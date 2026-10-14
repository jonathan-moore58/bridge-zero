// Re-verifies captured fixtures off-chain, with no network access:
//   - every header decodes completely and blake2_256 of its SCALE bytes is the block hash;
//   - every precommit's ed25519 signature verifies over the 53-byte payload
//     0x01 ‖ target hash ‖ u32le number ‖ u64le round ‖ u64le set_id, under the recorded set,
//     and the threshold N - floor((N - 1) / 3) is met;
//   - the read proof walks from the header's state_root to the stored value, and a one-byte
//     flip in any proof node makes the walk fail;
//   - tampered inputs fail: a signature byte, set_id +/- 1, round + 1, too few or duplicated
//     precommits, a header byte;
//   - the files fit together the way a light client would use them.
//
//   npm run check -- [--dir <fixtures dir>]

import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { bytesToHex, equalBytes, flipByte, hexToBytes, leToBigInt, shortHex } from "./bytes.js";
import type {
  AuthorityJson,
  AuthoritySetFixture,
  AuthoritySetJson,
  FinalityProofFixture,
  Fixture,
  HeaderJson,
  IndexFixture,
  JustifiedHeaderFixture,
  SetChangeFixture,
  StorageProofFixture,
} from "./fixture.js";
import { readJson } from "./fixture.js";
import { precommitPayload, threshold, verifyJustification } from "./grandpa.js";
import { blake2_256, GRANDPA_AUTHORITIES_KEY, storageKey, systemAccountKey } from "./hash.js";
import {
  decodeAccountInfo,
  decodeAuthorityList,
  decodeFinalityProof,
  decodeHeader,
  decodeJustification,
  decodeU64,
  decodeVersionedAuthorityList,
  grandpaLogs,
  type Header,
  type Justification,
} from "./scale.js";
import { readProof } from "./trie.js";

const fmt = (n: number) => n.toLocaleString("en-US");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

class Report {
  passed = 0;
  failed = 0;

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

function checkProvenance(f: Fixture): void {
  report.check("provenance header", () => {
    const p = f.provenance;
    assert(typeof p.rpc === "string" && /^wss?:\/\/|^https?:\/\//.test(p.rpc), "rpc url missing");
    assert(hexToBytes(p.genesisHash).length === 32, "genesis hash is not 32 bytes");
    assert(Number.isInteger(p.runtime?.specVersion), "runtime spec version missing");
    assert(Number.isInteger(p.block?.number) && hexToBytes(p.block.hash).length === 32, "block number or hash missing");
    assert(Number.isInteger(p.setId), "set_id missing");
    assert(/Z$/.test(p.capturedAt) && !Number.isNaN(Date.parse(p.capturedAt)), "capture time is not a UTC timestamp");
    assert(p.tool?.name && p.tool.version, "tool version missing");
    return `${p.chain}, ${p.runtime.specName} ${p.runtime.specVersion}, #${fmt(p.block.number)}, set ${p.setId}, ${p.capturedAt}, ${p.tool.name} ${p.tool.version}`;
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

function checkAuthoritySet(s: AuthoritySetJson, label: string): CheckedSet | undefined {
  return step(`${label}: authority list and set id`, () => {
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
    assert(f.signingSet.at.hash === bytesToHex(header.parentHash) && f.signingSet.at.number === header.number - 1, "signing set was not read at the parent block");
    return "signing set read at the parent block";
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

function checkFinalityProof(f: FinalityProofFixture): ReturnType<typeof checkJustifiedHeader> {
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
      assert(f.signingSet.at.hash === f.parentHeader.hash, "signing set was not read at this parent");
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
  report.check(":grandpa_authorities matches the runtime call", () => {
    assert(f.wellKnownKey.key === bytesToHex(GRANDPA_AUTHORITIES_KEY), "key is not :grandpa_authorities");
    assert(f.wellKnownKey.scale, "value missing");
    const { version, authorities } = decodeVersionedAuthorityList(hexToBytes(f.wellKnownKey.scale));
    const list: AuthorityJson[] = authorities.map((a) => ({ id: bytesToHex(a.id), weight: Number(a.weight) }));
    assert(sameAuthorities(list, f.authoritySet.authorities), "lists differ");
    return `version ${version}, same ${list.length} keys in the same order`;
  });
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
    return `${nodes.length} nodes (${sizes.join(", ")} B; ${fmt(f.proof.bytes)} B total), all used, root ${shortHex(header.stateRoot)}`;
  });
  report.check("value decodes as AccountInfo", () => {
    const info = decodeAccountInfo(value);
    const d = f.value.decoded;
    assert(value.length === 80 && f.value.bytes === 80, `value is ${value.length} B`);
    assert(d.nonce === info.nonce && d.providers === info.providers && d.free === info.free.toString() && d.reserved === info.reserved.toString(), "decoded fields differ");
    return `nonce ${info.nonce}, providers ${info.providers}, free ${info.free} (base units)`;
  });
  report.check("one-byte flips in the proof are rejected", () => {
    // What a walk proves: the value it reaches, or null if it fails or shows the key absent.
    const proven = (root: Uint8Array, proof: Uint8Array[], k: Uint8Array): Uint8Array | null => {
      try {
        return readProof(root, proof, k).value;
      } catch {
        return null;
      }
    };
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
    report.heading(`${file}  [${f.kind}]  #${fmt(p?.block?.number ?? 0)} ${shortHex(p?.block?.hash ?? "0x")}  set ${p?.setId}`);
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
      case "index":
        checkIndex(f, loaded);
        break;
      default:
        report.check("known fixture kind", () => assert(false, `unknown kind ${(f as { kind: string }).kind}`));
    }
  }

  checkTogether(loaded, results);

  console.log(`\n${report.failed === 0 ? "All checks passed" : "Some checks FAILED"}: ${report.passed} passed, ${report.failed} failed.`);
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
      return `set ${sc.signingSet.setId} (checkpoint #${fmt(sc.parentHeader.number)}) -> #${fmt(sc.header.number)} -> set ${sc.newSetId} -> head #${fmt(head.header.number)} (${result.valid}/${result.required})`;
    });
  }
}

try {
  main();
} catch (error) {
  console.error(`check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
