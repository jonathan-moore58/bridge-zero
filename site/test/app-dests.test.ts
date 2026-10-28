// The destinations' one config (src/app/dests.ts): every address against deployments/, the chain ids
// against viem's, the RPCs against the Content-Security-Policy (build/csp.ts), what each chain's sends
// and screens take of it (its block time, its L1 rule, where its minter's logs start, its fast
// confirmations, its finality and its costs) against the records and the relayer's rules, the ids a
// lock or a burn goes by on each, the chain each send goes out on, and the chain picker's rows:
// Sepolia, Base Sepolia and Arbitrum Sepolia live and pickable, and a destination pickable only
// once the app sends to it (SENDS). Offline.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { getContractAddress } from "viem";
import { arbitrumSepolia as viemArbitrumSepolia, baseSepolia as viemBaseSepolia, sepolia as viemSepolia } from "viem/chains";
import { BRIDGE_NODES, ROLLUP_NODES, connectOf, cspPolicy } from "../build/csp.ts";
import { arbitrumSepolia, baseSepolia, sepolia, transports, v3, viemChain } from "../src/app/chains.ts";
import {
  DESTS,
  ROLLUPS,
  SENDS,
  burnKey,
  deployed,
  destByChainId,
  destOf,
  destOfLock,
  destState,
  explorerBlock,
  explorerTx,
  lockKey,
  pickRows,
  refOf,
  selectable,
  type Dest,
  type DestKey,
} from "../src/app/dests.ts";
import { AUTO_TIME, BURN_GAS, BURN_GAS_FULL, CH, LATER_CHAINS, MINT_GAS, MINT_GAS_FULL, SEPOLIA_FINALITY, TIME, chainById, fromOf, sendChain, timeOf, toOf } from "../src/app/facts.ts";
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

test("the app sends to all three since Oct 28: Sepolia, Base Sepolia and Arbitrum Sepolia are live and pickable", () => {
  assert.deepEqual(
    DESTS.map((d) => [d.key, destState(d), selectable(d)]),
    [
      ["sepolia", "live", true],
      ["base-sepolia", "live", true],
      ["arbitrum-sepolia", "live", true],
    ],
  );
  // Each with its own minter and wtPOT, balance read, recipient, token mark, costs and strip.
  assert.deepEqual([...SENDS], ["sepolia", "base-sepolia", "arbitrum-sepolia"]);
});

test("Receive on, the way in: V3 turns the card round, Sepolia is the current one, and either rollup can be picked", () => {
  assert.deepEqual(pickRows("to", "in", "sepolia"), [
    { key: "v3", state: "open", to: { dir: "back", dest: "sepolia" } },
    { key: "sepolia", state: "current", to: null },
    { key: "base-sepolia", state: "open", to: { dir: "in", dest: "base-sepolia" } },
    { key: "arbitrum-sepolia", state: "open", to: { dir: "in", dest: "arbitrum-sepolia" } },
  ]);
  // With Base Sepolia chosen, it is the current one and Sepolia can be picked back.
  assert.deepEqual(pickRows("to", "in", "base-sepolia").slice(1), [
    { key: "sepolia", state: "open", to: { dir: "in", dest: "sepolia" } },
    { key: "base-sepolia", state: "current", to: null },
    { key: "arbitrum-sepolia", state: "open", to: { dir: "in", dest: "arbitrum-sepolia" } },
  ]);
});

