// This browser's journal of the transfers it started: what to look for on the chains when the page
// loads again. It lives in localStorage where the browser allows it, and the chains stay the truth:
// a journal that is lost, cleared or edited costs the page its memory of a transfer, never funds,
// since every entry is read again from the chains before the page shows it as more than a start.
// Kept apart from the build's records so that node --test runs it.

import type { Hex } from "../lib/hex.ts";
import { DESTS, type DestKey } from "./dests.ts";
import type { BurnTransfer, CheckKey, CheckState, ExtrinsicRef, Failure, LiveTransfer, LockSender, LockTransfer, MintRoute, SentTx } from "./model.ts";

export const JOURNAL_KEY = "bz-app.transfers";
/** About this many transfers are kept: past it, the oldest finished ones go first (encodeJournal). */
export const JOURNAL_MAX = 40;

/**
 * 3: each transfer names its destination (dest: Sepolia, Base Sepolia or Arbitrum Sepolia), the
 * chain its lock names and its mint is sent on, or its burn is sent on; a lock found minted by a
 * transaction older than the destination's nodes search says when (mintBeyond). 2: a lock names its sender
 * (an Ethereum wallet's address, or a Substrate account and its wallet), its extrinsic when it is a
 * Substrate one, who sent its mint, and whether auto-mint had a mint pending. Version 1's entries
 * are read as Ethereum locks, and an entry of any version without a destination as Sepolia's, the
 * only one the page sent to before. A page of an earlier version drops a journal of a later one: its
 * memory of those transfers, never funds; it never takes a rollup's transfer for Sepolia's.
 */
const VERSION = 3;
const READS = [1, 2, 3];

/** Minted, or released. */
const finished = (t: LiveTransfer): boolean => t.doneAt !== null || (t.dir === "in" ? t.mint?.stage === "mined" || t.mintBeyond !== undefined : t.release.released);

/**
 * A lock from a Polkadot wallet that is, or may be, on V3 and is not minted: locked (its nonce read),
 * or broadcast and not settled (followed, or the page stopped following it). The journal is the only
 * place the app finds it again: V3's EVM RPC serves no log of a Substrate extrinsic, so Activity,
 * Finish mint and auto-mint cannot see it on the chain.
 */
const onlyHere = (t: LiveTransfer): boolean =>
  t.dir === "in" && t.sender.kind === "substrate" && !finished(t) && (t.nonce !== null || (t.lock.stage === "sent" && (t.failure === null || t.failure.reason === "stopped")));

/**
 * The transfers the journal keeps: all of them up to JOURNAL_MAX; past it, the oldest finished ones
 * go first, then the oldest others, but never one onlyHere, which stays whatever the count.
 */
export function keptOf(list: readonly LiveTransfer[]): LiveTransfer[] {
  const byStart = [...list].sort((a, b) => a.startedAt - b.startedAt);
  const over = byStart.length - JOURNAL_MAX;
  if (over <= 0) return byStart;
  const drop = new Set<LiveTransfer>();
  for (const t of byStart) if (drop.size < over && finished(t)) drop.add(t);
  for (const t of byStart) if (drop.size < over && !drop.has(t) && !onlyHere(t)) drop.add(t);
  return byStart.filter((t) => !drop.has(t));
}

/** The journal's text: every transfer kept (keptOf) as JSON, its amount as a decimal string; the notes, which say what the page is doing now, left out. */
export function encodeJournal(list: readonly LiveTransfer[]): string {
  return JSON.stringify({ v: VERSION, transfers: keptOf(list).map((t) => ({ ...t, amount: t.amount.toString(), note: null })) });
}

/**
 * The journal a tab writes: the transfers it follows (`follows`) as it has them, and every other
 * entry as the journal holds it now, as the tab that follows it wrote it last. So a tab never writes
 * its own, older copy of another tab's transfer over that tab's.
 */
export function mergeJournal(stored: readonly LiveTransfer[], mine: readonly LiveTransfer[], follows: (id: string) => boolean): LiveTransfer[] {
  const kept = mine.filter((t) => follows(t.id));
  const ids = new Set(kept.map((t) => t.id));
  return [...stored.filter((t) => !ids.has(t.id)), ...kept];
}

/** The transfers a journal's text holds. An entry that does not read as one is dropped, and so is a journal of another version. */
export function decodeJournal(text: string | null): LiveTransfer[] {
  if (!text) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isObj(raw) || !READS.includes(raw.v as number) || !Array.isArray(raw.transfers)) return [];
  const out: LiveTransfer[] = [];
  for (const x of raw.transfers) {
    const t = transferOf(x);
    if (t && !out.some((o) => o.id === t.id)) out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Reading an entry back, field by field

type Obj = Record<string, unknown>;

const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const int = (x: unknown): number | null => (typeof x === "number" && Number.isSafeInteger(x) && x >= 0 ? x : null);
const time = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : null);
const str = (x: unknown): string | null => (typeof x === "string" ? x : null);
const hexOf = (x: unknown, bytes: number): Hex | null => (typeof x === "string" && new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(x) ? (x.toLowerCase() as Hex) : null);
const hash = (x: unknown): Hex | null => hexOf(x, 32);
const orNull = <T>(x: unknown, read: (y: unknown) => T | null): T | null | undefined => (x === null ? null : (read(x) ?? undefined));

