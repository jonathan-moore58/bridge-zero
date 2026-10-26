// What the page checks before it asks the wallet for a lock or a burn: a dry run from the sender
// (the contracts' own refusals, dust and all), eth_estimateGas with the margin, the fees, and what
// the wallet checks up front against the balance. The deployed contracts and the endpoints come in
// as arguments (sends.ts passes the build's), so that a node script runs these read-only against
// the live chains, and node --test against fake ones.

import { decode, encodeCall, type AbiRegistry } from "../lib/abi.ts";
import { formatUnits } from "../lib/format.ts";
import type { Hex } from "../lib/hex.ts";
import { unreachable as reachedNoNode } from "../lib/proof/plan.ts";
import { revertOf, type Revert } from "../lib/proof/sepolia.ts";
import { AllFailed, NodeError, request, type Endpoint } from "../lib/rpc.ts";
import { evmValue, keyControlled, sepoliaFees, upFront, v3Fees, withMargin, type Fees } from "./txmath.ts";

/** The deployed contracts, the page's endpoints, and the contracts' errors, which name a revert. */
export interface SendEnv {
  sepolia: Endpoint[];
  v3Evm: Endpoint[];
  vault: Hex;
  minter: Hex;
  token: Hex;
  sepoliaChainId: bigint;
  registry: AbiRegistry;
}

/**
 * A read that reached no node, as opposed to a node that answered with an error: worth asking again
 * later. The proof core's test (it throws only these for a plan to be made again), and viem's.
 */
export function unreachable(e: unknown): boolean {
  if (reachedNoNode(e)) return true;
  if (e instanceof AllFailed) return false;
  // viem's, through wagmi's transports.
  for (let x: unknown = e, i = 0; x && typeof x === "object" && i < 8; x = (x as { cause?: unknown }).cause, i++) {
    const name = (x as { name?: unknown }).name;
    if (name === "HttpRequestError" || name === "TimeoutError" || name === "WebSocketRequestError") return true;
  }
  return false;
}

export const errorText = (e: unknown): string => (e instanceof AllFailed ? (e.problems[0] ?? e.message) : e instanceof Error ? e.message : String(e));

export interface DryTx {
  from: Hex;
  to: Hex;
  data: Hex;
  value?: bigint;
}

const qty = (n: bigint): Hex => `0x${n.toString(16)}`;
const word = (data: Hex): bigint => decode("uint256", data)[0] as bigint;

/**
 * eth_call or eth_estimateGas of `tx` at the latest block, endpoint by endpoint: the first answer,
 * or the revert named by the contracts' errors. A revert without data is asked of the next endpoint,
 * as the proof core's dry runs do (../lib/proof/sepolia.ts); one with data is the contracts' verdict.
 */
export async function dry(endpoints: Endpoint[], method: "eth_call" | "eth_estimateGas", tx: DryTx, registry: AbiRegistry): Promise<{ result: Hex } | { revert: Revert }> {
  const json = { from: tx.from, to: tx.to, data: tx.data, ...(tx.value ? { value: qty(tx.value) } : {}) };
  let bare: Revert | null = null;
  const problems: string[] = [];
  for (const ep of endpoints) {
    try {
      return { result: (await request<Hex>([ep], method, [json, "latest"], { timeoutMs: 15_000 })).result };
    } catch (e) {
      if (e instanceof NodeError && e.isRevert) {
        const r = revertOf(e.data, e.message, registry);
        if (r.data) return { revert: r };
        bare ??= r;
        continue;
      }
      problems.push(e instanceof AllFailed ? e.problems.join("; ") : errorText(e));
    }
  }
  if (bare) return { revert: bare };
  throw new AllFailed(method, problems);
}

/** Sepolia's fees now: the latest block's base fee and the node's priority fee (txmath.ts, sepoliaFees). */
export async function sepoliaFeesNow(endpoints: Endpoint[]): Promise<Fees & { base: bigint }> {
  const [block, tip] = await Promise.all([
    request<{ baseFeePerGas?: Hex } | null>(endpoints, "eth_getBlockByNumber", ["latest", false], { accept: (r) => r !== null }),
    request<Hex>(endpoints, "eth_maxPriorityFeePerGas", []),
  ]);
  const base = block.result?.baseFeePerGas;
  if (!base) throw new Error("Sepolia's latest block carries no base fee");
  return { ...sepoliaFees(BigInt(base), BigInt(tip.result)), base: BigInt(base) };
}

