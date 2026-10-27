// Activity: the recorded runs of the project's test address, always listed; the transfers this
// browser started, from its journal, each linked to its live screen; and with a wallet connected,
// that address's own locks and burns, read live and read-only: the vault's Locked events on V3 and
// BridgeMinter's BurnRequested events on Sepolia, each with its status (used(nonce) on Sepolia,
// released(burnId) on V3).

import { useEffect, useState } from "preact/hooks";
import { decode, encodeCall, type AbiValue, type DecodedLog } from "../../lib/abi.ts";
import {
  DECIMALS,
  MINTER,
  SEPOLIA,
  SEPOLIA_CHAIN_ID,
  SEPOLIA_HISTORY,
  SEPOLIA_LOGS,
  V3_EVM,
  V3_SUBSTRATE_HTTP,
  V3_SUBSTRATE_WS,
  VAULT,
  records,
} from "../../lib/chains.ts";
import { checksum } from "../../lib/display.ts";
import { eventTopic } from "../../lib/hashes.ts";
import type { Hex } from "../../lib/hex.ts";
import { registry } from "../../lib/live.ts";
import { request, SubstrateClient, type Endpoint } from "../../lib/rpc.ts";
import { decodeTimestampInherent } from "../../lib/scale.ts";
import { SPEED_NAME, fromOf, toOf, type Dir, type Speed } from "../facts.ts";
import { handoffOf } from "../handoff.ts";
import { polka } from "../polkadot.ts";
import type { Route } from "../router.ts";
import { Box, useBox } from "../store.ts";
import { shortSs58 } from "../substrate/account.ts";
import { chainIdOf, isDone, transfers, type LiveTransfer } from "../transfers.ts";
import { Chip, Icon, Mark, dur, fmt, num, secs, short } from "../ui.tsx";
import { wallet } from "../wallet.ts";

// ---------------------------------------------------------------------------------------------
// Times and amounts

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number): string => String(n).padStart(2, "0");

/** "Oct 24, 09:51": UTC, as the records keep time. The rows print no zone, as the prototype does. */
export function dayTime(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()] ?? ""} ${d.getUTCDate()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** "09:53 UTC". */
export function clockUtc(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

const timeOf = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : Number.NaN);

/** Base units (tPOT and wtPOT both have 14 decimals) as a number to show. */
export const tok = (units: bigint | string): number => Number(BigInt(units)) / 10 ** DECIMALS;

export const qty = (n: number | bigint): string => `0x${n.toString(16)}`;

// ---------------------------------------------------------------------------------------------
// The recorded runs: lock 0, lock 1, burn 0 and burn 1, from the build's records

export interface Run {
  /** Its receipt: lock-<nonce> or burn-<burn nonce>. */
  id: string;
  dir: Dir;
  /** The lock's nonce, or the burn's. */
  n: string;
  amount: number;
  /** When it was sent (ms). */
  at: number;
  /** Minted (a lock) or released (a burn), by the records. */
  done: boolean;
  took: string;
  tookTitle: string | null;
  speed: Speed | null;
  /** The committee's release of a burn: its V3 block, and when it ran (ms). */
  release: { block: number; at: number } | null;
}

/**
 * Burn 1 (Oct 24), released in fast mode: 84 s from the burn's Sepolia block to the release's V3
 * block (README rows 56 to 58; the prototype's data.js, runBackFast.fromBlock). The records keep
 * neither block's time.
 */
const FAST_RELEASE_S: Record<string, number> = { "1": 84 };

const RP = records.returnPath;

function recordedRuns(): Run[] {
  const runs: Run[] = [];
  const b = records.bridge;
  const minted0 = b.mint.status === 1;
  runs.push({
    id: "lock-0",
    dir: "in",
    n: "0",
    amount: tok(b.lock.amountNative),
    at: timeOf(b.lock.signedAt),
    done: minted0,
    // Lock 0 was minted half a day after it was locked: its row says when, not how long.
    took: minted0 && b.mint.signedAt ? `minted ${dayTime(timeOf(b.mint.signedAt))}` : "",
    tookTitle: null,
    speed: null,
    release: null,
  });
  const r = records.latestRun;
  if (r && r.lock.nonce !== 0) {
    const minted = r.mint.status === 1;
    runs.push({
      id: `lock-${r.lock.nonce}`,
      dir: "in",
      n: String(r.lock.nonce),
      amount: tok(r.lock.amountNative),
      at: timeOf(r.lock.signedAt),
      done: minted,
      took: minted && r.timing ? secs(r.timing.totalSeconds) : "",
      tookTitle: null,
      speed: null,
      release: null,
    });
  }
  for (const burn of RP.burns) {
    if (burn.ok !== true || burn.status !== 1 || burn.burnNonce === null || burn.burnId === null) continue;
    const rel = RP.releases.find((x) => x.status === "released" && x.burnId === burn.burnId) ?? null;
    const ran = rel?.approvals.find((a) => a.action === "execute") ?? null;
    const fast = rel?.by === "fast";
    const fastS = FAST_RELEASE_S[burn.burnNonce];
    // The records time the first way back from sending the burn to running the release.
    const std = RP.timing && RP.timing.burnSentAt === burn.signedAt ? `≈ ${Math.round(RP.timing.seconds / 60)} min` : "";
    runs.push({
      id: `burn-${burn.burnNonce}`,
      dir: "back",
      n: burn.burnNonce,
      amount: tok(burn.amount),
      at: timeOf(burn.signedAt),
      done: rel !== null,
      took: rel ? (fast ? (fastS === undefined ? "" : secs(fastS)) : std) : "",
      tookTitle: rel && fast && fastS !== undefined ? "From the burn's Sepolia block to the release" : null,
      speed: rel ? (fast ? "fast" : "std") : null,
      release: rel?.releasedAt ? { block: rel.releasedAt.number, at: timeOf(ran?.signedAt) } : null,
    });
  }
  return runs.sort((x, y) => y.at - x.at);
}

export const RUNS: Run[] = recordedRuns();

/** The project's test address: every recorded run is its. */
const PROJECT = records.bridge.lock.recipient;
const PROJECT_SHORT = short(checksum(PROJECT));

// ---------------------------------------------------------------------------------------------
// The connected address's own transfers, read live

export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  /** Some nodes add the block's timestamp to each log (hex seconds). */
  blockTimestamp?: string;
}

