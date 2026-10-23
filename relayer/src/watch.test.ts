// Unit tests of watch.ts, offline: the confirmation rule and the fast cap, the committee's next
// step for a burn (never an approval twice), one round of the watcher over stand-ins for the
// chains and the release tool (a fresh burn, the resume of a half-done release, a crash after an
// approval was sent, a payee the checks refuse, a burn already released, a dry run), where the
// watcher starts looking, the wait between rounds, the member keys, and the lock.
//
//   npm test

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  checkBlock,
  cursorOf,
  DEFAULT_FAST_CAP,
  FINALITY,
  haltRefusal,
  LOCK_STALE,
  MAX_BACKOFF_SECONDS,
  nextStep,
  nextWait,
  parseConfirmations,
  parseMemberKeys,
  qualification,
  readBurnCache,
  readHalt,
  rpcTrouble,
  submitErrorVerdict,
  takeLock,
  tradeOff,
  watchRound,
  writeBurnCache,
  writeHalt,
  type BurnState,
  type Outcome,
  type Ports,
  type RecordedApproval,
  type RecordedRound,
  type Rule,
  type SeenBurn,
} from "./watch.js";

const TPOT = 10n ** 14n;
const FAST3: Rule = { confirmations: 3, fastCap: DEFAULT_FAST_CAP };
const HEADS = { latest: 1_000, finalized: 930 };

describe("the confirmation rule", () => {
  it("reads a burn at the finalized block by default, and n below the latest in fast mode", () => {
    assert.equal(checkBlock(HEADS, FINALITY), 930);
    assert.equal(checkBlock(HEADS, FAST3), 997);
    assert.equal(checkBlock(HEADS, { confirmations: 64, fastCap: TPOT }), 936);
    // n below the latest is under the finalized block: the finalized block, which is never less safe.
    assert.equal(checkBlock({ latest: 1_000, finalized: 990 }, { confirmations: 64, fastCap: TPOT }), 990);
    assert.throws(() => checkBlock({ latest: 900, finalized: 930 }, FAST3), RangeError);
  });

  it("takes a burn once it is final, whatever the mode", () => {
    for (const rule of [FINALITY, FAST3]) {
      const q = qualification({ block: 930, amount: 50n * TPOT }, HEADS, rule);
      assert.ok(q.ok && q.by === "finality", JSON.stringify(q));
    }
  });

  it("waits for finality without --confirmations", () => {
    const q = qualification({ block: 999, amount: TPOT / 2n }, HEADS, FINALITY);
    assert.equal(q.ok, false);
    assert.match(q.why, /not final yet/);
  });

  it("takes a burn with at least n blocks on top of it in fast mode, and not one with fewer", () => {
    const at = (block: number) => qualification({ block, amount: TPOT / 2n }, HEADS, FAST3);
    const deep = at(997);
    assert.ok(deep.ok && deep.by === "fast", JSON.stringify(deep));
    assert.ok(at(950).ok);
    const shallow = at(998);
    assert.equal(shallow.ok, false);
    assert.match(shallow.why, /2 of 3 blocks on top/);
    assert.equal(at(1_000).ok, false);
  });

  it("parses --confirmations from 1 to 64 blocks", () => {
    assert.equal(parseConfirmations("1"), 1);
    assert.equal(parseConfirmations("3"), 3);
    assert.equal(parseConfirmations("64"), 64);
    for (const bad of ["0", "65", "-1", "3.5", "x", "", " 3"]) assert.throws(() => parseConfirmations(bad), /blocks|whole number/, bad);
  });

  it("says the trade-off plainly", () => {
    assert.equal(
      tradeOff(3),
      "fast mode: the committee releases before Sepolia finalizes this burn; a reorg deeper than 3 blocks could undo the burn after the release",
    );
  });
});

