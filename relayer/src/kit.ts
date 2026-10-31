// The proof kit's tool: Portaldot V3 state read at a block the light client on Sepolia holds, the
// proof walked here with the contracts' checks and then by PortaldotStateReader (contracts/src/kit)
// on a Sepolia node; the capture of the kit's fixture; and its offline check.
//
//   npm run kit -- read balance --account <0x address | 0x 32-byte id>   [--at <V3 block hash>]
//   npm run kit -- read asset   --asset <id> --account <...>             [--at]
//   npm run kit -- read nft     --collection <n> --item <n>              [--at]
//   npm run kit -- read slot    --contract <0x address> --slot <0x hex | decimal> [--at]
//   npm run kit -- read lock    --nonce <n>                              [--at]
//   npm run kit -- capture [--out <dir>] [--at <hash>] [--force]
//   npm run kit -- check   [--dir <dir>]
//   options: --network sepolia (only Sepolia has a Reader in v0.1), --rpc <wss url> (the V3 node),
//            --reader <address> (default: deployments/sepolia-kit.json), --from-fixture <file>
//
// A read takes B, a V3 block that GrandpaLightClient #2 on Sepolia imported: its latest, unless --at
// names another one it holds. The V3 node's header of B must hash to B and name the client's state
// root. The read's proof comes from the V3 node (or, with --from-fixture, from a state-reads
// fixture of B) and is walked here with the contracts' checks (state.ts); then PortaldotStateReader
// makes the same read on a Sepolia node, by eth_call and eth_estimateGas, and must return the same
// value. Until the Reader is deployed (no deployments/sepolia-kit.json and no --reader), the call
// runs the local build (contracts/out, from forge build) at a stand-in address through eth_call's
// state override, against the deployed light client and StorageProofs; a node that refuses state
// overrides skips that step with a note. read lock also recomputes the lock's commitment with
// BridgeMinter.commitmentOf and runs BridgeMinter.mint with the proofs as an eth_call.
//
// capture reads, at B (by default the client's latest), everything fixtures/v3-testnet-kit holds:
// B's header and its parent, the set that signs B, grandpa_proveFinality(B), the signers hint, the
// light client's answers for B, the kit's main-trie reads and the vault's slots, each proof walked
// here and every item used, and the tampers. check verifies that file again offline
// (state.ts checkStateReads).
//
// Read-only: nothing is signed or sent. capture writes the fixture file and nothing else.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { HEADER_IMPORTED_TOPIC, MINTER, callData, logWindows, mintCalldata, signersHint, uintAt, wordAt } from "./bridge.js";
import { bytesToHex, equalBytes, hexToBytes, shortHex, type Hex } from "./bytes.js";
import { Chain } from "./chain.js";
import { authoritySetJson, headerJson, justificationJson, proofJson, readJson, writeJson, type ToolInfo } from "./fixture.js";
import { clientVerifies, verifyJustification } from "./grandpa.js";
import { blake2_256, childRootKey, storageKey } from "./hash.js";
import { RpcClient } from "./rpc.js";
import { decodeAuthorityList, decodeFinalityProof, decodeHeader, decodeJustification, decodeU64 } from "./scale.js";
import {
  accountIdOf,
  accountInfoAt,
  assetAccountAt,
  assetsAccountKey,
  assetsAccountPrefix,
  contractSlotAt,
  checkStateReads,
  decodedJson,
  decodeNftItem,
  keyOfRead,
  nftsItemKey,
  outcomeOf,
  readAs,
  readerCalldata,
  decodeReaderResult,
  readMain,
  lockProofOf,
  systemAccountKey,
  type ContractSlotProofs,
  type ReaderCall,
  type ReaderResult,
  type StateReadArgs,
  type StateReadJson,
  type StateReadsFixture,
  type StateSlotJson,
  type StateTamperJson,
} from "./state.js";
import { ethCall, estimateGas, fetchContractSlot, fetchMain, importedBlock, KitStop, KitUnreachable, nodeAgrees, revertText, type FetchedRead, type FetchedSlot, type ImportedBlock } from "./state-fetch.js";
import { checksumAddress, commitmentSlot, ethAccountId, formatTpot, lockCommitment, parseAddress, uintWord } from "./vault.js";
import { fmt, NETWORKS, rpc, rpcBody, type NetworkName } from "../../contracts/script/lib/sepolia.mjs";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const DEPLOYMENTS = join(REPO, "deployments");
const DEFAULT_DIR = join(REPO, "fixtures", "v3-testnet-kit");
const FIXTURE_FILE = "state-reads.json";
const READER_BUILD = join(REPO, "contracts", "out", "PortaldotStateReader.sol", "PortaldotStateReader.json");
const V3_RPC = "wss://test-node-v3.portaldot.dev";
const SET_ID_KEY = storageKey("Grandpa", "CurrentSetId");
/** Where the local build of the Reader runs, through eth_call's state override, until it is deployed. */
const STAND_IN = "0x000000000000000000000000000000000000c0de" as Hex;
const STORAGE_PROOFS_ID = "src/trie/StorageProofs.sol:StorageProofs";

const log = (line = "") => console.log(line);
const ok = (line: string) => log(`  ok    ${line}`);
const fail = (line: string) => {
  log(`  FAIL  ${line}`);
  process.exitCode = 1;
};
const note = (line: string) => log(`  note  ${line}`);

// ---------------------------------------------------------------------------------------
// The records

/** A lock of the vault as the records hold it: the V3 record's, or the auto-mint history of the chain that minted it. */
interface LockFacts {
  nonce: number;
  dstChainId: bigint;
  dstMinter: Uint8Array;
  recipient: Uint8Array;
  amountNative: bigint;
  source: string;
}

interface KitRecords {
  client: Hex;
  storageProofs: Hex;
  minter: Hex;
  vault: Hex;
  v3ChainId: bigint;
  /** PortaldotStateReader on Sepolia, from deployments/sepolia-kit.json; null until it is deployed. */
  reader: Hex | null;
}

function records(): KitRecords {
  const sepolia = readJson<{ contracts: Record<string, Hex> }>(join(DEPLOYMENTS, "sepolia.json"));
  const bridge = readJson<{ contracts: Record<string, Hex>; lightClient: { address: Hex } }>(join(DEPLOYMENTS, "sepolia-bridge.json"));
  const v3 = readJson<{ chainId: number | string; vault: { address: Hex } }>(join(DEPLOYMENTS, "v3-testnet.json"));
  const client = sepolia.contracts["GrandpaLightClient #2"];
  if (bridge.lightClient.address.toLowerCase() !== client.toLowerCase()) throw new Error("deployments/sepolia-bridge.json names another light client than GrandpaLightClient #2");
  const kitFile = join(DEPLOYMENTS, "sepolia-kit.json");
  const kit = existsSync(kitFile) ? readJson<{ contracts?: Record<string, Hex> }>(kitFile) : null;
  return {
    client: client.toLowerCase() as Hex,
    storageProofs: sepolia.contracts.StorageProofs.toLowerCase() as Hex,
    minter: bridge.contracts.BridgeMinter.toLowerCase() as Hex,
    vault: v3.vault.address.toLowerCase() as Hex,
    v3ChainId: BigInt(v3.chainId),
    reader: kit?.contracts?.PortaldotStateReader ? (kit.contracts.PortaldotStateReader.toLowerCase() as Hex) : null,
  };
}

