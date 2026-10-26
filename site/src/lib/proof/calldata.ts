// The calldata of the transactions a mint sends: BridgeMinter.importAndMint and mint(p), the light
// client's importHeader, and Multicall3.aggregate3 around them for a self-relay. An ABI encoder for
// the argument shapes these take (words, bytes, arrays, tuples), ported from relayer/src/bridge.ts;
// ../abi.ts decodes.

import { decode, type AbiValue } from "../abi.ts";
import { SIG } from "../calls.ts";
import { selector } from "../hashes.ts";
import { concatBytes, hexToBytes, type Hex } from "../hex.ts";

/** One ABI argument: a static 32-byte word, bytes, an array (T[]) or a tuple (a struct). */
export type Arg = { word: Uint8Array } | { bytes: Uint8Array } | { array: Arg[] } | { tuple: Arg[] };

export function uintWord(n: bigint): Uint8Array {
  if (n < 0n || n >> 256n) throw new RangeError(`not a uint256: ${n}`);
  return hexToBytes(`0x${n.toString(16).padStart(64, "0")}`);
}

export function addressWord(address: Uint8Array | string): Uint8Array {
  const a = typeof address === "string" ? hexToBytes(address) : address;
  if (a.length !== 20) throw new RangeError(`an address is 20 bytes, got ${a.length}`);
  return concatBytes(new Uint8Array(12), a);
}

/** bytes[]: an array of bytes. */
export const list = (items: Uint8Array[]): Arg => ({ array: items.map((bytes) => ({ bytes })) });

const isDynamic = (a: Arg): boolean => "bytes" in a || "array" in a || ("tuple" in a && a.tuple.some(isDynamic));
const padRight = (b: Uint8Array): Uint8Array => concatBytes(b, new Uint8Array((32 - (b.length % 32)) % 32));

function encodeStatic(a: Arg): Uint8Array {
  if ("word" in a) {
    if (a.word.length !== 32) throw new RangeError(`a word is 32 bytes, got ${a.word.length}`);
    return a.word;
  }
  if ("tuple" in a) return abiEncode(a.tuple);
  throw new TypeError("not a static argument");
}

function encodeTail(a: Arg): Uint8Array {
  if ("bytes" in a) return concatBytes(uintWord(BigInt(a.bytes.length)), padRight(a.bytes));
  if ("array" in a) return concatBytes(uintWord(BigInt(a.array.length)), abiEncode(a.array));
  if ("tuple" in a) return abiEncode(a.tuple);
  throw new TypeError("not a dynamic argument");
}

/** Head and tail encoding of an argument list: abi.encode of a function's arguments, of a struct or of an array's items. */
export function abiEncode(args: Arg[]): Uint8Array {
  const heads: Uint8Array[] = [];
  const tails: Uint8Array[] = [];
  let offset = args.reduce((n, a) => n + (isDynamic(a) ? 32 : encodeStatic(a).length), 0);
  for (const a of args) {
    if (!isDynamic(a)) {
      heads.push(encodeStatic(a));
      continue;
    }
    const tail = encodeTail(a);
    heads.push(uintWord(BigInt(offset)));
    tails.push(tail);
    offset += tail.length;
  }
  return concatBytes(...heads, ...tails);
}

const call = (signature: string, args: Arg[]): Uint8Array => concatBytes(hexToBytes(selector(signature)), abiEncode(args));

// ---------------------------------------------------------------------------------------------
// BridgeMinter and the light client

export const MINT_SIG = "mint((bytes32,bytes[],bytes[],bytes[],address,uint256,uint256))";

/** BridgeMinter.LockProof: the block the proofs are against, the three proofs and the lock's fields. */
export interface LockProof {
  blockHash: Uint8Array;
  /** Revive.AccountInfoOf(vault): read only while the minter is not bound, else empty. */
  accountProof: Uint8Array[];
  childRootProof: Uint8Array[];
  slotProof: Uint8Array[];
  recipient: Uint8Array;
  /** Native base units of tPOT, which are wtPOT units. */
  amount: bigint;
  nonce: bigint;
}

const lockProofArg = (p: LockProof): Arg => {
  if (p.blockHash.length !== 32) throw new RangeError(`a block hash is 32 bytes, got ${p.blockHash.length}`);
  return {
    tuple: [{ word: p.blockHash }, list(p.accountProof), list(p.childRootProof), list(p.slotProof), { word: addressWord(p.recipient) }, { word: uintWord(p.amount) }, { word: uintWord(p.nonce) }],
  };
};

/** BridgeMinter.importAndMint(header, finalityProof, signers, p): the import, the bind while unbound, the mint. */
export const importAndMintCalldata = (header: Uint8Array, finalityProof: Uint8Array, signers: Uint8Array, p: LockProof): Uint8Array =>
  call(SIG.importAndMint, [{ bytes: header }, { bytes: finalityProof }, { bytes: signers }, lockProofArg(p)]);

/** BridgeMinter.mint(p), against a block the light client holds already. */
export const mintCalldata = (p: LockProof): Uint8Array => call(MINT_SIG, [lockProofArg(p)]);

/** GrandpaLightClient.importHeader(header, justification, signers): how a set change is imported. */
export const importHeaderCalldata = (header: Uint8Array, justification: Uint8Array, signers: Uint8Array): Uint8Array =>
  call(SIG.importHeader, [{ bytes: header }, { bytes: justification }, { bytes: signers }]);

// ---------------------------------------------------------------------------------------------
// Multicall3

/**
 * Multicall3, at this address on Sepolia as on most chains (github.com/mds1/multicall). Neither the
 * light client nor the minter looks at msg.sender, so a self-relay goes through it: the imports and
 * the mint in one transaction.
 */
export const MULTICALL3: Hex = "0xcA11bde05977b3631167028862bE2a173976CA11";
/** keccak-256 of Multicall3's 3,808 bytes of code on Sepolia, checked before a plan sends through it. */
export const MULTICALL3_CODE_HASH: Hex = "0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891";
export const AGGREGATE3_SIG = "aggregate3((address,bool,bytes)[])";

export interface Call3 {
  target: string;
  /** False in a plan: one failed call reverts the whole transaction, so it does all or nothing. */
  allowFailure: boolean;
  callData: Uint8Array;
}

export const aggregate3Calldata = (calls: Call3[]): Uint8Array =>
  call(AGGREGATE3_SIG, [{ array: calls.map((c) => ({ tuple: [{ word: addressWord(c.target) }, { word: uintWord(c.allowFailure ? 1n : 0n) }, { bytes: c.callData }] })) }]);

/** aggregate3's return value, Result[] = (bool success, bytes returnData)[]: each call's outcome, a revert's data when it failed. */
export function decodeAggregate3(returnData: string): { success: boolean; returnData: Hex }[] {
  const [results] = decode("(bool,bytes)[]", returnData);
  return (results as AbiValue[][]).map(([success, data]) => ({ success: success === true, returnData: data as Hex }));
}