interface FoundLock {
  nonce: bigint;
  amount: bigint;
  block: number;
  at: number | null;
  /** used(nonce) on BridgeMinter; null when it could not be read. */
  minted: boolean | null;
}

interface FoundBurn {
  nonce: bigint;
  amount: bigint;
  block: number;
  at: number | null;
  /** released(burnId) on the vault; null when it could not be read. */
  released: boolean | null;
}

interface Part<T> {
  state: "loading" | "live" | "error";
  items: T[];
  /** When the live answer was read (ms). */
  at?: number;
  error?: string;
}

interface Found {
  /** Lowercase. */
  address: string;
  locks: Part<FoundLock>;
  burns: Part<FoundBurn>;
}

/** Kept across pages, so a visit back shows the last answer while it reads again. */
const found = new Box<Found | null>(null);

// The events as contracts/src/bridge/PortaldotVault.sol and BridgeMinter.sol declare them.
const LOCKED = eventTopic("Locked(uint256,address,address,uint256,address,uint256,bytes32)");
const BURN_REQUESTED = eventTopic("BurnRequested(uint256,address,address,uint256,bytes32)");

/** Where the vault's logs start: its deployment block on V3, from the records. */
const VAULT_FROM = records.bridge.vault.deployBlock.number;
/** BridgeMinter's deployment block on Sepolia (deployments/sepolia-bridge.json, "deploy BridgeMinter"; README row 24). */
const MINTER_FROM = 11_950_851;
/** Blocks per eth_getLogs window when no endpoint takes the whole range: drpc's cap, as the relayer reads. */
const LOG_WINDOW = 10_000;
/** Past this many windows the read stops rather than send hundreds of requests. */
const MAX_WINDOWS = 60;
/** The newest rows get their block's time read; older ones show their block. */
const MAX_TIMES = 12;

const v3Node = new SubstrateClient(V3_SUBSTRATE_HTTP, V3_SUBSTRATE_WS);

const ethCall = (endpoints: Endpoint[], to: string, data: string) => request<Hex>(endpoints, "eth_call", [{ to, data }, "latest"]);

const argOf = (d: DecodedLog, name: string): AbiValue | undefined => d.args.find((a) => a.name === name)?.value;

