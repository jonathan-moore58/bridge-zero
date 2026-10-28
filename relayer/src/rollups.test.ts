// Unit tests of the way in to Base Sepolia and Arbitrum Sepolia, offline: the auto-mint's --network
// (one process for several networks, each with its records, files, locks, scan start and values of
// --keep, --max-spend and --max-base-fee), the first mint of a minter that is not bound to the vault
// yet (only the head path, whose importAndMint binds it), and the L1 part of a rollup's transaction
// (l1.ts: Arbitrum's L1 gas in the gas limit, an OP Stack rollup's L1 data fee in the balance a send
// needs and in what it cost). Sepolia's behaviour is automint.test.ts's. Nothing is read from a chain.
//
//   npm test

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { NETWORKS, type Fees, type Receipt } from "../../contracts/script/lib/sepolia.mjs";
import {
  appendLine,
  decide,
  Fatal,
  filesOf,
  GAS_CAP,
  gasLimitOf,
  headJob,
  HOLD_MS,
  holdAfter,
  minterLockOf,
  NETWORK_DEFAULTS,
  parseLockedLog,
  parseOptions,
  preflight,
  readBridge,
  recordOf,
  resultFromReceipt,
  rpcsOf,
  sendJob,
  sepoliaRpcs,
  setLog,
  spentSince,
  START_BLOCKS,
  stillHolds,
  Usage,
  worstCode,
  type AttemptLine,
  type CallResult,
  type ClientView,
  type Facts,
  type HistoryLine,
  type Hold,
  type Job,
  type LockRecord,
  type PreflightCtx,
  type SendCtx,
  type SepoliaReads,
  type Signer,
} from "./automint.js";
import { MINTED_TOPIC } from "./bridge.js";
import { bytesToHex, hexToBytes, type Hex } from "./bytes.js";
import type { MintBundleFixture } from "./fixture.js";
import { decodeL1Component, decodeL1FeeBound, GAS_PRICE_ORACLE, l1ComponentCalldata, L1_KIND, l1FeeBoundCalldata, l1Request, limitWithL1, NO_L1, NODE_INTERFACE, receiptL1Fee, UNSIGNED_TX_OVERHEAD, type L1Cost } from "./l1.js";
import { addressWord, LOCKED_TOPIC, lockCommitment, uintWord } from "./vault.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const VAULT: Hex = "0xa02ee16eb03d2cf1aef199f7658fb8c8e3188ffd";
const ROLLUP_MINTER: Hex = "0xdc31a3bc1354545eeb985aad7b2aa662e9272348";
const SEPOLIA_MINTER: Hex = "0x8287b3baf205ca8456f98346f13064aa7fcdcb9e";
const D983: Hex = "0xd9838a86cf83c28ee486544060d1ca4ca2971071";
const SENDER: Hex = "0x57cc2ba3b883339a9f32726e6d0d3a9ee861a113";
const ETH = 10n ** 18n;
const ROLLUPS = ["base-sepolia", "arbitrum-sepolia"] as const;
const DIR = mkdtempSync(join(tmpdir(), "bz-rollups-test-"));

setLog(() => undefined);

const word = (x: bigint | Hex): string => bytesToHex(typeof x === "bigint" ? uintWord(x) : addressWord(hexToBytes(x))).slice(2);

/** A Locked log of the vault for `dstChainId` and `dstMinter`, with the commitment its fields give. */
function lockedLog(nonce: bigint, block: number, dstChainId: bigint, dstMinter: Hex) {
  const amount = 10n ** 11n;
  const commitment = bytesToHex(lockCommitment({ v3ChainId: 420_420_777n, vault: hexToBytes(VAULT), dstChainId, dstMinter: hexToBytes(dstMinter), recipient: hexToBytes(D983), amountNative: amount, nonce }));
  return {
    address: VAULT,
    blockNumber: `0x${block.toString(16)}`,
    transactionHash: `0x${"ab".repeat(32)}`,
    topics: [LOCKED_TOPIC, `0x${word(nonce)}`, `0x${word(D983)}`, `0x${word(D983)}`],
    data: `0x${word(dstChainId)}${word(dstMinter)}${word(amount)}${commitment.slice(2)}`,
  };
}

