// eth_getLogs over more blocks than a node serves in one call, on a rollup: in windows as wide as
// each endpoint takes (Endpoint.logRange; one call for a node with no known cap), newest first or
// oldest first, a node that fails handing the search to the next at the window it failed on, as
// ./lc-read.ts searches a light client's imports. A rollup makes a block every 0.2 or 0.25 s, so
// 50,000 blocks are under three hours of Base Sepolia: a search goes as far as `maxCalls` windows
// reach, and says which blocks it searched. Read-only. Kept apart from the build's records so that
// node --test runs it.

import type { Hex } from "./hex.ts";
import { MIN_LOG_RANGE } from "./lc-read.ts";
import { AllFailed, request, type Endpoint } from "./rpc.ts";

/** A log as eth_getLogs gives it: the fields every caller reads. */
export interface FoundLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  /** Some nodes add the block's timestamp to each log (hex seconds); Arbitrum's own node gives 0. */
  blockTimestamp?: string;
}

/** The most eth_getLogs calls one search makes: 24 windows of 50,000 blocks reach about 2.8 days of Base Sepolia, 3.5 of Arbitrum Sepolia. */
export const MAX_LOG_WINDOWS = 24;

export interface LogSearch<T> {
  /** Oldest first, as eth_getLogs gives them. */
  logs: T[];
  /** The oldest block searched: `from`, unless a search back from the head stopped first (at its first log, or after maxCalls windows). */
  oldest: number;
  /** The newest block searched: `head`, unless a search on from `from` stopped first. Below `oldest` when no window answered. */
  newest: number;
}

const qty = (n: number): Hex => `0x${Math.max(0, n).toString(16)}`;

/**
 * The logs of `filter` from block `from` to `head`, searched in windows: back from `head` (newest
 * first), or with `order: "oldest"` on from `from`, for a log that follows a block the caller knows
 * (a lock's mint, a burn sent after the wallet was asked). `first`: stop at the first window that
 * holds any, the newest or the oldest, as a lookup by an indexed nonce does. `onCall`: told of each
 * eth_getLogs call, for a caller that counts its reads. Throws when no node answers a window.
 */
export async function searchLogs<T extends FoundLog = FoundLog>(
  endpoints: Endpoint[],
  filter: { address: string; topics: (string | string[] | null)[] },
  from: number,
  head: number,
  opts: { maxCalls?: number; first?: boolean; order?: "newest" | "oldest"; onCall?: () => void } = {},
): Promise<LogSearch<T>> {
  const nodes = endpoints.filter((e) => (e.logRange ?? Number.POSITIVE_INFINITY) >= MIN_LOG_RANGE);
  const maxCalls = opts.maxCalls ?? MAX_LOG_WINDOWS;
  const back = opts.order !== "oldest";
  const problems: string[] = [];
  const found: T[][] = [];
  let at = 0;
  // The blocks not searched yet: lo to hi.
  let lo = from;
  let hi = head;
  let calls = 0;
  while (hi >= lo && calls < maxCalls) {
    const ep = nodes[at];
    if (!ep) throw new AllFailed("eth_getLogs", problems.length ? problems : ["no endpoint searches logs"]);
    const span = ep.logRange ?? Number.POSITIVE_INFINITY;
    const a = back ? Math.max(lo, hi - span + 1) : lo;
    const b = back ? hi : Math.min(hi, lo + span - 1);
    calls++;
    opts.onCall?.();
    let logs: T[];
    try {
      logs = (await request<T[]>([ep], "eth_getLogs", [{ ...filter, fromBlock: qty(a), toBlock: qty(b) }], { accept: (r) => Array.isArray(r), timeoutMs: 12_000, retries: 0 })).result;
    } catch (error) {
      problems.push(...(error instanceof AllFailed ? error.problems : [(error as Error).message]));
      at++;
      continue;
    }
    if (back) {
      found.unshift(logs);
      hi = a - 1;
    } else {
      found.push(logs);
      lo = b + 1;
    }
    if (opts.first && logs.length) break;
  }
  return { logs: found.flat(), oldest: back ? hi + 1 : from, newest: back ? head : lo - 1 };
}
