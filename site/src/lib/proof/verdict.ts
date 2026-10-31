// What a Verify run shows, apart from the checks themselves (./verify.ts), which the page loads only
// when it runs one: the steps and their states, the evidence rows and cross-check lines, the raw
// data, and the verdict. The page draws a run's card from these before the checks arrive.

import type { Hex } from "../hex.ts";

export type StepKey = "header" | "keys" | "sigs" | "proof" | "commit" | "accepted" | "burn" | "burnId" | "released" | "release";

/**
 * waiting, checking, passed, failed; skipped: not checked (a node did not answer, an input is
 * missing); unreached: after a failed step; trusted: the committee's release, never passed; open:
 * a neutral outcome (not released on V3 yet).
 */
export type StepState = "waiting" | "checking" | "passed" | "failed" | "skipped" | "unreached" | "trusted" | "open";

/**
 * A value of an evidence row: words, a mono figure, a hash or an address (copy, and its explorer
 * when it has one), a small tag (auto-mint), or where a value comes from when it is not the step's
 * own reads (recorded, not served).
 */
export type Val =
  | { t: "text"; text: string }
  | { t: "mono"; text: string }
  | { t: "hash"; full: string; label: string; href: string | null }
  | { t: "tag"; text: string }
  | { t: "src"; kind: "read" | "recorded" | "missing"; text: string };

/** An evidence row: a label and its value. `wide`: a long value, under its label on a phone. */
export interface Ev {
  k: string;
  v: Val[];
  wide?: boolean;
}

/** A cross-check: true when it agrees, false when it does not (red), null when it could not be made (not answered, not served). */
export interface Line {
  ok: boolean | null;
  text: string;
}

/** One block of raw data, and the call that gave it. */
export interface Raw {
  label: string;
  call: string;
  value: string;
}

export interface Step {
  key: StepKey;
  title: string;
  state: StepState;
  /** What the check itself took in this browser (the hash, the signatures, the walk), its reads apart; null for a step that compares what it read. */
  ms: number | null;
  /** The one-line result, or why it failed or was not checked. */
  sub: string;
  /** A failure's expected and found values. */
  diff: { expected: string; found: string } | null;
  ev: Ev[];
  lines: Line[];
  trust: { kind: "verify" | "trust"; text: string } | null;
  raw: Raw[];
  /** The nodes whose answers the step read just now, by name: "Read now · publicnode, tenderly". */
  from: string[];
  /** Not checked because a node did not answer: the page offers Try again. */
  retry: boolean;
}

/** What the page's commands and panels need ("Check it without this page", "Where the keys come from"), filled in as the run reads it. */
export interface Facts {
  block: { number: number; hash: Hex } | null;
  setId: bigint | null;
  /**
   * The light client's checkpoint, its set 0: the set id, the V3 block it started at, its keys hash
   * and their number, the set changes the client imported since and the set they reached (null when
   * authoritySetCount was not answered), and whether the set that signed holds the checkpoint's keys.
   */
  checkpoint: { setId: bigint; at: number; keysHash: Hex; keys: number; changes: number | null; latest: bigint | null; same: boolean } | null;
  /** Set changes V3 made after the client's latest set, each checked here, through which the keys were carried to the set that signed. */
  carried: number;
  /** The light client's admin() as read just now: the key that installed the checkpoint and can pause the client. */
  admin: Hex | null;
  header: Hex | null;
  /** The mint's transaction and sender; `data`, the mint's own call when it went through Multicall3, which a replay sends to the minter. */
  mint: { tx: Hex; from: Hex | null; data: Hex | null } | null;
  /** The lock's vault nonce, or on the way back the burn's nonce. */
  nonce: bigint | null;
  burnId: Hex | null;
}

