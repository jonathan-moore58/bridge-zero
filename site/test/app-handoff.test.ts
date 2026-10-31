// The way in's mint handed to auto-mint (src/app/handoff.ts): which locks it takes, how long the page
// waits before it offers the visitor's own mint, and how long when auto-mint's key has a mint the
// chain has not mined; and while a destination's light client reads behind V3's validator set, what
// the page says of the relayer that brings it to the new set, with no clock in it. Times from the
// lock's V3 block. Offline.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DESTS, destOf } from "../src/app/dests.ts";
import * as handoff from "../src/app/handoff.ts";
import { timeOf } from "../src/app/facts.ts";
import { parseAmount } from "../src/app/txmath.ts";

const { AUTO_MINT, RELAY_EVERY_MIN, autoMints, handoffOf, handoffProgress, relayAfterChange, relayFootWhen, relayNote, relayNotice, relayOfferWhy, relayStepLine, relayWithin, setChangesText } = handoff;

const here = dirname(fileURLToPath(import.meta.url));
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

test("auto-mint takes a lock to a rollup as one to Sepolia: the same minimum, and the visitor's own mint offered 5 minutes after the lock's block", () => {
  // The handoff does not depend on the destination: one process, one rule (README rows 98 to 107).
  assert.deepEqual(handoffOf(MIN, "evm", AT, AT + 4 * MIN_MS, false), { kind: "waiting", offerAt: AT + 5 * MIN_MS });
  assert.deepEqual(handoffOf(MIN, "evm", AT, AT + 5 * MIN_MS, false), { kind: "offer", since: AT + 5 * MIN_MS });
  assert.deepEqual(handoffOf(MIN - 1n, "evm", AT, AT, false), { kind: "self" });
});

// ---------------------------------------------------------------------------------------------
// A light client behind V3's validator set: read, not predicted

const SEP = destOf("sepolia");
const BASE = destOf("base-sepolia");
const ARB = destOf("arbitrum-sepolia");
const line = (l: readonly (string | { nb: string })[]): string => l.map((x) => (typeof x === "string" ? x : x.nb)).join("");

test("no clock in the handoff: a lock at any time of day, the times V3 changed set at until Oct 28 and on Oct 31 among them, is offered to its visitor 5 minutes after its block", () => {
  // V3's set changes followed 01:54, 07:54, 13:54 and 19:54 UTC until Oct 28; set 65 began at 02:54 UTC on Oct 29, set 75 at 18:54:06 on Oct 31.
  const times = [Date.UTC(2026, 9, 28, 1, 52), Date.UTC(2026, 9, 28, 1, 54), Date.UTC(2026, 9, 28, 13, 56), Date.UTC(2026, 9, 28, 19, 51, 36), Date.UTC(2026, 9, 29, 2, 54, 6), Date.UTC(2026, 9, 31, 18, 54, 6), Date.UTC(2026, 9, 31, 10, 0)];
  for (const lockedAt of times) {
    assert.deepEqual(handoffOf(MIN, "evm", lockedAt, lockedAt + 5 * MIN_MS - 1, false), { kind: "waiting", offerAt: lockedAt + 5 * MIN_MS }, new Date(lockedAt).toISOString());
    assert.deepEqual(handoffOf(MIN, "evm", lockedAt, lockedAt + 5 * MIN_MS, false), { kind: "offer", since: lockedAt + 5 * MIN_MS }, new Date(lockedAt).toISOString());
    assert.equal(handoffProgress(lockedAt, lockedAt + 72_000), 0.5);
  }
  // The clock's predictions are gone from the module: no set-change times, no relayer run after them.
  for (const gone of ["V3_SET_CHANGES_UTC", "SET_CHANGES_TEXT", "RELAY_AFTER_CHANGE_MS", "relayWait", "mintDueAt", "utcClock"]) assert.equal(gone in handoff, false, gone);
  assert.equal("afterRelayMs" in AUTO_MINT, false);
});

test("the relayer runs every 10 minutes for Sepolia's light client and every 20 for each rollup's: once V3 has changed set, the page says the client is at the new set within about that long", () => {
  assert.deepEqual(RELAY_EVERY_MIN, { sepolia: 10, "base-sepolia": 20, "arbitrum-sepolia": 20 });
  for (const d of DESTS) assert.ok(RELAY_EVERY_MIN[d.key] > 0, d.key);
  assert.equal(relayWithin("sepolia"), "within about 10 minutes");
  assert.equal(relayWithin("base-sepolia"), "within about 20 minutes");
  assert.equal(relayWithin("arbitrum-sepolia"), "within about 20 minutes");
  assert.equal(setChangesText(1), "a validator-set change");
  assert.equal(setChangesText(3), "3 validator-set changes");
});

