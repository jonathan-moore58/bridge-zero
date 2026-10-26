// planMint on fake chains that answer with recorded V3 data: lock 1's bundle at #118,637 and the set
// changes #118,123, #121,706 and #125,299, with the light client in states the relay records show
// it in (set 32 at #116,992, set 33 at #118,614). Each path is taken where it applies and its
// calldata checked: lock 1's own mint (row 55) without the account proof, and each importHeader
// byte for byte against the dataHash the relayer recorded for that set change. Then the statuses:
// minted, moved, waiting, blocked, failed, and the fallbacks when the node does not serve a block's
// state. Nothing leaves the machine.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { decodeFunctionData, parseAbi, type Hex as ViemHex } from "viem";
import { blake2b256, eventTopic, keccak256 } from "../src/lib/hashes.ts";
import { bytesToHex, hexToBytes, type Hex } from "../src/lib/hex.ts";
import { importAndMintCalldata, mintCalldata, MULTICALL3, type LockProof } from "../src/lib/proof/calldata.ts";
import { clientCrypto, signersHint } from "../src/lib/proof/grandpa.ts";
import { CHECK_KEYS, lockRefOf, PlanError, planMint, type Check, type LockRef, type PlanOptions } from "../src/lib/proof/plan.ts";
import { decodeFinalityProof, decodeJustification } from "../src/lib/proof/scale.ts";
import { lockCommitment } from "../src/lib/proofs.ts";
import {
  B,
  bundle,
  enc,
  fakeChains,
  fixture,
  HELD_116992,
  HELD_118614,
  KEYS,
  LIGHT_CLIENT,
  LOCK1,
  MINTER,
  proveFrom,
  repo,
  restoreFetch,
  revertData,
  RpcFail,
  S0,
  S1,
  S2,
  VAULT,
  type Chains,
  type V3Block,
} from "./fake-chains.ts";

const crypto = clientCrypto(ed25519, sha512);
const opts = (more: PlanOptions = {}): PlanOptions => ({ crypto, from: "0x000000000000000000000000000000000000beef", ...more });
/** Multicall3's address as a plan names it, in lower case. */
const MULTICALL = MULTICALL3.toLowerCase();

afterEach(restoreFetch);

