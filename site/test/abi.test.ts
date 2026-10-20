// The ABI codec: selectors, view-call results, revert data and logs, checked against what the
// chain returned for the bridge's own transactions.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AbiError, AbiRegistry, decode, encodeCall, formatError } from "../src/lib/abi.ts";
import { eventTopic, selector } from "../src/lib/hashes.ts";
import { parseAbi } from "../build/records.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const abi = parseAbi(join(repo, "contracts", "src"));
const registry = new AbiRegistry(abi.errors, abi.events);
const bridge = JSON.parse(readFileSync(join(repo, "deployments", "sepolia-bridge.json"), "utf8"));
const hero = JSON.parse(readFileSync(join(here, "fixtures", "hero-mint.json"), "utf8"));

test("selectors match cast sig", () => {
  assert.equal(selector("importAndMint(bytes,bytes,bytes,(bytes32,bytes[],bytes[],bytes[],address,uint256,uint256))"), "0x9bf20ea3");
  assert.equal(selector("importHeader(bytes,bytes,bytes)"), "0xdff47f31");
  assert.equal(selector("importFinalityProof(bytes,bytes,bytes)"), "0xf6d683a8");
  assert.equal(selector("currentSetId()"), "0xfba92a29");
  assert.equal(selector("latestFinalized()"), "0x6cdd45ae");
  assert.equal(selector("authorities(uint64)"), "0xcf812283");
  assert.equal(selector("used(uint256)"), "0x020fe6e5");
  assert.equal(selector("commitments(uint256)"), "0x49ce8997");
  assert.equal(eventTopic("HeaderImported(bytes32,uint32,bytes32,uint64,uint256)"), "0xcd7096bd8323fd78ac4c66260ac448b2e3c7a73dee4d157701a99c0c6b63ce0f");
  assert.equal(eventTopic("Locked(uint256,address,address,uint256,address,uint256,bytes32)"), "0x56431a42ac501689c7bf63a9cab5bc9a191019a6321793149852e1bbe6db157c");
});

test("the contract sources give every error and event the page decodes", () => {
  const errors = new Set(abi.errors.map((e) => e.name));
  for (const name of ["InvalidSignature", "FinalityProofBlockMismatch", "CommitmentMismatch", "NonceAlreadyUsed", "UnknownBlock", "NotNewer", "KeyNotPresent", "VaultNotBound"]) {
    assert.ok(errors.has(name), name);
  }
  const events = new Map(abi.events.map((e) => [e.name, e]));
  assert.deepEqual(
    events.get("HeaderImported")?.params.map((p) => [p.type, p.name, p.indexed]),
    [
      ["bytes32", "blockHash", true],
      ["uint32", "number", true],
      ["bytes32", "stateRoot", false],
      ["uint64", "setId", false],
      ["uint256", "signatures", false],
    ],
  );
  assert.equal(events.get("Halted")?.params[2]?.type, "uint8", "an enum parameter is a uint8 in the ABI");
});

test("encodeCall builds the view calls", () => {
  assert.equal(encodeCall("used(uint256)", [0n]), "0x020fe6e5" + "0".repeat(64));
  assert.equal(
    encodeCall("balanceOf(address)", ["0xD9838A86cF83C28Ee486544060D1cA4Ca2971071"]),
    "0x70a08231000000000000000000000000d9838a86cf83c28ee486544060d1ca4ca2971071",
  );
  assert.equal(encodeCall("authorities(uint64)", [3907n]), "0xcf812283" + (3907).toString(16).padStart(64, "0"));
  assert.throws(() => encodeCall("used(uint256)", []), AbiError);
});

