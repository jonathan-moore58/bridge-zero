// The page's live data: every read the page makes, in parallel, each with the recorded value it
// falls back to. A field is "live" (read from a chain just now, with the endpoint that answered),
// "recorded" (from the repository's records, because the live read failed) or "error" (no live
// answer and nothing recorded). Read-only: eth_call, eth_getLogs, eth_getStorageAt,
// eth_getTransactionByHash, eth_getTransactionReceipt, eth_blockNumber and Substrate chain_/state_
// reads. Nothing is signed or sent.

import { useEffect, useState } from "preact/hooks";
import { AbiRegistry, decode, encodeCall, type AbiValue, type DecodedError, type DecodedLog } from "./abi.ts";
import { decodeImportCall } from "./calls.ts";
import {
  GRANDPA_SET_ID_KEY,
  HERO_TX,
  LC,
  MAINNET_SUBSTRATE_WS,
  MINTER,
  RECIPIENT,
  SEPOLIA,
  SEPOLIA_HISTORY,
  SEPOLIA_LOGS,
  TOKEN,
  V3_EVM,
  V3_SUBSTRATE_HTTP,
  V3_SUBSTRATE_WS,
  VAULT,
  records,
} from "./chains.ts";
import { eventTopic } from "./hashes.ts";
import { hexToBytes, leToBigInt, type Hex } from "./hex.ts";
import type { Attack } from "./records-types.ts";
import { failure, nextField, type Field, type FieldStatus, type Recorded } from "./field.ts";
import { AllFailed, NodeError, request, SubstrateClient } from "./rpc.ts";
import { decodeTimestampInherent, precommitPayload } from "./scale.ts";

export const registry = new AbiRegistry(records.abi.errors, records.abi.events);

// ---------------------------------------------------------------------------------------------
// Field types

export interface LcState {
  setId: bigint;
  latestHash: Hex;
  latestNumber: number;
  threshold: number;
  paused: boolean | null;
  halted: boolean | null;
  admin: Hex | null;
}

export interface ChainHead {
  number: number;
  hash: Hex;
  setId: bigint | null;
}

export interface VaultState {
  outstanding: bigint;
  commitment0: Hex;
  nextNonce: bigint;
}

export interface LockLog {
  txHash: Hex;
  blockNumber: number;
  blockHash: Hex;
  nonce: bigint;
  sender: Hex;
  recipient: Hex;
  dstChainId: bigint;
  dstMinter: Hex;
  amountNative: bigint;
  commitment: Hex;
}

export interface MinterState {
  used0: boolean;
  trieId: Hex;
  burnCount: bigint;
}

export interface TokenState {
  totalSupply: bigint;
  recipientBalance: bigint;
}

export interface ReceiptView {
  txHash: Hex;
  status: number;
  blockNumber: number;
  gasUsed: number;
  from: Hex;
  to: Hex;
  effectiveGasPrice: bigint | null;
  logs: DecodedLog[];
}

export interface AuthoritySet {
  setId: bigint;
  keys: Hex[];
}

export interface CountedSignature {
  position: number;
  authorityIndex: number;
  id: Hex;
  signature: Hex;
  targetHash: Hex;
  targetNumber: number;
}

export interface ImportView {
  txHash: Hex;
  sepoliaBlock: number | null;
  method: string;
  number: number;
  blockHash: Hex;
  /** The set that signed: HeaderImported.setId, or the relayer record's set before the import. */
  setId: bigint;
  signatures: number;
  round: bigint | null;
  precommitCount: number | null;
  counted: CountedSignature[];
  /** Where the transaction hash came from: the client's own log, or the relayer's record. */
  foundBy: "log" | "record";
  /** True when the transaction's calldata could be read and decoded. */
  decoded: boolean;
  /** The keys of the set that signed, read from the client: authorities(setId). */
  signingKeys: Hex[] | null;
  note: string | null;
}

export interface BurnCheck {
  burnNonce: string;
  /** The burn id the records hold. */
  burnId: Hex;
  /** BridgeMinter.burnIdOf(burnNonce) on Sepolia. */
  onChain: Hex | null;
  /** PortaldotVault.released(burnId) on V3. */
  released: boolean | null;
}

/** The latest recorded transfer, checked again: BridgeMinter.used(nonce) on Sepolia. */
export interface RunMinterState {
  used: boolean;
}

/** The latest transfer's mint receipt, read again. */
export interface RunReceipt {
  status: number;
  blockNumber: number;
  gasUsed: number;
  /** The events it emitted, decoded with the contract sources' signatures (none when recorded). */
  events: string[];
  /** The mint block's timestamp, ms: the receipt's logs carry it (blockTimestamp), or the record. */
  blockTime: number | null;
}

