// The way in's mint, handed to auto-mint: the operator's process that mints every new lock of at
// least 0.001 tPOT for its committed recipient, from its own key, about 90 s after V3 finalized the
// lock (README, "Auto-mint: lock 2, minted for its recipient"; relayer/src/automint.ts), on the
// chain the lock names: one process serves Sepolia, Base Sepolia and Arbitrum Sepolia since Oct 28,
// with the same minimum and grace (it minted locks 4 and 5, README rows 106 and 107). The page does
// not ask the wallet for that mint: it waits, and offers the visitor's own mint only when auto-mint
// has not minted it in a while. A lock can wait for the relayer too: auto-mint imports no
// validator-set change itself. While a chain's light client is behind V3's set, auto-mint mints a
// lock there only when the client already holds a header at or after the lock's block (its held
// path, mint(p) with no import); any other lock waits until the relayer has brought the client to
// V3's set. The page knows this from what it reads (net.ts): the client's set against V3's, and its
// latest header; not from the clock. Pure, so that node --test runs it.

import type { Hex } from "../lib/hex.ts";
import type { Dest, DestKey } from "./dests.ts";
import type { LockSender } from "./model.ts";
import type { NetState } from "./netstate.ts";

export const AUTO_MINT = {
  /** Its key, the same on every chain it mints on (deployments/automint-<network>-0x57cc…a113.jsonl). */
  key: "0x57cc2ba3b883339a9f32726e6d0d3a9ee861a113" as Hex,
  /** Its --min-amount on the live process, 0.001 tPOT, in native units: a smaller lock is left to its locker. */
  min: 100_000_000_000n,
  /**
   * Whether auto-mint sees a lock signed from a Polkadot wallet. Yes since Oct 28: V3's EVM RPC
   * serves no log of a Substrate extrinsic, so the live process also reads the lock's
   * Revive.ContractEmitted event from System.Events (relayer/src/substrate-locks.ts). Lock 3, sent
   * that way, was minted by it (README rows 86 and 87).
   */
  substrate: true as boolean,
  /** Lock 2, Oct 27: 144 s from its V3 block to the mint's block, 90 of them the grace (README rows 84 and 85). */
  usualSeconds: 144,
  /**
   * The visitor's own mint is offered 5 minutes after the lock's V3 block: about twice lock 2's,
   * room for a missed round, slow Sepolia slots and locks queued before this one (auto-mint sends
   * one transaction at a time). Sooner would race it: the mint that loses reverts NonceAlreadyUsed.
   * The same while the light client reads behind V3's set: the offer then says that auto-mint waits
   * for the relayer, and that the visitor's own mint imports the change first.
   */
  fallbackAfterMs: 5 * 60_000,
  /**
   * Once the page has read the light client back at V3's set after a read that found it behind, both
   * after the lock, the offer waits until this long after that read, when that is later: auto-mint
   * mints the lock in its next round (one every 15 s, README: --watch 15), its grace long over.
   * Offered at once, the visitor's mint would race it.
   */
  afterCatchUpMs: 3 * 60_000,
  /** While auto-mint's key has a transaction the chain has not mined, up to 15 minutes: it replaces a stuck one after 10. */
  pendingGraceMs: 15 * 60_000,
  /** Its --max-spend on Sepolia: at most this much ETH of gas a day. */
  dailyEth: "0.02",
  /** Its --max-spend on each rollup (README, "Status"). */
  rollupDailyEth: "0.002",
  /** How often the page reads used(nonce) and the Minted log while it waits. */
  pollMs: 10_000,
} as const;

/** Who signs a lock: an Ethereum wallet, on V3's EVM side, or a Polkadot wallet's 5… account, as a Substrate extrinsic. */
export type SenderKind = LockSender["kind"];

/** Whether auto-mint takes this lock: at least its minimum, and signed where auto-mint can see it (AUTO_MINT.substrate). */
export const autoMints = (amount: bigint, sender: SenderKind): boolean => amount >= AUTO_MINT.min && (sender === "evm" || AUTO_MINT.substrate);

