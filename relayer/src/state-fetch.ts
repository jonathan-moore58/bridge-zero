// The proof kit's reads from the network, read-only: the V3 block the light client on Sepolia holds
// (GrandpaLightClient #2, by eth_call), whether the V3 node agrees about that block, and the proofs
// of a read at it from the V3 node, each walked here with the contracts' checks (state.ts) before
// anything uses it. kit.ts (npm run kit) uses it. Nothing here signs or sends.
//
// Only blocks the light client imported can be read on chain: the Reader takes a block hash and
// asks the client for its state root (UnknownBlock otherwise). The V3 node keeps a block's state
// only as long as it chooses to (the testnet node still served #264,729 on Oct 31, after V3 stopped
// producing blocks); when it has discarded it, or does not answer, a fixture's proofs are the way
// left (kit.ts --from-fixture).

import { BRIDGE_ERRORS, callData, CLIENT, errorMap, revertName, uintAt, wordAt, type LockProof } from "./bridge.js";
import { bytesToHex, equalBytes, hexToBytes, shortHex, type Hex } from "./bytes.js";
import { childItems, type Chain } from "./chain.js";
import { childRootKey } from "./hash.js";
import { reviveAccountInfoKey, reviveSlotKey } from "./revive.js";
import { RpcError } from "./rpc.js";
import type { Header } from "./scale.js";
import { childSlotAt, contractAt, KIT_ERRORS, lockProofOf, outcomeOf } from "./state.js";
import { readProof } from "./trie.js";
import { checksumAddress, commitmentSlot } from "./vault.js";
import { rpc, rpcBody, useNetwork, type NetworkName } from "../../contracts/script/lib/sepolia.mjs";

/** A refusal with what to do about it. */
export class KitStop extends Error {
  override name = "KitStop";
}

/** A node that does not answer. */
export class KitUnreachable extends Error {
  override name = "KitUnreachable";
}

const ERRORS = errorMap([...BRIDGE_ERRORS, ...KIT_ERRORS]);
const FALLBACK = "run with --from-fixture <file> to take the proofs from a fixture (fixtures/v3-testnet-kit/state-reads.json holds #264,729's)";

/** A V3 node read; a node that does not answer, or no longer has the block's state, says how to go on. */
async function nodeRead<T>(what: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof RpcError && error.code === undefined) throw new KitUnreachable(`the V3 node did not answer ${what} (${message}); ${FALLBACK}`);
    if (/discarded|pruned|unknown block|not found/i.test(message)) throw new KitStop(`the V3 node no longer has the state for ${what} (${message}); ${FALLBACK}`);
    throw error;
  }
}

// ---------------------------------------------------------------------------------------
// The block

/** A V3 block the light client holds, as it answers for it. */
export interface ImportedBlock {
  network: NetworkName;
  client: Hex;
  hash: Hex;
  number: number;
  stateRoot: Hex;
  /** The set that finalized it (the client's headerOf().setId; for a checkpoint, the set installed with it). */
  setId: number;
  /** The client's latest block. */
  latest: { hash: Hex; number: number };
  /** The block of `network` the client was read at. */
  readAt: { number: number; hash: Hex };
}

const HEADER_OF = "headerOf(bytes32)";

/** Code to run at an address for one call (eth_call's state override). */
export type CodeOverrides = Record<string, { code: Hex }>;

/**
 * eth_call on the network sepolia.mjs is on: the answer, or the revert data and the node's message.
 * With `overrides`, a node that does not take the state override answers an error without revert
 * data, which comes back as a revert with none.
 */
export async function ethCall(to: Hex, data: Uint8Array, block: string, overrides?: CodeOverrides): Promise<{ ok: true; data: Uint8Array } | { ok: false; revert: Uint8Array; message: string }> {
  const body = await rpcBody("eth_call", [{ to, data: bytesToHex(data) }, block, ...(overrides ? [overrides] : [])]);
  if (!body.error) return { ok: true, data: hexToBytes(String(body.result)) };
  const message = body.error.message ?? "error";
  const revert = typeof body.error.data === "string" && body.error.data.startsWith("0x") ? hexToBytes(body.error.data) : new Uint8Array(0);
  if (revert.length === 0 && !/revert/i.test(message) && !overrides) throw new Error(`eth_call: ${message}`);
  return { ok: false, revert, message };
}

