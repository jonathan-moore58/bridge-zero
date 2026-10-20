// Endpoints, explorers and the constants of the deployed contracts.

import records from "virtual:records";
import type { Endpoint } from "./rpc.ts";

export { records };

export const SEPOLIA_CHAIN_ID = 11155111n;
export const V3_CHAIN_ID = 420420777n;
/** Sepolia's per-transaction gas cap. */
export const TX_GAS_CAP = 16_777_216;

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

/** twox128("Grandpa") ++ twox128("CurrentSetId"), the same key on both chains. */
export const GRANDPA_SET_ID_KEY = "0x5f9cc45b7a00c5899361e1c6099678dc8a2d09463effcc78a22d75b9cb87dffc";

export const ETHERSCAN = "https://sepolia.etherscan.io";
export const etherscanTx = (h: string) => `${ETHERSCAN}/tx/${h}`;
export const etherscanAddress = (a: string) => `${ETHERSCAN}/address/${a}`;
export const etherscanBlock = (n: number) => `${ETHERSCAN}/block/${n}`;
/** The old mainnet's explorer. */
export const portalscanBlock = (n: number) => `https://portalscan.portaldot.io/#/blocks/${n}`;
/** We found no indexed explorer for the V3 testnet; the Node Console reads the V3 node directly. */
export const nodeConsoleBlock = (n: number) => `https://node-console.portaldot.dev/?rpc=wss%3A%2F%2Ftest-node-v3.portaldot.dev#/explorer/query/${n}`;

export const REPO = records.repo;
export const repoFile = (path: string) => `${REPO}/blob/main/${path}`;
export const repoTree = (path: string) => `${REPO}/tree/main/${path}`;

export const LC = records.lightClients;
export const MINTER = records.sepolia.minter;
export const TOKEN = records.sepolia.token;
export const VAULT = records.bridge.vault.address;
export const RECIPIENT = records.bridge.lock.recipient;
export const HERO_TX = records.bridge.mint.txHash;
/** wtPOT and tPOT have 14 decimals; one wtPOT unit is one native base unit of tPOT. */
export const DECIMALS = 14;