/** Lock `nonce`: deployments/v3-testnet.json, else the auto-mint history that minted it (locks the app sent are only there). */
function lockFacts(nonce: number): LockFacts | null {
  const v3 = readJson<{ locks: { vaultNonce?: string; expected?: { vaultNonce?: string }; dstChainId: string; dstMinter: Hex; recipient: Hex; amountNative: string }[] }>(
    join(DEPLOYMENTS, "v3-testnet.json"),
  );
  const index = v3.locks.findIndex((l) => (l.vaultNonce ?? l.expected?.vaultNonce) === String(nonce));
  if (index >= 0) {
    const l = v3.locks[index];
    return { nonce, dstChainId: BigInt(l.dstChainId), dstMinter: hexToBytes(l.dstMinter), recipient: hexToBytes(l.recipient), amountNative: BigInt(l.amountNative), source: `deployments/v3-testnet.json locks[${index}]` };
  }
  for (const name of Object.keys(NETWORKS) as NetworkName[]) {
    const file = join(DEPLOYMENTS, `automint-${name}-0x57cc2ba3b883339a9f32726e6d0d3a9ee861a113.jsonl`);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as { kind?: string; lock?: string; to?: Hex; recipient?: Hex; amount?: string };
      if (entry.kind !== "attempt" || entry.lock !== String(nonce) || !entry.to || !entry.recipient || !entry.amount) continue;
      return {
        nonce,
        dstChainId: NETWORKS[name].chainId,
        dstMinter: hexToBytes(entry.to),
        recipient: hexToBytes(entry.recipient),
        amountNative: BigInt(entry.amount),
        source: `deployments/automint-${name}-0x57cc….jsonl (its mint of lock ${nonce})`,
      };
    }
  }
  return null;
}

function toolInfo(): ToolInfo {
  const pkg = readJson<{ name: string; version: string }>(fileURLToPath(new URL("../package.json", import.meta.url)));
  const relayerDir = fileURLToPath(new URL("..", import.meta.url));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: relayerDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  let gitCommit: string | null = null;
  let gitDirty: boolean | null = null;
  try {
    gitCommit = git("rev-parse", "HEAD");
    gitDirty = git("status", "--porcelain", "--", ".") !== "";
  } catch {
    // not a git checkout, or git is not installed
  }
  return { name: pkg.name, version: pkg.version, script: "src/kit.ts", gitCommit, gitDirty };
}

async function connectV3(url: string): Promise<Chain> {
  try {
    return new Chain(await RpcClient.connect(url));
  } catch (error) {
    throw new KitUnreachable(`the V3 node ${new URL(url).host} is unreachable (${error instanceof Error ? error.message : String(error)}); run with --from-fixture <file> to take the proofs from a fixture`);
  }
}

// ---------------------------------------------------------------------------------------
// Where the proofs come from

/** Proofs at B: from the V3 node, or from a state-reads fixture of B. */
interface Source {
  label: string;
  main(key: Uint8Array, what: string): Promise<FetchedRead>;
  slot(address: Uint8Array, slot: Uint8Array): Promise<FetchedSlot>;
  close(): Promise<void>;
}

function nodeSource(chain: Chain, b: ImportedBlock): Source {
  return {
    label: `the V3 node ${new URL(chain.rpc.url).host}`,
    main: (key, what) => fetchMain(chain, b, key, what),
    slot: (address, slot) => fetchContractSlot(chain, b, address, slot),
    close: () => chain.rpc.close(),
  };
}

function fixtureSource(file: string, f: StateReadsFixture): Source {
  const nodes = (hex: Hex[]) => hex.map((n) => hexToBytes(n));
  const missing = (what: string) => new KitStop(`${file} holds no proof of ${what}: read it from the V3 node (without --from-fixture)`);
  return {
    label: `the fixture ${file}`,
    async main(key, what) {
      const r = f.reads.find((x) => x.key.hex === bytesToHex(key));
      if (!r) throw missing(what);
      return { value: r.value ? hexToBytes(r.value.scale) : null, proof: nodes(r.proof.nodes), hashed: r.value?.hashed ?? false };
    },
    async slot(address, slot) {
      const c = f.contract;
      const s = c.slots.find((x) => x.index === bytesToHex(slot));
      const account = f.reads.find((x) => x.id === c.read);
      if (c.address !== bytesToHex(address) || !s || !account) throw missing(`slot ${shortHex(slot)} of ${checksumAddress(address)}`);
      return {
        trieId: hexToBytes(c.trieId),
        codeHash: hexToBytes(c.codeHash),
        childRoot: hexToBytes(c.childRoot.root),
        word: s.value ? hexToBytes(s.value.hex) : null,
        account: nodes(account.proof.nodes),
        childRootProof: nodes(c.childRoot.proof.nodes),
        slotProof: nodes(s.proof.nodes),
        served: s.proof.served,
      };
    },
    close: async () => {},
  };
}

// ---------------------------------------------------------------------------------------
// The Reader on Sepolia

interface ArtifactJson {
  deployedBytecode?: {
    object?: string;
    linkReferences?: Record<string, Record<string, { start: number; length: number }[]>>;
    immutableReferences?: Record<string, { start: number; length: number }[]>;
  };
}

/**
 * The runtime code PortaldotStateReader would have on Sepolia, from the local build (contracts/out):
 * StorageProofs linked at its deployed address and the lightClient immutable filled in. Null without
 * a build.
 */
function standInCode(client: Hex, storageProofs: Hex): Uint8Array | null {
  if (!existsSync(READER_BUILD)) return null;
  const code = readJson<ArtifactJson>(READER_BUILD).deployedBytecode;
  let hex = (code?.object ?? "").replace(/^0x/, "");
  if (!hex) throw new Error(`${READER_BUILD} has no runtime code`);
  for (const [path, libraries] of Object.entries(code?.linkReferences ?? {})) {
    for (const [name, refs] of Object.entries(libraries)) {
      if (`${path}:${name}` !== STORAGE_PROOFS_ID) throw new Error(`the Reader's build links ${path}:${name}, not only StorageProofs`);
      for (const ref of refs) hex = hex.slice(0, 2 * ref.start) + storageProofs.slice(2) + hex.slice(2 * (ref.start + ref.length));
    }
  }
  const runtime = hexToBytes(hex);
  const immutables = Object.values(code?.immutableReferences ?? {});
  if (immutables.length !== 1) throw new Error(`the Reader's build has ${immutables.length} immutables, not one (lightClient)`);
  const word = new Uint8Array(32);
  word.set(hexToBytes(client), 12);
  for (const ref of immutables[0]) runtime.set(word, ref.start);
  return runtime;
}

interface ReaderTarget {
  to: Hex;
  label: string;
  overrides?: Record<string, { code: Hex }>;
}

/** The deployed Reader (--reader, else deployments/sepolia-kit.json), or the local build at the stand-in address; null when neither is there. */
function readerTarget(r: KitRecords, given: Hex | undefined): ReaderTarget | null {
  const deployed = given ?? r.reader;
  if (deployed) return { to: deployed, label: `PortaldotStateReader ${shortHex(deployed)}` };
  const code = standInCode(r.client, r.storageProofs);
  if (!code) return null;
  return { to: STAND_IN, label: "PortaldotStateReader (not deployed yet: the local build at a stand-in address, by eth_call's state override)", overrides: { [STAND_IN]: { code: bytesToHex(code) } } };
}

