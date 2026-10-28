// The trusted way back from each chain a BridgeMinter is on (Sepolia, Base Sepolia, Arbitrum
// Sepolia), without the network: what "final" means on each, fast mode's confirmations there, and
// what the release tool and its watcher keep apart per chain (its bridge record, its burn cache, its
// releases in the V3 record, its burn ids). One vault and one committee on V3 serve every chain, so
// the committee's lock, its halt file and the fast budget are shared: the watcher counts the fast
// releases of every chain against one budget, and so does an approval by hand in fast mode
// (fastExposure). The watcher's rounds over several chains (WatchSchedule: each chain's own count and
// wait), and what a watcher that does not serve a chain would leave behind there (unservedRounds),
// are here too. release.ts and wayback.test.ts use it.
//
// Final: each chain's finalized block tag (eth_getBlockByNumber "finalized"). On Sepolia, Ethereum's
// finality, about two epochs after a block. On an OP Stack chain (Base Sepolia) the node derives its
// finalized L2 block from the batches in Sepolia's finalized blocks; on an Arbitrum chain (Arbitrum
// Sepolia) the node marks an L2 block finalized once the batch that holds it is in a finalized
// Sepolia block. Either way a rollup's burn is final when Sepolia has finalized its batch, about 20
// minutes after the burn on Oct 28, 2026 (Base Sepolia's finalized tag 5,800 to 6,700 blocks of
// 0.2 s below its latest, Arbitrum Sepolia's 3,800 to 4,500 blocks of 0.25 s, Sepolia's about 80 of
// 12 s).
//
// Fast mode: the burn read --confirmations blocks below the chain's latest block, up to the fast cap,
// with the fast releases not final yet within the fast budget, as on Sepolia. A rollup's blocks come
// every 0.2 or 0.25 s, so its confirmations are many more blocks for the same time: with --send a
// rollup takes at least 36 seconds of its blocks on top of a burn (Base Sepolia 180, Arbitrum Sepolia
// 144), the time Sepolia's 3 confirmations take. Until a rollup's batch is on Sepolia its sequencer
// alone orders its blocks: a restart or a failover that drops its latest blocks is the reorg that
// could undo a fast burn there.

import { NETWORKS, type NetworkName } from "../../contracts/script/lib/sepolia.mjs";
import { fastReleaseChecked, MAX_CONFIRMATIONS, MIN_WATCH_CONFIRMATIONS, nextWait, parseConfirmations, type FinalizedCheck, type Rule } from "./watch.js";

/** What the way back from one chain takes. */
export interface WaybackChain {
  network: NetworkName;
  title: string;
  chainId: bigint;
  /** Its bridge record: the minter and the token, and the burns sent through the release tool (steps of kind "burn"). */
  record: string;
  /** Seconds per block, measured on Oct 28, 2026. */
  blockSeconds: number;
  /** About how long after a burn's block the chain's finalized tag passes it. */
  finalizesIn: string;
  /** What final means there. */
  finality: string;
  /** Fast mode: the most confirmations taken (a deeper read is the finalized block's anyway). */
  maxConfirmations: number;
  /** Fast mode with --send: the fewest confirmations taken, and why. */
  minSendConfirmations: number;
  minSendWhy: string;
  /** How far below a fast release's recorded block its check against the final chain searches the logs. */
  reconcileBack: number;
  /**
   * The gas limit of a burn's first dry-run pass: the cap on Sepolia, as before; 1,000,000 on a
   * rollup, where the cap at the max fee (ten times the base fee) needs more ETH than a burner
   * holds there (0.0034 ETH on Arbitrum Sepolia at 0.2 gwei), and a burn takes far less (52,822
   * gas on either rollup on Oct 28).
   */
  burnProbeGas: number;
  /**
   * The burn's gas limit: on a rollup eth_estimateGas's + 10% (and Arbitrum's L1 gas once more), as
   * the mint tools send there; on Sepolia the gas used + 10%, as before. A burn of the sender's whole
   * balance clears two storage slots (its balance, the total supply), whose refund leaves the gas
   * used below what the burn needs to run: 52,822 used on Base Sepolia on Oct 28, and a limit of
   * 58,105 ran out of gas.
   */
  burnGasByEstimate: boolean;
  /** State the first RPC no longer serves is read from the network's archive RPCs (sepolia.mjs NETWORKS): on Arbitrum Sepolia its own RPC keeps about 4,500 blocks, about as deep as its finalized block. Not on Sepolia, as before. */
  archiveState: boolean;
}

