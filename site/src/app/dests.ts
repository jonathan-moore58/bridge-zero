// The chains the bridge pays out on, in one config: Sepolia, where it ran first, and the two rollups
// where the V3 light client is live since Oct 27 (README, "More chains"), BridgeMinter and wtPOT
// deployed since Oct 27, 20:56 to 20:58 UTC (deployments/<network>-bridge.json), and the app sends
// since Oct 28, as auto-mint and the release watcher serve them (README, "the way in to" and "the way
// back from Base Sepolia and Arbitrum Sepolia"). Each has its chain id and names, its mark
// (./marks.tsx), two or more public RPCs (../lib/endpoints.ts), its explorer, its V3 light client
// and ProvenBalance, its minter and wtPOT, null until they are deployed, and what the sends and the
// transfer screen need of it: its block time, how it charges for L1, where its minter's logs start,
// the confirmations fast mode reads, its finality and its measured costs. Kept apart from the
// build's records so that the tests import it; they check every address here against deployments/.

import { ARBITRUM_SEPOLIA, BASE_SEPOLIA, SEPOLIA } from "../lib/endpoints.ts";
import type { Hex } from "../lib/hex.ts";
import type { L1Kind } from "../lib/l1.ts";
import type { Endpoint } from "../lib/rpc.ts";
import type { Dir } from "./model.ts";

export type DestKey = "sepolia" | "base-sepolia" | "arbitrum-sepolia";

/** A chain's mark, as ./marks.tsx ships it (each one's source is in NOTICE.md). */
export type MarkKey = "portaldot" | "ethereum" | "base" | "arbitrum";

/** A cost measured on one of the chain's recorded transactions: the gas as the card rounds it, in full, whose it was (its README row), and what else to know of it. */
export interface Measured {
  /** "2.39" (M gas) for a mint, "61" (k gas) for a burn. */
  gas: string;
  full: string;
  run: string;
  /**
   * The gas the run used, when below `full`, the gas it needed to run: a burn of its sender's whole
   * balance clears two storage slots, whose refund lowers what it used (README, "A burn on a rollup").
   */
  used?: string;
  note?: string;
}

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
  /** Seconds a block, as measured on Oct 28 (relayer/src/wayback.ts). */
  blockSeconds: number;
  /** How it charges for the data its transactions post to L1 (../lib/l1.ts): Sepolia does not. */
  l1: L1Kind;
  /** BridgeMinter's deployment block: its Minted and BurnRequested logs start there. */
  minterFrom: number;
  /**
   * Fast mode: the confirmations the release watcher reads a burn of up to 1 tPOT at (its
   * --confirmations, README "the way back from Base Sepolia and Arbitrum Sepolia"): Sepolia's 3, and
   * on a rollup the 36 s of its blocks those 3 take.
   */
  fastConfirmations: number;
  /**
   * Final: the chain's finalized block tag passing the burn's block. Sepolia's own finality; on a
   * rollup, Sepolia's finality of the batch that holds it, about 20 minutes after it on Oct 28.
   * `blocks`: about how many of its blocks that is, inside the range measured, for the countdown;
   * `seconds`: those blocks' time; `range`, as measured.
   */
  finality: { seconds: number; blocks: number; range: string };
  /** A mint and a burn as recorded on it: the costs the card states. */
  mintGas: Measured;
  burnGas: Measured;
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
    blockSeconds: 12,
    l1: "none",
    // deployments/sepolia-bridge.json, "deploy BridgeMinter" (README row 24).
    minterFrom: 11_950_851,
    fastConfirmations: 3,
    // The watcher's logged heads on Oct 24: median 16 min, about 80 blocks (./facts.ts, SEPOLIA_FINALITY).
    finality: { seconds: 960, blocks: 80, range: "12.5 to 19.4 min" },
    // Rows 55 and 56.
    mintGas: { gas: "2.39", full: "2,391,069", run: "Lock 1's mint" },
    burnGas: { gas: "61", full: "61,434", run: "Burn 1" },
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
    blockSeconds: 0.2,
    l1: "op",
    minterFrom: 51_063_602,
    fastConfirmations: 180,
    // Its finalized tag was 5,800 to 6,700 blocks below its latest on Oct 28.
    finality: { seconds: 1_200, blocks: 6_000, range: "about 20 min" },
    // Rows 106 and 108. A burn that leaves its sender a balance uses about what burn 0 needed to run.
    mintGas: { gas: "2.64", full: "2,637,646", run: "Lock 4's mint", note: "the first there, which bound the vault too" },
    burnGas: { gas: "62", full: "62,517", used: "52,822", run: "Burn 0", note: "and an L1 data fee of 666,738 wei besides" },
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
    blockSeconds: 0.25,
    l1: "arbitrum",
    minterFrom: 323_463_305,
    fastConfirmations: 144,
    // Its finalized tag was 3,800 to 4,500 blocks below its latest on Oct 28: 16 to 19 minutes of its 0.25 s blocks.
    finality: { seconds: 1_050, blocks: 4_200, range: "about 16 to 19 min" },
    // Rows 107 and 109, burn 0 the same contract and call as on Base Sepolia.
    mintGas: { gas: "2.61", full: "2,605,555", run: "Lock 5's mint", note: "the first there, which bound the vault too" },
    burnGas: { gas: "62", full: "62,517", used: "52,822", run: "Burn 0", note: "its L1 gas 0 on Oct 28" },
  },
];

