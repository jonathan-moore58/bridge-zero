// Unit tests of relay.ts, offline: the fees it signs and simulates with, how it reads RPC errors,
// the state directory, and how it settles a transaction whose receipt or state an RPC no longer
// serves (against a stand-in for fetch, so no request leaves the machine).
//
//   npm test

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { keccak256, RPC, type Fees, type Receipt } from "../../contracts/script/lib/sepolia.mjs";
import { bytesToHex, utf8 } from "./bytes.js";
import {
  callAt,
  clampFees,
  feeCap,
  findMined,
  heldBackBeforePlan,
  importedNothing,
  legacyAdvice,
  makeStateDir,
  maxFeeAt,
  measureFees,
  notNewerIn,
  outcomeAtLatest,
  pruned,
  raised,
  senderOf,
  transient,
  upfrontOf,
  type ClientState,
  type LegacyFacts,
  type Options,
  type RelayEntry,
} from "./relay.js";

const GWEI = 10n ** 9n;
const fees = (base: bigint, tip = 1_000n, maxFee = 10n * base + tip): Fees => ({ base, tip, maxFee, gasPrice: base + tip });
const options = (more: Partial<Options> = {}): Options => ({
  chain: "v3",
  send: true,
  rpc: "wss://test-node-v3.portaldot.dev",
  stateDir: "state",
  scanLimit: 100_800,
  headEvery: 600,
  maxBaseFee: 50_000_000n,
  maxBaseFeeChange: 1_500_000_000n,
  keep: 5n * 10n ** 16n,
  replaceAfter: 300_000,
  ...more,
});

describe("replacement fees", () => {
  it("raise both fees by at least 1/8, and at least to the current ones", () => {
    assert.deepEqual(raised({ maxFee: 10_000_000n, tip: 1_000n }, fees(16n, 1_000n, 10_000_000n), GWEI), { ...fees(16n, 1_000n), tip: 1_125n, maxFee: 11_250_000n });
    const r = raised({ maxFee: 400_001_000n, tip: 1_266n }, fees(16n, 1_000n, 10_000_000n), 15n * GWEI);
    assert.equal(r?.maxFee, 450_001_125n);
    assert.equal(r?.tip, 1_425n);
  });

  it("are refused above the cap", () => {
    assert.equal(raised({ maxFee: 12n * GWEI, tip: 1_000n }, fees(16n), feeCap(options(), fees(16n), 50_000_000n)), null);
  });

  it("cap at ten times the gate plus the priority fee, or --max-fee", () => {
    assert.equal(feeCap(options(), fees(16n), 50_000_000n), 500_001_000n);
    assert.equal(feeCap(options({ maxFee: 3n * GWEI }), fees(16n), 50_000_000n), 3n * GWEI);
  });
});

describe("the dry run's first pass (F1)", () => {
  const CAP = 16_777_216n;

  it("measures at twice the base fee plus the priority fee", () => {
    const now = fees(1_500_000_000n);
    const low = measureFees(now);
    assert.equal(low.maxFee, 3_000_001_000n);
    assert.equal(low.tip, now.tip);
    assert.equal(low.base, now.base);
    // At the set changes' gate the cap needs about 0.05 ETH on hand, no longer 0.25 ETH.
    assert.equal(CAP * low.maxFee, 50_331_664_777_216_000n);
    assert.ok(CAP * now.maxFee > 250n * 10n ** 15n);
  });

  it("stays valid: never below the base fee or the priority fee", () => {
    for (const base of [0n, 1n, 16n, 50_000_000n, 1_500_000_000n, 10n ** 11n]) {
      // The run's own fees as dryRun checks them first: the max fee covers the base fee and the priority fee.
      for (const now of [fees(base), fees(base, 2n * GWEI), fees(base, 1_000n, 10_000_000n)].filter((f) => f.maxFee >= f.base && f.maxFee >= f.tip)) {
        const low = measureFees(now);
        assert.ok(low.maxFee >= low.base && low.maxFee >= low.tip, `base ${base}`);
        assert.ok(low.maxFee <= now.maxFee);
      }
    }
  });

  it("keeps a lower max fee the run was given", () => {
    const now = fees(1_500_000_000n, 1_000n, 2n * GWEI);
    assert.equal(measureFees(now), now);
  });
});

