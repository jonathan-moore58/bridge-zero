// The fast mode and the auto-release watcher of the trusted return path, without the network:
// when a burn on Sepolia qualifies for its release (Sepolia's finality, or --confirmations n blocks
// on top of it up to --fast-cap), what the committee does next for it (open the operation, run it,
// nothing, or leave it to the members), one round of the watcher over the burns through ports
// release.ts fills with the chains, the lock that lets one watcher run per committee, and the wait
// between rounds. release.ts and watch.test.ts use it.

import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from "node:fs";

// ---------------------------------------------------------------------------------------
// The confirmation rule

/**
 * The most confirmations fast mode takes: Sepolia finalizes a block about two epochs (64 slots)
 * after it, so a deeper read is the finalized block's anyway.
 */
export const MAX_CONFIRMATIONS = 64;

/** The default --fast-cap: 1 tPOT, in native base units (wtPOT units). */
export const DEFAULT_FAST_CAP = 10n ** 14n;

/** The largest --fast-cap and --fast-budget taken without --fast-cap-override: 10 tPOT. */
export const FAST_LIMIT = 10n * DEFAULT_FAST_CAP;

/** The fewest confirmations the watcher takes with --send: reorgs of one or two blocks happen on Sepolia. */
export const MIN_WATCH_CONFIRMATIONS = 3;

/**
 * How a burn is read before its release: at Sepolia's finalized block (confirmations null, the
 * default), or, in fast mode, at the block `confirmations` below the latest, for a burn of at most
 * `fastCap`; a larger burn waits for finality. The watcher also keeps the burns it released fast
 * whose blocks are not final yet (with --send, and those not checked against Sepolia's final chain
 * yet) to `fastBudget` in all: what a reorg could undo at most.
 */
export interface Rule {
  confirmations: number | null;
  fastCap: bigint;
  fastBudget: bigint;
}

export const FINALITY: Rule = { confirmations: null, fastCap: DEFAULT_FAST_CAP, fastBudget: DEFAULT_FAST_CAP };

/** --confirmations: a whole number of blocks, 1 to MAX_CONFIRMATIONS. */
export function parseConfirmations(text: string): number {
  if (!/^\d+$/.test(text)) throw new Error(`a number of blocks is a whole number, got ${JSON.stringify(text)}`);
  const n = Number(text);
  if (n < 1 || n > MAX_CONFIRMATIONS) throw new Error(`from 1 to ${MAX_CONFIRMATIONS} blocks (Sepolia finalizes a block about 64 blocks after it), got ${text}`);
  return n;
}

/** The trade-off fast mode makes, printed every time it is on. */
export const tradeOff = (confirmations: number) =>
  `fast mode: the committee releases before Sepolia finalizes this burn; a reorg deeper than ${confirmations} block${confirmations === 1 ? "" : "s"} could undo the burn after the release`;

export interface Heads {
  /** Sepolia's latest block and its finalized block. */
  latest: number;
  finalized: number;
}

/**
 * The block a burn is read and checked at: the finalized block; in fast mode the block
 * `confirmations` below the latest, or the finalized block when that is higher (a finalized block
 * is never less safe).
 */
export function checkBlock(heads: Heads, rule: Rule): number {
  if (heads.latest < heads.finalized) throw new RangeError(`the latest block #${heads.latest} is below the finalized block #${heads.finalized}`);
  if (rule.confirmations === null) return heads.finalized;
  return Math.max(heads.latest - rule.confirmations, heads.finalized);
}

export type Qualification = { ok: true; by: "finality" | "fast"; why: string } | { ok: false; why: string };

/**
 * Whether a burn in block `block` of `amount` may be released now: when its block is final, or in
 * fast mode when it has at least `confirmations` blocks on top of it (its block is at most the
 * latest minus confirmations), its amount is at most the cap, and with the burns released fast
 * whose blocks are not final yet, or (with --send) not checked against Sepolia's final chain yet
 * (`exposed`, in all), it stays within the budget.
 */
export function qualification(burn: { block: number; amount: bigint }, heads: Heads, rule: Rule, exposed = 0n): Qualification {
  if (burn.block <= heads.finalized) return { ok: true, by: "finality", why: `its block #${burn.block} is final (finalized #${heads.finalized})` };
  if (rule.confirmations === null) return { ok: false, why: `its block #${burn.block} is not final yet (finalized #${heads.finalized}): the committee releases a burn once it is final` };
  if (burn.amount > rule.fastCap) return { ok: false, why: `its amount is above the fast cap (${burn.amount} > ${rule.fastCap} base units): it waits for finality (its block #${burn.block}, finalized #${heads.finalized})` };
  if (exposed + burn.amount > rule.fastBudget) {
    return {
      ok: false,
      why: `the burns released fast and not final, or not checked against Sepolia's final chain, yet hold ${exposed} base units; with its ${burn.amount} that is above the fast budget of ${rule.fastBudget}: it waits for finality (its block #${burn.block}, finalized #${heads.finalized})`,
    };
  }
  const depth = heads.latest - burn.block;
  if (depth >= rule.confirmations) return { ok: true, by: "fast", why: `${depth} blocks on top of its block #${burn.block}, at least ${rule.confirmations} (fast mode, up to the cap)` };
  return { ok: false, why: `${Math.max(depth, 0)} of ${rule.confirmations} blocks on top of its block #${burn.block} so far (fast mode)` };
}

