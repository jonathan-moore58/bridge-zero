// The Verify page's runs, one per transfer and visit, kept as the Lab keeps its answers: the page
// draws them, and starts, repeats and leaves them here. The checks and the reads behind them load
// with the first run (./verify.ts and ../lib/proof/verify.ts), as noble's ed25519 loads with the
// first signature check. Nothing polls: a run reads once, and Check again reads again.

import { records } from "../lib/chains.ts";
import type { History } from "../lib/proof/verify.ts";
import { refOf, type DestKey } from "./dests.ts";
import { Box } from "./store.ts";
import { burnLabel, burnRows, lockRows, type BeyondLock, type PickRow, type VerifyHead, type VerifyState } from "./verify-model.ts";

export type { VerifyHead, VerifyState } from "./verify-model.ts";

/** The recorded locks and burns, newest first: the picker's lists, and the heads the card shows at once. */
export const LOCKS: readonly PickRow[] = lockRows(records);
export const BURNS: readonly PickRow[] = burnRows(records);

/** Where a V3 light client's keys come from: the check of the newest recorded lock to its chain, opened at its keys panel. */
export function keysHref(dest: DestKey): string {
  const r = LOCKS.find((l) => l.dest === dest);
  return r ? `#/verify/${r.id}?panel=keys` : "#/verify";
}

/** A transfer's head from the records, when they hold it. */
export function headOf(id: string): VerifyHead | null {
  const row = [...LOCKS, ...BURNS].find((r) => r.id === id);
  if (row) return { dir: row.dir, dest: row.dest, label: row.label, at: row.at, amount: row.amount, substrate: row.substrate };
  const k = refOf(id);
  // A burn's id names its chain; a lock's chain is in its log, read first.
  return k?.dir === "back" ? { dir: "back", dest: k.dest, label: burnLabel(k.dest, k.n), at: null, amount: null, substrate: false } : null;
}

export const runs = new Box<ReadonlyMap<string, VerifyState>>(new Map());

export function setRun(id: string, s: VerifyState): void {
  runs.set((m) => new Map(m).set(id, s));
}

function dropRun(id: string): void {
  runs.set((m) => {
    if (!m.has(id)) return m;
    const next = new Map(m);
    next.delete(id);
    return next;
  });
}

/** Each id's visit: leaving the page or Check again starts a new one, and a run of an older visit stops at its next step. */
const visits = new Map<string, number>();

/** Runs `id`, unless a run of it is under way or finished on this page already; `again` runs it anew. */
export function startVerify(id: string, again = false): void {
  const cur = runs.get().get(id);
  if (!again && cur && cur.status !== "error") return;
  const visit = (visits.get(id) ?? 0) + 1;
  visits.set(id, visit);
  const head = headOf(id);
  setRun(id, { status: "resolving", head });
  const stopped = () => visits.get(id) !== visit;
  void import("./verify.ts").then(
    (m) => m.runVerify(id, { stopped }),
    () => {
      if (!stopped()) setRun(id, { status: "error", head, why: "The checks did not load: the page's code for them could not be fetched." });
    },
  );
}

/** Leaving the page: a run under way stops, and the next visit starts it again; a finished one stays, as the Lab keeps its answers. */
export function leaveVerify(id: string): void {
  visits.set(id, (visits.get(id) ?? 0) + 1);
  const cur = runs.get().get(id);
  if (cur && !(cur.status === "run" && cur.run.done) && cur.status !== "none") dropRun(id);
}

// ---------------------------------------------------------------------------------------------
// The key history, on demand, per destination

export const histories = new Box<ReadonlyMap<DestKey, History | "loading" | "failed">>(new Map());
const historyVisits = new Map<DestKey, number>();

/** Walks `dest`'s light client from its checkpoint, in this browser: about 2 requests per set change. */
export function startHistory(dest: DestKey): void {
  const visit = (historyVisits.get(dest) ?? 0) + 1;
  historyVisits.set(dest, visit);
  histories.set((m) => new Map(m).set(dest, "loading"));
  const stopped = () => historyVisits.get(dest) !== visit;
  void import("./verify.ts").then(
    (m) => m.runHistory(dest, { stopped }),
    () => {
      if (!stopped()) histories.set((m) => new Map(m).set(dest, "failed"));
    },
  );
}

/** Leaving the page stops a walk under way; a finished one stays. */
export function leaveHistory(dest: DestKey): void {
  const cur = histories.get().get(dest);
  if (cur === "loading" || (cur && cur !== "failed" && !cur.done)) {
    historyVisits.set(dest, (historyVisits.get(dest) ?? 0) + 1);
    histories.set((m) => {
      const next = new Map(m);
      next.delete(dest);
      return next;
    });
  }
}

/** The transfer a transaction hash belongs to, read from the chains: its id, or null. */
export function lookupHash(hash: string): Promise<string | null> {
  return import("./verify.ts").then((m) => m.lookupHash(hash));
}

// ---------------------------------------------------------------------------------------------
// Locks past the records, for the picker: read once a page load, nothing polls

export const beyond = new Box<readonly BeyondLock[]>([]);
let beyondRead = false;

/**
 * Reads the locks the vault holds past the records, once: the picker lists them, marked as read
 * from V3. A lock whose Locked log was not read is asked for again when the picker next opens.
 */
export function startBeyond(): void {
  if (beyondRead) return;
  beyondRead = true;
  void import("./verify.ts")
    .then((m) => m.readBeyond((list) => beyond.set(list), beyond.get()))
    .then(() => {
      if (beyond.get().some((x) => x.read === "failed")) beyondRead = false;
    })
    .catch(() => {
      // Not read: the picker lists the records' locks, and the field takes any other.
      beyondRead = false;
    });
}