describe("a later step's fees (F2)", () => {
  const head = (now: Fees, o = options()) => feeCap(o, now, o.maxBaseFee);

  it("a head after a re-signed set change pays at most the head's cap", () => {
    // X5 (a): the run's fees were raised over a dropped 12 gwei set change.
    const carried = { ...fees(16n), maxFee: 13_500_001_125n, tip: 1_125n };
    const signed = clampFees(carried, head(fees(16n)));
    assert.equal(signed.maxFee, 500_001_000n);
    assert.equal(signed.tip, 1_125n);
    // X5 (b): step 0 re-signed at 10,000,001,000 at a 1 gwei base fee, the head then at 16 wei.
    assert.equal(clampFees({ ...fees(16n), maxFee: 10_000_001_000n }, head(fees(16n))).maxFee, 500_001_000n);
  });

  it("never raises fees, and lowers a priority fee above the cap with the max fee", () => {
    const low = fees(16n, 1_000n, 10_000_000n);
    assert.equal(clampFees(low, head(fees(16n))), low);
    const tipped = clampFees({ ...fees(16n), maxFee: 3n * GWEI, tip: 2n * GWEI }, 1n * GWEI);
    assert.equal(tipped.maxFee, GWEI);
    assert.equal(tipped.tip, GWEI);
  });

  it("follows --max-fee when it is given", () => {
    const o = options({ maxFee: 2n * GWEI });
    assert.equal(clampFees({ ...fees(16n), maxFee: 5n * GWEI }, head(fees(16n), o)).maxFee, 2n * GWEI);
  });
});

describe("RPC errors asked again (F9)", () => {
  const rpcError = (body: object) => new Error(`eth_simulateV1: ${JSON.stringify(body)}`);

  it("are the ones a load-balanced RPC gives for a while", () => {
    assert.ok(transient(new TypeError("fetch failed")));
    assert.ok(transient(rpcError({ code: -32000, message: "header not found" })));
    assert.ok(transient(rpcError({ code: -32603, message: "internal error" })));
    assert.ok(transient(rpcError({ code: 429, message: "Too Many Requests" })));
    assert.ok(transient(rpcError({ code: -32000, message: "state is not available" })));
  });

  it("are not a node without the method", () => {
    assert.ok(!transient(rpcError({ code: -32601, message: "the method eth_simulateV1 does not exist/is not available" })));
    assert.ok(!transient(rpcError({ code: -32601, message: "Method not found" })));
    assert.ok(!transient(rpcError({ code: -32000, message: "eth_simulateV1 is not supported" })));
  });

  it("are not errors of the request itself", () => {
    assert.ok(!transient(rpcError({ code: -38014, message: "insufficient funds for gas * price + value" })));
    assert.ok(!transient(rpcError({ code: 3, message: "execution reverted", data: "0x" })));
  });
});

