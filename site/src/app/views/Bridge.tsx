// The bridge: the card (direction, amount, what each way trusts, speed, cost, the action), the strip
// below it with each way's recorded numbers, and the card's sheets (pick a chain, review, get ETH).

import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { MINTER, SEPOLIA, TOKEN, VAULT } from "../../lib/chains.ts";
import { checksum } from "../../lib/display.ts";
import { formatUnits } from "../../lib/format.ts";
import type { Hex } from "../../lib/hex.ts";
import { CALLS_PER_TX } from "../../lib/proof/plan.ts";
import { request } from "../../lib/rpc.ts";
import { openWalletPicker } from "../connect.tsx";
import {
  AUTO_TIME,
  BURN_GAS,
  BURN_GAS_FULL,
  CH,
  FAST_CAP,
  IMPORT_GAS,
  LATER_CHAINS,
  LOCK_CEILING,
  LOCK_COST,
  LOCK_DEPOSIT,
  MINT_GAS,
  MINT_GAS_FULL,
  README,
  SPEED_NAME,
  SUBSTRATE_ROOM,
  TIME,
  V3_RPC,
  fromOf,
  toOf,
  type ChainInfo,
  type Dir,
  type Speed,
} from "../facts.ts";
import { AUTO_MINT, autoMints } from "../handoff.ts";
import type { NetState } from "../net.ts";
import { loadChain, normalize, polka, polkaList, type PolkaState } from "../polkadot.ts";
import type { Route } from "../router.ts";
import { startBurn, startLock, startSubstrateLock } from "../sends.ts";
import { Box, useBox } from "../store.ts";
import { checkRecipient, recipientNote, senderOf, shortSs58, type RecipientCheck } from "../substrate/account.ts";
import type { PreparedLock } from "../substrate/send.ts";
import { DECIMALS, parseAmount } from "../txmath.ts";
import { CopyChip, Icon, Mark, Mono, Nb, Tip, announce, closeSheet, fmt, openSheet, short, toast } from "../ui.tsx";
import { readBalances, switchTo, wallet, walletCode, type WalletState } from "../wallet.ts";

interface Form {
  amount: string;
  details: boolean;
  /** The wallet refused to add V3: show the network's parameters to add by hand. */
  addHelp: boolean;
  /** A lock from a Polkadot wallet: the Sepolia address it pays, as typed or filled in from the Ethereum wallet. */
  to: string;
  toFrom: "typed" | "wallet";
}

/** Kept across pages, so the amount survives a visit to Activity. */
const form = new Box<Form>({ amount: "1", details: false, addHelp: false, to: "", toFrom: "typed" });

const setForm = (p: Partial<Form>) => form.set((f) => ({ ...f, ...p }));

