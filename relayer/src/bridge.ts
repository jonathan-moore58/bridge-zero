// BridgeMinter and WrappedTPOT (contracts/src/bridge) computed off chain the way the contracts
// compute it: the ABI of the minter's, the token's and the light client's calls and events, the
// LockProof a mint bundle carries, the signers hint the light client takes, the constructor
// arguments of the deployment, the checks that deployed code is the build's and that a build is
// from the current sources, the light client's storage after initialize (for a simulation), the
// errors a revert names, the offline checks of a mint bundle, the demo's tampered and replayed
// calls with the reverts they have to get, the guard that keeps a dry run from sending (on fetch,
// on the WebSocket client and on a polkadot-js provider), and the windows a log search asks. No
// network access: mint.ts, release.ts and bridge.test.ts use it.

import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, equalBytes, flipByte, hexToBytes, shortHex, type Hex } from "./bytes.js";
import type { MintBundleFixture } from "./fixture.js";
import { clientVerifies, threshold, verifyJustification, type JustificationResult, type PrecommitResult } from "./grandpa.js";
import { blake2_256, childRootKey, storageKey } from "./hash.js";
import { decodeReviveAccountInfo, reviveAccountInfoKey, reviveSlotKey } from "./revive.js";
import { RpcClient } from "./rpc.js";
import { decodeAuthorityList, decodeFinalityProof, decodeHeader, decodeJustification, decodeU64, encodeCompact, grandpaLogs, type Justification } from "./scale.js";
import { readProof } from "./trie.js";
import { addressWord, commitmentSlot, formatUnits, lockCommitment, selector, topic, uintWord, wordToAddress, type LogJson } from "./vault.js";

// ---------------------------------------------------------------------------------------
// Chains and units

/** block.chainid where the vault runs (the Portaldot V3 testnet) and where the minter runs (Sepolia). */
export const V3_CHAIN_ID = 420_420_777n;
export const SEPOLIA_CHAIN_ID = 11_155_111n;

/** wtPOT has 14 decimals: one unit is one native base unit of tPOT. */
export const WTPOT_DECIMALS = 14;
export const formatWtpot = (units: bigint): string => `${formatUnits(units, WTPOT_DECIMALS)} wtPOT`;

// ---------------------------------------------------------------------------------------
// ABI encoding

/** One ABI parameter: a static 32-byte word, bytes, bytes32[] (words), bytes[] (list) or a tuple (a struct). */
export type AbiParam = { word: Uint8Array } | { bytes: Uint8Array } | { words: Uint8Array[] } | { list: Uint8Array[] } | { tuple: AbiParam[] };

const isDynamic = (p: AbiParam): boolean => !("word" in p) && (!("tuple" in p) || p.tuple.some(isDynamic));
const padRight = (b: Uint8Array): Uint8Array => concatBytes(b, new Uint8Array((32 - (b.length % 32)) % 32));

function encodeStatic(p: AbiParam): Uint8Array {
  if ("word" in p) {
    if (p.word.length !== 32) throw new Error(`a word is 32 bytes, got ${p.word.length}`);
    return p.word;
  }
  if ("tuple" in p) return abiEncode(p.tuple);
  throw new Error("not a static parameter");
}

function encodeTail(p: AbiParam): Uint8Array {
  if ("bytes" in p) return concatBytes(uintWord(BigInt(p.bytes.length)), padRight(p.bytes));
  if ("words" in p) {
    if (p.words.some((w) => w.length !== 32)) throw new Error("a bytes32[] item is not 32 bytes");
    return concatBytes(uintWord(BigInt(p.words.length)), ...p.words);
  }
  if ("list" in p) return concatBytes(uintWord(BigInt(p.list.length)), abiEncode(p.list.map((bytes) => ({ bytes }))));
  if ("tuple" in p) return abiEncode(p.tuple);
  throw new Error("not a dynamic parameter");
}

/** Head/tail encoding of a parameter list (abi.encode of a function's arguments, or of a struct). */
export function abiEncode(params: AbiParam[]): Uint8Array {
  const heads: Uint8Array[] = [];
  const tails: Uint8Array[] = [];
  let offset = params.reduce((n, p) => n + (isDynamic(p) ? 32 : encodeStatic(p).length), 0);
  for (const p of params) {
    if (!isDynamic(p)) {
      heads.push(encodeStatic(p));
      continue;
    }
    const tail = encodeTail(p);
    heads.push(uintWord(BigInt(offset)));
    tails.push(tail);
    offset += tail.length;
  }
  return concatBytes(...heads, ...tails);
}

export const wordAt = (data: Uint8Array, i: number): Uint8Array => {
  if (data.length < 32 * (i + 1)) throw new Error(`no word ${i} in ${data.length} bytes`);
  return data.slice(32 * i, 32 * i + 32);
};
export const uintAt = (data: Uint8Array, i: number): bigint => BigInt(bytesToHex(wordAt(data, i)));
export const addressAt = (data: Uint8Array, i: number, what = `word ${i}`): Uint8Array => wordToAddress(wordAt(data, i), what);

/** A call whose arguments are all static words. */
export const callData = (signature: string, ...words: Uint8Array[]): Uint8Array => concatBytes(selector(signature), ...words);

// ---------------------------------------------------------------------------------------
// The minter, the token and the light client

/** BridgeMinter's external functions. The struct is LockProof (below), a tuple in the signature. */
export const MINTER = {
  importAndMint: "importAndMint(bytes,bytes,bytes,(bytes32,bytes[],bytes[],bytes[],address,uint256,uint256))",
  mint: "mint((bytes32,bytes[],bytes[],bytes[],address,uint256,uint256))",
  bindVault: "bindVault(bytes32,bytes[])",
  burn: "burn(uint256,address)",
  bound: "bound()",
  vaultTrieId: "vaultTrieId()",
  used: "used(uint256)",
  burnCount: "burnCount()",
  commitmentOf: "commitmentOf(address,uint256,uint256)",
  slotKeyOf: "slotKeyOf(uint256)",
  burnIdOf: "burnIdOf(uint256)",
  lightClient: "lightClient()",
  vault: "vault()",
  vaultChainId: "vaultChainId()",
  vaultCodeHash: "vaultCodeHash()",
  token: "token()",
} as const;

