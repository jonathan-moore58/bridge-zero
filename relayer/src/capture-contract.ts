// Captures one storage slot of a pallet-revive contract, with everything that proves it from a
// block's state_root, and the EVM RPC's view of the same slot. Read-only: it queries a Substrate
// node and its EVM RPC and writes one JSON file; it never signs or sends anything.
//
//   npm run capture-contract -- --rpc <wss url> --evm <http(s) url> --contract <0x 20-byte address>
//                               --slot <0x hex or decimal> --out <dir> [--label <text>]
//
// Everything is read at the finalized head B, one read after the other:
//   - B's header (blake2_256 of its SCALE bytes must be B's hash) and runtime version;
//   - state_getReadProof of Revive.BlockHash(B) and of Revive.BlockHash(B - 1), the hashes of the
//     Ethereum blocks the runtime built for B and for its parent, and the EVM RPC's block with B's
//     number. That block must be B itself (B's hash, parent hash and state root) or the Ethereum
//     block of B (the two proven hashes as its hash and parent hash, and the empty-trie root as its
//     state root); nothing else is accepted;
//   - state_getReadProof of Revive.AccountInfoOf(contract): the contract's trie id and code hash;
//   - state_getReadProof of Revive.CodeInfoOf(code hash), and eth_getCode at the EVM block: the
//     code's keccak-256 is the code hash, its length is code_len and its kind is code_type;
//   - state_getReadProof of ":child_storage:default:" ++ trie id: the root of its child trie;
//   - state_getChildReadProof of blake2_256(slot) in that child trie, and eth_getStorageAt of the
//     slot at the EVM block;
//   - state_getStorage of Grandpa.CurrentSetId, with no proof: provenance.setId, which says only
//     whether the chain runs GRANDPA of its own (null on a parachain, whose header is then trusted
//     input), and which set the node reported.
// The EVM RPC is asked at the EVM block's hash (EIP-1898), or at its number if it refuses the hash.
// Each proof is walked here and every value compared before contract-storage.json is written to
// --out (revive.ts describes the layout; check.ts verifies the file again offline).

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, equalBytes, hexToBytes, leToBigInt, shortHex, toSafeNumber, type Hex } from "./bytes.js";
import { Chain, childItems, type ProvenValue } from "./chain.js";
import { headerJson, proofJson, writeJson, type BlockRef, type ContractStorageFixture, type EvmBlockParam, type EvmBlockRelation, type ToolInfo } from "./fixture.js";
import { CHILD_STORAGE_DEFAULT_PREFIX, childRootKey, storageKey } from "./hash.js";
import {
  CODE_TYPE_OF_KIND,
  codeKind,
  decodeReviveAccountInfo,
  decodeReviveCodeInfo,
  EMPTY_TRIE_ROOT,
  isUnsetStorageWord,
  reviveAccountInfoKey,
  reviveBlockHashKey,
  reviveCodeInfoKey,
  reviveSlotKey,
} from "./revive.js";
import { RpcClient } from "./rpc.js";
import { decodeU64 } from "./scale.js";
import { readProof } from "./trie.js";

const FILE = "contract-storage.json";
const EVM_TIMEOUT_MS = 20_000;
/** The EVM RPC may not have indexed B yet when the capture starts: ask again this often, this many times. */
const EVM_BLOCK_RETRY_MS = 3_000;
const EVM_BLOCK_TRIES = 10;
const SET_ID_KEY = storageKey("Grandpa", "CurrentSetId");
const PARA_ID_KEY = storageKey("ParachainInfo", "ParachainId");
const USAGE =
  "usage: npm run capture-contract -- --rpc <wss url> --evm <http(s) url> --contract <0x address> --slot <0x hex or decimal> --out <dir> [--label <text>]";

const log = (message: string) => console.log(message);
const fmt = (n: number) => n.toLocaleString("en-US");

