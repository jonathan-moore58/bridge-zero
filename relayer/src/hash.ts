// Hashes used by Substrate: blake2b (block hashes, trie nodes, map keys) and twox128
// (storage prefixes). twox is xxHash64, implemented here from the published algorithm
// description (https://github.com/Cyan4973/xxHash/blob/dev/doc/xxhash_spec.md); it is not
// security-relevant, it only derives fixed storage keys.

import { blake2b } from "@noble/hashes/blake2.js";
import { concatBytes, u64le, utf8 } from "./bytes.js";

export function blake2_256(data: Uint8Array): Uint8Array {
  return blake2b(data, { dkLen: 32 });
}

export function blake2_128(data: Uint8Array): Uint8Array {
  return blake2b(data, { dkLen: 16 });
}

/** Substrate's Blake2_128Concat map hasher: blake2_128(data) ‖ data. */
export function blake2_128Concat(data: Uint8Array): Uint8Array {
  return concatBytes(blake2_128(data), data);
}

const MASK64 = (1n << 64n) - 1n;
const PRIME64_1 = 0x9e3779b185ebca87n;
const PRIME64_2 = 0xc2b2ae3d27d4eb4fn;
const PRIME64_3 = 0x165667b19e3779f9n;
const PRIME64_4 = 0x85ebca77c2b2ae63n;
const PRIME64_5 = 0x27d4eb2f165667c5n;

const add = (a: bigint, b: bigint): bigint => (a + b) & MASK64;
const mul = (a: bigint, b: bigint): bigint => (a * b) & MASK64;
const rotl = (x: bigint, r: bigint): bigint => ((x << r) | (x >> (64n - r))) & MASK64;

function round(acc: bigint, lane: bigint): bigint {
  return mul(rotl(add(acc, mul(lane, PRIME64_2)), 31n), PRIME64_1);
}

function mergeRound(acc: bigint, lane: bigint): bigint {
  return add(mul(acc ^ round(0n, lane), PRIME64_1), PRIME64_4);
}

/** xxHash64 of `input` with a 64-bit seed. */
export function xxhash64(input: Uint8Array, seed: bigint): bigint {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const length = input.length;
  let p = 0;
  let h: bigint;

  if (length >= 32) {
    let v1 = add(add(seed, PRIME64_1), PRIME64_2);
    let v2 = add(seed, PRIME64_2);
    let v3 = seed & MASK64;
    let v4 = (seed - PRIME64_1) & MASK64;
    while (p + 32 <= length) {
      v1 = round(v1, view.getBigUint64(p, true));
      v2 = round(v2, view.getBigUint64(p + 8, true));
      v3 = round(v3, view.getBigUint64(p + 16, true));
      v4 = round(v4, view.getBigUint64(p + 24, true));
      p += 32;
    }
    h = add(add(add(rotl(v1, 1n), rotl(v2, 7n)), rotl(v3, 12n)), rotl(v4, 18n));
    h = mergeRound(h, v1);
    h = mergeRound(h, v2);
    h = mergeRound(h, v3);
    h = mergeRound(h, v4);
  } else {
    h = add(seed, PRIME64_5);
  }

  h = add(h, BigInt(length));
  while (p + 8 <= length) {
    h ^= round(0n, view.getBigUint64(p, true));
    h = add(mul(rotl(h, 27n), PRIME64_1), PRIME64_4);
    p += 8;
  }
  if (p + 4 <= length) {
    h ^= mul(BigInt(view.getUint32(p, true)), PRIME64_1);
    h = add(mul(rotl(h, 23n), PRIME64_2), PRIME64_3);
    p += 4;
  }
  while (p < length) {
    h ^= mul(BigInt(input[p]), PRIME64_5);
    h = mul(rotl(h, 11n), PRIME64_1);
    p += 1;
  }

  h ^= h >> 33n;
  h = mul(h, PRIME64_2);
  h ^= h >> 29n;
  h = mul(h, PRIME64_3);
  h ^= h >> 32n;
  return h;
}

/** Substrate's twox128: xxHash64 with seeds 0 and 1, each written little-endian. */
export function twox128(data: Uint8Array | string): Uint8Array {
  const bytes = typeof data === "string" ? utf8(data) : data;
  return concatBytes(u64le(xxhash64(bytes, 0n)), u64le(xxhash64(bytes, 1n)));
}

/** Storage prefix of a plain storage item: twox128(pallet) ‖ twox128(item). */
export function storageKey(pallet: string, item: string): Uint8Array {
  return concatBytes(twox128(pallet), twox128(item));
}

/** System.Account(accountId): prefix ‖ blake2_128Concat(accountId), 80 bytes. */
export function systemAccountKey(accountId: Uint8Array): Uint8Array {
  if (accountId.length !== 32) throw new Error(`account id must be 32 bytes, got ${accountId.length}`);
  return concatBytes(storageKey("System", "Account"), blake2_128Concat(accountId));
}

/** Well-known key holding the GRANDPA authority list in runtimes of this age. */
export const GRANDPA_AUTHORITIES_KEY = utf8(":grandpa_authorities");
