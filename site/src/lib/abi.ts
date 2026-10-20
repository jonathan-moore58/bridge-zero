// A small Solidity ABI codec: what the page needs to read view calls, receipts, revert data and
// the calldata of the bridge's transactions. Decoding checks every offset and length it follows.

import { eventTopic, selector } from "./hashes.ts";
import { bytesToHex, hexToBytes, type Hex } from "./hex.ts";
import type { AbiItem, AbiParam } from "./records-types.ts";

export type AbiType =
  | { kind: "uint"; bits: number }
  | { kind: "int"; bits: number }
  | { kind: "address" }
  | { kind: "bool" }
  | { kind: "fixedBytes"; size: number }
  | { kind: "bytes" }
  | { kind: "string" }
  | { kind: "array"; inner: AbiType }
  | { kind: "tuple"; members: AbiType[] };

export type AbiValue = bigint | boolean | string | AbiValue[];

export class AbiError extends Error {}

/** Splits "a,(b,c),d[]" at the top-level commas. */
function splitTop(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(list.slice(start, i));
      start = i + 1;
    }
  }
  const last = list.slice(start);
  if (last.trim() || out.length) out.push(last);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

export function parseType(s: string): AbiType {
  const t = s.trim();
  if (t.endsWith("[]")) return { kind: "array", inner: parseType(t.slice(0, -2)) };
  if (t.startsWith("(") && t.endsWith(")")) return { kind: "tuple", members: splitTop(t.slice(1, -1)).map(parseType) };
  let m = /^uint(\d*)$/.exec(t);
  if (m) return { kind: "uint", bits: m[1] ? Number(m[1]) : 256 };
  m = /^int(\d*)$/.exec(t);
  if (m) return { kind: "int", bits: m[1] ? Number(m[1]) : 256 };
  if (t === "address") return { kind: "address" };
  if (t === "bool") return { kind: "bool" };
  if (t === "bytes") return { kind: "bytes" };
  if (t === "string") return { kind: "string" };
  m = /^bytes(\d+)$/.exec(t);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 32) return { kind: "fixedBytes", size: Number(m[1]) };
  throw new AbiError(`unsupported ABI type ${s}`);
}

export function parseTypes(list: string): AbiType[] {
  return splitTop(list).map(parseType);
}

function isDynamic(t: AbiType): boolean {
  if (t.kind === "bytes" || t.kind === "string" || t.kind === "array") return true;
  if (t.kind === "tuple") return t.members.some(isDynamic);
  return false;
}

function headSize(t: AbiType): number {
  if (t.kind === "tuple" && !isDynamic(t)) return t.members.reduce((n, m) => n + headSize(m), 0);
  return 32;
}

class Reader {
  readonly data: Uint8Array;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  word(at: number): Uint8Array {
    if (at < 0 || at + 32 > this.data.length) throw new AbiError(`read past the end at ${at} (${this.data.length} bytes)`);
    return this.data.subarray(at, at + 32);
  }

  uint(at: number): bigint {
    let n = 0n;
    for (const b of this.word(at)) n = (n << 8n) | BigInt(b);
    return n;
  }

  /** A word used as an offset or a length: has to fit in the data. */
  size(at: number): number {
    const n = this.uint(at);
    if (n > BigInt(this.data.length)) throw new AbiError(`offset or length ${n} at ${at} exceeds the data`);
    return Number(n);
  }
}

function decodeAt(r: Reader, t: AbiType, at: number): AbiValue {
  switch (t.kind) {
    case "uint": {
      const n = r.uint(at);
      if (t.bits < 256 && n >> BigInt(t.bits) !== 0n) throw new AbiError(`uint${t.bits} out of range at ${at}`);
      return n;
    }
    case "int": {
      let n = r.uint(at);
      if (n >> 255n) n -= 1n << 256n;
      return n;
    }
    case "address": {
      const w = r.word(at);
      if (w.subarray(0, 12).some((b) => b !== 0)) throw new AbiError(`address with dirty upper bytes at ${at}`);
      return bytesToHex(w.subarray(12));
    }
    case "bool": {
      const n = r.uint(at);
      if (n > 1n) throw new AbiError(`bool out of range at ${at}`);
      return n === 1n;
    }
    case "fixedBytes":
      return bytesToHex(r.word(at).subarray(0, t.size));
    case "bytes":
    case "string": {
      const len = r.size(at);
      if (at + 32 + len > r.data.length) throw new AbiError(`bytes of ${len} at ${at} run past the end`);
      const body = r.data.subarray(at + 32, at + 32 + len);
      return t.kind === "string" ? new TextDecoder().decode(body) : bytesToHex(body);
    }
    case "array": {
      const len = r.size(at);
      return decodeTuple(r, Array.from({ length: len }, () => t.inner), at + 32);
    }
    case "tuple":
      return decodeTuple(r, t.members, at);
  }
}

function decodeTuple(r: Reader, types: AbiType[], base: number): AbiValue[] {
  const out: AbiValue[] = [];
  let head = base;
  for (const t of types) {
    if (isDynamic(t)) out.push(decodeAt(r, t, base + r.size(head)));
    else out.push(decodeAt(r, t, head));
    head += headSize(t);
  }
  return out;
}

/** Decodes `data` (no selector) as the tuple `types`. */
export function decode(types: AbiType[] | string, data: Uint8Array | string): AbiValue[] {
  const ts = typeof types === "string" ? parseTypes(types) : types;
  const bytes = typeof data === "string" ? hexToBytes(data) : data;
  return decodeTuple(new Reader(bytes), ts, 0);
}

