// Captures Portaldot fixtures for the light client tests. Read-only: it queries an RPC node
// and writes JSON files; it never signs or sends anything.
//
//   npm run capture -- [--rpc <wss url>] [--out <dir>] [--watch <seconds>] [--account <0x 32-byte id>]
//                      [--scan-limit <blocks>]
//
// Files (each with a provenance header; every chain item also as raw SCALE hex):
//   finality-proof-head.json         grandpa_proveFinality at the finalized head B, and B's header
//   justification-<n>-precommits.json  a subscription justification with 8+ precommits, if one arrives in time
//   authority-set.json               GrandpaApi_grandpa_authorities and Grandpa.CurrentSetId at B
//   set-change.json                  the latest FRNK ScheduledChange header with its stored justification,
//                                    and the change before it, which started the signing set
//   stored-justification-512.json    a justification the node stores every 512 blocks (chain_getBlock)
//   account-proof.json               a System.Account read proof at B
//   index.json                       the list above, the justifications seen while watching, and notes
//
// Set changes are found from headers alone, scanning back from B (changes.ts), so the capture
// also works on nodes that discard old state (the V3 testnet keeps about 256 blocks). Where
// a block's state is gone, its signing set is the one announced by the change log that started
// the set, and its runtime version is the head's if no runtime upgrade lies in between.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { bytesToHex, equalBytes, hexToBytes, shortHex, toSafeNumber, type Hex } from "./bytes.js";
import { scanSetChanges, type ChangeScan } from "./changes.js";
import {
  announcedSetJson,
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
  type StateAuthoritySetJson,
  type StorageProofFixture,
  type ToolInfo,
} from "./fixture.js";
import { verifyJustification } from "./grandpa.js";
import { blake2_256, GRANDPA_AUTHORITIES_KEY, storageKey, systemAccountKey } from "./hash.js";
import { RpcClient, RpcError, type Subscription } from "./rpc.js";
import {
  decodeAccountInfo,
  decodeAuthorityList,
  decodeFinalityProof,
  decodeHeader,
  decodeJustification,
  decodeU64,
  encodeRpcHeader,
  GRANDPA_ENGINE,
  type Authority,
  type GrandpaLog,
  type Header,
  type Justification,
  type RpcHeader,
} from "./scale.js";
import { readProof } from "./trie.js";

const DEFAULT_RPC = "wss://mainnet.portaldot.io";
const DEFAULT_WATCH_SECONDS = 360;
const MIN_EXTRA_PRECOMMITS = 8;
const JUSTIFICATION_PERIOD = 512;
/** How far below the head, in blocks, the scan for the two latest set changes may look (about 2 days of 6 s blocks). */
const DEFAULT_SCAN_LIMIT = 30_000;
/** Header requests in flight during the scan. */
const SCAN_CONCURRENCY = 32;
const SET_ID_KEY = storageKey("Grandpa", "CurrentSetId");
/** Where newer runtimes keep the authority list, instead of under GRANDPA_AUTHORITIES_KEY. */
const AUTHORITIES_KEY = storageKey("Grandpa", "Authorities");
const SUDO_KEY = storageKey("Sudo", "Key");
/** GrandpaLightClient.MAX_AUTHORITIES: the client halts on a change to a larger set. Keep the two equal. */
const MAX_AUTHORITIES = 16;

const log = (message: string) => console.log(message);
const now = () => new Date().toISOString();
const fmt = (n: number) => n.toLocaleString("en-US");

/** The node has pruned that block's state (it still serves the block's header and body). */
function stateDiscarded(error: unknown): boolean {
  return error instanceof RpcError && error.message.includes("State already discarded");
}

/** A ScheduledChange or ForcedChange, as the logs and notes describe it. */
function describeChange(l: GrandpaLog): string {
  if (l.kind !== "ScheduledChange" && l.kind !== "ForcedChange") return l.kind;
  const weights = new Set(l.nextAuthorities.map((a) => a.weight));
  return `${l.kind}, delay ${l.delay}, ${l.nextAuthorities.length} keys, weights {${[...weights].join(", ")}}`;
}

