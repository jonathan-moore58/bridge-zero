// The app's sends, and the following of what they start. The way in: the lock on V3 (a dry run, the
// gas and fees worked out here, then the wallet), its receipt and Locked log checked, V3's finality
// of its block, the mint planned and checked in this browser by the proof core (../lib/proof), then
// the mint on Sepolia, followed by used(nonce) and the Minted log, so that a mint anyone sends (the
// relayer's operator, another tab, the wallet's own speed-up) completes the transfer. When the light
// client is behind V3's validator set, the plan imports the changes itself (a self-relay): nobody
// waits for the relayer. The way back: the burn on Sepolia, its BurnRequested log checked, then its
// confirmations, Sepolia's finality, the committee's approvals and released(burnId) on V3.
//
// Every transfer is kept in this browser's journal (journal.ts) and read again from the chains when
// the page loads: the journal says what to look for, the chains say what happened. A transfer this
// tab starts asks the wallet for each next step as soon as it can; one read back after a reload
// waits for the visitor's click. The checks before each prompt are preflight.ts's and the proof
// core's dry runs. The wallet signs; nothing here holds a key.

import { decode, encodeCall } from "../lib/abi.ts";
import { MINTER, SEPOLIA, SEPOLIA_CHAIN_ID, SEPOLIA_LOGS, TOKEN, V3_CHAIN_ID, V3_EVM, VAULT } from "../lib/chains.ts";
import { blake2b256, eventTopic } from "../lib/hashes.ts";
import { bytesToHex, hexToBytes, type Hex } from "../lib/hex.ts";
import { registry } from "../lib/live.ts";
import { proofEnv } from "../lib/proof/env.ts";
import { PlanError, planMint, type Check, type LockRef, type MintPlan } from "../lib/proof/plan.ts";
import { V3Reader } from "../lib/proof/v3.ts";
import { request, type Endpoint } from "../lib/rpc.ts";
import { decodeTimestampInherent } from "../lib/scale.ts";
import { connectThen } from "./connect.tsx";
import { decodeJournal, encodeJournal, JOURNAL_KEY } from "./journal.ts";
import { balanceOn, errorText, prepareBurn, prepareLock, sepoliaFeesNow, unreachable, type SendEnv } from "./preflight.ts";
import { go } from "./router.ts";
import {
  chainReads,
  findLock,
  findMint,
  followerOf,
  isDone,
  nonceOf,
  putTransfer,
  sepoliaHeads,
  transferActions,
  transfers,
  updateTransfer,
  v3BlockTime,
  waitingChecks,
  watcherSpeed,
  type BurnTransfer,
  type CheckKey,
  type CheckState,
  type Failure,
  type LiveTransfer,
  type LockTransfer,
  type Note,
} from "./transfers.ts";
import { burnedOf, carries, COMMITTEE_MULTISIGS, lockedOf, mintedIn, multisigOf, parseAmount, upFront } from "./txmath.ts";
import { fmt, short, toast } from "./ui.tsx";
import { blockTimeOn, problemOf, readBalances, receiptOn, sendOn, switchTo, wallet, walletOn } from "./wallet.ts";

// The events as contracts/src declares them.
const LOCKED = eventTopic("Locked(uint256,address,address,uint256,address,uint256,bytes32)");
const BURN_REQUESTED = eventTopic("BurnRequested(uint256,address,address,uint256,bytes32)");

