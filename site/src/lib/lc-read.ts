// A GRANDPA light client's state, read from any EVM chain it is deployed on (Sepolia, Base Sepolia,
// Arbitrum Sepolia): its set, its latest header, its threshold and pause flags, and the keys of its
// current set; when a block it holds was imported, from its HeaderImported log; and how far it is
// behind the chain it follows. Read-only (eth_call, eth_getLogs, eth_getBlockByNumber). Kept apart
// from the build's records so that the tests run it against a fake node.

import { decode, encodeCall } from "./abi.ts";
import type { Recorded } from "./field.ts";
import { eventTopic } from "./hashes.ts";
import type { Hex } from "./hex.ts";
import type { RollupClientFacts } from "./records-types.ts";
import { AllFailed, request, type Endpoint } from "./rpc.ts";

/** As GrandpaLightClient.sol declares it: the block hash and number are indexed; stateRoot, setId (the set that signed) and signatures are its data. */
export const HEADER_IMPORTED = eventTopic("HeaderImported(bytes32,uint32,bytes32,uint64,uint256)");

export interface ClientState {
  setId: bigint;
  latestHash: Hex;
  latestNumber: number;
  threshold: number;
  paused: boolean | null;
  halted: boolean | null;
  admin: Hex | null;
  /** How many keys its current set has (authorities(setId)); null when that read failed. */
  keys: number | null;
}

/**
 * Reads the client at `address` through `endpoints`, the first that answers: the six reads go out
 * together (one JSON-RPC batch where the node takes batches), then authorities(setId).
 */
export async function readClient(endpoints: Endpoint[], address: Hex): Promise<{ value: ClientState; endpoint: string }> {
  const call = (data: Hex) => request<Hex>(endpoints, "eth_call", [{ to: address, data }, "latest"]);
  const [set, latest, thr, paused, halted, admin] = await Promise.all(["currentSetId()", "latestFinalized()", "threshold()", "paused()", "halted()", "admin()"].map((sig) => call(encodeCall(sig))));
  const setId = decode("uint64", set!.result)[0] as bigint;
  const [latestHash, latestNumber] = decode("bytes32,uint32", latest!.result) as [Hex, bigint];
  let keys: number | null = null;
  try {
    keys = (decode("bytes32[]", (await call(encodeCall("authorities(uint64)", [setId]))).result)[0] as Hex[]).length;
  } catch {
    // The card says so; the rest of the read stands.
  }
  return {
    value: {
      setId,
      latestHash,
      latestNumber: Number(latestNumber),
      threshold: Number(decode("uint256", thr!.result)[0] as bigint),
      paused: decode("bool", paused!.result)[0] as boolean,
      halted: decode("bool", halted!.result)[0] as boolean,
      admin: decode("address", admin!.result)[0] as Hex,
      keys,
    },
    endpoint: latest!.endpoint.label,
  };
}

/** GRANDPA's threshold for `n` keys: more than two thirds. */
export const thresholdOf = (n: number): number => n - Math.floor((n - 1) / 3);

/**
 * A rollup client's recorded state, the fallback when no node answers: the relayer's newest import
 * into it by the records, with `keys` keys in its set (V3 has had 2 since the client's checkpoint).
 * Pause flags and the admin are not recorded: they show as not read.
 */
export function recordedClient(facts: RollupClientFacts | null, keys: number): Recorded<ClientState> | null {
  const r = facts?.latestImport;
  if (!r) return null;
  return {
    value: { setId: BigInt(r.setId), latestHash: r.hash, latestNumber: r.number, threshold: thresholdOf(keys), paused: null, halted: null, admin: null, keys },
    from: r.from,
  };
}

/** Minutes a client whose latest header is `clientNumber` is behind a finalized head at `headNumber`, at `blockTimeSec` a block. */
export const lagMinutes = (clientNumber: number, headNumber: number, blockTimeSec: number): number => Math.max(0, Math.round(((headNumber - clientNumber) * blockTimeSec) / 60));

/** Validator-set changes the chain made (`chainSet`, null when it could not be read) that a client at `clientSet` has not imported. */
export const setsBehind = (clientSet: bigint, chainSet: bigint | null): number => (chainSet !== null && chainSet > clientSet ? Number(chainSet - clientSet) : 0);

