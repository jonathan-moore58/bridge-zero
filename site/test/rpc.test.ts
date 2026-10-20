// The RPC client's batching: calls to one endpoint at about the same time go out as one JSON-RPC
// batch, up to its batch size; an endpoint that does not answer batches as batches gets its calls
// one by one. fetch is replaced by a fake node here: nothing leaves the machine.

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { NodeError, request, resetBatching, type Endpoint } from "../src/lib/rpc.ts";

type Body = { jsonrpc: string; id: number; method: string; params: unknown[] };
type Reply = (payload: Body | Body[]) => { status?: number; body: unknown };

const realFetch = globalThis.fetch;
let posts: (Body | Body[])[] = [];

function fakeNode(reply: Reply) {
  posts = [];
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const payload = JSON.parse(init.body) as Body | Body[];
    posts.push(payload);
    const r = reply(payload);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

/** Answers each call with "<method>:<first param>", in reverse order (a batch's answers may come in any order). */
const echo: Reply = (p) =>
  Array.isArray(p) ? { body: p.map((c) => ({ jsonrpc: "2.0", id: c.id, result: `${c.method}:${String(c.params[0])}` })).reverse() } : { body: { jsonrpc: "2.0", id: p.id, result: `${p.method}:${String(p.params[0])}` } };

const ep = (batch?: number): Endpoint => ({ id: "fake", label: "fake node", url: `https://fake.example/${batch ?? "none"}`, batch });

afterEach(() => {
  globalThis.fetch = realFetch;
  resetBatching();
});

test("calls made together go out as one batch, and each caller gets its own answer", async () => {
  fakeNode(echo);
  const e = ep(8);
  const answers = await Promise.all(["a", "b", "c"].map((x) => request<string>([e], "eth_call", [x])));
  assert.deepEqual(
    answers.map((a) => a.result),
    ["eth_call:a", "eth_call:b", "eth_call:c"],
  );
  assert.equal(posts.length, 1);
  assert.ok(Array.isArray(posts[0]) && posts[0].length === 3);
});

test("a batch is never larger than the endpoint takes", async () => {
  fakeNode(echo);
  const e = ep(3);
  await Promise.all([1, 2, 3, 4, 5].map((x) => request<string>([e], "eth_blockNumber", [x])));
  assert.deepEqual(
    posts.map((p) => (Array.isArray(p) ? p.length : 1)),
    [3, 2],
  );
});

test("an endpoint without a batch size gets every call on its own", async () => {
  fakeNode(echo);
  const e = ep();
  await Promise.all([1, 2].map((x) => request<string>([e], "chain_getHeader", [x])));
  assert.equal(posts.length, 2);
  assert.ok(posts.every((p) => !Array.isArray(p)));
});

test("one error for a whole batch: the calls are sent one by one, from then on", async () => {
  fakeNode((p) => (Array.isArray(p) ? { body: { jsonrpc: "2.0", id: null, error: { code: -32005, message: "Batched requests are not supported by this server" } } } : echo(p)));
  const e = ep(8);
  const first = await Promise.all([1, 2].map((x) => request<string>([e], "state_getStorage", [x])));
  assert.deepEqual(
    first.map((a) => a.result),
    ["state_getStorage:1", "state_getStorage:2"],
  );
  const before = posts.length;
  await Promise.all([3, 4].map((x) => request<string>([e], "state_getStorage", [x])));
  assert.equal(posts.length - before, 2);
  assert.ok(posts.slice(before).every((p) => !Array.isArray(p)), "no second batch");
});

test("a batch refused per call (a plan's limit) is sent one by one", async () => {
  fakeNode((p) =>
    Array.isArray(p)
      ? { status: 500, body: p.map((c) => ({ jsonrpc: "2.0", id: c.id, error: { code: -32000, message: "Batch of more than 3 requests are not allowed on free plan" } })) }
      : echo(p),
  );
  const e = ep(8);
  const answers = await Promise.all([1, 2, 3, 4].map((x) => request<string>([e], "eth_call", [x])));
  assert.deepEqual(
    answers.map((a) => a.result),
    ["eth_call:1", "eth_call:2", "eth_call:3", "eth_call:4"],
  );
});

test("a revert inside a batch is the caller's answer: it is thrown, not retried elsewhere", async () => {
  fakeNode((p) =>
    Array.isArray(p)
      ? {
          body: p.map((c) =>
            c.params[0] === "bad" ? { jsonrpc: "2.0", id: c.id, error: { code: 3, message: "execution reverted", data: "0x09bde339" } } : { jsonrpc: "2.0", id: c.id, result: "0x01" },
          ),
        }
      : echo(p),
  );
  const e = ep(8);
  const other = ep(8);
  other.url = "https://fake.example/other";
  const [ok, bad] = await Promise.allSettled([request<string>([e], "eth_call", ["good"]), request<string>([e, other], "eth_call", ["bad"])]);
  assert.equal(ok.status === "fulfilled" && ok.value.result, "0x01");
  assert.ok(bad.status === "rejected" && bad.reason instanceof NodeError && bad.reason.isRevert && bad.reason.data === "0x09bde339");
  assert.ok(posts.every((p) => Array.isArray(p)), "the other endpoint was not asked");
});

test("a call the batch answer leaves out is sent again on its own", async () => {
  fakeNode((p) => (Array.isArray(p) ? { body: p.slice(1).map((c) => ({ jsonrpc: "2.0", id: c.id, result: "x" })) } : { body: { jsonrpc: "2.0", id: p.id, result: "alone" } }));
  const e = ep(8);
  const answers = await Promise.all([1, 2, 3].map((x) => request<string>([e], "eth_call", [x])));
  assert.deepEqual(
    answers.map((a) => a.result),
    ["alone", "x", "x"],
  );
});