describe("the auto-mint's --network", () => {
  it("serves Sepolia alone by default, with its values as before", () => {
    const o = parseOptions([]);
    assert.deepEqual(o.networks, ["sepolia"]);
    assert.equal(o.keep, 5n * 10n ** 16n);
    assert.equal(o.maxSpend, 2n * 10n ** 16n);
    assert.deepEqual([o.keepBy.sepolia, o.maxSpendBy.sepolia, o.maxBaseFeeBy.sepolia], [o.keep, o.maxSpend, o.maxBaseFee]);
    assert.deepEqual(rpcsOf("sepolia", undefined), sepoliaRpcs(undefined));
    assert.equal(START_BLOCKS.sepolia, 218_400);
  });

  it("takes several networks, each with its own defaults, one value for all, or <network>=<value> pairs", () => {
    const all = parseOptions(["--network", "sepolia,base-sepolia,arbitrum-sepolia"]);
    assert.deepEqual(all.networks, ["sepolia", "base-sepolia", "arbitrum-sepolia"]);
    assert.equal(all.keepBy.sepolia, 5n * 10n ** 16n);
    assert.equal(all.keepBy["base-sepolia"], 2n * 10n ** 14n, "0.0002 ETH on a rollup");
    assert.equal(all.maxSpendBy["arbitrum-sepolia"], 2n * 10n ** 15n, "0.002 ETH a day on a rollup");
    assert.equal(all.maxBaseFeeBy["arbitrum-sepolia"], 1_500_000_000n);
    for (const x of ROLLUPS) assert.deepEqual(NETWORK_DEFAULTS[x], { keep: "0.0002", maxSpend: "0.002" });
    const one = parseOptions(["--network", "base-sepolia,arbitrum-sepolia", "--keep", "0.0005"]);
    assert.deepEqual([one.keepBy["base-sepolia"], one.keepBy["arbitrum-sepolia"]], [5n * 10n ** 14n, 5n * 10n ** 14n]);
    assert.equal(one.keep, 5n * 10n ** 14n, "the first network's");
    const pairs = parseOptions(["--network", "sepolia,arbitrum-sepolia", "--keep", "sepolia=0.01", "--max-spend", "sepolia=0.02,arbitrum-sepolia=0.004", "--max-base-fee", "arbitrum-sepolia=0.5"]);
    assert.deepEqual([pairs.keepBy.sepolia, pairs.keepBy["arbitrum-sepolia"]], [10n ** 16n, 2n * 10n ** 14n], "a network left out keeps its default");
    assert.deepEqual([pairs.maxSpendBy.sepolia, pairs.maxSpendBy["arbitrum-sepolia"]], [2n * 10n ** 16n, 4n * 10n ** 15n]);
    assert.deepEqual([pairs.maxBaseFeeBy.sepolia, pairs.maxBaseFeeBy["arbitrum-sepolia"]], [1_500_000_000n, 500_000_000n]);
  });

  it("refuses a network it does not know, one named twice, values for networks it does not serve, and --retry or --rehearse across networks", () => {
    const password = join(DIR, "not-a-password.txt");
    writeFileSync(password, "not a password\n");
    for (const args of [
      ["--network", "linea-sepolia"],
      ["--network", "base-sepolia,base-sepolia"],
      ["--network", ""],
      ["--network", "base-sepolia", "--keep", "sepolia=0.01"],
      ["--network", "base-sepolia", "--keep", "base-sepolia=0.01,base-sepolia=0.02"],
      ["--network", "base-sepolia", "--keep", "base-sepolia:0.01"],
      ["--network", "base-sepolia,arbitrum-sepolia", "--max-spend", "arbitrum-sepolia=0"],
      ["--network", "base-sepolia,arbitrum-sepolia", "--rehearse", "4"],
      ["--network", "base-sepolia,arbitrum-sepolia", "--send", "--account", "k", "--password-file", password, "--retry", "4"],
    ]) {
      assert.throws(() => parseOptions(args), Usage, args.join(" "));
    }
  });

  for (const network of ROLLUPS) {
    it(`${network}: its records, RPCs, files, locks and scan start`, () => {
      const b = readBridge(ROOT, network);
      assert.deepEqual(
        [b.network, b.chainId, b.minter, b.token, b.client, b.vault],
        [network, NETWORKS[network].chainId, ROLLUP_MINTER, "0xe1130718c56de008b47c392c85895a1a605ba95e", "0x389781d4856f0a9f3266ca6e76be6c7b7cfe0ab6", VAULT],
      );
      const sepolia = readBridge(ROOT);
      assert.equal(sepolia.network, undefined, "Sepolia's bridge reads as before");
      assert.equal(sepolia.minter, SEPOLIA_MINTER);
      assert.deepEqual(rpcsOf(network, undefined), NETWORKS[network].rpcs);
      assert.deepEqual(rpcsOf(network, "https://rpc.example/key"), ["https://rpc.example/key", ...NETWORKS[network].rpcs]);
      const f = filesOf(DIR, SENDER, network);
      assert.equal(f.state, join(DIR, `automint-${network}-${SENDER}.json`));
      assert.equal(f.lock, join(DIR, `automint-${network}-${SENDER}.lock`));
      assert.equal(filesOf(DIR, SENDER).state, join(DIR, `automint-sepolia-${SENDER}.json`), "Sepolia's as before");
      // Both rollups have their minter at one address: the minter's lock names the network.
      assert.equal(minterLockOf(ROLLUP_MINTER, DIR, network), join(DIR, `automint-${network}-minter-${ROLLUP_MINTER}.lock`));
      assert.equal(minterLockOf(SEPOLIA_MINTER, DIR), join(DIR, `automint-sepolia-minter-${SEPOLIA_MINTER}.lock`));
      // Below the minters there (README rows 94 to 97) and below lock 4, the first lock naming one.
      assert.ok(START_BLOCKS[network] < 222_600 && START_BLOCKS[network] > 222_024);
    });
  }

  it("takes a lock for its own network and minter, and skips one for Sepolia or the other rollup", () => {
    const base = readBridge(ROOT, "base-sepolia");
    const own = parseLockedLog(lockedLog(4n, 224_435, 84_532n, ROLLUP_MINTER), base);
    assert.equal(own.kind, "lock");
    // README's lock 4: the commitment the vault stores for it.
    assert.ok(own.kind === "lock");
    assert.equal(own.lock.commitment, "0x911489350293bf3f3d029c18a41148225eda61d272d4dd829b92a41d6c514f61");
    const arbitrum = parseLockedLog(lockedLog(5n, 224_440, 421_614n, ROLLUP_MINTER), base);
    assert.ok(arbitrum.kind === "skip");
    assert.match(arbitrum.why, /names chain 421614, not Base Sepolia \(84532\)/);
    const sepolia = parseLockedLog(lockedLog(3n, 222_024, 11_155_111n, SEPOLIA_MINTER), base);
    assert.ok(sepolia.kind === "skip" && /not Base Sepolia/.test(sepolia.why));
    const five = parseLockedLog(lockedLog(5n, 224_440, 421_614n, ROLLUP_MINTER), readBridge(ROOT, "arbitrum-sepolia"));
    assert.ok(five.kind === "lock");
    assert.equal(five.lock.commitment, "0x636ef291c881c6839ace1d82bfb896a8f8c5322154c31d7e9cde9142e540beb9");
  });

  it("ends a run over several networks with the worst code: a failed check, then a node unreachable, then a pending transaction", () => {
    assert.equal(worstCode([0, 0]), 0);
    assert.equal(worstCode([0, 3]), 3);
    assert.equal(worstCode([3, 2, 0]), 2);
    assert.equal(worstCode([2, 1, 3]), 1);
    assert.equal(worstCode([]), 0);
  });
});

