// The shapes of a live transfer: what sends.ts fills in, the journal keeps across a reload, and the
// transfer screen, the receipt and Activity read. Types only, kept apart from the build's records
// (transfers.ts and facts.ts read them) so that node --test and its typecheck run what uses them.

import type { Hex } from "../lib/hex.ts";
import type { DestKey } from "./dests.ts";

export type Dir = "in" | "back";
export type Speed = "fast" | "std";

/** The five checks of a mint, in the contracts' order: the light client's two, then BridgeMinter's three. */
export type CheckKey = "header" | "sigs" | "proof" | "commit" | "nonce";
export type CheckState = "waiting" | "checking" | "passed" | "failed";

/**
 * A transaction the visitor sends: asked for in the wallet, sent (the wallet returned its hash),
 * then mined. Times are ms since the epoch; `minedAt` is its block's timestamp. `gasUsed` is null
 * for a lock this page did not send (Finish mint), whose receipt it did not read. `by`: the sender,
 * and its next nonce as this page's node counted it just before the wallet was asked, the wallet's
 * nonce for it most likely: once the sender's nonce has passed it with no receipt for this hash, the
 * wallet put another transaction in its place, even when no node ever showed this one.
 */
export type SentTx =
  | { stage: "asking" }
  | { stage: "sent"; hash: Hex; sentAt: number; by?: { from: Hex; nonce: number } }
  | { stage: "mined"; hash: Hex; sentAt: number; block: number; minedAt: number; gasUsed: number | null };

/** What the step under way waits on, when it is not a block: the wallet (`wallet`), or a read or a dry run here. Not kept in the journal. */
export interface Note {
  text: string;
  wallet: boolean;
}

/**
 * Why a transfer stopped, and what the screen says (`title` and `text` override the reason's own
 * words). rejected: declined in the wallet, nothing sent. refused: this page did not ask the wallet,
 * as the dry run or a check said it would fail; nothing sent. reverted: mined and reverted, only
 * the fee paid. proof: a check of the mint did not hold. blocked: the light client takes no import
 * until its admin acts. stopped: this page stopped following a transfer that is on chain. `at`
 * stops the card's clock.
 */
export interface Failure {
  reason: "rejected" | "refused" | "reverted" | "proof" | "blocked" | "stopped";
  at: number;
  title: string | null;
  text: string | null;
}

/** How the mint goes, from the proof core's plan (../lib/proof/plan.ts), and the transaction the wallet is asked for now. */
export interface MintRoute {
  /** mint(p) at a block the light client holds, importAndMint at V3's head or at a set change, or a self-relay through Multicall3. */
  path: "mint" | "head" | "change" | "selfRelay";
  /** The validator-set changes the mint imports besides its own block: the self-relay's importHeader calls, over every transaction. */
  imports: number;
  /** The transaction asked for now: its title, its gas limit, and its place among the plan's transactions (1-based). */
  title: string;
  gas: number | null;
  step: number;
  steps: number;
  /** The gas limits of every transaction of the plan, summed, when the dry run measured them all. */
  total: number | null;
}

interface Common {
  /** The page's #/tx/<id>: letters, digits and dashes, and never a lock's or a burn's (lock-1, burn-0…). */
  id: string;
  /**
   * The chain on the other side of V3 (./dests.ts): the lock names its chain id and minter and the
   * mint is sent there, or the burn is sent there. Sepolia for a transfer from before the page sent
   * to the rollups (journal.ts).
   */
  dest: DestKey;
  /** Base units, 14 decimals: tPOT and wtPOT alike. */
  amount: bigint;
  /** The address paid on the other chain: the sender's own, but for a lock from a Substrate account, which pays the address given on the destination. */
  recipient: Hex;
  /** When the visitor confirmed the review (or Finish mint): the transfer's clock starts here. */
  startedAt: number;
  /**
   * The first block the lock's or the burn's log can be in, on its chain (V3, the destination): the one after
   * the latest block when the checks before the wallet's prompt ran. Where the page looks for a lock
   * or a burn whose hash it does not have. Absent until the wallet is asked.
   */
  fromBlock?: number;
  /** When its last step finished. */
  doneAt: number | null;
  failure: Failure | null;
  note: Note | null;
}