/** V3 makes a block every 6 s, Sepolia every 12 s: receipts and heads are read about twice a block. */
const V3_POLL = 3_000;
const SEPOLIA_POLL = 4_000;
/** released(burnId) is read once a V3 block, Sepolia's heads once a Sepolia block. */
const RELEASE_POLL = 6_000;
const HEADS_POLL = 12_000;
/** A plan this fresh is sent as it is when no wallet prompt came in between. */
const FRESH_PLAN = 15_000;
/** How far back V3's EVM RPC serves state (docs/V3.md: about 256 blocks): the release's block is looked for within it. */
const V3_EVM_STATE = 250;
/** Every this many rounds without a receipt, the page asks whether the wallet put another transaction in its place (Speed up, Cancel). */
const REPLACED_EVERY = 10;
/** How often a lock that waits for the visitor, or that this page stopped following, is checked for a mint someone else sent. */
const IDLE_POLL = 20_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const qty = (n: bigint | number): Hex => `0x${n.toString(16)}`;
const topicOf = (address: string): Hex => `0x${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
const sameAddress = (a: string | null | undefined, b: string): boolean => !!a && a.toLowerCase() === b.toLowerCase();
const tokens = (units: bigint, decimals: number): string => fmt(Number(units) / 10 ** decimals, 6);
const flag = (data: Hex): boolean => decode("bool", data)[0] === true;

let sendEnvCache: SendEnv | null = null;

/** BridgeMinter, the vault and wtPOT, and the page's endpoints, for preflight.ts. */
const sendEnv = (): SendEnv =>
  (sendEnvCache ??= { sepolia: SEPOLIA, v3Evm: V3_EVM, vault: VAULT, minter: MINTER, token: TOKEN, sepoliaChainId: SEPOLIA_CHAIN_ID, registry });

/** The connected address, lower case, or null. */
function me(): Hex | null {
  const w = wallet.get();
  return w.status === "on" && w.address ? (w.address.toLowerCase() as Hex) : null;
}

// ---------------------------------------------------------------------------------------------
// One runner per transfer

interface Job {
  stop: boolean;
}

const jobs = new Map<string, Job>();

/** Runs `work` for a transfer unless a run of it is under way; an error it does not settle stops the transfer, saying why. */
function runFor(id: string, work: (job: Job) => Promise<void>): void {
  if (jobs.has(id)) return;
  const job: Job = { stop: false };
  jobs.set(id, job);
  void work(job)
    .catch((e: unknown) => stopped(id, e))
    .finally(() => {
      if (jobs.get(id) === job) jobs.delete(id);
    });
}

const lockT = (id: string): LockTransfer | null => {
  const t = transfers.get().get(id);
  return t?.dir === "in" ? t : null;
};

const burnT = (id: string): BurnTransfer | null => {
  const t = transfers.get().get(id);
  return t?.dir === "back" ? t : null;
};

function patchIn(id: string, p: Partial<LockTransfer> | ((t: LockTransfer) => Partial<LockTransfer>)): void {
  updateTransfer(id, (t) => (t.dir === "in" ? { ...t, ...(typeof p === "function" ? p(t) : p) } : t));
}

function patchBack(id: string, p: Partial<BurnTransfer> | ((t: BurnTransfer) => Partial<BurnTransfer>)): void {
  updateTransfer(id, (t) => (t.dir === "back" ? { ...t, ...(typeof p === "function" ? p(t) : p) } : t));
}

function say(id: string, note: Note | null): void {
  updateTransfer(id, (t) => (t.note?.text === note?.text && t.note?.wallet === note?.wallet ? t : { ...t, note }));
}

function fail(id: string, reason: Failure["reason"], title: string | null, text: string | null): void {
  updateTransfer(id, (t) => ({ ...t, failure: { reason, at: Date.now(), title, text }, note: null }));
}

/** What an error nothing settled means for the transfer: not sent, when nothing was; else the page stopped following it. */
function stopped(id: string, e: unknown): void {
  const t = transfers.get().get(id);
  if (!t || isDone(t) || t.failure) return;
  const sent = t.dir === "in" ? t.lock.stage !== "asking" : t.burn.stage !== "asking";
  if (e instanceof PlanError) fail(id, "proof", null, `${errorText(e)}.`);
  else if (sent) fail(id, "stopped", null, `${errorText(e)}. Nothing on chain changed: follow it again.`);
  else fail(id, "refused", null, `${errorText(e)}. Nothing was sent.`);
}

/**
 * Runs a read until a node answers it: after one that reached no node, again after 5 s, then 10, up
 * to a minute, saying so on the transfer, and with its earlier line back once it answers. Errors a
 * node answered with are the caller's. Null when the job stopped.
 */
async function patiently<T>(job: Job, id: string, chain: string, read: () => Promise<T>): Promise<{ value: T } | null> {
  const before = transfers.get().get(id)?.note ?? null;
  for (let wait = 5_000; !job.stop; wait = Math.min(60_000, wait * 2)) {
    try {
      const value = await read();
      if (transfers.get().get(id)?.note?.text.startsWith(chain)) say(id, before);
      return { value };
    } catch (e) {
      if (!unreachable(e)) throw e;
      say(id, { text: `${chain} did not answer: asking again in ${wait / 1000} s`, wallet: false });
      await sleep(wait);
    }
  }
  return null;
}

const usedOnSepolia = async (nonce: number): Promise<boolean> =>
  flag((await request<Hex>(SEPOLIA, "eth_call", [{ to: MINTER, data: encodeCall("used(uint256)", [BigInt(nonce)]) }, "latest"])).result);

/** A wallet that did not send: declined, or another reason in its own words. Nothing was sent either way. */
function walletRefused(id: string, e: unknown, what: "Lock" | "Burn"): false {
  const p = problemOf(e);
  if (p.kind === "rejected") fail(id, "rejected", null, null);
  else fail(id, "refused", `${what} not sent`, p.text);
  return false;
}

// ---------------------------------------------------------------------------------------------
// A sent transaction with no receipt: still pending, mined (a receipt the first node no longer
// keeps), or put out of place by another one from the wallet (its Speed up, or a Cancel)

/** A sent transaction as a node has it: its sender, the nonce it was sent with, and its block once mined. */
interface Seen {
  from: Hex;
  nonce: bigint;
  block: number | null;
}

/** What a node says of a transaction, or null while none knows it (a wallet may broadcast through its own nodes). */
async function seenTx(endpoints: Endpoint[], hash: Hex): Promise<Seen | null> {
  try {
    const x = (await request<{ from?: string; nonce?: string; blockNumber?: string | null } | null>(endpoints, "eth_getTransactionByHash", [hash], { accept: (r) => r !== null })).result;
    return x?.from && x.nonce ? { from: x.from.toLowerCase() as Hex, nonce: BigInt(x.nonce), block: x.blockNumber ? Number(BigInt(x.blockNumber)) : null } : null;
  } catch {
    return null;
  }
}

type Fate = "pending" | "mined" | "replaced";

/**
 * What became of a sent transaction that has no receipt: mined, when a node shows it in a block;
 * replaced, when the nonce it was sent with is taken by another mined transaction of its sender;
 * else pending. `seen` keeps what a node said of it once: a replaced transaction leaves the pools.
 */
async function fateOf(endpoints: Endpoint[], hash: Hex, seen: { tx: Seen | null }): Promise<Fate> {
  const now = await seenTx(endpoints, hash);
  seen.tx = now ?? seen.tx;
  if (now?.block != null) return "mined";
  const s = seen.tx;
  if (!s) return "pending";
  try {
    const count = BigInt((await request<Hex>(endpoints, "eth_getTransactionCount", [s.from, "latest"])).result);
    if (count <= s.nonce) return "pending";
  } catch {
    return "pending";
  }
  // Mined between the two reads, or not.
  const again = await seenTx(endpoints, hash);
  if (again?.block != null) {
    seen.tx = again;
    return "mined";
  }
  return "replaced";
}

/** A receipt as the sends read it, or as a log on chain stands for one when no endpoint serves the receipt (its gas then unknown). */
interface Landed {
  ok: boolean;
  block: number;
  gasUsed: number | null;
  logs: { address: string; topics: string[]; data: string }[];
}

/** A log as eth_getLogs gives it. */
interface ChainLog {
  address: string;
  topics: string[];
  data: string;
  transactionHash: string;
  blockNumber: string;
}

const landedOf = (log: ChainLog): Landed => ({ ok: true, block: Number(BigInt(log.blockNumber)), gasUsed: null, logs: [log] });

// ---------------------------------------------------------------------------------------------
// The way in: the lock

const newId = (dir: "in" | "back"): string => {
  const r = new Uint32Array(1);
  crypto.getRandomValues(r);
  return `${dir}-${Date.now().toString(36)}-${(r[0] ?? 0).toString(36)}`;
};

/** The review's Confirm on the way in: a new transfer, its screen, and the lock asked for. */
export function startLock(amountText: string): void {
  const amount = parseAmount(amountText);
  if (amount === null) return toast("revert", "Not an amount the vault takes", "Up to 14 decimals, more than 0.");
  const from = me();
  if (!from) return connectThen(() => startLock(amountText));
  const id = newId("in");
  putTransfer({
    id,
    dir: "in",
    amount,
    recipient: from,
    startedAt: Date.now(),
    doneAt: null,
    failure: null,
    note: null,
    lock: { stage: "asking" },
    nonce: null,
    commitment: null,
    finality: null,
    proof: { checks: waitingChecks(), builtAt: null },
    route: null,
    relayed: [],
    mint: null,
    resumed: false,
  });
  go(`#/tx/${id}`);
  runFor(id, (job) => lockFlow(job, id, true));
}

