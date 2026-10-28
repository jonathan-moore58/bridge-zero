// The app's shell: the top bar (brand, navigation, the bridge's status and the wallet), the preview
// banner for visitors without a connected wallet, the routed view, the phone tab bar, and the
// overlays (the sheet, toasts, the announcer).

import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { destOf, refOf, type DestKey, type MarkKey } from "./dests.ts";
import { chainById, fromOf, type ChainInfo, type Dir } from "./facts.ts";
import { useRoute, type Route } from "./router.ts";
import { useBox } from "./store.ts";
import { addWtpotToWallet, openNoWallet, openWalletPicker } from "./connect.tsx";
import { ChainMark, walletMark } from "./marks.tsx";
import { useNet, type NetState } from "./net.ts";
import { disconnectPolka, polka, polkaList, type PolkaState } from "./polkadot.ts";
import { watchRollups } from "./rollups.ts";
import { shortSs58 } from "./substrate/account.ts";
import { chainReads, followerOf, transfers, type ChainRead, type LiveTransfer } from "./transfers.ts";
import { Announcer, CopyButton, Icon, Mark, SheetHost, Toasts, closeSheet, fmt, short, toast } from "./ui.tsx";
import { ActivityView } from "./views/Activity.tsx";
import { BridgeView, useCardDest } from "./views/Bridge.tsx";
import { LabView } from "./views/Lab.tsx";
import { NetworkView } from "./views/Network.tsx";
import { ReceiptView } from "./views/Receipt.tsx";
import { TxView } from "./views/Tx.tsx";
import { addV3, disconnect, wallet, walletCode, type Balances } from "./wallet.ts";

// ---------------------------------------------------------------------------------------------
// The wallet button and its menu

let lastDir: Dir = "in";

function dirOf(route: Route): Dir {
  if (route.name === "bridge") lastDir = route.parts[1] === "back" ? "back" : "in";
  return lastDir;
}

const tokenNum = (v: bigint | null | undefined, decimals: number): number | null => (v == null ? null : Number(v) / 10 ** decimals);

/** A chain the bridge sends on, V3 or a destination of ./dests.ts, by the chain id a wallet is on: the wallet button names it and shows its mark. */
const chainOf = (id: bigint | null): ChainInfo | null => chainById(id);

function BalanceRow({ mark, token, where, value }: { mark: MarkKey; token: string; where: string; value: number | null | undefined }) {
  return (
    <div class="menu__bal">
      <ChainMark mark={mark} cls="mark--20" />
      <dt>
        {token} <span>{where}</span>
      </dt>
      <dd class="mono">{value === undefined ? <span class="skel" /> : value === null ? "—" : fmt(value)}</dd>
    </div>
  );
}

/** A Polkadot wallet's own mark in the menu's badge, as an Ethereum wallet's icon is shown there; else the sprite's wallet. */
function PolkaBadgeIcon({ walletKey }: { walletKey: string }) {
  const src = walletMark(walletKey);
  return src ? <img class="wallet-ico" src={src} alt="" /> : <Icon id="i-wallet" />;
}

/** The Polkadot account in the wallet menu: who (its address, its wallet in the badge, as the Ethereum part names its wallet, and its name under them) and its tPOT. */
function PolkaHead({ p }: { p: PolkaState }) {
  const a = p.account;
  if (!a) return null;
  return (
    <>
      <div class="menu__head">
        <span class="menu__who">
          <span class="menu__addr mono">{shortSs58(a.address)}</span>
          {p.wallet ? (
            <span class="badge badge--sm badge--muted menu__via">
              <PolkaBadgeIcon walletKey={p.wallet.key} />
              <span>{p.wallet.name}</span>
            </span>
          ) : null}
        </span>
        <CopyButton value={a.address} label="your Polkadot account" />
      </div>
      {a.name ? <p class="menu__acct">{a.name}</p> : null}
      <dl class="menu__bals">
        <BalanceRow mark="portaldot" token="tPOT" where="on V3" value={p.balance === null ? undefined : tokenNum(p.balance, 14)} />
      </dl>
    </>
  );
}

/** The Polkadot wallet's disconnect, in the wallet menu. */
function PolkaDisconnect({ p, onClose }: { p: PolkaState; onClose: (focusButton: boolean) => void }) {
  return (
    <button
      class="menu__item"
      role="menuitem"
      type="button"
      onClick={() => {
        onClose(false);
        disconnectPolka();
        toast("info", "Polkadot wallet disconnected", "Connect it again from the wallet button.");
      }}
    >
      <Icon id="i-logout" />
      Disconnect {p.wallet?.name ?? "Polkadot wallet"}
    </button>
  );
}

