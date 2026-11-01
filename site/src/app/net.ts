// The bridge's status: the V3 light client on a destination against V3 itself, the one the page is
// about (the bridge card's, or a transfer's: App.tsx). Sepolia's from the live reads the status
// page makes too; a rollup's from rollups.ts, read while a page shows it. Worked out by
// netstate.ts; this file reads the fields and remembers, for each destination, when the page read
// its client back at V3's set after a read that found it behind.

import { useField } from "../lib/live.ts";
import { ALL_DESTS, rollupsOf, type DestKey, type RollupKey } from "./dests.ts";
import { NO_CATCH_UP, liveSets, netOf, nextCatchUp, type CatchUp, type NetState } from "./netstate.ts";
import { useRollup } from "./rollups.ts";

/** Every configured destination's client but Sepolia's, in the config's order: the hooks below run for each, in this order, on every render. */
const ROLLUP_KEYS: readonly RollupKey[] = rollupsOf(ALL_DESTS).map((d) => d.key);

export type { NetKey, NetState } from "./netstate.ts";

/** For each destination, its client's last live read and when one found it caught up, for as long as the page is open. */
const catchUps = new Map<DestKey, CatchUp>();

/** When the page read the light client on `dest` back at V3's set after a read that found it behind (ms), null when it has not: Activity's offers wait for it as the transfer screen's do. */
export const caughtUpOf = (dest: DestKey): number | null => catchUps.get(dest)?.caughtUpAt ?? null;

/** The status of the light client on `dest`, Sepolia's unless given: the top bar's, and the card's. */
export function useNet(dest: DestKey = "sepolia"): NetState {
  const lc = useField("lc.v3");
  const chain = useField("chain.v3");
  // Every rollup's field, whichever the card shows: the hooks run in the same order on every render.
  const rollups = new Map(ROLLUP_KEYS.map((k) => [k, useRollup(k)] as const));
  const client = dest === "sepolia" ? lc : rollups.get(dest)!;
  // Every answer of these reads draws the page again (the hooks above subscribe to them), so the read
  // that finds the client caught up is seen after the one that found it behind.
  const before = catchUps.get(dest) ?? NO_CATCH_UP;
  const after = nextCatchUp(before, liveSets(client, chain));
  if (after !== before) catchUps.set(dest, after);
  return netOf(client, chain, dest, after.caughtUpAt);
}