/** The way in from wherever the transfer is. `auto`: this tab is in the flow, so the wallet is asked for each next step as soon as it can be. */
async function lockFlow(job: Job, id: string, auto: boolean): Promise<void> {
  if (lockT(id)?.lock.stage === "asking" && !(await sendLock(job, id))) return;
  if (lockT(id)?.lock.stage === "sent" && !(await followLock(job, id))) return;
  const t = lockT(id);
  if (!t || job.stop || t.lock.stage !== "mined" || t.nonce === null || isDone(t)) return;
  if (t.mint?.stage === "sent") return followMint(job, id, auto);
  if (!t.finality && !(await waitFinality(job, id))) return;
  const plan = await readyPlan(job, id);
  if (!plan) return;
  if (!auto) return say(id, null);
  await signMint(job, id, plan);
}

async function sendLock(job: Job, id: string): Promise<boolean> {
  const t = lockT(id);
  if (!t) return false;
  const from = t.recipient;
  if (!sameAddress(me(), from)) {
    fail(id, "refused", "Lock not sent", `Connect ${short(from)}, the address this lock is for, then try again.`);
    return false;
  }
  if (!walletOn("v3")) {
    say(id, { text: "Switch your wallet to Portaldot V3 testnet", wallet: true });
    try {
      await switchTo("v3");
    } catch (e) {
      return walletRefused(id, e, "Lock");
    }
  }
  say(id, { text: "Checking the lock: a dry run on V3, and its gas", wallet: false });
  const got = await patiently(job, id, "Portaldot V3", () => prepareLock(sendEnv(), from, t.amount));
  if (!got || job.stop) return false;
  const prep = got.value;
  if ("problem" in prep) {
    fail(id, "refused", prep.problem.title, prep.problem.text);
    return false;
  }
  say(id, null);
  let hash: Hex;
  try {
    hash = await sendOn("v3", { to: VAULT, data: prep.data, value: prep.value, gas: prep.gas, ...prep.fees });
  } catch (e) {
    return walletRefused(id, e, "Lock");
  }
  patchIn(id, { lock: { stage: "sent", hash, sentAt: Date.now() } });
  return true;
}

/**
 * The lock's receipt, then its Locked log checked and its commitment recomputed: the nonce comes from
 * there. Without a receipt, the vault's logs: the lock under this hash, or under the one the wallet's
 * Speed up sent at the same nonce; a Cancel in its place locked nothing.
 */
async function followLock(job: Job, id: string): Promise<boolean> {
  const seen = { tx: null as Seen | null };
  let strikes = 0;
  for (let round = 1; !job.stop; round++) {
    const t = lockT(id);
    if (!t || t.lock.stage !== "sent") return false;
    const { hash, sentAt } = t.lock;
    const got = await patiently(job, id, "Portaldot V3", () => receiptOn("v3", hash));
    if (!got) return false;
    let r: Landed | null = got.value;
    if (!r && round % REPLACED_EVERY === 0) {
      const fate = await fateOf(V3_EVM, hash, seen);
      const logs = await locksSince(t).catch((): ChainLog[] => []);
      const mine = logs.find((l) => l.transactionHash.toLowerCase() === hash);
      const other = logs.find((l) => l.transactionHash.toLowerCase() !== hash);
      if (mine) r = landedOf(mine);
      else if (other && (fate === "replaced" || !seen.tx)) {
        patchIn(id, { lock: { stage: "sent", hash: other.transactionHash.toLowerCase() as Hex, sentAt } });
        seen.tx = null;
        strikes = 0;
        continue;
      } else {
        // Twice, a round apart, so that a speed-up whose log no node serves yet is not taken for a cancel.
        strikes = fate === "replaced" ? strikes + 1 : 0;
        if (strikes >= 2) {
          fail(id, "rejected", "Lock replaced in your wallet", "Your wallet sent another transaction in its place, a cancel say: nothing was locked. Try again, or change the amount.");
          return false;
        }
      }
    }
    if (!r) {
      if (round === 100) say(id, { text: "Not mined after 5 min: open your wallet to see whether it is still pending", wallet: false });
      await sleep(V3_POLL);
      continue;
    }
    if (!r.ok) {
      fail(id, "reverted", "The lock reverted on V3", "Your tPOT was not taken: only the fee was paid. Try again, or change the amount.");
      return false;
    }
    const check = lockedOf(r.logs, registry, { vault: VAULT, v3ChainId: V3_CHAIN_ID, sepoliaChainId: SEPOLIA_CHAIN_ID, minter: MINTER, sender: t.recipient, amount: t.amount });
    if (!check.ok) {
      fail(id, "stopped", "The lock's receipt did not check out", `In V3 block #${r.block}, ${check.why}. Look at the transaction before anything else is sent.`);
      return false;
    }
    const minedAt = await blockTimeOn("v3", r.block).catch(() => v3BlockTime(r.block).catch(() => Date.now()));
    patchIn(id, { lock: { stage: "mined", hash, sentAt, block: r.block, minedAt, gasUsed: r.gasUsed }, nonce: Number(check.nonce), commitment: check.commitment, note: null });
    void readBalances();
    return true;
  }
  return false;
}

