// The proof kit's reads of Portaldot V3 state, off chain and with no network access: the storage
// keys of the items PortaldotState (contracts/src/kit) reads, the decoders of their values as the
// V3 runtime stores them (portaldot-v3 3002), the contracts' checks in the contracts' order and
// with the contracts' error names, the ABI of PortaldotStateReader and of the example
// ProvenAssetGate, and the offline checks of a state-reads fixture (fixtures/v3-testnet-kit).
// state-fetch.ts reads the proofs from a V3 node, kit.ts (npm run kit) uses both, and
// state.test.ts checks them against the fixture.
//
// What a read proves: a non-empty value under the state root of a block the light client imported
// (GrandpaLightClient.stateRootOf). The walk here is the contracts' (the vendored PolkadotTrie
// through SubstrateProofs.verifyMain), which differs from trie.ts readProof in two ways: a key that
// ends on a branch without a value is present with an empty value (EmptyValue), not absent; and
// proof items the walk does not need are accepted. A capture still refuses them (chain.ts
// provenRead), and the checks below require every item to be used.

import { keccak_256 } from "@noble/hashes/sha3.js";
import { abiEncode, addressAt, signersHint, uintAt, type AbiParam, type LockProof } from "./bridge.js";
import { bytesToHex, concatBytes, equalBytes, flipByte, hexToBytes, leToBigInt, shortHex, u32le, type Hex } from "./bytes.js";
import type { BlockRef, HeaderJson, JustificationJson, ProofJson, Provenance, StateAuthoritySetJson } from "./fixture.js";
import { clientVerifies, threshold, verifyJustification } from "./grandpa.js";
import { blake2_128Concat, blake2_256, childRootKey, storageKey, systemAccountKey } from "./hash.js";
import { decodeReviveAccountInfo, reviveAccountInfoKey, reviveSlotKey } from "./revive.js";
import { decodeAuthorityList, decodeFinalityProof, decodeHeader, decodeJustification, decodeU64, grandpaLogs, Reader } from "./scale.js";
import { decodeNode, readProof } from "./trie.js";
import { addressWord, commitmentSlot, ethAccountId, lockCommitment, selector, topic, uintWord } from "./vault.js";

export { systemAccountKey, childRootKey } from "./hash.js";
export { reviveAccountInfoKey, reviveSlotKey } from "./revive.js";
export { ethAccountId, commitmentSlot } from "./vault.js";

// ---------------------------------------------------------------------------------------
// Keys

/** twox128("System") ++ twox128("Account"). */
export const SYSTEM_ACCOUNT_PREFIX = storageKey("System", "Account");
/** twox128("Assets") ++ twox128("Account"). */
export const ASSETS_ACCOUNT_PREFIX = storageKey("Assets", "Account");
/** twox128("Nfts") ++ twox128("Item"). */
export const NFTS_ITEM_PREFIX = storageKey("Nfts", "Item");

function accountId32(accountId: Uint8Array): Uint8Array {
  if (accountId.length !== 32) throw new Error(`an account id is 32 bytes, got ${accountId.length}`);
  return accountId;
}

/** Assets.Account(assetId, accountId): prefix ++ blake2_128Concat(u32le(assetId)) ++ blake2_128Concat(accountId), 100 bytes. */
export function assetsAccountKey(assetId: number, accountId: Uint8Array): Uint8Array {
  return concatBytes(ASSETS_ACCOUNT_PREFIX, blake2_128Concat(u32le(assetId)), blake2_128Concat(accountId32(accountId)));
}

/** The prefix of asset `assetId`'s holders in Assets.Account: prefix ++ blake2_128Concat(u32le(assetId)), 52 bytes. */
export function assetsAccountPrefix(assetId: number): Uint8Array {
  return concatBytes(ASSETS_ACCOUNT_PREFIX, blake2_128Concat(u32le(assetId)));
}

/** Nfts.Item(collection, item): prefix ++ blake2_128Concat(u32le(collection)) ++ blake2_128Concat(u32le(item)), 72 bytes. */
export function nftsItemKey(collection: number, item: number): Uint8Array {
  return concatBytes(NFTS_ITEM_PREFIX, blake2_128Concat(u32le(collection)), blake2_128Concat(u32le(item)));
}

/**
 * The EVM slot of entry `key` of a Solidity mapping at slot `slot`: keccak256(abi.encode(key, slot)).
 * A bigint key is a uint256; a 32-byte key is used as it is (an address key is its 32-byte word).
 */
export function mappingSlot(key: bigint | Uint8Array, slot: bigint): Uint8Array {
  const word = typeof key === "bigint" ? uintWord(key) : key;
  if (word.length !== 32) throw new Error(`a mapping key is a 32-byte word, got ${word.length} bytes`);
  return keccak_256(concatBytes(word, uintWord(slot)));
}

/** A V3 account id from text: a 20-byte Ethereum address (its account is the address ++ 0xEE x 12) or a 32-byte account id. */
export function accountIdOf(text: string): Uint8Array {
  const bytes = hexToBytes(text);
  if (bytes.length === 20) return ethAccountId(bytes);
  if (bytes.length === 32) return bytes;
  throw new Error(`${text} is neither a 20-byte address nor a 32-byte account id`);
}

// ---------------------------------------------------------------------------------------
// The contracts' errors

/** The vendored trie walk's revert reasons (Error(string)). */
export const INCOMPLETE_PROOF = "Incomplete Proof!";
export const BAD_FORMAT = "Bad Format!";

/**
 * A read the contracts refuse. `reason` is the name of the error they revert with (SubstrateProofs'
 * "KeyNotPresent", "EmptyValue", ..., PortaldotState's "NotAContract", ..., or the walk's Error
 * string, such as "Incomplete Proof!"); `args` are the error's arguments as revertName prints them.
 */
export class StateProofError extends Error {
  override name = "StateProofError";

  constructor(
    readonly reason: string,
    readonly args: string[] = [],
  ) {
    super(args.length ? `${reason}(${args.join(", ")})` : reason);
  }
}