/** The latest transfer's lock block on V3, read from the Substrate node: its Timestamp.set. */
export interface RunLockBlock {
  number: number;
  hash: Hex | null;
  /** ms since the epoch */
  at: number;
}

/** The latest transfer's commitment as the vault stores it: commitments(nonce) on V3. */
export interface RunVaultState {
  commitment: Hex;
}

export interface Fields {
  "run.minter": RunMinterState;
  "run.receipt": RunReceipt;
  "run.vault": RunVaultState;
  "run.lock": LockLog;
  "run.lockBlock": RunLockBlock;
  "sepolia.head": number;
  "return.checks": BurnCheck[];
  "lc.mainnet": LcState;
  "lc.v3": LcState;
  "chain.mainnet": ChainHead;
  "chain.v3": ChainHead;
  "v3.vault": VaultState;
  "v3.lock0": LockLog;
  "sepolia.minter": MinterState;
  "sepolia.token": TokenState;
  "receipt.hero": ReceiptView;
  "set.mainnet": AuthoritySet;
  "set.v3": AuthoritySet;
  "import.mainnet": ImportView;
}

export type FieldKey = keyof Fields;

export type { Field, FieldStatus };

// ---------------------------------------------------------------------------------------------
// Recorded values

const thresholdOf = (n: number) => n - Math.floor((n - 1) / 3);
const BR_FILE = "deployments/sepolia-bridge.json";
const V3_FILE = "deployments/v3-testnet.json";

/** The newest import the records hold for a client: the relayer's, or a mint's bundle block. */
function recordedLc(key: "mainnet" | "v3"): { value: LcState; from: string } | null {
  const lc = LC[key];
  const r = lc.latestImport;
  if (!r) return null;
  return {
    value: {
      setId: BigInt(r.setId),
      latestHash: r.hash,
      latestNumber: r.number,
      threshold: thresholdOf(lc.fixtureSet.keys.length),
      paused: null,
      halted: null,
      admin: records.sepolia.deployer.toLowerCase() as Hex,
    },
    from: r.from,
  };
}

function eventItem(name: string) {
  const item = records.abi.events.find((e) => e.name === name);
  if (!item) throw new Error(`no event ${name} in the contract sources`);
  return item;
}

function recordedLog(name: string, address: Hex, values: Record<string, AbiValue>): DecodedLog {
  const item = eventItem(name);
  return {
    name,
    signature: `${name}(${item.params.map((p) => p.type).join(",")})`,
    source: item.source,
    address,
    args: item.params.map((p) => {
      const v = values[p.name];
      if (v === undefined) throw new Error(`no recorded value for ${name}.${p.name}`);
      return { name: p.name, type: p.type, value: v };
    }),
  };
}

function recordedReceipt(): ReceiptView {
  const b = records.bridge;
  const amount = BigInt(b.mint.amountNative);
  return {
    txHash: b.mint.txHash,
    status: b.mint.status ?? 0,
    blockNumber: b.mint.block ?? 0,
    gasUsed: b.mint.gasUsed ?? 0,
    from: b.mint.sender,
    to: b.mint.to,
    effectiveGasPrice: b.mint.effectiveGasPrice ? BigInt(b.mint.effectiveGasPrice) : null,
    logs: [
      recordedLog("HeaderImported", LC.v3.address, {
        blockHash: b.finality.block.hash,
        number: BigInt(b.finality.block.number),
        stateRoot: b.finality.block.stateRoot,
        setId: BigInt(b.finality.setId),
        signatures: BigInt(b.finality.signers.count),
      }),
      recordedLog("VaultBound", MINTER, { vault: b.vault.address, trieId: b.proofs.account.trieId, blockHash: b.finality.block.hash }),
      recordedLog("Transfer", TOKEN, { from: "0x0000000000000000000000000000000000000000", to: b.mint.recipient, value: amount }),
      recordedLog("Minted", MINTER, { nonce: 0n, recipient: b.mint.recipient, amount, blockHash: b.finality.block.hash }),
    ],
  };
}

function recordedImport(): ImportView | null {
  const r = LC.mainnet.latestRelay;
  if (!r) return null;
  return {
    txHash: r.txHash,
    sepoliaBlock: r.sepoliaBlock,
    method: r.method,
    number: r.block.number,
    blockHash: r.block.hash,
    setId: BigInt(r.setBefore),
    signatures: r.signatures,
    round: null,
    precommitCount: null,
    counted: [],
    foundBy: "record",
    decoded: false,
    signingKeys: null,
    note: null,
  };
}

