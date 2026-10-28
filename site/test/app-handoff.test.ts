// The way in's mint handed to auto-mint (src/app/handoff.ts): which locks it takes, how long the page
// waits before it offers the visitor's own mint, and how long when auto-mint's key has a mint
// Sepolia has not mined. Times from the lock's V3 block. Offline.

import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTO_MINT, autoMints, handoffOf, handoffProgress } from "../src/app/handoff.ts";
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