/**
 * Whether a burn's receipt is in its log's block: for a final burn, the two block hashes agree when
 * the RPC gives both; for one not final yet (fast mode), both must be given and agree, as a
 * load-balanced RPC can serve the receipt and the log from two forks.
 */
export function receiptInLogBlock(final: boolean, receiptBlockHash: string | null | undefined, logBlockHash: string | null | undefined): boolean {
  const r = receiptBlockHash?.toLowerCase();
  const l = logBlockHash?.toLowerCase();
  if (final) return !r || !l || r === l;
  return !!r && !!l && r === l;
}

// ---------------------------------------------------------------------------------------
// What the committee does next for a burn

/** The open multisig operation of a burn's release on V3, its members as numbers (0 for an account that is no member). */
export interface OpenOperation {
  approvals: number[];
  depositor: number;
  /** Its call is this burn's release: the burn id, the payee and the amount. */
  matches: boolean;
}

/** An approval of a burn's release in deployments/v3-testnet.json. */
export interface RecordedApproval {
  member: number;
  action: "open" | "execute" | "cancel";
  status: "submitted" | "final" | "failed" | "dropped";
  /** It is in a block (a final one): the extrinsic ran, whatever its checks said. */
  onChain: boolean;
}

/** A release round of the burn in the record. */
export interface RecordedRound {
  status: "open" | "released" | "failed" | "cancelled";
  approvals: RecordedApproval[];
}

export interface BurnState {
  /** released[burnId] at V3's finalized head. */
  released: boolean;
  op: OpenOperation | null;
  rounds: RecordedRound[];
}

export type Next =
  | { kind: "done"; why: string }
  | { kind: "open"; member: number; why: string }
  | { kind: "execute"; member: number; why: string }
  /** Nothing now; a later round looks again. */
  | { kind: "wait"; why: string }
  /** Nothing the watcher does: the members look at it. */
  | { kind: "hold"; why: string };

/**
 * The committee's next step for a burn, from the chain (released[burnId], the open operation) and
 * the record, for the members whose keys the watcher holds (`keyed`, ascending). It never approves
 * twice: a member that approved the open operation, or that the record has approving it, does not
 * approve again; an approval the record holds as submitted is settled first; a round whose execution
 * ran on chain without releasing, a cancelled round, a failed approval that ran on chain, or an open
 * operation whose call is not this burn's release, is left to the members.
 */
export function nextStep(s: BurnState, keyed: number[], threshold: number): Next {
  if (s.released) return { kind: "done", why: "released[burnId] is true: the burn is released" };
  const approvals = s.rounds.flatMap((r) => r.approvals);
  if (approvals.some((a) => a.status === "submitted")) return { kind: "wait", why: "an approval an earlier run submitted is not settled yet" };
  if (approvals.some((a) => a.action === "execute" && a.onChain)) return { kind: "hold", why: "the record has an execution of its release on chain, and the burn is not released: the members look at it" };
  if (approvals.some((a) => a.status === "failed" && a.onChain)) return { kind: "hold", why: "an approval of its release ran on chain and failed its checks: the members look at it" };
  if (s.rounds.some((r) => r.status === "cancelled")) return { kind: "hold", why: "a member cancelled a release of this burn: the members decide what comes next" };
  if (s.op) {
    if (!s.op.matches) return { kind: "hold", why: `the open operation for this burn is not its release: its depositor, member ${s.op.depositor || "?"}, cancels it` };
    const open = s.rounds.filter((r) => r.status === "open");
    const recorded = open.flatMap((r) => r.approvals.filter((a) => a.status === "final" && a.action !== "cancel").map((a) => a.member));
    const approved = new Set([...s.op.approvals, ...recorded]);
    if (s.op.approvals.length + 1 < threshold) return { kind: "hold", why: `${s.op.approvals.length} of ${threshold} approvals: one more does not run it` };
    const member = keyed.find((k) => !approved.has(k));
    if (member === undefined) return { kind: "wait", why: `approved by member ${[...approved].join(", ")}; the watcher holds no other member's key` };
    return { kind: "execute", member, why: `opened by member ${s.op.depositor || "?"}, approved by member ${s.op.approvals.join(", ")}: member ${member} runs it` };
  }
  if (s.rounds.some((r) => r.status === "open" && r.approvals.some((a) => a.action === "open" && a.status === "final"))) {
    return { kind: "hold", why: "the record has its operation open, and multisig.multisigs does not: the members look at it" };
  }
  if (keyed.length === 0) return { kind: "wait", why: "the watcher holds no member's key" };
  return { kind: "open", member: keyed[0], why: `nothing is open: member ${keyed[0]} opens it` };
}

/**
 * What an error at submission says about an extrinsic: "rejected" when the node refused it and it
 * was never broadcast (1010 invalid, 1011 unknown validity, 1012 temporarily banned, 1015 to 1019),
 * "pending" when it may still be included (1013: the pool has it already; 1014: another with its
 * nonce is in the pool), "error" for anything else. A status the node reports once the extrinsic
 * was accepted (Invalid, Dropped, Usurped) is no proof either: another node may include it, and
 * the next run settles it by its nonce.
 */
