// A transfer in progress, or a recorded run replayed: its steps, its checks and what it trusts. A
// replay plays the measured step plan on a clock, with the recorded run's hashes and blocks; a live
// transfer is drawn from what the wallet and the chains have answered so far; any other lock or burn
// from what the chains say of it now. Each in the words of its destination (../dests.ts): its name,
// its mark, its explorer, its confirmations and its finality.

import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { nodeConsoleBlock, records } from "../../lib/chains.ts";
import { checksum } from "../../lib/display.ts";
import type { Hex } from "../../lib/records-types.ts";
import { deployed, destOf, explorerAddress, explorerBlock, explorerTx, type Dest, type DestKey } from "../dests.ts";
import { FAST_CAP, IMPORT_GAS, SPEED_NAME, fromOf, mintGasText, timeOf, toOf, type ChainInfo, type Dir, type Speed } from "../facts.ts";
import { AUTO_MINT, autoMints, handoffOf, handoffProgress, mintDueAt, relayWait, utcClock, type RelayWait } from "../handoff.ts";
import { ChainMark } from "../marks.tsx";
import type { NetState } from "../net.ts";
import type { Route } from "../router.ts";
import { useBox } from "../store.ts";
import { wallet } from "../wallet.ts";
import {
  CHAIN_EVERY,
  FAST_RUN,
  STD_RUN,
  amountText,
  followerOf,
  isDone,
  nonceOf,
  recordedBurn,
  recordedOf,
  timedRun,
  toTokens,
  transferActions,
  transfers,
  useChainRead,
  waitingChecks,
  watcherSpeed,
  type BurnRun,
  type BurnTransfer,
  type ChainBurn,
  type ChainLock,
  type ChainRead,
  type ChainTransfer,
  type CheckKey,
  type CheckState,
  type Failure,
  type LiveTransfer,
  type LockRun,
  type LockTransfer,
  type MintRoute,
  type TransferAction,
} from "../transfers.ts";
import { gasText } from "../txmath.ts";
import { Addr, Chip, Icon, Nb, announce, clock, dur, fmt, num, secs, short, toast } from "../ui.tsx";

type StepState = "pending" | "active" | "needs" | "done" | "failed" | "stuck";
export type MemberState = "approved" | "waiting" | "idle";
/** Verified or trusted, the step's note, and the shorter note a folded step keeps on phones. */
type Trust = readonly ["verify" | "trust", string, string?];
/** A step's line: plain text, with the parts that keep to one line marked. */
type Line = string | readonly (string | { nb: string })[];

interface TxRef {
  hash: Hex;
  href: string | undefined;
  label: string;
}

interface Step {
  key: string;
  title: string;
  st: StepState;
  /** How far along it is, 0 to 1: its segment of the bar over the card. */
  p: number;
  sub: Line;
  trust: Trust;
  /** Its trust line stays when the finished step folds on small phones. */
  keep: boolean;
  tx: TxRef | null;
  link: { href: string; text: string } | null;
  /** Confirmations so far: three dots. */
  count: number | null;
  /** The committee's approvals so far: two dots. */
  approvals: number | null;
  /** The finality countdown's fill, 0 to 1. */
  bar: number | null;
  time: string;
}

interface TxState {
  steps: Step[];
  /** Seconds on the card's clock; null when the transfer's start could not be read. */
  t: number | null;
  done: boolean;
  /** The next step waits on the visitor. */
  needs: { action: string; note: string } | null;
  /** Why it stopped, the notice's words, the button's, and whether nothing is on chain yet (the amount can change). */
  failed: { reason: Failure["reason"]; title: string; text: string; action: string; change: boolean } | null;
  /** The mint was sent and is not mined. */
  stuck: { action: string; note: string } | null;
  /** Auto-mint has not minted it in time: why, above the button that offers the visitor's own mint. */
  offer: { title: string; text: string } | null;
  checks: Record<CheckKey, CheckState>;
  members: readonly MemberState[];
}

/** The values a passed check shows: the finalized block, its signatures, the lock's commitment and nonce. */
export interface CheckFacts {
  finalBlock: number | null;
  finalHash: Hex | null;
  setId: number | null;
  signatures: number | null;
  authorities: number | null;
  commitment: Hex | null;
  nonce: number | null;
}

/** What the card says about the transfer, whatever its state. */
interface Head {
  /** The chain on the other side of V3: Sepolia for the recorded runs and their replays. */
  dest: DestKey;
  /** The way in, or the way back's release speed. */
  mode: "in" | Speed;
  amount: number;
  /** For "Change amount": the bridge's field takes it back. */
  amountText: string;
  label: string;
  fallback: boolean;
  /** A replay's: when the recorded run was made. */
  replayWhen: string | null;
  /** A lock or a burn read from the chains: what was read. */
  note: string | null;
  /** A note on the card itself: how this mint goes when it imports set changes first. */
  cardNote: string | null;
  receipt: string;
  facts: CheckFacts;
  /** The way in, minted by auto-mint (a lock of its minimum or more): its usual time is auto-mint's. */
  auto: boolean;
  /** The foot's line once the lock is on V3 and the mint is auto-mint's to send. */
  waitText: string | null;
  /** The clock's "usually", when it is not the destination's usual time: a lock whose auto-mint waits for the relayer's run (usualOf). */
  usual: readonly [string, string] | null;
}

// ---------------------------------------------------------------------------------------------
// The words and the pacing

/** The five checks of a mint, as the contracts make them: each tampered mint of rows 33 to 38 reverts at one. */
const CHECKS: readonly { key: CheckKey; name: string; what: string }[] = [
  { key: "header", name: "Header hash", what: "blake2b of the header is the block the signatures finalize" },
  { key: "sigs", name: "2 of 2 validator signatures", what: "ed25519, against V3's current validator set" },
  { key: "proof", name: "Storage proofs", what: "the vault's child trie, walked to the state root" },
  { key: "commit", name: "Commitment", what: "recomputed from recipient, amount and nonce" },
  { key: "nonce", name: "Nonce, used once", what: "this lock has not been minted before" },
];

const CHECK_LABEL: Record<CheckState, string> = { waiting: "Waiting", checking: "Checking", passed: "Passed", failed: "Failed" };

export const ALL_PASSED: Record<CheckKey, CheckState> = { header: "passed", sigs: "passed", proof: "passed", commit: "passed", nonce: "passed" };

/** Sepolia: the recorded runs, and the replays that play them. */
const SEP = destOf("sepolia");

/** Each step's trust line, in the words of the destination `d`: its burn, its confirmations, its finality. */
function trustOf(d: Dest) {
  const sep = d.key === "sepolia";
  return {
    lock: ["verify", "Your lock is the vault's record: the proof reads it later."],
    final: ["verify", "GRANDPA: 2 of 2 validators sign the block."],
    proof: ["verify", `Checked here first, then again by the contracts on ${d.short}.`],
    mint: ["verify", "BridgeMinter checks all five again, on chain, before it mints."],
    burn: ["verify", `${d.short} records the burn and its id. This part is on chain.`],
    confs: sep
      ? [
          "trust",
          "Fast releases after 3 confirmations, before Sepolia finality. A reorg deeper than 3 blocks could undo the burn after the release.",
          "Before Sepolia finality · a reorg deeper than 3 blocks could undo it",
        ]
      : [
          "trust",
          `Fast releases after ${d.fastConfirmations} blocks, 36 s, before its batch is final on Sepolia. A restart or a failover of ${d.short}'s sequencer that drops them could undo the burn after the release.`,
          "Before its batch is final · a sequencer restart could undo it",
        ],
    finality: ["verify", sep ? "Waits until Sepolia cannot revert the burn." : `Waits until ${d.short}'s batch is final on Sepolia: then nothing can revert the burn.`],
    release: ["trust", "Trusted: 2 of 3 members approve. Nothing on V3 checks the burn."],
  } as const satisfies Record<string, Trust>;
}

/** What the visitor signs on `d`: the mint. */
const needsOn = (d: Dest) => ({ action: `Switch to ${d.short} and sign the mint`, note: "Your wallet asks twice: switch network, then sign." });
const STUCK = {
  action: "Speed up the mint",
  note: "Your wallet's Speed up re-signs the same mint at the same nonce, with a higher fee. Only one of the two can be mined, and either completes this transfer.",
};

/** What the visitor signs next on `d`: the mint, or one transaction of a self-relay that takes several. */
function needsOf(r: MintRoute | null, d: Dest): { action: string; note: string } {
  if (!r || r.steps < 2) return needsOn(d);
  return { action: `Switch to ${d.short} and sign ${r.step} of ${r.steps}`, note: `Your wallet asks for each of the ${r.steps} transactions in turn, after the one before is mined.` };
}

/** What the dry run ran, by the mint's path. */
const DRY: Record<MintRoute["path"], string> = { mint: "mint(p)", head: "importAndMint", change: "importAndMint", selfRelay: "the self-relay" };

/** The card's note for a mint that imports V3's set changes itself instead of waiting for the relayer. */
function routeNote(r: MintRoute | null): string | null {
  if (r?.path === "change") {
    return "V3 changed validator set at the block your lock is proven in, and the light client had not imported it: the mint imports that change in the same call, about 0.5 M gas more than at V3's head. Nobody waits for the relayer.";
  }
  if (r?.path !== "selfRelay" || r.imports < 1) return null;
  const n = r.imports;
  const txs = r.steps > 1 ? ` in ${r.steps} transactions` : "";
  const all = r.total !== null ? ` (≈ ${gasText(r.total)} gas in all)` : "";
  return `The light client lacked V3's newer validator sets: the mint imports ${n === 1 ? "a set change" : `${n} set changes`} first, through Multicall3${txs}, about ${fmt(IMPORT_GAS * n, 1)} M gas more${all}. Nobody waits for the relayer.`;
}

/** The finality step's line: the block the proofs are read at, its set, and the signatures the import counts when it imports one. */
function finalLine(f: NonNullable<LockTransfer["finality"]>): string {
  const set = f.setId !== null ? ` · set ${f.setId}` : "";
  const sigs = f.signatures !== null && f.authorities !== null ? ` · ${f.signatures} of ${f.authorities} precommits` : "";
  return `Finalized in block #${num(f.block)}${set}${sigs}`;
}

/** The card's notice and button for a transfer to or from `d` that stopped, by why, in the words the sends gave it when they said more. */
function failedOf(f: Failure, dir: Dir, onChain: boolean, d: Dest): NonNullable<TxState["failed"]> {
  // On the way in, once the lock is on chain what is left to send is the mint.
  const what = dir === "back" ? "burn" : onChain ? "mint" : "lock";
  const Was = dir === "back" ? "burned" : onChain ? `sent to ${d.short}` : "sent";
  const after = dir === "in" && onChain ? " Your tPOT stays locked for you; the lock does not expire." : " Try again, or change the amount.";
  const words: Record<Failure["reason"], readonly [string, string, string]> = {
    rejected: ["Cancelled in your wallet", `Nothing was ${Was}.${after}`, `Try the ${what} again`],
    refused: [`${what[0]?.toUpperCase() ?? ""}${what.slice(1)} not sent`, `Nothing was ${Was}.`, `Try the ${what} again`],
    reverted: [`The ${what} reverted`, `Only its fee was paid.${after}`, `Try the ${what} again`],
    proof: [
      "A storage proof didn't check out",
      `Nothing was sent to ${d.short}. Your tPOT stays locked for you; the lock does not expire. Rebuilding reads the proof again at the latest finalized block.`,
      "Rebuild the proof",
    ],
    blocked: ["The mint is blocked", "Your tPOT stays locked for you; the lock does not expire.", "Check again"],
    stopped: ["This page stopped following it", "Nothing on chain changed.", "Follow it again"],
  };
  const [title, text, action] = words[f.reason];
  return { reason: f.reason, title: f.title ?? title, text: f.text ?? text, action, change: !onChain };
}

