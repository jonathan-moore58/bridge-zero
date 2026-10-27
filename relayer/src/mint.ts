// The mint tool: a lock in PortaldotVault on the Portaldot V3 testnet becomes wtPOT on Sepolia
// through BridgeMinter, which takes V3 finality from GrandpaLightClient #2 and proves the lock's
// commitment from the vault's storage. The tool captures a mint bundle, dry-runs the deployment
// and the mint with eth_simulateV1, sends them, and reads the bridge back.
//
//   npm run mint -- bundle --nonce <n> [--out <dir>] [--force]
//   npm run mint -- bundle --check <file>
//   npm run mint -- plan [--bundle <file> | --nonce <n>] [--sandbox] [--from <address>]
//   npm run mint -- deploy [--bundle <file> | --nonce <n>] [--send --account <keystore> --password-file <path>]
//   npm run mint -- mint [--bundle <file> | --nonce <n>] [--from <address>] [--send --account <keystore> --password-file <path>]
//   npm run mint -- mint --tamper signature|header|proof|amount|recipient | --replay [--bundle <file> | --nonce <n>] [--sandbox | --from <address> | --send ...]
//   npm run mint -- status
//   more options: --rpc <wss url> (the V3 node), --evm <http(s) url> (its EVM RPC), --artifacts <dir>
//   (the Sepolia build, by default contracts/out-sepolia), --priority-fee <gwei>, --max-fee <gwei>
//
// bundle --nonce reads, at the latest finalized V3 block B, everything one importAndMint of lock
// <n> needs, and writes it to <dir>/mint-bundle.json (by default fixtures/v3-testnet-mint), nothing
// else, and not over a file that is there already unless --force: B's header (its SCALE bytes must
// hash to B's hash; neither B nor its parent may change a set: the capture is refused with "run
// again in a few seconds") and its parent header; grandpa_proveFinality(B), without unknown
// headers, whose justification is verified under Grandpa.CurrentSetId and
// GrandpaApi_grandpa_authorities at B's parent (the set that signs B; both must hold the same set
// at B, which changes none) with the light client's own signature check (grandpa.ts
// clientVerifies); the signers hint, built as relay.ts builds it; and, under B's state
// root, the read proofs of Revive.AccountInfoOf(vault), of the vault's child-trie root and of
// commitments[n] in the child trie (chain.ts, as capture-contract.ts reads them). Each proof is
// walked here; the account entry must be a contract whose code hash is the recorded vault's, and
// the slot must hold the commitment recomputed from the lock in deployments/v3-testnet.json (or the
// vault's Locked log). The node discards state after about 256 blocks, so the proofs are read at
// the head; the bundle stays usable while the light client is in B's set and not past B. bundle
// --check verifies a bundle file offline the same way (check.ts verifies it again in its own style).
//
// plan and mint take a bundle file (--bundle), a capture of lock <n> that is checked the same way
// and not written (--nonce), or else fixtures/v3-testnet-mint/mint-bundle.json, where bundle writes.
// plan dry-runs the whole path on Sepolia with eth_simulateV1 (validation on): while BridgeMinter
// is not deployed, its creation from the deployer at nonce 31 (CREATE(deployer, 31), the minter
// lock 0 names), with GrandpaLightClient #2, the vault, V3's chain id, the vault's code hash and
// the token's address CREATE(deployer, 32) as constructor arguments, and WrappedTPOT's creation at
// nonce 32 with the minter's address; then importAndMint(bundle), which binds the vault in the same
// call while the minter is not bound. It refuses unless the deployer's next nonce, mined and
// pending, is 31 and CREATE(deployer, 31) is the lock's minter; and unless the light client can
// import B: it has to be at B's set and below B (or hold B), so while it lags behind the bundle's
// set the plan says to run the relayer first instead of showing the import's revert, and once it
// is past B it says to capture the bundle again: importing into the light client is open to
// anyone, so a head any relayer imports (ours or another's) can move it past B, and a mint sent
// then reverts NotNewer. Every transaction runs first with the 16,777,216 cap as gas limit, then
// with the limit it is sent with (its gas + 10%), from its sender at the nonce and with the balance
// it has on chain, as script/deploy-sepolia.mjs runs its plan; a request goes on from what the one
// before left. The plan prints the gas, the fees and the cost, checks the events (HeaderImported,
// VaultBound, Minted, Transfer), reads the wtPOT balance after, and runs the same importAndMint
// once more from another sender, which must verify B again and revert with NonceAlreadyUsed.
// plan --sandbox runs the same path on a light client of its own: a sandbox sender creates a fresh
// GrandpaLightClient from the Sepolia build (its libraries are the ones on chain) and initializes it
// at the bundle's set with B's parent as the checkpoint, so that importAndMint imports B itself; the
// minter then points at that client. The deployer's nonce is 31 in the sandbox and the minter's and
// token's addresses are empty there, so the whole path runs on Sepolia's EVM without a relayer run,
// before or after the deployment, and nothing is sent.
// Before it plans, every run of plan, deploy and mint settles what an earlier --send run left open
// in deployments/sepolia-bridge.json (a hash recorded, no block): a mined transaction gets its
// receipt and the checks it allows, a pending one stays open, one neither mined nor pending is
// marked dropped, which lets a later --send send it again.
// deploy dry-runs the two creations (or the token's alone if the minter is there) and mint the
// importAndMint, as plan does; with --send they then send them one transaction at a time the way
// deploy-sepolia.mjs does: cast mktx with the keystore, the transaction's hash recorded in
// deployments/sepolia-bridge.json before cast publish, then the receipt and its events checked. A
// creation's code must be the build's, with the constructor arguments as its immutables, and the
// build must be compiled from the checkout's sources; the record keeps the constructor arguments,
// and the Etherscan verification command (sepolia profile) is printed for each contract, in the
// dry run too. deploy needs the deployer's keystore; the mint is open to anyone. A deploy reads the
// lock (lock 0 unless --bundle or --nonce) only for its minter address.
// mint --tamper and mint --replay are the demo's two reverts, as transactions anyone can send. A
// tamper is the bundle's importAndMint with one part changed (bridge.ts tamperedCall: a signature
// byte in the finality proof, a byte of B's state root in the header, a byte of the slot proof,
// the amount, or the recipient), which has to revert with the error that names that part, before
// the lock is minted or after it. The replay, once the lock is minted, is the same importAndMint
// again: the light client verifies B again and the minter answers NonceAlreadyUsed. Each is
// dry-run like the mint and must get exactly that revert from the node; with --send it is sent and
// recorded the same way and checked: status 0 in the receipt, and the call replayed on its block
// reverting with that error. Its gas limit is the one it was dry-run with, 5,000,000, not its gas
// + 10%: on the Sepolia node a call that reverts can need a limit well above the gas it reports.
// With --sandbox they run on plan --sandbox's path instead: the tamper before the mint and again
// after it, the replay after it, nothing sent.
// status reads the minter (bound, trie id, burns), the token (total supply, each recipient's
// balance) and the vault on V3 as v3-vault.ts status reads it (each lock's commitment recomputed and
// compared with its event and with storage, and the accounting), and says which locks are minted and
// whether each burn has been released on V3, which the committee does (the trusted return path). It
// reads the logs in windows of at most 10,000 blocks from each contract's deploy block; when an RPC
// refuses old logs (the public Sepolia RPC answers "pruned history unavailable" after about a week)
// it falls back to the views: burnCount and burnIdOf on Sepolia, nextNonce and the commitments with
// the record's lock fields on V3. A release has its Released log through eth_getLogs only when V3's
// EVM RPC serves it, which it does for Ethereum transactions; the committee's releases are
// Substrate extrinsics, counted from released[burnId] and the burn's amount.
//
// Nothing is signed without --send, and --account and --password-file are refused without it.
// Every RPC client of this process refuses eth_send*, eth_sign*, personal_* and author_submit*
// before anything reaches the wire (bridge.ts installDryRunGuard): with --send, cast publish sends.
// The Sepolia RPC is SEPOLIA_RPC_URL when set, else the public endpoint; of it and of a custom --rpc
// or --evm URL only the host is printed. Exit code 0 when the bundle is written or checks out, the
// dry run passed, the transactions are mined and checked, or status found nothing wrong; 1 when a
// check fails or the tool refuses; 2 when a node cannot be reached; 3 when a sent transaction is
// still pending.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  addressAt,
  AUTHORITY_SET_CHANGED_TOPIC,
  BRIDGE_ERRORS,
  BURN_REQUESTED_TOPIC,
  bundleCalldata,
  callData,
  checkBundle,
  CLIENT,
  decodeBurnRequested,
  decodeHeaderImported,
  decodeMinted,
  decodeTransfer,
  decodeVaultBound,
  DryRunViolation,
  errorMap,
  formatWtpot,
  HALTED_TOPIC,
  HEADER_IMPORTED_TOPIC,
  immutablesProblem,
  initializeCalldata,
  initializeWrites,
  installDryRunGuard,
  librariesIn,
  logWindows,
  MINTED_TOPIC,
  MINTER,
  minterConstructorArgs,
  replayCall,
  revertName,
  SEPOLIA_CHAIN_ID,
  signersHint,
  sourceHashes,
  TAMPERS,
  tamperedCall,
  TOKEN,
  tokenConstructorArgs,
  TRANSFER_TOPIC,
  uintAt,
  V3_CHAIN_ID,
  VAULT_BOUND_TOPIC,
  wordAt,
  type ExpectedRevert,
  type ImmutableReferences,
  type Tamper,
} from "./bridge.js";
import { bytesToHex, equalBytes, hexToBytes, shortHex, toSafeNumber, type Hex } from "./bytes.js";
import { Chain, childItems } from "./chain.js";
import {
  authoritySetJson,
  headerJson,
  justificationJson,
  proofJson,
  readJson,
  writeJson,
  type BlockRef,
  type MintBundleFixture,
  type StateAuthoritySetJson,
  type ToolInfo,
} from "./fixture.js";
import { threshold } from "./grandpa.js";
import { CHILD_STORAGE_DEFAULT_PREFIX, childRootKey, storageKey } from "./hash.js";
import { decodeReviveAccountInfo, reviveAccountInfoKey, reviveSlotKey } from "./revive.js";
import { RpcClient, RpcError } from "./rpc.js";
import { decodeAuthorityList, decodeFinalityProof, decodeJustification, decodeU64, grandpaLogs } from "./scale.js";
import { readProof } from "./trie.js";
import {
  addressWord,
  burnId,
  checksumAddress,
  commitmentSlot,
  createAddress,
  decodeLocked,
  decodeReleased,
  formatTpot,
  LOCKED_TOPIC,
  lockCommitment,
  parseAddress,
  releasedSlot,
  RELEASED_TOPIC,
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
  RECEIPT_TIMEOUT,
  REQUEST_GAS,
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

/** The Portaldot V3 testnet, where the vault runs. */
const V3 = {
  title: "the Portaldot V3 testnet",
  rpc: "wss://test-node-v3.portaldot.dev",
  evm: "https://test-evm-rpc-v3.portaldot.dev",
  genesis: "0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd",
  chainId: V3_CHAIN_ID,
} as const;
/** The light client on Sepolia that follows V3 (deployments/sepolia.json). */
const CLIENT_NAME = "GrandpaLightClient #2";
/** The deployer's nonces that create the minter and the token: lock 0 names CREATE(deployer, 31) as its minter. */
const MINTER_NONCE = 31;
const TOKEN_NONCE = 32;

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SEPOLIA_RECORD = "deployments/sepolia.json";
const V3_RECORD = "deployments/v3-testnet.json";
const BRIDGE_RECORD = "deployments/sepolia-bridge.json";
const DEFAULT_ARTIFACTS = "contracts/out-sepolia";
const DEFAULT_OUT = "fixtures/v3-testnet-mint";
const BUNDLE_FILE = "mint-bundle.json";
const at = (path: string) => resolve(ROOT, path);
/** A path as the repository names it, for the record and the log. */
const repoPath = (path: string) => relative(ROOT, path).replaceAll("\\", "/");

/** Creates and initializes the sandbox light client in a simulation; its balance is a state override. */
const SANDBOX_SENDER = "0x00000000000000000000000000000000b21d5a9d" as const;
/** Gas limit of each view read at the end of a simulated request. */
const VIEW_GAS = 200_000;
/**
 * Gas limit of a call that has to revert: importAndMint replayed after the mint, which verifies B
 * again (about 2,000,000 gas with 2 signatures) before it reverts, and the demo's reverts, which are
 * measured and sent with it.
 */
const REPLAY_GAS = 5_000_000;
/** Returns SLOAD of each 32-byte word of its calldata; put at a contract's address in a later simulated block, it reads that contract's storage. */
const DUMPER_CODE = "0x5f5b8036111560145780355481526020016001565b365ff3";
const dumpGas = (slots: number) => 50_000 + 3_000 * slots;
const SET_ID_KEY = storageKey("Grandpa", "CurrentSetId");
/** An empty account, as a state override: what the sandbox makes of the minter's and the token's addresses. */
const EMPTY_ACCOUNT = { code: "0x", nonce: "0x0", balance: "0x0", state: {} };

const OK = 0;
const FAILED = 1;
const UNREACHABLE = 2;
const PENDING = 3;

const log = (message = "") => console.log(message);
const errorText = (error: unknown) => redact(error instanceof Error ? error.message : String(error));
const tag = (s: Step) => `[${String(s.index).padStart(2)}]`;

let failures = 0;
function check(ok: boolean, what: string): boolean {
  log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures += 1;
  return ok;
}

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

/** The request never got an answer (fetch failed, timed out, or no JSON came back), as opposed to an error the RPC returned. */
const offline = (error: unknown) =>
  error instanceof TypeError || error instanceof SyntaxError || (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"));

/**
 * A Sepolia read, retried as a load-balanced RPC can lag: Unreachable when it never got an answer,
 * Stop with the RPC's error otherwise. The dry-run guard's refusal is passed on as it is.
 */
async function sepolia<R>(what: string, read: () => Promise<R>): Promise<R> {
  try {
    return await retry(what, read);
  } catch (error) {
    if (error instanceof DryRunViolation) throw error;
    if (offline(error)) throw new Unreachable(`Sepolia RPC unreachable (${what}: ${errorText(error)})`);
    throw new Stop(`Sepolia RPC: ${what}: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------------------
// Options

const USAGE = `usage (from relayer/):
  npm run mint -- bundle --nonce <n> [--out <dir>] [--force]
  npm run mint -- bundle --check <file>
  npm run mint -- plan [--bundle <file> | --nonce <n>] [--sandbox] [--from <address>]
  npm run mint -- deploy [--bundle <file> | --nonce <n>] [--send --account <keystore> --password-file <path>]
  npm run mint -- mint [--bundle <file> | --nonce <n>] [--from <address>] [--send --account <keystore> --password-file <path>]
  npm run mint -- mint --tamper ${TAMPERS.join("|")} | --replay [--bundle <file> | --nonce <n>] [--sandbox | --from <address> | --send ...]
  npm run mint -- status
  more options: --rpc <wss url>, --evm <http(s) url>, --artifacts <dir>, --priority-fee <gwei>, --max-fee <gwei>
  plan and mint read ${DEFAULT_OUT}/${BUNDLE_FILE} unless given --bundle or --nonce`;

function usage(problem: string): never {
  throw new Usage(problem);
}

interface Common {
  rpc: string;
  evm: string;
}

interface BundleOptions extends Common {
  nonce?: bigint;
  out: string;
  /** Write over a bundle file that is there already. */
  force: boolean;
  checkFile?: string;
}

type Command = "plan" | "deploy" | "mint";

interface PlanOptions extends Common {
  command: Command;
  bundleFile?: string;
  nonce?: bigint;
  sandbox: boolean;
  /** mint only: the demo's tampered importAndMint, or its replay. */
  tamper?: Tamper;
  replay: boolean;
  from?: Hex;
  send: boolean;
  account?: string;
  passwordFile?: string;
  artifacts: string;
  priorityFee?: bigint;
  maxFee?: bigint;
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

/** A lock nonce: a whole number written as digits only, as the vault counts them. */
function parseNonce(text: string): bigint {
  if (!/^\d+$/.test(text)) throw new Error(`a lock nonce is a whole number, got ${JSON.stringify(text)}`);
  const value = BigInt(text);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${text} is above any nonce the vault will reach`);
  return value;
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

function bundleOptions(args: string[]): BundleOptions {
  const v = parse(args, { nonce: { type: "string" }, out: { type: "string" }, check: { type: "string" }, force: { type: "boolean", default: false }, ...COMMON });
  const nonceText = str(v.nonce);
  const checkFile = str(v.check);
  if ((nonceText === undefined) === (checkFile === undefined)) usage("bundle takes --nonce <n> (to capture one) or --check <file> (to verify one)");
  if (checkFile !== undefined && (str(v.out) !== undefined || str(v.rpc) !== undefined || str(v.evm) !== undefined || v.force === true)) usage("--check is offline: --out, --force, --rpc and --evm are for a capture");
  return {
    ...parseCommon(v),
    nonce: nonceText === undefined ? undefined : option("--nonce", () => parseNonce(nonceText)),
    out: resolve(str(v.out) ?? at(DEFAULT_OUT)),
    force: v.force === true,
    checkFile: checkFile === undefined ? undefined : resolve(checkFile),
  };
}

function planOptions(command: Command, args: string[]): PlanOptions {
  const v = parse(args, {
    bundle: { type: "string" },
    nonce: { type: "string" },
    sandbox: { type: "boolean", default: false },
    tamper: { type: "string" },
    replay: { type: "boolean", default: false },
    from: { type: "string" },
    send: { type: "boolean", default: false },
    account: { type: "string" },
    "password-file": { type: "string" },
    artifacts: { type: "string" },
    "priority-fee": { type: "string" },
    "max-fee": { type: "string" },
    ...COMMON,
  });
  let bundleFile = str(v.bundle);
  const nonceText = str(v.nonce);
  if (bundleFile !== undefined && nonceText !== undefined) usage("choose one of --bundle <file> and --nonce <n>");
  if (bundleFile === undefined && nonceText === undefined && command !== "deploy") {
    bundleFile = at(join(DEFAULT_OUT, BUNDLE_FILE));
    if (!existsSync(bundleFile)) usage(`${command} reads ${DEFAULT_OUT}/${BUNDLE_FILE} unless given --bundle <file> or --nonce <n>, and there is none: capture one with bundle --nonce <n>`);
  } else if (bundleFile !== undefined && !existsSync(resolve(bundleFile))) usage(`--bundle: no file at ${resolve(bundleFile)}`);
  const sandbox = v.sandbox === true;
  const send = v.send === true;
  const tamperText = str(v.tamper);
  const replay = v.replay === true;
  if ((tamperText !== undefined || replay) && command !== "mint") usage("--tamper and --replay are for mint");
  if (tamperText !== undefined && replay) usage("choose one of --tamper <part> and --replay");
  if (tamperText !== undefined && !(TAMPERS as readonly string[]).includes(tamperText)) usage(`--tamper takes one of ${TAMPERS.join(", ")}`);
  if (sandbox && command === "deploy") usage("--sandbox is for plan and mint");
  if (sandbox && send) usage("--sandbox is a dry run: it sends nothing");
  if (send && command === "plan") usage("plan is a dry run: deploy and mint take --send");
  const account = str(v.account);
  const passwordText = str(v["password-file"]);
  if (!send && (account !== undefined || passwordText !== undefined)) usage("--account and --password-file are for --send; a dry run signs nothing");
  if (send && !(account && passwordText)) usage("--send needs --account <keystore name> and --password-file <path>");
  const fromText = str(v.from);
  if (fromText !== undefined && command === "deploy") usage("the deployer creates the contracts: --from is for plan and mint");
  if (fromText !== undefined && send) usage("--from is for a dry run: --send sends from the address its keystore unlocks to");
  // cast runs in a directory of its own: the path is made absolute here (this script never opens it).
  const passwordFile = passwordText === undefined ? undefined : resolve(passwordText);
  redactAlso(passwordFile, passwordText);
  if (passwordFile !== undefined && !existsSync(passwordFile)) usage("--password-file: no such file");
  const gwei = (name: string) => {
    const text = str(v[name]);
    return text === undefined ? undefined : option(`--${name}`, () => parseGwei(text));
  };
  return {
    ...parseCommon(v),
    command,
    bundleFile: bundleFile === undefined ? undefined : resolve(bundleFile),
    nonce: nonceText === undefined ? undefined : option("--nonce", () => parseNonce(nonceText)),
    sandbox,
    tamper: tamperText as Tamper | undefined,
    replay,
    from: fromText === undefined ? undefined : bytesToHex(option("--from", () => parseAddress(fromText, "an address"))),
    send,
    account,
    passwordFile,
    artifacts: resolve(str(v.artifacts) ?? at(DEFAULT_ARTIFACTS)),
    priorityFee: gwei("priority-fee"),
    maxFee: gwei("max-fee"),
  };
}

function statusOptions(args: string[]): Common {
  return parseCommon(parse(args, COMMON));
}

// ---------------------------------------------------------------------------------------
// The records

/** What deployments/sepolia.json says: the deployer and the light client that follows V3. */
interface SepoliaDeployment {
  deployer: Hex;
  deployerName: string;
  client: Hex;
  clientCodeHash: Hex;
}

function readSepolia(): SepoliaDeployment {
  const record = readJson<{ chainId: number; deployer: string; contracts: Record<string, string>; steps: { name: string; codeHash: string | null }[] }>(at(SEPOLIA_RECORD));
  const client = record.contracts?.[CLIENT_NAME];
  const codeHash = record.steps?.find((s) => s.name === CLIENT_NAME)?.codeHash;
  if (record.chainId !== Number(SEPOLIA_CHAIN_ID) || !client || !codeHash) throw new Stop(`${SEPOLIA_RECORD} has no ${CLIENT_NAME} on Sepolia`);
  return { deployer: record.deployer.toLowerCase() as Hex, deployerName: record.deployer, client: client.toLowerCase() as Hex, clientCodeHash: codeHash.toLowerCase() as Hex };
}

/** A lock as deployments/v3-testnet.json records it (v3-vault.ts). */
interface RecordedLock {
  status: string;
  txHash: Hex;
  vault: Hex;
  dstChainId: string;
  dstMinter: Hex;
  recipient: Hex;
  amountNative: string;
  vaultNonce?: string;
  commitment?: Hex;
}

/** A release round as deployments/v3-testnet.json records it (release.ts). */
interface RecordedRelease {
  status: string;
  burn: { burnNonce: string; burnId: Hex };
  payee: Hex;
  amountNative: string;
  released?: { block: { number: number } };
}

/** What deployments/v3-testnet.json says: the vault, its code hash, the block it was deployed in, its locks, and the committee's releases. */
interface VaultDeployment {
  address: Hex;
  codeHash: Hex;
  block: number;
  locks: RecordedLock[];
  releases: RecordedRelease[];
}

function readV3(): VaultDeployment {
  const record = readJson<{
    network: string;
    genesisHash: string;
    chainId: number;
    vault: { status: string; address: string; codeHash: string | null; block: { number: number } | null } | null;
    locks: RecordedLock[];
    releases?: RecordedRelease[];
  }>(at(V3_RECORD));
  if (record.genesisHash !== V3.genesis || BigInt(record.chainId) !== V3.chainId) throw new Stop(`${V3_RECORD} is not a record of ${V3.title}`);
  const vault = record.vault;
  if (!vault || vault.status !== "deployed" || !vault.codeHash || !vault.block) throw new Stop(`${V3_RECORD} records no deployed vault`);
  return {
    address: vault.address.toLowerCase() as Hex,
    codeHash: vault.codeHash.toLowerCase() as Hex,
    block: vault.block.number,
    locks: Array.isArray(record.locks) ? record.locks : [],
    releases: Array.isArray(record.releases) ? record.releases : [],
  };
}

/**
 * One transaction of the bridge deployment, one mint, or one of the demo's reverts, in
 * deployments/sepolia-bridge.json; release.ts writes the burns of the trusted return path there
 * too (kind "burn").
 */
interface BridgeStep {
  name: string;
  kind: "deploy" | "mint" | "tamper" | "replay" | "burn";
  nonce: number;
  sender: Hex;
  contract: string;
  address: Hex;
  /** A deployment: the libraries its code calls, as linked at compile time, and its constructor arguments. */
  libraries?: Record<string, string>;
  constructorArgs?: Hex;
  /** A mint, a tamper or a replay: the lock, and the bundle's file and block. */
  lock?: { nonce: number; recipient: Hex; amountNative: string };
  bundle?: { file: string | null; block: BlockRef; setId: number };
  /** A tamper or a replay: what was changed, and the error it has to revert with, by name and as revert data. */
  tamper?: { part: Tamper; what: string };
  expectedRevert?: { name: string; data: Hex };
  /** A burn (release.ts): what it asked for, and the burn nonce and id the minter gave it. */
  burn?: { amount: string; v3Recipient: Hex; expected: { burnNonce: string; burnId: Hex }; burnNonce: string | null; burnId: Hex | null };
  dataHash: Hex;
  gasLimit: number | null;
  simulatedGas: number | null;
  /** keccak256 of the code a deployment leaves, as simulated. */
  codeHash: Hex | null;
  txHash: Hex | null;
  signedAt: string | null;
  block: number | null;
  gasUsed: number | null;
  effectiveGasPrice: string | null;
  status: number | null;
  ok: boolean | null;
  /** Transactions at this nonce that were never mined. */
  dropped?: Hex[];
  note?: string;
}

interface BridgeRecord {
  network: "sepolia";
  chainId: number;
  deployer: string;
  lightClient: { name: string; address: Hex };
  vault: { network: string; chainId: number; address: Hex; codeHash: Hex };
  /** keccak256 of each contract's creation code in the build it was deployed from. */
  artifacts: Record<string, Hex>;
  contracts: Record<string, Hex>;
  steps: BridgeStep[];
}

function readBridge(): BridgeRecord | null {
  const path = at(BRIDGE_RECORD);
  if (!existsSync(path)) return null;
  let record: BridgeRecord;
  try {
    record = readJson<BridgeRecord>(path);
  } catch (error) {
    throw new Stop(`${BRIDGE_RECORD}: ${errorText(error)}`);
  }
  if (record.network !== "sepolia" || record.chainId !== Number(SEPOLIA_CHAIN_ID) || !Array.isArray(record.steps)) throw new Stop(`${BRIDGE_RECORD} is not a Sepolia bridge record`);
  return record;
}

function saveBridge(record: BridgeRecord): void {
  record.contracts = {};
  for (const s of record.steps) if (s.kind === "deploy" && s.ok) record.contracts[s.name] = s.address;
  try {
    writeJsonAtomic(at(BRIDGE_RECORD), record);
  } catch (error) {
    throw new Stop(`${BRIDGE_RECORD} could not be written: ${errorText(error)}`);
  }
}

function toolInfo(): ToolInfo {
  const pkg = readJson<{ name: string; version: string }>(fileURLToPath(new URL("../package.json", import.meta.url)));
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
  return { name: pkg.name, version: pkg.version, script: "src/mint.ts", gitCommit, gitDirty };
}

// ---------------------------------------------------------------------------------------
// The Sepolia build

type ArtifactName = "BridgeMinter" | "WrappedTPOT" | "GrandpaLightClient";

interface Artifact {
  name: ArtifactName;
  path: string;
  /** `<source path>:<name>`, as forge names the contract. */
  contractId: string;
  initcode: Uint8Array;
  runtime: Uint8Array;
  immutables: ImmutableReferences;
  compiler: string;
  evmVersion: string;
  optimizerRuns: number | null;
  /** The libraries its code calls, `<source path>:<library>` => address, as the sepolia profile links them at compile time. */
  libraries: Record<string, string>;
  /** The errors its ABI declares, by signature. */
  errors: string[];
}

interface ArtifactJson {
  abi?: { type: string; name?: string; inputs?: { type: string }[] }[];
  bytecode?: { object?: string };
  deployedBytecode?: { object?: string; immutableReferences?: ImmutableReferences };
  metadata?: {
    compiler?: { version?: string };
    settings?: { evmVersion?: string; optimizer?: { enabled?: boolean; runs?: number }; libraries?: Record<string, string>; compilationTarget?: Record<string, string> };
    sources?: Record<string, { keccak256?: string }>;
  };
}

const artifacts = new Map<string, Artifact>();

/**
 * forge's output file of `name` in `dir`, read when first needed. Refused without code, with a
 * library placeholder left in it (the sepolia profile links the libraries at compile time),
 * compiled by another solc than 0.8.27, or compiled from sources other than the checkout's: a
 * deployment is verified on Etherscan against contracts/.
 */
function artifactOf(dir: string, name: ArtifactName): Artifact {
  const key = `${dir}|${name}`;
  const cached = artifacts.get(key);
  if (cached) return cached;
  const path = join(dir, `${name}.sol`, `${name}.json`);
  const rebuild = "build it in contracts/ with FOUNDRY_PROFILE=sepolia forge build --skip test --skip script";
  if (!existsSync(path)) throw new Stop(`no ${path}: ${rebuild}`);
  const a = readJson<ArtifactJson>(path);
  const initcode = a.bytecode?.object ?? "0x";
  const runtime = a.deployedBytecode?.object ?? "0x";
  if (initcode === "0x" || runtime === "0x") throw new Stop(`${path} has no bytecode`);
  if (initcode.includes("__$") || runtime.includes("__$")) throw new Stop(`${path} has an unlinked library placeholder: build it with FOUNDRY_PROFILE=sepolia, which links the libraries at compile time`);
  const settings = a.metadata?.settings;
  const target = Object.entries(settings?.compilationTarget ?? {});
  if (target.length !== 1 || target[0][1] !== name) throw new Stop(`${path} is not ${name}'s artifact`);
  const compiler = a.metadata?.compiler?.version ?? "unknown";
  if (!compiler.startsWith("0.8.27+")) throw new Stop(`${path} was compiled by solc ${compiler}, not 0.8.27`);
  const sources = Object.entries(a.metadata?.sources ?? {});
  const stale = sources.filter(([source, s]) => {
    const file = at(join("contracts", source));
    return !existsSync(file) || !sourceHashes(readFileSync(file)).includes(s.keccak256?.toLowerCase() as Hex);
  });
  if (sources.length === 0 || stale.length > 0) {
    const which = stale.length > 0 ? `contracts/${stale[0][0]}${stale.length > 1 ? ` and ${stale.length - 1} more` : ""}` : "no source list";
    throw new Stop(`${path} is not built from the current sources (${which}): ${rebuild}`);
  }
  const code = hexToBytes(initcode);
  const artifact: Artifact = {
    name,
    path,
    contractId: `${target[0][0]}:${name}`,
    initcode: code,
    runtime: hexToBytes(runtime),
    immutables: a.deployedBytecode?.immutableReferences ?? {},
    compiler,
    evmVersion: settings?.evmVersion ?? "unknown",
    optimizerRuns: settings?.optimizer?.enabled ? (settings.optimizer.runs ?? null) : null,
    libraries: librariesIn(code, settings?.libraries ?? {}),
    errors: (a.abi ?? []).filter((e) => e.type === "error" && e.name).map((e) => `${e.name}(${(e.inputs ?? []).map((i) => i.type).join(",")})`),
  };
  artifacts.set(key, artifact);
  return artifact;
}

/** The forge verify-contract command of a deployed contract, run with the sepolia profile. */
function verifyCommand(a: Artifact, address: Hex, constructorArgs: Hex): string {
  const parts = [
    "FOUNDRY_PROFILE=sepolia forge verify-contract", checksumAddress(hexToBytes(address)), a.contractId,
    "--chain sepolia --verifier etherscan --watch", `--compiler-version ${a.compiler}`, `--evm-version ${a.evmVersion}`,
  ];
  if (a.optimizerRuns !== null) parts.push(`--num-of-optimizations ${a.optimizerRuns}`);
  for (const [id, address] of Object.entries(a.libraries)) parts.push(`--libraries ${id}:${address}`);
  if (constructorArgs !== "0x") parts.push(`--constructor-args ${constructorArgs}`);
  return `(from contracts/, with ETHERSCAN_API_KEY set) ${parts.join(" ")}`;
}

// ---------------------------------------------------------------------------------------
// Portaldot V3

/** Grandpa.CurrentSetId at a block. */
async function setIdAt(chain: Chain, at: Hex): Promise<{ setId: bigint; scale: Uint8Array }> {
  const scale = await chain.storage(SET_ID_KEY, at);
  if (!scale) throw new Error(`Grandpa.CurrentSetId is empty at ${at}`);
  return { setId: decodeU64(scale, "Grandpa.CurrentSetId"), scale };
}

/** Grandpa.CurrentSetId and GrandpaApi_grandpa_authorities at a block, as capture.ts reads a set. */
async function authoritySet(chain: Chain, at: BlockRef): Promise<{ setId: bigint; keys: Uint8Array[]; json: StateAuthoritySetJson }> {
  const { setId, scale: setIdScale } = await setIdAt(chain, at.hash);
  const runtimeCallScale = hexToBytes(await chain.rpc.request<Hex>("state_call", ["GrandpaApi_grandpa_authorities", "0x", at.hash]));
  const authorities = decodeAuthorityList(runtimeCallScale);
  return { setId, keys: authorities.map((a) => a.id), json: authoritySetJson({ setId, at, authorities, setIdKey: SET_ID_KEY, setIdScale, runtimeCallScale }) };
}

/**
 * grandpa_proveFinality at `number`. A proof for a later block carries the headers in between,
 * which the client does not take (UnknownHeadersNotEmpty), so it is asked again at that block.
 */
async function finalityProof(chain: Chain, number: number): Promise<{ requested: number; scale: Uint8Array; block: Uint8Array; justification: Uint8Array }> {
  let requested = number;
  for (let attempt = 1; ; attempt++) {
    const hex = await chain.rpc.request<Hex | null>("grandpa_proveFinality", [requested]);
    if (!hex) throw new Stop(`grandpa_proveFinality(${requested}) returned no proof`);
    const scale = hexToBytes(hex);
    const proof = decodeFinalityProof(scale);
    if (proof.unknownHeaders.length === 0) return { requested, scale, block: proof.block, justification: proof.justification };
    if (attempt === 3) throw new Stop(`the finality proof still carries ${proof.unknownHeaders.length} unknown headers after ${attempt} tries; run again`);
    requested = decodeJustification(proof.justification).targetNumber;
    log(`     finality moved on during the call; asking again at #${fmt(requested)}`);
  }
}

/** Ethereum JSON-RPC over HTTP (the V3 EVM RPC); a request that gets no answer is tried 3 times, then it is Unreachable. */
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
        if (body.error) throw new RpcError(method, body.error.message ?? "error", body.error.code);
        if (body.result === undefined) throw new Error("a response without a result");
        return body.result;
      } catch (error) {
        if (error instanceof RpcError || error instanceof DryRunViolation) throw error;
        if (attempt === 3) throw new Unreachable(`the EVM RPC ${new URL(this.url).host} is unreachable (${method}: ${errorText(error)})`);
        await sleep(2_000);
      }
    }
  }

  async word(address: Hex, slot: Uint8Array | bigint, block: string): Promise<bigint> {
    const position = typeof slot === "bigint" ? qty(slot) : qty(BigInt(bytesToHex(slot)));
    const value = await this.call<string>("eth_getStorageAt", [address, position, block]);
    return value === "0x" ? 0n : BigInt(value);
  }

  /** eth_getLogs from `from` to `to` in windows of at most 10,000 blocks; { refused } when the RPC refuses a window. */
  async logs(filter: { address: Hex; topics: (string | string[])[] }, from: number, to: number): Promise<LogJson[] | { refused: string }> {
    const out: LogJson[] = [];
    for (const [a, z] of logWindows(from, to)) {
      try {
        out.push(...(await this.call<LogJson[]>("eth_getLogs", [{ ...filter, fromBlock: qty(a), toBlock: qty(z) }])));
      } catch (error) {
        if (error instanceof RpcError) return { refused: `${errorText(error)} for #${fmt(a)} to #${fmt(z)}` };
        throw error;
      }
    }
    return out;
  }
}

