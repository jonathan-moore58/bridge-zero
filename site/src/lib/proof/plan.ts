// How to mint a lock now, without waiting for the relayer. planMint reads the light client and the
// minter on Sepolia and V3's finalized head, picks the cheapest path the deployed contracts allow,
// builds its transactions in this browser with every header, signature and proof checked here first,
// and dry-runs them on Sepolia before any wallet is asked. Nothing here signs or sends.
//
// The paths, in the order they are tried (gas as the research of Oct 24 measured it on Sepolia):
//   mint       The light client holds a V3 header at or after the lock's block: BridgeMinter.mint(p)
//              with the proofs read at that header. No import and no signature, about 0.6 M gas; it
//              works while the client is behind V3's set, paused or halted.
//   head       The client is at V3's validator set: importAndMint at V3's finalized head (about
//              2.5 M gas), the path lock 1 took (README row 55).
//   change     The client is behind V3's set and the lock is at or before the first set change S it
//              has not imported: importAndMint(S) imports S, which the client's own set signed and
//              which moves it to the next set, then mints from S's state, in one call to the minter
//              (about 3.0 M gas). The relayer's mint tool refuses such a block; the contracts take it.
//   selfRelay  The client is behind and the lock is after S: through Multicall3, importHeader for
//              each set change before the lock, then importAndMint at the first change at or after
//              it, or at the head. One change and the mint is about 4.8 M gas; six calls fit one
//              transaction under Sepolia's 16,777,216 cap, so past five changes the plan has several
//              transactions, sent one after the other.
// When the V3 node no longer serves the state a path reads at (an old block), the next path is
// tried. Whoever sends brings data, not trust: the light client and the minter check every byte,
// and the recipient and the amount come from the proven commitment, nothing from the sender.
//
// The same plan runs on a rollup (Base Sepolia, Arbitrum Sepolia): ProofEnv names that chain's
// endpoints, its V3 light client, its minter and its chain id, and how it charges for L1; each
// transaction then carries its L1 part (../l1.ts), read after the dry run: Arbitrum's L1 gas, added
// once more to its gas limit, or Base's L1 data fee, which the sender pays besides the gas.

import type { AbiRegistry } from "../abi.ts";
import { shortAddr } from "../display.ts";
import { formatInt, formatUnits } from "../format.ts";
import { bytesToHex, equalBytes, hexToBytes, type Hex } from "../hex.ts";
import { limitWithL1, NO_L1, readL1, type L1Cost, type L1Kind } from "../l1.ts";
import { lockCommitment } from "../proofs.ts";
import { AllFailed, NodeError, TransportError, type Endpoint, type SubstrateClient } from "../rpc.ts";
import { aggregate3Calldata, decodeAggregate3, importAndMintCalldata, importHeaderCalldata, mintCalldata, MULTICALL3_CODE_HASH, type Call3, type LockProof } from "./calldata.ts";
import { authorityChange, loadClientCrypto, SignatureError, signersHint, type ClientCrypto, type SignersHint } from "./grandpa.ts";
import { accountInfoKey, decodeContractInfo } from "./revive.ts";
import { encodeFinalityProof, ScaleError, type Header } from "./scale.ts";
import {
  codeHash,
  dryCall,
  estimateGas,
  heldHeader,
  overGasCap,
  readClient,
  readMinter,
  readVaultCodeHash,
  revertOf,
  simulate,
  TX_GAS_CAP,
  type ClientView,
  type DryTx,
  type MinterView,
  type Revert,
} from "./sepolia.ts";
import { provenValue, TrieProofError } from "./trie.ts";
import { HaltingChange, V3Error, V3Moved, V3Reader, type Block, type SetChange, type V3Head } from "./v3.ts";

// ---------------------------------------------------------------------------------------------
// What planMint takes and returns

/** A lock of the vault, as its Locked log gives it. */
export interface LockRef {
  nonce: bigint;
  /** Its V3 block: the receipt's blockNumber, which is the Substrate block's number. */
  block: number;
  /** Native base units of tPOT, which are wtPOT units (14 decimals). */
  amount: bigint;
  recipient: Hex;
  commitment: Hex;
}

/**
 * The contracts and the endpoints, passed in: ./env.ts has Sepolia's deployed ones, from the build's
 * records. `sepolia` and `sepoliaChainId` are the chain the mint is sent on: Sepolia's, or a rollup's
 * endpoints and chain id, with its light client and minter.
 */
export interface ProofEnv {
  sepolia: Endpoint[];
  v3: SubstrateClient;
  lightClient: Hex;
  minter: Hex;
  vault: Hex;
  multicall: Hex;
  v3ChainId: bigint;
  sepoliaChainId: bigint;
  /** Names a revert by the contracts' errors. */
  registry: AbiRegistry;
  /** The Sepolia block the plan reads and dry-runs at: "latest" unless given (an older block reruns a plan as of then). */
  sepoliaBlock?: string;
  /** How the chain charges for L1 (../l1.ts): none unless given, as on Sepolia. */
  l1?: L1Kind;
  /** The chain's name in the plan's words: "Sepolia" unless given. */
  chain?: string;
}

export type MintPath = "mint" | "head" | "change" | "selfRelay";

export interface PlanOptions {
  /** The sender: the dry run runs from it. */
  from?: Hex;
  /** Each check as it starts and ends, for the transfer screen. */
  onCheck?: (check: Check) => void;
  /** Build and dry-run a lock whose nonce is used already: the dry run then reverts NonceAlreadyUsed. */
  evenIfMinted?: boolean;
  /** Take this path, or throw PlanError when it does not apply: a check of one path, not for the app's sends. */
  only?: MintPath;
  /** Percent added to the estimated gas for each transaction's limit (10, the relayer's). */
  margin?: number;
  /** The client's signature check, when the caller has it loaded (tests). */
  crypto?: ClientCrypto;
}