/**
 * Where the mint stands while it is not minted. self: auto-mint does not take the lock (below its
 * minimum, or from a Polkadot wallet), the visitor mints it. waiting: auto-mint's, the visitor's own
 * mint offered from `offerAt`; `caughtUp` when that is set by the page's read of the light client
 * back at V3's set (auto-mint mints it in its next round). pending: auto-mint's key has a transaction
 * the destination has not mined (it sends one at a time, so this lock's mint may be queued behind
 * it), so the offer waits longer. offer: auto-mint has not minted it in time: the visitor can mint
 * it. The same on every destination and at any time of day: the offer 5 minutes after the lock's V3
 * block, unless the light client caught up later than that allows.
 */
export type Handoff = { kind: "self" } | { kind: "waiting"; offerAt: number; caughtUp?: true } | { kind: "pending"; offerAt: number } | { kind: "offer"; since: number };

/** Auto-mint's mint, not offered to the visitor yet. */
export type Waiting = Extract<Handoff, { kind: "waiting" | "pending" }>;

/**
 * The handoff of a lock of `amount` from `sender`, mined in a V3 block at `lockedAt` (ms), at `now`;
 * whether auto-mint's key has a transaction pending; and when the page read the destination's light
 * client back at V3's set after a read that found it behind (`caughtUpAt`, net.ts): when that came
 * after the lock, the offer waits until AUTO_MINT.afterCatchUpMs after it, if that is later.
 */
export function handoffOf(amount: bigint, sender: SenderKind, lockedAt: number, now: number, autoPending: boolean, caughtUpAt: number | null = null): Handoff {
  if (!autoMints(amount, sender)) return { kind: "self" };
  const usual = lockedAt + AUTO_MINT.fallbackAfterMs;
  const caught = caughtUpAt !== null && caughtUpAt > lockedAt ? caughtUpAt + AUTO_MINT.afterCatchUpMs : null;
  const due = caught !== null && caught > usual ? caught : usual;
  const late = Math.max(lockedAt + AUTO_MINT.pendingGraceMs, due);
  if (autoPending && now < late) return { kind: "pending", offerAt: late };
  if (now < due) return due === usual ? { kind: "waiting", offerAt: due } : { kind: "waiting", offerAt: due, caughtUp: true };
  return { kind: "offer", since: autoPending ? late : due };
}

/** How far along the usual wait is, 0 to 0.9: the mint step's segment of the card's bar, toward lock 2's 144 s after the lock. */
export const handoffProgress = (lockedAt: number, now: number): number => Math.min(0.9, Math.max(0, (now - lockedAt) / (AUTO_MINT.usualSeconds * 1000)));

// ---------------------------------------------------------------------------------------------
// What the page reads of a lock's light client

/** What the page reads, for one lock, of the light client on its destination (net.ts). */
export interface LockRead {
  /**
   * The validator-set changes the client reads behind V3 that the lock waits for: 0 when it is at
   * V3's set, and when it holds a header at or after the lock's block, where auto-mint mints with no
   * import (relayer/src/automint.ts, the held path).
   */
  behind: number;
  /** When the page read the client back at V3's set after a read that found it behind (ms); null when it has not. */
  caughtUpAt: number | null;
  /** Whether the client's set against V3's is read: "reading" until the first reads answer, "unread" when one failed (recorded values, or the read before a failed refresh). */
  known: "read" | "reading" | "unread";
}

/**
 * A lock's read of `net`, the status of the light client the page is about (App.tsx gives the
 * transfer's own), for a lock to `dest` in V3 block `block` (null while the lock is not on V3: it
 * will be after any header the client holds).
 */
export function lockReadOf(net: Pick<NetState, "key" | "behind" | "dest" | "latest" | "stale" | "caughtUpAt">, dest: DestKey, block: number | null): LockRead {
  // Another destination's status says nothing of this one's client: the page reads that one next (App.tsx).
  if (net.dest !== dest) return { behind: 0, caughtUpAt: null, known: "reading" };
  const known = net.key === "checking" ? "reading" : net.key === "rpc" || net.stale ? "unread" : "read";
  const held = block !== null && net.latest !== null && net.latest >= block;
  return { behind: net.key === "relay" && !held ? net.behind : 0, caughtUpAt: net.caughtUpAt, known };
}

