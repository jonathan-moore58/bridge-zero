// The destinations' one config (src/app/dests.ts): every address against deployments/, the chain ids
// against viem's, the RPCs against the Content-Security-Policy (build/csp.ts), what each chain's sends
// and screens take of it (its block time, its L1 rule, where its minter's logs start, its fast
// confirmations, its finality and its costs) against the records and the relayer's rules, the ids a
// lock or a burn goes by on each, the chain each send goes out on, and the chain picker's rows:
// Sepolia, Base Sepolia, Arbitrum Sepolia and the BNB Smart Chain testnet live and pickable, and a
// destination pickable only once the app sends to it (SENDS). And the BNB Smart Chain testnet, shown
// since its first round trip on Nov 1: its entry as measured that day, its records, and the flag
// that hid it until then (HIDDEN), which keeps a destination it holds out of every picker, wagmi
// chain and the Content-Security-Policy. Offline.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { getContractAddress } from "viem";
import { arbitrumSepolia as viemArbitrumSepolia, baseSepolia as viemBaseSepolia, bscTestnet as viemBscTestnet, sepolia as viemSepolia } from "viem/chains";
import { BRIDGE_NODES, ROLLUP_NODES, connectOf, cspPolicy } from "../build/csp.ts";
import { WALLET_CHAINS, arbitrumSepolia, baseSepolia, bscTestnet, sepolia, transports, v3, viemChain } from "../src/app/chains.ts";
import {
  ALL_DESTS,
  DESTS,
  HIDDEN,
  ROLLUPS,
  SENDS,
  clientOf,
  fastConfirmationsOf,
  rollupsOf,
  shown,
  burnKey,
  deployed,
  destByChainId,
  destOf,
  destOfLock,
  destState,
  explorerBlock,
  explorerTx,
  gasFrom,
  lockKey,
  pickRows,
  refOf,
  selectable,
  type Dest,
  type DestKey,
} from "../src/app/dests.ts";
import {
  AUTO_TIME,
  BURN_GAS,
  BURN_GAS_FULL,
  CH,
  DESTS_NAMED,
  DESTS_WORD,
  FAST_BUDGET_LINE,
  LATER_CHAINS,
  MINT_GAS,
  MINT_GAS_FULL,
  OTHER_CHAINS,
  ROLLUP_RUNS,
  SEPOLIA_FINALITY,
  SLOW_RELEASE_MS,
  TIME,
  aboutMinutes,
  andList,
  chainById,
  countWord,
  destsNamedOf,
  fastWait,
  fromOf,
  otherChainsOf,
  runDayOf,
  sendChain,
  timeOf,
  toOf,
} from "../src/app/facts.ts";
import { SEPOLIA, SEPOLIA_HISTORY, SEPOLIA_LOGS } from "../src/lib/endpoints.ts";
import type { Hex } from "../src/lib/hex.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = process.env.RECORDS_ROOT ?? join(here, "..", "..");
const readJson = (path: string): any => JSON.parse(readFileSync(join(repo, path), "utf8"));
const lower = (a: string) => a.toLowerCase();

const SEP = readJson("deployments/sepolia.json");
const SEP_BRIDGE = readJson("deployments/sepolia-bridge.json");

