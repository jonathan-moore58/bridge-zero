// Unit tests of relay.ts, offline: the fees it signs and simulates with, how it reads RPC errors,
// the state directory, and how it settles a transaction whose receipt or state an RPC no longer
// serves (against a stand-in for fetch, so no request leaves the machine).
//
//   npm test

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Fees } from "../../contracts/script/lib/sepolia.mjs";
import { clampFees, feeCap, heldBackBeforePlan, maxFeeAt, measureFees, raised, transient, upfrontOf, type ClientState, type Options } from "./relay.js";

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