export const WAYBACK: Record<NetworkName, WaybackChain> = {
  sepolia: {
    network: "sepolia",
    title: "Sepolia",
    chainId: NETWORKS.sepolia.chainId,
    record: "deployments/sepolia-bridge.json",
    blockSeconds: 12,
    finalizesIn: "about 13 minutes",
    finality: "Sepolia's finalized block, about two epochs (64 slots) after a block",
    maxConfirmations: MAX_CONFIRMATIONS,
    minSendConfirmations: MIN_WATCH_CONFIRMATIONS,
    minSendWhy: "reorgs of one or two blocks happen on Sepolia",
    reconcileBack: 128,
    burnProbeGas: 16_777_216,
    burnGasByEstimate: false,
    archiveState: false,
  },
  "base-sepolia": {
    network: "base-sepolia",
    title: "Base Sepolia",
    chainId: NETWORKS["base-sepolia"].chainId,
    record: "deployments/base-sepolia-bridge.json",
    blockSeconds: 0.2,
    finalizesIn: "about 20 minutes",
    finality: "Base Sepolia's finalized block, which its node derives from the batches in Sepolia's finalized blocks (OP Stack)",
    maxConfirmations: 7_200,
    minSendConfirmations: 180,
    minSendWhy: "36 seconds of its blocks, the time Sepolia's 3 confirmations take: until its batch is on Sepolia its sequencer alone orders its latest blocks, and a restart or a failover can drop them",
    reconcileBack: 1_800,
    burnProbeGas: 1_000_000,
    burnGasByEstimate: true,
    archiveState: true,
  },
  "arbitrum-sepolia": {
    network: "arbitrum-sepolia",
    title: "Arbitrum Sepolia",
    chainId: NETWORKS["arbitrum-sepolia"].chainId,
    record: "deployments/arbitrum-sepolia-bridge.json",
    blockSeconds: 0.25,
    finalizesIn: "about 20 minutes",
    finality: "Arbitrum Sepolia's finalized block, which its node marks once the batch that holds it is in a finalized Sepolia block",
    maxConfirmations: 7_200,
    minSendConfirmations: 144,
    minSendWhy: "36 seconds of its blocks, the time Sepolia's 3 confirmations take: until its batch is on Sepolia its sequencer alone orders its latest blocks, and a restart can drop them",
    reconcileBack: 1_800,
    burnProbeGas: 1_000_000,
    burnGasByEstimate: true,
    archiveState: true,
  },
};

/** The chains a minter is on, in the order of sepolia.mjs NETWORKS. */
export const WAYBACK_NETWORKS = Object.keys(WAYBACK) as NetworkName[];

/** The chain with chain id `chainId`, or null. */
export const waybackOf = (chainId: bigint | string): WaybackChain | null => Object.values(WAYBACK).find((c) => c.chainId === BigInt(chainId)) ?? null;

/** --network of a command on one chain (burn, release --burn-nonce, status): Sepolia's by default. */
export function parseNetwork(text: string | undefined): NetworkName {
  if (text === undefined) return "sepolia";
  if (!(WAYBACK_NETWORKS as string[]).includes(text)) throw new Error(`one of ${WAYBACK_NETWORKS.join(", ")}, got ${JSON.stringify(text)}${text.includes(",") ? " (several are for release --watch)" : ""}`);
  return text as NetworkName;
}

/** --network of the watcher: one chain or several, comma separated, served in the order given; Sepolia alone by default. */
export function parseNetworks(text: string | undefined): NetworkName[] {
  if (text === undefined) return ["sepolia"];
  const names = text.split(",").map((x) => x.trim());
  for (const x of names) if (!(WAYBACK_NETWORKS as string[]).includes(x)) throw new Error(`each is one of ${WAYBACK_NETWORKS.join(", ")}, got ${JSON.stringify(x)}`);
  if (new Set(names).size !== names.length) throw new Error("a network is named twice");
  return names as NetworkName[];
}