describe("the first mint of a minter that is not bound to the vault", () => {
  const rec = (): LockRecord => {
    const p = parseLockedLog(lockedLog(4n, 1_000, 84_532n, ROLLUP_MINTER), readBridge(ROOT, "base-sepolia"));
    assert.ok(p.kind === "lock");
    return recordOf(p);
  };
  const client = (more: Partial<ClientView> = {}): ClientView => ({ setId: 62n, latestHash: `0x${"cc".repeat(32)}`, latestNumber: 900, halted: false, paused: false, ...more });
  const facts = (more: Partial<Facts> = {}): Facts => ({ now: 0, graceMs: 0, v3Finalized: 1_010, v3SetId: 62n, client: client(), used: false, failedSends: 0, minAmount: 0n, bound: false, ...more });

  it("goes by the head path, whose importAndMint binds the vault, even when the client holds a header after the lock", () => {
    for (const c of [client(), client({ latestNumber: 1_005 })]) {
      const d = decide(rec(), facts({ client: c }));
      assert.deepEqual([d.kind, d.kind === "mint" ? d.path : null], ["mint", "head"]);
      assert.match(d.why, /the minter is not bound yet: importAndMint at V3's finalized head binds the vault and mints/);
    }
    // Bound (or not said, as before): the held path again.
    assert.deepEqual(decide(rec(), facts({ bound: true, client: client({ latestNumber: 1_005 }) })), decide(rec(), facts({ bound: undefined, client: client({ latestNumber: 1_005 }) })));
    const held = decide(rec(), facts({ bound: true, client: client({ latestNumber: 1_005 }) }));
    assert.ok(held.kind === "mint" && held.path === "held");
  });

  it("waits while no importAndMint can bind it: the client behind V3's set, paused or halted, or the set not read", () => {
    const behind = decide(rec(), facts({ v3SetId: 63n, client: client({ latestNumber: 1_005 }) }));
    assert.equal(behind.kind, "wait");
    assert.match(behind.why, /not bound to the vault yet, and mint\(p\) at a held header cannot bind it; .* at set 62 and V3 at set 63/);
    assert.match(decide(rec(), facts({ client: client({ latestNumber: 1_005, halted: true }) })).why, /is halted, so no importAndMint can bind it/);
    assert.match(decide(rec(), facts({ client: client({ paused: true }) })).why, /is paused/);
    assert.equal(decide(rec(), facts({ v3SetId: null })).kind, "wait");
    assert.match(decide(rec(), facts({ v3SetId: 61n })).why, /behind the light client's set 62/);
    // Minted, not final yet or in its grace: as for any lock.
    assert.equal(decide(rec(), facts({ used: true })).kind, "minted");
    assert.equal(decide(rec(), facts({ v3Finalized: 999 })).kind, "wait");
  });

  it("carries the vault's account proof while the minter is not bound, and says so", () => {
    const b = JSON.parse(readFileSync(join(ROOT, "fixtures", "v3-testnet-lock1", "mint-bundle.json"), "utf8")) as MintBundleFixture;
    const p = parseLockedLog(
      {
        ...lockedLog(1n, 118_636, 11_155_111n, SEPOLIA_MINTER),
        data: `0x${word(11_155_111n)}${word(SEPOLIA_MINTER)}${word(10n ** 14n)}${b.lock.commitment.slice(2)}`,
      },
      readBridge(ROOT),
    );
    assert.ok(p.kind === "lock");
    const at = { setId: 33n, latestHash: `0x${"cc".repeat(32)}` as Hex, latestNumber: 118_000, halted: false, paused: false };
    const unbound = headJob(b, recordOf(p), at, false, SEPOLIA_MINTER);
    assert.match(unbound.what, /binding the vault first \(its account proof, \d+ items: the minter is not bound yet\)/);
    const bound = headJob(b, recordOf(p), at, true, SEPOLIA_MINTER);
    assert.doesNotMatch(bound.what, /binding/);
    assert.ok(bound.data.length < unbound.data.length);
  });
});

describe("the L1 part of a rollup's transaction", () => {
  it("knows how each network charges for L1", () => {
    assert.deepEqual(L1_KIND, { sepolia: "none", "base-sepolia": "op", "arbitrum-sepolia": "arbitrum" });
    assert.equal(l1Request("none", ROLLUP_MINTER, "0x12"), null);
    assert.equal(l1Request("arbitrum", ROLLUP_MINTER, "0x12")?.to, NODE_INTERFACE);
    assert.equal(l1Request("op", ROLLUP_MINTER, "0x12")?.to, GAS_PRICE_ORACLE);
  });

  it("asks NodeInterface for a call's L1 gas, and reads its answer", () => {
    const data: Hex = "0xdeadbeef";
    const c = l1ComponentCalldata(ROLLUP_MINTER, data);
    const sel = bytesToHex(keccak_256(new TextEncoder().encode("gasEstimateL1Component(address,bool,bytes)")).slice(0, 4));
    assert.equal(c.slice(0, 10), sel);
    const body = c.slice(10);
    assert.equal(body.slice(0, 64), word(ROLLUP_MINTER));
    assert.equal(BigInt(`0x${body.slice(64, 128)}`), 0n, "a call, not a creation");
    assert.equal(BigInt(`0x${body.slice(128, 192)}`), 96n, "the bytes after the two static words");
    assert.equal(BigInt(`0x${body.slice(192, 256)}`), 4n);
    assert.equal(body.slice(256, 264), "deadbeef");
    assert.equal(BigInt(`0x${l1ComponentCalldata(null, data).slice(10 + 64, 10 + 128)}`), 1n, "a creation");
    const answer = `0x${word(123_456n)}${word(20_000_000n)}${word(7n)}` as Hex;
    assert.deepEqual(decodeL1Component(answer), { kind: "arbitrum", gas: 123_456, fee: 123_456n * 20_000_000n, l1BaseFee: 7n });
  });

  it("asks GasPriceOracle for the bound of a call's L1 fee, for the calldata and the rest of the transaction", () => {
    const c = l1FeeBoundCalldata("0x0102030405");
    assert.equal(c.slice(0, 10), bytesToHex(keccak_256(new TextEncoder().encode("getL1FeeUpperBound(uint256)")).slice(0, 4)));
    assert.equal(BigInt(`0x${c.slice(10)}`), BigInt(5 + UNSIGNED_TX_OVERHEAD));
    assert.deepEqual(decodeL1FeeBound(`0x${word(359_835_110n)}`), { kind: "op", gas: 0, fee: 359_835_110n, l1BaseFee: null });
  });

  it("adds Arbitrum's L1 gas once more to the gas limit, and nothing elsewhere; reads an OP Stack receipt's l1Fee", () => {
    const l1: L1Cost = { kind: "arbitrum", gas: 50_000, fee: 0n, l1BaseFee: 1n };
    assert.equal(limitWithL1("arbitrum", 2_900_000, l1), 2_950_000);
    assert.equal(limitWithL1("op", 2_900_000, { kind: "op", gas: 0, fee: 5n, l1BaseFee: null }), 2_900_000);
    assert.equal(limitWithL1("none", 2_900_000, NO_L1), 2_900_000);
    assert.equal(receiptL1Fee({ l1Fee: "0xe0ce7a" }), 14_732_922n);
    assert.equal(receiptL1Fee({}), 0n);
    assert.equal(receiptL1Fee({ l1Fee: null }), 0n);
  });
});

describe("a rollup's send: its gas limit, the balance it needs and what it cost", () => {
  const p = parseLockedLog(lockedLog(5n, 224_440, 421_614n, ROLLUP_MINTER), readBridge(ROOT, "arbitrum-sepolia"));
  assert.ok(p.kind === "lock");
  const job: Job = { lock: recordOf(p), path: "head", block: { number: 224_531, hash: `0x${"dd".repeat(32)}` }, to: ROLLUP_MINTER, data: "0x1234abcd", what: "importAndMint" };

  /** A rollup as a preflight reads it, in memory. */
  class FakeRollup implements SepoliaReads {
    gas = 2_636_722;
    base = 20_000_000n;
    funds = ETH;
    l1: L1Cost = NO_L1;
    async used() {
      return false;
    }
    async call(): Promise<CallResult> {
      return { ok: true, revert: null, text: "no revert" };
    }
    async estimateGas() {
      return this.gas;
    }
    async nextBaseFee() {
      return this.base;
    }
    async balance() {
      return this.funds;
    }
    async nonces() {
      return { latest: 0, pending: 0 };
    }
    async receipt() {
      return null;
    }
    async transaction() {
      return null;
    }
    publishUrl() {
      return "https://rollup.example";
    }
    async l1Cost() {
      return this.l1;
    }
  }
  const ctx = (r: FakeRollup, more: Partial<PreflightCtx["fees"]> = {}): PreflightCtx => ({
    sepolia: r,
    network: { title: "Arbitrum Sepolia", gasCap: GAS_CAP },
    sender: SENDER,
    fees: { maxBaseFee: 1_500_000_000n, keep: 2n * 10n ** 14n, ...more },
  });

  it("on Arbitrum: the estimate with its L1 gas + 10%, and the L1 gas once more; the cap bounds the execution part", async () => {
    const r = new FakeRollup();
    r.l1 = { kind: "arbitrum", gas: 400_000, fee: 400_000n * 20_000_000n, l1BaseFee: 30n };
    const pf = await preflight(job, ctx(r), true);
    assert.ok(pf.kind === "ready");
    assert.equal(pf.gas, 2_636_722);
    assert.equal(pf.gasLimit, gasLimitOf(2_636_722) + 400_000);
    assert.deepEqual(pf.l1, r.l1);
    // 15.3 M of execution would pass the cap with its 10%; the same estimate with 2 M of it L1 gas does not.
    r.gas = 15_300_000;
    r.l1 = NO_L1;
    const over = await preflight(job, ctx(r), true);
    assert.ok(over.kind === "failed" && /above Arbitrum Sepolia's 16,777,216 cap/.test(over.why));
    r.l1 = { kind: "arbitrum", gas: 2_000_000, fee: 0n, l1BaseFee: 1n };
    const fits = await preflight(job, ctx(r), true);
    assert.ok(fits.kind === "ready", "the L1 gas is not execution");
    assert.ok(fits.gasLimit > GAS_CAP);
  });

  it("on an OP Stack rollup: the gas limit as on Sepolia, and the L1 fee in the balance a send needs and in --max-spend", async () => {
    const r = new FakeRollup();
    r.base = 5_000_000n;
    r.l1 = { kind: "op", gas: 0, fee: 10n ** 14n, l1BaseFee: null };
    const fees: Fees = { base: 5_000_000n, tip: 1_000n, maxFee: 50_001_000n, gasPrice: 5_001_000n };
    const limit = gasLimitOf(r.gas);
    const need = BigInt(limit) * fees.maxFee + r.l1.fee;
    r.funds = need + 2n * 10n ** 14n;
    const ok = await preflight(job, ctx(r), true);
    assert.ok(ok.kind === "ready" && ok.gasLimit === limit);
    r.funds -= 1n;
    const short = await preflight(job, ctx(r), true);
    assert.ok(short.kind === "wait" && /the gas limit at the max fee and the L1 fee is/.test(short.why));
    r.funds = ETH;
    const next = BigInt(limit) * (fees.base + fees.tip) + r.l1.fee;
    const capped = await preflight(job, { ...ctx(r, { maxSpend: next - 1n }), spent: () => 0n }, true);
    assert.ok(capped.kind === "wait" && /above --max-spend/.test(capped.why));
    assert.equal((await preflight(job, { ...ctx(r, { maxSpend: next }), spent: () => 0n }, true)).kind, "ready");
  });

  it("says when a send waits for what it costs (the base fee, --max-spend, or the balance, given with it), and not when it waits for anything else", async () => {
    const r = new FakeRollup();
    r.base = 2_000_000_000n;
    const gate = await preflight(job, ctx(r), true);
    assert.ok(gate.kind === "wait" && gate.cost === "base-fee", "above --max-base-fee");
    r.base = 20_000_000n;
    const capped = await preflight(job, { ...ctx(r, { maxSpend: 1n }), spent: () => 0n }, true);
    assert.ok(capped.kind === "wait" && capped.cost === "max-spend");
    r.funds = 10n ** 14n;
    const short = await preflight(job, ctx(r), true);
    assert.ok(short.kind === "wait" && short.cost === "balance" && short.balance === 10n ** 14n);
    r.funds = ETH;
    r.nonces = async () => ({ latest: 3, pending: 4 });
    const pending = await preflight(job, ctx(r), true);
    assert.ok(pending.kind === "wait" && pending.cost === undefined, "a pending transaction");
    r.call = async () => ({ ok: false, revert: null, text: "NotNewer(225000, 225100)" });
    const moved = await preflight(job, ctx(r), true);
    assert.ok(moved.kind === "wait" && moved.cost === undefined, "the chains moved");
  });

  it("holds a rollup's lock for 5 minutes after such a wait, never Sepolia's (planned every round, as before), a replacement's, or after any other end", () => {
    assert.deepEqual(HOLD_MS, { sepolia: 0, "base-sepolia": 300_000, "arbitrum-sepolia": 300_000 });
    const short = { kind: "wait", why: "the sender has 0 ETH", cost: "balance", balance: 0n } as const;
    for (const network of ROLLUPS) {
      assert.deepEqual(holdAfter(short, network, "head", false, 1_000), { path: "head", until: 301_000, cost: "balance", why: "the sender has 0 ETH", balance: 0n });
    }
    assert.deepEqual(holdAfter({ kind: "wait", why: "above --max-spend", cost: "max-spend" }, "base-sepolia", "held", false, 0), { path: "held", until: 300_000, cost: "max-spend", why: "above --max-spend" });
    assert.equal(holdAfter(short, "sepolia", "head", false, 1_000), null);
    assert.equal(holdAfter(short, "arbitrum-sepolia", "head", true, 1_000), null, "a replacement");
    assert.equal(holdAfter({ kind: "wait", why: "the chains moved" }, "arbitrum-sepolia", "head", false), null);
    assert.equal(holdAfter({ kind: "failed", why: "eth_call reverts VaultNotBound()" }, "arbitrum-sepolia", "head", false), null);
    assert.equal(holdAfter({ kind: "minted", ours: false, txHash: null, why: "minted already" }, "arbitrum-sepolia", "head", false), null);
  });

  it("keeps the hold until its end, on its path, while the sender's balance has not risen, the base fee is above the gate, or --max-spend is reached", async () => {
    const r = new FakeRollup();
    const gateFee = 1_500_000_000n;
    r.funds = 5n;
    const short: Hold = { path: "head", until: 10_000, cost: "balance", why: "the sender has 5 wei", balance: 5n };
    assert.equal(await stillHolds(short, "head", r, SENDER, gateFee, 9_999), true);
    assert.equal(await stillHolds(short, "head", r, SENDER, gateFee, 10_000), false, "its end");
    assert.equal(await stillHolds(short, "held", r, SENDER, gateFee, 0), false, "another path is planned");
    assert.equal(await stillHolds(undefined, "head", r, SENDER, gateFee, 0), false);
    r.funds = 4n;
    assert.equal(await stillHolds(short, "head", r, SENDER, gateFee, 0), true, "less than before");
    r.funds = 6n;
    assert.equal(await stillHolds(short, "head", r, SENDER, gateFee, 0), false, "funded: planned again at once");
    const gate: Hold = { path: "head", until: 10_000, cost: "base-fee", why: "the next base fee is above --max-base-fee" };
    r.base = gateFee + 1n;
    assert.equal(await stillHolds(gate, "head", r, SENDER, gateFee, 0), true);
    r.base = gateFee;
    assert.equal(await stillHolds(gate, "head", r, SENDER, gateFee, 0), false, "back within the gate");
    const spend: Hold = { path: "head", until: 10_000, cost: "max-spend", why: "above --max-spend" };
    assert.equal(await stillHolds(spend, "head", r, SENDER, gateFee, 9_999), true);
    assert.equal(await stillHolds(spend, "head", r, SENDER, gateFee, 10_000), false);
  });

  it("signs a rollup's mint for the rollup's chain id, and Sepolia's for Sepolia, as before", async () => {
    const history = join(DIR, "automint-arbitrum-sepolia-sign-test.jsonl");
    writeFileSync(history, "");
    const signed: string[][] = [];
    // cast that cannot sign: the send stops there (Fatal), with the arguments it was given.
    const signer: Signer = {
      sign: (args) => {
        signed.push(args);
        return null;
      },
      publish: () => false,
    };
    const send = (chainId: bigint | undefined): SendCtx => ({
      ...ctx(new FakeRollup()),
      ...(chainId === undefined ? {} : { chainId }),
      minter: ROLLUP_MINTER,
      record: (line) => appendLine(history, line),
      signer,
      account: "automint-test-key",
      passwordFile: "no-password-file",
      fence: () => undefined,
      receiptWaitMs: 10,
      pollMs: 5,
    });
    await assert.rejects(sendJob(job, send(421_614n)), Fatal);
    await assert.rejects(sendJob(job, send(undefined)), Fatal);
    assert.deepEqual(
      signed.map((a) => [a[a.indexOf("--chain") + 1], a[a.indexOf("--rpc-url") + 1]]),
      [
        ["421614", "https://rollup.example"],
        ["11155111", "https://rollup.example"],
      ],
    );
  });

  it("records an OP Stack receipt's l1Fee with the result, and counts it in what was spent", async () => {
    const attempt: AttemptLine = {
      kind: "attempt",
      id: "a",
      lock: "4",
      path: "head",
      block: job.block,
      to: ROLLUP_MINTER,
      dataHash: `0x${"00".repeat(32)}`,
      sender: SENDER,
      txNonce: 0,
      recipient: D983,
      amount: "100000000000",
      gas: 2_662_538,
      gasLimit: 2_928_792,
      maxFee: "108987270",
      priorityFee: "1000",
      at: new Date().toISOString(),
    };
    const receipt = {
      status: "0x1",
      blockNumber: "0x30c0000",
      gasUsed: "0x28a000",
      effectiveGasPrice: "0x4c4b40",
      transactionHash: `0x${"ee".repeat(32)}`,
      l1Fee: "0x2540be400",
      logs: [{ address: ROLLUP_MINTER, topics: [MINTED_TOPIC, `0x${word(4n)}`, `0x${word(D983)}`, `0x${"dd".repeat(32)}`], data: `0x${word(10n ** 11n)}` }],
    } as Receipt & { l1Fee: string };
    const line = await resultFromReceipt(attempt, receipt.transactionHash as Hex, receipt, { sepolia: new FakeRollup(), minter: ROLLUP_MINTER, title: "Base Sepolia", record: () => undefined });
    assert.equal(line.outcome, "minted");
    assert.match(line.why, /mined in Base Sepolia block/);
    assert.equal(line.l1Fee, "10000000000");
    const gasCost = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice!);
    assert.equal(spentSince([line as HistoryLine], 0), gasCost + 10_000_000_000n);
    // A Sepolia or Arbitrum receipt has no l1Fee: the result has none, as before.
    const plain = await resultFromReceipt(attempt, receipt.transactionHash as Hex, { ...receipt, l1Fee: undefined } as unknown as Receipt, { sepolia: new FakeRollup(), minter: ROLLUP_MINTER, record: () => undefined });
    assert.equal("l1Fee" in plain, false);
    assert.match(plain.why, /mined in Sepolia block/);
    assert.equal(spentSince([plain as HistoryLine], 0), gasCost);
  });
});
