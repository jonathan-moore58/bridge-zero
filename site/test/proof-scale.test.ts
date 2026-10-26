// The proof core's SCALE: compact integers, headers with their digest, GRANDPA logs, justifications
// and finality proofs, checked on the captured V3 bundles and set change, byte for byte.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { blake2b256 } from "../src/lib/hashes.ts";
import { bytesToHex, hexToBytes } from "../src/lib/hex.ts";
import {
  decodeAuthorityList,
  decodeFinalityProof,
  decodeHeader,
  decodeJustification,
  decodeU64,
  encodeCompact,
  encodeFinalityProof,
  encodeRpcHeader,
  grandpaLogs,
  Reader,
  ScaleError,
} from "../src/lib/proof/scale.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const read = (path: string) => JSON.parse(readFileSync(join(repo, path), "utf8"));
const lock1 = read("fixtures/v3-testnet-lock1/mint-bundle.json");
const change = read("fixtures/v3-testnet/set-change.json");

/** A fixture header as chain_getHeader returns it: the digest items as SCALE hex. */
const rpcHeader = (h: { parentHash: string; number: number; stateRoot: string; extrinsicsRoot: string; digest: { scale: string }[] }) => ({
  parentHash: h.parentHash,
  number: `0x${h.number.toString(16)}`,
  stateRoot: h.stateRoot,
  extrinsicsRoot: h.extrinsicsRoot,
  digest: { logs: h.digest.map((d) => d.scale) },
});

test("compact integers round-trip at every width, and non-canonical ones are refused", () => {
  for (const v of [0n, 1n, 63n, 64n, 16_383n, 16_384n, (1n << 30n) - 1n, 1n << 30n, 1n << 32n, (1n << 64n) - 1n, 1n << 100n]) {
    const r = new Reader(encodeCompact(v));
    assert.equal(r.compact(), v);
    r.end("compact");
  }
  assert.equal(bytesToHex(encodeCompact(118_637)), "0xb63d0700"); // as in lock 1's header
  assert.throws(() => new Reader(hexToBytes("0x0100")).compact(), ScaleError); // 0 in the two-byte form
  assert.throws(() => new Reader(hexToBytes("0x02000000")).compact(), ScaleError); // 0 in the four-byte form
  assert.throws(() => new Reader(hexToBytes("0x030000000000")).compact(), ScaleError); // a big form with a zero top byte
  assert.throws(() => new Reader(hexToBytes("0x08")).length(), ScaleError); // a length past the end
});

test("lock 1's header decodes, re-encodes from chain_getHeader's form and hashes to its block hash", () => {
  const h = decodeHeader(hexToBytes(lock1.header.scale));
  assert.equal(h.number, 118_637);
  assert.equal(bytesToHex(h.parentHash), lock1.header.parentHash);
  assert.equal(bytesToHex(h.stateRoot), lock1.header.stateRoot);
  assert.deepEqual(
    h.digest.map((d) => [d.kind, d.engine]),
    [
      ["PreRuntime", "BABE"],
      ["Consensus", "BEEF"],
      ["Seal", "BABE"],
    ],
  );
  assert.equal(bytesToHex(blake2b256(h.encoded)), lock1.header.hash);
  assert.equal(bytesToHex(encodeRpcHeader(rpcHeader(lock1.header))), lock1.header.scale);
  assert.equal(grandpaLogs(h).length, 0);
  assert.throws(() => decodeHeader(hexToBytes(lock1.header.scale + "00")), ScaleError);
});

test("the set change at V3 #71,539 carries one ScheduledChange, delay 0, to the two keys", () => {
  const h = decodeHeader(hexToBytes(change.header.scale));
  assert.equal(bytesToHex(blake2b256(h.encoded)), change.header.hash);
  const logs = grandpaLogs(h);
  assert.equal(logs.length, 1);
  const l = logs[0];
  assert.ok(l && l.kind === "ScheduledChange");
  assert.equal(l.delay, 0);
  assert.deepEqual(
    l.nextAuthorities.map((a) => [bytesToHex(a.id), a.weight]),
    change.scheduledChange.nextAuthorities.map((a: { id: string; weight: number }) => [a.id, BigInt(a.weight)]),
  );
});

test("lock 1's finality proof: block, justification, no unknown headers, and the same bytes built back", () => {
  const scale = hexToBytes(lock1.finalityProof.scale);
  const p = decodeFinalityProof(scale);
  assert.equal(bytesToHex(p.block), lock1.header.hash);
  assert.equal(p.unknownHeaders.length, 0);
  assert.equal(bytesToHex(p.justification), lock1.justification.scale);
  assert.equal(bytesToHex(encodeFinalityProof(p.block, p.justification)), lock1.finalityProof.scale);
  const j = decodeJustification(p.justification);
  assert.equal(j.round, 2319n);
  assert.equal(j.targetNumber, 118_637);
  assert.equal(bytesToHex(j.targetHash), lock1.header.hash);
  assert.equal(j.precommits.length, 2);
  assert.equal(j.votesAncestries.length, 0);
  assert.throws(() => decodeJustification(hexToBytes(lock1.justification.scale + "00")), ScaleError);
  assert.throws(() => encodeFinalityProof(new Uint8Array(31), p.justification), ScaleError);
});

test("the signing set's runtime call and set id decode", () => {
  const list = decodeAuthorityList(hexToBytes(lock1.signingSet.runtimeCall.scale));
  assert.deepEqual(
    list.map((a) => [bytesToHex(a.id), a.weight]),
    lock1.signingSet.authorities.map((a: { id: string; weight: number }) => [a.id, BigInt(a.weight)]),
  );
  assert.equal(decodeU64(hexToBytes(lock1.signingSet.setIdStorage.scale), "Grandpa.CurrentSetId"), 33n);
  assert.throws(() => decodeU64(hexToBytes("0x2100"), "Grandpa.CurrentSetId"), ScaleError);
});