export function submitErrorVerdict(text: string): "rejected" | "pending" | "error" {
  const m = /^(\d{4}):/.exec(text);
  if (!m) return "error";
  const code = Number(m[1]);
  if (code === 1013 || code === 1014) return "pending";
  if (code >= 1010 && code <= 1019) return "rejected";
  return "error";
}

// ---------------------------------------------------------------------------------------
// After finality: a release made in fast mode, checked against its burn on the final chain

/** A burn's facts, as the record has them for a release and as its log has them at the finalized block (hex in any case). */
export interface BurnFacts {
  txHash: string;
  /** Null when the record has no block hash for it. */
  blockHash: string | null;
  block: number;
  payee: string;
  amount: bigint;
  burnId: string;
}

/**
 * Whether a release made in fast mode stands once its burn's block is final: BurnRequested(n) on the
 * final chain is the same transaction, burn id, payee and amount as the burn the release paid for.
 * The same transaction in another block (a reorg moved it) still stands, with a note.
 */
export function reconcileVerdict(recorded: BurnFacts, final: BurnFacts | null): { ok: boolean; why: string } {
  if (!final) return { ok: false, why: "the final chain has no BurnRequested log of this burn nonce" };
  const lower = (x: string) => x.toLowerCase();
  const differs: string[] = [];
  if (lower(final.txHash) !== lower(recorded.txHash)) differs.push(`transaction ${final.txHash}, not ${recorded.txHash}`);
  if (lower(final.burnId) !== lower(recorded.burnId)) differs.push(`burn id ${final.burnId}, not ${recorded.burnId}`);
  if (lower(final.payee) !== lower(recorded.payee)) differs.push(`payee ${final.payee}, not ${recorded.payee}`);
  if (final.amount !== recorded.amount) differs.push(`amount ${final.amount}, not ${recorded.amount}`);
  if (differs.length > 0) return { ok: false, why: `the final chain's burn has ${differs.join("; ")}` };
  const moved = final.block !== recorded.block || (recorded.blockHash !== null && final.blockHash !== null && lower(final.blockHash) !== lower(recorded.blockHash));
  return {
    ok: true,
    why: moved ? `the same burn, moved by a reorg from #${recorded.block} to #${final.block} (final)` : `the same burn in final block #${final.block}`,
  };
}

/**
 * How many rounds in a row a fast release's burn may be found nowhere (no log of it on the final
 * chain, and its transaction without a receipt or reverted) before that is a fatal stop: an RPC that
 * lags, or answers eth_getLogs with nothing, does not halt the watcher at once.
 */
export const RECONCILE_MISSES = 3;

/** A fast release's burn transaction as its receipt has it, read when the final chain's logs did not show the burn. */
export interface BurnReceipt {
  /** 1: it ran; 0: it reverted. */
  status: number;
  block: number;
  /** Its block is the canonical one of its number (eth_getBlockByNumber); null when that was not read. */
  canonical: boolean | null;
  /** The minter's BurnRequested log of this burn nonce in it, if any. */
  log: BurnFacts | null;
}

export type MissingBurnVerdict =
  /** Nothing is known yet: a later round looks again. `missed`: this round counts toward RECONCILE_MISSES. */
  | { kind: "later"; why: string; missed: boolean }
  /** Its transaction is in a final canonical block: check the release against what it burned there (reconcileVerdict). */
  | { kind: "check"; final: BurnFacts | null }
  /** Found nowhere RECONCILE_MISSES rounds in a row: the release does not stand. */
  | { kind: "fatal"; why: string };

/**
 * What to make of a fast release whose burn the final chain's logs did not show (eth_getLogs gave
 * nothing, or `logsRefused`), from its transaction's receipt (null: none) and the rounds in a row it
 * was missed before (`misses`). In a final canonical block, the receipt's BurnRequested log of this
 * nonce is the final chain's (a burn nonce is the minter's, once): check against it. Above the
 * finalized block (a reorg moved it), or in a block that is not the canonical one yet: later. No
 * receipt, or a reverted transaction: later, until RECONCILE_MISSES rounds in a row, then fatal; with
 * the logs refused nothing counts, since the final chain was not read.
 */
export function missingBurnVerdict(receipt: BurnReceipt | null, finalized: number, misses: number, logsRefused: boolean): MissingBurnVerdict {
  if (receipt === null || receipt.status !== 1) {
    const what = receipt === null ? "its transaction has no receipt" : `its transaction reverted (status ${receipt.status}) in #${receipt.block}`;
    if (logsRefused) return { kind: "later", why: what, missed: false };
    const n = misses + 1;
    if (n >= RECONCILE_MISSES) return { kind: "fatal", why: `the final chain has no BurnRequested log of this burn nonce, and ${what}, ${n} rounds in a row` };
    return { kind: "later", why: `${what} (${n} of ${RECONCILE_MISSES} rounds in a row before a fatal stop)`, missed: true };
  }
  if (receipt.block > finalized) return { kind: "later", why: `its transaction is in #${receipt.block}, above the finalized #${finalized} (a reorg moved it)`, missed: false };
  if (receipt.canonical !== true) return { kind: "later", why: `its receipt's block #${receipt.block} is not the canonical one of its number yet (an RPC behind?)`, missed: false };
  return { kind: "check", final: receipt.log };
}

