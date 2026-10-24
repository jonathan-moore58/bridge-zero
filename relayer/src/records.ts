// Writing deployments/v3-testnet.json from more than one process: release.ts (the watcher, an
// approval by hand, fund) and v3-vault.ts (deploy, lock) each keep a copy of the record in memory,
// for as long as a command runs, and save it whole. Every save takes <record>.lock (watch.ts
// takeLock's scheme) for the read-modify-write alone, reads the file again, merges it into the
// copy in memory, and writes that: an entry another process added is kept, and an entry another
// process settled is not set back to submitted. release.ts, v3-vault.ts and records.test.ts use it.

import { existsSync, readFileSync } from "node:fs";
import { writeJsonAtomic } from "../../contracts/script/lib/sepolia.mjs";
import { takeLock } from "./watch.js";

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** How long a save waits for another process's save. */
export const RECORD_LOCK_WAIT = 30_000;
/**
 * How long the record's lock may go unrefreshed before it counts as stale although its process id
 * runs: a save holds it for milliseconds, and Windows may give the id of a process that died
 * holding it to another process soon after.
 */
export const RECORD_LOCK_STALE = 60_000;

/** Runs `fn` while this process holds `<path>.lock`, waiting up to `wait` ms for another holder; throws when it cannot be taken. A lock older than RECORD_LOCK_STALE is taken over. */
export function withFileLock<T>(path: string, fn: () => T, wait = RECORD_LOCK_WAIT): T {
  const lockPath = `${path}.lock`;
  const until = Date.now() + wait;
  for (;;) {
    const lock = takeLock(lockPath, () => undefined, RECORD_LOCK_STALE);
    if (lock) {
      try {
        return fn();
      } finally {
        lock.release();
      }
    }
    if (Date.now() >= until) throw new Error(`${lockPath} is held by another process (waited ${wait / 1000} s)`);
    pause(100);
  }
}

type Entry = Record<string, unknown>;

/** Not settled yet: an approval or transfer submitted, a lock signed. */
const settling = (e: Entry) => e.status === "submitted" || e.status === "signed";

/** Merges `disk` into `mine`, in place: all of disk's fields when it is settled and mine is not, else the fields mine lacks. */
function mergeEntry(mine: Entry, disk: Entry): void {
  if (settling(mine) && !settling(disk)) Object.assign(mine, disk);
  else for (const [k, v] of Object.entries(disk)) if (!(k in mine)) mine[k] = v;
}

/** Both lists merged by key, disk's order first, then the entries only `mine` has; an entry in both is mine's object, merged. */
function mergeList<T extends Entry>(mine: T[] | undefined, disk: T[] | undefined, key: (e: T) => string, merge: (m: T, d: T) => void): T[] | undefined {
  if (!Array.isArray(disk)) return mine;
  if (!Array.isArray(mine)) return disk;
  const byKey = new Map(mine.map((e) => [key(e), e]));
  const out: T[] = [];
  const used = new Set<T>();
  for (const d of disk) {
    const m = byKey.get(key(d));
    if (m && !used.has(m)) {
      merge(m, d);
      out.push(m);
      used.add(m);
    } else out.push(d);
  }
  for (const m of mine) if (!used.has(m)) out.push(m);
  return out;
}

/** A release round's key: its first approval (recorded with the round, in the same save), else its call and burn. */
const roundKey = (r: Entry) => {
  const first = (r.approvals as Entry[] | undefined)?.[0];
  return typeof first?.extrinsicHash === "string" ? first.extrinsicHash : `${(r.call as Entry | undefined)?.hash}/${(r.burn as Entry | undefined)?.burnId}`;
};

/** A release round merged: its approvals by extrinsic hash; disk's outcome when mine is still open and disk's is not; the fields mine lacks. */
function mergeRound(mine: Entry, disk: Entry): void {
  mine.approvals = mergeList(mine.approvals as Entry[] | undefined, disk.approvals as Entry[] | undefined, (a) => String(a.extrinsicHash), mergeEntry) ?? [];
  if (mine.status === "open" && disk.status !== "open") {
    for (const k of ["status", "released", "multisig"]) if (k in disk) mine[k] = disk[k];
  }
  for (const [k, v] of Object.entries(disk)) if (!(k in mine)) mine[k] = v;
}

/**
 * deployments/v3-testnet.json as `disk` holds it now, merged into `mine` (in place; mine is
 * returned): releases by round (its first approval) and their approvals by extrinsic hash,
 * committeeFunding and failedDeploys by extrinsic hash, locks by transaction hash. Of an entry in
 * both, disk's is taken when it is settled and mine is not (submitted or signed). `vault` is
 * mine's for the tool that deploys it (v3-vault.ts), disk's for one that only reads it.
 */
export function mergeV3Record<R extends object>(disk: R, mine: R, o: { vault: "mine" | "disk" }): R {
  const d = disk as Entry;
  const m = mine as Entry;
  m.releases = mergeList(m.releases as Entry[] | undefined, d.releases as Entry[] | undefined, roundKey, mergeRound);
  m.committeeFunding = mergeList(m.committeeFunding as Entry[] | undefined, d.committeeFunding as Entry[] | undefined, (e) => String(e.extrinsicHash), mergeEntry);
  m.failedDeploys = mergeList(m.failedDeploys as Entry[] | undefined, d.failedDeploys as Entry[] | undefined, (e) => String(e.extrinsicHash), mergeEntry);
  m.locks = mergeList(m.locks as Entry[] | undefined, d.locks as Entry[] | undefined, (e) => String(e.txHash), mergeEntry) ?? [];
  if (o.vault === "disk" && "vault" in d) m.vault = d.vault;
  for (const k of ["releases", "committeeFunding", "failedDeploys"]) if (m[k] === undefined) delete m[k];
  return mine;
}

/** Saves `record` to `path`: under the record's lock, the file read again and merged into it (mergeV3Record), then written atomically. */
export function saveMerged<R extends object>(path: string, record: R, o: { vault: "mine" | "disk" }): void {
  withFileLock(path, () => {
    if (existsSync(path)) mergeV3Record(JSON.parse(readFileSync(path, "utf8")) as R, record, o);
    writeJsonAtomic(path, record);
  });
}