/**
 * Who locks: an Ethereum wallet, through V3's EVM side (the address is the lock's sender and its
 * recipient on the destination), or a Substrate (5…) account of a Polkadot wallet, through revive.call: the
 * vault records `h160`, pallet-revive's address of the account, as the sender, and the recipient is
 * the destination's address the visitor gave. `wallet`: the wallet's key in window.injectedWeb3, `walletName`
 * how the page names it.
 */
export type LockSender = { kind: "evm"; address: Hex } | { kind: "substrate"; ss58: string; h160: Hex; wallet: string; walletName: string };

/**
 * A lock signed as a Substrate extrinsic: the account nonce it was signed with, and the blocks its
 * mortal era lets it in (`from` to `to`). Known before the wallet is asked: once V3 has finalized
 * past `to` without it, it can never be included, so nothing was locked.
 */
export interface ExtrinsicRef {
  nonce: number;
  from: number;
  to: number;
}

/** V3 to the destination: the lock, V3's finality of its block, the proof built and checked here, the mint there. */
export interface LockTransfer extends Common {
  dir: "in";
  sender: LockSender;
  /** A Substrate lock's extrinsic, once the wallet is asked for it; null for an Ethereum lock. */
  ext: ExtrinsicRef | null;
  lock: SentTx;
  /** The vault's nonce for this lock, from its Locked log. */
  nonce: number | null;
  commitment: Hex | null;
  /**
   * The finalized block the proofs are read at, its set and the signatures the mint's import counts
   * (null for a block the light client holds already, or not known yet). `at`: when this page saw
   * V3 finalize the lock's block.
   */
  finality: { block: number; hash: Hex; setId: number | null; signatures: number | null; authorities: number | null; at: number } | null;
  /** Each check as this browser runs it; `builtAt` once all five passed (the nonce passes with the dry run of the mint). */
  proof: { checks: Record<CheckKey, CheckState>; builtAt: number | null };
  route: MintRoute | null;
  /** The transactions of a self-relay that came before the one that mints: set changes imported. */
  relayed: { hash: Hex; block: number }[];
  /** null until the visitor is asked to sign the mint, or until a mint anyone sent is found. */
  mint: SentTx | null;
  /**
   * Minted (used(nonce) is true on the destination) by a transaction whose Minted log is older than
   * the destination's nodes search (../lib/logs.ts), so the page cannot name it: when the page found
   * it so. Done, as a mined mint is; absent otherwise.
   */
  mintBeyond?: number;
  /** Who sent the mint, once it is found: auto-mint's key, the visitor, anyone. */
  mintBy: Hex | null;
  /** Auto-mint's key had a transaction the destination had not mined, at the last read: the visitor's own mint waits longer (handoff.ts). */
  autoPending: boolean;
  /** Finish mint: the lock was made before this page followed it, so its steps before the mint are not timed. */
  resumed: boolean;
}

/** The destination to V3: the burn, its confirmations or its chain's finality, then the committee's release. */
export interface BurnTransfer extends Common {
  dir: "back";
  /** How the watcher releases it: after its chain's fast confirmations, 3 on Sepolia (fast), or after its finality (standard). */
  speed: Speed;
  /** Fast was asked for, but the fast budget was in use: released the standard way. */
  fallback: boolean;
  burn: SentTx;
  /** From BurnRequested. */
  burnNonce: number | null;
  burnId: Hex | null;
  /** Its chain's blocks on top of the burn's, whether its block is final, and when the burn qualified for the release. */
  depth: { confirmations: number; final: boolean; qualifiedAt: number | null };
  /**
   * The committee's approvals on V3, 2 of 3 to release, read from its multisig's open operation;
   * `released` once released(burnId) is true on the vault; the extrinsic that ran it and its block's
   * timestamp (`at`), when they were found.
   */
  release: { approvals: number; open: { extrinsic: Hex; block: number } | null; run: { extrinsic: Hex; block: number } | null; at: number | null; released: boolean };
}

export type LiveTransfer = LockTransfer | BurnTransfer;
