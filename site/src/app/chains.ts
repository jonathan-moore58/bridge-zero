// The two bridge chains as viem defines them, for the wallet layer (wallet.ts), each with a transport
// to the endpoints the page's Content-Security-Policy allows (vite.config.ts), never a chain's
// default RPC. The page's own reads go through ../lib/rpc.ts; these serve wagmi's.

import { defineChain, fallback, http } from "viem";
import { sepolia as viemSepolia } from "viem/chains";
import { SEPOLIA, V3_EVM } from "../lib/chains.ts";
import type { Endpoint } from "../lib/rpc.ts";
import { CH, V3_RPC, V3_SCAN } from "./facts.ts";

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

const over = (endpoints: Endpoint[]) => fallback(endpoints.map((e) => http(e.url)));

export const transports = { [v3.id]: over(V3_EVM), [sepolia.id]: over(SEPOLIA) };
