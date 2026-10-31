// The V3 vault tool: deploys PortaldotVault on the Portaldot V3 testnet, locks tPOT in it with an
// Ethereum transaction or a Substrate extrinsic, and reads it back.
//
//   npm run v3-vault -- deploy --releaser <h160> [--committee-multisig <ss58>] [--from <ss58>]
//   npm run v3-vault -- deploy --releaser <h160> [--committee-multisig <ss58>] --send --key-file <path> [--from <ss58>]
//   npm run v3-vault -- lock --dst-chain <id> --dst-minter <h160> --recipient <h160> --amount <tPOT> [--from <h160> | --from <ss58>]
//   npm run v3-vault -- lock ... --send --account <keystore> --password-file <path>
//   npm run v3-vault -- lock ... --send --key-file <path> [--password-file <path>] [--from <ss58>]
//   npm run v3-vault -- status
//   more options: --rpc <wss url> (the V3 node), --evm <http(s) url> (its EVM RPC), --vault <h160>
//   (lock and status dry runs: a vault the record does not hold), --any-destination (lock: a chain
//   and minter no deployments/*-bridge.json records for the vault, with a warning),
//   --committee <ss58,ss58,...> and --threshold <n> (deploy: the members --committee-multisig is
//   derived from; by default the trusted return-path committee below, 2 of 3)
//
// deploy runs a dry run unless --send. It reads the vault's V3 build
// (contracts/out-v3/PortaldotVault.sol/PortaldotVault.json, from FOUNDRY_PROFILE=v3 forge build
// --skip test --skip script) and refuses one compiled from another source than the checkout's or
// without its settings. It checks the node's genesis hash and the chain id (pallet-revive's and the
// EVM RPC's), reads NativeToEthRatio live, and builds the creation code with the constructor
// arguments (ratio, --releaser) appended, as pallet-revive takes EVM constructor input. With
// --committee-multisig it derives that pallet-multisig account from the members and the threshold
// and requires reviveApi.address of it to be --releaser. It then has the EVM RPC run the
// constructor (eth_call), which must return the build's runtime code with both immutables filled in,
// and dry-runs reviveApi.instantiate from the deployer (--from, by default the testnet account
// 5ERJ…): no revert, the same runtime code, and the address CREATE gives the deployer's address at
// its nonce. It prints that address, the storage deposit, the weight, the fee (payment_queryInfo of
// the extrinsic) and the deployer's balance, and refuses unless the balance covers the deposit
// limit, the fee, the existential deposit and 1 tPOT.
// --send also reads --key-file (JSON with .substrate.mnemonic, sr25519, never printed), requires the
// account it derives to be the deployer, and refuses while deployments/v3-testnet.json holds a vault.
// It signs revive.instantiateWithCode with the dry run's weight plus 10% and its deposit plus 2% as
// limits, records the extrinsic hash and the expected address in deployments/v3-testnet.json, submits
// it and waits for finalization. The block must hold ExtrinsicSuccess and revive.Instantiated for
// that address; eth_getCode there must be the runtime code with the ratio and releaser in it (the
// vault has no getter for either). The record then gets the vault: address, deployer, extrinsic,
// block, code hash and size, the deposit charged (what left the deployer's free balance besides the
// fee), ratio, releaser, committee and the build's compiler settings. An extrinsic the node refuses
// or drops, or one final without ExtrinsicSuccess, moves to the record's failedDeploys, which lets
// a later run deploy again. Every write is atomic.
//
// lock runs a dry run unless --send, against the recorded vault (or --vault): its code must be the V3
// build, from which it reads the ratio and releaser. The lock commits to its destination, which only
// that chain's BridgeMinter can prove, and the vault never gives a lock back (it pays out against
// burns only): the dry run fails unless --dst-chain and --dst-minter are the chainId and
// contracts.BridgeMinter of a deployments/*-bridge.json whose vault is this one (--any-destination
// makes that a warning). It fails too for a recipient that is a Substrate account's address on V3
// (revive.originalAccount maps it to one, read from the node): no Ethereum key holds such an address,
// so wtPOT minted there could never move or be burned. From the sender (--from, by default the demo
// account 0xD983…1071) it runs lock(dstChain, dstMinter, recipient) with eth_call and
// eth_estimateGas, with the amount (tPOT, at most 14 decimals) times the ratio as value, and prints
// the nonce and the commitment the vault will store, the gas (on V3 it includes the storage deposit)
// and the fee at the node's gas price. It refuses dust, and a balance that does not cover the value
// and the gas limit at the max fee.
// --send unlocks the Foundry keystore (--account, --password-file; cast reads the password file, this
// script never does), settles what an earlier run left open in the record, and sends the lock as an
// Ethereum transaction the way contracts/script/lib/sepolia.mjs sends Sepolia transactions: cast mktx
// with the keystore, chain 420420777, the sender's next nonce, the estimate plus 10% as gas limit, and
// the node's gas price (eth_gasPrice, the base fee) plus one eighth as max fee with no priority fee,
// so it pays the base fee and a small rise of it does not leave it unmined; the hash (keccak of the
// raw transaction) is recorded before cast publish, and cast runs in an empty directory without
// ETH_* variables. It waits for the receipt, decodes Locked, recomputes the commitment from the
// event, and reads commitments(nonce) with eth_call and its slot with eth_getStorageAt; the lock is
// then completed in the record.
//
// lock from a Substrate account (--from <ss58> for the dry run, --send --key-file <path> to sign:
// the format deploy takes, .substrate.mnemonic, or a polkadot-js keystore with --password-file;
// neither is ever printed) sends the same lock as revive.call(vault, amount, weight limit, storage
// deposit limit, lock calldata), as the app's Portaldot Wallet path does: the value is the amount in
// native base units (msg.value is that times the ratio), and msg.sender is the account's address,
// keccak-256 of its account id (pallet-revive's AutoMap; reviveApi.address must say the same). It
// checks the destination and the recipient as the EVM lock does, and refuses that address, the
// account's own, as the recipient, mapped or not. It dry-runs the call with ReviveApi_call from the
// account (no error, no revert, the vault's next nonce returned) and takes its weight plus 10% and
// its storage deposit plus 2% as the limits; it prints the commitment, the fee (payment_queryInfo)
// and the deposit, and refuses a free balance that does not cover the amount, the deposit limit,
// the fee and the existential deposit. --send settles what an earlier run left signed, records the
// extrinsic's hash before it submits, waits for finality, and checks ExtrinsicSuccess, the vault's
// Locked event in System.Events (a Substrate extrinsic's event is not a log: eth_getLogs does not
// return it, which the tool shows), read with substrate-locks.ts as the EVM logs' parser reads a
// log, the commitment recomputed and in storage (commitments(nonce), and its slot in the vault's
// child trie at the block); the record gets the same fields as an EVM lock's, with the 5... sender
// and its address (from), the extrinsic's block and index, its fee and the deposit it paid.
//
// status reads the vault: nextNonce (slot 1), outstanding, its balance, every Locked and Released log
// (eth_getLogs from the deployment block), each Locked commitment recomputed and compared with the
// event and with storage, and the accounting (outstanding = locked - released, balance at least
// outstanding times the ratio, one Locked event per nonce). The committee's releases (release.ts) are
// Substrate extrinsics whose Released event the EVM RPC does not return as a log: the ones the
// record lists count once released[burnId] holds them. A lock sent as a Substrate extrinsic has no
// log either: a nonce below nextNonce without one is read from System.Events (substrate-locks.ts,
// at the block the record names, else found by a binary search) and counted like the others.
//
// Exit code 0 when the dry run passed, the transaction is done and checked, or status found nothing
// wrong; 1 when a check fails or the tool refuses; 2 when the node or the EVM RPC cannot be reached;
// 3 when a sent extrinsic or transaction is not final yet (the record says which).

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { keccak_256 } from "@noble/hashes/sha3.js";
import type { ApiPromise, Keyring } from "@polkadot/api";
// The static types of consts, storage, extrinsics and events (Substrate's pallets, close to V3's).
import type {} from "@polkadot/api/augment";
import type { SubmittableExtrinsic } from "@polkadot/api/types";
import type { KeyringPair$Json } from "@polkadot/keyring/types";
import type { EventRecord } from "@polkadot/types/interfaces";
import { connectWithin } from "./bridge.js";
import { bytesToHex, equalBytes, hexToBytes, shortHex, type Hex } from "./bytes.js";
import { blake2_256, systemAccountKey } from "./hash.js";
import { reviveOriginalAccountKey } from "./revive.js";
import { RpcClient } from "./rpc.js";
import { decodeAccountInfo } from "./scale.js";
import { findSubstrateLocks, firstBlockWhere, LookupError, logOfEvent, nodeReads, vaultEventsAt, vaultWordAt, type V3Reads } from "./substrate-locks.js";
import {
  bridgeDestination,
  checksumAddress,
  commitmentsCalldata,
  commitmentSlot,
  constructorArgs,
  createAddress,
  decodeLocked,
  decodeReleased,
  evmDecimals,
  fillImmutables,
  formatEvmTpot,
  formatTpot,
  LOCKED_TOPIC,
  lockCalldata,
  lockCommitment,
  multisigAccountId,
  outstandingCalldata,
  parseAddress,
  parseTpot,
  readImmutables,
  readVaultBuild,
  recipientProblem,
  releasedSlot,
  RELEASED_TOPIC,
  reviveAddress,
  SLOTS,
  uintWord,
  vaultError,
  type Destination,
  type LogJson,
  type VaultBuild,
} from "./vault.js";
import { cast, keystoreAddress, redact, redactAlso, sleep } from "../../contracts/script/lib/sepolia.mjs";
import { saveMerged } from "./records.js";

/** The Portaldot V3 testnet. */
const V3 = {
  title: "the Portaldot V3 testnet",
  rpc: "wss://test-node-v3.portaldot.dev",
  evm: "https://test-evm-rpc-v3.portaldot.dev",
  genesis: "0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd",
  chainId: 420_420_777n,
  ss58: 42,
} as const;

/** The testnet sr25519 account that deploys the vault, and the EVM account the demo locks from. */
const DEFAULT_DEPLOYER = "5ERJiUnzmQwEF98X3rGyKiNsyjrcenLGJST3MULCjUSwgPJ7";
const DEFAULT_LOCKER = "0xD9838A86cF83C28Ee486544060D1cA4Ca2971071";

/** The return-path committee (trusted): a pallet-multisig account, 2 of these 3 members. */
const COMMITTEE = {
  members: ["5DLnLMAsR3kkHnHndC4eRWhMFXPjCU8bGiSugCjUmGJaBism", "5F99Y91UgQ4EDTubPWWPvWKc3ghhVA77nc7HjRhsTyXn38z9", "5EJJYKuM5aaKwgegKGinAbnL7dK3m3QziyqusPotTQ3S7w1E"],
  threshold: 2,
};

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ARTIFACT = "contracts/out-v3/PortaldotVault.sol/PortaldotVault.json";
const RECORD = "deployments/v3-testnet.json";
const at = (path: string) => resolve(ROOT, path);

/** The size the vault's runtime code is meant to stay within (every byte costs a storage deposit). */
const SIZE_BUDGET = 900;
/** What the deployer keeps beyond the deposit limit, the fee and the existential deposit. */
const BALANCE_MARGIN = 10n ** 14n;
/** How long a sent extrinsic waits for finalization and a sent transaction for its receipt. */
const FINAL_TIMEOUT = 10 * 60_000;
const RECEIPT_TIMEOUT = 10 * 60_000;
const CONNECT_TIMEOUT = 60_000;

const OK = 0;
const FAILED = 1;
const UNREACHABLE = 2;
const PENDING = 3;

const log = (message = "") => console.log(message);
const errorText = (error: unknown) => redact(error instanceof Error ? error.message : String(error));
const fmt = (n: number | bigint) => n.toLocaleString("en-US");

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

/** The node or the EVM RPC did not answer: exit code 2. */
class Unreachable extends Error {
  override name = "Unreachable";
}

/** A command line the tool does not take: exit code 1, with the usage. */
class Usage extends Stop {
  override name = "Usage";
}

/**
 * @polkadot/api, loaded by deploy and the lock from a Substrate account only: the EVM lock and
 * status read the node with rpc.ts (withNodeReads), and the EVM RPC otherwise. Loading it starts
 * its WebAssembly crypto in the background, and an exit in the middle of that can abort the
 * process on Windows, so the tool never calls process.exit: it sets the exit code and returns.
 */
const polkadot = () => import("@polkadot/api");

