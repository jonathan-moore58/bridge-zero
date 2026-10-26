// What a mint reads from the Portaldot V3 node, each answer checked before it is used: headers that
// hash to their block hash, the set id in force at a block, finality proofs (asked again while they
// carry unknown headers), the read proofs of the vault's lock, and the validator-set changes the
// light client has not imported, found without a scan. Read-only, through ../rpc.ts.

import { formatInt } from "../format.ts";
import { blake2b256 } from "../hashes.ts";
import { bytesToHex, equalBytes, hexToBytes, type Hex } from "../hex.ts";
import type { SubstrateClient } from "../rpc.ts";
import { authorityChange, signersHint, SignatureError, type ClientCrypto, type SignersHint } from "./grandpa.ts";
import { childItems, childRootKey, commitmentKey } from "./revive.ts";
import { decodeFinalityProof, decodeHeader, decodeJustification, decodeU64, encodeRpcHeader, ScaleError, type Header, type Justification, type RpcHeader } from "./scale.ts";
import { provenValue } from "./trie.ts";

/** twox128("Grandpa") ++ twox128("CurrentSetId"), as ../chains.ts has it (that module reads the build's records, which node --test cannot). */
export const GRANDPA_SET_ID_KEY: Hex = "0x5f9cc45b7a00c5899361e1c6099678dc8a2d09463effcc78a22d75b9cb87dffc";

/**
 * V3 enacts a GRANDPA set change at fixed times of day, UTC: every one from #75,119 to #179,035
 * fell at one of these (research of Oct 24), 3,565 to 3,595 blocks apart; the seven from #182,605
 * to #204,108 came 3,578 to 3,591 blocks apart (Oct 26).
 */
export const V3_SET_CHANGE_TIMES = ["01:54:06", "07:54:06", "13:54:06", "19:54:06"] as const;

/** When V3 next changes its validator set, by its schedule (ms since the epoch). */
export function nextV3SetChange(now = Date.now()): number {
  const day = Math.floor(now / 86_400_000) * 86_400_000;
  for (let d = 0; d < 2; d++) {
    for (const t of V3_SET_CHANGE_TIMES) {
      const [h, m, s] = t.split(":").map(Number);
      const at = day + d * 86_400_000 + ((h ?? 0) * 3600 + (m ?? 0) * 60 + (s ?? 0)) * 1000;
      if (at > now) return at;
    }
  }
  throw new Error("unreachable: a set change comes every 6 hours");
}

/**
 * Where to ask grandpa_proveFinality for the change that ends a set: this many blocks after the
 * block that started it. A set lasts 3,565 to 3,595 blocks on V3, so the answer is the set's own
 * change with about 70 to 100 unknown headers (45 KB), not the next set's.
 */
export const SET_CHANGE_GUESS = 3_500;

/** The V3 node answered with something that does not check out: a header that does not hash to its block, a proof for another block. */
export class V3Error extends Error {
  override name = "V3Error";
}

/** V3 moved on while it was read (finality kept moving, the node is behind the light client): read again in a few seconds. */
export class V3Moved extends Error {
  override name = "V3Moved";
}

/** A set change the light client cannot follow: importing it would halt the client, which then needs its admin. */
export class HaltingChange extends Error {
  override name = "HaltingChange";
  readonly block: number;

  constructor(block: number, reason: string) {
    super(`V3 block #${formatInt(block)} carries ${reason}: importing it would halt the light client`);
    this.block = block;
  }
}

export interface Block {
  number: number;
  hash: Hex;
}

export interface V3Head extends Block {
  header: Header;
  /** Grandpa.CurrentSetId in the head's state: the set that signs the blocks after it. */
  setId: bigint;
}

/** A finality proof the light client takes: for `block` itself, with no unknown headers. */
export interface CleanProof {
  block: Block;
  header: Header;
  /** grandpa_proveFinality's bytes, as importFinalityProof takes them. */
  scale: Uint8Array;
  justification: Justification;
}

/** One validator-set change the light client has not imported, and what importing it takes. */
export interface SetChange extends Block {
  header: Header;
  /** The justification V3 stores for it, as importHeader takes it. */
  justification: Uint8Array;
  /** The set that signs it, which the client is in when it imports it, and that set's keys. */
  setId: bigint;
  keys: Uint8Array[];
  signers: SignersHint;
  /** The keys of set setId + 1, from its ScheduledChange. */
  next: Uint8Array[];
  /** The block grandpa_proveFinality was asked at, and the headers its answer carried. */
  asked: number;
  unknownHeaders: number;
}

/** The lock's two proofs at one block, each walked here from that block's state root. */
export interface LockProofs {
  childRootProof: Uint8Array[];
  slotProof: Uint8Array[];
  /** The proven root of the vault's child trie. */
  childRoot: Uint8Array;
  /** The proven word at commitments[nonce]. */
  value: Uint8Array;
}