/** WrappedTPOT's functions the tools read. */
export const TOKEN = {
  balanceOf: "balanceOf(address)",
  totalSupply: "totalSupply()",
  decimals: "decimals()",
  minter: "minter()",
} as const;

/** GrandpaLightClient's functions the tools use. */
export const CLIENT = {
  initialize: "initialize(bytes32,uint64,bytes32[],bytes)",
  currentSetId: "currentSetId()",
  latestFinalized: "latestFinalized()",
  isImported: "isImported(bytes32)",
  halted: "halted()",
  paused: "paused()",
  genesisHash: "genesisHash()",
} as const;

/** BridgeMinter.LockProof: the block the proofs are for, the three proofs and the lock's fields. */
export interface LockProof {
  blockHash: Uint8Array;
  accountProof: Uint8Array[];
  childRootProof: Uint8Array[];
  slotProof: Uint8Array[];
  recipient: Uint8Array;
  amount: bigint;
  nonce: bigint;
}

export const lockProofParam = (p: LockProof): AbiParam => ({
  tuple: [
    { word: p.blockHash },
    { list: p.accountProof },
    { list: p.childRootProof },
    { list: p.slotProof },
    { word: addressWord(p.recipient) },
    { word: uintWord(p.amount) },
    { word: uintWord(p.nonce) },
  ],
});

export const importAndMintCalldata = (header: Uint8Array, finalityProof: Uint8Array, signers: Uint8Array, p: LockProof): Uint8Array =>
  concatBytes(selector(MINTER.importAndMint), abiEncode([{ bytes: header }, { bytes: finalityProof }, { bytes: signers }, lockProofParam(p)]));

export const mintCalldata = (p: LockProof): Uint8Array => concatBytes(selector(MINTER.mint), abiEncode([lockProofParam(p)]));

export const bindVaultCalldata = (blockHash: Uint8Array, accountProof: Uint8Array[]): Uint8Array =>
  concatBytes(selector(MINTER.bindVault), abiEncode([{ word: blockHash }, { list: accountProof }]));

/**
 * BridgeMinter's constructor arguments, as appended to its creation code:
 * abi.encode(lightClient, vault, vaultChainId, vaultCodeHash, token).
 */
export function minterConstructorArgs(lightClient: Uint8Array, vault: Uint8Array, vaultChainId: bigint, vaultCodeHash: Uint8Array, token: Uint8Array): Uint8Array {
  if (vaultCodeHash.length !== 32) throw new Error(`a code hash is 32 bytes, got ${vaultCodeHash.length}`);
  return concatBytes(addressWord(lightClient), addressWord(vault), uintWord(vaultChainId), vaultCodeHash, addressWord(token));
}

/** WrappedTPOT's constructor argument: abi.encode(minter). */
export const tokenConstructorArgs = (minter: Uint8Array): Uint8Array => addressWord(minter);

/** GrandpaLightClient.initialize(genesis, setId, keys, checkpointHeader). */
export const initializeCalldata = (genesis: Uint8Array, setId: bigint, keys: Uint8Array[], checkpointHeader: Uint8Array): Uint8Array =>
  concatBytes(selector(CLIENT.initialize), abiEncode([{ word: genesis }, { word: uintWord(setId) }, { words: keys }, { bytes: checkpointHeader }]));

// ---------------------------------------------------------------------------------------
// Events

export const VAULT_BOUND_TOPIC = topic("VaultBound(address,bytes32,bytes32)");
export const MINTED_TOPIC = topic("Minted(uint256,address,uint256,bytes32)");
export const BURN_REQUESTED_TOPIC = topic("BurnRequested(uint256,address,address,uint256,bytes32)");
export const TRANSFER_TOPIC = topic("Transfer(address,address,uint256)");
export const HEADER_IMPORTED_TOPIC = topic("HeaderImported(bytes32,uint32,bytes32,uint64,uint256)");
export const AUTHORITY_SET_CHANGED_TOPIC = topic("AuthoritySetChanged(uint64,uint64,bytes32,uint256,uint32)");
export const HALTED_TOPIC = topic("Halted(uint32,bytes32,uint8)");

const wordsOf = (data: Uint8Array, count: number, what: string): Uint8Array[] => {
  if (data.length !== 32 * count) throw new Error(`${what}: ${data.length} bytes of data, expected ${32 * count}`);
  return Array.from({ length: count }, (_, i) => data.slice(32 * i, 32 * i + 32));
};

function expectLog(log: LogJson, t: Hex, topics: number, what: string): void {
  if (log.topics.length !== topics || log.topics[0].toLowerCase() !== t) throw new Error(`not a ${what} log`);
}

/** VaultBound(address indexed vault, bytes32 trieId, bytes32 indexed blockHash). */
export function decodeVaultBound(log: LogJson): { vault: Uint8Array; trieId: Uint8Array; blockHash: Uint8Array } {
  expectLog(log, VAULT_BOUND_TOPIC, 3, "VaultBound");
  const [trieId] = wordsOf(hexToBytes(log.data), 1, "VaultBound");
  return { vault: wordToAddress(hexToBytes(log.topics[1]), "VaultBound.vault"), trieId, blockHash: hexToBytes(log.topics[2]) };
}

/** Minted(uint256 indexed nonce, address indexed recipient, uint256 amount, bytes32 indexed blockHash). */
export function decodeMinted(log: LogJson): { nonce: bigint; recipient: Uint8Array; amount: bigint; blockHash: Uint8Array } {
  expectLog(log, MINTED_TOPIC, 4, "Minted");
  const [amount] = wordsOf(hexToBytes(log.data), 1, "Minted");
  return {
    nonce: BigInt(log.topics[1]),
    recipient: wordToAddress(hexToBytes(log.topics[2]), "Minted.recipient"),
    amount: BigInt(bytesToHex(amount)),
    blockHash: hexToBytes(log.topics[3]),
  };
}

/**
 * BurnRequested(uint256 indexed burnNonce, address indexed from, address indexed v3Recipient,
 * uint256 amount, bytes32 burnId): the start of the trusted return path.
 */