/** The five checks of a mint, in the contracts' order, as ../../app/transfers.ts names them. */
export type CheckKey = "header" | "sigs" | "proof" | "commit" | "nonce";
/** The app's check states (../../app/transfers.ts). */
export type CheckState = "waiting" | "checking" | "passed" | "failed";

export interface Check {
  key: CheckKey;
  state: CheckState;
  /** What was checked, or why it failed, in words. */
  detail: string;
}

export const CHECK_KEYS: readonly CheckKey[] = ["header", "sigs", "proof", "commit", "nonce"];

/** One call a transaction makes: to the minter or the light client, directly or through Multicall3. */
export interface PlannedCall {
  to: Hex;
  method: "mint" | "importAndMint" | "importHeader";
  /** The V3 block it imports, or proves the lock at. */
  block: Block;
  /** The block it imports changes V3's validator set: the light client moves to the next set with it. */
  setChange: boolean;
  what: string;
}

export interface PlannedTx {
  /** BridgeMinter, the light client, or Multicall3 for several calls, in lower case. Value 0, on Sepolia. */
  to: Hex;
  data: Hex;
  /** The dry run's gas: eth_estimateGas for the first transaction; eth_simulateV1 for one that needs the one before it mined. */
  gas: bigint | null;
  /**
   * gas plus the margin, at most the cap (16,777,216, on the rollups too), and on Arbitrum its L1 gas
   * once more: what the wallet is given. Null when no dry run could measure it (plan again once the
   * one before is mined).
   */
  gasLimit: bigint | null;
  gasFrom: "estimate" | "simulation" | null;
  /** What it pays for L1 on a rollup, read once its dry run passed: Arbitrum's L1 gas (in gasLimit), or Base's L1 data fee, paid besides the gas. NO_L1 on Sepolia. */
  l1: L1Cost;
  title: string;
  detail: string;
  calls: PlannedCall[];
}

/** The V3 block the mint proves the lock in. */
export interface MintTarget extends Block {
  /** The set whose signatures finalize it: checked here when the plan imports it; for a block the light client holds, the set it was taken in under. */
  setId: bigint;
  /** The signatures the plan's import counts, and the set's size; null when not known here (a block the client holds). */
  signatures: number | null;
  authorities: number | null;
  /** The plan imports it (importAndMint); false for a block the light client holds (mint). */
  imported: boolean;
}

export type PlanStatus =
  /** The transactions dry-ran: ask the wallet for them, in order. */
  | "ready"
  /** used(nonce) is true, or the dry run reverted NonceAlreadyUsed: the lock is minted, by whoever sent it. */
  | "minted"
  /** V3 has not finalized the lock's block yet, or the V3 node is behind the light client: plan again in a few seconds. */
  | "waiting"
  /** The chains moved while the plan was built (a newer import, a new set, finality moving on): plan again. */
  | "moved"
  /** Nothing can mint it until the light client's admin acts: the client is paused or halted, or V3 made a set change it cannot follow. */
  | "blocked"
  /** A check failed (see `checks`): a header, a signature, a proof or the commitment does not hold. */
  | "failed";

export interface PlanRead {
  /** The Sepolia block tag the plan read and dry-ran at. */
  sepoliaBlock: string;
  client: { setId: bigint; latest: Block; paused: boolean; halted: boolean } | null;
  minter: { used: boolean; bound: boolean } | null;
  v3: { finalized: Block; setId: bigint } | null;
  /** The set changes the client has not imported, when it is behind V3's set. */
  pending: Block[];
}

export interface PlanRevert {
  /** The transaction of the plan that reverted, and the call inside it when it goes through Multicall3. */
  tx: number;
  call: number | null;
  text: string;
  name: string | null;
  data: Hex | null;
}

export interface MintPlan {
  lock: LockRef;
  status: PlanStatus;
  path: MintPath | null;
  /** Why this path, or why there is none: a sentence for the transfer screen. */
  why: string;
  txs: PlannedTx[];
  target: MintTarget | null;
  checks: Check[];
  revert: PlanRevert | null;
  read: PlanRead;
  builtAt: number;
}

/** A forced path that does not apply, or a plan the chains' answers make impossible. */
export class PlanError extends Error {
  override name = "PlanError";
}

/** A log as eth_getLogs and a receipt give it. */
export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
}

/**
 * The lock a Locked log of the vault describes, or null when it is not one this minter can mint
 * (another contract's log, another destination chain or minter). Its block is the log's
 * blockNumber, the number of the Substrate block; the receipt's blockHash is the EVM block hash
 * pallet-revive builds, which no V3 node call takes, so it is not used.
 */
export function lockRefOf(log: RawLog, env: ProofEnv): LockRef | null {
  if (log.address.toLowerCase() !== env.vault.toLowerCase()) return null;
  const d = env.registry.decodeLog(log);
  if (d?.name !== "Locked") return null;
  const arg = (name: string) => d.args.find((a) => a.name === name)?.value;
  const [nonce, recipient, amount, commitment, dstChainId, dstMinter] = ["nonce", "recipient", "amountNative", "commitment", "dstChainId", "dstMinter"].map(arg);
  if (typeof nonce !== "bigint" || typeof recipient !== "string" || typeof amount !== "bigint" || typeof commitment !== "string" || typeof dstMinter !== "string") return null;
  if (dstChainId !== env.sepoliaChainId || dstMinter.toLowerCase() !== env.minter.toLowerCase()) return null;
  return { nonce, block: Number(BigInt(log.blockNumber)), amount, recipient: recipient.toLowerCase() as Hex, commitment: commitment.toLowerCase() as Hex };
}

// ---------------------------------------------------------------------------------------------
// Internals