/** A mint sent this long ago and still not mined is stuck: the prototype's "sent 5 min ago". */
const STUCK_AFTER = 5 * 60_000;
/** A qualified burn with no approval this long is not picked up yet: the watcher's rounds take about 20 s, its checks under a minute. */
const SLOW_RELEASE = 3 * 60_000;

// The replays' pacing, not measurements: when each check lights inside the measured proof step
// (seconds from its start), when the second signature is checked, Sepolia's 12 s a block for the
// confirmations, and the standard burn's 15 s (its own time was not recorded).
const CHECK_AT: Record<CheckKey, number> = { header: 1.5, sigs: 3.5, proof: 6, commit: 7.5, nonce: 8.5 };
const SECOND_SIG_AT = 2.5;
const BLOCK_S = 12;
const STD_MINED = 15;
// The replays' wallet prompts, as the prototype plays them: the lock or the burn is asked for in
// the wallet for the first 2.5 s, and the mint for the first 3 s of its step, before it is sent.
const CONFIRM_S = 2.5;
const MINT_CONFIRM_S = 3;

/** The timed run's steps: what "usually" means on a live transfer. */
const MEASURED = timedRun().steps;

const NO_MEMBERS: readonly MemberState[] = ["idle", "idle", "idle"];
const NO_FACTS: CheckFacts = { finalBlock: null, finalHash: null, setId: null, signatures: null, authorities: null, commitment: null, nonce: null };

// ---------------------------------------------------------------------------------------------
// Small helpers, shared with the receipt

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** "14:45", in UTC. */
export function hhmm(at: string | number): string {
  const d = new Date(at);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** "Oct 20", in UTC. */
export function day(at: string | number): string {
  const d = new Date(at);
  return `${MONTHS[d.getUTCMonth()] ?? ""} ${d.getUTCDate()}`;
}

/** "Oct 20, 14:45 UTC". */
export const when = (at: string | number): string => `${day(at)}, ${hhmm(at)} UTC`;

export const factsOf = (r: LockRun): CheckFacts => ({
  finalBlock: r.finalBlock,
  finalHash: r.finalHash,
  setId: r.setId,
  signatures: r.signatures,
  authorities: r.authorities,
  commitment: r.commitment,
  nonce: r.nonce,
});

export function liveFacts(x: LockTransfer): CheckFacts {
  const f = x.finality;
  return {
    finalBlock: f?.block ?? null,
    finalHash: f?.hash ?? null,
    setId: f?.setId ?? null,
    signatures: f?.signatures ?? null,
    authorities: f?.authorities ?? null,
    commitment: x.commitment,
    nonce: x.nonce,
  };
}

/** A live transfer's name: its nonce, once the chain has given it; a rollup's burn with its chain, as each minter counts its own. */
export function liveLabel(x: LiveTransfer): string {
  if (x.dir === "in") return x.nonce !== null ? `Lock ${x.nonce}` : "New lock";
  if (x.burnNonce === null) return "New burn";
  return x.dest === "sepolia" ? `Burn ${x.burnNonce}` : `Burn ${x.burnNonce} on ${destOf(x.dest).short}`;
}

/** A duration between two times in ms. A block's timestamp can trail the page's clock by a second or two. */
const span = (from: number, to: number): string => dur(Math.max(0, (to - from) / 1000));

const lineText = (l: Line): string => (typeof l === "string" ? l : l.map((p) => (typeof p === "string" ? p : p.nb)).join(""));

function LineView({ l }: { l: Line }) {
  if (typeof l === "string") return <>{l}</>;
  return <>{l.map((p, i) => (typeof p === "string" ? p : <Nb key={i}>{p.nb}</Nb>))}</>;
}

/** A span with one CSS property set through the CSSOM: the page's CSP allows no style attributes. */
export function CssSpan({ cls, prop, value }: { cls?: string; prop: string; value: string | null }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (value === null) el.style.removeProperty(prop);
    else el.style.setProperty(prop, value);
  }, [prop, value]);
  return <span class={cls} ref={ref} />;
}

/** Sends the page on to where this id lives, replacing the history entry. */
export function Redirect({ to }: { to: string }) {
  useEffect(() => {
    location.replace(to);
  }, [to]);
  return null;
}

/** A page with nothing to show yet, or nothing at all: Activity's empty state, as a page. */
function EmptyCard({ title, status = false, children }: { title: string; status?: boolean; children: ComponentChildren }) {
  return (
    <div class="page page--narrow">
      <div class="card acard">
        <div class="empty">
          <svg class="empty__art" viewBox="0 0 96 96" aria-hidden="true">
            <rect x="4" y="4" width="88" height="88" rx="24" class="empty__tile" />
            <rect x="20" y="26" width="42" height="12" rx="6" class="empty__bar" />
            <rect x="34" y="58" width="42" height="12" rx="6" class="empty__bar empty__bar--b" />
            <path d="M57 32 L39 64" class="empty__beam" />
          </svg>
          <h1 class="empty__title">{title}</h1>
          <p class="empty__text" role={status ? "status" : undefined}>
            {children}
          </p>
          <a class="btn btn--primary btn--lg" href="#/activity">
            Go to Activity
          </a>
        </div>
      </div>
    </div>
  );
}

export function NotFound({ what, id }: { what: "transfer" | "receipt"; id: string }) {
  const name = id.length > 32 ? short(id, 14, 8) : id;
  // A lock's or a burn's id has been looked for on its chain too.
  const k = nonceOf(id);
  const where = k ? `this browser, in the records or in ${k.dir === "in" ? "the vault's logs on V3" : `BridgeMinter's logs on ${destOf(k.dest).short}`}` : "this browser or in the records";
  return (
    <EmptyCard title={what === "transfer" ? "Transfer not found" : "Receipt not found"}>
      {name ? (
        <>
          Nothing in {where} goes by <span class="mono">{name}</span>.{" "}
        </>
      ) : null}
      {what === "transfer"
        ? "A transfer you start is kept in the browser you start it in, and followed here again when the page opens. The recorded runs are in Activity."
        : "A receipt follows a transfer once it is done. The recorded runs and their receipts are in Activity."}
    </EmptyCard>
  );
}

/** A lock or a burn being read from its chain, or a chain that did not answer the first read, or a burn older than its chain's nodes search. */
export function ChainWait({ id, read }: { id: string; read: ChainRead }) {
  const k = nonceOf(id);
  // A burn's id names its chain; a lock's chain is in its log, read first.
  const chain = k?.dir === "back" ? destOf(k.dest).short : null;
  const name = `${chain ? "burn" : "lock"} ${k?.n ?? ""}${chain && chain !== "Sepolia" ? ` on ${chain}` : ""}`;
  const where = chain ? `BridgeMinter's BurnRequested log on ${chain}` : "the vault's Locked log on V3";
  if (read.state === "older" && k?.dir === "back") {
    const d = destOf(k.dest);
    return (
      <EmptyCard title={`${name[0]?.toUpperCase() ?? ""}${name.slice(1)} is older than this page searches`}>
        BridgeMinter on {d.short} counts it, and its BurnRequested log is older than block <span class="mono">#{num(read.before)}</span>, as far back as the nodes here search
        logs.{" "}
        <a class="text-link" href={`${explorerAddress(d, deployed(d).minter)}#events`} target="_blank" rel="noopener">
          See BridgeMinter's events on {d.explorer.name}
        </a>
        .
      </EmptyCard>
    );
  }
  if (read.state === "error") {
    return (
      <EmptyCard title={`Could not read ${name}`}>
        {chain ? `${chain}'s RPCs` : "Portaldot V3"} did not answer, so {where} could not be read. This page asks again every {CHAIN_EVERY / 1000} s.
      </EmptyCard>
    );
  }
  return (
    <EmptyCard title={`Reading ${name}`} status>
      From {where}, then what came of it on {chain ? "V3" : "the chain it names"}.
    </EmptyCard>
  );
}

// ---------------------------------------------------------------------------------------------
// The two side panels: the checks (the way in) and the committee (the way back)

function checkValue(key: CheckKey, f: CheckFacts): string | null {
  switch (key) {
    case "header":
      return f.finalHash && f.finalBlock !== null ? `blake2b → ${short(f.finalHash, 10, 8)} · #${num(f.finalBlock)}` : null;
    case "sigs":
      return f.signatures !== null && f.authorities !== null && f.setId !== null ? `${f.signatures} of ${f.authorities} precommits · set ${f.setId}` : null;
    case "proof":
      return f.nonce !== null ? `commitments[${f.nonce}] in the vault's child trie` : null;
    case "commit":
      return f.commitment ? `${short(f.commitment, 10, 8)} · matched` : null;
    case "nonce":
      return f.nonce !== null ? `nonce ${f.nonce} · used(${f.nonce}) was false` : null;
  }
}

/**
 * The five checks, as a lit rail: the project's signature. `held`, on a receipt: the mint was mint(p)
 * at a block the light client held already, whose header and signatures it checked when it took the
 * block in (null: not known which). `chain`: where the mint is checked, the destination's name.
 */
export function ChecksPanel({
  states,
  receipt,
  facts,
  held = false,
  chain = "Sepolia",
}: {
  states: Record<CheckKey, CheckState>;
  receipt: boolean;
  facts: CheckFacts;
  held?: boolean | null;
  chain?: string;
}) {
  const passed = CHECKS.filter((c) => states[c.key] === "passed").length;
  return (
    <div class="rail-card">
      <div class="rail-card__head">
        <span class="rail-card__icon" aria-hidden="true">
          <Icon id="i-shield-check" />
        </span>
        <div>
          <h2 class="rail-card__title">{receipt ? "What was checked" : `What ${chain} checks`}</h2>
          <p class="rail-card__sub">
            {!receipt
              ? "Your browser checks each one first. BridgeMinter checks them again, on chain."
              : held === true
                ? "The light client verified the header and its signatures when it took the block in; mint(p) verified the other three before it minted."
                : held === null
                  ? `Verified on ${chain} before the mint, by the light client and BridgeMinter.`
                  : `importAndMint verified all five on ${chain} before it minted.`}
          </p>
        </div>
        <span class="rail-card__count">
          <span class="mono">{passed}</span>/{CHECKS.length}
        </span>
      </div>
      <ol class="rail">
        {CHECKS.map((c) => {
          const st = states[c.key];
          const value = st === "passed" ? checkValue(c.key, facts) : null;
          return (
            <li key={c.key} class={`rail__item is-${st}`}>
              <span class="rail__node">
                {st === "passed" ? <Icon id="i-check" /> : st === "failed" ? <Icon id="i-x" /> : st === "checking" ? <span class="tl__spin" aria-hidden="true" /> : null}
              </span>
              <div class="rail__body">
                <p class="rail__title">{c.name}</p>
                <p class="rail__meta">{value !== null ? <span class="mono">{value}</span> : c.what}</p>
              </div>
              <span class="rail__state">{CHECK_LABEL[st]}</span>
            </li>
          );
        })}
      </ol>
      <p class="rail-card__foot">
        <Icon id="i-info" cls="i--14" />
        <span>Still trusts the V3 validator set (2 keys, testnet), V3's sudo key and the light client's admin.</span>
      </p>
    </div>
  );
}

