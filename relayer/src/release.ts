// The return-path tool (trusted): a burn of wtPOT on Sepolia through BridgeMinter.burn, and its
// release of tPOT from PortaldotVault on the Portaldot V3 testnet by the committee's 2-of-3
// pallet-multisig account. No contract checks the release against the burn: the committee does.
//
//   npm run release -- burn --amount <wtPOT> --v3-recipient <h160> [--from <address>]
//   npm run release -- burn --amount <wtPOT> --v3-recipient <h160> --send --account <keystore> --password-file <path>
//   npm run release -- release --burn-nonce <n> [--to <h160>]
//   npm run release -- release --burn-nonce <n> --rehearse --amount <wtPOT> --to <h160> [--approve --member <1|2|3>]
//   npm run release -- release --burn-nonce <n> --approve --member <1|2|3> [--send --key-file <member json> --password-file <path>]
//   npm run release -- release --burn-nonce <n> --cancel --member <1|2|3> [--send --key-file <member json> --password-file <path>]
//   npm run release -- release --watch <seconds> [--rounds <n>] [--state-dir <path>]
//   npm run release -- release --watch <seconds> --send --member-keys <k>:<member json>,<j>:<member json> --password-file <path>
//   npm run release -- fund --member <1|2|3> | --multisig --amount <tPOT> [--from <ss58>] [--send --key-file <path>]
//   npm run release -- status
//   fast mode, for release and release --watch: --confirmations <n> (1 to 64) [--fast-cap <tPOT>] [--fast-budget <tPOT>, --watch]
//   more options: --rpc <wss url> (the V3 node), --evm <http(s) url> (its EVM RPC), --priority-fee
//   <gwei> and --max-fee <gwei> (burn)
//
// burn dry-runs BridgeMinter.burn(amount, v3Recipient) on Sepolia with eth_simulateV1, validation
// on, from the sender (--from, by default the deployer 0xD983…1071) at its nonce and with its
// balances, first with the 16,777,216 cap as gas limit, then with the gas + 10% it is sent with, as
// mint.ts runs its plan. It refuses a sender whose wtPOT balance is below the amount, and a
// v3Recipient nobody is shown to control on V3 (committee.ts payeeVerdict: the committee would
// refuse to release to it, and the burn cannot be undone). It checks the BurnRequested event (the
// next burn nonce, the sender, the recipient, the amount) and its burn id, which must be
// burnIdOf(nonce) and the vault's convention keccak256(abi.encode(keccak256("BridgeZero.Burn.v1"),
// 11155111, minter, nonce)) (vault.ts burnId); the Transfer to the zero address; and the sender's
// balance, the total supply and burnCount after. Every burn run first settles the burns an earlier
// --send run left open in deployments/sepolia-bridge.json (mined: checked and completed; pending:
// exit code 3; neither: marked dropped). --send unlocks the Foundry keystore (cast reads the
// password file; this tool never does), sends nothing when that settling found a burn mined (it may
// be the one asked for again), and sends the burn the way contracts/script/lib/sepolia.mjs sends
// Sepolia transactions: cast mktx, the hash recorded in the record (a step of kind "burn") before
// cast publish, then the receipt and its events checked as in the dry run.
//
// release reads burn <n> on Sepolia at the finalized block (in fast mode, below): burnCount and
// burnIdOf(n) at that block, and the BurnRequested(n) log (eth_getLogs in windows of at most 10,000
// blocks from the minter's deploy block, or at the block the record names), whose burn id must be
// burnIdOf(n) and the vault's convention. --to, if given, must be the burn's v3Recipient. On V3, at
// the finalized head, it checks the vault's code against deployments/v3-testnet.json, the
// committee (the multisig of the recorded members and threshold, whose address is the vault's
// RELEASER and is mapped to it), that released[burnId] is false and outstanding at least the amount
// (reviveApi.getStorage), and that someone controls the payee. It dry-runs the release from the
// multisig: reviveApi.call (weight and storage deposit; no revert) and reviveApi.traceCall with the
// call tracer (the Released log, the payout of amount x 10^4 wei to the payee); builds the call
// revive.call(vault, 0, weight limit, storage deposit limit, release(burnId, v3Recipient, amount))
// with the limits of committee.ts releaseLimits (twice the weight, the deposit + 2%, at least
// 3.9415 tPOT), dry-runs it again with them, and checks its encoding against polkadot-js. It prints
// the call, its hash, its weight (transactionPaymentCallApi.queryCallInfo), the multisig's state
// for it (multisig.multisigs) and what the next approver runs. An open operation for the same burn
// with another call (other limits) is joined when its call (from the record, or from the first
// approval's extrinsic on chain) is this burn's release with limits that cover the dry run.
// --rehearse dry-runs a burn that is not on Sepolia yet: the vault does not look at Sepolia, so the
// V3 side runs in full with --amount and --to, under burnIdOf(n); with --approve --member k it
// dry-runs that member's approval of it too. Nothing can be sent for it.
// --approve --member k builds member k's approval: multisig.asMulti(2, the other two members in
// ascending order, no timepoint, the call, its weight) when nothing is open, which opens the
// operation and reserves DepositBase + 2 x DepositFactor (9.27 tPOT) of the member's until it runs;
// asMulti with the open operation's timepoint (read from multisig.multisigs) and the call in full
// when the other member approved, which runs it. Both send the call in full, so it is in the first
// approval's extrinsic on chain: V3's pallet-multisig stores only its hash. It prints the fee
// (payment_queryInfo) and refuses a member whose free balance does not cover it, the deposit to
// reserve and the existential deposit. --cancel --member k builds the depositor's cancelAsMulti.
// Every release and fund run first settles the approvals and transfers an earlier --send run left
// submitted: each is looked for in the final blocks after the one it was submitted at, then
// checked as below (exit code 3 while one is still on its way). Each save of the record takes
// deployments/v3-testnet.json.lock, reads the file again and merges it in (records.ts), so what
// v3-vault.ts or another run of this tool wrote meanwhile is kept.
// --send reads --key-file (the member's polkadot-js JSON keystore, sr25519) with --password-file,
// never printed, requires the account to be member k, records the approval in
// deployments/v3-testnet.json (releases) before it submits, waits for finalization and checks the
// events: NewMultisig, or MultisigExecuted with its result Ok and the vault's
// revive.ContractEmitted Released event, then released[burnId], outstanding and the payee's
// balance on the EVM side (eth_getBalance) up by amount x 10^4 wei, and the Released log through
// eth_getLogs, which V3's EVM RPC may not serve for a Substrate extrinsic.
//
// Fast mode: release with --confirmations n (1 to 64) reads and checks the burn at the block n below
// Sepolia's latest (the finalized block when that is higher) instead of the finalized block, and
// prints the trade-off every time: "fast mode: the committee releases before Sepolia finalizes this
// burn; a reorg deeper than n blocks could undo the burn after the release". Only a burn of at most
// --fast-cap (by default 1 tPOT) is released that way; a larger one waits for finality (exit code 3
// until then). The receipt of the burn's transaction has to be in the block its log is in. The
// default stays finality (watch.ts has the rule).
//
// release --watch <seconds> is the auto-release watcher: a round every <seconds> (10 to 86,400),
// --rounds n of them, or until stopped. Each round reads the record again and Sepolia's heads, and
// takes every burn from the last one the record has released (checked again) to burnCount at the
// latest block: a burn the record released, from the record; any other from its BurnRequested log,
// searched from the latest block back to the last released burn's block. A burn released on V3 is
// left alone; one that does not qualify yet (finality, or the fast-mode rule above) waits; for one
// that qualifies, watch.ts nextStep says what comes next, and each approval runs through this tool
// as --approve --member k does, every check first (the burn read again at the block its rule
// gives, its id, amount and recipient as the round saw them, the payee, the vault's code, the
// committee, released[burnId], outstanding, the dry run and the call trace, the member's balance):
// nothing open, the lower of the two members opens it; open, the member that has not approved runs
// it, and the checks of the execution (released[burnId], outstanding, the payee's balance) and the
// record follow as with --send. It never approves twice: a member that approved (on chain, or in
// the record) does not approve again, an approval the record holds as submitted is settled before
// anything else (a round stops while one is on its way, exit code 3), and a burn whose execution ran
// without releasing it, with a cancelled round, with an approval that ran on chain and failed its
// checks, or with an open operation that is another call, is left to the members. A half-done
// release (opened, not run) is resumed by the other member. Without --send each burn's next approval
// is dry-run, members 1 and 2 standing for the two keys. --send takes the two members' polkadot-js
// keystores (--member-keys k:<path>,j:<path>, opened with one --password-file, neither printed) and
// holds the lock release-watch-<multisig>.lock in .bridge-zero in the home directory, whatever
// --state-dir is, relay.ts's scheme: one watcher per committee and machine, checked before each
// signing. --state-dir (by default that same folder) holds the halt file and the burn cache. After a round an RPC failed, the wait doubles, up to an hour. A fatal stop ends the
// watcher with exit code 4: a sent approval that fails its checks on chain, an approval an earlier
// run submitted that is in none of the blocks searched though its sender's nonce is used, a lost
// lock, a key file or a record that cannot be written. With --send it first writes
// release-watch-<multisig>.halt in --state-dir (the reason, the burn, the extrinsic, the time), and no
// watcher with --send starts while that file is there: a member looks, then removes it. Otherwise a
// round ends 0 when nothing was refused, 1 when a burn was refused or left to the members, 2 when a
// node could not be reached, 3 when something sent is not final yet.
//
// fund dry-runs balances.transferKeepAlive of --amount tPOT from --from (by default the testnet
// account 5ERJ…) to member k or to the multisig account, with its fee and what the member needs for
// the approval it is funded for; --send signs with --key-file (JSON with .substrate.mnemonic, as
// v3-vault.ts deploy takes it), records the transfer (committeeFunding) and checks it.
//
// status lists the burns on Sepolia (windowed logs; burnCount and burnIdOf when the RPC refuses old
// logs) with the release state of each on V3 (released[burnId], the Released logs, the multisig's
// open operations, the record), the members' and the multisig's balances, and the accounting: the
// vault's outstanding covers the wtPOT supply and the burns not released yet.
//
// Nothing is signed without --send, and --account, --password-file, --key-file and --member-keys
// are refused without it. Every fetch of this process refuses eth_send*, eth_sign* and personal_* before
// anything reaches the wire (bridge.ts installDryRunGuard), and the V3 node's provider refuses
// author_submit* unless the command signs on V3 with --send (bridge.ts guardProvider). Exit code 0
// when the dry run passed, the transaction is done and checked, or status found nothing wrong; 1
// when a check fails or the tool refuses; 2 when a node cannot be reached; 3 when a sent
// transaction or extrinsic is not final yet, or the burn is not final on Sepolia yet (in fast mode,
// not --confirmations deep yet, or above --fast-cap and not final).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { keccak_256 } from "@noble/hashes/sha3.js";
import type { ApiPromise, Keyring } from "@polkadot/api";
// The static types of consts, storage, extrinsics and events (Substrate's pallets, close to V3's).
import type {} from "@polkadot/api/augment";
import type { SubmittableExtrinsic } from "@polkadot/api/types";
import type { EventRecord } from "@polkadot/types/interfaces";
import {
  BRIDGE_ERRORS,
  BURN_REQUESTED_TOPIC,
  callData,
  decodeBurnRequested,
  decodeTransfer,
  DryRunViolation,
  errorMap,
  formatWtpot,
  guardProvider,
  installDryRunGuard,
  logWindows,
  MINTER,
  revertName,
  SEPOLIA_CHAIN_ID,
  TOKEN,
  TRANSFER_TOPIC,
  uintAt,
  V3_CHAIN_ID,
  wordAt,
} from "./bridge.js";
import { bytesToHex, equalBytes, hexToBytes, shortHex, type Hex } from "./bytes.js";
import {
  burnCalldata,
  callHash,
  decodeReleaseCalldata,
  decodeReviveCall,
  encodeReviveCall,
  evmValue,
  isDelegation,
  limitsProblem,
  multisigDeposit,
  otherSignatories,
  parseWtpot,
  payeeVerdict,
  releaseCall,
  releaseDepositFloor,
  releaseLimits,
  releaseTraceChecks,
  traceOf,
  type PayeeFacts,
  type Release,
  type ReleaseNeeds,
  type ReviveCall,
  type Timepoint,
  type Weight,
} from "./committee.js";
import {
  burnId,
  checksumAddress,
  decodeReleased,
  ethAccountId,
  formatEvmTpot,
  formatTpot,
  multisigAccountId,
  parseAddress,
  parseTpot,
  releasedSlot,
  RELEASED_TOPIC,
  reviveAddress,
  SLOTS,
  uintWord,
  type LogJson,
} from "./vault.js";
import {
  CAP,
  PROBE,
  PROBE_CODE,
  PROBE_GAS,
  PROBE_SENDER,
  RPC,
  eth,
  feesAt,
  findLog,
  fmt,
  gasOf,
  keystoreAddress,
  mktxArgs,
  nextNonceIs,
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
  withHeadroom,
  writeJsonAtomic,
  type Fees,
  type Log,
  type Receipt,
} from "../../contracts/script/lib/sepolia.mjs";
import {
  checkBlock,
  cursorOf,
  DEFAULT_FAST_CAP,
  FINALITY,
  haltRefusal,
  MAX_WATCH_SECONDS,
  MIN_WATCH_SECONDS,
  nextWait,
  parseConfirmations,
  parseMemberKeys,
  readBurnCache,
  readHalt,
  reconcileVerdict,
  rpcTrouble,
  submitErrorVerdict,
  takeLock,
  tradeOff,
  watchRound,
  writeBurnCache,
  writeHalt,
  type BurnState,
  type CachedBurn,
  type Heads,
  type FatalStop,
  type Lock,
  type Outcome,
  type Ports,
  type RoundResult,
  type Rule,
  type SeenBurn,
} from "./watch.js";
import { saveMerged } from "./records.js";

/** The Portaldot V3 testnet, where the vault and the committee's multisig are. */
const V3 = {
  title: "the Portaldot V3 testnet",
  rpc: "wss://test-node-v3.portaldot.dev",
  evm: "https://test-evm-rpc-v3.portaldot.dev",
  genesis: "0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd",
  chainId: V3_CHAIN_ID,
  ss58: 42,
} as const;

/** The account a burn dry run sends from, and the testnet account that funds the committee. */
const DEFAULT_SENDER = "0xD9838A86cF83C28Ee486544060D1cA4Ca2971071";
const DEFAULT_FUNDER = "5ERJiUnzmQwEF98X3rGyKiNsyjrcenLGJST3MULCjUSwgPJ7";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
/** Where the watcher's lock is, and the default --state-dir: outside every checkout, as relay.ts keeps its state. */
const STATE_DIR = join(homedir(), ".bridge-zero");
/** The lock of the committee's watcher, in STATE_DIR whatever --state-dir is: two watchers of one committee on one machine never both send. */
const watchLockPath = (multisig: string) => join(STATE_DIR, `release-watch-${multisig}.lock`);
const BRIDGE_RECORD = "deployments/sepolia-bridge.json";
const V3_RECORD = "deployments/v3-testnet.json";
const at = (path: string) => resolve(ROOT, path);

/** Gas limit of each view read at the end of a simulated burn. */
const VIEW_GAS = 200_000;
/** How long a sent extrinsic waits for finalization, and how long the node may take to connect. */
const FINAL_TIMEOUT = 10 * 60_000;
const CONNECT_TIMEOUT = 60_000;
/** How many blocks after the one it was submitted at an extrinsic an earlier run left is looked for. */
const SEARCH_BLOCKS = 1_200;
const TPOT = 10n ** 14n;

/** The whole tPOT that cover `missing` native base units, at least 1: what the tool advises to fund. */
const wholeTpot = (missing: bigint): bigint => (missing <= TPOT ? 1n : (missing + TPOT - 1n) / TPOT);

const TRUST = "trusted: the committee's 2-of-3 multisig releases on V3; no contract checks the release against the burn";

const OK = 0;
const FAILED = 1;
const UNREACHABLE = 2;
const PENDING = 3;
/** The watcher stopped for good (a fatal stop) and left its halt file: whatever restarts it must not. */
const HALTED = 4;

const log = (message = "") => console.log(message);
const errorText = (error: unknown) => redact(error instanceof Error ? error.message : String(error));

let failures = 0;
function check(ok: boolean, what: string): boolean {
  log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
  return ok;
}
const warn = (what: string) => log(`WARN ${what}`);

/** A refusal or a failed check: exit code 1. */
class Stop extends Error {
  override name = "Stop";
}

/** A command line the tool does not take: exit code 1, with the usage. */
class Usage extends Stop {
  override name = "Usage";
}

/** A node did not answer: exit code 2. */
class Unreachable extends Error {
  override name = "Unreachable";
}

/** An RPC answered a read with an error (exit code 1, as any Stop): for the watcher, trouble with the RPC, not with the burn. */
class RpcError extends Stop {
  override name = "RpcError";
}

/** The request never got an answer (fetch failed, timed out, or no JSON came back), as opposed to an error the RPC returned. */
const offline = (error: unknown) =>
  error instanceof TypeError || error instanceof SyntaxError || (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"));

/** A Sepolia read, retried as a load-balanced RPC can lag: Unreachable when it never got an answer, Stop with the RPC's error otherwise. */
async function sepolia<R>(what: string, read: () => Promise<R>): Promise<R> {
  try {
    return await retry(what, read);
  } catch (error) {
    if (error instanceof DryRunViolation) throw error;
    if (offline(error)) throw new Unreachable(`Sepolia RPC unreachable (${what}: ${errorText(error)})`);
    throw new RpcError(`Sepolia RPC: ${what}: ${errorText(error)}`);
  }
}

/** @polkadot/api, loaded when a command reads V3. The tool never calls process.exit (v3-vault.ts says why). */
const polkadot = () => import("@polkadot/api");

// ---------------------------------------------------------------------------------------
// Options

const USAGE = `usage (from relayer/):
  npm run release -- burn --amount <wtPOT> --v3-recipient <h160> [--from <address>] [--send --account <keystore> --password-file <path>]
  npm run release -- release --burn-nonce <n> [--to <h160>]
  npm run release -- release --burn-nonce <n> --rehearse --amount <wtPOT> --to <h160> [--approve --member <1|2|3>]
  npm run release -- release --burn-nonce <n> --approve|--cancel --member <1|2|3> [--send --key-file <member json> --password-file <path>]
  npm run release -- release --watch <seconds> [--rounds <n>] [--state-dir <path>] [--send --member-keys <k>:<member json>,<j>:<member json> --password-file <path>]
  fast mode, for release and release --watch: --confirmations <n> (1 to 64) [--fast-cap <tPOT>, by default 1] [--fast-budget <tPOT>, --watch only, by default the cap]
  npm run release -- fund --member <1|2|3> | --multisig --amount <tPOT> [--from <ss58>] [--send --key-file <path>]
  npm run release -- status
  more options: --rpc <wss url>, --evm <http(s) url>, --priority-fee <gwei> and --max-fee <gwei> (burn)
  the return path is trusted: the committee's multisig releases on V3, and no contract checks a release against its burn`;

function usage(problem: string): never {
  throw new Usage(problem);
}

interface Common {
  rpc: string;
  evm: string;
}

interface BurnOptions extends Common {
  amount: bigint;
  v3Recipient: Uint8Array;
  from?: Uint8Array;
  send: boolean;
  account?: string;
  passwordFile?: string;
  priorityFee?: bigint;
  maxFee?: bigint;
}

type Action = "plan" | "approve" | "cancel";
type Member = 1 | 2 | 3;

/** What one release run is asked: the command line's, or the watcher's for one burn. */
interface ReleaseRun {
  burnNonce: bigint;
  to?: Uint8Array;
  rehearse: boolean;
  amount?: bigint;
  action: Action;
  member?: Member;
  send: boolean;
  keyFile?: string;
  passwordFile?: string;
  /** Where the burn is read on Sepolia: the finalized block, or --confirmations below the latest up to --fast-cap. */
  rule: Rule;
  /** The member's key, which the watcher loads once. */
  pair?: Pair;
  /** Throws when the watcher's lock is not its own any more; called before signing. */
  guard?: () => void;
  /** The watcher runs it: it prints its own next steps. */
  watcher?: boolean;
  /** Where the watcher saw the burn's log: findBurn looks there first, in that one block. */
  hint?: BurnHint;
}

/** A burn's log as a round saw it: its block, its block's hash and its transaction. */
interface BurnHint {
  block: number;
  blockHash: Hex | null;
  txHash: Hex | null;
}

interface ReleaseOptions extends Common, ReleaseRun {}

/** release --watch: the auto-release watcher. */
interface WatchOptions extends Common {
  watch: number;
  /** Stop after this many rounds (--rounds); null: run until stopped. */
  rounds: number | null;
  rule: Rule;
  send: boolean;
  /** The two members whose keys sign (--member-keys); without --send, members 1 and 2. */
  memberKeys: { member: Member; path: string | null }[];
  passwordFile?: string;
  /** Where the halt file and the burn cache are (--state-dir), absolute; the lock is in STATE_DIR. */
  stateDir: string;
}

interface FundOptions extends Common {
  member?: Member;
  multisig: boolean;
  amount: bigint;
  from: string;
  send: boolean;
  keyFile?: string;
}

function parse(args: string[], options: NonNullable<ParseArgsConfig["options"]>) {
  try {
    return parseArgs({ args, options, strict: true, allowPositionals: false }).values as Record<string, string | boolean | undefined>;
  } catch (error) {
    usage(errorText(error));
  }
}

const str = (v: string | boolean | undefined) => (typeof v === "string" ? v : undefined);

/** Wraps a parse error of one option into the usage message. */
function option<T>(what: string, parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    usage(`${what}: ${errorText(error)}`);
  }
}

