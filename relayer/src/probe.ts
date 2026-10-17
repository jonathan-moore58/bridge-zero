// Read-only probe: tells, in one run, whether a Substrate node serves everything a GRANDPA
// light client on Ethereum needs. It queries the node and writes one JSON report; it never
// signs or sends anything.
//
//   npm run probe -- --rpc <wss url> [--evm <https url>] [--account <ss58 or 0x id>] [--out <dir>]
//
// Checks: identity and runtime APIs; the RPC surface; finality (lag, block time, and a
// grandpa_proveFinality proof verified here against GrandpaApi_grandpa_authorities and
// Grandpa.CurrentSetId); a System.Account read proof walked from the finalized state_root;
// the child read proof method; and, with --evm, the Ethereum JSON-RPC basics.
// Exit code 0 when no gate fails, 1 otherwise (including an unreachable endpoint).

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { blake2b } from "@noble/hashes/blake2.js";
import { bytesToHex, concatBytes, equalBytes, flipByte, hexToBytes, shortHex, toSafeNumber, utf8, type Hex } from "./bytes.js";
import { writeJson, type BlockRef, type RuntimeInfo, type ToolInfo } from "./fixture.js";
import { threshold, verifyJustification } from "./grandpa.js";
import { blake2_256, storageKey, systemAccountKey } from "./hash.js";
import { RpcClient, RpcError } from "./rpc.js";
import {
  decodeAccountInfo,
  decodeAuthorityList,
  decodeFinalityProof,
  decodeHeader,
  decodeJustification,
  decodeU64,
  encodeRpcHeader,
  type Authority,
  type Header,
  type RpcHeader,
} from "./scale.js";
import { decodeNode, readProof } from "./trie.js";

const CONNECT_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;
const EVM_TIMEOUT_MS = 10_000;
/** Backstop: the whole run, whatever happens. */
const OVERALL_TIMEOUT_MS = 180_000;
/** After this many unanswered calls in a row, the remaining calls are skipped. */
const MAX_TIMEOUTS_IN_A_ROW = 2;
const LAG_LIMIT = 10;
const BLOCK_TIME_SPAN = 10;

/** The ed25519 public key of the well-known development seed //Alice. */
const ALICE_ED25519 = "0x88dc3417d5058ec4b4503e0c12ea1a0a89be200fe98922423d4334014fa6b0ee";

const SET_ID_KEY = storageKey("Grandpa", "CurrentSetId");
const SUDO_KEY = storageKey("Sudo", "Key");
const TIMESTAMP_KEY = storageKey("Timestamp", "Now");
const SYSTEM_ACCOUNT_PREFIX = storageKey("System", "Account");

/** Runtime APIs to flag. Core is in every runtime and checks the id computation. */
const API_NAMES = ["Core", "GrandpaApi", "BeefyApi", "MmrApi", "ReviveApi", "EthereumRuntimeRPCApi", "BabeApi", "AuraApi"] as const;
const RPC_FLAGS = [
  "grandpa_proveFinality",
  "grandpa_subscribeJustifications",
  "state_getReadProof",
  "state_getChildReadProof",
  "beefy_getFinalizedHead",
  "mmr_generateProof",
] as const;

/** Runtime API id: blake2b with an 8-byte output over the trait name, as sp-api derives it. */
export function runtimeApiId(name: string): Hex {
  return bytesToHex(blake2b(utf8(name), { dkLen: 8 }));
}

const log = (message = "") => console.log(message);
const fmt = (n: number) => n.toLocaleString("en-US");
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const notExposed = (error: unknown) => error instanceof RpcError && error.code === -32601;

// ---------------------------------------------------------------------------------------
// SS58 addresses (32-byte account ids only)

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const SS58_CONTEXT = utf8("SS58PRE");

function base58Decode(text: string): Uint8Array {
  let n = 0n;
  for (const c of text) {
    const digit = B58.indexOf(c);
    if (digit < 0) throw new Error(`not base58: ${JSON.stringify(c)}`);
    n = n * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  for (; n > 0n; n >>= 8n) bytes.unshift(Number(n & 0xffn));
  let zeros = 0;
  while (text[zeros] === "1") zeros++;
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...bytes]);
}

function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  for (; n > 0n; n /= 58n) out = B58[Number(n % 58n)] + out;
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

const ss58Checksum = (body: Uint8Array) => blake2b(concatBytes(SS58_CONTEXT, body), { dkLen: 64 }).subarray(0, 2);

export function ss58Decode(address: string): { id: Uint8Array; prefix: number } {
  const raw = base58Decode(address);
  const prefixLength = raw[0] < 64 ? 1 : raw[0] < 128 ? 2 : 0;
  if (prefixLength === 0 || raw.length !== prefixLength + 34) throw new Error("not an SS58 address of a 32-byte account id");
  const body = raw.subarray(0, prefixLength + 32);
  if (!equalBytes(ss58Checksum(body), raw.subarray(prefixLength + 32))) throw new Error("SS58 checksum mismatch");
  const prefix = prefixLength === 1 ? raw[0] : ((raw[0] & 0x3f) << 2) | (raw[1] >> 6) | ((raw[1] & 0x3f) << 8);
  return { id: raw.slice(prefixLength, prefixLength + 32), prefix };
}