/** V3's finalized head, read until it reaches the lock's block: GRANDPA finality, which the proofs need. */
async function waitFinality(job: Job, id: string): Promise<boolean> {
  const reader = new V3Reader(proofEnv().v3);
  while (!job.stop) {
    const t = lockT(id);
    if (!t || t.lock.stage !== "mined") return false;
    const block = t.lock.block;
    const got = await patiently(job, id, "Portaldot V3", () => reader.finalizedHead());
    if (!got) return false;
    const head = got.value;
    if (head.number >= block) {
      patchIn(id, { finality: { block: head.number, hash: head.hash, setId: Number(head.setId), signatures: null, authorities: null, at: Date.now() } });
      return true;
    }
    await sleep(V3_POLL);
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// The way in: the mint

function setCheck(id: string, c: Check): void {
  patchIn(id, (t) => (t.proof.checks[c.key] === c.state ? {} : { proof: { ...t.proof, checks: { ...t.proof.checks, [c.key]: c.state } } }));
}

const checksOf = (list: Check[]): Record<CheckKey, CheckState> => {
  const out = waitingChecks();
  for (const c of list) out[c.key] = c.state;
  return out;
};

/** The plan's route on the transfer: the path, the transaction asked for next, and, the first time, how many set changes and how much gas in all. */
function applyPlan(id: string, p: MintPlan): void {
  const target = p.target;
  const tx = p.txs[0];
  const imports = p.txs.flatMap((x) => x.calls).filter((c) => c.method === "importHeader").length;
  const total = p.txs.every((x) => x.gasLimit !== null) ? p.txs.reduce((s, x) => s + Number(x.gasLimit), 0) : null;
  patchIn(id, (t) => {
    const done = t.relayed.length;
    const prev = done ? t.route : null;
    return {
      proof: { checks: checksOf(p.checks), builtAt: p.builtAt },
      finality: target
        ? {
            block: target.number,
            hash: target.hash,
            setId: Number(target.setId),
            signatures: target.signatures,
            authorities: target.authorities,
            at: t.finality?.at ?? Date.now(),
          }
        : t.finality,
      route: {
        path: p.path ?? "head",
        imports: prev ? prev.imports : imports,
        title: tx?.title ?? "",
        gas: tx?.gasLimit != null ? Number(tx.gasLimit) : null,
        step: done + 1,
        steps: done + p.txs.length,
        total: prev ? prev.total : total,
      },
      note: null,
    };
  });
}

/** One plan of the mint, with the sender's address for its dry run; asked again while a chain does not answer. */
async function planFor(job: Job, id: string): Promise<MintPlan | null> {
  const t = lockT(id);
  const lock = t?.lock;
  if (!t || t.nonce === null || t.commitment === null || lock?.stage !== "mined") return null;
  const ref: LockRef = { nonce: BigInt(t.nonce), block: lock.block, amount: t.amount, recipient: t.recipient, commitment: t.commitment };
  const from = me() ?? undefined;
  const got = await patiently(job, id, "Sepolia or Portaldot V3", () => planMint(ref, proofEnv(), { ...(from ? { from } : {}), onCheck: (c) => setCheck(id, c) }));
  return got?.value ?? null;
}

/**
 * The mint planned until its plan is ready, or what the plan says instead settled: minted (by
 * whoever sent it), a check that failed, a light client its admin has to unblock. Null when there
 * is nothing to send.
 */
async function readyPlan(job: Job, id: string): Promise<MintPlan | null> {
  for (let moved = 0; !job.stop; ) {
    const t = lockT(id);
    if (!t || isDone(t) || t.failure) return null;
    const plan = await planFor(job, id);
    if (!plan || job.stop) return null;
    switch (plan.status) {
      case "ready":
        applyPlan(id, plan);
        return plan;
      case "minted":
        await completeMinted(job, id);
        return null;
      case "blocked":
        patchIn(id, { proof: { checks: checksOf(plan.checks), builtAt: null } });
        fail(id, "blocked", "The mint is blocked", `${plan.why} Your tPOT stays locked for you; the lock does not expire.`);
        return null;
      case "failed":
        patchIn(id, { proof: { checks: checksOf(plan.checks), builtAt: null } });
        fail(id, "proof", null, `${plan.why} Nothing was sent to Sepolia. Your tPOT stays locked for you; the lock does not expire.`);
        return null;
      case "moved":
        if (++moved > 6) {
          fail(id, "stopped", "The chains kept moving", `${plan.why} Six plans in a row were overtaken by newer blocks: try again.`);
          return null;
        }
        say(id, { text: "A newer import moved the light client: planning again", wallet: false });
        await sleep(1_500);
        break;
      case "waiting":
        say(id, { text: plan.why, wallet: false });
        await sleep(4_000);
        break;
    }
  }
  return null;
}

/**
 * The mint asked for in the wallet: on Sepolia, from the plan made right before the prompt (the
 * one in hand when it is that fresh and no other prompt came in between), with its gas limit and
 * Sepolia's fees, then followed. Any address can send it: it pays the lock's recipient.
 */
async function signMint(job: Job, id: string, fresh: MintPlan | null): Promise<void> {
  if (!me()) {
    patchIn(id, { mint: null, note: null });
    toast("info", "Connect a wallet to mint", "Any address can send the mint: it pays the lock's recipient, whoever sends it.");
    connectThen(() => sign(id));
    return;
  }
  let plan = fresh;
  if (!walletOn("sepolia")) {
    say(id, { text: "Switch your wallet to Ethereum Sepolia", wallet: true });
    try {
      await switchTo("sepolia");
    } catch (e) {
      return mintNotSent(id, e);
    }
    plan = null;
  }
  if (!plan || Date.now() - plan.builtAt > FRESH_PLAN) {
    say(id, { text: "Checking the mint again: the proof, and a dry run on Sepolia", wallet: false });
    plan = await readyPlan(job, id);
    if (!plan) return;
  }
  const tx = plan.txs[0];
  const from = me();
  if (!tx || tx.gasLimit === null || !from) return say(id, null);
  const gas = tx.gasLimit;
  const got = await patiently(job, id, "Sepolia", () => Promise.all([sepoliaFeesNow(SEPOLIA), balanceOn(SEPOLIA, from)]));
  if (!got) return;
  const [{ maxFeePerGas, maxPriorityFeePerGas }, eth] = got.value;
  const fees = { maxFeePerGas, maxPriorityFeePerGas };
  const need = upFront(0n, gas, fees);
  if (eth < need) {
    patchIn(id, { mint: null });
    fail(id, "refused", "Not enough Sepolia ETH", `This transaction's gas needs up to ${tokens(need, 18)} ETH, and ${short(from)} has ${tokens(eth, 18)}. Your tPOT stays locked for you; the lock does not expire.`);
    return;
  }
  patchIn(id, { mint: { stage: "asking" }, note: null });
  let hash: Hex;
  try {
    hash = await sendOn("sepolia", { to: tx.to, data: tx.data, gas, ...fees });
  } catch (e) {
    return mintNotSent(id, e);
  }
  patchIn(id, { mint: { stage: "sent", hash, sentAt: Date.now() } });
  await followMint(job, id, true);
}

function mintNotSent(id: string, e: unknown): void {
  const p = problemOf(e);
  patchIn(id, { mint: null, note: null });
  if (p.kind === "rejected") toast("info", "Mint not sent", "You declined it in your wallet. Your tPOT stays locked for you: sign the mint when you like.");
  else toast("revert", "Mint not sent", p.text);
}

/**
 * The mint's receipt, and used(nonce) every third round: a mint anyone else sent, or the wallet's own
 * speed-up under another hash, completes the transfer too. A self-relay's transaction that only
 * imports set changes goes on to the next one. One the wallet replaced is planned again.
 */
async function followMint(job: Job, id: string, auto: boolean): Promise<void> {
  const seen = { tx: null as Seen | null };
  for (let round = 1; !job.stop; round++) {
    const t = lockT(id);
    if (!t || t.mint?.stage !== "sent" || t.nonce === null) return;
    const { hash, sentAt } = t.mint;
    const nonce = t.nonce;
    const got = await patiently(job, id, "Sepolia", () => receiptOn("sepolia", hash, round === 1 || round % REPLACED_EVERY === 0));
    if (!got) return;
    const r = got.value;
    if (r?.ok) {
      const minted = mintedIn(r.logs, registry, MINTER, BigInt(nonce));
      if (minted) {
        const minedAt = await blockTimeOn("sepolia", r.block).catch(() => Date.now());
        return finish(id, { stage: "mined", hash, sentAt, block: r.block, minedAt, gasUsed: r.gasUsed });
      }
      patchIn(id, (x) => ({ relayed: [...x.relayed, { hash, block: r.block }], mint: null }));
      toast("verify", "Set changes imported", `Transaction ${t.route?.step ?? 1} of ${t.route?.steps ?? 2} is mined: the light client follows V3's newer validator set. The next one mints.`);
      const plan = await readyPlan(job, id);
      if (plan && auto) await signMint(job, id, plan);
      return;
    }
    if (r || round % 3 === 0) {
      const used = await patiently(job, id, "Sepolia", () => usedOnSepolia(nonce));
      if (!used) return;
      if (used.value) return completeMinted(job, id);
      if (r) {
        patchIn(id, { mint: null });
        toast("revert", "The transaction reverted on Sepolia", "Only its gas was paid: the chains moved between the dry run and the block. The mint is planned again; sign it once more.");
        await readyPlan(job, id);
        return;
      }
    }
    const fate = !r && round % REPLACED_EVERY === 0 ? await fateOf(SEPOLIA, hash, seen) : "pending";
    if (fate !== "pending") {
      // A speed-up that minted completes the transfer. Mined with a receipt no endpoint serves, it
      // was a self-relay's import; replaced (a cancel, or a sped-up import), the plan says what is left.
      const used = await patiently(job, id, "Sepolia", () => usedOnSepolia(nonce));
      if (!used) return;
      if (used.value) return completeMinted(job, id);
      if (fate === "mined") {
        patchIn(id, (x) => ({ relayed: [...x.relayed, { hash, block: seen.tx?.block ?? 0 }], mint: null }));
        const plan = await readyPlan(job, id);
        if (plan && auto) await signMint(job, id, plan);
        return;
      }
      patchIn(id, { mint: null });
      toast("info", "Your wallet replaced the transaction", "It sent another one in its place. The mint is planned again from what the chains hold now.");
      await readyPlan(job, id);
      return;
    }
    await sleep(SEPOLIA_POLL);
  }
}

/** A lock minted by a transaction this page did not follow (another tab, someone else, a speed-up): its Minted log, its block and the V3 block it proved. */
async function completeMinted(job: Job, id: string): Promise<void> {
  for (let tries = 0; !job.stop; tries++) {
    const t = lockT(id);
    if (!t || t.nonce === null || isDone(t)) return;
    say(id, { text: "Minted: finding the mint's transaction on Sepolia", wallet: false });
    const nonce = t.nonce;
    const got = await patiently(job, id, "Sepolia", () => findMint(nonce));
    if (!got) return;
    const m = got.value;
    if (m) {
      const minedAt = await blockTimeOn("sepolia", m.block).catch(() => Date.now());
      let finality = t.finality;
      if (!finality || finality.hash !== m.final.hash) {
        const block = m.final.block ?? (await new V3Reader(proofEnv().v3).header(m.final.hash).then((h) => h.number).catch(() => null));
        finality = block === null ? finality : { block, hash: m.final.hash, setId: m.final.setId, signatures: m.final.signatures, authorities: null, at: t.finality?.at ?? minedAt };
      }
      const sentAt = t.mint && t.mint.stage !== "asking" && t.mint.hash === m.tx ? t.mint.sentAt : minedAt;
      patchIn(id, { finality, proof: { checks: { header: "passed", sigs: "passed", proof: "passed", commit: "passed", nonce: "passed" }, builtAt: t.proof.builtAt } });
      return finish(id, { stage: "mined", hash: m.tx, sentAt, block: m.block, minedAt, gasUsed: m.gasUsed });
    }
    if (tries === 9) {
      fail(id, "stopped", "Minted, its transaction not found yet", `used(${nonce}) is true on Sepolia, but no RPC served its Minted log yet. Follow it again in a minute.`);
      return;
    }
    await sleep(6_000);
  }
}

function finish(id: string, mint: LockTransfer["mint"]): void {
  patchIn(id, { mint, doneAt: Date.now(), note: null, failure: null });
  const t = lockT(id);
  if (t) toast("verify", "Minted on Sepolia", `${fmt(Number(t.amount) / 1e14)} wtPOT to ${short(t.recipient)}, proven from lock ${t.nonce ?? ""} in the vault's storage.`);
  void readBalances();
}

/**
 * Finish mint for a lock this browser does not follow (Activity's "Locked, not minted", a lock read
 * by its nonce): the lock as the chains have it, its mint planned and asked for. Its clock starts
 * now; the lock's own steps are not timed.
 */
async function adopt(n: number): Promise<void> {
  const chainId = `lock-${n}`;
  const known = followerOf(chainId);
  if (known) {
    go(`#/tx/${known.id}`);
    return sign(known.id);
  }
  const read = chainReads.get().get(chainId);
  let x = read?.state === "live" && read.value.dir === "in" ? read.value : null;
  if (!x) {
    try {
      x = await findLock(n);
    } catch (e) {
      return toast("revert", "Could not read the lock", errorText(e));
    }
  }
  if (!x) return toast("revert", "Lock not found", `The vault has no lock ${n} for this bridge.`);
  if (x.minted === true) return go(`#/receipt/${chainId}`);
  const id = newId("in");
  const at = x.at ?? Date.now();
  putTransfer({
    id,
    dir: "in",
    amount: x.amount,
    recipient: x.recipient.toLowerCase() as Hex,
    startedAt: Date.now(),
    doneAt: null,
    failure: null,
    note: null,
    lock: { stage: "mined", hash: x.tx, sentAt: at, block: x.block, minedAt: at, gasUsed: null },
    nonce: n,
    commitment: x.commitment,
    finality: null,
    proof: { checks: waitingChecks(), builtAt: null },
    route: null,
    relayed: [],
    mint: null,
    resumed: true,
  });
  go(`#/tx/${id}`);
  runFor(id, (job) => lockFlow(job, id, true));
}

// ---------------------------------------------------------------------------------------------
// The way back: the burn

/** The review's Confirm on the way back: a new transfer, its screen, and the burn asked for. */
export function startBurn(amountText: string): void {
  const amount = parseAmount(amountText);
  if (amount === null) return toast("revert", "Not an amount BridgeMinter takes", "Up to 14 decimals, more than 0.");
  const from = me();
  if (!from) return connectThen(() => startBurn(amountText));
  const id = newId("back");
  putTransfer({
    id,
    dir: "back",
    amount,
    recipient: from,
    startedAt: Date.now(),
    doneAt: null,
    failure: null,
    note: null,
    speed: watcherSpeed(amount),
    fallback: false,
    burn: { stage: "asking" },
    burnNonce: null,
    burnId: null,
    depth: { confirmations: 0, final: false, qualifiedAt: null },
    release: { approvals: 0, open: null, run: null, at: null, released: false },
  });
  go(`#/tx/${id}`);
  runFor(id, (job) => burnFlow(job, id));
}

async function burnFlow(job: Job, id: string): Promise<void> {
  if (burnT(id)?.burn.stage === "asking" && !(await sendBurn(job, id))) return;
  if (burnT(id)?.burn.stage === "sent" && !(await followBurn(job, id))) return;
  await followRelease(job, id);
}

async function sendBurn(job: Job, id: string): Promise<boolean> {
  const t = burnT(id);
  if (!t) return false;
  const from = t.recipient;
  if (!sameAddress(me(), from)) {
    fail(id, "refused", "Burn not sent", `Connect ${short(from)}, the address this burn is from and pays on V3, then try again.`);
    return false;
  }
  if (!walletOn("sepolia")) {
    say(id, { text: "Switch your wallet to Ethereum Sepolia", wallet: true });
    try {
      await switchTo("sepolia");
    } catch (e) {
      return walletRefused(id, e, "Burn");
    }
  }
  say(id, { text: "Checking the burn: your address, your wtPOT, the vault, and a dry run on Sepolia", wallet: false });
  const got = await patiently(job, id, "Sepolia or Portaldot V3", () => prepareBurn(sendEnv(), from, t.amount));
  if (!got || job.stop) return false;
  const prep = got.value;
  if ("problem" in prep) {
    fail(id, "refused", prep.problem.title, prep.problem.text);
    return false;
  }
  say(id, null);
  let hash: Hex;
  try {
    hash = await sendOn("sepolia", { to: MINTER, data: prep.data, gas: prep.gas, ...prep.fees });
  } catch (e) {
    return walletRefused(id, e, "Burn");
  }
  patchBack(id, { burn: { stage: "sent", hash, sentAt: Date.now() } });
  return true;
}

/**
 * The burn's receipt, then its BurnRequested log checked: the burn nonce and the burn id come from
 * there. Without a receipt, the minter's logs: the burn under this hash (a receipt the first node no
 * longer keeps), or under the one the wallet's Speed up sent at the same nonce; a Cancel in its place
 * burned nothing.
 */
async function followBurn(job: Job, id: string): Promise<boolean> {
  const seen = { tx: null as Seen | null };
  let strikes = 0;
  for (let round = 1; !job.stop; round++) {
    const t = burnT(id);
    if (!t || t.burn.stage !== "sent") return false;
    const { hash, sentAt } = t.burn;
    const look = round % REPLACED_EVERY === 0;
    const got = await patiently(job, id, "Sepolia", () => receiptOn("sepolia", hash, round === 1 || look));
    if (!got) return false;
    let r: Landed | null = got.value;
    if (!r && look) {
      const fate = await fateOf(SEPOLIA, hash, seen);
      const logs = await burnsSince(t).catch((): ChainLog[] => []);
      const mine = logs.find((l) => l.transactionHash.toLowerCase() === hash);
      const other = logs.find((l) => l.transactionHash.toLowerCase() !== hash);
      if (mine) r = landedOf(mine);
      else if (other && (fate === "replaced" || !seen.tx)) {
        patchBack(id, { burn: { stage: "sent", hash: other.transactionHash.toLowerCase() as Hex, sentAt } });
        seen.tx = null;
        strikes = 0;
        continue;
      } else {
        strikes = fate === "replaced" ? strikes + 1 : 0;
        if (strikes >= 2) {
          fail(id, "rejected", "Burn replaced in your wallet", "Your wallet sent another transaction in its place, a cancel say: nothing was burned. Try again, or change the amount.");
          return false;
        }
      }
    }
    if (!r) {
      await sleep(SEPOLIA_POLL);
      continue;
    }
    if (!r.ok) {
      fail(id, "reverted", "The burn reverted on Sepolia", "Nothing was burned: only the fee was paid. Try again, or change the amount.");
      return false;
    }
    const check = burnedOf(r.logs, registry, { minter: MINTER, sepoliaChainId: SEPOLIA_CHAIN_ID, sender: t.recipient, amount: t.amount });
    if (!check.ok) {
      fail(id, "stopped", "The burn's receipt did not check out", `In Sepolia block #${r.block}, ${check.why}.`);
      return false;
    }
    const minedAt = await blockTimeOn("sepolia", r.block).catch(() => Date.now());
    patchBack(id, { burn: { stage: "mined", hash, sentAt, block: r.block, minedAt, gasUsed: r.gasUsed }, burnNonce: Number(check.burnNonce), burnId: check.burnId, note: null });
    void readBalances();
    return true;
  }
  return false;
}

/**
 * After the burn: Sepolia's heads until its block is final (the confirmations Fast waits for, and
 * the finality Standard waits for), the committee's open operation once it qualifies, and
 * released(burnId) on V3 once a V3 block, read at a block this page names so that the release's own
 * block can be found when it turns true.
 */
async function followRelease(job: Job, id: string): Promise<void> {
  let lastFalse: number | null = null;
  let headsAt = 0;
  let openAt = 0;
  while (!job.stop) {
    const t = burnT(id);
    if (!t || t.burn.stage !== "mined" || !t.burnId || isDone(t)) return;
    const burnId = t.burnId;
    const block = t.burn.block;
    if (!t.depth.final && Date.now() - headsAt >= HEADS_POLL) {
      const h = await patiently(job, id, "Sepolia", () => sepoliaHeads());
      if (!h) return;
      headsAt = Date.now();
      const confirmations = Math.max(0, h.value.latest - block);
      const final = h.value.finalized >= block;
      patchBack(id, (x) => {
        const qualifies = final || (x.speed === "fast" && confirmations >= 3);
        return { depth: { confirmations, final, qualifiedAt: x.depth.qualifiedAt ?? (qualifies ? Date.now() : null) } };
      });
    }
    const r = await patiently(job, id, "Portaldot V3", () => releasedNow(burnId));
    if (!r) return;
    if (r.value.released) return settleRelease(id, burnId, lastFalse, r.value.block);
    lastFalse = r.value.block;
    const q = burnT(id);
    if (q && q.depth.qualifiedAt !== null && q.release.approvals < 1 && Date.now() - openAt >= HEADS_POLL) {
      openAt = Date.now();
      const o = await openFor(burnId).catch(() => null);
      if (o) patchBack(id, (x) => ({ release: { ...x.release, approvals: Math.max(x.release.approvals, o.approvals), open: o.open } }));
    }
    await sleep(RELEASE_POLL);
  }
}

const v3Node = () => proofEnv().v3;

/** released(burnId) on the vault, at V3's latest block, and that block. */
async function releasedNow(burnId: Hex): Promise<{ released: boolean; block: number }> {
  const head = Number(BigInt((await request<Hex>(V3_EVM, "eth_blockNumber", [])).result));
  return { released: await releasedAt(burnId, head), block: head };
}

async function releasedAt(burnId: Hex, block: number): Promise<boolean> {
  return flag((await request<Hex>(V3_EVM, "eth_call", [{ to: VAULT, data: encodeCall("released(bytes32)", [burnId]) }, qty(block)])).result);
}

const extrinsics = new Map<number, Hex[]>();

/** A V3 block's extrinsics, from the Substrate node (the committee's approvals are Substrate extrinsics, which the EVM RPC does not show). */
async function extrinsicsOf(block: number): Promise<Hex[]> {
  const known = extrinsics.get(block);
  if (known) return known;
  const hash = (await v3Node().request<Hex | null>("chain_getBlockHash", [block])).result;
  if (!hash) throw new Error(`the V3 node has no block #${block}`);
  const b = (await v3Node().request<{ block: { extrinsics: Hex[] } } | null>("chain_getBlock", [hash])).result;
  const list = b?.block.extrinsics ?? [];
  extrinsics.set(block, list);
  return list;
}

const extrinsicHash = (x: Hex): Hex => bytesToHex(blake2b256(hexToBytes(x)));

/**
 * The committee's open operation for this burn: the multisig's operations on V3 (Multisig.Multisigs),
 * each with its opening extrinsic, which carries the release call, and so the burn id, in full.
 */
async function openFor(burnId: Hex): Promise<{ approvals: number; open: { extrinsic: Hex; block: number } } | null> {
  const keys = (await v3Node().request<Hex[] | null>("state_getKeysPaged", [COMMITTEE_MULTISIGS, 16])).result ?? [];
  for (const key of keys) {
    const value = (await v3Node().request<Hex | null>("state_getStorage", [key])).result;
    const m = value ? multisigOf(hexToBytes(value)) : null;
    if (!m) continue;
    const x = (await extrinsicsOf(m.height))[m.index];
    if (x && carries(x, burnId)) return { approvals: m.approvals, open: { extrinsic: extrinsicHash(x), block: m.height } };
  }
  return null;
}

/**
 * Released: the block it turned true in, by bisection between the last read that said false and
 * the one that said true (over the state V3's EVM RPC keeps), then the extrinsic there that carries
 * the burn id, which ran the release, and the block's time. Unknown when that is older than the
 * state the RPC keeps: the release stands on released(burnId) alone then.
 */
async function findRelease(burnId: Hex, lastFalse: number | null, at: number): Promise<{ run: { extrinsic: Hex; block: number } | null; time: number | null }> {
  let lo = lastFalse ?? Math.max(0, at - V3_EVM_STATE);
  let hi = at;
  if (lastFalse === null && (await releasedAt(burnId, lo))) return { run: null, time: null };
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await releasedAt(burnId, mid)) hi = mid;
    else lo = mid;
  }
  const list = await extrinsicsOf(hi);
  const run = [...list].reverse().find((x) => carries(x, burnId));
  const first = list[0];
  return { run: run ? { extrinsic: extrinsicHash(run), block: hi } : null, time: first ? Number(decodeTimestampInherent(first).moment) : null };
}

