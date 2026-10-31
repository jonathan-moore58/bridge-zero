// The Verify page's reads, loaded with its first run: each destination's endpoints and contracts as
// the checks take them (../lib/proof/verify.ts), what a transfer's id is (the records first, then
// the chains: the vault's Locked log, the destination's Minted or BurnRequested log, used(nonce)),
// and the runs themselves, reported to ./verify-runs.ts as each step settles.

import { decode, encodeCall } from "../lib/abi.ts";
import { LC, nodeConsoleBlock, records, SEPOLIA, SEPOLIA_LOGS, V3_CHAIN_ID, V3_EVM, VAULT } from "../lib/chains.ts";
import type { Hex } from "../lib/hex.ts";
import { registry } from "../lib/live.ts";
import { proofEnv } from "../lib/proof/env.ts";
import { loadClientCrypto } from "../lib/proof/grandpa.ts";
import { planMint } from "../lib/proof/plan.ts";
import { keyHistory, verifyBurn, verifyMinted, verifyUnminted, type BurnTarget, type DestEnv, type Looked, type MintedLock, type Run, type UnmintedLock, type VerifyEnv } from "../lib/proof/verify.ts";
import { request, type Endpoint } from "../lib/rpc.ts";
import { DESTS, burnKey, deployed, destByChainId, destOf, explorerAddress, explorerBlock, explorerTx, lockKey, refOf, selectable, type DestKey } from "./dests.ts";
import { planEnv } from "./sends.ts";
import { findBurn, findLock, findMint, v3BlockTime, type ChainLock } from "./transfers.ts";
import { headOf, histories, setRun, type VerifyHead } from "./verify-runs.ts";
import { burnLabel, type BeyondLock } from "./verify-model.ts";

// ---------------------------------------------------------------------------------------------
// Each destination, as the checks read it

/** Sepolia's nodes for the checks: drpc refuses Sepolia on its free plan (Oct 28), so it is left out. */
const SEP = SEPOLIA.filter((e) => e.id !== "drpc");
const SEP_LOGS = SEPOLIA_LOGS.filter((e) => e.id !== "drpc");
const TENDERLY = SEP.filter((e) => e.id === "tenderly");

/** Auto-mint's key, from its histories' names: the page calls it auto-mint. */
const AUTO_MINT = ((): Hex | null => {
  const m = records.locks.find((l) => l.mint?.from.includes("automint-"))?.mint;
  return m ? m.sender : null;
})();

const envs = new Map<DestKey, VerifyEnv>();

/**
 * A destination's endpoints and contracts. State reads go to its public RPCs, two compared where two
 * answer; old receipts to the ones that keep them (tenderly on Sepolia); a re-run at an old block
 * to the ones that serve historical state (tenderly on Sepolia, both of Base Sepolia's, none of
 * Arbitrum Sepolia's); logs to the ones that serve wide ranges.
 */
export function verifyEnv(key: DestKey): VerifyEnv {
  const cached = envs.get(key);
  if (cached) return cached;
  const d = destOf(key);
  const sep = key === "sepolia";
  const rpcs: Endpoint[] = sep ? SEP : [...d.rpcs];
  const dest: DestEnv = {
    key,
    name: d.short,
    chainId: BigInt(d.chainId),
    rpcs,
    history: rpcs,
    archive: sep ? [...TENDERLY, ...SEP.filter((e) => e.id !== "tenderly")] : key === "base-sepolia" ? [...d.rpcs] : [],
    logs: sep ? SEP_LOGS : [...d.rpcs],
    lightClient: d.lightClient,
    minter: deployed(d).minter,
    clientFrom: sep ? LC.v3.deployBlock : (records.rollups[key]?.deployBlock ?? d.minterFrom),
    // One key deployed the three chains' contracts and initialized each V3 client (deployments/<network>-bridge.json).
    deployer: records.sepolia.deployer,
    explorer: { name: d.explorer.name, tx: (h) => explorerTx(d, h), address: (a) => explorerAddress(d, a), block: (b) => explorerBlock(d, b) },
  };
  const env: VerifyEnv = {
    dest,
    v3: proofEnv().v3,
    v3Evm: V3_EVM,
    vault: VAULT,
    vaultFrom: records.bridge.vault.deployBlock.number,
    v3ChainId: V3_CHAIN_ID,
    genesis: LC.v3.genesis,
    registry,
    recordedVault: { trieId: records.bridge.proofs.account.trieId, codeHash: records.bridge.proofs.account.codeHash, from: records.bridge.bundleFile },
    v3Block: nodeConsoleBlock,
    crypto: loadClientCrypto,
    importOf: (hash) => importOf(key, hash),
    // The planner as the sends run it, with the same environment: its dry runs only, nothing sent.
    plan: (lock, opts) => planMint(lock, planEnv(key), opts),
  };
  envs.set(key, env);
  return env;
}

