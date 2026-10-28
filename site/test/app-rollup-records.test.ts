// The rollups' first transfers, recomputed with the app's own code from what deployments/ recorded:
// lock 4 (to Base Sepolia) and lock 5 (to Arbitrum Sepolia), whose commitments the vault stored on V3
// (deployments/v3-testnet.json, README rows 98 and 99), and burn 0 on each rollup, whose ids the
// committee released (deployments/base-sepolia-bridge.json and arbitrum-sepolia-bridge.json, rows 108
// to 113). The config of each destination (src/app/dests.ts), the commitment and the burn id
// (src/lib/proofs.ts), the receipt checks the sends make (src/app/txmath.ts), both wallet paths' lock
// calldata, the proof planner's reading of a Locked log (src/lib/proof/plan.ts) and the ids the pages
// go by. Offline.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { burnKey, deployed, destOf, destOfLock, lockKey, refOf, type DestKey } from "../src/app/dests.ts";
import { lockData } from "../src/app/substrate/call.ts";
import { burnedOf, lockedOf, type ReceiptLog } from "../src/app/txmath.ts";
import { encodeCall } from "../src/lib/abi.ts";
import { V3_CHAIN_ID } from "../src/lib/endpoints.ts";
import { eventTopic } from "../src/lib/hashes.ts";
import type { Hex } from "../src/lib/hex.ts";
import { lockRefOf, type ProofEnv } from "../src/lib/proof/plan.ts";
import { burnId, lockCommitment } from "../src/lib/proofs.ts";
import type { SubstrateClient } from "../src/lib/rpc.ts";
import { enc, readJson, registry, repo } from "./fake-chains.ts";

const V3 = readJson("deployments/v3-testnet.json");
const VAULT = (V3.vault.address as string).toLowerCase() as Hex;
const README = readFileSync(join(repo, "README.md"), "utf8");
const LOCKED = eventTopic("Locked(uint256,address,address,uint256,address,uint256,bytes32)");
const BURN_REQUESTED = eventTopic("BurnRequested(uint256,address,address,uint256,bytes32)");
const topic = (v: bigint | string): Hex => `0x${BigInt(v).toString(16).padStart(64, "0")}`;
/** How the README shortens a 32-byte value: `0x91148935…6c514f61`. */
const shortOf = (h: string): string => `\`${h.slice(0, 10)}…${h.slice(-8)}\``;

const ROLLUP_LOCKS: readonly (readonly [DestKey, number])[] = [
  ["base-sepolia", 4],
  ["arbitrum-sepolia", 5],
];
const OTHER: Record<string, DestKey> = { "base-sepolia": "arbitrum-sepolia", "arbitrum-sepolia": "base-sepolia" };

/** A lock as the V3 record holds it: its vault nonce, destination, recipient, amount and the commitment the vault stored. */
const lockOf = (n: number): any => V3.locks.find((l: any) => l.vaultNonce === String(n) && l.status === "locked");

/** Its Locked log, as the vault emits it: nonce, sender and recipient indexed; the chain, the minter, the amount and the commitment as data. */
function lockedLog(l: any): ReceiptLog {
  return {
    address: l.vault,
    topics: [LOCKED, topic(l.vaultNonce), topic(l.from), topic(l.recipient)],
    data: enc("uint256,address,uint256,bytes32", [BigInt(l.dstChainId), l.dstMinter, BigInt(l.amountNative), l.commitment]),
  };
}

/** The proof planner's view of a destination, as the sends hand it over (sends.ts, planEnv): what lockRefOf reads. */
function planEnvOf(key: DestKey): ProofEnv {
  const d = destOf(key);
  return {
    sepolia: [...d.rpcs],
    v3: undefined as unknown as SubstrateClient,
    lightClient: d.lightClient,
    minter: deployed(d).minter,
    vault: VAULT,
    multicall: "0xca11bde05977b3631167028862be2a173976ca11",
    v3ChainId: V3_CHAIN_ID,
    sepoliaChainId: BigInt(d.chainId),
    registry,
    l1: d.l1,
    chain: d.short,
  };
}

