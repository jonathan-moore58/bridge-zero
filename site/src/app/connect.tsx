// Connecting a wallet: the picker of the wallets this browser has, Ethereum wallets (EIP-6963) and
// Polkadot wallets (window.injectedWeb3) in two groups, the account picker of a Polkadot wallet, the
// sheet for a browser that has none, and adding wtPOT to the wallet.

import { useEffect, useState } from "preact/hooks";
import { V3_EVM } from "../lib/chains.ts";
import { checksum } from "../lib/display.ts";
import { request } from "../lib/rpc.ts";
import { deployed, destOf, type DestKey } from "./dests.ts";
import { ChainMark, walletMark } from "./marks.tsx";
import { connectPolka, normalize, pickAccount, polka, polkaList } from "./polkadot.ts";
import { useBox } from "./store.ts";
import { senderOf, shortSs58 } from "./substrate/account.ts";
import { faultOf, faultText, PORTALDOT_WALLET_URL, type AccountRow, type PolkaWallet } from "./substrate/inject.ts";
import { Chip, Icon, closeSheet, fmt, openSheet, short, toast } from "./ui.tsx";
import { addWtpot, connect, wallet, walletCode, wallets } from "./wallet.ts";

/** What an Ethereum wallet is wanted for, where only it can do it: the destination's address filled in, the mint, the burn, or any of these. */
export type EthUse = "fill" | "mint" | "burn" | "send";

/** A Polkadot wallet is in this browser, or connected. */
const polkaHere = (): boolean => polkaList.get().length > 0 || polka.get().status === "on";

/** No Ethereum wallet in this browser: the sheet that says so, for `use` on `dest`; with no Polkadot wallet either, the sheet for a browser with none. */
function noEthWallet(use: EthUse, dest: DestKey): void {
  if (polkaHere()) openNoEthWallet(use, dest);
  else openNoWallet();
}

/** Adds wtPOT on `dest` to the wallet, and says what the wallet answered. A wallet not connected yet is connected first. */
export async function addWtpotToWallet(dest: DestKey = "sepolia"): Promise<void> {
  const d = destOf(dest);
  const status = wallet.get().status;
  if (status === "none") return noEthWallet("send", dest);
  if (status === "off") return openWalletPicker(() => void addWtpotToWallet(dest), "evm", "send", dest);
  if (status === "connecting") return toast("info", "Check your wallet", "It already has a connection request open.");
  const token = `${short(checksum(deployed(d).token))} on ${d.short}, 14 decimals.`;
  try {
    if (await addWtpot(dest)) toast("verify", "wtPOT added to your wallet", token);
    else toast("info", "wtPOT not added", `Your wallet did not add it. The token is ${token}`);
  } catch (e) {
    if (walletCode(e) !== 4001) toast("revert", "Your wallet refused", (e as Error).message || `Switch it to ${d.short}, then add wtPOT.`);
  }
}

/** Connects the wallet picked in the picker, says how it went, then runs `after`. */
export async function connectWallet(walletId: string, after?: () => void): Promise<void> {
  try {
    await connect(walletId);
  } catch (e) {
    const code = walletCode(e);
    if (code === 4001) toast("info", "Not connected", "Your wallet declined the connection. Nothing was shared.");
    else if (code === -32002) toast("info", "Check your wallet", "It already has a connection request open.");
    else toast("revert", "Could not connect", (e as Error).message || "The wallet did not answer.");
    return;
  }
  const w = wallet.get();
  if (w.address) toast("verify", "Wallet connected", `${short(w.address)}.`);
  after?.();
}

/** A wallet's own icon: the data:image/ URI an Ethereum wallet announced (wallet.ts keeps no other), or the mark the page ships for a Polkadot wallet; else the sprite's wallet. */
export function WalletIcon({ icon }: { icon: string | null }) {
  return icon ? (
    <img class="wallet-ico" src={icon} alt="" />
  ) : (
    <span class="wallet-ico wallet-ico--none" aria-hidden="true">
      <Icon id="i-wallet" cls="i--20" />
    </span>
  );
}

/** A Polkadot wallet's own mark, by its key in window.injectedWeb3 (./marks.tsx: the Portaldot Wallet, polkadot{.js}, Talisman), else the sprite's wallet (SubWallet, whose mark is held back, and any other). */
export function PolkaIcon({ walletKey }: { walletKey: string }) {
  return <WalletIcon icon={walletMark(walletKey)} />;
}