export const balanceOn = async (endpoints: Endpoint[], address: Hex): Promise<bigint> => BigInt((await request<Hex>(endpoints, "eth_getBalance", [address, "latest"])).result);

/**
 * The sender's next nonce, its pending transactions counted: the nonce the wallet most likely gives
 * the transaction it is asked for next. Null when no node said; nothing depends on it but the check
 * for a transaction the wallet replaced (sends.ts).
 */
export const nextNonce = (endpoints: Endpoint[], address: Hex): Promise<number | null> =>
  request<Hex>(endpoints, "eth_getTransactionCount", [address, "pending"]).then(
    (a) => Number(BigInt(a.result)),
    () => null,
  );

/** The chain's latest block number, or null when no node said. */
const headOf = (endpoints: Endpoint[]): Promise<number | null> =>
  request<Hex>(endpoints, "eth_blockNumber", []).then(
    (a) => Number(BigInt(a.result)),
    () => null,
  );

/** A send the wallet can be asked for, with what the checks found. Amounts in wei unless said. */
export interface Prepared {
  data: Hex;
  /** msg.value: on V3, the amount in 18 decimals. */
  value: bigint;
  /** The gas limit the wallet is given: the estimate plus 10%. */
  gas: bigint;
  fees: Fees;
  /** eth_estimateGas's answer. */
  estimate: bigint;
  /** What the dry run returned: the nonce the lock would take, or the burn's. Another send can take it first: the receipt's log decides. */
  returns: bigint;
  /** What the wallet checks up front (the value, and the gas limit at the max fee), and the balance it checks it against. */
  need: bigint;
  balance: bigint;
  /** The estimate at the price now: on V3 the whole cost, its storage deposit included. */
  cost: bigint;
  /**
   * The chain's latest block as the checks read it: the lock or the burn the wallet sends after them
   * is in a later block, which is where the sends look for its log. And the sender's next nonce
   * (nextNonce). Each null when the node did not say.
   */
  head: number | null;
  nonce: number | null;
}

export type Prep = Prepared | { problem: { title: string; text: string } };

const problem = (title: string, text: string): Prep => ({ problem: { title, text } });
const tokens = (wei: bigint, decimals: number): string => formatUnits(wei, decimals, 6);

/**
 * The lock, checked before the wallet is asked: `lock(11155111, BridgeMinter, the sender)`, whose
 * chain, minter and recipient never come from what the visitor types. A dry run from the sender (the
 * vault's own refusals: dust, a zero amount), eth_estimateGas, which on V3 includes the storage
 * deposit, the fees (txmath.ts, v3Fees), and what the wallet checks up front against the balance.
 */
export async function prepareLock(env: SendEnv, from: Hex, amount: bigint): Promise<Prep> {
  const value = evmValue(amount);
  const data = encodeCall("lock(uint256,address,address)", [env.sepoliaChainId, env.minter, from]);
  const tx: DryTx = { from, to: env.vault, data, value };
  // A node that will not run a lock the sender cannot pay for says so in words, not as a revert:
  // "insufficient funds for gas * price + value" on V3.
  const poor = (e: unknown): { short: string } => {
    if (!unreachable(e) && /insufficient|balance|funds/i.test(errorText(e))) return { short: errorText(e) };
    throw e;
  };
  const [call, est, price, balance, head, nonce] = await Promise.all([
    dry(env.v3Evm, "eth_call", tx, env.registry).catch(poor),
    dry(env.v3Evm, "eth_estimateGas", tx, env.registry).catch(poor),
    request<Hex>(env.v3Evm, "eth_gasPrice", []).then((a) => BigInt(a.result)),
    balanceOn(env.v3Evm, from),
    headOf(env.v3Evm),
    nextNonce(env.v3Evm, from),
  ]);
  if ("short" in call || "short" in est) {
    return problem("Not enough tPOT for the lock", `You have ${tokens(balance, 18)} tPOT on V3, and V3 would not run this lock: the amount and its gas, the storage deposit included, are more. Nothing was sent.`);
  }
  if ("revert" in call) return problem("The vault would refuse this lock", `Its dry run on V3 reverted: ${call.revert.text}. Nothing was sent.`);
  if ("revert" in est) return problem("The vault would refuse this lock", `V3's gas estimate reverted: ${est.revert.text}. Nothing was sent.`);
  const estimate = BigInt(est.result);
  const gas = withMargin(estimate);
  const fees = v3Fees(price);
  const need = upFront(value, gas, fees);
  const cost = estimate * price;
  if (balance < need) {
    return problem(
      "Not enough tPOT for the lock",
      `Your wallet checks ${tokens(need, 18)} tPOT up front: the amount, and the gas limit at the max fee. On V3 the gas includes the storage deposit; about ${tokens(cost, 18)} tPOT of it is charged at today's price. You have ${tokens(balance, 18)}. Nothing was sent.`,
    );
  }
  return { data, value, gas, fees, estimate, returns: word(call.result), need, balance, cost, head, nonce };
}

