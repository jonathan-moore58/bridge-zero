// Relayer v0: brings a GrandpaLightClient on Sepolia up to date with its Portaldot chain.
//
//   npm run relay -- --chain mainnet|v3 [--dry-run] [--from <address>] [--watch <seconds>]
//   npm run relay -- --chain mainnet|v3 --send --account <keystore> --password-file <path> [--watch <seconds>]
//   more options: --rpc <wss url> (the Portaldot node), --state-dir <path>, --scan-limit <blocks>,
//   --head-every <blocks>, --priority-fee <gwei>, --max-fee <gwei>, --max-base-fee <gwei>,
//   --max-base-fee-change <gwei>, --keep <eth>, --replace-after <minutes>
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
// index in the client's key list; a head proof the client cannot count leaves the head for a later
// run, after the set changes before it. A run plans nothing, and says why, when the client is halted
// or paused, when a change ahead would halt it (a ForcedChange, a delayed or multiple change, a list
// the client cannot use, such as more than MAX_AUTHORITIES keys), when an import would revert, or
// when the client is more than --scan-limit blocks behind (by default about a week of the chain's
// blocks, and at least 30,000: 30,000 on mainnet, 100,800 on V3).
//
// The sender is the address the keystore unlocks to with --send, and --from (by default the
// deployer) in a dry run: its nonce and balance are the ones used and recorded. Imports need no
// rights on the client, while its admin (the deployer) can pause and reinitialize it, so --watch
// --send is better run with a key of its own and a small balance, one key per chain (a sender's
// nonce and record serve both chains' runs, and one chain's open transaction holds the other's
// runs back); a run warns when the sender is a client's admin.
//
// --dry-run (the default) has a Sepolia node run the plan with eth_simulateV1 (validation on), on
// top of its latest block, from the sender with its nonce and balance on chain: every transaction
// first with the 16,777,216 cap as gas limit, then with the limit it is sent with (its gas + 10%).
// Every import must emit HeaderImported, a set change also AuthoritySetChanged, and none Halted.
// Each request stays within the gas a node lets one request use; a request starts from the
// client's storage as the one before left it (the slots its imports wrote, read back in that
// simulation), and from the sender's nonce and remaining balance; one the node fails the way a
// load-balanced RPC can (an unknown block, a timeout, an HTTP error) is sent again. With every
// transaction at its max fee, the sender must still keep --keep (default 0.05 ETH); a run whose only
// failure is the sender's balance counts as blocked (see --watch).
// --send runs the same dry run, then sends the plan one transaction at a time the way
// contracts/script/deploy-sepolia.mjs sends its steps (cast mktx with the keystore, the hash
// recorded, cast publish, the receipt and its events checked), each after checking, at the latest
// block, that the client is still where the plan expects it and neither paused nor halted, and that
// the next base fee is within the step's gate: --max-base-fee (default 0.05 gwei) for the head,
// --max-base-fee-change (default 1.5 gwei, and at least --max-base-fee) for a set change. Above it,
// that step and the rest of the plan are left for a later run, and the run ends OK (or 3 while a
// transaction of the record is open); a run checks before it scans too, and does not scan while
// nothing could be sent (Grandpa.CurrentSetId at the node's finalized head tells whether a set
// change is due). With --watch, a run warns (WARN) once set changes have been held back that way
// for more than 3 hours. A transaction not mined after --replace-after minutes (default 5) is
// signed again at its nonce, once the client still reads as the step expects, with its max fee and
// priority fee raised by at least 1/8, never above the max fee a run would use at the step's gate,
// nor above --max-fee when it is given (a --priority-fee above --max-base-fee needs --max-fee); one
// of the record left at the next nonce, pending or dropped, is outbid the same way. All transactions
// for one import share its nonce, so at most one of them is mined. One mined without importing is
// superseded (another relayer imported its header or a later one first, and the next run plans
// again) when the client held the header at its block, or when it reverted and, replayed with
// eth_call on the state its block left, it reverts with NotNewer; out of gas, or any other revert,
// fails its checks.
// The sender's record, history and lock are in the state directory, --state-dir (by default
// .bridge-zero in the home directory), which every checkout shares: relay-sepolia-<sender>.json holds
// the sender's transactions not settled yet (signed, pending, or dropped while their nonce is free),
// each written before it is broadcast; a settled one (mined and checked, superseded, or replaced by
// another at its nonce) moves to relay-sepolia-<sender>.jsonl, a line appended, so the JSON stays
// small and the history is never rewritten. Before planning, a run settles what the JSON left open.
// An earlier version kept them in deployments/ of the checkout: while that record holds open
// transactions nothing runs (exit code 1), and a run says what to move where.
// Only one --send run per sender at a time holds relay-sepolia-<sender>.lock: the holder refreshes it
// every 30 s, a lock whose process is gone or which was not refreshed for 10 minutes is taken over,
// and a run checks before every signing and record write that the lock still holds its own token
// (exit code 1 when it does not). takeLock tells the lock's limits.
// --watch starts the next run <seconds> (10 to 86,400) after each run ends, a failed one too; after
// runs in a row that stop on something only the client's admin or the operator can clear (a halt,
// a pause, a ForcedChange, the scan limit, too small a balance, ...), the wait doubles each time, up
// to an hour.
//
// The Sepolia RPC is SEPOLIA_RPC_URL when set, else the public endpoint; of it and of a --rpc URL
// (which has no #fragment) only the host is printed. Exit code 0 when the client is up to date, the
// dry run passed, the plan was sent and checked, or the base fee is too high to send; 1 when a check
// fails or nothing can be relayed; 2 when an RPC cannot be reached, a read keeps failing, or the
// Portaldot node is behind the client; 3 when a sent transaction is still pending, or one of the
// record is open at the next nonce. With --watch, only a sent transaction that fails its checks, or
// a signing or record problem, ends the loop.

import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, equalBytes, hexToBytes, leToBigInt, shortHex, toSafeNumber, utf8, type Hex } from "./bytes.js";
import { scanSetChanges, type FoundChange, type HeaderSource } from "./changes.js";
import { clientVerifies, threshold, verifyJustification } from "./grandpa.js";
import { blake2_256, storageKey } from "./hash.js";
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
  rpcBody,
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

