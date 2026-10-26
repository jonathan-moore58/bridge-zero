// What a mint reads from Sepolia, and its dry runs: the light client's set, keys and latest header,
// the minter's replay guard and trie id, and eth_estimateGas (or eth_simulateV1, for a transaction
// that needs the one before it mined) of what the wallet will send, a revert named by the contracts'
// errors. Read-only: eth_call, eth_estimateGas, eth_simulateV1, eth_getCode, through ../rpc.ts.

import { decode, encodeCall, formatError, type AbiRegistry, type AbiValue, type DecodedError } from "../abi.ts";
import { keccak256 } from "../hashes.ts";
import { bytesToHex, hexToBytes, shortHex, type Hex } from "../hex.ts";
import { AllFailed, NodeError, request, type Endpoint } from "../rpc.ts";
import type { Block } from "./v3.ts";

/** Sepolia's gas cap per transaction (EIP-7825), as ../chains.ts has it. */
export const TX_GAS_CAP = 16_777_216n;

export interface ClientView {
  setId: bigint;
  /** The current set's keys, in the order the signers hint indexes them. */
  keys: Uint8Array[];
  latest: Block;
  paused: boolean;
  halted: boolean;
  /** The block that started the current set (a set change, or the checkpoint); null when the client's last set is not its current one. */
  activatedAt: number | null;
}

export interface MinterView {
  used: boolean;
  /** The vault's trie id the minter is bound to; null while it is not bound. */
  trieId: Uint8Array | null;
}

const call = (endpoints: Endpoint[], to: string, data: string, block: string) => request<Hex>(endpoints, "eth_call", [{ to, data }, block], { timeoutMs: 12_000 });
const one = (data: string, type: string): AbiValue => decode(type, data)[0] as AbiValue;

/** The light client's state, in one batch and then the keys of its set. */
export async function readClient(endpoints: Endpoint[], client: string, block: string): Promise<ClientView> {
  const [setId, latest, paused, halted, count] = await Promise.all([
    call(endpoints, client, encodeCall("currentSetId()"), block),
    call(endpoints, client, encodeCall("latestFinalized()"), block),
    call(endpoints, client, encodeCall("paused()"), block),
    call(endpoints, client, encodeCall("halted()"), block),
    call(endpoints, client, encodeCall("authoritySetCount()"), block),
  ]);
  const id = one(setId.result, "uint64") as bigint;
  const [hash, number] = decode("bytes32,uint32", latest.result) as [Hex, bigint];
  const sets = one(count.result, "uint256") as bigint;
  const [keys, last] = await Promise.all([
    call(endpoints, client, encodeCall("authorities(uint64)", [id]), block),
    call(endpoints, client, encodeCall("authoritySetAt(uint256)", [sets - 1n]), block),
  ]);
  const [set] = decode("(bytes32,bytes32,uint64,uint32),bytes32[]", last.result) as [[Hex, Hex, bigint, bigint]];
  return {
    setId: id,
    keys: (one(keys.result, "bytes32[]") as Hex[]).map((k) => hexToBytes(k)),
    latest: { number: Number(number), hash: hash.toLowerCase() as Hex },
    paused: one(paused.result, "bool") === true,
    halted: one(halted.result, "bool") === true,
    activatedAt: set[2] === id ? Number(set[3]) : null,
  };
}

/** used(nonce) and the vault's trie id on BridgeMinter. */
export async function readMinter(endpoints: Endpoint[], minter: string, nonce: bigint, block: string): Promise<MinterView> {
  const [used, trieId] = await Promise.all([call(endpoints, minter, encodeCall("used(uint256)", [nonce]), block), call(endpoints, minter, encodeCall("vaultTrieId()"), block)]);
  const id = hexToBytes(one(trieId.result, "bytes32") as Hex);
  return { used: one(used.result, "bool") === true, trieId: id.some((b) => b !== 0) ? id : null };
}

/** The minter's vaultCodeHash, which a bind's account proof has to name. */
export async function readVaultCodeHash(endpoints: Endpoint[], minter: string, block: string): Promise<Uint8Array> {
  return hexToBytes(one((await call(endpoints, minter, encodeCall("vaultCodeHash()"), block)).result, "bytes32") as Hex);
}

/** A V3 header the light client holds: its number, its state root, and the set that finalized it (for a checkpoint, the set installed with it). */
export interface HeldHeader {
  number: number;
  stateRoot: Uint8Array;
  setId: bigint;
}

/** headerOf(hash) on the light client, or null when it does not hold that block (UnknownBlock). */
export async function heldHeader(endpoints: Endpoint[], client: string, hash: Hex, block: string): Promise<HeldHeader | null> {
  let a: { result: Hex };
  try {
    a = await call(endpoints, client, encodeCall("headerOf(bytes32)", [hash]), block);
  } catch (error) {
    if (error instanceof NodeError && error.isRevert) return null;
    throw error;
  }
  const [h] = decode("(uint32,bytes32,uint64)", a.result) as [[bigint, Hex, bigint]];
  return { number: Number(h[0]), stateRoot: hexToBytes(h[1]), setId: h[2] };
}

/** keccak-256 of the code at an address, or null when there is none. */
export async function codeHash(endpoints: Endpoint[], address: string, block: string): Promise<Hex | null> {
  const a = await request<Hex>(endpoints, "eth_getCode", [address, block], { timeoutMs: 12_000 });
  const code = hexToBytes(a.result);
  return code.length === 0 ? null : bytesToHex(keccak256(code));
}

