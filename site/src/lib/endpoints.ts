// The nodes the page reads, and the chain ids, apart from the build's records so that the tests can
// import them. ./chains.ts re-exports all of it; vite.config.ts's Content-Security-Policy allows
// these hosts and no others.

import type { Endpoint } from "./rpc.ts";

export const SEPOLIA_CHAIN_ID = 11155111n;
export const V3_CHAIN_ID = 420420777n;

// `batch`: the most calls sent in one JSON-RPC batch (drpc's free plan takes 3; the Substrate node's
// HTTP endpoint takes none, so it has no batch size).
const publicnode: Endpoint = { id: "publicnode", label: "ethereum-sepolia-rpc.publicnode.com", url: "https://ethereum-sepolia-rpc.publicnode.com", batch: 8 };
const drpc: Endpoint = { id: "drpc", label: "sepolia.drpc.org", url: "https://sepolia.drpc.org", batch: 3 };
const tenderly: Endpoint = { id: "tenderly", label: "sepolia.gateway.tenderly.co", url: "https://sepolia.gateway.tenderly.co", batch: 8 };

/** State reads: the public node first. */
export const SEPOLIA: Endpoint[] = [publicnode, drpc, tenderly];
/** Older transactions and receipts: the public node keeps about a day of them, so the others follow. */
export const SEPOLIA_HISTORY: Endpoint[] = [publicnode, drpc, tenderly];
/**
 * eth_getLogs from the relayer's latest recorded import on: tenderly serves wide ranges; the public
 * node takes up to 50,000 blocks (about a week of Sepolia) and drpc up to 10,000.
 */
export const SEPOLIA_LOGS: Endpoint[] = [tenderly, publicnode, drpc];

export const V3_EVM: Endpoint[] = [{ id: "v3-evm", label: "test-evm-rpc-v3.portaldot.dev", url: "https://test-evm-rpc-v3.portaldot.dev", batch: 8 }];
export const V3_SUBSTRATE_HTTP: Endpoint = { id: "v3-http", label: "test-node-v3.portaldot.dev", url: "https://test-node-v3.portaldot.dev" };
export const V3_SUBSTRATE_WS: Endpoint = { id: "v3-ws", label: "wss://test-node-v3.portaldot.dev", url: "wss://test-node-v3.portaldot.dev" };
export const MAINNET_SUBSTRATE_WS: Endpoint = { id: "mainnet-ws", label: "wss://mainnet.portaldot.io", url: "wss://mainnet.portaldot.io" };

/**
 * The two rollups where the V3 light client is live: two public RPCs each. Each answered
 * eth_chainId (84532 and 421614), a batch of eight eth_calls to the client and a CORS preflight
 * from a browser origin on Oct 28, 2026. The public node first on Base Sepolia (sepolia.base.org is
 * rate-limited), Arbitrum's own node first on Arbitrum Sepolia (the public node keeps only about
 * 64 blocks of its state: enough for "latest", not for history). `logRange`, measured on Oct 28:
 * the public nodes search at most 50,000 blocks of logs in one call ("exceed maximum block range:
 * 50000"), sepolia.base.org 200 (HTTP 413, too few to search with), and Arbitrum's own node served
 * 171,006 in one.
 */
export const BASE_SEPOLIA: Endpoint[] = [
  { id: "base-publicnode", label: "base-sepolia-rpc.publicnode.com", url: "https://base-sepolia-rpc.publicnode.com", batch: 8, logRange: 50_000 },
  { id: "base-official", label: "sepolia.base.org", url: "https://sepolia.base.org", batch: 8, logRange: 200 },
];
export const ARBITRUM_SEPOLIA: Endpoint[] = [
  { id: "arbitrum-official", label: "sepolia-rollup.arbitrum.io", url: "https://sepolia-rollup.arbitrum.io/rpc", batch: 8 },
  { id: "arbitrum-publicnode", label: "arbitrum-sepolia-rpc.publicnode.com", url: "https://arbitrum-sepolia-rpc.publicnode.com", batch: 8, logRange: 50_000 },
];