const ABI = parseAbi([
  "function importAndMint(bytes header, bytes finalityProof, bytes signers, (bytes32 blockHash, bytes[] accountProof, bytes[] childRootProof, bytes[] slotProof, address recipient, uint256 amount, uint256 nonce) p)",
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);

/** The relayer's own imports of the V3 set changes, by block: the keccak-256 of the calldata it sent. */
const relayed = new Map<number, string>();
for (const line of readFileSync(join(repo, "deployments", "relay-sepolia-0xd9838a86cf83c28ee486544060d1ca4ca2971071.jsonl"), "utf8").trim().split("\n")) {
  const e = JSON.parse(line) as { chain: string; method: string; block: { number: number }; dataHash: string };
  if (e.chain === "v3" && e.method === "importHeader") relayed.set(e.block.number, e.dataHash);
}

// ---------------------------------------------------------------------------------------------
// The scenes

/** The light client at set 33 since #118,123, its latest #118,614 (the relayer's head import before lock 1), or another. */
function atSet33(c: Chains, latest: { number: number; hash: Hex } = HELD_118614): void {
  Object.assign(c.sepolia.client, { setId: 33n, latest, sets: [{ setId: 33n, activatedAt: S0.number, keys: KEYS }] });
}

/** The light client at set 32 since #114,535, its latest #116,992. */
function atSet32(c: Chains, activatedAt = 114_535): void {
  Object.assign(c.sepolia.client, { setId: 32n, latest: HELD_116992, sets: [{ setId: 32n, activatedAt, keys: KEYS }] });
}

/** V3's finalized head, the blocks it knows and the justified blocks its grandpa_proveFinality answers with. */
function headAt(c: Chains, head: V3Block, ends: V3Block[] = []): void {
  c.v3.add(...ends, head);
  c.v3.finalized = head.hash;
  c.v3.prove = proveFrom([...ends, head]);
}

/** Lock 1's proofs as the node serves them at #118,637 (the bundle's), #121,706 and #125,299 (the capture's). */
function lockProofs(c: Chains, ...at: V3Block[]): void {
  for (const b of at) {
    if (b === B) c.v3.lockProofs(B.hash, bundle.childRoot.proof.nodes, [...bundle.childRoot.proof.nodes, ...bundle.slot.proof.nodes]);
    else {
      const f = fixture.changes.find((x: { number: number }) => x.number === b.number).lock1;
      c.v3.lockProofs(b.hash, f.rootProof, f.childProof);
    }
  }
}

const rootOf = (b: V3Block): Hex[] => (b === B ? bundle.childRoot.proof.nodes : fixture.changes.find((x: { number: number }) => x.number === b.number).lock1.rootProof);
/** The child-trie items of what the node served: the ones not in the root proof. */
const slotOf = (b: V3Block): Hex[] => {
  if (b === B) return bundle.slot.proof.nodes;
  const f = fixture.changes.find((x: { number: number }) => x.number === b.number).lock1;
  return f.childProof.filter((x: Hex) => !f.rootProof.includes(x));
};

const proofAt = (b: V3Block): LockProof => ({
  blockHash: hexToBytes(b.hash),
  accountProof: [],
  childRootProof: rootOf(b).map((x) => hexToBytes(x)),
  slotProof: slotOf(b).map((x) => hexToBytes(x)),
  recipient: hexToBytes(LOCK1.recipient),
  amount: LOCK1.amount,
  nonce: 1n,
});

/** Lock 1's importAndMint of README row 55, the account proof left out as the bound minter takes it. */
const LOCK1_MINT = bytesToHex(importAndMintCalldata(hexToBytes(bundle.header.scale), hexToBytes(bundle.finalityProof.scale), hexToBytes(bundle.signers.hint), proofAt(B)));

/** An importAndMint of lock 1 at block b, read back: its header hashes to b, its proof is the node's own for b, its LockProof is the node's proofs at b. */
function assertImportAndMintAt(data: Hex, b: V3Block, setId: bigint): void {
  const d = decodeFunctionData({ abi: ABI, data: data as ViemHex });
  assert.equal(d.functionName, "importAndMint");
  const [header, proof, signers, p] = d.args as unknown as [Hex, Hex, Hex, { blockHash: Hex; accountProof: Hex[]; childRootProof: Hex[]; slotProof: Hex[]; recipient: Hex; amount: bigint; nonce: bigint }];
  assert.equal(bytesToHex(blake2b256(hexToBytes(header))), b.hash);
  assert.equal(proof, b.proof);
  const j = decodeJustification(decodeFinalityProof(hexToBytes(proof)).justification);
  assert.equal(signers, bytesToHex(signersHint(j, KEYS.map((k) => hexToBytes(k)), setId, crypto.verify).hint));
  assert.deepEqual([p.blockHash, p.accountProof, p.childRootProof, p.slotProof], [b.hash, [], rootOf(b), slotOf(b)]);
  assert.deepEqual([p.recipient.toLowerCase(), p.amount, p.nonce], [LOCK1.recipient, LOCK1.amount, 1n]);
}

/** aggregate3's calls in a Multicall3 transaction. */
const callsOf = (data: Hex) => {
  const d = decodeFunctionData({ abi: ABI, data: data as ViemHex });
  assert.equal(d.functionName, "aggregate3");
  return d.args[0] as readonly { target: Hex; allowFailure: boolean; callData: Hex }[];
};

/** An importHeader of set change s, byte for byte the call the relayer sent for it (its recorded dataHash). */
function assertRelayedImport(call: { target: Hex; allowFailure: boolean; callData: Hex }, s: V3Block): void {
  assert.equal(call.target.toLowerCase(), LIGHT_CLIENT);
  assert.equal(call.allowFailure, false);
  const recorded = relayed.get(s.number);
  assert.ok(recorded, `the record has the import of #${s.number}`);
  assert.equal(bytesToHex(keccak256(hexToBytes(call.callData))), recorded);
}

const proveAsks = (c: Chains): number[] => c.seen.filter((s) => s.method === "grandpa_proveFinality").map((s) => s.params[0] as number);
const states = (checks: Check[]) => Object.fromEntries(checks.map((c) => [c.key, c.state]));
const ALL_PASSED = Object.fromEntries(CHECK_KEYS.map((k) => [k, "passed"]));
const at = (lock: LockRef, block: number): LockRef => ({ ...lock, block });

// ---------------------------------------------------------------------------------------------
// The paths

test("head: the client at V3's set, below the lock: one importAndMint at V3's head, lock 1's own mint of row 55", async () => {
  const c = fakeChains();
  atSet33(c);
  headAt(c, B);
  lockProofs(c, B);
  const seen: Check[] = [];
  const plan = await planMint(LOCK1, c.env, opts({ onCheck: (x) => seen.push(x) }));
  assert.equal(plan.status, "ready", plan.why);
  assert.equal(plan.path, "head");
  assert.equal(plan.txs.length, 1);
  const tx = plan.txs[0]!;
  assert.equal(tx.to, MINTER);
  assert.equal(tx.data, LOCK1_MINT);
  assert.equal(hexToBytes(tx.data).length, 3_364);
  assert.deepEqual([tx.gas, tx.gasLimit, tx.gasFrom], [2_466_245n, 2_712_869n, "estimate"]);
  assert.equal(tx.title, "Import V3 #118,637 and mint 1 wtPOT");
  assert.deepEqual(states(plan.checks), ALL_PASSED);
  assert.deepEqual(plan.target, { number: 118_637, hash: B.hash, setId: 33n, signatures: 2, authorities: 2, imported: true });
  // Each check started, then passed, in the contracts' order.
  assert.deepEqual(
    seen.filter((x) => x.state === "passed").map((x) => x.key),
    ["header", "sigs", "proof", "commit", "nonce"],
  );
  assert.ok(c.seen.every((s) => s.method !== "eth_simulateV1"), "one transaction needs no simulation");
  const estimate = c.seen.find((s) => s.method === "eth_estimateGas");
  assert.deepEqual(estimate?.params, [{ from: "0x000000000000000000000000000000000000beef", to: MINTER, data: LOCK1_MINT }, "latest"]);
});

test("mint: the client holds #118,637, at or after the lock: mint(p) there, no import and no signature", async () => {
  const c = fakeChains();
  atSet33(c, { number: B.number, hash: B.hash });
  c.sepolia.client.held.set(B.hash, { number: B.number, stateRoot: bundle.header.stateRoot, setId: 33n });
  headAt(c, B);
  lockProofs(c, B);
  const plan = await planMint(LOCK1, c.env, opts());
  assert.equal(plan.status, "ready", plan.why);
  assert.equal(plan.path, "mint");
  assert.equal(plan.txs[0]?.data, bytesToHex(mintCalldata(proofAt(B))));
  assert.equal(plan.txs[0]?.gas, 601_970n);
  assert.equal(plan.txs[0]?.title, "Mint 1 wtPOT");
  assert.deepEqual(states(plan.checks), ALL_PASSED);
  assert.match(plan.checks[1]!.detail, /under set 33/);
  assert.deepEqual(plan.target, { number: 118_637, hash: B.hash, setId: 33n, signatures: null, authorities: 2, imported: false });
  assert.deepEqual(proveAsks(c), [], "mint(p) asks for no finality proof");
});

test("mint: a held block whose state root is not V3's header's is refused, and the plan reads at V3's head", async () => {
  const c = fakeChains();
  atSet33(c, { number: B.number, hash: B.hash });
  c.sepolia.client.held.set(B.hash, { number: B.number, stateRoot: `0x${"00".repeat(32)}`, setId: 33n });
  headAt(c, S1, [B]);
  lockProofs(c, S1);
  const plan = await planMint(LOCK1, c.env, opts());
  assert.equal(plan.status, "ready", plan.why);
  assert.equal(plan.path, "change");
  assert.match(plan.why, /mint\(p\) at #118,637 could not be built/);
});

test("change: V3 changed set at #121,706 after the lock: importAndMint of that block imports the change and mints", async () => {
  const c = fakeChains();
  atSet33(c);
  headAt(c, S1);
  lockProofs(c, S1);
  const plan = await planMint(LOCK1, c.env, opts());
  assert.equal(plan.status, "ready", plan.why);
  assert.equal(plan.path, "change");
  assert.deepEqual(plan.read.pending, [{ number: S1.number, hash: S1.hash }]);
  assert.equal(plan.txs.length, 1);
  assert.equal(plan.txs[0]?.to, MINTER);
  assertImportAndMintAt(plan.txs[0]!.data, S1, 33n);
  assert.equal(plan.txs[0]?.title, "Import V3's set change #121,706 and mint 1 wtPOT");
  assert.deepEqual(plan.target, { number: 121_706, hash: S1.hash, setId: 33n, signatures: 2, authorities: 2, imported: true });
  // Found without a scan: one grandpa_proveFinality, 3,500 blocks after the set began (#118,123).
  assert.deepEqual(proveAsks(c), [121_623]);
});

test("self-relay: a lock after #121,706 imports that change (the relayer's own calldata), then importAndMint(#125,299), through Multicall3", async () => {
  const c = fakeChains();
  atSet33(c);
  headAt(c, S2, [S1]);
  lockProofs(c, S2);
  const plan = await planMint(at(LOCK1, 121_800), c.env, opts());
  assert.equal(plan.status, "ready", plan.why);
  assert.equal(plan.path, "selfRelay");
  assert.equal(plan.txs.length, 1);
  const tx = plan.txs[0]!;
  assert.equal(tx.to, MULTICALL);
  const calls = callsOf(tx.data);
  assert.equal(calls.length, 2);
  assertRelayedImport(calls[0]!, S1);
  assert.equal(calls[1]?.target.toLowerCase(), MINTER);
  assertImportAndMintAt(calls[1]!.callData, S2, 34n);
  assert.equal(tx.title, "Import 1 set change and mint 1 wtPOT");
  assert.match(tx.detail, /^Through Multicall3 \(0xcA11…CA11\), all or nothing: GrandpaLightClient.importHeader/);
  assert.deepEqual(plan.target?.setId, 34n);
  assert.deepEqual(proveAsks(c), [121_623, 125_206]);
});

test("self-relay at the head: the client at set 32, lock 1 after #118,123: that change (the relayer's calldata), then lock 1's own mint", async () => {
  const c = fakeChains();
  atSet32(c);
  headAt(c, B, [S0]);
  lockProofs(c, B);
  const plan = await planMint(LOCK1, c.env, opts());
  assert.equal(plan.status, "ready", plan.why);
  assert.equal(plan.path, "selfRelay");
  const calls = callsOf(plan.txs[0]!.data);
  assertRelayedImport(calls[0]!, S0);
  assert.deepEqual([calls[1]?.target.toLowerCase(), calls[1]?.allowFailure, calls[1]?.callData], [MINTER, false, LOCK1_MINT]);
  assert.equal(plan.txs[0]?.gas, 30_000n + 2_393_040n + 2_466_245n);
  assert.deepEqual(plan.target, { number: 118_637, hash: B.hash, setId: 33n, signatures: 2, authorities: 2, imported: true });
  assert.deepEqual(proveAsks(c), [118_035, 118_637]);
});

test("a guess past the change: the proof the next set signed is refused, and the change is asked for right after the client's latest", async () => {
  const c = fakeChains();
  atSet32(c, 118_000);
  headAt(c, S2, [S0, S1]);
  lockProofs(c, S1);
  const plan = await planMint(LOCK1, c.env, opts());
  assert.equal(plan.status, "ready", plan.why);
  assert.equal(plan.path, "selfRelay");
  assert.deepEqual(plan.read.pending.map((b) => b.number), [118_123, 121_706, 125_299]);
  // #121,500 gave #121,706, signed by set 33, not 32; #116,993 gave #118,123. Then one ask per set.
  assert.deepEqual(proveAsks(c), [121_500, 116_993, 121_623, 125_206]);
  const calls = callsOf(plan.txs[0]!.data);
  assert.equal(calls.length, 2, "the mint at #121,706, the first change after the lock: #125,299 is not imported");
  assertRelayedImport(calls[0]!, S0);
  assertImportAndMintAt(calls[1]!.callData, S1, 33n);
});

test("past the cap: the Multicall3 transaction is split, and the one after the first is measured with eth_simulateV1", async () => {
  const c = fakeChains();
  atSet32(c);
  headAt(c, S2, [S0, S1]);
  lockProofs(c, S2);
  const run = c.sepolia.run;
  c.sepolia.run = (tx) =>
    tx.to.toLowerCase() === MULTICALL3.toLowerCase() && c.sepolia.inner(tx.data).length > 2 ? { fail: new RpcFail(-32000, "gas required exceeds allowance (16777216)") } : run(tx);
  const plan = await planMint(at(LOCK1, 121_800), c.env, opts());
  assert.equal(plan.status, "ready", plan.why);
  assert.deepEqual(
    plan.txs.map((t) => [t.to, t.title, t.gasFrom]),
    [
      [MULTICALL, "1 of 2: Import 2 set changes", "estimate"],
      [MINTER, "2 of 2: Import V3's set change #125,299 and mint 1 wtPOT", "simulation"],
    ],
  );
  const calls = callsOf(plan.txs[0]!.data);
  assertRelayedImport(calls[0]!, S0);
  assertRelayedImport(calls[1]!, S1);
  assertImportAndMintAt(plan.txs[1]!.data, S2, 34n);
  assert.equal(plan.txs[1]?.gasLimit, 2_712_869n);
  // Each transaction in a simulated block of its own, in order.
  const sim = c.seen.find((s) => s.method === "eth_simulateV1");
  const blocks = (sim?.params[0] as { blockStateCalls: { calls: { to: string }[] }[] }).blockStateCalls;
  assert.deepEqual(
    blocks.map((b) => b.calls.map((x) => x.to)),
    [[MULTICALL], [MINTER]],
  );
  assert.match(plan.why, /2 transactions, sent one after the other/);
});

test("without eth_simulateV1, the transactions after the first are measured once the one before is mined", async () => {
  const c = fakeChains();
  atSet32(c);
  headAt(c, S2, [S0, S1]);
  lockProofs(c, S2);
  c.sepolia.simulateAvailable = false;
  c.sepolia.code.clear();
  const plan = await planMint(at(LOCK1, 121_800), c.env, opts());
  assert.equal(plan.status, "ready", plan.why);
  // No Multicall3 at its address: each call a transaction of its own.
  assert.deepEqual(
    plan.txs.map((t) => [t.to, t.gasFrom]),
    [
      [LIGHT_CLIENT, "estimate"],
      [LIGHT_CLIENT, null],
      [MINTER, null],
    ],
  );
  assert.equal(plan.txs[1]?.gasLimit, null);
  assert.match(plan.why, /does not hold Multicall3's code/);
  assert.match(plan.why, /plan again then/);
});

// ---------------------------------------------------------------------------------------------
// Statuses

test("minted: used(1) is true, and nothing is built; with evenIfMinted the dry run reverts NonceAlreadyUsed(1) after the other checks", async () => {
  const c = fakeChains();
  atSet33(c);
  headAt(c, B);
  lockProofs(c, B);
  c.sepolia.minter.used.add(1n);
  const plan = await planMint(LOCK1, c.env, opts());
  assert.equal(plan.status, "minted");
  assert.deepEqual(plan.txs, []);
  assert.ok(c.seen.every((s) => s.method !== "eth_estimateGas" && s.method !== "grandpa_proveFinality"));
  const again = await planMint(LOCK1, c.env, opts({ evenIfMinted: true }));
  assert.equal(again.status, "minted");
  assert.equal(again.txs[0]?.data, LOCK1_MINT);
  assert.deepEqual(again.revert, { tx: 0, call: null, text: "NonceAlreadyUsed(nonce: 1)", name: "NonceAlreadyUsed", data: revertData("NonceAlreadyUsed(uint256)", "uint256", [1n]) });
  assert.deepEqual(states(again.checks), { header: "passed", sigs: "passed", proof: "passed", commit: "passed", nonce: "failed" });
});

test("through Multicall3, the call that reverted is named: the mint, NonceAlreadyUsed(1)", async () => {
  const c = fakeChains();
  atSet33(c);
  headAt(c, S2, [S1]);
  lockProofs(c, S2);
  c.sepolia.minter.used.add(1n);
  const plan = await planMint(at(LOCK1, 121_800), c.env, opts({ evenIfMinted: true }));
  assert.equal(plan.status, "minted");
  assert.deepEqual([plan.revert?.tx, plan.revert?.call, plan.revert?.name], [0, 1, "NonceAlreadyUsed"]);
  assert.match(plan.checks[4]!.detail, /call 2 \(importAndMint\): NonceAlreadyUsed\(nonce: 1\)/);
});

test("moved: another import landed first (NotNewer), so the plan is built again", async () => {
  const c = fakeChains();
  atSet33(c);
  headAt(c, B);
  lockProofs(c, B);
  c.sepolia.run = () => ({ revert: revertData("NotNewer(uint32,uint32)", "uint32,uint32", [118_637, 118_700]) });
  const plan = await planMint(LOCK1, c.env, opts());
  assert.equal(plan.status, "moved");
  assert.equal(plan.revert?.name, "NotNewer");
});

test("waiting: V3 has not finalized the lock's block, or the V3 node is behind the light client", async () => {
  const c = fakeChains();
  atSet32(c);
  headAt(c, S0);
  const plan = await planMint(LOCK1, c.env, opts());
  assert.equal(plan.status, "waiting");
  assert.match(plan.why, /not finalized the lock's block #118,636 yet \(finalized: #118,123\)/);
  atSet33(c);
  const behind = await planMint(at(LOCK1, 118_000), c.env, opts());
  assert.equal(behind.status, "waiting");
  assert.match(behind.why, /The V3 node is behind the light client/);
});

test("paused: a held block still mints (mint(p) imports nothing); without one, blocked until the admin acts", async () => {
  const c = fakeChains();
  atSet33(c, { number: B.number, hash: B.hash });
  c.sepolia.client.paused = true;
  c.sepolia.client.held.set(B.hash, { number: B.number, stateRoot: bundle.header.stateRoot, setId: 33n });
  headAt(c, B);
  lockProofs(c, B);
  assert.equal((await planMint(LOCK1, c.env, opts())).path, "mint");
  atSet33(c);
  const plan = await planMint(LOCK1, c.env, opts());
  assert.equal(plan.status, "blocked");
  assert.match(plan.why, /paused/);
});

test("failed: the node serves a proof with a flipped byte, which walks to nothing", async () => {
  const c = fakeChains();
  atSet33(c);
  headAt(c, B);
  const slot = bundle.slot.proof.nodes.slice();
  slot[0] = `${slot[0].slice(0, 40)}${slot[0][40] === "0" ? "1" : "0"}${slot[0].slice(41)}`;
  c.v3.lockProofs(B.hash, bundle.childRoot.proof.nodes, [...bundle.childRoot.proof.nodes, ...slot]);
  const plan = await planMint(LOCK1, c.env, opts());
  assert.equal(plan.status, "failed");
  assert.deepEqual(states(plan.checks), { header: "passed", sigs: "passed", proof: "failed", commit: "waiting", nonce: "waiting" });
  assert.ok(c.seen.every((s) => s.method !== "eth_estimateGas"), "nothing is dry-run");
});

test("failed: fields that do not give the lock's commitment, and a commitment V3's state does not hold", async () => {
  const c = fakeChains();
  atSet33(c);
  headAt(c, B);
  lockProofs(c, B);
  const wrong = await planMint({ ...LOCK1, amount: 2n * LOCK1.amount }, c.env, opts());
  assert.equal(wrong.status, "failed");
  assert.deepEqual(c.seen, [], "refused before any read");
  // 2 tPOT with its own commitment: a lock the vault never stored.
  const commitment = lockCommitment({ v3ChainId: 420_420_777n, vault: bundle.vault.address, dstChainId: 11_155_111n, minter: MINTER, recipient: LOCK1.recipient, amountNative: 2n * LOCK1.amount, nonce: 1n });
  const plan = await planMint({ ...LOCK1, amount: 2n * LOCK1.amount, commitment }, c.env, opts());
  assert.equal(plan.status, "failed");
  assert.deepEqual(states(plan.checks), { header: "passed", sigs: "passed", proof: "passed", commit: "failed", nonce: "waiting" });
  assert.match(plan.checks[3]!.detail, new RegExp(`holds ${bundle.lock.commitment}`));
});

// ---------------------------------------------------------------------------------------------
// Fallbacks and forced paths

test("the held block's state pruned: mint(p) gives way to importAndMint at the change", async () => {
  const c = fakeChains();
  atSet33(c, { number: B.number, hash: B.hash });
  c.sepolia.client.held.set(B.hash, { number: B.number, stateRoot: bundle.header.stateRoot, setId: 33n });
  headAt(c, S1, [B]);
  lockProofs(c, B, S1);
  c.v3.pruned.add(B.hash);
  const plan = await planMint(LOCK1, c.env, opts());
  assert.equal(plan.status, "ready", plan.why);
  assert.equal(plan.path, "change");
  assertImportAndMintAt(plan.txs[0]!.data, S1, 33n);
  assert.match(plan.why, /State already discarded/);
});

test("the change's state pruned: the change is imported and the mint is at V3's head", async () => {
  const c = fakeChains();
  atSet32(c);
  headAt(c, B, [S0]);
  lockProofs(c, B);
  c.v3.pruned.add(S0.hash);
  // A lock at or before #118,123 mints at that change, unless its state is gone.
  const plan = await planMint(at(LOCK1, 118_000), c.env, opts());
  assert.equal(plan.status, "ready", plan.why);
  assert.equal(plan.path, "selfRelay");
  const calls = callsOf(plan.txs[0]!.data);
  assertRelayedImport(calls[0]!, S0);
  assert.equal(calls[1]?.callData, LOCK1_MINT);
  assert.match(plan.why, /could not be read/);
});

test("a forced path that does not apply throws PlanError; a forced self-relay of one change", async () => {
  const c = fakeChains();
  atSet32(c);
  headAt(c, B, [S0]);
  lockProofs(c, B);
  await assert.rejects(planMint(LOCK1, c.env, opts({ only: "change" })), PlanError);
  await assert.rejects(planMint(LOCK1, c.env, opts({ only: "head" })), PlanError);
  await assert.rejects(planMint(LOCK1, c.env, opts({ only: "mint" })), PlanError);
  const plan = await planMint(LOCK1, c.env, opts({ only: "selfRelay" }));
  assert.equal(plan.path, "selfRelay");
});

test("a forced self-relay when the lock is before the first change: every change imported, the mint at the head", async () => {
  const c = fakeChains();
  atSet33(c);
  headAt(c, S2, [S1]);
  lockProofs(c, S1, S2);
  assert.equal((await planMint(LOCK1, c.env, opts())).path, "change");
  // The head is the last change: the mint is at it, after the change before it.
  const plan = await planMint(LOCK1, c.env, opts({ only: "selfRelay" }));
  assert.equal(plan.status, "ready", plan.why);
  const calls = callsOf(plan.txs[0]!.data);
  assertRelayedImport(calls[0]!, S1);
  assertImportAndMintAt(calls[1]!.callData, S2, 34n);
});

test("the reads are at the Sepolia block the env names, for a plan as of then", async () => {
  const c = fakeChains();
  atSet33(c);
  headAt(c, B);
  lockProofs(c, B);
  const plan = await planMint(LOCK1, { ...c.env, sepoliaBlock: "0xb6e23e" }, opts());
  assert.equal(plan.status, "ready", plan.why);
  const sepoliaCalls = c.seen.filter((s) => s.url === c.sepolia.endpoint.url);
  assert.ok(sepoliaCalls.length > 0);
  assert.ok(sepoliaCalls.every((s) => s.params[1] === "0xb6e23e"));
  assert.equal(plan.read.sepoliaBlock, "0xb6e23e");
});

test("no call sends or signs: every request the planner made is a read or a dry run", async () => {
  const c = fakeChains();
  atSet32(c);
  headAt(c, S2, [S0, S1]);
  lockProofs(c, S1, S2);
  await planMint(at(LOCK1, 121_800), c.env, opts());
  const methods = new Set(c.seen.map((s) => s.method));
  for (const m of methods) assert.match(m, /^(eth_call|eth_estimateGas|eth_simulateV1|eth_getCode|chain_getFinalizedHead|chain_getHeader|state_getStorage|grandpa_proveFinality|state_getReadProof|state_getChildReadProof)$/);
});

test("lockRefOf: lock 1's Locked log gives the lock planMint takes; another contract's, chain's or minter's gives none", () => {
  const { env } = fakeChains();
  const word = (h: string) => `0x${h.replace(/^0x/, "").padStart(64, "0")}`;
  const data = (dstChainId: bigint, minter: Hex) => enc("uint256,address,uint256,bytes32", [dstChainId, minter, LOCK1.amount, LOCK1.commitment]);
  const log = {
    address: VAULT,
    topics: [eventTopic("Locked(uint256,address,address,uint256,address,uint256,bytes32)"), word("01"), word(LOCK1.recipient), word(LOCK1.recipient)],
    data: data(11_155_111n, MINTER),
    blockNumber: "0x1cf6c",
  };
  assert.deepEqual(lockRefOf(log, env), LOCK1);
  assert.equal(lockRefOf({ ...log, address: MINTER }, env), null);
  assert.equal(lockRefOf({ ...log, data: data(1n, MINTER) }, env), null);
  assert.equal(lockRefOf({ ...log, data: data(11_155_111n, LIGHT_CLIENT) }, env), null);
  assert.equal(lockRefOf({ ...log, topics: log.topics.slice(0, 3) }, env), null);
});
