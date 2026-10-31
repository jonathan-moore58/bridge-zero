// The way in's mint, handed to auto-mint: the operator's process that mints every new lock of at
// least 0.001 tPOT for its committed recipient, from its own key, about 90 s after V3 finalized the
// lock (README, "Auto-mint: lock 2, minted for its recipient"; relayer/src/automint.ts), on the
// chain the lock names: one process serves Sepolia, Base Sepolia and Arbitrum Sepolia since Oct 28,
// with the same minimum and grace (it minted locks 4 and 5, README rows 106 and 107). The page does
// not ask the wallet for that mint: it waits, and offers the visitor's own mint only when auto-mint
// has not minted it in a while. A lock can wait for the relayer too: auto-mint imports no
// validator-set change itself, so after V3 changes set it mints no lock on a chain until the
// relayer has brought that chain's light client to the new set. The page knows this from what it
// reads, the client's set against V3's (net.ts), not from the clock. Pure, so that node --test runs it.

import type { Hex } from "../lib/hex.ts";
import type { Dest, DestKey } from "./dests.ts";
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
   * The same while the light client reads behind V3's set: the offer then says that auto-mint waits
   * for the relayer, and that the visitor's own mint imports the change first.
   */
  fallbackAfterMs: 5 * 60_000,
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
 * destination and at any time of day: the offer 5 minutes after the lock's V3 block.
 */
export type Handoff = { kind: "self" } | { kind: "waiting"; offerAt: number } | { kind: "pending"; offerAt: number } | { kind: "offer"; since: number };

/** The handoff of a lock of `amount` from `sender`, mined in a V3 block at `lockedAt` (ms), at `now`, and whether auto-mint's key has a transaction pending. */
export function handoffOf(amount: bigint, sender: SenderKind, lockedAt: number, now: number, autoPending: boolean): Handoff {
  if (!autoMints(amount, sender)) return { kind: "self" };
  const due = lockedAt + AUTO_MINT.fallbackAfterMs;
  const late = Math.max(lockedAt + AUTO_MINT.pendingGraceMs, due);
  if (autoPending && now < late) return { kind: "pending", offerAt: late };
  if (now < due) return { kind: "waiting", offerAt: due };
  return { kind: "offer", since: autoPending ? late : due };
}

/** How far along the usual wait is, 0 to 0.9: the mint step's segment of the card's bar, toward lock 2's 144 s after the lock. */
export const handoffProgress = (lockedAt: number, now: number): number => Math.min(0.9, Math.max(0, (now - lockedAt) / (AUTO_MINT.usualSeconds * 1000)));

// ---------------------------------------------------------------------------------------------
// A light client behind V3's validator set

/**
 * How often the relayer runs for the light client on each destination, in minutes: Sepolia's every
 * 10 (watch mode, since Oct 23), each rollup's every 20 (since Oct 31, 20:33 UTC, at :00, :20 and
 * :40 past the hour). A run imports every validator-set change the client lacks, so once V3 has
 * changed set, the client is at the new one within about that long, while the relayer's machine runs.
 *
 * When V3 changes set is not known in advance: its changes follow its sessions, and a stall moves
 * them. They came every 6 hours at the same times of the UTC day until Oct 28; then set 65 began 19
 * hours after set 64, and set 75, at #266,908 on Oct 31, 10 hours and 2,179 blocks after set 74
 * (the clients' authoritySetAt, and those blocks' timestamps). So the page predicts no change: it
 * reads the client's set against V3's (net.ts), and while the client is behind, says that the
 * relayer brings it to the new set within this many minutes.
 */
export const RELAY_EVERY_MIN: Readonly<Record<DestKey, number>> = { sepolia: 10, "base-sepolia": 20, "arbitrum-sepolia": 20 };

/** "within about 20 minutes": how soon the relayer brings the light client on `dest` to V3's set, once V3 has changed it. */
export const relayWithin = (dest: DestKey): string => `within about ${RELAY_EVERY_MIN[dest]} minutes`;

/** What a client `behind` V3's set lacks: "a validator-set change", "2 validator-set changes". */
export const setChangesText = (behind: number): string => (behind === 1 ? "a validator-set change" : `${behind} validator-set changes`);

/** "once the relayer has imported it, within about 20 minutes": when auto-mint mints, while the light client on `d` is `behind` V3's set. */
const relayOnce = (d: Dest, behind: number): string => `once the relayer has imported ${behind === 1 ? "it" : "them"}, ${relayWithin(d.key)}`;

/** The review's note on a lock auto-mint is to mint while the light client on `d` reads `behind` V3's set (net.ts); null when it reads at V3's set. */
export function relayNote(d: Dest, behind: number): string | null {
  if (behind < 1) return null;
  const client = d.key === "sepolia" ? "The V3 light client" : `The light client on ${d.short}`;
  return `${client} is ${setChangesText(behind)} behind V3: auto-mint mints a lock made now ${relayOnce(d, behind)}.`;
}

/**
 * The card's notice on the way in, for a lock auto-mint mints, while the light client on `d` reads
 * `behind` V3's set: `usual` is auto-mint's usual time ("≈ 2½ min"). The visitor's own mint is
 * offered after the usual 5 minutes, and imports the change itself.
 */
export function relayNotice(d: Dest, behind: number, usual: string): string {
  const one = behind === 1;
  return `Auto-mint mints your lock ${relayOnce(d, behind)}, so it can take longer than ${usual}. If it has not minted it within ${AUTO_MINT.fallbackAfterMs / 60_000} minutes of your lock, this page offers you the mint, which imports ${one ? "the change" : "the changes"} itself.`;
}

/**
 * What any V3 set change does to auto-mint on `d`, said where the client reads at V3's set (the
 * review and the way in's tooltip): `who` waits for the relayer to bring `client` to the new set.
 */
export const relayAfterChange = (d: Dest, who: string, client: string): string => `After V3 changes validator set, ${who} waits for the relayer to bring ${client} to the new set, ${relayWithin(d.key)}`;

/** The mint step's line while auto-mint waits for the relayer: the light client on `d` reads `behind` V3's set. */
export function relayStepLine(d: Dest, behind: number): readonly (string | { nb: string })[] {
  return [
    { nb: "Auto-mint waits for the relayer," },
    " ",
    { nb: relayWithin(d.key) },
    " · ",
    { nb: `the light client on ${d.short}` },
    " ",
    { nb: `is ${setChangesText(behind)} behind V3` },
    " · ",
    { nb: "nothing to sign" },
  ];
}

/** When auto-mint mints, in the transfer's foot ("Auto-mint mints 1 wtPOT for 0x… on Base Sepolia …"), while the light client on `d` reads behind V3's set. */
export const relayFootWhen = (d: Dest): string => `once the relayer has imported V3's new validator set ${d.key === "sepolia" ? "on Sepolia" : "there"}, ${relayWithin(d.key)}`;

/** The offer of the visitor's own mint while auto-mint waits for the relayer: why it waits, before what the visitor's mint costs. */
export const relayOfferWhy = (d: Dest, behind: number): string => `The light client on ${d.short} is ${setChangesText(behind)} behind V3: auto-mint mints this lock ${relayOnce(d, behind)}.`;
