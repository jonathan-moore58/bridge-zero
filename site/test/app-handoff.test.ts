// The way in's mint handed to auto-mint (src/app/handoff.ts): which locks it takes, how long the page
// waits before it offers the visitor's own mint, how long when auto-mint's key has a mint the chain
// has not mined, and how long once the page has read the light client back at V3's set; and while a
// destination's light client reads behind V3's validator set, what the page says of the relayer
// that brings it to the new set, with no clock in it, and with no time at all once the relayer has
// fallen behind. Times from the lock's V3 block. Offline.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ALL_DESTS, DESTS, destOf, type DestKey } from "../src/app/dests.ts";
import * as handoff from "../src/app/handoff.ts";
import { timeOf } from "../src/app/facts.ts";
import type { NetState } from "../src/app/netstate.ts";
import { parseAmount } from "../src/app/txmath.ts";

const {
  AUTO_MINT,
  RELAY_EVERY_MIN,
  autoFoot,
  autoMintAhead,
  autoMints,
  autoWaitStep,
  clientOn,
  handoffOf,
  handoffProgress,
  lockReadOf,
  offerOf,
  relayAfterChange,
  relayAutoWait,
  relayNote,
  relayNotice,
  relayOfferWhy,
  relayStepLine,
  relayWithin,
  setChangesText,
} = handoff;

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
  assert.deepEqual(handoffOf(MIN - 1n, "evm", AT, AT + 30 * MIN_MS, false, AT + 20 * MIN_MS), { kind: "self" });
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

test("once the page has read the light client back at V3's set after the lock, the offer waits 3 minutes from that read: auto-mint mints the lock in its next round", () => {
  assert.equal(AUTO_MINT.afterCatchUpMs, 3 * MIN_MS);
  // The relayer brought the client to V3's set 12 minutes after the lock: the offer that was up since 5 minutes waits until 15.
  const caught = AT + 12 * MIN_MS;
  assert.deepEqual(handoffOf(MIN, "evm", AT, caught + 1000, false, caught), { kind: "waiting", offerAt: caught + 3 * MIN_MS, caughtUp: true });
  assert.deepEqual(handoffOf(MIN, "evm", AT, caught + 3 * MIN_MS - 1, false, caught), { kind: "waiting", offerAt: caught + 3 * MIN_MS, caughtUp: true });
  assert.deepEqual(handoffOf(MIN, "evm", AT, caught + 3 * MIN_MS, false, caught), { kind: "offer", since: caught + 3 * MIN_MS });
  // Caught up within 2 minutes of the lock, before auto-mint's grace is over: the usual 5 minutes, the usual line.
  assert.deepEqual(handoffOf(MIN, "evm", AT, AT + 3 * MIN_MS, false, AT + MIN_MS), { kind: "waiting", offerAt: AT + 5 * MIN_MS });
  assert.deepEqual(handoffOf(MIN, "evm", AT, AT + 5 * MIN_MS, false, AT + 2 * MIN_MS), { kind: "offer", since: AT + 5 * MIN_MS });
  // A catch-up before the lock says nothing of it.
  assert.deepEqual(handoffOf(MIN, "evm", AT, AT + 5 * MIN_MS, false, AT - MIN_MS), { kind: "offer", since: AT + 5 * MIN_MS });
  assert.deepEqual(handoffOf(MIN, "evm", AT, AT + 5 * MIN_MS, false, AT), { kind: "offer", since: AT + 5 * MIN_MS });
  // A transaction of auto-mint's pending: whichever comes later.
  assert.deepEqual(handoffOf(MIN, "evm", AT, AT + 16 * MIN_MS, true, AT + 14 * MIN_MS), { kind: "pending", offerAt: AT + 17 * MIN_MS });
  assert.deepEqual(handoffOf(MIN, "evm", AT, AT + 6 * MIN_MS, true, AT + 4 * MIN_MS), { kind: "pending", offerAt: AT + 15 * MIN_MS });
});

// ---------------------------------------------------------------------------------------------
// A light client behind V3's validator set: read, not predicted