/** The Polkadot account in the wallet menu: who, its tPOT, and its disconnect. */
function PolkaPart({ p, onClose }: { p: PolkaState; onClose: (focusButton: boolean) => void }) {
  if (!p.account) return null;
  return (
    <>
      <PolkaHead p={p} />
      <PolkaDisconnect p={p} onClose={onClose} />
    </>
  );
}

interface MenuProps {
  address: string;
  /** The connected wallet's name and icon (a data:image/ URI, or null). */
  name: string | null;
  icon: string | null;
  balances: Balances | null;
  /** A Polkadot account connected too: its part of the menu. */
  p: PolkaState;
  /** The page's next transaction is the Polkadot account's (a lock on the way in): its part comes first. */
  polkaFirst: boolean;
  onClose: (focusButton: boolean) => void;
}

/** The menu of a Polkadot account alone, with no Ethereum wallet connected. */
function PolkaMenu({ p, onClose }: { p: PolkaState; onClose: (focusButton: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>(".menu__item")?.focus();
  }, []);
  return (
    <div
      class="menu"
      id="wallet-menu"
      role="menu"
      aria-labelledby="wallet"
      ref={ref}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose(true);
        if (e.key === "Tab") onClose(false);
      }}
    >
      <PolkaHead p={p} />
      <div class="menu__sep" role="separator" />
      <button
        class="menu__item"
        role="menuitem"
        type="button"
        onClick={() => {
          onClose(false);
          openWalletPicker(undefined, "evm", "send");
        }}
      >
        <Icon id="i-plus" />
        Connect an Ethereum wallet
      </button>
      <a class="menu__item" role="menuitem" href="#/activity" onClick={() => onClose(false)}>
        <Icon id="i-activity" />
        Your activity
      </a>
      <div class="menu__sep" role="separator" />
      <PolkaDisconnect p={p} onClose={onClose} />
    </div>
  );
}

function WalletMenu({ address, name, icon, balances, p, polkaFirst, onClose }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>(".menu__item")?.focus();
  }, []);
  const onKeyDown = (e: KeyboardEvent) => {
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>(".menu__item") ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    }
    if (e.key === "Escape") onClose(true);
    if (e.key === "Tab") onClose(false);
  };
  const act = (fn: () => Promise<void>, ok: [string, string]) => () => {
    onClose(false);
    fn().then(
      () => toast("verify", ok[0], ok[1]),
      (e) => {
        if (walletCode(e) !== 4001) toast("revert", "Your wallet refused", (e as Error).message ?? "");
      },
    );
  };
  const b = balances;
  // wtPOT and ETH as read on the bridge card's destination (wallet.ts, balancesOn).
  const on = destOf(b?.dest ?? "sepolia");
  const polkaTop = polkaFirst && p.status === "on" && p.account !== null;
  return (
    <div class="menu" id="wallet-menu" role="menu" aria-labelledby="wallet" ref={ref} onKeyDown={onKeyDown}>
      {polkaTop ? (
        <>
          <PolkaHead p={p} />
          <div class="menu__sep" role="separator" />
        </>
      ) : null}
      <div class="menu__head">
        <span class="menu__who">
          <span class="menu__addr mono">{short(address)}</span>
          {name ? (
            <span class="badge badge--sm badge--muted menu__via">
              {icon ? <img class="wallet-ico" src={icon} alt="" /> : <Icon id="i-wallet" />}
              <span>{name}</span>
            </span>
          ) : null}
        </span>
        <CopyButton value={address} label="your address" />
      </div>
      <dl class="menu__bals">
        <BalanceRow mark="portaldot" token="tPOT" where="on V3" value={b ? tokenNum(b.tpot, 14) : undefined} />
        <BalanceRow mark={on.mark} token="wtPOT" where={`on ${on.short}`} value={b ? tokenNum(b.wtpot, 14) : undefined} />
        <BalanceRow mark={on.mark} token="ETH" where={`on ${on.short}, for gas`} value={b ? tokenNum(b.eth, 18) : undefined} />
      </dl>
      <div class="menu__sep" role="separator" />
      <button class="menu__item" role="menuitem" type="button" onClick={act(addV3, ["Portaldot V3 testnet added", "Chain 420420777, tPOT. Your wallet may call it an unrecognised network; that is expected."])}>
        <Icon id="i-plus" />
        Add Portaldot V3 to wallet
      </button>
      <button
        class="menu__item"
        role="menuitem"
        type="button"
        onClick={() => {
          onClose(false);
          void addWtpotToWallet(on.key);
        }}
      >
        <Icon id="i-plus" />
        Add wtPOT on {on.short} to wallet
      </button>
      <a class="menu__item" role="menuitem" href="#/activity" onClick={() => onClose(false)}>
        <Icon id="i-activity" />
        Your activity
      </a>
      <div class="menu__sep" role="separator" />
      <button
        class="menu__item"
        role="menuitem"
        type="button"
        onClick={() => {
          onClose(false);
          void disconnect().then(() => toast("info", "Disconnected", "Connect again to see your balances."));
        }}
      >
        <Icon id="i-logout" />
        {polkaTop ? `Disconnect ${name ?? "Ethereum wallet"}` : "Disconnect"}
      </button>
      {polkaTop ? (
        <PolkaDisconnect p={p} onClose={onClose} />
      ) : p.status === "on" ? (
        <>
          <div class="menu__sep" role="separator" />
          <PolkaPart p={p} onClose={onClose} />
        </>
      ) : null}
    </div>
  );
}

