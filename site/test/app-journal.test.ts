// This browser's journal of its transfers (src/app/journal.ts): what it keeps across a reload, and
// what it drops when the text in localStorage is not what the page wrote (another version, edited,
// cut short). Each transfer is kept with its destination (Sepolia, Base Sepolia, Arbitrum Sepolia),
// and one written before the page sent to the rollups reads as Sepolia's. The chains stay the truth:
// an entry dropped costs the page its memory of a transfer, never funds. Offline.

import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeJournal, encodeJournal, JOURNAL_MAX, mergeJournal } from "../src/app/journal.ts";
import type { BurnTransfer, LiveTransfer, LockTransfer } from "../src/app/model.ts";
import type { Hex } from "../src/lib/hex.ts";

const H = (k: number): Hex => `0x${k.toString(16).padStart(64, "0")}`;
const ME: Hex = "0xd9838a86cf83c28ee486544060d1ca4ca2971071";

/** A lock on V3, final, its proof built and a self-relay's first transaction mined, the mint sent. */
const lock: LockTransfer = {
  id: "in-mh8k2q1x-1a2b3c",
  dest: "sepolia",
  dir: "in",
  amount: 150_000_000_000_000n,
  recipient: ME,
  startedAt: 1_761_500_000_000,
  doneAt: null,
  failure: null,
  note: { text: "Checking the mint again", wallet: false },
  sender: { kind: "evm", address: ME },
  ext: null,
  lock: { stage: "mined", hash: H(1), sentAt: 1_761_500_001_000, block: 208_101, minedAt: 1_761_500_010_000, gasUsed: 103_974_591_156_436 },
  nonce: 7,
  commitment: H(2),
  finality: { block: 208_104, hash: H(3), setId: 59, signatures: 2, authorities: 2, at: 1_761_500_024_000 },
  proof: { checks: { header: "passed", sigs: "passed", proof: "passed", commit: "passed", nonce: "checking" }, builtAt: 1_761_500_033_000 },
  route: { path: "selfRelay", imports: 7, title: "2 of 2: Import 1 set change and mint 1.5 wtPOT", gas: 5_300_000, step: 2, steps: 2, total: 20_800_000 },
  relayed: [{ hash: H(4), block: 12_000_100 }],
  mint: { stage: "sent", hash: H(5), sentAt: 1_761_500_060_000 },
  mintBy: null,
  autoPending: false,
  resumed: false,
};