/**
 * eth_getLogs on Sepolia from `from` to `to` in windows of at most 10,000 blocks; { refused } when
 * the RPC refuses a window three times (the public RPC answers "pruned history unavailable" for
 * logs about a week old, and caps a range at 50,000 blocks).
 */
async function sepoliaLogs(filter: { address: Hex; topics: (string | string[])[] }, from: number, to: number): Promise<LogJson[] | { refused: string }> {
  const out: LogJson[] = [];
  for (const [a, z] of logWindows(from, to)) {
    for (let attempt = 1; ; attempt++) {
      const body = await sepolia("logs", () => rpcBody("eth_getLogs", [{ ...filter, fromBlock: qty(a), toBlock: qty(z) }]));
      if (!body.error) {
        out.push(...(body.result as LogJson[]));
        break;
      }
      if (attempt === 3) return { refused: `${body.error.message ?? "error"}${body.error.code === undefined ? "" : ` (code ${body.error.code})`} for #${fmt(a)} to #${fmt(z)}` };
      await sleep(3_000);
    }
  }
  return out;
}

async function connectV3(url: string): Promise<Chain> {
  try {
    return new Chain(await RpcClient.connect(url));
  } catch (error) {
    throw new Unreachable(`the V3 node ${new URL(url).host} is unreachable (${errorText(error)})`);
  }
}

