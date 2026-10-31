// The Verify page's core: one transfer checked in this browser, from the chains' public nodes, step
// by step, each step a check the contracts make. The way in, from the mint the destination took:
//   1 header     the header it carried hashes to block B, the block the justification finalizes
//   2 keys       the destination's light client holds B's validator set: the keys it checked
//   3 sigs       more than two thirds of them signed B, by the client's own ed25519 rules
//   4 proof      the lock's commitment sits in the vault's child trie under B's state root
//   5 commit     it is the commitment of exactly this lock
//   6 accepted   the destination's contracts took the same bytes and minted once: its receipt, and
//                the same calldata sent again just now as a read, which stops only at the nonce
// A lock not minted yet runs 1 to 5 on a proof read from V3 now, and 6 becomes the planner's dry
// run. The way back: the burn (B1), its id (B2), released[burnId] proven at V3's finalized head
// (B3), and the release itself, which nothing checks (B4). On demand, the light client's key history
// from its checkpoint. Read-only: eth_call and eth_get*, and the V3 node's header, state and
// finality calls; nothing is signed or sent. The endpoints and contracts come in as arguments
// (VerifyEnv), so node --test runs this against fakes.

import { decode, encodeCall, type AbiRegistry, type AbiValue } from "../abi.ts";
import { importArgs, lockProofOf, SIG, type LockProofArg } from "../calls.ts";
import { checksum } from "../display.ts";
import { formatInt, formatUnits } from "../format.ts";
import { blake2b256, eventTopic, keccak256, selector } from "../hashes.ts";
import { bytesToHex, concatBytes, equalBytes, hexToBytes, type Hex } from "../hex.ts";
import { searchLogs, type FoundLog, type LogSearch } from "../logs.ts";
import { burnId as burnIdOf, lockCommitment, LOCK_TAG } from "../proofs.ts";
import { AllFailed, NodeError, request, SubstrateClient, TransportError, type Answer, type Endpoint, type RequestOptions } from "../rpc.ts";
import { precommitPayload } from "../scale.ts";
import { abiEncode, AGGREGATE3_SIG, importHeaderCalldata, MINT_SIG } from "./calldata.ts";
import { authorityChange, signersHint, threshold, verifyJustification, type ClientCrypto, type JustificationResult } from "./grandpa.ts";
import type { LockRef, MintPlan } from "./plan.ts";
import { accountInfoKey, childItems, childRootKey, commitmentKey, decodeContractInfo } from "./revive.ts";
import { decodeAuthorityList, decodeFinalityProof, decodeGrandpaLog, decodeHeader, decodeJustification, decodeU64, encodeRpcHeader, ScaleError, type Header, type Justification, type RpcHeader } from "./scale.ts";
import { revertOf, TX_GAS_CAP, type Revert } from "./sepolia.ts";
import { provenValue, readProof, TrieProofError } from "./trie.ts";
import { GRANDPA_SET_ID_KEY, V3Error, V3Reader, type SetChange } from "./v3.ts";
import { noFacts, stepTitles, waitingStep, type Ev, type Facts, type Line, type Raw, type Run, type Step, type StepKey, type StepState, type Val } from "./verdict.ts";

export type { Ev, Facts, Line, Raw, Run, Step, StepKey, StepState, Val } from "./verdict.ts";

// ---------------------------------------------------------------------------------------------
// The environment: the destination's endpoints and contracts, V3's node, the records' fallbacks

export interface DestEnv {
  key: string;
  /** "Sepolia", "Base Sepolia": in running text. */
  name: string;
  chainId: bigint;
  /** State reads, in order: the keys are asked of the first two that answer, and compared. */
  rpcs: Endpoint[];
  /** Transactions and receipts, an old one's included. */
  history: Endpoint[];
  /** Endpoints that serve the state at an old block; none on Arbitrum Sepolia. */
  archive: Endpoint[];
  /** eth_getLogs over a wide range, for an import the records lack. */
  logs: Endpoint[];
  lightClient: Hex;
  minter: Hex;
  /** The light client's deployment block: where its logs start. */
  clientFrom: number;
  /** The key that deployed the light client and installed its checkpoint, as the records hold it: what its admin() should answer. */
  deployer: Hex;
  explorer: { name: string; tx: (h: string) => string; address: (a: string) => string; block: (n: number) => string };
}

export interface VerifyEnv {
  dest: DestEnv;
  v3: SubstrateClient;
  v3Evm: Endpoint[];
  vault: Hex;
  /** The vault's deployment block: where its logs start. */
  vaultFrom: number;
  v3ChainId: bigint;
  /** V3's genesis hash as the records hold it. */
  genesis: Hex;
  registry: AbiRegistry;
  /** The vault's trie id and code hash as the records hold them: used when the minter's are not read. */
  recordedVault: { trieId: Hex; codeHash: Hex; from: string };
  /** A V3 block in the Node Console. */
  v3Block: (n: number) => string;
  crypto: () => Promise<ClientCrypto>;
  /** The import that brought a V3 block into this destination's client, as the records hold it. */
  importOf: (hash: Hex) => { tx: Hex; block: number | null; from: string } | null;
  /** The planner's dry run of a lock's mint: for a lock not minted yet, and (evenIfMinted) for a minted one whose mint is not served. */
  plan: ((lock: LockRef, opts: { evenIfMinted: boolean }) => Promise<MintPlan>) | null;
}

/** How the run reports itself. */
export interface Out {
  emit(run: Run): void;
  stopped(): boolean;
}

export class VerifyError extends Error {
  override name = "VerifyError";
}

class Stopped extends Error {}

// ---------------------------------------------------------------------------------------------
// Words

const n = (x: number | bigint): string => formatInt(x);
/** 0x9eba…7e35: hashes and addresses in running text, 6…4. */
export const sh = (h: string): string => (h.length > 13 ? `${h.slice(0, 6)}…${h.slice(-4)}` : h);
const tpot = (units: bigint): string => `${formatUnits(units, 14)} tPOT`;
const errorText = (e: unknown): string => (e instanceof AllFailed ? e.problems.join("; ") : e instanceof Error ? e.message : String(e));
const plural = (k: number, one: string): string => `${k} ${one}${k === 1 ? "" : "s"}`;
const word = (v: bigint): Uint8Array => hexToBytes(`0x${v.toString(16).padStart(64, "0")}`);
const topicOf = (v: bigint): Hex => `0x${v.toString(16).padStart(64, "0")}`;
const qty = (v: number): Hex => `0x${Math.max(0, v).toString(16)}`;
const json = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 1);

/** An endpoint as a chip names it: publicnode, tenderly, sepolia.base.org, arbitrum.io, test-node-v3. */
export function nodeName(label: string): string {
  if (/publicnode/.test(label)) return "publicnode";
  if (/tenderly/.test(label)) return "tenderly";
  if (/drpc/.test(label)) return "drpc";
  if (/arbitrum\.io/.test(label)) return "arbitrum.io";
  if (/test-node-v3/.test(label)) return "test-node-v3";
  if (/test-evm-rpc-v3/.test(label)) return "V3 EVM RPC";
  return label.replace(/^https?:\/\/|^wss?:\/\//, "");
}

/**
 * One endpoint's failure, as AllFailed lists it ("<method>: <endpoint>: <problem>"), in plain words:
 * "publicnode did not answer in time", "drpc refused: its free plan does not serve this chain". An
 * answer the words do not cover is shown as the node gave it.
 */
function plainProblem(problem: string): string {
  const p = problem.replace(/^[a-z]+_\w+: /, "");
  const at = p.indexOf(": ");
  const who = at > 0 ? nodeName(p.slice(0, at)) : null;
  const what = at > 0 ? p.slice(at + 2) : p;
  const http = /HTTP (\d+)/.exec(what);
  const said = /free plan|paid plan|upgrade/i.test(what)
    ? "refused: its free plan does not serve this chain"
    : /no answer in|timed? ?out/i.test(what)
      ? "did not answer in time"
      : /HTTP 429|rate.?limit|too many requests/i.test(what)
        ? "refused: too many requests"
        : /unreachable|connection closed|could not open|no connection|failed to fetch/i.test(what)
          ? "did not answer"
          : http
            ? `answered HTTP ${http[1]}`
            : what === "no data"
              ? "had nothing to give"
              : null;
  return who ? (said ? `${who} ${said}` : `${who}: ${what}`) : (said ?? what);
}

/** Why a read failed, in plain words, each endpoint once; the raw message goes in the step's raw data. */
export function plainWhy(e: unknown): string {
  if (e instanceof AllFailed) return [...new Set(e.problems.map(plainProblem))].join("; ");
  if (e instanceof TransportError) return plainProblem(`${e.endpoint.label}: ${e.message}`);
  return errorText(e);
}

const TOPIC = {
  locked: eventTopic("Locked(uint256,address,address,uint256,address,uint256,bytes32)"),
  headerImported: eventTopic("HeaderImported(bytes32,uint32,bytes32,uint64,uint256)"),
  burnRequested: eventTopic("BurnRequested(uint256,address,address,uint256,bytes32)"),
  initialized: eventTopic("Initialized(bytes32,uint64,bytes32,uint32,bytes32)"),
  paused: eventTopic("Paused(address,string)"),
  unpaused: eventTopic("Unpaused(address)"),
  reinitialized: eventTopic("Reinitialized(address,bytes32,uint64,uint32,bytes32,string)"),
  halted: eventTopic("Halted(uint32,bytes32,uint8)"),
  adminTransferred: eventTopic("AdminTransferred(address,address)"),
};

/** NonceAlreadyUsed(n)'s revert data: what a replay of a mint answers once it is minted. */
export const nonceUsedData = (nonce: bigint): Hex => `${selector("NonceAlreadyUsed(uint256)")}${nonce.toString(16).padStart(64, "0")}` as Hex;

// ---------------------------------------------------------------------------------------------
// The calldata a mint carries

/**
 * A light-client import's arguments: the header, the proof as sent (importHeader's justification,
 * or the FinalityProof), the justification in it, the FinalityProof's block (none for
 * importHeader) and the signers hint.
 */
export interface ImportCall {
  method: "importHeader" | "importFinalityProof" | "importAndMint";
  header: Uint8Array;
  proof: Uint8Array;
  justification: Uint8Array;
  proofBlock: Uint8Array | null;
  unknownHeaders: number;
  signers: Uint8Array;
}

/** BridgeMinter.LockProof, as bytes. */
export interface LockProofBytes {
  blockHash: Uint8Array;
  accountProof: Uint8Array[];
  childRootProof: Uint8Array[];
  slotProof: Uint8Array[];
  recipient: Hex;
  amount: bigint;
  nonce: bigint;
}

export interface MintCall {
  method: "importAndMint" | "mint";
  /** Sent through Multicall3's aggregate3: a self-relay, with the set changes it imports first, in order. */
  multicall: boolean;
  setChanges: ImportCall[];
  /** importAndMint's import; null for mint(p), whose block the client held. */
  imported: ImportCall | null;
  p: LockProofBytes;
  /**
   * The minter's own calldata: the transaction's input, or the call inside aggregate3. A replay sends
   * this to the minter: Multicall3 would answer a failed call with its own Error("Multicall3: call
   * failed"), never NonceAlreadyUsed(n); neither contract reads msg.sender.
   */
  data: Hex;
}

const proofBytes = (p: LockProofArg): LockProofBytes => ({
  blockHash: hexToBytes(p.blockHash),
  accountProof: p.accountProof.map(hexToBytes),
  childRootProof: p.childRootProof.map(hexToBytes),
  slotProof: p.slotProof.map(hexToBytes),
  recipient: p.recipient.toLowerCase() as Hex,
  amount: p.amount,
  nonce: p.nonce,
});

/** An import's arguments from its calldata, the justification unwrapped from a FinalityProof. */
export function importCallOf(input: string): ImportCall {
  const a = importArgs(input);
  const header = hexToBytes(a.header);
  const proof = hexToBytes(a.proof);
  const signers = hexToBytes(a.signersHint);
  if (a.method === "importHeader") return { method: a.method, header, proof, justification: proof, proofBlock: null, unknownHeaders: 0, signers };
  const fp = decodeFinalityProof(proof);
  return { method: a.method, header, proof, justification: fp.justification, proofBlock: fp.block, unknownHeaders: fp.unknownHeaders.length, signers };
}

/**
 * The import as the light client takes it on its own: importHeader, or importFinalityProof for an
 * importFinalityProof's or an importAndMint's, which imports through the same checks. Sent again as
 * a read, it returns the block: the client verifies a known header again and writes nothing.
 */
export function clientImportData(imp: ImportCall): Hex {
  if (imp.method === "importHeader") return bytesToHex(importHeaderCalldata(imp.header, imp.proof, imp.signers));
  return bytesToHex(concatBytes(hexToBytes(selector(SIG.importFinalityProof)), abiEncode([{ bytes: imp.header }, { bytes: imp.proof }, { bytes: imp.signers }])));
}

const aggregateCalls = (input: string): { target: string; data: Hex }[] =>
  (decode("(address,bool,bytes)[]", `0x${input.slice(10)}`)[0] as AbiValue[][]).map((c) => ({ target: String(c[0]).toLowerCase(), data: c[2] as Hex }));

/**
 * The mint a transaction sent to `minter`: importAndMint, mint(p), or either inside Multicall3's
 * aggregate3, with the light client's importHeader calls before it there (a self-relay's set
 * changes), its own calldata kept for the replay.
 */
export function decodeMintCall(input: string, minter: string, lightClient: string): MintCall {
  const sel = input.slice(0, 10).toLowerCase();
  const data = input.toLowerCase() as Hex;
  if (sel === selector(SIG.importAndMint)) {
    const a = importArgs(input);
    if (!a.lockProof) throw new VerifyError("importAndMint without its LockProof");
    return { method: "importAndMint", multicall: false, setChanges: [], imported: importCallOf(input), p: proofBytes(a.lockProof), data };
  }
  if (sel === selector(MINT_SIG)) {
    const [t] = decode("(bytes32,bytes[],bytes[],bytes[],address,uint256,uint256)", `0x${input.slice(10)}`);
    return { method: "mint", multicall: false, setChanges: [], imported: null, p: proofBytes(lockProofOf(t as AbiValue[])), data };
  }
  if (sel === selector(AGGREGATE3_SIG)) {
    const setChanges: ImportCall[] = [];
    for (const c of aggregateCalls(input)) {
      if (c.target === lightClient.toLowerCase() && c.data.slice(0, 10) === selector(SIG.importHeader)) setChanges.push(importCallOf(c.data));
      else if (c.target === minter.toLowerCase()) return { ...decodeMintCall(c.data, minter, lightClient), multicall: true, setChanges };
    }
    throw new VerifyError("the Multicall3 transaction makes no call to this BridgeMinter");
  }
  throw new VerifyError(`not a mint of this BridgeMinter (selector ${sel})`);
}

/** The import of block `hash` in a transaction that brought it into the client: an import, an importAndMint, or one inside aggregate3. */
export function importFrom(input: string, hash: Uint8Array): ImportCall {
  if (input.slice(0, 10).toLowerCase() === selector(AGGREGATE3_SIG)) {
    for (const c of aggregateCalls(input)) {
      try {
        return importFrom(c.data, hash);
      } catch {
        // another call of the aggregate
      }
    }
    throw new VerifyError(`no call in the Multicall3 transaction imports ${sh(bytesToHex(hash))}`);
  }
  const imp = importCallOf(input);
  const got = blake2b256(imp.header);
  if (!equalBytes(got, hash)) throw new VerifyError(`its header hashes to ${sh(bytesToHex(got))}, not ${sh(bytesToHex(hash))}`);
  return imp;
}

// ---------------------------------------------------------------------------------------------
// The checks, on bytes in hand

export interface Problem {
  text: string;
  expected?: string;
  found?: string;
}

const problemOf = (e: unknown): Problem => ({ text: errorText(e) });

export interface HeaderCheck {
  header: Header | null;
  hash: Uint8Array;
  j: Justification | null;
  problem: Problem | null;
}

/**
 * Step 1: the header's blake2b-256 is the block the justification finalizes (its target hash and
 * number), the FinalityProof's block, and the block the storage proofs name (`blockHash`), as the
 * light client and the minter require (HeaderHashMismatch, TargetNumberMismatch,
 * FinalityProofBlockMismatch, BlockMismatch).
 */
export function checkHeader(imp: ImportCall, blockHash: Uint8Array): HeaderCheck {
  const hash = blake2b256(imp.header);
  const h = bytesToHex(hash);
  let header: Header;
  let j: Justification;
  try {
    header = decodeHeader(imp.header);
  } catch (e) {
    return { header: null, hash, j: null, problem: { text: `the header does not decode: ${errorText(e)}` } };
  }
  try {
    j = decodeJustification(imp.justification);
  } catch (e) {
    return { header, hash, j: null, problem: { text: `the justification does not decode: ${errorText(e)}` } };
  }
  const target = bytesToHex(j.targetHash);
  let problem: Problem | null = null;
  if (imp.unknownHeaders) problem = { text: `the finality proof carries ${imp.unknownHeaders} unknown headers, which the client refuses` };
  else if (target !== h) problem = { text: `the header hashes to ${sh(h)}, the signatures finalize ${sh(target)}`, expected: target, found: h };
  else if (j.targetNumber !== header.number) problem = { text: `the signatures finalize #${n(j.targetNumber)}, the header is #${n(header.number)}`, expected: `#${n(j.targetNumber)}`, found: `#${n(header.number)}` };
  else if (imp.proofBlock && !equalBytes(imp.proofBlock, hash)) problem = { text: `the finality proof is for ${sh(bytesToHex(imp.proofBlock))}, the header hashes to ${sh(h)}`, expected: bytesToHex(imp.proofBlock), found: h };
  else if (!equalBytes(blockHash, hash)) problem = { text: `the storage proofs are for ${sh(bytesToHex(blockHash))}, the header is ${sh(h)}`, expected: h, found: bytesToHex(blockHash) };
  return { header, hash, j, problem };
}

/** keccak256 of a key list, packed: the light client's listHash of a set. */
export const keysHash = (keys: Uint8Array[]): Hex => bytesToHex(keccak256(concatBytes(...keys)));

export interface SigCheck {
  result: JustificationResult;
  /** The signers hint recomputed here; null when the justification does not verify. */
  hint: Uint8Array | null;
  problem: Problem | null;
}

/**
 * Step 3: every precommit signed by a distinct member of set `setId` under `keys`, on the commit
 * target, with the client's own ed25519 check, at least threshold(N) of them; then the signers hint
 * recomputed and compared with the one the transaction sent (`given`).
 */
export function checkSignatures(j: Justification, keys: Uint8Array[], setId: bigint, crypto: ClientCrypto, given: Uint8Array | null): SigCheck {
  const result = verifyJustification(j, keys, setId, crypto.verify);
  if (!result.ok) return { result, hint: null, problem: { text: result.problems[0] ?? "the justification does not verify" } };
  const hint = signersHint(j, keys, setId, crypto.verify).hint;
  if (given && !equalBytes(hint, given)) return { result, hint, problem: { text: "the mint named other precommits", expected: bytesToHex(hint), found: bytesToHex(given) } };
  return { result, hint, problem: null };
}

export interface StorageCheck {
  childRoot: Uint8Array | null;
  value: Uint8Array | null;
  /** A first mint's bind: the trie id and code hash Revive.AccountInfoOf(vault) names. */
  bind: { trieId: Uint8Array; codeHash: Uint8Array } | null;
  problem: Problem | null;
}

/**
 * The bind of a minter's first mint: the vault's AccountInfoOf entry, proven under `stateRoot`,
 * names the trie id the minter stored and the code hash it was deployed for (bindVault, its
 * VaultCodeMismatch). The minter reads the account proof only while it is not bound.
 */
export function checkBind(stateRoot: Uint8Array, p: LockProofBytes, trieId: Uint8Array, vault: Hex, codeHash: Uint8Array | null): { bind: StorageCheck["bind"]; problem: Problem | null } {
  try {
    const bind = decodeContractInfo(provenValue(stateRoot, p.accountProof, accountInfoKey(vault), "account"));
    if (codeHash && !equalBytes(bind.codeHash, codeHash)) return { bind, problem: { text: `the vault's entry names code hash ${sh(bytesToHex(bind.codeHash))}`, expected: bytesToHex(codeHash), found: bytesToHex(bind.codeHash) } };
    if (!equalBytes(bind.trieId, trieId)) return { bind, problem: { text: `the vault's entry names trie id ${sh(bytesToHex(bind.trieId))}`, expected: bytesToHex(trieId), found: bytesToHex(bind.trieId) } };
    return { bind, problem: null };
  } catch (e) {
    if (e instanceof TrieProofError || e instanceof ScaleError) return { bind: null, problem: problemOf(e) };
    throw e;
  }
}

/**
 * Step 4: from `stateRoot`, the vault's child-trie root under ":child_storage:default:" ++ trie id,
 * then the word at commitments[nonce] under it, every item used; with `bind` (a first mint, the one
 * that bound the minter), first the vault's AccountInfoOf entry naming that trie id and the code hash
 * the minter was deployed for. By default the account proof is read whenever the mint carries one.
 */
export function checkStorage(stateRoot: Uint8Array, p: LockProofBytes, trieId: Uint8Array, vault: Hex, codeHash: Uint8Array | null, bind = p.accountProof.length > 0): StorageCheck {
  let bound: StorageCheck["bind"] = null;
  if (bind) {
    const c = checkBind(stateRoot, p, trieId, vault, codeHash);
    if (c.problem) return { childRoot: null, value: null, bind: c.bind, problem: c.problem };
    bound = c.bind;
  }
  try {
    const childRoot = provenValue(stateRoot, p.childRootProof, childRootKey(trieId), "child-root");
    if (childRoot.length !== 32 || childRoot.every((b) => b === 0)) return { childRoot, value: null, bind: bound, problem: { text: "the child root is not 32 non-zero bytes" } };
    const value = provenValue(childRoot, p.slotProof, commitmentKey(p.nonce), "slot");
    return { childRoot, value, bind: bound, problem: null };
  } catch (e) {
    if (e instanceof TrieProofError || e instanceof ScaleError) return { childRoot: null, value: null, bind: bound, problem: problemOf(e) };
    throw e;
  }
}

export interface LockFieldsOf {
  v3ChainId: bigint;
  vault: Hex;
  dstChainId: bigint;
  minter: Hex;
}

/** Step 5: the proven word is the commitment of exactly this lock's fields, for this destination's minter (the minter's CommitmentMismatch). */
export function checkCommitment(c: LockFieldsOf, p: LockProofBytes, value: Uint8Array): { expected: Hex; problem: Problem | null } {
  const expected = lockCommitment({ v3ChainId: c.v3ChainId, vault: c.vault, dstChainId: c.dstChainId, minter: c.minter, recipient: p.recipient, amountNative: p.amount, nonce: p.nonce });
  const found = bytesToHex(value);
  return { expected, problem: expected === found ? null : { text: `commitments[${p.nonce}] holds ${sh(found)}; this lock's fields give ${sh(expected)}`, expected, found } };
}

/** The eight words the commitment hashes, for the raw data. */
export const commitmentWords = (c: LockFieldsOf, p: LockProofBytes): Hex[] =>
  [hexToBytes(LOCK_TAG), word(c.v3ChainId), word(BigInt(c.vault)), word(c.dstChainId), word(BigInt(c.minter)), word(BigInt(p.recipient)), word(p.amount), word(p.nonce)].map(bytesToHex);

/** A log as a receipt gives it. */
export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber?: string;
  transactionHash?: string;
}

