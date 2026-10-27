// Locks that eth_getLogs does not return. A lock sent to PortaldotVault as a Substrate extrinsic
// (revive.call signed by a 5... account, as the app's Portaldot Wallet path and v3-vault.ts lock
// --key-file send it, or a revive.call inside another call) emits its Locked event only as
// Revive.ContractEmitted in System.Events: V3's EVM RPC (eth-rpc) indexes the logs of EthTransact
// extrinsics only, so eth_getLogs never returns it. The committee's releases at V3 #117,701 and
// #173,062 show the same for Released. This file finds such a lock by its nonce, from the V3 node:
//
//   1. The block. The vault's nextNonce (slot 1) grows by one with each lock and never falls, so
//      lock n is in the first block whose state has nextNonce > n. The node serves old state, so a
//      binary search over block numbers finds that block: each probe is chain_getBlockHash and
//      childstate_getStorage of the slot in the vault's child trie (its trie id from
//      Revive.AccountInfoOf), about 17 probes over the vault's first 120,000 blocks, fewer from a
//      hint: the block of an earlier lock as the lower bound, or the block a record names, checked
//      with two probes before any search.
//   2. The event. System.Events at that block, decoded with the metadata of the runtime that ran
//      the block (state_getMetadata at its parent, read once per spec version; @polkadot/types,
//      loaded only then), gives the Revive.ContractEmitted events. The parent's, because a block
//      that upgrades the runtime is still run, and its events encoded, by the old one, while the
//      block's own state already names the new one (polkadot-js's api.at reads the parent's too).
//      The vault's event with the Locked topic and nonce n becomes the log eth_getLogs would give
//      for it (logOfEvent), which the EVM logs' parser reads (vault.ts decodeLocked, automint.ts
//      parseLockedLog).
//   3. The check. The block before does not count the lock yet, and the event's commitment is the
//      word commitments[n] holds at that block.
//
// The extrinsic's hash (blake2_256 of its bytes, from chain_getBlock) stands in for the log's
// transaction hash. Every request has the RpcClient's timeout, and nodeReads starts them at least
// MIN_INTERVAL_MS apart: a lookup without a hint makes about 40. Read-only: nothing here signs or
// sends. automint.ts, mint.ts and v3-vault.ts use it; substrate-locks.test.ts tests it on System.Events
// captured from the V3 node (fixtures/v3-testnet-events).

import type { TypeRegistry } from "@polkadot/types";
import type { EventRecord } from "@polkadot/types/interfaces";
import { bytesToHex, equalBytes, hexToBytes, type Hex } from "./bytes.js";
import { blake2_256, childRootKey, storageKey } from "./hash.js";
import { decodeReviveAccountInfo, reviveAccountInfoKey, reviveSlotKey } from "./revive.js";
import { commitmentSlot, decodeLocked, LOCKED_TOPIC, SLOTS, uintWord, type LogJson } from "./vault.js";

/** twox128("System") ++ twox128("Events"): the block's events, Vec<EventRecord>. */
export const SYSTEM_EVENTS_KEY = storageKey("System", "Events");
/** The least time between the starts of two requests of one nodeReads: at most 10 a second. */
export const MIN_INTERVAL_MS = 100;

// ---------------------------------------------------------------------------------------
// Reading the node

/** What a lookup reads from the V3 node: nodeReads over an RpcClient, a stand-in in the tests. */
export interface V3Reads {
  finalizedHead(): Promise<{ number: number; hash: Hex }>;
  blockHash(number: number): Promise<Hex>;
  /** The parent of block `at` (chain_getHeader): the runtime of its state ran `at`. */
  parentHash(at: Hex): Promise<Hex>;
  storage(key: Uint8Array, at: Hex): Promise<Uint8Array | null>;
  childStorage(childKey: Uint8Array, key: Uint8Array, at: Hex): Promise<Uint8Array | null>;
  /** The metadata of the runtime in `at`'s state, as state_getMetadata returns it (SCALE): the runtime that runs `at`'s child. */
  metadata(at: Hex): Promise<Uint8Array>;
  /** The block's extrinsics, each as its SCALE bytes (chain_getBlock). */
  extrinsics(at: Hex): Promise<Uint8Array[]>;
}

