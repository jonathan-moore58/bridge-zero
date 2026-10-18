// SPDX-License-Identifier: UNLICENSED
//
// Types of what relayer/src/relay.ts imports from sepolia.mjs (the TypeScript relayer shares the
// Sepolia send flow with script/deploy-sepolia.mjs). Keep them in step with sepolia.mjs.

type Hex = `0x${string}`;

export const RPC: string;
export const CAP: number;
export const SEPOLIA_CHAIN_ID: bigint;
export const REQUEST_GAS: number;
export const RECEIPT_TIMEOUT: number;

export function keccak256(bytes: Uint8Array): Uint8Array;
export function concat(...parts: Uint8Array[]): Uint8Array;
export function word(n: bigint | number): Uint8Array;

/** One ABI parameter: a static 32-byte word, bytes, bytes32[] (words) or bytes[] (list). */
export type AbiParam = { word: Uint8Array } | { bytes: Uint8Array } | { words: Uint8Array[] } | { list: Uint8Array[] };
export function encode(params: AbiParam[]): Uint8Array;

export function rpc<T = unknown>(method: string, params: unknown[]): Promise<T>;
export function fmt(n: number | bigint): string;
export function share(used: number): string;
export function qty(n: number | bigint): string;
export function gasOf(r: { gasUsed: string }): number;
export function withHeadroom(used: number): number;
export function sleep(ms: number): Promise<void>;
export function eth(wei: bigint): string;
export function topic(signature: string): Hex;

export interface Log {
  address: string;
  topics: string[];
  data: string;
}
export function findLog(logs: Log[] | undefined, address: string, t: string, first?: string): Log | undefined;
export function dataWord(log: Log, i: number): bigint;

export const PROBE: string;
export const PROBE_SENDER: string;
export const PROBE_CODE: string;
export const PROBE_GAS: number;

export interface Fees {
  base: bigint;
  tip: bigint;
  maxFee: bigint;
  gasPrice: bigint;
}
export function parseGwei(s: string): bigint;
export function feesAt(block: { number: string }, options?: { priorityFee?: bigint; maxFee?: bigint }): Promise<Fees>;

export function redactAlso(...values: (string | undefined)[]): void;
export function redact(text: unknown): string;
export function retry<T>(what: string, fn: () => Promise<T>): Promise<T>;
export function nonces(address: string): Promise<{ latest: number; pending: number }>;
export function nextNonceIs(address: string, nonce: number): Promise<boolean>;

export interface Receipt {
  status: string;
  blockNumber: string;
  gasUsed: string;
  effectiveGasPrice?: string;
  transactionHash: Hex;
  logs: Log[];
}
export function receiptOf(hash: string, wait: boolean): Promise<Receipt | null>;

export function keystoreAddress(account: string, passwordFile: string): string | null;
export function signerIs(address: string, account: string, passwordFile: string): boolean;
export function mktxArgs(
  name: string,
  tx: { to: string | null; data: string; nonce: number; gasLimit: number; fees: Fees; account: string; passwordFile: string },
): string[];
export function signAndPublish(args: string[], label: string, signed: (hash: Hex) => void): Hex | null;
export function writeJsonAtomic(path: string, value: unknown): void;
