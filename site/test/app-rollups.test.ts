// The Network page's reads of the V3 light client on the rollups (src/lib/lc-read.ts), through a fake
// node: the client's set, latest header, threshold, pause flags and the keys of its set, from the
// first RPC that answers; the rule every card follows when none does (src/lib/field.ts): the last
// live answer stays, else the records' latest import shows as Recorded, else the card says it could
// not read; how far the client is behind V3; and when its latest block was imported, from its
// HeaderImported log, searched back from the rollup's head in windows each node serves; and the
// rollups' BridgeMinter logs the sends and Activity search the same way (src/lib/logs.ts). fetch is
// replaced: nothing leaves the machine. The records' values are read from the records, which grow
// with every relayer run.

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { encodeAbiParameters, parseAbiParameters, type Hex as ViemHex } from "viem";
import { buildRecords } from "../build/records.ts";
import { ROLLUPS, destOf } from "../src/app/dests.ts";
import { ARBITRUM_SEPOLIA, BASE_SEPOLIA } from "../src/lib/endpoints.ts";
import { nextField, type Field } from "../src/lib/field.ts";
import { selector } from "../src/lib/hashes.ts";
import type { Hex } from "../src/lib/hex.ts";
import { HEADER_IMPORTED, MAX_LOG_CALLS, MIN_LOG_RANGE, lagMinutes, readClient, recordedClient, searchImport, setsBehind, thresholdOf, type ClientState } from "../src/lib/lc-read.ts";
import { MAX_LOG_WINDOWS, searchLogs } from "../src/lib/logs.ts";
import { AllFailed, resetBatching, type Endpoint } from "../src/lib/rpc.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = process.env.RECORDS_ROOT ?? join(here, "..", "..");
const records = buildRecords(repo);

const LC: Hex = "0x389781d4856f0a9f3266ca6e76be6c7b7cfe0ab6";
/** The state the fake node gives the client: set 60, V3 #216,777 (Base Sepolia's client as it answered on Oct 28). */
const HELD = { setId: 60n, number: 216_777, hash: "0x44bab2c49435ba358685075cbccf37bbb0d84ae23e71d4f9baf1adeca98ec943" as Hex };
const ADMIN: Hex = "0xd9838a86cf83c28ee486544060d1ca4ca2971071";
const KEYS: Hex[] = [`0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`];

type Call = { jsonrpc: string; id: number; method: string; params: unknown[] };
type Answer = { result?: unknown; error?: { code: number; message: string } };

const realFetch = globalThis.fetch;
let posts: { url: string; body: Call | Call[] }[] = [];

/** A node per URL: `down` URLs answer HTTP 503; the others answer each call with `answer`. */
function fakeNodes(answer: (url: string, c: Call) => Answer, down: string[] = []) {
  posts = [];
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Call | Call[];
    posts.push({ url, body });
    if (down.includes(url)) return new Response("unavailable", { status: 503 });
    const one = (c: Call) => ({ jsonrpc: "2.0", id: c.id, ...answer(url, c) });
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  resetBatching();
});

const enc = (types: string, values: unknown[]): Hex => encodeAbiParameters(parseAbiParameters(types), values as never) as Hex;

/** The client's six reads and authorities(setId), as GrandpaLightClient.sol answers them. */
function clientAnswers(state = HELD, opts: { paused?: boolean; keys?: Hex[] } = {}) {
  return (_url: string, c: Call): Answer => {
    if (c.method !== "eth_call") return { error: { code: -32601, message: `no ${c.method} here` } };
    const [tx] = c.params as [{ to: string; data: string }];
    assert.equal(tx.to, LC);
    const sel = tx.data.slice(0, 10);
    if (sel === selector("currentSetId()")) return { result: enc("uint64", [state.setId]) };
    if (sel === selector("latestFinalized()")) return { result: enc("bytes32, uint32", [state.hash as ViemHex, state.number]) };
    if (sel === selector("threshold()")) return { result: enc("uint256", [2n]) };
    if (sel === selector("paused()")) return { result: enc("bool", [opts.paused ?? false]) };
    if (sel === selector("halted()")) return { result: enc("bool", [false]) };
    if (sel === selector("admin()")) return { result: enc("address", [ADMIN]) };
    if (sel === selector("authorities(uint64)")) return { result: enc("bytes32[]", [opts.keys ?? KEYS]) };
    return { error: { code: 3, message: "execution reverted" } };
  };
}

