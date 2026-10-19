// What capture-contract.ts and mint.ts read from a Substrate node: headers, refused unless their
// SCALE bytes hash to the block hash; the runtime version; storage values; and read proofs of the
// main trie and of a child trie, each walked from its root here before anything uses it.
// Read-only: nothing here signs or sends.

import { bytesToHex, equalBytes, hexToBytes, shortHex, type Hex } from "./bytes.js";
import type { RuntimeInfo } from "./fixture.js";
import { blake2_256 } from "./hash.js";
import { RpcError, type RpcClient } from "./rpc.js";
import { decodeHeader, encodeRpcHeader, type Header, type RpcHeader } from "./scale.js";
import { readProof } from "./trie.js";

/** A value proven from a state root, the proof items that prove it, and how many values the walk found behind their hash. */
export interface ProvenValue {
  value: Uint8Array;
  nodes: Uint8Array[];
  hashedValues: number;
}

export class Chain {
  constructor(readonly rpc: RpcClient) {}

  /** chain_getHeader, re-encoded to SCALE; refuses it unless blake2_256 of the bytes is the block hash. */
  async header(hash: Hex): Promise<Header> {
    const json = await this.rpc.request<RpcHeader | null>("chain_getHeader", [hash]);
    if (!json) throw new Error(`no header for ${hash}`);
    const header = decodeHeader(encodeRpcHeader(json));
    const computed = bytesToHex(blake2_256(header.encoded));
    if (computed !== hash.toLowerCase()) throw new Error(`header ${hash} re-encodes to a different hash ${computed}`);
    return header;
  }

  async runtime(at: Hex): Promise<RuntimeInfo> {
    const v = await this.rpc.request<Record<string, unknown>>("state_getRuntimeVersion", [at]);
    return {
      specName: String(v.specName),
      specVersion: Number(v.specVersion),
      implName: String(v.implName),
      implVersion: Number(v.implVersion),
      transactionVersion: Number(v.transactionVersion),
      ...(v.stateVersion === undefined ? {} : { stateVersion: Number(v.stateVersion) }),
    };
  }

  async storage(key: Uint8Array, at: Hex): Promise<Uint8Array | null> {
    const value = await this.rpc.request<Hex | null>("state_getStorage", [bytesToHex(key), at]);
    return value === null ? null : hexToBytes(value);
  }

  async readProof(key: Uint8Array, at: Hex): Promise<Uint8Array[]> {
    const result = await this.rpc.request<{ at: Hex; proof: Hex[] }>("state_getReadProof", [[bytesToHex(key)], at]);
    return result.proof.map((n) => hexToBytes(n));
  }

  /**
   * state_getReadProof of `key` at `at`, walked from `root` (the state root of `at`): the value,
   * which must be state_getStorage's, and the items, which the walk must all use. Null when the
   * key has no value, which the proof must show too.
   */
  async provenRead(root: Uint8Array, key: Uint8Array, at: Hex, what: string): Promise<ProvenValue | null> {
    const stored = await this.storage(key, at);
    const nodes = await this.readProof(key, at);
    const read = readProof(root, nodes, key);
    if (stored === null) {
      if (read.value !== null) throw new Error(`${what}: state_getStorage has no value, the proof shows ${shortHex(read.value)}`);
      return null;
    }
    if (!read.value || !equalBytes(read.value, stored)) throw new Error(`the ${what} proof does not lead to the value from state_getStorage`);
    if (read.itemsUsed !== nodes.length) throw new Error(`the ${what} proof has ${nodes.length - read.itemsUsed} items the walk does not need`);
    return { value: read.value, nodes, hashedValues: read.hashedValues };
  }

  async childReadProof(childStorageKey: Uint8Array, key: Uint8Array, at: Hex): Promise<Uint8Array[]> {
    const result = await this.rpc.request<{ at: Hex; proof: Hex[] }>("state_getChildReadProof", [bytesToHex(childStorageKey), [bytesToHex(key)], at]);
    return result.proof.map((n) => hexToBytes(n));
  }

  /** childstate_getStorage, or undefined if the node does not expose it. */
  async childStorage(childStorageKey: Uint8Array, key: Uint8Array, at: Hex): Promise<Uint8Array | null | undefined> {
    try {
      const value = await this.rpc.request<Hex | null>("childstate_getStorage", [bytesToHex(childStorageKey), bytesToHex(key), at]);
      return value === null ? null : hexToBytes(value);
    } catch (error) {
      if (error instanceof RpcError && error.code === -32601) return undefined;
      throw error;
    }
  }
}

/**
 * The child-trie items of what state_getChildReadProof served. The node also serves the main-trie
 * items that lead to the child root; they must be exactly `rootNodes`, the child-root proof, and
 * only the others are kept.
 */
export function childItems(served: Uint8Array[], rootNodes: Uint8Array[]): { nodes: Uint8Array[]; mainTrieItems: number } {
  const inRootProof = new Set(rootNodes.map((n) => bytesToHex(n)));
  const inServed = new Set(served.map((n) => bytesToHex(n)));
  const nodes = served.filter((n) => !inRootProof.has(bytesToHex(n)));
  const mainTrieItems = served.length - nodes.length;
  if (mainTrieItems !== rootNodes.length || rootNodes.some((n) => !inServed.has(bytesToHex(n)))) {
    throw new Error(`state_getChildReadProof served ${mainTrieItems} main-trie items, not the ${rootNodes.length} items of the child-root proof`);
  }
  return { nodes, mainTrieItems };
}
