// Connecting a wallet, the sheet for a browser that has none, and adding wtPOT to the wallet.

import { TOKEN } from "../lib/chains.ts";
import { checksum } from "../lib/display.ts";
import { Icon, openSheet, short, toast } from "./ui.tsx";
import { addWtpot, connect, wallet, walletCode } from "./wallet.ts";

/** Adds wtPOT to the wallet, and says what the wallet answered. */
export async function addWtpotToWallet(): Promise<void> {
  if (wallet.get().status === "none") return openNoWallet();
  const token = `${short(checksum(TOKEN))} on Sepolia, 14 decimals.`;
  try {
    if (await addWtpot()) toast("verify", "wtPOT added to your wallet", token);
    else toast("info", "wtPOT not added", `Your wallet did not add it. The token is ${token}`);
  } catch (e) {
    if (walletCode(e) !== 4001) toast("revert", "Your wallet refused", (e as Error).message || "Switch it to Sepolia, then add wtPOT.");
  }
}

export async function connectWallet(): Promise<void> {
  try {
    await connect();
    const w = wallet.get();
    if (w.address) toast("verify", "Wallet connected", `${short(w.address)}.`);
  } catch (e) {
    const code = walletCode(e);
    if (code === 4001) toast("info", "Not connected", "Your wallet declined the connection. Nothing was shared.");
    else if (code === -32002) toast("info", "Check your wallet", "It already has a connection request open.");
    else toast("revert", "Could not connect", (e as Error).message || "The wallet did not answer.");
  }
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
