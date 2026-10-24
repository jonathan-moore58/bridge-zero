// The visitor's browser wallet (EIP-1193): whether there is one, the connected address and the chain
// it is on. Balances are read from the public RPCs for that address, not through the wallet, so they
// show on both chains whichever chain the wallet is on.

import { encodeCall } from "../lib/abi.ts";
import { SEPOLIA, SEPOLIA_CHAIN_ID, TOKEN, V3_CHAIN_ID, V3_EVM } from "../lib/chains.ts";
import { request } from "../lib/rpc.ts";
import { CH, V3_RPC, V3_SCAN, type ChainKey } from "./facts.ts";
import { Box } from "./store.ts";

interface Eip1193 {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
  on?(event: string, fn: (...args: never[]) => void): void;
}

export type WalletStatus = "none" | "off" | "connecting" | "on";

/** In base units: tPOT and wtPOT with 14 decimals, ETH in wei. */
export interface Balances {
  tpot: bigint | null;
  wtpot: bigint | null;
  eth: bigint | null;
}

export interface WalletState {
  status: WalletStatus;
  address: string | null;
  chainId: bigint | null;
  /** null until the first read for this address answers. */
  balances: Balances | null;
}

export const wallet = new Box<WalletState>({ status: "off", address: null, chainId: null, balances: null });

/** V3's EVM values have 18 decimals; tPOT has 14 (NativeToEthRatio 10,000, docs/V3.md). */
const V3_EVM_PER_NATIVE = 10_000n;
const FORGET = "bz-app-disconnected";

function provider(): Eip1193 | null {
  const eth = (window as { ethereum?: Eip1193 }).ethereum;
  return eth && typeof eth.request === "function" ? eth : null;
}

/** The EIP-1193 error code of a wallet's refusal (4001: the user said no; 4902: unknown chain). */
export function walletCode(e: unknown): number | null {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "number" ? c : null;
}

function patch(p: Partial<WalletState>): void {
  wallet.set((w) => ({ ...w, ...p }));
}

function remember(disconnected: boolean): void {
  try {
    if (disconnected) localStorage.setItem(FORGET, "1");
    else localStorage.removeItem(FORGET);
  } catch {
    // Storage can be blocked; the wallet's own permission still decides.
  }
}

function forgotten(): boolean {
  try {
    return localStorage.getItem(FORGET) === "1";
  } catch {
    return false;
  }
}

function setAccounts(accounts: unknown): void {
  const a = Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0] : null;
  const prev = wallet.get().address;
  if (!a) {
    patch({ status: provider() ? "off" : "none", address: null, balances: null });
    return;
  }
  patch({ status: "on", address: a, balances: prev?.toLowerCase() === a.toLowerCase() ? wallet.get().balances : null });
  void readBalances();
}

function setChain(id: unknown): void {
  try {
    patch({ chainId: typeof id === "string" ? BigInt(id) : null });
  } catch {
    patch({ chainId: null });
  }
}

let started = false;
let timer: ReturnType<typeof setInterval> | undefined;

/** Finds the wallet, restores a connection the visitor already allowed, and follows its events. */
export function startWallet(): void {
  if (started) return;
  const p = provider();
  if (!p) {
    patch({ status: "none" });
    // Some wallets inject after the page loads.
    window.addEventListener("ethereum#initialized", () => startWallet(), { once: true });
    return;
  }
  started = true;
  patch({ status: "off" });
  p.on?.("accountsChanged", ((a: unknown) => setAccounts(a)) as never);
  p.on?.("chainChanged", ((id: unknown) => setChain(id)) as never);
  void p.request({ method: "eth_chainId" }).then(setChain, () => undefined);
  if (!forgotten()) void p.request({ method: "eth_accounts" }).then(setAccounts, () => undefined);
  timer ??= setInterval(() => {
    if (!document.hidden && wallet.get().status === "on") void readBalances();
  }, 30_000);
}

export async function connect(): Promise<void> {
  const p = provider();
  if (!p) return;
  patch({ status: "connecting" });
  try {
    const accounts = await p.request({ method: "eth_requestAccounts" });
    remember(false);
    setAccounts(accounts);
    setChain(await p.request({ method: "eth_chainId" }));
  } catch (e) {
    patch({ status: "off" });
    throw e;
  }
}

export async function disconnect(): Promise<void> {
  remember(true);
  patch({ status: "off", address: null, balances: null });
  try {
    await provider()?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] });
  } catch {
    // Not every wallet can revoke; the page forgets the address either way.
  }
}

/** Asks the wallet to add the Portaldot V3 testnet (it then offers to switch to it). */
export async function addV3(): Promise<void> {
  const p = provider();
  if (!p) return;
  await p.request({
    method: "wallet_addEthereumChain",
    params: [
      {
        chainId: "0x" + V3_CHAIN_ID.toString(16),
        chainName: CH.v3.full,
        nativeCurrency: { name: "tPOT", symbol: "tPOT", decimals: 18 },
        rpcUrls: [V3_RPC],
        blockExplorerUrls: [V3_SCAN],
      },
    ],
  });
}

/** Switches the wallet to a bridge chain, adding V3 first when the wallet does not know it. */
export async function switchTo(chain: ChainKey): Promise<void> {
  const p = provider();
  if (!p) return;
  const id = chain === "v3" ? V3_CHAIN_ID : SEPOLIA_CHAIN_ID;
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x" + id.toString(16) }] });
  } catch (e) {
    if (walletCode(e) === 4902 && chain === "v3") await addV3();
    else throw e;
  }
}

/**
 * Asks the wallet to show wtPOT (EIP-747); true when it added it. A wallet files a token under the
 * network it is on, so this switches it to Sepolia first.
 */
export async function addWtpot(): Promise<boolean> {
  const p = provider();
  if (!p) return false;
  if (wallet.get().chainId !== SEPOLIA_CHAIN_ID) await switchTo("sepolia");
  const answer = await p.request({ method: "wallet_watchAsset", params: { type: "ERC20", options: { address: TOKEN, symbol: "wtPOT", decimals: 14 } } });
  return answer === true;
}

/** The address's tPOT on V3, wtPOT and ETH on Sepolia. A failed read keeps its last value. */
export async function readBalances(): Promise<void> {
  const address = wallet.get().address;
  if (!address) return;
  const [tpot, wtpot, eth] = await Promise.allSettled([
    request<string>(V3_EVM, "eth_getBalance", [address, "latest"]).then((a) => BigInt(a.result) / V3_EVM_PER_NATIVE),
    request<string>(SEPOLIA, "eth_call", [{ to: TOKEN, data: encodeCall("balanceOf(address)", [address]) }, "latest"]).then((a) => BigInt(a.result)),
    request<string>(SEPOLIA, "eth_getBalance", [address, "latest"]).then((a) => BigInt(a.result)),
  ]);
  if (wallet.get().address !== address) return;
  const prev = wallet.get().balances;
  const pick = (r: PromiseSettledResult<bigint>, old: bigint | null | undefined) => (r.status === "fulfilled" ? r.value : (old ?? null));
  patch({ balances: { tpot: pick(tpot, prev?.tpot), wtpot: pick(wtpot, prev?.wtpot), eth: pick(eth, prev?.eth) } });
}