// ---------------------------------------------------------------------------------------
// One round

/** A burn as its BurnRequested log has it. */
export interface SeenBurn {
  burnNonce: bigint;
  amount: bigint;
  block: number;
  /** For the log lines: the payee, checksummed. */
  payee: string;
  /** For the log lines: the amount as the tool writes it. */
  amountText?: string;
  /** Its log could not be read this round (the RPC refuses the range, or does not serve it yet): it waits, and the round goes on. */
  missing?: string;
}

/** What a run of the release tool for one burn ended with. */
export type Outcome =
  /** Every check passed: for an approval with --send, it is final and checked. */
  | { kind: "ok" }
  /** Something is not final yet: the burn on Sepolia, or an extrinsic sent. */
  | { kind: "pending"; why: string }
  /** A check refused the release before anything was signed (the payee, the dry run, a balance, ...). */
  | { kind: "refused"; why: string }
  /** The node refused the extrinsic: it was never included, and a later round may send it again. */
  | { kind: "rejected"; why: string }
  /** An approval ran on chain and failed its checks: the watcher stops. */
  | { kind: "failed"; why: string; extrinsicHash?: string };

/** The approval a run of the release tool added to the record: its extrinsic, its status, and its block once it is in one. */
export interface SentApproval {
  extrinsicHash: string;
  status: string;
  block: { number: number } | null;
  note?: string;
}

/**
 * What a run of the release tool for one approval ended with, from how it ended (its exit code, or
 * the refusal it threw) and the approval it added to the record, if any. An approval still
 * submitted is pending whatever else happened (a refusal thrown after it was sent, or a block it is
 * not found in): nothing more is signed until the next round settles it. One in a block failed its
 * checks; one never included was rejected; with nothing sent, the run refused.
 */
export function approvalOutcome(end: { code: "ok" | "pending" | "failed" } | { refused: string }, sent: SentApproval | undefined, failedChecks: number): Outcome {
  if ("code" in end && end.code === "ok") return { kind: "ok" };
  if ("code" in end && end.code === "pending") return { kind: "pending", why: "an approval is not final yet" };
  const why = "refused" in end ? end.refused : `${failedChecks} check${failedChecks === 1 ? "" : "s"} failed`;
  if (sent?.status === "submitted") return { kind: "pending", why: `${sent.extrinsicHash} was submitted and its outcome is not known (${why}); the next round settles it` };
  if (sent?.block) return { kind: "failed", why: `${sent.extrinsicHash} in #${sent.block.number} failed its checks`, extrinsicHash: sent.extrinsicHash };
  if (sent) return { kind: "rejected", why: sent.note ?? "never included" };
  return { kind: "refused", why };
}

/** What settling the approvals an earlier run left submitted ended with. */
export type Settled =
  /** Nothing is on its way any more: each is final (and checked), failed or dropped. */
  | { kind: "ok" }
  /** One is still on its way, or final and not checked yet: nothing more is signed until it is settled. */
  | { kind: "pending"; why: string }
  /**
   * One ran on chain and failed its checks, as a sent approval can (the same fatal stop), or one
   * cannot be found though its sender's nonce is used: the watcher stops.
   */
  | { kind: "fatal"; why: string; burn: string | null; extrinsicHash: string | null; left?: boolean };

/** An approval the record held as submitted before a settling: its key in `after`, its burn nonce and its extrinsic. */
export interface Submitted {
  key: string;
  burn: string;
  extrinsicHash: string;
}

/**
 * The first of the approvals the record held as submitted (`before`) that the settling found on
 * chain and failing its checks (`after`, by key: its status now, and whether it is in a block):
 * the same fatal stop as an approval sent in this round that fails them. Null when there is none.
 */
export function settledOnChainFailure<S extends Submitted>(before: S[], after: Map<string, { status: string; onChain: boolean }>): S | null {
  return before.find((s) => {
    const now = after.get(s.key);
    return now !== undefined && now.status === "failed" && now.onChain;
  }) ?? null;
}

/** How a settling ended (settleOrHalt): its code, a fatal stop it found, or what it threw. */
export type SettleEnd<T> = { kind: "settled"; code: T } | { kind: "fatal"; stop: FatalStop } | { kind: "threw"; error: unknown };

/**
 * Runs a settling of what an earlier --send run left submitted (`settle`), then asks which approval
 * it found on chain and failing its checks (`failure`). When there is one, `leave` writes the
 * committee's halt file, whatever the command (the watcher, an approval by hand, fund) and with or
 * without --send: writing it signs nothing, and the record keeps that approval as failed from then
 * on, so the run that settled it is the only one that sees it fail. The run stops on it, even when
 * the settling then threw. Otherwise the settling's code, or what it threw.
 */
export async function settleOrHalt<T>(settle: () => Promise<T>, failure: () => FatalStop | null, leave: (f: FatalStop) => void): Promise<SettleEnd<T>> {
  let end: SettleEnd<T>;
  try {
    end = { kind: "settled", code: await settle() };
  } catch (error) {
    end = { kind: "threw", error };
  }
  const failed = failure();
  if (failed) {
    leave(failed);
    return { kind: "fatal", stop: { ...failed, left: true } };
  }
  return end;
}

