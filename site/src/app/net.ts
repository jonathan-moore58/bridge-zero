// The bridge's status: the V3 light client on a destination against V3 itself, the one the page is
// about (the bridge card's, or a transfer's: App.tsx). Sepolia's from the live reads the status
// page makes too; a rollup's from rollups.ts, read while a page shows it.

import { setsBehind } from "../lib/lc-read.ts";
import { useField } from "../lib/live.ts";
import { destOf, type DestKey } from "./dests.ts";
import { useRollup } from "./rollups.ts";

export type NetKey = "checking" | "ready" | "relay" | "paused" | "rpc";

export interface NetState {
  key: NetKey;
  cls: "verify" | "trust" | "revert" | "muted";
  label: string;
  long: string;
  /** Validator-set changes the client is behind V3 (relay). */
  behind: number;
  /** The chain whose RPC did not answer (rpc): V3, or the destination. */
  down: "v3" | DestKey | null;
  /** The destination whose light client this is. */
  dest: DestKey;
}

/** The status of the light client on `dest`, Sepolia's unless given: the top bar's, and the card's. */
export function useNet(dest: DestKey = "sepolia"): NetState {
  const lc = useField("lc.v3");
  const chain = useField("chain.v3");
  // Both rollups' fields, whichever the card shows: the hooks run in the same order on every render.
  const base = useRollup("base-sepolia");
  const arbitrum = useRollup("arbitrum-sepolia");
  const d = destOf(dest);
  const client = dest === "sepolia" ? lc : dest === "base-sepolia" ? base : arbitrum;
  // Sepolia's client is "the V3 light client", as the status page has always named it; a rollup's names its chain.
  const on = dest === "sepolia" ? "" : ` on ${d.short}`;
  const v3Down = chain.status === "recorded" || chain.status === "error";
  const destDown = client.status === "recorded" || client.status === "error";
  if (v3Down || destDown) {
    const name = v3Down ? "Portaldot V3" : d.short;
    return { key: "rpc", cls: "muted", label: "Reading records", long: `${name}'s RPC did not answer. Values shown are recorded.`, behind: 0, down: v3Down ? "v3" : dest, dest };
  }
  const c = client.value;
  const h = chain.value;
  if (client.status === "loading" || chain.status === "loading" || !c || !h) {
    return { key: "checking", cls: "muted", label: "Checking", long: `Reading the V3 light client on ${d.short}, and V3 itself.`, behind: 0, down: null, dest };
  }
  if (c.paused || c.halted) {
    return {
      key: "paused",
      cls: "revert",
      label: c.halted ? "Client halted" : "Client paused",
      long: c.halted ? `The V3 light client${on} is halted: it met a validator-set change it cannot import.` : `The V3 light client${on} is paused by its admin.`,
      behind: 0,
      down: null,
      dest,
    };
  }
  const behind = setsBehind(c.setId, h.setId);
  if (behind) {
    const s = behind === 1 ? "" : "s";
    // The relayer's to import, or a mint's: one made now imports the changes first (sends.ts), so nobody waits.
    return {
      key: "relay",
      cls: "trust",
      label: "Relay needed",
      long: `The V3 light client${on} is ${behind} validator-set change${s} behind V3. A mint made now imports ${behind === 1 ? "it" : "them"} first.`,
      behind,
      down: null,
      dest,
    };
  }
  return { key: "ready", cls: "verify", label: "Bridge ready", long: `The V3 light client${on} is at V3's validator set.`, behind: 0, down: null, dest };
}
