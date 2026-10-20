// Bytes and hex strings.

import type { Hex } from "./records-types.ts";

export type { Hex };

const HEX = /^0x([0-9a-fA-F]{2})*$/;

export function isHex(s: unknown): s is Hex {
  return typeof s === "string" && HEX.test(s);
}

export function hexToBytes(h: string): Uint8Array {
  if (!isHex(h)) throw new TypeError(`not a hex string: ${h.slice(0, 20)}`);
  const out = new Uint8Array((h.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
}

export function bytesToHex(b: Uint8Array): Hex {
  let s = "0x";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s as Hex;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

export function u64le(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
}

export function leToBigInt(b: Uint8Array): bigint {
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i] ?? 0);
  return n;
}

/** A 32-byte big-endian word as a bigint. */
export function wordToBigInt(word: string): bigint {
  return BigInt("0x" + (word.replace(/^0x/, "") || "0"));
}

/** 0x1234…cdef: the first `head` and last `tail` hex digits. */
export function shortHex(h: string, head = 8, tail = 8): string {
  const body = h.replace(/^0x/, "");
  if (body.length <= head + tail + 1) return h;
  return `0x${body.slice(0, head)}…${body.slice(-tail)}`;
}

/** EIP-55 checksum casing for an address, given keccak-256. */
export function checksumAddress(address: string, keccak: (b: Uint8Array) => Uint8Array): string {
  const lower = address.toLowerCase().replace(/^0x/, "");
  const hash = bytesToHex(keccak(new TextEncoder().encode(lower))).slice(2);
  let out = "0x";
  for (let i = 0; i < lower.length; i++) {
    const c = lower[i] ?? "";
    out += parseInt(hash[i] ?? "0", 16) >= 8 ? c.toUpperCase() : c;
  }
  return out;
}