test("four destinations: Sepolia, then Base Sepolia, Arbitrum Sepolia and the BNB Smart Chain testnet, each with its chain id, names, mark and explorer", () => {
  assert.deepEqual(
    DESTS.map((d) => [d.key, d.chainId, d.name, d.sub, d.full, d.short, d.mark]),
    [
      ["sepolia", 11155111, "Ethereum", "Sepolia", "Ethereum Sepolia", "Sepolia", "ethereum"],
      ["base-sepolia", 84532, "Base", "Sepolia", "Base Sepolia", "Base Sepolia", "base"],
      ["arbitrum-sepolia", 421614, "Arbitrum", "Sepolia", "Arbitrum Sepolia", "Arbitrum Sepolia", "arbitrum"],
      ["bsc-testnet", 97, "BNB Smart Chain", "testnet", "BNB Smart Chain testnet", "BSC testnet", "bnb"],
    ],
  );
  // The chain ids and explorers viem knows these chains by.
  for (const [d, v] of [
    [destOf("sepolia"), viemSepolia],
    [destOf("base-sepolia"), viemBaseSepolia],
    [destOf("arbitrum-sepolia"), viemArbitrumSepolia],
    [destOf("bsc-testnet"), viemBscTestnet],
  ] as const) {
    assert.equal(d.chainId, v.id, d.full);
    assert.equal(d.explorer.url, v.blockExplorers.default.url, d.full);
  }
  // Every destination but Sepolia, in the config's order: the Network page has a card for each one's client.
  assert.deepEqual(
    ROLLUPS.map((d) => d.key),
    ["base-sepolia", "arbitrum-sepolia", "bsc-testnet"],
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

test("two or more public RPCs each, over https and distinct; the CSP adds exactly the rollups' and the BNB Smart Chain testnet's to the app's page", () => {
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
    "https://bsc-testnet-rpc.publicnode.com",
    "https://bsc-testnet.bnbchain.org",
  ]);
  assert.deepEqual(connectOf(true), [...BRIDGE_NODES, ...ROLLUP_NODES]);
  // The status page reads no rollup.
  assert.deepEqual(connectOf(false), BRIDGE_NODES);
  assert.deepEqual(BRIDGE_NODES, [
    "https://ethereum-sepolia-rpc.publicnode.com",
    "https://sepolia.gateway.tenderly.co",
    "https://test-evm-rpc-v3.portaldot.dev",
    "https://test-node-v3.portaldot.dev",
    "wss://test-node-v3.portaldot.dev",
    "wss://mainnet.portaldot.io",
  ]);
  const connect = (p: string) => (p.split("; ").find((x) => x.startsWith("connect-src ")) ?? "").split(" ").slice(1);
  assert.deepEqual(connect(cspPolicy(true)), connectOf(true));
  assert.deepEqual(connect(cspPolicy(false)), BRIDGE_NODES);
  // sepolia.drpc.org's free plan refuses Sepolia since Oct 28: no list reads it, and neither page's policy lets it connect.
  for (const list of [SEPOLIA, SEPOLIA_HISTORY, SEPOLIA_LOGS]) assert.ok(!list.some((e) => /drpc/.test(e.url)), list.map((e) => e.url).join(", "));
  for (const app of [true, false]) assert.ok(!cspPolicy(app).includes("drpc"), `the ${app ? "app's" : "status page's"} policy`);
  assert.ok(cspPolicy(true).includes("img-src 'self' data:"), "the marks are served with the page");
});

test("wagmi's chains: V3, Sepolia, the two rollups and the BNB Smart Chain testnet, each read through the page's own RPCs", () => {
  assert.deepEqual(
    [v3.id, sepolia.id, baseSepolia.id, arbitrumSepolia.id, bscTestnet.id],
    [420420777, 11155111, 84532, 421614, 97],
  );
  assert.deepEqual(
    WALLET_CHAINS.map((c) => c.id),
    [420420777, 11155111, 84532, 421614, 97],
  );
  assert.deepEqual(baseSepolia.rpcUrls.default.http, destOf("base-sepolia").rpcs.map((e) => e.url));
  assert.deepEqual(arbitrumSepolia.rpcUrls.default.http, destOf("arbitrum-sepolia").rpcs.map((e) => e.url));
  assert.deepEqual(bscTestnet.rpcUrls.default.http, destOf("bsc-testnet").rpcs.map((e) => e.url));
  assert.deepEqual(Object.keys(transports).map(Number).sort((a, b) => a - b), [97, 84532, 421614, 11155111, 420420777]);
});

test("the app sends to all four: Sepolia, Base Sepolia and Arbitrum Sepolia since Oct 28, the BNB Smart Chain testnet since Nov 1, each live and pickable", () => {
  assert.deepEqual(
    DESTS.map((d) => [d.key, destState(d), selectable(d)]),
    [
      ["sepolia", "live", true],
      ["base-sepolia", "live", true],
      ["arbitrum-sepolia", "live", true],
      ["bsc-testnet", "live", true],
    ],
  );
  // Each with its own minter and wtPOT, balance read, recipient, token mark, costs and strip.
  assert.deepEqual([...SENDS], ["sepolia", "base-sepolia", "arbitrum-sepolia", "bsc-testnet"]);
});

test("Receive on, the way in: V3 turns the card round, Sepolia is the current one, and either rollup or the BNB Smart Chain testnet can be picked", () => {
  assert.deepEqual(pickRows("to", "in", "sepolia"), [
    { key: "v3", state: "open", to: { dir: "back", dest: "sepolia" } },
    { key: "sepolia", state: "current", to: null },
    { key: "base-sepolia", state: "open", to: { dir: "in", dest: "base-sepolia" } },
    { key: "arbitrum-sepolia", state: "open", to: { dir: "in", dest: "arbitrum-sepolia" } },
    { key: "bsc-testnet", state: "open", to: { dir: "in", dest: "bsc-testnet" } },
  ]);
  // With Base Sepolia chosen, it is the current one and Sepolia can be picked back.
  assert.deepEqual(pickRows("to", "in", "base-sepolia").slice(1), [
    { key: "sepolia", state: "open", to: { dir: "in", dest: "sepolia" } },
    { key: "base-sepolia", state: "current", to: null },
    { key: "arbitrum-sepolia", state: "open", to: { dir: "in", dest: "arbitrum-sepolia" } },
    { key: "bsc-testnet", state: "open", to: { dir: "in", dest: "bsc-testnet" } },
  ]);
});

test("Send from, the way in: V3 is the current one; a destination turns the card round, sent from that chain", () => {
  assert.deepEqual(pickRows("from", "in", "sepolia"), [
    { key: "v3", state: "current", to: null },
    { key: "sepolia", state: "open", to: { dir: "back", dest: "sepolia" } },
    { key: "base-sepolia", state: "open", to: { dir: "back", dest: "base-sepolia" } },
    { key: "arbitrum-sepolia", state: "open", to: { dir: "back", dest: "arbitrum-sepolia" } },
    { key: "bsc-testnet", state: "open", to: { dir: "back", dest: "bsc-testnet" } },
  ]);
  // The way back from Arbitrum Sepolia: it is the current one, and V3 is received on.
  assert.deepEqual(pickRows("from", "back", "arbitrum-sepolia"), [
    { key: "v3", state: "open", to: { dir: "in", dest: "arbitrum-sepolia" } },
    { key: "sepolia", state: "open", to: { dir: "back", dest: "sepolia" } },
    { key: "base-sepolia", state: "open", to: { dir: "back", dest: "base-sepolia" } },
    { key: "arbitrum-sepolia", state: "current", to: null },
    { key: "bsc-testnet", state: "open", to: { dir: "back", dest: "bsc-testnet" } },
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
  // The rule, with a SENDS that lacks the rollups: ready, not live, listed as a soon row, which no click changes the card from.
  const before = new Set<DestKey>(["sepolia"]);
  assert.equal(destState(base, before), "ready");
  assert.equal(selectable(base, before), false);
  for (const [side, dir] of [
    ["to", "in"],
    ["from", "back"],
    ["from", "in"],
    ["to", "back"],
  ] as const) {
    for (const r of pickRows(side, dir, "sepolia", DESTS, before).filter((x) => x.key !== "v3" && x.key !== "sepolia")) assert.deepEqual(r, { key: r.key, state: "soon", to: null }, `${side} ${dir}`);
  }
  // Half a deployment is not ready: a minter without wtPOT, or wtPOT without a minter, is soon.
  assert.equal(destState(destOf("base-sepolia", withMinter("base-sepolia", M, null))), "soon");
  assert.equal(destState(destOf("base-sepolia", withMinter("base-sepolia", null, T))), "soon");
  assert.equal(destState(destOf("base-sepolia", withMinter("base-sepolia", null, null))), "soon");
  // Once the app sends to it (SENDS, with the card's facts its own), it is live and can be picked.
  const sends = new Set<DestKey>(["sepolia", "base-sepolia"]);
  assert.equal(destState(base, sends), "live");
  assert.equal(selectable(base, sends), true);
  assert.deepEqual(pickRows("to", "in", "sepolia", DESTS, sends), [
    { key: "v3", state: "open", to: { dir: "back", dest: "sepolia" } },
    { key: "sepolia", state: "current", to: null },
    { key: "base-sepolia", state: "open", to: { dir: "in", dest: "base-sepolia" } },
    { key: "arbitrum-sepolia", state: "soon", to: null },
    { key: "bsc-testnet", state: "soon", to: null },
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

test("the later chains no longer list the two rollups and the BNB Smart Chain testnet, which the V3 light client is live on", () => {
  assert.deepEqual(LATER_CHAINS, ["OP Sepolia", "Polygon Amoy", "Avalanche Fuji"]);
  for (const d of ROLLUPS) assert.ok(!LATER_CHAINS.includes(d.full), d.full);
});

// ---------------------------------------------------------------------------------------------
// What each chain's sends and screens take of it

const README = readFileSync(join(repo, "README.md"), "utf8");
const bridgeOf = (key: DestKey): any => readJson(`deployments/${key}-bridge.json`);
const stepOf = (key: DestKey, kind: string, n: string): any => bridgeOf(key).steps.find((s: any) => s.kind === kind && (s.burn?.burnNonce === n || s.lock?.nonce === Number(n)));
/** Auto-mint's recorded result for a lock on a rollup: its mint's gas. */
const autoMintOf = (key: DestKey, lock: number): any =>
  readFileSync(join(repo, "deployments", `automint-${key}-0x57cc2ba3b883339a9f32726e6d0d3a9ee861a113.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .find((e) => e.kind === "result" && e.lock === String(lock) && e.outcome === "minted");

test("each chain's block time, L1 rule and fast confirmations: the release watcher's 3, 180 and 144, the same 36 s on each, and none on the BNB Smart Chain testnet, which has one speed", () => {
  assert.deepEqual(
    DESTS.map((d) => [d.key, d.blockSeconds, d.l1, d.fastConfirmations]),
    [
      ["sepolia", 12, "none", 3],
      ["base-sepolia", 0.2, "op", 180],
      ["arbitrum-sepolia", 0.25, "arbitrum", 144],
      ["bsc-testnet", 0.45, "none", null],
    ],
  );
  for (const d of DESTS.filter((x) => x.fastConfirmations !== null)) assert.equal(Math.round(fastConfirmationsOf(d) * d.blockSeconds), 36, d.full);
  // The watcher as it runs since Oct 28 (README, "the way back from Base Sepolia and Arbitrum Sepolia").
  assert.ok(README.includes("--confirmations sepolia=3,base-sepolia=180,arbitrum-sepolia=144 --send"));
  // The relayer's tools charge L1 the same way (relayer/src/l1.ts, L1_KIND).
  const l1 = readFileSync(join(repo, "relayer", "src", "l1.ts"), "utf8");
  for (const d of DESTS) assert.ok(l1.includes(`${d.key === "sepolia" ? "sepolia" : `"${d.key}"`}: "${d.l1}"`), d.key);
});

test("where each minter's logs start: its deployment block, as its bridge record has it", () => {
  for (const d of DESTS) {
    const deploy = bridgeOf(d.key).steps.find((s: any) => s.kind === "deploy" && s.name === "BridgeMinter");
    assert.equal(d.minterFrom, deploy.block, d.full);
    assert.equal(lower(deploy.address), d.minter, d.full);
  }
});

test("finality: Sepolia's as the watcher measured it, a rollup's its batch final on Sepolia, the blocks inside the range its finalized tag was measured at", () => {
  assert.deepEqual(destOf("sepolia").finality, { kind: "ethereum", seconds: SEPOLIA_FINALITY.median, blocks: SEPOLIA_FINALITY.blocks, range: SEPOLIA_FINALITY.range });
  // The rollups' is their batch final on Sepolia; the BNB Smart Chain testnet's is its validators' votes, as its entry has it (below).
  assert.deepEqual(
    ROLLUPS.map((d) => [d.key, d.finality.kind]),
    [
      ["base-sepolia", "batch"],
      ["arbitrum-sepolia", "batch"],
      ["bsc-testnet", "votes"],
    ],
  );
  const batch = ROLLUPS.filter((d) => d.finality.kind === "batch");
  // README, "Final, on a rollup": Base Sepolia's finalized block 5,800 to 6,700 of its 0.2 s blocks below its latest, Arbitrum Sepolia's 3,800 to 4,500 of its 0.25 s blocks.
  assert.match(README, /about 20 minutes after a block: Base Sepolia's finalized block was 5,800 to\s+6,700 of its 0\.2 s blocks below its latest, Arbitrum Sepolia's 3,800 to 4,500 of its 0\.25 s\s+blocks/);
  const measured: Record<string, readonly [number, number]> = { "base-sepolia": [5_800, 6_700], "arbitrum-sepolia": [3_800, 4_500] };
  for (const d of batch) {
    const [lo, hi] = measured[d.key] ?? [0, 0];
    assert.ok(d.finality.blocks >= lo && d.finality.blocks <= hi, `${d.full}: ${d.finality.blocks} blocks, measured ${lo} to ${hi}`);
    // The countdown's seconds are those blocks' time.
    assert.equal(d.finality.seconds, d.finality.blocks * d.blockSeconds, d.full);
  }
  assert.deepEqual(
    batch.map((d) => [d.key, d.finality.blocks, d.finality.seconds]),
    [
      ["base-sepolia", 6_000, 1_200],
      ["arbitrum-sepolia", 4_200, 1_050],
    ],
  );
});

test("the costs each card states are the chain's own recorded mint and burn", () => {
  const sep = destOf("sepolia");
  // Sepolia's, as the card always said: lock 1's mint (row 55) and burn 1 (row 56).
  assert.deepEqual([MINT_GAS, MINT_GAS_FULL, BURN_GAS, BURN_GAS_FULL], ["2.39", "2,391,069", "61", "61,434"]);
  assert.equal(sep.mintGas.full, Number(stepOf("sepolia", "mint", "1").gasUsed).toLocaleString("en-US"));
  assert.equal(sep.burnGas.full, Number(stepOf("sepolia", "burn", "1").gasUsed).toLocaleString("en-US"));
  // The rollups' and the BNB Smart Chain testnet's: auto-mint's first mint there (locks 4, 5 and 8, which bound the vault) and burn 0.
  for (const [key, lock] of [
    ["base-sepolia", 4],
    ["arbitrum-sepolia", 5],
    ["bsc-testnet", 8],
  ] as const) {
    const d = destOf(key);
    const mint = autoMintOf(key, lock);
    assert.ok(mint, `${key}: auto-mint minted lock ${lock}`);
    assert.equal(d.mintGas.full, mint.gasUsed.toLocaleString("en-US"), key);
    assert.equal(d.mintGas.gas, (Math.round(mint.gasUsed / 1e4) / 100).toFixed(2), key);
    // Burn 0 burned its sender's whole balance, whose refund lowered its gas used below what a burn
    // needs to run (README, "A burn on a rollup"): the card states what it needs, as Sepolia's 61 k.
    const burn = stepOf(key, "burn", "0");
    assert.equal(d.burnGas.used, Number(burn.gasUsed).toLocaleString("en-US"), key);
    assert.equal(d.burnGas.full, "62,517", key);
    assert.equal(d.burnGas.gas, "62", key);
    // Sent with eth_estimateGas's + 10%, the estimate of what it needs to run.
    assert.ok(Math.abs(Number(burn.gasLimit) - Math.round(62_517 * 1.1)) <= 1, `${key}: gas limit ${burn.gasLimit}`);
  }
  assert.match(README, /leaves the gas used\s+\(52,822\) below what the burn needs to run \(62,517\)/);
  // Base Sepolia's burn 0 paid its L1 data fee besides the gas; Arbitrum Sepolia's L1 gas was 0.
  assert.equal(stepOf("base-sepolia", "burn", "0").l1Fee, "666738");
  assert.match(destOf("base-sepolia").burnGas.note ?? "", /666,738 wei/);
  assert.equal(stepOf("arbitrum-sepolia", "burn", "0").gasUsedForL1, 0);
});

test("the ids a lock or a burn goes by: the vault's one count of locks, and each chain's own burns", () => {
  assert.deepEqual(refOf("lock-4"), { dir: "in", n: 4 });
  assert.deepEqual(refOf("burn-0"), { dir: "back", n: 0, dest: "sepolia" });
  assert.deepEqual(refOf("burn-base-sepolia-0"), { dir: "back", n: 0, dest: "base-sepolia" });
  assert.deepEqual(refOf("burn-arbitrum-sepolia-12"), { dir: "back", n: 12, dest: "arbitrum-sepolia" });
  // Sepolia's burns keep their bare number; a lock names no chain (its log does); no leading zeros, no other chain.
  for (const bad of ["burn-sepolia-0", "lock-base-sepolia-4", "lock-04", "burn-optimism-sepolia-0", "burn-base-sepolia-", "in-mh8k2q1x-1a2b3c", "replay-in"]) assert.equal(refOf(bad), null, bad);
  for (const d of DESTS) for (const n of [0, 1, 999_999_999]) assert.deepEqual(refOf(burnKey(d.key, n)), { dir: "back", n, dest: d.key });
  assert.equal(burnKey("sepolia", 1), "burn-1");
  assert.equal(burnKey("base-sepolia", 0), "burn-base-sepolia-0");
  assert.deepEqual(refOf(lockKey(5)), { dir: "in", n: 5 });
});

test("a lock names its destination by chain id and minter: the rollups' minters share an address, the chain id tells them apart", () => {
  const rollupMinter = "0xDC31a3BC1354545EeB985AaD7b2Aa662E9272348";
  assert.equal(destOfLock(84_532n, rollupMinter)?.key, "base-sepolia");
  assert.equal(destOfLock(421_614n, rollupMinter.toLowerCase())?.key, "arbitrum-sepolia");
  assert.equal(destOfLock("11155111", "0x8287b3baf205ca8456f98346f13064aa7fcdcb9e")?.key, "sepolia");
  // Another chain's minter, an unknown chain, a chain the app does not send to: no lock of ours to mint.
  assert.equal(destOfLock(11_155_111n, rollupMinter), null);
  assert.equal(destOfLock(84_532n, "0x8287b3baf205ca8456f98346f13064aa7fcdcb9e"), null);
  assert.equal(destOfLock(10n, rollupMinter), null);
  assert.equal(destOfLock(84_532n, rollupMinter, DESTS, new Set<DestKey>(["sepolia"])), null);
  assert.deepEqual(deployed(destOf("arbitrum-sepolia")), { minter: lower(rollupMinter), token: "0xe1130718c56de008b47c392c85895a1a605ba95e" });
});

test("each send goes out on its own chain: the lock on V3, the mint and the burn on the destination, as wagmi knows them", () => {
  for (const d of DESTS) {
    assert.equal(sendChain("lock", d.key), "v3");
    assert.equal(viemChain(sendChain("mint", d.key)).id, d.chainId, d.full);
    assert.equal(viemChain(sendChain("burn", d.key)).id, d.chainId, d.full);
  }
  assert.equal(viemChain("v3").id, 420_420_777);
  // The card's two sides, and the chain a wallet is on.
  assert.equal(fromOf("back", "arbitrum-sepolia").chainId, 421_614n);
  assert.equal(fromOf("back", "arbitrum-sepolia").token, "wtPOT");
  assert.equal(toOf("in", "base-sepolia").mark, "base");
  assert.equal(toOf("back", "base-sepolia"), CH.v3);
  assert.equal(chainById(84_532n)?.full, "Base Sepolia");
  assert.equal(chainById(420_420_777n)?.key, "v3");
  assert.equal(chainById(1n), null);
});

test("each destination's explorer links its transactions and blocks", () => {
  const h = `0x${"ab".repeat(32)}`;
  assert.equal(explorerTx(destOf("base-sepolia"), h), `https://sepolia.basescan.org/tx/${h}`);
  assert.equal(explorerBlock(destOf("arbitrum-sepolia"), 323_549_062), "https://sepolia.arbiscan.io/block/323549062");
  assert.equal(explorerTx(destOf("sepolia"), h), `https://sepolia.etherscan.io/tx/${h}`);
});

test("the times the card states: Sepolia's as measured, unchanged; each other chain's as measured where it ran, on Oct 28 on the rollups and on Nov 1 on the BNB Smart Chain testnet, and an estimate said so where it did not", () => {
  assert.deepEqual(timeOf("sepolia", "in"), TIME.in);
  assert.deepEqual(timeOf("sepolia", "fast"), ["≈ 84 s", "measured Oct 24"]);
  assert.deepEqual(timeOf("sepolia", "std"), ["≈ 17 min", "est., with the watcher"]);
  assert.deepEqual(timeOf("sepolia", "auto"), AUTO_TIME);
  // Auto-mint: each chain's own run, 139 s and 133 s on the rollups and 125 s on the BNB Smart Chain testnet from the lock's V3 block, with the lock's own block (about 6 s), as Sepolia's 144 s is.
  assert.deepEqual(timeOf("base-sepolia", "auto"), ["≈ 2½ min", "auto-mint, measured Oct 28"]);
  assert.deepEqual(timeOf("arbitrum-sepolia", "auto"), ["≈ 2¼ min", "auto-mint, measured Oct 28"]);
  assert.deepEqual(timeOf("bsc-testnet", "auto"), ["≈ 2¼ min", "auto-mint, measured Nov 1"]);
  assert.equal(aboutMinutes(144 + 6), AUTO_TIME[0], "the same rounding gives Sepolia's");
  // Fast: Arbitrum Sepolia's burn 1, 105 s; Base Sepolia's burn 1 waited for the fast budget, so its time is Arbitrum Sepolia's, said to be.
  assert.deepEqual(timeOf("arbitrum-sepolia", "fast"), ["≈ 105 s", "measured Oct 28"]);
  assert.deepEqual(timeOf("base-sepolia", "fast"), ["≈ 105 s", "est., as measured on Arbitrum Sepolia"]);
  // No chain but Sepolia has timed a mint sent by its locker.
  for (const d of ROLLUPS) assert.match(timeOf(d.key, "in")[1], /^as measured on Sepolia/, d.key);
  // Nor a rollup a release after finality; the BNB Smart Chain testnet has, burn 0's 46 s.
  for (const key of ["base-sepolia", "arbitrum-sepolia"] as const) assert.match(timeOf(key, "std")[1], /^est\./, key);
  assert.deepEqual(timeOf("bsc-testnet", "std"), ["≈ 46 s", "measured Nov 1"]);
  // Standard: the chain's own finality, then about a minute of the watcher's round and the approvals.
  assert.equal(timeOf("base-sepolia", "std")[0], "≈ 21 min");
  assert.equal(timeOf("arbitrum-sepolia", "std")[0], "≈ 19 min");
  // The strip under the card states auto-mint's time as the card does, from timeOf: each rollup's own run, not Sepolia's of Oct 27.
  const bridge = readFileSync(join(here, "..", "src", "app", "views", "Bridge.tsx"), "utf8");
  const from = bridge.indexOf("function ProofStrip(");
  const to = bridge.indexOf("function ChainButton(");
  assert.ok(from > 0 && to > from, "Bridge.tsx's ProofStrip");
  const strip = bridge.slice(from, to);
  assert.ok(strip.includes('timeOf(d.key, "auto")'), "the strip reads auto-mint's time from timeOf");
  assert.ok(!strip.includes("2½") && !strip.includes("as measured on Sepolia, Oct 27"), "no time of Sepolia's run stands for a rollup's");
});

test("the rollups' runs are the README's: lock 6 and lock 7 minted 139 s and 133 s after their V3 blocks, Arbitrum Sepolia's burn 1 released 105 s after its block", () => {
  const readme = readFileSync(join(repo, "README.md"), "utf8").replace(/\s+/g, " ");
  const app = readme.slice(readme.indexOf("### The app: the first transfers from the owner's own wallet"));
  assert.ok(app.length > 0 && app.length < readme.length, "the README's section on the app's first transfers");
  const run = (re: RegExp) => Number(re.exec(app)?.[1]);
  assert.equal(run(/lock 6's V3 block is stamped \d\d:\d\d:\d\d and its mint's Base Sepolia block \d\d:\d\d:\d\d, (\d+) seconds/), ROLLUP_RUNS["base-sepolia"].auto);
  assert.equal(run(/lock 7's V3 block \d\d:\d\d:\d\d and its mint's Arbitrum Sepolia block \d\d:\d\d:\d\d, (\d+) seconds/), ROLLUP_RUNS["arbitrum-sepolia"].auto);
  assert.equal(run(/\| \*\*123\*\* \|[^|]*; (\d+) seconds after the burn's block\*\* \|/), ROLLUP_RUNS["arbitrum-sepolia"].fast);
  // Base Sepolia's burn 1 waited for the fast budget: its 905 s are not a chain's time.
  assert.match(app, /From Base Sepolia it took 905 seconds, .* because the fast budget was full/);
  assert.equal(ROLLUP_RUNS["base-sepolia"].fast, null);
});

test("the fast budget: before a burn that goes Fast is signed, one line that it is shared; on the transfer screen, why a fast burn waits past Fast's usual time", () => {
  assert.equal(FAST_BUDGET_LINE, "Fast mode shares one 1 tPOT budget across all chains: while another fast release is in flight, your burn can wait for finality.");
  const arb = destOf("arbitrum-sepolia");
  const t0 = 1_793_186_433_000;
  const waiting = { qualifiedAt: t0, final: false, approvals: 0, released: false };
  // Within Fast's usual time and the watcher's rounds: nothing to say.
  assert.equal(fastWait(arb, waiting, t0 + SLOW_RELEASE_MS), null);
  const late = fastWait(arb, waiting, t0 + SLOW_RELEASE_MS + 1);
  // Its times keep to one line: no-break spaces inside "≈ 105 s" and "≈ 19 min".
  assert.equal(
    late?.replace(/\u00a0/g, " "),
    "Fast usually takes ≈ 105 s. Fast mode shares one 1 tPOT budget across all chains: while another fast release holds it, your burn waits until that release's burn is final, or yours is (≈ 19 min, as Standard). Releases also wait while the committee's watcher, on one machine, is off.",
  );
  assert.ok(late?.includes("≈\u00a019\u00a0min") && late.includes("≈\u00a0105\u00a0s"));
  // A burn read from the chains, whose approvals the page does not read, is said the same way.
  assert.equal(fastWait(arb, { ...waiting, approvals: null }, t0 + 10 * 60_000), late);
  assert.match(fastWait(destOf("sepolia"), waiting, t0 + 10 * 60_000)?.replace(/\u00a0/g, " ") ?? "", /^Fast usually takes ≈ 84 s\. .* \(≈ 17 min, as Standard\)\./);
  // Base Sepolia's Fast is Arbitrum Sepolia's run, which its card calls an estimate: so does the note.
  assert.match(fastWait(destOf("base-sepolia"), waiting, t0 + 10 * 60_000)?.replace(/\u00a0/g, " ") ?? "", /^Fast usually takes ≈ 105 s \(est\.\)\. .* \(≈ 21 min, as Standard\)\./);
  // Not late: released, a member has approved, not qualified yet, or final on its chain, where the budget no longer holds it.
  for (const done of [{ released: true }, { approvals: 1 }, { qualifiedAt: null }, { final: true }]) assert.equal(fastWait(arb, { ...waiting, ...done }, t0 + 10 * 60_000), null, JSON.stringify(done));
});

// ---------------------------------------------------------------------------------------------
// The BNB Smart Chain testnet: shown since its first round trip on Nov 1, and the flag that hid it until then

const BSC = destOf("bsc-testnet", ALL_DESTS);
const ROLLUP_MINTER: Hex = "0xdc31a3bc1354545eeb985aad7b2aa662e9272348";
const ROLLUP_TOKEN: Hex = "0xe1130718c56de008b47c392c85895a1a605ba95e";
/** HIDDEN as it stood until the first round trip, holding chain 97: the destinations it left shown, and their sends (dests.ts SENDS_ALL less the hidden one). */
const HID: ReadonlySet<DestKey> = new Set<DestKey>(["bsc-testnet"]);
const BEFORE = shown(ALL_DESTS, HID);
const BEFORE_SENDS: ReadonlySet<DestKey> = new Set<DestKey>(["sepolia", "base-sepolia", "arbitrum-sepolia"]);

test("the BNB Smart Chain testnet is shown since Nov 1: in DESTS, both pickers, wagmi's chains, the transports and the CSP; HIDDEN keeps a destination it holds out of them all", () => {
  assert.deepEqual(
    ALL_DESTS.map((d) => d.key),
    ["sepolia", "base-sepolia", "arbitrum-sepolia", "bsc-testnet"],
  );
  assert.deepEqual([...HIDDEN], []);
  assert.deepEqual(
    DESTS.map((d) => d.key),
    ["sepolia", "base-sepolia", "arbitrum-sepolia", "bsc-testnet"],
  );
  assert.equal(destOf("bsc-testnet"), BSC);
  // Its sends are wired (dests.ts SENDS_ALL), and in SENDS since HIDDEN no longer holds it: a deep link picks it too.
  assert.ok(SENDS.has("bsc-testnet"));
  assert.match(readFileSync(join(here, "..", "src", "app", "dests.ts"), "utf8"), /const SENDS_ALL: readonly DestKey\[\] = \["sepolia", "base-sepolia", "arbitrum-sepolia", "bsc-testnet"\];/);
  for (const side of ["from", "to"] as const) for (const dir of ["in", "back"] as const) assert.equal(pickRows(side, dir, "sepolia").find((r) => r.key === "bsc-testnet")?.state, "open", `${side} ${dir}`);
  assert.deepEqual(
    WALLET_CHAINS.map((c) => c.id),
    [420420777, 11155111, 84532, 421614, 97],
  );
  assert.ok(Object.keys(transports).map(Number).includes(97));
  for (const e of BSC.rpcs) {
    assert.ok(ROLLUP_NODES.includes(e.url), e.url);
    assert.ok(cspPolicy(true).includes(new URL(e.url).host), e.url);
  }
  assert.equal(destByChainId(97), BSC);
  assert.deepEqual(refOf("burn-bsc-testnet-0"), { dir: "back", n: 0, dest: "bsc-testnet" }, "the route to its burn");
  assert.equal(destOfLock(97n, ROLLUP_MINTER), BSC);
  assert.deepEqual(OTHER_CHAINS, ["two rollups", "the BNB Smart Chain testnet"]);
  assert.equal(DESTS_WORD, "four");
  assert.equal(DESTS_NAMED, "Sepolia, the two rollups and the BNB Smart Chain testnet");
  // HIDDEN as it held chain 97 before its first round trip: the three shown, no picker row, route or lock of it, and the words of the three.
  assert.deepEqual(
    BEFORE.map((d) => d.key),
    ["sepolia", "base-sepolia", "arbitrum-sepolia"],
  );
  assert.throws(() => destOf("bsc-testnet", BEFORE), /no destination bsc-testnet/);
  for (const side of ["from", "to"] as const) for (const dir of ["in", "back"] as const) assert.ok(pickRows(side, dir, "sepolia", BEFORE, BEFORE_SENDS).every((r) => r.key !== "bsc-testnet"), `${side} ${dir}`);
  assert.equal(destByChainId(97, BEFORE), null);
  assert.equal(refOf("burn-bsc-testnet-0", BEFORE), null, "no route to a hidden chain's burn");
  assert.equal(destOfLock(97n, ROLLUP_MINTER, BEFORE, BEFORE_SENDS), null);
  assert.deepEqual(otherChainsOf(BEFORE), ["two rollups"]);
  assert.equal(countWord(BEFORE.length), "three");
  assert.equal(destsNamedOf(BEFORE), "Sepolia and the two rollups");
  // wagmi's chains, the transports and the CSP take DESTS' chains and RPCs: a destination HIDDEN holds is in none of them.
  assert.deepEqual(
    WALLET_CHAINS.map((c) => c.id),
    [v3.id, ...DESTS.map((d) => d.chainId)],
  );
  assert.deepEqual(Object.keys(transports).map(Number).sort((a, b) => a - b), [v3.id, ...DESTS.map((d) => d.chainId)].sort((a, b) => a - b));
  assert.deepEqual(ROLLUP_NODES, rollupsOf(DESTS).flatMap((d) => d.rpcs.map((e) => e.url)));
  // A build never previews it: no import.meta.env outside vite's dev server, and in it only VITE_PREVIEW_DESTS names it.
  assert.deepEqual(
    shown(ALL_DESTS, HID, new Set(["bsc-testnet"])).map((d) => d.key),
    ["sepolia", "base-sepolia", "arbitrum-sepolia", "bsc-testnet"],
  );
  assert.deepEqual(shown(ALL_DESTS, HIDDEN).map((d) => d.key), DESTS.map((d) => d.key));
});

test("its entry: chain 97 as viem knows it, its names, the text mark, BscScan, the RPCs of Nov 1, fast finality and one speed, the 0.1 gwei tip, its records' addresses and its first round trip", () => {
  assert.deepEqual([BSC.chainId, BSC.name, BSC.sub, BSC.full, BSC.short, BSC.mark], [97, "BNB Smart Chain", "testnet", "BNB Smart Chain testnet", "BSC testnet", "bnb"]);
  assert.equal(viemBscTestnet.id, 97);
  assert.equal(bscTestnet.id, 97);
  assert.deepEqual(bscTestnet.rpcUrls.default.http, BSC.rpcs.map((e) => e.url));
  assert.equal(BSC.explorer.url, "https://testnet.bscscan.com");
  assert.equal(BSC.explorer.url, viemBscTestnet.blockExplorers.default.url);
  assert.equal(viemChain("bsc-testnet").id, 97);
  // publicnode, the only public RPC that serves its logs, first; the official endpoint keeps receipts and serves no logs.
  assert.deepEqual(
    BSC.rpcs.map((e) => [e.url, e.batch, e.logRange]),
    [
      ["https://bsc-testnet-rpc.publicnode.com", 8, 50_000],
      ["https://bsc-testnet.bnbchain.org", 8, 0],
    ],
  );
  assert.deepEqual([BSC.blockSeconds, BSC.l1, BSC.fastConfirmations, BSC.minTip, BSC.firsts], [0.45, "none", null, 100_000_000n, { lock: 8, burn: 0 }]);
  assert.deepEqual(BSC.finality, { kind: "votes", seconds: 1, blocks: 2, range: "0.9 to 1.4 s" });
  assert.equal(fastConfirmationsOf(BSC), 0);
  // The relayer's tools have the same rules (relayer/src/l1.ts, wayback.ts).
  assert.ok(readFileSync(join(repo, "relayer", "src", "l1.ts"), "utf8").includes(`"bsc-testnet": "none"`));
  assert.match(readFileSync(join(repo, "relayer", "src", "wayback.ts"), "utf8"), /network: "bsc-testnet",[\s\S]*?blockSeconds: 0\.45,/);
  // Its first round trip as measured (facts.ts, ROLLUP_RUNS; README rows 145 to 149): auto-mint minted lock 8 125 s after the lock's V3 block, and the watcher released burn 0 46 s after the burn's block, at its finality; one speed, no fast run.
  assert.deepEqual(ROLLUP_RUNS["bsc-testnet"], { auto: 125, fast: null, std: 46, on: "Nov 1" });
  const section = README.replace(/\s+/g, " ").split("### More chains: the BNB Smart Chain testnet")[1] ?? "";
  assert.ok(section.length > 0, "the README's section on the BNB Smart Chain testnet");
  assert.equal(Number(/The mint's block came (\d+) seconds after the lock's by the block timestamps/.exec(section)?.[1]), ROLLUP_RUNS["bsc-testnet"].auto);
  assert.equal(Number(/the release's block came (\d+) seconds after the burn's/.exec(section)?.[1]), ROLLUP_RUNS["bsc-testnet"].std);
  assert.deepEqual(timeOf("bsc-testnet", "auto"), ["≈ 2¼ min", "auto-mint, measured Nov 1"]);
  assert.deepEqual(timeOf("bsc-testnet", "std"), ["≈ 46 s", "measured Nov 1"]);
  assert.deepEqual(timeOf("bsc-testnet", "in"), ["≈ 48 s", "as measured on Sepolia, Oct 20"]);
  // The strip under the card names the day of each chain's own run (facts.ts, runDayOf): Sepolia's Oct 27, the rollups' Oct 28, its Nov 1.
  assert.match(readFileSync(join(here, "..", "src", "app", "views", "Bridge.tsx"), "utf8"), /`lock to mint, sent by auto-mint · \$\{autoEst \?\? `measured on \$\{d\.short\}, \$\{runDayOf\(d\.key\)\}`\}`/);
  assert.deepEqual(
    DESTS.map((d) => runDayOf(d.key)),
    ["Oct 27", "Oct 28", "Oct 28", "Nov 1"],
  );
  // Its costs from its first round trip's receipts, lock 8's mint and burn 0 (README rows 146 and 147), the rollups' gas schedule: the records check them with the rollups' (above).
  assert.deepEqual([BSC.mintGas.gas, BSC.mintGas.full, BSC.burnGas.gas, BSC.burnGas.used], ["2.66", "2,658,627", "62", "52,822"]);
  // Deployed on Nov 1 at the rollups' addresses: every address is its records', and its minter's logs start at BridgeMinter's deployment block.
  const lc = readJson("deployments/bsc-testnet.json");
  assert.equal(lc.chainId, 97);
  assert.equal(BSC.lightClient, lower(lc.contracts["GrandpaLightClient #2"]));
  assert.equal(BSC.provenBalance, lower(lc.contracts["ProvenBalance #2"]));
  const b = readJson("deployments/bsc-testnet-bridge.json");
  assert.equal(b.chainId, 97);
  assert.equal(BSC.minter, lower(b.contracts.BridgeMinter));
  assert.equal(BSC.token, lower(b.contracts.WrappedTPOT));
  assert.equal(BSC.minterFrom, b.steps.find((s: any) => s.kind === "deploy" && s.name === "BridgeMinter").block);
  assert.deepEqual(
    [BSC.lightClient, BSC.provenBalance, BSC.minter, BSC.token, BSC.minterFrom],
    [destOf("base-sepolia").lightClient, destOf("base-sepolia").provenBalance, ROLLUP_MINTER, ROLLUP_TOKEN, 140_162_374],
  );
  assert.equal(destState(BSC), "live");
  assert.equal(selectable(BSC), true);
  assert.deepEqual(clientOf(BSC), { lightClient: lower(lc.contracts["GrandpaLightClient #2"]), provenBalance: lower(lc.contracts["ProvenBalance #2"]) });
  assert.deepEqual(deployed(BSC), { minter: ROLLUP_MINTER, token: ROLLUP_TOKEN });
  // Its firsts, as the records have them: lock 8, the first lock to chain 97, and burn 0 there, released on V3.
  const v3Record = readJson("deployments/v3-testnet.json");
  assert.equal(Math.min(...v3Record.locks.filter((l: any) => l.dstChainId === "97" && l.status === "locked").map((l: any) => Number(l.vaultNonce))), BSC.firsts?.lock);
  assert.equal(stepOf("bsc-testnet", "burn", String(BSC.firsts?.burn))?.burn.burnId, "0xf38d1b6cd1e6d5a6fbe5b1f8238646147194891702fd9e164d9b6ad450454773");
  assert.equal(v3Record.releases.find((r: any) => r.burn?.chainId === "97" && r.burn.burnNonce === String(BSC.firsts?.burn))?.status, "released");
});

test("the gas each chain's words name: Sepolia ETH and each rollup's ETH as before, tBNB on the BNB Smart Chain testnet, where a visitor gets it, and auto-mint's chains", () => {
  const three = ALL_DESTS.filter((d) => d.key !== "bsc-testnet");
  // The three as the card, the review and the transfer screen have always said them: "in Base Sepolia ETH", "0.002 ETH".
  assert.deepEqual(
    three.map((d) => [d.key, d.gas.token, d.gas.name]),
    [
      ["sepolia", "ETH", "Sepolia ETH"],
      ["base-sepolia", "ETH", "Base Sepolia ETH"],
      ["arbitrum-sepolia", "ETH", "Arbitrum Sepolia ETH"],
    ],
  );
  for (const d of three) assert.equal(d.gas.name, `${d.short} ETH`, d.key);
  assert.deepEqual(BSC.gas, { token: "tBNB", name: "tBNB" });
  // The symbol a wallet shows for each, as viem gives it to a wallet that adds the chain.
  for (const [d, v] of [
    [destOf("sepolia"), viemSepolia],
    [destOf("base-sepolia"), viemBaseSepolia],
    [destOf("arbitrum-sepolia"), viemArbitrumSepolia],
    [BSC, viemBscTestnet],
  ] as const) {
    assert.equal(d.gas.token, v.nativeCurrency.symbol, d.key);
  }
  // A rollup's ETH comes through its own bridge from Sepolia, as before; tBNB from its faucets, with no bridge from Sepolia.
  assert.equal(gasFrom(destOf("base-sepolia")), "Base Sepolia's own bridge takes Sepolia ETH there, and its public faucets give some");
  assert.equal(gasFrom(destOf("arbitrum-sepolia")), "Arbitrum Sepolia's own bridge takes Sepolia ETH there, and its public faucets give some");
  assert.equal(gasFrom(BSC), "BSC testnet's public faucets give tBNB");
  // Auto-mint is one process for the chains shown: the four since the activation showed chain 97, the three before it.
  assert.equal(destsNamedOf(three), "Sepolia and the two rollups");
  assert.equal(DESTS_NAMED, destsNamedOf(DESTS));
  assert.deepEqual(otherChainsOf(DESTS), ["two rollups", "the BNB Smart Chain testnet"]);
  assert.equal(destsNamedOf(DESTS), "Sepolia, the two rollups and the BNB Smart Chain testnet");
  assert.equal(andList(["V3", "Sepolia", ...otherChainsOf(DESTS)]), "V3, Sepolia, two rollups and the BNB Smart Chain testnet");
  assert.deepEqual([andList([]), andList(["V3"]), andList(["V3", "Sepolia"])], ["", "V3", "V3 and Sepolia"]);
});

test("one speed on the BNB Smart Chain testnet: its burns never fast on the transfer screen, and no Fast option nor fast release on the card there", () => {
  // transfers.ts watcherSpeed: Fast up to the cap where the destination has fast confirmations; a call without one would take every chain's as fast.
  const transfers = readFileSync(join(here, "..", "src", "app", "transfers.ts"), "utf8");
  assert.match(transfers, /export const watcherSpeed = \(amount: bigint, d\?: Dest\): Speed => \(toTokens\(amount\) <= FAST_CAP && d\?\.fastConfirmations !== null \? "fast" : "std"\);/);
  const tx = readFileSync(join(here, "..", "src", "app", "views", "Tx.tsx"), "utf8");
  assert.match(tx, /mode: x\.dir === "in" \? "in" : watcherSpeed\(x\.amount, d\),/);
  assert.match(tx, /const fast = watcherSpeed\(x\.amount, d\) === "fast";/);
  for (const src of [tx, readFileSync(join(here, "..", "src", "app", "sends.ts"), "utf8")]) assert.doesNotMatch(src, /watcherSpeed\([^,()]+\)/, "every call names the destination");
  const bridge = readFileSync(join(here, "..", "src", "app", "views", "Bridge.tsx"), "utf8");
  assert.match(bridge, /const oneSpeed = d\.fastConfirmations === null;/);
  assert.match(bridge, /\{oneSpeed \? null : \(\s*<button[^>]*?id="opt-fast"/);
  assert.match(bridge, /<p class="speed__fix" hidden=\{k\.fastOK \|\| dir !== "back" \|\| oneSpeed\}>/);
  assert.match(bridge, /\{oneSpeed \? \(\s*<>The release is trusted\. One speed on \{d\.short\}: the watcher releases a burn of any amount after \{words\.final\}\.<\/>/);
  assert.match(bridge, /releases · \{d\.fastConfirmations === null \? timeOf\(d\.key, "std"\)\[0\] : `fast \$\{timeOf\(d\.key, "fast"\)\[0\]\}`\}/);
  // Nor the fast budget's line under the speed tiles (facts.ts, FAST_BUDGET_LINE): no burn there goes Fast.
  assert.match(bridge, /<p class="speed__note" hidden=\{!k\.fastOK \|\| dir !== "back" \|\| oneSpeed\}>\s*\{FAST_BUDGET_LINE\}/);
  assert.equal(destOf("bsc-testnet", ALL_DESTS).fastConfirmations, null);
  // The three as before: Fast up to 1 tPOT on each.
  for (const key of ["sepolia", "base-sepolia", "arbitrum-sepolia"] as const) assert.notEqual(destOf(key).fastConfirmations, null, key);
});

test("as shown since Nov 1: picked on either side, its lock told from the rollups' by chain id 97, its burns' ids", () => {
  const rows = pickRows("to", "in", "sepolia");
  assert.deepEqual(rows.find((r) => r.key === "bsc-testnet"), { key: "bsc-testnet", state: "open", to: { dir: "in", dest: "bsc-testnet" } });
  assert.deepEqual(pickRows("from", "back", "bsc-testnet").find((r) => r.key === "bsc-testnet"), { key: "bsc-testnet", state: "current", to: null });
  // With sends that lack it, as while HIDDEN held it, its row would be listed and not pickable: deployed, not sent to.
  assert.equal(pickRows("to", "in", "sepolia", DESTS, BEFORE_SENDS).find((r) => r.key === "bsc-testnet")?.state, "soon");
  assert.equal(destState(BSC, BEFORE_SENDS), "ready");
  assert.equal(selectable(BSC, BEFORE_SENDS), false);
  // One minter address on three chains: the chain id tells them apart.
  assert.equal(destOfLock(97n, ROLLUP_MINTER)?.key, "bsc-testnet");
  assert.equal(destOfLock(84_532n, ROLLUP_MINTER)?.key, "base-sepolia");
  assert.equal(destOfLock(421_614n, ROLLUP_MINTER)?.key, "arbitrum-sepolia");
  assert.equal(destOfLock(97n, "0x8287b3baf205ca8456f98346f13064aa7fcdcb9e"), null);
  assert.equal(burnKey("bsc-testnet", 0), "burn-bsc-testnet-0");
  assert.deepEqual(refOf("burn-bsc-testnet-0"), { dir: "back", n: 0, dest: "bsc-testnet" });
  assert.deepEqual(refOf(burnKey("bsc-testnet", 12)), { dir: "back", n: 12, dest: "bsc-testnet" });
  assert.deepEqual(
    rollupsOf(DESTS).map((d) => d.key),
    ["base-sepolia", "arbitrum-sepolia", "bsc-testnet"],
  );
  assert.deepEqual(deployed(destOf("bsc-testnet")), { minter: ROLLUP_MINTER, token: ROLLUP_TOKEN });
  assert.equal(explorerTx(destOf("bsc-testnet"), `0x${"ab".repeat(32)}`), `https://testnet.bscscan.com/tx/0x${"ab".repeat(32)}`);
});

test("its mark is a text mark, BNB, with no image shipped or listed: BNB Chain asks for approval before its logo is used", () => {
  const marks = readFileSync(join(here, "..", "src", "app", "marks.tsx"), "utf8");
  assert.match(marks, /bnb: "BNB"/);
  assert.doesNotMatch(marks, /import \w+ from "\.\/marks\/bnb/i);
  assert.ok(!existsSync(join(here, "..", "src", "app", "marks", "bnb.svg")) && !existsSync(join(here, "..", "src", "app", "marks", "bnb.png")));
  assert.doesNotMatch(readFileSync(join(repo, "NOTICE.md"), "utf8"), /BNB/);
  assert.match(readFileSync(join(here, "..", "src", "app", "styles", "v3.css"), "utf8"), /\.mark\[data-mark="bnb"\] \.mark__letter text \{/);
});