const loading: Field<ClientState> = { status: "loading", value: undefined };

test("the rollups' RPCs are the ones the destinations give the Network page", () => {
  assert.deepEqual(destOf("base-sepolia").rpcs, BASE_SEPOLIA);
  assert.deepEqual(destOf("arbitrum-sepolia").rpcs, ARBITRUM_SEPOLIA);
  for (const d of ROLLUPS) assert.equal(d.lightClient, LC);
});

test("a rollup's client is read in one batch from its first RPC, then its set's keys", async () => {
  fakeNodes(clientAnswers());
  const r = await readClient(BASE_SEPOLIA, LC);
  assert.equal(r.endpoint, "base-sepolia-rpc.publicnode.com");
  assert.deepEqual(r.value, { setId: 60n, latestHash: HELD.hash, latestNumber: 216_777, threshold: 2, paused: false, halted: false, admin: ADMIN, keys: 2 });
  // Six reads together, then authorities(60): two requests, both to the first RPC.
  assert.deepEqual(
    posts.map((p) => [p.url, Array.isArray(p.body) ? p.body.length : 1]),
    [
      ["https://base-sepolia-rpc.publicnode.com", 6],
      ["https://base-sepolia-rpc.publicnode.com", 1],
    ],
  );
});

test("when the first RPC is down, the second answers, and the card names it", async () => {
  fakeNodes(clientAnswers({ setId: 60n, number: 216_800, hash: `0x${"e4".repeat(32)}` }), ["https://sepolia-rollup.arbitrum.io/rpc"]);
  const r = await readClient(ARBITRUM_SEPOLIA, LC);
  assert.equal(r.endpoint, "arbitrum-sepolia-rpc.publicnode.com");
  assert.equal(r.value.latestNumber, 216_800);
  assert.ok(posts.some((p) => p.url === "https://sepolia-rollup.arbitrum.io/rpc"));
});

test("a failed authorities() read leaves the rest of the read standing, its keys unknown", async () => {
  const base = clientAnswers();
  fakeNodes((url, c) => {
    const [tx] = c.params as [{ data: string }];
    return tx.data.startsWith(selector("authorities(uint64)")) ? { error: { code: 3, message: "execution reverted" } } : base(url, c);
  });
  const r = await readClient(BASE_SEPOLIA, LC);
  assert.equal(r.value.keys, null);
  assert.equal(r.value.setId, 60n);
});

test("the records' latest import into each rollup's client: the fallback when no node answers", () => {
  const base = records.rollups["base-sepolia"];
  const arb = records.rollups["arbitrum-sepolia"];
  assert.ok(base && arb);
  assert.equal(base.chainId, 84532);
  assert.equal(arb.chainId, 421614);
  for (const r of [base, arb]) {
    assert.equal(r.lightClient, LC);
    assert.equal(r.provenBalance, "0x40f4b03aa20d3e7ce2503c406a4fe4a46ba886f0");
    assert.equal(r.lightClient, destOf(r.network).lightClient);
    assert.equal(r.provenBalance, destOf(r.network).provenBalance);
    // The relayer's two imports of Oct 27 (README rows 79 to 82): the set change 59 → 60, then a head.
    assert.deepEqual(
      r.imports.slice(0, 2).map((i) => [i.number, i.setBefore, i.setAfter]),
      [
        [214_864, 59, 60],
        [r.network === "base-sepolia" ? 216_777 : 216_800, 60, 60],
      ],
    );
  }
  assert.equal(base.deployBlock, 50_885_228);
  assert.equal(arb.deployBlock, 323_329_995);
  // The fallback is the newest import the records hold, whichever run that was.
  for (const r of [base, arb]) {
    const last = r.imports.at(-1)!;
    const rec = recordedClient(r, 2);
    assert.ok(rec);
    assert.deepEqual(rec.value, { setId: BigInt(last.setAfter), latestHash: last.hash, latestNumber: last.number, threshold: 2, paused: null, halted: null, admin: null, keys: 2 });
    assert.equal(rec.from, last.from);
    assert.match(rec.from, new RegExp(`^deployments/relay-${r.network}-0x[0-9a-f]{40}\\.jsonl$`));
    assert.ok(r.imports.every((i, k) => k === 0 || i.number >= r.imports[k - 1]!.number), "oldest first");
  }
  assert.equal(recordedClient(null, 2), null);
  assert.equal(thresholdOf(2), 2);
  assert.equal(thresholdOf(10), 7);
});