export function ss58Encode(id: Uint8Array, prefix: number): string {
  const p = prefix < 64 ? Uint8Array.of(prefix) : Uint8Array.of(((prefix & 0xfc) >> 2) | 0x40, (prefix >> 8) | ((prefix & 0x03) << 6));
  const body = concatBytes(p, id);
  return base58Encode(concatBytes(body, ss58Checksum(body)));
}

function parseAccount(text: string): Uint8Array {
  if (text.startsWith("0x")) {
    const id = hexToBytes(text);
    if (id.length !== 32) throw new Error(`--account: expected a 32-byte account id, got ${id.length} bytes`);
    return id;
  }
  return ss58Decode(text).id;
}

// ---------------------------------------------------------------------------------------
// Node access

class Node {
  private timeoutsInARow = 0;

  constructor(readonly rpc: RpcClient) {}

  /** A request with the client's timeout; gives up on the node after repeated timeouts. */
  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    if (this.timeoutsInARow >= MAX_TIMEOUTS_IN_A_ROW) throw new RpcError(method, "skipped: the node stopped answering");
    try {
      const result = await this.rpc.request<T>(method, params, REQUEST_TIMEOUT_MS);
      this.timeoutsInARow = 0;
      return result;
    } catch (error) {
      if (error instanceof RpcError && error.code === undefined && error.message.includes("no response after")) this.timeoutsInARow++;
      throw error;
    }
  }

  /** chain_getHeader, re-encoded to SCALE; refused unless blake2_256 of the bytes is the block hash. */
  async header(hash: Hex): Promise<Header> {
    const json = await this.call<RpcHeader | null>("chain_getHeader", [hash]);
    if (!json) throw new Error(`no header for ${hash}`);
    const header = decodeHeader(encodeRpcHeader(json));
    const computed = bytesToHex(blake2_256(header.encoded));
    if (computed !== hash.toLowerCase()) throw new Error(`header ${hash} re-encodes to a different hash ${computed}`);
    return header;
  }

  async blockHash(number: number): Promise<Hex> {
    const hash = await this.call<Hex | null>("chain_getBlockHash", [number]);
    if (!hash) throw new Error(`no block #${number}`);
    return hash;
  }

  async storage(key: Uint8Array, at: Hex): Promise<Uint8Array | null> {
    const value = await this.call<Hex | null>("state_getStorage", [bytesToHex(key), at]);
    return value === null ? null : hexToBytes(value);
  }

  async timestamp(at: Hex): Promise<bigint> {
    const value = await this.storage(TIMESTAMP_KEY, at);
    if (!value) throw new Error(`Timestamp.Now is empty at ${at}`);
    return decodeU64(value, "Timestamp.Now");
  }

  /** The GRANDPA set in a block's state: Grandpa.CurrentSetId and GrandpaApi_grandpa_authorities. */
  async grandpaSet(at: Hex): Promise<{ setId: bigint; authorities: Authority[] }> {
    const setIdScale = await this.storage(SET_ID_KEY, at);
    if (!setIdScale) throw new Error("Grandpa.CurrentSetId is empty");
    const setId = decodeU64(setIdScale, "Grandpa.CurrentSetId");
    const scale = await this.call<Hex>("state_call", ["GrandpaApi_grandpa_authorities", "0x", at]);
    return { setId, authorities: decodeAuthorityList(hexToBytes(scale)) };
  }
}

