// Unit tests of committee.ts, offline: the burn's calldata and burn id against values cast computed
// (cast calldata, cast keccak of cast abi-encode) and the one BridgeMinter.burnIdOf(0) returns on
// Sepolia, the release's calldata, its revive.call as polkadot-js encoded it from the V3 testnet's
// metadata on Oct 20 (and its call hash), the other signatories and the deposit pallet-multisig
// takes, the limits a release is approved with, the payee rule, and the checks of the release's
// call trace on a trace reviveApi.traceCall returned on V3, and the checks of a release's execution.
//
//   npm test

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keyring } from "@polkadot/api";
import { bytesToHex, concatBytes, hexToBytes } from "./bytes.js";
import {
  burnCalldata,
  callHash,
  decodeReleaseCalldata,
  decodeReviveCall,
  encodeReviveCall,
  encodeWeight,
  evmValue,
  executionChecks,
  isDelegation,
  limitsProblem,
  multisigDeposit,
  otherSignatories,
  parseWtpot,
  payeeVerdict,
  releaseCall,
  releaseDepositFloor,
  releaseLimits,
  releaseTraceChecks,
  traceOf,
  type CallTrace,
  type ExecutionFacts,
  type PayeeFacts,
  type ReviveCall,
} from "./committee.js";
import { burnId, releaseCalldata, RELEASED_TOPIC } from "./vault.js";

const SEPOLIA = 11_155_111n;
const MINTER = hexToBytes("0x8287b3baf205ca8456f98346f13064aa7fcdcb9e");
const VAULT = hexToBytes("0xa02ee16eb03d2cf1aef199f7658fb8c8e3188ffd");
const RELEASER = hexToBytes("0xa08a7f7ded49cc81f901fb42fec00edfc48c0fc1");
const PAYEE = hexToBytes("0xd9838a86cf83c28ee486544060d1ca4ca2971071");
const TPOT = 10n ** 14n;
/** BridgeMinter.burnIdOf(0) on Sepolia, Oct 20; cast keccak of cast abi-encode gives the same. */
const BURN_ID_0 = "0x0b8e808d1084dd2878e3d20b124a677cdc26785882cf3aac9f7ccbf84245471f";
/** revive.call(vault, 0, {1.6e9, 60,000}, 3.9415 tPOT, release(BURN_ID_0, PAYEE, 0.5 tPOT)), as polkadot-js encoded it from V3's metadata (call index 0x5001). */
const RELEASE_CALL =
  "0x5001a02ee16eb03d2cf1aef199f7658fb8c8e3188ffd000300105e5f82a903000f00fcbc327a66019101f5b16b840b8e808d1084dd2878e3d20b124a677cdc26785882cf3aac9f7ccbf84245471f" +
  "000000000000000000000000d9838a86cf83c28ee486544060d1ca4ca297107100000000000000000000000000000000000000000000000000002d79883d2000";
const RELEASE_CALL_HASH = "0x9f59c29317862ad33cdf026e1c32b8af449e713dc878f24f9e2a1c1217ee9b9a";
const INDEX = Uint8Array.of(0x50, 0x01);
const MEMBERS = ["5DLnLMAsR3kkHnHndC4eRWhMFXPjCU8bGiSugCjUmGJaBism", "5F99Y91UgQ4EDTubPWWPvWKc3ghhVA77nc7HjRhsTyXn38z9", "5EJJYKuM5aaKwgegKGinAbnL7dK3m3QziyqusPotTQ3S7w1E"];
/** The dry run of the release of 0.5 tPOT to PAYEE from the multisig on Oct 20 (reviveApi.call). */
const NEEDS = { refTime: 782_299_332n, proofSize: 26_093n, maxStorageDeposit: 384_150_000_000_000n };
/** 3.9415 tPOT: DepositPerByte 0.06 x 64 + DepositPerChildTrieItem 0.0015 + the existential deposit 0.1. */
const FLOOR = 394_150_000_000_000n;