export function decodeBurnRequested(log: LogJson): { burnNonce: bigint; from: Uint8Array; v3Recipient: Uint8Array; amount: bigint; burnId: Uint8Array } {
  expectLog(log, BURN_REQUESTED_TOPIC, 4, "BurnRequested");
  const [amount, burnId] = wordsOf(hexToBytes(log.data), 2, "BurnRequested");
  return {
    burnNonce: BigInt(log.topics[1]),
    from: wordToAddress(hexToBytes(log.topics[2]), "BurnRequested.from"),
    v3Recipient: wordToAddress(hexToBytes(log.topics[3]), "BurnRequested.v3Recipient"),
    amount: BigInt(bytesToHex(amount)),
    burnId,
  };
}

/** Transfer(address indexed from, address indexed to, uint256 value). */
export function decodeTransfer(log: LogJson): { from: Uint8Array; to: Uint8Array; value: bigint } {
  expectLog(log, TRANSFER_TOPIC, 3, "Transfer");
  const [value] = wordsOf(hexToBytes(log.data), 1, "Transfer");
  return { from: wordToAddress(hexToBytes(log.topics[1]), "Transfer.from"), to: wordToAddress(hexToBytes(log.topics[2]), "Transfer.to"), value: BigInt(bytesToHex(value)) };
}

/** HeaderImported(bytes32 indexed blockHash, uint32 indexed number, bytes32 stateRoot, uint64 setId, uint256 signatures). */
export function decodeHeaderImported(log: LogJson): { blockHash: Uint8Array; number: number; stateRoot: Uint8Array; setId: bigint; signatures: number } {
  expectLog(log, HEADER_IMPORTED_TOPIC, 3, "HeaderImported");
  const [stateRoot, setId, signatures] = wordsOf(hexToBytes(log.data), 3, "HeaderImported");
  return {
    blockHash: hexToBytes(log.topics[1]),
    number: Number(BigInt(log.topics[2])),
    stateRoot,
    setId: BigInt(bytesToHex(setId)),
    signatures: Number(BigInt(bytesToHex(signatures))),
  };
}

// ---------------------------------------------------------------------------------------
// Errors

/**
 * The errors a deployment or a mint can revert with, by signature: BridgeMinter's, WrappedTPOT's,
 * SubstrateProofs' (the trie walk, through the StorageProofs library), the light client's and its
 * libraries', and Solidity's own (the vendored trie walk reverts with an Error string). mint.ts adds
 * what the artifacts' ABIs declare, so a renamed error is still named.
 */
export const BRIDGE_ERRORS: readonly string[] = [
  // BridgeMinter
  "ZeroArgument()", "VaultAlreadyBound()", "VaultNotBound()", "NotAContract(uint256,uint8)", "VaultCodeMismatch(bytes32)",
  "BlockMismatch(bytes32,bytes32)", "ZeroAmount()", "ZeroRecipient()", "CommitmentLength(uint256)",
  "CommitmentMismatch(bytes32,bytes32)", "NonceAlreadyUsed(uint256)",
  // WrappedTPOT
  "ZeroMinter()", "NotMinter()", "ZeroAddress()", "InsufficientBalance(uint256,uint256)", "InsufficientAllowance(uint256,uint256)",
  // SubstrateProofs, and the BLAKE2b library it hashes with
  "EmptyProof()", "EmptyKey()", "KeyNotPresent(bytes32,bytes)", "EmptyValue(bytes32,bytes)", "ChildRootLength(uint256)", "ZeroChildRoot()",
  "KeyLengthExceeded()", "OutputLengthCannotBeZero()", "OutputLengthExceeded()",
  // GrandpaLightClient, AuthoritySets and GrandpaCodec
  "NotAdmin()", "ZeroAdmin()", "AlreadyInitialized()", "NotInitialized()", "ClientHalted()", "ClientPaused()", "NotHalted()",
  "EmptyAuthoritySet()", "TooManyAuthorities(uint256)", "InvalidAuthorityKey(uint256,bytes32)", "DuplicateAuthorityKey(uint256,bytes32)",
  "UnknownAuthoritySet(uint64)", "UnknownBlock(bytes32)", "HeaderHashMismatch(bytes32,bytes32)", "TargetNumberMismatch(uint32,uint32)",
  "FinalityProofBlockMismatch(bytes32,bytes32)", "NotNewer(uint32,uint32)", "MalformedSigners(uint256)", "BelowThreshold(uint256,uint256)",
  "PrecommitIndexOutOfRange(uint256,uint256)", "DuplicatePrecommit(uint256,uint256)", "AuthorityIndexOutOfRange(uint256,uint256,uint256)",
  "DuplicateSigner(uint256,uint256)", "SignersOutOfOrder(uint256,uint256,uint256)", "PrecommitNotOnTarget(uint256,uint256)",
  "UnknownSigner(uint256,uint256,bytes32)", "InvalidSignature(uint256,uint256)", "WrongSetId(uint64,uint64)",
  "Truncated(uint256,uint256)", "TrailingBytes(uint256,uint256)", "NonCanonicalCompact(uint256)", "CompactOverflow(uint256)",
  "UnknownDigestItem(uint8,uint256)", "UnknownGrandpaLog(uint8,uint256)", "VotesAncestriesNotEmpty(uint256)", "UnknownHeadersNotEmpty(uint256)",
  // Solidity
  "Error(string)", "Panic(uint256)",
];

/** `signatures` by selector, to name a revert. */
export const errorMap = (signatures: readonly string[]): Map<Hex, string> => new Map(signatures.map((s) => [bytesToHex(selector(s)), s] as const));

/** One decoded argument of a revert: numbers in decimal, addresses whole, hashes shortened, strings quoted. */
function formatArg(type: string, data: Uint8Array, i: number): string {
  if (type === "string" || type === "bytes") {
    const at = Number(uintAt(data, i));
    const length = Number(uintAt(data.slice(at), 0));
    if (at + 32 + length > data.length) throw new Error("truncated");
    const value = data.slice(at + 32, at + 32 + length);
    return type === "string" ? JSON.stringify(new TextDecoder().decode(value)) : `${shortHex(value)} (${length} B)`;
  }
  const w = wordAt(data, i);
  if (type === "address") return bytesToHex(w.slice(12));
  if (type === "bool") return uintAt(data, i) === 0n ? "false" : "true";
  if (type.startsWith("uint") || type.startsWith("int")) return String(uintAt(data, i));
  return shortHex(w);
}

