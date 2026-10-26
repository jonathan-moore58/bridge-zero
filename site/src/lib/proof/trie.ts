// Substrate storage proofs: the sp-trie node codec (a 16-ary radix trie, no extension nodes,
// blake2_256 node hashes) as state_getReadProof and state_getChildReadProof serve it, walked from a
// root along a key. Trie V0 keeps every value in its node; trie V1 moves a value of 33 bytes or more
// into a proof item of its own, referenced by its hash. The node headers say which form a node uses,
// so one walk takes both. A port of relayer/src/trie.ts, which has run against the old mainnet (V0),
// the V3 testnet (V1) and Westend Asset Hub's pallet-revive child tries.

import { blake2b256 } from "../hashes.ts";
import { bytesToHex, shortHex } from "../hex.ts";
import { Reader } from "./scale.ts";

export class TrieProofError extends Error {
  override name = "TrieProofError";
}

type NodeValue = { inline: Uint8Array } | { hashed: Uint8Array };
type ChildRef = { hash: Uint8Array } | { inline: Uint8Array };

type TrieNode =
  | { type: "empty" }
  | { type: "leaf"; partial: number[]; value: NodeValue }
  | { type: "branch"; partial: number[]; value: NodeValue | null; children: (ChildRef | null)[] };

/** The nibble count of a node header: its low bits, extended by the bytes that follow while they are 255. */
function decodeSize(first: number, r: Reader, prefixBits: number): number {
  const max = 0xff >> prefixBits;
  let size = first & max;
  if (size < max) return size;
  size -= 1;
  for (;;) {
    const next = r.u8();
    if (next < 255) return size + next + 1;
    size += 255;
  }
}

/** The partial key's nibbles. With an odd count, the high nibble of the first byte is padding and has to be zero. */
function readPartial(r: Reader, nibbleCount: number): number[] {
  const raw = r.bytes((nibbleCount + 1) >> 1);
  const nibbles: number[] = [];
  let i = 0;
  if (nibbleCount % 2 === 1) {
    const first = raw[0] ?? 0;
    if (first >> 4 !== 0) throw new TrieProofError("partial key padding is not zero");
    nibbles.push(first & 0x0f);
    i = 1;
  }
  for (; i < raw.length; i++) {
    const b = raw[i] ?? 0;
    nibbles.push(b >> 4, b & 0x0f);
  }
  return nibbles;
}

function readValue(r: Reader, hashed: boolean): NodeValue {
  return hashed ? { hashed: r.bytes(32) } : { inline: r.vecU8() };
}

export function decodeNode(data: Uint8Array): TrieNode {
  const r = new Reader(data);
  const first = r.u8();
  let node: TrieNode;
  if (first === 0x00) {
    node = { type: "empty" };
  } else {
    // Header layouts: 01 leaf, 10 branch, 11 branch with a value (a 6-bit size); 001 leaf with a
    // hashed value (5-bit size); 0001 branch with a hashed value (4-bit size).
    let isLeaf: boolean;
    let hasValue: boolean;
    let hashedValue = false;
    let nibbleCount: number;
    switch (first >> 6) {
      case 0b01:
        [isLeaf, hasValue, nibbleCount] = [true, true, decodeSize(first, r, 2)];
        break;
      case 0b10:
        [isLeaf, hasValue, nibbleCount] = [false, false, decodeSize(first, r, 2)];
        break;
      case 0b11:
        [isLeaf, hasValue, nibbleCount] = [false, true, decodeSize(first, r, 2)];
        break;
      default:
        if (first >> 5 === 0b001) [isLeaf, hasValue, nibbleCount] = [true, true, decodeSize(first, r, 3)];
        else if (first >> 4 === 0b0001) [isLeaf, hasValue, nibbleCount] = [false, true, decodeSize(first, r, 4)];
        else throw new TrieProofError(`invalid node header byte 0x${first.toString(16).padStart(2, "0")}`);
        hashedValue = true;
    }
    const partial = readPartial(r, nibbleCount);
    if (isLeaf) {
      node = { type: "leaf", partial, value: readValue(r, hashedValue) };
    } else {
      const bitmap = r.u8() | (r.u8() << 8);
      if (bitmap === 0) throw new TrieProofError("branch node without children");
      const value = hasValue ? readValue(r, hashedValue) : null;
      const children: (ChildRef | null)[] = [];
      for (let i = 0; i < 16; i++) {
        if ((bitmap & (1 << i)) === 0) {
          children.push(null);
          continue;
        }
        const child = r.vecU8();
        children.push(child.length === 32 ? { hash: child } : { inline: child });
      }
      node = { type: "branch", partial, value, children };
    }
  }
  r.end("trie node");
  return node;
}

export interface ProofRead {
  /** The stored value, or null when the proof shows the key absent. */
  value: Uint8Array | null;
  /** The distinct proof items the walk used: nodes, and in trie V1 the values behind a hash. */
  itemsUsed: number;
  /** Values that were stored behind their hash (trie V1 only). */
  hashedValues: number;
}

/**
 * Walks `proof` from `root` along `key`. Throws when a node it needs is missing or malformed, which
 * is what a tampered item causes, since its hash no longer matches the reference to it.
 */
export function readProof(root: Uint8Array, proof: Uint8Array[], key: Uint8Array): ProofRead {
  const byHash = new Map<string, Uint8Array>();
  for (const item of proof) byHash.set(bytesToHex(blake2b256(item)), item);
  const used = new Set<string>();
  const lookup = (hash: Uint8Array, what: string): Uint8Array => {
    const id = bytesToHex(hash);
    const item = byHash.get(id);
    if (item === undefined) throw new TrieProofError(`${what} ${shortHex(id)} is not in the proof`);
    used.add(id);
    return item;
  };

  const nibbles: number[] = [];
  for (const b of key) nibbles.push(b >> 4, b & 0x0f);

  let hashedValues = 0;
  const resolve = (v: NodeValue): Uint8Array => {
    if ("inline" in v) return v.inline;
    hashedValues += 1;
    return lookup(v.hashed, "hashed value");
  };
  const result = (value: Uint8Array | null): ProofRead => ({ value, itemsUsed: used.size, hashedValues });

  let data = lookup(root, "root node");
  let pos = 0;
  for (;;) {
    const node = decodeNode(data);
    if (node.type === "empty") return result(null);
    const { partial } = node;
    if (partial.length > nibbles.length - pos) return result(null);
    for (let i = 0; i < partial.length; i++) if (partial[i] !== nibbles[pos + i]) return result(null);
    pos += partial.length;

    if (node.type === "leaf") return result(pos === nibbles.length ? resolve(node.value) : null);
    if (pos === nibbles.length) return result(node.value ? resolve(node.value) : null);

    const child = node.children[nibbles[pos] ?? 16];
    pos += 1;
    if (!child) return result(null);
    data = "hash" in child ? lookup(child.hash, "node") : child.inline;
  }
}

/**
 * The value `proof` proves under `root` for `key`, as the minter's walk needs it: present, and
 * reached with every item of the proof (an item the walk does not use is refused, as a capture
 * that carries more than it proves would be).
 */
export function provenValue(root: Uint8Array, proof: Uint8Array[], key: Uint8Array, what: string): Uint8Array {
  const read = readProof(root, proof, key);
  if (!read.value) throw new TrieProofError(`the ${what} proof shows the key absent`);
  if (read.itemsUsed !== proof.length) throw new TrieProofError(`the ${what} proof has ${proof.length - read.itemsUsed} items the walk does not use`);
  return read.value;
}
