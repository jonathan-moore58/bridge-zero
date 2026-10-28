// Unit tests of the way back from each chain (wayback.ts and the watcher's round across chains),
// offline: Sepolia's rule and words as before; Base Sepolia's and Arbitrum Sepolia's finality,
// confirmations and records; --network and --confirmations for one chain or several; each chain's
// burns, releases and burn cache kept apart, though the rollups' minters share one address; one fast
// budget across every chain; and the two burns recorded on the rollups, whose ids follow the vault's
// convention with each chain's id. Nothing is read from a chain.
//
//   npm test

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { NETWORKS, type NetworkName } from "../../contracts/script/lib/sepolia.mjs";
import { bytesToHex, hexToBytes } from "./bytes.js";
import { payeeVerdict } from "./committee.js";
import { burnId } from "./vault.js";
import {
  burnCacheName,
  burnLabel,
  burnOn,
  chainIdOf,
  confirmationsBy,
  fastExposure,
  fastReleasesOf,
  otherFastChains,
  parseConfirmationsOn,
  parseNetwork,
  parseNetworks,
  prunedState,
  rulesBy,
  sendConfirmationsProblem,
  unservedRounds,
  WatchSchedule,
  WAYBACK,
  WAYBACK_NETWORKS,
  waybackOf,
  type FastRound,
} from "./wayback.js";
import {
  addHalt,
  DEFAULT_FAST_CAP,
  MAX_BACKOFF_SECONDS,
  MAX_CONFIRMATIONS,
  MIN_WATCH_CONFIRMATIONS,
  nextStep,
  parseConfirmations,
  qualification,
  readHalt,
  recordedStop,
  tradeOff,
  watchRound,
  type BurnState,
  type Ports,
  type RecordedFindings,
  type Rule,
  type SeenBurn,
} from "./watch.js";

const TPOT = 10n ** 14n;
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
/** BridgeMinter on Base Sepolia and on Arbitrum Sepolia: the same address (the deployer's nonce 9 on both). */
const ROLLUP_MINTER = "0xdc31a3bc1354545eeb985aad7b2aa662e9272348";
const SEPOLIA_MINTER = "0x8287b3baf205ca8456f98346f13064aa7fcdcb9e";
const MULTISIG = "5FTrjzEPPdxo3WP1RcQGTzUX1y1udD7tAkaETV1iLH24xPk3";

