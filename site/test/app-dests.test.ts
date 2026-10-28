// The destinations' one config (src/app/dests.ts): every address against deployments/, the chain ids
// against viem's, the RPCs against the Content-Security-Policy (build/csp.ts), and the chain picker's
// rows: Sepolia live, Base Sepolia and Arbitrum Sepolia, whose minter and wtPOT are deployed, listed
// and not pickable, and a destination pickable only once the app sends to it (SENDS). Offline.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { getContractAddress } from "viem";
import { arbitrumSepolia as viemArbitrumSepolia, baseSepolia as viemBaseSepolia, sepolia as viemSepolia } from "viem/chains";
import { BRIDGE_NODES, ROLLUP_NODES, connectOf, cspPolicy } from "../build/csp.ts";
import { arbitrumSepolia, baseSepolia, sepolia, transports, v3 } from "../src/app/chains.ts";
import { DESTS, ROLLUPS, SENDS, destByChainId, destOf, destState, pickRows, selectable, type Dest, type DestKey } from "../src/app/dests.ts";
import { LATER_CHAINS } from "../src/app/facts.ts";
import type { Hex } from "../src/lib/hex.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = process.env.RECORDS_ROOT ?? join(here, "..", "..");
const readJson = (path: string): any => JSON.parse(readFileSync(join(repo, path), "utf8"));
const lower = (a: string) => a.toLowerCase();

const SEP = readJson("deployments/sepolia.json");
const SEP_BRIDGE = readJson("deployments/sepolia-bridge.json");

test("three destinations: Sepolia, then Base Sepolia and Arbitrum Sepolia, each with its chain id, names, mark and explorer", () => {
  assert.deepEqual(
    DESTS.map((d) => [d.key, d.chainId, d.name, d.sub, d.full, d.short, d.mark]),
    [
      ["sepolia", 11155111, "Ethereum", "Sepolia", "Ethereum Sepolia", "Sepolia", "ethereum"],
      ["base-sepolia", 84532, "Base", "Sepolia", "Base Sepolia", "Base Sepolia", "base"],
      ["arbitrum-sepolia", 421614, "Arbitrum", "Sepolia", "Arbitrum Sepolia", "Arbitrum Sepolia", "arbitrum"],
    ],
  );
  // The chain ids and explorers viem knows these chains by.
  for (const [d, v] of [
    [destOf("sepolia"), viemSepolia],
    [destOf("base-sepolia"), viemBaseSepolia],
    [destOf("arbitrum-sepolia"), viemArbitrumSepolia],
  ] as const) {
    assert.equal(d.chainId, v.id, d.full);
    assert.equal(d.explorer.url, v.blockExplorers.default.url, d.full);
  }
  assert.deepEqual(
    ROLLUPS.map((d) => d.key),
    ["base-sepolia", "arbitrum-sepolia"],
  );
});

test("Sepolia's addresses are the records': V3's client #2 and ProvenBalance #2, BridgeMinter and wtPOT", () => {
  const s = destOf("sepolia");
  assert.equal(s.lightClient, lower(SEP.contracts["GrandpaLightClient #2"]));
  assert.equal(s.provenBalance, lower(SEP.contracts["ProvenBalance #2"]));
  assert.equal(s.minter, lower(SEP_BRIDGE.contracts.BridgeMinter));
  assert.equal(s.token, lower(SEP_BRIDGE.contracts.WrappedTPOT));
  assert.equal(s.lightClient, "0x447171c4885ad725ee4772e8e3c228adee50dcb0");
});

test("each rollup's V3 client and ProvenBalance are its record's; on Sepolia the same address is the old mainnet's client", () => {
  for (const d of ROLLUPS) {
    const r = readJson(`deployments/${d.key}.json`);
    assert.equal(r.network, d.key);
    assert.equal(r.chainId, d.chainId, d.full);
    assert.equal(d.lightClient, lower(r.contracts["GrandpaLightClient #2"]), d.full);
    assert.equal(d.provenBalance, lower(r.contracts["ProvenBalance #2"]), d.full);
    assert.equal(d.record, `deployments/${d.key}.json and deployments/${d.key}-bridge.json`);
    // 0x3897…0ab6 is V3's client on the rollups and the old mainnet's on Sepolia: never Sepolia's V3 client.
    assert.equal(d.lightClient, lower(SEP.contracts["GrandpaLightClient #1"]));
    assert.notEqual(d.lightClient, destOf("sepolia").lightClient);
  }
});

