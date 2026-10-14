// GRANDPA justification checks, mirroring the rules the light client contract applies:
// every precommit is an ed25519 signature over a 53-byte message, each authority counts
// once, and the count must reach N - floor((N - 1) / 3).

import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, concatBytes, equalBytes, u32le, u64le } from "./bytes.js";
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
 * and at least threshold(N) of them. Any problem makes the result not ok, as on chain.
 */
export function verifyJustification(j: Justification, authorities: Uint8Array[], setId: bigint): JustificationResult {
  const required = threshold(authorities.length);
  const indexOf = new Map(authorities.map((id, i) => [bytesToHex(id), i] as const));
  const counted = new Set<number>();
  const problems: string[] = [];
  const precommits: PrecommitResult[] = [];
  if (j.votesAncestries.length !== 0) problems.push(`${j.votesAncestries.length} votes_ancestries (not supported)`);

  j.precommits.forEach((p, index) => {
    const authorityIndex = indexOf.get(bytesToHex(p.id)) ?? -1;
    const message = precommitPayload(p.targetHash, p.targetNumber, j.round, setId);
    const signatureValid = verifySignature(p.signature, message, p.id);
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
