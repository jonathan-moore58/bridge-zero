// What the app states as fact: the two chains, and the times and costs measured on the recorded
// runs (README rows 24 to 58). Each number names the run it comes from.

import { SEPOLIA_CHAIN_ID, V3_CHAIN_ID } from "../lib/chains.ts";

export type Dir = "in" | "back";
export type Speed = "fast" | "std";
export type ChainKey = "v3" | "sepolia";

export interface ChainInfo {
  key: ChainKey;
  name: string;
  sub: string;
  full: string;
  short: string;
  markId: "m-pdot" | "m-eth";
  token: "tPOT" | "wtPOT";
  chainId: bigint;
}

export const CH: Record<ChainKey, ChainInfo> = {
  v3: { key: "v3", name: "Portaldot V3", sub: "testnet", full: "Portaldot V3 testnet", short: "V3", markId: "m-pdot", token: "tPOT", chainId: V3_CHAIN_ID },
  sepolia: { key: "sepolia", name: "Ethereum", sub: "Sepolia", full: "Ethereum Sepolia", short: "Sepolia", markId: "m-eth", token: "wtPOT", chainId: SEPOLIA_CHAIN_ID },
};

export const fromOf = (dir: Dir): ChainInfo => (dir === "in" ? CH.v3 : CH.sepolia);
export const toOf = (dir: Dir): ChainInfo => (dir === "in" ? CH.sepolia : CH.v3);

/** The one way to say each time, with its source: lock 1 (Oct 20), burn 0 (Oct 20), burn 1 (Oct 24). */
export const TIME: Record<"in" | Speed, readonly [string, string]> = {
  in: ["≈ 48 s", "measured Oct 20"],
  std: ["≈ 20 min", "measured Oct 20"],
  fast: ["≈ 84 s", "measured Oct 24"],
};

export const SPEED_NAME: Record<Speed, string> = { fast: "Fast", std: "Standard" };

/** The watcher's fast cap: up to 1 tPOT per burn, and 1 tPOT in all before finality. */
export const FAST_CAP = 1;

/**
 * What the wallet checks up front for a lock, beyond the amount: on V3, eth_estimateGas includes the
 * storage deposit, and the wallet checks gas limit × max fee before it sends (about 4.9 tPOT).
 */
export const LOCK_CEILING = 4.9;

/** Lock 1 (Oct 20): 3.8415 tPOT of storage deposit for its commitment, and about 0.023 tPOT in fees. */
export const LOCK_COST = "3.86";
export const LOCK_DEPOSIT = "3.84";
/** Lock 1's mint (row 55): 2,391,069 gas. */
export const MINT_GAS = "2.39";
export const MINT_GAS_FULL = "2,391,069";
/** Burn 1 (row 56): 61,434 gas. Burn 0 used 159,354, the first burn, which wrote new storage. */
export const BURN_GAS = "61";
export const BURN_GAS_FULL = "61,434";

/** Passed the whole deploy, import and proof sequence in a simulation on Oct 24 (README, Roadmap). */
export const LATER_CHAINS = ["Base Sepolia", "OP Sepolia", "Arbitrum Sepolia", "Polygon Amoy", "BNB Smart Chain testnet", "Avalanche Fuji"];

export const V3_SCAN = "https://scanner-testnet-v3.portaldot.dev";
export const V3_RPC = "https://test-evm-rpc-v3.portaldot.dev";
export const README = "https://github.com/jonathan-moore58/bridge-zero#readme";
