// The calldata the proof core builds: the cast vectors of the relayer's tests, the recorded mints
// and set-change import rebuilt byte for byte (their keccak-256 is what the records hold), viem's
// encoder as a second opinion, and Multicall3's aggregate3 both ways.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, parseAbi, type Hex as ViemHex } from "viem";
import { decodeImportCall } from "../src/lib/calls.ts";
import { keccak256 } from "../src/lib/hashes.ts";
import { bytesToHex, hexToBytes } from "../src/lib/hex.ts";
import {
  abiEncode,
  aggregate3Calldata,
  decodeAggregate3,
  importAndMintCalldata,
  importHeaderCalldata,
  MINT_SIG,
  mintCalldata,
  MULTICALL3,
  type LockProof,
} from "../src/lib/proof/calldata.ts";
import { clientCrypto, signersHint } from "../src/lib/proof/grandpa.ts";
import { decodeJustification } from "../src/lib/proof/scale.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const read = (path: string) => JSON.parse(readFileSync(join(repo, path), "utf8"));
const crypto = clientCrypto(ed25519, sha512);
const bridge = read("deployments/sepolia-bridge.json");
const sepolia = read("deployments/sepolia.json");
const recorded = (steps: { name: string; dataHash: string }[], name: string) => steps.find((s) => s.name === name)?.dataHash;