// ---------------------------------------------------------------------------------------------
// A light client behind V3's validator set

/**
 * How often the relayer runs for the light client on each destination, in minutes: Sepolia's every
 * 10 (watch mode since Oct 23: a new run 10 minutes after each one ends), each rollup's every 20
 * (since Oct 31, 20:33 UTC, at :00, :20 and :40 past the hour), and the BNB Smart Chain testnet's on
 * the same timer from its activation, the third run of each slot (ops/bnb-activation.md, bz-rollups).
 * A run imports every validator-set change the client lacks, so once V3 has changed set, the client
 * is at the new one within about that long, while the relayer's machine runs.
 *
 * When V3 changes set is not known in advance: its changes follow its sessions, and a stall moves
 * them. Until Oct 28 they came four times a day, at the same times of the UTC day; then set 65
 * began 19 hours after set 64, and set 75, at #266,908 on Oct 31, 10 hours and 2,179 blocks after
 * set 74 (the clients' authoritySetAt, and those blocks' timestamps). So the page predicts no
 * change: it reads the client's set against V3's (net.ts), and while the client is behind, says
 * that the relayer brings it to the new set within this many minutes.
 */
export const RELAY_EVERY_MIN: Readonly<Record<DestKey, number>> = { sepolia: 10, "base-sepolia": 20, "arbitrum-sepolia": 20, "bsc-testnet": 20 };

/**
 * "within about 20 minutes": how soon the relayer brings the light client on `dest` to V3's set, once
 * V3 has changed it. Sepolia's "usually": its relayer holds a set change while Sepolia's base fee is
 * above its 1.5 gwei gate (README, the relayer in watch mode), and runs 10 minutes after the last run
 * ended, not on the clock.
 */
export const relayWithin = (dest: DestKey): string => `${dest === "sepolia" ? "usually " : ""}within about ${RELAY_EVERY_MIN[dest]} minutes`;

/** What a client `behind` V3's set lacks: "a validator-set change", "2 validator-set changes". */
export const setChangesText = (behind: number): string => (behind === 1 ? "a validator-set change" : `${behind} validator-set changes`);

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The light client on `d` as the app names it, capitalized to start a sentence (`start`): Sepolia's
 * is "the V3 light client", as the status page has always named it; a rollup's names its chain.
 */
export const clientOn = (d: Dest, start = false): string => {
  const name = d.key === "sepolia" ? "the V3 light client" : `the light client on ${d.short}`;
  return start ? cap(name) : name;
};

/**
 * Said when the client is 2 or more changes behind: V3 changes set hours apart, and a relayer run
 * imports every change it finds, so the relayer has missed runs, and the page cannot time the next.
 */
const NOT_KEPT_UP = "The relayer has not kept up with V3's changes, so this page cannot say when.";

/**
 * When auto-mint mints while the light client on `d` reads `behind` V3's set: "once the relayer has
 * imported it, within about 20 minutes"; 2 or more behind, "once the relayer has imported them" and
 * the sentence that says why no time is given.
 */
const relayWhen = (d: Dest, behind: number): readonly [string, string] =>
  behind === 1 ? [`once the relayer has imported it, ${relayWithin(d.key)}`, ""] : ["once the relayer has imported them", ` ${NOT_KEPT_UP}`];

/** The review's note on a lock auto-mint is to mint while the light client on `d` reads `behind` V3's set (net.ts); null when it reads at V3's set. */
export function relayNote(d: Dest, behind: number): string | null {
  if (behind < 1) return null;
  const [when, more] = relayWhen(d, behind);
  return `${clientOn(d, true)} is ${setChangesText(behind)} behind V3: auto-mint mints a lock made now ${when}.${more}`;
}

/**
 * The card's notice on the way in, for a lock auto-mint mints, while the light client on `d` reads
 * `behind` V3's set: `usual` is auto-mint's usual time ("≈ 2½ min"), kept on one line. The visitor's
 * own mint is offered after the usual 5 minutes, and imports the change itself.
 */
