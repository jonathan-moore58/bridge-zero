// The bridge's status (src/app/netstate.ts): the V3 light client on a destination against V3 itself,
// from the two reads net.ts makes, by ../src/lib/field.ts's rule for a read that fails (a failed
// refresh keeps the last live answer: the status says it is the read before); and when the page read
// a client that was behind V3's set back at it, which holds the offer of the visitor's own mint
// (handoff.ts). Offline.

import assert from "node:assert/strict";
import { test } from "node:test";
import { NO_CATCH_UP, liveSets, netOf, nextCatchUp, type CatchUp, type ClientRead, type V3Read } from "../src/app/netstate.ts";
import type { Field } from "../src/lib/field.ts";

const AT = 1_761_960_000_000;
/** The client as a live read gives it: set `setId`, its latest header #266,907 (the last block of V3's set 74). */
const client = (setId: bigint, more: Partial<Field<ClientRead>> = {}, value: Partial<ClientRead> = {}): Field<ClientRead> => ({
  status: "live",
  value: { setId, latestNumber: 266_907, paused: false, halted: false, ...value },
  endpoint: "client",
  at: AT,
  ...more,
});
/** V3's finalized head as a live read gives it, its set `setId`, read a second after the client. */
const v3 = (setId: bigint | null, more: Partial<Field<V3Read>> = {}): Field<V3Read> => ({ status: "live", value: { setId }, endpoint: "v3", at: AT + 1000, ...more });

test("at V3's set: Bridge ready, nothing behind, and the client's latest header for the held path", () => {
  const n = netOf(client(75n), v3(75n), "base-sepolia");
  assert.equal(n.key, "ready");
  assert.equal(n.label, "Bridge ready");
  assert.equal(n.behind, 0);
  assert.equal(n.latest, 266_907);
  assert.equal(n.stale, false);
  assert.equal(n.caughtUpAt, null);
  assert.equal(n.dest, "base-sepolia");
  assert.equal(n.long, "The V3 light client on Base Sepolia is at V3's validator set.");
  // A client ahead of the V3 node's head (a node that lags) is not behind.
  assert.equal(netOf(client(76n), v3(75n), "sepolia").key, "ready");
});

test("behind V3's set: Relay needed, with the changes it lacks", () => {
  const one = netOf(client(74n), v3(75n), "sepolia");
  assert.equal(one.key, "relay");
  assert.equal(one.behind, 1);
  assert.equal(one.latest, 266_907);
  assert.equal(one.long, "The V3 light client is 1 validator-set change behind V3. A mint made now imports it first.");
  const two = netOf(client(73n), v3(75n), "arbitrum-sepolia");
  assert.equal(two.behind, 2);
  assert.equal(two.long, "The V3 light client on Arbitrum Sepolia is 2 validator-set changes behind V3. A mint made now imports them first.");
});

test("a refresh that failed keeps the read before it, and the status says so: stale", () => {
  // The client's refresh failed: the last live answer stays (field.ts), with the error.
  const c = netOf(client(75n, { error: "timeout" }), v3(75n), "base-sepolia");
  assert.equal(c.key, "ready");
  assert.equal(c.stale, true);
  assert.equal(c.long, "The V3 light client on Base Sepolia is at V3's validator set. The last refresh failed, so this is the read before it.");
  // V3's refresh failed: the same, and a client read behind stays behind.
  const h = netOf(client(74n), v3(75n, { error: "HTTP 502" }), "sepolia");
  assert.equal(h.key, "relay");
  assert.equal(h.behind, 1);
  assert.equal(h.stale, true);
  assert.match(h.long, /The last refresh failed, so this is the read before it\.$/);
  // Both answered on their last refresh: not stale.
  assert.equal(netOf(client(74n), v3(75n), "sepolia").stale, false);
});

test("a read that never answered: rpc, nothing behind, and the chain that did not answer", () => {
  const dest = netOf(client(75n, { status: "error", value: undefined, error: "all endpoints failed" }), v3(75n), "base-sepolia");
  assert.equal(dest.key, "rpc");
  assert.equal(dest.down, "base-sepolia");
  assert.equal(dest.behind, 0);
  assert.equal(dest.latest, null);
  assert.equal(dest.long, "Base Sepolia's RPC did not answer. Values shown are recorded.");
  const node = netOf(client(74n), v3(75n, { status: "recorded", from: "deployments/" }), "sepolia");
  assert.equal(node.key, "rpc");
  assert.equal(node.down, "v3");
  // V3's set is not known: the client is not said to be behind.
  assert.equal(node.behind, 0);
});

