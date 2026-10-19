// PortaldotVault (contracts/src/bridge/PortaldotVault.sol) computed off chain the way the contract
// computes it: the lock commitment and the burn id, the calldata and events, the storage slots a
// minter proves, the addresses pallet-revive and pallet-multisig derive, and the V3 build's code
// with its immutables. No network access: v3-vault.ts and vault.test.ts use it.

import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, equalBytes, hexToBytes, utf8, type Hex } from "./bytes.js";
import { blake2_256 } from "./hash.js";
import { encodeCompact } from "./scale.js";

// ---------------------------------------------------------------------------------------
// Units

/** Native tPOT has 14 decimals: one tPOT is 10^14 native base units. */
export const TPOT_DECIMALS = 14;
export const TPOT = 10n ** BigInt(TPOT_DECIMALS);

/**
 * An amount of tPOT ("1.5", at most 14 decimals) in native base units. Refuses more decimals (they
 * would be dust the vault rejects), signs, exponents, separators and zero (AmountTooSmall).
 */
export function parseTpot(text: string): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) throw new Error(`not an amount of tPOT: ${JSON.stringify(text)}`);
  const fraction = m[2] ?? "";
  if (fraction.length > TPOT_DECIMALS) {
    throw new Error(`${text} tPOT has more than ${TPOT_DECIMALS} decimals: below one native base unit, the vault would reject it as dust`);
  }
  const value = BigInt(m[1]) * TPOT + BigInt(fraction.padEnd(TPOT_DECIMALS, "0"));
  if (value === 0n) throw new Error("the amount is zero");
  return value;
}