test("each rollup's BridgeMinter and wtPOT are its bridge record's, bound to its V3 client and the V3 vault", () => {
  const vault = lower(readJson("deployments/v3-testnet.json").vault.address);
  for (const d of ROLLUPS) {
    assert.ok(d.minter && d.token, `${d.full}: deployed on Oct 27`);
    const file = `deployments/${d.key}-bridge.json`;
    if (existsSync(join(repo, file))) {
      const r = readJson(file);
      assert.equal(r.network, d.key, file);
      assert.equal(r.chainId, d.chainId, file);
      assert.equal(d.minter, lower(r.contracts.BridgeMinter), file);
      assert.equal(d.token, lower(r.contracts.WrappedTPOT), file);
      assert.equal(lower(r.lightClient.address), d.lightClient, file);
      assert.equal(lower(r.vault.address), vault, file);
      assert.equal(r.vault.chainId, 420420777, file);
      continue;
    }
    // This branch's deployments/ predates the bridge records (main has them since 3d957a7): the
    // addresses must be the next two contracts the rollup's deployer created after the client's
    // deployment, BridgeMinter and then wtPOT, as the deploy tool sends them.
    const rec = readJson(`deployments/${d.key}.json`);
    const after = Math.max(...rec.steps.map((s: { nonce: number }) => s.nonce));
    const created = (nonce: number) => lower(getContractAddress({ from: rec.deployer, nonce: BigInt(nonce) }));
    const n = Array.from({ length: 16 }, (_, i) => after + 1 + i).find((k) => created(k) === d.minter);
    assert.ok(n !== undefined, `${d.full}: BridgeMinter is not a contract its deployer created after the client`);
    assert.equal(created(n + 1), d.token, `${d.full}: wtPOT is the deployer's next contract`);
  }
});

test("two or more public RPCs each, over https and distinct; the CSP adds exactly the rollups' to the app's page", () => {
  for (const d of DESTS) {
    assert.ok(d.rpcs.length >= 2, d.full);
    assert.equal(new Set(d.rpcs.map((e) => new URL(e.url).host)).size, d.rpcs.length, d.full);
    for (const e of d.rpcs) assert.equal(new URL(e.url).protocol, "https:", e.url);
  }
  assert.deepEqual(ROLLUP_NODES, [
    "https://base-sepolia-rpc.publicnode.com",
    "https://sepolia.base.org",
    "https://sepolia-rollup.arbitrum.io/rpc",
    "https://arbitrum-sepolia-rpc.publicnode.com",
  ]);
  assert.deepEqual(connectOf(true), [...BRIDGE_NODES, ...ROLLUP_NODES]);
  // The status page reads no rollup.
  assert.deepEqual(connectOf(false), BRIDGE_NODES);
  assert.deepEqual(BRIDGE_NODES, [
    "https://ethereum-sepolia-rpc.publicnode.com",
    "https://sepolia.drpc.org",
    "https://sepolia.gateway.tenderly.co",
    "https://test-evm-rpc-v3.portaldot.dev",
    "https://test-node-v3.portaldot.dev",
    "wss://test-node-v3.portaldot.dev",
    "wss://mainnet.portaldot.io",
  ]);
  const connect = (p: string) => (p.split("; ").find((x) => x.startsWith("connect-src ")) ?? "").split(" ").slice(1);
  assert.deepEqual(connect(cspPolicy(true)), connectOf(true));
  assert.deepEqual(connect(cspPolicy(false)), BRIDGE_NODES);
  assert.ok(cspPolicy(true).includes("img-src 'self' data:"), "the marks are served with the page");
});

test("wagmi's chains: V3, Sepolia and the two rollups, each read through the page's own RPCs", () => {
  assert.deepEqual(
    [v3.id, sepolia.id, baseSepolia.id, arbitrumSepolia.id],
    [420420777, 11155111, 84532, 421614],
  );
  assert.deepEqual(baseSepolia.rpcUrls.default.http, destOf("base-sepolia").rpcs.map((e) => e.url));
  assert.deepEqual(arbitrumSepolia.rpcUrls.default.http, destOf("arbitrum-sepolia").rpcs.map((e) => e.url));
  assert.deepEqual(Object.keys(transports).map(Number).sort((a, b) => a - b), [84532, 421614, 11155111, 420420777]);
});

test("Sepolia is live; Base Sepolia and Arbitrum Sepolia are ready, their minter deployed: listed, not pickable", () => {
  assert.deepEqual(
    DESTS.map((d) => [d.key, destState(d), selectable(d)]),
    [
      ["sepolia", "live", true],
      ["base-sepolia", "ready", false],
      ["arbitrum-sepolia", "ready", false],
    ],
  );
  // The bridge card's balance, recipient, token, costs and strip are Sepolia's: a rollup joins SENDS only with its own.
  assert.deepEqual([...SENDS], ["sepolia"]);
});