/** --confirmations on one chain: Sepolia's as before (1 to 64, watch.ts parseConfirmations); on a rollup, 1 to its maxConfirmations. */
export function parseConfirmationsOn(text: string, chain: WaybackChain): number {
  if (chain.network === "sepolia") return parseConfirmations(text);
  if (!/^\d+$/.test(text)) throw new Error(`a number of blocks is a whole number, got ${JSON.stringify(text)}`);
  const n = Number(text);
  const minutes = Math.round((chain.maxConfirmations * chain.blockSeconds) / 60);
  if (n < 1 || n > chain.maxConfirmations) {
    throw new Error(`from 1 to ${chain.maxConfirmations.toLocaleString("en-US")} blocks on ${chain.title} (${minutes} minutes of its blocks; it finalizes a block ${chain.finalizesIn} after it), got ${text}`);
  }
  return n;
}

/**
 * --confirmations for the chains served: one number for every chain, or <network>=<n> pairs (comma
 * separated), where a chain left out waits for finality; undefined (no --confirmations) leaves every
 * chain at finality. Each number within its chain's bounds (parseConfirmationsOn); a message names
 * the chain when there are several.
 */
export function confirmationsBy(text: string | undefined, networks: NetworkName[]): Map<NetworkName, number | null> {
  const out = new Map<NetworkName, number | null>(networks.map((x) => [x, null]));
  if (text === undefined) return out;
  const named = (x: NetworkName, parse: () => number) => {
    try {
      return parse();
    } catch (error) {
      throw new Error(`${networks.length > 1 || x !== "sepolia" ? `(${x}) ` : ""}${error instanceof Error ? error.message : String(error)}`);
    }
  };
  if (!text.includes("=")) {
    for (const x of networks) out.set(x, named(x, () => parseConfirmationsOn(text, WAYBACK[x])));
    return out;
  }
  const seen = new Set<string>();
  for (const part of text.split(",")) {
    const m = /^\s*([a-z-]+)\s*=\s*(\S+)\s*$/.exec(part);
    if (!m) throw new Error(`${JSON.stringify(part)} is not <network>=<blocks>`);
    if (!(WAYBACK_NETWORKS as string[]).includes(m[1])) throw new Error(`no network ${m[1]}`);
    if (!networks.includes(m[1] as NetworkName)) throw new Error(`${m[1]} is not a --network of this run`);
    if (seen.has(m[1])) throw new Error(`${m[1]} is named twice`);
    seen.add(m[1]);
    out.set(m[1] as NetworkName, named(m[1] as NetworkName, () => parseConfirmationsOn(m[2], WAYBACK[m[1] as NetworkName])));
  }
  return out;
}

/**
 * Why --send does not take `confirmations` on `chain` (fewer than its minimum), as the rest of
 * "--send takes ..." or "--watch --send takes ...", or null. Sepolia's words are as before.
 */
export function sendConfirmationsProblem(chain: WaybackChain, confirmations: number): string | null {
  if (confirmations >= chain.minSendConfirmations) return null;
  return chain.network === "sepolia"
    ? `takes --confirmations ${chain.minSendConfirmations} or more: ${chain.minSendWhy}`
    : `takes --confirmations ${chain.minSendConfirmations} or more on ${chain.title}: ${chain.minSendWhy}`;
}

/** Each chain's rule: its confirmations (null: finality), and the one fast cap and fast budget, which every chain shares. */
export function rulesBy(confirmations: Map<NetworkName, number | null>, fastCap: bigint, fastBudget: bigint): Map<NetworkName, Rule> {
  return new Map([...confirmations].map(([x, c]) => [x, { confirmations: c, fastCap, fastBudget }]));
}

/**
 * The file of the watcher's burn cache for `network` in its --state-dir: Sepolia's as before,
 * release-watch-<multisig>.burns.json; a rollup's release-watch-<multisig>.<network>.burns.json, as
 * Base Sepolia's and Arbitrum Sepolia's minters share one address (the cache is kept by minter).
 */
export const burnCacheName = (multisig: string, network: NetworkName): string =>
  network === "sepolia" ? `release-watch-${multisig}.burns.json` : `release-watch-${multisig}.${network}.burns.json`;

/** A release round's burn as the V3 record has it: its chain (a round recorded without one is Sepolia's) and minter. */
export interface RoundBurn {
  chainId?: string;
  minter: string;
}

/** The chain id of a round's burn: Sepolia's when the record has none. */
export const chainIdOf = (burn: RoundBurn): bigint => BigInt(burn.chainId ?? NETWORKS.sepolia.chainId);