/** The proven word is not the lock's commitment: no other block can change that. */
class CommitError extends Error {
  override name = "CommitError";
}

/** The light client imports nothing until its admin acts. */
class Blocked extends Error {
  override name = "Blocked";
}

class Checks {
  private readonly map = new Map<CheckKey, Check>();
  private readonly onCheck: ((check: Check) => void) | undefined;
  current: CheckKey | null = null;

  constructor(onCheck: ((check: Check) => void) | undefined) {
    this.onCheck = onCheck;
  }

  set(key: CheckKey, state: CheckState, detail: string): void {
    const c = { key, state, detail };
    this.map.set(key, c);
    if (state === "checking") this.current = key;
    else if (this.current === key) this.current = null;
    this.onCheck?.(c);
  }

  list(): Check[] {
    return CHECK_KEYS.map((key) => this.map.get(key) ?? { key, state: "waiting", detail: "" });
  }
}

/** One call, built: where it goes, its calldata, and what it does in words. */
interface Built {
  call: Call3;
  planned: PlannedCall;
}

/** The block a mint proves the lock in, and how the light client comes to hold it. */
interface Target {
  at: Block;
  header: Header;
  /** null: the client holds it already. Else importAndMint imports it with this proof and hint, under set `setId`. */
  imported: { finalityProof: Uint8Array; setId: bigint; signers: SignersHint; keys: number; follows: boolean } | null;
}

/** A path, built: its calls in order, the block it mints at, and why. */
interface Choice {
  path: MintPath;
  built: Built[];
  target: MintTarget;
  why: string;
}

interface Ctx {
  lock: LockRef;
  env: ProofEnv;
  opts: PlanOptions;
  at: string;
  v3: V3Reader;
  checks: Checks;
  crypto: ClientCrypto;
  client: ClientView;
  minter: MinterView;
  head: V3Head;
  read: PlanRead;
  notes: string[];
  vaultCodeHash: Uint8Array | null;
}

const n = (x: number | bigint): string => formatInt(x);
const wt = (units: bigint): string => `${formatUnits(units, 14)} wtPOT`;
const plural = (k: number, one: string, many = `${one}s`): string => `${n(k)} ${k === 1 ? one : many}`;
const sigs = (s: SignersHint, keys: number): string => `${s.counted.length} of ${keys}`;

/** Calls per transaction through Multicall3: six imports, or five and the mint, about 14 M gas, under the 16,777,216 cap with the margin. */
export const CALLS_PER_TX = 6;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A failure of what the chains answered (a header, a signature, a proof), as opposed to not reaching them. */
const isCheckFailure = (error: unknown): boolean =>
  error instanceof V3Error || error instanceof SignatureError || error instanceof TrieProofError || error instanceof ScaleError || error instanceof PlanError;

/** How ../rpc.ts words a try that reached no node: no connection, no answer in time, an HTTP error, no JSON-RPC answer. */
const NO_NODE = /: (unreachable|no answer in|HTTP \d+|not a JSON-RPC answer|no data|connection closed|could not open|send failed|no connection in)/;

/**
 * A read that reached no node, as opposed to a node that answered with an error: worth asking again
 * in a moment. planMint throws these; the app asks again (../../app/preflight.ts uses this too).
 */
export const unreachable = (error: unknown): boolean =>
  error instanceof TransportError || (error instanceof AllFailed && error.problems.every((p) => NO_NODE.test(p)));

/**
 * A failure the next path may not meet: the node answered that it no longer serves an old block's
 * state, or what it served did not check out. A node not reached is not a reason to take another,
 * dearer path: planMint throws, and the plan is made again once the node answers.
 */
const fallsBack = (error: unknown): boolean =>
  !(error instanceof CommitError) && (isCheckFailure(error) || error instanceof NodeError || (error instanceof AllFailed && !unreachable(error)));

const importedTarget = (t: Target): MintTarget => ({
  ...t.at,
  setId: t.imported?.setId ?? 0n,
  signatures: t.imported ? t.imported.signers.counted.length : null,
  authorities: t.imported ? t.imported.keys : null,
  imported: t.imported !== null,
});

/** The lock's proofs at a target block, walked here, and the LockProof that carries them. */
async function proveLock(ctx: Ctx, t: Target): Promise<LockProof> {
  const { lock, env, v3, checks } = ctx;
  checks.set("proof", "checking", `reading lock ${lock.nonce}'s storage proofs at V3 #${n(t.at.number)}`);
  let trieId = ctx.minter.trieId;
  let accountProof: Uint8Array[] = [];
  if (!trieId) {
    // Not bound yet (a fresh minter): importAndMint binds it from Revive.AccountInfoOf(vault).
    if (!t.imported) throw new PlanError("the minter is not bound to the vault, and mint(p) does not bind it");
    const key = accountInfoKey(env.vault);
    accountProof = await v3.readProof(key, t.at.hash);
    const info = decodeContractInfo(provenValue(t.header.stateRoot, accountProof, key, "Revive.AccountInfoOf(vault)"));
    ctx.vaultCodeHash ??= await readVaultCodeHash(env.sepolia, env.minter, ctx.at);
    if (!equalBytes(info.codeHash, ctx.vaultCodeHash)) throw new PlanError(`the vault's code hash on V3 is ${bytesToHex(info.codeHash)}, not the minter's vaultCodeHash`);
    trieId = info.trieId;
  }
  const proofs = await v3.lockProofs(t.at, t.header.stateRoot, trieId, lock.nonce);
  checks.set(
    "proof",
    "passed",
    `the vault's child-trie root and commitments[${lock.nonce}] walk from V3 #${n(t.at.number)}'s state root, ${proofs.childRootProof.length} + ${proofs.slotProof.length} items` +
      (accountProof.length ? `, and its account entry (${accountProof.length} items) for the bind` : ""),
  );
  checks.set("commit", "checking", "comparing the proven word with the lock's commitment");
  if (bytesToHex(proofs.value) !== lock.commitment.toLowerCase()) {
    throw new CommitError(`commitments[${lock.nonce}] holds ${bytesToHex(proofs.value)} at V3 #${n(t.at.number)}, not the lock's commitment ${lock.commitment}`);
  }
  checks.set("commit", "passed", `commitments[${lock.nonce}] holds ${lock.commitment}: ${wt(lock.amount)} for ${shortAddr(lock.recipient)}, nonce ${lock.nonce}`);
  return { blockHash: hexToBytes(t.at.hash), accountProof, childRootProof: proofs.childRootProof, slotProof: proofs.slotProof, recipient: hexToBytes(lock.recipient), amount: lock.amount, nonce: lock.nonce };
}

