// The proof core's reads, on fake nodes that answer with recorded data: the light client's and the
// minter's views on Sepolia, the dry runs and how a revert is named, and the V3 node's headers,
// finality proofs, read proofs and set changes, each answer checked before it is used. Nothing
// leaves the machine.

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, type Hex } from "../src/lib/hex.ts";
import { MULTICALL3, MULTICALL3_CODE_HASH } from "../src/lib/proof/calldata.ts";
import { clientCrypto } from "../src/lib/proof/grandpa.ts";
import { decodeFinalityProof, encodeCompact, encodeRpcHeader } from "../src/lib/proof/scale.ts";
import { codeHash, dryCall, estimateGas, heldHeader, overGasCap, readClient, readMinter, revertOf, simulate, TX_GAS_CAP } from "../src/lib/proof/sepolia.ts";
import { nextV3SetChange, V3Error, V3Moved, V3Reader } from "../src/lib/proof/v3.ts";
import { AllFailed } from "../src/lib/rpc.ts";
import {
  B,
  bundle,
  fakeChains,
  HELD_118614,
  KEYS,
  LIGHT_CLIENT,
  MINTER,
  MULTICALL_FAILED,
  proveFrom,
  registry,
  restoreFetch,
  revertData,
  RpcFail,
  S0,
  S1,
  S2,
  type Chains,
} from "./fake-chains.ts";

const crypto = clientCrypto(ed25519, sha512);

afterEach(restoreFetch);

function chains(): Chains {
  const c = fakeChains();
  Object.assign(c.sepolia.client, {
    sets: [
      { setId: 32n, activatedAt: 114_535, keys: KEYS },
      { setId: 33n, activatedAt: S0.number, keys: KEYS },
    ],
  });
  return c;
}

// ---------------------------------------------------------------------------------------------
// Sepolia

test("readClient: the set, its keys, the latest header, paused and halted, and the block the set began at", async () => {
  const c = chains();
  const v = await readClient(c.env.sepolia, LIGHT_CLIENT, "latest");
  assert.equal(v.setId, 33n);
  assert.deepEqual(v.keys.map(bytesToHex), KEYS);
  assert.deepEqual(v.latest, HELD_118614);
  assert.deepEqual([v.paused, v.halted, v.activatedAt], [false, false, 118_123]);
  // A last set that is not the current one (a reinitialize to an older id) gives no start block.
  c.sepolia.client.setId = 32n;
  assert.equal((await readClient(c.env.sepolia, LIGHT_CLIENT, "latest")).activatedAt, null);
});

test("readMinter and heldHeader: the replay guard, the trie id, and a header the client holds or not", async () => {
  const c = chains();
  c.sepolia.minter.used.add(1n);
  assert.deepEqual(await readMinter(c.env.sepolia, MINTER, 1n, "latest"), { used: true, trieId: hexToBytes(bundle.vault.trieId) });
  c.sepolia.minter.trieId = `0x${"00".repeat(32)}`;
  assert.deepEqual(await readMinter(c.env.sepolia, MINTER, 2n, "latest"), { used: false, trieId: null });
  c.sepolia.client.held.set(B.hash, { number: B.number, stateRoot: bundle.header.stateRoot, setId: 33n });
  assert.deepEqual(await heldHeader(c.env.sepolia, LIGHT_CLIENT, B.hash, "latest"), { number: 118_637, stateRoot: hexToBytes(bundle.header.stateRoot), setId: 33n });
  assert.equal(await heldHeader(c.env.sepolia, LIGHT_CLIENT, S1.hash, "latest"), null);
});

test("codeHash: Multicall3's code on Sepolia hashes to the constant the planner checks", async () => {
  const c = chains();
  assert.equal(await codeHash(c.env.sepolia, MULTICALL3, "latest"), MULTICALL3_CODE_HASH);
  assert.equal(await codeHash(c.env.sepolia, MINTER, "latest"), null);
});

test("estimateGas: the gas, or the revert named by the contracts' errors; a revert without data is asked of the next endpoint", async () => {
  const c = chains();
  c.sepolia.run = (tx) => (tx.data === "0x01" ? { gas: 21_000n } : { revert: revertData("NonceAlreadyUsed(uint256)", "uint256", [1n]) });
  assert.deepEqual(await estimateGas(c.env.sepolia, { to: MINTER, data: "0x01" }, "latest", registry), { gas: 21_000n });
  const r = await estimateGas(c.env.sepolia, { to: MINTER, data: "0x02" }, "latest", registry);
  assert.ok("revert" in r);
  assert.equal(r.revert.text, "NonceAlreadyUsed(nonce: 1)");
  assert.equal(r.revert.error?.name, "NonceAlreadyUsed");
  // The first node reverts with no data; the second says why.
  const bare = { id: "bare", label: "bare node", url: "https://bare.fake/" };
  const { fakeFetch } = await import("./fake-chains.ts");
  fakeFetch({
    [bare.url]: () => {
      throw new RpcFail(3, "execution reverted");
    },
    [c.sepolia.endpoint.url]: c.sepolia.handle,
  });
  const named = await estimateGas([bare, c.sepolia.endpoint], { to: MINTER, data: "0x02" }, "latest", registry);
  assert.ok("revert" in named && named.revert.error?.name === "NonceAlreadyUsed");
  const alone = await estimateGas([bare], { to: MINTER, data: "0x02" }, "latest", registry);
  assert.ok("revert" in alone && alone.revert.data === null && alone.revert.text === "execution reverted");
});

