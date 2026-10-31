// The Verify page's lists and words, apart from the checks themselves (proof-verify.test.ts): the
// picker's transfers from the records (six locks and four burns, each group newest first), a lock
// past them as read from V3 (its log not read, none, or minted by used(n)), what the "Another lock
// or burn" field takes, the ids the page goes by and the destination the top bar shows
// on it, each step's title, the verdict of a run (Verified only when every check passed on the mint
// itself; the way back always Trusted), and the commands that check the same without the page.
// Offline.

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildRecords } from "../build/records.ts";
import { destOf, refOf } from "../src/app/dests.ts";
import { bareMeta, beyondLock, burnRows, commandsOf, dayTime, lockRows, readField, verifyDest, type VerifyHead } from "../src/app/verify-model.ts";
import { signedChecked, stepTitles, verdictOf, waitingRun, type Facts, type Run, type StepState } from "../src/lib/proof/verdict.ts";

const here = dirname(fileURLToPath(import.meta.url));
const records = buildRecords(process.env.RECORDS_ROOT ?? join(here, "..", ".."));

test("the picker lists the recorded locks and burns from the records, each group newest first; lock 3 came from a Polkadot wallet", () => {
  const locks = lockRows(records);
  assert.deepEqual(
    locks.map((r) => [r.id, r.dest, r.label, r.done]),
    [
      ["lock-5", "arbitrum-sepolia", "Lock 5", true],
      ["lock-4", "base-sepolia", "Lock 4", true],
      ["lock-3", "sepolia", "Lock 3", true],
      ["lock-2", "sepolia", "Lock 2", true],
      ["lock-1", "sepolia", "Lock 1", true],
      ["lock-0", "sepolia", "Lock 0", true],
    ],
  );
  assert.deepEqual(
    locks.filter((r) => r.substrate).map((r) => r.id),
    ["lock-3"],
  );
  assert.ok(locks.every((r) => r.dir === "in"));
  assert.equal(locks.find((r) => r.id === "lock-0")?.amount, 100_000_000_000_000n);
  assert.equal(dayTime(locks.find((r) => r.id === "lock-4")!.at), "Oct 27, 23:55");
  const burns = burnRows(records);
  assert.deepEqual(
    burns.map((r) => [r.id, r.label, r.done]),
    [
      ["burn-arbitrum-sepolia-0", "Burn 0 on Arbitrum Sepolia", true],
      ["burn-base-sepolia-0", "Burn 0 on Base Sepolia", true],
      ["burn-1", "Burn 1", true],
      ["burn-0", "Burn 0", true],
    ],
  );
  assert.ok(burns.every((r) => r.dir === "back"));
  // Every row's id is one the page and the routes take.
  for (const r of [...locks, ...burns]) assert.deepEqual(refOf(r.id)?.dir, r.dir, r.id);
});