/**
 * `needs`: the chain the page's next transaction is sent on (the bridge card's source chain), or
 * null on pages that send nothing, where either bridge chain is fine. `polkaFirst`: that
 * transaction is the Polkadot account's (a lock on the way in), so the button shows the account.
 */
function WalletButton({ needs, polkaFirst, net }: { needs: ChainInfo | null; polkaFirst: boolean; net: NetState }) {
  const w = useBox(wallet);
  const p = useBox(polka);
  const polkaWallets = useBox(polkaList);
  const [open, setOpen] = useState(false);
  /** A Polkadot account and no Ethereum wallet: the button is the account's. */
  const polkaOnly = (w.status === "none" || w.status === "off") && p.status === "on" && p.account !== null;
  /** Both, where the account sends: the button is the account's too, and the menu holds both. */
  const polkaShown = polkaOnly || (polkaFirst && p.status === "on" && p.account !== null && w.status === "on" && !!w.address);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!(e.target as Element | null)?.closest?.(".wallet-wrap")) setOpen(false);
    };
    document.addEventListener("click", away);
    return () => document.removeEventListener("click", away);
  }, [open]);
  useEffect(() => {
    if (w.status !== "on" && !polkaOnly) setOpen(false);
  }, [w.status, polkaOnly]);
  const close = (focusButton: boolean) => {
    setOpen(false);
    if (focusButton) btn.current?.focus();
  };

  const on = chainOf(w.chainId);
  /** The chain the wallet is on, by name, the rollups included: the wrong-network button names it. */
  const onNamed = on;
  // A wallet whose chain is not known yet is shown on the chain the page needs.
  const shown = w.chainId === null ? needs : on;
  const wrong = w.chainId !== null && (needs ? w.chainId !== needs.chainId : on === null);
  let cls = "wallet";
  let label: string;
  let inner;
  if (polkaShown && p.account) {
    cls += ` wallet--st-${net.cls}`;
    const evm = !polkaOnly && w.address ? `, and ${w.name ?? "your Ethereum wallet"} ${short(w.address)}` : "";
    label = `${p.wallet?.name ?? "Polkadot wallet"} ${shortSs58(p.account.address)} on Portaldot V3 testnet${evm}. ${net.label}. Open wallet menu`;
    inner = (
      <>
        <span class="wallet__net">
          <ChainMark mark="portaldot" />
        </span>
        <span class="wallet__addr">{shortSs58(p.account.address)}</span>
        <Icon id="i-chevron-down" cls="wallet__chev" />
      </>
    );
  } else if (w.status === "none") {
    label = "No wallet found. Get a wallet";
    inner = (
      <>
        <span class="wallet__icon">
          <Icon id="i-wallet" />
        </span>
        <span class="wallet__text">Get a wallet</span>
      </>
    );
  } else if (w.status === "off") {
    label = "Connect wallet";
    inner = (
      <>
        <span class="wallet__icon">
          <Icon id="i-wallet" />
        </span>
        <span class="wallet__text">Connect</span>
      </>
    );
  } else if (w.status === "connecting" || !w.address) {
    cls += " is-connecting";
    label = "Connecting";
    inner = (
      <>
        <span class="wallet__icon" />
        <span class="wallet__text">Connecting</span>
      </>
    );
  } else if (wrong) {
    cls += " wallet--wrong";
    label = `${w.name ?? "Wallet"} ${short(w.address)} is on ${onNamed ? onNamed.full : `chain ${w.chainId}`}, the wrong network. Open wallet menu`;
    inner = (
      <>
        <span class="wallet__net">{onNamed ? <ChainMark mark={onNamed.mark} /> : null}</span>
        <span class="wallet__warn">
          <Icon id="i-alert" />
          <span class="wallet__text">Wrong network</span>
        </span>
        <Icon id="i-chevron-down" cls="wallet__chev" />
      </>
    );
  } else {
    cls += ` wallet--st-${net.cls}`;
    label = `${w.name ?? "Wallet"} ${short(w.address)}${shown ? ` on ${shown.full}` : ""}. ${net.label}. Open wallet menu`;
    inner = (
      <>
        <span class="wallet__net">{shown ? <ChainMark mark={shown.mark} /> : null}</span>
        <span class="wallet__addr">{short(w.address)}</span>
        <Icon id="i-chevron-down" cls="wallet__chev" />
      </>
    );
  }

  const onClick = (e: MouseEvent) => {
    e.stopPropagation();
    if (polkaOnly) return setOpen((o) => !o);
    if (w.status === "none") return polkaWallets.length ? openWalletPicker() : openNoWallet();
    if (w.status === "off") return openWalletPicker();
    if (w.status === "connecting") return;
    setOpen((o) => !o);
  };

  const menu = (w.status === "on" && w.address) || polkaOnly;
  return (
    <div class="wallet-wrap">
      <button
        class={cls}
        id="wallet"
        type="button"
        ref={btn}
        aria-label={label}
        aria-busy={w.status === "connecting" ? "true" : undefined}
        aria-haspopup={menu ? "menu" : w.status === "none" || w.status === "off" ? "dialog" : undefined}
        aria-expanded={menu ? open : undefined}
        onClick={onClick}
      >
        {inner}
      </button>
      {open && w.address ? <WalletMenu address={w.address} name={w.name} icon={w.icon} balances={w.balances} p={p} polkaFirst={polkaShown} onClose={close} /> : null}
      {open && !w.address && polkaOnly ? <PolkaMenu p={p} onClose={close} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The shell

const NAV = [
  ["bridge", "Bridge", "i-swap-h"],
  ["activity", "Activity", "i-activity"],
  ["network", "Network", "i-network"],
  ["lab", "Attack lab", "i-flask"],
] as const;

/**
 * The destination a page is about, whose light client the top bar's status and the wallet button's
 * dot show: the bridge card's; on a transfer's screen or its receipt, that transfer's (this
 * browser's, a burn's by its id, a lock's once its Locked log is read); else none, and the status
 * is Sepolia's, as on Activity and Network.
 */
function routeDest(route: Route, card: DestKey, live: ReadonlyMap<string, LiveTransfer>, reads: ReadonlyMap<string, ChainRead>): DestKey | null {
  if (route.name === "bridge") return card;
  if (route.name !== "tx" && route.name !== "receipt") return null;
  const id = route.parts[1] ?? "";
  const t = live.get(id) ?? followerOf(id);
  if (t) return t.dest;
  const k = refOf(id);
  if (k?.dir === "back") return k.dest;
  const r = reads.get(id);
  return r?.state === "live" ? r.value.dest : null;
}

/** The background's light follows the main card; pages without one get a quiet field. */
function placeBg(): void {
  const bg = document.getElementById("bz-bg");
  if (!bg) return;
  const card = document.querySelector("#view .stage .card");
  bg.classList.toggle("is-quiet", !card);
  if (!card) {
    bg.style.setProperty("--bz-bg-intensity", "0.35");
    bg.style.setProperty("--bz-bg-focus-x", "88%");
    bg.style.setProperty("--bz-bg-focus-y", "30%");
    return;
  }
  // #bz-bg is fixed, so the focus is in viewport coordinates: the middle of the card's visible part.
  const rc = card.getBoundingClientRect();
  const top = Math.max(rc.top, 0);
  const bottom = Math.min(rc.bottom, innerHeight);
  const fy = bottom > top ? (top + bottom) / 2 : rc.top + rc.height / 2;
  bg.style.setProperty("--bz-bg-intensity", innerWidth < 768 ? "0.4" : innerWidth < 961 ? "0.6" : "1");
  bg.style.setProperty("--bz-bg-focus-x", `${Math.round(rc.left + rc.width / 2)}px`);
  bg.style.setProperty("--bz-bg-focus-y", `${Math.round(fy)}px`);
}

export function App() {
  const route = useRoute();
  const w = useBox(wallet);
  // The bridge card's destination, or the transfer's on its screen and receipt: the status and the wallet button are its chain's.
  const dest = useCardDest();
  const shown = routeDest(route, dest, useBox(transfers), useBox(chainReads));
  const sepoliaNet = useNet();
  const net = useNet(shown ?? "sepolia");
  const dir = dirOf(route);
  const path = route.parts.join("/");

  // A rollup's light client is read while a page is about that rollup (the Network page reads both itself).
  useEffect(() => (shown && shown !== "sepolia" ? watchRollups() : undefined), [shown]);

  // A new page closes the sheet and starts at the top; flipping the bridge's direction keeps both.
  useEffect(() => {
    closeSheet(true);
  }, [path]);
  useEffect(() => {
    if (!route.q.get("keep")) window.scrollTo(0, 0);
  }, [route.name]);

  useLayoutEffect(placeBg);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const on = () => {
      clearTimeout(t);
      t = setTimeout(placeBg, 120);
    };
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);

  const current = (key: string) => route.name === key || (key === "bridge" && (route.name === "tx" || route.name === "receipt"));
  const p = useBox(polka);
  const preview = (w.status === "none" || w.status === "off") && p.status !== "on";
  const polkaIn = route.name === "bridge" && dir === "in" && p.status === "on" && p.account !== null;

  const view = {
    bridge: () => <BridgeView route={route} net={net} />,
    tx: () => <TxView route={route} net={net} />,
    receipt: () => <ReceiptView route={route} />,
    activity: () => <ActivityView route={route} />,
    network: () => <NetworkView net={sepoliaNet} />,
    lab: () => <LabView route={route} />,
  }[route.name]();

  return (
    <>
      <a
        class="skip-link"
        href="#view"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("view")?.focus();
        }}
      >
        Skip to content
      </a>

      <header class="topbar">
        <div class="topbar__in">
          <a class="brand" href="#/bridge" aria-label="Bridge Zero, testnet. Go to the bridge">
            <Mark id="m-zero" cls="brand__mark" />
            <span class="brand__name">Bridge Zero</span>
            <span class="badge badge--testnet brand__badge">Testnet</span>
          </a>

          <nav class="nav" aria-label="Main">
            {NAV.map(([key, label]) => (
              <a key={key} class="nav__link" href={`#/${key}`} aria-current={current(key) ? "page" : undefined}>
                {label}
              </a>
            ))}
          </nav>

          <div class="topbar__end">
            <a class={`status status--${net.cls}`} href="#/network" aria-label={`${net.label}. ${net.long} Open Network.`} title={net.long}>
              <span class="status__dot" aria-hidden="true" />
              <span class="status__label">{net.label}</span>
            </a>
            {/* On the way in from a Polkadot account the lock is that account's: the Ethereum wallet only fills the address and sends a mint, switched to the destination when it does, so no chain is wrong for it there. */}
            <WalletButton needs={route.name === "bridge" && !polkaIn ? fromOf(dir, dest) : null} polkaFirst={polkaIn} net={net} />
          </div>
        </div>
      </header>

      {preview ? (
        <div class="preview">
          <div class="preview__in">
            <span class="preview__icon" aria-hidden="true">
              <Icon id="i-eye" cls="i--16" />
            </span>
            <p class="preview__text">
              <strong>Preview</strong>
              <span class="preview__sep" aria-hidden="true">
                ·
              </span>
              {w.status === "none" ? "No wallet found in this browser. " : "No wallet connected. "}
              <span class="preview__more">Everything here is read from the chains or the recorded runs.</span>
            </p>
            <a class="preview__link" href="#/tx/replay-in">
              <Icon id="i-play" cls="i--14" />
              Watch the 48 s run
            </a>
          </div>
        </div>
      ) : null}

      <main class="view" id="view" tabIndex={-1}>
        {view}
      </main>

      <nav class="tabbar" aria-label="Main">
        {NAV.map(([key, label, icon]) => (
          <a key={key} class="tabbar__item" href={`#/${key}`} aria-current={current(key) ? "page" : undefined}>
            <Icon id={icon} cls="i--20" />
            <span>{label}</span>
          </a>
        ))}
      </nav>

      <SheetHost />
      <Toasts />
      <Announcer />
    </>
  );
}
