// The way in's mint handed to auto-mint (src/app/handoff.ts): which locks it takes, how long the page
// waits before it offers the visitor's own mint, and how long when auto-mint's key has a mint the
// chain has not mined; on a rollup, the wait for the relayer's run after a V3 set change, and the
// offer held until a few minutes after that run. Times from the lock's V3 block. Offline.

import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTO_MINT, RELAY_AFTER_CHANGE_MS, SET_CHANGES_TEXT, V3_SET_CHANGES_UTC, autoMints, handoffOf, handoffProgress, mintDueAt, relayWait, utcClock } from "../src/app/handoff.ts";
import { parseAmount } from "../src/app/txmath.ts";

const MIN = AUTO_MINT.min;
const AT = 1_761_600_000_000;
const MIN_MS = 60_000;

test("auto-mint takes Ethereum wallets' locks of 0.001 tPOT and more: the live process's --min-amount", () => {
  assert.equal(MIN, parseAmount("0.001"));
  assert.equal(autoMints(MIN, "evm"), true);
  assert.equal(autoMints(MIN - 1n, "evm"), false);
  assert.equal(autoMints(parseAmount("0.5")!, "evm"), true);
  assert.equal(autoMints(parseAmount("0.0009")!, "evm"), false);
  assert.equal(AUTO_MINT.key, "0x57cc2ba3b883339a9f32726e6d0d3a9ee861a113");
});

test("auto-mint takes a Polkadot wallet's lock of 0.001 tPOT and more too: it reads the lock's event from System.Events (lock 3)", () => {
  assert.equal(AUTO_MINT.substrate, true);
  assert.equal(autoMints(MIN - 1n, "substrate"), false);
  for (const amount of [MIN, parseAmount("0.5")!, parseAmount("100")!]) {
    assert.equal(autoMints(amount, "substrate"), true);
    // As an Ethereum wallet's lock: the page waits, and offers the visitor's own mint after 5 minutes.
    assert.deepEqual(handoffOf(amount, "substrate", AT, AT, false), { kind: "waiting", offerAt: AT + 5 * MIN_MS });
    assert.deepEqual(handoffOf(amount, "substrate", AT, AT + 5 * MIN_MS, false), { kind: "offer", since: AT + 5 * MIN_MS });
  }
  // Below the minimum the visitor mints it.
  assert.deepEqual(handoffOf(MIN - 1n, "substrate", AT, AT, false), { kind: "self" });
});

test("below the minimum the visitor mints it, as before: no wait, no offer", () => {
  for (const now of [AT, AT + 4 * MIN_MS, AT + 60 * MIN_MS]) assert.deepEqual(handoffOf(MIN - 1n, "evm", AT, now, false), { kind: "self" });
  assert.deepEqual(handoffOf(MIN - 1n, "evm", AT, AT, true), { kind: "self" });
});

test("auto-mint's: the page waits, and offers the visitor's own mint 5 minutes after the lock's block", () => {
  assert.deepEqual(handoffOf(MIN, "evm", AT, AT, false), { kind: "waiting", offerAt: AT + 5 * MIN_MS });
  assert.deepEqual(handoffOf(MIN, "evm", AT, AT + 144_000, false), { kind: "waiting", offerAt: AT + 5 * MIN_MS });
  assert.deepEqual(handoffOf(MIN, "evm", AT, AT + 5 * MIN_MS - 1, false), { kind: "waiting", offerAt: AT + 5 * MIN_MS });
  assert.deepEqual(handoffOf(MIN, "evm", AT, AT + 5 * MIN_MS, false), { kind: "offer", since: AT + 5 * MIN_MS });
  assert.deepEqual(handoffOf(MIN, "evm", AT, AT + 3 * 60 * MIN_MS, false), { kind: "offer", since: AT + 5 * MIN_MS });
});

