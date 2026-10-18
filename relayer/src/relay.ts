// Relayer v0: brings a GrandpaLightClient on Sepolia up to date with its Portaldot chain.
//
//   npm run relay -- --chain mainnet|v3 [--dry-run] [--from <address>] [--watch <seconds>]
//   npm run relay -- --chain mainnet|v3 --send --account <keystore> --password-file <path> [--watch <seconds>]
//   more options: --rpc <wss url> (the Portaldot node), --scan-limit <blocks>, --head-every <blocks>,
//   --priority-fee <gwei>, --max-fee <gwei>, --max-base-fee <gwei>, --keep <eth>, --replace-after <minutes>
//
// A run reads the client's state on Sepolia (currentSetId, latestFinalized, authorities, halted,
// paused), takes a finality proof at the Portaldot finalized head, and scans the headers from
// there back to the client's latest header for GRANDPA set changes (changes.ts; pruned nodes
// serve headers too). It plans, in order, one importHeader per set change, with the
// justification the node stores for that block, then importFinalityProof at the head when the
// plan has a set change or the head is at least --head-every blocks past the client's latest
// header (by default about an hour of the chain's blocks: 60 on mainnet, 600 on V3, where a set
// change comes every 12 and every 6 hours). Each justification is verified here first, under the set the
// client will be in when it is imported and with the client's own signature check (grandpa.ts
// clientVerifies: SCL's, with no cofactor), and its signers hint counts exactly the threshold, by
// index in the client's key list. A run plans nothing, and says why, when the client is halted or
// paused, when a change ahead would halt it (a ForcedChange, a delayed or multiple change, a list
// the client cannot use, such as more than MAX_AUTHORITIES keys), when an import would revert, or
// when the client is more than --scan-limit blocks behind.
//
// The sender is the address the keystore unlocks to with --send, and --from (by default the
// deployer) in a dry run: its nonce and balance are the ones used and recorded. Imports need no
// rights on the client, while its admin (the deployer) can pause and reinitialize it, so --watch
// --send is better run with a key of its own and a small balance; a run warns when the sender is
// a client's admin.
//
// --dry-run (the default) has a Sepolia node run the plan with eth_simulateV1 (validation on), on
// top of its latest block, from the sender with its nonce and balance on chain: every transaction
// first with the 16,777,216 cap as gas limit, then with the limit it is sent with (its gas + 10%).
// Every import must emit HeaderImported, a set change also AuthoritySetChanged, and none Halted.
// Each request stays within the gas a node lets one request use; a request starts from the
// client's storage as the one before left it (the slots its imports wrote, read back in that
// simulation), and from the sender's nonce and remaining balance. With every transaction at its
// max fee, the sender must still keep --keep (default 0.05 ETH).
// --send runs the same dry run, then sends the plan one transaction at a time the way
// contracts/script/deploy-sepolia.mjs sends its steps (cast mktx with the keystore, the hash
// recorded, cast publish, the receipt and its events checked), each after checking, at the latest
// block, that the client is still where the plan expects it and neither paused nor halted. While
// the next base fee is above --max-base-fee (default 0.05 gwei) nothing is sent, and the run ends
// OK (or 3 while a transaction of the record is pending). A transaction not mined after
// --replace-after minutes (default 5) is signed again at its nonce, with its max fee and priority
// fee raised by at least 1/8, never above the max fee a run would use at --max-base-fee, nor above
// --max-fee when it is given. All transactions for one import share its nonce, so at most one
// of them is mined. When another relayer imports the header or a later one first, the
// transaction is recorded as superseded and the next run plans again.
// deployments/relay-sepolia-<sender>.json holds the sender's transactions not settled yet (signed,
// pending, or dropped while their nonce is free), each written before it is broadcast; a settled
// one (mined and checked, superseded, or replaced by another at its nonce) moves to
// deployments/relay-sepolia-<sender>.jsonl, a line appended, so the JSON stays small and the
// history is never rewritten. Before planning, a run settles what the JSON left open. Only one
// --send run per sender at a time holds the lock bridge-zero-relay-<sender>.lock in the system's
// temp directory, which every checkout shares.
// --watch starts the next run <seconds> (at least 10) after each run ends, a failed one too; after
// runs in a row that stop on something only the client's admin or the operator can clear (a halt,
// a pause, a ForcedChange, the scan limit, ...), the wait doubles each time, up to an hour.
//
// The Sepolia RPC is SEPOLIA_RPC_URL when set, else the public endpoint; of it and of a --rpc URL
// only the host is printed. Exit code 0 when the client is up to date, the dry run passed, the
// plan was sent and checked, or the base fee is too high to send; 1 when a check fails or nothing
// can be relayed; 2 when an RPC cannot be reached or a read keeps failing; 3 when a sent
// transaction is still pending. With --watch, only a sent transaction that fails its checks, or a
// signing or record problem, ends the loop.

import { appendFileSync, closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, equalBytes, hexToBytes, shortHex, toSafeNumber, utf8, type Hex } from "./bytes.js";
import { scanSetChanges, type FoundChange, type HeaderSource } from "./changes.js";
import { clientVerifies, threshold, verifyJustification } from "./grandpa.js";
import { blake2_256 } from "./hash.js";
import { RpcClient, RpcError } from "./rpc.js";
import {
  decodeFinalityProof,
  decodeHeader,
  decodeJustification,
  encodeRpcHeader,
  GRANDPA_ENGINE,
  type Header,
  type Justification,
  type RpcHeader,
} from "./scale.js";
import {
  CAP,
  PROBE,
  PROBE_CODE,
  PROBE_GAS,
  PROBE_SENDER,
  RECEIPT_TIMEOUT,
  REQUEST_GAS,
  RPC,
  SEPOLIA_CHAIN_ID,
  concat,
  dataWord,
  encode,
  eth,
  feesAt,
  findLog,
  fmt,
  gasOf,
  keccak256,
  keystoreAddress,
  mktxArgs,
  nonces,
  parseGwei,
  qty,
  receiptOf,
  redact,
  redactAlso,
  retry,
  rpc,
  share,
  signAndPublish,
  sleep,
  topic,
  withHeadroom,
  word,
  writeJsonAtomic,
  type Fees,
  type Log,
  type Receipt,
} from "../../contracts/script/lib/sepolia.mjs";

/** headEvery: the default --head-every, about an hour of the chain's blocks (60 s on the old mainnet, 6 s on V3). */
const CHAINS = {
  mainnet: { title: "the old Portaldot mainnet", rpc: "wss://mainnet.portaldot.io", client: "GrandpaLightClient #1", headEvery: 60 },
  v3: { title: "the Portaldot V3 testnet", rpc: "wss://test-node-v3.portaldot.dev", client: "GrandpaLightClient #2", headEvery: 600 },
} as const;
type ChainName = keyof typeof CHAINS;

const DEPLOYMENT = fileURLToPath(new URL("../../deployments/sepolia.json", import.meta.url));
/** Where each sender's record and history are written. */
const DEPLOYMENTS = fileURLToPath(new URL("../../deployments", import.meta.url));

/** How far below the head the client's latest header may be: about 2 days of 6 s blocks, 3 weeks of 60 s blocks. */
const DEFAULT_SCAN_LIMIT = 30_000;
/** Header requests in flight during the scan. */
const SCAN_CONCURRENCY = 32;
const MIN_WATCH_SECONDS = 10;
/** The longest --watch waits between runs that stop on something only the admin or the operator can clear. */
const MAX_BACKOFF_SECONDS = 3_600;
/** How long a nonce used on chain waits for a receipt of the record's transactions at it (an RPC can lag). */
const NONCE_WAIT = 60_000;
/** Gas limit of each view of the client read at the end of a simulated request. */
const VIEW_GAS = 200_000;
/** Returns SLOAD of each 32-byte word of its calldata. Given the client's address in a simulation, it reads the client's storage. */
const DUMPER_CODE = "0x5f5b8036111560145780355481526020016001565b365ff3";
const dumpGas = (slots: number) => 50_000 + 3_000 * slots;

const OK = 0;
const FAILED = 1;
const UNREACHABLE = 2;
const PENDING = 3;

const log = (message = "") => console.log(message);
const errorText = (error: unknown) => redact(error instanceof Error ? error.message : String(error));
const tag = (s: Step) => `[${String(s.index).padStart(2)}]`;
const max = (...values: bigint[]) => values.reduce((a, b) => (b > a ? b : a));
/** A synchronous pause, for the lock (as writeJsonAtomic waits). */
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Checks of the current run, printed as the Sepolia scripts print theirs. */
let failures = 0;
function check(ok: boolean, what: string): boolean {
  log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
  return ok;
}

/** Why the client cannot be brought up to date in this run. */
class Stop extends Error {
  override name = "Stop";
}

/** A Stop that later runs cannot get past until the client's admin or the operator acts: --watch waits longer after each. */
class Blocked extends Stop {
  override name = "Blocked";
}

/** A problem a later run cannot get past alone: --watch ends. */
class Fatal extends Error {
  override name = "Fatal";
}

/** A read from Sepolia or the Portaldot node that failed, after its retries: exit code 2. */
class Unreachable extends Error {
  override name = "Unreachable";
}

/** A Sepolia read, retried as a load-balanced RPC can lag; Unreachable when it keeps failing. */
async function sepolia<R>(what: string, read: () => Promise<R>): Promise<R> {
  try {
    return await retry(what, read);
  } catch (error) {
    throw new Unreachable(`Sepolia RPC unreachable (${what}: ${errorText(error)})`);
  }
}

/** A Sepolia read that retries by itself (receiptOf); Unreachable when it fails. */
const reached = <R>(what: string, read: Promise<R>): Promise<R> =>
  read.catch((error: unknown) => {
    throw new Unreachable(`Sepolia RPC unreachable (${what}: ${errorText(error)})`);
  });

/** The request never got an answer (fetch failed, timed out, or no JSON came back), as opposed to an error the RPC returned. */
const offline = (error: unknown) =>
  error instanceof TypeError || error instanceof SyntaxError || (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"));

// ---------------------------------------------------------------------------------------
// Options

interface Options {
  chain: ChainName;
  send: boolean;
  account?: string;
  passwordFile?: string;
  /** --from: the sender of a dry run. */
  from?: Hex;
  watch?: number;
  rpc: string;
  scanLimit: number;
  headEvery: number;
  priorityFee?: bigint;
  maxFee?: bigint;
  maxBaseFee: bigint;
  keep: bigint;
  /** Milliseconds a transaction waits for its receipt before its nonce is signed again with higher fees. */
  replaceAfter: number;
}

function usage(problem: string): never {
  log(`${problem}
usage (from relayer/):
  npm run relay -- --chain mainnet|v3 [--dry-run] [--from <address>] [--watch <seconds>]
  npm run relay -- --chain mainnet|v3 --send --account <keystore> --password-file <path> [--watch <seconds>]
  more options: --rpc <wss url>, --scan-limit <blocks>, --head-every <blocks>, --priority-fee <gwei>, --max-fee <gwei>,
    --max-base-fee <gwei> (default 0.05), --keep <eth> (default 0.05), --replace-after <minutes> (default 5)`);
  process.exit(FAILED);
}

function parse() {
  try {
    return parseArgs({
      options: {
        chain: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        send: { type: "boolean", default: false },
        account: { type: "string" },
        "password-file": { type: "string" },
        from: { type: "string" },
        watch: { type: "string" },
        rpc: { type: "string" },
        "scan-limit": { type: "string", default: String(DEFAULT_SCAN_LIMIT) },
        "head-every": { type: "string" },
        "priority-fee": { type: "string" },
        "max-fee": { type: "string" },
        "max-base-fee": { type: "string", default: "0.05" },
        keep: { type: "string", default: "0.05" },
        "replace-after": { type: "string", default: "5" },
      },
    }).values;
  } catch (error) {
    usage(errorText(error));
  }
}

/** An amount in ETH ("0.05") in wei; 0 is allowed. */
function parseEth(s: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,18}))?$/.exec(s);
  if (!m) throw new Error(`not an amount in ETH: ${s}`);
  return BigInt(m[1]) * 10n ** 18n + BigInt((m[2] ?? "").padEnd(18, "0"));
}

