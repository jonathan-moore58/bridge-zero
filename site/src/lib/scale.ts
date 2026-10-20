// SCALE decoding of what a light-client import carries: the header's number, a GRANDPA
// justification and the FinalityProof wrapper of grandpa_proveFinality. The layouts are the ones
// GrandpaCodec.sol decodes on chain.

import { bytesToHex, hexToBytes, leToBigInt, type Hex } from "./hex.ts";

export class ScaleError extends Error {}

class Cursor {
  at = 0;
  readonly b: Uint8Array;

  constructor(b: Uint8Array) {
    this.b = b;
  }

  take(n: number): Uint8Array {
    if (n < 0 || this.at + n > this.b.length) throw new ScaleError(`truncated: ${n} bytes needed at ${this.at} of ${this.b.length}`);
    const out = this.b.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }

  u8(): number {
    return this.take(1)[0] ?? 0;
  }

  u32(): number {
    return Number(leToBigInt(this.take(4)));
  }

  u64(): bigint {
    return leToBigInt(this.take(8));
  }

  /** A SCALE compact integer. */
  compact(): bigint {
    const first = this.u8();
    const mode = first & 3;
    if (mode === 0) return BigInt(first >> 2);
    if (mode === 1) return BigInt((first | (this.u8() << 8)) >> 2);
    if (mode === 2) {
      const rest = this.take(3);
      return BigInt(((first | ((rest[0] ?? 0) << 8) | ((rest[1] ?? 0) << 16) | ((rest[2] ?? 0) << 24)) >>> 2) >>> 0);
    }
    const len = (first >> 2) + 4;
    return leToBigInt(this.take(len));
  }

  compactNumber(): number {
    const n = this.compact();
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new ScaleError(`compact ${n} too large`);
    return Number(n);
  }

  done(): boolean {
    return this.at === this.b.length;
  }
}

export interface ScaleHeader {
  parentHash: Hex;
  number: number;
  stateRoot: Hex;
  extrinsicsRoot: Hex;
}

/** The fixed fields of a Substrate header; the digest is left unread. */
export function decodeHeader(bytes: Uint8Array | string): ScaleHeader {
  const c = new Cursor(typeof bytes === "string" ? hexToBytes(bytes) : bytes);
  const parentHash = bytesToHex(c.take(32));
  const number = c.compactNumber();
  const stateRoot = bytesToHex(c.take(32));
  const extrinsicsRoot = bytesToHex(c.take(32));
  return { parentHash, number, stateRoot, extrinsicsRoot };
}

export interface SignedPrecommit {
  position: number;
  targetHash: Hex;
  targetNumber: number;
  signature: Hex;
  id: Hex;
}

export interface Justification {
  round: bigint;
  targetHash: Hex;
  targetNumber: number;
  precommits: SignedPrecommit[];
  votesAncestries: number;
}

function readJustification(c: Cursor): Justification {
  const round = c.u64();
  const targetHash = bytesToHex(c.take(32));
  const targetNumber = c.u32();
  const n = c.compactNumber();
  const precommits: SignedPrecommit[] = [];
  for (let i = 0; i < n; i++) {
    precommits.push({
      position: i,
      targetHash: bytesToHex(c.take(32)),
      targetNumber: c.u32(),
      signature: bytesToHex(c.take(64)),
      id: bytesToHex(c.take(32)),
    });
  }
  const votesAncestries = c.compactNumber();
  return { round, targetHash, targetNumber, precommits, votesAncestries };
}

/** A GRANDPA justification (round, commit, votes_ancestries count). Ancestry headers are not read. */
export function decodeJustification(bytes: Uint8Array | string): Justification {
  const c = new Cursor(typeof bytes === "string" ? hexToBytes(bytes) : bytes);
  const j = readJustification(c);
  if (j.votesAncestries === 0 && !c.done()) throw new ScaleError(`${c.b.length - c.at} trailing bytes after the justification`);
  return j;
}

export interface FinalityProof {
  block: Hex;
  justification: Justification;
  unknownHeaders: number;
}

/** grandpa_proveFinality's FinalityProof: block, the encoded justification, unknown_headers. */
export function decodeFinalityProof(bytes: Uint8Array | string): FinalityProof {
  const c = new Cursor(typeof bytes === "string" ? hexToBytes(bytes) : bytes);
  const block = bytesToHex(c.take(32));
  const len = c.compactNumber();
  const justification = decodeJustification(c.take(len));
  const unknownHeaders = c.compactNumber();
  return { block, justification, unknownHeaders };
}

export interface SignerEntry {
  /** The precommit's position in the justification. */
  position: number;
  /** The signer's index in the verifying set. */
  authorityIndex: number;
}

/** The light client's signers hint: 2 bytes per counted precommit, its position then the authority index. */
export function decodeSigners(hint: Uint8Array | string): SignerEntry[] {
  const b = typeof hint === "string" ? hexToBytes(hint) : hint;
  if (b.length % 2 !== 0) throw new ScaleError(`a signers hint has 2 bytes per entry, got ${b.length}`);
  const out: SignerEntry[] = [];
  for (let i = 0; i < b.length; i += 2) out.push({ position: b[i] ?? 0, authorityIndex: b[i + 1] ?? 0 });
  return out;
}

export interface TimestampInherent {
  /** The extrinsic format version (4 or 5). */
  version: number;
  pallet: number;
  call: number;
  /** Timestamp.set's argument: the block's time, ms since the Unix epoch. */
  moment: bigint;
}

/**
 * A block's first extrinsic as chain_getBlock returns it, read as Timestamp.set(now): the length
 * prefix, an unsigned ("bare") version byte, the call index, and now as a compact u64. Anything
 * else (a signed extrinsic, trailing bytes) is refused.
 */
export function decodeTimestampInherent(extrinsic: Uint8Array | string): TimestampInherent {
  const c = new Cursor(typeof extrinsic === "string" ? hexToBytes(extrinsic) : extrinsic);
  const len = c.compactNumber();
  if (len !== c.b.length - c.at) throw new ScaleError(`the length prefix says ${len} bytes, ${c.b.length - c.at} follow`);
  const v = c.u8();
  if (v & 0xc0) throw new ScaleError("not an unsigned (inherent) extrinsic");
  const version = v & 0x3f;
  if (version !== 4 && version !== 5) throw new ScaleError(`extrinsic version ${version}`);
  const pallet = c.u8();
  const call = c.u8();
  const moment = c.compact();
  if (!c.done()) throw new ScaleError("trailing bytes after Timestamp.set's argument");
  return { version, pallet, call, moment };
}

/**
 * The message a GRANDPA precommit signs: SCALE of (Message::Precommit(target_hash, target_number),
 * round, set_id), 53 bytes; Justification.signedPayload builds the same on chain.
 */
export function precommitPayload(targetHash: Hex, targetNumber: number, round: bigint, setId: bigint): Uint8Array {
  const out = new Uint8Array(53);
  out[0] = 0x01;
  out.set(hexToBytes(targetHash), 1);
  const v = new DataView(out.buffer);
  v.setUint32(33, targetNumber, true);
  v.setBigUint64(37, round, true);
  v.setBigUint64(45, setId, true);
  return out;
}