describe("the fast cap", () => {
  it("is 1 tPOT by default", () => assert.equal(DEFAULT_FAST_CAP, TPOT));

  it("releases a burn up to the cap fast, and makes a larger one wait for finality", () => {
    const deep = 990;
    const atCap = qualification({ block: deep, amount: TPOT }, HEADS, FAST3);
    assert.ok(atCap.ok && atCap.by === "fast");
    const above = qualification({ block: deep, amount: TPOT + 1n }, HEADS, FAST3);
    assert.equal(above.ok, false);
    assert.match(above.why, /above the fast cap.*waits for finality/);
    // Once final, the cap does not matter.
    const final = qualification({ block: 930, amount: TPOT + 1n }, HEADS, FAST3);
    assert.ok(final.ok && final.by === "finality");
    // Another cap.
    const capped = qualification({ block: deep, amount: 3n * TPOT }, HEADS, { confirmations: 3, fastCap: 5n * TPOT });
    assert.ok(capped.ok && capped.by === "fast");
  });
});

const approval = (member: number, action: RecordedApproval["action"], status: RecordedApproval["status"], onChain = status === "final"): RecordedApproval => ({ member, action, status, onChain });
const round = (status: RecordedRound["status"], ...approvals: RecordedApproval[]): RecordedRound => ({ status, approvals });
const fresh: BurnState = { released: false, op: null, rounds: [] };

describe("the committee's next step for a burn", () => {
  it("opens with the first keyed member when nothing is open, and runs it with the other", () => {
    assert.deepEqual(nextStep(fresh, [1, 2], 2), { kind: "open", member: 1, why: "nothing is open: member 1 opens it" });
    const opened: BurnState = { released: false, op: { approvals: [1], depositor: 1, matches: true }, rounds: [round("open", approval(1, "open", "final"))] };
    const next = nextStep(opened, [1, 2], 2);
    assert.equal(next.kind, "execute");
    assert.equal((next as { member: number }).member, 2);
  });

  it("does nothing for a burn that is released", () => {
    assert.equal(nextStep({ ...fresh, released: true }, [1, 2], 2).kind, "done");
  });

  it("never has a member approve twice: not the opener, nor one the record has approving", () => {
    // Only member 1's key, and member 1 opened it.
    assert.equal(nextStep({ released: false, op: { approvals: [1], depositor: 1, matches: true }, rounds: [] }, [1], 2).kind, "wait");
    // Member 3 opened it: member 1 runs it (the lowest keyed member that has not approved).
    const by3 = nextStep({ released: false, op: { approvals: [3], depositor: 3, matches: true }, rounds: [] }, [1, 2], 2);
    assert.equal(by3.kind === "execute" && by3.member, 1);
    // The record has member 2 approving the open operation although the chain does not show it yet: member 2 is not asked again.
    const lagging = nextStep({ released: false, op: { approvals: [1], depositor: 1, matches: true }, rounds: [round("open", approval(1, "open", "final"), approval(2, "execute", "final", false))] }, [1, 2], 2);
    assert.equal(lagging.kind, "wait");
  });

  it("settles an approval an earlier run submitted before anything else", () => {
    const s: BurnState = { released: false, op: null, rounds: [round("open", approval(1, "open", "submitted"))] };
    assert.equal(nextStep(s, [1, 2], 2).kind, "wait");
  });

  it("leaves to the members an execution that ran without releasing, a failed approval on chain, a cancelled round, and another call", () => {
    const ran = { released: false, op: null, rounds: [round("failed", approval(1, "open", "final"), approval(2, "execute", "final"))] };
    assert.equal(nextStep(ran, [1, 2], 2).kind, "hold");
    const failedOnChain = { released: false, op: { approvals: [1], depositor: 1, matches: true }, rounds: [round("open", approval(1, "open", "failed", true))] };
    assert.equal(nextStep(failedOnChain, [1, 2], 2).kind, "hold");
    const cancelled = { released: false, op: null, rounds: [round("cancelled", approval(1, "open", "final"), approval(1, "cancel", "final"))] };
    assert.equal(nextStep(cancelled, [1, 2], 2).kind, "hold");
    const other = { released: false, op: { approvals: [1], depositor: 1, matches: false }, rounds: [] };
    assert.match(nextStep(other, [1, 2], 2).why, /not its release.*member 1, cancels it/);
    const gone = { released: false, op: null, rounds: [round("open", approval(1, "open", "final"))] };
    assert.equal(nextStep(gone, [1, 2], 2).kind, "hold");
  });

  it("opens again after an opening that never reached the chain", () => {
    const dropped = { released: false, op: null, rounds: [round("failed", approval(1, "open", "dropped"))] };
    assert.equal(nextStep(dropped, [1, 2], 2).kind, "open");
    const rejected = { released: false, op: null, rounds: [round("open", approval(1, "open", "failed", false))] };
    assert.equal(nextStep(rejected, [1, 2], 2).kind, "open");
  });
});