export interface MintLogsCheck {
  lines: Line[];
  problem: Problem | null;
}

/** Whether a mint's receipt has the minter's VaultBound: the mint that bound it, whose account proof the minter read. */
export const boundIn = (logs: RawLog[], minter: Hex, registry: AbiRegistry): boolean =>
  logs.some((l) => l.address.toLowerCase() === minter.toLowerCase() && registry.decodeLog(l)?.name === "VaultBound");

/**
 * Step 6's receipt: the light client's HeaderImported of block B (for an importAndMint) with its
 * number, state root and set, and one for each set change a self-relay imported before it
 * (`changes`, their block hashes, in order); VaultBound on a first mint, the token's Transfer, and
 * the minter's Minted(nonce, recipient, amount, B), each matched with steps 1 to 5.
 */
export function checkMintLogs(
  logs: RawLog[],
  x: { minter: Hex; lightClient: Hex; block: Hex; number: number; stateRoot: Hex; setId: bigint | null; p: LockProofBytes; imported: boolean; changes?: Hex[] },
  registry: AbiRegistry,
): MintLogsCheck {
  const lines: Line[] = [];
  const decoded = logs.map((l) => ({ l, d: registry.decodeLog(l) }));
  const arg = (d: { args: { name: string; value: AbiValue }[] }, name: string) => d.args.find((a) => a.name === name)?.value;
  const eq = (v: AbiValue | undefined, w: string | bigint) => (typeof v === "string" && typeof w === "string" ? v.toLowerCase() === w.toLowerCase() : v === w);
  const minted = decoded.find(({ l, d }) => d?.name === "Minted" && l.address.toLowerCase() === x.minter && eq(arg(d, "nonce"), x.p.nonce));
  if (!minted?.d) return { lines, problem: { text: `the receipt has no Minted log for nonce ${x.p.nonce}` } };
  if (!eq(arg(minted.d, "blockHash"), x.block)) return { lines, problem: { text: `the Minted log names block ${sh(String(arg(minted.d, "blockHash")))}, not ${sh(x.block)}` } };
  if (!eq(arg(minted.d, "recipient"), x.p.recipient) || !eq(arg(minted.d, "amount"), x.p.amount)) return { lines, problem: { text: "the Minted log names another recipient or amount" } };
  // A self-relay's receipt has a HeaderImported for each set change before the block's own: each is found by its block.
  const imports = decoded.filter(({ l, d }) => d?.name === "HeaderImported" && l.address.toLowerCase() === x.lightClient);
  const importOf = (hash: Hex) => imports.find(({ d }) => d && eq(arg(d, "blockHash"), hash))?.d ?? null;
  for (const [i, hash] of (x.changes ?? []).entries()) {
    const c = importOf(hash);
    lines.push(
      c
        ? { ok: true, text: `HeaderImported(#${n(Number(arg(c, "number")))}, set ${String(arg(c, "setId"))}): set change ${i + 1} of ${x.changes?.length}, imported first` }
        : { ok: false, text: `no HeaderImported log names set change ${i + 1}, ${sh(hash)}, which the transaction imported first` },
    );
  }
  if (x.imported) {
    const hi = importOf(x.block);
    if (!hi) return { lines, problem: { text: imports.length ? `no HeaderImported log names block ${sh(x.block)}` : "the receipt has no HeaderImported log, which importAndMint makes" } };
    const ok = eq(arg(hi, "number"), BigInt(x.number)) && eq(arg(hi, "stateRoot"), x.stateRoot) && (x.setId === null || eq(arg(hi, "setId"), x.setId));
    if (!ok) return { lines, problem: { text: "the HeaderImported log names another number, state root or set" } };
    lines.push({ ok: true, text: `HeaderImported(#${n(x.number)}, set ${String(arg(hi, "setId"))}, ${String(arg(hi, "signatures"))} signatures): the same block, state root and set` });
  }
  // Only the mint that bound the minter has VaultBound; a later one may carry an account proof too, which the minter does not read.
  if (boundIn(logs, x.minter, registry)) lines.push({ ok: true, text: "VaultBound: this first mint bound the minter to the vault" });
  const tr = decoded.find(({ d }) => d?.name === "Transfer" && eq(arg(d, "to"), x.p.recipient) && eq(arg(d, "value"), x.p.amount));
  lines.push(tr ? { ok: true, text: `Transfer of ${tpot(x.p.amount).replace("tPOT", "wtPOT")} to ${sh(checksum(x.p.recipient))}` } : { ok: false, text: "no Transfer of the amount to the recipient" });
  lines.push({ ok: true, text: `Minted(${x.p.nonce}, ${sh(checksum(x.p.recipient))}, ${formatUnits(x.p.amount, 14)}, ${sh(x.block)}): this lock, this block` });
  return { lines, problem: null };
}

export type ReplayOutcome = { kind: "used" } | { kind: "paused"; name: string } | { kind: "other"; text: string } | { kind: "none" };

/** What a replay of the mint answered: NonceAlreadyUsed(nonce) byte for byte, the client paused or halted, another error, or no revert at all. */
export function replayOutcome(revert: Revert | null, nonce: bigint): ReplayOutcome {
  if (!revert) return { kind: "none" };
  if (revert.data?.toLowerCase() === nonceUsedData(nonce)) return { kind: "used" };
  const name = revert.error?.name ?? null;
  if (name === "ClientPaused" || name === "ClientHalted") return { kind: "paused", name };
  return { kind: "other", text: revert.text };
}

/** The child-trie key of released[burnId]: blake2_256(keccak256(abi.encode(burnId, 3))), the vault's slot 3. */
export const releasedKey = (burnId: Hex): Uint8Array => blake2b256(keccak256(concatBytes(hexToBytes(burnId), word(3n))));

/** A proven storage word, as a number: 1 for a mapping's true. */
export const wordValue = (v: Uint8Array | null): bigint => (v && v.length ? BigInt(bytesToHex(v)) : 0n);

// ---------------------------------------------------------------------------------------------
// Reads

type Got<T> = { ok: true; value: T; ep: Endpoint } | { ok: false; why: string; revert: Revert | null; ep: Endpoint | null };

const answered = <T>(g: Got<T>): boolean => g.ok || g.revert !== null;

/** The reads made to find what an id is, before its run: counted in; `floor` when a lookup searched logs in windows it did not count one by one. */
export interface Looked {
  reads: number;
  floor: boolean;
}

/** The run's reads: counted (from the lookup's on), each one's endpoint kept. */
class Reads {
  count: number;
  readonly floor: boolean;
  readonly eps = new Set<string>();
  private readonly env: VerifyEnv;

  constructor(env: VerifyEnv, looked?: Looked) {
    this.env = env;
    this.count = looked?.reads ?? 0;
    this.floor = looked?.floor ?? false;
  }

  async eth<T>(eps: Endpoint[], method: string, params: unknown[], opts: RequestOptions = {}): Promise<Got<T>> {
    this.count++;
    try {
      const a = await request<T>(eps, method, params, { timeoutMs: 15_000, ...opts });
      this.eps.add(a.endpoint.label);
      return { ok: true, value: a.result, ep: a.endpoint };
    } catch (error) {
      if (error instanceof NodeError && error.isRevert) {
        this.eps.add(error.endpoint.label);
        return { ok: false, why: error.message, revert: revertOf(error.data, error.message, this.env.registry), ep: error.endpoint };
      }
      return { ok: false, why: errorText(error), revert: null, ep: null };
    }
  }

  call(eps: Endpoint[], to: string, sig: string, args: (bigint | number | string | boolean)[] = []): Promise<Got<Hex>> {
    return this.eth<Hex>(eps, "eth_call", [{ to, data: encodeCall(sig, args) }, "latest"]);
  }

  /** The same call to the first two endpoints, each asked once more when it fails, and a third when one of them does not answer. */
  async two<T>(eps: Endpoint[], method: string, params: unknown[]): Promise<Got<T>[]> {
    const out = await Promise.all(eps.slice(0, 2).map((ep) => this.eth<T>([ep], method, params, { retries: 1 })));
    for (const ep of eps.slice(2)) {
      if (out.filter(answered).length >= 2) break;
      out.push(await this.eth<T>([ep], method, params, { retries: 1 }));
    }
    return out;
  }

  async v3<T>(method: string, params: unknown[], timeoutMs = 15_000): Promise<Got<T>> {
    this.count++;
    try {
      const a = await this.env.v3.request<T>(method, params, timeoutMs);
      this.eps.add(a.endpoint.label);
      return { ok: true, value: a.result, ep: a.endpoint };
    } catch (error) {
      return { ok: false, why: errorText(error), revert: null, ep: null };
    }
  }

  /** A log search in windows (../logs.ts), each eth_getLogs call it makes counted. */
  logs(eps: Endpoint[], filter: { address: string; topics: (string | string[] | null)[] }, from: number, head: number, opts: { maxCalls?: number; first?: boolean; order?: "newest" | "oldest" }): Promise<LogSearch<FoundLog>> {
    return searchLogs(eps, filter, from, head, { ...opts, onCall: () => this.count++ });
  }
}

const callText = (method: string, params: unknown[], ep: Endpoint | null): string => `${method}(${params.map((p) => json(p).replace(/\s+/g, " ")).join(", ")})${ep ? ` · ${ep.label}` : ""}`;
const pruned = (why: string): boolean => /discard|prun|not available|missing trie node|unknown block|state.*not found/i.test(why);

/** The nodes whose answers a step read just now, by name, each once: a revert is an answer too. */
const fromOf = (...gots: ({ ep: Endpoint | null } | null | undefined)[]): string[] => [...new Set(gots.flatMap((g) => (g?.ep ? [nodeName(g.ep.label)] : [])))];

/** The V3 node, by name, for a step that read it through V3Reader. */
const v3Name = (env: VerifyEnv): string => nodeName(env.v3.http?.label ?? env.v3.wsEndpoint.label);

// ---------------------------------------------------------------------------------------------
// The board: the steps, settled in order

type Patch = Partial<Omit<Step, "key" | "title">> & { state: StepState };

class Board {
  readonly run: Run;
  private readonly t0 = performance.now();
  private readonly out: Out;
  private readonly reads: Reads;

  constructor(dir: Run["dir"], route: Run["route"], titles: readonly (readonly [StepKey, string])[], out: Out, reads: Reads) {
    this.out = out;
    this.reads = reads;
    this.run = { dir, route, steps: titles.map(waitingStep), done: false, ms: 0, reads: reads.count, readsFloor: reads.floor, endpoints: [], disagree: false, usedUnread: false, facts: noFacts() };
  }

  emit(): void {
    if (this.out.stopped()) throw new Stopped();
    this.run.ms = performance.now() - this.t0;
    this.run.reads = this.reads.count;
    this.run.endpoints = [...this.reads.eps];
    // A red cross-check under a step that did not fail: the verdict says so, whatever the checks found.
    this.run.disagree = this.run.steps.some((s) => s.state !== "failed" && s.lines.some((l) => l.ok === false));
    this.out.emit({ ...this.run, steps: this.run.steps.map((s) => ({ ...s })), facts: { ...this.run.facts } });
  }

  step(key: StepKey): Step {
    const s = this.run.steps.find((x) => x.key === key);
    if (!s) throw new Error(`no step ${key}`);
    return s;
  }

  checking(key: StepKey): void {
    this.step(key).state = "checking";
    this.emit();
  }