export interface Run {
  dir: "in" | "back";
  /**
   * minted: checked from the mint the destination took. unminted: from a proof read from V3 now.
   * fallback: minted, and no RPC serves its mint transaction (or it is older than the nodes search):
   * from a proof read from V3 now, the destination's dry run stopping at the nonce.
   */
  route: "minted" | "unminted" | "fallback";
  steps: Step[];
  done: boolean;
  /** Since the run started. */
  ms: number;
  /** JSON-RPC calls made, the id's lookup's included, and the endpoints that answered them. */
  reads: number;
  /** The id's lookup searched logs in windows it did not count one by one: `reads` is a floor. */
  readsFloor: boolean;
  endpoints: string[];
  /** A cross-check disagreed (a red line under a step that did not fail): the V3 node's header or proof, a log, a replay, released(). */
  disagree: boolean;
  /** A lock not minted yet whose used(nonce) was not read: that it is not minted rests on step 6's dry run. */
  usedUnread: boolean;
  facts: Facts;
}

/** The steps of a run, in order, with their titles in the words of the destination `chain`. */
export function stepTitles(dir: Run["dir"], route: Run["route"], chain: string): (readonly [StepKey, string])[] {
  if (dir === "back") {
    return [
      ["burn", `Burn on ${chain}`],
      ["burnId", "Burn id"],
      ["released", "Released on V3"],
      ["release", "The release itself"],
    ];
  }
  return [
    ["header", "Header hash"],
    ["keys", "Validator keys"],
    ["sigs", "Validator signatures"],
    ["proof", "Storage proofs"],
    ["commit", "Commitment"],
    ["accepted", route === "unminted" ? `Would ${chain} accept it?` : `Accepted on ${chain}`],
  ];
}

/** A step that has not started. */
export const waitingStep = ([key, title]: readonly [StepKey, string]): Step => ({ key, title, state: "waiting", ms: null, sub: "", diff: null, ev: [], lines: [], trust: null, raw: [], from: [], retry: false });

/** Nothing read yet. */
export const noFacts = (): Facts => ({ block: null, setId: null, checkpoint: null, carried: 0, admin: null, header: null, mint: null, nonce: null, burnId: null });

/** A run that has not started: every step waiting, as the card shows it before the first answer. */
export function waitingRun(dir: Run["dir"], route: Run["route"], chain: string): Run {
  return { dir, route, steps: stepTitles(dir, route, chain).map(waitingStep), done: false, ms: 0, reads: 0, readsFloor: false, endpoints: [], disagree: false, usedUnread: false, facts: noFacts() };
}

export type VerdictKind = "checking" | "verified" | "partial" | "failed" | "trusted" | "unminted" | "disagree";

export interface Verdict {
  kind: VerdictKind;
  /** The chip. */
  chip: string;
  title: string;
  sub: string;
  /** The failed step, 1-based. */
  failedAt: number | null;
}

/** A duration: milliseconds under a second, else seconds to a tenth. */
export const secsText = (ms: number): string => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

/**
 * Whether the signatures on the block were checked and passed: step 3 on the way in, B3 on the way
 * back (passed, or open: released[burnId] read as 0 under signatures that verified). Until then the
 * set the run read is only read, not checked.
 */
export const signedChecked = (run: Pick<Run, "steps">): boolean => run.steps.some((s) => (s.key === "sigs" && s.state === "passed") || (s.key === "released" && (s.state === "passed" || s.state === "open")));

/** The first cross-check that disagreed, a red line under a step that did not fail; null when none did. */
export const redLine = (run: Pick<Run, "steps">): Line | null => run.steps.flatMap((s) => (s.state === "failed" ? [] : s.lines)).find((l) => l.ok === false) ?? null;

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The run's verdict, from its steps' states. The way in: Verified only when every step passed on
 * the mint itself and no cross-check disagreed; Not all checked when one was not checked, or when
 * the mint's transaction was not served and the checks ran on a proof from V3 now; Did not check
 * out at the first failed step. A lock not minted yet: whether its destination would take it, by
 * step 6's dry run. The way back is Trusted whatever B1 to B3 say, the release being the
 * committee's and never shown as passed; its title says what B1 and B3 found, and no more.
 */