// ---------------------------------------------------------------------------------------
// Options

const USAGE = `usage (from relayer/):
  npm run v3-vault -- deploy --releaser <h160> [--committee-multisig <ss58>] [--from <ss58>] [--send --key-file <path>]
  npm run v3-vault -- lock --dst-chain <id> --dst-minter <h160> --recipient <h160> --amount <tPOT> [--from <h160>]
                          [--send --account <keystore> --password-file <path>]
  npm run v3-vault -- lock ... --from <ss58> | --send --key-file <path> [--password-file <path>] [--from <ss58>]
                          (from a Substrate account: revive.call)
  npm run v3-vault -- status
  more options: --rpc <wss url>, --evm <http(s) url>, --vault <h160> (lock and status dry runs),
    --any-destination (lock: a chain and minter deployments/*-bridge.json do not record for the vault),
    --committee <ss58,ss58,...> and --threshold <n> (deploy, with --committee-multisig)`;

function usage(problem: string): never {
  throw new Usage(problem);
}

interface Common {
  rpc: string;
  evm: string;
}

interface DeployOptions extends Common {
  releaser: Uint8Array;
  committeeMultisig?: string;
  committee: string[];
  threshold: number;
  from: string;
  send: boolean;
  keyFile?: string;
}

interface LockOptions extends Common {
  dstChainId: bigint;
  dstMinter: Uint8Array;
  /** --any-destination: a destination deployments/ does not record for the vault is a WARN, not a failed check. */
  anyDestination: boolean;
  recipient: Uint8Array;
  amountNative: bigint;
  amountText: string;
  from?: Uint8Array;
  /** --from <ss58>: a Substrate account, which locks with revive.call. */
  fromSs58?: string;
  /** --key-file: the Substrate account's key, for --send (revive.call). */
  keyFile?: string;
  vault?: Uint8Array;
  send: boolean;
  account?: string;
  passwordFile?: string;
}

interface StatusOptions extends Common {
  vault?: Uint8Array;
}

/** Wraps a parse error of one option into the usage message. */
function option<T>(what: string, parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    usage(`${what}: ${errorText(error)}`);
  }
}

/** A positive whole number written as digits only. */
function positiveInteger(text: string, what: string): bigint {
  if (!/^\d+$/.test(text)) throw new Error(`${what} must be a whole number, got ${JSON.stringify(text)}`);
  const value = BigInt(text);
  if (value === 0n || value >= 1n << 256n) throw new Error(`${what} must be between 1 and 2^256 - 1`);
  return value;
}

function nonZeroAddress(text: string, what: string): Uint8Array {
  const address = parseAddress(text, what);
  if (address.every((b) => b === 0)) throw new Error(`${what} is the zero address`);
  return address;
}

function parseCommon(values: { rpc?: string; evm?: string }): Common {
  const rpc = values.rpc ?? V3.rpc;
  const evm = values.evm ?? V3.evm;
  if (!/^wss?:\/\//i.test(rpc) || !URL.canParse(rpc)) usage("--rpc must be a ws:// or wss:// URL");
  if (!/^https?:\/\//i.test(evm) || !URL.canParse(evm)) usage("--evm must be an http:// or https:// URL");
  // Only the host of a custom URL is printed; it can carry a key.
  redactAlso(rpc === V3.rpc ? undefined : rpc, evm === V3.evm ? undefined : evm);
  return { rpc, evm };
}

function parse(args: string[], options: NonNullable<ParseArgsConfig["options"]>) {
  try {
    return parseArgs({ args, options, strict: true, allowPositionals: false }).values as Record<string, string | boolean | undefined>;
  } catch (error) {
    usage(errorText(error));
  }
}

const str = (v: string | boolean | undefined) => (typeof v === "string" ? v : undefined);

function deployOptions(args: string[]): DeployOptions {
  const v = parse(args, {
    releaser: { type: "string" },
    "committee-multisig": { type: "string" },
    committee: { type: "string" },
    threshold: { type: "string" },
    from: { type: "string" },
    send: { type: "boolean", default: false },
    "key-file": { type: "string" },
    rpc: { type: "string" },
    evm: { type: "string" },
  });
  const releaserText = str(v.releaser);
  if (!releaserText) usage("deploy needs --releaser <h160>: the committee multisig's address (reviveApi.address of it)");
  const releaser = option("--releaser", () => nonZeroAddress(releaserText, "--releaser"));
  const send = v.send === true;
  const keyFile = str(v["key-file"]);
  if (send && !keyFile) usage("--send needs --key-file <path> (JSON with .substrate.mnemonic)");
  if (!send && keyFile) usage("--key-file is for --send; a dry run signs nothing");
  // The key file is opened only to sign; its path is not printed either.
  const keyPath = keyFile === undefined ? undefined : resolve(keyFile);
  redactAlso(keyPath, keyFile);
  if (keyPath && !existsSync(keyPath)) usage("--key-file: no such file");
  const committeeText = str(v.committee);
  const thresholdText = str(v.threshold);
  if ((committeeText || thresholdText) && !str(v["committee-multisig"])) usage("--committee and --threshold describe --committee-multisig, which is missing");
  const committee = committeeText ? committeeText.split(",").map((s) => s.trim()) : COMMITTEE.members;
  const threshold = thresholdText === undefined ? COMMITTEE.threshold : Number(option("--threshold", () => positiveInteger(thresholdText, "--threshold")));
  return {
    ...parseCommon({ rpc: str(v.rpc), evm: str(v.evm) }),
    releaser,
    committeeMultisig: str(v["committee-multisig"]),
    committee,
    threshold,
    from: str(v.from) ?? DEFAULT_DEPLOYER,
    send,
    keyFile: keyPath,
  };
}

function lockOptions(args: string[]): LockOptions {
  const v = parse(args, {
    "dst-chain": { type: "string" },
    "dst-minter": { type: "string" },
    "any-destination": { type: "boolean", default: false },
    recipient: { type: "string" },
    amount: { type: "string" },
    from: { type: "string" },
    vault: { type: "string" },
    send: { type: "boolean", default: false },
    account: { type: "string" },
    "password-file": { type: "string" },
    "key-file": { type: "string" },
    rpc: { type: "string" },
    evm: { type: "string" },
  });
  const dst = str(v["dst-chain"]);
  const minter = str(v["dst-minter"]);
  const to = str(v.recipient);
  const amount = str(v.amount);
  if (!dst || !minter || !to || !amount) usage("lock needs --dst-chain, --dst-minter, --recipient and --amount");
  const send = v.send === true;
  const account = str(v.account);
  const passwordText = str(v["password-file"]);
  const keyText = str(v["key-file"]);
  if (keyText !== undefined && account !== undefined) usage("choose one of --account (an Ethereum keystore: an EVM lock) and --key-file (a Substrate account: revive.call)");
  if (keyText !== undefined && !send) usage("--key-file is for --send; a dry run from a Substrate account takes --from <ss58>");
  if (send && keyText === undefined && !(account && passwordText)) usage("--send needs --account <keystore name> and --password-file <path>, or --key-file <path> (a Substrate account)");
  if (!send && (account || passwordText)) usage("--account and --password-file are for --send; a dry run signs nothing");
  if (send && str(v.vault)) usage("--vault is for a dry run: --send locks only in the vault deployments/v3-testnet.json records");
  // cast runs in a directory of its own: the path is made absolute here (this script never opens it).
  const passwordFile = passwordText === undefined ? undefined : resolve(passwordText);
  redactAlso(passwordFile, passwordText);
  if (passwordFile && !existsSync(passwordFile)) usage("--password-file: no such file");
  // The key file is opened only to sign; its path is not printed either.
  const keyFile = keyText === undefined ? undefined : resolve(keyText);
  redactAlso(keyFile, keyText);
  if (keyFile && !existsSync(keyFile)) usage("--key-file: no such file");
  const fromText = str(v.from);
  const evmFrom = fromText !== undefined && /^0x/i.test(fromText);
  if (fromText !== undefined && !evmFrom && account !== undefined) usage("--from <ss58> is a Substrate account, which signs with --key-file, not --account");
  if (evmFrom && keyFile !== undefined) usage("--key-file signs for a Substrate account: --from takes its ss58 address");
  const vaultText = str(v.vault);
  return {
    ...parseCommon({ rpc: str(v.rpc), evm: str(v.evm) }),
    dstChainId: option("--dst-chain", () => positiveInteger(dst, "--dst-chain")),
    dstMinter: option("--dst-minter", () => nonZeroAddress(minter, "--dst-minter")),
    anyDestination: v["any-destination"] === true,
    recipient: option("--recipient", () => nonZeroAddress(to, "--recipient")),
    amountNative: option("--amount", () => parseTpot(amount)),
    amountText: amount,
    from: evmFrom ? option("--from", () => parseAddress(fromText, "--from")) : undefined,
    fromSs58: fromText !== undefined && !evmFrom ? fromText : undefined,
    keyFile,
    vault: vaultText === undefined ? undefined : option("--vault", () => nonZeroAddress(vaultText, "--vault")),
    send,
    account,
    passwordFile,
  };
}

function statusOptions(args: string[]): StatusOptions {
  const v = parse(args, { vault: { type: "string" }, rpc: { type: "string" }, evm: { type: "string" } });
  const vaultText = str(v.vault);
  return {
    ...parseCommon({ rpc: str(v.rpc), evm: str(v.evm) }),
    vault: vaultText === undefined ? undefined : option("--vault", () => nonZeroAddress(vaultText, "--vault")),
  };
}

// ---------------------------------------------------------------------------------------
// The record (deployments/v3-testnet.json)

interface VaultEntry {
  /** submitted: signed and sent, not seen final yet. deployed: final and checked. failed: final without ExtrinsicSuccess. */
  status: "submitted" | "deployed" | "failed";
  address: Hex;
  deployer: { ss58: string; address: Hex; nonce: number };
  extrinsicHash: Hex;
  signedAt: string;
  block: { number: number; hash: Hex } | null;
  codeHash: Hex | null;
  runtimeBytes: number;
  /** In native base units: the dry run's deposit and limit, and what the extrinsic charged. */
  deposit: { dryRun: string; limit: string; charged: string | null };
  fee: string | null;
  weightLimit: { refTime: string; proofSize: string };
  nativeToEthRatio: string;
  releaser: Hex;
  committee: { multisig: string; accountId: Hex; members: string[]; threshold: number; trust: string } | null;
  build: {
    artifact: string;
    compiler: string;
    evmVersion: string;
    viaIR: boolean;
    optimizer: { enabled: boolean; runs: number };
    appendCBOR: boolean;
    source: string;
    sourceKeccak: Hex;
    initcodeHash: Hex;
  };
  git: { commit: string | null; dirty: boolean | null };
  note?: string;
}

interface LockEntry {
  /**
   * signed: recorded before cast publish (or, from a Substrate account, before it is submitted).
   * locked: mined (final) and checked. failed: mined, reverted or not as expected. dropped: never mined.
   */
  status: "signed" | "locked" | "failed" | "dropped";
  /** The Ethereum transaction's hash, or the extrinsic's (blake2_256) for a lock sent with revive.call. */
  txHash: Hex;
  /** The lock's sender as the vault sees it (msg.sender): the Ethereum key's address, or the Substrate account's (keccak-256 of its id). */
  from: Hex;
  /** The sender's account nonce. */
  nonce: number;
  vault: Hex;
  dstChainId: string;
  dstMinter: Hex;
  recipient: Hex;
  amountNative: string;
  /** msg.value, in EVM units: amountNative times the ratio. */
  value: string;
  /** An EVM lock's gas limit, the node's gas price when signed (the base fee), and the max fee per gas signed (no priority fee). */
  gasLimit?: string;
  gasPrice?: string;
  maxFee?: string;
  /** What the dry run expected; another lock mined first takes its nonce. */
  expected: { vaultNonce: string; commitment: Hex };
  signedAt: string;
  /** Its block: an EVM lock's as the EVM RPC names it, a Substrate extrinsic's by its Substrate hash. */
  block?: { number: number; hash: Hex };
  gasUsed?: string;
  effectiveGasPrice?: string;
  /** In EVM units, what the lock cost besides its value: the fee and the storage deposit (gasUsed x effectiveGasPrice for an EVM lock). */
  cost?: string;
  vaultNonce?: string;
  commitment?: Hex;
  slot?: Hex;
  /** A lock sent from a Substrate account with revive.call: its account, the limits, the dry run's needs, and once final its extrinsic's index, fee and deposit (native base units). */
  via?: "substrate";
  substrate?: { ss58: string; accountId: Hex };
  weightLimit?: { refTime: string; proofSize: string };
  storageDepositLimit?: string;
  dryRun?: { refTime: string; proofSize: string; storageDeposit: string };
  /** V3's finalized head when it was signed: the extrinsic is in a later block. */
  submittedAfter?: number;
  extrinsicIndex?: number;
  fee?: string;
  deposit?: string;
  /** Whether eth_getLogs returned its Locked log when it was checked (a Substrate extrinsic's event is not a log). */
  lockedLog?: "eth_getLogs" | "not served";
  note?: string;
}

interface VaultRecord {
  network: "portaldot-v3-testnet";
  genesisHash: string;
  chainId: number;
  vault: VaultEntry | null;
  /** Deploy extrinsics that were final without ExtrinsicSuccess: they used a nonce and paid a fee, and left no vault. */
  failedDeploys?: VaultEntry[];
  locks: LockEntry[];
  /** The committee's release rounds (release.ts), as far as status reads them. */
  releases?: { status: string; burn: { burnNonce: string; burnId: Hex }; payee: Hex; amountNative: string; released?: { block: { number: number } } }[];
}

function readRecord(): VaultRecord | null {
  const path = at(RECORD);
  if (!existsSync(path)) return null;
  let record: VaultRecord;
  try {
    record = JSON.parse(readFileSync(path, "utf8")) as VaultRecord;
  } catch (error) {
    throw new Stop(`${RECORD}: ${errorText(error)}`);
  }
  if (record.network !== "portaldot-v3-testnet" || record.genesisHash !== V3.genesis || BigInt(record.chainId) !== V3.chainId || !Array.isArray(record.locks)) {
    throw new Stop(`${RECORD} is not a record of ${V3.title} (genesis ${V3.genesis})`);
  }
  return record;
}

/**
 * Saves the record: under deployments/v3-testnet.json.lock, the file read again and merged into
 * `record` (records.ts mergeV3Record: the releases and transfers release.ts added or settled since
 * are kept), then written atomically. The vault is this tool's.
 */
function saveRecord(record: VaultRecord): void {
  try {
    saveMerged(at(RECORD), record, { vault: "mine" });
  } catch (error) {
    throw new Stop(`${RECORD} could not be written: ${errorText(error)}`);
  }
}

const emptyRecord = (): VaultRecord => ({ network: "portaldot-v3-testnet", genesisHash: V3.genesis, chainId: Number(V3.chainId), vault: null, locks: [] });

function gitState(): { commit: string | null; dirty: boolean | null } {
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return { commit: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain") !== "" };
  } catch {
    return { commit: null, dirty: null };
  }
}

// ---------------------------------------------------------------------------------------
// The V3 build

/** The vault's V3 build, refused unless it was compiled from the checkout's source with the V3 settings. */
function readBuild(): VaultBuild {
  const path = at(ARTIFACT);
  if (!existsSync(path)) throw new Stop(`no ${ARTIFACT}: build it in contracts/ with FOUNDRY_PROFILE=v3 forge build --skip test --skip script`);
  let build: VaultBuild;
  try {
    build = readVaultBuild(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    throw new Stop(`${ARTIFACT}: ${errorText(error)}`);
  }
  const source = at(`contracts/${build.sourcePath}`);
  const current = existsSync(source) ? bytesToHex(keccak_256(readFileSync(source))) : null;
  const what =
    `Build: ${ARTIFACT}, ${fmt(build.runtime.length)} bytes of runtime code (budget ${SIZE_BUDGET}), solc ${build.compiler}, ` +
    `${build.evmVersion}, ${build.viaIR ? "IR pipeline" : "legacy pipeline"}, ${build.appendCBOR ? "with" : "no"} CBOR metadata`;
  log(what);
  if (!check(current === build.sourceKeccak, `the build is from the current contracts/${build.sourcePath}`)) {
    throw new Stop(`${ARTIFACT} is older than contracts/${build.sourcePath}: rebuild it with FOUNDRY_PROFILE=v3`);
  }
  if (!check(build.evmVersion === "cancun" && build.compiler.startsWith("0.8.27+"), "solc 0.8.27 for cancun, the V3 profile")) {
    throw new Stop(`${ARTIFACT} is not the V3 profile's build`);
  }
  if (build.runtime.length > SIZE_BUDGET) log(`WARN the runtime code is ${fmt(build.runtime.length - SIZE_BUDGET)} bytes over the budget`);
  return build;
}

// ---------------------------------------------------------------------------------------
// Chain access

/** The EVM RPC answered with an error (the request arrived and was refused, or the call reverted). */
class EvmRpcError extends Error {
  override name = "EvmRpcError";

  constructor(
    readonly method: string,
    message: string,
    readonly code: number | undefined,
    readonly data: unknown,
  ) {
    super(`${method}: ${message}${code === undefined ? "" : ` (code ${code})`}`);
  }

  /** The revert data of a call that reverted, if the error carries it. */
  get revertData(): Uint8Array | null {
    return typeof this.data === "string" && /^0x([0-9a-fA-F]{2})*$/.test(this.data) ? hexToBytes(this.data) : null;
  }
}

/** Ethereum JSON-RPC over HTTP; a request that gets no answer is tried 3 times, then it is Unreachable. */
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
        const body = (await response.json()) as { result?: T; error?: { code?: number; message?: string; data?: unknown } };
        if (body.error) throw new EvmRpcError(method, body.error.message ?? "error", body.error.code, body.error.data);
        if (body.result === undefined) throw new Error("a response without a result");
        return body.result;
      } catch (error) {
        if (error instanceof EvmRpcError) throw error;
        if (attempt === 3) throw new Unreachable(`the EVM RPC ${new URL(this.url).host} is unreachable (${method}: ${errorText(error)})`);
        await sleep(2_000);
      }
    }
  }

  async chainId(): Promise<bigint> {
    return BigInt(await this.call<string>("eth_chainId"));
  }

  async code(address: Uint8Array, block = "latest"): Promise<Uint8Array> {
    return hexToBytes(await this.call<string>("eth_getCode", [bytesToHex(address), block]));
  }

  async word(address: Uint8Array, slot: Uint8Array | bigint, block = "latest"): Promise<bigint> {
    const position = typeof slot === "bigint" ? `0x${slot.toString(16)}` : `0x${BigInt(bytesToHex(slot)).toString(16)}`;
    const value = await this.call<string>("eth_getStorageAt", [bytesToHex(address), position, block]);
    return value === "0x" ? 0n : BigInt(value);
  }

  async balance(address: Uint8Array, block = "latest"): Promise<bigint> {
    return BigInt(await this.call<string>("eth_getBalance", [bytesToHex(address), block]));
  }
}

