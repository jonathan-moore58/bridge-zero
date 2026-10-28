// The built pages' Content-Security-Policy: scripts, styles, fonts and images from the page itself,
// and connections to the RPC nodes the page reads and nothing else. The bridge app also reads the
// rollups' V3 light clients (its Network page), through the RPCs src/app/dests.ts gives each
// destination: its policy adds exactly those; the status page reads no rollup and its policy has none.

import { DESTS } from "../src/app/dests.ts";
import { MAINNET_SUBSTRATE_WS, SEPOLIA, V3_EVM, V3_SUBSTRATE_HTTP, V3_SUBSTRATE_WS } from "../src/lib/endpoints.ts";

/** Sepolia's and Portaldot's nodes (src/lib/endpoints.ts), which both pages read. */
export const BRIDGE_NODES = [...SEPOLIA, ...V3_EVM, V3_SUBSTRATE_HTTP, V3_SUBSTRATE_WS, MAINNET_SUBSTRATE_WS].map((e) => e.url);

/** The rollups' RPCs: the ones the Network page reads each rollup's V3 light client through. */
export const ROLLUP_NODES = DESTS.filter((d) => d.key !== "sepolia").flatMap((d) => d.rpcs.map((e) => e.url));

/** Endpoints a page may reach: the RPC nodes it reads and nothing else; `app`, the bridge app, reads the rollups' too. */
export const connectOf = (app: boolean): string[] => [...new Set([...BRIDGE_NODES, ...(app ? ROLLUP_NODES : [])])];

export function cspPolicy(app: boolean): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connectOf(app).join(" ")}`,
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join("; ");
}