describe("amounts", () => {
  it("parses wtPOT with up to 14 decimals into units, which are native base units", () => {
    assert.equal(parseWtpot("0.5"), 50_000_000_000_000n);
    assert.equal(parseWtpot("1"), TPOT);
    assert.equal(parseWtpot("0.00000000000001"), 1n);
    assert.equal(parseWtpot("007.25"), 725_000_000_000_000n);
  });

  it("refuses zero, dust and anything that is not a plain decimal", () => {
    assert.throws(() => parseWtpot("0"), /zero/);
    assert.throws(() => parseWtpot("0.000000000000001"), /more than 14 decimals/);
    for (const bad of ["", "-1", "+1", "1e3", "0x10", "1,5", ".5", "5.", "1.2.3", " 1"]) assert.throws(() => parseWtpot(bad), /not an amount of wtPOT/, bad);
    assert.throws(() => parseWtpot((1n << 128n).toString()), /more than any balance/);
  });

  it("scales native base units to the EVM units the vault pays", () => {
    // cast to-wei 0.5 ether: 18-decimal EVM units at NativeToEthRatio 10^4.
    assert.equal(evmValue(parseWtpot("0.5"), 10_000n), 500_000_000_000_000_000n);
    assert.equal(evmValue(1n, 10_000n), 10_000n);
    assert.throws(() => evmValue(0n, 10_000n), RangeError);
  });
});

describe("the burn", () => {
  it("encodes burn(uint256,address) as cast calldata does", () => {
    assert.equal(
      bytesToHex(burnCalldata(parseWtpot("0.5"), PAYEE)),
      "0xfcd3533c00000000000000000000000000000000000000000000000000002d79883d2000000000000000000000000000d9838a86cf83c28ee486544060d1ca4ca2971071",
    );
    assert.throws(() => burnCalldata(0n, PAYEE), /zero amount/);
    assert.throws(() => burnCalldata(1n, new Uint8Array(20)), /zero address/);
  });

  it("gives burn 0 the id the minter gives it, and each nonce its own", () => {
    assert.equal(bytesToHex(burnId(SEPOLIA, MINTER, 0n)), BURN_ID_0);
    assert.equal(bytesToHex(burnId(SEPOLIA, MINTER, 1n)), "0x1573ff21c0f6cae223a42566b061f39bc0a982dafe451b86b29a8bf5f9219c0e");
    assert.notEqual(bytesToHex(burnId(1n, MINTER, 0n)), BURN_ID_0, "another chain");
    assert.notEqual(bytesToHex(burnId(SEPOLIA, VAULT, 0n)), BURN_ID_0, "another minter");
  });
});

describe("the release's call", () => {
  const release = { burnId: hexToBytes(BURN_ID_0), to: PAYEE, amountNative: parseWtpot("0.5") };
  const limits = { weightLimit: { refTime: 1_600_000_000n, proofSize: 60_000n }, storageDepositLimit: FLOOR };

  it("encodes release(bytes32,address,uint256) as cast calldata does, and decodes it back", () => {
    const data = releaseCalldata(release.burnId, release.to, release.amountNative);
    assert.equal(
      bytesToHex(data),
      "0xf5b16b84" + BURN_ID_0.slice(2) + "000000000000000000000000d9838a86cf83c28ee486544060d1ca4ca2971071" + "00000000000000000000000000000000000000000000000000002d79883d2000",
    );
    const back = decodeReleaseCalldata(data);
    assert.equal(bytesToHex(back.burnId), BURN_ID_0);
    assert.deepEqual(back.to, PAYEE);
    assert.equal(back.amountNative, release.amountNative);
    assert.throws(() => decodeReleaseCalldata(data.slice(0, 99)), /not release/);
    assert.throws(() => decodeReleaseCalldata(concatBytes(Uint8Array.of(0, 0, 0, 0), data.slice(4))), /not release/);
    const dirty = data.slice();
    dirty[36] = 1;
    assert.throws(() => decodeReleaseCalldata(dirty), /not an address/);
  });

  it("encodes a weight as two compacts", () => {
    assert.equal(bytesToHex(encodeWeight(limits.weightLimit)), "0x0300105e5f82a90300");
    assert.equal(bytesToHex(encodeWeight({ refTime: 0n, proofSize: 1n })), "0x0004");
    assert.throws(() => encodeWeight({ refTime: 1n << 64n, proofSize: 0n }), RangeError);
  });

  it("encodes revive.call as polkadot-js does from V3's metadata, with the call hash pallet-multisig keys it by", () => {
    const call = releaseCall(VAULT, release, limits);
    const bytes = encodeReviveCall(INDEX, call);
    assert.equal(bytesToHex(bytes), RELEASE_CALL);
    assert.equal(bytes.length, 142);
    assert.equal(bytesToHex(callHash(bytes)), RELEASE_CALL_HASH);
  });

  it("decodes revive.call back, and refuses another call, a non-canonical compact and trailing bytes", () => {
    const c = decodeReviveCall(hexToBytes(RELEASE_CALL), INDEX);
    assert.deepEqual(c.dest, VAULT);
    assert.equal(c.value, 0n);
    assert.deepEqual(c.weightLimit, limits.weightLimit);
    assert.equal(c.storageDepositLimit, FLOOR);
    assert.equal(bytesToHex(c.data), bytesToHex(releaseCalldata(release.burnId, release.to, release.amountNative)));
    assert.throws(() => decodeReviveCall(hexToBytes(RELEASE_CALL), Uint8Array.of(0x50, 0x02)), /not revive.call/);
    assert.throws(() => decodeReviveCall(concatBytes(hexToBytes(RELEASE_CALL), Uint8Array.of(0)), INDEX), /trailing/);
    // The value 0 written as a two-byte compact.
    const bytes = hexToBytes(RELEASE_CALL);
    const nonCanonical = concatBytes(bytes.subarray(0, 22), Uint8Array.of(0x01, 0x00), bytes.subarray(23));
    assert.throws(() => decodeReviveCall(nonCanonical, INDEX), /non-canonical/);
  });

  it("changes its hash with every field", () => {
    const base: ReviveCall = releaseCall(VAULT, release, limits);
    const variants: ReviveCall[] = [
      { ...base, dest: PAYEE },
      { ...base, value: 1n },
      { ...base, weightLimit: { refTime: 1_600_000_001n, proofSize: 60_000n } },
      { ...base, weightLimit: { refTime: 1_600_000_000n, proofSize: 60_001n } },
      { ...base, storageDepositLimit: FLOOR + 1n },
      releaseCall(VAULT, { ...release, amountNative: release.amountNative + 1n }, limits),
    ];
    const seen = new Set([base, ...variants].map((c) => bytesToHex(callHash(encodeReviveCall(INDEX, c)))));
    assert.equal(seen.size, variants.length + 1);
  });
});