/** The import that brought a V3 block into `key`'s client, as the relayer's records hold it. */
function importOf(key: DestKey, hash: Hex): { tx: Hex; block: number | null; from: string } | null {
  const h = hash.toLowerCase();
  if (key === "sepolia") {
    const e = records.relay.entries.find((x) => x.chain === "v3" && x.client === LC.v3.address && x.block.hash === h && x.ok === true);
    return e ? { tx: e.txHash, block: e.sepoliaBlock, from: records.relay.files.find((f) => f.endsWith(`relay-sepolia-${e.sender}.jsonl`)) ?? "deployments/" } : null;
  }
  const i = records.rollups[key]?.imports.find((x) => x.hash === h);
  return i ? { tx: i.txHash, block: i.block, from: i.from } : null;
}

// ---------------------------------------------------------------------------------------------
// What an id is

type Target =
  | { kind: "minted"; dest: DestKey; head: VerifyHead; input: MintedLock }
  | { kind: "unminted"; dest: DestKey; head: VerifyHead; input: UnmintedLock }
  | { kind: "burn"; dest: DestKey; head: VerifyHead; input: BurnTarget }
  | { kind: "none"; why: string };

const nonNull = { accept: (r: unknown) => r !== null };

// The reads made to find what an id is, before its checks (Looked): each lookup counted once, and a
// lookup that searches logs in windows (a mint's, a burn's) at least once, so the run's count is then
// a floor.

async function usedOn(key: DestKey, nonce: number, looked: Looked): Promise<boolean | null> {
  const d = destOf(key);
  looked.reads++;
  try {
    const a = await request<Hex>(verifyEnv(key).dest.rpcs, "eth_call", [{ to: deployed(d).minter, data: encodeCall("used(uint256)", [BigInt(nonce)]) }, "latest"]);
    return decode("bool", a.result)[0] === true;
  } catch {
    return null;
  }
}

/** A lock's Locked log on V3 (one eth_getLogs), and its block's time when the log has none. */
async function lockOf(n: number, looked: Looked): Promise<{ log: ChainLock; at: number | null } | null> {
  looked.reads++;
  const log = await findLock(n).catch(() => null);
  if (!log) return null;
  if (log.at !== null) return { log, at: log.at };
  looked.reads++;
  return { log, at: await v3BlockTime(log.block).catch(() => null) };
}

async function mintOn(dest: DestKey, n: number, since: number | null, looked: Looked): Promise<Awaited<ReturnType<typeof findMint>> | null> {
  looked.reads++;
  looked.floor = true;
  return findMint(dest, n, since).catch(() => null);
}