// ---------------------------------------------------------------------------------------
// The walk

/** The bytes of a node handle or a value: inline, or the proof item with this blake2_256 hash. */
type Handle = { inline: Uint8Array } | { hashed: Uint8Array } | { hash: Uint8Array };

/**
 * PolkadotTrie.VerifyProof for one key: whether the key is in the trie under `root` and its value.
 * A missing node or hashed value is "Incomplete Proof!", a node that does not decode "Bad Format!"
 * (the contract's decoder names some such nodes "Unallowed encoding"; neither can occur in a proof
 * under a root a chain produced, as every node is found by its hash).
 */
function walk(root: Uint8Array, proof: Uint8Array[], key: Uint8Array): { present: boolean; value: Uint8Array } {
  const items = new Map<string, Uint8Array>();
  for (const item of proof) items.set(bytesToHex(blake2_256(item)), item);
  const load = (h: Handle): Uint8Array => {
    if ("inline" in h) return h.inline;
    const hash = "hashed" in h ? h.hashed : h.hash;
    const item = items.get(bytesToHex(hash));
    if (item === undefined) throw new StateProofError(INCOMPLETE_PROOF);
    return item;
  };
  const decode = (data: Uint8Array) => {
    try {
      return decodeNode(data);
    } catch {
      throw new StateProofError(BAD_FORMAT);
    }
  };
  const nibbles: number[] = [];
  for (const b of key) nibbles.push(b >> 4, b & 0x0f);
  const absent = { present: false, value: new Uint8Array(0) };
  const matches = (partial: number[], at: number) => partial.every((n, i) => n === nibbles[at + i]);

  let node = decode(load({ hash: root }));
  let pos = 0;
  for (;;) {
    if (node.type === "empty") return absent;
    const left = nibbles.length - pos;
    if (node.type === "leaf") {
      return node.partial.length === left && matches(node.partial, pos) ? { present: true, value: load(node.value) } : absent;
    }
    if (node.partial.length > left || !matches(node.partial, pos)) return absent;
    pos += node.partial.length;
    if (pos === nibbles.length) return { present: true, value: node.value ? load(node.value) : new Uint8Array(0) };
    const child = node.children[nibbles[pos]];
    if (!child) return absent;
    pos += 1;
    node = decode(load(child));
  }
}

/**
 * SubstrateProofs.verifyMain: the non-empty value of `key` under `root`. Throws StateProofError
 * with the contract's reason: EmptyProof, EmptyKey, the walk's, KeyNotPresent (the proof shows
 * the key absent) or EmptyValue (the key ends on a branch without a value).
 */
export function readMain(root: Uint8Array, proof: Uint8Array[], key: Uint8Array): Uint8Array {
  if (proof.length === 0) throw new StateProofError("EmptyProof");
  if (key.length === 0) throw new StateProofError("EmptyKey");
  const read = walk(root, proof, key);
  const args = [shortHex(root), `${shortHex(key)} (${key.length} B)`];
  if (!read.present) throw new StateProofError("KeyNotPresent", args);
  if (read.value.length === 0) throw new StateProofError("EmptyValue", args);
  return read.value;
}

/**
 * A child-trie read as BridgeMinter and PortaldotState do it: the root of default child trie
 * `trieId` under ":child_storage:default:" ++ trieId in the main trie (exactly 32 bytes, not zero),
 * then `key` under that root.
 */
export function readChild(root: Uint8Array, childRootProof: Uint8Array[], childProof: Uint8Array[], trieId: Uint8Array, key: Uint8Array): { value: Uint8Array; childRoot: Uint8Array } {
  const childRoot = readMain(root, childRootProof, childRootKey(trieId));
  if (childRoot.length !== 32) throw new StateProofError("ChildRootLength", [String(childRoot.length)]);
  if (childRoot.every((b) => b === 0)) throw new StateProofError("ZeroChildRoot");
  return { value: readMain(childRoot, childProof, key), childRoot };
}

// ---------------------------------------------------------------------------------------
// Values (V3, portaldot-v3 3002)

/** frame_system AccountInfo with pallet_balances AccountData, as V3 stores it: 80 bytes, little-endian. */
export interface SystemAccount {
  nonce: number;
  consumers: number;
  providers: number;
  sufficients: number;
  free: bigint;
  reserved: bigint;
  frozen: bigint;
  flags: bigint;
}

/** A System.Account value: exactly 80 bytes, else AccountInfoLength. */
export function decodeSystemAccount(value: Uint8Array): SystemAccount {
  if (value.length !== 80) throw new StateProofError("AccountInfoLength", [String(value.length)]);
  const r = new Reader(value);
  return { nonce: r.u32(), consumers: r.u32(), providers: r.u32(), sufficients: r.u32(), free: r.u128(), reserved: r.u128(), frozen: r.u128(), flags: r.u128() };
}

/** pallet-assets AccountStatus and ExistenceReason, by variant index. */
export const ASSET_STATUSES = ["Liquid", "Frozen", "Blocked"] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];
export const ASSET_REASONS = ["Consumer", "Sufficient", "DepositHeld", "DepositRefunded", "DepositFrom"] as const;
export type AssetReason = (typeof ASSET_REASONS)[number];
/** The length of an AssetAccount value with each reason: DepositHeld carries a u128, DepositFrom an account and a u128. */
const ASSET_ACCOUNT_LENGTH = [18, 18, 34, 18, 66];

/** pallet-assets AssetAccount { balance, status, reason, extra: () }. */
export interface AssetAccount {
  balance: bigint;
  status: AssetStatus;
  reason: AssetReason;
  /** DepositHeld's and DepositFrom's deposit. */
  deposit?: bigint;
  /** DepositFrom's depositor. */
  depositor?: Uint8Array;
}

/**
 * An Assets.Account value: balance (u128), status (u8, at most 2), reason (u8 and its data). The
 * length must be the reason's: 18 bytes for Consumer, Sufficient and DepositRefunded, 34 for
 * DepositHeld, 66 for DepositFrom; else AssetAccountMalformed(length, status, reason), with status
 * and reason the bytes at 16 and 17, or 0 where the value is shorter.
 */