describe("pallet-multisig", () => {
  const keyring = new Keyring({ ss58Format: 42 });
  const ids = MEMBERS.map((m) => keyring.decodeAddress(m));
  const names = (list: Uint8Array[]) => list.map((x) => keyring.encodeAddress(x, 42));

  it("lists each member's other signatories in ascending order of their account ids", () => {
    // payment_queryInfo of these asMulti calls on V3 passed with these orders, Oct 20.
    assert.deepEqual(names(otherSignatories(ids, ids[0])), [MEMBERS[2], MEMBERS[1]]);
    assert.deepEqual(names(otherSignatories(ids, ids[1])), [MEMBERS[0], MEMBERS[2]]);
    assert.deepEqual(names(otherSignatories(ids, ids[2])), [MEMBERS[0], MEMBERS[1]]);
    for (const me of ids) {
      const hex = otherSignatories(ids, me).map((x) => bytesToHex(x));
      assert.deepEqual(hex, [...hex].sort());
    }
  });

  it("refuses an account that is not a member, and a member listed twice", () => {
    assert.throws(() => otherSignatories(ids, new Uint8Array(32)), /not a member/);
    assert.throws(() => otherSignatories([ids[0], ids[1], ids[1]], ids[0]), /twice/);
  });

  it("reserves DepositBase + DepositFactor x threshold from the member who opens an operation", () => {
    // multisig.depositBase and depositFactor on V3: 5.43 and 1.92 tPOT.
    assert.equal(multisigDeposit(543_000_000_000_000n, 192_000_000_000_000n, 2), 927_000_000_000_000n);
  });
});