export function relayNotice(d: Dest, behind: number, usual: string): string {
  const time = usual.replace(/ /g, "\u00a0");
  const offer = `within ${AUTO_MINT.fallbackAfterMs / 60_000} minutes of your lock, this page offers you the mint`;
  if (behind === 1) return `Auto-mint mints your lock ${relayWhen(d, 1)[0]}, so it can take longer than ${time}. If it has not minted it ${offer}, which imports the change itself.`;
  return `Auto-mint mints your lock once the relayer has imported them, so it can take longer than ${time}. ${NOT_KEPT_UP} If auto-mint has not minted it ${offer}, which imports the changes itself.`;
}

/**
 * What any V3 set change does to auto-mint on `d`, said where the client reads at V3's set (the
 * review and the way in's tooltip): `who` waits for the relayer to bring `client` to the new set.
 */
export const relayAfterChange = (d: Dest, who: string, client: string): string => `After V3 changes validator set, ${who} waits for the relayer to bring ${client} to the new set, ${relayWithin(d.key)}`;

/** What auto-mint does while the light client on `d` reads `behind` V3's set, in a sentence, after one on a mint the visitor sends (the Network page's notice). */
export const relayAutoWait = (d: Dest, behind: number): string =>
  behind === 1 ? `Auto-mint waits for the relayer, which imports it on its next run, ${relayWithin(d.key)}.` : `Auto-mint waits for the relayer to import them. ${NOT_KEPT_UP}`;

/**
 * The mint step's words for a lock auto-mint is to mint, before its wait starts (the review, a lock
 * not final yet, a proof not built yet): `usual`, auto-mint's usual time, after the lock; or, while
 * the light client on `d` reads `behind` V3's set, the relayer's import it waits for.
 */
export function autoMintAhead(d: Dest, behind: number, usual: string): string {
  if (behind < 1) return `Auto-mint, ${usual} after your lock · nothing to sign`;
  const imports = behind === 1 ? `V3's new validator set on ${d.short}, ${relayWithin(d.key)}` : `V3's ${behind} validator-set changes on ${d.short}`;
  return `Auto-mint, once the relayer has imported ${imports} · nothing to sign`;
}

/** A step's line on the transfer screen: plain text, with the parts that keep to one line marked. */
export type StepLine = readonly (string | { nb: string })[];

/** The mint step's line while auto-mint waits for the relayer: the light client on `d` reads `behind` V3's set. */
export function relayStepLine(d: Dest, behind: number): StepLine {
  return [
    { nb: "Auto-mint waits for the relayer," },
    " ",
    { nb: behind === 1 ? relayWithin(d.key) : "which has not kept up" },
    " · ",
    { nb: clientOn(d) },
    " ",
    { nb: `is ${setChangesText(behind)} behind V3` },
    " · ",
    { nb: "nothing to sign" },
  ];
}

/**
 * The mint step while auto-mint is to mint a lock on V3 (`h`, waiting or pending), the light client
 * on `d` read as `read`: its segment of the card's bar and its line. `lockedAt`: the lock's V3 block
 * time (ms), null when not read; `usual`: auto-mint's usual time; `you`: the visitor's own transfer
 * ("for you", "your lock"), else a lock read from the chains ("the lock").
 */
export function autoWaitStep(d: Dest, h: Waiting, read: LockRead, lockedAt: number | null, now: number, usual: string, you: boolean): { p: number; sub: StepLine } {
  // While the client reads behind V3's set, auto-mint waits for the relayer, which no read here can
  // time: the segment stays empty rather than fill toward lock 2's 144 s.
  const p = lockedAt !== null && read.behind === 0 ? handoffProgress(lockedAt, now) : 0;
  const tail = [" · ", { nb: "nothing to sign" }] as const;
  // Pending: auto-mint's key has a transaction the chain has not mined, this lock's mint or another's
  // it sends first (one at a time): the page cannot tell which, so it says only that.
  if (h.kind === "pending") return { p, sub: [{ nb: "Auto-mint has a transaction waiting" }, " ", { nb: `on ${d.short}` }, " · ", { nb: "yours may be queued behind it" }, ...tail] };
  if (read.behind > 0) return { p, sub: relayStepLine(d, read.behind) };
  if (h.caughtUp) return { p, sub: [{ nb: clientOn(d, true) }, " ", { nb: "is at V3's validator set again" }, " · ", { nb: "auto-mint mints it in its next round" }, ...tail] };
  // The usual line, and whether it rests on a read of the client: before the first answer, or after a failed one, it does not.
  const unread = read.known === "read" ? [] : [" · ", { nb: read.known === "reading" ? "reading the light client's set" : "the light client's set could not be checked" }];
  return { p, sub: [{ nb: you ? "Auto-mint sends it for you" : "Auto-mint sends it" }, " · ", { nb: `usually ${usual} after ${you ? "your" : "the"} lock` }, ...unread, ...tail] };
}

