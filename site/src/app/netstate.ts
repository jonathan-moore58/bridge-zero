// The bridge's status: the V3 light client on a destination against V3 itself, from the two reads
// net.ts makes (the client on its chain, V3's finalized head), by the rule every card follows when a
// read fails (../lib/field.ts): a failed refresh keeps the last live answer, which the status then
// says is the read before. And what the page remembers between reads: when it read a client that
// was behind V3's set back at it. Pure, so that node --test runs it.

import type { Field } from "../lib/field.ts";
import { setsBehind } from "../lib/lc-read.ts";
import { destOf, type DestKey } from "./dests.ts";

export type NetKey = "checking" | "ready" | "relay" | "paused" | "rpc";

/** What the status takes of a light client's read: its set, its latest header and its pause flags (../lib/live.ts, ../lib/lc-read.ts). */
export interface ClientRead {
  setId: bigint;
  latestNumber: number;
  paused: boolean | null;
  halted: boolean | null;
}

/** What the status takes of V3's read: the validator set at its finalized head (null when the node gave none). */
export interface V3Read {
  setId: bigint | null;
}

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
  /** The number of the client's latest header, as last read (null before any value): auto-mint mints a lock at or below it with no import, behind V3's set or not. */
  latest: number | null;
  /** The last refresh of the client or of V3 failed: the status is the read before it. */
  stale: boolean;
  /** When a live read showed the client back at V3's set after one that showed it behind (ms), while this page was open; null when none did. */
  caughtUpAt: number | null;
}

/** A live answer whose last refresh failed: ../lib/field.ts keeps it, with the error. */
const staleField = (f: Field<unknown>): boolean => f.status === "live" && f.error !== undefined;

/**
 * The status of the light client on `dest` from its read `client` and V3's `chain`: the top bar's,
 * the card's and the transfer screen's. `caughtUpAt`: when the page read it catch up (nextCatchUp).
 */
export function netOf(client: Field<ClientRead>, chain: Field<V3Read>, dest: DestKey, caughtUpAt: number | null = null): NetState {
  const d = destOf(dest);
  // Sepolia's client is "the V3 light client", as the status page has always named it; a rollup's names its chain.
  const on = dest === "sepolia" ? "" : ` on ${d.short}`;
  const c = client.value;
  const h = chain.value;
  const stale = staleField(client) || staleField(chain);
  const base = { dest, latest: c?.latestNumber ?? null, stale, caughtUpAt, down: null, behind: 0 };
  // The read the status is drawn from failed its last refresh: said where the status is spelled out.
  const said = (long: string) => (stale ? `${long} The last refresh failed, so this is the read before it.` : long);
  const v3Down = chain.status === "recorded" || chain.status === "error";
  const destDown = client.status === "recorded" || client.status === "error";
  if (v3Down || destDown) {
    const name = v3Down ? "Portaldot V3" : d.short;
    return { ...base, key: "rpc", cls: "muted", label: "Reading records", long: `${name}'s RPC did not answer. Values shown are recorded.`, down: v3Down ? "v3" : dest };
  }
  if (client.status === "loading" || chain.status === "loading" || !c || !h) {
    return { ...base, key: "checking", cls: "muted", label: "Checking", long: `Reading the V3 light client on ${d.short}, and V3 itself.` };
  }
  if (c.paused || c.halted) {
    return {
      ...base,
      key: "paused",
      cls: "revert",
      label: c.halted ? "Client halted" : "Client paused",
      long: said(c.halted ? `The V3 light client${on} is halted: it met a validator-set change it cannot import.` : `The V3 light client${on} is paused by its admin.`),
    };
  }
  const behind = setsBehind(c.setId, h.setId);
  if (behind) {
    const s = behind === 1 ? "" : "s";
    // The relayer's to import, or a mint's: one the visitor sends imports the changes first (sends.ts); auto-mint waits for the relayer (handoff.ts).
    return {
      ...base,
      key: "relay",
      cls: "trust",
      label: "Relay needed",
      long: said(`The V3 light client${on} is ${behind} validator-set change${s} behind V3. A mint made now imports ${behind === 1 ? "it" : "them"} first.`),
      behind,
    };
  }
  return { ...base, key: "ready", cls: "verify", label: "Bridge ready", long: said(`The V3 light client${on} is at V3's validator set.`) };
}

/** A live read of both sets, each answered on its last refresh, the client neither paused nor halted: the changes it is behind V3, and when the later of the two answered (ms). Else null. */
export function liveSets(client: Field<ClientRead>, chain: Field<V3Read>): { behind: number; at: number } | null {
  const c = client.value;
  const h = chain.value;
  if (client.status !== "live" || chain.status !== "live" || staleField(client) || staleField(chain)) return null;
  if (!c || !h || h.setId === null || c.paused || c.halted) return null;
  return { behind: setsBehind(c.setId, h.setId), at: Math.max(client.at ?? 0, chain.at ?? 0) };
}

/** What the page remembers of a destination's client: the changes the last live read found it behind (null before one), and when a read found it caught up. */
export interface CatchUp {
  behind: number | null;
  caughtUpAt: number | null;
}

export const NO_CATCH_UP: CatchUp = { behind: null, caughtUpAt: null };

/**
 * After a read (liveSets; null for any other): a client read behind V3's set and then at it caught
 * up when the second read answered. The same object back when nothing changed, so the status is
 * worked out on every render at no cost.
 */
export function nextCatchUp(prev: CatchUp, read: { behind: number; at: number } | null): CatchUp {
  if (read === null || read.behind === prev.behind) return prev;
  if (read.behind === 0 && prev.behind !== null && prev.behind > 0) return { behind: 0, caughtUpAt: read.at };
  return { behind: read.behind, caughtUpAt: prev.caughtUpAt };
}
