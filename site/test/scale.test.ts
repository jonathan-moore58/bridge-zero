// GRANDPA decoding: the signers hint, the finality proof and header of the hero bundle, and the
// calldata of a light-client import and of the mint, down to signatures that verify.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeImportCall } from "../src/lib/calls.ts";
import { hexToBytes } from "../src/lib/hex.ts";
import { headerHash } from "../src/lib/proofs.ts";
import { decodeFinalityProof, decodeHeader, decodeSigners, decodeTimestampInherent, precommitPayload, ScaleError } from "../src/lib/scale.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const bundle = JSON.parse(readFileSync(join(repo, "fixtures", "v3-testnet-hero", "mint-bundle.json"), "utf8"));
const hero = JSON.parse(readFileSync(join(here, "fixtures", "hero-mint.json"), "utf8"));
const head = JSON.parse(readFileSync(join(here, "fixtures", "mainnet-head-import.json"), "utf8"));

test("the signers hint is 2 bytes per counted precommit: position, then authority index", () => {
  assert.deepEqual(decodeSigners("0x01000001"), [
    { position: 1, authorityIndex: 0 },
    { position: 0, authorityIndex: 1 },
  ]);
  assert.deepEqual(
    decodeSigners("0x0701060201030404000503070208").map((s) => s.authorityIndex),
    [1, 2, 3, 4, 5, 7, 8],
  );
  assert.throws(() => decodeSigners("0x010000"), ScaleError);
});

test("the hero bundle's header hashes to its block hash and decodes", () => {
  const h = bundle.header;
  assert.equal(headerHash(h.scale), h.hash);
  const d = decodeHeader(h.scale);
  assert.equal(d.number, 108424);
  assert.equal(d.parentHash, h.parentHash);
  assert.equal(d.stateRoot, h.stateRoot);
  assert.equal(d.extrinsicsRoot, h.extrinsicsRoot);
});

test("the hero bundle's finality proof decodes, and both signatures verify over the 53-byte message", () => {
  const fp = decodeFinalityProof(bundle.finalityProof.scale);
  assert.equal(fp.block, bundle.header.hash);
  assert.equal(fp.unknownHeaders, 0);
  const j = fp.justification;
  assert.equal(j.round, BigInt(bundle.justification.round));
  assert.equal(j.targetNumber, 108424);
  assert.equal(j.precommits.length, 2);
  for (const [i, pc] of j.precommits.entries()) {
    const rec = bundle.justification.precommits[i];
    assert.equal(pc.id, rec.authorityId);
    assert.equal(pc.signature, rec.signature);
    const msg = precommitPayload(pc.targetHash, pc.targetNumber, j.round, BigInt(bundle.signingSet.setId));
    assert.equal(msg.length, 53);
    assert.equal(msg[0], 1);
    assert.ok(ed25519.verify(hexToBytes(pc.signature), msg, hexToBytes(pc.id)), `precommit ${i}`);
    // The same signature under the next set id does not verify.
    const other = precommitPayload(pc.targetHash, pc.targetNumber, j.round, BigInt(bundle.signingSet.setId) + 1n);
    assert.equal(ed25519.verify(hexToBytes(pc.signature), other, hexToBytes(pc.id)), false);
  }
});

test("the mint's calldata decodes to the bundle it was built from", () => {
  const d = decodeImportCall(hero.input);
  assert.equal(d.method, "importAndMint");
  assert.equal(d.signersHint, bundle.signers.hint);
  assert.equal(d.headerFields.number, 108424);
  assert.equal(d.justification.precommits.length, 2);
  assert.ok(d.lockProof);
  assert.equal(d.lockProof.blockHash, bundle.header.hash);
  assert.equal(d.lockProof.recipient, bundle.lock.recipient);
  assert.equal(d.lockProof.amount, BigInt(bundle.lock.amountNative));
  assert.equal(d.lockProof.nonce, 0n);
  assert.equal(d.lockProof.accountProof.length, bundle.account.proof.count);
  assert.equal(d.lockProof.childRootProof.length, bundle.childRoot.proof.count);
  assert.equal(d.lockProof.slotProof.length, bundle.slot.proof.count);
});

test("an old-mainnet head import decodes to 7 counted signatures that verify under set 3907", () => {
  const d = decodeImportCall(head.input);
  assert.equal(d.method, "importFinalityProof");
  assert.equal(d.headerFields.number, 2734439);
  assert.equal(d.signers.length, 7);
  assert.ok(d.justification.precommits.length >= 7);
  for (const s of d.signers) {
    const pc = d.justification.precommits[s.position];
    assert.ok(pc);
    const msg = precommitPayload(pc.targetHash, pc.targetNumber, d.justification.round, 3907n);
    assert.ok(ed25519.verify(hexToBytes(pc.signature), msg, hexToBytes(pc.id)), `authority ${s.authorityIndex}`);
  }
  assert.throws(() => decodeImportCall("0x12345678" + "00".repeat(64)));
});

test("a block's Timestamp.set inherent reads as its time: V3 #118,636, lock 1's block", () => {
  // The first extrinsic of V3 block #118,636 (0x0c4cded3…dc03d814, the parent of lock 1's bundle
  // block), as chain_getBlock returned it on Oct 20: length 10, bare v5, call 3.0, compact now.
  const t = decodeTimestampInherent("0x280503000b8062c659a101");
  assert.equal(t.version, 5);
  assert.deepEqual([t.pallet, t.call], [3, 0]);
  assert.equal(new Date(Number(t.moment)).toISOString(), "2026-10-20T14:45:36.000Z");
  // A v4 inherent with a 4-byte compact reads the same way.
  assert.equal(decodeTimestampInherent("0x1c04030002093d00").moment, 1000000n);
  assert.throws(() => decodeTimestampInherent("0x290503000b8062c659a101"), ScaleError, "a length prefix that does not match");
  assert.throws(() => decodeTimestampInherent("0x288503000b8062c659a101"), ScaleError, "a signed extrinsic");
  assert.throws(() => decodeTimestampInherent("0x2c0503000b8062c659a10100"), ScaleError, "trailing bytes");
});