/** eth_estimateGas of a call (the 21,000 base and the calldata included), or the node's reason for not estimating it. */
export async function estimateGas(to: Hex, data: Uint8Array, block: string, overrides?: CodeOverrides): Promise<{ gas: number } | { refused: string }> {
  const body = await rpcBody("eth_estimateGas", [{ to, data: bytesToHex(data) }, block, ...(overrides ? [overrides] : [])]);
  return body.error ? { refused: body.error.message ?? "error" } : { gas: Number(BigInt(String(body.result))) };
}

/** What revert data names, such as "UnknownBlock(0x6dc4…6f50)" or 'Error("Incomplete Proof!")'. */
export const revertText = (data: Uint8Array): string => (data.length === 0 ? "a revert without data" : (revertName(data, ERRORS) ?? `revert data ${shortHex(data)}`));

/**
 * The block `at` (else the client's latest) as the light client `client` on `network` holds it:
 * latestFinalized() and headerOf(block). Refused when the client does not hold the block: the
 * Reader would revert UnknownBlock.
 */
export async function importedBlock(network: NetworkName, client: Hex, at?: Hex): Promise<ImportedBlock> {
  useNetwork(network);
  const head = await rpc<{ number: Hex; hash: Hex }>("eth_getBlockByNumber", ["latest", false]);
  const latest = await ethCall(client, callData(CLIENT.latestFinalized), head.number);
  if (!latest.ok) throw new Error(`latestFinalized() on ${client} reverted: ${revertText(latest.revert)}`);
  const latestBlock = { hash: bytesToHex(wordAt(latest.data, 0)), number: Number(uintAt(latest.data, 1)) };
  const hash = (at ?? latestBlock.hash).toLowerCase() as Hex;
  const header = await ethCall(client, callData(HEADER_OF, hexToBytes(hash)), head.number);
  if (!header.ok) {
    const name = revertText(header.revert);
    if (name.startsWith("UnknownBlock")) throw new KitStop(`${hash} is not imported by GrandpaLightClient #2 on ${network}: the Reader would revert UnknownBlock`);
    throw new Error(`headerOf(${shortHex(hash)}) reverted: ${name}`);
  }
  return {
    network,
    client,
    hash,
    number: Number(uintAt(header.data, 0)),
    stateRoot: bytesToHex(wordAt(header.data, 1)),
    setId: Number(uintAt(header.data, 2)),
    latest: latestBlock,
    readAt: { number: Number(BigInt(head.number)), hash: head.hash },
  };
}

/** The V3 node's header of the block: its SCALE bytes must hash to the block's hash (chain.ts) and name the client's number and state root. */
export async function nodeAgrees(chain: Chain, b: ImportedBlock): Promise<Header> {
  const header = await nodeRead(`the header of #${b.number}`, () => chain.header(b.hash));
  if (header.number !== b.number || bytesToHex(header.stateRoot) !== b.stateRoot) {
    throw new KitStop(`the V3 node's header of ${shortHex(b.hash)} is #${header.number} with state root ${shortHex(header.stateRoot)}; the light client holds #${b.number} with ${shortHex(b.stateRoot)}`);
  }
  return header;
}

// ---------------------------------------------------------------------------------------
// The proofs

/** A main-trie read at a block: the stored value (null when there is none) and the proof the node served, every item used. */
export interface FetchedRead {
  value: Uint8Array | null;
  proof: Uint8Array[];
  /** Whether trie V1 keeps the value behind its hash (a separate proof item). */
  hashed: boolean;
}

/**
 * The value of `key` at block `b` with its read proof (chain.ts provenRead: the value must be
 * state_getStorage's and every item used). A key without a value comes back with its proof that
 * shows so, every item used as well; whether the contracts call that KeyNotPresent or EmptyValue is
 * state.ts readMain's to say.
 */
export async function fetchMain(chain: Chain, b: { number: number; hash: Hex; stateRoot: Hex }, key: Uint8Array, what: string): Promise<FetchedRead> {
  const root = hexToBytes(b.stateRoot);
  const proven = await nodeRead(`${what} at #${b.number}`, () => chain.provenRead(root, key, b.hash, what));
  if (proven) return { value: proven.value, proof: proven.nodes, hashed: proven.hashedValues > 0 };
  const nodes = await nodeRead(`${what} at #${b.number}`, () => chain.readProof(key, b.hash));
  const read = readProof(root, nodes, key);
  if (read.value !== null) throw new Error(`${what}: state_getStorage has no value, the proof shows ${shortHex(read.value)}`);
  if (read.itemsUsed !== nodes.length) throw new Error(`the ${what} proof has ${nodes.length - read.itemsUsed} items the walk does not need`);
  return { value: null, proof: nodes, hashed: false };
}