describe("the limits of a release", () => {
  it("puts the deposit floor at one storage item and the existential deposit: 3.9415 tPOT", () => {
    assert.equal(releaseDepositFloor(6_000_000_000_000n, 150_000_000_000n, 10_000_000_000_000n), FLOOR);
  });

  it("doubles the dry run's weight and rounds it up, and keeps the deposit at the floor or 2% above the dry run", () => {
    assert.deepEqual(releaseLimits(NEEDS, FLOOR), { weightLimit: { refTime: 1_600_000_000n, proofSize: 60_000n }, storageDepositLimit: FLOOR });
    // On a step already: no rounding.
    assert.deepEqual(releaseLimits({ refTime: 50_000_000n, proofSize: 5_000n, maxStorageDeposit: 0n }, FLOOR).weightLimit, { refTime: 100_000_000n, proofSize: 10_000n });
    // A deposit above the floor: 7.683 tPOT + 2% = 7.83666, rounded up to 7.8367.
    assert.equal(releaseLimits({ ...NEEDS, maxStorageDeposit: 768_300_000_000_000n }, FLOOR).storageDepositLimit, 783_670_000_000_000n);
    // Two dry runs a little apart build the same call.
    assert.deepEqual(releaseLimits({ ...NEEDS, refTime: NEEDS.refTime + 1_000_000n, proofSize: NEEDS.proofSize + 500n }, FLOOR), releaseLimits(NEEDS, FLOOR));
    assert.throws(() => releaseLimits({ ...NEEDS, refTime: 0n }, FLOOR), RangeError);
  });

  it("says whether a call's limits cover a dry run", () => {
    const call = releaseCall(VAULT, { burnId: hexToBytes(BURN_ID_0), to: PAYEE, amountNative: 1n }, releaseLimits(NEEDS, FLOOR));
    assert.equal(limitsProblem(call, NEEDS, FLOOR), null);
    assert.match(limitsProblem({ ...call, weightLimit: { refTime: 700_000_000n, proofSize: 60_000n } }, NEEDS, FLOOR) ?? "", /ref time limit/);
    assert.match(limitsProblem({ ...call, weightLimit: { refTime: 1_600_000_000n, proofSize: 20_000n } }, NEEDS, FLOOR) ?? "", /proof size limit/);
    assert.match(limitsProblem({ ...call, storageDepositLimit: NEEDS.maxStorageDeposit - 1n }, NEEDS, FLOOR) ?? "", /storage deposit limit .* below the .* the dry run holds/);
    assert.match(limitsProblem({ ...call, storageDepositLimit: NEEDS.maxStorageDeposit }, NEEDS, FLOOR) ?? "", /below the floor/);
  });
});

describe("the payee", () => {
  const none: PayeeFacts = { original: null, contract: false, sepoliaContract: false, burner: false, sepoliaNonce: 0, v3Nonce: 0 };

  it("is controlled when it is a mapped Substrate account, a contract on V3, the burn's sender, or an address that has signed transactions", () => {
    assert.equal(payeeVerdict({ ...none, original: new Uint8Array(32).fill(7) }).kind, "substrate");
    assert.equal(payeeVerdict({ ...none, contract: true }).kind, "contract");
    assert.equal(payeeVerdict({ ...none, burner: true, sepoliaNonce: 1 }).kind, "burner");
    // The deployer on Oct 20: nonce 46 on Sepolia, 1 on V3, no code on either.
    const signer = payeeVerdict({ ...none, sepoliaNonce: 46, v3Nonce: 1 });
    assert.equal(signer.kind, "signer");
    assert.match(signer.why, /nonce 46 on Sepolia, 1 on V3/);
    for (const f of [{ ...none, original: new Uint8Array(32) }, { ...none, contract: true }, { ...none, burner: true }, { ...none, v3Nonce: 1 }, { ...none, sepoliaNonce: 1 }]) assert.ok(payeeVerdict(f).ok);
  });

  it("is refused when nothing shows that anyone controls it", () => {
    const v = payeeVerdict(none);
    assert.equal(v.ok, false);
    assert.equal(v.kind, "unproven");
    assert.match(v.why, /fallback account nobody controls/);
  });

  it("takes no evidence from Sepolia for a contract there, a smart wallet that sent the burn say", () => {
    for (const f of [{ ...none, sepoliaContract: true, burner: true, sepoliaNonce: 1 }, { ...none, sepoliaContract: true, sepoliaNonce: 3 }]) {
      const v = payeeVerdict(f);
      assert.equal(v.ok, false);
      assert.match(v.why, /a contract on Sepolia that is not on V3/);
    }
    // The same address with a nonce on V3 sent transactions there, as a key does; one with code on V3 is a contract there.
    assert.ok(payeeVerdict({ ...none, sepoliaContract: true, v3Nonce: 1 }).ok);
    assert.equal(payeeVerdict({ ...none, sepoliaContract: true, contract: true }).kind, "contract");
  });

  it("knows an EIP-7702 delegation from a contract's code", () => {
    assert.ok(isDelegation(concatBytes(Uint8Array.of(0xef, 0x01, 0x00), PAYEE)));
    assert.ok(!isDelegation(concatBytes(Uint8Array.of(0xef, 0x01, 0x00), PAYEE, Uint8Array.of(0))));
    assert.ok(!isDelegation(hexToBytes("0x6080604052")));
    assert.ok(!isDelegation(new Uint8Array(0)));
  });
});

