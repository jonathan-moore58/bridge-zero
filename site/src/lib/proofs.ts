// What a visitor's browser can recompute itself: the lock's commitment (as the vault stores it and
// as BridgeMinter.commitmentOf recomputes it), the child-trie key of commitments[nonce], and a
// header's hash.

import { blake2b256, keccak256 } from "./hashes.ts";
import { bytesToHex, concatBytes, hexToBytes, type Hex } from "./hex.ts";

function word(v: bigint | string): Uint8Array {
  const n = typeof v === "string" ? BigInt(v) : v;
  if (n < 0n || n >> 256n) throw new RangeError(`not a uint256: ${n}`);
  return hexToBytes("0x" + n.toString(16).padStart(64, "0"));
}

export const LOCK_TAG: Hex = bytesToHex(keccak256(new TextEncoder().encode("BridgeZero.Lock.v1")));
export const BURN_TAG: Hex = bytesToHex(keccak256(new TextEncoder().encode("BridgeZero.Burn.v1")));

export interface LockFields {
  v3ChainId: bigint;
  vault: string;
  dstChainId: bigint;
  minter: string;
  recipient: string;
  amountNative: bigint;
  nonce: bigint;
}

/** keccak256(abi.encode(LOCK_TAG, v3ChainId, vault, dstChainId, minter, recipient, amountNative, nonce)). */
export function lockCommitment(f: LockFields): Hex {
  return bytesToHex(
    keccak256(concatBytes(word(LOCK_TAG), word(f.v3ChainId), word(f.vault), word(f.dstChainId), word(f.minter), word(f.recipient), word(f.amountNative), word(f.nonce))),
  );
}

/** The EVM storage slot of commitments[nonce]: keccak256(abi.encode(nonce, 0)). */
export function commitmentSlot(nonce: bigint): Hex {
  return bytesToHex(keccak256(concatBytes(word(nonce), word(0n))));
}

/** The key of commitments[nonce] in the vault's child trie: blake2_256 of the slot. */
export function childTrieKey(nonce: bigint): Hex {
  return bytesToHex(blake2b256(hexToBytes(commitmentSlot(nonce))));
}

/** A Substrate block hash: blake2b-256 of the SCALE-encoded header. */
export function headerHash(scale: string): Hex {
  return bytesToHex(blake2b256(hexToBytes(scale)));
}

/** keccak256(abi.encode(BURN_TAG, srcChainId, minter, burnNonce)): the id the committee releases against. */
export function burnId(srcChainId: bigint, minter: string, burnNonce: bigint): Hex {
  return bytesToHex(keccak256(concatBytes(word(BURN_TAG), word(srcChainId), word(minter), word(burnNonce))));
}