/**
 * Connects to the V3 node, or throws Unreachable after CONNECT_TIMEOUT (bridge.ts connectWithin:
 * the provider is disconnected then, and so is a connection made later).
 */
async function connectV3(url: string): Promise<ApiPromise> {
  const { ApiPromise, WsProvider } = await polkadot();
  const provider = new WsProvider(url, 2_500, {}, 60_000);
  try {
    return await connectWithin(
      () =>
        ApiPromise.create({
          provider,
          noInitWarn: true,
          // Two transaction extensions polkadot-js does not know; in V3's metadata both are empty
          // structs with no implicit data, so they add nothing to the extrinsic or what it signs.
          signedExtensions: { AuthorizeCall: { extrinsic: {}, payload: {} }, EthSetOrigin: { extrinsic: {}, payload: {} } },
        }),
      provider,
      CONNECT_TIMEOUT,
    );
  } catch (error) {
    throw new Unreachable(`the V3 node ${new URL(url).host} is unreachable (${errorText(error)})`);
  }
}

/** The node's identity: refuses another chain than the V3 testnet. */
async function checkChain(api: ApiPromise, evm: EvmRpc): Promise<void> {
  const genesis = api.genesisHash.toHex();
  const version = `${api.runtimeVersion.specName.toString()} ${api.runtimeVersion.specVersion.toNumber()}`;
  if (!check(genesis === V3.genesis, `genesis ${shortHex(genesis)} is ${V3.title}'s (${api.runtimeChain.toString()}, ${version})`)) {
    throw new Stop(`the node serves genesis ${genesis}, not ${V3.title} (a reset testnet?)`);
  }
  const reviveChainId = api.consts.revive.chainId.toBigInt();
  const evmChainId = await evm.chainId();
  if (!check(reviveChainId === V3.chainId && evmChainId === V3.chainId, `chain id ${V3.chainId} (pallet-revive ${reviveChainId}, EVM RPC ${evmChainId})`)) {
    throw new Stop("the chain id is not V3's");
  }
}

/** A constant the static types of @polkadot/api do not list. */
const constOf = (api: ApiPromise, pallet: string, name: string): string =>
  String((api.consts as unknown as Record<string, Record<string, { toString(): string } | undefined>>)[pallet]?.[name] ?? "");

/** What the tool reads of reviveApi.instantiate, from its JSON form (V3's result type is newer than the static types). */
interface InstantiateDryRun {
  refTime: bigint;
  proofSize: bigint;
  /** Positive: charged; negative: refunded. */
  deposit: bigint;
  ok: { address: Uint8Array; reverted: boolean; data: Uint8Array } | null;
  error: string | null;
}

function readInstantiate(api: ApiPromise, json: unknown): InstantiateDryRun {
  const r = json as {
    weightRequired?: { refTime?: number | string; proofSize?: number | string };
    storageDeposit?: { charge?: number | string; refund?: number | string };
    result?: { ok?: { result?: { flags?: { bits?: number }; data?: string }; addr?: string }; err?: unknown };
  };
  if (!r.weightRequired || !r.storageDeposit || !r.result) throw new Error(`reviveApi.instantiate returned an unexpected result: ${JSON.stringify(json).slice(0, 200)}`);
  const deposit = r.storageDeposit.charge !== undefined ? BigInt(r.storageDeposit.charge) : -BigInt(r.storageDeposit.refund ?? 0);
  let error: string | null = null;
  if (r.result.err !== undefined) {
    const module = (r.result.err as { module?: { index: number; error: string } }).module;
    if (module) {
      // A module error by its pallet index and the first byte of its error code.
      const meta = api.registry.findMetaError(Uint8Array.of(module.index, hexToBytes(module.error)[0]));
      error = `${meta.section}.${meta.name}: ${meta.docs.join(" ")}`;
    } else error = JSON.stringify(r.result.err);
  }
  const ok = r.result.ok;
  return {
    refTime: BigInt(r.weightRequired.refTime ?? 0),
    proofSize: BigInt(r.weightRequired.proofSize ?? 0),
    deposit,
    ok: ok ? { address: hexToBytes(ok.addr ?? "0x"), reverted: ((ok.result?.flags?.bits ?? 0) & 1) === 1, data: hexToBytes(ok.result?.data ?? "0x") } : null,
    error,
  };
}

// ---------------------------------------------------------------------------------------
// deploy

type Pair = ReturnType<Keyring["addFromMnemonic"]>;

/**
 * The sr25519 pair of the key file's .substrate.mnemonic, refused unless it is `expected`. Neither
 * the mnemonic nor any part of the file is printed, and errors are reported without their text
 * (a JSON parse error quotes the input).
 */
function loadKey(path: string, expected: string, keyring: Keyring): Pair {
  let mnemonic: unknown;
  try {
    mnemonic = (JSON.parse(readFileSync(path, "utf8")) as { substrate?: { mnemonic?: unknown } }).substrate?.mnemonic;
  } catch {
    throw new Stop("--key-file could not be read as JSON");
  }
  const pair = pairFromMnemonic(mnemonic, keyring);
  if (!check(pair.address === expected, `the key file's account (sr25519) is the deployer ${expected}`)) {
    throw new Stop(`the key file's mnemonic derives ${pair.address}, not ${expected}`);
  }
  return pair;
}

/** The sr25519 pair of a key file's .substrate.mnemonic; never printed, and errors without its text. */
function pairFromMnemonic(mnemonic: unknown, keyring: Keyring): Pair {
  if (typeof mnemonic !== "string" || mnemonic.trim() === "") throw new Stop("--key-file has no .substrate.mnemonic");
  // polkadot-js takes a phrase of another length as a raw seed; only a BIP-39 phrase is accepted here.
  const words = mnemonic.trim().split(/\s+/);
  if (![12, 15, 18, 21, 24].includes(words.length)) throw new Stop("the .substrate.mnemonic in --key-file is not a phrase of 12, 15, 18, 21 or 24 words");
  try {
    return keyring.addFromMnemonic(words.join(" "));
  } catch {
    throw new Stop("the .substrate.mnemonic in --key-file is not a valid BIP-39 phrase");
  }
}

