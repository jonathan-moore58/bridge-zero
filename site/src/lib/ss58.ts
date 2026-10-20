// SS58 addresses for 32-byte public keys: how Portaldot's tools show the validator keys.

import { blake2b512 } from "./hashes.ts";
import { concatBytes, hexToBytes } from "./hex.ts";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

/** The SS58 address of a 32-byte key, for a network prefix below 64 (Portaldot uses 42). */
export function ss58(key: string | Uint8Array, prefix = 42): string {
  const id = typeof key === "string" ? hexToBytes(key) : key;
  if (id.length !== 32) throw new RangeError(`an SS58 key is 32 bytes, got ${id.length}`);
  if (prefix < 0 || prefix > 63) throw new RangeError(`prefix ${prefix} needs the two-byte form`);
  const body = concatBytes(Uint8Array.of(prefix), id);
  const checksum = blake2b512(concatBytes(new TextEncoder().encode("SS58PRE"), body)).subarray(0, 2);
  return base58(concatBytes(body, checksum));
}
