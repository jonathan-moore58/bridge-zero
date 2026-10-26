// GRANDPA justifications checked as the light client checks them: every counted precommit is an
// ed25519 signature over a 53-byte message, verified the way SCL_EIP6565.Verify_LE does on chain,
// each authority counts once, and the count must reach N - floor((N - 1) / 3). Then the signers hint
// the client takes, and whether a header's authority change is one the client can follow. A port of
// relayer/src/grandpa.ts, bridge.ts signersHint and relay.ts haltReason.
//
// noble's ed25519 and SHA-512 are loaded on first use (loadClientCrypto), as the status page loads
// them for its signature check: the page's first screen does not need them.

import type { EdwardsPoint } from "@noble/curves/abstract/edwards.js";
import type { ed25519 } from "@noble/curves/ed25519.js";
import type { sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, equalBytes, leToBigInt } from "../hex.ts";
import { precommitPayload } from "../scale.ts";
import { grandpaLogs, type Header, type Justification } from "./scale.ts";

/** Votes needed with N authorities of weight 1: 2 -> 2, 4 -> 3, 10 -> 7. */
export function threshold(n: number): number {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`the authority count must be a positive integer, got ${n}`);
  return n - Math.floor((n - 1) / 3);
}

/** GrandpaLightClient.MAX_AUTHORITIES: a set change to more keys halts the client. */
export const MAX_AUTHORITIES = 16;

export type Verify = (signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array) => boolean;

/** The light client's own ed25519 checks. */
export interface ClientCrypto {
  /** SCL_EIP6565.Verify_LE with the point AuthoritySets.deriveKey derives from the key. */
  verify: Verify;
  /** AuthoritySets.deriveKey accepts the key: the canonical encoding of a curve point not of small order. */
  usableKey: (key: Uint8Array) => boolean;
}

/**
 * The client's checks on noble's curve. verify: the key is the canonical encoding of a point not of
 * small order; s (little-endian) is in 1..L-1; k = SHA-512(R ‖ key ‖ message) mod L; and
 * [s]B + [L - k]A, encoded, must be R byte for byte. No cofactor is cleared, so an R with a
 * small-order part and a non-canonical R both fail, where noble's own verify takes them. As on chain,
 * a neutral [s]B + [L - k]A matches only the R that SCL computes for it. A key SCL cannot build its
 * table for counts no signature, so a signers hint never names a precommit the client could refuse.
 */
export function clientCrypto(curve: typeof ed25519, hash: typeof sha512): ClientCrypto {
  const Point = curve.Point;
  const L = Point.Fn.ORDER;
  // SCL's neutral element becomes x = 0, y = (A + 3) / (A - 3), A = 486662 (SCL_EIP6565.WeierStrass2Edwards).
  const NEUTRAL_R = Point.Fp.toBytes(Point.Fp.div(486_665n, 486_659n));
  // G, -G, -2G and -3G: SCL cannot build its table for a key Q where Q, 2Q or 3Q is one of them (ecGenMulmuladdB4W).
  const TABLE_CLASHES = [1n, L - 1n, L - 2n, L - 3n].map((c) => Point.BASE.multiplyUnsafe(c));
  const point = (key: Uint8Array): EdwardsPoint | null => {
    try {
      return Point.fromBytes(key, false);
    } catch {
      return null;
    }
  };
  return {
    usableKey: (key) => {
      const A = key.length === 32 ? point(key) : null;
      return !!A && !A.isSmallOrder();
    },
    verify: (signature, message, publicKey) => {
      if (signature.length !== 64 || publicKey.length !== 32) return false;
      const A = point(publicKey);
      if (!A || A.isSmallOrder()) return false;
      if ([A, A.double(), A.double().add(A)].some((m) => TABLE_CLASHES.some((c) => m.equals(c)))) return false;
      const s = leToBigInt(signature.subarray(32));
      if (s === 0n || s >= L) return false;
      const r = signature.subarray(0, 32);
      const k = leToBigInt(hash(concatBytes(r, publicKey, message))) % L;
      const sum = Point.BASE.multiplyUnsafe(s).add(k === 0n ? A.multiplyUnsafe(L - 1n).add(A) : A.multiplyUnsafe(L - k));
      return equalBytes(sum.is0() ? NEUTRAL_R : sum.toBytes(), r);
    },
  };
}

let loading: Promise<ClientCrypto> | null = null;

/** clientCrypto on noble's ed25519 and SHA-512, loaded on first use. */
export function loadClientCrypto(): Promise<ClientCrypto> {
  loading ??= Promise.all([import("@noble/curves/ed25519.js"), import("@noble/hashes/sha2.js")]).then(
    ([c, h]) => clientCrypto(c.ed25519, h.sha512),
    (error: unknown) => {
      loading = null;
      throw error;
    },
  );
  return loading;
}

