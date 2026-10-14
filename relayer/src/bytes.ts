// Byte and hex helpers shared by the SCALE, trie and GRANDPA code.

export type Hex = `0x${string}`;

const HEX_DIGITS = /^[0-9a-fA-F]*$/;
const BYTE_TO_HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

/** Parses a hex string (with or without 0x) into bytes. Rejects odd lengths and non-hex digits. */
export function hexToBytes(hex: string): Uint8Array {
  const digits = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (digits.length % 2 !== 0) throw new Error(`hex string has an odd number of digits (${digits.length})`);
  if (!HEX_DIGITS.test(digits)) throw new Error(`not a hex string: ${hex.slice(0, 24)}...`);
  const out = new Uint8Array(digits.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(digits.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** Lower-case 0x-prefixed hex. */
export function bytesToHex(bytes: Uint8Array): Hex {
  let out = "0x";
  for (const b of bytes) out += BYTE_TO_HEX[b];
  return out as Hex;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function u32le(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError(`not a u32: ${value}`);
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

export function u64le(value: bigint): Uint8Array {
  if (value < 0n || value >= 1n << 64n) throw new RangeError(`not a u64: ${value}`);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

/** Little-endian unsigned integer of any width. */
export function leToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i]);
  return value;
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Converts a bigint to a JS number, refusing values a JSON number cannot hold exactly. */
export function toSafeNumber(value: bigint, what: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${what} out of safe integer range: ${value}`);
  return Number(value);
}

/** Copy of `bytes` with one byte XOR-ed, for tamper checks. */
export function flipByte(bytes: Uint8Array, index: number, mask = 0x01): Uint8Array {
  if (index < 0 || index >= bytes.length) throw new RangeError(`flip index ${index} outside 0..${bytes.length - 1}`);
  const out = bytes.slice();
  out[index] ^= mask;
  return out;
}

/** 0x1234…abcd, for log lines. */
export function shortHex(value: Uint8Array | string, keep = 4): string {
  const hex = typeof value === "string" ? value : bytesToHex(value);
  return hex.length <= 2 + 4 * keep ? hex : `${hex.slice(0, 2 + 2 * keep)}…${hex.slice(-2 * keep)}`;
}