/** What a round reads and does, through the tool: release.ts fills them with the chains, the tests with stand-ins. */
export interface Ports<B extends SeenBurn = SeenBurn> {
  /**
   * The committee's halt file, read again (with --send): why a fatal stop that another process left
   * since the watcher started (a dry run's or an approval by hand's settling, say) stops it. Null
   * when there is none. Read at the start of each round and before each approval.
   */
  halted(): string | null;
  /**
   * Settles every approval the record holds as submitted (an earlier run crashed, timed out, or lost
   * the node while it was on its way): found final and checked, or dropped. Runs first in each round;
   * fatal when one ran on chain and failed its checks (settledOnChainFailure).
   */
  settle(): Promise<Settled>;
  heads(): Promise<Heads>;
  /** Every BurnRequested since the last burn handled, at the latest block, in nonce order. */
  burns(): Promise<B[]>;
  /**
   * The releases the record has made in fast mode: each burn's amount and block, and whether its
   * check against Sepolia's final chain passed (finalizedCheck).
   */
  fastReleases(): Promise<{ amount: bigint; block: number; checked: boolean }[]>;
  /**
   * Checks each release made in fast mode whose burn's block is final now, and not checked yet,
   * against BurnRequested(n) on the final chain (reconcileVerdict), and records it; fatal on a
   * mismatch: the vault paid for a burn a reorg changed or undid.
   */
  reconcile(heads: Heads): Promise<{ checked: number; fatal: FatalStop | null }>;
  /** The burn's state on V3 at the finalized head, and in the record. */
  state(burn: B): Promise<BurnState>;
  /**
   * Every check of the release tool for the burn (read at the block the rule gives), then member
   * k's approval: signed, sent and checked with --send, a dry run without.
   */
  approve(burn: B, by: "finality" | "fast", step: { kind: "open" | "execute"; member: number }): Promise<Outcome>;
  log(line: string): void;
}

export interface RoundResult {
  /** Burns released (executed and checked) in this round. */
  released: number;
  /** Burns that do not qualify yet. */
  waiting: number;
  /** Burns a check refused in this round. */
  refused: number;
  /** Burns left to the members. */
  held: number;
  /** Approvals dry-run (without --send). */
  planned: number;
  /** Something sent is not final yet: the round stopped there, and the next round settles it first. */
  pending: boolean;
  /** An approval failed its checks on chain, or what ran cannot be known: the watcher stops, and leaves a halt file. */
  fatal: FatalStop | null;
  /** The halt file another process left (Ports.halted): the round signed nothing more, and the watcher stops without writing it again. */
  halted: string | null;
}

/** Why the watcher stops for good: the reason, and the burn and the extrinsic when there is one. */
export interface FatalStop {
  why: string;
  burn: string | null;
  extrinsicHash: string | null;
  /** The halt file is written already: the settling that found it left it (settleOrHalt). */
  left?: boolean;
}

/**
 * Where the watcher looks for burns: the first burn nonce not handled yet (every burn below it is
 * released, as the record has the releases) and the block to search its logs from, the block of
 * the last burn handled (the minter's deploy block when none is).
 */
export function cursorOf(handled: { burnNonce: bigint; block: number }[], deployBlock: number): { nextNonce: bigint; fromBlock: number } {
  let nextNonce = 0n;
  let fromBlock = deployBlock;
  for (;;) {
    const h = handled.find((x) => x.burnNonce === nextNonce);
    if (!h) return { nextNonce, fromBlock };
    fromBlock = Math.max(fromBlock, h.block);
    nextNonce += 1n;
  }
}

/** The most approvals one burn takes in a round: the opening and the execution. */
const STEPS = 2;

/**
 * One round of the watcher: nothing while the committee's halt file is there (read again before each
 * approval too); first the approvals an earlier run left submitted are settled (the round
 * ends there while one is on its way); then, for each burn since the last one handled, in order, nothing when it is
 * released; a wait while it does not qualify; else the committee's next step, run through the tool
 * (every check first), then the next one, until it is released, refused, or left to the members.
 * Without `send` each burn's next approval is dry-run, and nothing more.
 */
