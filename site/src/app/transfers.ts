// The transfers the app shows. Live ones, which this browser sends and follows: a lock on V3 and its
// mint on Sepolia (the way in), or a burn on Sepolia and the committee's release on V3 (the way
// back). The code that sends (sends.ts) fills them in as the wallet and the chains answer, and keeps
// them in this browser's journal (journal.ts); the transfer screen and the receipt only read them.
// The recorded runs, from the build's records: the receipts show them and the replays play them.
// And any other lock or burn, read from the chains by its nonce: Activity lists a connected
// wallet's, and links each to its transfer or its receipt.

import { useEffect } from "preact/hooks";
import { decode, encodeCall, type AbiValue, type DecodedLog } from "../lib/abi.ts";
import {
  DECIMALS,
  LC,
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
} from "../lib/chains.ts";
import { formatUnits } from "../lib/format.ts";
import { eventTopic } from "../lib/hashes.ts";
import { registry } from "../lib/live.ts";
import type { BurnRecord, Hex, RunStep } from "../lib/records-types.ts";
import { request, SubstrateClient, type Endpoint } from "../lib/rpc.ts";
import { decodeTimestampInherent } from "../lib/scale.ts";
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

export const isDone = (t: LiveTransfer): boolean => (t.dir === "in" ? t.mint?.stage === "mined" : t.release.released);

/** What the transfer screen's buttons ask for. sends.ts sets them when the app starts. */
export type TransferAction = "retry" | "sign" | "speedUp";
export const transferActions: Partial<Record<TransferAction, (id: string) => void>> = {};

/** lock-<nonce> or burn-<burn nonce>: the id a lock or a burn goes by in Activity, in the records and on the chains. */
export function nonceOf(id: string): { dir: Dir; n: number } | null {
  const m = /^(lock|burn)-(0|[1-9]\d{0,8})$/.exec(id);
  return m ? { dir: m[1] === "lock" ? "in" : "back", n: Number(m[2]) } : null;
}

/** The lock's or the burn's nonce a live transfer goes by on the chains, once its receipt gave it. */
export const chainIdOf = (t: LiveTransfer): string | null =>
  t.dir === "in" ? (t.nonce === null ? null : `lock-${t.nonce}`) : t.burnNonce === null ? null : `burn-${t.burnNonce}`;

/** The live transfer that follows lock-<n> or burn-<n>, if this browser follows it. */
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
 * How the auto-release watcher releases a burn, by its rule (README, the watcher and fast mode): up
 * to 1 tPOT after 3 confirmations, a larger burn after Sepolia's finality. Whether it did, or fell
 * back to finality because its fast budget was in use, is its record, not the chain's.
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

