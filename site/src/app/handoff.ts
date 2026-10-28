// The way in's mint, handed to auto-mint: the operator's process that mints every new lock of at
// least 0.001 tPOT for its committed recipient, from its own key, about 90 s after V3 finalized the
// lock (README, "Auto-mint: lock 2, minted for its recipient"; relayer/src/automint.ts), on the
// chain the lock names: one process serves Sepolia, Base Sepolia and Arbitrum Sepolia since Oct 28,
// with the same minimum and grace (it minted locks 4 and 5, README rows 106 and 107). The page does
// not ask the wallet for that mint: it waits, and offers the visitor's own mint only when auto-mint
// has not minted it in a while. On a rollup a lock can wait for the relayer too: after V3 changes
// validator set, auto-mint mints no lock there until the relayer's run brings the rollup's light
// client to the new set. Pure, so that node --test runs it.

import type { Hex } from "../lib/hex.ts";
import type { DestKey } from "./dests.ts";
import type { LockSender } from "./model.ts";

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
   */
  fallbackAfterMs: 5 * 60_000,
  /**
   * After a relayer run a lock waits for (relayWait), the visitor's own mint is offered no sooner than
   * this: auto-mint's next round mints it within a minute of the run, and its plan would import the
   * set change too, racing auto-mint for 2.4 M gas more.
   */
  afterRelayMs: 3 * 60_000,
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
 * mint offered from `offerAt`. pending: auto-mint's key has a transaction the destination has not
 * mined (it sends one at a time, so this lock's mint may be queued behind it), so the offer waits
 * longer. offer: auto-mint has not minted it in time: the visitor can mint it. The same on every
 * destination: the offer 5 minutes after the lock's V3 block, and on a rollup no sooner than a few
 * minutes after the relayer's run the lock waits for (relayWait).
 */
export type Handoff = { kind: "self" } | { kind: "waiting"; offerAt: number } | { kind: "pending"; offerAt: number } | { kind: "offer"; since: number };

/**
 * The handoff of a lock of `amount` from `sender`, mined in a V3 block at `lockedAt` (ms), at `now`,
 * whether auto-mint's key has a transaction pending, and the relayer's run it waits for, if any.
 */
export function handoffOf(amount: bigint, sender: SenderKind, lockedAt: number, now: number, autoPending: boolean, wait: RelayWait | null = null): Handoff {
  if (!autoMints(amount, sender)) return { kind: "self" };
  const due = Math.max(lockedAt + AUTO_MINT.fallbackAfterMs, wait ? wait.relay + AUTO_MINT.afterRelayMs : 0);
  const late = Math.max(lockedAt + AUTO_MINT.pendingGraceMs, due);
  if (autoPending && now < late) return { kind: "pending", offerAt: late };
  if (now < due) return { kind: "waiting", offerAt: due };
  return { kind: "offer", since: autoPending ? late : due };
}

/**
 * How far along the usual wait is, 0 to 0.9: the mint step's segment of the card's bar. `until`: when
 * auto-mint usually mints it (ms), lock 2's 144 s after the lock unless a relayer run comes first (relayWait).
 */
export const handoffProgress = (lockedAt: number, now: number, until = lockedAt + AUTO_MINT.usualSeconds * 1000): number =>
  Math.min(0.9, Math.max(0, (now - lockedAt) / Math.max(1, until - lockedAt)));

// ---------------------------------------------------------------------------------------------
// A rollup's light client after a V3 set change

/**
 * When V3 changes validator set: every 6 hours, at these minutes of the UTC day, 01:54, 07:54,
 * 13:54 and 19:54 (README, "the way in to Base Sepolia and Arbitrum Sepolia").
 */
export const V3_SET_CHANGES_UTC: readonly number[] = [1 * 60 + 54, 7 * 60 + 54, 13 * 60 + 54, 19 * 60 + 54];

/** Those times as the page says them: "01:54, 07:54, 13:54 and 19:54 UTC". */
export const SET_CHANGES_TEXT = ((t: string[]) => `${t.slice(0, -1).join(", ")} and ${t.at(-1) ?? ""} UTC`)(
  V3_SET_CHANGES_UTC.map((m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`),
);

/**
 * The rollups' light clients are kept at V3's validator set by one relayer run per rollup, 6
 * minutes after each set change. Until it runs, the client is a set behind: a mint by the head path
 * (importAndMint at V3's head) reverts WrongSetId, and auto-mint, which sends only mint(p) at a
 * header the client holds or that path, waits for it. Sepolia's client is relayed every 10 minutes.
 */
export const RELAY_AFTER_CHANGE_MS = 6 * 60_000;

/** A set change as the clock has it: when V3 changes set (ms), and when the rollups' relayer run brings their clients to it. */
export interface RelayWait {
  change: number;
  relay: number;
}

const DAY_MS = 24 * 60 * 60_000;

/**
 * The set change whose relayer run a lock to `dest` waits for, when auto-mint would come to it
 * (its usual time after the lock's V3 block at `lockedAt`, ms) in the minutes between V3's change
 * and that run; null when it would not, and always on Sepolia. By the clock: V3's sessions and the
 * relayer's run can drift, so the page words these times as approximate, and a client that reads
 * behind V3 (net.ts) says more than the clock. The visitor's own mint is offered a few minutes after
 * the run (handoffOf); one sent before it imports the set change itself (sends.ts).
 */
export function relayWait(dest: DestKey, lockedAt: number): RelayWait | null {
  if (dest === "sepolia") return null;
  const due = lockedAt + AUTO_MINT.usualSeconds * 1000;
  const day = due - (due % DAY_MS);
  for (const d of [day - DAY_MS, day]) {
    for (const minute of V3_SET_CHANGES_UTC) {
      const change = d + minute * 60_000;
      if (due >= change && due < change + RELAY_AFTER_CHANGE_MS) return { change, relay: change + RELAY_AFTER_CHANGE_MS };
    }
  }
  return null;
}

/**
 * When auto-mint usually mints a lock to `dest` mined at `lockedAt` (ms): lock 2's 144 s after it,
 * or, when it waits for the relayer's run (relayWait), its round about a minute after that run (the
 * 90 s grace long past).
 */
export function mintDueAt(dest: DestKey, lockedAt: number): number {
  const w = relayWait(dest, lockedAt);
  return w ? w.relay + (AUTO_MINT.usualSeconds - 90) * 1000 : lockedAt + AUTO_MINT.usualSeconds * 1000;
}

/** "01:54 UTC": a time of the day, as the card says when a set change and its relayer run are. */
export function utcClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}