async function settleRelease(id: string, burnId: Hex, lastFalse: number | null, at: number): Promise<void> {
  say(id, { text: "Released: finding the committee's extrinsic on V3", wallet: false });
  const found = await findRelease(burnId, lastFalse, at).catch(() => ({ run: null, time: null }));
  patchBack(id, (x) => ({ release: { ...x.release, approvals: 2, run: found.run, at: found.time, released: true }, doneAt: Date.now(), note: null, failure: null }));
  const t = burnT(id);
  if (t) toast("trust", "Released on V3", `${fmt(Number(t.amount) / 1e14)} tPOT paid to ${short(t.recipient)} by the committee.`);
  void readBalances();
}

// ---------------------------------------------------------------------------------------------
// A lock or a burn sent under another hash than the one this page holds: a reload that cut the
// wallet's prompt off, or the wallet's own Speed up

/**
 * The vault's Locked logs from this transfer's sender for its amount, from about ten minutes before
 * it started, but those of locks other transfers of this browser follow.
 */
async function locksSince(t: LockTransfer): Promise<ChainLog[]> {
  const head = Number(BigInt((await request<Hex>(V3_EVM, "eth_blockNumber", [])).result));
  const from = Math.max(0, head - Math.ceil((Date.now() - t.startedAt) / 6_000) - 100);
  const logs = (await request<ChainLog[]>(V3_EVM, "eth_getLogs", [{ address: VAULT, topics: [LOCKED, null, topicOf(t.recipient)], fromBlock: qty(from), toBlock: "latest" }])).result;
  const others = [...transfers.get().values()].filter((x): x is LockTransfer => x.dir === "in" && x.id !== t.id);
  const nonces = new Set(others.map((x) => x.nonce));
  const hashes = new Set(others.map((x) => (x.lock.stage === "asking" ? null : x.lock.hash)));
  return (logs ?? []).filter((log) => {
    const d = registry.decodeLog(log);
    const nonce = d?.args.find((a) => a.name === "nonce")?.value;
    const amount = d?.args.find((a) => a.name === "amountNative")?.value;
    return d?.name === "Locked" && amount === t.amount && typeof nonce === "bigint" && !nonces.has(Number(nonce)) && !hashes.has(log.transactionHash.toLowerCase() as Hex);
  });
}