function word(n: bigint): string {
  if (n < 0n || n >> 256n) throw new AbiError(`value out of range: ${n}`);
  return n.toString(16).padStart(64, "0");
}

/** Encodes static arguments (uint, address, bool, bytes32) after a selector: enough for the page's view calls. */
export function encodeCall(signature: string, args: (bigint | number | string | boolean)[] = []): Hex {
  const open = signature.indexOf("(");
  const types = parseTypes(signature.slice(open + 1, -1));
  if (types.length !== args.length) throw new AbiError(`${signature} takes ${types.length} arguments, got ${args.length}`);
  let out = selector(signature).slice(2);
  types.forEach((t, i) => {
    const v = args[i];
    if (t.kind === "uint") out += word(BigInt(v as bigint | number | string));
    else if (t.kind === "address") out += word(BigInt(String(v)));
    else if (t.kind === "bool") out += word(v ? 1n : 0n);
    else if (t.kind === "fixedBytes") out += String(v).replace(/^0x/, "").padEnd(64, "0");
    else throw new AbiError(`encodeCall does not encode ${t.kind}`);
  });
  return `0x${out}` as Hex;
}

// ---------------------------------------------------------------------------------------------
// Errors and events, from the contract sources (build/records.ts) and Solidity's own two errors

export interface DecodedArg {
  name: string;
  type: string;
  value: AbiValue;
}

export interface DecodedError {
  name: string;
  signature: string;
  args: DecodedArg[];
  /** Which source declares it (contracts/src/...), or "Solidity" for Error and Panic. */
  source: string;
}

export interface DecodedLog {
  name: string;
  signature: string;
  args: DecodedArg[];
  address: Hex;
  source: string;
}

export function canonical(item: { name: string; params: AbiParam[] }): string {
  return `${item.name}(${item.params.map((p) => p.type).join(",")})`;
}

const BUILTIN_ERRORS: AbiItem[] = [
  { kind: "error", name: "Error", params: [{ type: "string", name: "reason", indexed: false }], source: "Solidity" },
  { kind: "error", name: "Panic", params: [{ type: "uint256", name: "code", indexed: false }], source: "Solidity" },
];

export class AbiRegistry {
  readonly errors = new Map<string, AbiItem[]>();
  readonly events = new Map<string, AbiItem[]>();

  constructor(errors: AbiItem[], events: AbiItem[]) {
    for (const e of [...BUILTIN_ERRORS, ...errors]) {
      const key = selector(canonical(e));
      const list = this.errors.get(key) ?? [];
      if (!list.some((x) => canonical(x) === canonical(e))) list.push(e);
      this.errors.set(key, list);
    }
    for (const e of events) {
      const key = eventTopic(canonical(e));
      const list = this.events.get(key) ?? [];
      if (!list.some((x) => canonical(x) === canonical(e) && sameIndexing(x, e))) list.push(e);
      this.events.set(key, list);
    }
  }

  /** Decodes revert data: a custom error of the contracts, Error(string) or Panic(uint256); null if unknown. */
  decodeError(data: string): DecodedError | null {
    if (!/^0x[0-9a-fA-F]{8}/.test(data)) return null;
    const items = this.errors.get(data.slice(0, 10).toLowerCase()) ?? [];
    for (const item of items) {
      try {
        const values = decode(item.params.map((p) => parseType(p.type)), "0x" + data.slice(10));
        return {
          name: item.name,
          signature: canonical(item),
          source: item.source,
          args: item.params.map((p, i) => ({ name: p.name, type: p.type, value: values[i] as AbiValue })),
        };
      } catch {
        // try the next item with this selector
      }
    }
    return null;
  }

  /** Decodes a log from its topics and data; null if the event is not one of the contracts'. */
  decodeLog(log: { address: string; topics: string[]; data: string }): DecodedLog | null {
    const topic0 = log.topics[0]?.toLowerCase();
    if (!topic0) return null;
    for (const item of this.events.get(topic0) ?? []) {
      const indexed = item.params.filter((p) => p.indexed);
      if (indexed.length !== log.topics.length - 1) continue;
      try {
        const plain = item.params.filter((p) => !p.indexed);
        const values = decode(plain.map((p) => parseType(p.type)), log.data);
        let ti = 1;
        let vi = 0;
        const args = item.params.map((p) => {
          if (p.indexed) {
            const topic = log.topics[ti++] ?? "0x";
            const t = parseType(p.type);
            const value = isDynamic(t) ? topic : (decode([t], topic)[0] as AbiValue);
            return { name: p.name, type: p.type, value };
          }
          return { name: p.name, type: p.type, value: values[vi++] as AbiValue };
        });
        return { name: item.name, signature: canonical(item), args, address: log.address.toLowerCase() as Hex, source: item.source };
      } catch {
        // try the next item with this topic
      }
    }
    return null;
  }
}

function sameIndexing(a: AbiItem, b: AbiItem): boolean {
  return a.params.every((p, i) => p.indexed === b.params[i]?.indexed);
}

/** "InvalidSignature(i: 0, authorityIndex: 0)", with 32-byte words shortened by `short`. */
export function formatError(e: DecodedError, short: (h: string) => string = (h) => h): string {
  if (e.name === "Error" && typeof e.args[0]?.value === "string") return `Error("${e.args[0].value}")`;
  return `${e.name}(${e.args.map((a) => `${a.name}: ${formatValue(a.value, short)}`).join(", ")})`;
}

export function formatValue(v: AbiValue, short: (h: string) => string = (h) => h): string {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.map((x) => formatValue(x, short)).join(", ")}]`;
  return v.startsWith("0x") ? short(v) : JSON.stringify(v);
}
