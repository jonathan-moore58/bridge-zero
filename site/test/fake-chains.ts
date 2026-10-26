// Fake chains for the proof core's tests: fetch replaced by a V3 node and a Sepolia node that
// answer from the recorded fixtures and from what each test sets, as rpc.test.ts fakes a node.
// Nothing leaves the machine: a method a fake does not know is an error, and so is any eth_send,
// eth_sign or author_ call.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeFunctionData, encodeAbiParameters, parseAbi, parseAbiParameters, type Hex as ViemHex } from "viem";
import { parseAbi as parseSources } from "../build/records.ts";
import { AbiRegistry, decode } from "../src/lib/abi.ts";
import { selector } from "../src/lib/hashes.ts";
import { bytesToHex, concatBytes, hexToBytes, u64le, type Hex } from "../src/lib/hex.ts";
import { MULTICALL3 } from "../src/lib/proof/calldata.ts";
import type { LockRef, ProofEnv } from "../src/lib/proof/plan.ts";
import { childRootKey, commitmentKey } from "../src/lib/proof/revive.ts";
import { decodeFinalityProof, decodeU64, encodeCompact, encodeRpcHeader, type RpcHeader } from "../src/lib/proof/scale.ts";
import { GRANDPA_SET_ID_KEY } from "../src/lib/proof/v3.ts";
import { request, resetBatching, SubstrateClient, type Answer, type Endpoint } from "../src/lib/rpc.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const repo = join(here, "..", "..");
/** A repo file's JSON, of a shape the tests read field by field. */
export const readJson = (path: string): any => JSON.parse(readFileSync(join(repo, path), "utf8"));

export const LIGHT_CLIENT: Hex = "0x447171c4885ad725ee4772e8e3c228adee50dcb0";
export const MINTER: Hex = "0x8287b3baf205ca8456f98346f13064aa7fcdcb9e";
export const VAULT: Hex = "0xa02ee16eb03d2cf1aef199f7658fb8c8e3188ffd";
export const GENESIS: Hex = "0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd";

/** The contracts' errors and events, from contracts/src as the build reads them. */
export const registry = (() => {
  const abi = parseSources(join(repo, "contracts", "src"));
  return new AbiRegistry(abi.errors, abi.events);
})();

// ---------------------------------------------------------------------------------------------
// The recorded V3 blocks

/** A V3 block as the fakes serve it: its header, the set id in its state, and its own clean finality proof. */
export interface V3Block {
  number: number;
  hash: Hex;
  header: RpcHeader;
  /** Grandpa.CurrentSetId in its state. */
  setId: bigint;
  /** grandpa_proveFinality at the block: the block, its justification, no unknown headers. */
  proof: Hex;
}

/** Lock 1's bundle, read at V3 #118,637 (set 33) for the mint of README row 55. */
export const bundle = readJson("fixtures/v3-testnet-lock1/mint-bundle.json");
/** The set changes #118,123 (32 to 33), #121,706 (33 to 34) and #125,299 (34 to 35), read from the V3 node. */
export const fixture = readJson("site/test/fixtures/v3-set-changes.json");

const rpcHeaderOf = (h: { parentHash: string; number: number; stateRoot: string; extrinsicsRoot: string; digest: { scale: string }[] }): RpcHeader => ({
  parentHash: h.parentHash,
  number: `0x${h.number.toString(16)}`,
  stateRoot: h.stateRoot,
  extrinsicsRoot: h.extrinsicsRoot,
  digest: { logs: h.digest.map((d) => d.scale) },
});

/** Lock 1's block #118,637, where its bundle was read. */
export const B: V3Block = { number: bundle.header.number, hash: bundle.header.hash, header: rpcHeaderOf(bundle.header), setId: 33n, proof: bundle.finalityProof.scale };
/** S0 #118,123, S1 #121,706, S2 #125,299. */
export const [S0, S1, S2] = (fixture.changes as { number: number; hash: Hex; header: RpcHeader; proveFinality: Hex; setId: Hex }[]).map(
  (c): V3Block => ({ number: c.number, hash: c.hash, header: c.header, setId: decodeU64(hexToBytes(c.setId), "Grandpa.CurrentSetId"), proof: c.proveFinality }),
) as [V3Block, V3Block, V3Block];

