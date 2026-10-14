// Captures Portaldot mainnet fixtures for the light client tests. Read-only: it queries an
// RPC node and writes JSON files; it never signs or sends anything.
//
//   npm run capture -- [--rpc <wss url>] [--out <dir>] [--watch <seconds>] [--account <0x 32-byte id>]
//
// Files (each with a provenance header; every chain item also as raw SCALE hex):
//   finality-proof-head.json         grandpa_proveFinality at the finalized head B, and B's header
//   justification-<n>-precommits.json  a subscription justification with 8+ precommits, if one arrives in time
//   authority-set.json               GrandpaApi_grandpa_authorities and Grandpa.CurrentSetId at B
//   set-change.json                  the latest FRNK ScheduledChange header with its stored justification
//   stored-justification-512.json    a justification the node stores every 512 blocks (chain_getBlock)
//   account-proof.json               a System.Account read proof at B
//   index.json                       the list above, the justifications seen while watching, and notes

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { bytesToHex, equalBytes, hexToBytes, shortHex, toSafeNumber, type Hex } from "./bytes.js";
import {
  authoritySetJson,
  grandpaLogJson,
  headerJson,
  justificationJson,
  writeJson,
  type AuthoritySetFixture,
  type AuthoritySetJson,
  type BlockRef,
  type FinalityProofFixture,
  type FixtureKind,
  type IndexEntry,
  type IndexFixture,
  type JustifiedHeaderFixture,
  type Provenance,
  type RuntimeInfo,
  type SeenJustification,
  type SetChangeFixture,
  type StorageProofFixture,
  type ToolInfo,
} from "./fixture.js";
import { verifyJustification } from "./grandpa.js";
import { blake2_256, GRANDPA_AUTHORITIES_KEY, storageKey, systemAccountKey } from "./hash.js";
import { RpcClient, type Subscription } from "./rpc.js";
import {
  decodeAccountInfo,
  decodeAuthorityList,
  decodeFinalityProof,
  decodeHeader,
  decodeJustification,
  decodeU64,
  encodeRpcHeader,
  GRANDPA_ENGINE,
  grandpaLogs,
  type Authority,
  type Header,
  type Justification,
  type RpcHeader,
} from "./scale.js";
import { readProof } from "./trie.js";

const DEFAULT_RPC = "wss://mainnet.portaldot.io";
const DEFAULT_WATCH_SECONDS = 360;
const MIN_EXTRA_PRECOMMITS = 8;
const JUSTIFICATION_PERIOD = 512;
const SET_ID_KEY = storageKey("Grandpa", "CurrentSetId");
const SUDO_KEY = storageKey("Sudo", "Key");

const log = (message: string) => console.log(message);
const now = () => new Date().toISOString();
const fmt = (n: number) => n.toLocaleString("en-US");

// ---------------------------------------------------------------------------------------
// Chain access

interface SetAt {
  setId: bigint;
  authorities: Authority[];
  json: AuthoritySetJson;
}

/** A header with the justification that finalizes it, and the set that signed it. */
interface Justified {
  header: Header;
  hash: Uint8Array;
  justification: Justification;
  scale: Uint8Array;
  signing: SetAt;
}

/** Turns RPC byte fields into bytes: hex strings, or number arrays (as this node's chain_getBlock returns). */
function rpcBytes(value: unknown): Uint8Array {
  if (typeof value === "string") return hexToBytes(value);
  if (Array.isArray(value) && value.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) return Uint8Array.from(value as number[]);
  throw new Error(`unexpected byte encoding in RPC result: ${JSON.stringify(value).slice(0, 40)}`);
}

function engineId(value: unknown): string {
  if (typeof value === "string" && !value.startsWith("0x")) return value;
  return String.fromCharCode(...rpcBytes(value));
}

class Chain {
  private readonly runtimes = new Map<string, RuntimeInfo>();

  constructor(readonly rpc: RpcClient) {}

  async blockHash(number: number): Promise<Hex> {
    const hash = await this.rpc.request<Hex | null>("chain_getBlockHash", [number]);
    if (!hash) throw new Error(`no block #${number}`);
    return hash;
  }