/**
 * The pair a Substrate lock signs with: a key file in deploy's format (.substrate.mnemonic, which
 * takes no password file), or a polkadot-js keystore decoded with --password-file (its content less
 * one trailing line end). Neither the key, the mnemonic nor the password is printed, and errors are
 * reported without their text (a JSON parse error quotes the input).
 */
function loadLockKey(path: string, passwordFile: string | undefined, keyring: Keyring): Pair {
  let json: { substrate?: { mnemonic?: unknown }; encoded?: unknown };
  try {
    json = JSON.parse(readFileSync(path, "utf8")) as typeof json;
  } catch {
    throw new Stop("--key-file could not be read as JSON");
  }
  if (json?.substrate?.mnemonic !== undefined) {
    if (passwordFile !== undefined) throw new Stop("--key-file holds a mnemonic (.substrate.mnemonic), which takes no --password-file");
    return pairFromMnemonic(json.substrate.mnemonic, keyring);
  }
  if (typeof json?.encoded !== "string") throw new Stop("--key-file holds neither .substrate.mnemonic nor a polkadot-js keystore");
  if (passwordFile === undefined) throw new Stop("--key-file is a polkadot-js keystore: it needs --password-file");
  let pair: Pair;
  try {
    pair = keyring.addFromJson(json as unknown as KeyringPair$Json);
  } catch {
    throw new Stop("--key-file is not a polkadot-js keystore polkadot-js can read");
  }
  let password: string;
  try {
    password = readFileSync(passwordFile, "utf8").replace(/\r?\n$/, "");
  } catch {
    throw new Stop("--password-file could not be read");
  }
  try {
    pair.decodePkcs8(password);
  } catch {
    throw new Stop("--password-file does not open --key-file");
  }
  return pair;
}

async function deploy(o: DeployOptions): Promise<number> {
  log(`${new Date().toISOString()}: deploying PortaldotVault on ${V3.title}${o.send ? "" : " (dry run)"}`);
  const build = readBuild();
  const record = readRecord();
  if (record?.vault) {
    const what = `${RECORD} already holds a vault (${record.vault.status}) at ${record.vault.address}`;
    if (o.send) throw new Stop(`${what}: a second one is not deployed over it`);
    log(`     note: ${what}; --send would refuse`);
  }
  const { Keyring } = await polkadot();
  const keyring = new Keyring({ type: "sr25519", ss58Format: V3.ss58 });
  const from = option("--from", () => keyring.encodeAddress(keyring.decodeAddress(o.from), V3.ss58));
  const pair = o.send ? loadKey(o.keyFile!, from, keyring) : null;

  const evm = new EvmRpc(o.evm);
  const api = await connectV3(o.rpc);
  try {
    log(`V3 node ${new URL(o.rpc).host}, EVM RPC ${new URL(o.evm).host}`);
    await checkChain(api, evm);
    if (!check(constOf(api, "revive", "allowEVMBytecode") === "true", "pallet-revive takes EVM bytecode (AllowEVMBytecode)")) {
      throw new Stop("this runtime does not take EVM bytecode");
    }
    const ratio = api.consts.revive.nativeToEthRatio.toBigInt();
    const ed = api.consts.balances.existentialDeposit.toBigInt();
    if (ratio === 0n) throw new Stop("NativeToEthRatio is zero");
    log(`     NativeToEthRatio ${ratio} (read live): EVM values have ${evmDecimals(ratio)} decimals; existential deposit ${formatTpot(ed)}`);

    // The releaser, and the committee it stands for.
    const releaser = o.releaser;
    let committee: VaultEntry["committee"] = null;
    if (o.committeeMultisig) {
      const members = o.committee.map((m) => option("--committee", () => keyring.decodeAddress(m)));
      const accountId = option("--committee-multisig", () => keyring.decodeAddress(o.committeeMultisig!));
      const derived = option("--threshold", () => multisigAccountId(members, o.threshold));
      const names = o.committee.map((m) => keyring.encodeAddress(keyring.decodeAddress(m), V3.ss58));
      if (!check(equalBytes(derived, accountId), `${o.committeeMultisig} is the ${o.threshold}-of-${members.length} multisig of ${names.join(", ")}`)) {
        throw new Stop(`the multisig of those members and threshold is ${keyring.encodeAddress(derived, V3.ss58)}`);
      }
      const mapped = hexToBytes((await api.call.reviveApi.address(accountId)).toHex());
      if (!check(equalBytes(mapped, releaser), `reviveApi.address(${o.committeeMultisig}) is the releaser ${checksumAddress(releaser)}`)) {
        throw new Stop(`the multisig's address is ${checksumAddress(mapped)}, not --releaser`);
      }
      if (!equalBytes(reviveAddress(accountId), mapped)) throw new Stop("reviveApi.address disagrees with pallet-revive's mapping as vault.ts computes it");
      committee = {
        multisig: keyring.encodeAddress(accountId, V3.ss58),
        accountId: bytesToHex(accountId),
        members: names,
        threshold: o.threshold,
        trust: `trusted: any ${o.threshold} of the ${members.length} members can release up to the vault's outstanding amount`,
      };
    } else {
      log("WARN no --committee-multisig: the releaser is not checked against the committee, and the record will name no committee");
    }

    // The deployer.
    const deployerId = keyring.decodeAddress(from);
    const deployer = hexToBytes((await api.call.reviveApi.address(deployerId)).toHex());
    if (!equalBytes(deployer, reviveAddress(deployerId))) throw new Stop("reviveApi.address disagrees with pallet-revive's mapping as vault.ts computes it");
    const original = await api.query.revive.originalAccount(deployer);
    const account = await api.query.system.account(from);
    const free = account.data.free.toBigInt();
    const nonce = (await api.rpc.system.accountNextIndex(from)).toBigInt();
    log(
      `     deployer ${from} (address ${checksumAddress(deployer)}, ${original.isSome ? "mapped" : "not mapped"}), ` +
        `nonce ${nonce}, free ${formatTpot(free)}`,
    );

    // The code the vault will have, as V3 runs its constructor.
    const initcode = new Uint8Array([...build.initcode, ...constructorArgs(ratio, releaser)]);
    const runtime = fillImmutables(build, ratio, releaser);
    const created = hexToBytes(await evm.call<string>("eth_call", [{ from: bytesToHex(deployer), data: bytesToHex(initcode) }, "latest"]));
    check(equalBytes(created, runtime), "the constructor run with eth_call returns the build's runtime code with the ratio and the releaser in it");

    // The dry run.
    const dryJson = (await api.call.reviveApi.instantiate(from, 0, null, null, { Upload: bytesToHex(initcode) }, "0x", null)).toJSON();
    const dry = readInstantiate(api, dryJson);
    if (!dry.ok) {
      check(false, `reviveApi.instantiate dry run: ${dry.error}`);
      return FAILED;
    }
    const expected = createAddress(deployer, nonce);
    check(!dry.ok.reverted, "reviveApi.instantiate dry run: the constructor does not revert");
    check(equalBytes(dry.ok.data, runtime), "the dry run returns the same runtime code");
    check(
      equalBytes(dry.ok.address, expected),
      `the vault would be ${checksumAddress(dry.ok.address)}, the CREATE address of ${checksumAddress(deployer)} at nonce ${nonce}`,
    );
    if (dry.deposit <= 0n) throw new Stop(`the dry run charges no storage deposit (${dry.deposit})`);
    const weightLimit = { refTime: dry.refTime + dry.refTime / 10n, proofSize: dry.proofSize + dry.proofSize / 10n };
    const depositLimit = dry.deposit + dry.deposit / 50n;
    const tx = api.tx.revive.instantiateWithCode(0, weightLimit, depositLimit, bytesToHex(initcode), "0x", null);
    const fee = (await tx.paymentInfo(from)).partialFee.toBigInt();
    log(
      `     storage deposit ${formatTpot(dry.deposit)} (limit ${formatTpot(depositLimit)}); weight ${fmt(dry.refTime)} ref time, ` +
        `${fmt(dry.proofSize)} proof size (limits ${fmt(weightLimit.refTime)}, ${fmt(weightLimit.proofSize)}); fee about ${formatTpot(fee)}`,
    );
    const need = depositLimit + fee + ed + BALANCE_MARGIN;
    if (
      !check(
        free >= need,
        `the deployer's free ${formatTpot(free)} covers the deposit limit, the fee, the existential deposit and ${formatTpot(BALANCE_MARGIN)} (${formatTpot(need)})`,
      )
    ) {
      return FAILED;
    }
    if (failures > 0) {
      log("\nThe dry run failed: nothing is sent.");
      return FAILED;
    }
    if (!pair) {
      log(`\nThe dry run passed: the vault would be ${checksumAddress(expected)}. Nothing was signed or sent.`);
      return OK;
    }

    // --send
    const now = readRecord() ?? emptyRecord();
    if (now.vault) throw new Stop(`${RECORD} holds a vault at ${now.vault.address}: nothing is sent`);
    const signed = await tx.signAsync(pair, { nonce: Number(nonce) });
    const entry: VaultEntry = {
      status: "submitted",
      address: bytesToHex(expected),
      deployer: { ss58: from, address: bytesToHex(deployer), nonce: Number(nonce) },
      extrinsicHash: signed.hash.toHex(),
      signedAt: new Date().toISOString(),
      block: null,
      codeHash: null,
      runtimeBytes: runtime.length,
      deposit: { dryRun: dry.deposit.toString(), limit: depositLimit.toString(), charged: null },
      fee: null,
      weightLimit: { refTime: weightLimit.refTime.toString(), proofSize: weightLimit.proofSize.toString() },
      nativeToEthRatio: ratio.toString(),
      releaser: bytesToHex(releaser),
      committee,
      build: {
        artifact: ARTIFACT,
        compiler: build.compiler,
        evmVersion: build.evmVersion,
        viaIR: build.viaIR,
        optimizer: build.optimizer,
        appendCBOR: build.appendCBOR,
        source: `contracts/${build.sourcePath}`,
        sourceKeccak: build.sourceKeccak,
        initcodeHash: bytesToHex(keccak_256(initcode)),
      },
      git: gitState(),
    };
    now.vault = entry;
    saveRecord(now);
    log(`\nSigned revive.instantiateWithCode ${entry.extrinsicHash} at nonce ${nonce}, recorded in ${RECORD}; submitting`);
    let final: Final | "pending";
    try {
      final = await submitAndWatch(api, signed);
    } catch (error) {
      if (!(error instanceof Rejected)) throw error;
      entry.status = "failed";
      entry.note = `never included: ${errorText(error)}`;
      now.failedDeploys = [...(now.failedDeploys ?? []), entry];
      now.vault = null;
      saveRecord(now);
      check(false, `${errorText(error)}; the record moves the attempt to failedDeploys`);
      return FAILED;
    }
    if (final === "pending") {
      log(`     not final after ${FINAL_TIMEOUT / 60_000} minutes; ${RECORD} keeps it as submitted: look at ${entry.extrinsicHash} and at code at ${entry.address}`);
      return PENDING;
    }
    log(`     final in block #${fmt(final.number)} ${final.hash}`);
    entry.block = { number: final.number, hash: final.hash };
    const success = final.events.some((e) => e.section === "system" && e.method === "ExtrinsicSuccess");
    if (!check(success, "ExtrinsicSuccess")) {
      log(`     ${final.dispatchError ?? "no dispatch error reported"}; the record moves the attempt to failedDeploys`);
      entry.status = "failed";
      now.failedDeploys = [...(now.failedDeploys ?? []), entry];
      now.vault = null;
      saveRecord(now);
      return FAILED;
    }
    const instantiated = final.events.find((e) => e.section === "revive" && e.method === "Instantiated");
    check(
      instantiated?.data[0] === bytesToHex(deployer) && instantiated?.data[1] === entry.address,
      `revive.Instantiated: deployer ${checksumAddress(deployer)}, contract ${checksumAddress(expected)}`,
    );
    // TransactionFeePaid { who, actual_fee, tip }: the actual fee includes the tip (none here).
    const paid = final.events.find((e) => e.section === "transactionPayment" && e.method === "TransactionFeePaid");
    const feePaid = paid ? BigInt(paid.data[1]) : 0n;
    entry.fee = feePaid.toString();
    const before = (await (await api.at(final.parentHash)).query.system.account(from)).data.free.toBigInt();
    const after = (await (await api.at(final.hash)).query.system.account(from)).data.free.toBigInt();
    entry.deposit.charged = (before - after - feePaid).toString();
    log(`     fee ${formatTpot(feePaid)}, deposit charged ${formatTpot(before - after - feePaid)} (the dry run said ${formatTpot(dry.deposit)})`);

    // The code at the new address: the build's, with the ratio and the releaser in it.
    let code = await evm.code(expected);
    for (let i = 0; code.length === 0 && i < 20; i++) {
      await sleep(3_000);
      code = await evm.code(expected);
    }
    entry.codeHash = bytesToHex(keccak_256(code));
    check(equalBytes(code, runtime), `eth_getCode(${checksumAddress(expected)}) is the build's runtime code (${fmt(code.length)} bytes, code hash ${shortHex(entry.codeHash)})`);
    const immutables = readImmutables(build, code);
    check(
      immutables !== null && immutables.ratio === ratio && equalBytes(immutables.releaser, releaser),
      `the deployed code holds NATIVE_TO_ETH_RATIO ${ratio} and RELEASER ${checksumAddress(releaser)}`,
    );
    const outstandingWord = await evm.call<string>("eth_call", [{ to: entry.address, data: bytesToHex(outstandingCalldata()) }, "latest"]);
    check(outstandingWord !== "0x" && BigInt(outstandingWord) === 0n, "outstanding() reads 0 through the EVM RPC");
    entry.status = "deployed";
    saveRecord(now);
    log(`\nThe vault is ${checksumAddress(expected)}; ${RECORD} records it.`);
    return failures === 0 ? OK : FAILED;
  } finally {
    await api.disconnect();
  }
}