test("Receive on, the way in: V3 turns the card round, Sepolia is the current one, the rollups cannot be picked", () => {
  assert.deepEqual(pickRows("to", "in", "sepolia"), [
    { key: "v3", state: "open", to: { dir: "back", dest: "sepolia" } },
    { key: "sepolia", state: "current", to: null },
    { key: "base-sepolia", state: "soon", to: null },
    { key: "arbitrum-sepolia", state: "soon", to: null },
  ]);
});

test("Send from, the way in: V3 is the current one; Sepolia turns the card round, as the picker always did", () => {
  assert.deepEqual(pickRows("from", "in", "sepolia"), [
    { key: "v3", state: "current", to: null },
    { key: "sepolia", state: "open", to: { dir: "back", dest: "sepolia" } },
    { key: "base-sepolia", state: "soon", to: null },
    { key: "arbitrum-sepolia", state: "soon", to: null },
  ]);
  // The way back mirrors it: Sepolia is sent from, V3 receives.
  assert.deepEqual(pickRows("from", "back", "sepolia").slice(0, 2), [
    { key: "v3", state: "open", to: { dir: "in", dest: "sepolia" } },
    { key: "sepolia", state: "current", to: null },
  ]);
  assert.deepEqual(pickRows("to", "back", "sepolia").slice(0, 2), [
    { key: "v3", state: "current", to: null },
    { key: "sepolia", state: "open", to: { dir: "in", dest: "sepolia" } },
  ]);
});

/** The config with a rollup's minter and wtPOT replaced. */
function withMinter(key: DestKey, minter: Hex | null, token: Hex | null): Dest[] {
  return DESTS.map((d) => (d.key === key ? { ...d, minter, token } : d));
}

const M: Hex = "0x00000000000000000000000000000000000000b1";
const T: Hex = "0x00000000000000000000000000000000000000b2";

test("a deployed minter does not make a rollup pickable: only a destination the app sends to is", () => {
  const base = destOf("base-sepolia");
  // Ready, not live: the picker lists it as a soon row, which no click changes the card from.
  assert.equal(destState(base), "ready");
  assert.equal(selectable(base), false);
  for (const [side, dir] of [
    ["to", "in"],
    ["from", "back"],
    ["from", "in"],
    ["to", "back"],
  ] as const) {
    for (const r of pickRows(side, dir, "sepolia").filter((x) => x.key !== "v3" && x.key !== "sepolia")) assert.deepEqual(r, { key: r.key, state: "soon", to: null }, `${side} ${dir}`);
  }
  // Half a deployment is not ready: a minter without wtPOT, or wtPOT without a minter, is soon.
  assert.equal(destState(destOf("base-sepolia", withMinter("base-sepolia", M, null))), "soon");
  assert.equal(destState(destOf("base-sepolia", withMinter("base-sepolia", null, T))), "soon");
  assert.equal(destState(destOf("base-sepolia", withMinter("base-sepolia", null, null))), "soon");
  // Once a later stage sends to it (SENDS, with the card's facts its own), it is live and can be picked.
  const sends = new Set<DestKey>(["sepolia", "base-sepolia"]);
  assert.equal(destState(base, sends), "live");
  assert.equal(selectable(base, sends), true);
  assert.deepEqual(pickRows("to", "in", "sepolia", DESTS, sends), [
    { key: "v3", state: "open", to: { dir: "back", dest: "sepolia" } },
    { key: "sepolia", state: "current", to: null },
    { key: "base-sepolia", state: "open", to: { dir: "in", dest: "base-sepolia" } },
    { key: "arbitrum-sepolia", state: "soon", to: null },
  ]);
  assert.deepEqual(pickRows("to", "in", "base-sepolia", DESTS, sends).slice(1, 3), [
    { key: "sepolia", state: "open", to: { dir: "in", dest: "sepolia" } },
    { key: "base-sepolia", state: "current", to: null },
  ]);
});

test("the wallet button names a rollup a wallet is on", () => {
  assert.equal(destByChainId(84532n)?.full, "Base Sepolia");
  assert.equal(destByChainId(421614)?.full, "Arbitrum Sepolia");
  assert.equal(destByChainId(11155111n)?.mark, "ethereum");
  assert.equal(destByChainId(1n), null);
  assert.equal(destByChainId(null), null);
});

test("the later chains no longer list the two rollups the V3 light client is live on", () => {
  assert.deepEqual(LATER_CHAINS, ["OP Sepolia", "Polygon Amoy", "BNB Smart Chain testnet", "Avalanche Fuji"]);
  for (const d of ROLLUPS) assert.ok(!LATER_CHAINS.includes(d.full), d.full);
});