/** The rollups, in the config's order: the Network page has a card for each one's client. */
export const ROLLUPS = DESTS.filter((d) => d.key !== "sepolia") as readonly (Dest & { key: "base-sepolia" | "arbitrum-sepolia" })[];

/**
 * The destinations the app's lock, mint and burn run to, and so the only ones a visitor can pick:
 * each with its own minter and wtPOT in the proof planner, the sends, the review, auto-mint and the
 * release watcher, and its own balance read, recipient, token mark, costs and strip on the card. A
 * chain joins this set only together with all of them: Base Sepolia and Arbitrum Sepolia since
 * Oct 28.
 */
export const SENDS: ReadonlySet<DestKey> = new Set<DestKey>(["sepolia", "base-sepolia", "arbitrum-sepolia"]);

/**
 * live: the app bridges to it. ready: its minter and wtPOT are deployed, the app does not send to it
 * yet. soon: only its light client is live.
 */
export type DestState = "live" | "ready" | "soon";

export function destState(d: Dest, sends: ReadonlySet<DestKey> = SENDS): DestState {
  if (!d.minter || !d.token) return "soon";
  return sends.has(d.key) ? "live" : "ready";
}

/** Whether the destination list lets a visitor pick it: only once the app sends to it. A ready chain is listed like a soon one. */
export const selectable = (d: Dest, sends: ReadonlySet<DestKey> = SENDS): boolean => destState(d, sends) === "live";

export function destOf(key: DestKey, dests: readonly Dest[] = DESTS): Dest {
  const d = dests.find((x) => x.key === key);
  if (!d) throw new Error(`no destination ${key}`);
  return d;
}

/** The destination with `chainId`, if any: the wallet button names the chain a wallet is on. */
export const destByChainId = (chainId: number | bigint | null, dests: readonly Dest[] = DESTS): Dest | null =>
  chainId === null ? null : (dests.find((d) => BigInt(d.chainId) === BigInt(chainId)) ?? null);

/**
 * The destination a lock names (the Locked log's dstChainId and dstMinter, which its commitment
 * carries), when it is one the app sends to; null for any other chain or minter, whose lock is no
 * BridgeMinter's of this config to mint. The rollups' minters share one address: the chain id tells
 * them apart.
 */
export function destOfLock(dstChainId: bigint | number | string, dstMinter: string, dests: readonly Dest[] = DESTS, sends: ReadonlySet<DestKey> = SENDS): Dest | null {
  const d = destByChainId(BigInt(dstChainId), dests);
  return d && selectable(d, sends) && d.minter?.toLowerCase() === dstMinter.toLowerCase() ? d : null;
}

/** A destination's minter and wtPOT, which a destination the app sends to has. */
export function deployed(d: Dest): { minter: Hex; token: Hex } {
  if (!d.minter || !d.token) throw new Error(`${d.full} has no BridgeMinter and wtPOT yet`);
  return { minter: d.minter, token: d.token };
}

/** A transaction, a block or an address on a destination's explorer. */
export const explorerTx = (d: Dest, hash: string): string => `${d.explorer.url}/tx/${hash}`;
export const explorerBlock = (d: Dest, n: number): string => `${d.explorer.url}/block/${n}`;
export const explorerAddress = (d: Dest, a: string): string => `${d.explorer.url}/address/${a}`;

// ---------------------------------------------------------------------------------------------
// The ids a lock or a burn goes by in Activity, in the records, on the chains and in the routes
// (#/tx/<id>, #/receipt/<id>)

/**
 * lock-<nonce>: the vault's nonce, one count for every destination (lock 4 names Base Sepolia, lock
 * 5 Arbitrum Sepolia). burn-<n>: Sepolia's BridgeMinter's burn n; burn-<chain>-<n>: a rollup's,
 * whose minter counts its burns from 0 too, so a burn's number alone does not say whose it is (its
 * burn id puts the chain id in, README "Burn ids differ per chain").
 */
export type ChainRef = { dir: "in"; n: number } | { dir: "back"; n: number; dest: DestKey };

export const lockKey = (n: number): string => `lock-${n}`;
export const burnKey = (dest: DestKey, n: number): string => (dest === "sepolia" ? `burn-${n}` : `burn-${dest}-${n}`);

const N = "(0|[1-9]\\d{0,8})";
const REF = new RegExp(`^(?:lock-${N}|burn-(?:(${ROLLUPS.map((d) => d.key).join("|")})-)?${N})$`);

/** A lock's or a burn's id, read back: lock-4, burn-0, burn-base-sepolia-0; null for any other. */
export function refOf(id: string): ChainRef | null {
  const m = REF.exec(id);
  if (!m) return null;
  if (m[1] !== undefined) return { dir: "in", n: Number(m[1]) };
  return { dir: "back", n: Number(m[3]), dest: (m[2] as DestKey | undefined) ?? "sepolia" };
}

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