/** What revert data names, such as "NonceAlreadyUsed(0)" or 'Error("Incomplete Proof!")'; null for data no entry of `errors` matches. */
export function revertName(data: Uint8Array, errors: Map<Hex, string>): string | null {
  if (data.length < 4) return null;
  const signature = errors.get(bytesToHex(data.slice(0, 4)));
  if (!signature) return null;
  const name = signature.slice(0, signature.indexOf("("));
  const types = signature.slice(signature.indexOf("(") + 1, -1).split(",").filter(Boolean);
  const args = data.slice(4);
  try {
    return `${name}(${types.map((t, i) => formatArg(t, args, i)).join(", ")})`;
  } catch {
    return `${name}(${shortHex(args)})`;
  }
}

// ---------------------------------------------------------------------------------------
// The signers hint

export interface SignersHint {
  /** 2 bytes per counted precommit: its position in the justification, the signer's index in the set. */
  hint: Uint8Array;
  /** The precommits the hint names, in increasing authority index. */
  counted: PrecommitResult[];
  result: JustificationResult;
}

/**
 * The hint relay.ts builds for an import: the justification is verified under `keys` and `setId`
 * with the client's own signature check (clientVerifies), and the hint names exactly the threshold
 * of valid precommits, as (position, index in the set) pairs in increasing index, the order the
 * client requires. Throws unless the client would accept the justification.
 */
export function signersHint(j: Justification, keys: Uint8Array[], setId: bigint): SignersHint {
  const result = verifyJustification(j, keys, setId, clientVerifies);
  if (result.valid < result.required) throw new Error(`the justification does not verify under set ${setId}: ${result.problems.join("; ")}`);
  // A hint names a precommit by a one-byte position.
  const counted = result.precommits
    .filter((p) => p.problem === undefined && p.index < 256)
    .sort((a, b) => a.authorityIndex - b.authorityIndex)
    .slice(0, result.required);
  if (counted.length < result.required) throw new Error("the valid precommits are beyond position 255, where a signers hint cannot name them");
  return { hint: Uint8Array.from(counted.flatMap((p) => [p.index, p.authorityIndex])), counted, result };
}

// ---------------------------------------------------------------------------------------
// Deployed code

/** forge's immutableReferences: per immutable (its AST id), the byte ranges of its words in the runtime code. */
export type ImmutableReferences = Record<string, { start: number; length: number }[]>;

/**
 * Why `code` is not the build's runtime code with its immutables filled in, or null when it is:
 * byte for byte the build's outside the immutables' words, every word of one immutable the same,
 * and the immutables' values, one word each, exactly `expected` in some order (the constructor's
 * arguments; an artifact without its AST does not say which immutable is which).
 */
export function immutablesProblem(code: Uint8Array, runtime: Uint8Array, references: ImmutableReferences, expected: Uint8Array[]): string | null {
  if (code.length !== runtime.length) return `${code.length} bytes of code, the build has ${runtime.length}`;
  const outside = runtime.slice();
  const values: Hex[] = [];
  for (const [id, refs] of Object.entries(references)) {
    if (refs.length === 0 || refs.some((r) => r.length !== 32 || r.start + 32 > code.length)) return `immutable ${id} has a reference that is not one word in the code`;
    const words = refs.map((r) => bytesToHex(code.slice(r.start, r.start + 32)));
    if (new Set(words).size !== 1) return `immutable ${id} holds different words at its references`;
    values.push(words[0]);
    for (const r of refs) outside.set(code.subarray(r.start, r.start + 32), r.start);
  }
  if (!equalBytes(outside, code)) return "the code differs from the build outside the immutables";
  const want = expected.map((w) => bytesToHex(w)).sort();
  if (values.length !== want.length || values.sort().some((v, i) => v !== want[i])) return `the immutables hold ${values.join(", ")}, not the constructor's ${want.join(", ")}`;
  return null;
}

/**
 * The keccak256 a build can record for a source file (solc's metadata, per source): of its bytes,
 * and of its bytes with CRLF line ends made LF, as forge reads sources on Windows, where a checkout
 * can have CRLF line ends.
 */
export function sourceHashes(bytes: Uint8Array): Hex[] {
  const lf: number[] = [];
  for (let i = 0; i < bytes.length; i++) if (!(bytes[i] === 0x0d && bytes[i + 1] === 0x0a)) lf.push(bytes[i]);
  return [bytesToHex(keccak_256(bytes)), bytesToHex(keccak_256(Uint8Array.from(lf)))];
}

/** The libraries of `libraries` (id => address) whose address the code carries: the ones it calls. */
export function librariesIn(code: Uint8Array, libraries: Record<string, string>): Record<string, string> {
  const hex = bytesToHex(code);
  return Object.fromEntries(Object.entries(libraries).filter(([, address]) => hex.includes(address.toLowerCase().slice(2))));
}

// ---------------------------------------------------------------------------------------
// The light client's storage (AuthoritySets.Store at slot 0; relay.ts has the layout)

const SLOT_MOD = 1n << 256n;
const hashSlot = (...parts: Uint8Array[]): bigint => BigInt(bytesToHex(keccak_256(concatBytes(...parts))));
const mapSlot = (key: Uint8Array, slot: bigint): bigint => hashSlot(key, uintWord(slot));
const plus = (slot: bigint, offset: bigint): bigint => (slot + offset) % SLOT_MOD;

/**
 * The slots a fresh client's initialize writes: the packed word (admin, latestNumber, currentSet),
 * the genesis hash, the latest hash, the set list and its first set (3 slots), setIndexOf of that
 * set, the key list (its keys and their points) and the checkpoint header's record (2 slots).
 */
export function initializeWrites(checkpointHash: Uint8Array, genesis: Uint8Array, setId: bigint, keys: Uint8Array[]): bigint[] {
  const header = mapSlot(checkpointHash, 6n);
  const set = hashSlot(uintWord(3n));
  const slots = [0n, 1n, 2n, 3n, set, plus(set, 1n), plus(set, 2n), header, plus(header, 1n)];
  slots.push(mapSlot(keccak_256(concatBytes(genesis, uintWord(setId))), 5n));
  const list = mapSlot(keccak_256(concatBytes(...keys)), 4n);
  const keysAt = hashSlot(uintWord(list));
  const points = hashSlot(uintWord(plus(list, 1n)));
  slots.push(list, plus(list, 1n));
  keys.forEach((_, i) => slots.push(plus(keysAt, BigInt(i)), plus(points, 2n * BigInt(i)), plus(points, 2n * BigInt(i) + 1n)));
  return slots;
}