const SEP = destOf("sepolia");
const BASE = destOf("base-sepolia");
const ARB = destOf("arbitrum-sepolia");
const line = (l: readonly (string | { nb: string })[]): string => l.map((x) => (typeof x === "string" ? x : x.nb)).join("");
/** A status as net.ts gives it: the light client on `dest` at `behind` changes behind V3, its latest header #266,907. */
const net = (dest: NetState["dest"], key: NetState["key"], behind = 0, more: Partial<NetState> = {}) => ({ dest, key, behind, latest: 266_907, stale: false, caughtUpAt: null, ...more });
const READ: handoff.LockRead = { behind: 0, caughtUpAt: null, known: "read" };
const NBSP = "\u00a0";

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

test("the relayer runs every 10 minutes for Sepolia's light client and every 20 for each rollup's: once V3 has changed set, the client is at the new set within about that long, usually on Sepolia", () => {
  // The BNB Smart Chain testnet's, hidden until its activation, on the rollups' timer from then (ops/bnb-activation.md).
  assert.deepEqual(RELAY_EVERY_MIN, { sepolia: 10, "base-sepolia": 20, "arbitrum-sepolia": 20, "bsc-testnet": 20 });
  for (const d of ALL_DESTS) assert.ok(RELAY_EVERY_MIN[d.key] > 0, d.key);
  // Sepolia's relayer holds a set change while the base fee is above its gate, and runs 10 minutes after the last run ended: usually.
  assert.equal(relayWithin("sepolia"), "usually within about 10 minutes");
  assert.equal(relayWithin("base-sepolia"), "within about 20 minutes");
  assert.equal(relayWithin("arbitrum-sepolia"), "within about 20 minutes");
  assert.equal(relayWithin("bsc-testnet"), "within about 20 minutes");
  assert.equal(setChangesText(1), "a validator-set change");
  assert.equal(setChangesText(3), "3 validator-set changes");
  // One name for each client: Sepolia's is the V3 light client, as the status page names it.
  assert.equal(clientOn(SEP), "the V3 light client");
  assert.equal(clientOn(BASE, true), "The light client on Base Sepolia");
});

test("what the page reads for one lock: the client's set against V3's, not when the client already holds the lock's block, and only for the lock's own destination", () => {
  // Behind V3's set, the lock after the client's latest header (or not on V3 yet): it waits for the relayer.
  assert.deepEqual(lockReadOf(net("base-sepolia", "relay", 1), "base-sepolia", 266_950), { behind: 1, caughtUpAt: null, known: "read" });
  assert.deepEqual(lockReadOf(net("base-sepolia", "relay", 2), "base-sepolia", null), { behind: 2, caughtUpAt: null, known: "read" });
  // The client holds a header at or after the lock's block: auto-mint's held path mints it with no import.
  assert.equal(lockReadOf(net("base-sepolia", "relay", 1), "base-sepolia", 266_907).behind, 0);
  assert.equal(lockReadOf(net("base-sepolia", "relay", 1), "base-sepolia", 266_000).behind, 0);
  assert.equal(lockReadOf(net("base-sepolia", "relay", 1, { latest: null }), "base-sepolia", 266_000).behind, 1);
  // At V3's set, paused: nothing behind.
  assert.equal(lockReadOf(net("sepolia", "ready"), "sepolia", 266_950).behind, 0);
  assert.equal(lockReadOf(net("sepolia", "paused"), "sepolia", 266_950).behind, 0);
  // Another destination's status: nothing known of this one's client yet.
  assert.deepEqual(lockReadOf(net("sepolia", "relay", 1), "base-sepolia", 266_950), { behind: 0, caughtUpAt: null, known: "reading" });
  // Whether it rests on a read: before the first answers, after one failed, after a refresh failed.
  assert.equal(lockReadOf(net("sepolia", "checking"), "sepolia", null).known, "reading");
  assert.equal(lockReadOf(net("sepolia", "rpc"), "sepolia", null).known, "unread");
  assert.equal(lockReadOf(net("sepolia", "ready", 0, { stale: true }), "sepolia", null).known, "unread");
  // A stale read behind stays behind: the read before it said so.
  assert.equal(lockReadOf(net("sepolia", "relay", 1, { stale: true }), "sepolia", null).behind, 1);
  // The catch-up the page read, for the handoff.
  assert.equal(lockReadOf(net("arbitrum-sepolia", "ready", 0, { caughtUpAt: AT }), "arbitrum-sepolia", null).caughtUpAt, AT);
});