describe("the check before a send run scans (F5)", () => {
  const GENESIS = `0x${"d4".repeat(32)}` as const;
  const client: ClientState = {
    genesis: GENESIS,
    setId: 46n,
    keys: [],
    latestHash: `0x${"14".repeat(32)}`,
    latestNumber: 165_089,
    halted: false,
    paused: false,
    maxAuthorities: 100,
    sets: 47,
  };
  const node = (number: number, setId: bigint, genesis: string = GENESIS) => ({
    setIdAtHead: async () => ({ number, setId }),
    blockHash: async () => genesis as `0x${string}`,
  });
  const high = fees(2n * GWEI);

  it("holds the run back while the base fee is above every gate that could matter", async () => {
    assert.equal(await heldBackBeforePlan(node(165_744, 46n), client, fees(GWEI), options()), true);
    assert.equal(await heldBackBeforePlan(node(165_744, 47n), client, high, options()), true);
  });

  it("lets a due set change through below its gate", async () => {
    assert.equal(await heldBackBeforePlan(node(165_744, 47n), client, fees(GWEI), options()), false);
  });

  it("does not count the word of a node behind the client, or of another chain: the run plans, and makePlan stops", async () => {
    assert.equal(await heldBackBeforePlan(node(165_000, 46n), client, high, options()), false);
    assert.equal(await heldBackBeforePlan(node(165_744, 45n), client, high, options()), false);
    assert.equal(await heldBackBeforePlan(node(165_744, 46n, `0x${"aa".repeat(32)}`), client, high, options()), false);
  });

  it("plans when the node does not say", async () => {
    const silent = { setIdAtHead: async () => null, blockHash: async () => GENESIS as `0x${string}` };
    assert.equal(await heldBackBeforePlan(silent, client, high, options()), false);
  });
});

describe("a dry run above the gates (F6)", () => {
  it("prices the plan at the max fee a --send run uses at the gate", () => {
    assert.equal(maxFeeAt(options(), 1_500_000_000n, 1_000n), 15_000_001_000n);
    assert.equal(maxFeeAt(options(), 50_000_000n, 1_000n), 500_001_000n);
    // feesAt's floor of 0.01 gwei, and --max-fee.
    assert.equal(maxFeeAt(options(), 16n, 1_000n), 10_000_000n);
    assert.equal(maxFeeAt(options({ maxFee: 3n * GWEI }), 1_500_000_000n, 1_000n), 3n * GWEI);
  });

  it("asks before each transaction its gas limit at the max fee, after what the earlier ones paid", () => {
    const steps = [
      { limit: 6_700_000, gas: 6_100_000 },
      { limit: 6_356_454, gas: 5_778_594 },
    ];
    const fee = 15_000_001_000n;
    assert.equal(upfrontOf(steps, fee), (6_100_000n + 6_356_454n) * fee);
    assert.equal(upfrontOf(steps.slice(0, 1), fee), 6_700_000n * fee);
    assert.equal(upfrontOf([], fee), 0n);
    // A mainnet set change at the gate: about 0.1 ETH, as the funding note says.
    assert.ok(upfrontOf(steps.slice(0, 1), fee) < 101n * 10n ** 15n);
  });
});

