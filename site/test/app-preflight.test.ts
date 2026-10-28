// The checks before the wallet is asked for a lock or a burn (src/app/preflight.ts), on fake nodes
// that answer as V3's EVM RPC and Sepolia answered on Oct 26 (scratchpad probe): the lock's calldata
// names this bridge and the sender, its value is whole native units, its gas the estimate plus 10%
// at V3's fees; a sender V3 will not run the lock for, a vault refusal, a sender with code on
// Sepolia, too little wtPOT, an empty vault or too little ETH each stop it before the wallet. Then
// the rollups: a lock names the rollup's chain id and minter; a burn there counts its L1 part
// (src/lib/l1.ts), Arbitrum's L1 gas in its gas limit and Base's L1 data fee in the balance it
// needs, and the words name the chain. A method that sends or signs is an error here. Offline.

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { decodeFunctionData, encodeFunctionData, parseAbi, type Hex as ViemHex } from "viem";
import { prepareBurn, prepareLock, unreachable, type Prepared, type SendEnv } from "../src/app/preflight.ts";
import { SEPOLIA_MIN_TIP, sepoliaFees, upFront, withMargin } from "../src/app/txmath.ts";
import { encodeCall } from "../src/lib/abi.ts";
import type { Hex } from "../src/lib/hex.ts";
import { feeBesides, GAS_PRICE_ORACLE, l1Call, l1ComponentCalldata, l1FeeBoundCalldata, l1Of, limitWithL1, NO_L1, NODE_INTERFACE, UNSIGNED_TX_OVERHEAD } from "../src/lib/l1.ts";
import { AllFailed, TransportError, type Endpoint } from "../src/lib/rpc.ts";
import { enc, fakeFetch, MINTER, restoreFetch, revertData, RpcFail, registry, VAULT, type Seen } from "./fake-chains.ts";

afterEach(restoreFetch);

const TOKEN: Hex = "0x1fcbbd66922ac5aa20219a5c16c2591a76b4cb14";
const ME: Hex = "0xd9838a86cf83c28ee486544060d1ca4ca2971071";
const SEP: Endpoint = { id: "sep", label: "fake Sepolia", url: "https://sepolia.fake/" };
const V3E: Endpoint = { id: "v3e", label: "fake V3 EVM", url: "https://v3-evm.fake/" };
const env: SendEnv = { evm: [SEP], chainId: 11_155_111n, chain: "Sepolia", l1: "none", v3Evm: [V3E], vault: VAULT, minter: MINTER, token: TOKEN, registry };

/** The rollups' BridgeMinter and wtPOT, the same addresses on both (deployments/<network>-bridge.json). */
const ROLLUP_MINTER: Hex = "0xdc31a3bc1354545eeb985aad7b2aa662e9272348";
const ROLLUP_TOKEN: Hex = "0xe1130718c56de008b47c392c85895a1a605ba95e";
const BASE: Endpoint = { id: "base", label: "fake Base Sepolia", url: "https://base-sepolia.fake/", logRange: 50_000 };
const ARB: Endpoint = { id: "arb", label: "fake Arbitrum Sepolia", url: "https://arbitrum-sepolia.fake/" };
const baseEnv: SendEnv = { ...env, evm: [BASE], chainId: 84_532n, chain: "Base Sepolia", l1: "op", minter: ROLLUP_MINTER, token: ROLLUP_TOKEN };
const arbEnv: SendEnv = { ...env, evm: [ARB], chainId: 421_614n, chain: "Arbitrum Sepolia", l1: "arbitrum", minter: ROLLUP_MINTER, token: ROLLUP_TOKEN };

const qty = (n: bigint): Hex => `0x${n.toString(16)}`;
const ONE = 100_000_000_000_000n;
/** Oct 26: the gas price, a 0.1 tPOT lock's estimate (3.93 tPOT at that price, the deposit included), and 0xD983…1071's 183 tPOT. */
const PRICE = 0x7409n;
const LOCK_GAS = 0x782d4d63c156n;
const RICH = 0x9ecdce795e7bc78c4n;

