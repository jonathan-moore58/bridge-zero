// The transfers the app shows. Live ones, which this browser sends and follows: a lock on V3 and its
// mint on the destination, Sepolia or a rollup (the way in), or a burn there and the committee's
// release on V3 (the way back). The code that sends (sends.ts) fills them in as the wallet and the
// chains answer, and keeps them in this browser's journal (journal.ts); the transfer screen and the
// receipt only read them. The recorded runs, from the build's records: the receipts show them and
// the replays play them, and on a rollup they stand in for logs older than its nodes search. And
// any other lock or burn, read from the chains by its nonce: Activity lists a connected wallet's,
// and links each to its transfer or its receipt.

import { useEffect } from "preact/hooks";
import { decode, encodeCall, type AbiValue, type DecodedLog } from "../lib/abi.ts";
import { DECIMALS, SEPOLIA, SEPOLIA_HISTORY, SEPOLIA_LOGS, V3_EVM, V3_SUBSTRATE_HTTP, V3_SUBSTRATE_WS, VAULT, records } from "../lib/chains.ts";
import { formatUnits } from "../lib/format.ts";
import { eventTopic } from "../lib/hashes.ts";
import { registry } from "../lib/live.ts";
import { searchLogs, type FoundLog } from "../lib/logs.ts";
import type { BurnRecord, Hex, RunStep } from "../lib/records-types.ts";
import { request, SubstrateClient, type Endpoint } from "../lib/rpc.ts";
import { decodeTimestampInherent } from "../lib/scale.ts";
import { ROLLUPS, burnKey, deployed, destOf, destOfLock, lockKey, refOf, type ChainRef, type Dest, type DestKey } from "./dests.ts";
import { FAST_CAP, type Dir, type Speed } from "./facts.ts";
import type { CheckKey, CheckState, LiveTransfer } from "./model.ts";
import { Box, useBox } from "./store.ts";

// ---------------------------------------------------------------------------------------------
// Live transfers: their shapes are model.ts's

export type { BurnTransfer, CheckKey, CheckState, Failure, LiveTransfer, LockTransfer, MintRoute, Note, SentTx } from "./model.ts";

export function waitingChecks(): Record<CheckKey, CheckState> {
  return { header: "waiting", sigs: "waiting", proof: "waiting", commit: "waiting", nonce: "waiting" };
}

/** The transfers this browser follows, by id: the journal's, read back when the page loads, and those it starts. */
export const transfers = new Box<ReadonlyMap<string, LiveTransfer>>(new Map());

export function putTransfer(t: LiveTransfer): void {
  transfers.set((m) => new Map(m).set(t.id, t));
}

export function updateTransfer(id: string, fn: (t: LiveTransfer) => LiveTransfer): void {
  transfers.set((m) => {
    const t = m.get(id);
    return t ? new Map(m).set(id, fn(t)) : m;
  });
}

/** Minted (its mint found, or minted by a transaction older than the nodes search), or released. */
export const isDone = (t: LiveTransfer): boolean => (t.dir === "in" ? t.mint?.stage === "mined" || t.mintBeyond !== undefined : t.release.released);

/** What the transfer screen's buttons ask for. sends.ts sets them when the app starts. */
export type TransferAction = "retry" | "sign" | "speedUp";
export const transferActions: Partial<Record<TransferAction, (id: string) => void>> = {};

/**
 * lock-<nonce>, burn-<burn nonce> (Sepolia's) or burn-<chain>-<burn nonce> (a rollup's): the id a
 * lock or a burn goes by in Activity, in the records and on the chains (./dests.ts, refOf).
 */
export const nonceOf = (id: string): ChainRef | null => refOf(id);

/** The lock's or the burn's id a live transfer goes by on the chains, once its receipt gave its nonce. */
export const chainIdOf = (t: LiveTransfer): string | null =>
  t.dir === "in" ? (t.nonce === null ? null : lockKey(t.nonce)) : t.burnNonce === null ? null : burnKey(t.dest, t.burnNonce);

/** The live transfer that follows lock-<n> or a burn's id, if this browser follows it. */
export function followerOf(id: string): LiveTransfer | null {
  if (!nonceOf(id)) return null;
  for (const t of transfers.get().values()) if (chainIdOf(t) === id) return t;
  return null;
}

/** The way a transfer goes, for the chain the wallet should be on: a live one, a replay, or a lock or a burn. */
export function transferDir(id: string): Dir | null {
  const t = transfers.get().get(id);
  if (t) return t.dir;
  if (id === "replay-in") return "in";
  if (id === "replay-back") return "back";
  return nonceOf(id)?.dir ?? null;
}

/** Base units as tokens, for display. */
export const toTokens = (v: bigint): number => Number(v) / 10 ** DECIMALS;