/** A slot number as its 32-byte big-endian storage key. */
function parseSlot(text: string): Uint8Array {
  if (!/^(0x[0-9a-fA-F]{1,64}|[0-9]+)$/.test(text)) throw new Error(`--slot: not a 0x hex or decimal number: ${text}`);
  const value = BigInt(text);
  if (value >= 1n << 256n) throw new Error(`--slot: more than 32 bytes: ${text}`);
  return hexToBytes(value.toString(16).padStart(64, "0"));
}

function parseAddress(text: string): Uint8Array {
  const address = text.startsWith("0x") ? hexToBytes(text) : new Uint8Array(0);
  if (address.length !== 20) throw new Error(`--contract: expected a 0x-prefixed 20-byte address, got ${text}`);
  return address;
}

function toolInfo(): ToolInfo {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { name: string; version: string };
  const relayerDir = fileURLToPath(new URL("..", import.meta.url));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: relayerDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  let gitCommit: string | null = null;
  let gitDirty: boolean | null = null;
  try {
    gitCommit = git("rev-parse", "HEAD");
    gitDirty = git("status", "--porcelain", "--", ".") !== "";
  } catch {
    // not a git checkout, or git is not installed
  }
  return { name: pkg.name, version: pkg.version, script: "src/capture-contract.ts", gitCommit, gitDirty };
}

// ---------------------------------------------------------------------------------------
// Chain access

/** A JSON-RPC error object from the EVM RPC (the request arrived and was refused). */
class EvmRpcError extends Error {
  override name = "EvmRpcError";
}

/** Ethereum JSON-RPC over HTTP. */
class EvmRpc {
  private nextId = 1;

  constructor(readonly url: string) {}

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
      signal: AbortSignal.timeout(EVM_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
    const body = (await response.json()) as { result?: T; error?: { code?: number; message?: string } };
    if (body.error) throw new EvmRpcError(`${method}: ${body.error.message ?? "error"} (code ${body.error.code})`);
    if (body.result === undefined) throw new Error(`${method}: a response without a result`);
    return body.result;
  }
}

interface EvmBlock {
  number: Hex;
  hash: Hex;
  parentHash: Hex;
  stateRoot: Hex;
}

/**
 * Revive.BlockHash(number) proven from the state root of `at`: the hash of the Ethereum block the
 * runtime built for that block, which must be 32 non-zero bytes.
 */
async function ethBlockHash(chain: Chain, root: Uint8Array, at: BlockRef, number: number): Promise<{ key: Uint8Array; read: ProvenValue; hash: Hex }> {
  const key = reviveBlockHashKey(number);
  const read = await chain.provenRead(root, key, at.hash, `Revive.BlockHash(${number})`);
  if (!read) throw new Error(`Revive.BlockHash(${number}) is empty at #${fmt(at.number)}: this runtime records no Ethereum block hash for #${fmt(number)}`);
  if (read.value.length !== 32 || read.value.every((b) => b === 0)) {
    throw new Error(`Revive.BlockHash(${number}) is not 32 non-zero bytes: ${bytesToHex(read.value)}`);
  }
  return { key, read, hash: bytesToHex(read.value) };
}

/** The EVM RPC's block with this number, waiting for the RPC to index it if needed. */
async function evmBlock(evm: EvmRpc, number: Hex): Promise<EvmBlock> {
  for (let attempt = 1; ; attempt++) {
    const block = await evm.call<EvmBlock | null>("eth_getBlockByNumber", [number, false]);
    if (block) return block;
    if (attempt === EVM_BLOCK_TRIES) throw new Error(`eth_getBlockByNumber(${number}) returned no block after ${EVM_BLOCK_TRIES} tries`);
    await new Promise((resolve) => setTimeout(resolve, EVM_BLOCK_RETRY_MS));
  }
}

/**
 * `method` with `args` at the EVM block: by its hash (EIP-1898 {blockHash}), or, if the RPC
 * refuses that, by its number. The block was matched to B before, so both name B.
 */
