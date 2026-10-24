// The bridge: the card (direction, amount, what each way trusts, speed, cost, the action), the strip
// below it with each way's recorded numbers, and the card's sheets (pick a chain, review, get ETH).

import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { connectWallet, openNoWallet } from "../connect.tsx";
import {
  BURN_GAS,
  BURN_GAS_FULL,
  CH,
  FAST_CAP,
  LATER_CHAINS,
  LOCK_CEILING,
  LOCK_COST,
  LOCK_DEPOSIT,
  MINT_GAS,
  MINT_GAS_FULL,
  README,
  SPEED_NAME,
  TIME,
  V3_RPC,
  fromOf,
  toOf,
  type ChainInfo,
  type Dir,
  type Speed,
} from "../facts.ts";
import type { NetState } from "../net.ts";
import type { Route } from "../router.ts";
import { Box, useBox } from "../store.ts";
import { CopyChip, Icon, Mark, Mono, Nb, Tip, announce, closeSheet, fmt, openSheet, short, toast } from "../ui.tsx";
import { readBalances, switchTo, wallet, walletCode, type WalletState } from "../wallet.ts";

interface Form {
  amount: string;
  details: boolean;
  /** The wallet refused to add V3: show the network's parameters to add by hand. */
  addHelp: boolean;
}

/** Kept across pages, so the amount survives a visit to Activity. */
const form = new Box<Form>({ amount: "1", details: false, addHelp: false });

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
}

function work(dir: Dir, f: Form, w: WalletState): Facts {
  const from = fromOf(dir);
  const to = toOf(dir);
  const value = amountValue(f.amount);
  const conn = w.status === "on" && !!w.address;
  const loading = w.status === "connecting" || (conn && !w.balances);
  const ready = conn && !loading;
  const raw = dir === "in" ? w.balances?.tpot : w.balances?.wtpot;
  const bal = raw == null ? null : Number(raw) / 1e14;
  const eth = w.balances?.eth == null ? null : Number(w.balances.eth) / 1e18;
  const room = dir === "in" ? LOCK_CEILING : 0;
  // The burn carries no speed: the watcher releases a burn of up to 1 tPOT fast (while no other fast
  // release waits for finality), and a larger one after Sepolia's finality. So the card shows the
  // speed the amount gets; it offers no choice the watcher would not honour.
  const speed: Speed = value > FAST_CAP ? "std" : "fast";
  let max = "0";
  if (raw != null) max = dir === "back" ? units(raw, 14) : String(Math.max(0, Math.floor(((bal ?? 0) - room) * 100) / 100));
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
    noEth: ready && eth !== null && eth <= 0,
    wrong: ready && w.chainId !== null && w.chainId !== from.chainId,
    fastOK: value <= FAST_CAP,
    speed,
    time: TIME[dir === "in" ? "in" : speed],
    max,
  };
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

function ReviewFoot({ k, value }: { k: Facts; value: string }) {
  const inDir = k.dir === "in";
  const [consent, setConsent] = useState(false);
  const confirm = () => {
    closeSheet(true);
    toast("info", "Sending comes next", "This build stops at the review: the lock, the mint and the burn are wired in the next step.");
  };
  return (
    <>
      {inDir ? null : (
        <label class="check">
          <input type="checkbox" checked={consent} data-autofocus="" onChange={(e) => setConsent(e.currentTarget.checked)} />{" "}
          <span>
            {k.speed === "fast"
              ? "I understand Fast is trusted: the committee releases before Sepolia finality, and once sent, a burn cannot be cancelled."
              : "I understand the release is trusted: the committee releases after Sepolia finality, and once sent, a burn cannot be cancelled."}
          </span>
        </label>
      )}
      <button class="btn btn--primary btn--lg btn--block" type="button" disabled={!inDir && !consent} data-autofocus={inDir ? "" : undefined} onClick={confirm}>
        {inDir ? `Lock ${value} tPOT on V3` : `Burn ${value} wtPOT on Sepolia`}
      </button>
      <p class="sheet-foot">
        {inDir ? "Your wallet asks twice: the lock on V3, then the mint on Sepolia. Nothing is sent until you confirm." : "Your wallet asks once. Nothing is sent until you confirm."}
      </p>
    </>
  );
}

