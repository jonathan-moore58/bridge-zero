// The lock as a Substrate extrinsic: Revive.call(vault, value, weight_limit, storage_deposit_limit,
// lock(11155111, BridgeMinter, recipient)), as V3's metadata defines it (pallet 80, call 1). The
// page encodes the call here byte by byte too, and refuses unless the call @polkadot/api built and
// the call the wallet is asked to sign are this one. Also: the dry run as reviveApi.call answers it
// (its JSON form; V3's result type is newer than the library's static types, as the relayer reads
// it), the limits the relayer sets from it, and what the wallet's payload has to say. Kept apart
// from the library and the build's records so that node --test runs it.

import { encodeCall } from "../../lib/abi.ts";
import { bytesToHex, concatBytes, hexToBytes, type Hex } from "../../lib/hex.ts";

export { V3_GENESIS } from "./account.ts";

/** Portaldot V3 testnet (docs/V3.md): the chain id of pallet-revive and of the EVM RPC. */
export const V3_CHAIN = 420_420_777n;

/** Revive.call: pallet 80, call 1 (V3's metadata, spec 3002). */
export const REVIVE_CALL: Hex = "0x5001";

/** tPOT on the Substrate side: 14 decimals. revive.call's value is in these units; the vault sees it times 10,000 (NativeToEthRatio). */
export const NATIVE_DECIMALS = 14;

/** The extrinsic's mortal era: 64 blocks, about 6.4 minutes of V3's 6 s blocks. */
export const ERA_PERIOD = 64;

/** SCALE's compact encoding of an unsigned integer. */
export function compact(n: bigint): Uint8Array {
  if (n < 0n) throw new RangeError("compact of a negative number");
  if (n < 1n << 6n) return Uint8Array.of(Number(n << 2n));
  if (n < 1n << 14n) {
    const v = Number((n << 2n) | 1n);
    return Uint8Array.of(v & 0xff, v >> 8);
  }
  if (n < 1n << 30n) {
    const v = (n << 2n) | 2n;
    return Uint8Array.of(Number(v & 0xffn), Number((v >> 8n) & 0xffn), Number((v >> 16n) & 0xffn), Number((v >> 24n) & 0xffn));
  }
  const bytes: number[] = [];
  for (let x = n; x > 0n; x >>= 8n) bytes.push(Number(x & 0xffn));
  if (bytes.length > 67) throw new RangeError("compact of a number over 536 bits");
  return Uint8Array.from([((bytes.length - 4) << 2) | 3, ...bytes]);
}

/** lock(uint256 dstChainId, address dstMinter, address recipient): 0xecd1eb6c and three words, 100 bytes. */
export const lockData = (dstChainId: bigint, minter: Hex, recipient: Hex): Hex => encodeCall("lock(uint256,address,address)", [dstChainId, minter, recipient]);

/** What a lock's revive.call carries. Amounts in native units (14 decimals). */
export interface LockCall {
  vault: Hex;
  value: bigint;
  refTime: bigint;
  proofSize: bigint;
  depositLimit: bigint;
  data: Hex;
}

/** Revive.call(dest: H160, value: Compact<u128>, weight_limit: {Compact<u64>, Compact<u64>}, storage_deposit_limit: Compact<u128>, data: Vec<u8>). */
export function reviveCall(c: LockCall): Hex {
  const dest = hexToBytes(c.vault);
  const data = hexToBytes(c.data);
  if (dest.length !== 20) throw new RangeError("the vault's address is 20 bytes");
  return bytesToHex(concatBytes(hexToBytes(REVIVE_CALL), dest, compact(c.value), compact(c.refTime), compact(c.proofSize), compact(c.depositLimit), compact(BigInt(data.length)), data));
}

// ---------------------------------------------------------------------------------------------
// The dry run: reviveApi.call(origin, dest, value, None, None, data), read in its JSON form

/** A module error: the pallet's index and the error's first byte, which the library names. */
export interface ModuleError {
  index: number;
  error: number;
}

export interface DryRun {
  /** The call ran (it may still have reverted: `reverted`). */
  ok: boolean;
  reverted: boolean;
  /** What lock() returned: the nonce the lock would take, unless another lock takes it first. */
  returns: bigint | null;
  /** What it returned, raw: the revert's data when it reverted. */
  data: Hex;
  /** Why it did not run: a module error, or the error's JSON. */
  error: ModuleError | string | null;
  refTime: bigint;
  proofSize: bigint;
  /** The storage deposit the call charges (negative: refunds), and the most it may charge. */
  deposit: bigint;
  maxDeposit: bigint;
}

type Json = Record<string, unknown>;
const isObj = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x);
const big = (x: unknown): bigint => (typeof x === "number" || (typeof x === "string" && /^(0x[0-9a-fA-F]+|\d+)$/.test(x)) ? BigInt(x) : 0n);

/** A storage deposit as the JSON gives it: { charge: n } or { refund: n }. */
function depositOf(x: unknown): bigint {
  if (!isObj(x)) return 0n;
  if (x.charge !== undefined) return big(x.charge);
  if (x.refund !== undefined) return -big(x.refund);
  return 0n;
}