test("a lock past the records: a Locked log not read says so, never that there is none; one read is Minted or Locked by used(n), with no chip when that was not answered", () => {
  const failed = beyondLock(7, "failed");
  assert.deepEqual(failed, { n: 7, read: "failed", row: null });
  assert.equal(bareMeta(failed.read), "Its Locked log could not be read: V3's EVM RPC did not answer");
  assert.doesNotMatch(bareMeta(failed.read), /No Locked log/);
  assert.equal(bareMeta("reading"), "Reading its Locked log on V3…");
  // Read, and none: a lock from a Polkadot wallet, which its mint names.
  const none = beyondLock(7, null);
  assert.deepEqual(none, { n: 7, read: "read", row: null });
  assert.match(bareMeta(none.read), /^No Locked log through V3's EVM RPC: a lock from a Polkadot wallet/);
  // Read, with its log: its row, done by used(7) on the chain it names.
  const log = { dest: "sepolia" as const, amount: 100_000_000_000n, at: Date.UTC(2026, 9, 28, 9, 30), minted: true };
  const minted = beyondLock(7, log);
  assert.equal(minted.read, "read");
  assert.deepEqual(minted.row, { id: "lock-7", dir: "in", dest: "sepolia", n: 7, amount: 100_000_000_000n, at: log.at, label: "Lock 7", substrate: false, done: true });
  assert.equal(refOf(minted.row!.id)?.dir, "in");
  assert.equal(beyondLock(7, { ...log, minted: false }).row?.done, false);
  assert.equal(beyondLock(7, { ...log, minted: null }).row?.done, null);
  assert.ok(Number.isNaN(beyondLock(7, { ...log, at: null }).row?.at));
});

test("the field takes lock-7, a bare 7, burn-base-sepolia-0 and a transaction hash, and says what it does not take", () => {
  assert.deepEqual(readField("lock-7"), { kind: "id", id: "lock-7" });
  assert.deepEqual(readField(" 7 "), { kind: "id", id: "lock-7" });
  assert.deepEqual(readField("burn-base-sepolia-0"), { kind: "id", id: "burn-base-sepolia-0" });
  assert.deepEqual(readField("Burn-1"), { kind: "id", id: "burn-1" });
  assert.deepEqual(readField("burn arbitrum-sepolia 0"), { kind: "id", id: "burn-arbitrum-sepolia-0" });
  const hash = `0x${"ab".repeat(32)}`;
  assert.deepEqual(readField(hash.toUpperCase().replace("0X", "0x")), { kind: "hash", hash });
  for (const bad of ["", "0x1234", "lock-x", "burn-optimism-0", "07", "-1"]) assert.equal(readField(bad).kind, "bad", JSON.stringify(bad));
});

test("the page's ids are the receipts' ids, and the top bar shows the transfer's destination, as on a receipt", () => {
  assert.deepEqual(refOf("lock-7"), { dir: "in", n: 7 });
  assert.deepEqual(refOf("burn-0"), { dir: "back", n: 0, dest: "sepolia" });
  assert.deepEqual(refOf("burn-base-sepolia-0"), { dir: "back", n: 0, dest: "base-sepolia" });
  assert.equal(refOf("verify"), null);
  const head = (dest: VerifyHead["dest"]): VerifyHead => ({ dir: "in", dest, label: "Lock 6", at: null, amount: null, substrate: false });
  // A burn's id names its chain.
  assert.equal(verifyDest("burn-arbitrum-sepolia-0", undefined, null), "arbitrum-sepolia");
  // A recorded lock: the records name its chain at once.
  assert.equal(verifyDest("lock-4", undefined, head("base-sepolia")), "base-sepolia");
  // A lock beyond the records: none while its chain is read, then the one its Locked log names.
  assert.equal(verifyDest("lock-6", { status: "resolving", head: null }, null), null);
  assert.equal(verifyDest("lock-6", { status: "run", head: head("base-sepolia"), run: waitingRun("in", "minted", "Base Sepolia") }, null), "base-sepolia");
  assert.equal(verifyDest("lock-99", { status: "none", why: "" }, null), null);
  assert.equal(verifyDest("nothing", undefined, head("sepolia")), null);
});

test("each step's title, in the destination's words: the way in, a lock not minted yet, the fallback, the way back", () => {
  const titles = (dir: Run["dir"], route: Run["route"], chain: string) => stepTitles(dir, route, chain).map(([, t]) => t);
  assert.deepEqual(titles("in", "minted", "Base Sepolia"), ["Header hash", "Validator keys", "Validator signatures", "Storage proofs", "Commitment", "Accepted on Base Sepolia"]);
  assert.equal(titles("in", "unminted", "Sepolia")[5], "Would Sepolia accept it?");
  assert.equal(titles("in", "fallback", "Sepolia")[5], "Accepted on Sepolia");
  assert.deepEqual(titles("back", "minted", "Arbitrum Sepolia"), ["Burn on Arbitrum Sepolia", "Burn id", "Released on V3", "The release itself"]);
});

/** A finished run whose steps are in `states`. */
function runOf(dir: Run["dir"], route: Run["route"], states: StepState[], more: Partial<Run> = {}): Run {
  const w = waitingRun(dir, route, "Sepolia");
  return { ...w, steps: w.steps.map((s, i) => ({ ...s, state: states[i] ?? "waiting", sub: `step ${i + 1}` })), done: true, ms: 1_600, reads: 14, ...more };
}

test("the verdict: Verified only when all six passed on the mint itself; one not checked gives Not all checked; one failed gives Did not check out at it; the way back is always Trusted", () => {
  const P: StepState[] = ["passed", "passed", "passed", "passed", "passed", "passed"];
  const ok = verdictOf(runOf("in", "minted", P), "Sepolia");
  assert.deepEqual([ok.kind, ok.chip, ok.title, ok.sub], ["verified", "Verified", "Verified in your browser", "6 of 6 checks · 1.6 s · 14 reads"]);
  // A lookup that searched logs in windows: the count is a floor.
  assert.equal(verdictOf(runOf("in", "minted", P, { readsFloor: true }), "Sepolia").sub, "6 of 6 checks · 1.6 s · at least 14 reads");
  // Verified needs every step passed: a step in any other state is not a pass.
  assert.equal(verdictOf(runOf("in", "minted", ["passed", "passed", "passed", "passed", "passed", "open"]), "Sepolia").kind, "partial");
  const partial = verdictOf(runOf("in", "minted", ["passed", "skipped", "skipped", "passed", "passed", "passed"]), "Sepolia");
  assert.deepEqual([partial.kind, partial.chip], ["partial", "Not all checked"]);
  assert.match(partial.sub, /^4 of 6 checks · 2 not checked/);
  const failed = verdictOf(runOf("in", "minted", ["passed", "passed", "passed", "failed", "unreached", "unreached"]), "Sepolia");
  assert.deepEqual([failed.kind, failed.chip, failed.title, failed.failedAt], ["failed", "Did not check out", "Did not check out at step 4 · Storage proofs", 4]);
  const checking = verdictOf({ ...runOf("in", "minted", ["passed", "checking"]), done: false }, "Sepolia");
  assert.deepEqual([checking.kind, checking.chip], ["checking", "Checking"]);
  const disagree = verdictOf(runOf("in", "minted", P, { disagree: true }), "Sepolia");
  assert.deepEqual([disagree.kind, disagree.chip, disagree.title], ["disagree", "Cross-check differs", "Verified · a cross-check disagrees"]);
  // A red line under a passed step is a disagreement, and the verdict names it.
  const red = runOf("in", "minted", P);
  red.steps[4] = { ...red.steps[4]!, lines: [{ ok: false, text: "the Locked log at V3 #101,009 names other fields" }] };
  const redV = verdictOf(red, "Sepolia");
  assert.equal(redV.kind, "disagree");
  assert.equal(redV.sub, "The Locked log at V3 #101,009 names other fields · 6 of 6 checks · 1.6 s · 14 reads");
  // From V3 now: a lock not minted yet, and the fallback for a minted one whose mint is not served, which never says Verified.
  const unminted = verdictOf(runOf("in", "unminted", P), "Sepolia");
  assert.deepEqual([unminted.kind, unminted.chip, unminted.title], ["unminted", "Not minted yet", "Not minted yet · Sepolia would accept it"]);
  // Route B by its step 6: minted while it was read, or the dry run not checked.
  const meanwhile = verdictOf(runOf("in", "unminted", ["passed", "passed", "passed", "passed", "passed", "open"]), "Sepolia");
  assert.deepEqual([meanwhile.kind, meanwhile.chip, meanwhile.title], ["partial", "Minted meanwhile", "Minted meanwhile · check again"]);
  const B6: StepState[] = ["passed", "passed", "passed", "passed", "passed", "skipped"];
  assert.equal(verdictOf(runOf("in", "unminted", B6), "Sepolia").title, "Not minted yet · not all checked");
  const unread = verdictOf(runOf("in", "unminted", B6, { usedUnread: true }), "Sepolia");
  assert.deepEqual([unread.kind, unread.chip, unread.title], ["partial", "Not all checked", "Not all checked · whether it is minted was not read"]);
  const fallback = verdictOf(runOf("in", "fallback", P), "Sepolia");
  assert.deepEqual([fallback.kind, fallback.chip], ["partial", "Not all checked"]);
  // The way back: Trusted whatever B1 to B3 say, and B4 is never counted as passed; the title says what B1 and B3 found.
  const back = verdictOf(runOf("back", "minted", ["passed", "passed", "passed", "trusted"]), "Base Sepolia");
  assert.deepEqual([back.kind, back.chip, back.title, back.sub], ["trusted", "Trusted · 2-of-3", "Burned on Base Sepolia, released on V3", "3 checks passed · 1 trusted: the committee's release"]);
  const notYet = verdictOf(runOf("back", "minted", ["passed", "passed", "open", "trusted"]), "Sepolia");
  assert.deepEqual([notYet.kind, notYet.title], ["trusted", "Burned on Sepolia, not released on V3 yet"]);
  const notRead = verdictOf(runOf("back", "minted", ["passed", "passed", "skipped", "trusted"]), "Sepolia");
  assert.deepEqual([notRead.title, notRead.sub], ["Burned on Sepolia, release not checked on V3", "2 checks passed · 1 not checked · 1 trusted: the committee's release"]);
  const noBurn = verdictOf(runOf("back", "minted", ["skipped", "passed", "skipped", "trusted"]), "Sepolia");
  assert.deepEqual([noBurn.kind, noBurn.title], ["trusted", "Burn not checked, release not checked on V3"]);
  for (const v of [back, notYet, notRead, noBurn]) assert.notEqual(v.kind, "verified");
  // The set the run read is checked once its signatures passed: step 3, or B3 (passed, or open under signatures that verified).
  assert.equal(signedChecked(runOf("in", "minted", ["passed", "passed", "failed", "unreached", "unreached", "unreached"])), false);
  assert.equal(signedChecked(runOf("in", "minted", P)), true);
  assert.equal(signedChecked(runOf("back", "minted", ["passed", "passed", "open", "trusted"])), true);
  assert.equal(signedChecked(runOf("back", "minted", ["passed", "passed", "failed", "trusted"])), false);
});

const FACTS: Facts = {
  block: { number: 108_424, hash: "0xc89b7e6c5d7596897e677d464a9cc5ca373a69412f810d3f003d7aa8761e4e6d" },
  setId: 30n,
  checkpoint: { setId: 19n, at: 67_958, keysHash: "0xb8c9", keys: 2, changes: 45, latest: 64n, same: true },
  carried: 0,
  admin: "0xd9838a86cf83c28ee486544060d1ca4ca2971071",
  header: "0x0102",
  mint: { tx: "0x91714c8422a7058c161f5592ff7c59eb62399bc99d5f02d6a9ebc1506c955cba", from: "0xd9838a86cf83c28ee486544060d1ca4ca2971071", data: null },
  nonce: 0n,
  burnId: null,
};

test("the commands that check the same without the page: cast and b2sum, read-only, for a lock and for a burn", () => {
  const sep = destOf("sepolia");
  const rpc = "https://ethereum-sepolia-rpc.publicnode.com";
  const v3 = { vault: "0xa02ee16eb03d2cf1aef199f7658fb8c8e3188ffd", rpc: "https://test-evm-rpc-v3.portaldot.dev" };
  const lock = commandsOf(FACTS, sep, rpc, v3).map((c) => c.cmd);
  assert.ok(lock.includes(`cast call ${sep.minter} "used(uint256)(bool)" 0 --rpc-url ${rpc}`));
  assert.ok(lock.includes(`cast call ${sep.lightClient} "headerOf(bytes32)((uint32,bytes32,uint64))" ${FACTS.block!.hash} --rpc-url ${rpc}`));
  assert.ok(lock.includes(`cast call ${sep.lightClient} "authorities(uint64)(bytes32[])" 30 --rpc-url ${rpc}`));
  assert.ok(lock.includes(`cast call ${sep.minter} --from ${FACTS.mint!.from} --data $(cast tx ${FACTS.mint!.tx} input --rpc-url ${rpc}) --rpc-url ${rpc}`));
  // A mint sent through Multicall3 goes again as its own call to the minter: the transaction's input would be the aggregate.
  const inner = "0x63a1ef5f00";
  const viaMulticall = commandsOf({ ...FACTS, mint: { ...FACTS.mint!, data: inner } }, sep, rpc, v3).map((c) => c.cmd);
  assert.ok(viaMulticall.includes(`cast call ${sep.minter} --from ${FACTS.mint!.from} --data ${inner} --rpc-url ${rpc}`));
  assert.ok(lock.includes("printf 0102 | xxd -r -p | b2sum -l 256"));
  // Locks 0 and 1: the relayer's offline check of their recorded bundles.
  assert.ok(lock.includes("cd relayer && npm ci && npm run check -- --dir ../fixtures/v3-testnet-hero"));
  assert.ok(commandsOf({ ...FACTS, nonce: 1n }, sep, rpc, v3).some((c) => c.cmd.endsWith("--dir ../fixtures/v3-testnet-lock1")));
  assert.ok(!commandsOf({ ...FACTS, nonce: 4n }, destOf("base-sepolia"), rpc, v3).some((c) => c.cmd.includes("npm run check")));
  // A burn: its id and released(burnId) on V3; no used(n), no headerOf of V3's head, which the client need not hold.
  const burnId = "0x1573ff21c0f6cae223a42566b061f39bc0a982dafe451b86b29a8bf5f9219c0e";
  const burn = commandsOf({ ...FACTS, mint: null, nonce: 1n, burnId }, sep, rpc, v3).map((c) => c.cmd);
  assert.ok(burn.includes(`cast call ${sep.minter} "burnIdOf(uint256)(bytes32)" 1 --rpc-url ${rpc}`));
  assert.ok(burn.includes(`cast call ${v3.vault} "released(bytes32)(bool)" ${burnId} --rpc-url ${v3.rpc}`));
  assert.ok(!burn.some((c) => c.includes("used(uint256)") || c.includes("headerOf(") || c.includes("npm run check")));
  // Nothing here sends: no cast send, no private key.
  for (const c of [...lock, ...burn]) assert.ok(!/cast send|--private-key|--account/.test(c), c);
});