test("no node answers: the card shows the records' value as Recorded, says why, and says it could not read when nothing is recorded", async () => {
  fakeNodes(clientAnswers(), [...BASE_SEPOLIA.map((e) => e.url)]);
  const rec = recordedClient(records.rollups["base-sepolia"], 2);
  const f = await nextField(loading, () => readClient(BASE_SEPOLIA, LC), rec);
  assert.equal(f.status, "recorded");
  assert.equal(f.value?.latestNumber, records.rollups["base-sepolia"]!.latestImport!.number);
  assert.equal(f.from, rec?.from);
  assert.match(f.error ?? "", /base-sepolia-rpc\.publicnode\.com: HTTP 503; sepolia\.base\.org: HTTP 503/);
  const none = await nextField(loading, () => readClient(BASE_SEPOLIA, LC), null);
  assert.deepEqual([none.status, none.value], ["error", undefined]);
  await assert.rejects(readClient(BASE_SEPOLIA, LC), AllFailed);
});

test("a live answer stays when a later refresh fails, with the failure noted", async () => {
  fakeNodes(clientAnswers());
  const at = 1_761_700_000_000;
  const live = await nextField(loading, () => readClient(BASE_SEPOLIA, LC), null, () => at);
  assert.deepEqual([live.status, live.endpoint, live.at], ["live", "base-sepolia-rpc.publicnode.com", at]);
  resetBatching();
  fakeNodes(clientAnswers(), [...BASE_SEPOLIA.map((e) => e.url)]);
  const after = await nextField(live, () => readClient(BASE_SEPOLIA, LC), recordedClient(records.rollups["base-sepolia"], 2));
  assert.equal(after.status, "live");
  assert.equal(after.at, at);
  assert.equal(after.value?.keys, 2);
  assert.match(after.error ?? "", /HTTP 503/);
});

test("how far behind V3: minutes from the block numbers at V3's 6 s, and the set changes not imported", () => {
  // Oct 28: V3 finalized #222,345 in set 62; the rollup clients held #216,777 and #216,800 in set 60.
  assert.equal(lagMinutes(216_777, 222_345, 6), 557);
  assert.equal(lagMinutes(216_800, 222_345, 6), 555);
  assert.equal(lagMinutes(222_345, 222_345, 6), 0);
  // A client ahead of the head read (a newer import than the head answer) is not behind.
  assert.equal(lagMinutes(222_400, 222_345, 6), 0);
  assert.equal(setsBehind(60n, 62n), 2);
  assert.equal(setsBehind(62n, 62n), 0);
  assert.equal(setsBehind(62n, null), 0);
});

// ---------------------------------------------------------------------------------------------
// When the client's latest block was imported: its HeaderImported log, searched back from the head

const IMPORTED: Hex = `0x${"ab".repeat(32)}`;
const SIGNED_BY_62 = enc("bytes32, uint64, uint256", [`0x${"cd".repeat(32)}`, 62n, 2n]);
const hex = (n: number) => `0x${n.toString(16)}`;

interface LogFilter {
  address: string;
  topics: string[];
  fromBlock: string;
  toBlock: string;
}

/**
 * Rollup nodes that cap a log search as the real ones do (Oct 28): `cap` blocks per call by URL (a
 * JSON-RPC error past it, as publicnode answers; no cap for a URL not named, as Arbitrum's own node),
 * with the client's one HeaderImported log for IMPORTED at block `at`, and block times of
 * 1,700,000,000 + the block. `down` URLs answer HTTP 503.
 */
