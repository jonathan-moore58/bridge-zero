// Where the vault's lock lives in V3's state, in pallet-revive's layout (relayer/src/revive.ts has
// the whole of it): Revive.AccountInfoOf(vault) in the main trie names the vault's trie id; the root
// of its child trie is in the main trie under ":child_storage:default:" ++ trie id; and an EVM slot
// K is in that child trie under blake2_256(K). commitments[nonce] is the vault's slot
// keccak256(abi.encode(nonce, 0)) (../proofs.ts).

import { bytesToHex, concatBytes, hexToBytes, type Hex } from "../hex.ts";
import { childTrieKey } from "../proofs.ts";
import { Reader, ScaleError } from "./scale.ts";
import { TrieProofError } from "./trie.ts";

/** twox128("Revive") ++ twox128("AccountInfoOf"): BridgeMinter's ACCOUNT_INFO_OF_PREFIX. */
export const ACCOUNT_INFO_OF_PREFIX: Hex = "0x735f040a5d490f1107ad9c56f5ca00d2ae37ff0591fdbbcd9c2406df7147a9dc";

/** The prefix of the main-trie keys that hold the roots of default child tries. */
export const CHILD_STORAGE_DEFAULT_PREFIX = new TextEncoder().encode(":child_storage:default:");

/** Revive.AccountInfoOf(vault): the prefix, then the 20-byte address (Identity hasher), 52 bytes. */
export function accountInfoKey(vault: string): Uint8Array {
  const address = hexToBytes(vault);
  if (address.length !== 20) throw new RangeError(`an address is 20 bytes, got ${address.length}`);
  return concatBytes(hexToBytes(ACCOUNT_INFO_OF_PREFIX), address);
}

/** The main-trie key of a contract's child-trie root: ":child_storage:default:" ++ trie id. The child-state RPCs take the same bytes. */
export function childRootKey(trieId: Uint8Array): Uint8Array {
  if (trieId.length === 0) throw new RangeError("a trie id is not empty");
  return concatBytes(CHILD_STORAGE_DEFAULT_PREFIX, trieId);
}

/** The child-trie key of commitments[nonce]: blake2_256(keccak256(abi.encode(nonce, 0))), as BridgeMinter.slotKeyOf computes it. */
export function commitmentKey(nonce: bigint): Uint8Array {
  return hexToBytes(childTrieKey(nonce));
}

export interface ReviveContract {
  trieId: Uint8Array;
  /** keccak-256 of the code eth_getCode returns. */
  codeHash: Uint8Array;
}

/**
 * The trie id and code hash of a Revive.AccountInfoOf value, taken only as BridgeMinter.bindVault
 * takes them: a Contract entry (variant 0) of exactly 130 bytes, its trie id 32 bytes at byte 2, its
 * code hash at byte 34. The whole value has to decode as AccountInfo { Contract(ContractInfo), dust }.
 */
export function decodeContractInfo(value: Uint8Array): ReviveContract {
  if (value.length !== 130 || value[0] !== 0x00 || value[1] !== 0x80) {
    throw new ScaleError(`not the 130-byte Contract entry with a 32-byte trie id that the minter takes (${value.length} bytes, variant ${value[0] ?? "none"})`);
  }
  const r = new Reader(value);
  r.u8();
  const trieId = r.vecU8();
  const codeHash = r.bytes(32);
  r.u32(); // storage_bytes
  r.u32(); // storage_items
  r.u128(); // storage_byte_deposit
  r.u128(); // storage_item_deposit
  r.u128(); // storage_base_deposit
  r.u32(); // immutable_data_len
  r.u32(); // dust
  r.end("Revive AccountInfo");
  return { trieId, codeHash };
}

/**
 * The child-trie items of what state_getChildReadProof served. The node also serves the main-trie
 * items that lead to the child root; they must be exactly `rootNodes`, the child-root proof, and
 * only the others are kept (relayer/src/chain.ts childItems).
 */
export function childItems(served: Uint8Array[], rootNodes: Uint8Array[]): Uint8Array[] {
  const inRoot = new Set(rootNodes.map((n) => bytesToHex(n)));
  const inServed = new Set(served.map((n) => bytesToHex(n)));
  const nodes = served.filter((n) => !inRoot.has(bytesToHex(n)));
  const mainItems = served.length - nodes.length;
  if (mainItems !== rootNodes.length || rootNodes.some((n) => !inServed.has(bytesToHex(n)))) {
    throw new TrieProofError(`state_getChildReadProof served ${mainItems} main-trie items, not the ${rootNodes.length} items of the child-root proof`);
  }
  return nodes;
}