  /**
   * Settles a step, in order; its time is the check's own when the patch gives one. After a failure
   * the steps below are not reached, except the release itself, which is trusted whatever the
   * checks above it say.
   */
  settle(key: StepKey, patch: Patch): void {
    const s = this.step(key);
    Object.assign(s, { ms: null }, patch);
    if (patch.state === "failed") {
      for (const x of this.run.steps.slice(this.run.steps.indexOf(s) + 1)) {
        if (x.key !== "release" && (x.state === "waiting" || x.state === "checking")) Object.assign(x, { state: "unreached", sub: "Not reached" });
      }
    }
    this.emit();
  }

  failed(): boolean {
    return this.run.steps.some((s) => s.state === "failed");
  }

  finish(): void {
    this.run.done = true;
    this.emit();
  }
}

const TRUST = {
  keys: (admin: string) =>
    `Trust: the client's checkpoint, which its admin (${admin}) installed, and each set change since, imported only with the signatures of the set before. The destination's RPCs answer these reads; this page does not verify that chain's consensus.`,
  sigs: "Trust: step 2's keys. The ed25519 code is @noble/curves 2.4.0, run with the light client's own acceptance rules.",
  proof: "Trust: the state root, through steps 1 to 3. V3's runtime sets what its storage holds, and V3's sudo key can change any of it.",
  /** The destination and its RPCs: the mint's acceptance on the way in, the burn on the way back. */
  chain: (chain: string) => `Trust: ${chain} and its public RPCs, read here, not verified. The explorer link gives a third view.`,
  released: "Trust: the same as steps 1 to 4 of the way in: the light client's set, V3's validators and its sudo key.",
  release: "Trusted: 2 of 3 committee members approved it through pallet-multisig. Nothing on V3 checks the burn; on the testnet one operator holds all three keys.",
};

/** The client's admin in words, from admin() as read: its deployer, another key, or the records' word when not answered. */
function adminWords(read: Hex | null, deployer: Hex): string {
  if (!read) return `its deployer, ${sh(checksum(deployer))}, as recorded`;
  return read === deployer.toLowerCase() ? `its deployer, ${sh(checksum(deployer))}` : sh(checksum(read));
}

/** admin() of the client on `d`, as read with a step's reads: its line, its raw data, and the address. */
function adminRead(d: DestEnv, g: Got<Hex>): { line: Line; raw: Raw; admin: Hex | null } {
  let admin: Hex | null = null;
  try {
    admin = g.ok ? ((decode("address", g.value)[0] as string).toLowerCase() as Hex) : null;
  } catch {
    // Not an address: as not answered.
  }
  const raw = { label: "GrandpaLightClient.admin()", call: callText("eth_call", [{ to: d.lightClient, data: encodeCall("admin()") }, "latest"], g.ep), value: g.ok ? g.value : g.why };
  const deployer = d.deployer.toLowerCase();
  const line: Line = !admin
    ? { ok: null, text: `admin(): not answered by ${d.name}'s RPCs; the records name its deployer, ${sh(checksum(deployer))}` }
    : admin === deployer
      ? { ok: true, text: `admin() = ${sh(checksum(admin))}, its deployer, who installed the checkpoint` }
      : { ok: false, text: `admin() = ${sh(checksum(admin))}, not its deployer ${sh(checksum(deployer))}: the client has another admin` };
  return { line, raw, admin };
}

// ---------------------------------------------------------------------------------------------
// Shared pieces of the runs

type HeldValue = { number: number; stateRoot: Hex; setId: bigint };

interface Held {
  answers: Got<Hex>[];
  /** The number, state root and set the client stores for the block, as the RPCs that answered give it. */
  value: HeldValue | null;
  /** The RPCs that answered it, by name. */
  who: string[];
  /** Two RPCs answered another number, state root or set: what differs, and each one's value. */
  differ: { what: string; expected: string; found: string } | null;
  /** A node answered UnknownBlock. */
  unknown: boolean;
}

/** headerOf(block) on the client, asked of two RPCs: every answer decoded and compared, as the keys are. */
async function readHeld(reads: Reads, d: DestEnv, block: Hex): Promise<Held> {
  const answers = await reads.two<Hex>(d.rpcs, "eth_call", [{ to: d.lightClient, data: encodeCall("headerOf(bytes32)", [block]) }, "latest"]);
  const values = answers.flatMap((a): { v: HeldValue; ep: Endpoint }[] => {
    if (!a.ok) return [];
    const [[num, root, set]] = decode("(uint32,bytes32,uint64)", a.value) as [[bigint, Hex, bigint]];
    return [{ v: { number: Number(num), stateRoot: root.toLowerCase() as Hex, setId: set }, ep: a.ep }];
  });
  const first = values[0]?.v ?? null;
  let differ: Held["differ"] = null;
  for (const { v } of values.slice(1)) {
    if (!first || differ) break;
    if (v.stateRoot !== first.stateRoot) differ = { what: "state roots", expected: first.stateRoot, found: v.stateRoot };
    else if (v.number !== first.number) differ = { what: "numbers", expected: `#${n(first.number)}`, found: `#${n(v.number)}` };
    else if (v.setId !== first.setId) differ = { what: "sets", expected: `set ${first.setId}`, found: `set ${v.setId}` };
  }
  return { answers, value: first, who: values.map((x) => nodeName(x.ep.label)), differ, unknown: answers.some((a) => !a.ok && a.revert?.error?.name === "UnknownBlock") };
}

interface KeysRead {
  answers: Got<Hex>[];
  keys: Uint8Array[] | null;
  /** Two RPCs answered other keys. */
  differ: boolean;
}

async function readKeys(reads: Reads, d: DestEnv, setId: bigint): Promise<KeysRead> {
  const answers = await reads.two<Hex>(d.rpcs, "eth_call", [{ to: d.lightClient, data: encodeCall("authorities(uint64)", [setId]) }, "latest"]);
  const lists = answers.flatMap((a) => (a.ok ? [(decode("bytes32[]", a.value)[0] as Hex[]).map((k) => k.toLowerCase())] : []));
  const first = lists[0];
  return { answers, keys: first ? first.map((k) => hexToBytes(k)) : null, differ: lists.some((l) => l.join() !== first?.join()) };
}

/** authoritySetAt(i) of the client: the set's genesis, list hash, id and start, and its keys. */
interface SetAt {
  genesis: Hex;
  listHash: Hex;
  setId: bigint;
  activatedAt: number;
  keys: Hex[];
}

function decodeSetAt(data: Hex): SetAt {
  const [[genesis, listHash, setId, activatedAt], keys] = decode("(bytes32,bytes32,uint64,uint32),bytes32[]", data) as [[Hex, Hex, bigint, bigint], Hex[]];
  return { genesis: genesis.toLowerCase() as Hex, listHash: listHash.toLowerCase() as Hex, setId, activatedAt: Number(activatedAt), keys: keys.map((k) => k.toLowerCase() as Hex) };
}

const keyRows = (keys: Uint8Array[]): Ev[] => keys.map((k, i) => ({ k: `Key ${i}`, v: [{ t: "hash", full: bytesToHex(k), label: `validator key ${i}`, href: null }] }));

/**
 * The checkpoint as the page's "Where the keys come from" shows it: the client's set 0, the set
 * changes it imported since and the set they reached (by its set count; each change adds the next
 * set), and whether `keys` are the checkpoint's keys.
 */
const checkpointOf = (first: SetAt, sets: bigint | null, keys: Uint8Array[]): Facts["checkpoint"] => ({
  setId: first.setId,
  at: first.activatedAt,
  keysHash: first.listHash,
  keys: first.keys.length,
  changes: sets === null ? null : Number(sets) - 1,
  latest: sets === null ? null : first.setId + sets - 1n,
  same: first.listHash === keysHash(keys),
});

function digestText(h: Header): string {
  return h.digest
    .map((d) => {
      if (d.kind === "Consensus" && d.engine === "FRNK") {
        try {
          const l = decodeGrandpaLog(d.payload);
          return l.kind === "ScheduledChange" ? `Consensus FRNK: ScheduledChange to ${l.nextAuthorities.length} keys, delay ${l.delay}` : `Consensus FRNK: ${l.kind}`;
        } catch {
          return `Consensus FRNK: ${d.payload.length} bytes`;
        }
      }
      return `${d.kind}${d.engine ? ` ${d.engine}` : ""}: ${d.payload.length} bytes`;
    })
    .join("\n");
}

/** The keys and the set that signed `block` on the destination's client: step 2, for both routes. */
async function keysStep(
  b: Board,
  reads: Reads,
  env: VerifyEnv,
  x: {
    block: { number: number; hash: Hex };
    held: Held;
    /** The set the run takes as the signer, when the client does not hold the block (the way back, an unminted lock): its id. */
    setId: bigint | null;
    header: Header | null;
    lightClientP: Promise<Got<Hex>> | null;
    adminP: Promise<Got<Hex>>;
    genesisP: Promise<Got<Hex>>;
    v3GenesisP: Promise<Got<Hex | null>>;
    v3KeysP: Promise<Got<Hex>>;
    v3SetP: Promise<Got<Hex | null>>;
    set0P: Promise<Got<Hex>>;
  },
): Promise<{ keys: Uint8Array[]; setId: bigint } | null> {
  const d = env.dest;
  b.checking("keys");
  const raw: Raw[] = [];
  const lines: Line[] = [];
  const ev: Ev[] = [];
  const read: (Got<unknown> | null)[] = [...x.held.answers];
  const settle = (patch: Patch) => b.settle("keys", { ...patch, from: fromOf(...read) });
  // 1. The minter imports through this client, whose admin installed its checkpoint.
  if (x.lightClientP) {
    const lc = await x.lightClientP;
    read.push(lc);
    const addr = lc.ok ? (decode("address", lc.value)[0] as string).toLowerCase() : null;
    raw.push({ label: "BridgeMinter.lightClient()", call: callText("eth_call", [{ to: d.minter, data: encodeCall("lightClient()") }, "latest"], lc.ep), value: lc.ok ? lc.value : lc.why });
    if (addr && addr !== d.lightClient.toLowerCase()) {
      settle({ state: "failed", sub: `this minter checks another light client: ${sh(checksum(addr))}`, diff: { expected: checksum(d.lightClient), found: checksum(addr) }, raw });
      return null;
    }
    lines.push(addr ? { ok: true, text: `Light client ${sh(checksum(d.lightClient))} = BridgeMinter.lightClient()` } : { ok: null, text: `BridgeMinter.lightClient(): not answered by ${d.name}'s RPCs` });
  }
  const ad = await x.adminP;
  read.push(ad);
  const admin = adminRead(d, ad);
  b.run.facts.admin = admin.admin;
  raw.push(admin.raw);
  lines.push(admin.line);
  // 2. The set that finalized the block.
  for (const a of x.held.answers) raw.push({ label: `headerOf(#${n(x.block.number)})`, call: callText("eth_call", [{ to: d.lightClient, data: encodeCall("headerOf(bytes32)", [x.block.hash]) }, "latest"], a.ep), value: a.ok ? a.value : a.why });
  const setId = x.held.value?.setId ?? x.setId;
  if (setId === null) {
    settle({ state: "skipped", sub: `Not checked: no ${d.name} RPC answered headerOf(${sh(x.block.hash)})`, lines, raw, retry: true });
    return null;
  }
  // 3. The keys of that set, from two RPCs.
  const k = await readKeys(reads, d, setId);
  read.push(...k.answers);
  for (const a of k.answers) raw.push({ label: `authorities(${setId})`, call: callText("eth_call", [{ to: d.lightClient, data: encodeCall("authorities(uint64)", [setId]) }, "latest"], a.ep), value: a.ok ? a.value : a.why });
  if (!k.keys) {
    settle({ state: "skipped", sub: `Not checked: no ${d.name} RPC answered authorities(${setId})`, lines, raw, retry: true });
    return null;
  }
  if (k.differ) {
    settle({ state: "failed", sub: "the RPCs answer different keys", raw });
    return null;
  }
  const keys = k.keys;
  const need = threshold(keys.length);
  const agree = k.answers.filter((a) => a.ok);
  const asked = d.rpcs.slice(0, 2).map((e) => nodeName(e.label));
  const who = agree.map((a) => (a.ep ? nodeName(a.ep.label) : ""));
  lines.push(
    agree.length >= 2
      ? { ok: true, text: `${agree.length} RPCs agree: ${who.join(" and ")}` }
      : { ok: null, text: `Only ${who[0] ?? "one RPC"} answered authorities(${setId}); ${asked.find((x) => x !== who[0]) ?? "the second"} did not, so the keys are one RPC's word` },
  );
  // 4. The list hash: this set's, and the checkpoint's.
  const hash = keysHash(keys);
  const set0 = await x.set0P;
  read.push(set0);
  raw.push({ label: "authoritySetAt(0): the checkpoint's set", call: callText("eth_call", [{ to: d.lightClient, data: encodeCall("authoritySetAt(uint256)", [0]) }, "latest"], set0.ep), value: set0.ok ? set0.value : set0.why });
  const first = set0.ok ? decodeSetAt(set0.value) : null;
  if (first) {
    const [at, count] = await Promise.all([reads.call(d.rpcs, d.lightClient, "authoritySetAt(uint256)", [setId - first.setId]), reads.call(d.rpcs, d.lightClient, "authoritySetCount()")]);
    read.push(at, count);
    b.run.facts.checkpoint = checkpointOf(first, count.ok ? (decode("uint256", count.value)[0] as bigint) : null, keys);
    raw.push({ label: `authoritySetAt(${setId - first.setId}): set ${setId}`, call: callText("eth_call", [{ to: d.lightClient, data: encodeCall("authoritySetAt(uint256)", [setId - first.setId]) }, "latest"], at.ep), value: at.ok ? at.value : at.why });
    const set = at.ok ? decodeSetAt(at.value) : null;
    if (set && (set.setId !== setId || set.listHash !== hash)) {
      settle({ state: "failed", sub: `the client's set ${setId} entry does not name these keys`, diff: { expected: hash, found: set.listHash }, raw });
      return null;
    }
    lines.push(
      first.listHash === hash
        ? { ok: true, text: `The same keys as the checkpoint's (set ${first.setId} at V3 #${n(first.activatedAt)}) · keys hash ${sh(hash)}` }
        : { ok: null, text: `Other keys than the checkpoint's (set ${first.setId}): V3 rotated keys since; the key history below walks each change` },
    );
  } else lines.push({ ok: null, text: `authoritySetAt: not answered by ${d.name}'s RPCs` });
  // 5. The client follows this chain.
  const [gen, v3gen] = await Promise.all([x.genesisP, x.v3GenesisP]);
  read.push(gen, v3gen);
  const genesis = gen.ok ? (decode("bytes32", gen.value)[0] as string).toLowerCase() : null;
  const v3Genesis = v3gen.ok && v3gen.value ? v3gen.value.toLowerCase() : env.genesis;
  raw.push({ label: "genesisHash()", call: callText("eth_call", [{ to: d.lightClient, data: encodeCall("genesisHash()") }, "latest"], gen.ep), value: gen.ok ? gen.value : gen.why });
  if (genesis && genesis !== v3Genesis) {
    settle({ state: "failed", sub: `V3 was reset: the client follows genesis ${sh(genesis)}, V3's block 0 is ${sh(v3Genesis)}`, diff: { expected: v3Genesis, found: genesis }, raw });
    return null;
  }
  if (genesis) lines.push({ ok: true, text: `genesisHash() = V3's block 0, ${sh(v3Genesis)}${v3gen.ok ? "" : " (recorded: the V3 node did not answer)"}` });
  // 6. V3's own runtime at the block names the same set and keys.
  const [v3k, v3s] = await Promise.all([x.v3KeysP, x.v3SetP]);
  read.push(v3k, v3s);
  raw.push({ label: `GrandpaApi_grandpa_authorities at #${n(x.block.number)}`, call: callText("state_call", ["GrandpaApi_grandpa_authorities", "0x", x.block.hash], v3k.ep), value: v3k.ok ? String(v3k.value) : v3k.why });
  raw.push({ label: `Grandpa.CurrentSetId at #${n(x.block.number)}`, call: callText("state_getStorage", [GRANDPA_SET_ID_KEY, x.block.hash], v3s.ep), value: v3s.ok ? String(v3s.value) : v3s.why });
  if (v3k.ok && v3s.ok && v3s.value) {
    const runtime = decodeAuthorityList(hexToBytes(v3k.value));
    const runtimeSet = decodeU64(hexToBytes(v3s.value), "Grandpa.CurrentSetId");
    const sameKeys = runtime.length === keys.length && runtime.every((a, i) => a.weight === 1n && equalBytes(a.id, keys[i] ?? new Uint8Array()));
    // At a set change's own block, its state names the next set already.
    const change = x.header ? authorityChange(x.header, { verify: () => false, usableKey: () => true }).kind === "follows" : false;
    const sameSet = runtimeSet === setId || (change && runtimeSet === setId + 1n);
    if (!sameKeys || !sameSet) {
      settle({
        state: "failed",
        sub: `V3's runtime and the light client disagree on set ${setId}`,
        diff: { expected: `set ${setId}: ${keys.map((x) => sh(bytesToHex(x))).join(", ")}`, found: `set ${runtimeSet}: ${runtime.map((a) => sh(bytesToHex(a.id))).join(", ")}` },
        raw,
      });
      return null;
    }
    lines.push({ ok: true, text: `The same keys as V3's runtime at #${n(x.block.number)}, set ${runtimeSet}` });
  } else lines.push({ ok: null, text: `V3's runtime at #${n(x.block.number)}: ${pruned(v3k.ok ? "" : v3k.why) ? "not served (pruned)" : "not answered"}` });
  ev.push(...keyRows(keys));
  ev.push({ k: "Light client", v: [{ t: "hash", full: checksum(d.lightClient), label: `the light client on ${d.name}`, href: d.explorer.address(d.lightClient) }], wide: true });
  ev.push({ k: "Keys hash", v: [{ t: "hash", full: hash, label: "the keys hash", href: null }] });
  b.run.facts.setId = setId;
  settle({ state: "passed", sub: `Set ${setId} · ${keys.length} keys · ${need} needed`, ev, lines, raw, trust: { kind: "trust", text: TRUST.keys(adminWords(admin.admin, d.deployer)) } });
  return { keys, setId };
}