function nonZeroAddress(text: string, what: string): Uint8Array {
  const address = parseAddress(text, what);
  if (address.every((b) => b === 0)) throw new Error(`${what} is the zero address`);
  return address;
}

/** A burn nonce: a whole number written as digits only, as the minter counts them. */
function parseBurnNonce(text: string): bigint {
  if (!/^\d+$/.test(text)) throw new Error(`a burn nonce is a whole number, got ${JSON.stringify(text)}`);
  const value = BigInt(text);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${text} is above any nonce the minter will reach`);
  return value;
}

function parseMember(text: string): Member {
  if (text !== "1" && text !== "2" && text !== "3") throw new Error(`a member is 1, 2 or 3, got ${JSON.stringify(text)}`);
  return Number(text) as Member;
}

/** A file the tool opens only to sign: made absolute, its path never printed, and refused when it is not there. */
function secretPath(text: string | undefined, what: string): string | undefined {
  if (text === undefined) return undefined;
  const path = resolve(text);
  redactAlso(path, text);
  if (!existsSync(path)) usage(`${what}: no such file`);
  return path;
}

function parseCommon(values: Record<string, string | boolean | undefined>): Common {
  const rpcUrl = str(values.rpc) ?? V3.rpc;
  const evm = str(values.evm) ?? V3.evm;
  if (!/^wss?:\/\//i.test(rpcUrl) || !URL.canParse(rpcUrl)) usage("--rpc must be a ws:// or wss:// URL");
  if (!/^https?:\/\//i.test(evm) || !URL.canParse(evm)) usage("--evm must be an http:// or https:// URL");
  // Only the host of a custom URL is printed; it can carry a key.
  redactAlso(rpcUrl === V3.rpc ? undefined : rpcUrl, evm === V3.evm ? undefined : evm);
  return { rpc: rpcUrl, evm };
}

const COMMON = { rpc: { type: "string" }, evm: { type: "string" } } as const;

function burnOptions(args: string[]): BurnOptions {
  const v = parse(args, {
    amount: { type: "string" },
    "v3-recipient": { type: "string" },
    from: { type: "string" },
    send: { type: "boolean", default: false },
    account: { type: "string" },
    "password-file": { type: "string" },
    "priority-fee": { type: "string" },
    "max-fee": { type: "string" },
    ...COMMON,
  });
  const amountText = str(v.amount);
  const recipientText = str(v["v3-recipient"]);
  if (amountText === undefined || recipientText === undefined) usage("burn needs --amount <wtPOT> and --v3-recipient <h160>, the address on V3 the committee is to pay");
  const send = v.send === true;
  const account = str(v.account);
  const passwordText = str(v["password-file"]);
  if (!send && (account !== undefined || passwordText !== undefined)) usage("--account and --password-file are for --send; a dry run signs nothing");
  if (send && !(account && passwordText)) usage("--send needs --account <keystore name> and --password-file <path>");
  const fromText = str(v.from);
  if (fromText !== undefined && send) usage("--from is for a dry run: --send burns from the address its keystore unlocks to");
  // cast runs in a directory of its own: the path is made absolute here (this tool never opens it).
  const passwordFile = secretPath(passwordText, "--password-file");
  const gwei = (name: string) => {
    const text = str(v[name]);
    return text === undefined ? undefined : option(`--${name}`, () => parseGwei(text));
  };
  return {
    ...parseCommon(v),
    amount: option("--amount", () => parseWtpot(amountText)),
    v3Recipient: option("--v3-recipient", () => nonZeroAddress(recipientText, "--v3-recipient")),
    from: fromText === undefined ? undefined : option("--from", () => parseAddress(fromText, "--from")),
    send,
    account,
    passwordFile,
    priorityFee: gwei("priority-fee"),
    maxFee: gwei("max-fee"),
  };
}

/** --confirmations, --fast-cap and --fast-budget (by default the cap): the rule a burn is read by. */
function ruleOf(v: Record<string, string | boolean | undefined>): Rule {
  const confirmationsText = str(v.confirmations);
  const capText = str(v["fast-cap"]);
  const budgetText = str(v["fast-budget"]);
  if (confirmationsText === undefined) {
    if (capText !== undefined) usage("--fast-cap is for fast mode: add --confirmations <n>");
    if (budgetText !== undefined) usage("--fast-budget is for fast mode: add --confirmations <n>");
    return FINALITY;
  }
  const fastCap = capText === undefined ? DEFAULT_FAST_CAP : option("--fast-cap", () => parseTpot(capText));
  return {
    confirmations: option("--confirmations", () => parseConfirmations(confirmationsText)),
    fastCap,
    fastBudget: budgetText === undefined ? fastCap : option("--fast-budget", () => parseTpot(budgetText)),
  };
}

/** A whole number written as digits only, within [min, max]. */
function wholeIn(text: string, min: number, max: number): number {
  if (!/^\d+$/.test(text)) throw new Error(`a whole number, got ${JSON.stringify(text)}`);
  const n = Number(text);
  if (n < min || n > max) throw new Error(`from ${fmt(min)} to ${fmt(max)}, got ${text}`);
  return n;
}

function releaseOptions(args: string[]): ReleaseOptions | WatchOptions {
  const v = parse(args, {
    "burn-nonce": { type: "string" },
    to: { type: "string" },
    rehearse: { type: "boolean", default: false },
    amount: { type: "string" },
    approve: { type: "boolean", default: false },
    cancel: { type: "boolean", default: false },
    member: { type: "string" },
    send: { type: "boolean", default: false },
    "key-file": { type: "string" },
    "password-file": { type: "string" },
    confirmations: { type: "string" },
    "fast-cap": { type: "string" },
    "fast-budget": { type: "string" },
    watch: { type: "string" },
    rounds: { type: "string" },
    "member-keys": { type: "string" },
    "state-dir": { type: "string" },
    ...COMMON,
  });
  if (str(v.watch) !== undefined) return watchOptions(v);
  for (const name of ["rounds", "member-keys", "state-dir", "fast-budget"]) if (v[name] !== undefined) usage(`--${name} is for --watch`);
  const nonceText = str(v["burn-nonce"]);
  if (nonceText === undefined) usage("release needs --burn-nonce <n>, the burn on Sepolia to release, or --watch <seconds>");
  const rehearse = v.rehearse === true;
  const approve = v.approve === true;
  const cancel = v.cancel === true;
  const send = v.send === true;
  const amountText = str(v.amount);
  const toText = str(v.to);
  const memberText = str(v.member);
  const keyText = str(v["key-file"]);
  const passwordText = str(v["password-file"]);
  if (approve && cancel) usage("choose one of --approve and --cancel");
  if (rehearse && (cancel || send)) usage("--rehearse is a dry run of a burn that is not on Sepolia: nothing is sent or cancelled for it (--approve dry-runs an approval)");
  if (rehearse && (amountText === undefined || toText === undefined)) usage("--rehearse needs --amount <wtPOT> and --to <h160>: the burn it stands for");
  if (!rehearse && amountText !== undefined) usage("--amount is for --rehearse: a release pays exactly what its burn burned");
  if (rehearse && v.confirmations !== undefined) usage("--confirmations reads a burn on Sepolia, and a rehearsal has none");
  if ((approve || cancel) && memberText === undefined) usage(`--${approve ? "approve" : "cancel"} needs --member <1|2|3>`);
  if (!approve && !cancel && memberText !== undefined) usage("--member is for --approve and --cancel");
  if (send && !approve && !cancel) usage("--send signs an approval or a cancellation: add --approve or --cancel with --member");
  if (send && !(keyText && passwordText)) usage("--send needs --key-file <member json> and --password-file <path>");
  if (!send && (keyText !== undefined || passwordText !== undefined)) usage("--key-file and --password-file are for --send; a dry run signs nothing");
  // The key file and the password file are opened only to sign; their paths are not printed either.
  const keyFile = secretPath(keyText, "--key-file");
  const passwordFile = secretPath(passwordText, "--password-file");
  return {
    ...parseCommon(v),
    burnNonce: option("--burn-nonce", () => parseBurnNonce(nonceText)),
    to: toText === undefined ? undefined : option("--to", () => nonZeroAddress(toText, "--to")),
    rehearse,
    amount: amountText === undefined ? undefined : option("--amount", () => parseWtpot(amountText)),
    action: approve ? "approve" : cancel ? "cancel" : "plan",
    member: memberText === undefined ? undefined : option("--member", () => parseMember(memberText)),
    send,
    keyFile,
    passwordFile,
    rule: ruleOf(v),
  };
}

function watchOptions(v: Record<string, string | boolean | undefined>): WatchOptions {
  for (const name of ["burn-nonce", "to", "amount", "member", "key-file"]) if (v[name] !== undefined) usage(`--${name} is for a release of one burn: --watch releases every burn that qualifies`);
  for (const name of ["rehearse", "approve", "cancel"]) if (v[name] === true) usage(`--${name} is for a release of one burn: --watch releases every burn that qualifies`);
  const send = v.send === true;
  const keysText = str(v["member-keys"]);
  const passwordText = str(v["password-file"]);
  if (send && !(keysText && passwordText)) usage("--watch --send needs --member-keys <k>:<member json>,<j>:<member json> and --password-file <path>, which opens both");
  if (!send && (keysText !== undefined || passwordText !== undefined)) usage("--member-keys and --password-file are for --send; a dry run signs nothing");
  const roundsText = str(v.rounds);
  const memberKeys = keysText === undefined
    ? [{ member: 1 as Member, path: null }, { member: 2 as Member, path: null }]
    : option("--member-keys", () => parseMemberKeys(keysText)).map((k) => ({ member: k.member as Member, path: secretPath(k.path, `--member-keys (member ${k.member})`)! }));
  return {
    ...parseCommon(v),
    watch: option("--watch", () => wholeIn(str(v.watch)!, MIN_WATCH_SECONDS, MAX_WATCH_SECONDS)),
    rounds: roundsText === undefined ? null : option("--rounds", () => wholeIn(roundsText, 1, Number.MAX_SAFE_INTEGER)),
    rule: ruleOf(v),
    send,
    memberKeys,
    passwordFile: secretPath(passwordText, "--password-file"),
    stateDir: resolve(str(v["state-dir"]) ?? STATE_DIR),
  };
}

function fundOptions(args: string[]): FundOptions {
  const v = parse(args, {
    member: { type: "string" },
    multisig: { type: "boolean", default: false },
    amount: { type: "string" },
    from: { type: "string" },
    send: { type: "boolean", default: false },
    "key-file": { type: "string" },
    ...COMMON,
  });
  const memberText = str(v.member);
  const multisig = v.multisig === true;
  const amountText = str(v.amount);
  if ((memberText === undefined) === !multisig) usage("fund takes --member <1|2|3> or --multisig: the account to fund");
  if (amountText === undefined) usage("fund needs --amount <tPOT>");
  const send = v.send === true;
  const keyText = str(v["key-file"]);
  if (send && !keyText) usage("--send needs --key-file <path> (JSON with .substrate.mnemonic)");
  if (!send && keyText !== undefined) usage("--key-file is for --send; a dry run signs nothing");
  return {
    ...parseCommon(v),
    member: memberText === undefined ? undefined : option("--member", () => parseMember(memberText)),
    multisig,
    amount: option("--amount", () => parseTpot(amountText)),
    from: str(v.from) ?? DEFAULT_FUNDER,
    send,
    keyFile: secretPath(keyText, "--key-file"),
  };
}

function statusOptions(args: string[]): Common {
  return parseCommon(parse(args, COMMON));
}

// ---------------------------------------------------------------------------------------
// The records

/** The burn a step of kind "burn" sent: what was asked, and what the minter gave it once mined. */
interface BurnFacts {
  amount: string;
  v3Recipient: Hex;
  expected: { burnNonce: string; burnId: Hex };
  burnNonce: string | null;
  burnId: Hex | null;
}

/** A Sepolia transaction in deployments/sepolia-bridge.json: mint.ts writes the deploy, mint, tamper and replay steps, this tool the burns. */
interface BridgeStep {
  name: string;
  kind: string;
  nonce: number;
  sender: Hex;
  contract: string;
  address: Hex;
  burn?: BurnFacts;
  dataHash: Hex;
  gasLimit: number | null;
  simulatedGas: number | null;
  codeHash: Hex | null;
  txHash: Hex | null;
  signedAt: string | null;
  block: number | null;
  gasUsed: number | null;
  effectiveGasPrice: string | null;
  status: number | null;
  ok: boolean | null;
  dropped?: Hex[];
  note?: string;
}

interface BridgeRecord {
  network: string;
  chainId: number;
  deployer: string;
  contracts: Record<string, Hex>;
  steps: BridgeStep[];
}

/** The minter and the token as the record has them. */
interface Bridge {
  record: BridgeRecord;
  minter: Hex;
  token: Hex;
  deployer: Hex;
  /** The block BridgeMinter was created in: where a search for its logs starts. */
  deployBlock: number;
  minterCodeHash: Hex;
  tokenCodeHash: Hex;
}

function readBridge(): Bridge {
  const path = at(BRIDGE_RECORD);
  if (!existsSync(path)) throw new Stop(`no ${BRIDGE_RECORD}: the bridge is deployed with npm run mint -- deploy`);
  let record: BridgeRecord;
  try {
    record = JSON.parse(readFileSync(path, "utf8")) as BridgeRecord;
  } catch (error) {
    throw new Stop(`${BRIDGE_RECORD}: ${errorText(error)}`);
  }
  if (record.network !== "sepolia" || record.chainId !== Number(SEPOLIA_CHAIN_ID) || !Array.isArray(record.steps)) throw new Stop(`${BRIDGE_RECORD} is not a Sepolia bridge record`);
  const deployed = (name: string) => record.steps.find((s) => s.kind === "deploy" && s.name === name && s.ok && s.block !== null && s.codeHash);
  const minter = deployed("BridgeMinter");
  const token = deployed("WrappedTPOT");
  if (!minter || !token || record.contracts?.BridgeMinter !== minter.address || record.contracts?.WrappedTPOT !== token.address) {
    throw new Stop(`${BRIDGE_RECORD} records no deployed BridgeMinter and WrappedTPOT`);
  }
  return {
    record,
    minter: minter.address,
    token: token.address,
    deployer: minter.sender,
    deployBlock: minter.block!,
    minterCodeHash: minter.codeHash!,
    tokenCodeHash: token.codeHash!,
  };
}

function saveBridge(record: BridgeRecord): void {
  try {
    writeJsonAtomic(at(BRIDGE_RECORD), record);
  } catch (error) {
    throw new Stop(`${BRIDGE_RECORD} could not be written: ${errorText(error)}`);
  }
}

interface WeightJson {
  refTime: string;
  proofSize: string;
}

/** One extrinsic of a release round: a member's approval or cancellation, recorded before it is submitted. */
interface ApprovalEntry {
  member: number;
  account: string;
  /** open: asMulti without a timepoint (the first approval); execute: asMulti with the timepoint (runs the call); cancel: cancelAsMulti. */
  action: "open" | "execute" | "cancel";
  timepoint: Timepoint | null;
  maxWeight: WeightJson | null;
  nonce: number;
  extrinsicHash: Hex;
  signedAt: string;
  /** The finalized V3 block when it was submitted: where a later run looks for it. */
  submittedAfter: number;
  /** submitted: not seen final yet. final: final, with ExtrinsicSuccess and its events checked. failed: refused, or final without them. dropped: never included. */
  status: "submitted" | "final" | "failed" | "dropped";
  block: { number: number; hash: Hex; index: number } | null;
  fee: string | null;
  events: string[];
  /** MultisigExecuted's result: "Ok", or the error. */
  result?: string;
  note?: string;
}

/** One release round of a burn, in deployments/v3-testnet.json (releases). */
interface ReleaseEntry {
  /** open: approved, not run yet. released: run and checked. failed: run with an error, or its checks failed. cancelled. */
  status: "open" | "released" | "failed" | "cancelled";
  /** How the burn qualified at the round's last approval: final on Sepolia, or fast mode before finality. */
  by?: "fast" | "finality";
  /** For a release made in fast mode: the check of its burn on Sepolia's final chain, once its block was final (the watcher's). */
  finalizedCheck?: { block: number; ok: boolean; why: string; at: string };
  trust: string;
  burn: { chainId: string; minter: Hex; burnNonce: string; burnId: Hex; from: Hex; v3Recipient: Hex; amount: string; txHash: Hex; block: number; blockHash?: Hex | null };
  vault: Hex;
  payee: Hex;
  amountNative: string;
  /** What the vault pays, in EVM units (amountNative x the ratio). */
  value: string;
  call: { hex: Hex; hash: Hex; weightLimit: WeightJson; storageDepositLimit: string; weight: WeightJson };
  dryRun: { block: number; refTime: string; proofSize: string; storageDeposit: string; maxStorageDeposit: string };
  multisig: { account: string; threshold: number; timepoint: Timepoint | null; depositor: string | null; deposit: string | null };
  approvals: ApprovalEntry[];
  released?: { block: { number: number; hash: Hex }; outstandingAfter: string; payeeCredited: string; payeeReceived: string | null; releasedLog: "eth_getLogs" | "not served" };
  note?: string;
}

/** A transfer that funds a member or the multisig, in deployments/v3-testnet.json (committeeFunding). */
interface FundingEntry {
  status: "submitted" | "final" | "failed" | "dropped";
  from: string;
  to: string;
  role: string;
  amount: string;
  nonce: number;
  extrinsicHash: Hex;
  signedAt: string;
  submittedAfter: number;
  block: { number: number; hash: Hex; index: number } | null;
  fee: string | null;
  note?: string;
}

interface VaultRecord {
  network: string;
  genesisHash: string;
  chainId: number;
  vault: {
    status: string;
    address: string;
    codeHash: string | null;
    block: { number: number } | null;
    nativeToEthRatio: string;
    releaser: string;
    committee: { multisig: string; accountId: string; members: string[]; threshold: number } | null;
  } | null;
  locks: unknown[];
  releases?: ReleaseEntry[];
  committeeFunding?: FundingEntry[];
}

/** The vault and the committee, as deployments/v3-testnet.json records them. */
interface VaultFacts {
  address: Uint8Array;
  codeHash: Hex;
  block: number;
  ratio: bigint;
  releaser: Uint8Array;
  multisig: string;
  multisigId: Uint8Array;
  members: string[];
  threshold: number;
}

function readV3Record(): VaultRecord {
  const path = at(V3_RECORD);
  if (!existsSync(path)) throw new Stop(`no ${V3_RECORD}: the vault is deployed with npm run v3-vault -- deploy`);
  let record: VaultRecord;
  try {
    record = JSON.parse(readFileSync(path, "utf8")) as VaultRecord;
  } catch (error) {
    throw new Stop(`${V3_RECORD}: ${errorText(error)}`);
  }
  if (record.network !== "portaldot-v3-testnet" || record.genesisHash !== V3.genesis || BigInt(record.chainId) !== V3.chainId || !Array.isArray(record.locks)) {
    throw new Stop(`${V3_RECORD} is not a record of ${V3.title} (genesis ${V3.genesis})`);
  }
  return record;
}

/** The record could not be written: the watcher stops. */
class RecordError extends Stop {
  override name = "RecordError";
}

/**
 * Saves the record: under deployments/v3-testnet.json.lock, the file read again and merged into
 * `record` (records.ts mergeV3Record: what another process added or settled is kept), then written
 * atomically. The vault is the file's: this tool never changes it.
 */
function saveV3Record(record: VaultRecord): void {
  try {
    saveMerged(at(V3_RECORD), record, { vault: "disk" });
  } catch (error) {
    throw new RecordError(`${V3_RECORD} could not be written: ${errorText(error)}`);
  }
}

/** The vault and its committee from the record; refuses a committee whose multisig account or address is not the recorded one. */
function vaultFacts(record: VaultRecord, keyring: Keyring): VaultFacts {
  const v = record.vault;
  if (!v || v.status !== "deployed" || !v.codeHash || !v.block) throw new Stop(`${V3_RECORD} records no deployed vault`);
  const c = v.committee;
  if (!c) throw new Stop(`${V3_RECORD} names no committee for the vault's releaser`);
  const memberIds = c.members.map((m) => keyring.decodeAddress(m));
  const multisigId = multisigAccountId(memberIds, c.threshold);
  if (bytesToHex(multisigId) !== c.accountId.toLowerCase() || keyring.encodeAddress(multisigId, V3.ss58) !== c.multisig) {
    throw new Stop(`${V3_RECORD}: the ${c.threshold}-of-${c.members.length} multisig of the recorded members is ${keyring.encodeAddress(multisigId, V3.ss58)}, not ${c.multisig}`);
  }
  const releaser = hexToBytes(v.releaser);
  if (!equalBytes(reviveAddress(multisigId), releaser)) throw new Stop(`${V3_RECORD}: the multisig's address is ${checksumAddress(reviveAddress(multisigId))}, the vault's RELEASER is ${checksumAddress(releaser)}`);
  return {
    address: hexToBytes(v.address),
    codeHash: v.codeHash.toLowerCase() as Hex,
    block: v.block.number,
    ratio: BigInt(v.nativeToEthRatio),
    releaser,
    multisig: c.multisig,
    multisigId,
    members: c.members.map((m) => keyring.encodeAddress(keyring.decodeAddress(m), V3.ss58)),
    threshold: c.threshold,
  };
}

const weightJson = (w: Weight): WeightJson => ({ refTime: w.refTime.toString(), proofSize: w.proofSize.toString() });
const weightText = (w: Weight) => `${fmt(w.refTime)} ref time, ${fmt(w.proofSize)} proof size`;

function gitCommit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------
// Sepolia

const sepoliaView = async (to: Hex, data: Uint8Array, block: string) => hexToBytes(await sepolia("view", () => rpc<Hex>("eth_call", [{ to, data: bytesToHex(data) }, block])));