/** The two V3 keys, the same in every set since the client's checkpoint. */
export const KEYS: Hex[] = bundle.signingSet.authorities.map((a: { id: Hex }) => a.id);

/** Lock 1 as its Locked log gives it: 1 tPOT for 0xD983…1071 in V3 #118,636. */
export const LOCK1: LockRef = {
  nonce: 1n,
  block: bundle.parentHeader.number,
  amount: BigInt(bundle.lock.amountNative),
  recipient: bundle.lock.recipient,
  commitment: bundle.lock.commitment,
};

/** The light client's latest headers the records hold: #116,992 (set 32) and #118,614 (set 33), both head imports. */
export const HELD_116992 = { number: 116_992, hash: "0x31a710c60cf68d426027f081dda3318f9b84bd779da51d61b253008efa06fa7d" as Hex };
export const HELD_118614 = { number: 118_614, hash: "0x59a60ac996da928bc282fca935b0451584cf37391a6a0aeecb4712e5a5fc9dab" as Hex };

/**
 * grandpa_proveFinality as a node answers it: the justification of the first of `ends` at or after
 * n (the last block of n's set, or the head in the set still running), with the headers after n up
 * to it. Here only the last of those headers, the proven block's own, which is all the proof core
 * reads of them. None past the last of `ends`.
 */
export function proveFrom(ends: V3Block[]): (n: number) => Hex | null {
  const sorted = [...ends].sort((a, b) => a.number - b.number);
  return (n) => {
    const e = sorted.find((x) => x.number >= n);
    if (!e) return null;
    if (e.number === n) return e.proof;
    const p = decodeFinalityProof(hexToBytes(e.proof));
    return bytesToHex(concatBytes(p.block, encodeCompact(p.justification.length), p.justification, encodeCompact(1), encodeRpcHeader(e.header)));
  };
}

// ---------------------------------------------------------------------------------------------
// fetch

export class RpcFail extends Error {
  readonly code: number;
  readonly data: Hex | undefined;

