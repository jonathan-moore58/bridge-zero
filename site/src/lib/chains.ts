// Endpoints, explorers and the constants of the deployed contracts. The endpoints and chain ids are
// kept in ./endpoints.ts, which does not read the build's records, and re-exported here.

import records from "virtual:records";

export { records };

export {
  ARBITRUM_SEPOLIA,
  BASE_SEPOLIA,
  MAINNET_SUBSTRATE_WS,
  SEPOLIA,
  SEPOLIA_CHAIN_ID,
  SEPOLIA_HISTORY,
  SEPOLIA_LOGS,
  V3_CHAIN_ID,
  V3_EVM,
  V3_SUBSTRATE_HTTP,
  V3_SUBSTRATE_WS,
} from "./endpoints.ts";

/** Sepolia's per-transaction gas cap. */
export const TX_GAS_CAP = 16_777_216;

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