export class V3Reader {
  readonly node: SubstrateClient;

  constructor(node: SubstrateClient) {
    this.node = node;
  }

  private async call<T>(method: string, params: unknown[], timeoutMs = 15_000): Promise<T> {
    return (await this.node.request<T>(method, params, timeoutMs)).result;
  }

  /** chain_getHeader, re-encoded to SCALE; refused unless its blake2_256 is the block hash. */
  async header(hash: Hex): Promise<Header> {
    const json = await this.call<RpcHeader | null>("chain_getHeader", [hash]);
    if (!json) throw new V3Error(`the V3 node has no header ${hash}`);
    const header = decodeHeader(encodeRpcHeader(json));
    const computed = bytesToHex(blake2b256(header.encoded));
    if (computed !== hash.toLowerCase()) throw new V3Error(`the V3 node's header ${hash} hashes to ${computed}`);
    return header;
  }

  async blockHash(n: number): Promise<Hex> {
    const hash = await this.call<Hex | null>("chain_getBlockHash", [n]);
    if (!hash) throw new V3Error(`the V3 node has no block #${formatInt(n)}`);
    return hash.toLowerCase() as Hex;
  }

  /** Grandpa.CurrentSetId at a block: after a set change's block, the new set's id. */
  async setIdAt(hash: Hex): Promise<bigint> {
    const value = await this.call<Hex | null>("state_getStorage", [GRANDPA_SET_ID_KEY, hash]);
    if (!value) throw new V3Error(`Grandpa.CurrentSetId is empty at ${hash}`);
    return decodeU64(hexToBytes(value), "Grandpa.CurrentSetId");
  }

  /** The finalized head, its header and the set id in its state. */
  async finalizedHead(): Promise<V3Head> {
    const hash = (await this.call<Hex>("chain_getFinalizedHead", [])).toLowerCase() as Hex;
    const [header, setId] = await Promise.all([this.header(hash), this.setIdAt(hash)]);
    return { number: header.number, hash, header, setId };
  }

  /** grandpa_proveFinality(n), decoded; null when the node has no proof to give. */
  async proveFinality(n: number): Promise<{ scale: Uint8Array; block: Uint8Array; justification: Uint8Array; unknownHeaders: Header[] } | null> {
    const hex = await this.call<Hex | null>("grandpa_proveFinality", [n], 20_000);
    if (!hex) return null;
    const scale = hexToBytes(hex);
    return { scale, ...decodeFinalityProof(scale) };
  }

  /**
   * A finality proof for a finalized block from `n` on, with no unknown headers: a proof for a later
   * block carries the headers in between, which the client refuses (UnknownHeadersNotEmpty), so it is
   * asked again at that block (relay.ts and mint.ts do the same, three tries).
   */
  async cleanProof(n: number): Promise<CleanProof> {
    let ask = n;
    for (let attempt = 1; ; attempt++) {
      const p = await this.proveFinality(ask);
      if (!p) throw new V3Error(`grandpa_proveFinality(${ask}) gave no proof`);
      const j = decodeJustification(p.justification);
      if (p.unknownHeaders.length === 0) {
        if (!equalBytes(p.block, j.targetHash)) throw new V3Error("the finality proof is not for the block its justification targets");
        const hash = bytesToHex(p.block);
        const header = await this.header(hash);
        if (header.number !== j.targetNumber) throw new V3Error(`the justification targets #${formatInt(j.targetNumber)}, its block is #${formatInt(header.number)}`);
        return { block: { number: header.number, hash }, header, scale: p.scale, justification: j };
      }
      if (attempt === 3) throw new V3Moved(`the finality proof still carries ${p.unknownHeaders.length} unknown headers after ${attempt} tries`);
      ask = j.targetNumber;
    }
  }

  /** state_getReadProof of one key at a block. */
  async readProof(key: Uint8Array, at: Hex): Promise<Uint8Array[]> {
    const r = await this.call<{ proof: Hex[] }>("state_getReadProof", [[bytesToHex(key)], at]);
    return r.proof.map((n) => hexToBytes(n));
  }

  /** state_getChildReadProof of one key of a child trie at a block. */
  async childReadProof(childKey: Uint8Array, key: Uint8Array, at: Hex): Promise<Uint8Array[]> {
    const r = await this.call<{ proof: Hex[] }>("state_getChildReadProof", [bytesToHex(childKey), [bytesToHex(key)], at]);
    return r.proof.map((n) => hexToBytes(n));
  }

