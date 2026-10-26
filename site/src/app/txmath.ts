// The arithmetic of the app's transactions, kept apart from the build's records so that node --test
// runs it: an amount typed in the bridge's field as exact base units, the gas and fee policies the
// sends follow, and what a lock's or a burn's receipt says, checked here before the page trusts it.

import type { AbiRegistry, AbiValue } from "../lib/abi.ts";
import type { Hex } from "../lib/hex.ts";
import { burnId, lockCommitment } from "../lib/proofs.ts";

/** tPOT and wtPOT: 14 decimals. */
export const DECIMALS = 14;
/** V3's EVM side counts tPOT in 18 decimals: msg.value is the base units times this (NativeToEthRatio, docs/V3.md). */
export const EVM_PER_NATIVE = 10_000n;

/**
 * "1.5" as base units, exactly: digits with at most one point and at most 14 decimals. Null for
 * anything else and for 0. Never parseFloat: 0.1 + 0.2 is not what a lock may carry.
 */
export function parseAmount(text: string, decimals = DECIMALS): bigint | null {
  const m = /^(\d*)(?:\.(\d*))?$/.exec(text.trim());
  if (!m) return null;
  const whole = m[1] ?? "";
  const frac = m[2] ?? "";
  if (!whole && !frac) return null;
  if (frac.length > decimals) return null;
  const units = BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
  return units > 0n ? units : null;
}

/** The lock's msg.value: whole native base units, so the vault never sees dust (DustNotAllowed). */
export const evmValue = (units: bigint): bigint => units * EVM_PER_NATIVE;

/** The relayer's margin on every gas limit: the estimate plus 10%. */
export const withMargin = (gas: bigint): bigint => gas + gas / 10n;

export interface Fees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/**
 * V3: eth_gasPrice is the base fee and the priority fee is 0; the max fee is one eighth above it,
 * as relayer/src/v3-vault.ts sent lock 1. eth_estimateGas there includes the storage deposit, so
 * a base fee that falls before inclusion needs more gas: the eighth and the 10% cover that.
 */
export const v3Fees = (gasPrice: bigint): Fees => ({ maxFeePerGas: gasPrice + gasPrice / 8n, maxPriorityFeePerGas: 0n });

/**
 * The least priority fee the page offers on Sepolia: the relayer's 1,000 wei, which Sepolia mined in
 * the next block (the research of Oct 24). Public nodes have suggested as little as 3 wei.
 */
export const SEPOLIA_MIN_TIP = 1_000n;

/** Sepolia: the node's priority fee (at least SEPOLIA_MIN_TIP), and a max fee of twice the base fee plus it, so a base fee that doubles still includes it. */
export function sepoliaFees(baseFee: bigint, priority: bigint): Fees {
  const tip = priority > SEPOLIA_MIN_TIP ? priority : SEPOLIA_MIN_TIP;
  return { maxFeePerGas: 2n * baseFee + tip, maxPriorityFeePerGas: tip };
}

/** What a wallet checks before it sends: the value, and the gas limit at the max fee. */
export const upFront = (value: bigint, gas: bigint, fees: Fees): bigint => value + gas * fees.maxFeePerGas;

/**
 * An address a key controls on Sepolia: no code, or an EIP-7702 delegation (0xef0100 and an
 * address, 23 bytes). The committee pays a burn's sender on V3 only then (relayer/src/committee.ts,
 * payeeVerdict): a contract's address on Sepolia is no key's on V3.
 */
export function keyControlled(code: string): boolean {
  const c = code.toLowerCase();
  return c === "0x" || /^0xef0100[0-9a-f]{40}$/.test(c);
}

/** Gas as the transfer screen says it: "2.5 M", "0.6 M", "61 k". */
export function gasText(gas: number | bigint): string {
  const g = Number(gas);
  if (g >= 1e6) return `${(Math.round(g / 1e5) / 10).toLocaleString("en-US")} M`;
  return `${Math.max(1, Math.round(g / 1e3)).toLocaleString("en-US")} k`;
}

// ---------------------------------------------------------------------------------------------
// Receipts

export interface ReceiptLog {
  address: string;
  topics: readonly string[];
  data: string;
}

type Checked<T> = ({ ok: true } & T) | { ok: false; why: string };

const argOf = (args: { name: string; value: AbiValue }[], name: string): AbiValue | undefined => args.find((a) => a.name === name)?.value;
const sameAddress = (a: AbiValue | undefined, b: string): boolean => typeof a === "string" && a.toLowerCase() === b.toLowerCase();

/** What the lock's receipt has to show: this vault, this bridge's minter and chains, and the sender's own amount and recipient. */
export interface LockExpect {
  vault: string;
  v3ChainId: bigint;
  sepoliaChainId: bigint;
  minter: string;
  sender: string;
  amount: bigint;
}

/**
 * The vault's Locked log in a lock's receipt, checked field by field, its commitment recomputed
 * here as BridgeMinter will recompute it. The nonce comes from the log, never from a prediction:
 * another lock can take the predicted nonce first.
 */
