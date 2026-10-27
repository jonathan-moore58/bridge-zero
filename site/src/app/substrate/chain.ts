// Portaldot V3's Substrate side, for a lock from a Polkadot wallet, through @polkadot/api 17.0.2:
// the relayer's library, version and configuration (relayer/src/v3-vault.ts), which has signed and
// finalized revive extrinsics on V3. This module is the page's lazy chunk: it is loaded only when a
// visitor picks a Polkadot wallet, so nothing of the library is in the page's first load.
//
// It connects to V3's node once and refuses another chain (genesis, pallet-revive's chain id, the
// EVM RPC's); dry-runs the lock from the account (reviveApi.call, read-only) and takes the
// relayer's limits from it; quotes the fee; builds revive.call and refuses unless its bytes are the
// ones ./call.ts encodes; has the wallet sign it once, checking the payload before the wallet sees
// it; asks V3 whether it would take the signed extrinsic (validate_transaction, read-only); and
// broadcasts it. Then it finds the extrinsic in V3's blocks, and its events: ExtrinsicSuccess or
// ExtrinsicFailed, and the vault's Locked event, which V3 emits as Revive.ContractEmitted (V3's EVM
// RPC serves no log of a Substrate extrinsic, so eth_getLogs never shows it).
//
// WebAssembly is never started: the page's Content-Security-Policy does not allow it, and the
// library's JavaScript paths do all this page needs (hashes and SS58; the wallet signs).

import { ApiPromise, WsProvider } from "@polkadot/api";
import type { SignerOptions, SubmittableExtrinsic } from "@polkadot/api/types";
import { checksum } from "../../lib/display.ts";
import { bytesToHex, type Hex } from "../../lib/hex.ts";
import type { ReceiptLog } from "../txmath.ts";
import { shortSs58 } from "./account.ts";
import { ERA_PERIOD, V3_CHAIN, V3_GENESIS, eraWindow, limitsOf, lockData, payloadProblem, readDryRun, reviveCall, type DryRun, type PayloadJson } from "./call.ts";
import type { InjectedSigner, SignerResult } from "./inject.ts";
import { NodeRefused, PayloadRefused, type LockChain, type LockPrep, type PreparedLock, type SignedLock } from "./send.ts";
import type { ExtrinsicRef } from "../model.ts";

/** What the chunk is given by the page: the node, the contracts, the EVM RPC's chain id and how the contracts name a revert. */
export interface ChainEnv {
  node: string;
  vault: Hex;
  minter: Hex;
  sepoliaChainId: bigint;
  evmChainId: () => Promise<bigint>;
  revertText: (data: Hex) => string;
}

/** An extrinsic found in a block: where, and its hash. */
export interface Found {
  block: number;
  blockHash: Hex;
  index: number;
  hash: Hex;
}

/** What a found extrinsic did: its events in its phase. */
export type Outcome = { ok: true; logs: ReceiptLog[] } | { ok: false; error: string };

/** The node did not answer in time, or serves another chain. */
export class ChainError extends Error {
  override name = "ChainError";
}

