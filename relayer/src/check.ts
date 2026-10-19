// Re-verifies captured fixtures off-chain, with no network access:
//   - every header decodes completely and blake2_256 of its SCALE bytes is the block hash;
//   - every precommit's ed25519 signature verifies over the 53-byte payload
//     0x01 ‖ target hash ‖ u32le number ‖ u64le round ‖ u64le set_id, under the recorded set,
//     and the threshold N - floor((N - 1) / 3) is met;
//   - the read proof walks from the header's state_root to the stored value, and a one-byte
//     flip in any proof node makes the walk fail;
//   - tampered inputs fail: a signature byte, set_id +/- 1, round + 1, too few or duplicated
//     precommits, a header byte;
//   - a signing set known only from the change log that started it (captures from nodes that
//     discard old state) is that log's list, in a header that hashes to its block hash;
//   - a pallet-revive contract slot (capture-contract.ts): Revive.AccountInfoOf walks from the
//     state_root and names the trie id and code hash, Revive.CodeInfoOf of that hash walks from
//     the state_root and its code_len and code_type are the code's length and kind, keccak-256 of
//     the code is that hash, the child root walks from the state_root under
//     ":child_storage:default:" ++ trie id, the slot walks from the child root under
//     blake2_256(slot), Revive.BlockHash(B) and Revive.BlockHash(B - 1) walk from the state_root
//     and tie the EVM RPC's block to B, and eth_getStorageAt's word at that block is the slot's
//     value; flipped bytes, another contract, code hash, trie id, slot or block number, and a
//     flipped root all fail, and the AccountInfo and CodeInfo decoders reject other variants,
//     trailing and missing bytes; the set id, which the capture reads without a proof, is null on
//     a chain without GRANDPA of its own;
//   - a mint bundle (mint.ts): B's header and finality proof as above, every signature also
//     under the light client's own check (grandpa.ts clientVerifies), the signers hint as the
//     client reads it (exactly the threshold, in increasing signer index) and as relay.ts builds
//     it, B's parent as a checkpoint in the signing set, Revive.AccountInfoOf(vault) as the
//     130-byte Contract entry BridgeMinter reads (trie id and code hash at their offsets), the child
//     root under ":child_storage:default:" ++ trie id, and commitments[nonce] under
//     blake2_256(keccak256(abi.encode(nonce, 0))) holding the commitment recomputed from the lock;
//     flipped bytes, another vault, trie id or nonce, a flipped root, and any other lock field fail;
//   - the files fit together the way a light client would use them.
//
//   npm run check -- [--dir <fixtures dir>]

import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, equalBytes, flipByte, hexToBytes, leToBigInt, shortHex, type Hex } from "./bytes.js";
import type {
  AnnouncedJson,
  AuthorityJson,
  AuthoritySetFixture,
  AuthoritySetJson,
  ContractStorageFixture,
  EvmBlockParam,
  FinalityProofFixture,
  FinalityProofJson,
  Fixture,
  HeaderJson,
  IndexFixture,
  JustifiedHeaderFixture,
  MintBundleFixture,
  ProofJson,
  SetChangeFixture,
  StorageKeyJson,
  StorageProofFixture,
} from "./fixture.js";
import { readJson } from "./fixture.js";
import { clientVerifies, precommitPayload, threshold, verifyJustification } from "./grandpa.js";
import { blake2_256, CHILD_STORAGE_DEFAULT_PREFIX, childRootKey, GRANDPA_AUTHORITIES_KEY, storageKey, systemAccountKey } from "./hash.js";
import {
  CODE_TYPE_OF_KIND,
  codeKind,
  decodeReviveAccountInfo,
  decodeReviveCodeInfo,
  EMPTY_TRIE_ROOT,
  isUnsetStorageWord,
  reviveAccountInfoKey,
  reviveBlockHashKey,
  reviveCodeInfoKey,
  reviveSlotKey,
} from "./revive.js";
import {
  decodeAccountInfo,
  decodeAuthorityList,
  decodeFinalityProof,
  decodeHeader,
  decodeJustification,
  decodeU64,
  decodeVersionedAuthorityList,
  grandpaLogs,
  ScaleError,
  type Header,
  type Justification,
} from "./scale.js";
import { readProof } from "./trie.js";
import { commitmentSlot, lockCommitment, type Lock } from "./vault.js";

const fmt = (n: number) => n.toLocaleString("en-US");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

class Report {
  passed = 0;
  failed = 0;
  skipped = 0;

  heading(text: string): void {
    console.log(`\n${text}`);
  }

