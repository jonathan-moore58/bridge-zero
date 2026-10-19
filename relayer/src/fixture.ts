// The JSON fixture format written by capture.ts, capture-contract.ts and mint.ts (a mint bundle)
// and read by check.ts. Every file starts with a provenance header. Every chain item keeps its raw
// SCALE bytes as hex ("scale") next to the decoded fields, so tests can feed the exact bytes a
// relayer would submit.

import { readFileSync, writeFileSync } from "node:fs";
import { bytesToHex, toSafeNumber, type Hex } from "./bytes.js";
import { threshold } from "./grandpa.js";
import type { Authority, GrandpaLog, Header, Justification } from "./scale.js";

export interface BlockRef {
  number: number;
  hash: Hex;
}

export interface RuntimeInfo {
  specName: string;
  specVersion: number;
  implName: string;
  implVersion: number;
  transactionVersion: number;
  /** Reported only by runtimes new enough to have state versions; older ones use trie V0. */
  stateVersion?: number;
  /**
   * Set when the node no longer had the state of the block this describes: the version was read
   * at this later block instead. Unless upgradedAfter is set, no header after the block up to it
   * carries RuntimeEnvironmentUpdated, so this is the block's version.
   */
  readAt?: BlockRef;
  /** The first block after this one that upgraded the runtime: the version read at readAt is newer than the block's. */
  upgradedAfter?: number;
}

export interface ToolInfo {
  name: string;
  version: string;
  script: string;
  /** Repository HEAD when the capture ran, and whether the relayer sources differed from it. */
  gitCommit: string | null;
  gitDirty: boolean | null;
}

export interface Provenance {
  chain: string;
  rpc: string;
  genesisHash: Hex;
  runtime: RuntimeInfo;
  /** The block this file's data was read at. */
  block: BlockRef;
  /** The GRANDPA set relevant to the file: for a justification, the set that signed it. */
  setId: number;
  capturedAt: string;
  tool: ToolInfo;
}

export interface DigestItemJson {
  kind: string;
  engine?: string;
  bytes: number;
  scale: Hex;
}

export interface HeaderJson {
  hash: Hex;
  number: number;
  parentHash: Hex;
  stateRoot: Hex;
  extrinsicsRoot: Hex;
  digest: DigestItemJson[];
  bytes: number;
  scale: Hex;
}

export interface PrecommitJson {
  /** Position of the signer in the signing set's authority list (-1 if absent). */
  authorityIndex: number;
  authorityId: Hex;
  targetHash: Hex;
  targetNumber: number;
  signature: Hex;
}

export interface JustificationJson {
  round: number;
  targetHash: Hex;
  targetNumber: number;
  precommits: PrecommitJson[];
  votesAncestries: number;
  bytes: number;
  scale: Hex;
}

export interface AuthorityJson {
  id: Hex;
  weight: number;
}

/** The FRNK change log that started an authority set, and the header that carries it. */
export interface AnnouncedJson {
  header: HeaderJson;
  scheduledChange: GrandpaLogJson;
}

export interface AuthoritySetJson {
  setId: number;
  /**
   * The block whose state holds this set: where it was read, or, for a set known only from its
   * change log (no setIdStorage), the block that carries that log.
   */
  at: BlockRef;
  count: number;
  threshold: number;
  authorities: AuthorityJson[];
  /** Grandpa.CurrentSetId at `at`: storage key and raw u64 value. Absent if the node no longer had that state. */
  setIdStorage?: { key: Hex; scale: Hex };
  /** state_call GrandpaApi_grandpa_authorities at `at`: raw Vec<(AuthorityId, u64)>. Absent if the node no longer had that state. */
  runtimeCall?: { method: string; scale: Hex };
  /**
   * The change that started this set. The keys are in its log; the set id is not, and comes from
   * counting change logs back from a block whose state was read; the signatures checked under
   * the set confirm both. The header is a checkpoint for a light client that starts with this
   * set. Present in set-change captures whenever the scan of headers reached that change, and
   * wherever the state was gone.
   */
  announced?: AnnouncedJson;
}