async function resolveLock(n: number): Promise<Target> {
  const id = lockKey(n);
  const looked: Looked = { reads: 0, floor: false };
  const rec = records.locks.find((l) => l.nonce === n);
  if (rec) {
    const d = destByChainId(rec.dstChainId);
    if (!d) return { kind: "none", why: `Lock ${n} names chain ${rec.dstChainId}, which this page does not check.` };
    const head = headOf(id) ?? { dir: "in", dest: d.key, label: `Lock ${n}`, at: Date.parse(rec.signedAt), amount: BigInt(rec.amountNative), substrate: rec.via === "substrate" };
    const lock = { tx: rec.tx, block: rec.block.number, via: rec.via };
    const fields = { recipient: rec.recipient, amount: BigInt(rec.amountNative), block: rec.block.number, commitment: rec.commitment };
    if (rec.mint) {
      return {
        kind: "minted",
        dest: d.key,
        head,
        input: { nonce: BigInt(n), mintTx: rec.mint.tx, recorded: { block: rec.mint.block, gasUsed: rec.mint.gasUsed, sender: rec.mint.sender, from: rec.mint.from }, lock, autoMint: AUTO_MINT, fields, looked },
      };
    }
    // Recorded and not minted by the records: what the chain says now.
    return mintedOrNot(d.key, n, head, lock, fields, null, looked);
  }
  // Beyond the records: the vault's Locked log names the destination.
  const found = await lockOf(n, looked);
  if (found) {
    const { log, at } = found;
    const head: VerifyHead = { dir: "in", dest: log.dest, label: `Lock ${n}`, at, amount: log.amount, substrate: false };
    return mintedOrNot(log.dest, n, head, { tx: log.tx, block: log.block, via: "evm" }, { recipient: log.recipient, amount: log.amount, block: log.block, commitment: log.commitment }, at, looked);
  }
  // A Substrate extrinsic has no Locked log through eth_getLogs: the minter that counts it as used names it.
  for (const d of DESTS.filter((x) => selectable(x))) {
    if ((await usedOn(d.key, n, looked)) !== true) continue;
    const head: VerifyHead = { dir: "in", dest: d.key, label: `Lock ${n}`, at: null, amount: null, substrate: true };
    const m = await mintOn(d.key, n, null, looked);
    if (m && m !== "beyond") return { kind: "minted", dest: d.key, head, input: { nonce: BigInt(n), mintTx: m.tx, recorded: null, lock: null, autoMint: AUTO_MINT, fields: null, looked } };
    return { kind: "none", why: `Lock ${n} is minted on ${d.short}, by a transaction older than its nodes search: its page cannot name the mint.` };
  }
  return { kind: "none", why: "The vault's Locked logs on V3 have none, and no minter counts it. A lock from a Polkadot wallet shows here once it is minted." };
}

/**
 * A lock on chain: minted (its mint found) or not. One minted by a transaction that is not found
 * (older than the nodes search) is checked from V3 now, the labelled fallback route. One whose
 * used(nonce) could not be read goes the way of a lock not minted, marked so: its step 6 says.
 */
async function mintedOrNot(
  dest: DestKey,
  n: number,
  head: VerifyHead,
  lock: UnmintedLock["lock"],
  fields: UnmintedLock["fields"],
  since: number | null,
  looked: Looked,
): Promise<Target> {
  const used = await usedOn(dest, n, looked);
  if (used === true) {
    const m = await mintOn(dest, n, since, looked);
    if (m && m !== "beyond") return { kind: "minted", dest, head, input: { nonce: BigInt(n), mintTx: m.tx, recorded: null, lock, autoMint: AUTO_MINT, fields, looked } };
    const why = `Minted (used(${n}) is true on ${destOf(dest).short}), by a transaction ${m === "beyond" ? "older than the nodes here search" : "not found"}: checked on a proof read from V3 now instead.`;
    return { kind: "unminted", dest, head, input: { nonce: BigInt(n), fields, lock, why, minted: true, looked } };
  }
  const why = used === false ? `Not minted yet: used(${n}) is false on ${destOf(dest).short}. The proof is read from V3 now.` : `Whether it is minted could not be read: used(${n}) on ${destOf(dest).short} was not answered. The proof is read from V3 now.`;
  return { kind: "unminted", dest, head, input: { nonce: BigInt(n), fields, lock, why, unread: used === null, looked } };
}