const RECORDED_BURNS: BurnCheck[] = records.returnPath.burns
  .filter((b) => b.burnNonce !== null && b.burnId !== null)
  .map((b) => ({
    burnNonce: b.burnNonce ?? "0",
    burnId: b.burnId as Hex,
    onChain: b.burnId,
    released: records.returnPath.releases.some((r) => r.burnId === b.burnId && r.status === "released"),
  }));

const RUN = records.latestRun;
const RUN_TIMES = RUN?.timing?.blockTimes ?? null;

const RECORDED: { [K in FieldKey]?: { value: Fields[K]; from: string } | null } = {
  "run.minter": RUN ? { value: { used: RUN.mint.status === 1 }, from: BR_FILE } : null,
  "run.receipt": RUN
    ? {
        value: { status: RUN.mint.status ?? 0, blockNumber: RUN.mint.block ?? 0, gasUsed: RUN.mint.gasUsed ?? 0, events: [], blockTime: RUN_TIMES ? Date.parse(RUN_TIMES.mint.at) : null },
        from: RUN_TIMES ? `${BR_FILE} and ${RUN.timing?.from}` : BR_FILE,
      }
    : null,
  "run.vault": RUN ? { value: { commitment: RUN.lock.commitment }, from: V3_FILE } : null,
  "run.lock": RUN
    ? {
        value: {
          txHash: RUN.lock.txHash,
          blockNumber: RUN.lock.block,
          blockHash: RUN.lock.evmBlockHash,
          nonce: BigInt(RUN.lock.nonce),
          sender: RUN.lock.from,
          recipient: RUN.lock.recipient,
          dstChainId: BigInt(RUN.lock.dstChainId),
          dstMinter: RUN.lock.dstMinter,
          amountNative: BigInt(RUN.lock.amountNative),
          commitment: RUN.lock.commitment,
        },
        from: V3_FILE,
      }
    : null,
  "run.lockBlock":
    RUN && RUN_TIMES
      ? {
          value: { number: RUN.lock.block, hash: RUN.bundle.parent.number === RUN.lock.block ? RUN.bundle.parent.hash : null, at: Date.parse(RUN_TIMES.lock.at) },
          from: RUN.timing?.from ?? "",
        }
      : null,
  "return.checks": RECORDED_BURNS.length ? { value: RECORDED_BURNS, from: `${BR_FILE} and ${V3_FILE}` } : null,
  "lc.mainnet": recordedLc("mainnet"),
  "lc.v3": recordedLc("v3"),
  "v3.vault": {
    value: { outstanding: BigInt(records.totals.outstandingNative), commitment0: records.bridge.lock.commitment, nextNonce: BigInt(records.totals.locks) },
    from: V3_FILE,
  },
  "v3.lock0": {
    value: {
      txHash: records.bridge.lock.txHash,
      blockNumber: records.bridge.lock.block.number,
      blockHash: records.bridge.lock.block.hash,
      nonce: 0n,
      sender: records.bridge.lock.from,
      recipient: records.bridge.lock.recipient,
      dstChainId: BigInt(records.bridge.lock.dstChainId),
      dstMinter: records.bridge.lock.dstMinter,
      amountNative: BigInt(records.bridge.lock.amountNative),
      commitment: records.bridge.lock.commitment,
    },
    from: V3_FILE,
  },
  "sepolia.minter": {
    value: {
      used0: records.bridge.mint.status === 1,
      trieId: records.bridge.proofs.account.trieId,
      burnCount: BigInt(records.returnPath.burns.filter((b) => b.ok && b.status === 1).length),
    },
    from: BR_FILE,
  },
  "sepolia.token": {
    value: { totalSupply: BigInt(records.totals.supply), recipientBalance: BigInt(records.totals.recipientBalance) },
    from: BR_FILE,
  },
  "receipt.hero": { value: recordedReceipt(), from: `${records.bridge.bundleFile} and ${BR_FILE}` },
  // The client's set by the records (the relayer's latest import), with the keys of a captured
  // fixture: the old mainnet's set ids move on with the same 10 keys (authorities(3895) and
  // authorities(3907) on the client are the same list).
  "set.mainnet": {
    value: { setId: BigInt(LC.mainnet.latestImport?.setId ?? LC.mainnet.fixtureSet.setId), keys: LC.mainnet.fixtureSet.keys },
    from: LC.mainnet.latestImport ? `${LC.mainnet.latestImport.from} (the set) and ${LC.mainnet.fixtureSet.from} (the keys)` : LC.mainnet.fixtureSet.from,
  },
  "set.v3": { value: { setId: BigInt(LC.v3.fixtureSet.setId), keys: LC.v3.fixtureSet.keys }, from: LC.v3.fixtureSet.from },
  "import.mainnet": (() => {
    const v = recordedImport();
    return v ? { value: v, from: LC.mainnet.latestImport?.from ?? "deployments/" } : null;
  })(),
};

