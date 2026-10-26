// The deployed contracts and the page's endpoints, as planMint takes them in the app. Kept apart
// from the proof modules, which take them as arguments so that node --test runs them: this module
// reads the build's records (virtual:records), which only Vite resolves.

import { LC, MINTER, SEPOLIA, SEPOLIA_CHAIN_ID, V3_CHAIN_ID, V3_SUBSTRATE_HTTP, V3_SUBSTRATE_WS, VAULT } from "../chains.ts";
import { registry } from "../live.ts";
import { SubstrateClient } from "../rpc.ts";
import { MULTICALL3 } from "./calldata.ts";
import type { ProofEnv } from "./plan.ts";

let env: ProofEnv | null = null;

/** GrandpaLightClient #2, BridgeMinter, the vault and Multicall3; Sepolia's public endpoints and the V3 node. */
export function proofEnv(): ProofEnv {
  env ??= {
    sepolia: SEPOLIA,
    v3: new SubstrateClient(V3_SUBSTRATE_HTTP, V3_SUBSTRATE_WS),
    lightClient: LC.v3.address,
    minter: MINTER,
    vault: VAULT,
    multicall: MULTICALL3,
    v3ChainId: V3_CHAIN_ID,
    sepoliaChainId: SEPOLIA_CHAIN_ID,
    registry,
  };
  return env;
}
