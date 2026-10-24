// The app's shell: the top bar (brand, navigation, the bridge's status and the wallet), the preview
// banner for visitors without a connected wallet, the routed view, the phone tab bar, and the
// overlays (the sheet, toasts, the announcer).

import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { CH, fromOf, type ChainInfo, type Dir } from "./facts.ts";
import { useRoute, type Route } from "./router.ts";
import { useBox } from "./store.ts";
import { connectWallet, openNoWallet } from "./connect.tsx";
import { useNet, type NetState } from "./net.ts";
import { Announcer, CopyButton, Icon, Mark, SheetHost, Toasts, closeSheet, fmt, short, toast } from "./ui.tsx";
import { ActivityView } from "./views/Activity.tsx";
import { BridgeView } from "./views/Bridge.tsx";
import { LabView } from "./views/Lab.tsx";
import { NetworkView } from "./views/Network.tsx";
import { ReceiptView } from "./views/Receipt.tsx";
import { TxView } from "./views/Tx.tsx";
import { addV3, addWtpot, disconnect, wallet, walletCode, type Balances } from "./wallet.ts";

// ---------------------------------------------------------------------------------------------
// The wallet button and its menu

let lastDir: Dir = "in";

function dirOf(route: Route): Dir {
  if (route.name === "bridge") lastDir = route.parts[1] === "back" ? "back" : "in";
  return lastDir;
}

const tokenNum = (v: bigint | null | undefined, decimals: number): number | null => (v == null ? null : Number(v) / 10 ** decimals);

function chainOf(id: bigint | null): ChainInfo | null {
  return id === CH.v3.chainId ? CH.v3 : id === CH.sepolia.chainId ? CH.sepolia : null;
}

function BalanceRow({ mark, token, where, value }: { mark: string; token: string; where: string; value: number | null | undefined }) {
  return (
    <div class="menu__bal">
      <Mark id={mark} cls="mark--20" />
      <dt>
        {token} <span>{where}</span>
      </dt>
      <dd class="mono">{value === undefined ? <span class="skel" /> : value === null ? "—" : fmt(value)}</dd>
    </div>
  );
}

function WalletMenu({ address, balances, onClose }: { address: string; balances: Balances | null; onClose: (focusButton: boolean) => void }) {
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
  return (
    <div class="menu" id="wallet-menu" role="menu" aria-labelledby="wallet" ref={ref} onKeyDown={onKeyDown}>
      <div class="menu__head">
        <span class="menu__addr mono">{short(address)}</span>
        <CopyButton value={address} label="your address" />
      </div>
      <dl class="menu__bals">
        <BalanceRow mark="m-pdot" token="tPOT" where="on V3" value={b ? tokenNum(b.tpot, 14) : undefined} />
        <BalanceRow mark="m-eth" token="wtPOT" where="on Sepolia" value={b ? tokenNum(b.wtpot, 14) : undefined} />
        <BalanceRow mark="m-eth" token="ETH" where="on Sepolia, for gas" value={b ? tokenNum(b.eth, 18) : undefined} />
      </dl>
      <div class="menu__sep" role="separator" />
      <button class="menu__item" role="menuitem" type="button" onClick={act(addV3, ["Portaldot V3 testnet added", "Chain 420420777, tPOT. Your wallet may call it an unrecognised network; that is expected."])}>
        <Icon id="i-plus" />
        Add Portaldot V3 to wallet
      </button>
      <button class="menu__item" role="menuitem" type="button" onClick={act(addWtpot, ["wtPOT added", "0x1fcB…Cb14 on Sepolia, 14 decimals."])}>
        <Icon id="i-plus" />
        Add wtPOT to wallet
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
        Disconnect
      </button>
    </div>
  );
}

function WalletButton({ dir, net }: { dir: Dir; net: NetState }) {
  const w = useBox(wallet);
  const [open, setOpen] = useState(false);
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
    if (w.status !== "on") setOpen(false);
  }, [w.status]);
  const close = (focusButton: boolean) => {
    setOpen(false);
    if (focusButton) btn.current?.focus();
  };

  const src = fromOf(dir);
  let cls = "wallet";
  let label: string;
  let inner;
  if (w.status === "none") {
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
  } else if (w.chainId !== null && w.chainId !== src.chainId) {
    const on = chainOf(w.chainId);
    cls += " wallet--wrong";
    label = `Wallet ${short(w.address)} is on ${on ? on.full : `chain ${w.chainId}`}, the wrong network. Open wallet menu`;
    inner = (
      <>
        <span class="wallet__net">{on ? <Mark id={on.markId} /> : null}</span>
        <span class="wallet__warn">
          <Icon id="i-alert" />
          <span class="wallet__text">Wrong network</span>
        </span>
        <Icon id="i-chevron-down" cls="wallet__chev" />
      </>
    );
  } else {
    cls += ` wallet--st-${net.cls}`;
    label = `Wallet ${short(w.address)} on ${src.full}. ${net.label}. Open wallet menu`;
    inner = (
      <>
        <span class="wallet__net">
          <Mark id={src.markId} />
        </span>
        <span class="wallet__addr">{short(w.address)}</span>
        <Icon id="i-chevron-down" cls="wallet__chev" />
      </>
    );
  }

  const onClick = (e: MouseEvent) => {
    e.stopPropagation();
    if (w.status === "none") return openNoWallet();
    if (w.status === "off") return void connectWallet();
    if (w.status === "connecting") return;
    setOpen((o) => !o);
  };

  const menu = w.status === "on" && w.address;
  return (
    <div class="wallet-wrap">
      <button
        class={cls}
        id="wallet"
        type="button"
        ref={btn}
        aria-label={label}
        aria-busy={w.status === "connecting" ? "true" : undefined}
        aria-haspopup={w.status === "none" ? "dialog" : menu ? "menu" : undefined}
        aria-expanded={menu ? open : undefined}
        onClick={onClick}
      >
        {inner}
      </button>
      {open && w.address ? <WalletMenu address={w.address} balances={w.balances} onClose={close} /> : null}
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
  const net = useNet();
  const dir = dirOf(route);
  const path = route.parts.join("/");

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
  const preview = w.status === "none" || w.status === "off";

  const view = {
    bridge: () => <BridgeView route={route} net={net} />,
    tx: () => <TxView route={route} net={net} />,
    receipt: () => <ReceiptView route={route} />,
    activity: () => <ActivityView route={route} />,
    network: () => <NetworkView net={net} />,
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
            <WalletButton dir={dir} net={net} />
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