test("dryCall: eth_call with the cap as its gas, its return data or its revert", async () => {
  const c = chains();
  c.sepolia.minter.used.add(1n);
  const call = { to: MULTICALL3, data: "0x" } as const;
  c.sepolia.run = () => ({ revert: MULTICALL_FAILED });
  const r = await dryCall(c.env.sepolia, call, "latest", registry);
  assert.ok("revert" in r && r.revert.text === 'Error("Multicall3: call failed")');
  const sent = c.seen.find((s) => s.method === "eth_call")?.params[0] as { gas: string };
  assert.equal(BigInt(sent.gas), TX_GAS_CAP);
});

test("simulate: each transaction in a simulated block of its own, in order; null when no endpoint runs it", async () => {
  const c = chains();
  c.sepolia.run = (tx) => (tx.data === "0x01" ? { gas: 50_000n } : { revert: revertData("NotNewer(uint32,uint32)", "uint32,uint32", [5, 6]) });
  const out = await simulate(
    c.env.sepolia,
    [
      { from: "0x000000000000000000000000000000000000beef", to: LIGHT_CLIENT, data: "0x01" },
      { to: MINTER, data: "0x02" },
    ],
    "latest",
    registry,
  );
  assert.deepEqual(
    out?.map((x) => [x.ok, x.gasUsed, x.revert?.text ?? null]),
    [
      [true, 50_000n, null],
      [false, 21_000n, "NotNewer(number: 5, latest: 6)"],
    ],
  );
  const params = c.seen.find((s) => s.method === "eth_simulateV1")?.params[0] as { blockStateCalls: { calls: { gas: string }[] }[]; validation: boolean };
  assert.deepEqual(
    params.blockStateCalls.map((b) => b.calls.map((x) => BigInt(x.gas))),
    [[TX_GAS_CAP], [TX_GAS_CAP]],
  );
  assert.equal(params.validation, false);
  c.sepolia.simulateAvailable = false;
  assert.equal(await simulate(c.env.sepolia, [{ to: MINTER, data: "0x01" }], "latest", registry), null);
});

test("revertOf and overGasCap: a revert in words, and a node refusing an estimate over its gas cap", () => {
  assert.equal(revertOf(MULTICALL_FAILED, "execution reverted", registry).text, 'Error("Multicall3: call failed")');
  assert.equal(revertOf(revertData("Panic(uint256)", "uint256", [0x11n]), "x", registry).text, "Panic(code: 17)");
  assert.deepEqual(revertOf("0xdeadbeef", "execution reverted", registry), { data: "0xdeadbeef", error: null, text: "execution reverted (0xdeadbeef)" });
  assert.deepEqual(revertOf("0x", "execution reverted", registry), { data: null, error: null, text: "execution reverted" });
  for (const m of ["gas required exceeds allowance (16777216)", "exceeds block gas limit", "intrinsic gas too high"]) assert.ok(overGasCap(new AllFailed("eth_estimateGas", [`node: ${m}`])), m);
  assert.equal(overGasCap(new AllFailed("eth_estimateGas", ["node: execution reverted"])), false);
});

// ---------------------------------------------------------------------------------------------
// V3

test("header: chain_getHeader re-encoded and refused unless it hashes to the block hash", async () => {
  const c = chains();
  c.v3.add(B, S1);
  const reader = new V3Reader(c.env.v3);
  const h = await reader.header(B.hash);
  assert.equal(h.number, 118_637);
  assert.equal(bytesToHex(h.stateRoot), bundle.header.stateRoot);
  // The node changes a digest item: the header no longer hashes to the hash asked for.
  c.v3.add({ ...S1, hash: B.hash });
  await assert.rejects(reader.header(B.hash), V3Error);
  await assert.rejects(reader.header(S0.hash), /no header/);
});

test("finalizedHead and setIdAt: the head, its header, and Grandpa.CurrentSetId in its state", async () => {
  const c = chains();
  c.v3.add(S1);
  c.v3.finalized = S1.hash;
  const head = await new V3Reader(c.env.v3).finalizedHead();
  assert.deepEqual([head.number, head.hash, head.setId], [121_706, S1.hash, 34n]);
});

