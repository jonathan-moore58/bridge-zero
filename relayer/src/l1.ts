// What a transaction on a rollup pays for its data on L1 (Sepolia), besides its execution gas, and
// how the tools estimate it before they send. Sepolia has none.
//
// Arbitrum (Nitro): L1 gas. The poster's cost is charged as gas units at the L2 gas price, so it is
// part of the gas a transaction uses and must fit in its gas limit; eth_estimateGas includes it, at
// the L1 price of the moment. NodeInterface's gasEstimateL1Component(to, contractCreation, data),
// a virtual contract the node answers through eth_call at 0x…c8, returns those units alone, the L2
// base fee and its L1 base fee estimate. The L1 price can move between the estimate and inclusion,
// so the tools add the units once more to the gas limit they send with (automint.ts, mint.ts).
//
// OP Stack (Base): an L1 data fee in wei, charged besides the gas (gas limit times gas price): the
// receipt's l1Fee. GasPriceOracle's getL1FeeUpperBound(unsigned transaction size) at 0x42…0f, since
// Fjord, bounds it from above; the tools count it in the balance a send needs and in what it costs.
//
// No network access here: the calldata and the decoding. automint.ts and mint.ts make the calls.

import type { NetworkName } from "../../contracts/script/lib/sepolia.mjs";
import { bytesToHex, concatBytes, hexToBytes, type Hex } from "./bytes.js";
import { abiEncode, uintAt } from "./bridge.js";
import { addressWord, selector, uintWord } from "./vault.js";

/** How a network charges for L1: not at all (Sepolia), in gas units (Arbitrum), or as a fee besides the gas (OP Stack). */
export type L1Kind = "none" | "arbitrum" | "op";

export const L1_KIND: Record<NetworkName, L1Kind> = {
  sepolia: "none",
  "base-sepolia": "op",
  "arbitrum-sepolia": "arbitrum",
};

/** Arbitrum's NodeInterface (eth_call only) and the OP Stack's GasPriceOracle predeploy. */
export const NODE_INTERFACE: Hex = "0x00000000000000000000000000000000000000c8";
export const GAS_PRICE_ORACLE: Hex = "0x420000000000000000000000000000000000000f";

/**
 * Bytes an unsigned EIP-1559 transaction carries besides its calldata (chain id, nonce, both fees,
 * gas limit, to, value, access list, RLP headers): about 60; getL1FeeUpperBound adds the signature
 * itself. 200 keeps the bound above the transaction that is sent.
 */
export const UNSIGNED_TX_OVERHEAD = 200;

/** What a transaction pays for L1: gas units in its gas limit (Arbitrum), or a fee in wei besides its gas (OP Stack). */
export interface L1Cost {
  kind: L1Kind;
  /** Arbitrum: L1 gas units, paid at the L2 gas price; 0 elsewhere. */
  gas: number;
  /** The L1 part in wei: Arbitrum, gas times the L2 base fee; OP Stack, the upper bound of the L1 data fee. */
  fee: bigint;
  /** Arbitrum: its L1 base fee estimate (wei); OP Stack: null. */
  l1BaseFee: bigint | null;
}

export const NO_L1: L1Cost = { kind: "none", gas: 0, fee: 0n, l1BaseFee: null };

/** NodeInterface.gasEstimateL1Component(to, contractCreation, data): the L1 gas of a call to `to` (or of a creation, with `to` the zero address). */
export function l1ComponentCalldata(to: Hex | null, data: Hex): Hex {
  const target = to ? hexToBytes(to) : new Uint8Array(20);
  return bytesToHex(
    concatBytes(
      selector("gasEstimateL1Component(address,bool,bytes)"),
      abiEncode([{ word: addressWord(target) }, { word: uintWord(to ? 0n : 1n) }, { bytes: hexToBytes(data) }]),
    ),
  );
}

/** gasEstimateL1Component's answer: (uint64 gasEstimateForL1, uint256 baseFee, uint256 l1BaseFeeEstimate), as an L1Cost. */
export function decodeL1Component(result: Hex): L1Cost {
  const words = hexToBytes(result);
  const gas = uintAt(words, 0);
  const baseFee = uintAt(words, 1);
  if (gas > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`gasEstimateL1Component answered ${gas} L1 gas`);
  return { kind: "arbitrum", gas: Number(gas), fee: gas * baseFee, l1BaseFee: uintAt(words, 2) };
}

/** GasPriceOracle.getL1FeeUpperBound(size) of a transaction with `data` as calldata. */
export function l1FeeBoundCalldata(data: Hex): Hex {
  const size = BigInt((data.length - 2) / 2 + UNSIGNED_TX_OVERHEAD);
  return bytesToHex(concatBytes(selector("getL1FeeUpperBound(uint256)"), uintWord(size)));
}

export function decodeL1FeeBound(result: Hex): L1Cost {
  return { kind: "op", gas: 0, fee: uintAt(hexToBytes(result), 0), l1BaseFee: null };
}

/** The eth_call that estimates the L1 part of a call to `to` with `data` on a network of kind `kind`; null where there is none. */
export function l1Request(kind: L1Kind, to: Hex | null, data: Hex): { to: Hex; data: Hex; decode: (result: Hex) => L1Cost } | null {
  if (kind === "arbitrum") return { to: NODE_INTERFACE, data: l1ComponentCalldata(to, data), decode: decodeL1Component };
  if (kind === "op") return { to: GAS_PRICE_ORACLE, data: l1FeeBoundCalldata(data), decode: decodeL1FeeBound };
  return null;
}

/**
 * The gas limit a transaction is sent with on a network of kind `kind`, from its estimate (or
 * simulated gas) with `headroom` applied: on Arbitrum the L1 gas is added once more, as the L1 price
 * can rise before inclusion and the whole L1 part has to fit in the limit; elsewhere it is the
 * estimate with headroom.
 */
export function limitWithL1(kind: L1Kind, withHeadroom: number, l1: L1Cost): number {
  return kind === "arbitrum" ? withHeadroom + l1.gas : withHeadroom;
}

/** What a mined transaction cost besides its gas: the OP Stack receipt's l1Fee (wei), else 0. */
export function receiptL1Fee(receipt: { l1Fee?: string | null }): bigint {
  return typeof receipt.l1Fee === "string" && /^0x[0-9a-fA-F]+$/.test(receipt.l1Fee) ? BigInt(receipt.l1Fee) : 0n;
}