export function decodeAssetAccount(value: Uint8Array): AssetAccount {
  const status = value.length > 16 ? value[16] : 0;
  const reason = value.length > 17 ? value[17] : 0;
  if (value.length !== ASSET_ACCOUNT_LENGTH[reason] || status > 2) {
    throw new StateProofError("AssetAccountMalformed", [String(value.length), String(status), String(reason)]);
  }
  const out: AssetAccount = { balance: leToBigInt(value.subarray(0, 16)), status: ASSET_STATUSES[status], reason: ASSET_REASONS[reason] };
  if (reason === 2) out.deposit = leToBigInt(value.subarray(18, 34));
  if (reason === 4) {
    out.depositor = value.slice(18, 50);
    out.deposit = leToBigInt(value.subarray(50, 66));
  }
  return out;
}

/** pallet-nfts ItemDetails { owner, approvals: BTreeMap<AccountId32, Option<u32>>, deposit { account, amount } }. */
export interface NftItem {
  owner: Uint8Array;
  approvals: { account: Uint8Array; deadline: number | null }[];
  deposit: { account: Uint8Array; amount: bigint };
}

/**
 * An Nfts.Item value, parsed whole: the owner (32 bytes), the approvals (a compact count of one or
 * two bytes, then per approval a 32-byte account and an Option<u32>), and exactly 48 bytes of
 * deposit (account and u128) after them; else NftItemMalformed(length). PortaldotState.decodeNftOwner
 * parses the same way.
 */
export function decodeNftItem(value: Uint8Array): NftItem {
  const length = value.length;
  const malformed = () => new StateProofError("NftItemMalformed", [String(length)]);
  if (length < 81) throw malformed();
  let at = 32;
  const b0 = value[at];
  let count: number;
  if ((b0 & 3) === 0) {
    count = b0 >> 2;
    at += 1;
  } else if ((b0 & 3) === 1) {
    count = (b0 | (value[at + 1] << 8)) >> 2;
    if (count < 64) throw malformed();
    at += 2;
  } else {
    throw malformed();
  }
  const approvals: NftItem["approvals"] = [];
  for (let i = 0; i < count; i++) {
    const account = value.slice(at, at + 32);
    at += 32;
    if (at >= length) throw malformed();
    if (value[at] === 0) {
      approvals.push({ account, deadline: null });
      at += 1;
    } else if (value[at] === 1 && at + 5 <= length) {
      approvals.push({ account, deadline: Number(leToBigInt(value.subarray(at + 1, at + 5))) });
      at += 5;
    } else {
      throw malformed();
    }
  }
  if (at > length || length - at !== 48) throw malformed();
  return { owner: value.slice(0, 32), approvals, deposit: { account: value.slice(at, at + 32), amount: leToBigInt(value.subarray(at + 32, at + 48)) } };
}

/**
 * A Revive.AccountInfoOf value as BridgeMinter and PortaldotState read it: a 130-byte Contract entry
 * (variant 0) with a 32-byte trie id (compact length 0x80), the trie id at byte 2 and the code hash
 * at byte 34; else NotAContract(length, variant). An externally owned account's entry is 5 bytes.
 */
export function decodeContractInfo(value: Uint8Array): { trieId: Uint8Array; codeHash: Uint8Array } {
  if (value.length !== 130 || value[0] !== 0 || value[1] !== 0x80) {
    throw new StateProofError("NotAContract", [String(value.length), String(value.length ? value[0] : 0)]);
  }
  return { trieId: value.slice(2, 34), codeHash: value.slice(34, 66) };
}

/** A contract slot's value: the 32-byte word the contract stored, else SlotLength. */
export function slotWord(value: Uint8Array): Uint8Array {
  if (value.length !== 32) throw new StateProofError("SlotLength", [String(value.length)]);
  return value;
}

// ---------------------------------------------------------------------------------------
// The reads, as PortaldotState makes them (after the light client's stateRootOf)

export const accountInfoAt = (root: Uint8Array, accountId: Uint8Array, proof: Uint8Array[]): SystemAccount =>
  decodeSystemAccount(readMain(root, proof, systemAccountKey(accountId)));

export const assetAccountAt = (root: Uint8Array, assetId: number, accountId: Uint8Array, proof: Uint8Array[]): AssetAccount =>
  decodeAssetAccount(readMain(root, proof, assetsAccountKey(assetId, accountId)));

export const nftOwnerAt = (root: Uint8Array, collection: number, item: number, proof: Uint8Array[]): Uint8Array =>
  decodeNftItem(readMain(root, proof, nftsItemKey(collection, item))).owner;

export const contractAt = (root: Uint8Array, address: Uint8Array, accountProof: Uint8Array[]): { trieId: Uint8Array; codeHash: Uint8Array } =>
  decodeContractInfo(readMain(root, accountProof, reviveAccountInfoKey(address)));

/** The word of `slot` in the child trie `trieId` (PortaldotState.childSlotAt). */
export const childSlotAt = (root: Uint8Array, trieId: Uint8Array, slot: Uint8Array, childRootProof: Uint8Array[], slotProof: Uint8Array[]): Uint8Array =>
  slotWord(readChild(root, childRootProof, slotProof, trieId, reviveSlotKey(slot)).value);

/** The proofs of a contract slot: Revive.AccountInfoOf(address), the root of its child trie, the slot in it. */
export interface ContractSlotProofs {
  account: Uint8Array[];
  childRoot: Uint8Array[];
  slot: Uint8Array[];
}

/** A contract's slot (PortaldotState.contractSlotAt): its trie id from its AccountInfoOf entry, then the slot in its child trie. */
export function contractSlotAt(root: Uint8Array, address: Uint8Array, slot: Uint8Array, p: ContractSlotProofs): { word: Uint8Array; codeHash: Uint8Array; trieId: Uint8Array } {
  const { trieId, codeHash } = contractAt(root, address, p.account);
  return { word: childSlotAt(root, trieId, slot, p.childRoot, p.slot), codeHash, trieId };
}