/** The mint's call at a target: mint(p) at a held block, else importAndMint. */
async function mintAt(ctx: Ctx, t: Target): Promise<Built> {
  const { lock, env } = ctx;
  const p = await proveLock(ctx, t);
  const mints = `mints ${wt(lock.amount)} to ${shortAddr(lock.recipient)}`;
  if (!t.imported) {
    return {
      call: { target: env.minter, allowFailure: false, callData: mintCalldata(p) },
      planned: {
        to: env.minter,
        method: "mint",
        block: t.at,
        setChange: false,
        what: `BridgeMinter.mint: proves lock ${lock.nonce} in V3 #${n(t.at.number)}, which the light client holds, and ${mints}`,
      },
    };
  }
  const i = t.imported;
  return {
    call: { target: env.minter, allowFailure: false, callData: importAndMintCalldata(t.header.encoded, i.finalityProof, i.signers.hint, p) },
    planned: {
      to: env.minter,
      method: "importAndMint",
      block: t.at,
      setChange: i.follows,
      what:
        `BridgeMinter.importAndMint: the light client checks ${sigs(i.signers, i.keys)} signatures of set ${i.setId} for V3 #${n(t.at.number)} and stores it` +
        (i.follows ? `, moving to set ${i.setId + 1n}` : "") +
        `; the minter proves lock ${lock.nonce} in its state and ${mints}`,
    },
  };
}

/** A set change's importHeader. */
function importOf(ctx: Ctx, s: SetChange): Built {
  return {
    call: { target: ctx.env.lightClient, allowFailure: false, callData: importHeaderCalldata(s.header.encoded, s.justification, s.signers.hint) },
    planned: {
      to: ctx.env.lightClient,
      method: "importHeader",
      block: { number: s.number, hash: s.hash },
      setChange: true,
      what: `GrandpaLightClient.importHeader: V3's set change #${n(s.number)}, set ${s.setId} to ${s.setId + 1n}, with ${sigs(s.signers, s.keys.length)} signatures`,
    },
  };
}

/** The importAndMint target at a set change the client has not imported: its stored justification, as a FinalityProof. */
function changeTarget(s: SetChange): Target {
  return {
    at: { number: s.number, hash: s.hash },
    header: s.header,
    imported: { finalityProof: encodeFinalityProof(hexToBytes(s.hash), s.justification), setId: s.setId, signers: s.signers, keys: s.keys.length, follows: true },
  };
}

/** The importAndMint target at V3's finalized head, signed by `setId` with `keys` (the client's set once the imports before it are in), above block `after`. */
async function headTarget(ctx: Ctx, setId: bigint, keys: Uint8Array[], after: number): Promise<Target> {
  const proof = await ctx.v3.cleanProof(ctx.head.number);
  // Someone imported V3's head meanwhile: the next plan mints against it.
  if (proof.block.number <= after) throw new V3Moved(`V3's finality proof is for #${n(proof.block.number)}, not above #${n(after)}`);
  const change = authorityChange(proof.header, ctx.crypto);
  if (change.kind === "halts") throw new HaltingChange(proof.block.number, change.reason);
  const signers = signersHint(proof.justification, keys, setId, ctx.crypto.verify);
  return { at: proof.block, header: proof.header, imported: { finalityProof: proof.scale, setId, signers, keys: keys.length, follows: change.kind === "follows" } };
}

/** The header and sigs checks, passed, for the set changes a plan imports and its target. */
function passTarget(ctx: Ctx, imports: SetChange[], t: Target): void {
  const i = t.imported;
  if (!i) return;
  const blocks = [...imports.map((s) => `the set change #${n(s.number)}`), `V3 #${n(t.at.number)}`].join(", ");
  ctx.checks.set(
    "header",
    "passed",
    `${blocks} ${imports.length ? "hash to their block hashes, each its justification's target" : "hashes to its block hash and is its finality proof's target"}; ` +
      (imports.length || i.follows ? "each set change is one the light client can follow" : "it changes no validator set"),
  );
  ctx.checks.set(
    "sigs",
    "passed",
    [...imports.map((s) => `${sigs(s.signers, s.keys.length)} of set ${s.setId}`), `${sigs(i.signers, i.keys)} of set ${i.setId}`].join(", ") +
      " verify with the light client's own ed25519 check",
  );
}

// ---------------------------------------------------------------------------------------------
// The paths