test("cleanProof: an answer for a later block is asked again at that block; one that keeps moving is V3Moved", async () => {
  const c = chains();
  c.v3.add(S0, B);
  c.v3.prove = proveFrom([S0, B]);
  const reader = new V3Reader(c.env.v3);
  const p = await reader.cleanProof(118_400);
  assert.deepEqual(p.block, { number: B.number, hash: B.hash });
  assert.equal(bytesToHex(p.scale), B.proof);
  assert.deepEqual(
    c.seen.filter((s) => s.method === "grandpa_proveFinality").map((s) => s.params[0]),
    [118_400, 118_637],
  );
  // Finality keeps moving: every answer carries headers.
  const moving = decodeFinalityProof(hexToBytes(B.proof));
  c.v3.prove = () => bytesToHex(concatBytes(moving.block, encodeCompact(moving.justification.length), moving.justification, encodeCompact(1), encodeRpcHeader(B.header)));
  await assert.rejects(reader.cleanProof(118_400), V3Moved);
  // A proof whose block is not its justification's target.
  c.v3.prove = () => bytesToHex(concatBytes(hexToBytes(S0.hash), encodeCompact(moving.justification.length), moving.justification, encodeCompact(0)));
  await assert.rejects(reader.cleanProof(118_637), /not for the block its justification targets/);
  c.v3.prove = () => null;
  await assert.rejects(reader.cleanProof(118_637), /gave no proof/);
});

test("lockProofs: lock 1's child root and commitment walk from #118,637's state root; a child proof without the root items is refused", async () => {
  const c = chains();
  const root = bundle.childRoot.proof.nodes as Hex[];
  const slot = bundle.slot.proof.nodes as Hex[];
  c.v3.lockProofs(B.hash, root, [...root, ...slot]);
  const reader = new V3Reader(c.env.v3);
  const p = await reader.lockProofs({ number: B.number, hash: B.hash }, hexToBytes(bundle.header.stateRoot), hexToBytes(bundle.vault.trieId), 1n);
  assert.equal(bytesToHex(p.value), bundle.lock.commitment);
  assert.equal(bytesToHex(p.childRoot), bundle.childRoot.root);
  assert.deepEqual(p.slotProof.map(bytesToHex), slot);
  c.v3.lockProofs(B.hash, root, slot);
  await assert.rejects(reader.lockProofs({ number: B.number, hash: B.hash }, hexToBytes(bundle.header.stateRoot), hexToBytes(bundle.vault.trieId), 1n), /main-trie items/);
  c.v3.lockProofs(B.hash, root, [...root, ...slot]);
  await assert.rejects(reader.lockProofs({ number: B.number, hash: B.hash }, hexToBytes(bundle.header.stateRoot).fill(1), hexToBytes(bundle.vault.trieId), 1n), /root node/);
});

test("setChanges: from set 32, the three changes, each found with one grandpa_proveFinality 3,500 blocks into its set, each verified", async () => {
  const c = chains();
  c.v3.add(S0, S1, S2);
  c.v3.prove = proveFrom([S0, S1, S2]);
  const reader = new V3Reader(c.env.v3);
  const keys = KEYS.map((k) => hexToBytes(k));
  const found = await reader.setChanges({ number: 116_992, setId: 32n, keys, activatedAt: 114_535 }, 3, crypto);
  assert.deepEqual(
    found.map((s) => [s.number, s.hash, s.setId, s.asked, s.unknownHeaders, bytesToHex(s.signers.hint).length]),
    [
      [118_123, S0.hash, 32n, 118_035, 1, 10],
      [121_706, S1.hash, 33n, 121_623, 1, 10],
      [125_299, S2.hash, 34n, 125_206, 1, 10],
    ],
  );
  assert.deepEqual(found[2]?.next.map(bytesToHex), KEYS);
  // Without the set's start, each change is asked for at the block after the one before.
  const plain = await reader.setChanges({ number: 116_992, setId: 32n, keys, activatedAt: null }, 1, crypto);
  assert.equal(plain[0]?.asked, 116_993);
});

test("setChanges: a block that changes no set, or a node with no proof, is no set change", async () => {
  const c = chains();
  c.v3.add(S0, B);
  // The node answers with lock 1's block #118,637, signed by set 33 but changing none.
  c.v3.prove = proveFrom([B]);
  const reader = new V3Reader(c.env.v3);
  const keys = KEYS.map((k) => hexToBytes(k));
  await assert.rejects(reader.setChanges({ number: 118_123, setId: 33n, keys, activatedAt: 118_123 }, 1, crypto), /no set change of set 33 found after #118,123: #121,623: no proof; #118,124: #118,637 changes no set/);
  c.v3.prove = () => null;
  await assert.rejects(reader.setChanges({ number: 118_123, setId: 33n, keys, activatedAt: null }, 1, crypto), V3Error);
});

test("nextV3SetChange: V3's fixed schedule, every 6 hours at 01:54:06, 07:54:06, 13:54:06 and 19:54:06 UTC", () => {
  const t = (iso: string) => Date.parse(iso);
  assert.equal(nextV3SetChange(t("2026-10-26T17:40:00Z")), t("2026-10-26T19:54:06Z"));
  assert.equal(nextV3SetChange(t("2026-10-26T19:54:06Z")), t("2026-10-27T01:54:06Z"));
  assert.equal(nextV3SetChange(t("2026-10-26T23:59:59Z")), t("2026-10-27T01:54:06Z"));
  assert.equal(nextV3SetChange(t("2026-10-27T00:00:00Z")), t("2026-10-27T01:54:06Z"));
});