/** Base units as the bridge's amount field takes them: "0.5". */
export const amountText = (v: bigint): string => formatUnits(v, DECIMALS).replace(/,/g, "");

/**
 * How the auto-release watcher releases a burn, by its rule (README, the watcher and fast mode, and
 * "the way back from Base Sepolia and Arbitrum Sepolia"): up to 1 tPOT after its chain's fast
 * confirmations (3 on Sepolia, 180 on Base Sepolia, 144 on Arbitrum Sepolia), a larger burn after
 * its chain's finality. Whether it did, or fell back to finality because its fast budget (one for
 * the three chains) was in use, is its record, not the chain's.
 */
export const watcherSpeed = (amount: bigint): Speed => (toTokens(amount) <= FAST_CAP ? "fast" : "std");

// ---------------------------------------------------------------------------------------------
// The recorded runs

/** A lock and its mint, as the records hold them. */
export interface LockRun {
  nonce: number;
  amount: bigint;
  recipient: Hex;
  lockTx: Hex;
  lockBlock: number;
  /** When the lock was signed (ISO, UTC). */
  lockAt: string;
  /** The block the finality proof finalizes, where the storage proofs were read. */
  finalBlock: number;
  finalHash: Hex;
  setId: number;
  signatures: number;
  threshold: number;
  authorities: number;
  commitment: Hex;
  mintTx: Hex;
  mintBlock: number;
  mintGas: number;
  mintAt: string | null;
  /** The measured intervals of a timed run, in seconds (site/data/measured-runs.json). */
  steps: { lock: number; finality: number; proofs: number; mint: number } | null;
}

/** A burn and the committee's release of it. */
export interface BurnRun {
  /** The chain it was burned on: Sepolia, or a rollup, whose minter counts its own burns. */
  dest: DestKey;
  n: number;
  amount: bigint;
  payee: Hex;
  burnTx: Hex;
  burnBlock: number;
  burnId: Hex;
  /** When the burn was signed (ISO, UTC). */
  burnAt: string;
  /** Released by the watcher in fast mode (the record's "by"). */
  fast: boolean;
  open: { tx: Hex; block: number; at: string | null } | null;
  run: { tx: Hex; block: number; at: string | null };
}

/**
 * Burn 1, Fast, Oct 24 (README, rows 56 to 58 and the notes under them): the burn command at
 * 09:51:24, the burn's block at 09:51:48, member 1 opened the release at 09:52:42 and member 2 ran
 * it in the release's block at 09:53:12: 84 s from the burn's block, 108 s from sending. Sepolia's
 * final chain was checked after it: ok (deployments/v3-testnet.json, releases, finalizedCheck).
 * Seconds from sending the burn.
 */
export const FAST_RUN = { burn: 1, mined: 24, opened: 78, ran: 108 } as const;

/**
 * Burn 0, Standard, Oct 20, released by hand before the watcher existed: its block at 12:52:12,
 * final about 16.6 min later by Sepolia's epoch rule (a block is final once the third epoch after
 * its own starts), about 83 blocks of 12 s, then about 3 min of a person running the release tool;
 * 20 min from signing the burn to the release (rows 47 to 51). The approvals' own times are in the
 * records. With the watcher, Standard is about 17 min (facts.ts, TIME).
 */
export const STD_RUN = { burn: 0, finality: 996, total: 1200, blocks: 83, finLabel: "≈ 17 min", relLabel: "≈ 3 min, by hand" } as const;

/**
 * Lock 1, Oct 20: the timed run, which the way in's replay plays. The records give it while it is
 * their newest mint (latestRun); once a later mint is recorded they no longer do, and this is its
 * source. The lock: deployments/v3-testnet.json, locks[1] (README row 54). Its bundle:
 * fixtures/v3-testnet-lock1/mint-bundle.json. The mint: deployments/sepolia-bridge.json,
 * "importAndMint lock 1" (row 55). The steps: site/data/measured-runs.json.
 */
const LOCK_1: LockRun = {
  nonce: 1,
  amount: 100_000_000_000_000n,
  recipient: "0xd9838a86cf83c28ee486544060d1ca4ca2971071",
  lockTx: "0x30606cf196d5d9553c83580b7d114de91f8a4839d819320ca775351a8c6c70e4",
  lockBlock: 118_636,
  lockAt: "2026-10-20T14:45:32.561Z",
  finalBlock: 118_637,
  finalHash: "0xf7d13964affa4085c9e2e87eee896be2b621846761e9839a93aa9a831c1c5a0d",
  setId: 33,
  signatures: 2,
  threshold: 2,
  authorities: 2,
  commitment: "0x2d1ab009f006fd70b9653d09a56a3b4927775d6251c4879df9c7a1364b0ad0a7",
  mintTx: "0xb9134dd793b84ff53375cd6b5ec8fb51940fea0a5cce2b5924f674b530d7f943",
  mintBlock: 11_955_981,
  mintGas: 2_391_069,
  mintAt: "2026-10-20T14:46:09.780Z",
  steps: { lock: 10, finality: 14, proofs: 9, mint: 15 },
};