interface V3State {
  balance: bigint;
  outstanding: bigint;
  /** The node's own refusal of a lock the sender cannot pay for. */
  poor: boolean;
  /** The vault's refusal, as revert data. */
  revert: Hex | null;
  /** The node does not answer eth_blockNumber and eth_getTransactionCount. */
  mute: boolean;
}

interface SepoliaState {
  code: Hex;
  wtpot: bigint;
  eth: bigint;
  base: bigint;
  tip: bigint;
  revert: Hex | null;
}

/** Oct 26 (scratchpad probes): V3's head and 0xD983…1071's nonce there; Sepolia's head and its nonce there. */
const V3_HEAD = 0x32f42n;
const SEP_HEAD = 0xb71cddn;

/**
 * The fake chains: V3's EVM RPC, and the destination's node at `dest` (Sepolia's by default), whose
 * wtPOT is `token`; `l1` answers an eth_call to NodeInterface or GasPriceOracle, as a rollup's node does.
 */
function chains(v3: Partial<V3State> = {}, sep: Partial<SepoliaState> = {}, dest: { ep: Endpoint; token: Hex; l1?: (to: string, data: Hex) => Hex } = { ep: SEP, token: TOKEN }): Seen[] {
  const V: V3State = { balance: RICH, outstanding: 14n * ONE / 10n, poor: false, revert: null, mute: false, ...v3 };
  const S: SepoliaState = { code: "0x", wtpot: 14n * ONE / 10n, eth: 10n ** 17n, base: 17n, tip: 3n, revert: null, ...sep };
  return fakeFetch({
    [V3E.url]: (method, params) => {
      const tx = params[0] as { to?: string; data?: string; value?: string };
      switch (method) {
        case "eth_gasPrice":
          return qty(PRICE);
        case "eth_getBalance":
          return qty(V.balance);
        case "eth_blockNumber":
          if (V.mute) break;
          return qty(V3_HEAD);
        case "eth_getTransactionCount":
          if (V.mute) break;
          return params[1] === "pending" ? "0x2" : "0x1";
        case "eth_call":
        case "eth_estimateGas":
          if (tx.to?.toLowerCase() === VAULT && tx.data === encodeCall("outstanding()")) return enc("uint256", [V.outstanding]);
          if (V.poor) throw new RpcFail(-32000, `insufficient funds for gas * price + value (0): address ${ME} have 0 (supplied gas None)`);
          if (V.revert) throw new RpcFail(3, "execution reverted", V.revert);
          return method === "eth_call" ? enc("uint256", [2n]) : qty(LOCK_GAS);
      }
      throw new Error(method);
    },
    [dest.ep.url]: (method, params) => {
      const tx = params[0] as { to?: string; data?: string };
      const to = method === "eth_call" ? tx.to?.toLowerCase() : undefined;
      if (to && dest.l1 && (to === NODE_INTERFACE || to === GAS_PRICE_ORACLE)) return dest.l1(to, tx.data as Hex);
      switch (method) {
        case "eth_getCode":
          return S.code;
        case "eth_getBalance":
          return qty(S.eth);
        case "eth_getBlockByNumber":
          return { number: "0xb71cdd", baseFeePerGas: qty(S.base) };
        case "eth_maxPriorityFeePerGas":
          return qty(S.tip);
        case "eth_blockNumber":
          return qty(SEP_HEAD);
        case "eth_getTransactionCount":
          return params[1] === "pending" ? "0x54" : "0x53";
        case "eth_call":
        case "eth_estimateGas":
          if (tx.to?.toLowerCase() === dest.token) return enc("uint256", [S.wtpot]);
          if (S.revert) throw new RpcFail(3, "execution reverted", S.revert);
          return method === "eth_call" ? enc("uint256", [2n]) : qty(62_261n);
      }
      throw new Error(method);
    },
  });
}