function EvmList({ after }: { after: (() => void) | undefined }) {
  const list = useBox(wallets);
  const status = useBox(wallet).status;
  // Connected some other way while this is open (from the wallet itself, say): nothing left to pick.
  useEffect(() => {
    if (status === "on") closeSheet();
  }, [status]);
  if (!list.length) {
    return (
      <ul class="picker__list">
        <li>
          <a class="list-row" href="https://metamask.io/download/" target="_blank" rel="noopener">
            <WalletIcon icon={null} />
            <span class="list-row__text">
              <span class="list-row__title">MetaMask</span>
              <span class="list-row__meta">No Ethereum wallet in this browser</span>
            </span>
            <span class="list-row__end">
              <Chip kind="muted" cls="badge--sm">
                Get it
              </Chip>
              <Icon id="i-external" cls="i--14" />
            </span>
          </a>
        </li>
      </ul>
    );
  }
  return (
    <ul class="picker__list">
      {list.map((o, i) => (
        <li key={o.id}>
          <button
            class="list-row"
            type="button"
            data-autofocus={i === 0 ? "" : undefined}
            onClick={() => {
              closeSheet();
              void connectWallet(o.id, after);
            }}
          >
            <WalletIcon icon={o.icon} />
            <span class="list-row__text">
              <span class="list-row__title">{o.name}</span>
            </span>
            <span class="list-row__end">
              {o.last ? (
                <Chip kind="needs" cls="badge--sm">
                  Last used
                </Chip>
              ) : (
                <Chip kind="muted" cls="badge--sm">
                  Installed
                </Chip>
              )}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function PolkaList({ after }: { after: (() => void) | undefined }) {
  const list = useBox(polkaList);
  const p = useBox(polka);
  if (!list.length) {
    return (
      <ul class="picker__list">
        <li>
          <a class="list-row" href={PORTALDOT_WALLET_URL} target="_blank" rel="noopener">
            <PolkaIcon walletKey="portaldot extension" />
            <span class="list-row__text">
              <span class="list-row__title">Portaldot Wallet</span>
              <span class="list-row__meta">Portaldot's own wallet, for 5… accounts</span>
            </span>
            <span class="list-row__end">
              <Chip kind="muted" cls="badge--sm">
                Get it
              </Chip>
              <Icon id="i-external" cls="i--14" />
            </span>
          </a>
        </li>
      </ul>
    );
  }
  return (
    <ul class="picker__list">
      {list.map((o) => {
        const on = p.status === "on" && p.wallet?.key === o.key;
        return (
          <li key={o.key}>
            <button
              class="list-row"
              type="button"
              aria-current={on ? "true" : undefined}
              onClick={() => {
                closeSheet(true);
                void connectPolkaWallet(o, after);
              }}
            >
              <PolkaIcon walletKey={o.key} />
              <span class="list-row__text">
                <span class="list-row__title">{o.name}</span>
                {o.note ? <span class="list-row__meta">{o.note}</span> : null}
              </span>
              <span class="list-row__end">
                {on ? (
                  <Chip kind="verified" cls="badge--sm">
                    Connected
                  </Chip>
                ) : (
                  <Chip kind="muted" cls="badge--sm">
                    Installed
                  </Chip>
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** The picker's two groups: Ethereum wallets (0x addresses) and Polkadot wallets (5… addresses). `only`: Ethereum wallets alone, for what only they can send. */
function Picker({ after, only }: { after: (() => void) | undefined; only: "evm" | null }) {
  return (
    <div class="picker__groups">
      <section class="picker__group" aria-labelledby="pg-evm">
        <p class="eyebrow picker__group-h" id="pg-evm">
          Ethereum wallets · 0x addresses
        </p>
        <EvmList after={after} />
      </section>
      {only === "evm" ? null : (
        <section class="picker__group" aria-labelledby="pg-polka">
          <p class="eyebrow picker__group-h" id="pg-polka">
            Polkadot wallets · 5… addresses
          </p>
          <PolkaList after={after} />
        </section>
      )}
    </div>
  );
}

/**
 * Connects an Ethereum wallet first when none is, then runs `after`: what only an Ethereum wallet
 * sends (a burn, a mint, `use`) on the destination `dest`, so the picker shows those.
 */
export function connectThen(after: () => void, use: EthUse = "send", dest: DestKey = "sepolia"): void {
  const status = wallet.get().status;
  if (status === "on") return after();
  if (status === "none") return noEthWallet(use, dest);
  if (status === "connecting") return toast("info", "Check your wallet", "It already has a connection request open.");
  openWalletPicker(after, "evm", use, dest);
}

/** The wallets this browser has, to connect one; `after` runs once it is connected. `only` "evm": Ethereum wallets alone, wanted for `use` on `dest`. */
export function openWalletPicker(after?: () => void, only: "evm" | null = null, use: EthUse = "send", dest: DestKey = "sepolia"): void {
  const none = !wallets.get().length;
  if (none && only === "evm") return noEthWallet(use, dest);
  if (none && !polkaHere()) return openNoWallet();
  openSheet({ title: only === "evm" ? "Connect an Ethereum wallet" : "Connect a wallet", cls: "picker", body: <Picker after={after} only={only} /> });
}

// ---------------------------------------------------------------------------------------------
// A Polkadot wallet: its prompt, then the account

/** Enables the Polkadot wallet picked (its prompt asks to share accounts), then the account picker. */
export async function connectPolkaWallet(w: PolkaWallet, after?: () => void): Promise<void> {
  let rows: AccountRow[];
  try {
    rows = await connectPolka(w.key);
  } catch (e) {
    const fault = faultOf(e);
    if (fault === "rejected") toast("info", "Not connected", `${w.name} declined the connection. Nothing was shared.`);
    else toast("revert", "Could not connect", faultText(e) || `${w.name} did not answer.`);
    return;
  }
  openAccountPicker(w, rows, after);
}

function openAccountPicker(w: PolkaWallet, rows: AccountRow[], after?: () => void): void {
  openSheet({ title: "Choose an account", cls: "picker", body: <AccountList wallet={w} rows={rows} after={after} /> });
}

/** The account's tPOT on V3, read through its address on V3, which pallet-revive maps to it. */
async function tpotOf(address: string): Promise<bigint | null> {
  const h160 = senderOf(address);
  if (!h160) return null;
  try {
    return BigInt((await request<string>(V3_EVM, "eth_getBalance", [h160, "latest"])).result) / 10_000n;
  } catch {
    return null;
  }
}

function AccountList({ wallet: w, rows: first, after }: { wallet: PolkaWallet; rows: AccountRow[]; after: (() => void) | undefined }) {
  const p = useBox(polka);
  // The wallet's list as it changes while this is open (accounts.subscribe).
  const rows = p.wallet?.key === w.key && p.accounts.length ? p.accounts : first;
  const [bal, setBal] = useState<Record<string, bigint | null>>({});
  useEffect(() => {
    let live = true;
    for (const r of rows) {
      if (r.why || r.address in bal) continue;
      void tpotOf(r.address).then((v) => {
        if (live) setBal((b) => ({ ...b, [r.address]: v }));
      });
    }
    return () => {
      live = false;
    };
  }, [rows]);
  if (!rows.length) {
    return (
      <div class="sheet-stack">
        <p class="sheet-lead">{w.name} shares no account with this page. In it, add an account or allow one for this site, then connect again.</p>
        <button
          class="btn btn--primary btn--lg btn--block"
          type="button"
          data-autofocus
          onClick={() => {
            closeSheet(true);
            void connectPolkaWallet(w, after);
          }}
        >
          Connect again
        </button>
      </div>
    );
  }
  const usable = rows.filter((r) => !r.why);
  return (
    <>
      <ul class="picker__list">
        {rows.map((r) => {
          const h160 = r.why ? null : senderOf(r.address);
          const v = bal[r.address];
          const current = p.account?.address === normalize(r.address);
          return (
            <li key={r.address}>
              <button
                class="list-row"
                type="button"
                aria-disabled={r.why ? "true" : undefined}
                aria-current={current ? "true" : undefined}
                data-autofocus={!r.why && r === usable[0] ? "" : undefined}
                onClick={() => {
                  if (r.why) return;
                  pickAccount(r);
                  closeSheet();
                  toast("verify", "Polkadot account connected", `${r.name ? `${r.name} · ` : ""}${shortSs58(normalize(r.address) ?? r.address)}, in ${w.name}.`);
                  after?.();
                }}
              >
                <PolkaIcon walletKey={w.key} />
                <span class="list-row__text">
                  <span class="list-row__title">
                    {r.name ?? "Account"} <span class="mono list-row__addr">{shortSs58(normalize(r.address) ?? r.address)}</span>
                  </span>
                  <span class="list-row__meta">{r.why ?? (h160 ? <>on V3 as <span class="mono">{short(checksum(h160))}</span></> : null)}</span>
                </span>
                <span class="list-row__end">
                  {r.why ? null : v === undefined ? (
                    <span class="skel" />
                  ) : (
                    <span class="mono list-row__bal">{v === null ? "—" : `${fmt(Number(v) / 1e14)} tPOT`}</span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {w.note ? (
        <p class="sheet-foot">
          <Icon id="i-info" cls="i--14" /> {w.note}: Settings, Networks & Tokens, Manage networks, Add network, Polkadot, RPC wss://test-node-v3.portaldot.dev.
        </p>
      ) : null}
    </>
  );
}

/** What an Ethereum wallet does for a visitor with a Polkadot wallet, by `use`, on `dest` (Sepolia, or a rollup). */
function ethUse(use: EthUse, dest: DestKey): string {
  const d = destOf(dest);
  switch (use) {
    case "fill":
      return `Its mint is sent on ${d.short} from an Ethereum wallet such as MetaMask, with ${d.short} ETH for gas, and that wallet's address can fill in the recipient.`;
    case "mint":
      return `The mint is a ${d.short} transaction: you send it from an Ethereum wallet such as MetaMask, with ${d.short} ETH for its gas, about ${d.mintGas.gas} M gas.`;
    case "burn":
      return `The way back's burn is a ${d.short} transaction: you send it from an Ethereum wallet such as MetaMask, with ${d.short} ETH for its gas.`;
    case "send":
      return `The mint you send yourself and the way back's burn are ${d.short} transactions, sent from an Ethereum wallet such as MetaMask, with ${d.short} ETH for gas.`;
  }
}

/** A Polkadot wallet here and no Ethereum wallet: what an Ethereum wallet is wanted for (`use`, on `dest`), and where to get one. */
export function openNoEthWallet(use: EthUse = "send", dest: DestKey = "sepolia"): void {
  const name = polka.get().wallet?.name ?? polkaList.get()[0]?.name ?? "Your Polkadot wallet";
  openSheet({
    title: "No Ethereum wallet in this browser",
    body: (
      <div class="sheet-stack">
        <div class="empty-mark" aria-hidden="true">
          <ChainMark mark={destOf(dest).mark} cls="mark--28" />
        </div>
        <p class="sheet-lead">
          {name} signs {use === "fill" || use === "mint" ? "the lock" : "locks"} on V3. {ethUse(use, dest)} Install one, then reload this page.
        </p>
        <a class="btn btn--primary btn--lg btn--block" href="https://metamask.io/download/" target="_blank" rel="noopener" data-autofocus>
          Get MetaMask
          <Icon id="i-external" />
        </a>
        <p class="sheet-foot">
          {dest === "sepolia" ? "Any public Sepolia faucet gives Sepolia ETH." : `${destOf(dest).short}'s own bridge takes Sepolia ETH there, and its public faucets give some.`} On a phone,
          open this page in the MetaMask app's browser.
        </p>
      </div>
    ),
  });
}

export function openNoWallet(): void {
  openSheet({
    title: "No wallet found",
    body: (
      <div class="sheet-stack">
        <div class="empty-mark" aria-hidden="true">
          <Icon id="i-wallet" cls="i--20" />
        </div>
        <p class="sheet-lead">Bridge Zero works with MetaMask and other browser wallets, and with Portaldot Wallet and other Polkadot wallets for 5… accounts.</p>
        <ol class="howto">
          <li>
            <span class="howto__n mono">1</span>
            <span>Install a browser wallet, then reload this page.</span>
          </li>
          <li>
            <span class="howto__n mono">2</span>
            <span>
              Add Portaldot V3 testnet (chain <span class="mono">420420777</span>). The app does this for you.
            </span>
          </li>
          <li>
            <span class="howto__n mono">3</span>
            <span>Get tPOT: ask in the Portaldot community. There is no self-service faucet.</span>
          </li>
        </ol>
        <a class="btn btn--primary btn--lg btn--block" href="https://metamask.io/download/" target="_blank" rel="noopener" data-autofocus>
          Get MetaMask
          <Icon id="i-external" />
        </a>
        <a class="btn btn--secondary btn--lg btn--block" href={PORTALDOT_WALLET_URL} target="_blank" rel="noopener">
          Get Portaldot Wallet
          <Icon id="i-external" />
        </a>
        <p class="sheet-foot">On a phone, open this page in the MetaMask app's browser.</p>
      </div>
    ),
  });
}