/** `value` with `decimals` decimals, without trailing zeros: formatUnits(150n, 2) is "1.5". */
export function formatUnits(value: bigint, decimals: number): string {
  const sign = value < 0n ? "-" : "";
  const digits = (value < 0n ? -value : value).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${sign}${BigInt(whole).toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
}

/** Native base units as tPOT. */
export const formatTpot = (native: bigint): string => `${formatUnits(native, TPOT_DECIMALS)} tPOT`;

/**
 * The decimals of EVM values (msg.value, eth_getBalance): 14 plus the digits of
 * NativeToEthRatio, which has to be a power of ten (10^4 on V3: 18 decimals).
 */
export function evmDecimals(ratio: bigint): number {
  const digits = ratio.toString();
  if (!/^10*$/.test(digits)) throw new Error(`NativeToEthRatio ${ratio} is not a power of ten`);
  return TPOT_DECIMALS + digits.length - 1;
}

/** An EVM value as tPOT. */
export const formatEvmTpot = (value: bigint, ratio: bigint): string => `${formatUnits(value, evmDecimals(ratio))} tPOT`;

// ---------------------------------------------------------------------------------------
// ABI words, addresses and selectors

const MAX_UINT256 = (1n << 256n) - 1n;

export function uintWord(value: bigint): Uint8Array {
  if (value < 0n || value > MAX_UINT256) throw new RangeError(`not a uint256: ${value}`);
  return hexToBytes(value.toString(16).padStart(64, "0"));
}

/** A 20-byte address, left-padded to a word as abi.encode writes it. */
export function addressWord(address: Uint8Array): Uint8Array {
  if (address.length !== 20) throw new Error(`an address is 20 bytes, got ${address.length}`);
  return concatBytes(new Uint8Array(12), address);
}

/** The EIP-55 mixed-case form of an address. */
export function checksumAddress(address: Uint8Array): Hex {
  const lower = bytesToHex(address).slice(2);
  const hash = bytesToHex(keccak_256(utf8(lower))).slice(2);
  let out = "0x";
  for (let i = 0; i < lower.length; i++) out += Number.parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return out as Hex;
}

/**
 * "0x" and 40 hex digits as 20 bytes. A mixed-case address must carry a valid EIP-55 checksum,
 * which catches a mistyped digit; an all-lower-case or all-upper-case one is taken as it is.
 */
export function parseAddress(text: string, what = "address"): Uint8Array {
  if (!/^0x[0-9a-fA-F]{40}$/.test(text)) throw new Error(`${what} must be 0x and 40 hex digits, got ${JSON.stringify(text)}`);
  const bytes = hexToBytes(text);
  const digits = text.slice(2);
  const mixed = digits !== digits.toLowerCase() && digits !== digits.toUpperCase();
  if (mixed && checksumAddress(bytes) !== text) throw new Error(`${what} ${text} fails its EIP-55 checksum (did you mean ${checksumAddress(bytes)}?)`);
  return bytes;
}

/** The low 20 bytes of an address word; refuses a word whose upper 12 bytes are not zero. */
export function wordToAddress(word: Uint8Array, what = "address word"): Uint8Array {
  if (word.length !== 32 || word.subarray(0, 12).some((b) => b !== 0)) throw new Error(`${what} is not an address: ${bytesToHex(word)}`);
  return word.slice(12);
}

export const selector = (signature: string): Uint8Array => keccak_256(utf8(signature)).slice(0, 4);
export const topic = (signature: string): Hex => bytesToHex(keccak_256(utf8(signature)));

/** The vault's external functions. nextNonce, NATIVE_TO_ETH_RATIO and RELEASER have no getter. */
export const SIGNATURES = {
  lock: "lock(uint256,address,address)",
  release: "release(bytes32,address,uint256)",
  commitments: "commitments(uint256)",
  outstanding: "outstanding()",
  released: "released(bytes32)",
} as const;

export const LOCKED_TOPIC = topic("Locked(uint256,address,address,uint256,address,uint256,bytes32)");
export const RELEASED_TOPIC = topic("Released(bytes32,address,uint256)");

/** The vault's errors by selector, to name a revert. */
export const VAULT_ERRORS = new Map(
  ["ZeroArgument()", "DustNotAllowed()", "AmountTooSmall()", "NotReleaser()", "AlreadyReleased()", "ExceedsOutstanding()", "TransferFailed()"].map(
    (signature) => [bytesToHex(selector(signature)), signature] as const,
  ),
);

/** The vault error a revert's data names, or null. */
export function vaultError(revertData: Uint8Array): string | null {
  return revertData.length === 4 ? (VAULT_ERRORS.get(bytesToHex(revertData)) ?? null) : null;
}

export const lockCalldata = (dstChainId: bigint, dstMinter: Uint8Array, recipient: Uint8Array): Uint8Array =>
  concatBytes(selector(SIGNATURES.lock), uintWord(dstChainId), addressWord(dstMinter), addressWord(recipient));

export const commitmentsCalldata = (nonce: bigint): Uint8Array => concatBytes(selector(SIGNATURES.commitments), uintWord(nonce));

export const outstandingCalldata = (): Uint8Array => selector(SIGNATURES.outstanding);

export const releaseCalldata = (burnId: Uint8Array, to: Uint8Array, amountNative: bigint): Uint8Array =>
  concatBytes(selector(SIGNATURES.release), burnId, addressWord(to), uintWord(amountNative));

/** The constructor arguments, as appended to the creation code: abi.encode(nativeToEthRatio, releaser). */
export const constructorArgs = (ratio: bigint, releaser: Uint8Array): Uint8Array => concatBytes(uintWord(ratio), addressWord(releaser));

// ---------------------------------------------------------------------------------------
// Commitments, burn ids and storage slots

/** keccak256("BridgeZero.Lock.v1"): the domain tag of a lock commitment. */
export const LOCK_TAG = keccak_256(utf8("BridgeZero.Lock.v1"));
/** keccak256("BridgeZero.Burn.v1"): the domain tag of a burn id. */
export const BURN_TAG = keccak_256(utf8("BridgeZero.Burn.v1"));

/** The vault's storage layout, part of the protocol. */
export const SLOTS = { commitments: 0n, nextNonce: 1n, outstanding: 2n, released: 3n } as const;

export interface Lock {
  /** block.chainid on V3, where the vault runs. */
  v3ChainId: bigint;
  vault: Uint8Array;
  dstChainId: bigint;
  dstMinter: Uint8Array;
  recipient: Uint8Array;
  amountNative: bigint;
  nonce: bigint;
}

/**
 * The word the vault stores at commitments[nonce]:
 * keccak256(abi.encode(LOCK_TAG, v3ChainId, vault, dstChainId, dstMinter, recipient, amountNative, nonce)).
 * A minter recomputes it with its own chain id and address as dstChainId and dstMinter.
 */
export function lockCommitment(l: Lock): Uint8Array {
  return keccak_256(
    concatBytes(
      LOCK_TAG,
      uintWord(l.v3ChainId),
      addressWord(l.vault),
      uintWord(l.dstChainId),
      addressWord(l.dstMinter),
      addressWord(l.recipient),
      uintWord(l.amountNative),
      uintWord(l.nonce),
    ),
  );
}

/**
 * The id a burn is released under, which the committee derives before it approves:
 * keccak256(abi.encode(BURN_TAG, srcChainId, srcMinter, burnNonce)). The vault releases each id once
 * and does not check how it was derived.
 */
export function burnId(srcChainId: bigint, srcMinter: Uint8Array, burnNonce: bigint): Uint8Array {
  return keccak_256(concatBytes(BURN_TAG, uintWord(srcChainId), addressWord(srcMinter), uintWord(burnNonce)));
}

/** The EVM slot of commitments[nonce]: keccak256(abi.encode(nonce, 0)). The minter proves this one. */
export const commitmentSlot = (nonce: bigint): Uint8Array => keccak_256(concatBytes(uintWord(nonce), uintWord(SLOTS.commitments)));

/** The EVM slot of released[burnId]: keccak256(abi.encode(burnId, 3)). */
export function releasedSlot(id: Uint8Array): Uint8Array {
  if (id.length !== 32) throw new Error(`a burn id is 32 bytes, got ${id.length}`);
  return keccak_256(concatBytes(id, uintWord(SLOTS.released)));
}

// ---------------------------------------------------------------------------------------
// Events

export interface LogJson {
  address: string;
  topics: string[];
  data: string;
  blockNumber?: string;
  blockHash?: string;
  transactionHash?: string;
  logIndex?: string;
}

export interface LockedEvent {
  nonce: bigint;
  sender: Uint8Array;
  recipient: Uint8Array;
  dstChainId: bigint;
  dstMinter: Uint8Array;
  amountNative: bigint;
  commitment: Uint8Array;
}

export interface ReleasedEvent {
  burnId: Uint8Array;
  to: Uint8Array;
  amountNative: bigint;
}

const wordsOf = (data: Uint8Array, count: number, what: string): Uint8Array[] => {
  if (data.length !== 32 * count) throw new Error(`${what}: ${data.length} bytes of data, expected ${32 * count}`);
  return Array.from({ length: count }, (_, i) => data.slice(32 * i, 32 * i + 32));
};
const uintOf = (word: Uint8Array): bigint => BigInt(bytesToHex(word));

/** Locked(uint256 indexed nonce, address indexed sender, address indexed recipient, uint256 dstChainId, address dstMinter, uint256 amountNative, bytes32 commitment). */
export function decodeLocked(log: LogJson): LockedEvent {
  if (log.topics.length !== 4 || log.topics[0].toLowerCase() !== LOCKED_TOPIC) throw new Error("not a Locked log");
  const [dstChainId, dstMinter, amountNative, commitment] = wordsOf(hexToBytes(log.data), 4, "Locked");
  return {
    nonce: BigInt(log.topics[1]),
    sender: wordToAddress(hexToBytes(log.topics[2]), "Locked.sender"),
    recipient: wordToAddress(hexToBytes(log.topics[3]), "Locked.recipient"),
    dstChainId: uintOf(dstChainId),
    dstMinter: wordToAddress(dstMinter, "Locked.dstMinter"),
    amountNative: uintOf(amountNative),
    commitment,
  };
}

/** Released(bytes32 indexed burnId, address indexed to, uint256 amountNative). */
export function decodeReleased(log: LogJson): ReleasedEvent {
  if (log.topics.length !== 3 || log.topics[0].toLowerCase() !== RELEASED_TOPIC) throw new Error("not a Released log");
  const [amountNative] = wordsOf(hexToBytes(log.data), 1, "Released");
  return { burnId: hexToBytes(log.topics[1]), to: wordToAddress(hexToBytes(log.topics[2]), "Released.to"), amountNative: uintOf(amountNative) };
}

// ---------------------------------------------------------------------------------------
// Addresses on V3

/** The minimal big-endian bytes of a non-negative integer, as RLP takes it (zero is empty). */
function minimalBigEndian(value: bigint): Uint8Array {
  if (value === 0n) return new Uint8Array(0);
  const digits = value.toString(16);
  return hexToBytes(digits.length % 2 ? `0${digits}` : digits);
}

/**
 * The CREATE address of `sender` at `nonce`: the last 20 bytes of keccak256(rlp([sender, nonce])).
 * pallet-revive gives a contract instantiated without a salt this address, with the deployer's
 * account nonce.
 */
export function createAddress(sender: Uint8Array, nonce: bigint): Uint8Array {
  if (sender.length !== 20) throw new Error(`a sender is 20 bytes, got ${sender.length}`);
  const n = minimalBigEndian(nonce);
  if (n.length > 8) throw new RangeError(`nonce ${nonce} does not fit 64 bits`);
  const nonceItem = n.length === 1 && n[0] < 0x80 ? n : concatBytes(Uint8Array.of(0x80 + n.length), n);
  const body = concatBytes(Uint8Array.of(0x80 + 20), sender, nonceItem);
  return keccak_256(concatBytes(Uint8Array.of(0xc0 + body.length), body)).slice(12);
}

const ETH_DERIVED_SUFFIX = new Uint8Array(12).fill(0xee);

/**
 * The address pallet-revive gives an AccountId32 (AccountId32Mapper): an account that stands for an
 * Ethereum address (its last 12 bytes are 0xEE) keeps that address, any other one takes the last
 * 20 bytes of keccak256(account id).
 */
export function reviveAddress(accountId: Uint8Array): Uint8Array {
  if (accountId.length !== 32) throw new Error(`an account id is 32 bytes, got ${accountId.length}`);
  return equalBytes(accountId.subarray(20), ETH_DERIVED_SUFFIX) ? accountId.slice(0, 20) : keccak_256(accountId).slice(12);
}

/** The AccountId32 of an Ethereum address with no original Substrate account: the address, then twelve 0xEE bytes. */
export const ethAccountId = (address: Uint8Array): Uint8Array => concatBytes(address, ETH_DERIVED_SUFFIX);

/**
 * pallet-multisig's account of `members` (in any order; the pallet sorts them) and `threshold`:
 * blake2_256("modlpy/utilisuba" ++ SCALE(sorted members) ++ u16le(threshold)).
 */
export function multisigAccountId(members: Uint8Array[], threshold: number): Uint8Array {
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > members.length || threshold > 0xffff) {
    throw new Error(`threshold ${threshold} for ${members.length} members`);
  }
  if (members.some((m) => m.length !== 32)) throw new Error("a member is not a 32-byte account id");
  const sorted = members.map((m) => bytesToHex(m)).sort();
  if (new Set(sorted).size !== sorted.length) throw new Error("a member is listed twice");
  return blake2_256(
    concatBytes(utf8("modlpy/utilisuba"), encodeCompact(sorted.length), ...sorted.map((m) => hexToBytes(m)), Uint8Array.of(threshold & 0xff, threshold >> 8)),
  );
}