/** The outcome of `read`: "value", or the reason the contracts refuse it with. */
export function outcomeOf(read: () => unknown): string {
  try {
    read();
    return "value";
  } catch (error) {
    if (error instanceof StateProofError) return error.reason;
    throw error;
  }
}

// ---------------------------------------------------------------------------------------
// PortaldotStateReader and ProvenAssetGate

/** PortaldotStateReader's functions (IPortaldotStateReader). */
export const READER = {
  accountInfo: "accountInfo(bytes32,bytes32,bytes[])",
  assetAccount: "assetAccount(bytes32,uint32,bytes32,bytes[])",
  nftOwner: "nftOwner(bytes32,uint32,uint32,bytes[])",
  contractInfo: "contractInfo(bytes32,address,bytes[])",
  contractSlot: "contractSlot(bytes32,address,bytes32,(bytes[],bytes[],bytes[]))",
  childSlot: "childSlot(bytes32,bytes32,bytes32,bytes[],bytes[])",
  readMain: "readMain(bytes32,bytes,bytes[])",
  stateRootOf: "stateRootOf(bytes32)",
  lightClient: "lightClient()",
} as const;

export type ReaderCall =
  | { kind: "accountInfo"; blockHash: Uint8Array; accountId: Uint8Array; proof: Uint8Array[] }
  | { kind: "assetAccount"; blockHash: Uint8Array; assetId: number; accountId: Uint8Array; proof: Uint8Array[] }
  | { kind: "nftOwner"; blockHash: Uint8Array; collection: number; item: number; proof: Uint8Array[] }
  | { kind: "contractInfo"; blockHash: Uint8Array; address: Uint8Array; proof: Uint8Array[] }
  | { kind: "contractSlot"; blockHash: Uint8Array; address: Uint8Array; slot: Uint8Array; proofs: ContractSlotProofs }
  | { kind: "childSlot"; blockHash: Uint8Array; trieId: Uint8Array; slot: Uint8Array; childRootProof: Uint8Array[]; slotProof: Uint8Array[] }
  | { kind: "readMain"; blockHash: Uint8Array; key: Uint8Array; proof: Uint8Array[] }
  | { kind: "stateRootOf"; blockHash: Uint8Array }
  | { kind: "lightClient" };

const u = (n: number | bigint) => ({ word: uintWord(BigInt(n)) });
const w = (word: Uint8Array): { word: Uint8Array } => {
  if (word.length !== 32) throw new Error(`a bytes32 argument is 32 bytes, got ${word.length}`);
  return { word };
};

/** The calldata of a Reader call. */
export function readerCalldata(call: ReaderCall): Uint8Array {
  const args: AbiParam[] = (() => {
    switch (call.kind) {
      case "accountInfo":
        return [w(call.blockHash), w(call.accountId), { list: call.proof }];
      case "assetAccount":
        return [w(call.blockHash), u(call.assetId), w(call.accountId), { list: call.proof }];
      case "nftOwner":
        return [w(call.blockHash), u(call.collection), u(call.item), { list: call.proof }];
      case "contractInfo":
        return [w(call.blockHash), { word: addressWord(call.address) }, { list: call.proof }];
      case "contractSlot":
        return [w(call.blockHash), { word: addressWord(call.address) }, w(call.slot), { tuple: [{ list: call.proofs.account }, { list: call.proofs.childRoot }, { list: call.proofs.slot }] }];
      case "childSlot":
        return [w(call.blockHash), w(call.trieId), w(call.slot), { list: call.childRootProof }, { list: call.slotProof }];
      case "readMain":
        return [w(call.blockHash), { bytes: call.key }, { list: call.proof }];
      case "stateRootOf":
        return [w(call.blockHash)];
      case "lightClient":
        return [];
    }
  })();
  return concatBytes(selector(READER[call.kind]), abiEncode(args));
}

export type ReaderResult =
  | { kind: "accountInfo"; info: SystemAccount; number: number }
  | { kind: "assetAccount"; balance: bigint; status: number; number: number }
  | { kind: "nftOwner"; owner: Uint8Array; number: number }
  | { kind: "contractInfo"; trieId: Uint8Array; codeHash: Uint8Array; number: number }
  | { kind: "contractSlot"; word: Uint8Array; codeHash: Uint8Array; number: number }
  | { kind: "childSlot"; word: Uint8Array; number: number }
  | { kind: "readMain"; value: Uint8Array; number: number }
  | { kind: "stateRootOf"; stateRoot: Uint8Array; number: number }
  | { kind: "lightClient"; address: Uint8Array };

/** What a Reader call returned, decoded. Throws on an answer of the wrong size or a value out of range. */
export function decodeReaderResult(kind: ReaderCall["kind"], data: Uint8Array): ReaderResult {
  const word = (i: number) => {
    if (data.length < 32 * (i + 1)) throw new Error(`a ${kind} answer of ${data.length} bytes has no word ${i}`);
    return data.slice(32 * i, 32 * i + 32);
  };
  const uint = (i: number, bits: number) => {
    const v = uintAt(data, i);
    if (v >= 1n << BigInt(bits)) throw new Error(`word ${i} of the ${kind} answer is not a uint${bits}`);
    return v;
  };
  const num = (i: number) => Number(uint(i, 32));
  const size = (words: number) => {
    if (data.length !== 32 * words) throw new Error(`a ${kind} answer is ${32 * words} bytes, got ${data.length}`);
  };
  switch (kind) {
    case "accountInfo": {
      size(9);
      const info = { nonce: num(0), consumers: num(1), providers: num(2), sufficients: num(3), free: uint(4, 128), reserved: uint(5, 128), frozen: uint(6, 128), flags: uint(7, 128) };
      return { kind, info, number: num(8) };
    }
    case "assetAccount":
      size(3);
      return { kind, balance: uint(0, 128), status: Number(uint(1, 8)), number: num(2) };
    case "nftOwner":
      size(2);
      return { kind, owner: word(0), number: num(1) };
    case "contractInfo":
      size(3);
      return { kind, trieId: word(0), codeHash: word(1), number: num(2) };
    case "contractSlot":
      size(3);
      return { kind, word: word(0), codeHash: word(1), number: num(2) };
    case "childSlot":
      size(2);
      return { kind, word: word(0), number: num(1) };
    case "stateRootOf":
      size(2);
      return { kind, stateRoot: word(0), number: num(1) };
    case "lightClient":
      size(1);
      return { kind, address: addressAt(data, 0) };
    case "readMain": {
      const at = Number(uint(0, 32));
      const length = at + 32 <= data.length ? Number(uintAt(data.slice(at), 0)) : -1;
      if (length < 0 || at + 32 + length > data.length) throw new Error("a readMain answer with its value outside it");
      return { kind, value: data.slice(at + 32, at + 32 + length), number: num(1) };
    }
  }
}