/** mint(p) at the light client's latest header, which is at or after the lock. */
async function heldPath(ctx: Ctx): Promise<Choice> {
  const { client, env, v3, checks, lock } = ctx;
  const latest = client.latest;
  const [header, held] = await Promise.all([v3.header(latest.hash), heldHeader(env.sepolia, env.lightClient, latest.hash, ctx.at)]);
  if (!held || held.number !== header.number || !equalBytes(held.stateRoot, header.stateRoot)) {
    throw new V3Error(`the light client holds ${held ? bytesToHex(held.stateRoot) : "no state root"} for #${n(latest.number)}, V3's header has ${bytesToHex(header.stateRoot)}`);
  }
  checks.set("header", "passed", `the light client holds V3 #${n(latest.number)}: V3's header for it hashes to its block hash and carries the state root the client stores`);
  checks.set("sigs", "passed", `the light client took V3 #${n(latest.number)} in under set ${held.setId}, with that set's signatures or as its admin's checkpoint; mint(p) imports nothing, so it sends no signature`);
  const built = await mintAt(ctx, { at: latest, header, imported: null });
  return {
    path: "mint",
    built: [built],
    target: { ...latest, setId: held.setId, signatures: null, authorities: held.setId === client.setId ? client.keys.length : null, imported: false },
    why: `The light client already holds V3 #${n(latest.number)}, at or after the lock's block #${n(lock.block)}: mint(p) proves the lock there, with no import.`,
  };
}

/** importAndMint at V3's finalized head, the client at V3's set. */
async function headPath(ctx: Ctx): Promise<Choice> {
  const { client } = ctx;
  const t = await headTarget(ctx, client.setId, client.keys, client.latest.number);
  passTarget(ctx, [], t);
  const built = await mintAt(ctx, t);
  return {
    path: "head",
    built: [built],
    target: importedTarget(t),
    why: `The light client is at V3's validator set ${client.setId}: one importAndMint at V3's finalized block #${n(t.at.number)} imports that block and mints.`,
  };
}

/**
 * The client is `behind` set changes: importAndMint at the first change at or after the lock with
 * the changes before it imported first (none: the change path), or every change imported and the
 * mint at the head. When the node does not serve the state at that change, every change and the
 * head.
 */
async function behindPath(ctx: Ctx, behind: number): Promise<Choice> {
  const { client, lock, checks, opts, v3, head } = ctx;
  checks.set("header", "checking", `finding the ${plural(behind, "validator-set change")} V3 made that the light client has not imported`);
  const changes = await v3.setChanges({ number: client.latest.number, setId: client.setId, keys: client.keys, activatedAt: client.activatedAt }, behind, ctx.crypto, head.number);
  ctx.read.pending = changes.map((s) => ({ number: s.number, hash: s.hash }));
  const K = changes.length;
  const first = changes[0];
  const last = changes[K - 1];
  if (!first || !last) throw new PlanError("V3 made no set change the light client lacks");
  // The mint at the head imports every change first; when the head is the last change, it mints there.
  const atHead = head.number > last.number ? K : K - 1;
  const j = changes.findIndex((s) => s.number >= lock.block);
  const natural = j === -1 ? K : j;
  let ks: number[];
  if (opts.only === "change") {
    if (j !== 0) throw new PlanError(`the change path does not apply: the lock (#${n(lock.block)}) is after V3's first set change #${n(first.number)} the light client lacks`);
    ks = [0];
  } else if (opts.only === "selfRelay") {
    ks = [...new Set([natural === 0 ? atHead : natural, atHead])].filter((k) => k > 0);
    if (!ks.length) throw new PlanError(`the self-relay path does not apply: V3's only pending set change #${n(first.number)} is its head, so the mint imports it with nothing before it`);
  } else {
    ks = [...new Set([natural, atHead])];
  }

  for (const [i, k] of ks.entries()) {
    const imports = changes.slice(0, k);
    const change = changes[k];
    const target = change ? changeTarget(change) : await headTarget(ctx, last.setId + 1n, last.next, last.number);
    passTarget(ctx, imports, target);
    let mint: Built;
    try {
      mint = await mintAt(ctx, target);
    } catch (error) {
      const next = ks[i + 1];
      if (next === undefined || !fallsBack(error)) throw error;
      ctx.notes.push(`The lock's proofs at #${n(target.at.number)} could not be read (${errorText(error)}): ${plural(next, "set change")} imported first, and the mint at #${n(changes[next]?.number ?? head.number)}.`);
      continue;
    }
    const at = change ? `the set change #${n(target.at.number)}, which it imports too` : `V3's finalized block #${n(target.at.number)}`;
    return {
      path: k === 0 ? "change" : "selfRelay",
      built: [...imports.map((s) => importOf(ctx, s)), mint],
      target: importedTarget(target),
      why:
        k === 0
          ? `V3 changed validator set at #${n(first.number)} (set ${first.setId} to ${first.setId + 1n}) and the light client has not imported it; the lock (#${n(lock.block)}) is at or before it, so importAndMint of that block imports the change and mints, in one call.`
          : `V3 changed validator set ${plural(behind, "time")} since the light client's latest import (set ${client.setId} to ${head.setId}); ${plural(k, "set change")} ${k === 1 ? "is" : "are"} imported first, then the mint at ${at}, through Multicall3.`,
    };
  }
  throw new PlanError("no path was left to try");
}