/** The newest mint in the records, its lock, its bundle and, when it was timed, its measured steps: lock 1 today. */
function fromLatest(): LockRun | null {
  const r = records.latestRun;
  if (!r || r.mint.block === null || r.mint.gasUsed === null) return null;
  const sec = (k: RunStep["key"]) => r.timing?.steps.find((s) => s.key === k)?.seconds;
  const lock = sec("lock");
  const finality = sec("finality");
  const proofs = sec("proofs");
  const mint = sec("mint");
  return {
    nonce: r.lock.nonce,
    amount: BigInt(r.lock.amountNative),
    recipient: r.lock.recipient,
    lockTx: r.lock.txHash,
    lockBlock: r.lock.block,
    lockAt: r.lock.signedAt,
    finalBlock: r.bundle.block.number,
    finalHash: r.bundle.block.hash,
    setId: r.bundle.setId,
    signatures: r.bundle.signatures,
    threshold: r.bundle.threshold,
    authorities: r.bundle.authorities,
    commitment: r.lock.commitment,
    mintTx: r.mint.txHash,
    mintBlock: r.mint.block,
    mintGas: r.mint.gasUsed,
    mintAt: r.mint.signedAt,
    steps: lock !== undefined && finality !== undefined && proofs !== undefined && mint !== undefined ? { lock, finality, proofs, mint } : null,
  };
}

/** Lock 0, Oct 19, and the first mint, which also bound the vault. */
function fromBridge(): LockRun | null {
  const b = records.bridge;
  if (b.mint.block === null || b.mint.gasUsed === null) return null;
  return {
    nonce: b.lock.nonce,
    amount: BigInt(b.lock.amountNative),
    recipient: b.lock.recipient,
    lockTx: b.lock.txHash,
    lockBlock: b.lock.block.number,
    lockAt: b.lock.signedAt,
    finalBlock: b.finality.block.number,
    finalHash: b.finality.block.hash,
    setId: b.finality.setId,
    signatures: b.finality.signers.count,
    threshold: b.finality.signers.threshold,
    authorities: b.finality.authorities.length,
    commitment: b.lock.commitment,
    mintTx: b.mint.txHash,
    mintBlock: b.mint.block,
    mintGas: b.mint.gasUsed,
    mintAt: b.mint.signedAt,
    steps: null,
  };
}

/** A recorded burn on `dest` and its release: the release is found by the burn's id, which names its chain. */
function fromBurn(b: BurnRecord, dest: DestKey): BurnRun | null {
  if (!b.txHash || b.block === null || !b.burnId || b.burnNonce === null || !b.signedAt || b.ok !== true) return null;
  const rel = records.returnPath.releases.find((r) => r.burnId === b.burnId && r.status === "released");
  const open = rel?.approvals.find((a) => a.action === "open");
  const run = rel?.approvals.find((a) => a.action === "execute");
  const runBlock = rel?.releasedAt?.number ?? run?.block ?? null;
  if (!rel || !run || runBlock === null) return null;
  return {
    dest,
    n: Number(b.burnNonce),
    amount: BigInt(b.amount),
    payee: rel.payee ?? b.v3Recipient,
    burnTx: b.txHash,
    burnBlock: b.block,
    burnId: b.burnId,
    burnAt: b.signedAt,
    fast: rel.by === "fast",
    open: open && open.block !== null ? { tx: open.extrinsicHash, block: open.block, at: open.signedAt } : null,
    run: { tx: run.extrinsicHash, block: runBlock, at: run.signedAt },
  };
}

// The newest run first: when lock 0 is also the newest, its timed record wins. Lock 1 stays once a
// later mint is the records' newest.
const FROM_RECORDS: LockRun[] = [fromLatest(), fromBridge()].filter((r): r is LockRun => r !== null);
const LOCKS: LockRun[] = FROM_RECORDS.some((r) => r.nonce === LOCK_1.nonce) ? FROM_RECORDS : [...FROM_RECORDS, LOCK_1];
// Sepolia's burns (the records' return path is deployments/sepolia-bridge.json's), then each
// rollup's (deployments/<network>-bridge.json): burn 0 on Base Sepolia and on Arbitrum Sepolia.
const BURNS: BurnRun[] = [
  ...records.returnPath.burns.map((b) => fromBurn(b, "sepolia")),
  ...ROLLUPS.flatMap((d) => (records.rollupRuns[d.key]?.burns ?? []).map((b) => fromBurn(b, d.key))),
].filter((b): b is BurnRun => b !== null);