/**
 * blockSeconds: the chain's block time (60 s on the old mainnet, 6 s on V3). headEvery: the default
 * --head-every, about an hour of its blocks. scanLimit: the default --scan-limit, how far below the
 * head the client's latest header may be: about a week of its blocks, and at least 30,000 (on
 * mainnet, 30,000 blocks are about 3 weeks; a V3 scan of 100,800 headers takes about 20 minutes).
 */
const CHAINS = {
  mainnet: { title: "the old Portaldot mainnet", rpc: "wss://mainnet.portaldot.io", client: "GrandpaLightClient #1", blockSeconds: 60, headEvery: 60, scanLimit: 30_000 },
  v3: { title: "the Portaldot V3 testnet", rpc: "wss://test-node-v3.portaldot.dev", client: "GrandpaLightClient #2", blockSeconds: 6, headEvery: 600, scanLimit: 100_800 },
} as const;
type ChainName = keyof typeof CHAINS;

const DEPLOYMENT = fileURLToPath(new URL("../../deployments/sepolia.json", import.meta.url));
/** Where an earlier version wrote each sender's record and history (now in the state directory). */
const DEPLOYMENTS = fileURLToPath(new URL("../../deployments", import.meta.url));
/** The default --state-dir: each sender's record, history and lock, outside every checkout. */
const STATE_DIR = join(homedir(), ".bridge-zero");

/** Header requests in flight during the scan. */
const SCAN_CONCURRENCY = 32;
const MIN_WATCH_SECONDS = 10;
const MAX_WATCH_SECONDS = 86_400;
/** The longest --watch waits between runs that stop on something only the admin or the operator can clear. */
const MAX_BACKOFF_SECONDS = 3_600;
/**
 * The default --max-base-fee-change, the gate of a set change (the head's, --max-base-fee, is 0.05
 * gwei). In the 30 days to 2026-10-18 the next base fee on Sepolia sat near 1 gwei for three weeks
 * (median 0.98 gwei, 99th percentile 1.30) and was at most 1.5 gwei in 99.7% of blocks, never above
 * it for more than 40 minutes. Replayed on those blocks, --watch on both chains (a key of its own per
 * chain, 1 ETH each) imports every set change within the hour and spends at most 0.024 ETH in a day,
 * 0.43 ETH in the 30 days; at the 0.05 gwei gate alone, set changes waited up to 18 days. Near the
 * gate a set change needs its gas limit at the max fee (ten times the base fee) on hand above
 * --keep: about 0.1 ETH on mainnet, 0.04 ETH on V3.
 */
const MAX_BASE_FEE_CHANGE = "1.5";
/** Grandpa.CurrentSetId, read (without a proof) to tell whether a set change is due before a run scans. */
const SET_ID_KEY = bytesToHex(storageKey("Grandpa", "CurrentSetId"));
/** With --watch, set changes held back by the base fee for this long make a run warn. */
const HELD_BACK_WARN_MS = 3 * 3_600_000;
/** How often the lock's holder refreshes it, and how long a lock whose process runs may go unrefreshed before it counts as stale. */
const LOCK_REFRESH = 30_000;
const LOCK_STALE = 10 * 60_000;
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

/** A Blocked run whose plan stands, but the sender's balance cannot pay it and keep --keep. */
class Underfunded extends Blocked {}

/** A problem a later run cannot get past alone: --watch ends. */
class Fatal extends Error {
  override name = "Fatal";
}

/** A read from Sepolia or the Portaldot node that failed, after its retries, or a node behind the client: exit code 2. */
class Unreachable extends Error {
  override name = "Unreachable";
}

/** The sender's lock no longer holds this run's token (another relayer took it over): the run stops, nothing more signed or written. */
class LockLost extends Error {
  override name = "LockLost";
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

/**
 * An error a load-balanced RPC gives for a while: no answer or an HTTP error page (offline), a
 * block it has not seen yet or a state it does not serve, a timeout, a rate limit, an internal
 * error. Errors about the request itself, such as insufficient funds, are not.
 */
const transient = (error: unknown) =>
  offline(error) ||
  /header not found|block not found|unknown block|beyond (the )?(current )?head|missing trie node|not (yet )?available|timeout|timed out|rate limit|too many requests|unavailable|internal error|-32005\b|-32603\b/i.test(
    errorText(error),
  );

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
  /** Where the sender's record, history and lock are (--state-dir), absolute. */
  stateDir: string;
  scanLimit: number;
  headEvery: number;
  priorityFee?: bigint;
  maxFee?: bigint;
  /** The gates: the most the next base fee may be when the head (maxBaseFee) or a set change (maxBaseFeeChange) is sent. */
  maxBaseFee: bigint;
  maxBaseFeeChange: bigint;
  keep: bigint;
  /** Milliseconds a transaction waits for its receipt before its nonce is signed again with higher fees. */
  replaceAfter: number;
}