export function verdictOf(run: Pick<Run, "dir" | "route" | "steps" | "done" | "ms" | "reads" | "readsFloor" | "disagree" | "usedUnread">, chain = ""): Verdict {
  const total = run.steps.length;
  const passed = run.steps.filter((s) => s.state === "passed").length;
  const failed = run.steps.findIndex((s) => s.state === "failed");
  const timing = `${secsText(run.ms)} · ${run.readsFloor ? "at least " : ""}${run.reads} reads`;
  if (failed >= 0) {
    const s = run.steps[failed];
    return { kind: "failed", chip: "Did not check out", title: `Did not check out at step ${failed + 1} · ${s?.title ?? ""}`, sub: s?.sub ?? "", failedAt: failed + 1 };
  }
  if (!run.done) return { kind: "checking", chip: "Checking", title: "Checking in your browser", sub: `${passed} of ${total} checks so far`, failedAt: null };
  const skipped = run.steps.filter((s) => s.state === "skipped").length;
  const red = redLine(run);
  const differs = run.disagree || red !== null;
  const note = differs ? " · a cross-check disagrees" : "";
  const state = (k: StepKey) => run.steps.find((s) => s.key === k)?.state;
  if (run.dir === "back") {
    const rel = state("released");
    const released = rel === "passed" ? "released on V3" : rel === "open" ? "not released on V3 yet" : "release not checked on V3";
    return {
      kind: "trusted",
      chip: "Trusted · 2-of-3",
      title: `${state("burn") === "passed" ? `Burned on ${chain}` : "Burn not checked"}, ${released}`,
      sub: `${passed} check${passed === 1 ? "" : "s"} passed${skipped ? ` · ${skipped} not checked` : ""}${note} · 1 trusted: the committee's release`,
      failedAt: null,
    };
  }
  const counts = `${passed} of ${total} checks${skipped ? ` · ${skipped} not checked` : ""}${note} · ${timing}`;
  if (run.route === "unminted") {
    // Step 6 is the dry run: it says whether the destination would take the lock, or that it was minted meanwhile.
    if (state("accepted") === "open") return { kind: "partial", chip: "Minted meanwhile", title: "Minted meanwhile · check again", sub: counts, failedAt: null };
    if (passed !== total) {
      return run.usedUnread
        ? { kind: "partial", chip: "Not all checked", title: "Not all checked · whether it is minted was not read", sub: counts, failedAt: null }
        : { kind: "unminted", chip: "Not minted yet", title: "Not minted yet · not all checked", sub: counts, failedAt: null };
    }
    return { kind: "unminted", chip: "Not minted yet", title: `Not minted yet · ${chain} would accept it`, sub: counts, failedAt: null };
  }
  if (run.route === "fallback") {
    return {
      kind: "partial",
      chip: "Not all checked",
      title: "Not all checked: the mint itself was not served",
      sub: `${passed} of ${total} checks on a proof read from V3 now${skipped ? ` · ${skipped} not checked` : ""}${note} · ${timing}`,
      failedAt: null,
    };
  }
  // Verified only when every step passed: a step not checked, or one in any other state, is not a pass.
  if (passed !== total) return { kind: "partial", chip: "Not all checked", title: "Not all checked", sub: `${passed} of ${total} checks · ${total - passed} not checked${note} · ${timing}`, failedAt: null };
  if (differs) return { kind: "disagree", chip: "Cross-check differs", title: "Verified · a cross-check disagrees", sub: `${red ? `${capital(red.text)} · ` : ""}${passed} of ${total} checks · ${timing}`, failedAt: null };
  return { kind: "verified", chip: "Verified", title: "Verified in your browser", sub: `${passed} of ${total} checks · ${timing}`, failedAt: null };
}
