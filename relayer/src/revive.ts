// pallet-revive contract storage, in the layout Westend Asset Hub uses (westmint, spec 1,025,002;
// fixtures/westend-asset-hub-revive is a capture of it). The Portaldot V3 testnet's runtime
// metadata (portaldot-v3 3002) has the same Revive storage types.
//   - Revive.AccountInfoOf maps a 20-byte address (Identity hasher) to AccountInfo
//     { account_type, dust: u32 }. account_type 0 is Contract(ContractInfo), 1 an externally
//     owned account. ContractInfo starts with the contract's trie id (Vec<u8>) and its code hash
//     (H256, the keccak-256 of the code that eth_getCode returns).
//   - Revive.CodeInfoOf maps a code hash (Identity hasher) to CodeInfo { owner: AccountId32,
//     deposit: Compact<u128>, refcount: Compact<u64>, code_len: u32, code_type, behaviour_version:
//     u32 }. code_type 0 is a PolkaVM program, 1 EVM bytecode (BytecodeType in the metadata).
//   - The contract's storage is the default child trie named by its trie id. The child trie's
//     root is in the main trie under ":child_storage:default:" ++ trie id (hash.ts, childRootKey).
//   - A 32-byte storage key K, such as an EVM slot, is stored in that child trie under
//     blake2_256(K); the value is the stored bytes.
//   - Revive.BlockHash maps a block number (u32, Identity hasher) to the hash of the Ethereum
//     block the runtime builds for that block. An eth-rpc that serves those blocks reports this
//     hash, not the Substrate one; the block's parent hash is Revive.BlockHash of the block
//     before, and its state root is a placeholder, the empty-trie root (EMPTY_TRIE_ROOT).

import { keccak_256 } from "@noble/hashes/sha3.js";
import { concatBytes, equalBytes, u32le } from "./bytes.js";
import { blake2_256, storageKey } from "./hash.js";
import { Reader, ScaleError } from "./scale.js";

/** twox128("Revive") ++ twox128("AccountInfoOf"). */
export const REVIVE_ACCOUNT_INFO_PREFIX = storageKey("Revive", "AccountInfoOf");
/** twox128("Revive") ++ twox128("CodeInfoOf"). */
export const REVIVE_CODE_INFO_PREFIX = storageKey("Revive", "CodeInfoOf");
/** twox128("Revive") ++ twox128("BlockHash"). */
export const REVIVE_BLOCK_HASH_PREFIX = storageKey("Revive", "BlockHash");

/** Revive.AccountInfoOf(address): prefix ‖ address (Identity hasher), 52 bytes. */
export function reviveAccountInfoKey(address: Uint8Array): Uint8Array {
  if (address.length !== 20) throw new Error(`address must be 20 bytes, got ${address.length}`);
  return concatBytes(REVIVE_ACCOUNT_INFO_PREFIX, address);
}

/** Revive.CodeInfoOf(codeHash): prefix ‖ code hash (Identity hasher), 64 bytes. */
export function reviveCodeInfoKey(codeHash: Uint8Array): Uint8Array {
  if (codeHash.length !== 32) throw new Error(`code hash must be 32 bytes, got ${codeHash.length}`);
  return concatBytes(REVIVE_CODE_INFO_PREFIX, codeHash);
}

/** Revive.BlockHash(number): prefix ‖ u32le(number) (Identity hasher), 36 bytes. */
export function reviveBlockHashKey(number: number): Uint8Array {
  return concatBytes(REVIVE_BLOCK_HASH_PREFIX, u32le(number));
}

/**
 * The state root of the Ethereum blocks the runtime builds, as an eth-rpc that serves them reports
 * it: the root of an empty Ethereum trie, keccak-256 of RLP("") (the byte 0x80),
 * 0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421. A placeholder, not B's.
 */
export const EMPTY_TRIE_ROOT = keccak_256(Uint8Array.of(0x80));

/** Child-trie key of a contract's 32-byte storage key (an EVM slot): blake2_256(slot). */
export function reviveSlotKey(slot: Uint8Array): Uint8Array {
  if (slot.length !== 32) throw new Error(`slot must be 32 bytes, got ${slot.length}`);
  return blake2_256(slot);
}