/** ProvenAssetGate's functions and its event. */
export const GATE = {
  claim: "claim(address,bytes[])",
  claimed: "claimed(address)",
  reader: "reader()",
  snapshotBlock: "snapshotBlock()",
  snapshotNumber: "snapshotNumber()",
  assetId: "assetId()",
  minimum: "minimum()",
} as const;
export const CLAIMED_TOPIC = topic("Claimed(address,uint128,uint8,bytes32,uint32)");

/** ProvenAssetGate.claim(holder, proof): Assets.Account(assetId, holder ++ 0xEE x 12) at the gate's snapshot block. */
export const claimCalldata = (holder: Uint8Array, proof: Uint8Array[]): Uint8Array =>
  concatBytes(selector(GATE.claim), abiEncode([{ word: addressWord(holder) }, { list: proof }]));

/** ProvenAssetGate's constructor arguments: abi.encode(reader, snapshotBlock, uint32 assetId, uint128 minimum). */
export const gateConstructorArgs = (reader: Uint8Array, snapshotBlock: Uint8Array, assetId: number, minimum: bigint): Uint8Array =>
  concatBytes(addressWord(reader), w(snapshotBlock).word, uintWord(BigInt(assetId)), uintWord(minimum));

/** The errors a Reader call or a claim can revert with, by signature, for bridge.ts errorMap and revertName. */
export const KIT_ERRORS: readonly string[] = [
  // PortaldotState and PortaldotStateReader
  "ZeroLightClient()", "AccountInfoLength(uint256)", "AssetAccountMalformed(uint256,uint8,uint8)", "NftItemMalformed(uint256)",
  "NotAContract(uint256,uint8)", "SlotLength(uint256)",
  // ProvenAssetGate
  "ZeroArgument()", "BelowMinimum(uint128,uint128)", "AlreadyClaimed(address)",
  // SubstrateProofs, through the StorageProofs library, and the light client's stateRootOf
  "EmptyProof()", "EmptyKey()", "KeyNotPresent(bytes32,bytes)", "EmptyValue(bytes32,bytes)", "ChildRootLength(uint256)", "ZeroChildRoot()",
  "UnknownBlock(bytes32)",
  // Solidity (the trie walk reverts with an Error string)
  "Error(string)", "Panic(uint256)",
];

/** BridgeMinter.LockProof of lock `nonce` from a contract-slot read of commitments[nonce]; accountProof only when the minter still has to bind the vault. */
export const lockProofOf = (blockHash: Uint8Array, proofs: ContractSlotProofs, lock: { recipient: Uint8Array; amount: bigint; nonce: bigint }, bind: boolean): LockProof => ({
  blockHash,
  accountProof: bind ? proofs.account : [],
  childRootProof: proofs.childRoot,
  slotProof: proofs.slot,
  recipient: lock.recipient,
  amount: lock.amount,
  nonce: lock.nonce,
});

// ---------------------------------------------------------------------------------------
// The fixture: state-reads.json (kit.ts capture writes it, kit.ts check and state.test.ts check it)

/** What a read is of, and what its key is built from. */
export type StateReadArgs =
  | { storage: "System.Account"; accountId: Hex }
  | { storage: "Assets.Account"; assetId: number; accountId: Hex }
  | { storage: "Assets.Account prefix"; assetId: number }
  | { storage: "Nfts.Item"; collection: number; item: number }
  | { storage: "Revive.AccountInfoOf"; address: Hex };

/** One read of the main trie at B, with the contracts' outcome: "value", or the error they revert with. */
export interface StateReadJson {
  id: number;
  name: string;
  args: StateReadArgs;
  key: { hasher: string; bytes: number; hex: Hex };
  outcome: string;
  /** The stored value (null when the proof shows none), its decoding, and whether trie V1 kept it behind its hash. */
  value: { bytes: number; scale: Hex; hashed: boolean; decoded: Record<string, unknown> } | null;
  proof: ProofJson;
}

/** One slot of the vault's child trie at B; `lock` is the record's lock for a commitments[n] slot. */
export interface StateSlotJson {
  name: string;
  index: Hex;
  key: { hasher: string; hex: Hex };
  outcome: string;
  value: { bytes: number; hex: Hex } | null;
  lock?: { nonce: number; dstChainId: string; dstMinter: Hex; recipient: Hex; amountNative: string; source: string };
  proof: ProofJson & { served: { count: number; bytes: number; mainTrieItems: number } };
}

/** A read's proof used for another key, with the walk's outcome there. */
export interface StateTamperJson {
  name: string;
  read: number;
  key: Hex;
  outcome: string;
}

