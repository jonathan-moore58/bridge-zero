// The bridge's status: the V3 light client on Sepolia against V3 itself, from the live reads the
// status page makes too.

import { useField } from "../lib/live.ts";

export type NetKey = "checking" | "ready" | "relay" | "paused" | "rpc";

export interface NetState {
  key: NetKey;
  cls: "verify" | "trust" | "revert" | "muted";
  label: string;
  long: string;
  /** Validator-set changes the client is behind V3 (relay). */
  behind: number;
  /** The chain whose RPC did not answer (rpc). */
  down: "v3" | "sepolia" | null;
}

export function useNet(): NetState {
  const lc = useField("lc.v3");
  const chain = useField("chain.v3");
  const v3Down = chain.status === "recorded" || chain.status === "error";
  const sepoliaDown = lc.status === "recorded" || lc.status === "error";
  if (v3Down || sepoliaDown) {
    const name = v3Down ? "Portaldot V3" : "Sepolia";
    return { key: "rpc", cls: "muted", label: "Reading records", long: `${name}'s RPC did not answer. Values shown are recorded.`, behind: 0, down: v3Down ? "v3" : "sepolia" };
  }
  const c = lc.value;
  const h = chain.value;
  if (lc.status === "loading" || chain.status === "loading" || !c || !h) {
    return { key: "checking", cls: "muted", label: "Checking", long: "Reading the V3 light client on Sepolia, and V3 itself.", behind: 0, down: null };
  }
  if (c.paused || c.halted) {
    return {
      key: "paused",
      cls: "revert",
      label: c.halted ? "Client halted" : "Client paused",
      long: c.halted ? "The V3 light client is halted: it met a validator-set change it cannot import." : "The V3 light client is paused by its admin.",
      behind: 0,
      down: null,
    };
  }
  const behind = h.setId !== null && h.setId > c.setId ? Number(h.setId - c.setId) : 0;
  if (behind) {
    const s = behind === 1 ? "" : "s";
    return { key: "relay", cls: "trust", label: "Relay needed", long: `The V3 light client is ${behind} validator-set change${s} behind V3.`, behind, down: null };
  }
  return { key: "ready", cls: "verify", label: "Bridge ready", long: "The V3 light client is at V3's validator set.", behind: 0, down: null };
}
