// The visitor's browser wallets, through wagmi's core (@wagmi/core, on viem): every wallet that
// announces itself (EIP-6963), window.ethereum for one that does not, the connected address and the
// chain it is on. Balances are read from the public RPCs for that address, not through the wallet,
// so they show on both chains whichever chain the wallet is on.

import {
  connect as wagmiConnect,
  createConfig,
  createStorage,
  disconnect as wagmiDisconnect,
  getConnection,
  getConnectorClient,
  injected,
  reconnect,
  switchChain,
  watchAsset,
  watchConnection,
  watchConnectors,
} from "@wagmi/core";
import { addChain } from "viem/actions";
import { encodeCall } from "../lib/abi.ts";
import { SEPOLIA, TOKEN, V3_EVM } from "../lib/chains.ts";
import { request } from "../lib/rpc.ts";
import { sepolia, transports, v3 } from "./chains.ts";
import type { ChainKey } from "./facts.ts";
import { Box } from "./store.ts";

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
  /** The connected wallet's name, and its icon: the data:image/ URI it announced, or null. */
  name: string | null;
  icon: string | null;
}

/** A wallet the picker offers. */
export interface WalletOption {
  /** wagmi's connector id: the wallet's EIP-6963 rdns (io.metamask, say), or "injected" for window.ethereum. */
  id: string;
  name: string;
  /** The data:image/ URI the wallet announced, or null. */
  icon: string | null;
  /** The wallet this browser connected with last. */
  last: boolean;
}

export const wallet = new Box<WalletState>({ status: "off", address: null, chainId: null, balances: null, name: null, icon: null });

/** The wallets found in this browser, the last used first. */
export const wallets = new Box<WalletOption[]>([]);

/** V3's EVM values have 18 decimals; tPOT has 14 (NativeToEthRatio 10,000, docs/V3.md). */
const V3_EVM_PER_NATIVE = 10_000n;
/** Wallets answer EIP-6963 at once and a few inject late: this long passes before the page says there is none. */
const DISCOVERY_MS = 600;
/** wagmi's connector for window.ethereum; every other connector is a wallet's EIP-6963 announcement. */
const INJECTED = "injected";

/**
 * localStorage where the browser allows it, else memory for the page's life. wagmi keeps the last
 * used wallet and each wallet's "disconnected" flag here, and wagmi's own default throws where
 * storage is blocked.
 */
function browserStorage() {
  const memory = new Map<string, string>();
  const local = (() => {
    try {
      const s = window.localStorage;
      s.setItem("bz-app.probe", "1");
      s.removeItem("bz-app.probe");
      return s;
    } catch {
      return null;
    }
  })();
  return {
    getItem(key: string): string | null {
      try {
        if (local) return local.getItem(key);
      } catch {
        // Blocked since the probe: memory has what this page wrote.
      }
      return memory.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      memory.set(key, value);
      try {
        local?.setItem(key, value);
      } catch {
        // Full or blocked: memory keeps it.
      }
    },
    removeItem(key: string): void {
      memory.delete(key);
      try {
        local?.removeItem(key);
      } catch {
        // Blocked.
      }
    },
  };
}

const config = createConfig({
  chains: [v3, sepolia],
  // window.ethereum, for a wallet that does not announce itself; EIP-6963 adds a connector for each
  // wallet that does. WalletConnect, for a phone wallet without an in-app browser, would be one more
  // connector here (walletConnect from @wagmi/connectors), with the owner's Reown project id and its
  // relay's hosts in the page's connect-src (vite.config.ts). It is not wired.
  connectors: [injected()],
  multiInjectedProviderDiscovery: true,
  storage: createStorage({ key: "bz-app.wallet", storage: browserStorage() }),
  transports,
});

/** The wallet a connect() waits on. */
let pending: string | null = null;
/** The connector id wagmi stored as the last one connected. */
let recent: string | null = null;
/** Discovery has had its moment: no wallet by now means none. */
let settled = false;

const nameOf = (c: { id: string; name: string }): string => (c.id === INJECTED ? "Browser wallet" : c.name);