/** No answer from the node (a timeout, a closed connection), as opposed to an error it returned. */
const noAnswer = (error: unknown) => error instanceof RpcError && error.code === undefined;

/** A lock of the vault: the record's, or the vault's Locked log. */
interface LockFacts {
  nonce: bigint;
  recipient: Uint8Array;
  amountNative: bigint;
  dstChainId: bigint;
  dstMinter: Uint8Array;
  commitment: Uint8Array;
  source: string;
  txHash?: Hex;
}

async function lockOf(vault: VaultDeployment, nonce: bigint, o: Common): Promise<LockFacts> {
  const recorded = vault.locks.find((l) => l.status === "locked" && l.vault === vault.address && l.vaultNonce === nonce.toString());
  if (recorded?.commitment) {
    return {
      nonce,
      recipient: hexToBytes(recorded.recipient),
      amountNative: BigInt(recorded.amountNative),
      dstChainId: BigInt(recorded.dstChainId),
      dstMinter: hexToBytes(recorded.dstMinter),
      commitment: hexToBytes(recorded.commitment),
      source: V3_RECORD,
      txHash: recorded.txHash,
    };
  }
  const evm = new EvmRpc(o.evm);
  let logs: LogJson[];
  try {
    logs = await evm.call<LogJson[]>("eth_getLogs", [{ address: vault.address, fromBlock: qty(vault.block), toBlock: "latest", topics: [LOCKED_TOPIC, bytesToHex(uintWord(nonce))] }]);
  } catch (error) {
    if (error instanceof RpcError) throw new Stop(`the EVM RPC's eth_getLogs: ${errorText(error)}`);
    throw error;
  }
  if (logs.length !== 1) throw new Stop(`${V3_RECORD} has no lock ${nonce}, and the vault's logs hold ${logs.length} Locked events for that nonce`);
  const e = decodeLocked(logs[0]);
  return {
    nonce,
    recipient: e.recipient,
    amountNative: e.amountNative,
    dstChainId: e.dstChainId,
    dstMinter: e.dstMinter,
    commitment: e.commitment,
    source: "the vault's Locked log",
    ...(logs[0].transactionHash ? { txHash: logs[0].transactionHash.toLowerCase() as Hex } : {}),
  };
}

/** The lock must be one this tool can mint: for Sepolia, through the minter at CREATE(deployer, 31), with a commitment that is its own. */
function checkLock(lock: LockFacts, vault: VaultDeployment, deployment: SepoliaDeployment): void {
  const minter = createAddress(hexToBytes(deployment.deployer), BigInt(MINTER_NONCE));
  if (lock.dstChainId !== SEPOLIA_CHAIN_ID) throw new Stop(`lock ${lock.nonce} is for chain ${lock.dstChainId}, not Sepolia (${SEPOLIA_CHAIN_ID})`);
  if (!equalBytes(lock.dstMinter, minter)) {
    throw new Stop(`lock ${lock.nonce} names the minter ${checksumAddress(lock.dstMinter)}, not ${checksumAddress(minter)} (CREATE(${deployment.deployerName}, ${MINTER_NONCE})): no minter this tool deploys can mint it`);
  }
  const expected = lockCommitment({ v3ChainId: V3.chainId, vault: hexToBytes(vault.address), dstChainId: lock.dstChainId, dstMinter: lock.dstMinter, recipient: lock.recipient, amountNative: lock.amountNative, nonce: lock.nonce });
  if (!equalBytes(expected, lock.commitment)) throw new Stop(`the fields of lock ${lock.nonce} give commitment ${bytesToHex(expected)}, ${lock.source} says ${bytesToHex(lock.commitment)}`);
  if (lock.amountNative === 0n || lock.recipient.every((b) => b === 0)) throw new Stop(`lock ${lock.nonce} has a zero amount or recipient, which the minter refuses`);
}

/** Reads the bundle of lock `nonce` at the latest finalized head, every proof walked here, and returns it; nothing is written. automint.ts uses it too. */
export async function captureBundle(o: Common, nonce: bigint): Promise<MintBundleFixture> {
  const deployment = readSepolia();
  const vault = readV3();
  const tool = toolInfo();
  const lock = await lockOf(vault, nonce, o);
  checkLock(lock, vault, deployment);
  log(`Lock ${nonce} (${lock.source}): ${formatTpot(lock.amountNative)} for ${checksumAddress(lock.recipient)} on chain ${lock.dstChainId}, minter ${checksumAddress(lock.dstMinter)}`);
  log(`Connecting to ${new URL(o.rpc).host}`);
  const chain = await connectV3(o.rpc);
  try {
    const chainName = await chain.rpc.request<string>("system_chain");
    const nodeVersion = await chain.rpc.request<string>("system_version");
    const genesis = (await chain.rpc.request<Hex>("chain_getBlockHash", [0])).toLowerCase();
    if (genesis !== V3.genesis) throw new Stop(`the node serves genesis ${genesis}, not ${V3.title}`);
    log(`  ${chainName}, genesis ${shortHex(genesis)}, node ${nodeVersion}`);

    // (1) B: the latest finalized block with a finality proof of its own. Every read is at B.
    const capturedAt = new Date().toISOString();
    const finalized = await chain.header(await chain.rpc.request<Hex>("chain_getFinalizedHead"));
    const proof = await finalityProof(chain, finalized.number);
    const j = decodeJustification(proof.justification);
    if (!equalBytes(proof.block, j.targetHash)) throw new Stop("the finality proof is not for the block its justification targets");
    if (j.votesAncestries.length > 0) throw new Stop("the finality proof's justification carries votes_ancestries, which the client does not decode; run again");
    const hash = bytesToHex(j.targetHash);
    const header = await chain.header(hash);
    if (header.number !== j.targetNumber) throw new Stop(`the justification targets #${j.targetNumber}, the header is #${header.number}`);
    const B: BlockRef = { number: header.number, hash };
    const change = grandpaLogs(header).find((l) => l.log.kind === "ScheduledChange" || l.log.kind === "ForcedChange");
    if (change) throw new Stop(`#${fmt(B.number)} carries a ${change.log.kind}: a bundle is taken at a block that changes no set; run again in a few seconds`);
    const parentHash = bytesToHex(header.parentHash);
    const parent = await chain.header(parentHash);
    // B's parent is the checkpoint a fresh light client starts from (plan --sandbox), and the set
    // that signs B is read there: a parent that changes the set is refused as B would be.
    const parentChange = grandpaLogs(parent).find((l) => l.log.kind === "ScheduledChange" || l.log.kind === "ForcedChange");
    if (parentChange) throw new Stop(`#${fmt(parent.number)}, the parent of #${fmt(B.number)}, carries a ${parentChange.log.kind}: a bundle is taken at a block whose parent changes no set either; run again in a few seconds`);
    const runtime = await chain.runtime(B.hash);
    const trieVersion: 0 | 1 = runtime.stateVersion === 1 ? 1 : 0;
    log(`(1) block #${fmt(B.number)} ${B.hash}: ${runtime.specName} ${runtime.specVersion}, trie V${trieVersion}, header ${header.encoded.length} B, finality proof ${fmt(proof.scale.length)} B`);

    // (2) The set that signs B: the set in force at its parent, which B's own state holds too (B
    // changes no set): Grandpa.CurrentSetId and GrandpaApi_grandpa_authorities at B must be the
    // same. The hint counts exactly the threshold, each signature by the client's check.
    const signing = await authoritySet(chain, { number: parent.number, hash: parentHash });
    const atB = await authoritySet(chain, B);
    if (atB.setId !== signing.setId || atB.keys.length !== signing.keys.length || atB.keys.some((k, i) => !equalBytes(k, signing.keys[i]))) {
      throw new Stop(`the set at #${fmt(B.number)} (set ${atB.setId}, ${atB.keys.length} keys) is not the one at its parent (set ${signing.setId}, ${signing.keys.length} keys)`);
    }
    const hint = signersHint(j, signing.keys, signing.setId);
    if (!hint.result.ok) throw new Stop(`the justification of #${fmt(B.number)} has precommits the client would not count: ${hint.result.problems.join("; ")}`);
    log(
      `(2) set ${signing.setId}, ${signing.keys.length} keys, threshold ${threshold(signing.keys.length)}: round ${j.round}, ${j.precommits.length} precommits, ` +
        `all ${hint.result.valid} valid with the client's check; hint ${bytesToHex(hint.hint)}`,
    );

    // (3) Revive.AccountInfoOf(vault): a contract whose code hash is the recorded one; its trie id.
    const vaultAddress = hexToBytes(vault.address);
    const accountKey = reviveAccountInfoKey(vaultAddress);
    const account = await chain.provenRead(header.stateRoot, accountKey, B.hash, "Revive.AccountInfoOf(vault)");
    if (!account) throw new Stop(`Revive.AccountInfoOf(${vault.address}) is empty at #${fmt(B.number)} (the proof shows the key absent): no contract there`);
    const info = decodeReviveAccountInfo(account.value);
    if (info.kind !== "Contract") throw new Stop(`${vault.address} is an externally owned account on V3, not a contract`);
    const contract = info.contract;
    if (account.value.length !== 130 || contract.trieId.length !== 32) {
      throw new Stop(`the AccountInfoOf entry is ${account.value.length} B with a ${contract.trieId.length}-byte trie id; the minter takes 130 B with a 32-byte trie id`);
    }
    const codeHash = bytesToHex(contract.codeHash);
    if (codeHash !== vault.codeHash) throw new Stop(`the vault's code hash on V3 is ${codeHash}, ${V3_RECORD} records ${vault.codeHash}`);
    log(`(3) Revive.AccountInfoOf: trie id ${bytesToHex(contract.trieId)}, code hash ${shortHex(codeHash)} (the record's); proof ${account.nodes.length} items${account.hashedValues ? ", value behind its hash" : ""}`);

    // (4) The root of the vault's child trie, in the main trie.
    const rootKey = childRootKey(contract.trieId);
    const root = await chain.provenRead(header.stateRoot, rootKey, B.hash, "child-root");
    if (!root) throw new Stop(`no child root at ":child_storage:default:" ++ trie id ${bytesToHex(contract.trieId)}`);
    if (root.value.length !== 32 || root.value.every((b) => b === 0)) throw new Stop(`the child root is not 32 non-zero bytes: ${bytesToHex(root.value)}`);
    log(`(4) child root ${bytesToHex(root.value)}; proof ${root.nodes.length} items`);

    // (5) commitments[nonce] in the child trie, under blake2_256 of its slot index.
    const index = commitmentSlot(nonce);
    const slotKey = reviveSlotKey(index);
    const served = await chain.childReadProof(rootKey, slotKey, B.hash);
    const direct = await chain.childStorage(rootKey, slotKey, B.hash);
    const { nodes: childNodes, mainTrieItems } = childItems(served, root.nodes);
    const slotRead = readProof(root.value, childNodes, slotKey);
    if (!slotRead.value) throw new Stop(`the child proof shows commitments[${nonce}] absent at #${fmt(B.number)}: the vault has no lock ${nonce}`);
    if (slotRead.itemsUsed !== childNodes.length) throw new Stop(`the child proof has ${childNodes.length - slotRead.itemsUsed} items the walk does not need`);
    if (direct !== undefined && (!direct || !equalBytes(direct, slotRead.value))) throw new Stop("the child proof does not lead to the value from childstate_getStorage");
    if (!equalBytes(slotRead.value, lock.commitment)) throw new Stop(`commitments[${nonce}] holds ${bytesToHex(slotRead.value)}, the lock's commitment is ${bytesToHex(lock.commitment)}`);
    log(`(5) commitments[${nonce}] at blake2_256(${shortHex(index)}): ${bytesToHex(slotRead.value)}, the lock's commitment; ${childNodes.length} child-trie items`);

    return {
      provenance: { chain: chainName, rpc: o.rpc, genesisHash: genesis as Hex, runtime, block: B, setId: toSafeNumber(signing.setId, "set id"), capturedAt, tool },
      kind: "mint-bundle",
      about:
        "Everything BridgeMinter.importAndMint needs for one lock of PortaldotVault, read at one finalized block B: B's header with grandpa_proveFinality(B) " +
        "and the set that signs it (read at B's parent), the signers hint the light client takes, B's parent header (the checkpoint a fresh client imports B from), " +
        "and, under B's state_root, the proofs of Revive.AccountInfoOf(vault) (its trie id and code hash), of the vault's child-trie root, and of commitments[nonce] " +
        "in the child trie, whose value is the lock's commitment.",
      source: { method: "grandpa_proveFinality", params: [proof.requested], lock: lock.source },
      node: { version: nodeVersion },
      header: headerJson(header, j.targetHash),
      justification: justificationJson(j, proof.justification, signing.keys.map((id) => ({ id, weight: 1n }))),
      signingSet: signing.json,
      finalityProof: { block: bytesToHex(proof.block), justificationBytes: proof.justification.length, unknownHeaders: 0, bytes: proof.scale.length, scale: bytesToHex(proof.scale) },
      signers: { hint: bytesToHex(hint.hint), count: hint.counted.length, threshold: hint.result.required },
      parentHeader: headerJson(parent, header.parentHash),
      trieVersion,
      vault: { address: vault.address, chainId: Number(V3.chainId), codeHash: codeHash as Hex, trieId: bytesToHex(contract.trieId) },
      lock: {
        nonce: toSafeNumber(nonce, "nonce"),
        recipient: bytesToHex(lock.recipient),
        amountNative: lock.amountNative.toString(),
        dstChainId: lock.dstChainId.toString(),
        dstMinter: bytesToHex(lock.dstMinter),
        commitment: bytesToHex(lock.commitment),
        source: lock.source,
        ...(lock.txHash ? { txHash: lock.txHash } : {}),
      },
      account: {
        key: { pallet: "Revive", item: "AccountInfoOf", hasher: "Identity", bytes: accountKey.length, hex: bytesToHex(accountKey) },
        value: {
          bytes: account.value.length,
          scale: bytesToHex(account.value),
          decoded: {
            kind: info.kind,
            trieId: bytesToHex(contract.trieId),
            codeHash,
            storageBytes: contract.storageBytes,
            storageItems: contract.storageItems,
            storageByteDeposit: contract.storageByteDeposit.toString(),
            storageItemDeposit: contract.storageItemDeposit.toString(),
            storageBaseDeposit: contract.storageBaseDeposit.toString(),
            immutableDataLen: contract.immutableDataLen,
            dust: info.dust,
          },
        },
        proof: proofJson("state_getReadProof", account.nodes),
      },
      childRoot: {
        key: { prefix: new TextDecoder().decode(CHILD_STORAGE_DEFAULT_PREFIX), bytes: rootKey.length, hex: bytesToHex(rootKey) },
        root: bytesToHex(root.value),
        proof: proofJson("state_getReadProof", root.nodes),
      },
      slot: {
        index: bytesToHex(index),
        key: { hasher: "Blake2_256", hex: bytesToHex(slotKey) },
        value: { bytes: slotRead.value.length, hex: bytesToHex(slotRead.value) },
        proof: { ...proofJson("state_getChildReadProof", childNodes), served: { count: served.length, bytes: served.reduce((n, item) => n + item.length, 0), mainTrieItems } },
      },
      notes: [
        `The signing set is Grandpa.CurrentSetId and GrandpaApi_grandpa_authorities at #${fmt(parent.number)}, B's parent; both hold the same set at B, as B changes none.`,
        `The signers hint names ${hint.counted.map((p) => `precommit ${p.index} (key ${p.authorityIndex})`).join(" and ")}, each signature checked with the light client's own check (grandpa.ts clientVerifies).`,
        `${direct === undefined ? "The node does not expose childstate_getStorage: the slot's value comes from the child proof alone." : "childstate_getStorage returns the same word as the child proof."} ` +
          `state_getChildReadProof served ${served.length} items: the ${mainTrieItems} main-trie items of childRoot.proof and the ${childNodes.length} child-trie items in slot.proof.`,
        `The lock is ${lock.source === V3_RECORD ? `the one ${V3_RECORD} records` : "the vault's Locked log for this nonce"}; the slot holds the commitment recomputed from its fields.`,
        "A light client at the signing set whose latest header is below B imports B with this finality proof (B's parent is such a checkpoint); one that holds B already verifies it again and writes nothing.",
      ],
    };
  } catch (error) {
    if (noAnswer(error)) throw new Unreachable(`the V3 node is unreachable (${errorText(error)})`);
    throw error;
  } finally {
    await chain.rpc.close();
  }
}