test("lock 4 and lock 5: the app recomputes the commitments the vault stored, from each lock's fields and its own config of the rollup it names", () => {
  for (const [key, n] of ROLLUP_LOCKS) {
    const l = lockOf(n);
    assert.ok(l, `lock ${n} is recorded`);
    const d = destOf(key);
    const { minter } = deployed(d);
    // The lock names the rollup by chain id and minter, and the app's config finds that destination from them.
    assert.equal(l.dstChainId, String(d.chainId), key);
    assert.equal(l.dstMinter.toLowerCase(), minter, key);
    assert.equal(destOfLock(l.dstChainId, l.dstMinter)?.key, key);
    const commitment = lockCommitment({ v3ChainId: V3_CHAIN_ID, vault: VAULT, dstChainId: BigInt(d.chainId), minter, recipient: l.recipient, amountNative: BigInt(l.amountNative), nonce: BigInt(n) });
    assert.equal(commitment, l.commitment, `lock ${n}'s commitment`);
    assert.equal(commitment, l.expected.commitment, `lock ${n}'s expected commitment`);
    assert.ok(README.includes(shortOf(commitment)), `the README names lock ${n}'s commitment ${shortOf(commitment)}`);
    // The same fields for the other rollup, or for Sepolia, give another word: a lock mints on one chain only.
    const other = destOf(OTHER[key]!);
    assert.notEqual(lockCommitment({ v3ChainId: V3_CHAIN_ID, vault: VAULT, dstChainId: BigInt(other.chainId), minter, recipient: l.recipient, amountNative: BigInt(l.amountNative), nonce: BigInt(n) }), commitment);
    const sep = destOf("sepolia");
    assert.notEqual(lockCommitment({ v3ChainId: V3_CHAIN_ID, vault: VAULT, dstChainId: BigInt(sep.chainId), minter: deployed(sep).minter, recipient: l.recipient, amountNative: BigInt(l.amountNative), nonce: BigInt(n) }), commitment);
  }
  // The two commitments the README records, in order.
  assert.equal(lockOf(4).commitment, "0x911489350293bf3f3d029c18a41148225eda61d272d4dd829b92a41d6c514f61");
  assert.equal(lockOf(5).commitment, "0x636ef291c881c6839ace1d82bfb896a8f8c5322154c31d7e9cde9142e540beb9");
});

test("lock 4's and lock 5's receipts check out as the sends check a lock to that rollup, and only to that rollup", () => {
  for (const [key, n] of ROLLUP_LOCKS) {
    const l = lockOf(n);
    const d = destOf(key);
    const expect = { vault: VAULT, v3ChainId: V3_CHAIN_ID, dstChainId: BigInt(d.chainId), minter: deployed(d).minter, sender: l.from, recipient: l.recipient, amount: BigInt(l.amountNative) };
    const r = lockedOf([lockedLog(l)], registry, expect);
    assert.ok(r.ok, r.ok ? "" : r.why);
    assert.equal(r.nonce, BigInt(n));
    assert.equal(r.commitment, l.commitment);
    // A transfer started for the other rollup (the same minter address) or for Sepolia refuses this receipt.
    const other = destOf(OTHER[key]!);
    const wrong = lockedOf([lockedLog(l)], registry, { ...expect, dstChainId: BigInt(other.chainId) });
    assert.ok(!wrong.ok && /another chain or minter/.test(wrong.why));
    const sep = lockedOf([lockedLog(l)], registry, { ...expect, dstChainId: 11_155_111n, minter: deployed(destOf("sepolia")).minter });
    assert.ok(!sep.ok && /another chain or minter/.test(sep.why));
  }
});

test("both wallet paths name the rollup in the lock's calldata: lock(84532 or 421614, BridgeMinter, recipient)", () => {
  for (const [key, n] of ROLLUP_LOCKS) {
    const l = lockOf(n);
    const d = destOf(key);
    // An Ethereum wallet's lock on V3's EVM side (preflight.ts, prepareLock) and a Polkadot wallet's revive.call (substrate/call.ts).
    const evm = encodeCall("lock(uint256,address,address)", [BigInt(d.chainId), deployed(d).minter, l.recipient]);
    assert.equal(lockData(BigInt(d.chainId), deployed(d).minter, l.recipient), evm);
    assert.equal(BigInt(`0x${evm.slice(10, 74)}`), BigInt(l.dstChainId));
    assert.equal(`0x${evm.slice(98, 138)}`, l.dstMinter.toLowerCase());
  }
});