/** The cheapest path that applies, or the one `opts.only` names. */
async function choose(ctx: Ctx): Promise<Choice> {
  const { client, minter, lock, opts, head, checks } = ctx;
  const held = minter.trieId !== null && client.latest.number >= lock.block;
  if (opts.only === "mint" && !held) {
    throw new PlanError(minter.trieId ? `the light client's latest header #${n(client.latest.number)} is below the lock's block #${n(lock.block)}` : "the minter is not bound to the vault");
  }
  let heldFailed: string | null = null;
  if (held && (opts.only === undefined || opts.only === "mint")) {
    try {
      return await heldPath(ctx);
    } catch (error) {
      // A node that no longer serves that block's state: the next path reads at the head.
      if (opts.only || !fallsBack(error)) throw error;
      heldFailed = errorText(error);
    }
  }
  if (client.paused || client.halted) {
    const state = client.halted ? "halted" : "paused";
    throw new Blocked(
      heldFailed === null
        ? `The light client is ${state} and holds no V3 block at or after the lock's: the mint waits for its admin.`
        : `The light client is ${state}, so it imports nothing until its admin acts, and mint(p) at the block it holds, #${n(client.latest.number)}, could not be built: ${heldFailed}.`,
    );
  }
  if (heldFailed !== null) {
    ctx.notes.push(`mint(p) at #${n(client.latest.number)} could not be built (${heldFailed}); the plan reads at V3's head instead.`);
    checks.set("header", "checking", "reading V3's finalized head");
  }
  const behind = Number(head.setId - client.setId);
  if (behind === 0) {
    if (opts.only && opts.only !== "head") throw new PlanError(`the ${opts.only} path does not apply: the light client is at V3's set ${client.setId}, with no set change to import`);
    return headPath(ctx);
  }
  if (opts.only === "head") throw new PlanError(`the head path does not apply: the light client is ${plural(behind, "set")} behind V3, so an import at the head would revert WrongSetId`);
  return behindPath(ctx, behind);
}

// ---------------------------------------------------------------------------------------------
// Transactions and the dry run

/** The calls in transactions: at most `size` calls each, in order; one call alone goes to its contract directly, more through Multicall3. */
function chunk(env: ProofEnv, built: Built[], size: number): { tx: PlannedTx; calls: Call3[] }[] {
  const out: { tx: PlannedTx; calls: Call3[] }[] = [];
  for (let i = 0; i < built.length; i += size) {
    const part = built.slice(i, i + size);
    const first = part[0];
    if (!first) continue;
    const direct = part.length === 1;
    const calls = part.map((b) => b.call);
    out.push({
      calls,
      tx: {
        to: (direct ? first.call.target : env.multicall).toLowerCase() as Hex,
        data: bytesToHex(direct ? first.call.callData : aggregate3Calldata(calls)),
        gas: null,
        gasLimit: null,
        gasFrom: null,
        l1: NO_L1,
        title: "",
        detail: "",
        calls: part.map((b) => b.planned),
      },
    });
  }
  return out;
}

const isMulticallFailure = (r: Revert): boolean => r.error?.name === "Error" && r.error.args[0]?.value === "Multicall3: call failed";

/** Which call of a Multicall3 transaction reverted, and with what: the same calls again with every failure allowed, read from aggregate3's results. */
async function innerRevert(ctx: Ctx, txs: { tx: PlannedTx; calls: Call3[] }[], index: number): Promise<{ call: number; revert: Revert } | null> {
  const t = txs[index];
  if (!t || t.calls.length < 2) return null;
  const from = ctx.opts.from ? { from: ctx.opts.from } : {};
  const probe: DryTx = { ...from, to: t.tx.to, data: bytesToHex(aggregate3Calldata(t.calls.map((c) => ({ ...c, allowFailure: true })))) };
  let returned: Hex | null = null;
  if (index === 0) {
    const r = await dryCall(ctx.env.sepolia, probe, ctx.at, ctx.env.registry);
    if ("data" in r) returned = r.data;
  } else {
    const before = txs.slice(0, index).map((x) => ({ ...from, to: x.tx.to, data: x.tx.data }));
    const sim = await simulate(ctx.env.sepolia, [...before, probe], ctx.at, ctx.env.registry);
    const last = sim?.at(-1);
    if (last?.ok) returned = last.returnData;
  }
  if (!returned) return null;
  const results = decodeAggregate3(returned);
  const call = results.findIndex((r) => !r.success);
  const failed = results[call];
  return failed ? { call, revert: revertOf(failed.returnData, "reverted", ctx.env.registry) } : null;
}

type DryRun = { ok: true } | { ok: false; overCap: true } | { ok: false; overCap: false; revert: PlanRevert };

/**
 * The plan's dry run, from the sender: eth_estimateGas of the first transaction, on the state as it
 * is; eth_simulateV1 of them all in order for a later one, which needs the one before it mined. Each
 * limit is its gas plus the margin; a Multicall3 transaction over the cap asks for smaller ones.
 */
async function dryRun(ctx: Ctx, txs: { tx: PlannedTx; calls: Call3[] }[]): Promise<DryRun> {
  const { env, opts } = ctx;
  const margin = BigInt(Math.max(0, Math.round(opts.margin ?? 10)));
  const withMargin = (gas: bigint): bigint => gas + (gas * margin) / 100n;
  const from = opts.from ? { from: opts.from } : {};
  /** The limit for `gas`, or null when the transaction has to be split (or cannot be, which throws). */
  const limitOf = (gas: bigint, calls: number): bigint | null => {
    if (withMargin(gas) <= TX_GAS_CAP) return withMargin(gas);
    if (calls > 1) return null;
    if (gas > TX_GAS_CAP) throw new PlanError(`the transaction needs ${n(gas)} gas, more than ${env.chain ?? "Sepolia"}'s ${n(TX_GAS_CAP)} per transaction`);
    return TX_GAS_CAP;
  };
  const fail = async (index: number, revert: Revert): Promise<DryRun> => {
    const inner = isMulticallFailure(revert) ? await innerRevert(ctx, txs, index) : null;
    const r = inner?.revert ?? revert;
    return { ok: false, overCap: false, revert: { tx: index, call: inner?.call ?? null, text: r.text, name: r.error?.name ?? null, data: r.data } };
  };
  const first = txs[0];
  if (!first) return { ok: true };
  let estimate: Awaited<ReturnType<typeof estimateGas>>;
  try {
    estimate = await estimateGas(env.sepolia, { ...from, to: first.tx.to, data: first.tx.data }, ctx.at, env.registry);
  } catch (error) {
    if (first.calls.length > 1 && overGasCap(error)) return { ok: false, overCap: true };
    throw error;
  }
  if ("revert" in estimate) return fail(0, estimate.revert);
  const limit = limitOf(estimate.gas, first.calls.length);
  if (limit === null) return { ok: false, overCap: true };
  Object.assign(first.tx, { gas: estimate.gas, gasLimit: limit, gasFrom: "estimate" });
  if (txs.length === 1) return { ok: true };
  const sim = await simulate(
    env.sepolia,
    txs.map((t) => ({ ...from, to: t.tx.to, data: t.tx.data })),
    ctx.at,
    env.registry,
  );
  if (!sim) {
    ctx.notes.push("No endpoint ran eth_simulateV1, so each transaction after the first is measured once the one before is mined: plan again then.");
    return { ok: true };
  }
  for (let i = 1; i < txs.length; i++) {
    const s = sim[i];
    const t = txs[i];
    if (!s || !t) continue;
    if (!s.ok) return fail(i, s.revert ?? revertOf(null, "reverted", env.registry));
    const l = limitOf(s.gasUsed, t.calls.length);
    if (l === null) return { ok: false, overCap: true };
    Object.assign(t.tx, { gas: s.gasUsed, gasLimit: l, gasFrom: "simulation" });
  }
  return { ok: true };
}