/** Step 3, for both routes: the justification's signatures under the keys of step 2. */
async function sigsStep(
  b: Board,
  env: VerifyEnv,
  j: Justification,
  bytes: Uint8Array,
  given: Uint8Array | null,
  keys: { keys: Uint8Array[]; setId: bigint } | null,
  what: string,
): Promise<boolean> {
  b.checking("sigs");
  const raw: Raw[] = [{ label: `the justification, ${bytes.length} bytes, ${j.precommits.length} precommits`, call: what, value: bytesToHex(bytes) }];
  if (!keys) {
    b.settle("sigs", { state: "skipped", sub: "Not checked: needs the keys" });
    return false;
  }
  let crypto: ClientCrypto;
  try {
    crypto = await env.crypto();
  } catch {
    b.settle("sigs", { state: "skipped", sub: "Not checked: the signature code did not load", retry: true });
    return false;
  }
  const t = performance.now();
  const c = checkSignatures(j, keys.keys, keys.setId, crypto, given);
  const ms = performance.now() - t;
  for (const p of j.precommits) {
    raw.push({
      label: `precommit ${j.precommits.indexOf(p)}: R, s, key, and the 53-byte message signed`,
      call: "ed25519, the light client's rules",
      value: [bytesToHex(p.signature.subarray(0, 32)), bytesToHex(p.signature.subarray(32)), bytesToHex(p.id), bytesToHex(precommitPayload(bytesToHex(p.targetHash), p.targetNumber, j.round, keys.setId))].join("\n"),
    });
  }
  if (c.problem) {
    b.settle("sigs", { state: "failed", sub: c.problem.text, diff: c.problem.expected && c.problem.found ? { expected: c.problem.expected, found: c.problem.found } : null, raw });
    return false;
  }
  const ev: Ev[] = c.result.precommits.map((p) => ({ k: `Precommit ${p.index}`, v: [{ t: "text", text: `key ${p.authorityIndex} · ` }, { t: "text", text: p.signatureValid ? "Valid" : "Invalid" }] }));
  const lines: Line[] = [{ ok: true, text: `The light client's own rules: a canonical key not of small order, s below L, [s]B + [L−k]A equal to R byte for byte, no cofactor cleared` }];
  if (c.hint) {
    const hint = bytesToHex(c.hint);
    ev.push({ k: "Signers hint", v: [{ t: "mono", text: hint }, { t: "text", text: given ? " = the mint's" : "" }] });
    if (given) lines.push({ ok: true, text: `Hint ${hint} = the one the transaction sent: ${c.result.precommits.filter((p) => !p.problem).map((p) => `precommit ${p.index} by key ${p.authorityIndex}`).join(", ")}` });
  }
  b.settle("sigs", {
    state: "passed",
    sub: `Round ${n(j.round)} · set ${keys.setId} · ${c.result.valid} of ${c.result.total} valid · ${c.result.required} needed`,
    ms,
    ev,
    lines,
    raw,
    trust: { kind: "verify", text: TRUST.sigs },
  });
  return true;
}

/** A read proof's items, as state_getReadProof and state_getChildReadProof answer them; null for any other answer. */
const proofOf = (g: Got<{ proof: Hex[] }>): Hex[] | null => (g.ok && g.value && Array.isArray(g.value.proof) && g.value.proof.every((x) => typeof x === "string") ? g.value.proof : null);

/** The lock's two proofs as the V3 node serves them at a block, walked from its state root: the cross-check of step 4. */
async function nodeWord(reads: Reads, at: Hex, stateRoot: Uint8Array, trieId: Uint8Array, key: Uint8Array): Promise<{ value: Uint8Array | null; why: string | null; raw: Raw[]; from: string[] }> {
  const rootKey = childRootKey(trieId);
  const [rp, cp] = await Promise.all([
    reads.v3<{ proof: Hex[] }>("state_getReadProof", [[bytesToHex(rootKey)], at]),
    reads.v3<{ proof: Hex[] }>("state_getChildReadProof", [bytesToHex(rootKey), [bytesToHex(key)], at]),
  ]);
  const rootItems = proofOf(rp);
  const served = proofOf(cp);
  const from = fromOf(rp, cp);
  const raw: Raw[] = [
    { label: "the V3 node's child-root proof", call: callText("state_getReadProof", [[bytesToHex(rootKey)], at], rp.ep), value: rootItems ? rootItems.join("\n") : rp.ok ? "no proof" : rp.why },
    { label: "the V3 node's child proof", call: callText("state_getChildReadProof", [bytesToHex(rootKey), [bytesToHex(key)], at], cp.ep), value: served ? served.join("\n") : cp.ok ? "no proof" : cp.why },
  ];
  if (!rootItems || !served) return { value: null, why: !rp.ok ? rp.why : !cp.ok ? cp.why : "no proof", raw, from };
  try {
    const rootNodes = rootItems.map(hexToBytes);
    const childRoot = provenValue(stateRoot, rootNodes, rootKey, "child-root");
    const items = childItems(served.map(hexToBytes), rootNodes);
    const read = items.length ? provenValue(childRoot, items, key, "slot") : null;
    return { value: read, why: null, raw, from };
  } catch (e) {
    return { value: null, why: `its proof does not walk: ${errorText(e)}`, raw, from };
  }
}

// ---------------------------------------------------------------------------------------------
// The way in: a minted lock, from the mint its destination took

/** A transaction and its receipt, as eth_getTransactionByHash and eth_getTransactionReceipt give them. */
interface RawTx {
  hash: Hex;
  from: Hex;
  to: Hex;
  input: Hex;
  blockNumber: Hex | null;
}

interface RawReceipt {
  status: Hex;
  gasUsed: Hex;
  blockNumber: Hex;
  from?: Hex;
  logs: RawLog[];
}

export interface MintedLock {
  nonce: bigint;
  /** The mint's transaction on the destination: the records', or the Minted log's. */
  mintTx: Hex;
  /** What the records hold of the mint: the receipt's labelled fallback. */
  recorded: { block: number; gasUsed: number | null; sender: Hex; from: string } | null;
  /** The lock on V3, for step 5's cross-check: a Substrate extrinsic has no Locked log through eth_getLogs. */
  lock: { tx: Hex; block: number; via: "evm" | "substrate" } | null;
  /** Auto-mint's key, which the page names as the sender. */
  autoMint: Hex | null;
  /**
   * The lock's fields, its Locked log's or the records': when no RPC serves the mint's transaction,
   * the run goes on from a proof read from V3 now (the fallback route). Absent: it stops there.
   */
  fields?: UnmintedLock["fields"];
  /** The reads that found the lock and its mint, before the run. */
  looked?: Looked;
}

interface ReplayRead {
  answered: boolean;
  revert: Revert | null;
  returned: Hex | null;
  ep: Endpoint | null;
  head: number | null;
  call: Raw;
}

/** The same transaction sent again just now as a read, endpoint by endpoint at its head, with the cap as gas: its revert, or what it returns. */
async function replayOn(reads: Reads, d: DestEnv, tx: { from: Hex; to: Hex; data: Hex }, label: string): Promise<ReplayRead> {
  const req = { from: tx.from, to: tx.to, data: tx.data, gas: qty(Number(TX_GAS_CAP)) };
  const shown = { ...req, data: `${tx.data.slice(0, 74)}… (${(tx.data.length - 2) / 2} bytes)` };
  for (const ep of d.rpcs) {
    const head = await reads.eth<Hex>([ep], "eth_blockNumber", [], { retries: 0 });
    if (!head.ok) continue;
    const r = await reads.eth<Hex>([ep], "eth_call", [req, head.value], { retries: 0 });
    const call = { label, call: callText("eth_call", [shown, head.value], ep), value: r.ok ? r.value : (r.revert?.data ?? r.why) };
    if (r.ok) return { answered: true, revert: null, returned: r.value, ep, head: Number(BigInt(head.value)), call };
    if (r.revert?.data) return { answered: true, revert: r.revert, returned: null, ep, head: Number(BigInt(head.value)), call };
  }
  return { answered: false, revert: null, returned: null, ep: null, head: null, call: { label, call: callText("eth_call", [shown, "latest"], null), value: `no ${d.name} RPC answered` } };
}

/** The import that brought block `hash` into the destination's client: the records' relay entry, else its HeaderImported log. */
async function findImport(reads: Reads, env: VerifyEnv, hash: Hex, before: number | null): Promise<{ tx: Hex; src: string } | null> {
  const rec = env.importOf(hash);
  if (rec) return { tx: rec.tx, src: `Recorded · ${rec.from}` };
  const d = env.dest;
  // Back from the mint's block, in the windows each node serves: an import comes a little before the mint that uses it.
  let head = before;
  if (head === null) {
    const h = await reads.eth<Hex>(d.rpcs, "eth_blockNumber", []);
    if (!h.ok) return null;
    head = Number(BigInt(h.value));
  }
  try {
    const found = await reads.logs(d.logs, { address: d.lightClient, topics: [TOPIC.headerImported, hash] }, d.clientFrom, head, { maxCalls: 12, first: true });
    const log = found.logs.at(-1);
    return log ? { tx: log.transactionHash.toLowerCase() as Hex, src: `Read now · its HeaderImported log at ${d.name} #${n(Number(BigInt(log.blockNumber)))}` } : null;
  } catch {
    return null;
  }
}

const boolOf = (g: Got<Hex>): boolean | null => (g.ok ? decode("bool", g.value)[0] === true : null);

function done(b: Board): Run {
  b.finish();
  return b.run;
}