function amountValue(s: string): number {
  const v = parseFloat(s.replace(/,/g, ""));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** A base-unit amount as a plain decimal string, for the amount field. */
function units(v: bigint, decimals: number): string {
  const s = v.toString().padStart(decimals + 1, "0");
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return frac ? `${s.slice(0, -decimals)}.${frac}` : s.slice(0, -decimals);
}

/** Digits and one point, at most 14 decimals (tPOT's and wtPOT's). */
function cleanAmount(raw: string): string {
  let v = raw.replace(/[^0-9.]/g, "");
  const parts = v.split(".");
  if (parts.length > 2) v = `${parts[0]}.${parts.slice(1).join("")}`;
  const [int, frac] = v.split(".");
  if (frac && frac.length > 14) v = `${int}.${frac.slice(0, 14)}`;
  return v;
}

/** What the card needs to know, worked out once per render. */
interface Facts {
  dir: Dir;
  from: ChainInfo;
  to: ChainInfo;
  value: number;
  conn: boolean;
  loading: boolean;
  ready: boolean;
  bal: number | null;
  eth: number | null;
  short: boolean;
  noEth: boolean;
  wrong: boolean;
  fastOK: boolean;
  speed: Speed;
  time: readonly [string, string];
  max: string;
  /** The way in from a Polkadot wallet's account: it signs the lock, and the recipient is the Sepolia address given. */
  sub: boolean;
  /** The way in below auto-mint's minimum. */
  below: boolean;
  /** The way in, minted by auto-mint: an Ethereum wallet's lock of its minimum or more (handoff.ts). Otherwise the visitor mints it, with Sepolia ETH. */
  auto: boolean;
  /** The visitor's own Sepolia transaction is part of this transfer: the burn, or a mint auto-mint does not send. */
  ethNeeded: boolean;
  /** A lock from a Polkadot wallet: the Sepolia address typed, checked. */
  rc: RecipientCheck | null;
}

function work(dir: Dir, f: Form, w: WalletState, p: PolkaState): Facts {
  const from = fromOf(dir);
  const to = toOf(dir);
  const value = amountValue(f.amount);
  const sub = dir === "in" && p.status === "on" && p.account !== null;
  const evmOn = w.status === "on" && !!w.address;
  const conn = sub || evmOn;
  const loading = sub ? p.balance === null : w.status === "connecting" || (conn && !w.balances);
  const ready = conn && !loading;
  const raw = sub ? p.balance : dir === "in" ? w.balances?.tpot : w.balances?.wtpot;
  const bal = raw == null ? null : Number(raw) / 1e14;
  const eth = evmOn && w.balances?.eth != null ? Number(w.balances.eth) / 1e18 : null;
  const room = dir === "in" ? (sub ? SUBSTRATE_ROOM : LOCK_CEILING) : 0;
  const exact = parseAmount(f.amount);
  const kind = sub ? "substrate" : "evm";
  const below = dir === "in" && exact !== null && exact < AUTO_MINT.min;
  // Auto-mint mints an Ethereum wallet's lock of 0.001 tPOT or more, and no Polkadot wallet's yet
  // (handoff.ts): the burn, and any other lock, need the visitor's Sepolia ETH. With no amount in,
  // whether it takes this sender's locks at all.
  const auto = dir === "in" && autoMints(exact ?? AUTO_MINT.min, kind);
  const ethNeeded = dir === "back" || !auto;
  // The burn carries no speed: the watcher releases a burn of up to 1 tPOT fast (while no other fast
  // release waits for finality), and a larger one after Sepolia's finality. So the card shows the
  // speed the amount gets; it offers no choice the watcher would not honour.
  const speed: Speed = value > FAST_CAP ? "std" : "fast";
  let max = "0";
  if (raw != null) max = dir === "back" ? units(raw, 14) : String(Math.max(0, Math.floor(((bal ?? 0) - room) * 100) / 100));
  const rc = sub && p.account ? checkRecipient(f.to, { mapped: p.account.h160, others: othersOf(p), minter: MINTER, token: TOKEN, vault: VAULT }) : null;
  return {
    dir,
    from,
    to,
    value,
    conn,
    loading,
    ready,
    bal,
    eth,
    short: ready && bal !== null && value > 0 && value > bal - room,
    noEth: ready && ethNeeded && (sub ? eth === null || eth <= 0 : eth !== null && eth <= 0),
    wrong: !sub && ready && w.chainId !== null && w.chainId !== from.chainId,
    fastOK: value <= FAST_CAP,
    speed,
    time: auto ? AUTO_TIME : TIME[dir === "in" ? "in" : speed],
    max,
    sub,
    below,
    auto,
    ethNeeded,
    rc,
  };
}

/** Each wallet account's address on V3, worked out once. */
const h160s = new Map<string, Hex | null>();

/** The V3 addresses of the other accounts the Polkadot wallet shares, and how to name each: keyless on Sepolia, like the connected one's. */
function othersOf(p: PolkaState): { h160: Hex; label: string }[] {
  const out: { h160: Hex; label: string }[] = [];
  for (const r of p.accounts) {
    if (r.why) continue;
    let h = h160s.get(r.address);
    if (h === undefined) {
      h = senderOf(r.address);
      h160s.set(r.address, h);
    }
    if (!h || h === p.account?.h160) continue;
    const s = shortSs58(normalize(r.address) ?? r.address);
    out.push({ h160: h, label: r.name ? `${r.name} (${s})` : s });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The Sepolia address a lock from a Polkadot wallet pays

const notes = new Map<string, string | null>();

/** What Sepolia says of a recipient the checks passed: a contract, or an address with no history (account.ts, recipientNote). Read once per address. */
function useRecipientNote(address: Hex | null): string | null | undefined {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!address || notes.has(address)) return;
    let live = true;
    const t = setTimeout(() => {
      void Promise.all([
        request<string>(SEPOLIA, "eth_getCode", [address, "latest"]),
        request<string>(SEPOLIA, "eth_getTransactionCount", [address, "latest"]),
        request<string>(SEPOLIA, "eth_getBalance", [address, "latest"]),
      ]).then(
        ([code, count, balance]) => {
          notes.set(address, recipientNote(code.result, BigInt(count.result), BigInt(balance.result)));
          if (live) bump((n) => n + 1);
        },
        () => undefined,
      );
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [address]);
  return address ? notes.get(address) : null;
}

/** The connected Ethereum wallet's address in the To field: what "Connect an Ethereum wallet to fill it" does once the wallet is connected. */
function fillFromWallet(): void {
  const a = wallet.get().address;
  if (a) setForm({ to: checksum(a), toFrom: "wallet" });
}

/** The To line of a lock from a Polkadot wallet: the Sepolia address, its check, and the Ethereum wallet's address to fill it with. */
function RecipientField({ k, f, w }: { k: Facts; f: Form; w: WalletState }) {
  const rc = k.rc;
  const note = useRecipientNote(rc?.ok ? rc.address : null);
  const mine = w.status === "on" && w.address ? w.address : null;
  const filled = !!mine && rc?.ok === true && rc.address === mine.toLowerCase();
  const bad = rc && !rc.ok && rc.kind !== "empty";
  return (
    <div class="amount__line amount__line--to">
      <dt>
        <label for="to">To, on Sepolia</label>
      </dt>
      <dd class="recip">
      <input
        class={`recip__input mono${bad ? " is-error" : ""}`}
        id="to"
        type="text"
        inputMode="text"
        autoComplete="off"
        spellcheck={false}
        placeholder="Sepolia address (0x…)"
        aria-invalid={bad ? "true" : undefined}
        aria-describedby="to-note"
        value={f.to}
        onInput={(e) => setForm({ to: e.currentTarget.value.trim(), toFrom: "typed" })}
      />
      <p class={`recip__note${bad ? " recip__note--err" : note ? " recip__note--warn" : ""}`} id="to-note" role={bad ? "alert" : undefined}>
        {bad ? (
          <>
            <Icon id="i-alert" cls="i--12" />
            <span>{rc.text}</span>
          </>
        ) : rc?.ok ? (
          note ? (
            <>
              <Icon id="i-alert" cls="i--12" />
              <span>{note}</span>
            </>
          ) : (
            <>
              <Icon id="i-check" cls="i--12" />
              <span class="mono">{short(rc.shown)}</span>
              <span>{f.toFrom === "wallet" ? `· your ${w.name ?? "Ethereum wallet"}'s address` : "· checksum and form checked"}</span>
            </>
          )
        ) : (
          <span>The address that receives the wtPOT. It cannot be changed once the lock is on V3.</span>
        )}
      </p>
      <p class="recip__fill">
        {mine ? (
          filled ? null : (
            <button class="recip__chip" type="button" onClick={() => setForm({ to: checksum(mine), toFrom: "wallet" })}>
              <Icon id="i-wallet" cls="i--12" />
              Use {short(checksum(mine))} ({w.name ?? "your wallet"})
            </button>
          )
        ) : (
          <button class="text-link recip__connect" type="button" onClick={() => openWalletPicker(fillFromWallet, "evm", "fill")}>
            Connect an Ethereum wallet to fill it
          </button>
        )}
      </p>
      </dd>
    </div>
  );
}

function swapDir(dir: Dir): void {
  const next = dir === "in" ? "back" : "in";
  location.hash = `#/bridge/${next}`;
  announce(
    next === "in"
      ? "Direction: Portaldot V3 testnet to Ethereum Sepolia. Verified by the light client."
      : "Direction: Ethereum Sepolia to Portaldot V3 testnet. Trusted: a 2-of-3 committee releases your tPOT.",
  );
}

// ---------------------------------------------------------------------------------------------
// Sheets

function openPicker(side: "from" | "to", dir: Dir): void {
  const cur = side === "from" ? fromOf(dir).key : toOf(dir).key;
  const row = (c: ChainInfo, meta: ComponentChildren) => (
    <li key={c.key}>
      <button
        class="list-row"
        type="button"
        aria-current={c.key === cur}
        data-autofocus={c.key === cur ? "" : undefined}
        onClick={() => {
          closeSheet();
          if (c.key !== cur) swapDir(dir);
        }}
      >
        <Mark id={c.markId} cls="mark--36" />
        <span class="list-row__text">
          <span class="list-row__title">{c.full}</span>
          <span class="list-row__meta">{meta}</span>
        </span>
        <span class="list-row__end">
          <Icon id="i-check" cls="picker__tick" />
        </span>
      </button>
    </li>
  );
  openSheet({
    title: side === "from" ? "Send from" : "Receive on",
    cls: "picker",
    body: (
      <>
        <ul class="picker__list">
          {row(
            CH.v3,
            <>
              tPOT · chain <span class="mono">420420777</span>
            </>,
          )}
          {row(
            CH.sepolia,
            <>
              wtPOT · chain <span class="mono">11155111</span>
            </>,
          )}
        </ul>
        <div class="picker__later" aria-disabled="true">
          <p class="picker__later-head">
            <span class="picker__later-title">More EVM chains</span>
            <span class="badge badge--later badge--sm">Later</span>
          </p>
          <p class="picker__later-names">{LATER_CHAINS.join(" · ")}</p>
          <p class="picker__later-note">Each passed a full simulated run on Oct 24: deploy, import, proof and a tampered proof.</p>
        </div>
      </>
    ),
  });
}

function openGetEth(dir: Dir, address: string): void {
  const inDir = dir === "in";
  const check = () => {
    void readBalances().then(() => {
      const e = wallet.get().balances?.eth;
      if (e && e > 0n) {
        closeSheet(true);
        toast("verify", "Sepolia ETH found", `${fmt(Number(e) / 1e18)} ETH on Sepolia. You can bridge now.`);
      } else toast("info", "No Sepolia ETH yet", "A faucet can take a minute. This page also checks on its own every 30 s.");
    });
  };
  openSheet({
    title: "Get Sepolia ETH",
    body: (
      <div class="sheet-stack">
        <div class="empty-mark" aria-hidden="true">
          <Mark id="m-eth" cls="mark--28" />
        </div>
        <p class="sheet-lead">
          {inDir
            ? `You send the mint on Sepolia yourself, so you pay its gas: about ${MINT_GAS} M gas, in Sepolia ETH.`
            : `The burn is a Sepolia transaction: about ${BURN_GAS} k gas, in Sepolia ETH.`}{" "}
          Bridge Zero has no faucet of its own; any public Sepolia faucet works.
        </p>
        <div class="kv">
          <dt class="kv__k">Send it to</dt>
          <dd class="kv__v">
            <CopyChip value={address} label="your address" shown={short(address)} />
          </dd>
        </div>
        <button class="btn btn--primary btn--lg btn--block" type="button" data-autofocus onClick={check}>
          I have Sepolia ETH, check again
        </button>
        <p class="sheet-foot">Your balance updates here on its own. {inDir ? "Lock once you have it, so the mint doesn't wait on you." : ""}</p>
      </div>
    ),
  });
}

/** The mint's gas while the light client is `behind` V3's validator set: the mint imports each change first (sends.ts, the self-relay). */
const mintGas = (behind: number): string => fmt(Number(MINT_GAS) + IMPORT_GAS * behind, 1);

/** The Sepolia transactions of a mint that imports `behind` set changes first: the plan's calls, at most CALLS_PER_TX to a transaction (../../lib/proof/plan.ts). */
const sepoliaTxs = (behind: number): number => Math.ceil((behind + 1) / CALLS_PER_TX);

/** A lock from a Polkadot wallet, as the review checks it on V3 before Confirm: the dry run from the account, its deposit, the fee. */
type LockCheck = { state: "checking" } | { state: "ok"; prep: PreparedLock } | { state: "problem"; title: string; text: string };

const lockCheck = new Box<LockCheck>({ state: "checking" });
let checkSeq = 0;

/** Checks the lock on V3 (read-only: a dry run and a fee quote), for the review's costs and its Confirm. */
function checkLock(origin: string, amount: bigint, recipient: Hex): void {
  const seq = ++checkSeq;
  lockCheck.set({ state: "checking" });
  void loadChain()
    .then((c) => c.prepareLock(origin, amount, recipient))
    .then(
      (prep) => {
        if (seq === checkSeq) lockCheck.set("problem" in prep ? { state: "problem", ...prep.problem } : { state: "ok", prep });
      },
      (e: unknown) => {
        if (seq === checkSeq) lockCheck.set({ state: "problem", title: "Could not check the lock on V3", text: `${e instanceof Error ? e.message : String(e)}. Close this and try again.` });
      },
    );
}

const tpot = (units: bigint, max = 4): string => fmt(Number(units) / 1e14, max);

/** The review's costs of a lock from a Polkadot wallet: V3's dry run's storage deposit and its fee quote. */
function LockCosts() {
  const c = useBox(lockCheck);
  if (c.state === "checking") {
    return (
      <span class="kv__check">
        <span class="skel" /> <span class="kv__note">checking on V3</span>
      </span>
    );
  }
  if (c.state === "problem") return <span class="kv__bad">{c.title}</span>;
  return (
    <>
      <Nb>
        <Mono>{tpot(c.prep.deposit)}</Mono> tPOT deposit
      </Nb>{" "}
      +{" "}
      <Nb>
        ≈ <Mono>{tpot(c.prep.fee, 3)}</Mono> tPOT fee
      </Nb>
      <span class="kv__note kv__line">storage deposit and fee, from V3's dry run of this lock</span>
    </>
  );
}

/** The lock step's cost in the review: what V3's dry run said it takes besides the amount. */
function LockStepCost() {
  const c = useBox(lockCheck);
  if (c.state !== "ok") return <span class="skel" />;
  return (
    <>
      <Nb>≈ {tpot(c.prep.deposit + c.prep.fee, 3)} tPOT</Nb> · <Nb>{tpot(c.prep.deposit)} storage deposit + fee</Nb>
    </>
  );
}

/** What the review's check found wrong, under the steps. */
function LockProblem() {
  const c = useBox(lockCheck);
  if (c.state !== "problem") return null;
  return (
    <div class="notice notice--revert" role="alert">
      <Icon id="i-alert" />
      <div>
        <p class="notice__title">{c.title}</p>
        <p>{c.text}</p>
      </div>
    </div>
  );
}

/** Who signs a lock from a Polkadot wallet, and where it pays: what the review names. */
interface SubLock {
  address: string;
  name: string | null;
  h160: Hex;
  walletName: string;
  recipient: Hex;
  shown: string;
  /** Filled in from the Ethereum wallet, or typed. */
  from: "wallet" | "typed";
  ethWallet: string | null;
}

/**
 * `amount`: the field's text, which the sends parse exactly; `value` is how the sheet shows it, to
 * its last decimal; `address`: the account the sheet names, which Confirm locks or burns for and
 * from, or nothing; `txs`: the mint's Sepolia transactions; `sub`: a lock from a Polkadot wallet.
 */
function ReviewFoot({ k, value, amount, address, txs, sub }: { k: Facts; value: string; amount: string; address: string; txs: number; sub: SubLock | null }) {
  const inDir = k.dir === "in";
  const [consent, setConsent] = useState(false);
  const check = useBox(lockCheck);
  // A burn is asked to be understood as trusted; a typed recipient, to be checked: it cannot be undone.
  const needsConsent = !inDir || (sub !== null && sub.from === "typed");
  const blocked = sub !== null && check.state !== "ok";
  const confirm = () => {
    closeSheet(true);
    if (sub) startSubstrateLock(amount, sub.address, sub.recipient);
    else if (inDir) startLock(amount, address);
    else startBurn(amount, address);
  };
  return (
    <>
      {needsConsent ? (
        <label class="check">
          <input type="checkbox" checked={consent} data-autofocus="" onChange={(e) => setConsent(e.currentTarget.checked)} />{" "}
          <span>
            {inDir
              ? "I checked the recipient: wtPOT minted to a wrong address cannot be recovered."
              : k.speed === "fast"
                ? "I understand Fast is trusted: the committee releases before Sepolia finality, and once sent, a burn cannot be cancelled."
                : "I understand the release is trusted: the committee releases after Sepolia finality, and once sent, a burn cannot be cancelled."}
          </span>
        </label>
      ) : null}
      <button
        class={`btn btn--primary btn--lg btn--block${sub && check.state === "checking" ? " is-loading" : ""}`}
        type="button"
        disabled={(needsConsent && !consent) || blocked}
        aria-busy={sub && check.state === "checking" ? "true" : undefined}
        data-autofocus={needsConsent ? undefined : ""}
        onClick={confirm}
      >
        {inDir ? `Lock ${value} tPOT on V3` : `Burn ${value} wtPOT on Sepolia`}
      </button>
      <p class="sheet-foot">
        {!inDir || k.auto
          ? sub
            ? `Your wallet asks once: ${sub.walletName}, for the lock. Nothing is sent until you confirm.`
            : "Your wallet asks once. Nothing is sent until you confirm."
          : sub
            ? // Two wallets: the Polkadot one signs the lock, the Ethereum one sends the mint.
              `${sub.walletName} asks for the lock on V3, then ${sub.ethWallet ?? "your Ethereum wallet"} for ${txs > 1 ? `${txs} transactions on Sepolia, each after the one before is mined` : "the mint on Sepolia"}. Nothing is sent until you confirm.`
            : txs > 1
              ? `Your wallet asks for the lock on V3, then for ${txs} transactions on Sepolia, each after the one before is mined. Nothing is sent until you confirm.`
              : "Your wallet asks twice: the lock on V3, then the mint on Sepolia. Nothing is sent until you confirm."}
      </p>
    </>
  );
}

function openReview(k: Facts, address: string, amount: string, net: NetState, sub: SubLock | null = null): void {
  // What Confirm sends, to its last decimal: the sends parse the field exactly, so no rounding here.
  const exact = parseAmount(amount);
  const v = exact === null ? fmt(k.value) : formatUnits(exact, DECIMALS);
  const inDir = k.dir === "in";
  // Auto-mint mints it: nothing to sign on Sepolia.
  const auto = inDir && k.auto;
  const behind = inDir && net.key === "relay" ? net.behind : 0;
  // Who sends the mint when it is the visitor's: a Polkadot wallet's lock is minted from the Ethereum wallet.
  const minter = sub ? (sub.ethWallet ?? "Your Ethereum wallet") : "Your wallet";
  const txs = behind ? sepoliaTxs(behind) : 1;
  if (sub && exact !== null) checkLock(sub.address, exact, sub.recipient);
  const sumRow = (label: string, c: ChainInfo) => (
    <div class="sum__row">
      <Mark id={c.markId} cls="mark--36" />
      <span class="sum__text">
        <span class="sum__label">{label}</span>
        <span class="sum__chain">{c.full}</span>
      </span>
      <span class="sum__amt">
        {v}
        <span class="unit">{c.token}</span>
      </span>
    </div>
  );
  const step = (n: number, title: string, meta: ComponentChildren, cost: ComponentChildren, cls = "") => (
    <li class={`rstep ${cls}`}>
      <span class="rstep__n mono">{n}</span>
      <span class="rstep__body">
        <span class="rstep__title">{title}</span>
        <span class="rstep__meta">{meta}</span>
        {cost ? <span class="rstep__cost">{cost}</span> : null}
      </span>
    </li>
  );
  const lockCost = sub ? (
    <LockStepCost />
  ) : (
    <>
      <Nb>≈ {LOCK_COST} tPOT</Nb> · <Nb>{LOCK_DEPOSIT} storage deposit + gas</Nb>
    </>
  );
  const steps = inDir ? (
    <>
      {step(1, "Lock on Portaldot V3", sub ? `${sub.walletName}, once` : "Your wallet, on V3", lockCost)}
      {auto
        ? step(2, "Mint on Sepolia", `Auto-mint, ${AUTO_TIME[0]} after your lock · nothing to sign`, null)
        : step(
            2,
            "Mint on Sepolia",
            behind
              ? `${minter}, on Sepolia, after V3 finality and the proof · it imports the ${behind === 1 ? "validator-set change" : `${behind} validator-set changes`} the light client lacks first${txs > 1 ? `, in ${txs} transactions` : ""}`
              : `${minter}, on Sepolia, after V3 finality and the proof`,
            <>
              <Nb>≈ {behind ? mintGas(behind) : MINT_GAS} M gas</Nb> <Nb>in Sepolia ETH</Nb>
            </>,
          )}
    </>
  ) : (
    <>
      {step(
        1,
        "Burn on Sepolia",
        "Your wallet, on Sepolia · no approval step",
        <>
          <Nb>≈ {BURN_GAS} k gas</Nb> <Nb>in Sepolia ETH</Nb>
        </>,
      )}
      {step(
        2,
        "Committee releases on V3",
        k.speed === "fast" ? (
          <>
            After 3 Sepolia confirmations, <Nb>≈ 84 s after your burn's block</Nb> · nothing to sign
          </>
        ) : (
          <>
            After Sepolia finality, <Nb>{TIME.std[0]} in all</Nb> · nothing to sign
          </>
        ),
        null,
        "is-trusted",
      )}
    </>
  );
  const trust = inDir ? (
    <div class="notice notice--verify">
      <Icon id="i-shield-check" />
      <div>
        <p class="notice__title">Checked on Sepolia</p>
        <p>
          2 of 2 V3 validator signatures and a storage proof of your lock. Still trusted: the V3 validator set (2 keys, testnet), V3's sudo key and the
          light client's admin.
        </p>
      </div>
    </div>
  ) : (
    <div class="notice notice--trust">
      <Icon id="i-users" />
      <div>
        {k.speed === "fast" ? (
          <>
            <p class="notice__title">Trusted: 2-of-3 committee, before finality</p>
            <p>
              Fast releases after 3 Sepolia confirmations, before your burn is final. A reorg deeper than 3 blocks could undo the burn after V3 has released,
              breaking the 1:1 backing: that is why Fast is capped at 1 tPOT. Nothing on V3 checks your burn. On the testnet one operator holds all three keys.
            </p>
          </>
        ) : (
          <>
            <p class="notice__title">Trusted: 2-of-3 committee</p>
            <p>Two of three members release it after Sepolia finality; nothing on V3 checks your burn. On the testnet one operator holds all three keys.</p>
          </>
        )}
      </div>
    </div>
  );
  openSheet({
    title: "Review transfer",
    cls: "review",
    body: (
      <div class="review__body">
        <div class="sum">
          {sumRow("You send", k.from)}
          <span class="sum__arrow" aria-hidden="true">
            <Icon id="i-arrow-down" cls="i--16" />
          </span>
          {sumRow("You receive", k.to)}
        </div>
        <dl class="review__kv">
          {sub ? (
            <div class="kv">
              <dt class="kv__k">From</dt>
              <dd class="kv__v">
                {sub.name ? `${sub.name} · ` : ""}
                <span class="mono">{shortSs58(sub.address)}</span>
                <span class="kv__note kv__line">
                  {sub.walletName} · the vault records <span class="mono">{short(checksum(sub.h160))}</span>
                </span>
              </dd>
            </div>
          ) : null}
          <div class={`kv${sub ? " kv--full" : ""}`}>
            <dt class="kv__k">Recipient</dt>
            {sub ? (
              <dd class="kv__v kv__v--wrap">
                <span class="mono kv__full">{sub.shown}</span>
                <span class="kv__note kv__line">on Sepolia · {sub.from === "wallet" ? `your ${sub.ethWallet ?? "Ethereum wallet"}'s address` : "typed"}</span>
              </dd>
            ) : (
              <dd class="kv__v">
                <span class="mono">{short(address)}</span> <span class="kv__note">· you, on {k.to.short}</span>
              </dd>
            )}
          </div>
          {inDir ? null : (
            <div class="kv">
              <dt class="kv__k">Controlled by you</dt>
              <dd class="kv__v kv__v--ok">
                <Icon id="i-check" cls="i--14" />
                <span>Burn sender, no code</span>
              </dd>
            </div>
          )}
          {inDir ? null : (
            <div class="kv">
              <dt class="kv__k">Speed</dt>
              <dd class="kv__v">
                <Icon id={k.speed === "fast" ? "i-bolt" : "i-clock"} cls="i--14 kv__ic" />
                {SPEED_NAME[k.speed]} <span class="kv__note">· {k.speed === "fast" ? "after 3 confirmations" : "after Sepolia finality"} · set by the amount</span>
              </dd>
            </div>
          )}
          {sub ? (
            <div class="kv">
              <dt class="kv__k">Costs</dt>
              <dd class="kv__v">
                <LockCosts />
              </dd>
            </div>
          ) : null}
          <div class="kv">
            <dt class="kv__k">Time</dt>
            <dd class="kv__v">
              {k.time[0]} <span class="kv__note">· {k.time[1]}</span>
            </dd>
          </div>
          <div class="kv">
            <dt class="kv__k">Bridge fee</dt>
            <dd class="kv__v">
              None <span class="kv__note">· testnet</span>
            </dd>
          </div>
        </dl>
        {inDir ? null : trust}
        <div>
          <p class="eyebrow review__h">Steps</p>
          <ol class="rsteps">{steps}</ol>
          {!inDir && k.speed === "fast" ? (
            <p class="rnote">
              <Icon id="i-info" cls="i--14" />
              <span>
                Fast takes up to 1 tPOT per burn, and up to 1 tPOT in all across fast releases not yet final. If other fast burns are in flight, yours is released
                the standard way ({TIME.std[0]}).
              </span>
            </p>
          ) : null}
          {auto ? (
            <p class="rnote">
              <Icon id="i-info" cls="i--14" />
              <span>
                If auto-mint has not minted it within 5 minutes of your lock, this page offers you the mint: any Ethereum wallet with Sepolia ETH can send it.
                Auto-mint takes locks of {tpot(AUTO_MINT.min, 3)} tPOT or more.
              </span>
            </p>
          ) : inDir && sub && !k.below ? (
            <p class="rnote">
              <Icon id="i-info" cls="i--14" />
              <span>
                Auto-mint does not see locks from Polkadot wallets yet, so you send the mint on Sepolia from {sub.ethWallet ?? "your Ethereum wallet"}: about {MINT_GAS} M
                gas in Sepolia ETH. It pays the recipient above.
              </span>
            </p>
          ) : inDir ? (
            <p class="rnote">
              <Icon id="i-info" cls="i--14" />
              <span>
                Below auto-mint's {tpot(AUTO_MINT.min, 3)} tPOT minimum: you mint it on Sepolia, about {MINT_GAS} M gas in Sepolia ETH.
              </span>
            </p>
          ) : null}
        </div>
        {sub ? <LockProblem /> : null}
        {inDir ? trust : null}
      </div>
    ),
    foot: <ReviewFoot k={k} value={v} amount={amount} address={address} txs={txs} sub={sub} />,
  });
}

// ---------------------------------------------------------------------------------------------
// The card

/** The strip under the card: what each way trusts, and its recorded numbers; the way in's time is auto-mint's when it mints the card's lock (`auto`). */
function ProofStrip({ dir, auto }: { dir: Dir; auto: boolean }) {
  const back = dir === "back";
  return (
    <aside class="proof" aria-labelledby="proof-title" data-dir={dir}>
      <div class="proof__head">
        <h2 class="proof__title" id="proof-title">
          What each way trusts
        </h2>
        <span class="badge badge--sm proof__rec">Recorded Oct 20 · Oct 24</span>
      </div>
      <div class="lanes">
        <div class="lanes__node">
          <Mark id="m-pdot" cls="mark--36" />
          <span class="lanes__chain">Portaldot V3</span>
          <span class="lanes__net">testnet</span>
          <span class="lanes__short" aria-hidden="true">
            V3
          </span>
        </div>
        <div class="lanes__mid">
          <div class="lane lane--in">
            <p class="lane__label">
              <Icon id="i-shield-check" cls="i--14" />
              <span>
                <strong>Verified</strong> · light client<span class="lane__more"> checks the mint</span>
              </span>
            </p>
            <span class="lane__line" aria-hidden="true" />
          </div>
          <div class="lane lane--back">
            <span class="lane__line" aria-hidden="true" />
            <p class="lane__label">
              <Icon id="i-users" cls="i--14" />
              <span>
                <strong>Trusted</strong> · 2-of-3 committee<span class="lane__more"> releases · fast ≈ 84 s</span>
              </span>
            </p>
          </div>
        </div>
        <div class="lanes__node">
          <Mark id="m-eth" cls="mark--36" />
          <span class="lanes__chain">Ethereum</span>
          <span class="lanes__net">Sepolia</span>
          <span class="lanes__short" aria-hidden="true">
            Sepolia
          </span>
        </div>
      </div>
      <ul class="facts">
        {back ? (
          <>
            <li class="fact">
              <a class="fact__link" href="#/receipt/burn-1">
                <span class="fact__num">
                  84<span class="unit">s</span>
                </span>
                <span class="fact__text">from the burn's block to the release, Fast · Oct 24 (108 s from sending)</span>
              </a>
            </li>
            <li class="fact">
              <a class="fact__link" href="#/receipt/burn-0">
                <span class="fact__num">
                  <span class="fact__approx">≈</span>20<span class="unit">min</span>
                </span>
                <span class="fact__text">from sending the burn to the release, Standard · Oct 20, released by hand before the watcher</span>
              </a>
            </li>
            <li class="fact">
              <a class="fact__link" href="#/network">
                <span class="fact__num">
                  <span class="fact__approx">≤</span>1<span class="unit">tPOT</span>
                </span>
                <span class="fact__text">per Fast burn, and in all before finality; larger burns go Standard</span>
              </a>
            </li>
          </>
        ) : (
          <>
            {auto ? (
              <li class="fact">
                <span class="fact__num">
                  <span class="fact__approx">≈</span>2½<span class="unit">min</span>
                </span>
                <span class="fact__text">lock to mint, sent by auto-mint · measured Oct 27</span>
              </li>
            ) : (
              <li class="fact">
                <span class="fact__num">
                  48<span class="unit">s</span>
                </span>
                <span class="fact__text">lock to mint, the mint sent by its locker · measured Oct 20</span>
              </li>
            )}
            <li class="fact">
              <a class="fact__link" href="#/lab">
                <span class="fact__num">
                  6<span class="fact__of"> of </span>6
                </span>
                <span class="fact__text">attacks reverted on chain: 5 tampered mints and a replay</span>
              </a>
            </li>
            <li class="fact">
              <a class="fact__link" href="#/network">
                <span class="fact__num">
                  10<span class="unit">min</span>
                </span>
                <span class="fact__text">between relayer runs; each client ≤ 70 min behind</span>
              </a>
            </li>
          </>
        )}
      </ul>
      <a class="proof__link" href={back ? "#/tx/replay-back?speed=fast" : "#/tx/replay-in"}>
        <Icon id="i-play" cls="i--14" />
        <span>{back ? "Watch the 84 s fast release" : "Watch the recorded run"}</span>
        <Icon id="i-arrow-right" cls="i--16" />
      </a>
    </aside>
  );
}

/** `who`: the Polkadot account the lock is sent from, under the chain's name. */
function ChainButton({ side, c, dir, who = null }: { side: "from" | "to"; c: ChainInfo; dir: Dir; who?: { line: string; title: string } | null }) {
  const name = side === "from" ? "From" : "To";
  return (
    <button
      class="chain-btn"
      type="button"
      aria-haspopup="dialog"
      aria-label={`${name}: ${c.full}, ${c.token}${who ? `, ${who.title}` : ""}. Change network`}
      title={who?.title}
      onClick={() => openPicker(side, dir)}
    >
      <Mark id={c.markId} />
      <span class="chain-btn__text">
        <span class="chain-btn__label">{name}</span>
        <span class="chain-btn__name">{c.name}</span>
        <span class={`chain-btn__sub${who ? " chain-btn__sub--who" : ""}`}>{who ? who.line : c.sub}</span>
      </span>
      <Icon id="i-chevron-down" cls="i--16 chain-btn__chev" />
    </button>
  );
}

interface Action {
  label: ComponentChildren;
  hint: string;
  warn?: boolean;
  disabled?: boolean;
  busy?: boolean;
  run?: () => void;
}

/** The lock from a Polkadot wallet's account: its gates, then the review. */
function subAction(k: Facts, f: Form, w: WalletState, p: PolkaState, net: NetState): Action {
  if (k.loading) return { label: <span>Reading balances</span>, hint: `Reading your tPOT on ${k.from.short}…`, busy: true, disabled: true };
  if (net.key === "paused") return { label: <span>Mints are paused</span>, hint: "Watch Network for the light client to resume.", disabled: true };
  if (net.key === "rpc" && net.down === "v3") return { label: <span>Can't reach Portaldot V3</span>, hint: "Retrying every 30 s.", disabled: true };
  if (!k.value) return { label: <span>Enter an amount</span>, hint: "", disabled: true };
  // Auto-mint does not mint this lock (handoff.ts: a Polkadot wallet's, or below its minimum): its
  // mint is the visitor's, sent from an Ethereum wallet with Sepolia ETH, so that comes first.
  if (!k.auto && k.noEth) {
    const why = k.below
      ? `Below ${tpot(AUTO_MINT.min, 3)} tPOT auto-mint skips the lock, so you send its mint on Sepolia: about ${MINT_GAS} M gas in Sepolia ETH, from an Ethereum wallet.`
      : `Auto-mint does not see locks from Polkadot wallets yet, so you send the mint on Sepolia: about ${MINT_GAS} M gas in Sepolia ETH, from an Ethereum wallet such as MetaMask.`;
    if (w.status === "on" && w.address) return { label: <span>Get Sepolia ETH first</span>, hint: why, warn: true, disabled: true };
    return {
      label: (
        <>
          <Icon id="i-wallet" />
          <span>Connect an Ethereum wallet</span>
        </>
      ),
      hint: why,
      run: () => openWalletPicker(undefined, "evm", "mint"),
    };
  }
  if (k.short) return { label: <span>Not enough tPOT</span>, hint: `A lock uses about ${LOCK_COST} tPOT besides the amount: V3's storage deposit for its record, and the fee.`, disabled: true };
  const rc = k.rc;
  if (!rc || !rc.ok) {
    return { label: <span>{rc?.kind === "empty" ? "Enter a Sepolia address" : "Check the Sepolia address"}</span>, hint: rc?.kind === "empty" ? "The address that receives the wtPOT on Sepolia." : "", disabled: true };
  }
  const a = p.account;
  return {
    label: <span>Review transfer</span>,
    hint: "",
    run: () => {
      if (!a || !p.wallet) return;
      const sub: SubLock = {
        address: a.address,
        name: a.name,
        h160: a.h160,
        walletName: p.wallet.name,
        recipient: rc.address,
        shown: rc.shown,
        from: f.toFrom === "wallet" && w.address?.toLowerCase() === rc.address ? "wallet" : "typed",
        ethWallet: w.name,
      };
      openReview(k, a.address, f.amount, net, sub);
    },
  };
}

function action(
  k: Facts,
  f: Form,
  w: WalletState,
  p: PolkaState,
  net: NetState,
  busy: string | null,
  run: (fn: () => Promise<void>, wait: string) => void,
  polkaWallets: boolean,
): Action {
  const { dir, from, to } = k;
  if (busy) return { label: <span>{busy}</span>, hint: "", busy: true, disabled: true };
  if (k.sub) return subAction(k, f, w, p, net);
  if (w.status === "none" && !polkaWallets) {
    return {
      label: (
        <>
          <Icon id="i-wallet" />
          <span>Get a wallet to bridge</span>
        </>
      ),
      hint: "No wallet in this browser. Everything else here works without one.",
      run: () => openWalletPicker(),
    };
  }
  if (w.status === "none" && dir === "back") {
    // A Polkadot wallet is here, and the burn is a Sepolia transaction.
    return {
      label: (
        <>
          <Icon id="i-wallet" />
          <span>Connect an Ethereum wallet to burn</span>
        </>
      ),
      hint: "The way back burns wtPOT on Sepolia from an Ethereum wallet such as MetaMask. Nothing is sent until you sign.",
      run: () => openWalletPicker(undefined, "evm", "burn"),
    };
  }
  if (w.status === "off" || w.status === "none") {
    return {
      label: (
        <>
          <Icon id="i-wallet" />
          <span>Connect wallet</span>
        </>
      ),
      hint: dir === "back" ? "The burn is sent from an Ethereum wallet. Nothing is sent until you sign." : "Connect to see your balances. Nothing is sent until you sign.",
      run: () => (dir === "back" ? openWalletPicker(undefined, "evm", "burn") : openWalletPicker()),
    };
  }
  if (k.loading) {
    const connecting = w.status === "connecting";
    return {
      label: <span>{connecting ? "Waiting for your wallet" : "Reading balances"}</span>,
      hint: connecting ? "Approve the connection in your wallet." : `Reading ${from.short} and ${to.short}…`,
      busy: true,
      disabled: true,
    };
  }
  if (k.wrong) {
    const on = w.chainId === to.chainId ? to.full : "another network";
    return {
      label: <span>Switch to {from.full}</span>,
      hint: `Your wallet is on ${on}. The ${dir === "in" ? "lock" : "burn"} is sent on ${from.short}.`,
      warn: true,
      run: () => run(() => switchTo(from.key), "Waiting for your wallet"),
    };
  }
  if (dir === "in" && net.key === "paused") return { label: <span>Mints are paused</span>, hint: "Watch Network for the light client to resume.", disabled: true };
  if (dir === "in" && net.key === "rpc" && net.down === "v3") return { label: <span>Can't reach Portaldot V3</span>, hint: "Retrying every 30 s.", disabled: true };
  if (!k.value) return { label: <span>Enter an amount</span>, hint: "", disabled: true };
  if (k.short) return { label: <span>Not enough {from.token}</span>, hint: "", disabled: true };
  if (k.noEth) {
    return {
      label: <span>Get Sepolia ETH first</span>,
      hint:
        dir === "in"
          ? `Below ${tpot(AUTO_MINT.min, 3)} tPOT you send the mint yourself: ≈ ${MINT_GAS} M gas in Sepolia ETH. Get some before you lock, or lock ${tpot(AUTO_MINT.min, 3)} tPOT or more and auto-mint mints it for you.`
          : `The burn needs ≈ ${BURN_GAS} k gas in Sepolia ETH.`,
      warn: true,
      disabled: true,
    };
  }
  return {
    label: (
      <span>
        Review transfer
        {dir === "back" ? <span class="cta__speed"> · {SPEED_NAME[k.speed]}</span> : null}
      </span>
    ),
    hint: "",
    run: () => {
      if (w.address) openReview(k, w.address, f.amount, net);
    },
  };
}

function Notice({ k, f, net }: { k: Facts; f: Form; net: NetState }) {
  let n: [string, string, string, ComponentChildren] | null = null;
  if (f.addHelp && k.dir === "in") {
    n = [
      "notice--add",
      "i-plus",
      "Add Portaldot V3 testnet to your wallet",
      <>
        <dl class="netparams">
          <div>
            <dt>Chain id</dt>
            <dd>
              <CopyChip value="420420777" label="chain id" />
            </dd>
          </div>
          <div>
            <dt>RPC</dt>
            <dd>
              <CopyChip value={V3_RPC} label="RPC URL" shown="test-evm-rpc-v3.portaldot.dev" />
            </dd>
          </div>
        </dl>
        Your wallet may call it unrecognised; that is expected.
      </>,
    ];
  } else if (k.dir === "in" && net.key === "relay") {
    const one = net.behind === 1;
    // The mint imports what the relayer has not (sends.ts): six calls fit one transaction, so past
    // five changes it takes more than one.
    const txs = sepoliaTxs(net.behind);
    n = [
      "notice--trust",
      "i-refresh",
      `The light client is ${net.behind} validator-set change${one ? "" : "s"} behind V3`,
      k.auto
        ? // Auto-mint imports no change itself: a lock after the client's latest header waits for the relayer's import (relayer/src/automint.ts).
          `Auto-mint mints your lock once the relayer has imported ${one ? "it" : "them"}, usually within minutes, so it can take longer than ${AUTO_TIME[0]}. If it has not minted it within 5 minutes of your lock, this page offers you the mint, which imports ${one ? "the change" : "the changes"} itself.`
        : `You can lock and mint now: your mint imports ${one ? "the change" : `the ${net.behind} changes`} first, through Multicall3${txs > 1 ? `, in ${txs} transactions` : ""}, for about ${fmt(IMPORT_GAS * net.behind, 1)} M gas more (≈ ${mintGas(net.behind)} M in all, in Sepolia ETH). Nothing waits for the relayer.`,
    ];
  } else if (k.dir === "in" && net.key === "paused") {
    n = ["notice--revert", "i-alert", "The light client is paused by its admin", "Mints are refused until it resumes. Nothing you hold is affected. Burns still work."];
  } else if (net.key === "rpc") {
    const name = net.down === "v3" ? "Portaldot V3" : "Sepolia";
    n = ["notice--muted", "i-server", `Can't reach ${name}`, `Showing recorded values. ${k.dir === "in" && net.down === "v3" ? "Locks need V3, so the way in waits. " : ""}Your funds are not affected.`];
  }
  if (!n) return null;
  return (
    <div class={`notice ${n[0]}`}>
      <Icon id={n[1]} />
      <div>
        <p class="notice__title">{n[2]}</p>
        <p>{n[3]}</p>
      </div>
    </div>
  );
}

export function BridgeView({ route, net }: { route: Route; net: NetState }) {
  const dir: Dir = route.parts[1] === "back" ? "back" : "in";
  const f = useBox(form);
  const w = useBox(wallet);
  const p = useBox(polka);
  const polkaWallets = useBox(polkaList).length > 0;
  const [busy, setBusy] = useState<string | null>(null);

  // Deep links: #/bridge/back?amount=0.5&details=1 (and review=1 once connected).
  const query = route.q.toString();
  useEffect(() => {
    const q = new URLSearchParams(query);
    const patch: Partial<Form> = {};
    const a = q.get("amount");
    if (a) patch.amount = cleanAmount(a);
    if (q.get("details")) patch.details = true;
    if (Object.keys(patch).length) setForm(patch);
  }, [query]);

  const k = work(dir, f, w, p);
  const { from, to } = k;

  useEffect(() => {
    if (route.q.get("review") && k.ready && !k.sub && w.address && !k.wrong && k.value) openReview(k, w.address, f.amount, net);
    // Only when the page opens with ?review=1 and the wallet is read.
  }, [query, k.ready]);

  const run = (fn: () => Promise<void>, wait: string) => {
    setBusy(wait);
    fn().then(
      () => {
        setBusy(null);
        setForm({ addHelp: false });
      },
      (e) => {
        setBusy(null);
        if (walletCode(e) === 4001) return;
        if (from.key === "v3") setForm({ addHelp: true });
        toast("revert", "Your wallet did not switch", (e as Error).message || "Add the network by hand, with the values on the card.");
      },
    );
  };
  const a = action(k, f, w, p, net, busy, run, polkaWallets);

  const useMax = () => {
    setForm({ amount: k.max });
    document.getElementById("amt")?.focus();
  };
  const explainSpeed = () =>
    toast("info", "The amount sets the speed", "Up to 1 tPOT goes Fast, after 3 Sepolia confirmations. More goes Standard, after Sepolia finality.");

  // The line under the amount: only before an amount is in, to say what 1 token becomes.
  const subShown = !(k.ready && k.value > 0 && !k.short);
  const balText = !k.conn && !k.loading ? "—" : k.loading ? null : k.bal === null ? "—" : `${fmt(k.bal)} ${from.token}`;
  const needsShown = k.ready && (k.short || k.noEth || k.bal === 0);
  const tokOK = !k.short && (k.bal ?? 1) > 0;
  const T = k.time;

  return (
    <div class="stage" data-dir={dir}>
      <section class="intro" aria-labelledby="intro-title">
        <p class="intro__eyebrow">
          <span class="intro__dot" aria-hidden="true" />
          <span>
            {dir === "in" ? "Portaldot V3 testnet" : "Ethereum Sepolia"} <span aria-hidden="true">→</span>
            <span class="visually-hidden">to</span> {dir === "in" ? "Ethereum Sepolia" : "Portaldot V3 testnet"}
          </span>
        </p>
        <h1 class="intro__title" id="intro-title">
          {dir === "in" ? (
            <>
              Bridge tPOT to Sepolia, <span class="intro__grad">proven by a light client.</span>
            </>
          ) : (
            <>
              Bring wtPOT back to V3, <span class="intro__grad">released by a committee.</span>
            </>
          )}
        </h1>
        <p class="intro__lead">
          {dir === "in"
            ? "Each mint on Sepolia checks Portaldot's own validator signatures and a storage proof of your lock. The way back is run by a committee, and the card says so."
            : "Burn wtPOT on Sepolia and a 2-of-3 committee releases your tPOT on V3. Nothing on V3 checks the burn: this way is trusted, and the card says so."}
        </p>
      </section>

      <div class="cardcol">
        <section class="card card--lit bridge" id="bridge" aria-labelledby="bridge-title">
          <div class="bridge__head">
            <h2 class="bridge__title" id="bridge-title">
              Bridge
            </h2>
            <p class="bridge__pair">
              <span>tPOT</span>
              <Icon id="i-swap-h" cls="i--12" />
              <span>wtPOT</span>
              <span class="bridge__sep" aria-hidden="true">
                ·
              </span>
              <span class="num">1:1</span>
            </p>
          </div>

          <div class="pair">
            <ChainButton
              side="from"
              c={from}
              dir={dir}
              who={
                k.sub && p.account
                  ? {
                      line: shortSs58(p.account.address),
                      title: `${p.account.name ? `${p.account.name}, ` : ""}${p.account.address}, in ${p.wallet?.name ?? "your Polkadot wallet"}`,
                    }
                  : null
              }
            />
            <button class="swap-btn" type="button" aria-label={`Swap direction: send from ${to.full} to ${from.full}`} onClick={() => swapDir(dir)}>
              <Icon id="i-swap-h" />
            </button>
            <ChainButton side="to" c={to} dir={dir} />
          </div>

          <div class={`panel amount${k.short ? " is-error" : ""}`}>
            <label class="amount__label" for="amt">
              You send
            </label>
            <span class="amount__bal">
              <span>
                <span class="bal-long">Balance</span>
                <span class="bal-short" aria-hidden="true">
                  Bal.
                </span>
              </span>
              {balText === null ? <span class="skel" /> : <span class="mono">{balText}</span>}
            </span>
            <input
              class="amount__input"
              id="amt"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              spellcheck={false}
              placeholder="0"
              aria-describedby="amt-sub amt-err"
              value={f.amount}
              onInput={(e) => {
                const el = e.currentTarget;
                const v = cleanAmount(el.value);
                if (el.value !== v) el.value = v;
                setForm({ amount: v });
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !a.disabled) a.run?.();
              }}
            />
            <button class="max-btn" type="button" aria-label="Use the maximum amount" disabled={!k.ready || k.bal === null} onClick={useMax}>
              Max
            </button>
            <span class="token">
              <span class="token__mark">
                <Mark id={from.markId} />
              </span>
              <span>{from.token}</span>
            </span>
            <p class="amount__sub" id="amt-sub" hidden={k.short || !subShown}>
              {subShown ? `1 ${from.token} ${dir === "in" ? "locked on V3 becomes" : "burned on Sepolia releases"} 1 ${to.token} on ${to.short}` : ""}
            </p>
            <p class="amount__err" id="amt-err" role="alert" hidden={!k.short}>
              {k.short ? (
                <>
                  <Icon id="i-alert" cls="i--14" />
                  <span>
                    {dir === "in"
                      ? k.sub
                        ? `You need ${fmt(Math.ceil((k.value + SUBSTRATE_ROOM - (k.bal ?? 0)) * 100) / 100, 2)} more tPOT. A lock uses ≈ ${LOCK_COST} tPOT besides the amount (mostly V3's storage deposit), and 0.1 tPOT stays in your account.`
                        : `You need ${fmt(Math.ceil((k.value + LOCK_CEILING - (k.bal ?? 0)) * 100) / 100, 2)} more tPOT. A lock uses ≈ ${LOCK_COST} tPOT (mostly V3's storage deposit), and your wallet checks ≈ ${LOCK_CEILING} tPOT up front for gas.`
                      : `You have ${fmt(k.bal ?? 0)} wtPOT on Sepolia.`}{" "}
                    {Number(k.max) > 0 ? (
                      <button type="button" class="text-link" onClick={useMax}>
                        Use max
                      </button>
                    ) : (
                      <a class="text-link" href={README} target="_blank" rel="noopener">
                        How to get tPOT
                      </a>
                    )}
                  </span>
                </>
              ) : null}
            </p>
            <dl class="amount__foot">
              <div class="amount__line">
                <dt>You receive</dt>
                <dd class="amount__receive">
                  <strong class="mono">{k.value ? fmt(k.value) : "0"}</strong> <span>{to.token}</span> <span class="amount__on">on {to.short}</span>
                </dd>
              </div>
              {k.sub ? (
                <RecipientField k={k} f={f} w={w} />
              ) : (
                <div class="amount__line">
                  <dt>To</dt>
                  <dd class="amount__to">
                    {w.address ? <span class="mono">{short(w.address)}</span> : null}
                    <span class="amount__you">{w.address ? `you, on ${to.short}` : `your address, on ${to.short}`}</span>
                    {dir === "back" && w.address ? (
                      <span class="tag tag--verify amount__ctrl">
                        <Icon id="i-check" cls="i--12" />
                        Controlled by you
                      </span>
                    ) : null}
                    <span class="tip tip--change">
                      <button class="text-link amount__change" type="button" aria-disabled="true" aria-describedby="tip-change">
                        Change
                      </button>
                      <span class="tip__bubble tip__bubble--end" role="tooltip" id="tip-change">
                        {dir === "in"
                          ? "From an Ethereum wallet the recipient is your own address. From a Polkadot wallet you give the Sepolia address."
                          : "The committee pays your own address on V3."}
                      </span>
                    </span>
                  </dd>
                </div>
              )}
            </dl>
          </div>

          <div class="route route--in">
            <span class="route__icon" aria-hidden="true">
              <Icon id="i-shield-check" />
            </span>
            <div class="route__titles">
              <p class="route__title">
                <span class="route__kind route__kind--verify">Verified</span> by the light client{" "}
                {net.key === "ready" || net.key === "relay" ? (
                  <span class="livechip" title="Read live: the light client on Sepolia and V3's validator set. When the client is behind, your mint imports V3's changes itself.">
                    Live
                  </span>
                ) : null}
              </p>
              <p class="route__sub">2 of 2 validator signatures · storage proof · nonce</p>
              <p class="route__sub route__sub--auto">
                {k.auto ? (
                  <>
                    <Nb>Auto-mint mints it for you {AUTO_TIME[0]} after your lock</Nb> · <Nb>nothing to sign on Sepolia</Nb> ·{" "}
                    <Nb>for locks of {tpot(AUTO_MINT.min, 3)} tPOT or more</Nb>
                  </>
                ) : k.below ? (
                  <>
                    Below {tpot(AUTO_MINT.min, 3)} tPOT you mint it on Sepolia · ≈ {MINT_GAS} M gas
                  </>
                ) : (
                  <>
                    <Nb>From a Polkadot wallet you mint it on Sepolia</Nb> · <Nb>≈ {MINT_GAS} M gas</Nb> · <Nb>auto-mint does not see these locks yet</Nb>
                  </>
                )}
              </p>
            </div>
            <Tip id="tip-in" label="What the way in checks and trusts, and auto-mint">
              Sepolia checks 2 of 2 V3 validator signatures, a storage proof of your lock and its nonce. It still trusts V3's validator set (2 keys on the testnet),
              V3's sudo key and the light client's admin. Auto-mint is the operator's process: about 2½ minutes after your lock it sends the mint from its own key and
              pays the gas, at most {AUTO_MINT.dailyEth} ETH a day, on one machine. It can only mint what your lock commits to. Anyone can still send the mint: if
              auto-mint has not minted it within 5 minutes, this page offers it to you. It does not see locks signed with a Polkadot wallet yet: you send their mint.
            </Tip>
          </div>

          <div class="route route--back">
            <span class="route__icon" aria-hidden="true">
              <Icon id="i-users" />
            </span>
            <div class="route__titles">
              <p class="route__title">
                <span class="route__kind route__kind--trust">Trusted:</span> 2-of-3 committee{" "}
                {/* This page cannot see whether the watcher runs: a neutral label, not a live one. */}
                <span
                  class="badge badge--sm badge--muted"
                  title="The committee's release watcher sends both approvals. It runs on one machine: while that machine is off or asleep, burns wait until it is back."
                >
                  Watcher
                </span>
              </p>
              <p class="route__sub">
                {k.speed === "fast"
                  ? "Fast: released after 3 Sepolia confirmations, before finality. Nothing on V3 checks the burn."
                  : "Released on V3 after Sepolia finality. Nothing on V3 checks the burn."}
              </p>
            </div>
            <Tip id="tip-back" label="About the committee">
              Two of the three committee members must approve the release on V3. Both speeds are trusted. The amount sets the speed: Fast releases after 3
              Sepolia confirmations, before finality, up to 1 tPOT per burn and up to 1 tPOT in all across fast releases whose burn is not final yet; a larger burn
              goes Standard, after finality. A reorg deeper than 3 blocks could undo a burn on Sepolia after V3 has released, which would break the 1:1 backing.
              On the testnet one operator holds all three keys, and the watcher that sends their approvals runs on one machine: while it is off, burns wait. Once
              sent, a burn cannot be cancelled.
            </Tip>
            <div class="speed" role="radiogroup" aria-readonly="true" aria-label="Release speed, set by the amount">
              <button class="opt opt--row" type="button" role="radio" id="opt-std" aria-checked={k.speed === "std"} tabIndex={k.speed === "std" ? 0 : -1} onClick={explainSpeed}>
                <span class="opt__head">
                  <span class="opt__icon" aria-hidden="true">
                    <Icon id="i-clock" />
                  </span>
                  <span class="opt__title">Standard</span>
                  <span class="opt__time">
                    ≈ 17<span class="unit">min</span>
                  </span>
                </span>
                <span class="opt__meta">
                  <span>Any amount</span>
                </span>
                <span class="opt__src">{TIME.std[1]}</span>
              </button>
              <button
                class="opt opt--row"
                type="button"
                role="radio"
                id="opt-fast"
                aria-checked={k.speed === "fast"}
                aria-disabled={!k.fastOK}
                tabIndex={k.speed === "fast" ? 0 : -1}
                onClick={explainSpeed}
              >
                <span class="opt__head">
                  <span class="opt__icon" aria-hidden="true">
                    <Icon id="i-bolt" />
                  </span>
                  <span class="opt__title">Fast</span>
                  <span class="opt__time">
                    ≈ 84<span class="unit">s</span>
                  </span>
                </span>
                <span class="opt__meta">
                  <span>{k.fastOK ? "≤ 1 tPOT" : "Over the 1 tPOT cap"}</span>
                </span>
                <span class="opt__src">measured Oct 24</span>
              </button>
            </div>
            <p class="speed__fix" hidden={k.fastOK || dir !== "back"}>
              <span>Fast takes up to 1 tPOT per burn.</span>{" "}
              <button
                class="text-link"
                type="button"
                onClick={() => {
                  const amount = String(Math.min(FAST_CAP, k.bal ?? FAST_CAP));
                  setForm({ amount });
                  document.getElementById("amt")?.focus();
                  announce(`Amount set to ${amount} wtPOT: it goes Fast.`);
                }}
              >
                Send 1 for Fast
              </button>
            </p>
          </div>

          <div class="quote">
            <button
              class="quote__sum"
              type="button"
              aria-expanded={f.details}
              aria-controls="quote-body"
              aria-label={`${f.details ? "Hide" : "Show"} details: ${dir === "back" ? `${SPEED_NAME[k.speed]}, ` : ""}${T[0]}, ${T[1]}, no bridge fee`}
              onClick={() => setForm({ details: !f.details })}
            >
              <span class="quote__text">
                {k.loading ? (
                  <span class="skel skel--line" />
                ) : (
                  <>
                    <Nb>
                      <Icon id={dir === "back" && k.speed === "fast" ? "i-bolt" : "i-clock"} cls="i--14" />
                      {dir === "back" ? <span class="quote__speed">{SPEED_NAME[k.speed]} </span> : null}
                      {T[0]}
                    </Nb>
                    <span class="quote__dot" aria-hidden="true">
                      ·
                    </span>
                    <Nb>No bridge fee</Nb>
                    <span class="quote__dot" aria-hidden="true">
                      ·
                    </span>
                    {dir === "in" ? (
                      !k.auto ? (
                        <span class="nowrap" title={`≈ ${LOCK_COST} tPOT on V3 for the lock, ≈ ${MINT_GAS} M gas on Sepolia for the mint`}>
                          ≈ <Mono>{LOCK_COST}</Mono> tPOT + <Mono>{MINT_GAS}</Mono> M gas
                        </span>
                      ) : (
                        <span class="nowrap" title={`≈ ${LOCK_COST} tPOT on V3 for the lock; auto-mint pays the mint's gas`}>
                          ≈ <Mono>{LOCK_COST}</Mono> tPOT
                        </span>
                      )
                    ) : (
                      <Nb>
                        Gas ≈ <Mono>{BURN_GAS}</Mono> k
                      </Nb>
                    )}
                  </>
                )}
              </span>
              <span class="quote__more">
                <Icon id="i-chevron-down" cls="i--16 quote__chev" />
              </span>
            </button>
            <div class="quote__body" id="quote-body" inert={!f.details}>
              <div class="quote__inner">
                <dl class="quote__list">
                  <div class="kv">
                    <dt class="kv__k">
                      <Icon id="i-clock" />
                      Time
                    </dt>
                    <dd class="kv__v">
                      {T[0]} <span class="kv__note">· {T[1]}</span>
                    </dd>
                  </div>
                  <div class="kv">
                    <dt class="kv__k">
                      <Icon id="i-gas" />
                      <span>{dir === "in" ? "Lock on V3" : "Burn on Sepolia"}</span>
                    </dt>
                    <dd class="kv__v">
                      {dir === "in" ? (
                        <>
                          ≈ <Mono>{LOCK_COST}</Mono> tPOT
                          <Tip id="tip-lock" label="About the lock cost">
                            A lock uses ≈ {LOCK_COST} tPOT: V3's storage deposit for your lock's record ({LOCK_DEPOSIT} tPOT), plus gas.{" "}
                            {k.sub
                              ? "From a Polkadot wallet the review shows V3's dry run of your lock: its deposit and its fee."
                              : `Your wallet also checks ≈ ${LOCK_CEILING} tPOT up front for gas before it sends.`}
                          </Tip>
                        </>
                      ) : (
                        <>
                          ≈ <Mono>{BURN_GAS}</Mono> k gas
                          <Tip id="tip-burn" label="About the burn gas">
                            Burn 1 used {BURN_GAS_FULL} gas, paid in Sepolia ETH. No approval step is needed.
                          </Tip>
                        </>
                      )}
                    </dd>
                  </div>
                  <div class="kv">
                    <dt class="kv__k">
                      <Icon id="i-gas" />
                      <span>{dir === "in" ? "Mint on Sepolia" : "Release on V3"}</span>
                    </dt>
                    <dd class="kv__v">
                      {dir === "in" ? (
                        !k.auto ? (
                          <>
                            ≈ <Mono>{MINT_GAS}</Mono> M gas
                            <Tip id="tip-mint" label="About the mint gas">
                              Lock 1's mint used {MINT_GAS_FULL} gas.{" "}
                              {k.below
                                ? `Below auto-mint's ${tpot(AUTO_MINT.min, 3)} tPOT minimum you send the mint, so you pay its gas in Sepolia ETH.`
                                : "Auto-mint does not see locks from Polkadot wallets yet: you send the mint from an Ethereum wallet, so you pay its gas in Sepolia ETH."}
                            </Tip>
                          </>
                        ) : (
                          <>
                            Nothing to pay <span class="kv__note">· auto-mint</span>
                          </>
                        )
                      ) : (
                        <>
                          Nothing to pay <span class="kv__note">· committee</span>
                        </>
                      )}
                    </dd>
                  </div>
                  <div class="kv">
                    <dt class="kv__k">
                      <Icon id="i-bridge" />
                      Bridge fee
                    </dt>
                    <dd class="kv__v">
                      None <span class="kv__note">· testnet</span>
                    </dd>
                  </div>
                </dl>
              </div>
            </div>
          </div>

          {needsShown ? (
            <div class="needs">
              <span class="needs__k">You have</span>
              <ul class="needs__list">
                <li class={`need ${tokOK ? "is-ok" : "is-miss"}`}>
                  <Icon id={tokOK ? "i-check" : "i-alert"} cls="i--14" />
                  <span class="need__label">
                    {from.token} on {from.short}
                  </span>
                  <span class="need__val mono">{k.bal === null ? "—" : fmt(k.bal, 2)}</span>
                  {!tokOK && dir === "in" ? (
                    <a class="text-link need__fix" href={README} target="_blank" rel="noopener">
                      Get tPOT
                    </a>
                  ) : null}
                </li>
                {k.ethNeeded ? (
                  <li class={`need ${k.noEth ? "is-miss" : "is-ok"}`}>
                    <Icon id={k.noEth ? "i-alert" : "i-check"} cls="i--14" />
                    <span class="need__label">ETH for the {dir === "in" ? "mint" : "burn"}</span>
                    <span class="need__val mono">{k.eth === null ? "—" : fmt(k.eth, 3)}</span>
                    {k.noEth && w.address ? (
                      <button class="text-link need__fix" type="button" onClick={() => openGetEth(dir, w.address ?? "")}>
                        Get Sepolia ETH
                      </button>
                    ) : null}
                  </li>
                ) : null}
              </ul>
            </div>
          ) : null}

          <Notice k={k} f={f} net={net} />

          <div class="actbar">
            <button
              class={`btn btn--primary btn--lg btn--block bridge__cta${a.busy ? " is-loading" : ""}`}
              type="button"
              disabled={a.disabled}
              aria-busy={a.busy ? "true" : undefined}
              onClick={() => a.run?.()}
            >
              {a.label}
            </button>
          </div>
          {a.hint ? (
            <p class={`bridge__hint${a.warn ? " bridge__hint--warn" : ""}`}>
              {a.warn ? <Icon id="i-alert" cls="i--14" /> : null}
              <span>{a.hint}</span>
            </p>
          ) : null}
        </section>
        <p class="later-note">
          <span class="badge badge--later badge--sm">Later</span>
          <span>
            <span class="later-note__name">LP fast-fill:</span> a liquidity provider pays you at once.
          </span>
        </p>
      </div>

      <ProofStrip dir={dir} auto={k.auto} />
    </div>
  );
}