test("while auto-mint's key has a transaction Sepolia has not mined, the offer waits until 15 minutes: auto-mint sends one at a time, and replaces a stuck one after 10", () => {
  assert.deepEqual(handoffOf(MIN, "evm", AT, AT + 6 * MIN_MS, true), { kind: "pending", offerAt: AT + 15 * MIN_MS });
  assert.deepEqual(handoffOf(MIN, "evm", AT, AT + MIN_MS, true), { kind: "pending", offerAt: AT + 15 * MIN_MS });
  assert.deepEqual(handoffOf(MIN, "evm", AT, AT + 15 * MIN_MS, true), { kind: "offer", since: AT + 15 * MIN_MS });
  // Mined meanwhile: back to the 5 minutes, already passed.
  assert.deepEqual(handoffOf(MIN, "evm", AT, AT + 6 * MIN_MS, false), { kind: "offer", since: AT + 5 * MIN_MS });
});

test("the mint step's segment fills toward lock 2's 144 s, and stops short of the end", () => {
  assert.equal(AUTO_MINT.usualSeconds, 144);
  assert.equal(handoffProgress(AT, AT), 0);
  assert.equal(handoffProgress(AT, AT + 72_000), 0.5);
  assert.equal(handoffProgress(AT, AT + 10 * MIN_MS), 0.9);
  assert.equal(handoffProgress(AT, AT - 5_000), 0);
});

// ---------------------------------------------------------------------------------------------
// The rollups: the same handoff, and the relayer's run after a V3 set change

/** Oct 28, 2026, 00:00 UTC. */
const DAY = Date.UTC(2026, 9, 28);
const at = (h: number, m: number, s = 0) => DAY + ((h * 60 + m) * 60 + s) * 1000;

test("auto-mint takes a lock to a rollup as one to Sepolia: the same minimum, and the visitor's own mint offered 5 minutes after the lock's block", () => {
  // The handoff does not depend on the destination: one process, one rule (README rows 98 to 107).
  assert.deepEqual(handoffOf(MIN, "evm", AT, AT + 4 * MIN_MS, false), { kind: "waiting", offerAt: AT + 5 * MIN_MS });
  assert.deepEqual(handoffOf(MIN, "evm", AT, AT + 5 * MIN_MS, false), { kind: "offer", since: AT + 5 * MIN_MS });
  assert.deepEqual(handoffOf(MIN - 1n, "evm", AT, AT, false), { kind: "self" });
});

test("V3 changes validator set at 01:54, 07:54, 13:54 and 19:54 UTC, and the rollups' relayer runs 6 minutes later", () => {
  assert.deepEqual(V3_SET_CHANGES_UTC, [114, 474, 834, 1194]);
  assert.equal(SET_CHANGES_TEXT, "01:54, 07:54, 13:54 and 19:54 UTC");
  assert.equal(RELAY_AFTER_CHANGE_MS, 6 * MIN_MS);
  assert.equal(utcClock(at(1, 54)), "01:54 UTC");
  assert.equal(utcClock(at(20, 0, 59)), "20:00 UTC");
});

test("a lock to a rollup whose auto-mint would come between a set change and the relayer's run waits for that run; Sepolia's never does", () => {
  // Auto-mint comes to a lock about lock 2's 144 s after its block: a lock at 01:52 is taken at 01:54:24, inside 01:54 to 02:00.
  for (const key of ["base-sepolia", "arbitrum-sepolia"] as const) {
    assert.deepEqual(relayWait(key, at(1, 52)), { change: at(1, 54), relay: at(2, 0) });
    assert.deepEqual(relayWait(key, at(13, 56)), { change: at(13, 54), relay: at(14, 0) });
    assert.deepEqual(relayWait(key, at(19, 51, 36)), { change: at(19, 54), relay: at(20, 0) });
    // Taken before the change (01:51:35 + 144 s = 01:53:59), or after the run: no wait.
    assert.equal(relayWait(key, at(1, 51, 35)), null);
    assert.equal(relayWait(key, at(1, 57, 36)), null);
    assert.equal(relayWait(key, at(10, 0)), null);
  }
  assert.equal(relayWait("sepolia", at(1, 52)), null);
});