export interface StateReadsFixture {
  provenance: Provenance;
  kind: "state-reads";
  about: string;
  node: { version: string };
  /** B, the block every read is at, and its parent, a checkpoint in the set that finalized B. */
  header: HeaderJson;
  parentHeader: HeaderJson;
  trieVersion: 0 | 1;
  /** The set that signed B, read at B's parent; setIdAtB is Grandpa.CurrentSetId at B (B changes the set). */
  signingSet: StateAuthoritySetJson;
  setIdAtB: { key: Hex; scale: Hex; setId: number };
  justification: JustificationJson;
  finalityProof: { block: Hex; justificationBytes: number; unknownHeaders: number; bytes: number; scale: Hex };
  signers: { hint: Hex; count: number; threshold: number };
  /** What the light client on Sepolia answered for B, and the transaction that imported B. */
  lightClient: {
    network: string;
    name: string;
    address: Hex;
    readAt: BlockRef;
    stateRootOf: { stateRoot: Hex; number: number };
    headerOf: { number: number; stateRoot: Hex; setId: number };
    latestFinalized: BlockRef;
    currentSetId: number;
    importTx: { hash: Hex; block: number; method: string } | null;
  };
  reads: StateReadJson[];
  contract: {
    address: Hex;
    /** The id of its Revive.AccountInfoOf read. */
    read: number;
    trieId: Hex;
    codeHash: Hex;
    chainId: number;
    childRoot: { key: { prefix: string; bytes: number; hex: Hex }; root: Hex; proof: ProofJson };
    slots: StateSlotJson[];
  };
  tampers: StateTamperJson[];
  notes: string[];
}

const nodesOf = (p: ProofJson): Uint8Array[] => p.nodes.map((n) => hexToBytes(n));

/** The key of a read, from its arguments. */
export function keyOfRead(args: StateReadArgs): Uint8Array {
  switch (args.storage) {
    case "System.Account":
      return systemAccountKey(hexToBytes(args.accountId));
    case "Assets.Account":
      return assetsAccountKey(args.assetId, hexToBytes(args.accountId));
    case "Assets.Account prefix":
      return assetsAccountPrefix(args.assetId);
    case "Nfts.Item":
      return nftsItemKey(args.collection, args.item);
    case "Revive.AccountInfoOf":
      return reviveAccountInfoKey(hexToBytes(args.address));
  }
}

/** A read made the way the contracts make it (the Reader's function for its item; readMain for a prefix): the value it returns, decoded. */
export function readAs(args: StateReadArgs, root: Uint8Array, proof: Uint8Array[]): Record<string, unknown> {
  switch (args.storage) {
    case "System.Account":
      return systemAccountJson(accountInfoAt(root, hexToBytes(args.accountId), proof));
    case "Assets.Account":
      return assetAccountJson(assetAccountAt(root, args.assetId, hexToBytes(args.accountId), proof));
    case "Assets.Account prefix":
      return { value: bytesToHex(readMain(root, proof, assetsAccountPrefix(args.assetId))) };
    case "Nfts.Item":
      return nftItemJson(decodeNftItem(readMain(root, proof, nftsItemKey(args.collection, args.item))));
    case "Revive.AccountInfoOf": {
      const { trieId, codeHash } = contractAt(root, hexToBytes(args.address), proof);
      return { trieId: bytesToHex(trieId), codeHash: bytesToHex(codeHash) };
    }
  }
}

export const systemAccountJson = (a: SystemAccount): Record<string, unknown> => ({
  nonce: a.nonce,
  consumers: a.consumers,
  providers: a.providers,
  sufficients: a.sufficients,
  free: a.free.toString(),
  reserved: a.reserved.toString(),
  frozen: a.frozen.toString(),
  flags: a.flags.toString(),
});

export const assetAccountJson = (a: AssetAccount): Record<string, unknown> => ({
  balance: a.balance.toString(),
  status: a.status,
  reason: a.reason,
  ...(a.deposit === undefined ? {} : { deposit: a.deposit.toString() }),
  ...(a.depositor === undefined ? {} : { depositor: bytesToHex(a.depositor) }),
});

export const nftItemJson = (n: NftItem): Record<string, unknown> => ({
  owner: bytesToHex(n.owner),
  approvals: n.approvals.map((a) => ({ account: bytesToHex(a.account), deadline: a.deadline })),
  deposit: { account: bytesToHex(n.deposit.account), amount: n.deposit.amount.toString() },
});