function usage(problem: string): never {
  log(`${problem}
usage (from relayer/):
  npm run relay -- --chain mainnet|v3 [--dry-run] [--from <address>] [--watch <seconds>]
  npm run relay -- --chain mainnet|v3 --send --account <keystore> --password-file <path> [--watch <seconds>]
  more options: --rpc <wss url>, --state-dir <path> (default ~/.bridge-zero), --scan-limit <blocks>, --head-every <blocks>,
    --priority-fee <gwei>, --max-fee <gwei>, --max-base-fee <gwei> (default 0.05), --max-base-fee-change <gwei> (default ${MAX_BASE_FEE_CHANGE}),
    --keep <eth> (default 0.05), --replace-after <minutes> (default 5)`);
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
        "state-dir": { type: "string" },
        "scan-limit": { type: "string" },
        "head-every": { type: "string" },
        "priority-fee": { type: "string" },
        "max-fee": { type: "string" },
        "max-base-fee": { type: "string", default: "0.05" },
        "max-base-fee-change": { type: "string" },
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
  // The WebSocket constructor refuses a URL with a fragment, which would otherwise show up as an unreachable node.
  if (rpcUrl.includes("#")) usage("--rpc must not have a #fragment");
  if (values["state-dir"] === "") usage("--state-dir must be a directory");
  let watch: number | undefined;
  if (values.watch !== undefined) {
    watch = whole(values.watch);
    if (!Number.isSafeInteger(watch) || watch < MIN_WATCH_SECONDS || watch > MAX_WATCH_SECONDS) {
      usage(`--watch must be a whole number of seconds, from ${MIN_WATCH_SECONDS} to ${fmt(MAX_WATCH_SECONDS)}`);
    }
  }
  const scanLimit = values["scan-limit"] === undefined ? CHAINS[chain].scanLimit : whole(values["scan-limit"]);
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
  const priorityFee = amount(values["priority-fee"], parseGwei);
  const maxFee = amount(values["max-fee"], parseGwei);
  const maxBaseFee = amount(values["max-base-fee"], parseGwei)!;
  // Unless given, the set changes' gate is at least the head's.
  const given = amount(values["max-base-fee-change"], parseGwei);
  const maxBaseFeeChange = given ?? max(parseGwei(MAX_BASE_FEE_CHANGE), maxBaseFee);
  if (maxBaseFeeChange < maxBaseFee) usage("--max-base-fee-change must be at least --max-base-fee");
  // The most a replacement may offer grows with the priority fee: a large one needs a ceiling of its own.
  if (priorityFee !== undefined && maxFee === undefined && priorityFee > maxBaseFee) {
    usage("--priority-fee is above --max-base-fee: give --max-fee too, the most a transaction may offer per gas");
  }
  return {
    chain,
    send,
    account: values.account,
    passwordFile,
    from: values.from?.toLowerCase() as Hex | undefined,
    watch,
    rpc: rpcUrl,
    stateDir: resolve(values["state-dir"] ?? STATE_DIR),
    scanLimit,
    headEvery,
    priorityFee,
    maxFee,
    maxBaseFee,
    maxBaseFeeChange,
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

/** Who signs and pays: the address (lower case), how a run prints it, and its record, history and lock in the state directory. */
interface Sender {
  address: Hex;
  name: string;
  record: string;
  history: string;
  lock: string;
}

function senderOf(address: Hex, name: string, stateDir: string): Sender {
  const file = join(stateDir, `relay-sepolia-${address}`);
  return { address, name, record: `${file}.json`, history: `${file}.jsonl`, lock: `${file}.lock` };
}

/**
 * An earlier version kept the sender's record and history in deployments/ of the checkout. While
 * that record holds open transactions, nothing runs: printed is what to move where, so that none
 * is lost. A record with none open is left alone.
 */
function legacyRecordMoved(s: Sender): boolean {
  const record = join(DEPLOYMENTS, `relay-sepolia-${s.address}.json`);
  const history = join(DEPLOYMENTS, `relay-sepolia-${s.address}.jsonl`);
  if (!existsSync(record)) return true;
  let open: number | null = null;
  try {
    const old = JSON.parse(readFileSync(record, "utf8")) as { open?: unknown };
    open = Array.isArray(old.open) ? old.open.length : null;
  } catch {
    // unreadable: it may hold open transactions
  }
  if (open === 0) return true;
  check(
    false,
    `${record} is the record of an earlier version of this relayer and ${open === null ? "cannot be read; it may hold" : `holds ${open}`} open ` +
      `transaction${open === 1 ? "" : "s"} of ${s.address}: nothing runs until it is moved to the state directory ${dirname(s.record)}`,
  );
  if (existsSync(s.record)) log(`     ${s.record} exists too: add the entries of "open" in ${record} to its "open" list, then delete ${record}`);
  else log(`     move ${record} to ${s.record}`);
  if (existsSync(history)) {
    log(existsSync(s.history) ? `     and add the lines of ${history} to the end of ${s.history}, then delete ${history}` : `     and move ${history} to ${s.history}`);
  }
  return false;
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

  /**
   * The node's finalized head and Grandpa.CurrentSetId there, as the node states them (no proof):
   * enough to tell, before a scan, whether a set change is due. Null when the node does not say.
   */
  async setIdAtHead(): Promise<{ number: number; setId: bigint } | null> {
    const hash = await this.rpc.request<Hex>("chain_getFinalizedHead");
    const header = await this.header(hash.toLowerCase() as Hex);
    const value = await this.rpc.request<Hex | null>("state_getStorage", [SET_ID_KEY, hash]);
    if (!value) return null;
    const scale = hexToBytes(value);
    return scale.length === 8 ? { number: header.number, setId: leToBigInt(scale) } : null;
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
  /** The head the plan was made to: the finalized head, or the later block its finality proof is for. */
  head?: number;
}

/** A step's gate: the most the next base fee may be when it is sent (--max-base-fee-change for a set change, --max-base-fee for the head). */
const gateOf = (s: Step, o: Options) => (s.setAfter !== s.setBefore ? o.maxBaseFeeChange : o.maxBaseFee);
const gateName = (s: Step) => (s.setAfter !== s.setBefore ? "--max-base-fee-change" : "--max-base-fee");

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
  // The client imports finalized headers only: a node whose finality is below the client's latest lags (an RPC problem).
  if (finalized.number < client.latestNumber) {
    throw new Unreachable(
      `Portaldot node behind: its finalized head #${fmt(finalized.number)} is below the client's latest header #${fmt(client.latestNumber)} (a node still syncing, or one that lost its peers)`,
    );
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
    // A head proof the client cannot count leaves the head for a later run, after the set changes before it.
    let v: Verified | null | undefined;
    try {
      checkDigest(head.header, head.hash);
      v = verified(headProof.justification, head.hash, head.number, set, "the finality proof's justification");
    } catch (error) {
      if (!(error instanceof Stop) || steps.length === 0) throw error;
      notes.push(`the head is left for a later run: ${error.message}`);
    }
    if (v === null) notes.push(`the head is left for a later run: its finality proof carries votes_ancestries, which the client does not decode`);
    else if (v) {
      check(
        true,
        `head #${fmt(head.number)} ${shortHex(head.hash)}: its finality proof (${v.j.precommits.length} precommits, round ${v.j.round}, no unknown headers) ` +
          `verifies under set ${set.id}, ${threshold(set.keys.length)} of ${set.keys.length} needed${v.uncounted.length ? `; not counted: ${v.uncounted.join("; ")}` : ""}`,
      );
      add("importFinalityProof", head.header, head.hash, v, headProof.scale, null);
    }
  }
  return { steps, notes, head: head.number };
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
  /** The plan's head block on Portaldot, for the warning about set changes held back. */
  head?: number;
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
 * eth_simulateV1, asked again (every 3 s, 10 times) while it fails the way a load-balanced RPC
 * can (transient); Unreachable when it keeps failing. Any other error is the request's (`what`).
 */
async function simulated(params: unknown[], what: string): Promise<SimBlock[]> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await rpc<SimBlock[]>("eth_simulateV1", params);
    } catch (error) {
      if (!transient(error)) throw new Error(`${what}: ${errorText(error)}`);
      if (attempt === 10) throw new Unreachable(`Sepolia RPC unreachable (eth_simulateV1: ${errorText(error)})`);
      log(`     (eth_simulateV1: ${errorText(error)}; retrying)`);
      await sleep(3_000);
    }
  }
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
    const blocks = await simulated([{ blockStateCalls, validation: true }, ctx.block.number], `request [${request.map((s) => s.index).join(",")}]`);

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

/** Runs the plan on the node; null when a check fails, "underfunded" when the cost check is the only one that fails. */
async function dryRun(steps: Step[], ctx: Context, title: string): Promise<DryRun | "underfunded" | null> {
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
  const othersFailed = failures > 0;
  const funded = check(
    need + ctx.keep <= ctx.balance,
    `cost at the current fees ${eth(ctx.balance - run.balance)} (base fee ${fmt(run.baseFee)} wei + priority fee, as simulated);` +
      ` at most ${eth(need)} at the max fee, with --keep ${eth(ctx.keep)} left; the sender has ${eth(ctx.balance)}`,
  );
  if (failures === 0) return { limits, gas };
  return funded || othersFailed ? null : "underfunded";
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

/** The sender's record (relay-sepolia-<sender>.json in the state directory), the history its settled transactions move to (.jsonl), and the run's lock. */
interface Ledger {
  path: string;
  history: string;
  record: RelayRecord;
  /** The sender's lock, checked before every write of the record or the history. */
  lock: Lock | null;
}

function openLedger(s: Sender, lock: Lock | null = null): Ledger {
  const ledger: Ledger = { path: s.record, history: s.history, record: { network: "sepolia", chainId: Number(SEPOLIA_CHAIN_ID), sender: s.address, open: [] }, lock };
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

/** Stops the run (LockLost) unless the sender's lock still holds this run's token. */
function fence(l: Ledger, what: string): void {
  if (l.lock && !l.lock.held()) throw new LockLost(`${l.lock.path} no longer holds this run's token: another relayer took the lock over, and nothing more is ${what}`);
}

function saveLedger(l: Ledger): void {
  fence(l, "written");
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

/** Windows reports a file busy (EBUSY, EPERM, EACCES) for a moment while another process reads, scans or deletes it. */
const busy = (error: unknown) => /^(EBUSY|EPERM|EACCES)$/.test((error as NodeJS.ErrnoException | null)?.code ?? "");

/** `fn`, tried again every 250 ms for up to 5 s while the file it touches is busy. */
function busyRetry<R>(fn: () => R): R {
  for (let i = 1; ; i++) {
    try {
      return fn();
    } catch (error) {
      if (i === 20 || !busy(error)) throw error;
      pause(250);
    }
  }
}

/** False when `path` holds bytes and the last one is no newline (a line cut short, say by a power cut). */
function endsLine(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return true;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] === 0x0a;
  } finally {
    closeSync(fd);
  }
}

/**
 * Moves a settled transaction from the record to the history: appended there first, so a crash in
 * between repeats a line instead of losing one (whatever reads the history dedupes by txHash). A
 * history whose last line was cut short gets a newline first, so the new line stays whole.
 */
function archive(l: Ledger, entry: RelayEntry): void {
  entry.settledAt = new Date().toISOString();
  fence(l, "written");
  try {
    const line = JSON.stringify(entry) + "\n";
    busyRetry(() => appendFileSync(l.history, endsLine(l.history) ? line : "\n" + line));
  } catch (error) {
    throw new Fatal(`${l.history}: ${errorText(error)}`);
  }
  l.record.open = l.record.open.filter((e) => e !== entry);
  saveLedger(l);
}

/** The sender's lock, held by one --send run at a time. */
interface Lock {
  path: string;
  /** True while the lock still holds this run's token; it then refreshes the lock's time too. */
  held(): boolean;
  /** Stops refreshing and removes the lock if it is still this run's; never throws. */
  release(): void;
}

/** The lock's content and holder (0 when the content is not a lock's, as when half written) and the time since it was refreshed, or null when there is none. */
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
 * A lock found in place is stale when its process is gone, when it is this process's own (its runs
 * never overlap: an earlier one could not remove it), or when it was not refreshed for LOCK_STALE
 * (its process id now another process's, or a holder suspended that long); a half-written one is
 * stale after 10 s.
 */
function stale(held: { pid: number; age: number }): boolean {
  if (held.pid === 0) return held.age >= 10_000;
  return held.pid === process.pid || !alive(held.pid) || held.age > LOCK_STALE;
}

/**
 * Only one --send run at a time per sender: the lock, in the state directory, holds the holder's
 * process id and a token of the run's own, and the holder refreshes its time every LOCK_REFRESH. A
 * stale lock is taken over by the one process that creates <lock>.takeover: if the lock still holds
 * what it found, and is still stale, it renames it aside (renameSync) and removes it, and then every
 * process tries again to create the lock, which only one can. A lock in use is never moved; a
 * takeover file older than 30 s is taken for one whose process died; a busy file (Windows keeps one
 * being deleted for a moment) is tried again after 200 ms. Returns the lock, or null while another
 * live relayer holds it.
 *
 * The limits: two runs can hold it at once when a process stalls more than 10 s between creating
 * the lock and writing it, or more than 30 s inside a takeover; and a holder that refreshes nothing
 * for LOCK_STALE (a suspended process, or a machine asleep while another relayer of the sender wakes
 * first) is taken over. Before each signing and each write of the record or the history a run checks
 * that the lock still holds its token, and stops when it does not, so it then signs and writes
 * nothing more, apart from a write already under way. The lock works between processes of one
 * machine on a local disk: not between machines, nor on a network share or a synced folder.
 */
function takeLock(path: string): Lock | null {
  const takeover = `${path}.takeover`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const content = JSON.stringify({ pid: process.pid, token: randomUUID(), since: new Date().toISOString() });
    try {
      const fd = openSync(path, "wx");
      try {
        writeSync(fd, content);
      } finally {
        closeSync(fd);
      }
      return heldLock(path, content);
    } catch (error) {
      if (busy(error)) {
        pause(200);
        continue;
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let held: ReturnType<typeof readLock>;
    try {
      held = readLock(path);
    } catch (error) {
      if (!busy(error)) throw error;
      pause(200);
      continue;
    }
    if (!held) continue; // released meanwhile
    if (!stale(held)) {
      log(held.pid === 0 ? `     another relayer is writing ${path}` : `     another relayer (process ${held.pid}) is sending; ${path} is its lock`);
      return null;
    }
    if (held.pid > 0 && held.pid !== process.pid && alive(held.pid)) {
      log(`     ${path} names process ${held.pid}, which runs but has not refreshed the lock for ${Math.floor(held.age / 60_000)} minutes: it is taken for stale`);
    }
    let fd: number;
    try {
      fd = openSync(takeover, "wx");
    } catch (error) {
      if (!busy(error) && (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Another process is taking it over; a takeover file this old is from one that died meanwhile.
      if (ageOf(takeover) > 30_000) {
        try {
          rmSync(takeover, { force: true });
        } catch (removing) {
          if (!busy(removing)) throw removing;
        }
      }
      pause(200);
      continue;
    }
    closeSync(fd);
    try {
      const now = readLock(path);
      if (now?.content === held.content && stale(now)) {
        const aside = `${path}.${process.pid}.stale`;
        renameSync(path, aside);
        busyRetry(() => rmSync(aside, { force: true }));
      }
    } catch (error) {
      if (!busy(error)) throw error;
      pause(200);
    } finally {
      busyRetry(() => rmSync(takeover, { force: true }));
    }
  }
  log(`     ${path} could not be taken`);
  return null;
}

/** The lock this run created with `content`: refreshed every LOCK_REFRESH while held. */
function heldLock(path: string, content: string): Lock {
  const held = () => {
    try {
      if (busyRetry(() => readFileSync(path, "utf8")) !== content) return false;
    } catch {
      return false;
    }
    try {
      const now = new Date();
      utimesSync(path, now, now);
    } catch {
      // refreshed at the next check
    }
    return true;
  };
  const beat = setInterval(held, LOCK_REFRESH);
  beat.unref();
  return {
    path,
    held,
    release: () => {
      clearInterval(beat);
      try {
        if (readLock(path)?.content === content) rmSync(path, { force: true });
      } catch (error) {
        log(`     (${path} could not be removed: ${errorText(error)}; the next run of this process takes it over)`);
      }
    },
  };
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

const NOT_NEWER = bytesToHex(selector("NotNewer(uint32,uint32)"));

/**
 * Why a mined transaction imported nothing, and whether another relayer imported its header or a
 * later one first (superseded). Out of gas (status 0 with every gas of its limit used) fails. Status
 * 1 without HeaderImported is the client verifying again a header it holds (the only way an import
 * returns without importing): superseded when it holds the header at the receipt's block. Any other
 * revert: a receipt carries no reason, so the transaction (its own input, sender and gas limit) is
 * replayed with eth_call on the state its block left, and is superseded when the replay reverts with
 * NotNewer (the client was at or past the header) or verifies a header the client holds; it fails
 * on any other revert, or when the header would still import. A revert for another reason in a block
 * where another relayer's import came after it would read as superseded too.
 */
async function importedNothing(entry: RelayEntry, receipt: Receipt, status: number, gasUsed: number): Promise<{ superseded: boolean; why: string }> {
  if (status === 0 && gasUsed >= entry.gasLimit) return { superseded: false, why: `out of gas, all ${fmt(entry.gasLimit)} of its gas limit used` };
  const held = async () => {
    const now = await readLatest(entry.client, receipt.blockNumber, entry.block.hash);
    return now.imported ? `the client held the header already, at #${fmt(now.number)} ${shortHex(now.hash)}` : null;
  };
  if (status === 1) {
    const why = await held();
    return why ? { superseded: true, why } : { superseded: false, why: "without HeaderImported" };
  }
  const tx = await sepolia("transaction", async () => {
    const t = await rpc<{ from: Hex; to: Hex; input: Hex; gas: string } | null>("eth_getTransactionByHash", [receipt.transactionHash]);
    if (!t) throw new Error(`no transaction ${receipt.transactionHash}`);
    return t;
  });
  const replay = await sepolia("replay", async () => {
    const body = (await rpcBody("eth_call", [{ from: tx.from, to: tx.to, data: tx.input, gas: tx.gas }, receipt.blockNumber])) as {
      result?: Hex;
      error?: { message?: string; data?: string };
    };
    // An error without revert data can be a node that has not seen the block yet: asked again.
    if (body.error && body.error.data === undefined && transient(new Error(JSON.stringify(body.error)))) throw new Error(JSON.stringify(body.error));
    return body;
  });
  if (replay.error) {
    const data = (replay.error.data ?? "").toLowerCase();
    if (data.startsWith(NOT_NEWER)) {
      const args = hexToBytes(`0x${data.slice(10)}`);
      const [number, latest] = [uintAt(args, 0), uintAt(args, 1)];
      return { superseded: true, why: `replayed on its block it reverts with NotNewer(${number}, ${latest}): the client was at #${fmt(latest)} already` };
    }
    return { superseded: false, why: `replayed on its block it ${revertText({ status: "0x0", gasUsed: "0x0", returnData: "0x", error: replay.error })}` };
  }
  const why = await held();
  return why ? { superseded: true, why } : { superseded: false, why: "yet replayed on its block it would import the header" };
}

/**
 * Checks a mined transaction's receipt and events and moves it, with the other transactions at its
 * nonce (which can no longer be mined), from the record to the history; superseded or failed, as
 * importedNothing tells, when it imported nothing.
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
    const nothing = await importedNothing(entry, receipt, status, gasUsed);
    if (nothing.superseded) {
      outcome = "superseded";
      log(`     ${what}: superseded, ${nothing.why} (another relayer imported it or a later header first)`);
    } else {
      check(false, `${what}: ${nothing.why}`);
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
  /** Pending ones (old enough to be replaced, with higher fees) or dropped ones (signed again, outbid as far as the cap allows). */
  earlier: RelayEntry[];
}

/**
 * Settles what the record left open, before anything is planned. A transaction mined since (one
 * taken for dropped or replaced too) is checked and moves to the history; a nonce used on chain by
 * none of the record's transactions, after a minute's wait for a receipt, is Fatal. What is left
 * is at the sender's next nonce: a transaction of the other chain's runs, which this run never
 * replaces (PENDING, until that chain's runs settle it), still pending (PENDING, until it has waited
 * --replace-after), or dropped. Superseded transactions are noted, and planning goes on from the
 * client's state.
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
  // One sender's record holds both chains' transactions: another client's is left to its own runs.
  const client = deployment(o.chain).client;
  const other = earlier.find((e) => e.client !== client);
  if (other) {
    log(
      `     ${other.txHash} (${other.method} #${fmt(other.block.number)} to ${other.client}, of a --chain ${other.chain} run) is open at the sender's ` +
        `next nonce ${other.nonce}: it is left to that chain's runs, and nothing is sent until one settles it`,
    );
    return { code: PENDING, earlier: [] };
  }
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
 * The most a replacement offers per gas: the max fee a run would use at a base fee of the step's
 * gate (ten times it plus the priority fee, at least the run's own at a base fee not above it), or
 * --max-fee when it is given, which no transaction passes.
 */
const feeCap = (o: Options, now: Fees, gate: bigint) => o.maxFee ?? max(10n * gate + now.tip, now.maxFee);

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
 * fee is above the step's gate, the raised fees would pass feeCap, or the rest of the plan at the
 * new max fee would leave the sender less than --keep.
 */
async function replacement(fees: Fees, rest: Step[], dry: DryRun, ctx: Context, o: Options): Promise<Fees | null> {
  const gate = gateOf(rest[0], o);
  const block = await sepolia("latest block", () => rpc<{ number: string; hash: string }>("eth_getBlockByNumber", ["latest", false]));
  const now = await sepolia("fees", () => feesAt(block, { priorityFee: o.priorityFee, maxFee: o.maxFee }));
  if (now.base > gate) {
    log(`     (the base fee is ${fmt(now.base)} wei, above ${gateName(rest[0])} ${fmt(gate)} wei: not signed again yet)`);
    return null;
  }
  const next = raised(fees, now, feeCap(o, now, gate));
  if (!next) {
    log(`     (signing again needs a max fee above ${fmt(feeCap(o, now, gate))} wei: not signed again)`);
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

/** False, printed, when the sender's lock no longer holds this run's token: nothing more is signed. */
function fenced(l: Ledger): boolean {
  if (!l.lock || l.lock.held()) return true;
  check(false, `${l.lock.path} no longer holds this run's token: another relayer took the lock over, and nothing more is signed`);
  return false;
}

/**
 * Signs the first of `rest` at its nonce, records it and broadcasts it, then waits for a
 * transaction at that nonce to be mined: this one, one an earlier run left in the record, or the
 * step signed again with higher fees after each --replace-after without a receipt (as replacement
 * allows), once the client, read at the latest block (from Sepolia block `after` on), still is
 * where the step expects it. Every signing first checks the sender's lock. Returns PENDING after
 * RECEIPT_TIMEOUT, FAILED when the client moved or the lock was lost; else the mined transaction,
 * its outcome, and the fees the next step is signed with.
 */
async function sendStep(
  rest: Step[],
  dry: DryRun,
  ctx: Context,
  o: Options,
  l: Ledger,
  after: number,
): Promise<number | { entry: RelayEntry; outcome: Outcome; fees: Fees }> {
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
      // Signed again with the same fees, a transaction keeps its hash: it replaces nothing.
      const replacing = replaces !== undefined && replaces !== signed ? replaces : undefined;
      log(
        `     ${tag(s)} ${s.label}: signed ${signed}, gas limit ${fmt(limit)}` +
          (replacing ? `, max fee ${fmt(fees.maxFee)} wei, priority fee ${fmt(fees.tip)} wei, in place of ${replacing}` : ""),
      );
      if (!replacing) delete entry.replaces;
      Object.assign(entry, { txHash: signed, signedAt: new Date().toISOString() });
      entry = remember(l, entry);
    });
    if (!hash) throw new Fatal("cast mktx could not sign");
    return entry;
  };
  if (!fenced(l)) return FAILED;
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
    if (!next) continue;
    // Another relayer may have moved the client meanwhile: a replacement would then pay for nothing.
    const now = await clientNow(ctx.client, after);
    if (now.hash === s.hash && !now.halted && !now.paused) {
      log(`     the client holds #${fmt(s.number)} already: ${last.txHash} is not signed again, and its receipt is waited for`);
      continue;
    }
    if (now.halted || now.paused || now.hash !== s.before.hash || now.setId !== s.setBefore) {
      check(
        false,
        `the client is ${now.halted ? "halted" : now.paused ? "paused" : `at #${fmt(now.number)} ${shortHex(now.hash)}, set ${now.setId}`} at Sepolia block ${fmt(now.block)}, ` +
          `not where step ${s.index} expects it: ${last.txHash} is not signed again; the next run settles it and plans again`,
      );
      return FAILED;
    }
    if (!fenced(l)) return FAILED;
    fees = next;
    last = sign(last.txHash);
  }
}

/** When this process first saw set changes held back by the base fee in a --send run; reset when one is sent or none is due. */
let heldBackSince: number | undefined;

/**
 * Notes that the base fee holds back set changes the client needs (at set `setId`, `behind` blocks
 * below the head); with --watch, once that has lasted HELD_BACK_WARN_MS, every such run warns.
 */
function heldBack(base: bigint, o: Options, client: { setId: bigint; behind: number }, chainSetId?: bigint): void {
  heldBackSince ??= Date.now();
  const held = Date.now() - heldBackSince;
  if (held < HELD_BACK_WARN_MS) return;
  const hours = (blocks: number) => ((blocks * CHAINS[o.chain].blockSeconds) / 3_600).toFixed(1);
  log(
    `WARN for ${(held / 3_600_000).toFixed(1)} hours the base fee has held back set changes the client needs: the next base fee ${fmt(base)} wei is above ` +
      `--max-base-fee-change ${fmt(o.maxBaseFeeChange)} wei. The client is at set ${client.setId}${chainSetId === undefined ? "" : ` (the node's chain at set ${chainSetId})`}, ` +
      `${fmt(client.behind)} blocks (about ${hours(client.behind)} hours) behind the head, and runs stop when it is --scan-limit ${fmt(o.scanLimit)} blocks behind ` +
      `(in about ${hours(Math.max(0, o.scanLimit - client.behind))} hours): raise --max-base-fee-change to let the set changes through`,
  );
}

/**
 * Before a send run scans: true, printed, when the next base fee holds back all that could be due,
 * that is the head when no set change is due (by Grandpa.CurrentSetId at the node's finalized head)
 * and the set changes too when one is. False when the node does not say: the run then plans.
 */
async function heldBackBeforePlan(portaldot: Portaldot, client: ClientState, current: Fees, o: Options): Promise<boolean> {
  let at: { number: number; setId: bigint } | null = null;
  try {
    at = await portaldot.setIdAtHead();
  } catch (error) {
    if (error instanceof RpcError && error.code === undefined) throw error;
    log(`     (the node's Grandpa.CurrentSetId: ${errorText(error)}; the run plans)`);
  }
  if (!at) return false;
  const due = at.setId > client.setId;
  if (due && current.base <= o.maxBaseFeeChange) return false;
  if (due) heldBack(current.base, o, { setId: client.setId, behind: at.number - client.latestNumber }, at.setId);
  else heldBackSince = undefined;
  log(
    `     the next base fee is ${fmt(current.base)} wei, above ${due ? `--max-base-fee-change ${fmt(o.maxBaseFeeChange)}` : `--max-base-fee ${fmt(o.maxBaseFee)}`} wei` +
      `${due ? `, and set changes are due (the node's chain is at set ${at.setId}, the client at ${client.setId})` : ", and no set change is due"}: nothing is sent in this run`,
  );
  return true;
}

/**
 * Sends the plan one transaction at a time. Before each, the client must still be where the plan
 * expects it (another relayer may have moved it) and neither paused nor halted, as read at the
 * latest block once the RPC has the previous receipt's; the next base fee there must be within the
 * step's gate (else the rest waits for a later run: OK, or PENDING while the record has an open
 * transaction); and the step's nonce must be the sender's next, with nothing pending but what it
 * replaces.
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
    const base = (await sepolia("fees", () => feesAt({ number: qty(now.block) }, { priorityFee: o.priorityFee, maxFee: o.maxFee }))).base;
    if (base > gateOf(s, o)) {
      log(`     the next base fee is ${fmt(base)} wei, above ${gateName(s)} ${fmt(gateOf(s, o))} wei: ${i === 0 ? "the plan is" : "the rest of the plan is"} left for a later run`);
      if (s.setAfter !== s.setBefore) heldBack(base, o, { setId: s.setBefore, behind: (ctx.head ?? s.number) - s.before.number });
      return l.record.open.length > 0 ? PENDING : OK;
    }
    const replacing = l.record.open.some((e) => e.nonce === s.nonce && !e.dropped);
    if (!(await nonceIsNext(ctx.sender, s.nonce, replacing))) return FAILED;
    const sent = await sendStep(steps.slice(i), dry, { ...ctx, fees }, o, l, after);
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
    if (s.setAfter !== s.setBefore) heldBackSince = undefined;
    after = entry.sepoliaBlock!;
  }
  log(`\nEvery transaction is mined and checked; the history is ${l.history}.`);
  return OK;
}

// ---------------------------------------------------------------------------------------
// A run

async function relay(o: Options, sender: Sender, lock: Lock | null = null): Promise<number> {
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
  const ledger = o.send ? openLedger(sender, lock) : null;
  // The record's transactions at the sender's next nonce, which this run signs again: still
  // pending after --replace-after (stuck), or dropped.
  let earlier: RelayEntry[] = [];
  if (ledger) {
    const r = await reconcile(ledger, sender.address, o);
    if (r.code !== OK) return r.code;
    earlier = r.earlier;
  }
  const stuck = earlier.some((e) => !e.dropped);
  /** How a run that sends nothing ends: PENDING while a transaction of the record is open at the next nonce. */
  const idle = () => (earlier.length > 0 ? PENDING : OK);

  // Everything is read at one block, the one the plan is simulated on; a load-balanced RPC can
  // briefly fail on a block it has not seen yet.
  const block = await sepolia("latest block", () => rpc<{ number: string; hash: string }>("eth_getBlockByNumber", ["latest", false]));
  const at = <R>(what: string, method: string, params: unknown[]) => sepolia(what, () => rpc<R>(method, [...params, block.number]));
  const current = await sepolia("fees", () => feesAt(block, { priorityFee: o.priorityFee, maxFee: o.maxFee }));
  const balance = BigInt(await at<string>("balance", "eth_getBalance", [sender.address]));
  const nonce = Number(BigInt(await at<string>("nonce", "eth_getTransactionCount", [sender.address])));
  const n = await sepolia("nonces", () => nonces(sender.address));
  log(`Sepolia block ${fmt(Number(BigInt(block.number)))} (${block.hash}), simulated on top of it via ${new URL(RPC).host}`);
  log(`Sender ${sender.name}: nonce ${nonce}, balance ${eth(balance)}${o.send ? `; record ${sender.record}` : ""}`);
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
    // A send run does not scan while the base fee holds back all that could be due.
    if (o.send && current.base > o.maxBaseFee && (await heldBackBeforePlan(portaldot, client, current, o))) return idle();
    plan = await makePlan(portaldot, client, o);
  } catch (error) {
    // No answer (a timeout, a closed connection), as opposed to an error the node returned.
    if (error instanceof RpcError && error.code === undefined) throw new Unreachable(`Portaldot node unreachable (${errorText(error)})`);
    throw error;
  } finally {
    await portaldot.rpc.close();
  }
  if (plan.upToDate) {
    if (o.send) heldBackSince = undefined;
    check(true, `${chain.client} is up to date: ${plan.upToDate}`);
    if (earlier.length > 0) log(`     ${earlier.at(-1)!.txHash} is still open at nonce ${earlier[0].nonce}: the run ends PENDING until it is settled`);
    return idle();
  }
  for (const note of plan.notes) log(`     note: ${note}`);
  if (plan.steps.length === 0) throw new Stop("nothing can be imported in this run");
  // A step, and every one after it, waits while the next base fee is above the step's gate.
  const cut = plan.steps.findIndex((s) => current.base > gateOf(s, o));
  if (cut >= 0) {
    const s = plan.steps[cut];
    const what = `the next base fee is ${fmt(current.base)} wei, above ${gateName(s)} ${fmt(gateOf(s, o))} wei`;
    if (!o.send) {
      log(`     (${what}: a --send run would ${cut === 0 ? "send nothing now" : `send the first ${cut} transaction${cut === 1 ? "" : "s"} and leave the rest for a later run`})`);
    } else if (cut === 0) {
      if (s.setAfter !== s.setBefore) heldBack(current.base, o, { setId: client.setId, behind: (plan.head ?? s.number) - client.latestNumber });
      else heldBackSince = undefined;
      log(`     ${what}: nothing is sent in this run`);
      return idle();
    } else {
      log(`     note: ${cut === plan.steps.length - 1 && s.method === "importFinalityProof" ? "the head is" : "the rest of the plan is"} left for a later run: ${what}`);
      plan.steps = plan.steps.slice(0, cut);
    }
  }
  for (const s of plan.steps) s.nonce = nonce + s.index;
  // A transaction of the record left at the next nonce (stuck, or dropped and maybe still held by
  // some node) is outbid there: both fees at least 1/8 above the highest signed, within the cap.
  let fees = current;
  if (earlier.length > 0) {
    const cap = feeCap(o, current, gateOf(plan.steps[0], o));
    const higher = raised(highest(earlier), current, cap);
    if (higher) fees = higher;
    else if (stuck) {
      log(`     replacing ${earlier.at(-1)!.txHash} needs a max fee above ${fmt(cap)} wei: it is left to be mined`);
      return PENDING;
    }
  }
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

  const ctx: Context = { block, fees, balance, sender: sender.address, client: address, keep: o.keep, head: plan.head };
  let dry: DryRun | "underfunded" | null = null;
  try {
    dry = await dryRun(plan.steps, ctx, title);
  } catch (error) {
    if (error instanceof Unreachable) throw error;
    check(false, errorText(error));
    // A node refuses to simulate a transaction the sender cannot pay for at its max fee.
    if (failures === 1 && /insufficient funds/i.test(errorText(error))) dry = "underfunded";
  }
  if (dry === "underfunded") {
    log("\nThe dry run failed on the sender's balance alone: nothing can be sent until it is funded.");
    throw new Underfunded(`the sender has ${eth(balance)}, too little for the plan at its max fee with --keep ${eth(o.keep)} left`);
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
  return sendPlan(plan.steps, dry, ctx, o, ledger!);
}

/** One run's exit code, and whether it stopped on something only the admin or the operator can clear. */
interface Run {
  code: number;
  blocked: boolean;
}

/** One run; with --send, under the sender's lock. Fatal problems propagate, everything else becomes an exit code. */
async function runOnce(o: Options, sender: Sender): Promise<Run> {
  failures = 0;
  let lock: Lock | null = null;
  try {
    if (o.send) {
      mkdirSync(dirname(sender.lock), { recursive: true });
      lock = takeLock(sender.lock);
      if (!lock) return { code: FAILED, blocked: false };
    }
    return { code: await relay(o, sender, lock), blocked: false };
  } catch (error) {
    if (error instanceof Fatal) throw error;
    if (error instanceof Unreachable) {
      log(errorText(error));
      return { code: UNREACHABLE, blocked: false };
    }
    check(false, errorText(error));
    if (error instanceof Stop) log(error instanceof Underfunded ? "\nNothing was sent." : "\nNothing was planned.");
    return { code: FAILED, blocked: error instanceof Blocked };
  } finally {
    lock?.release();
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
    sender = senderOf(unlocked.toLowerCase() as Hex, `${unlocked} (keystore ${o.account})`, o.stateDir);
  } else sender = o.from ? senderOf(o.from, o.from, o.stateDir) : senderOf(deployer, `${deployerName} (the deployer)`, o.stateDir);
  if (!legacyRecordMoved(sender)) return FAILED;
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

/**
 * Ends the process with `code` once nothing is left to run, or 10 s later at the latest: exiting at
 * once while a socket still closes can fail an assertion in libuv on Windows (exit code 127).
 */
function exit(code: number): void {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 10_000).unref();
}

main().then(exit, (error: unknown) => {
  check(false, errorText(error));
  exit(FAILED);
});