test("decode reads static words, tuples and dynamic arrays", () => {
  const latest = "0x31a710c60cf68d426027f081dda3318f9b84bd779da51d61b253008efa06fa7d" + (116992).toString(16).padStart(64, "0");
  assert.deepEqual(decode("bytes32,uint32", latest), ["0x31a710c60cf68d426027f081dda3318f9b84bd779da51d61b253008efa06fa7d", 116992n]);
  const keys = ["0x" + "11".repeat(32), "0x" + "22".repeat(32)];
  const arr = "0x" + (32).toString(16).padStart(64, "0") + (2).toString(16).padStart(64, "0") + keys.map((k) => k.slice(2)).join("");
  assert.deepEqual(decode("bytes32[]", arr), [keys]);
  assert.deepEqual(decode("bool", "0x" + "0".repeat(63) + "1"), [true]);
  assert.throws(() => decode("bool", "0x" + "0".repeat(62) + "02"), AbiError);
  assert.throws(() => decode("uint32", "0x" + "f".repeat(64)), AbiError);
  assert.throws(() => decode("bytes32,uint32", latest.slice(0, 80)), AbiError, "a truncated answer is refused");
  assert.throws(() => decode("bytes", "0x" + (1000).toString(16).padStart(64, "0")), AbiError, "an offset past the end is refused");
});

test("every recorded revert decodes to the error the record names", () => {
  const expected: Record<string, string> = {
    signature: "InvalidSignature(i: 0, authorityIndex: 0)",
    header: "FinalityProofBlockMismatch(proofBlock: 0xc89b7e6c…761e4e6d, headerHash: 0xe26f5666…6626a17f)",
    proof: 'Error("Incomplete Proof!")',
    amount: "CommitmentMismatch(expected: 0xcd0e66fe…1248e426, found: 0x9eba08c9…41e23435)",
    recipient: "CommitmentMismatch(expected: 0xd0c88e8b…9eb88781, found: 0x9eba08c9…41e23435)",
    replay: "NonceAlreadyUsed(nonce: 0)",
  };
  const short = (h: string) => (h.length > 20 ? `${h.slice(0, 10)}…${h.slice(-8)}` : h);
  const steps = bridge.steps.filter((s: { kind: string }) => s.kind === "tamper" || s.kind === "replay");
  assert.equal(steps.length, 6);
  for (const s of steps) {
    const part = s.kind === "replay" ? "replay" : s.tamper.part;
    const d = registry.decodeError(s.expectedRevert.data);
    assert.ok(d, part);
    assert.equal(formatError(d, short), expected[part], part);
  }
  assert.equal(registry.decodeError("0x12345678"), null, "an unknown selector is not guessed");
  const panic = registry.decodeError("0x4e487b71" + (0x11).toString(16).padStart(64, "0"));
  assert.equal(panic?.name, "Panic");
});

test("the mint's receipt decodes to its four events", () => {
  const logs = hero.receipt.logs.map((l: { address: string; topics: string[]; data: string }) => registry.decodeLog(l));
  assert.deepEqual(
    logs.map((l: { name: string } | null) => l?.name),
    ["HeaderImported", "VaultBound", "Transfer", "Minted"],
  );
  const arg = (i: number, n: string) => logs[i].args.find((a: { name: string }) => a.name === n)?.value;
  assert.equal(arg(0, "blockHash"), "0xc89b7e6c5d7596897e677d464a9cc5ca373a69412f810d3f003d7aa8761e4e6d");
  assert.equal(arg(0, "number"), 108424n);
  assert.equal(arg(0, "setId"), 30n);
  assert.equal(arg(0, "signatures"), 2n);
  assert.equal(arg(1, "trieId"), "0xbe307c2d11dbc9391cda93d17e9772542d1300c9af14e7431918fb49e2f47c3a");
  assert.equal(arg(2, "from"), "0x0000000000000000000000000000000000000000");
  assert.equal(arg(2, "value"), 100000000000000n);
  assert.equal(arg(3, "nonce"), 0n);
  assert.equal(arg(3, "recipient"), "0xd9838a86cf83c28ee486544060d1ca4ca2971071");
  assert.equal(arg(3, "amount"), 100000000000000n);
});