/**
 * BridgeMinter's BurnRequested logs from this transfer's sender for its amount, from about ten
 * minutes before it started, but those of burns other transfers of this browser follow.
 */
async function burnsSince(t: BurnTransfer): Promise<ChainLog[]> {
  const head = Number(BigInt((await request<Hex>(SEPOLIA, "eth_blockNumber", [])).result));
  const from = Math.max(0, head - Math.ceil((Date.now() - t.startedAt) / 12_000) - 50);
  const logs = (await request<ChainLog[]>(SEPOLIA_LOGS, "eth_getLogs", [{ address: MINTER, topics: [BURN_REQUESTED, null, topicOf(t.recipient)], fromBlock: qty(from), toBlock: "latest" }])).result;
  const others = [...transfers.get().values()].filter((x): x is BurnTransfer => x.dir === "back" && x.id !== t.id);
  const nonces = new Set(others.map((x) => x.burnNonce));
  const hashes = new Set(others.map((x) => (x.burn.stage === "asking" ? null : x.burn.hash)));
  return (logs ?? []).filter((log) => {
    const d = registry.decodeLog(log);
    const n = d?.args.find((a) => a.name === "burnNonce")?.value;
    const amount = d?.args.find((a) => a.name === "amount")?.value;
    return d?.name === "BurnRequested" && amount === t.amount && typeof n === "bigint" && !nonces.has(Number(n)) && !hashes.has(log.transactionHash.toLowerCase() as Hex);
  });
}