function openReview(k: Facts, address: string): void {
  const v = fmt(k.value);
  const inDir = k.dir === "in";
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
  const steps = inDir ? (
    <>
      {step(
        1,
        "Lock on Portaldot V3",
        "Your wallet, on V3",
        <>
          <Nb>≈ {LOCK_COST} tPOT</Nb> · <Nb>{LOCK_DEPOSIT} storage deposit + gas</Nb>
        </>,
      )}
      {step(
        2,
        "Mint on Sepolia",
        "Your wallet, on Sepolia, after V3 finality and the proof",
        <>
          <Nb>≈ {MINT_GAS} M gas</Nb> <Nb>in Sepolia ETH</Nb>
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
            After Sepolia finality, <Nb>≈ 20 min in all</Nb> · nothing to sign
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
          <div class="kv">
            <dt class="kv__k">Recipient</dt>
            <dd class="kv__v">
              <span class="mono">{short(address)}</span> <span class="kv__note">· you, on {k.to.short}</span>
            </dd>
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
                the standard way (≈ 20 min).
              </span>
            </p>
          ) : null}
        </div>
        {inDir ? trust : null}
      </div>
    ),
    foot: <ReviewFoot k={k} value={v} />,
  });
}

// ---------------------------------------------------------------------------------------------
// The card

