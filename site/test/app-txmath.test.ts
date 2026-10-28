// The arithmetic of the app's sends (src/app/txmath.ts): an amount typed in the bridge's field as
// exact base units, the gas and fee policies, and the receipts' logs checked before the page trusts
// them, against lock 1, burns 0 and 1 and lock 1's mint as deployments/ records them. Offline.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  burnedOf,
  carries,
  evmValue,
  gasText,
  keyControlled,
  lockedOf,
  mintedIn,
  multisigOf,
  parseAmount,
  SEPOLIA_MIN_TIP,
  sepoliaFees,
  upFront,
  v3Fees,
  withMargin,
  type LockExpect,
  type ReceiptLog,
} from "../src/app/txmath.ts";
import { eventTopic } from "../src/lib/hashes.ts";
import { bytesToHex, concatBytes, hexToBytes, type Hex } from "../src/lib/hex.ts";
import { burnId, lockCommitment } from "../src/lib/proofs.ts";
import { enc, MINTER, readJson, registry, VAULT } from "./fake-chains.ts";

const SEPOLIA_ID = 11_155_111n;
const V3_ID = 420_420_777n;
const LOCKED = eventTopic("Locked(uint256,address,address,uint256,address,uint256,bytes32)");
const BURN_REQUESTED = eventTopic("BurnRequested(uint256,address,address,uint256,bytes32)");
const MINTED = eventTopic("Minted(uint256,address,uint256,bytes32)");
const topic = (v: bigint | string): Hex => `0x${BigInt(v).toString(16).padStart(64, "0")}`;

/** Lock 1 (README row 54) and its vault, as deployments/v3-testnet.json records them. */
const lock1 = readJson("deployments/v3-testnet.json").locks[1];
const steps: { kind: string; burn?: { burnNonce: string; burnId: string; amount: string; v3Recipient: string }; sender: string; lock?: { nonce: number }; bundle?: { block: { hash: Hex } } }[] =
  readJson("deployments/sepolia-bridge.json").steps;
const burns = steps.filter((s) => s.kind === "burn");
const burn1 = burns.find((s) => s.burn?.burnNonce === "1");
const mint1 = steps.find((s) => s.kind === "mint" && s.lock?.nonce === 1);

const expectLock1: LockExpect = { vault: VAULT, v3ChainId: V3_ID, dstChainId: SEPOLIA_ID, minter: MINTER, sender: lock1.from, recipient: lock1.recipient, amount: BigInt(lock1.amountNative) };

/** Lock 1's Locked log, as the vault emitted it, with any field changed. */
function lockedLog(over: { address?: string; nonce?: bigint; sender?: string; recipient?: string; dstChainId?: bigint; dstMinter?: string; amount?: bigint; commitment?: Hex } = {}): ReceiptLog {
  return {
    address: over.address ?? lock1.vault,
    topics: [LOCKED, topic(over.nonce ?? BigInt(lock1.vaultNonce)), topic(over.sender ?? lock1.from), topic(over.recipient ?? lock1.recipient)],
    data: enc("uint256,address,uint256,bytes32", [over.dstChainId ?? BigInt(lock1.dstChainId), over.dstMinter ?? lock1.dstMinter, over.amount ?? BigInt(lock1.amountNative), over.commitment ?? lock1.commitment]),
  };
}

test("an amount is read exactly, in base units, never through a float", () => {
  assert.equal(parseAmount("1"), 100_000_000_000_000n);
  assert.equal(parseAmount("0.5"), 50_000_000_000_000n);
  assert.equal(parseAmount(".5"), 50_000_000_000_000n);
  assert.equal(parseAmount("1."), 100_000_000_000_000n);
  assert.equal(parseAmount(" 01.50 "), 150_000_000_000_000n);
  // 0.1 + 0.2 as a float is 0.30000000000000004: as text it is exact.
  assert.equal(parseAmount("0.3"), 30_000_000_000_000n);
  assert.equal(parseAmount("1.00000000000001"), 100_000_000_000_001n);
  assert.equal(parseAmount("123456789.12345678901234"), 12_345_678_912_345_678_901_234n);
  for (const bad of ["", ".", "0", "0.0", "0.000000000000001", "1e3", "-1", "1,5", "1.2.3", "0x10", "one", "1 000"]) assert.equal(parseAmount(bad), null, bad);
});

test("the lock's value is whole native units in V3's 18 decimals, so the vault never sees dust", () => {
  assert.equal(evmValue(100_000_000_000_000n), BigInt(lock1.value));
  for (const units of [1n, 7n, 123_456_789n, 10n ** 20n + 3n]) assert.equal(evmValue(units) % 10_000n, 0n);
});

