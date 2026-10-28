// The visitor's Polkadot wallet, beside the Ethereum one (wallet.ts): the wallets this browser has
// in window.injectedWeb3, the one the visitor enabled, its accounts, the account picked, its address
// on V3 (what the vault records as a lock's sender) and its tPOT. Either wallet, or both, can be
// connected: the Polkadot one signs the lock, the Ethereum one can fill the destination's address
// and send a mint. The library that builds and sends the lock (./substrate/chain.ts) is loaded on
// first use.

import { V3_EVM, V3_SUBSTRATE_WS, VAULT } from "../lib/chains.ts";
import type { Hex } from "../lib/hex.ts";
import { registry } from "../lib/live.ts";
import { revertOf } from "../lib/proof/sepolia.ts";
import { request } from "../lib/rpc.ts";
import { ss58 } from "../lib/ss58.ts";
import { Box } from "./store.ts";
import { accountIdOf, reviveAddress, SS58_PREFIX } from "./substrate/account.ts";
import { accountRows, enableWallet, polkaWallets, type AccountRow, type Injected, type InjectedSigner, type InjectedWindow, type PolkaWallet } from "./substrate/inject.ts";
import type { V3Chain } from "./substrate/chain.ts";

export interface PolkaAccount {
  /** SS58 with Portaldot's prefix (42), whatever form the wallet gave. */
  address: string;
  name: string | null;
  /** pallet-revive's address of the account: the vault's sender for its locks. */
  h160: Hex;
}

export interface PolkaState {
  /** off: none enabled; asking: the wallet's prompt is open; picking: enabled, no account picked; on: an account picked. */
  status: "off" | "asking" | "picking" | "on";
  wallet: PolkaWallet | null;
  accounts: AccountRow[];
  account: PolkaAccount | null;
  /** The account's tPOT on V3, native units; null until read. */
  balance: bigint | null;
}

const OFF: PolkaState = { status: "off", wallet: null, accounts: [], account: null, balance: null };

export const polka = new Box<PolkaState>(OFF);

/** The Polkadot wallets this browser has, Portaldot's own first. */
export const polkaList = new Box<PolkaWallet[]>([]);

const STORE = "bz-app.polkadot";
/** As wallet.ts: extensions inject at once, a few late. */
const DISCOVERY_MS = 600;

let injected: Injected | null = null;
let unsubscribe: (() => void) | null = null;

const win = (): InjectedWindow => window as unknown as InjectedWindow;

function remember(v: { key: string; address: string } | null): void {
  try {
    if (v) localStorage.setItem(STORE, JSON.stringify(v));
    else localStorage.removeItem(STORE);
  } catch {
    // Blocked: the page forgets it on reload.
  }
}

function recalled(): { key: string; address: string } | null {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? "null") as { key?: unknown; address?: unknown } | null;
    return v && typeof v.key === "string" && typeof v.address === "string" ? { key: v.key, address: v.address } : null;
  } catch {
    return null;
  }
}

/** An SS58 address in Portaldot's form, or null when it is not one of a 32-byte account. */
export function normalize(address: string): string | null {
  const a = accountIdOf(address);
  return a ? ss58(a.id, SS58_PREFIX) : null;
}

export function listPolka(): void {
  polkaList.set(polkaWallets(win()));
}

function patch(p: Partial<PolkaState>): void {
  polka.set((s) => ({ ...s, ...p }));
}

function watchAccounts(i: Injected): void {
  unsubscribe?.();
  unsubscribe = null;
  const sub = i.accounts.subscribe;
  if (typeof sub !== "function") return;
  try {
    const r = sub((list) => {
      const rows = accountRows(list ?? [], polka.get().wallet?.name);
      const cur = polka.get();
      patch({ accounts: rows });
      // The account picked is no longer shared with the page: it is not connected any more.
      if (cur.account && !rows.some((r2) => normalize(r2.address) === cur.account?.address && !r2.why)) patch({ status: "picking", account: null, balance: null });
    });
    if (typeof r === "function") unsubscribe = r as () => void;
    else if (r && typeof (r as Promise<unknown>).then === "function") (r as Promise<unknown>).then((u) => (typeof u === "function" ? (unsubscribe = u as () => void) : undefined), () => undefined);
  } catch {
    // A wallet without subscriptions: the list stays as read.
  }
}

