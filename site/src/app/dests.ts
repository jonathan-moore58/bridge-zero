// The chains the bridge pays out on, in one config: Sepolia, where it runs, and the two rollups where
// the V3 light client is live since Oct 27 (README, "More chains") and BridgeMinter and wtPOT are
// deployed since Oct 27, 20:56 to 20:58 UTC (deployments/<network>-bridge.json, on main since 3d957a7). Each
// has its chain id and names, its mark (./marks.tsx), two or more public RPCs
// (../lib/endpoints.ts), its explorer, its V3 light client and ProvenBalance, and its minter and
// wtPOT, null until they are deployed. Only a destination the app sends to (SENDS) can be picked:
// the card's balance, recipient, token, costs and the strip below it are Sepolia's, and so are the
// lock, mint and burn. The rollups are listed and cannot be picked. Kept apart from the build's
// records so that the tests import it; they check every address here against deployments/.

import { ARBITRUM_SEPOLIA, BASE_SEPOLIA, SEPOLIA } from "../lib/endpoints.ts";
import type { Hex } from "../lib/hex.ts";
import type { Endpoint } from "../lib/rpc.ts";
import type { Dir } from "./model.ts";

export type DestKey = "sepolia" | "base-sepolia" | "arbitrum-sepolia";

/** A chain's mark, as ./marks.tsx ships it (each one's source is in NOTICE.md). */
export type MarkKey = "portaldot" | "ethereum" | "base" | "arbitrum";

export interface Dest {
  key: DestKey;
  chainId: number;
  /** The chain button's two lines: "Base" over "Sepolia". */
  name: string;
  sub: string;
  /** "Base Sepolia": the destination list, the Network page. */
  full: string;
  /** "Base Sepolia" in running text ("on Base Sepolia"); Sepolia is "Sepolia". */
  short: string;
  mark: MarkKey;
  /** The public RPCs the page reads it through, in order: the Content-Security-Policy allows these. */
  rpcs: readonly Endpoint[];
  explorer: { name: string; url: string };
  /** GrandpaLightClient #2, which follows the V3 testnet. On Sepolia 0x3897…0ab6 is the old mainnet's client; on the rollups it is V3's. */
  lightClient: Hex;
  /** ProvenBalance #2, bound to that client. */
  provenBalance: Hex;
  /** BridgeMinter: null until it is deployed. */
  minter: Hex | null;
  /** wtPOT (WrappedTPOT): null until it is deployed. */
  token: Hex | null;
  /** Where deployments/ records these addresses. */
  record: string;
}

export const DESTS: readonly Dest[] = [
  {
    key: "sepolia",
    chainId: 11155111,
    name: "Ethereum",
    sub: "Sepolia",
    full: "Ethereum Sepolia",
    short: "Sepolia",
    mark: "ethereum",
    rpcs: SEPOLIA,
    explorer: { name: "Etherscan", url: "https://sepolia.etherscan.io" },
    lightClient: "0x447171c4885ad725ee4772e8e3c228adee50dcb0",
    provenBalance: "0x5b41d227248dc4775ef1061f2dfbf7136ccead3c",
    minter: "0x8287b3baf205ca8456f98346f13064aa7fcdcb9e",
    token: "0x1fcbbd66922ac5aa20219a5c16c2591a76b4cb14",
    record: "deployments/sepolia.json and deployments/sepolia-bridge.json",
  },
  {
    key: "base-sepolia",
    chainId: 84532,
    name: "Base",
    sub: "Sepolia",
    full: "Base Sepolia",
    short: "Base Sepolia",
    mark: "base",
    rpcs: BASE_SEPOLIA,
    explorer: { name: "Basescan", url: "https://sepolia.basescan.org" },
    lightClient: "0x389781d4856f0a9f3266ca6e76be6c7b7cfe0ab6",
    provenBalance: "0x40f4b03aa20d3e7ce2503c406a4fe4a46ba886f0",
    // deployments/base-sepolia-bridge.json (the deployer's nonces 9 and 10, Base 51,063,602 and 51,063,630).
    minter: "0xdc31a3bc1354545eeb985aad7b2aa662e9272348",
    token: "0xe1130718c56de008b47c392c85895a1a605ba95e",
    record: "deployments/base-sepolia.json and deployments/base-sepolia-bridge.json",
  },
  {
    key: "arbitrum-sepolia",
    chainId: 421614,
    name: "Arbitrum",
    sub: "Sepolia",
    full: "Arbitrum Sepolia",
    short: "Arbitrum Sepolia",
    mark: "arbitrum",
    rpcs: ARBITRUM_SEPOLIA,
    explorer: { name: "Arbiscan", url: "https://sepolia.arbiscan.io" },
    lightClient: "0x389781d4856f0a9f3266ca6e76be6c7b7cfe0ab6",
    provenBalance: "0x40f4b03aa20d3e7ce2503c406a4fe4a46ba886f0",
    // deployments/arbitrum-sepolia-bridge.json (the deployer's nonces 9 and 10, Arbitrum 323,463,305 and 323,463,329).
    minter: "0xdc31a3bc1354545eeb985aad7b2aa662e9272348",
    token: "0xe1130718c56de008b47c392c85895a1a605ba95e",
    record: "deployments/arbitrum-sepolia.json and deployments/arbitrum-sepolia-bridge.json",
  },
];

