// The auto-mint: tPOT locked in PortaldotVault on the Portaldot V3 testnet becomes wtPOT on Sepolia
// without its locker sending anything on Sepolia. The locker signs the lock on V3 and can close the
// page; this process notices the lock and sends the mint for them, paying the gas, through
// BridgeMinter, which mints only to the recipient and the amount the lock's commitment names, and
// only once per nonce: nothing comes from msg.sender, and used(nonce) stops a second mint.
//
//   npm run automint [-- --watch <seconds>] [--grace <seconds>] [--from <V3 block>] [--sender <address>] [--rehearse <nonce>]
//   npm run automint -- --send --account <keystore> --password-file <path> [--watch <seconds>] [--grace <seconds>] [--keep <eth>] [--from <V3 block>] [--retry <nonce>]
//   more options: --state-dir <path> (default ~/.bridge-zero), --rpc <wss url> (the V3 node), --evm <http(s) url> (its EVM RPC),
//   --grace <seconds> (default 90), --replace-after <minutes> (default 10), --min-amount <tPOT> (default 0.01),
//   --max-spend <eth> a day (default 0.02), --priority-fee <gwei>, --max-fee <gwei>, --max-base-fee <gwei> (default 1.5)
//
// A round:
// 1. Settles what an earlier round left open in the sender's history (below), nonce by nonce: of
//    the transactions it signed at one nonce (one, and those that replaced it), the one mined gets
//    its receipt and the others are replaced; while one is pending nothing else is sent this round,
//    unless it has waited --replace-after since the last of them was signed: then the next mint
//    planned signs that nonce again, with the max fee and the priority fee at least 1/8 higher and
//    at least the current ones, up to --max-fee (or the max fee at a base fee of --max-base-fee);
//    one neither mined nor pending is dropped (its nonce, when still free, is the next send's).
// 2. Reads the vault's Locked events on V3's EVM RPC with eth_getLogs, in windows of 10,000 blocks,
//    from the state's next block (less 64 blocks, read again in case the RPC's index lagged) up to
//    the RPC's finalized block, and checks the vault's nextNonce at that block against the locks in
//    the state: one the scan missed is looked up by its nonce and taken in, with a WARN. A lock for
//    another destination chain or minter, or whose commitment is not the one its fields give, is
//    recorded as skipped and never minted.
// 3. For each lock not minted yet, in nonce order: used(nonce) on Sepolia (true: minted, by whoever
//    sent it); --min-amount (a lock below it is skipped: dust costs its locker nearly nothing, and
//    its locker mints it from the app); V3's finality of its block, by the V3 node the proofs come
//    from; --grace seconds after this process first saw it final (the app still offers the locker
//    its own mint then, which is not raced); then the cheapest path that adds no wait:
//      held  the light client holds a V3 header at or after the lock's block (its latest):
//            BridgeMinter.mint(p) with the lock's proofs read at that header, about 0.6 M gas. No
//            import and no signature, so it works while the client is behind V3's set, paused or
//            halted. When the V3 node no longer serves that header's state, the head path is tried.
//      head  the client is at V3's validator set: importAndMint at V3's latest finalized block,
//            read and checked by mint.ts captureBundle (the path lock 1 took), about 2.5 M gas.
//    While the client is behind V3's set and holds no header at or after the lock, the lock waits
//    for a later round: the live relayer imports each set change within minutes.
// 4. Before every send: eth_call and eth_estimateGas from the sender; the gas limit, the estimate +
//    10%, within Sepolia's 16,777,216 cap; the relayer's fees (priority fee 1,000 wei unless
//    --priority-fee, max fee ten times the next base fee plus it, at least 0.01 gwei, unless
//    --max-fee); the next base fee at most --max-base-fee; what our transactions mined over the last
//    24 hours cost (their receipts' gas used at their effective gas price) plus this one at the next
//    base fee within --max-spend; the balance at least the gas limit at the max fee plus --keep;
//    nothing pending from the sender (but the transaction a replacement replaces); and used(nonce)
//    read once more. A revert NonceAlreadyUsed, in the eth_call or in the mined transaction, counts
//    as minted. Then cast mktx signs, the hash is recorded, used(nonce) is read again (true: it is
//    not broadcast), cast publish broadcasts, and the receipt is waited for (5 minutes; a later round
//    settles it after that). One transaction at a time.
//
// Files, in the state directory (--state-dir, by default .bridge-zero in the home directory), one
// set per sender: automint-sepolia-<sender>.json, the state (the next V3 block to scan and every lock
// seen), written whole through a temporary file with fsync; automint-sepolia-<sender>.jsonl, the
// history, one JSON line per event, appended with fsync: "attempt" before cast mktx signs, "signed"
// with the hash before cast publish broadcasts, "result" once the transaction is settled, "reset"
// when --retry takes a lock in again. An attempt without a result is settled before anything else is
// sent, so a crash between sending and recording never leads to a blind second send: the transaction
// the history names is found mined, pending or dropped first, and a send after a dropped one signs
// its nonce again (at most one transaction at a nonce is ever mined). A state that does not parse is
// set aside (renamed, kept) and rebuilt from the scan and used(nonce); the history is never
// rewritten. Two locks (watch.ts takeLock, the relayer's scheme) are checked before every signing and
// every record: automint-sepolia-<sender>.lock lets one --send process per key and state directory
// run, and automint-sepolia-minter-<minter>.lock, always in ~/.bridge-zero, one per minter, whatever
// its key or state directory (two would each send every mint, and one of each pair would revert).
// With --watch, a lock held at the start (a crash can leave one naming a process id Windows gave
// again) is asked for again every <seconds> until watch.ts takes it over. A key a relayer has sent
// with (a relay-<network>-<key>.json, .jsonl or .lock in --state-dir, in ~/.bridge-zero or in
// deployments/, however old) is refused at the start and before every signing, and so is the light
// client's admin: they would sign at the same nonces. A dry run writes nothing.
//
// A lock left to the operator (MAX_FAILED_SENDS of our transactions mined without minting it, or
// below --min-amount) is skipped; --retry <nonce> takes it in again (its failed sends so far no
// longer count), or the operator mints it by hand: npm run mint -- mint --nonce <n> --send ...
//
// Timeouts: every request has one, so no hung request stalls the loop: Sepolia 15 s a request
// (SEPOLIA_RPC_URL when set, else publicnode, then tenderly, each tried twice), V3's EVM RPC 20 s
// (twice), the V3 node 15 s to connect and 30 s a request, a captureBundle 4 minutes in all, each
// cast 2 minutes, the receipt 5 minutes.
//
// Without --send nothing is signed, --account and --password-file are refused, and every RPC client
// of this process refuses eth_send*, eth_sign*, personal_* and author_submit* (bridge.ts
// installDryRunGuard; with --send too, as cast publishes, in a process of its own). A dry run reads
// the state and history of --sender (by default an address of no one's) without writing, plans each
// lock and dry-runs its send. --rehearse <nonce> (a dry run) builds the mint of a lock that is minted
// already on each path that applies now and requires its eth_call to revert NonceAlreadyUsed, which
// the minter checks only after the header, the proofs and the commitment have passed.
//
// Exit code without --watch: 0 when the round ran, 1 when a check failed or the tool refused, 2 when
// a node could not be reached, 3 when a sent transaction is still pending. With --watch, a round
// starts <seconds> after the one before ends (twice as long after each round a node could not be
// reached, up to 10 minutes); only a Fatal ends it: a lost lock, a record that cannot be written, a
// refused key, or cast unable to sign.
// automint-main.ts runs it (npm run automint); automint.test.ts tests it.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { eth, fmt, keystoreAddress, mktxArgs, parseGwei, qty, redact, redactAlso, sleep, type Fees, type Receipt } from "../../contracts/script/lib/sepolia.mjs";
import {
  addressAt,
  BRIDGE_ERRORS,
  bundleProof,
  callData,
  checkBundle,
  CLIENT,
  decodeMinted,
  DryRunViolation,
  errorMap,
  formatWtpot,
  importAndMintCalldata,
  installDryRunGuard,
  logWindows,
  MINTED_TOPIC,
  MINTER,
  mintCalldata,
  revertName,
  SEPOLIA_CHAIN_ID,
  uintAt,
  V3_CHAIN_ID,
  wordAt,
  type LockProof,
} from "./bridge.js";
import { bytesToHex, equalBytes, hexToBytes, shortHex, type Hex } from "./bytes.js";
import { Chain, childItems } from "./chain.js";
import type { MintBundleFixture } from "./fixture.js";
import { childRootKey, storageKey } from "./hash.js";
import { captureBundle } from "./mint.js";
import { reviveSlotKey } from "./revive.js";
import { RpcClient, RpcError } from "./rpc.js";
import { decodeU64 } from "./scale.js";
import { readProof } from "./trie.js";
import { checksumAddress, commitmentSlot, decodeLocked, formatTpot, LOCKED_TOPIC, lockCommitment, parseTpot, SLOTS, uintWord, type LockedEvent, type LogJson } from "./vault.js";
import { LOCK_STALE, takeLock, type Lock } from "./watch.js";

// ---------------------------------------------------------------------------------------
// Constants

/** Sepolia's most gas a transaction may use (EIP-7825): a mint's gas limit, its estimate + 10%, stays within it. */
export const GAS_CAP = 16_777_216;
const V3_RPC = "wss://test-node-v3.portaldot.dev";
const V3_EVM = "https://test-evm-rpc-v3.portaldot.dev";
const CLIENT_NAME = "GrandpaLightClient #2";

/** Sepolia's RPCs, in order: SEPOLIA_RPC_URL when set, then publicnode, then tenderly (sepolia.drpc.org's free plan refuses Sepolia calls). */
export const sepoliaRpcs = (env = process.env.SEPOLIA_RPC_URL): string[] => [
  ...new Set([env, "https://ethereum-sepolia-rpc.publicnode.com", "https://sepolia.gateway.tenderly.co"].filter((u): u is string => !!u && URL.canParse(u))),
];

/**
 * Where the first run scans from without --from: V3 block #218,400. On Oct 27, 2026, V3's finalized
 * block was #218,465 (13:56 UTC); the vault's nextNonce was 2, and no Locked log lies between lock
 * 1's block #118,636 and it. Every lock after locks 0 and 1 (both minted) is at or above this block,
 * so a first run started on any later day misses none and does not scan the demo's locks again;
 * --from reaches further back.
 */
export const DEFAULT_START_BLOCK = 218_400;
/** Blocks below the state's next block that each round reads again, in case the EVM RPC's log index lagged behind its finalized block. */
export const SCAN_OVERLAP = 64;
/** Our transactions for one lock that may be mined without minting it before the lock is left to the operator. */
export const MAX_FAILED_SENDS = 3;
/** The most blocks one eth_getLogs asks for (bridge.ts logWindows' default): the scan's and every lookup's windows. */
export const LOG_WINDOW = 10_000;
/** The window --max-spend counts our mined transactions' cost over. */
export const SPEND_WINDOW_MS = 24 * 3_600_000;
/** Every wait is bounded (see the header). */
export const TIMEOUTS = {
  sepoliaMs: 15_000,
  evmMs: 20_000,
  v3ConnectMs: 15_000,
  v3RequestMs: 30_000,
  captureMs: 240_000,
  castMs: 120_000,
  receiptMs: 300_000,
  receiptPollMs: 4_000,
};
const DEFAULT_KEEP = "0.05";
const DEFAULT_MAX_BASE_FEE = "1.5";
/** --grace: the app still offers its own mint once a lock is final, so a send waits this long for the locker first. */
const DEFAULT_GRACE = "90";
/** --replace-after, in minutes: our transaction pending this long is signed again at its nonce, with higher fees. */
const DEFAULT_REPLACE_AFTER = "10";
/** --min-amount, in tPOT: a lock below it is not ours to pay for (dust locks cost their locker nearly nothing). */
const DEFAULT_MIN_AMOUNT = "0.01";
/** --max-spend, in ETH: the most our mined transactions may cost over SPEND_WINDOW_MS. */
const DEFAULT_MAX_SPEND = "0.02";
const MAX_REPLACE_AFTER_MINUTES = 1_440;
/** The relayer's priority fee (sepolia.mjs feesAt): 1,000 wei, above what most Sepolia blocks pay. */
const DEFAULT_TIP = 1_000n;
/** The lowest max fee feesAt sets (0.01 gwei). */
const MIN_MAX_FEE = 10_000_000n;
export const MIN_WATCH_SECONDS = 10;
export const MAX_WATCH_SECONDS = 86_400;
/** The longest wait between rounds after rounds in a row that could not reach a node. */
export const MAX_BACKOFF_SECONDS = 600;
const MAX_GRACE_SECONDS = 86_400;
/** The sender of a dry run without --sender, for eth_call and eth_estimateGas: an address no one holds. */
export const DRY_RUN_SENDER: Hex = "0x00000000000000000000000000000000b21da070";
const SET_ID_KEY = storageKey("Grandpa", "CurrentSetId");
const REPO = fileURLToPath(new URL("../..", import.meta.url));
/** Where the relayers keep their records and locks (relay.ts --state-dir's default), whatever auto-mint's --state-dir is. */
const STATE_DIR = join(homedir(), ".bridge-zero");

export const OK = 0;
export const FAILED = 1;
export const UNREACHABLE = 2;
export const PENDING = 3;

// ---------------------------------------------------------------------------------------
// Output and errors

let out: (line: string) => void = (line) => console.log(line);
/** Where the lines go: console.log, or the tests' collector. */
export function setLog(fn: (line: string) => void): void {
  out = fn;
}
const log = (line = "") => out(line);
export const errorText = (error: unknown) => redact(error instanceof Error ? error.message : String(error));
const n = (x: number | bigint) => fmt(x);
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const hostOf = (url: string) => (URL.canParse(url) ? new URL(url).host : "the RPC");
const short = (address: string) => shortHex(checksumAddress(hexToBytes(address)));

let failures = 0;
function check(ok: boolean, what: string): boolean {
  log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
  return ok;
}

/** A node or an RPC that did not answer in time, after its retries: the round ends and the next one asks again. */
export class Unreachable extends Error {
  override name = "Unreachable";
}

export interface RpcErrorBody {
  code?: number;
  message?: string;
  data?: unknown;
}

export interface RpcBody {
  result?: unknown;
  error?: RpcErrorBody;
}

/** An RPC answered a request with an error (a revert, a parameter it refuses). */
export class AnswerError extends Error {
  override name = "AnswerError";

  constructor(
    readonly method: string,
    readonly answer: RpcErrorBody,
  ) {
    super(`${method}: ${answer.message ?? "error"}${answer.code === undefined ? "" : ` (code ${answer.code})`}`);
  }
}

/** Something only the operator can clear: the process stops (a lost lock, a record it cannot read or write, a key another tool sends with). */
export class Fatal extends Error {
  override name = "Fatal";
}

/** A command line the tool does not take. */
export class Usage extends Error {
  override name = "Usage";
}

/** What a chain served failed a check: nothing is sent for the lock in this round. */
export class CheckError extends Error {
  override name = "CheckError";
}

/** The chains moved while a path was built (a newer import, a new set): the next round plans again. */
export class Moved extends Error {
  override name = "Moved";
}

// ---------------------------------------------------------------------------------------
// Requests, each with a timeout