function rangeNodes(cap: Record<string, number>, at: number | null, stamp: "time" | "zero" | "none" = "time", down: string[] = []) {
  const searched: { url: string; from: number; to: number }[] = [];
  fakeNodes((url, c) => {
    if (c.method === "eth_getLogs") {
      const f = (c.params as [LogFilter])[0];
      assert.deepEqual([f.address, f.topics], [LC, [HEADER_IMPORTED, IMPORTED]]);
      const from = Number(BigInt(f.fromBlock));
      const to = Number(BigInt(f.toBlock));
      searched.push({ url, from, to });
      const max = cap[url] ?? Number.POSITIVE_INFINITY;
      if (to - from + 1 > max) return { error: { code: -32000, message: `exceed maximum block range: ${max}` } };
      const hit = at !== null && at >= from && at <= to;
      const log = { blockNumber: hex(at ?? 0), data: SIGNED_BY_62, transactionHash: `0x${"0e".repeat(32)}`, ...(stamp === "none" ? {} : { blockTimestamp: stamp === "zero" ? "0x0" : hex(1_700_000_000 + (at ?? 0)) }) };
      return { result: hit ? [log] : [] };
    }
    if (c.method === "eth_getBlockByNumber") return { result: { timestamp: hex(1_700_000_000 + Number(BigInt((c.params as [string])[0]))) } };
    return { error: { code: -32601, message: `no ${c.method} here` } };
  }, down);
  return searched;
}

const PUBLICNODE_BASE = "https://base-sepolia-rpc.publicnode.com";
const BASE_OFFICIAL = "https://sepolia.base.org";
const ARB_OFFICIAL = "https://sepolia-rollup.arbitrum.io/rpc";
const PUBLICNODE_ARB = "https://arbitrum-sepolia-rpc.publicnode.com";

test("each rollup RPC's log range is the one measured: the public nodes 50,000 blocks, sepolia.base.org too few to search with", () => {
  assert.deepEqual(
    [...BASE_SEPOLIA, ...ARBITRUM_SEPOLIA].map((e: Endpoint) => [e.url, e.logRange ?? null]),
    [
      [PUBLICNODE_BASE, 50_000],
      [BASE_OFFICIAL, 200],
      [ARB_OFFICIAL, null],
      [PUBLICNODE_ARB, 50_000],
    ],
  );
  assert.ok(200 < MIN_LOG_RANGE && MIN_LOG_RANGE <= 50_000);
});

test("Base Sepolia: an import 230,000 blocks back is found in 50,000-block windows from the head, newest first, never through sepolia.base.org", async () => {
  const head = 51_300_000;
  const searched = rangeNodes({ [PUBLICNODE_BASE]: 50_000, [BASE_OFFICIAL]: 200 }, head - 230_000);
  const r = await searchImport(BASE_SEPOLIA, LC, IMPORTED, 50_886_860, head);
  assert.deepEqual(r, { found: { block: head - 230_000, at: (1_700_000_000 + head - 230_000) * 1000, signedBy: 62n, tx: `0x${"0e".repeat(32)}` } });
  assert.deepEqual(
    searched.map((s) => [s.url, s.from, s.to]),
    [0, 1, 2, 3, 4].map((k) => [PUBLICNODE_BASE, head - 50_000 * (k + 1) + 1, head - 50_000 * k]),
  );
  assert.ok(!posts.some((p) => p.url === BASE_OFFICIAL), "sepolia.base.org takes 200 blocks a call: it is never asked");
});

