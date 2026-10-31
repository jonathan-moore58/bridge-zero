// What the app states as fact: the chains, and the times and costs measured on the recorded runs
// (README rows 24 to 58, and 98 to 126 for the rollups). Each number names the run it comes from.
// The destinations, Sepolia and the rollups, are configured in ./dests.ts.

import { V3_CHAIN_ID } from "../lib/endpoints.ts";
import { DESTS, destOf, type Dest, type DestKey, type MarkKey } from "./dests.ts";
import type { Dir, Speed } from "./model.ts";

export type { Dir, Speed };
/** Portaldot V3, or a destination: the chains the wallet is switched to and sends on. */
export type ChainKey = "v3" | DestKey;

/** How the card and the lists show a chain: the chain button's two lines, its names in text, its mark and token. */
export interface ChainFace {
  name: string;
  sub: string;
  full: string;
  short: string;
  mark: MarkKey;
  token: "tPOT" | "wtPOT";
}

export interface ChainInfo extends ChainFace {
  key: ChainKey;
  chainId: bigint;
}

const V3: ChainInfo = { key: "v3", name: "Portaldot V3", sub: "testnet", full: "Portaldot V3 testnet", short: "V3", mark: "portaldot", token: "tPOT", chainId: V3_CHAIN_ID };

export const CH = Object.fromEntries([
  ["v3", V3],
  ...DESTS.map((d) => [d.key, { key: d.key, name: d.name, sub: d.sub, full: d.full, short: d.short, mark: d.mark, token: "wtPOT", chainId: BigInt(d.chainId) } satisfies ChainInfo]),
]) as Record<ChainKey, ChainInfo>;

/** The card's two sides: V3 and the destination `dest`, the way `dir` goes. */
export const fromOf = (dir: Dir, dest: DestKey): ChainInfo => (dir === "in" ? CH.v3 : CH[dest]);
export const toOf = (dir: Dir, dest: DestKey): ChainInfo => (dir === "in" ? CH[dest] : CH.v3);

/** The chain whose chain id is `id`, of V3 and the destinations; null for any other. */
export const chainById = (id: bigint | null): ChainInfo | null => (id === null ? null : (Object.values(CH).find((c) => c.chainId === id) ?? null));

/**
 * The chain a transfer's send goes out on: its lock on V3, its mint and a burn on its destination.
 * The wallet is switched to it before the checks, and asked to send on it alone (wallet.ts, sendOn).
 */
export const sendChain = (what: "lock" | "mint" | "burn", dest: DestKey): ChainKey => (what === "lock" ? "v3" : dest);

/**
 * The one way to say each time on Sepolia, with its source: lock 1 (Oct 20), burn 1 (Oct 24), and
 * Standard as the watcher releases it: Sepolia's finality (SEPOLIA_FINALITY), then the watcher's
 * round and the two approvals, about a minute. Burn 0's 20 min (Oct 20) included a person typing
 * the release by hand before the watcher existed.
 */
export const TIME: Record<"in" | Speed, readonly [string, string]> = {
  in: ["≈ 48 s", "measured Oct 20"],
  std: ["≈ 17 min", "est., with the watcher"],
  fast: ["≈ 84 s", "measured Oct 24"],
};

/**
 * The way in when auto-mint mints it (a lock of 0.001 tPOT or more, handoff.ts): lock 2, Oct 27,
 * 144 s from its V3 block to the mint's block (README rows 84 and 85), plus the lock's own block.
 */
export const AUTO_TIME = ["≈ 2½ min", "auto-mint, measured Oct 27"] as const;

/** A rollup: a destination other than Sepolia. */
export type RollupKey = Exclude<DestKey, "sepolia">;

/**
 * The rollups' runs, in seconds by the block timestamps: the owner's wallet in the app on Oct 28
 * (README rows 114 to 126, "The app: the first transfers from the owner's own wallet"). Auto-mint
 * minted lock 6 on Base Sepolia 139 s after its V3 block (rows 117 and 118) and lock 7 on Arbitrum
 * Sepolia 133 s after its (rows 119 and 120), 90 s of each auto-mint's grace (handoff.ts). The
 * watcher released Arbitrum Sepolia's burn 1 in fast mode 105 s after the burn's block (rows 121
 * to 123).
 * Base Sepolia's burn 1 took 905 s (rows 124 to 126): it waited while Arbitrum Sepolia's release
 * held the watcher's fast budget (README, after row 126), so it times that wait, not the chain:
 * `fast` is null there.
 */