/** The rollups, in the config's order: the Network page has a card for each one's client. */
export const ROLLUPS = DESTS.filter((d) => d.key !== "sepolia") as readonly (Dest & { key: "base-sepolia" | "arbitrum-sepolia" })[];

/**
 * The destinations the app's lock, mint and burn run to, and so the only ones a visitor can pick. A
 * rollup's are a later stage: the proof planner, the sends, the review, auto-mint and the watcher
 * know Sepolia's minter and wtPOT only, and the bridge card's balance read, recipient, token mark,
 * costs and the strip below it are Sepolia's. A rollup joins this set only together with all of them.
 */
export const SENDS: ReadonlySet<DestKey> = new Set<DestKey>(["sepolia"]);

/**
 * live: the app bridges to it. ready: its minter and wtPOT are deployed, the app does not send to it
 * yet. soon: only its light client is live.
 */
export type DestState = "live" | "ready" | "soon";

export function destState(d: Dest, sends: ReadonlySet<DestKey> = SENDS): DestState {
  if (!d.minter || !d.token) return "soon";
  return sends.has(d.key) ? "live" : "ready";
}

/** Whether the destination list lets a visitor pick it: only once the app sends to it. A ready rollup is listed like a soon one. */
export const selectable = (d: Dest, sends: ReadonlySet<DestKey> = SENDS): boolean => destState(d, sends) === "live";

export function destOf(key: DestKey, dests: readonly Dest[] = DESTS): Dest {
  const d = dests.find((x) => x.key === key);
  if (!d) throw new Error(`no destination ${key}`);
  return d;
}

/** The destination with `chainId`, if any: the wallet button names the chain a wallet is on. */
export const destByChainId = (chainId: number | bigint | null, dests: readonly Dest[] = DESTS): Dest | null =>
  chainId === null ? null : (dests.find((d) => BigInt(d.chainId) === BigInt(chainId)) ?? null);

// ---------------------------------------------------------------------------------------------
// The chain picker ("Send from", "Receive on")

/** A row of the picker: Portaldot V3, or a destination. */
export interface PickRow {
  key: "v3" | DestKey;
  /** current: the chain already on that side. open: picking it changes the card. soon: listed, not pickable. */
  state: "current" | "open" | "soon";
  /** Where picking it leads: the direction and the destination. Null for a row that cannot be picked or is already there. */
  to: { dir: Dir; dest: DestKey } | null;
}

const flip = (dir: Dir): Dir => (dir === "in" ? "back" : "in");

/**
 * The picker's rows for `side` while the card goes `dir` with the destination `dest`. V3 is on one
 * side and the destination on the other: picking the chain of the other side swaps the direction,
 * and picking a destination on its own side changes the destination. A destination the app does not
 * send to (its minter deployed or not) is listed and cannot be picked.
 */
export function pickRows(side: "from" | "to", dir: Dir, dest: DestKey, dests: readonly Dest[] = DESTS, sends: ReadonlySet<DestKey> = SENDS): PickRow[] {
  const evmSide = dir === "in" ? "to" : "from";
  const rows: PickRow[] = [side === evmSide ? { key: "v3", state: "open", to: { dir: flip(dir), dest } } : { key: "v3", state: "current", to: null }];
  for (const d of dests) {
    if (!selectable(d, sends)) rows.push({ key: d.key, state: "soon", to: null });
    else if (side !== evmSide) rows.push({ key: d.key, state: "open", to: { dir: flip(dir), dest: d.key } });
    else if (d.key === dest) rows.push({ key: d.key, state: "current", to: null });
    else rows.push({ key: d.key, state: "open", to: { dir, dest: d.key } });
  }
  return rows;
}