describe("each chain's way back", () => {
  it("keeps Sepolia's rule as before: its record, 1 to 64 confirmations, 3 or more with --send, the cap as the burn's first gas limit", () => {
    const s = WAYBACK.sepolia;
    assert.equal(s.record, "deployments/sepolia-bridge.json");
    assert.equal(s.chainId, 11_155_111n);
    assert.equal(s.maxConfirmations, MAX_CONFIRMATIONS);
    assert.equal(s.maxConfirmations, 64);
    assert.equal(s.minSendConfirmations, MIN_WATCH_CONFIRMATIONS);
    assert.equal(s.minSendConfirmations, 3);
    assert.equal(s.burnProbeGas, 16_777_216);
    assert.equal(s.burnGasByEstimate, false, "a Sepolia burn's limit stays the gas used + 10%");
    assert.equal(s.archiveState, false, "Sepolia's reads stay as before");
    assert.equal(s.reconcileBack, 128);
  });

  it("gives each rollup its record, its chain id, its finalized tag as final, and 36 seconds of its blocks as the fewest confirmations with --send", () => {
    for (const network of ["base-sepolia", "arbitrum-sepolia"] as const) {
      const c = WAYBACK[network];
      assert.equal(c.network, network);
      assert.equal(c.record, `deployments/${network}-bridge.json`);
      assert.equal(c.chainId, NETWORKS[network].chainId);
      assert.equal(c.title, NETWORKS[network].title);
      assert.match(c.finality, /finalized block/);
      assert.match(c.finality, /Sepolia's finalized blocks|finalized Sepolia block/, "a rollup's finality follows Sepolia's finality of its batch");
      // The time Sepolia's 3 confirmations of 12 s take.
      assert.equal(Math.round(c.minSendConfirmations * c.blockSeconds), 36);
      assert.ok(c.maxConfirmations * c.blockSeconds >= 20 * 60, "the most confirmations reach past the finalized block, about 20 minutes back");
      assert.equal(c.burnProbeGas, 1_000_000);
      assert.equal(c.burnGasByEstimate, true);
      assert.equal(c.archiveState, true);
    }
    assert.equal(WAYBACK["base-sepolia"].minSendConfirmations, 180);
    assert.equal(WAYBACK["arbitrum-sepolia"].minSendConfirmations, 144);
    assert.deepEqual(WAYBACK_NETWORKS, ["sepolia", "base-sepolia", "arbitrum-sepolia"]);
    assert.equal(waybackOf(84_532n)?.network, "base-sepolia");
    assert.equal(waybackOf("421614")?.network, "arbitrum-sepolia");
    assert.equal(waybackOf(1n), null);
  });

  it("takes --network: one chain for burn, release and status (Sepolia by default), one or several for the watcher", () => {
    assert.equal(parseNetwork(undefined), "sepolia");
    assert.equal(parseNetwork("base-sepolia"), "base-sepolia");
    assert.throws(() => parseNetwork("arbitrum"), /one of sepolia, base-sepolia, arbitrum-sepolia/);
    assert.throws(() => parseNetwork("sepolia,base-sepolia"), /several are for release --watch/);
    assert.deepEqual(parseNetworks(undefined), ["sepolia"]);
    assert.deepEqual(parseNetworks("arbitrum-sepolia, sepolia"), ["arbitrum-sepolia", "sepolia"], "in the order given");
    assert.throws(() => parseNetworks("sepolia,sepolia"), /named twice/);
    assert.throws(() => parseNetworks("sepolia,op-sepolia"), /got "op-sepolia"/);
  });
});

describe("--confirmations on each chain", () => {
  it("reads Sepolia's as before, and each rollup's within its own bounds", () => {
    assert.equal(parseConfirmationsOn("64", WAYBACK.sepolia), 64);
    for (const bad of ["0", "65", "x"]) {
      assert.throws(
        () => parseConfirmationsOn(bad, WAYBACK.sepolia),
        (e: Error) => {
          assert.throws(() => parseConfirmations(bad), (f: Error) => f.message === e.message, "Sepolia's message as before");
          return true;
        },
      );
    }
    assert.equal(parseConfirmationsOn("180", WAYBACK["base-sepolia"]), 180);
    assert.equal(parseConfirmationsOn("7200", WAYBACK["arbitrum-sepolia"]), 7_200);
    assert.throws(() => parseConfirmationsOn("7201", WAYBACK["base-sepolia"]), /from 1 to 7,200 blocks on Base Sepolia \(24 minutes of its blocks; it finalizes a block about 20 minutes after it\), got 7201/);
    assert.throws(() => parseConfirmationsOn("0", WAYBACK["arbitrum-sepolia"]), /from 1 to 7,200 blocks on Arbitrum Sepolia/);
    assert.throws(() => parseConfirmationsOn("1e3", WAYBACK["arbitrum-sepolia"]), /a whole number/);
  });

  it("takes one number for every chain served, or <network>=<n> pairs, a chain left out waiting for finality", () => {
    const all = ["sepolia", "base-sepolia", "arbitrum-sepolia"] as const;
    assert.deepEqual([...confirmationsBy(undefined, [...all])], [["sepolia", null], ["base-sepolia", null], ["arbitrum-sepolia", null]]);
    assert.deepEqual([...confirmationsBy("200", ["base-sepolia", "arbitrum-sepolia"])], [["base-sepolia", 200], ["arbitrum-sepolia", 200]]);
    assert.throws(() => confirmationsBy("200", [...all]), /\(sepolia\) from 1 to 64 blocks/, "one number for every chain: Sepolia's bounds hold too");
    const pairs = confirmationsBy("sepolia=3, arbitrum-sepolia=144", [...all]);
    assert.deepEqual([...pairs], [["sepolia", 3], ["base-sepolia", null], ["arbitrum-sepolia", 144]]);
    assert.throws(() => confirmationsBy("sepolia=3,optimism-sepolia=5", [...all]), /no network optimism-sepolia/);
    assert.throws(() => confirmationsBy("base-sepolia=180", ["sepolia"]), /base-sepolia is not a --network of this run/);
    assert.throws(() => confirmationsBy("sepolia=3,sepolia=4", [...all]), /sepolia is named twice/);
    assert.throws(() => confirmationsBy("sepolia=3,base-sepolia", [...all]), /"base-sepolia" is not <network>=<blocks>/);
    assert.throws(() => confirmationsBy("sepolia:3", [...all]), /\(sepolia\) a number of blocks is a whole number, got "sepolia:3"/, "without =, one number for every chain");
    assert.throws(() => confirmationsBy("base-sepolia=9000", [...all]), /\(base-sepolia\) from 1 to 7,200 blocks/);
    // Sepolia alone: the message as before, without the chain's name.
    assert.throws(() => confirmationsBy("65", ["sepolia"]), (e: Error) => /^from 1 to 64 blocks/.test(e.message));
  });

  it("refuses, with --send, fewer than each chain's minimum, in Sepolia's words as before", () => {
    assert.equal(sendConfirmationsProblem(WAYBACK.sepolia, 2), "takes --confirmations 3 or more: reorgs of one or two blocks happen on Sepolia");
    assert.equal(sendConfirmationsProblem(WAYBACK.sepolia, 3), null);
    assert.match(sendConfirmationsProblem(WAYBACK["base-sepolia"], 179) ?? "", /^takes --confirmations 180 or more on Base Sepolia: 36 seconds of its blocks/);
    assert.equal(sendConfirmationsProblem(WAYBACK["base-sepolia"], 180), null);
    assert.match(sendConfirmationsProblem(WAYBACK["arbitrum-sepolia"], 3) ?? "", /^takes --confirmations 144 or more on Arbitrum Sepolia/);
    assert.equal(sendConfirmationsProblem(WAYBACK["arbitrum-sepolia"], 144), null);
  });

  it("gives every chain the one fast cap and the one fast budget", () => {
    const rules = rulesBy(new Map([["sepolia", 3], ["base-sepolia", null]]), TPOT, 2n * TPOT);
    assert.deepEqual(rules.get("sepolia"), { confirmations: 3, fastCap: TPOT, fastBudget: 2n * TPOT });
    assert.deepEqual(rules.get("base-sepolia"), { confirmations: null, fastCap: TPOT, fastBudget: 2n * TPOT });
  });

  it("names the burn's chain in the trade-off and the budget's message, and keeps Sepolia's words by default", () => {
    assert.equal(tradeOff(3), "fast mode: the committee releases before Sepolia finalizes this burn; a reorg deeper than 3 blocks could undo the burn after the release");
    assert.equal(tradeOff(180, "Base Sepolia"), "fast mode: the committee releases before Base Sepolia finalizes this burn; a reorg deeper than 180 blocks could undo the burn after the release");
    const rule: Rule = { confirmations: 180, fastCap: TPOT, fastBudget: TPOT };
    const over = qualification({ block: 990, amount: TPOT / 2n }, { latest: 2_000, finalized: 900 }, rule, TPOT);
    assert.match(over.why, /not checked against Sepolia's final chain, yet hold/);
    const shared = qualification({ block: 990, amount: TPOT / 2n }, { latest: 2_000, finalized: 900 }, rule, TPOT, "their chains' final blocks");
    assert.match(shared.why, /not checked against their chains' final blocks, yet hold/);
  });
});

describe("each chain's burns and releases, kept apart", () => {
  it("gives each chain its own burn cache: Sepolia's file as before, the rollups' by network, as their minters share one address", () => {
    assert.equal(burnCacheName(MULTISIG, "sepolia"), `release-watch-${MULTISIG}.burns.json`);
    assert.equal(burnCacheName(MULTISIG, "base-sepolia"), `release-watch-${MULTISIG}.base-sepolia.burns.json`);
    assert.equal(burnCacheName(MULTISIG, "arbitrum-sepolia"), `release-watch-${MULTISIG}.arbitrum-sepolia.burns.json`);
  });

  it("tells a release's chain by its chain id and minter: Base Sepolia's burn 0 is not Arbitrum Sepolia's, and a round without a chain id is Sepolia's", () => {
    const base = { chainId: "84532", minter: ROLLUP_MINTER };
    assert.equal(burnOn(base, 84_532n, ROLLUP_MINTER), true);
    assert.equal(burnOn(base, 421_614n, ROLLUP_MINTER), false, "same minter address, another chain");
    assert.equal(burnOn({ minter: SEPOLIA_MINTER }, 11_155_111n, SEPOLIA_MINTER.toUpperCase().replace("0X", "0x")), true, "no chain id: Sepolia's");
    assert.equal(chainIdOf({ minter: SEPOLIA_MINTER }), 11_155_111n);
    assert.equal(burnLabel(11_155_111n, 1n), "1", "Sepolia's burns by their nonce alone, as before");
    assert.equal(burnLabel("84532", "0"), "0 on Base Sepolia");
    assert.equal(burnLabel(421_614n, 0n), "0 on Arbitrum Sepolia");
    assert.equal(burnLabel(5n, 2n), "2 on chain 5");
  });

  it("gives the same nonce of the same minter address another burn id on each chain, as the vault's convention puts the chain id in it", () => {
    const minter = hexToBytes(ROLLUP_MINTER);
    const ids = [84_532n, 421_614n].map((c) => bytesToHex(burnId(c, minter, 0n)));
    assert.notEqual(ids[0], ids[1]);
    assert.equal(ids[0], "0x6ae40d53f7c3d1156db402387484ed10011948fca8a2dfedd2b25eabbedb6d8d");
    assert.equal(ids[1], "0x9890de419e811a71bd9e8f16963d616b7f746ec284d8ce03813d2508cfe80522");
  });

  it("knows a state an RPC no longer serves, Arbitrum's words and the others'", () => {
    assert.ok(prunedState('{"code":-32000,"message":"historical state a5ce0da06229645378929fc4e25f1ecd09151e836f857216975423053d5d88e9 is not available"}'));
    assert.ok(prunedState('{"code":-32000,"message":"missing trie node 1a2b (path ) state 0x1a2b is not available"}'));
    assert.ok(prunedState('{"code":4444,"message":"pruned history unavailable"}'));
    assert.equal(prunedState('{"code":-32000,"message":"header not found"}'), false);
    assert.equal(prunedState('{"code":3,"message":"execution reverted"}'), false);
  });
});

describe("the two burns on the rollups, in their records", () => {
  for (const [network, chainId, tx, block] of [
    ["base-sepolia", 84_532n, "0xaffaf9e0f464552686c3478cb4ffb3b822accb98b656cbd2053579de70eefd2e", 51_177_673],
    ["arbitrum-sepolia", 421_614n, "0xc2ec4b933efeeabb01414348c0b430d084fc3ddec40ee2fe765adeb381f48cb8", 323_549_062],
  ] as const) {
    it(`${network}: burn 0, 0.001 wtPOT for 0xD983…1071, a step of kind burn as Sepolia's burns are recorded, its id the vault's convention`, () => {
      type Step = { kind: string; nonce: number; sender: string; address: string; burn?: { amount: string; v3Recipient: string; burnNonce: string | null; burnId: string | null; expected: { burnNonce: string; burnId: string } }; txHash: string | null; block: number | null; status: number | null; ok: boolean | null };
      const record = JSON.parse(readFileSync(join(ROOT, "deployments", `${network}-bridge.json`), "utf8")) as { network: string; chainId: number; contracts: { BridgeMinter: string }; steps: Step[] };
      assert.equal(record.network, network);
      assert.equal(BigInt(record.chainId), chainId);
      const burns = record.steps.filter((s) => s.kind === "burn");
      assert.equal(burns.length, 1);
      const s = burns[0];
      assert.equal(s.address, record.contracts.BridgeMinter);
      assert.equal(s.address, ROLLUP_MINTER);
      assert.equal(s.sender, "0xd9838a86cf83c28ee486544060d1ca4ca2971071");
      assert.equal(s.nonce, 12);
      assert.equal(s.txHash, tx);
      assert.equal(s.block, block);
      assert.equal(s.status, 1);
      assert.equal(s.ok, true);
      assert.equal(s.burn?.amount, (TPOT / 1000n).toString());
      assert.equal(s.burn?.v3Recipient, "0xd9838a86cf83c28ee486544060d1ca4ca2971071");
      assert.equal(s.burn?.burnNonce, "0");
      assert.equal(s.burn?.burnId, bytesToHex(burnId(chainId, hexToBytes(ROLLUP_MINTER), 0n)));
      assert.equal(s.burn?.expected.burnId, s.burn?.burnId);
    });
  }
});

describe("the payee on a rollup", () => {
  it("names the burn's chain, and Sepolia as before when none is given", () => {
    const facts = { original: null, contract: false, sepoliaContract: false, burner: true, sepoliaNonce: 12, v3Nonce: 0 };
    assert.equal(payeeVerdict(facts).why, "the burn's own sender, which has no code on Sepolia: the Ethereum key that signed the burn controls the same address on V3");
    assert.equal(payeeVerdict({ ...facts, chain: "Base Sepolia" }).why, "the burn's own sender, which has no code on Base Sepolia: the Ethereum key that signed the burn controls the same address on V3");
    assert.match(payeeVerdict({ ...facts, burner: false, chain: "Arbitrum Sepolia" }).why, /nonce 12 on Arbitrum Sepolia, 0 on V3/);
    assert.match(payeeVerdict({ ...facts, burner: false, sepoliaNonce: 0, sepoliaContract: true, chain: "Base Sepolia" }).why, /a contract on Base Sepolia that is not on V3/);
  });
});

/** A released round of the V3 record, for the fast budget. */
const fastRound = (chainId: string, minter: string, block: number, amount: bigint, finalizedCheck?: FastRound["finalizedCheck"]): FastRound => ({
  status: "released",
  by: "fast",
  amountNative: amount.toString(),
  burn: { chainId, minter, block, burnNonce: "0" },
  ...(finalizedCheck ? { finalizedCheck } : {}),
});

describe("one fast budget across every chain", () => {
  const SIX = (6n * TPOT) / 10n;
  const base = { chainId: 84_532n, minter: ROLLUP_MINTER };

  it("counts the round's own chain's fast releases as before, and another chain's by its own finalized head", () => {
    const rounds = [
      fastRound("84532", ROLLUP_MINTER, 1_000, SIX),
      fastRound("421614", ROLLUP_MINTER, 5_000, SIX),
      fastRound("11155111", SEPOLIA_MINTER, 300, TPOT / 10n, { ok: true }),
      { ...fastRound("421614", ROLLUP_MINTER, 4_000, TPOT), by: "finality" as const },
    ];
    assert.deepEqual(otherFastChains(rounds, base), [421_614n], "Sepolia's is checked already; a release by finality never counts");
    const items = fastReleasesOf(rounds, base, new Map([[421_614n, 4_999]]));
    assert.equal(items.length, 3);
    assert.deepEqual(items.map(({ round: _r, ...x }) => x), [
      { amount: SIX, block: 1_000, checked: false },
      { amount: SIX, block: 5_000, checked: false, final: false },
      { amount: TPOT / 10n, block: 300, checked: true, final: true },
    ]);
    // Arbitrum Sepolia's finalized head past the block: final there.
    assert.equal(fastReleasesOf(rounds, base, new Map([[421_614n, 5_000]]))[1].final, true);
    // Its head not read: not final.
    assert.equal(fastReleasesOf(rounds, base, new Map())[1].final, false);
  });

  /** Stand-ins for one chain's round: one burn that qualifies fast, and the fast releases the budget counts. */
  function ports(fast: { amount: bigint; block: number; checked: boolean; final?: boolean }[], calls: string[], lines: string[]): Ports {
    const state: BurnState = { released: false, op: null, rounds: [] };
    return {
      halted: () => null,
      settle: async () => ({ kind: "ok" }),
      heads: async () => ({ latest: 10_000, finalized: 4_000 }),
      burns: async (): Promise<SeenBurn[]> => [{ burnNonce: 0n, amount: SIX, block: 9_000, payee: "0xD9838A86cF83C28Ee486544060D1cA4Ca2971071" }],
      fastReleases: async () => fast,
      reconcile: async () => ({ checked: 0, fatal: null }),
      state: async () => structuredClone(state),
      approve: async (b, by, step) => {
        calls.push(`${b.burnNonce}:${step.kind}:${step.member}:${by}`);
        if (step.kind === "open") state.op = { approvals: [step.member], depositor: step.member, matches: true };
        else {
          state.op = null;
          state.released = true;
        }
        return { kind: "ok" };
      },
      log: (line) => lines.push(line),
    };
  }
  const FAST: Rule = { confirmations: 180, fastCap: DEFAULT_FAST_CAP, fastBudget: DEFAULT_FAST_CAP };
  const SEND = { send: true, keyed: [1, 2], threshold: 2, title: "Arbitrum Sepolia", finalChain: "their chains' final blocks" };

  it("makes a 0.6 tPOT burn on one rollup wait while another chain's 0.6 tPOT fast release is not final there", async () => {
    const calls: string[] = [];
    const lines: string[] = [];
    const r = await watchRound(ports([{ amount: SIX, block: 9_500, checked: false, final: false }], calls, lines), FAST, SEND);
    assert.deepEqual(calls, []);
    assert.equal(r.waiting, 1);
    assert.ok(lines.includes("Arbitrum Sepolia: latest #10000, finalized #4000"), lines.join("\n"));
    assert.ok(lines.some((l) => /waits: the burns released fast and not final, or not checked against their chains' final blocks, yet hold 60000000000000 base units/.test(l)), lines.join("\n"));
  });

  it("releases it fast once that release is final on its chain and checked, though its block is above this chain's finalized head", async () => {
    const calls: string[] = [];
    const lines: string[] = [];
    // Block 9,500 is above this chain's finalized #4,000; `final` is the other chain's word.
    const r = await watchRound(ports([{ amount: SIX, block: 9_500, checked: true, final: true }], calls, lines), FAST, SEND);
    assert.deepEqual(calls, ["0:open:1:fast", "0:execute:2:fast"]);
    assert.equal(r.released, 1);
    assert.ok(lines.some((l) => l.includes(tradeOff(180, "Arbitrum Sepolia"))), lines.join("\n"));
  });

  it("with --send keeps counting another chain's release final there and not checked against its final chain yet; a dry run counts its block alone", async () => {
    const stillOpen = [{ amount: SIX, block: 3_000, checked: false, final: true }];
    const sent = await watchRound(ports(stillOpen, [], []), FAST, SEND);
    assert.equal(sent.waiting, 1);
    const dry = await watchRound(ports(stillOpen, [], []), FAST, { ...SEND, send: false });
    assert.equal(dry.planned, 1);
  });

  it("keeps Sepolia's own words when no title is given: a release of its own chain against the round's finalized head, as before", async () => {
    const lines: string[] = [];
    const r = await watchRound(ports([{ amount: SIX, block: 9_500, checked: false }], [], lines), FAST, { send: true, keyed: [1, 2], threshold: 2 });
    assert.equal(r.waiting, 1);
    assert.ok(lines.includes("Sepolia: latest #10000, finalized #4000"));
    assert.ok(lines.some((l) => l.includes("not checked against Sepolia's final chain, yet hold 60000000000000")));
  });
});

/** A round of the V3 record for `chainId` (Sepolia's has no chain id when `chainId` is null), burn `nonce`, 0.001 tPOT. */
const roundOf = (status: string, by: "fast" | "finality" | null, chainId: string | null, nonce: string, finalizedCheck?: FastRound["finalizedCheck"]): FastRound => ({
  status,
  ...(by ? { by } : {}),
  amountNative: (TPOT / 1000n).toString(),
  burn: { ...(chainId ? { chainId } : {}), minter: chainId === null || chainId === "11155111" ? SEPOLIA_MINTER : ROLLUP_MINTER, block: 100, burnNonce: nonce, burnId: `0x${(chainId ?? "aa").padStart(32, "0")}${nonce.padStart(32, "0")}` },
  ...(finalizedCheck ? { finalizedCheck } : {}),
});

describe("a watcher that does not serve every chain", () => {
  const SEPOLIA_ONLY = [11_155_111n];

  it("finds what only a round of a chain it does not serve finishes: a release left open, and one made fast and not checked against that chain's final blocks yet", () => {
    const rounds = [
      roundOf("open", null, "84532", "0"),
      roundOf("released", "fast", "421614", "0"),
      roundOf("released", "fast", "421614", "1", { ok: true }),
      roundOf("released", "fast", "421614", "2", { ok: false, acknowledged: "member 1, Oct 29: looked at it" }),
      roundOf("released", "finality", "84532", "1"),
      roundOf("failed", null, "84532", "2"),
      roundOf("cancelled", null, "84532", "3"),
      roundOf("released", "fast", null, "5"),
    ];
    assert.deepEqual(unservedRounds(rounds, SEPOLIA_ONLY), [
      { chainId: 84_532n, burnNonce: "0", why: "its release is open (opened, not run yet)" },
      { chainId: 421_614n, burnNonce: "0", why: "its release, made in fast mode, is not checked against Arbitrum Sepolia's final blocks yet" },
    ]);
    assert.deepEqual(unservedRounds(rounds, [11_155_111n, 84_532n, 421_614n]), [], "a watcher of the three chains leaves nothing behind");
    // A round recorded without a chain id is Sepolia's: a watcher of the rollups alone names it.
    assert.deepEqual(
      unservedRounds(rounds, [84_532n, 421_614n]).map((x) => [x.chainId, x.burnNonce]),
      [[11_155_111n, "5"]],
    );
  });
});

describe("an approval by hand in fast mode", () => {
  it("counts every chain's releases made fast and not checked yet against the one budget, its own burn's left out", () => {
    const rounds = [
      { ...roundOf("released", "fast", "11155111", "2"), amountNative: ((9n * TPOT) / 10n).toString() },
      { ...roundOf("released", "fast", "84532", "0", { ok: true }), amountNative: TPOT.toString() },
      { ...roundOf("released", "fast", "421614", "0"), amountNative: (TPOT / 10n).toString() },
      { ...roundOf("released", "fast", "421614", "1", { ok: false }), amountNative: (TPOT / 10n).toString() },
      { ...roundOf("released", "finality", "84532", "1"), amountNative: TPOT.toString() },
      { ...roundOf("open", null, "84532", "2"), amountNative: TPOT.toString() },
    ];
    const exposed = fastExposure(rounds, "0xnone");
    assert.equal(exposed.total, (11n * TPOT) / 10n, "0.9 on Sepolia, 0.1 and 0.1 (its check failed, not acknowledged) on Arbitrum Sepolia");
    assert.deepEqual(exposed.burns.map((x) => burnLabel(x.chainId, x.burnNonce)), ["2", "0 on Arbitrum Sepolia", "1 on Arbitrum Sepolia"]);
    // A burn of 0.001 tPOT by hand in fast mode is above the default budget (the cap by hand), 1 tPOT.
    assert.ok(exposed.total + TPOT / 1000n > DEFAULT_FAST_CAP);
    // The burn the run is for is left out (its own release, when there is one, is not more of the budget).
    const own = rounds[2].burn.burnId!.toUpperCase().replace("0X", "0x");
    assert.equal(fastExposure(rounds, own).total, TPOT);
  });
});

describe("the watcher's rounds over several chains", () => {
  /**
   * watchCommand's loop on a clock of its own: each chain's round takes `takes[x]` seconds and ends
   * with `code(x, n)` (`trouble(x, n)`: an RPC failed); the rounds in the order they ran, and each
   * chain's last code.
   */
  function simulate(
    networks: NetworkName[],
    watch: number,
    rounds: number,
    takes: Partial<Record<NetworkName, number>>,
    code: (x: NetworkName, n: number) => number = () => 0,
    trouble: (x: NetworkName, n: number) => boolean = () => false,
  ) {
    const s = new WatchSchedule(networks, watch, rounds);
    let now = 1_000_000;
    const ran: string[] = [];
    for (let pass = 0; pass < 1_000; pass++) {
      for (const x of networks) {
        if (!s.due(x, now)) continue;
        const n = s.start(x);
        ran.push(`${x}#${n}`);
        now += (takes[x] ?? 1) * 1000;
        s.end(x, code(x, n), trouble(x, n), now);
      }
      if (s.finished()) return { ran, last: s.lastCodes() };
      now = Math.max(now, s.nextDue(now));
    }
    throw new Error("the rounds did not end");
  }

  it("runs --rounds n of each chain, though a chain is not due yet when another's round ends (the dry run of Oct 28: --watch 60 --rounds 2)", () => {
    const r = simulate(["base-sepolia", "arbitrum-sepolia"], 60, 2, { "base-sepolia": 5, "arbitrum-sepolia": 20 });
    assert.deepEqual(r.ran, ["base-sepolia#1", "arbitrum-sepolia#1", "base-sepolia#2", "arbitrum-sepolia#2"]);
  });

  it("counts each chain's rounds on its own when one chain's round is longer than another's wait", () => {
    const r = simulate(["sepolia", "base-sepolia"], 10, 3, { sepolia: 30, "base-sepolia": 1 });
    assert.deepEqual(r.ran, ["sepolia#1", "base-sepolia#1", "sepolia#2", "base-sepolia#2", "sepolia#3", "base-sepolia#3"]);
  });

  it("backs a chain off alone while its RPC fails, and ends with each chain's last round's code", () => {
    // Base Sepolia's first round cannot reach its RPC (exit code 2): its wait doubles, Sepolia's does not.
    const r = simulate(["sepolia", "base-sepolia"], 15, 2, {}, (x, n) => (x === "base-sepolia" && n === 1 ? 2 : 0), (x, n) => x === "base-sepolia" && n === 1);
    assert.deepEqual(r.ran, ["sepolia#1", "base-sepolia#1", "sepolia#2", "base-sepolia#2"]);
    assert.deepEqual(r.last, [0, 0], "the failure was not either chain's last round");
    const failedLast = simulate(["sepolia", "base-sepolia"], 15, 2, {}, (x, n) => (x === "base-sepolia" && n === 2 ? 1 : 0));
    assert.deepEqual(failedLast.last, [0, 1], "a chain whose last round failed says so, whatever ran after it");
    const s = new WatchSchedule(["sepolia", "base-sepolia"], 15, null);
    s.end("base-sepolia", 2, true, 0);
    s.end("base-sepolia", 2, true, 0);
    assert.deepEqual(s.upcoming().map((x) => [x.network, x.wait]), [["sepolia", 15], ["base-sepolia", 60]]);
    for (let i = 0; i < 10; i++) s.end("base-sepolia", 2, true, 0);
    assert.equal(s.upcoming()[1].wait, MAX_BACKOFF_SECONDS, "up to an hour");
    assert.equal(s.finished(), false, "without --rounds it never ends");
  });

  it("keeps Sepolia alone as before: --rounds n is n rounds, and the exit code the last round's", () => {
    const r = simulate(["sepolia"], 15, 3, {}, (_x, n) => (n === 3 ? 3 : 1));
    assert.deepEqual(r.ran, ["sepolia#1", "sepolia#2", "sepolia#3"]);
    assert.deepEqual(r.last, [3]);
  });
});

describe("a rollup's burn in messages and the halt file", () => {
  const exec = { member: 2, action: "execute", extrinsicHash: "0xexec", status: "final", block: { number: 300_000 } };
  const open = { member: 1, action: "open", extrinsicHash: "0xopen", status: "final", block: { number: 299_990 } };

  it("names it with its chain where the record holds a finding, and its chain's final chain; Sepolia's as before", () => {
    const base: RecordedFindings = { burn: burnLabel(84_532n, 0n), approvals: [open, exec], finalizedCheck: { ok: false, why: "the final chain has no BurnRequested log of this burn nonce" }, chain: "Base Sepolia" };
    const stop = recordedStop([base]);
    assert.equal(stop?.burn, "0 on Base Sepolia");
    assert.match(stop!.why, /the release of burn 0 on Base Sepolia, made in fast mode, as failing its check against Base Sepolia's final chain \(the final chain has no BurnRequested/);
    const failed = recordedStop([{ burn: burnLabel(421_614n, 0n), approvals: [open, { ...exec, status: "failed" }], chain: "Arbitrum Sepolia" }]);
    assert.match(failed!.why, /member 2's execute 0xexec \(burn 0 on Arbitrum Sepolia\) as run on chain in #300000/);
    const sepolia = recordedStop([{ burn: burnLabel(11_155_111n, 1n), approvals: [open, exec], finalizedCheck: { ok: false } }]);
    assert.equal(sepolia?.burn, "1");
    assert.match(sepolia!.why, /burn 1, made in fast mode, as failing its check against Sepolia's final chain, and no member/);
  });

  /** Stand-ins for a round on Base Sepolia whose burn 0 is final and whose opening fails its checks on chain. */
  function failing(lines: string[], state: BurnState = { released: false, op: null, rounds: [] }, calls: string[] = []): Ports {
    return {
      halted: () => null,
      settle: async () => ({ kind: "ok" }),
      heads: async () => ({ latest: 10_000, finalized: 9_500 }),
      burns: async (): Promise<SeenBurn[]> => [{ burnNonce: 0n, amount: TPOT / 1000n, block: 9_000, payee: "0xD9838A86cF83C28Ee486544060D1cA4Ca2971071" }],
      fastReleases: async () => [],
      reconcile: async () => ({ checked: 1, fatal: null }),
      state: async () => structuredClone(state),
      approve: async (_b, _by, step) => {
        calls.push(`${step.kind}:${step.member}`);
        return { kind: "failed", why: "0xfeed in #300000 failed its checks", extrinsicHash: "0xfeed" };
      },
      log: (line) => lines.push(line),
    };
  }
  const FINAL: Rule = { confirmations: null, fastCap: DEFAULT_FAST_CAP, fastBudget: DEFAULT_FAST_CAP };
  const ON_BASE = { send: true, keyed: [1, 2], threshold: 2, title: "Base Sepolia", finalChain: "their chains' final blocks", label: (n: bigint) => burnLabel(84_532n, n) };

  it("leaves one stop in the halt file when a round's approval fails on chain: the run's line and the round's name the burn alike", async () => {
    const lines: string[] = [];
    const r = await watchRound(failing(lines), FINAL, ON_BASE);
    assert.equal(r.fatal?.burn, "0 on Base Sepolia");
    assert.match(r.fatal!.why, /^burn 0 on Base Sepolia \(/);
    assert.ok(lines.includes("1 release made in fast mode checked against Base Sepolia's final blocks"), lines.join("\n"));
    const dir = join(tmpdir(), "bz-wayback-test");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "halt.json");
    rmSync(path, { force: true });
    // releaseOnV3 leaves it first (onChainFailure with burnLabel), then watchCommand's halt() with the round's fatal stop.
    addHalt(path, { reason: "member 1's open 0xfeed (burn 0 on Base Sepolia) ran on chain in #300,000 and failed its checks", burn: burnLabel(84_532n, 0n), extrinsicHash: "0xfeed", at: "2026-10-28T10:00:00.000Z" });
    addHalt(path, { reason: r.fatal!.why, burn: r.fatal!.burn, extrinsicHash: r.fatal!.extrinsicHash, at: "2026-10-28T10:00:01.000Z" });
    const h = readHalt(path);
    rmSync(path, { force: true });
    assert.equal(h?.burn, "0 on Base Sepolia");
    assert.doesNotMatch(h!.reason, /earlier/, "the same stop is not written twice");
    // Without a label, Sepolia's words as before.
    const sepolia = await watchRound(failing([]), FINAL, { send: true, keyed: [1, 2], threshold: 2 });
    assert.equal(sepolia.fatal?.burn, "0");
  });

  it("makes an opening wait, naming the release, while the member who opens is busy with another chain's release", async () => {
    const why = "member 1's deposit is reserved by the release of burn 0 on Arbitrum Sepolia (opened at #229,000), opened and not run yet";
    assert.deepEqual(nextStep({ released: false, op: null, rounds: [], openerBusy: why }, [1, 2], 2), { kind: "wait", why });
    // This burn's own open operation is run as before: its opening's deposit is reserved already.
    assert.equal(nextStep({ released: false, op: { approvals: [1], depositor: 1, matches: true }, rounds: [], openerBusy: why }, [1, 2], 2).kind, "execute");
    const lines: string[] = [];
    const calls: string[] = [];
    const r = await watchRound(failing(lines, { released: false, op: null, rounds: [], openerBusy: why }, calls), FINAL, ON_BASE);
    assert.deepEqual(calls, [], "nothing is dry-run or signed for it");
    assert.equal(r.waiting, 1);
    assert.equal(r.fatal, null);
    assert.ok(lines.some((l) => l.startsWith("burn 0 on Base Sepolia (") && l.endsWith(`waits: ${why}`)), lines.join("\n"));
  });
});

describe("release.ts on each chain", () => {
  const source = readFileSync(join(ROOT, "relayer", "src", "release.ts"), "utf8");
  const slice = (from: string, to: string) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));

  it("keeps each chain's releases apart by chain id and minter where the watcher reads them, and records each release's chain", () => {
    assert.match(slice("async function burnsSince(", "async function burnStateOf("), /r\.status === "released" && burnOn\(r\.burn, b\.chainId, b\.minter\)/);
    assert.match(slice("async function reconcileFast(", "async function watchOnce("), /!burnOn\(round\.burn, b\.chainId, b\.minter\)/);
    assert.match(slice("async function releaseOnV3(", "const limitsText"), /chainId: b\.chainId\.toString\(\),/);
    assert.doesNotMatch(source, /SEPOLIA_CHAIN_ID/, "every burn id takes its chain's id");
  });

  it("counts every chain's fast releases against the one budget, each by its own chain's finality", () => {
    const once = slice("async function watchOnce(", "function leaveHalt(");
    assert.match(once, /fastReleases: async \(\) => \{[^]*otherFastChains\(rounds, here\)[^]*finalizedOn\(chainId\)[^]*fastReleasesOf\(rounds, here, finalized\)/);
    assert.match(once, /join\(o\.stateDir, burnCacheName\(d\.v\.multisig, d\.b\.chain\.network\)\)/);
  });

  it("switches the RPC, the records and the rule to each chain before its round, and shares the committee's lock and halt file", () => {
    const command = slice("async function watchCommand(", "function worstCode(");
    assert.match(command, /for \(const x of o\.networks\) \{\s*if \(!schedule\.due\(x, Date\.now\(\)\)\) continue;[^]*useReleaseNetwork\(x\);\s*const round = schedule\.start\(x\);[^]*await watchOnce\(o, keyring, keys, lock\)[^]*schedule\.end\(x, code, trouble, Date\.now\(\)\);/);
    assert.match(command, /if \(schedule\.finished\(\)\) return worstCode\(schedule\.lastCodes\(\)\);/, "--rounds n: n rounds of each chain, the worst of each chain's last code");
    assert.match(command, /takeCommitteeLock\(watchLockPath\(v\.multisig\), haltPath, log, \{ holder: "the watcher" \}\)/, "one lock per committee, whatever the chains");
  });

  it("does not start with --send while the record holds a release that only a round of a chain it does not serve finishes, once the lock is held and before the keys open", () => {
    const command = slice("async function watchCommand(", "function worstCode(");
    assert.match(command, /lock = taken\.lock;[^]*try \{[^]*const unserved = unservedRounds\(readV3Record\(\)\.releases \?\? \[\], o\.networks\.map\(\(x\) => WAYBACK\[x\]\.chainId\)\);[^]*if \(o\.send\) \{\s*check\(false, .the watcher does not start: \$\{what\}[^\n]*\);\s*return HALTED;\s*\}[^]*loadMemberKey\(/);
    assert.match(command, /const idle = WAYBACK_NETWORKS\.filter\(\(x\) => !o\.networks\.includes\(x\) && existsSync\(at\(WAYBACK\[x\]\.record\)\)\);/, "a warning names the chains with a minter that it does not serve");
  });

  it("reads another chain's finalized head in a dry run alone, and names each burn with its chain in a round", () => {
    const once = slice("async function watchOnce(", "function leaveHalt(");
    assert.match(once, /if \(!o\.send\) \{\s*for \(const chainId of otherFastChains\(rounds, here\)\) \{\s*const head = await finalizedOn\(chainId\);/);
    assert.match(once, /label: \(n\) => burnLabel\(d\.b\.chainId, n\),/);
    assert.match(once, /state: \(burn\) => burnStateOf\(api, d, burn, o\.memberKeys\[0\]\?\.member\),/);
    const finalized = slice("async function finalizedOn(", "function leaveHalt(");
    assert.match(finalized, /ask<string>\("eth_chainId", \[\]\)[^]*BigInt\(served\) !== chainId[^]*return null;[^]*"eth_getBlockByNumber", \["finalized", false\]/, "the RPC must answer the chain's id first");
    assert.doesNotMatch(finalized, /attempt/, "one short attempt");
  });

  it("keeps an approval by hand in fast mode to the fast budget, across every chain", () => {
    const v3 = slice("async function releaseOnV3(", "const limitsText");
    assert.match(v3, /if \(!o\.watcher && action !== "cancel" && !burn\.final\) \{\s*const exposed = fastExposure\(readV3Record\(\)\.releases \?\? \[\], bytesToHex\(burn\.burnId\)\);[^]*exposed\.total \+ burn\.amount <= o\.rule\.fastBudget[^]*\}\s*if \(failures > 0\) \{/);
  });
});
