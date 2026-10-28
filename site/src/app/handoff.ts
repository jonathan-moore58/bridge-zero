// The way in's mint, handed to auto-mint: the operator's process that mints every new lock of at
// least 0.001 tPOT for its committed recipient, from its own key, about 90 s after V3 finalized the
// lock (README, "Auto-mint: lock 2, minted for its recipient"; relayer/src/automint.ts). The page
// does not ask the wallet for that mint: it waits, and offers the visitor's own mint only when
// auto-mint has not minted it in a while. Pure, so that node --test runs it.

import type { Hex } from "../lib/hex.ts";
import type { LockSender } from "./model.ts";

export const AUTO_MINT = {
  /** Its key on Sepolia (deployments/automint-sepolia-0x57cc…a113.jsonl). */
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
  /** While auto-mint's key has a transaction Sepolia has not mined, up to 15 minutes: it replaces a stuck one after 10. */
  pendingGraceMs: 15 * 60_000,
  /** Its --max-spend: at most this much ETH of gas a day. */
  dailyEth: "0.02",
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
 * mint offered from `offerAt`. pending: auto-mint's key has a transaction Sepolia has not mined
 * (it sends one at a time, so this lock's mint may be queued behind it), so the offer waits longer.
 * offer: auto-mint has not minted it in time: the visitor can mint it.
 */
export type Handoff = { kind: "self" } | { kind: "waiting"; offerAt: number } | { kind: "pending"; offerAt: number } | { kind: "offer"; since: number };

/** The handoff of a lock of `amount` from `sender`, mined in a V3 block at `lockedAt` (ms), at `now`, and whether auto-mint's key has a transaction pending. */
export function handoffOf(amount: bigint, sender: SenderKind, lockedAt: number, now: number, autoPending: boolean): Handoff {
  if (!autoMints(amount, sender)) return { kind: "self" };
  const due = lockedAt + AUTO_MINT.fallbackAfterMs;
  const late = lockedAt + AUTO_MINT.pendingGraceMs;
  if (autoPending && now < late) return { kind: "pending", offerAt: late };
  if (now < due) return { kind: "waiting", offerAt: due };
  return { kind: "offer", since: autoPending ? late : due };
}

/** How far along the usual wait is, 0 to 0.9: the mint step's segment of the card's bar. */
export const handoffProgress = (lockedAt: number, now: number): number => Math.min(0.9, Math.max(0, (now - lockedAt) / 1000 / AUTO_MINT.usualSeconds));