function fromBurn(b: BurnRecord): BurnRun | null {
  if (!b.txHash || b.block === null || !b.burnId || b.burnNonce === null || !b.signedAt || b.ok !== true) return null;
  const rel = records.returnPath.releases.find((r) => r.burnId === b.burnId && r.status === "released");
  const open = rel?.approvals.find((a) => a.action === "open");
  const run = rel?.approvals.find((a) => a.action === "execute");
  const runBlock = rel?.releasedAt?.number ?? run?.block ?? null;
  if (!rel || !run || runBlock === null) return null;
  return {
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
const BURNS: BurnRun[] = records.returnPath.burns.map(fromBurn).filter((b): b is BurnRun => b !== null);

export const lockRun = (nonce: number): LockRun | null => LOCKS.find((r) => r.nonce === nonce) ?? null;
export const burnRun = (n: number): BurnRun | null => BURNS.find((b) => b.n === n) ?? null;

/** The measured run, which the way in's replay plays and which "usually" means on a transfer: lock 1, Oct 20, whichever mint is newest. */
export function timedRun(): LockRun {
  const r = lockRun(LOCK_1.nonce);
  return r?.steps ? r : LOCK_1;
}

/** The first recorded release of each speed, which the way back's replays play: burn 1 (fast) and burn 0 (standard). */
export const recordedBurn = (speed: Speed): BurnRun | null => BURNS.find((b) => b.fast === (speed === "fast")) ?? null;

export type Recorded = { dir: "in"; run: LockRun } | { dir: "back"; run: BurnRun };

/** A recorded run by its id: lock-<nonce> or burn-<burn nonce>. */
export function recordedOf(id: string): Recorded | null {
  const k = nonceOf(id);
  if (!k) return null;
  if (k.dir === "in") {
    const run = lockRun(k.n);
    return run ? { dir: "in", run } : null;
  }
  const run = burnRun(k.n);
  return run ? { dir: "back", run } : null;
}

// ---------------------------------------------------------------------------------------------
// Locks and burns read from the chains: any that this tab does not follow and the records lack

/** A lock by its nonce: the vault's Locked log on V3, and what came of it. */
export interface ChainLock {
  dir: "in";
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
  /** used(nonce) on BridgeMinter; null when it could not be read. */
  minted: boolean | null;
  /** The mint, once minted and found. */
  mint: ChainMint | null;
}

/** BridgeMinter's Minted log for a lock, and its transaction's receipt. */
export interface ChainMint {
  tx: Hex;
  block: number;
  /** null when the receipt could not be read. */
  gasUsed: number | null;
  /** The V3 block its proofs were read at: Minted's block hash, and the light client's HeaderImported for it in the same transaction. */
  final: { hash: Hex; block: number | null; setId: number | null; signatures: number | null };
}

/** A burn by its burn nonce: BridgeMinter's BurnRequested log on Sepolia, and what came of it. */
export interface ChainBurn {
  dir: "back";
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
  /** Sepolia's latest and finalized blocks at the last read; null when they could not be read. */
  heads: { latest: number; finalized: number } | null;
}

export type ChainTransfer = ChainLock | ChainBurn;

export type ChainRead =
  | { state: "reading" }
  /** No lock or burn of this bridge goes by that nonce. */
  | { state: "none" }
  | { state: "error"; error: string }
  /** `error`: the last refresh failed, and this is the read before it. */
  | { state: "live"; value: ChainTransfer; at: number; error?: string };

interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  /** Some nodes add the block's timestamp to each log (hex seconds). */
  blockTimestamp?: string;
}

// The events as contracts/src declares them.
const LOCKED = eventTopic("Locked(uint256,address,address,uint256,address,uint256,bytes32)");
const MINTED = eventTopic("Minted(uint256,address,uint256,bytes32)");
const BURN_REQUESTED = eventTopic("BurnRequested(uint256,address,address,uint256,bytes32)");

/** Where the vault's logs start: its deployment block on V3. */
const VAULT_FROM = records.bridge.vault.deployBlock.number;
/**
 * Where BridgeMinter's Minted and BurnRequested logs start: lock 0's mint, the first of either
 * (README row 24), or BridgeMinter's deployment block when the records lack it
 * (deployments/sepolia-bridge.json, "BridgeMinter deploy").
 */
const MINTER_FROM = records.bridge.mint.block ?? 11_950_851;
/** Blocks per eth_getLogs window when no endpoint takes the whole range: drpc's cap, as the relayer reads. */
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
const stampOf = (log: RawLog): number | null => (log.blockTimestamp ? Number(BigInt(log.blockTimestamp)) * 1000 : null);
const got = <T>(r: PromiseSettledResult<T>): T | null => (r.status === "fulfilled" ? r.value : null);
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const same = (a: AbiValue | undefined, b: string): boolean => typeof a === "string" && a.toLowerCase() === b.toLowerCase();

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

async function sepoliaTime(block: number): Promise<number> {
  const a = await request<{ timestamp?: string } | null>(SEPOLIA_HISTORY, "eth_getBlockByNumber", [qty(block), false], { accept: (r) => r !== null, timeoutMs: 10000 });
  const t = a.result?.timestamp;
  if (!t) throw new Error(`no time for Sepolia block #${block}`);
  return Number(BigInt(t)) * 1000;
}

/** Sepolia's latest block and its finalized block. */
async function sepoliaHeads(): Promise<{ latest: number; finalized: number }> {
  const [latest, fin] = await Promise.all([
    request<Hex>(SEPOLIA, "eth_blockNumber", []),
    request<{ number?: string } | null>(SEPOLIA, "eth_getBlockByNumber", ["finalized", false], { accept: (r) => r !== null }),
  ]);
  const f = fin.result?.number;
  if (!f) throw new Error("Sepolia gave no finalized block");
  return { latest: Number(BigInt(latest.result)), finalized: Number(BigInt(f)) };
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

/** The vault's Locked log for this nonce, when it is this bridge's lock. */
async function lockLog(nonce: number): Promise<ChainLock | null> {
  const a = await request<RawLog[]>(V3_EVM, "eth_getLogs", [{ address: VAULT, topics: [LOCKED, topicOf(nonce)], fromBlock: qty(VAULT_FROM), toBlock: "latest" }], {
    timeoutMs: 15000,
  });
  for (const log of Array.isArray(a.result) ? a.result : []) {
    const d = registry.decodeLog(log);
    if (!d || d.name !== "Locked" || argOf(d, "nonce") !== BigInt(nonce)) continue;
    // Only this bridge's: a lock for another chain or minter is not BridgeMinter's to mint.
    if (argOf(d, "dstChainId") !== SEPOLIA_CHAIN_ID || !same(argOf(d, "dstMinter"), MINTER)) continue;
    const amount = argOf(d, "amountNative");
    const recipient = argOf(d, "recipient");
    const commitment = argOf(d, "commitment");
    if (typeof amount !== "bigint" || typeof recipient !== "string" || typeof commitment !== "string") continue;
    return {
      dir: "in",
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
    };
  }
  return null;
}

/** The lock's mint: BridgeMinter's Minted log for its nonce, then the transaction's receipt. */
async function mintOf(nonce: number): Promise<ChainMint | null> {
  const logs = await sepoliaLogs({ address: MINTER, topics: [MINTED, topicOf(nonce)] }, MINTER_FROM);
  for (const log of logs) {
    const d = registry.decodeLog(log);
    const hash = d?.name === "Minted" && argOf(d, "nonce") === BigInt(nonce) ? argOf(d, "blockHash") : undefined;
    if (typeof hash !== "string") continue;
    const tx = log.transactionHash.toLowerCase() as Hex;
    const mint: ChainMint = { tx, block: Number(BigInt(log.blockNumber)), gasUsed: null, final: { hash: hash as Hex, block: null, setId: null, signatures: null } };
    try {
      const r = await request<{ gasUsed: string; logs: RawLog[] } | null>(SEPOLIA_HISTORY, "eth_getTransactionReceipt", [tx], { accept: (x) => x !== null, timeoutMs: 10000 });
      if (r.result) {
        mint.gasUsed = Number(BigInt(r.result.gasUsed));
        // importAndMint imports the block through the light client first, in the same transaction.
        for (const l of r.result.logs) {
          const h = same(l.address, LC.v3.address) ? registry.decodeLog(l) : null;
          if (h?.name !== "HeaderImported" || !same(argOf(h, "blockHash"), hash)) continue;
          const n = argOf(h, "number");
          const set = argOf(h, "setId");
          const sigs = argOf(h, "signatures");
          if (typeof n === "bigint" && typeof set === "bigint" && typeof sigs === "bigint") mint.final = { hash: hash as Hex, block: Number(n), setId: Number(set), signatures: Number(sigs) };
        }
      }
    } catch {
      // The mint stands without its receipt: its gas and its V3 block show as not read.
    }
    return mint;
  }
  return null;
}

/** A lock, and what came of it. Once read, its log is not read again; what has settled is not read again either. */
async function readLock(nonce: number, last: ChainLock | null): Promise<ChainLock | null> {
  const x = last ?? (await lockLog(nonce));
  if (!x) return null;
  const [used, final, at] = await Promise.allSettled([
    x.minted === true ? true : ethCall(SEPOLIA, MINTER, encodeCall("used(uint256)", [BigInt(nonce)])).then((a) => boolOf(a.result)),
    x.final === true ? true : v3Finalized().then((head) => head >= x.block),
    x.at ?? v3Time(x.block),
  ]);
  const minted = got(used) ?? x.minted;
  const mint = minted !== true ? null : x.mint && x.mint.gasUsed !== null ? x.mint : ((await mintOf(nonce).catch(() => null)) ?? x.mint);
  return { ...x, minted, final: got(final) ?? x.final, at: got(at) ?? x.at, mint };
}

/** BridgeMinter's BurnRequested log for this burn nonce. */
async function burnLog(n: number): Promise<ChainBurn | null> {
  const logs = await sepoliaLogs({ address: MINTER, topics: [BURN_REQUESTED, topicOf(n)] }, MINTER_FROM);
  for (const log of logs) {
    const d = registry.decodeLog(log);
    if (!d || d.name !== "BurnRequested" || argOf(d, "burnNonce") !== BigInt(n)) continue;
    const amount = argOf(d, "amount");
    const payee = argOf(d, "v3Recipient");
    const burnId = argOf(d, "burnId");
    if (typeof amount !== "bigint" || typeof payee !== "string" || typeof burnId !== "string") continue;
    return {
      dir: "back",
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

/** A burn, and what came of it. Sepolia's heads are read again until it is released. */
async function readBurn(n: number, last: ChainBurn | null): Promise<ChainBurn | null> {
  const x = last ?? (await burnLog(n));
  if (!x) return null;
  const [released, at, heads] = await Promise.allSettled([
    x.released === true ? true : ethCall(V3_EVM, VAULT, encodeCall("released(bytes32)", [x.burnId])).then((a) => boolOf(a.result)),
    x.at ?? sepoliaTime(x.block),
    x.released === true ? x.heads : sepoliaHeads(),
  ]);
  return { ...x, released: got(released) ?? x.released, at: got(at) ?? x.at, heads: got(heads) ?? x.heads };
}

// What the sends read the same way: a lock by its nonce (Finish mint), a lock's mint (one that
// someone else sent), a burn by its nonce, a V3 block's time and Sepolia's heads.
export { burnLog as findBurn, lockLog as findLock, mintOf as findMint, sepoliaHeads, v3Time as v3BlockTime };

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
  const read: Promise<ChainTransfer | null> = k.dir === "in" ? readLock(k.n, last?.dir === "in" ? last : null) : readBurn(k.n, last?.dir === "back" ? last : null);
  void read
    .then(
      (value) => setRead(id, value ? { state: "live", value, at: Date.now() } : { state: "none" }),
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