/**
 * Errors a load-balanced RPC gives for a while (a block it has not seen, a rate limit, an internal
 * error): asked of the next endpoint. An error that carries revert data is the call's answer, never one of these.
 */
const TRANSIENT = /header not found|block not found|unknown block|missing trie node|not (yet )?available|timeout|timed out|rate limit|too many requests|unavailable|internal error|-32005\b|-32603\b/i;
export const transientAnswer = (e: RpcErrorBody): boolean => revertData(e) === null && TRANSIENT.test(`${e.message ?? ""} (code ${e.code ?? ""})`);

/**
 * JSON-RPC over HTTP with a timeout on each request (the body included), across endpoints in order:
 * one that does not answer in time, answers an HTTP error or a transient error is passed over for
 * the next, the whole list `tries` times, then Unreachable. Only hosts are printed: a URL can carry
 * a key.
 */
export class HttpRpc {
  private id = 1;
  /** The endpoint that answered last: where cast publishes. */
  lastUrl: string;

  constructor(
    readonly name: string,
    readonly urls: string[],
    readonly timeoutMs: number,
    readonly tries = 2,
    readonly pauseMs = 1_000,
  ) {
    if (urls.length === 0) throw new Error(`${name}: no URL`);
    this.lastUrl = urls[0];
  }

  private async ask(url: string, method: string, params: unknown[]): Promise<RpcBody> {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.id++, method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = (await response.json()) as unknown;
    if (json === null || typeof json !== "object" || (!("result" in json) && !("error" in json))) throw new Error("not a JSON-RPC answer");
    return json as RpcBody;
  }

  /** The first answer that counts: a result, or an error the RPC returned for the request itself (a revert, say). */
  async body(method: string, params: unknown[]): Promise<RpcBody> {
    const problems: string[] = [];
    for (let attempt = 1; attempt <= this.tries; attempt++) {
      for (const url of this.urls) {
        let answer: RpcBody;
        try {
          answer = await this.ask(url, method, params);
        } catch (error) {
          if (error instanceof DryRunViolation) throw error;
          problems.push(`${hostOf(url)}: ${errorText(error)}`);
          continue;
        }
        if (answer.error && transientAnswer(answer.error)) {
          problems.push(`${hostOf(url)}: ${answer.error.message ?? "error"}`);
          continue;
        }
        this.lastUrl = url;
        return answer;
      }
      if (attempt < this.tries) await sleep(this.pauseMs);
    }
    throw new Unreachable(`${this.name} did not answer ${method} (${problems.slice(-3).join("; ")})`);
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    const b = await this.body(method, params);
    if (b.error) throw new AnswerError(method, b.error);
    return b.result as T;
  }

  /**
   * The first result that is not null, asking every endpoint once (a receipt or a transaction one
   * backend has and another not yet); null when each that answered had none, Unreachable when none answered.
   */
  async firstNonNull<T>(method: string, params: unknown[]): Promise<T | null> {
    const problems: string[] = [];
    let answered = false;
    for (const url of this.urls) {
      try {
        const b = await this.ask(url, method, params);
        if (b.error) {
          problems.push(`${hostOf(url)}: ${b.error.message ?? "error"}`);
          continue;
        }
        answered = true;
        if (b.result !== null && b.result !== undefined) {
          this.lastUrl = url;
          return b.result as T;
        }
      } catch (error) {
        if (error instanceof DryRunViolation) throw error;
        problems.push(`${hostOf(url)}: ${errorText(error)}`);
      }
    }
    if (!answered) throw new Unreachable(`${this.name} did not answer ${method} (${problems.join("; ")})`);
    return null;
  }
}

/**
 * `work`, or Unreachable once `ms` have passed: the round goes on while a read that hangs is left to
 * its own timeouts. Only for reads; nothing is sent under a deadline.
 */
export function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Unreachable(`${what} did not finish within ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** The V3 node, with automint's timeouts: Unreachable when it cannot be reached. */
export async function openV3(url: string, t = { connectMs: TIMEOUTS.v3ConnectMs, requestMs: TIMEOUTS.v3RequestMs }): Promise<Chain> {
  try {
    return new Chain(await RpcClient.connect(url, { connectTimeoutMs: t.connectMs, requestTimeoutMs: t.requestMs }));
  } catch (error) {
    throw new Unreachable(`the V3 node ${hostOf(url)} is unreachable (${errorText(error)})`);
  }
}

/** A V3 node read: Unreachable when the node did not answer (a timeout, a closed connection), else what it answered or threw. */
export async function v3<R>(what: string, read: () => Promise<R>): Promise<R> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof RpcError && error.code === undefined) throw new Unreachable(`the V3 node did not answer (${what}: ${errorText(error)})`);
    throw error;
  }
}

// ---------------------------------------------------------------------------------------
// cast, with a timeout

export interface ToolRun {
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** The environment cast runs with: without the variables that would add a sender, a key, a gas setting or libraries (as sepolia.mjs toolEnv). */
function toolEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(ETH|CAST|TEMPO|FOUNDRY|ETHERSCAN|VERIFIER|DAPP)_/i.test(k) && k.toUpperCase() !== "CHAIN") env[k] = v;
  return env;
}

let toolDir: string | undefined;
/**
 * Runs `command` with `args` for at most `timeoutMs`, then kills it. cast runs in an empty directory
 * of its own (Foundry would load a .env file of the directory it runs in), removed on exit, as
 * sepolia.mjs cast runs it.
 */
export function runTool(command: string, args: string[], timeoutMs: number): ToolRun {
  if (!toolDir) {
    const dir = mkdtempSync(join(tmpdir(), "bz-automint-"));
    toolDir = dir;
    process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  }
  const r = spawnSync(command, args, { cwd: toolDir, env: toolEnv(), encoding: "utf8", windowsHide: true, maxBuffer: 1 << 26, timeout: timeoutMs, killSignal: "SIGKILL" });
  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || (r.status === null && r.signal !== null);
  return { ok: r.status === 0 && !r.error, stdout: r.stdout ?? "", stderr: r.stderr ?? "", timedOut };
}

/** Signs and broadcasts: cast in the tool, a stand-in in the tests. */
export interface Signer {
  /** The signed raw transaction, or null when it could not be signed (printed). */
  sign(args: string[]): Hex | null;
  /** Broadcasts it; false when the RPC refused it or did not answer in time (printed): the receipt is waited for anyway. */
  publish(raw: Hex, rpcUrl: string): boolean;
}

/** The hash of a signed raw transaction: keccak-256 of its bytes. */
export const txHashOf = (raw: Hex): Hex => bytesToHex(keccak_256(hexToBytes(raw)));

export const castSigner: Signer = {
  sign(args) {
    const r = runTool("cast", args, TIMEOUTS.castMs);
    const raw = /0x[0-9a-fA-F]+/.exec(r.stdout)?.[0];
    if (!r.ok || !raw) {
      log(`FAIL cast mktx ${r.timedOut ? `did not finish within ${TIMEOUTS.castMs / 1000} s` : "failed"}: ${redact(r.stderr || r.stdout) || "no output"}`);
      return null;
    }
    return raw.toLowerCase() as Hex;
  },
  publish(raw, rpcUrl) {
    const r = runTool("cast", ["publish", raw, "--rpc-url", rpcUrl, "--async"], TIMEOUTS.castMs);
    const sent = /0x[0-9a-fA-F]{64}/.exec(r.stdout)?.[0]?.toLowerCase();
    if (!r.ok || sent !== txHashOf(raw)) {
      log(`     (cast publish: ${r.timedOut ? "no answer in time" : redact(r.stderr || r.stdout) || "no hash"}; the receipt is waited for anyway)`);
      return false;
    }
    return true;
  },
};

// ---------------------------------------------------------------------------------------
// Options

export interface Options {
  send: boolean;
  account?: string;
  passwordFile?: string;
  /** A dry run's sender (--sender): its balance and nonce are checked too. */
  sender?: Hex;
  watch?: number;
  graceMs: number;
  keep: bigint;
  /** --from: the V3 block the scan starts at. */
  from?: number;
  rehearse?: bigint;
  /** --retry: a lock left to the operator (failed sends, --min-amount) taken in again, once, at the start. */
  retry?: bigint;
  /** --replace-after: our transaction pending this long is signed again at its nonce. */
  replaceAfterMs: number;
  /** --min-amount, in native base units: a lock below it is skipped (its locker mints it from the app). */
  minAmount: bigint;
  /** --max-spend, in wei: the most our mined transactions may cost over SPEND_WINDOW_MS. */
  maxSpend: bigint;
  stateDir: string;
  rpc: string;
  evm: string;
  priorityFee?: bigint;
  maxFee?: bigint;
  maxBaseFee: bigint;
}

export const USAGE = `usage (from relayer/):
  npm run automint [-- --watch <seconds>] [--grace <seconds>] [--from <V3 block>] [--sender <address>] [--rehearse <nonce>]
  npm run automint -- --send --account <keystore> --password-file <path> [--watch <seconds>] [--grace <seconds>] [--keep <eth>] [--from <V3 block>] [--retry <nonce>]
  more options: --state-dir <path> (default ~/.bridge-zero), --rpc <wss url>, --evm <http(s) url>,
    --grace <seconds> (default ${DEFAULT_GRACE}), --replace-after <minutes> (default ${DEFAULT_REPLACE_AFTER}),
    --min-amount <tPOT> (default ${DEFAULT_MIN_AMOUNT}), --max-spend <eth> a day (default ${DEFAULT_MAX_SPEND}),
    --priority-fee <gwei>, --max-fee <gwei>, --max-base-fee <gwei> (default ${DEFAULT_MAX_BASE_FEE})`;

function usage(problem: string): never {
  throw new Usage(problem);
}

/** A whole number written as digits only; NaN otherwise. */
const whole = (s: string) => (/^\d+$/.test(s) ? Number(s) : NaN);

/** An amount in ETH ("0.05") in wei; 0 is allowed. */
export function parseEth(s: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,18}))?$/.exec(s);
  if (!m) throw new Error(`not an amount in ETH: ${s}`);
  return BigInt(m[1]) * 10n ** 18n + BigInt((m[2] ?? "").padEnd(18, "0"));
}

export function parseOptions(args: string[]): Options {
  let v: Record<string, string | boolean | undefined>;
  try {
    v = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: {
        send: { type: "boolean", default: false },
        account: { type: "string" },
        "password-file": { type: "string" },
        sender: { type: "string" },
        watch: { type: "string" },
        grace: { type: "string" },
        keep: { type: "string" },
        from: { type: "string" },
        rehearse: { type: "string" },
        retry: { type: "string" },
        "replace-after": { type: "string" },
        "min-amount": { type: "string" },
        "max-spend": { type: "string" },
        "state-dir": { type: "string" },
        rpc: { type: "string" },
        evm: { type: "string" },
        "priority-fee": { type: "string" },
        "max-fee": { type: "string" },
        "max-base-fee": { type: "string" },
      },
    }).values as Record<string, string | boolean | undefined>;
  } catch (error) {
    usage(errorText(error));
  }
  const str = (k: string) => (typeof v[k] === "string" ? (v[k] as string) : undefined);
  const send = v.send === true;
  const account = str("account");
  const passwordText = str("password-file");
  if (send && !(account && passwordText)) usage("--send needs --account <keystore name> and --password-file <path>");
  if (!send && (account !== undefined || passwordText !== undefined)) usage("--account and --password-file are for --send; a dry run signs nothing");
  // cast runs in a directory of its own: the path is made absolute here (this process never opens it).
  const passwordFile = passwordText === undefined ? undefined : resolve(passwordText);
  redactAlso(passwordFile, passwordText);
  if (passwordFile !== undefined && !existsSync(passwordFile)) usage("--password-file: no such file");
  const senderText = str("sender");
  if (senderText !== undefined && send) usage("--sender is for a dry run: --send sends from the address its keystore unlocks to");
  if (senderText !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(senderText)) usage("--sender must be an address: 0x and 40 hex digits");
  const rehearseText = str("rehearse");
  if (rehearseText !== undefined && send) usage("--rehearse is a dry run: it sends nothing");
  if (rehearseText !== undefined && !/^\d+$/.test(rehearseText)) usage("--rehearse takes a lock nonce, a whole number");
  let watch: number | undefined;
  const watchText = str("watch");
  if (watchText !== undefined) {
    watch = whole(watchText);
    if (!Number.isSafeInteger(watch) || watch < MIN_WATCH_SECONDS || watch > MAX_WATCH_SECONDS) usage(`--watch must be a whole number of seconds, from ${MIN_WATCH_SECONDS} to ${n(MAX_WATCH_SECONDS)}`);
  }
  if (watch !== undefined && rehearseText !== undefined) usage("--rehearse runs once: leave out --watch");
  const retryText = str("retry");
  if (retryText !== undefined && !send) usage("--retry writes the state and the history: it needs --send");
  if (retryText !== undefined && !/^\d+$/.test(retryText)) usage("--retry takes a lock nonce, a whole number");
  const graceText = str("grace") ?? DEFAULT_GRACE;
  const grace = whole(graceText);
  if (!Number.isSafeInteger(grace) || grace > MAX_GRACE_SECONDS) usage(`--grace must be a whole number of seconds, from 0 to ${n(MAX_GRACE_SECONDS)}`);
  const replaceAfter = whole(str("replace-after") ?? DEFAULT_REPLACE_AFTER);
  if (!Number.isSafeInteger(replaceAfter) || replaceAfter < 1 || replaceAfter > MAX_REPLACE_AFTER_MINUTES) {
    usage(`--replace-after must be a whole number of minutes, from 1 to ${n(MAX_REPLACE_AFTER_MINUTES)}`);
  }
  const fromText = str("from");
  const from = fromText === undefined ? undefined : whole(fromText);
  if (from !== undefined && !Number.isSafeInteger(from)) usage("--from must be a V3 block number");
  let keep: bigint;
  try {
    keep = parseEth(str("keep") ?? DEFAULT_KEEP);
  } catch (error) {
    usage(`--keep: ${errorText(error)}`);
  }
  let maxSpend: bigint;
  try {
    maxSpend = parseEth(str("max-spend") ?? DEFAULT_MAX_SPEND);
  } catch (error) {
    usage(`--max-spend: ${errorText(error)}`);
  }
  if (maxSpend === 0n) usage("--max-spend must be above 0: nothing could be sent");
  const minText = str("min-amount") ?? DEFAULT_MIN_AMOUNT;
  let minAmount: bigint;
  try {
    // 0: every lock, however small.
    minAmount = /^0+(\.0*)?$/.test(minText) ? 0n : parseTpot(minText);
  } catch (error) {
    usage(`--min-amount: ${errorText(error)}`);
  }
  const gwei = (name: string, fallback?: string) => {
    const text = str(name) ?? fallback;
    if (text === undefined) return undefined;
    try {
      return parseGwei(text);
    } catch (error) {
      usage(`--${name}: ${errorText(error)}`);
    }
  };
  const priorityFee = gwei("priority-fee");
  const maxFee = gwei("max-fee");
  const maxBaseFee = gwei("max-base-fee", DEFAULT_MAX_BASE_FEE)!;
  if (priorityFee !== undefined && maxFee !== undefined && maxFee < priorityFee) usage("--max-fee must be at least --priority-fee");
  const rpcUrl = str("rpc") ?? V3_RPC;
  const evm = str("evm") ?? V3_EVM;
  if (!/^wss?:\/\//i.test(rpcUrl) || !URL.canParse(rpcUrl) || rpcUrl.includes("#")) usage("--rpc must be a ws:// or wss:// URL without a #fragment");
  if (!/^https?:\/\//i.test(evm) || !URL.canParse(evm)) usage("--evm must be an http:// or https:// URL");
  // Only the host of a custom URL is printed; it can carry a key.
  redactAlso(rpcUrl === V3_RPC ? undefined : rpcUrl, evm === V3_EVM ? undefined : evm);
  const stateDir = str("state-dir");
  if (stateDir === "") usage("--state-dir must be a directory");
  return {
    send,
    account,
    passwordFile,
    sender: senderText?.toLowerCase() as Hex | undefined,
    watch,
    graceMs: grace * 1000,
    keep,
    from,
    rehearse: rehearseText === undefined ? undefined : BigInt(rehearseText),
    retry: retryText === undefined ? undefined : BigInt(retryText),
    replaceAfterMs: replaceAfter * 60_000,
    minAmount,
    maxSpend,
    stateDir: resolve(stateDir ?? STATE_DIR),
    rpc: rpcUrl,
    evm,
    priorityFee,
    maxFee,
    maxBaseFee,
  };
}

// ---------------------------------------------------------------------------------------
// The bridge, from the deployment records

export interface Bridge {
  vault: Hex;
  vaultBlock: number;
  v3ChainId: bigint;
  v3Genesis: Hex;
  chainId: bigint;
  minter: Hex;
  token: Hex;
  client: Hex;
}

/** The vault (deployments/v3-testnet.json) and the minter, its token and light client on Sepolia (deployments/sepolia-bridge.json), lower case. */
export function readBridge(root = REPO): Bridge {
  const read = <T>(file: string): T => {
    try {
      return JSON.parse(readFileSync(join(root, "deployments", file), "utf8")) as T;
    } catch (error) {
      throw new Fatal(`deployments/${file}: ${errorText(error)}`);
    }
  };
  const v3 = read<{ genesisHash?: string; chainId?: number; vault?: { status?: string; address?: string; block?: { number?: number } } }>("v3-testnet.json");
  const sep = read<{ chainId?: number; contracts?: Record<string, string>; lightClient?: { address?: string }; vault?: { address?: string; chainId?: number } }>("sepolia-bridge.json");
  const vault = v3.vault?.address?.toLowerCase();
  const minter = sep.contracts?.BridgeMinter?.toLowerCase();
  const token = sep.contracts?.WrappedTPOT?.toLowerCase();
  const client = sep.lightClient?.address?.toLowerCase();
  if (v3.vault?.status !== "deployed" || !vault || typeof v3.vault.block?.number !== "number" || !v3.genesisHash || BigInt(v3.chainId ?? 0) !== V3_CHAIN_ID) {
    throw new Fatal("deployments/v3-testnet.json records no deployed vault on the V3 testnet");
  }
  if (BigInt(sep.chainId ?? 0) !== SEPOLIA_CHAIN_ID || !minter || !token || !client || sep.vault?.address?.toLowerCase() !== vault) {
    throw new Fatal("deployments/sepolia-bridge.json records no BridgeMinter, WrappedTPOT and light client on Sepolia for that vault");
  }
  return {
    vault: vault as Hex,
    vaultBlock: v3.vault.block.number,
    v3ChainId: V3_CHAIN_ID,
    v3Genesis: v3.genesisHash.toLowerCase() as Hex,
    chainId: SEPOLIA_CHAIN_ID,
    minter: minter as Hex,
    token: token as Hex,
    client: client as Hex,
  };
}

// ---------------------------------------------------------------------------------------
// Locks

export type Path = "held" | "head";

/** A lock as the vault's Locked log gives it. */
export interface LockInfo {
  nonce: bigint;
  /** Its V3 block: the log's blockNumber, which is the Substrate block's number. */
  block: number;
  txHash: Hex | null;
  /** Who locked, on V3. */
  sender: Hex;
  recipient: Hex;
  amount: bigint;
  dstChainId: bigint;
  dstMinter: Hex;
  commitment: Hex;
}

export type Parsed = { kind: "lock"; lock: LockInfo } | { kind: "skip"; lock: LockInfo; why: string } | { kind: "ignore"; why: string };

/**
 * A log the scan read: a lock this minter can mint (kind "lock"); a lock it must never mint, as its
 * commitment names another destination chain or minter, or is not the one its fields give, or has
 * a zero amount or recipient (kind "skip", recorded); or no Locked log of the vault (kind "ignore").
 */
export function parseLockedLog(log: LogJson & { removed?: boolean }, bridge: Pick<Bridge, "vault" | "v3ChainId" | "chainId" | "minter">): Parsed {
  if (log.removed === true) return { kind: "ignore", why: "a log removed by a reorg" };
  if (log.address.toLowerCase() !== bridge.vault) return { kind: "ignore", why: `a log of ${log.address}, not the vault` };
  if (log.topics[0]?.toLowerCase() !== LOCKED_TOPIC) return { kind: "ignore", why: "not a Locked log" };
  let e: LockedEvent;
  try {
    e = decodeLocked(log);
  } catch (error) {
    return { kind: "ignore", why: `a Locked log that does not decode (${errorText(error)})` };
  }
  const block = log.blockNumber === undefined || !/^0x[0-9a-fA-F]+$/.test(log.blockNumber) ? NaN : Number(BigInt(log.blockNumber));
  if (!Number.isSafeInteger(block)) return { kind: "ignore", why: `lock ${e.nonce}'s log has no block number` };
  const lock: LockInfo = {
    nonce: e.nonce,
    block,
    txHash: log.transactionHash ? (log.transactionHash.toLowerCase() as Hex) : null,
    sender: bytesToHex(e.sender),
    recipient: bytesToHex(e.recipient),
    amount: e.amountNative,
    dstChainId: e.dstChainId,
    dstMinter: bytesToHex(e.dstMinter),
    commitment: bytesToHex(e.commitment),
  };
  if (e.dstChainId !== bridge.chainId) return { kind: "skip", lock, why: `its commitment names chain ${e.dstChainId}, not Sepolia (${bridge.chainId})` };
  if (lock.dstMinter !== bridge.minter) return { kind: "skip", lock, why: `its commitment names the minter ${short(lock.dstMinter)}, not this BridgeMinter ${short(bridge.minter)}` };
  const expected = lockCommitment({
    v3ChainId: bridge.v3ChainId,
    vault: hexToBytes(bridge.vault),
    dstChainId: e.dstChainId,
    dstMinter: e.dstMinter,
    recipient: e.recipient,
    amountNative: e.amountNative,
    nonce: e.nonce,
  });
  if (!equalBytes(expected, e.commitment)) return { kind: "skip", lock, why: `its commitment ${lock.commitment} is not the one its fields give (${bytesToHex(expected)})` };
  if (e.amountNative === 0n) return { kind: "skip", lock, why: "a zero amount, which the minter refuses" };
  if (e.recipient.every((b) => b === 0)) return { kind: "skip", lock, why: "the zero recipient" };
  return { kind: "lock", lock };
}