test("while the light client reads behind V3's set: the card's notice and the review's notes say that auto-mint waits for the relayer, and how soon it comes", () => {
  // At V3's set: no note.
  assert.equal(relayNote(BASE, 0), null);
  assert.equal(
    relayNote(BASE, 1),
    "The light client on Base Sepolia is a validator-set change behind V3: auto-mint mints a lock made now once the relayer has imported it, within about 20 minutes.",
  );
  assert.equal(relayNote(SEP, 1), "The V3 light client is a validator-set change behind V3: auto-mint mints a lock made now once the relayer has imported it, usually within about 10 minutes.");
  // The usual time kept on one line on a phone.
  assert.equal(
    relayNotice(ARB, 1, timeOf("arbitrum-sepolia", "auto")[0]),
    `Auto-mint mints your lock once the relayer has imported it, within about 20 minutes, so it can take longer than ≈${NBSP}2¼${NBSP}min. If it has not minted it within 5 minutes of your lock, this page offers you the mint, which imports the change itself.`,
  );
  // Where nothing reads behind, the review and the way in's tooltip say what any set change does.
  assert.equal(
    relayAfterChange(BASE, "auto-mint", "the light client on Base Sepolia"),
    "After V3 changes validator set, auto-mint waits for the relayer to bring the light client on Base Sepolia to the new set, within about 20 minutes",
  );
  assert.equal(relayAfterChange(ARB, "it", "this client"), "After V3 changes validator set, it waits for the relayer to bring this client to the new set, within about 20 minutes");
  // The review's mint step, and the transfer screen's before the wait starts.
  assert.equal(autoMintAhead(BASE, 0, timeOf("base-sepolia", "auto")[0]), "Auto-mint, ≈ 2½ min after your lock · nothing to sign");
  assert.equal(autoMintAhead(BASE, 1, "≈ 2½ min"), "Auto-mint, once the relayer has imported V3's new validator set on Base Sepolia, within about 20 minutes · nothing to sign");
  assert.equal(autoMintAhead(SEP, 1, "≈ 2½ min"), "Auto-mint, once the relayer has imported V3's new validator set on Sepolia, usually within about 10 minutes · nothing to sign");
  // The Network page's notice, after what a mint the visitor sends does.
  assert.equal(relayAutoWait(SEP, 1), "Auto-mint waits for the relayer, which imports it on its next run, usually within about 10 minutes.");
});

test("2 or more changes behind, the relayer has missed runs (V3 changes set hours apart): every line says so, and none gives a time", () => {
  const usual = "≈ 2½ min";
  assert.equal(
    relayNote(SEP, 2),
    "The V3 light client is 2 validator-set changes behind V3: auto-mint mints a lock made now once the relayer has imported them. The relayer has not kept up with V3's changes, so this page cannot say when.",
  );
  assert.equal(
    relayNotice(SEP, 2, usual),
    `Auto-mint mints your lock once the relayer has imported them, so it can take longer than ≈${NBSP}2½${NBSP}min. The relayer has not kept up with V3's changes, so this page cannot say when. If auto-mint has not minted it within 5 minutes of your lock, this page offers you the mint, which imports the changes itself.`,
  );
  assert.equal(autoMintAhead(BASE, 2, usual), "Auto-mint, once the relayer has imported V3's 2 validator-set changes on Base Sepolia · nothing to sign");
  assert.equal(line(relayStepLine(BASE, 2)), "Auto-mint waits for the relayer, which has not kept up · the light client on Base Sepolia is 2 validator-set changes behind V3 · nothing to sign");
  assert.equal(
    relayOfferWhy(BASE, 2),
    "The light client on Base Sepolia is 2 validator-set changes behind V3: auto-mint mints this lock once the relayer has imported them. The relayer has not kept up with V3's changes, so this page cannot say when.",
  );
  assert.equal(relayAutoWait(SEP, 3), "Auto-mint waits for the relayer to import them. The relayer has not kept up with V3's changes, so this page cannot say when.");
  // One behind against two, for every text the page builds: a time for one, none for two.
  const what = "1 wtPOT for 0xAbCd…1234 on Base Sepolia";
  for (const d of DESTS) {
    const texts = (b: number): string[] => [
      relayNote(d, b) ?? "",
      relayNotice(d, b, usual),
      autoMintAhead(d, b, usual),
      line(relayStepLine(d, b)),
      relayOfferWhy(d, b),
      relayAutoWait(d, b),
      autoFoot(d, what, { ...READ, behind: b }, false, usual, false),
      offerOf(d, b, "0xAbCd…1234", "≈ 4.79 M gas").text,
    ];
    for (const t of texts(1)) assert.ok(t.includes(relayWithin(d.key)), `${d.key}, 1 behind: ${t}`);
    for (const t of texts(2)) {
      assert.ok(!t.includes("within about"), `${d.key}, 2 behind: ${t}`);
      assert.ok(t.includes("cannot say when") || t.includes("has not kept up") || t.startsWith("Auto-mint, once the relayer"), `${d.key}, 2 behind: ${t}`);
    }
  }
});