const ok = (p: Awaited<ReturnType<typeof prepareLock>>): Prepared => {
  assert.ok(!("problem" in p), "problem" in p ? `${p.problem.title}: ${p.problem.text}` : "");
  return p as Prepared;
};

const problemOf = (p: Awaited<ReturnType<typeof prepareLock>>): { title: string; text: string } => {
  assert.ok("problem" in p, "expected a problem");
  return (p as { problem: { title: string; text: string } }).problem;
};

test("a lock names Sepolia, BridgeMinter and the sender, carries whole native units, and gets the estimate plus 10% at V3's fees", async () => {
  const seen = chains();
  const amount = ONE / 10n;
  const p = ok(await prepareLock(env, ME, amount));
  assert.equal(p.data, encodeCall("lock(uint256,address,address)", [11_155_111n, MINTER, ME]));
  assert.equal(p.value, amount * 10_000n);
  assert.equal(p.estimate, LOCK_GAS);
  assert.equal(p.gas, LOCK_GAS + LOCK_GAS / 10n);
  assert.deepEqual(p.fees, { maxFeePerGas: PRICE + PRICE / 8n, maxPriorityFeePerGas: 0n });
  assert.equal(p.need, p.value + p.gas * p.fees.maxFeePerGas);
  assert.equal(p.cost, LOCK_GAS * PRICE);
  assert.equal(p.returns, 2n);
  // The block the lock's log can only follow, and the nonce the wallet most likely gives it: pending transactions counted.
  assert.deepEqual([p.head, p.nonce], [Number(V3_HEAD), 2]);
  assert.deepEqual(
    seen.find((s) => s.method === "eth_getTransactionCount")?.params,
    [ME, "pending"],
  );
  // Both dry runs ran from the sender, with the value.
  for (const m of ["eth_call", "eth_estimateGas"]) {
    const c = seen.find((s) => s.method === m && (s.params[0] as { to: string }).to.toLowerCase() === VAULT && (s.params[0] as { data: string }).data === p.data);
    assert.ok(c, m);
    assert.deepEqual(c.params[0], { from: ME, to: VAULT, data: p.data, value: qty(p.value) });
  }
  assert.ok(seen.every((s) => !/^(eth_send|eth_sign|personal_|wallet_)/.test(s.method)));
});

test("a node that does not give its head or the sender's nonce does not stop the lock: they read as unknown", async () => {
  chains({ mute: true });
  const p = ok(await prepareLock(env, ME, ONE / 10n));
  assert.deepEqual([p.head, p.nonce], [null, null]);
});

test("a lock V3 will not run for the sender stops before the wallet, in words", async () => {
  chains({ poor: true, balance: 0n });
  const p = problemOf(await prepareLock(env, ME, ONE));
  assert.equal(p.title, "Not enough tPOT for the lock");
  assert.match(p.text, /You have 0 tPOT on V3/);
  assert.match(p.text, /Nothing was sent/);
});

test("a lock the vault refuses names its error", async () => {
  chains({ revert: revertData("AmountTooSmall()") });
  const p = problemOf(await prepareLock(env, ME, 1n));
  assert.equal(p.title, "The vault would refuse this lock");
  assert.match(p.text, /AmountTooSmall/);
});

test("a lock the balance does not cover up front stops before the wallet, with what V3 would charge", async () => {
  // Enough for V3 to run it, not for the wallet's check: the gas limit at the max fee comes first.
  const need = ONE + (LOCK_GAS + LOCK_GAS / 10n) * (PRICE + PRICE / 8n);
  chains({ balance: need - 1n });
  const p = problemOf(await prepareLock(env, ME, ONE / 10_000n));
  assert.equal(p.title, "Not enough tPOT for the lock");
  assert.match(p.text, /up front/);
  assert.match(p.text, /about 3\.92\d* tPOT of it is charged/);
});