// ---------------------------------------------------------------------------------------
// The V3 build (contracts/out-v3/PortaldotVault.sol/PortaldotVault.json)

export type ImmutableName = "NATIVE_TO_ETH_RATIO" | "RELEASER";

export interface VaultBuild {
  initcode: Uint8Array;
  /** The runtime code with zero words where the immutables go. */
  runtime: Uint8Array;
  /** Byte offsets of each immutable's 32-byte words in the runtime code. */
  immutables: Record<ImmutableName, number[]>;
  compiler: string;
  evmVersion: string;
  viaIR: boolean;
  optimizer: { enabled: boolean; runs: number };
  appendCBOR: boolean;
  /** keccak256 of the source the build was compiled from, as its metadata records it. */
  sourcePath: string;
  sourceKeccak: Hex;
}

interface ArtifactJson {
  bytecode?: { object?: string };
  deployedBytecode?: { object?: string; immutableReferences?: Record<string, { start: number; length: number }[]> };
  metadata?: {
    compiler?: { version?: string };
    settings?: { evmVersion?: string; viaIR?: boolean; optimizer?: { enabled?: boolean; runs?: number }; metadata?: { appendCBOR?: boolean }; compilationTarget?: Record<string, string> };
    sources?: Record<string, { keccak256?: string }>;
  };
  ast?: unknown;
}