/**
 * The L1 part of each transaction on a rollup (../l1.ts), read once the dry run passed: Arbitrum's
 * L1 gas, which eth_estimateGas includes at the L1 price of the moment, is added once more to the
 * limit, as the relayer's tools send there; Base's L1 data fee is kept on the transaction, for the
 * balance its sender needs. Nothing on Sepolia.
 */
async function l1Parts(ctx: Ctx, txs: PlannedTx[]): Promise<void> {
  const kind = ctx.env.l1 ?? "none";
  if (kind === "none") return;
  for (const tx of txs) {
    tx.l1 = await readL1(ctx.env.sepolia, kind, tx.to, tx.data, ctx.at);
    if (tx.gasLimit !== null) tx.gasLimit = limitWithL1(tx.gasLimit, tx.l1);
  }
}

/** What a revert in the dry run means for the transfer. */
function statusOf(name: string | null): PlanStatus {
  if (name === "NonceAlreadyUsed") return "minted";
  if (name === "ClientPaused" || name === "ClientHalted") return "blocked";
  // Another import moved the client between the reads and the dry run (a newer header, a new set).
  if (name && ["NotNewer", "UnknownBlock", "WrongSetId", "InvalidSignature", "UnknownSigner", "BelowThreshold", "UnknownAuthoritySet", "BlockMismatch"].includes(name)) return "moved";
  return "failed";
}

/** Titles and words for each transaction of a plan. */
function describe(ctx: Ctx, txs: { tx: PlannedTx; calls: Call3[] }[]): void {
  const { lock, env } = ctx;
  txs.forEach(({ tx }, i) => {
    const of = txs.length > 1 ? `${i + 1} of ${txs.length}: ` : "";
    const imports = tx.calls.filter((c) => c.method === "importHeader");
    const mint = tx.calls.find((c) => c.method !== "importHeader");
    if (tx.to.toLowerCase() === env.multicall.toLowerCase()) {
      tx.title = `${of}Import ${plural(imports.length, "set change")}${mint ? ` and mint ${wt(lock.amount)}` : ""}`;
      tx.detail = `Through Multicall3 (${shortAddr(env.multicall)}), all or nothing: ${tx.calls.map((c) => c.what).join("; then ")}. The wallet shows Multicall3 as the contract it calls; the light client and BridgeMinter check every byte.`;
      return;
    }
    const c = tx.calls[0];
    if (!c) return;
    const block = c.setChange ? `V3's set change #${n(c.block.number)}` : `V3 #${n(c.block.number)}`;
    if (c.method === "mint") tx.title = `${of}Mint ${wt(lock.amount)}`;
    else if (c.method === "importHeader") tx.title = `${of}Import ${block}`;
    else tx.title = `${of}Import ${block} and mint ${wt(lock.amount)}`;
    tx.detail = `${c.what}.`;
  });
}

// ---------------------------------------------------------------------------------------------
// planMint

/**
 * The plan to mint `lock` now: the path, its transactions with their gas, what each does, the block
 * it mints at, and the five checks as this browser ran them. Throws when a chain cannot be reached
 * (AllFailed, TransportError: `unreachable` says so; plan again in a moment) or a forced path does
 * not apply (PlanError); everything else is a status. The dry run is the contracts' own verdict:
 * plan again right before the wallet opens.
 */