interface Final {
  hash: Hex;
  parentHash: Hex;
  number: number;
  /** The extrinsic's index in its block, or null when it is not there. */
  index: number | null;
  events: { section: string; method: string; data: string[] }[];
  dispatchError: string | null;
}

/** The node refused a submitted extrinsic, or dropped it from its pool: it was never included. */
class Rejected extends Stop {
  override name = "Rejected";
}

/**
 * Submits a signed extrinsic and waits for its block to be finalized; "pending" after FINAL_TIMEOUT
 * or when the node stops waiting for finality, as the extrinsic may still be final later. Throws
 * Rejected when the node refuses it (an error 1010 to 1019 at submission) or reports it invalid,
 * dropped or usurped.
 */
async function submitAndWatch(api: ApiPromise, signed: SubmittableExtrinsic<"promise">): Promise<Final | "pending"> {
  type Outcome = { hash: Hex; index: number | undefined; events: Final["events"]; dispatchError: string | null };
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
          const events = result.events.map(({ event }) => ({
            section: event.section,
            method: event.method,
            data: event.data.map((d) => (d.toRawType() === "H160" ? d.toHex() : d.toString())),
          }));
          finish({ hash: s.asFinalized.toHex(), index: (result as { txIndex?: number }).txIndex, events, dispatchError });
        } else if (s.isInvalid || s.isDropped || s.isUsurped) {
          finish(new Rejected(`the node reports the extrinsic ${s.type}`));
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
          finish(/^101\d:/.test(text) ? new Rejected(text) : error instanceof Error ? error : new Error(text));
        },
      );
  });
  if (outcome === "pending") return outcome;
  const header = await api.rpc.chain.getHeader(outcome.hash);
  let index = outcome.index ?? null;
  if (index === null) {
    const i = (await api.rpc.chain.getBlock(outcome.hash)).block.extrinsics.findIndex((x) => x.hash.toHex() === signed.hash.toHex());
    index = i < 0 ? null : i;
  }
  return { hash: outcome.hash, parentHash: header.parentHash.toHex(), number: header.number.toNumber(), index, events: outcome.events, dispatchError: outcome.dispatchError };
}

// ---------------------------------------------------------------------------------------
// The vault on chain (lock and status)

interface VaultOnChain {
  address: Uint8Array;
  ratio: bigint;
  releaser: Uint8Array;
  code: Uint8Array;
  /** The block the record says it was deployed in, where eth_getLogs starts. */
  fromBlock: number;
}

/** The vault the command works on (the record's, or --vault), and what its code says. */
async function vaultOnChain(evm: EvmRpc, build: VaultBuild, record: VaultRecord | null, override: Uint8Array | undefined): Promise<VaultOnChain> {
  const entry = record?.vault ?? null;
  let address: Uint8Array;
  if (override) {
    address = override;
    log(`Vault ${checksumAddress(address)} (--vault)`);
  } else if (entry) {
    address = hexToBytes(entry.address);
    log(`Vault ${checksumAddress(address)} (${RECORD}, ${entry.status})`);
    if (entry.status !== "deployed") log(`     note: the record has not seen extrinsic ${entry.extrinsicHash} final; the address is the one it expected`);
  } else {
    throw new Stop(`${RECORD} records no vault: deploy it first (npm run v3-vault -- deploy), or name one with --vault`);
  }
  const code = await evm.code(address);
  if (code.length === 0) throw new Stop(`no contract at ${checksumAddress(address)}`);
  const immutables = readImmutables(build, code);
  if (!check(immutables !== null, `the code at ${checksumAddress(address)} is the V3 build (${fmt(code.length)} bytes)`)) {
    throw new Stop(`${checksumAddress(address)} does not run this PortaldotVault build`);
  }
  const { ratio, releaser } = immutables!;
  log(`     NATIVE_TO_ETH_RATIO ${ratio}, RELEASER ${checksumAddress(releaser)} (read from the code)`);
  const recorded = entry && equalBytes(hexToBytes(entry.address), address) ? entry : null;
  if (recorded) {
    const same = BigInt(recorded.nativeToEthRatio) === ratio && recorded.releaser === bytesToHex(releaser) && (recorded.codeHash === null || recorded.codeHash === bytesToHex(keccak_256(code)));
    if (!check(same, `the code, ratio and releaser are the ones ${RECORD} records`)) throw new Stop(`the vault at ${checksumAddress(address)} is not the recorded one`);
  }
  return { address, ratio, releaser, code, fromBlock: recorded?.block?.number ?? 0 };
}

/** Names a revert of the vault by its error, from an eth_call or eth_estimateGas error. */
function revertText(error: unknown): string {
  if (error instanceof EvmRpcError) {
    const data = error.revertData;
    const name = data ? vaultError(data) : null;
    return name ? `reverts with ${name}` : errorText(error);
  }
  return errorText(error);
}

// ---------------------------------------------------------------------------------------
// lock

/** The destinations deployments/ records for the vault: each deployments/*-bridge.json whose vault is this one, with its chain and BridgeMinter. */
function recordedDestinations(vault: Uint8Array): (Destination & { file: string })[] {
  const dir = at("deployments");
  const names = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith("-bridge.json")).sort() : [];
  const out: (Destination & { file: string })[] = [];
  for (const name of names) {
    const file = `deployments/${name}`;
    let d: Destination | null;
    try {
      d = bridgeDestination(JSON.parse(readFileSync(at(file), "utf8")), vault, V3.chainId);
    } catch (error) {
      throw new Stop(`${file}: ${errorText(error)}`);
    }
    if (d) out.push({ ...d, file });
  }
  return out;
}

/**
 * The lock's destination, which its commitment binds: only the BridgeMinter it names, on the chain
 * it names, can prove it, and the vault never gives a lock back (it pays out against burns only).
 * A failed check (the dry run fails, and --send with it) unless deployments/ records that minter on
 * that chain for this vault; a WARN with --any-destination.
 */
function checkDestination(o: LockOptions, vault: Uint8Array): void {
  const known = recordedDestinations(vault);
  const named = `chain ${o.dstChainId} and minter ${checksumAddress(o.dstMinter)}`;
  const match = known.find((d) => d.chainId === o.dstChainId && equalBytes(d.minter, o.dstMinter));
  if (match) {
    check(true, `${named}: the BridgeMinter ${match.file} records for this vault`);
    return;
  }
  const recorded = known.length === 0 ? "none" : known.map((d) => `chain ${d.chainId}, minter ${checksumAddress(d.minter)} (${d.file})`).join("; ");
  const why = "only the minter a lock names can prove it, and the vault never gives a lock back: tPOT locked for another destination stays locked";
  if (o.anyDestination) {
    log(`WARN ${named} are no destination deployments/*-bridge.json records for this vault (recorded: ${recorded}); --any-destination: ${why}`);
    return;
  }
  check(false, `${named} are a destination deployments/*-bridge.json records for this vault (recorded: ${recorded})`);
  log(`     ${why}. --any-destination locks for it anyway`);
}

/** An EVM lock's recipient (vault.ts recipientProblem): revive.originalAccount of it at V3's finalized head, read from the node. */
async function checkRecipient(o: LockOptions): Promise<void> {
  const original = await withNodeReads(o.rpc, async (reads) => reads.storage(reviveOriginalAccountKey(o.recipient), (await reads.finalizedHead()).hash));
  const why = recipientProblem(o.recipient, original === null ? null : bytesToHex(original), null);
  check(why === null, why ?? `the recipient ${checksumAddress(o.recipient)} is no Substrate account's address on V3 (revive.originalAccount maps none to it)`);
}