/** Why the light client would halt on this change log, or null if it follows it. */
function haltReason(l: GrandpaLog): string | null {
  if (l.kind === "ForcedChange") return "a ForcedChange";
  if (l.kind !== "ScheduledChange") return null;
  if (l.delay !== 0) return `a ScheduledChange with delay ${l.delay}`;
  if (l.nextAuthorities.length === 0 || l.nextAuthorities.some((a) => a.weight !== 1n)) return "a ScheduledChange to an empty list or with a weight other than 1";
  if (l.nextAuthorities.length > MAX_AUTHORITIES) return `a ScheduledChange to ${l.nextAuthorities.length} keys (the client takes at most ${MAX_AUTHORITIES})`;
  if (new Set(l.nextAuthorities.map((a) => bytesToHex(a.id))).size !== l.nextAuthorities.length) return "a ScheduledChange with a duplicate key";
  return null;
}

// ---------------------------------------------------------------------------------------
// Chain access

interface SetAt {
  setId: bigint;
  authorities: Authority[];
  json: AuthoritySetJson;
}

/** A set read from chain state. */
interface StateSetAt extends SetAt {
  json: StateAuthoritySetJson;
}

/** What a scan of headers back from the head established, for blocks whose state is gone. */
interface History {
  head: BlockRef;
  /** Grandpa.CurrentSetId at the head; the set started by the k-th newest change has id headSetId - k. */
  headSetId: bigint;
  scan: ChangeScan;
}

/** The node has discarded the state that holds a block's signing set, and the scan does not supply it. */
class UnknownSetError extends Error {
  override name = "UnknownSetError";
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
  /** Set once the set changes below the head are known; consulted where the node has discarded state. */
  history: History | null = null;

  constructor(readonly rpc: RpcClient) {}

  async blockHash(number: number): Promise<Hex> {
    const hash = await this.rpc.request<Hex | null>("chain_getBlockHash", [number]);
    if (!hash) throw new Error(`no block #${number}`);
    return hash;
  }

