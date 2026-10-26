// This browser's journal of its transfers (src/app/journal.ts): what it keeps across a reload, and
// what it drops when the text in localStorage is not what the page wrote (another version, edited,
// cut short). The chains stay the truth: an entry dropped costs the page its memory of a transfer,
// never funds. Offline.

import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeJournal, encodeJournal, JOURNAL_MAX } from "../src/app/journal.ts";
import type { BurnTransfer, LiveTransfer, LockTransfer } from "../src/app/model.ts";
import type { Hex } from "../src/lib/hex.ts";

const H = (k: number): Hex => `0x${k.toString(16).padStart(64, "0")}`;
const ME: Hex = "0xd9838a86cf83c28ee486544060d1ca4ca2971071";

/** A lock on V3, final, its proof built and a self-relay's first transaction mined, the mint sent. */
const lock: LockTransfer = {
  id: "in-mh8k2q1x-1a2b3c",
  dir: "in",
  amount: 150_000_000_000_000n,
  recipient: ME,
  startedAt: 1_761_500_000_000,
  doneAt: null,
  failure: null,
  note: { text: "Checking the mint again", wallet: false },
  lock: { stage: "mined", hash: H(1), sentAt: 1_761_500_001_000, block: 208_101, minedAt: 1_761_500_010_000, gasUsed: 103_974_591_156_436 },
  nonce: 7,
  commitment: H(2),
  finality: { block: 208_104, hash: H(3), setId: 59, signatures: 2, authorities: 2, at: 1_761_500_024_000 },
  proof: { checks: { header: "passed", sigs: "passed", proof: "passed", commit: "passed", nonce: "checking" }, builtAt: 1_761_500_033_000 },
  route: { path: "selfRelay", imports: 7, title: "2 of 2: Import 1 set change and mint 1.5 wtPOT", gas: 5_300_000, step: 2, steps: 2, total: 20_800_000 },
  relayed: [{ hash: H(4), block: 12_000_100 }],
  mint: { stage: "sent", hash: H(5), sentAt: 1_761_500_060_000 },
  resumed: false,
};

/** A burn on Sepolia, released by the committee. */
const burn: BurnTransfer = {
  id: "back-mh8k3z9a-zz9",
  dir: "back",
  amount: 10_000_000_000_000n,
  recipient: ME,
  startedAt: 1_761_500_100_000,
  doneAt: 1_761_500_208_000,
  failure: null,
  note: null,
  speed: "fast",
  fallback: false,
  burn: { stage: "mined", hash: H(6), sentAt: 1_761_500_101_000, block: 12_000_200, minedAt: 1_761_500_124_000, gasUsed: 61_434 },
  burnNonce: 2,
  burnId: H(7),
  depth: { confirmations: 80, final: true, qualifiedAt: 1_761_500_160_000 },
  release: { approvals: 2, open: { extrinsic: H(8), block: 208_200 }, run: { extrinsic: H(9), block: 208_205 }, at: 1_761_500_208_000, released: true },
};

/** A lock declined in the wallet: nothing on chain, so most fields are still empty. */
const declined: LockTransfer = {
  ...lock,
  id: "in-mh8k4a00-7",
  startedAt: 1_761_500_200_000,
  failure: { reason: "rejected", at: 1_761_500_205_000, title: null, text: null },
  note: null,
  lock: { stage: "asking" },
  nonce: null,
  commitment: null,
  finality: null,
  proof: { checks: { header: "waiting", sigs: "waiting", proof: "waiting", commit: "waiting", nonce: "waiting" }, builtAt: null },
  route: null,
  relayed: [],
  mint: null,
};

const text = (list: unknown[], v = 1) => JSON.stringify({ v, transfers: list });
/** An entry as the journal writes it: its amount as a decimal string. */
const raw = (t: LiveTransfer): Record<string, unknown> => JSON.parse(encodeJournal([t])).transfers[0];

test("every transfer comes back as it was written, without the line on what the page was doing", () => {
  const back = decodeJournal(encodeJournal([lock, burn, declined]));
  assert.deepEqual(back, [
    { ...lock, note: null },
    { ...burn, note: null },
    { ...declined, note: null },
  ]);
  assert.equal(typeof (back[0] as LockTransfer).amount, "bigint");
});

test("nothing, another version, or text that is not JSON reads as no transfers", () => {
  assert.deepEqual(decodeJournal(null), []);
  assert.deepEqual(decodeJournal(""), []);
  assert.deepEqual(decodeJournal("{"), []);
  assert.deepEqual(decodeJournal("[]"), []);
  assert.deepEqual(decodeJournal(text([raw(lock)], 2)), []);
  assert.deepEqual(decodeJournal(JSON.stringify({ v: 1, transfers: "no" })), []);
});

test("an entry that does not read as the page wrote it is dropped, and the others kept", () => {
  const bad: unknown[] = [
    { ...raw(lock), id: "lock-1" },
    { ...raw(lock), id: "back-mh8k2q1x-1a2b3c" },
    { ...raw(lock), amount: "0" },
    { ...raw(lock), amount: "-5" },
    { ...raw(lock), amount: 150 },
    { ...raw(lock), recipient: "0x1234" },
    { ...raw(lock), nonce: -1 },
    { ...raw(lock), nonce: 1.5 },
    { ...raw(lock), lock: { stage: "mined", hash: "0x12", sentAt: 1 } },
    { ...raw(lock), mint: { stage: "flying" } },
    { ...raw(lock), proof: { checks: { ...lock.proof.checks, sigs: "skipped" }, builtAt: null } },
    { ...raw(lock), route: { ...lock.route, step: 3 } },
    { ...raw(lock), route: { ...lock.route, path: "teleport" } },
    { ...raw(lock), relayed: [{ hash: H(1) }] },
    { ...raw(lock), failure: { reason: "gone", at: 1 } },
    { ...raw(lock), dir: "sideways" },
    { ...raw(burn), speed: "slow" },
    { ...raw(burn), burnId: "0xzz" },
    { ...raw(burn), depth: null },
    { ...raw(burn), release: { ...burn.release, open: { extrinsic: H(1) } } },
    "lock",
    null,
  ];
  assert.deepEqual(decodeJournal(text([...bad, raw(burn)])), [{ ...burn, note: null }]);
});

test("a second entry with an id already read is dropped; approvals past 2 read as 2", () => {
  const twice = decodeJournal(text([raw(lock), { ...raw(lock), nonce: 8 }]));
  assert.equal(twice.length, 1);
  assert.equal((twice[0] as LockTransfer).nonce, 7);
  const many = decodeJournal(text([{ ...raw(burn), release: { ...burn.release, approvals: 9 } }]));
  assert.equal((many[0] as BurnTransfer).release.approvals, 2);
});

test(`the journal keeps the newest ${JOURNAL_MAX} transfers by when they started`, () => {
  const list = Array.from({ length: JOURNAL_MAX + 5 }, (_, i): LiveTransfer => ({ ...burn, id: `back-t${i}-x`, startedAt: 1_761_000_000_000 + (JOURNAL_MAX + 5 - i) * 1000 }));
  const kept = decodeJournal(encodeJournal(list));
  assert.equal(kept.length, JOURNAL_MAX);
  // The five that started first are the last five of the list.
  assert.deepEqual(
    kept.map((t) => t.id).sort(),
    list
      .slice(0, JOURNAL_MAX)
      .map((t) => t.id)
      .sort(),
  );
});