export type Left = "failed-sends" | "min-amount";

/** A lock in the state. */
export interface LockRecord {
  nonce: string;
  block: number;
  txHash: Hex | null;
  sender: Hex;
  recipient: Hex;
  amount: string;
  dstChainId: string;
  dstMinter: Hex;
  commitment: Hex;
  status: "pending" | "minted" | "skipped";
  why?: string;
  /**
   * Why a skipped lock was left to the operator, when it may be minted after all (--retry takes it
   * in again): our transactions were mined without minting it, or it is below --min-amount. A lock
   * skipped without it (another chain or minter, a commitment its fields do not give, a log that
   * disagrees) is never minted.
   */
  left?: Left;
  seenAt: string;
  /** When this process first saw the lock's block finalized by the V3 node: --grace counts from here. */
  finalSeenAt?: string;
  /** Our transaction that minted it. */
  mintTx?: Hex;
  doneAt?: string;
}

export function recordOf(p: Exclude<Parsed, { kind: "ignore" }>, now = Date.now()): LockRecord {
  const l = p.lock;
  return {
    nonce: l.nonce.toString(),
    block: l.block,
    txHash: l.txHash,
    sender: l.sender,
    recipient: l.recipient,
    amount: l.amount.toString(),
    dstChainId: l.dstChainId.toString(),
    dstMinter: l.dstMinter,
    commitment: l.commitment,
    status: p.kind === "lock" ? "pending" : "skipped",
    ...(p.kind === "skip" ? { why: p.why } : {}),
    seenAt: iso(now),
  };
}

/** The light client on Sepolia, as a round reads it. */
export interface ClientView {
  setId: bigint;
  latestHash: Hex;
  latestNumber: number;
  halted: boolean;
  paused: boolean;
}

/** What a decision goes by. */
export interface Facts {
  now: number;
  graceMs: number;
  /** The finalized head of the V3 node the proofs come from, and Grandpa.CurrentSetId there (null: not read). */
  v3Finalized: number;
  v3SetId: bigint | null;
  client: ClientView;
  used: boolean;
  /** Our transactions for this lock that were mined without minting it (the history's "reverted" results since its last --retry). */
  failedSends: number;
  /** --min-amount, in native base units. */
  minAmount: bigint;
}

export type Decision =
  | { kind: "minted"; why: string }
  | { kind: "skip"; why: string; left?: Left }
  | { kind: "wait"; why: string; until?: number }
  | { kind: "mint"; path: Path; why: string };

/**
 * What to do with a lock now: nothing when it is minted (by whoever) or skipped; skip it when it is
 * below --min-amount; wait while V3 has not finalized its block, through --grace after this process
 * first saw it final, while the light client holds no header at or after it and is not at V3's set
 * (or is paused or halted); else mint, by the cheapest path that adds no wait: at the header the
 * client holds (held) when it is at or after the lock's block, else importing V3's finalized head
 * (head). A lock whose transactions were mined MAX_FAILED_SENDS times without minting it is left to
 * the operator.
 */
export function decide(rec: LockRecord, f: Facts): Decision {
  if (rec.status === "skipped") return { kind: "skip", why: rec.why ?? "skipped" };
  if (f.used) return { kind: "minted", why: `used(${rec.nonce}) is true: minted already` };
  if (BigInt(rec.amount) < f.minAmount) {
    return {
      kind: "skip",
      left: "min-amount",
      why: `${formatTpot(BigInt(rec.amount))} is below --min-amount ${formatTpot(f.minAmount)}: auto-mint pays for no lock this small, and its locker mints it from the app (with a lower --min-amount, --retry ${rec.nonce} takes it in again)`,
    };
  }
  if (rec.block > f.v3Finalized) return { kind: "wait", why: `V3 has not finalized #${n(rec.block)} yet (its finalized head is #${n(f.v3Finalized)})` };
  if (f.failedSends >= MAX_FAILED_SENDS) {
    return {
      kind: "skip",
      left: "failed-sends",
      why: `${f.failedSends} of our transactions for it were mined without minting it: left to the operator (--retry ${rec.nonce} takes it in again; or npm run mint -- mint --nonce ${rec.nonce} --send ...)`,
    };
  }
  if (f.graceMs > 0) {
    const since = rec.finalSeenAt ? Date.parse(rec.finalSeenAt) : f.now;
    const until = since + f.graceMs;
    if (f.now < until) return { kind: "wait", why: `--grace: ${Math.ceil((until - f.now) / 1000)} s more, so that a mint from the app is not raced`, until };
  }
  const c = f.client;
  if (c.latestNumber >= rec.block) {
    return { kind: "mint", path: "held", why: `${CLIENT_NAME} holds #${n(c.latestNumber)}, at or after the lock's block: mint(p) there, with no import` };
  }
  if (c.halted || c.paused) {
    return { kind: "wait", why: `${CLIENT_NAME} is ${c.halted ? "halted" : "paused"} and holds no header at or after #${n(rec.block)} (its latest is #${n(c.latestNumber)}): imports revert until its admin acts` };
  }
  if (f.v3SetId === null) return { kind: "wait", why: "V3's validator set was not read in this round" };
  if (f.v3SetId > c.setId) {
    return { kind: "wait", why: `${CLIENT_NAME} is at set ${c.setId} and V3 at set ${f.v3SetId}: the relayer imports the set change within minutes, and a later round mints` };
  }
  if (f.v3SetId < c.setId) return { kind: "wait", why: `the V3 node's finalized head is in set ${f.v3SetId}, behind the light client's set ${c.setId}` };
  return { kind: "mint", path: "head", why: `${CLIENT_NAME} is at V3's set ${c.setId}, its latest #${n(c.latestNumber)} below the lock's block: importAndMint at V3's finalized head` };
}

// ---------------------------------------------------------------------------------------
// The state and the history

export interface State {
  version: 1;
  network: "sepolia";
  chainId: number;
  minter: Hex;
  vault: Hex;
  sender: Hex;
  /** The lowest block the scan reads (the first run's start, or --from). */
  startBlock: number;
  /** The first V3 block not read yet. */
  nextBlock: number;
  locks: Record<string, LockRecord>;
  updatedAt: string;
}

export interface Files {
  state: string;
  history: string;
  lock: string;
}

export const filesOf = (stateDir: string, sender: Hex): Files => {
  const base = join(stateDir, `automint-sepolia-${sender.toLowerCase()}`);
  return { state: `${base}.json`, history: `${base}.jsonl`, lock: `${base}.lock` };
};

/**
 * The lock every --send auto-mint of `minter` takes, whatever its key and --state-dir: two of them,
 * with two keys or two state directories, would each send a mint for every lock, and one of each
 * pair would revert. It is in the relayers' state directory, where every checkout looks.
 */
export const minterLockOf = (minter: Hex, home = STATE_DIR): string => join(home, `automint-sepolia-minter-${minter.toLowerCase()}.lock`);

/** Where a relayer's files can be: auto-mint's --state-dir, the relayers' (~/.bridge-zero, relay.ts's default), and deployments/ of this checkout (where an earlier relayer kept them). */
export const keyDirsOf = (stateDir: string, home = STATE_DIR, repo = REPO): string[] => [...new Set([resolve(stateDir), resolve(home), resolve(join(repo, "deployments"))])];

/**
 * Why `sender` must not send auto-mints, or null: a relayer has sent with it, on any chain (a record,
 * a history or a lock relay-<network>-<sender>.* in one of `dirs`, however old: the relayer holds
 * its lock only while a run lasts and writes its record only when it signs or settles, so neither
 * the lock nor the record's age tells that it stopped). The two would sign at the same nonces. Read only.
 */
export function relayerKeyProblem(dirs: string[], sender: Hex): string | null {
  const own = new RegExp(`^relay-[a-z0-9-]+-${sender.toLowerCase()}\\.(json|jsonl|lock)$`, "i");
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue; // no such directory
    }
    const found = names.find((name) => own.test(name));
    if (found) return `${join(dir, found)} is a relayer's: ${sender} is a relayer's key, and auto-mint needs a key of its own (one nonce sequence per process)`;
  }
  return null;
}

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const busy = (error: unknown) => /^(EBUSY|EPERM|EACCES)$/.test((error as NodeJS.ErrnoException | null)?.code ?? "");