export interface PrecommitResult {
  /** The precommit's position in the justification. */
  index: number;
  /** The signer's position in the authority list, or -1 when it is not a member. */
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
 * A justification checked against an authority list and set id, strictly: no votes_ancestries,
 * every precommit on the commit target and signed by a distinct member with a valid signature, and
 * at least threshold(N) of them. Any problem makes it not ok, as on chain.
 */
export function verifyJustification(j: Justification, authorities: Uint8Array[], setId: bigint, verify: Verify): JustificationResult {
  const required = threshold(authorities.length);
  const indexOf = new Map(authorities.map((id, i) => [bytesToHex(id), i] as const));
  const counted = new Set<number>();
  const problems: string[] = [];
  const precommits: PrecommitResult[] = [];
  if (j.votesAncestries.length !== 0) problems.push(`${j.votesAncestries.length} votes_ancestries, which the client does not decode`);
  j.precommits.forEach((p, index) => {
    const authorityIndex = indexOf.get(bytesToHex(p.id)) ?? -1;
    const signatureValid = verify(p.signature, precommitPayload(bytesToHex(p.targetHash), p.targetNumber, j.round, setId), p.id);
    let problem: string | undefined;
    if (p.targetNumber !== j.targetNumber || !equalBytes(p.targetHash, j.targetHash)) problem = "not on the commit target";
    else if (authorityIndex < 0) problem = "the signer is not in the authority set";
    else if (counted.has(authorityIndex)) problem = `authority ${authorityIndex} appears twice`;
    else if (!signatureValid) problem = "invalid signature";
    if (problem === undefined) counted.add(authorityIndex);
    else problems.push(`precommit ${index}: ${problem}`);
    precommits.push({ index, authorityIndex, signatureValid, ...(problem === undefined ? {} : { problem }) });
  });
  if (counted.size < required) problems.push(`${counted.size} valid signatures, ${required} required`);
  return { total: j.precommits.length, valid: counted.size, required, problems, precommits, ok: problems.length === 0 };
}

export class SignatureError extends Error {
  override name = "SignatureError";
}

export interface SignersHint {
  /** 2 bytes per counted precommit: its position in the justification, the signer's index in the set. */
  hint: Uint8Array;
  /** The precommits the hint names, in increasing authority index. */
  counted: PrecommitResult[];
  result: JustificationResult;
}

/**
 * The hint the light client takes, as relay.ts builds it: the justification verified under `keys`
 * and `setId` with the client's own check, and exactly the threshold of valid precommits named as
 * (position, index in the set) pairs in increasing index, the order the client requires. Throws
 * SignatureError unless the client would accept the justification.
 */
export function signersHint(j: Justification, keys: Uint8Array[], setId: bigint, verify: Verify): SignersHint {
  const result = verifyJustification(j, keys, setId, verify);
  if (j.votesAncestries.length !== 0) throw new SignatureError(`the justification carries ${j.votesAncestries.length} votes_ancestries, which the client does not decode`);
  if (result.valid < result.required) throw new SignatureError(`the justification does not verify under set ${setId}: ${result.problems.join("; ")}`);
  // A hint names a precommit by a one-byte position.
  const counted = result.precommits
    .filter((p) => p.problem === undefined && p.index < 256)
    .sort((a, b) => a.authorityIndex - b.authorityIndex)
    .slice(0, result.required);
  if (counted.length < result.required) throw new SignatureError("the valid precommits are beyond position 255, where a signers hint cannot name them");
  return { hint: Uint8Array.from(counted.flatMap((p) => [p.index, p.authorityIndex])), counted, result };
}

/** What importing a header does to the client's authority set. */
export type AuthorityChange =
  /** No ScheduledChange or ForcedChange: the set stays. */
  | { kind: "none" }
  /** One ScheduledChange with delay 0 and a list the client can use: the client moves to set id + 1 with `next`. */
  | { kind: "follows"; next: Uint8Array[] }
  /** Importing it would halt the client (or revert), which then needs its admin. */
  | { kind: "halts"; reason: string };

/**
 * The authority change in `header`, as GrandpaCodec.decodeHeader and AuthoritySets.enactChange
 * judge it (relay.ts haltReason): one ScheduledChange with delay 0, every weight 1, 1 to
 * MAX_AUTHORITIES distinct keys, each a usable point. Anything else that changes the authorities
 * halts the client; a ChangesTrieRoot digest item makes the import revert (UnknownDigestItem).
 */
export function authorityChange(header: Header, crypto: ClientCrypto): AuthorityChange {
  if (header.digest.some((d) => d.kind === "ChangesTrieRoot")) return { kind: "halts", reason: "a ChangesTrieRoot digest item, which the client does not decode (UnknownDigestItem)" };
  const changes = grandpaLogs(header).filter((l) => l.kind === "ScheduledChange" || l.kind === "ForcedChange");
  const l = changes[0];
  if (!l) return { kind: "none" };
  if (changes.length > 1) return { kind: "halts", reason: `${changes.length} set changes in one header (MultipleChanges)` };
  if (l.kind === "ForcedChange") return { kind: "halts", reason: `a ForcedChange (median #${l.median}, delay ${l.delay})` };
  if (l.delay !== 0) return { kind: "halts", reason: `a ScheduledChange with delay ${l.delay} (DelayedChange)` };
  const keys = l.nextAuthorities;
  if (keys.some((a) => a.weight !== 1n)) return { kind: "halts", reason: "a ScheduledChange with a weight other than 1 (UnusableAuthoritySet)" };
  if (keys.length === 0 || keys.length > MAX_AUTHORITIES) return { kind: "halts", reason: `a ScheduledChange to ${keys.length} keys, where the client takes 1 to ${MAX_AUTHORITIES} (UnusableAuthoritySet)` };
  if (new Set(keys.map((a) => bytesToHex(a.id))).size !== keys.length) return { kind: "halts", reason: "a ScheduledChange with a duplicate key (UnusableAuthoritySet)" };
  const bad = keys.findIndex((a) => !crypto.usableKey(a.id));
  if (bad >= 0) return { kind: "halts", reason: `a ScheduledChange whose key ${bad} is no usable ed25519 point (UnusableAuthoritySet)` };
  return { kind: "follows", next: keys.map((a) => a.id) };
}
