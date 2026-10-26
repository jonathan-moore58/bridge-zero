// The proof core's GRANDPA checks: the recorded justifications verify with the light client's own
// signature check and give the recorded signers hints; what the client refuses (a flipped byte,
// another set id or round, an R with a small-order part, a key it cannot use) is refused here too;
// and a header's authority change is judged as the client judges it.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, leToBigInt, u32le, u64le } from "../src/lib/hex.ts";
import { authorityChange, clientCrypto, loadClientCrypto, signersHint, SignatureError, threshold, verifyJustification } from "../src/lib/proof/grandpa.ts";
import { decodeHeader, decodeJustification, encodeCompact } from "../src/lib/proof/scale.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const read = (path: string) => JSON.parse(readFileSync(join(repo, path), "utf8"));
const crypto = clientCrypto(ed25519, sha512);
const keysOf = (set: { authorities: { id: string }[] }) => set.authorities.map((a) => hexToBytes(a.id));

test("threshold: N - floor((N - 1) / 3)", () => {
  assert.deepEqual([1, 2, 3, 4, 7, 10, 16].map(threshold), [1, 2, 3, 3, 5, 7, 11]);
  assert.throws(() => threshold(0), RangeError);
});

for (const dir of ["v3-testnet-mint", "v3-testnet-hero", "v3-testnet-lock1"]) {
  test(`${dir}: the justification verifies under its set and gives the recorded signers hint`, () => {
    const b = read(`fixtures/${dir}/mint-bundle.json`);
    const j = decodeJustification(hexToBytes(b.justification.scale));
    const setId = BigInt(b.signingSet.setId);
    const r = verifyJustification(j, keysOf(b.signingSet), setId, crypto.verify);
    assert.ok(r.ok, r.problems.join("; "));
    assert.equal(r.valid, 2);
    assert.equal(bytesToHex(signersHint(j, keysOf(b.signingSet), setId, crypto.verify).hint), b.signers.hint);
  });
}

test("the set change at V3 #71,539 verifies under set 19, and nothing verifies under set 20", () => {
  const f = read("fixtures/v3-testnet/set-change.json");
  const j = decodeJustification(hexToBytes(f.justification.scale));
  const keys = keysOf(f.signingSet);
  assert.equal(signersHint(j, keys, 19n, crypto.verify).counted.length, 2);
  assert.throws(() => signersHint(j, keys, 20n, crypto.verify), SignatureError);
});

test("a flipped signature byte, another set id, another round or another key is refused", () => {
  const b = read("fixtures/v3-testnet-lock1/mint-bundle.json");
  const j = decodeJustification(hexToBytes(b.justification.scale));
  const keys = keysOf(b.signingSet);
  const p0 = j.precommits[0]!;
  const sig = p0.signature.slice();
  sig[10] = (sig[10] ?? 0) ^ 1;
  const flipped = verifyJustification({ ...j, precommits: [{ ...p0, signature: sig }, ...j.precommits.slice(1)] }, keys, 33n, crypto.verify);
  assert.equal(flipped.precommits[0]?.problem, "invalid signature");
  assert.throws(() => signersHint({ ...j, precommits: [{ ...p0, signature: sig }, ...j.precommits.slice(1)] }, keys, 33n, crypto.verify), SignatureError);
  assert.equal(verifyJustification(j, keys, 34n, crypto.verify).valid, 0);
  assert.equal(verifyJustification({ ...j, round: j.round + 1n }, keys, 33n, crypto.verify).valid, 0);
  // With one key of the two, its own precommit alone meets that set's threshold (1 of 1); with a key that signed nothing, none does.
  assert.equal(signersHint(j, keys.slice(0, 1), 33n, crypto.verify).counted.length, 1);
  assert.throws(() => signersHint(j, [ed25519.Point.BASE.multiply(7n).toBytes()], 33n, crypto.verify), SignatureError);
});

