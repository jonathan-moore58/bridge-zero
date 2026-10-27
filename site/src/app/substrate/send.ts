// A lock from a Polkadot wallet, sent once: the checks on V3 (a dry run of the lock from the
// account, the limits and the fee), then the wallet's prompt, then V3's own check of what the wallet
// signed (validate_transaction), then the broadcast. The wallet only signs; the page broadcasts, so
// a page that closes while the wallet asks has sent nothing. What V3 is asked goes through a
// LockChain: ./chain.ts gives the real one, with @polkadot/api, and the tests a stand-in. No
// library and no DOM here, so that node --test runs it.

import type { Hex } from "../../lib/hex.ts";
import type { ExtrinsicRef } from "../model.ts";
import { faultOf, faultText, type InjectedSigner } from "./inject.ts";

/** A lock the wallet can be asked for, with what the checks found. Amounts in native units (14 decimals). */
export interface PreparedLock {
  /** The revive.call, as call.ts encodes it and as @polkadot/api built it: the same bytes, or nothing is asked. */
  call: Hex;
  data: Hex;
  value: bigint;
  refTime: bigint;
  proofSize: bigint;
  depositLimit: bigint;
  /** The storage deposit the dry run charged, and the fee V3 quotes for the extrinsic. */
  deposit: bigint;
  fee: bigint;
  /** The nonce the dry run's lock() returned: another lock can take it first. */
  returns: bigint | null;
  /** The account's free tPOT, and what the lock needs of it: the amount, the deposit limit, the fee and the existential deposit. */
  free: bigint;
  need: bigint;
  /** V3's best block when the checks ran. */
  head: number;
}

export type LockPrep = PreparedLock | { problem: { title: string; text: string } };

/** The extrinsic the wallet signed: its hash, its bytes, its nonce and era. */
export interface SignedLock {
  hash: Hex;
  hex: Hex;
  ext: ExtrinsicRef;
}

/** What a lock needs of V3. */
export interface LockChain {
  prepareLock(origin: string, amount: bigint, recipient: Hex): Promise<LockPrep>;
  /** Builds the extrinsic and asks the wallet to sign it; `onAsk` runs right before the wallet's prompt, with the nonce and the era it signs. */
  signLock(prep: PreparedLock, origin: string, signer: InjectedSigner, onAsk: (ext: ExtrinsicRef) => void): Promise<SignedLock>;
  /** V3's best block number: the next block is the first one an extrinsic broadcast now can be in. */
  best(): Promise<number>;
  /** V3's verdict on the signed extrinsic, without running it: null when it would take it, else why not. */
  validate(hex: Hex): Promise<string | null>;
  /** Broadcasts it. Throws NodeRefused when the node refuses it (it never entered the pool). */
  submit(hex: Hex): Promise<void>;
}

/** The page refused what @polkadot/api built before the wallet saw it. */
export class PayloadRefused extends Error {
  override name = "PayloadRefused";
}

/** V3's node refused the extrinsic at submission (an error 1010 to 1019): it was never in the pool. */
export class NodeRefused extends Error {
  override name = "NodeRefused";
}

export type SendResult =
  /** Signed and broadcast (`broadcast`), or signed and its broadcast not known to have reached the node: follow it by its hash. */
  | { kind: "sent"; signed: SignedLock; prep: PreparedLock; broadcast: boolean }
  /** The checks refused it: the wallet was not asked. */
  | { kind: "problem"; title: string; text: string }
  /** The visitor declined it in the wallet. */
  | { kind: "rejected" }
  /** Not sent: the wallet failed, or V3 would not take what it signed. */
  | { kind: "refused"; title: string; text: string }
  /** A send of this transfer is under way already: this one asked nothing. */
  | { kind: "busy" };

export interface SendHooks {
  /** The checks start. */
  checking(): void;
  /** Right before the wallet's prompt: the nonce and the era it is asked to sign, for the journal. */
  asking(ext: ExtrinsicRef, prep: PreparedLock): void;
  /** Signed and checked, before the broadcast: from here on the lock may be on V3. */
  signed(s: SignedLock): void;
  /** The account the visitor reviewed is still the one connected. */
  still(): boolean;
}

/** Talisman signs only for a network it holds the metadata of, which a page cannot give it. */
export const TALISMAN_HELP =
  "Talisman signs only on networks it knows. In Talisman, open Settings, Networks & Tokens, Manage networks, Add network, Polkadot, and give it the RPC wss://test-node-v3.portaldot.dev. Then try again. Nothing was sent.";

const inFlight = new Set<string>();

/**
 * One lock for transfer `key`, from `origin` to `recipient` on Sepolia: checked, signed once, checked
 * by V3, broadcast once. A second call for the same transfer while one runs asks nothing ("busy"),
 * so one click never sends two locks.
 */
export async function sendLockOnce(key: string, chain: LockChain, signer: InjectedSigner, input: { origin: string; amount: bigint; recipient: Hex }, hooks: SendHooks): Promise<SendResult> {
  if (inFlight.has(key)) return { kind: "busy" };
  inFlight.add(key);
  try {
    hooks.checking();
    const prep = await chain.prepareLock(input.origin, input.amount, input.recipient);
    if ("problem" in prep) return { kind: "problem", ...prep.problem };
    if (!hooks.still()) return { kind: "refused", title: "Lock not sent", text: "Your Polkadot wallet changed account after the checks. Nothing was sent: review the lock again." };
    let signed: SignedLock;
    try {
      signed = await chain.signLock(prep, input.origin, signer, (ext) => hooks.asking(ext, prep));
    } catch (e) {
      if (e instanceof PayloadRefused) return { kind: "refused", title: "Lock not asked for", text: `What the library built for your wallet is not the lock this page checked: ${e.message}. Nothing was sent.` };
      const fault = faultOf(e);
      if (fault === "rejected") return { kind: "rejected" };
      if (fault === "metadata") return { kind: "refused", title: "Talisman does not know Portaldot V3", text: TALISMAN_HELP };
      return { kind: "refused", title: "Lock not signed", text: `${faultText(e) || "Your wallet did not sign it"}. Nothing was sent.` };
    }
    // A wallet that answers once the era has ended signed for blocks V3 is past: V3 then reads the
    // signature against another block's hash (CheckMortality), so it calls it bad. Said as it is.
    const late = async (): Promise<boolean> => (await chain.best()) + 1 > signed.ext.to;
    const tooLate: SendResult = {
      kind: "refused",
      title: "Signed after V3's signing window",
      text: `Your wallet answered after V3's signing window for this lock, blocks #${signed.ext.from} to #${signed.ext.to} (about 6 minutes from its prompt), had passed. Nothing was sent: sign it again.`,
    };
    if (await late()) return tooLate;
    const invalid = await chain.validate(signed.hex);
    if (invalid !== null) return (await late()) ? tooLate : { kind: "refused", title: "V3 would not take what your wallet signed", text: `${invalid}. Nothing was sent.` };
    hooks.signed(signed);
    try {
      await chain.submit(signed.hex);
    } catch (e) {
      if (e instanceof NodeRefused) return { kind: "refused", title: "V3's node refused the lock", text: `${e.message}. Nothing was sent.` };
      // Whether the node took it is not known: the page follows it by its hash until its era ends.
      return { kind: "sent", signed, prep, broadcast: false };
    }
    return { kind: "sent", signed, prep, broadcast: true };
  } finally {
    inFlight.delete(key);
  }
}