async function checkSepolia(): Promise<void> {
  let chainId: string;
  try {
    chainId = await rpc<string>("eth_chainId", []);
  } catch (error) {
    if (error instanceof DryRunViolation) throw error;
    throw new Unreachable(`Sepolia RPC unreachable (${errorText(error)})`);
  }
  if (!check(BigInt(chainId) === SEPOLIA_CHAIN_ID, `chain id ${BigInt(chainId)} is Sepolia (${new URL(RPC).host})`)) throw new Stop("the Sepolia RPC serves another chain");
}

interface SepoliaState {
  burnCount: bigint;
  totalSupply: bigint;
}

/** The minter and the token at `block`: their code must be the record's. */
async function sepoliaState(b: Bridge, block: string): Promise<SepoliaState> {
  for (const [name, address, hash] of [["BridgeMinter", b.minter, b.minterCodeHash], ["WrappedTPOT", b.token, b.tokenCodeHash]] as const) {
    const code = hexToBytes(await sepolia("code", () => rpc<Hex>("eth_getCode", [address, block])));
    if (bytesToHex(keccak_256(code)) !== hash) throw new Stop(`${name} ${checksumAddress(hexToBytes(address))} does not have the code ${BRIDGE_RECORD} records`);
  }
  return {
    burnCount: uintAt(await sepoliaView(b.minter, callData(MINTER.burnCount), block), 0),
    totalSupply: uintAt(await sepoliaView(b.token, callData(TOKEN.totalSupply), block), 0),
  };
}

/**
 * eth_getLogs of `filter` over blocks `from` to `to` in windows of at most 10,000 blocks; { refused }
 * when the RPC refuses a window three times (pruned history, a range cap; a node behind a load
 * balancer can also lag the head for a moment).
 */
async function sepoliaLogs(filter: { address: Hex; topics: (string | string[] | null)[] }, from: number, to: number): Promise<{ logs: LogJson[] } | { refused: string }> {
  const logs: LogJson[] = [];
  for (const [a, z] of logWindows(from, to)) {
    for (let attempt = 1; ; attempt++) {
      const body = await sepolia("logs", () => rpcBody("eth_getLogs", [{ ...filter, fromBlock: qty(a), toBlock: qty(z) }]));
      if (!body.error) {
        logs.push(...(body.result as LogJson[]));
        break;
      }
      if (attempt === 3) return { refused: `${body.error.message ?? "error"}${body.error.code === undefined ? "" : ` (code ${body.error.code})`} for #${fmt(a)} to #${fmt(z)}` };
      await sleep(3_000);
    }
  }
  return { logs };
}

/** A burn as its BurnRequested log has it. */
interface BurnOnChain {
  burnNonce: bigint;
  from: Uint8Array;
  v3Recipient: Uint8Array;
  amount: bigint;
  burnId: Uint8Array;
  txHash: Hex;
  block: number;
  /** The log's block hash, when the RPC gave it. */
  blockHash: Hex | null;
}

function burnOfLog(l: LogJson): BurnOnChain {
  const e = decodeBurnRequested(l);
  return { ...e, txHash: (l.transactionHash ?? "0x").toLowerCase() as Hex, block: Number(BigInt(l.blockNumber ?? "0")), blockHash: l.blockHash ? (l.blockHash.toLowerCase() as Hex) : null };
}

/**
 * BurnRequested(n): first in the block `hint` names (the watcher's, from its round), where the log
 * counts only in the canonical block of that number (its block hash is eth_getBlockByNumber's), read
 * with eth_getLogs over that one block or, when the RPC refuses that (pruned history), from its
 * transaction's receipt; then from the block the record names for it; then from the minter's deploy
 * block to `to`. Null when there is none.
 */
async function findBurn(b: Bridge, n: bigint, to: number, hint?: BurnHint): Promise<BurnOnChain | null> {
  const filter = { address: b.minter, topics: [BURN_REQUESTED_TOPIC, bytesToHex(uintWord(n))] };
  if (hint && hint.block <= to) {
    const ours = (logs: LogJson[]) =>
      logs.filter((l) => l.address.toLowerCase() === b.minter && !(l as { removed?: boolean }).removed && l.topics[0]?.toLowerCase() === BURN_REQUESTED_TOPIC && l.topics[1]?.toLowerCase() === filter.topics[1]);
    const canonical = await sepolia("block", () => rpc<{ hash: string } | null>("eth_getBlockByNumber", [qty(hint.block), false]));
    let logs: LogJson[] | null = null;
    const found = await sepoliaLogs(filter, hint.block, hint.block);
    if (!("refused" in found)) logs = ours(found.logs);
    else if (hint.txHash) {
      const receipt = (await sepolia("receipt", () => receiptOf(hint.txHash!, false))) as { logs?: LogJson[] } | null;
      if (receipt?.logs) logs = ours(receipt.logs);
    }
    if (logs && logs.length > 1) throw new Stop(`${logs.length} BurnRequested logs for burn ${n} in #${fmt(hint.block)}`);
    const l = logs?.[0];
    const hash = l?.blockHash?.toLowerCase();
    if (l && hash && canonical && hash === canonical.hash.toLowerCase() && Number(BigInt(l.blockNumber ?? "-1")) === hint.block && (!hint.blockHash || hash === hint.blockHash)) return burnOfLog(l);
    log(`     burn ${n}'s log is not in the canonical block #${fmt(hint.block)} where the round saw it${logs === null ? " (the RPC serves neither the logs nor the receipt there)" : ""}: searching for it`);
  }
  const recorded = b.record.steps.find((s) => s.kind === "burn" && s.ok && s.burn?.burnNonce === n.toString() && s.block !== null && s.block <= to);
  for (const [from, until] of recorded ? [[recorded.block!, recorded.block!], [b.deployBlock, to]] : [[b.deployBlock, to]]) {
    const found = await sepoliaLogs(filter, from, until);
    if ("refused" in found) throw new Stop(`the Sepolia RPC refuses eth_getLogs: ${found.refused}; set SEPOLIA_RPC_URL to an RPC that keeps the minter's logs from #${fmt(b.deployBlock)}`);
    const logs = found.logs.filter((l) => l.address.toLowerCase() === b.minter && !(l as { removed?: boolean }).removed);
    if (logs.length > 1) throw new Stop(`${logs.length} BurnRequested logs for burn ${n}`);
    if (logs.length === 1) return burnOfLog(logs[0]);
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// V3

/** The EVM RPC answered with an error. */
class EvmRpcError extends Error {
  override name = "EvmRpcError";

  constructor(
    readonly method: string,
    message: string,
    readonly code: number | undefined,
  ) {
    super(`${method}: ${message}${code === undefined ? "" : ` (code ${code})`}`);
  }
}

/** Ethereum JSON-RPC over HTTP (V3's EVM RPC); a request that gets no answer is tried 3 times, then it is Unreachable. */
class EvmRpc {
  private nextId = 1;

  constructor(readonly url: string) {}

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await fetch(this.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.json()) as { result?: T; error?: { code?: number; message?: string } };
        if (body.error) throw new EvmRpcError(method, body.error.message ?? "error", body.error.code);
        if (body.result === undefined) throw new Error("a response without a result");
        return body.result;
      } catch (error) {
        if (error instanceof EvmRpcError || error instanceof DryRunViolation) throw error;
        if (attempt === 3) throw new Unreachable(`the EVM RPC ${new URL(this.url).host} is unreachable (${method}: ${errorText(error)})`);
        await sleep(2_000);
      }
    }
  }

  async balance(address: Uint8Array, block: number): Promise<bigint> {
    return BigInt(await this.call<string>("eth_getBalance", [bytesToHex(address), qty(block)]));
  }

  /** eth_getLogs in windows of at most 10,000 blocks; null when the RPC refuses one. */
  async logs(filter: { address: Hex; topics: (string | string[] | null)[] }, from: number, to: number): Promise<LogJson[] | null> {
    const out: LogJson[] = [];
    for (const [a, z] of logWindows(from, to)) {
      try {
        out.push(...(await this.call<LogJson[]>("eth_getLogs", [{ ...filter, fromBlock: qty(a), toBlock: qty(z) }])));
      } catch (error) {
        if (error instanceof EvmRpcError) return null;
        throw error;
      }
    }
    return out;
  }
}

/**
 * Connects to the V3 node, or throws Unreachable after CONNECT_TIMEOUT. Unless `signs`, the
 * provider refuses author_submit* (and every other write method) before it reaches the socket.
 */
async function connectV3(url: string, signs: boolean): Promise<ApiPromise> {
  const { ApiPromise, WsProvider } = await polkadot();
  const provider = new WsProvider(url, 2_500, {}, 60_000);
  if (!signs) guardProvider(provider, new URL(url).host);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no connection after ${CONNECT_TIMEOUT / 1000} s`)), CONNECT_TIMEOUT);
  });
  try {
    return await Promise.race([
      ApiPromise.create({
        provider,
        noInitWarn: true,
        // Two transaction extensions polkadot-js does not know; in V3's metadata both are empty
        // structs with no implicit data, so they add nothing to the extrinsic or what it signs.
        signedExtensions: { AuthorizeCall: { extrinsic: {}, payload: {} }, EthSetOrigin: { extrinsic: {}, payload: {} } },
      }),
      timeout,
    ]);
  } catch (error) {
    await provider.disconnect().catch(() => undefined);
    throw new Unreachable(`the V3 node ${new URL(url).host} is unreachable (${errorText(error)})`);
  } finally {
    clearTimeout(timer);
  }
}

/** The node's identity: refuses another chain than the V3 testnet. */
async function checkV3(api: ApiPromise, evm: EvmRpc): Promise<void> {
  const genesis = api.genesisHash.toHex();
  const version = `${api.runtimeVersion.specName.toString()} ${api.runtimeVersion.specVersion.toNumber()}`;
  if (!check(genesis === V3.genesis, `genesis ${shortHex(genesis)} is ${V3.title}'s (${api.runtimeChain.toString()}, ${version})`)) {
    throw new Stop(`the node serves genesis ${genesis}, not ${V3.title} (a reset testnet?)`);
  }
  const reviveChainId = api.consts.revive.chainId.toBigInt();
  const evmChainId = BigInt(await evm.call<string>("eth_chainId"));
  if (!check(reviveChainId === V3.chainId && evmChainId === V3.chainId, `chain id ${V3.chainId} (pallet-revive ${reviveChainId}, EVM RPC ${evmChainId})`)) {
    throw new Stop("the chain id is not V3's");
  }
}

/** A constant the static types of @polkadot/api do not list. */
const constOf = (api: ApiPromise, pallet: string, name: string): string =>
  String((api.consts as unknown as Record<string, Record<string, { toString(): string } | undefined>>)[pallet]?.[name] ?? "");

type ApiAt = Awaited<ReturnType<ApiPromise["at"]>>;
type Codec = { toJSON(): unknown; toHex(): string; toU8a(): Uint8Array };

/** A runtime API call the static types do not list in V3's form (reviveApi's newer result types), at a block. */
const runtimeCall = (apiAt: ApiAt, section: string, method: string, ...args: unknown[]): Promise<Codec> =>
  (apiAt.call as unknown as Record<string, Record<string, (...a: unknown[]) => Promise<Codec>>>)[section][method](...args);

interface V3Head {
  number: number;
  hash: Hex;
  apiAt: ApiAt;
}

async function finalizedHead(api: ApiPromise): Promise<V3Head> {
  const hash = await api.rpc.chain.getFinalizedHead();
  const header = await api.rpc.chain.getHeader(hash);
  return { number: header.number.toNumber(), hash: hash.toHex(), apiAt: await api.at(hash) };
}

/** The word in the vault's storage at `slot` (reviveApi.getStorage); 0 for an empty slot. */
async function vaultWord(head: V3Head, vault: Uint8Array, slot: Uint8Array | bigint): Promise<bigint> {
  const key = typeof slot === "bigint" ? uintWord(slot) : slot;
  const r = (await runtimeCall(head.apiAt, "reviveApi", "getStorage", bytesToHex(vault), bytesToHex(key))).toJSON() as { ok?: string | null; err?: unknown };
  if (r.err !== undefined) throw new Stop(`reviveApi.getStorage(${checksumAddress(vault)}): ${JSON.stringify(r.err)}`);
  return r.ok ? BigInt(r.ok) : 0n;
}

/** The vault on chain: its code is the record's (so are its ratio and releaser, which the code holds), and pallet-revive's ratio is the record's. */
async function checkVault(api: ApiPromise, evm: EvmRpc, head: V3Head, v: VaultFacts): Promise<void> {
  const code = hexToBytes(await evm.call<Hex>("eth_getCode", [bytesToHex(v.address), qty(head.number)]));
  if (!check(bytesToHex(keccak_256(code)) === v.codeHash, `the vault ${checksumAddress(v.address)} has the code ${V3_RECORD} records (code hash ${shortHex(v.codeHash)}), with RELEASER ${checksumAddress(v.releaser)} and NATIVE_TO_ETH_RATIO ${v.ratio}`)) {
    throw new Stop("the vault on V3 is not the recorded one");
  }
  const ratio = api.consts.revive.nativeToEthRatio.toBigInt();
  if (!check(ratio === v.ratio, `pallet-revive's NativeToEthRatio is ${ratio}`)) throw new Stop("the ratio changed");
}

/** The committee on chain: reviveApi.address of the multisig is the releaser, and revive.originalAccount maps the releaser back to the multisig. */
async function checkCommittee(head: V3Head, v: VaultFacts): Promise<void> {
  const address = hexToBytes((await runtimeCall(head.apiAt, "reviveApi", "address", bytesToHex(v.multisigId))).toHex());
  const original = (await head.apiAt.query.revive.originalAccount(bytesToHex(v.releaser))) as unknown as { isSome: boolean; unwrap(): Codec };
  const mapped = original.isSome && equalBytes(original.unwrap().toU8a(), v.multisigId);
  if (!check(equalBytes(address, v.releaser) && mapped, `the committee ${v.multisig} (${v.threshold} of ${v.members.length}) is the RELEASER ${checksumAddress(v.releaser)}, mapped to it on chain`)) {
    throw new Stop("the multisig's address is not the vault's releaser, or the releaser is not mapped to the multisig");
  }
}

interface AccountState {
  nonce: number;
  free: bigint;
  reserved: bigint;
  exists: boolean;
}

async function accountState(apiAt: ApiAt, id: Uint8Array | string): Promise<AccountState> {
  const a = await apiAt.query.system.account(typeof id === "string" ? id : bytesToHex(id));
  return { nonce: a.nonce.toNumber(), free: a.data.free.toBigInt(), reserved: a.data.reserved.toBigInt(), exists: a.providers.toNumber() > 0 || a.sufficients.toNumber() > 0 };
}

/** What V3 and Sepolia say about the payee, and the account the vault's payout goes to. */
async function payeeFacts(evm: EvmRpc, head: V3Head, payee: Uint8Array, burner: Uint8Array | null): Promise<{ facts: PayeeFacts; account: Uint8Array; exists: boolean }> {
  const original = (await head.apiAt.query.revive.originalAccount(bytesToHex(payee))) as unknown as { isSome: boolean; unwrap(): Codec };
  const originalId = original.isSome ? original.unwrap().toU8a() : null;
  const code = hexToBytes(await evm.call<Hex>("eth_getCode", [bytesToHex(payee), qty(head.number)]));
  const v3Nonce = Number(BigInt(await evm.call<string>("eth_getTransactionCount", [bytesToHex(payee), qty(head.number)])));
  const sepoliaNonce = Number(BigInt(await sepolia("nonce", () => rpc<string>("eth_getTransactionCount", [bytesToHex(payee), "latest"]))));
  const sepoliaCode = hexToBytes(await sepolia("code", () => rpc<Hex>("eth_getCode", [bytesToHex(payee), "latest"])));
  const account = originalId ?? ethAccountId(payee);
  const state = await accountState(head.apiAt, account);
  return {
    facts: {
      original: originalId,
      contract: code.length > 0,
      sepoliaContract: sepoliaCode.length > 0 && !isDelegation(sepoliaCode),
      burner: burner !== null && equalBytes(burner, payee),
      sepoliaNonce,
      v3Nonce,
    },
    account,
    exists: state.exists,
  };
}

/** What a reviveApi.call dry run says, from its JSON form (V3's result type is newer than the static types). */
interface CallDryRun {
  refTime: bigint;
  proofSize: bigint;
  /** Positive: charged; negative: refunded. */
  storageDeposit: bigint;
  maxStorageDeposit: bigint;
  reverted: boolean;
  returned: Uint8Array;
  error: string | null;
}

const depositOf = (d: { charge?: number | string; refund?: number | string } | undefined): bigint =>
  d?.charge !== undefined ? BigInt(d.charge) : -BigInt(d?.refund ?? 0);

function readCallDryRun(api: ApiPromise, json: unknown): CallDryRun {
  const r = json as {
    weightRequired?: { refTime?: number | string; proofSize?: number | string };
    storageDeposit?: { charge?: number | string; refund?: number | string };
    maxStorageDeposit?: { charge?: number | string; refund?: number | string };
    result?: { ok?: { flags?: { bits?: number }; data?: string }; err?: unknown };
  };
  if (!r?.weightRequired || !r.storageDeposit || !r.result) throw new Stop(`reviveApi.call returned an unexpected result: ${JSON.stringify(json).slice(0, 200)}`);
  let error: string | null = null;
  if (r.result.err !== undefined) {
    const module = (r.result.err as { module?: { index: number; error: string } }).module;
    if (module) {
      const meta = api.registry.findMetaError(Uint8Array.of(module.index, hexToBytes(module.error)[0]));
      error = `${meta.section}.${meta.name}`;
    } else error = JSON.stringify(r.result.err);
  }
  const ok = r.result.ok;
  return {
    refTime: BigInt(r.weightRequired.refTime ?? 0),
    proofSize: BigInt(r.weightRequired.proofSize ?? 0),
    storageDeposit: depositOf(r.storageDeposit),
    maxStorageDeposit: depositOf(r.maxStorageDeposit ?? r.storageDeposit),
    reverted: ((ok?.flags?.bits ?? 0) & 1) === 1,
    returned: hexToBytes(ok?.data ?? "0x"),
    error,
  };
}

/** Why a dry run of the release failed, with the vault's error named; null when it passed. */
function dryRunProblem(d: CallDryRun): string | null {
  if (d.error) return d.error;
  if (d.reverted) return `the vault reverts${revertName(d.returned, VAULT_REVERTS) ? ` with ${revertName(d.returned, VAULT_REVERTS)}` : ` (${bytesToHex(d.returned)})`}`;
  return null;
}

const VAULT_REVERTS = errorMap(["ZeroArgument()", "NotReleaser()", "AlreadyReleased()", "ExceedsOutstanding()", "TransferFailed()"]);

/** reviveApi.call of the release from the multisig, with `limits` or without. */
async function dryRunRelease(api: ApiPromise, head: V3Head, v: VaultFacts, data: Uint8Array, limits?: { weightLimit: Weight; storageDepositLimit: bigint }): Promise<CallDryRun> {
  const json = (
    await runtimeCall(
      head.apiAt,
      "reviveApi",
      "call",
      v.multisig,
      bytesToHex(v.address),
      0,
      limits ? { refTime: limits.weightLimit.refTime, proofSize: limits.weightLimit.proofSize } : null,
      limits ? limits.storageDepositLimit : null,
      bytesToHex(data),
    )
  ).toJSON();
  return readCallDryRun(api, json);
}

// ---------------------------------------------------------------------------------------
// Extrinsics

interface Final {
  hash: Hex;
  parentHash: Hex;
  number: number;
  /** The extrinsic's index in its block. */
  index: number;
  records: EventRecord[];
  events: string[];
  dispatchError: string | null;
}

/** The node refused a submitted extrinsic, or dropped it from its pool: it was never included. */
class Rejected extends Stop {
  override name = "Rejected";
}

const eventText = (r: EventRecord) => `${r.event.section}.${r.event.method}`;

/**
 * Submits a signed extrinsic and waits for its block to be finalized; "pending" after FINAL_TIMEOUT,
 * when the node stops waiting for finality, when it reports the extrinsic invalid, dropped or
 * usurped after taking it, and at submission errors 1013 and 1014 (watch.ts submitErrorVerdict), as
 * it may still be included through another node: the record keeps it as submitted, and the next run
 * settles it by its nonce. Throws Rejected when the node refuses it at submission (1010 to 1012,
 * 1015 to 1019): it was never broadcast.
 */