/** A JSON-RPC client: rpc.ts RpcClient, whose every request has a timeout. */
export interface Requester {
  request<T = unknown>(method: string, params?: unknown[]): Promise<T>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * V3Reads over `rpc`, each request started at least `minIntervalMs` after the one before (they
 * queue), the metadata read once per spec version (in `metadataBySpec`, which a caller that opens a
 * connection per round keeps across them). `requests()` counts what was asked.
 */
export function nodeReads(rpc: Requester, minIntervalMs = MIN_INTERVAL_MS, metadataBySpec = new Map<number, Promise<Uint8Array>>()): V3Reads & { requests(): number } {
  let queue: Promise<void> = Promise.resolve();
  let last = 0;
  let count = 0;
  const ask = <T>(method: string, params: unknown[]): Promise<T> => {
    const turn = queue.then(async () => {
      const wait = last + minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      count += 1;
    });
    queue = turn.catch(() => undefined);
    return turn.then(() => rpc.request<T>(method, params));
  };
  return {
    requests: () => count,
    async finalizedHead() {
      const hash = (await ask<Hex>("chain_getFinalizedHead", [])).toLowerCase() as Hex;
      const header = await ask<{ number: string } | null>("chain_getHeader", [hash]);
      if (!header) throw new Error(`no header for the finalized head ${hash}`);
      return { number: Number(BigInt(header.number)), hash };
    },
    async blockHash(number) {
      const hash = await ask<Hex | null>("chain_getBlockHash", [number]);
      if (!hash) throw new Error(`the node has no block #${number}`);
      return hash.toLowerCase() as Hex;
    },
    async parentHash(at) {
      const header = await ask<{ parentHash: Hex } | null>("chain_getHeader", [at]);
      if (!header) throw new Error(`the node has no header for ${at}`);
      return header.parentHash.toLowerCase() as Hex;
    },
    async storage(key, at) {
      const value = await ask<Hex | null>("state_getStorage", [bytesToHex(key), at]);
      return value === null ? null : hexToBytes(value);
    },
    async childStorage(childKey, key, at) {
      const value = await ask<Hex | null>("childstate_getStorage", [bytesToHex(childKey), bytesToHex(key), at]);
      return value === null ? null : hexToBytes(value);
    },
    async metadata(at) {
      const spec = Number((await ask<{ specVersion: number }>("state_getRuntimeVersion", [at])).specVersion);
      let m = metadataBySpec.get(spec);
      if (!m) {
        m = ask<Hex>("state_getMetadata", [at]).then(hexToBytes);
        metadataBySpec.set(spec, m);
        m.catch(() => metadataBySpec.delete(spec));
      }
      return m;
    },
    async extrinsics(at) {
      const block = await ask<{ block: { extrinsics: Hex[] } } | null>("chain_getBlock", [at]);
      if (!block) throw new Error(`the node has no block ${at}`);
      return block.block.extrinsics.map(hexToBytes);
    },
  };
}

// ---------------------------------------------------------------------------------------
// The events

/** A Revive.ContractEmitted event of a block: what a contract logged. */
export interface ContractEvent {
  /** Its index among the block's events. */
  index: number;
  /** The extrinsic it belongs to (Phase::ApplyExtrinsic), or null (the block's initialization or finalization). */
  extrinsic: number | null;
  contract: Hex;
  topics: Hex[];
  data: Hex;
}

/** The two transaction extensions in V3's metadata that polkadot-js does not know: empty structs, as v3-vault.ts connectV3 declares them. */
const USER_EXTENSIONS = { AuthorizeCall: { extrinsic: {}, payload: {} }, EthSetOrigin: { extrinsic: {}, payload: {} } };

/** One type registry per metadata (by its blake2_256), each built once per process. */
const registries = new Map<Hex, Promise<TypeRegistry>>();

function registryFor(metadata: Uint8Array): Promise<TypeRegistry> {
  const key = bytesToHex(blake2_256(metadata));
  let r = registries.get(key);
  if (!r) {
    r = (async () => {
      // Loaded only here: its crypto starts its WebAssembly in the background (see v3-vault.ts).
      const { TypeRegistry, Metadata } = await import("@polkadot/types");
      const registry = new TypeRegistry();
      registry.setMetadata(new Metadata(registry, metadata), undefined, USER_EXTENSIONS);
      return registry;
    })();
    registries.set(key, r);
    r.catch(() => registries.delete(key));
  }
  return r;
}

/**
 * The Revive.ContractEmitted events of a block's System.Events (`events`, SCALE), decoded with the
 * runtime's `metadata`; throws unless the decoding uses every byte.
 */
export async function contractEvents(metadata: Uint8Array, events: Uint8Array): Promise<ContractEvent[]> {
  const registry = await registryFor(metadata);
  const records = registry.createType("Vec<EventRecord>", events) as unknown as EventRecord[] & { encodedLength: number };
  if (records.encodedLength !== events.length) throw new Error(`System.Events holds ${events.length} bytes, and its records decode from ${records.encodedLength}`);
  const out: ContractEvent[] = [];
  records.forEach((r, index) => {
    if (r.event.section !== "revive" || r.event.method !== "ContractEmitted") return;
    const fields = r.event.data;
    if (fields.length !== 3) throw new Error(`Revive.ContractEmitted with ${fields.length} fields, not 3 (contract, data, topics)`);
    const [contract, data, topics] = fields as unknown as [{ toHex(): string }, { toHex(): string }, { toHex(): string }[]];
    out.push({
      index,
      extrinsic: r.phase.isApplyExtrinsic ? r.phase.asApplyExtrinsic.toNumber() : null,
      contract: contract.toHex().toLowerCase() as Hex,
      topics: [...topics].map((t) => t.toHex().toLowerCase() as Hex),
      data: data.toHex().toLowerCase() as Hex,
    });
  });
  return out;
}

/** The log eth_getLogs would give for a contract's event: the address, topics and data, its block (the Substrate block's hash) and `txHash`. */
export function logOfEvent(e: ContractEvent, block: { number: number; hash: Hex }, txHash: Hex | null): LogJson {
  return {
    address: e.contract,
    topics: e.topics,
    data: e.data,
    blockNumber: `0x${block.number.toString(16)}`,
    blockHash: block.hash,
    ...(txHash ? { transactionHash: txHash } : {}),
    logIndex: `0x${e.index.toString(16)}`,
  };
}

/** An extrinsic's hash, as the node names it: blake2_256 of its SCALE bytes. */
export const extrinsicHash = (bytes: Uint8Array): Hex => bytesToHex(blake2_256(bytes));

/**
 * The events `vault` emitted in block `at` (System.Events), each with its extrinsic's hash, decoded
 * with the metadata at the block's parent (`parent`, else read from `at`'s header): the runtime that
 * ran the block and encoded its events, the old one in a block that upgrades it (see the header).
 */
export async function vaultEventsAt(reads: V3Reads, vault: Hex, at: Hex, parent?: Hex): Promise<(ContractEvent & { txHash: Hex | null })[]> {
  const events = await reads.storage(SYSTEM_EVENTS_KEY, at);
  if (events === null) return [];
  const metadata = await reads.metadata(parent ?? (await reads.parentHash(at)));
  const mine = (await contractEvents(metadata, events)).filter((e) => e.contract === vault.toLowerCase());
  if (mine.length === 0) return [];
  const extrinsics = mine.some((e) => e.extrinsic !== null) ? await reads.extrinsics(at) : [];
  return mine.map((e) => {
    const bytes = e.extrinsic === null ? undefined : extrinsics[e.extrinsic];
    if (e.extrinsic !== null && !bytes) throw new LookupError(`event ${e.index} of ${at} belongs to extrinsic ${e.extrinsic}, which the block does not have`);
    return { ...e, txHash: bytes ? extrinsicHash(bytes) : null };
  });
}

// ---------------------------------------------------------------------------------------
// The lookup

/** The node served something that contradicts itself, or the lock is not where nextNonce puts it: nothing is taken from it. */
export class LookupError extends Error {
  override name = "LookupError";
}

/** A lock found in System.Events. */
export interface FoundLock {
  /** The Locked event as the log eth_getLogs would give for it (blockHash: the Substrate block's). */
  log: LogJson;
  block: { number: number; hash: Hex };
  /** The extrinsic that emitted it, its index in the block and its hash; null when no extrinsic did. */
  extrinsic: { index: number; hash: Hex } | null;
}

export interface LockQuery {
  vault: Hex;
  /** The vault's deployment block: no lock is below it. */
  vaultBlock: number;
  nonce: bigint;
  /** A block at or below the lock's (the block of an earlier lock): the search starts there. */
  from?: number;
  /** The block a record names for the lock: checked first, with two probes. */
  block?: number;
}

/** A storage word as a number: an empty slot is 0. */
const wordValue = (bytes: Uint8Array | null): bigint => (bytes === null || bytes.length === 0 ? 0n : BigInt(bytesToHex(bytes)));

/** The smallest block from `lo` to `hi` where `holds` does, for a `holds` that stays true once it is (and holds at `hi`). */
export async function firstBlockWhere(lo: number, hi: number, holds: (n: number) => Promise<boolean>): Promise<number> {
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (await holds(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

const trieIds = new WeakMap<V3Reads, Map<Hex, Promise<Uint8Array>>>();

/** The vault's trie id, from Revive.AccountInfoOf at `at`; once per reads and vault (a contract's trie id never changes). */
export function vaultTrieId(reads: V3Reads, vault: Hex, at: Hex): Promise<Uint8Array> {
  let byVault = trieIds.get(reads);
  if (!byVault) trieIds.set(reads, (byVault = new Map()));
  const key = vault.toLowerCase() as Hex;
  let t = byVault.get(key);
  if (!t) {
    t = (async () => {
      const value = await reads.storage(reviveAccountInfoKey(hexToBytes(key)), at);
      if (!value) throw new LookupError(`Revive.AccountInfoOf(${key}) is empty at ${at}: no contract there`);
      const info = decodeReviveAccountInfo(value);
      if (info.kind !== "Contract") throw new LookupError(`${key} is not a contract on V3`);
      return info.contract.trieId;
    })();
    byVault.set(key, t);
    t.catch(() => byVault.delete(key));
  }
  return t;
}

/** The word at the vault's EVM slot `slot` (32 bytes) at block `at`, from its child trie. */
export async function vaultWordAt(reads: V3Reads, vault: Hex, slot: Uint8Array, at: Hex, trieAt: Hex = at): Promise<bigint> {
  const trie = await vaultTrieId(reads, vault, trieAt);
  return wordValue(await reads.childStorage(childRootKey(trie), reviveSlotKey(slot), at));
}

/**
 * Locks `nonces` of the vault from System.Events, one after the other in ascending order, each
 * searched from the block of the one found before it (and checked first at the block `blocks` names
 * for it, from a record): a FoundLock, or null for a nonce no final block counts yet.
 */
export async function findSubstrateLocks(reads: V3Reads, q: { vault: Hex; vaultBlock: number; nonces: bigint[]; blocks?: Map<bigint, number> }): Promise<Map<bigint, FoundLock | null>> {
  const out = new Map<bigint, FoundLock | null>();
  let from: number | undefined;
  for (const nonce of [...q.nonces].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const found = await findSubstrateLock(reads, { vault: q.vault, vaultBlock: q.vaultBlock, nonce, from, block: q.blocks?.get(nonce) });
    out.set(nonce, found);
    if (found) from = found.block.number;
  }
  return out;
}

/**
 * Lock `nonce` of the vault, from System.Events (see the header): null while the vault's nextNonce
 * at V3's finalized head does not count it (no final block holds it yet). Throws LookupError when
 * the node's answers contradict each other, and whatever the node's requests throw.
 */
export async function findSubstrateLock(reads: V3Reads, q: LockQuery): Promise<FoundLock | null> {
  const head = await reads.finalizedHead();
  // Each block's hash is asked once: the probes often read the found block's and its parent's.
  const hashes = new Map<number, Promise<Hex>>();
  const hashOf = (n: number): Promise<Hex> => {
    let h = hashes.get(n);
    if (!h) hashes.set(n, (h = reads.blockHash(n)));
    return h;
  };
  const nextNonceSlot = uintWord(SLOTS.nextNonce);
  const nextNonceAt = async (n: number) => vaultWordAt(reads, q.vault, nextNonceSlot, await hashOf(n), head.hash);
  const counts = async (n: number) => n >= q.vaultBlock && (await nextNonceAt(n)) > q.nonce;
  if ((await vaultWordAt(reads, q.vault, nextNonceSlot, head.hash)) <= q.nonce) return null;

  let block: number | null = null;
  if (q.block !== undefined && q.block >= q.vaultBlock && q.block <= head.number && (await counts(q.block)) && !(await counts(q.block - 1))) block = q.block;
  if (block === null) {
    let lo = Math.min(Math.max(q.vaultBlock, q.from ?? q.vaultBlock), head.number);
    // A lower bound that counts the lock already may be past it: the search starts at the vault's block then.
    if (lo > q.vaultBlock && (await counts(lo - 1))) lo = q.vaultBlock;
    block = await firstBlockWhere(lo, head.number, counts);
  }
  const hash = await hashOf(block);
  const nonceTopic = bytesToHex(uintWord(q.nonce));
  // The events are decoded with the metadata at the block's parent: a finalized block's parent is the block before it.
  const found = (await vaultEventsAt(reads, q.vault, hash, await hashOf(block - 1))).filter((e) => e.topics[0] === LOCKED_TOPIC && e.topics[1] === nonceTopic);
  if (found.length !== 1) {
    throw new LookupError(`the vault's nextNonce passes ${q.nonce} at V3 #${block.toLocaleString("en-US")}, and its System.Events there hold ${found.length} Locked events of the vault for that nonce, not 1`);
  }
  const e = found[0];
  const at = { number: block, hash };
  const log = logOfEvent(e, at, e.txHash);
  let commitment: Uint8Array;
  try {
    commitment = decodeLocked(log).commitment;
  } catch (error) {
    throw new LookupError(`the vault's Locked event of nonce ${q.nonce} at #${block} does not decode: ${error instanceof Error ? error.message : String(error)}`);
  }
  const stored = await vaultWordAt(reads, q.vault, commitmentSlot(q.nonce), hash, head.hash);
  if (stored !== BigInt(bytesToHex(commitment)) || equalBytes(commitment, new Uint8Array(32))) {
    throw new LookupError(`commitments[${q.nonce}] holds 0x${stored.toString(16).padStart(64, "0")} at #${block}, and the Locked event there says ${bytesToHex(commitment)}`);
  }
  return { log, block: at, extrinsic: e.extrinsic === null || e.txHash === null ? null : { index: e.extrinsic, hash: e.txHash } };
}