/**
 * Stand-ins for the chains and the release tool: per burn, released[burnId], the open operation
 * and the record's approvals; approve() applies an approval as V3 would (or `outcome` says what
 * happens instead) and logs every call.
 */
class FakeChain {
  readonly calls: string[] = [];
  readonly lines: string[] = [];
  readonly states = new Map<bigint, BurnState>();
  /** What approve() returns for a burn instead of applying it, once. */
  readonly outcomes = new Map<bigint, Outcome[]>();
  /** An approval sent and not final yet: approve() records it as submitted and returns pending. */
  pendingNext = false;
  /** What settle() says instead of settling, once each: still on its way, or not to be found. */
  readonly settleOutcomes: ({ kind: "pending"; why: string } | { kind: "fatal"; why: string })[] = [];
  settled = 0;

  constructor(
    readonly heads = HEADS,
    readonly burnList: SeenBurn[] = [],
  ) {}

  state(n: bigint): BurnState {
    let s = this.states.get(n);
    if (!s) this.states.set(n, (s = { released: false, op: null, rounds: [] }));
    return s;
  }

  ports(): Ports {
    return {
      // As settleSubmitted: an approval the record holds as submitted is found final; an opening then holds the operation open on chain.
      settle: async () => {
        const queued = this.settleOutcomes.shift();
        if (queued) return queued;
        for (const s of this.states.values()) {
          for (const a of s.rounds.flatMap((r) => r.approvals).filter((x) => x.status === "submitted")) {
            a.status = "final";
            a.onChain = true;
            this.settled += 1;
            if (a.action === "open") s.op = { approvals: [a.member], depositor: a.member, matches: true };
          }
        }
        return { kind: "ok" };
      },
      heads: async () => this.heads,
      burns: async () => this.burnList,
      state: async (b) => structuredClone(this.state(b.burnNonce)),
      approve: async (b, by, step) => {
        this.calls.push(`${b.burnNonce}:${step.kind}:${step.member}:${by}`);
        const queued = this.outcomes.get(b.burnNonce)?.shift();
        if (queued) return queued;
        const s = this.state(b.burnNonce);
        if (s.released) throw new Error(`burn ${b.burnNonce} released twice`);
        if (s.op?.approvals.includes(step.member)) throw new Error(`member ${step.member} approved twice`);
        if (this.pendingNext) {
          this.pendingNext = false;
          s.rounds.push(round("open", approval(step.member, step.kind, "submitted")));
          return { kind: "pending", why: "not final after 10 minutes" };
        }
        if (step.kind === "open") {
          if (s.op) throw new Error("opened twice");
          s.op = { approvals: [step.member], depositor: step.member, matches: true };
          s.rounds.push(round("open", approval(step.member, "open", "final")));
        } else {
          if (!s.op) throw new Error("ran what is not open");
          s.op = null;
          s.released = true;
          s.rounds.at(-1)!.approvals.push(approval(step.member, "execute", "final"));
          s.rounds.at(-1)!.status = "released";
        }
        return { kind: "ok" };
      },
      log: (line) => this.lines.push(line),
    };
  }
}

