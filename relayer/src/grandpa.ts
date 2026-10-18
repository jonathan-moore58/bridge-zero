// GRANDPA justification checks, mirroring the rules the light client contract applies:
// every precommit is an ed25519 signature over a 53-byte message, each authority counts
// once, and the count must reach N - floor((N - 1) / 3).

import type { EdwardsPoint } from "@noble/curves/abstract/edwards.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, equalBytes, leToBigInt, u32le, u64le } from "./bytes.js";
import type { Justification } from "./scale.js";

/** Votes needed with N authorities of weight 1. 10 -> 7, 4 -> 3, 1 -> 1. */
export function threshold(n: number): number {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`authority count must be a positive integer, got ${n}`);
  return n - Math.floor((n - 1) / 3);
}

/**
 * The signed message: SCALE of (Message::Precommit(Precommit { target_hash, target_number }), round, set_id),
 * i.e. 0x01 ‖ target_hash ‖ u32le(target_number) ‖ u64le(round) ‖ u64le(set_id), 53 bytes.
 */
export function precommitPayload(targetHash: Uint8Array, targetNumber: number, round: bigint, setId: bigint): Uint8Array {
  if (targetHash.length !== 32) throw new RangeError(`target hash must be 32 bytes, got ${targetHash.length}`);
  return concatBytes(Uint8Array.of(0x01), targetHash, u32le(targetNumber), u64le(round), u64le(setId));
}

export function verifySignature(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false; // malformed key or signature encoding
  }
}

const Point = ed25519.Point;
const L = Point.Fn.ORDER;
/**
 * The R that SCL's Verify_LE computes when [s]B + [L - k]A is the neutral element: the point (0, 0)
 * its multiplication then returns becomes x = 0, y = (A + 3) / (A - 3), A = 486662
 * (SCL_EIP6565.WeierStrass2Edwards).
 */
const NEUTRAL_R = Point.Fp.toBytes(Point.Fp.div(486_665n, 486_659n));
/** G, -G, -2G and -3G: SCL cannot build its table for a key Q where Q, 2Q or 3Q is one of them (ecGenMulmuladdB4W). */
const TABLE_CLASHES = [1n, L - 1n, L - 2n, L - 3n].map((c) => Point.BASE.multiplyUnsafe(c));

/**
 * The light client's own check: SCL_EIP6565.Verify_LE with the point AuthoritySets.deriveKey
 * derives from the key. The key is the canonical encoding of a curve point not of small order; s
 * (little-endian) is in 1..L-1; k = SHA-512(R ‖ key ‖ message) mod L; and [s]B + [L - k]A, encoded,
 * must be R byte for byte. No cofactor is cleared, so an R with a small-order part and a
 * non-canonical R both fail, where verifySignature (noble's) takes them. As on chain, a neutral
 * [s]B + [L - k]A matches NEUTRAL_R only. For a key SCL cannot build its table for, SCL computes
 * something else, which is not followed here: such a key's signatures never count, so a signers
 * hint never names a precommit the client could reject.
 */
export function clientVerifies(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  if (signature.length !== 64 || publicKey.length !== 32) return false;
  let A: EdwardsPoint;
  try {
    A = Point.fromBytes(publicKey, false);
  } catch {
    return false; // not a canonical curve point
  }
  if (A.isSmallOrder()) return false;
  if ([A, A.double(), A.double().add(A)].some((m) => TABLE_CLASHES.some((c) => m.equals(c)))) return false;
  const s = leToBigInt(signature.subarray(32));
  if (s === 0n || s >= L) return false;
  const r = signature.subarray(0, 32);
  const k = leToBigInt(sha512(concatBytes(r, publicKey, message))) % L;
  const sum = Point.BASE.multiplyUnsafe(s).add(k === 0n ? A.multiplyUnsafe(L - 1n).add(A) : A.multiplyUnsafe(L - k));
  return equalBytes(sum.is0() ? NEUTRAL_R : sum.toBytes(), r);
}

export interface PrecommitResult {
  /** Position in the justification. */
  index: number;
  /** Position of the signer in the authority list, or -1 if it is not a member. */
  authorityIndex: number;
  signatureValid: boolean;
  problem?: string;
}

export interface JustificationResult {
  total: number;
  /** Distinct authorities with a valid signature on the commit target. */
  valid: number;
  required: number;
  problems: string[];
  precommits: PrecommitResult[];
  ok: boolean;
}

/**
 * Strict check of a justification against an authority list and set id: no votes_ancestries,
 * every precommit on the commit target, signed by a distinct member with a valid signature,
 * and at least threshold(N) of them. Any problem makes the result not ok, as on chain. `verify`
 * checks one signature (clientVerifies for exactly what the light client accepts).
 */
export function verifyJustification(
  j: Justification,
  authorities: Uint8Array[],
  setId: bigint,
  verify: (signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array) => boolean = verifySignature,
): JustificationResult {
  const required = threshold(authorities.length);
  const indexOf = new Map(authorities.map((id, i) => [bytesToHex(id), i] as const));
  const counted = new Set<number>();
  const problems: string[] = [];
  const precommits: PrecommitResult[] = [];
  if (j.votesAncestries.length !== 0) problems.push(`${j.votesAncestries.length} votes_ancestries (not supported)`);

  j.precommits.forEach((p, index) => {
    const authorityIndex = indexOf.get(bytesToHex(p.id)) ?? -1;
    const message = precommitPayload(p.targetHash, p.targetNumber, j.round, setId);
    const signatureValid = verify(p.signature, message, p.id);
    let problem: string | undefined;
    if (p.targetNumber !== j.targetNumber || !equalBytes(p.targetHash, j.targetHash)) problem = "not on the commit target";
    else if (authorityIndex < 0) problem = "signer is not in the authority set";
    else if (counted.has(authorityIndex)) problem = `authority ${authorityIndex} appears twice`;
    else if (!signatureValid) problem = "invalid signature";
    if (problem === undefined) counted.add(authorityIndex);
    else problems.push(`precommit ${index}: ${problem}`);
    precommits.push({ index, authorityIndex, signatureValid, problem });
  });

  if (counted.size < required) problems.push(`${counted.size} valid signatures, ${required} required`);
  return { total: j.precommits.length, valid: counted.size, required, problems, precommits, ok: problems.length === 0 };
}
