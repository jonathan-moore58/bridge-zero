// The three hashes the bridge uses: keccak-256 (Ethereum, the commitment and the slot index),
// blake2b-256 (Substrate: block hashes, trie keys) and blake2b-512 (SS58 checksums).

import { blake2b } from "@noble/hashes/blake2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, type Hex } from "./hex.ts";

export function keccak256(data: Uint8Array): Uint8Array {
  return keccak_256(data);
}

export function blake2b256(data: Uint8Array): Uint8Array {
  return blake2b(data, { dkLen: 32 });
}

export function blake2b512(data: Uint8Array): Uint8Array {
  return blake2b(data, { dkLen: 64 });
}

/** The 4-byte selector of a canonical signature, e.g. "used(uint256)". */
export function selector(signature: string): Hex {
  return bytesToHex(keccak256(new TextEncoder().encode(signature)).subarray(0, 4));
}

/** The topic of a canonical event signature. */
export function eventTopic(signature: string): Hex {
  return bytesToHex(keccak256(new TextEncoder().encode(signature)));
}