const CONNECT_MS = 20_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      t = setTimeout(() => reject(new ChainError(`${what}: no answer after ${ms / 1000} s`)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

type AnyCall = (...args: unknown[]) => Promise<{ toJSON(): unknown }>;
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// The library's decorated sections (consts, query, tx, call) are read without its generated
// augmentation, which this page does not load: through these few shapes, each checked to exist.
type Section = Record<string, unknown>;
type Sections = Record<string, Section | undefined>;

function member<T>(root: unknown, section: string, name: string): T {
  const v = (root as Sections)[section]?.[name];
  if (v === undefined || v === null) throw new ChainError(`V3's runtime has no ${section}.${name}`);
  return v as T;
}

/** A constant as a bigint. */
const constOf = (api: ApiPromise, section: string, name: string): bigint => BigInt(member<{ toString(): string }>(api.consts, section, name).toString());

/** System.Account of an account: its nonce and its free balance. */
interface AccountInfo {
  nonce: { toNumber(): number };
  data: { free: { toBigInt(): bigint } };
}

/** One of System.Events: its phase and its event. */
interface EventRecord {
  phase: { isApplyExtrinsic: boolean; asApplyExtrinsic: { toNumber(): number } };
  event: { section: string; method: string; data: ArrayLike<unknown> & { toJSON(): unknown } };
}

type Query = (...args: unknown[]) => Promise<unknown>;

/** The words for a module error the dry run named. */
function moduleWords(name: string): string {
  if (name === "revive.TransferFailed") return "your account cannot pay this amount and the storage deposit (revive.TransferFailed)";
  if (name === "revive.StorageDepositNotEnoughFunds") return "your account cannot pay the storage deposit (revive.StorageDepositNotEnoughFunds)";
  if (name === "revive.AccountUnmapped") return "your account has no address on V3 yet (revive.AccountUnmapped)";
  return name;
}

export class V3Chain implements LockChain {
  private readonly api: ApiPromise;
  private readonly env: ChainEnv;

  private constructor(api: ApiPromise, env: ChainEnv) {
    this.api = api;
    this.env = env;
  }

  /** An SS58 address's account id, as V3's registry reads it, for comparing accounts whatever their prefix. */
  private idOf(address: string): Hex {
    return this.api.createType("AccountId32", address).toHex();
  }

  /** Connects to V3's node and checks it is Portaldot V3 testnet: its genesis, pallet-revive's chain id and the EVM RPC's. */
  static async connect(env: ChainEnv): Promise<V3Chain> {
    const provider = new WsProvider(env.node, 2_500, {}, 60_000);
    let api: ApiPromise;
    try {
      api = await withTimeout(
        ApiPromise.create({
          provider,
          noInitWarn: true,
          initWasm: false,
          // Two transaction extensions @polkadot/types does not know; in V3's metadata both are empty,
          // with no implicit data: they add nothing to the extrinsic or to what the wallet signs.
          signedExtensions: { AuthorizeCall: { extrinsic: {}, payload: {} }, EthSetOrigin: { extrinsic: {}, payload: {} } },
        }),
        CONNECT_MS,
        "Portaldot V3's node",
      );
    } catch (e) {
      await provider.disconnect().catch(() => undefined);
      throw e instanceof ChainError ? e : new ChainError(`Portaldot V3's node: ${errText(e)}`);
    }
    const chain = new V3Chain(api, env);
    try {
      await chain.checkChain();
    } catch (e) {
      await api.disconnect().catch(() => undefined);
      throw e;
    }
    return chain;
  }

  private async checkChain(): Promise<void> {
    const genesis = this.api.genesisHash.toHex();
    if (genesis !== V3_GENESIS) throw new ChainError(`the node serves genesis ${genesis.slice(0, 10)}…, not Portaldot V3 testnet's`);
    const revive = constOf(this.api, "revive", "chainId");
    const evm = await this.env.evmChainId();
    if (revive !== V3_CHAIN || evm !== V3_CHAIN) throw new ChainError(`the chain id is not V3's ${V3_CHAIN} (pallet-revive ${String(revive)}, EVM RPC ${evm})`);
  }

  private reviveApi(name: string): AnyCall {
    const fn = (this.api.call as unknown as Record<string, Record<string, AnyCall | undefined> | undefined>).reviveApi?.[name];
    if (!fn) throw new ChainError(`V3's runtime has no reviveApi.${name}`);
    return fn;
  }

  /** A module error by its pallet index and first error byte, as section.name. */
  private errorName(index: number, error: number): string {
    try {
      const m = this.api.registry.findMetaError(Uint8Array.of(index, error));
      return `${m.section}.${m.name}`;
    } catch {
      return `module ${index}, error ${error}`;
    }
  }

  /** reviveApi.call(origin, vault, value, None, None, data): the lock run on V3's state, read-only. */
  async dryRun(origin: string, value: bigint, data: Hex): Promise<DryRun> {
    const r = await this.reviveApi("call")(origin, this.env.vault, value, null, null, data);
    return readDryRun(r.toJSON());
  }

  private build(prep: Pick<PreparedLock, "value" | "refTime" | "proofSize" | "depositLimit" | "data" | "call">): SubmittableExtrinsic<"promise"> {
    const make = member<(...a: unknown[]) => SubmittableExtrinsic<"promise">>(this.api.tx, "revive", "call");
    const tx = make(this.env.vault, prep.value, { refTime: prep.refTime, proofSize: prep.proofSize }, prep.depositLimit, prep.data);
    if (tx.method.toHex() !== prep.call) throw new PayloadRefused("the call @polkadot/api built differs from the one this page encodes");
    return tx;
  }

  private account(origin: string, at: unknown = this.api): Promise<AccountInfo> {
    return member<Query>((at as { query: unknown }).query, "system", "account")(origin) as Promise<AccountInfo>;
  }

  /**
   * The Substrate account pallet-revive maps this address to (revive.originalAccount), in SS58; null
   * for any other address. An Ethereum key's address is never in that map: V3 derives its account.
   */
  async originalAccount(address: Hex): Promise<string | null> {
    const o = (await member<Query>(this.api.query, "revive", "originalAccount")(address)) as { isSome?: boolean; unwrap?: () => { toString(): string } };
    return o.isSome === true && typeof o.unwrap === "function" ? o.unwrap().toString() : null;
  }

  async prepareLock(origin: string, amount: bigint, recipient: Hex): Promise<LockPrep> {
    const data = lockData(this.env.sepoliaChainId, this.env.minter, recipient);
    const [owner, dry, account, header] = await Promise.all([this.originalAccount(recipient), this.dryRun(origin, amount, data), this.account(origin), this.api.rpc.chain.getHeader()]);
    if (owner) {
      // Any Substrate account's address on V3 is a hash no Ethereum key matches: wtPOT minted there could never move.
      return {
        problem: {
          title: "That recipient is a Polkadot account's address",
          text: `${checksum(recipient)} is the address V3 gives the Substrate account ${shortSs58(owner)}. No Ethereum key holds it, so wtPOT minted there would be stuck. Give an address your Ethereum wallet controls. Nothing was sent.`,
        },
      };
    }
    const free = account.data.free.toBigInt();
    if (!dry.ok) {
      const why = typeof dry.error === "object" && dry.error ? moduleWords(this.errorName(dry.error.index, dry.error.error)) : String(dry.error);
      return { problem: { title: "V3 would not run this lock", text: `Its dry run from your account failed: ${why}. Nothing was sent.` } };
    }
    if (dry.reverted) return { problem: { title: "The vault would refuse this lock", text: `Its dry run on V3 reverted: ${this.env.revertText(dry.data)}. Nothing was sent.` } };
    const limits = limitsOf(dry);
    const call = reviveCall({ vault: this.env.vault, value: amount, refTime: limits.refTime, proofSize: limits.proofSize, depositLimit: limits.depositLimit, data });
    const base = { call, data, value: amount, refTime: limits.refTime, proofSize: limits.proofSize, depositLimit: limits.depositLimit };
    const tx = this.build(base);
    const fee = (await tx.paymentInfo(origin)).partialFee.toBigInt();
    const ed = constOf(this.api, "balances", "existentialDeposit");
    const need = amount + limits.depositLimit + fee + ed;
    if (free < need) {
      const t = (v: bigint) => (Number(v) / 1e14).toLocaleString("en-US", { maximumFractionDigits: 4 });
      return {
        problem: {
          title: "Not enough tPOT for the lock",
          text: `The lock needs ${t(need)} tPOT of your account: ${t(amount)} locked, up to ${t(limits.depositLimit)} of storage deposit, ${t(fee)} of fee, and ${t(ed)} that stays in the account. It has ${t(free)}. Nothing was sent.`,
        },
      };
    }
    const deposit = dry.deposit > 0n ? dry.deposit : 0n;
    return { ...base, deposit, fee, returns: dry.returns, free, need, head: header.number.toNumber() };
  }

  async signLock(prep: PreparedLock, origin: string, signer: InjectedSigner, onAsk: (ext: ExtrinsicRef) => void): Promise<SignedLock> {
    const sign = signer.signPayload;
    if (!sign) throw new PayloadRefused("the wallet cannot sign payloads");
    const tx = this.build(prep);
    const nonce = (await this.api.rpc.system.accountNextIndex(origin)).toNumber();
    let ext: ExtrinsicRef | null = null;
    let returned: SignerResult | null = null;
    const guard = {
      signPayload: async (payload: PayloadJson): Promise<SignerResult> => {
        const why = payloadProblem(payload, { address: origin, call: prep.call, genesis: V3_GENESIS });
        if (why) throw new PayloadRefused(why);
        if (Number(BigInt(payload.nonce)) !== nonce) throw new PayloadRefused(`its nonce is ${BigInt(payload.nonce)}, not ${nonce}`);
        const w = eraWindow(payload.era, Number(BigInt(payload.blockNumber)));
        ext = { nonce, from: w.from, to: w.to };
        onAsk(ext);
        returned = await sign({ ...payload, withSignedTransaction: true });
        return returned;
      },
    };
    // allowCallDataAlteration (read by the library, not in its option type): a wallet that returns its
    // own signed extrinsic may add what it must (a metadata hash), never change the call.
    const options = { signer: guard, nonce, era: ERA_PERIOD, tip: 0, withSignedTransaction: true, allowCallDataAlteration: false } as unknown as Partial<SignerOptions>;
    await tx.signAsync(origin, options);
    const got = returned as SignerResult | null;
    const asked = ext as ExtrinsicRef | null;
    if (!got || !asked) throw new PayloadRefused("the wallet was not asked");
    const raw = got.signedTransaction;
    const hex: Hex = raw === undefined ? tx.toHex() : typeof raw === "string" ? (raw.toLowerCase() as Hex) : bytesToHex(raw);
    // What goes on chain, read back: signed, by the account, at the nonce, with the lock's call.
    const x = this.api.createType("Extrinsic", hex);
    if (!x.isSigned || this.idOf(x.signer.toString()) !== this.idOf(origin) || x.nonce.toNumber() !== nonce || x.method.toHex() !== prep.call) {
      throw new PayloadRefused("the extrinsic your wallet returned is not the lock it was asked to sign");
    }
    return { hash: x.hash.toHex(), hex, ext: asked };
  }

  async validate(hex: Hex): Promise<string | null> {
    const best = await this.api.rpc.chain.getBlockHash();
    const fn = (this.api.call as unknown as Record<string, Record<string, AnyCall | undefined> | undefined>).taggedTransactionQueue?.validateTransaction;
    if (!fn) return null;
    const r = (await fn("External", hex, best)).toJSON() as { ok?: unknown; err?: unknown } | null;
    if (r && r.ok !== undefined) return null;
    const err = r?.err as { invalid?: Record<string, unknown> | string; unknown?: Record<string, unknown> | string } | undefined;
    const kind = typeof err?.invalid === "string" ? err.invalid : err?.invalid ? Object.keys(err.invalid)[0] : null;
    const words: Record<string, string> = {
      badProof: "its signature does not check out",
      payment: "your account cannot pay its fee",
      stale: "its nonce is used already",
      future: "its nonce is ahead of your account's",
      ancientBirthBlock: "its era has ended",
      exhaustsResources: "V3's blocks are full",
      badSigner: "V3 does not take its signer",
    };
    if (kind) return `V3 says ${words[kind] ?? kind}`;
    return `V3 says it is invalid: ${JSON.stringify(err ?? r).slice(0, 160)}`;
  }

  async submit(hex: Hex): Promise<void> {
    try {
      await this.api.rpc.author.submitExtrinsic(hex);
    } catch (e) {
      const text = errText(e);
      if (/^\s*10[01]\d\b|Invalid Transaction|Priority is too low|Already Imported|temporarily banned/i.test(text)) throw new NodeRefused(text.split("\n")[0] ?? text);
      throw e;
    }
  }

  /** V3's best block number. */
  async best(): Promise<number> {
    return (await this.api.rpc.chain.getHeader()).number.toNumber();
  }

  /** V3's best and finalized block numbers. */
  async heads(): Promise<{ best: number; finalized: number }> {
    const [best, fin] = await Promise.all([this.api.rpc.chain.getHeader(), this.api.rpc.chain.getFinalizedHead()]);
    const f = await this.api.rpc.chain.getHeader(fin);
    return { best: best.number.toNumber(), finalized: f.number.toNumber() };
  }

  /** The hash of V3's block at height `n` on its best chain, which is its final chain once V3 has finalized past `n`; null when it has none. */
  async hashAt(n: number): Promise<Hex | null> {
    const h = await this.api.rpc.chain.getBlockHash(n);
    return h.isEmpty ? null : (h.toHex().toLowerCase() as Hex);
  }

  /** The account's nonce in V3's state at its finalized block: past `n`, an extrinsic of the account with nonce n is final. */
  async finalNonce(origin: string): Promise<number> {
    const fin = await this.api.rpc.chain.getFinalizedHead();
    const at = await this.api.at(fin);
    return (await this.account(origin, at)).nonce.toNumber();
  }

  /**
   * The extrinsic with this hash in V3's blocks `from` to `to` (best chain), looked at in order; or,
   * by `signer` and `nonce`, the one that took that nonce. `scanned`: the last block looked at.
   */
  async find(q: { hash: Hex; signer: string; nonce: number }, from: number, to: number): Promise<{ found: Found | null; other: Found | null; scanned: number }> {
    const who = this.idOf(q.signer);
    let scanned = from - 1;
    for (let n = from; n <= to; n++) {
      const blockHash = await this.api.rpc.chain.getBlockHash(n);
      if (blockHash.isEmpty) break;
      const block = await this.api.rpc.chain.getBlock(blockHash);
      const list = block.block.extrinsics;
      for (let i = 0; i < list.length; i++) {
        const x = list[i];
        if (!x) continue;
        const hash = x.hash.toHex();
        const at: Found = { block: n, blockHash: blockHash.toHex(), index: i, hash };
        if (hash === q.hash) return { found: at, other: null, scanned: n };
        if (x.isSigned && x.nonce.toNumber() === q.nonce && this.idOf(x.signer.toString()) === who) return { found: null, other: at, scanned: n };
      }
      scanned = n;
    }
    return { found: null, other: null, scanned };
  }

  /** What the extrinsic did: ExtrinsicFailed (named), or ExtrinsicSuccess and the vault's events as logs. */
  async outcome(f: Found): Promise<Outcome> {
    const at = await this.api.at(f.blockHash);
    const records = (await member<Query>(at.query, "system", "events")()) as EventRecord[];
    const mine = Array.from(records).filter((r) => r.phase.isApplyExtrinsic && r.phase.asApplyExtrinsic.toNumber() === f.index);
    const failed = mine.find((r) => r.event.section === "system" && r.event.method === "ExtrinsicFailed");
    if (failed) {
      const d = failed.event.data[0] as unknown as { isModule?: boolean; asModule?: { index: { toNumber(): number }; error: { toU8a(): Uint8Array } }; toString(): string } | undefined;
      let error = d ? d.toString() : "ExtrinsicFailed";
      if (d?.isModule && d.asModule) error = this.errorName(d.asModule.index.toNumber(), d.asModule.error.toU8a()[0] ?? 0);
      return { ok: false, error };
    }
    if (!mine.some((r) => r.event.section === "system" && r.event.method === "ExtrinsicSuccess")) return { ok: false, error: "no ExtrinsicSuccess in its block's events" };
    const logs: ReceiptLog[] = [];
    for (const r of mine) {
      if (r.event.section !== "revive" || r.event.method !== "ContractEmitted") continue;
      const j = r.event.data.toJSON() as unknown;
      const [contract, data, topics] = Array.isArray(j) ? j : [(j as Record<string, unknown>).contract, (j as Record<string, unknown>).data, (j as Record<string, unknown>).topics];
      if (typeof contract !== "string" || typeof data !== "string" || !Array.isArray(topics)) continue;
      logs.push({ address: contract.toLowerCase(), data: data.toLowerCase(), topics: topics.map((t) => String(t).toLowerCase()) });
    }
    return { ok: true, logs };
  }

  async disconnect(): Promise<void> {
    await this.api.disconnect().catch(() => undefined);
  }
}

let connecting: Promise<V3Chain> | null = null;

/** The page's one connection to V3's node, made on first use; a failed one is made again next time. */
export function v3Chain(env: ChainEnv): Promise<V3Chain> {
  connecting ??= V3Chain.connect(env).catch((e: unknown) => {
    connecting = null;
    throw e;
  });
  return connecting;
}