test("the client's check is stricter than noble's: an R with a small-order part, s at or above L, a key equal to G", () => {
  const P = ed25519.Point;
  const L = P.Fn.ORDER;
  const le32 = (n: bigint) => {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = Number((n >> BigInt(8 * i)) & 0xffn);
    return out;
  };
  const message = new TextEncoder().encode("a precommit");
  const sign = (a: bigint, r: bigint, extra = P.ZERO) => {
    const A = P.BASE.multiply(a).toBytes();
    const R = P.BASE.multiply(r).add(extra).toBytes();
    const k = leToBigInt(sha512(concatBytes(R, A, message))) % L;
    return { A, sig: concatBytes(R, le32((r + k * a) % L)) };
  };
  const good = sign(123_456_789n, 987_654_321n);
  assert.ok(ed25519.verify(good.sig, message, good.A));
  assert.ok(crypto.verify(good.sig, message, good.A));
  // R + T, T of order 2: noble's cofactored check takes it, the client's does not.
  const small = sign(123_456_789n, 987_654_321n, P.fromAffine({ x: 0n, y: P.Fp.neg(1n) }));
  assert.ok(ed25519.verify(small.sig, message, small.A));
  assert.equal(crypto.verify(small.sig, message, small.A), false);
  // s + L encodes the same scalar mod L: the client refuses s >= L.
  const s = leToBigInt(good.sig.subarray(32));
  assert.equal(crypto.verify(concatBytes(good.sig.subarray(0, 32), le32(s + L)), message, good.A), false);
  // The key G (private scalar 1): a valid signature, but SCL cannot build its table for it.
  const g = sign(1n, 55n);
  assert.ok(ed25519.verify(g.sig, message, g.A));
  assert.equal(crypto.verify(g.sig, message, g.A), false);
  assert.equal(crypto.verify(good.sig.subarray(1), message, good.A), false);
  // Keys: a point of small order, and bytes that are no point, are unusable.
  assert.equal(crypto.usableKey(hexToBytes(`0x01${"00".repeat(31)}`)), false);
  assert.equal(crypto.usableKey(hexToBytes(`0x02${"00".repeat(31)}`)), false);
  assert.equal(crypto.usableKey(good.A), true);
});

test("loadClientCrypto loads noble on first use and gives the same check", async () => {
  const loaded = await loadClientCrypto();
  const b = read("fixtures/v3-testnet-lock1/mint-bundle.json");
  const j = decodeJustification(hexToBytes(b.justification.scale));
  assert.equal(bytesToHex(signersHint(j, keysOf(b.signingSet), 33n, loaded.verify).hint), "0x01000001");
  assert.equal(await loadClientCrypto(), loaded);
});

/** The set change's header with its digest replaced: parent hash, number, roots, then these items. */
function withDigest(items: Uint8Array[]): ReturnType<typeof decodeHeader> {
  const h = decodeHeader(hexToBytes(read("fixtures/v3-testnet/set-change.json").header.scale));
  return decodeHeader(concatBytes(h.parentHash, encodeCompact(h.number), h.stateRoot, h.extrinsicsRoot, encodeCompact(items.length), ...items));
}
const frnk = (payload: Uint8Array) => concatBytes(Uint8Array.of(4), new TextEncoder().encode("FRNK"), encodeCompact(payload.length), payload);
const authorities = (keys: Uint8Array[], weight = 1n) => concatBytes(encodeCompact(keys.length), ...keys.flatMap((k) => [k, u64le(weight)]));
const scheduled = (keys: Uint8Array[], delay = 0, weight = 1n) => frnk(concatBytes(Uint8Array.of(1), authorities(keys, weight), u32le(delay)));
const forced = (keys: Uint8Array[]) => frnk(concatBytes(Uint8Array.of(2), u32le(5), authorities(keys), u32le(0)));

test("an authority change is followed only as the client follows it", () => {
  const f = read("fixtures/v3-testnet/set-change.json");
  const keys = keysOf(f.signingSet);
  const real = authorityChange(decodeHeader(hexToBytes(f.header.scale)), crypto);
  assert.equal(real.kind, "follows");
  assert.deepEqual(real.kind === "follows" ? real.next.map(bytesToHex) : [], f.scheduledChange.nextAuthorities.map((a: { id: string }) => a.id));
  assert.equal(authorityChange(withDigest([]), crypto).kind, "none");
  assert.equal(authorityChange(withDigest([scheduled(keys)]), crypto).kind, "follows");
  const halts = (items: Uint8Array[]) => {
    const c = authorityChange(withDigest(items), crypto);
    return c.kind === "halts" ? c.reason : `not halted: ${c.kind}`;
  };
  assert.match(halts([scheduled(keys, 1)]), /DelayedChange/);
  assert.match(halts([forced(keys)]), /ForcedChange/);
  assert.match(halts([scheduled(keys), scheduled(keys)]), /MultipleChanges/);
  assert.match(halts([scheduled(keys, 0, 2n)]), /weight/);
  assert.match(halts([scheduled([])]), /0 keys/);
  assert.match(halts([scheduled(Array.from({ length: 17 }, () => keys[0]!))]), /17 keys/);
  assert.match(halts([scheduled([keys[0]!, keys[0]!])]), /duplicate/);
  assert.match(halts([scheduled([keys[0]!, hexToBytes(`0x01${"00".repeat(31)}`)])]), /key 1/);
  assert.match(halts([concatBytes(Uint8Array.of(2), new Uint8Array(32))]), /ChangesTrieRoot/);
});