test("the transfer screen's mint step while auto-mint is to mint: the relayer's wait, the client back at V3's set, a pending transaction, or the usual line, and its segment", () => {
  const waiting = { kind: "waiting", offerAt: AT + 5 * MIN_MS } as const;
  const usual = timeOf("base-sepolia", "auto")[0];
  // The usual line, its segment toward lock 2's 144 s.
  let w = autoWaitStep(BASE, waiting, READ, AT, AT + 72_000, usual, true);
  assert.equal(w.p, 0.5);
  assert.equal(line(w.sub), "Auto-mint sends it for you · usually ≈ 2½ min after your lock · nothing to sign");
  assert.equal(line(autoWaitStep(BASE, waiting, READ, AT, AT + 72_000, usual, false).sub), "Auto-mint sends it · usually ≈ 2½ min after the lock · nothing to sign");
  // Before the first reads answer, or after one failed: the usual line says the client's set is not read.
  assert.equal(line(autoWaitStep(BASE, waiting, { ...READ, known: "reading" }, AT, AT, usual, true).sub), "Auto-mint sends it for you · usually ≈ 2½ min after your lock · reading the light client's set · nothing to sign");
  assert.equal(
    line(autoWaitStep(BASE, waiting, { ...READ, known: "unread" }, AT, AT, usual, false).sub),
    "Auto-mint sends it · usually ≈ 2½ min after the lock · the light client's set could not be checked · nothing to sign",
  );
  // Behind V3's set: the relayer's wait, which no read times: the segment stays empty.
  w = autoWaitStep(BASE, waiting, { ...READ, behind: 1 }, AT, AT + 72_000, usual, true);
  assert.equal(w.p, 0);
  assert.equal(line(w.sub), "Auto-mint waits for the relayer, within about 20 minutes · the light client on Base Sepolia is a validator-set change behind V3 · nothing to sign");
  assert.equal(
    line(autoWaitStep(SEP, waiting, { ...READ, behind: 1, known: "unread" }, AT, AT, usual, true).sub),
    "Auto-mint waits for the relayer, usually within about 10 minutes · the V3 light client is a validator-set change behind V3 · nothing to sign",
  );
  // Each part unbroken: on a phone the line wraps between them.
  assert.ok(relayStepLine(ARB, 1).some((x) => typeof x !== "string" && x.nb === "within about 20 minutes"));
  // Read back at V3's set after the lock: auto-mint's next round.
  w = autoWaitStep(ARB, { kind: "waiting", offerAt: AT + 15 * MIN_MS, caughtUp: true }, { ...READ, caughtUpAt: AT + 12 * MIN_MS }, AT, AT + 13 * MIN_MS, usual, true);
  assert.equal(w.p, 0.9);
  assert.equal(line(w.sub), "The light client on Arbitrum Sepolia is at V3's validator set again · auto-mint mints it in its next round · nothing to sign");
  // Auto-mint's key has a transaction pending.
  assert.equal(line(autoWaitStep(BASE, { kind: "pending", offerAt: AT + 15 * MIN_MS }, READ, AT, AT, usual, true).sub), "Auto-mint has a transaction waiting on Base Sepolia · yours may be queued behind it · nothing to sign");
  // No block time read: no segment.
  assert.equal(autoWaitStep(BASE, waiting, READ, null, AT, usual, false).p, 0);
});