// ---------------------------------------------------------------------------------------------
// Dry runs

export interface Revert {
  /** The revert data, when the node gave it. */
  data: Hex | null;
  /** The contracts' error it names, when one does. */
  error: DecodedError | null;
  /** "NonceAlreadyUsed(nonce: 1)", or the node's message when the data names nothing. */
  text: string;
}

export function revertOf(data: string | null | undefined, message: string, registry: AbiRegistry): Revert {
  const d = data && /^0x([0-9a-fA-F]{2})*$/.test(data) && data.length > 2 ? (data.toLowerCase() as Hex) : null;
  const error = d ? registry.decodeError(d) : null;
  return { data: d, error, text: error ? formatError(error, (h) => shortHex(h)) : d ? `${message} (${shortHex(d)})` : message };
}

export interface DryTx {
  from?: string;
  to: string;
  data: string;
}

const txJson = (tx: DryTx, gas?: bigint) => ({ ...(tx.from ? { from: tx.from } : {}), to: tx.to, data: tx.data, ...(gas === undefined ? {} : { gas: `0x${gas.toString(16)}` }) });

/**
 * `method` endpoint by endpoint: the first answer, or the first revert that carries its data. A
 * revert without data is asked of the next endpoint, as the status page's attack check does; a node
 * that refuses the call for another reason (a pruned block, a rate limit) moves to the next too.
 */
async function firstAnswer<T>(endpoints: Endpoint[], method: string, params: unknown[], registry: AbiRegistry): Promise<{ result: T } | { revert: Revert }> {
  let bare: Revert | null = null;
  const problems: string[] = [];
  for (const ep of endpoints) {
    try {
      return { result: (await request<T>([ep], method, params, { timeoutMs: 20_000 })).result };
    } catch (error) {
      if (error instanceof NodeError && error.isRevert) {
        const revert = revertOf(error.data, error.message, registry);
        if (revert.data) return { revert };
        bare ??= revert;
        continue;
      }
      problems.push(error instanceof AllFailed ? error.problems.join("; ") : (error as Error).message);
    }
  }
  if (bare) return { revert: bare };
  throw new AllFailed(method, problems);
}

/** eth_estimateGas of `tx`: the gas, or the revert. */
export async function estimateGas(endpoints: Endpoint[], tx: DryTx, block: string, registry: AbiRegistry): Promise<{ gas: bigint } | { revert: Revert }> {
  const a = await firstAnswer<Hex>(endpoints, "eth_estimateGas", [txJson(tx), block], registry);
  return "revert" in a ? a : { gas: BigInt(a.result) };
}

/** eth_call of `tx` with the cap as its gas: its return data, or its revert. */
export async function dryCall(endpoints: Endpoint[], tx: DryTx, block: string, registry: AbiRegistry): Promise<{ data: Hex } | { revert: Revert }> {
  const a = await firstAnswer<Hex>(endpoints, "eth_call", [txJson(tx, TX_GAS_CAP), block], registry);
  return "revert" in a ? a : { data: a.result };
}

export interface SimulatedCall {
  ok: boolean;
  gasUsed: bigint;
  returnData: Hex;
  revert: Revert | null;
}

interface SimCallJson {
  status: string;
  gasUsed: string;
  returnData?: string;
  error?: { message?: string; data?: string };
}

/**
 * eth_simulateV1 of `txs` in order, each on the state the one before left, each with the cap as its
 * gas: what eth_estimateGas cannot give for a transaction that needs the one before it mined. Each
 * goes in a simulated block of its own, as the wallet's would land, since several at the cap can
 * be more than one block's gas limit. Null when no endpoint runs it (tenderly answers 429; a node
 * may lack the method).
 */
export async function simulate(endpoints: Endpoint[], txs: DryTx[], block: string, registry: AbiRegistry): Promise<SimulatedCall[] | null> {
  const blockStateCalls = txs.map((t) => ({ calls: [txJson(t, TX_GAS_CAP)] }));
  let blocks: { calls: SimCallJson[] }[];
  try {
    blocks = (await request<{ calls: SimCallJson[] }[]>(endpoints, "eth_simulateV1", [{ blockStateCalls, validation: false }, block], { timeoutMs: 30_000 })).result;
  } catch (error) {
    if (error instanceof AllFailed || (error instanceof NodeError && !error.isRevert)) return null;
    throw error;
  }
  if (!Array.isArray(blocks) || blocks.length !== txs.length) return null;
  const out = blocks.map((b) => (b && Array.isArray(b.calls) ? b.calls[0] : undefined));
  if (out.some((c) => c === undefined)) return null;
  return (out as SimCallJson[]).map((c) => {
    const ok = c.status === "0x1";
    const data = c.returnData && c.returnData !== "0x" ? c.returnData : c.error?.data;
    return { ok, gasUsed: BigInt(c.gasUsed), returnData: (c.returnData ?? "0x") as Hex, revert: ok ? null : revertOf(data, c.error?.message ?? "reverted", registry) };
  });
}

/** A node that refused an estimate because the call needs more gas than it lets one transaction use. */
export const overGasCap = (error: unknown): boolean => /gas required exceeds|exceeds (the )?(block )?gas (limit|cap)|gas limit .* (cap|too high)|intrinsic gas too high/i.test(error instanceof AllFailed ? error.problems.join("; ") : error instanceof Error ? error.message : String(error));