/** A whole number written as digits only (Number() alone also takes "1e2" and "0x10"); NaN otherwise. */
const whole = (s: string) => (/^\d+$/.test(s) ? Number(s) : NaN);

function options(): Options {
  const values = parse();
  const chain = values.chain;
  if (chain !== "mainnet" && chain !== "v3") usage("--chain must be mainnet or v3");
  if (values["dry-run"] && values.send) usage("choose one of --dry-run and --send");
  const send = values.send;
  if (send && !(values.account && values["password-file"])) usage("--send needs --account <keystore name> and --password-file <path>");
  if (send && values.from !== undefined) usage("--from is for a dry run: --send sends from the address its keystore unlocks to");
  if (values.from !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(values.from)) usage("--from must be an address: 0x and 40 hex digits");
  // cast runs in a directory of its own: the path is made absolute here (the file is never opened by this script).
  const passwordFile = values["password-file"] === undefined ? undefined : resolve(values["password-file"]);
  if (send && !existsSync(passwordFile!)) usage("--password-file: no such file");
  const rpcUrl = values.rpc ?? CHAINS[chain].rpc;
  if (!/^wss?:\/\//i.test(rpcUrl) || !URL.canParse(rpcUrl)) usage("--rpc must be a ws:// or wss:// URL");
  let watch: number | undefined;
  if (values.watch !== undefined) {
    watch = whole(values.watch);
    if (!Number.isSafeInteger(watch) || watch < MIN_WATCH_SECONDS) usage(`--watch must be a whole number of seconds, at least ${MIN_WATCH_SECONDS}`);
  }
  const scanLimit = whole(values["scan-limit"]);
  if (!Number.isSafeInteger(scanLimit) || scanLimit < 1) usage("--scan-limit must be a positive number of blocks");
  const headEvery = values["head-every"] === undefined ? CHAINS[chain].headEvery : whole(values["head-every"]);
  if (!Number.isSafeInteger(headEvery) || headEvery < 1) usage("--head-every must be a positive number of blocks");
  const replaceAfter = whole(values["replace-after"]);
  if (!Number.isSafeInteger(replaceAfter) || replaceAfter < 1) usage("--replace-after must be a positive number of minutes");
  const amount = (s: string | undefined, parseAmount: (s: string) => bigint) => {
    if (s === undefined) return undefined;
    try {
      return parseAmount(s);
    } catch (error) {
      usage(errorText(error));
    }
  };
  return {
    chain,
    send,
    account: values.account,
    passwordFile,
    from: values.from?.toLowerCase() as Hex | undefined,
    watch,
    rpc: rpcUrl,
    scanLimit,
    headEvery,
    priorityFee: amount(values["priority-fee"], parseGwei),
    maxFee: amount(values["max-fee"], parseGwei),
    maxBaseFee: amount(values["max-base-fee"], parseGwei)!,
    keep: amount(values.keep, parseEth)!,
    replaceAfter: replaceAfter * 60_000,
  };
}

// ---------------------------------------------------------------------------------------
// The deployment

/** What deployments/sepolia.json says: the client's address and code, every light client, and the deployer (the dry run's sender unless --from). */
interface Deployment {
  /** The deployer, lower case, and as the record writes it. */
  deployer: Hex;
  deployerName: string;
  client: Hex;
  /** keccak256 of the client's runtime code. */
  codeHash: Hex;
  /** Every GrandpaLightClient deployed, to tell whether the sender is the admin of one. */
  clients: { name: string; address: Hex }[];
}

function deployment(chain: ChainName): Deployment {
  const name = CHAINS[chain].client;
  const record = JSON.parse(readFileSync(DEPLOYMENT, "utf8")) as {
    chainId: number;
    deployer: string;
    contracts: Record<string, string>;
    steps: { name: string; codeHash: string | null }[];
  };
  const client = record.contracts[name];
  const codeHash = record.steps.find((s) => s.name === name)?.codeHash;
  if (record.chainId !== Number(SEPOLIA_CHAIN_ID) || !client || !codeHash) throw new Fatal(`${DEPLOYMENT} has no ${name} on Sepolia`);
  return {
    deployer: record.deployer.toLowerCase() as Hex,
    deployerName: record.deployer,
    client: client.toLowerCase() as Hex,
    codeHash: codeHash as Hex,
    clients: Object.entries(record.contracts)
      .filter(([n]) => n.startsWith("GrandpaLightClient"))
      .map(([n, address]) => ({ name: n, address: address.toLowerCase() as Hex })),
  };
}

/** Who signs and pays: the address (lower case), how a run prints it, and its record, history and lock. */
interface Sender {
  address: Hex;
  name: string;
  record: string;
  history: string;
  lock: string;
}

function senderOf(address: Hex, name: string): Sender {
  return {
    address,
    name,
    record: join(DEPLOYMENTS, `relay-sepolia-${address}.json`),
    history: join(DEPLOYMENTS, `relay-sepolia-${address}.jsonl`),
    lock: join(tmpdir(), `bridge-zero-relay-${address}.lock`),
  };
}

// ---------------------------------------------------------------------------------------
// Portaldot

/** Turns RPC byte fields into bytes: hex strings, or number arrays (as some nodes' chain_getBlock returns). */
function rpcBytes(value: unknown): Uint8Array {
  if (typeof value === "string") return hexToBytes(value);
  if (Array.isArray(value) && value.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) return Uint8Array.from(value as number[]);
  throw new Error(`unexpected byte encoding in RPC result: ${JSON.stringify(value).slice(0, 40)}`);
}

function engineId(value: unknown): string {
  if (typeof value === "string" && !value.startsWith("0x")) return value;
  return String.fromCharCode(...rpcBytes(value));
}

/** What a run reads from the Portaldot node. Every header is refused unless it hashes to its block hash. */
class Portaldot implements HeaderSource {
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

  /** chain_getHeader, re-encoded to SCALE; refused unless blake2_256 of the bytes is the block hash. */
  async header(hash: Hex): Promise<Header> {
    const json = await this.rpc.request<RpcHeader | null>("chain_getHeader", [hash]);
    if (!json) throw new Error(`no header for ${hash}`);
    const header = decodeHeader(encodeRpcHeader(json));
    const computed = bytesToHex(blake2_256(header.encoded));
    if (computed !== hash.toLowerCase()) throw new Error(`header ${hash} re-encodes to a different hash ${computed}`);
    return header;
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
   * grandpa_proveFinality at `number`. A proof for a later block carries the headers in between,
   * which the client does not take (UnknownHeadersNotEmpty), so it is asked again at that block.
   */
  async finalityProof(number: number): Promise<{ scale: Uint8Array; block: Uint8Array; justification: Uint8Array; unknownHeaders: number } | null> {
    let requested = number;
    for (let attempt = 1; ; attempt++) {
      const proofHex = await this.rpc.request<Hex | null>("grandpa_proveFinality", [requested]);
      if (!proofHex) return null;
      const scale = hexToBytes(proofHex);
      const proof = decodeFinalityProof(scale);
      if (proof.unknownHeaders.length === 0 || attempt === 3) {
        return { scale, block: proof.block, justification: proof.justification, unknownHeaders: proof.unknownHeaders.length };
      }
      requested = decodeJustification(proof.justification).targetNumber;
    }
  }
}

// ---------------------------------------------------------------------------------------
// The light client on Sepolia

const selector = (signature: string) => keccak256(utf8(signature)).slice(0, 4);
/** Calldata of a call whose arguments are all static words. */
const callData = (signature: string, ...args: Uint8Array[]): Hex => bytesToHex(concat(selector(signature), ...args));
const wordAt = (b: Uint8Array, i: number) => b.slice(32 * i, 32 * i + 32);
const uintAt = (b: Uint8Array, i: number) => BigInt(bytesToHex(wordAt(b, i)));
/** A bytes32[] return value: offset, length, items. */
const bytes32Array = (b: Uint8Array) => Array.from({ length: Number(uintAt(b, 1)) }, (_, i) => wordAt(b, 2 + i));
/** keccak256(abi.encodePacked(keys)): the key list's hash in the client (AuthoritySet.listHash). */
const listHash = (keys: Uint8Array[]) => bytesToHex(keccak256(concat(...keys)));

const T = {
  imported: topic("HeaderImported(bytes32,uint32,bytes32,uint64,uint256)"),
  changed: topic("AuthoritySetChanged(uint64,uint64,bytes32,uint256,uint32)"),
  halted: topic("Halted(uint32,bytes32,uint8)"),
};

/** The client's errors and those of its decoding libraries, to name a revert. */
const ERRORS = new Map(
  [
    "NotInitialized()", "ClientHalted()", "ClientPaused()", "UnknownAuthoritySet(uint64)", "UnknownBlock(bytes32)",
    "HeaderHashMismatch(bytes32,bytes32)", "TargetNumberMismatch(uint32,uint32)", "FinalityProofBlockMismatch(bytes32,bytes32)",
    "NotNewer(uint32,uint32)", "MalformedSigners(uint256)", "BelowThreshold(uint256,uint256)",
    "PrecommitIndexOutOfRange(uint256,uint256)", "DuplicatePrecommit(uint256,uint256)",
    "AuthorityIndexOutOfRange(uint256,uint256,uint256)", "DuplicateSigner(uint256,uint256)",
    "SignersOutOfOrder(uint256,uint256,uint256)", "PrecommitNotOnTarget(uint256,uint256)",
    "UnknownSigner(uint256,uint256,bytes32)", "InvalidSignature(uint256,uint256)", "WrongSetId(uint64,uint64)",
    "Truncated(uint256,uint256)", "TrailingBytes(uint256,uint256)", "NonCanonicalCompact(uint256)", "CompactOverflow(uint256)",
    "UnknownDigestItem(uint8,uint256)", "UnknownGrandpaLog(uint8,uint256)",
    "VotesAncestriesNotEmpty(uint256)", "UnknownHeadersNotEmpty(uint256)",
  ].map((signature) => [bytesToHex(selector(signature)), signature] as const),
);

/** The client's state at one Sepolia block. */
interface ClientState {
  genesis: Hex;
  setId: bigint;
  keys: Uint8Array[];
  latestHash: Hex;
  latestNumber: number;
  halted: boolean;
  paused: boolean;
  maxAuthorities: number;
  /** authoritySetCount(): the index in the client's list of sets that the next set takes. */
  sets: number;
}

async function readClient(client: Hex, block: string): Promise<ClientState> {
  const get = async (signature: string, ...args: Uint8Array[]) => hexToBytes(await rpc<Hex>("eth_call", [{ to: client, data: callData(signature, ...args) }, block]));
  const setId = uintAt(await get("currentSetId()"), 0);
  const latest = await get("latestFinalized()");
  return {
    genesis: bytesToHex(wordAt(await get("genesisHash()"), 0)),
    setId,
    keys: bytes32Array(await get("authorities(uint64)", word(setId))),
    latestHash: bytesToHex(wordAt(latest, 0)),
    latestNumber: Number(uintAt(latest, 1)),
    halted: uintAt(await get("halted()"), 0) !== 0n,
    paused: uintAt(await get("paused()"), 0) !== 0n,
    maxAuthorities: Number(uintAt(await get("MAX_AUTHORITIES()"), 0)),
    sets: Number(uintAt(await get("authoritySetCount()"), 0)),
  };
}

/** latestFinalized() and isImported(`hash`) at `block`; retried, as a load-balanced RPC can lag the block of a receipt. */
async function readLatest(client: Hex, block: string, hash: Hex): Promise<{ hash: Hex; number: number; imported: boolean }> {
  const get = (data: Hex) => sepolia("client state", () => rpc<Hex>("eth_call", [{ to: client, data }, block]));
  const latest = hexToBytes(await get(callData("latestFinalized()")));
  const imported = BigInt(await get(callData("isImported(bytes32)", hexToBytes(hash)))) !== 0n;
  return { hash: bytesToHex(wordAt(latest, 0)), number: Number(uintAt(latest, 1)), imported };
}

/** What the next transaction of a plan finds: the client at the RPC's latest block. */
interface Now {
  block: number;
  hash: Hex;
  number: number;
  setId: bigint;
  halted: boolean;
  paused: boolean;
}

/**
 * The client's latest header, set, halt and pause at the RPC's latest block, once that block is
 * `after` or later (a load-balanced RPC can lag the block of the previous receipt).
 */
async function clientNow(client: Hex, after: number): Promise<Now> {
  const until = Date.now() + 60_000;
  for (;;) {
    const head = Number(BigInt(await sepolia("block number", () => rpc<string>("eth_blockNumber", []))));
    if (head >= after) {
      const get = (signature: string) => sepolia("client state", () => rpc<Hex>("eth_call", [{ to: client, data: callData(signature) }, qty(head)]));
      const latest = hexToBytes(await get("latestFinalized()"));
      return {
        block: head,
        hash: bytesToHex(wordAt(latest, 0)),
        number: Number(uintAt(latest, 1)),
        setId: BigInt(await get("currentSetId()")),
        halted: BigInt(await get("halted()")) !== 0n,
        paused: BigInt(await get("paused()")) !== 0n,
      };
    }
    if (Date.now() > until) throw new Unreachable(`Sepolia RPC unreachable (its latest block is still #${fmt(head)}, below #${fmt(after)})`);
    await sleep(3_000);
  }
}

// Storage of the client: AuthoritySets.Store at slot 0 (forge inspect GrandpaLightClient storageLayout).
//   0 admin | halted | paused | latestNumber | currentSet    1 genesisHash    2 latestHash
//   3 sets: AuthoritySet[], 3 slots each (genesisHash, listHash, setId | activatedAt)
//   4 lists: listHash => KeyList { bytes32[] keys; uint256[2][] points }
//   5 setIndexOf: keccak256(abi.encode(genesisHash, setId)) => index + 1
//   6 headers: blockHash => StoredHeader, 2 slots (stateRoot; number | setIndex | known)
const SLOT_MOD = 1n << 256n;
const hashSlot = (...parts: Uint8Array[]) => BigInt(bytesToHex(keccak256(concat(...parts))));
const mapSlot = (key: Uint8Array, slot: bigint) => hashSlot(key, word(slot));
const plus = (slot: bigint, offset: bigint) => (slot + offset) % SLOT_MOD;

/** The slots an import writes: the latest header, its record and, for a set change, the new set and its key list. */
function writesOf(hash: Hex, change: { setIndex: number; genesis: Hex; setId: bigint; keys: Uint8Array[] } | null): bigint[] {
  const header = mapSlot(hexToBytes(hash), 6n);
  const slots = [0n, 2n, header, plus(header, 1n)];
  if (!change) return slots;
  const set = plus(hashSlot(word(3n)), 3n * BigInt(change.setIndex));
  slots.push(3n, set, plus(set, 1n), plus(set, 2n));
  slots.push(mapSlot(keccak256(concat(hexToBytes(change.genesis), word(change.setId))), 5n));
  // The key list is written only if no set has used it before; reading it back costs little either way.
  const list = mapSlot(hexToBytes(listHash(change.keys)), 4n);
  const keys = hashSlot(word(list));
  const points = hashSlot(word(plus(list, 1n)));
  slots.push(list, plus(list, 1n));
  change.keys.forEach((_, i) => slots.push(plus(keys, BigInt(i)), plus(points, 2n * BigInt(i)), plus(points, 2n * BigInt(i) + 1n)));
  return slots;
}

// ---------------------------------------------------------------------------------------
// The plan

interface Step {
  index: number;
  nonce: number;
  method: "importHeader" | "importFinalityProof";
  number: number;
  hash: Hex;
  /** The set that verifies the import, and the client's set after it. */
  setBefore: bigint;
  setAfter: bigint;
  keysAfter: Uint8Array[];
  /** Signatures the signers hint counts. */
  signatures: number;
  /** The client's latest header before the import. */
  before: { hash: Hex; number: number };
  data: Hex;
  writes: bigint[];
  label: string;
}

interface Plan {
  steps: Step[];
  /** Why the plan stops short of the finalized head, if it does. */
  notes: string[];
  /** Set, with no steps, when nothing is due: why the client counts as up to date. */
  upToDate?: string;
}

const upToDate = (why: string): Plan => ({ steps: [], notes: [], upToDate: why });

/** AuthoritySets.deriveKey accepts the key: the canonical encoding of a curve point that is not of small order. */
function usableKey(key: Uint8Array): boolean {
  try {
    return !ed25519.Point.fromBytes(key, false).isSmallOrder();
  } catch {
    return false;
  }
}

/** Why the client would halt on this set change (GrandpaCodec.decodeHeader, AuthoritySets.enactChange), or null. */
function haltReason(change: FoundChange, maxAuthorities: number): string | null {
  if (change.logs.length !== 1) return `${change.logs.length} set changes in one header (MultipleChanges)`;
  const l = change.logs[0].log;
  if (l.kind === "ForcedChange") return `a ForcedChange (median #${fmt(l.median)}, delay ${l.delay})`;
  if (l.kind !== "ScheduledChange") return `a ${l.kind} log`;
  if (l.delay !== 0) return `a ScheduledChange with delay ${l.delay} (DelayedChange)`;
  const keys = l.nextAuthorities;
  if (keys.some((a) => a.weight !== 1n)) return "a ScheduledChange with a weight other than 1 (UnusableAuthoritySet)";
  if (keys.length === 0 || keys.length > maxAuthorities) {
    return `a ScheduledChange to ${keys.length} keys, where the client takes 1 to ${maxAuthorities} (UnusableAuthoritySet)`;
  }
  if (new Set(keys.map((a) => bytesToHex(a.id))).size !== keys.length) return "a ScheduledChange with a duplicate key (UnusableAuthoritySet)";
  const bad = keys.findIndex((a) => !usableKey(a.id));
  if (bad >= 0) return `a ScheduledChange whose key ${bad} (${shortHex(keys[bad].id)}) is no usable ed25519 point (UnusableAuthoritySet)`;
  return null;
}

/** The light client decodes the digest items of current runtimes only; a header with another one reverts. */
function checkDigest(header: Header, hash: Hex): void {
  const old = header.digest.find((d) => d.kind === "ChangesTrieRoot");
  if (old) throw new Blocked(`#${fmt(header.number)} ${hash} carries a ChangesTrieRoot digest item: its import would revert (UnknownDigestItem)`);
}

/** A justification the client accepts under its set, with the signers hint that makes it count. */
interface Verified {
  j: Justification;
  hint: Uint8Array;
  /** Precommits the hint leaves out because the client would not count them, with why. */
  uncounted: string[];
}

/**
 * Decodes `scale`, a justification for block `number` (`hash`), and verifies it under `set`
 * (grandpa.ts, as the client checks each counted precommit: on the target, signed by a member of
 * the set, each member once, and its signature by the client's own check, clientVerifies). The
 * hint counts exactly the threshold, as (position, index in the set's keys) pairs in increasing
 * index, the order the client requires. Throws Stop unless the client would accept it; null for
 * votes_ancestries, which the client does not decode.
 */
function verified(scale: Uint8Array, hash: Hex, number: number, set: { id: bigint; keys: Uint8Array[] }, what: string): Verified | null {
  const j = decodeJustification(scale);
  if (bytesToHex(j.targetHash) !== hash || j.targetNumber !== number) throw new Stop(`${what} for #${fmt(number)} targets #${fmt(j.targetNumber)} ${bytesToHex(j.targetHash)}`);
  if (j.votesAncestries.length > 0) return null;
  const result = verifyJustification(j, set.keys, set.id, clientVerifies);
  if (result.valid < result.required) throw new Stop(`${what} for #${fmt(number)} does not verify under the client's set ${set.id}: ${result.problems.join("; ")}`);
  // A hint names a precommit by a one-byte position.
  const counted = result.precommits
    .filter((p) => p.problem === undefined && p.index < 256)
    .sort((a, b) => a.authorityIndex - b.authorityIndex)
    .slice(0, result.required);
  if (counted.length < result.required) throw new Stop(`${what} for #${fmt(number)} has its valid precommits beyond position 255, where a signers hint cannot name them`);
  const hint = Uint8Array.from(counted.flatMap((p) => [p.index, p.authorityIndex]));
  return { j, hint, uncounted: result.problems };
}

/**
 * The imports that bring the client from its latest header to the Portaldot finalized head, or
 * none, with why, when it is there already or within --head-every of it with no set change due.
 * Throws Stop when the client cannot be brought further (Blocked when no later run can either).
 */
async function makePlan(portaldot: Portaldot, client: ClientState, o: Options): Promise<Plan> {
  const chainName = await portaldot.rpc.request<string>("system_chain");
  const genesis = (await portaldot.blockHash(0)).toLowerCase();
  const finalizedHash = (await portaldot.rpc.request<Hex>("chain_getFinalizedHead")).toLowerCase() as Hex;
  const finalized = await portaldot.header(finalizedHash);
  log(`Portaldot: ${chainName} via ${new URL(o.rpc).host}, finalized head #${fmt(finalized.number)} ${finalizedHash}`);
  if (!check(genesis === client.genesis, `the node serves the client's chain (genesis ${shortHex(client.genesis)})`)) {
    throw new Blocked(`the client follows genesis ${client.genesis}, the node serves ${genesis}`);
  }
  const atLatest = (await portaldot.rpc.request<Hex | null>("chain_getBlockHash", [client.latestNumber]))?.toLowerCase();
  if (!check(atLatest === client.latestHash, `the client's latest header #${fmt(client.latestNumber)} ${shortHex(client.latestHash)} is the node's block there`)) {
    throw new Blocked(`the node's block #${fmt(client.latestNumber)} is ${atLatest ?? "missing"}: the client is not on this chain (a reset testnet?) and needs reinitialize`);
  }
  if (finalized.number <= client.latestNumber) return upToDate(`the node's finalized head is not above #${fmt(client.latestNumber)}`);

  // The head is the block a finality proof without unknown headers is for: the finalized head, or
  // a later block if finality moved on meanwhile. Without one, the plan ends at the last set change.
  const notes: string[] = [];
  let head = { number: finalized.number, hash: finalizedHash, header: finalized };
  let headProof: { scale: Uint8Array; justification: Uint8Array } | null = null;
  const proof = await portaldot.finalityProof(finalized.number);
  if (!proof) notes.push(`the head is left for a later run: grandpa_proveFinality(${finalized.number}) returned no proof`);
  else if (proof.unknownHeaders > 0) {
    notes.push(`the head is left for a later run: the finality proof at #${fmt(finalized.number)} still carries ${proof.unknownHeaders} unknown headers`);
  } else {
    const j = decodeJustification(proof.justification);
    if (!equalBytes(proof.block, j.targetHash)) throw new Stop(`the finality proof is for ${bytesToHex(proof.block)} but its justification for ${bytesToHex(j.targetHash)}`);
    if (j.targetNumber <= client.latestNumber) {
      return upToDate(`the node's finality proof is for #${fmt(j.targetNumber)}, not above the client's latest #${fmt(client.latestNumber)}`);
    }
    const hash = bytesToHex(j.targetHash);
    head = { number: j.targetNumber, hash, header: await portaldot.header(hash) };
    headProof = { scale: proof.scale, justification: proof.justification };
  }

  const behind = head.number - client.latestNumber;
  if (behind > o.scanLimit) {
    throw new Blocked(
      `the client's latest header #${fmt(client.latestNumber)} is ${fmt(behind)} blocks below #${fmt(head.number)}, ` +
        `more than --scan-limit ${fmt(o.scanLimit)}: every set change in between has to be found, so raise it`,
    );
  }
  const started = Date.now();
  const scan = await scanSetChanges(
    portaldot,
    { header: head.header, hash: hexToBytes(head.hash) },
    { want: Number.MAX_SAFE_INTEGER, limit: behind - 1, concurrency: SCAN_CONCURRENCY },
  );
  // The scan links each header to the one above it, from the head down; the lowest must sit on the client's latest.
  if (scan.lowest !== client.latestNumber + 1 || scan.lowestParentHash !== client.latestHash) {
    throw new Error(`the scan ended at #${scan.lowest}, child of ${scan.lowestParentHash}, not on the client's latest header #${client.latestNumber} ${client.latestHash}`);
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  log(
    `Scanned ${fmt(scan.examined)} headers, #${fmt(head.number)} back to #${fmt(scan.lowest)}, in ${seconds} s: ` +
      `${scan.changes.length} set change${scan.changes.length === 1 ? "" : "s"}` +
      (scan.otherLogs.length ? `; other FRNK logs: ${scan.otherLogs.map((x) => `${x.kind} at #${fmt(x.number)}`).join(", ")}` : ""),
  );

  const steps: Step[] = [];
  let set = { id: client.setId, keys: client.keys };
  let before = { hash: client.latestHash, number: client.latestNumber };
  const add = (method: Step["method"], header: Header, hash: Hex, v: Verified, payload: Uint8Array, next: Uint8Array[] | null) => {
    const setAfter = next ? set.id + 1n : set.id;
    const keysAfter = next ?? set.keys;
    const change = next ? { setIndex: client.sets + steps.filter((s) => s.setAfter !== s.setBefore).length, genesis: client.genesis, setId: setAfter, keys: next } : null;
    const signatures = v.hint.length / 2;
    steps.push({
      index: steps.length,
      nonce: 0,
      method,
      number: header.number,
      hash,
      setBefore: set.id,
      setAfter,
      keysAfter,
      signatures,
      before,
      data: bytesToHex(
        concat(selector(`${method}(bytes,bytes,bytes)`), encode([{ bytes: header.encoded }, { bytes: payload }, { bytes: v.hint }])),
      ),
      writes: writesOf(hash, change),
      label:
        `${method} #${fmt(header.number)}, ` +
        (next ? `set ${set.id} -> ${setAfter}` : `set ${set.id}`) +
        `, ${signatures} of ${set.keys.length} signatures`,
    });
    before = { hash, number: header.number };
    set = { id: setAfter, keys: keysAfter };
  };

  // A set change no run can import (its stored justification does not change) needs the admin.
  for (const c of [...scan.changes].reverse()) {
    const reason = haltReason(c, client.maxAuthorities);
    if (reason) {
      throw new Blocked(`#${fmt(c.number)} ${c.hash} carries ${reason}: importing it would halt the client, which then needs reinitialize at a later checkpoint`);
    }
    checkDigest(c.header, c.hash);
    const scale = await portaldot.storedJustification(c.hash);
    if (!scale) throw new Blocked(`the node stores no justification for the set change at #${fmt(c.number)} ${c.hash}`);
    let v: Verified | null;
    try {
      v = verified(scale, c.hash, c.number, set, "the stored justification");
    } catch (error) {
      throw error instanceof Stop ? new Blocked(error.message) : error;
    }
    if (!v) {
      throw new Blocked(
        `the stored justification for the set change at #${fmt(c.number)} carries votes_ancestries: its import would revert (VotesAncestriesNotEmpty), ` +
          `so the client cannot follow this change`,
      );
    }
    const l = c.logs[0].log;
    const next = l.kind === "ScheduledChange" ? l.nextAuthorities.map((a) => a.id) : [];
    const same = next.length === set.keys.length && next.every((k, i) => equalBytes(k, set.keys[i]));
    check(
      true,
      `#${fmt(c.number)} ${shortHex(c.hash)}: ScheduledChange, delay 0, ${next.length} keys (${same ? "the same keys" : "new keys"}); ` +
        `its stored justification (${v.j.precommits.length} precommits, round ${v.j.round}) verifies under set ${set.id}, ` +
        `${threshold(set.keys.length)} of ${set.keys.length} needed${v.uncounted.length ? `; not counted: ${v.uncounted.join("; ")}` : ""}`,
    );
    add("importHeader", c.header, c.hash, v, scale, next);
  }

  // With no set change due, the head waits until it is --head-every blocks past the client's latest.
  if (steps.length === 0 && behind < o.headEvery) {
    return upToDate(
      `no set change is due, and the head #${fmt(head.number)} is ${fmt(behind)} block${behind === 1 ? "" : "s"} past #${fmt(client.latestNumber)}, ` +
        `fewer than --head-every ${fmt(o.headEvery)}`,
    );
  }
  if (headProof && head.number === before.number) notes.push(`the head #${fmt(head.number)} is the last set change`);
  else if (headProof) {
    checkDigest(head.header, head.hash);
    const v = verified(headProof.justification, head.hash, head.number, set, "the finality proof's justification");
    if (!v) notes.push(`the head is left for a later run: its finality proof carries votes_ancestries, which the client does not decode`);
    else {
      check(
        true,
        `head #${fmt(head.number)} ${shortHex(head.hash)}: its finality proof (${v.j.precommits.length} precommits, round ${v.j.round}, no unknown headers) ` +
          `verifies under set ${set.id}, ${threshold(set.keys.length)} of ${set.keys.length} needed${v.uncounted.length ? `; not counted: ${v.uncounted.join("; ")}` : ""}`,
      );
      add("importFinalityProof", head.header, head.hash, v, headProof.scale, null);
    }
  }
  return { steps, notes };
}

// ---------------------------------------------------------------------------------------
// Dry run

interface SimCall {
  status: string;
  gasUsed: string;
  returnData: string;
  logs?: Log[];
  error?: { message?: string; data?: string };
}

interface SimBlock {
  baseFeePerGas: string;
  calls: SimCall[];
}

interface Context {
  block: { number: string; hash: string };
  fees: Fees;
  balance: bigint;
  sender: Hex;
  client: Hex;
  /** What the sender must keep (--keep), with every transaction at its max fee. */
  keep: bigint;
}

interface Simulated {
  results: Map<number, SimCall>;
  /** The client's views after each request, checked against the plan. */
  views: [boolean, string][];
  requests: Step[][];
  balance: bigint;
  baseFee: bigint;
  /** The most gas one request needed: what it used before each call, plus that call's limit. */
  peak: number;
}

/** What a request reads at its end: the sender's balance (the probe), then the client's views. */
function readsOf(end: Step, sender: Hex, client: Hex): { to: string; gas: number; data: Hex }[] {
  return [
    { to: PROBE, gas: PROBE_GAS, data: bytesToHex(word(BigInt(sender))) },
    { to: client, gas: VIEW_GAS, data: callData("currentSetId()") },
    { to: client, gas: VIEW_GAS, data: callData("latestFinalized()") },
    { to: client, gas: VIEW_GAS, data: callData("authorities(uint64)", word(end.setAfter)) },
  ];
}
const READS_GAS = PROBE_GAS + 3 * VIEW_GAS;

/**
 * Consecutive steps per request. A node sets each call's whole gas limit aside from what the
 * request may still use, so a step joins the request while what the steps before it may use
 * (`bound`), its own limit, and the reads and storage read-back at the end fit in REQUEST_GAS.
 */
function requestsOf(steps: Step[], limitOf: (s: Step) => number, boundOf: (s: Step) => number): Step[][] {
  const out: Step[][] = [];
  let used = 0;
  for (const s of steps) {
    const last = out.at(-1);
    const slots = new Set(last ? [...last, s].flatMap((x) => x.writes) : []).size;
    if (last && used + limitOf(s) + READS_GAS + dumpGas(slots) <= REQUEST_GAS) {
      last.push(s);
      used += boundOf(s);
    } else {
      out.push([s]);
      used = boundOf(s);
    }
  }
  return out;
}

/**
 * Runs `steps` on the node, each with gas limit `limitOf(step)`, on top of ctx.block. The first
 * request runs on the chain's own state; a later one carries, as state overrides, the slots of
 * the client that the earlier ones wrote (read back by the dumper in a second simulated block,
 * where the client's code is replaced by it) and the sender's nonce and remaining balance as
 * the probe read it: no balance is added. Stops after a request in which a step failed.
 */
async function simulate(steps: Step[], limitOf: (s: Step) => number, boundOf: (s: Step) => number, ctx: Context): Promise<Simulated> {
  const sim: Simulated = { results: new Map(), views: [], requests: requestsOf(steps, limitOf, boundOf), balance: ctx.balance, baseFee: 0n, peak: 0 };
  const carried: Record<string, Hex> = {};
  let senderState: { nonce: string; balance: string } | undefined;
  const fee = { maxFeePerGas: qty(ctx.fees.maxFee), maxPriorityFeePerGas: qty(ctx.fees.tip) };
  for (const [r, request] of sim.requests.entries()) {
    const end = request.at(-1)!;
    const reads = readsOf(end, ctx.sender, ctx.client);
    const calls = [
      ...request.map((s) => ({ from: ctx.sender, to: ctx.client, nonce: qty(s.nonce), gas: qty(limitOf(s)), ...fee, data: s.data })),
      ...reads.map((x) => ({ from: PROBE_SENDER, to: x.to, gas: qty(x.gas), ...fee, data: x.data })),
    ];
    const stateOverrides: Record<string, unknown> = { [PROBE]: { code: PROBE_CODE }, [PROBE_SENDER]: { balance: qty(10n ** 18n) } };
    if (Object.keys(carried).length > 0) stateOverrides[ctx.client] = { stateDiff: { ...carried } };
    if (senderState) stateOverrides[ctx.sender] = senderState;
    const blockStateCalls: unknown[] = [{ stateOverrides, calls }];
    const later = r < sim.requests.length - 1;
    const slots = [...new Set(request.flatMap((s) => s.writes))];
    if (later) {
      const dump = { from: PROBE_SENDER, to: ctx.client, gas: qty(dumpGas(slots.length)), ...fee, data: bytesToHex(concat(...slots.map((s) => word(s)))) };
      blockStateCalls.push({ stateOverrides: { [ctx.client]: { code: DUMPER_CODE } }, calls: [dump] });
    }
    const blocks = await rpc<SimBlock[]>("eth_simulateV1", [{ blockStateCalls, validation: true }, ctx.block.number]).catch((error: unknown) => {
      if (offline(error)) throw new Unreachable(`Sepolia RPC unreachable (eth_simulateV1: ${errorText(error)})`);
      throw new Error(`request [${request.map((s) => s.index).join(",")}]: ${errorText(error)}`);
    });

    const done = [...blocks[0].calls, ...(blocks[1]?.calls ?? [])];
    const limits = [...request.map(limitOf), ...reads.map((x) => x.gas), ...(later ? [dumpGas(slots.length)] : [])];
    let used = 0;
    done.forEach((c, i) => {
      sim.peak = Math.max(sim.peak, used + limits[i]);
      used += gasOf(c);
    });
    request.forEach((s, i) => sim.results.set(s.index, blocks[0].calls[i]));
    const [probe, setIdCall, latestCall, keysCall] = blocks[0].calls.slice(request.length);
    if (probe.status !== "0x1") throw new Error(`the probe call failed: ${probe.error?.message}`);
    sim.balance = uintAt(hexToBytes(probe.returnData), 1);
    sim.baseFee = BigInt(blocks[0].baseFeePerGas);
    senderState = { nonce: qty(end.nonce + 1), balance: qty(sim.balance) };
    if (request.some((s) => sim.results.get(s.index)!.status !== "0x1")) break;

    // The client's views at the end of the request: the state the next request starts from.
    const views = [setIdCall, latestCall, keysCall];
    const latest = latestCall.status === "0x1" ? hexToBytes(latestCall.returnData) : new Uint8Array(64);
    const keys = keysCall.status === "0x1" ? bytes32Array(hexToBytes(keysCall.returnData)) : [];
    const same =
      views.every((v) => v.status === "0x1") &&
      BigInt(setIdCall.returnData) === end.setAfter &&
      bytesToHex(wordAt(latest, 0)) === end.hash &&
      uintAt(latest, 1) === BigInt(end.number) &&
      keys.length === end.keysAfter.length &&
      keys.every((k, i) => equalBytes(k, end.keysAfter[i]));
    sim.views.push([
      same,
      `after [${request.map((s) => s.index).join(",")}]: currentSetId ${end.setAfter}, latestFinalized #${fmt(end.number)} ${shortHex(end.hash)}, ` +
        `authorities(${end.setAfter}) the ${end.keysAfter.length} keys of the plan`,
    ]);

    if (later) {
      const d = blocks[1].calls[0];
      if (d.status !== "0x1") throw new Error(`reading the client's storage back failed: ${d.error?.message}`);
      const values = hexToBytes(d.returnData);
      slots.forEach((slot, i) => (carried[bytesToHex(word(slot))] = bytesToHex(wordAt(values, i))));
    }
  }
  return sim;
}

/** Why a simulated call failed, with the client's error named when it is one. */
function revertText(r: SimCall): string {
  const data = (r.error?.data ?? r.returnData ?? "0x").toLowerCase();
  const signature = data.length >= 10 ? ERRORS.get(data.slice(0, 10) as Hex) : undefined;
  if (!signature) return r.error?.message ?? `status ${r.status}`;
  const types = signature.slice(signature.indexOf("(") + 1, -1).split(",").filter(Boolean);
  const args = hexToBytes(`0x${data.slice(10)}`);
  const values = types.map((t, i) => (t.startsWith("uint") ? String(uintAt(args, i)) : shortHex(wordAt(args, i))));
  return `reverted with ${signature.slice(0, signature.indexOf("("))}(${values.join(", ")})`;
}

interface Expected {
  number: number;
  hash: Hex;
  setBefore: bigint;
  setAfter: bigint;
  signatures: number;
  /** For a set change: the key list it installs. */
  keysAfter?: Uint8Array[];
}

/** The events of one import: HeaderImported, and AuthoritySetChanged for a set change; never Halted. */
function eventChecks(e: Expected, logs: Log[] | undefined, client: Hex): [boolean, string][] {
  const imported = findLog(logs, client, T.imported, e.hash);
  const changed = findLog(logs, client, T.changed);
  const halted = findLog(logs, client, T.halted);
  const out: [boolean, string][] = [
    [
      !!imported && BigInt(imported.topics[2]) === BigInt(e.number) && dataWord(imported, 1) === e.setBefore && dataWord(imported, 2) === BigInt(e.signatures),
      `HeaderImported #${fmt(e.number)} under set ${e.setBefore}, ${e.signatures} signatures`,
    ],
  ];
  if (e.setAfter === e.setBefore) {
    out.push([!changed && !halted, "no set change, not halted"]);
    return out;
  }
  let ok = !!changed && !halted && BigInt(changed.topics[1]) === e.setBefore && BigInt(changed.topics[2]) === e.setAfter && dataWord(changed, 2) === BigInt(e.number);
  if (changed && e.keysAfter) ok &&= dataWord(changed, 0) === BigInt(listHash(e.keysAfter)) && dataWord(changed, 1) === BigInt(e.keysAfter.length);
  out.push([ok, `AuthoritySetChanged ${e.setBefore} -> ${e.setAfter}${e.keysAfter ? `, ${e.keysAfter.length} keys` : ""}, not halted`]);
  return out;
}

/** The checks of one simulated step, as [ok, what] pairs; the first is the step itself. */
function judge(s: Step, r: SimCall | undefined, limit: number, client: Hex): [boolean, string][] {
  if (!r) return [[false, `${tag(s)} ${s.label}: not run, a step before it failed`]];
  if (r.status !== "0x1") return [[false, `${tag(s)} ${s.label}: ${revertText(r)}`]];
  const lines: [boolean, string][] = [[true, `${tag(s)} ${s.label}: ${share(gasOf(r))}; gas limit ${fmt(limit)}`]];
  lines.push([r.returnData.toLowerCase() === s.hash, `     returns the block hash ${shortHex(s.hash)}`]);
  const keysAfter = s.setAfter === s.setBefore ? undefined : s.keysAfter;
  for (const [ok, what] of eventChecks({ ...s, keysAfter }, r.logs, client)) lines.push([ok, `     ${what}`]);
  return lines;
}

const groups = (requests: Step[][]) => requests.map((r) => `[${r.map((s) => s.index).join(",")}]`).join(" ");

interface DryRun {
  /** Per step: the gas limit it is sent with and its simulated gas. */
  limits: Map<number, number>;
  gas: Map<number, number>;
}

/** Runs the plan on the node; null when a check fails. */
async function dryRun(steps: Step[], ctx: Context, title: string): Promise<DryRun | null> {
  const { fees } = ctx;
  log(
    `Fees: next base fee ${fmt(fees.base)} wei, priority fee ${fmt(fees.tip)} wei, max fee ${fmt(fees.maxFee)} wei` +
      ` (node gas price ${fmt(fees.gasPrice)} wei)`,
  );
  if (!check(fees.maxFee >= fees.base && fees.maxFee >= fees.tip, "the max fee covers the next base fee and the priority fee")) return null;

  // 1. Measure, with the cap as gas limit.
  const first = await simulate(steps, () => CAP, () => CAP, ctx);
  const measured = steps.flatMap((s) => judge(s, first.results.get(s.index), CAP, ctx.client));
  if ([...measured, ...first.views].some(([ok]) => !ok)) {
    log(`\nWith gas limit 16,777,216 (requests ${groups(first.requests)}):`);
    for (const [ok, what] of [...measured, ...first.views]) check(ok, what);
    return null;
  }
  const gas = new Map(steps.map((s) => [s.index, gasOf(first.results.get(s.index)!)]));
  const limits = new Map(steps.map((s) => [s.index, withHeadroom(gas.get(s.index)!)]));

  // 2. The exact plan: every step with the gas limit it is sent with.
  const run = await simulate(steps, (s) => limits.get(s.index)!, (s) => gas.get(s.index)!, ctx);
  log(`Requests: ${groups(first.requests)} with gas limit 16,777,216, then ${groups(run.requests)} with the gas limits below.`);
  log(`\nOn ${title}:`);
  let total = 0;
  let largest = 0;
  for (const s of steps) {
    const r = run.results.get(s.index);
    for (const [ok, what] of judge(s, r, limits.get(s.index)!, ctx.client)) check(ok, what);
    if (!r) continue;
    if (gasOf(r) !== gas.get(s.index)) check(false, `     ${fmt(gas.get(s.index)!)} gas with the cap as gas limit, ${fmt(gasOf(r))} with ${fmt(limits.get(s.index)!)}`);
    total += gasOf(r);
    largest = Math.max(largest, gasOf(r));
  }
  for (const [ok, what] of run.views) check(ok, what);

  // 3. Gas and cost. Before each transaction the sender must hold its gas limit at the max fee;
  // at most, every earlier one paid the max fee too. --keep stays on top.
  log(`\n     ${steps.length} transaction${steps.length === 1 ? "" : "s"}: ${fmt(total)} gas; the largest ${share(largest)}`);
  const top = Math.max(...limits.values());
  check(top <= CAP, `every gas limit is within the 16,777,216 cap (the largest ${fmt(top)})`);
  const peak = Math.max(first.peak, run.peak);
  check(peak <= REQUEST_GAS, `the largest request needs ${fmt(peak)} of the ${fmt(REQUEST_GAS)} gas one request may use`);
  let need = 0n;
  let paid = 0n;
  for (const s of steps) {
    const upfront = paid + BigInt(limits.get(s.index)!) * fees.maxFee;
    if (upfront > need) need = upfront;
    paid += BigInt(gas.get(s.index)!) * fees.maxFee;
  }
  check(
    need + ctx.keep <= ctx.balance,
    `cost at the current fees ${eth(ctx.balance - run.balance)} (base fee ${fmt(run.baseFee)} wei + priority fee, as simulated);` +
      ` at most ${eth(need)} at the max fee, with --keep ${eth(ctx.keep)} left; the sender has ${eth(ctx.balance)}`,
  );
  return failures === 0 ? { limits, gas } : null;
}

// ---------------------------------------------------------------------------------------
// Send

/** One relayed transaction, in the sender's record while open and in its history once settled. */
interface RelayEntry {
  chain: ChainName;
  client: Hex;
  method: Step["method"];
  block: { number: number; hash: Hex };
  setBefore: number;
  setAfter: number;
  signatures: number;
  nonce: number;
  gasLimit: number;
  /** As signed, in wei: what a transaction replacing this one at its nonce has to beat. */
  maxFee: string;
  priorityFee: string;
  simulatedGas: number;
  dataHash: Hex;
  txHash: Hex;
  /** The transaction at this nonce, signed before with lower fees, that this one replaces. */
  replaces?: Hex;
  signedAt: string;
  /** Filled in when the transaction is mined. */
  sepoliaBlock: number | null;
  gasUsed: number | null;
  effectiveGasPrice: string | null;
  status: number | null;
  ok: boolean | null;
  /** Not mined and not pending while its nonce is free: the next run signs that nonce again. */
  dropped?: true;
  /** Mined without importing: the client already held this header or a later one (another relayer came first). */
  superseded?: true;
  /** Never mined: another transaction of the record at its nonce was. */
  replaced?: true;
  /** When it moved from the record to the history. */
  settledAt?: string;
}

interface RelayRecord {
  network: "sepolia";
  chainId: number;
  sender: Hex;
  /** The transactions not settled yet, in the order they were signed. */
  open: RelayEntry[];
}

/** The sender's record (deployments/relay-sepolia-<sender>.json) and the history its settled transactions move to (.jsonl). */
interface Ledger {
  path: string;
  history: string;
  record: RelayRecord;
}

function openLedger(s: Sender): Ledger {
  const ledger: Ledger = { path: s.record, history: s.history, record: { network: "sepolia", chainId: Number(SEPOLIA_CHAIN_ID), sender: s.address, open: [] } };
  if (!existsSync(s.record)) return ledger;
  let record: RelayRecord;
  try {
    record = JSON.parse(readFileSync(s.record, "utf8")) as RelayRecord;
  } catch (error) {
    throw new Fatal(`${s.record}: ${errorText(error)}`);
  }
  if (record.chainId !== Number(SEPOLIA_CHAIN_ID) || String(record.sender).toLowerCase() !== s.address || !Array.isArray(record.open)) {
    throw new Fatal(`${s.record} is for chain ${record.chainId} and sender ${record.sender}, not this relayer's`);
  }
  return { ...ledger, record };
}

function saveLedger(l: Ledger): void {
  try {
    writeJsonAtomic(l.path, l.record);
  } catch (error) {
    throw new Fatal(`${l.path}: ${errorText(error)}`);
  }
}

/** Adds a signed transaction to the record and writes it; a byte-identical re-sign updates the entry of its hash instead. */
function remember(l: Ledger, entry: RelayEntry): RelayEntry {
  const same = l.record.open.find((e) => e.txHash === entry.txHash);
  if (same) {
    delete same.dropped;
    same.signedAt = entry.signedAt;
  } else l.record.open.push(entry);
  saveLedger(l);
  return same ?? entry;
}

/** Moves a settled transaction from the record to the history: appended there first, so a crash in between repeats a line instead of losing one. */
function archive(l: Ledger, entry: RelayEntry): void {
  entry.settledAt = new Date().toISOString();
  try {
    appendFileSync(l.history, JSON.stringify(entry) + "\n");
  } catch (error) {
    throw new Fatal(`${l.history}: ${errorText(error)}`);
  }
  l.record.open = l.record.open.filter((e) => e !== entry);
  saveLedger(l);
}

/** The lock's content and holder (0 when the content is not a lock's, as when half written), or null when there is none. */
function readLock(lock: string): { content: string; pid: number; age: number } | null {
  try {
    const content = readFileSync(lock, "utf8");
    const age = Date.now() - statSync(lock).mtimeMs;
    let pid = 0;
    try {
      const p = Number((JSON.parse(content) as { pid?: unknown }).pid);
      if (Number.isSafeInteger(p) && p > 0) pid = p;
    } catch {
      // half written
    }
    return { content, pid, age };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

const ageOf = (path: string) => {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};

/**
 * Only one --send run at a time per sender: the lock, in the system's temp directory so that every
 * checkout finds the same one, holds the holder's process id. A lock whose process is gone (or this
 * process, whose runs never overlap: an earlier run could not remove it) is taken over by the one
 * process that creates <lock>.takeover: if the lock still holds what it found stale, it renames it
 * aside (renameSync) and removes it, and then every process tries again to create the lock, which
 * only one can. A lock in use is never moved; a takeover file older than 30 s is taken for one whose
 * process died. Returns its release, which never throws, or null while another live relayer holds it.
 */
function takeLock(lock: string): (() => void) | null {
  const takeover = `${lock}.takeover`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const content = JSON.stringify({ pid: process.pid, since: new Date().toISOString() });
    try {
      const fd = openSync(lock, "wx");
      try {
        writeSync(fd, content);
      } finally {
        closeSync(fd);
      }
      return () => {
        try {
          if (readLock(lock)?.content === content) rmSync(lock, { force: true });
        } catch (error) {
          log(`     (${lock} could not be removed: ${errorText(error)}; the next run of this process takes it over)`);
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const held = readLock(lock);
    if (!held) continue; // released meanwhile
    if (held.pid > 0 && held.pid !== process.pid && alive(held.pid)) {
      log(`     another relayer (process ${held.pid}) is sending; ${lock} is its lock`);
      return null;
    }
    if (held.pid === 0 && held.age < 10_000) {
      log(`     another relayer is writing ${lock}`);
      return null;
    }
    let fd: number;
    try {
      fd = openSync(takeover, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Another process is taking it over; a takeover file this old is from one that died meanwhile.
      if (ageOf(takeover) > 30_000) rmSync(takeover, { force: true });
      pause(200);
      continue;
    }
    closeSync(fd);
    try {
      if (readLock(lock)?.content === held.content) {
        const aside = `${lock}.${process.pid}.stale`;
        renameSync(lock, aside);
        rmSync(aside, { force: true });
      }
    } finally {
      rmSync(takeover, { force: true });
    }
  }
  log(`     ${lock} could not be taken`);
  return null;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** What a mined transaction did: imported its header as checked, imported nothing as another relayer came first, or failed its checks. */
type Outcome = "ok" | "superseded" | "failed";

/**
 * Checks a mined transaction's receipt and events and moves it, with the other transactions at its
 * nonce (which can no longer be mined), from the record to the history. It is superseded when it
 * imported nothing (a revert such as NotNewer, or the re-verification of a header the client held)
 * because, at the receipt's block, the client held its header (isImported) or was at its block or
 * past it (latestFinalized).
 */
async function settle(l: Ledger, entry: RelayEntry, receipt: Receipt, keysAfter?: Uint8Array[]): Promise<Outcome> {
  const status = Number(BigInt(receipt.status));
  const gasUsed = gasOf(receipt);
  const block = Number(BigInt(receipt.blockNumber));
  const what =
    `${entry.method} #${fmt(entry.block.number)}: status ${status}, block ${fmt(block)}, ${share(gasUsed)}` +
    ` (simulated ${fmt(entry.simulatedGas)}), tx ${receipt.transactionHash}`;
  let outcome: Outcome = "ok";
  if (status === 1 && findLog(receipt.logs, entry.client, T.imported, entry.block.hash)) {
    const expected = { ...entry.block, setBefore: BigInt(entry.setBefore), setAfter: BigInt(entry.setAfter), signatures: entry.signatures, keysAfter };
    let ok = check(true, what);
    for (const [k, line] of eventChecks(expected, receipt.logs, entry.client)) ok = check(k, `     ${line}`) && ok;
    if (!ok) outcome = "failed";
  } else {
    const now = await readLatest(entry.client, receipt.blockNumber, entry.block.hash);
    if (now.imported || now.number >= entry.block.number) {
      outcome = "superseded";
      log(
        `     ${what}: superseded, the client ${now.imported ? "held the header" : "was past it"} already, at #${fmt(now.number)} ${shortHex(now.hash)}` +
          ` (another relayer imported it or a later header first)`,
      );
    } else {
      check(false, `${what}${status === 1 ? ", without HeaderImported" : ""}`);
      outcome = "failed";
    }
  }
  delete entry.dropped;
  Object.assign(entry, {
    sepoliaBlock: block,
    gasUsed,
    effectiveGasPrice: BigInt(receipt.effectiveGasPrice ?? 0).toString(),
    status,
    ok: outcome === "ok",
    ...(outcome === "superseded" ? { superseded: true } : {}),
  });
  for (const other of l.record.open.filter((e) => e !== entry && e.nonce === entry.nonce)) {
    delete other.dropped;
    other.replaced = true;
    archive(l, other);
  }
  archive(l, entry);
  return outcome;
}

/** The first receipt of any of `hashes`, looked for every 4 s for `ms`; null when none is mined by then. */
async function firstReceipt(hashes: Hex[], ms: number): Promise<Receipt | null> {
  const until = Date.now() + ms;
  for (;;) {
    for (const hash of hashes) {
      const receipt = await reached("receipt", receiptOf(hash, false));
      if (receipt) return receipt;
    }
    if (Date.now() >= until) return null;
    await sleep(4_000);
  }
}

/** The open entry of a receipt's transaction. */
const entryOf = (l: Ledger, receipt: Receipt) => l.record.open.find((e) => e.txHash === receipt.transactionHash.toLowerCase())!;

/** What reconcile leaves a run: OK or PENDING, and with OK the record's transactions at the sender's next nonce. */
interface Reconciled {
  code: number;
  /** Pending ones (old enough to be replaced, with higher fees) or dropped ones (signed again as they come). */
  earlier: RelayEntry[];
}

/**
 * Settles what the record left open, before anything is planned. A transaction mined since (one
 * taken for dropped or replaced too) is checked and moves to the history; a nonce used on chain by
 * none of the record's transactions, after a minute's wait for a receipt, is Fatal. What is left
 * is at the sender's next nonce: still pending (PENDING, until it has waited --replace-after), or
 * dropped. Superseded transactions are noted, and planning goes on from the client's state.
 */
async function reconcile(l: Ledger, sender: Hex, o: Options): Promise<Reconciled> {
  const open = () => l.record.open;
  const settled = async (entry: RelayEntry, receipt: Receipt) => {
    if ((await settle(l, entry, receipt)) === "failed") throw new Fatal(`relayed transaction ${entry.txHash} failed its checks`);
  };
  for (const entry of [...open()]) {
    if (!open().includes(entry)) continue; // settled with another at its nonce
    const receipt = await reached("receipt", receiptOf(entry.txHash, false));
    if (receipt) await settled(entry, receipt);
  }
  if (open().length === 0) return { code: OK, earlier: [] };
  const n = await sepolia("nonces", () => nonces(sender));
  for (const nonce of new Set(open().filter((e) => e.nonce < n.latest).map((e) => e.nonce))) {
    const atNonce = open().filter((e) => e.nonce === nonce);
    // An RPC behind a load balancer can count a mined transaction before it serves its receipt.
    const receipt = await firstReceipt(atNonce.map((e) => e.txHash), NONCE_WAIT);
    if (!receipt) throw new Fatal(`nonce ${nonce} is used on chain, but by none of ${atNonce.map((e) => e.txHash).join(", ")}; look at the sender's transactions`);
    await settled(entryOf(l, receipt), receipt);
  }
  const ahead = open().find((e) => e.nonce > n.latest);
  if (ahead) {
    log(`     ${ahead.txHash} at nonce ${ahead.nonce} waits for nonce ${n.latest} to be mined: nothing is sent until then`);
    return { code: PENDING, earlier: [] };
  }
  const earlier = open();
  if (earlier.length === 0) return { code: OK, earlier };
  const last = earlier.at(-1)!;
  const what = `${last.txHash} (${last.method} #${fmt(last.block.number)}, nonce ${last.nonce})`;
  if (n.pending > n.latest) {
    // Only a pending transaction of the record (one the node holds) is replaced; another one is waited for.
    const held: RelayEntry[] = [];
    for (const e of earlier) if (await sepolia("transaction", () => rpc<unknown>("eth_getTransactionByHash", [e.txHash]))) held.push(e);
    if (held.length === 0) {
      log(`     the sender has a pending transaction at nonce ${n.latest} that is none of the record's: nothing is sent until it is mined`);
      return { code: PENDING, earlier: [] };
    }
    for (const e of held) delete e.dropped;
    saveLedger(l);
    const waited = Date.now() - Date.parse(last.signedAt);
    if (waited < o.replaceAfter) {
      log(`     ${what} is still pending: nothing more is sent until it is mined, or for ${o.replaceAfter / 60_000} minutes after it was signed`);
      return { code: PENDING, earlier: [] };
    }
    log(`     ${what} is still pending after ${Math.floor(waited / 60_000)} minutes: its nonce is signed again, with higher fees`);
    return { code: OK, earlier };
  }
  for (const e of earlier.filter((x) => !x.dropped)) {
    log(`     ${e.txHash} (${e.method} #${fmt(e.block.number)}) was dropped; the plan is made again from the client's state, at its nonce ${e.nonce}`);
    e.dropped = true;
  }
  saveLedger(l);
  return { code: OK, earlier };
}

/** The highest max fee and priority fee among `entries`, as signed. */
const highest = (entries: RelayEntry[]) => ({ maxFee: max(...entries.map((e) => BigInt(e.maxFee))), tip: max(...entries.map((e) => BigInt(e.priorityFee))) });

/**
 * The fees of a transaction that replaces a pending one at its nonce: max fee and priority fee each
 * at least 1/8 above the old ones (which nodes require of a replacement) and at least the current
 * ones; null when the max fee would pass `cap`.
 */
function raised(old: { maxFee: bigint; tip: bigint }, now: Fees, cap: bigint): Fees | null {
  const up = (x: bigint) => x + (x + 7n) / 8n;
  const tip = max(up(old.tip), now.tip);
  const maxFee = max(up(old.maxFee), now.maxFee, tip);
  return maxFee <= cap ? { ...now, tip, maxFee } : null;
}

/**
 * The most a replacement offers per gas: the max fee a run would use at a base fee of --max-base-fee
 * (ten times it plus the priority fee, at least the run's own at a base fee not above it), or
 * --max-fee when it is given, which no transaction passes.
 */
const feeCap = (o: Options, now: Fees) => o.maxFee ?? max(10n * o.maxBaseFee + now.tip, now.maxFee);

/**
 * Waits, up to a minute for a lagging RPC, until `nonce` is the sender's next nonce and nothing is
 * pending but, when `replacing`, the transaction this one replaces. False, printed, otherwise.
 */
async function nonceIsNext(sender: Hex, nonce: number, replacing: boolean): Promise<boolean> {
  const until = Date.now() + 60_000;
  for (;;) {
    const n = await sepolia("nonces", () => nonces(sender));
    if (n.latest === nonce && (n.pending === nonce || (replacing && n.pending === nonce + 1))) return true;
    if (n.latest > nonce || Date.now() > until) {
      check(false, `nonce ${nonce} is next (on chain: ${n.latest}, pending: ${n.pending})`);
      return false;
    }
    await sleep(3_000);
  }
}

/**
 * The fees to sign a step again with after it waited --replace-after: null, printed, while the base
 * fee is above --max-base-fee, the raised fees would pass feeCap, or the rest of the plan at the
 * new max fee would leave the sender less than --keep.
 */
async function replacement(fees: Fees, rest: Step[], dry: DryRun, ctx: Context, o: Options): Promise<Fees | null> {
  const block = await sepolia("latest block", () => rpc<{ number: string; hash: string }>("eth_getBlockByNumber", ["latest", false]));
  const now = await sepolia("fees", () => feesAt(block, { priorityFee: o.priorityFee, maxFee: o.maxFee }));
  if (now.base > o.maxBaseFee) {
    log(`     (the base fee is ${fmt(now.base)} wei, above --max-base-fee ${fmt(o.maxBaseFee)} wei: not signed again yet)`);
    return null;
  }
  const next = raised(fees, now, feeCap(o, now));
  if (!next) {
    log(`     (signing again needs a max fee above ${fmt(feeCap(o, now))} wei: not signed again)`);
    return null;
  }
  const balance = BigInt(await sepolia("balance", () => rpc<string>("eth_getBalance", [ctx.sender, block.number])));
  const need = rest.reduce((sum, s) => sum + BigInt(dry.limits.get(s.index)!) * next.maxFee, 0n);
  if (need + o.keep > balance) {
    log(`     (at max fee ${fmt(next.maxFee)} wei the rest of the plan needs ${eth(need)} and --keep ${eth(o.keep)}; the sender has ${eth(balance)}: not signed again)`);
    return null;
  }
  return next;
}

/**
 * Signs the first of `rest` at its nonce, records it and broadcasts it, then waits for a
 * transaction at that nonce to be mined: this one, one an earlier run left in the record, or the
 * step signed again with higher fees after each --replace-after without a receipt (as replacement
 * allows). Returns PENDING after RECEIPT_TIMEOUT; else the mined transaction, its outcome, and the
 * fees the next step is signed with.
 */
async function sendStep(rest: Step[], dry: DryRun, ctx: Context, o: Options, l: Ledger): Promise<number | { entry: RelayEntry; outcome: Outcome; fees: Fees }> {
  const s = rest[0];
  const limit = dry.limits.get(s.index)!;
  let fees = ctx.fees;
  const sign = (replaces?: Hex): RelayEntry => {
    let entry: RelayEntry = {
      chain: o.chain,
      client: ctx.client,
      method: s.method,
      block: { number: s.number, hash: s.hash },
      setBefore: toSafeNumber(s.setBefore, "set id"),
      setAfter: toSafeNumber(s.setAfter, "set id"),
      signatures: s.signatures,
      nonce: s.nonce,
      gasLimit: limit,
      maxFee: fees.maxFee.toString(),
      priorityFee: fees.tip.toString(),
      simulatedGas: dry.gas.get(s.index)!,
      dataHash: bytesToHex(keccak256(hexToBytes(s.data))),
      txHash: "0x",
      ...(replaces ? { replaces } : {}),
      signedAt: "",
      sepoliaBlock: null,
      gasUsed: null,
      effectiveGasPrice: null,
      status: null,
      ok: null,
    };
    const args = mktxArgs(s.label, { to: ctx.client, data: s.data, nonce: s.nonce, gasLimit: limit, fees, account: o.account!, passwordFile: o.passwordFile! });
    const hash = signAndPublish(args, `${tag(s)} ${s.label}`, (signed) => {
      log(
        `     ${tag(s)} ${s.label}: signed ${signed}, gas limit ${fmt(limit)}` +
          (replaces ? `, max fee ${fmt(fees.maxFee)} wei, priority fee ${fmt(fees.tip)} wei, in place of ${replaces}` : ""),
      );
      Object.assign(entry, { txHash: signed, signedAt: new Date().toISOString() });
      entry = remember(l, entry);
    });
    if (!hash) throw new Fatal("cast mktx could not sign");
    return entry;
  };
  let last = sign(l.record.open.filter((e) => e.nonce === s.nonce && e.txHash !== "0x").at(-1)?.txHash);
  const started = Date.now();
  let retryAt = started + o.replaceAfter;
  for (;;) {
    const hashes = l.record.open.filter((e) => e.nonce === s.nonce).map((e) => e.txHash);
    const receipt = await firstReceipt(hashes, Math.max(0, Math.min(retryAt, started + RECEIPT_TIMEOUT) - Date.now()));
    if (receipt) {
      const entry = entryOf(l, receipt);
      const keysAfter = entry.block.hash === s.hash && s.setAfter !== s.setBefore ? s.keysAfter : undefined;
      return { entry, outcome: await settle(l, entry, receipt, keysAfter), fees };
    }
    if (Date.now() >= started + RECEIPT_TIMEOUT) {
      log(`     ${last.txHash} is not mined after ${RECEIPT_TIMEOUT / 60_000} minutes; the next run waits for it, or signs its nonce again`);
      return PENDING;
    }
    retryAt = Date.now() + o.replaceAfter;
    const next = await replacement(fees, rest, dry, ctx, o);
    if (next) {
      fees = next;
      last = sign(last.txHash);
    }
  }
}

/**
 * Sends the plan one transaction at a time. Before each, the client must still be where the plan
 * expects it (another relayer may have moved it) and neither paused nor halted, as read at the
 * latest block once the RPC has the previous receipt's; and the step's nonce must be the sender's
 * next, with nothing pending but what it replaces.
 */
async function sendPlan(steps: Step[], dry: DryRun, ctx: Context, o: Options, l: Ledger): Promise<number> {
  let after = Number(BigInt(ctx.block.number));
  let fees = ctx.fees;
  for (const [i, s] of steps.entries()) {
    const now = await clientNow(ctx.client, after);
    if (now.halted || now.paused) {
      check(false, `the client is ${now.halted ? "halted" : "paused"} at Sepolia block ${fmt(now.block)}: nothing more is sent`);
      return FAILED;
    }
    if (now.hash !== s.before.hash || now.setId !== s.setBefore) {
      check(false, `the client is at #${fmt(now.number)} ${shortHex(now.hash)}, set ${now.setId}, not where step ${s.index} expects it: the next run plans again`);
      return FAILED;
    }
    const replacing = l.record.open.some((e) => e.nonce === s.nonce && !e.dropped);
    if (!(await nonceIsNext(ctx.sender, s.nonce, replacing))) return FAILED;
    const sent = await sendStep(steps.slice(i), dry, { ...ctx, fees }, o, l);
    if (typeof sent === "number") return sent;
    const { entry, outcome } = sent;
    fees = sent.fees;
    if (outcome === "failed") throw new Fatal(`relayed transaction ${entry.txHash} failed its checks`);
    if (outcome === "superseded") {
      check(false, `${entry.txHash} was superseded: the next run plans again`);
      return FAILED;
    }
    if (entry.block.hash !== s.hash) {
      check(false, `${entry.txHash}, for ${entry.method} #${fmt(entry.block.number)}, was mined at nonce ${s.nonce} instead of step ${s.index}: the next run plans again`);
      return FAILED;
    }
    after = entry.sepoliaBlock!;
  }
  return OK;
}

// ---------------------------------------------------------------------------------------
// A run

async function relay(o: Options, sender: Sender): Promise<number> {
  const chain = CHAINS[o.chain];
  const { client: address, codeHash, clients } = deployment(o.chain);
  const title = `${chain.client} ${address}`;
  log(`${new Date().toISOString()}: relaying ${chain.title} to ${title} on Sepolia${o.send ? "" : " (dry run)"}`);

  let chainId: string;
  try {
    chainId = await rpc<string>("eth_chainId", []);
  } catch (error) {
    throw new Unreachable(`Sepolia RPC unreachable (${errorText(error)})`);
  }
  if (!check(BigInt(chainId) === SEPOLIA_CHAIN_ID, `chain id ${BigInt(chainId)} is Sepolia`)) throw new Blocked("the Sepolia RPC serves another chain");
  const ledger = o.send ? openLedger(sender) : null;
  // The record's transactions at the sender's next nonce, which this run signs again: still
  // pending after --replace-after (stuck), or dropped.
  let earlier: RelayEntry[] = [];
  if (ledger) {
    const r = await reconcile(ledger, sender.address, o);
    if (r.code !== OK) return r.code;
    earlier = r.earlier;
  }
  const stuck = earlier.some((e) => !e.dropped);

  // Everything is read at one block, the one the plan is simulated on; a load-balanced RPC can
  // briefly fail on a block it has not seen yet.
  const block = await sepolia("latest block", () => rpc<{ number: string; hash: string }>("eth_getBlockByNumber", ["latest", false]));
  const at = <R>(what: string, method: string, params: unknown[]) => sepolia(what, () => rpc<R>(method, [...params, block.number]));
  const current = await sepolia("fees", () => feesAt(block, { priorityFee: o.priorityFee, maxFee: o.maxFee }));
  const balance = BigInt(await at<string>("balance", "eth_getBalance", [sender.address]));
  const nonce = Number(BigInt(await at<string>("nonce", "eth_getTransactionCount", [sender.address])));
  const n = await sepolia("nonces", () => nonces(sender.address));
  log(`Sepolia block ${fmt(Number(BigInt(block.number)))} (${block.hash}), simulated on top of it via ${new URL(RPC).host}`);
  log(`Sender ${sender.name}: nonce ${nonce}, balance ${eth(balance)}`);
  const admins: string[] = [];
  for (const c of clients) {
    const admin = await at<Hex>("admin", "eth_call", [{ to: c.address, data: callData("admin()") }]);
    if (admin.slice(-40).toLowerCase() === sender.address.slice(2)) admins.push(c.name);
  }
  if (admins.length > 0) {
    log(
      `WARN the sender is the admin of ${admins.join(" and ")}, which can pause and reinitialize ${admins.length === 1 ? "it" : "them"}: ` +
        `imports need no rights, so --watch --send is better run with a key of its own`,
    );
  }
  if (current.base > o.maxBaseFee) {
    const what = `the next base fee is ${fmt(current.base)} wei, above --max-base-fee ${fmt(o.maxBaseFee)} wei`;
    if (o.send) {
      log(`     ${what}: nothing is sent in this run`);
      return stuck ? PENDING : OK;
    }
    log(`     (${what}: a --send run would send nothing now)`);
  }
  // A stuck transaction is replaced with higher fees; a dropped one is simply signed again.
  let fees = current;
  if (stuck) {
    const higher = raised(highest(earlier), current, feeCap(o, current));
    if (!higher) {
      log(`     replacing ${earlier.at(-1)!.txHash} needs a max fee above ${fmt(feeCap(o, current))} wei: it is left to be mined`);
      return PENDING;
    }
    fees = higher;
  }
  if (n.pending !== n.latest) {
    const what = `the sender has pending transactions (nonce ${n.latest}, pending ${n.pending})`;
    if (o.send && !(stuck && n.pending === n.latest + 1)) {
      log(`     ${what}: nothing is sent until they are mined`);
      return PENDING;
    }
    log(`     (${what}: the plan starts at the mined nonce${stuck ? ", where it replaces the pending one" : ""})`);
  }
  const code = await at<Hex>("code", "eth_getCode", [address]);
  if (!check(bytesToHex(keccak256(hexToBytes(code))) === codeHash, `${chain.client} has the code deployments/sepolia.json recorded`)) {
    throw new Blocked(`${chain.client} at ${address} does not have the code deployments/sepolia.json recorded`);
  }
  const client = await sepolia("client state", () => readClient(address, block.number));
  log(
    `Client: set ${client.setId} (${client.keys.length} keys, threshold ${threshold(client.keys.length)}), latest #${fmt(client.latestNumber)} ` +
      `${client.latestHash}, ${client.halted ? "HALTED" : "not halted"}, ${client.paused ? "PAUSED" : "not paused"}`,
  );
  if (client.halted) throw new Blocked("the client is halted (an authority change it could not follow): imports revert until the admin reinitializes it");
  if (client.paused) throw new Blocked("the client is paused by its admin: imports revert until it is unpaused");

  let portaldot: Portaldot;
  try {
    portaldot = new Portaldot(await RpcClient.connect(o.rpc));
  } catch (error) {
    throw new Unreachable(`Portaldot node unreachable (${errorText(error)})`);
  }
  let plan: Plan;
  try {
    plan = await makePlan(portaldot, client, o);
  } catch (error) {
    // No answer (a timeout, a closed connection), as opposed to an error the node returned.
    if (error instanceof RpcError && error.code === undefined) throw new Unreachable(`Portaldot node unreachable (${errorText(error)})`);
    throw error;
  } finally {
    await portaldot.rpc.close();
  }
  if (plan.upToDate) {
    check(true, `${chain.client} is up to date: ${plan.upToDate}`);
    return OK;
  }
  for (const note of plan.notes) log(`     note: ${note}`);
  if (plan.steps.length === 0) throw new Stop("nothing can be imported in this run");
  for (const s of plan.steps) s.nonce = nonce + s.index;
  const changes = plan.steps.filter((s) => s.setAfter !== s.setBefore).length;
  log(
    `\nPlan: ${plan.steps.length} transaction${plan.steps.length === 1 ? "" : "s"} from nonce ${nonce}: ${changes} set change${changes === 1 ? "" : "s"} (importHeader)` +
      `${plan.steps.length > changes ? ", then the head (importFinalityProof)" : ""}. eth_simulateV1 with validation on, from the sender at its nonce and with its balance on chain;` +
      ` each request goes on from what the previous one left (no balance is added).`,
  );
  if (earlier.length > 0) {
    log(
      `     nonce ${earlier[0].nonce} is signed again (the record has ${earlier.length} transaction${earlier.length === 1 ? "" : "s"} at it, ` +
        `${stuck ? "pending" : "dropped"}): max fee ${fmt(fees.maxFee)} wei, priority fee ${fmt(fees.tip)} wei`,
    );
  }

  const ctx: Context = { block, fees, balance, sender: sender.address, client: address, keep: o.keep };
  let dry: DryRun | null = null;
  try {
    dry = await dryRun(plan.steps, ctx, title);
  } catch (error) {
    if (error instanceof Unreachable) throw error;
    check(false, errorText(error));
  }
  if (!dry) {
    log("\nThe dry run failed: nothing can be sent.");
    return FAILED;
  }
  if (!o.send) {
    log("\nThe dry run passed. Nothing was signed or sent.");
    return OK;
  }
  log("\nThe dry run passed. Sending:");
  const sent = await sendPlan(plan.steps, dry, ctx, o, ledger!);
  if (sent === OK) log(`\nEvery transaction is mined and checked; the history is ${ledger!.history}.`);
  return sent;
}

/** One run's exit code, and whether it stopped on something only the admin or the operator can clear. */
interface Run {
  code: number;
  blocked: boolean;
}

/** One run; with --send, under the sender's lock. Fatal problems propagate, everything else becomes an exit code. */
async function runOnce(o: Options, sender: Sender): Promise<Run> {
  failures = 0;
  let release: (() => void) | null = null;
  try {
    if (o.send) {
      release = takeLock(sender.lock);
      if (!release) return { code: FAILED, blocked: false };
    }
    return { code: await relay(o, sender), blocked: false };
  } catch (error) {
    if (error instanceof Fatal) throw error;
    if (error instanceof Unreachable) {
      log(errorText(error));
      return { code: UNREACHABLE, blocked: false };
    }
    check(false, errorText(error));
    if (error instanceof Stop) log("\nNothing was planned.");
    return { code: FAILED, blocked: error instanceof Blocked };
  } finally {
    release?.();
  }
}

async function main(): Promise<number> {
  const o = options();
  redactAlso(o.passwordFile, o.rpc === CHAINS[o.chain].rpc ? undefined : o.rpc);
  const { deployer, deployerName } = deployment(o.chain);
  let sender: Sender;
  if (o.send) {
    const unlocked = keystoreAddress(o.account!, o.passwordFile!);
    if (!unlocked) return FAILED;
    sender = senderOf(unlocked.toLowerCase() as Hex, `${unlocked} (keystore ${o.account})`);
  } else sender = o.from ? senderOf(o.from, o.from) : senderOf(deployer, `${deployerName} (the deployer)`);
  let wait = o.watch ?? 0;
  for (;;) {
    const run = await runOnce(o, sender);
    if (o.watch === undefined) return run.code;
    wait = run.blocked ? Math.min(2 * wait, Math.max(o.watch, MAX_BACKOFF_SECONDS)) : o.watch;
    log(
      `\nNext run in ${wait} s, at ${new Date(Date.now() + wait * 1000).toISOString()}` +
        `${run.blocked ? " (the wait doubles while runs stop on something only the admin or the operator can clear)" : ""}.\n`,
    );
    await sleep(wait * 1000);
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    check(false, errorText(error));
    process.exit(FAILED);
  },
);