describe("the state directory and an earlier version's files (F7, F8, ops nits 2-5)", () => {
  const ADDRESS = "0xd9838a86cf83c28ee486544060d1ca4ca2971071" as const;
  const state = join("C:", "state");
  const deployments = join("C:", "checkout", "deployments");
  const s = senderOf(ADDRESS, ADDRESS, state);
  const facts = (more: Partial<LegacyFacts> = {}): LegacyFacts => ({
    record: join(deployments, `relay-sepolia-${ADDRESS}.json`),
    history: join(deployments, `relay-sepolia-${ADDRESS}.jsonl`),
    recordExists: false,
    open: null,
    historyExists: false,
    newRecordExists: false,
    newHistoryExists: false,
    stateDirExists: true,
    sameDir: false,
    ...more,
  });

  it("keeps the sender's record, history and lock side by side", () => {
    assert.equal(s.record, join(state, `relay-sepolia-${ADDRESS}.json`));
    assert.equal(s.history, join(state, `relay-sepolia-${ADDRESS}.jsonl`));
    assert.equal(s.lock, join(state, `relay-sepolia-${ADDRESS}.lock`));
  });

  it("says nothing when there is nothing earlier", () => {
    assert.deepEqual(legacyAdvice(s, facts()), { refuse: false, lines: [] });
    assert.deepEqual(legacyAdvice(s, facts({ recordExists: true, open: 0 })), { refuse: false, lines: [] });
  });

  it("refuses a --send run while the earlier record holds open transactions, and says what to move", () => {
    const a = legacyAdvice(s, facts({ recordExists: true, open: 2, historyExists: true }));
    assert.equal(a.refuse, true);
    assert.match(a.lines[0], /holds 2 open transactions/);
    assert.equal(a.lines[1], `move ${facts().record} to ${s.record}`);
    assert.equal(a.lines[2], `and move ${facts().history} to ${s.history}`);
    const b = legacyAdvice(s, facts({ recordExists: true, open: null, newRecordExists: true, newHistoryExists: true, historyExists: true }));
    assert.match(b.lines[0], /cannot be read; it may hold open transactions/);
    assert.match(b.lines[1], /add the entries of "open"/);
    assert.match(b.lines[2], /add the lines of .* to the end of/);
  });

  it("does not refuse its own record when --state-dir is deployments/ (F8)", () => {
    assert.deepEqual(legacyAdvice(s, facts({ sameDir: true, recordExists: true, open: 3, historyExists: true })), { refuse: false, lines: [] });
  });

  it("points at an earlier history left without a record (nit 2)", () => {
    const a = legacyAdvice(s, facts({ historyExists: true }));
    assert.equal(a.refuse, false);
    assert.equal(a.lines.length, 1);
    assert.ok(a.lines[0].startsWith(`${facts().history} is the history of an earlier version of this relayer, and is not written any more: the sender's settled transactions go to ${s.history}, which a --send run starts`));
    // It is never to be deleted: a checkout may publish it.
    assert.doesNotMatch(a.lines[0], /delete|move/);
    const b = legacyAdvice(s, facts({ historyExists: true, newHistoryExists: true, recordExists: true, open: 0 }));
    assert.match(b.lines[0], /go to .*\.jsonl; add the earlier lines at its start to keep one history$/);
  });

  it("says to create the state directory first when it does not exist (nit 3)", () => {
    const a = legacyAdvice(s, facts({ recordExists: true, open: 1, stateDirExists: false }));
    assert.match(a.lines[1], /\(create the directory .* first\)$/);
    assert.match(a.lines[0], /holds 1 open transaction of/);
    const b = legacyAdvice(s, facts({ recordExists: true, open: 2, historyExists: true, stateDirExists: false }));
    assert.match(b.lines[1], /^move .* \(create the directory .* first\)$/);
    assert.equal(b.lines[2], `and move ${facts().history} to ${s.history}`);
  });

  it("blocks a run whose state directory cannot be created (nit 4)", () => {
    // A directory under a file cannot be made; nothing is created.
    const under = join(fileURLToPath(import.meta.url), "state");
    assert.throws(() => makeStateDir(under), (error: Error) => error.name === "Blocked" && /cannot be created/.test(error.message));
    assert.equal(existsSync(under), false);
  });
});