async function resolveBurn(dest: DestKey, n: number): Promise<Target> {
  const d = destOf(dest);
  const id = burnKey(dest, n);
  const C = records.returnPath.committee;
  const committee = { members: C.members, threshold: C.threshold, multisig: C.multisig };
  const burns = dest === "sepolia" ? records.returnPath.burns : (records.rollupRuns[dest]?.burns ?? []);
  const rec = burns.find((b) => b.burnNonce === String(n) && b.ok === true && b.status === 1);
  const file = dest === "sepolia" ? "deployments/sepolia-bridge.json" : (records.rollupRuns[dest]?.from ?? "deployments/");
  if (rec?.txHash && rec.block !== null && rec.burnId) {
    const rel = records.returnPath.releases.find((r) => r.burnId === rec.burnId && r.status === "released");
    const run = rel?.approvals.find((a) => a.action === "execute");
    const runBlock = rel?.releasedAt?.number ?? run?.block ?? null;
    return {
      kind: "burn",
      dest,
      head: headOf(id) ?? { dir: "back", dest, label: burnLabel(dest, n), at: rec.signedAt ? Date.parse(rec.signedAt) : null, amount: BigInt(rec.amount), substrate: false },
      input: {
        n: BigInt(n),
        tx: rec.txHash,
        recorded: { block: rec.block, amount: BigInt(rec.amount), payee: rel?.payee ?? rec.v3Recipient, burnId: rec.burnId, from: file },
        release: rel
          ? {
              payee: rel.payee,
              amount: rel.amountNative !== null ? BigInt(rel.amountNative) : null,
              by: rel.by,
              approvals: rel.approvals.map((a) => ({ member: a.member, action: a.action, extrinsic: a.extrinsicHash, block: a.block })),
              run: run && runBlock !== null ? { extrinsic: run.extrinsicHash, block: runBlock } : null,
              from: "deployments/v3-testnet.json",
            }
          : null,
        committee,
      },
    };
  }
  // Its BurnRequested log, searched back from the head in windows: a floor of one read.
  const looked: Looked = { reads: 1, floor: true };
  const log = await findBurn(dest, n).catch(() => null);
  if (!log) return { kind: "none", why: `BridgeMinter's BurnRequested logs on ${d.short} have none.` };
  if ("older" in log) return { kind: "none", why: `Burn ${n} on ${d.short} is older than its nodes search back (block #${log.older}).` };
  return {
    kind: "burn",
    dest,
    head: { dir: "back", dest, label: burnLabel(dest, n), at: log.at, amount: log.amount, substrate: false },
    input: { n: BigInt(n), tx: log.tx, recorded: null, release: null, committee, looked },
  };
}

function resolve(id: string): Promise<Target> {
  const k = refOf(id);
  if (!k) return Promise.resolve({ kind: "none", why: "" });
  return k.dir === "in" ? resolveLock(k.n) : resolveBurn(k.dest, k.n);
}

// ---------------------------------------------------------------------------------------------
// The runs

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Runs `id`'s checks, reporting each step as it settles, until `ctl` says the page left. */
export async function runVerify(id: string, ctl: { stopped(): boolean }): Promise<void> {
  let t: Target;
  try {
    t = await resolve(id);
  } catch (e) {
    if (!ctl.stopped()) setRun(id, { status: "error", head: headOf(id), why: `Its chain could not be read: ${message(e)}` });
    return;
  }
  if (ctl.stopped()) return;
  if (t.kind === "none") {
    setRun(id, { status: "none", why: t.why });
    return;
  }
  const { head } = t;
  const env = verifyEnv(t.dest);
  const out = { emit: (run: Run) => setRun(id, { status: "run", head, run }), stopped: ctl.stopped };
  try {
    if (t.kind === "minted") await verifyMinted(env, t.input, out);
    else if (t.kind === "unminted") await verifyUnminted(env, t.input, out);
    else await verifyBurn(env, t.input, out);
  } catch (e) {
    if (!ctl.stopped()) setRun(id, { status: "error", head, why: `The checks stopped: ${message(e)}` });
  }
}