/** Prints the offline checks of a bundle as check lines; false when one fails. */
function verifyBundle(b: MintBundleFixture, title: string): boolean {
  log(`\n${title}:`);
  const lines = checkBundle(b);
  for (const [ok, what] of lines) check(ok, `     ${what}`);
  return lines.every(([ok]) => ok);
}

function readBundle(file: string): MintBundleFixture {
  if (!existsSync(file)) throw new Stop(`no bundle file at ${file}`);
  let b: MintBundleFixture;
  try {
    b = readJson<MintBundleFixture>(file);
  } catch (error) {
    throw new Stop(`${file}: ${errorText(error)}`);
  }
  if (b?.kind !== "mint-bundle") throw new Stop(`${file} is a ${String(b?.kind)} fixture, not a mint bundle`);
  return b;
}

const bundleTitle = (b: MintBundleFixture) => `#${fmt(b.header.number)} ${shortHex(b.header.hash)}, set ${b.provenance.setId}, lock ${b.lock.nonce}`;

async function bundle(o: BundleOptions): Promise<number> {
  if (o.checkFile !== undefined) {
    const b = readBundle(o.checkFile);
    const ok = verifyBundle(b, `${o.checkFile}: ${bundleTitle(b)}`);
    log(ok ? "\nThe bundle checks out." : "\nThe bundle does not check out.");
    return ok ? OK : FAILED;
  }
  const file = join(o.out, BUNDLE_FILE);
  // A bundle a mint was sent with stays as it was: the record names its file.
  const existing = () => {
    if (existsSync(file) && !o.force) throw new Stop(`${repoPath(file)} is there already: bundle does not write over it without --force (a sent mint's record can name it); --out <dir> writes elsewhere`);
  };
  existing();
  log(`${new Date().toISOString()}: capturing the mint bundle of lock ${o.nonce} on ${V3.title}`);
  const b = await captureBundle(o, o.nonce!);
  if (!verifyBundle(b, "Offline checks before writing")) {
    log("\nThe bundle does not check out: nothing is written.");
    return FAILED;
  }
  existing();
  const named = readBridge()?.steps.filter((s) => s.bundle?.file === repoPath(file)) ?? [];
  if (named.length > 0) log(`     note: ${BRIDGE_RECORD} names ${repoPath(file)} for ${named.map((s) => s.name).join(", ")}; --force writes over it`);
  mkdirSync(o.out, { recursive: true });
  const bytes = writeJson(file, b);
  log(`\nWrote ${file} (${fmt(bytes)} B): ${bundleTitle(b)}`);
  for (const n of b.notes) log(`  note: ${n}`);
  return OK;
}

/** The bundle a plan or a mint works on: the file, or a fresh capture that is not written. */
async function bundleFor(o: PlanOptions): Promise<{ bundle: MintBundleFixture; file: string | null }> {
  if (o.bundleFile !== undefined) {
    const b = readBundle(o.bundleFile);
    if (!verifyBundle(b, `Bundle ${repoPath(o.bundleFile)}: ${bundleTitle(b)}`)) throw new Stop("the bundle does not check out");
    return { bundle: b, file: o.bundleFile };
  }
  const b = await captureBundle(o, o.nonce!);
  if (!verifyBundle(b, "Offline checks of the captured bundle (not written)")) throw new Stop("the bundle does not check out");
  return { bundle: b, file: null };
}

/** The lock of a bundle, as checkLock takes it. */
const lockOfBundle = (b: MintBundleFixture): LockFacts => ({
  nonce: BigInt(b.lock.nonce),
  recipient: hexToBytes(b.lock.recipient),
  amountNative: BigInt(b.lock.amountNative),
  dstChainId: BigInt(b.lock.dstChainId),
  dstMinter: hexToBytes(b.lock.dstMinter),
  commitment: hexToBytes(b.lock.commitment),
  source: `the bundle, from ${b.lock.source}`,
});

// ---------------------------------------------------------------------------------------
// Sepolia: the light client, the minter and the token

const view = async (to: Hex, data: Uint8Array, block: string) => hexToBytes(await rpc<Hex>("eth_call", [{ to, data: bytesToHex(data) }, block]));
const codeAt = async (address: Hex, block: string) => hexToBytes(await sepolia("code", () => rpc<Hex>("eth_getCode", [address, block])));

interface ClientState {
  genesis: Hex;
  setId: bigint;
  latestHash: Hex;
  latestNumber: number;
  halted: boolean;
  paused: boolean;
}

async function readClient(client: Hex, block: string): Promise<ClientState> {
  const get = (signature: string, ...words: Uint8Array[]) => sepolia("client state", () => view(client, callData(signature, ...words), block));
  const latest = await get(CLIENT.latestFinalized);
  return {
    genesis: bytesToHex(wordAt(await get(CLIENT.genesisHash), 0)),
    setId: uintAt(await get(CLIENT.currentSetId), 0),
    latestHash: bytesToHex(wordAt(latest, 0)),
    latestNumber: Number(uintAt(latest, 1)),
    halted: uintAt(await get(CLIENT.halted), 0) !== 0n,
    paused: uintAt(await get(CLIENT.paused), 0) !== 0n,
  };
}

/** The minter at CREATE(deployer, 31) and the token at CREATE(deployer, 32), as they are on chain. */
interface BridgeState {
  minter: Hex;
  token: Hex;
  minterDeployed: boolean;
  tokenDeployed: boolean;
  /** The minter's immutables and state, when it is deployed. */
  lightClient?: Hex;
  vault?: Hex;
  vaultChainId?: bigint;
  vaultCodeHash?: Hex;
  tokenOf?: Hex;
  bound: boolean;
  trieId: Hex;
  burnCount: bigint;
  /** The token's minter and supply, when it is deployed. */
  tokenMinter?: Hex;
  decimals?: number;
  totalSupply: bigint;
}

async function readBridgeState(deployer: Hex, block: string): Promise<BridgeState> {
  const minter = bytesToHex(createAddress(hexToBytes(deployer), BigInt(MINTER_NONCE)));
  const token = bytesToHex(createAddress(hexToBytes(deployer), BigInt(TOKEN_NONCE)));
  const state: BridgeState = {
    minter,
    token,
    minterDeployed: (await codeAt(minter, block)).length > 0,
    tokenDeployed: (await codeAt(token, block)).length > 0,
    bound: false,
    trieId: bytesToHex(new Uint8Array(32)),
    burnCount: 0n,
    totalSupply: 0n,
  };
  if (state.minterDeployed) {
    const get = (signature: string, ...words: Uint8Array[]) => sepolia("minter state", () => view(minter, callData(signature, ...words), block));
    state.lightClient = bytesToHex(addressAt(await get(MINTER.lightClient), 0, "lightClient()"));
    state.vault = bytesToHex(addressAt(await get(MINTER.vault), 0, "vault()"));
    state.vaultChainId = uintAt(await get(MINTER.vaultChainId), 0);
    state.vaultCodeHash = bytesToHex(wordAt(await get(MINTER.vaultCodeHash), 0));
    state.tokenOf = bytesToHex(addressAt(await get(MINTER.token), 0, "token()"));
    state.bound = uintAt(await get(MINTER.bound), 0) !== 0n;
    state.trieId = bytesToHex(wordAt(await get(MINTER.vaultTrieId), 0));
    state.burnCount = uintAt(await get(MINTER.burnCount), 0);
  }
  if (state.tokenDeployed) {
    const get = (signature: string) => sepolia("token state", () => view(token, callData(signature), block));
    state.tokenMinter = bytesToHex(addressAt(await get(TOKEN.minter), 0, "minter()"));
    state.decimals = Number(uintAt(await get(TOKEN.decimals), 0));
    state.totalSupply = uintAt(await get(TOKEN.totalSupply), 0);
  }
  return state;
}

/** Refuses a minter or token on chain that is not the pair this tool deploys: bound to the recorded light client and vault, and to each other. */
function checkBridge(b: BridgeState, deployment: SepoliaDeployment, vault: VaultDeployment): void {
  if (b.minterDeployed) {
    const same =
      b.lightClient === deployment.client && b.vault === vault.address && b.vaultChainId === V3.chainId && b.vaultCodeHash === vault.codeHash && b.tokenOf === b.token;
    if (!check(same, `BridgeMinter ${checksumAddress(hexToBytes(b.minter))} takes ${CLIENT_NAME}, the recorded vault, chain ${V3.chainId} and its code hash, and the token at CREATE(deployer, ${TOKEN_NONCE})`)) {
      throw new Stop("the minter on chain is not the one this tool deploys");
    }
  }
  if (b.tokenDeployed && !check(b.tokenMinter === b.minter && b.decimals === 14, `WrappedTPOT ${checksumAddress(hexToBytes(b.token))} has 14 decimals and the minter as its minter`)) {
    throw new Stop("the token on chain is not the one this tool deploys");
  }
}

// ---------------------------------------------------------------------------------------
// The plan

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

/** What a call left: its status and logs (a simulated call, or a receipt). */
interface Outcome {
  status: string;
  logs?: Log[];
}

/** A call made after a step, by the probe's sender: a view, or a call that has to revert (with its own gas limit). */
interface Read {
  to: Hex;
  data: Uint8Array;
  gas?: number;
}

/** What a read returned, or its revert data; the gas is known in a simulation only (0 otherwise). */
interface ReadResult {
  ok: boolean;
  data: Uint8Array;
  gas: number;
}

const readGas = (x: Read) => x.gas ?? VIEW_GAS;

interface Step {
  index: number;
  nonce: number;
  /** The sender, lower case. */
  from: Hex;
  kind: "deploy" | "call";
  name: string;
  label: string;
  data: Hex;
  to?: Hex;
  /** A deployment: its CREATE address, its artifact, its constructor arguments and the words its immutables must hold. */
  address?: Hex;
  artifact?: Artifact;
  constructorArgs?: Hex;
  immutables?: Uint8Array[];
  /** The slots its constructor writes, carried with its code to later simulated requests. */
  initialState?: Record<Hex, Hex>;
  /** Storage a later request needs: a contract and the slots this step writes there. */
  writes?: { address: Hex; slots: bigint[] };
  /** Calls made at the end of the request this step is in, and in the receipt's block once mined. */
  reads: Read[];
  /** The checks of its logs and of what the reads returned. */
  checks: (r: Outcome, views: ReadResult[]) => [boolean, string][];
  /** The command that sends it; the sandbox's own steps are never sent. */
  sentBy: "deploy" | "mint" | null;
  /** One of the demo's reverts: it passes only by reverting with exactly `revert`. */
  expect?: { kind: "tamper" | "replay"; tamper?: { part: Tamper; what: string }; revert: Uint8Array };
  /** It needs the state the step before it leaves, so it runs in the same simulated request. */
  after?: boolean;
  /** The gas limit it is measured with instead of the cap (a call that reverts after a few million gas). */
  measureLimit?: number;
}

interface Plan {
  steps: Step[];
  /** State overrides every simulated request starts from (the sandbox's). */
  overrides: Record<string, unknown>;
  /** The errors a revert can name: the known ones, and those the artifacts declare. */
  errors: Map<Hex, string>;
  minter: Hex;
  token: Hex;
  client: Hex;
}

/** What the plan is built on: the records, the chain state at one block, and the bundle. */
interface Setting {
  o: PlanOptions;
  deployment: SepoliaDeployment;
  vault: VaultDeployment;
  /** The bundle of the mint, absent for a deploy. */
  bundle: MintBundleFixture | null;
  bundleFile: string | null;
  bridge: BridgeState;
  client: ClientState;
  /** Whether the light client holds B already. */
  imported: boolean;
  deployerNonce: number;
  /** The sender of the mint, lower case, and its nonce. */
  sender: Hex;
  senderNonce: number;
  /** The token balance of the lock's recipient before the mint. */
  balanceBefore: bigint;
}

/** The deployer creates the minter at nonce 31 and the token at 32; nothing else puts them where lock 0 expects them. */
function requireDeployerNonce(s: Setting, n: { latest: number; pending: number }, nonce: number): void {
  if (n.latest === nonce && n.pending === nonce && s.deployerNonce === nonce) {
    check(true, `the deployer's next nonce is ${nonce}, mined and pending`);
    return;
  }
  const what = nonce === MINTER_NONCE ? `BridgeMinter has to be its nonce-${MINTER_NONCE} creation, ${checksumAddress(hexToBytes(s.bridge.minter))}, the minter lock 0 names` : `WrappedTPOT has to be its nonce-${TOKEN_NONCE} creation, ${checksumAddress(hexToBytes(s.bridge.token))}, the token the minter takes`;
  throw new Stop(
    `the deployer ${s.deployment.deployerName} is at nonce ${n.latest} (pending ${n.pending}), and ${what}` +
      (n.latest > nonce ? `: nonce ${nonce} is spent, so no transaction can put it there any more` : ": wait until the pending transaction is mined"),
  );
}

/**
 * Where the light client is against the bundle: importAndMint passes only with the client at B's
 * set and B above its latest header, or B imported already.
 */
function requireClientReady(s: Setting): void {
  const b = s.bundle!;
  const c = s.client;
  const relay =
    `run npm run relay -- --chain v3 first, then capture the bundle again (npm run mint -- bundle --nonce ${b.lock.nonce})` +
    (s.bridge.minterDeployed && s.bridge.tokenDeployed
      ? ""
      : `. Until both are deployed the relayer sends from a key other than the deployer, whose nonces ${MINTER_NONCE} and ${TOKEN_NONCE} create the minter and the token; npm run mint -- deploy dry-runs the creations alone`);
  // Anyone can import into the light client: a head any relayer imported moves it past a bundle's block.
  const recapture = `capture the bundle again (npm run mint -- bundle --nonce ${b.lock.nonce} --force); importing into ${CLIENT_NAME} is open to anyone, so any relayer's import moves it on`;
  if (c.genesis !== b.provenance.genesisHash) throw new Stop(`${CLIENT_NAME} follows genesis ${c.genesis}, the bundle is from ${b.provenance.genesisHash}`);
  if (c.halted || c.paused) throw new Stop(`${CLIENT_NAME} is ${c.halted ? "halted" : "paused"}: imports revert until its admin acts`);
  const want = BigInt(b.provenance.setId);
  if (c.setId < want) {
    throw new Stop(`${CLIENT_NAME} is at set ${c.setId} (latest #${fmt(c.latestNumber)}), and the bundle's block #${fmt(b.header.number)} is signed by set ${want}: the import cannot pass until the client follows V3 there: ${relay}`);
  }
  if (c.setId > want && !s.imported) {
    throw new Stop(`${CLIENT_NAME} is at set ${c.setId}, past the bundle's set ${want}, and does not hold #${fmt(b.header.number)}: ${recapture}`);
  }
  if (!s.imported && c.latestNumber >= b.header.number) {
    throw new Stop(`${CLIENT_NAME} is at #${fmt(c.latestNumber)}, at or past the bundle's block #${fmt(b.header.number)}, which it does not hold (the import would revert NotNewer): ${recapture}`);
  }
  check(
    true,
    s.imported
      ? `${CLIENT_NAME} holds #${fmt(b.header.number)} already: importAndMint verifies it again and writes no header`
      : `${CLIENT_NAME} is at set ${c.setId} with latest #${fmt(c.latestNumber)}, below the bundle's #${fmt(b.header.number)}: it can import it`,
  );
}

const addErrors = (errors: Map<Hex, string>, signatures: string[]) => {
  for (const s of signatures) errors.set(bytesToHex(keccak_256(new TextEncoder().encode(s)).slice(0, 4)), s);
};

/**
 * The steps of `s.o.command`: the creations still needed (the minter at nonce 31 and the token at
 * 32), then importAndMint (plan and mint). With --sandbox a fresh light client comes first, created
 * and initialized by the sandbox sender, and the minter takes it; the deployer's nonce is 31 and the
 * minter's and token's addresses are empty there, so the same addresses come out.
 */