/** The decoding of a stored value as the capture records it: every field, whether or not the contracts accept the value. */
export function decodedJson(args: StateReadArgs, value: Uint8Array): Record<string, unknown> {
  switch (args.storage) {
    case "System.Account":
      return systemAccountJson(decodeSystemAccount(value));
    case "Assets.Account":
      return assetAccountJson(decodeAssetAccount(value));
    case "Assets.Account prefix":
      return { value: bytesToHex(value) };
    case "Nfts.Item":
      return nftItemJson(decodeNftItem(value));
    case "Revive.AccountInfoOf": {
      const info = decodeReviveAccountInfo(value);
      if (info.kind === "EOA") return { kind: "EOA", dust: info.dust };
      const c = info.contract;
      return {
        kind: "Contract",
        trieId: bytesToHex(c.trieId),
        codeHash: bytesToHex(c.codeHash),
        storageBytes: c.storageBytes,
        storageItems: c.storageItems,
        storageByteDeposit: c.storageByteDeposit.toString(),
        storageItemDeposit: c.storageItemDeposit.toString(),
        storageBaseDeposit: c.storageBaseDeposit.toString(),
        immutableDataLen: c.immutableDataLen,
        dust: info.dust,
      };
    }
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Every item of `nodes` flipped in its middle byte: each copy must fail with "Incomplete Proof!". */
function flipsFail(nodes: Uint8Array[], read: (nodes: Uint8Array[]) => unknown): number {
  for (let i = 0; i < nodes.length; i++) {
    const copy = nodes.slice();
    copy[i] = flipByte(nodes[i], nodes[i].length >> 1);
    const outcome = outcomeOf(() => read(copy));
    assert(outcome === INCOMPLETE_PROOF, `item ${i} flipped gives ${outcome}, not "${INCOMPLETE_PROOF}"`);
  }
  return nodes.length;
}

/**
 * Verifies a state-reads fixture offline, as the light client and the Reader will: B's header and
 * its parent hash to their hashes; the signing set is the one its runtime call and set id storage
 * hold at B's parent; B carries the set change to the next set, which Grandpa.CurrentSetId at B
 * names; the finality proof is for B, without unknown headers, every precommit verifies under the
 * signing set with the client's own check and meets the threshold, and the signers hint is the one
 * relay.ts builds; the light client's recorded answer names B's state root; every read's key is the
 * one its arguments give, the read (the Reader's function for its item) has the recorded outcome
 * and decoding, every item is used, and any item flipped fails with "Incomplete Proof!"; the
 * vault's child root and slots likewise, each commitment the one recomputed from the record's
 * lock; and every tamper has its recorded outcome. Returns each check as [passed, what].
 */
export function checkStateReads(f: StateReadsFixture): [boolean, string][] {
  const lines: [boolean, string][] = [];
  const check = (what: string, run: () => string | void) => {
    try {
      const detail = run();
      lines.push([true, detail ? `${what}: ${detail}` : what]);
    } catch (error) {
      lines.push([false, `${what}: ${error instanceof Error ? error.message : String(error)}`]);
    }
  };
  const header = hexToBytes(f.header.scale);
  const root = hexToBytes(f.header.stateRoot);
  const B = `#${f.header.number.toLocaleString("en-US")}`;
  const keys = f.signingSet.authorities.map((a) => hexToBytes(a.id));
  const setId = BigInt(f.signingSet.setId);

  check(`B's header hashes to B (${B} ${shortHex(f.header.hash)})`, () => {
    assert(bytesToHex(blake2_256(header)) === f.header.hash, "it does not");
    const h = decodeHeader(header);
    assert(h.number === f.header.number && bytesToHex(h.stateRoot) === f.header.stateRoot, "its number or state root is not the recorded one");
    assert(bytesToHex(h.parentHash) === f.parentHeader.hash, "its parent hash is not the parent header's");
    return `state root ${shortHex(f.header.stateRoot)}`;
  });
  check("B's parent hashes to its hash, a checkpoint in the signing set", () => {
    const parent = hexToBytes(f.parentHeader.scale);
    assert(bytesToHex(blake2_256(parent)) === f.parentHeader.hash, "it does not");
    assert(decodeHeader(parent).number + 1 === f.header.number, "it is not B's parent");
    assert(f.signingSet.at.hash === f.parentHeader.hash, "the signing set was not read at B's parent");
    assert(!grandpaLogs(decodeHeader(parent)).some((l) => l.log.kind === "ScheduledChange" || l.log.kind === "ForcedChange"), "the parent changes the set");
  });
  check(`the signing set is set ${setId}, as its runtime call and set id storage hold it`, () => {
    const list = decodeAuthorityList(hexToBytes(f.signingSet.runtimeCall.scale));
    assert(list.length === keys.length && list.every((a, i) => equalBytes(a.id, keys[i]) && a.weight === 1n), "the runtime call holds another list");
    assert(decodeU64(hexToBytes(f.signingSet.setIdStorage.scale), "set id") === setId, "Grandpa.CurrentSetId holds another set id");
    assert(f.signingSet.threshold === threshold(keys.length), "the recorded threshold is not N - floor((N - 1) / 3)");
    return `${keys.length} keys, threshold ${f.signingSet.threshold}`;
  });
  check(`B carries the change to set ${setId + 1n}, which Grandpa.CurrentSetId names at B`, () => {
    const changes = grandpaLogs(decodeHeader(header)).filter((l) => l.log.kind === "ScheduledChange" || l.log.kind === "ForcedChange");
    assert(changes.length === 1 && changes[0].log.kind === "ScheduledChange" && changes[0].log.delay === 0, "B does not carry exactly one ScheduledChange with delay 0");
    const next = changes[0].log.kind === "ScheduledChange" ? changes[0].log.nextAuthorities : [];
    assert(decodeU64(hexToBytes(f.setIdAtB.scale), "set id") === setId + 1n && f.setIdAtB.setId === Number(setId) + 1, "Grandpa.CurrentSetId at B is not the next set id");
    const sameKeys = next.length === keys.length && next.every((a, i) => equalBytes(a.id, keys[i]));
    return `${next.length} keys, ${sameKeys ? "the same as the signing set's" : "a new list"}`;
  });
  let jOk = false;
  check(`the finality proof is for B, without unknown headers, and every precommit verifies under set ${setId} with the client's check`, () => {
    const proof = decodeFinalityProof(hexToBytes(f.finalityProof.scale));
    assert(bytesToHex(proof.block) === f.header.hash && proof.unknownHeaders.length === 0, "it is not B's, or it carries unknown headers");
    assert(bytesToHex(proof.justification) === f.justification.scale, "its justification is not the recorded one");
    const j = decodeJustification(proof.justification);
    assert(bytesToHex(j.targetHash) === f.header.hash && j.targetNumber === f.header.number, "the justification targets another block");
    const result = verifyJustification(j, keys, setId, clientVerifies);
    assert(result.ok && result.valid === j.precommits.length, result.problems.join("; ") || "not every precommit is valid");
    const hint = signersHint(j, keys, setId);
    assert(bytesToHex(hint.hint) === f.signers.hint && hint.counted.length === f.signers.count, "the signers hint is not the one relay.ts builds");
    jOk = true;
    return `${result.valid} of ${keys.length} valid, threshold ${result.required}; hint ${f.signers.hint}`;
  });
  check(`the light client (${f.lightClient.name}, ${f.lightClient.network}) holds B with its state root`, () => {
    assert(f.lightClient.stateRootOf.stateRoot === f.header.stateRoot && f.lightClient.stateRootOf.number === f.header.number, "stateRootOf answered another root");
    assert(f.lightClient.headerOf.setId === Number(setId), `headerOf names set ${f.lightClient.headerOf.setId}, not the signing set`);
    return `stateRootOf at Sepolia block ${f.lightClient.readAt.number.toLocaleString("en-US")}, set ${f.lightClient.headerOf.setId}${f.lightClient.importTx ? `, imported in ${shortHex(f.lightClient.importTx.hash)}` : ""}`;
  });
  if (!jOk) lines.push([false, "the reads are checked against B's state root only once B's finality checks out"]);

  for (const r of f.reads) {
    check(`read ${r.id}: ${r.name}`, () => {
      const nodes = nodesOf(r.proof);
      const key = keyOfRead(r.args);
      assert(bytesToHex(key) === r.key.hex && key.length === r.key.bytes, "the key is not the one its arguments give");
      const outcome = outcomeOf(() => readAs(r.args, root, nodes));
      assert(outcome === r.outcome, `the read gives ${outcome}, the fixture says ${r.outcome}`);
      const used = readProof(root, nodes, key);
      assert(used.itemsUsed === nodes.length, `${nodes.length - used.itemsUsed} items the walk does not need`);
      if (r.value) {
        const value = hexToBytes(r.value.scale);
        assert(used.value !== null && equalBytes(used.value, value), "the proof leads to another value");
        assert(same(decodedJson(r.args, value), r.value.decoded), "the value decodes to other fields");
        assert(r.value.hashed === (used.hashedValues > 0), "the value is recorded as hashed or inline wrongly");
      } else {
        assert(used.value === null || used.value.length === 0, "the proof shows a value");
      }
      flipsFail(nodes, (copy) => readAs(r.args, root, copy));
      return `${r.outcome}; ${nodes.length} items, ${r.proof.bytes} B, each one flipped fails`;
    });
  }

  const c = f.contract;
  const trieId = hexToBytes(c.trieId);
  const childRootNodes = nodesOf(c.childRoot.proof);
  check(`the vault ${shortHex(c.address)}: its AccountInfoOf entry names trie id ${shortHex(c.trieId)} and code hash ${shortHex(c.codeHash)}`, () => {
    const read = f.reads.find((r) => r.id === c.read);
    assert(read && read.args.storage === "Revive.AccountInfoOf" && read.args.address === c.address, "no AccountInfoOf read of the vault");
    const info = contractAt(root, hexToBytes(c.address), nodesOf(read.proof));
    assert(bytesToHex(info.trieId) === c.trieId && bytesToHex(info.codeHash) === c.codeHash, "it names another trie id or code hash");
  });
  check(`the vault's child root ${shortHex(c.childRoot.root)} under ":child_storage:default:" ++ trie id`, () => {
    assert(bytesToHex(childRootKey(trieId)) === c.childRoot.key.hex, "the key is not the trie id's");
    const value = readMain(root, childRootNodes, childRootKey(trieId));
    assert(bytesToHex(value) === c.childRoot.root, "the proof leads to another root");
    assert(readProof(root, childRootNodes, childRootKey(trieId)).itemsUsed === childRootNodes.length, "items the walk does not need");
    flipsFail(childRootNodes, (copy) => readMain(root, copy, childRootKey(trieId)));
    return `${childRootNodes.length} items, each one flipped fails`;
  });
  for (const s of c.slots) {
    check(`slot ${s.name}`, () => {
      const index = hexToBytes(s.index);
      assert(bytesToHex(reviveSlotKey(index)) === s.key.hex, "the key is not blake2_256 of the slot");
      const nodes = nodesOf(s.proof);
      const outcome = outcomeOf(() => childSlotAt(root, trieId, index, childRootNodes, nodes));
      assert(outcome === s.outcome, `the read gives ${outcome}, the fixture says ${s.outcome}`);
      const childRoot = hexToBytes(c.childRoot.root);
      const used = readProof(childRoot, nodes, reviveSlotKey(index));
      assert(used.itemsUsed === nodes.length, `${nodes.length - used.itemsUsed} items the walk does not need`);
      assert(s.proof.served.mainTrieItems === childRootNodes.length, "the node served other main-trie items than the child-root proof's");
      let detail = s.outcome;
      if (s.value) {
        const word = childSlotAt(root, trieId, index, childRootNodes, nodes);
        assert(bytesToHex(word) === s.value.hex, "the proof leads to another word");
        if (s.lock) {
          assert(bytesToHex(index) === bytesToHex(commitmentSlot(BigInt(s.lock.nonce))), "the slot is not commitments[nonce]");
          const expected = lockCommitment({
            v3ChainId: BigInt(c.chainId),
            vault: hexToBytes(c.address),
            dstChainId: BigInt(s.lock.dstChainId),
            dstMinter: hexToBytes(s.lock.dstMinter),
            recipient: hexToBytes(s.lock.recipient),
            amountNative: BigInt(s.lock.amountNative),
            nonce: BigInt(s.lock.nonce),
          });
          assert(equalBytes(word, expected), `the word is not the commitment of the record's lock ${s.lock.nonce}`);
          detail += `, the commitment of lock ${s.lock.nonce} as ${s.lock.source} records it`;
        }
      }
      flipsFail(nodes, (copy) => childSlotAt(root, trieId, index, childRootNodes, copy));
      return `${detail}; ${nodes.length} child-trie items, each one flipped fails`;
    });
  }
  for (const t of f.tampers) {
    check(`tamper: ${t.name}`, () => {
      const read = f.reads.find((r) => r.id === t.read);
      assert(read, `no read ${t.read}`);
      const outcome = outcomeOf(() => readMain(root, nodesOf(read.proof), hexToBytes(t.key)));
      assert(outcome === t.outcome, `the walk gives ${outcome}, the fixture says ${t.outcome}`);
      return outcome;
    });
  }
  check("B's proofs under another root (its parent's) fail", () => {
    const parentRoot = hexToBytes(f.parentHeader.stateRoot);
    for (const r of f.reads) {
      const outcome = outcomeOf(() => readAs(r.args, parentRoot, nodesOf(r.proof)));
      assert(outcome === INCOMPLETE_PROOF, `read ${r.id} gives ${outcome}`);
    }
    return `all ${f.reads.length} reads give "${INCOMPLETE_PROOF}"`;
  });
  return lines;
}