/** An authority set read from chain state. */
export type StateAuthoritySetJson = AuthoritySetJson & Required<Pick<AuthoritySetJson, "setIdStorage" | "runtimeCall">>;

export type FixtureKind =
  | "index"
  | "finality-proof"
  | "justification"
  | "stored-justification"
  | "set-change"
  | "authority-set"
  | "storage-proof"
  | "contract-storage"
  | "mint-bundle";

export interface FixtureBase {
  provenance: Provenance;
  kind: FixtureKind;
  about: string;
}

/** A header with the justification that finalizes it and the set that signed it. */
export interface JustifiedHeaderFixture extends FixtureBase {
  kind: "finality-proof" | "justification" | "stored-justification" | "set-change" | "mint-bundle";
  source: Record<string, unknown>;
  header: HeaderJson;
  justification: JustificationJson;
  signingSet: AuthoritySetJson;
}

/** grandpa_proveFinality's FinalityProof for the header: the block, the justification as Vec<u8>, and unknown headers. */
export interface FinalityProofJson {
  block: Hex;
  justificationBytes: number;
  unknownHeaders: number;
  bytes: number;
  scale: Hex;
}

export interface FinalityProofFixture extends JustifiedHeaderFixture {
  kind: "finality-proof";
  finalityProof: FinalityProofJson;
}

export interface GrandpaLogJson {
  kind: GrandpaLog["kind"];
  delay?: number;
  median?: number;
  nextAuthorities?: AuthorityJson[];
  /** The FRNK consensus log payload (ConsensusLog SCALE). */
  bytes: number;
  scale: Hex;
}

export interface SetChangeFixture extends JustifiedHeaderFixture {
  kind: "set-change";
  newSetId: number;
  scheduledChange: GrandpaLogJson;
  /**
   * The block before the change: a checkpoint header inside the outgoing set. signingSet.announced,
   * when present, holds another one: the change before this one, where the outgoing set starts.
   */
  parentHeader: HeaderJson;
}

export interface AuthoritySetFixture extends FixtureBase {
  kind: "authority-set";
  authoritySet: StateAuthoritySetJson;
  /** The same list under the well-known storage key, as a cross-check. */
  wellKnownKey: { key: Hex; scale: Hex | null };
  /**
   * The same list in Grandpa.Authorities (no version byte), where newer runtimes keep it instead
   * of under the well-known key. Not in captures made before it was added.
   */
  palletStorage?: { key: Hex; scale: Hex | null };
}

export interface StorageProofFixture extends FixtureBase {
  kind: "storage-proof";
  source: Record<string, unknown>;
  /** The header whose state_root the proof is checked against. */
  header: HeaderJson;
  trieVersion: 0 | 1;
  account: { id: Hex; source: string };
  key: { pallet: string; item: string; hasher: string; bytes: number; hex: Hex };
  value: { bytes: number; scale: Hex; decoded: Record<string, string | number> };
  proof: { count: number; bytes: number; nodeBytes: number[]; nodes: Hex[] };
}

/** Proof items in the order the node served them. */
export interface ProofJson {
  method: string;
  count: number;
  bytes: number;
  nodeBytes: number[];
  nodes: Hex[];
}

/**
 * Provenance of a contract-storage capture, which also reads an EVM RPC. setId is
 * Grandpa.CurrentSetId at the block as state_getStorage returned it, without a proof (check.ts
 * prints it as not proven), or null on a chain without GRANDPA of its own (a parachain), where
 * check.ts requires null.
 */
export interface ContractProvenance extends Omit<Provenance, "setId"> {
  evmRpc: string;
  setId: number | null;
}

/** The key of a pallet storage item: twox128(pallet) ++ twox128(item) ++ the hashed map key. */
export interface StorageKeyJson {
  pallet: string;
  item: string;
  hasher: string;
  bytes: number;
  hex: Hex;
}

/**
 * The block an EVM RPC call was asked at: the EVM block's hash (EIP-1898), or its number (a
 * QUANTITY, hex without leading zeros) where the RPC refused the hash.
 */
export type EvmBlockParam = Hex | { blockHash: Hex };