test("V3's fees and gas are lock 1's: the max fee one eighth above the gas price, no tip, the estimate plus 10%", () => {
  const fees = v3Fees(BigInt(lock1.gasPrice));
  assert.equal(fees.maxFeePerGas, BigInt(lock1.maxFee));
  assert.equal(fees.maxPriorityFeePerGas, 0n);
  // The estimate lock 1's limit came from, plus 10% as the vault tool sent it.
  assert.equal(withMargin(105_612_858_522_451n), BigInt(lock1.gasLimit));
  // What a wallet checks up front for it: 1 tPOT and the limit at the max fee, about 5.86 tPOT in all.
  assert.equal(upFront(BigInt(lock1.value), BigInt(lock1.gasLimit), fees), BigInt(lock1.value) + BigInt(lock1.gasLimit) * BigInt(lock1.maxFee));
});

test("Sepolia's fees: twice the base fee and the tip, the tip at least the relayer's 1,000 wei", () => {
  // A public node suggested 3 wei on Oct 26, at a base fee of 17.
  assert.deepEqual(sepoliaFees(17n, 3n), { maxFeePerGas: 2n * 17n + SEPOLIA_MIN_TIP, maxPriorityFeePerGas: SEPOLIA_MIN_TIP });
  assert.deepEqual(sepoliaFees(18n, 1_000_000n), { maxFeePerGas: 1_000_036n, maxPriorityFeePerGas: 1_000_000n });
  assert.equal(upFront(0n, 68_487n, sepoliaFees(17n, 3n)), 68_487n * 1_034n);
});

test("a burn's sender has to be an address a key controls: no code, or an EIP-7702 delegation", () => {
  assert.equal(keyControlled("0x"), true);
  assert.equal(keyControlled(`0xef0100${"ab".repeat(20)}`), true);
  assert.equal(keyControlled(`0xEF0100${"AB".repeat(20)}`), true);
  assert.equal(keyControlled(`0xef0100${"ab".repeat(19)}`), false);
  assert.equal(keyControlled("0x6080604052"), false);
});

test("gas reads as the transfer screen says it", () => {
  assert.equal(gasText(2_391_069), "2.4 M");
  assert.equal(gasText(601_910n), "602 k");
  assert.equal(gasText(61_434), "61 k");
  assert.equal(gasText(14_077_990), "14.1 M");
});

test("lock 1's Locked log checks out: its nonce, and its commitment recomputed as BridgeMinter will", () => {
  const r = lockedOf([lockedLog()], registry, expectLock1);
  assert.ok(r.ok, r.ok ? "" : r.why);
  assert.equal(r.nonce, 1n);
  assert.equal(r.commitment, lock1.commitment);
  assert.equal(
    lockCommitment({ v3ChainId: V3_ID, vault: VAULT, dstChainId: SEPOLIA_ID, minter: MINTER, recipient: lock1.recipient, amountNative: BigInt(lock1.amountNative), nonce: 1n }),
    lock1.commitment,
  );
  // Another contract's log first in the receipt is passed over.
  const other = { ...lockedLog(), address: MINTER };
  assert.ok(lockedOf([other, lockedLog()], registry, expectLock1).ok);
});

test("a Locked log that is not this lock is refused, saying why", () => {
  const why = (log: ReceiptLog, e: LockExpect = expectLock1): string => {
    const r = lockedOf([log], registry, e);
    assert.equal(r.ok, false);
    return r.ok ? "" : r.why;
  };
  assert.match(why(lockedLog({ address: MINTER })), /no Locked log of the vault/);
  assert.match(why(lockedLog({ dstMinter: VAULT })), /another chain or minter/);
  assert.match(why(lockedLog({ dstChainId: 1n })), /another chain or minter/);
  assert.match(why(lockedLog({ recipient: VAULT })), /recipient is not the address you gave/);
  assert.match(why(lockedLog({ sender: MINTER })), /sender is not your address/);
  // A Substrate account's lock: the vault's sender is the account's address on V3, the recipient the one given.
  const h160 = "0xb621f9a9dd96ba88681c40b04657cef602854e24";
  assert.match(why(lockedLog({ sender: h160 })), /sender is not your address/);
  assert.equal(lockedOf([lockedLog({ sender: h160 })], registry, { ...expectLock1, sender: h160 }).ok, true);
  assert.match(why(lockedLog(), { ...expectLock1, amount: 2n * expectLock1.amount }), /locked 100000000000000 base units/);
  assert.match(why(lockedLog({ commitment: topic(1n) })), /the vault stored/);
  // The nonce is the log's: another nonce under lock 1's commitment does not hold.
  assert.match(why(lockedLog({ nonce: 7n })), /the vault stored/);
  assert.match(why({ address: VAULT, topics: [LOCKED], data: "0x" }), /no Locked log|does not decode/);
});