/** A transfer whose wallet prompt the reload cut off: its transaction on the chain if the wallet sent it, else not sent. */
async function recover(job: Job, id: string): Promise<void> {
  const t = transfers.get().get(id);
  if (!t) return;
  const what = t.dir === "in" ? "lock" : "burn";
  say(id, { text: `This page reloaded while your wallet was asking: looking for the ${what} on ${t.dir === "in" ? "V3" : "Sepolia"}`, wallet: false });
  const got = await patiently(job, id, t.dir === "in" ? "Portaldot V3" : "Sepolia", () => (t.dir === "in" ? locksSince(t) : burnsSince(t)));
  if (!got) return;
  const found = got.value[0];
  if (!found) {
    fail(id, "refused", "Not sent", `This page reloaded while your wallet was asking, and no such ${what} from your address is on chain since. If you confirm it in your wallet later, Activity lists it from the chain.`);
    return;
  }
  const sent = { stage: "sent" as const, hash: found.transactionHash.toLowerCase() as Hex, sentAt: t.startedAt };
  if (t.dir === "in") {
    patchIn(id, { lock: sent, note: null });
    await lockFlow(job, id, false);
  } else {
    patchBack(id, { burn: sent, note: null });
    await burnFlow(job, id);
  }
}

// ---------------------------------------------------------------------------------------------
// The transfer screen's buttons