/** A burn on Sepolia, released by the committee. */
const burn: BurnTransfer = {
  id: "back-mh8k3z9a-zz9",
  dest: "sepolia",
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

const text = (list: unknown[], v = 2) => JSON.stringify({ v, transfers: list });
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
  assert.deepEqual(decodeJournal(text([raw(lock)], 4)), []);
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

/** A lock the wallet sent, not mined yet: where its log can be, and the nonce the wallet most likely gave it. */
const sent: LockTransfer = {
  ...declined,
  id: "in-mh8k5b00-9",
  failure: null,
  fromBlock: 208_100,
  lock: { stage: "sent", hash: H(10), sentAt: 1_761_500_201_000, by: { from: ME, nonce: 4 } },
};

test("the block a lock's log can be in from, and the sender's nonce, come back; an entry without them reads too, and bad ones are dropped", () => {
  assert.deepEqual(decodeJournal(encodeJournal([sent])), [{ ...sent, note: null }]);
  assert.equal("fromBlock" in (decodeJournal(encodeJournal([declined]))[0] as LockTransfer), false);
  const r = raw(sent);
  const bad: unknown[] = [
    { ...r, fromBlock: -1 },
    { ...r, fromBlock: "208100" },
    { ...r, lock: { ...(r.lock as object), by: { from: "0x12", nonce: 4 } } },
    { ...r, lock: { ...(r.lock as object), by: { from: ME, nonce: 1.5 } } },
    { ...r, lock: { ...(r.lock as object), by: null } },
  ];
  assert.deepEqual(decodeJournal(text([...bad, raw(burn)])), [{ ...burn, note: null }]);
});

test("a tab writes only the transfers it follows: another tab's stays as that tab wrote it last, never its own older copy", () => {
  // Tab A follows `sent` and has moved it on: its lock mined, its mint sent.
  const moved: LockTransfer = { ...lock, id: sent.id, startedAt: sent.startedAt };
  // Tab B read it while A's wallet was still asking, and holds that older copy; B follows its own burn.
  const stale: LockTransfer = { ...sent, lock: { stage: "asking" }, failure: { reason: "refused", at: 1_761_500_202_000, title: "Not sent", text: null } };
  const stored = decodeJournal(encodeJournal([moved]));
  const b = mergeJournal(stored, [stale, burn], (id) => id === burn.id);
  assert.deepEqual(
    b.map((t) => [t.id, t.dir === "in" ? t.lock.stage : t.burn.stage, t.failure?.title ?? null]),
    [
      [sent.id, "mined", null],
      [burn.id, "mined", null],
    ],
  );
  // Once B follows it (A closed, or its visitor acted on it in B), B's copy is the one written.
  assert.equal((mergeJournal(stored, [stale], () => true)[0] as LockTransfer).lock.stage, "asking");
  // An entry B does not follow and the journal no longer holds is not written back either.
  assert.deepEqual(mergeJournal([], [stale], () => false), []);
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

// ---------------------------------------------------------------------------------------------
// Version 2: a lock's sender, a Substrate lock's extrinsic, who minted it, auto-mint pending

/** A lock from a Polkadot wallet's account: sent as an extrinsic, its era from #220,910 to #220,973. */
const substrate: LockTransfer = {
  ...sent,
  id: "in-mh9a0000-5u8",
  recipient: "0x00000000000000000000000000000000000000aa",
  sender: { kind: "substrate", ss58: "5ERJiUnzmQwEF98X3rGyKiNsyjrcenLGJST3MULCjUSwgPJ7", h160: "0xb621f9a9dd96ba88681c40b04657cef602854e24", wallet: "subwallet-js", walletName: "SubWallet" },
  ext: { nonce: 7, from: 220_910, to: 220_973 },
  fromBlock: 220_910,
  lock: { stage: "sent", hash: H(11), sentAt: 1_761_500_301_000 },
  mintBy: "0x57cc2ba3b883339a9f32726e6d0d3a9ee861a113",
  autoPending: true,
};

test("a lock from a Polkadot wallet comes back with its account, its wallet, its extrinsic's nonce and era, who minted it, and auto-mint's pending flag", () => {
  assert.deepEqual(decodeJournal(encodeJournal([substrate])), [{ ...substrate, note: null }]);
  assert.equal(JSON.parse(encodeJournal([substrate])).v, 3);
});

test("past the cap the oldest finished transfers go first, and a Polkadot wallet's lock that may be on V3 and is not minted is never dropped: only the journal finds it again", () => {
  const t0 = 1_761_000_000_000;
  // Broadcast, not settled: the oldest of all.
  const old: LockTransfer = { ...substrate, id: "in-old0-sub", startedAt: t0 };
  const ids = (list: LiveTransfer[]) => new Set(decodeJournal(encodeJournal(list)).map((t) => t.id));
  // 40 released burns, then an Ethereum lock not minted yet (on chain, so findable there too): two too many.
  const done = Array.from({ length: JOURNAL_MAX }, (_, i): LiveTransfer => ({ ...burn, id: `back-d${i}-x`, startedAt: t0 + (10 + i) * 1000 }));
  const open: LockTransfer = { ...lock, id: "in-old1-evm", startedAt: t0 + 1000 };
  const a = ids([...done, old, open]);
  assert.equal(a.size, JOURNAL_MAX);
  assert.ok(a.has(old.id) && a.has(open.id));
  assert.ok(!a.has("back-d0-x") && !a.has("back-d1-x") && a.has("back-d2-x"));
  // Nothing finished to drop: the oldest others go, never that lock.
  const locks = Array.from({ length: JOURNAL_MAX + 3 }, (_, i): LiveTransfer => ({ ...lock, id: `in-e${i}-x`, startedAt: t0 + (10 + i) * 1000 }));
  const b = ids([...locks, old]);
  assert.equal(b.size, JOURNAL_MAX);
  assert.ok(b.has(old.id) && !b.has("in-e0-x") && !b.has("in-e3-x") && b.has("in-e4-x"));
  // Locked, its nonce read: kept too. Nothing on V3 (expired, declined): dropped like any other.
  assert.ok(ids([...locks, { ...old, lock: { stage: "mined", hash: H(12), sentAt: t0, block: 220_920, minedAt: t0 + 6000, gasUsed: null }, nonce: 3 }]).has(old.id));
  const expired: LockTransfer = { ...old, failure: { reason: "refused", at: t0 + 400_000, title: "The lock expired", text: null } };
  assert.ok(!ids([...locks, expired]).has(old.id));
  assert.ok(!ids([...locks, { ...old, lock: { stage: "asking" }, failure: { reason: "rejected", at: t0 + 9000, title: null, text: null } }]).has(old.id));
});

test("a version-1 journal still reads: its locks are Ethereum wallets' locks, paid to their own address", () => {
  const v1 = raw(lock);
  for (const k of ["sender", "ext", "mintBy", "autoPending", "dest"]) delete v1[k];
  const back = decodeJournal(text([v1, raw(burn)], 1));
  assert.equal(back.length, 2);
  const l = back[0] as LockTransfer;
  assert.equal(l.dest, "sepolia");
  assert.deepEqual(l.sender, { kind: "evm", address: ME });
  assert.equal(l.ext, null);
  assert.equal(l.mintBy, null);
  assert.equal(l.autoPending, false);
});

test("a lock whose sender or extrinsic does not read is dropped: an Ethereum sender is its own recipient, a Substrate one names its account", () => {
  const r = raw(substrate);
  const s = r.sender as Record<string, unknown>;
  const bad: unknown[] = [
    { ...raw(lock), sender: { kind: "evm", address: "0x00000000000000000000000000000000000000bb" } },
    { ...raw(lock), sender: { kind: "evm", address: ME }, ext: { nonce: 1, from: 1, to: 64 } },
    { ...r, sender: { ...s, kind: "ink" } },
    { ...r, sender: { ...s, ss58: "0xb621f9a9dd96ba88681c40b04657cef602854e24" } },
    { ...r, sender: { ...s, h160: "0x12" } },
    { ...r, sender: { ...s, wallet: 7 } },
    { ...r, ext: { nonce: 7, from: 220_973, to: 220_910 } },
    { ...r, ext: { nonce: -1, from: 1, to: 2 } },
    { ...r, mintBy: "auto-mint" },
  ];
  assert.deepEqual(decodeJournal(text([...bad, raw(burn)])), [{ ...burn, note: null }]);
});

// ---------------------------------------------------------------------------------------------
// Version 3: each transfer's destination

/** Lock 4's kind of transfer: a lock that names Base Sepolia, minted there by auto-mint. */
const toBase: LockTransfer = {
  ...lock,
  id: "in-mhb4a000-b4",
  dest: "base-sepolia",
  startedAt: 1_761_500_050_000,
  mint: { stage: "mined", hash: H(13), sentAt: 1_761_500_090_000, block: 51_159_736, minedAt: 1_761_500_096_000, gasUsed: 2_637_646 },
  doneAt: 1_761_500_096_000,
  mintBy: "0x57cc2ba3b883339a9f32726e6d0d3a9ee861a113",
};
/** Burn 0's kind of transfer on Arbitrum Sepolia: its own burn nonce 0, waiting for finality. */
const fromArbitrum: BurnTransfer = {
  ...burn,
  id: "back-mhb5a000-a5",
  dest: "arbitrum-sepolia",
  burnNonce: 0,
  speed: "std",
  doneAt: null,
  depth: { confirmations: 2_000, final: false, qualifiedAt: null },
  release: { approvals: 0, open: null, run: null, at: null, released: false },
};

test("each transfer comes back with its destination: a lock to Base Sepolia, a burn on Arbitrum Sepolia, Sepolia's", () => {
  const back = decodeJournal(encodeJournal([toBase, fromArbitrum, lock]));
  assert.deepEqual(back, [
    { ...lock, note: null },
    { ...toBase, note: null },
    { ...fromArbitrum, note: null },
  ]);
  assert.deepEqual(
    back.map((t) => t.dest),
    ["sepolia", "base-sepolia", "arbitrum-sepolia"],
  );
  const written = JSON.parse(encodeJournal([toBase]));
  assert.equal(written.v, 3);
  assert.equal(written.transfers[0].dest, "base-sepolia");
});

test("a transfer stored without a chain reads as Sepolia's, whatever the version: the only chain the page sent to before", () => {
  for (const v of [1, 2, 3]) {
    const r = raw(lock);
    delete r.dest;
    const b = raw(burn);
    delete b.dest;
    const back = decodeJournal(text([r, b], v));
    assert.deepEqual(
      back.map((t) => [t.id, t.dest]),
      [
        [lock.id, "sepolia"],
        [burn.id, "sepolia"],
      ],
      `version ${v}`,
    );
  }
});

test("a destination the page does not know is dropped, never taken for Sepolia's", () => {
  const bad: unknown[] = [
    { ...raw(toBase), dest: "optimism-sepolia" },
    { ...raw(toBase), dest: 84_532 },
    { ...raw(fromArbitrum), dest: null },
    { ...raw(fromArbitrum), dest: "Arbitrum Sepolia" },
  ];
  assert.deepEqual(decodeJournal(text([...bad, raw(fromArbitrum)], 3)), [{ ...fromArbitrum, note: null }]);
});

test("the cap and the merge keep each transfer's destination", () => {
  const stored = decodeJournal(encodeJournal([toBase]));
  const merged = mergeJournal(stored, [fromArbitrum], (id) => id === fromArbitrum.id);
  assert.deepEqual(
    decodeJournal(encodeJournal(merged)).map((t) => [t.id, t.dest]),
    [
      [toBase.id, "base-sepolia"],
      [fromArbitrum.id, "arbitrum-sepolia"],
    ],
  );
});

/** A lock to Base Sepolia found minted (used(nonce) true) by a transaction older than its nodes search: done, its mint unnamed. */
const mintedBeyond: LockTransfer = {
  ...toBase,
  id: "in-mhb6a000-b6",
  startedAt: 1_761_600_000_000,
  mint: null,
  mintBy: null,
  mintBeyond: 1_761_900_000_000,
  doneAt: 1_761_900_000_000,
};

test("a lock found minted by a transaction older than the nodes search keeps when the page found it so, and reads as done; a bad time drops it", () => {
  const back = decodeJournal(encodeJournal([mintedBeyond, toBase]));
  assert.deepEqual(back, [
    { ...toBase, note: null },
    { ...mintedBeyond, note: null },
  ]);
  // Absent on every other entry, as written before.
  assert.equal("mintBeyond" in raw(toBase), false);
  assert.equal(raw(mintedBeyond).mintBeyond, 1_761_900_000_000);
  for (const bad of [0, -1, "soon", null]) assert.deepEqual(decodeJournal(text([{ ...raw(mintedBeyond), mintBeyond: bad }], 3)), [], String(bad));
});