/**
 * The burn, checked before the wallet is asked: `burn(amount, the sender)`, so the V3 recipient is
 * the sender's own 20-byte address. The sender has to be an address a key controls (the committee
 * pays a burn's sender on V3 only then), hold the wtPOT, the vault's outstanding tPOT has to cover
 * the release, the dry run has to pass, and the sender has to have the ETH for its gas.
 */
export async function prepareBurn(env: SendEnv, from: Hex, amount: bigint): Promise<Prep> {
  const data = encodeCall("burn(uint256,address)", [amount, from]);
  const tx: DryTx = { from, to: env.minter, data };
  const [code, held, call, est, fees, eth, outstanding, head, nonce] = await Promise.all([
    request<Hex>(env.sepolia, "eth_getCode", [from, "latest"]).then((a) => a.result),
    request<Hex>(env.sepolia, "eth_call", [{ to: env.token, data: encodeCall("balanceOf(address)", [from]) }, "latest"]).then((a) => word(a.result)),
    dry(env.sepolia, "eth_call", tx, env.registry),
    dry(env.sepolia, "eth_estimateGas", tx, env.registry),
    sepoliaFeesNow(env.sepolia),
    balanceOn(env.sepolia, from),
    request<Hex>(env.v3Evm, "eth_call", [{ to: env.vault, data: encodeCall("outstanding()") }, "latest"]).then((a) => word(a.result)),
    headOf(env.sepolia),
    nextNonce(env.sepolia, from),
  ]);
  if (!keyControlled(code)) {
    return problem(
      "Not burned: your address is a contract on Sepolia",
      "The committee pays a burn's sender on V3 only when a key controls that address there, and a smart wallet's address is no key's. Burn from an address a key controls (an EIP-7702 delegation is fine). Nothing was burned.",
    );
  }
  if (held < amount) return problem("Not enough wtPOT", `You hold ${tokens(held, 14)} wtPOT on Sepolia. Nothing was burned.`);
  if (outstanding < amount) {
    return problem("The vault cannot release that much", `The vault on V3 holds ${tokens(outstanding, 14)} tPOT for wtPOT, less than this burn: the committee could not release it. Nothing was burned.`);
  }
  if ("revert" in call) return problem("BridgeMinter would refuse this burn", `Its dry run on Sepolia reverted: ${call.revert.text}. Nothing was burned.`);
  if ("revert" in est) return problem("BridgeMinter would refuse this burn", `Sepolia's gas estimate reverted: ${est.revert.text}. Nothing was burned.`);
  const estimate = BigInt(est.result);
  const gas = withMargin(estimate);
  const need = upFront(0n, gas, fees);
  if (eth < need) return problem("Not enough Sepolia ETH", `The burn's gas needs up to ${tokens(need, 18)} ETH; you have ${tokens(eth, 18)}. Nothing was burned.`);
  const { maxFeePerGas, maxPriorityFeePerGas } = fees;
  return { data, value: 0n, gas, fees: { maxFeePerGas, maxPriorityFeePerGas }, estimate, returns: word(call.result), need, balance: eth, cost: estimate * (fees.base + maxPriorityFeePerGas), head, nonce };
}