export async function watchRound<B extends SeenBurn>(p: Ports<B>, rule: Rule, o: { send: boolean; keyed: number[]; threshold: number }): Promise<RoundResult> {
  const r: RoundResult = { released: 0, waiting: 0, refused: 0, held: 0, planned: 0, pending: false, fatal: null, halted: null };
  r.halted = p.halted();
  if (r.halted) return r;
  const settled = await p.settle();
  if (settled.kind === "fatal") {
    r.fatal = { why: settled.why, burn: settled.burn, extrinsicHash: settled.extrinsicHash, ...(settled.left ? { left: true } : {}) };
    return r;
  }
  if (settled.kind === "pending") {
    p.log(`an approval an earlier run submitted is still on its way (${settled.why}): nothing is signed until it is final`);
    r.pending = true;
    return r;
  }
  const heads = await p.heads();
  p.log(`Sepolia: latest #${heads.latest}, finalized #${heads.finalized}`);
  const reconciled = await p.reconcile(heads);
  if (reconciled.checked > 0) p.log(`${reconciled.checked} release${reconciled.checked === 1 ? "" : "s"} made in fast mode checked against Sepolia's final blocks`);
  if (reconciled.fatal) {
    r.fatal = reconciled.fatal;
    return r;
  }
  const burns = await p.burns();
  p.log(`${burns.length} burn${burns.length === 1 ? "" : "s"} from the last one handled`);
  // What a reorg could still undo: the burns released fast whose blocks are not final yet, and with
  // --send those final whose check against the final chain has not passed yet (reconcile may defer
  // it). Without --send no check is recorded, and the block alone counts.
  let exposed = (await p.fastReleases()).filter((x) => x.block > heads.finalized || (o.send && !x.checked)).reduce((sum, x) => sum + x.amount, 0n);
  if (rule.confirmations !== null) p.log(`released fast and not final or not checked yet: ${exposed} of the fast budget's ${rule.fastBudget} base units`);
  for (const burn of burns) {
    if (burn.missing !== undefined) {
      p.log(`burn ${burn.burnNonce}: waits: ${burn.missing}`);
      r.waiting += 1;
      continue;
    }
    const name = `burn ${burn.burnNonce} (${burn.amountText ?? `${burn.amount} base units`} for ${burn.payee}, #${burn.block})`;
    let state = await p.state(burn);
    if (state.released) {
      p.log(`${name}: released already; nothing to do`);
      continue;
    }
    const q = qualification(burn, heads, rule, exposed);
    if (!q.ok) {
      p.log(`${name}: waits: ${q.why}`);
      r.waiting += 1;
      continue;
    }
    p.log(`${name}: qualifies: ${q.why}`);
    if (q.by === "fast") p.log(`     ${tradeOff(rule.confirmations!)}`);
    for (let i = 0; ; i++) {
      const next = nextStep(state, o.keyed, o.threshold);
      if (next.kind === "done") {
        if (i > 0) {
          r.released += 1;
          if (q.by === "fast") exposed += burn.amount;
        }
        p.log(`${name}: ${next.why}`);
        break;
      }
      if (next.kind === "wait" || next.kind === "hold") {
        p.log(`${name}: ${next.kind === "hold" ? "left to the members" : "waits"}: ${next.why}`);
        if (next.kind === "hold") r.held += 1;
        else r.waiting += 1;
        break;
      }
      if (i === STEPS) {
        r.fatal = { why: `${name}: still not released after ${STEPS} approvals in one round`, burn: String(burn.burnNonce), extrinsicHash: null };
        return r;
      }
      // A fatal stop another process left since the round started signs nothing more either.
      r.halted = p.halted();
      if (r.halted) return r;
      p.log(`${name}: ${next.why}${o.send ? "" : " (dry run)"}`);
      const out = await p.approve(burn, q.by, { kind: next.kind, member: next.member });
      if (out.kind === "refused") {
        p.log(`${name}: refused: ${out.why}`);
        r.refused += 1;
        break;
      }
      if (out.kind === "rejected") {
        p.log(`${name}: the node refused member ${next.member}'s approval (${out.why}); a later round tries again`);
        r.refused += 1;
        break;
      }
      if (out.kind === "pending") {
        p.log(`${name}: ${out.why}; the next round settles it first`);
        r.pending = true;
        return r;
      }
      if (out.kind === "failed") {
        r.fatal = { why: `${name}: member ${next.member}'s approval failed its checks: ${out.why}`, burn: String(burn.burnNonce), extrinsicHash: out.extrinsicHash ?? null };
        return r;
      }
      if (!o.send) {
        r.planned += 1;
        if (next.kind === "open") p.log(`${name}: then member ${o.keyed.find((k) => k !== next.member) ?? "<another>"} runs it (asMulti with the opening's timepoint)`);
        break;
      }
      state = await p.state(burn);
    }
  }
  return r;
}

// ---------------------------------------------------------------------------------------
// The burn cache: the logs of final burns the watcher found, so that it never searches for one again

/** A burn's BurnRequested log, as the cache keeps it (hex strings and decimal amounts). */
export interface CachedBurn {
  block: number;
  blockHash: string;
  txHash: string;
  from: string;
  payee: string;
  amount: string;
  burnId: string;
}

interface BurnCacheFile {
  minter: string;
  burns: Record<string, CachedBurn>;
}

const isHex = (x: unknown, bytes: number) => typeof x === "string" && new RegExp(`^0x[0-9a-fA-F]{${2 * bytes}}$`).test(x);

/** The cache at `path` for `minter`, by burn nonce; empty when there is none, it does not parse, or it is another minter's. Entries that are not whole are left out. */
export function readBurnCache(path: string, minter: string): Map<string, CachedBurn> {
  try {
    const f = JSON.parse(readFileSync(path, "utf8")) as BurnCacheFile;
    if (typeof f.minter !== "string" || f.minter.toLowerCase() !== minter.toLowerCase() || typeof f.burns !== "object" || f.burns === null) return new Map();
    return new Map(
      Object.entries(f.burns).filter(
        ([n, b]) =>
          /^\d+$/.test(n) &&
          Number.isSafeInteger(b?.block) &&
          isHex(b.blockHash, 32) &&
          isHex(b.txHash, 32) &&
          isHex(b.from, 20) &&
          isHex(b.payee, 20) &&
          isHex(b.burnId, 32) &&
          /^\d+$/.test(String(b.amount)),
      ),
    );
  } catch {
    return new Map();
  }
}