test("the proof planner takes lock 4 as Base Sepolia's to mint and lock 5 as Arbitrum Sepolia's, and neither as the other's", () => {
  for (const [key, n] of ROLLUP_LOCKS) {
    const l = lockOf(n);
    const locked = lockedLog(l);
    const log = { ...locked, topics: [...locked.topics], blockNumber: `0x${Number(l.block.number).toString(16)}` };
    const ref = lockRefOf(log, planEnvOf(key));
    assert.deepEqual(ref, { nonce: BigInt(n), block: l.block.number, amount: BigInt(l.amountNative), recipient: l.recipient, commitment: l.commitment });
    assert.equal(lockRefOf(log, planEnvOf(OTHER[key]!)), null);
    assert.equal(lockRefOf(log, planEnvOf("sepolia")), null);
  }
  // The pages go by lock-4 and lock-5: one count of locks for every chain.
  assert.deepEqual(refOf(lockKey(4)), { dir: "in", n: 4 });
});

test("burn 0 on each rollup: the app recomputes the burn id the committee released, each with its own chain id, and checks the burn's receipt", () => {
  const sepoliaBurn0 = readJson("deployments/sepolia-bridge.json").steps.find((s: any) => s.kind === "burn" && s.burn.burnNonce === "0").burn.burnId;
  const ids = new Set<string>([sepoliaBurn0]);
  for (const key of ["base-sepolia", "arbitrum-sepolia"] as const) {
    const d = destOf(key);
    const { minter } = deployed(d);
    const step = readJson(`deployments/${key}-bridge.json`).steps.find((s: any) => s.kind === "burn" && s.burn.burnNonce === "0");
    assert.ok(step, `${key}: burn 0 is recorded`);
    const id = burnId(BigInt(d.chainId), minter, 0n);
    assert.equal(id, step.burn.burnId, `${key}: burn 0's id`);
    assert.equal(id, step.burn.expected.burnId, `${key}: burn 0's expected id`);
    assert.ok(README.includes(shortOf(id)), `the README names ${key}'s burn 0 ${shortOf(id)}`);
    ids.add(id);
    // The committee released it on V3 by that id, for that chain and minter.
    const rel = V3.releases.find((r: any) => r.burn.chainId === String(d.chainId) && r.burn.burnNonce === "0");
    assert.equal(rel?.status, "released");
    assert.equal(rel?.burn.burnId, id);
    assert.equal(rel?.burn.minter, minter);
    // As the sends check the burn's receipt (txmath.ts, burnedOf): its BurnRequested log, its id recomputed with the chain's id.
    const log: ReceiptLog = {
      address: minter,
      topics: [BURN_REQUESTED, topic(0n), topic(step.sender), topic(step.burn.v3Recipient)],
      data: enc("uint256,bytes32", [BigInt(step.burn.amount), step.burn.burnId]),
    };
    const r = burnedOf([log], registry, { minter, chainId: BigInt(d.chainId), sender: step.sender, amount: BigInt(step.burn.amount) });
    assert.ok(r.ok, r.ok ? "" : r.why);
    assert.equal(r.burnNonce, 0n);
    assert.equal(r.burnId, id);
    // The same log taken for the other rollup's burn 0 (the same minter address) does not check out.
    const other = destOf(OTHER[key]!);
    const wrong = burnedOf([log], registry, { minter, chainId: BigInt(other.chainId), sender: step.sender, amount: BigInt(step.burn.amount) });
    assert.ok(!wrong.ok && /burn id is/.test(wrong.why));
    // Its page: burn-base-sepolia-0, never Sepolia's burn-0.
    assert.equal(burnKey(key, 0), `burn-${key}-0`);
    assert.deepEqual(refOf(burnKey(key, 0)), { dir: "back", n: 0, dest: key });
  }
  // Three burns numbered 0, three ids: the vault's released[burnId] pays each once.
  assert.equal(ids.size, 3);
  assert.equal(burnId(84_532n, deployed(destOf("base-sepolia")).minter, 0n), "0x6ae40d53f7c3d1156db402387484ed10011948fca8a2dfedd2b25eabbedb6d8d");
  assert.equal(burnId(421_614n, deployed(destOf("arbitrum-sepolia")).minter, 0n), "0x9890de419e811a71bd9e8f16963d616b7f746ec284d8ce03813d2508cfe80522");
});