describe("transactions whose receipt or state the Sepolia RPC pruned (F3, F4)", () => {
  // A stand-in for fetch: the Sepolia RPC (RPC) prunes receipts and old state as publicnode does;
  // sepolia.drpc.org keeps all; sepolia.gateway.tenderly.co serves another chain, so it is never asked.
  const CLIENT = "0x389781d4856f0a9f3266ca6e76be6c7b7cfe0ab6" as const;
  const HEADER = `0x${"0e".repeat(32)}` as const;
  const TX = `0x${"f9".repeat(32)}` as const;
  const OTHER = `0x${"b9".repeat(32)}` as const;
  const BLOCK_HASH = `0x${"44".repeat(32)}`;
  const OLD = "0xb63c86";
  const sel = (signature: string) => bytesToHex(keccak256(utf8(signature)).slice(0, 4));
  const LATEST = sel("latestFinalized()");
  const IMPORTED = sel("isImported(bytes32)");
  const NOT_NEWER = sel("NotNewer(uint32,uint32)");
  const word = (n: bigint | number) => BigInt(n).toString(16).padStart(64, "0");
  const PRUNED = { code: 4444, message: "pruned history unavailable: requested 11943046, earliest available 11969386" };

  interface World {
    /** The client at the latest block. */
    latest: { number: number; imported: boolean };
    /** What a replay of the transaction gives on its block, where it is served. */
    replay: { result?: string; error?: object };
    /** The client on the state of the old block, where it is served. */
    old?: { number: number; imported: boolean };
    /** Which hosts serve the old state, receipts and transactions. */
    archiveState: boolean;
    archiveReceipt: boolean;
    receiptBlockHash: string;
    txMined: boolean;
    txOnPrimary: boolean;
    /** The Sepolia RPC puts revert-like data on its pruned-state error. */
    prunedData?: boolean;
    asked: string[];
  }
  let world: World;
  const reset = (more: Partial<World> = {}) => {
    world = {
      latest: { number: 2_727_000, imported: true },
      replay: { result: `0x${word(0)}` },
      archiveState: true,
      archiveReceipt: true,
      receiptBlockHash: BLOCK_HASH,
      txMined: true,
      txOnPrimary: true,
      asked: [],
      ...more,
    };
  };
  const client = (at: { number: number; imported: boolean }, data: string) =>
    data.startsWith(LATEST) ? { result: `0x${HEADER.slice(2)}${word(at.number)}` } : data.startsWith(IMPORTED) ? { result: `0x${word(at.imported ? 1 : 0)}` } : { error: { code: 3, message: "execution reverted", data: "0x" } };
  const answer = (url: string, method: string, params: unknown[]): object => {
    const host = new URL(url).host;
    world.asked.push(`${host} ${method}`);
    const primary = url === RPC;
    if (host === "sepolia.gateway.tenderly.co") return method === "eth_chainId" ? { result: "0x1" } : { result: null };
    if (method === "eth_chainId") return { result: "0xaa36a7" };
    const tx = { from: "0xd9838a86cf83c28ee486544060d1ca4ca2971071", to: CLIENT, input: "0x1234", gas: "0x6a2a65", blockHash: world.txMined ? BLOCK_HASH : null, blockNumber: world.txMined ? OLD : null };
    if (method === "eth_getTransactionByHash") return { result: params[0] === TX && (!primary || world.txOnPrimary) ? tx : null };
    if (method === "eth_getTransactionReceipt") {
      if (primary || !world.archiveReceipt || params[0] !== TX) return { result: null };
      return { result: { status: "0x1", blockNumber: OLD, blockHash: world.receiptBlockHash, gasUsed: "0x6083d1", transactionHash: TX, logs: [] } };
    }
    if (method === "eth_call") {
      const [call, block] = params as [{ data: string; from?: string }, string];
      if (block === "latest") return client(world.latest, call.data);
      if (primary || !world.archiveState) return { error: primary && world.prunedData ? { ...PRUNED, data: "0x" } : PRUNED };
      if (call.from) return world.replay;
      return client(world.old ?? world.latest, call.data);
    }
    return { error: { code: -32601, message: "Method not found" } };
  };
  const real = globalThis.fetch;
  before(() => {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, ...answer(String(url), body.method, body.params) }));
    }) as typeof fetch;
  });
  after(() => {
    globalThis.fetch = real;
  });

  const entry = (more: Partial<RelayEntry> = {}): RelayEntry => ({
    chain: "mainnet",
    client: CLIENT,
    method: "importHeader",
    block: { number: 2_726_491, hash: HEADER },
    setBefore: 3895,
    setAfter: 3896,
    signatures: 7,
    nonce: 16,
    gasLimit: 6_957_669,
    maxFee: "10000000",
    priorityFee: "1000",
    simulatedGas: 6_325_153,
    dataHash: `0x${"56".repeat(32)}`,
    txHash: TX,
    signedAt: "2026-10-18T19:08:16.291Z",
    sepoliaBlock: null,
    gasUsed: null,
    effectiveGasPrice: null,
    status: null,
    ok: null,
    ...more,
  });
  const receipt = (status: string, gasUsed = "0x100000"): Receipt => ({ status, blockNumber: OLD, gasUsed, transactionHash: TX, logs: [] });

  it("tell a pruned state from a block not seen yet", () => {
    assert.ok(pruned(new Error(JSON.stringify(PRUNED))));
    assert.ok(pruned(new Error('{"code":-32000,"message":"historical state 0xabc is not available"}')));
    assert.ok(!pruned(new Error('{"code":-32000,"message":"header not found"}')));
  });

  it("find the mined one with its receipt from an archive RPC, in the block the Sepolia RPC names", async () => {
    reset();
    const found = await findMined([entry({ txHash: OTHER }), entry()]);
    assert.equal(found?.entry.txHash, TX);
    assert.equal(found?.block, 0xb63c86);
    assert.equal(found?.receipt?.transactionHash, TX);
    assert.ok(!world.asked.some((a) => a.startsWith("sepolia.gateway.tenderly.co eth_getTransactionReceipt")), "an RPC of another chain is not asked");
  });

  it("drop an archive receipt from another block, and find nothing when none is mined", async () => {
    reset({ receiptBlockHash: `0x${"55".repeat(32)}` });
    const found = await findMined([entry()]);
    assert.equal(found?.receipt, null);
    assert.equal(found?.block, 0xb63c86);
    reset({ txMined: false });
    assert.equal(await findMined([entry()]), null);
    reset({ txOnPrimary: false, archiveReceipt: false });
    assert.equal((await findMined([entry()]))?.block, 0xb63c86, "the transaction from an archive RPC");
  });

  it("settle from the client at the latest block when no RPC serves the receipt", async () => {
    reset({ latest: { number: 2_727_000, imported: true } });
    assert.equal((await outcomeAtLatest(entry())).outcome, "ok");
    reset({ latest: { number: 2_727_000, imported: false } });
    assert.equal((await outcomeAtLatest(entry())).outcome, "superseded");
    reset({ latest: { number: 2_726_000, imported: false } });
    const below = await outcomeAtLatest(entry());
    assert.equal(below.outcome, "failed");
    assert.match(below.why, /below it/);
  });

  it("call on an old block's state through an archive RPC once the Sepolia RPC pruned it", async () => {
    reset();
    const a = await callAt({ to: CLIENT, data: LATEST }, OLD, "client state");
    assert.equal(a?.result, `0x${HEADER.slice(2)}${word(2_727_000)}`);
    assert.deepEqual(world.asked.filter((x) => x.endsWith("eth_call")), [`${new URL(RPC).host} eth_call`, "sepolia.drpc.org eth_call"]);
    reset({ archiveState: false });
    assert.equal(await callAt({ to: CLIENT, data: LATEST }, OLD, "client state"), null);
  });

  it("ask the archives when the Sepolia RPC puts data on its pruned-state error (nit 3)", async () => {
    reset({ prunedData: true });
    const a = await callAt({ to: CLIENT, data: LATEST }, OLD, "client state");
    assert.equal(a?.result, `0x${HEADER.slice(2)}${word(2_727_000)}`);
    assert.deepEqual(world.asked.filter((x) => x.endsWith("eth_call")), [`${new URL(RPC).host} eth_call`, "sepolia.drpc.org eth_call"]);
    // A replay there is a revert only once an RPC that serves the state reverts it.
    reset({ prunedData: true, replay: { error: { code: 3, message: "execution reverted", data: `${NOT_NEWER}${word(2_726_491)}${word(2_727_000)}` } } });
    assert.equal((await importedNothing(entry(), receipt("0x0"), 0, 0x100000)).superseded, true);
  });

  it("read NotNewer wherever an RPC puts the revert data", () => {
    const args = `${word(2_726_491)}${word(2_727_000)}`;
    assert.deepEqual(notNewerIn({ code: 3, message: "execution reverted", data: `${NOT_NEWER}${args}` }), { number: 2_726_491n, latest: 2_727_000n });
    assert.deepEqual(notNewerIn({ code: -32015, message: "VM execution error.", data: `Reverted ${NOT_NEWER}${args}` }), { number: 2_726_491n, latest: 2_727_000n });
    assert.deepEqual(notNewerIn({ code: 3, message: `execution reverted: ${NOT_NEWER}${args}` }), { number: 2_726_491n, latest: 2_727_000n });
    assert.equal(notNewerIn({ code: 3, message: "execution reverted", data: { reason: "x" } }), null);
    assert.equal(notNewerIn({ code: 3, message: "execution reverted", data: `${sel("InvalidSignature(uint256,uint256)")}${args}` }), null);
  });

  it("replay a revert on an archive RPC: NotNewer is superseded, another revert fails", async () => {
    reset({ replay: { error: { code: 3, message: "execution reverted", data: `${NOT_NEWER}${word(2_726_491)}${word(2_727_000)}` } } });
    const a = await importedNothing(entry(), receipt("0x0"), 0, 0x100000);
    assert.equal(a.superseded, true);
    assert.match(a.why, /NotNewer\(2726491, 2727000\)/);
    reset({ replay: { error: { code: 3, message: "execution reverted", data: `${sel("InvalidSignature(uint256,uint256)")}${word(3)}${word(5)}` } } });
    const b = await importedNothing(entry(), receipt("0x0"), 0, 0x100000);
    assert.equal(b.superseded, false);
    assert.match(b.why, /InvalidSignature\(3, 5\)/);
    // An archive RPC's revert without data is a revert, not a state it lacks.
    reset({ replay: { error: { code: 3, message: "execution reverted" } }, latest: { number: 2_727_000, imported: false } });
    const c = await importedNothing(entry(), receipt("0x0"), 0, 0x100000);
    assert.equal(c.superseded, false);
    assert.equal(c.why, "replayed on its block it execution reverted");
    // Revert data an RPC gives as an object no longer throws.
    reset({ replay: { error: { code: 3, message: "execution reverted", data: { reason: "x" } } } });
    assert.equal((await importedNothing(entry(), receipt("0x0"), 0, 0x100000)).superseded, false);
  });

  it("fall back to the client at the latest block when no RPC serves the old state", async () => {
    reset({ archiveState: false, latest: { number: 2_727_000, imported: false } });
    const past = await importedNothing(entry(), receipt("0x0"), 0, 0x100000);
    assert.equal(past.superseded, true);
    assert.match(past.why, /no RPC serves the state at its block any more.*the revert not replayed/);
    reset({ archiveState: false, latest: { number: 2_726_000, imported: false } });
    assert.equal((await importedNothing(entry(), receipt("0x0"), 0, 0x100000)).superseded, false);
    reset({ archiveState: false, latest: { number: 2_727_000, imported: true } });
    assert.equal((await importedNothing(entry(), receipt("0x1"), 1, 0x100000)).superseded, true, "status 1 without HeaderImported, the header held");
    // Out of gas fails without a read.
    reset({ archiveState: false });
    assert.equal((await importedNothing(entry(), receipt("0x0", `0x${(6_957_669).toString(16)}`), 0, 6_957_669)).superseded, false);
    assert.equal(world.asked.length, 0);
  });

  it("read the old state from an archive RPC for a status 1 without HeaderImported", async () => {
    reset({ old: { number: 2_726_491, imported: true }, latest: { number: 2_726_000, imported: false } });
    const a = await importedNothing(entry(), receipt("0x1"), 1, 0x100000);
    assert.equal(a.superseded, true);
    assert.match(a.why, /held the header already, at #2,726,491/);
  });
});