  check(label: string, run: () => string | void): boolean {
    try {
      const detail = run();
      console.log(`  ok    ${label}${detail ? `: ${detail}` : ""}`);
      this.passed += 1;
      return true;
    } catch (error) {
      console.log(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`);
      this.failed += 1;
      return false;
    }
  }

  /** A check that does not apply to this snapshot: printed, and not counted as a pass. */
  skip(label: string, why: string): void {
    console.log(`  skip  ${label}: ${why}`);
    this.skipped += 1;
  }
}

const report = new Report();

/** Runs `run` and returns its value, or undefined if it threw (already reported as a failure). */
function step<T>(label: string, run: () => { value: T; detail?: string }): T | undefined {
  let value: T | undefined;
  report.check(label, () => {
    const out = run();
    value = out.value;
    return out.detail;
  });
  return value;
}

// ---------------------------------------------------------------------------------------
// Pieces shared by several fixture kinds

/** What a walk proves: the value it reaches, or null if it fails or shows the key absent. */
function proven(root: Uint8Array, proof: Uint8Array[], key: Uint8Array): Uint8Array | null {
  try {
    return readProof(root, proof, key).value;
  } catch {
    return null;
  }
}

/** The set a file records. A contract-storage capture reads it without a proof (capture-contract.ts). */
function setIdText(f: Fixture): string {
  const setId = f.provenance?.setId;
  if (setId === null) return "no GRANDPA set";
  return f.kind === "contract-storage" ? `set ${setId} (not proven)` : `set ${setId}`;
}

function checkProvenance(f: Fixture): void {
  report.check("provenance header", () => {
    const p = f.provenance;
    assert(typeof p.rpc === "string" && /^wss?:\/\/|^https?:\/\//.test(p.rpc), "rpc url missing");
    assert(hexToBytes(p.genesisHash).length === 32, "genesis hash is not 32 bytes");
    assert(Number.isInteger(p.runtime?.specVersion), "runtime spec version missing");
    assert(Number.isInteger(p.block?.number) && hexToBytes(p.block.hash).length === 32, "block number or hash missing");
    // A contract-storage capture on a chain without GRANDPA of its own (a parachain) has no set.
    assert(Number.isInteger(p.setId) || (f.kind === "contract-storage" && p.setId === null), "set_id missing");
    assert(/Z$/.test(p.capturedAt) && !Number.isNaN(Date.parse(p.capturedAt)), "capture time is not a UTC timestamp");
    assert(p.tool?.name && p.tool.version, "tool version missing");
    const readAt = p.runtime.readAt;
    if (readAt) assert(readAt.number >= p.block.number && hexToBytes(readAt.hash).length === 32, "runtime readAt is not a later block");
    const upgraded = p.runtime.upgradedAfter;
    if (upgraded !== undefined) assert(readAt !== undefined && upgraded > p.block.number && upgraded <= readAt.number, "upgradedAfter is not between the block and readAt");
    const where = readAt ? ` (read at #${fmt(readAt.number)}${upgraded !== undefined ? `, after an upgrade at #${fmt(upgraded)}` : ""})` : "";
    return `${p.chain}, ${p.runtime.specName} ${p.runtime.specVersion}${where}, ` +
      `#${fmt(p.block.number)}, ${setIdText(f)}, ${p.capturedAt}, ${p.tool.name} ${p.tool.version}`;
  });
}

function checkHeader(h: HeaderJson, label: string): Header | undefined {
  return step(`${label}: blake2b-256(SCALE header) = block hash`, () => {
    const scale = hexToBytes(h.scale);
    const header = decodeHeader(scale);
    assert(scale.length === h.bytes, `size ${scale.length} B, file says ${h.bytes}`);
    assert(bytesToHex(blake2_256(scale)) === h.hash, `hash ${bytesToHex(blake2_256(scale))} != ${h.hash}`);
    assert(header.number === h.number, `number ${header.number} != ${h.number}`);
    assert(bytesToHex(header.parentHash) === h.parentHash, "parent hash differs from the decoded one");
    assert(bytesToHex(header.stateRoot) === h.stateRoot, "state root differs from the decoded one");
    assert(bytesToHex(header.extrinsicsRoot) === h.extrinsicsRoot, "extrinsics root differs from the decoded one");
    assert(header.digest.length === h.digest.length, "digest item count differs");
    header.digest.forEach((d, i) => assert(bytesToHex(d.encoded) === h.digest[i].scale, `digest item ${i} differs`));
    const flipped = flipByte(scale, Math.floor(scale.length / 2));
    assert(bytesToHex(blake2_256(flipped)) !== h.hash, "a flipped header byte still hashes to the block hash");
    const items = header.digest.map((d) => `${d.kind}${d.engine ? ` ${d.engine}` : ""} ${d.payload.length}`).join(", ");
    return { value: header, detail: `#${fmt(header.number)}, ${scale.length} B, digest [${items}]; one-byte flip changes the hash` };
  });
}

interface CheckedSet {
  setId: bigint;
  ids: Uint8Array[];
  authorities: AuthorityJson[];
}

function sameAuthorities(a: AuthorityJson[], b: AuthorityJson[]): boolean {
  return a.length === b.length && a.every((x, i) => x.id === b[i].id && x.weight === b[i].weight);
}

/**
 * A set read from state (setIdStorage and runtimeCall), known from the change log that started
 * it (announced), or both, in which case both give the listed authorities.
 */
function checkAuthoritySet(s: AuthoritySetJson, label: string): CheckedSet | undefined {
  let set: CheckedSet | undefined;
  if (s.setIdStorage !== undefined || s.runtimeCall !== undefined || s.announced === undefined) {
    set = step(`${label}: authority list and set id`, () => {
      assert(s.runtimeCall !== undefined || s.setIdStorage !== undefined, "neither read from state (setIdStorage, runtimeCall) nor announced by a change log");
      assert(s.runtimeCall && s.setIdStorage, "only one of setIdStorage and runtimeCall is present");
      const list = decodeAuthorityList(hexToBytes(s.runtimeCall.scale));
      const decoded: AuthorityJson[] = list.map((a) => ({ id: bytesToHex(a.id), weight: Number(a.weight) }));
      assert(sameAuthorities(decoded, s.authorities), "decoded runtime-call list differs from the listed authorities");
      assert(s.setIdStorage.key === bytesToHex(storageKey("Grandpa", "CurrentSetId")), "set id storage key is not twox128(Grandpa) ++ twox128(CurrentSetId)");
      const setId = decodeU64(hexToBytes(s.setIdStorage.scale), "Grandpa.CurrentSetId");
      assert(setId === BigInt(s.setId), `stored set id ${setId} != ${s.setId}`);
      assert(new Set(decoded.map((a) => a.id)).size === decoded.length, "duplicate authority keys");
      assert(decoded.every((a) => a.weight === 1), "an authority weight is not 1");
      assert(s.count === decoded.length && s.threshold === threshold(decoded.length), "count or threshold field is wrong");
      return {
        value: { setId, ids: list.map((a) => a.id), authorities: decoded },
        detail: `set ${setId} at #${fmt(s.at.number)}, ${decoded.length} authorities of weight 1, threshold ${threshold(decoded.length)}`,
      };
    });
    if (!set) return undefined;
  }
  if (s.announced !== undefined) {
    const announced = checkAnnounced(s, s.announced, label);
    if (!announced) return undefined;
    set ??= announced;
  }
  return set;
}

/** A set as announced by the FRNK ScheduledChange (or ForcedChange) that started it. */
function checkAnnounced(s: AuthoritySetJson, a: AnnouncedJson, label: string): CheckedSet | undefined {
  const header = checkHeader(a.header, `${label}: header of the change that started it`);
  if (!header) return undefined;
  return step(`${label}: authority list from that change log`, () => {
    const changes = grandpaLogs(header).filter((l) => l.log.kind === "ScheduledChange" || l.log.kind === "ForcedChange");
    assert(changes.length === 1, `${changes.length} FRNK set changes in that header`);
    const { item, log } = changes[0];
    assert(log.kind === "ScheduledChange" || log.kind === "ForcedChange", `a ${log.kind} log`);
    assert(bytesToHex(item.payload) === a.scheduledChange.scale, "scheduledChange.scale is not the digest payload");
    assert(log.kind === a.scheduledChange.kind && log.delay === a.scheduledChange.delay, "kind or delay differs from the decoded log");
    if (s.setIdStorage === undefined) assert(log.kind === "ScheduledChange" && log.delay === 0, "a set known only from its change log must start with a ScheduledChange of delay 0");
    const decoded: AuthorityJson[] = log.nextAuthorities.map((x) => ({ id: bytesToHex(x.id), weight: Number(x.weight) }));
    assert(sameAuthorities(decoded, a.scheduledChange.nextAuthorities ?? []), "nextAuthorities differ from the decoded log");
    assert(sameAuthorities(decoded, s.authorities), "the listed authorities are not the ones the log announces");
    if (s.setIdStorage === undefined) assert(s.at.hash === a.header.hash && s.at.number === header.number, "`at` is not the block that carries the log");
    assert(new Set(decoded.map((x) => x.id)).size === decoded.length, "duplicate authority keys");
    assert(decoded.every((x) => x.weight === 1), "an authority weight is not 1");
    assert(s.count === decoded.length && s.threshold === threshold(decoded.length), "count or threshold field is wrong");
    return {
      value: { setId: BigInt(s.setId), ids: log.nextAuthorities.map((x) => x.id), authorities: decoded },
      detail:
        `${log.kind} (delay ${log.delay}) at #${fmt(header.number)}: ${decoded.length} authorities of weight 1, threshold ${threshold(decoded.length)}; ` +
        `set ${s.setId}, an id the log does not carry (the signatures fix it)`,
    };
  });
}

function sameJustification(j: Justification, f: JustifiedHeaderFixture): void {
  const x = f.justification;
  assert(BigInt(x.round) === j.round, "round differs from the decoded one");
  assert(x.targetHash === bytesToHex(j.targetHash) && x.targetNumber === j.targetNumber, "target differs from the decoded one");
  assert(x.precommits.length === j.precommits.length, "precommit count differs");
  j.precommits.forEach((p, i) => {
    const y = x.precommits[i];
    assert(y.authorityId === bytesToHex(p.id) && y.signature === bytesToHex(p.signature), `precommit ${i} differs`);
    assert(y.targetHash === bytesToHex(p.targetHash) && y.targetNumber === p.targetNumber, `precommit ${i} target differs`);
    assert(f.signingSet.authorities[y.authorityIndex]?.id === y.authorityId, `precommit ${i} authorityIndex does not point at its signer`);
  });
  assert(x.votesAncestries === j.votesAncestries.length, "votes_ancestries count differs");
}

/** Header, signing set, justification, signatures, threshold and tamper cases for one justified header. */
function checkJustifiedHeader(f: JustifiedHeaderFixture): { header: Header; justification: Justification; set: CheckedSet } | undefined {
  const header = checkHeader(f.header, "header");
  const set = checkAuthoritySet(f.signingSet, "signing set");
  if (!header || !set) return undefined;

  report.check("provenance matches the header and the signing set", () => {
    assert(f.provenance.block.hash === f.header.hash && f.provenance.block.number === header.number, "provenance block is not this header");
    assert(BigInt(f.provenance.setId) === set.setId, `provenance set_id ${f.provenance.setId} != signing set ${set.setId}`);
    const announced = f.signingSet.announced;
    if (announced) assert(announced.header.number < header.number, "the signing set was announced at or after this block");
    const started = announced ? `; announced at #${fmt(announced.header.number)}, ${fmt(header.number - announced.header.number)} blocks earlier` : "";
    // Without the state, the set is known from its change log only (checked with the set above).
    if (f.signingSet.setIdStorage === undefined) return `signing set from the change log${started}`;
    assert(f.signingSet.at.hash === bytesToHex(header.parentHash) && f.signingSet.at.number === header.number - 1, "signing set was not read at the parent block");
    return `signing set read at the parent block${started}`;
  });

  const justification = step("justification decodes", () => {
    const scale = hexToBytes(f.justification.scale);
    const j = decodeJustification(scale);
    assert(scale.length === f.justification.bytes, `size ${scale.length} B, file says ${f.justification.bytes}`);
    sameJustification(j, f);
    assert(equalBytes(j.targetHash, blake2_256(hexToBytes(f.header.scale))) && j.targetNumber === header.number, "justification does not target this header");
    assert(j.votesAncestries.length === 0, `${j.votesAncestries.length} votes_ancestries`);
    const expected = 8 + 32 + 4 + 1 + j.precommits.length * 132 + 1;
    assert(scale.length === expected, `size ${scale.length} B, layout predicts ${expected}`);
    return { value: j, detail: `${scale.length} B, round ${j.round}, target #${fmt(j.targetNumber)} = header hash, ${j.precommits.length} precommits, 0 ancestries` };
  });
  if (!justification) return undefined;
  const j = justification;

  report.check("precommit signatures (53-byte payload)", () => {
    for (const p of j.precommits) {
      const payload = precommitPayload(p.targetHash, p.targetNumber, j.round, set.setId);
      assert(payload.length === 53 && payload[0] === 0x01, "payload is not 53 bytes starting with 0x01");
      assert(equalBytes(payload.subarray(1, 33), p.targetHash), "payload hash bytes");
      assert(Number(leToBigInt(payload.subarray(33, 37))) === p.targetNumber, "payload number bytes");
      assert(leToBigInt(payload.subarray(37, 45)) === j.round && leToBigInt(payload.subarray(45, 53)) === set.setId, "payload round or set id bytes");
    }
    const result = verifyJustification(j, set.ids, set.setId);
    const bad = result.precommits.filter((p) => !p.signatureValid).length;
    assert(bad === 0, `${bad} signatures do not verify`);
    return `${j.precommits.length}/${j.precommits.length} ed25519 signatures valid under round ${j.round}, set ${set.setId}`;
  });

  report.check("threshold N - floor((N - 1) / 3)", () => {
    const result = verifyJustification(j, set.ids, set.setId);
    assert(result.ok, result.problems.join("; "));
    return `${result.valid} distinct signers >= ${result.required} required (N = ${set.ids.length})`;
  });

  report.check("tampered justifications are rejected", () => {
    const rejects = (what: string, jj: Justification, setId = set.setId) => {
      const r = verifyJustification(jj, set.ids, setId);
      assert(!r.ok, `${what} still verifies`);
      return r;
    };
    const p0 = j.precommits[0];
    const r1 = rejects("a flipped signature byte", { ...j, precommits: [{ ...p0, signature: flipByte(p0.signature, 10) }, ...j.precommits.slice(1)] });
    assert(r1.precommits[0].problem === "invalid signature", "the flipped signature was not the reason");
    for (const delta of [1n, -1n]) {
      const r = rejects(`set_id ${delta > 0n ? "+" : "-"}1`, j, set.setId + delta);
      assert(r.precommits.every((p) => !p.signatureValid), `set_id ${delta > 0n ? "+" : "-"}1: some signature still verifies`);
    }
    const r3 = rejects("round + 1", { ...j, round: j.round + 1n });
    assert(r3.precommits.every((p) => !p.signatureValid), "round + 1: some signature still verifies");
    const required = threshold(set.ids.length);
    rejects("one precommit fewer than the threshold", { ...j, precommits: j.precommits.slice(0, required - 1) });
    rejects("a duplicated precommit", { ...j, precommits: [...j.precommits, p0] });
    assert(verifyJustification({ ...j, precommits: j.precommits.slice(0, required) }, set.ids, set.setId).ok, "trimmed to exactly the threshold, it should still verify");
    return `signature byte, set_id +1, set_id -1, round + 1, ${required - 1} precommits, duplicate signer all fail; trimmed to ${required} still passes`;
  });

  return { header, justification: j, set };
}

// ---------------------------------------------------------------------------------------
// Fixture kinds

function checkFinalityProof(f: JustifiedHeaderFixture & { finalityProof: FinalityProofJson }): ReturnType<typeof checkJustifiedHeader> {
  const checked = checkJustifiedHeader(f);
  report.check("finality proof (grandpa_proveFinality)", () => {
    const scale = hexToBytes(f.finalityProof.scale);
    const proof = decodeFinalityProof(scale);
    assert(scale.length === f.finalityProof.bytes, `size ${scale.length} B, file says ${f.finalityProof.bytes}`);
    assert(bytesToHex(proof.block) === f.header.hash, "proof block is not the header hash");
    assert(bytesToHex(proof.justification) === f.justification.scale, "embedded justification differs");
    assert(proof.unknownHeaders.length === f.finalityProof.unknownHeaders, "unknown header count differs");
    return `${scale.length} B = block (32) + justification (${proof.justification.length}) + ${proof.unknownHeaders.length} unknown headers`;
  });
  return checked;
}

function checkSetChange(f: SetChangeFixture): ReturnType<typeof checkJustifiedHeader> {
  const checked = checkJustifiedHeader(f);
  if (!checked) return checked;
  report.check("FRNK ScheduledChange in the header", () => {
    const logs = grandpaLogs(checked.header);
    const change = logs.find((l) => l.log.kind === "ScheduledChange" || l.log.kind === "ForcedChange");
    assert(change, "no FRNK change log in the digest");
    assert(bytesToHex(change.item.payload) === f.scheduledChange.scale, "scheduledChange.scale is not the digest payload");
    assert(change.log.kind === "ScheduledChange", `${change.log.kind} (the light client halts on it)`);
    assert(change.log.delay === 0 && f.scheduledChange.delay === 0, `delay ${change.log.delay}; only delay 0 is supported`);
    const next: AuthorityJson[] = change.log.nextAuthorities.map((a) => ({ id: bytesToHex(a.id), weight: Number(a.weight) }));
    assert(sameAuthorities(next, f.scheduledChange.nextAuthorities ?? []), "nextAuthorities differ from the decoded log");
    assert(BigInt(f.newSetId) === checked.set.setId + 1n, `newSetId ${f.newSetId} is not signing set + 1`);
    const same = sameAuthorities(next, checked.set.authorities);
    return `${change.item.payload.length} B log, delay 0, ${next.length} next authorities (${same ? "same keys as" : "different keys from"} set ${checked.set.setId}), set ${checked.set.setId} -> ${f.newSetId}`;
  });
  const parent = checkHeader(f.parentHeader, "parent header (checkpoint)");
  if (parent) {
    report.check("parent header is the set-change block's parent", () => {
      assert(f.parentHeader.hash === bytesToHex(checked.header.parentHash), "parentHeader is not the parent");
      if (f.signingSet.setIdStorage !== undefined) assert(f.signingSet.at.hash === f.parentHeader.hash, "signing set was not read at this parent");
      return `#${fmt(parent.number)} ${shortHex(f.parentHeader.hash)}`;
    });
  }
  return checked;
}

function checkAuthoritySetFixture(f: AuthoritySetFixture): CheckedSet | undefined {
  const set = checkAuthoritySet(f.authoritySet, "authority set");
  report.check("provenance matches the set", () => {
    assert(f.provenance.block.hash === f.authoritySet.at.hash && f.provenance.block.number === f.authoritySet.at.number, "provenance block differs");
    assert(f.provenance.setId === f.authoritySet.setId, "provenance set_id differs");
  });
  // Older runtimes keep the list under the well-known key, newer ones in Grandpa.Authorities.
  const inPallet = f.palletStorage?.scale ?? null;
  if (f.wellKnownKey.scale === null && inPallet !== null) report.skip(":grandpa_authorities matches the runtime call", "not set by this runtime, which keeps the list in Grandpa.Authorities");
  else report.check(":grandpa_authorities matches the runtime call", () => {
    assert(f.wellKnownKey.key === bytesToHex(GRANDPA_AUTHORITIES_KEY), "key is not :grandpa_authorities");
    assert(f.wellKnownKey.scale, "value missing");
    const { version, authorities } = decodeVersionedAuthorityList(hexToBytes(f.wellKnownKey.scale));
    const list: AuthorityJson[] = authorities.map((a) => ({ id: bytesToHex(a.id), weight: Number(a.weight) }));
    assert(sameAuthorities(list, f.authoritySet.authorities), "lists differ");
    return `version ${version}, same ${list.length} keys in the same order`;
  });
  if (f.palletStorage && inPallet === null) report.skip("Grandpa.Authorities matches the runtime call", "not set by this runtime, which keeps the list under :grandpa_authorities");
  else if (f.palletStorage) {
    report.check("Grandpa.Authorities matches the runtime call", () => {
      assert(f.palletStorage?.key === bytesToHex(storageKey("Grandpa", "Authorities")), "key is not twox128(Grandpa) ++ twox128(Authorities)");
      assert(inPallet !== null, "value missing");
      const list: AuthorityJson[] = decodeAuthorityList(hexToBytes(inPallet)).map((a) => ({ id: bytesToHex(a.id), weight: Number(a.weight) }));
      assert(sameAuthorities(list, f.authoritySet.authorities), "lists differ");
      assert(inPallet === f.authoritySet.runtimeCall.scale, "not the same bytes as the runtime call");
      return `same ${list.length} keys in the same order, same bytes as the runtime call`;
    });
  }
  return set;
}

function checkStorageProof(f: StorageProofFixture): void {
  const header = checkHeader(f.header, "header");
  if (!header) return;
  report.check("provenance matches the header", () => {
    assert(f.provenance.block.hash === f.header.hash && f.provenance.block.number === header.number, "provenance block is not this header");
  });
  const accountId = hexToBytes(f.account.id);
  const key = hexToBytes(f.key.hex);
  report.check("storage key = twox128(System) ++ twox128(Account) ++ blake2_128(id) ++ id", () => {
    assert(equalBytes(systemAccountKey(accountId), key), "key does not derive from the account id");
    assert(key.length === 80 && f.key.bytes === 80, `key is ${key.length} B`);
    return `${key.length} B, account ${shortHex(accountId)} (${f.account.source})`;
  });
  const nodes = f.proof.nodes.map((n) => hexToBytes(n));
  const value = hexToBytes(f.value.scale);
  report.check(`read proof walks from state_root to the value (trie V${f.trieVersion})`, () => {
    assert(nodes.length === f.proof.count, "node count differs");
    const sizes = nodes.map((n) => n.length);
    assert(sizes.every((s, i) => s === f.proof.nodeBytes[i]), "node sizes differ");
    assert(sizes.reduce((a, b) => a + b, 0) === f.proof.bytes, "total size differs");
    const read = readProof(header.stateRoot, nodes, key);
    assert(read.value, "the proof shows the key as absent");
    assert(equalBytes(read.value, value), "the proof leads to a different value");
    assert(read.itemsUsed === nodes.length, `${nodes.length - read.itemsUsed} proof nodes were not needed`);
    if (f.trieVersion === 0) assert(read.hashedValues === 0, "a hashed value node in a V0 trie");
    // Trie V1 keeps values over 32 bytes out of their leaf, behind their hash, as a proof item of their own.
    const where = f.trieVersion === 1 ? `; value ${read.hashedValues > 0 ? "behind its hash (a proof item of its own)" : "inline in its node"}` : "";
    return `${nodes.length} nodes (${sizes.join(", ")} B; ${fmt(f.proof.bytes)} B total), all used, root ${shortHex(header.stateRoot)}${where}`;
  });
  report.check("value decodes as AccountInfo", () => {
    const info = decodeAccountInfo(value);
    const d = f.value.decoded;
    assert(value.length === 80 && f.value.bytes === 80, `value is ${value.length} B`);
    assert(d.nonce === info.nonce && d.providers === info.providers && d.free === info.free.toString() && d.reserved === info.reserved.toString(), "decoded fields differ");
    return `nonce ${info.nonce}, providers ${info.providers}, free ${info.free} (base units)`;
  });
  report.check("one-byte flips in the proof are rejected", () => {
    nodes.forEach((node, i) => {
      const tampered = nodes.map((n, k) => (k === i ? flipByte(n, Math.floor(n.length / 2)) : n));
      const v = proven(header.stateRoot, tampered, key);
      assert(v === null || !equalBytes(v, value), `a flip in node ${i} (${node.length} B) still proves the value`);
    });
    assert(proven(header.stateRoot, nodes, systemAccountKey(flipByte(accountId, 31))) === null, "the proof also proves a value for another account");
    assert(proven(flipByte(header.stateRoot, 0), nodes, key) === null, "a flipped state_root still reaches the value");
    return `${nodes.length}/${nodes.length} single-node flips fail; another account's key and a flipped state_root fail too`;
  });
}

/**
 * The proof came from `method`, its items match their recorded sizes, and the walk from `root`
 * along `key` reaches `value` using every one.
 */
function checkWalk(label: string, root: Uint8Array, proof: ProofJson, method: string, key: Uint8Array, value: Uint8Array, trieVersion: 0 | 1): Uint8Array[] | undefined {
  return step(label, () => {
    assert(proof.method === method, `the proof is from ${proof.method}, not ${method}`);
    const nodes = proof.nodes.map((n) => hexToBytes(n));
    assert(nodes.length === proof.count, "item count differs");
    const sizes = nodes.map((n) => n.length);
    assert(sizes.length === proof.nodeBytes.length && sizes.every((s, i) => s === proof.nodeBytes[i]), "item sizes differ");
    assert(sizes.reduce((a, b) => a + b, 0) === proof.bytes, "total size differs");
    const read = readProof(root, nodes, key);
    assert(read.value, "the proof shows the key as absent");
    assert(equalBytes(read.value, value), "the proof leads to a different value");
    assert(read.itemsUsed === nodes.length, `${nodes.length - read.itemsUsed} proof items were not needed`);
    if (trieVersion === 0) assert(read.hashedValues === 0, "a hashed value in a V0 trie");
    // Trie V1 keeps values over 32 bytes out of their leaf, behind their hash, as a proof item of their own.
    const where = trieVersion === 1 ? `; value ${read.hashedValues > 0 ? "behind its hash (a proof item of its own)" : "inline in its node"}` : "";
    return { value: nodes, detail: `${nodes.length} items (${fmt(proof.bytes)} B), all used, from ${shortHex(root)}${where}` };
  });
}

/** A one-byte flip in any item, a flipped root, and each of `others` fail to prove `value`. */
function checkTampers(label: string, root: Uint8Array, nodes: Uint8Array[], key: Uint8Array, value: Uint8Array, others: { what: string; key: Uint8Array }[]): void {
  report.check(label, () => {
    nodes.forEach((node, i) => {
      const tampered = nodes.map((n, k) => (k === i ? flipByte(n, Math.floor(n.length / 2)) : n));
      const v = proven(root, tampered, key);
      assert(v === null || !equalBytes(v, value), `a flip in item ${i} (${node.length} B) still proves the value`);
    });
    assert(proven(flipByte(root, 0), nodes, key) === null, "a flipped root still reaches the value");
    for (const o of others) assert(proven(root, nodes, o.key) === null, `the proof also proves a value for ${o.what}`);
    return `${nodes.length}/${nodes.length} single-item flips fail; a flipped root${others.map((o) => `, ${o.what}`).join("")} fail too`;
  });
}

/** The 32-byte big-endian slot `delta` away from `slot`, modulo 2^256. */
function otherSlot(slot: Uint8Array, delta: bigint): Uint8Array {
  const n = (BigInt(bytesToHex(slot)) + delta) & ((1n << 256n) - 1n);
  return hexToBytes(n.toString(16).padStart(64, "0"));
}

/**
 * pallet-revive's ChainId (a runtime constant, and what eth_chainId returns) of each chain with a
 * contract-storage capture, by genesis hash, with the chain's name as system_chain gives it. Read
 * from each chain's runtime metadata and its EVM RPC. `grandpa` says whether the chain runs GRANDPA
 * of its own; a parachain does not (its relay chain finalizes it), so its captures record no set.
 */
const EVM_CHAINS: Record<string, { chain: string; chainId: Hex; grandpa: boolean }> = {
  // 420,420,421; parachain 1000 of Westend
  "0x67f9723393ef76214df0118c34bbbd3dbebc8ed46a10973a8c969d48fe7598c9": { chain: "Westend Asset Hub", chainId: "0x190f1b45", grandpa: false },
  // 420,420,777; GRANDPA (fixtures/v3-testnet)
  "0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd": { chain: "PortaldotV3 Test", chainId: "0x190f1ca9", grandpa: true },
};

/** An Ethereum JSON-RPC QUANTITY: 0x and hex digits, without leading zeros. */
const QUANTITY = /^0x(0|[1-9a-f][0-9a-f]*)$/;

/** The value at a dotted path of a parsed file, or undefined where the path ends early. */
function field(json: unknown, path: string): unknown {
  let x = json;
  for (const key of path.split(".")) x = x !== null && typeof x === "object" ? (x as Record<string, unknown>)[key] : undefined;
  return x;
}

/** The objects of a contract-storage file that its checks read. */
const CONTRACT_SECTIONS = [
  "header",
  "account.key",
  "account.value.decoded",
  "account.proof",
  "codeInfo.key",
  "codeInfo.value.decoded",
  "codeInfo.proof",
  "code",
  "childRoot.key",
  "childRoot.proof",
  "slot.key",
  "slot.value",
  "slot.proof.served",
  "evm.reviveBlockHash.key",
  "evm.reviveBlockHash.proof",
  "evm.reviveParentBlockHash.key",
  "evm.reviveParentBlockHash.proof",
  "evm.block",
  "evm.storageAt",
];
/** Its hex fields that are parsed before the check that uses them. */
const CONTRACT_HEX_FIELDS = [
  "account.address",
  "account.key.hex",
  "account.value.scale",
  "codeInfo.key.hex",
  "codeInfo.value.scale",
  "childRoot.key.hex",
  "childRoot.root",
  "slot.index",
  "slot.key.hex",
  "slot.value.hex",
  "evm.reviveBlockHash.key.hex",
  "evm.reviveBlockHash.value",
  "evm.reviveParentBlockHash.key.hex",
  "evm.reviveParentBlockHash.value",
];

/** The key names `pallet`.`item` with `hasher`, and holds exactly the bytes `expected`. */
function checkKeyFields(key: StorageKeyJson, pallet: string, item: string, hasher: string, expected: Uint8Array): void {
  assert(key.pallet === pallet && key.item === item && key.hasher === hasher, `the key says ${key.pallet}.${key.item} (${key.hasher}), not ${pallet}.${item} (${hasher})`);
  assert(key.hex === bytesToHex(expected), `the key is not twox128(${pallet}) ++ twox128(${item}) ++ the ${hasher} map key`);
  assert(key.bytes === expected.length, `key size ${key.bytes}, the key has ${expected.length} B`);
}

/** `run` throws a ScaleError whose message matches `reason`. */
function rejects(what: string, reason: RegExp, run: () => unknown): void {
  try {
    run();
  } catch (error) {
    assert(error instanceof ScaleError && reason.test(error.message), `${what}: rejected for another reason (${error instanceof Error ? error.message : String(error)})`);
    return;
  }
  throw new Error(`${what} is accepted`);
}

/** The block parameter of an EVM RPC call names the EVM block: its hash (EIP-1898) or its number (a QUANTITY). */
function namesEvmBlock(at: EvmBlockParam | undefined, hash: Hex, number: number): boolean {
  if (at !== null && typeof at === "object") return Object.keys(at).length === 1 && at.blockHash === hash;
  return typeof at === "string" && QUANTITY.test(at) && BigInt(at) === BigInt(number);
}

/** A pallet-revive contract slot proven from the state_root (capture-contract.ts). */
function checkContractStorage(f: ContractStorageFixture): void {
  // A file without one of its sections fails here, before any check reads it.
  const complete = report.check("every section is present", () => {
    const missing = CONTRACT_SECTIONS.filter((path) => {
      const value = field(f, path);
      return value === null || typeof value !== "object";
    });
    assert(missing.length === 0, `no ${missing.join(", ")}`);
    const notHex = CONTRACT_HEX_FIELDS.filter((path) => {
      const value = field(f, path);
      return typeof value !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(value);
    });
    assert(notHex.length === 0, `not 0x hex: ${notHex.join(", ")}`);
    assert(Array.isArray(f.notes), "no notes");
    return "header, account, codeInfo, code, childRoot, slot, evm (reviveBlockHash, reviveParentBlockHash, block, storageAt), notes";
  });
  if (!complete) return;
  const header = checkHeader(f.header, "header");
  if (!header) return;
  report.check("provenance matches the header", () => {
    assert(f.provenance.block.hash === f.header.hash && f.provenance.block.number === header.number, "provenance block is not this header");
    assert(typeof f.provenance.evmRpc === "string" && /^https?:\/\//.test(f.provenance.evmRpc), "EVM RPC url missing");
    assert(f.provenance.tool.script === "src/capture-contract.ts", `written by ${f.provenance.tool.script}, not src/capture-contract.ts`);
    assert(f.trieVersion === (f.provenance.runtime.stateVersion === 1 ? 1 : 0), `trie V${f.trieVersion}, runtime stateVersion ${f.provenance.runtime.stateVersion}`);
    // The set id is read without a proof; whether there is one at all is a property of the chain.
    const known = EVM_CHAINS[f.provenance.genesisHash];
    assert(known, `no record of genesis ${f.provenance.genesisHash}: whether it runs GRANDPA is not known`);
    const setId = f.provenance.setId;
    if (!known.grandpa) {
      assert(setId === null, `${known.chain} has no GRANDPA of its own, yet the file records set ${setId}`);
      return "no GRANDPA set at this block: the header is trusted input (see the notes)";
    }
    assert(typeof setId === "number" && Number.isSafeInteger(setId) && setId >= 0, `${known.chain} runs GRANDPA, yet the file records no set id (${setId})`);
    return `GRANDPA set ${setId} at this block, as state_getStorage returned it (not proven)`;
  });

  // Revive.AccountInfoOf(address), from the state_root.
  const address = hexToBytes(f.account.address);
  const accountKey = hexToBytes(f.account.key.hex);
  const accountValue = hexToBytes(f.account.value.scale);
  report.check("account key = twox128(Revive) ++ twox128(AccountInfoOf) ++ address", () => {
    assert(address.length === 20, `address is ${address.length} B`);
    checkKeyFields(f.account.key, "Revive", "AccountInfoOf", "Identity", reviveAccountInfoKey(address));
    return `${accountKey.length} B (Identity hasher), contract ${f.account.address}`;
  });
  const accountNodes = checkWalk(
    `AccountInfoOf proof walks from state_root to the value (trie V${f.trieVersion})`,
    header.stateRoot,
    f.account.proof,
    "state_getReadProof",
    accountKey,
    accountValue,
    f.trieVersion,
  );
  const contract = step("value decodes as a contract's AccountInfo", () => {
    assert(accountValue.length === f.account.value.bytes, `value is ${accountValue.length} B, file says ${f.account.value.bytes}`);
    const info = decodeReviveAccountInfo(accountValue);
    assert(info.kind === "Contract", "an externally owned account, not a contract");
    const c = info.contract;
    const d = f.account.value.decoded;
    assert(d.kind === info.kind && d.trieId === bytesToHex(c.trieId) && d.codeHash === bytesToHex(c.codeHash), "kind, trie id or code hash differs from the decoded one");
    assert(d.storageBytes === c.storageBytes && d.storageItems === c.storageItems && d.immutableDataLen === c.immutableDataLen && d.dust === info.dust, "sizes differ from the decoded ones");
    assert(
      d.storageByteDeposit === c.storageByteDeposit.toString() && d.storageItemDeposit === c.storageItemDeposit.toString() && d.storageBaseDeposit === c.storageBaseDeposit.toString(),
      "deposits differ from the decoded ones",
    );
    return { value: c, detail: `trie id ${shortHex(c.trieId)} (${c.trieId.length} B), code hash ${shortHex(c.codeHash)}, ${c.storageItems} storage items` };
  });
  report.check("AccountInfo decoder: an EOA value is an EOA; another variant, an added byte and a missing byte are rejected", () => {
    const eoa = decodeReviveAccountInfo(Uint8Array.of(1, 0, 0, 0, 0));
    assert(eoa.kind === "EOA" && eoa.dust === 0, "variant 1 with dust 0 does not decode as an EOA");
    rejects("variant 2", /unknown AccountType variant 2$/, () => decodeReviveAccountInfo(Uint8Array.of(2, 0, 0, 0, 0)));
    rejects("the value with a byte added", /trailing bytes/, () => decodeReviveAccountInfo(concatBytes(accountValue, Uint8Array.of(0))));
    rejects("the value without its last byte", /^need \d+ bytes/, () => decodeReviveAccountInfo(accountValue.subarray(0, accountValue.length - 1)));
    return "0x0100000000 decodes as an EOA; variant 2, the contract's value plus one byte and minus one byte all throw";
  });
  if (!contract) return;

  // Revive.CodeInfoOf(code hash), from the state_root, and the code eth_getCode returned.
  const codeInfoKey = hexToBytes(f.codeInfo.key.hex);
  const codeInfoValue = hexToBytes(f.codeInfo.value.scale);
  report.check("code-info key = twox128(Revive) ++ twox128(CodeInfoOf) ++ code hash", () => {
    checkKeyFields(f.codeInfo.key, "Revive", "CodeInfoOf", "Identity", reviveCodeInfoKey(contract.codeHash));
    return `${codeInfoKey.length} B (Identity hasher), the code hash from AccountInfoOf`;
  });
  const codeInfoNodes = checkWalk(
    `CodeInfoOf proof walks from state_root to the value (trie V${f.trieVersion})`,
    header.stateRoot,
    f.codeInfo.proof,
    "state_getReadProof",
    codeInfoKey,
    codeInfoValue,
    f.trieVersion,
  );
  report.check("code: keccak-256 = code hash, length = code_len, kind = code_type", () => {
    const code = hexToBytes(f.code.hex);
    assert(f.code.method === "eth_getCode", `code from ${f.code.method}`);
    assert(
      f.code.params.length === 2 && f.code.params[0] === f.account.address && namesEvmBlock(f.code.params[1], f.evm.block.hash, header.number),
      "eth_getCode was not asked for this contract at the EVM block",
    );
    assert(code.length === f.code.bytes, `code is ${code.length} B, file says ${f.code.bytes}`);
    assert(bytesToHex(keccak_256(code)) === f.code.keccak256, "keccak256 field differs");
    assert(equalBytes(keccak_256(code), contract.codeHash), "the code's keccak-256 is not the code hash in AccountInfoOf");
    const kind = codeKind(code);
    assert(kind === f.code.kind, `the code is ${kind}, file says ${f.code.kind}`);
    assert(codeInfoValue.length === f.codeInfo.value.bytes, `CodeInfo is ${codeInfoValue.length} B, file says ${f.codeInfo.value.bytes}`);
    const info = decodeReviveCodeInfo(codeInfoValue);
    const d = f.codeInfo.value.decoded;
    assert(d.owner === bytesToHex(info.owner) && d.deposit === info.deposit.toString() && d.refcount === info.refcount.toString(), "owner, deposit or refcount differs from the decoded one");
    assert(d.codeLen === info.codeLen && d.codeType === info.codeType && d.behaviourVersion === info.behaviourVersion, "code_len, code_type or behaviour_version differs from the decoded one");
    assert(info.codeLen === code.length, `CodeInfoOf says code_len ${info.codeLen}, the code is ${code.length} B`);
    assert(info.codeType === CODE_TYPE_OF_KIND[kind], `CodeInfoOf says code_type ${info.codeType}, the code is ${kind === "evm" ? "EVM bytecode" : "a PolkaVM program"}`);
    return `${fmt(code.length)} B from ${f.code.method}, ${kind === "evm" ? "EVM bytecode" : "a PolkaVM program"} (starts ${bytesToHex(code.subarray(0, 4))}); ` +
      `CodeInfoOf: code_type ${info.codeType}, code_len ${fmt(info.codeLen)}`;
  });
  report.check("CodeInfo decoder: the other code_type decodes as such; code_type 2, an added byte and a missing byte are rejected", () => {
    const at = codeInfoValue.length - 5; // code_type (u8), then behaviour_version (u32)
    const decoded = decodeReviveCodeInfo(codeInfoValue).codeType;
    const other = decodeReviveCodeInfo(flipByte(codeInfoValue, at)).codeType;
    assert(other !== decoded, "code_type is not the fifth byte from the end");
    rejects("code_type 2", /unknown BytecodeType variant 2$/, () => decodeReviveCodeInfo(Uint8Array.from(codeInfoValue, (b, i) => (i === at ? 2 : b))));
    rejects("the value with a byte added", /trailing bytes/, () => decodeReviveCodeInfo(concatBytes(codeInfoValue, Uint8Array.of(0))));
    rejects("the value without its last byte", /^need \d+ bytes/, () => decodeReviveCodeInfo(codeInfoValue.subarray(0, codeInfoValue.length - 1)));
    return `code_type ${decoded} flipped reads as ${other}; code_type 2, one byte added and one byte removed all throw`;
  });

  // The child trie's root, from the state_root.
  const rootKey = hexToBytes(f.childRoot.key.hex);
  const childRoot = hexToBytes(f.childRoot.root);
  report.check('child-root key = ":child_storage:default:" ++ trie id', () => {
    assert(equalBytes(childRootKey(contract.trieId), rootKey), "key is not the prefix and the decoded trie id");
    assert(f.childRoot.key.prefix === new TextDecoder().decode(CHILD_STORAGE_DEFAULT_PREFIX) && rootKey.length === f.childRoot.key.bytes, "prefix or key size differs");
    assert(childRoot.length === 32 && childRoot.some((b) => b !== 0), "the child root is not 32 non-zero bytes");
    return `${rootKey.length} B`;
  });
  const rootNodes = checkWalk(
    `child-root proof walks from state_root to the child root (trie V${f.trieVersion})`,
    header.stateRoot,
    f.childRoot.proof,
    "state_getReadProof",
    rootKey,
    childRoot,
    f.trieVersion,
  );

  // The slot, from the child root.
  const index = hexToBytes(f.slot.index);
  const slotKey = hexToBytes(f.slot.key.hex);
  const value = hexToBytes(f.slot.value.hex);
  report.check("slot key = blake2_256(slot)", () => {
    assert(index.length === 32, `slot is ${index.length} B`);
    assert(f.slot.key.hasher === "Blake2_256", `the key says hasher ${f.slot.key.hasher}, not Blake2_256`);
    assert(equalBytes(reviveSlotKey(index), slotKey), "key is not blake2_256 of the slot");
    assert(value.length > 0 && value.length === f.slot.value.bytes, "value is empty or its size differs");
    if (f.slot.label) assert(f.slot.label.source === "command line (--label)", `label source ${f.slot.label.source}`);
    return `slot ${shortHex(index)}${f.slot.label ? ` (${f.slot.label.text})` : ""} -> ${shortHex(slotKey)}`;
  });
  const slotNodes = checkWalk("slot proof walks from the child root to the value", childRoot, f.slot.proof, "state_getChildReadProof", slotKey, value, f.trieVersion);
  report.check("served child proof = these items + the items of the child-root proof", () => {
    const s = f.slot.proof.served;
    assert(s.mainTrieItems === f.childRoot.proof.count, `${s.mainTrieItems} main-trie items served, the child-root proof has ${f.childRoot.proof.count}`);
    assert(s.count === f.slot.proof.count + s.mainTrieItems, `served ${s.count} items, not ${f.slot.proof.count} kept + ${s.mainTrieItems} main-trie items`);
    assert(s.bytes === f.slot.proof.bytes + f.childRoot.proof.bytes, `served ${s.bytes} B, not ${f.slot.proof.bytes} + ${f.childRoot.proof.bytes}`);
    return `${s.count} served (${fmt(s.bytes)} B): the ${s.mainTrieItems} child-root proof items + ${f.slot.proof.count} child-trie items`;
  });

  // The EVM RPC's block: B itself, or the Ethereum block whose hash Revive.BlockHash(B) holds and
  // whose parent hash Revive.BlockHash(B - 1) holds.
  const blockHashKey = hexToBytes(f.evm.reviveBlockHash.key.hex);
  const blockHashValue = hexToBytes(f.evm.reviveBlockHash.value);
  report.check("block-hash key = twox128(Revive) ++ twox128(BlockHash) ++ u32le(block number)", () => {
    checkKeyFields(f.evm.reviveBlockHash.key, "Revive", "BlockHash", "Identity", reviveBlockHashKey(header.number));
    assert(blockHashValue.length === 32 && blockHashValue.some((b) => b !== 0), "the value is not 32 non-zero bytes");
    return `${blockHashKey.length} B (Identity hasher, u32 key ${header.number})`;
  });
  const blockHashNodes = checkWalk(
    `Revive.BlockHash(B) proof walks from state_root to the value (trie V${f.trieVersion})`,
    header.stateRoot,
    f.evm.reviveBlockHash.proof,
    "state_getReadProof",
    blockHashKey,
    blockHashValue,
    f.trieVersion,
  );
  const parentKey = hexToBytes(f.evm.reviveParentBlockHash.key.hex);
  const parentValue = hexToBytes(f.evm.reviveParentBlockHash.value);
  report.check("parent block-hash key = twox128(Revive) ++ twox128(BlockHash) ++ u32le(block number - 1)", () => {
    checkKeyFields(f.evm.reviveParentBlockHash.key, "Revive", "BlockHash", "Identity", reviveBlockHashKey(header.number - 1));
    assert(parentValue.length === 32 && parentValue.some((b) => b !== 0), "the value is not 32 non-zero bytes");
    return `${parentKey.length} B (Identity hasher, u32 key ${header.number - 1})`;
  });
  const parentNodes = checkWalk(
    `Revive.BlockHash(B - 1) proof walks from state_root to the value (trie V${f.trieVersion})`,
    header.stateRoot,
    f.evm.reviveParentBlockHash.proof,
    "state_getReadProof",
    parentKey,
    parentValue,
    f.trieVersion,
  );
  report.check("EVM chain id = pallet-revive's ChainId of this chain", () => {
    const known = EVM_CHAINS[f.provenance.genesisHash];
    assert(known, `no EVM chain id on record for genesis ${f.provenance.genesisHash}`);
    assert(f.provenance.chain === known.chain, `chain ${f.provenance.chain}, this genesis is ${known.chain}`);
    assert(f.evm.chainId === known.chainId, `EVM chain id ${f.evm.chainId}, ${known.chain} has ${known.chainId}`);
    return `${BigInt(f.evm.chainId)} (${f.evm.chainId}), ${known.chain}`;
  });
  report.check("EVM block is B, by its relation", () => {
    const b = f.evm.block;
    assert(b.method === "eth_getBlockByNumber", `block from ${b.method}`);
    assert(b.number === header.number, `EVM block ${b.number}, header #${header.number}`);
    if (f.evm.relation === "substrate-block") {
      assert(b.hash === f.header.hash, "relation substrate-block, but the EVM block's hash is not the header's");
      assert(b.parentHash === f.header.parentHash, "relation substrate-block, but the EVM block's parent hash is not the header's");
      assert(b.stateRoot === f.header.stateRoot, "relation substrate-block, but the EVM block's state root is not the header's");
      return `substrate-block: same hash, parent hash and state root as the header (Revive.BlockHash(B) and (B - 1) are ${shortHex(blockHashValue)} and ${shortHex(parentValue)})`;
    }
    assert(f.evm.relation === "revive-block-hash", `unknown relation ${f.evm.relation}`);
    assert(blockHashNodes && parentNodes, "Revive.BlockHash(B) or Revive.BlockHash(B - 1) is not proven");
    assert(b.hash === f.evm.reviveBlockHash.value, "relation revive-block-hash, but the EVM block's hash is not Revive.BlockHash(B)");
    assert(b.parentHash === f.evm.reviveParentBlockHash.value, "relation revive-block-hash, but the EVM block's parent hash is not Revive.BlockHash(B - 1)");
    assert(b.stateRoot === bytesToHex(EMPTY_TRIE_ROOT), `relation revive-block-hash, but the EVM block's state root ${b.stateRoot} is not the empty-trie root`);
    return `revive-block-hash: its hash and parent hash are Revive.BlockHash(B) ${shortHex(blockHashValue)} and Revive.BlockHash(B - 1) ${shortHex(parentValue)}, ` +
      `proven at B; its state root is the empty-trie root ${shortHex(EMPTY_TRIE_ROOT)}, a placeholder`;
  });
  report.check("eth_getStorageAt's word at the EVM block is the proven value", () => {
    const s = f.evm.storageAt;
    assert(s.method === "eth_getStorageAt", `word from ${s.method}`);
    assert(s.params.length === 3, `eth_getStorageAt with ${s.params.length} parameters`);
    assert(typeof s.params[1] === "string" && QUANTITY.test(s.params[1]), `the slot parameter ${JSON.stringify(s.params[1])} is not a QUANTITY (0x hex without leading zeros)`);
    assert(
      s.params[0] === f.account.address && BigInt(s.params[1]) === BigInt(f.slot.index) && namesEvmBlock(s.params[2], f.evm.block.hash, header.number),
      "eth_getStorageAt was not asked for this contract and slot at the EVM block",
    );
    assert(isUnsetStorageWord(new Uint8Array(0)) && isUnsetStorageWord(new Uint8Array(32)) && !isUnsetStorageWord(flipByte(new Uint8Array(32), 31)), '"0x" and 32 zero bytes are not both read as unset');
    const word = hexToBytes(s.result);
    // A stored value of fewer than 32 zero bytes, left-padded, is 32 zero bytes too: `matches` tells it from an unset slot.
    assert(!isUnsetStorageWord(word) || equalBytes(word, value) || s.matches === "left-padded", `the word ${s.result} means unset, the proof shows a value`);
    if (s.matches === "equal") {
      assert(equalBytes(word, value), "the word differs from the proven value");
    } else {
      assert(s.matches === "left-padded" && word.length === 32 && value.length < 32, `not a known relation: ${s.matches}`);
      assert(equalBytes(word.subarray(32 - value.length), value) && word.subarray(0, 32 - value.length).every((x) => x === 0), "the word is not the value left-padded");
    }
    const at = typeof s.params[2] === "object" ? "the EVM block's hash (EIP-1898)" : `block ${s.params[2]}`;
    return `asked at ${at}; word ${shortHex(word)} = value${s.matches === "equal" ? ", byte for byte" : ", left-padded"}`;
  });

  // Tampering: each step is bound to its root and its key.
  if (accountNodes && address.length === 20) {
    const other = reviveAccountInfoKey(flipByte(address, address.length - 1));
    checkTampers("AccountInfoOf proof: one-byte flips, a flipped state_root, another address", header.stateRoot, accountNodes, accountKey, accountValue, [{ what: "another address", key: other }]);
  }
  if (codeInfoNodes) {
    const other = reviveCodeInfoKey(flipByte(contract.codeHash, contract.codeHash.length - 1));
    checkTampers("CodeInfoOf proof: one-byte flips, a flipped state_root, another code hash", header.stateRoot, codeInfoNodes, codeInfoKey, codeInfoValue, [{ what: "another code hash", key: other }]);
  }
  if (rootNodes) {
    const other = childRootKey(flipByte(contract.trieId, contract.trieId.length - 1));
    checkTampers("child-root proof: one-byte flips, a flipped state_root, another trie id", header.stateRoot, rootNodes, rootKey, childRoot, [{ what: "another trie id", key: other }]);
  }
  if (slotNodes && index.length === 32) {
    const others = [1n, -1n].map((d) => ({ what: `slot ${d > 0n ? "+" : "-"} 1`, key: reviveSlotKey(otherSlot(index, d)) }));
    checkTampers("slot proof: one-byte flips, a flipped child root, the neighbouring slots", childRoot, slotNodes, slotKey, value, others);
  }
  // The neighbouring block numbers that exist (a u32 key is not negative).
  const blocks = (deltas: number[], what: (d: number) => string) =>
    deltas.filter((d) => header.number + d >= 0).map((d) => ({ what: what(d), key: reviveBlockHashKey(header.number + d) }));
  if (blockHashNodes) {
    const others = blocks([1, -1], (d) => `block B ${d > 0 ? "+" : "-"} 1`);
    checkTampers("Revive.BlockHash(B) proof: one-byte flips, a flipped state_root, the neighbouring block numbers", header.stateRoot, blockHashNodes, blockHashKey, blockHashValue, others);
  }
  if (parentNodes) {
    const others = blocks([0, -2], (d) => (d === 0 ? "block B" : "block B - 2"));
    checkTampers("Revive.BlockHash(B - 1) proof: one-byte flips, a flipped state_root, the neighbouring block numbers", header.stateRoot, parentNodes, parentKey, parentValue, others);
  }
}

/** The objects of a mint bundle that its checks read, and its hex fields parsed before the check that uses them. */
const BUNDLE_SECTIONS = [
  "header",
  "justification",
  "signingSet",
  "finalityProof",
  "signers",
  "parentHeader",
  "vault",
  "lock",
  "account.key",
  "account.value.decoded",
  "account.proof",
  "childRoot.key",
  "childRoot.proof",
  "slot.key",
  "slot.value",
  "slot.proof.served",
];
const BUNDLE_HEX_FIELDS = [
  "signers.hint",
  "vault.address",
  "vault.codeHash",
  "vault.trieId",
  "lock.recipient",
  "lock.dstMinter",
  "lock.commitment",
  "account.key.hex",
  "account.value.scale",
  "childRoot.key.hex",
  "childRoot.root",
  "slot.index",
  "slot.key.hex",
  "slot.value.hex",
];

/**
 * A mint bundle (mint.ts): B finalized by the recorded set as the light client checks it, the
 * signers hint it takes, B's parent as a checkpoint, and the three proofs BridgeMinter walks from
 * B's state_root to the lock's commitment.
 */
function checkMintBundle(f: MintBundleFixture): void {
  const complete = report.check("every section is present", () => {
    const missing = BUNDLE_SECTIONS.filter((path) => {
      const value = field(f, path);
      return value === null || typeof value !== "object";
    });
    assert(missing.length === 0, `no ${missing.join(", ")}`);
    const notHex = BUNDLE_HEX_FIELDS.filter((path) => {
      const value = field(f, path);
      return typeof value !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(value);
    });
    assert(notHex.length === 0, `not 0x hex: ${notHex.join(", ")}`);
    assert(Array.isArray(f.notes), "no notes");
    return "header, justification, signingSet, finalityProof, signers, parentHeader, vault, lock, account, childRoot, slot, notes";
  });
  if (!complete) return;
  const checked = checkFinalityProof(f);
  if (!checked) return;
  const { header, justification: j, set } = checked;

  report.check("provenance: a mint bundle of mint.ts, trie version the runtime's", () => {
    assert(f.provenance.tool.script === "src/mint.ts", `written by ${f.provenance.tool.script}, not src/mint.ts`);
    assert(f.trieVersion === (f.provenance.runtime.stateVersion === 1 ? 1 : 0), `trie V${f.trieVersion}, runtime stateVersion ${f.provenance.runtime.stateVersion}`);
    return `trie V${f.trieVersion}`;
  });
  report.check("B changes no set (a bundle is taken at such a block)", () => {
    const changes = grandpaLogs(header).filter((l) => l.log.kind === "ScheduledChange" || l.log.kind === "ForcedChange");
    assert(changes.length === 0, `B carries a ${changes[0]?.log.kind}`);
    return `digest [${header.digest.map((d) => `${d.kind}${d.engine ? ` ${d.engine}` : ""}`).join(", ")}]`;
  });

  // The light client's own signature check, and the signers hint it takes.
  report.check("every precommit verifies with the light client's own check (SCL Verify_LE, no cofactor)", () => {
    const result = verifyJustification(j, set.ids, set.setId, clientVerifies);
    assert(result.ok, result.problems.join("; "));
    return `${result.valid}/${j.precommits.length} under set ${set.setId} (grandpa.ts clientVerifies)`;
  });
  const hint = hexToBytes(f.signers.hint);
  const required = threshold(set.ids.length);
  report.check("signers hint: exactly the threshold, increasing signer index, each named precommit by its signer and valid", () => {
    assert(hint.length % 2 === 0, `${hint.length} bytes, not 2 per counted precommit`);
    const count = hint.length / 2;
    assert(count === required && f.signers.count === count && f.signers.threshold === required, `${count} entries, threshold ${required} (the file says ${f.signers.count} of ${f.signers.threshold})`);
    const positions = new Set<number>();
    let previous = -1;
    for (let i = 0; i < count; i++) {
      const [position, index] = [hint[2 * i], hint[2 * i + 1]];
      assert(position < j.precommits.length && !positions.has(position), `entry ${i}: precommit ${position} is out of range or named twice`);
      assert(index < set.ids.length && index > previous, `entry ${i}: signer index ${index} is out of range or not above ${previous}`);
      const p = j.precommits[position];
      assert(equalBytes(p.id, set.ids[index]), `entry ${i}: precommit ${position} is not signed by key ${index}`);
      assert(clientVerifies(p.signature, precommitPayload(p.targetHash, p.targetNumber, j.round, set.setId), p.id), `entry ${i}: the signature of precommit ${position} fails the client's check`);
      positions.add(position);
      previous = index;
    }
    return `${f.signers.hint}: ${Array.from({ length: count }, (_, i) => `precommit ${hint[2 * i]} by key ${hint[2 * i + 1]}`).join(", ")}`;
  });
  report.check("signers hint is the one relay.ts builds: the valid precommits of the lowest signer indexes", () => {
    const valid = j.precommits
      .map((p, position) => ({ position, index: set.ids.findIndex((id) => equalBytes(id, p.id)), p }))
      .filter((x) => x.index >= 0 && x.position < 256 && clientVerifies(x.p.signature, precommitPayload(x.p.targetHash, x.p.targetNumber, j.round, set.setId), x.p.id))
      .sort((a, b) => a.index - b.index);
    const expected = Uint8Array.from(valid.slice(0, required).flatMap((x) => [x.position, x.index]));
    assert(equalBytes(expected, hint), `relay.ts would build ${bytesToHex(expected)}`);
  });

  // B's parent: the checkpoint a fresh client starts from to import B.
  const parent = checkHeader(f.parentHeader, "parent header (checkpoint)");
  if (parent) {
    report.check("parent header is B's parent, where the signing set was read", () => {
      assert(f.parentHeader.hash === bytesToHex(header.parentHash) && parent.number === header.number - 1, "parentHeader is not B's parent");
      assert(f.signingSet.at.hash === f.parentHeader.hash, "the signing set was not read at this parent");
      return `#${fmt(parent.number)} ${shortHex(f.parentHeader.hash)}`;
    });
  }

  // Revive.AccountInfoOf(vault), from B's state_root, as BridgeMinter reads it.
  const vault = hexToBytes(f.vault.address);
  const accountKey = hexToBytes(f.account.key.hex);
  const accountValue = hexToBytes(f.account.value.scale);
  report.check("account key = twox128(Revive) ++ twox128(AccountInfoOf) ++ vault", () => {
    assert(vault.length === 20, `vault address is ${vault.length} B`);
    checkKeyFields(f.account.key, "Revive", "AccountInfoOf", "Identity", reviveAccountInfoKey(vault));
    return `${accountKey.length} B (Identity hasher), vault ${f.vault.address}`;
  });
  const accountNodes = checkWalk(`AccountInfoOf proof walks from B's state_root to the value (trie V${f.trieVersion})`, header.stateRoot, f.account.proof, "state_getReadProof", accountKey, accountValue, f.trieVersion);
  report.check("value is the 130-byte Contract entry the minter takes: trie id at bytes 2..33, code hash at 34..65", () => {
    assert(accountValue.length === 130 && f.account.value.bytes === 130, `value is ${accountValue.length} B`);
    assert(accountValue[0] === 0 && accountValue[1] === 0x80, `variant ${accountValue[0]}, trie id length byte 0x${accountValue[1].toString(16)}: not a contract with a 32-byte trie id`);
    const info = decodeReviveAccountInfo(accountValue);
    assert(info.kind === "Contract", "not a contract");
    const c = info.contract;
    const d = f.account.value.decoded;
    assert(equalBytes(c.trieId, accountValue.subarray(2, 34)) && bytesToHex(c.trieId) === f.vault.trieId && d.trieId === f.vault.trieId, "the trie id differs");
    assert(equalBytes(c.codeHash, accountValue.subarray(34, 66)) && bytesToHex(c.codeHash) === f.vault.codeHash && d.codeHash === f.vault.codeHash, "the code hash differs");
    assert(d.kind === "Contract" && d.storageItems === c.storageItems && d.storageBytes === c.storageBytes && d.dust === info.dust, "decoded fields differ");
    return `trie id ${shortHex(c.trieId)}, code hash ${shortHex(c.codeHash)}, ${c.storageItems} storage items`;
  });

  // The vault's child-trie root, from B's state_root.
  const trieId = hexToBytes(f.vault.trieId);
  const rootKey = hexToBytes(f.childRoot.key.hex);
  const childRoot = hexToBytes(f.childRoot.root);
  report.check('child-root key = ":child_storage:default:" ++ trie id', () => {
    assert(equalBytes(childRootKey(trieId), rootKey), "key is not the prefix and the trie id");
    assert(f.childRoot.key.prefix === new TextDecoder().decode(CHILD_STORAGE_DEFAULT_PREFIX) && rootKey.length === f.childRoot.key.bytes, "prefix or key size differs");
    assert(childRoot.length === 32 && childRoot.some((b) => b !== 0), "the child root is not 32 non-zero bytes");
    return `${rootKey.length} B`;
  });
  const rootNodes = checkWalk(`child-root proof walks from B's state_root to the child root (trie V${f.trieVersion})`, header.stateRoot, f.childRoot.proof, "state_getReadProof", rootKey, childRoot, f.trieVersion);

  // commitments[nonce], from the child root.
  const nonce = BigInt(f.lock.nonce);
  const index = hexToBytes(f.slot.index);
  const slotKey = hexToBytes(f.slot.key.hex);
  const value = hexToBytes(f.slot.value.hex);
  report.check("slot = keccak256(abi.encode(nonce, 0)) (commitments[nonce]), key = blake2_256(slot)", () => {
    assert(Number.isSafeInteger(f.lock.nonce) && f.lock.nonce >= 0, `nonce ${f.lock.nonce}`);
    assert(equalBytes(commitmentSlot(nonce), index), `the slot is not commitments[${nonce}]'s`);
    assert(f.slot.key.hasher === "Blake2_256" && equalBytes(reviveSlotKey(index), slotKey), "key is not blake2_256 of the slot");
    assert(value.length === 32 && f.slot.value.bytes === 32, `value is ${value.length} B, not a word`);
    return `nonce ${nonce}: slot ${shortHex(index)} -> ${shortHex(slotKey)}`;
  });
  const slotNodes = checkWalk("slot proof walks from the child root to the value", childRoot, f.slot.proof, "state_getChildReadProof", slotKey, value, f.trieVersion);
  report.check("served child proof = these items + the items of the child-root proof", () => {
    const s = f.slot.proof.served;
    assert(s.mainTrieItems === f.childRoot.proof.count, `${s.mainTrieItems} main-trie items served, the child-root proof has ${f.childRoot.proof.count}`);
    assert(s.count === f.slot.proof.count + s.mainTrieItems && s.bytes === f.slot.proof.bytes + f.childRoot.proof.bytes, "served counts or sizes do not add up");
    return `${s.count} served (${fmt(s.bytes)} B): the ${s.mainTrieItems} child-root proof items + ${f.slot.proof.count} child-trie items`;
  });

  // The word is the lock's commitment.
  const known = EVM_CHAINS[f.provenance.genesisHash];
  const lock: Lock = {
    v3ChainId: BigInt(f.vault.chainId),
    vault,
    dstChainId: BigInt(f.lock.dstChainId),
    dstMinter: hexToBytes(f.lock.dstMinter),
    recipient: hexToBytes(f.lock.recipient),
    amountNative: BigInt(f.lock.amountNative),
    nonce,
  };
  report.check("the proven word is the commitment recomputed from the lock, on this chain's id", () => {
    assert(known && BigInt(known.chainId) === lock.v3ChainId, `vault chain id ${f.vault.chainId}, this genesis is ${known ? `${known.chain}'s ${BigInt(known.chainId)}` : "not on record"}`);
    const commitment = lockCommitment(lock);
    assert(bytesToHex(commitment) === f.lock.commitment, `the lock's fields give ${bytesToHex(commitment)}, the file says ${f.lock.commitment}`);
    assert(equalBytes(commitment, value), "the proven word is another commitment");
    assert(lock.amountNative > 0n && lock.recipient.some((b) => b !== 0), "a zero amount or recipient");
    return `${shortHex(commitment)}: ${f.lock.amountNative} base units for ${f.lock.recipient} on chain ${f.lock.dstChainId}, minter ${f.lock.dstMinter}`;
  });
  report.check("another recipient, amount, nonce, minter, destination chain, vault or source chain gives another commitment", () => {
    const variants: [string, Lock][] = [
      ["recipient", { ...lock, recipient: flipByte(lock.recipient, 19) }],
      ["amount", { ...lock, amountNative: lock.amountNative + 1n }],
      ["nonce", { ...lock, nonce: lock.nonce + 1n }],
      ["minter", { ...lock, dstMinter: flipByte(lock.dstMinter, 19) }],
      ["destination chain", { ...lock, dstChainId: lock.dstChainId + 1n }],
      ["vault", { ...lock, vault: flipByte(lock.vault, 19) }],
      ["source chain", { ...lock, v3ChainId: lock.v3ChainId + 1n }],
    ];
    for (const [what, l] of variants) assert(!equalBytes(lockCommitment(l), value), `another ${what} gives the same commitment`);
    return `${variants.length} variants, ${variants.length} other commitments`;
  });

  // Tampering: each proof is bound to its root and its key.
  if (accountNodes) {
    checkTampers("AccountInfoOf proof: one-byte flips, a flipped state_root, another vault", header.stateRoot, accountNodes, accountKey, accountValue, [
      { what: "another vault", key: reviveAccountInfoKey(flipByte(vault, 19)) },
    ]);
  }
  if (rootNodes) {
    checkTampers("child-root proof: one-byte flips, a flipped state_root, another trie id", header.stateRoot, rootNodes, rootKey, childRoot, [
      { what: "another trie id", key: childRootKey(flipByte(trieId, 31)) },
    ]);
  }
  if (slotNodes) {
    const others = [nonce + 1n, ...(nonce > 0n ? [nonce - 1n] : [])].map((n) => ({ what: `commitments[${n}]`, key: reviveSlotKey(commitmentSlot(n)) }));
    checkTampers("slot proof: one-byte flips, a flipped child root, the neighbouring nonces", childRoot, slotNodes, slotKey, value, others);
  }
}

// ---------------------------------------------------------------------------------------
// Main

interface CaptureResults {
  finality?: { file: string; fixture: FinalityProofFixture; checked: ReturnType<typeof checkJustifiedHeader> };
  setChange?: { file: string; fixture: SetChangeFixture };
  authoritySet?: { file: string; fixture: AuthoritySetFixture };
  storage?: { file: string; fixture: StorageProofFixture };
}

function main(): void {
  const { values } = parseArgs({
    options: { dir: { type: "string", default: fileURLToPath(new URL("../../fixtures/mainnet", import.meta.url)) } },
  });
  const dir = resolve(values.dir);
  if (!existsSync(dir)) throw new Error(`no fixtures directory at ${dir}`);
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  console.log(`Checking ${files.length} fixture files in ${dir}`);

  const loaded = new Map<string, Fixture>();
  for (const file of files) loaded.set(file, readJson<Fixture>(join(dir, file)));

  // Cross-file checks use only the files of the capture that index.json describes; other
  // files (say, from an earlier capture) are still checked on their own.
  const index = loaded.get("index.json");
  const order = index?.kind === "index" ? index.files.map((e) => e.file) : [];
  const listed = index?.kind === "index" ? new Set(order) : null;
  const results: CaptureResults = {};
  const keep = <T>(file: string, value: T): T | undefined => (listed === null || listed.has(file) ? value : undefined);
  const rank = (file: string) => (file === "index.json" ? Infinity : order.includes(file) ? order.indexOf(file) : order.length);
  const ordered = [...loaded].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));

  for (const [file, f] of ordered) {
    const p = f.provenance;
    report.heading(`${file}  [${f.kind}]  #${fmt(p?.block?.number ?? 0)} ${shortHex(typeof p?.block?.hash === "string" ? p.block.hash : "0x")}  ${setIdText(f)}`);
    checkProvenance(f);
    switch (f.kind) {
      case "finality-proof":
        results.finality = keep(file, { file, fixture: f, checked: checkFinalityProof(f) }) ?? results.finality;
        break;
      case "justification":
      case "stored-justification": {
        const checked = checkJustifiedHeader(f);
        if (checked && f.kind === "stored-justification") {
          console.log(`        (stored at #${fmt(checked.header.number)}; #${fmt(checked.header.number)} mod 512 = ${checked.header.number % 512})`);
        }
        break;
      }
      case "set-change":
        checkSetChange(f);
        results.setChange = keep(file, { file, fixture: f }) ?? results.setChange;
        break;
      case "authority-set":
        checkAuthoritySetFixture(f);
        results.authoritySet = keep(file, { file, fixture: f }) ?? results.authoritySet;
        break;
      case "storage-proof":
        checkStorageProof(f);
        results.storage = keep(file, { file, fixture: f }) ?? results.storage;
        break;
      case "contract-storage":
        checkContractStorage(f);
        for (const note of Array.isArray(f.notes) ? f.notes : []) console.log(`        note: ${note}`);
        break;
      case "mint-bundle":
        checkMintBundle(f);
        for (const note of Array.isArray(f.notes) ? f.notes : []) console.log(`        note: ${note}`);
        break;
      case "index":
        checkIndex(f, loaded);
        break;
      default:
        report.check("known fixture kind", () => assert(false, `unknown kind ${(f as { kind: string }).kind}`));
    }
  }

  checkTogether(loaded, results);

  console.log(`\n${report.failed === 0 ? "All checks passed" : "Some checks FAILED"}: ${report.passed} passed, ${report.failed} failed${report.skipped ? `, ${report.skipped} skipped` : ""}.`);
  process.exitCode = report.failed === 0 ? 0 : 1;
}

function checkIndex(f: IndexFixture, loaded: Map<string, Fixture>): void {
  report.check("index lists this capture's files", () => {
    for (const e of f.files) {
      const x = loaded.get(e.file);
      assert(x, `${e.file} is listed but missing`);
      assert(x.kind === e.kind && x.provenance.block.number === e.block && x.provenance.setId === e.setId, `${e.file} does not match its entry`);
    }
    const unlisted = [...loaded.keys()].filter((name) => name !== "index.json" && !f.files.some((e) => e.file === name));
    return `${f.files.length} files${unlisted.length ? `; not from this capture: ${unlisted.join(", ")}` : ""}`;
  });
  const counts = f.watch.seen.map((s) => s.precommits);
  console.log(`        watch: ${f.watch.seen.length} justifications seen in ${f.watch.seconds} s on ${f.watch.method}, precommit counts [${counts.join(", ")}]`);
  for (const note of f.notes) console.log(`        note: ${note}`);
}

/** Cross-file checks: the files of one capture must fit together as a light client would use them. */
function checkTogether(loaded: Map<string, Fixture>, r: CaptureResults): void {
  report.heading("cross-file");
  report.check("one chain: every file has the same genesis hash", () => {
    const genesis = new Set([...loaded.values()].map((f) => f.provenance.genesisHash));
    assert(genesis.size === 1, `${genesis.size} different genesis hashes`);
    return [...genesis][0];
  });
  const { finality, setChange, authoritySet, storage } = r;
  if (finality && storage) {
    report.check("account proof is at the finality-proof block", () => {
      assert(storage.fixture.header.hash === finality.fixture.header.hash, "different blocks");
      assert(storage.fixture.header.stateRoot === finality.fixture.header.stateRoot, "different state roots");
      return `#${fmt(finality.fixture.header.number)}, state_root ${shortHex(finality.fixture.header.stateRoot)}`;
    });
  }
  if (finality && authoritySet) {
    report.check("authority set is at the finality-proof block", () => {
      assert(authoritySet.fixture.authoritySet.at.hash === finality.fixture.header.hash, "different blocks");
      if (authoritySet.fixture.authoritySet.setId === finality.fixture.signingSet.setId) {
        assert(sameAuthorities(authoritySet.fixture.authoritySet.authorities, finality.fixture.signingSet.authorities), "same set id, different keys");
      }
      return `set ${authoritySet.fixture.authoritySet.setId}`;
    });
  }
  if (setChange && authoritySet) {
    report.check("latest set change leads to the current set", () => {
      assert(setChange.fixture.newSetId === authoritySet.fixture.authoritySet.setId, `change to set ${setChange.fixture.newSetId}, current set ${authoritySet.fixture.authoritySet.setId}`);
      assert(sameAuthorities(setChange.fixture.scheduledChange.nextAuthorities ?? [], authoritySet.fixture.authoritySet.authorities), "next authorities differ from the current list");
      return `set ${setChange.fixture.signingSet.setId} -> ${setChange.fixture.newSetId} at #${fmt(setChange.fixture.header.number)}`;
    });
  }
  const head = finality?.checked;
  if (setChange && head) {
    report.check("light-client path: checkpoint -> set change -> head", () => {
      // Start from the outgoing set, import the set-change header, move to the announced set,
      // then accept the head's justification under that set alone.
      const sc = setChange.fixture;
      const outgoing = sc.signingSet.authorities.map((a) => hexToBytes(a.id));
      const changeJ = decodeJustification(hexToBytes(sc.justification.scale));
      assert(verifyJustification(changeJ, outgoing, BigInt(sc.signingSet.setId)).ok, "set-change justification fails under the outgoing set");
      const next = (sc.scheduledChange.nextAuthorities ?? []).map((a) => hexToBytes(a.id));
      assert(sc.header.number <= head.header.number, "set change is after the head");
      const result = verifyJustification(head.justification, next, BigInt(sc.newSetId));
      assert(result.ok, `head justification fails under the announced set: ${result.problems.join("; ")}`);
      const checkpoints = `#${fmt(sc.parentHeader.number)}${sc.signingSet.announced ? ` or #${fmt(sc.signingSet.announced.header.number)}` : ""}`;
      return `set ${sc.signingSet.setId} (checkpoint ${checkpoints}) -> #${fmt(sc.header.number)} -> set ${sc.newSetId} -> head #${fmt(head.header.number)} (${result.valid}/${result.required})`;
    });
  }
}

try {
  main();
} catch (error) {
  console.error(`check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