const ID = /^(in|back)-[0-9a-z]{1,16}-[0-9a-z]{1,16}$/;
const DEST_KEYS: readonly DestKey[] = DESTS.map((d) => d.key);
const CHECK_KEYS: readonly CheckKey[] = ["header", "sigs", "proof", "commit", "nonce"];
const CHECK_STATES: readonly CheckState[] = ["waiting", "checking", "passed", "failed"];
const REASONS: readonly Failure["reason"][] = ["rejected", "refused", "reverted", "proof", "blocked", "stopped"];
const PATHS: readonly MintRoute["path"][] = ["mint", "head", "change", "selfRelay"];

function sentOf(x: unknown): SentTx | null {
  if (!isObj(x)) return null;
  if (x.stage === "asking") return { stage: "asking" };
  const h = hash(x.hash);
  const sentAt = time(x.sentAt);
  if (!h || sentAt === null) return null;
  if (x.stage === "sent") {
    if (x.by === undefined) return { stage: "sent", hash: h, sentAt };
    const from = isObj(x.by) ? hexOf(x.by.from, 20) : null;
    const nonce = isObj(x.by) ? int(x.by.nonce) : null;
    return from && nonce !== null ? { stage: "sent", hash: h, sentAt, by: { from, nonce } } : null;
  }
  const block = int(x.block);
  const minedAt = time(x.minedAt);
  const gasUsed = x.gasUsed === null ? null : int(x.gasUsed);
  if (x.stage !== "mined" || block === null || minedAt === null || (gasUsed === null && x.gasUsed !== null)) return null;
  return { stage: "mined", hash: h, sentAt, block, minedAt, gasUsed };
}

function failureOf(x: unknown): Failure | null {
  if (!isObj(x)) return null;
  const reason = REASONS.find((r) => r === x.reason);
  const at = time(x.at);
  if (!reason || at === null) return null;
  return { reason, at, title: str(x.title), text: str(x.text) };
}

function routeOf(x: unknown): MintRoute | null {
  if (!isObj(x)) return null;
  const path = PATHS.find((p) => p === x.path);
  const imports = int(x.imports);
  const title = str(x.title);
  const step = int(x.step);
  const steps = int(x.steps);
  if (!path || imports === null || title === null || step === null || steps === null || step < 1 || step > steps) return null;
  return { path, imports, title, gas: int(x.gas), step, steps, total: int(x.total) };
}

/** The fields both ways share; null when one does not read. */
function commonOf(x: Obj) {
  const id = str(x.id);
  // Absent in an entry from before the page sent to the rollups: Sepolia's.
  const dest = x.dest === undefined ? "sepolia" : DEST_KEYS.find((k) => k === x.dest);
  const amount = typeof x.amount === "string" && /^[1-9]\d{0,40}$/.test(x.amount) ? BigInt(x.amount) : null;
  const recipient = hexOf(x.recipient, 20);
  const startedAt = time(x.startedAt);
  const doneAt = orNull(x.doneAt, time);
  const failure = orNull(x.failure, failureOf);
  // Absent in an entry from before the page kept it.
  const fromBlock = x.fromBlock === undefined ? undefined : int(x.fromBlock);
  if (!id || !ID.test(id) || !dest || amount === null || !recipient || startedAt === null || doneAt === undefined || failure === undefined || fromBlock === null) return null;
  return { id, dest, amount, recipient, startedAt, ...(fromBlock === undefined ? {} : { fromBlock }), doneAt, failure, note: null };
}

/** A lock's sender; a version-1 entry (no sender) is an Ethereum wallet's lock, its recipient the sender. */
function senderOf(x: unknown, recipient: Hex): LockSender | null {
  if (x === undefined) return { kind: "evm", address: recipient };
  if (!isObj(x)) return null;
  if (x.kind === "evm") {
    const address = hexOf(x.address, 20);
    return address ? { kind: "evm", address } : null;
  }
  const h160 = hexOf(x.h160, 20);
  const ss58 = str(x.ss58);
  const wallet = str(x.wallet);
  const walletName = str(x.walletName);
  if (x.kind !== "substrate" || !h160 || !ss58 || !/^[1-9A-HJ-NP-Za-km-z]{46,50}$/.test(ss58) || wallet === null || walletName === null) return null;
  return { kind: "substrate", ss58, h160, wallet, walletName };
}

