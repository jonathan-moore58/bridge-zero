// What the app states as fact: the chains, and the times and costs measured on the recorded runs
// (README rows 24 to 58, and 98 to 113 for the rollups). Each number names the run it comes from.
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

/**
 * The rollups' times. None was measured there end to end: locks 4 and 5 waited for auto-mint to
 * start serving the rollups, and both burns 0 for the watcher (README rows 98 to 113), so each is
 * Sepolia's measured part where the chain does not matter, and an estimate where it does. The mint
 * yourself is lock 1's 48 s (its V3 steps, and a mint a rollup takes in under a second rather than
 * Sepolia's 15 s). Auto-mint is the same process, its 0.001 tPOT minimum and 90 s grace (handoff.ts).
 * Fast reads 180 or 144 blocks, the 36 s Sepolia's 3 take, then the watcher and the two approvals
 * as on burn 1. Standard waits for the batch's finality on Sepolia, the chain's own as measured on
 * Oct 28 (./dests.ts, finality: about 20 minutes of Base Sepolia, 17.5 of Arbitrum Sepolia), then
 * about a minute of the watcher's round and the approvals: about 21 and 19 minutes.
 */
const ROLLUP_TIME: Record<"in" | "auto" | "fast", readonly [string, string]> = {
  in: ["≈ 48 s", "as measured on Sepolia, Oct 20"],
  auto: ["≈ 2½ min", "est., as measured on Sepolia"],
  fast: ["≈ 1½ min", "est., 36 s of blocks, then the watcher"],
};

/** How long a transfer to or from `dest` usually takes, and where that comes from: the way in sent by its locker or by auto-mint, or a burn's release speed. */
export function timeOf(dest: DestKey, mode: "in" | "auto" | Speed): readonly [string, string] {
  if (dest === "sepolia") return mode === "auto" ? AUTO_TIME : TIME[mode];
  if (mode === "std") return [`≈ ${Math.round(destOf(dest).finality.seconds / 60 + 1)} min`, "est., its batch final on Sepolia"];
  return ROLLUP_TIME[mode];
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
 * Sepolia's finality, from a block's arrival to the block final: 12.5 to 19.4 min, median 16, over
 * the 1,594 blocks the watcher's logged heads show on Oct 24. About 80 blocks of 12 s.
 */
export const SEPOLIA_FINALITY = { median: 960, blocks: 80, range: "12.5 to 19.4 min" } as const;

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