const ABI = parseAbi([
  "function importAndMint(bytes header, bytes finalityProof, bytes signers, (bytes32 blockHash, bytes[] accountProof, bytes[] childRootProof, bytes[] slotProof, address recipient, uint256 amount, uint256 nonce) p)",
  "function mint((bytes32 blockHash, bytes[] accountProof, bytes[] childRootProof, bytes[] slotProof, address recipient, uint256 amount, uint256 nonce) p)",
  "function importHeader(bytes header, bytes justification, bytes signers) returns (bytes32)",
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);

/** A bundle's LockProof, its account proof as recorded or left out (the minter is bound now). */
function proofOf(b: Record<string, any>, account = true): LockProof {
  return {
    blockHash: hexToBytes(b.header.hash),
    accountProof: account ? b.account.proof.nodes.map((x: string) => hexToBytes(x)) : [],
    childRootProof: b.childRoot.proof.nodes.map((x: string) => hexToBytes(x)),
    slotProof: b.slot.proof.nodes.map((x: string) => hexToBytes(x)),
    recipient: hexToBytes(b.lock.recipient),
    amount: BigInt(b.lock.amountNative),
    nonce: BigInt(b.lock.nonce),
  };
}

const viemTuple = (p: LockProof) => ({
  blockHash: bytesToHex(p.blockHash) as ViemHex,
  accountProof: p.accountProof.map((x) => bytesToHex(x) as ViemHex),
  childRootProof: p.childRootProof.map((x) => bytesToHex(x) as ViemHex),
  slotProof: p.slotProof.map((x) => bytesToHex(x) as ViemHex),
  recipient: bytesToHex(p.recipient) as ViemHex,
  amount: p.amount,
  nonce: p.nonce,
});

test("mint and importAndMint encode the LockProof struct as cast does (the relayer's vectors)", () => {
  const p: LockProof = {
    blockHash: hexToBytes(`0x${"11".repeat(32)}`),
    accountProof: [hexToBytes("0xaa")],
    childRootProof: [],
    slotProof: [hexToBytes("0xbbcc"), hexToBytes("0xdd")],
    recipient: hexToBytes(`0x${"22".repeat(20)}`),
    amount: 5n,
    nonce: 7n,
  };
  const tail =
    "0000000000000000000000000000000000000000000000000000000000000020" +
    "1111111111111111111111111111111111111111111111111111111111111111" +
    "00000000000000000000000000000000000000000000000000000000000000e0" +
    "0000000000000000000000000000000000000000000000000000000000000160" +
    "0000000000000000000000000000000000000000000000000000000000000180" +
    "0000000000000000000000002222222222222222222222222222222222222222" +
    "0000000000000000000000000000000000000000000000000000000000000005" +
    "0000000000000000000000000000000000000000000000000000000000000007" +
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000000000000000000000000000000000000000000020" +
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "aa00000000000000000000000000000000000000000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000002" +
    "0000000000000000000000000000000000000000000000000000000000000040" +
    "0000000000000000000000000000000000000000000000000000000000000080" +
    "0000000000000000000000000000000000000000000000000000000000000002" +
    "bbcc000000000000000000000000000000000000000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "dd00000000000000000000000000000000000000000000000000000000000000";
  assert.equal(bytesToHex(mintCalldata(p)), `0x97379043${tail}`);
  assert.equal(
    bytesToHex(importAndMintCalldata(hexToBytes("0x01"), hexToBytes("0x0203"), new Uint8Array(0), p)),
    "0x9bf20ea3" +
      "0000000000000000000000000000000000000000000000000000000000000080" +
      "00000000000000000000000000000000000000000000000000000000000000c0" +
      "0000000000000000000000000000000000000000000000000000000000000100" +
      "0000000000000000000000000000000000000000000000000000000000000120" +
      "0000000000000000000000000000000000000000000000000000000000000001" +
      "0100000000000000000000000000000000000000000000000000000000000000" +
      "0000000000000000000000000000000000000000000000000000000000000002" +
      "0203000000000000000000000000000000000000000000000000000000000000" +
      "0000000000000000000000000000000000000000000000000000000000000000" +
      tail.slice(64),
  );
  assert.equal(MINT_SIG, "mint((bytes32,bytes[],bytes[],bytes[],address,uint256,uint256))");
  assert.throws(() => abiEncode([{ word: new Uint8Array(31) }]), /32 bytes/);
});

for (const [dir, name, bytes] of [
  ["v3-testnet-lock1", "importAndMint lock 1", 5_444],
  ["v3-testnet-hero", "importAndMint lock 0", null],
] as const) {
  test(`${name}: rebuilt from fixtures/${dir}, its keccak-256 is the dataHash the record holds`, () => {
    const b = read(`fixtures/${dir}/mint-bundle.json`);
    const j = decodeJustification(hexToBytes(b.justification.scale));
    const hint = signersHint(j, b.signingSet.authorities.map((a: { id: string }) => hexToBytes(a.id)), BigInt(b.signingSet.setId), crypto.verify).hint;
    const data = importAndMintCalldata(hexToBytes(b.header.scale), hexToBytes(b.finalityProof.scale), hint, proofOf(b));
    if (bytes !== null) assert.equal(data.length, bytes);
    assert.equal(bytesToHex(keccak256(data)), recorded(bridge.steps, name));
    // The status page's decoder reads it back.
    const d = decodeImportCall(bytesToHex(data));
    assert.equal(d.method, "importAndMint");
    assert.equal(d.signersHint, b.signers.hint);
    assert.equal(d.lockProof?.nonce, BigInt(b.lock.nonce));
    assert.deepEqual(d.lockProof?.slotProof, b.slot.proof.nodes);
  });
}

test("the V3 set change 19 -> 20 (README row 6): importHeader rebuilt from fixtures/v3-testnet, the record's dataHash", () => {
  const f = read("fixtures/v3-testnet/set-change.json");
  const j = decodeJustification(hexToBytes(f.justification.scale));
  const hint = signersHint(j, f.signingSet.authorities.map((a: { id: string }) => hexToBytes(a.id)), 19n, crypto.verify).hint;
  const data = importHeaderCalldata(hexToBytes(f.header.scale), hexToBytes(f.justification.scale), hint);
  assert.equal(bytesToHex(keccak256(data)), recorded(sepolia.steps, "#2 importHeader"));
  assert.equal(
    bytesToHex(data),
    encodeFunctionData({ abi: ABI, functionName: "importHeader", args: [f.header.scale, f.justification.scale, bytesToHex(hint) as ViemHex] }),
  );
});

test("viem encodes lock 1's mint and importAndMint the same, the account proof left out as the bound minter takes it", () => {
  const b = read("fixtures/v3-testnet-lock1/mint-bundle.json");
  const p = proofOf(b, false);
  assert.equal(bytesToHex(mintCalldata(p)), encodeFunctionData({ abi: ABI, functionName: "mint", args: [viemTuple(p)] }));
  const data = importAndMintCalldata(hexToBytes(b.header.scale), hexToBytes(b.finalityProof.scale), hexToBytes(b.signers.hint), p);
  assert.equal(bytesToHex(data), encodeFunctionData({ abi: ABI, functionName: "importAndMint", args: [b.header.scale, b.finalityProof.scale, b.signers.hint, viemTuple(p)] }));
  assert.equal(data.length, 3_364);
});

test("aggregate3: the calls in order, each target, allowFailure and calldata; its results decode", () => {
  const calls = [
    { target: "0x447171c4885Ad725eE4772E8e3c228aDeE50Dcb0", allowFailure: false, callData: hexToBytes("0xdff47f31aabb") },
    { target: "0x8287B3Baf205CA8456f98346F13064AA7fCDcB9E", allowFailure: true, callData: hexToBytes(`0x9bf20ea3${"01".repeat(70)}`) },
    { target: MULTICALL3, allowFailure: false, callData: new Uint8Array(0) },
  ];
  const data = bytesToHex(aggregate3Calldata(calls));
  assert.equal(data.slice(0, 10), "0x82ad56cb");
  assert.equal(data, encodeFunctionData({ abi: ABI, functionName: "aggregate3", args: [calls.map((c) => ({ target: c.target as ViemHex, allowFailure: c.allowFailure, callData: bytesToHex(c.callData) as ViemHex }))] }));
  const back = decodeFunctionData({ abi: ABI, data: data as ViemHex });
  assert.equal(back.functionName, "aggregate3");
  const results = encodeAbiParameters(
    [{ type: "tuple[]", components: [{ name: "success", type: "bool" }, { name: "returnData", type: "bytes" }] }],
    [[{ success: true, returnData: "0x00000000000000000000000000000000000000000000000000000000000000ff" }, { success: false, returnData: "0x91cab5040000000000000000000000000000000000000000000000000000000000000001" }]],
  );
  assert.deepEqual(decodeAggregate3(results), [
    { success: true, returnData: "0x00000000000000000000000000000000000000000000000000000000000000ff" },
    { success: false, returnData: "0x91cab5040000000000000000000000000000000000000000000000000000000000000001" },
  ]);
});