async function evmCall(url: string, method: string): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
    signal: AbortSignal.timeout(EVM_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  const body = (await response.json()) as { result?: unknown; error?: { code?: number; message?: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message ?? "error"} (code ${body.error.code})`);
  return body.result;
}

// ---------------------------------------------------------------------------------------
// Report

type Status = "PASS" | "WARN" | "FAIL";

interface Gate {
  gate: string;
  status: Status;
  detail: string;
}

interface ProbeProvenance {
  chain: string | null;
  rpc: string;
  genesisHash: Hex | null;
  runtime: RuntimeInfo | null;
  /** The finalized head the checks read at. */
  block: BlockRef | null;
  /** Grandpa.CurrentSetId at that block, when the chain has one. */
  setId: number | null;
  capturedAt: string;
  tool: ToolInfo;
}

interface ProbeReport {
  provenance: ProbeProvenance;
  kind: "probe";
  about: string;
  connection: { ok: boolean; error?: string; elapsedMs: number };
  identity: Record<string, unknown>;
  runtimeApis: { flags: Record<string, { id: Hex; present: boolean; version: number | null }>; all: { id: Hex; version: number; name: string | null }[] } | null;
  rpcSurface: { methodCount: number; flags: Record<string, boolean>; ethMethods: string[] } | null;
  finality: Record<string, unknown>;
  stateProofs: Record<string, unknown>;
  evm: Record<string, unknown> | null;
  gates: Gate[];
  verdict: Status;
  errors: Record<string, string>;
  elapsedMs: number;
}

function toolInfo(): ToolInfo {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { name: string; version: string };
  const relayerDir = fileURLToPath(new URL("..", import.meta.url));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: relayerDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  let gitCommit: string | null = null;
  let gitDirty: boolean | null = null;
  try {
    gitCommit = git("rev-parse", "HEAD");
    gitDirty = git("status", "--porcelain", "--", ".") !== "";
  } catch {
    // not a git checkout, or git is not installed
  }
  return { name: pkg.name, version: pkg.version, script: "src/probe.ts", gitCommit, gitDirty };
}

function chainTypeText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const [key, inner] = Object.entries(value)[0] ?? ["unknown", null];
    return inner ? `${key}(${String(inner)})` : key;
  }
  return "unknown";
}

function reportFileName(rpcUrl: string): string {
  try {
    return `${new URL(rpcUrl).hostname.replace(/[^a-zA-Z0-9.-]/g, "_")}.json`;
  } catch {
    return "probe.json";
  }
}

// ---------------------------------------------------------------------------------------
// Probe

async function probe(rpcUrl: string, evmUrl: string | undefined, accountArg: Uint8Array | undefined, tool: ToolInfo): Promise<ProbeReport> {
  const started = Date.now();
  const errors: Record<string, string> = {};
  const gates: Gate[] = [];
  const gate = (name: string, status: Status, detail: string) => gates.push({ gate: name, status, detail });
  const report: ProbeReport = {
    provenance: { chain: null, rpc: rpcUrl, genesisHash: null, runtime: null, block: null, setId: null, capturedAt: new Date().toISOString(), tool },
    kind: "probe",
    about:
      "Read-only probe of one node: can it serve what a GRANDPA light client on Ethereum needs (finality proofs that verify, " +
      "read proofs that walk from the finalized state_root, child read proofs, timely finality, non-development validators)?",
    connection: { ok: false, elapsedMs: 0 },
    identity: {},
    runtimeApis: null,
    rpcSurface: null,
    finality: {},
    stateProofs: {},
    evm: null,
    gates,
    verdict: "FAIL",
    errors,
    elapsedMs: 0,
  };
  /** Runs one check; a failure is recorded under `label` and yields undefined. */
  const step = async <T>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (error) {
      errors[label] = errorText(error);
      return undefined;
    }
  };

  // EVM first: it does not depend on the Substrate endpoint being up.
  if (evmUrl) {
    const evm: Record<string, unknown> = { url: evmUrl };
    for (const method of ["eth_chainId", "net_version", "eth_blockNumber", "web3_clientVersion"]) {
      evm[method] = (await step(`evm.${method}`, () => evmCall(evmUrl, method))) ?? null;
    }
    report.evm = evm;
  }

  let rpc: RpcClient;
  try {
    rpc = await RpcClient.connect(rpcUrl, { connectTimeoutMs: CONNECT_TIMEOUT_MS, requestTimeoutMs: REQUEST_TIMEOUT_MS });
  } catch (error) {
    report.connection = { ok: false, error: errorText(error), elapsedMs: Date.now() - started };
    for (const name of GATE_NAMES) gate(name, "FAIL", `endpoint unreachable: ${errorText(error)}`);
    evmGate(report, gate);
    return finish(report, started);
  }
  report.connection = { ok: true, elapsedMs: Date.now() - started };
  const node = new Node(rpc);

  try {
    // 1. Identity
    const id = report.identity;
    const genesisHash = await step("genesis", () => node.blockHash(0));
    id.genesisHash = genesisHash ?? null;
    for (const method of ["system_chain", "system_name", "system_version", "system_chainType", "system_properties"]) {
      id[method.slice("system_".length)] = (await step(method, () => node.call<unknown>(method))) ?? null;
    }
    id.chainType = id.chainType === null ? null : chainTypeText(id.chainType);
    const properties = (id.properties ?? {}) as Record<string, unknown>;
    const ss58Format = typeof properties.ss58Format === "number" ? properties.ss58Format : 42;
    report.provenance.chain = typeof id.chain === "string" ? id.chain : null;
    report.provenance.genesisHash = genesisHash ?? null;

    // Heads: finalized (hash-checked header) and best.
    const finalizedHash = await step("finalizedHead", () => node.call<Hex>("chain_getFinalizedHead"));
    const finalized = finalizedHash ? await step("finalizedHeader", () => node.header(finalizedHash)) : undefined;
    const best = await step("bestHeader", () => node.call<RpcHeader>("chain_getHeader"));
    const bestNumber = best ? Number(BigInt(best.number)) : null;
    const B: BlockRef | null = finalized && finalizedHash ? { number: finalized.number, hash: finalizedHash } : null;
    report.provenance.block = B;

    // Runtime version at the finalized head, and its API list.
    const rv = await step("runtimeVersion", () => node.call<Record<string, unknown>>("state_getRuntimeVersion", B ? [B.hash] : []));
    if (rv) {
      const runtime: RuntimeInfo = {
        specName: String(rv.specName),
        specVersion: Number(rv.specVersion),
        implName: String(rv.implName),
        implVersion: Number(rv.implVersion),
        transactionVersion: Number(rv.transactionVersion),
        ...(rv.stateVersion === undefined ? {} : { stateVersion: Number(rv.stateVersion) }),
      };
      report.provenance.runtime = runtime;
      const apis = (Array.isArray(rv.apis) ? rv.apis : []) as [string, number][];
      const names = new Map(API_NAMES.map((name) => [runtimeApiId(name), name] as const));
      const listed = new Map(apis.map(([apiId, version]) => [apiId.toLowerCase(), version] as const));
      const flags: NonNullable<ProbeReport["runtimeApis"]>["flags"] = {};
      for (const name of API_NAMES) {
        const apiId = runtimeApiId(name);
        flags[name] = { id: apiId, present: listed.has(apiId), version: listed.get(apiId) ?? null };
      }
      report.runtimeApis = {
        flags,
        all: apis.map(([apiId, version]) => ({ id: apiId.toLowerCase() as Hex, version, name: names.get(apiId.toLowerCase() as Hex) ?? null })),
      };
      if (!flags.Core.present) errors.runtimeApis = "Core is not in the API list: the computed ids do not match this node's encoding";
    }

    // 2. RPC surface
    const methods = await step("rpc_methods", () => node.call<{ methods: string[] }>("rpc_methods"));
    const methodSet = new Set(methods?.methods ?? []);
    if (methods) {
      report.rpcSurface = {
        methodCount: methodSet.size,
        flags: Object.fromEntries(RPC_FLAGS.map((m) => [m, methodSet.has(m)])),
        ethMethods: [...methodSet].filter((m) => m.startsWith("eth_")).sort(),
      };
    }

    // 3. Finality
    const fin = report.finality;
    fin.best = bestNumber;
    fin.finalized = B;
    fin.lagBlocks = bestNumber !== null && B ? bestNumber - B.number : null;
    if (B) {
      // Timestamp.Now at the finalized head and the blocks before it, read in parallel.
      const span = Math.min(BLOCK_TIME_SPAN, B.number);
      const stamps = await step("timestamps", () =>
        Promise.all(Array.from({ length: span + 1 }, async (_, i) => node.timestamp(i === 0 ? B.hash : await node.blockHash(B.number - i)))),
      );
      const tN = stamps?.[0];
      const deltas = stamps ? stamps.slice(0, -1).map((t, i) => Number(t - stamps[i + 1])) : null;
      fin.blockTimeMs = deltas && deltas.length > 0 ? deltas[0] : null;
      fin.blockTimeAvgMs = stamps && span > 0 ? Math.round(Number(stamps[0] - stamps[span]) / span) : null;
      fin.blockTimeSpan = span;
      fin.blockTimeDeltasMs = deltas;
      fin.headTimestamp = tN === undefined ? null : new Date(Number(tN)).toISOString();
    }

    // The GRANDPA set at the finalized head (for the validator check).
    const headSet = B ? await step("grandpaSet.head", () => node.grandpaSet(B.hash)) : undefined;
    if (headSet) {
      report.provenance.setId = toSafeNumber(headSet.setId, "set id");
      const weights = [...new Set(headSet.authorities.map((a) => a.weight.toString()))];
      fin.authoritySet = {
        at: B,
        setId: report.provenance.setId,
        count: headSet.authorities.length,
        threshold: headSet.authorities.length > 0 ? threshold(headSet.authorities.length) : null,
        weights,
        aliceIsAuthority: headSet.authorities.some((a) => bytesToHex(a.id) === ALICE_ED25519),
        authorities: headSet.authorities.map((a) => bytesToHex(a.id)),
      };
    }

    // grandpa_proveFinality at the finalized head, decoded and verified here.
    let proofOutcome: { served: boolean; verified: boolean; thresholdMet: boolean; detail: string } = {
      served: false,
      verified: false,
      thresholdMet: false,
      detail: "",
    };
    if (B) {
      try {
        const hex = await node.call<Hex | null>("grandpa_proveFinality", [B.number]);
        if (!hex) throw new Error(`grandpa_proveFinality(${B.number}) returned no proof`);
        const scale = hexToBytes(hex);
        const proof = decodeFinalityProof(scale);
        const j = decodeJustification(proof.justification);
        proofOutcome.served = true;
        const target = await node.header(bytesToHex(j.targetHash));
        if (target.number !== j.targetNumber) throw new Error(`justification targets #${j.targetNumber}, its header is #${target.number}`);
        if (!equalBytes(proof.block, j.targetHash)) throw new Error("finality proof block is not the justification target");
        // A block is finalized by the set in force before it executes: read the set at its parent.
        const parent: BlockRef = { number: target.number - 1, hash: bytesToHex(target.parentHash) };
        const signing = await node.grandpaSet(parent.hash);
        const ids = signing.authorities.map((a) => a.id);
        const result = verifyJustification(j, ids, signing.setId);
        // Negative controls: the same justification must fail under another set id or with one signature byte flipped.
        const wrongSet = verifyJustification(j, ids, signing.setId + 1n).ok;
        const flipUnchanged = j.precommits.length > 0
          ? verifyJustification({ ...j, precommits: j.precommits.map((p, i) => (i === 0 ? { ...p, signature: flipByte(p.signature, 0) } : p)) }, ids, signing.setId).valid ===
            result.valid
          : false;
        const weights = [...new Set(signing.authorities.map((a) => a.weight.toString()))];
        proofOutcome = {
          served: true,
          verified: result.ok,
          thresholdMet: result.valid >= result.required,
          detail: result.ok
            ? `${result.valid}/${result.precommits.length} valid, ${result.required} of ${ids.length} needed, set ${signing.setId}, round ${j.round}`
            : result.problems.slice(0, 3).join("; "),
        };
        fin.proof = {
          requested: B.number,
          target: { number: target.number, hash: bytesToHex(j.targetHash) },
          signingSetReadAt: parent,
          setId: toSafeNumber(signing.setId, "set id"),
          round: j.round.toString(),
          authorities: ids.length,
          weights,
          precommits: j.precommits.length,
          validSignatures: result.valid,
          required: result.required,
          thresholdMet: result.valid >= result.required,
          verified: result.ok,
          problems: result.problems,
          votesAncestries: j.votesAncestries.length,
          unknownHeaders: proof.unknownHeaders.length,
          proofBytes: scale.length,
          justificationBytes: proof.justification.length,
          targetHeaderBytes: target.encoded.length,
          negativeControls: { wrongSetIdRejected: !wrongSet, flippedSignatureRejected: j.precommits.length > 0 && !flipUnchanged },
          aliceSigned: j.precommits.some((p) => bytesToHex(p.id) === ALICE_ED25519),
        };
      } catch (error) {
        errors.grandpa_proveFinality = errorText(error);
        proofOutcome.detail = notExposed(error) ? "grandpa_proveFinality is not exposed" : errorText(error);
      }
    }

    const sudo = B ? await step("Sudo.Key", () => node.storage(SUDO_KEY, B.hash)) : undefined;
    fin.sudoKey = sudo && sudo.length === 32 ? { id: bytesToHex(sudo), ss58: ss58Encode(sudo, ss58Format) } : null;

    // 4. State proofs
    const sp = report.stateProofs;
    let readOutcome: { served: boolean; verified: boolean; v1: boolean; detail: string } = { served: false, verified: false, v1: false, detail: "" };
    if (B && finalized) {
      try {
        let account: { id: Uint8Array; source: string };
        if (accountArg) account = { id: accountArg, source: "--account" };
        else if (sudo && sudo.length === 32) account = { id: sudo, source: "Sudo.Key" };
        else {
          const keys = await node.call<Hex[]>("state_getKeysPaged", [bytesToHex(SYSTEM_ACCOUNT_PREFIX), 1, null, B.hash]);
          if (keys.length === 0) throw new Error("no System.Account entries to prove");
          account = { id: hexToBytes(keys[0]).slice(-32), source: "first System.Account key (state_getKeysPaged)" };
        }
        const key = systemAccountKey(account.id);
        const stored = await node.storage(key, B.hash);
        const response = await node.call<{ at: Hex; proof: Hex[] }>("state_getReadProof", [[bytesToHex(key)], B.hash]);
        readOutcome.served = true;
        const nodes = response.proof.map((n) => hexToBytes(n));
        // Which layout the proof uses: V1 nodes carry hashed-value headers.
        let hashedValueNodes = 0;
        let undecodable = 0;
        for (const item of nodes) {
          try {
            const decoded = decodeNode(item);
            if (decoded.type !== "empty" && decoded.value && "hashed" in decoded.value) hashedValueNodes++;
          } catch {
            undecodable++; // in V1, a hashed value is its own proof item
          }
        }
        const stateVersion = report.provenance.runtime?.stateVersion;
        const v1 = stateVersion === 1 || hashedValueNodes > 0;
        readOutcome.v1 = v1;
        sp.readProof = {
          account: { id: bytesToHex(account.id), ss58: ss58Encode(account.id, ss58Format), source: account.source },
          key: bytesToHex(key),
          at: B,
          stateRoot: bytesToHex(finalized.stateRoot),
          nodes: nodes.length,
          bytes: nodes.reduce((n, item) => n + item.length, 0),
          runtimeStateVersion: stateVersion ?? null,
          hashedValueNodes,
          itemsThatAreNotNodes: undecodable,
          trieVersion: v1 ? 1 : 0,
        };
        const detail = sp.readProof as Record<string, unknown>;
        try {
          const read = readProof(finalized.stateRoot, nodes, key);
          const matches = read.value === null ? stored === null : stored !== null && equalBytes(read.value, stored);
          if (!matches) throw new Error("the proof leads to a different value than state_getStorage");
          // Negative control: one flipped byte in the root node must break the walk.
          const rootIndex = nodes.findIndex((item) => equalBytes(blake2_256(item), finalized.stateRoot));
          let tamperRejected = false;
          try {
            readProof(finalized.stateRoot, nodes.map((item, i) => (i === rootIndex ? flipByte(item, item.length - 1) : item)), key);
          } catch {
            tamperRejected = true;
          }
          detail.verified = true;
          detail.itemsUsed = read.itemsUsed;
          detail.hashedValuesInWalk = read.hashedValues;
          detail.value = read.value === null ? null : { bytes: read.value.length, scale: bytesToHex(read.value) };
          detail.tamperedRootRejected = tamperRejected;
          if (read.value) {
            try {
              detail.free = decodeAccountInfo(read.value).free.toString();
            } catch {
              // not the 80-byte AccountInfo layout; the raw value is recorded above
            }
          }
          readOutcome.verified = tamperRejected;
          readOutcome.detail = `${nodes.length} nodes, ${fmt(detail.bytes as number)} B, ${read.value ? `value ${read.value.length} B` : "absent"}, ` +
            `trie V${v1 ? 1 : 0}${read.hashedValues ? ` (${read.hashedValues} hashed value)` : ""}, walked from the state_root of #${fmt(B.number)}` +
            (tamperRejected ? "" : "; a tampered root was NOT rejected");
        } catch (error) {
          detail.verified = false;
          detail.error = errorText(error);
          readOutcome.detail = v1 ? `trie V1 proof could not be verified yet: ${errorText(error)}` : errorText(error);
        }
      } catch (error) {
        errors.state_getReadProof = errorText(error);
        readOutcome.detail = notExposed(error) ? "state_getReadProof is not exposed" : errorText(error);
      }
    }

    // Child read proofs: listed in rpc_methods, and the call is routed (an absent child trie is fine).
    const childListed = methodSet.has("state_getChildReadProof");
    let childAnswer: string | null = null;
    let childRouted = false;
    if (B) {
      const childKey = bytesToHex(concatBytes(utf8(":child_storage:default:"), new Uint8Array(32)));
      try {
        const r = await node.call<{ proof?: unknown[] }>("state_getChildReadProof", [childKey, ["0x00"], B.hash]);
        childRouted = true;
        childAnswer = `answered with ${Array.isArray(r?.proof) ? r.proof.length : 0} proof items for an absent child trie`;
      } catch (error) {
        childRouted = !notExposed(error) && error instanceof RpcError && error.code !== undefined;
        childAnswer = `${notExposed(error) ? "not exposed" : "answered with an error"}: ${errorText(error)}`;
      }
    }
    sp.childReadProof = { listedInRpcMethods: childListed, probeCall: childAnswer, routed: childRouted };

    if (methodSet.has("beefy_getFinalizedHead")) {
      fin.beefyFinalizedHead = (await step("beefy_getFinalizedHead", () => node.call<Hex>("beefy_getFinalizedHead"))) ?? null;
    }

    // 6. Gates
    const listedProve = methodSet.has("grandpa_proveFinality");
    gate(
      "GRANDPA proofs served",
      proofOutcome.served ? "PASS" : "FAIL",
      proofOutcome.served
        ? `grandpa_proveFinality(#${fmt(B!.number)}) returned a decodable proof${listedProve ? "" : " (not listed in rpc_methods)"}`
        : proofOutcome.detail || "no finalized head",
    );
    gate("Justification verifies", proofOutcome.verified ? "PASS" : "FAIL", proofOutcome.served ? proofOutcome.detail : "no proof to verify");
    const p = fin.proof as Record<string, unknown> | undefined;
    if (p) {
      const weightsOk = (p.weights as string[]).every((w) => w === "1");
      gate(
        "Threshold met",
        !p.thresholdMet ? "FAIL" : weightsOk ? "PASS" : "WARN",
        `${p.validSignatures} valid of ${p.authorities} authorities, ${p.required} required (N - floor((N-1)/3))` +
          (weightsOk ? "" : `; weights ${(p.weights as string[]).join(",")}: the light client assumes weight 1`),
      );
    } else {
      gate("Threshold met", "FAIL", "no verified justification");
    }
    if (!readOutcome.served) gate("Read proofs served and verified", "FAIL", readOutcome.detail || "no finalized head");
    else if (readOutcome.verified) gate("Read proofs served and verified", "PASS", readOutcome.detail);
    else gate("Read proofs served and verified", readOutcome.v1 ? "WARN" : "FAIL", readOutcome.detail);
    if (readOutcome.verified && readOutcome.v1) {
      gate("Trie V1 on chain", "PASS", "trie V1 proof verified off-chain by trie.ts; the Solidity walker is tested on captured V3 testnet trie V1 proofs (contracts/test/unit/V3Testnet.t.sol)");
    }
    gate(
      "Child read proofs served",
      childListed && childRouted ? "PASS" : childListed || childRouted ? "WARN" : "FAIL",
      `${childListed ? "listed" : "not listed"} in rpc_methods; ${childAnswer ?? "not called"}`,
    );
    const lag = fin.lagBlocks as number | null;
    gate(
      `Finality lag under ${LAG_LIMIT} blocks`,
      lag === null ? "FAIL" : lag < LAG_LIMIT ? "PASS" : lag < 10 * LAG_LIMIT ? "WARN" : "FAIL",
      lag === null ? "best or finalized head unknown" : `best #${fmt(bestNumber!)}, finalized #${fmt(B!.number)}: ${lag} blocks behind`,
    );
    const set = fin.authoritySet as { count: number; aliceIsAuthority: boolean } | undefined;
    const chainType = String(id.chainType ?? "unknown");
    if (!set) gate("Real or development validators", "FAIL", `no GRANDPA authority set in state (${errors["grandpaSet.head"] ?? "not read"})`);
    else if (set.aliceIsAuthority) gate("Real or development validators", "FAIL", "the public //Alice ed25519 key is a GRANDPA authority: anyone can sign finality");
    else if (chainType !== "Live") gate("Real or development validators", "WARN", `${set.count} authorities, none is //Alice, but chainType is ${chainType}`);
    else if (set.count < 4) gate("Real or development validators", "WARN", `only ${set.count} GRANDPA authorities (none is //Alice)`);
    else gate("Real or development validators", "PASS", `${set.count} GRANDPA authorities, none is //Alice; chainType ${chainType}`);
    evmGate(report, gate);
  } finally {
    await rpc.close();
  }
  return finish(report, started);
}

