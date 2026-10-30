// The build-time records, and what the page recomputes from them: amounts, commitments, keys and
// SS58 addresses.

import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildRecords,
  checkReadmeTiming,
  latestRecordedMint,
  lockTotals,
  markStaleOutputs,
  parseEvidence,
  parseRoadmap,
  parseVerify,
  readAutoMints,
  readmeTimingSection,
} from "../build/records.ts";
import { formatDuration, formatInt, formatUnits } from "../src/lib/format.ts";
import { checksumAddress } from "../src/lib/hex.ts";
import { keccak256 } from "../src/lib/hashes.ts";
import { burnId, childTrieKey, commitmentSlot, lockCommitment } from "../src/lib/proofs.ts";
import { ss58 } from "../src/lib/ss58.ts";

const here = dirname(fileURLToPath(import.meta.url));
// RECORDS_ROOT runs these tests against another checkout's records (a newer README, say).
const repo = process.env.RECORDS_ROOT ?? join(here, "..", "..");
const r = buildRecords(repo);

test("the records hold the run of lock 0 and its six reverted copies", () => {
  assert.ok(r.evidence.length >= 38);
  assert.equal(r.bridge.row, 32);
  assert.equal(r.bridge.mint.gasUsed, 2952838);
  assert.equal(r.bridge.finality.block.number, 108424);
  assert.equal(r.bridge.finality.setId, 30);
  assert.equal(r.bridge.lock.block.number, 101009);
  assert.deepEqual(
    r.attacks.map((a) => [a.part, a.row]),
    [
      ["signature", 33],
      ["header", 34],
      ["proof", 35],
      ["amount", 36],
      ["recipient", 37],
      ["replay", 38],
    ],
  );
  assert.equal(r.lightClients.mainnet.checkpointRow, 1);
  assert.equal(r.lightClients.v3.checkpointRow, 5);
  assert.equal(r.lightClients.mainnet.fixtureSet.keys.length, 10);
  assert.equal(r.lightClients.mainnet.blockTimeSec, 60);
  assert.equal(r.lightClients.v3.blockTimeSec, 6);
});

test("the page recomputes lock 0's commitment and slot key as the records hold them", () => {
  const l = r.bridge.lock;
  assert.equal(
    lockCommitment({ v3ChainId: 420420777n, vault: r.bridge.vault.address, dstChainId: BigInt(l.dstChainId), minter: l.dstMinter, recipient: l.recipient, amountNative: BigInt(l.amountNative), nonce: 0n }),
    l.commitment,
  );
  assert.equal(commitmentSlot(0n), r.bridge.proofs.slot.index);
  assert.equal(childTrieKey(0n), r.bridge.proofs.slot.key);
  for (const b of r.returnPath.burns) {
    if (b.burnNonce === null || b.burnId === null) continue;
    assert.equal(burnId(11155111n, r.sepolia.minter, BigInt(b.burnNonce)), b.burnId, `burn ${b.burnNonce}`);
  }
});

test("totals follow the records: minted, pending, burned, released", () => {
  const t = r.totals;
  assert.equal(BigInt(t.supply), BigInt(t.minted) - BigInt(t.burned));
  assert.ok(t.locks >= 2, "locks 0 and 1");
  assert.ok(BigInt(t.minted) >= 200000000000000n, "1 wtPOT each for locks 0 and 1");
  // Over the locks the records know: what the vault took (the V3 record's amount of each lock it
  // holds) less what the committee released, which is what was minted, on Sepolia and on the
  // rollups, plus the recorded locks not minted yet, less the same, only while the mint records
  // agree with the V3 record on every lock.
  const released = r.returnPath.releases.filter((x) => x.status === "released").reduce((n, x) => n + BigInt(x.amountNative ?? "0"), 0n);
  assert.equal(BigInt(t.outstandingNative), BigInt(t.minted) + BigInt(t.mintedRollups) + BigInt(t.pending) - released);
  assert.ok(BigInt(t.pending) >= 0n);
  // Lock 2 was minted by auto-mint, from its own key (deployments/automint-sepolia-*.jsonl).
  if (t.locks >= 3) assert.ok(BigInt(t.minted) >= 201000000000000n, "lock 2's 0.01 wtPOT, minted by auto-mint");
  if (t.locks === 2 && released === 50000000000000n) {
    assert.equal(t.supply, "150000000000000");
    assert.equal(t.outstandingNative, "150000000000000");
  }
});