// ---------------------------------------------------------------------------------------
// A mint bundle

/** The LockProof of a bundle: the proofs as the node served them, and the lock's fields. */
export function bundleProof(b: MintBundleFixture): LockProof {
  return {
    blockHash: hexToBytes(b.header.hash),
    accountProof: b.account.proof.nodes.map((n) => hexToBytes(n)),
    childRootProof: b.childRoot.proof.nodes.map((n) => hexToBytes(n)),
    slotProof: b.slot.proof.nodes.map((n) => hexToBytes(n)),
    recipient: hexToBytes(b.lock.recipient),
    amount: BigInt(b.lock.amountNative),
    nonce: BigInt(b.lock.nonce),
  };
}

/** The calldata of importAndMint for a bundle: B's header, its finality proof, the signers hint and the LockProof. */
export function bundleCalldata(b: MintBundleFixture): Uint8Array {
  return importAndMintCalldata(hexToBytes(b.header.scale), hexToBytes(b.finalityProof.scale), hexToBytes(b.signers.hint), bundleProof(b));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** The value a walk proves, or null when it fails or shows the key absent. */
function proven(root: Uint8Array, proof: Uint8Array[], key: Uint8Array): Uint8Array | null {
  try {
    return readProof(root, proof, key).value;
  } catch {
    return null;
  }
}

/** The walk from `root` along `key` reaches `value` and uses every item. */
function walks(root: Uint8Array, nodes: Uint8Array[], key: Uint8Array, value: Uint8Array, what: string): void {
  const read = readProof(root, nodes, key);
  assert(read.value, `the ${what} proof shows the key absent`);
  assert(equalBytes(read.value, value), `the ${what} proof leads to another value`);
  assert(read.itemsUsed === nodes.length, `the ${what} proof has ${nodes.length - read.itemsUsed} items the walk does not need`);
}

/**
 * Verifies a bundle offline, as the light client and the minter will: B's header hashes to its hash
 * and carries no set change, its parent header hashes to B's parent hash; the signing set is the one
 * its runtime call and set id storage hold, read at B's parent; the finality proof is for B, without
 * unknown headers, and its justification verifies under that set with the client's own signature
 * check, every precommit; the signers hint is the one relay.ts builds; each proof walks from B's
 * state root (the slot from the proven child root) to its value using every item, and fails with
 * any byte of any item flipped; the account entry is a 130-byte Contract entry naming the vault's
 * trie id and code hash; the slot is commitments[nonce] and holds the lock's commitment, recomputed
 * from the lock. Returns each check as [passed, what].
 */
export function checkBundle(b: MintBundleFixture): [boolean, string][] {
  const lines: [boolean, string][] = [];
  const check = (what: string, run: () => string | void) => {
    try {
      const detail = run();
      lines.push([true, detail ? `${what}: ${detail}` : what]);
    } catch (error) {
      lines.push([false, `${what}: ${error instanceof Error ? error.message : String(error)}`]);
    }
  };
  const fail = (what: string) => {
    lines.push([false, what]);
    return lines;
  };
  let header: ReturnType<typeof decodeHeader>;
  try {
    header = decodeHeader(hexToBytes(b.header.scale));
  } catch (error) {
    return fail(`B's header does not decode: ${error instanceof Error ? error.message : String(error)}`);
  }
  const B = hexToBytes(b.header.hash);
  check("B's header hashes to its block hash and changes no set", () => {
    assert(equalBytes(blake2_256(header.encoded), B), `blake2_256 of the header is ${bytesToHex(blake2_256(header.encoded))}`);
    assert(header.number === b.header.number && b.provenance.block.hash === b.header.hash && b.provenance.block.number === header.number, "the header is not the provenance block");
    assert(bytesToHex(header.stateRoot) === b.header.stateRoot && bytesToHex(header.parentHash) === b.header.parentHash, "the state root or parent hash differs from the decoded one");
    const change = grandpaLogs(header).find((l) => l.log.kind === "ScheduledChange" || l.log.kind === "ForcedChange");
    assert(!change, `B carries a ${change?.log.kind}: a bundle is taken at a block that changes no set`);
    return `#${header.number.toLocaleString("en-US")} ${shortHex(B)}, state root ${shortHex(header.stateRoot)}`;
  });
  check("B's parent header hashes to B's parent hash", () => {
    const scale = hexToBytes(b.parentHeader.scale);
    const parent = decodeHeader(scale);
    assert(equalBytes(blake2_256(scale), hexToBytes(b.parentHeader.hash)), "the parent header does not hash to its hash");
    assert(equalBytes(hexToBytes(b.parentHeader.hash), header.parentHash) && parent.number === header.number - 1, "not B's parent");
    return `#${parent.number.toLocaleString("en-US")} ${shortHex(b.parentHeader.hash)}`;
  });

  const s = b.signingSet;
  const keys = s.authorities.map((a) => hexToBytes(a.id));
  const setId = BigInt(s.setId);
  check("the signing set is Grandpa.CurrentSetId and GrandpaApi_grandpa_authorities at B's parent", () => {
    assert(s.runtimeCall && s.setIdStorage, "the set was not read from state");
    assert(s.at.hash === b.parentHeader.hash && s.at.number === b.parentHeader.number, "the set was not read at B's parent");
    const list = decodeAuthorityList(hexToBytes(s.runtimeCall.scale));
    assert(list.length === keys.length && list.every((a, i) => equalBytes(a.id, keys[i]) && a.weight === 1n && s.authorities[i].weight === 1), "the listed keys are not the runtime call's, each of weight 1");
    assert(s.setIdStorage.key === bytesToHex(storageKey("Grandpa", "CurrentSetId")), "the set id key is not Grandpa.CurrentSetId");
    assert(decodeU64(hexToBytes(s.setIdStorage.scale), "Grandpa.CurrentSetId") === setId && BigInt(b.provenance.setId) === setId, "the set id differs from the stored one or the provenance's");
    assert(s.count === keys.length && s.threshold === threshold(keys.length), "count or threshold field is wrong");
    return `set ${setId}, ${keys.length} keys, threshold ${threshold(keys.length)}`;
  });

  let j: Justification | undefined;
  check("the finality proof is for B and every precommit verifies under the signing set with the client's check", () => {
    const proof = decodeFinalityProof(hexToBytes(b.finalityProof.scale));
    assert(equalBytes(proof.block, B) && b.finalityProof.block === b.header.hash, "the proof's block is not B");
    assert(proof.unknownHeaders.length === 0 && b.finalityProof.unknownHeaders === 0, `${proof.unknownHeaders.length} unknown headers, which the client refuses`);
    assert(bytesToHex(proof.justification) === b.justification.scale, "the embedded justification differs from the recorded one");
    j = decodeJustification(proof.justification);
    assert(equalBytes(j.targetHash, B) && j.targetNumber === header.number, "the justification does not target B");
    assert(j.votesAncestries.length === 0, "votes_ancestries, which the client does not decode");
    const result = verifyJustification(j, keys, setId, clientVerifies);
    assert(result.ok, result.problems.join("; "));
    return `round ${j.round}, ${result.valid} of ${j.precommits.length} precommits valid under set ${setId}, ${result.required} required`;
  });
  check("the signers hint is relay.ts's: exactly the threshold, in increasing authority index", () => {
    assert(j, "no justification");
    const expected = signersHint(j, keys, setId);
    assert(bytesToHex(expected.hint) === b.signers.hint, `the hint should be ${bytesToHex(expected.hint)}`);
    assert(b.signers.count === expected.counted.length && b.signers.threshold === threshold(keys.length) && b.signers.count === b.signers.threshold, "count or threshold field is wrong");
    return expected.counted.map((p) => `precommit ${p.index} by key ${p.authorityIndex}`).join(", ");
  });
  check("a flipped signature byte, set id + 1 and round + 1 no longer verify", () => {
    assert(j, "no justification");
    const p0 = j.precommits[0];
    const flipped = verifyJustification({ ...j, precommits: [{ ...p0, signature: flipByte(p0.signature, 10) }, ...j.precommits.slice(1)] }, keys, setId, clientVerifies);
    assert(!flipped.ok && flipped.precommits[0].problem === "invalid signature", "a flipped signature byte still verifies");
    assert(verifyJustification(j, keys, setId + 1n, clientVerifies).valid === 0, "a signature verifies under set id + 1");
    assert(verifyJustification({ ...j, round: j.round + 1n }, keys, setId, clientVerifies).valid === 0, "a signature verifies under round + 1");
  });

  const vault = hexToBytes(b.vault.address);
  const stateRoot = header.stateRoot;
  const accountKey = hexToBytes(b.account.key.hex);
  const accountNodes = b.account.proof.nodes.map((n) => hexToBytes(n));
  const accountValue = hexToBytes(b.account.value.scale);
  check("Revive.AccountInfoOf(vault) walks from B's state root to a 130-byte Contract entry naming the trie id and code hash", () => {
    assert(vault.length === 20 && equalBytes(reviveAccountInfoKey(vault), accountKey), "the key is not twox128(Revive) ++ twox128(AccountInfoOf) ++ vault");
    walks(stateRoot, accountNodes, accountKey, accountValue, "account");
    assert(accountValue.length === 130 && accountValue[0] === 0 && accountValue[1] === 0x80, "not the 130-byte Contract entry with a 32-byte trie id that the minter takes");
    const info = decodeReviveAccountInfo(accountValue);
    assert(info.kind === "Contract", "not a contract");
    assert(bytesToHex(info.contract.trieId) === b.vault.trieId && bytesToHex(accountValue.subarray(2, 34)) === b.vault.trieId, "the trie id differs");
    assert(bytesToHex(info.contract.codeHash) === b.vault.codeHash && bytesToHex(accountValue.subarray(34, 66)) === b.vault.codeHash, "the code hash differs");
    return `${accountNodes.length} items, trie id ${shortHex(b.vault.trieId)}, code hash ${shortHex(b.vault.codeHash)}`;
  });
  const rootKey = hexToBytes(b.childRoot.key.hex);
  const rootNodes = b.childRoot.proof.nodes.map((n) => hexToBytes(n));
  const childRoot = hexToBytes(b.childRoot.root);
  check('the child root walks from B\'s state root under ":child_storage:default:" ++ trie id', () => {
    assert(equalBytes(childRootKey(hexToBytes(b.vault.trieId)), rootKey), "the key is not the prefix and the trie id");
    assert(childRoot.length === 32 && childRoot.some((x) => x !== 0), "the root is not 32 non-zero bytes");
    walks(stateRoot, rootNodes, rootKey, childRoot, "child-root");
    return `${rootNodes.length} items, root ${shortHex(childRoot)}`;
  });
  const index = hexToBytes(b.slot.index);
  const slotKey = hexToBytes(b.slot.key.hex);
  const slotNodes = b.slot.proof.nodes.map((n) => hexToBytes(n));
  const value = hexToBytes(b.slot.value.hex);
  const nonce = BigInt(b.lock.nonce);
  check("commitments[nonce] walks from the child root under blake2_256(keccak256(abi.encode(nonce, 0)))", () => {
    assert(equalBytes(commitmentSlot(nonce), index), `the slot index is not keccak256(abi.encode(${nonce}, 0))`);
    assert(equalBytes(reviveSlotKey(index), slotKey), "the key is not blake2_256(index)");
    assert(value.length === 32 && b.slot.value.bytes === 32, `${value.length} B, not a word`);
    walks(childRoot, slotNodes, slotKey, value, "slot");
    const served = b.slot.proof.served;
    assert(served.mainTrieItems === rootNodes.length && served.count === slotNodes.length + rootNodes.length, "the served item counts do not add up");
    return `${slotNodes.length} child-trie items, value ${shortHex(value)}`;
  });
  check("the word is the lock's commitment, recomputed from the lock", () => {
    const l = b.lock;
    const commitment = lockCommitment({
      v3ChainId: BigInt(b.vault.chainId),
      vault,
      dstChainId: BigInt(l.dstChainId),
      dstMinter: hexToBytes(l.dstMinter),
      recipient: hexToBytes(l.recipient),
      amountNative: BigInt(l.amountNative),
      nonce,
    });
    assert(bytesToHex(commitment) === l.commitment, `the lock's fields give ${bytesToHex(commitment)}, the file says ${l.commitment}`);
    assert(equalBytes(commitment, value), "the proven word is another commitment");
    assert(BigInt(l.amountNative) > 0n && hexToBytes(l.recipient).some((x) => x !== 0), "a zero amount or recipient, which the minter refuses");
    return `nonce ${nonce}: ${formatUnits(BigInt(l.amountNative), WTPOT_DECIMALS)} tPOT for ${l.recipient} on chain ${l.dstChainId}, minter ${l.dstMinter}`;
  });
  check("one-byte flips in every byte of every proof item, and a flipped root, are rejected", () => {
    const sets: [string, Uint8Array, Uint8Array[], Uint8Array, Uint8Array][] = [
      ["account", stateRoot, accountNodes, accountKey, accountValue],
      ["child-root", stateRoot, rootNodes, rootKey, childRoot],
      ["slot", childRoot, slotNodes, slotKey, value],
    ];
    let flips = 0;
    for (const [what, root, nodes, key, expected] of sets) {
      nodes.forEach((node, i) => {
        for (let at = 0; at < node.length; at++) {
          const tampered = nodes.map((n, k) => (k === i ? flipByte(n, at) : n));
          const v = proven(root, tampered, key);
          assert(v === null || !equalBytes(v, expected), `a flip of byte ${at} of ${what} item ${i} still proves the value`);
          flips += 1;
        }
      });
      assert(proven(flipByte(root, 0), nodes, key) === null, `the ${what} proof still reaches its value under a flipped root`);
    }
    return `${flips.toLocaleString("en-US")} single-byte flips and 3 flipped roots all fail`;
  });
  return lines;
}

// ---------------------------------------------------------------------------------------
// The demo's reverts: a tampered mint and a replayed one

/** The parts of a mint the demo changes, each refused with an error that names it. */
export const TAMPERS = ["signature", "header", "proof", "amount", "recipient"] as const;
export type Tamper = (typeof TAMPERS)[number];

/** A call that has to revert: its calldata, what makes it wrong, and the exact revert data it gets. */
export interface ExpectedRevert {
  data: Uint8Array;
  what: string;
  revert: Uint8Array;
}

/** The revert data of Error(string), what revert("...") returns (the vendored trie walk's "Incomplete Proof!"). */
export function errorString(message: string): Uint8Array {
  const text = new TextEncoder().encode(message);
  return concatBytes(selector("Error(string)"), uintWord(32n), uintWord(BigInt(text.length)), padRight(text));
}

/**
 * The bundle's importAndMint with one part changed, and the revert that names the part. It is the
 * same whether the lock is minted already or not: an imported B is verified again, and the proof
 * and the commitment are checked before the replay guard.
 *   signature: byte 0 of R in the first precommit the hint counts, in the finality proof: the light
 *     client's InvalidSignature(0, the signer's index);
 *   header: byte 0 of B's state root, in the header: the client's FinalityProofBlockMismatch(B, the
 *     changed header's hash);
 *   proof: the middle byte of the first item of the slot proof: the trie walk's "Incomplete Proof!";
 *   amount: a thousand times the lock's amount: the minter's CommitmentMismatch(the commitment of
 *     that amount, the proven word);
 *   recipient: the last byte of the recipient flipped: CommitmentMismatch, the same way.
 * `minter` and `chainId` are the minter's address and chain, which the commitments it computes name.
 */
export function tamperedCall(b: MintBundleFixture, tamper: Tamper, minter: Uint8Array, chainId: bigint): ExpectedRevert {
  const header = hexToBytes(b.header.scale);
  const finalityProof = hexToBytes(b.finalityProof.scale);
  const hint = hexToBytes(b.signers.hint);
  const p = bundleProof(b);
  const call = (h: Uint8Array, f: Uint8Array, q: LockProof) => importAndMintCalldata(h, f, hint, q);
  const mismatch = (q: LockProof) =>
    concatBytes(
      selector("CommitmentMismatch(bytes32,bytes32)"),
      lockCommitment({ v3ChainId: BigInt(b.vault.chainId), vault: hexToBytes(b.vault.address), dstChainId: chainId, dstMinter: minter, recipient: q.recipient, amountNative: q.amount, nonce: q.nonce }),
      hexToBytes(b.slot.value.hex),
    );
  switch (tamper) {
    case "signature": {
      // FinalityProof = block hash, the justification as Vec<u8>, unknown headers. A justification
      // = round (8 bytes), target hash (32), target number (4), then the precommits as a Vec, 132
      // bytes each: target hash, target number, R, s, the signer's key.
      const [position, index] = hint;
      const precommits = 32 + encodeCompact(b.finalityProof.justificationBytes).length + 44 + encodeCompact(b.justification.precommits.length).length;
      const at = precommits + 132 * position + 36;
      const signature = hexToBytes(b.justification.precommits[position]?.signature ?? "0x");
      if (signature.length !== 64 || finalityProof[at] !== signature[0]) throw new Error("the finality proof does not hold the justification's precommits where expected");
      return {
        data: call(header, flipByte(finalityProof, at), p),
        what: `byte 0 of R in precommit ${position}, signed by key ${index}, flipped in the finality proof`,
        revert: concatBytes(selector("InvalidSignature(uint256,uint256)"), uintWord(0n), uintWord(BigInt(index))),
      };
    }
    case "header": {
      // A header = parent hash (32 bytes), the number as a compact integer, the state root, ...
      const at = 32 + encodeCompact(b.header.number).length;
      if (bytesToHex(header.subarray(at, at + 32)) !== b.header.stateRoot) throw new Error("the header does not hold its state root where expected");
      const changed = flipByte(header, at);
      return {
        data: call(changed, finalityProof, p),
        what: "byte 0 of B's state root flipped in the header",
        revert: concatBytes(selector("FinalityProofBlockMismatch(bytes32,bytes32)"), hexToBytes(b.header.hash), blake2_256(changed)),
      };
    }
    case "proof": {
      const item = p.slotProof[0];
      const at = Math.floor(item.length / 2);
      return {
        data: call(header, finalityProof, { ...p, slotProof: [flipByte(item, at), ...p.slotProof.slice(1)] }),
        what: `byte ${at} of the slot proof's first item flipped`,
        revert: errorString("Incomplete Proof!"),
      };
    }
    case "amount": {
      const q = { ...p, amount: p.amount * 1000n };
      return { data: call(header, finalityProof, q), what: `the amount ${formatWtpot(p.amount)} made ${formatWtpot(q.amount)}`, revert: mismatch(q) };
    }
    case "recipient": {
      const q = { ...p, recipient: flipByte(p.recipient, 19) };
      return { data: call(header, finalityProof, q), what: `the recipient's last byte flipped (${bytesToHex(q.recipient)})`, revert: mismatch(q) };
    }
  }
}

/** The bundle's importAndMint as it is, once its lock is minted: the client verifies B again, then the minter answers NonceAlreadyUsed. */
export const replayCall = (b: MintBundleFixture): ExpectedRevert => ({
  data: bundleCalldata(b),
  what: "the same importAndMint again",
  revert: concatBytes(selector("NonceAlreadyUsed(uint256)"), uintWord(BigInt(b.lock.nonce))),
});

// ---------------------------------------------------------------------------------------
// The dry-run guard

/** JSON-RPC methods that sign, send or submit: what a dry run must never call. */
export const WRITE_METHOD = /^(eth_send|eth_sign|personal_|account_sign|author_submit|author_insert|author_rotate)/i;

export const isWriteMethod = (method: string): boolean => WRITE_METHOD.test(method);

/** A dry run tried to send: the method, and the RPC it was going to. */
export class DryRunViolation extends Error {
  override name = "DryRunViolation";

  constructor(method: string, where: string) {
    super(`dry run: ${method} to ${where} is refused (nothing is signed or sent without --send)`);
  }
}

/** The JSON-RPC methods a request body calls (one request or a batch); none when the body is not JSON-RPC. */
export function methodsOf(body: unknown): string[] {
  if (typeof body !== "string") return [];
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return [];
  }
  const requests = Array.isArray(json) ? json : [json];
  return requests.map((r) => (r && typeof r === "object" ? (r as { method?: unknown }).method : undefined)).filter((m): m is string => typeof m === "string");
}