test("Arbitrum Sepolia: its own node takes the whole range in one call; its zero blockTimestamp sends the page to the block's time", async () => {
  const head = 323_700_000;
  const searched = rangeNodes({ [PUBLICNODE_ARB]: 50_000 }, 323_462_680, "zero");
  const r = await searchImport(ARBITRUM_SEPOLIA, LC, IMPORTED, 323_331_302, head);
  assert.ok("found" in r);
  assert.deepEqual(r.found, { block: 323_462_680, at: (1_700_000_000 + 323_462_680) * 1000, signedBy: 62n, tx: `0x${"0e".repeat(32)}` });
  assert.deepEqual(searched, [{ url: ARB_OFFICIAL, from: 323_331_302, to: head }]);
  assert.equal(posts.filter((p) => !Array.isArray(p.body) && p.body.method === "eth_getBlockByNumber").length, 1);
  // A node that stamps the log saves the block read.
  resetBatching();
  rangeNodes({}, 323_462_680, "time");
  assert.ok("found" in (await searchImport(ARBITRUM_SEPOLIA, LC, IMPORTED, 323_331_302, head)));
  assert.ok(!posts.some((p) => !Array.isArray(p.body) && p.body.method === "eth_getBlockByNumber"));
});

test("a node that fails hands the search to the next, at the window it failed on", async () => {
  const head = 323_700_000;
  // Arbitrum's own node answers HTTP 503: the public node searches in its own 50,000-block windows.
  const searched = rangeNodes({ [PUBLICNODE_ARB]: 50_000 }, head - 120_000, "time", [ARB_OFFICIAL]);
  const r = await searchImport(ARBITRUM_SEPOLIA, LC, IMPORTED, head - 400_000, head);
  assert.ok("found" in r && r.found.block === head - 120_000);
  assert.deepEqual(
    searched.map((s) => [s.url, s.from, s.to]),
    [
      [PUBLICNODE_ARB, head - 49_999, head],
      [PUBLICNODE_ARB, head - 99_999, head - 50_000],
      [PUBLICNODE_ARB, head - 149_999, head - 100_000],
    ],
  );
  assert.ok(posts.some((p) => p.url === ARB_OFFICIAL));
  // When no node answers, the search says so: the card shows "Could not read" and asks again with the next read.
  resetBatching();
  rangeNodes({}, null, "time", [PUBLICNODE_BASE, BASE_OFFICIAL]);
  await assert.rejects(searchImport(BASE_SEPOLIA, LC, IMPORTED, 0, 1_000_000), AllFailed);
});

test("past the most calls a search makes, or back at its start, the import is older than the oldest block searched", async () => {
  const head = 51_300_000;
  rangeNodes({ [PUBLICNODE_BASE]: 50_000, [BASE_OFFICIAL]: 200 }, head - 700_000);
  const r = await searchImport(BASE_SEPOLIA, LC, IMPORTED, 50_000_000, head);
  const oldest = head - 50_000 * MAX_LOG_CALLS + 1;
  assert.deepEqual(r, { before: { block: oldest, at: (1_700_000_000 + oldest) * 1000 } });
  assert.equal(posts.filter((p) => !Array.isArray(p.body) && p.body.method === "eth_getLogs").length, MAX_LOG_CALLS);
  // A search that reaches its start without the log: older than the start.
  resetBatching();
  rangeNodes({ [PUBLICNODE_BASE]: 50_000 }, null);
  assert.deepEqual(await searchImport(BASE_SEPOLIA, LC, IMPORTED, head - 80_000, head), { before: { block: head - 80_000, at: (1_700_000_000 + head - 80_000) * 1000 } });
});

// ---------------------------------------------------------------------------------------------
// A rollup's BridgeMinter logs for the sends and Activity (src/lib/logs.ts): a burn or a mint by its
// nonce, the burns of an address, in the windows each node serves

const MINTER_ROLLUP: Hex = "0xdc31a3bc1354545eeb985aad7b2aa662e9272348";
const BURN_TOPIC: Hex = `0x${"b0".repeat(32)}`;