const burn = (n: bigint, block: number, amount = TPOT / 2n): SeenBurn => ({ burnNonce: n, amount, block, payee: "0xD9838A86cF83C28Ee486544060D1cA4Ca2971071" });
const SEND = { send: true, keyed: [1, 2], threshold: 2 };

describe("a round of the watcher", () => {
  it("releases a burn that qualifies: member 1 opens it, member 2 runs it, once each", async () => {
    const chain = new FakeChain(HEADS, [burn(0n, 990)]);
    const r = await watchRound(chain.ports(), FAST3, SEND);
    assert.deepEqual(chain.calls, ["0:open:1:fast", "0:execute:2:fast"]);
    assert.equal(r.released, 1);
    assert.equal(chain.state(0n).released, true);
    assert.ok(chain.lines.some((l) => l.includes(tradeOff(3))), "the trade-off is printed");
    // The next round finds it released and approves nothing.
    const again = await watchRound(chain.ports(), FAST3, SEND);
    assert.deepEqual(chain.calls, ["0:open:1:fast", "0:execute:2:fast"]);
    assert.equal(again.released, 0);
  });

  it("resumes a half-done release: opened by member 1, run by member 2 only", async () => {
    const chain = new FakeChain(HEADS, [burn(0n, 900)]);
    chain.states.set(0n, { released: false, op: { approvals: [1], depositor: 1, matches: true }, rounds: [round("open", approval(1, "open", "final"))] });
    const r = await watchRound(chain.ports(), FINALITY, SEND);
    assert.deepEqual(chain.calls, ["0:execute:2:finality"]);
    assert.equal(r.released, 1);
  });

  it("after a crash with an opening sent and not final, settles it first and never opens again", async () => {
    const chain = new FakeChain(HEADS, [burn(0n, 900)]);
    chain.pendingNext = true;
    const first = await watchRound(chain.ports(), FINALITY, SEND);
    assert.equal(first.pending, true);
    assert.deepEqual(chain.calls, ["0:open:1:finality"]);
    // A restart while the opening is still on its way: the round settles first, finds it pending, and approves nothing.
    chain.settleOutcomes.push({ kind: "pending", why: "the node's pool holds it" });
    const second = await watchRound(chain.ports(), FINALITY, SEND);
    assert.equal(second.pending, true);
    assert.deepEqual(chain.calls, ["0:open:1:finality"]);
    // The next round settles it (final, the operation open on chain) by itself: member 2 runs it; member 1 never opens again.
    const third = await watchRound(chain.ports(), FINALITY, SEND);
    assert.equal(chain.settled, 1);
    assert.deepEqual(chain.calls, ["0:open:1:finality", "0:execute:2:finality"]);
    assert.equal(third.released, 1);
  });

  it("stops when an approval an earlier run submitted cannot be found though its nonce is used", async () => {
    const chain = new FakeChain(HEADS, [burn(0n, 900)]);
    chain.settleOutcomes.push({ kind: "fatal", why: "member 1's nonce 7 is used, but 0xabc is not in the blocks searched" });
    const r = await watchRound(chain.ports(), FINALITY, SEND);
    assert.match(r.fatal?.why ?? "", /nonce 7 is used/);
    assert.deepEqual(chain.calls, []);
  });

  it("refuses a burn whose payee the checks refuse, signs nothing for it, and goes on with the next burn", async () => {
    const chain = new FakeChain(HEADS, [burn(0n, 900), burn(1n, 905)]);
    chain.outcomes.set(0n, [{ kind: "refused", why: "the payee 0x0000…dEaD is nothing shows that anyone controls it on V3" }]);
    const r = await watchRound(chain.ports(), FINALITY, SEND);
    assert.equal(r.refused, 1);
    assert.equal(r.released, 1);
    assert.equal(chain.state(0n).op, null);
    assert.equal(chain.state(0n).released, false);
    assert.deepEqual(chain.calls, ["0:open:1:finality", "1:open:1:finality", "1:execute:2:finality"]);
    assert.ok(chain.lines.some((l) => /burn 0 .*refused: the payee/.test(l)));
  });

  it("does nothing for a burn already released", async () => {
    const chain = new FakeChain(HEADS, [burn(0n, 900)]);
    chain.states.set(0n, { released: true, op: null, rounds: [round("released", approval(1, "open", "final"), approval(2, "execute", "final"))] });
    const r = await watchRound(chain.ports(), FAST3, SEND);
    assert.deepEqual(chain.calls, []);
    assert.deepEqual([r.released, r.waiting, r.refused, r.held, r.pending, r.fatal], [0, 0, 0, 0, false, null]);
    assert.ok(chain.lines.some((l) => /burn 0 .*released already; nothing to do/.test(l)));
  });

  it("waits for a burn that does not qualify yet, and for one above the fast cap", async () => {
    const chain = new FakeChain(HEADS, [burn(0n, 999), burn(1n, 950, 2n * TPOT), burn(2n, 950, TPOT)]);
    const r = await watchRound(chain.ports(), FAST3, SEND);
    assert.equal(r.waiting, 2);
    assert.deepEqual(chain.calls, ["2:open:1:fast", "2:execute:2:fast"]);
  });

  it("lets a burn whose log the RPC does not serve wait, and goes on with the next burn", async () => {
    const unread: SeenBurn = { burnNonce: 0n, amount: 0n, block: 0, payee: "?", missing: "the Sepolia RPC refuses eth_getLogs (code 4444) before its log is found" };
    const chain = new FakeChain(HEADS, [unread, burn(1n, 905)]);
    const r = await watchRound(chain.ports(), FINALITY, SEND);
    assert.equal(r.waiting, 1);
    assert.equal(r.released, 1);
    assert.deepEqual(chain.calls, ["1:open:1:finality", "1:execute:2:finality"]);
    assert.ok(chain.lines.some((l) => /^burn 0: waits: the Sepolia RPC refuses eth_getLogs/.test(l)));
  });

  it("stops at an approval that failed its checks on chain, and touches no later burn", async () => {
    const chain = new FakeChain(HEADS, [burn(0n, 900), burn(1n, 905)]);
    chain.outcomes.set(0n, [{ kind: "failed", why: "MultisigExecuted with an error", extrinsicHash: "0xfeed" }]);
    const r = await watchRound(chain.ports(), FINALITY, SEND);
    assert.match(r.fatal?.why ?? "", /failed its checks: MultisigExecuted/);
    assert.equal(r.fatal?.burn, "0");
    assert.equal(r.fatal?.extrinsicHash, "0xfeed");
    assert.deepEqual(chain.calls, ["0:open:1:finality"]);
  });

  it("dry-runs only the next approval without --send, and says who runs it then", async () => {
    const chain = new FakeChain(HEADS, [burn(0n, 900)]);
    const r = await watchRound(chain.ports(), FINALITY, { ...SEND, send: false });
    assert.equal(r.planned, 1);
    assert.deepEqual(chain.calls, ["0:open:1:finality"]);
    assert.ok(chain.lines.some((l) => /then member 2 runs it/.test(l)));
  });
});