/** `fn`, tried again every 250 ms for up to 5 s while Windows reports the file busy (another process reading or scanning it). */
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

/**
 * True while `lock` still holds this process's token. watch.ts's held() reads the lock file once and
 * answers false on any error, a file Windows reports busy for a moment (an antivirus scan) too, so a
 * false is asked again every `pauseMs` for up to `tries` times before it counts: a lock another
 * process took over holds another token and stays false.
 */
export function stillHeld(lock: Pick<Lock, "held">, tries = 20, pauseMs = 250): boolean {
  for (let i = 1; ; i++) {
    if (lock.held()) return true;
    if (i >= tries) return false;
    pause(pauseMs);
  }
}

/** Writes `text` to `path` through `path`.tmp, flushed to disk before the rename: an interrupted write never leaves half a file. */
export function writeFileAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  busyRetry(() => {
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  });
  busyRetry(() => renameSync(tmp, path));
}

const isHex = (s: unknown): s is Hex => typeof s === "string" && /^0x[0-9a-f]*$/.test(s);

function stateProblem(s: unknown): string | null {
  if (!s || typeof s !== "object") return "not an object";
  const x = s as Partial<State>;
  if (x.version !== 1) return `version ${String(x.version)}`;
  if (!Number.isSafeInteger(x.nextBlock) || !Number.isSafeInteger(x.startBlock)) return "no next block";
  if (!x.locks || typeof x.locks !== "object") return "no locks";
  for (const [k, r] of Object.entries(x.locks)) {
    if (!r || r.nonce !== k || !Number.isSafeInteger(r.block) || !isHex(r.commitment) || !isHex(r.recipient) || !/^\d+$/.test(r.amount ?? "")) return `lock ${k} is not whole`;
    if (!["pending", "minted", "skipped"].includes(r.status)) return `lock ${k} has status ${String(r.status)}`;
  }
  return null;
}

/**
 * The state at `path`: a fresh one starting at `start` when there is none; one that does not parse
 * is set aside (renamed, kept) and rebuilt when `setAside` (a --send run), else left alone (a dry
 * run). A state of another minter, vault or sender is refused.
 */
export function loadState(path: string, bridge: Pick<Bridge, "chainId" | "minter" | "vault">, sender: Hex, start: number, setAside: boolean): { state: State; note: string } {
  const fresh = (): State => ({
    version: 1,
    network: "sepolia",
    chainId: Number(bridge.chainId),
    minter: bridge.minter,
    vault: bridge.vault,
    sender,
    startBlock: start,
    nextBlock: start,
    locks: {},
    updatedAt: iso(),
  });
  if (!existsSync(path)) return { state: fresh(), note: `no state at ${path} yet: the scan starts at V3 #${n(start)}` };
  let parsed: unknown;
  let problem: string | null;
  try {
    parsed = JSON.parse(busyRetry(() => readFileSync(path, "utf8")));
    problem = stateProblem(parsed);
  } catch (error) {
    problem = errorText(error);
  }
  if (problem !== null) {
    if (!setAside) return { state: fresh(), note: `${path} does not parse (${problem}): a --send run sets it aside and rebuilds it; this dry run starts at V3 #${n(start)}` };
    const aside = `${path}.unreadable-${Date.now()}`;
    busyRetry(() => renameSync(path, aside));
    return { state: fresh(), note: `${path} did not parse (${problem}): kept as ${aside}, and rebuilt from V3 #${n(start)} and used(nonce) on Sepolia` };
  }
  const s = parsed as State;
  if (s.chainId !== Number(bridge.chainId) || s.minter !== bridge.minter || s.vault !== bridge.vault || s.sender !== sender) {
    throw new Fatal(`${path} is the state of minter ${s.minter}, vault ${s.vault} and sender ${s.sender} on chain ${s.chainId}, not of this auto-mint`);
  }
  return { state: s, note: `state ${path}: next V3 block #${n(s.nextBlock)}, ${Object.keys(s.locks).length} locks seen` };
}

export function saveState(path: string, state: State): void {
  state.updatedAt = iso();
  writeFileAtomic(path, JSON.stringify(state, null, 2) + "\n");
}

/** How an attempt ended; "replaced": another of our transactions at its nonce was mined instead, so it never can be. */
export type Outcome = "minted" | "already-minted" | "reverted" | "dropped" | "not-sent" | "replaced";

/** Written before cast mktx signs. */
export interface AttemptLine {
  kind: "attempt";
  id: string;
  lock: string;
  path: Path;
  block: { number: number; hash: Hex };
  to: Hex;
  dataHash: Hex;
  sender: Hex;
  txNonce: number;
  recipient: Hex;
  amount: string;
  gas: number;
  gasLimit: number;
  maxFee: string;
  priorityFee: string;
  at: string;
}

/** Written with the hash, before cast publish broadcasts. */
export interface SignedLine {
  kind: "signed";
  id: string;
  lock: string;
  txNonce: number;
  txHash: Hex;
  at: string;
}

/** Written once the attempt is settled. */
export interface ResultLine {
  kind: "result";
  id: string;
  lock: string;
  txHash: Hex | null;
  outcome: Outcome;
  why: string;
  sepoliaBlock: number | null;
  gasUsed: number | null;
  effectiveGasPrice: string | null;
  at: string;
}

/** Written by --retry: the lock's failed sends before it no longer count. */
export interface ResetLine {
  kind: "reset";
  id: string;
  lock: string;
  why: string;
  at: string;
}

export type HistoryLine = AttemptLine | SignedLine | ResultLine | ResetLine;

/** False when `path` holds bytes and the last one is no newline (a line cut short, say by a crash). */
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
 * Appends one JSON line to the history and flushes it to disk; a line a crash cut short gets a
 * newline first, so the new one stays whole. Only the open and the flush are tried again while
 * Windows reports the file busy: the line is written once (the readers count each id once anyway).
 */
export function appendLine(path: string, line: HistoryLine): void {
  mkdirSync(dirname(path), { recursive: true });
  const text = JSON.stringify(line) + "\n";
  const whole = busyRetry(() => endsLine(path));
  const fd = busyRetry(() => openSync(path, "a"));
  try {
    writeSync(fd, whole ? text : "\n" + text);
    busyRetry(() => fsyncSync(fd));
  } finally {
    closeSync(fd);
  }
}

/** The history's lines, and how many do not parse (a line a crash cut short; left as it is). */
export function readHistory(path: string): { lines: HistoryLine[]; bad: number } {
  if (!existsSync(path)) return { lines: [], bad: 0 };
  const lines: HistoryLine[] = [];
  let bad = 0;
  for (const raw of busyRetry(() => readFileSync(path, "utf8")).split("\n")) {
    const text = raw.trim();
    if (!text) continue;
    try {
      const v = JSON.parse(text) as Partial<HistoryLine>;
      if ((v.kind === "attempt" || v.kind === "signed" || v.kind === "result" || v.kind === "reset") && typeof v.id === "string" && typeof v.lock === "string") lines.push(v as HistoryLine);
      else bad += 1;
    } catch {
      bad += 1;
    }
  }
  return { lines, bad };
}

export interface OpenAttempt {
  attempt: AttemptLine;
  signed: SignedLine | null;
}

/** The attempts without a result, in the order they were written, each once (a line written twice counts once). */
export function openAttempts(lines: HistoryLine[]): OpenAttempt[] {
  const settled = new Set(lines.filter((l) => l.kind === "result").map((l) => l.id));
  const signed = new Map<string, SignedLine>();
  for (const l of lines) if (l.kind === "signed" && !signed.has(l.id)) signed.set(l.id, l);
  const seen = new Set<string>();
  const open: OpenAttempt[] = [];
  for (const l of lines) {
    if (l.kind !== "attempt" || settled.has(l.id) || seen.has(l.id)) continue;
    seen.add(l.id);
    open.push({ attempt: l, signed: signed.get(l.id) ?? null });
  }
  return open;
}

/**
 * Our transactions for lock `nonce` that were mined without minting it: the attempts written after
 * its last --retry (a "reset" line) whose result is "reverted", each counted once.
 */
export function failedSendsOf(lines: HistoryLine[], nonce: string): number {
  let from = 0;
  lines.forEach((l, i) => {
    if (l.kind === "reset" && l.lock === nonce) from = i + 1;
  });
  const since = new Set(lines.slice(from).filter((l) => l.kind === "attempt" && l.lock === nonce).map((l) => l.id));
  return new Set(lines.filter((l) => l.kind === "result" && l.lock === nonce && l.outcome === "reverted" && since.has(l.id)).map((l) => l.id)).size;
}

/** What our transactions settled since `since` (ms) cost: gas used times the effective gas price of each mined one, counted once. */
export function spentSince(lines: HistoryLine[], since: number): bigint {
  const seen = new Set<string>();
  let total = 0n;
  for (const l of lines) {
    if (l.kind !== "result" || seen.has(l.id) || l.gasUsed === null || l.effectiveGasPrice === null || !(Date.parse(l.at) >= since)) continue;
    seen.add(l.id);
    total += BigInt(l.gasUsed) * BigInt(l.effectiveGasPrice);
  }
  return total;
}

// ---------------------------------------------------------------------------------------
// Sepolia

export interface CallResult {
  ok: boolean;
  /** The revert data, when the node gave it. */
  revert: Hex | null;
  text: string;
}

/** What a send and a settling read from Sepolia: SepoliaChain in the tool, a stand-in in the tests. */
export interface SepoliaReads {
  used(nonce: bigint): Promise<boolean>;
  call(from: Hex, to: Hex, data: Hex, block?: string): Promise<CallResult>;
  estimateGas(from: Hex, to: Hex, data: Hex): Promise<number>;
  nextBaseFee(): Promise<bigint>;
  balance(address: Hex): Promise<bigint>;
  nonces(address: Hex): Promise<{ latest: number; pending: number }>;
  receipt(hash: Hex): Promise<Receipt | null>;
  /** The transaction as the RPC knows it (blockNumber null while pending), or null when it knows none. */
  transaction(hash: Hex): Promise<{ blockNumber: string | null } | null>;
  /** Where cast publishes. */
  publishUrl(): string;
}

/** The revert data in an RPC error: its data, or data.data (nodes differ). */
export function revertData(e: RpcErrorBody): Hex | null {
  const d = e.data;
  const text = typeof d === "string" ? d : d && typeof d === "object" && typeof (d as { data?: unknown }).data === "string" ? (d as { data: string }).data : null;
  return text !== null && /^0x([0-9a-fA-F]{2})*$/.test(text) ? (text.toLowerCase() as Hex) : null;
}

const NONCE_ALREADY_USED = bytesToHex(keccak_256(new TextEncoder().encode("NonceAlreadyUsed(uint256)")).slice(0, 4));

/** The revert is exactly NonceAlreadyUsed(nonce): the minter checks it after the header, the proofs and the commitment. */
export function isNonceUsed(revert: Hex | null, nonce: bigint): boolean {
  if (revert === null || revert.length !== 2 + 8 + 64 || revert.slice(0, 10) !== NONCE_ALREADY_USED) return false;
  return BigInt(`0x${revert.slice(10)}`) === nonce;
}