// ---------------------------------------------------------------------------------------------
// The store

type Listener = () => void;

class Store {
  private readonly fields = new Map<FieldKey, Field<unknown>>();
  private readonly listeners = new Map<FieldKey, Set<Listener>>();

  get<K extends FieldKey>(key: K): Field<Fields[K]> {
    const f = this.fields.get(key);
    if (f) return f as Field<Fields[K]>;
    const rec = RECORDED[key];
    return { status: "loading", value: rec?.value as Fields[K] | undefined, from: rec?.from };
  }

  set<K extends FieldKey>(key: K, field: Field<Fields[K]>): void {
    this.fields.set(key, field as Field<unknown>);
    for (const l of this.listeners.get(key) ?? []) l();
  }

  subscribe(key: FieldKey, fn: Listener): () => void {
    let set = this.listeners.get(key);
    if (!set) this.listeners.set(key, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }
}

export const store = new Store();

export function useField<K extends FieldKey>(key: K): Field<Fields[K]> {
  const [, bump] = useState(0);
  useEffect(() => store.subscribe(key, () => bump((n) => n + 1)), [key]);
  return store.get(key);
}

/** The current time, updated every `ms`: for "read 20 s ago" labels. */
export function useNow(ms = 5000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const message = failure;

/** Reads `key` and stores what came of it, by the rule in ./field.ts: live, else the last live answer, else recorded, else an error. */
async function run<K extends FieldKey>(key: K, read: () => Promise<{ value: Fields[K]; endpoint: string }>): Promise<void> {
  const before = store.get(key);
  store.set(key, await nextField(before, read, RECORDED[key] as Recorded<Fields[K]> | null | undefined));
}

// ---------------------------------------------------------------------------------------------
// Reads

const HEADER_IMPORTED = eventTopic("HeaderImported(bytes32,uint32,bytes32,uint64,uint256)");
const LOCKED = eventTopic("Locked(uint256,address,address,uint256,address,uint256,bytes32)");

const ethCall = (endpoints: typeof SEPOLIA, to: string, data: string) => request<Hex>(endpoints, "eth_call", [{ to, data }, "latest"]);

const mainnetNode = new SubstrateClient(null, MAINNET_SUBSTRATE_WS);
const v3Node = new SubstrateClient(V3_SUBSTRATE_HTTP, V3_SUBSTRATE_WS);

function readSepoliaHead() {
  return run("sepolia.head", async () => {
    const a = await request<Hex>(SEPOLIA, "eth_blockNumber", []);
    return { value: Number(BigInt(a.result)), endpoint: a.endpoint.label };
  });
}

function readLightClient(key: "mainnet" | "v3") {
  return run(key === "mainnet" ? "lc.mainnet" : "lc.v3", async () => {
    const at = LC[key].address;
    const [set, latest, thr, paused, halted, admin] = await Promise.all(
      ["currentSetId()", "latestFinalized()", "threshold()", "paused()", "halted()", "admin()"].map((sig) => ethCall(SEPOLIA, at, encodeCall(sig))),
    );
    const [latestHash, latestNumber] = decode("bytes32,uint32", latest!.result) as [Hex, bigint];
    return {
      value: {
        setId: decode("uint64", set!.result)[0] as bigint,
        latestHash,
        latestNumber: Number(latestNumber),
        threshold: Number(decode("uint256", thr!.result)[0] as bigint),
        paused: decode("bool", paused!.result)[0] as boolean,
        halted: decode("bool", halted!.result)[0] as boolean,
        admin: decode("address", admin!.result)[0] as Hex,
      },
      endpoint: latest!.endpoint.label,
    };
  });
}

function readChainHead(key: "mainnet" | "v3") {
  const node = key === "mainnet" ? mainnetNode : v3Node;
  return run(key === "mainnet" ? "chain.mainnet" : "chain.v3", async () => {
    const fin = await node.request<Hex>("chain_getFinalizedHead", [], 9000);
    const [header, set] = await Promise.all([
      node.request<{ number: string }>("chain_getHeader", [fin.result], 9000),
      node.request<Hex | null>("state_getStorage", [GRANDPA_SET_ID_KEY, fin.result], 9000),
    ]);
    return {
      value: { number: Number(BigInt(header.result.number)), hash: fin.result, setId: set.result ? leToBigInt(hexToBytes(set.result)) : null },
      endpoint: fin.endpoint.label,
    };
  });
}

function readVault() {
  return run("v3.vault", async () => {
    const [out, c0, nonce] = await Promise.all([
      ethCall(V3_EVM, VAULT, encodeCall("outstanding()")),
      ethCall(V3_EVM, VAULT, encodeCall("commitments(uint256)", [0n])),
      request<Hex>(V3_EVM, "eth_getStorageAt", [VAULT, "0x1", "latest"]),
    ]);
    return {
      value: {
        outstanding: decode("uint256", out.result)[0] as bigint,
        commitment0: decode("bytes32", c0.result)[0] as Hex,
        nextNonce: BigInt(nonce.result),
      },
      endpoint: out.endpoint.label,
    };
  });
}

interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  /** Some nodes add the block's timestamp to each log (hex seconds). */
  blockTimestamp?: string;
}

/**
 * The vault's Locked event for one nonce, from the V3 EVM RPC (it still serves the logs it no
 * longer serves receipts for), in the one block the records put the lock in: a range that does
 * not grow with the chain.
 */
function readLockLog(key: "v3.lock0" | "run.lock", nonce: bigint, block: number) {
  return run(key, async () => {
    const topic = "0x" + nonce.toString(16).padStart(64, "0");
    const at = "0x" + block.toString(16);
    const a = await request<RawLog[]>(V3_EVM, "eth_getLogs", [{ address: VAULT, topics: [LOCKED, topic], fromBlock: at, toBlock: at }], {
      accept: (r) => Array.isArray(r) && r.length > 0,
      timeoutMs: 12000,
    });
    const log = a.result[0]!;
    const d = registry.decodeLog(log);
    if (!d || d.name !== "Locked") throw new Error("the vault's log does not decode as Locked");
    const arg = (n: string) => d.args.find((x) => x.name === n)?.value;
    if (arg("nonce") !== nonce) throw new Error(`the log is for nonce ${String(arg("nonce"))}, not ${nonce}`);
    return {
      value: {
        txHash: log.transactionHash.toLowerCase() as Hex,
        blockNumber: Number(BigInt(log.blockNumber)),
        blockHash: log.blockHash.toLowerCase() as Hex,
        nonce: arg("nonce") as bigint,
        sender: arg("sender") as Hex,
        recipient: arg("recipient") as Hex,
        dstChainId: arg("dstChainId") as bigint,
        dstMinter: arg("dstMinter") as Hex,
        amountNative: arg("amountNative") as bigint,
        commitment: arg("commitment") as Hex,
      },
      endpoint: a.endpoint.label,
    };
  });
}

function readMinter() {
  return run("sepolia.minter", async () => {
    const [used, trie, burns] = await Promise.all([
      ethCall(SEPOLIA, MINTER, encodeCall("used(uint256)", [0n])),
      ethCall(SEPOLIA, MINTER, encodeCall("vaultTrieId()")),
      ethCall(SEPOLIA, MINTER, encodeCall("burnCount()")),
    ]);
    return {
      value: {
        used0: decode("bool", used.result)[0] as boolean,
        trieId: decode("bytes32", trie.result)[0] as Hex,
        burnCount: decode("uint256", burns.result)[0] as bigint,
      },
      endpoint: used.endpoint.label,
    };
  });
}

function readToken() {
  return run("sepolia.token", async () => {
    const [supply, balance] = await Promise.all([
      ethCall(SEPOLIA, TOKEN, encodeCall("totalSupply()")),
      ethCall(SEPOLIA, TOKEN, encodeCall("balanceOf(address)", [RECIPIENT])),
    ]);
    return {
      value: { totalSupply: decode("uint256", supply.result)[0] as bigint, recipientBalance: decode("uint256", balance.result)[0] as bigint },
      endpoint: supply.endpoint.label,
    };
  });
}

interface RawReceipt {
  status: string;
  blockNumber: string;
  gasUsed: string;
  from: string;
  to: string;
  effectiveGasPrice?: string;
  logs: RawLog[];
}

function readReceipt() {
  return run("receipt.hero", async () => {
    const a = await request<RawReceipt | null>(SEPOLIA_HISTORY, "eth_getTransactionReceipt", [HERO_TX], { accept: (r) => r !== null, timeoutMs: 10000 });
    const r = a.result!;
    const logs = r.logs.map((l) => registry.decodeLog(l)).filter((l): l is DecodedLog => l !== null);
    if (logs.length !== r.logs.length) throw new Error("a log of the receipt does not decode");
    return {
      value: {
        txHash: HERO_TX,
        status: Number(BigInt(r.status)),
        blockNumber: Number(BigInt(r.blockNumber)),
        gasUsed: Number(BigInt(r.gasUsed)),
        from: r.from.toLowerCase() as Hex,
        to: r.to.toLowerCase() as Hex,
        effectiveGasPrice: r.effectiveGasPrice ? BigInt(r.effectiveGasPrice) : null,
        logs,
      },
      endpoint: a.endpoint.label,
    };
  });
}

function readSet(key: "mainnet" | "v3") {
  const lcField = store.get(key === "mainnet" ? "lc.mainnet" : "lc.v3");
  const setId = lcField.value?.setId;
  if (setId === undefined) return Promise.resolve();
  return run(key === "mainnet" ? "set.mainnet" : "set.v3", async () => {
    const a = await ethCall(SEPOLIA, LC[key].address, encodeCall("authorities(uint64)", [setId]));
    return { value: { setId, keys: decode("bytes32[]", a.result)[0] as Hex[] }, endpoint: a.endpoint.label };
  });
}

interface RawTx {
  from: string;
  to: string;
  input: string;
  gas: string;
  blockNumber: string | null;
}

function readLatestImport() {
  const lc = store.get("lc.mainnet").value;
  if (!lc) return Promise.resolve();
  return run("import.mainnet", async () => {
    let txHash: Hex | null = null;
    let sepoliaBlock: number | null = null;
    let setId: bigint | null = null;
    let signatures: number | null = null;
    let foundBy: ImportView["foundBy"] = "log";
    let endpoint = "";
    try {
      // From the relayer's latest recorded import on: the client's latest block was imported then or
      // later, and the range stays small enough for the public nodes for a while.
      const from = LC.mainnet.latestRelay?.sepoliaBlock ?? LC.mainnet.deployBlock;
      const a = await request<RawLog[]>(
        SEPOLIA_LOGS,
        "eth_getLogs",
        [{ address: LC.mainnet.address, topics: [HEADER_IMPORTED, lc.latestHash], fromBlock: "0x" + from.toString(16), toBlock: "latest" }],
        { accept: (r) => Array.isArray(r) && r.length > 0, timeoutMs: 12000, retries: 0 },
      );
      const log = a.result.at(-1)!;
      const d = registry.decodeLog(log);
      txHash = log.transactionHash.toLowerCase() as Hex;
      sepoliaBlock = Number(BigInt(log.blockNumber));
      setId = (d?.args.find((x) => x.name === "setId")?.value as bigint | undefined) ?? null;
      const sigs = d?.args.find((x) => x.name === "signatures")?.value as bigint | undefined;
      signatures = sigs === undefined ? null : Number(sigs);
      endpoint = a.endpoint.label;
    } catch {
      const rec = records.relay.entries.find((e) => e.chain === "mainnet" && e.block.hash === lc.latestHash) ?? null;
      if (!rec) throw new Error("the import of the client's latest block was not found in its logs or in the relayer's record");
      txHash = rec.txHash;
      sepoliaBlock = rec.sepoliaBlock;
      setId = BigInt(rec.setBefore);
      signatures = rec.signatures;
      foundBy = "record";
    }
    const t = await request<RawTx | null>(SEPOLIA_HISTORY, "eth_getTransactionByHash", [txHash], { accept: (r) => r !== null, timeoutMs: 10000 });
    endpoint ||= t.endpoint.label;
    const view: ImportView = {
      txHash,
      sepoliaBlock: sepoliaBlock ?? (t.result!.blockNumber ? Number(BigInt(t.result!.blockNumber)) : null),
      method: "",
      number: lc.latestNumber,
      blockHash: lc.latestHash,
      setId: setId ?? lc.setId,
      signatures: signatures ?? 0,
      round: null,
      precommitCount: null,
      counted: [],
      foundBy,
      decoded: false,
      signingKeys: null,
      note: null,
    };
    try {
      const d = decodeImportCall(t.result!.input);
      view.method = d.method;
      view.round = d.justification.round;
      view.precommitCount = d.justification.precommits.length;
      view.counted = d.signers.map((s) => {
        const pc = d.justification.precommits[s.position];
        if (!pc) throw new Error(`the hint names precommit ${s.position}, which the justification does not have`);
        return { position: s.position, authorityIndex: s.authorityIndex, id: pc.id, signature: pc.signature, targetHash: pc.targetHash, targetNumber: pc.targetNumber };
      });
      if (!view.signatures) view.signatures = view.counted.length;
      view.decoded = true;
      if (d.headerFields.number !== lc.latestNumber) view.note = `the calldata's header is #${d.headerFields.number}, the client's latest #${lc.latestNumber}`;
    } catch (error) {
      view.note = `calldata not decoded: ${(error as Error).message}`;
    }
    try {
      const keys = await ethCall(SEPOLIA, LC.mainnet.address, encodeCall("authorities(uint64)", [view.setId]));
      view.signingKeys = decode("bytes32[]", keys.result)[0] as Hex[];
    } catch {
      view.signingKeys = null;
    }
    return { value: view, endpoint };
  });
}

/** The latest recorded transfer, read again from both chains: used(nonce), its mint's receipt, commitments(nonce). */
function readRun() {
  const r = RUN;
  if (!r) return Promise.resolve();
  const nonce = BigInt(r.lock.nonce);
  return Promise.allSettled([
    run("run.minter", async () => {
      const a = await ethCall(SEPOLIA, MINTER, encodeCall("used(uint256)", [nonce]));
      return { value: { used: decode("bool", a.result)[0] as boolean }, endpoint: a.endpoint.label };
    }),
    run("run.vault", async () => {
      const a = await ethCall(V3_EVM, VAULT, encodeCall("commitments(uint256)", [nonce]));
      return { value: { commitment: decode("bytes32", a.result)[0] as Hex }, endpoint: a.endpoint.label };
    }),
    run("run.receipt", async () => {
      const a = await request<RawReceipt | null>(SEPOLIA_HISTORY, "eth_getTransactionReceipt", [r.mint.txHash], { accept: (x) => x !== null, timeoutMs: 10000 });
      const rc = a.result!;
      const stamp = rc.logs.find((l) => typeof l.blockTimestamp === "string")?.blockTimestamp;
      return {
        value: {
          status: Number(BigInt(rc.status)),
          blockNumber: Number(BigInt(rc.blockNumber)),
          gasUsed: Number(BigInt(rc.gasUsed)),
          events: rc.logs.map((l) => registry.decodeLog(l)?.name ?? "an unknown event"),
          blockTime: stamp ? Number(BigInt(stamp)) * 1000 : null,
        },
        endpoint: a.endpoint.label,
      };
    }),
    readLockLog("run.lock", nonce, r.lock.block),
    run("run.lockBlock", async () => {
      // The Substrate hash of the lock's block: the bundle's parent when it was read right after the
      // lock, else the node's chain_getBlockHash. Its first extrinsic is Timestamp.set.
      let hash: Hex | null = r.bundle.parent.number === r.lock.block ? r.bundle.parent.hash : null;
      if (!hash) {
        const h = await v3Node.request<Hex | null>("chain_getBlockHash", [r.lock.block], 9000);
        if (!h.result) throw new Error(`the V3 node has no block #${r.lock.block}`);
        hash = h.result;
      }
      const b = await v3Node.request<{ block: { header: { number: string }; extrinsics: Hex[] } } | null>("chain_getBlock", [hash], 9000);
      if (!b.result) throw new Error(`the V3 node does not serve block #${r.lock.block}`);
      const number = Number(BigInt(b.result.block.header.number));
      if (number !== r.lock.block) throw new Error(`the node's block ${hash} is #${number}, not #${r.lock.block}`);
      const first = b.result.block.extrinsics[0];
      if (!first) throw new Error("the block has no extrinsics");
      const at = Number(decodeTimestampInherent(first).moment);
      // A sanity bound: the block was made within minutes of the lock's signing, by the records.
      if (Math.abs(at - Date.parse(r.lock.signedAt)) > 10 * 60_000) throw new Error("the block's first extrinsic does not read as the lock's time");
      return { value: { number, hash, at }, endpoint: b.endpoint.label };
    }),
  ]);
}

/** For each recorded burn: its id as BridgeMinter derives it, and whether the vault released it. */
function readReturn() {
  if (!RECORDED_BURNS.length) return Promise.resolve();
  return run("return.checks", async () => {
    let endpoint = "";
    const checks = await Promise.all(
      RECORDED_BURNS.map(async (b) => {
        const [id, rel] = await Promise.all([
          ethCall(SEPOLIA, MINTER, encodeCall("burnIdOf(uint256)", [BigInt(b.burnNonce)])),
          ethCall(V3_EVM, VAULT, encodeCall("released(bytes32)", [b.burnId])),
        ]);
        endpoint = `${id.endpoint.label} and ${rel.endpoint.label}`;
        return { ...b, onChain: decode("bytes32", id.result)[0] as Hex, released: decode("bool", rel.result)[0] as boolean };
      }),
    );
    return { value: checks, endpoint };
  });
}

// ---------------------------------------------------------------------------------------------
// Schedules

let started = false;
let lastHeads = 0;

async function refreshHeads(): Promise<void> {
  lastHeads = Date.now();
  await Promise.allSettled([readSepoliaHead(), readLightClient("mainnet"), readLightClient("v3"), readChainHead("mainnet"), readChainHead("v3")]);
}

async function refreshState(): Promise<void> {
  await Promise.allSettled([readVault(), readMinter(), readToken(), readReturn()]);
}

/** Starts the reads: everything once, in parallel, then the heads every 30 s and the state every 2 min while the tab is visible. */
export function startLive(): void {
  if (started) return;
  started = true;
  const heads = refreshHeads();
  void refreshState();
  void readRun();
  void readLockLog("v3.lock0", 0n, records.bridge.lock.block.number);
  void readReceipt();
  void heads.then(() => Promise.allSettled([readSet("mainnet"), readSet("v3"), readLatestImport()]));
  let lastImportHash = "";
  setInterval(() => {
    if (document.hidden) return;
    void refreshHeads().then(() => {
      // A newer import, or a set change, since the page read them: read them again, once per change.
      const h = store.get("lc.mainnet").value?.latestHash ?? "";
      if (h && h !== lastImportHash && store.get("import.mainnet").value?.blockHash !== h) {
        lastImportHash = h;
        void Promise.allSettled([readSet("mainnet"), readLatestImport()]);
      }
      const v3 = store.get("lc.v3").value?.setId;
      if (v3 !== undefined && store.get("set.v3").value?.setId !== v3) void readSet("v3");
    });
  }, 30_000);
  setInterval(() => {
    if (!document.hidden) void refreshState();
  }, 120_000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && Date.now() - lastHeads > 30_000) void refreshHeads();
  });
}