/** Nodes holding a log at each of `at`, capped per URL as `cap` says (no cap: any range), and `down` URLs answering HTTP 503. */
function minterNodes(cap: Record<string, number>, at: number[], down: string[] = []) {
  const searched: { url: string; from: number; to: number }[] = [];
  fakeNodes((url, c) => {
    if (c.method !== "eth_getLogs") return { error: { code: -32601, message: `no ${c.method} here` } };
    const f = (c.params as [{ address: string; topics: (string | null)[]; fromBlock: Hex; toBlock: Hex }])[0];
    assert.deepEqual([f.address, f.topics], [MINTER_ROLLUP, [BURN_TOPIC, null]]);
    const from = Number(BigInt(f.fromBlock));
    const to = Number(BigInt(f.toBlock));
    searched.push({ url, from, to });
    const max = cap[url] ?? Number.POSITIVE_INFINITY;
    if (to - from + 1 > max) return { error: { code: -32000, message: `exceed maximum block range: ${max}` } };
    const log = (n: number) => ({ address: MINTER_ROLLUP, topics: [BURN_TOPIC], data: "0x", blockNumber: hex(n), transactionHash: `0x${n.toString(16).padStart(64, "0")}` });
    return { result: at.filter((n) => n >= from && n <= to).map(log) };
  }, down);
  return searched;
}

const MINTER_FILTER = { address: MINTER_ROLLUP, topics: [BURN_TOPIC, null] };

test("a rollup's minter logs are searched back from its head in 50,000-block windows, never through sepolia.base.org, oldest first in the answer", async () => {
  // Base Sepolia's minter was deployed at 51,063,602 (README row 94); a burn at 51,177,673 (row 108) and another later.
  const head = 51_200_000;
  const searched = minterNodes({ [PUBLICNODE_BASE]: 50_000, [BASE_OFFICIAL]: 200 }, [51_177_673, 51_190_000]);
  const r = await searchLogs(BASE_SEPOLIA, MINTER_FILTER, 51_063_602, head);
  assert.deepEqual(
    r.logs.map((l) => Number(BigInt(l.blockNumber))),
    [51_177_673, 51_190_000],
  );
  assert.equal(r.oldest, 51_063_602);
  assert.deepEqual(
    searched.map((s) => [s.url, s.from, s.to]),
    [
      [PUBLICNODE_BASE, 51_150_001, 51_200_000],
      [PUBLICNODE_BASE, 51_100_001, 51_150_000],
      [PUBLICNODE_BASE, 51_063_602, 51_100_000],
    ],
  );
});

test("a lookup by nonce stops at the newest window that holds the log; past the most windows a search says where it stopped", async () => {
  const head = 51_300_000;
  const searched = minterNodes({ [PUBLICNODE_BASE]: 50_000 }, [51_177_673]);
  const r = await searchLogs(BASE_SEPOLIA, MINTER_FILTER, 51_063_602, head, { first: true });
  assert.deepEqual(r.logs.map((l) => l.transactionHash), [`0x${(51_177_673).toString(16).padStart(64, "0")}`]);
  assert.equal(searched.length, 3);
  assert.equal(r.oldest, head - 150_000 + 1);
  // Nothing within reach: the search stops after its most windows, and names the oldest block it searched.
  resetBatching();
  minterNodes({ [PUBLICNODE_BASE]: 50_000 }, []);
  const none = await searchLogs(BASE_SEPOLIA, MINTER_FILTER, 0, head, { maxCalls: MAX_LOG_WINDOWS });
  assert.deepEqual(none, { logs: [], oldest: head - 50_000 * MAX_LOG_WINDOWS + 1, newest: head });
});