test("a recorded lock not minted yet is pending, and an auto-mint of a lock the V3 record lacks counts with what its history names", () => {
  const D = "0xd9838a86cf83c28ee486544060d1ca4ca2971071" as const;
  const lock = (nonce: number, amountNative: bigint) => ({ nonce, amountNative, recipient: D });
  // Locks 0 to 3 recorded, 0 to 2 minted: lock 3 (0.001 tPOT, sent from a Substrate account) waits for its mint.
  const recorded = [lock(0, 10n ** 14n), lock(1, 10n ** 14n), lock(2, 10n ** 12n), lock(3, 10n ** 11n)];
  const minted = [lock(0, 10n ** 14n), lock(1, 10n ** 14n), lock(2, 10n ** 12n)];
  const a = lockTotals(recorded, minted);
  assert.deepEqual([a.locks, a.minted, a.pending, a.locked], [4, 201n * 10n ** 12n, 10n ** 11n, 2011n * 10n ** 11n]);
  // Then auto-mint mints lock 3, and lock 4, which the V3 record lacks (sent from the app), from its history.
  const b = lockTotals(recorded, [...minted, lock(3, 10n ** 11n), lock(4, 5n * 10n ** 13n)]);
  assert.deepEqual([b.locks, b.minted, b.pending, b.locked], [5, 2511n * 10n ** 11n, 0n, 2511n * 10n ** 11n]);
  assert.equal(b.mintedTo(D), b.minted);
  // A nonce named twice counts once.
  assert.equal(lockTotals([...recorded, lock(3, 10n ** 11n)], [...minted, lock(0, 10n ** 14n)]).locks, 4);
  for (const t of [a, b]) {
    assert.equal(t.locked, t.minted + t.pending, "outstanding = minted + pending - released");
    assert.deepEqual(t.disagree, []);
  }
  // A mint record that says lock 1 was 2 tPOT while the V3 record holds 1: the vault took what the V3
  // record says, the identity fails, and the lock is named (the build refuses it).
  const c = lockTotals(recorded, [lock(0, 10n ** 14n), lock(1, 2n * 10n ** 14n), lock(2, 10n ** 12n)]);
  assert.equal(c.locked, a.locked);
  assert.notEqual(c.locked, c.minted + c.pending);
  assert.deepEqual(
    c.disagree.map((d) => [d.minted.nonce, d.recorded.amountNative, d.minted.amountNative]),
    [[1, 10n ** 14n, 2n * 10n ** 14n]],
  );
  // Another recipient disagrees too; a mint that names none (a history without its attempt line) does not.
  const E = "0x000000000000000000000000000000000000beef" as const;
  assert.deepEqual(lockTotals(recorded, [{ ...lock(0, 10n ** 14n), recipient: E }]).disagree.map((d) => d.minted.nonce), [0]);
  assert.deepEqual(lockTotals(recorded, [{ ...lock(0, 10n ** 14n), recipient: null }]).disagree, []);

  // The histories: the attempt line gives the amount and the recipient; a minted result without one,
  // another outcome and a line cut short are each read as the tool reads them. Nonces 1000 and 1001
  // stand for locks sent from the app, which the V3 record does not hold.
  const dir = mkdtempSync(join(tmpdir(), "bz-site-automint-"));
  try {
    const at = "2026-10-28T00:00:00.000Z";
    const lines = [
      { kind: "attempt", id: "a", lock: "1000", recipient: D, amount: "50000000000000", txNonce: 1, at },
      { kind: "signed", id: "a", lock: "1000", txHash: `0x${"aa".repeat(32)}`, at },
      { kind: "result", id: "a", lock: "1000", txHash: `0x${"aa".repeat(32)}`, outcome: "minted", at },
      { kind: "result", id: "b", lock: "1001", txHash: `0x${"bb".repeat(32)}`, outcome: "minted", at },
      { kind: "attempt", id: "c", lock: "1002", recipient: D, amount: "1", at },
      { kind: "result", id: "c", lock: "1002", txHash: null, outcome: "reverted", at },
    ].map((l) => JSON.stringify(l));
    const file = `automint-sepolia-0x${"57".repeat(20)}.jsonl`;
    writeFileSync(join(dir, file), `${lines.join("\n")}\n{"kind":"res`);
    const read = readAutoMints(dir);
    assert.deepEqual([...read.keys()].sort(), [1000, 1001]);
    assert.deepEqual(read.get(1000), { amountNative: "50000000000000", recipient: D, txHash: `0x${"aa".repeat(32)}`, network: "sepolia", file });
    assert.deepEqual(read.get(1001), { amountNative: null, recipient: null, txHash: `0x${"bb".repeat(32)}`, network: "sepolia", file });
    // The repository's records with the repository's histories (every chain's) and that one: lock 1000
    // counts (0.5 wtPOT), lock 1001 has no amount anywhere and is left out with a warning, and the
    // build does not fail.
    for (const f of readdirSync(join(repo, "deployments")).filter((x) => /^automint-[a-z-]+-0x[0-9a-f]{40}\.jsonl$/.test(x))) copyFileSync(join(repo, "deployments", f), join(dir, f));
    const withApp = buildRecords(repo, undefined, dir);
    assert.equal(BigInt(withApp.totals.minted), BigInt(r.totals.minted) + 5n * 10n ** 13n);
    assert.equal(withApp.totals.pending, r.totals.pending);
    assert.equal(withApp.totals.locks, r.totals.locks + 1);
    const released = r.returnPath.releases.filter((x) => x.status === "released").reduce((n, x) => n + BigInt(x.amountNative ?? "0"), 0n);
    assert.equal(BigInt(withApp.totals.outstandingNative), BigInt(withApp.totals.minted) + BigInt(withApp.totals.mintedRollups) + BigInt(withApp.totals.pending) - released);
    // A history that says a recorded lock no mint step names was minted with another amount than
    // deployments/v3-testnet.json holds: the records contradict each other, and the build fails.
    // (This history's name sorts before the repository's Sepolia history, the only other one that
    // names that lock, so its line is the one read.)
    type Rec = { locks: { status: string; vaultNonce?: string; amountNative: string; recipient: string }[]; steps: { kind: string; ok?: boolean; status?: number; lock?: { nonce: number } }[] };
    const v3 = JSON.parse(readFileSync(join(repo, "deployments", "v3-testnet.json"), "utf8")) as Pick<Rec, "locks">;
    const stepped = new Set((JSON.parse(readFileSync(join(repo, "deployments", "sepolia-bridge.json"), "utf8")) as Pick<Rec, "steps">).steps.filter((s) => s.kind === "mint" && s.ok === true && s.status === 1).map((s) => s.lock?.nonce));
    const target = v3.locks.find((l) => l.status === "locked" && l.vaultNonce !== undefined && !stepped.has(Number(l.vaultNonce)));
    assert.ok(target, "a recorded lock no mint step names (lock 2, which auto-mint minted)");
    const more = (BigInt(target.amountNative) + 1n).toString();
    const wrong = [
      { kind: "attempt", id: "w", lock: target.vaultNonce, recipient: target.recipient, amount: more, txNonce: 9, at },
      { kind: "result", id: "w", lock: target.vaultNonce, txHash: `0x${"cc".repeat(32)}`, outcome: "minted", at },
    ].map((l) => JSON.stringify(l));
    writeFileSync(join(dir, `automint-sepolia-0x${"00".repeat(20)}.jsonl`), `${wrong.join("\n")}\n`);
    assert.throws(
      () => buildRecords(repo, undefined, dir),
      new RegExp(`automint-sepolia-0x0{40}\\.jsonl: lock ${target.vaultNonce} was minted as ${more} for 0x[0-9a-f]{40}, and deployments/v3-testnet\\.json holds ${target.amountNative} for`),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the rollups' auto-mint histories count for the vault, and only Sepolia's for Sepolia's wtPOT", () => {
  // One vault backs wtPOT on Sepolia, Base Sepolia and Arbitrum Sepolia, and auto-mint keeps a history
  // for each chain (automint-<network>-<sender>.jsonl). A lock the app sent for a rollup is in no
  // other record: locks 6 and 7 (rows 117 to 120) count only through the rollups' histories, and
  // without them the vault's outstanding would fall below what was released for their burns.
  const D = "0xd9838a86cf83c28ee486544060d1ca4ca2971071" as const;
  const O = "0xc6e997a757f0be410714ed04b869efa1aee32011" as const;
  const onRollups = [...readAutoMints(join(repo, "deployments"))].filter(([, m]) => m.network !== "sepolia");
  assert.equal(BigInt(r.totals.mintedRollups), onRollups.reduce((n, [, m]) => n + BigInt(m.amountNative ?? "0"), 0n));
  if (r.totals.locks === 8) {
    assert.deepEqual(
      onRollups.map(([n, m]) => [n, m.network, m.amountNative, m.recipient]).sort((a, b) => Number(a[0]) - Number(b[0])),
      [
        [4, "base-sepolia", "100000000000", D],
        [5, "arbitrum-sepolia", "100000000000", D],
        [6, "base-sepolia", "100000000000000", O],
        [7, "arbitrum-sepolia", "100000000000000", O],
      ],
    );
    // Locks 0 to 7, 4.013 tPOT, less 2.602 released: nothing pending, and the vault's outstanding is
    // the wtPOT supply, all of it on Sepolia.
    assert.deepEqual([r.totals.mintedRollups, r.totals.pending, r.totals.outstandingNative, r.totals.supply], ["200200000000000", "0", "141100000000000", "141100000000000"]);
  }

  const dir = mkdtempSync(join(tmpdir(), "bz-site-automint-rollups-"));
  try {
    const at = "2026-10-28T00:00:00.000Z";
    const history = (id: string, lock: string, amount: string, recipient: string) =>
      [
        { kind: "attempt", id, lock, recipient, amount, txNonce: 1, at },
        { kind: "result", id, lock, txHash: `0x${id.repeat(32)}`, outcome: "minted", at },
      ]
        .map((l) => `${JSON.stringify(l)}\n`)
        .join("");
    for (const f of readdirSync(join(repo, "deployments")).filter((x) => /^automint-[a-z-]+-0x[0-9a-f]{40}\.jsonl$/.test(x))) copyFileSync(join(repo, "deployments", f), join(dir, f));
    // Two more locks the V3 record lacks, sent from the app: 1000 minted on Base Sepolia (1 wtPOT) and
    // 1001 on Arbitrum Sepolia (0.5). Each history's name sorts before the repository's history for
    // its chain, so its lines are the ones read.
    const arb = `automint-arbitrum-sepolia-0x${"00".repeat(20)}.jsonl`;
    writeFileSync(join(dir, `automint-base-sepolia-0x${"00".repeat(20)}.jsonl`), history("dd", "1000", "100000000000000", O));
    writeFileSync(join(dir, arb), history("ee", "1001", "50000000000000", O));
    const read = readAutoMints(dir);
    assert.deepEqual([read.get(1000)?.network, read.get(1001)?.network], ["base-sepolia", "arbitrum-sepolia"]);
    const f = buildRecords(repo, undefined, dir);
    const more = 15n * 10n ** 13n;
    assert.equal(f.totals.locks, r.totals.locks + 2);
    assert.equal(BigInt(f.totals.mintedRollups), BigInt(r.totals.mintedRollups) + more);
    assert.equal(BigInt(f.totals.outstandingNative), BigInt(r.totals.outstandingNative) + more);
    // Sepolia's wtPOT is as before: no rollup's mint is in its supply or in the recipient's balance.
    assert.deepEqual(
      [f.totals.minted, f.totals.burned, f.totals.supply, f.totals.recipientBalance, f.totals.pending],
      [r.totals.minted, r.totals.burned, r.totals.supply, r.totals.recipientBalance, r.totals.pending],
    );
    // A rollup's history that says a recorded lock was minted with another amount than
    // deployments/v3-testnet.json holds fails the build, as Sepolia's does.
    type V3Lock = { status: string; vaultNonce?: string; dstChainId: string; amountNative: string; recipient: string };
    const v3 = JSON.parse(readFileSync(join(repo, "deployments", "v3-testnet.json"), "utf8")) as { locks: V3Lock[] };
    const target = v3.locks.find((l) => l.status === "locked" && l.dstChainId === "421614" && l.vaultNonce !== undefined);
    assert.ok(target?.vaultNonce, "a recorded lock for Arbitrum Sepolia (lock 5)");
    const wrong = (BigInt(target.amountNative) + 1n).toString();
    writeFileSync(join(dir, arb), history("ff", target.vaultNonce, wrong, target.recipient));
    assert.throws(
      () => buildRecords(repo, undefined, dir),
      new RegExp(`automint-arbitrum-sepolia-0x0{40}\\.jsonl: lock ${target.vaultNonce} was minted as ${wrong} for 0x[0-9a-f]{40}, and deployments/v3-testnet\\.json holds ${target.amountNative} for`),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the latest transfer the page shows is the newest mint of a lock the V3 record holds", () => {
  const step = (nonce: number, block: number) => ({ kind: "mint", ok: true, status: 1, block, lock: { nonce, amountNative: "1" } });
  // The mint tool minted lock 4 last, sent from the app: deployments/v3-testnet.json lacks it, so the page shows lock 1's run.
  const mints = [step(0, 100), step(4, 300), step(1, 200)];
  assert.equal(latestRecordedMint(mints, new Set([0, 1, 2, 3]))?.block, 200);
  assert.equal(latestRecordedMint(mints, new Set([0, 1, 4]))?.block, 300);
  assert.equal(latestRecordedMint(mints, new Set([7])), null);
  assert.deepEqual(mints.map((s) => s.block), [100, 300, 200], "the steps are left in their order");
});

test("the latest transfer is lock 1, with its bundle, its mint and the measured steps", () => {
  const run = r.latestRun;
  assert.ok(run);
  if (run.lock.nonce !== 1) return; // a later run is in the records: the checks below are lock 1's
  assert.equal(run.lock.txHash, "0x30606cf196d5d9553c83580b7d114de91f8a4839d819320ca775351a8c6c70e4");
  assert.equal(run.lock.block, 118636);
  assert.equal(run.lock.commitment, "0x2d1ab009f006fd70b9653d09a56a3b4927775d6251c4879df9c7a1364b0ad0a7");
  assert.equal(run.bundle.block.number, 118637);
  assert.equal(run.bundle.parent.number, 118636);
  assert.equal(run.bundle.setId, 33);
  assert.equal(run.bundle.signatures, 2);
  assert.equal(run.bundle.authorities, 2);
  assert.equal(run.mint.txHash, "0xb9134dd793b84ff53375cd6b5ec8fb51940fea0a5cce2b5924f674b530d7f943");
  assert.equal(run.mint.block, 11955981);
  assert.equal(run.mint.gasUsed, 2391069);
  assert.equal(run.bound, false, "lock 0's mint bound the vault");
  assert.equal(formatUnits(BigInt(run.mint.amountNative), 14), "1");
  const l = run.lock;
  assert.equal(
    lockCommitment({ v3ChainId: 420420777n, vault: r.bridge.vault.address, dstChainId: BigInt(l.dstChainId), minter: l.dstMinter, recipient: l.recipient, amountNative: BigInt(l.amountNative), nonce: 1n }),
    l.commitment,
  );
  assert.equal(commitmentSlot(1n), l.slot);
  const t = run.timing;
  assert.ok(t, "site/data/measured-runs.json holds lock 1's steps");
  assert.deepEqual(
    t.steps.map((s) => [s.key, s.seconds]),
    [
      ["lock", 10],
      ["finality", 14],
      ["proofs", 9],
      ["mint", 15],
    ],
  );
  assert.equal(t.totalSeconds, 48);
  // The records' timestamps fit inside the 48 s: the lock was signed, the bundle read and the mint signed in that order.
  const at = (iso: string) => Date.parse(iso);
  assert.ok(at(l.signedAt) < at(run.bundle.capturedAt) && at(run.bundle.capturedAt) < at(run.mint.signedAt ?? ""));
  assert.ok(at(run.mint.signedAt ?? "") - at(l.signedAt) < t.totalSeconds * 1000);
});

test("the relayer's latest runs: V3 set 32 to 33, then its head", () => {
  const v3 = r.relayRuns.v3;
  assert.ok(v3 && v3.entries.length > 0);
  const change = v3.entries.find((e) => e.setBefore === 32 && e.setAfter === 33);
  if (change) {
    assert.equal(change.block.number, 118123);
    assert.equal(change.sepoliaBlock, 11955971);
    const head = v3.entries.find((e) => e.method === "importFinalityProof");
    assert.equal(head?.block.number, 118614);
    assert.equal(head?.sepoliaBlock, 11955972);
  }
  assert.ok(r.relayRuns.mainnet && r.relayRuns.mainnet.entries.every((e) => e.signatures === 7));
});

test("every sender's relay history counts: the newest import and the latest run across them, one sender a run", () => {
  // Three senders' histories (test/fixtures/relays): A into both clients, then B into V3 and C into
  // the old mainnet; B's file holds one line twice.
  const dir = join(here, "fixtures", "relays");
  const f = buildRecords(repo, dir);
  const A = `0x${"a".repeat(40)}`;
  const B = `0x${"b".repeat(40)}`;
  const C = `0x${"c".repeat(40)}`;
  const tx = (b: string) => `0x${b.repeat(32)}`;
  const fileOf = (s: string) => f.relay.files.find((x) => x.endsWith(`relay-sepolia-${s}.jsonl`));

  // The newest import into each client is the newest in any file.
  assert.equal(f.lightClients.v3.latestRelay?.txHash, tx("b3"));
  assert.equal(f.lightClients.mainnet.latestRelay?.txHash, tx("c1"));
  assert.deepEqual([f.lightClients.v3.latestImport?.via, f.lightClients.v3.latestImport?.number], ["relayer", 201700]);
  assert.equal(f.lightClients.v3.latestImport?.from, fileOf(B));
  assert.equal(f.lightClients.mainnet.latestImport?.from, fileOf(C));

  // All three files, each transaction once.
  assert.equal(f.relay.files.length, 3);
  assert.deepEqual([A, B, C].map((s) => Boolean(fileOf(s))), [true, true, true]);
  assert.deepEqual(
    f.relay.entries.map((e) => [e.sender, e.txHash]),
    [
      [A, tx("a1")],
      [A, tx("a2")],
      [A, tx("a3")],
      [A, tx("a4")],
      [B, tx("b1")],
      [B, tx("b2")],
      [B, tx("b3")],
      [C, tx("c1")],
    ],
  );

  // Each client's last run is the newest across the senders, and holds one sender's entries: A's
  // mainnet head 5 minutes before C's is not part of C's run.
  assert.deepEqual(f.relayRuns.v3?.entries.map((e) => e.txHash), [tx("b2"), tx("b3")]);
  assert.equal(f.relayRuns.v3?.settledAt, "2026-10-19T12:00:10.000Z");
  assert.deepEqual(f.relayRuns.mainnet?.entries.map((e) => e.txHash), [tx("c1")]);
  assert.equal(f.relayRuns.mainnet?.settledAt, "2026-10-19T12:10:00.000Z");

  // The repository's own records: every history in deployments/ is read.
  assert.ok(r.relay.files.length >= 1 && r.relay.files.every((x) => /^deployments\/relay-sepolia-0x[0-9a-f]{40}\.jsonl$/.test(x)));
  assert.equal(new Set(r.relay.entries.map((e) => e.txHash)).size, r.relay.entries.length);
});

test("the way back's duration comes from the records' timestamps", () => {
  const t = r.returnPath.timing;
  assert.ok(t);
  assert.equal(t.burnSentAt, "2026-10-20T12:51:52.245Z");
  assert.equal(t.releaseRunAt, "2026-10-20T13:11:50.143Z");
  assert.equal(t.seconds, 1198);
  assert.equal(formatDuration(t.seconds), "20 min");
});

test("each release names its burn's chain: the return path counts Sepolia's releases, not the rollups'", () => {
  // The section shows Sepolia's burns and counts a release as theirs when its record names Sepolia's
  // chain id, or none, which the relayer reads as Sepolia's: exactly the releases whose burn id
  // Sepolia's minter gives.
  const sepolia = String(11155111n);
  const released = r.returnPath.releases.filter((x) => x.status === "released");
  for (const x of released) {
    const counted = (x.chainId ?? sepolia) === sepolia;
    const sepoliaBurn = x.burnNonce !== null && x.burnId === burnId(11155111n, r.sepolia.minter, BigInt(x.burnNonce));
    assert.equal(counted, sepoliaBurn, `the release of burn ${x.burnNonce} on chain ${x.chainId}`);
  }
  // Burns 0 and 1 on Sepolia (rows 47 to 51 and 56 to 58), then burn 0 on Base Sepolia and on
  // Arbitrum Sepolia (rows 110 to 113), then burn 1 on Arbitrum Sepolia and on Base Sepolia, in fast
  // mode (rows 121 to 126): run 2 times from Sepolia, not 6.
  assert.deepEqual(
    released.slice(0, 2).map((x) => [x.chainId, x.burnNonce, x.by]),
    [
      [sepolia, "0", null],
      [sepolia, "1", "fast"],
    ],
  );
  if (released.length === 6) {
    assert.deepEqual(
      released.slice(2).map((x) => [x.chainId, x.burnNonce, x.by]),
      [
        ["84532", "0", "finality"],
        ["421614", "0", "finality"],
        ["421614", "1", "fast"],
        ["84532", "1", "fast"],
      ],
    );
    assert.equal(released.filter((x) => (x.chainId ?? sepolia) === sepolia).length, 2);
  }
});

test("the roadmap is the README's, with plans and no promises", () => {
  const rm = r.roadmap;
  assert.ok(rm);
  assert.match(rm.intro, /^Plans, not promises/);
  // What comes next first, then the later groups in the README's order, however many it has: the
  // README's third group ("Planned after the check-in") must not stop the page from building.
  assert.match(rm.groups[0]?.title ?? "", /^Next\b/);
  assert.ok(rm.groups.length >= 2 && rm.groups.every((g) => g.title && g.items.length > 0));
  const text = [rm.intro, ...rm.groups.flatMap((g) => [g.title, ...g.items.map((i) => `${i.lead ?? ""} ${i.text}`)])].join(" ");
  assert.doesNotMatch(text, /\bwill\b|coming soon/i);
  assert.match(text, /Solana/);
  assert.ok(rm.groups.flatMap((g) => g.items).find((i) => i.lead === "More EVM chains."));
  const md = ["## Roadmap", "", "Plans.", "", "**Soon**", "", "- One,", "  continued.", "- **Two.** Text.", "", "**Later: three**", "", "- **Three,** then.", "", "## Next"].join(String.fromCharCode(10));
  assert.deepEqual(parseRoadmap(md), {
    intro: "Plans.",
    groups: [
      {
        title: "Soon",
        items: [
          { lead: null, text: "One, continued." },
          { lead: "Two.", text: "Text." },
        ],
      },
      { title: "Later: three", items: [{ lead: "Three,", text: "then." }] },
    ],
  });
});

test("the README's recorded outputs against deployments/: a later mint shows next to them", () => {
  const md = [
    "## Verify it yourself",
    "",
    "```sh",
    "SEPOLIA=https://a.example",
    "",
    "# wtPOT",
    'cast call 0x1fcB "totalSupply()(uint256)" --rpc-url $SEPOLIA',
    "# 50000000000000 [5e13]",
    'cast call 0x1fcB "balanceOf(address)(uint256)" 0xD9838A86cF83C28Ee486544060D1cA4Ca2971071 --rpc-url $SEPOLIA',
    "# 150000000000000 [1.5e14]",
    'cast call 0x8287 "burnCount()(uint256)" --rpc-url $SEPOLIA',
    "```",
  ].join("\n");
  const v = parseVerify(md);
  assert.ok(v);
  const differ = markStaleOutputs(v, [
    { cmd: /"totalSupply\(\)\(uint256\)"/, value: 150000000000000n, note: "1.5 wtPOT" },
    { cmd: /"balanceOf\(address\)\(uint256\)"\s+0xd9838a86cf83c28ee486544060d1ca4ca2971071\b/i, value: 150000000000000n, note: "1.5 wtPOT" },
    { cmd: /"burnCount\(\)\(uint256\)"/, value: 1n, note: "1 recorded" },
  ]);
  const cmds = v.groups.flatMap((g) => g.commands);
  assert.equal(cmds[0]?.now, "150000000000000 (1.5 wtPOT)", "the README's 5e13 predates lock 1's mint");
  assert.equal(cmds[1]?.now, null, "an output that still holds is left alone");
  assert.equal(cmds[2]?.now, null, "a command without a recorded output is left alone");
  assert.equal(differ.length, 1);
  // The repository's own README: whatever differs is marked, and a marked value is what deployments/ gives.
  for (const c of r.verify?.groups.flatMap((g) => g.commands) ?? []) {
    if (c.now === null) continue;
    assert.match(c.now, /^\d+ \(/);
    if (/totalSupply/.test(c.cmd)) assert.ok(c.now.startsWith(`${r.totals.supply} `));
    if (/outstanding\(\)/.test(c.cmd)) assert.ok(c.now.startsWith(`${r.totals.outstandingNative} `));
  }
});

test("the V3 client's recorded set is the one the newest mint was signed under", () => {
  const run = r.latestRun;
  assert.ok(run);
  assert.equal(r.lightClients.v3.fixtureSet.setId, run.bundle.setId);
  assert.equal(r.lightClients.v3.fixtureSet.keys.length, run.bundle.authorities);
  assert.equal(r.lightClients.v3.fixtureSet.from, run.bundle.file);
  // Lock 0's bundle keeps its own set for the bridge section's signature check.
  assert.equal(r.bridge.finality.setId, 30);
  assert.equal(r.bridge.finality.authorities.length, 2);
});

test("SS58 and checksummed addresses match the probes and Etherscan's casing", () => {
  assert.equal(ss58(r.lightClients.v3.sudo.id, 42), r.lightClients.v3.sudo.ss58);
  assert.equal(ss58(r.lightClients.mainnet.sudo.id, 42), r.lightClients.mainnet.sudo.ss58);
  assert.equal(checksumAddress("0x447171c4885ad725ee4772e8e3c228adee50dcb0", keccak256), "0x447171c4885Ad725eE4772E8e3c228aDeE50Dcb0");
  assert.equal(checksumAddress("0x8287b3baf205ca8456f98346f13064aa7fcdcb9e", keccak256), "0x8287B3Baf205CA8456f98346F13064AA7fCDcB9E");
});

test("amounts and numbers are formatted without rounding", () => {
  assert.equal(formatUnits(100000000000000n, 14), "1");
  assert.equal(formatUnits(50000000000000n, 14), "0.5");
  assert.equal(formatUnits(1n, 14), "0.00000000000001");
  assert.equal(formatUnits(11547316337433722360n, 18, 4), "11.5473");
  assert.equal(formatUnits(123456789000000000000n, 14), "1,234,567.89");
  assert.equal(formatInt(2952838), "2,952,838");
  assert.equal(formatInt(-1200n), "-1,200");
  assert.equal(formatDuration(51 * 60), "51 min");
  assert.equal(formatDuration(486 * 6), "49 min");
});

test("evidence rows: Sepolia links and V3 rows with their extrinsics resolved, a rollup row's hash as printed", () => {
  const base = "0xaffaf9e0f464552686c3478cb4ffb3b822accb98b656cbd2053579de70eefd2e";
  const md = [
    "### A table",
    "| # | What | Transaction | Block | Result |",
    "|---|---|---|---|---|",
    `| **47** | **Burn: \`a | b\`** | [\`0x42d70ae9…\`](https://sepolia.etherscan.io/tx/0x${"42".repeat(32)}) | Sepolia 11,955,414 | success |`,
    "| 48 | Funded | `0xe1c37a36…30209617` | V3 [#117,514](https://node-console.portaldot.dev/?rpc=x#/explorer/query/117514) | final |",
    `| 108 | Base Sepolia: burn 0 | [\`0xaffaf9e0…70eefd2e\`](https://sepolia.basescan.org/tx/${base}) | Base 51,177,673 | success |`,
  ].join("\n");
  // The V3 record holds the rollup burn's hash too, in the release that names the burn.
  const rows = parseEvidence(md, ["0xe1c37a368392d3d1bbbffba8d9cbab36e96303bc93e201746d69b2d930209617", base]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0]?.chain, "sepolia");
  assert.equal(rows[0]?.block, 11955414);
  assert.equal(rows[0]?.what, "Burn: `a | b`");
  assert.equal(rows[1]?.chain, "v3");
  assert.equal(rows[1]?.block, 117514);
  assert.equal(rows[1]?.tx, "0xe1c37a368392d3d1bbbffba8d9cbab36e96303bc93e201746d69b2d930209617");
  assert.ok(rows[1]?.blockUrl?.endsWith("/117514"));
  // Only a V3 row's short hash is resolved: the page links a non-V3 row's tx on Sepolia's
  // Etherscan, where a rollup's transaction is not.
  assert.equal(rows[2]?.n, 108);
  assert.equal(rows[2]?.tx, null);
  assert.equal(rows[2]?.txText, "0xaffaf9e0…70eefd2e");
  // The repository's README: every row the page links on Sepolia's Etherscan links it there too.
  const readme = readFileSync(join(repo, "README.md"), "utf8").toLowerCase();
  for (const e of r.evidence.filter((x) => x.chain === "sepolia" && x.tx)) {
    assert.ok(readme.includes(`(https://sepolia.etherscan.io/tx/${e.tx})`), `row ${e.n}: ${e.tx} is not linked on Sepolia's Etherscan in the README`);
  }
});

test("the README's verify block: descriptions, commands and recorded outputs", () => {
  const md = [
    "## Verify it yourself",
    "",
    "```sh",
    "A=https://a.example",
    "",
    "# What the first group shows",
    "# on two lines",
    "cast call 0x1 \"f()(uint256)\"",
    "# 2",
    "cast call 0x2 \"g()(bool)\"",
    "# true",
    "",
    "# The second group",
    "cast code 0x3 | cast keccak",
    "```",
  ].join("\n");
  const v = parseVerify(md);
  assert.ok(v);
  assert.deepEqual(v.env, ["A=https://a.example"]);
  assert.equal(v.groups.length, 2);
  assert.deepEqual(v.groups[0]?.what, ["What the first group shows", "on two lines"]);
  assert.deepEqual(
    v.groups[0]?.commands.map((c) => [c.cmd, c.output]),
    [
      ['cast call 0x1 "f()(uint256)"', ["2"]],
      ['cast call 0x2 "g()(bool)"', ["true"]],
    ],
  );
  assert.deepEqual(v.groups[1]?.commands[0]?.output, []);
  if (r.verify) assert.ok(r.verify.groups.length > 0, "the repository's README has the block");
});

test("the timed run: the block stamps, and the README section that must give the same numbers", () => {
  const t = r.latestRun?.timing;
  assert.ok(t);
  if (r.latestRun?.lock.nonce === 1) {
    assert.deepEqual(t.blockTimes, { lock: { block: 118636, at: "2026-10-20T14:45:36Z" }, mint: { block: 11955981, at: "2026-10-20T14:46:12Z" }, seconds: 36 });
  }
  const md = [
    "### Lock to mint in 48 seconds",
    "",
    "The lock's V3 block is stamped 14:45:36 and the mint's Sepolia",
    "block 14:46:12: 36 seconds. From sending the lock to the mint's receipt, with the tools' own checks,",
    "it took 48 seconds: the lock 10, GRANDPA finality 14, reading and checking the proofs 9, the mint 15.",
    "",
    "| # | What it shows |",
    "",
    "## Layout",
  ].join("\n");
  const section = readmeTimingSection(md);
  assert.ok(section && !section.includes("Layout"));
  assert.deepEqual(checkReadmeTiming(section, t.steps, 48, ["14:45:36", "14:46:12"]), { status: "agrees", problem: null });
  // Other numbers in the README are a contradiction; other words are not.
  assert.equal(checkReadmeTiming(section.replace("proofs 9", "proofs 8"), t.steps, 48, []).status, "disagrees");
  assert.equal(checkReadmeTiming(section, t.steps, 48, ["14:45:37", "14:46:12"]).status, "disagrees");
  assert.equal(checkReadmeTiming(section.replaceAll("48 seconds", "47 seconds"), t.steps, 48, []).status, "disagrees");
  assert.equal(checkReadmeTiming(section.replace("48 seconds:", "48 seconds, so:"), t.steps, 48, []).status, "unclear");
  assert.equal(checkReadmeTiming("It was quick.", t.steps, 48, ["14:45:36"]).status, "unclear");
  assert.equal(readmeTimingSection("## Roadmap"), null);
});

test("each light client's newest import by the records: the relayer's, or a mint's bundle block", () => {
  const v3 = r.lightClients.v3.latestImport;
  const main = r.lightClients.mainnet.latestImport;
  assert.ok(v3 && main);
  assert.equal(main.via, "relayer");
  assert.equal(main.number, r.lightClients.mainnet.latestRelay?.block.number);
  // Lock 1's mint imported V3 #118,637, after the relayer's head #118,614.
  if (r.latestRun?.lock.nonce === 1 && (r.lightClients.v3.latestRelay?.block.number ?? 0) < 118637) {
    assert.deepEqual([v3.via, v3.number, v3.setId, v3.sepoliaBlock], ["mint", 118637, 33, 11955981]);
    assert.equal(v3.txHash, r.latestRun.mint.txHash);
  }
  assert.ok(v3.number >= (r.lightClients.v3.latestRelay?.block.number ?? 0));
});