  /** chain_getHeader, re-encoded to SCALE; refuses it unless blake2_256 of the bytes is the block hash. */
  async header(hash: Hex): Promise<Header> {
    const json = await this.rpc.request<RpcHeader | null>("chain_getHeader", [hash]);
    if (!json) throw new Error(`no header for ${hash}`);
    const header = decodeHeader(encodeRpcHeader(json));
    const computed = bytesToHex(blake2_256(header.encoded));
    if (computed !== hash.toLowerCase()) throw new Error(`header ${hash} re-encodes to a different hash ${computed}`);
    return header;
  }

  async storage(key: Uint8Array, at: Hex): Promise<Uint8Array | null> {
    const value = await this.rpc.request<Hex | null>("state_getStorage", [bytesToHex(key), at]);
    return value === null ? null : hexToBytes(value);
  }

  async setIdAt(at: Hex): Promise<{ setId: bigint; scale: Uint8Array }> {
    const scale = await this.storage(SET_ID_KEY, at);
    if (!scale) throw new Error(`Grandpa.CurrentSetId is empty at ${at}`);
    return { setId: decodeU64(scale, "Grandpa.CurrentSetId"), scale };
  }

  async setIdAtNumber(number: number): Promise<bigint> {
    return (await this.setIdAt(await this.blockHash(number))).setId;
  }

  async authoritySet(at: BlockRef): Promise<SetAt> {
    const { setId, scale: setIdScale } = await this.setIdAt(at.hash);
    const runtimeCallScale = hexToBytes(await this.rpc.request<Hex>("state_call", ["GrandpaApi_grandpa_authorities", "0x", at.hash]));
    const authorities = decodeAuthorityList(runtimeCallScale);
    return { setId, authorities, json: authoritySetJson({ setId, at, authorities, setIdKey: SET_ID_KEY, setIdScale, runtimeCallScale }) };
  }

  async runtime(at: Hex): Promise<RuntimeInfo> {
    const cached = this.runtimes.get(at);
    if (cached) return cached;
    const v = await this.rpc.request<Record<string, unknown>>("state_getRuntimeVersion", [at]);
    const info: RuntimeInfo = {
      specName: String(v.specName),
      specVersion: Number(v.specVersion),
      implName: String(v.implName),
      implVersion: Number(v.implVersion),
      transactionVersion: Number(v.transactionVersion),
      ...(v.stateVersion === undefined ? {} : { stateVersion: Number(v.stateVersion) }),
    };
    this.runtimes.set(at, info);
    return info;
  }

  /** The GRANDPA justification stored with a block (chain_getBlock), or null if it has none. */
  async storedJustification(hash: Hex): Promise<Uint8Array | null> {
    const block = await this.rpc.request<{ justifications?: unknown; justification?: unknown } | null>("chain_getBlock", [hash]);
    if (!block) throw new Error(`no block ${hash}`);
    if (Array.isArray(block.justifications)) {
      for (const entry of block.justifications as unknown[]) {
        if (Array.isArray(entry) && entry.length === 2 && engineId(entry[0]) === GRANDPA_ENGINE) return rpcBytes(entry[1]);
      }
      return null;
    }
    // Nodes from before multiple justifications return a single GRANDPA one.
    return block.justification ? rpcBytes(block.justification) : null;
  }

  /**
   * Decodes a justification, fetches the header it finalizes and the set that signed it, and
   * verifies it, so that a capture never writes data that does not check out.
   *
   * The signing set is read from the parent block's state. A block is finalized by the set in
   * force before it executes; at a set-change block the new set id is already in the block's
   * own state, but the block itself is still finalized by the outgoing set.
   */
  async justified(scale: Uint8Array): Promise<Justified> {
    const justification = decodeJustification(scale);
    const header = await this.header(bytesToHex(justification.targetHash));
    if (header.number !== justification.targetNumber) {
      throw new Error(`justification targets #${justification.targetNumber}, header is #${header.number}`);
    }
    const signing = await this.authoritySet({ number: header.number - 1, hash: bytesToHex(header.parentHash) });
    const result = verifyJustification(justification, signing.authorities.map((a) => a.id), signing.setId);
    if (!result.ok) throw new Error(`justification for #${header.number} does not verify: ${result.problems.join("; ")}`);
    return { header, hash: justification.targetHash, justification, scale, signing };
  }
}