describe("an error at submission", () => {
  it("counts an extrinsic the node may still include as on its way, and one it refused as never sent", () => {
    // 1013: the pool has it already; 1014: another with its nonce is in the pool. Either may still be included.
    assert.equal(submitErrorVerdict("1013: Transaction Already Imported"), "pending");
    assert.equal(submitErrorVerdict("1014: Priority is too low: (100 vs 100)"), "pending");
    for (const text of ["1010: Invalid Transaction: Inability to pay some fees", "1011: Unknown Transaction Validity", "1012: Transaction is temporarily banned", "1015: Unknown", "1019: Unknown"]) {
      assert.equal(submitErrorVerdict(text), "rejected", text);
    }
    for (const text of ["WebSocket is not connected", "1020: something else", "Error 1010"]) assert.equal(submitErrorVerdict(text), "error", text);
  });
});

describe("where the watcher looks, and when", () => {
  it("starts from the first burn not released, and its logs from the last released burn's block", () => {
    assert.deepEqual(cursorOf([], 11_950_851), { nextNonce: 0n, fromBlock: 11_950_851 });
    assert.deepEqual(cursorOf([{ burnNonce: 0n, block: 11_955_414 }], 11_950_851), { nextNonce: 1n, fromBlock: 11_955_414 });
    // A gap: burn 1 is not released, so the watcher starts there even though burn 2 is.
    assert.deepEqual(cursorOf([{ burnNonce: 0n, block: 100 }, { burnNonce: 2n, block: 300 }], 50), { nextNonce: 1n, fromBlock: 100 });
  });

  it("waits --watch seconds between rounds, doubling after rounds an RPC failed, up to an hour", () => {
    assert.equal(nextWait(30, 30, false), 30);
    assert.equal(nextWait(30, 30, true), 60);
    assert.equal(nextWait(30, 60, true), 120);
    assert.equal(nextWait(30, 2_400, true), MAX_BACKOFF_SECONDS);
    assert.equal(nextWait(30, MAX_BACKOFF_SECONDS, false), 30);
    assert.equal(nextWait(7_200, 7_200, true), 7_200);
  });

  it("doubles the wait only for trouble with an RPC", () => {
    const named = (name: string) => Object.assign(new Error("x"), { name });
    assert.equal(rpcTrouble(named("Unreachable")), true);
    assert.equal(rpcTrouble(named("RpcError")), true);
    assert.equal(rpcTrouble(named("EvmRpcError")), true);
    for (const name of ["Stop", "Error", "TypeError", "Rejected"]) assert.equal(rpcTrouble(named(name)), false, name);
    assert.equal(rpcTrouble("Unreachable"), false);
  });

  it("takes two members' key files", () => {
    assert.deepEqual(parseMemberKeys("2:b.json,1:C:\\keys\\a.json"), [
      { member: 1, path: "C:\\keys\\a.json" },
      { member: 2, path: "b.json" },
    ]);
    assert.throws(() => parseMemberKeys("1:a.json"), /two members/);
    assert.throws(() => parseMemberKeys("1:a.json,1:b.json"), /member 1 is named twice/);
    assert.throws(() => parseMemberKeys("1:a.json,4:b.json"), /<member>:<key file>/);
    assert.throws(() => parseMemberKeys("1:a.json,2:a.json"), /same key file/);
    assert.throws(() => parseMemberKeys("1:a.json,2:b.json,3:c.json"), /two members/);
  });
});