test("a burn names the sender's own address on V3, with Sepolia's fees and the tip at least the relayer's", async () => {
  const seen = chains();
  const amount = ONE / 100n;
  const p = ok(await prepareBurn(env, ME, amount));
  assert.equal(p.data, encodeCall("burn(uint256,address)", [amount, ME]));
  assert.equal(p.value, 0n);
  assert.equal(p.gas, 62_261n + 6_226n);
  assert.deepEqual(p.fees, { maxFeePerGas: 2n * 17n + SEPOLIA_MIN_TIP, maxPriorityFeePerGas: SEPOLIA_MIN_TIP });
  assert.equal(p.returns, 2n);
  assert.deepEqual([p.head, p.nonce], [Number(SEP_HEAD), 0x54]);
  assert.ok(seen.some((s) => s.method === "eth_call" && (s.params[0] as { to: string }).to.toLowerCase() === VAULT));
  assert.ok(seen.every((s) => !/^(eth_send|eth_sign|personal_|wallet_)/.test(s.method)));
});

test("an EIP-7702 delegation burns; a contract does not, as the committee pays no contract's address", async () => {
  chains({}, { code: `0xef0100${"12".repeat(20)}` });
  ok(await prepareBurn(env, ME, ONE / 100n));
  restoreFetch();
  chains({}, { code: "0x6080604052" });
  assert.match(problemOf(await prepareBurn(env, ME, ONE / 100n)).title, /contract on Sepolia/);
});

test("a burn of more wtPOT than held, more than the vault holds, or without the ETH for its gas stops before the wallet", async () => {
  chains({}, { wtpot: ONE / 10n });
  assert.equal(problemOf(await prepareBurn(env, ME, ONE)).title, "Not enough wtPOT");
  restoreFetch();
  chains({ outstanding: ONE / 10n }, { wtpot: 2n * ONE });
  assert.equal(problemOf(await prepareBurn(env, ME, ONE)).title, "The vault cannot release that much");
  restoreFetch();
  chains({}, { eth: 1000n });
  assert.equal(problemOf(await prepareBurn(env, ME, ONE / 100n)).title, "Not enough Sepolia ETH");
  restoreFetch();
  chains({}, { revert: revertData("ZeroRecipient()") });
  assert.match(problemOf(await prepareBurn(env, ME, ONE / 100n)).text, /ZeroRecipient/);
});

test("only a read that reached no node counts as unreachable; a node's refusal does not", () => {
  assert.equal(unreachable(new TransportError("unreachable", SEP)), true);
  assert.equal(unreachable(new AllFailed("eth_call", ["fake Sepolia: no answer in 8 s", "fake V3 EVM: HTTP 503"])), true);
  assert.equal(unreachable(new AllFailed("eth_call", ["fake V3 EVM: insufficient funds for gas * price + value"])), false);
  assert.equal(unreachable({ name: "CallExecutionError", cause: { name: "HttpRequestError" } }), true);
  assert.equal(unreachable(new Error("execution reverted")), false);
  // The V3 node's refusal to prove a block it has not finalized is an answer: asking again the same way gets the same.
  assert.equal(unreachable(new AllFailed("grandpa_proveFinality", ["grandpa_proveFinality: fake V3 node: GRANDPA prove finality rpc failed: Block not yet finalized"])), false);
});

// ---------------------------------------------------------------------------------------------
// The rollups: the lock names the rollup, the burn counts its L1 part

const L1_ABI = parseAbi([
  "function gasEstimateL1Component(address to, bool contractCreation, bytes data) returns (uint64 gasEstimateForL1, uint256 baseFee, uint256 l1BaseFeeEstimate)",
  "function getL1FeeUpperBound(uint256 unsignedTxSize) view returns (uint256)",
]);