/** The way in, minted: the six checks on the mint the destination took, and its acceptance now. */
export async function verifyMinted(env: VerifyEnv, x: MintedLock, out: Out): Promise<Run> {
  const d = env.dest;
  const reads = new Reads(env, x.looked);
  const b = new Board("in", "minted", stepTitles("in", "minted", d.name), out, reads);
  try {
    b.run.facts.nonce = x.nonce;
    b.run.facts.mint = { tx: x.mintTx, from: x.recorded?.sender ?? null, data: null };
    b.emit();
    // Everything that does not need the calldata goes out at once.
    const nonNull = { accept: (r: unknown) => r !== null };
    const txP = reads.eth<RawTx>(d.history, "eth_getTransactionByHash", [x.mintTx], nonNull);
    const rcP = reads.eth<RawReceipt>(d.history, "eth_getTransactionReceipt", [x.mintTx], nonNull);
    const lightClientP = reads.call(d.rpcs, d.minter, "lightClient()");
    const adminP = reads.call(d.rpcs, d.lightClient, "admin()");
    const trieP = reads.call(d.rpcs, d.minter, "vaultTrieId()");
    const codeP = reads.call(d.rpcs, d.minter, "vaultCodeHash()");
    const usedP = reads.call(d.rpcs, d.minter, "used(uint256)", [x.nonce]);
    const genesisP = reads.call(d.rpcs, d.lightClient, "genesisHash()");
    const v3GenesisP = reads.v3<Hex | null>("chain_getBlockHash", [0]);
    const set0P = reads.call(d.rpcs, d.lightClient, "authoritySetAt(uint256)", [0]);
    const lockedP = reads.eth<RawLog[]>(env.v3Evm, "eth_getLogs", [{ address: env.vault, topics: [TOPIC.locked, topicOf(x.nonce)], fromBlock: qty(env.vaultFrom), toBlock: "latest" }]);

    // Step 1: the header the mint carried.
    b.checking("header");
    const tx = await txP;
    if (!tx.ok && x.fields !== undefined) {
      // The labelled fallback: the same checks on a proof read from V3 now, and the destination's dry run.
      const why = `No ${d.name} RPC served the mint's transaction ${sh(x.mintTx)}: checked on a proof read from V3 now instead.`;
      return await verifyUnminted(env, { nonce: x.nonce, fields: x.fields, lock: x.lock, why, minted: true, looked: { reads: reads.count, floor: reads.floor } }, out);
    }
    if (!tx.ok) {
      const why = `Not checked: no ${d.name} RPC served the mint's transaction ${sh(x.mintTx)}`;
      for (const k of ["header", "keys", "sigs", "proof", "commit"] as const) b.settle(k, { state: "skipped", sub: k === "header" ? why : "Not checked: needs the mint's calldata", retry: k === "header" });
      b.settle("accepted", { state: "skipped", sub: "Not checked: needs the mint's transaction", retry: true });
      return done(b);
    }
    let call: MintCall;
    try {
      call = decodeMintCall(tx.value.input, d.minter, d.lightClient);
    } catch (e) {
      b.settle("header", { state: "failed", sub: `the transaction ${sh(x.mintTx)} is not a mint of this BridgeMinter: ${errorText(e)}`, from: fromOf(tx) });
      return done(b);
    }
    b.run.facts.mint = { tx: x.mintTx, from: tx.value.from.toLowerCase() as Hex, data: call.multicall ? call.data : null };
    if (call.p.nonce !== x.nonce) {
      b.settle("header", { state: "failed", sub: `the transaction mints lock ${call.p.nonce}, not lock ${x.nonce}`, from: fromOf(tx) });
      return done(b);
    }
    const block = bytesToHex(call.p.blockHash);
    const mintBlock = tx.value.blockNumber ? Number(BigInt(tx.value.blockNumber)) : (x.recorded?.block ?? null);
    const rawCall: Raw[] = [];
    const read1: Got<unknown>[] = [tx];
    let imp = call.imported;
    let impTx: RawTx | null = null;
    let impSrc = `${call.method} calldata${call.multicall ? ", inside Multicall3's aggregate3" : ""}`;
    if (!imp) {
      // mint(p): the block came in with an earlier import.
      const found = await findImport(reads, env, block, mintBlock);
      if (found) {
        const it = await reads.eth<RawTx>(d.history, "eth_getTransactionByHash", [found.tx], nonNull);
        read1.push(it);
        if (it.ok) {
          try {
            imp = importFrom(it.value.input, call.p.blockHash);
            impTx = it.value;
            impSrc = `the ${imp.method} that brought it in, tx ${sh(found.tx)} (${found.src})`;
          } catch (e) {
            b.settle("header", { state: "failed", sub: `the import ${sh(found.tx)} does not import ${sh(block)}: ${errorText(e)}`, from: fromOf(...read1) });
            return done(b);
          }
        }
      }
      if (!imp) {
        b.settle("header", { state: "skipped", sub: `Not checked: the import that brought ${sh(block)} into the client was found neither in the records nor in its logs`, retry: true });
        for (const k of ["keys", "sigs", "proof", "commit"] as const) b.settle(k, { state: "skipped", sub: "Not checked: needs the header" });
      }
    }
    const t1 = performance.now();
    const hc = imp ? checkHeader(imp, call.p.blockHash) : null;
    const ms1 = performance.now() - t1;
    const header = hc?.header ?? null;
    if (header && imp) {
      b.run.facts.block = { number: header.number, hash: block };
      b.run.facts.header = bytesToHex(imp.header);
    }
    // What needs the block: the client's record of it, V3's view of it, the replays. The mint goes
    // again to the minter itself (from Multicall3 its own call); the import, to the light client; the
    // re-run before it was mined is the transaction as it was sent, the set changes it imported first
    // included.
    const heldP = readHeld(reads, d, block);
    const v3HeaderP = reads.v3<RpcHeader | null>("chain_getHeader", [block]);
    const v3KeysP = reads.v3<Hex>("state_call", ["GrandpaApi_grandpa_authorities", "0x", block]);
    const v3SetP = reads.v3<Hex | null>("state_getStorage", [GRANDPA_SET_ID_KEY, block]);
    const replayP = replayOn(reads, d, { from: tx.value.from, to: d.minter, data: call.data }, "the mint, sent again just now as a read");
    const impReplayP = impTx && imp ? replayOn(reads, d, { from: impTx.from, to: d.lightClient, data: clientImportData(imp) }, "the import, sent again just now as a read") : null;
    const archiveP =
      d.archive.length && mintBlock !== null
        ? reads.eth<Hex>(d.archive, "eth_call", [{ from: tx.value.from, to: tx.value.to, data: tx.value.input, gas: qty(Number(TX_GAS_CAP)) }, qty(mintBlock - 1)], { retries: 0 })
        : null;
    const trieIdP = (async (): Promise<{ bytes: Uint8Array; src: Val | null; got: Got<Hex> }> => {
      const t = await trieP;
      const v = t.ok ? hexToBytes(decode("bytes32", t.value)[0] as Hex) : null;
      if (t.ok && v && v.some((c) => c !== 0)) return { bytes: v, src: null, got: t };
      return { bytes: hexToBytes(env.recordedVault.trieId), src: { t: "src", kind: "recorded", text: `Recorded · ${env.recordedVault.from}` }, got: t };
    })();
    const nodeWordP = header ? trieIdP.then((t) => nodeWord(reads, block, header.stateRoot, t.bytes, commitmentKey(x.nonce))) : null;

    let keys: { keys: Uint8Array[]; setId: bigint } | null = null;
    if (imp && hc) {
      rawCall.push({ label: `the header, ${imp.header.length} bytes (SCALE)`, call: impSrc, value: bytesToHex(imp.header) });
      if (header) rawCall.push({ label: "its digest items", call: "decoded here", value: digestText(header) });
      if (hc.problem || !header || !hc.j) {
        b.settle("header", { state: "failed", sub: hc.problem?.text ?? "the header does not decode", diff: hc.problem?.expected && hc.problem.found ? { expected: hc.problem.expected, found: hc.problem.found } : null, raw: rawCall, ms: ms1, from: fromOf(...read1) });
        return done(b);
      }
      const held = await heldP;
      read1.push(...held.answers);
      const lines: Line[] = [];
      if (held.differ) {
        b.settle("header", {
          state: "failed",
          sub: `${d.name}'s RPCs answer different ${held.differ.what} for #${n(header.number)} (headerOf): ${held.who.join(" and ")}`,
          diff: { expected: held.differ.expected, found: held.differ.found },
          raw: rawCall,
          ms: ms1,
          from: fromOf(...read1),
        });
        return done(b);
      }
      if (held.unknown && !held.value) {
        b.settle("header", { state: "failed", sub: `the light client on ${d.name} holds no block ${sh(block)}`, raw: rawCall, ms: ms1, from: fromOf(...read1) });
        return done(b);
      }
      if (held.value) {
        if (held.value.number !== header.number || held.value.stateRoot !== bytesToHex(header.stateRoot)) {
          b.settle("header", { state: "failed", sub: `the light client on ${d.name} stores another state root for #${n(header.number)}`, diff: { expected: bytesToHex(header.stateRoot), found: held.value.stateRoot }, raw: rawCall, ms: ms1, from: fromOf(...read1) });
          return done(b);
        }
        const asked = d.rpcs.slice(0, 2).map((e) => nodeName(e.label));
        lines.push({ ok: true, text: `The light client on ${d.name} stores the same state root for #${n(header.number)} (headerOf${held.who.length >= 2 ? `; ${held.who.join(" and ")} agree` : ""})` });
        if (held.who.length < 2) lines.push({ ok: null, text: `Only ${held.who[0] ?? "one RPC"} answered headerOf; ${asked.find((x) => x !== held.who[0]) ?? "the second"} did not, so the client's record is one RPC's word` });
      } else lines.push({ ok: null, text: `headerOf(${sh(block)}) on ${d.name}: not answered` });
      const v3h = await v3HeaderP;
      read1.push(v3h);
      rawCall.push({ label: `the V3 node's header of #${n(header.number)}`, call: callText("chain_getHeader", [block], v3h.ep), value: v3h.ok ? json(v3h.value) : v3h.why });
      if (v3h.ok && v3h.value) {
        const same = equalBytes(encodeRpcHeader(v3h.value), imp.header);
        lines.push(same ? { ok: true, text: `The V3 node serves the same ${imp.header.length} bytes` } : { ok: false, text: `the V3 node serves another header for #${n(header.number)}` });
      } else lines.push({ ok: null, text: `The V3 node's header: ${v3h.ok ? "not served" : "not answered"}` });
      b.settle("header", {
        state: "passed",
        sub: `blake2b of the ${imp.header.length} bytes is #${n(header.number)}, the block the signatures finalize`,
        ms: ms1,
        ev: [
          { k: "Block", v: [{ t: "mono", text: `#${n(header.number)}` }, { t: "hash", full: block, label: `block #${n(header.number)}`, href: env.v3Block(header.number) }] },
          { k: "Parent", v: [{ t: "hash", full: bytesToHex(header.parentHash), label: "the parent hash", href: null }] },
          { k: "State root", v: [{ t: "hash", full: bytesToHex(header.stateRoot), label: "the state root", href: null }] },
          { k: "From", v: [{ t: "text", text: call.method === "importAndMint" ? "importAndMint's calldata" : `${imp.method}, the import before mint(p)` }] },
        ],
        lines,
        raw: rawCall,
        from: fromOf(...read1),
        trust: { kind: "verify", text: "Nothing of its own: the hash binds these bytes to the block, and step 3's signatures cover that hash." },
      });

      // Step 2: the keys the client checked them against.
      keys = await keysStep(b, reads, env, { block: { number: header.number, hash: block }, held, setId: null, header, lightClientP, adminP, genesisP, v3GenesisP, v3KeysP, v3SetP, set0P });
      if (b.failed()) return done(b);

      // Step 3: the signatures.
      await sigsStep(b, env, hc.j, imp.justification, imp.signers, keys, `${impSrc}: the FinalityProof's justification`);
      if (b.failed()) return done(b);
      await setChangesLine(b, reads, env, call);

      // Step 4: the storage proofs.
      b.checking("proof");
      const [trie, code, rc] = await Promise.all([trieIdP, codeP, rcP]);
      const codeHash = code.ok ? hexToBytes(decode("bytes32", code.value)[0] as Hex) : hexToBytes(env.recordedVault.codeHash);
      // The account proof counts on the mint that bound the minter, as its receipt's VaultBound shows: a
      // later mint may carry one too (lock 1's does), which the minter does not read once it is bound.
      const carried = call.p.accountProof.length > 0;
      const binds = !carried ? false : rc.ok ? boundIn(rc.value.logs, d.minter, env.registry) : null;
      const t4 = performance.now();
      const sc = checkStorage(header.stateRoot, call.p, trie.bytes, env.vault, codeHash, binds === true);
      const extra = carried && binds !== true ? checkBind(header.stateRoot, call.p, trie.bytes, env.vault, codeHash) : null;
      const ms4 = performance.now() - t4;
      const accountLabel = binds === false ? "carried, and skipped by the minter, bound already: it reads it only on its first mint" : "Revive.AccountInfoOf(vault)";
      const praw: Raw[] = [
        ...(carried ? [{ label: `account proof, ${call.p.accountProof.length} items: ${accountLabel}`, call: impSrc, value: call.p.accountProof.map(bytesToHex).join("\n") }] : []),
        { label: `child-root proof, ${call.p.childRootProof.length} items`, call: "LockProof.childRootProof", value: call.p.childRootProof.map(bytesToHex).join("\n") },
        { label: `slot proof, ${call.p.slotProof.length} items`, call: "LockProof.slotProof", value: call.p.slotProof.map(bytesToHex).join("\n") },
        {
          label: "keys",
          call: "computed here",
          value: [`child root key ${bytesToHex(childRootKey(trie.bytes))}`, `slot key ${bytesToHex(commitmentKey(x.nonce))}`, ...(call.p.accountProof.length ? [`account key ${bytesToHex(accountInfoKey(env.vault))}`] : [])].join("\n"),
        },
      ];
      const read4: Got<unknown>[] = [tx, trie.got, code, ...(binds !== false ? [rc] : [])];
      if (sc.problem || !sc.value || !sc.childRoot) {
        b.settle("proof", { state: "failed", sub: sc.problem?.text ?? "the proofs do not walk", diff: sc.problem?.expected && sc.problem.found ? { expected: sc.problem.expected, found: sc.problem.found } : null, raw: praw, ms: ms4, from: fromOf(...read4) });
        return done(b);
      }
      const value = sc.value;
      praw.push({ label: "proven values", call: "walked here", value: `child root ${bytesToHex(sc.childRoot)}\ncommitments[${x.nonce}] ${bytesToHex(value)}` });
      const plines: Line[] = [];
      let nodeFrom: string[] = [];
      if (nodeWordP) {
        const nw = await nodeWordP;
        praw.push(...nw.raw);
        nodeFrom = nw.from;
        if (nw.value) {
          const same = equalBytes(nw.value, value);
          plines.push(same ? { ok: true, text: `The V3 node's own proof at #${n(header.number)} gives the same word` } : { ok: false, text: `the V3 node's proof at #${n(header.number)} gives another word, ${sh(bytesToHex(nw.value))}` });
        } else
          plines.push({
            ok: null,
            text: nw.why && pruned(nw.why) ? `Not served · the V3 node no longer has state at #${n(header.number)} (pruned): the proof checked is the one the mint carried` : "The V3 node's proof: not answered",
          });
      }
      const items = `${call.p.childRootProof.length} + ${call.p.slotProof.length}${binds === true ? `, ${call.p.accountProof.length} more for the bind` : ""}`;
      const pev: Ev[] = [
        { k: "Child root", v: [{ t: "hash", full: bytesToHex(sc.childRoot), label: "the vault's child-trie root", href: null }] },
        { k: "Items", v: [{ t: "mono", text: items }] },
        { k: "Slot key", v: [{ t: "hash", full: bytesToHex(commitmentKey(x.nonce)), label: "the slot key", href: null }] },
        { k: "Trie id", v: [{ t: "hash", full: bytesToHex(trie.bytes), label: "the vault's trie id", href: null }, ...(trie.src ? [trie.src] : [])] },
      ];
      const named = (c: { trieId: Uint8Array; codeHash: Uint8Array }) =>
        `the trie id the minter stored (${sh(bytesToHex(c.trieId))}) and the code hash it was deployed for (${sh(bytesToHex(c.codeHash))})${code.ok ? "" : ", as recorded"}`;
      if (sc.bind) {
        pev.push({ k: "Bind", v: [{ t: "text", text: "trie id = vaultTrieId() · code hash = vaultCodeHash()" }], wide: true });
        plines.push({ ok: true, text: `This first mint bound the minter: its account proof names ${named(sc.bind)}` });
      } else if (extra && binds === false) {
        // Not the minter's check, but one made here: when the proof walks to the same trie id and code hash, it agrees.
        plines.push({
          ok: extra.problem ? null : true,
          text: `The mint also carried the vault's account proof. The minter reads it only on its first mint, so it skipped it here.${extra.problem ? "" : " Walked in this browser, it gives the same trie id and code hash."}`,
        });
      } else if (extra) {
        plines.push(extra.bind && !extra.problem ? { ok: true, text: `The account proof it carries names ${named(extra.bind)}` } : { ok: null, text: `The account proof it carries does not walk here (${extra.problem?.text ?? ""}); the minter reads it only on its first mint` });
      }
      b.settle("proof", {
        state: "passed",
        sub: `commitments[${x.nonce}] = ${sh(bytesToHex(value))} in the vault's child trie`,
        ms: ms4,
        ev: pev,
        lines: plines,
        raw: praw,
        from: [...new Set([...fromOf(...read4), ...nodeFrom])],
        trust: { kind: "verify", text: TRUST.proof },
      });

      // Step 5: the commitment.
      await commitStep(b, env, call.p, value, lockedP, x.lock);
      if (b.failed()) return done(b);
    }

    // Step 6: what the destination did with it, then and now.
    await acceptedStep(b, env, x, { call, block, header, keys, tx: tx.value, rcP, usedP, replayP, impReplayP, archiveP, mintBlock });
    return done(b);
  } catch (e) {
    if (e instanceof Stopped) return b.run;
    throw e;
  }
}

/** A self-relay's set changes, each imported before the mint in the same transaction: its header and signatures checked as its set's change, a line under step 3. */
async function setChangesLine(b: Board, reads: Reads, env: VerifyEnv, call: MintCall): Promise<void> {
  if (!call.setChanges.length) return;
  const s = b.step("sigs");
  const crypto = await env.crypto().catch(() => null);
  for (const [i, c] of call.setChanges.entries()) {
    const hash = bytesToHex(blake2b256(c.header));
    const held = await readHeld(reads, env.dest, hash);
    const set = held.differ ? null : (held.value?.setId ?? null);
    const keys = set !== null ? await readKeys(reads, env.dest, set) : null;
    let ok: boolean | null = null;
    if (crypto && keys?.keys && set !== null) {
      const j = decodeJustification(c.justification);
      const r = verifyJustification(j, keys.keys, set, crypto.verify);
      const change = authorityChange(decodeHeader(c.header), crypto);
      ok = r.ok && equalBytes(j.targetHash, blake2b256(c.header)) && change.kind === "follows";
    }
    const by = set !== null ? `, signed by set ${set}` : "";
    s.lines = [...s.lines, { ok, text: `Set change ${i + 1} of ${call.setChanges.length}, imported first through Multicall3: ${sh(hash)}${by}${ok === null ? ": not checked" : ok ? ", its signatures valid, a change the client follows" : ": does not verify"}` }];
  }
  b.emit();
}

/** Step 5, for both routes: the proven word is this lock's commitment; the Locked log, where V3's EVM RPC serves it, names the same. */
async function commitStep(b: Board, env: VerifyEnv, p: LockProofBytes, value: Uint8Array, lockedP: Promise<Got<RawLog[]>>, lock: MintedLock["lock"]): Promise<void> {
  const d = env.dest;
  b.checking("commit");
  const t = performance.now();
  const fields: LockFieldsOf = { v3ChainId: env.v3ChainId, vault: env.vault, dstChainId: d.chainId, minter: d.minter };
  const c = checkCommitment(fields, p, value);
  const ms = performance.now() - t;
  const raw: Raw[] = [
    { label: "the eight words: tag, V3's chain id, vault, chain id, minter, recipient, amount, nonce", call: "abi.encode, here", value: commitmentWords(fields, p).join("\n") },
    { label: "keccak256 of them", call: "computed here", value: c.expected },
  ];
  const what = `${tpot(p.amount)} · to ${sh(checksum(p.recipient))} · on ${d.name} · nonce ${p.nonce}`;
  if (c.problem) {
    // The fields are not in the result line here: they go with the failure.
    b.settle("commit", { state: "failed", sub: c.problem.text, diff: { expected: bytesToHex(value), found: c.expected }, ev: [{ k: "Lock", v: [{ t: "text", text: what }], wide: true }], raw, ms });
    return;
  }
  const lines: Line[] = [];
  const lg = await lockedP;
  const log = lg.ok && Array.isArray(lg.value) ? lg.value.find((l) => env.registry.decodeLog(l)?.name === "Locked") : undefined;
  if (lg.ok) raw.push({ label: "the vault's Locked log", call: callText("eth_getLogs", [{ address: env.vault, topics: [TOPIC.locked, topicOf(p.nonce)] }], lg.ep), value: json(lg.value) });
  if (log) {
    const dl = env.registry.decodeLog(log);
    const arg = (k: string) => dl?.args.find((a) => a.name === k)?.value;
    const same =
      arg("dstChainId") === d.chainId &&
      String(arg("dstMinter")).toLowerCase() === d.minter.toLowerCase() &&
      String(arg("recipient")).toLowerCase() === p.recipient &&
      arg("amountNative") === p.amount &&
      String(arg("commitment")).toLowerCase() === c.expected;
    const at = log.blockNumber ? ` at V3 #${n(Number(BigInt(log.blockNumber)))}` : "";
    const txh = log.transactionHash ? ` (tx ${sh(log.transactionHash)})` : "";
    lines.push(same ? { ok: true, text: `The Locked log${at}${txh} names the same` } : { ok: false, text: `the Locked log${at}${txh} names other fields` });
  } else if (lg.ok) lines.push({ ok: null, text: lock?.via === "substrate" ? "Locked log: not served, a Substrate extrinsic's event" : "Locked log: not served by V3's EVM RPC" });
  else lines.push({ ok: null, text: "Locked log: V3's EVM RPC did not answer" });
  b.settle("commit", {
    state: "passed",
    sub: what,
    ms,
    ev: [{ k: "Recomputed = proven", v: [{ t: "hash", full: c.expected, label: "the recomputed commitment", href: null }] }],
    lines,
    raw,
    from: fromOf(lg),
    trust: { kind: "verify", text: "Nothing of its own: keccak-256 over the value proven in step 4 and the chain the mint ran on." },
  });
}

interface AcceptedIn {
  call: MintCall;
  block: Hex;
  header: Header | null;
  keys: { keys: Uint8Array[]; setId: bigint } | null;
  tx: RawTx;
  rcP: Promise<Got<RawReceipt>>;
  usedP: Promise<Got<Hex>>;
  replayP: Promise<ReplayRead>;
  impReplayP: Promise<ReplayRead> | null;
  archiveP: Promise<Got<Hex>> | null;
  mintBlock: number | null;
}

/**
 * Step 6: the receipt (read now, or the records'), used(nonce), and the mint sent again just now as
 * a read. It passes only on what a node answered just now: the receipt read now with its logs
 * matched, used(nonce) true, or the replay stopping at NonceAlreadyUsed(nonce). The records' receipt
 * is shown, labelled, and counts for nothing.
 */
