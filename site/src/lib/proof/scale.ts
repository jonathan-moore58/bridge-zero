// Just enough SCALE for a mint built in the browser: compact integers, block headers with their
// digest items (GRANDPA "FRNK" logs among them), GRANDPA justifications, the FinalityProof of
// grandpa_proveFinality, and authority lists. A port of relayer/src/scale.ts; ../scale.ts stays the
// status page's lighter decoder.

import { concatBytes, hexToBytes, leToBigInt, u32le } from "../hex.ts";

export class ScaleError extends Error {
  override name = "ScaleError";
}

/** Cursor over a byte array. Every read checks bounds. */
export class Reader {
  offset = 0;
  readonly data: Uint8Array;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  get remaining(): number {
    return this.data.length - this.offset;
  }

  bytes(n: number): Uint8Array {
    if (!Number.isInteger(n) || n < 0 || n > this.remaining) throw new ScaleError(`need ${n} bytes at offset ${this.offset}, ${this.remaining} left`);
    const out = this.data.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  u8(): number {
    return this.bytes(1)[0] ?? 0;
  }

  u32(): number {
    return Number(leToBigInt(this.bytes(4)));
  }

  u64(): bigint {
    return leToBigInt(this.bytes(8));
  }

  u128(): bigint {
    return leToBigInt(this.bytes(16));
  }

  /** Compact<uN>. Refuses non-canonical encodings, as parity-scale-codec does. */
  compact(): bigint {
    const at = this.offset;
    const b0 = this.u8();
    switch (b0 & 0b11) {
      case 0:
        return BigInt(b0 >> 2);
      case 1: {
        const value = (b0 | (this.u8() << 8)) >> 2;
        if (value < 1 << 6) throw new ScaleError(`non-canonical compact at offset ${at}`);
        return BigInt(value);
      }
      case 2: {
        const value = Number(leToBigInt(concatBytes(Uint8Array.of(b0), this.bytes(3)))) >>> 2;
        if (value < 1 << 14) throw new ScaleError(`non-canonical compact at offset ${at}`);
        return BigInt(value);
      }
      default: {
        const raw = this.bytes((b0 >> 2) + 4);
        if (raw[raw.length - 1] === 0) throw new ScaleError(`non-canonical compact at offset ${at}`);
        const value = leToBigInt(raw);
        if (value < 1n << 30n) throw new ScaleError(`non-canonical compact at offset ${at}`);
        return value;
      }
    }
  }

  /** A compact length or count. It cannot exceed the bytes left, which also bounds allocations. */
  length(): number {
    const at = this.offset;
    const n = this.compact();
    if (n > BigInt(this.remaining)) throw new ScaleError(`length ${n} at offset ${at} exceeds the ${this.remaining} bytes left`);
    return Number(n);
  }

  /** Vec<u8>: compact length, then the bytes. */
  vecU8(): Uint8Array {
    return this.bytes(this.length());
  }

  /** Throws unless the whole input was read. */
  end(what: string): void {
    if (this.remaining !== 0) throw new ScaleError(`${what}: ${this.remaining} trailing bytes at offset ${this.offset}`);
  }
}

export function encodeCompact(value: number | bigint): Uint8Array {
  const v = BigInt(value);
  if (v < 0n) throw new RangeError(`compact of a negative value: ${v}`);
  if (v < 1n << 6n) return Uint8Array.of(Number(v) << 2);
  if (v < 1n << 14n) {
    const x = (Number(v) << 2) | 0b01;
    return Uint8Array.of(x & 0xff, x >> 8);
  }
  if (v < 1n << 30n) return u32le(Number(v) * 4 + 0b10);
  const le: number[] = [];
  for (let t = v; t > 0n; t >>= 8n) le.push(Number(t & 0xffn));
  if (le.length > 67) throw new RangeError("compact value too large");
  return Uint8Array.of(((le.length - 4) << 2) | 0b11, ...le);
}

// ---------------------------------------------------------------------------------------------
// Headers and digest items

export type DigestKind = "Other" | "ChangesTrieRoot" | "Consensus" | "Seal" | "PreRuntime" | "RuntimeEnvironmentUpdated";

export interface DigestItem {
  tag: number;
  kind: DigestKind;
  /** The four-byte engine id as ASCII ("BABE", "FRNK", ...) for Consensus, Seal and PreRuntime. */
  engine?: string;
  /** The payload without its length prefix; empty for RuntimeEnvironmentUpdated. */
  payload: Uint8Array;
}

export interface Header {
  parentHash: Uint8Array;
  number: number;
  stateRoot: Uint8Array;
  extrinsicsRoot: Uint8Array;
  digest: DigestItem[];
  /** The SCALE bytes this header was decoded from; blake2_256 of these is the block hash. */
  encoded: Uint8Array;
}

const DIGEST_KINDS: Partial<Record<number, DigestKind>> = {
  0: "Other",
  2: "ChangesTrieRoot", // a legacy item of older runtimes: a bare 32-byte hash
  4: "Consensus",
  5: "Seal",
  6: "PreRuntime",
  8: "RuntimeEnvironmentUpdated",
};

function readDigestItem(r: Reader): DigestItem {
  const start = r.offset;
  const tag = r.u8();
  const kind = DIGEST_KINDS[tag];
  if (kind === undefined) throw new ScaleError(`unknown digest item tag ${tag} at offset ${start}`);
  switch (kind) {
    case "Other":
      return { tag, kind, payload: r.vecU8() };
    case "ChangesTrieRoot":
      return { tag, kind, payload: r.bytes(32) };
    case "Consensus":
    case "Seal":
    case "PreRuntime": {
      const engine = String.fromCharCode(...r.bytes(4));
      return { tag, kind, engine, payload: r.vecU8() };
    }
    case "RuntimeEnvironmentUpdated":
      return { tag, kind, payload: new Uint8Array(0) };
  }
}

export function readHeader(r: Reader): Header {
  const start = r.offset;
  const parentHash = r.bytes(32);
  const number = r.compact();
  if (number > 0xffffffffn) throw new ScaleError(`block number ${number} does not fit a u32`);
  const stateRoot = r.bytes(32);
  const extrinsicsRoot = r.bytes(32);
  const count = r.length();
  const digest: DigestItem[] = [];
  for (let i = 0; i < count; i++) digest.push(readDigestItem(r));
  return { parentHash, number: Number(number), stateRoot, extrinsicsRoot, digest, encoded: r.data.subarray(start, r.offset) };
}

export function decodeHeader(bytes: Uint8Array): Header {
  const r = new Reader(bytes);
  const header = readHeader(r);
  r.end("header");
  return header;
}

/** A header as chain_getHeader returns it: the digest logs are SCALE-encoded items already. */
export interface RpcHeader {
  parentHash: string;
  number: string;
  stateRoot: string;
  extrinsicsRoot: string;
  digest: { logs: string[] };
}

function hash32(hex: string, field: string): Uint8Array {
  const bytes = hexToBytes(hex);
  if (bytes.length !== 32) throw new ScaleError(`${field} must be 32 bytes, got ${bytes.length}`);
  return bytes;
}

/** SCALE of a chain_getHeader result. The caller checks blake2_256 of it against the block hash. */
export function encodeRpcHeader(h: RpcHeader): Uint8Array {
  return concatBytes(
    hash32(h.parentHash, "parentHash"),
    encodeCompact(BigInt(h.number)),
    hash32(h.stateRoot, "stateRoot"),
    hash32(h.extrinsicsRoot, "extrinsicsRoot"),
    encodeCompact(h.digest.logs.length),
    ...h.digest.logs.map((log) => hexToBytes(log)),
  );
}

// ---------------------------------------------------------------------------------------------
// GRANDPA

export interface Authority {
  /** The ed25519 public key. */
  id: Uint8Array;
  weight: bigint;
}

/** Vec<(AuthorityId, u64)>, as GrandpaApi_grandpa_authorities and a ScheduledChange carry it. */
export function readAuthorityList(r: Reader): Authority[] {
  const n = r.length();
  const list: Authority[] = [];
  for (let i = 0; i < n; i++) list.push({ id: r.bytes(32), weight: r.u64() });
  return list;
}

export function decodeAuthorityList(bytes: Uint8Array): Authority[] {
  const r = new Reader(bytes);
  const list = readAuthorityList(r);
  r.end("authority list");
  return list;
}

export type GrandpaLog =
  | { kind: "ScheduledChange"; nextAuthorities: Authority[]; delay: number }
  | { kind: "ForcedChange"; median: number; nextAuthorities: Authority[]; delay: number }
  | { kind: "OnDisabled"; authorityIndex: bigint }
  | { kind: "Pause"; delay: number }
  | { kind: "Resume"; delay: number };

export const GRANDPA_ENGINE = "FRNK";

/** sp-consensus-grandpa's ConsensusLog: the payload of a Consensus("FRNK", ...) digest item. */
export function decodeGrandpaLog(payload: Uint8Array): GrandpaLog {
  const r = new Reader(payload);
  const index = r.u8();
  let log: GrandpaLog;
  switch (index) {
    case 1: {
      const nextAuthorities = readAuthorityList(r);
      log = { kind: "ScheduledChange", nextAuthorities, delay: r.u32() };
      break;
    }
    case 2: {
      const median = r.u32();
      const nextAuthorities = readAuthorityList(r);
      log = { kind: "ForcedChange", median, nextAuthorities, delay: r.u32() };
      break;
    }
    case 3:
      log = { kind: "OnDisabled", authorityIndex: r.u64() };
      break;
    case 4:
      log = { kind: "Pause", delay: r.u32() };
      break;
    case 5:
      log = { kind: "Resume", delay: r.u32() };
      break;
    default:
      throw new ScaleError(`unknown GRANDPA consensus log index ${index}`);
  }
  r.end("GRANDPA consensus log");
  return log;
}

/** The GRANDPA consensus logs in a header's digest, in digest order. */
export function grandpaLogs(header: Header): GrandpaLog[] {
  return header.digest.filter((d) => d.kind === "Consensus" && d.engine === GRANDPA_ENGINE).map((d) => decodeGrandpaLog(d.payload));
}

export interface SignedPrecommit {
  targetHash: Uint8Array;
  targetNumber: number;
  /** 64 bytes: R, then s. */
  signature: Uint8Array;
  /** The signer's ed25519 public key. */
  id: Uint8Array;
}

export interface Justification {
  round: bigint;
  targetHash: Uint8Array;
  targetNumber: number;
  precommits: SignedPrecommit[];
  votesAncestries: Header[];
}

/**
 * GrandpaJustification { round: u64, commit: { target_hash, target_number: u32, precommits:
 * Vec<{ precommit: { target_hash, target_number }, signature, id }> }, votes_ancestries: Vec<Header> }.
 * Refuses trailing bytes.
 */
export function decodeJustification(bytes: Uint8Array): Justification {
  const r = new Reader(bytes);
  const round = r.u64();
  const targetHash = r.bytes(32);
  const targetNumber = r.u32();
  const count = r.length();
  const precommits: SignedPrecommit[] = [];
  for (let i = 0; i < count; i++) precommits.push({ targetHash: r.bytes(32), targetNumber: r.u32(), signature: r.bytes(64), id: r.bytes(32) });
  const ancestries = r.length();
  const votesAncestries: Header[] = [];
  for (let i = 0; i < ancestries; i++) votesAncestries.push(readHeader(r));
  r.end("justification");
  return { round, targetHash, targetNumber, precommits, votesAncestries };
}

export interface FinalityProof {
  block: Uint8Array;
  /** The justification's SCALE bytes. */
  justification: Uint8Array;
  unknownHeaders: Header[];
}

/** FinalityProof { block: H256, justification: Vec<u8>, unknown_headers: Vec<Header> }, from grandpa_proveFinality. */
export function decodeFinalityProof(bytes: Uint8Array): FinalityProof {
  const r = new Reader(bytes);
  const block = r.bytes(32);
  const justification = r.vecU8();
  const count = r.length();
  const unknownHeaders: Header[] = [];
  for (let i = 0; i < count; i++) unknownHeaders.push(readHeader(r));
  r.end("finality proof");
  return { block, justification, unknownHeaders };
}

/**
 * A FinalityProof of `block` with no unknown headers, as importFinalityProof (and importAndMint)
 * takes it: grandpa_proveFinality's encoding, built here from a justification already in hand.
 */
export function encodeFinalityProof(block: Uint8Array, justification: Uint8Array): Uint8Array {
  if (block.length !== 32) throw new ScaleError(`a block hash is 32 bytes, got ${block.length}`);
  return concatBytes(block, encodeCompact(justification.length), justification, encodeCompact(0));
}

/** A u64 storage value, such as Grandpa.CurrentSetId. */
export function decodeU64(bytes: Uint8Array, what: string): bigint {
  const r = new Reader(bytes);
  const value = r.u64();
  r.end(what);
  return value;
}