async function lock(o: LockOptions): Promise<number> {
  if (o.keyFile !== undefined || o.fromSs58 !== undefined) return lockFromSubstrate(o);
  log(`${new Date().toISOString()}: locking ${o.amountText} tPOT on ${V3.title}${o.send ? "" : " (dry run)"}`);
  const build = readBuild();
  const record = readRecord();
  const evm = new EvmRpc(o.evm);
  const evmChainId = await evm.chainId();
  if (!check(evmChainId === V3.chainId, `the EVM RPC ${new URL(o.evm).host} serves chain ${evmChainId}`)) throw new Stop("the EVM RPC serves another chain");

  let sender: Uint8Array;
  if (o.send) {
    const unlocked = keystoreAddress(o.account!, o.passwordFile!);
    if (!unlocked) return FAILED;
    sender = hexToBytes(unlocked);
    if (o.from && !check(equalBytes(o.from, sender), `keystore ${o.account} is --from ${checksumAddress(o.from)}`)) return FAILED;
  } else sender = o.from ?? hexToBytes(DEFAULT_LOCKER);
  const vault = await vaultOnChain(evm, build, record, o.vault);
  checkDestination(o, vault.address);
  await checkRecipient(o);
  const value = o.amountNative * vault.ratio;

  const nextNonce = await evm.word(vault.address, SLOTS.nextNonce);
  const data = bytesToHex(lockCalldata(o.dstChainId, o.dstMinter, o.recipient));
  const call = { from: bytesToHex(sender), to: bytesToHex(vault.address), value: `0x${value.toString(16)}`, data };
  log(
    `     lock ${formatTpot(o.amountNative)} for ${checksumAddress(o.recipient)} on chain ${o.dstChainId} (minter ${checksumAddress(o.dstMinter)}), ` +
      `value ${fmt(value)} (${evmDecimals(vault.ratio)} decimals)`,
  );
  log(`     sender ${checksumAddress(sender)}${o.send ? ` (keystore ${o.account})` : ""}; the vault's next nonce is ${nextNonce}`);
  let returned: string;
  let gas: bigint;
  try {
    returned = await evm.call<string>("eth_call", [call, "latest"]);
    gas = BigInt(await evm.call<string>("eth_estimateGas", [call]));
  } catch (error) {
    if (error instanceof Unreachable) throw error;
    check(false, `lock ${revertText(error)}`);
    return FAILED;
  }
  check(BigInt(returned) === nextNonce, `eth_call of lock returns nonce ${BigInt(returned)}`);
  const gasPrice = BigInt(await evm.call<string>("eth_gasPrice"));
  const gasLimit = gas + gas / 10n;
  const maxFee = gasPrice + gasPrice / 8n;
  const commitment = lockCommitment({
    v3ChainId: V3.chainId,
    vault: vault.address,
    dstChainId: o.dstChainId,
    dstMinter: o.dstMinter,
    recipient: o.recipient,
    amountNative: o.amountNative,
    nonce: nextNonce,
  });
  log(
    `     gas ${fmt(gas)} (eth_estimateGas; it includes the storage deposit) at the node's gas price ${fmt(gasPrice)} wei: ` +
      `${formatEvmTpot(gas * gasPrice, vault.ratio)}; gas limit ${fmt(gasLimit)}, max fee ${fmt(maxFee)} wei, no priority fee`,
  );
  log(`     the vault will store commitment ${bytesToHex(commitment)} for nonce ${nextNonce}, at slot ${bytesToHex(commitmentSlot(nextNonce))}`);
  const balance = await evm.balance(sender);
  const need = value + gasLimit * maxFee;
  if (!check(balance >= need, `the sender's ${formatEvmTpot(balance, vault.ratio)} covers the value and the gas limit at the max fee (${formatEvmTpot(need, vault.ratio)})`)) {
    return FAILED;
  }
  if (failures > 0) {
    log("\nThe dry run failed: nothing is sent.");
    return FAILED;
  }
  if (!o.send) {
    log("\nThe dry run passed. Nothing was signed or sent.");
    return OK;
  }

  // --send
  const now = record!;
  const open = await settleOpenLocks(evm, now, vault);
  if (open !== OK) return open;
  const latest = Number(BigInt(await evm.call<string>("eth_getTransactionCount", [bytesToHex(sender), "latest"])));
  const pending = Number(BigInt(await evm.call<string>("eth_getTransactionCount", [bytesToHex(sender), "pending"])));
  if (!check(latest === pending, `the sender has no pending transaction (nonce ${latest})`)) return PENDING;
  const args = [
    "mktx", bytesToHex(vault.address), data,
    "--rpc-url", o.evm, "--chain", V3.chainId.toString(),
    "--account", o.account!, "--password-file", o.passwordFile!,
    "--nonce", String(latest), "--gas-limit", gasLimit.toString(),
    "--gas-price", maxFee.toString(), "--priority-gas-price", "0",
    "--value", value.toString(),
  ];
  const out = cast(args);
  const raw = /0x[0-9a-fA-F]+/.exec(out.stdout ?? "")?.[0];
  if (out.status !== 0 || !raw) {
    check(false, `cast mktx failed\n${redact(out.stderr || out.stdout)}`);
    return FAILED;
  }
  const entry: LockEntry = {
    status: "signed",
    txHash: bytesToHex(keccak_256(hexToBytes(raw))),
    from: bytesToHex(sender),
    nonce: latest,
    vault: bytesToHex(vault.address),
    dstChainId: o.dstChainId.toString(),
    dstMinter: bytesToHex(o.dstMinter),
    recipient: bytesToHex(o.recipient),
    amountNative: o.amountNative.toString(),
    value: value.toString(),
    gasLimit: gasLimit.toString(),
    gasPrice: gasPrice.toString(),
    maxFee: maxFee.toString(),
    expected: { vaultNonce: nextNonce.toString(), commitment: bytesToHex(commitment) },
    signedAt: new Date().toISOString(),
  };
  now.locks.push(entry);
  saveRecord(now);
  log(`\nSigned ${entry.txHash} at nonce ${latest}, recorded in ${RECORD}; publishing`);
  const published = cast(["publish", raw, "--rpc-url", o.evm, "--async"]);
  const sent = /0x[0-9a-fA-F]{64}/.exec(published.stdout ?? "")?.[0]?.toLowerCase();
  if (published.status !== 0 || sent !== entry.txHash) {
    const what = `cast publish: ${redact(published.stderr || published.stdout) || "no hash"}`;
    if (!(await evm.call<unknown>("eth_getTransactionByHash", [entry.txHash]))) {
      entry.status = "dropped";
      entry.note = `the node did not take it (${what})`;
      saveRecord(now);
      check(false, `the node did not take ${entry.txHash} (${what})`);
      return FAILED;
    }
    log(`     (${what}; the node has ${entry.txHash}, waiting for it)`);
  }
  const receipt = await receiptOf(evm, entry.txHash, RECEIPT_TIMEOUT);
  if (!receipt) {
    log(`     no receipt after ${RECEIPT_TIMEOUT / 60_000} minutes; ${RECORD} keeps the lock as signed, and the next --send run settles it first`);
    return PENDING;
  }
  const ok = await settleLock(evm, entry, receipt, vault);
  saveRecord(now);
  return ok ? OK : FAILED;
}

interface Receipt {
  status: string;
  blockNumber: string;
  blockHash: string;
  gasUsed: string;
  effectiveGasPrice?: string;
  logs: LogJson[];
}

async function receiptOf(evm: EvmRpc, hash: Hex, waitMs: number): Promise<Receipt | null> {
  const until = Date.now() + waitMs;
  for (;;) {
    const receipt = await evm.call<Receipt | null>("eth_getTransactionReceipt", [hash]);
    if (receipt || Date.now() >= until) return receipt;
    await sleep(3_000);
  }
}

/**
 * Checks a mined lock and completes its entry: status 1, one Locked log of the vault from the
 * sender with the entry's arguments, the commitment recomputed from the event, and the same word
 * read with commitments(nonce) and eth_getStorageAt of its slot at the receipt's block.
 */
async function settleLock(evm: EvmRpc, entry: LockEntry, receipt: Receipt, vault: VaultOnChain): Promise<boolean> {
  const block = { number: Number(BigInt(receipt.blockNumber)), hash: receipt.blockHash.toLowerCase() as Hex };
  const gasUsed = BigInt(receipt.gasUsed);
  const price = BigInt(receipt.effectiveGasPrice ?? entry.gasPrice ?? "0");
  Object.assign(entry, { block, gasUsed: gasUsed.toString(), effectiveGasPrice: price.toString(), cost: (gasUsed * price).toString() });
  let ok = check(BigInt(receipt.status) === 1n, `${entry.txHash}: status ${BigInt(receipt.status)}, block #${fmt(block.number)}, cost ${formatEvmTpot(gasUsed * price, vault.ratio)}`);
  const logs = receipt.logs.filter((l) => l.address.toLowerCase() === entry.vault && l.topics[0]?.toLowerCase() === LOCKED_TOPIC);
  ok = check(logs.length === 1, "one Locked log") && ok;
  if (logs.length !== 1) {
    entry.status = "failed";
    return false;
  }
  const e = decodeLocked(logs[0]);
  ok =
    check(
      bytesToHex(e.sender) === entry.from &&
        bytesToHex(e.recipient) === entry.recipient &&
        e.dstChainId === BigInt(entry.dstChainId) &&
        bytesToHex(e.dstMinter) === entry.dstMinter &&
        e.amountNative === BigInt(entry.amountNative),
      `Locked: nonce ${e.nonce}, ${formatTpot(e.amountNative)} from ${checksumAddress(e.sender)} for ${checksumAddress(e.recipient)} on chain ${e.dstChainId}`,
    ) && ok;
  const recomputed = lockCommitment({ v3ChainId: V3.chainId, vault: vault.address, dstChainId: e.dstChainId, dstMinter: e.dstMinter, recipient: e.recipient, amountNative: e.amountNative, nonce: e.nonce });
  ok = check(equalBytes(recomputed, e.commitment), `the commitment recomputed from the event is the event's ${bytesToHex(e.commitment)}`) && ok;
  if (e.nonce.toString() !== entry.expected.vaultNonce) log(`     note: another lock took nonce ${entry.expected.vaultNonce} first; this one is nonce ${e.nonce}`);
  const tag = `0x${block.number.toString(16)}`;
  const slot = commitmentSlot(e.nonce);
  const stored = await evm.word(vault.address, slot, tag);
  const viaGetter = BigInt(await evm.call<string>("eth_call", [{ to: entry.vault, data: bytesToHex(commitmentsCalldata(e.nonce)) }, tag]));
  const word = BigInt(bytesToHex(e.commitment));
  ok = check(stored === word && viaGetter === word, `commitments(${e.nonce}) and eth_getStorageAt of slot ${shortHex(slot)} hold it`) && ok;
  Object.assign(entry, { vaultNonce: e.nonce.toString(), commitment: bytesToHex(e.commitment), slot: bytesToHex(slot), status: ok ? "locked" : "failed" });
  return ok;
}

/**
 * Settles the record's locks that an earlier --send run left signed: a mined one is checked, one
 * the node still holds keeps this run from sending (PENDING), one that is neither is dropped.
 */
async function settleOpenLocks(evm: EvmRpc, record: VaultRecord, vault: VaultOnChain): Promise<number> {
  // A lock sent from a Substrate account is settled by lock --key-file (settleOpenSubstrateLocks).
  for (const entry of record.locks.filter((l) => l.status === "signed" && l.via !== "substrate")) {
    const receipt = await receiptOf(evm, entry.txHash, 0);
    if (receipt) {
      log(`     settling ${entry.txHash}, signed by an earlier run:`);
      await settleLock(evm, entry, receipt, vault);
      saveRecord(record);
      continue;
    }
    if (await evm.call<unknown>("eth_getTransactionByHash", [entry.txHash])) {
      log(`     ${entry.txHash}, signed by an earlier run, is still pending: nothing more is sent until it is mined`);
      return PENDING;
    }
    entry.status = "dropped";
    entry.note = `neither mined nor pending at ${new Date().toISOString()}`;
    saveRecord(record);
    log(`     ${entry.txHash}, signed by an earlier run, was dropped`);
  }
  return OK;
}

// ---------------------------------------------------------------------------------------
// lock, from a Substrate account (revive.call)

/** The V3 node for the reads substrate-locks.ts makes (paced), once its genesis is V3's; closed after `work`. A LookupError is a Stop. */
async function withNodeReads<R>(url: string, work: (reads: V3Reads) => Promise<R>): Promise<R> {
  let client: RpcClient;
  try {
    client = await RpcClient.connect(url, { connectTimeoutMs: 20_000, requestTimeoutMs: 60_000 });
  } catch (error) {
    throw new Unreachable(`the V3 node ${new URL(url).host} is unreachable (${errorText(error)})`);
  }
  try {
    const genesis = (await client.request<Hex>("chain_getBlockHash", [0])).toLowerCase();
    if (genesis !== V3.genesis) throw new Stop(`the node serves genesis ${genesis}, not ${V3.title}`);
    return await work(nodeReads(client));
  } catch (error) {
    if (error instanceof LookupError) throw new Stop(`System.Events: ${errorText(error)}`);
    if (error instanceof Error && error.name === "RpcError" && (error as { code?: number }).code === undefined) throw new Unreachable(`the V3 node did not answer (${errorText(error)})`);
    throw error;
  } finally {
    await client.close();
  }
}

/** What a reviveApi.call dry run says, from its JSON form (V3's result type is newer than the static types; release.ts reads it the same way). */
interface CallDryRun {
  refTime: bigint;
  proofSize: bigint;
  /** Positive: charged; negative: refunded. The most the call holds at any point. */
  storageDeposit: bigint;
  maxStorageDeposit: bigint;
  reverted: boolean;
  returned: Uint8Array;
  error: string | null;
}

const depositOf = (d: { charge?: number | string; refund?: number | string } | undefined): bigint => (d?.charge !== undefined ? BigInt(d.charge) : -BigInt(d?.refund ?? 0));

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
      error = `${meta.section}.${meta.name}: ${meta.docs.join(" ")}`;
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

/** A dispatch error, named from the metadata when it is a module's. */
function dispatchErrorText(api: ApiPromise, record: EventRecord): string {
  const err = record.event.data[0] as unknown as { isModule: boolean; asModule: Parameters<ApiPromise["registry"]["findMetaError"]>[0]; toString(): string };
  if (!err?.isModule) return String(err);
  const meta = api.registry.findMetaError(err.asModule);
  return `${meta.section}.${meta.name}: ${meta.docs.join(" ")}`;
}

/**
 * The lock from a Substrate account: revive.call of lock() on the vault, dry-run with ReviveApi_call,
 * then with --send signed with the key file, recorded, submitted, and checked once final (see the
 * header). The checks and the record are an EVM lock's, with what a Substrate extrinsic has instead.
 */