async function acceptedStep(b: Board, env: VerifyEnv, x: MintedLock, a: AcceptedIn): Promise<void> {
  const d = env.dest;
  const nonce = x.nonce;
  b.checking("accepted");
  const ev: Ev[] = [{ k: "Mint", v: [{ t: "hash", full: x.mintTx, label: "the mint transaction", href: d.explorer.tx(x.mintTx) }] }];
  const lines: Line[] = [];
  const raw: Raw[] = [];
  const read: ({ ep: Endpoint | null } | null)[] = [];
  const settle = (patch: Patch) => b.settle("accepted", { ev, lines, raw, from: fromOf(...read), ...patch });
  const fail = (sub: string) => settle({ state: "failed", sub });
  const rc = await a.rcP;
  read.push(rc);
  const sender = (rc.ok ? rc.value.from : null) ?? a.tx.from;
  const auto = !!x.autoMint && sender.toLowerCase() === x.autoMint.toLowerCase();
  // The receipt read just now, its logs matched with steps 1 to 5: an answer of its own.
  let receipt = false;
  if (rc.ok) {
    raw.push({ label: "the receipt's logs", call: callText("eth_getTransactionReceipt", [x.mintTx], rc.ep), value: json(rc.value.logs) });
    if (Number(BigInt(rc.value.status)) !== 1) return fail("the mint's receipt has status 0");
    const logs = checkMintLogs(
      rc.value.logs,
      {
        minter: d.minter,
        lightClient: d.lightClient,
        block: a.block,
        number: a.header?.number ?? 0,
        stateRoot: a.header ? bytesToHex(a.header.stateRoot) : "0x",
        setId: a.keys?.setId ?? null,
        p: a.call.p,
        imported: a.call.method === "importAndMint" && a.header !== null,
        changes: a.call.setChanges.map((c) => bytesToHex(blake2b256(c.header))),
      },
      env.registry,
    );
    if (logs.problem) return fail(logs.problem.text);
    lines.push(...logs.lines);
    ev.push({ k: "Status", v: [{ t: "mono", text: "1" }] });
    ev.push({ k: "Block", v: [{ t: "mono", text: `#${n(Number(BigInt(rc.value.blockNumber)))}` }, { t: "text", text: `· ${n(Number(BigInt(rc.value.gasUsed)))} gas` }] });
    receipt = true;
  } else if (x.recorded) {
    ev.push({ k: "Status", v: [{ t: "mono", text: "1" }, { t: "src", kind: "recorded", text: `Recorded · status 1 at #${n(x.recorded.block)} · ${x.recorded.from}` }], wide: true });
    if (x.recorded.gasUsed !== null) ev.push({ k: "Block", v: [{ t: "mono", text: `#${n(x.recorded.block)}` }, { t: "text", text: `· ${n(x.recorded.gasUsed)} gas` }] });
    lines.push({ ok: null, text: `The receipt: not served by ${d.name}'s RPCs; the records' is shown` });
  } else ev.push({ k: "Status", v: [{ t: "src", kind: "missing", text: `Not served · no ${d.name} RPC gave the receipt` }] });
  ev.push({ k: "Sender", v: [...(auto ? [{ t: "tag" as const, text: "auto-mint" }] : []), { t: "hash", full: checksum(sender), label: auto ? "auto-mint's key" : "the sender", href: d.explorer.address(sender) }] });
  const used = await a.usedP;
  read.push(used);
  const u = boolOf(used);
  raw.push({ label: `used(${nonce})`, call: callText("eth_call", [{ to: d.minter, data: encodeCall("used(uint256)", [nonce]) }, "latest"], used.ep), value: used.ok ? used.value : used.why });
  if (u === false) return fail(`used(${nonce}) is false: the minter would mint it again`);
  ev.push({ k: `used(${nonce})`, v: u === null ? [{ t: "src", kind: "missing", text: "Not answered" }] : [{ t: "mono", text: "true" }] });
  const rp = await a.replayP;
  read.push(rp);
  raw.push(rp.call);
  let paused: string | null = null;
  let stopped = false;
  if (rp.answered) {
    const o = replayOutcome(rp.revert, nonce);
    if (o.kind === "none") return fail("the minter would mint it again: the replay did not revert");
    if (o.kind === "other") return fail(`the replay stopped before the nonce: ${o.text}`);
    if (o.kind === "paused") paused = `Not checked: the light client is ${o.name === "ClientHalted" ? "halted" : "paused"}; the receipt stands`;
    else {
      stopped = true;
      // mint(p) checks no header and no signature: the state root the client holds for the block, which its import put there.
      const first =
        a.call.method === "mint"
          ? `Both proofs and the commitment passed first, under the state root the client holds for ${a.header ? `#${n(a.header.number)}` : "this block"}.`
          : "The header, the signatures, both proofs and the commitment passed first.";
      const how = a.call.multicall ? ", its own call to the minter (the mint went through Multicall3)" : "";
      lines.push({ ok: true, text: `Sent again just now as a read${how}: NonceAlreadyUsed(${nonce}) · ${d.name} #${n(rp.head ?? 0)} · ${rp.ep ? nodeName(rp.ep.label) : ""}. ${first}` });
    }
  } else lines.push({ ok: null, text: `The replay: no ${d.name} RPC answered` });
  if (a.impReplayP) {
    const ir = await a.impReplayP;
    read.push(ir);
    raw.push(ir.call);
    const back = ir.returned && ir.returned.length >= 66 ? (decode("bytes32", ir.returned)[0] as string).toLowerCase() : null;
    lines.push(
      back === a.block
        ? { ok: true, text: `The import that brought it in, sent again just now as a read, returns ${sh(a.block)}` }
        : ir.answered
          ? { ok: false, text: "the import, sent again, does not return this block" }
          : { ok: null, text: "The import's replay: not answered" },
    );
  }
  if (a.archiveP && a.mintBlock !== null) {
    const ar = await a.archiveP;
    read.push(ar);
    if (ar.ok) lines.push({ ok: true, text: `Run again at ${d.name} #${n(a.mintBlock - 1)}, the block before it was mined: it passes · ${nodeName(ar.ep.label)}` });
    else if (ar.revert?.data) lines.push({ ok: false, text: `Run again at #${n(a.mintBlock - 1)}, before it was mined: it reverts, ${ar.revert.text}` });
  }
  if (paused) {
    settle({ state: "skipped", sub: paused });
    return;
  }
  if (!receipt && u !== true && !stopped) {
    const sub = x.recorded && !rc.ok ? `Not checked: ${d.name}'s RPCs answered neither used(${nonce}) nor the replay; the records' receipt is shown` : `Not checked: no ${d.name} RPC answered`;
    settle({ state: "skipped", sub, retry: true });
    return;
  }
  // The result says what answered, and no more.
  const sub = stopped ? `Minted once · sent again just now: NonceAlreadyUsed(${nonce})` : u === true ? `Minted once · used(${nonce}) = true` : "Minted once · its receipt, read now, has status 1";
  settle({ state: "passed", sub, trust: { kind: "trust", text: TRUST.chain(d.name) } });
}

// ---------------------------------------------------------------------------------------------
// V3 now: a finalized head, its proof and the keys that signed it, for a lock not minted yet and for
// the way back's released[burnId]

/** The V3 node, each call counted as one of the run's reads. */
class CountingClient extends SubstrateClient {
  private readonly inner: SubstrateClient;
  private readonly reads: Reads;

  constructor(inner: SubstrateClient, reads: Reads) {
    super(inner.http, inner.wsEndpoint);
    this.inner = inner;
    this.reads = reads;
  }

  override async request<T>(method: string, params: unknown[] = [], timeoutMs = 8000): Promise<Answer<T>> {
    this.reads.count++;
    const a = await this.inner.request<T>(method, params, timeoutMs);
    this.reads.eps.add(a.endpoint.label);
    return a;
  }
}

/** V3's finalized head as a clean finality proof: the block, its header, its justification and the proof's size. */
interface HeadProof {
  block: { number: number; hash: Hex };
  header: Header;
  j: Justification;
  justification: Uint8Array;
  bytes: number;
  /** The set that signed it: Grandpa.CurrentSetId in its state, one less at a set change's own block. */
  setId: bigint;
}

async function headProof(v3r: V3Reader): Promise<HeadProof> {
  const head = await v3r.finalizedHead();
  const p = await v3r.cleanProof(head.number);
  const state = await v3r.setIdAt(p.block.hash);
  const change = authorityChange(p.header, { verify: () => false, usableKey: () => true }).kind === "follows";
  return { block: p.block, header: p.header, j: p.justification, justification: decodeFinalityProof(p.scale).justification, bytes: p.scale.length, setId: change ? state - 1n : state };
}

/** The client's current set, its keys, its latest block, the block that started the set, how many sets it has installed, and the RPCs that answered. */
async function clientNow(
  reads: Reads,
  d: DestEnv,
): Promise<{ setId: bigint; keys: Uint8Array[]; latest: { number: number; hash: Hex }; activatedAt: number | null; sets: bigint; from: string[] } | null> {
  const [set, latest, count] = await Promise.all([
    reads.call(d.rpcs, d.lightClient, "currentSetId()"),
    reads.call(d.rpcs, d.lightClient, "latestFinalized()"),
    reads.call(d.rpcs, d.lightClient, "authoritySetCount()"),
  ]);
  if (!set.ok || !latest.ok || !count.ok) return null;
  const setId = decode("uint64", set.value)[0] as bigint;
  const [hash, number] = decode("bytes32,uint32", latest.value) as [Hex, bigint];
  const sets = decode("uint256", count.value)[0] as bigint;
  const [keys, last] = await Promise.all([reads.call(d.rpcs, d.lightClient, "authorities(uint64)", [setId]), reads.call(d.rpcs, d.lightClient, "authoritySetAt(uint256)", [sets - 1n])]);
  if (!keys.ok || !last.ok) return null;
  const at = decodeSetAt(last.value);
  return {
    setId,
    keys: (decode("bytes32[]", keys.value)[0] as Hex[]).map((k) => hexToBytes(k)),
    latest: { number: Number(number), hash: hash.toLowerCase() as Hex },
    activatedAt: at.setId === setId ? at.activatedAt : null,
    sets,
    from: fromOf(set, latest, count, keys, last),
  };
}

/**
 * The keys of the set that signed a block of V3 now, by the destination's client: the client's own
 * list when it holds that set, else its current set's keys carried forward through the set changes
 * it has not imported yet, each one checked (V3Reader.setChanges, as the planner does).
 */
async function keysNow(
  reads: Reads,
  env: VerifyEnv,
  v3r: V3Reader,
  signer: bigint,
  head: number,
): Promise<{ keys: Uint8Array[]; setId: bigint; carried: number; current: bigint; sets: bigint; from: string[] } | { skip: string }> {
  const d = env.dest;
  const client = await clientNow(reads, d);
  if (!client) return { skip: `Not checked: no ${d.name} RPC answered the light client's set` };
  if (signer <= client.setId) {
    const k = await readKeys(reads, d, signer);
    if (!k.keys) return { skip: `Not checked: no ${d.name} RPC answered authorities(${signer})` };
    if (k.differ) return { skip: `Not checked: ${d.name}'s RPCs answer different keys for set ${signer}` };
    return { keys: k.keys, setId: signer, carried: 0, current: client.setId, sets: client.sets, from: [...new Set([...client.from, ...fromOf(...k.answers)])] };
  }
  try {
    const crypto = await env.crypto();
    const changes = await v3r.setChanges({ number: client.latest.number, setId: client.setId, keys: client.keys, activatedAt: client.activatedAt }, Number(signer - client.setId), crypto, head);
    const last = changes.at(-1);
    if (!last) throw new VerifyError("no change found");
    return { keys: last.next, setId: signer, carried: changes.length, current: client.setId, sets: client.sets, from: [...client.from, v3Name(env)] };
  } catch {
    return { skip: `Not checked: the keys of set ${signer} are not proven yet` };
  }
}

/** The checkpoint of the client on `d`, its set 0, for the run's facts: read once, after the keys. */
async function checkpointNow(reads: Reads, d: DestEnv, sets: bigint, keys: Uint8Array[]): Promise<Facts["checkpoint"]> {
  const set0 = await reads.call(d.rpcs, d.lightClient, "authoritySetAt(uint256)", [0]);
  return set0.ok ? checkpointOf(decodeSetAt(set0.value), sets, keys) : null;
}

export interface UnmintedLock {
  nonce: bigint;
  /** The lock's fields: its Locked log's or the records'; null for a Substrate lock beyond the records, which only its commitment shows. */
  fields: { recipient: Hex; amount: bigint; block: number; commitment: Hex } | null;
  lock: MintedLock["lock"];
  /** Why the run is from V3 now: not minted, or the mint's transaction not served. */
  why: string;
  /**
   * Minted (used(nonce) is true), its mint transaction not served or not found: the fallback route.
   * Step 6 is then the dry run of a proof read from V3 now, which has to stop at NonceAlreadyUsed(nonce).
   */
  minted?: boolean;
  /** used(nonce) could not be read before the run: whether the lock is minted rests on step 6's dry run. */
  unread?: boolean;
  /** The reads that found the lock, before the run. */
  looked?: Looked;
}

/**
 * The way in from V3 now: steps 1 to 5 on a proof read at V3's finalized head, and the planner's
 * dry run on the destination as step 6. For a lock not minted yet, whether the destination would
 * accept it; for a minted one whose mint is not served (`minted`), that the same proof stops at its
 * nonce.
 */