/** A revert that means the chains moved between the plan and the call (another import, a new set): planned again in a later round. */
const MOVED_REVERT = /^(NotNewer|WrongSetId|UnknownBlock|BlockMismatch)\(/;

export class SepoliaChain implements SepoliaReads {
  constructor(
    readonly rpc: HttpRpc,
    readonly bridge: Bridge,
    readonly errors: Map<Hex, string>,
  ) {}

  private async view(to: Hex, data: Uint8Array): Promise<Uint8Array> {
    return hexToBytes(await this.rpc.call<Hex>("eth_call", [{ to, data: bytesToHex(data) }, "latest"]));
  }

  async chainId(): Promise<bigint> {
    return BigInt(await this.rpc.call<string>("eth_chainId", []));
  }

  async client(): Promise<ClientView> {
    const get = (signature: string) => this.view(this.bridge.client, callData(signature));
    const latest = await get(CLIENT.latestFinalized);
    return {
      setId: uintAt(await get(CLIENT.currentSetId), 0),
      latestHash: bytesToHex(wordAt(latest, 0)),
      latestNumber: Number(uintAt(latest, 1)),
      halted: uintAt(await get(CLIENT.halted), 0) !== 0n,
      paused: uintAt(await get(CLIENT.paused), 0) !== 0n,
    };
  }

  /** The state root the light client holds for `hash`, and its number; AnswerError (UnknownBlock) when it holds none. */
  async stateRootOf(hash: Hex): Promise<{ stateRoot: Hex; number: number }> {
    const r = await this.view(this.bridge.client, callData("stateRootOf(bytes32)", hexToBytes(hash)));
    return { stateRoot: bytesToHex(wordAt(r, 0)), number: Number(uintAt(r, 1)) };
  }

  async admin(): Promise<Hex> {
    return bytesToHex(addressAt(await this.view(this.bridge.client, callData("admin()")), 0, "admin()"));
  }

  /** The minter's wiring (its light client, vault and V3 chain id), whether it is bound, and the vault's trie id. */
  async minter(): Promise<{ lightClient: Hex; vault: Hex; vaultChainId: bigint; bound: boolean; trieId: Hex }> {
    const get = (signature: string) => this.view(this.bridge.minter, callData(signature));
    return {
      lightClient: bytesToHex(addressAt(await get(MINTER.lightClient), 0, "lightClient()")),
      vault: bytesToHex(addressAt(await get(MINTER.vault), 0, "vault()")),
      vaultChainId: uintAt(await get(MINTER.vaultChainId), 0),
      bound: uintAt(await get(MINTER.bound), 0) !== 0n,
      trieId: bytesToHex(wordAt(await get(MINTER.vaultTrieId), 0)),
    };
  }

  async used(nonce: bigint): Promise<boolean> {
    return uintAt(await this.view(this.bridge.minter, callData(MINTER.used, uintWord(nonce))), 0) !== 0n;
  }

  async call(from: Hex, to: Hex, data: Hex, block = "latest"): Promise<CallResult> {
    const b = await this.rpc.body("eth_call", [{ from, to, data, gas: qty(GAS_CAP) }, block]);
    if (!b.error) return { ok: true, revert: null, text: "no revert" };
    const revert = revertData(b.error);
    const named = revert === null ? null : revertName(hexToBytes(revert), this.errors);
    return { ok: false, revert, text: named ?? `${b.error.message ?? "error"}${revert === null ? "" : ` (${shortHex(revert)})`}` };
  }

  async estimateGas(from: Hex, to: Hex, data: Hex): Promise<number> {
    return Number(BigInt(await this.rpc.call<string>("eth_estimateGas", [{ from, to, data }])));
  }

  /** The next block's base fee, as sepolia.mjs feesAt reads it. */
  async nextBaseFee(): Promise<bigint> {
    const history = await this.rpc.call<{ baseFeePerGas: string[] }>("eth_feeHistory", ["0x1", "latest", []]);
    const last = history.baseFeePerGas.at(-1);
    if (last === undefined) throw new AnswerError("eth_feeHistory", { message: "no base fee" });
    return BigInt(last);
  }

  async balance(address: Hex): Promise<bigint> {
    return BigInt(await this.rpc.call<string>("eth_getBalance", [address, "latest"]));
  }

  async nonces(address: Hex): Promise<{ latest: number; pending: number }> {
    const count = async (which: string) => Number(BigInt(await this.rpc.call<string>("eth_getTransactionCount", [address, which])));
    return { latest: await count("latest"), pending: await count("pending") };
  }

  receipt(hash: Hex): Promise<Receipt | null> {
    return this.rpc.firstNonNull<Receipt>("eth_getTransactionReceipt", [hash]);
  }

  transaction(hash: Hex): Promise<{ blockNumber: string | null } | null> {
    return this.rpc.firstNonNull<{ blockNumber: string | null }>("eth_getTransactionByHash", [hash]);
  }

  publishUrl(): string {
    return this.rpc.lastUrl;
  }
}

// ---------------------------------------------------------------------------------------
// The mint's calldata, on each path

/** One mint, built: the call and what it does. */
export interface Job {
  lock: LockRecord;
  path: Path;
  /** The V3 block the lock is proven at (and imported at, on the head path). */
  block: { number: number; hash: Hex };
  to: Hex;
  data: Hex;
  what: string;
}

/**
 * Walks the two proofs mint(p) carries, as the minter will: the vault's child-trie root from
 * `stateRoot` along ":child_storage:default:" ++ trie id, then commitments[nonce] from that root
 * along blake2_256 of its slot index, each walk using every item. Returns the slot's value (null
 * when the proof shows it absent); throws when a walk fails.
 */
export function verifyLockProofs(
  stateRoot: Uint8Array,
  trieId: Uint8Array,
  nonce: bigint,
  childRootProof: Uint8Array[],
  slotProof: Uint8Array[],
): { childRoot: Uint8Array; value: Uint8Array | null } {
  const rootRead = readProof(stateRoot, childRootProof, childRootKey(trieId));
  if (!rootRead.value || rootRead.value.length !== 32 || rootRead.value.every((b) => b === 0)) throw new CheckError("the vault's child-trie root is not 32 non-zero bytes under the state root");
  if (rootRead.itemsUsed !== childRootProof.length) throw new CheckError(`the child-root proof has ${childRootProof.length - rootRead.itemsUsed} items the walk does not need`);
  const slotRead = readProof(rootRead.value, slotProof, reviveSlotKey(commitmentSlot(nonce)));
  if (slotRead.itemsUsed !== slotProof.length) throw new CheckError(`the slot proof has ${slotProof.length - slotRead.itemsUsed} items the walk does not need`);
  return { childRoot: rootRead.value, value: slotRead.value };
}

/** Reads, at V3 block `at`, the proofs of the vault's child-trie root and of commitments[nonce], walked here (chain.ts, as mint.ts captureBundle reads them). */
export async function readLockProofs(chain: Chain, stateRoot: Uint8Array, at: Hex, trieId: Uint8Array, nonce: bigint) {
  const rootKey = childRootKey(trieId);
  const root = await chain.provenRead(stateRoot, rootKey, at, "child-root");
  if (!root) throw new CheckError(`no child root at ":child_storage:default:" ++ trie id ${bytesToHex(trieId)} at ${at}`);
  const served = await chain.childReadProof(rootKey, reviveSlotKey(commitmentSlot(nonce)), at);
  const { nodes } = childItems(served, root.nodes);
  const walked = verifyLockProofs(stateRoot, trieId, nonce, root.nodes, nodes);
  return { childRootProof: root.nodes, slotProof: nodes, value: walked.value };
}

/** mint(p) at the light client's latest header: its state root there must be V3's, and the slot must hold the lock's commitment. */
export async function heldJob(chain: Chain, sepolia: SepoliaChain, rec: LockRecord, client: ClientView, trieId: Hex, minter: Hex): Promise<Job> {
  const at = { number: client.latestNumber, hash: client.latestHash };
  const held = await sepolia.stateRootOf(at.hash);
  const header = await v3(`the header of #${at.number}`, () => chain.header(at.hash));
  if (header.number !== at.number || held.number !== at.number || bytesToHex(header.stateRoot) !== held.stateRoot) {
    throw new CheckError(`${CLIENT_NAME} holds #${n(held.number)} with state root ${held.stateRoot} for ${at.hash}; V3's header there is #${n(header.number)} with ${bytesToHex(header.stateRoot)}`);
  }
  const proofs = await v3(`lock ${rec.nonce}'s proofs at #${at.number}`, () => readLockProofs(chain, header.stateRoot, at.hash, hexToBytes(trieId), BigInt(rec.nonce)));
  if (!proofs.value || bytesToHex(proofs.value) !== rec.commitment) {
    throw new CheckError(`commitments[${rec.nonce}] holds ${proofs.value ? bytesToHex(proofs.value) : "nothing"} at #${n(at.number)}, not the lock's commitment ${rec.commitment}`);
  }
  const p: LockProof = {
    blockHash: hexToBytes(at.hash),
    accountProof: [],
    childRootProof: proofs.childRootProof,
    slotProof: proofs.slotProof,
    recipient: hexToBytes(rec.recipient),
    amount: BigInt(rec.amount),
    nonce: BigInt(rec.nonce),
  };
  return {
    lock: rec,
    path: "held",
    block: at,
    to: minter,
    data: bytesToHex(mintCalldata(p)),
    what: `mint(p) at #${n(at.number)}, which ${CLIENT_NAME} holds (${proofs.childRootProof.length} + ${proofs.slotProof.length} proof items)`,
  };
}

/**
 * importAndMint of a bundle captureBundle read at V3's finalized head B: the bundle must check out
 * offline (bridge.ts checkBundle), be the lock's, with B at or after the lock's block, signed by the
 * client's set and above its latest header. The account proof is left out once the minter is bound
 * (importAndMint reads it only to bind).
 */
export function headJob(b: MintBundleFixture, rec: LockRecord, client: ClientView, bound: boolean, minter: Hex): Job {
  const failed = checkBundle(b).filter(([ok]) => !ok);
  if (failed.length > 0) throw new CheckError(`the bundle does not check out: ${failed.map(([, what]) => what).join("; ")}`);
  const l = b.lock;
  const same =
    String(l.nonce) === rec.nonce &&
    l.recipient.toLowerCase() === rec.recipient &&
    l.amountNative === rec.amount &&
    l.commitment.toLowerCase() === rec.commitment &&
    l.dstChainId === rec.dstChainId &&
    l.dstMinter.toLowerCase() === minter;
  if (!same) throw new CheckError(`the bundle's lock ${l.nonce} (${l.amountNative} for ${l.recipient}, ${l.commitment}) is not lock ${rec.nonce} as its log gives it`);
  if (b.header.number < rec.block) throw new Moved(`the bundle's block #${n(b.header.number)} is below the lock's block #${n(rec.block)}: the V3 node is behind`);
  if (BigInt(b.provenance.setId) !== client.setId) throw new Moved(`the bundle's block #${n(b.header.number)} is signed by set ${b.provenance.setId}, and ${CLIENT_NAME} is at set ${client.setId}`);
  if (client.latestNumber >= b.header.number) throw new Moved(`${CLIENT_NAME} is at #${n(client.latestNumber)}, at or past the bundle's block #${n(b.header.number)}`);
  const p = bundleProof(b);
  const proof = bound ? { ...p, accountProof: [] } : p;
  return {
    lock: rec,
    path: "head",
    block: { number: b.header.number, hash: b.header.hash },
    to: minter,
    data: bytesToHex(importAndMintCalldata(hexToBytes(b.header.scale), hexToBytes(b.finalityProof.scale), hexToBytes(b.signers.hint), proof)),
    what: `importAndMint at V3's finalized #${n(b.header.number)}, signed by set ${b.provenance.setId} (${b.signers.count} of its ${b.signingSet.count} keys)`,
  };
}

// ---------------------------------------------------------------------------------------
// The send

/** The relayer's fees (sepolia.mjs feesAt): priority fee 1,000 wei unless given, max fee ten times the base fee plus it, at least 0.01 gwei, unless given. */
export function feesFor(base: bigint, o: { priorityFee?: bigint; maxFee?: bigint }): Fees {
  const tip = o.priorityFee ?? DEFAULT_TIP;
  const floor = 10n * base + tip;
  return { base, tip, maxFee: o.maxFee ?? (floor > MIN_MAX_FEE ? floor : MIN_MAX_FEE), gasPrice: base + tip };
}

/** The gas limit a transaction is sent with: its estimate + 10%, rounded up. */
export const gasLimitOf = (gas: number) => gas + Math.ceil(gas / 10);

const maxOf = (...xs: bigint[]) => xs.reduce((a, b) => (b > a ? b : a));

/**
 * The fees of a transaction that replaces our pending one at its nonce (relay.ts raised): the max
 * fee and the priority fee each at least 1/8 above the highest signed at that nonce (which nodes
 * require of a replacement) and at least the current ones; null when the max fee would pass `cap`.
 */
export function raisedFees(old: { maxFee: bigint; tip: bigint }, now: Fees, cap: bigint): Fees | null {
  const up = (x: bigint) => x + (x + 7n) / 8n;
  const tip = maxOf(up(old.tip), now.tip);
  const maxFee = maxOf(up(old.maxFee), now.maxFee, tip);
  return maxFee <= cap ? { ...now, tip, maxFee } : null;
}

/** The most a replacement offers per gas: --max-fee when given, else the max fee feesFor sets at a base fee of --max-base-fee (and at least the current one). */
export const replacementCap = (o: { maxFee?: bigint; maxBaseFee: bigint }, now: Fees): bigint => o.maxFee ?? maxOf(10n * o.maxBaseFee + now.tip, now.maxFee);

export type SendEnd =
  | { kind: "minted"; ours: boolean; txHash: Hex | null; why: string }
  | { kind: "wait"; why: string }
  | { kind: "failed"; why: string; txHash?: Hex }
  | { kind: "pending"; txHash: Hex };

export interface Ready {
  kind: "ready";
  gas: number;
  gasLimit: number;
  fees: Fees;
  /** The nonce it is signed at: the sender's next, mined and pending, or a replacement's; -1 when the sender was not checked (a dry run without --sender). */
  txNonce: number;
  balance: bigint | null;
}

/** Our transactions at one nonce, pending for --replace-after: the next mint planned replaces them at that nonce. */
export interface Stuck {
  txNonce: number;
  /** The highest max fee and priority fee signed at it. */
  maxFee: bigint;
  tip: bigint;
  /** Their hashes, in the order they were signed. */
  hashes: Hex[];
  /** When the last of them was signed (ms). */
  since: number;
}

export interface PreflightCtx {
  sepolia: SepoliaReads;
  sender: Hex;
  /** --max-spend (wei; none when left out) against `spent`, what our transactions mined over the last SPEND_WINDOW_MS cost. */
  fees: { priorityFee?: bigint; maxFee?: bigint; maxBaseFee: bigint; keep: bigint; maxSpend?: bigint };
  spent?: () => bigint;
}

/**
 * Everything checked before a send, in order: eth_call (NonceAlreadyUsed: minted already; a revert
 * that means the chains moved: wait), eth_estimateGas, the gas limit within the cap, the fees and
 * --max-base-fee (a replacement's raised above the stuck transactions', within replacementCap),
 * --max-spend against what was spent over the last day plus this send at the next base fee, then
 * with `checkSender` the balance against the gas limit at the max fee plus --keep and the sender's
 * nonce (nothing pending; for a replacement, the stuck nonce still the next one), and last a fresh
 * used(nonce).
 */
export async function preflight(job: Job, ctx: PreflightCtx, checkSender: boolean, replacing: Stuck | null = null): Promise<Ready | SendEnd> {
  const nonce = BigInt(job.lock.nonce);
  const call = await ctx.sepolia.call(ctx.sender, job.to, job.data);
  if (!call.ok) {
    if (isNonceUsed(call.revert, nonce)) return { kind: "minted", ours: false, txHash: null, why: `eth_call reverts NonceAlreadyUsed(${nonce}): minted already` };
    if (MOVED_REVERT.test(call.text)) return { kind: "wait", why: `the chains moved: eth_call reverts ${call.text}; a later round plans again` };
    return { kind: "failed", why: `eth_call reverts ${call.text}` };
  }
  let gas: number;
  try {
    gas = await ctx.sepolia.estimateGas(ctx.sender, job.to, job.data);
  } catch (error) {
    if (error instanceof AnswerError) return { kind: "failed", why: `eth_estimateGas: ${errorText(error)}` };
    throw error;
  }
  const gasLimit = gasLimitOf(gas);
  if (gasLimit > GAS_CAP) return { kind: "failed", why: `its gas ${n(gas)} + 10% is above Sepolia's ${n(GAS_CAP)} cap` };
  const base = await ctx.sepolia.nextBaseFee();
  let fees = feesFor(base, ctx.fees);
  if (fees.maxFee < fees.base || fees.maxFee < fees.tip) {
    return { kind: "failed", why: `the max fee ${n(fees.maxFee)} wei does not cover the next base fee ${n(base)} wei and the priority fee ${n(fees.tip)} wei` };
  }
  if (base > ctx.fees.maxBaseFee) return { kind: "wait", why: `the next base fee ${n(base)} wei is above --max-base-fee ${n(ctx.fees.maxBaseFee)} wei` };
  if (replacing) {
    const cap = replacementCap(ctx.fees, fees);
    const raised = raisedFees(replacing, fees, cap);
    if (!raised) {
      return {
        kind: "wait",
        why: `replacing nonce ${replacing.txNonce} needs a max fee above ${n(cap)} wei (--max-fee, or ten times --max-base-fee): not signed again, and nothing else is sent until it is mined`,
      };
    }
    fees = raised;
  }
  if (ctx.fees.maxSpend !== undefined) {
    const spent = ctx.spent?.() ?? 0n;
    const next = BigInt(gasLimit) * (fees.base + fees.tip);
    if (spent + next > ctx.fees.maxSpend) {
      return { kind: "wait", why: `our transactions of the last ${SPEND_WINDOW_MS / 3_600_000} hours cost ${eth(spent)}, and this one would cost about ${eth(next)}: above --max-spend ${eth(ctx.fees.maxSpend)}` };
    }
  }
  let balance: bigint | null = null;
  let txNonce = -1;
  if (checkSender) {
    balance = await ctx.sepolia.balance(ctx.sender);
    const need = BigInt(gasLimit) * fees.maxFee;
    if (need + ctx.fees.keep > balance) {
      return { kind: "wait", why: `the sender has ${eth(balance)}: the gas limit at the max fee is ${eth(need)}, and --keep ${eth(ctx.fees.keep)} stays` };
    }
    const nonces = await ctx.sepolia.nonces(ctx.sender);
    if (replacing) {
      // Only our stuck transaction may be pending, at the sender's next nonce: a replacement signs that nonce again.
      if (nonces.latest !== replacing.txNonce) {
        return { kind: "wait", why: `the sender's next nonce is ${nonces.latest}, not the stuck ${replacing.txNonce}: a transaction at it was mined meanwhile, and the next round settles it` };
      }
      if (nonces.pending > nonces.latest + 1) return { kind: "wait", why: `the sender has more pending than our stuck transaction (nonce ${nonces.latest}, pending ${nonces.pending}): nothing is signed again` };
      txNonce = replacing.txNonce;
    } else {
      if (nonces.pending !== nonces.latest) return { kind: "wait", why: `the sender has a pending transaction (nonce ${nonces.latest}, pending ${nonces.pending}): nothing is sent until it is mined` };
      txNonce = nonces.latest;
    }
  }
  if (await ctx.sepolia.used(nonce)) return { kind: "minted", ours: false, txHash: null, why: `used(${nonce}) turned true just before the send: minted by another transaction` };
  return { kind: "ready", gas, gasLimit, fees, txNonce, balance };
}

export interface SettleCtx {
  sepolia: SepoliaReads;
  minter: Hex;
  /** Appends a line to the history (fenced by the lock); a dry run prints it instead. */
  record: (line: HistoryLine) => void;
}

const resultOf = (a: AttemptLine, txHash: Hex | null, outcome: Outcome, why: string, mined?: Receipt): ResultLine => ({
  kind: "result",
  id: a.id,
  lock: a.lock,
  txHash,
  outcome,
  why,
  sepoliaBlock: mined ? Number(BigInt(mined.blockNumber)) : null,
  gasUsed: mined ? Number(BigInt(mined.gasUsed)) : null,
  effectiveGasPrice: mined?.effectiveGasPrice ? BigInt(mined.effectiveGasPrice).toString() : null,
  at: iso(),
});

/**
 * The result of a mined transaction: minted when it emitted Minted(nonce) for the attempt's
 * recipient and amount; reverted otherwise, already-minted when used(nonce) is true (another
 * transaction minted it first), its revert named by `replay` when given.
 */
export async function resultFromReceipt(a: AttemptLine, txHash: Hex, r: Receipt, ctx: SettleCtx, replay?: () => Promise<CallResult>): Promise<ResultLine> {
  const block = Number(BigInt(r.blockNumber));
  if (Number(BigInt(r.status)) === 1) {
    const log = r.logs.find((l) => l.address.toLowerCase() === ctx.minter && l.topics[0]?.toLowerCase() === MINTED_TOPIC && l.topics.length === 4 && BigInt(l.topics[1]) === BigInt(a.lock));
    if (log) {
      const m = decodeMinted(log);
      if (bytesToHex(m.recipient) === a.recipient && m.amount.toString() === a.amount) {
        return resultOf(a, txHash, "minted", `mined in Sepolia block ${n(block)}: Minted(${a.lock}) of ${formatWtpot(m.amount)} to ${short(a.recipient)}`, r);
      }
      return resultOf(a, txHash, "reverted", `mined in block ${n(block)}, but Minted names ${bytesToHex(m.recipient)} and ${m.amount}, not the attempt's`, r);
    }
    return resultOf(a, txHash, "reverted", `mined in block ${n(block)} with status 1, but without a Minted event of lock ${a.lock}`, r);
  }
  if (await ctx.sepolia.used(BigInt(a.lock))) return resultOf(a, txHash, "already-minted", `reverted in block ${n(block)}: used(${a.lock}) is true, another transaction minted it first`, r);
  const named = replay ? await replay().catch(() => null) : null;
  return resultOf(a, txHash, "reverted", `reverted in block ${n(block)}${named && !named.ok ? ` (replayed: ${named.text})` : ""}; used(${a.lock}) is still false`, r);
}

/**
 * Polls for a receipt of any of `hashes` (a transaction and those it replaces at its nonce, of which
 * at most one is mined) every `pollMs`, for at most `waitMs`; null when there is none by then (the
 * attempts stay open).
 */
export async function waitReceipt(s: Pick<SepoliaReads, "receipt">, hashes: Hex[], waitMs: number, pollMs: number): Promise<{ hash: Hex; receipt: Receipt } | null> {
  const until = Date.now() + waitMs;
  for (;;) {
    for (const hash of hashes) {
      const receipt = await s.receipt(hash).catch(() => null);
      if (receipt) return { hash, receipt };
    }
    if (Date.now() >= until) return null;
    await sleep(Math.min(pollMs, Math.max(0, until - Date.now())));
  }
}

export interface Settled {
  /** Our transaction still pending (or mined with its receipt not served yet): nothing else is sent until it is settled. */
  pending: Hex | null;
  /** Set when the pending transactions have waited --replace-after since the last of them was signed: the next mint planned signs their nonce again. */
  stuck: Stuck | null;
  results: ResultLine[];
}

/**
 * Settles the attempts an earlier round or process left without a result, before anything else is
 * sent, nonce by nonce: the attempts signed at one nonce (a transaction and those that replaced it)
 * are settled together, as at most one of them can be mined. One with no "signed" line never
 * reached cast publish (the hash is recorded first), so nothing was sent. Of those with a hash, the
 * one with a receipt is settled by it, and the others are replaced; while one is pending, nothing
 * else is sent (`pending`; `stuck` once the last was signed `replaceAfterMs` ago and none is mined);
 * when none is mined nor pending, all are dropped, and the nonce, when still free, is the next
 * send's, so no two of them can ever both be mined.
 */
export async function settle(open: OpenAttempt[], ctx: SettleCtx, replaceAfterMs = Infinity, now = Date.now()): Promise<Settled> {
  const results: ResultLine[] = [];
  const put = (line: ResultLine) => {
    ctx.record(line);
    results.push(line);
  };
  const byNonce = new Map<number, OpenAttempt[]>();
  for (const a of open) byNonce.set(a.attempt.txNonce, [...(byNonce.get(a.attempt.txNonce) ?? []), a]);
  for (const [txNonce, group] of byNonce) {
    for (const { attempt } of group.filter((a) => !a.signed)) put(resultOf(attempt, null, "not-sent", "no hash was recorded: the process stopped before cast publish, so nothing was sent"));
    const signed = group.flatMap((a) => (a.signed ? [{ attempt: a.attempt, signed: a.signed }] : []));
    if (signed.length === 0) continue;
    let mined: { attempt: AttemptLine; signed: SignedLine; receipt: Receipt } | null = null;
    for (const a of signed) {
      const receipt = await ctx.sepolia.receipt(a.signed.txHash);
      if (receipt) {
        mined = { ...a, receipt };
        break;
      }
    }
    if (mined) {
      put(await resultFromReceipt(mined.attempt, mined.signed.txHash, mined.receipt, ctx));
      for (const a of signed) {
        if (a.attempt.id !== mined.attempt.id) put(resultOf(a.attempt, a.signed.txHash, "replaced", `${mined.signed.txHash} was mined at nonce ${txNonce}: this transaction, signed at the same nonce, never can be`));
      }
      continue;
    }
    const known: { hash: Hex; mined: boolean }[] = [];
    for (const a of signed) {
      const tx = await ctx.sepolia.transaction(a.signed.txHash);
      if (tx) known.push({ hash: a.signed.txHash, mined: tx.blockNumber !== null });
    }
    if (known.length > 0) {
      const last = signed.at(-1)!;
      const since = Date.parse(last.signed.at);
      const waited = Number.isFinite(since) ? now - since : 0;
      const stuck =
        !known.some((k) => k.mined) && waited >= replaceAfterMs
          ? {
              txNonce,
              maxFee: maxOf(...signed.map((a) => BigInt(a.attempt.maxFee))),
              tip: maxOf(...signed.map((a) => BigInt(a.attempt.priorityFee))),
              hashes: signed.map((a) => a.signed.txHash),
              since,
            }
          : null;
      const shown = known.at(-1)!;
      log(
        `     ${shown.hash} (lock ${last.attempt.lock}, nonce ${txNonce}) is ${shown.mined ? "mined, its receipt not served yet" : `pending, signed ${Math.floor(waited / 60_000)} minutes ago`}: ` +
          (stuck ? "it waited --replace-after, so the next mint planned signs its nonce again, with higher fees" : "nothing else is sent until it is settled"),
      );
      return { pending: shown.hash, stuck, results };
    }
    const nonces = await ctx.sepolia.nonces(signed[0].attempt.sender);
    for (const a of signed) {
      put(
        resultOf(
          a.attempt,
          a.signed.txHash,
          "dropped",
          nonces.latest > txNonce
            ? `neither mined nor pending, and nonce ${txNonce} was used by another transaction (or mined longer ago than the RPC keeps receipts): used(${a.attempt.lock}) tells whether the lock is minted`
            : `neither mined nor pending: nonce ${txNonce} is free again, and the next send signs it`,
        ),
      );
    }
  }
  return { pending: null, stuck: null, results };
}

export interface SendCtx extends PreflightCtx, SettleCtx {
  signer: Signer;
  account: string;
  passwordFile: string;
  /** Throws Fatal unless this process still holds its locks and the key is no relayer's: checked right before each signing. */
  fence: () => void;
  receiptWaitMs: number;
  pollMs: number;
}

const endOf = (line: ResultLine): SendEnd => {
  switch (line.outcome) {
    case "minted":
      return { kind: "minted", ours: true, txHash: line.txHash, why: line.why };
    case "already-minted":
      return { kind: "minted", ours: false, txHash: line.txHash, why: line.why };
    case "reverted":
      return { kind: "failed", why: line.why, ...(line.txHash ? { txHash: line.txHash } : {}) };
    default:
      return { kind: "wait", why: line.why };
  }
};

/**
 * One send: preflight, then "attempt" recorded, cast mktx at the sender's next nonce (or, when
 * `replacing`, at the stuck transactions' nonce with raised fees), "signed" with the hash recorded,
 * used(nonce) read once more (true: the transaction is never broadcast, and its nonce stays free),
 * cast publish, the receipt waited for and "result" recorded. A signing that fails is Fatal (the
 * keystore or cast). Returns pending when no receipt has come within receiptWaitMs, or when one of
 * the transactions this one replaces was mined instead: a later round settles them.
 */
export async function sendJob(job: Job, ctx: SendCtx, replacing: Stuck | null = null): Promise<SendEnd> {
  const pf = await preflight(job, ctx, true, replacing);
  if (pf.kind !== "ready") return pf;
  if (replacing) log(`     signs nonce ${pf.txNonce} again, replacing ${replacing.hashes.join(", ")} (pending since ${iso(replacing.since)})`);
  // Built before anything is recorded: a command line cast could not take leaves no attempt behind.
  const args = mktxArgs(`lock ${job.lock.nonce}`, { to: job.to, data: job.data, nonce: pf.txNonce, gasLimit: pf.gasLimit, fees: pf.fees, account: ctx.account, passwordFile: ctx.passwordFile });
  args[args.indexOf("--rpc-url") + 1] = ctx.sepolia.publishUrl();
  const attempt: AttemptLine = {
    kind: "attempt",
    id: randomUUID(),
    lock: job.lock.nonce,
    path: job.path,
    block: job.block,
    to: job.to,
    dataHash: bytesToHex(keccak_256(hexToBytes(job.data))),
    sender: ctx.sender,
    txNonce: pf.txNonce,
    recipient: job.lock.recipient,
    amount: job.lock.amount,
    gas: pf.gas,
    gasLimit: pf.gasLimit,
    maxFee: pf.fees.maxFee.toString(),
    priorityFee: pf.fees.tip.toString(),
    at: iso(),
  };
  ctx.record(attempt);
  ctx.fence();
  const raw = ctx.signer.sign(args);
  if (!raw) {
    ctx.record(resultOf(attempt, null, "not-sent", "cast mktx could not sign"));
    throw new Fatal("cast mktx could not sign with the keystore: nothing more is sent");
  }
  const txHash = txHashOf(raw);
  ctx.record({ kind: "signed", id: attempt.id, lock: attempt.lock, txNonce: attempt.txNonce, txHash, at: iso() });
  log(`     signed ${txHash}: nonce ${pf.txNonce}, gas limit ${n(pf.gasLimit)} (estimate ${n(pf.gas)}), max fee ${n(pf.fees.maxFee)} wei, priority fee ${n(pf.fees.tip)} wei`);
  // Signing took a moment: a mint from the app may have landed meanwhile.
  const nonce = BigInt(job.lock.nonce);
  if (await ctx.sepolia.used(nonce)) {
    const why = `used(${nonce}) turned true after signing: ${txHash} was not broadcast, so it can never be mined, and nonce ${pf.txNonce} stays free`;
    ctx.record(resultOf(attempt, txHash, "not-sent", why));
    return { kind: "minted", ours: false, txHash: null, why };
  }
  ctx.signer.publish(raw, ctx.sepolia.publishUrl());
  const got = await waitReceipt(ctx.sepolia, [txHash, ...(replacing?.hashes ?? [])], ctx.receiptWaitMs, ctx.pollMs);
  if (!got) {
    log(`     ${txHash} has no receipt after ${Math.round(ctx.receiptWaitMs / 1000)} s: a later round settles it, and nothing else is sent until then`);
    return { kind: "pending", txHash };
  }
  if (got.hash !== txHash) {
    log(`     ${got.hash}, which ${txHash} replaces, was mined first: the next round settles both`);
    return { kind: "pending", txHash };
  }
  const receipt = got.receipt;
  const line = await resultFromReceipt(attempt, txHash, receipt, ctx, () => ctx.sepolia.call(ctx.sender, job.to, job.data, qty(BigInt(receipt.blockNumber))));
  ctx.record(line);
  return endOf(line);
}

// ---------------------------------------------------------------------------------------
// The scan

/** The vault's Locked logs from `from` to `to`, in windows of at most `window` blocks. */
export async function scanLocks(evm: Pick<HttpRpc, "call">, vault: Hex, from: number, to: number, window = LOG_WINDOW, topics: string[] = [LOCKED_TOPIC]): Promise<(LogJson & { removed?: boolean })[]> {
  const logs: (LogJson & { removed?: boolean })[] = [];
  for (const [a, z] of logWindows(from, to, window)) logs.push(...(await evm.call<LogJson[]>("eth_getLogs", [{ address: vault, topics, fromBlock: qty(a), toBlock: qty(z) }])));
  return logs;
}

/** The blocks a round reads: from the state's next block less SCAN_OVERLAP (not below its start block) to `finalized`; null when there is nothing new. */
export function scanRange(state: Pick<State, "startBlock" | "nextBlock">, finalized: number): [number, number] | null {
  if (finalized < state.nextBlock) return null;
  return [Math.max(state.startBlock, state.nextBlock - SCAN_OVERLAP), finalized];
}

/**
 * Adds the locks of `logs` to the state: a new nonce as pending (or skipped, with why); a nonce seen
 * already, with the same block and commitment, changes nothing; one whose log disagrees with the
 * record is left to the operator (skipped, and returned as a conflict).
 */
export function absorbLogs(state: State, logs: (LogJson & { removed?: boolean })[], bridge: Pick<Bridge, "vault" | "v3ChainId" | "chainId" | "minter">, now = Date.now()) {
  const added: LockRecord[] = [];
  const conflicts: string[] = [];
  let ignored = 0;
  for (const log of logs) {
    const p = parseLockedLog(log, bridge);
    if (p.kind === "ignore") {
      ignored += 1;
      continue;
    }
    const key = p.lock.nonce.toString();
    const known = state.locks[key];
    if (!known) {
      state.locks[key] = recordOf(p, now);
      added.push(state.locks[key]);
      continue;
    }
    if (known.block !== p.lock.block || known.commitment !== p.lock.commitment) {
      const why = `two Locked logs of nonce ${key} disagree (#${n(known.block)} ${known.commitment}, #${n(p.lock.block)} ${p.lock.commitment}): left to the operator`;
      conflicts.push(why);
      if (known.status === "pending") {
        known.status = "skipped";
        known.why = why;
      }
    }
  }
  return { added, conflicts, ignored };
}

// ---------------------------------------------------------------------------------------
// A round

/** Everything a round works with. */
export interface Run {
  o: Options;
  bridge: Bridge;
  sender: Hex;
  files: Files;
  state: State;
  sepolia: SepoliaChain;
  evm: HttpRpc;
  /** With --send, the minter's lock and the sender's (none in a dry run). */
  locks: Lock[];
  signer: Signer;
  errors: Map<Hex, string>;
  /** Checked once per process: the chain ids, the minter's wiring, the V3 node's genesis. */
  wired: boolean;
  genesisChecked: boolean;
  /** Nonces below the scan's start whose lock was looked up, once per process. */
  accounted: Set<string>;
}

interface RoundFacts {
  v3: { finalized: number; hash: Hex; setId: bigint };
  client: ClientView;
  minter: { bound: boolean; trieId: Hex };
}

const fence = (run: Run) => {
  for (const lock of run.locks) {
    if (!stillHeld(lock)) throw new Fatal(`${lock.path} no longer holds this process's token: another auto-mint took the lock over, and nothing more is signed or written`);
  }
};

/** Right before each signing too: a relayer started with this key since would sign at the same nonces. */
const guardKey = (run: Run) => {
  const problem = relayerKeyProblem(keyDirsOf(run.o.stateDir), run.sender);
  if (problem) throw new Fatal(`${problem}: nothing more is signed`);
};

function save(run: Run): void {
  if (!run.o.send) return;
  fence(run);
  try {
    saveState(run.files.state, run.state);
  } catch (error) {
    throw new Fatal(`${run.files.state} could not be written: ${errorText(error)}`);
  }
}

function record(run: Run, line: HistoryLine): void {
  if (!run.o.send) {
    if (line.kind === "result") log(`     (dry run: the history would get ${line.outcome} for attempt ${line.id}${line.txHash ? `, ${line.txHash}` : ""})`);
    return;
  }
  fence(run);
  try {
    appendLine(run.files.history, line);
  } catch (error) {
    throw new Fatal(`${run.files.history} could not be written: ${errorText(error)}`);
  }
}

const labelOf = (r: LockRecord) => `lock ${r.nonce} (#${n(r.block)}, ${formatTpot(BigInt(r.amount))} for ${short(r.recipient)})`;

/** The state's record of a lock now minted: by our transaction, or another. */
function markMinted(rec: LockRecord, why: string, ours: Hex | null): void {
  rec.status = "minted";
  rec.why = why;
  if (ours) rec.mintTx = ours;
  rec.doneAt = iso();
}

function applyResult(run: Run, line: ResultLine): void {
  const rec = run.state.locks[line.lock];
  if (!rec) return;
  if (line.outcome === "minted") markMinted(rec, line.why, line.txHash);
  else if (line.outcome === "already-minted") markMinted(rec, line.why, null);
}

/** Checked once: the RPCs serve Sepolia and V3, and the minter takes the recorded light client and vault. */
async function checkWiring(run: Run): Promise<void> {
  const sepoliaId = await run.sepolia.chainId();
  const v3Id = BigInt(await run.evm.call<string>("eth_chainId", []));
  const m = await run.sepolia.minter();
  const ok = sepoliaId === run.bridge.chainId && v3Id === run.bridge.v3ChainId && m.lightClient === run.bridge.client && m.vault === run.bridge.vault && m.vaultChainId === run.bridge.v3ChainId;
  const what =
    `Sepolia's RPC serves chain ${sepoliaId}, V3's EVM RPC chain ${v3Id}; BridgeMinter ${short(run.bridge.minter)} takes the light client ${short(m.lightClient)} ` +
    `and the vault ${short(m.vault)} of chain ${m.vaultChainId}, as deployments/ records`;
  if (!check(ok, what)) throw new Fatal("the chains or the minter are not the ones deployments/ records");
  const sender = run.o.send ? run.sender : run.o.sender;
  if (!run.o.send && sender !== undefined) {
    // A --send run refuses a relayer's key before its first round; a dry run of --sender says so.
    const problem = relayerKeyProblem(keyDirsOf(run.o.stateDir), sender);
    if (problem) check(false, `${problem} (a --send run refuses it)`);
  }
  if (sender !== undefined && (await run.sepolia.admin()) === sender) {
    // Its emergency pause would share a nonce sequence with the mints, and its key would stay unlocked in an always-on process.
    const why = `the sender ${sender} is the admin of ${CLIENT_NAME}, which can pause and reinitialize it: auto-mint needs a key of its own`;
    if (run.o.send) throw new Fatal(why);
    check(false, `${why} (a --send run refuses it)`);
  }
}

async function v3Head(chain: Chain): Promise<{ finalized: number; hash: Hex; setId: bigint }> {
  const hash = (await chain.rpc.request<Hex>("chain_getFinalizedHead")).toLowerCase() as Hex;
  const header = await chain.header(hash);
  const scale = await chain.storage(SET_ID_KEY, hash);
  if (!scale) throw new Error("Grandpa.CurrentSetId is empty at V3's finalized head");
  return { finalized: header.number, hash, setId: decodeU64(scale, "Grandpa.CurrentSetId") };
}

async function readFacts(run: Run, chain: Chain): Promise<RoundFacts> {
  if (!run.genesisChecked) {
    const genesis = (await v3("genesis", () => chain.rpc.request<Hex>("chain_getBlockHash", [0]))).toLowerCase();
    if (genesis !== run.bridge.v3Genesis) throw new Fatal(`the V3 node serves genesis ${genesis}, not the V3 testnet's ${run.bridge.v3Genesis}`);
    run.genesisChecked = true;
  }
  const head = await v3("V3's finalized head", () => v3Head(chain));
  const client = await run.sepolia.client();
  const m = await run.sepolia.minter();
  log(
    `     V3 finalized #${n(head.finalized)} (set ${head.setId}); ${CLIENT_NAME} at set ${client.setId}, latest #${n(client.latestNumber)}` +
      `${client.halted ? ", HALTED" : ""}${client.paused ? ", PAUSED" : ""}; the minter ${m.bound ? "is bound to the vault" : "is not bound"}`,
  );
  return { v3: head, client, minter: { bound: m.bound, trieId: m.trieId } };
}

/** The job of `path`, or null (printed) when it cannot be built now; a held path the node cannot serve falls back to the head path when that applies. */
async function buildJob(run: Run, chain: Chain, rec: LockRecord, path: Path, f: RoundFacts): Promise<Job | null> {
  const headApplies = !f.client.halted && !f.client.paused && f.v3.setId === f.client.setId && f.client.latestNumber < f.v3.finalized;
  if (path === "held") {
    try {
      return await heldJob(chain, run.sepolia, rec, f.client, f.minter.trieId, run.bridge.minter);
    } catch (error) {
      if (error instanceof Unreachable || error instanceof Fatal || error instanceof DryRunViolation) throw error;
      if (error instanceof CheckError) {
        check(false, `${labelOf(rec)}: the held path at #${n(f.client.latestNumber)}: ${errorText(error)}`);
        return null;
      }
      log(`     the held path at #${n(f.client.latestNumber)} is not available (${errorText(error)})${headApplies ? "; the head path instead" : ""}`);
      if (!headApplies) return null;
    }
  }
  try {
    const b = await withDeadline(captureBundle({ rpc: run.o.rpc, evm: run.o.evm }, BigInt(rec.nonce)), TIMEOUTS.captureMs, `the capture of lock ${rec.nonce}'s bundle`);
    return headJob(b, rec, f.client, f.minter.bound, run.bridge.minter);
  } catch (error) {
    if (error instanceof Unreachable || error instanceof Fatal || error instanceof DryRunViolation) throw error;
    // mint.ts's own Unreachable: the V3 node did not answer the capture.
    if (error instanceof Error && error.name === "Unreachable") throw new Unreachable(error.message);
    if (error instanceof CheckError) check(false, `${labelOf(rec)}: the head path: ${errorText(error)}`);
    else log(`     the head path is not ready (${errorText(error)}): a later round tries again`);
    return null;
  }
}

/** A dry run of a job: preflight without sending, printed. */
async function dryRunJob(run: Run, job: Job, replacing: Stuck | null): Promise<void> {
  const pf = await preflight(job, sendCtx(run), run.o.sender !== undefined, replacing);
  if (pf.kind === "ready") {
    const cost = BigInt(pf.gasLimit) * pf.fees.maxFee;
    check(
      true,
      `${labelOf(job.lock)}: a --send run would send ${job.what}${replacing ? `, replacing ${replacing.hashes.join(", ")} at nonce ${replacing.txNonce}` : ""}: gas ${n(pf.gas)}, limit ${n(pf.gasLimit)}; ` +
        `next base fee ${n(pf.fees.base)} wei, max fee ${n(pf.fees.maxFee)} wei, at most ${eth(cost)}` +
        `${pf.balance === null ? " (the sender's balance and nonce are checked with --sender)" : `; the sender has ${eth(pf.balance)}, nonce ${pf.txNonce}`}`,
    );
    return;
  }
  if (pf.kind === "minted") log(`${labelOf(job.lock)}: minted already: ${pf.why}`);
  else if (pf.kind === "failed") check(false, `${labelOf(job.lock)}: ${job.what}: ${pf.why}`);
  else if (pf.kind === "wait") log(`${labelOf(job.lock)}: ${job.what}: a --send run would wait: ${pf.why}`);
}

function sendCtx(run: Run): SendCtx {
  return {
    sepolia: run.sepolia,
    sender: run.sender,
    minter: run.bridge.minter,
    fees: { priorityFee: run.o.priorityFee, maxFee: run.o.maxFee, maxBaseFee: run.o.maxBaseFee, keep: run.o.keep, maxSpend: run.o.maxSpend },
    spent: () => spentSince(readHistory(run.files.history).lines, Date.now() - SPEND_WINDOW_MS),
    record: (line) => record(run, line),
    signer: run.signer,
    account: run.o.account ?? "",
    passwordFile: run.o.passwordFile ?? "",
    fence: () => {
      fence(run);
      guardKey(run);
    },
    receiptWaitMs: TIMEOUTS.receiptMs,
    pollMs: TIMEOUTS.receiptPollMs,
  };
}

/**
 * The vault's nextNonce at `evmFinal` (the block the scan read up to, so every lock it counts is in
 * a final block) against the locks in the state. A nonce the state lacks is looked up by its Locked
 * log (in LOG_WINDOW windows from the vault's block): at or above the scan's start, the scan missed
 * it (the RPC's log index lagged more than SCAN_OVERLAP blocks), and it is taken in now, with a
 * WARN; below the start, once per process, it is printed, minted or not (a lock not minted there is
 * left to --from, never minted unseen); one no lookup finds is a WARN, looked up again next round.
 */
export async function accountForNonces(run: Run, evmFinal: number): Promise<void> {
  const next = BigInt(await run.evm.call<string>("eth_getStorageAt", [run.bridge.vault, qty(SLOTS.nextNonce), qty(evmFinal)]));
  let below = 0;
  for (let i = 0n; i < next; i++) {
    const key = i.toString();
    if (run.state.locks[key] || run.accounted.has(key)) continue;
    const logs = await scanLocks(run.evm, run.bridge.vault, run.bridge.vaultBlock, evmFinal, LOG_WINDOW, [LOCKED_TOPIC, bytesToHex(uintWord(i))]);
    const p = logs.map((l) => parseLockedLog(l, run.bridge)).find((x) => x.kind !== "ignore");
    if (!p) {
      log(`WARN the vault's nextNonce at V3 #${n(evmFinal)}, a final block, counts lock ${key}, but V3's EVM RPC returns no Locked log of it: looked up again next round`);
      continue;
    }
    if (p.lock.block >= run.state.startBlock) {
      const a = absorbLogs(run.state, logs, run.bridge);
      for (const r of a.added) log(`WARN the scan missed ${labelOf(r)} (the RPC's log index lagged?): taken in now${r.status === "skipped" ? `, skipped, never minted: ${r.why}` : ""}`);
      for (const c of a.conflicts) check(false, c);
      save(run);
      continue;
    }
    run.accounted.add(key);
    below += 1;
    const minted = p.kind === "lock" && (await run.sepolia.used(i));
    log(
      p.kind === "skip"
        ? `     lock ${key} (#${n(p.lock.block)}, below the scan's start #${n(run.state.startBlock)}) is not for this minter: ${p.why}`
        : minted
          ? `     lock ${key} (#${n(p.lock.block)}, below the scan's start #${n(run.state.startBlock)}): minted already`
          : `WARN lock ${key} (#${n(p.lock.block)}) is below the scan's start #${n(run.state.startBlock)} and not minted: auto-mint leaves it; run once with --from ${p.lock.block} to take it in`,
    );
  }
  const seen = Object.keys(run.state.locks).length;
  if (run.o.watch === undefined || below > 0) log(`     the vault's nextNonce at V3 #${n(evmFinal)} is ${next}: ${seen} lock${seen === 1 ? "" : "s"} in the state${below > 0 ? `, ${below} below the scan's start` : ""}`);
}

/** --rehearse: the mint of a lock that is minted already, on each path that applies now; each eth_call must revert NonceAlreadyUsed(nonce). */
async function rehearse(run: Run, chain: Chain, f: RoundFacts, nonce: bigint, evmFinal: number): Promise<void> {
  const key = nonce.toString();
  let rec = run.state.locks[key];
  if (!rec) {
    const logs = await scanLocks(run.evm, run.bridge.vault, run.bridge.vaultBlock, evmFinal, LOG_WINDOW, [LOCKED_TOPIC, bytesToHex(uintWord(nonce))]);
    const p = logs.map((l) => parseLockedLog(l, run.bridge)).find((x) => x.kind === "lock");
    if (!p || p.kind !== "lock") {
      check(false, `rehearsal: no final Locked log of lock ${key} for this minter`);
      return;
    }
    rec = recordOf(p);
  }
  log(`\nRehearsal of ${labelOf(rec)}:`);
  if (!check(await run.sepolia.used(nonce), `used(${key}) is true: the lock is minted already, as a rehearsal needs (it can only revert)`)) return;
  const paths: Path[] = [];
  if (f.client.latestNumber >= rec.block) paths.push("held");
  if (!f.client.halted && !f.client.paused && f.v3.setId === f.client.setId && f.client.latestNumber < f.v3.finalized) paths.push("head");
  if (!check(paths.length > 0, `a path applies now (held: the client holds #${n(f.client.latestNumber)}; head: client set ${f.client.setId}, V3 set ${f.v3.setId})`)) return;
  for (const path of paths) {
    let job: Job;
    try {
      job =
        path === "held"
          ? await heldJob(chain, run.sepolia, rec, f.client, f.minter.trieId, run.bridge.minter)
          : headJob(
              await withDeadline(captureBundle({ rpc: run.o.rpc, evm: run.o.evm }, nonce), TIMEOUTS.captureMs, `the capture of lock ${key}'s bundle`),
              rec,
              f.client,
              f.minter.bound,
              run.bridge.minter,
            );
    } catch (error) {
      if (error instanceof Unreachable || error instanceof Fatal || error instanceof DryRunViolation) throw error;
      check(false, `${path}: ${errorText(error)}`);
      continue;
    }
    const r = await run.sepolia.call(DRY_RUN_SENDER, job.to, job.data);
    check(
      !r.ok && isNonceUsed(r.revert, nonce),
      `${path}: ${job.what}, ${n((job.data.length - 2) / 2)} bytes of calldata: eth_call reverts ${r.ok ? "nothing: it would mint again!" : r.text}` +
        `${!r.ok && isNonceUsed(r.revert, nonce) ? ", which the minter checks after the header, the proofs and the commitment" : ""}`,
    );
  }
}

/** One round (see the header). Unreachable ends it with code 2 and `trouble`; Fatal propagates. */
export async function round(run: Run): Promise<{ code: number; trouble: boolean }> {
  failures = 0;
  const { o, state } = run;
  log(`\n${iso()}: auto-mint round${o.send ? "" : " (dry run)"}, sender ${run.sender}`);
  let chain: Chain | null = null;
  let pendingTx: Hex | null = null;
  /** Our pending transactions past --replace-after: the next mint planned signs their nonce again (once a round). */
  let stuck: Stuck | null = null;
  try {
    if (!run.wired) {
      await checkWiring(run);
      run.wired = true;
    }

    // 1. What an earlier round left open.
    const history = readHistory(run.files.history);
    if (history.bad > 0) log(`     note: ${history.bad} line${history.bad === 1 ? "" : "s"} of ${run.files.history} do not parse (cut by a crash?): left as they are`);
    const open = openAttempts(history.lines);
    if (open.length > 0) {
      log(`     ${open.length} attempt${open.length === 1 ? "" : "s"} of ${run.files.history} without a result: settled first`);
      const s = await settle(open, sendCtx(run), o.replaceAfterMs);
      for (const line of s.results) {
        log(`     attempt ${line.id} (lock ${line.lock}): ${line.outcome}: ${line.why}`);
        applyResult(run, line);
        history.lines.push(line);
      }
      pendingTx = s.pending;
      stuck = s.stuck;
      save(run);
    }

    // 2. The locks. A round with --watch prints only what changed; a single round prints every lock.
    const once = o.watch === undefined;
    const evmFinal = Number(BigInt((await run.evm.call<{ number: string }>("eth_getBlockByNumber", ["finalized", false])).number));
    const range = scanRange(state, evmFinal);
    if (range) {
      const logs = await scanLocks(run.evm, run.bridge.vault, range[0], range[1]);
      const a = absorbLogs(state, logs, run.bridge);
      state.nextBlock = evmFinal + 1;
      if (once || a.added.length > 0) {
        log(`     scanned V3 #${n(range[0])} to #${n(range[1])} (the EVM RPC's finalized block): ${logs.length} Locked log${logs.length === 1 ? "" : "s"}, ${a.added.length} new lock${a.added.length === 1 ? "" : "s"}`);
      }
      for (const r of a.added) log(`     new ${labelOf(r)}${r.status === "skipped" ? `: skipped, never minted: ${r.why}` : ""}`);
      for (const c of a.conflicts) check(false, c);
      save(run);
    }
    try {
      await accountForNonces(run, evmFinal);
    } catch (error) {
      // A check of the scan, not a step of the mint: the locks in the state are planned anyway.
      if (error instanceof Fatal || error instanceof DryRunViolation) throw error;
      log(`WARN the vault's nonces were not checked against the state in this round (${errorText(error)}): a later round checks them`);
    }

    // 3. Each lock not minted yet.
    const byNonce = (x: LockRecord, y: LockRecord) => (BigInt(x.nonce) < BigInt(y.nonce) ? -1 : 1);
    const pending = Object.values(state.locks).filter((r) => r.status === "pending").sort(byNonce);
    if (once) for (const r of Object.values(state.locks).sort(byNonce)) if (r.status !== "pending") log(`${labelOf(r)}: ${r.status}${r.why ? `: ${r.why}` : ""}`);
    if (pending.length === 0 && o.rehearse === undefined) {
      if (once) log(`     nothing to mint${pendingTx ? `; ${pendingTx} is still pending` : ""}`);
      return { code: failures > 0 ? FAILED : pendingTx ? PENDING : OK, trouble: false };
    }
    chain = await openV3(o.rpc);
    let facts = await readFacts(run, chain);
    for (const rec of pending) {
      const nonce = BigInt(rec.nonce);
      const used = await run.sepolia.used(nonce);
      const now = Date.now();
      if (!used && rec.block <= facts.v3.finalized && !rec.finalSeenAt) rec.finalSeenAt = iso(now);
      const d = decide(rec, {
        now,
        graceMs: o.graceMs,
        v3Finalized: facts.v3.finalized,
        v3SetId: facts.v3.setId,
        client: facts.client,
        used,
        failedSends: failedSendsOf(history.lines, rec.nonce),
        minAmount: o.minAmount,
      });
      if (d.kind === "minted") {
        const ours = history.lines.find((l): l is ResultLine => l.kind === "result" && l.lock === rec.nonce && l.outcome === "minted")?.txHash ?? null;
        markMinted(rec, ours ? `minted by our ${ours}` : `${d.why}, by another transaction`, ours);
        log(`${labelOf(rec)}: ${rec.why}`);
        save(run);
        continue;
      }
      if (d.kind === "skip") {
        rec.status = "skipped";
        rec.why = d.why;
        if (d.left) rec.left = d.left;
        // Below --min-amount is the rule doing its work; failed sends need the operator.
        if (d.left === "min-amount") log(`${labelOf(rec)}: skipped: ${d.why}`);
        else check(false, `${labelOf(rec)}: ${d.why}`);
        save(run);
        continue;
      }
      if (d.kind === "wait") {
        log(`${labelOf(rec)}: waits: ${d.why}`);
        continue;
      }
      log(`${labelOf(rec)}: ${d.path} path: ${d.why}`);
      if (pendingTx && !stuck) {
        log(`     our ${pendingTx} is still pending: nothing else is sent until it is settled`);
        continue;
      }
      // While our transaction is pending, only a replacement at its nonce is sent, once a round.
      const replacing = pendingTx ? stuck : null;
      const job = await buildJob(run, chain, rec, d.path, facts);
      if (!job) continue;
      stuck = null;
      if (!o.send) {
        await dryRunJob(run, job, replacing);
        continue;
      }
      save(run);
      const end = await sendJob(job, sendCtx(run), replacing);
      if (end.kind === "minted") {
        markMinted(rec, end.ours ? `minted by our ${end.txHash}: ${end.why}` : end.why, end.ours ? end.txHash : null);
        check(true, `${labelOf(rec)}: ${rec.why}`);
      } else if (end.kind === "pending") pendingTx = end.txHash;
      else if (end.kind === "failed") check(false, `${labelOf(rec)}: ${job.what}: ${end.why}`);
      else log(`${labelOf(rec)}: waits: ${end.why}`);
      // A replacement mined (minted or reverted) used the stuck nonce: what it replaced never can be mined.
      if (replacing && ((end.kind === "minted" && end.ours) || (end.kind === "failed" && end.txHash))) pendingTx = null;
      save(run);
      // A transaction sent moves the client (an import) or the sender's nonce: the next lock is planned on fresh facts.
      const sent = end.kind === "pending" || ((end.kind === "minted" || end.kind === "failed") && !!end.txHash);
      if (sent) facts = await readFacts(run, chain);
    }
    if (o.rehearse !== undefined) await rehearse(run, chain, facts, o.rehearse, evmFinal);
    save(run);
    return { code: failures > 0 ? FAILED : pendingTx ? PENDING : OK, trouble: false };
  } catch (error) {
    if (error instanceof Fatal || error instanceof DryRunViolation) throw error;
    try {
      save(run);
    } catch (saving) {
      if (saving instanceof Fatal) throw saving;
    }
    if (error instanceof Unreachable) {
      log(errorText(error));
      return { code: UNREACHABLE, trouble: true };
    }
    check(false, errorText(error));
    return { code: FAILED, trouble: false };
  } finally {
    await chain?.rpc.close();
  }
}

/** The wait before the next round: --watch, doubled after each round in a row that could not reach a node, up to MAX_BACKOFF_SECONDS (or --watch when longer). */
export function nextWait(watch: number, previous: number, trouble: boolean): number {
  if (!trouble) return watch;
  return Math.min(Math.max(2 * previous, watch), Math.max(watch, MAX_BACKOFF_SECONDS));
}

/**
 * The locks at `paths` (the minter's, then the sender's: watch.ts takeLock, holder "auto-mint"),
 * all or none. While another live process holds one, null without `watchSeconds`; with it, they are
 * asked for again every `watchSeconds`: watch.ts takes a lock over once its process is gone or it
 * was not refreshed for 10 minutes, so a process the logon task starts right after a crash (whose
 * lock may name a process id Windows has given again) waits for it instead of ending.
 */
export async function holdLocks(paths: string[], watchSeconds?: number, wait: (ms: number) => Promise<void> = sleep): Promise<Lock[] | null> {
  for (;;) {
    const held: Lock[] = [];
    for (const path of paths) {
      const lock = takeLock(path, log, LOCK_STALE, "auto-mint");
      if (!lock) break;
      held.push(lock);
    }
    if (held.length === paths.length) return held;
    for (const lock of held.reverse()) lock.release();
    if (watchSeconds === undefined) return null;
    log(`     asked for again in ${watchSeconds} s (a lock a crash left is taken over once its process is gone, or 10 minutes after it was last refreshed)`);
    await wait(watchSeconds * 1000);
  }
}

/**
 * --retry: lock `nonce`, left to the operator (its failed sends, or --min-amount), is pending
 * again, and its failed sends so far no longer count (a "reset" line in the history). A lock
 * skipped for another reason (another chain or minter, a commitment its fields do not give, logs
 * that disagree) is never minted: refused. False, printed, when refused.
 */
export function retryLock(run: Run, nonce: bigint): boolean {
  const key = nonce.toString();
  const rec = run.state.locks[key];
  if (!rec) return check(false, `--retry ${key}: lock ${key} is not in the state (one below the scan's start is taken in by a run with --from <its V3 block>)`);
  if (rec.status !== "skipped") {
    log(`     --retry ${key}: ${labelOf(rec)} is ${rec.status}: nothing to take in again`);
    return true;
  }
  if (!rec.left) return check(false, `--retry ${key}: ${labelOf(rec)} was skipped because ${rec.why ?? "of what its log gives"}, and such a lock is never minted`);
  record(run, { kind: "reset", id: randomUUID(), lock: key, why: `--retry: it was left to the operator: ${rec.why ?? rec.left}`, at: iso() });
  rec.status = "pending";
  delete rec.why;
  delete rec.left;
  save(run);
  log(`     --retry ${key}: ${labelOf(rec)} is pending again; its failed sends so far no longer count`);
  return true;
}

/** The auto-mint: one round, or with --watch one round after another. automint-main.ts runs it (npm run automint). */
export async function main(argv = process.argv.slice(2)): Promise<number> {
  let o: Options;
  try {
    o = parseOptions(argv);
  } catch (error) {
    if (error instanceof Usage) {
      log(`${error.message}\n${USAGE}`);
      return FAILED;
    }
    throw error;
  }
  // Every RPC client of this process refuses the write methods: cast signs and publishes, in a process of its own.
  installDryRunGuard();
  log(
    `${iso()}: auto-mint of wtPOT on Sepolia for the locks in the vault on V3` +
      (o.send ? ", with --send" : " (dry run: nothing is signed, and this process's RPC clients refuse eth_send*, eth_sign*, personal_* and author_submit*)"),
  );
  const bridge = readBridge();
  let sender: Hex;
  if (o.send) {
    const unlocked = keystoreAddress(o.account!, o.passwordFile!);
    if (!unlocked) return FAILED;
    sender = unlocked.toLowerCase() as Hex;
  } else sender = o.sender ?? DRY_RUN_SENDER;
  const files = filesOf(o.stateDir, sender);
  log(
    `     vault ${short(bridge.vault)} on V3 to BridgeMinter ${short(bridge.minter)} on Sepolia (${CLIENT_NAME} ${short(bridge.client)}); ` +
      `sender ${checksumAddress(hexToBytes(sender))}${o.send ? ` (keystore ${o.account})` : o.sender ? " (--sender)" : " (no one's: --sender checks a key's balance and nonce)"}; ` +
      `--grace ${o.graceMs / 1000} s, --keep ${eth(o.keep)}, --max-base-fee ${n(o.maxBaseFee)} wei, --replace-after ${o.replaceAfterMs / 60_000} min, ` +
      `--min-amount ${formatTpot(o.minAmount)}, --max-spend ${eth(o.maxSpend)} a day`,
  );
  let locks: Lock[] = [];
  if (o.send) {
    const problem = relayerKeyProblem(keyDirsOf(o.stateDir), sender);
    if (problem) {
      check(false, problem);
      return FAILED;
    }
    try {
      for (const dir of new Set([o.stateDir, STATE_DIR])) mkdirSync(dir, { recursive: true });
    } catch (error) {
      check(false, `the state directory ${o.stateDir} cannot be created: ${errorText(error)}`);
      return FAILED;
    }
    const held = await holdLocks([minterLockOf(bridge.minter), files.lock], o.watch);
    if (!held) {
      check(false, `${minterLockOf(bridge.minter)} or ${files.lock} is held by another process: one auto-mint per minter, with any key or state directory`);
      return FAILED;
    }
    locks = held;
  }
  try {
    const start = Math.max(bridge.vaultBlock, o.from ?? DEFAULT_START_BLOCK);
    const loaded = loadState(files.state, bridge, sender, start, o.send);
    log(`     ${loaded.note}`);
    const state = loaded.state;
    if (o.from !== undefined && state.nextBlock !== start) {
      log(`     --from: the scan starts at V3 #${n(start)} (the state had #${n(state.nextBlock)})`);
      state.nextBlock = start;
      state.startBlock = Math.min(state.startBlock, start);
    }
    const errors = errorMap(BRIDGE_ERRORS);
    const run: Run = {
      o,
      bridge,
      sender,
      files,
      state,
      sepolia: new SepoliaChain(new HttpRpc("Sepolia's RPC", sepoliaRpcs(), TIMEOUTS.sepoliaMs), bridge, errors),
      evm: new HttpRpc("V3's EVM RPC", [o.evm], TIMEOUTS.evmMs),
      locks,
      signer: castSigner,
      errors,
      wired: false,
      genesisChecked: false,
      accounted: new Set(),
    };
    save(run);
    if (o.retry !== undefined && !retryLock(run, o.retry)) return FAILED;
    let wait = o.watch ?? 0;
    for (;;) {
      const r = await round(run);
      if (o.watch === undefined) {
        log(o.send ? "" : "\nThe dry run is over. Nothing was signed or sent.");
        return r.code;
      }
      wait = nextWait(o.watch, wait, r.trouble);
      log(`\nNext round in ${wait} s, at ${iso(Date.now() + wait * 1000)}.`);
      await sleep(wait * 1000);
    }
  } finally {
    for (const lock of locks.reverse()) lock.release();
  }
}