// ---------------------------------------------------------------------------------------
// Justification subscription

interface Heard extends SeenJustification {
  scale: Uint8Array;
}

class JustificationWatch {
  readonly heard: Heard[] = [];
  readonly startedAt = Date.now();
  private subscription: Subscription | null = null;
  private wake: (() => void) | null = null;

  constructor(private readonly minPrecommits: number) {}

  async start(rpc: RpcClient): Promise<void> {
    this.subscription = await rpc.subscribe<unknown>(
      "grandpa_subscribeJustifications",
      [],
      "grandpa_unsubscribeJustifications",
      (result) => this.onJustification(result),
    );
  }

  private onJustification(result: unknown): void {
    try {
      const scale = rpcBytes(result);
      const j = decodeJustification(scale);
      this.heard.push({
        number: j.targetNumber,
        hash: bytesToHex(j.targetHash),
        round: toSafeNumber(j.round, "round"),
        precommits: j.precommits.length,
        bytes: scale.length,
        receivedAt: now(),
        scale,
      });
      log(`    [watch] justification for #${fmt(j.targetNumber)}: ${j.precommits.length} precommits, ${fmt(scale.length)} B`);
      if (j.precommits.length >= this.minPrecommits) this.wake?.();
    } catch (error) {
      log(`    [watch] could not decode a justification: ${(error as Error).message}`);
    }
  }

  found(): Heard | undefined {
    return this.heard.find((h) => h.precommits >= this.minPrecommits);
  }

  async waitUntil(deadline: number, rpc: RpcClient): Promise<Heard | undefined> {
    while (!this.found() && Date.now() < deadline) {
      if (rpc.closeReason) throw rpc.closeReason;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(deadline - Date.now(), 5_000));
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = null;
    }
    return this.found();
  }

  async stop(): Promise<void> {
    await this.subscription?.unsubscribe();
  }
}

// ---------------------------------------------------------------------------------------
// Capture steps

async function proveFinalityAtHead(chain: Chain): Promise<{ requested: number; scale: Uint8Array }> {
  let requested = (await chain.header(await chain.rpc.request<Hex>("chain_getFinalizedHead"))).number;
  for (let attempt = 1; ; attempt++) {
    const hex = await chain.rpc.request<Hex | null>("grandpa_proveFinality", [requested]);
    if (!hex) throw new Error(`grandpa_proveFinality(${requested}) returned no proof`);
    const scale = hexToBytes(hex);
    const proof = decodeFinalityProof(scale);
    // A proof for a newer block than requested carries the headers in between; ask again
    // at the newer block so the fixture is the plain head case (no unknown headers).
    if (proof.unknownHeaders.length === 0 || attempt === 3) return { requested, scale };
    requested = decodeJustification(proof.justification).targetNumber;
    log(`    finality moved on during the call; asking again at #${fmt(requested)}`);
  }
}

/**
 * The first block whose state holds `setId`. Grandpa.CurrentSetId never decreases, and with
 * delay 0 the change is scheduled and enacted in one block, the one carrying the FRNK log.
 */
async function findSetChange(chain: Chain, headNumber: number, setId: bigint): Promise<number> {
  let hi = headNumber;
  let span = 1024;
  let lo = Math.max(0, hi - span);
  while ((await chain.setIdAtNumber(lo)) >= setId) {
    if (lo === 0) throw new Error(`set ${setId} is already in force at genesis`);
    hi = lo;
    span *= 2;
    lo = Math.max(0, hi - span);
  }
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if ((await chain.setIdAtNumber(mid)) >= setId) hi = mid;
    else lo = mid;
  }
  return hi;
}

async function findPeriodJustification(chain: Chain, headNumber: number, skip: number): Promise<{ number: number; scale: Uint8Array } | null> {
  let base = Math.floor(headNumber / JUSTIFICATION_PERIOD) * JUSTIFICATION_PERIOD;
  for (let periods = 0; periods < 3 && base > 0; periods++, base -= JUSTIFICATION_PERIOD) {
    // Stored at the first block finalized in each period, normally the multiple itself.
    for (let number = base; number <= Math.min(base + 3, headNumber); number++) {
      if (number === skip) continue;
      const scale = await chain.storedJustification(await chain.blockHash(number));
      if (scale) return { number, scale };
    }
  }
  return null;
}