test("burns 0 and 1's BurnRequested logs check out, each burn id the convention the committee releases by", () => {
  assert.equal(burns.length >= 2, true);
  for (const s of burns) {
    const b = s.burn!;
    const log: ReceiptLog = {
      address: MINTER,
      topics: [BURN_REQUESTED, topic(b.burnNonce), topic(s.sender), topic(b.v3Recipient)],
      data: enc("uint256,bytes32", [BigInt(b.amount), b.burnId]),
    };
    const r = burnedOf([log], registry, { minter: MINTER, chainId: SEPOLIA_ID, sender: s.sender, amount: BigInt(b.amount) });
    assert.ok(r.ok, r.ok ? "" : r.why);
    assert.equal(r.burnNonce, BigInt(b.burnNonce));
    assert.equal(r.burnId, b.burnId);
    assert.equal(burnId(SEPOLIA_ID, MINTER, BigInt(b.burnNonce)), b.burnId);
  }
  const b = burn1!.burn!;
  const log = (id: string, recipient = b.v3Recipient): ReceiptLog => ({
    address: MINTER,
    topics: [BURN_REQUESTED, topic(b.burnNonce), topic(burn1!.sender), topic(recipient)],
    data: enc("uint256,bytes32", [BigInt(b.amount), id]),
  });
  const expect = { minter: MINTER, chainId: SEPOLIA_ID, sender: burn1!.sender, amount: BigInt(b.amount) };
  const r1 = burnedOf([log(burns[0]!.burn!.burnId)], registry, expect);
  assert.ok(!r1.ok && /burn id is/.test(r1.why));
  const r2 = burnedOf([log(b.burnId, VAULT)], registry, expect);
  assert.ok(!r2.ok && /not your address/.test(r2.why));
  const r3 = burnedOf([log(b.burnId)], registry, { ...expect, amount: 1n });
  assert.ok(!r3.ok && /burned 10000000000000 base units/.test(r3.why));
  assert.equal(burnedOf([], registry, expect).ok, false);
});

test("lock 1's mint is found by its Minted log: its nonce, and the V3 block it proved the lock in", () => {
  const blockHash = mint1!.bundle!.block.hash;
  const log: ReceiptLog = { address: MINTER, topics: [MINTED, topic(1n), topic(lock1.recipient), blockHash], data: enc("uint256", [BigInt(lock1.amountNative)]) };
  assert.deepEqual(mintedIn([log], registry, MINTER, 1n), { blockHash });
  assert.equal(mintedIn([log], registry, MINTER, 2n), null);
  assert.equal(mintedIn([{ ...log, address: VAULT }], registry, MINTER, 1n), null);
});

test("an open multisig operation reads as its timepoint and its approvals", () => {
  const u32 = (n: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    return b;
  };
  const account = (k: number) => new Uint8Array(32).fill(k);
  // Burn 1's release, opened by member 1 in V3 #173,057, extrinsic 1 (deployments/v3-testnet.json): 9.27 tPOT reserved.
  const deposit = hexToBytes(`0x${(927_000_000_000_000n).toString(16).padStart(32, "0")}`).reverse();
  const value = (approvals: number) => concatBytes(u32(173_057), u32(1), deposit, account(1), new Uint8Array([approvals << 2]), ...Array.from({ length: approvals }, (_, i) => account(i + 1)));
  assert.deepEqual(multisigOf(value(1)), { height: 173_057, index: 1, approvals: 1 });
  assert.deepEqual(multisigOf(value(2)), { height: 173_057, index: 1, approvals: 2 });
  assert.equal(multisigOf(value(1).slice(0, -1)), null);
  assert.equal(multisigOf(new Uint8Array(8)), null);
});

test("an extrinsic carries a burn id only at a byte boundary", () => {
  const id = burn1!.burn!.burnId;
  const ext = bytesToHex(concatBytes(new Uint8Array([0x45, 0x02, 0x84]), hexToBytes(id), new Uint8Array([0x00])));
  assert.equal(carries(ext, id), true);
  assert.equal(carries(ext.toUpperCase().replace("0X", "0x"), id), true);
  // The same digits shifted by half a byte are not the id.
  assert.equal(carries(`0x0${ext.slice(2)}0`, id), false);
  assert.equal(carries(ext, id.slice(0, 40)), false);
});