test("a log that follows a known block (a lock's mint, a burn after the wallet was asked) is searched on from that block, oldest first: found in its first window however long ago", async () => {
  // Lock 4's mint at Base 51,159,736 (README row 106), looked for three weeks of Base Sepolia later: newest first, 24 windows reach 1.2 M blocks, short of it.
  const mint = 51_159_736;
  const head = mint + 3 * 7 * 24 * 60 * 60 * 5;
  minterNodes({ [PUBLICNODE_BASE]: 50_000 }, [mint]);
  const back = await searchLogs(BASE_SEPOLIA, MINTER_FILTER, mint - 3_000, head, { first: true });
  assert.deepEqual(back.logs, []);
  assert.equal(back.oldest, head - 50_000 * MAX_LOG_WINDOWS + 1);
  assert.ok(back.oldest > mint - 3_000, "the newest-first search stops short of the lock");
  // From the lock on, oldest first: one call.
  resetBatching();
  const searched = minterNodes({ [PUBLICNODE_BASE]: 50_000 }, [mint]);
  const on = await searchLogs(BASE_SEPOLIA, MINTER_FILTER, mint - 3_000, head, { first: true, order: "oldest" });
  assert.deepEqual(
    on.logs.map((l) => Number(BigInt(l.blockNumber))),
    [mint],
  );
  assert.deepEqual(
    searched.map((s) => [s.url, s.from, s.to]),
    [[PUBLICNODE_BASE, mint - 3_000, mint - 3_000 + 49_999]],
  );
  assert.deepEqual([on.oldest, on.newest], [mint - 3_000, mint - 3_000 + 49_999]);
  // Without `first`, every window from the start, oldest first, as far as the calls reach: the blocks searched say how far.
  resetBatching();
  minterNodes({ [PUBLICNODE_BASE]: 50_000 }, [mint, mint + 120_000]);
  const all = await searchLogs(BASE_SEPOLIA, MINTER_FILTER, mint - 3_000, head, { order: "oldest", maxCalls: 3 });
  assert.deepEqual(
    all.logs.map((l) => Number(BigInt(l.blockNumber))),
    [mint, mint + 120_000],
  );
  assert.deepEqual([all.oldest, all.newest], [mint - 3_000, mint - 3_000 + 150_000 - 1]);
  // A window that fails on the public node: sepolia.base.org takes too few blocks to search with, so nothing answers.
  resetBatching();
  minterNodes({ [PUBLICNODE_BASE]: 50_000 }, [mint], [PUBLICNODE_BASE]);
  await assert.rejects(searchLogs(BASE_SEPOLIA, MINTER_FILTER, mint - 3_000, head, { order: "oldest" }), AllFailed);
});

test("on Arbitrum Sepolia an oldest-first search is one call on its own node, and goes on in the public node's windows from where it failed", async () => {
  const head = 323_700_000;
  const one = minterNodes({ [PUBLICNODE_ARB]: 50_000 }, [323_534_868]);
  const r = await searchLogs(ARBITRUM_SEPOLIA, MINTER_FILTER, 323_530_000, head, { first: true, order: "oldest" });
  assert.equal(r.logs.length, 1);
  assert.deepEqual(one.map((s) => [s.url, s.from, s.to]), [[ARB_OFFICIAL, 323_530_000, head]]);
  resetBatching();
  const failed = minterNodes({ [PUBLICNODE_ARB]: 50_000 }, [323_534_868], [ARB_OFFICIAL]);
  const again = await searchLogs(ARBITRUM_SEPOLIA, MINTER_FILTER, 323_530_000, head, { first: true, order: "oldest" });
  assert.equal(again.logs.length, 1);
  assert.deepEqual(
    failed.filter((s) => s.url === PUBLICNODE_ARB).map((s) => [s.from, s.to]),
    [[323_530_000, 323_579_999]],
  );
});

test("on Arbitrum Sepolia its own node takes the whole range in one call; when it fails, the public node goes on in windows", async () => {
  const head = 323_600_000;
  const one = minterNodes({ [PUBLICNODE_ARB]: 50_000 }, [323_549_062]);
  const r = await searchLogs(ARBITRUM_SEPOLIA, MINTER_FILTER, 323_463_305, head);
  assert.equal(r.logs.length, 1);
  assert.deepEqual(
    one.map((s) => [s.url, s.from, s.to]),
    [[ARB_OFFICIAL, 323_463_305, head]],
  );
  resetBatching();
  const failed = minterNodes({ [PUBLICNODE_ARB]: 50_000 }, [323_549_062], [ARB_OFFICIAL]);
  const again = await searchLogs(ARBITRUM_SEPOLIA, MINTER_FILTER, 323_463_305, head, { first: true });
  assert.equal(again.logs.length, 1);
  assert.deepEqual(
    failed.filter((s) => s.url === PUBLICNODE_ARB).map((s) => [s.from, s.to]),
    [
      [head - 49_999, head],
      [323_500_001, 323_550_000],
    ],
  );
  // No node that searches: said so.
  resetBatching();
  minterNodes({}, [], [PUBLICNODE_BASE]);
  await assert.rejects(searchLogs(BASE_SEPOLIA, MINTER_FILTER, 0, head), AllFailed);
});