/** A contract's slot at a block with its three proofs, as PortaldotState.contractSlotAt reads it. */
export interface FetchedSlot {
  trieId: Uint8Array;
  codeHash: Uint8Array;
  childRoot: Uint8Array;
  /** The stored word, or null when the slot is empty (the child proof shows the key absent: KeyNotPresent). */
  word: Uint8Array | null;
  account: Uint8Array[];
  childRootProof: Uint8Array[];
  slotProof: Uint8Array[];
  /** What state_getChildReadProof served: its child-trie items are slotProof; the rest must be exactly childRootProof. */
  served: { count: number; bytes: number; mainTrieItems: number };
}

/**
 * Slot `slot` (32 bytes) of the contract at `address` at block `b`: Revive.AccountInfoOf(address)
 * (a Contract entry, else NotAContract), the root of its child trie, and the slot under
 * blake2_256(slot) in it (state_getChildReadProof, whose main-trie items must be exactly the
 * child-root proof: chain.ts childItems). The word must be childstate_getStorage's where the node
 * serves it.
 */
export async function fetchContractSlot(chain: Chain, b: { number: number; hash: Hex; stateRoot: Hex }, address: Uint8Array, slot: Uint8Array): Promise<FetchedSlot> {
  const root = hexToBytes(b.stateRoot);
  const who = checksumAddress(address);
  const account = await fetchMain(chain, b, reviveAccountInfoKey(address), `Revive.AccountInfoOf(${who})`);
  if (!account.value) throw new KitStop(`${who} has no Revive.AccountInfoOf entry at #${b.number}: no contract there`);
  const { trieId, codeHash } = contractAt(root, address, account.proof);
  const rootKey = childRootKey(trieId);
  const child = await fetchMain(chain, b, rootKey, "child root");
  if (!child.value || child.value.length !== 32 || child.value.every((x) => x === 0)) throw new Error(`no 32-byte child root under ":child_storage:default:" ++ ${shortHex(trieId)}`);
  const slotKey = reviveSlotKey(slot);
  const served = await nodeRead(`the slot at #${b.number}`, () => chain.childReadProof(rootKey, slotKey, b.hash));
  const { nodes, mainTrieItems } = childItems(served, child.proof);
  const used = readProof(child.value, nodes, slotKey);
  if (used.itemsUsed !== nodes.length) throw new Error(`the child proof has ${nodes.length - used.itemsUsed} items the walk does not need`);
  let word: Uint8Array | null = null;
  const outcome = outcomeOf(() => {
    word = childSlotAt(root, trieId, slot, child.proof, nodes);
  });
  if (outcome !== "value" && outcome !== "KeyNotPresent") throw new Error(`the slot's proof gives ${outcome}`);
  const direct = await nodeRead(`the slot at #${b.number}`, () => chain.childStorage(rootKey, slotKey, b.hash));
  const proven = word as Uint8Array | null;
  if (direct !== undefined && (direct === null ? proven !== null : proven === null || !equalBytes(direct, proven))) {
    throw new Error("the child proof does not lead to the value from childstate_getStorage");
  }
  return {
    trieId,
    codeHash,
    childRoot: child.value,
    word: proven,
    account: account.proof,
    childRootProof: child.proof,
    slotProof: nodes,
    served: { count: served.length, bytes: served.reduce((n, item) => n + item.length, 0), mainTrieItems },
  };
}

/**
 * Lock `nonce` of the vault as BridgeMinter.mint takes it (THREAT_MODEL's fetch.lockProof): the
 * proofs of commitments[nonce] at block `b`, which the light client must hold, and the lock's fields,
 * which the minter recomputes the commitment from. With `bind`, the vault's AccountInfoOf proof too,
 * for a minter that still has to bind the vault (importAndMint). Anyone can send the mint: about
 * 0.72M gas at a block the client holds, against 2.4M when the same transaction imports it.
 */
export async function fetchLockProof(chain: Chain, b: { number: number; hash: Hex; stateRoot: Hex }, vault: Uint8Array, nonce: bigint, lock: { recipient: Uint8Array; amount: bigint }, o: { bind: boolean }): Promise<LockProof> {
  const s = await fetchContractSlot(chain, b, vault, commitmentSlot(nonce));
  if (!s.word) throw new KitStop(`the vault holds no commitments[${nonce}] at #${b.number}`);
  return lockProofOf(hexToBytes(b.hash), { account: s.account, childRoot: s.childRootProof, slot: s.slotProof }, { ...lock, nonce }, o.bind);
}