/** Sign the mint: a live lock's, or Finish mint for a lock read by its nonce (lock-<n>). */
function sign(id: string): void {
  const k = nonceOf(id);
  if (k) {
    if (k.dir === "in") void adopt(k.n);
    return;
  }
  if (!lockT(id)) return;
  connectThen(() => runFor(id, (job) => lockFlow(job, id, true)));
}

/** Try again from where the transfer stopped: the lock or the burn again when nothing is on chain, else on from there. */
function retry(id: string): void {
  const t = transfers.get().get(id);
  if (!t || jobs.has(id)) return;
  const again = (): void => {
    const x = transfers.get().get(id);
    if (!x) return;
    if (x.dir === "in") {
      const fresh = x.nonce === null && x.lock.stage !== "mined" && (x.failure?.reason !== "stopped" || x.lock.stage === "asking");
      patchIn(id, fresh ? { failure: null, note: null, lock: { stage: "asking" }, startedAt: Date.now() } : { failure: null, note: null });
      runFor(id, (job) => lockFlow(job, id, true));
    } else {
      const fresh = x.burnNonce === null && x.burn.stage !== "mined" && (x.failure?.reason !== "stopped" || x.burn.stage === "asking");
      patchBack(id, fresh ? { failure: null, note: null, burn: { stage: "asking" }, startedAt: Date.now() } : { failure: null, note: null });
      runFor(id, (job) => burnFlow(job, id));
    }
  };
  connectThen(again);
}

/** The wallet's own Speed up re-signs the same mint at its nonce; this page follows the lock's nonce, so either copy completes it. */
function speedUp(id: string): void {
  toast(
    "info",
    "Speed it up in your wallet",
    "Open the pending mint in your wallet and choose Speed up: it re-signs the same mint at the same nonce, with a higher fee. This page follows the lock's nonce, so whichever copy is mined completes the transfer.",
  );
  const t = lockT(id);
  if (t?.mint?.stage === "sent" && !jobs.has(id)) runFor(id, (job) => followMint(job, id, false));
}

// ---------------------------------------------------------------------------------------------
// Locks that wait for the visitor

/**
 * The locks on chain that no run follows (waiting for the visitor's click, or stopped): one that
 * anyone else minted meanwhile (another tab, the relayer's operator) completes here too.
 */
function watchIdle(): void {
  if (document.hidden) return;
  for (const t of transfers.get().values()) {
    if (t.dir !== "in" || t.nonce === null || isDone(t) || jobs.has(t.id)) continue;
    const { id, nonce } = t;
    void usedOnSepolia(nonce).then(
      (used) => {
        if (!used || jobs.has(id)) return;
        patchIn(id, { failure: null });
        runFor(id, (job) => completeMinted(job, id));
      },
      () => undefined,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// The journal

const storage = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

function readJournal(): LiveTransfer[] {
  try {
    return decodeJournal(storage()?.getItem(JOURNAL_KEY) ?? null);
  } catch {
    return [];
  }
}

/** Writes this tab's transfers over the journal, keeping what other tabs added since (by id). */
function saveJournal(): void {
  try {
    const mine = [...transfers.get().values()];
    const ids = new Set(mine.map((t) => t.id));
    storage()?.setItem(JOURNAL_KEY, encodeJournal([...readJournal().filter((t) => !ids.has(t.id)), ...mine]));
  } catch {
    // Full or blocked: the page follows its transfers until it closes, and Activity reads them from the chains.
  }
}

/**
 * A transfer read back from the journal, followed again from where the chains have it: one this page
 * had stopped following too, as the chains may have moved on. A wallet prompt the reload cut off is
 * gone; the chains say whether it was sent.
 */
function resume(t: LiveTransfer): void {
  if (isDone(t) || (t.failure && t.failure.reason !== "stopped")) return;
  if (t.failure) updateTransfer(t.id, (x) => ({ ...x, failure: null }));
  if (t.dir === "in") {
    if (t.lock.stage === "asking") return runFor(t.id, (job) => recover(job, t.id));
    runFor(t.id, (job) => lockFlow(job, t.id, false));
  } else {
    if (t.burn.stage === "asking") return runFor(t.id, (job) => recover(job, t.id));
    runFor(t.id, (job) => burnFlow(job, t.id));
  }
}

let started = false;

/** Reads the journal back and follows each transfer again, keeps the journal from then on, and wires the transfer screen's buttons. */
export function startSends(): void {
  if (started) return;
  started = true;
  transferActions.retry = retry;
  transferActions.sign = sign;
  transferActions.speedUp = speedUp;
  for (const t of readJournal()) putTransfer(t.dir === "in" && t.mint?.stage === "asking" ? { ...t, mint: null } : t);
  transfers.subscribe(saveJournal);
  for (const t of transfers.get().values()) resume(t);
  setInterval(watchIdle, IDLE_POLL);
}