/** The AST ids of the immutable state variables, by name. */
function immutableIds(ast: unknown): Map<number, string> {
  const ids = new Map<number, string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === "object") {
      const n = node as { nodeType?: unknown; mutability?: unknown; stateVariable?: unknown; id?: unknown; name?: unknown };
      if (n.nodeType === "VariableDeclaration" && n.mutability === "immutable" && n.stateVariable === true && typeof n.id === "number" && typeof n.name === "string") {
        ids.set(n.id, n.name);
      }
      Object.values(node).forEach(walk);
    }
  };
  walk(ast);
  return ids;
}

/**
 * Reads the forge artifact of the vault's V3 build. Refuses one without code, without the AST
 * that names its immutables (profile v3 keeps it), or whose immutables are not exactly
 * NATIVE_TO_ETH_RATIO and RELEASER, one 32-byte word per reference.
 */
export function readVaultBuild(json: unknown): VaultBuild {
  const a = json as ArtifactJson;
  const initcode = a.bytecode?.object;
  const runtime = a.deployedBytecode?.object;
  if (!initcode || !runtime || initcode === "0x" || runtime === "0x") throw new Error("the artifact has no bytecode");
  const settings = a.metadata?.settings;
  const target = Object.entries(settings?.compilationTarget ?? {});
  if (target.length !== 1 || target[0][1] !== "PortaldotVault") throw new Error("the artifact is not PortaldotVault's");
  const sourcePath = target[0][0];
  const sourceKeccak = a.metadata?.sources?.[sourcePath]?.keccak256;
  if (!sourceKeccak) throw new Error(`the artifact's metadata has no hash of ${sourcePath}`);
  if (a.ast === undefined) throw new Error("the artifact has no AST to name its immutables: build it with FOUNDRY_PROFILE=v3");
  const names = immutableIds(a.ast);
  const immutables: Partial<Record<ImmutableName, number[]>> = {};
  for (const [id, refs] of Object.entries(a.deployedBytecode?.immutableReferences ?? {})) {
    const name = names.get(Number(id));
    if (name !== "NATIVE_TO_ETH_RATIO" && name !== "RELEASER") throw new Error(`unexpected immutable ${name ?? `#${id}`}`);
    if (refs.some((r) => r.length !== 32)) throw new Error(`${name} has a reference that is not one word`);
    immutables[name] = refs.map((r) => r.start);
  }
  if (!immutables.NATIVE_TO_ETH_RATIO?.length || !immutables.RELEASER?.length) throw new Error("the artifact does not reference both immutables");
  return {
    initcode: hexToBytes(initcode),
    runtime: hexToBytes(runtime),
    immutables: immutables as Record<ImmutableName, number[]>,
    compiler: a.metadata?.compiler?.version ?? "unknown",
    evmVersion: settings?.evmVersion ?? "unknown",
    viaIR: settings?.viaIR === true,
    optimizer: { enabled: settings?.optimizer?.enabled === true, runs: settings?.optimizer?.runs ?? 0 },
    appendCBOR: settings?.metadata?.appendCBOR !== false,
    sourcePath,
    sourceKeccak: sourceKeccak.toLowerCase() as Hex,
  };
}

/** The runtime code a vault deployed with `ratio` and `releaser` has: the build's, with both immutables filled in. */
export function fillImmutables(build: VaultBuild, ratio: bigint, releaser: Uint8Array): Uint8Array {
  const code = build.runtime.slice();
  const words: Record<ImmutableName, Uint8Array> = { NATIVE_TO_ETH_RATIO: uintWord(ratio), RELEASER: addressWord(releaser) };
  for (const name of ["NATIVE_TO_ETH_RATIO", "RELEASER"] as const) {
    for (const start of build.immutables[name]) code.set(words[name], start);
  }
  return code;
}

/**
 * The immutables of deployed vault code, or null unless the code is the build's runtime code with
 * some ratio and releaser filled in (every reference of an immutable holding the same word, the
 * releaser's upper 12 bytes zero, and the ratio non-zero).
 */
export function readImmutables(build: VaultBuild, code: Uint8Array): { ratio: bigint; releaser: Uint8Array } | null {
  if (code.length !== build.runtime.length) return null;
  const word = (start: number) => code.slice(start, start + 32);
  const [ratioWord, releaserWord] = [build.immutables.NATIVE_TO_ETH_RATIO[0], build.immutables.RELEASER[0]].map(word);
  if (releaserWord.subarray(0, 12).some((b) => b !== 0)) return null;
  const ratio = BigInt(bytesToHex(ratioWord));
  if (ratio === 0n) return null;
  const releaser = releaserWord.slice(12);
  return equalBytes(fillImmutables(build, ratio, releaser), code) ? { ratio, releaser } : null;
}