export const lockRun = (nonce: number): LockRun | null => LOCKS.find((r) => r.nonce === nonce) ?? null;
export const burnRun = (dest: DestKey, n: number): BurnRun | null => BURNS.find((b) => b.dest === dest && b.n === n) ?? null;

/** The recorded burns and their releases, on every chain: Activity lists them, the Network page names their releases. */
export const recordedBurns = (): readonly BurnRun[] => BURNS;

/** The measured run, which the way in's replay plays and which "usually" means on a transfer: lock 1, Oct 20, whichever mint is newest. */
export function timedRun(): LockRun {
  const r = lockRun(LOCK_1.nonce);
  return r?.steps ? r : LOCK_1;
}

/** The first recorded release of each speed on Sepolia, which the way back's replays play: burn 1 (fast) and burn 0 (standard). */
export const recordedBurn = (speed: Speed): BurnRun | null => BURNS.find((b) => b.dest === "sepolia" && b.fast === (speed === "fast")) ?? null;

export type Recorded = { dir: "in"; run: LockRun } | { dir: "back"; run: BurnRun };

/**
 * A recorded run by its id: lock-<nonce> of Sepolia's recorded runs, or a burn of the records on
 * its chain (burn-<n> on Sepolia, burn-<rollup>-<n>). A rollup's locks are read from V3 as any
 * other, their mints from the records (mintOf).
 */
export function recordedOf(id: string): Recorded | null {
  const k = nonceOf(id);
  if (!k) return null;
  if (k.dir === "in") {
    const run = lockRun(k.n);
    return run ? { dir: "in", run } : null;
  }
  const run = burnRun(k.dest, k.n);
  return run ? { dir: "back", run } : null;
}

/**
 * A lock's mint on a rollup as the records hold it: auto-mint's history there
 * (deployments/automint-<network>-<sender>.jsonl), which names its transaction and block, its gas,
 * its sender and the V3 block it proved, which it imported unless it minted at a block the client
 * held. Its Minted log can be older than the rollup's nodes search, so the records answer first.
 */
function recordedMint(key: DestKey, nonce: number): ChainMint | null {
  if (key === "sepolia") return null;
  const m = records.rollupRuns[key]?.mints.find((x) => x.nonce === nonce);
  if (!m?.v3Block) return null;
  const final = { hash: m.v3Block.hash, block: m.path === "held" ? null : m.v3Block.number, setId: null, signatures: null };
  return { tx: m.txHash, block: m.block, gasUsed: m.gasUsed, from: m.sender, final };
}

// ---------------------------------------------------------------------------------------------
// Locks and burns read from the chains: any that this tab does not follow and the records lack

/** A lock by its nonce: the vault's Locked log on V3, and what came of it on the destination it names. */
export interface ChainLock {
  dir: "in";
  dest: DestKey;
  nonce: number;
  amount: bigint;
  recipient: Hex;
  commitment: Hex;
  tx: Hex;
  block: number;
  /** Its block's time (ms), when it could be read. */
  at: number | null;
  /** Whether V3 has finalized its block; null when V3's finalized head could not be read. */
  final: boolean | null;
  /** used(nonce) on the destination's BridgeMinter; null when it could not be read. */
  minted: boolean | null;
  /** The mint, once minted and found. */
  mint: ChainMint | null;
  /** Minted, and its Minted log is not in the blocks the destination's nodes search (../lib/logs.ts): its transaction is not known here. */
  mintBeyond: boolean;
}

/** BridgeMinter's Minted log for a lock, and its transaction's receipt. */
export interface ChainMint {
  tx: Hex;
  block: number;
  /** null when the receipt could not be read. */
  gasUsed: number | null;
  /** Who sent it (auto-mint's key, the locker, anyone), from the receipt; null when it could not be read. */
  from: Hex | null;
  /** The V3 block its proofs were read at: Minted's block hash, and the light client's HeaderImported for it in the same transaction. */
  final: { hash: Hex; block: number | null; setId: number | null; signatures: number | null };
}

/** A burn by its chain and its burn nonce: that chain's BridgeMinter's BurnRequested log, and what came of it. */
export interface ChainBurn {
  dir: "back";
  dest: DestKey;
  n: number;
  amount: bigint;
  payee: Hex;
  burnId: Hex;
  tx: Hex;
  block: number;
  /** Its block's time (ms), when it could be read. */
  at: number | null;
  /** released(burnId) on the vault; null when it could not be read. */
  released: boolean | null;
  /** Its chain's latest and finalized blocks at the last read; null when they could not be read. */
  heads: { latest: number; finalized: number } | null;
}

export type ChainTransfer = ChainLock | ChainBurn;

/** A burn its chain's BridgeMinter counts (burnCount) whose log is older than the blocks the nodes search: `older`, the oldest block searched. */
export interface OlderBurn {
  older: number;
}