async function atEvmBlock<T, A extends Hex[]>(
  evm: EvmRpc,
  method: string,
  args: [...A],
  block: { hash: Hex; number: Hex },
  notes: string[],
): Promise<{ params: [...A, EvmBlockParam]; result: T }> {
  const byHash: [...A, EvmBlockParam] = [...args, { blockHash: block.hash }];
  try {
    return { params: byHash, result: await evm.call<T>(method, byHash) };
  } catch (error) {
    if (!(error instanceof EvmRpcError)) throw error;
    notes.push(`The EVM RPC refused ${method} at the block hash (EIP-1898; ${error.message}); it was asked at the block number instead.`);
    const byNumber: [...A, EvmBlockParam] = [...args, block.number];
    return { params: byNumber, result: await evm.call<T>(method, byNumber) };
  }
}

// ---------------------------------------------------------------------------------------
// Main

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      rpc: { type: "string" },
      evm: { type: "string" },
      contract: { type: "string" },
      slot: { type: "string" },
      out: { type: "string" },
      label: { type: "string" },
    },
  });
  if (!values.rpc || !values.evm || !values.contract || !values.slot || !values.out) throw new Error(USAGE);
  const address = parseAddress(values.contract);
  const addressHex = bytesToHex(address);
  const slot = parseSlot(values.slot);
  const outDir = resolve(values.out);
  const tool = toolInfo();
  const evm = new EvmRpc(values.evm);

  log(`Connecting to ${values.rpc}`);
  const rpc = await RpcClient.connect(values.rpc);
  const chain = new Chain(rpc);
  const notes: string[] = [];
  try {
    const chainName = await rpc.request<string>("system_chain");
    const nodeVersion = await rpc.request<string>("system_version");
    const genesisHash = await rpc.request<Hex>("chain_getBlockHash", [0]);
    const chainId = (await evm.call<Hex>("eth_chainId")).toLowerCase() as Hex;
    const clientVersion = await evm.call<string>("web3_clientVersion").catch(() => null);
    log(`  ${chainName}, genesis ${genesisHash}, node ${nodeVersion}`);
    log(`  EVM RPC ${values.evm}: chain id ${BigInt(chainId)}${clientVersion ? `, ${clientVersion}` : ""}`);

    // (1) B: the finalized head. Every read below is at B.
    const capturedAt = new Date().toISOString();
    const hash = (await rpc.request<Hex>("chain_getFinalizedHead")).toLowerCase() as Hex;
    const head = await chain.header(hash);
    const B: BlockRef = { number: head.number, hash };
    const runtime = await chain.runtime(B.hash);
    const trieVersion = runtime.stateVersion === 1 ? 1 : 0;
    log(`(1) block #${fmt(B.number)} ${B.hash}: ${runtime.specName} ${runtime.specVersion}, trie V${trieVersion}, header ${head.encoded.length} B`);

    // (2) The EVM RPC's block with B's number. It is B itself, or the Ethereum block the runtime
    // built for B, whose hash the runtime stores in Revive.BlockHash(B) and whose parent hash in
    // Revive.BlockHash(B - 1).
    const own = await ethBlockHash(chain, head.stateRoot, B, B.number);
    const parent = await ethBlockHash(chain, head.stateRoot, B, B.number - 1);
    const numberHex = `0x${B.number.toString(16)}` as Hex;
    const block = await evmBlock(evm, numberHex);
    if (BigInt(block.number) !== BigInt(B.number)) throw new Error(`eth_getBlockByNumber(${numberHex}) returned block ${block.number}`);
    const evmHash = block.hash.toLowerCase() as Hex;
    const evmParent = block.parentHash.toLowerCase() as Hex;
    const evmRoot = block.stateRoot.toLowerCase() as Hex;
    const emptyRoot = bytesToHex(EMPTY_TRIE_ROOT);
    let relation: EvmBlockRelation;
    if (evmHash === B.hash && evmParent === bytesToHex(head.parentHash) && evmRoot === bytesToHex(head.stateRoot)) relation = "substrate-block";
    else if (evmHash === own.hash && evmParent === parent.hash && evmRoot === emptyRoot) relation = "revive-block-hash";
    else {
      throw new Error(
        `the EVM RPC's block ${numberHex} (hash ${evmHash}, parent ${evmParent}, state root ${evmRoot}) is not B ` +
          `(hash ${B.hash}, parent ${bytesToHex(head.parentHash)}, state root ${bytesToHex(head.stateRoot)}), nor the Ethereum block of B ` +
          `(hash Revive.BlockHash(B) ${own.hash}, parent Revive.BlockHash(B - 1) ${parent.hash}, state root the empty-trie root ${emptyRoot})`,
      );
    }
    const at = { hash: evmHash, number: numberHex };
    log(`(2) Revive.BlockHash(B) = ${own.hash}, Revive.BlockHash(B - 1) = ${parent.hash}; proofs ${own.read.nodes.length} and ${parent.read.nodes.length} items. ` +
      `EVM block ${numberHex} ${evmHash}: ` +
      (relation === "substrate-block"
        ? "B itself (same hash, parent hash and state root)"
        : "the Ethereum block of B (its hash and parent hash are Revive.BlockHash(B) and (B - 1), its state root the empty-trie root)"));

    // (3) Revive.AccountInfoOf(contract): a contract, its trie id and its code hash.
    const accountKey = reviveAccountInfoKey(address);
    const account = await chain.provenRead(head.stateRoot, accountKey, B.hash, "AccountInfoOf");
    if (!account) {
      throw new Error(
        `no AccountInfoOf entry for ${addressHex} at #${fmt(B.number)}: Revive.AccountInfoOf(${addressHex}) is empty (the proof shows the key absent), ` +
          "so the address is not a pallet-revive contract at this block",
      );
    }
    const info = decodeReviveAccountInfo(account.value);
    if (info.kind !== "Contract") throw new Error(`${addressHex} is an externally owned account, not a contract`);
    const contract = info.contract;
    log(`(3) Revive.AccountInfoOf: ${account.value.length} B, trie id ${bytesToHex(contract.trieId)}, code hash ${bytesToHex(contract.codeHash)}, ` +
      `${contract.storageItems} storage items; proof ${account.nodes.length} items${account.hashedValues ? ", value behind its hash" : ""}`);

    // (4) Revive.CodeInfoOf(code hash), and the code from the EVM RPC: its hash, length and kind.
    const codeInfoKey = reviveCodeInfoKey(contract.codeHash);
    const codeInfoRead = await chain.provenRead(head.stateRoot, codeInfoKey, B.hash, "CodeInfoOf");
    if (!codeInfoRead) throw new Error(`no CodeInfoOf entry for the code hash ${bytesToHex(contract.codeHash)} at #${fmt(B.number)}`);
    const codeInfo = decodeReviveCodeInfo(codeInfoRead.value);
    const codeCall = await atEvmBlock<Hex, [Hex]>(evm, "eth_getCode", [addressHex], at, notes);
    const code = hexToBytes(codeCall.result);
    const kind = codeKind(code);
    if (!equalBytes(keccak_256(code), contract.codeHash)) throw new Error(`keccak-256 of eth_getCode is ${bytesToHex(keccak_256(code))}, the code hash in AccountInfoOf is ${bytesToHex(contract.codeHash)}`);
    if (codeInfo.codeLen !== code.length) throw new Error(`CodeInfoOf says code_len ${codeInfo.codeLen}, eth_getCode returned ${code.length} B`);
    if (codeInfo.codeType !== CODE_TYPE_OF_KIND[kind]) throw new Error(`CodeInfoOf says code_type ${codeInfo.codeType}, eth_getCode returned ${kind === "evm" ? "EVM bytecode" : "a PolkaVM program"}`);
    log(`(4) Revive.CodeInfoOf: ${codeInfoRead.value.length} B, code_type ${codeInfo.codeType}, code_len ${fmt(codeInfo.codeLen)}, refcount ${codeInfo.refcount}; ` +
      `proof ${codeInfoRead.nodes.length} items. eth_getCode: ${fmt(code.length)} B, ${kind === "evm" ? "EVM bytecode" : "PolkaVM"}, keccak-256 = code hash`);

    // (5) The root of the contract's child trie, in the main trie.
    const rootKey = childRootKey(contract.trieId);
    const rootRead = await chain.provenRead(head.stateRoot, rootKey, B.hash, "child-root");
    if (!rootRead) throw new Error(`no child root at ":child_storage:default:" ++ trie id ${bytesToHex(contract.trieId)}`);
    if (rootRead.value.length !== 32 || rootRead.value.every((b) => b === 0)) throw new Error(`the child root is not 32 non-zero bytes: ${bytesToHex(rootRead.value)}`);
    const childRoot = rootRead.value;
    const rootNodes = rootRead.nodes;
    log(`(5) child root ${bytesToHex(childRoot)} at ":child_storage:default:" ++ trie id (${rootKey.length} B key); proof ${rootNodes.length} items`);

    // (6) The slot in the child trie, and eth_getStorageAt of it. The node also serves the
    // main-trie items that lead to the child root; they must be exactly the child-root proof, so
    // only the child-trie items are kept.
    const slotKey = reviveSlotKey(slot);
    const served = await chain.childReadProof(rootKey, slotKey, B.hash);
    const direct = await chain.childStorage(rootKey, slotKey, B.hash);
    const { nodes: childNodes, mainTrieItems } = childItems(served, rootNodes);
    const slotRead = readProof(childRoot, childNodes, slotKey);
    // The position is a QUANTITY in the Ethereum JSON-RPC: hex without leading zeros.
    const storageCall = await atEvmBlock<Hex, [Hex, Hex]>(evm, "eth_getStorageAt", [addressHex, `0x${BigInt(bytesToHex(slot)).toString(16)}`], at, notes);
    const word = storageCall.result.toLowerCase() as Hex;
    const wordBytes = hexToBytes(word);
    if (!slotRead.value) {
      if (direct) throw new Error(`the child proof shows slot ${bytesToHex(slot)} absent, childstate_getStorage returns ${bytesToHex(direct)}`);
      throw new Error(
        isUnsetStorageWord(wordBytes)
          ? `slot ${bytesToHex(slot)} is unset at #${fmt(B.number)}: the child proof shows it absent, and eth_getStorageAt returns ${word}, which means unset too; the proofs need a slot with a value`
          : `the child proof shows slot ${bytesToHex(slot)} absent, but eth_getStorageAt returns ${word}`,
      );
    }
    if (slotRead.value.length === 0) {
      throw new Error(`slot ${bytesToHex(slot)} holds a zero-length value, which SubstrateProofs.verifyMain rejects (EmptyValue); the proofs need a slot with a value`);
    }
    if (direct === undefined) notes.push("The node does not expose childstate_getStorage: the slot's value comes from the child proof alone.");
    else if (!direct || !equalBytes(slotRead.value, direct)) throw new Error("the child proof does not lead to the value from childstate_getStorage");
    if (slotRead.itemsUsed !== childNodes.length) throw new Error(`the child proof has ${childNodes.length - slotRead.itemsUsed} items the walk does not need`);
    const value = slotRead.value;
    let matches: "equal" | "left-padded";
    if (equalBytes(wordBytes, value)) matches = "equal";
    else if (wordBytes.length === 32 && value.length < 32 && equalBytes(wordBytes.subarray(32 - value.length), value) && wordBytes.subarray(0, 32 - value.length).every((b) => b === 0)) matches = "left-padded";
    else if (isUnsetStorageWord(wordBytes)) throw new Error(`eth_getStorageAt returns ${word}, which means the slot is unset, but the proof shows ${bytesToHex(value)}`);
    else throw new Error(`eth_getStorageAt returned ${word}, the proven value is ${bytesToHex(value)}`);
    log(`(6) slot ${shortHex(slot)} at blake2_256(slot) ${bytesToHex(slotKey)}: ${value.length} B ${bytesToHex(value)}; ` +
      `served ${served.length} items, ${childNodes.length} of them in the child trie. eth_getStorageAt ${word} (${matches})`);

    // Finality of B: GRANDPA in this chain's state, or a parachain that has none of its own. Both
    // are read without a proof: they describe the chain, and no proof below depends on them.
    const setIdScale = await chain.storage(SET_ID_KEY, B.hash);
    const setId = setIdScale ? decodeU64(setIdScale, "Grandpa.CurrentSetId") : null;
    const paraIdScale = await chain.storage(PARA_ID_KEY, B.hash);
    const paraId = paraIdScale?.length === 4 ? Number(leToBigInt(paraIdScale)) : null;

    if (setId === null) {
      notes.push(
        `${chainName} has no GRANDPA of its own${paraId === null ? "" : ` (it is parachain ${paraId}, ParachainInfo.ParachainId)`}: B's header is trusted input here. ` +
          "Proving it final through the relay chain (the relay chain's GRANDPA, then this chain's head in the relay chain's state) is out of scope.",
      );
    } else {
      notes.push(
        `This chain runs GRANDPA: state_getStorage of Grandpa.CurrentSetId at B returns set ${setId}, which this file records without a proof. ` +
          "Once a light client has imported B, these proofs check against the state root it stores for B.",
      );
    }
    notes.push(
      `Revive.AccountInfoOf(${addressHex}) is a contract: trie id ${bytesToHex(contract.trieId)}, code hash ${bytesToHex(contract.codeHash)}. ` +
        `Revive.CodeInfoOf of that hash says code_type ${codeInfo.codeType} and code_len ${fmt(codeInfo.codeLen)}. eth_getCode returns ` +
        `${kind === "evm" ? "EVM bytecode, which pallet-revive runs with REVM" : 'a PolkaVM program ("PVM\\0" magic)'} ` +
        `(${fmt(code.length)} B, starting ${bytesToHex(code.subarray(0, 5))}), and its keccak-256 is that code hash.`,
    );
    notes.push(
      `state_getChildReadProof served ${served.length} items: the ${mainTrieItems} main-trie items that lead to the child root, exactly the items of childRoot.proof, ` +
        `and the ${childNodes.length} child-trie items in slot.proof.`,
    );
    notes.push(
      relation === "substrate-block"
        ? `The EVM RPC's block ${numberHex} is B itself: same hash, parent hash and state root. Revive.BlockHash(B) and Revive.BlockHash(B - 1), proven at B, ` +
            `are ${own.hash} and ${parent.hash}: the hash and parent hash an eth-rpc that serves the runtime's Ethereum blocks reports for B instead.`
        : `The EVM RPC's block ${numberHex} is the Ethereum block the runtime built for B: its hash is Revive.BlockHash(B) and its parent hash ` +
            `Revive.BlockHash(B - 1), both proven at B. Its state root ${evmRoot} is the empty-trie root, a placeholder, not B's.`,
    );
    const byHash = typeof codeCall.params[1] === "object" && typeof storageCall.params[2] === "object";
    notes.push(
      `${byHash ? "eth_getCode and eth_getStorageAt were asked at the EVM block's hash (EIP-1898). " : ""}` +
        `eth_getStorageAt returns ${matches === "equal" ? "the proven value byte for byte" : "the proven value left-padded to 32 bytes"}.`,
    );
    if (values.label) notes.push("slot.label is the text given with --label; this tool does not check it.");

    const fixture: ContractStorageFixture = {
      provenance: {
        chain: chainName,
        rpc: values.rpc,
        evmRpc: values.evm,
        genesisHash,
        runtime,
        block: B,
        setId: setId === null ? null : toSafeNumber(setId, "set id"),
        capturedAt,
        tool,
      },
      kind: "contract-storage",
      about:
        "One storage slot of a pallet-revive contract, proven from the state_root of block B: Revive.AccountInfoOf(address) in the main trie " +
        "gives the contract's trie id and code hash; Revive.CodeInfoOf(code hash) gives the code's type and length; the main trie holds the root " +
        'of the contract\'s child trie under ":child_storage:default:" ++ trie id; the child trie holds the slot under blake2_256(slot). ' +
        "Revive.BlockHash(B) and Revive.BlockHash(B - 1), also proven at B, tie the EVM RPC's block to B; eth_getCode and eth_getStorageAt at that block " +
        "are recorded next to the proofs.",
      node: { version: nodeVersion },
      header: headerJson(head, hexToBytes(B.hash)),
      trieVersion,
      account: {
        address: addressHex,
        key: { pallet: "Revive", item: "AccountInfoOf", hasher: "Identity", bytes: accountKey.length, hex: bytesToHex(accountKey) },
        value: {
          bytes: account.value.length,
          scale: bytesToHex(account.value),
          decoded: {
            kind: info.kind,
            trieId: bytesToHex(contract.trieId),
            codeHash: bytesToHex(contract.codeHash),
            storageBytes: contract.storageBytes,
            storageItems: contract.storageItems,
            storageByteDeposit: contract.storageByteDeposit.toString(),
            storageItemDeposit: contract.storageItemDeposit.toString(),
            storageBaseDeposit: contract.storageBaseDeposit.toString(),
            immutableDataLen: contract.immutableDataLen,
            dust: info.dust,
          },
        },
        proof: proofJson("state_getReadProof", account.nodes),
      },
      codeInfo: {
        key: { pallet: "Revive", item: "CodeInfoOf", hasher: "Identity", bytes: codeInfoKey.length, hex: bytesToHex(codeInfoKey) },
        value: {
          bytes: codeInfoRead.value.length,
          scale: bytesToHex(codeInfoRead.value),
          decoded: {
            owner: bytesToHex(codeInfo.owner),
            deposit: codeInfo.deposit.toString(),
            refcount: codeInfo.refcount.toString(),
            codeLen: codeInfo.codeLen,
            codeType: codeInfo.codeType,
            behaviourVersion: codeInfo.behaviourVersion,
          },
        },
        proof: proofJson("state_getReadProof", codeInfoRead.nodes),
      },
      code: { method: "eth_getCode", params: codeCall.params, kind, bytes: code.length, keccak256: bytesToHex(keccak_256(code)), hex: bytesToHex(code) },
      childRoot: {
        key: { prefix: new TextDecoder().decode(CHILD_STORAGE_DEFAULT_PREFIX), bytes: rootKey.length, hex: bytesToHex(rootKey) },
        root: bytesToHex(childRoot),
        proof: proofJson("state_getReadProof", rootNodes),
      },
      slot: {
        index: bytesToHex(slot),
        ...(values.label ? { label: { text: values.label, source: "command line (--label)" } } : {}),
        key: { hasher: "Blake2_256", hex: bytesToHex(slotKey) },
        value: { bytes: value.length, hex: bytesToHex(value) },
        proof: {
          ...proofJson("state_getChildReadProof", childNodes),
          served: { count: served.length, bytes: served.reduce((n, item) => n + item.length, 0), mainTrieItems },
        },
      },
      evm: {
        chainId,
        clientVersion,
        relation,
        reviveBlockHash: {
          key: { pallet: "Revive", item: "BlockHash", hasher: "Identity", bytes: own.key.length, hex: bytesToHex(own.key) },
          value: own.hash,
          proof: proofJson("state_getReadProof", own.read.nodes),
        },
        reviveParentBlockHash: {
          key: { pallet: "Revive", item: "BlockHash", hasher: "Identity", bytes: parent.key.length, hex: bytesToHex(parent.key) },
          value: parent.hash,
          proof: proofJson("state_getReadProof", parent.read.nodes),
        },
        block: { method: "eth_getBlockByNumber", number: B.number, hash: evmHash, parentHash: evmParent, stateRoot: evmRoot },
        storageAt: { method: "eth_getStorageAt", params: storageCall.params, result: word, matches },
      },
      notes,
    };

    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, FILE);
    const bytes = writeJson(file, fixture);
    log(`\nWrote ${file} (${fmt(bytes)} B)`);
    for (const n of notes) log(`  note: ${n}`);
  } finally {
    await rpc.close();
  }
}

main().catch((error: unknown) => {
  console.error(`capture-contract failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