function makePlan(s: Setting): Plan {
  const { o, deployment, bridge } = s;
  const deployer = deployment.deployer;
  const errors = errorMap(BRIDGE_ERRORS);
  const steps: Step[] = [];
  const overrides: Record<string, unknown> = {};
  let client = deployment.client;
  const add = (step: Omit<Step, "index">) => steps.push({ index: steps.length, ...step });
  const none = (): [boolean, string][] => [];

  if (o.sandbox) {
    const b = s.bundle!;
    const lc = artifactOf(o.artifacts, "GrandpaLightClient");
    addErrors(errors, lc.errors);
    client = bytesToHex(createAddress(hexToBytes(SANDBOX_SENDER), 0n));
    const genesis = hexToBytes(b.provenance.genesisHash);
    const setId = BigInt(b.signingSet.setId);
    const keys = b.signingSet.authorities.map((a) => hexToBytes(a.id));
    overrides[SANDBOX_SENDER] = { balance: qty(10n ** 18n), nonce: "0x0" };
    overrides[deployer] = { nonce: qty(MINTER_NONCE) };
    overrides[bridge.minter] = EMPTY_ACCOUNT;
    overrides[bridge.token] = EMPTY_ACCOUNT;
    add({
      nonce: 0,
      from: SANDBOX_SENDER,
      kind: "deploy",
      name: "sandbox GrandpaLightClient",
      label: `sandbox GrandpaLightClient from the Sepolia build, created by the sandbox sender ${shortHex(SANDBOX_SENDER)}`,
      data: bytesToHex(lc.initcode),
      address: client,
      artifact: lc,
      constructorArgs: "0x",
      immutables: [],
      // The constructor makes its sender the admin: slot 0 holds it (AuthoritySets.Store.admin).
      initialState: { [bytesToHex(uintWord(0n))]: bytesToHex(addressWord(hexToBytes(SANDBOX_SENDER))) },
      reads: [],
      checks: none,
      sentBy: null,
    });
    add({
      nonce: 1,
      from: SANDBOX_SENDER,
      kind: "call",
      name: "sandbox initialize",
      label: `sandbox initialize: set ${setId}, ${keys.length} keys, checkpoint #${fmt(b.parentHeader.number)} (B's parent)`,
      data: bytesToHex(initializeCalldata(genesis, setId, keys, hexToBytes(b.parentHeader.scale))),
      to: client,
      writes: { address: client, slots: initializeWrites(hexToBytes(b.parentHeader.hash), genesis, setId, keys) },
      reads: [],
      checks: none,
      sentBy: null,
    });
  }

  // The creations: both while the minter is not deployed, the token alone after it (never in the
  // sandbox, where both addresses are empty).
  let nonce = o.sandbox ? MINTER_NONCE : s.deployerNonce;
  const minterNeeded = o.sandbox || !bridge.minterDeployed;
  const tokenNeeded = o.sandbox || !bridge.tokenDeployed;
  if (minterNeeded || tokenNeeded) {
    const minter = artifactOf(o.artifacts, "BridgeMinter");
    const token = artifactOf(o.artifacts, "WrappedTPOT");
    addErrors(errors, [...minter.errors, ...token.errors]);
    if (minterNeeded) {
      const words = [addressWord(hexToBytes(client)), addressWord(hexToBytes(s.vault.address)), uintWord(V3.chainId), hexToBytes(s.vault.codeHash), addressWord(hexToBytes(bridge.token))];
      const args = minterConstructorArgs(hexToBytes(client), hexToBytes(s.vault.address), V3.chainId, hexToBytes(s.vault.codeHash), hexToBytes(bridge.token));
      add({
        nonce,
        from: deployer,
        kind: "deploy",
        name: "BridgeMinter",
        label:
          `BridgeMinter (${o.sandbox ? "taking the sandbox client" : `taking ${CLIENT_NAME}`}, vault ${shortHex(s.vault.address)}, chain ${V3.chainId}, ` +
          `code hash ${shortHex(s.vault.codeHash)}, token ${shortHex(bridge.token)})`,
        data: bytesToHex(new Uint8Array([...minter.initcode, ...args])),
        address: bridge.minter,
        artifact: minter,
        constructorArgs: bytesToHex(args),
        immutables: words,
        reads: [],
        checks: none,
        sentBy: "deploy",
      });
      nonce += 1;
    }
    const args = tokenConstructorArgs(hexToBytes(bridge.minter));
    add({
      nonce,
      from: deployer,
      kind: "deploy",
      name: "WrappedTPOT",
      label: `WrappedTPOT (minter ${shortHex(bridge.minter)})`,
      data: bytesToHex(new Uint8Array([...token.initcode, ...args])),
      address: bridge.token,
      artifact: token,
      constructorArgs: bytesToHex(args),
      immutables: [args],
      reads: [],
      checks: none,
      sentBy: "deploy",
    });
    nonce += 1;
  } else {
    for (const name of ["BridgeMinter", "WrappedTPOT"] as const) {
      // Once the contracts are deployed the build is not needed; the known errors still name a revert.
      if (existsSync(join(o.artifacts, `${name}.sol`, `${name}.json`))) addErrors(errors, artifactOf(o.artifacts, name).errors);
    }
  }

  if (s.bundle && o.command !== "deploy") {
    const b = s.bundle;
    const from = s.sender;
    const B = b.header.hash;
    const recipient = hexToBytes(b.lock.recipient);
    const amount = BigInt(b.lock.amountNative);
    const lockNonce = BigInt(b.lock.nonce);
    const binds = o.sandbox || !bridge.bound;
    // Held already (the relayer imported exactly B): verified again, nothing written, no event.
    const imported = !o.sandbox && s.imported;
    const balanceBefore = o.sandbox ? 0n : s.balanceBefore;
    const minter = bridge.minter;
    const token = bridge.token;
    // The sender's nonces from here on; the deployer's go on after its creations.
    let next = from === deployer ? nonce : s.senderNonce;
    const demo: (ExpectedRevert & { kind: "tamper" | "replay" }) | null = o.tamper
      ? { kind: "tamper", ...tamperedCall(b, o.tamper, hexToBytes(minter), SEPOLIA_CHAIN_ID) }
      : o.replay
        ? { kind: "replay", ...replayCall(b) }
        : null;
    const addMint = () =>
      add({
        nonce: next++,
        from,
        kind: "call",
        name: `importAndMint lock ${b.lock.nonce}`,
        label:
          `importAndMint: #${fmt(b.header.number)} ${shortHex(B)}, ${b.signers.count} of ${b.signingSet.count} signatures` +
          `${binds ? ", bindVault" : ""}, lock ${b.lock.nonce}: ${formatWtpot(amount)} to ${checksumAddress(recipient)}`,
        data: bytesToHex(bundleCalldata(b)),
        to: minter,
        reads: [
          { to: token, data: callData(TOKEN.balanceOf, addressWord(recipient)) },
          { to: token, data: callData(TOKEN.totalSupply) },
          { to: minter, data: callData(MINTER.used, uintWord(lockNonce)) },
          { to: minter, data: callData(MINTER.vaultTrieId) },
          { to: client, data: callData(CLIENT.latestFinalized) },
          // The same call again, from another sender: B is verified again (no NotNewer), then the
          // replay guard refuses the lock.
          { to: minter, data: bundleCalldata(b), gas: REPLAY_GAS },
        ],
        checks: (r, views) => {
          const out: [boolean, string][] = [];
          const headerLog = findLog(r.logs, client, HEADER_IMPORTED_TOPIC, B);
          if (imported) out.push([!headerLog, `#${fmt(b.header.number)} was imported before: verified again, no HeaderImported`]);
          else {
            let ok = false;
            if (headerLog) {
              const e = decodeHeaderImported(headerLog);
              ok = e.number === b.header.number && e.setId === BigInt(b.provenance.setId) && e.signatures === b.signers.count && bytesToHex(e.stateRoot) === b.header.stateRoot;
            }
            out.push([ok, `HeaderImported #${fmt(b.header.number)} under set ${b.provenance.setId}, ${b.signers.count} signatures, state root ${shortHex(b.header.stateRoot)}`]);
          }
          out.push([!findLog(r.logs, client, HALTED_TOPIC) && !findLog(r.logs, client, AUTHORITY_SET_CHANGED_TOPIC), "no set change, not halted"]);
          const boundLog = findLog(r.logs, minter, VAULT_BOUND_TOPIC);
          if (binds) {
            let ok = false;
            if (boundLog) {
              const e = decodeVaultBound(boundLog);
              ok = bytesToHex(e.vault) === b.vault.address && bytesToHex(e.trieId) === b.vault.trieId && bytesToHex(e.blockHash) === B;
            }
            out.push([ok, `VaultBound ${shortHex(b.vault.address)}, trie id ${shortHex(b.vault.trieId)}, at #${fmt(b.header.number)}`]);
          } else out.push([!boundLog, `the vault is bound already (trie id ${shortHex(bridge.trieId)}): no VaultBound`]);
          const mintedLog = findLog(r.logs, minter, MINTED_TOPIC, bytesToHex(uintWord(lockNonce)));
          let minted = false;
          if (mintedLog) {
            const e = decodeMinted(mintedLog);
            minted = equalBytes(e.recipient, recipient) && e.amount === amount && bytesToHex(e.blockHash) === B;
          }
          out.push([minted, `Minted lock ${b.lock.nonce}: ${formatWtpot(amount)} to ${checksumAddress(recipient)}, proven at #${fmt(b.header.number)}`]);
          const transferLog = findLog(r.logs, token, TRANSFER_TOPIC, bytesToHex(new Uint8Array(32)));
          let transferred = false;
          if (transferLog) {
            const e = decodeTransfer(transferLog);
            transferred = equalBytes(e.to, recipient) && e.value === amount;
          }
          out.push([transferred, `Transfer of ${formatWtpot(amount)} from the zero address to ${checksumAddress(recipient)}`]);
          if (views.length !== 6 || views.slice(0, 5).some((v) => !v.ok)) {
            out.push([false, "the views after the mint were not read"]);
            return out;
          }
          const [balance, supply, used, trieId, latest, replay] = views.map((v) => v.data);
          out.push([uintAt(balance, 0) === balanceBefore + amount, `the recipient's wtPOT balance after: ${formatWtpot(uintAt(balance, 0))} (before ${formatWtpot(balanceBefore)})`]);
          out.push([uintAt(supply, 0) >= amount, `wtPOT total supply after: ${formatWtpot(uintAt(supply, 0))}`]);
          out.push([uintAt(used, 0) === 1n, `used(${b.lock.nonce}) is true`]);
          out.push([bytesToHex(wordAt(trieId, 0)) === b.vault.trieId, `vaultTrieId is the vault's, ${shortHex(b.vault.trieId)}`]);
          out.push([true, `the client's latest header after: #${fmt(Number(uintAt(latest, 1)))} ${shortHex(bytesToHex(wordAt(latest, 0)))}`]);
          const expected = `NonceAlreadyUsed(${lockNonce})`;
          const name = views[5].ok ? null : revertName(replay, errors);
          const detail = name === expected ? (views[5].gas ? ` (${fmt(views[5].gas)} gas)` : "") : `: ${views[5].ok ? "it passes" : `it reverts with ${name ?? shortHex(replay)}`}`;
          out.push([name === expected, `the same importAndMint again, from another sender: B verified again, then ${expected}${detail}`]);
          return out;
        },
        sentBy: "mint",
      });
    // One of the demo's reverts, from the mint's sender: it passes only by reverting with exactly
    // the error that names what was changed.
    const addDemo = (d: ExpectedRevert & { kind: "tamper" | "replay" }, when: string, after: boolean) =>
      add({
        nonce: next++,
        from,
        kind: "call",
        name: d.kind === "tamper" ? `tampered importAndMint lock ${b.lock.nonce} (${o.tamper})` : `replayed importAndMint lock ${b.lock.nonce}`,
        label: `${d.kind === "tamper" ? `tampered importAndMint, ${d.what}` : `importAndMint of lock ${b.lock.nonce} again (replay)`}${when}`,
        data: bytesToHex(d.data),
        to: minter,
        reads: [],
        checks: none,
        sentBy: o.sandbox ? null : "mint",
        expect: { kind: d.kind, ...(d.kind === "tamper" ? { tamper: { part: o.tamper!, what: d.what } } : {}), revert: d.revert },
        after,
        measureLimit: REPLAY_GAS,
      });
    // On chain the demo's transaction goes alone, before the mint or after it. The sandbox runs the
    // whole path: a tamper before the mint and again after it, the replay after it.
    if (demo && !o.sandbox) addDemo(demo, "", false);
    else {
      if (demo?.kind === "tamper") addDemo(demo, ", before the mint", false);
      addMint();
      if (demo) addDemo(demo, ", after the mint", true);
    }
  }
  return { steps, overrides, errors, minter: bridge.minter, token: bridge.token, client };
}

// ---------------------------------------------------------------------------------------
// Dry run

interface Simulated {
  results: Map<number, SimCall>;
  views: Map<number, ReadResult[]>;
  /** EXTCODEHASH at each deployment's address after its request, as the probe read it. */
  codeHashThere: Map<number, Hex>;
  requests: Step[][];
  /** Each sender's balance after its last request. */
  balances: Map<Hex, bigint>;
  baseFee: bigint;
  /** The most gas one request needed: what it used before each call, plus that call's limit. */
  peak: number;
}

const isHexData = (s: unknown): s is Hex => typeof s === "string" && /^0x([0-9a-fA-F]{2})*$/.test(s);

/** What a simulated read returned: its data, or its revert data. */
function readResult(c: SimCall): ReadResult {
  const ok = c.status === "0x1";
  const data = ok ? c.returnData : (c.error?.data ?? c.returnData);
  return { ok, data: isHexData(data) ? hexToBytes(data) : new Uint8Array(0), gas: gasOf(c) };
}

/**
 * Consecutive steps per request, while their limits and the reads and storage read-back at the end
 * fit in REQUEST_GAS (as relay.ts packs them); a step that needs the state of the one before it
 * stays in its request.
 */