export type ChainRead =
  | { state: "reading" }
  /** No lock or burn of this bridge goes by that nonce. */
  | { state: "none" }
  | { state: "error"; error: string }
  /** A rollup's burn on chain, older than its nodes search back: its page says so, and where to see it. */
  | { state: "older"; before: number }
  /** `error`: the last refresh failed, and this is the read before it. */
  | { state: "live"; value: ChainTransfer; at: number; error?: string };

type RawLog = FoundLog;

/**
 * A destination's logs as logsOn found them, oldest first, and, when the nodes' windows did not
 * reach over the whole range asked for, the blocks they did search (null: all of them, or the log
 * looked for was found).
 */
export interface DestLogs {
  logs: RawLog[];
  partial: { oldest: number; newest: number } | null;
}

// The events as contracts/src declares them.
const LOCKED = eventTopic("Locked(uint256,address,address,uint256,address,uint256,bytes32)");
const MINTED = eventTopic("Minted(uint256,address,uint256,bytes32)");
const BURN_REQUESTED = eventTopic("BurnRequested(uint256,address,address,uint256,bytes32)");

/** Where the vault's logs start: its deployment block on V3. */
const VAULT_FROM = records.bridge.vault.deployBlock.number;
/**
 * Where Sepolia's BridgeMinter's Minted and BurnRequested logs start: lock 0's mint, the first of
 * either (README row 24), or BridgeMinter's deployment block when the records lack it
 * (deployments/sepolia-bridge.json, "BridgeMinter deploy"). A rollup's: its minter's deployment (./dests.ts).
 */
const MINTER_FROM = records.bridge.mint.block ?? destOf("sepolia").minterFrom;
/** Blocks per eth_getLogs window when no Sepolia endpoint takes the whole range: drpc's cap, as the relayer reads. */
const LOG_WINDOW = 10_000;
/** Past this many windows the read stops rather than send hundreds of requests. */
const MAX_WINDOWS = 60;
/** How often a page reads its lock or burn again while that can still change it: the watcher's round. */
export const CHAIN_EVERY = 15_000;

const v3Node = new SubstrateClient(V3_SUBSTRATE_HTTP, V3_SUBSTRATE_WS);

const qty = (n: number): string => `0x${n.toString(16)}`;
const topicOf = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const ethCall = (endpoints: Endpoint[], to: string, data: string) => request<Hex>(endpoints, "eth_call", [{ to, data }, "latest"]);
const argOf = (d: DecodedLog, name: string): AbiValue | undefined => d.args.find((a) => a.name === name)?.value;
// Arbitrum's own node gives every log a blockTimestamp of 0: then the block's own time is read.
const stampOf = (log: RawLog): number | null => (log.blockTimestamp && BigInt(log.blockTimestamp) > 0n ? Number(BigInt(log.blockTimestamp)) * 1000 : null);
const got = <T>(r: PromiseSettledResult<T>): T | null => (r.status === "fulfilled" ? r.value : null);
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const same = (a: AbiValue | undefined, b: string): boolean => typeof a === "string" && a.toLowerCase() === b.toLowerCase();

/** A destination's endpoints for state reads, for older receipts and blocks, and for logs: Sepolia's three lists, a rollup's RPCs for each. */
const reads = (d: Dest): Endpoint[] => (d.key === "sepolia" ? SEPOLIA : [...d.rpcs]);
const history = (d: Dest): Endpoint[] => (d.key === "sepolia" ? SEPOLIA_HISTORY : [...d.rpcs]);

function boolOf(data: string): boolean | null {
  try {
    const v = decode("bool", data)[0];
    return typeof v === "boolean" ? v : null;
  } catch {
    return null;
  }
}

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

/** V3's finalized head, from the Substrate node. */
async function v3Finalized(): Promise<number> {
  const fin = await v3Node.request<Hex>("chain_getFinalizedHead", [], 9000);
  const h = await v3Node.request<{ number: string }>("chain_getHeader", [fin.result], 9000);
  return Number(BigInt(h.result.number));
}

/** A block's time (ms) on a destination. */
async function timeOn(d: Dest, block: number): Promise<number> {
  const a = await request<{ timestamp?: string } | null>(history(d), "eth_getBlockByNumber", [qty(block), false], { accept: (r) => r !== null, timeoutMs: 10000 });
  const t = a.result?.timestamp;
  if (!t) throw new Error(`no time for ${d.short} block #${block}`);
  return Number(BigInt(t)) * 1000;
}

/** A destination's latest block and its finalized block: Sepolia's finality, or on a rollup Sepolia's finality of its batch. */
async function headsOn(key: DestKey): Promise<{ latest: number; finalized: number }> {
  const d = destOf(key);
  const [latest, fin] = await Promise.all([
    request<Hex>(reads(d), "eth_blockNumber", []),
    request<{ number?: string } | null>(reads(d), "eth_getBlockByNumber", ["finalized", false], { accept: (r) => r !== null }),
  ]);
  const f = fin.result?.number;
  if (!f) throw new Error(`${d.short} gave no finalized block`);
  return { latest: Number(BigInt(latest.result)), finalized: Number(BigInt(f)) };
}

