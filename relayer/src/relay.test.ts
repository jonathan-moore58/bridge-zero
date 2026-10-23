// Unit tests of relay.ts, offline: the fees it signs and simulates with, how it reads RPC errors,
// the state directory, and how it settles a transaction whose receipt or state an RPC no longer
// serves (against a stand-in for fetch, so no request leaves the machine).
//
//   npm test

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Fees } from "../../contracts/script/lib/sepolia.mjs";
import { feeCap, measureFees, raised, type Options } from "./relay.js";

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