/** reviveApi.call's answer, from its JSON form: { weightRequired, storageDeposit, maxStorageDeposit, result: { ok: { flags, data } } | { err } }. */
export function readDryRun(json: unknown): DryRun {
  if (!isObj(json) || !isObj(json.weightRequired) || !isObj(json.result)) throw new Error(`reviveApi.call answered in an unexpected form: ${JSON.stringify(json).slice(0, 200)}`);
  const w = json.weightRequired;
  const result = json.result;
  const deposit = depositOf(json.storageDeposit);
  const base = { refTime: big(w.refTime), proofSize: big(w.proofSize), deposit, maxDeposit: json.maxStorageDeposit === undefined ? deposit : depositOf(json.maxStorageDeposit) };
  if (isObj(result.ok)) {
    const flags = isObj(result.ok.flags) ? Number(result.ok.flags.bits ?? 0) : Number(result.ok.flags ?? 0);
    const data = typeof result.ok.data === "string" && /^0x([0-9a-fA-F]{2})*$/.test(result.ok.data) ? (result.ok.data.toLowerCase() as Hex) : "0x";
    const reverted = (flags & 1) === 1;
    const returns = !reverted && /^0x[0-9a-fA-F]{64}$/.test(data) ? BigInt(data) : null;
    return { ok: true, reverted, returns, data, error: null, ...base };
  }
  const err = result.err;
  const module = isObj(err) && isObj(err.module) ? err.module : null;
  if (module && typeof module.index === "number" && typeof module.error === "string" && /^0x[0-9a-fA-F]{2}/.test(module.error)) {
    return { ok: false, reverted: false, returns: null, data: "0x", error: { index: module.index, error: parseInt(module.error.slice(2, 4), 16) }, ...base };
  }
  return { ok: false, reverted: false, returns: null, data: "0x", error: JSON.stringify(err ?? null), ...base };
}

/** The relayer's limits (relayer/src/v3-vault.ts): the weight the dry run required plus 10%, the most it may charge in deposit plus 2%. */
export function limitsOf(d: DryRun): { refTime: bigint; proofSize: bigint; depositLimit: bigint } {
  const dep = d.maxDeposit > d.deposit ? d.maxDeposit : d.deposit;
  const charge = dep > 0n ? dep : 0n;
  return { refTime: d.refTime + d.refTime / 10n, proofSize: d.proofSize + d.proofSize / 10n, depositLimit: charge + charge / 50n };
}

// ---------------------------------------------------------------------------------------------
// The payload the wallet signs

/** The SignerPayloadJSON polkadot{.js}-style wallets take (the fields this page checks). */
export interface PayloadJson {
  address: string;
  blockHash: string;
  blockNumber: string;
  era: string;
  genesisHash: string;
  method: string;
  nonce: string;
  specVersion: string;
  tip: string;
  transactionVersion: string;
  signedExtensions: string[];
  version: number;
  withSignedTransaction?: boolean;
  mode?: number;
  metadataHash?: string | null;
  assetId?: string | null;
}

/** What the page expects the wallet to be asked: the account, the call, the chain. */
export interface PayloadExpect {
  address: string;
  call: Hex;
  genesis: Hex;
}

/**
 * Whether the payload @polkadot/api built for the wallet is the lock the page checked: from the
 * account, this exact call, on V3, mortal, no tip, and the wallet allowed to add what it must
 * (a metadata hash) as long as the call stays. Null when it is; else what differs.
 */
export function payloadProblem(p: PayloadJson, e: PayloadExpect): string | null {
  if (p.address !== e.address) return `it names ${p.address}, not ${e.address}`;
  if (p.method.toLowerCase() !== e.call.toLowerCase()) return "its call is not the lock this page checked";
  if (p.genesisHash.toLowerCase() !== e.genesis.toLowerCase()) return "it is for another chain than Portaldot V3";
  if (!/^0x[0-9a-fA-F]{4}$/.test(p.era)) return "its era is not a mortal one";
  if (BigInt(p.tip) !== 0n) return "it carries a tip";
  if (!/^0x[0-9a-fA-F]+$/.test(p.nonce) || !/^0x[0-9a-fA-F]+$/.test(p.blockNumber)) return "its nonce or block does not read";
  return null;
}

/** The first and the last block a mortal era (as its two-byte form says) lets the extrinsic in, from the block it was made at. */
export function eraWindow(era: string, blockNumber: number): { from: number; to: number } {
  const b = hexToBytes(era);
  if (b.length !== 2) throw new RangeError("an immortal or unknown era");
  const enc = (b[0] ?? 0) + ((b[1] ?? 0) << 8);
  const period = 2 ** ((enc % 16) + 1);
  const quantize = Math.max(period >> 12, 1);
  const phase = (enc >> 4) * quantize;
  const birth = Math.floor((Math.max(blockNumber, phase) - phase) / period) * period + phase;
  return { from: birth, to: birth + period - 1 };
}