async function lockFromSubstrate(o: LockOptions): Promise<number> {
  log(`${new Date().toISOString()}: locking ${o.amountText} tPOT on ${V3.title} from a Substrate account, with revive.call${o.send ? "" : " (dry run)"}`);
  const build = readBuild();
  const record = readRecord();
  const evm = new EvmRpc(o.evm);
  const evmChainId = await evm.chainId();
  if (!check(evmChainId === V3.chainId, `the EVM RPC ${new URL(o.evm).host} serves chain ${evmChainId}`)) throw new Stop("the EVM RPC serves another chain");
  const vault = await vaultOnChain(evm, build, record, o.vault);
  checkDestination(o, vault.address);
  const { Keyring } = await polkadot();
  const keyring = new Keyring({ type: "sr25519", ss58Format: V3.ss58 });
  const named = o.fromSs58 === undefined ? undefined : option("--from", () => keyring.encodeAddress(keyring.decodeAddress(o.fromSs58!), V3.ss58));
  const api = await connectV3(o.rpc);
  try {
    log(`V3 node ${new URL(o.rpc).host}, EVM RPC ${new URL(o.evm).host}`);
    await checkChain(api, evm);
    // The key is opened once the node is up (polkadot-js's crypto is ready by then), and before any dry run that names its account.
    const pair = o.send ? loadLockKey(o.keyFile!, o.passwordFile, keyring) : null;
    const from = pair ? keyring.encodeAddress(pair.publicKey, V3.ss58) : named!;
    if (pair && named !== undefined && !check(from === named, `the key file's account is --from ${named}`)) return FAILED;
    const accountId = keyring.decodeAddress(from);
    // pallet-revive's AutoMap: a Substrate account's msg.sender is keccak-256 of its account id, last 20 bytes.
    const sender = reviveAddress(accountId);
    const mapped = hexToBytes((await api.call.reviveApi.address(accountId)).toHex());
    if (!check(equalBytes(mapped, sender), `reviveApi.address(${from}) is ${checksumAddress(sender)}, keccak-256 of the account id: the lock's sender (msg.sender)`)) {
      throw new Stop("reviveApi.address disagrees with pallet-revive's mapping as vault.ts computes it");
    }
    const ratio = api.consts.revive.nativeToEthRatio.toBigInt();
    if (!check(ratio === vault.ratio, `NativeToEthRatio ${ratio} (read live) is the vault's`)) throw new Stop("the runtime's ratio is not the one in the vault's code");
    const ed = api.consts.balances.existentialDeposit.toBigInt();
    const original = await api.query.revive.originalAccount(sender);
    const account = await api.query.system.account(from);
    const free = account.data.free.toBigInt();
    // revive.call's value is in native base units; the vault sees msg.value = value x the ratio.
    const value = o.amountNative;
    const data = lockCalldata(o.dstChainId, o.dstMinter, o.recipient);
    const nextNonce = await evm.word(vault.address, SLOTS.nextNonce);
    log(
      `     lock ${formatTpot(o.amountNative)} for ${checksumAddress(o.recipient)} on chain ${o.dstChainId} (minter ${checksumAddress(o.dstMinter)}): ` +
        `revive.call with value ${fmt(value)} native base units, msg.value ${fmt(value * ratio)} (${evmDecimals(ratio)} decimals)`,
    );
    log(`     sender ${from} (address ${checksumAddress(sender)}, ${original.isSome ? "mapped" : "not mapped: AutoMap"}), nonce ${account.nonce.toNumber()}, free ${formatTpot(free)}; the vault's next nonce is ${nextNonce}`);
    // The recipient (vault.ts recipientProblem): no Substrate account's address, nor this account's own.
    const owner = await api.query.revive.originalAccount(bytesToHex(o.recipient));
    const why = recipientProblem(o.recipient, owner.isSome ? keyring.encodeAddress(owner.unwrap(), V3.ss58) : null, accountId);
    check(why === null, why ?? `the recipient ${checksumAddress(o.recipient)} is no Substrate account's address on V3 (revive.originalAccount maps none to it), nor the sender's`);

    // The dry run, from the account, at V3's best block.
    const dry = readCallDryRun(api, (await api.call.reviveApi.call(from, bytesToHex(vault.address), value, null, null, bytesToHex(data))).toJSON());
    if (dry.error) {
      check(false, `reviveApi.call dry run: ${dry.error}`);
      return FAILED;
    }
    if (dry.reverted) {
      const name = vaultError(dry.returned);
      check(false, `reviveApi.call dry run: lock reverts${name ? ` with ${name}` : ` (${bytesToHex(dry.returned)})`}`);
      return FAILED;
    }
    const returnedNonce = dry.returned.length === 32 ? BigInt(bytesToHex(dry.returned)) : null;
    check(returnedNonce === nextNonce, `reviveApi.call dry run of lock from ${from}: no revert, returns nonce ${returnedNonce ?? bytesToHex(dry.returned)}`);
    const held = dry.maxStorageDeposit > dry.storageDeposit ? dry.maxStorageDeposit : dry.storageDeposit;
    if (held <= 0n) throw new Stop(`the dry run charges no storage deposit (${dry.storageDeposit}), and a lock stores a new commitment`);
    const weightLimit = { refTime: dry.refTime + dry.refTime / 10n, proofSize: dry.proofSize + dry.proofSize / 10n };
    const depositLimit = held + held / 50n;
    const tx = api.tx.revive.call(bytesToHex(vault.address), value, weightLimit, depositLimit, bytesToHex(data));
    const fee = (await tx.paymentInfo(from)).partialFee.toBigInt();
    const commitment = lockCommitment({ v3ChainId: V3.chainId, vault: vault.address, dstChainId: o.dstChainId, dstMinter: o.dstMinter, recipient: o.recipient, amountNative: o.amountNative, nonce: nextNonce });
    log(
      `     weight ${fmt(dry.refTime)} ref time, ${fmt(dry.proofSize)} proof size (limits, + 10%: ${fmt(weightLimit.refTime)}, ${fmt(weightLimit.proofSize)}); ` +
        `storage deposit ${formatTpot(held)} (limit, + 2%: ${formatTpot(depositLimit)}); fee about ${formatTpot(fee)}`,
    );
    log(`     the vault will store commitment ${bytesToHex(commitment)} for nonce ${nextNonce}, at slot ${bytesToHex(commitmentSlot(nextNonce))}`);
    const need = value + depositLimit + fee + ed;
    if (!check(free >= need, `the sender's free ${formatTpot(free)} covers the amount, the deposit limit, the fee and the existential deposit (${formatTpot(need)})`)) return FAILED;
    if (failures > 0) {
      log("\nThe dry run failed: nothing is sent.");
      return FAILED;
    }
    if (!pair) {
      log("\nThe dry run passed. Nothing was signed or sent.");
      return OK;
    }

    // --send
    const now = record!;
    return await withNodeReads(o.rpc, async (reads) => {
      const open = await settleOpenSubstrateLocks(api, reads, evm, now, vault);
      if (open !== OK) return open;
      const next = (await api.rpc.system.accountNextIndex(from)).toNumber();
      const onChain = (await api.query.system.account(from)).nonce.toNumber();
      if (!check(next === onChain, `the sender has no pending extrinsic (nonce ${onChain})`)) return PENDING;
      const after = (await api.rpc.chain.getHeader(await api.rpc.chain.getFinalizedHead())).number.toNumber();
      const signed = await tx.signAsync(pair, { nonce: next });
      const entry: LockEntry = {
        status: "signed",
        via: "substrate",
        txHash: signed.hash.toHex(),
        from: bytesToHex(sender),
        substrate: { ss58: from, accountId: bytesToHex(accountId) },
        nonce: next,
        vault: bytesToHex(vault.address),
        dstChainId: o.dstChainId.toString(),
        dstMinter: bytesToHex(o.dstMinter),
        recipient: bytesToHex(o.recipient),
        amountNative: o.amountNative.toString(),
        value: (value * ratio).toString(),
        weightLimit: { refTime: weightLimit.refTime.toString(), proofSize: weightLimit.proofSize.toString() },
        storageDepositLimit: depositLimit.toString(),
        dryRun: { refTime: dry.refTime.toString(), proofSize: dry.proofSize.toString(), storageDeposit: held.toString() },
        expected: { vaultNonce: nextNonce.toString(), commitment: bytesToHex(commitment) },
        signedAt: new Date().toISOString(),
        submittedAfter: after,
      };
      now.locks.push(entry);
      saveRecord(now);
      log(`\nSigned revive.call ${entry.txHash} at nonce ${next}, recorded in ${RECORD}; submitting`);
      let final: Final | "pending";
      try {
        final = await submitAndWatch(api, signed);
      } catch (error) {
        if (!(error instanceof Rejected)) throw error;
        entry.status = "dropped";
        entry.note = `never included: ${errorText(error)}`;
        saveRecord(now);
        check(false, `${errorText(error)}; the record marks the lock dropped`);
        return FAILED;
      }
      if (final === "pending") {
        log(`     not final after ${FINAL_TIMEOUT / 60_000} minutes; ${RECORD} keeps the lock as signed, and the next --send run settles it first`);
        return PENDING;
      }
      log(`     final in block #${fmt(final.number)} ${final.hash}`);
      if (final.index === null) throw new Stop(`extrinsic ${entry.txHash} is not in block ${final.hash}`);
      const ok = await settleSubstrateLock(api, reads, evm, entry, { number: final.number, hash: final.hash, parentHash: final.parentHash, index: final.index }, vault);
      saveRecord(now);
      return ok && failures === 0 ? OK : FAILED;
    });
  } finally {
    await api.disconnect();
  }
}

/**
 * Checks a final lock sent from a Substrate account and completes its entry: ExtrinsicSuccess, one
 * Locked event of the vault among the extrinsic's events (System.Events, read as the EVM logs'
 * parser reads a log) with the entry's sender, recipient, chain, minter and amount, the commitment
 * recomputed from the event, the same word in commitments(nonce) and in its slot of the vault's
 * child trie at the block; then what eth_getLogs gives for it (nothing: a Substrate extrinsic's
 * event is not a log), the fee (TransactionFeePaid) and the storage deposit (what left the
 * sender's free balance over the block besides the amount and the fee).
 */
async function settleSubstrateLock(api: ApiPromise, reads: V3Reads, evm: EvmRpc, entry: LockEntry, at: { number: number; hash: Hex; parentHash: Hex; index: number }, vault: VaultOnChain): Promise<boolean> {
  Object.assign(entry, { block: { number: at.number, hash: at.hash }, extrinsicIndex: at.index });
  const records = ((await (await api.at(at.hash)).query.system.events()) as unknown as EventRecord[]).filter((r) => r.phase.isApplyExtrinsic && r.phase.asApplyExtrinsic.toNumber() === at.index);
  const failed = records.find((r) => r.event.section === "system" && r.event.method === "ExtrinsicFailed");
  const paid = records.find((r) => r.event.section === "transactionPayment" && r.event.method === "TransactionFeePaid");
  // TransactionFeePaid { who, actual_fee, tip }: the actual fee includes the tip (none here).
  const fee = paid ? BigInt(paid.event.data[1].toString()) : 0n;
  entry.fee = fee.toString();
  const succeeded = !failed && records.some((r) => r.event.section === "system" && r.event.method === "ExtrinsicSuccess");
  let ok = check(succeeded, `${entry.txHash}: ${succeeded ? "ExtrinsicSuccess" : `failed: ${failed ? dispatchErrorText(api, failed) : "no ExtrinsicSuccess"}`}, block #${fmt(at.number)}, extrinsic ${at.index}, fee ${formatTpot(fee)}`);
  if (!succeeded) {
    entry.status = "failed";
    return false;
  }
  const vaultHex = bytesToHex(vault.address);
  const emitted = (await vaultEventsAt(reads, vaultHex, at.hash, at.parentHash)).filter((e) => e.extrinsic === at.index && e.topics[0] === LOCKED_TOPIC);
  ok = check(emitted.length === 1, `one Locked event of the vault among the extrinsic's events (System.Events, revive.ContractEmitted): ${emitted.length} found`) && ok;
  if (emitted.length !== 1) {
    entry.status = "failed";
    return false;
  }
  const e = decodeLocked(logOfEvent(emitted[0], { number: at.number, hash: at.hash }, entry.txHash));
  ok =
    check(
      bytesToHex(e.sender) === entry.from &&
        bytesToHex(e.recipient) === entry.recipient &&
        e.dstChainId === BigInt(entry.dstChainId) &&
        bytesToHex(e.dstMinter) === entry.dstMinter &&
        e.amountNative === BigInt(entry.amountNative),
      `Locked: nonce ${e.nonce}, ${formatTpot(e.amountNative)} from ${checksumAddress(e.sender)} (${entry.substrate?.ss58}) for ${checksumAddress(e.recipient)} on chain ${e.dstChainId}`,
    ) && ok;
  const recomputed = lockCommitment({ v3ChainId: V3.chainId, vault: vault.address, dstChainId: e.dstChainId, dstMinter: e.dstMinter, recipient: e.recipient, amountNative: e.amountNative, nonce: e.nonce });
  ok = check(equalBytes(recomputed, e.commitment), `the commitment recomputed from the event is the event's ${bytesToHex(e.commitment)}`) && ok;
  if (e.nonce.toString() !== entry.expected.vaultNonce) log(`     note: another lock took nonce ${entry.expected.vaultNonce} first; this one is nonce ${e.nonce}`);
  const slot = commitmentSlot(e.nonce);
  const word = BigInt(bytesToHex(e.commitment));
  const stored = await vaultWordAt(reads, vaultHex, slot, at.hash);
  const viaGetter = BigInt(await evm.call<string>("eth_call", [{ to: entry.vault, data: bytesToHex(commitmentsCalldata(e.nonce)) }, "latest"]));
  ok = check(stored === word && viaGetter === word, `commitments(${e.nonce}) (eth_call) and slot ${shortHex(slot)} of the vault's child trie at #${fmt(at.number)} hold it`) && ok;
  // What eth_getLogs gives for it: V3's EVM RPC indexes the logs of Ethereum transactions only.
  const tag = `0x${at.number.toString(16)}`;
  const logs = await evm.call<LogJson[]>("eth_getLogs", [{ address: entry.vault, fromBlock: tag, toBlock: tag, topics: [LOCKED_TOPIC, bytesToHex(uintWord(e.nonce))] }]).catch(() => null);
  if (logs !== null) entry.lockedLog = logs.length > 0 ? "eth_getLogs" : "not served";
  log(
    logs === null
      ? "     eth_getLogs could not be asked for the block"
      : logs.length > 0
        ? `     eth_getLogs returns its Locked log too (${logs.length})`
        : `     eth_getLogs over #${fmt(at.number)} returns no Locked log of nonce ${e.nonce}: the EVM RPC indexes the logs of Ethereum transactions only, and this lock is a Substrate extrinsic's event, in System.Events (auto-mint and the mint tool read it there)`,
  );
  // What the sender paid besides the amount: the fee and the storage deposit (held from its free balance).
  const freeAt = async (hash: Hex) => (await (await api.at(hash)).query.system.account(entry.substrate!.ss58)).data.free.toBigInt();
  const deposit = (await freeAt(at.parentHash)) - (await freeAt(at.hash)) - fee - BigInt(entry.amountNative);
  Object.assign(entry, { deposit: deposit.toString(), cost: ((fee + deposit) * vault.ratio).toString() });
  log(`     storage deposit ${formatTpot(deposit)} (the dry run said ${formatTpot(BigInt(entry.dryRun?.storageDeposit ?? "0"))}), fee ${formatTpot(fee)}`);
  Object.assign(entry, { vaultNonce: e.nonce.toString(), commitment: bytesToHex(e.commitment), slot: bytesToHex(slot), status: ok ? "locked" : "failed" });
  return ok;
}