test("before the first answers: checking; a paused or halted client says so", () => {
  const loading = netOf(client(75n, { status: "loading", at: undefined }), v3(75n), "arbitrum-sepolia");
  assert.equal(loading.key, "checking");
  assert.equal(loading.long, "Reading the V3 light client on Arbitrum Sepolia, and V3 itself.");
  assert.equal(netOf(client(75n), v3(null, { status: "loading" }), "sepolia").key, "checking");
  const paused = netOf(client(74n, {}, { paused: true }), v3(75n), "sepolia");
  assert.equal(paused.key, "paused");
  assert.equal(paused.behind, 0);
  assert.equal(netOf(client(74n, {}, { halted: true }), v3(75n), "base-sepolia").long, "The V3 light client on Base Sepolia is halted: it met a validator-set change it cannot import.");
});

test("the status carries when the page read the client catch up, as net.ts remembers it", () => {
  assert.equal(netOf(client(75n), v3(75n), "base-sepolia", AT - 60_000).caughtUpAt, AT - 60_000);
  assert.equal(netOf(client(75n), v3(75n), "base-sepolia").caughtUpAt, null);
});

test("only a live read of both sets, each answered on its last refresh, counts toward a catch-up", () => {
  assert.deepEqual(liveSets(client(74n), v3(75n)), { behind: 1, at: AT + 1000 });
  assert.deepEqual(liveSets(client(75n), v3(75n)), { behind: 0, at: AT + 1000 });
  // A stale answer, a recorded one, a loading one, V3's set not given, a paused client: none counts.
  assert.equal(liveSets(client(75n, { error: "timeout" }), v3(75n)), null);
  assert.equal(liveSets(client(75n), v3(75n, { error: "HTTP 502" })), null);
  assert.equal(liveSets(client(75n, { status: "recorded" }), v3(75n)), null);
  assert.equal(liveSets(client(75n, { status: "loading" }), v3(75n)), null);
  assert.equal(liveSets(client(75n), v3(null)), null);
  assert.equal(liveSets(client(75n, {}, { paused: true }), v3(75n)), null);
});

test("a client read behind and then at V3's set caught up when that read answered; any other sequence did not", () => {
  const T = AT + 20 * 60_000;
  let s: CatchUp = NO_CATCH_UP;
  // Read at V3's set first: nothing caught up.
  s = nextCatchUp(s, { behind: 0, at: AT });
  assert.deepEqual(s, { behind: 0, caughtUpAt: null });
  // V3 changes set: read behind.
  s = nextCatchUp(s, { behind: 1, at: AT + 60_000 });
  assert.deepEqual(s, { behind: 1, caughtUpAt: null });
  // The same read again, and a read that does not count: the same object back.
  assert.equal(nextCatchUp(s, { behind: 1, at: AT + 90_000 }), s);
  assert.equal(nextCatchUp(s, null), s);
  // The relayer has imported it: caught up when that read answered.
  s = nextCatchUp(s, { behind: 0, at: T });
  assert.deepEqual(s, { behind: 0, caughtUpAt: T });
  assert.equal(nextCatchUp(s, { behind: 0, at: T + 30_000 }), s);
  // From 2 behind to 1 is no catch-up; from 1 to 0 is, and it replaces the one before.
  s = nextCatchUp(s, { behind: 2, at: T + 60_000 });
  s = nextCatchUp(s, { behind: 1, at: T + 90_000 });
  assert.deepEqual(s, { behind: 1, caughtUpAt: T });
  s = nextCatchUp(s, { behind: 0, at: T + 120_000 });
  assert.deepEqual(s, { behind: 0, caughtUpAt: T + 120_000 });
  // A page opened after the catch-up never read the client behind: it knows of none.
  assert.deepEqual(nextCatchUp(NO_CATCH_UP, { behind: 0, at: T }), { behind: 0, caughtUpAt: null });
});
