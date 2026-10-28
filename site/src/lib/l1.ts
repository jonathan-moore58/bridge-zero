// What a transaction on a rollup pays for its data on L1 (Sepolia), besides its execution gas, and
// how the page reads it before the wallet is asked, as the relayer's tools do (relayer/src/l1.ts).
// Sepolia has none.
//
// Arbitrum (Nitro): L1 gas. The poster's cost is charged as gas units at the L2 gas price, so it is
// part of the gas a transaction uses and must fit in its gas limit; eth_estimateGas includes it, at
// the L1 price of the moment. NodeInterface's gasEstimateL1Component(to, contractCreation, data), a
// virtual contract the node answers through eth_call at 0x…c8, gives those units alone: the page
// adds them once more to the gas limit, as the L1 price can rise before inclusion.
//
// OP Stack (Base): an L1 data fee in wei, charged besides the gas (the receipt's l1Fee).
// GasPriceOracle's getL1FeeUpperBound(unsigned transaction size) at 0x42…0f bounds it from above:
// the page counts it in the balance a send needs, and in what it costs. On Oct 28 Arbitrum
// Sepolia's L1 gas was 0 and Base Sepolia's L1 fee under 0.000000001 ETH (README, "More chains").

import { decode, encodeCall } from "./abi.ts";
import { selector } from "./hashes.ts";
import { hexToBytes, type Hex } from "./hex.ts";
import { request, type Endpoint } from "./rpc.ts";

/** How a chain charges for L1: not at all (Sepolia), in gas units (Arbitrum), or as a fee besides the gas (OP Stack). */
export type L1Kind = "none" | "arbitrum" | "op";

/** Arbitrum's NodeInterface (eth_call only) and the OP Stack's GasPriceOracle predeploy. */
export const NODE_INTERFACE: Hex = "0x00000000000000000000000000000000000000c8";
export const GAS_PRICE_ORACLE: Hex = "0x420000000000000000000000000000000000000f";

/**
 * Bytes an unsigned EIP-1559 transaction carries besides its calldata (chain id, nonce, both fees,
 * gas limit, to, value, access list, RLP headers): about 60; getL1FeeUpperBound adds the signature
 * itself. 200 keeps the bound above the transaction that is sent, as the relayer's.
 */
export const UNSIGNED_TX_OVERHEAD = 200;

/** What a transaction pays for L1: gas units in its gas limit (Arbitrum), or a fee in wei besides its gas (OP Stack). */
export interface L1Cost {
  kind: L1Kind;
  /** Arbitrum: L1 gas units, paid at the L2 gas price; 0 elsewhere. */
  gas: bigint;
  /** The L1 part in wei: Arbitrum, its gas at the L2 base fee; OP Stack, the bound of the L1 data fee. */
  fee: bigint;
}

export const NO_L1: L1Cost = { kind: "none", gas: 0n, fee: 0n };

const word = (n: bigint): string => n.toString(16).padStart(64, "0");

/** NodeInterface.gasEstimateL1Component(to, false, data): the L1 gas of a call to `to` with `data`. */
export function l1ComponentCalldata(to: Hex, data: Hex): Hex {
  const bytes = hexToBytes(data);
  const body = data.slice(2).toLowerCase().padEnd(Math.ceil(bytes.length / 32) * 64, "0");
  // to, contractCreation, then the offset of the bytes (three words in) and their length.
  return `${selector("gasEstimateL1Component(address,bool,bytes)")}${word(BigInt(to))}${word(0n)}${word(96n)}${word(BigInt(bytes.length))}${body}` as Hex;
}

/** GasPriceOracle.getL1FeeUpperBound(size) of a transaction with `data` as its calldata. */
export const l1FeeBoundCalldata = (data: Hex): Hex => encodeCall("getL1FeeUpperBound(uint256)", [BigInt(hexToBytes(data).length + UNSIGNED_TX_OVERHEAD)]);

/** The eth_call that reads the L1 part of a call to `to` with `data` on a chain of kind `kind`; null where there is none. */
export function l1Call(kind: L1Kind, to: Hex, data: Hex): { to: Hex; data: Hex } | null {
  if (kind === "arbitrum") return { to: NODE_INTERFACE, data: l1ComponentCalldata(to, data) };
  if (kind === "op") return { to: GAS_PRICE_ORACLE, data: l1FeeBoundCalldata(data) };
  return null;
}

/** That eth_call's answer as an L1Cost: gasEstimateL1Component's (uint64 gasEstimateForL1, uint256 baseFee, uint256 l1BaseFeeEstimate), or getL1FeeUpperBound's uint256. */
export function l1Of(kind: L1Kind, result: Hex): L1Cost {
  if (kind === "arbitrum") {
    const [gas, baseFee] = decode("uint64,uint256,uint256", result) as [bigint, bigint, bigint];
    return { kind, gas, fee: gas * baseFee };
  }
  if (kind === "op") return { kind, gas: 0n, fee: decode("uint256", result)[0] as bigint };
  return NO_L1;
}

/** The L1 part of a call to `to` with `data`, read from the chain's nodes at `block`; nothing to read on Sepolia. Throws what the read throws. */
export async function readL1(endpoints: Endpoint[], kind: L1Kind, to: Hex, data: Hex, block = "latest"): Promise<L1Cost> {
  const c = l1Call(kind, to, data);
  if (!c) return NO_L1;
  return l1Of(kind, (await request<Hex>(endpoints, "eth_call", [c, block], { timeoutMs: 12_000 })).result);
}

/** The gas limit a transaction is sent with: on Arbitrum the L1 gas once more, as the whole L1 part has to fit in it; elsewhere `gas` as it is. */
export const limitWithL1 = (gas: bigint, l1: L1Cost): bigint => (l1.kind === "arbitrum" ? gas + l1.gas : gas);

/** What a send costs besides its gas: the OP Stack's L1 data fee; 0 elsewhere, where any L1 part is gas. */
export const feeBesides = (l1: L1Cost): bigint => (l1.kind === "op" ? l1.fee : 0n);