/** Writes the cache (through a temporary file, then a rename). */
export function writeBurnCache(path: string, minter: string, burns: Map<string, CachedBurn>): void {
  const file: BurnCacheFile = { minter, burns: Object.fromEntries([...burns].sort(([a], [b]) => (BigInt(a) < BigInt(b) ? -1 : 1))) };
  writeFileSync(`${path}.tmp`, `${JSON.stringify(file, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}

// ---------------------------------------------------------------------------------------
// The halt file: after a fatal stop, no watcher of the committee starts again until a member looks

/** What the halt file holds. */
export interface Halt {
  reason: string;
  burn: string | null;
  extrinsicHash: string | null;
  /** When the watcher stopped, ISO 8601. */
  at: string;
}

/** Writes the halt file (through a temporary file, then a rename). */
export function writeHalt(path: string, halt: Halt): void {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(halt, null, 2)}
`);
  renameSync(`${path}.tmp`, path);
}

/** The halt file at `path`, or null when there is none; one that does not parse still halts. */
export function readHalt(path: string): Halt | null {
  if (!existsSync(path)) return null;
  try {
    const h = JSON.parse(readFileSync(path, "utf8")) as Partial<Halt>;
    return { reason: String(h.reason ?? "no reason recorded"), burn: h.burn ?? null, extrinsicHash: h.extrinsicHash ?? null, at: String(h.at ?? "an unknown time") };
  } catch {
    return { reason: "the halt file does not parse", burn: null, extrinsicHash: null, at: "an unknown time" };
  }
}

/** Why a watcher refuses to start while the halt file is there. */
export const haltRefusal = (h: Halt, path: string) =>
  `a fatal stop at ${h.at}: ${h.reason}${h.burn === null ? "" : ` (burn ${h.burn}${h.extrinsicHash ? `, extrinsic ${h.extrinsicHash}` : ""})`}; look at it, then remove ${path}`;

// ---------------------------------------------------------------------------------------
// The wait between rounds

export const MIN_WATCH_SECONDS = 10;
export const MAX_WATCH_SECONDS = 86_400;
/** The longest wait after rounds in a row that an RPC failed. */
export const MAX_BACKOFF_SECONDS = 3_600;

/**
 * Whether a round's error is trouble with an RPC, after which the wait doubles: a node that did not
 * answer (Unreachable) or an RPC that answered a read with an error (RpcError for Sepolia,
 * EvmRpcError for V3's EVM RPC). Anything else (a check, a burn) is retried after --watch seconds,
 * as the next round would anyway.
 */
export const rpcTrouble = (error: unknown): boolean => error instanceof Error && (error.name === "Unreachable" || error.name === "RpcError" || error.name === "EvmRpcError");

/** The wait before the next round: --watch, doubled after each round in a row an RPC failed, up to an hour (or --watch when that is longer). */
export function nextWait(watch: number, previous: number, trouble: boolean): number {
  if (!trouble) return watch;
  return Math.min(Math.max(2 * Math.max(previous, watch), watch), Math.max(watch, MAX_BACKOFF_SECONDS));
}

// ---------------------------------------------------------------------------------------
// The member keys

/** --member-keys k:<path>,j:<path>: two members of 1, 2 and 3, each with its key file, in ascending order. */
export function parseMemberKeys(text: string): { member: number; path: string }[] {
  const out: { member: number; path: string }[] = [];
  for (const part of text.split(",")) {
    const m = /^([123]):(.+)$/.exec(part.trim());
    if (!m) throw new Error(`each entry is <member>:<key file>, a member being 1, 2 or 3; got ${JSON.stringify(part.trim().replace(/:.*/, ":..."))}`);
    const member = Number(m[1]);
    if (out.some((x) => x.member === member)) throw new Error(`member ${member} is named twice`);
    out.push({ member, path: m[2] });
  }
  if (out.length !== 2) throw new Error(`two members run a release, got ${out.length}`);
  if (out[0].path === out[1].path) throw new Error("the two members have the same key file");
  return out.sort((a, b) => a.member - b.member);
}

// ---------------------------------------------------------------------------------------
// The lock: one watcher with --send per committee

/** How often the lock's holder refreshes it, and how long a lock whose process runs may go unrefreshed before it counts as stale. */
export const LOCK_REFRESH = 30_000;
export const LOCK_STALE = 10 * 60_000;
/** How old a <lock>.takeover file is when it counts as left by a process that died while taking a stale lock over: a takeover lasts milliseconds. */
export const TAKEOVER_STALE = 60_000;