/** The key history of `dest`'s client, reported as each change verifies. */
export async function runHistory(dest: DestKey, ctl: { stopped(): boolean }): Promise<void> {
  try {
    await keyHistory(verifyEnv(dest), { emit: (h) => histories.set((m) => new Map(m).set(dest, h)), stopped: ctl.stopped });
  } catch {
    if (!ctl.stopped()) histories.set((m) => new Map(m).set(dest, "failed"));
  }
}

// ---------------------------------------------------------------------------------------------
// Locks past the records, for the picker

/** The most locks past the records the picker reads, newest first. */
const BEYOND_MAX = 8;

/**
 * The locks the vault holds past the records (its nextNonce, the word at slot 1), newest first,
 * each filled in once its Locked log is read: a lock sent as a Substrate extrinsic has none through
 * eth_getLogs, and stays a bare nonce. Read once per page load, reported as each one is read.
 */
export async function readBeyond(report: (locks: readonly BeyondLock[]) => void): Promise<void> {
  const next = Number(BigInt((await request<Hex>(V3_EVM, "eth_getStorageAt", [VAULT, "0x1", "latest"])).result));
  const from = records.locks.reduce((m, l) => Math.max(m, l.nonce + 1), 0);
  const ns = Array.from({ length: Math.max(0, Math.min(next - from, BEYOND_MAX)) }, (_, i) => next - 1 - i);
  let list: BeyondLock[] = ns.map((n) => ({ n, row: null, read: false }));
  report(list);
  await Promise.all(
    ns.map(async (n) => {
      const found = await lockOf(n, { reads: 0, floor: false }).catch(() => null);
      const row = found ? { id: lockKey(n), dir: "in" as const, dest: found.log.dest, n, amount: found.log.amount, at: found.at ?? Number.NaN, label: `Lock ${n}`, substrate: false, done: false } : null;
      list = list.map((x) => (x.n === n ? { n, row, read: true } : x));
      report(list);
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// A transaction hash, from the field

interface Receipt {
  logs: { address: string; topics: string[]; data: string }[];
}

/** The transfer `hash` belongs to: the records' first, then V3's EVM RPC (a lock), then each destination (a mint or a burn). */
export async function lookupHash(hash: string): Promise<string | null> {
  const h = hash.toLowerCase();
  for (const l of records.locks) if (l.tx === h || l.mint?.tx === h) return lockKey(l.nonce);
  for (const b of records.returnPath.burns) if (b.txHash === h && b.burnNonce !== null) return burnKey("sepolia", Number(b.burnNonce));
  for (const d of DESTS) for (const b of d.key === "sepolia" ? [] : (records.rollupRuns[d.key]?.burns ?? [])) if (b.txHash === h && b.burnNonce !== null) return burnKey(d.key, Number(b.burnNonce));
  const v3 = await request<Receipt>(V3_EVM, "eth_getTransactionReceipt", [h], nonNull).catch(() => null);
  for (const l of v3?.result.logs ?? []) {
    const dl = l.address.toLowerCase() === VAULT ? registry.decodeLog(l) : null;
    const nonce = dl?.name === "Locked" ? dl.args.find((a) => a.name === "nonce")?.value : undefined;
    if (typeof nonce === "bigint") return lockKey(Number(nonce));
  }
  for (const d of DESTS.filter((x) => selectable(x))) {
    const rc = await request<Receipt>(verifyEnv(d.key).dest.history, "eth_getTransactionReceipt", [h], nonNull).catch(() => null);
    for (const l of rc?.result.logs ?? []) {
      const dl = l.address.toLowerCase() === deployed(d).minter ? registry.decodeLog(l) : null;
      const arg = (k: string) => dl?.args.find((a) => a.name === k)?.value;
      if (dl?.name === "Minted" && typeof arg("nonce") === "bigint") return lockKey(Number(arg("nonce")));
      if (dl?.name === "BurnRequested" && typeof arg("burnNonce") === "bigint") return burnKey(d.key, Number(arg("burnNonce")));
    }
  }
  return null;
}