const GATE_NAMES = [
  "GRANDPA proofs served",
  "Justification verifies",
  "Threshold met",
  "Read proofs served and verified",
  "Child read proofs served",
  `Finality lag under ${LAG_LIMIT} blocks`,
  "Real or development validators",
];

function evmGate(report: ProbeReport, gate: (name: string, status: Status, detail: string) => void): void {
  if (!report.evm) return;
  const e = report.evm;
  const answered = ["eth_chainId", "net_version", "eth_blockNumber", "web3_clientVersion"].filter((m) => e[m] !== null);
  if (answered.length === 0) {
    gate("EVM endpoint answers", "FAIL", report.errors["evm.eth_chainId"] ?? "no answer");
    return;
  }
  const chainId = typeof e.eth_chainId === "string" ? BigInt(e.eth_chainId) : null;
  const netVersion = typeof e.net_version === "string" ? BigInt(e.net_version) : null;
  const consistent = chainId === null || netVersion === null || chainId === netVersion;
  gate(
    "EVM endpoint answers",
    answered.length === 4 && consistent ? "PASS" : "WARN",
    `${answered.length}/4 methods answered; chainId ${chainId ?? "?"}, net_version ${netVersion ?? "?"}` + (consistent ? "" : " (they differ)"),
  );
}