  /** chain_getBlockHash with a list of numbers: one request for many hashes. */
  async blockHashes(numbers: number[]): Promise<Hex[]> {
    const hashes = await this.rpc.request<(Hex | null)[]>("chain_getBlockHash", [numbers]);
    if (!Array.isArray(hashes) || hashes.length !== numbers.length) throw new Error(`chain_getBlockHash returned no list of ${numbers.length} hashes`);
    return hashes.map((hash, i) => {
      if (!hash) throw new Error(`no block #${numbers[i]}`);
      return hash;
    });
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

  async authoritySet(at: BlockRef): Promise<StateSetAt> {
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

  /** The runtime version at `block`; where the node has discarded its state, the head's, if no runtime upgrade lies in between. */
  async runtimeOf(block: BlockRef): Promise<RuntimeInfo> {
    try {
      return await this.runtime(block.hash);
    } catch (error) {
      const h = this.history;
      if (!stateDiscarded(error) || !h) throw error;
      if (block.number < h.scan.lowest || block.number > h.head.number) throw new Error(`the state of #${block.number} is discarded and the scan did not cover it`);
      // After a later upgrade the head runs another version: record where, instead of failing.
      const upgrade = h.scan.runtimeUpdates.find((n) => n > block.number);
      return { ...(await this.runtime(h.head.hash)), readAt: h.head, ...(upgrade !== undefined ? { upgradedAfter: upgrade } : {}) };
    }
  }

  /**
   * The set that finalizes `header`, i.e. the set in force at its parent: read from the parent's
   * state, or, where the node has discarded it, the set announced by the newest set change below
   * `header` that the scan found.
   */
  async signingSet(header: Header): Promise<SetAt> {
    try {
      return await this.authoritySet({ number: header.number - 1, hash: bytesToHex(header.parentHash) });
    } catch (error) {
      if (!stateDiscarded(error)) throw error;
      const set = this.announcedSet(header.number);
      if (!set) {
        const h = this.history;
        const range = h ? ` (it covered #${fmt(h.head.number)} back to #${fmt(h.scan.lowest)}${h.scan.lowest > 0 ? "; raise --scan-limit to look further" : ""})` : "";
        throw new UnknownSetError(`the state of #${header.number - 1} is discarded, and the scan found no set change below #${header.number}${range}`);
      }
      return set;
    }
  }

  /**
   * The set in force at block `number - 1` according to the scan: the set started by the newest
   * change below `number`, with the keys of its log. Only a ScheduledChange with delay 0 starts
   * its set right after its own block, so other changes are refused.
   */
  announcedSet(number: number): SetAt | null {
    const h = this.history;
    if (!h || number - 1 > h.head.number) return null;
    const k = h.scan.changes.findIndex((c) => c.number < number);
    if (k < 0) return null;
    const change = h.scan.changes[k];
    if (change.logs.length !== 1) throw new Error(`block #${change.number} carries ${change.logs.length} set changes`);
    const { item, log: l } = change.logs[0];
    if (l.kind !== "ScheduledChange" || l.delay !== 0) throw new Error(`the set change at #${change.number} is ${describeChange(l)}; its set cannot be read from the log`);
    const setId = h.headSetId - BigInt(k);
    return { setId, authorities: l.nextAuthorities, json: announcedSetJson(setId, change.header, hexToBytes(change.hash), l, item.payload) };
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
   * The signing set is the one in force at the parent block (signingSet). A block is finalized
   * by the set in force before it executes; at a set-change block the new set id is already in
   * the block's own state, but the block itself is still finalized by the outgoing set.
   */
  async justified(scale: Uint8Array): Promise<Justified> {
    const justification = decodeJustification(scale);
    const header = await this.header(bytesToHex(justification.targetHash));
    if (header.number !== justification.targetNumber) {
      throw new Error(`justification targets #${justification.targetNumber}, header is #${header.number}`);
    }
    const signing = await this.signingSet(header);
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
 * The two latest set changes at or below the head, from the FRNK logs in the headers: the
 * newest started the head's set, the one before it the set that signs the newest. pallet_grandpa
 * increments Grandpa.CurrentSetId in the block that carries the log, so the newest is also the
 * first block whose state holds the head's set id.
 */
async function findSetChanges(chain: Chain, head: Justified, limit: number): Promise<ChangeScan> {
  const started = Date.now();
  const scan = await scanSetChanges(chain, { header: head.header, hash: head.hash }, { want: 2, limit, concurrency: SCAN_CONCURRENCY });
  const seconds = Math.round((Date.now() - started) / 1000);
  log(`    scanned ${fmt(scan.examined)} headers, #${fmt(head.header.number)} back to #${fmt(scan.lowest)}, in ${seconds} s`);
  for (const c of scan.changes) log(`    #${fmt(c.number)} ${c.hash}: ${c.logs.map((l) => describeChange(l.log)).join("; ")}`);
  return scan;
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
      "scan-limit": { type: "string", default: String(DEFAULT_SCAN_LIMIT) },
    },
  });
  const rpcUrl = values.rpc;
  const outDir = resolve(values.out);
  const watchSeconds = Number(values.watch);
  if (!Number.isFinite(watchSeconds) || watchSeconds < 0) throw new Error("--watch must be a number of seconds");
  const scanLimit = Number(values["scan-limit"]);
  if (!Number.isInteger(scanLimit) || scanLimit < 1) throw new Error("--scan-limit must be a positive number of blocks");

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
      runtime: await chain.runtimeOf(block),
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
    const inPallet = await chain.storage(AUTHORITIES_KEY, B.hash);
    const weights = new Set(current.authorities.map((a) => a.weight));
    log(`    set ${current.setId}: ${current.authorities.length} authorities, weights {${[...weights].join(", ")}}, threshold ${current.json.threshold}`);
    if (weights.size !== 1 || !weights.has(1n)) notes.push("Not every authority weight is 1; the light client supports weight 1 only.");
    const authoritySet: AuthoritySetFixture = {
      provenance: await provenance(B, current.setId, atC),
      kind: "authority-set",
      about: "The GRANDPA authority list (state_call GrandpaApi_grandpa_authorities) and Grandpa.CurrentSetId at the head block: the checkpoint data for initializing a light client.",
      authoritySet: current.json,
      wellKnownKey: { key: bytesToHex(GRANDPA_AUTHORITIES_KEY), scale: wellKnown ? bytesToHex(wellKnown) : null },
      palletStorage: { key: bytesToHex(AUTHORITIES_KEY), scale: inPallet ? bytesToHex(inPallet) : null },
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
      about: `state_getReadProof for one System.Account entry at the head block, checked against the state_root of that block's header (trie V${trieVersion} on this chain).`,
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

    // (d) The most recent set change and its stored justification, and the change before it,
    // which started the set that signs it. Found from headers, so old state is not needed.
    log("(d) most recent set change");
    const atD = now();
    const scan = await findSetChanges(chain, head, scanLimit);
    chain.history = { head: B, headSetId: current.setId, scan };
    if (scan.changes.length === 0) {
      throw new Error(`no FRNK set change in the ${fmt(scan.examined)} blocks from #${fmt(B.number)} back to #${fmt(scan.lowest)}; raise --scan-limit`);
    }
    notes.push(
      `Set changes found by scanning ${scan.examined} headers, #${B.number} back to #${scan.lowest}: ` +
        `${scan.changes.map((c) => `#${c.number} (${c.logs.map((l) => describeChange(l.log)).join("; ")})`).join(", ")}.`,
    );
    for (const c of scan.changes) {
      if (c.logs.length > 1) notes.push(`Block #${c.number} carries ${c.logs.length} FRNK set changes; the light client halts on it.`);
      for (const { log: l } of c.logs) {
        const reason = haltReason(l);
        if (reason) notes.push(`The set change at #${c.number} is ${reason}; the light client halts on it.`);
      }
    }
    if (scan.otherLogs.length > 0) notes.push(`Other FRNK logs in the scanned blocks: ${scan.otherLogs.map((o) => `${o.kind} at #${o.number}`).join(", ")}.`);
    const latest = scan.changes[0];
    const changeNumber = latest.number;
    const changeHash = latest.hash;
    const stored = await chain.storedJustification(changeHash);
    if (!stored) throw new Error(`set-change block #${changeNumber} has no stored justification`);
    const change = await chain.justified(stored);
    if (bytesToHex(change.hash) !== changeHash) throw new Error("stored justification targets another block");
    const changeLog = latest.logs[0];
    if (change.signing.setId !== current.setId - 1n) {
      throw new Error(`set-change block is signed by set ${change.signing.setId}, expected ${current.setId - 1n}`);
    }
    const fromState = change.signing.json.setIdStorage !== undefined;
    if (fromState) {
      // Where the node still has the state, Grandpa.CurrentSetId confirms the scan: the parent
      // holds the outgoing set id and the change block the new one, so the change block is the
      // first block of the new set.
      const { setId } = await chain.setIdAt(changeHash);
      if (setId !== current.setId) throw new Error(`Grandpa.CurrentSetId at #${changeNumber} is ${setId}, not ${current.setId}`);
      // The keys in the change before agree with the set read at the parent; it is kept as a
      // second checkpoint (signingSet.announced).
      let previous: SetAt | null = null;
      try {
        previous = chain.announcedSet(changeNumber);
      } catch (error) {
        notes.push(`set-change.json has no signingSet.announced: ${(error as Error).message}.`);
      }
      if (previous) {
        const same = previous.authorities.length === change.signing.authorities.length &&
          previous.authorities.every((a, i) => equalBytes(a.id, change.signing.authorities[i].id) && a.weight === change.signing.authorities[i].weight);
        if (!same) throw new Error(`the keys announced at #${previous.json.at.number} differ from the signing set read at #${changeNumber - 1}`);
        change.signing.json.announced = previous.json.announced;
      } else if (scan.changes.length < 2) {
        const why = scan.lowest === 0 ? `no set change comes before #${changeNumber}` : `the change before #${changeNumber} is more than ${scanLimit} blocks below the head`;
        notes.push(`set-change.json has no signingSet.announced: ${why}.`);
      }
    } else {
      notes.push(
        `The node no longer has the state at #${changeNumber - 1}, so set-change.json's signing set (set ${change.signing.setId}) is the one announced ` +
          `by the change log at #${change.signing.json.at.number} (signingSet.announced); the set-change justification verifies under it.`,
      );
    }
    const parentHeader = await chain.header(bytesToHex(change.header.parentHash));
    const signingSource = fromState ? `read at #${fmt(changeNumber - 1)}` : `announced at #${fmt(change.signing.json.at.number)}`;
    log(`    block #${fmt(changeNumber)} ${changeHash}: ${changeLog.log.kind}, set ${change.signing.setId} -> ${current.setId}, ` +
      `header ${fmt(change.header.encoded.length)} B, FRNK log ${changeLog.item.payload.length} B, justification ${fmt(stored.length)} B ` +
      `(${change.justification.precommits.length} precommits), signing set ${signingSource}`);
    const announced = change.signing.json.announced;
    const setChange: SetChangeFixture = {
      provenance: await provenance(refOf(change), change.signing.setId, atD),
      kind: "set-change",
      about:
        "The most recent block carrying a FRNK ScheduledChange, with the justification the node stores for it (chain_getBlock). It is signed by the outgoing set; the set id in the block's own state is already the new one." +
        (announced ? " signingSet.announced is the change before it, which started the outgoing set." : ""),
      source: {
        method: "chain_getBlock",
        engine: GRANDPA_ENGINE,
        located: "newest block with a FRNK ScheduledChange or ForcedChange log, scanning the headers back from the head block",
        scanned: { from: B.number, to: scan.lowest, headers: scan.examined },
      },
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
      let p: Justified | null = null;
      try {
        p = await chain.justified(period.scale);
      } catch (error) {
        if (!(error instanceof UnknownSetError)) throw error;
        notes.push(`The justification stored at #${period.number} was left out: ${error.message}.`);
        log(`    block #${fmt(period.number)}: left out, ${error.message}`);
      }
      if (p) {
        log(`    block #${fmt(period.number)}: ${p.justification.precommits.length} precommits, ${fmt(period.scale.length)} B, set ${p.signing.setId}`);
        periodFixture = {
          provenance: await provenance(refOf(p), p.signing.setId, atP),
          kind: "stored-justification",
          about: `A justification the node stores every ${JUSTIFICATION_PERIOD} blocks, read with chain_getBlock.`,
          source: { method: "chain_getBlock", engine: GRANDPA_ENGINE, period: JUSTIFICATION_PERIOD },
          ...justifiedJson(p),
        };
      }
    } else {
      notes.push(`No stored ${JUSTIFICATION_PERIOD}-block-period justification found in the last 3 periods.`);
    }

    // (b) A justification with 8 or more precommits, if one arrives within the watch window. A
    // set of fewer than 8 authorities cannot sign one, so then there is nothing to wait for.
    const deadline = watch.startedAt + watchSeconds * 1000;
    const possible = current.authorities.length >= MIN_EXTRA_PRECOMMITS;
    if (possible) {
      log(`(b) justification with ${MIN_EXTRA_PRECOMMITS}+ precommits: waiting up to ${Math.max(0, Math.round((deadline - Date.now()) / 1000))} s more`);
    } else {
      log(`(b) justification with ${MIN_EXTRA_PRECOMMITS}+ precommits: not possible with ${current.authorities.length} authorities, not waiting`);
      if (watching) {
        notes.push(`The head's set has ${current.authorities.length} authorities, so no justification carries ${MIN_EXTRA_PRECOMMITS} or more precommits; the watch did not wait for one.`);
      }
    }
    const heard = watching && possible ? await watch.waitUntil(deadline, rpc) : undefined;
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
    } else if (watching && possible) {
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

    const written = [finality, authoritySet, setChange, accountProof, periodFixture, extraFixture];
    if (written.some((f) => f?.provenance.runtime.readAt)) {
      notes.push(
        "Where the node no longer had a block's state, that file's runtime version was read at the head block instead (provenance.runtime.readAt); " +
          "no header between them carries RuntimeEnvironmentUpdated.",
      );
    }
    if (written.some((f) => f?.provenance.runtime.upgradedAfter !== undefined)) {
      notes.push(
        "A runtime upgrade lies between a file's block and the head (provenance.runtime.upgradedAfter): " +
          "that file's runtime version is the head's, not its block's.",
      );
    }
    notes.push(
      "These files chain together: a light client initialized with set-change.json's signing set (checkpoint: its parentHeader" +
        (setChange.signingSet.announced ? ", or signingSet.announced.header, the change that started that set" : "") +
        ") can import set-change.json's header (moving to the next set), then finality-proof-head.json, then check account-proof.json against that header's state_root.",
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