/**
 * How the EVM RPC's block is B. "substrate-block": its hash, parent hash and state root are B's (an
 * eth-rpc that serves Substrate blocks). "revive-block-hash": it is the Ethereum block the runtime
 * built for B (an eth-rpc that serves those blocks): its hash is Revive.BlockHash(B) and its parent
 * hash Revive.BlockHash(B - 1), both proven at B, and its state root is the empty-trie root, a
 * placeholder (revive.ts, EMPTY_TRIE_ROOT).
 */
export type EvmBlockRelation = "substrate-block" | "revive-block-hash";

/**
 * One storage slot of a pallet-revive contract (see revive.ts), proven from a block's state_root
 * (Revive.AccountInfoOf, Revive.CodeInfoOf, the child trie's root, the slot in the child trie), and
 * the EVM RPC's eth_getCode and eth_getStorageAt at the same block, which Revive.BlockHash ties to it.
 */
export interface ContractStorageFixture {
  provenance: ContractProvenance;
  kind: "contract-storage";
  about: string;
  node: { version: string };
  /** The block every proof was read at; they start from its state_root. */
  header: HeaderJson;
  trieVersion: 0 | 1;
  /** Revive.AccountInfoOf(address): makes the address a contract and names its trie id and code hash. */
  account: {
    address: Hex;
    key: StorageKeyJson;
    value: { bytes: number; scale: Hex; decoded: Record<string, string | number> };
    proof: ProofJson;
  };
  /** Revive.CodeInfoOf(code hash): the code's type (EVM or PolkaVM) and length. */
  codeInfo: {
    key: StorageKeyJson;
    value: { bytes: number; scale: Hex; decoded: Record<string, string | number> };
    proof: ProofJson;
  };
  /**
   * The code eth_getCode returns at the EVM block. Its keccak-256 is the code hash in the account
   * entry; its length and kind are the code_len and code_type of the CodeInfoOf entry.
   */
  code: { method: string; params: [Hex, EvmBlockParam]; kind: "evm" | "pvm"; bytes: number; keccak256: Hex; hex: Hex };
  /** The root of the contract's child trie, in the main trie under ":child_storage:default:" ++ trie id. */
  childRoot: { key: { prefix: string; bytes: number; hex: Hex }; root: Hex; proof: ProofJson };
  slot: {
    /** The 32-byte storage key: the slot number, big-endian. */
    index: Hex;
    /** What the slot holds, as given on the command line (--label). Not checked. */
    label?: { text: string; source: string };
    key: { hasher: string; hex: Hex };
    value: { bytes: number; hex: Hex };
    /**
     * The child-trie items of state_getChildReadProof. The node also serves the main-trie items
     * that lead to the child root: served.mainTrieItems of them, exactly the items of childRoot.proof.
     */
    proof: ProofJson & { served: { count: number; bytes: number; mainTrieItems: number } };
  };
  evm: {
    chainId: Hex;
    clientVersion: string | null;
    relation: EvmBlockRelation;
    /** Revive.BlockHash(B) at B: the hash of the Ethereum block the runtime built for B. */
    reviveBlockHash: { key: StorageKeyJson; value: Hex; proof: ProofJson };
    /** Revive.BlockHash(B - 1) at B: the hash of the Ethereum block before it, its parent hash. */
    reviveParentBlockHash: { key: StorageKeyJson; value: Hex; proof: ProofJson };
    /** The EVM RPC's block with the header's number; `relation` says how it is B. */
    block: { method: string; number: number; hash: Hex; parentHash: Hex; stateRoot: Hex };
    /**
     * eth_getStorageAt(address, slot as a QUANTITY, EVM block) and how its word relates to the
     * proven value. A value of fewer than 32 zero bytes, left-padded, reads like an unset slot.
     */
    storageAt: { method: string; params: [Hex, Hex, EvmBlockParam]; result: Hex; matches: "equal" | "left-padded" };
  };
  notes: string[];
}