/**
 * eth_getLogs on Sepolia from `from` to the head: the whole range first (tenderly serves wide
 * ranges), then windows of 10,000 blocks, which every endpoint of SEPOLIA_LOGS takes.
 */
async function sepoliaLogs(filter: { address: string; topics: (string | null)[] }, from: number): Promise<RawLog[]> {
  try {
    const a = await request<RawLog[]>(SEPOLIA_LOGS, "eth_getLogs", [{ ...filter, fromBlock: qty(from), toBlock: "latest" }], { timeoutMs: 15000, retries: 0 });
    if (Array.isArray(a.result)) return a.result;
  } catch {
    // Too wide for every endpoint that answered: read it in windows below.
  }
  const head = Number(BigInt((await request<Hex>(SEPOLIA, "eth_blockNumber", [])).result));
  if ((head - from) / LOG_WINDOW > MAX_WINDOWS) throw new Error(`no Sepolia endpoint served the logs from #${from} in one range, and windows would take over ${MAX_WINDOWS} requests`);
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

/**
 * A destination's logs of `filter` from block `from` on, oldest first: Sepolia's as above, all of
 * them; a rollup's in the windows its nodes serve (../lib/logs.ts), as far as they reach, back from
 * its head, or with `order: "oldest"` on from `from`, and with `first` only the first window that
 * holds any: a lookup by an indexed nonce. `partial` says which blocks a rollup's search covered
 * when that was not all of them.
 */
async function logsOn(
  key: DestKey,
  filter: { address: string; topics: (string | null)[] },
  from: number,
  opts: { first?: boolean; order?: "newest" | "oldest" } = {},
): Promise<DestLogs> {
  if (key === "sepolia") return { logs: await sepoliaLogs(filter, from), partial: null };
  const d = destOf(key);
  const head = Number(BigInt((await request<Hex>(reads(d), "eth_blockNumber", [])).result));
  const lo = Math.max(from, d.minterFrom);
  const r = await searchLogs<RawLog>([...d.rpcs], filter, lo, head, opts);
  const whole = (r.oldest <= lo && r.newest >= head) || (!!opts.first && r.logs.length > 0);
  return { logs: r.logs, partial: whole ? null : { oldest: r.oldest, newest: r.newest } };
}

/** The vault's Locked log for this nonce, when it is this bridge's lock: one that names a destination of ./dests.ts and its minter. */
async function lockLog(nonce: number): Promise<ChainLock | null> {
  const a = await request<RawLog[]>(V3_EVM, "eth_getLogs", [{ address: VAULT, topics: [LOCKED, topicOf(nonce)], fromBlock: qty(VAULT_FROM), toBlock: "latest" }], {
    timeoutMs: 15000,
  });
  for (const log of Array.isArray(a.result) ? a.result : []) {
    const d = registry.decodeLog(log);
    if (!d || d.name !== "Locked" || argOf(d, "nonce") !== BigInt(nonce)) continue;
    // Only this bridge's: a lock for another chain or minter is not a BridgeMinter of ours to mint.
    const chain = argOf(d, "dstChainId");
    const minter = argOf(d, "dstMinter");
    const dest = typeof chain === "bigint" && typeof minter === "string" ? destOfLock(chain, minter) : null;
    if (!dest) continue;
    const amount = argOf(d, "amountNative");
    const recipient = argOf(d, "recipient");
    const commitment = argOf(d, "commitment");
    if (typeof amount !== "bigint" || typeof recipient !== "string" || typeof commitment !== "string") continue;
    return {
      dir: "in",
      dest: dest.key,
      nonce,
      amount,
      recipient: recipient as Hex,
      commitment: commitment as Hex,
      tx: log.transactionHash.toLowerCase() as Hex,
      block: Number(BigInt(log.blockNumber)),
      at: stampOf(log),
      final: null,
      minted: null,
      mint: null,
      mintBeyond: false,
    };
  }
  return null;
}

/**
 * The lock's Minted log on `d`: its transaction, its block and the V3 block it proved. On a rollup,
 * with `since` (when the lock was mined, ms), first on from a little before the block that time
 * gives, oldest first, where a mint sent soon after the lock is (auto-mint's, minutes later); then
 * back from the head, where one sent long after it is. "beyond": in neither, and those windows are
 * not all the blocks since the lock (Base Sepolia's public node takes 50,000 a call).
 */
async function mintLog(d: Dest, nonce: number, since: number | null): Promise<ChainMint | "beyond" | null> {
  const filter = { address: deployed(d).minter, topics: [MINTED, topicOf(nonce)] };
  let found: DestLogs;
  if (d.key !== "sepolia" && since !== null) {
    const head = Number(BigInt((await request<Hex>(reads(d), "eth_blockNumber", [])).result));
    const from = Math.max(d.minterFrom, head - Math.ceil((Date.now() - since) / (d.blockSeconds * 1000)) - 3_000);
    found = await logsOn(d.key, filter, from, { first: true, order: "oldest" });
    if (!found.logs.length && found.partial) found = await logsOn(d.key, filter, found.partial.newest + 1, { first: true });
  } else found = await logsOn(d.key, filter, d.key === "sepolia" ? MINTER_FROM : d.minterFrom, { first: true });
  for (const log of found.logs) {
    const dl = registry.decodeLog(log);
    const hash = dl?.name === "Minted" && argOf(dl, "nonce") === BigInt(nonce) ? argOf(dl, "blockHash") : undefined;
    if (typeof hash !== "string") continue;
    return { tx: log.transactionHash.toLowerCase() as Hex, block: Number(BigInt(log.blockNumber)), gasUsed: null, from: null, final: { hash: hash as Hex, block: null, setId: null, signatures: null } };
  }
  return found.partial ? "beyond" : null;
}

/**
 * The lock's mint: as the records hold it on a rollup (recordedMint), else the destination's
 * BridgeMinter's Minted log for its nonce (mintLog); then the transaction's receipt, for its gas,
 * its sender and the set and signatures of the V3 block it imported. `since`: when the lock was
 * mined (ms), when known. "beyond": minted by a transaction older than the nodes search.
 */
async function mintOf(key: DestKey, nonce: number, since: number | null = null): Promise<ChainMint | "beyond" | null> {
  const d = destOf(key);
  const found = recordedMint(key, nonce) ?? (await mintLog(d, nonce, since));
  if (found === null || found === "beyond") return found;
  const mint: ChainMint = { ...found, final: { ...found.final } };
  const hash = mint.final.hash;
  try {
    const r = await request<{ gasUsed: string; from?: string; logs: RawLog[] } | null>(history(d), "eth_getTransactionReceipt", [mint.tx], { accept: (x) => x !== null, timeoutMs: 10000 });
    if (r.result) {
      mint.gasUsed = Number(BigInt(r.result.gasUsed));
      if (typeof r.result.from === "string" && /^0x[0-9a-fA-F]{40}$/.test(r.result.from)) mint.from = r.result.from.toLowerCase() as Hex;
      // importAndMint imports the block through the destination's V3 light client first, in the same transaction.
      for (const l of r.result.logs) {
        const h = same(l.address, d.lightClient) ? registry.decodeLog(l) : null;
        if (h?.name !== "HeaderImported" || !same(argOf(h, "blockHash"), hash)) continue;
        const n = argOf(h, "number");
        const set = argOf(h, "setId");
        const sigs = argOf(h, "signatures");
        if (typeof n === "bigint" && typeof set === "bigint" && typeof sigs === "bigint") mint.final = { hash, block: Number(n), setId: Number(set), signatures: Number(sigs) };
      }
    }
  } catch {
    // The mint stands without its receipt: its gas and its V3 block show as not read, or as the records have them.
  }
  return mint;
}

/** used(nonce) on a destination's BridgeMinter: the lock is minted there, by whoever sent it. */
const usedOn = async (key: DestKey, nonce: number): Promise<boolean | null> => {
  const d = destOf(key);
  return boolOf((await ethCall(reads(d), deployed(d).minter, encodeCall("used(uint256)", [BigInt(nonce)]))).result);
};

/** A lock, and what came of it. Once read, its log is not read again; what has settled is not read again either. */
async function readLock(nonce: number, last: ChainLock | null): Promise<ChainLock | null> {
  const x = last ?? (await lockLog(nonce));
  if (!x) return null;
  const [used, final, at] = await Promise.allSettled([
    x.minted === true ? true : usedOn(x.dest, nonce),
    x.final === true ? true : v3Finalized().then((head) => head >= x.block),
    x.at ?? v3Time(x.block),
  ]);
  const minted = got(used) ?? x.minted;
  const time = got(at) ?? x.at;
  // A mint older than the nodes search is not looked for again: the page says so instead.
  const found = minted !== true || (x.mint && x.mint.gasUsed !== null) || x.mintBeyond ? null : await mintOf(x.dest, nonce, time).catch(() => null);
  const mint = minted !== true ? null : found && found !== "beyond" ? found : x.mint;
  return { ...x, minted, final: got(final) ?? x.final, at: time, mint, mintBeyond: minted === true && mint === null && (x.mintBeyond || found === "beyond") };
}

/**
 * A destination's BridgeMinter's BurnRequested log for this burn nonce, back from its head. Not in
 * the blocks a rollup's nodes search: an older burn when its minter's burnCount() counts it.
 */
async function burnLog(key: DestKey, n: number): Promise<ChainBurn | OlderBurn | null> {
  const d = destOf(key);
  const { minter } = deployed(d);
  const found = await logsOn(key, { address: minter, topics: [BURN_REQUESTED, topicOf(n)] }, key === "sepolia" ? MINTER_FROM : d.minterFrom, { first: true });
  if (!found.logs.length && found.partial) {
    const count = decode("uint256", (await ethCall(reads(d), minter, encodeCall("burnCount()"))).result)[0];
    return typeof count === "bigint" && BigInt(n) < count ? { older: found.partial.oldest } : null;
  }
  for (const log of found.logs) {
    const dl = registry.decodeLog(log);
    if (!dl || dl.name !== "BurnRequested" || argOf(dl, "burnNonce") !== BigInt(n)) continue;
    const amount = argOf(dl, "amount");
    const payee = argOf(dl, "v3Recipient");
    const burnId = argOf(dl, "burnId");
    if (typeof amount !== "bigint" || typeof payee !== "string" || typeof burnId !== "string") continue;
    return {
      dir: "back",
      dest: key,
      n,
      amount,
      payee: payee as Hex,
      burnId: burnId as Hex,
      tx: log.transactionHash.toLowerCase() as Hex,
      block: Number(BigInt(log.blockNumber)),
      at: stampOf(log),
      released: null,
      heads: null,
    };
  }
  return null;
}

/** A burn, and what came of it. Its chain's heads are read again until it is released. */
async function readBurn(key: DestKey, n: number, last: ChainBurn | null): Promise<ChainBurn | OlderBurn | null> {
  const x = last ?? (await burnLog(key, n));
  if (!x || "older" in x) return x;
  const [released, at, heads] = await Promise.allSettled([
    x.released === true ? true : ethCall(V3_EVM, VAULT, encodeCall("released(bytes32)", [x.burnId])).then((a) => boolOf(a.result)),
    x.at ?? timeOn(destOf(key), x.block),
    x.released === true ? x.heads : headsOn(key),
  ]);
  return { ...x, released: got(released) ?? x.released, at: got(at) ?? x.at, heads: got(heads) ?? x.heads };
}

// What the sends read the same way: a lock by its nonce (Finish mint), a lock's mint (one that
// someone else sent), a burn by its chain and nonce, a destination's logs and heads, a block's time
// on V3 or on a destination.
export { burnLog as findBurn, headsOn, lockLog as findLock, logsOn, mintOf as findMint, timeOn, v3Time as v3BlockTime };

/** What the chains said of each lock and burn, by id. Kept across pages: a visit back shows the last read while it reads again. */
export const chainReads = new Box<ReadonlyMap<string, ChainRead>>(new Map());
const inFlight = new Set<string>();
const READING: ChainRead = { state: "reading" };

function setRead(id: string, r: ChainRead): void {
  chainReads.set((m) => new Map(m).set(id, r));
}

/** Reads a lock or a burn from the chains, unless a read of it is under way or has just answered. A failed read keeps the last answer. */
export function readChain(id: string): void {
  const k = nonceOf(id);
  const prev = chainReads.get().get(id);
  if (!k || inFlight.has(id) || (prev?.state === "live" && Date.now() - prev.at < 5000)) return;
  inFlight.add(id);
  if (!prev) setRead(id, READING);
  const last = prev?.state === "live" ? prev.value : null;
  const read: Promise<ChainTransfer | OlderBurn | null> = k.dir === "in" ? readLock(k.n, last?.dir === "in" ? last : null) : readBurn(k.dest, k.n, last?.dir === "back" ? last : null);
  void read
    .then(
      (value) => setRead(id, !value ? { state: "none" } : "older" in value ? { state: "older", before: value.older } : { state: "live", value, at: Date.now() }),
      (e: unknown) => setRead(id, prev?.state === "live" ? { ...prev, error: message(e) } : { state: "error", error: message(e) }),
    )
    .finally(() => inFlight.delete(id));
}

/**
 * A lock or a burn read from the chains, for a page: read on arrival, then every 15 s while the tab
 * shows it and `settled` says another read could still change the page.
 */
export function useChainRead(id: string, settled: (x: ChainTransfer) => boolean): ChainRead {
  const read = useBox(chainReads).get(id) ?? READING;
  const again = read.state === "reading" || read.state === "error" || (read.state === "live" && !settled(read.value));
  useEffect(() => readChain(id), [id]);
  useEffect(() => {
    if (!again) return;
    const t = setInterval(() => {
      if (!document.hidden) readChain(id);
    }, CHAIN_EVERY);
    return () => clearInterval(t);
  }, [id, again]);
  return read;
}