async function submitAndWatch(api: ApiPromise, signed: SubmittableExtrinsic<"promise">): Promise<Final | "pending"> {
  type Outcome = { hash: Hex; index: number | undefined; records: EventRecord[]; dispatchError: string | null };
  const outcome = await new Promise<Outcome | "pending">((resolveOutcome, reject) => {
    let unsubscribe: (() => void) | null = null;
    let done = false;
    const finish = (value: Outcome | "pending" | Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe?.();
      if (value instanceof Error) reject(value);
      else resolveOutcome(value);
    };
    const timer = setTimeout(() => finish("pending"), FINAL_TIMEOUT);
    signed
      .send((result) => {
        const s = result.status;
        if (s.isInBlock) log(`     in block ${s.asInBlock.toHex()}`);
        if (s.isFinalized) {
          let dispatchError: string | null = null;
          if (result.dispatchError) {
            if (result.dispatchError.isModule) {
              const meta = api.registry.findMetaError(result.dispatchError.asModule);
              dispatchError = `${meta.section}.${meta.name}: ${meta.docs.join(" ")}`;
            } else dispatchError = result.dispatchError.toString();
          }
          finish({ hash: s.asFinalized.toHex(), index: (result as { txIndex?: number }).txIndex, records: [...result.events], dispatchError });
        } else if (s.isInvalid || s.isDropped || s.isUsurped) {
          log(`     the node reports the extrinsic ${s.type}; another node may still include it, so it stays submitted and the next run settles it by its nonce`);
          finish("pending");
        } else if (s.isFinalityTimeout) {
          log("     the node stopped waiting for its block to be finalized");
          finish("pending");
        } else if (s.isRetracted) {
          log("     retracted from its block; waiting for another");
        }
      })
      .then(
        (u) => {
          unsubscribe = u;
          if (done) u();
        },
        (error: unknown) => {
          const text = errorText(error);
          const verdict = submitErrorVerdict(text);
          if (verdict === "pending") log(`     the node answers ${text}; the extrinsic may still be included, so it stays submitted and the next run settles it by its nonce`);
          finish(verdict === "rejected" ? new Rejected(text) : verdict === "pending" ? "pending" : error instanceof Error ? error : new Error(text));
        },
      );
  });
  if (outcome === "pending") return outcome;
  const header = await api.rpc.chain.getHeader(outcome.hash);
  const index = outcome.index ?? (await locateIn(api, outcome.hash, signed.hash.toHex()));
  if (index === null) throw new Stop(`extrinsic ${signed.hash.toHex()} is not in block ${outcome.hash}`);
  return {
    hash: outcome.hash,
    parentHash: header.parentHash.toHex(),
    number: header.number.toNumber(),
    index,
    records: outcome.records,
    events: outcome.records.map(eventText),
    dispatchError: outcome.dispatchError,
  };
}

/** The index of extrinsic `hash` in block `blockHash`, or null. */
async function locateIn(api: ApiPromise, blockHash: string, hash: Hex): Promise<number | null> {
  const block = await api.rpc.chain.getBlock(blockHash);
  const i = block.block.extrinsics.findIndex((x) => x.hash.toHex() === hash);
  return i < 0 ? null : i;
}

/**
 * Where an extrinsic an earlier run submitted ended up: its block and events when it is in a final
 * block from the one after `submittedAfter` to the finalized head (`head`); "unknown" when its
 * sender's nonce is used at the finalized head and it is not in the blocks searched; "pending"
 * while the node's pool holds it or a block not final yet used the nonce; "dropped" otherwise.
 */
async function locate(api: ApiPromise, head: V3Head, e: { extrinsicHash: Hex; nonce: number; submittedAfter: number }, sender: string): Promise<Final | "pending" | "dropped" | "unknown"> {
  const until = Math.min(head.number, e.submittedAfter + SEARCH_BLOCKS);
  for (let n = e.submittedAfter + 1; n <= until; n++) {
    const blockHash = (await api.rpc.chain.getBlockHash(n)).toHex();
    const index = await locateIn(api, blockHash, e.extrinsicHash);
    if (index === null) continue;
    const header = await api.rpc.chain.getHeader(blockHash);
    const all = (await (await api.at(blockHash)).query.system.events()) as unknown as EventRecord[];
    const records = all.filter((r) => r.phase.isApplyExtrinsic && r.phase.asApplyExtrinsic.toNumber() === index);
    const failed = records.find((r) => r.event.section === "system" && r.event.method === "ExtrinsicFailed");
    let dispatchError: string | null = null;
    if (failed) {
      const err = failed.event.data[0] as unknown as { isModule: boolean; asModule: Parameters<ApiPromise["registry"]["findMetaError"]>[0]; toString(): string };
      if (err.isModule) {
        const meta = api.registry.findMetaError(err.asModule);
        dispatchError = `${meta.section}.${meta.name}: ${meta.docs.join(" ")}`;
      } else dispatchError = err.toString();
    }
    return { hash: blockHash as Hex, parentHash: header.parentHash.toHex(), number: n, index, records, events: records.map(eventText), dispatchError };
  }
  if ((await head.apiAt.query.system.account(sender)).nonce.toNumber() > e.nonce) return "unknown";
  // accountNextIndex counts the best block and the pool: above the nonce, the extrinsic (or another
  // with its nonce) is on its way to a final block.
  if ((await api.rpc.system.accountNextIndex(sender)).toNumber() > e.nonce) return "pending";
  const pool = await api.rpc.author.pendingExtrinsics();
  return pool.some((x) => x.hash.toHex() === e.extrinsicHash) ? "pending" : "dropped";
}

// ---------------------------------------------------------------------------------------
// Keys

type Pair = ReturnType<Keyring["addFromJson"]>;

/**
 * Member k's sr25519 pair from its polkadot-js JSON keystore, decoded with the password file (its
 * content less one trailing line end); refused unless it is `expected` and signs as it. Neither the
 * password nor any part of either file is printed, and errors are reported without their text.
 */
function loadMemberKey(keyFile: string, passwordFile: string, expected: string, keyring: Keyring): Pair {
  let json: { address?: unknown; encoded?: unknown; encoding?: { content?: unknown } };
  try {
    json = JSON.parse(readFileSync(keyFile, "utf8")) as typeof json;
  } catch {
    throw new Stop("--key-file could not be read as JSON");
  }
  if (typeof json.encoded !== "string" || !Array.isArray(json.encoding?.content) || !json.encoding.content.includes("sr25519")) throw new Stop("--key-file is not a polkadot-js sr25519 keystore");
  if (typeof json.address !== "string" || keyring.encodeAddress(keyring.decodeAddress(json.address), V3.ss58) !== expected) throw new Stop(`--key-file is not the keystore of ${expected}`);
  let password: string;
  try {
    password = readFileSync(passwordFile, "utf8").replace(/\r?\n$/, "");
  } catch {
    throw new Stop("--password-file could not be read");
  }
  let pair: Pair;
  try {
    pair = keyring.addFromJson(json as Parameters<Keyring["addFromJson"]>[0]);
    pair.decodePkcs8(password);
  } catch {
    throw new Stop("the password file does not open --key-file");
  }
  const message = new TextEncoder().encode("bridge-zero committee key check");
  if (!check(pair.address === expected && pair.verify(message, pair.sign(message), pair.publicKey), `the key file is member ${expected}'s, and signs as it`)) {
    throw new Stop(`--key-file holds ${pair.address}, not ${expected}`);
  }
  return pair;
}

/** The sr25519 pair of the key file's .substrate.mnemonic (v3-vault.ts deploy's format), refused unless it is `expected`. */
function loadMnemonicKey(path: string, expected: string, keyring: Keyring): ReturnType<Keyring["addFromMnemonic"]> {
  let mnemonic: unknown;
  try {
    mnemonic = (JSON.parse(readFileSync(path, "utf8")) as { substrate?: { mnemonic?: unknown } }).substrate?.mnemonic;
  } catch {
    throw new Stop("--key-file could not be read as JSON");
  }
  if (typeof mnemonic !== "string" || mnemonic.trim() === "") throw new Stop("--key-file has no .substrate.mnemonic");
  const words = mnemonic.trim().split(/\s+/);
  if (![12, 15, 18, 21, 24].includes(words.length)) throw new Stop("the .substrate.mnemonic in --key-file is not a phrase of 12, 15, 18, 21 or 24 words");
  let pair: ReturnType<Keyring["addFromMnemonic"]>;
  try {
    pair = keyring.addFromMnemonic(words.join(" "));
  } catch {
    throw new Stop("the .substrate.mnemonic in --key-file is not a valid BIP-39 phrase");
  }
  if (!check(pair.address === expected, `the key file's account (sr25519) is ${expected}`)) throw new Stop(`the key file's mnemonic derives ${pair.address}, not ${expected}`);
  return pair;
}

// ---------------------------------------------------------------------------------------
// burn

/** What a simulated burn left: the call, the sender's ETH balance after it, and the views after it. */
interface SimulatedBurn {
  call: { status: string; gasUsed: string; returnData: string; logs?: Log[]; error?: { message?: string; data?: string } };
  balanceAfter: bigint;
  views: { ok: boolean; data: Uint8Array }[];
  baseFee: bigint;
}

async function simulateBurn(p: { sender: Hex; nonce: number; minter: Hex; token: Hex; data: Uint8Array; gas: number; fees: Fees; burnNonce: bigint }, block: string): Promise<SimulatedBurn> {
  const fee = { maxFeePerGas: qty(p.fees.maxFee), maxPriorityFeePerGas: qty(p.fees.tip) };
  const views = [
    { to: p.token, data: callData(TOKEN.balanceOf, uintWord(BigInt(p.sender))) },
    { to: p.token, data: callData(TOKEN.totalSupply) },
    { to: p.minter, data: callData(MINTER.burnCount) },
    { to: p.minter, data: callData(MINTER.burnIdOf, uintWord(p.burnNonce)) },
  ];
  const calls = [
    { from: p.sender, to: p.minter, nonce: qty(p.nonce), gas: qty(p.gas), ...fee, data: bytesToHex(p.data) },
    { from: PROBE_SENDER, to: PROBE, gas: qty(PROBE_GAS), ...fee, data: bytesToHex(uintWord(BigInt(p.sender))) },
    ...views.map((x) => ({ from: PROBE_SENDER, to: x.to, gas: qty(VIEW_GAS), ...fee, data: bytesToHex(x.data) })),
  ];
  const stateOverrides = { [PROBE]: { code: PROBE_CODE }, [PROBE_SENDER]: { balance: qty(10n ** 18n) } };
  const blocks = await rpc<{ baseFeePerGas: string; calls: SimulatedBurn["call"][] }[]>("eth_simulateV1", [{ blockStateCalls: [{ stateOverrides, calls }], validation: true }, block]).catch((error: unknown) => {
    if (error instanceof DryRunViolation) throw error;
    if (offline(error)) throw new Unreachable(`Sepolia RPC unreachable (eth_simulateV1: ${errorText(error)})`);
    throw new Stop(`eth_simulateV1: ${errorText(error)}`);
  });
  const done = blocks[0].calls;
  if (done[1]?.status !== "0x1") throw new Stop(`the probe call failed: ${done[1]?.error?.message}`);
  return {
    call: done[0],
    balanceAfter: uintAt(hexToBytes(done[1].returnData), 1),
    views: done.slice(2).map((c) => ({ ok: c.status === "0x1", data: hexToBytes(c.returnData) })),
    baseFee: BigInt(blocks[0].baseFeePerGas),
  };
}

/** The checks of a burn's logs (a simulated call, or a receipt), as [passed, what]; the burn nonce the minter gave it. */
function burnLogChecks(logs: Log[] | undefined, b: Bridge, sender: Hex, v3Recipient: Uint8Array, amount: bigint, expectedNonce: bigint): { lines: [boolean, string][]; burn: BurnOnChain | null } {
  const lines: [boolean, string][] = [];
  const burns = (logs ?? []).filter((l) => l.address.toLowerCase() === b.minter && l.topics[0]?.toLowerCase() === BURN_REQUESTED_TOPIC);
  let burn: BurnOnChain | null = null;
  if (burns.length === 1) burn = burnOfLog(burns[0] as LogJson);
  const fields = burn !== null && bytesToHex(burn.from) === sender && equalBytes(burn.v3Recipient, v3Recipient) && burn.amount === amount;
  lines.push([
    burns.length === 1 && fields,
    burn
      ? `BurnRequested: burn ${burn.burnNonce}, ${formatWtpot(burn.amount)} from ${checksumAddress(burn.from)} for ${checksumAddress(burn.v3Recipient)} on V3`
      : `one BurnRequested log of the minter (${burns.length} found)`,
  ]);
  if (burn) {
    if (burn.burnNonce !== expectedNonce) log(`     note: another burn took nonce ${expectedNonce} first; this one is burn ${burn.burnNonce}`);
    const convention = burnId(SEPOLIA_CHAIN_ID, hexToBytes(b.minter), burn.burnNonce);
    lines.push([equalBytes(burn.burnId, convention), `its burn id ${bytesToHex(burn.burnId)} is the vault's convention keccak256(abi.encode(BURN_TAG, 11155111, minter, ${burn.burnNonce}))`]);
  }
  const transfer = findLog(logs, b.token, TRANSFER_TOPIC, bytesToHex(uintWord(BigInt(sender))));
  let burned = false;
  if (transfer) {
    const t = decodeTransfer(transfer as LogJson);
    burned = t.to.every((x) => x === 0) && t.value === amount;
  }
  lines.push([burned, `Transfer of ${formatWtpot(amount)} from ${checksumAddress(hexToBytes(sender))} to the zero address`]);
  return { lines, burn };
}

/**
 * Settles the burns an earlier --send run left open in the record (hash set, block not): a mined
 * one is checked and completed, one the node still holds stops the run (PENDING), one that is
 * neither is marked dropped. Returns how many it found mined.
 */
async function settleOpenBurns(b: Bridge): Promise<number | typeof PENDING> {
  let mined = 0;
  for (const entry of b.record.steps.filter((s) => s.kind === "burn" && s.txHash !== null && s.block === null)) {
    const receipt = await sepolia("receipt", () => receiptOf(entry.txHash!, false));
    if (receipt) {
      log(`     settling ${entry.txHash}, burned by an earlier run:`);
      await completeBurn(b, entry, receipt);
      mined += 1;
      continue;
    }
    const n = await sepolia("nonces", () => nonces(entry.sender));
    if (n.latest <= entry.nonce && n.pending > n.latest) {
      log(`     ${entry.txHash}, burned by an earlier run, is still pending: nothing more is sent until it is mined`);
      return PENDING;
    }
    entry.dropped = [...(entry.dropped ?? []), entry.txHash!];
    entry.txHash = null;
    entry.ok = false;
    entry.note = n.latest > entry.nonce ? `nonce ${entry.nonce} was used by another transaction` : `neither mined nor pending at ${new Date().toISOString()}`;
    saveBridge(b.record);
    log(`     ${entry.dropped.at(-1)}, burned by an earlier run, was never mined (${entry.note})`);
  }
  return mined;
}

/** Checks a mined burn against its entry and completes it in the record; true when it passed. */
async function completeBurn(b: Bridge, entry: BridgeStep, receipt: Receipt): Promise<boolean> {
  const status = Number(BigInt(receipt.status));
  const block = Number(BigInt(receipt.blockNumber));
  const lines: [boolean, string][] = [[status === 1, `${receipt.transactionHash}: status ${status}, block ${fmt(block)}, ${share(gasOf(receipt))} (simulated ${fmt(entry.simulatedGas ?? 0)})`]];
  const facts = entry.burn!;
  const { lines: logLines, burn } = burnLogChecks(receipt.logs, b, entry.sender, hexToBytes(facts.v3Recipient), BigInt(facts.amount), BigInt(facts.expected.burnNonce));
  lines.push(...logLines);
  if (burn) {
    const viaView = wordAt(await sepoliaView(b.minter, callData(MINTER.burnIdOf, uintWord(burn.burnNonce)), receipt.blockNumber), 0);
    lines.push([equalBytes(viaView, burn.burnId), `burnIdOf(${burn.burnNonce}) at its block is the same id`]);
  }
  let ok = true;
  for (const [k, what] of lines) ok = check(k, what) && ok;
  Object.assign(entry, {
    txHash: receipt.transactionHash,
    block,
    gasUsed: gasOf(receipt),
    status,
    effectiveGasPrice: BigInt(receipt.effectiveGasPrice ?? 0).toString(),
    ok,
    burn: { ...facts, burnNonce: burn ? burn.burnNonce.toString() : null, burnId: burn ? bytesToHex(burn.burnId) : null },
  });
  saveBridge(b.record);
  return ok;
}

async function burnCommand(o: BurnOptions): Promise<number> {
  log(`${new Date().toISOString()}: burning ${formatWtpot(o.amount)} on Sepolia for ${checksumAddress(o.v3Recipient)} on V3${o.send ? "" : " (dry run)"}`);
  log(`     the return path is ${TRUST}`);
  const b = readBridge();
  let sender: Hex = b.deployer;
  if (o.send) {
    const unlocked = keystoreAddress(o.account!, o.passwordFile!);
    if (!unlocked) return FAILED;
    sender = unlocked.toLowerCase() as Hex;
  } else sender = bytesToHex(o.from ?? hexToBytes(DEFAULT_SENDER));

  await checkSepolia();
  // What an earlier --send run left open is settled first, so that the plan starts from the chain as it is.
  const settled = await settleOpenBurns(b);
  if (settled === PENDING) return PENDING;
  const block = await sepolia("latest block", () => rpc<{ number: string; hash: string }>("eth_getBlockByNumber", ["latest", false]));
  const fees = await sepolia("fees", () => feesAt(block, { priorityFee: o.priorityFee, maxFee: o.maxFee }));
  const state = await sepoliaState(b, block.number);
  const n = state.burnCount;
  const balanceOf = async (address: Hex) => uintAt(await sepoliaView(b.token, callData(TOKEN.balanceOf, uintWord(BigInt(address))), block.number), 0);
  const wtpot = await balanceOf(sender);
  const ethBalance = BigInt(await sepolia("balance", () => rpc<string>("eth_getBalance", [sender, block.number])));
  const nonce = Number(BigInt(await sepolia("nonce", () => rpc<string>("eth_getTransactionCount", [sender, block.number]))));
  log(`Sepolia block ${fmt(Number(BigInt(block.number)))} (${block.hash}), simulated on top of it via ${new URL(RPC).host}`);
  log(`BridgeMinter ${checksumAddress(hexToBytes(b.minter))}: ${n} burn${n === 1n ? "" : "s"} so far; WrappedTPOT ${checksumAddress(hexToBytes(b.token))}: total supply ${formatWtpot(state.totalSupply)}`);
  log(`Sender ${checksumAddress(hexToBytes(sender))}${o.send ? ` (keystore ${o.account})` : o.from ? " (--from)" : ""}: nonce ${nonce}, ${formatWtpot(wtpot)}, ${eth(ethBalance)}`);
  if (!check(wtpot >= o.amount, `the sender holds ${formatWtpot(wtpot)}, at least the ${formatWtpot(o.amount)} it burns`)) return FAILED;

  // The burn id the minter will give it, by the view and by the vault's convention.
  const id = burnId(SEPOLIA_CHAIN_ID, hexToBytes(b.minter), n);
  const viaView = wordAt(await sepoliaView(b.minter, callData(MINTER.burnIdOf, uintWord(n)), block.number), 0);
  check(equalBytes(viaView, id), `burn ${n} will carry burn id ${bytesToHex(id)}: burnIdOf(${n}) and the vault's convention agree`);

  // The payee on V3: the committee releases only to an address someone controls, and the burn cannot be undone.
  const keyring = new (await polkadot()).Keyring({ type: "sr25519", ss58Format: V3.ss58 });
  const vault = vaultFacts(readV3Record(), keyring);
  const evm = new EvmRpc(o.evm);
  const api = await connectV3(o.rpc, false);
  try {
    await checkV3(api, evm);
    const head = await finalizedHead(api);
    const payee = await payeeFacts(evm, head, o.v3Recipient, hexToBytes(sender));
    const verdict = payeeVerdict(payee.facts);
    if (!check(verdict.ok, `the V3 recipient ${checksumAddress(o.v3Recipient)} is ${verdict.why}`)) {
      log("\nThe committee would refuse to release to it, and a burn cannot be undone: nothing is burned. Name an address you control on V3.");
      return FAILED;
    }
    const outstanding = await vaultWord(head, vault.address, SLOTS.outstanding);
    if (!check(outstanding >= o.amount, `the vault's outstanding on V3 is ${formatTpot(outstanding)}, at least the amount`)) return FAILED;
    // The release this burn asks for, dry-run from the multisig now: a payee the vault cannot pay is found before the burn, not after.
    const data = releaseCall(vault.address, { burnId: id, to: o.v3Recipient, amountNative: o.amount }, { weightLimit: { refTime: 0n, proofSize: 0n }, storageDepositLimit: 0n }).data;
    const problem = dryRunProblem(await dryRunRelease(api, head, vault, data));
    if (!check(problem === null, `the release of this burn runs on V3 from the multisig${problem ? `: ${problem}` : ""}`)) {
      log("\nThe committee could not release it as things stand on V3, and a burn cannot be undone: nothing is burned.");
      return FAILED;
    }
  } finally {
    await api.disconnect();
  }

  // The dry run: the cap as gas limit, then the limit it is sent with.
  const data = burnCalldata(o.amount, o.v3Recipient);
  const errors = errorMap(BRIDGE_ERRORS);
  log(`\nFees: next base fee ${fmt(fees.base)} wei, priority fee ${fmt(fees.tip)} wei, max fee ${fmt(fees.maxFee)} wei (node gas price ${fmt(fees.gasPrice)} wei)`);
  const run = (gas: number) => simulateBurn({ sender, nonce, minter: b.minter, token: b.token, data, gas, fees, burnNonce: n }, block.number);
  const first = await run(CAP);
  if (first.call.status !== "0x1") {
    const revert = first.call.error?.data ?? first.call.returnData;
    const name = /^0x([0-9a-fA-F]{2})*$/.test(revert ?? "") ? revertName(hexToBytes(revert), errors) : null;
    check(false, `burn(${o.amount}, ${checksumAddress(o.v3Recipient)}) ${name ? `reverts with ${name}` : (first.call.error?.message ?? `status ${first.call.status}`)}`);
    return FAILED;
  }
  const gas = gasOf(first.call);
  const gasLimit = withHeadroom(gas);
  const second = await run(gasLimit);
  check(second.call.status === "0x1" && gasOf(second.call) === gas, `burn(${o.amount}, ${checksumAddress(o.v3Recipient)}): ${share(gas)} with the cap and with gas limit ${fmt(gasLimit)}`);
  const { lines } = burnLogChecks(second.call.logs, b, sender, o.v3Recipient, o.amount, n);
  for (const [ok, what] of lines) check(ok, `     ${what}`);
  const [balanceAfter, supplyAfter, countAfter, idAfter] = second.views.map((x) => x.data);
  if (second.views.every((x) => x.ok)) {
    check(uintAt(balanceAfter, 0) === wtpot - o.amount, `     the sender's wtPOT after: ${formatWtpot(uintAt(balanceAfter, 0))}`);
    check(uintAt(supplyAfter, 0) === state.totalSupply - o.amount, `     wtPOT total supply after: ${formatWtpot(uintAt(supplyAfter, 0))}`);
    check(uintAt(countAfter, 0) === n + 1n && equalBytes(wordAt(idAfter, 0), id), `     burnCount after: ${uintAt(countAfter, 0)}; burnIdOf(${n}) ${shortHex(wordAt(idAfter, 0))}`);
  } else check(false, "     the views after the burn were not read");
  const paid = ethBalance - second.balanceAfter;
  const most = BigInt(gasLimit) * fees.maxFee;
  check(most <= ethBalance, `the sender pays ${eth(paid)} at the current fees (base fee ${fmt(second.baseFee)} wei + priority fee, as simulated); at most ${eth(most)} at the max fee; it has ${eth(ethBalance)}`);
  if (failures > 0) {
    log("\nThe dry run failed: nothing is sent.");
    return FAILED;
  }
  if (!o.send) {
    log(`\nThe dry run passed. Nothing was signed or sent. Once sent and final on Sepolia, the committee releases it on V3: npm run release -- release --burn-nonce ${n}`);
    return OK;
  }

  // --send. A burn an earlier run left open and this run found mined may be the one asked for again.
  if (settled > 0) {
    log(`\n${settled} burn${settled === 1 ? "" : "s"} an earlier run sent ${settled === 1 ? "was" : "were"} mined: nothing more is burned in this run. Run it again to burn again.`);
    return failures === 0 ? OK : FAILED;
  }
  const n2 = await sepolia("nonces", () => nonces(sender));
  if (n2.latest !== n2.pending) throw new Stop(`the sender has pending transactions (nonce ${n2.latest}, pending ${n2.pending}): wait until they are mined`);
  if (n2.latest !== nonce) throw new Stop(`the sender's nonce moved from ${nonce} to ${n2.latest} since the dry run: run again`);
  const dataHash = bytesToHex(keccak_256(data));
  const reusable = b.record.steps.find((s) => s.sender === sender && s.nonce === nonce);
  if (reusable && (reusable.kind !== "burn" || reusable.dataHash !== dataHash || reusable.txHash !== null)) throw new Stop(`${BRIDGE_RECORD} has another transaction at nonce ${nonce} of ${sender} (${reusable.name}): look at it before sending`);
  const entry: BridgeStep = reusable ?? {
    name: `burn ${formatWtpot(o.amount)} for ${checksumAddress(o.v3Recipient)} on V3`,
    kind: "burn",
    nonce,
    sender,
    contract: "src/bridge/BridgeMinter.sol:BridgeMinter",
    address: b.minter,
    burn: { amount: o.amount.toString(), v3Recipient: bytesToHex(o.v3Recipient), expected: { burnNonce: n.toString(), burnId: bytesToHex(id) }, burnNonce: null, burnId: null },
    dataHash,
    gasLimit: null,
    simulatedGas: null,
    codeHash: null,
    txHash: null,
    signedAt: null,
    block: null,
    gasUsed: null,
    effectiveGasPrice: null,
    status: null,
    ok: null,
  };
  if (!reusable) b.record.steps.push(entry);
  Object.assign(entry, { gasLimit, simulatedGas: gas, ok: null });
  saveBridge(b.record);
  if (!(await nextNonceIs(sender, nonce))) return FAILED;
  const args = mktxArgs(entry.name, { to: b.minter, data: bytesToHex(data), nonce, gasLimit, fees, account: o.account!, passwordFile: o.passwordFile! });
  const hash = signAndPublish(args, entry.name, (signed) => {
    log(`     burn: signed ${signed}, gas limit ${fmt(gasLimit)}`);
    Object.assign(entry, { txHash: signed, signedAt: new Date().toISOString() });
    saveBridge(b.record);
  });
  if (!hash) return FAILED;
  const receipt = await sepolia("receipt", () => receiptOf(hash, true));
  if (!receipt) {
    log(`     ${hash} is not mined yet; run again to settle it (${BRIDGE_RECORD} keeps it as signed)`);
    return PENDING;
  }
  const ok = await completeBurn(b, entry, receipt);
  if (ok) {
    log(`\nBurn ${entry.burn!.burnNonce} is mined and checked; ${BRIDGE_RECORD} records it. Once Sepolia finalizes its block (about 13 minutes), the committee releases it on V3:`);
    log(`     npm run release -- release --burn-nonce ${entry.burn!.burnNonce}`);
  }
  return ok ? OK : FAILED;
}