/**
 * Settles the record's locks from Substrate accounts that an earlier --send run left signed: one
 * whose sender's nonce a final block used is found there (the block by a binary search over the
 * sender's System.Account nonce, from the block it was signed after) and checked, or dropped when
 * another extrinsic used the nonce; one the node may still include (its account's next index, or
 * its pool) keeps this run from sending (PENDING); one that is neither is dropped.
 */
async function settleOpenSubstrateLocks(api: ApiPromise, reads: V3Reads, evm: EvmRpc, record: VaultRecord, vault: VaultOnChain): Promise<number> {
  for (const entry of record.locks.filter((l) => l.status === "signed" && l.via === "substrate")) {
    const who = entry.substrate!.ss58;
    const key = systemAccountKey(hexToBytes(entry.substrate!.accountId));
    const nonceAt = async (hash: Hex) => {
      const v = await reads.storage(key, hash);
      return v === null ? 0 : decodeAccountInfo(v).nonce;
    };
    const head = await reads.finalizedHead();
    if ((await nonceAt(head.hash)) > entry.nonce) {
      const from = Math.min(head.number, Math.max(1, (entry.submittedAfter ?? 0) + 1));
      const number = await firstBlockWhere(from, head.number, async (n) => (await nonceAt(await reads.blockHash(n))) > entry.nonce);
      const hash = await reads.blockHash(number);
      const index = (await reads.extrinsics(hash)).findIndex((x) => bytesToHex(blake2_256(x)) === entry.txHash);
      if (index < 0) {
        entry.status = "dropped";
        entry.note = `nonce ${entry.nonce} was used in #${number} by another extrinsic`;
        saveRecord(record);
        log(`     ${entry.txHash}, signed by an earlier run, was dropped: ${entry.note}`);
        continue;
      }
      log(`     settling ${entry.txHash}, signed by an earlier run: final in #${fmt(number)}`);
      const header = await api.rpc.chain.getHeader(hash);
      await settleSubstrateLock(api, reads, evm, entry, { number, hash, parentHash: header.parentHash.toHex(), index }, vault);
      saveRecord(record);
      continue;
    }
    // accountNextIndex counts the best block and the pool: above the nonce, it is on its way to a final block.
    const pending = (await api.rpc.system.accountNextIndex(who)).toNumber() > entry.nonce || (await api.rpc.author.pendingExtrinsics()).some((x) => x.hash.toHex() === entry.txHash);
    if (pending) {
      log(`     ${entry.txHash}, signed by an earlier run, is not final yet: nothing more is sent until it is`);
      return PENDING;
    }
    entry.status = "dropped";
    entry.note = `neither final nor pending at ${new Date().toISOString()}`;
    saveRecord(record);
    log(`     ${entry.txHash}, signed by an earlier run, was dropped`);
  }
  return OK;
}

// ---------------------------------------------------------------------------------------
// status

async function status(o: StatusOptions): Promise<number> {
  log(`${new Date().toISOString()}: the vault on ${V3.title}`);
  const build = readBuild();
  const record = readRecord();
  const evm = new EvmRpc(o.evm);
  const evmChainId = await evm.chainId();
  if (!check(evmChainId === V3.chainId, `the EVM RPC ${new URL(o.evm).host} serves chain ${evmChainId}`)) throw new Stop("the EVM RPC serves another chain");
  const vault = await vaultOnChain(evm, build, record, o.vault);
  const head = Number(BigInt(await evm.call<string>("eth_blockNumber")));
  const tag = `0x${head.toString(16)}`;
  const nextNonce = await evm.word(vault.address, SLOTS.nextNonce, tag);
  const outstanding = await evm.word(vault.address, SLOTS.outstanding, tag);
  const viaGetter = BigInt(await evm.call<string>("eth_call", [{ to: bytesToHex(vault.address), data: bytesToHex(outstandingCalldata()) }, tag]));
  const balance = await evm.balance(vault.address, tag);
  log(`At block #${fmt(head)}: nextNonce ${nextNonce}, outstanding ${formatTpot(outstanding)}, balance ${formatEvmTpot(balance, vault.ratio)}`);
  check(viaGetter === outstanding, "outstanding() is the word at slot 2");

  const logs = await evm.call<LogJson[]>("eth_getLogs", [
    { address: bytesToHex(vault.address), fromBlock: `0x${vault.fromBlock.toString(16)}`, toBlock: tag, topics: [[LOCKED_TOPIC, RELEASED_TOPIC]] },
  ]);
  let locked = 0n;
  let released = 0n;
  const nonces = new Set<bigint>();
  const logged = new Set<string>();
  for (const l of logs) {
    const where = `#${fmt(Number(BigInt(l.blockNumber ?? "0")))} ${shortHex(l.transactionHash ?? "0x")}`;
    if (l.topics[0]?.toLowerCase() === LOCKED_TOPIC) {
      const e = decodeLocked(l);
      locked += e.amountNative;
      nonces.add(e.nonce);
      const recomputed = lockCommitment({ v3ChainId: V3.chainId, vault: vault.address, dstChainId: e.dstChainId, dstMinter: e.dstMinter, recipient: e.recipient, amountNative: e.amountNative, nonce: e.nonce });
      const stored = await evm.word(vault.address, commitmentSlot(e.nonce), tag);
      check(
        equalBytes(recomputed, e.commitment) && stored === BigInt(bytesToHex(e.commitment)),
        `lock ${e.nonce} (${where}): ${formatTpot(e.amountNative)} from ${checksumAddress(e.sender)} for ${checksumAddress(e.recipient)} on chain ${e.dstChainId} ` +
          `(minter ${checksumAddress(e.dstMinter)}), commitment ${shortHex(e.commitment)} recomputed and in storage`,
      );
    } else {
      const e = decodeReleased(l);
      released += e.amountNative;
      logged.add(bytesToHex(e.burnId));
      log(`     release (${where}): ${formatTpot(e.amountNative)} to ${checksumAddress(e.to)}, burn id ${shortHex(e.burnId)}`);
    }
  }
  // The committee's releases are Substrate extrinsics (multisig.asMulti dispatching revive.call),
  // whose Released event the EVM RPC does not return as a log: the ones release.ts recorded count
  // once the vault's released[burnId] holds them.
  for (const r of (record?.releases ?? []).filter((x) => x.status === "released" && !logged.has(x.burn.burnId.toLowerCase()))) {
    const flag = await evm.word(vault.address, releasedSlot(hexToBytes(r.burn.burnId)), tag);
    if (flag !== 0n) released += BigInt(r.amountNative);
    check(flag !== 0n, `release of burn ${r.burn.burnNonce} (${RECORD}${r.released ? `, #${fmt(r.released.block.number)}` : ""}): ${formatTpot(BigInt(r.amountNative))} to ${checksumAddress(hexToBytes(r.payee))}, burn id ${shortHex(r.burn.burnId)}, released[burnId] set; no Released log (a Substrate extrinsic)`);
  }
  // A lock sent as a Substrate extrinsic has no log either: its Locked event is in System.Events,
  // read at the block the record names for it, else found where the vault's nextNonce passed it.
  const vaultHex = bytesToHex(vault.address);
  const missing = Array.from({ length: Number(nextNonce) }, (_, i) => BigInt(i)).filter((x) => !nonces.has(x));
  let fromEvents = 0;
  if (missing.length > 0) {
    const blocks = new Map(
      (record?.locks ?? []).filter((l) => l.status === "locked" && l.vault === vaultHex && l.vaultNonce !== undefined && l.block).map((l) => [BigInt(l.vaultNonce!), l.block!.number] as const),
    );
    const found = await withNodeReads(o.rpc, (reads) => findSubstrateLocks(reads, { vault: vaultHex, vaultBlock: vault.fromBlock, nonces: missing, blocks }));
    for (const [n, f] of found) {
      if (!f) {
        log(`     lock ${n}: eth_getLogs has no log of it, and no final block of V3 counts it yet: run again in a minute`);
        continue;
      }
      const e = decodeLocked(f.log);
      locked += e.amountNative;
      nonces.add(e.nonce);
      fromEvents += 1;
      const recomputed = lockCommitment({ v3ChainId: V3.chainId, vault: vault.address, dstChainId: e.dstChainId, dstMinter: e.dstMinter, recipient: e.recipient, amountNative: e.amountNative, nonce: e.nonce });
      const stored = await evm.word(vault.address, commitmentSlot(e.nonce), tag);
      check(
        equalBytes(recomputed, e.commitment) && stored === BigInt(bytesToHex(e.commitment)),
        `lock ${e.nonce} (#${fmt(f.block.number)} ${shortHex(f.extrinsic?.hash ?? "0x")}, from System.Events: a Substrate extrinsic's): ${formatTpot(e.amountNative)} from ${checksumAddress(e.sender)} ` +
          `for ${checksumAddress(e.recipient)} on chain ${e.dstChainId} (minter ${checksumAddress(e.dstMinter)}), commitment ${shortHex(e.commitment)} recomputed and in storage`,
      );
    }
  }
  check(
    BigInt(nonces.size) === nextNonce && [...nonces].every((n) => n < nextNonce),
    `one Locked event for each of the ${nextNonce} nonces${fromEvents > 0 ? ` (${fromEvents} from System.Events, none of them a log)` : ""}`,
  );
  check(locked - released === outstanding, `outstanding = locked ${formatTpot(locked)} - released ${formatTpot(released)}`);
  check(balance >= outstanding * vault.ratio, "the vault's balance covers outstanding times the ratio");
  const recorded = record?.locks.filter((l) => l.vault === bytesToHex(vault.address)) ?? [];
  for (const l of recorded.filter((x) => x.status !== "locked")) log(`     note: ${RECORD} has lock ${l.txHash} as ${l.status}`);
  if (logs.length === 0) log("     no lock yet");
  return failures === 0 ? OK : FAILED;
}

// ---------------------------------------------------------------------------------------

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "deploy") return deploy(deployOptions(args));
  if (command === "lock") return lock(lockOptions(args));
  if (command === "status") return status(statusOptions(args));
  usage(command ? `unknown command ${JSON.stringify(command)}` : "no command");
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