/**
 * The transfer screen's foot while auto-mint is to mint the visitor's lock: that the page can be
 * closed, what auto-mint mints (`what`: "1 wtPOT for 0x… on Base Sepolia") and when, and where the
 * lock is found again (`here`: a Polkadot wallet's lock, which only this browser lists). `caughtUp`:
 * the handoff's (handoffOf); `usual`: auto-mint's usual time.
 */
export function autoFoot(d: Dest, what: string, read: LockRead, caughtUp: boolean, usual: string, here: boolean): string {
  const find = here ? "Activity in this browser lists it" : "Activity shows it on any device";
  const there = d.key === "sepolia" ? "on Sepolia" : "there";
  if (read.behind === 1) return `You can close this page. Auto-mint mints ${what} once the relayer has imported V3's new validator set ${there}, ${relayWithin(d.key)}; ${find}.`;
  if (read.behind > 1) return `You can close this page. Auto-mint mints ${what} once the relayer has imported V3's ${read.behind} validator-set changes ${there}. ${NOT_KEPT_UP} ${cap(find)}.`;
  if (caughtUp) return `You can close this page. Auto-mint mints ${what} in its next round, now that ${d.key === "sepolia" ? "the V3 light client" : "the light client there"} is at V3's validator set again; ${find}.`;
  return `You can close this page. Auto-mint usually mints ${what} ${usual} after your lock; ${find}.`;
}

/** The offer of the visitor's own mint while auto-mint waits for the relayer: why it waits, before what the visitor's mint costs. */
export function relayOfferWhy(d: Dest, behind: number): string {
  const [when, more] = relayWhen(d, behind);
  return `${clientOn(d, true)} is ${setChangesText(behind)} behind V3: auto-mint mints this lock ${when}.${more}`;
}

/**
 * The offer of the visitor's own mint on `d`, when auto-mint has not minted the lock in time
 * (handoffOf): why, and what the visitor's mint does and what it costs (`cost`, as the transfer
 * screen states it), for `payee`, the lock's recipient. While the light client there reads `behind`
 * V3's set, auto-mint waits for the relayer, and the visitor's mint imports the changes first.
 */
export function offerOf(d: Dest, behind: number, payee: string, cost: string): { title: string; text: string } {
  const pays = `any address can send the mint, it pays ${payee}`;
  if (behind > 0) {
    return {
      title: "Auto-mint is waiting for the relayer",
      text: `${relayOfferWhy(d, behind)} Your tPOT stays locked for you, and the lock does not expire. You can mint it yourself now: ${pays}, it imports ${behind === 1 ? "the set change" : `the ${behind} set changes`} first, and it costs ${cost}.`,
    };
  }
  const runs =
    d.key === "sepolia"
      ? `It runs on one machine and spends at most ${AUTO_MINT.dailyEth} ETH of gas a day: while that machine is off or the day's gas is spent, locks wait.`
      : `It runs on one machine, for Sepolia and the two rollups, and spends at most ${AUTO_MINT.rollupDailyEth} ETH of gas a day on ${d.short}: while that machine is off or the day's gas is spent, locks wait.`;
  return {
    title: "Auto-mint hasn't minted it yet",
    text: `${runs} Your tPOT stays locked for you, and the lock does not expire. You can mint it yourself now: ${pays}, and it costs ${cost}.`,
  };
}