export interface Lock {
  path: string;
  /** True while the lock still holds this watcher's token; it then refreshes the lock's time too. */
  held(): boolean;
  /** Stops refreshing and removes the lock if it is still this watcher's; never throws. */
  release(): void;
}

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const busy = (error: unknown) => /^(EBUSY|EPERM|EACCES)$/.test((error as NodeJS.ErrnoException | null)?.code ?? "");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLock(path: string): { content: string; pid: number; age: number; holder: string | null } | null {
  try {
    const content = readFileSync(path, "utf8");
    const age = Date.now() - statSync(path).mtimeMs;
    let pid = 0;
    let holder: string | null = null;
    try {
      const parsed = JSON.parse(content) as { pid?: unknown; holder?: unknown };
      const p = Number(parsed.pid);
      if (Number.isSafeInteger(p) && p > 0) pid = p;
      if (typeof parsed.holder === "string" && parsed.holder.length > 0) holder = parsed.holder.slice(0, 100);
    } catch {
      // half written
    }
    return { content, pid, age, holder };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** A lock whose process is gone, or which was not refreshed for `staleAfter` ms; a half-written one after 10 s. */
const stale = (held: { pid: number; age: number }, staleAfter: number) => (held.pid === 0 ? held.age >= 10_000 : !alive(held.pid) || held.age > staleAfter);

/** The age of the file at `path` in ms, or null when it is gone. */
function ageOf(path: string): number | null {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * The watcher's lock at `path` (relay.ts takeLock's scheme): created exclusively with the process id
 * and a token of its own, refreshed every LOCK_REFRESH. A stale lock is taken over by the one process
 * that creates <path>.takeover, which renames it aside and removes it; then the lock is created
 * again, which only one process can. A takeover file older than TAKEOVER_STALE was left by a process
 * that died inside its takeover: it is renamed aside and removed, and the takeover tried again. A
 * lock whose process runs counts as stale once it was not refreshed for `staleAfter` ms (LOCK_STALE
 * by default; a lock held for milliseconds passes less, as withFileLock does, so a process id that
 * Windows gave again to another process soon after a crash does not keep it for 10 minutes).
 * `holder` says who holds it ("the watcher", "member 1's approval by hand"), written into the lock
 * so that a refusal names it. Returns null while another live process holds it, after printing
 * who. Between processes of one machine, on a local disk.
 */
export function takeLock(path: string, log: (line: string) => void, staleAfter = LOCK_STALE, holder?: string): Lock | null {
  const takeover = `${path}.takeover`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const content = JSON.stringify({ pid: process.pid, token: randomUUID(), since: new Date().toISOString(), ...(holder ? { holder } : {}) });
    try {
      const fd = openSync(path, "wx");
      try {
        writeSync(fd, content);
      } finally {
        closeSync(fd);
      }
      return heldLock(path, content);
    } catch (error) {
      if (busy(error)) {
        pause(200);
        continue;
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const held = readLock(path);
    if (!held) continue;
    if (!stale(held, staleAfter)) {
      log(held.pid === 0 ? `     another process is writing ${path}` : `     ${held.holder ?? "another process"} (process ${held.pid}) holds ${path}`);
      return null;
    }
    let fd: number;
    try {
      fd = openSync(takeover, "wx");
    } catch (error) {
      if (!busy(error) && (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Another process is taking it over; a takeover file this old is from one that died meanwhile.
      const age = busy(error) ? null : ageOf(takeover);
      if (age !== null && age > TAKEOVER_STALE) {
        log(`     ${takeover} was left ${Math.floor(age / 1000)} s ago by a takeover that did not finish: removed`);
        const aside = `${takeover}.${process.pid}.stale`;
        try {
          renameSync(takeover, aside);
          rmSync(aside, { force: true });
        } catch (removing) {
          // another process removed it first, or Windows holds it for a moment
          if (!busy(removing) && (removing as NodeJS.ErrnoException).code !== "ENOENT") throw removing;
          pause(200);
        }
        continue;
      }
      pause(200);
      continue;
    }
    closeSync(fd);
    try {
      const now = readLock(path);
      if (now?.content === held.content && stale(now, staleAfter)) {
        log(`     ${path} is stale (process ${held.pid || "?"}, refreshed ${Math.floor(held.age / 1000)} s ago): taken over`);
        const aside = `${path}.${process.pid}.stale`;
        renameSync(path, aside);
        rmSync(aside, { force: true });
      }
    } finally {
      rmSync(takeover, { force: true });
    }
  }
  log(`     ${path} could not be taken`);
  return null;
}

/**
 * The committee's lock for a run with --send (takeLock, as `holder`), and its halt file read again
 * once the lock is held: another run with --send may have left it after this run first looked and
 * before it took the lock (it writes the file, then releases the lock). With the halt file there,
 * the lock is released again and the halt returned, unless `despiteHalt` (an approval by hand once
 * a member has looked). Null while another run holds the lock.
 */
export function takeCommitteeLock(lockPath: string, haltPath: string, log: (line: string) => void, o: { holder: string; despiteHalt?: boolean }): { lock: Lock } | { halt: Halt } | null {
  const lock = takeLock(lockPath, log, LOCK_STALE, o.holder);
  if (!lock) return null;
  const halt = readHalt(haltPath);
  if (halt && !o.despiteHalt) {
    lock.release();
    return { halt };
  }
  return { lock };
}

function heldLock(path: string, content: string): Lock {
  const held = () => {
    try {
      if (readFileSync(path, "utf8") !== content) return false;
    } catch {
      return false;
    }
    try {
      const now = new Date();
      utimesSync(path, now, now);
    } catch {
      // refreshed at the next check
    }
    return true;
  };
  const beat = setInterval(held, LOCK_REFRESH);
  beat.unref();
  return {
    path,
    held,
    release: () => {
      clearInterval(beat);
      try {
        if (readLock(path)?.content === content) rmSync(path, { force: true });
      } catch {
        // the next watcher takes it over once stale
      }
    },
  };
}