test("the mint step's bar fills toward when auto-mint usually mints: lock 2's 144 s, or later when it waits for the relayer", () => {
  const lockedAt = at(1, 52);
  const until = at(2, 0) + 54_000;
  assert.equal(handoffProgress(lockedAt, lockedAt, until), 0);
  assert.equal(handoffProgress(lockedAt, lockedAt + (until - lockedAt) / 2, until), 0.5);
  assert.equal(handoffProgress(lockedAt, until + MIN_MS, until), 0.9);
  // Without it, as before: lock 2's 144 s.
  assert.equal(handoffProgress(lockedAt, lockedAt + 72_000), 0.5);
});

test("a lock that waits for the relayer's run is offered to its visitor 3 minutes after the run, not 5 after the lock: sooner would race auto-mint and import the set change too", () => {
  assert.equal(AUTO_MINT.afterRelayMs, 3 * MIN_MS);
  // Locked at 01:51:36: auto-mint comes to it at 01:54:00, inside 01:54 to 02:00, so it waits for the 02:00 run.
  const lockedAt = at(1, 51, 36);
  const wait = relayWait("base-sepolia", lockedAt);
  assert.deepEqual(wait, { change: at(1, 54), relay: at(2, 0) });
  // 5 minutes after the lock is 01:56:36, 204 s before the run: still waiting, until 02:03.
  assert.deepEqual(handoffOf(MIN, "evm", lockedAt, at(1, 56, 36), false, wait), { kind: "waiting", offerAt: at(2, 3) });
  assert.deepEqual(handoffOf(MIN, "evm", lockedAt, at(2, 2, 59), false, wait), { kind: "waiting", offerAt: at(2, 3) });
  assert.deepEqual(handoffOf(MIN, "evm", lockedAt, at(2, 3), false, wait), { kind: "offer", since: at(2, 3) });
  // A lock at 01:54, a minute before its offer would have been due under the 5 minutes, waits for 02:03 as well.
  const late = at(1, 54);
  assert.deepEqual(handoffOf(MIN, "evm", late, late + 5 * MIN_MS, false, relayWait("arbitrum-sepolia", late)), { kind: "waiting", offerAt: at(2, 3) });
  // auto-mint's pending transaction still holds the offer to 15 minutes after the lock, past the relayer's floor.
  assert.deepEqual(handoffOf(MIN, "evm", lockedAt, at(2, 4), true, wait), { kind: "pending", offerAt: lockedAt + 15 * MIN_MS });
  // No wait (Sepolia, or a lock clear of the set change): the 5 minutes, as before.
  assert.deepEqual(handoffOf(MIN, "evm", lockedAt, lockedAt + 5 * MIN_MS, false, null), { kind: "offer", since: lockedAt + 5 * MIN_MS });
  assert.deepEqual(handoffOf(MIN, "evm", lockedAt, lockedAt + 5 * MIN_MS, false, relayWait("sepolia", lockedAt)), { kind: "offer", since: lockedAt + 5 * MIN_MS });
  // Below auto-mint's minimum the visitor mints it whatever the relayer does.
  assert.deepEqual(handoffOf(MIN - 1n, "evm", lockedAt, lockedAt, false, wait), { kind: "self" });
});

test("when auto-mint usually mints: lock 2's 144 s after the lock, or its round about a minute after the relayer's run it waits for", () => {
  assert.equal(mintDueAt("base-sepolia", at(10, 0)), at(10, 2, 24));
  assert.equal(mintDueAt("sepolia", at(1, 52)), at(1, 54, 24));
  // Locked at 01:52: the 02:00 run, then 54 s (lock 2's 144 s less its 90 s grace, long past).
  assert.equal(mintDueAt("arbitrum-sepolia", at(1, 52)), at(2, 0, 54));
});