export async function planMint(lock: LockRef, env: ProofEnv, opts: PlanOptions = {}): Promise<MintPlan> {
  const checks = new Checks(opts.onCheck);
  const at = env.sepoliaBlock ?? "latest";
  const read: PlanRead = { sepoliaBlock: at, client: null, minter: null, v3: null, pending: [] };
  const notes: string[] = [];
  const done = (status: PlanStatus, why: string, more: Partial<MintPlan> = {}): MintPlan => ({
    lock,
    status,
    path: null,
    why: notes.length ? `${why} ${notes.join(" ")}` : why,
    txs: [],
    target: null,
    checks: checks.list(),
    revert: null,
    read,
    builtAt: Date.now(),
    ...more,
  });

  // The lock's fields have to give its commitment, as the vault computed it and the minter will.
  const expected = lockCommitment({ v3ChainId: env.v3ChainId, vault: env.vault, dstChainId: env.sepoliaChainId, minter: env.minter, recipient: lock.recipient, amountNative: lock.amount, nonce: lock.nonce });
  if (expected !== lock.commitment.toLowerCase()) {
    checks.set("commit", "failed", `the lock's fields give the commitment ${expected}, not ${lock.commitment}: not a lock of this vault for this minter`);
    return done("failed", "The lock's fields do not give its commitment.");
  }
  if (lock.amount <= 0n) {
    checks.set("commit", "failed", "a lock of 0, which the minter refuses (ZeroAmount)");
    return done("failed", "The lock's amount is 0.");
  }

  checks.set("header", "checking", `reading the light client on ${env.chain ?? "Sepolia"} and V3's finalized head`);
  const v3 = new V3Reader(env.v3);
  let client: ClientView;
  let minter: MinterView;
  let head: V3Head;
  let crypto: ClientCrypto;
  try {
    [client, minter, head, crypto] = await Promise.all([
      readClient(env.sepolia, env.lightClient, at),
      readMinter(env.sepolia, env.minter, lock.nonce, at),
      v3.finalizedHead(),
      opts.crypto ?? loadClientCrypto(),
    ]);
  } catch (error) {
    if (!isCheckFailure(error)) throw error;
    checks.set("header", "failed", errorText(error));
    return done("failed", `V3's finalized head did not check out: ${errorText(error)}`);
  }
  read.client = { setId: client.setId, latest: client.latest, paused: client.paused, halted: client.halted };
  read.minter = { used: minter.used, bound: minter.trieId !== null };
  read.v3 = { finalized: { number: head.number, hash: head.hash }, setId: head.setId };

  if (minter.used && !opts.evenIfMinted) {
    checks.set("header", "waiting", "lock already minted: nothing to import");
    checks.set("nonce", "failed", `used(${lock.nonce}) is true on BridgeMinter: lock ${lock.nonce} is minted already, by whoever sent it`);
    return done("minted", `Lock ${lock.nonce} is minted already.`);
  }
  if (head.number < lock.block) {
    checks.set("header", "waiting", `V3 has finalized #${n(head.number)}; the lock is in #${n(lock.block)}`);
    return done("waiting", `V3 has not finalized the lock's block #${n(lock.block)} yet (finalized: #${n(head.number)}).`);
  }
  if (client.latest.number > head.number || head.setId < client.setId) {
    checks.set("header", "waiting", `the V3 node is at #${n(head.number)}, set ${head.setId}; the light client at #${n(client.latest.number)}, set ${client.setId}`);
    return done("waiting", "The V3 node is behind the light client: ask it again in a few seconds.");
  }

  const ctx: Ctx = { lock, env, opts, at, v3, checks, crypto, client, minter, head, read, notes, vaultCodeHash: null };
  let choice: Choice;
  try {
    choice = await choose(ctx);
  } catch (error) {
    if (error instanceof Blocked) {
      checks.set("header", "failed", error.message);
      return done("blocked", error.message);
    }
    if (error instanceof HaltingChange) {
      checks.set("header", "failed", error.message);
      return done("blocked", `${error.message}: no import can follow it until the light client's admin reinitializes it.`);
    }
    if (error instanceof V3Moved) {
      checks.set(checks.current ?? "header", "waiting", error.message);
      return done("moved", `V3 moved on while the proof was read (${error.message}): plan again.`);
    }
    if (error instanceof CommitError) {
      checks.set("commit", "failed", error.message);
      return done("failed", "The proven word is not the lock's commitment.");
    }
    if (error instanceof PlanError && opts.only) throw error;
    if (isCheckFailure(error)) {
      checks.set(checks.current ?? "header", "failed", errorText(error));
      return done("failed", `A check did not hold: ${errorText(error)}`);
    }
    throw error;
  }
  const { path, built, target } = choice;

  // One call alone goes to its contract; more go through Multicall3, whose code has to be the
  // canonical one, or else each call is a transaction of its own.
  let size = CALLS_PER_TX;
  if (built.length > 1 && (await codeHash(env.sepolia, env.multicall, at)) !== MULTICALL3_CODE_HASH) {
    notes.push(`${env.multicall} does not hold Multicall3's code on this chain: each call is a transaction of its own.`);
    size = 1;
  }
  checks.set("nonce", "checking", `used(${lock.nonce}) is ${minter.used}; dry-running the plan on ${env.chain ?? "Sepolia"}`);
  let txs = chunk(env, built, size);
  let dry = await dryRun(ctx, txs);
  while (!dry.ok && dry.overCap && size > 1) {
    size -= 1;
    txs = chunk(env, built, size);
    dry = await dryRun(ctx, txs);
  }
  describe(ctx, txs);
  const planned = txs.map((t) => t.tx);
  const why = path === "selfRelay" && planned.length > 1 ? `${choice.why} ${plural(planned.length, "transaction")}, sent one after the other.` : choice.why;
  if (!dry.ok) {
    if (dry.overCap) throw new PlanError(`every call alone needs more gas than ${env.chain ?? "Sepolia"} allows in one transaction`);
    const r = dry.revert;
    const status = statusOf(r.name);
    const where = planned.length > 1 ? `transaction ${r.tx + 1}` : "the transaction";
    const inCall = r.call === null ? "" : `, call ${r.call + 1} (${planned[r.tx]?.calls[r.call]?.method ?? "?"})`;
    checks.set("nonce", "failed", `the dry run of ${where} reverted${inCall}: ${r.text}`);
    return done(status, status === "minted" ? `Lock ${lock.nonce} is minted already: the dry run reverted ${r.text}.` : `The dry run of ${where} reverted${inCall}: ${r.text}.`, { path, txs: planned, target, revert: r });
  }
  await l1Parts(ctx, planned);
  checks.set(
    "nonce",
    "passed",
    `used(${lock.nonce}) is false, and the dry run passed` + (planned.length > 1 ? (planned.every((t) => t.gas !== null) ? " for every transaction, in order" : " for the first transaction") : ""),
  );
  return done("ready", why, { path, txs: planned, target });
}