export const ROLLUP_RUNS = {
  "base-sepolia": { auto: 139, fast: null },
  "arbitrum-sepolia": { auto: 133, fast: 105 },
} as const satisfies Record<RollupKey, { auto: number; fast: number | null }>;

/** Fast on a rollup while the budget is free: the one run that timed it, Arbitrum Sepolia's burn 1. */
const ROLLUP_FAST = { seconds: ROLLUP_RUNS["arbitrum-sepolia"].fast, on: "arbitrum-sepolia" } as const;

/** V3's block time (fixtures/probe, about 6 s): a lock's own block, before the runs' clocks start. */
const V3_BLOCK_S = 6;

const QUARTERS = ["", "¼", "½", "¾"] as const;

/** Seconds as the card states a few minutes: to the nearest quarter of a minute, "≈ 2¼ min". */
export function aboutMinutes(seconds: number): string {
  const q = Math.round(seconds / 15);
  return `≈ ${Math.floor(q / 4)}${QUARTERS[q % 4] ?? ""} min`;
}

/**
 * The rollups' times. Auto-mint's is each chain's run (ROLLUP_RUNS) and the lock's own block, as
 * Sepolia's is (AUTO_TIME): about 2½ minutes on Base Sepolia and 2¼ on Arbitrum Sepolia. Fast reads
 * 36 s of either chain's blocks (180 or 144), then the watcher's round and the two approvals on V3:
 * Arbitrum Sepolia's run, which Base Sepolia's would take too while the budget is free. The mint
 * yourself is lock 1's 48 s (its V3 steps, and a mint a rollup takes in under a second rather than
 * Sepolia's 15 s): no rollup has run it yet. Standard waits for the batch's finality on Sepolia, the
 * chain's own as measured on Oct 28 (./dests.ts, finality: about 20 minutes of Base Sepolia, 17.5 of
 * Arbitrum Sepolia), then about a minute of the watcher's round and the approvals: about 21 and 19
 * minutes.
 */
function rollupTime(dest: RollupKey, mode: "in" | "auto" | "fast"): readonly [string, string] {
  if (mode === "in") return ["≈ 48 s", "as measured on Sepolia, Oct 20"];
  const run = ROLLUP_RUNS[dest];
  if (mode === "auto") return [aboutMinutes(run.auto + V3_BLOCK_S), "auto-mint, measured Oct 28"];
  if (run.fast !== null) return [`≈ ${run.fast} s`, "measured Oct 28"];
  return [`≈ ${ROLLUP_FAST.seconds} s`, `est., as measured on ${destOf(ROLLUP_FAST.on).short}`];
}

/** How long a transfer to or from `dest` usually takes, and where that comes from: the way in sent by its locker or by auto-mint, or a burn's release speed. */
export function timeOf(dest: DestKey, mode: "in" | "auto" | Speed): readonly [string, string] {
  if (dest === "sepolia") return mode === "auto" ? AUTO_TIME : TIME[mode];
  if (mode === "std") return [`≈ ${Math.round(destOf(dest).finality.seconds / 60 + 1)} min`, "est., its batch final on Sepolia"];
  return rollupTime(dest, mode);
}

/**
 * What a lock from a Polkadot wallet takes besides the amount, out of the balance the card shows,
 * for the card's check before the dry run: the storage deposit's limit (3.8415 tPOT of lock 2's dry
 * run, plus 2%) and the fee (about 0.025 tPOT, V3's quote). The card's balance is eth_getBalance,
 * which already leaves out the 0.1 tPOT that stays in the account. The review's dry run says the
 * exact figure.
 */
export const SUBSTRATE_ROOM = 3.95;

/**
 * Sepolia's finality, from a block's arrival to the block final: 12.5 to 19.9 min, median 16, over
 * the 2,221 blocks the watcher's 15-second rounds saw arrive and become final on Oct 24 (its logs;
 * the chain's own floor is two epochs, 12.8 min). About 80 blocks of 12 s.
 */
export const SEPOLIA_FINALITY = { median: 960, blocks: 80, range: "12.5 to 19.9 min" } as const;

/** What one V3 validator-set change adds to a mint that imports it first: an importHeader, about 2.4 M gas (README: "a V3 set change about 2.39M"). */
export const IMPORT_GAS = 2.4;

/**
 * The mint's gas on `d` as the card and the transfer screen state it, in M: its recorded mint, and
 * an import for each validator-set change its light client is `behind` (sends.ts, the self-relay).
 */
export const mintGasText = (d: Dest, behind = 0): string =>
  behind > 0 ? (Number(d.mintGas.gas) + IMPORT_GAS * behind).toLocaleString("en-US", { maximumFractionDigits: 1 }) : d.mintGas.gas;

