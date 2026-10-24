// Unit tests of records.ts, offline: a save of deployments/v3-testnet.json from a copy read long
// before keeps what another process added or settled in between, and two saves never run at once.
//
//   npm test

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { mergeV3Record, saveMerged, withFileLock } from "./records.js";
import { takeLock } from "./watch.js";

const approval = (hash: string, status: string, extra: object = {}) => ({ member: 1, action: "open", extrinsicHash: hash, status, block: null, ...extra });
const round = (first: string, status: string, approvals: object[], extra: object = {}) => ({ status, call: { hash: "0xca11" }, burn: { burnId: "0xb0", burnNonce: "1" }, approvals: approvals.length > 0 ? approvals : [approval(first, "submitted")], ...extra });
const base = () => ({ network: "portaldot-v3-testnet", vault: { status: "deployed", address: "0xva" }, locks: [] as object[] });
const copy = <T>(x: T): T => structuredClone(x);

describe("a save of the record from a stale copy", () => {
  it("keeps a lock another tool added, and the watcher's approval a stale save of another tool would drop", () => {
    const read = { ...base(), releases: [] as object[] };
    // The watcher records its opening; meanwhile v3-vault lock --send records a lock.
    const watcher = copy(read);
    watcher.releases.push(round("0xa1", "open", []));
    const vault = copy(read);
    vault.locks.push({ status: "signed", txHash: "0x10c4" });
    // v3-vault saves first, then the watcher: the lock stays.
    const afterWatcher = mergeV3Record(copy(vault), copy(watcher), { vault: "disk" });
    assert.deepEqual(afterWatcher.locks, [{ status: "signed", txHash: "0x10c4" }]);
    assert.equal(afterWatcher.releases.length, 1);
    // The watcher saves first, then v3-vault from its stale copy: the watcher's submitted opening stays.
    const afterVault = mergeV3Record(copy(watcher), copy(vault), { vault: "mine" }) as typeof watcher;
    assert.deepEqual(
      (afterVault.releases[0] as { approvals: { extrinsicHash: string; status: string }[] }).approvals.map((a) => [a.extrinsicHash, a.status]),
      [["0xa1", "submitted"]],
    );
    assert.equal(afterVault.locks.length, 1);
  });

  it("never sets an entry another process settled back to submitted or signed", () => {
    const stale = { ...base(), releases: [round("0xa1", "open", [])], committeeFunding: [{ extrinsicHash: "0xf1", status: "submitted" }], locks: [{ txHash: "0x10c4", status: "signed" }] };
    const disk = {
      ...base(),
      releases: [round("0xa1", "released", [approval("0xa1", "final", { block: { number: 7 } }), approval("0xa2", "final", { action: "execute" })], { released: { block: { number: 8 } }, finalizedCheck: { ok: true } })],
      committeeFunding: [{ extrinsicHash: "0xf1", status: "final", block: { number: 3 } }],
      locks: [{ txHash: "0x10c4", status: "locked" }],
    };
    const merged = mergeV3Record(copy(disk), copy(stale), { vault: "disk" }) as unknown as typeof disk;
    const r = merged.releases[0] as unknown as { status: string; approvals: { extrinsicHash: string; status: string }[]; released?: unknown; finalizedCheck?: unknown };
    assert.equal(r.status, "released");
    assert.deepEqual(r.released, { block: { number: 8 } });
    assert.deepEqual(r.finalizedCheck, { ok: true });
    assert.deepEqual(r.approvals.map((a) => [a.extrinsicHash, a.status]), [["0xa1", "final"], ["0xa2", "final"]]);
    assert.deepEqual(merged.committeeFunding, [{ extrinsicHash: "0xf1", status: "final", block: { number: 3 } }]);
    assert.deepEqual(merged.locks, [{ txHash: "0x10c4", status: "locked" }]);
  });

  it("keeps this process's own progress over the file's older state", () => {
    const disk = { ...base(), releases: [round("0xa1", "open", [])] };
    const mine = { ...base(), releases: [round("0xa1", "released", [approval("0xa1", "final"), approval("0xa2", "final", { action: "execute" })], { by: "fast" })] };
    const merged = mergeV3Record(copy(disk), mine, { vault: "disk" });
    assert.equal(merged, mine, "merged in place");
    const r = merged.releases[0] as unknown as { status: string; by: string; approvals: { status: string }[] };
    assert.equal(r.status, "released");
    assert.equal(r.by, "fast");
    assert.deepEqual(r.approvals.map((a) => a.status), ["final", "final"]);
  });

  it("takes the vault from the file for release.ts, and from memory for v3-vault.ts", () => {
    const disk = { ...base(), vault: { status: "deployed", address: "0xnew" } };
    assert.deepEqual(mergeV3Record(copy(disk), base(), { vault: "disk" }).vault, { status: "deployed", address: "0xnew" });
    assert.deepEqual(mergeV3Record(copy(disk), base(), { vault: "mine" }).vault, { status: "deployed", address: "0xva" });
  });
});

describe("the record's lock", () => {
  // One folder for every run, its files written over: nothing to clean up.
  const dir = join(tmpdir(), "bz-records-test");
  mkdirSync(dir, { recursive: true });

  it("merges under the lock, and waits for another writer instead of writing over it", () => {
    const path = join(dir, "v3-testnet.json");
    writeFileSync(path, JSON.stringify({ ...base(), locks: [{ txHash: "0x10c4", status: "locked" }] }));
    saveMerged(path, { ...base(), releases: [round("0xa1", "open", [])] }, { vault: "disk" });
    const saved = JSON.parse(readFileSync(path, "utf8")) as { locks: unknown[]; releases: unknown[] };
    assert.equal(saved.locks.length, 1);
    assert.equal(saved.releases.length, 1);
    // Another process holds the lock: a save waits, and gives up after its wait.
    const held = takeLock(`${path}.lock`, () => undefined);
    assert.ok(held);
    try {
      assert.throws(() => withFileLock(path, () => "written", 300), /held by another process/);
    } finally {
      held!.release();
    }
    assert.equal(withFileLock(path, () => "written", 300), "written");
  });

  it("takes over a lock left more than a minute ago, though its process id runs again", () => {
    const path = join(dir, "v3-testnet-crashed.json");
    const lock = `${path}.lock`;
    // A save that crashed holding the lock, its process id now another running process's.
    writeFileSync(lock, JSON.stringify({ pid: process.ppid, token: "a crashed save" }));
    const then = new Date(Date.now() - 2 * 60_000); // above RECORD_LOCK_STALE
    utimesSync(lock, then, then);
    assert.equal(withFileLock(path, () => "written", 300), "written");
  });
});