test("while the light client reads behind V3's set: the card's notice and the review's note say that auto-mint waits for the relayer, and how soon it comes", () => {
  // At V3's set: no note.
  assert.equal(relayNote(BASE, 0), null);
  assert.equal(
    relayNote(BASE, 1),
    "The light client on Base Sepolia is a validator-set change behind V3: auto-mint mints a lock made now once the relayer has imported it, within about 20 minutes.",
  );
  assert.equal(relayNote(SEP, 2), "The V3 light client is 2 validator-set changes behind V3: auto-mint mints a lock made now once the relayer has imported them, within about 10 minutes.");
  assert.equal(
    relayNotice(ARB, 1, timeOf("arbitrum-sepolia", "auto")[0]),
    "Auto-mint mints your lock once the relayer has imported it, within about 20 minutes, so it can take longer than ≈ 2¼ min. If it has not minted it within 5 minutes of your lock, this page offers you the mint, which imports the change itself.",
  );
  assert.equal(
    relayNotice(SEP, 2, timeOf("sepolia", "auto")[0]),
    "Auto-mint mints your lock once the relayer has imported them, within about 10 minutes, so it can take longer than ≈ 2½ min. If it has not minted it within 5 minutes of your lock, this page offers you the mint, which imports the changes itself.",
  );
  // Where nothing reads behind, the review and the way in's tooltip say what any set change does.
  assert.equal(
    relayAfterChange(BASE, "auto-mint", "the light client on Base Sepolia"),
    "After V3 changes validator set, auto-mint waits for the relayer to bring the light client on Base Sepolia to the new set, within about 20 minutes",
  );
  assert.equal(relayAfterChange(ARB, "it", "this client"), "After V3 changes validator set, it waits for the relayer to bring this client to the new set, within about 20 minutes");
});

test("while the light client reads behind V3's set: the transfer screen's mint step, its foot and the offer of the visitor's own mint say the same", () => {
  assert.equal(line(relayStepLine(BASE, 1)), "Auto-mint waits for the relayer, within about 20 minutes · the light client on Base Sepolia is a validator-set change behind V3 · nothing to sign");
  assert.equal(line(relayStepLine(SEP, 2)), "Auto-mint waits for the relayer, within about 10 minutes · the light client on Sepolia is 2 validator-set changes behind V3 · nothing to sign");
  // Each part unbroken, as the step's other lines: on a phone the line wraps between them.
  assert.ok(relayStepLine(ARB, 1).some((x) => typeof x !== "string" && x.nb === "within about 20 minutes"));
  assert.equal(relayFootWhen(ARB), "once the relayer has imported V3's new validator set there, within about 20 minutes");
  assert.equal(relayFootWhen(SEP), "once the relayer has imported V3's new validator set on Sepolia, within about 10 minutes");
  assert.equal(relayOfferWhy(ARB, 1), "The light client on Arbitrum Sepolia is a validator-set change behind V3: auto-mint mints this lock once the relayer has imported it, within about 20 minutes.");
  assert.equal(relayOfferWhy(BASE, 2), "The light client on Base Sepolia is 2 validator-set changes behind V3: auto-mint mints this lock once the relayer has imported them, within about 20 minutes.");
});

test("no page of the app states a time V3 changes set at, nor a relayer run fixed after one: the views take the relayer's words from handoff.ts", () => {
  const app = join(here, "..", "src", "app");
  const files = [...readdirSync(app).map((f) => join(app, f)), ...readdirSync(join(app, "views")).map((f) => join(app, "views", f))].filter((f) => /\.tsx?$/.test(f));
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const fixed of [/\b\d\d:54\b/, /RELAY_AFTER_CHANGE/, /SET_CHANGES_TEXT/, /V3_SET_CHANGES_UTC/, /relayWait\(/, /utcClock/]) assert.equal(fixed.test(src), false, `${f}: ${fixed}`);
  }
  // The Bridge card, the transfer screen and the Network page read the cadence and the words from handoff.ts.
  const view = (name: string) => readFileSync(join(app, "views", name), "utf8");
  assert.match(view("Bridge.tsx"), /relayNotice\(d, net\.behind/);
  assert.match(view("Bridge.tsx"), /relayNote\(d, behind\)/);
  assert.match(view("Bridge.tsx"), /RELAY_EVERY_MIN\[d\.key\]/);
  assert.match(view("Tx.tsx"), /relayStepLine\(d, behind\)/);
  assert.match(view("Tx.tsx"), /relayOfferWhy\(d, behind\)/);
  assert.match(view("Network.tsx"), /a run every \{RELAY_EVERY_MIN\[d\.key\]\} minutes/);
});