describe("the release's call trace", () => {
  // reviveApi.traceCall({ from: the releaser, to: the vault, input: release(BURN_ID_0, PAYEE, 0.5 tPOT) }, { CallTracer: { withLogs: true } }) on V3, Oct 20.
  const trace: CallTrace = {
    from: "0xa08a7f7ded49cc81f901fb42fec00edfc48c0fc1",
    to: "0xa02ee16eb03d2cf1aef199f7658fb8c8e3188ffd",
    input: bytesToHex(releaseCalldata(hexToBytes(BURN_ID_0), PAYEE, 50_000_000_000_000n)),
    output: "0x",
    error: null,
    revertReason: null,
    calls: [
      {
        from: "0xa02ee16eb03d2cf1aef199f7658fb8c8e3188ffd",
        to: "0xd9838a86cf83c28ee486544060d1ca4ca2971071",
        input: "0x",
        output: "0x",
        error: null,
        revertReason: null,
        calls: [],
        logs: [],
        value: "0x00000000000000000000000000000000000000000000000006f05b59d3b20000",
        callType: "Call",
      },
    ],
    logs: [
      {
        address: "0xa02ee16eb03d2cf1aef199f7658fb8c8e3188ffd",
        topics: [RELEASED_TOPIC, BURN_ID_0, "0x000000000000000000000000d9838a86cf83c28ee486544060d1ca4ca2971071"],
        data: "0x00000000000000000000000000000000000000000000000000002d79883d2000",
      },
    ],
    value: "0x0000000000000000000000000000000000000000000000000000000000000000",
    callType: "Call",
  };
  const expect = { releaser: RELEASER, vault: VAULT, release: { burnId: hexToBytes(BURN_ID_0), to: PAYEE, amountNative: 50_000_000_000_000n }, ratio: 10_000n };

  it("passes on the trace V3 returned: the releaser calls the vault, which logs Released and pays 0.5 tPOT", () => {
    const lines = releaseTraceChecks(trace, expect);
    assert.equal(lines.length, 4);
    for (const [ok, what] of lines) assert.ok(ok, what);
    assert.equal(traceOf({ ok: { call: trace } }).trace, trace);
    assert.match(traceOf({ err: { message: "x" } }).problem ?? "", /traceCall returned/);
  });

  it("fails when anything is off", () => {
    const failing = (t: CallTrace, e = expect) => releaseTraceChecks(t, e).filter(([ok]) => !ok).length;
    assert.equal(failing({ ...trace, from: "0x0000000000000000000000000000000000000001" }), 1, "another caller");
    assert.equal(failing({ ...trace, error: "execution reverted", revertReason: "AlreadyReleased()" }), 1, "a revert");
    assert.equal(failing({ ...trace, logs: [] }), 1, "no Released log");
    assert.equal(failing({ ...trace, logs: [trace.logs![0], trace.logs![0]] }), 1, "two Released logs");
    assert.equal(failing({ ...trace, calls: [{ ...trace.calls![0], value: "0x1" }] }), 1, "another payout");
    assert.equal(failing(trace, { ...expect, release: { ...expect.release, amountNative: 1n } }), 2, "another amount: the log and the payout");
    assert.equal(failing(trace, { ...expect, ratio: 1n }), 1, "another ratio");
  });
});

describe("the checks of a release's execution", () => {
  /** Burn 0's execution in V3 block #117,701: 0.5 tPOT to a payee whose account existed. */
  const ED = 10n ** 13n;
  const facts: ExecutionFacts = {
    block: 117_701,
    amountNative: 50_000_000_000_000n,
    outstanding: { before: 3n * TPOT, after: 3n * TPOT - 50_000_000_000_000n },
    payeeExisted: true,
    credited: 50_000_000_000_000n,
    existentialDeposit: ED,
    received: 50_000_000_000_000n * 10_000n,
    value: 50_000_000_000_000n * 10_000n,
    ratio: 10_000n,
  };
  const failing = (f: ExecutionFacts) => executionChecks(f).checks.filter(([ok]) => !ok).map(([, what]) => what);

  it("pass on an execution alone in its block: outstanding down by the amount, the payee up by it", () => {
    const { checks, warnings } = executionChecks(facts);
    assert.equal(checks.length, 3);
    for (const [ok, what] of checks) assert.ok(ok, what);
    assert.deepEqual(warnings, []);
    // A payee whose account the release creates gets the existential deposit too; the EVM RPC may not serve the block any more.
    assert.deepEqual(failing({ ...facts, payeeExisted: false, credited: facts.credited + ED, received: null }), []);
  });

  it("fail on a payout that is not the amount", () => {
    assert.equal(failing({ ...facts, outstanding: { ...facts.outstanding, after: facts.outstanding.after - 1n } }).length, 1, "outstanding down by more");
    assert.equal(failing({ ...facts, credited: facts.credited - 1n, received: facts.received! - 10_000n }).length, 2, "the payee paid less");
  });
});