describe("the burn cache", () => {
  const dir = join(tmpdir(), "bz-watch-test");
  mkdirSync(dir, { recursive: true });
  const MINTER = "0x1111111111111111111111111111111111111111";
  const entry = {
    block: 11_955_414,
    blockHash: `0x${"ab".repeat(32)}`,
    txHash: `0x${"cd".repeat(32)}`,
    from: "0xd9838a86cf83c28ee486544060d1ca4ca2971071",
    payee: "0xd9838a86cf83c28ee486544060d1ca4ca2971071",
    amount: "50000000000000",
    burnId: `0x${"0b".repeat(32)}`,
  };

  it("keeps the final burns' logs it is given, for its minter only", () => {
    const path = join(dir, "release-watch-5Fmultisig.burns.json");
    writeBurnCache(path, MINTER, new Map([["10", { ...entry, block: 12 }], ["2", entry]]));
    const read = readBurnCache(path, MINTER.toUpperCase().replace("0X", "0x"));
    assert.deepEqual([...read.keys()], ["2", "10"]);
    assert.deepEqual(read.get("2"), entry);
    assert.equal(readBurnCache(path, "0x2222222222222222222222222222222222222222").size, 0);
  });

  it("is empty when there is none or it does not parse, and leaves out an entry that is not whole", () => {
    assert.equal(readBurnCache(join(dir, "never-written.burns.json"), MINTER).size, 0);
    const garbled = join(dir, "garbled.burns.json");
    writeFileSync(garbled, "{ not json");
    assert.equal(readBurnCache(garbled, MINTER).size, 0);
    const partial = join(dir, "partial.burns.json");
    writeFileSync(partial, JSON.stringify({ minter: MINTER, burns: { "0": entry, "1": { ...entry, blockHash: "0x12" }, "2": { ...entry, amount: "-1" }, x: entry } }));
    assert.deepEqual([...readBurnCache(partial, MINTER).keys()], ["0"]);
  });
});