/** Only a data:image/ URI is drawn as an <img>; anything else gets the page's own wallet icon. */
const imageOf = (icon: string | undefined): string | null => (icon && /^data:image\//i.test(icon) ? icon : null);

const hasEthereum = (): boolean => typeof (window as { ethereum?: { request?: unknown } }).ethereum?.request === "function";

/**
 * The EIP-1193 code a wallet answered with (4001: the user said no; 4902: unknown chain; -32002: a
 * request is already open). viem and wagmi wrap the wallet's error, at times in a class with another
 * code (a pending request comes back as a SwitchChainError, 4902; a failed wallet_addEthereumChain
 * as a UserRejectedRequestError, 4001), so this walks the causes and keeps the innermost code, the
 * wallet's own.
 */
export function walletCode(e: unknown): number | null {
  let code: number | null = null;
  for (const x of causes(e)) {
    const c = (x as { code?: unknown }).code;
    if (typeof c === "number") code = c;
  }
  return code;
}

/** The error and its causes, outermost first; MetaMask Mobile nests its own in data.originalError. */
function causes(e: unknown): object[] {
  const out: object[] = [];
  for (let x: unknown = e; x !== null && typeof x === "object" && !out.includes(x) && out.length < 8; ) {
    out.push(x);
    const o = x as { cause?: unknown; data?: { originalError?: unknown } | null };
    x = o.cause ?? o.data?.originalError;
  }
  return out;
}

/**
 * What a wallet call threw, for a toast: the wallet's own words (the innermost message; viem's and
 * wagmi's messages run to docs links and versions), and its code for walletCode.
 */
class WalletError extends Error {
  readonly code: number | null;

  constructor(cause: unknown) {
    let text = "";
    for (const x of causes(cause)) {
      const o = x as { shortMessage?: unknown; message?: unknown };
      const s = typeof o.shortMessage === "string" ? o.shortMessage : o.message;
      if (typeof s === "string" && s.trim()) text = s.trim().split("\n")[0] ?? "";
    }
    super(text, { cause });
    this.name = "WalletError";
    this.code = walletCode(cause);
  }
}

function patch(p: Partial<WalletState>): void {
  wallet.set((w) => ((Object.keys(p) as (keyof WalletState)[]).every((k) => Object.is(w[k], p[k])) ? w : { ...w, ...p }));
}

/** The wallet state from wagmi's connection: "connecting" only while a connect() the visitor asked for waits. */
function sync(): void {
  const c = getConnection(config);
  if (c.status === "connected") {
    const prev = wallet.get();
    const same = prev.address?.toLowerCase() === c.address.toLowerCase();
    patch({
      status: "on",
      address: c.address,
      chainId: BigInt(c.chainId),
      balances: same ? prev.balances : null,
      name: nameOf(c.connector),
      icon: imageOf(c.connector.icon),
    });
    if (!same) void readBalances();
    return;
  }
  // wagmi's own reconnect on load is not shown: the wallet asks nothing, as with a first visit.
  const status = pending ? "connecting" : wallets.get().length || !settled ? "off" : "none";
  patch({ status, address: null, chainId: null, balances: null, name: null, icon: null });
}

function listWallets(): void {
  const announced = config.connectors.filter((c) => c.id !== INJECTED);
  // window.ethereum is listed only when no wallet announced itself: it is usually one of those.
  const shown = announced.length ? announced : config.connectors.filter((c) => c.id === INJECTED && hasEthereum());
  const list = shown.map((c) => ({ id: c.id, name: nameOf(c), icon: imageOf(c.icon), last: c.id === recent }));
  wallets.set(list.sort((a, b) => Number(b.last) - Number(a.last)));
  sync();
}

let started = false;

/** Finds the wallets, restores a connection the visitor already allowed, and follows wagmi's state. */
export function startWallet(): void {
  if (started) return;
  started = true;
  watchConnection(config, { onChange: sync });
  watchConnectors(config, {
    onChange(list, prev) {
      listWallets();
      // The last used wallet announced itself after the reconnect below ran: restore it now.
      const late = list.find((c) => c.id === recent && !prev.some((p) => p.uid === c.uid));
      if (late && !pending && getConnection(config).status === "disconnected") void reconnect(config, { connectors: [late] }).catch(() => undefined);
    },
  });
  // A wallet that sets window.ethereum after the page loads, without announcing itself.
  window.addEventListener("ethereum#initialized", listWallets, { once: true });
  void Promise.resolve(config.storage?.getItem("recentConnectorId")).then(
    (id) => {
      recent = typeof id === "string" ? id : null;
      listWallets();
    },
    () => undefined,
  );
  listWallets();
  setTimeout(() => {
    settled = true;
    sync();
  }, DISCOVERY_MS);
  // After wagmi has read back what it stored (a few microtasks after createConfig).
  setTimeout(() => void reconnect(config).catch(() => undefined), 0);
  setInterval(() => {
    if (!document.hidden && wallet.get().status === "on") void readBalances();
  }, 30_000);
}

/** Connects the wallet the visitor picked (a WalletOption's id); throws what the wallet answered. */
export async function connect(walletId: string): Promise<void> {
  const connector = config.connectors.find((c) => c.id === walletId);
  if (!connector) throw new WalletError(new Error("That wallet is no longer in this browser."));
  pending = walletId;
  sync();
  try {
    if (getConnection(config).connector?.uid !== connector.uid) await wagmiConnect(config, { connector });
    recent = walletId;
    listWallets();
  } catch (e) {
    throw new WalletError(e);
  } finally {
    pending = null;
    sync();
  }
}

/** Disconnects every wallet wagmi holds (it asks each to revoke the page's access, where it can). */
export async function disconnect(): Promise<void> {
  for (const { connector } of [...config.state.connections.values()]) {
    try {
      await wagmiDisconnect(config, { connector });
    } catch {
      // A wallet that has gone away: the page forgets it below either way.
    }
  }
  if (config.state.status !== "disconnected") config.setState((x) => ({ ...x, connections: new Map(), current: null, status: "disconnected" }));
}

/** Asks the wallet to add the Portaldot V3 testnet (it then offers to switch to it). */
export async function addV3(): Promise<void> {
  try {
    await addChain(await getConnectorClient(config), { chain: v3 });
  } catch (e) {
    throw new WalletError(e);
  }
}

/** Switches the wallet to a bridge chain; wagmi adds V3 first when the wallet does not know it. */
export async function switchTo(chain: ChainKey): Promise<void> {
  try {
    await switchChain(config, { chainId: chain === "v3" ? v3.id : sepolia.id });
  } catch (e) {
    throw new WalletError(e);
  }
}

/**
 * Asks the wallet to show wtPOT (EIP-747); true when it says it added it. A wallet files a token
 * under the network it is on, so this switches it to Sepolia first.
 */
export async function addWtpot(): Promise<boolean> {
  try {
    if (getConnection(config).chainId !== sepolia.id) await switchChain(config, { chainId: sepolia.id });
    return (await watchAsset(config, { type: "ERC20", options: { address: TOKEN, symbol: "wtPOT", decimals: 14 } })) === true;
  } catch (e) {
    throw new WalletError(e);
  }
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