export function lockedOf(logs: readonly ReceiptLog[], registry: AbiRegistry, e: LockExpect): Checked<{ nonce: bigint; commitment: Hex }> {
  for (const log of logs) {
    if (log.address.toLowerCase() !== e.vault.toLowerCase()) continue;
    const d = registry.decodeLog({ address: log.address, topics: [...log.topics], data: log.data });
    if (d?.name !== "Locked") continue;
    const nonce = argOf(d.args, "nonce");
    const amount = argOf(d.args, "amountNative");
    const commitment = argOf(d.args, "commitment");
    if (typeof nonce !== "bigint" || typeof amount !== "bigint" || typeof commitment !== "string") return { ok: false, why: "the Locked log does not decode" };
    if (argOf(d.args, "dstChainId") !== e.sepoliaChainId || !sameAddress(argOf(d.args, "dstMinter"), e.minter)) return { ok: false, why: "the lock names another chain or minter" };
    if (!sameAddress(argOf(d.args, "sender"), e.sender) || !sameAddress(argOf(d.args, "recipient"), e.sender)) return { ok: false, why: "the lock's sender or recipient is not your address" };
    if (amount !== e.amount) return { ok: false, why: `the vault locked ${amount} base units, not ${e.amount}` };
    const expected = lockCommitment({ v3ChainId: e.v3ChainId, vault: e.vault, dstChainId: e.sepoliaChainId, minter: e.minter, recipient: e.sender, amountNative: e.amount, nonce });
    if (expected !== commitment.toLowerCase()) return { ok: false, why: `the vault stored ${commitment}, and this lock's fields give ${expected}` };
    return { ok: true, nonce, commitment: expected };
  }
  return { ok: false, why: "the receipt has no Locked log of the vault" };
}

/** What the burn's receipt has to show: BridgeMinter on Sepolia, the sender's amount, paid to its own address on V3. */
export interface BurnExpect {
  minter: string;
  sepoliaChainId: bigint;
  sender: string;
  amount: bigint;
}

/** BridgeMinter's BurnRequested log in a burn's receipt, its burn id checked against the convention the committee releases by. */
export function burnedOf(logs: readonly ReceiptLog[], registry: AbiRegistry, e: BurnExpect): Checked<{ burnNonce: bigint; burnId: Hex }> {
  for (const log of logs) {
    if (log.address.toLowerCase() !== e.minter.toLowerCase()) continue;
    const d = registry.decodeLog({ address: log.address, topics: [...log.topics], data: log.data });
    if (d?.name !== "BurnRequested") continue;
    const n = argOf(d.args, "burnNonce");
    const amount = argOf(d.args, "amount");
    const id = argOf(d.args, "burnId");
    if (typeof n !== "bigint" || typeof amount !== "bigint" || typeof id !== "string") return { ok: false, why: "the BurnRequested log does not decode" };
    if (!sameAddress(argOf(d.args, "from"), e.sender) || !sameAddress(argOf(d.args, "v3Recipient"), e.sender)) return { ok: false, why: "the burn's sender or V3 recipient is not your address" };
    if (amount !== e.amount) return { ok: false, why: `the minter burned ${amount} base units, not ${e.amount}` };
    const expected = burnId(e.sepoliaChainId, e.minter, n);
    if (expected !== id.toLowerCase()) return { ok: false, why: `the burn id is ${id}, and burn ${n}'s is ${expected}` };
    return { ok: true, burnNonce: n, burnId: expected };
  }
  return { ok: false, why: "the receipt has no BurnRequested log of the minter" };
}

/** BridgeMinter's Minted log for `nonce` in a receipt, and the V3 block it proved the lock in. */
export function mintedIn(logs: readonly ReceiptLog[], registry: AbiRegistry, minter: string, nonce: bigint): { blockHash: Hex } | null {
  for (const log of logs) {
    if (log.address.toLowerCase() !== minter.toLowerCase()) continue;
    const d = registry.decodeLog({ address: log.address, topics: [...log.topics], data: log.data });
    const hash = d?.name === "Minted" && argOf(d.args, "nonce") === nonce ? argOf(d.args, "blockHash") : undefined;
    if (typeof hash === "string") return { blockHash: hash.toLowerCase() as Hex };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The committee's approvals on V3

/**
 * Multisig.Multisigs's keys for the committee's account: twox128("Multisig") ++ twox128("Multisigs")
 * ++ twox64Concat(the account id of 5FTrjz…xPk3, docs/V3.md). Each key under it is one open
 * operation, by its call's hash.
 */
export const COMMITTEE_MULTISIGS: Hex = "0x7474449cca95dc5d0c00e71735a6d17d3cd15a3fd6e04e47bee3922dbfa92c8d956ba63fe3f5b239965d40eafb701a82cb344dc54fd7b89ec8b328c4fcd922b9c728ed782c646af8";

/**
 * An open multisig operation, from its SCALE value: Multisig { when: Timepoint { height: u32,
 * index: u32 }, deposit: u128, depositor: AccountId32, approvals: BoundedVec<AccountId32> }.
 * The call itself is not stored: it is in the opening extrinsic, at `when`.
 */
export function multisigOf(value: Uint8Array): { height: number; index: number; approvals: number } | null {
  if (value.length < 8 + 16 + 32 + 1) return null;
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  const height = view.getUint32(0, true);
  const index = view.getUint32(4, true);
  const at = 8 + 16 + 32;
  const b = value[at] ?? 0;
  // A compact length: one byte (mode 0) or two (mode 1), enough for a 2-of-3 committee's approvals.
  const mode = b & 3;
  const count = mode === 0 ? b >> 2 : mode === 1 ? (b | ((value[at + 1] ?? 0) << 8)) >> 2 : -1;
  const width = mode === 0 ? 1 : 2;
  if (count < 0 || value.length !== at + width + count * 32) return null;
  return { height, index, approvals: count };
}

/** Whether an extrinsic's bytes carry a 32-byte value (the burn id the release call names), at a byte boundary. */
export function carries(extrinsic: string, word: string): boolean {
  const hay = extrinsic.toLowerCase().replace(/^0x/, "");
  const needle = word.toLowerCase().replace(/^0x/, "");
  if (needle.length !== 64) return false;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) if (i % 2 === 0) return true;
  return false;
}