/** The strip under the card: what each way trusts, and its recorded numbers. */
function ProofStrip({ dir }: { dir: Dir }) {
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
                <span class="fact__text">from sending the burn to the release, Standard · Oct 20</span>
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
            <li class="fact">
              <span class="fact__num">
                48<span class="unit">s</span>
              </span>
              <span class="fact__text">lock to mint, measured Oct 20</span>
            </li>
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

function ChainButton({ side, c, dir }: { side: "from" | "to"; c: ChainInfo; dir: Dir }) {
  const name = side === "from" ? "From" : "To";
  return (
    <button class="chain-btn" type="button" aria-haspopup="dialog" aria-label={`${name}: ${c.full}, ${c.token}. Change network`} onClick={() => openPicker(side, dir)}>
      <Mark id={c.markId} />
      <span class="chain-btn__text">
        <span class="chain-btn__label">{name}</span>
        <span class="chain-btn__name">{c.name}</span>
        <span class="chain-btn__sub">{c.sub}</span>
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

function action(k: Facts, w: WalletState, net: NetState, busy: string | null, run: (fn: () => Promise<void>, wait: string) => void): Action {
  const { dir, from, to } = k;
  if (busy) return { label: <span>{busy}</span>, hint: "", busy: true, disabled: true };
  if (w.status === "none") {
    return {
      label: (
        <>
          <Icon id="i-wallet" />
          <span>Get a wallet to bridge</span>
        </>
      ),
      hint: "No wallet in this browser. Everything else here works without one.",
      run: openNoWallet,
    };
  }
  if (w.status === "off") {
    return {
      label: (
        <>
          <Icon id="i-wallet" />
          <span>Connect wallet</span>
        </>
      ),
      hint: "Connect to see your balances. Nothing is sent until you sign.",
      run: () => void connectWallet(),
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
          ? `The mint needs ≈ ${MINT_GAS} M gas in Sepolia ETH. Get some before you lock, so the mint doesn't wait on you.`
          : `The burn needs ≈ ${BURN_GAS} k gas in Sepolia ETH.`,
      warn: true,
      disabled: true,
    };
  }
  return {
    label: (
      <span>
        {dir === "in" && net.key === "relay" ? "Review: lock now, mint after the relay" : "Review transfer"}
        {dir === "back" ? <span class="cta__speed"> · {SPEED_NAME[k.speed]}</span> : null}
      </span>
    ),
    hint: "",
    run: () => {
      if (w.address) openReview(k, w.address);
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
    const s = net.behind === 1 ? "" : "s";
    n = [
      "notice--trust",
      "i-refresh",
      `A relay is due: ${net.behind} validator-set change${s}`,
      "You can lock now. Your tPOT stays locked for you, and the mint waits for the relayer's next run, within about 10 min.",
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
  const [busy, setBusy] = useState<string | null>(null);

  // Deep links: #/bridge/back?amount=0.5&details=1 (and review=1 once connected).
  const query = route.q.toString();
  useEffect(() => {
    const q = new URLSearchParams(query);
    const p: Partial<Form> = {};
    const a = q.get("amount");
    if (a) p.amount = cleanAmount(a);
    if (q.get("details")) p.details = true;
    if (Object.keys(p).length) setForm(p);
  }, [query]);

  const k = work(dir, f, w);
  const { from, to } = k;

  useEffect(() => {
    if (route.q.get("review") && k.ready && w.address && !k.wrong && k.value) openReview(k, w.address);
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
  const a = action(k, w, net, busy, run);

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
            <ChainButton side="from" c={from} dir={dir} />
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
                      ? `You need ${fmt(Math.ceil((k.value + LOCK_CEILING - (k.bal ?? 0)) * 100) / 100, 2)} more tPOT. A lock uses ≈ ${LOCK_COST} tPOT (mostly V3's storage deposit), and your wallet checks ≈ ${LOCK_CEILING} tPOT up front for gas.`
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
                      Later: send to another address. Today the recipient is your own address.
                    </span>
                  </span>
                </dd>
              </div>
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
                  <span class="livechip" title="The light client on Sepolia follows V3: the relayer runs every 10 min">
                    Live
                  </span>
                ) : null}
              </p>
              <p class="route__sub">2 of 2 validator signatures · storage proof · nonce</p>
            </div>
            <Tip id="tip-in" label="What the way in checks and trusts">
              Sepolia checks 2 of 2 V3 validator signatures, a storage proof of your lock and its nonce. It still trusts V3's validator set (2 keys on the testnet),
              V3's sudo key and the light client's admin.
            </Tip>
          </div>

          <div class="route route--back">
            <span class="route__icon" aria-hidden="true">
              <Icon id="i-users" />
            </span>
            <div class="route__titles">
              <p class="route__title">
                <span class="route__kind route__kind--trust">Trusted:</span> 2-of-3 committee{" "}
                <span class="livechip livechip--trust" title="The release watcher runs a round every 15 s">
                  Watcher live
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
              On the testnet one operator holds all three keys. Once sent, a burn cannot be cancelled.
            </Tip>
            <div class="speed" role="radiogroup" aria-readonly="true" aria-label="Release speed, set by the amount">
              <button class="opt opt--row" type="button" role="radio" id="opt-std" aria-checked={k.speed === "std"} tabIndex={k.speed === "std" ? 0 : -1} onClick={explainSpeed}>
                <span class="opt__head">
                  <span class="opt__icon" aria-hidden="true">
                    <Icon id="i-clock" />
                  </span>
                  <span class="opt__title">Standard</span>
                  <span class="opt__time">
                    ≈ 20<span class="unit">min</span>
                  </span>
                </span>
                <span class="opt__meta">
                  <span>Any amount</span>
                </span>
                <span class="opt__src">measured Oct 20</span>
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
                      <span class="nowrap" title={`≈ ${LOCK_COST} tPOT on V3 for the lock, ≈ ${MINT_GAS} M gas on Sepolia for the mint`}>
                        ≈ <Mono>{LOCK_COST}</Mono> tPOT + <Mono>{MINT_GAS}</Mono> M gas
                      </span>
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
                            A lock uses ≈ {LOCK_COST} tPOT: V3's storage deposit for your lock's record ({LOCK_DEPOSIT} tPOT), plus gas. Your wallet also checks ≈{" "}
                            {LOCK_CEILING} tPOT up front for gas before it sends.
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
                        <>
                          ≈ <Mono>{MINT_GAS}</Mono> M gas
                          <Tip id="tip-mint" label="About the mint gas">
                            Lock 1's mint used {MINT_GAS_FULL} gas. You send the mint, so you pay its gas in Sepolia ETH.
                          </Tip>
                        </>
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

      <ProofStrip dir={dir} />
    </div>
  );
}