// ---------------------------------------------------------------------------------------
// release

/** A burn to release: the one on Sepolia, or, for a rehearsal, the one --amount and --to describe. */
interface BurnToRelease {
  /** Its block is final at the block it was read at (always, without fast mode). */
  final: boolean;
  burnNonce: bigint;
  burnId: Uint8Array;
  from: Uint8Array | null;
  v3Recipient: Uint8Array;
  amount: bigint;
  txHash: Hex | null;
  block: number | null;
  /** The log's block hash, when the RPC gave it. */
  blockHash: Hex | null;
}

/** An open multisig operation of the committee, with its call when the record or the chain has it. */
interface Operation {
  hash: Hex;
  when: Timepoint;
  deposit: bigint;
  depositor: Uint8Array;
  approvals: Uint8Array[];
  call: Uint8Array | null;
  source: string;
  revive: ReviveCall | null;
  release: Release | null;
}

/** multisig.multisigs of the committee at the head, each with its call: the record's, or the first approval's on chain (an asMulti carries it in full). */
async function operations(api: ApiPromise, head: V3Head, v: VaultFacts, record: VaultRecord, index: Uint8Array): Promise<Operation[]> {
  const entries = await head.apiAt.query.multisig.multisigs.entries(bytesToHex(v.multisigId));
  const out: Operation[] = [];
  for (const [key, value] of entries) {
    const hash = (key.args[1] as unknown as Codec).toHex() as Hex;
    const m = (value as unknown as { unwrap(): { when: { height: { toNumber(): number }; index: { toNumber(): number } }; deposit: { toBigInt(): bigint }; depositor: Codec; approvals: Codec[] } }).unwrap();
    const op: Operation = {
      hash,
      when: { height: m.when.height.toNumber(), index: m.when.index.toNumber() },
      deposit: m.deposit.toBigInt(),
      depositor: m.depositor.toU8a(),
      approvals: [...m.approvals].map((a) => a.toU8a()),
      call: null,
      source: "none",
      revive: null,
      release: null,
    };
    const recorded = (record.releases ?? []).find((r) => r.call.hash === hash);
    if (recorded) {
      op.call = hexToBytes(recorded.call.hex);
      op.source = V3_RECORD;
    } else {
      const block = await api.rpc.chain.getBlock(await api.rpc.chain.getBlockHash(op.when.height));
      const x = block.block.extrinsics[op.when.index];
      if (x && x.method.section === "multisig" && x.method.method === "asMulti") {
        op.call = (x.method.args[3] as unknown as Codec).toU8a();
        op.source = `the first approval's extrinsic, #${fmt(op.when.height)} index ${op.when.index}`;
      }
    }
    if (op.call && bytesToHex(callHash(op.call)) !== hash) {
      op.call = null;
      op.source = "a call that does not hash to the operation's";
    }
    if (op.call) {
      try {
        op.revive = decodeReviveCall(op.call, index);
        if (equalBytes(op.revive.dest, v.address) && op.revive.value === 0n) op.release = decodeReleaseCalldata(op.revive.data);
      } catch {
        op.release = null;
      }
    }
    out.push(op);
  }
  return out;
}

/** Member k (1 to 3) of an account id, or null. */
const memberOf = (v: VaultFacts, keyring: Keyring, id: Uint8Array): number | null => {
  const i = v.members.findIndex((m) => equalBytes(keyring.decodeAddress(m), id));
  return i < 0 ? null : i + 1;
};

/** The release round of call `hash` in the record that is not over, or a new one. */
function roundOf(record: VaultRecord, hash: Hex, fresh: () => ReleaseEntry): ReleaseEntry {
  record.releases ??= [];
  const found = record.releases.find((r) => r.call.hash === hash && r.status === "open");
  if (found) return found;
  const entry = fresh();
  record.releases.push(entry);
  return entry;
}

const resultText = (api: ApiPromise, result: unknown): string => {
  const r = result as { isOk: boolean; isErr: boolean; asErr: { isModule: boolean; asModule: Parameters<ApiPromise["registry"]["findMetaError"]>[0]; toString(): string } };
  if (r.isOk) return "Ok";
  if (r.asErr.isModule) {
    const meta = api.registry.findMetaError(r.asErr.asModule);
    return `${meta.section}.${meta.name}`;
  }
  return r.asErr.toString();
};

/**
 * The checks of an approval that is final: ExtrinsicSuccess; for an opening, NewMultisig and the
 * operation in storage at its block (the timepoint, the depositor, the deposit); for the
 * execution, MultisigExecuted with result Ok, the vault's ContractEmitted Released event, then
 * released[burnId], outstanding and the payee's EVM balance at the block, and the Released log
 * through eth_getLogs; for a cancellation, MultisigCancelled and the operation gone.
 */
async function checkApproval(
  ctx: { api: ApiPromise; evm: EvmRpc; keyring: Keyring; v: VaultFacts; burn: { burnId: Uint8Array; payee: Uint8Array; amount: bigint } },
  round: ReleaseEntry,
  approval: ApprovalEntry,
  final: Final,
): Promise<boolean> {
  const { api, evm, keyring, v } = ctx;
  approval.block = { number: final.number, hash: final.hash, index: final.index };
  approval.events = final.events;
  const paid = final.records.find((r) => r.event.section === "transactionPayment" && r.event.method === "TransactionFeePaid");
  approval.fee = paid ? BigInt(paid.event.data[1].toString()).toString() : null;
  let ok = check(final.events.includes("system.ExtrinsicSuccess"), `${approval.extrinsicHash}: final in block #${fmt(final.number)} ${final.hash}, index ${final.index}${approval.fee ? `, fee ${formatTpot(BigInt(approval.fee))}` : ""}${final.dispatchError ? `: ${final.dispatchError}` : ""}`);
  const member = keyring.decodeAddress(approval.account);
  const find = (method: string) => final.records.find((r) => r.event.section === "multisig" && r.event.method === method);
  const apiAt = await api.at(final.hash);
  const stored = await apiAt.query.multisig.multisigs(bytesToHex(v.multisigId), round.call.hash);
  if (approval.action === "open") {
    const e = find("NewMultisig");
    ok = check(!!e && equalBytes((e.event.data[0] as unknown as Codec).toU8a(), member) && equalBytes((e.event.data[1] as unknown as Codec).toU8a(), v.multisigId) && (e.event.data[2] as unknown as Codec).toHex() === round.call.hash, `multisig.NewMultisig: member ${approval.member} opens ${shortHex(round.call.hash)} for ${v.multisig}`) && ok;
    const m = (stored as unknown as { isSome: boolean; unwrap(): { when: { height: { toNumber(): number }; index: { toNumber(): number } }; deposit: { toBigInt(): bigint }; depositor: Codec } });
    const when = m.isSome ? { height: m.unwrap().when.height.toNumber(), index: m.unwrap().when.index.toNumber() } : null;
    ok = check(when !== null && when.height === final.number && when.index === final.index && equalBytes(m.unwrap().depositor.toU8a(), member), `multisig.multisigs holds it at timepoint #${fmt(final.number)} index ${final.index}, deposit ${m.isSome ? formatTpot(m.unwrap().deposit.toBigInt()) : "none"} reserved from member ${approval.member}`) && ok;
    if (when) Object.assign(round.multisig, { timepoint: when, depositor: approval.account, deposit: m.unwrap().deposit.toBigInt().toString() });
    // Nothing is open on chain when the opening failed.
    if (!m.isSome) round.status = "failed";
    return ok;
  }
  const gone = (stored as unknown as { isNone: boolean }).isNone;
  if (approval.action === "cancel") {
    const e = find("MultisigCancelled");
    ok = check(!!e && (e.event.data[3] as unknown as Codec).toHex() === round.call.hash, `multisig.MultisigCancelled: ${shortHex(round.call.hash)}`) && ok;
    ok = check(gone, "the operation is gone from multisig.multisigs; its deposit is back with the depositor") && ok;
    if (gone) round.status = "cancelled";
    return ok;
  }
  // The execution.
  const e = find("MultisigExecuted");
  const result = e ? resultText(api, e.event.data[4]) : "no event";
  approval.result = result;
  ok = check(!!e && result === "Ok" && (e.event.data[3] as unknown as Codec).toHex() === round.call.hash, `multisig.MultisigExecuted: ${shortHex(round.call.hash)}, result ${result}`) && ok;
  const emitted = final.records.filter((r) => r.event.section === "revive" && r.event.method === "ContractEmitted");
  const released = emitted.find((r) => {
    const [contract, data, topics] = r.event.data as unknown as [Codec, Codec, Codec[]];
    return equalBytes(contract.toU8a(), v.address) && [...topics].length === 3 && [...topics][0].toHex() === RELEASED_TOPIC;
  });
  let eventOk = false;
  if (released) {
    const [, data, topics] = released.event.data as unknown as [Codec, { toU8a(isBare: boolean): Uint8Array }, Codec[]];
    const r = decodeReleased({ address: bytesToHex(v.address), topics: [...topics].map((t) => t.toHex()), data: bytesToHex(data.toU8a(true)) });
    eventOk = equalBytes(r.burnId, ctx.burn.burnId) && equalBytes(r.to, ctx.burn.payee) && r.amountNative === ctx.burn.amount;
  }
  ok = check(eventOk, `revive.ContractEmitted by the vault: Released(${shortHex(ctx.burn.burnId)}, ${checksumAddress(ctx.burn.payee)}, ${formatTpot(ctx.burn.amount)})`) && ok;
  ok = check(gone, "the operation is gone from multisig.multisigs, and the depositor's deposit is unreserved") && ok;
  const atBlock: V3Head = { number: final.number, hash: final.hash, apiAt };
  const parentAt: V3Head = { number: final.number - 1, hash: final.parentHash, apiAt: await api.at(final.parentHash) };
  const flag = await vaultWord(atBlock, v.address, releasedSlot(ctx.burn.burnId));
  const before = await vaultWord(parentAt, v.address, SLOTS.outstanding);
  const after = await vaultWord(atBlock, v.address, SLOTS.outstanding);
  ok = check(flag === 1n, `released[${shortHex(ctx.burn.burnId)}] is true at #${fmt(final.number)}`) && ok;
  ok = check(before - after === ctx.burn.amount, `outstanding went from ${formatTpot(before)} to ${formatTpot(after)}`) && ok;
  // The payout, from the payee's account at the block and its parent: the node keeps that state, while V3's EVM RPC
  // answers "State already discarded" once the block is about 256 blocks old. The free balance goes up by the amount,
  // and by the existential deposit too where the release creates the account.
  const original = (await apiAt.query.revive.originalAccount(bytesToHex(ctx.burn.payee))) as unknown as { isSome: boolean; unwrap(): Codec };
  const account = original.isSome ? original.unwrap().toU8a() : ethAccountId(ctx.burn.payee);
  const was = await accountState(parentAt.apiAt, account);
  const credited = (await accountState(apiAt, account)).free - was.free;
  const ed = api.consts.balances.existentialDeposit.toBigInt();
  ok = check(credited === ctx.burn.amount + (was.exists ? 0n : ed), `System.Account: the payee's free balance went up by ${formatTpot(credited)}, the amount${was.exists ? "" : ` plus the existential deposit ${formatTpot(ed)} of the account the release created`}`) && ok;
  // The same through the EVM RPC, while it still serves that state.
  const value = evmValue(ctx.burn.amount, v.ratio);
  let received: bigint | null = null;
  try {
    received = (await evm.balance(ctx.burn.payee, final.number)) - (await evm.balance(ctx.burn.payee, final.number - 1));
  } catch (error) {
    if (!(error instanceof EvmRpcError)) throw error;
    warn(`the EVM RPC does not serve the state of #${fmt(final.number)} any more (${errorText(error)}): the System.Account check above stands for it`);
  }
  if (received !== null) ok = check(received === value, `the payee's balance through the EVM RPC went up by ${fmt(received)} wei (${formatEvmTpot(received, v.ratio)}), amount x ${v.ratio}`) && ok;
  const logs = await evm.logs({ address: bytesToHex(v.address), topics: [RELEASED_TOPIC, bytesToHex(ctx.burn.burnId)] }, final.number, final.number);
  const served = logs !== null && logs.length === 1 && equalBytes(decodeReleased(logs[0]).to, ctx.burn.payee) && decodeReleased(logs[0]).amountNative === ctx.burn.amount;
  if (served) check(true, "the Released log through eth_getLogs");
  else warn("eth_getLogs does not return the Released log: V3's EVM RPC serves the logs of Ethereum transactions, and the release is a Substrate extrinsic (multisig.asMulti dispatching revive.call); the ContractEmitted event above is the vault's Released event");
  round.released = { block: { number: final.number, hash: final.hash }, outstandingAfter: after.toString(), payeeCredited: credited.toString(), payeeReceived: received === null ? null : received.toString(), releasedLog: served ? "eth_getLogs" : "not served" };
  // The record follows the chain: released once released[burnId] is set (a failed check says
  // what else is wrong); an execution whose extrinsic failed leaves the operation open,
  // approved by its opener.
  round.status = flag === 1n ? "released" : gone ? "failed" : "open";
  if (round.status !== "released") delete round.released;
  return ok;
}

/** Settles the approvals and funding transfers an earlier --send run left submitted; PENDING while one is still on its way, Stop when one cannot be found. */
async function settleSubmitted(api: ApiPromise, evm: EvmRpc, keyring: Keyring, v: VaultFacts, record: VaultRecord): Promise<number> {
  const head = await finalizedHead(api);
  for (const round of record.releases ?? []) {
    for (const approval of round.approvals.filter((a) => a.status === "submitted")) {
      log(`     settling ${approval.action} ${approval.extrinsicHash} of member ${approval.member}, submitted by an earlier run:`);
      const where = await locate(api, head, approval, approval.account);
      if (where === "pending") {
        log("     it is still in the node's pool: nothing more is sent until it is final");
        return PENDING;
      }
      if (where === "unknown") throw new Stop(`member ${approval.member}'s nonce ${approval.nonce} is used, but ${approval.extrinsicHash} is not in blocks #${fmt(approval.submittedAfter + 1)} to #${fmt(Math.min(head.number, approval.submittedAfter + SEARCH_BLOCKS))}: look at the member's extrinsics`);
      if (where === "dropped") {
        approval.status = "dropped";
        approval.note = `never included (checked at #${fmt(head.number)})`;
        if (round.approvals.every((a) => a.status !== "final")) round.status = "failed";
        saveV3Record(record);
        log("     it was never included");
        continue;
      }
      const burn = { burnId: hexToBytes(round.burn.burnId), payee: hexToBytes(round.payee), amount: BigInt(round.amountNative) };
      // One entry that cannot be checked does not hold up every command: it stays submitted and the next run checks it
      // again. The commands read the multisig from the chain, and what the check wrote so far is read from the chain too.
      try {
        approval.status = (await checkApproval({ api, evm, keyring, v, burn }, round, approval, where)) ? "final" : "failed";
      } catch (error) {
        if (error instanceof Unreachable) throw error;
        warn(`${approval.extrinsicHash} is final in #${fmt(where.number)}, but its checks stopped (${errorText(error)}): it stays submitted, and the next run checks it again`);
        continue;
      }
      saveV3Record(record);
    }
  }
  for (const f of (record.committeeFunding ?? []).filter((x) => x.status === "submitted")) {
    log(`     settling the transfer ${f.extrinsicHash} to ${f.to}, submitted by an earlier run:`);
    const where = await locate(api, head, f, f.from);
    if (where === "pending") return PENDING;
    if (where === "unknown") throw new Stop(`${f.from}'s nonce ${f.nonce} is used, but ${f.extrinsicHash} is not in the blocks searched: look at its extrinsics`);
    if (where === "dropped") f.status = "dropped";
    else {
      f.block = { number: where.number, hash: where.hash, index: where.index };
      f.status = check(where.events.includes("system.ExtrinsicSuccess") && where.events.includes("balances.Transfer"), `final in #${fmt(where.number)}: ${where.events.join(", ")}`) ? "final" : "failed";
    }
    saveV3Record(record);
  }
  return OK;
}

/** The deployments a release reads: the bridge on Sepolia, the vault and its committee on V3. */
interface Deployed {
  b: Bridge;
  record: VaultRecord;
  keyring: Keyring;
  v: VaultFacts;
}

async function deployed(): Promise<Deployed> {
  const b = readBridge();
  const record = readV3Record();
  const { Keyring } = await polkadot();
  const keyring = new Keyring({ type: "sr25519", ss58Format: V3.ss58 });
  return { b, record, keyring, v: vaultFacts(record, keyring) };
}

const ruleText = (rule: Rule, watch = false) =>
  rule.confirmations === null
    ? "the burn is read at Sepolia's finalized block"
    : `${tradeOff(rule.confirmations)}. A burn of at most --fast-cap ${formatTpot(rule.fastCap)} is read ${rule.confirmations} block${rule.confirmations === 1 ? "" : "s"} below Sepolia's latest; a larger one waits for finality` +
      (watch ? `, and so does one that would take the burns released fast whose blocks are not final yet above --fast-budget ${formatTpot(rule.fastBudget)} in all` : "");