export async function verifyUnminted(env: VerifyEnv, x: UnmintedLock, out: Out): Promise<Run> {
  const d = env.dest;
  const reads = new Reads(env, x.looked);
  const route = x.minted ? "fallback" : "unminted";
  const b = new Board("in", route, stepTitles("in", route, d.name), out, reads);
  const v3r = new V3Reader(new CountingClient(env.v3, reads));
  const node = v3Name(env);
  try {
    b.run.facts.nonce = x.nonce;
    b.run.usedUnread = x.unread === true;
    b.emit();
    const lightClientP = reads.call(d.rpcs, d.minter, "lightClient()");
    const adminP = reads.call(d.rpcs, d.lightClient, "admin()");
    const trieP = reads.call(d.rpcs, d.minter, "vaultTrieId()");
    const genesisP = reads.call(d.rpcs, d.lightClient, "genesisHash()");
    const v3GenesisP = reads.v3<Hex | null>("chain_getBlockHash", [0]);
    const set0P = reads.call(d.rpcs, d.lightClient, "authoritySetAt(uint256)", [0]);
    const lockedP = reads.eth<RawLog[]>(env.v3Evm, "eth_getLogs", [{ address: env.vault, topics: [TOPIC.locked, topicOf(x.nonce)], fromBlock: qty(env.vaultFrom), toBlock: "latest" }]);

    // Step 1: V3's finalized head, as a finality proof the client takes.
    b.checking("header");
    let hp: HeadProof;
    try {
      hp = await headProof(v3r);
    } catch (e) {
      b.settle("header", {
        state: "skipped",
        sub: `Not checked: the V3 node did not give its finalized head's proof (${plainWhy(e)})`,
        raw: [{ label: "the V3 node's answer", call: "chain_getFinalizedHead, grandpa_proveFinality", value: errorText(e) }],
        retry: true,
      });
      for (const k of ["keys", "sigs", "proof", "commit", "accepted"] as const) b.settle(k, { state: "skipped", sub: "Not checked: needs V3's finalized head" });
      return done(b);
    }
    const block = hp.block.hash;
    b.run.facts.block = hp.block;
    b.run.facts.header = bytesToHex(hp.header.encoded);
    if (x.fields && hp.block.number < x.fields.block) {
      b.settle("header", { state: "skipped", sub: `Not checked: V3 has finalized #${n(hp.block.number)}; the lock is in #${n(x.fields.block)}`, retry: true, from: [node] });
      for (const k of ["keys", "sigs", "proof", "commit", "accepted"] as const) b.settle(k, { state: "skipped", sub: "Not checked: V3 has not finalized the lock's block yet" });
      return done(b);
    }
    b.settle("header", {
      state: "passed",
      sub: `V3's finalized block #${n(hp.block.number)}: its ${hp.header.encoded.length} bytes hash to the block the justification finalizes`,
      ev: [
        { k: "Block", v: [{ t: "mono", text: `#${n(hp.block.number)}` }, { t: "hash", full: block, label: `block #${n(hp.block.number)}`, href: env.v3Block(hp.block.number) }] },
        { k: "State root", v: [{ t: "hash", full: bytesToHex(hp.header.stateRoot), label: "the state root", href: null }] },
        { k: "From", v: [{ t: "src", kind: "read", text: `From V3's finality proof (≈ ${(hp.bytes / 1024).toFixed(1)} KB)` }] },
      ],
      lines: [{ ok: null, text: x.why }],
      raw: [
        { label: `the header, ${hp.header.encoded.length} bytes (SCALE)`, call: callText("chain_getHeader", [block], null), value: bytesToHex(hp.header.encoded) },
        { label: "its digest items", call: "decoded here", value: digestText(hp.header) },
      ],
      from: [node],
      trust: { kind: "verify", text: "Nothing of its own: the hash binds these bytes to the block, and step 3's signatures cover that hash." },
    });

    // Step 2: the keys of the set that signed it, as the client holds them or carried forward.
    const kn = await keysNow(reads, env, v3r, hp.setId, hp.block.number);
    let keys: { keys: Uint8Array[]; setId: bigint } | null = null;
    if ("skip" in kn) b.settle("keys", { state: "skipped", sub: kn.skip, retry: true });
    else if (kn.carried === 0) {
      const held: Held = { answers: [], value: null, who: [], differ: null, unknown: false };
      const v3KeysP = reads.v3<Hex>("state_call", ["GrandpaApi_grandpa_authorities", "0x", block]);
      const v3SetP = reads.v3<Hex | null>("state_getStorage", [GRANDPA_SET_ID_KEY, block]);
      keys = await keysStep(b, reads, env, { block: hp.block, held, setId: kn.setId, header: hp.header, lightClientP, adminP, genesisP, v3GenesisP, v3KeysP, v3SetP, set0P });
      if (b.failed()) return done(b);
    } else {
      keys = { keys: kn.keys, setId: kn.setId };
      const admin = adminRead(d, await adminP);
      b.run.facts.setId = kn.setId;
      b.run.facts.carried = kn.carried;
      b.run.facts.admin = admin.admin;
      b.run.facts.checkpoint = await checkpointNow(reads, d, kn.sets, kn.keys);
      b.settle("keys", {
        state: "passed",
        sub: `Set ${kn.setId} · ${kn.keys.length} keys · ${threshold(kn.keys.length)} needed`,
        ev: keyRows(kn.keys),
        lines: [{ ok: true, text: `The client is at set ${kn.current}: set ${kn.setId}'s keys carried forward through ${plural(kn.carried, "set change")} V3 made since, each signed by the set before` }, admin.line],
        raw: [admin.raw],
        from: [...new Set([...kn.from, ...fromOf(await adminP)])],
        trust: { kind: "trust", text: TRUST.keys(adminWords(admin.admin, d.deployer)) },
      });
    }

    // Step 3: its signatures.
    await sigsStep(b, env, hp.j, hp.justification, null, keys, "grandpa_proveFinality: V3's justification of its finalized head");
    if (b.failed()) return done(b);

    // Step 4: the lock's proofs at that block, read and walked here.
    b.checking("proof");
    const t = await trieP;
    const tv = t.ok ? hexToBytes(decode("bytes32", t.value)[0] as Hex) : null;
    const trieId = tv && tv.some((c) => c !== 0) ? tv : hexToBytes(env.recordedVault.trieId);
    let value: Uint8Array;
    try {
      const lp = await v3r.lockProofs(hp.block, hp.header.stateRoot, trieId, x.nonce);
      value = lp.value;
      b.settle("proof", {
        state: "passed",
        sub: `commitments[${x.nonce}] = ${sh(bytesToHex(value))} at V3 #${n(hp.block.number)}`,
        ev: [
          { k: "Child root", v: [{ t: "hash", full: bytesToHex(lp.childRoot), label: "the vault's child-trie root", href: null }] },
          { k: "Items", v: [{ t: "mono", text: `${lp.childRootProof.length} + ${lp.slotProof.length}` }] },
          { k: "Slot key", v: [{ t: "hash", full: bytesToHex(commitmentKey(x.nonce)), label: "the slot key", href: null }] },
        ],
        raw: [
          { label: `child-root proof, ${lp.childRootProof.length} items`, call: callText("state_getReadProof", [[bytesToHex(childRootKey(trieId))], block], null), value: lp.childRootProof.map(bytesToHex).join("\n") },
          { label: `slot proof, ${lp.slotProof.length} items`, call: callText("state_getChildReadProof", [bytesToHex(childRootKey(trieId)), [bytesToHex(commitmentKey(x.nonce))], block], null), value: lp.slotProof.map(bytesToHex).join("\n") },
        ],
        from: [...new Set([...fromOf(t), node])],
        trust: { kind: "verify", text: TRUST.proof },
      });
    } catch (e) {
      if (e instanceof TrieProofError || e instanceof VerifyError || e instanceof ScaleError) {
        b.settle("proof", { state: "failed", sub: errorText(e), from: [node] });
        return done(b);
      }
      b.settle("proof", {
        state: "skipped",
        sub: `Not checked: the V3 node did not serve the proofs (${plainWhy(e)})`,
        raw: [{ label: "the V3 node's answer", call: "state_getReadProof, state_getChildReadProof", value: errorText(e) }],
        retry: true,
      });
      b.settle("commit", { state: "skipped", sub: "Not checked: needs the proven word" });
      b.settle("accepted", { state: "skipped", sub: "Not checked: needs the proofs" });
      return done(b);
    }

    // Step 5: the commitment of this lock's fields.
    if (!x.fields) {
      b.settle("commit", { state: "skipped", sub: `Not checked: a Substrate lock's fields are not served; its proven commitment is ${sh(bytesToHex(value))}` });
    } else {
      const p: LockProofBytes = { blockHash: hexToBytes(block), accountProof: [], childRootProof: [], slotProof: [], recipient: x.fields.recipient.toLowerCase() as Hex, amount: x.fields.amount, nonce: x.nonce };
      await commitStep(b, env, p, value, lockedP, x.lock);
      if (b.failed()) return done(b);
    }

    // Step 6: would the destination accept it now? The planner's dry run; for a minted lock, the same
    // dry run, which has to stop at its nonce.
    b.checking("accepted");
    if (!env.plan || !x.fields) {
      b.settle("accepted", { state: "skipped", sub: !x.fields ? "Not checked: the dry run needs the lock's fields" : "Not checked: the planner is not available here" });
      return done(b);
    }
    let plan: MintPlan;
    try {
      plan = await env.plan({ nonce: x.nonce, block: x.fields.block, amount: x.fields.amount, recipient: x.fields.recipient, commitment: x.fields.commitment }, { evenIfMinted: x.minted === true });
    } catch (e) {
      b.settle("accepted", { state: "skipped", sub: `Not checked: ${plainWhy(e)}`, raw: [{ label: "the planner's reads", call: "planMint, its reads and dry run", value: errorText(e) }], retry: true });
      return done(b);
    }
    const tx = plan.txs[0];
    const ev: Ev[] = tx ? [{ k: x.minted ? "Dry run" : "Would send", v: [{ t: "text", text: `${tx.title}${tx.gas !== null ? ` · ${n(tx.gas)} gas` : ""}` }], wide: true }] : [];
    const raw: Raw[] = plan.txs.map((x2, i) => ({ label: `transaction ${i + 1} of ${plan.txs.length}: ${x2.title}`, call: `eth_estimateGas · to ${x2.to}`, value: x2.data }));
    const lines: Line[] = [{ ok: null, text: `The planner's own reads and its dry run come besides this page's count. Nothing is sent${x.minted ? "" : ": the mint itself is the transfer's page"}.` }];
    const trust = { kind: "trust" as const, text: TRUST.chain(d.name) };
    if (x.minted) {
      const used = plan.status === "minted" && plan.revert?.name === "NonceAlreadyUsed";
      // The planner reads and builds its own proof, at the V3 head it reads: not the one steps 1 to 5 checked.
      if (used) b.settle("accepted", { state: "passed", sub: `Minted once: a proof read from V3 now passes every check on ${d.name} and stops at NonceAlreadyUsed(${x.nonce}), as a read just now`, ev, raw, lines, trust });
      else if (plan.status === "ready") b.settle("accepted", { state: "failed", sub: `the dry run passed: the minter would mint lock ${x.nonce} again`, ev, raw });
      else if (plan.status === "failed") b.settle("accepted", { state: "failed", sub: plan.why, ev, raw });
      else b.settle("accepted", { state: "skipped", sub: `Not checked: ${plan.why}`, ev, raw, retry: plan.status !== "blocked" });
      return done(b);
    }
    if (plan.status === "ready") b.settle("accepted", { state: "passed", sub: `Yes: the dry run on ${d.name} passed. ${plan.why}`, ev, raw, lines, trust });
    else if (plan.status === "minted") b.settle("accepted", { state: "open", sub: `Minted meanwhile: ${plan.why} Check again shows its mint.`, ev, raw });
    else if (plan.status === "failed") b.settle("accepted", { state: "failed", sub: plan.why, ev, raw });
    else b.settle("accepted", { state: "skipped", sub: `Not checked: ${plan.why}`, ev, raw, retry: plan.status !== "blocked" });
    return done(b);
  } catch (e) {
    if (e instanceof Stopped) return b.run;
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// The way back

export interface BurnTarget {
  n: bigint;
  /** The burn's transaction: the records', or its BurnRequested log's. */
  tx: Hex | null;
  /** The records' account of the burn: the fallback when no RPC serves its receipt. */
  recorded: { block: number; amount: bigint; payee: Hex; burnId: Hex; from: string } | null;
  /** The committee's release, as the records hold it: who approved, how, the extrinsic that ran it. */
  release: {
    payee: Hex | null;
    amount: bigint | null;
    by: string | null;
    approvals: { member: number; action: string; extrinsic: Hex; block: number | null }[];
    run: { extrinsic: Hex; block: number } | null;
    from: string;
  } | null;
  committee: { members: string[]; threshold: number; multisig: string };
  /** The reads that found the burn, before the run. */
  looked?: Looked;
}

/**
 * The way back: the burn (B1) and its id (B2) on the destination, released[burnId] proven at V3's
 * finalized head (B3), and the committee's release, trusted (B4) whatever B1 to B3 found. B1 passes
 * on the burn's receipt read just now; the records' account of it is shown, labelled, as not checked.
 */
export async function verifyBurn(env: VerifyEnv, x: BurnTarget, out: Out): Promise<Run> {
  const d = env.dest;
  const reads = new Reads(env, x.looked);
  const b = new Board("back", "minted", stepTitles("back", "minted", d.name), out, reads);
  const v3r = new V3Reader(new CountingClient(env.v3, reads));
  const nonNull = { accept: (r: unknown) => r !== null };
  const node = v3Name(env);
  // B4, always last and always trusted: nothing on V3 checks the burn before the vault pays.
  const release = (): Run => {
    const rel = x.release;
    const c = x.committee;
    b.settle("release", {
      state: "trusted",
      sub: "Trusted, not checked: the committee's release",
      ev: [
        { k: "Committee", v: [{ t: "hash", full: c.multisig, label: "the committee's multisig", href: null }, { t: "text", text: `· ${c.threshold} of ${c.members.length}` }], wide: true },
        ...(rel
          ? rel.approvals.map((ap) => ({
              k: `Member ${ap.member}`,
              v: [{ t: "text" as const, text: `${ap.action === "open" ? "opened it" : ap.action === "execute" ? "ran it" : ap.action}${ap.block !== null ? ` · V3 #${n(ap.block)}` : ""}` }, { t: "src" as const, kind: "recorded" as const, text: "Recorded" }],
            }))
          : []),
        // As the receipt says it: Fast when the watcher released it before the burn was final, else Standard.
        ...(rel ? [{ k: "How", v: [{ t: "text" as const, text: rel.by === "fast" ? "Fast, before the burn was final" : "Standard, after the burn was final" }] }] : []),
      ],
      lines: [{ ok: null, text: "The vault would have paid the same with no burn at all, up to its outstanding tPOT" }],
      trust: { kind: "trust", text: TRUST.release },
    });
    return done(b);
  };
  try {
    b.run.facts.nonce = x.n;
    b.emit();
    const rcP = x.tx ? reads.eth<RawReceipt>(d.history, "eth_getTransactionReceipt", [x.tx], nonNull) : null;
    const finP = reads.eth<{ number: Hex }>(d.rpcs, "eth_getBlockByNumber", ["finalized", false], nonNull);
    const idOfP = reads.call(d.rpcs, d.minter, "burnIdOf(uint256)", [x.n]);
    const trieP = reads.call(d.rpcs, d.minter, "vaultTrieId()");
    const adminP = reads.call(d.rpcs, d.lightClient, "admin()");
    const headP = headProof(v3r).then(
      (h) => ({ ok: true as const, h }),
      (e: unknown) => ({ ok: false as const, e }),
    );

    // B1: the burn, from its receipt read just now; the records' account of it is not a check.
    b.checking("burn");
    const rc = rcP ? await rcP : null;
    let burn: { amount: bigint; payee: Hex; burnId: Hex; block: number; src: Val | null } | null = null;
    const raw1: Raw[] = [];
    if (rc?.ok) {
      raw1.push({ label: "the burn's receipt: its logs", call: callText("eth_getTransactionReceipt", [x.tx], rc.ep), value: json(rc.value.logs) });
      if (Number(BigInt(rc.value.status)) !== 1) {
        b.settle("burn", { state: "failed", sub: "the burn's receipt has status 0", raw: raw1, from: fromOf(rc) });
        return release();
      }
      for (const l of rc.value.logs) {
        const dl = l.address.toLowerCase() === d.minter ? env.registry.decodeLog(l) : null;
        const arg = (k: string) => dl?.args.find((a) => a.name === k)?.value;
        if (dl?.name !== "BurnRequested" || arg("burnNonce") !== x.n) continue;
        burn = { amount: arg("amount") as bigint, payee: String(arg("v3Recipient")).toLowerCase() as Hex, burnId: String(arg("burnId")).toLowerCase() as Hex, block: Number(BigInt(rc.value.blockNumber)), src: null };
      }
      if (!burn) {
        b.settle("burn", { state: "failed", sub: `the transaction has no BurnRequested log for burn ${x.n}`, raw: raw1, from: fromOf(rc) });
        return release();
      }
    } else if (x.recorded) {
      burn = { amount: x.recorded.amount, payee: x.recorded.payee, burnId: x.recorded.burnId, block: x.recorded.block, src: { t: "src", kind: "recorded", text: `Recorded · ${x.recorded.from}` } };
    }
    if (!burn) {
      b.settle("burn", { state: "skipped", sub: `Not checked: no ${d.name} RPC served the burn's receipt`, retry: true });
      for (const k of ["burnId", "released"] as const) b.settle(k, { state: "skipped", sub: "Not checked: needs the burn" });
      return release();
    }
    const live = rc?.ok === true;
    b.run.facts.burnId = burn.burnId;
    const fin = await finP;
    const finalized = fin.ok ? Number(BigInt(fin.value.number)) : null;
    const lines1: Line[] = [
      finalized === null
        ? { ok: null, text: `${d.name}'s finalized block: not answered` }
        : finalized >= burn.block
          ? { ok: true, text: `Final on ${d.name}: its finalized block #${n(finalized)} is past the burn's` }
          : { ok: null, text: `Not final yet on ${d.name}: finalized #${n(finalized)}` },
    ];
    const recorded: Val = { t: "src", kind: "recorded", text: "Recorded" };
    const ev1: Ev[] = [
      ...(x.tx ? [{ k: "Burn", v: [{ t: "hash" as const, full: x.tx, label: "the burn transaction", href: d.explorer.tx(x.tx) }] }] : []),
      { k: "Block", v: [{ t: "mono", text: `#${n(burn.block)}` }, ...(burn.src ? [burn.src] : [])] },
      { k: "Amount", v: [{ t: "text", text: tpot(burn.amount).replace("tPOT", "wtPOT") }, ...(burn.src ? [recorded] : [])] },
      { k: "Paid to on V3", v: [{ t: "hash", full: checksum(burn.payee), label: "the payee on V3", href: null }, ...(burn.src ? [recorded] : [])] },
    ];
    if (!live) {
      lines1.push({ ok: null, text: `The receipt: not served by ${d.name}'s RPCs; the records' account is shown` });
      b.settle("burn", { state: "skipped", sub: `Not checked: no ${d.name} RPC served the burn's receipt; the records' account of it is shown`, ev: ev1, lines: lines1, raw: raw1, from: fromOf(fin), retry: true });
    } else {
      b.settle("burn", {
        state: "passed",
        sub: `${tpot(burn.amount).replace("tPOT", "wtPOT")} burned for ${sh(checksum(burn.payee))} on V3, at ${d.name} #${n(burn.block)}`,
        ev: ev1,
        lines: lines1,
        raw: raw1,
        from: fromOf(rc, fin),
        trust: { kind: "trust", text: TRUST.chain(d.name) },
      });
    }

    // B2: its id names this burn on this chain, as the log or the minter's burnIdOf(n) says just now.
    b.checking("burnId");
    const t2 = performance.now();
    const computed = burnIdOf(d.chainId, d.minter, x.n);
    const ms2 = performance.now() - t2;
    const idOf = await idOfP;
    const onChain = idOf.ok ? (decode("bytes32", idOf.value)[0] as string).toLowerCase() : null;
    const raw2: Raw[] = [
      { label: "the four words: tag, chain id, minter, burn nonce", call: "abi.encode, here", value: [bytesToHex(keccak256(new TextEncoder().encode("BridgeZero.Burn.v1"))), bytesToHex(word(d.chainId)), bytesToHex(word(BigInt(d.minter))), bytesToHex(word(x.n))].join("\n") },
      { label: `burnIdOf(${x.n})`, call: callText("eth_call", [{ to: d.minter, data: encodeCall("burnIdOf(uint256)", [x.n]) }, "latest"], idOf.ep), value: idOf.ok ? idOf.value : idOf.why },
    ];
    const ev2: Ev[] = [{ k: "Burn id", v: [{ t: "hash", full: computed, label: "the burn id", href: null }] }];
    if (computed !== burn.burnId || (onChain && onChain !== computed)) {
      b.settle("burnId", { state: "failed", sub: "this id does not name this burn", diff: { expected: computed, found: onChain && onChain !== computed ? onChain : burn.burnId }, raw: raw2, ms: ms2, from: fromOf(idOf) });
      return release();
    }
    const lines2: Line[] = [
      onChain ? { ok: true, text: `BridgeMinter.burnIdOf(${x.n}) answers the same` } : { ok: null, text: `burnIdOf(${x.n}): not answered` },
      { ok: true, text: `keccak256(abi.encode(tag, ${d.chainId}, minter, ${x.n})): a burn on another chain has another id` },
    ];
    if (!live && !onChain) {
      b.settle("burnId", { state: "skipped", sub: `Not checked: neither the burn's log nor burnIdOf(${x.n}) was served; the id recomputed here is ${sh(computed)}`, ev: ev2, lines: lines2, raw: raw2, ms: ms2, retry: true });
    } else {
      b.settle("burnId", {
        state: "passed",
        sub: `recomputed = ${live ? "the log's" : "the records'"}${onChain ? ` = burnIdOf(${x.n})` : ""}`,
        ms: ms2,
        ev: ev2,
        lines: lines2,
        raw: raw2,
        from: fromOf(...(live ? [rc] : []), idOf),
        trust: { kind: "verify", text: "Nothing of its own: keccak-256." },
      });
    }

    // B3: released[burnId] in V3's finalized state, under 2 of 2 signatures checked here.
    b.checking("released");
    const head = await headP;
    const admin = adminRead(d, await adminP);
    b.run.facts.admin = admin.admin;
    if (!head.ok) {
      b.settle("released", {
        state: "skipped",
        sub: `Not checked: the V3 node did not give its finalized head's proof (${plainWhy(head.e)})`,
        raw: [{ label: "the V3 node's answer", call: "chain_getFinalizedHead, grandpa_proveFinality", value: errorText(head.e) }],
        retry: true,
      });
    } else {
      const hp = head.h;
      const kn = await keysNow(reads, env, v3r, hp.setId, hp.block.number);
      let sigs: JustificationResult | null = null;
      let ms3 = 0;
      if (!("skip" in kn)) {
        const crypto = await env.crypto().catch(() => null);
        const t = performance.now();
        if (crypto) sigs = verifyJustification(hp.j, kn.keys, kn.setId, crypto.verify);
        ms3 += performance.now() - t;
        // Where these keys come from, for the panel below the card: V3's head, its set, the client's checkpoint.
        b.run.facts.block = hp.block;
        b.run.facts.setId = kn.setId;
        b.run.facts.carried = kn.carried;
        b.run.facts.header = bytesToHex(hp.header.encoded);
        b.run.facts.checkpoint = await checkpointNow(reads, d, kn.sets, kn.keys);
      }
      const t = await trieP;
      const tv = t.ok ? hexToBytes(decode("bytes32", t.value)[0] as Hex) : null;
      const trieId = tv && tv.some((c) => c !== 0) ? tv : hexToBytes(env.recordedVault.trieId);
      const key = releasedKey(burn.burnId);
      const rootKey = childRootKey(trieId);
      const [rp, cp, evm] = await Promise.all([
        reads.v3<{ proof: Hex[] }>("state_getReadProof", [[bytesToHex(rootKey)], hp.block.hash]),
        reads.v3<{ proof: Hex[] }>("state_getChildReadProof", [bytesToHex(rootKey), [bytesToHex(key)], hp.block.hash]),
        reads.call(env.v3Evm, env.vault, "released(bytes32)", [burn.burnId]),
      ]);
      const rootItems = proofOf(rp);
      const served = proofOf(cp);
      const raw3: Raw[] = [
        { label: `V3's header #${n(hp.block.number)}`, call: callText("chain_getHeader", [hp.block.hash], null), value: bytesToHex(hp.header.encoded) },
        { label: "its justification", call: "grandpa_proveFinality", value: bytesToHex(hp.justification) },
        { label: "the child-root proof", call: callText("state_getReadProof", [[bytesToHex(rootKey)], hp.block.hash], rp.ep), value: rootItems ? rootItems.join("\n") : rp.ok ? "no proof" : rp.why },
        { label: "the child proof of released[burnId]", call: callText("state_getChildReadProof", [bytesToHex(rootKey), [bytesToHex(key)], hp.block.hash], cp.ep), value: served ? served.join("\n") : cp.ok ? "no proof" : cp.why },
        admin.raw,
      ];
      const from3 = [...new Set([node, ...("skip" in kn ? [] : kn.from), ...fromOf(t, rp, cp, evm, await adminP)])];
      if ("skip" in kn || !sigs) {
        b.settle("released", { state: "skipped", sub: "skip" in kn ? kn.skip : "Not checked: the signature code did not load", lines: [admin.line], raw: raw3, from: from3, retry: true });
      } else if (!sigs.ok) {
        b.settle("released", { state: "failed", sub: `V3's head #${n(hp.block.number)}: ${sigs.problems[0] ?? "its signatures do not verify"}`, raw: raw3, ms: ms3, from: from3 });
        return release();
      } else if (!rootItems || !served) {
        b.settle("released", { state: "skipped", sub: "Not checked: the V3 node did not serve the proofs", lines: [admin.line], raw: raw3, from: from3, retry: true });
      } else {
        let value: Uint8Array | null;
        let items = 0;
        const tw = performance.now();
        try {
          const rootNodes = rootItems.map(hexToBytes);
          const childRoot = provenValue(hp.header.stateRoot, rootNodes, rootKey, "child-root");
          const nodes = childItems(served.map(hexToBytes), rootNodes);
          items = rootNodes.length + nodes.length;
          const r = readProof(childRoot, nodes, key);
          if (r.itemsUsed !== nodes.length) throw new TrieProofError(`the released proof has ${nodes.length - r.itemsUsed} items the walk does not use`);
          value = r.value;
        } catch (e) {
          b.settle("released", { state: "failed", sub: errorText(e), raw: raw3, ms: ms3 + performance.now() - tw, from: from3 });
          return release();
        }
        ms3 += performance.now() - tw;
        const released = wordValue(value) === 1n;
        const evmSays = boolOf(evm);
        const lines3: Line[] = [
          { ok: true, text: `V3 #${n(hp.block.number)}: its header hashes to its block, ${sigs.valid} of ${sigs.total} signatures of set ${kn.setId} valid${kn.carried ? `, its keys carried forward through ${plural(kn.carried, "set change")}` : ""}` },
          evmSays === null ? { ok: null, text: "released() on V3's EVM RPC: not answered" } : { ok: evmSays === released, text: `released() = ${evmSays}, from V3's EVM RPC` },
          admin.line,
        ];
        const ev3: Ev[] = [
          { k: "Proven", v: [{ t: "mono", text: `released[${sh(burn.burnId)}] = ${released ? "1" : "0"}` }], wide: true },
          { k: "At", v: [{ t: "mono", text: `V3 #${n(hp.block.number)}` }, { t: "hash", full: hp.block.hash, label: "V3's finalized block", href: env.v3Block(hp.block.number) }] },
          { k: "Items", v: [{ t: "mono", text: `${items}` }] },
        ];
        const run = x.release?.run ?? null;
        if (released && run) {
          const located = await locateExtrinsic(reads, run.block, run.extrinsic);
          ev3.push({ k: "Release", v: [{ t: "mono", text: `V3 #${n(run.block)}` }, { t: "hash", full: run.extrinsic, label: "the release extrinsic", href: env.v3Block(run.block) }] });
          lines3.push(located === null ? { ok: null, text: `The release's block #${n(run.block)}: not answered` } : located ? { ok: true, text: `Its extrinsic is in V3 #${n(run.block)}, found by its blake2 hash` } : { ok: false, text: `the release block #${n(run.block)} holds no extrinsic of that hash` });
        }
        if (released && x.release?.amount != null && x.release.payee) {
          ev3.push({ k: "Paid", v: [{ t: "text", text: `${tpot(x.release.amount)} to ${sh(checksum(x.release.payee))}` }, { t: "src", kind: "recorded", text: `Recorded · ${x.release.from}` }], wide: true });
        }
        b.settle("released", {
          state: released ? "passed" : "open",
          sub: released ? `released[${sh(burn.burnId)}] = 1 at V3 #${n(hp.block.number)} · ${sigs.valid} of ${sigs.total} · set ${kn.setId}` : "Not released on V3 yet",
          ms: ms3,
          ev: ev3,
          lines: lines3,
          raw: raw3,
          from: from3,
          trust: { kind: "verify", text: TRUST.released },
        });
      }
    }

    // B4: the release itself, trusted.
    return release();
  } catch (e) {
    if (e instanceof Stopped) return b.run;
    throw e;
  }
}

/** Whether V3 block `number` holds an extrinsic whose blake2-256 is `hash`; null when the node does not answer. */
async function locateExtrinsic(reads: Reads, number: number, hash: Hex): Promise<boolean | null> {
  const h = await reads.v3<Hex | null>("chain_getBlockHash", [number]);
  if (!h.ok || !h.value) return null;
  const blk = await reads.v3<{ block: { extrinsics: Hex[] } } | null>("chain_getBlock", [h.value]);
  if (!blk.ok || !blk.value) return null;
  return blk.value.block.extrinsics.some((e) => bytesToHex(blake2b256(hexToBytes(e))) === hash.toLowerCase());
}

// ---------------------------------------------------------------------------------------------
// The key history: the client's keys traced back to its checkpoint, on demand

export interface HistoryChange {
  setId: bigint;
  /** The V3 block that started this set: the change. */
  at: number;
  state: "waiting" | "checking" | "passed" | "failed" | "skipped";
  text: string;
}

export interface History {
  /** The checkpoint: set 0 of the client, its block, and whether V3's node has that block and those keys. */
  checkpoint: { setId: bigint; at: number; hash: Hex | null; keysHash: Hex; lines: Line[] } | null;
  /** The Initialized event, from the records' initialize transaction. */
  init: { tx: Hex; block: number | null } | null;
  changes: HistoryChange[];
  /** Paused, Unpaused, Reinitialized, Halted or a new admin since the client's deployment. */
  events: Line | null;
  done: boolean;
  /** "45 of 45 set changes verified · the same 2 keys since set 19". */
  summary: string;
  reads: number;
}

/** A change the node could not give: not answered, no proof at that block, no header. Not checked, not failed. */
const notServed = (e: unknown): boolean => e instanceof AllFailed || e instanceof TransportError || e instanceof TypeError || (e instanceof V3Error && /^no proof$|^the V3 node has no (header|block)/.test(e.message));

/**
 * The client's key history: every set it installed (authoritySetAt), the checkpoint's block and keys
 * against V3's node, then each set change it imported, at the block that started the set, checked
 * again here, four at a time: the keys it is checked under are the set's own (their keccak is the
 * set's list hash, as the checkpoint's is the Initialized event's), its header hashes to its block,
 * its justification is signed by that set, and its ScheduledChange names exactly the client's next
 * list. So the chain closes from the checkpoint to the client's latest set. Then the events its
 * admin could have caused: Paused, Unpaused, Reinitialized, Halted, a new admin.
 */
export async function keyHistory(env: VerifyEnv, out: { emit(h: History): void; stopped(): boolean }): Promise<History> {
  const d = env.dest;
  const reads = new Reads(env);
  const v3r = new V3Reader(new CountingClient(env.v3, reads));
  const h: History = { checkpoint: null, init: null, changes: [], events: null, done: false, summary: "Reading the client's sets", reads: 0 };
  const emit = () => {
    if (out.stopped()) throw new Stopped();
    h.reads = reads.count;
    out.emit({ ...h, changes: h.changes.map((c) => ({ ...c })) });
  };
  try {
    emit();
    const count = await reads.call(d.rpcs, d.lightClient, "authoritySetCount()");
    if (!count.ok) {
      h.summary = `Not checked: no ${d.name} RPC answered authoritySetCount()`;
      h.done = true;
      emit();
      return h;
    }
    const total = Number(decode("uint256", count.value)[0] as bigint);
    const sets = await Promise.all(Array.from({ length: total }, (_, i) => reads.call(d.rpcs, d.lightClient, "authoritySetAt(uint256)", [i])));
    const list = sets.map((s) => (s.ok ? decodeSetAt(s.value) : null));
    const first = list[0];
    if (!first || list.some((s) => s === null)) {
      h.summary = `Not checked: ${d.name}'s RPCs did not answer every authoritySetAt`;
      h.done = true;
      emit();
      return h;
    }
    const all = list as SetAt[];
    h.changes = all.slice(1).map((s) => ({ setId: s.setId, at: s.activatedAt, state: "waiting", text: "" }));
    // The checkpoint, against V3's node; the admin's Initialized event, soon after the client's deployment.
    const [cpHash, init] = await Promise.all([
      reads.v3<Hex | null>("chain_getBlockHash", [first.activatedAt]),
      reads.logs(d.logs, { address: d.lightClient, topics: [TOPIC.initialized] }, d.clientFrom, d.clientFrom + 49_999, { maxCalls: 2, first: true, order: "oldest" }).catch(() => null),
    ]);
    const lines: Line[] = [];
    let checkpointHash: Hex | null = null;
    const log = init?.logs[0];
    if (log) {
      const [, listHash, number, hash] = decode("uint64,bytes32,uint32,bytes32", log.data) as [bigint, Hex, bigint, Hex];
      const at = Number(BigInt(log.blockNumber));
      checkpointHash = hash.toLowerCase() as Hex;
      lines.push({
        ok: listHash.toLowerCase() === first.listHash && Number(number) === first.activatedAt,
        text: `Initialized at ${d.name} #${n(at)} by its admin: set ${first.setId} at V3 #${n(Number(number))}, keys hash ${sh(listHash)}`,
      });
      h.init = { tx: log.transactionHash.toLowerCase() as Hex, block: at };
    } else lines.push({ ok: null, text: `The Initialized event: not found by ${d.name}'s RPCs` });
    const nodeHash = cpHash.ok && cpHash.value ? (cpHash.value.toLowerCase() as Hex) : null;
    if (nodeHash && checkpointHash) lines.push({ ok: nodeHash === checkpointHash, text: nodeHash === checkpointHash ? `V3's node has the checkpoint's block at #${n(first.activatedAt)}: ${sh(nodeHash)}` : `V3's node has another block at #${n(first.activatedAt)}` });
    if (nodeHash) {
      const rk = await reads.v3<Hex>("state_call", ["GrandpaApi_grandpa_authorities", "0x", nodeHash]);
      if (rk.ok) {
        const runtime = decodeAuthorityList(hexToBytes(rk.value)).map((a) => bytesToHex(a.id));
        lines.push({ ok: runtime.join() === first.keys.join(), text: runtime.join() === first.keys.join() ? `V3's runtime names the checkpoint's ${first.keys.length} keys there` : "V3's runtime names other keys at the checkpoint" });
      }
    }
    h.checkpoint = { setId: first.setId, at: first.activatedAt, hash: nodeHash ?? checkpointHash, keysHash: first.listHash, lines };
    h.summary = `Checking ${h.changes.length} set changes`;
    emit();
    // The events the admin could have caused, from the client's deployment on. Its constructor's
    // AdminTransferred, from no one to its deployer, is the deployment's own.
    const eventsP = (async (): Promise<Line> => {
      const what = "Paused, Unpaused, Reinitialized, Halted, AdminTransferred";
      try {
        const head = await reads.eth<Hex>(d.rpcs, "eth_blockNumber", []);
        if (!head.ok) return { ok: null, text: `${what}: not searched, no RPC answered` };
        const found = await reads.logs(d.logs, { address: d.lightClient, topics: [[TOPIC.paused, TOPIC.unpaused, TOPIC.reinitialized, TOPIC.halted, TOPIC.adminTransferred]] }, d.clientFrom, Number(BigInt(head.value)), { maxCalls: 24 });
        const acts = found.logs.filter((l) => !(l.topics[0]?.toLowerCase() === TOPIC.adminTransferred && BigInt(l.topics[1] ?? "0x0") === 0n));
        if (acts.length) {
          const names = [...new Set(acts.map((l) => env.registry.decodeLog(l)?.name ?? "an event"))].join(", ");
          return { ok: false, text: `${plural(acts.length, "admin event")} since its deployment: ${names}` };
        }
        if (found.oldest > d.clientFrom) return { ok: null, text: `No pause, reinitialize, halt or new admin back to #${n(found.oldest)}, as far as the nodes search` };
        return { ok: true, text: "Never paused, reinitialized or halted, and the same admin, since its deployment" };
      } catch (e) {
        return { ok: null, text: `${what}: not searched (${plainWhy(e)})` };
      }
    })();
    // Each change, four at a time, under the keys of the set before it: the keys whose keccak is that
    // set's list hash, which the change before named (or, for the first, the checkpoint's).
    const crypto = await env.crypto();
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        const c = h.changes[i];
        const before = all[i];
        const set = all[i + 1];
        if (!c || !before || !set) return;
        c.state = "checking";
        emit();
        try {
          const keys = before.keys.map(hexToBytes);
          if (keysHash(keys) !== before.listHash) {
            c.state = "failed";
            c.text = `#${n(set.activatedAt)}: the keys the client lists for set ${before.setId} do not hash to its list hash ${sh(before.listHash)}`;
          } else {
            const ch: SetChange = await v3r.changeAt(set.activatedAt, before.setId, keys, crypto);
            const same = keysHash(ch.next) === set.listHash;
            c.state = same ? "passed" : "failed";
            c.text = same ? `#${n(ch.number)}: signed by set ${before.setId} (${ch.signers.counted.length} of ${before.keys.length}), names set ${set.setId}'s keys` : `#${n(ch.number)}: its ScheduledChange names other keys than the client's set ${set.setId}`;
          }
        } catch (e) {
          c.state = notServed(e) ? "skipped" : "failed";
          c.text = `#${n(set.activatedAt)}: ${c.state === "skipped" ? `not checked, ${plainWhy(e) === "no proof" ? "the node gave no proof there" : plainWhy(e)}` : errorText(e)}`;
        }
        emit();
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    h.events = await eventsP;
    const ok = h.changes.filter((c) => c.state === "passed").length;
    const unchecked = h.changes.filter((c) => c.state === "skipped").length;
    const bad = h.changes.find((c) => c.state === "failed");
    const lists = new Set(all.map((s) => s.listHash)).size;
    const notes = `${unchecked ? ` · ${unchecked} not checked` : ""}${bad ? ` · set ${bad.setId}'s change does not` : ""}`;
    h.summary = `${ok} of ${h.changes.length} set changes verified${notes}${!bad && !unchecked && lists === 1 ? ` · the same ${first.keys.length} keys since set ${first.setId}` : ""}`;
    h.done = true;
    emit();
    return h;
  } catch (e) {
    if (e instanceof Stopped) return h;
    throw e;
  }
}
