// The bridge's chains as viem defines them, for the wallet layer (wallet.ts), each with a transport
// to the endpoints the page's Content-Security-Policy allows (vite.config.ts), never a chain's
// default RPC: V3, and the destinations of ./dests.ts, Sepolia and the two rollups, which the
// bridge sends on. The page's own reads go through ../lib/rpc.ts; these serve wagmi's.

import { defineChain, fallback, http, type Chain } from "viem";
import { arbitrumSepolia as viemArbitrumSepolia, baseSepolia as viemBaseSepolia, sepolia as viemSepolia } from "viem/chains";
import { SEPOLIA, V3_EVM } from "../lib/endpoints.ts";
import type { Endpoint } from "../lib/rpc.ts";
import { destOf, type DestKey } from "./dests.ts";
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

/** A destination's RPCs (./dests.ts; the tests check its chain id against viem's). */
const rpcsOf = (key: DestKey): string[] => destOf(key).rpcs.map((e) => e.url);

/** viem's Base Sepolia and Arbitrum Sepolia with the page's nodes as their RPCs, which a wallet that has to add one is offered. */
export const baseSepolia = defineChain({ ...viemBaseSepolia, rpcUrls: { default: { http: rpcsOf("base-sepolia") } } });
export const arbitrumSepolia = defineChain({ ...viemArbitrumSepolia, rpcUrls: { default: { http: rpcsOf("arbitrum-sepolia") } } });

const over = (endpoints: readonly Endpoint[]) => fallback(endpoints.map((e) => http(e.url)));

export const transports = {
  [v3.id]: over(V3_EVM),
  [sepolia.id]: over(SEPOLIA),
  [baseSepolia.id]: over(destOf("base-sepolia").rpcs),
  [arbitrumSepolia.id]: over(destOf("arbitrum-sepolia").rpcs),
};

const BY_KEY: Record<ChainKey, Chain> = { v3, sepolia, "base-sepolia": baseSepolia, "arbitrum-sepolia": arbitrumSepolia };

/**
 * The chain a send of the bridge goes out on, as wagmi knows it: the wallet is switched to it, and
 * asked to send on it alone (wallet.ts, sendOn: viem refuses a wallet on any other chain).
 */
export const viemChain = (key: ChainKey): Chain => BY_KEY[key];