  constructor(code: number, message: string, data?: Hex) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

type Handler = (method: string, params: unknown[]) => unknown;

export interface Seen {
  url: string;
  method: string;
  params: unknown[];
}

interface Call {
  id: number;
  method: string;
  params: unknown[];
}

const realFetch = globalThis.fetch;

/** fetch answered by `routes`, each a fake node at a URL; returns every call they were asked, in order. */
export function fakeFetch(routes: Record<string, Handler>): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = (async (url: string | URL, init: { body: string }) => {
    const u = String(url);
    const route = routes[u];
    if (!route) throw new TypeError(`no fake node at ${u}`);
    const payload = JSON.parse(init.body) as Call | Call[];
    const answer = (c: Call) => {
      seen.push({ url: u, method: c.method, params: c.params });
      try {
        if (/^(eth_send|eth_sign|personal_|author_)/.test(c.method)) throw new RpcFail(-32601, `a test sent ${c.method}`);
        return { jsonrpc: "2.0", id: c.id, result: route(c.method, c.params) };
      } catch (e) {
        const f = e instanceof RpcFail ? e : new RpcFail(-32601, `the fake node has no answer: ${(e as Error).message}`);
        return { jsonrpc: "2.0", id: c.id, error: { code: f.code, message: f.message, ...(f.data ? { data: f.data } : {}) } };
      }
    };
    const body = Array.isArray(payload) ? payload.map(answer) : answer(payload);
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return seen;
}

export function restoreFetch(): void {
  globalThis.fetch = realFetch;
  resetBatching();
}

/** The V3 node over its HTTP endpoint only: a test never falls back to a WebSocket. */
export class HttpOnly extends SubstrateClient {
  override async request<T>(method: string, params: unknown[] = [], timeoutMs = 8000): Promise<Answer<T>> {
    if (!this.http) throw new Error("no HTTP endpoint");
    return request<T>([this.http], method, params, { timeoutMs, retries: 0 });
  }
}

// ---------------------------------------------------------------------------------------------
// The V3 node

export class FakeV3 {
  readonly endpoint: Endpoint = { id: "fake-v3", label: "fake V3 node", url: "https://v3.fake/" };
  readonly blocks = new Map<string, V3Block>();
  finalized: Hex = "0x";
  /** grandpa_proveFinality(n): null when the node has no proof to give. */
  prove: (n: number) => Hex | null = () => null;
  /** state_getReadProof and state_getChildReadProof answers, by `${block}|${key}` and `${block}|${child key}|${key}`. */
  readonly readProofs = new Map<string, Hex[]>();
  readonly childProofs = new Map<string, Hex[]>();
  /** Blocks whose state the node refuses, as a node that pruned it does. */
  readonly pruned = new Set<string>();

  add(...blocks: V3Block[]): this {
    for (const b of blocks) this.blocks.set(b.hash, b);
    return this;
  }

  /** Lock 1's two proofs at a block, as state_getReadProof and state_getChildReadProof serve them. */
  lockProofs(at: Hex, rootProof: Hex[], childProof: Hex[]): this {
    const rootKey = bytesToHex(childRootKey(hexToBytes(bundle.vault.trieId)));
    this.readProofs.set(`${at}|${rootKey}`, rootProof);
    this.childProofs.set(`${at}|${rootKey}|${bytesToHex(commitmentKey(1n))}`, childProof);
    return this;
  }

  private state(at: unknown): void {
    if (typeof at === "string" && this.pruned.has(at)) throw new RpcFail(4003, "State already discarded for block");
  }

  readonly handle: Handler = (method, params) => {
    switch (method) {
      case "chain_getFinalizedHead":
        return this.finalized;
      case "chain_getHeader":
        return this.blocks.get(String(params[0]))?.header ?? null;
      case "chain_getBlockHash":
        return [...this.blocks.values()].find((b) => b.number === params[0])?.hash ?? null;
      case "state_getStorage": {
        this.state(params[1]);
        const b = this.blocks.get(String(params[1]));
        return params[0] === GRANDPA_SET_ID_KEY && b ? bytesToHex(u64le(b.setId)) : null;
      }
      case "grandpa_proveFinality":
        return this.prove(Number(params[0]));
      case "state_getReadProof": {
        this.state(params[1]);
        const proof = this.readProofs.get(`${String(params[1])}|${String((params[0] as string[])[0])}`);
        if (!proof) throw new RpcFail(-32602, "the fake has no such read proof");
        return { at: params[1], proof };
      }
      case "state_getChildReadProof": {
        this.state(params[2]);
        const proof = this.childProofs.get(`${String(params[2])}|${String(params[0])}|${String((params[1] as string[])[0])}`);
        if (!proof) throw new RpcFail(-32602, "the fake has no such child read proof");
        return { at: params[2], proof };
      }
      default:
        throw new RpcFail(-32601, `the fake V3 node has no ${method}`);
    }
  };
}

// ---------------------------------------------------------------------------------------------
// Sepolia

const ABI = parseAbi([
  "function importAndMint(bytes header, bytes finalityProof, bytes signers, (bytes32 blockHash, bytes[] accountProof, bytes[] childRootProof, bytes[] slotProof, address recipient, uint256 amount, uint256 nonce) p)",
  "function mint((bytes32 blockHash, bytes[] accountProof, bytes[] childRootProof, bytes[] slotProof, address recipient, uint256 amount, uint256 nonce) p)",
  "function importHeader(bytes header, bytes justification, bytes signers) returns (bytes32)",
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);

export const enc = (types: string, values: readonly unknown[]): Hex => encodeAbiParameters(parseAbiParameters(types), values as never) as Hex;
export const revertData = (signature: string, types = "", values: readonly unknown[] = []): Hex => `${selector(signature)}${types ? enc(types, values).slice(2) : ""}` as Hex;
export const MULTICALL_FAILED = revertData("Error(string)", "string", ["Multicall3: call failed"]);

/** What one transaction does in a dry run: its gas, its revert data, or the node's refusal. */
export type Outcome = { gas: bigint } | { revert: Hex } | { fail: RpcFail };

export interface FakeSet {
  setId: bigint;
  activatedAt: number;
  keys: Hex[];
}

interface Tx {
  to: string;
  data: Hex;
}

export class FakeSepolia {
  readonly endpoint: Endpoint = { id: "fake-sepolia", label: "fake Sepolia", url: "https://sepolia.fake/", batch: 8 };
  client = {
    setId: 33n,
    latest: HELD_118614 as { number: number; hash: Hex },
    paused: false,
    halted: false,
    sets: [] as FakeSet[],
    /** headerOf(hash): what the client holds. */
    held: new Map<string, { number: number; stateRoot: Hex; setId: bigint }>(),
  };
  minter = { used: new Set<bigint>(), trieId: bundle.vault.trieId as Hex, codeHash: bundle.vault.codeHash as Hex };
  readonly code = new Map<string, Hex>([[MULTICALL3.toLowerCase(), fixture.multicall3.code as Hex]]);
  simulateAvailable = true;
  /** Every dry run of a transaction: by default the gas of its calls, NonceAlreadyUsed for a used nonce. */
  run: (tx: Tx) => Outcome = (tx) => this.gasOf(tx);

  /** The fake's own gas for a call: about what Sepolia measured (docs/BRIDGE.md, the research of Oct 24). */
  gasOf(tx: Tx): Outcome {
    const to = tx.to.toLowerCase();
    if (to === MULTICALL3.toLowerCase()) {
      let gas = 30_000n;
      for (const c of this.inner(tx.data)) {
        const o = this.run({ to: c.target, data: c.callData });
        if ("fail" in o) return o;
        if ("revert" in o) {
          if (!c.allowFailure) return { revert: MULTICALL_FAILED };
          gas += 300_000n;
        } else gas += o.gas;
      }
      return { gas };
    }
    const d = decodeFunctionData({ abi: ABI, data: tx.data as ViemHex });
    if (to === MINTER && (d.functionName === "importAndMint" || d.functionName === "mint")) {
      const p = d.functionName === "mint" ? d.args[0] : d.args[3];
      if (this.minter.used.has(p.nonce)) return { revert: revertData("NonceAlreadyUsed(uint256)", "uint256", [p.nonce]) };
      return { gas: d.functionName === "mint" ? 601_970n : 2_466_245n };
    }
    if (to === LIGHT_CLIENT && d.functionName === "importHeader") return { gas: 2_393_040n };
    throw new RpcFail(-32601, `the fake has no call ${d.functionName} to ${tx.to}`);
  }

  /** aggregate3's calls. */
  inner(data: Hex): readonly { target: string; allowFailure: boolean; callData: Hex }[] {
    const d = decodeFunctionData({ abi: ABI, data: data as ViemHex });
    if (d.functionName !== "aggregate3") throw new RpcFail(-32601, "not aggregate3");
    return d.args[0];
  }

  private view(to: string, data: Hex): Hex {
    const sel = data.slice(0, 10);
    const args = `0x${data.slice(10)}`;
    const is = (sig: string) => sel === selector(sig);
    const c = this.client;
    if (to === LIGHT_CLIENT) {
      if (is("currentSetId()")) return enc("uint64", [c.setId]);
      if (is("latestFinalized()")) return enc("bytes32,uint32", [c.latest.hash, c.latest.number]);
      if (is("paused()")) return enc("bool", [c.paused]);
      if (is("halted()")) return enc("bool", [c.halted]);
      if (is("authoritySetCount()")) return enc("uint256", [BigInt(c.sets.length)]);
      if (is("authorities(uint64)")) {
        const id = decode("uint64", args)[0] as bigint;
        const set = c.sets.find((s) => s.setId === id);
        if (!set) throw new RpcFail(3, "execution reverted", revertData("UnknownAuthoritySet(uint64)", "uint64", [id]));
        return enc("bytes32[]", [set.keys]);
      }
      if (is("authoritySetAt(uint256)")) {
        const set = c.sets[Number(decode("uint256", args)[0] as bigint)];
        if (!set) throw new RpcFail(3, "execution reverted", revertData("Panic(uint256)", "uint256", [0x32n]));
        return enc("(bytes32,bytes32,uint64,uint32),bytes32[]", [[GENESIS, `0x${"ab".repeat(32)}`, set.setId, set.activatedAt], set.keys]);
      }
      if (is("headerOf(bytes32)")) {
        const hash = decode("bytes32", args)[0] as Hex;
        const h = c.held.get(hash);
        if (!h) throw new RpcFail(3, "execution reverted", revertData("UnknownBlock(bytes32)", "bytes32", [hash]));
        return enc("(uint32,bytes32,uint64)", [[h.number, h.stateRoot, h.setId]]);
      }
    }
    if (to === MINTER) {
      if (is("used(uint256)")) return enc("bool", [this.minter.used.has(decode("uint256", args)[0] as bigint)]);
      if (is("vaultTrieId()")) return enc("bytes32", [this.minter.trieId]);
      if (is("vaultCodeHash()")) return enc("bytes32", [this.minter.codeHash]);
    }
    throw new RpcFail(-32601, `the fake has no view ${sel} on ${to}`);
  }

  private outcomeJson(tx: Tx) {
    const o = this.run(tx);
    if ("fail" in o) throw o.fail;
    if ("revert" in o) return { status: "0x0", gasUsed: "0x5208", returnData: o.revert, error: { message: "execution reverted", data: o.revert } };
    const returnData = tx.to.toLowerCase() === MULTICALL3.toLowerCase() ? this.results(tx.data) : "0x";
    return { status: "0x1", gasUsed: `0x${o.gas.toString(16)}`, returnData };
  }

  /** aggregate3's return value: each call's success and return data (its revert data when it failed). */
  private results(data: Hex): Hex {
    return enc("(bool,bytes)[]", [
      this.inner(data).map((c) => {
        const o = this.run({ to: c.target, data: c.callData });
        if ("fail" in o) throw o.fail;
        return "revert" in o ? [false, o.revert] : [true, "0x"];
      }),
    ]);
  }

  readonly handle: Handler = (method, params) => {
    const tx = params[0] as Tx;
    switch (method) {
      case "eth_call": {
        const to = tx.to.toLowerCase();
        if (to !== MULTICALL3.toLowerCase()) return this.view(to, tx.data);
        const o = this.run(tx);
        if ("fail" in o) throw o.fail;
        if ("revert" in o) throw new RpcFail(3, "execution reverted", o.revert);
        return this.results(tx.data);
      }
      case "eth_estimateGas": {
        const o = this.run(tx);
        if ("fail" in o) throw o.fail;
        if ("revert" in o) throw new RpcFail(3, "execution reverted", o.revert);
        return `0x${o.gas.toString(16)}`;
      }
      case "eth_simulateV1": {
        if (!this.simulateAvailable) throw new RpcFail(-32601, "the method eth_simulateV1 does not exist/is not available");
        const { blockStateCalls } = params[0] as { blockStateCalls: { calls: Tx[] }[] };
        return blockStateCalls.map((b) => ({ calls: b.calls.map((c) => this.outcomeJson(c)) }));
      }
      case "eth_getCode":
        return this.code.get(String(params[0]).toLowerCase()) ?? "0x";
      default:
        throw new RpcFail(-32601, `the fake Sepolia node has no ${method}`);
    }
  };
}

// ---------------------------------------------------------------------------------------------
// Both, for the planner

export interface Chains {
  v3: FakeV3;
  sepolia: FakeSepolia;
  seen: Seen[];
  env: ProofEnv;
}

/** A V3 node and a Sepolia node, faked, and the ProofEnv that reads them. */
export function fakeChains(): Chains {
  const v3 = new FakeV3();
  const sepolia = new FakeSepolia();
  const seen = fakeFetch({ [v3.endpoint.url]: v3.handle, [sepolia.endpoint.url]: sepolia.handle });
  const env: ProofEnv = {
    sepolia: [sepolia.endpoint],
    v3: new HttpOnly(v3.endpoint, { id: "fake-v3-ws", label: "no WebSocket", url: "wss://v3.fake/" }),
    lightClient: LIGHT_CLIENT,
    minter: MINTER,
    vault: VAULT,
    multicall: MULTICALL3,
    v3ChainId: 420_420_777n,
    sepoliaChainId: 11_155_111n,
    registry,
  };
  return { v3, sepolia, seen, env };
}
