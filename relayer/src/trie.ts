// Substrate storage proof verification: the sp-trie node codec (16-ary radix trie, no
// extension nodes, blake2_256 node hashes), as served by state_getReadProof.
//
// Trie V0 keeps every value inline in its node. Trie V1 moves values of 33 bytes or more
// into a separate proof item referenced by its hash; the node headers say which form a node
// uses, so one walk handles both. Only V0 has been run against a live chain so far.

import { bytesToHex, shortHex } from "./bytes.js";
import { blake2_256 } from "./hash.js";
import { Reader } from "./scale.js";

export class TrieProofError extends Error {
  override name = "TrieProofError";
}

type NodeValue = { inline: Uint8Array } | { hashed: Uint8Array };
type ChildRef = { hash: Uint8Array } | { inline: Uint8Array };

type TrieNode =
  | { type: "empty" }
  | { type: "leaf"; partial: number[]; value: NodeValue }
  | { type: "branch"; partial: number[]; value: NodeValue | null; children: (ChildRef | null)[] };

/** Nibble count from the node header: the low bits, extended by following bytes while they are 255. */
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

/** Partial key nibbles. With an odd count the high nibble of the first byte is padding and must be zero. */
function readPartial(r: Reader, nibbleCount: number): number[] {
  const raw = r.bytes((nibbleCount + 1) >> 1);
  const nibbles: number[] = [];
  let i = 0;
  if (nibbleCount % 2 === 1) {
    if (raw[0] >> 4 !== 0) throw new TrieProofError("partial key padding is not zero");
    nibbles.push(raw[0] & 0x0f);
    i = 1;
  }
  for (; i < raw.length; i++) nibbles.push(raw[i] >> 4, raw[i] & 0x0f);
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
    // Header layouts: 01 leaf, 10 branch, 11 branch with value (6-bit size);
    // 001 leaf with hashed value (5-bit size); 0001 branch with hashed value (4-bit size).
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
        if (first >> 5 === 0b001) {
          [isLeaf, hasValue, nibbleCount] = [true, true, decodeSize(first, r, 3)];
        } else if (first >> 4 === 0b0001) {
          [isLeaf, hasValue, nibbleCount] = [false, true, decodeSize(first, r, 4)];
        } else {
          throw new TrieProofError(`invalid node header byte 0x${first.toString(16).padStart(2, "0")}`);
        }
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
  /** The stored value, or null when the proof shows the key is absent. */
  value: Uint8Array | null;
  /** Distinct proof items the walk touched (nodes, plus hashed values in V1). */
  itemsUsed: number;
  /** Values that were stored behind a hash (trie V1 only). */
  hashedValues: number;
}

/**
 * Walks `proof` from `root` along `key`. Throws if a needed node is missing or malformed,
 * which is what a tampered node causes, since its hash no longer matches its reference.
 */
export function readProof(root: Uint8Array, proof: Uint8Array[], key: Uint8Array): ProofRead {
  const byHash = new Map<string, Uint8Array>();
  for (const item of proof) byHash.set(bytesToHex(blake2_256(item)), item);
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

    const child = node.children[nibbles[pos]];
    pos += 1;
    if (!child) return result(null);
    data = "hash" in child ? lookup(child.hash, "node") : child.inline;
  }
}