/** Enables the wallet the visitor picked: its prompt asks to share accounts. Throws what it answered. */
export async function connectPolka(key: string): Promise<AccountRow[]> {
  const wallet = polkaWallets(win()).find((w) => w.key === key) ?? null;
  patch({ status: "asking", wallet, account: null, balance: null, accounts: [] });
  try {
    const i = await enableWallet(win(), key);
    injected = i;
    const rows = accountRows(await i.accounts.get(true), wallet?.name);
    patch({ status: "picking", accounts: rows });
    watchAccounts(i);
    // The library is fetched while the visitor picks an account.
    void import("./substrate/chain.ts").catch(() => undefined);
    return rows;
  } catch (e) {
    injected = null;
    polka.set(OFF);
    throw e;
  }
}

/** The account the visitor picked from the wallet's. */
export function pickAccount(row: AccountRow): void {
  const address = normalize(row.address);
  const id = accountIdOf(row.address);
  if (!address || !id || row.why) return;
  const wallet = polka.get().wallet;
  patch({ status: "on", account: { address, name: row.name, h160: reviveAddress(id.id) }, balance: null });
  if (wallet) remember({ key: wallet.key, address });
  void readPolkaBalance();
}

export function disconnectPolka(): void {
  unsubscribe?.();
  unsubscribe = null;
  injected = null;
  remember(null);
  polka.set(OFF);
}

/** The connected wallet's signer, while an account is picked. */
export function polkaSigner(): InjectedSigner | null {
  return polka.get().status === "on" ? (injected?.signer ?? null) : null;
}

/** The account's tPOT on V3: eth_getBalance of its address on V3 (pallet-revive maps it to the account), in 18 decimals, as native units. */
export async function readPolkaBalance(): Promise<void> {
  const a = polka.get().account;
  if (!a) return;
  try {
    const r = await request<string>(V3_EVM, "eth_getBalance", [a.h160, "latest"]);
    if (polka.get().account?.address === a.address) patch({ balance: BigInt(r.result) / 10_000n });
  } catch {
    // Read again on the next round.
  }
}

let started = false;

/** Finds the wallets, and reconnects the account the visitor picked before, if its wallet is here and still shares it. */
export function startPolka(): void {
  if (started) return;
  started = true;
  listPolka();
  setTimeout(() => {
    listPolka();
    const r = recalled();
    if (!r || polka.get().status !== "off" || !polkaList.get().some((w) => w.key === r.key)) return;
    void connectPolka(r.key).then(
      (rows) => {
        const row = rows.find((x) => normalize(x.address) === r.address && !x.why);
        if (row) pickAccount(row);
        else if (polka.get().status === "picking") patch({ status: "off" });
      },
      () => remember(null),
    );
  }, DISCOVERY_MS);
  setInterval(() => {
    if (!document.hidden && polka.get().status === "on") void readPolkaBalance();
  }, 30_000);
}

// ---------------------------------------------------------------------------------------------
// The library, on first use

/** The EVM RPC's chain id, which the chunk checks along with the node's. */
const evmChainId = async (): Promise<bigint> => BigInt((await request<string>(V3_EVM, "eth_chainId", [])).result);

/** V3's node through @polkadot/api: the lazy chunk, connected once. */
export async function loadChain(): Promise<V3Chain> {
  const m = await import("./substrate/chain.ts");
  return m.v3Chain({
    node: V3_SUBSTRATE_WS.url,
    vault: VAULT,
    evmChainId,
    revertText: (data) => revertOf(data, "reverted", registry).text,
  });
}