test("the L1 calls are the predeploys' own: NodeInterface's gasEstimateL1Component and GasPriceOracle's getL1FeeUpperBound, encoded as viem encodes them", () => {
  const burn = encodeCall("burn(uint256,address)", [ONE / 1000n, ME]);
  assert.equal(l1ComponentCalldata(ROLLUP_MINTER, burn), encodeFunctionData({ abi: L1_ABI, functionName: "gasEstimateL1Component", args: [ROLLUP_MINTER, false, burn as ViemHex] }));
  // Calldata whose length is no multiple of 32 bytes is padded as the ABI pads bytes.
  const odd = "0x0102030405" as Hex;
  assert.equal(l1ComponentCalldata(ROLLUP_MINTER, odd), encodeFunctionData({ abi: L1_ABI, functionName: "gasEstimateL1Component", args: [ROLLUP_MINTER, false, odd as ViemHex] }));
  // The bound is of the unsigned transaction's size: its calldata and 200 bytes, as the relayer's.
  assert.equal(l1FeeBoundCalldata(burn), encodeFunctionData({ abi: L1_ABI, functionName: "getL1FeeUpperBound", args: [BigInt((burn.length - 2) / 2 + UNSIGNED_TX_OVERHEAD)] }));
  assert.deepEqual(l1Call("arbitrum", ROLLUP_MINTER, burn), { to: NODE_INTERFACE, data: l1ComponentCalldata(ROLLUP_MINTER, burn) });
  assert.deepEqual(l1Call("op", ROLLUP_MINTER, burn), { to: GAS_PRICE_ORACLE, data: l1FeeBoundCalldata(burn) });
  assert.equal(l1Call("none", ROLLUP_MINTER, burn), null);
});

test("an L1 part, read: Arbitrum's gas goes into the limit once more, Base's fee is paid besides it, Sepolia has none", () => {
  const arb = l1Of("arbitrum", enc("uint64,uint256,uint256", [1_234n, 20_000_000n, 9n]));
  assert.deepEqual(arb, { kind: "arbitrum", gas: 1_234n, fee: 1_234n * 20_000_000n });
  assert.equal(limitWithL1(100_000n, arb), 101_234n);
  assert.equal(feeBesides(arb), 0n);
  const op = l1Of("op", enc("uint256", [666_738n]));
  assert.deepEqual(op, { kind: "op", gas: 0n, fee: 666_738n });
  assert.equal(limitWithL1(100_000n, op), 100_000n);
  assert.equal(feeBesides(op), 666_738n);
  assert.equal(limitWithL1(100_000n, NO_L1), 100_000n);
  assert.equal(feeBesides(NO_L1), 0n);
});

test("a lock to Base Sepolia or Arbitrum Sepolia names that chain id and its minter; the rest of the lock is as Sepolia's", async () => {
  for (const e of [baseEnv, arbEnv]) {
    chains();
    const p = ok(await prepareLock(e, ME, ONE / 1000n));
    assert.equal(p.data, encodeCall("lock(uint256,address,address)", [e.chainId, ROLLUP_MINTER, ME]));
    assert.equal(p.value, (ONE / 1000n) * 10_000n);
    assert.equal(p.gas, LOCK_GAS + LOCK_GAS / 10n);
    // The lock is a V3 transaction: no L1 part.
    assert.deepEqual(p.l1, NO_L1);
    restoreFetch();
  }
  // Sepolia's lock is the one it always was: lock(11155111, 0x8287…cb9e, the sender).
  chains();
  assert.equal(ok(await prepareLock(env, ME, ONE)).data, encodeCall("lock(uint256,address,address)", [11_155_111n, MINTER, ME]));
});