function requestsOf(steps: Step[], limitOf: (s: Step) => number, boundOf: (s: Step) => number): Step[][] {
  const out: Step[][] = [];
  let used = 0;
  for (const s of steps) {
    const last = out.at(-1);
    const all = last ? [...last, s] : [s];
    const reads = all.reduce((n, x) => n + x.reads.reduce((g, r) => g + readGas(r), 0), 0);
    const slots = all.reduce((n, x) => n + (x.writes?.slots.length ?? 0), 0);
    const end = PROBE_GAS + reads + (slots ? dumpGas(slots) : 0);
    if (last && (s.after || used + limitOf(s) + end <= REQUEST_GAS)) {
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
 * Runs `plan.steps` on the node, each with gas limit `limitOf(step)`, on top of `block`. The first
 * request runs on the chain's own state (with the plan's overrides); a later one carries, as state
 * overrides, the code of the contracts created before (with their constructors' slots), the slots
 * an earlier step wrote (read back by the dumper in a later simulated block, where that contract's
 * code is replaced by it), and each sender's nonce and remaining balance as the probe read it: no
 * balance is added. Stops after a request in which a step failed.
 */
async function simulate(plan: Plan, limitOf: (s: Step) => number, boundOf: (s: Step) => number, block: string, fees: Fees): Promise<Simulated> {
  const sim: Simulated = { results: new Map(), views: new Map(), codeHashThere: new Map(), requests: requestsOf(plan.steps, limitOf, boundOf), balances: new Map(), baseFee: 0n, peak: 0 };
  const carried = new Map<Hex, { code?: Hex; state: Record<Hex, Hex> }>();
  const senderState = new Map<Hex, { nonce: string; balance: string }>();
  const fee = { maxFeePerGas: qty(fees.maxFee), maxPriorityFeePerGas: qty(fees.tip) };
  for (const [r, request] of sim.requests.entries()) {
    const senders = [...new Set(request.map((s) => s.from))];
    const deployed = request.filter((s) => s.kind === "deploy");
    const probed = [...senders, ...deployed.map((s) => s.address!)];
    const reads = request.flatMap((s) => s.reads);
    const calls = [
      ...request.map((s) => ({ from: s.from, nonce: qty(s.nonce), gas: qty(limitOf(s)), ...fee, ...(s.to ? { to: s.to } : {}), data: s.data })),
      { from: PROBE_SENDER, to: PROBE, gas: qty(PROBE_GAS), ...fee, data: bytesToHex(new Uint8Array(probed.flatMap((a) => [...uintWord(BigInt(a))]))) },
      ...reads.map((x) => ({ from: PROBE_SENDER, to: x.to, gas: qty(readGas(x)), ...fee, data: bytesToHex(x.data) })),
    ];
    const stateOverrides: Record<string, unknown> = { ...plan.overrides, [PROBE]: { code: PROBE_CODE }, [PROBE_SENDER]: { balance: qty(10n ** 18n) } };
    for (const [address, c] of carried) stateOverrides[address] = c.code ? { code: c.code, nonce: "0x1", state: c.state } : { stateDiff: c.state };
    for (const [address, st] of senderState) stateOverrides[address] = { ...((stateOverrides[address] as object | undefined) ?? {}), ...st };
    const blockStateCalls: unknown[] = [{ stateOverrides, calls }];
    const later = r < sim.requests.length - 1;
    const dumps = new Map<Hex, bigint[]>();
    for (const s of request) if (s.writes) dumps.set(s.writes.address, [...new Set([...(dumps.get(s.writes.address) ?? []), ...s.writes.slots])]);
    if (later) {
      for (const [address, slots] of dumps) {
        const dump = { from: PROBE_SENDER, to: address, gas: qty(dumpGas(slots.length)), ...fee, data: bytesToHex(new Uint8Array(slots.flatMap((x) => [...uintWord(x)]))) };
        blockStateCalls.push({ stateOverrides: { [address]: { code: DUMPER_CODE } }, calls: [dump] });
      }
    }
    const blocks = await rpc<SimBlock[]>("eth_simulateV1", [{ blockStateCalls, validation: true }, block]).catch((error: unknown) => {
      if (error instanceof DryRunViolation) throw error;
      if (offline(error)) throw new Unreachable(`Sepolia RPC unreachable (eth_simulateV1: ${errorText(error)})`);
      throw new Error(`request [${request.map((s) => s.index).join(",")}]: ${errorText(error)}`);
    });

    const done = blocks.flatMap((b) => b.calls);
    const limits = [...request.map(limitOf), PROBE_GAS, ...reads.map(readGas), ...(later ? [...dumps.values()].map((slots) => dumpGas(slots.length)) : [])];
    let used = 0;
    done.forEach((c, i) => {
      sim.peak = Math.max(sim.peak, used + (limits[i] ?? 0));
      used += gasOf(c);
    });
    request.forEach((s, i) => sim.results.set(s.index, blocks[0].calls[i]));
    const probe = blocks[0].calls[request.length];
    if (probe.status !== "0x1") throw new Error(`the probe call failed: ${probe.error?.message}`);
    const words = hexToBytes(probe.returnData);
    probed.forEach((address, i) => {
      const codeHash = bytesToHex(wordAt(words, 2 * i));
      const balance = uintAt(words, 2 * i + 1);
      if (i < senders.length) {
        sim.balances.set(address, balance);
        const last = Math.max(...request.filter((s) => s.from === address).map((s) => s.nonce));
        senderState.set(address, { nonce: qty(last + 1), balance: qty(balance) });
      } else sim.codeHashThere.set(deployed[i - senders.length].index, codeHash);
    });
    sim.baseFee = BigInt(blocks[0].baseFeePerGas);
    let offset = request.length + 1;
    for (const s of request) {
      sim.views.set(s.index, blocks[0].calls.slice(offset, offset + s.reads.length).map(readResult));
      offset += s.reads.length;
    }
    // A demo step reverts by design: judge checks its revert.
    if (request.some((s) => !s.expect && sim.results.get(s.index)!.status !== "0x1")) break;

    for (const s of deployed) carried.set(s.address!, { code: sim.results.get(s.index)!.returnData as Hex, state: { ...(s.initialState ?? {}) } });
    if (later) {
      [...dumps].forEach(([address, slots], k) => {
        const d = blocks[1 + k].calls[0];
        if (d.status !== "0x1") throw new Error(`reading ${address}'s storage back failed: ${d.error?.message}`);
        const values = hexToBytes(d.returnData);
        const entry = carried.get(address) ?? { state: {} };
        slots.forEach((slot, i) => (entry.state[bytesToHex(uintWord(slot))] = bytesToHex(wordAt(values, i))));
        carried.set(address, entry);
      });
    }
  }
  return sim;
}

/** Why a call failed, with the error named when it is one of the known ones. */
function revertText(r: { error?: { message?: string; data?: string }; returnData?: string; status: string }, errors: Map<Hex, string>): string {
  const data = r.error?.data ?? r.returnData;
  const name = isHexData(data) ? revertName(hexToBytes(data), errors) : null;
  return name ? `reverted with ${name}` : (r.error?.message ?? `status ${r.status}`);
}

const NOT_NEWER = bytesToHex(keccak_256(new TextEncoder().encode("NotNewer(uint32,uint32)")).slice(0, 4));

/**
 * What to do about a NotNewer revert: the light client moved to the bundle's block or past it
 * after the bundle was read. Importing into it is open to anyone, so the import that did it can be
 * any relayer's, ours or not; the remedy is a fresh bundle.
 */
function notNewerHint(r: { error?: { data?: string }; returnData?: string }): string {
  const data = r.error?.data ?? r.returnData;
  return isHexData(data) && data.toLowerCase().startsWith(NOT_NEWER)
    ? ` (the light client moved to or past the bundle's block after it was read: anyone can import into it, so any relayer's import can do that; capture the bundle again with --force and send again)`
    : "";
}

/** A demo step's outcome: it passes when the call reverted with exactly the expected revert data. */
function revertCheck(revert: Uint8Array, r: { error?: { message?: string; data?: string }; returnData?: string; status: string }, errors: Map<Hex, string>): [boolean, string] {
  const want = revertName(revert, errors) ?? shortHex(revert);
  const data = r.error?.data ?? r.returnData;
  const ok = r.status !== "0x1" && isHexData(data) && equalBytes(hexToBytes(data), revert);
  return [ok, ok ? `reverts with ${want}, as it has to` : `has to revert with ${want}, but ${r.status === "0x1" ? "it passes" : revertText(r, errors)}`];
}

/** Why the code a creation left is not the build's with its constructor arguments as immutables, or null. */
const buildProblem = (s: Step, code: Uint8Array): string | null => immutablesProblem(code, s.artifact!.runtime, s.artifact!.immutables, s.immutables!);

/** The checks of one simulated step, as [ok, what] pairs; the first is the step itself. */
function judge(s: Step, sim: Simulated, limit: number, errors: Map<Hex, string>): [boolean, string][] {
  const r = sim.results.get(s.index);
  if (!r) return [[false, `${tag(s)} ${s.label}: not run, a step before it failed`]];
  const gas = `${share(gasOf(r))}; gas limit ${fmt(limit)}`;
  if (s.expect) {
    const [ok, what] = revertCheck(s.expect.revert, r, errors);
    return [[ok, `${tag(s)} ${s.label}: ${what}; ${gas}`]];
  }
  if (r.status !== "0x1") return [[false, `${tag(s)} ${s.label}: ${revertText(r, errors)}${notNewerHint(r)}`]];
  if (s.kind === "deploy") {
    const code = hexToBytes(r.returnData);
    const there = sim.codeHashThere.get(s.index) === bytesToHex(keccak_256(code));
    const problem = buildProblem(s, code);
    return [
      [there, `${tag(s)} ${s.label}, nonce ${s.nonce}, at ${checksumAddress(hexToBytes(s.address!))}: ${there ? `${fmt(code.length)} bytes of code there, ${gas}` : "its code is not at the CREATE address"}`],
      [problem === null, `     the code is the build's (${repoPath(s.artifact!.path)})${s.immutables!.length ? `, its ${s.immutables!.length} immutable${s.immutables!.length === 1 ? "" : "s"} the constructor arguments` : ""}${problem ? `: ${problem}` : ""}`],
    ];
  }
  const lines: [boolean, string][] = [[true, `${tag(s)} ${s.label}: ${gas}`]];
  for (const [ok, what] of s.checks(r, sim.views.get(s.index) ?? [])) lines.push([ok, `     ${what}`]);
  return lines;
}

const groups = (requests: Step[][]) => requests.map((r) => `[${r.map((s) => s.index).join(",")}]`).join(" ");

interface DryRun {
  /** Per step: the gas limit it is sent with, its simulated gas and, for a creation, the hash of the code it leaves. */
  limits: Map<number, number>;
  gas: Map<number, number>;
  codeHashes: Map<number, Hex>;
}

/** Runs the plan on the node, twice (the cap, then the limits); null when a check fails. */
async function dryRun(plan: Plan, ctx: { block: { number: string; hash: string }; fees: Fees; balances: Map<Hex, bigint> }): Promise<DryRun | null> {
  const { fees } = ctx;
  log(`Fees: next base fee ${fmt(fees.base)} wei, priority fee ${fmt(fees.tip)} wei, max fee ${fmt(fees.maxFee)} wei (node gas price ${fmt(fees.gasPrice)} wei)`);
  if (!check(fees.maxFee >= fees.base && fees.maxFee >= fees.tip, "the max fee covers the next base fee and the priority fee")) return null;

  // 1. Measure, with the cap as gas limit (a demo step, which reverts after a few million gas, with
  // its own limit, so that it fits in the request of the step whose state it needs).
  const cap = (s: Step) => s.measureLimit ?? CAP;
  const first = await simulate(plan, cap, cap, ctx.block.number, fees);
  const measured = plan.steps.flatMap((s) => judge(s, first, cap(s), plan.errors));
  if (measured.some(([ok]) => !ok)) {
    log(`\nWith gas limit 16,777,216 (requests ${groups(first.requests)}):`);
    for (const [ok, what] of measured) check(ok, what);
    return null;
  }
  const gas = new Map(plan.steps.map((s) => [s.index, gasOf(first.results.get(s.index)!)]));
  // A demo step keeps the limit it was measured with: on the Sepolia node a call that reverts can
  // need a limit well above the gas it reports (the amount tamper before the mint reports 2,316,080
  // and reverts without data below a limit of about 2,650,000), so its gas + 10% is not enough.
  const limits = new Map(plan.steps.map((s) => [s.index, s.expect ? cap(s) : withHeadroom(gas.get(s.index)!)]));

  // 2. The exact plan: every step with the gas limit it is sent with.
  const run = await simulate(plan, (s) => limits.get(s.index)!, (s) => gas.get(s.index)!, ctx.block.number, fees);
  const demoLimit = plan.steps.some((s) => s.measureLimit) ? ` (the demo's reverts ${fmt(REPLAY_GAS)})` : "";
  log(`Requests: ${groups(first.requests)} with gas limit 16,777,216${demoLimit}, then ${groups(run.requests)} with the gas limits below.\n`);
  let total = 0;
  let largest = 0;
  for (const s of plan.steps) {
    for (const [ok, what] of judge(s, run, limits.get(s.index)!, plan.errors)) check(ok, what);
    const r = run.results.get(s.index);
    if (!r) continue;
    if (gasOf(r) !== gas.get(s.index)) check(false, `     ${fmt(gas.get(s.index)!)} gas with the cap as gas limit, ${fmt(gasOf(r))} with ${fmt(limits.get(s.index)!)}`);
    total += gasOf(r);
    largest = Math.max(largest, gasOf(r));
  }

  // 3. Gas and cost. Before each of its transactions a sender must hold the transaction's gas limit
  // at the max fee; at most, every earlier one paid the max fee too.
  log(`\n     ${plan.steps.length} transaction${plan.steps.length === 1 ? "" : "s"}: ${fmt(total)} gas; the largest ${share(largest)}`);
  const top = Math.max(...limits.values());
  check(top <= CAP, `every gas limit is within the 16,777,216 cap (the largest ${fmt(top)})`);
  const peak = Math.max(first.peak, run.peak);
  check(peak <= REQUEST_GAS, `the largest request needs ${fmt(peak)} of the ${fmt(REQUEST_GAS)} gas one request may use`);
  for (const [sender, balance] of ctx.balances) {
    let need = 0n;
    let paid = 0n;
    for (const s of plan.steps.filter((x) => x.from === sender)) {
      const upfront = paid + BigInt(limits.get(s.index)!) * fees.maxFee;
      if (upfront > need) need = upfront;
      paid += BigInt(gas.get(s.index)!) * fees.maxFee;
    }
    if (need === 0n) continue;
    const after = run.balances.get(sender) ?? balance;
    check(
      need <= balance,
      `${checksumAddress(hexToBytes(sender))} pays ${eth(balance - after)} at the current fees (base fee ${fmt(run.baseFee)} wei + priority fee, as simulated); ` +
        `at most ${eth(need)} at the max fee; it has ${eth(balance)}`,
    );
  }
  if (failures > 0) return null;
  const codeHashes = new Map<number, Hex>();
  for (const s of plan.steps) if (s.kind === "deploy") codeHashes.set(s.index, bytesToHex(keccak_256(hexToBytes(run.results.get(s.index)!.returnData))));
  return { limits, gas, codeHashes };
}

// ---------------------------------------------------------------------------------------
// Send

const dataHash = (s: Step): Hex => bytesToHex(keccak_256(hexToBytes(s.data)));

function newRecord(s: Setting): BridgeRecord {
  return {
    network: "sepolia",
    chainId: Number(SEPOLIA_CHAIN_ID),
    deployer: s.deployment.deployerName,
    lightClient: { name: CLIENT_NAME, address: s.deployment.client },
    vault: { network: "portaldot-v3-testnet", chainId: Number(V3.chainId), address: s.vault.address, codeHash: s.vault.codeHash },
    artifacts: {},
    contracts: {},
    steps: [],
  };
}

/** The record's entry of a step (by sender and nonce), or a new one appended to it. */
function entryOf(record: BridgeRecord, s: Step, setting: Setting, errors: Map<Hex, string>): BridgeStep {
  const found = record.steps.find((e) => e.nonce === s.nonce && e.sender === s.from);
  if (found) {
    if (found.dataHash !== dataHash(s)) throw new Stop(`${BRIDGE_RECORD} has another transaction at nonce ${s.nonce} of ${s.from} (${found.name}): look at it before sending again`);
    return found;
  }
  const b = setting.bundle;
  const entry: BridgeStep = {
    name: s.name,
    kind: s.kind === "deploy" ? "deploy" : (s.expect?.kind ?? "mint"),
    nonce: s.nonce,
    sender: s.from,
    contract: s.kind === "deploy" ? s.artifact!.contractId : "src/bridge/BridgeMinter.sol:BridgeMinter",
    address: s.kind === "deploy" ? s.address! : s.to!,
    ...(s.kind === "deploy" ? { libraries: s.artifact!.libraries, constructorArgs: s.constructorArgs! } : {}),
    ...(s.kind === "call" && b
      ? {
          lock: { nonce: b.lock.nonce, recipient: b.lock.recipient, amountNative: b.lock.amountNative },
          bundle: { file: setting.bundleFile === null ? null : repoPath(setting.bundleFile), block: b.provenance.block, setId: b.provenance.setId },
        }
      : {}),
    ...(s.expect
      ? { ...(s.expect.tamper ? { tamper: s.expect.tamper } : {}), expectedRevert: { name: revertName(s.expect.revert, errors) ?? "unnamed", data: bytesToHex(s.expect.revert) } }
      : {}),
    dataHash: dataHash(s),
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
  record.steps.push(entry);
  return entry;
}

/** eth_call at `block`, its error (with the revert data) returned rather than thrown. */
async function ethCall(call: { from?: Hex; to: Hex; data: Hex; gas: number }, block: string): Promise<{ result?: unknown; error?: { message?: string; data?: string } }> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ ...call, gas: qty(call.gas) }, block] }),
    signal: AbortSignal.timeout(120_000),
  });
  return (await res.json()) as { result?: unknown; error?: { message?: string; data?: string } };
}

/** A step's read in the block of its receipt: its data, or its revert data; an error without revert data is retried. */
function readAt(x: Read, block: string): Promise<ReadResult> {
  return sepolia("read", async () => {
    const body = await ethCall({ to: x.to, data: bytesToHex(x.data), gas: readGas(x) }, block);
    if (isHexData(body.result)) return { ok: true, data: hexToBytes(body.result), gas: 0 };
    if (isHexData(body.error?.data)) return { ok: false, data: hexToBytes(body.error.data), gas: 0 };
    throw new Error(body.error?.message ?? "eth_call returned neither a result nor revert data");
  });
}

/** Checks a mined step against the dry run and writes it into the record; true when it passed. */
async function recordReceipt(record: BridgeRecord, s: Step, entry: BridgeStep, receipt: Receipt, plan: Plan): Promise<boolean> {
  const status = Number(BigInt(receipt.status));
  const gasUsed = gasOf(receipt);
  const lines: [boolean, string][] = [
    [
      status === (s.expect ? 0 : 1),
      `${tag(s)} ${s.label}: status ${status}${s.expect ? " (it has to revert)" : ""}, block ${fmt(Number(BigInt(receipt.blockNumber)))}, ` +
        `${share(gasUsed)} (simulated ${fmt(entry.simulatedGas ?? 0)}), tx ${receipt.transactionHash}`,
    ],
  ];
  if (s.expect) {
    // A receipt has no revert reason: the call replayed on the state its block left has to revert
    // with the expected error (nothing the demo sends changes state).
    const body = await sepolia("replay", () => ethCall({ from: s.from, to: s.to!, data: s.data, gas: entry.gasLimit ?? CAP }, receipt.blockNumber));
    const replayed = { status: body.error ? "0x0" : "0x1", error: body.error, returnData: isHexData(body.result) ? body.result : undefined };
    const [ok, what] = revertCheck(s.expect.revert, replayed, plan.errors);
    lines.push([ok, `     replayed on its block, it ${what}`]);
  } else if (s.kind === "deploy") {
    const r = receipt as Receipt & { contractAddress?: string };
    lines.push([r.contractAddress?.toLowerCase() === s.address, `     created at ${checksumAddress(hexToBytes(s.address!))}`]);
    const code = await codeAt(s.address!, receipt.blockNumber);
    lines.push([bytesToHex(keccak_256(code)) === entry.codeHash, "     with the code the dry run left there"]);
    const problem = buildProblem(s, code);
    lines.push([problem === null, `     the code is the build's, its immutables the constructor arguments${problem ? `: ${problem}` : ""}`]);
  } else if (status === 1) {
    const views: ReadResult[] = [];
    for (const x of s.reads) views.push(await readAt(x, receipt.blockNumber));
    for (const [ok, what] of s.checks(receipt, views)) lines.push([ok, `     ${what}`]);
  } else {
    // A receipt has no revert reason: replay the call on the state its block left.
    const body = await sepolia("replay", () => ethCall({ from: s.from, to: s.to!, data: s.data, gas: entry.gasLimit ?? CAP }, receipt.blockNumber));
    lines.push([false, `     replayed on its block: ${body.error ? `${revertText({ status: "0x0", error: body.error }, plan.errors)}${notNewerHint({ error: body.error })}` : "it passes there"}`]);
  }
  let ok = true;
  for (const [k, what] of lines) ok = check(k, what) && ok;
  Object.assign(entry, { txHash: receipt.transactionHash, block: Number(BigInt(receipt.blockNumber)), gasUsed, status, effectiveGasPrice: BigInt(receipt.effectiveGasPrice ?? 0).toString(), ok });
  saveBridge(record);
  return ok;
}

/**
 * Settles what an earlier --send run left in the record for `s`: a mined transaction is checked and
 * recorded (true: nothing to send), a dropped one is sent again (false), a pending one stops the run
 * (PENDING).
 */
async function reconcile(record: BridgeRecord, s: Step, entry: BridgeStep, plan: Plan): Promise<boolean | typeof PENDING> {
  if (!entry.txHash) return false;
  if (entry.block !== null) {
    if (!entry.ok) throw new Stop(`${entry.name} was mined (tx ${entry.txHash}) but failed its checks; see ${BRIDGE_RECORD}`);
    return true;
  }
  let receipt: Receipt | null = null;
  for (const h of [entry.txHash, ...(entry.dropped ?? [])]) receipt ??= await sepolia("receipt", () => receiptOf(h, false));
  if (receipt) {
    if (!(await recordReceipt(record, s, entry, receipt, plan))) throw new Stop(`${entry.name} (tx ${receipt.transactionHash}) failed its checks`);
    return true;
  }
  const n = await sepolia("nonces", () => nonces(s.from));
  if (n.latest > s.nonce) throw new Stop(`nonce ${s.nonce} of ${s.from} is used on chain, but not by ${entry.txHash}; look at the sender's transactions`);
  if (n.pending > n.latest) {
    log(`     ${entry.txHash} (${entry.name}) is still pending; run again once it is mined`);
    return PENDING;
  }
  log(`     ${entry.txHash} (${entry.name}) was dropped; it is sent again`);
  entry.dropped = [...(entry.dropped ?? []), entry.txHash];
  entry.txHash = null;
  saveBridge(record);
  return false;
}