const ROLES = ["opens the release", "runs it", "a spare key"];

/**
 * The committee: who approves the release, from the records. `members` is null on a receipt;
 * `speed` is null on the receipt of a burn read from the chains, which do not say how it was
 * released. `d`: the chain the burn is on.
 */
export function TrustPanel({ speed, fallback, members, d = SEP }: { speed: Speed | null; fallback: boolean; members: readonly MemberState[] | null; d?: Dest }) {
  const C = records.returnPath.committee;
  const sep = d.key === "sepolia";
  const mem = members ?? ["approved", "approved", "idle"];
  const approved = mem.filter((m) => m === "approved").length;
  return (
    <div class="rail-card rail-card--trust">
      <div class="rail-card__head">
        <span class="rail-card__icon" aria-hidden="true">
          <Icon id="i-users" />
        </span>
        <div>
          <h2 class="rail-card__title">{members ? "What you trust" : "What was trusted"}</h2>
          <p class="rail-card__sub">The burn is on {d.short}. The release is the committee's: 2 of 3 members must approve it on V3.</p>
        </div>
        <span class="rail-card__count">
          <span class="mono">{approved}</span>/{C.threshold}
        </span>
      </div>
      <ol class="rail rail--trust">
        {C.members.map((ss58, i) => {
          const st = mem[i] ?? "idle";
          const spare = i === 2 && st === "idle";
          const cls = spare ? "idle" : st === "approved" ? "passed" : st === "waiting" ? "checking" : "waiting";
          return (
            <li key={ss58} class={`rail__item is-${cls}`}>
              <span class="rail__node">
                {st === "approved" ? <Icon id="i-check" /> : st === "waiting" ? <span class="tl__spin" aria-hidden="true" /> : <span class="mono rail__n">{i + 1}</span>}
              </span>
              <div class="rail__body">
                <p class="rail__title">
                  Member {i + 1} <span class="rail__role">· {ROLES[i] ?? "a member"}</span>
                </p>
                <p class="rail__meta">
                  <span class="mono">{short(ss58, 6, 4)}</span>
                </p>
              </div>
              <span class="rail__state">{spare ? "Not needed" : st === "approved" ? "Approved" : st === "waiting" ? "Approving" : "Waiting"}</span>
            </li>
          );
        })}
      </ol>
      <dl class="rail-card__kv">
        <div class="kv">
          <dt class="kv__k">Mode</dt>
          <dd class="kv__v">
            {speed === "fast" ? (
              <>
                Fast <span class="kv__note">· after {d.fastConfirmations} confirmations, up to {FAST_CAP} tPOT</span>
              </>
            ) : speed === null ? (
              <>
                Fast or Standard <span class="kv__note">· the watcher's record, not the chain's</span>
              </>
            ) : fallback ? (
              <>
                Standard (fallback) <span class="kv__note">· Fast budget in use</span>
              </>
            ) : (
              <>
                Standard <span class="kv__note">· after {sep ? "Sepolia finality" : `${d.short}'s finality`}</span>
              </>
            )}
          </dd>
        </div>
        <div class="kv">
          <dt class="kv__k">Multisig</dt>
          <dd class="kv__v">
            <span class="mono">{short(C.multisig, 6, 4)}</span>{" "}
            <span class="kv__note">
              · {C.threshold} of {C.members.length}
            </span>
          </dd>
        </div>
      </dl>
      <p class="rail-card__foot rail-card__foot--trust">
        <Icon id="i-alert" cls="i--14" />
        <span>
          Nothing on V3 checks your burn.
          {speed === "std"
            ? ""
            : sep
              ? " Fast releases before Sepolia finality: a reorg deeper than 3 blocks could undo the burn after the release."
              : ` Fast releases before its batch is final on Sepolia: a restart or a failover of ${d.short}'s sequencer could undo the burn after the release.`}{" "}
          On the testnet one operator holds all three keys.
        </span>
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Steps

function step(key: string, title: string, trust: Trust): Step {
  return { key, title, trust, st: "pending", p: 0, sub: "", keep: false, tx: null, link: null, count: null, approvals: null, bar: null, time: "" };
}

/** A step on a replay's clock: pending, active or done by its window in the plan. */
function onPlan(x: Step, start: number, end: number, t: number): Step {
  x.st = t >= end ? "done" : t >= start ? "active" : "pending";
  x.p = Math.max(0, Math.min(1, (t - start) / (end - start)));
  if (x.st === "done") x.time = dur(end - start);
  return x;
}

/** A live step under way since `since` (ms): its segment fills toward the measured time, never quite to the end. */
function activeFrom(x: Step, since: number, usual: number | undefined, now: number): void {
  x.st = "active";
  x.p = usual ? Math.min(0.9, Math.max(0, (now - since) / 1000 / usual)) : 0;
}

/** The proof step's line while check `k` runs; `call`: what the dry run runs (a live plan's path is known only once it is built), on `chain`. */
function proofLine(k: CheckKey, block: number, sigs: string | null, call = "importAndMint", chain = "Sepolia"): string {
  if (k === "header") return `Reading block #${num(block)} from V3`;
  if (k === "sigs") return `Checking validator signatures${sigs ? ` · ${sigs}` : ""}`;
  if (k === "proof") return "Walking the vault's storage proof";
  if (k === "commit") return "Recomputing your lock's commitment";
  return `Dry run of ${call} on ${chain} · checks the nonce`;
}

/** Standard: the blocks so far against the ≈ `of` blocks of the chain's finality, and the minutes left of its `seconds`. */
function countdown(prefix: string, blocks: number, of: number, seconds: number): Line {
  const p = Math.min(1, blocks / of);
  const left = Math.max(1, Math.ceil(((1 - p) * seconds) / 60));
  return [prefix, { nb: `${num(blocks)} of ≈ ${num(of)} blocks` }, " · ", { nb: `≈ ${left} min left` }];
}

/** A live burn's countdown, against its chain's finality as measured (../dests.ts): Sepolia's about 80 blocks, a rollup's about 20 minutes of its blocks. */
const liveCountdown = (prefix: string, blocks: number, d: Dest): Line => countdown(prefix, blocks, d.finality.blocks, d.finality.seconds);

const finalityAhead = (prefix: string, d: Dest) => {
  const [t, src] = timeOf(d.key, "std");
  return d.key === "sepolia" ? `${prefix}Sepolia finality, ${d.finality.range} · ${t} in all, ${src}` : `${prefix}${d.short}'s finality, its batch final on Sepolia, ${d.finality.range} · ${t} in all, est.`;
};
const releaseAhead = (fast: boolean, d: Dest) => (fast ? `After ${d.fastConfirmations} confirmations · nothing to sign` : "About a minute after finality, by the watcher · nothing to sign");
/** Burn 0's, on its replay: released by hand, before the watcher existed. */
const RECORDED_FINALITY = `${STD_RUN.finLabel} · ${dur(STD_RUN.total)} in all, released by hand (burn ${STD_RUN.burn}, Oct 20)`;
const RECORDED_RELEASE = `${STD_RUN.relLabel} after finality · nothing to sign`;

function approvalLine(a: number, openBlock: number | null): string {
  if (a <= 0) return "0 of 2 approvals so far";
  if (a === 1) return `1 of 2 approvals · member 1 ${openBlock !== null ? `opened it in #${num(openBlock)}` : "opened it"}`;
  return "2 of 2 approvals · member 2 ran it";
}

// ---------------------------------------------------------------------------------------------
// The replays: the recorded runs on a clock

interface InPlan {
  lock: number;
  final: number;
  proof: number;
  total: number;
}

/** Seconds from sending the burn: its block, the burn qualified, the two approvals, the end. */
interface BackPlan {
  mined: number;
  qualified: number;
  opened: number;
  ran: number;
  total: number;
}

type Replay = { dir: "in"; run: LockRun; plan: InPlan } | { dir: "back"; speed: Speed; run: BurnRun; plan: BackPlan };

const since = (from: string, to: string | null): number | null => (to ? Math.round((Date.parse(to) - Date.parse(from)) / 1000) : null);

/** #/tx/replay-in (lock 1, Oct 20) and #/tx/replay-back?speed=fast|std (burn 1, Oct 24, or burn 0, Oct 20). */
function replayOf(id: string, speedQ: string | null): Replay | null {
  if (id === "replay-in") {
    const run = timedRun();
    const s = run.steps;
    if (!s) return null;
    const final = s.lock + s.finality;
    const proof = final + s.proofs;
    return { dir: "in", run, plan: { lock: s.lock, final, proof, total: proof + s.mint } };
  }
  if (id !== "replay-back") return null;
  const speed: Speed = speedQ === "std" ? "std" : "fast";
  const run = recordedBurn(speed);
  if (speed === "fast") {
    if (!run || run.n !== FAST_RUN.burn) return null;
    const qualified = FAST_RUN.mined + 3 * BLOCK_S;
    return { dir: "back", speed, run, plan: { mined: FAST_RUN.mined, qualified, opened: FAST_RUN.opened, ran: FAST_RUN.ran, total: FAST_RUN.ran } };
  }
  if (!run || run.n !== STD_RUN.burn) return null;
  // The two approvals at their recorded times, from the burn's signing: member 1 opens, member 2 runs it.
  const opened = since(run.burnAt, run.open?.at ?? null);
  const ran = since(run.burnAt, run.run.at);
  if (opened === null || ran === null) return null;
  return { dir: "back", speed, run, plan: { mined: STD_MINED, qualified: STD_MINED + STD_RUN.finality, opened, ran, total: STD_RUN.total } };
}

function replayHead(r: Replay): Head {
  if (r.dir === "in") {
    return {
      dest: "sepolia",
      mode: "in",
      amount: toTokens(r.run.amount),
      amountText: amountText(r.run.amount),
      label: `Lock ${r.run.nonce} · the recorded run`,
      fallback: false,
      replayWhen: when(r.run.lockAt),
      note: null,
      cardNote: null,
      receipt: "#/receipt/replay-in",
      facts: factsOf(r.run),
      auto: false,
      waitText: null,
      usual: null,
    };
  }
  return {
    dest: "sepolia",
    mode: r.speed,
    amount: toTokens(r.run.amount),
    amountText: amountText(r.run.amount),
    label: `Burn ${r.run.n} · the recorded run`,
    fallback: false,
    replayWhen: when(r.run.burnAt),
    note: null,
    cardNote: null,
    receipt: `#/receipt/replay-back?speed=${r.speed}`,
    facts: NO_FACTS,
    auto: false,
    waitText: null,
    usual: null,
  };
}

// A replay plays the wallet's prompts as the prototype does: the lock asked for in the wallet for
// its first 2.5 s, then sent; the mint asked for in the first 3 s of its step, then sent.
function replayIn(r: LockRun, w: InPlan, t: number): TxState {
  const amt = fmt(toTokens(r.amount));
  const TRUST = trustOf(SEP);

  const L = onPlan(step("lock", "Lock on Portaldot V3", TRUST.lock), 0, w.lock, t);
  if (L.st === "active" && t < CONFIRM_S) {
    L.st = "needs";
    L.sub = "Confirm the lock in your wallet";
  } else {
    L.sub = L.st === "done" ? `${amt} tPOT locked in V3 block #${num(r.lockBlock)} · nonce ${r.nonce}` : "Sent · waiting for a V3 block";
    L.tx = { hash: r.lockTx, href: nodeConsoleBlock(r.lockBlock), label: "lock transaction" };
  }

  const F = onPlan(step("final", "V3 finality", TRUST.final), w.lock, w.final, t);
  F.sub =
    F.st === "done"
      ? `Finalized in block #${num(r.finalBlock)} · set ${r.setId} · ${r.signatures} of ${r.authorities} precommits`
      : F.st === "active"
        ? `GRANDPA is finalizing #${num(r.lockBlock)} · usually ${w.final - w.lock} s`
        : `Waits for ${r.threshold} of ${r.authorities} V3 validators`;
  if (F.st !== "pending") F.link = { href: nodeConsoleBlock(r.finalBlock), text: `#${num(r.finalBlock)}` };

  const P = onPlan(step("proof", "Proof built in your browser", TRUST.proof), w.final, w.proof, t);
  const tp = t - w.final;
  const checks = waitingChecks();
  let open = P.st === "active";
  for (const k of ["header", "sigs", "proof", "commit"] as const) {
    if (tp >= CHECK_AT[k]) checks[k] = "passed";
    else if (open) {
      checks[k] = "checking";
      open = false;
    }
  }
  // The dry run of importAndMint reads used(nonce), so the nonce passes with it: the rail and the step agree.
  checks.nonce = tp >= CHECK_AT.nonce ? "passed" : P.st === "active" && tp >= CHECK_AT.commit ? "checking" : "waiting";
  const at: CheckKey = tp < CHECK_AT.header ? "header" : tp < CHECK_AT.sigs ? "sigs" : tp < CHECK_AT.proof ? "proof" : tp < CHECK_AT.commit ? "commit" : "nonce";
  P.sub =
    P.st === "done"
      ? "5 of 5 checks passed · dry run of importAndMint passed"
      : P.st === "active"
        ? proofLine(at, r.finalBlock, `${tp < SECOND_SIG_AT ? 1 : 2} of ${r.signatures}`)
        : `≈ ${w.proof - w.final} s · 7 requests to V3`;

  const M = onPlan(step("mint", "Mint on Sepolia", TRUST.mint), w.proof, w.total, t);
  if (M.st === "pending") M.sub = `Your wallet, on Sepolia · ≈ ${SEP.mintGas.gas} M gas`;
  else if (M.st === "active" && t < w.proof + MINT_CONFIRM_S) M.sub = "Confirm the mint in your wallet";
  else {
    M.sub = M.st === "done" ? `${amt} wtPOT minted · Sepolia #${num(r.mintBlock)} · ${num(r.mintGas)} gas` : `Sent · waiting for the receipt · usually ${w.total - w.proof} s`;
    M.tx = { hash: r.mintTx, href: explorerTx(SEP, r.mintTx), label: "mint transaction" };
  }

  return { steps: [L, F, P, M], t, done: t >= w.total, needs: null, failed: null, stuck: null, offer: null, checks, members: NO_MEMBERS };
}

function replayBack(b: BurnRun, speed: Speed, w: BackPlan, t: number): TxState {
  const amt = fmt(toTokens(b.amount));
  const fast = speed === "fast";
  const TRUST = trustOf(SEP);

  // Fast shows only the measured times: the burn's block 24 s after sending, the release 84 s after
  // that block. Standard shows burn 0's split of its ≈ 20 min.
  const B = onPlan(step("burn", "Burn on Sepolia", TRUST.burn), 0, w.mined, t);
  if (B.st === "active" && t < CONFIRM_S) {
    B.st = "needs";
    B.sub = "Confirm the burn in your wallet";
  } else {
    B.sub = B.st === "done" ? `${amt} wtPOT burned in Sepolia block #${num(b.burnBlock)}` : "Sent · waiting for a Sepolia block";
    B.tx = { hash: b.burnTx, href: explorerTx(SEP, b.burnTx), label: "burn transaction" };
  }
  B.time = fast && B.st === "done" ? secs(w.mined) : "";

  let mid: Step;
  if (fast) {
    mid = onPlan(step("confs", "3 confirmations", TRUST.confs), w.mined, w.qualified, t);
    const n = Math.min(3, Math.max(0, Math.floor((t - w.mined) / BLOCK_S)));
    mid.keep = true;
    mid.time = "";
    mid.sub = mid.st === "done" ? `3 of 3 · Sepolia #${num(b.burnBlock + 3)} · the watcher checks every 15 s` : mid.st === "active" ? `${n} of 3 · about 12 s each` : "Then the watcher, every 15 s, qualifies the burn";
    if (mid.st !== "pending") {
      mid.count = n;
      mid.link = { href: explorerBlock(SEP, b.burnBlock + n), text: `#${num(b.burnBlock + n)}` };
    }
  } else {
    mid = onPlan(step("finality", "Sepolia finality", TRUST.finality), w.mined, w.qualified, t);
    mid.time = mid.st === "done" ? STD_RUN.finLabel : "";
    mid.sub =
      mid.st === "done"
        ? `Final · Sepolia finalized past #${num(b.burnBlock)}`
        : mid.st === "active"
          ? countdown("", Math.round(mid.p * STD_RUN.blocks), STD_RUN.blocks, STD_RUN.finality)
          : RECORDED_FINALITY;
    mid.bar = mid.st === "active" ? mid.p : null;
  }

  const R = onPlan(step("release", "Committee release on V3", TRUST.release), w.qualified, w.total, t);
  const a = R.st === "pending" ? 0 : t >= w.ran ? 2 : t >= w.opened ? 1 : 0;
  R.approvals = a;
  R.time = R.st !== "done" ? "" : fast ? secs(w.ran - w.mined) : STD_RUN.relLabel;
  R.sub =
    R.st === "done"
      ? `${amt} tPOT paid to ${short(checksum(b.payee))} · V3 #${num(b.run.block)}${fast ? ` · ${w.ran - w.mined} s after the burn's block` : ""}`
      : R.st === "active"
        ? approvalLine(a, b.open?.block ?? null)
        : fast
          ? releaseAhead(true, SEP)
          : RECORDED_RELEASE;
  if (R.st === "done") R.tx = { hash: b.run.tx, href: nodeConsoleBlock(b.run.block), label: "release extrinsic" };

  const members: MemberState[] = [
    t >= w.opened && R.st !== "pending" ? "approved" : R.st === "active" ? "waiting" : "idle",
    t >= w.ran && R.st !== "pending" ? "approved" : "idle",
    "idle",
  ];
  return { steps: [B, mid, R], t, done: t >= w.total, needs: null, failed: null, stuck: null, offer: null, checks: waitingChecks(), members };
}

// ---------------------------------------------------------------------------------------------
// Live transfers: drawn from what the wallet and the chains have answered

/**
 * On a rollup, a lock whose auto-mint would come in the minutes between a V3 set change and the
 * relayer's run waits for that run (handoff.ts, relayWait): the mint step's line says so, with the
 * times as the clock gives them, about, and its bar fills toward the run. Past the run's time, until
 * the visitor's own mint is offered, that auto-mint mints it after the run.
 */
function waitLine(w: RelayWait, d: Dest, now: number): Line {
  const tail = [" · ", { nb: `nothing to sign on ${d.short}` }] as const;
  if (now >= w.relay) return [{ nb: "The relayer's run was due" }, " ", { nb: `at about ${utcClock(w.relay)}` }, " · ", { nb: "auto-mint mints it after that run" }, ...tail];
  return [{ nb: "Auto-mint waits for the relayer's run" }, " ", { nb: `at about ${utcClock(w.relay)}` }, " · ", { nb: "V3 changed validator set" }, " ", { nb: `at about ${utcClock(w.change)}` }, ...tail];
}

/** The light client on `d` reads behind V3's set (net.ts), whatever the clock says: auto-mint waits for the relayer's import. */
function behindLine(d: Dest, behind: number): Line {
  return [
    { nb: "Auto-mint waits for the relayer" },
    " · ",
    { nb: `the light client on ${d.short}` },
    " ",
    { nb: `is ${behind === 1 ? "a validator-set change" : `${behind} validator-set changes`} behind V3` },
    " · ",
    { nb: "nothing to sign" },
  ];
}

/** When auto-mint usually mints a lock locked at `lockedAt` on `d`: lock 2's time after it, or after the relayer's run it waits for. */
const mintDue = (d: Dest, lockedAt: number): number => mintDueAt(d.key, lockedAt);

/**
 * The clock's "usually" for a lock to `d` mined at `lockedAt` whose auto-mint waits for the relayer's
 * run (relayWait): from `from` (the transfer's start, or the lock's block) to when auto-mint usually
 * mints it after that run. Null when it does not wait.
 */
function usualOf(d: Dest, lockedAt: number, from: number): readonly [string, string] | null {
  const w = relayWait(d.key, lockedAt);
  if (!w) return null;
  return [`≈ ${Math.max(1, Math.round((mintDue(d, lockedAt) - from) / 60_000))} min`, `after the relayer's run at about ${utcClock(w.relay)}`];
}

/**
 * The foot's line once the lock is on V3: while auto-mint is to mint it, whom it pays and when it
 * usually does; for a Polkadot wallet's lock, that only this browser can find it again (V3's EVM RPC
 * serves no log of a Substrate extrinsic, so Activity elsewhere does not list it).
 */
function waitTextOf(x: LiveTransfer): string | null {
  if (x.dir !== "in") return null;
  const here = x.sender.kind === "substrate";
  const d = destOf(x.dest);
  if (autoMints(x.amount, x.sender.kind)) {
    const w = x.lock.stage === "mined" ? relayWait(x.dest, x.lock.minedAt) : null;
    const when = w ? `after the relayer's run at about ${utcClock(w.relay)}, which brings the light client on ${d.short} to V3's new validator set` : `${timeOf(x.dest, "auto")[0]} after your lock`;
    return `You can close this page. Auto-mint usually mints ${fmt(toTokens(x.amount))} wtPOT for ${short(checksum(x.recipient))}${d.key === "sepolia" ? "" : ` on ${d.short}`} ${when}; ${here ? "Activity in this browser lists it" : "Activity shows it on any device"}.`;
  }
  if (here) {
    return "You can close this page. Your tPOT stays locked for you, and the lock does not expire: Activity in this browser lists it, to send its mint. Other devices cannot see a lock signed with a Polkadot wallet yet.";
  }
  return null;
}

function liveHead(x: LiveTransfer): Head {
  return {
    dest: x.dest,
    mode: x.dir === "in" ? "in" : x.speed,
    amount: toTokens(x.amount),
    amountText: amountText(x.amount),
    label: liveLabel(x),
    fallback: x.dir === "back" && x.fallback,
    replayWhen: null,
    note: null,
    cardNote: x.dir === "in" ? routeNote(x.route) : null,
    receipt: `#/receipt/${x.id}`,
    facts: x.dir === "in" ? liveFacts(x) : NO_FACTS,
    auto: x.dir === "in" && autoMints(x.amount, x.sender.kind),
    waitText: waitTextOf(x),
    usual: x.dir === "in" && autoMints(x.amount, x.sender.kind) && x.lock.stage === "mined" ? usualOf(destOf(x.dest), x.lock.minedAt, x.startedAt) : null,
  };
}

/** Who sent the mint, for its line: auto-mint, the visitor, or an address. */
function mintedBy(by: Hex | null, me: string | null): string {
  if (!by) return "";
  if (by === AUTO_MINT.key) return " · sent by auto-mint";
  if (me && by === me.toLowerCase()) return " · sent by you";
  return ` · sent by ${short(checksum(by))}`;
}

/** The visitor's own mint on `d`, its light client `behind` V3's set by that many changes: its gas as the card states it, and Base's L1 data fee. */
const mintCost = (d: Dest, behind: number): string => `≈ ${mintGasText(d, behind)} M gas in ${d.short} ETH${d.l1 === "op" ? ", plus an L1 data fee" : ""}`;

/**
 * The offer of the visitor's own mint on `d`, when auto-mint has not minted it in time (handoff.ts).
 * While the light client there reads `behind` V3's set, auto-mint waits for the relayer, `wait`
 * the run the clock expected: the offer says so, and that the visitor's mint imports the change.
 */
function offerOf(recipient: Hex, d: Dest, behind: number, wait: RelayWait | null): NonNullable<TxState["offer"]> {
  const pays = `any address can send the mint, it pays ${short(checksum(recipient))}`;
  if (behind > 0) {
    const late = wait ? `The relayer's run due at about ${utcClock(wait.relay)} has not reached ${d.short} yet` : `The light client on ${d.short} is behind V3's validator set`;
    return {
      title: "Auto-mint is waiting for the relayer",
      text: `${late}, and auto-mint mints this lock once it has. Your tPOT stays locked for you, and the lock does not expire. You can mint it yourself now: ${pays}, it imports ${behind === 1 ? "the set change" : `the ${behind} set changes`} first, and it costs ${mintCost(d, behind)}.`,
    };
  }
  const runs =
    d.key === "sepolia"
      ? `It runs on one machine and spends at most ${AUTO_MINT.dailyEth} ETH of gas a day: while that machine is off or the day's gas is spent, locks wait.`
      : `It runs on one machine, for Sepolia and the two rollups, and spends at most ${AUTO_MINT.rollupDailyEth} ETH of gas a day on ${d.short}: while that machine is off or the day's gas is spent, locks wait.`;
  return {
    title: "Auto-mint hasn't minted it yet",
    text: `${runs} Your tPOT stays locked for you, and the lock does not expire. You can mint it yourself now: ${pays}, and it costs ${mintCost(d, 0)}.`,
  };
}

/**
 * `evm`: the connected Ethereum wallet's address, which can send the mint, or null. `behind`: the
 * validator-set changes the light client on the transfer's destination reads behind V3 (net.ts).
 */
function liveIn(x: LockTransfer, now: number, evm: string | null, behind: number): TxState {
  const amt = fmt(toTokens(x.amount));
  const d = destOf(x.dest);
  const TRUST = trustOf(d);
  const auto = timeOf(d.key, "auto");
  const { lock, mint, finality: fin, failure, route, note } = x;
  const locked = lock.stage === "mined" && x.nonce !== null ? lock : null;
  const minted = mint?.stage === "mined" ? mint : null;
  // Minted by a transaction older than the destination's nodes search (sends.ts, finishBeyond).
  const beyond = !minted && x.mintBeyond !== undefined;
  // Stopped before the lock is on chain: not sent, or reverted.
  const early = failure !== null && locked === null;
  const sub = x.sender.kind === "substrate" ? x.sender : null;

  const L = step("lock", "Lock on Portaldot V3", TRUST.lock);
  if (lock.stage !== "asking") L.tx = { hash: lock.hash, href: lock.stage === "mined" ? nodeConsoleBlock(lock.block) : undefined, label: sub ? "lock extrinsic" : "lock transaction" };
  if (early) {
    L.st = "failed";
    if (failure.reason === "reverted") L.title = sub ? "Lock failed" : "Lock reverted";
    else if (failure.reason !== "stopped") L.title = "Lock not sent";
  } else if (lock.stage === "asking") {
    L.st = note && !note.wallet ? "active" : "needs";
    L.sub = note?.text ?? `Confirm the lock in ${sub ? sub.walletName : "your wallet"}`;
  } else if (!locked) {
    activeFrom(L, x.startedAt, MEASURED?.lock, now);
    L.sub = note?.text ?? "Sent · waiting for a V3 block";
  } else {
    L.st = "done";
    L.sub = `${amt} tPOT locked in V3 block #${num(locked.block)} · nonce ${x.nonce}`;
    // Finish mint: the lock came before this page, so it is not timed.
    if (!x.resumed) L.time = span(x.startedAt, locked.minedAt);
  }

  const F = step("final", "V3 finality", TRUST.final);
  if (fin) {
    F.st = "done";
    F.sub = finalLine(fin);
    F.link = { href: nodeConsoleBlock(fin.block), text: `#${num(fin.block)}` };
    if (locked && !x.resumed) F.time = span(locked.minedAt, fin.at);
  } else if (minted || beyond) {
    F.st = "done";
    F.sub = "Final · the mint proved the lock";
  } else if (locked) {
    activeFrom(F, locked.minedAt, MEASURED?.finality, now);
    F.sub = `GRANDPA is finalizing #${num(locked.block)}${MEASURED ? ` · usually ${MEASURED.finality} s` : ""}`;
  } else F.sub = "Waits for 2 of 2 V3 validators";

  const P = step("proof", "Proof built in your browser", TRUST.proof);
  const checks = x.proof.checks;
  if (failure?.reason === "proof") {
    P.st = "failed";
    P.title = "Proof didn't check out";
  } else if (failure?.reason === "blocked") {
    P.st = "failed";
    P.title = "Mint blocked";
  } else if (CHECKS.every((c) => checks[c.key] === "passed")) {
    P.st = "done";
    P.sub = (minted || beyond) && x.proof.builtAt === null ? "5 of 5 checked on chain by the mint" : `5 of 5 checks passed · dry run of ${route ? DRY[route.path] : "the mint"} passed`;
    if (fin && x.proof.builtAt !== null) P.time = span(fin.at, x.proof.builtAt);
  } else if (fin) {
    activeFrom(P, fin.at, MEASURED?.proofs, now);
    const k = CHECKS.find((c) => checks[c.key] === "checking")?.key ?? CHECKS.find((c) => checks[c.key] !== "passed")?.key ?? "nonce";
    P.sub = note && !mint ? note.text : proofLine(k, fin.block, null, "the mint", d.short);
  } else P.sub = `${MEASURED ? `≈ ${MEASURED.proofs} s · ` : ""}7 requests to V3`;

  const M = step("mint", `Mint on ${d.short}`, TRUST.mint);
  let needs: TxState["needs"] = null;
  let stuck: TxState["stuck"] = null;
  let offer: TxState["offer"] = null;
  const built = x.proof.builtAt ?? now;
  const of = route && route.steps > 1 ? ` ${route.step} of ${route.steps}` : "";
  const gas = route?.gas != null ? `≈ ${gasText(route.gas)} gas` : `≈ ${mintGasText(d, behind)} M gas`;
  // On a rollup, the relayer's run after a V3 set change that auto-mint waits for (handoff.ts), by the clock.
  const wait = locked ? relayWait(d.key, locked.minedAt) : null;
  // Auto-mint's mint, or the visitor's own (handoff.ts), from the lock's V3 block and the run it waits for; before the lock is on V3, by its amount and its sender.
  const kind = x.sender.kind;
  const handoff = locked ? handoffOf(x.amount, kind, locked.minedAt, now, x.autoPending, wait) : autoMints(x.amount, kind) ? null : ({ kind: "self" } as const);
  const theirs = locked ? handoff?.kind !== "self" : autoMints(x.amount, kind);
  if (mint && mint.stage !== "asking") M.tx = { hash: mint.hash, href: explorerTx(d, mint.hash), label: "mint transaction" };
  if (minted) {
    M.st = "done";
    M.sub = `${amt} wtPOT minted · ${d.short} #${num(minted.block)}${x.mintBy ? mintedBy(x.mintBy, evm) : minted.gasUsed !== null ? ` · ${num(minted.gasUsed)} gas` : ""}`;
    if (x.proof.builtAt !== null) M.time = span(x.proof.builtAt, minted.minedAt);
  } else if (beyond) {
    M.st = "done";
    M.sub = [{ nb: `${amt} wtPOT minted on ${d.short}` }, " · ", { nb: "its transaction is older" }, " ", { nb: "than the nodes here search" }];
    M.link = { href: `${explorerAddress(d, deployed(d).minter)}#events`, text: `BridgeMinter's events on ${d.explorer.name}` };
  } else if (failure?.reason === "refused" && locked) {
    // The mint's own check refused it (the destination's ETH for its gas): the lock stays.
    M.st = "failed";
    M.title = "Mint not sent";
  } else if (P.st !== "done" || failure) M.sub = theirs && !mint ? `Auto-mint, ${auto[0]} after your lock · nothing to sign` : `${sub ? "Your Ethereum wallet" : "Your wallet"}, on ${d.short} · ${gas}`;
  else if (!mint) {
    if (note) {
      // Switching the wallet's network, or checking the plan again before the wallet asks.
      M.st = note.wallet ? "needs" : "active";
      M.sub = note.text;
    } else if (handoff?.kind === "waiting" || handoff?.kind === "pending") {
      M.st = "active";
      M.p = locked ? handoffProgress(locked.minedAt, now, mintDue(d, locked.minedAt)) : 0;
      // Pending: auto-mint's key has a transaction the chain has not mined, this lock's mint or another's
      // it sends first (one at a time): the page cannot tell which, so it says only that.
      M.sub =
        handoff.kind === "pending"
          ? [{ nb: "Auto-mint has a transaction waiting" }, " ", { nb: `on ${d.short}` }, " · ", { nb: "yours may be queued behind it" }, " · ", { nb: "nothing to sign" }]
          : wait
            ? waitLine(wait, d, now)
            : behind > 0
              ? behindLine(d, behind)
              : [{ nb: "Auto-mint sends it for you" }, " · ", { nb: `usually ${auto[0]} after your lock` }, " · ", { nb: "nothing to sign" }];
    } else if (handoff?.kind === "offer") {
      M.st = "needs";
      M.sub = behind > 0 ? "Auto-mint waits for the relayer · you can send the mint" : "Auto-mint hasn't minted it yet · you can send the mint";
      needs = evm
        ? { action: "Mint it yourself", note: `Your wallet asks for the mint on ${d.short}, ${mintCost(d, behind)}. It pays ${short(checksum(x.recipient))}.` }
        : { action: "Connect an Ethereum wallet to mint", note: `Any Ethereum wallet with ${d.short} ETH can send the mint: it pays the lock's recipient, whoever sends it.` };
      offer = offerOf(x.recipient, d, behind, wait);
    } else {
      M.st = "needs";
      M.sub = route ? `${route.title} · ${gas}` : needsOn(d).action;
      // A Polkadot wallet's lock is minted from an Ethereum wallet: connected first.
      needs =
        sub && !evm
          ? { action: "Connect an Ethereum wallet to mint", note: `Any Ethereum wallet with ${d.short} ETH can send the mint, ${gas}: it pays ${short(checksum(x.recipient))}, whoever sends it.` }
          : needsOf(route, d);
    }
  } else if (mint.stage === "asking") {
    M.st = "needs";
    M.sub = `Confirm${of || " the mint"} in your wallet · ${gas}`;
  } else if (now - mint.sentAt >= STUCK_AFTER) {
    M.st = "stuck";
    M.p = 0.9;
    M.sub = `Not mined yet · sent ${Math.floor((now - mint.sentAt) / 60_000)} min ago`;
    stuck = STUCK;
  } else {
    activeFrom(M, built, MEASURED?.mint, now);
    M.sub = note?.text ?? `Sent${of} · waiting for the receipt${MEASURED ? ` · usually ${MEASURED.mint} s` : ""}`;
  }

  const end = x.doneAt ?? failure?.at ?? minted?.minedAt ?? now;
  return {
    steps: [L, F, P, M],
    t: Math.max(0, (end - x.startedAt) / 1000),
    done: minted !== null || beyond,
    needs,
    failed: failure ? failedOf(failure, "in", locked !== null, d) : null,
    stuck,
    offer,
    checks,
    members: NO_MEMBERS,
  };
}

/**
 * The fast confirmations as the card counts them: `c` of the chain's `n` (3 on Sepolia, 180 or 144
 * on a rollup), drawn as three dots, each a third of them.
 */
function confsStep(x: Step, d: Dest, block: number, c: number, qualified: boolean): void {
  const n = d.fastConfirmations;
  const k = qualified ? n : Math.min(n, Math.max(0, c));
  x.st = qualified ? "done" : "active";
  x.p = k / n;
  x.count = Math.floor((3 * k) / n);
  x.sub = qualified ? `${n} of ${n} · ${d.short} #${num(block + n)} · the watcher checks every 15 s` : `${num(k)} of ${n} · about ${d.blockSeconds} s each`;
  x.link = { href: explorerBlock(d, block + k), text: `#${num(block + k)}` };
}

function liveBack(x: BurnTransfer, now: number): TxState {
  const amt = fmt(toTokens(x.amount));
  const d = destOf(x.dest);
  const TRUST = trustOf(d);
  const { burn, depth, release, failure, note } = x;
  const fast = x.speed === "fast";
  const burned = burn.stage === "mined" && x.burnNonce !== null ? burn : null;

  const B = step("burn", `Burn on ${d.short}`, TRUST.burn);
  if (burn.stage !== "asking") B.tx = { hash: burn.hash, href: explorerTx(d, burn.hash), label: "burn transaction" };
  if (failure && !burned) {
    B.st = "failed";
    if (failure.reason === "reverted") B.title = "Burn reverted";
    else if (failure.reason !== "stopped") B.title = "Burn not sent";
  } else if (burn.stage === "asking") {
    B.st = note && !note.wallet ? "active" : "needs";
    B.sub = note?.text ?? "Confirm the burn in your wallet";
  } else if (!burned) {
    // Burn 1's block came 24 s after sending on Sepolia; a rollup's in about a second.
    activeFrom(B, x.startedAt, d.key !== "sepolia" ? 2 : fast ? FAST_RUN.mined : STD_MINED, now);
    B.sub = note?.text ?? `Sent · waiting for a ${d.short} block`;
  } else {
    B.st = "done";
    B.sub = `${amt} wtPOT burned in ${d.short} block #${num(burned.block)}`;
    // As on the recorded runs, only Fast times the burn: from sending to its block.
    if (fast) B.time = secs(Math.max(0, (burned.minedAt - x.startedAt) / 1000));
  }

  const qualified = depth.qualifiedAt !== null || (fast ? depth.confirmations >= d.fastConfirmations : depth.final);
  let mid: Step;
  if (fast) {
    mid = step("confs", `${d.fastConfirmations} confirmations`, TRUST.confs);
    mid.keep = true;
    if (!burned) mid.sub = "Then the watcher, every 15 s, qualifies the burn";
    else confsStep(mid, d, burned.block, depth.confirmations, qualified);
  } else {
    mid = step("finality", `${d.short} finality`, TRUST.finality);
    const fb = x.fallback ? "Fast budget in use, waiting for finality · " : "";
    if (!burned) mid.sub = finalityAhead(fb, d);
    else if (qualified) {
      mid.st = "done";
      mid.sub = `Final · ${d.short} finalized past #${num(burned.block)}`;
      if (depth.qualifiedAt !== null) mid.time = span(burned.minedAt, depth.qualifiedAt);
    } else {
      const blocks = Math.min(d.finality.blocks, Math.max(0, depth.confirmations));
      mid.st = "active";
      mid.p = blocks / d.finality.blocks;
      mid.bar = mid.p;
      mid.sub = liveCountdown(fb, blocks, d);
    }
  }

  const R = step("release", "Committee release on V3", TRUST.release);
  const run = release.run;
  const a = release.released ? 2 : Math.min(2, Math.max(0, release.approvals));
  if (release.released) {
    R.st = "done";
    R.approvals = 2;
    const after = fast && burned && release.at !== null ? Math.max(0, Math.round((release.at - burned.minedAt) / 1000)) : null;
    const to = short(checksum(x.recipient));
    R.sub = run
      ? `${amt} tPOT paid to ${to} · V3 #${num(run.block)}${after !== null ? ` · ${after} s after the burn's block` : ""}`
      : `${amt} tPOT released to ${to} · released(burnId) is true on V3`;
    if (run) R.tx = { hash: run.extrinsic, href: nodeConsoleBlock(run.block), label: "release extrinsic" };
    if (after !== null) R.time = secs(after);
    else if (!fast && depth.qualifiedAt !== null && release.at !== null) R.time = span(depth.qualifiedAt, release.at);
  } else if (burned && qualified) {
    activeFrom(R, depth.qualifiedAt ?? now, fast ? FAST_RUN.ran - FAST_RUN.mined - 3 * BLOCK_S : 60, now);
    R.approvals = a;
    // The watcher runs on one machine: a burn it has not picked up after a few minutes says so, rather than look under way.
    R.sub =
      a === 0 && now - (depth.qualifiedAt ?? now) > SLOW_RELEASE
        ? "0 of 2 approvals · not picked up yet: the committee's watcher runs on one machine, and releases wait while it is off"
        : approvalLine(a, release.open?.block ?? null);
  } else R.sub = releaseAhead(fast, d);

  const members: MemberState[] = [a >= 1 ? "approved" : R.st === "active" ? "waiting" : "idle", a >= 2 ? "approved" : "idle", "idle"];
  const end = x.doneAt ?? failure?.at ?? (release.released ? release.at : null) ?? now;
  return {
    steps: [B, mid, R],
    t: Math.max(0, (end - x.startedAt) / 1000),
    done: release.released,
    needs: null,
    failed: failure ? failedOf(failure, "back", burned !== null, d) : null,
    stuck: null,
    offer: null,
    checks: waitingChecks(),
    members,
  };
}

// ---------------------------------------------------------------------------------------------
// A lock or a burn this tab does not follow, as the chains tell it now. A done one's page is its
// receipt, so these are a lock not minted yet and a burn not released yet. Its clock runs from its
// block's time: when it was sent is not on chain.

/** Done on the chains: minted, or released. */
const chainDone = (x: ChainTransfer): boolean => (x.dir === "in" ? x.minted === true : x.released === true);

/** Seconds from a block's time to now, for the card's clock. */
const elapsed = (at: number | null, now: number): number | null => (at === null ? null : Math.max(0, (now - at) / 1000));

function chainHead(x: ChainTransfer, id: string): Head {
  const d = destOf(x.dest);
  return {
    dest: x.dest,
    mode: x.dir === "in" ? "in" : watcherSpeed(x.amount),
    amount: toTokens(x.amount),
    amountText: amountText(x.amount),
    label: x.dir === "in" ? `Lock ${x.nonce}` : d.key === "sepolia" ? `Burn ${x.n}` : `Burn ${x.n} on ${d.short}`,
    fallback: false,
    replayWhen: null,
    note:
      x.dir === "in"
        ? `Read live: the vault's Locked log on V3, and used(${x.nonce}) on ${d.short}.`
        : `Read live: BridgeMinter's BurnRequested log on ${d.short}, and released(burnId) on V3.`,
    cardNote: null,
    receipt: `#/receipt/${id}`,
    facts: NO_FACTS,
    // Read from V3's EVM logs: an Ethereum wallet's lock.
    auto: x.dir === "in" && autoMints(x.amount, "evm"),
    waitText: null,
    usual: x.dir === "in" && x.at !== null && autoMints(x.amount, "evm") ? usualOf(d, x.at, x.at) : null,
  };
}

/** `evm`: the connected Ethereum wallet's address, which can send the mint, or null. `behind`: as for liveIn. */
function chainIn(x: ChainLock, now: number, evm: string | null, behind: number): TxState {
  const amt = fmt(toTokens(x.amount));
  const d = destOf(x.dest);
  const TRUST = trustOf(d);
  const auto = timeOf(d.key, "auto");
  const L = step("lock", "Lock on Portaldot V3", TRUST.lock);
  L.st = "done";
  L.sub = `${amt} tPOT locked in V3 block #${num(x.block)} · nonce ${x.nonce}`;
  L.tx = { hash: x.tx, href: nodeConsoleBlock(x.block), label: "lock transaction" };

  // V3's finalized head says whether the lock's block is final, not when, nor with which signatures.
  const F = step("final", "V3 finality", TRUST.final);
  if (x.final === true) {
    F.st = "done";
    F.sub = `Final · V3 finalized past #${num(x.block)}`;
  } else if (x.final === false) {
    activeFrom(F, x.at ?? now, MEASURED?.finality, now);
    F.sub = `GRANDPA is finalizing #${num(x.block)}${MEASURED ? ` · usually ${MEASURED.finality} s` : ""}`;
  } else {
    F.st = "active";
    F.sub = "Could not read V3's finalized head";
  }

  // The proof is built when the mint is finished, at the latest finalized block: the next step is the visitor's.
  const P = step("proof", "Proof built in your browser", TRUST.proof);
  P.sub = `${MEASURED ? `≈ ${MEASURED.proofs} s · ` : ""}7 requests to V3`;

  const M = step("mint", `Mint on ${d.short}`, TRUST.mint);
  let needs: TxState["needs"] = null;
  let offer: TxState["offer"] = null;
  // Auto-mint mints a lock of its minimum or more (handoff.ts): the visitor's own mint is offered when it has not, in time.
  // A lock read from V3's EVM logs is an Ethereum wallet's.
  const wait = x.at !== null ? relayWait(d.key, x.at) : null;
  const handoff =
    x.at !== null ? handoffOf(x.amount, "evm", x.at, now, false, wait) : autoMints(x.amount, "evm") ? ({ kind: "waiting", offerAt: now } as const) : ({ kind: "self" } as const);
  if (x.minted === null) M.sub = "Could not read whether it was minted";
  else if (x.final === true && handoff.kind === "waiting") {
    M.st = "active";
    M.p = x.at !== null ? handoffProgress(x.at, now, mintDue(d, x.at)) : 0;
    M.sub = wait
      ? waitLine(wait, d, now)
      : behind > 0
        ? behindLine(d, behind)
        : [{ nb: "Auto-mint sends it" }, " · ", { nb: `usually ${auto[0]} after the lock` }, " · ", { nb: "nothing to sign" }];
  } else if (x.final === true && handoff.kind === "offer") {
    M.st = "needs";
    M.sub = behind > 0 ? "Auto-mint waits for the relayer · you can send the mint" : "Auto-mint hasn't minted it yet · you can send the mint";
    needs = evm
      ? { action: "Mint it yourself", note: `Your wallet asks for the mint on ${d.short}, ${mintCost(d, behind)}. It pays ${short(checksum(x.recipient))}.` }
      : { action: "Connect an Ethereum wallet to mint", note: `Any Ethereum wallet with ${d.short} ETH can send the mint.` };
    offer = offerOf(x.recipient, d, behind, wait);
  } else if (x.final === true) {
    M.st = "needs";
    M.sub = needsOn(d).action;
    needs = needsOn(d);
  } else M.sub = handoff.kind === "self" ? `Your wallet, on ${d.short} · ≈ ${mintGasText(d, behind)} M gas` : `Auto-mint, ${auto[0]} after your lock · nothing to sign`;

  return { steps: [L, F, P, M], t: elapsed(x.at, now), done: false, needs, failed: null, stuck: null, offer, checks: waitingChecks(), members: NO_MEMBERS };
}

function chainBack(x: ChainBurn, now: number): TxState {
  const amt = fmt(toTokens(x.amount));
  const d = destOf(x.dest);
  const TRUST = trustOf(d);
  const fast = watcherSpeed(x.amount) === "fast";
  const B = step("burn", `Burn on ${d.short}`, TRUST.burn);
  B.st = "done";
  B.sub = `${amt} wtPOT burned in ${d.short} block #${num(x.block)}`;
  B.tx = { hash: x.tx, href: explorerTx(d, x.tx), label: "burn transaction" };

  const h = x.heads;
  const depth = h ? Math.max(0, h.latest - x.block) : 0;
  const final = h !== null && h.finalized >= x.block;
  const qualified = h !== null && (final || (fast && depth >= d.fastConfirmations));
  const mid = fast ? step("confs", `${d.fastConfirmations} confirmations`, TRUST.confs) : step("finality", `${d.short} finality`, TRUST.finality);
  mid.keep = fast;
  if (!h) {
    mid.st = "active";
    mid.sub = `Could not read ${d.short}'s head`;
  } else if (fast) {
    confsStep(mid, d, x.block, depth, qualified);
  } else if (final) {
    mid.st = "done";
    mid.sub = `Final · ${d.short} finalized past #${num(x.block)}`;
  } else {
    const blocks = Math.min(d.finality.blocks, depth);
    mid.st = "active";
    mid.p = blocks / d.finality.blocks;
    mid.bar = mid.p;
    mid.sub = liveCountdown("", blocks, d);
  }

  // The approvals are the committee's multisig on V3, which this page does not read: no dots, no members.
  const R = step("release", "Committee release on V3", TRUST.release);
  if (x.released === null) R.sub = "Could not read whether it was released";
  else if (qualified) {
    R.st = "active";
    R.sub = "Not released yet · nothing to sign";
  } else R.sub = releaseAhead(fast, d);

  return { steps: [B, mid, R], t: elapsed(x.at, now), done: false, needs: null, failed: null, stuck: null, offer: null, checks: waitingChecks(), members: NO_MEMBERS };
}

// ---------------------------------------------------------------------------------------------
// The card

/** What the live region says: the step under way and its line, or the last step done. */
function sayOf(s: TxState): string {
  const active = s.steps.find((x) => x.st !== "pending" && x.st !== "done");
  if (!active) return `${s.steps[s.steps.length - 1]?.title ?? "Transfer"} done`;
  const sub = lineText(active.sub);
  return sub ? `${active.title}: ${sub}` : active.title;
}

function nodeIcon(st: StepState) {
  if (st === "done") return <Icon id="i-check" />;
  if (st === "stuck") return <Icon id="i-clock" />;
  if (st === "failed") return <Icon id="i-x" />;
  return null;
}

function Dots({ n, on, trust = false }: { n: number; on: number; trust?: boolean }) {
  return (
    <div class={`dots3${trust ? " dots3--trust" : ""}`} aria-hidden="true">
      {Array.from({ length: n }, (_, k) => (
        <span key={k} class={k < on ? "on" : undefined} />
      ))}
    </div>
  );
}

/**
 * The action bar. On phones it is sticky above the tab bar and paints its backdrop only while it is
 * stuck over the content; a stuck bar's last pixel row sits on the root's shrunken bottom edge, so it
 * is never fully inside it.
 */
function ActBar({ pair = false, children }: { pair?: boolean; children: ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const tab = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--tabbar-h"), 10) || 64;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) setStuck(e.intersectionRatio < 1 && e.boundingClientRect.top > (e.rootBounds?.top ?? 0));
      },
      { threshold: [1], rootMargin: `0px 0px -${tab + 1}px 0px` },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div class={`actbar${pair ? " actbar--pair" : ""}${stuck ? " is-stuck" : ""}`} ref={ref}>
      {children}
    </div>
  );
}

function Foot({ h, s, asking, onAct }: { h: Head; s: TxState; asking: boolean; onAct: (a: TransferAction) => void }) {
  const inDir = h.mode === "in";
  const d = destOf(h.dest);
  if (s.failed) {
    // Nothing on chain yet: the amount can still change.
    const change = s.failed.change;
    return (
      <>
        <div class="notice notice--revert" role="alert">
          <Icon id="i-alert" />
          <div>
            <p class="notice__title">{s.failed.title}</p>
            <p>{s.failed.text}</p>
          </div>
        </div>
        <ActBar pair={change}>
          {change ? (
            <a class="btn btn--secondary btn--lg" href={`#/bridge/${inDir ? "in" : "back"}?amount=${h.amountText}${h.dest === "sepolia" ? "" : `&dest=${h.dest}`}`}>
              Change amount
            </a>
          ) : null}
          <button class="btn btn--primary btn--lg btn--block" type="button" onClick={() => onAct("retry")}>
            <Icon id="i-refresh" />
            <span>{s.failed.action}</span>
          </button>
        </ActBar>
      </>
    );
  }
  if (s.needs) {
    return (
      <>
        {s.offer ? (
          <div class="notice notice--trust">
            <Icon id="i-clock" />
            <div>
              <p class="notice__title">{s.offer.title}</p>
              <p>{s.offer.text}</p>
            </div>
          </div>
        ) : null}
        <ActBar>
          <button class="btn btn--primary btn--lg btn--block" type="button" onClick={() => onAct("sign")}>
            <span>{s.needs.action}</span>
          </button>
        </ActBar>
        <p class="bridge__hint">{s.needs.note}</p>
      </>
    );
  }
  if (s.stuck) {
    return (
      <>
        <div class="notice notice--trust">
          <Icon id="i-clock" />
          <div>
            <p class="notice__title">The mint is not mined yet</p>
            <p>{d.short} has not picked it up in 5 min, usually because the fee is low. Your tPOT stays locked for you either way.</p>
          </div>
        </div>
        <ActBar>
          <button class="btn btn--primary btn--lg btn--block" type="button" onClick={() => onAct("speedUp")}>
            <span>{s.stuck.action}</span>
          </button>
        </ActBar>
        <p class="bridge__hint">{s.stuck.note}</p>
      </>
    );
  }
  if (asking) {
    return (
      <p class="txcard__close txcard__close--ask">
        <Icon id="i-wallet" cls="i--14" />
        <span>Your wallet is asking you to confirm. Don't see it? Open your wallet; the request waits there.</span>
      </p>
    );
  }
  if (s.done) {
    return (
      <a class="btn btn--primary btn--lg btn--block" href={h.receipt}>
        <span>View receipt</span>
        <Icon id="i-arrow-right" />
      </a>
    );
  }
  // The first step is the lock or the burn: until it is mined, nothing is locked or burned yet, and
  // before the wallet sends it, closing the page sends nothing.
  const first = s.steps[0];
  const what = inDir ? "lock" : "burn";
  const where = inDir ? "V3" : d.short;
  const text =
    first?.st === "done"
      ? inDir
        ? (h.waitText ?? "You can close this page. Your tPOT stays locked for you, and Activity can finish the mint on any device.")
        : `You can close this page. The burn is on ${d.short}; the release is up to the committee.`
      : first?.tx
        ? `Sent, not on ${where} yet: this page follows the ${what} until a block takes it, and again when you come back.`
        : `Nothing is on ${where} yet. Keep this page open until your wallet has sent the ${what}.`;
  return (
    <p class="txcard__close">
      <Icon id="i-info" cls="i--14" />
      <span>{text}</span>
    </p>
  );
}

/** A chain's name in the card's title on a small phone: a rollup's first word ("Base", "Arbitrum"), as its chain button shows it. */
const tightName = (c: ChainInfo): string => (c.key === "v3" || c.key === "sepolia" ? c.short : c.name);

function TxScreen({ h, s, onAct }: { h: Head; s: TxState; onAct: (a: TransferAction) => void }) {
  const dir: Dir = h.mode === "in" ? "in" : "back";
  const d = destOf(h.dest);
  const from = fromOf(dir, h.dest);
  const to = toOf(dir, h.dest);
  const T = h.usual ?? timeOf(h.dest, h.auto ? "auto" : h.mode);
  // Its source kept on one line: on a phone the relayer's run wraps whole, not its "UTC".
  const usual = (
    <>
      {`${h.mode === "in" ? "" : `${h.fallback ? "Standard (fallback)" : SPEED_NAME[h.mode]} · `}usually ${T[0]} · `}
      <Nb>{T[1]}</Nb>
    </>
  );
  const [mm, ss] = s.t === null ? ["–", "––"] : clock(s.t).split(":");
  const asking = s.steps.some((x) => x.st === "needs") && !s.needs;

  // Step changes are said once in the polite live region: when the step under way changes.
  const say = sayOf(s);
  const topic = say.split(":")[0];
  useEffect(() => announce(say), [topic]);

  const chip = s.failed ? (
    <Chip kind="revert" cls="badge--sm" icon="i-alert">
      Needs attention
    </Chip>
  ) : asking ? (
    <Chip kind="needs" cls="badge--sm" icon="dot">
      Confirm in wallet
    </Chip>
  ) : s.needs ? (
    <Chip kind="needs" cls="badge--sm" icon="dot">
      Needs you
    </Chip>
  ) : s.stuck ? (
    <Chip kind="trusted" cls="badge--sm" icon="i-clock">
      Not mined yet
    </Chip>
  ) : s.done ? (
    dir === "in" ? (
      <Chip kind="verified" cls="badge--sm" icon="i-check">
        Minted
      </Chip>
    ) : (
      <Chip kind="trusted" cls="badge--sm" icon="i-users">
        Released
      </Chip>
    )
  ) : (
    <Chip kind="progress" cls="badge--sm" icon="dot">
      In progress
    </Chip>
  );

  return (
    <div class="stage stage--tx" data-dir={dir}>
      <section class="intro intro--tx" aria-labelledby="tx-title">
        <a class="back-link" href={h.replayWhen !== null ? `#/bridge/${dir}` : "#/activity"}>
          <Icon id="i-arrow-left" cls="i--16" />
          {h.replayWhen !== null ? "Bridge" : "Activity"}
        </a>
        <p class="intro__eyebrow">
          <span class="intro__dot" aria-hidden="true" />
          {h.label}
        </p>
        <h1 class="intro__title intro__title--tx" id="tx-title">
          {fmt(h.amount)} {from.token} <span class="intro__arrow" aria-hidden="true">→</span>
          <span class="visually-hidden"> to </span> {to.short}
        </h1>
        {h.replayWhen !== null ? (
          <p class="replay-note">
            <Icon id="i-play" cls="i--14" />A replay of the recorded run, {h.replayWhen}. Same transactions, same timings.
          </p>
        ) : h.note !== null ? (
          <p class="replay-note replay-note--sample">
            <Icon id="i-info" cls="i--14" />
            {h.note}
          </p>
        ) : null}
        <div class="side" id="tx-side">
          {h.mode === "in" ? (
            <ChecksPanel states={s.checks} receipt={false} facts={h.facts} chain={d.short} />
          ) : (
            <TrustPanel speed={h.mode} fallback={h.fallback} members={s.members} d={d} />
          )}
        </div>
      </section>

      <section class="card card--lit txcard" aria-labelledby="tx-title">
        <div class="txcard__head">
          <span class="pairmark" aria-hidden="true">
            <ChainMark mark={from.mark} cls="mark--32" />
            <ChainMark mark={to.mark} cls="mark--32" />
          </span>
          <div class="txcard__titles">
            {h.dest === "sepolia" ? (
              <p class="txcard__title">
                {from.short} → {to.short}
              </p>
            ) : (
              // A rollup's name is long beside the status chip on a small phone: there the chain button's first word.
              <p class="txcard__title">
                <span class="txcard__wide">
                  {from.short} → {to.short}
                </span>
                <span class="txcard__tight">
                  {tightName(from)} → {tightName(to)}
                </span>
              </p>
            )}
            <p class="txcard__sub">
              {h.mode === "in" ? (
                "Verified by the light client"
              ) : (
                <>
                  Trusted{h.fallback ? null : <span class="txcard__long"> · 2-of-3 committee</span>} · {h.fallback ? "Standard (fallback)" : SPEED_NAME[h.mode]}
                </>
              )}
            </p>
          </div>
          <span id="tx-chip">{chip}</span>
        </div>
        <div class="txclock">
          <span class="txclock__num" id="tx-clock">
            {mm}
            <span class="txclock__colon">:</span>
            {ss}
          </span>
          <span class="txclock__usual">{usual}</span>
        </div>
        {h.fallback ? (
          <p class="notice notice--lilac txcard__note">
            <Icon id="i-info" />
            <span>Other fast burns were in flight, so yours is released the standard way. Nothing to do.</span>
          </p>
        ) : null}
        {h.cardNote ? (
          <p class="notice notice--lilac txcard__note">
            <Icon id="i-info" />
            <span>{h.cardNote}</span>
          </p>
        ) : null}
        <div class="progress txprog" id="tx-prog" aria-hidden="true">
          {s.steps.map((x) => (
            <CssSpan
              key={x.key}
              cls={`progress__seg${x.st === "done" ? " is-done" : ""}${x.trust[0] === "trust" ? " is-trusted" : ""}${x.st === "failed" ? " is-failed" : ""}`}
              prop="--fill"
              value={`${x.st === "done" ? 100 : Math.round(x.p * 100)}%`}
            />
          ))}
        </div>
        <ol class="tl" id="tx-steps" aria-live="off">
          {s.steps.map((x) => {
            const trusted = x.trust[0] === "trust";
            // A failed step names itself; the reason is said once, in the card's foot.
            const showTrust = x.st !== "pending" && x.st !== "failed";
            return (
              <li key={x.key} class={`tl__step is-${x.st}${trusted ? " is-trusted" : ""}${x.keep ? " keeps-trust" : ""}`}>
                <span class="tl__node">{x.st === "active" ? <span class="tl__spin" aria-hidden="true" /> : nodeIcon(x.st)}</span>
                <div class="tl__body">
                  <div class="tl__top">
                    <p class="tl__title">{x.title}</p>
                    <span class="tl__time">{x.time}</span>
                  </div>
                  {lineText(x.sub) ? (
                    <p class="tl__sub">
                      <LineView l={x.sub} />
                    </p>
                  ) : null}
                  {x.tx ? (
                    <div class="tl__row">
                      <Addr full={x.tx.hash} href={x.tx.href} label={x.tx.label} cls="addr--tx" />
                    </div>
                  ) : x.link ? (
                    <div class="tl__row">
                      <a class="tl__link" href={x.link.href} target="_blank" rel="noopener">
                        {x.link.text}
                        <Icon id="i-external" cls="i--12" />
                      </a>
                    </div>
                  ) : null}
                  {x.count !== null ? <Dots n={3} on={x.count} /> : null}
                  {x.bar !== null ? (
                    <div class="tl__bar">
                      <CssSpan prop="--fill" value={`${Math.round(x.bar * 100)}%`} />
                    </div>
                  ) : null}
                  {x.approvals !== null && x.st !== "pending" ? <Dots n={2} on={x.approvals} trust /> : null}
                  {showTrust ? (
                    <p class={`tl__trust tl__trust--${x.trust[0]}`}>
                      <Icon id={trusted ? "i-users" : "i-shield-check"} cls="i--14" />
                      <span class="tl__trust-long">{x.trust[1]}</span>
                      {x.trust[2] ? <span class="tl__trust-short">{x.trust[2]}</span> : null}
                    </p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
        <div class={`txcard__foot${s.failed || s.needs || s.stuck ? " txcard__foot--act" : ""}`} id="tx-foot">
          <Foot h={h} s={s} asking={asking} onAct={onAct} />
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The clock

/** When each replay started on this page's clock: a replay goes on where it was when its page opens again. */
const replayStarts = new Map<string, number>();
/** The transfers whose card has moved on to the receipt: it moves on once. */
const finished = new Set<string>();

function useTick(ms: number, on: boolean): void {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => bump((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms, on]);
}

/** Moves on to the receipt 1.6 s after the last step, once, unless the visitor has left the page. */
function useFinish(key: string, done: boolean, href: string): void {
  useEffect(() => {
    if (!done || finished.has(key)) return;
    finished.add(key);
    const t = setTimeout(() => {
      location.hash = href;
    }, 1600);
    return () => clearTimeout(t);
  }, [done, key, href]);
}

function ReplayTx({ replay }: { replay: Replay }) {
  const key = replay.dir === "in" ? "replay-in" : `replay-back:${replay.speed}`;
  const [start] = useState(() => {
    const s = replayStarts.get(key) ?? performance.now();
    replayStarts.set(key, s);
    return s;
  });
  const total = replay.plan.total;
  const t = Math.min(total, (performance.now() - start) / 1000);
  const done = t >= total;
  useTick(200, !done);
  const h = replayHead(replay);
  useFinish(key, done, h.receipt);
  const s = replay.dir === "in" ? replayIn(replay.run, replay.plan, t) : replayBack(replay.run, replay.speed, replay.plan, t);
  return <TxScreen h={h} s={s} onAct={() => undefined} />;
}

/** The card's buttons: the code that sends handles them (sends.ts registers them when the app starts). */
const actOn = (id: string) => (a: TransferAction) => {
  const run = transferActions[a];
  if (run) run(id);
  else toast("info", "Not ready yet", "The page is still starting: try again in a moment.");
};

/** The connected Ethereum wallet's address, which can send a mint, or null. */
function useEvm(): string | null {
  const w = useBox(wallet);
  return w.status === "on" && w.address ? w.address : null;
}

/** The validator-set changes the light client on `dest` reads behind V3, when `net` is that chain's status (App.tsx gives the transfer's own). */
const behindOn = (net: NetState, dest: DestKey): number => (net.dest === dest && net.key === "relay" ? net.behind : 0);

function LiveTx({ x, net }: { x: LiveTransfer; net: NetState }) {
  const done = isDone(x);
  const evm = useEvm();
  useTick(1000, !done && x.failure === null);
  const now = Date.now();
  const s = x.dir === "in" ? liveIn(x, now, evm, behindOn(net, x.dest)) : liveBack(x, now);
  const h = liveHead(x);
  useFinish(x.id, done, h.receipt);
  return <TxScreen h={h} s={s} onAct={actOn(x.id)} />;
}

/** A lock or a burn read from the chains: read again every 15 s until it is done, then its receipt. */
function ChainTx({ id, net }: { id: string; net: NetState }) {
  const read = useChainRead(id, chainDone);
  const evm = useEvm();
  const x = read.state === "live" ? read.value : null;
  useTick(1000, x !== null && x.at !== null && !chainDone(x));
  if (read.state === "none") return <NotFound what="transfer" id={id} />;
  if (!x) return <ChainWait id={id} read={read} />;
  if (chainDone(x)) return <Redirect to={`#/receipt/${id}`} />;
  const now = Date.now();
  return <TxScreen h={chainHead(x, id)} s={x.dir === "in" ? chainIn(x, now, evm, behindOn(net, x.dest)) : chainBack(x, now)} onAct={actOn(id)} />;
}

/** `net`: the status of the light client on this transfer's destination, as the top bar shows it (App.tsx). */
export function TxView({ route, net }: { route: Route; net: NetState }) {
  const id = route.parts[1] ?? "";
  const live = useBox(transfers).get(id);
  if (live) return <LiveTx key={id} x={live} net={net} />;
  // A lock or a burn this browser follows: its page is the live transfer, with its own times.
  const follower = followerOf(id);
  if (follower) return <Redirect to={`#/tx/${follower.id}`} />;
  const replay = replayOf(id, route.q.get("speed"));
  if (replay) return <ReplayTx key={replay.dir === "in" ? "in" : replay.speed} replay={replay} />;
  // A recorded run is done: its page is the receipt.
  if (recordedOf(id)) return <Redirect to={`#/receipt/${id}`} />;
  // Any other lock or burn is read from its chain: Activity lists a connected wallet's own.
  if (nonceOf(id)) return <ChainTx key={id} id={id} net={net} />;
  return <NotFound what="transfer" id={id} />;
}