  /**
   * commitments[nonce] in the vault's child trie at `at`: the main-trie proof of the child root and
   * the child-trie proof of the slot, read together, each walked from its root here.
   */
  async lockProofs(at: Block, stateRoot: Uint8Array, trieId: Uint8Array, nonce: bigint): Promise<LockProofs> {
    const rootKey = childRootKey(trieId);
    const slotKey = commitmentKey(nonce);
    const [rootNodes, served] = await Promise.all([this.readProof(rootKey, at.hash), this.childReadProof(rootKey, slotKey, at.hash)]);
    const childRoot = provenValue(stateRoot, rootNodes, rootKey, "child-root");
    if (childRoot.length !== 32 || childRoot.every((b) => b === 0)) throw new V3Error(`the vault's child root is not 32 non-zero bytes at #${formatInt(at.number)}`);
    const slotNodes = childItems(served, rootNodes);
    const value = provenValue(childRoot, slotNodes, slotKey, `commitments[${nonce}]`);
    return { childRootProof: rootNodes, slotProof: slotNodes, childRoot, value };
  }

  /**
   * The `count` set changes after `from`, in order, without scanning headers: for a block m in a set
   * that has ended, grandpa_proveFinality(m) answers with the justification of that set's last
   * block, its set change, and carries the headers up to it, the change's own header last. m is
   * guessed SET_CHANGE_GUESS blocks after the set's start, but never past `head`; an answer to the
   * guess that is not the change of the expected set (its justification does not verify under that
   * set, its block changes no set, or the node refuses the ask) is asked again at the first block
   * after `from`, which is in that set for sure.
   *   from: the client's latest header, its set (id and keys) and the block that started that set
   *   (null when the client does not say: then every change is asked at the first block after the last).
   *   head: V3's finalized head; the node refuses to prove a block past it ("Block not yet finalized").
   */
  async setChanges(
    from: { number: number; setId: bigint; keys: Uint8Array[]; activatedAt: number | null },
    count: number,
    crypto: ClientCrypto,
    head = Number.MAX_SAFE_INTEGER,
  ): Promise<SetChange[]> {
    const out: SetChange[] = [];
    let after = from.number;
    let started = from.activatedAt;
    let setId = from.setId;
    let keys = from.keys;
    for (let k = 0; k < count; k++) {
      const first = after + 1;
      // A set that began at a checkpoint, or ran short, can end before the guess: the head bounds it.
      const guess = started === null ? first : Math.max(first, Math.min(head, started + SET_CHANGE_GUESS));
      let found: SetChange | null = null;
      const problems: string[] = [];
      for (const ask of guess === first ? [first] : [guess, first]) {
        try {
          found = await this.setChangeAt(ask, after, setId, keys, crypto);
          break;
        } catch (error) {
          // Whatever the guess gets, a refusal included, `first` is asked next and its answer counts;
          // a change the client cannot follow is the change, wherever it was found.
          const noChange = error instanceof SignatureError || error instanceof V3Error || error instanceof ScaleError;
          if (error instanceof HaltingChange || (ask === first && !noChange)) throw error;
          problems.push(`#${formatInt(ask)}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (!found) throw new V3Error(`no set change of set ${setId} found after #${formatInt(after)}: ${problems.join("; ")}`);
      out.push(found);
      after = found.number;
      started = found.number;
      setId += 1n;
      keys = found.next;
    }
    return out;
  }

  /** The change grandpa_proveFinality(ask) proves, if it is the change that ends set `setId` after block `after`. */
  private async setChangeAt(ask: number, after: number, setId: bigint, keys: Uint8Array[], crypto: ClientCrypto): Promise<SetChange> {
    const p = await this.proveFinality(ask);
    if (!p) throw new V3Error("no proof");
    const j = decodeJustification(p.justification);
    if (!equalBytes(p.block, j.targetHash)) throw new V3Error("the proof's block is not its justification's target");
    const hash = bytesToHex(p.block);
    const last = p.unknownHeaders.at(-1);
    // The answer's last unknown header is the proven block; with none, the block is the one asked.
    const header = last ?? (await this.header(hash));
    if (bytesToHex(blake2b256(header.encoded)) !== hash) throw new V3Error(`the proof's last header does not hash to its block ${hash}`);
    if (header.number !== j.targetNumber) throw new V3Error(`the justification targets #${formatInt(j.targetNumber)}, the header is #${formatInt(header.number)}`);
    if (header.number <= after) throw new V3Error(`the proof is for #${formatInt(header.number)}, not after #${formatInt(after)}`);
    // Signed by set `setId`: the change that ends it, or (asked too late) a block of a later set, refused here.
    const signers = signersHint(j, keys, setId, crypto.verify);
    const change = authorityChange(header, crypto);
    if (change.kind === "none") throw new V3Error(`#${formatInt(header.number)} changes no set: the set is still in force`);
    if (change.kind === "halts") throw new HaltingChange(header.number, change.reason);
    return { number: header.number, hash, header, justification: p.justification, setId, keys, signers, next: change.next, asked: ask, unknownHeaders: p.unknownHeaders.length };
  }
}