test("the transfer screen's foot and the offer of the visitor's own mint say the same as the step", () => {
  const what = "1 wtPOT for 0xAbCd…1234 on Base Sepolia";
  const usual = "≈ 2½ min";
  assert.equal(autoFoot(BASE, what, READ, false, usual, false), "You can close this page. Auto-mint usually mints 1 wtPOT for 0xAbCd…1234 on Base Sepolia ≈ 2½ min after your lock; Activity shows it on any device.");
  assert.equal(
    autoFoot(ARB, "1 wtPOT for 0xAbCd…1234 on Arbitrum Sepolia", { ...READ, behind: 1 }, false, usual, false),
    "You can close this page. Auto-mint mints 1 wtPOT for 0xAbCd…1234 on Arbitrum Sepolia once the relayer has imported V3's new validator set there, within about 20 minutes; Activity shows it on any device.",
  );
  assert.equal(
    autoFoot(SEP, "1 wtPOT for 0xAbCd…1234", { ...READ, behind: 1 }, false, usual, true),
    "You can close this page. Auto-mint mints 1 wtPOT for 0xAbCd…1234 once the relayer has imported V3's new validator set on Sepolia, usually within about 10 minutes; Activity in this browser lists it.",
  );
  assert.equal(
    autoFoot(BASE, what, { ...READ, behind: 2 }, false, usual, false),
    "You can close this page. Auto-mint mints 1 wtPOT for 0xAbCd…1234 on Base Sepolia once the relayer has imported V3's 2 validator-set changes there. The relayer has not kept up with V3's changes, so this page cannot say when. Activity shows it on any device.",
  );
  assert.equal(
    autoFoot(BASE, what, READ, true, usual, false),
    "You can close this page. Auto-mint mints 1 wtPOT for 0xAbCd…1234 on Base Sepolia in its next round, now that the light client there is at V3's validator set again; Activity shows it on any device.",
  );
  assert.equal(
    autoFoot(SEP, "1 wtPOT for 0xAbCd…1234", READ, true, usual, false),
    "You can close this page. Auto-mint mints 1 wtPOT for 0xAbCd…1234 in its next round, now that the V3 light client is at V3's validator set again; Activity shows it on any device.",
  );
  // The offer: why auto-mint has not minted it, and what the visitor's mint does.
  assert.deepEqual(offerOf(ARB, 1, "0xAbCd…1234", "≈ 4.79 M gas in Arbitrum Sepolia ETH"), {
    title: "Auto-mint is waiting for the relayer",
    text: "The light client on Arbitrum Sepolia is a validator-set change behind V3: auto-mint mints this lock once the relayer has imported it, within about 20 minutes. Your tPOT stays locked for you, and the lock does not expire. You can mint it yourself now: any address can send the mint, it pays 0xAbCd…1234, it imports the set change first, and it costs ≈ 4.79 M gas in Arbitrum Sepolia ETH.",
  });
  assert.match(offerOf(BASE, 2, "0xAbCd…1234", "≈ 7.19 M gas").text, /cannot say when\. Your tPOT stays locked .* it imports the 2 set changes first, and it costs ≈ 7\.19 M gas\.$/);
  assert.deepEqual(offerOf(SEP, 0, "0xAbCd…1234", "≈ 2.39 M gas in Sepolia ETH"), {
    title: "Auto-mint hasn't minted it yet",
    text: "It runs on one machine and spends at most 0.02 ETH of gas a day: while that machine is off or the day's gas is spent, locks wait. Your tPOT stays locked for you, and the lock does not expire. You can mint it yourself now: any address can send the mint, it pays 0xAbCd…1234, and it costs ≈ 2.39 M gas in Sepolia ETH.",
  });
  assert.match(offerOf(BASE, 0, "0xAbCd…1234", "x").text, /^It runs on one machine, for Sepolia and the two rollups, and spends at most 0\.002 ETH of gas a day on Base Sepolia/);
});