function extOf(x: unknown): ExtrinsicRef | null {
  if (!isObj(x)) return null;
  const nonce = int(x.nonce);
  const from = int(x.from);
  const to = int(x.to);
  return nonce !== null && from !== null && to !== null && to >= from ? { nonce, from, to } : null;
}

function lockOf(x: Obj): LockTransfer | null {
  const c = commonOf(x);
  const lock = sentOf(x.lock);
  const nonce = orNull(x.nonce, int);
  const commitment = orNull(x.commitment, hash);
  const mint = orNull(x.mint, sentOf);
  const route = orNull(x.route, routeOf);
  if (!c || !c.id.startsWith("in-") || !lock || nonce === undefined || commitment === undefined || mint === undefined || route === undefined) return null;
  const sender = senderOf(x.sender, c.recipient);
  const ext = x.ext === undefined ? null : orNull(x.ext, extOf);
  const mintBy = x.mintBy === undefined ? null : orNull(x.mintBy, (y) => hexOf(y, 20));
  // Absent unless the lock was found minted by a transaction older than the nodes search.
  const mintBeyond = x.mintBeyond === undefined ? undefined : time(x.mintBeyond);
  if (!sender || ext === undefined || mintBy === undefined || mintBeyond === null) return null;
  // An Ethereum lock's recipient is its sender; a Substrate lock is signed as an extrinsic.
  if (sender.kind === "evm" && (sender.address !== c.recipient || ext !== null)) return null;
  let finality: LockTransfer["finality"] = null;
  if (x.finality !== null) {
    const f = x.finality;
    if (!isObj(f)) return null;
    const block = int(f.block);
    const h = hash(f.hash);
    const at = time(f.at);
    if (block === null || !h || at === null) return null;
    finality = { block, hash: h, setId: int(f.setId), signatures: int(f.signatures), authorities: int(f.authorities), at };
  }
  const p = x.proof;
  if (!isObj(p) || !isObj(p.checks)) return null;
  const raw = p.checks;
  const checks = {} as Record<CheckKey, CheckState>;
  for (const k of CHECK_KEYS) {
    const s = CHECK_STATES.find((v) => v === raw[k]);
    if (!s) return null;
    checks[k] = s;
  }
  const builtAt = orNull(p.builtAt, time);
  if (builtAt === undefined) return null;
  const relayed: LockTransfer["relayed"] = [];
  if (!Array.isArray(x.relayed)) return null;
  for (const r of x.relayed) {
    const h = isObj(r) ? hash(r.hash) : null;
    const block = isObj(r) ? int(r.block) : null;
    if (!h || block === null) return null;
    relayed.push({ hash: h, block });
  }
  return {
    ...c,
    dir: "in",
    sender,
    ext,
    lock,
    nonce,
    commitment,
    finality,
    proof: { checks, builtAt },
    route,
    relayed,
    mint,
    ...(mintBeyond === undefined ? {} : { mintBeyond }),
    mintBy,
    autoPending: x.autoPending === true,
    resumed: x.resumed === true,
  };
}

function burnOf(x: Obj): BurnTransfer | null {
  const c = commonOf(x);
  const burn = sentOf(x.burn);
  const burnNonce = orNull(x.burnNonce, int);
  const burnId = orNull(x.burnId, hash);
  const speed = x.speed === "fast" || x.speed === "std" ? x.speed : null;
  if (!c || !c.id.startsWith("back-") || !burn || burnNonce === undefined || burnId === undefined || !speed) return null;
  const d = x.depth;
  const r = x.release;
  if (!isObj(d) || !isObj(r)) return null;
  const confirmations = int(d.confirmations);
  const qualifiedAt = orNull(d.qualifiedAt, time);
  const approvals = int(r.approvals);
  const at = orNull(r.at, time);
  const extrinsicAt = (y: unknown): { extrinsic: Hex; block: number } | null => {
    if (!isObj(y)) return null;
    const e = hash(y.extrinsic);
    const block = int(y.block);
    return e && block !== null ? { extrinsic: e, block } : null;
  };
  const open = orNull(r.open, extrinsicAt);
  const run = orNull(r.run, extrinsicAt);
  if (confirmations === null || qualifiedAt === undefined || approvals === null || at === undefined || open === undefined || run === undefined) return null;
  return {
    ...c,
    dir: "back",
    speed,
    fallback: x.fallback === true,
    burn,
    burnNonce,
    burnId,
    depth: { confirmations, final: d.final === true, qualifiedAt },
    release: { approvals: Math.min(2, approvals), open, run, at, released: r.released === true },
  };
}

function transferOf(x: unknown): LiveTransfer | null {
  if (!isObj(x)) return null;
  if (x.dir === "in") return lockOf(x);
  if (x.dir === "back") return burnOf(x);
  return null;
}