function finish(report: ProbeReport, started: number): ProbeReport {
  const statuses = report.gates.map((g) => g.status);
  report.verdict = statuses.includes("FAIL") ? "FAIL" : statuses.includes("WARN") ? "WARN" : "PASS";
  report.elapsedMs = Date.now() - started;
  return report;
}

// ---------------------------------------------------------------------------------------
// Human summary

function summary(r: ProbeReport): void {
  const line = (label: string, value: string) => log(`  ${label.padEnd(18)} ${value}`);
  const yes = (b: boolean | undefined) => (b ? "yes" : "no");
  log(`Bridge Zero probe: ${r.provenance.rpc}`);
  log(`  ${r.provenance.capturedAt}`);
  if (!r.connection.ok) {
    log(`\n  cannot reach the endpoint: ${r.connection.error} (${r.connection.elapsedMs} ms)`);
  } else {
    const id = r.identity;
    const rt = r.provenance.runtime;
    log("\nIdentity");
    line("chain", `${id.chain ?? "?"} (${id.chainType ?? "?"})`);
    line("genesis", String(id.genesisHash ?? "?"));
    line("node", `${id.name ?? "?"} ${id.version ?? "?"}`);
    line("runtime", rt ? `${rt.specName} spec ${rt.specVersion}, impl ${rt.implName}, stateVersion ${rt.stateVersion ?? "not reported"}` : "?");
    line("properties", JSON.stringify(id.properties ?? null));
    if (r.runtimeApis) {
      const flags = Object.entries(r.runtimeApis.flags)
        .filter(([name]) => name !== "Core")
        .map(([name, f]) => `${name} ${f.present ? `v${f.version}` : "-"}`);
      line("runtime APIs", `${r.runtimeApis.all.length} listed; ${flags.join(", ")}`);
      line("", `ids computed as blake2b-64 of the name (Core ${r.runtimeApis.flags.Core.id} ${r.runtimeApis.flags.Core.present ? "found" : "NOT found"})`);
    }
    log("\nRPC surface");
    if (r.rpcSurface) {
      line("methods", String(r.rpcSurface.methodCount));
      for (const [m, has] of Object.entries(r.rpcSurface.flags)) line(m, yes(has));
      line("eth_ methods", r.rpcSurface.ethMethods.length ? `${r.rpcSurface.ethMethods.length}: ${r.rpcSurface.ethMethods.slice(0, 6).join(", ")}${r.rpcSurface.ethMethods.length > 6 ? ", ..." : ""}` : "none");
    } else line("rpc_methods", `failed: ${r.errors.rpc_methods}`);

    const f = r.finality;
    log("\nFinality");
    const B = f.finalized as BlockRef | null;
    line("heads", `best #${f.best === null ? "?" : fmt(f.best as number)}, finalized ${B ? `#${fmt(B.number)} ${shortHex(B.hash)}` : "?"}, lag ${f.lagBlocks ?? "?"}`);
    if (f.blockTimeMs !== undefined) line("block time", `${f.blockTimeMs ?? "?"} ms (last block), ${f.blockTimeAvgMs ?? "?"} ms (avg of ${f.blockTimeSpan}); deltas ${JSON.stringify(f.blockTimeDeltasMs)}`);
    const set = f.authoritySet as Record<string, unknown> | undefined;
    if (set) line("authority set", `set ${set.setId}: ${set.count} authorities, threshold ${set.threshold}, weights {${(set.weights as string[]).join(",")}}, //Alice ${yes(set.aliceIsAuthority as boolean)}`);
    else line("authority set", `none (${r.errors["grandpaSet.head"] ?? "not read"})`);
    const p = f.proof as Record<string, unknown> | undefined;
    if (p) {
      const target = p.target as BlockRef;
      const nc = p.negativeControls as Record<string, boolean>;
      line("proveFinality", `asked #${fmt(p.requested as number)}, target #${fmt(target.number)}, ${fmt(p.proofBytes as number)} B (justification ${fmt(p.justificationBytes as number)} B), unknown headers ${p.unknownHeaders}`);
      line("justification", `round ${p.round}, set ${p.setId}, ${p.precommits} precommits, ${p.validSignatures} valid, ${p.required} required, ancestries ${p.votesAncestries}, verified ${yes(p.verified as boolean)}`);
      line("controls", `set_id+1 rejected ${yes(nc.wrongSetIdRejected)}, flipped signature rejected ${yes(nc.flippedSignatureRejected)}`);
    } else line("proveFinality", `failed: ${r.errors.grandpa_proveFinality ?? "not called"}`);
    const sudo = f.sudoKey as { id: Hex; ss58: string } | null | undefined;
    line("Sudo.Key", sudo ? `${sudo.id} (${sudo.ss58})` : "none");
    if (f.beefyFinalizedHead !== undefined) line("BEEFY head", String(f.beefyFinalizedHead));

    log("\nState proofs");
    const rp = r.stateProofs.readProof as Record<string, unknown> | undefined;
    if (rp) {
      const acct = rp.account as { ss58: string; source: string };
      line("account", `${acct.ss58} (${acct.source})`);
      line("read proof", `${rp.nodes} nodes, ${fmt(rp.bytes as number)} B, trie V${rp.trieVersion} (runtime stateVersion ${rp.runtimeStateVersion ?? "not reported"}, ${rp.hashedValueNodes} hashed-value node(s))`);
      line("verified", rp.verified ? `yes, from state_root ${shortHex(rp.stateRoot as string)}; value ${rp.value ? `${(rp.value as { bytes: number }).bytes} B` : "absent"}${rp.free ? `, free ${rp.free}` : ""}; tampered root rejected ${yes(rp.tamperedRootRejected as boolean)}` : `NO: ${rp.error}`);
    } else line("read proof", `failed: ${r.errors.state_getReadProof ?? "not called"}`);
    const child = r.stateProofs.childReadProof as { listedInRpcMethods: boolean; probeCall: string | null };
    line("child read proof", `${child.listedInRpcMethods ? "listed" : "not listed"}; ${child.probeCall ?? "not called"}`);
  }
  if (r.evm) {
    log("\nEVM");
    for (const m of ["eth_chainId", "net_version", "eth_blockNumber", "web3_clientVersion"]) line(m, r.evm[m] === null ? `failed: ${r.errors[`evm.${m}`]}` : String(r.evm[m]));
  }
  log("\nLight-client gates");
  for (const g of r.gates) log(`  ${g.status}  ${g.gate.padEnd(34)} ${g.detail}`);
  const others = Object.entries(r.errors).filter(([k]) => !["grandpa_proveFinality", "state_getReadProof"].includes(k));
  if (others.length) {
    log("\nOther errors");
    for (const [k, v] of others) log(`  ${k}: ${v}`);
  }
  log(`\nVerdict: ${r.verdict} (${(r.elapsedMs / 1000).toFixed(1)} s)`);
}

// ---------------------------------------------------------------------------------------
// Main

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      rpc: { type: "string" },
      evm: { type: "string" },
      account: { type: "string" },
      out: { type: "string", default: fileURLToPath(new URL("../../fixtures/probe", import.meta.url)) },
    },
  });
  if (!values.rpc) {
    console.error("usage: npm run probe -- --rpc <wss url> [--evm <https url>] [--account <ss58 or 0x id>] [--out <dir>]");
    return 1;
  }
  let account: Uint8Array | undefined;
  try {
    account = values.account ? parseAccount(values.account) : undefined;
  } catch (error) {
    console.error(`--account: ${errorText(error)}`);
    return 1;
  }
  const report = await probe(values.rpc, values.evm, account, toolInfo());
  summary(report);
  const outDir = resolve(values.out);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, reportFileName(values.rpc));
  const bytes = writeJson(file, report);
  log(`Report: ${file} (${fmt(bytes)} B)`);
  return report.verdict === "FAIL" ? 1 : 0;
}

const watchdog = setTimeout(() => {
  console.error(`probe: no result after ${OVERALL_TIMEOUT_MS / 1000} s; FAIL`);
  process.exit(1);
}, OVERALL_TIMEOUT_MS);

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(`probe failed: ${errorText(error)}`);
    process.exitCode = 1;
  })
  .finally(() => clearTimeout(watchdog));