/** `inner` refusing, before anything is sent, every request whose body calls a write method, and every body it cannot read. */
export function guardedFetch(inner: typeof fetch): typeof fetch {
  return (input, init) => {
    const where = typeof input === "string" ? URL.canParse(input) ? new URL(input).host : "the RPC" : input instanceof URL ? input.host : "the RPC";
    const body = init?.body;
    if (body !== undefined && body !== null && typeof body !== "string") return Promise.reject(new DryRunViolation("a request body that is not text", where));
    const bad = methodsOf(body).find(isWriteMethod);
    if (bad) return Promise.reject(new DryRunViolation(bad, where));
    return inner(input, init);
  };
}

/** RpcClient.request refusing a write method before anything is written to the socket. */
export function guardedRequest(inner: RpcClient["request"]): RpcClient["request"] {
  return function (this: RpcClient, method: string, ...rest: unknown[]) {
    if (isWriteMethod(method)) return Promise.reject(new DryRunViolation(method, URL.canParse(this.url) ? new URL(this.url).host : "the node"));
    return (inner as (this: RpcClient, method: string, ...rest: unknown[]) => Promise<unknown>).call(this, method, ...rest);
  } as RpcClient["request"];
}

/**
 * Keeps this process from sending anything: global fetch (the Sepolia and EVM RPCs) and the
 * WebSocket client (the V3 node) refuse the write methods above. mint.ts and release.ts install
 * it before their first request, for every command: a --send sends on Sepolia through cast
 * publish, a process of its own.
 */