test("Send from, the way in: V3 is the current one; a destination turns the card round, sent from that chain", () => {
  assert.deepEqual(pickRows("from", "in", "sepolia"), [
    { key: "v3", state: "current", to: null },
    { key: "sepolia", state: "open", to: { dir: "back", dest: "sepolia" } },
    { key: "base-sepolia", state: "open", to: { dir: "back", dest: "base-sepolia" } },
    { key: "arbitrum-sepolia", state: "open", to: { dir: "back", dest: "arbitrum-sepolia" } },
  ]);
  // The way back from Arbitrum Sepolia: it is the current one, and V3 is received on.
  assert.deepEqual(pickRows("from", "back", "arbitrum-sepolia"), [
    { key: "v3", state: "open", to: { dir: "in", dest: "arbitrum-sepolia" } },
    { key: "sepolia", state: "open", to: { dir: "back", dest: "sepolia" } },
    { key: "base-sepolia", state: "open", to: { dir: "back", dest: "base-sepolia" } },
    { key: "arbitrum-sepolia", state: "current", to: null },
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

test("each chain's block time, L1 rule and fast confirmations: the release watcher's 3, 180 and 144, the same 36 s on each", () => {
  assert.deepEqual(
    DESTS.map((d) => [d.key, d.blockSeconds, d.l1, d.fastConfirmations]),
    [
      ["sepolia", 12, "none", 3],
      ["base-sepolia", 0.2, "op", 180],
      ["arbitrum-sepolia", 0.25, "arbitrum", 144],
    ],
  );
  for (const d of DESTS) assert.equal(Math.round(d.fastConfirmations * d.blockSeconds), 36, d.full);
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
  assert.deepEqual(destOf("sepolia").finality, { seconds: SEPOLIA_FINALITY.median, blocks: SEPOLIA_FINALITY.blocks, range: SEPOLIA_FINALITY.range });
  // README, "Final, on a rollup": Base Sepolia's finalized block 5,800 to 6,700 of its 0.2 s blocks below its latest, Arbitrum Sepolia's 3,800 to 4,500 of its 0.25 s blocks.
  assert.match(README, /about 20 minutes after a block: Base Sepolia's finalized block was 5,800 to\s+6,700 of its 0\.2 s blocks below its latest, Arbitrum Sepolia's 3,800 to 4,500 of its 0\.25 s\s+blocks/);
  const measured: Record<string, readonly [number, number]> = { "base-sepolia": [5_800, 6_700], "arbitrum-sepolia": [3_800, 4_500] };
  for (const d of ROLLUPS) {
    const [lo, hi] = measured[d.key] ?? [0, 0];
    assert.ok(d.finality.blocks >= lo && d.finality.blocks <= hi, `${d.full}: ${d.finality.blocks} blocks, measured ${lo} to ${hi}`);
    // The countdown's seconds are those blocks' time.
    assert.equal(d.finality.seconds, d.finality.blocks * d.blockSeconds, d.full);
  }
  assert.deepEqual(
    ROLLUPS.map((d) => [d.key, d.finality.blocks, d.finality.seconds]),
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
  // The rollups': auto-mint's first mint there (locks 4 and 5, which bound the vault) and burn 0.
  for (const [key, lock] of [
    ["base-sepolia", 4],
    ["arbitrum-sepolia", 5],
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

test("the times the card states: Sepolia's as measured, unchanged; a rollup's as estimated, and said so", () => {
  assert.deepEqual(timeOf("sepolia", "in"), TIME.in);
  assert.deepEqual(timeOf("sepolia", "fast"), ["≈ 84 s", "measured Oct 24"]);
  assert.deepEqual(timeOf("sepolia", "std"), ["≈ 17 min", "est., with the watcher"]);
  assert.deepEqual(timeOf("sepolia", "auto"), AUTO_TIME);
  for (const d of ROLLUPS) {
    for (const mode of ["in", "auto", "fast", "std"] as const) assert.match(timeOf(d.key, mode)[1], /^(est\.|as measured on Sepolia)/, `${d.key} ${mode}`);
    assert.equal(timeOf(d.key, "auto")[0], AUTO_TIME[0]);
  }
  // Standard: the chain's own finality, then about a minute of the watcher's round and the approvals.
  assert.equal(timeOf("base-sepolia", "std")[0], "≈ 21 min");
  assert.equal(timeOf("arbitrum-sepolia", "std")[0], "≈ 19 min");
});