describe("the halt file", () => {
  // One folder for every run, its files written over: nothing to clean up.
  const dir = join(tmpdir(), "bz-watch-test");
  mkdirSync(dir, { recursive: true });

  it("keeps why a watcher stopped, and says what to do", () => {
    const path = join(dir, "release-watch-5Fmultisig.halt");
    writeHalt(path, { reason: "member 2's approval failed its checks", burn: "4", extrinsicHash: "0xfeed", at: "2026-10-24T10:00:00.000Z" });
    const h = readHalt(path);
    assert.deepEqual(h, { reason: "member 2's approval failed its checks", burn: "4", extrinsicHash: "0xfeed", at: "2026-10-24T10:00:00.000Z" });
    assert.equal(haltRefusal(h!, path), `a fatal stop at 2026-10-24T10:00:00.000Z: member 2's approval failed its checks (burn 4, extrinsic 0xfeed); look at it, then remove ${path}`);
  });

  it("halts on a halt file that does not parse, and not without one", () => {
    const path = join(dir, "garbled.halt");
    writeFileSync(path, "{ not json");
    assert.match(readHalt(path)!.reason, /does not parse/);
    assert.equal(readHalt(join(dir, "never-written.halt")), null);
  });
});

describe("the watcher's lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "bz-watch-lock-"));
  const quiet = () => undefined;

  it("lets one watcher hold it at a time", () => {
    const path = join(dir, "one.lock");
    const lines: string[] = [];
    const a = takeLock(path, quiet);
    assert.ok(a?.held());
    assert.equal(takeLock(path, (l) => lines.push(l)), null);
    assert.match(lines.join("\n"), new RegExp(`another watcher \\(process ${process.pid}\\)`));
    a!.release();
    const b = takeLock(path, quiet);
    assert.ok(b?.held());
    b!.release();
  });

  it("takes over a lock whose process is gone, or which was not refreshed for 10 minutes", () => {
    const gone = join(dir, "gone.lock");
    writeFileSync(gone, JSON.stringify({ pid: 2_147_483_646, token: "x" }));
    const a = takeLock(gone, quiet);
    assert.ok(a?.held());
    assert.notEqual(JSON.parse(readFileSync(gone, "utf8")).token, "x");
    a!.release();
    const old = join(dir, "old.lock");
    writeFileSync(old, JSON.stringify({ pid: process.ppid, token: "y" }));
    const then = new Date(Date.now() - LOCK_STALE - 60_000);
    utimesSync(old, then, then);
    const b = takeLock(old, quiet);
    assert.ok(b?.held());
    b!.release();
  });

  it("tells a watcher whose lock another took over that it is not its own", () => {
    const path = join(dir, "lost.lock");
    const a = takeLock(path, quiet)!;
    writeFileSync(path, JSON.stringify({ pid: process.ppid, token: "another" }));
    assert.equal(a.held(), false);
    a.release();
    assert.equal(JSON.parse(readFileSync(path, "utf8")).token, "another", "release leaves another watcher's lock in place");
  });
});