/**
 * Everything one BridgeMinter.importAndMint needs for one lock of PortaldotVault, read at one
 * finalized V3 block B (mint.ts): B's header with its finality proof and the set that signed it
 * (read at the parent block, as a finality-proof capture does), the signers hint the light client
 * takes, B's parent header (the checkpoint a fresh client starts from to import B), and the three
 * storage proofs under B's state_root: Revive.AccountInfoOf(vault) in the main trie, the root of
 * the vault's child trie, and commitments[nonce] in the child trie, whose value is the lock's
 * commitment recomputed from the lock. check.ts verifies the file again offline.
 */
export interface MintBundleFixture extends JustifiedHeaderFixture {
  kind: "mint-bundle";
  node: { version: string };
  finalityProof: FinalityProofJson;
  /**
   * The signers hint of the import: 2 bytes per counted precommit (its position in the
   * justification, the signer's index in the signing set), exactly the threshold, in increasing
   * index, each signature checked with the client's own check (grandpa.ts clientVerifies).
   */
  signers: { hint: Hex; count: number; threshold: number };
  /** B's parent: a checkpoint header inside the signing set, from which a fresh light client imports B. */
  parentHeader: HeaderJson;
  trieVersion: 0 | 1;
  /** The vault on V3, as its proven AccountInfoOf entry describes it; chainId is V3's, part of every commitment. */
  vault: { address: Hex; chainId: number; codeHash: Hex; trieId: Hex };
  /** The lock the bundle proves, as the vault's record or its Locked log describes it. */
  lock: {
    nonce: number;
    recipient: Hex;
    amountNative: string;
    dstChainId: string;
    dstMinter: Hex;
    commitment: Hex;
    source: string;
    txHash?: Hex;
  };
  /** Revive.AccountInfoOf(vault): makes the address a contract and names its trie id and code hash. */
  account: {
    key: StorageKeyJson;
    value: { bytes: number; scale: Hex; decoded: Record<string, string | number> };
    proof: ProofJson;
  };
  /** The root of the vault's child trie, in the main trie under ":child_storage:default:" ++ trie id. */
  childRoot: { key: { prefix: string; bytes: number; hex: Hex }; root: Hex; proof: ProofJson };
  /** commitments[nonce]: the slot's index, keccak256(abi.encode(nonce, 0)), under blake2_256(index) in the child trie. */
  slot: {
    index: Hex;
    key: { hasher: string; hex: Hex };
    value: { bytes: number; hex: Hex };
    /** The child-trie items of state_getChildReadProof; served.mainTrieItems are exactly the items of childRoot.proof. */
    proof: ProofJson & { served: { count: number; bytes: number; mainTrieItems: number } };
  };
  notes: string[];
}

export interface IndexEntry {
  file: string;
  kind: FixtureKind;
  block: number;
  setId: number;
  summary: string;
}

export interface SeenJustification {
  number: number;
  hash: Hex;
  round: number;
  precommits: number;
  bytes: number;
  receivedAt: string;
}

export interface IndexFixture extends FixtureBase {
  kind: "index";
  node: { version: string };
  chainProperties: Record<string, unknown>;
  files: IndexEntry[];
  watch: { method: string; seconds: number; minPrecommits: number; seen: SeenJustification[] };
  notes: string[];
}

export type Fixture =
  | IndexFixture
  | FinalityProofFixture
  | SetChangeFixture
  | (JustifiedHeaderFixture & { kind: "justification" | "stored-justification" })
  | AuthoritySetFixture
  | StorageProofFixture
  | ContractStorageFixture
  | MintBundleFixture;

// ---------------------------------------------------------------------------------------
// Builders

export function headerJson(header: Header, hash: Uint8Array): HeaderJson {
  return {
    hash: bytesToHex(hash),
    number: header.number,
    parentHash: bytesToHex(header.parentHash),
    stateRoot: bytesToHex(header.stateRoot),
    extrinsicsRoot: bytesToHex(header.extrinsicsRoot),
    digest: header.digest.map((d) => ({
      kind: d.kind,
      ...(d.engine === undefined ? {} : { engine: d.engine }),
      bytes: d.encoded.length,
      scale: bytesToHex(d.encoded),
    })),
    bytes: header.encoded.length,
    scale: bytesToHex(header.encoded),
  };
}