async function pickAccount(chain: Chain, at: Hex, fromCli: string | undefined): Promise<{ id: Uint8Array; source: string }> {
  if (fromCli) {
    const id = hexToBytes(fromCli);
    if (id.length !== 32) throw new Error("--account must be a 32-byte account id in hex");
    return { id, source: "command line" };
  }
  const sudo = await chain.storage(SUDO_KEY, at);
  if (sudo && sudo.length === 32) return { id: sudo, source: "Sudo.Key at the same block" };
  const prefix = storageKey("System", "Account");
  const keys = await chain.rpc.request<Hex[]>("state_getKeysPaged", [bytesToHex(prefix), 1, null, at]);
  if (keys.length === 0) throw new Error("no System.Account entries");
  return { id: hexToBytes(keys[0]).slice(-32), source: "first System.Account key at the same block" };
}

// ---------------------------------------------------------------------------------------
// Main

function toolInfo(): ToolInfo {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { name: string; version: string };
  const relayerDir = fileURLToPath(new URL("..", import.meta.url));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: relayerDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  let gitCommit: string | null = null;
  let gitDirty: boolean | null = null;
  try {
    gitCommit = git("rev-parse", "HEAD");
    gitDirty = git("status", "--porcelain", "--", ".") !== "";
  } catch {
    // not a git checkout, or git is not installed
  }
  return { name: pkg.name, version: pkg.version, script: "src/capture.ts", gitCommit, gitDirty };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      rpc: { type: "string", default: DEFAULT_RPC },
      out: { type: "string", default: fileURLToPath(new URL("../../fixtures/mainnet", import.meta.url)) },
      watch: { type: "string", default: String(DEFAULT_WATCH_SECONDS) },
      account: { type: "string" },
    },
  });
  const rpcUrl = values.rpc;
  const outDir = resolve(values.out);
  const watchSeconds = Number(values.watch);
  if (!Number.isFinite(watchSeconds) || watchSeconds < 0) throw new Error("--watch must be a number of seconds");

  const tool = toolInfo();
  log(`Connecting to ${rpcUrl}`);
  const rpc = await RpcClient.connect(rpcUrl);
  const chain = new Chain(rpc);
  const notes: string[] = [];

  try {
    const chainName = await rpc.request<string>("system_chain");
    const nodeVersion = await rpc.request<string>("system_version");
    const genesisHash = await chain.blockHash(0);
    const chainProperties = await rpc.request<Record<string, unknown>>("system_properties");
    log(`  ${chainName}, genesis ${genesisHash}, node ${nodeVersion}`);

    const provenance = async (block: BlockRef, setId: bigint, capturedAt: string): Promise<Provenance> => ({
      chain: chainName,
      rpc: rpcUrl,
      genesisHash,
      runtime: await chain.runtime(block.hash),
      block,
      setId: toSafeNumber(setId, "set id"),
      capturedAt,
      tool,
    });
    const justifiedJson = (j: Justified) => ({
      header: headerJson(j.header, j.hash),
      justification: justificationJson(j.justification, j.scale, j.signing.authorities),
      signingSet: j.signing.json,
    });
    const refOf = (j: Justified): BlockRef => ({ number: j.header.number, hash: bytesToHex(j.hash) });

    // Listen from the start, so the wait for an 8-precommit justification overlaps the rest.
    const watch = new JustificationWatch(MIN_EXTRA_PRECOMMITS);
    let watching = true;
    try {
      await watch.start(rpc);
      log(`  watching grandpa_subscribeJustifications for up to ${watchSeconds} s`);
    } catch (error) {
      watching = false;
      notes.push(`grandpa_subscribeJustifications failed (${(error as Error).message}); no subscription justification was captured.`);
      log(`  cannot subscribe to justifications: ${(error as Error).message}`);
    }

    // (a) Latest justification at the finalized head, and its header.
    log("(a) finality proof at the finalized head");
    const atA = now();
    const { requested, scale: proofScale } = await proveFinalityAtHead(chain);
    const proof = decodeFinalityProof(proofScale);
    const head = await chain.justified(proof.justification);
    if (!equalBytes(proof.block, head.hash)) throw new Error("finality proof block is not the justified block");
    const B = refOf(head);
    log(`    block #${fmt(B.number)} ${B.hash}: round ${head.justification.round}, set ${head.signing.setId}, ` +
      `${head.justification.precommits.length} precommits, proof ${fmt(proofScale.length)} B, justification ${fmt(head.scale.length)} B, header ${head.header.encoded.length} B`);
    const finality: FinalityProofFixture = {
      provenance: await provenance(B, head.signing.setId, atA),
      kind: "finality-proof",
      about: "grandpa_proveFinality at the finalized head: the latest justification and the header it finalizes, with the authority set that signed it (read at the parent block).",
      source: { method: "grandpa_proveFinality", params: [requested] },
      finalityProof: {
        block: bytesToHex(proof.block),
        justificationBytes: proof.justification.length,
        unknownHeaders: proof.unknownHeaders.length,
        bytes: proofScale.length,
        scale: bytesToHex(proofScale),
      },
      ...justifiedJson(head),
    };

    // (c) Authority set and set id at B.
    log("(c) authority set at the head block");
    const atC = now();
    const current = await chain.authoritySet(B);
    const wellKnown = await chain.storage(GRANDPA_AUTHORITIES_KEY, B.hash);
    const weights = new Set(current.authorities.map((a) => a.weight));
    log(`    set ${current.setId}: ${current.authorities.length} authorities, weights {${[...weights].join(", ")}}, threshold ${current.json.threshold}`);
    if (weights.size !== 1 || !weights.has(1n)) notes.push("Not every authority weight is 1; the light client supports weight 1 only.");
    const authoritySet: AuthoritySetFixture = {
      provenance: await provenance(B, current.setId, atC),
      kind: "authority-set",
      about: "The GRANDPA authority list (state_call GrandpaApi_grandpa_authorities) and Grandpa.CurrentSetId at the head block: the checkpoint data for initializing a light client.",
      authoritySet: current.json,
      wellKnownKey: { key: bytesToHex(GRANDPA_AUTHORITIES_KEY), scale: wellKnown ? bytesToHex(wellKnown) : null },
    };

    // (e) System.Account read proof at B.
    log("(e) System.Account read proof at the head block");
    const atE = now();
    const account = await pickAccount(chain, B.hash, values.account);
    const key = systemAccountKey(account.id);
    const value = await chain.storage(key, B.hash);
    if (!value) throw new Error(`System.Account(${bytesToHex(account.id)}) is empty at #${B.number}`);
    const readProofResult = await rpc.request<{ at: Hex; proof: Hex[] }>("state_getReadProof", [[bytesToHex(key)], B.hash]);
    const nodes = readProofResult.proof.map((n) => hexToBytes(n));
    const read = readProof(head.header.stateRoot, nodes, key);
    if (!read.value || !equalBytes(read.value, value)) throw new Error("read proof does not lead to the value from state_getStorage");
    const runtimeB = await chain.runtime(B.hash);
    const trieVersion = runtimeB.stateVersion === 1 ? 1 : 0;
    const info = decodeAccountInfo(value);
    const nodeBytes = nodes.map((n) => n.length);
    log(`    account ${shortHex(account.id)} (${account.source}): ${nodes.length} nodes, ${fmt(nodeBytes.reduce((a, b) => a + b, 0))} B, value ${value.length} B, free ${info.free}`);
    const accountProof: StorageProofFixture = {
      provenance: await provenance(B, head.signing.setId, atE),
      kind: "storage-proof",
      about: "state_getReadProof for one System.Account entry at the head block, checked against the state_root of that block's header (trie V0 on this chain).",
      source: { method: "state_getReadProof", at: B.hash },
      header: headerJson(head.header, head.hash),
      trieVersion,
      account: { id: bytesToHex(account.id), source: account.source },
      key: { pallet: "System", item: "Account", hasher: "Blake2_128Concat", bytes: key.length, hex: bytesToHex(key) },
      value: {
        bytes: value.length,
        scale: bytesToHex(value),
        decoded: {
          nonce: info.nonce,
          consumers: info.consumers,
          providers: info.providers,
          sufficients: info.sufficients,
          free: info.free.toString(),
          reserved: info.reserved.toString(),
          miscFrozen: info.miscFrozen.toString(),
          feeFrozen: info.feeFrozen.toString(),
        },
      },
      proof: { count: nodes.length, bytes: nodeBytes.reduce((a, b) => a + b, 0), nodeBytes, nodes: readProofResult.proof.map((n) => n.toLowerCase() as Hex) },
    };

    // (d) The most recent set change and its stored justification.
    log("(d) most recent set change");
    const atD = now();
    const changeNumber = await findSetChange(chain, B.number, current.setId);
    const changeHash = await chain.blockHash(changeNumber);
    const stored = await chain.storedJustification(changeHash);
    if (!stored) throw new Error(`set-change block #${changeNumber} has no stored justification`);
    const change = await chain.justified(stored);
    if (bytesToHex(change.hash) !== changeHash.toLowerCase()) throw new Error("stored justification targets another block");
    const changeLog = grandpaLogs(change.header).find((l) => l.log.kind === "ScheduledChange" || l.log.kind === "ForcedChange");
    if (!changeLog) throw new Error(`block #${changeNumber} starts set ${current.setId} but carries no FRNK change log`);
    if (change.signing.setId !== current.setId - 1n) {
      throw new Error(`set-change block is signed by set ${change.signing.setId}, expected ${current.setId - 1n}`);
    }
    if (changeLog.log.kind === "ForcedChange") notes.push(`The latest set change (#${changeNumber}) is a ForcedChange.`);
    const parentHeader = await chain.header(bytesToHex(change.header.parentHash));
    log(`    block #${fmt(changeNumber)} ${changeHash}: ${changeLog.log.kind}, set ${change.signing.setId} -> ${current.setId}, ` +
      `header ${fmt(change.header.encoded.length)} B, FRNK log ${changeLog.item.payload.length} B, justification ${fmt(stored.length)} B (${change.justification.precommits.length} precommits)`);
    const setChange: SetChangeFixture = {
      provenance: await provenance(refOf(change), change.signing.setId, atD),
      kind: "set-change",
      about: "The most recent block carrying a FRNK ScheduledChange, with the justification the node stores for it (chain_getBlock). It is signed by the outgoing set; the set id in the block's own state is already the new one.",
      source: { method: "chain_getBlock", engine: GRANDPA_ENGINE, located: "first block whose Grandpa.CurrentSetId equals the head's set id" },
      newSetId: toSafeNumber(current.setId, "set id"),
      scheduledChange: grandpaLogJson(changeLog.log, changeLog.item.payload),
      ...justifiedJson(change),
      parentHeader: headerJson(parentHeader, change.header.parentHash),
    };

    // Extra: a justification stored on the 512-block period (the catch-up path).
    log("(d+) justification stored on the 512-block period");
    const atP = now();
    let periodFixture: JustifiedHeaderFixture | null = null;
    const period = await findPeriodJustification(chain, B.number, changeNumber);
    if (period) {
      const p = await chain.justified(period.scale);
      log(`    block #${fmt(period.number)}: ${p.justification.precommits.length} precommits, ${fmt(period.scale.length)} B, set ${p.signing.setId}`);
      periodFixture = {
        provenance: await provenance(refOf(p), p.signing.setId, atP),
        kind: "stored-justification",
        about: `A justification the node stores every ${JUSTIFICATION_PERIOD} blocks, read with chain_getBlock.`,
        source: { method: "chain_getBlock", engine: GRANDPA_ENGINE, period: JUSTIFICATION_PERIOD },
        ...justifiedJson(p),
      };
    } else {
      notes.push(`No stored ${JUSTIFICATION_PERIOD}-block-period justification found in the last 3 periods.`);
    }

    // (b) A justification with 8 or more precommits, if one arrives within the watch window.
    const deadline = watch.startedAt + watchSeconds * 1000;
    log(`(b) justification with ${MIN_EXTRA_PRECOMMITS}+ precommits: waiting up to ${Math.max(0, Math.round((deadline - Date.now()) / 1000))} s more`);
    const heard = watching ? await watch.waitUntil(deadline, rpc) : undefined;
    if (watching) await watch.stop();
    let extraFixture: JustifiedHeaderFixture | null = null;
    if (heard) {
      const x = await chain.justified(heard.scale);
      log(`    block #${fmt(heard.number)}: ${heard.precommits} precommits, ${fmt(heard.bytes)} B, round ${heard.round}, set ${x.signing.setId}`);
      extraFixture = {
        provenance: await provenance(refOf(x), x.signing.setId, heard.receivedAt),
        kind: "justification",
        about: `A justification with ${heard.precommits} precommits (more than the threshold) from grandpa_subscribeJustifications.`,
        source: { method: "grandpa_subscribeJustifications", receivedAt: heard.receivedAt },
        ...justifiedJson(x),
      };
    } else if (watching) {
      const counts = watch.heard.map((h) => h.precommits).join(", ") || "none";
      notes.push(
        `No justification with ${MIN_EXTRA_PRECOMMITS} or more precommits arrived within ${watchSeconds} s ` +
          `(${watch.heard.length} seen; precommit counts: ${counts}). Run again with a longer --watch to capture one.`,
      );
      log(`    none within ${watchSeconds} s (${watch.heard.length} seen)`);
    }

    // Write.
    mkdirSync(outDir, { recursive: true });
    const entries: IndexEntry[] = [];
    const sizes: { file: string; bytes: number }[] = [];
    const put = (file: string, fixture: { provenance: Provenance; kind: FixtureKind }, summary: string) => {
      sizes.push({ file, bytes: writeJson(join(outDir, file), fixture) });
      entries.push({ file, kind: fixture.kind, block: fixture.provenance.block.number, setId: fixture.provenance.setId, summary });
    };
    const jSummary = (f: JustifiedHeaderFixture) =>
      `round ${f.justification.round}, ${f.justification.precommits.length} precommits, justification ${f.justification.bytes} B, header ${f.header.bytes} B`;

    put("finality-proof-head.json", finality, `${jSummary(finality)}, finality proof ${finality.finalityProof.bytes} B`);
    if (extraFixture) put(`justification-${extraFixture.justification.precommits.length}-precommits.json`, extraFixture, jSummary(extraFixture));
    put("authority-set.json", authoritySet, `set ${current.setId}, ${current.authorities.length} authorities, threshold ${current.json.threshold}`);
    put("set-change.json", setChange, `${setChange.scheduledChange.kind} (delay ${setChange.scheduledChange.delay}) to set ${setChange.newSetId}, ${jSummary(setChange)}, FRNK log ${setChange.scheduledChange.bytes} B`);
    if (periodFixture) put("stored-justification-512.json", periodFixture, jSummary(periodFixture));
    put("account-proof.json", accountProof, `${accountProof.proof.count} nodes, ${accountProof.proof.bytes} B, value ${accountProof.value.bytes} B`);

    notes.push(
      "These files chain together: a light client initialized with set-change.json's signing set (checkpoint: its parentHeader) " +
        "can import set-change.json's header (moving to the next set), then finality-proof-head.json, then check account-proof.json against that header's state_root.",
    );
    const index: IndexFixture = {
      provenance: await provenance(B, current.setId, atA),
      kind: "index",
      about: "Index of one capture run: the files written, the justifications seen on the subscription, and notes.",
      node: { version: nodeVersion },
      chainProperties,
      files: entries,
      watch: {
        method: "grandpa_subscribeJustifications",
        seconds: watchSeconds,
        minPrecommits: MIN_EXTRA_PRECOMMITS,
        seen: watch.heard.map(({ scale: _scale, ...seen }) => seen),
      },
      notes,
    };
    sizes.push({ file: "index.json", bytes: writeJson(join(outDir, "index.json"), index) });

    log(`\nWrote ${sizes.length} files to ${outDir}`);
    for (const s of sizes) log(`  ${s.file.padEnd(36)} ${fmt(s.bytes).padStart(8)} B`);
    for (const n of notes) log(`  note: ${n}`);
  } finally {
    await rpc.close();
  }
}

main().catch((error: unknown) => {
  console.error(`capture failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