function boolOf(data: string): boolean | null {
  try {
    const v = decode("bool", data)[0];
    return typeof v === "boolean" ? v : null;
  } catch {
    return null;
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const stampOf = (log: RawLog): number | null => (log.blockTimestamp ? Number(BigInt(log.blockTimestamp)) * 1000 : null);

/** A V3 block's time: its first extrinsic, Timestamp.set, from the Substrate node (the EVM RPC serves only recent blocks). */
async function v3Time(block: number): Promise<number> {
  const h = await v3Node.request<Hex | null>("chain_getBlockHash", [block], 9000);
  if (!h.result) throw new Error(`the V3 node has no block #${block}`);
  const b = await v3Node.request<{ block: { extrinsics: Hex[] } } | null>("chain_getBlock", [h.result], 9000);
  const first = b.result?.block.extrinsics[0];
  if (!first) throw new Error(`V3 block #${block} has no extrinsics`);
  const ms = Number(decodeTimestampInherent(first).moment);
  if (!(ms > 0) || ms > Date.now() + 10 * 60_000) throw new Error(`V3 block #${block}'s first extrinsic does not read as its time`);
  return ms;
}

export async function sepoliaTime(block: number): Promise<number> {
  const a = await request<{ timestamp?: string } | null>(SEPOLIA_HISTORY, "eth_getBlockByNumber", [qty(block), false], { accept: (r) => r !== null, timeoutMs: 10000 });
  const t = a.result?.timestamp;
  if (!t) throw new Error(`no time for Sepolia block #${block}`);
  return Number(BigInt(t)) * 1000;
}

/**
 * eth_getLogs on Sepolia from `from` to the head: the whole range first (tenderly serves wide
 * ranges), then windows of 10,000 blocks, which every endpoint of SEPOLIA_LOGS takes.
 */
async function sepoliaLogs(filter: { address: string; topics: string[] }, from: number): Promise<RawLog[]> {
  try {
    const a = await request<RawLog[]>(SEPOLIA_LOGS, "eth_getLogs", [{ ...filter, fromBlock: qty(from), toBlock: "latest" }], { timeoutMs: 15000, retries: 0 });
    if (Array.isArray(a.result)) return a.result;
  } catch {
    // Too wide for every endpoint that answered: read it in windows below.
  }
  const head = Number(BigInt((await request<Hex>(SEPOLIA, "eth_blockNumber", [])).result));
  if ((head - from) / LOG_WINDOW > MAX_WINDOWS) throw new Error(`no Sepolia endpoint served the logs from #${num(from)} in one range, and windows would take over ${MAX_WINDOWS} requests`);
  const out: RawLog[] = [];
  for (let a = from; a <= head; a += LOG_WINDOW) {
    const r = await request<RawLog[]>(SEPOLIA_LOGS, "eth_getLogs", [{ ...filter, fromBlock: qty(a), toBlock: qty(Math.min(head, a + LOG_WINDOW - 1)) }], {
      timeoutMs: 12000,
      retries: 0,
    });
    if (Array.isArray(r.result)) out.push(...r.result);
  }
  return out;
}

/** The address's locks (sent by it, or to it), with used(nonce) and each block's time. */
async function readLocks(address: string): Promise<FoundLock[]> {
  const a = await request<RawLog[]>(V3_EVM, "eth_getLogs", [{ address: VAULT, topics: [LOCKED], fromBlock: qty(VAULT_FROM), toBlock: "latest" }], { timeoutMs: 15000 });
  const mine = new Map<bigint, { nonce: bigint; amount: bigint; block: number; stamp: number | null }>();
  for (const log of Array.isArray(a.result) ? a.result : []) {
    const d = registry.decodeLog(log);
    if (!d || d.name !== "Locked") continue;
    const nonce = argOf(d, "nonce");
    const amount = argOf(d, "amountNative");
    // Only this bridge's locks: a lock for another chain or minter is not BridgeMinter's to mint.
    if (argOf(d, "dstChainId") !== SEPOLIA_CHAIN_ID || argOf(d, "dstMinter") !== MINTER) continue;
    if (typeof nonce !== "bigint" || typeof amount !== "bigint") continue;
    if (argOf(d, "sender") !== address && argOf(d, "recipient") !== address) continue;
    mine.set(nonce, { nonce, amount, block: Number(BigInt(log.blockNumber)), stamp: stampOf(log) });
  }
  const list = [...mine.values()].sort((x, y) => (y.nonce > x.nonce ? 1 : -1));
  const [used, times] = await Promise.all([
    Promise.allSettled(list.map((l) => ethCall(SEPOLIA, MINTER, encodeCall("used(uint256)", [l.nonce])))),
    Promise.allSettled(list.map((l, i) => (l.stamp !== null ? Promise.resolve(l.stamp) : i < MAX_TIMES ? v3Time(l.block) : Promise.reject(new Error("not read"))))),
  ]);
  return list.map((l, i) => {
    const u = used[i];
    const t = times[i];
    return { nonce: l.nonce, amount: l.amount, block: l.block, at: t?.status === "fulfilled" ? t.value : null, minted: u?.status === "fulfilled" ? boolOf(u.value.result) : null };
  });
}

/** The address's burns (sent by it, or released to it), with released(burnId) and each block's time. */
async function readBurns(address: string): Promise<FoundBurn[]> {
  const logs = await sepoliaLogs({ address: MINTER, topics: [BURN_REQUESTED] }, MINTER_FROM);
  const mine = new Map<bigint, { nonce: bigint; amount: bigint; burnId: string; block: number; stamp: number | null }>();
  for (const log of logs) {
    const d = registry.decodeLog(log);
    if (!d || d.name !== "BurnRequested") continue;
    const nonce = argOf(d, "burnNonce");
    const amount = argOf(d, "amount");
    const burnId = argOf(d, "burnId");
    if (typeof nonce !== "bigint" || typeof amount !== "bigint" || typeof burnId !== "string") continue;
    if (argOf(d, "from") !== address && argOf(d, "v3Recipient") !== address) continue;
    mine.set(nonce, { nonce, amount, burnId, block: Number(BigInt(log.blockNumber)), stamp: stampOf(log) });
  }
  const list = [...mine.values()].sort((x, y) => (y.nonce > x.nonce ? 1 : -1));
  const [released, times] = await Promise.all([
    Promise.allSettled(list.map((b) => ethCall(V3_EVM, VAULT, encodeCall("released(bytes32)", [b.burnId])))),
    Promise.allSettled(list.map((b, i) => (b.stamp !== null ? Promise.resolve(b.stamp) : i < MAX_TIMES ? sepoliaTime(b.block) : Promise.reject(new Error("not read"))))),
  ]);
  return list.map((b, i) => {
    const r = released[i];
    const t = times[i];
    return { nonce: b.nonce, amount: b.amount, block: b.block, at: t?.status === "fulfilled" ? t.value : null, released: r?.status === "fulfilled" ? boolOf(r.value.result) : null };
  });
}

/** A read's outcome; a failed refresh keeps the last live answer. */
async function settle<T>(read: Promise<T[]>, prev: Part<T> | undefined): Promise<Part<T>> {
  try {
    return { state: "live", items: await read, at: Date.now() };
  } catch (e) {
    return prev?.state === "live" ? { ...prev, error: message(e) } : { state: "error", items: [], error: message(e) };
  }
}

function patchFound(address: string, p: Partial<Pick<Found, "locks" | "burns">>): void {
  found.set((cur) => (cur && cur.address === address ? { ...cur, ...p } : cur));
}

const reading = new Set<string>();

function refresh(address: string): void {
  const cur = found.get();
  const same = cur && cur.address === address ? cur : null;
  if (!same) found.set({ address, locks: { state: "loading", items: [] }, burns: { state: "loading", items: [] } });
  // A read already under way for this address patches the state above when it lands.
  if (reading.has(address)) return;
  reading.add(address);
  void Promise.all([
    settle(readLocks(address), same?.locks).then((locks) => patchFound(address, { locks })),
    settle(readBurns(address), same?.burns).then((burns) => patchFound(address, { burns })),
  ]).finally(() => reading.delete(address));
}

// ---------------------------------------------------------------------------------------------
// Rows

/**
 * failed: not sent (declined, refused before the wallet, or not found on chain after the wallet's
 * prompt was cut off). reverted: sent and mined, reverted. replaced: the wallet sent another
 * transaction in its place. stopped: sent, or perhaps sent, and this browser stopped following it
 * (its receipt did not check out, or a read failed).
 */
type Status = "minted" | "released" | "locked" | "progress" | "unread" | "failed" | "reverted" | "replaced" | "stopped";
type Group = "action" | "progress" | "done";

interface Row {
  id: string;
  dir: Dir;
  title: string;
  /** The lock's nonce, or the burn's: on each chain they run in time order. */
  nonce: number;
  amount: number;
  status: Status;
  when: string;
  at: number | null;
  took: string;
  tookTitle: string | null;
  speed: Speed | null;
  /** Read from the chains just now, or followed by this browser; otherwise from the records. */
  live: boolean;
  /** This browser's own page for it, when it follows the transfer: its live screen or its receipt. */
  href: string | null;
  /** A lock auto-mint is to mint (handoff.ts): waiting for it, or past the time when the visitor is offered the mint. */
  handoff: "waiting" | "offer" | null;
}

const GROUP: Record<Status, Group> = {
  minted: "done",
  released: "done",
  locked: "action",
  progress: "progress",
  unread: "progress",
  failed: "action",
  reverted: "action",
  replaced: "action",
  stopped: "action",
};

/** Each status's chip: the badge kind, its text and its icon. */
const STATUS: Record<Status, readonly [string, string, string]> = {
  minted: ["verified", "Minted", "i-check"],
  released: ["trusted", "Released", "i-users"],
  locked: ["needs", "Locked, not minted", "dot"],
  progress: ["progress", "In progress", "dot"],
  unread: ["muted", "Could not read", "i-server"],
  failed: ["revert", "Not sent", "i-alert"],
  reverted: ["revert", "Reverted", "i-alert"],
  replaced: ["revert", "Replaced", "i-alert"],
  stopped: ["muted", "Not followed", "i-alert"],
};

const GROUPS: readonly (readonly [Group, string])[] = [
  ["action", "Needs action"],
  ["progress", "In progress"],
  ["done", "Done"],
];

function runRow(r: Run): Row {
  const lock = r.dir === "in";
  return {
    id: r.id,
    dir: r.dir,
    title: `${lock ? "Lock" : "Burn"} ${r.n}`,
    nonce: Number(r.n),
    amount: r.amount,
    status: r.done ? (lock ? "minted" : "released") : lock ? "locked" : "progress",
    when: dayTime(r.at),
    at: r.at,
    took: r.took,
    tookTitle: r.tookTitle,
    speed: r.speed,
    live: false,
    href: null,
    handoff: null,
  };
}

/**
 * A transfer of this browser's journal. Before its receipt gives a nonce it goes by its own id; then
 * by its lock's or its burn's, the row the chains' reads give it too. A lock on chain whose mint
 * waits for the visitor needs action (Finish mint); one that was never sent too (Not sent).
 */
function journalRow(t: LiveTransfer, now: number): Row {
  const chainId = chainIdOf(t);
  const lock = t.dir === "in";
  const n = lock ? t.nonce : t.burnNonce;
  const done = isDone(t);
  // A lock auto-mint mints (handoff.ts) waits for it, not for the visitor, until the transfer's page
  // offers the visitor's own mint (its proof checked, nothing sent yet); one it does not take waits
  // for the visitor once its plan is ready.
  const h = lock && n !== null && !done && t.lock.stage === "mined" ? handoffOf(t.amount, t.sender.kind, t.lock.minedAt, now, t.autoPending) : null;
  const own = lock && t.mint === null && t.note === null && t.proof.builtAt !== null;
  const offered = h?.kind === "offer" && own;
  const waitsForYou = lock && n !== null && !done && (t.failure !== null || offered || (h?.kind === "self" && own));
  // Stopped before its receipt gave a nonce. Not sent: declined, or refused before the wallet sent
  // it. Stopped: the page stopped following it, sent or perhaps sent (sends.ts, stopped).
  const stage = lock ? t.lock.stage : t.burn.stage;
  const r = t.failure?.reason;
  const stoppedEarly: Status | null =
    !r || n !== null ? null : r === "reverted" ? "reverted" : r === "stopped" ? "stopped" : stage === "asking" ? "failed" : r === "rejected" ? "replaced" : "stopped";
  const status: Status = done ? (lock ? "minted" : "released") : (stoppedEarly ?? (waitsForYou ? "locked" : "progress"));
  const end = lock ? (t.mint?.stage === "mined" ? t.mint.minedAt : null) : t.release.at;
  return {
    id: chainId ?? t.id,
    dir: t.dir,
    title: n !== null ? `${lock ? "Lock" : "Burn"} ${n}` : `New ${lock ? "lock" : "burn"}`,
    nonce: n ?? Number.MAX_SAFE_INTEGER,
    amount: tok(t.amount),
    status,
    when: dayTime(t.startedAt),
    at: t.startedAt,
    took: done && end !== null && !(lock && t.resumed) ? dur(Math.max(0, (end - t.startedAt) / 1000)) : "",
    tookTitle: done ? "Timed in this browser, from sending to the end" : null,
    speed: t.dir === "back" ? t.speed : null,
    live: true,
    href: done ? `#/receipt/${t.id}` : `#/tx/${t.id}`,
    handoff: t.failure !== null || !h || h.kind === "self" || (lock && t.mint !== null) ? null : offered ? "offer" : "waiting",
  };
}

function liveRows(f: Found, now: number): Row[] {
  const locks = f.locks.items.map((l): Row => {
    // Read from V3's EVM logs: an Ethereum wallet's lock. Auto-mint's, until the page offers its mint (handoff.ts); one whose block time was not read is taken as offered.
    const h = l.minted === false && l.at !== null ? handoffOf(l.amount, "evm", l.at, now, false) : null;
    const waiting = h?.kind === "waiting" || h?.kind === "pending";
    const status: Status = l.minted === true ? "minted" : l.minted === false ? (waiting ? "progress" : "locked") : "unread";
    return {
      id: `lock-${l.nonce}`,
      dir: "in",
      title: `Lock ${l.nonce}`,
      nonce: Number(l.nonce),
      amount: tok(l.amount),
      status,
      when: l.at === null ? `V3 #${num(l.block)}` : dayTime(l.at),
      at: l.at,
      took: "",
      tookTitle: null,
      speed: null,
      live: true,
      href: null,
      handoff: waiting ? "waiting" : h?.kind === "offer" ? "offer" : null,
    };
  });
  const burns = f.burns.items.map((b): Row => {
    const status: Status = b.released === true ? "released" : b.released === false ? "progress" : "unread";
    // Whether the watcher released it Fast or Standard is the watcher's record, not the chain's.
    return {
      id: `burn-${b.nonce}`,
      dir: "back",
      title: `Burn ${b.nonce}`,
      nonce: Number(b.nonce),
      amount: tok(b.amount),
      status,
      when: b.at === null ? `Sepolia #${num(b.block)}` : dayTime(b.at),
      at: b.at,
      took: "",
      tookTitle: null,
      speed: null,
      live: true,
      href: null,
      handoff: null,
    };
  });
  return [...locks, ...burns];
}

const byNonce = (x: Row, y: Row): number => y.nonce - x.nonce || 0;

/**
 * Newest first. A row whose block time was not read (past the newest MAX_TIMES of its chain, or the
 * read failed) keeps its place among its own chain's rows, whose nonces run in time order: it sorts
 * just after the newer row before it, and first only when no newer row of its chain has a time.
 */
function newestFirst(rows: Row[]): Row[] {
  const key = new Map<Row, number>();
  for (const dir of ["in", "back"] as const) {
    let newer = Number.POSITIVE_INFINITY;
    for (const r of rows.filter((x) => x.dir === dir).sort(byNonce)) {
      if (r.at !== null && Number.isFinite(r.at)) newer = r.at;
      key.set(r, newer);
    }
  }
  const k = (r: Row): number => key.get(r) ?? Number.NEGATIVE_INFINITY;
  // Ties go by chain, then nonce: one total order, so a chain's own rows never come out of nonce order.
  return [...rows].sort((x, y) => {
    const a = k(x);
    const b = k(y);
    if (a !== b) return b > a ? 1 : -1;
    if (x.dir !== y.dir) return x.dir === "in" ? -1 : 1;
    return byNonce(x, y);
  });
}

/**
 * The recorded runs, each confirmed by a live read of the same nonce when there is one, the
 * address's other transfers, and this browser's own (`journal`): those link to their live page,
 * and the chains have the last word on whether they are done.
 */
function allRows(mine: Found | null, journal: Row[], now: number): { rows: Row[]; own: number } {
  const live = mine ? liveRows(mine, now) : [];
  const recorded = RUNS.map((r) => {
    const row = runRow(r);
    const l = live.find((x) => x.id === row.id);
    return l && l.status !== "unread" ? { ...row, status: l.status, handoff: l.handoff, live: true } : row;
  });
  const rest = live.filter((l) => !recorded.some((r) => r.id === l.id));
  const rows = [...rest, ...recorded];
  for (const j of journal) {
    const i = rows.findIndex((r) => r.id === j.id);
    const r = rows[i];
    if (!r) rows.push(j);
    else rows[i] = { ...j, status: r.status === "minted" || r.status === "released" ? r.status : j.status };
  }
  return { rows: newestFirst(rows), own: live.length + journal.filter((j) => !live.some((l) => l.id === j.id)).length };
}

// ---------------------------------------------------------------------------------------------
// The view

function ActRow({ x, connected }: { x: Row; connected: boolean }) {
  const from = fromOf(x.dir);
  const to = toOf(x.dir);
  const s = STATUS[x.status];
  const action = x.status === "locked";
  const done = x.dir === "in" ? "locked" : "burned";
  // Auto-mint has not minted it in time (handoff.ts): the transfer's page offers the visitor's own mint.
  const offer = x.handoff === "offer";
  const why = action
    ? offer
      ? "Auto-mint hasn't minted it: you can send the mint yourself."
      : "Your tPOT is in the vault. The mint hasn't been sent."
    : x.status === "unread"
      ? `Could not read whether it was ${x.dir === "in" ? "minted" : "released"}.`
      : x.status === "failed"
        ? "Nothing was sent. Open it to try again."
        : x.status === "reverted"
          ? `It reverted: nothing was ${done}, only its fee was paid. Open it to try again.`
          : x.status === "replaced"
            ? `Your wallet sent another transaction in its place: nothing was ${done}. Open it to try again.`
            : x.status === "stopped"
              ? "This browser stopped following it. Open it to see why, and to follow it again."
              : null;
  // This browser's own transfer: its live page. Done: its receipt. Otherwise its transfer screen,
  // where Finish mint leads, as in the prototype. Both read a lock or a burn by this id from its
  // chain when this browser does not follow it and the records lack it.
  const href = x.href ?? (x.status === "minted" || x.status === "released" ? `#/receipt/${x.id}` : `#/tx/${x.id}`);
  const statusChip =
    x.status === "progress" ? (
      <Chip kind="progress badge--sm" icon="dot">
        {x.dir === "in" ? (x.handoff === "waiting" ? "Auto-mint minting" : "Minting") : "Awaiting committee"}
      </Chip>
    ) : (
      <Chip kind={`${s[0]} badge--sm`} icon={s[2]}>
        {s[1]}
      </Chip>
    );
  return (
    <li>
      <a class={`arow${action ? " arow--action" : ""}${why && !action ? " arow--note" : ""}`} href={href}>
        <span class="pairmark pairmark--sm" aria-hidden="true">
          <Mark id={from.markId} cls="mark--28" />
          <Mark id={to.markId} cls="mark--28" />
        </span>
        <span class="arow__main">
          <span class="arow__title">
            {fmt(x.amount)} {from.token} <span class="arow__to">→ {to.short}</span>
          </span>
          <span class="arow__meta">
            {x.title} · {x.when}
            {x.dir === "back" && x.speed ? ` · ${SPEED_NAME[x.speed]}` : ""}
            {connected ? (x.live ? " · read live" : " · recorded") : ""}
          </span>
        </span>
        <span class="arow__status">
          {statusChip}
          {x.took ? (
            <span class="arow__took" title={x.tookTitle ?? undefined}>
              {x.took}
            </span>
          ) : null}
        </span>
        {action ? (
          // The whole row is the link: the button is only drawn, as on the prototype's action rows, so
          // it is hidden from screen readers and stays out of the link's name.
          <span class="arow__cta">
            <span class="arow__why">{why}</span>
            <span class="btn btn--primary btn--sm" aria-hidden="true">
              {offer ? "Mint it yourself" : "Finish mint"}
            </span>
          </span>
        ) : why ? (
          <span class="arow__cta">
            <span class="arow__why arow__why--quiet">{why}</span>
          </span>
        ) : (
          <span class="arow__chev" aria-hidden="true">
            <Icon id="i-chevron-right" cls="i--16" />
          </span>
        )}
      </a>
    </li>
  );
}

function EmptyState({ filtered, who }: { filtered: boolean; who: string }) {
  return (
    <div class="empty">
      <svg class="empty__art" viewBox="0 0 96 96" aria-hidden="true">
        <rect x="4" y="4" width="88" height="88" rx="24" class="empty__tile" />
        <rect x="20" y="26" width="42" height="12" rx="6" class="empty__bar" />
        <rect x="34" y="58" width="42" height="12" rx="6" class="empty__bar empty__bar--b" />
        <path d="M57 32 L39 64" class="empty__beam" />
      </svg>
      <h2 class="empty__title">{filtered ? "Nothing here" : "No transfers yet"}</h2>
      <p class="empty__text">
        {filtered ? (
          "No transfers match this filter."
        ) : (
          <>
            Nothing found for <span class="mono">{who}</span> on either chain. Locks made with the command-line tools appear here too, read from the vault's logs.
          </>
        )}
      </p>
      {filtered ? (
        <a class="btn btn--secondary" href="#/activity">
          Show all
        </a>
      ) : (
        <a class="btn btn--primary btn--lg" href="#/bridge/in">
          Start a transfer
        </a>
      )}
    </div>
  );
}

/** What the live read is doing when it is not simply done: reading, or a chain that did not answer. */
function ReadNotice({ mine }: { mine: Found }) {
  const { locks, burns } = mine;
  let n: readonly [string, string, string] | null = null;
  if (locks.state === "error" && burns.state === "error") {
    n = ["i-server", "Could not read your transfers", "Neither Portaldot V3 nor Sepolia answered. The recorded runs are below; this page asks again every 2 min."];
  } else if (locks.state === "loading" || burns.state === "loading") {
    n = ["i-refresh", "Reading your transfers", "Locks from the vault's logs on V3, burns from BridgeMinter's logs on Sepolia."];
  } else if (locks.state === "error") {
    n = ["i-server", "Could not read your locks", "Portaldot V3 did not answer. Your burns are read from Sepolia; this page asks again every 2 min."];
  } else if (burns.state === "error") {
    n = ["i-server", "Could not read your burns", "Sepolia's RPCs did not answer. Your locks are read from V3; this page asks again every 2 min."];
  }
  if (!n) return null;
  return (
    <div class="notice notice--muted page__notice" role="status">
      <Icon id={n[0]} />
      <div>
        <p class="notice__title">{n[1]}</p>
        <p>{n[2]}</p>
      </div>
    </div>
  );
}

export function ActivityView({ route }: { route: Route }) {
  const w = useBox(wallet);
  const cur = useBox(found);
  const address = w.status === "on" && w.address ? w.address.toLowerCase() : null;

  // Read on arrival (unless the last answer is under 30 s old), then every 2 min while the tab shows.
  useEffect(() => {
    if (!address) return;
    const last = found.get();
    const lastAt = last && last.address === address ? Math.max(last.locks.at ?? 0, last.burns.at ?? 0) : 0;
    if (Date.now() - lastAt > 30_000) refresh(address);
    const t = setInterval(() => {
      if (!document.hidden) refresh(address);
    }, 120_000);
    return () => clearInterval(t);
  }, [address]);

  const f = route.q.get("f") ?? "all";
  const d = route.q.get("d") ?? "both";
  const mine = address && cur && cur.address === address ? cur : null;
  // This browser's transfers for the connected address, from its journal: the page is about that address.
  // A Polkadot account's locks come from the journal only: V3's EVM RPC serves no log of a Substrate extrinsic.
  const followed = useBox(transfers);
  const p = useBox(polka);
  const ss58 = p.status === "on" ? (p.account?.address ?? null) : null;
  // A Polkadot account alone: the page is about its locks this browser sent.
  const polkaOnly = !address && ss58 !== null;
  const now = Date.now();
  const journal = [...followed.values()]
    .filter((t) => (address !== null && t.recipient.toLowerCase() === address) || (ss58 !== null && t.dir === "in" && t.sender.kind === "substrate" && t.sender.ss58 === ss58))
    .map((t) => journalRow(t, now));
  const { rows, own } = allRows(mine, journal, now);
  const shown = rows.filter((x) => (f === "all" || GROUP[x.status] === f) && (d === "both" || x.dir === d));
  const counts: Record<"all" | Group, number> = { all: rows.length, action: 0, progress: 0, done: 0 };
  for (const x of rows) counts[GROUP[x.status]]++;

  // A lock waiting for auto-mint moves to Needs action when its page offers the visitor's mint: read again every 15 s meanwhile.
  const [, tick] = useState(0);
  const timed = rows.some((x) => x.handoff === "waiting");
  useEffect(() => {
    if (!timed) return;
    const t = setInterval(() => {
      if (!document.hidden) tick((n) => n + 1);
    }, 15_000);
    return () => clearInterval(t);
  }, [timed]);

  const who = address && w.address ? short(w.address) : polkaOnly && ss58 ? shortSs58(ss58) : PROJECT_SHORT;
  const other = !!address && address !== PROJECT;
  // Both reads answered and found nothing for the address: the empty state, above the recorded runs.
  const none = !!mine && mine.locks.state === "live" && mine.burns.state === "live" && own === 0 && f === "all" && d === "both";

  const seg = (key: "f" | "d", val: string, label: string, cnt?: number) => {
    const href = `#/activity?${key === "f" ? `f=${val}${d !== "both" ? `&d=${d}` : ""}` : `${f !== "all" ? `f=${f}&` : ""}d=${val}`}`;
    const on = (key === "f" ? f : d) === val;
    return (
      <a key={`${key}-${val}`} class={`filter${on ? " is-on" : ""}`} href={href} aria-current={on ? "true" : undefined}>
        {label}
        {cnt !== undefined ? <span class="filter__n mono">{cnt}</span> : null}
      </a>
    );
  };

  return (
    <div class="page page--narrow">
      <header class="page__head">
        <div>
          <p class="eyebrow page__eyebrow">{address ? "Your address, on both chains" : polkaOnly ? "Your Polkadot account, in this browser" : "Recorded · the project's test address"}</p>
          <h1 class="page__title">Activity</h1>
          {polkaOnly && ss58 ? (
            <p class="page__lead">
              Locks from <span class="mono">{shortSs58(ss58)}</span> that this browser sent, and their mints. The project's recorded runs are listed too, each marked
              recorded.
            </p>
          ) : (
            <p class="page__lead">
              Locks, mints, burns and releases for <span class="mono">{who}</span>, read from V3 and Sepolia. Locks made with the command-line tools appear here too.
              {other ? (
                <>
                  {" "}
                  The recorded runs are the project's test address, <span class="mono">{PROJECT_SHORT}</span>.
                </>
              ) : null}
            </p>
          )}
        </div>
      </header>
      {mine ? <ReadNotice mine={mine} /> : null}
      {ss58 ? (
        <div class="notice notice--muted page__notice" role="note">
          <Icon id="i-info" />
          <div>
            <p class="notice__title">Locks from {shortSs58(ss58)} are listed from this browser</p>
            <p>Locks you sign with a Polkadot wallet are listed only in the browser that sent them: other devices cannot find them on the chain yet.</p>
          </div>
        </div>
      ) : null}
      <nav class="filters" aria-label="Filter transfers">
        <div class="filters__scroll">
          <div class="filter-group" role="group" aria-label="Status">
            {seg("f", "all", "All", counts.all)}
            {seg("f", "action", "Needs action", counts.action)}
            {seg("f", "progress", "In progress", counts.progress)}
            {seg("f", "done", "Done", counts.done)}
          </div>
          <div class="filter-group filter-group--quiet" role="group" aria-label="Direction">
            {seg("d", "both", "Both ways")}
            {seg("d", "in", "Way in")}
            {seg("d", "back", "Way back")}
          </div>
        </div>
      </nav>
      <div class="card acard">
        {none ? <EmptyState filtered={false} who={who} /> : null}
        {shown.length ? (
          GROUPS.map(([g, label]) => {
            const gr = shown.filter((x) => GROUP[x.status] === g);
            if (!gr.length) return null;
            return (
              <section key={g} class="agroup" aria-label={label}>
                <h2 class="agroup__title">
                  {label}
                  <span class="mono">{gr.length}</span>
                </h2>
                <ul class="alist">
                  {gr.map((x) => (
                    <ActRow key={x.id} x={x} connected={!!address || polkaOnly} />
                  ))}
                </ul>
              </section>
            );
          })
        ) : (
          <EmptyState filtered={rows.length > 0} who={who} />
        )}
      </div>
    </div>
  );
}