/** The checks a receipt allows for an entry without the plan that sent it, as [passed, what]. */
async function receiptChecks(entry: BridgeStep, receipt: Receipt, errors: Map<Hex, string>): Promise<[boolean, string][]> {
  const status = Number(BigInt(receipt.status));
  const lines: [boolean, string][] = [];
  const head = `${entry.name}: status ${status}, block ${fmt(Number(BigInt(receipt.blockNumber)))}, ${share(gasOf(receipt))}, tx ${receipt.transactionHash}`;
  switch (entry.kind) {
    case "deploy": {
      const r = receipt as Receipt & { contractAddress?: string };
      lines.push([status === 1 && r.contractAddress?.toLowerCase() === entry.address, `${head}, created at ${checksumAddress(hexToBytes(entry.address))}`]);
      const code = await codeAt(entry.address, receipt.blockNumber);
      lines.push([bytesToHex(keccak_256(code)) === entry.codeHash, "with the code the dry run left there"]);
      break;
    }
    case "mint": {
      const l = entry.lock ? findLog(receipt.logs, entry.address, MINTED_TOPIC, bytesToHex(uintWord(BigInt(entry.lock.nonce)))) : undefined;
      const e = l ? decodeMinted(l) : null;
      lines.push([status === 1, head]);
      lines.push([!!e && bytesToHex(e.recipient) === entry.lock?.recipient && e.amount === BigInt(entry.lock?.amountNative ?? -1), `Minted lock ${entry.lock?.nonce}: ${e ? `${formatWtpot(e.amount)} to ${checksumAddress(e.recipient)}` : "no Minted event"}`]);
      break;
    }
    case "tamper":
    case "replay": {
      lines.push([status === 0, `${head} (it has to revert)`]);
      // A receipt has no revert reason: the call, rebuilt from the bundle file the entry names, replayed on its block.
      const file = entry.bundle?.file ? at(entry.bundle.file) : null;
      const b = file && existsSync(file) ? readBundle(file) : null;
      const data =
        b && entry.expectedRevert
          ? entry.kind === "replay"
            ? replayCall(b).data
            : entry.tamper
              ? tamperedCall(b, entry.tamper.part, hexToBytes(entry.address), SEPOLIA_CHAIN_ID).data
              : null
          : null;
      if (data && bytesToHex(keccak_256(data)) === entry.dataHash) {
        const body = await sepolia("replay", () => ethCall({ from: entry.sender, to: entry.address, data: bytesToHex(data), gas: entry.gasLimit ?? CAP }, receipt.blockNumber));
        const replayed = { status: body.error ? "0x0" : "0x1", error: body.error, returnData: isHexData(body.result) ? body.result : undefined };
        const [ok, what] = revertCheck(hexToBytes(entry.expectedRevert!.data), replayed, errors);
        lines.push([ok, `replayed on its block, it ${what}`]);
      } else log(`     note: ${entry.name} is not replayed: ${entry.bundle?.file ?? "no bundle file"} does not rebuild its call here`);
      break;
    }
    case "burn": {
      const l = receipt.logs.find((x) => x.address.toLowerCase() === entry.address && x.topics[0]?.toLowerCase() === BURN_REQUESTED_TOPIC);
      const e = l ? decodeBurnRequested(l) : null;
      lines.push([status === 1, head]);
      const fields = !!e && bytesToHex(e.from) === entry.sender && bytesToHex(e.v3Recipient) === entry.burn?.v3Recipient && e.amount === BigInt(entry.burn?.amount ?? -1);
      lines.push([fields && equalBytes(e!.burnId, burnId(SEPOLIA_CHAIN_ID, hexToBytes(entry.address), e!.burnNonce)), `BurnRequested: ${e ? `burn ${e.burnNonce}, ${formatWtpot(e.amount)} for ${checksumAddress(e.v3Recipient)} on V3, burn id ${shortHex(e.burnId)} (the vault's convention)` : "no event"}`]);
      if (e && entry.burn) Object.assign(entry.burn, { burnNonce: e.burnNonce.toString(), burnId: bytesToHex(e.burnId) });
      break;
    }
    default:
      lines.push([status === 1, head]);
  }
  return lines;
}

/**
 * Settles every entry an earlier --send run left open in the record (its hash recorded, its block
 * not), before anything is planned: a mined one gets its block, gas and status and the checks its
 * receipt allows (a creation's address and code, a mint's Minted event, a burn's BurnRequested
 * event, a demo revert's status 0 and, with its bundle file here, its revert replayed on its
 * block); a pending one stays open; one neither mined nor pending is marked dropped, so that a
 * later --send sends it again.
 */
async function settleOpen(record: BridgeRecord, errors: Map<Hex, string>): Promise<void> {
  for (const entry of record.steps.filter((e) => e.txHash !== null && e.block === null)) {
    let receipt: Receipt | null = null;
    for (const h of [entry.txHash!, ...(entry.dropped ?? [])]) receipt ??= await sepolia("receipt", () => receiptOf(h, false));
    if (!receipt) {
      const n = await sepolia("nonces", () => nonces(entry.sender));
      if (n.latest <= entry.nonce && n.pending > n.latest) {
        log(`     ${entry.name} (nonce ${entry.nonce}): ${entry.txHash}, sent by an earlier run, is still pending`);
        continue;
      }
      entry.dropped = [...(entry.dropped ?? []), entry.txHash!];
      entry.note = n.latest > entry.nonce ? `nonce ${entry.nonce} was used by another transaction` : `neither mined nor pending at ${new Date().toISOString()}`;
      entry.txHash = null;
      saveBridge(record);
      log(`     ${entry.name} (nonce ${entry.nonce}): ${entry.dropped.at(-1)}, sent by an earlier run, was never mined (${entry.note})`);
      continue;
    }
    log(`     settling ${entry.name} (nonce ${entry.nonce}), sent by an earlier run:`);
    let ok = true;
    for (const [k, what] of await receiptChecks(entry, receipt, errors)) ok = check(k, `     ${what}`) && ok;
    Object.assign(entry, {
      txHash: receipt.transactionHash,
      block: Number(BigInt(receipt.blockNumber)),
      gasUsed: gasOf(receipt),
      status: Number(BigInt(receipt.status)),
      effectiveGasPrice: BigInt(receipt.effectiveGasPrice ?? 0).toString(),
      ok,
    });
    saveBridge(record);
  }
}

/** Sends the steps `o.command` sends, one at a time, each recorded before it is published. */
async function send(plan: Plan, dry: DryRun, s: Setting, fees: Fees): Promise<number> {
  const o = s.o;
  if (!o.send || !o.account || !o.passwordFile) throw new Error("send without --send");
  const record = readBridge() ?? newRecord(s);
  const mine = plan.steps.filter((x) => x.sentBy === o.command);
  for (const step of mine) if (step.kind === "deploy") record.artifacts[step.artifact!.name] = bytesToHex(keccak_256(step.artifact!.initcode));
  saveBridge(record);
  for (const step of mine) {
    const entry = entryOf(record, step, s, plan.errors);
    const settled = await reconcile(record, step, entry, plan);
    if (settled === PENDING) return PENDING;
    if (settled) continue;
    if (!(await nextNonceIs(step.from, step.nonce))) return FAILED;
    const args = mktxArgs(step.name, {
      to: step.kind === "deploy" ? null : step.to!,
      data: step.data,
      nonce: step.nonce,
      gasLimit: dry.limits.get(step.index)!,
      fees,
      account: o.account,
      passwordFile: o.passwordFile,
    });
    Object.assign(entry, { gasLimit: dry.limits.get(step.index)!, simulatedGas: dry.gas.get(step.index)!, codeHash: dry.codeHashes.get(step.index) ?? null });
    saveBridge(record);
    const hash = signAndPublish(args, `${tag(step)} ${step.name}`, (signed) => {
      log(`     ${tag(step)} ${step.name}: signed ${signed}, gas limit ${fmt(dry.limits.get(step.index)!)}`);
      Object.assign(entry, { txHash: signed, signedAt: new Date().toISOString() });
      saveBridge(record);
    });
    if (!hash) return FAILED;
    const receipt = await sepolia("receipt", () => receiptOf(hash, true));
    if (!receipt) {
      log(`     ${hash} is not mined after ${RECEIPT_TIMEOUT / 60_000} minutes; run again to settle it`);
      return PENDING;
    }
    if (!(await recordReceipt(record, step, entry, receipt, plan))) {
      if (step.name === "BridgeMinter") log(`     nonce ${MINTER_NONCE} is spent: no minter can be created at ${checksumAddress(hexToBytes(step.address!))} any more`);
      if (step.name === "WrappedTPOT") log(`     nonce ${TOKEN_NONCE} is spent: no token can be created at ${checksumAddress(hexToBytes(step.address!))} any more, the token the minter takes`);
      return FAILED;
    }
    if (step.kind === "deploy") log(`     verify: ${verifyCommand(step.artifact!, step.address!, step.constructorArgs!)}`);
  }
  return OK;
}

// ---------------------------------------------------------------------------------------
// plan, deploy, mint

async function planCommand(o: PlanOptions): Promise<number> {
  const demo = o.tamper ? `the demo's tampered importAndMint (${o.tamper})` : o.replay ? "the demo's replayed importAndMint" : null;
  const what =
    o.command === "deploy"
      ? "deploying BridgeMinter and WrappedTPOT"
      : o.sandbox
        ? `planning the whole path${demo ? ` with ${demo}` : ""} in a sandbox`
        : o.command === "mint"
          ? (demo ?? "minting")
          : "planning the mint";
  log(`${new Date().toISOString()}: ${what} on Sepolia${o.send ? "" : " (dry run)"}`);
  const deployment = readSepolia();
  const vault = readV3();
  let sender: Hex = deployment.deployer;
  if (o.send) {
    const unlocked = keystoreAddress(o.account!, o.passwordFile!);
    if (!unlocked) return FAILED;
    sender = unlocked.toLowerCase() as Hex;
    if (o.command === "deploy" && !check(sender === deployment.deployer, `keystore ${o.account} is the deployer ${deployment.deployerName}`)) return FAILED;
  } else if (o.from) sender = o.from;

  // The lock: from the bundle (plan, mint, or a deploy given one), else, for a deploy, as the
  // record or the vault's log has it, without a capture.
  let captured: { bundle: MintBundleFixture; file: string | null } | null = null;
  let lock: LockFacts;
  if (o.command !== "deploy" || o.bundleFile !== undefined) {
    captured = await bundleFor(o);
    lock = lockOfBundle(captured.bundle);
    const b = captured.bundle;
    if (b.provenance.genesisHash !== V3.genesis || BigInt(b.vault.chainId) !== V3.chainId) throw new Stop(`the bundle is not from ${V3.title}`);
    if (b.vault.address !== vault.address || b.vault.codeHash !== vault.codeHash) throw new Stop(`the bundle's vault (${b.vault.address}, code hash ${shortHex(b.vault.codeHash)}) is not the one ${V3_RECORD} records`);
  } else lock = await lockOf(vault, o.nonce ?? 0n, o);
  checkLock(lock, vault, deployment);
  log(`Lock ${lock.nonce} (${lock.source}): ${formatTpot(lock.amountNative)} for ${checksumAddress(lock.recipient)}, minter ${checksumAddress(lock.dstMinter)} = CREATE(deployer, ${MINTER_NONCE})`);
  const bundle = o.command === "deploy" ? null : captured!.bundle;

  // Everything is read at one block, the one the plan is simulated on.
  let chainId: string;
  try {
    chainId = await rpc<string>("eth_chainId", []);
  } catch (error) {
    if (error instanceof DryRunViolation) throw error;
    throw new Unreachable(`Sepolia RPC unreachable (${errorText(error)})`);
  }
  if (!check(BigInt(chainId) === SEPOLIA_CHAIN_ID, `chain id ${BigInt(chainId)} is Sepolia`)) throw new Stop("the Sepolia RPC serves another chain");
  const block = await sepolia("latest block", () => rpc<{ number: string; hash: string }>("eth_getBlockByNumber", ["latest", false]));
  const fees = await sepolia("fees", () => feesAt(block, { priorityFee: o.priorityFee, maxFee: o.maxFee }));
  const balanceOf = async (address: Hex) => BigInt(await sepolia("balance", () => rpc<string>("eth_getBalance", [address, block.number])));
  const nonceOf = async (address: Hex) => Number(BigInt(await sepolia("nonce", () => rpc<string>("eth_getTransactionCount", [address, block.number]))));
  const deployerNonce = await nonceOf(deployment.deployer);
  const n = await sepolia("nonces", () => nonces(deployment.deployer));
  const senderNonce = sender === deployment.deployer ? deployerNonce : await nonceOf(sender);
  log(`Sepolia block ${fmt(Number(BigInt(block.number)))} (${block.hash}), simulated on top of it via ${new URL(RPC).host}`);
  log(`Deployer ${deployment.deployerName}: nonce ${deployerNonce} (pending ${n.pending}), balance ${eth(await balanceOf(deployment.deployer))}`);
  if (sender !== deployment.deployer) log(`Sender of the mint ${checksumAddress(hexToBytes(sender))}${o.send ? ` (keystore ${o.account})` : " (--from)"}: nonce ${senderNonce}, balance ${eth(await balanceOf(sender))}`);
  const clientCode = await codeAt(deployment.client, block.number);
  if (!check(bytesToHex(keccak_256(clientCode)) === deployment.clientCodeHash, `${CLIENT_NAME} ${deployment.client} has the code ${SEPOLIA_RECORD} recorded`)) throw new Stop("the light client is not the recorded one");
  const client = await readClient(deployment.client, block.number);
  log(`${CLIENT_NAME}: set ${client.setId}, latest #${fmt(client.latestNumber)} ${shortHex(client.latestHash)}, ${client.halted ? "HALTED" : "not halted"}, ${client.paused ? "PAUSED" : "not paused"}`);
  const bridge = await readBridgeState(deployment.deployer, block.number);
  if (!equalBytes(hexToBytes(bridge.minter), lock.dstMinter)) throw new Stop("CREATE(deployer, 31) is not the lock's minter");
  log(
    `BridgeMinter ${checksumAddress(hexToBytes(bridge.minter))} (CREATE(deployer, ${MINTER_NONCE})): ` +
      (bridge.minterDeployed ? `deployed, ${bridge.bound ? `bound to trie id ${shortHex(bridge.trieId)}` : "not bound"}, ${bridge.burnCount} burns` : "not deployed") +
      `; WrappedTPOT ${checksumAddress(hexToBytes(bridge.token))} (CREATE(deployer, ${TOKEN_NONCE})): ${bridge.tokenDeployed ? `deployed, total supply ${formatWtpot(bridge.totalSupply)}` : "not deployed"}`,
  );
  checkBridge(bridge, deployment, vault);
  const record = readBridge();
  if (record) {
    // What an earlier --send run left open is settled before anything is planned.
    await settleOpen(record, errorMap(BRIDGE_ERRORS));
    const open = record.steps.filter((e) => e.block === null && e.txHash !== null);
    log(`${BRIDGE_RECORD}: ${record.steps.length} step${record.steps.length === 1 ? "" : "s"}${open.length ? `, ${open.map((e) => `${e.name} (nonce ${e.nonce}) signed and still pending`).join(", ")}` : ""}`);
    for (const [name, address] of Object.entries(record.contracts)) {
      const onChain = name === "BridgeMinter" ? bridge.minter : name === "WrappedTPOT" ? bridge.token : null;
      if (onChain !== address) throw new Stop(`${BRIDGE_RECORD} records ${name} at ${address}, not at ${onChain}`);
    }
  } else log(`${BRIDGE_RECORD}: no record yet`);

  const imported = bundle ? BigInt(bytesToHex(await sepolia("isImported", () => view(deployment.client, callData(CLIENT.isImported, hexToBytes(bundle.header.hash)), block.number)))) !== 0n : false;
  const balanceBefore =
    bundle && bridge.tokenDeployed ? uintAt(await sepolia("balance", () => view(bridge.token, callData(TOKEN.balanceOf, addressWord(hexToBytes(bundle.lock.recipient))), block.number)), 0) : 0n;
  const setting: Setting = { o, deployment, vault, bundle, bundleFile: captured?.file ?? null, bridge, client, imported, deployerNonce, sender, senderNonce, balanceBefore };

  if (!o.sandbox) {
    // What is deployed decides the creations; the deployer has to be at exactly their nonce.
    if (!bridge.minterDeployed && bridge.tokenDeployed) throw new Stop("WrappedTPOT is deployed but BridgeMinter is not: the pair cannot be completed");
    const deployed = bridge.minterDeployed && bridge.tokenDeployed;
    if (o.command === "deploy" && deployed) {
      check(true, "BridgeMinter and WrappedTPOT are deployed already: nothing to deploy");
      return OK;
    }
    if (o.command === "mint" && !deployed) throw new Stop(`${bridge.minterDeployed ? "WrappedTPOT" : "BridgeMinter"} is not deployed: run npm run mint -- deploy first (plan dry-runs the whole path)`);
    if (!deployed) requireDeployerNonce(setting, n, bridge.minterDeployed ? TOKEN_NONCE : MINTER_NONCE);
    if (bundle) {
      const used = bridge.minterDeployed && uintAt(await sepolia("used", () => view(bridge.minter, callData(MINTER.used, uintWord(BigInt(bundle.lock.nonce))), block.number)), 0) !== 0n;
      // A tamper goes before the mint or after it; a replay is of a mint.
      if (used && !o.tamper && !o.replay) throw new Stop(`lock ${bundle.lock.nonce} is minted already (used(${bundle.lock.nonce}) is true)`);
      if (!used && o.replay) throw new Stop(`lock ${bundle.lock.nonce} is not minted yet: the replay is of its mint (npm run mint -- mint --send ...)`);
      requireClientReady(setting);
    }
    if (o.send && n.pending !== n.latest && sender === deployment.deployer) throw new Stop(`the deployer has pending transactions (nonce ${n.latest}, pending ${n.pending}): wait until they are mined`);
  }
  const plan = makePlan(setting);
  const deploys = plan.steps.filter((s) => s.kind === "deploy").length;
  log(
    `\nPlan: ${plan.steps.length} transaction${plan.steps.length === 1 ? "" : "s"}, ${deploys} creation${deploys === 1 ? "" : "s"} and ${plan.steps.length - deploys} call${plan.steps.length - deploys === 1 ? "" : "s"}` +
      (o.sandbox
        ? `; sandbox: the sandbox sender creates and initializes a fresh light client at ${checksumAddress(hexToBytes(plan.client))}, the deployer is at nonce ${MINTER_NONCE}, and ${shortHex(plan.minter)} and ${shortHex(plan.token)} are empty`
        : "") +
      `. eth_simulateV1 with validation on, from each sender at its nonce and with its balance on chain; each request goes on from what the one before left.`,
  );
  for (const s of plan.steps.filter((x) => x.kind === "deploy" && x.sentBy === "deploy" && !o.sandbox)) {
    log(`     ${tag(s)} ${s.name} at ${checksumAddress(hexToBytes(s.address!))}, constructor arguments ${s.constructorArgs}`);
    log(`          verify once mined: ${verifyCommand(s.artifact!, s.address!, s.constructorArgs!)}`);
  }
  log();
  const balances = new Map<Hex, bigint>();
  for (const s of plan.steps) if (s.from !== SANDBOX_SENDER && !balances.has(s.from)) balances.set(s.from, await balanceOf(s.from));
  let dry: DryRun | null = null;
  try {
    dry = await dryRun(plan, { block, fees, balances });
  } catch (error) {
    if (error instanceof Unreachable || error instanceof DryRunViolation) throw error;
    check(false, errorText(error));
  }
  if (!dry) {
    log("\nThe dry run failed: nothing can be sent.");
    return FAILED;
  }
  if (!o.send) {
    const next =
      o.command === "plan" && !o.sandbox && plan.steps.some((s) => s.sentBy === "deploy")
        ? ` Next: npm run mint -- deploy --send ..., then npm run mint -- mint ${captured?.file ? `--bundle ${repoPath(captured.file)}` : `--nonce ${lock.nonce}`} --send ...`
        : "";
    log(`\nThe dry run passed. Nothing was signed or sent.${next}`);
    return OK;
  }
  log("\nThe dry run passed. Sending:");
  const sent = await send(plan, dry, setting, fees);
  if (sent === OK) log(`\nEvery transaction is mined and checked; the record is ${BRIDGE_RECORD}.`);
  return sent;
}

// ---------------------------------------------------------------------------------------
// status

async function status(o: Common): Promise<number> {
  log(`${new Date().toISOString()}: the bridge from ${V3.title} to Sepolia`);
  const deployment = readSepolia();
  const vault = readV3();
  const record = readBridge();
  let chainId: string;
  try {
    chainId = await rpc<string>("eth_chainId", []);
  } catch (error) {
    if (error instanceof DryRunViolation) throw error;
    throw new Unreachable(`Sepolia RPC unreachable (${errorText(error)})`);
  }
  if (!check(BigInt(chainId) === SEPOLIA_CHAIN_ID, `chain id ${BigInt(chainId)} is Sepolia`)) throw new Stop("the Sepolia RPC serves another chain");

  // Sepolia: the light client, the minter and the token.
  const block = await sepolia("latest block", () => rpc<{ number: string }>("eth_getBlockByNumber", ["latest", false]));
  const client = await readClient(deployment.client, block.number);
  log(`Sepolia block ${fmt(Number(BigInt(block.number)))}: ${CLIENT_NAME} ${deployment.client} at set ${client.setId}, latest #${fmt(client.latestNumber)} ${shortHex(client.latestHash)}`);
  const bridge = await readBridgeState(deployment.deployer, block.number);
  const minterText = checksumAddress(hexToBytes(bridge.minter));
  if (!bridge.minterDeployed) log(`BridgeMinter ${minterText} (CREATE(deployer, ${MINTER_NONCE})): not deployed`);
  else {
    log(
      `BridgeMinter ${minterText}: ${bridge.bound ? `bound, trie id ${bridge.trieId}` : "not bound"}; light client ${bridge.lightClient}, vault ${bridge.vault} ` +
        `(chain ${bridge.vaultChainId}, code hash ${shortHex(bridge.vaultCodeHash ?? "0x")}); ${bridge.burnCount} burn${bridge.burnCount === 1n ? "" : "s"}`,
    );
  }
  log(`WrappedTPOT ${checksumAddress(hexToBytes(bridge.token))} (CREATE(deployer, ${TOKEN_NONCE})): ${bridge.tokenDeployed ? `total supply ${formatWtpot(bridge.totalSupply)}, minter ${bridge.tokenMinter}` : "not deployed"}`);
  checkBridge(bridge, deployment, vault);
  if (record) for (const s of record.steps.filter((x) => !x.ok)) log(`     note: ${BRIDGE_RECORD} has ${s.name} (nonce ${s.nonce}) as ${s.block === null ? (s.txHash ? "signed, not seen mined" : "planned") : "mined and failed"}`);
  for (const s of record?.steps.filter((x) => (x.kind === "tamper" || x.kind === "replay") && x.ok) ?? []) {
    log(`     the demo's ${s.kind}${s.tamper ? ` (${s.tamper.part})` : ""} of lock ${s.lock?.nonce}: tx ${s.txHash}, block ${fmt(s.block ?? 0)}, reverted with ${s.expectedRevert?.name}`);
  }

  // V3: the vault, read as v3-vault.ts status reads it, its logs in windows from its deploy block.
  const evm = new EvmRpc(o.evm);
  const evmChainId = BigInt(await evm.call<string>("eth_chainId"));
  if (!check(evmChainId === V3.chainId, `the EVM RPC ${new URL(o.evm).host} serves chain ${evmChainId}`)) throw new Stop("the EVM RPC serves another chain");
  const head = Number(BigInt(await evm.call<string>("eth_blockNumber")));
  const tagV3 = qty(head);
  const vaultCode = hexToBytes(await evm.call<Hex>("eth_getCode", [vault.address, tagV3]));
  if (!check(bytesToHex(keccak_256(vaultCode)) === vault.codeHash, `the vault ${checksumAddress(hexToBytes(vault.address))} has the code ${V3_RECORD} recorded (code hash ${shortHex(vault.codeHash)})`)) {
    throw new Stop("the vault on V3 is not the recorded one");
  }
  const nextNonce = await evm.word(vault.address, SLOTS.nextNonce, tagV3);
  const outstanding = await evm.word(vault.address, SLOTS.outstanding, tagV3);
  log(`\nThe vault on V3 at block #${fmt(head)}: nextNonce ${nextNonce}, outstanding ${formatTpot(outstanding)}`);
  const found = await evm.logs({ address: vault.address, topics: [[LOCKED_TOPIC, RELEASED_TOPIC]] }, vault.block, head);
  let locked = 0n;
  let released = 0n;
  const releases = new Map<Hex, bigint>();
  let minted = 0;
  let ours = 0;
  /** A lock's line: its commitment recomputed from its fields and compared with storage, and whether this minter minted it. */
  const lockLine = async (e: { nonce: bigint; sender: Uint8Array | null; recipient: Uint8Array; dstChainId: bigint; dstMinter: Uint8Array; amountNative: bigint; commitment: Uint8Array }, where: string) => {
    locked += e.amountNative;
    const recomputed = lockCommitment({ v3ChainId: V3.chainId, vault: hexToBytes(vault.address), dstChainId: e.dstChainId, dstMinter: e.dstMinter, recipient: e.recipient, amountNative: e.amountNative, nonce: e.nonce });
    const stored = await evm.word(vault.address, commitmentSlot(e.nonce), tagV3);
    let state = "for another chain or minter";
    if (e.dstChainId === SEPOLIA_CHAIN_ID && bytesToHex(e.dstMinter) === bridge.minter) {
      ours += 1;
      if (!bridge.minterDeployed || !bridge.tokenDeployed) state = "for this minter, which is not deployed: not minted";
      else {
        const used = uintAt(await sepolia("used", () => view(bridge.minter, callData(MINTER.used, uintWord(e.nonce)), block.number)), 0) !== 0n;
        const balance = uintAt(await sepolia("balance", () => view(bridge.token, callData(TOKEN.balanceOf, addressWord(e.recipient)), block.number)), 0);
        if (used) minted += 1;
        state = `${used ? "MINTED" : "not minted"}; the recipient holds ${formatWtpot(balance)}`;
      }
    }
    check(
      equalBytes(recomputed, e.commitment) && stored === BigInt(bytesToHex(e.commitment)),
      `lock ${e.nonce} (${where}): ${formatTpot(e.amountNative)}${e.sender ? ` from ${checksumAddress(e.sender)}` : ""} for ${checksumAddress(e.recipient)} on chain ${e.dstChainId}, ` +
        `minter ${checksumAddress(e.dstMinter)}, commitment ${shortHex(e.commitment)} recomputed and in storage; ${state}`,
    );
  };
  let lockCount = 0;
  if ("refused" in found) {
    // The locks from storage: nextNonce, and each commitment against the fields the record has.
    log(`     the EVM RPC refuses eth_getLogs (${found.refused}): the locks from storage and ${V3_RECORD}, the releases from the burns`);
    for (let n = 0n; n < nextNonce; n++) {
      const l = vault.locks.find((x) => x.status === "locked" && x.vault === vault.address && x.vaultNonce === n.toString() && x.commitment);
      if (!l) {
        check(false, `lock ${n}: ${V3_RECORD} has no fields to recompute its commitment from`);
        continue;
      }
      const e = { nonce: n, sender: null, recipient: hexToBytes(l.recipient), dstChainId: BigInt(l.dstChainId), dstMinter: hexToBytes(l.dstMinter), amountNative: BigInt(l.amountNative), commitment: hexToBytes(l.commitment!) };
      await lockLine(e, `${V3_RECORD}, ${shortHex(l.txHash)}`);
      lockCount += 1;
    }
  } else {
    const lockNonces = new Set<bigint>();
    for (const l of found) {
      const where = `#${fmt(Number(BigInt(l.blockNumber ?? "0")))} ${shortHex(l.transactionHash ?? "0x")}`;
      if (l.topics[0]?.toLowerCase() === RELEASED_TOPIC) {
        const e = decodeReleased(l);
        released += e.amountNative;
        releases.set(bytesToHex(e.burnId), e.amountNative);
        log(`     release (${where}): ${formatTpot(e.amountNative)} to ${checksumAddress(e.to)}, burn id ${shortHex(e.burnId)} (the committee's, trusted)`);
        continue;
      }
      const e = decodeLocked(l);
      lockNonces.add(e.nonce);
      await lockLine(e, where);
      lockCount += 1;
    }
    check(BigInt(lockNonces.size) === nextNonce && [...lockNonces].every((x) => x < nextNonce), `one Locked log for each of the ${nextNonce} nonces`);
  }
  log(`     ${ours} of ${lockCount} lock${lockCount === 1 ? "" : "s"} for this minter, ${minted} minted`);

  // Sepolia: the mints and the burns, the start of the trusted return path; their logs in windows
  // from the minter's deploy block, or the views when the RPC refuses old logs.
  /** Released on V3 (released[burnId] set) with no Released log: the committee's releases are Substrate extrinsics, whose events V3's EVM RPC does not serve. */
  let releasedUnlogged = 0n;
  let unknownAmounts = 0;
  if (bridge.minterDeployed && bridge.tokenDeployed) {
    const fromBlock = record?.steps.find((s) => s.name === "BridgeMinter" && s.ok)?.block ?? 0;
    const minterLogs = await sepoliaLogs({ address: bridge.minter, topics: [[MINTED_TOPIC, BURN_REQUESTED_TOPIC]] }, fromBlock, Number(BigInt(block.number)));
    const releaseState = async (id: Uint8Array, amount: bigint | null) => {
      const flag = await evm.word(vault.address, releasedSlot(id), tagV3);
      if (flag === 0n) return "not released yet";
      const logged = releases.get(bytesToHex(id));
      if (logged !== undefined) return `released on V3 (${formatTpot(logged)}, its Released log)`;
      const recorded = vault.releases.find((r) => r.status === "released" && r.burn.burnId === bytesToHex(id));
      const value = amount ?? (recorded ? BigInt(recorded.amountNative) : null);
      if (value === null) unknownAmounts += 1;
      else releasedUnlogged += value;
      return `released on V3 (released[burnId] is set${recorded?.released ? `; ${V3_RECORD}: #${fmt(recorded.released.block.number)}, ${formatTpot(BigInt(recorded.amountNative))}` : ""}; the EVM RPC serves no Released log for it)`;
    };
    if ("refused" in minterLogs) {
      log(`\n${bridge.burnCount} burn${bridge.burnCount === 1n ? "" : "s"} on Sepolia, from burnCount and burnIdOf: the Sepolia RPC refuses eth_getLogs (${minterLogs.refused}) (the trusted return path: the committee releases on V3, which no contract here checks)`);
      for (let n = 0n; n < bridge.burnCount; n++) {
        const id = wordAt(await sepolia("burnIdOf", () => view(bridge.minter, callData(MINTER.burnIdOf, uintWord(n)), block.number)), 0);
        const recorded = record?.steps.find((s) => s.kind === "burn" && s.ok && s.burn?.burnNonce === n.toString());
        check(equalBytes(id, burnId(SEPOLIA_CHAIN_ID, hexToBytes(bridge.minter), n)), `burn ${n}: burn id ${shortHex(id)} (the vault's convention); ${await releaseState(id, recorded?.burn ? BigInt(recorded.burn.amount) : null)}`);
      }
      log("     without the logs, the total supply is not checked against the mints and the burns");
    } else {
      let mintedSum = 0n;
      let burnedSum = 0n;
      for (const l of minterLogs.filter((x) => x.topics[0]?.toLowerCase() === MINTED_TOPIC)) mintedSum += decodeMinted(l).amount;
      const burns = minterLogs.filter((x) => x.topics[0]?.toLowerCase() === BURN_REQUESTED_TOPIC);
      log(`\n${burns.length} burn${burns.length === 1 ? "" : "s"} on Sepolia (the trusted return path: the committee releases on V3, which no contract here checks)`);
      for (const l of burns) {
        const e = decodeBurnRequested(l);
        burnedSum += e.amount;
        const id = burnId(SEPOLIA_CHAIN_ID, hexToBytes(bridge.minter), e.burnNonce);
        check(
          equalBytes(id, e.burnId),
          `burn ${e.burnNonce} (${shortHex(l.transactionHash ?? "0x")}): ${formatWtpot(e.amount)} from ${checksumAddress(e.from)} for ${checksumAddress(e.v3Recipient)} on V3, ` +
            `burn id ${shortHex(e.burnId)} (the vault's convention); ${await releaseState(id, e.amount)}`,
        );
      }
      check(BigInt(burns.length) === bridge.burnCount, `burnCount() is the ${burns.length} BurnRequested event${burns.length === 1 ? "" : "s"}`);
      check(bridge.totalSupply === mintedSum - burnedSum, `wtPOT total supply = minted ${formatWtpot(mintedSum)} - burned ${formatWtpot(burnedSum)}`);
      const burnIds = new Set(burns.map((l) => bytesToHex(decodeBurnRequested(l).burnId)));
      for (const [id, amount] of releases) if (!burnIds.has(id)) check(false, `a Released log for burn id ${shortHex(id)} (${formatTpot(amount)}), which no burn on Sepolia has`);
    }
  }
  if (unknownAmounts > 0) log(`     note: ${unknownAmounts} release${unknownAmounts === 1 ? "" : "s"} of an unknown amount: outstanding is not checked against the locks`);
  else check(locked - released - releasedUnlogged === outstanding, `outstanding = locked ${formatTpot(locked)} - released ${formatTpot(released + releasedUnlogged)}${releasedUnlogged ? ` (${formatTpot(releasedUnlogged)} of it without a Released log)` : ""}`);
  return failures === 0 ? OK : FAILED;
}

// ---------------------------------------------------------------------------------------

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  // Every RPC client of this process refuses the write methods: a dry run cannot send, and --send
  // sends through cast publish alone.
  installDryRunGuard();
  switch (command) {
    case "bundle":
      return bundle(bundleOptions(args));
    case "plan":
    case "deploy":
    case "mint": {
      const o = planOptions(command, args);
      if (!o.send) log("(dry run: nothing is signed, and this process's RPC clients refuse eth_send*, eth_sign*, personal_* and author_submit*)");
      return planCommand(o);
    }
    case "status":
      return status(statusOptions(args));
    default:
      usage(command ? `unknown command ${JSON.stringify(command)}` : "no command");
  }
}

/**
 * True when this file is the process's entry (npm run mint), false when another tool imports it
 * for captureBundle (automint.ts): the command runs only then. Under tsx, process.argv[1] is the
 * entry file's path (import.meta.main is not set); compared as the file system resolves it.
 */
function isEntry(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const canonical = (path: string) => {
    let p = resolve(path);
    try {
      p = realpathSync(p);
    } catch {
      // as given
    }
    return process.platform === "win32" ? p.toLowerCase() : p;
  };
  return canonical(argv1) === canonical(fileURLToPath(import.meta.url));
}

if (isEntry()) main().then(
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
