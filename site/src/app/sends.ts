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
// the page loads: the journal says what to look for, the chains say what happened. One tab follows
// each transfer (tabs.ts): another tab shows it as the journal has it, and takes it over when that
// tab closes. A transfer this tab starts asks the wallet for each next step as soon as it can; one
// read back after a reload waits for the visitor's click. The checks before each prompt are
// preflight.ts's and the proof core's dry runs. The wallet signs; nothing here holds a key.

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
import { decodeJournal, encodeJournal, JOURNAL_KEY, mergeJournal } from "./journal.ts";
import { balanceOn, errorText, nextNonce, prepareBurn, prepareLock, sepoliaFeesNow, unreachable, type SendEnv } from "./preflight.ts";
import { go } from "./router.ts";
import { claim, follows, onTaken, own, take } from "./tabs.ts";
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

/** Runs `work` for a transfer unless a run of it is under way, or another tab follows it; an error it does not settle stops the transfer, saying why. */
function runFor(id: string, work: (job: Job) => Promise<void>): void {
  if (jobs.has(id) || !follows(id)) return;
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

/**
 * What an error nothing settled means for the transfer: not sent, when the wallet was never asked;
 * else the page stopped following it (once asked, the wallet may have sent it: recover looks).
 */
function stopped(id: string, e: unknown): void {
  const t = transfers.get().get(id);
  if (!t || isDone(t) || t.failure || !follows(id)) return;
  const sent = t.dir === "in" ? t.lock.stage !== "asking" : t.burn.stage !== "asking";
  if (e instanceof PlanError) fail(id, "proof", null, `${errorText(e)}.`);
  else if (sent) fail(id, "stopped", null, `${errorText(e)}. Nothing on chain changed: follow it again.`);
  else if (t.fromBlock !== undefined) fail(id, "stopped", null, `${errorText(e)}. Whether your wallet sent it is not known here: follow it again to look for it.`);
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

/** The wallet moved to another account during the network switch or the checks: nothing is sent, from it or for it. */
function switched(id: string, what: "Lock" | "Burn", from: Hex): false {
  const now = me();
  const role = what === "Lock" ? "this lock is for" : "this burn is from and pays on V3";
  fail(id, "refused", `${what} not sent`, `Your wallet ${now ? `moved to ${short(now)}` : "disconnected"} after the checks. Connect ${short(from)}, the address ${role}, then try again.`);
  return false;
}

/** A transfer whose tab may have a wallet prompt open for it: its lock, burn or mint asked for, and no answer yet. */
const promptOpen = (t: LiveTransfer): boolean =>
  t.failure === null && (t.dir === "in" ? t.lock.stage === "asking" || t.mint?.stage === "asking" : t.burn.stage === "asking");

/**
 * A transfer another tab of this browser follows: the visitor acting on it here takes it over (that
 * tab stops following it), then `act` runs here; unless that tab may have a wallet prompt open for
 * it, which this page leaves to that tab. True when the action is that tab's to finish.
 */
function elsewhere(id: string, act: () => void): boolean {
  if (follows(id)) return false;
  const t = readJournal().find((x) => x.id === id) ?? transfers.get().get(id);
  if (t && promptOpen(t)) {
    toast("info", "Your wallet is asked in another tab", "Another tab of this browser is asking your wallet for this transfer's next step. Answer it there: this page shows what it does.");
    return true;
  }
  take(id, () => {
    // As the tab that followed it wrote it last.
    const latest = readJournal().find((x) => x.id === id);
    if (latest) putTransfer(latest);
    act();
  });
  return true;
}

/** Whether the address has a transaction its chain has not mined: its nonce counted with pending transactions past its latest. */
async function pendingFrom(endpoints: Endpoint[], address: Hex): Promise<boolean> {
  const count = (tag: string) => request<Hex>(endpoints, "eth_getTransactionCount", [address, tag]).then((a) => BigInt(a.result));
  try {
    const [latest, pending] = await Promise.all([count("latest"), count("pending")]);
    return pending > latest;
  } catch {
    return false;
  }
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
 * Its nonce is the one a node showed it with, else `by`'s, read before the wallet was asked (a
 * Cancel can leave the pools before any node here showed the transaction, and V3's node may show
 * only mined ones). The callers take "replaced" twice, a check apart, before they act on it.
 */
async function fateOf(endpoints: Endpoint[], hash: Hex, seen: { tx: Seen | null }, by: { from: Hex; nonce: number } | undefined): Promise<Fate> {
  const now = await seenTx(endpoints, hash);
  seen.tx = now ?? seen.tx;
  if (now?.block != null) return "mined";
  const s = seen.tx ?? (by ? { from: by.from, nonce: BigInt(by.nonce), block: null } : null);
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

/** The account the review named is not the wallet's now: nothing is started for another one. */
function reviewedElse(reviewed: string, now: Hex, what: string): boolean {
  if (sameAddress(now, reviewed)) return false;
  toast("revert", "Your wallet changed account", `You reviewed this ${what} for ${short(reviewed)}, and your wallet is on ${short(now)} now. Review it again.`);
  return true;
}

/** The review's Confirm on the way in: a new transfer, its screen, and the lock asked for, for `reviewed`, the address the review showed. */
export function startLock(amountText: string, reviewed: string): void {
  const amount = parseAmount(amountText);
  if (amount === null) return toast("revert", "Not an amount the vault takes", "Up to 14 decimals, more than 0.");
  const from = me();
  if (!from) return connectThen(() => startLock(amountText, reviewed));
  if (reviewedElse(reviewed, from, "lock")) return;
  const id = newId("in");
  own(id);
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
  if (!sameAddress(me(), from)) return switched(id, "Lock", from);
  // Whatever the wallet sends from here on is in a later block than the checks read.
  patchIn(id, (x) => ({ note: null, fromBlock: prep.head === null ? x.fromBlock : prep.head + 1 }));
  let hash: Hex;
  try {
    hash = await sendOn("v3", { from, to: VAULT, data: prep.data, value: prep.value, gas: prep.gas, ...prep.fees });
  } catch (e) {
    return walletRefused(id, e, "Lock");
  }
  patchIn(id, { lock: { stage: "sent", hash, sentAt: Date.now(), ...(prep.nonce === null ? {} : { by: { from, nonce: prep.nonce } }) } });
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
    const { hash, sentAt, by } = t.lock;
    const got = await patiently(job, id, "Portaldot V3", () => receiptOn("v3", hash));
    if (!got) return false;
    let r: Landed | null = got.value;
    // Seen in a pool from the first round: a Cancel can take its place within seconds.
    if (!r && !seen.tx) seen.tx = await seenTx(V3_EVM, hash);
    if (!r && round % REPLACED_EVERY === 0) {
      const fate = await fateOf(V3_EVM, hash, seen, by);
      const logs = await locksSince(t).catch((): ChainLog[] => []);
      const mine = logs.find((l) => l.transactionHash.toLowerCase() === hash);
      const other = logs.find((l) => l.transactionHash.toLowerCase() !== hash);
      if (mine) r = landedOf(mine);
      else if (other && (fate === "replaced" || !seen.tx)) {
        // The Speed up's copy: its log is on chain, so its receipt or that log settles it next round.
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
  const got = await patiently(job, id, "Sepolia", () => Promise.all([sepoliaFeesNow(SEPOLIA), balanceOn(SEPOLIA, from), nextNonce(SEPOLIA, from)]));
  if (!got) return;
  const [{ maxFeePerGas, maxPriorityFeePerGas }, eth, next] = got.value;
  const fees = { maxFeePerGas, maxPriorityFeePerGas };
  const need = upFront(0n, gas, fees);
  if (eth < need) {
    patchIn(id, { mint: null });
    fail(id, "refused", "Not enough Sepolia ETH", `This transaction's gas needs up to ${tokens(need, 18)} ETH, and ${short(from)} has ${tokens(eth, 18)}. Your tPOT stays locked for you; the lock does not expire.`);
    return;
  }
  const twin = mintElsewhere(id);
  if (twin) {
    // One mint is enough: this transfer completes when that one lands (watchIdle reads used(nonce)).
    patchIn(id, { mint: null, note: null });
    toast("info", "This lock's mint is under way", `Another transfer of this browser ${twin === "asking" ? "is asking your wallet for" : "has sent"} the same lock's mint. This one completes when it lands.`);
    return;
  }
  patchIn(id, { mint: { stage: "asking" }, note: null });
  let hash: Hex;
  try {
    hash = await sendOn("sepolia", { from, to: tx.to, data: tx.data, gas, ...fees });
  } catch (e) {
    return mintNotSent(id, e);
  }
  patchIn(id, { mint: { stage: "sent", hash, sentAt: Date.now(), ...(next === null ? {} : { by: { from, nonce: next } }) } });
  await followMint(job, id, true);
}

/**
 * Another entry of the journal for the same lock whose mint a wallet is asked for, or has sent: in
 * another tab, or a Finish mint made while that tab had not written the lock's nonce yet. The
 * journal, not this tab's copy: it has what every tab wrote last.
 */
function mintElsewhere(id: string): "asking" | "sent" | null {
  const nonce = lockT(id)?.nonce ?? null;
  if (nonce === null) return null;
  for (const x of readJournal()) {
    if (x.id === id || x.dir !== "in" || x.nonce !== nonce || isDone(x)) continue;
    if (x.mint?.stage === "asking" || x.mint?.stage === "sent") return x.mint.stage;
  }
  return null;
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
  let strikes = 0;
  for (let round = 1; !job.stop; round++) {
    const t = lockT(id);
    if (!t || t.mint?.stage !== "sent" || t.nonce === null) return;
    const { hash, sentAt, by } = t.mint;
    const nonce = t.nonce;
    const got = await patiently(job, id, "Sepolia", () => receiptOn("sepolia", hash, round === 1 || round % REPLACED_EVERY === 0));
    if (!got) return;
    const r = got.value;
    if (!r && !seen.tx) seen.tx = await seenTx(SEPOLIA, hash);
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
    let fate: Fate = "pending";
    if (!r && round % REPLACED_EVERY === 0) {
      fate = await fateOf(SEPOLIA, hash, seen, by);
      // Twice, a check apart, as for the lock and the burn: once could be a copy no node serves yet.
      strikes = fate === "replaced" ? strikes + 1 : 0;
      if (fate === "replaced" && strikes < 2) fate = "pending";
    }
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
  own(id);
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

/** The review's Confirm on the way back: a new transfer, its screen, and the burn asked for, from `reviewed`, the address the review showed. */
export function startBurn(amountText: string, reviewed: string): void {
  const amount = parseAmount(amountText);
  if (amount === null) return toast("revert", "Not an amount BridgeMinter takes", "Up to 14 decimals, more than 0.");
  const from = me();
  if (!from) return connectThen(() => startBurn(amountText, reviewed));
  if (reviewedElse(reviewed, from, "burn")) return;
  const id = newId("back");
  own(id);
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
  if (!sameAddress(me(), from)) return switched(id, "Burn", from);
  // Whatever the wallet sends from here on is in a later block than the checks read.
  patchBack(id, (x) => ({ note: null, fromBlock: prep.head === null ? x.fromBlock : prep.head + 1 }));
  let hash: Hex;
  try {
    hash = await sendOn("sepolia", { from, to: MINTER, data: prep.data, gas: prep.gas, ...prep.fees });
  } catch (e) {
    return walletRefused(id, e, "Burn");
  }
  patchBack(id, { burn: { stage: "sent", hash, sentAt: Date.now(), ...(prep.nonce === null ? {} : { by: { from, nonce: prep.nonce } }) } });
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
    const { hash, sentAt, by } = t.burn;
    const look = round % REPLACED_EVERY === 0;
    const got = await patiently(job, id, "Sepolia", () => receiptOn("sepolia", hash, round === 1 || look));
    if (!got) return false;
    let r: Landed | null = got.value;
    // Seen in a pool from the first round: a Cancel can take its place within seconds.
    if (!r && !seen.tx) seen.tx = await seenTx(SEPOLIA, hash);
    if (!r && look) {
      const fate = await fateOf(SEPOLIA, hash, seen, by);
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
// A lock or a burn sent under another hash than the one this page holds: a closed tab or a reload
// that cut the wallet's prompt off, or the wallet's own Speed up

/**
 * Where a transfer's lock or burn can be: from the block after the one the checks before the wallet's
 * prompt read (fromBlock), so a lock or a burn the address made before cannot be taken for it. A
 * transfer from before the page kept that block: about ten minutes before it started.
 */
async function searchFrom(t: LiveTransfer, endpoints: Endpoint[], blockSeconds: number, slack: number): Promise<number> {
  if (t.fromBlock !== undefined) return t.fromBlock;
  const head = Number(BigInt((await request<Hex>(endpoints, "eth_blockNumber", [])).result));
  return Math.max(0, head - Math.ceil((Date.now() - t.startedAt) / (blockSeconds * 1000)) - slack);
}

/** The vault's Locked logs from this transfer's sender for its amount, since searchFrom, but those of locks other transfers of this browser follow. Oldest first. */
async function locksSince(t: LockTransfer): Promise<ChainLog[]> {
  const from = await searchFrom(t, V3_EVM, 6, 100);
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

/** BridgeMinter's BurnRequested logs from this transfer's sender for its amount, since searchFrom, but those of burns other transfers of this browser follow. Oldest first. */
async function burnsSince(t: BurnTransfer): Promise<ChainLog[]> {
  const from = await searchFrom(t, SEPOLIA, 12, 50);
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

/** How long recover looks for a lock or a burn before it counts as not sent; and at most, while the sender has a transaction pending on that chain. */
const RECOVER_FOR = 3 * 60_000;
const RECOVER_PENDING_FOR = 15 * 60_000;

/** The transfer's lock or burn on chain, looked for once: its log since the wallet was asked. */
async function onChain(job: Job, id: string, t: LiveTransfer): Promise<{ found: ChainLog | null } | null> {
  const got = await patiently(job, id, t.dir === "in" ? "Portaldot V3" : "Sepolia", () => (t.dir === "in" ? locksSince(t) : burnsSince(t)));
  return got ? { found: got.value[0] ?? null } : null;
}

/** The lock or the burn found on chain, followed as this transfer's from there. */
async function followFound(job: Job, id: string, t: LiveTransfer, log: ChainLog): Promise<void> {
  const sent = { stage: "sent" as const, hash: log.transactionHash.toLowerCase() as Hex, sentAt: t.startedAt };
  if (t.dir === "in") {
    patchIn(id, { lock: sent, note: null, failure: null });
    await lockFlow(job, id, false);
  } else {
    patchBack(id, { burn: sent, note: null, failure: null });
    await burnFlow(job, id);
  }
}

/**
 * A transfer whose wallet prompt was cut off (the tab that asked closed or reloaded first): its lock
 * or burn on chain if the wallet sent it, else not sent. Not after one read: a confirmed transaction
 * takes a block or two to show, and a wallet's prompt can outlive the page that opened it. So a few
 * minutes, and longer while the sender has a transaction pending there. One the page closed on
 * before the wallet was asked (no fromBlock: the checks were still running) is looked for once.
 */
async function recover(job: Job, id: string): Promise<void> {
  const t = transfers.get().get(id);
  if (!t) return;
  const what = t.dir === "in" ? "lock" : "burn";
  const chain = t.dir === "in" ? "V3" : "Sepolia";
  const asked = t.fromBlock !== undefined;
  const began = Date.now();
  say(id, { text: asked ? `Looking for the ${what} on ${chain}: the page that asked your wallet closed first. If the wallet still asks, answer it there.` : `Looking for the ${what} on ${chain}`, wallet: false });
  for (;;) {
    const read = await onChain(job, id, t);
    if (!read || job.stop) return;
    if (read.found) return followFound(job, id, t, read.found);
    if (!asked) break;
    const waited = Date.now() - began;
    if (waited >= RECOVER_FOR && (waited >= RECOVER_PENDING_FOR || !(await pendingFrom(t.dir === "in" ? V3_EVM : SEPOLIA, t.recipient)))) break;
    await sleep(t.dir === "in" ? 2 * V3_POLL : 3 * SEPOLIA_POLL);
    if (job.stop) return;
  }
  fail(
    id,
    "refused",
    "Not sent",
    asked
      ? `No ${what} from your address for this amount is on ${chain} since your wallet was asked for it. If you confirm it in your wallet later, Activity lists it from the chain.`
      : `The page closed while it checked the ${what}, before your wallet was asked: nothing was sent.`,
  );
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
  if (!lockT(id) || elsewhere(id, () => sign(id))) return;
  connectThen(() => runFor(id, (job) => lockFlow(job, id, true)));
}

/**
 * Try again from where the transfer stopped: the lock or the burn again when nothing is on chain,
 * else on from there. Before the wallet is asked for another, the one it was asked for before is
 * looked for once more: confirmed late, or a Speed up taken for a Cancel, it is this transfer's.
 */
function retry(id: string): void {
  const t = transfers.get().get(id);
  if (!t || jobs.has(id) || elsewhere(id, () => retry(id))) return;
  connectThen(() =>
    runFor(id, async (job) => {
      const x = transfers.get().get(id);
      if (!x) return;
      const stage = x.dir === "in" ? x.lock.stage : x.burn.stage;
      // Stopped while it looked for what the wallet sent: looked for again, as after a reload.
      if (stage === "asking" && x.failure?.reason === "stopped" && x.fromBlock !== undefined) {
        updateTransfer(id, (y) => ({ ...y, failure: null }));
        return recover(job, id);
      }
      const unsent = (x.dir === "in" ? x.nonce : x.burnNonce) === null;
      const fresh = unsent && stage !== "mined" && (x.failure?.reason !== "stopped" || stage === "asking");
      const asked = x.fromBlock !== undefined && x.failure?.reason !== "reverted";
      updateTransfer(id, (y) => ({ ...y, failure: null, note: fresh && asked ? { text: `Looking on ${x.dir === "in" ? "V3" : "Sepolia"} for the ${x.dir === "in" ? "lock" : "burn"} your wallet was asked for before`, wallet: false } : null }));
      if (fresh && asked) {
        const read = await onChain(job, id, x);
        if (!read || job.stop) return;
        if (read.found) return followFound(job, id, x, read.found);
      }
      // A fresh attempt: its own fromBlock is taken before the wallet is asked again.
      if (x.dir === "in") {
        if (fresh) patchIn(id, { note: null, lock: { stage: "asking" }, startedAt: Date.now(), fromBlock: undefined });
        await lockFlow(job, id, true);
      } else {
        if (fresh) patchBack(id, { note: null, burn: { stage: "asking" }, startedAt: Date.now(), fromBlock: undefined });
        await burnFlow(job, id);
      }
    }),
  );
}

/** The wallet's own Speed up re-signs the same mint at its nonce; this page follows the lock's nonce, so either copy completes it. */
function speedUp(id: string): void {
  if (elsewhere(id, () => speedUp(id))) return;
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
    if (t.dir !== "in" || t.nonce === null || isDone(t) || jobs.has(t.id) || !follows(t.id)) continue;
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

/** Set while another tab's journal is copied in: what it wrote is not written back. */
let mirroring = false;

/** Writes the transfers this tab follows over the journal; every other entry stays as the tab that follows it wrote it (journal.ts, mergeJournal). */
function saveJournal(): void {
  if (mirroring) return;
  try {
    storage()?.setItem(JOURNAL_KEY, encodeJournal(mergeJournal(readJournal(), [...transfers.get().values()], follows)));
  } catch {
    // Full or blocked: the page follows its transfers until it closes, and Activity reads them from the chains.
  }
}

/** Another tab wrote the journal: the transfers it follows, as it has them now, and any it started, which this tab takes over if that tab closes. */
function mirror(e: StorageEvent): void {
  if (e.key !== JOURNAL_KEY) return;
  const added: LiveTransfer[] = [];
  mirroring = true;
  try {
    for (const t of decodeJournal(e.newValue)) {
      if (follows(t.id)) continue;
      const known = transfers.get().get(t.id);
      if (!known) added.push(t);
      if (!known || encodeJournal([known]) !== encodeJournal([t])) putTransfer(t);
    }
  } finally {
    mirroring = false;
  }
  for (const t of added) if (!isDone(t)) claim(t.id, () => takeOver(t.id));
}

/**
 * A transfer this tab follows from now on: as the journal has it last (the tab that followed it
 * may have moved it on), then followed again from there. A mint prompt that tab had open is gone
 * with it.
 */
function takeOver(id: string): void {
  const latest = readJournal().find((t) => t.id === id) ?? transfers.get().get(id);
  if (!latest) return;
  const t = latest.dir === "in" && latest.mint?.stage === "asking" ? { ...latest, mint: null } : latest;
  putTransfer(t);
  resume(t);
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

/**
 * Reads the journal back and follows each transfer again once this tab holds it (at once, unless
 * another tab follows it now), keeps the journal from then on, and wires the transfer screen's
 * buttons.
 */
export function startSends(): void {
  if (started) return;
  started = true;
  transferActions.retry = retry;
  transferActions.sign = sign;
  transferActions.speedUp = speedUp;
  // The visitor acted on a transfer in another tab, which took it from this one: this tab stops
  // running it, shows what that tab writes, and takes it back when that tab closes.
  onTaken((id) => {
    const job = jobs.get(id);
    if (job) job.stop = true;
    claim(id, () => takeOver(id));
  });
  for (const t of readJournal()) putTransfer(t);
  transfers.subscribe(saveJournal);
  window.addEventListener("storage", mirror);
  for (const t of transfers.get().values()) if (!isDone(t)) claim(t.id, () => takeOver(t.id));
  setInterval(watchIdle, IDLE_POLL);
}