export function installDryRunGuard(): void {
  globalThis.fetch = guardedFetch(globalThis.fetch);
  RpcClient.prototype.request = guardedRequest(RpcClient.prototype.request);
}

/** The two ways a request reaches the socket of a polkadot-js provider (WsProvider). */
export interface JsonRpcProvider {
  send(method: string, params: unknown[], ...rest: never[]): Promise<unknown>;
  subscribe(type: string, method: string, params: unknown[], ...rest: never[]): Promise<unknown>;
}

/**
 * `provider` refusing every write method (author_submitExtrinsic, author_submitAndWatchExtrinsic,
 * ...) before it reaches the socket: what release.ts gives @polkadot/api unless a command signs
 * with --send. polkadot-js submits an extrinsic through one of these two methods.
 */
export function guardProvider<P extends JsonRpcProvider>(provider: P, where: string): P {
  const send = provider.send.bind(provider) as (method: string, params: unknown[], ...rest: unknown[]) => Promise<unknown>;
  const subscribe = provider.subscribe.bind(provider) as (type: string, method: string, params: unknown[], ...rest: unknown[]) => Promise<unknown>;
  const guarded: JsonRpcProvider = {
    send: (method, params, ...rest) => (isWriteMethod(method) ? Promise.reject(new DryRunViolation(method, where)) : send(method, params, ...rest)),
    subscribe: (type, method, params, ...rest) => (isWriteMethod(method) ? Promise.reject(new DryRunViolation(method, where)) : subscribe(type, method, params, ...rest)),
  };
  provider.send = guarded.send as P["send"];
  provider.subscribe = guarded.subscribe as P["subscribe"];
  return provider;
}

// ---------------------------------------------------------------------------------------
// Logs in windows

/** The most blocks one eth_getLogs request spans: public RPCs cap the range (the Sepolia RPC at 50,000). */
export const LOG_WINDOW = 10_000;

/**
 * Blocks `from` to `to` (both included) as windows of at most `size` blocks, in order: the ranges
 * a log search asks one at a time.
 */
export function logWindows(from: number, to: number, size = LOG_WINDOW): [number, number][] {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || !Number.isSafeInteger(size) || size < 1) throw new RangeError(`not a block range: ${from} to ${to} by ${size}`);
  const out: [number, number][] = [];
  for (let start = from; start <= to; start += size) out.push([start, Math.min(to, start + size - 1)]);
  return out;
}
