// Polkadot wallets in the browser, without a library: each extension puts itself in
// window.injectedWeb3 under its own name ("portaldot extension", "polkadot-js", "subwallet-js",
// "talisman"…) with an enable(appName) that asks the visitor, then gives the accounts it shares and
// a signer. Only the wallet the visitor picks is enabled: @polkadot/extension-dapp's web3Enable
// would open every installed wallet's prompt. Kept apart from the DOM and the build's records so
// that node --test runs it against a stand-in extension.

import { accountIdOf, V3_GENESIS } from "./account.ts";
import type { PayloadJson } from "./call.ts";

export interface InjectedAccount {
  address: string;
  name?: string | null;
  /** sr25519, ed25519, ecdsa or ethereum. */
  type?: string | null;
  /** A genesis the wallet binds the account to, or none. */
  genesisHash?: string | null;
}

export interface SignerResult {
  id: number;
  signature: `0x${string}`;
  /** The extrinsic as the wallet signed it, when it changed what the page asked (a metadata hash). */
  signedTransaction?: `0x${string}` | Uint8Array;
}

export interface InjectedSigner {
  signPayload?: (payload: PayloadJson) => Promise<SignerResult>;
}

export interface Injected {
  accounts: {
    get: (anyType?: boolean) => Promise<InjectedAccount[]>;
    subscribe?: (cb: (accounts: InjectedAccount[]) => void) => (() => void) | Promise<() => void> | unknown;
  };
  signer: InjectedSigner;
}

export interface InjectedProvider {
  enable?: (origin: string) => Promise<Injected>;
  version?: string;
}

/** What the page reads of the window: the extensions' entries. */
export interface InjectedWindow {
  injectedWeb3?: Record<string, InjectedProvider | undefined>;
}

/** What the page calls itself when a wallet asks the visitor to share accounts. */
export const APP_NAME = "Bridge Zero";

/** Portaldot's own wallet's page on the Chrome Web Store, as portaldot.world links it (Products, Portaldot Wallet). */
export const PORTALDOT_WALLET_URL = "https://chromewebstore.google.com/detail/portaldot-extension/cpdecangbhmfijmlmjglfcocfpaojceo";

/** The wallets the page names; any other is listed by the name it injected itself under. */
const KNOWN: Record<string, { name: string; rank: number; note: string | null }> = {
  "portaldot extension": { name: "Portaldot Wallet", rank: 0, note: null },
  "polkadot-js": { name: "polkadot{.js}", rank: 1, note: null },
  "subwallet-js": { name: "SubWallet", rank: 2, note: null },
  talisman: { name: "Talisman", rank: 3, note: "Add Portaldot V3 in Talisman first" },
};

/** A Polkadot wallet the picker offers. */
export interface PolkaWallet {
  /** Its key in window.injectedWeb3; the picker draws the wallet's own mark by it (../marks.tsx). */
  key: string;
  name: string;
  /** Portaldot's own wallet, listed first. */
  portaldot: boolean;
  /** What the visitor has to know first, for the row's meta line. */
  note: string | null;
}

/** The Polkadot wallets this window has, Portaldot's own first, then the ones the page knows, then the others by name. */
export function polkaWallets(win: InjectedWindow): PolkaWallet[] {
  const found: PolkaWallet[] = [];
  for (const [key, p] of Object.entries(win.injectedWeb3 ?? {})) {
    if (!p || typeof p.enable !== "function") continue;
    const k = KNOWN[key];
    found.push({ key, name: k?.name ?? key, portaldot: key === "portaldot extension", note: k?.note ?? null });
  }
  const rank = (w: PolkaWallet) => KNOWN[w.key]?.rank ?? 99;
  return found.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** What a wallet's answer means. rejected: the visitor said no. metadata: Talisman, which signs only for networks it was given. */
export type WalletFault = "rejected" | "metadata" | "other";

export function faultOf(e: unknown): WalletFault {
  const text = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  if (/unable to find metadata/i.test(text)) return "metadata";
  if (/cancel|reject|denied|declin|not allowed|closed/i.test(text)) return "rejected";
  return "other";
}

/** A wallet's error in its own words, first line. */
export const faultText = (e: unknown): string => ((e instanceof Error ? e.message : String(e)).trim().split("\n")[0] ?? "").slice(0, 240);

/**
 * Enables the one wallet the visitor picked: its prompt asks them to share accounts with the page.
 * Throws what the wallet answered, or that the wallet is gone or does not sign payloads.
 */
export async function enableWallet(win: InjectedWindow, key: string): Promise<Injected> {
  const p = win.injectedWeb3?.[key];
  if (!p || typeof p.enable !== "function") throw new Error("That wallet is no longer in this browser.");
  const injected = await p.enable(APP_NAME);
  if (!injected || typeof injected.accounts?.get !== "function") throw new Error("The wallet shared no accounts.");
  if (typeof injected.signer?.signPayload !== "function") throw new Error("The wallet cannot sign Substrate transactions (signPayload).");
  return injected;
}

/** An account the account picker lists: usable, or why not. */
export interface AccountRow {
  address: string;
  name: string | null;
  type: string | null;
  /** Null when this page can use it; else why not, for the row. */
  why: string | null;
}

/**
 * The wallet's accounts as the page can use them: Substrate accounts (sr25519, ed25519, ecdsa) for
 * any chain or for V3. An Ethereum account is the wallet's other side (its EIP-6963 entry), an
 * account bound to another chain's genesis would not sign for V3, and an address that is not an
 * SS58 address of a 32-byte account is not one V3 knows. Ledger accounts are not checked here:
 * a failed signature says so. Each why says what to do, in `walletName` when it is the wallet's.
 */
export function accountRows(list: readonly InjectedAccount[], walletName = "your wallet"): AccountRow[] {
  const out: AccountRow[] = [];
  for (const a of list) {
    if (!a || typeof a.address !== "string" || out.some((o) => o.address === a.address)) continue;
    const type = typeof a.type === "string" ? a.type : null;
    const name = typeof a.name === "string" && a.name.trim() ? a.name.trim() : null;
    let why: string | null = null;
    if (type === "ethereum" || /^0x[0-9a-fA-F]{40}$/.test(a.address)) why = "An Ethereum account: connect it as an Ethereum wallet";
    else if (a.genesisHash && a.genesisHash.toLowerCase() !== V3_GENESIS) why = `Bound to another network: in ${walletName}, set this account to any network`;
    else if (!accountIdOf(a.address)) why = "Not a Substrate address";
    out.push({ address: a.address, name, type, why });
  }
  return out;
}