export interface ReviveContractInfo {
  trieId: Uint8Array;
  codeHash: Uint8Array;
  /** Size and item count of the contract's storage as pallet-revive accounts them, and the deposits held for it. */
  storageBytes: number;
  storageItems: number;
  storageByteDeposit: bigint;
  storageItemDeposit: bigint;
  storageBaseDeposit: bigint;
  immutableDataLen: number;
}

export type ReviveAccountInfo = { kind: "Contract"; contract: ReviveContractInfo; dust: number } | { kind: "EOA"; dust: number };

/** A Revive.AccountInfoOf value. Rejects other variants and trailing bytes. */
export function decodeReviveAccountInfo(bytes: Uint8Array): ReviveAccountInfo {
  const r = new Reader(bytes);
  const variant = r.u8();
  let info: ReviveAccountInfo;
  if (variant === 0) {
    const contract: ReviveContractInfo = {
      trieId: r.vecU8(),
      codeHash: r.bytes(32),
      storageBytes: r.u32(),
      storageItems: r.u32(),
      storageByteDeposit: r.u128(),
      storageItemDeposit: r.u128(),
      storageBaseDeposit: r.u128(),
      immutableDataLen: r.u32(),
    };
    if (contract.trieId.length === 0) throw new ScaleError("contract with an empty trie id");
    info = { kind: "Contract", contract, dust: r.u32() };
  } else if (variant === 1) {
    info = { kind: "EOA", dust: r.u32() };
  } else {
    throw new ScaleError(`unknown AccountType variant ${variant}`);
  }
  r.end("Revive AccountInfo");
  return info;
}

/** BytecodeType in Revive.CodeInfoOf: the variant index is the code_type byte. */
export const REVIVE_CODE_TYPES = ["Pvm", "Evm"] as const;
export type ReviveCodeType = (typeof REVIVE_CODE_TYPES)[number];

export interface ReviveCodeInfo {
  /** The account that uploaded the code, and the deposit it holds for it. */
  owner: Uint8Array;
  deposit: bigint;
  /** How many contracts use the code. */
  refcount: bigint;
  /** Length of the code that eth_getCode returns. */
  codeLen: number;
  codeType: ReviveCodeType;
  behaviourVersion: number;
}

/** A Revive.CodeInfoOf value. Rejects an unknown code_type, values out of range and trailing bytes. */
export function decodeReviveCodeInfo(bytes: Uint8Array): ReviveCodeInfo {
  const r = new Reader(bytes);
  const owner = r.bytes(32);
  const deposit = r.compact();
  if (deposit >= 1n << 128n) throw new ScaleError(`deposit ${deposit} does not fit u128`);
  const refcount = r.compact();
  if (refcount >= 1n << 64n) throw new ScaleError(`refcount ${refcount} does not fit u64`);
  const codeLen = r.u32();
  const typeIndex = r.u8();
  const codeType = REVIVE_CODE_TYPES[typeIndex];
  if (codeType === undefined) throw new ScaleError(`unknown BytecodeType variant ${typeIndex}`);
  const info: ReviveCodeInfo = { owner, deposit, refcount, codeLen, codeType, behaviourVersion: r.u32() };
  r.end("Revive CodeInfo");
  return info;
}

/** The magic that starts a PolkaVM program blob: "PVM\0". */
export const POLKAVM_MAGIC = Uint8Array.of(0x50, 0x56, 0x4d, 0x00);

/**
 * What eth_getCode returned, from its first bytes: a PolkaVM program, or EVM bytecode (run by
 * pallet-revive's REVM). A capture also proves the code's CodeInfoOf, whose code_type must agree.
 */
export function codeKind(code: Uint8Array): "pvm" | "evm" {
  if (code.length === 0) throw new Error("no code");
  return code.length >= 4 && equalBytes(code.subarray(0, 4), POLKAVM_MAGIC) ? "pvm" : "evm";
}

/** The CodeInfoOf code_type of each code kind. */
export const CODE_TYPE_OF_KIND: Record<"pvm" | "evm", ReviveCodeType> = { pvm: "Pvm", evm: "Evm" };

/**
 * eth_getStorageAt's word for a slot that holds nothing: "0x" from some eth-rpc versions (Westend
 * Asset Hub's), 32 zero bytes from others (the V3 testnet's). Both mean unset.
 */
export function isUnsetStorageWord(word: Uint8Array): boolean {
  return word.length === 0 || (word.length === 32 && word.every((b) => b === 0));
}