async function releaseCommand(o: ReleaseOptions): Promise<number> {
  const what = o.action === "approve" ? `member ${o.member}'s approval of` : o.action === "cancel" ? `member ${o.member}'s cancellation of` : "the release of";
  log(`${new Date().toISOString()}: ${what} burn ${o.burnNonce} on ${V3.title}${o.rehearse ? " (rehearsal)" : ""}${o.send ? "" : " (dry run)"}`);
  log(`     the return path is ${TRUST}`);
  if (o.rule.confirmations !== null) log(`     ${ruleText(o.rule)}`);
  const d = await deployed();
  const burn = await burnOnSepolia(d, o);
  if (typeof burn === "number") return burn;
  const evm = new EvmRpc(o.evm);
  const api = await connectV3(o.rpc, o.send);
  try {
    return await releaseOnV3(d, api, evm, o, burn);
  } finally {
    await api.disconnect();
  }
}

/**
 * Burn n on Sepolia, read and checked at the finalized block, or with --confirmations c at the block
 * c below the latest (the finalized block when that is higher); for a rehearsal, the burn --amount
 * and --to describe. PENDING while the burn is not that deep yet, or, in fast mode, while a burn
 * above --fast-cap is not final; FAILED when a check fails.
 */
async function burnOnSepolia(d: Deployed, o: ReleaseRun): Promise<BurnToRelease | number> {
  const { b } = d;
  const n = o.burnNonce;
  const c = o.rule.confirmations;
  await checkSepolia();
  const finalized = await sepolia("finalized block", () => rpc<{ number: string; hash: string }>("eth_getBlockByNumber", ["finalized", false]));
  const F = Number(BigInt(finalized.number));
  let at = { number: F, hash: finalized.hash };
  let L = F;
  if (c !== null) {
    const latest = await sepolia("latest block", () => rpc<{ number: string }>("eth_getBlockByNumber", ["latest", false]));
    L = Number(BigInt(latest.number));
    const C = checkBlock({ latest: L, finalized: F }, o.rule);
    if (C !== F) {
      at = await sepolia("block", async () => {
        const block = await rpc<{ number: string; hash: string } | null>("eth_getBlockByNumber", [qty(C), false]);
        if (!block) throw new Error(`block #${C} not found`);
        return { number: C, hash: block.hash };
      });
    }
  }
  const tag = qty(at.number);
  const state = await sepoliaState(b, tag);
  const id = burnId(SEPOLIA_CHAIN_ID, hexToBytes(b.minter), n);
  const viaView = wordAt(await sepoliaView(b.minter, callData(MINTER.burnIdOf, uintWord(n)), tag), 0);
  const where = at.number === F ? `finalized block ${fmt(F)} (${at.hash})` : `block ${fmt(at.number)} (${at.hash}), ${fmt(L - at.number)} below the latest #${fmt(L)}; finalized #${fmt(F)}`;
  log(`Sepolia, ${where}: BridgeMinter ${checksumAddress(hexToBytes(b.minter))}, ${state.burnCount} burn${state.burnCount === 1n ? "" : "s"}`);
  check(equalBytes(viaView, id), `burnIdOf(${n}) is ${bytesToHex(id)}, the vault's convention keccak256(abi.encode(BURN_TAG, 11155111, minter, ${n}))`);
  let burn: BurnToRelease;
  if (o.rehearse) {
    if (n < state.burnCount) throw new Stop(`burn ${n} is on Sepolia: release it without --rehearse`);
    burn = { final: true, burnNonce: n, burnId: id, from: null, v3Recipient: o.to!, amount: o.amount!, txHash: null, block: null, blockHash: null };
    log(`     rehearsal: burn ${n} is not on Sepolia; the V3 side runs as if it burned ${formatWtpot(burn.amount)} for ${checksumAddress(burn.v3Recipient)}. Nothing can be sent for it.`);
  } else {
    if (n >= state.burnCount) {
      const latest = await sepolia("latest block", () => rpc<{ number: string }>("eth_getBlockByNumber", ["latest", false]));
      const count = uintAt(await sepoliaView(b.minter, callData(MINTER.burnCount), latest.number), 0);
      if (n < count) {
        if (c === null) log(`     burn ${n} is on Sepolia after the finalized block #${fmt(F)}: the committee releases a burn once it is final (about 13 minutes after its block); run again then`);
        else log(`     burn ${n} is on Sepolia after block #${fmt(at.number)}: fewer than ${c} blocks are on top of it yet (fast mode); run again in a few blocks`);
        return PENDING;
      }
      throw new Stop(`there is no burn ${n} on Sepolia (burnCount ${count}); a dry run of one that is not there yet takes --rehearse --amount <wtPOT> --to <h160>`);
    }
    const found = await findBurn(b, n, at.number, o.hint);
    if (!found) throw new Stop(`burnCount is ${state.burnCount} at #${fmt(at.number)}, but no BurnRequested log of burn ${n} is there from #${fmt(b.deployBlock)}`);
    const final = found.block <= F;
    check(
      equalBytes(found.burnId, id) && found.block <= at.number,
      `BurnRequested(${n}) in #${fmt(found.block)} (${shortHex(found.txHash)}), ${final ? "final" : `${fmt(L - found.block)} blocks deep, not final yet`}: ${formatWtpot(found.amount)} from ${checksumAddress(found.from)} for ${checksumAddress(found.v3Recipient)} on V3, burn id ${shortHex(found.burnId)} (burnIdOf and the convention)`,
    );
    const receipt = await sepolia("receipt", () => receiptOf(found.txHash, false));
    const receiptHash = (receipt as (Receipt & { blockHash?: string }) | null)?.blockHash?.toLowerCase();
    check(
      receipt !== null &&
        BigInt(receipt.status) === 1n &&
        receipt.logs.some((l) => l.address.toLowerCase() === b.minter && l.topics[0]?.toLowerCase() === BURN_REQUESTED_TOPIC) &&
        Number(BigInt(receipt.blockNumber)) === found.block &&
        (!receiptHash || !found.blockHash || receiptHash === found.blockHash),
      "its transaction's receipt has status 1 and the log, in the log's block",
    );
    if (o.to && !equalBytes(o.to, found.v3Recipient)) throw new Stop(`burn ${n} pays ${checksumAddress(found.v3Recipient)} on V3, not --to ${checksumAddress(o.to)}`);
    if (!final) {
      // Fast mode: the burn is c blocks deep at least (it is in a block at most the one read), not final.
      if (found.amount > o.rule.fastCap) {
        log(`     burn ${n} burns ${formatWtpot(found.amount)}, above --fast-cap ${formatTpot(o.rule.fastCap)}: it waits for Sepolia's finality (its block #${fmt(found.block)}, finalized #${fmt(F)}); run again then`);
        return PENDING;
      }
      log(`     ${tradeOff(c!)}`);
    }
    burn = { ...found, final };
  }
  return failures > 0 ? FAILED : burn;
}