// ---------------------------------------------------------------------------------------------
// On demand: replay a recorded attack with eth_call, now

export interface AttackCheck {
  reverted: boolean;
  data: Hex | null;
  decoded: DecodedError | null;
  message: string;
  block: number;
  endpoint: string;
  /** The revert data is byte for byte what the recorded transaction reverted with. */
  sameAsRecord: boolean;
}

export async function checkAttack(a: Attack): Promise<AttackCheck> {
  const t = await request<RawTx | null>(SEPOLIA_HISTORY, "eth_getTransactionByHash", [a.txHash], { accept: (r) => r !== null, timeoutMs: 10000 });
  const tx = t.result!;
  if (tx.to.toLowerCase() !== MINTER) throw new Error(`that transaction was sent to ${tx.to}, not to BridgeMinter`);
  const head = await request<Hex>(SEPOLIA, "eth_blockNumber", []);
  const block = Number(BigInt(head.result));
  const call = [{ from: tx.from, to: tx.to, data: tx.input, gas: tx.gas }, head.result];
  let bare: AttackCheck | null = null;
  const problems: string[] = [];
  // Endpoint by endpoint: a revert is the answer, but one without its data is worth asking another node about.
  for (const ep of SEPOLIA) {
    try {
      const r = await request<Hex>([ep], "eth_call", call, { timeoutMs: 15000 });
      return { reverted: false, data: r.result, decoded: null, message: "the call did not revert", block, endpoint: r.endpoint.label, sameAsRecord: false };
    } catch (error) {
      if (!(error instanceof NodeError) || !error.isRevert) {
        problems.push(message(error));
        continue;
      }
      const data = (error.data ?? null) as Hex | null;
      const result: AttackCheck = {
        reverted: true,
        data,
        decoded: data ? registry.decodeError(data) : null,
        message: error.message,
        block,
        endpoint: error.endpoint.label,
        sameAsRecord: !!data && data.toLowerCase() === a.expectedRevert.data.toLowerCase(),
      };
      if (data) return result;
      bare ??= result;
    }
  }
  if (bare) return bare;
  throw new AllFailed("eth_call", problems);
}

// ---------------------------------------------------------------------------------------------
// On demand: check GRANDPA signatures in the browser (ed25519, loaded when asked for)

export interface SignatureCheck {
  authorityIndex: number;
  /** The precommit names the key the set holds at that index. */
  keyMatches: boolean;
  valid: boolean;
}

export async function checkSignatures(
  counted: CountedSignature[],
  keys: Hex[],
  round: bigint,
  setId: bigint,
): Promise<SignatureCheck[]> {
  const { ed25519 } = await import("@noble/curves/ed25519.js");
  return counted.map((c) => {
    const key = keys[c.authorityIndex];
    const keyMatches = !!key && key.toLowerCase() === c.id.toLowerCase();
    let valid = false;
    try {
      valid = ed25519.verify(hexToBytes(c.signature), precommitPayload(c.targetHash, c.targetNumber, round, setId), hexToBytes(c.id));
    } catch {
      valid = false;
    }
    return { authorityIndex: c.authorityIndex, keyMatches, valid };
  });
}