/**
 * Makes `call` on the Reader at the Sepolia block B was read at and requires `same` to accept the
 * answer; prints the gas eth_estimateGas reports for the whole transaction, under the rules Sepolia
 * runs since Oct 6 (a plain call costs 15,000 gas there, not 21,000, and new storage far more:
 * docs/GAS.md).
 */
async function readerStep(r: KitRecords, given: Hex | undefined, b: ImportedBlock, call: ReaderCall, same: (result: ReaderResult) => string | null, what: string): Promise<void> {
  const target = readerTarget(r, given);
  if (!target) {
    note("the Reader step is skipped: no Reader is deployed (deployments/sepolia-kit.json) and there is no local build (forge build in contracts/)");
    return;
  }
  const data = readerCalldata(call);
  const block = `0x${b.readAt.number.toString(16)}`;
  const answer = await ethCall(target.to, data, block, target.overrides);
  if (!answer.ok) {
    if (target.overrides && answer.revert.length === 0) {
      note(`the Reader step is skipped: the Sepolia node did not run the local build (${answer.message})`);
      return;
    }
    fail(`${target.label}.${call.kind} reverted: ${revertText(answer.revert)}`);
    return;
  }
  const result = decodeReaderResult(call.kind, answer.data);
  const problem = same(result);
  if (problem) {
    fail(`${target.label}.${call.kind} returned another answer: ${problem}`);
    return;
  }
  const gas = await estimateGas(target.to, data, block, target.overrides);
  ok(`${target.label}.${call.kind} returns ${what} at #${fmt(b.number)}: ${"gas" in gas ? `${fmt(gas.gas)} gas (eth_estimateGas: the whole transaction, under Sepolia's current rules)` : `gas not estimated (${gas.refused})`}, calldata ${fmt(data.length)} B`);
}

/**
 * Makes `call` on the Reader and requires it to revert with `expected`, the error the walk gives
 * off chain: for a key that holds nothing, KeyNotPresent is the proof of absence.
 */
async function readerRefuses(r: KitRecords, given: Hex | undefined, b: ImportedBlock, call: ReaderCall, expected: string): Promise<void> {
  const target = readerTarget(r, given);
  if (!target) {
    note("the Reader step is skipped: no Reader is deployed (deployments/sepolia-kit.json) and there is no local build (forge build in contracts/)");
    return;
  }
  const answer = await ethCall(target.to, readerCalldata(call), `0x${b.readAt.number.toString(16)}`, target.overrides);
  if (answer.ok) {
    fail(`${target.label}.${call.kind} answered instead of reverting ${expected}`);
    return;
  }
  if (target.overrides && answer.revert.length === 0) {
    note(`the Reader step is skipped: the Sepolia node did not run the local build (${answer.message})`);
    return;
  }
  const name = revertText(answer.revert);
  if (name.startsWith(`${expected}(`) || name === `Error(${JSON.stringify(expected)})`) ok(`${target.label}.${call.kind} reverts ${name.length > 90 ? `${name.slice(0, 90)}…` : name}`);
  else fail(`${target.label}.${call.kind} reverts ${name}, not ${expected}`);
}

// ---------------------------------------------------------------------------------------
// read

interface ReadOptions {
  at?: Hex;
  rpc: string;
  reader?: Hex;
  fromFixture?: string;
}

const proofSize = (nodes: Uint8Array[]) => `${nodes.length} items, ${fmt(nodes.reduce((n, x) => n + x.length, 0))} B`;

/** An account id as the tool prints it: an EVM account as its address ++ 0xEE x 12. */
function accountText(id: Uint8Array): string {
  const evm = id.subarray(20).every((x) => x === 0xee);
  return evm ? `${checksumAddress(id.subarray(0, 20))} ++ 0xEE x 12` : bytesToHex(id);
}

/** B, the node or fixture the proofs come from, and B's lines; the caller closes the source. */
async function begin(r: KitRecords, o: ReadOptions): Promise<{ b: ImportedBlock; src: Source }> {
  let fixture: StateReadsFixture | null = null;
  let at = o.at;
  if (o.fromFixture) {
    fixture = readJson<StateReadsFixture>(resolve(o.fromFixture));
    if (fixture.kind !== "state-reads") throw new KitStop(`${o.fromFixture} is a ${fixture.kind} fixture, not state-reads`);
    if (at && at.toLowerCase() !== fixture.header.hash) throw new KitStop(`${o.fromFixture} holds proofs at ${shortHex(fixture.header.hash)}, not at ${shortHex(at)}`);
    at = fixture.header.hash;
  }
  const b = await importedBlock("sepolia", r.client, at);
  const age = b.hash === b.latest.hash ? "the client's latest block" : `${fmt(b.latest.number - b.number)} blocks below the client's latest, #${fmt(b.latest.number)}`;
  log(`  B: V3 #${fmt(b.number)} ${shortHex(b.hash)}, imported by GrandpaLightClient #2 ${shortHex(r.client)} on Sepolia (read at block ${fmt(b.readAt.number)}): ${age}; state root ${shortHex(b.stateRoot)}, finalized by set ${b.setId}`);
  if (fixture) {
    const header = hexToBytes(fixture.header.scale);
    if (bytesToHex(blake2_256(header)) !== b.hash || bytesToHex(decodeHeader(header).stateRoot) !== b.stateRoot) throw new KitStop(`${o.fromFixture}'s header of B does not hash to B or names another state root than the client's`);
    ok(`the fixture's header of B hashes to B and names the client's state root`);
    return { b, src: fixtureSource(o.fromFixture ?? "", fixture) };
  }
  const chain = await connectV3(o.rpc);
  try {
    await nodeAgrees(chain, b);
  } catch (error) {
    await chain.rpc.close();
    throw error;
  }
  ok(`the V3 node's header of B hashes to B and names the same state root`);
  return { b, src: nodeSource(chain, b) };
}

async function readBalance(r: KitRecords, o: ReadOptions, account: string): Promise<void> {
  const id = accountIdOf(account);
  log(`System.Account(${accountText(id)}) on the Portaldot V3 testnet, proven on Sepolia`);
  const { b, src } = await begin(r, o);
  try {
    const key = systemAccountKey(id);
    const read = await src.main(key, "System.Account");
    log(`  the read: System.Account, key ${key.length} B; proof ${proofSize(read.proof)}, from ${src.label}`);
    if (!read.value) {
      const outcome = outcomeOf(() => readMain(hexToBytes(b.stateRoot), read.proof, key));
      ok(`off chain: the proof shows no System.Account entry (${outcome}): an account with no balance and no nonce`);
      await readerRefuses(r, o.reader, b, { kind: "accountInfo", blockHash: hexToBytes(b.hash), accountId: id, proof: read.proof }, outcome);
      return;
    }
    const a = accountInfoAt(hexToBytes(b.stateRoot), id, read.proof);
    ok(`off chain, with the contracts' checks: nonce ${a.nonce}, consumers ${a.consumers}, providers ${a.providers}, sufficients ${a.sufficients}, free ${formatTpot(a.free)} (${a.free}), reserved ${a.reserved}, frozen ${a.frozen}, flags ${a.flags === 1n << 127n ? "2^127" : a.flags}`);
    await readerStep(r, o.reader, b, { kind: "accountInfo", blockHash: hexToBytes(b.hash), accountId: id, proof: read.proof }, (x) => {
      if (x.kind !== "accountInfo") return x.kind;
      const same = JSON.stringify(Object.entries(x.info).map(([k, v]) => [k, String(v)])) === JSON.stringify(Object.entries(a).map(([k, v]) => [k, String(v)]));
      return same && x.number === b.number ? null : `${JSON.stringify(x.info, (_, v) => (typeof v === "bigint" ? v.toString() : v))} at #${x.number}`;
    }, "the same AccountInfo");
  } finally {
    await src.close();
  }
}

async function readAsset(r: KitRecords, o: ReadOptions, assetId: number, account: string): Promise<void> {
  const id = accountIdOf(account);
  log(`Assets.Account(${assetId}, ${accountText(id)}) on the Portaldot V3 testnet, proven on Sepolia`);
  const { b, src } = await begin(r, o);
  try {
    const key = assetsAccountKey(assetId, id);
    const read = await src.main(key, `Assets.Account(${assetId})`);
    log(`  the read: Assets.Account, key ${key.length} B; proof ${proofSize(read.proof)}, from ${src.label}`);
    if (!read.value) {
      const outcome = outcomeOf(() => readMain(hexToBytes(b.stateRoot), read.proof, key));
      ok(`off chain: the proof shows the account holds no asset ${assetId} (${outcome})`);
      await readerRefuses(r, o.reader, b, { kind: "assetAccount", blockHash: hexToBytes(b.hash), assetId, accountId: id, proof: read.proof }, outcome);
      return;
    }
    const a = assetAccountAt(hexToBytes(b.stateRoot), assetId, id, read.proof);
    ok(`off chain, with the contracts' checks: balance ${a.balance} (base units of asset ${assetId}), ${a.status}, ${a.reason}${a.deposit === undefined ? "" : `, deposit ${a.deposit}`}${a.depositor ? ` from ${shortHex(a.depositor)}` : ""}${read.hashed ? "; trie V1 stores the value behind its hash" : ""}`);
    const status = ["Liquid", "Frozen", "Blocked"].indexOf(a.status);
    await readerStep(r, o.reader, b, { kind: "assetAccount", blockHash: hexToBytes(b.hash), assetId, accountId: id, proof: read.proof }, (x) => {
      if (x.kind !== "assetAccount") return x.kind;
      return x.balance === a.balance && x.status === status && x.number === b.number ? null : `balance ${x.balance}, status ${x.status} at #${x.number}`;
    }, `balance ${a.balance} and status ${status} (${a.status})`);
  } finally {
    await src.close();
  }
}

async function readNft(r: KitRecords, o: ReadOptions, collection: number, item: number): Promise<void> {
  log(`Nfts.Item(${collection}, ${item}) on the Portaldot V3 testnet, proven on Sepolia`);
  const { b, src } = await begin(r, o);
  try {
    const key = nftsItemKey(collection, item);
    const read = await src.main(key, `Nfts.Item(${collection}, ${item})`);
    log(`  the read: Nfts.Item, key ${key.length} B; proof ${proofSize(read.proof)}, from ${src.label}`);
    if (!read.value) {
      const outcome = outcomeOf(() => readMain(hexToBytes(b.stateRoot), read.proof, key));
      ok(`off chain: the proof shows no item ${item} in collection ${collection} (${outcome})`);
      await readerRefuses(r, o.reader, b, { kind: "nftOwner", blockHash: hexToBytes(b.hash), collection, item, proof: read.proof }, outcome);
      return;
    }
    const n = decodeNftItem(readMain(hexToBytes(b.stateRoot), read.proof, key));
    ok(`off chain, with the contracts' checks: owner ${accountText(n.owner)}, ${n.approvals.length} approvals, deposit ${n.deposit.amount} from ${shortHex(n.deposit.account)}`);
    await readerStep(r, o.reader, b, { kind: "nftOwner", blockHash: hexToBytes(b.hash), collection, item, proof: read.proof }, (x) => {
      if (x.kind !== "nftOwner") return x.kind;
      return equalBytes(x.owner, n.owner) && x.number === b.number ? null : `owner ${bytesToHex(x.owner)} at #${x.number}`;
    }, "the same owner");
  } finally {
    await src.close();
  }
}

/** A contract slot's proofs at B and the walk of all three, printed. */
async function slotRead(src: Source, b: ImportedBlock, address: Uint8Array, slot: Uint8Array): Promise<FetchedSlot> {
  const s = await src.slot(address, slot);
  log(`  the read: Revive.AccountInfoOf(${checksumAddress(address)}), the root of its child trie, and slot ${shortHex(slot)} under blake2_256(slot); proofs of ${s.account.length} + ${s.childRootProof.length} + ${s.slotProof.length} items (${proofSize([...s.account, ...s.childRootProof, ...s.slotProof])}), from ${src.label}`);
  ok(`the contract: code hash ${shortHex(s.codeHash)}, trie id ${shortHex(s.trieId)}, child root ${shortHex(s.childRoot)}`);
  return s;
}

const proofsOf = (s: FetchedSlot): ContractSlotProofs => ({ account: s.account, childRoot: s.childRootProof, slot: s.slotProof });

async function readSlot(r: KitRecords, o: ReadOptions, contract: string, slotText: string): Promise<void> {
  const address = parseAddress(contract, "--contract");
  const slot = slotText.startsWith("0x") ? (() => {
    const raw = hexToBytes(slotText);
    if (raw.length > 32) throw new KitStop(`--slot ${slotText} is longer than 32 bytes`);
    const word = new Uint8Array(32);
    word.set(raw, 32 - raw.length);
    return word;
  })() : uintWord(BigInt(slotText));
  log(`Slot ${bytesToHex(slot)} of the contract ${checksumAddress(address)} on the Portaldot V3 testnet, proven on Sepolia`);
  const { b, src } = await begin(r, o);
  try {
    const s = await slotRead(src, b, address, slot);
    if (!s.word) {
      ok(`off chain: the child proof shows the slot empty (KeyNotPresent): a zero word is not stored`);
      await readerRefuses(r, o.reader, b, { kind: "contractSlot", blockHash: hexToBytes(b.hash), address, slot, proofs: proofsOf(s) }, "KeyNotPresent");
      return;
    }
    const read = contractSlotAt(hexToBytes(b.stateRoot), address, slot, proofsOf(s));
    ok(`off chain, with the contracts' checks: the word ${bytesToHex(read.word)}`);
    await readerStep(r, o.reader, b, { kind: "contractSlot", blockHash: hexToBytes(b.hash), address, slot, proofs: proofsOf(s) }, (x) => {
      if (x.kind !== "contractSlot") return x.kind;
      return equalBytes(x.word, read.word) && equalBytes(x.codeHash, read.codeHash) && x.number === b.number ? null : `word ${bytesToHex(x.word)}, code hash ${bytesToHex(x.codeHash)} at #${x.number}`;
    }, "the same word and code hash");
  } finally {
    await src.close();
  }
}

async function readLock(r: KitRecords, o: ReadOptions, nonce: number): Promise<void> {
  const vault = hexToBytes(r.vault);
  log(`Lock ${nonce} of the vault ${checksumAddress(vault)}: commitments[${nonce}] on the Portaldot V3 testnet, proven on Sepolia`);
  const { b, src } = await begin(r, o);
  try {
    const slot = commitmentSlot(BigInt(nonce));
    const s = await slotRead(src, b, vault, slot);
    if (!s.word) {
      ok(`off chain: the vault holds no commitments[${nonce}] at #${fmt(b.number)} (KeyNotPresent): no lock ${nonce} at that block`);
      await readerRefuses(r, o.reader, b, { kind: "contractSlot", blockHash: hexToBytes(b.hash), address: vault, slot, proofs: proofsOf(s) }, "KeyNotPresent");
      return;
    }
    const read = contractSlotAt(hexToBytes(b.stateRoot), vault, slot, proofsOf(s));
    ok(`off chain, with the contracts' checks: commitments[${nonce}] = ${bytesToHex(read.word)}`);
    const lock = lockFacts(nonce);
    if (!lock) {
      note(`no record holds lock ${nonce}'s fields, so its commitment is not recomputed`);
    } else {
      const expected = lockCommitment({ v3ChainId: r.v3ChainId, vault, dstChainId: lock.dstChainId, dstMinter: lock.dstMinter, recipient: lock.recipient, amountNative: lock.amountNative, nonce: BigInt(nonce) });
      if (equalBytes(expected, read.word)) ok(`the commitment of the lock ${lock.source} records: ${formatTpot(lock.amountNative)} to ${checksumAddress(lock.recipient)} on chain ${lock.dstChainId}, minter ${checksumAddress(lock.dstMinter)}`);
      else fail(`the word is not the commitment of the lock ${lock.source} records (${bytesToHex(expected)})`);
    }
    await readerStep(r, o.reader, b, { kind: "contractSlot", blockHash: hexToBytes(b.hash), address: vault, slot, proofs: proofsOf(s) }, (x) => {
      if (x.kind !== "contractSlot") return x.kind;
      return equalBytes(x.word, read.word) && equalBytes(x.codeHash, read.codeHash) && x.number === b.number ? null : `word ${bytesToHex(x.word)} at #${x.number}`;
    }, "the same word and code hash");
    if (!lock || lock.dstChainId !== NETWORKS.sepolia.chainId || bytesToHex(lock.dstMinter) !== r.minter) {
      if (lock) note(`lock ${nonce} names chain ${lock.dstChainId}, minter ${checksumAddress(lock.dstMinter)}: the BridgeMinter steps run only for Sepolia's minter`);
      return;
    }
    const block = `0x${b.readAt.number.toString(16)}`;
    const commitmentOf = await ethCall(r.minter, commitmentOfCalldata(lock), block);
    if (commitmentOf.ok && equalBytes(commitmentOf.data, read.word)) ok(`BridgeMinter ${shortHex(r.minter)}.commitmentOf(${checksumAddress(lock.recipient)}, ${lock.amountNative}, ${nonce}) on Sepolia returns the same word`);
    else fail(`BridgeMinter.commitmentOf returned ${commitmentOf.ok ? bytesToHex(commitmentOf.data) : revertText(commitmentOf.revert)}`);
    const proof = lockProofOf(hexToBytes(b.hash), proofsOf(s), { recipient: lock.recipient, amount: lock.amountNative, nonce: BigInt(nonce) }, false);
    const data = mintCalldata(proof);
    const used = await ethCall(r.minter, callData(MINTER.used, uintWord(BigInt(nonce))), block);
    const minted = used.ok && uintAt(used.data, 0) === 1n;
    const mint = await ethCall(r.minter, data, block);
    if (minted) {
      const name = mint.ok ? "success" : revertText(mint.revert);
      if (!mint.ok && name === `NonceAlreadyUsed(${nonce})`) ok(`BridgeMinter.mint(p) at #${fmt(b.number)} as an eth_call (${fmt(data.length)} B of calldata) reverts ${name}: the proofs pass, and lock ${nonce} was minted already`);
      else fail(`BridgeMinter.mint(p) as an eth_call: ${name}, not NonceAlreadyUsed(${nonce})`);
    } else if (mint.ok) {
      const gas = await estimateGas(r.minter, data, block);
      const cost = "gas" in gas ? `${fmt(gas.gas)} gas (eth_estimateGas)` : `gas not estimated (${gas.refused})`;
      ok(`BridgeMinter.mint(p) at #${fmt(b.number)} as an eth_call (${fmt(data.length)} B of calldata) succeeds: anyone can send it, ${cost}, and it mints ${formatTpot(lock.amountNative).replace("tPOT", "wtPOT")} to ${checksumAddress(lock.recipient)}`);
    } else {
      fail(`BridgeMinter.mint(p) as an eth_call reverts ${revertText(mint.revert)}`);
    }
  } finally {
    await src.close();
  }
}

/** BridgeMinter.commitmentOf(recipient, amount, nonce). */
const commitmentOfCalldata = (lock: LockFacts): Uint8Array => {
  const recipient = new Uint8Array(32);
  recipient.set(lock.recipient, 12);
  return callData(MINTER.commitmentOf, recipient, uintWord(lock.amountNative), uintWord(BigInt(lock.nonce)));
};

// ---------------------------------------------------------------------------------------
// capture

const EVM = (address: string) => bytesToHex(ethAccountId(hexToBytes(address)));
const DEPLOYER = "0xD9838A86cF83C28Ee486544060D1cA4Ca2971071";
const OWNER_WALLET = "0xc6e997A757F0be410714eD04B869EFA1aEE32011";
const HOLDER = "0x3e79403610c21de20144960a0694b578ebc0dcdf";

/** The kit's main-trie reads at B, with what each one shows. */
function plannedReads(vault: Hex): { name: string; args: StateReadArgs }[] {
  return [
    { name: "System.Account of the deployer 0xD983…1071 (its EVM account)", args: { storage: "System.Account", accountId: EVM(DEPLOYER) } },
    { name: "System.Account of the owner's wallet 0xc6e9…2011 (its EVM account)", args: { storage: "System.Account", accountId: EVM(OWNER_WALLET) } },
    { name: "Assets.Account of asset 7777 (pUSD) for 0x3e79…dcdf: 60.5 pUSD", args: { storage: "Assets.Account", assetId: 7777, accountId: EVM(HOLDER) } },
    { name: "Assets.Account of asset 7777 for 0x18dd…4cfa: 4.5 pUSD", args: { storage: "Assets.Account", assetId: 7777, accountId: EVM("0x18dd7b945aab902034617a1a2cdc0d936a464cfa") } },
    { name: "Assets.Account of asset 7777 for 0x9cea…458a: 1.55 pUSD", args: { storage: "Assets.Account", assetId: 7777, accountId: EVM("0x9ceaa6abfb2bc1ac202f96496cdc683d86bc458a") } },
    { name: "Assets.Account of asset 7777 for 0x4f7d…df25: 0.1 pUSD, below the example gate's minimum", args: { storage: "Assets.Account", assetId: 7777, accountId: EVM("0x4f7d38d29172f91f77d3050a9e0f75a1aae5df25") } },
    { name: "Assets.Account of asset 7777 for the Substrate account 0xfc5b…d636: a 66-byte DepositFrom value, behind its hash (trie V1)", args: { storage: "Assets.Account", assetId: 7777, accountId: "0xfc5b8f7a52ef94d8a6ace06be6d6992e0700f97f1e930f4cfa3369682826d636" } },
    { name: "Assets.Account of asset 4601 for 0x0a90…bc49: a Frozen balance", args: { storage: "Assets.Account", assetId: 4601, accountId: "0x0a90ff27c9c8a35251352dbc066ab66f0567ea7b92aeaca670e9c273f487bc49" } },
    { name: "Assets.Account of asset 7777 for the deployer: absent", args: { storage: "Assets.Account", assetId: 7777, accountId: EVM(DEPLOYER) } },
    { name: "The Assets.Account prefix of asset 7777: a branch without a value", args: { storage: "Assets.Account prefix", assetId: 7777 } },
    { name: "Nfts.Item(10, 3163806249): an item owned by an EVM account", args: { storage: "Nfts.Item", collection: 10, item: 3163806249 } },
    { name: "Nfts.Item(0, 0): an item owned by a Substrate account", args: { storage: "Nfts.Item", collection: 0, item: 0 } },
    { name: "Nfts.Item(10, 1): absent", args: { storage: "Nfts.Item", collection: 10, item: 1 } },
    { name: "Revive.AccountInfoOf of the vault 0xa02E…8ffd: a Contract entry", args: { storage: "Revive.AccountInfoOf", address: vault } },
    { name: "Revive.AccountInfoOf of 0x0000…0001: an externally owned account's entry", args: { storage: "Revive.AccountInfoOf", address: "0x0000000000000000000000000000000000000001" } },
  ];
}

const HASHERS: Record<StateReadArgs["storage"], string> = {
  "System.Account": "Blake2_128Concat(AccountId32)",
  "Assets.Account": "Blake2_128Concat(u32) ++ Blake2_128Concat(AccountId32)",
  "Assets.Account prefix": "Blake2_128Concat(u32), the first key only",
  "Nfts.Item": "Blake2_128Concat(u32) ++ Blake2_128Concat(u32)",
  "Revive.AccountInfoOf": "Identity(H160)",
};

/** The light client's answers for B, at the Sepolia block b was read at, and the transaction that imported B. */
async function lightClientJson(client: Hex, b: ImportedBlock): Promise<StateReadsFixture["lightClient"]> {
  const block = `0x${b.readAt.number.toString(16)}`;
  const call = async (signature: string, ...words: Uint8Array[]) => {
    const answer = await ethCall(client, callData(signature, ...words), block);
    if (!answer.ok) throw new Error(`${signature} on ${client} reverted: ${revertText(answer.revert)}`);
    return answer.data;
  };
  const root = await call("stateRootOf(bytes32)", hexToBytes(b.hash));
  const setId = await call("currentSetId()");
  let importTx: StateReadsFixture["lightClient"]["importTx"] = null;
  for (const [from, to] of logWindows(Math.max(0, b.readAt.number - 50_000), b.readAt.number).reverse()) {
    const body = await rpcBody("eth_getLogs", [{ address: client, topics: [HEADER_IMPORTED_TOPIC, b.hash], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }]);
    const logs = (body.result ?? []) as { transactionHash: Hex; blockNumber: Hex }[];
    if (body.error || logs.length === 0) continue;
    const tx = await rpc<{ input: Hex; to: Hex }>("eth_getTransactionByHash", [logs[0].transactionHash]);
    const receipt = await rpc<{ status: Hex }>("eth_getTransactionReceipt", [logs[0].transactionHash]);
    const methods: Record<string, string> = {
      [bytesToHex(callData("importHeader(bytes,bytes,bytes)"))]: "importHeader",
      [bytesToHex(callData("importFinalityProof(bytes,bytes,bytes)"))]: "importFinalityProof",
    };
    const method = methods[tx.input.slice(0, 10)] ?? `a call to ${tx.to} (${tx.input.slice(0, 10)})`;
    if (receipt.status === "0x1") importTx = { hash: logs[0].transactionHash, block: Number(BigInt(logs[0].blockNumber)), method };
    break;
  }
  return {
    network: "sepolia",
    name: "GrandpaLightClient #2",
    address: client,
    readAt: { number: b.readAt.number, hash: b.readAt.hash },
    stateRootOf: { stateRoot: bytesToHex(wordAt(root, 0)), number: Number(uintAt(root, 1)) },
    headerOf: { number: b.number, stateRoot: b.stateRoot, setId: b.setId },
    latestFinalized: { number: b.latest.number, hash: b.latest.hash },
    currentSetId: Number(uintAt(setId, 0)),
    importTx,
  };
}

async function capture(o: { out?: string; at?: Hex; force: boolean; rpc: string }): Promise<void> {
  const dir = resolve(o.out ?? DEFAULT_DIR);
  const file = join(dir, FIXTURE_FILE);
  if (existsSync(file) && !o.force) throw new KitStop(`${file} is there already; --force writes over it`);
  const r = records();
  log(`Capturing the proof kit's fixture: V3 state at a block GrandpaLightClient #2 on Sepolia holds`);
  const b = await importedBlock("sepolia", r.client, o.at);
  log(`  B: V3 #${fmt(b.number)} ${b.hash}, state root ${b.stateRoot}, finalized by set ${b.setId} (client read at Sepolia block ${fmt(b.readAt.number)})`);
  const chain = await connectV3(o.rpc);
  try {
    const header = await nodeAgrees(chain, b);
    ok(`the V3 node's header of B hashes to B and names the client's state root`);
    const parentHash = bytesToHex(header.parentHash);
    const parent = await chain.header(parentHash);
    const parentRef = { number: parent.number, hash: parentHash };
    const genesisHash = await chain.rpc.request<Hex>("chain_getBlockHash", [0]);
    const runtime = await chain.runtime(b.hash);
    const version = await chain.rpc.request<string>("system_version", []);

    // The set that signs B, read at B's parent, and the set id at B.
    const setIdScale = await chain.storage(SET_ID_KEY, parentHash);
    if (!setIdScale) throw new Error("Grandpa.CurrentSetId is empty at B's parent");
    const setId = decodeU64(setIdScale, "Grandpa.CurrentSetId");
    const runtimeCallScale = hexToBytes(await chain.rpc.request<Hex>("state_call", ["GrandpaApi_grandpa_authorities", "0x", parentHash]));
    const authorities = decodeAuthorityList(runtimeCallScale);
    const keys = authorities.map((a) => a.id);
    const signingSet = authoritySetJson({ setId, at: parentRef, authorities, setIdKey: SET_ID_KEY, setIdScale, runtimeCallScale });
    const setIdAtB = await chain.storage(SET_ID_KEY, b.hash);
    if (!setIdAtB) throw new Error("Grandpa.CurrentSetId is empty at B");
    if (setId !== BigInt(b.setId)) throw new KitStop(`the set at B's parent is ${setId}, but the client says set ${b.setId} finalized B`);
    ok(`the signing set: set ${setId}, ${keys.length} keys, read at B's parent #${fmt(parent.number)}; Grandpa.CurrentSetId is ${decodeU64(setIdAtB, "set id")} at B`);

    // B's finality proof: for B itself, without unknown headers, each signature checked with the client's own check.
    const proofScale = hexToBytes(await chain.rpc.request<Hex>("grandpa_proveFinality", [b.number]));
    const proof = decodeFinalityProof(proofScale);
    if (bytesToHex(proof.block) !== b.hash || proof.unknownHeaders.length) throw new KitStop(`grandpa_proveFinality(${b.number}) proves ${shortHex(proof.block)} with ${proof.unknownHeaders.length} unknown headers, not B alone`);
    const j = decodeJustification(proof.justification);
    const verified = verifyJustification(j, keys, setId, clientVerifies);
    if (!verified.ok) throw new KitStop(`B's justification does not verify under set ${setId}: ${verified.problems.join("; ")}`);
    const hint = signersHint(j, keys, setId);
    ok(`grandpa_proveFinality(B): ${proofScale.length} B, ${verified.valid} of ${keys.length} signatures valid with the client's check, hint ${bytesToHex(hint.hint)}`);
    const lightClient = await lightClientJson(r.client, b);
    if (lightClient.stateRootOf.stateRoot !== b.stateRoot) throw new KitStop("the client's stateRootOf(B) names another root than its headerOf(B)");
    ok(`the light client's stateRootOf(B): ${shortHex(lightClient.stateRootOf.stateRoot)}; ${lightClient.importTx ? `imported by ${lightClient.importTx.method} in ${shortHex(lightClient.importTx.hash)} (Sepolia block ${fmt(lightClient.importTx.block)})` : "the import transaction was not found in the last 50,000 Sepolia blocks"}`);

    const root = hexToBytes(b.stateRoot);
    const reads: StateReadJson[] = [];
    for (const [i, planned] of plannedReads(r.vault).entries()) {
      const key = keyOfRead(planned.args);
      const fetched = await fetchMain(chain, b, key, planned.name);
      const outcome = outcomeOf(() => readAs(planned.args, root, fetched.proof));
      reads.push({
        id: i + 1,
        name: planned.name,
        args: planned.args,
        key: { hasher: HASHERS[planned.args.storage], bytes: key.length, hex: bytesToHex(key) },
        outcome,
        value: fetched.value ? { bytes: fetched.value.length, scale: bytesToHex(fetched.value), hashed: fetched.hashed, decoded: decodedJson(planned.args, fetched.value) } : null,
        proof: proofJson("state_getReadProof", fetched.proof),
      });
      ok(`read ${i + 1}: ${planned.name}: ${outcome}, ${proofSize(fetched.proof)}`);
    }

    // The vault: its trie id from read 14, the root of its child trie, and its slots.
    const vaultRead = reads.find((x) => x.args.storage === "Revive.AccountInfoOf" && x.args.address === r.vault);
    if (!vaultRead?.value) throw new Error("no AccountInfoOf entry of the vault at B");
    const trieId = hexToBytes(String(vaultRead.value.decoded.trieId));
    const codeHash = hexToBytes(String(vaultRead.value.decoded.codeHash));
    const childRootRead = await fetchMain(chain, b, childRootKey(trieId), "the vault's child root");
    if (!childRootRead.value) throw new Error("no child root of the vault at B");
    const slotPlan: { name: string; index: Uint8Array; nonce?: number }[] = [];
    for (let n = 0; n < 9; n++) slotPlan.push({ name: `commitments[${n}]`, index: commitmentSlot(BigInt(n)), nonce: n });
    slotPlan.push({ name: "nextNonce (slot 1)", index: uintWord(1n) }, { name: "outstanding (slot 2)", index: uintWord(2n) });
    const slots: StateSlotJson[] = [];
    for (const p of slotPlan) {
      const s = await fetchContractSlot(chain, b, hexToBytes(r.vault), p.index);
      if (!equalBytes(s.trieId, trieId) || !equalBytes(s.childRoot, childRootRead.value) || s.childRootProof.length !== childRootRead.proof.length) throw new Error(`${p.name}: the node served another trie id or child-root proof`);
      const outcome = s.word ? "value" : "KeyNotPresent";
      const lock = s.word && p.nonce !== undefined ? lockFacts(p.nonce) : null;
      slots.push({
        name: s.word ? p.name : `${p.name}: absent`,
        index: bytesToHex(p.index),
        key: { hasher: "blake2_256(slot)", hex: bytesToHex(blake2_256(p.index)) },
        outcome,
        value: s.word ? { bytes: s.word.length, hex: bytesToHex(s.word) } : null,
        ...(lock ? { lock: { nonce: lock.nonce, dstChainId: lock.dstChainId.toString(), dstMinter: bytesToHex(lock.dstMinter), recipient: bytesToHex(lock.recipient), amountNative: lock.amountNative.toString(), source: lock.source } } : {}),
        proof: { ...proofJson("state_getChildReadProof", s.slotProof), served: s.served },
      });
      ok(`${p.name}: ${s.word ? shortHex(s.word) : "absent"}, ${proofSize(s.slotProof)} in the child trie`);
    }

    // The tampers: a read's proof used for another key, with the walk's outcome there.
    const read3 = reads[2];
    const read11 = reads[10];
    const tamperPlan: { name: string; read: StateReadJson; key: Uint8Array }[] = [
      { name: "read 3's proof for another holder of asset 7777 (0x18dd…4cfa)", read: read3, key: assetsAccountKey(7777, ethAccountId(hexToBytes("0x18dd7b945aab902034617a1a2cdc0d936a464cfa"))) },
      { name: "read 3's proof for the deployer, who holds no asset 7777", read: read3, key: assetsAccountKey(7777, ethAccountId(hexToBytes(DEPLOYER))) },
      { name: "read 3's proof for the same holder in asset 4601", read: read3, key: assetsAccountKey(4601, ethAccountId(hexToBytes(HOLDER))) },
      { name: "read 3's proof for the prefix of asset 7777", read: read3, key: assetsAccountPrefix(7777) },
      { name: "read 11's proof for item 1 of collection 10", read: read11, key: nftsItemKey(10, 1) },
      { name: "read 11's proof for the same item number in collection 0", read: read11, key: nftsItemKey(0, 3163806249) },
    ];
    const tampers: StateTamperJson[] = tamperPlan.map((t) => ({
      name: t.name,
      read: t.read.id,
      key: bytesToHex(t.key),
      outcome: outcomeOf(() => readMain(root, t.read.proof.nodes.map((n) => hexToBytes(n)), t.key)),
    }));
    for (const t of tampers) ok(`tamper: ${t.name}: ${t.outcome}`);

    const fixture: StateReadsFixture = {
      provenance: {
        chain: "PortaldotV3 Test",
        rpc: o.rpc,
        genesisHash,
        runtime,
        block: { number: b.number, hash: b.hash },
        setId: Number(setId),
        capturedAt: new Date().toISOString(),
        tool: toolInfo(),
      },
      kind: "state-reads",
      about:
        "The proof kit's reads of V3 state at one block B that GrandpaLightClient #2 on Sepolia imported: B's header and its parent (a checkpoint in the set that signs B), grandpa_proveFinality(B) with the set and the signers hint, what the light client answers for B, and under B's state root the main-trie reads PortaldotState makes (System.Account, Assets.Account, Nfts.Item, Revive.AccountInfoOf, present and absent) and the vault's slots in its child trie, each proof walked from the root with every item used, and the tampers.",
      node: { version },
      header: headerJson(header, hexToBytes(b.hash)),
      parentHeader: headerJson(parent, header.parentHash),
      trieVersion: runtime.stateVersion === 1 ? 1 : 0,
      signingSet,
      setIdAtB: { key: bytesToHex(SET_ID_KEY), scale: bytesToHex(setIdAtB), setId: Number(decodeU64(setIdAtB, "set id")) },
      justification: justificationJson(j, proof.justification, authorities),
      finalityProof: { block: bytesToHex(proof.block), justificationBytes: proof.justification.length, unknownHeaders: proof.unknownHeaders.length, bytes: proofScale.length, scale: bytesToHex(proofScale) },
      signers: { hint: bytesToHex(hint.hint), count: hint.counted.length, threshold: verified.required },
      lightClient,
      reads,
      contract: {
        address: r.vault,
        read: vaultRead.id,
        trieId: bytesToHex(trieId),
        codeHash: bytesToHex(codeHash),
        chainId: Number(r.v3ChainId),
        childRoot: {
          key: { prefix: ":child_storage:default:", bytes: childRootKey(trieId).length, hex: bytesToHex(childRootKey(trieId)) },
          root: bytesToHex(childRootRead.value),
          proof: proofJson("state_getReadProof", childRootRead.proof),
        },
        slots,
      },
      tampers,
      notes: [
        `B is V3 #${fmt(b.number)}, which carries the change from set ${setId} to set ${setId + 1n}: set ${setId} finalized it, and Grandpa.CurrentSetId is ${setId + 1n} at B. GrandpaLightClient #2 on Sepolia imported it${lightClient.importTx ? ` with ${lightClient.importTx.method} in ${lightClient.importTx.hash} (block ${fmt(lightClient.importTx.block)})` : ""}; a fresh client initialized at set ${setId} with B's parent as the checkpoint imports it with this finality proof.`,
        "Every read is made the way PortaldotState makes it: the light client's state root of B, then the walk of StorageProofs.verifyMain, then the decoder. outcome is what the contracts do with it: value, or the error they revert with. KeyNotPresent is a proof that the key holds nothing; EmptyValue a key that holds an empty value or ends on a branch without one (the walk reports both alike).",
        "An EVM account's id on V3 is its 20-byte address followed by 12 bytes of 0xEE (pallet-revive's AccountId32Mapper); a Substrate account keeps its own 32-byte id.",
        "The asset holders and NFT owners other than the project's own accounts are public V3 chain data, read only: no transaction names them.",
        "state_getReadProof's items are kept in the order the node served them. Every item is used by the walk; any item flipped fails with \"Incomplete Proof!\". For each slot, served.mainTrieItems counts the items of state_getChildReadProof that are exactly the child-root proof's.",
        "The decoders are V3's runtime layout (portaldot-v3 3002, trie V1): an 80-byte AccountInfo, AssetAccount of 18, 34 or 66 bytes by its reason, an Nfts ItemDetails parsed whole, a 130-byte Revive Contract entry.",
      ],
    };
    const lines = checkStateReads(fixture);
    const failed = lines.filter(([passed]) => !passed);
    if (failed.length) throw new Error(`the capture does not check out: ${failed.map(([, what]) => what).join("; ")}`);
    mkdirSync(dir, { recursive: true });
    const size = writeJson(file, fixture);
    log(`\nWrote ${file} (${fmt(size)} bytes): ${reads.length} reads, ${slots.length} slots, ${tampers.length} tampers; all ${lines.length} checks pass.`);
  } finally {
    await chain.rpc.close();
  }
}

// ---------------------------------------------------------------------------------------
// check

function check(dir: string): void {
  const file = join(resolve(dir), FIXTURE_FILE);
  if (!existsSync(file)) throw new KitStop(`no ${FIXTURE_FILE} in ${resolve(dir)}`);
  const f = readJson<StateReadsFixture>(file);
  if (f.kind !== "state-reads") throw new KitStop(`${file} is a ${f.kind} fixture, not state-reads`);
  log(`${file}: V3 #${fmt(f.header.number)} ${shortHex(f.header.hash)}, captured ${f.provenance.capturedAt} from ${f.provenance.rpc}`);
  const lines = checkStateReads(f);
  for (const [passed, what] of lines) (passed ? ok : fail)(what);
  for (const n of f.notes) log(`        note: ${n}`);
  const failed = lines.filter(([passed]) => !passed).length;
  log(`\n${failed === 0 ? "All checks passed" : "Some checks FAILED"}: ${lines.length - failed} passed, ${failed} failed.`);
  process.exitCode = failed === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------------------
// The command line

const USAGE = `usage:
  npm run kit -- read balance --account <0x address | 0x 32-byte id>   [--at <V3 block hash>]
  npm run kit -- read asset   --asset <id> --account <...>             [--at]
  npm run kit -- read nft     --collection <n> --item <n>              [--at]
  npm run kit -- read slot    --contract <0x address> --slot <0x hex | decimal> [--at]
  npm run kit -- read lock    --nonce <n>                              [--at]
  npm run kit -- capture [--out <dir>] [--at <hash>] [--force]
  npm run kit -- check   [--dir <dir>]
  options: --network sepolia (only Sepolia has a Reader in v0.1), --rpc <wss url> (the V3 node),
           --reader <address> (default: deployments/sepolia-kit.json), --from-fixture <file>`;

function usage(problem: string): never {
  console.error(`${problem}\n\n${USAGE}`);
  process.exit(2);
}

function number(text: string | undefined, what: string, max = 0xffff_ffff): number {
  if (text === undefined || !/^\d+$/.test(text) || Number(text) > max) usage(`${what} takes a whole number up to ${max}`);
  return Number(text);
}

function blockHash(text: string | undefined): Hex | undefined {
  if (text === undefined) return undefined;
  if (!/^0x[0-9a-fA-F]{64}$/.test(text)) usage(`--at takes a 32-byte V3 block hash, got ${text}`);
  return text.toLowerCase() as Hex;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      account: { type: "string" },
      asset: { type: "string" },
      collection: { type: "string" },
      item: { type: "string" },
      contract: { type: "string" },
      slot: { type: "string" },
      nonce: { type: "string" },
      at: { type: "string" },
      out: { type: "string" },
      dir: { type: "string" },
      force: { type: "boolean", default: false },
      network: { type: "string", default: "sepolia" },
      rpc: { type: "string", default: V3_RPC },
      reader: { type: "string" },
      "from-fixture": { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help || positionals.length === 0) usage("");
  if (values.network !== "sepolia") usage(`--network ${values.network}: only Sepolia has a Reader in v0.1`);
  const [command, kind] = positionals;
  if (command === "check") return check(values.dir ?? DEFAULT_DIR);
  if (command === "capture") return capture({ out: values.out, at: blockHash(values.at), force: values.force ?? false, rpc: values.rpc ?? V3_RPC });
  if (command !== "read") usage(`unknown command ${command}`);
  const o: ReadOptions = {
    at: blockHash(values.at),
    rpc: values.rpc ?? V3_RPC,
    reader: values.reader === undefined ? undefined : (bytesToHex(parseAddress(values.reader, "--reader")) as Hex),
    fromFixture: values["from-fixture"],
  };
  const r = records();
  switch (kind) {
    case "balance":
      if (!values.account) usage("read balance takes --account");
      return readBalance(r, o, values.account);
    case "asset":
      if (!values.account) usage("read asset takes --asset and --account");
      return readAsset(r, o, number(values.asset, "--asset"), values.account);
    case "nft":
      return readNft(r, o, number(values.collection, "--collection"), number(values.item, "--item"));
    case "slot":
      if (!values.contract || !values.slot) usage("read slot takes --contract and --slot");
      if (!/^(0x[0-9a-fA-F]{1,64}|\d+)$/.test(values.slot)) usage(`--slot takes 0x hex of at most 32 bytes or a decimal number, got ${values.slot}`);
      return readSlot(r, o, values.contract, values.slot);
    case "lock":
      return readLock(r, o, number(values.nonce, "--nonce"));
    default:
      usage(`read takes balance, asset, nft, slot or lock, not ${kind}`);
  }
}

main()
  .then(() => {
    if (process.argv[2] === "read") log("Nothing was signed or sent.");
  })
  .catch((error: unknown) => {
    if (error instanceof KitStop || error instanceof KitUnreachable) console.error(`\nStopped: ${error.message}`);
    else console.error(error);
    process.exitCode = 1;
  });