/** The V3 side of a release run: its checks, its dry runs, the call, and the approval or the cancellation asked for. */
async function releaseOnV3(d: Deployed, api: ApiPromise, evm: EvmRpc, o: ReleaseRun, burn: BurnToRelease): Promise<number> {
  const { b, record, keyring, v } = d;
  const n = o.burnNonce;
  {
    await checkV3(api, evm);
    // What an earlier --send run left submitted is settled first, dry run or not.
    if ((await settleSubmitted(api, evm, keyring, v, record)) === PENDING) return PENDING;
    const head = await finalizedHead(api);
    log(`V3, finalized block ${fmt(head.number)} (${head.hash}):`);
    await checkVault(api, evm, head, v);
    await checkCommittee(head, v);
    const flag = await vaultWord(head, v.address, releasedSlot(burn.burnId));
    if (flag !== 0n) {
      const done = (record.releases ?? []).find((r) => r.burn.burnId === bytesToHex(burn.burnId) && r.status === "released");
      check(true, `released[${shortHex(burn.burnId)}] is true: burn ${n} is released${done?.released ? ` (#${fmt(done.released.block.number)}, ${V3_RECORD})` : ""}; nothing to approve`);
      return failures === 0 ? OK : FAILED;
    }
    check(true, `released[${shortHex(burn.burnId)}] is false`);
    const outstanding = await vaultWord(head, v.address, SLOTS.outstanding);
    if (!check(outstanding >= burn.amount, `outstanding ${formatTpot(outstanding)} covers the ${formatTpot(burn.amount)} to release`)) throw new Stop("the vault would revert ExceedsOutstanding");

    // The payee.
    const payee = await payeeFacts(evm, head, burn.v3Recipient, burn.from);
    const verdict = payeeVerdict(payee.facts);
    if (!check(verdict.ok, `the payee ${checksumAddress(burn.v3Recipient)} is ${verdict.why}`)) throw new Stop("the committee does not release to an address nobody is shown to control");
    log(`     the payout goes to ${keyring.encodeAddress(payee.account, V3.ss58)}, which ${payee.exists ? "exists" : "does not exist yet: the release also pays its existential deposit"}`);

    // The dry run, from the multisig, and the limits.
    const release: Release = { burnId: burn.burnId, to: burn.v3Recipient, amountNative: burn.amount };
    const data = releaseCall(v.address, release, { weightLimit: { refTime: 0n, proofSize: 0n }, storageDepositLimit: 0n }).data;
    const dry = await dryRunRelease(api, head, v, data);
    const problem = dryRunProblem(dry);
    if (!check(problem === null, `reviveApi.call of release(${shortHex(burn.burnId)}, ${checksumAddress(burn.v3Recipient)}, ${burn.amount}) from ${v.multisig}: ${problem ?? `weight ${weightText(dry)}, storage deposit ${formatTpot(dry.storageDeposit)} (at most ${formatTpot(dry.maxStorageDeposit)})`}`)) {
      throw new Stop("the release does not run from the multisig");
    }
    const trace = traceOf((await runtimeCall(head.apiAt, "reviveApi", "traceCall", { from: bytesToHex(v.releaser), to: bytesToHex(v.address), input: { input: bytesToHex(data) }, value: 0 }, { CallTracer: { withLogs: true, onlyTopCall: false } })).toJSON());
    if (!trace.trace) check(false, trace.problem!);
    else for (const [ok, line] of releaseTraceChecks(trace.trace, { releaser: v.releaser, vault: v.address, release, ratio: v.ratio })) check(ok, `     reviveApi.traceCall: ${line}`);
    const ed = api.consts.balances.existentialDeposit.toBigInt();
    const floor = releaseDepositFloor(BigInt(constOf(api, "revive", "depositPerByte")), BigInt(constOf(api, "revive", "depositPerChildTrieItem")), ed);
    const needs: ReleaseNeeds = { refTime: dry.refTime, proofSize: dry.proofSize, maxStorageDeposit: dry.maxStorageDeposit > 0n ? dry.maxStorageDeposit : 0n };
    const limits = releaseLimits(needs, floor);
    const limited = await dryRunRelease(api, head, v, data, limits);
    const limitedProblem = dryRunProblem(limited);
    check(limitedProblem === null, `the same dry run with the call's limits (${weightText(limits.weightLimit)}; storage deposit ${formatTpot(limits.storageDepositLimit)}, floor ${formatTpot(floor)}) passes${limitedProblem ? `: ${limitedProblem}` : ""}`);

    // The call, as committee.ts encodes it and as polkadot-js does from V3's metadata.
    const fresh = releaseCall(v.address, release, limits);
    const index = api.tx.revive.call.callIndex;
    const freshBytes = encodeReviveCall(index, fresh);
    const polka = api.tx.revive.call(bytesToHex(v.address), 0, { refTime: limits.weightLimit.refTime, proofSize: limits.weightLimit.proofSize }, limits.storageDepositLimit, bytesToHex(data));
    if (!check(bytesToHex(polka.method.toU8a()) === bytesToHex(freshBytes) && polka.method.hash.toHex() === bytesToHex(callHash(freshBytes)), `the call encodes as polkadot-js encodes it from V3's metadata (${freshBytes.length} bytes, call index ${bytesToHex(index)})`)) {
      throw new Stop("committee.ts and polkadot-js encode the release's revive.call differently");
    }

    // The multisig: an open operation for this burn, or none.
    const ops = await operations(api, head, v, record, index);
    const mine = ops.filter((x) => x.release !== null && equalBytes(x.release.burnId, burn.burnId));
    const others = ops.filter((x) => !mine.includes(x));
    for (const x of others) log(`     another open operation of the committee: ${shortHex(x.hash)}, opened at #${fmt(x.when.height)}${x.release ? `, the release of burn id ${shortHex(x.release.burnId)}` : x.call ? ", not a release of this vault" : `, call unknown (${x.source})`}`);
    if (mine.length > 1) throw new Stop(`${mine.length} open operations release burn ${n}: cancel all but one (npm run release -- release --burn-nonce ${n} --cancel --member <depositor>)`);
    const op: Operation | null = mine[0] ?? null;
    // The operation's call when one is open (its call is known: it decodes as this burn's
    // release), else this run's.
    const callBytes = op ? op.call! : freshBytes;
    if (op) {
      const p = !equalBytes(op.release!.to, release.to) || op.release!.amountNative !== release.amountNative ? `it pays ${formatTpot(op.release!.amountNative)} to ${checksumAddress(op.release!.to)}` : limitsProblem(op.revive!, needs, floor);
      if (p) {
        check(false, `the open operation ${shortHex(op.hash)} for burn ${n} (from ${op.source}) is not this burn's release: ${p}`);
        log(`     its depositor, member ${memberOf(v, keyring, op.depositor) ?? "?"}, cancels it: npm run release -- release --burn-nonce ${n} --cancel --member ${memberOf(v, keyring, op.depositor) ?? "<k>"} --send ...`);
        if (o.action !== "cancel") return FAILED;
      } else if (op.hash !== bytesToHex(callHash(freshBytes))) {
        log(`     the open operation's call (from ${op.source}) has other limits than this run's (${limitsText(op.revive!)}); they cover the dry run, and it is the call to approve`);
      }
    }
    const call = decodeReviveCall(callBytes, index);
    const hash = bytesToHex(callHash(callBytes));
    const callWeight = await callWeightOf(api, head, callBytes);
    const deposit = multisigDeposit(api.consts.multisig.depositBase.toBigInt(), api.consts.multisig.depositFactor.toBigInt(), v.threshold);
    log(`\nThe call (${TRUST}):`);
    log(`     revive.call(${checksumAddress(v.address)}, 0, ${limitsText(call)}, release(${bytesToHex(burn.burnId)}, ${checksumAddress(burn.v3Recipient)}, ${burn.amount}))`);
    log(`     ${bytesToHex(callBytes)}`);
    log(`     call hash ${hash}; weight ${weightText(callWeight)} (transactionPaymentCallApi.queryCallInfo), the max weight of the approval that runs it`);
    log(`     the vault pays ${formatTpot(burn.amount)} (${fmt(evmValue(burn.amount, v.ratio))} wei) to ${checksumAddress(burn.v3Recipient)}; the multisig pays the storage deposit, ${formatTpot(dry.storageDeposit)} by the dry run`);
    const multisigAccount = await accountState(head.apiAt, v.multisigId);
    check(multisigAccount.free >= call.storageDepositLimit + ed, `the multisig holds ${formatTpot(multisigAccount.free)}, enough for the storage deposit limit and the existential deposit`);
    const approvers = op ? op.approvals.map((a) => memberOf(v, keyring, a)) : [];
    if (!op) log(`\nmultisig.multisigs(${v.multisig}, ${shortHex(hash)}) is empty at #${fmt(head.number)}: no member has approved it.`);
    else log(`\nmultisig.multisigs(${v.multisig}, ${shortHex(hash)}): opened at timepoint #${fmt(op.when.height)} index ${op.when.index} by member ${memberOf(v, keyring, op.depositor)} (deposit ${formatTpot(op.deposit)} reserved), approved by member${approvers.length === 1 ? "" : "s"} ${approvers.join(", ")}.`);

    // The approvals: asMulti(threshold, the other members in ascending order, the timepoint or none, the call in full, its weight).
    const memberIds = v.members.map((m) => keyring.decodeAddress(m));
    const signatoriesOf = (k: number) => otherSignatories(memberIds, memberIds[k - 1]).map((x) => bytesToHex(x));
    const asMultiOf = (k: number, timepoint: Timepoint | null) =>
      api.tx.multisig.asMulti(v.threshold, signatoriesOf(k), timepoint, api.createType("Call", callBytes), { refTime: callWeight.refTime, proofSize: callWeight.proofSize });
    const feeOf = async (tx: SubmittableExtrinsic<"promise">, k: number) => (await tx.paymentInfo(v.members[k - 1])).partialFee.toBigInt();
    const left = (approved: (number | null)[]) => [1, 2, 3].filter((k) => !approved.includes(k));
    const opener = op ? null : (o.member ?? 1);
    const runner = op ? (o.member ?? left(approvers)[0]) : opener === 1 ? 2 : 1;
    const openFee = opener === null ? null : await feeOf(asMultiOf(opener, null), opener);
    const runFee = await feeOf(asMultiOf(runner, op?.when ?? { height: head.number, index: 1 }), runner);
    const balances = await Promise.all(memberIds.map((id) => accountState(head.apiAt, id)));
    log(
      openFee === null
        ? `Costs: the member who runs it pays a fee of about ${formatTpot(runFee)} and keeps the existential deposit ${formatTpot(ed)}: it needs ${formatTpot(runFee + ed)} free`
        : `Costs: the member who opens it reserves ${formatTpot(deposit)} (DepositBase + ${v.threshold} x DepositFactor) until it runs and pays a fee of about ${formatTpot(openFee)}; ` +
            `the member who runs it pays about ${formatTpot(runFee)}; each keeps the existential deposit ${formatTpot(ed)}: they need ${formatTpot(deposit + openFee + ed)} and ${formatTpot(runFee + ed)} free`,
    );
    log(`     members now: ${balances.map((x, i) => `${i + 1}: ${formatTpot(x.free)} free${x.reserved ? `, ${formatTpot(x.reserved)} reserved` : ""}`).join("; ")}`);
    const commands = (verb: "approve" | "cancel", members: number[]) => {
      const who = members.length === 1 ? String(members[0]) : `<${members.join("|")}>`;
      const dry = `npm run release -- release --burn-nonce ${n} --${verb} --member ${who}`;
      return `     ${dry}\n     ${dry} --send --key-file <member json> --password-file <path>`;
    };
    if (o.action === "plan") {
      if (o.rehearse) log("\nThe rehearsal passed: the V3 side of this release runs. Nothing was signed or sent, and nothing can be approved until the burn is on Sepolia and final.");
      else if (!op) {
        log(`Next: any member opens it with asMulti, no timepoint and the call in full, which reserves ${formatTpot(deposit)} of that member's until the release runs:`);
        log(commands("approve", [1, 2, 3]));
      } else {
        log(`Next: member ${left(approvers).join(" or ")} runs it with asMulti, the timepoint #${fmt(op.when.height)} index ${op.when.index} and the call in full:`);
        log(commands("approve", left(approvers)));
      }
      if (failures > 0) return FAILED;
      if (!o.rehearse) log("\nThe dry run passed. Nothing was signed or sent.");
      return OK;
    }

    // An approval or a cancellation, by member k.
    const k = o.member!;
    const me = memberIds[k - 1];
    const signatories = signatoriesOf(k);
    let action: ApprovalEntry["action"];
    let tx: SubmittableExtrinsic<"promise">;
    if (o.action === "cancel") {
      if (!op) throw new Stop(`no open operation releases burn ${n}: nothing to cancel`);
      if (!equalBytes(op.depositor, me)) throw new Stop(`member ${memberOf(v, keyring, op.depositor)} opened ${shortHex(op.hash)}: only it can cancel it`);
      action = "cancel";
      tx = api.tx.multisig.cancelAsMulti(v.threshold, signatories, op.when, op.hash);
    } else if (!op) {
      action = "open";
      tx = asMultiOf(k, null);
    } else {
      if (op.approvals.some((a) => equalBytes(a, me))) throw new Stop(`member ${k} approved ${shortHex(op.hash)} already: member ${left(approvers).join(" or ")} runs it`);
      if (op.approvals.length + 1 < v.threshold) throw new Stop(`${op.approvals.length + 1} of ${v.threshold} approvals: this tool takes an operation from its first approval to its execution`);
      action = "execute";
      tx = asMultiOf(k, op.when);
    }
    const account = v.members[k - 1];
    const fee = await feeOf(tx, k);
    const balance = balances[k - 1];
    const need = (action === "open" ? deposit : 0n) + fee + ed;
    const role = action === "open" ? `the deposit ${formatTpot(deposit)}, the fee and the existential deposit` : "the fee and the existential deposit";
    log(`\nMember ${k} ${account}: ${action === "open" ? "opens the operation (asMulti, no timepoint)" : action === "execute" ? `runs it (asMulti, timepoint #${fmt(op!.when.height)} index ${op!.when.index})` : `cancels ${shortHex(op!.hash)} (cancelAsMulti)`}; other signatories ${signatories.map((x) => keyring.encodeAddress(x, V3.ss58)).join(", ")} (ascending)`);
    log(`     fee about ${formatTpot(fee)} (payment_queryInfo); member ${k} holds ${formatTpot(balance.free)} free${balance.reserved ? `, ${formatTpot(balance.reserved)} reserved` : ""}, nonce ${balance.nonce}`);
    if (!check(balance.free >= need, `member ${k}'s free balance covers ${role} (${formatTpot(need)})`)) {
      log(`     fund it first: npm run release -- fund --member ${k} --amount ${wholeTpot(need - balance.free)}, then with --send --key-file <path>`);
      return FAILED;
    }
    if (failures > 0) {
      log("\nThe dry run failed: nothing is sent.");
      return FAILED;
    }
    if (!o.send) {
      if (o.rehearse) log(`\nThe rehearsal of member ${k}'s approval passed. Nothing was signed or sent, and nothing can be until burn ${n} is on Sepolia and final.`);
      else if (o.watcher) log(`\nThe dry run of member ${k}'s approval passed. Nothing was signed or sent.`);
      else log(`\nThe dry run passed. Nothing was signed or sent. To send it:\n${commands(o.action === "cancel" ? "cancel" : "approve", [k]).split("\n")[1]}`);
      return OK;
    }

    // --send
    const pair = o.pair ?? loadMemberKey(o.keyFile!, o.passwordFile!, account, keyring);
    if (pair.address !== account) throw new Stop(`the key given for member ${k} is ${pair.address}, not ${account}`);
    // The watcher's lock is still its own: nothing is signed or recorded otherwise.
    o.guard?.();
    const nonce = (await api.rpc.system.accountNextIndex(account)).toNumber();
    const signed = await tx.signAsync(pair, { nonce });
    const round = roundOf(record, hash as Hex, () => ({
      status: "open",
      trust: TRUST,
      burn: {
        chainId: SEPOLIA_CHAIN_ID.toString(),
        minter: b.minter,
        burnNonce: n.toString(),
        burnId: bytesToHex(burn.burnId),
        from: bytesToHex(burn.from!),
        v3Recipient: bytesToHex(burn.v3Recipient),
        amount: burn.amount.toString(),
        txHash: burn.txHash!,
        block: burn.block!,
        blockHash: burn.blockHash,
      },
      vault: bytesToHex(v.address),
      payee: bytesToHex(burn.v3Recipient),
      amountNative: burn.amount.toString(),
      value: evmValue(burn.amount, v.ratio).toString(),
      call: { hex: bytesToHex(callBytes), hash: hash as Hex, weightLimit: weightJson(call.weightLimit), storageDepositLimit: call.storageDepositLimit.toString(), weight: weightJson(callWeight) },
      dryRun: { block: head.number, refTime: dry.refTime.toString(), proofSize: dry.proofSize.toString(), storageDeposit: dry.storageDeposit.toString(), maxStorageDeposit: dry.maxStorageDeposit.toString() },
      multisig: { account: v.multisig, threshold: v.threshold, timepoint: op?.when ?? null, depositor: op ? keyring.encodeAddress(op.depositor, V3.ss58) : null, deposit: op ? op.deposit.toString() : null },
      approvals: [],
      note: `git ${gitCommit() ?? "unknown"}`,
    }));
    const approval: ApprovalEntry = {
      member: k,
      account,
      action,
      timepoint: action === "open" ? null : op!.when,
      maxWeight: action === "cancel" ? null : weightJson(callWeight),
      nonce,
      extrinsicHash: signed.hash.toHex(),
      signedAt: new Date().toISOString(),
      submittedAfter: head.number,
      status: "submitted",
      block: null,
      fee: null,
      events: [],
    };
    round.approvals.push(approval);
    round.by = burn.final ? "finality" : "fast";
    saveV3Record(record);
    log(`\nSigned ${tx.method.section}.${tx.method.method} ${approval.extrinsicHash} as member ${k} at nonce ${nonce}, recorded in ${V3_RECORD}; submitting`);
    let final: Final | "pending";
    try {
      final = await submitAndWatch(api, signed);
    } catch (error) {
      if (!(error instanceof Rejected)) throw error;
      approval.status = "failed";
      approval.note = `never included: ${errorText(error)}`;
      saveV3Record(record);
      check(false, errorText(error));
      return FAILED;
    }
    if (final === "pending") {
      log(`     not seen final (at most ${FINAL_TIMEOUT / 60_000} minutes are waited); ${V3_RECORD} keeps it as submitted, and the next run settles it first`);
      return PENDING;
    }
    const ok = await checkApproval({ api, evm, keyring, v, burn: { burnId: burn.burnId, payee: burn.v3Recipient, amount: burn.amount } }, round, approval, final);
    approval.status = ok ? "final" : "failed";
    saveV3Record(record);
    if (!ok) return FAILED;
    if (action === "open") {
      log(o.watcher ? `\nOpened by member ${k}.` : `\nOpened. Next: member ${left([k]).join(" or ")} runs it:\n${commands("approve", left([k]))}`);
    } else if (action === "execute") log(`\nBurn ${n} is released: ${formatTpot(burn.amount)} paid to ${checksumAddress(burn.v3Recipient)} on V3, checked; ${V3_RECORD} records the round.`);
    else log(`\nCancelled; member ${k}'s deposit is back.`);
    return failures === 0 ? OK : FAILED;
  }
}

const limitsText = (c: ReviveCall) => `weight limit ${weightText(c.weightLimit)}, storage deposit limit ${formatTpot(c.storageDepositLimit)}`;

/** The weight a call is dispatched with (transactionPaymentCallApi.queryCallInfo): the max weight the approval that runs it has to allow. */
async function callWeightOf(api: ApiPromise, head: V3Head, call: Uint8Array): Promise<Weight> {
  const info = (await runtimeCall(head.apiAt, "transactionPaymentCallApi", "queryCallInfo", api.createType("Call", call), call.length)).toJSON() as { weight?: { refTime?: number | string; proofSize?: number | string } };
  if (info.weight?.refTime === undefined || info.weight.proofSize === undefined) throw new Stop(`transactionPaymentCallApi.queryCallInfo returned ${JSON.stringify(info).slice(0, 200)}`);
  return { refTime: BigInt(info.weight.refTime), proofSize: BigInt(info.weight.proofSize) };
}

/**
 * The fees (payment_queryInfo) of member k's approvals of a release, opening one and running one,
 * for a sample call: a release of 1 native base unit to the vault itself under a zero burn id,
 * with the limits of the release dry run of Oct 20 (782,299,332 ref time, 26,093 proof size,
 * 3.8415 tPOT), which has the length and nearly the weight of every release.
 */
async function approvalFees(api: ApiPromise, head: V3Head, v: VaultFacts, keyring: Keyring, k: Member): Promise<{ open: bigint; execute: bigint }> {
  const sample = releaseCall(v.address, { burnId: new Uint8Array(32), to: v.address, amountNative: 1n }, releaseLimits({ refTime: 782_299_332n, proofSize: 26_093n, maxStorageDeposit: 384_150_000_000_000n }, 0n));
  const bytes = encodeReviveCall(api.tx.revive.call.callIndex, sample);
  const weight = await callWeightOf(api, head, bytes);
  const me = keyring.decodeAddress(v.members[k - 1]);
  const others = otherSignatories(v.members.map((m) => keyring.decodeAddress(m)), me).map((x) => bytesToHex(x));
  const call = api.createType("Call", bytes);
  const fee = async (timepoint: Timepoint | null) =>
    (await api.tx.multisig.asMulti(v.threshold, others, timepoint, call, { refTime: weight.refTime, proofSize: weight.proofSize }).paymentInfo(v.members[k - 1])).partialFee.toBigInt();
  return { open: await fee(null), execute: await fee({ height: head.number, index: 1 }) };
}

// ---------------------------------------------------------------------------------------
// release --watch

/** The watcher's lock is not its own any more: it signs and writes nothing more. */
class LockLost extends Error {
  override name = "LockLost";
}

/** A problem a later round cannot get past alone (a key file, the lock): the watcher ends. */
class Fatal extends Error {
  override name = "Fatal";
}

/** A burn the watcher saw, with its log (null when its log could not be read this round: it waits). */
interface WatchedBurn extends SeenBurn {
  onChain: BurnOnChain | null;
}

/** The final burns' logs the watcher found, kept in <state-dir>/release-watch-<multisig>.burns.json (written with --send). */
interface BurnCache {
  path: string;
  burns: Map<string, CachedBurn>;
  write: boolean;
}

const cachedOf = (n: bigint, c: CachedBurn): BurnOnChain => ({
  burnNonce: n,
  from: hexToBytes(c.from),
  v3Recipient: hexToBytes(c.payee),
  amount: BigInt(c.amount),
  burnId: hexToBytes(c.burnId),
  txHash: c.txHash.toLowerCase() as Hex,
  block: c.block,
  blockHash: c.blockHash.toLowerCase() as Hex,
});

/**
 * BurnRequested(n), searched from `to` back to `from` in windows of at most 10,000 blocks, the
 * newest first (a burn the watcher has not handled yet is recent); { refused } when the RPC refuses
 * a window before the log is found (publicnode keeps logs for about 33 hours).
 */
async function recentBurn(b: Bridge, n: bigint, from: number, to: number): Promise<BurnOnChain | null | { refused: string }> {
  const filter = { address: b.minter, topics: [BURN_REQUESTED_TOPIC, bytesToHex(uintWord(n))] };
  for (const [a, z] of logWindows(from, to).reverse()) {
    const found = await sepoliaLogs(filter, a, z);
    if ("refused" in found) return found;
    const logs = found.logs.filter((l) => l.address.toLowerCase() === b.minter && !(l as { removed?: boolean }).removed);
    if (logs.length > 1) throw new Stop(`${logs.length} BurnRequested logs for burn ${n}`);
    if (logs.length === 1) return burnOfLog(logs[0]);
  }
  return null;
}

/**
 * Every burn from the last one handled (the record's releases, cursorOf), which is checked again,
 * to burnCount at the latest block: a burn the record has released, from the record; one the burn
 * cache has, from the cache; any other from its BurnRequested log (recentBurn), between the last
 * handled burn's block and the latest, and into the cache once its block is final. A burn whose log
 * the RPC refuses or does not serve yet waits; the round goes on with the next.
 */
async function burnsSince(d: Deployed, heads: Heads, cache: BurnCache): Promise<WatchedBurn[]> {
  const latest = heads.latest;
  const { b, record } = d;
  const releases = (record.releases ?? []).filter((r) => r.status === "released" && r.burn.minter === b.minter);
  const { nextNonce, fromBlock } = cursorOf(
    releases.map((r) => ({ burnNonce: BigInt(r.burn.burnNonce), block: r.burn.block })),
    b.deployBlock,
  );
  const first = nextNonce > 0n ? nextNonce - 1n : 0n;
  // burnCount one block below the latest: a load-balanced RPC may not serve the logs of the latest
  // block from every backend yet. A burn in the latest block is seen in the next round.
  const countAt = Math.max(latest - 1, heads.finalized);
  const count = uintAt(await sepoliaView(b.minter, callData(MINTER.burnCount), qty(countAt)), 0);
  log(`     ${V3_RECORD} has ${nextNonce === 0n ? "no burn" : nextNonce === 1n ? "burn 0" : `burns 0 to ${nextNonce - 1n}`} released; burnCount ${count} at #${fmt(countAt)}: the burns from nonce ${first}`);
  const out: WatchedBurn[] = [];
  let added = 0;
  for (let n = first; n < count; n++) {
    const done = releases.find((r) => r.burn.burnNonce === n.toString());
    const cached = cache.burns.get(n.toString());
    let burn: BurnOnChain;
    if (done) {
      burn = { burnNonce: n, from: hexToBytes(done.burn.from), v3Recipient: hexToBytes(done.burn.v3Recipient), amount: BigInt(done.burn.amount), burnId: hexToBytes(done.burn.burnId), txHash: done.burn.txHash, block: done.burn.block, blockHash: done.burn.blockHash ?? null };
    } else if (cached) {
      burn = cachedOf(n, cached);
    } else {
      const found = await recentBurn(b, n, fromBlock, latest);
      if (found !== null && "refused" in found) {
        out.push({ burnNonce: n, amount: 0n, block: 0, payee: "?", onChain: null, missing: `the Sepolia RPC refuses eth_getLogs (${found.refused}) before its log is found; an RPC that keeps the minter's logs from #${fmt(fromBlock)} finds it (SEPOLIA_RPC_URL)` });
        continue;
      }
      if (found === null) {
        out.push({ burnNonce: n, amount: 0n, block: 0, payee: "?", onChain: null, missing: `burnCount is ${count} at #${fmt(countAt)}, but the RPC serves no BurnRequested log of it from #${fmt(fromBlock)} yet` });
        continue;
      }
      burn = found;
      if (found.block <= heads.finalized && found.blockHash) {
        cache.burns.set(n.toString(), { block: found.block, blockHash: found.blockHash, txHash: found.txHash, from: bytesToHex(found.from), payee: bytesToHex(found.v3Recipient), amount: found.amount.toString(), burnId: bytesToHex(found.burnId) });
        added += 1;
      }
    }
    out.push({ burnNonce: n, amount: burn.amount, amountText: formatWtpot(burn.amount), block: burn.block, payee: checksumAddress(burn.v3Recipient), onChain: burn });
  }
  if (added > 0 && cache.write) {
    try {
      writeBurnCache(cache.path, b.minter, cache.burns);
      log(`     ${cache.path}: ${added} more final burn${added === 1 ? "" : "s"}, never searched for again`);
    } catch (error) {
      warn(`${cache.path} could not be written (${errorText(error)}): the next round searches for those burns again`);
    }
  }
  return out;
}

/** The burn on V3 at the finalized head (released[burnId], the committee's open operation for it) and in the record. */
async function burnStateOf(api: ApiPromise, d: Deployed, burn: WatchedBurn): Promise<BurnState> {
  const { v, record, keyring } = d;
  if (!burn.onChain) throw new Error(`burn ${burn.burnNonce}: no log`);
  const onChain = burn.onChain;
  const head = await finalizedHead(api);
  const released = (await vaultWord(head, v.address, releasedSlot(onChain.burnId))) !== 0n;
  const ops = (await operations(api, head, v, record, api.tx.revive.call.callIndex)).filter((x) => x.release !== null && equalBytes(x.release.burnId, onChain.burnId));
  const id = bytesToHex(onChain.burnId);
  const rounds = (record.releases ?? [])
    .filter((r) => r.burn.burnId === id)
    .map((r) => ({ status: r.status, approvals: r.approvals.map((a) => ({ member: a.member, action: a.action, status: a.status, onChain: a.block !== null })) }));
  const op = ops[0];
  return {
    released,
    op: op
      ? {
          approvals: op.approvals.map((a) => memberOf(v, keyring, a) ?? 0),
          depositor: memberOf(v, keyring, op.depositor) ?? 0,
          matches: ops.length === 1 && equalBytes(op.release!.to, onChain.v3Recipient) && op.release!.amountNative === burn.amount,
        }
      : null,
    rounds,
  };
}

/**
 * Member k's approval of a burn's release, through the release tool: the burn read again on Sepolia
 * by the rule it qualified by, every check and dry run on V3, then the approval (signed, sent and
 * checked with --send). What the record gained tells a refusal before signing from an extrinsic the
 * node refused and from one that ran on chain and failed its checks.
 */
async function approveFor(
  ctx: { d: Deployed; api: ApiPromise; evm: EvmRpc; o: WatchOptions; keys: Map<number, Pair> | null; lock: Lock | null },
  burn: WatchedBurn,
  by: "finality" | "fast",
  step: { kind: "open" | "execute"; member: number },
): Promise<Outcome> {
  const { d, api, evm, o, keys, lock } = ctx;
  failures = 0;
  // The record as it is now: another tool may have saved it since the round read it.
  d.record = readV3Record();
  if (!burn.onChain) throw new Error(`burn ${burn.burnNonce}: no log`);
  const onChain = burn.onChain;
  const id = bytesToHex(onChain.burnId);
  const approvalsOf = () => (d.record.releases ?? []).filter((r) => r.burn.burnId === id).flatMap((r) => r.approvals);
  const before = new Set(approvalsOf());
  const run: ReleaseRun = {
    burnNonce: burn.burnNonce,
    rehearse: false,
    action: "approve",
    member: step.member as Member,
    send: o.send,
    rule: by === "finality" ? FINALITY : o.rule,
    pair: keys?.get(step.member),
    guard: lock
      ? () => {
          if (!lock.held()) throw new LockLost(`${lock.path} no longer holds this watcher's token: another watcher took the lock over, and nothing more is signed`);
        }
      : undefined,
    watcher: true,
    hint: { block: onChain.block, blockHash: onChain.blockHash, txHash: onChain.txHash },
  };
  log(`\n--- burn ${burn.burnNonce}: member ${step.member} ${step.kind === "open" ? "opens" : "runs"} its release${o.send ? "" : " (dry run)"}`);
  try {
    const read = await burnOnSepolia(d, run);
    if (read === PENDING) return { kind: "pending", why: "the burn is not as deep on Sepolia as the round saw it (a reorg, or an RPC behind)" };
    if (typeof read === "number") return { kind: "refused", why: "a check of the burn on Sepolia failed" };
    if (!equalBytes(read.burnId, onChain.burnId) || !equalBytes(read.v3Recipient, onChain.v3Recipient) || read.amount !== burn.amount) {
      return { kind: "refused", why: "the burn on Sepolia is not the one the round saw (a reorg?)" };
    }
    const code = await releaseOnV3(d, api, evm, run, read);
    if (code === OK) return { kind: "ok" };
    if (code === PENDING) return { kind: "pending", why: "an approval is not final yet" };
    const sent = approvalsOf().filter((a) => !before.has(a)).at(-1);
    if (sent?.block) return { kind: "failed", why: `${sent.extrinsicHash} in #${fmt(sent.block.number)} failed its checks`, extrinsicHash: sent.extrinsicHash };
    if (sent) return { kind: "rejected", why: sent.note ?? "never included" };
    return { kind: "refused", why: `${failures} check${failures === 1 ? "" : "s"} failed` };
  } catch (error) {
    if (error instanceof Stop && !(error instanceof RecordError)) return { kind: "refused", why: errorText(error) };
    throw error;
  }
}

/**
 * The releases made in fast mode whose burns' blocks are final now and that are not checked yet:
 * BurnRequested(n) on the final chain (eth_getLogs from 128 blocks below the recorded block to the
 * finalized block, the log's block canonical), compared with the record (reconcileVerdict) and the
 * check recorded with --send. A release that does not stand is fatal. One whose log the RPC refuses
 * is checked in a later round.
 */
async function reconcileFast(d: Deployed, h: Heads, send: boolean): Promise<{ checked: number; fatal: FatalStop | null }> {
  const { b } = d;
  let checked = 0;
  for (const round of d.record.releases ?? []) {
    if (round.status !== "released" || round.by !== "fast" || round.finalizedCheck || round.burn.minter !== b.minter || round.burn.block > h.finalized) continue;
    const n = BigInt(round.burn.burnNonce);
    const found = await recentBurn(b, n, Math.max(b.deployBlock, round.burn.block - 128), h.finalized);
    if (found !== null && "refused" in found) {
      warn(`the release of burn ${n}, made in fast mode, is not checked against Sepolia's final chain yet: the RPC refuses eth_getLogs (${found.refused}); a later round tries again`);
      continue;
    }
    if (found) {
      const canonical = await sepolia("block", () => rpc<{ hash: string } | null>("eth_getBlockByNumber", [qty(found.block), false]));
      if (!canonical || !found.blockHash || canonical.hash.toLowerCase() !== found.blockHash) {
        warn(`burn ${n}'s log at #${fmt(found.block)} is not from the canonical block yet (an RPC behind?): a later round checks its fast release`);
        continue;
      }
    }
    const verdict = reconcileVerdict(
      { txHash: round.burn.txHash, blockHash: round.burn.blockHash ?? null, block: round.burn.block, payee: round.payee, amount: BigInt(round.amountNative), burnId: round.burn.burnId },
      found && { txHash: found.txHash, blockHash: found.blockHash, block: found.block, payee: bytesToHex(found.v3Recipient), amount: found.amount, burnId: bytesToHex(found.burnId) },
    );
    checked += 1;
    log(`${verdict.ok ? "ok  " : "FAIL"} the release of burn ${n}, made in fast mode, against Sepolia's finalized block #${fmt(h.finalized)}: ${verdict.why}`);
    if (send) {
      round.finalizedCheck = { block: h.finalized, ok: verdict.ok, why: verdict.why, at: new Date().toISOString() };
      saveV3Record(d.record);
    }
    if (!verdict.ok) {
      const executed = round.approvals.filter((a) => a.action === "execute" && a.block).at(-1);
      return {
        checked,
        fatal: { why: `the release of burn ${n}, made in fast mode, does not stand on Sepolia's final chain: ${verdict.why}; the vault paid ${formatTpot(BigInt(round.amountNative))} for a burn a reorg changed or undid`, burn: n.toString(), extrinsicHash: executed?.extrinsicHash ?? null },
      };
    }
  }
  return { checked, fatal: null };
}

/** One round: the record read again, Sepolia's heads and the burns since the last one handled, V3 connected for the round. */
async function watchOnce(o: WatchOptions, keyring: Keyring, keys: { pairs: Map<number, Pair> | null }, lock: Lock | null): Promise<RoundResult> {
  const record = readV3Record();
  const d: Deployed = { b: readBridge(), record, keyring, v: vaultFacts(record, keyring) };
  const cachePath = join(o.stateDir, `release-watch-${d.v.multisig}.burns.json`);
  const cache: BurnCache = { path: cachePath, burns: readBurnCache(cachePath, d.b.minter), write: o.send };
  await checkSepolia();
  const evm = new EvmRpc(o.evm);
  const api = await connectV3(o.rpc, o.send);
  try {
    await checkV3(api, evm);
    if (o.send && !keys.pairs) {
      // The keys are read once the API is up: its sr25519 crypto is ready then.
      try {
        keys.pairs = new Map(o.memberKeys.map((k) => [k.member, loadMemberKey(k.path!, o.passwordFile!, d.v.members[k.member - 1], keyring)]));
      } catch (error) {
        throw new Fatal(`--member-keys: ${errorText(error)}`);
      }
    }
    let heads: Heads = { latest: 0, finalized: 0 };
    const ports: Ports<WatchedBurn> = {
      settle: async () => {
        try {
          return (await settleSubmitted(api, evm, keyring, d.v, d.record)) === PENDING ? { kind: "pending", why: "the node's pool holds it, or a block not final yet used its nonce" } : { kind: "ok" };
        } catch (error) {
          // A Stop here is an approval whose sender's nonce is used while it is in none of the blocks
          // searched: nobody knows what ran, and the watcher signs nothing more.
          if (error instanceof Stop && !(error instanceof RpcError)) return { kind: "fatal", why: `settling the approvals an earlier run submitted: ${errorText(error)}` };
          throw error;
        }
      },
      heads: async () => {
        const [l, f] = await Promise.all(
          ["latest", "finalized"].map((tag) => sepolia(`${tag} block`, () => rpc<{ number: string }>("eth_getBlockByNumber", [tag, false]))),
        );
        heads = { latest: Number(BigInt(l.number)), finalized: Number(BigInt(f.number)) };
        return heads;
      },
      burns: () => burnsSince(d, heads, cache),
      fastReleases: async () =>
        (d.record.releases ?? []).filter((r) => r.status === "released" && r.by === "fast" && r.burn.minter === d.b.minter).map((r) => ({ amount: BigInt(r.amountNative), block: r.burn.block })),
      reconcile: (h) => reconcileFast(d, h, o.send),
      state: (burn) => burnStateOf(api, d, burn),
      approve: (burn, by, step) => approveFor({ d, api, evm, o, keys: keys.pairs, lock }, burn, by, step),
      log,
    };
    return await watchRound(ports, o.rule, { send: o.send, keyed: o.memberKeys.map((k) => k.member), threshold: d.v.threshold });
  } finally {
    await api.disconnect();
  }
}

/**
 * release --watch: a round every --watch seconds (watchRound), each burn that qualifies released by
 * two members' approvals; after rounds in a row an RPC failed, the wait doubles, up to an hour.
 * With --send one watcher per committee holds the lock in STATE_DIR. A fatal stop (a sent approval
 * that fails its checks, an approval that cannot be found though its nonce is used, a lost lock, a
 * key file or a record that cannot be written) ends it with exit code 4 and, with --send, leaves
 * release-watch-<multisig>.halt in --state-dir; no watcher with --send starts while it is there.
 */
async function watchCommand(o: WatchOptions): Promise<number> {
  const keyed = o.memberKeys.map((k) => k.member).join(" and ");
  log(`${new Date().toISOString()}: the auto-release watcher of ${V3.title}, a round every ${o.watch} s; members ${keyed} approve${o.send ? "" : " (dry run)"}`);
  log(`     the return path is ${TRUST}`);
  log(`     ${ruleText(o.rule, true)}`);
  const { Keyring } = await polkadot();
  const keyring = new Keyring({ type: "sr25519", ss58Format: V3.ss58 });
  const v = vaultFacts(readV3Record(), keyring);
  const haltPath = join(o.stateDir, `release-watch-${v.multisig}.halt`);
  const halted = readHalt(haltPath);
  if (halted) {
    if (o.send) {
      check(false, `the watcher does not start: ${haltRefusal(halted, haltPath)}`);
      return HALTED;
    }
    warn(`${haltRefusal(halted, haltPath)}; a watcher with --send does not start until then (this dry run goes on)`);
  }
  /** A fatal stop: the halt file first (with --send), then exit code 4, which a restarting wrapper must not restart. */
  const halt = (f: FatalStop): number => {
    check(false, f.why);
    if (o.send) {
      try {
        mkdirSync(o.stateDir, { recursive: true });
        writeHalt(haltPath, { reason: f.why, burn: f.burn, extrinsicHash: f.extrinsicHash, at: new Date().toISOString() });
        log(`     the watcher stopped for good: ${haltPath} holds why; no watcher of ${v.multisig} with --send starts until a member looks at it and removes it (exit code ${HALTED})`);
      } catch (error) {
        log(`FAIL the halt file ${haltPath} could not be written (${errorText(error)}): do not restart the watcher before a member looks (exit code ${HALTED})`);
      }
    }
    return HALTED;
  };
  let lock: Lock | null = null;
  if (o.send) {
    for (const dir of new Set([STATE_DIR, o.stateDir])) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch (error) {
        throw new Stop(`${dir} cannot be created: ${errorText(error)}`);
      }
    }
    lock = takeLock(watchLockPath(v.multisig), log);
    if (!lock) return FAILED;
    log(`     the lock ${lock.path} is this watcher's: no other watcher of the committee ${v.multisig} sends while it runs`);
  }
  const keys: { pairs: Map<number, Pair> | null } = { pairs: null };
  try {
    let wait = o.watch;
    for (let round = 1; ; round++) {
      failures = 0;
      log(`\n=== round ${round}, ${new Date().toISOString()}${o.rule.confirmations === null ? "" : `: ${tradeOff(o.rule.confirmations)}`}`);
      let code: number;
      let trouble = false;
      try {
        const r = await watchOnce(o, keyring, keys, lock);
        log(
          `\nRound ${round}: ${r.released} released, ${r.waiting} waiting, ${r.refused} refused, ${r.held} left to the members` +
            `${o.send ? "" : `, ${r.planned} approval${r.planned === 1 ? "" : "s"} dry-run; nothing was signed or sent`}${r.pending ? "; something sent is not final yet" : ""}`,
        );
        if (r.fatal) return halt(r.fatal);
        code = r.pending ? PENDING : r.refused + r.held > 0 ? FAILED : OK;
      } catch (error) {
        if (error instanceof LockLost || error instanceof Fatal || error instanceof RecordError || error instanceof DryRunViolation) {
          return halt({ why: errorText(error), burn: null, extrinsicHash: null });
        }
        trouble = rpcTrouble(error);
        if (error instanceof Unreachable) {
          log(errorText(error));
          code = UNREACHABLE;
        } else {
          check(false, `round ${round}: ${errorText(error)}`);
          code = FAILED;
        }
      }
      if (o.rounds !== null && round >= o.rounds) return code;
      wait = nextWait(o.watch, wait, trouble);
      log(`\nNext round in ${wait} s, at ${new Date(Date.now() + wait * 1000).toISOString()}${trouble ? " (the wait doubles while rounds fail, up to an hour)" : ""}.`);
      await sleep(wait * 1000);
    }
  } finally {
    lock?.release();
  }
}

// ---------------------------------------------------------------------------------------
// fund

async function fundCommand(o: FundOptions): Promise<number> {
  const { Keyring } = await polkadot();
  const keyring = new Keyring({ type: "sr25519", ss58Format: V3.ss58 });
  const record = readV3Record();
  const v = vaultFacts(record, keyring);
  const to = o.multisig ? v.multisig : v.members[o.member! - 1];
  const role = o.multisig ? "the committee's multisig, which pays each release's storage deposit" : `member ${o.member}`;
  const from = option("--from", () => keyring.encodeAddress(keyring.decodeAddress(o.from), V3.ss58));
  log(`${new Date().toISOString()}: funding ${role} (${to}) with ${formatTpot(o.amount)} from ${from} on ${V3.title}${o.send ? "" : " (dry run)"}`);
  const evm = new EvmRpc(o.evm);
  const api = await connectV3(o.rpc, o.send);
  try {
    await checkV3(api, evm);
    // The key is read once the API is up: its sr25519 crypto is ready then.
    const pair = o.send ? loadMnemonicKey(o.keyFile!, from, keyring) : null;
    // What an earlier --send run left submitted is settled first, dry run or not.
    if ((await settleSubmitted(api, evm, keyring, v, record)) === PENDING) return PENDING;
    const head = await finalizedHead(api);
    const ed = api.consts.balances.existentialDeposit.toBigInt();
    const sender = await accountState(head.apiAt, keyring.decodeAddress(from));
    const target = await accountState(head.apiAt, keyring.decodeAddress(to));
    const tx = api.tx.balances.transferKeepAlive(to, o.amount);
    const fee = (await tx.paymentInfo(from)).partialFee.toBigInt();
    log(`At #${fmt(head.number)}: ${from} holds ${formatTpot(sender.free)} (nonce ${sender.nonce}); ${to} holds ${formatTpot(target.free)} free${target.reserved ? `, ${formatTpot(target.reserved)} reserved` : ""}`);
    log(`     balances.transferKeepAlive(${to}, ${formatTpot(o.amount)}): fee about ${formatTpot(fee)}`);
    if (!o.multisig) {
      const deposit = multisigDeposit(api.consts.multisig.depositBase.toBigInt(), api.consts.multisig.depositFactor.toBigInt(), v.threshold);
      const fees = await approvalFees(api, head, v, keyring, o.member!);
      const open = deposit + fees.open + ed;
      const run = fees.execute + ed;
      log(
        `     to open a release, member ${o.member} needs ${formatTpot(open)} free: DepositBase + ${v.threshold} x DepositFactor, ${formatTpot(deposit)}, reserved until it runs, ` +
          `the fee, about ${formatTpot(fees.open)}, and the existential deposit; to run one, ${formatTpot(run)}: the fee, about ${formatTpot(fees.execute)}, and the existential deposit`,
      );
      const after = target.free + o.amount;
      log(`     after this transfer it holds ${formatTpot(after)} free: ${after >= open ? "enough to open a release" : after >= run ? "enough to run a release, not to open one" : "not enough for an approval"}`);
    }
    check(target.exists || o.amount >= ed, `the amount is at least the existential deposit ${formatTpot(ed)}, or ${to} exists already`);
    if (!check(sender.free >= o.amount + fee + ed, `${from}'s free balance covers the amount, the fee and the existential deposit (${formatTpot(o.amount + fee + ed)})`)) return FAILED;
    if (failures > 0) {
      log("\nThe dry run failed: nothing is sent.");
      return FAILED;
    }
    if (!pair) {
      log("\nThe dry run passed. Nothing was signed or sent.");
      return OK;
    }
    const nonce = (await api.rpc.system.accountNextIndex(from)).toNumber();
    const signed = await tx.signAsync(pair, { nonce });
    const entry: FundingEntry = {
      status: "submitted",
      from,
      to,
      role,
      amount: o.amount.toString(),
      nonce,
      extrinsicHash: signed.hash.toHex(),
      signedAt: new Date().toISOString(),
      submittedAfter: head.number,
      block: null,
      fee: null,
    };
    record.committeeFunding = [...(record.committeeFunding ?? []), entry];
    saveV3Record(record);
    log(`\nSigned balances.transferKeepAlive ${entry.extrinsicHash} at nonce ${nonce}, recorded in ${V3_RECORD}; submitting`);
    let final: Final | "pending";
    try {
      final = await submitAndWatch(api, signed);
    } catch (error) {
      if (!(error instanceof Rejected)) throw error;
      entry.status = "failed";
      entry.note = `never included: ${errorText(error)}`;
      saveV3Record(record);
      check(false, errorText(error));
      return FAILED;
    }
    if (final === "pending") {
      log(`     not final after ${FINAL_TIMEOUT / 60_000} minutes; ${V3_RECORD} keeps it as submitted`);
      return PENDING;
    }
    entry.block = { number: final.number, hash: final.hash, index: final.index };
    const paid = final.records.find((r) => r.event.section === "transactionPayment" && r.event.method === "TransactionFeePaid");
    entry.fee = paid ? BigInt(paid.event.data[1].toString()).toString() : null;
    const transfer = final.records.find((r) => r.event.section === "balances" && r.event.method === "Transfer");
    const moved = transfer ? BigInt(transfer.event.data[2].toString()) : 0n;
    const ok =
      check(final.events.includes("system.ExtrinsicSuccess"), `final in block #${fmt(final.number)} ${final.hash}${final.dispatchError ? `: ${final.dispatchError}` : ""}`) &&
      check(!!transfer && moved === o.amount && equalBytes((transfer.event.data[1] as unknown as Codec).toU8a(), keyring.decodeAddress(to)), `balances.Transfer of ${formatTpot(moved)} to ${to}`);
    entry.status = ok ? "final" : "failed";
    saveV3Record(record);
    const after = await accountState((await finalizedHead(api)).apiAt, keyring.decodeAddress(to));
    log(`     ${to} now holds ${formatTpot(after.free)} free`);
    return ok && failures === 0 ? OK : FAILED;
  } finally {
    await api.disconnect();
  }
}

// ---------------------------------------------------------------------------------------
// status

async function statusCommand(o: Common): Promise<number> {
  log(`${new Date().toISOString()}: the return path from Sepolia to ${V3.title} (${TRUST})`);
  const b = readBridge();
  const record = readV3Record();
  const { Keyring } = await polkadot();
  const keyring = new Keyring({ type: "sr25519", ss58Format: V3.ss58 });
  const v = vaultFacts(record, keyring);

  // Sepolia: the burns, from the logs, or from the views when the RPC refuses old logs.
  await checkSepolia();
  const latest = await sepolia("latest block", () => rpc<{ number: string }>("eth_getBlockByNumber", ["latest", false]));
  const finalized = await sepolia("finalized block", () => rpc<{ number: string }>("eth_getBlockByNumber", ["finalized", false]));
  const L = Number(BigInt(latest.number));
  const F = Number(BigInt(finalized.number));
  const state = await sepoliaState(b, latest.number);
  log(`Sepolia block ${fmt(L)} (finalized ${fmt(F)}): BridgeMinter ${checksumAddress(hexToBytes(b.minter))}, ${state.burnCount} burn${state.burnCount === 1n ? "" : "s"}; wtPOT total supply ${formatWtpot(state.totalSupply)}`);
  const found = await sepoliaLogs({ address: b.minter, topics: [BURN_REQUESTED_TOPIC] }, b.deployBlock, L);
  const burns: { burnNonce: bigint; burnId: Uint8Array; burn: BurnOnChain | null; source: string }[] = [];
  if ("refused" in found) {
    log(`     the Sepolia RPC refuses eth_getLogs (${found.refused}): the burns from burnCount and burnIdOf, their amounts and recipients from ${BRIDGE_RECORD} where it has them`);
    for (let i = 0n; i < state.burnCount; i++) {
      const id = wordAt(await sepoliaView(b.minter, callData(MINTER.burnIdOf, uintWord(i)), latest.number), 0);
      const s = b.record.steps.find((x) => x.kind === "burn" && x.ok && x.burn?.burnNonce === i.toString() && x.burn.burnId === bytesToHex(id));
      const burn: BurnOnChain | null = s?.burn && s.txHash && s.block !== null ? { burnNonce: i, from: hexToBytes(s.sender), v3Recipient: hexToBytes(s.burn.v3Recipient), amount: BigInt(s.burn.amount), burnId: id, txHash: s.txHash, block: s.block, blockHash: null } : null;
      burns.push({ burnNonce: i, burnId: id, burn, source: burn ? BRIDGE_RECORD : "burnIdOf" });
    }
  } else {
    for (const l of found.logs.filter((x) => x.address.toLowerCase() === b.minter)) {
      const e = burnOfLog(l);
      burns.push({ burnNonce: e.burnNonce, burnId: e.burnId, burn: e, source: "its log" });
    }
    check(BigInt(burns.length) === state.burnCount && burns.every((x, i) => x.burnNonce === BigInt(i)), `one BurnRequested log for each of the ${state.burnCount} burns, from #${fmt(b.deployBlock)}`);
  }

  // V3: the vault, the committee and its open operations, and each burn's release.
  const evm = new EvmRpc(o.evm);
  const api = await connectV3(o.rpc, false);
  try {
    await checkV3(api, evm);
    const head = await finalizedHead(api);
    await checkVault(api, evm, head, v);
    await checkCommittee(head, v);
    const outstanding = await vaultWord(head, v.address, SLOTS.outstanding);
    const releasedLogs = await evm.logs({ address: bytesToHex(v.address), topics: [RELEASED_TOPIC] }, v.block, head.number);
    const logged = new Map<Hex, ReturnType<typeof decodeReleased> & { block: number }>();
    for (const l of releasedLogs ?? []) logged.set(bytesToHex(decodeReleased(l).burnId), { ...decodeReleased(l), block: Number(BigInt(l.blockNumber ?? "0")) });
    log(`V3 finalized block ${fmt(head.number)}: the vault's outstanding ${formatTpot(outstanding)}; ${releasedLogs === null ? "the EVM RPC refuses eth_getLogs" : `${logged.size} Released log${logged.size === 1 ? "" : "s"} through eth_getLogs`}`);
    const ops = await operations(api, head, v, record, api.tx.revive.call.callIndex);
    let unreleased = 0n;
    let releasedSum = 0n;
    const known = new Set<Hex>();
    log(`\n${burns.length} burn${burns.length === 1 ? "" : "s"}:`);
    for (const x of burns) {
      const id = bytesToHex(x.burnId);
      known.add(id);
      const convention = equalBytes(x.burnId, burnId(SEPOLIA_CHAIN_ID, hexToBytes(b.minter), x.burnNonce));
      const flag = await vaultWord(head, v.address, releasedSlot(x.burnId));
      const round = [...(record.releases ?? [])].reverse().find((r) => r.burn.burnId === id);
      const op = ops.find((y) => y.release && equalBytes(y.release.burnId, x.burnId));
      const what = x.burn
        ? `${formatWtpot(x.burn.amount)} from ${checksumAddress(x.burn.from)} for ${checksumAddress(x.burn.v3Recipient)}, #${fmt(x.burn.block)}${x.burn.block <= F ? "" : " (not final yet)"} (${x.source})`
        : "amount and recipient unknown (no logs, nor a record of it)";
      let releaseState: string;
      if (flag !== 0n) {
        const l = logged.get(id);
        const amount = l?.amountNative ?? (round ? BigInt(round.amountNative) : x.burn?.amount ?? 0n);
        releasedSum += amount;
        const matches = !x.burn || (amount === x.burn.amount && (!l || equalBytes(l.to, x.burn.v3Recipient)));
        check(matches, `     released[${shortHex(id)}] is true: ${formatTpot(amount)}${l ? ` to ${checksumAddress(l.to)} (#${fmt(l.block)}, Released log)` : round?.released ? ` to ${checksumAddress(hexToBytes(round.payee))} (#${fmt(round.released.block.number)}, ${V3_RECORD})` : ""}${matches ? ", the burn's amount and recipient" : ", NOT the burn's amount and recipient"}`);
        releaseState = "RELEASED";
      } else {
        unreleased += x.burn?.amount ?? 0n;
        releaseState = op ? `not released; open: approved by member ${op.approvals.map((a) => memberOf(v, keyring, a)).join(", ")} at #${fmt(op.when.height)}` : "not released; no approval yet";
      }
      check(convention, `burn ${x.burnNonce}: ${what}; burn id ${shortHex(id)} (the vault's convention); ${releaseState}`);
    }
    for (const [id, l] of logged) if (!known.has(id)) check(false, `a Released log at #${fmt(l.block)} for burn id ${shortHex(id)}, which no burn on Sepolia has: ${formatTpot(l.amountNative)} to ${checksumAddress(l.to)}`);
    for (const op of ops.filter((x) => !x.release || !known.has(bytesToHex(x.release.burnId)))) {
      log(`     open operation ${shortHex(op.hash)} at #${fmt(op.when.height)}: ${op.release ? `releases burn id ${shortHex(op.release.burnId)}, which no burn on Sepolia has` : "not a release of the vault"} (${op.source})`);
    }
    for (const r of (record.releases ?? []).filter((x) => x.status !== "released")) log(`     note: ${V3_RECORD} has the round of burn ${r.burn.burnNonce} (${shortHex(r.call.hash)}) as ${r.status}, approvals ${r.approvals.map((a) => `${a.action} by member ${a.member} ${a.status}`).join(", ") || "none"}`);

    // The members and the multisig.
    const ed = api.consts.balances.existentialDeposit.toBigInt();
    log(`\nThe committee ${v.multisig} (${v.threshold} of ${v.members.length}, RELEASER ${checksumAddress(v.releaser)}):`);
    for (const [label, account] of [["multisig", v.multisig], ...v.members.map((m, i) => [`member ${i + 1}`, m])] as [string, string][]) {
      const a = await accountState(head.apiAt, keyring.decodeAddress(account));
      log(`     ${label} ${account}: ${formatTpot(a.free)} free${a.reserved ? `, ${formatTpot(a.reserved)} reserved` : ""}, nonce ${a.nonce}${!a.exists ? " (does not exist yet)" : a.free < ed ? " (below the existential deposit)" : ""}`);
    }

    // The accounting: outstanding = locked - released, and every burn was minted first.
    const due = state.totalSupply + unreleased;
    check(outstanding >= due, `the vault's outstanding ${formatTpot(outstanding)} covers the wtPOT supply ${formatWtpot(state.totalSupply)} and the burns not released yet ${formatTpot(unreleased)}`);
    log(`     ${formatTpot(releasedSum)} released in all; locks not minted yet account for the rest (${formatTpot(outstanding - due)})`);
    return failures === 0 ? OK : FAILED;
  } finally {
    await api.disconnect();
  }
}

// ---------------------------------------------------------------------------------------

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  // Every fetch of this process refuses the write methods: --send on Sepolia sends through cast
  // publish alone; the V3 node's provider is guarded in connectV3 unless the command signs there.
  installDryRunGuard();
  const banner = (send: boolean) => {
    if (!send) log("(dry run: nothing is signed, and this process's RPC clients refuse eth_send*, eth_sign*, personal_* and author_submit*)");
  };
  switch (command) {
    case "burn": {
      const o = burnOptions(args);
      banner(o.send);
      return burnCommand(o);
    }
    case "release": {
      const o = releaseOptions(args);
      banner(o.send);
      return "watch" in o ? watchCommand(o) : releaseCommand(o);
    }
    case "fund": {
      const o = fundOptions(args);
      banner(o.send);
      return fundCommand(o);
    }
    case "status":
      return statusCommand(statusOptions(args));
    default:
      usage(command ? `unknown command ${JSON.stringify(command)}` : "no command");
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof Usage) {
      log(`${errorText(error)}\n${USAGE}`);
      process.exitCode = FAILED;
    } else if (error instanceof Unreachable) {
      log(errorText(error));
      process.exitCode = UNREACHABLE;
    } else {
      check(false, errorText(error));
      process.exitCode = FAILED;
    }
  },
);