/** One import found on chain: the rollup block of its HeaderImported log, that block's time (ms), the set that signed it and its transaction. */
export interface FoundImport {
  block: number;
  at: number;
  /** HeaderImported.setId: the set that signed the header. */
  signedBy: bigint;
  tx: Hex | null;
}

interface RawLog {
  blockNumber: Hex;
  data: Hex;
  blockTimestamp?: Hex;
  transactionHash?: Hex;
}

const qty = (n: number): Hex => `0x${Math.max(0, n).toString(16)}`;

/** A block's time (ms), from the first endpoint that has the block. */
async function blockTime(endpoints: Endpoint[], block: number): Promise<number> {
  const b = await request<{ timestamp: Hex } | null>(endpoints, "eth_getBlockByNumber", [qty(block), false], { accept: (r) => !!r });
  return Number(BigInt(b.result!.timestamp)) * 1000;
}

/** A node that searches fewer blocks of logs than this in one call is not asked to (sepolia.base.org takes 200): it would take thousands of calls. */
export const MIN_LOG_RANGE = 10_000;

/** The most eth_getLogs calls one search makes: 12 windows of 50,000 blocks reach back about 33 h on Base Sepolia, 46 h on Arbitrum Sepolia. */
export const MAX_LOG_CALLS = 12;

/** What a search found: the import, or that it is older than block `block` (its time `at`, null when that could not be read). */
export type ImportSearch = { found: FoundImport } | { before: { block: number; at: number | null } };

/**
 * The HeaderImported log of the block `hash` on the client at `address`, searched back from the
 * chain's block `head` to `from`, newest first, in windows as wide as each node serves in one call
 * (Endpoint.logRange; one call for a node with no cap), and that block's time. A node that fails
 * hands the search to the next one, at the window it failed on. The search stops at the first log
 * found, or after `maxCalls` calls, or at `from`: then the import is older than the oldest block
 * searched, which `before` gives. Throws when no node answers.
 */
export async function searchImport(endpoints: Endpoint[], address: Hex, hash: Hex, from: number, head: number, maxCalls = MAX_LOG_CALLS): Promise<ImportSearch> {
  const nodes = endpoints.filter((e) => (e.logRange ?? Number.POSITIVE_INFINITY) >= MIN_LOG_RANGE);
  const problems: string[] = [];
  let at = 0;
  let hi = head;
  let calls = 0;
  while (hi >= from && calls < maxCalls) {
    const ep = nodes[at];
    if (!ep) throw new AllFailed("eth_getLogs", problems.length ? problems : ["no endpoint searches logs"]);
    const lo = Math.max(from, hi - (ep.logRange ?? Number.POSITIVE_INFINITY) + 1);
    calls++;
    let logs: RawLog[];
    try {
      const filter = { address, topics: [HEADER_IMPORTED, hash], fromBlock: qty(lo), toBlock: qty(hi) };
      logs = (await request<RawLog[]>([ep], "eth_getLogs", [filter], { accept: (r) => Array.isArray(r), timeoutMs: 12000, retries: 0 })).result;
    } catch (error) {
      problems.push(...(error instanceof AllFailed ? error.problems : [(error as Error).message]));
      at++;
      continue;
    }
    const log = logs.at(-1);
    if (log) {
      const signedBy = decode("bytes32,uint64,uint256", log.data)[1] as bigint;
      const block = Number(BigInt(log.blockNumber));
      // Arbitrum's own node gives every log a blockTimestamp of 0: then the block's own time is read.
      const stamped = log.blockTimestamp ? Number(BigInt(log.blockTimestamp)) : 0;
      const time = stamped > 0 ? stamped * 1000 : await blockTime([ep, ...endpoints.filter((e) => e !== ep)], block);
      return { found: { block, at: time, signedBy, tx: log.transactionHash ?? null } };
    }
    hi = lo - 1;
  }
  // Not found back to block hi + 1: the import is older than it.
  const oldest = hi + 1;
  let time: number | null = null;
  try {
    time = await blockTime(endpoints, oldest);
  } catch {
    // The card names the block's time only when it could read it.
  }
  return { before: { block: oldest, at: time } };
}