export function authoritiesJson(list: Authority[]): AuthorityJson[] {
  return list.map((a) => ({ id: bytesToHex(a.id), weight: toSafeNumber(a.weight, "authority weight") }));
}

export function justificationJson(j: Justification, scale: Uint8Array, signers: Authority[]): JustificationJson {
  const indexOf = new Map(signers.map((a, i) => [bytesToHex(a.id), i] as const));
  return {
    round: toSafeNumber(j.round, "round"),
    targetHash: bytesToHex(j.targetHash),
    targetNumber: j.targetNumber,
    precommits: j.precommits.map((p) => ({
      authorityIndex: indexOf.get(bytesToHex(p.id)) ?? -1,
      authorityId: bytesToHex(p.id),
      targetHash: bytesToHex(p.targetHash),
      targetNumber: p.targetNumber,
      signature: bytesToHex(p.signature),
    })),
    votesAncestries: j.votesAncestries.length,
    bytes: scale.length,
    scale: bytesToHex(scale),
  };
}

export function authoritySetJson(args: {
  setId: bigint;
  at: BlockRef;
  authorities: Authority[];
  setIdKey: Uint8Array;
  setIdScale: Uint8Array;
  runtimeCallScale: Uint8Array;
}): StateAuthoritySetJson {
  return {
    setId: toSafeNumber(args.setId, "set id"),
    at: args.at,
    count: args.authorities.length,
    threshold: threshold(args.authorities.length),
    authorities: authoritiesJson(args.authorities),
    setIdStorage: { key: bytesToHex(args.setIdKey), scale: bytesToHex(args.setIdScale) },
    runtimeCall: { method: "GrandpaApi_grandpa_authorities", scale: bytesToHex(args.runtimeCallScale) },
  };
}

/** The change log `log` (payload `payload`) in `header` (hash `hash`), which starts a set. */
export function announcedJson(header: Header, hash: Uint8Array, log: GrandpaLog, payload: Uint8Array): AnnouncedJson {
  if (log.kind !== "ScheduledChange" && log.kind !== "ForcedChange") throw new Error(`a ${log.kind} log does not start a set`);
  return { header: headerJson(header, hash), scheduledChange: grandpaLogJson(log, payload) };
}

/** A set known only from the change log that started it (see AuthoritySetJson.announced). */
export function announcedSetJson(setId: bigint, header: Header, hash: Uint8Array, log: GrandpaLog, payload: Uint8Array): AuthoritySetJson {
  const announced = announcedJson(header, hash, log, payload);
  const authorities = announced.scheduledChange.nextAuthorities ?? [];
  return {
    setId: toSafeNumber(setId, "set id"),
    at: { number: header.number, hash: bytesToHex(hash) },
    count: authorities.length,
    threshold: threshold(authorities.length),
    authorities,
    announced,
  };
}

/** Proof items, as `method` served them. */
export function proofJson(method: string, nodes: Uint8Array[]): ProofJson {
  const nodeBytes = nodes.map((n) => n.length);
  return { method, count: nodes.length, bytes: nodeBytes.reduce((a, b) => a + b, 0), nodeBytes, nodes: nodes.map((n) => bytesToHex(n)) };
}

export function grandpaLogJson(log: GrandpaLog, payload: Uint8Array): GrandpaLogJson {
  const base = { kind: log.kind, bytes: payload.length, scale: bytesToHex(payload) };
  switch (log.kind) {
    case "ScheduledChange":
      return { kind: log.kind, delay: log.delay, nextAuthorities: authoritiesJson(log.nextAuthorities), bytes: base.bytes, scale: base.scale };
    case "ForcedChange":
      return { kind: log.kind, median: log.median, delay: log.delay, nextAuthorities: authoritiesJson(log.nextAuthorities), bytes: base.bytes, scale: base.scale };
    default:
      return base;
  }
}

export function writeJson(path: string, data: unknown): number {
  const text = `${JSON.stringify(data, null, 2)}\n`;
  writeFileSync(path, text, "utf8");
  return Buffer.byteLength(text);
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