/** Whether a release round is for a burn on `chainId`'s minter `minter`: both, as the rollups' minters share one address. */
export const burnOn = (burn: RoundBurn, chainId: bigint, minter: string): boolean => chainIdOf(burn) === chainId && burn.minter.toLowerCase() === minter.toLowerCase();

/** A burn as messages and the halt file name it: Sepolia's by its nonce alone, as before; a rollup's with its chain. */
export const burnLabel = (chainId: bigint | string, nonce: bigint | string): string => {
  const chain = waybackOf(chainId);
  return chain === null ? `${nonce} on chain ${chainId}` : chain.network === "sepolia" ? `${nonce}` : `${nonce} on ${chain.title}`;
};

/** A release made in fast mode, as the fast budget counts it (watch.ts Ports fastReleases): `final` set for another chain's. */
export interface FastRelease {
  amount: bigint;
  block: number;
  checked: boolean;
  /** Another chain's release: whether its block is final there (watch.ts watchRound otherwise compares it with the round's finalized head). */
  final?: boolean;
}

/** A round of the V3 record, as fastReleasesOf, fastExposure and unservedRounds read it. */
export interface FastRound {
  status: string;
  by?: "fast" | "finality";
  amountNative: string;
  burn: RoundBurn & { block: number; burnNonce: string; burnId?: string };
  finalizedCheck?: FinalizedCheck & { why?: string };
}

/**
 * The fast releases the budget counts, of every chain: one vault and one committee release for all,
 * so what a reorg could undo is counted across them. The round's own chain's (`here`) as before:
 * their blocks against the round's finalized head. Another chain's with `final`: checked against its
 * own final chain already, or its block at or below that chain's finalized head (`finalized`, by
 * chain id; a chain whose head is not known counts as not final).
 */
export function fastReleasesOf(rounds: FastRound[], here: { chainId: bigint; minter: string }, finalized: Map<bigint, number>): (FastRelease & { round: FastRound })[] {
  return rounds
    .filter((r) => r.status === "released" && r.by === "fast")
    .map((r) => {
      const checked = fastReleaseChecked(r.finalizedCheck);
      const item = { amount: BigInt(r.amountNative), block: r.burn.block, checked, round: r };
      if (burnOn(r.burn, here.chainId, here.minter)) return item;
      const head = finalized.get(chainIdOf(r.burn));
      return { ...item, final: checked || (head !== undefined && r.burn.block <= head) };
    });
}

/** The chains other than `here` whose fast releases still count unless their blocks are final there: the finalized heads a round's dry run reads (with --send they count until checked, whatever their blocks). */
export function otherFastChains(rounds: FastRound[], here: { chainId: bigint; minter: string }): bigint[] {
  const out = new Set<bigint>();
  for (const r of rounds) if (r.status === "released" && r.by === "fast" && !burnOn(r.burn, here.chainId, here.minter) && !fastReleaseChecked(r.finalizedCheck)) out.add(chainIdOf(r.burn));
  return [...out];
}

/**
 * What a release by hand in fast mode counts against the fast budget, as the watcher with --send
 * counts it, on every chain: the releases made in fast mode that are not checked against their
 * chains' final blocks yet (their amounts and their burns, by chain id and nonce), the release of
 * burn id `except` (the burn the run is for) left out. One vault and one committee release for every
 * chain, so a fast release by hand keeps to the one budget too.
 */
export function fastExposure(rounds: FastRound[], except: string): { total: bigint; burns: { chainId: bigint; burnNonce: string; amount: bigint }[] } {
  const burns = rounds
    .filter((r) => r.status === "released" && r.by === "fast" && !fastReleaseChecked(r.finalizedCheck) && r.burn.burnId?.toLowerCase() !== except.toLowerCase())
    .map((r) => ({ chainId: chainIdOf(r.burn), burnNonce: r.burn.burnNonce, amount: BigInt(r.amountNative) }));
  return { total: burns.reduce((sum, x) => sum + x.amount, 0n), burns };
}