test("a burn on Arbitrum Sepolia: NodeInterface's L1 gas for this very burn goes into the gas limit once more", async () => {
  let asked: Hex | null = null;
  const seen = chains({}, {}, { ep: ARB, token: ROLLUP_TOKEN, l1: (_to, data) => ((asked = data), enc("uint64,uint256,uint256", [4_321n, 20_000_000n, 0n])) });
  const amount = ONE / 1000n;
  const p = ok(await prepareBurn(arbEnv, ME, amount));
  assert.equal(p.data, encodeCall("burn(uint256,address)", [amount, ME]));
  assert.equal(p.gas, withMargin(62_261n) + 4_321n);
  assert.deepEqual(p.l1, { kind: "arbitrum", gas: 4_321n, fee: 4_321n * 20_000_000n });
  // The L1 part is gas: the wallet's up-front check is the limit at the max fee, nothing besides.
  assert.equal(p.need, upFront(0n, p.gas, p.fees));
  // NodeInterface was asked about the burn to the rollup's minter, not about a creation.
  const d = decodeFunctionData({ abi: L1_ABI, data: asked! as ViemHex });
  assert.equal(d.functionName, "gasEstimateL1Component");
  assert.equal((d.args[0] as string).toLowerCase(), ROLLUP_MINTER);
  assert.equal(d.args[1], false);
  assert.equal(d.args[2], p.data);
  // The wtPOT read is the rollup's token's, on the rollup's node.
  assert.ok(seen.some((s) => s.url === ARB.url && s.method === "eth_call" && (s.params[0] as { to: string }).to.toLowerCase() === ROLLUP_TOKEN));
  assert.ok(seen.every((s) => s.url !== SEP.url), "nothing is read from Sepolia");
});

test("a burn on Base Sepolia: GasPriceOracle's bound of the L1 data fee counts in the ETH it needs, and the words name the fee and the chain", async () => {
  const fee = 1_333_476n;
  chains({}, {}, { ep: BASE, token: ROLLUP_TOKEN, l1: () => enc("uint256", [fee]) });
  const amount = ONE / 1000n;
  const p = ok(await prepareBurn(baseEnv, ME, amount));
  assert.equal(p.gas, withMargin(62_261n));
  assert.deepEqual(p.l1, { kind: "op", gas: 0n, fee });
  const fees = sepoliaFees(17n, 3n);
  assert.equal(p.need, upFront(0n, p.gas, fees) + fee);
  assert.equal(p.cost, 62_261n * (17n + SEPOLIA_MIN_TIP) + fee);
  restoreFetch();
  // One wei short of the gas and the fee: refused before the wallet, naming both.
  chains({}, { eth: p.need - 1n }, { ep: BASE, token: ROLLUP_TOKEN, l1: () => enc("uint256", [fee]) });
  const short = problemOf(await prepareBurn(baseEnv, ME, amount));
  assert.equal(short.title, "Not enough Base Sepolia ETH");
  assert.match(short.text, /gas and its L1 data fee need up to/);
});

test("the burn's checks name the rollup: its contract senders, its wtPOT, its dry run", async () => {
  chains({}, { code: "0x6080604052" }, { ep: ARB, token: ROLLUP_TOKEN, l1: () => enc("uint64,uint256,uint256", [0n, 1n, 0n]) });
  assert.equal(problemOf(await prepareBurn(arbEnv, ME, ONE / 1000n)).title, "Not burned: your address is a contract on Arbitrum Sepolia");
  restoreFetch();
  chains({}, { wtpot: 0n }, { ep: ARB, token: ROLLUP_TOKEN, l1: () => enc("uint64,uint256,uint256", [0n, 1n, 0n]) });
  assert.equal(problemOf(await prepareBurn(arbEnv, ME, ONE / 1000n)).text, "You hold 0 wtPOT on Arbitrum Sepolia. Nothing was burned.");
  restoreFetch();
  chains({}, { revert: revertData("ZeroRecipient()") }, { ep: BASE, token: ROLLUP_TOKEN, l1: () => enc("uint256", [1n]) });
  assert.match(problemOf(await prepareBurn(baseEnv, ME, ONE / 1000n)).text, /^Its dry run on Base Sepolia reverted: ZeroRecipient/);
});

test("Sepolia's burn asks no L1 question: its checks are the ones it always made", async () => {
  const seen = chains();
  const p = ok(await prepareBurn(env, ME, ONE / 100n));
  assert.deepEqual(p.l1, NO_L1);
  assert.equal(p.gas, withMargin(62_261n));
  assert.ok(seen.every((s) => !(s.method === "eth_call" && [NODE_INTERFACE, GAS_PRICE_ORACLE].includes((s.params[0] as { to: string }).to.toLowerCase() as Hex))));
});
