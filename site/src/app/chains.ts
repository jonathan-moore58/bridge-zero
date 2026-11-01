// The bridge's chains as viem defines them, for the wallet layer (wallet.ts), each with a transport
// to the endpoints the page's Content-Security-Policy allows (vite.config.ts), never a chain's
// default RPC: V3, and the destinations of ./dests.ts the app shows (Sepolia, the two rollups, and
// the BNB Smart Chain testnet once it is no longer hidden), which the bridge sends on. The page's own
// reads go through ../lib/rpc.ts; these serve wagmi's.

import { defineChain, fallback, http, type Chain } from "viem";
import { arbitrumSepolia as viemArbitrumSepolia, baseSepolia as viemBaseSepolia, bscTestnet as viemBscTestnet, sepolia as viemSepolia } from "viem/chains";
import { SEPOLIA, V3_EVM } from "../lib/endpoints.ts";
import type { Endpoint } from "../lib/rpc.ts";
import { ALL_DESTS, DESTS, destOf, type DestKey } from "./dests.ts";
import { CH, V3_RPC, V3_SCAN, type ChainKey } from "./facts.ts";

/** Portaldot V3 testnet's EVM side, where tPOT has 18 decimals (14 on the Substrate side). */
export const v3 = defineChain({
  id: Number(CH.v3.chainId),
  name: CH.v3.full,
  nativeCurrency: { name: "tPOT", symbol: "tPOT", decimals: 18 },
  rpcUrls: { default: { http: [V3_RPC] } },
  blockExplorers: { default: { name: "Portaldot V3 testnet scanner", url: V3_SCAN } },
  testnet: true,
});

/** viem's Sepolia with the page's own nodes as its RPC, which a wallet that has to add Sepolia is offered too. */
export const sepolia = defineChain({ ...viemSepolia, rpcUrls: { default: { http: SEPOLIA.map((e) => e.url) } } });

/** A destination's RPCs (./dests.ts, shown or not; the tests check its chain id against viem's). */
const rpcsOf = (key: DestKey): string[] => destOf(key, ALL_DESTS).rpcs.map((e) => e.url);

/** viem's Base Sepolia, Arbitrum Sepolia and BNB Smart Chain testnet with the page's nodes as their RPCs, which a wallet that has to add one is offered. */
export const baseSepolia = defineChain({ ...viemBaseSepolia, rpcUrls: { default: { http: rpcsOf("base-sepolia") } } });
export const arbitrumSepolia = defineChain({ ...viemArbitrumSepolia, rpcUrls: { default: { http: rpcsOf("arbitrum-sepolia") } } });
export const bscTestnet = defineChain({ ...viemBscTestnet, rpcUrls: { default: { http: rpcsOf("bsc-testnet") } } });

const over = (endpoints: readonly Endpoint[]) => fallback(endpoints.map((e) => http(e.url)));

const BY_KEY: Record<ChainKey, Chain> = { v3, sepolia, "base-sepolia": baseSepolia, "arbitrum-sepolia": arbitrumSepolia, "bsc-testnet": bscTestnet };

/** The chains wagmi knows: V3 and the destinations the app shows (a hidden one is none of them). */
export const WALLET_CHAINS: readonly [Chain, ...Chain[]] = [v3, ...DESTS.map((d) => BY_KEY[d.key])];

/** A transport for each of them, to the page's own nodes: V3's, Sepolia's, and each destination's. */
export const transports = Object.fromEntries([
  [v3.id, over(V3_EVM)],
  ...DESTS.map((d) => [BY_KEY[d.key].id, over(d.key === "sepolia" ? SEPOLIA : d.rpcs)] as const),
]) as Record<number, ReturnType<typeof over>>;

/**
 * The chain a send of the bridge goes out on, as wagmi knows it: the wallet is switched to it, and
 * asked to send on it alone (wallet.ts, sendOn: viem refuses a wallet on any other chain).
 */
export const viemChain = (key: ChainKey): Chain => BY_KEY[key];