export const SPEED_NAME: Record<Speed, string> = { fast: "Fast", std: "Standard" };

/** The watcher's fast cap: up to 1 tPOT per burn, and 1 tPOT in all before finality, across the chains it serves. */
export const FAST_CAP = 1;

/**
 * The fast budget, as the release watcher keeps it (relayer/src/watch.ts, qualification; README,
 * after row 126): the fast releases whose burns are not final on their chain yet stay within
 * FAST_CAP in all, across every chain it serves. A burn that would take them above it waits, round
 * after round, until those burns are final or its own is, whichever comes first: Base Sepolia's
 * burn 1 waited 905 s on Oct 28 while Arbitrum Sepolia's release held the budget. The watcher
 * publishes no budget, so the page cannot tell when it is in use: it says that it can be, before a
 * burn that goes Fast is signed, and why when one waits.
 */
export const FAST_BUDGET_LINE = `Fast mode shares one ${FAST_CAP} tPOT budget across all chains: while another fast release is in flight, your burn can wait for finality.`;

/** A qualified burn with no approval this long is late: the watcher's rounds take about 20 s, its checks under a minute. */
export const SLOW_RELEASE_MS = 3 * 60_000;

/**
 * Why a burn that goes Fast on `d` has no release past Fast's usual time, in plain words, for the
 * transfer screen: the budget another fast release can hold until its burn or this one is final,
 * and the watcher's one machine. Null while nothing is late: not qualified yet (`qualifiedAt`, when
 * its confirmations were reached), released, approved by a member (`approvals`; null when the page
 * does not read them), qualified SLOW_RELEASE_MS ago or less, or final on its chain, where the
 * budget no longer holds it and only the watcher can.
 */
export function fastWait(d: Dest, at: { qualifiedAt: number | null; final: boolean; approvals: number | null; released: boolean }, now: number): string | null {
  if (at.released || at.final || (at.approvals ?? 0) > 0 || at.qualifiedAt === null || now - at.qualifiedAt <= SLOW_RELEASE_MS) return null;
  // A time keeps to one line: "≈ 19 min", not "≈ 19" over "min".
  const t = (mode: Speed) => timeOf(d.key, mode)[0].replace(/ /g, "\u00a0");
  // Base Sepolia's Fast is Arbitrum Sepolia's run (rollupTime): an estimate there, and said to be.
  const est = timeOf(d.key, "fast")[1].startsWith("est.") ? " (est.)" : "";
  return `Fast usually takes ${t("fast")}${est}. Fast mode shares one ${FAST_CAP} tPOT budget across all chains: while another fast release holds it, your burn waits until that release's burn is final, or yours is (${t("std")}, as Standard). Releases also wait while the committee's watcher, on one machine, is off.`;
}

/**
 * What the wallet checks up front for a lock, beyond the amount: on V3, eth_estimateGas includes the
 * storage deposit, and the wallet checks gas limit × max fee before it sends (about 4.9 tPOT).
 */
export const LOCK_CEILING = 4.9;

/** Lock 1 (Oct 20): 3.8415 tPOT of storage deposit for its commitment, and about 0.023 tPOT in fees. Locks 4 and 5, to the rollups, cost the same 3.864. */
export const LOCK_COST = "3.86";
export const LOCK_DEPOSIT = "3.84";
/** Lock 1's mint (row 55): 2,391,069 gas. The rollups' are in ./dests.ts (mintGas). */
export const MINT_GAS = destOf("sepolia").mintGas.gas;
export const MINT_GAS_FULL = destOf("sepolia").mintGas.full;
/** Burn 1 (row 56): 61,434 gas. Burn 0 used 159,354, the first burn, which wrote new storage. */
export const BURN_GAS = destOf("sepolia").burnGas.gas;
export const BURN_GAS_FULL = destOf("sepolia").burnGas.full;

/**
 * Passed the whole deploy, import and proof sequence in a simulation on Oct 24 (README, Roadmap),
 * with nothing deployed on them yet. Base Sepolia and Arbitrum Sepolia, which passed it too, have the
 * V3 light client live since Oct 27 and are destinations now (./dests.ts).
 */
export const LATER_CHAINS = ["OP Sepolia", "Polygon Amoy", "BNB Smart Chain testnet", "Avalanche Fuji"];

export const V3_SCAN = "https://scanner-testnet-v3.portaldot.dev";
export const V3_RPC = "https://test-evm-rpc-v3.portaldot.dev";
export const README = "https://github.com/jonathan-moore58/bridge-zero#readme";