test("auto-mint's cap on each chain is its --max-spend there, in that chain's gas token: the server's unit on the three, the runbook's 0.005 tBNB on the BNB Smart Chain testnet", () => {
  const repo = join(here, "..", "..");
  /** A command line's --max-spend, chain by chain. */
  const spends = (line: string): Record<string, string> => {
    const list = /--max-spend (\S+)/.exec(line)?.[1] ?? "";
    assert.ok(list, `a --max-spend in ${line}`);
    return Object.fromEntries(list.split(",").map((pair) => pair.split("=")));
  };
  const execOf = (text: string): string => text.split(/\r?\n/).find((l) => l.trim().startsWith("ExecStart=") && l.includes("src/automint-main.ts")) ?? "";
  // The unit the server runs: the three chains, as the page has always said them (0.02 ETH on Sepolia, 0.002 on each rollup).
  const unit = spends(execOf(readFileSync(join(repo, "ops", "server", "systemd", "bz-automint.service"), "utf8")));
  for (const d of DESTS) assert.equal(AUTO_MINT.maxSpend[d.key], unit[d.key], d.key);
  for (const [key, value] of Object.entries(unit)) assert.equal(AUTO_MINT.maxSpend[key as DestKey], value, key);
  // The unit as the activation writes it (ops/bnb-activation.md, step 6): the four.
  assert.deepEqual(spends(execOf(readFileSync(join(repo, "ops", "bnb-activation.md"), "utf8"))), { ...AUTO_MINT.maxSpend });
  // The offer of the visitor's own mint says the cap in the chain's own token.
  assert.match(offerOf(destOf("bsc-testnet", ALL_DESTS), 0, "0xAbCd…1234", "x").text, / spends at most 0\.005 tBNB of gas a day on BSC testnet: /);
  assert.match(offerOf(ARB, 0, "0xAbCd…1234", "x").text, / spends at most 0\.002 ETH of gas a day on Arbitrum Sepolia: /);
});

/** Every .ts and .tsx file under `dir`. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sources(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
}

test("no page of the site states a time V3 changes set at, a fixed cadence of them, nor a relayer run fixed after one: the views take the relayer's words from handoff.ts", () => {
  const src = join(here, "..", "src");
  const files = sources(src);
  assert.ok(files.length > 40, `${files.length} files under src`);
  const fixed = [/\b\d\d:54\b/, /every 6 hours/i, /minutes after each (V3 )?set change/i, /after each (V3 )?set change/i, /RELAY_AFTER_CHANGE/, /SET_CHANGES_TEXT/, /V3_SET_CHANGES_UTC/, /V3_SET_CHANGE_TIMES/, /relayWait\(/, /utcClock/];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const re of fixed) assert.equal(re.test(text), false, `${f}: ${re}`);
  }
  // The card, the review, the transfer screen, Activity and the Network page take the cadence and the words from handoff.ts.
  const view = (name: string) => readFileSync(join(src, "app", "views", name), "utf8");
  assert.match(view("Bridge.tsx"), /relayNotice\(d, net\.behind/);
  assert.match(view("Bridge.tsx"), /relayNote\(d, behind\)/);
  assert.match(view("Bridge.tsx"), /autoMintAhead\(d, behind, T\[0\]\)/);
  assert.match(view("Bridge.tsx"), /\$\{clientOn\(d, true\)\} is \$\{setChangesText\(net\.behind\)\} behind V3/);
  assert.match(view("Bridge.tsx"), /RELAY_EVERY_MIN\[d\.key\]/);
  const tx = view("Tx.tsx");
  assert.match(tx, /lockReadOf\(net, x\.dest, x\.dir === "in" && x\.lock\.stage === "mined" \? x\.lock\.block : null\)/);
  assert.match(tx, /lockReadOf\(net, x\.dest, x\.block\)/);
  assert.equal(tx.match(/autoWaitStep\(d, handoff, read, /g)?.length, 2);
  assert.equal(tx.match(/autoMintAhead\(d, behind, auto\[0\]\)/g)?.length, 2);
  assert.match(tx, /autoFoot\(d, what, read, /);
  assert.match(tx, /offerOf\(d, behind, /);
  assert.equal(tx.match(/read\.caughtUpAt\)/g)?.length, 3);
  assert.match(view("Activity.tsx"), /caughtUpOf\(t\.dest\)/);
  assert.match(view("Activity.tsx"), /caughtUpOf\(l\.dest\)/);
  const network = view("Network.tsx");
  assert.match(network, /a run every \{RELAY_EVERY_MIN\[d\.key\]\} minutes/);
  assert.match(network, /relayAutoWait\(destOf\(net\.dest\), net\.behind\)/);
  assert.doesNotMatch(network, /nothing waits for the relayer/i);
  assert.doesNotMatch(network, /every 10 min/);
  assert.match(readFileSync(join(src, "app", "net.ts"), "utf8"), /netOf\(client, chain, dest, after\.caughtUpAt\)/);
});
