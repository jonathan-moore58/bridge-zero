// Connecting a wallet: the picker of the wallets this browser has, the sheet for a browser that has
// none, and adding wtPOT to the wallet.

import { useEffect } from "preact/hooks";
import { TOKEN } from "../lib/chains.ts";
import { checksum } from "../lib/display.ts";
import { useBox } from "./store.ts";
import { Chip, Icon, closeSheet, openSheet, short, toast } from "./ui.tsx";
import { addWtpot, connect, wallet, walletCode, wallets } from "./wallet.ts";

/** Adds wtPOT to the wallet, and says what the wallet answered. A wallet not connected yet is connected first. */
export async function addWtpotToWallet(): Promise<void> {
  const status = wallet.get().status;
  if (status === "none") return openNoWallet();
  if (status === "off") return openWalletPicker(() => void addWtpotToWallet());
  if (status === "connecting") return toast("info", "Check your wallet", "It already has a connection request open.");
  const token = `${short(checksum(TOKEN))} on Sepolia, 14 decimals.`;
  try {
    if (await addWtpot()) toast("verify", "wtPOT added to your wallet", token);
    else toast("info", "wtPOT not added", `Your wallet did not add it. The token is ${token}`);
  } catch (e) {
    if (walletCode(e) !== 4001) toast("revert", "Your wallet refused", (e as Error).message || "Switch it to Sepolia, then add wtPOT.");
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

/** A wallet's own icon (wallet.ts keeps only a data:image/ URI), else the sprite's wallet. */
export function WalletIcon({ icon }: { icon: string | null }) {
  return icon ? (
    <img class="wallet-ico" src={icon} alt="" />
  ) : (
    <span class="wallet-ico wallet-ico--none" aria-hidden="true">
      <Icon id="i-wallet" cls="i--20" />
    </span>
  );
}

function WalletList({ after }: { after: (() => void) | undefined }) {
  const list = useBox(wallets);
  const status = useBox(wallet).status;
  // Connected some other way while this is open (from the wallet itself, say): nothing left to pick.
  useEffect(() => {
    if (status === "on") closeSheet();
  }, [status]);
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

/** The wallets this browser has, to connect one; `after` runs once it is connected. */
export function openWalletPicker(after?: () => void): void {
  if (!wallets.get().length) return openNoWallet();
  openSheet({ title: "Connect a wallet", cls: "picker", body: <WalletList after={after} /> });
}

export function openNoWallet(): void {
  openSheet({
    title: "No wallet found",
    body: (
      <div class="sheet-stack">
        <div class="empty-mark" aria-hidden="true">
          <Icon id="i-wallet" cls="i--20" />
        </div>
        <p class="sheet-lead">Bridge Zero works with MetaMask and other browser wallets. The same address is used on both chains.</p>
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
        <p class="sheet-foot">On a phone, open this page in the MetaMask app's browser.</p>
      </div>
    ),
  });
}