/**
 * What the record holds that only a watcher serving its chain finishes, on the chains a watcher does
 * not serve (`served`, by chain id): a release left half done (open: its opener's deposit stays
 * reserved, and only that chain's round runs it) and a release made in fast mode that is not checked
 * against its chain's final blocks yet (only that chain's round checks it, and a reorg there that
 * undid the burn is found nowhere else). release.ts watchCommand does not start with --send while
 * there is one, and its dry run warns, so that a watcher started with fewer chains (an older command
 * line, as a logon task may keep) does not leave them behind unseen.
 */
export function unservedRounds(rounds: FastRound[], served: bigint[]): { chainId: bigint; burnNonce: string; why: string }[] {
  const out: { chainId: bigint; burnNonce: string; why: string }[] = [];
  for (const r of rounds) {
    const chainId = chainIdOf(r.burn);
    if (served.includes(chainId)) continue;
    const title = waybackOf(chainId)?.title ?? `chain ${chainId}`;
    if (r.status === "open") out.push({ chainId, burnNonce: r.burn.burnNonce, why: "its release is open (opened, not run yet)" });
    else if (r.status === "released" && r.by === "fast" && !fastReleaseChecked(r.finalizedCheck)) {
      out.push({ chainId, burnNonce: r.burn.burnNonce, why: `its release, made in fast mode, is not checked against ${title}'s final blocks yet` });
    }
  }
  return out;
}

/**
 * The rounds of the watcher over the chains it serves (release.ts watchCommand): each chain counts its
 * own rounds, waits its own wait (one whose RPC fails backs off alone: watch.ts nextWait) and is due
 * on its own; every chain is due at the start. With --rounds n each chain runs n rounds, and the run
 * is over once every chain has, its exit code the worst of each chain's last round's. Times are in
 * ms (Date.now()); the watcher passes the clock, the tests a stand-in.
 */
export class WatchSchedule {
  private readonly chains: Map<NetworkName, { ran: number; wait: number; due: number; last: number | null }>;

  constructor(
    readonly networks: NetworkName[],
    private readonly watch: number,
    private readonly rounds: number | null,
  ) {
    this.chains = new Map(networks.map((x) => [x, { ran: 0, wait: watch, due: 0, last: null }]));
  }

  private of(x: NetworkName) {
    const c = this.chains.get(x);
    if (!c) throw new Error(`the watcher does not serve ${x}`);
    return c;
  }

  /** Whether chain `x` has rounds left: always without --rounds. */
  left(x: NetworkName): boolean {
    return this.rounds === null || this.of(x).ran < this.rounds;
  }

  /** Whether chain `x`'s next round runs at `now`: it has rounds left, and its wait is over. */
  due(x: NetworkName, now: number): boolean {
    return this.left(x) && now >= this.of(x).due;
  }

  /** Starts chain `x`'s round: its number, counted for that chain alone. */
  start(x: NetworkName): number {
    const c = this.of(x);
    c.ran += 1;
    return c.ran;
  }

  /** Ends chain `x`'s round at `now` with exit code `code`; `trouble` (an RPC failed) doubles its wait, up to an hour. */
  end(x: NetworkName, code: number, trouble: boolean, now: number): void {
    const c = this.of(x);
    c.last = code;
    c.wait = nextWait(this.watch, c.wait, trouble);
    c.due = now + c.wait * 1000;
  }

  /** With --rounds n, whether every chain has run its n rounds; never without. */
  finished(): boolean {
    return this.rounds !== null && this.networks.every((x) => !this.left(x));
  }

  /** Each chain's last round's exit code, in the order served (a chain that has not run yet left out). */
  lastCodes(): number[] {
    return this.networks.map((x) => this.of(x).last).filter((c): c is number => c !== null);
  }

  /** The chains with rounds left, each with its wait (s) and when its next round is due (ms). */
  upcoming(): { network: NetworkName; wait: number; due: number }[] {
    return this.networks.filter((x) => this.left(x)).map((x) => ({ network: x, wait: this.of(x).wait, due: this.of(x).due }));
  }

  /** When the next round of a chain with rounds left is due (ms); now when there is none. */
  nextDue(now: number): number {
    const next = this.upcoming().map((x) => x.due);
    return next.length === 0 ? now : Math.min(...next);
  }
}

/** Errors of an RPC that no longer serves a block's state (relay.ts pruned, and Nitro's "historical state ... is not available"). */
export const prunedState = (text: string): boolean => /prun|historical state|missing trie node|history (is )?unavailable|"code":4444\b/i.test(text);
