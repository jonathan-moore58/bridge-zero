// Unit tests of automint.ts, offline: the Locked logs and the decision on fixtures (finality,
// used, another destination, a client behind V3's set, --grace, a held header or an import), the
// two paths on lock 1's real bundle, the send and its history across a simulated crash (against
// stand-ins for Sepolia and for cast, so nothing is signed or sent), the state, the lock and the
// relayer's keys, and the timeouts of each kind of request against local servers that never answer.
// Files go to a folder of this run's own in the system's temp directory (bz-automint-test-*), so
// two runs at once (the file alone and the whole suite, say) never write each other's files.
//
//   npm test

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createTcpServer, type AddressInfo, type Server as TcpServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import type { Receipt } from "../../contracts/script/lib/sepolia.mjs";
import {
  absorbLogs,
  accountForNonces,
  appendLine,
  decide,
  DEFAULT_START_BLOCK,
  failedSendsOf,
  Fatal,
  feesFor,
  filesOf,
  gasLimitOf,
  GAS_CAP,
  headJob,
  holdLocks,
  HttpRpc,
  isNonceUsed,
  keyDirsOf,
  loadState,
  LOG_WINDOW,
  lookupHint,
  MAX_BACKOFF_SECONDS,
  MAX_FAILED_SENDS,
  MAX_LOOKUPS_PER_ROUND,
  minterLockOf,
  nextWait,
  openAttempts,
  openV3,
  parseLockedLog,
  parseOptions,
  raisedFees,
  readHistory,
  recordOf,
  relayerKeyProblem,
  replacementCap,
  retryLock,
  revertData,
  runTool,
  saveState,
  scanLocks,
  scanRange,
  sendJob,
  setLog,
  settle,
  spentSince,
  stillHeld,
  txHashOf,
  Unreachable,
  Usage,
  v3,
  verifyLockProofs,
  withDeadline,
  type AttemptLine,
  type Bridge,
  type CallResult,
  type ClientView,
  type Facts,
  type HistoryLine,
  type Job,
  type LockRecord,
  type Run,
  type SendCtx,
  type SepoliaReads,
  type Signer,
  type State,
  type Stuck,
  type SubstrateLookup,
} from "./automint.js";
import type { FoundLock } from "./substrate-locks.js";
import { bundleCalldata, MINTED_TOPIC } from "./bridge.js";
import { bytesToHex, hexToBytes, type Hex } from "./bytes.js";
import type { MintBundleFixture } from "./fixture.js";
import { addressWord, LOCKED_TOPIC, lockCommitment, uintWord } from "./vault.js";
import { takeLock } from "./watch.js";

const VAULT: Hex = "0xa02ee16eb03d2cf1aef199f7658fb8c8e3188ffd";
const MINTER: Hex = "0x8287b3baf205ca8456f98346f13064aa7fcdcb9e";
const D983: Hex = "0xd9838a86cf83c28ee486544060d1ca4ca2971071";
const SENDER: Hex = "0x1111111111111111111111111111111111111111";
const BRIDGE = { vault: VAULT, v3ChainId: 420_420_777n, chainId: 11_155_111n, minter: MINTER };
const ONE_TPOT = 10n ** 14n;
const GWEI = 10n ** 9n;
const ETH = 10n ** 18n;
const DIR = mkdtempSync(join(tmpdir(), "bz-automint-test-"));
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const quiet: string[] = [];
setLog((line) => quiet.push(line));

const wordOf = (x: bigint | Hex): string => bytesToHex(typeof x === "bigint" ? uintWord(x) : addressWord(hexToBytes(x))).slice(2);

/** A Locked log of the vault, as V3's EVM RPC serves it; the commitment is the one its fields give unless given. */
function lockedLog(o: { nonce: bigint; block: number; recipient?: Hex; amount?: bigint; dstChainId?: bigint; dstMinter?: Hex; commitment?: Hex; address?: string; removed?: boolean; topic?: string }) {
  const recipient = o.recipient ?? D983;
  const amount = o.amount ?? ONE_TPOT;
  const dstChainId = o.dstChainId ?? 11_155_111n;
  const dstMinter = o.dstMinter ?? MINTER;
  const commitment =
    o.commitment ??
    bytesToHex(lockCommitment({ v3ChainId: 420_420_777n, vault: hexToBytes(VAULT), dstChainId, dstMinter: hexToBytes(dstMinter), recipient: hexToBytes(recipient), amountNative: amount, nonce: o.nonce }));
  return {
    address: o.address ?? VAULT,
    blockNumber: `0x${o.block.toString(16)}`,
    transactionHash: `0x${"ab".repeat(32)}`,
    topics: [o.topic ?? LOCKED_TOPIC, `0x${wordOf(o.nonce)}`, `0x${wordOf(D983)}`, `0x${wordOf(recipient)}`],
    data: `0x${wordOf(dstChainId)}${wordOf(dstMinter)}${wordOf(amount)}${commitment.slice(2)}`,
    ...(o.removed ? { removed: true } : {}),
  };
}

/** The state's record of a lock this minter can mint. */
function recordFor(log: ReturnType<typeof lockedLog>): LockRecord {
  const p = parseLockedLog(log, BRIDGE);
  assert.ok(p.kind === "lock", `a lock this minter can mint, not ${p.kind}`);
  return recordOf(p);
}

const NONCE_ALREADY_USED = bytesToHex(keccak_256(new TextEncoder().encode("NonceAlreadyUsed(uint256)")).slice(0, 4));

const freshState = (): State => ({
  version: 1,
  network: "sepolia",
  chainId: 11_155_111,
  minter: MINTER,
  vault: VAULT,
  sender: SENDER,
  startBlock: DEFAULT_START_BLOCK,
  nextBlock: DEFAULT_START_BLOCK,
  locks: {},
  updatedAt: new Date().toISOString(),
});

// ---------------------------------------------------------------------------------------

describe("the Locked logs", () => {
  it("reads locks 0 and 1 as the vault logged them, with the commitments the vault stores", () => {
    const zero = parseLockedLog(lockedLog({ nonce: 0n, block: 101_009 }), BRIDGE);
    assert.equal(zero.kind, "lock");
    assert.ok(zero.kind === "lock");
    // README's "Verify it yourself": lock 0's commitment as the vault stores it on V3.
    assert.equal(zero.lock.commitment, "0x9eba08c90e4527bdb00da438eb8f15ad244cbb202e8886d929b0e12941e23435");
    assert.equal(zero.lock.block, 101_009);
    assert.equal(zero.lock.recipient, D983);
    assert.equal(zero.lock.amount, ONE_TPOT);
    const one = parseLockedLog(lockedLog({ nonce: 1n, block: 118_636 }), BRIDGE);
    assert.ok(one.kind === "lock");
    // fixtures/v3-testnet-lock1: commitments[1].
    assert.equal(one.lock.commitment, "0x2d1ab009f006fd70b9653d09a56a3b4927775d6251c4879df9c7a1364b0ad0a7");
    assert.equal(recordOf(one).status, "pending");
  });

  it("skips, and keeps with the reason, a lock whose commitment names another chain or minter, or that no mint can prove", () => {
    const why = (log: ReturnType<typeof lockedLog>) => {
      const p = parseLockedLog(log, BRIDGE);
      assert.equal(p.kind, "skip");
      assert.ok(p.kind === "skip");
      assert.equal(recordOf(p).status, "skipped");
      return p.why;
    };
    assert.match(why(lockedLog({ nonce: 2n, block: 220_000, dstChainId: 84_532n })), /names chain 84532, not Sepolia/);
    assert.match(why(lockedLog({ nonce: 2n, block: 220_000, dstMinter: "0x2222222222222222222222222222222222222222" })), /names the minter .*, not this BridgeMinter/);
    assert.match(why(lockedLog({ nonce: 2n, block: 220_000, commitment: `0x${"77".repeat(32)}` })), /is not the one its fields give/);
    assert.match(why(lockedLog({ nonce: 2n, block: 220_000, amount: 0n })), /zero amount/);
    assert.match(why(lockedLog({ nonce: 2n, block: 220_000, recipient: `0x${"00".repeat(20)}` })), /zero recipient/);
  });

  it("ignores what is not a final Locked log of the vault", () => {
    assert.equal(parseLockedLog(lockedLog({ nonce: 2n, block: 220_000, address: "0x3333333333333333333333333333333333333333" }), BRIDGE).kind, "ignore");
    assert.equal(parseLockedLog(lockedLog({ nonce: 2n, block: 220_000, removed: true }), BRIDGE).kind, "ignore");
    assert.equal(parseLockedLog(lockedLog({ nonce: 2n, block: 220_000, topic: `0x${"12".repeat(32)}` }), BRIDGE).kind, "ignore");
    const short = { ...lockedLog({ nonce: 2n, block: 220_000 }), data: "0x1234" };
    assert.equal(parseLockedLog(short, BRIDGE).kind, "ignore");
    const blockless = { ...lockedLog({ nonce: 2n, block: 220_000 }), blockNumber: undefined };
    assert.equal(parseLockedLog(blockless, BRIDGE).kind, "ignore");
  });

  it("takes each nonce in once: the same log again changes nothing, a log that disagrees leaves the lock to the operator", () => {
    const s = freshState();
    const first = absorbLogs(s, [lockedLog({ nonce: 2n, block: 220_000 }), lockedLog({ nonce: 3n, block: 220_010, dstChainId: 84_532n })], BRIDGE);
    assert.deepEqual(
      first.added.map((r) => [r.nonce, r.status]),
      [
        ["2", "pending"],
        ["3", "skipped"],
      ],
    );
    const again = absorbLogs(s, [lockedLog({ nonce: 2n, block: 220_000 }), lockedLog({ nonce: 9n, block: 220_000, removed: true })], BRIDGE);
    assert.equal(again.added.length, 0);
    assert.equal(again.ignored, 1);
    assert.equal(s.locks["2"].status, "pending");
    const clash = absorbLogs(s, [lockedLog({ nonce: 2n, block: 220_001 })], BRIDGE);
    assert.equal(clash.conflicts.length, 1);
    assert.equal(s.locks["2"].status, "skipped");
  });

  it("scans in windows of 10,000 blocks, from the state's next block less the overlap, to the finalized block", async () => {
    const asked: [number, number][] = [];
    const evm = {
      call: async <T>(method: string, params: unknown[]): Promise<T> => {
        assert.equal(method, "eth_getLogs");
        const f = params[0] as { address: string; topics: string[]; fromBlock: string; toBlock: string };
        assert.equal(f.address, VAULT);
        assert.deepEqual(f.topics, [LOCKED_TOPIC]);
        asked.push([Number(f.fromBlock), Number(f.toBlock)]);
        return (Number(f.fromBlock) <= 220_000 && 220_000 <= Number(f.toBlock) ? [lockedLog({ nonce: 2n, block: 220_000 })] : []) as T;
      },
    };
    const logs = await scanLocks(evm, VAULT, 200_000, 225_099);
    assert.deepEqual(asked, [
      [200_000, 209_999],
      [210_000, 219_999],
      [220_000, 225_099],
    ]);
    assert.equal(logs.length, 1);
    assert.deepEqual(scanRange({ startBlock: 218_400, nextBlock: 218_400 }, 218_500), [218_400, 218_500]);
    assert.deepEqual(scanRange({ startBlock: 218_400, nextBlock: 218_501 }, 218_600), [218_437, 218_600]);
    assert.equal(scanRange({ startBlock: 218_400, nextBlock: 218_601 }, 218_600), null);
  });
});

// ---------------------------------------------------------------------------------------

describe("the decision", () => {
  const NOW = Date.parse("2026-10-27T12:00:00.000Z");
  const rec = (more: Partial<LockRecord> = {}): LockRecord => ({ ...recordFor(lockedLog({ nonce: 2n, block: 1_000 })), ...more });
  const client = (more: Partial<ClientView> = {}): ClientView => ({ setId: 10n, latestHash: `0x${"cc".repeat(32)}`, latestNumber: 900, halted: false, paused: false, ...more });
  const facts = (more: Partial<Facts> = {}): Facts => ({ now: NOW, graceMs: 0, v3Finalized: 1_010, v3SetId: 10n, client: client(), used: false, failedSends: 0, minAmount: 0n, ...more });

  it("leaves a minted lock alone, and waits for V3's finality of its block", () => {
    assert.equal(decide(rec(), facts({ used: true })).kind, "minted");
    const d = decide(rec(), facts({ v3Finalized: 999 }));
    assert.equal(d.kind, "wait");
    assert.match(d.why, /V3 has not finalized #1,000 yet/);
  });

  it("waits --grace after it first saw the block final, then mints", () => {
    const seen = new Date(NOW - 10_000).toISOString();
    const d = decide(rec({ finalSeenAt: seen }), facts({ graceMs: 60_000 }));
    assert.equal(d.kind, "wait");
    assert.ok(d.kind === "wait");
    assert.equal(d.until, NOW + 50_000);
    assert.match(d.why, /--grace: 50 s more/);
    assert.equal(decide(rec({ finalSeenAt: seen }), facts({ graceMs: 60_000, now: NOW + 50_000 })).kind, "mint");
    // Seen final only now: the whole grace.
    const fresh = decide(rec(), facts({ graceMs: 60_000 }));
    assert.ok(fresh.kind === "wait" && fresh.until === NOW + 60_000);
  });

  it("mints at a header the light client holds at or after the lock, even while it is behind V3's set, paused or halted", () => {
    for (const c of [client({ latestNumber: 1_000 }), client({ latestNumber: 1_005, setId: 9n }), client({ latestNumber: 1_005, halted: true }), client({ latestNumber: 1_005, paused: true })]) {
      const d = decide(rec(), facts({ client: c }));
      assert.deepEqual([d.kind, d.kind === "mint" ? d.path : null], ["mint", "held"]);
    }
  });

  it("imports V3's finalized head and mints when the client is at V3's set and holds nothing at or after the lock", () => {
    const d = decide(rec(), facts());
    assert.deepEqual([d.kind, d.kind === "mint" ? d.path : null], ["mint", "head"]);
  });

  it("waits while the client is behind V3's set, paused or halted, or the V3 node is behind the client", () => {
    const behind = decide(rec(), facts({ v3SetId: 11n }));
    assert.equal(behind.kind, "wait");
    assert.match(behind.why, /at set 10 and V3 at set 11: the relayer imports the set change within minutes/);
    assert.match(decide(rec(), facts({ client: client({ halted: true }) })).why, /is halted and holds no header at or after #1,000/);
    assert.match(decide(rec(), facts({ client: client({ paused: true }) })).why, /is paused/);
    assert.match(decide(rec(), facts({ v3SetId: 9n })).why, /behind the light client's set 10/);
    assert.equal(decide(rec(), facts({ v3SetId: null })).kind, "wait");
  });

  it(`leaves a lock to the operator after ${MAX_FAILED_SENDS} of our transactions were mined without minting it, and a skipped one stays skipped`, () => {
    assert.equal(decide(rec(), facts({ failedSends: MAX_FAILED_SENDS - 1 })).kind, "mint");
    const left = decide(rec(), facts({ failedSends: MAX_FAILED_SENDS }));
    assert.ok(left.kind === "skip" && left.left === "failed-sends");
    assert.match(left.why, /left to the operator \(--retry 2 takes it in again/);
    assert.equal(decide(rec({ status: "skipped", why: "for chain 84532" }), facts()).kind, "skip");
  });

  it("skips a lock below --min-amount, minted or not final yet as it may be, and pays for one at it", () => {
    const small = decide(rec(), facts({ minAmount: ONE_TPOT + 1n }));
    assert.ok(small.kind === "skip" && small.left === "min-amount");
    assert.match(small.why, /1 tPOT is below --min-amount 1\.00000000000001 tPOT: .* mints it from the app/);
    assert.equal(decide(rec(), facts({ minAmount: ONE_TPOT + 1n, v3Finalized: 999 })).kind, "skip");
    assert.equal(decide(rec(), facts({ minAmount: ONE_TPOT + 1n, used: true })).kind, "minted", "a lock minted already is recorded as minted");
    assert.equal(decide(rec(), facts({ minAmount: ONE_TPOT })).kind, "mint");
  });
});

// ---------------------------------------------------------------------------------------

describe("the two paths, on lock 1's bundle (fixtures/v3-testnet-lock1)", () => {
  const b = JSON.parse(readFileSync(join(ROOT, "fixtures", "v3-testnet-lock1", "mint-bundle.json"), "utf8")) as MintBundleFixture;
  const one = recordFor(lockedLog({ nonce: 1n, block: 118_636 }));
  const at33 = (latestNumber: number, setId = 33n): ClientView => ({ setId, latestHash: `0x${"cc".repeat(32)}`, latestNumber, halted: false, paused: false });
  const nodes = (hex: Hex[]) => hex.map((h) => hexToBytes(h));

  it("walks the proofs mint(p) carries from the block's state root to the lock's commitment, and fails on a changed byte", () => {
    const stateRoot = hexToBytes(b.header.stateRoot);
    const trieId = hexToBytes(b.vault.trieId);
    const walked = verifyLockProofs(stateRoot, trieId, 1n, nodes(b.childRoot.proof.nodes), nodes(b.slot.proof.nodes));
    assert.equal(bytesToHex(walked.value!), one.commitment);
    assert.equal(bytesToHex(walked.childRoot), b.childRoot.root);
    // commitments[0] is not on this slot proof's path: the walk fails or shows nothing there.
    let zero: Uint8Array | null | "threw";
    try {
      zero = verifyLockProofs(stateRoot, trieId, 0n, nodes(b.childRoot.proof.nodes), nodes(b.slot.proof.nodes)).value;
    } catch {
      zero = "threw";
    }
    assert.ok(zero === "threw" || zero === null);
    const tampered = nodes(b.slot.proof.nodes);
    tampered[0][tampered[0].length >> 1] ^= 1;
    assert.throws(() => verifyLockProofs(stateRoot, trieId, 1n, nodes(b.childRoot.proof.nodes), tampered));
  });

  it("builds importAndMint at the bundle's block, without the account proof once the minter is bound", () => {
    const unbound = headJob(b, one, at33(118_000), false, MINTER);
    assert.equal(unbound.data, bytesToHex(bundleCalldata(b)), "exactly mint.ts's call while the minter is not bound");
    const bound = headJob(b, one, at33(118_000), true, MINTER);
    assert.ok(bound.data.length < unbound.data.length, "the account proof is left out");
    assert.equal(bound.data.slice(0, 10), unbound.data.slice(0, 10));
    assert.equal(bound.path, "head");
    assert.equal(bound.block.number, 118_637);
  });

  it("refuses the bundle when the client is at another set or past its block, or when its lock is not the one seen", () => {
    assert.throws(() => headJob(b, one, at33(118_000, 34n), true, MINTER), /signed by set 33/);
    assert.throws(() => headJob(b, one, at33(118_637), true, MINTER), /at or past the bundle's block/);
    assert.throws(() => headJob(b, { ...one, amount: "2" }, at33(118_000), true, MINTER), /is not lock 1 as its log gives it/);
    assert.throws(() => headJob(b, { ...one, block: 118_700 }, at33(118_000), true, MINTER), /below the lock's block/);
  });
});

// ---------------------------------------------------------------------------------------

/** Sepolia as a send and a settling read it, in memory. */
class FakeSepolia implements SepoliaReads {
  usedNonces = new Set<bigint>();
  callResult: CallResult = { ok: true, revert: null, text: "no revert" };
  replayResult: CallResult = { ok: false, revert: null, text: 'NotNewer(220000, 220100)' };
  gas = 600_000;
  base = 20n;
  funds = ETH;
  latest = 5;
  pendingNonce = 5;
  receipts = new Map<Hex, Receipt>();
  txs = new Map<Hex, { blockNumber: string | null }>();
  async used(nonce: bigint) {
    return this.usedNonces.has(nonce);
  }
  async call(_from: Hex, _to: Hex, _data: Hex, block = "latest") {
    return block === "latest" ? this.callResult : this.replayResult;
  }
  async estimateGas() {
    return this.gas;
  }
  async nextBaseFee() {
    return this.base;
  }
  async balance() {
    return this.funds;
  }
  async nonces() {
    return { latest: this.latest, pending: this.pendingNonce };
  }
  async receipt(hash: Hex) {
    return this.receipts.get(hash) ?? null;
  }
  async transaction(hash: Hex) {
    return this.txs.get(hash) ?? null;
  }
  publishUrl() {
    return "https://sepolia.example";
  }
}

/** cast in memory: each signing is a raw transaction of its own; a crash can be set before signing or publishing. */
class FakeSigner implements Signer {
  signed: string[][] = [];
  published: Hex[] = [];
  crash: "sign" | "publish" | null = null;
  onSign: (() => void) | null = null;
  onPublish: ((hash: Hex) => void) | null = null;
  sign(args: string[]): Hex {
    if (this.crash === "sign") throw new Error("the process stops after recording the attempt");
    this.signed.push(args);
    this.onSign?.();
    return `0x02${Buffer.from(`${args.join(" ")} #${this.signed.length}`).toString("hex")}` as Hex;
  }
  publish(raw: Hex): boolean {
    if (this.crash === "publish") throw new Error("the process stops after recording the hash");
    this.published.push(raw);
    this.onPublish?.(txHashOf(raw));
    return true;
  }
}

const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];

describe("the send and its history, across a crash", () => {
  const history = join(DIR, "automint-sepolia-test.jsonl");
  const lock2 = recordFor(lockedLog({ nonce: 2n, block: 220_000 }));
  const job: Job = { lock: lock2, path: "held", block: { number: 220_100, hash: `0x${"dd".repeat(32)}` }, to: MINTER, data: "0x1234abcd", what: "mint(p) at #220,100" };
  let sepolia: FakeSepolia;
  let signer: FakeSigner;
  const ctx = (): SendCtx => ({
    sepolia,
    sender: SENDER,
    minter: MINTER,
    fees: { maxBaseFee: 1_500_000_000n, keep: ETH / 20n },
    record: (line) => appendLine(history, line),
    signer,
    account: "automint-test-key",
    passwordFile: "no-password-file",
    fence: () => undefined,
    receiptWaitMs: 50,
    pollMs: 10,
  });
  const minted = (hash: Hex, status = 1): Receipt => ({
    status: `0x${status}`,
    blockNumber: "0xb6d000",
    gasUsed: "0x92f2a",
    effectiveGasPrice: "0x3fc",
    transactionHash: hash,
    logs: status
      ? [{ address: MINTER, topics: [MINTED_TOPIC, `0x${wordOf(2n)}`, `0x${wordOf(D983)}`, `0x${"dd".repeat(32)}`], data: `0x${wordOf(ONE_TPOT)}` }]
      : [],
  });
  const fresh = () => {
    writeFileSync(history, "");
    sepolia = new FakeSepolia();
    signer = new FakeSigner();
  };
  const lines = () => readHistory(history).lines;
  const attemptLine = (id: string, txNonce: number, maxFee: string, priorityFee: string): AttemptLine => ({
    kind: "attempt",
    id,
    lock: "2",
    path: "held",
    block: job.block,
    to: MINTER,
    dataHash: `0x${"00".repeat(32)}`,
    sender: SENDER,
    txNonce,
    recipient: lock2.recipient,
    amount: lock2.amount,
    gas: 600_000,
    gasLimit: 660_000,
    maxFee,
    priorityFee,
    at: new Date().toISOString(),
  });

  it("records the attempt before signing and the hash before publishing, then the mint from its receipt", async () => {
    fresh();
    signer.onPublish = (hash) => sepolia.receipts.set(hash, minted(hash));
    const end = await sendJob(job, ctx());
    assert.equal(end.kind, "minted");
    assert.ok(end.kind === "minted" && end.ours);
    assert.deepEqual(
      lines().map((l) => l.kind),
      ["attempt", "signed", "result"],
    );
    const [attempt, signed, result] = lines();
    assert.ok(attempt.kind === "attempt" && signed.kind === "signed" && result.kind === "result");
    assert.equal(attempt.txNonce, 5);
    assert.equal(attempt.gasLimit, 660_000);
    assert.equal(signed.txHash, txHashOf(signer.published[0]));
    assert.equal(result.outcome, "minted");
    assert.equal(result.txHash, signed.txHash);
    // The relayer's fees: a priority fee of 1,000 wei, and the 0.01 gwei floor over ten times a base fee of 20 wei.
    const args = signer.signed[0];
    assert.deepEqual(
      ["--nonce", "--gas-limit", "--gas-price", "--priority-gas-price", "--rpc-url", "--account"].map((f) => flag(args, f)),
      ["5", "660000", "10000000", "1000", "https://sepolia.example", "automint-test-key"],
    );
    assert.equal(openAttempts(lines()).length, 0);
  });

  it("after a crash before signing, settles the attempt as not sent, and the next send signs the same nonce", async () => {
    fresh();
    signer.crash = "sign";
    await assert.rejects(sendJob(job, ctx()), /stops after recording the attempt/);
    assert.deepEqual(
      lines().map((l) => l.kind),
      ["attempt"],
    );
    // The next process.
    const open = openAttempts(lines());
    assert.equal(open.length, 1);
    assert.equal(open[0].signed, null);
    const s = await settle(open, ctx());
    assert.equal(s.pending, null);
    assert.equal(s.results[0].outcome, "not-sent");
    signer.crash = null;
    signer.onPublish = (hash) => sepolia.receipts.set(hash, minted(hash));
    assert.equal((await sendJob(job, ctx())).kind, "minted");
    assert.equal(flag(signer.signed[0], "--nonce"), "5");
  });

  it("after a crash once the hash is recorded, sends nothing else while the transaction is pending, then settles it from its receipt", async () => {
    fresh();
    signer.crash = "publish";
    await assert.rejects(sendJob(job, ctx()), /stops after recording the hash/);
    const open = openAttempts(lines());
    assert.equal(open.length, 1);
    const hash = open[0].signed!.txHash;
    // It reached the network after all, and waits there.
    sepolia.txs.set(hash, { blockNumber: null });
    const waiting = await settle(open, ctx());
    assert.equal(waiting.pending, hash, "a round sends nothing while it is pending");
    assert.equal(waiting.results.length, 0);
    assert.equal(openAttempts(lines()).length, 1, "nothing is recorded for it yet");
    // Mined: settled from its receipt, and the lock is minted by it.
    sepolia.receipts.set(hash, minted(hash));
    const done = await settle(openAttempts(lines()), ctx());
    assert.equal(done.pending, null);
    assert.equal(done.results[0].outcome, "minted");
    assert.equal(openAttempts(lines()).length, 0);
  });

  it("after a crash, a transaction neither mined nor pending is dropped and the next send signs its nonce again; one whose nonce another took is dropped too", async () => {
    fresh();
    signer.crash = "publish";
    await assert.rejects(sendJob(job, ctx()));
    const dropped = await settle(openAttempts(lines()), ctx());
    assert.equal(dropped.results[0].outcome, "dropped");
    assert.match(dropped.results[0].why, /nonce 5 is free again, and the next send signs it/);
    signer.crash = null;
    signer.onPublish = (hash) => sepolia.receipts.set(hash, minted(hash));
    assert.equal((await sendJob(job, ctx())).kind, "minted");
    assert.deepEqual(
      signer.signed.map((a) => flag(a, "--nonce")),
      ["5", "5"],
      "the same nonce: the dropped transaction and this one can never both be mined",
    );

    fresh();
    signer.crash = "publish";
    await assert.rejects(sendJob(job, ctx()));
    sepolia.latest = 6;
    sepolia.pendingNonce = 6;
    const taken = await settle(openAttempts(lines()), ctx());
    assert.equal(taken.results[0].outcome, "dropped");
    assert.match(taken.results[0].why, /nonce 5 was used by another transaction/);
  });

  it("sends nothing and records nothing when the eth_call reverts NonceAlreadyUsed or used(nonce) turns true before the send", async () => {
    fresh();
    sepolia.callResult = { ok: false, revert: `${NONCE_ALREADY_USED}${wordOf(2n)}` as Hex, text: "NonceAlreadyUsed(2)" };
    assert.ok(isNonceUsed(sepolia.callResult.revert, 2n));
    assert.ok(!isNonceUsed(sepolia.callResult.revert, 3n), "another lock's nonce is not this one's");
    const end = await sendJob(job, ctx());
    assert.equal(end.kind, "minted");
    sepolia.callResult = { ok: true, revert: null, text: "no revert" };
    sepolia.usedNonces.add(2n);
    const late = await sendJob(job, ctx());
    assert.equal(late.kind, "minted");
    assert.ok(late.kind === "minted" && !late.ours);
    assert.equal(signer.signed.length, 0);
    assert.equal(lines().length, 0);
  });

  it("waits, recording nothing, while the base fee is above the gate, the balance would fall below --keep or the sender has a pending transaction; refuses gas over the cap", async () => {
    fresh();
    sepolia.base = 2n * GWEI;
    assert.match(((await sendJob(job, ctx())) as { why: string }).why, /above --max-base-fee 1,500,000,000 wei/);
    sepolia.base = 20n;
    sepolia.funds = ETH / 20n;
    assert.match(((await sendJob(job, ctx())) as { why: string }).why, /--keep 0\.05 ETH stays/);
    sepolia.funds = ETH;
    sepolia.pendingNonce = 6;
    assert.match(((await sendJob(job, ctx())) as { why: string }).why, /pending transaction \(nonce 5, pending 6\)/);
    sepolia.pendingNonce = 5;
    sepolia.gas = 15_300_000;
    const over = await sendJob(job, ctx());
    assert.equal(over.kind, "failed");
    assert.match((over as { why: string }).why, /above Sepolia's 16,777,216 cap/);
    sepolia.gas = 600_000;
    sepolia.callResult = { ok: false, revert: null, text: "NotNewer(220100, 220200)" };
    assert.equal((await sendJob(job, ctx())).kind, "wait", "the chains moved: planned again");
    assert.equal(signer.signed.length, 0);
    assert.equal(lines().length, 0);
  });

  it("records a mined transaction that reverted, named by its replay, or as already minted when another transaction minted the lock first", async () => {
    fresh();
    signer.onPublish = (hash) => sepolia.receipts.set(hash, minted(hash, 0));
    const end = await sendJob(job, ctx());
    assert.equal(end.kind, "failed");
    assert.match((end as { why: string }).why, /reverted in block 11,980,800 \(replayed: NotNewer\(220000, 220100\)\)/);
    assert.equal(failedSendsOf(lines(), "2"), 1);
    sepolia.usedNonces.add(2n);
    // The next send's preflight sees used(2) and sends nothing; a receipt with status 0 then reads as minted by another.
    assert.equal((await sendJob(job, ctx())).kind, "minted");
    fresh();
    signer.onPublish = (hash) => {
      sepolia.receipts.set(hash, minted(hash, 0));
      sepolia.usedNonces.add(2n);
    };
    const first = await sendJob(job, ctx());
    assert.ok(first.kind === "minted" && !first.ours);
    const last = lines().at(-1);
    assert.ok(last?.kind === "result" && last.outcome === "already-minted");
  });

  it("keeps a history line a crash cut short out of the reading, and starts the next one on a line of its own", () => {
    fresh();
    writeFileSync(history, '{"kind":"attempt","id":"cut","lock":"2","pa');
    appendLine(history, { kind: "result", id: "x", lock: "2", txHash: null, outcome: "not-sent", why: "test", sepoliaBlock: null, gasUsed: null, effectiveGasPrice: null, at: new Date().toISOString() });
    const h = readHistory(history);
    assert.equal(h.bad, 1);
    assert.deepEqual(
      h.lines.map((l) => l.id),
      ["x"],
    );
  });

  it("does not broadcast a transaction once used(nonce) turned true while it was signed, and leaves its nonce free", async () => {
    fresh();
    signer.onSign = () => sepolia.usedNonces.add(2n);
    const end = await sendJob(job, ctx());
    assert.ok(end.kind === "minted" && !end.ours);
    assert.match(end.why, /was not broadcast, so it can never be mined, and nonce 5 stays free/);
    assert.equal(signer.signed.length, 1);
    assert.equal(signer.published.length, 0, "nothing was broadcast");
    assert.deepEqual(
      lines().map((l) => (l.kind === "result" ? `${l.kind}:${l.outcome}` : l.kind)),
      ["attempt", "signed", "result:not-sent"],
    );
    assert.equal(openAttempts(lines()).length, 0);
  });

  it("waits, recording nothing, while what our transactions cost over the last day and this one would pass --max-spend", async () => {
    fresh();
    const capped = (spent: bigint, maxSpend: bigint): SendCtx => ({ ...ctx(), fees: { ...ctx().fees, maxSpend }, spent: () => spent });
    // 660,000 gas at the next base fee and the priority fee: 660,000 x 1,020 wei.
    const next = 660_000n * 1_020n;
    const over = await sendJob(job, capped(ETH / 100n, ETH / 100n + next - 1n));
    assert.equal(over.kind, "wait");
    assert.match((over as { why: string }).why, /above --max-spend/);
    assert.equal(signer.signed.length, 0);
    signer.onPublish = (hash) => sepolia.receipts.set(hash, minted(hash));
    assert.equal((await sendJob(job, capped(ETH / 100n, ETH / 100n + next))).kind, "minted");
  });

  it("signs a stuck transaction's nonce again with fees 1/8 higher, only while that nonce is still the next, and within the cap", async () => {
    const old: Hex = `0x${"0e".repeat(32)}`;
    const stuck: Stuck = { txNonce: 5, maxFee: 10_000_000n, tip: 1_000n, hashes: [old], since: Date.now() - 11 * 60_000 };
    fresh();
    sepolia.pendingNonce = 6; // our stuck transaction
    signer.onPublish = (hash) => sepolia.receipts.set(hash, minted(hash));
    const end = await sendJob(job, ctx(), stuck);
    assert.ok(end.kind === "minted" && end.ours);
    assert.deepEqual(
      ["--nonce", "--gas-price", "--priority-gas-price"].map((f) => flag(signer.signed[0], f)),
      ["5", "11250000", "1125"],
    );
    const attempt = lines()[0];
    assert.ok(attempt.kind === "attempt" && attempt.txNonce === 5 && attempt.maxFee === "11250000");
    // The old one was mined first: pending, and the next round settles both.
    fresh();
    sepolia.pendingNonce = 6;
    sepolia.receipts.set(old, minted(old));
    const first = await sendJob(job, ctx(), stuck);
    assert.equal(first.kind, "pending");
    // A transaction at the nonce was mined meanwhile, or another one is pending too: not signed again.
    fresh();
    sepolia.latest = 6;
    sepolia.pendingNonce = 6;
    assert.match(((await sendJob(job, ctx(), stuck)) as { why: string }).why, /next nonce is 6, not the stuck 5/);
    sepolia.latest = 5;
    sepolia.pendingNonce = 7;
    assert.match(((await sendJob(job, ctx(), stuck)) as { why: string }).why, /more pending than our stuck transaction/);
    // --max-fee given, and already what the stuck one offers: never signed again above it.
    sepolia.pendingNonce = 6;
    const fixed: SendCtx = { ...ctx(), fees: { ...ctx().fees, maxFee: 10_000_000n } };
    assert.match(((await sendJob(job, fixed, stuck)) as { why: string }).why, /needs a max fee above 10,000,000 wei/);
    assert.equal(signer.signed.length, 0);
    assert.equal(lines().length, 0);
  });

  it("settles the transactions signed at one nonce together: the one mined, the others replaced; pending past --replace-after, stuck", async () => {
    fresh();
    const at = Date.now();
    const a = attemptLine("a", 5, "10000000", "1000");
    const b = attemptLine("b", 5, "11250000", "1125");
    const ha: Hex = `0x${"0a".repeat(32)}`;
    const hb: Hex = `0x${"0b".repeat(32)}`;
    for (const line of [
      a,
      { kind: "signed", id: "a", lock: "2", txNonce: 5, txHash: ha, at: new Date(at - 21 * 60_000).toISOString() },
      b,
      { kind: "signed", id: "b", lock: "2", txNonce: 5, txHash: hb, at: new Date(at - 60_000).toISOString() },
    ] as HistoryLine[]) {
      appendLine(history, line);
    }
    sepolia.txs.set(ha, { blockNumber: null });
    sepolia.txs.set(hb, { blockNumber: null });
    const waiting = await settle(openAttempts(lines()), ctx(), 10 * 60_000, at);
    assert.equal(waiting.pending, hb);
    assert.equal(waiting.stuck, null, "the last was signed a minute ago");
    const later = await settle(openAttempts(lines()), ctx(), 10 * 60_000, at + 10 * 60_000);
    assert.deepEqual(later.stuck, { txNonce: 5, maxFee: 11_250_000n, tip: 1_125n, hashes: [ha, hb], since: at - 60_000 });
    assert.equal(later.results.length, 0);
    // One mined (a receipt served for it, and none for the other): the first gets the receipt, the other is replaced.
    sepolia.receipts.set(ha, minted(ha));
    const done = await settle(openAttempts(lines()), ctx(), 10 * 60_000, at);
    assert.deepEqual(
      done.results.map((r) => [r.id, r.outcome]),
      [
        ["a", "minted"],
        ["b", "replaced"],
      ],
    );
    assert.equal(openAttempts(lines()).length, 0);
    assert.equal(failedSendsOf(lines(), "2"), 0);
  });

  it("counts a line written twice once: an attempt is settled once, a failed send counted once, and none before the lock's --retry", () => {
    fresh();
    const a = attemptLine("a", 5, "10000000", "1000");
    const reverted = { kind: "result", id: "a", lock: "2", txHash: null, outcome: "reverted", why: "test", sepoliaBlock: 1, gasUsed: 100, effectiveGasPrice: "7", at: new Date().toISOString() } as HistoryLine;
    for (const line of [a, a]) appendLine(history, line);
    assert.equal(openAttempts(lines()).length, 1, "the attempt written twice is one");
    for (const line of [reverted, reverted]) appendLine(history, line);
    assert.equal(failedSendsOf(lines(), "2"), 1);
    assert.equal(spentSince(lines(), 0), 700n, "its cost counted once");
    assert.equal(spentSince(lines(), Date.now() + 60_000), 0n, "nothing settled since then");
    appendLine(history, { kind: "reset", id: "r", lock: "2", why: "--retry", at: new Date().toISOString() });
    assert.equal(failedSendsOf(lines(), "2"), 0, "the failed sends before --retry no longer count");
    appendLine(history, attemptLine("c", 6, "10000000", "1000"));
    appendLine(history, { ...(reverted as object), id: "c" } as HistoryLine);
    assert.equal(failedSendsOf(lines(), "2"), 1);
    assert.equal(readHistory(history).bad, 0);
  });

  it("finds the revert data where nodes put it, and NonceAlreadyUsed only for its own nonce", () => {
    const data = `0x${"aa".repeat(4)}${wordOf(7n)}` as Hex;
    assert.equal(revertData({ code: 3, message: "execution reverted", data }), data);
    assert.equal(revertData({ code: -32000, message: "execution reverted", data: { data } }), data);
    assert.equal(revertData({ code: -32000, message: "x", data: "not hex" }), null);
    assert.ok(isNonceUsed(`${NONCE_ALREADY_USED}${wordOf(7n)}` as Hex, 7n));
    assert.ok(!isNonceUsed(data, 7n));
    assert.ok(!isNonceUsed(null, 7n));
  });
});

// ---------------------------------------------------------------------------------------

describe("the fees, the gas and the waits", () => {
  it("raises a replacement's fees by at least 1/8 and to the current ones, never above the cap", () => {
    const now = feesFor(20n, {});
    assert.deepEqual(raisedFees({ maxFee: 10_000_000n, tip: 1_000n }, now, GWEI), { ...now, maxFee: 11_250_000n, tip: 1_125n });
    // The base fee rose past what the stuck one offers: the current fees, which are higher.
    const risen = feesFor(5_000_000n, {});
    assert.equal(raisedFees({ maxFee: 10_000_000n, tip: 1_000n }, risen, GWEI)?.maxFee, 50_001_000n);
    assert.equal(raisedFees({ maxFee: 10_000_000n, tip: 1_000n }, now, 11_249_999n), null);
    // The cap: --max-fee when given, else the max fee at a base fee of --max-base-fee.
    assert.equal(replacementCap({ maxBaseFee: 1_500_000_000n }, now), 15_000_001_000n);
    assert.equal(replacementCap({ maxBaseFee: 1_500_000_000n, maxFee: 3n * GWEI }, now), 3n * GWEI);
  });

  it("prices a send as the relayer does", () => {
    assert.deepEqual(feesFor(20n, {}), { base: 20n, tip: 1_000n, maxFee: 10_000_000n, gasPrice: 1_020n });
    assert.equal(feesFor(2n * GWEI, {}).maxFee, 20n * GWEI + 1_000n);
    assert.equal(feesFor(2n * GWEI, { priorityFee: GWEI, maxFee: 30n * GWEI }).maxFee, 30n * GWEI);
    assert.equal(feesFor(2n * GWEI, { priorityFee: GWEI }).tip, GWEI);
    assert.equal(gasLimitOf(600_000), 660_000);
    assert.equal(gasLimitOf(2_466_245), 2_712_870);
    // The largest estimate whose limit fits Sepolia's cap.
    assert.equal(gasLimitOf(15_252_014), GAS_CAP);
    assert.ok(gasLimitOf(15_252_015) > GAS_CAP);
  });

  it("waits --watch between rounds, twice as long after each round a node could not be reached, up to 10 minutes", () => {
    assert.equal(nextWait(15, 15, false), 15);
    assert.equal(nextWait(15, 15, true), 30);
    assert.equal(nextWait(15, 480, true), MAX_BACKOFF_SECONDS);
    assert.equal(nextWait(15, MAX_BACKOFF_SECONDS, false), 15);
    assert.equal(nextWait(900, 900, true), 900);
  });
});

// ---------------------------------------------------------------------------------------

describe("the state, the lock and the relayer's keys", () => {
  it("writes the state whole and reads it back; one that does not parse is kept aside and rebuilt; another sender's is refused", () => {
    const path = join(DIR, "automint-sepolia-state.json");
    const s = freshState();
    s.nextBlock = 220_001;
    s.locks["2"] = recordFor(lockedLog({ nonce: 2n, block: 220_000 }));
    saveState(path, s);
    assert.ok(!existsSync(`${path}.tmp`));
    const back = loadState(path, BRIDGE, SENDER, DEFAULT_START_BLOCK, true);
    assert.equal(back.state.nextBlock, 220_001);
    assert.deepEqual(back.state.locks["2"], s.locks["2"]);
    assert.throws(() => loadState(path, BRIDGE, "0x2222222222222222222222222222222222222222", DEFAULT_START_BLOCK, true), Fatal);
    // A half-written state (as a crash could leave without the temporary file): a dry run leaves it, a --send run sets it aside.
    writeFileSync(path, '{"version":1,"nextBlo');
    const dry = loadState(path, BRIDGE, SENDER, DEFAULT_START_BLOCK, false);
    assert.equal(dry.state.nextBlock, DEFAULT_START_BLOCK);
    assert.ok(existsSync(path), "a dry run moves nothing");
    const rebuilt = loadState(path, BRIDGE, SENDER, 200_000, true);
    assert.equal(rebuilt.state.nextBlock, 200_000);
    assert.match(rebuilt.note, /kept as .*unreadable-/);
    assert.ok(!existsSync(path));
  });

  it("lets one process per key hold the lock", () => {
    const files = filesOf(DIR, SENDER);
    assert.match(files.lock, /automint-sepolia-0x1111111111111111111111111111111111111111\.lock$/);
    // A lock left by a process that is gone, as a crash leaves it: taken over.
    writeFileSync(files.lock, JSON.stringify({ pid: 2_147_483_646, token: "an earlier run" }));
    const a = takeLock(files.lock, () => undefined, undefined, "auto-mint");
    assert.ok(a?.held());
    const lines: string[] = [];
    assert.equal(takeLock(files.lock, (l) => lines.push(l), undefined, "auto-mint"), null);
    assert.match(lines.join("\n"), /auto-mint \(process \d+\) holds/);
    a!.release();
  });

  it("lets one auto-mint per minter run, whatever its key or state directory, and waits for a held lock with --watch", async () => {
    const minterLock = minterLockOf(MINTER, DIR);
    assert.equal(minterLock, join(DIR, `automint-sepolia-minter-${MINTER}.lock`));
    for (const dir of ["one", "two"]) mkdirSync(join(DIR, dir), { recursive: true });
    const first = await holdLocks([minterLock, filesOf(join(DIR, "one"), SENDER).lock]);
    assert.ok(first);
    // Another key, another state directory: the minter's lock still refuses it, and none of its locks is kept.
    const other = filesOf(join(DIR, "two"), "0x2222222222222222222222222222222222222222" as Hex).lock;
    assert.equal(await holdLocks([minterLock, other]), null);
    assert.equal(await holdLocks([other, minterLock]), null);
    const free = takeLock(other, () => undefined, undefined, "auto-mint");
    assert.ok(free, "the key's lock was let go when the minter's could not be taken");
    free.release();
    // With --watch, asked for again until it is free (as a crash's lock once watch.ts takes it over).
    let waits = 0;
    const second = await holdLocks([minterLock, other], 15, async (ms) => {
      assert.equal(ms, 15_000);
      waits += 1;
      if (waits === 2) for (const lock of first.reverse()) lock.release();
    });
    assert.equal(waits, 2);
    assert.ok(second?.every((lock) => lock.held()));
    for (const lock of second!.reverse()) lock.release();
  });

  it("asks a lock that reads as not held again before it counts as lost (a file Windows reports busy for a moment)", () => {
    let calls = 0;
    assert.equal(stillHeld({ held: () => ++calls >= 3 }, 20, 1), true);
    assert.equal(calls, 3);
    calls = 0;
    assert.equal(stillHeld({ held: () => (calls++, false) }, 4, 1), false);
    assert.equal(calls, 4);
  });

  it("refuses a key a relayer has sent with, on any chain and however long ago, in any directory a relayer keeps its files in", () => {
    const a = mkdtempSync(join(DIR, "keys-a-"));
    const b = mkdtempSync(join(DIR, "keys-b-"));
    const recent = "0x3333333333333333333333333333333333333333" as Hex;
    writeFileSync(join(a, `relay-sepolia-${recent}.json`), "{}");
    assert.match(relayerKeyProblem([a, b], recent) ?? "", /is a relayer's: 0x3333.* is a relayer's key, and auto-mint needs a key of its own/);
    const old = "0x4444444444444444444444444444444444444444" as Hex;
    const record = join(b, `relay-sepolia-${old}.jsonl`);
    writeFileSync(record, "");
    const twoDays = new Date(Date.now() - 2 * 24 * 3_600_000);
    utimesSync(record, twoDays, twoDays);
    assert.notEqual(relayerKeyProblem([a, b], old), null, "a relayer that has not sent for two days may still run");
    const base = "0x5555555555555555555555555555555555555555" as Hex;
    writeFileSync(join(a, `relay-base-sepolia-${base}.json`), "{}");
    assert.notEqual(relayerKeyProblem([a, b], base), null);
    const running = "0x6666666666666666666666666666666666666666" as Hex;
    writeFileSync(join(b, `relay-sepolia-${running}.lock`), "{}");
    assert.notEqual(relayerKeyProblem([a, b], running), null);
    // auto-mint's own files, another key's, or a directory that is not there are no relayer's.
    const own = "0x7777777777777777777777777777777777777777" as Hex;
    writeFileSync(join(a, `automint-sepolia-${own}.json`), "{}");
    assert.equal(relayerKeyProblem([a, b, join(a, "no-such-directory")], own), null);
    // The relayers' directory and deployments/ are looked in whatever --state-dir is; this checkout's
    // deployments/ keeps the histories of bz-relayer, bz-relayer-mainnet and the deployer.
    assert.deepEqual(keyDirsOf(a, b, ROOT), [a, b, join(ROOT, "deployments")]);
    for (const key of ["0xe94a82e2c7f38f777e8845a9d8c36b6be6a30257", "0x99268e630f7f24b0f9b000cea7b0350b3098c7f8", D983] as Hex[]) {
      assert.notEqual(relayerKeyProblem([join(ROOT, "deployments")], key), null, key);
    }
  });

  it("--retry takes in again a lock left to the operator, its failed sends no longer counting, and never one skipped for what its log gives", () => {
    const password = join(DIR, "retry-password.txt");
    writeFileSync(password, "not a password\n");
    const sender = "0x8888888888888888888888888888888888888888" as Hex;
    const dir = mkdtempSync(join(DIR, "retry-"));
    const o = parseOptions(["--send", "--account", "k", "--password-file", password, "--state-dir", dir, "--retry", "2"]);
    assert.equal(o.retry, 2n);
    const files = filesOf(dir, sender);
    const state = { ...freshState(), sender };
    state.locks["2"] = { ...recordFor(lockedLog({ nonce: 2n, block: 220_000 })), status: "skipped", why: "3 of our transactions ...", left: "failed-sends" };
    state.locks["3"] = { ...recordFor(lockedLog({ nonce: 3n, block: 220_010 })), status: "skipped", why: "its commitment names chain 84532" };
    state.locks["4"] = recordFor(lockedLog({ nonce: 4n, block: 220_020 }));
    for (const id of ["x", "y", "z"]) {
      appendLine(files.history, { kind: "attempt", id, lock: "2", path: "held", block: { number: 220_100, hash: `0x${"dd".repeat(32)}` }, to: MINTER, dataHash: `0x${"00".repeat(32)}`, sender, txNonce: 1, recipient: D983, amount: ONE_TPOT.toString(), gas: 1, gasLimit: 2, maxFee: "1", priorityFee: "1", at: new Date().toISOString() });
      appendLine(files.history, { kind: "result", id, lock: "2", txHash: null, outcome: "reverted", why: "test", sepoliaBlock: 1, gasUsed: 1, effectiveGasPrice: "1", at: new Date().toISOString() });
    }
    assert.equal(failedSendsOf(readHistory(files.history).lines, "2"), MAX_FAILED_SENDS);
    const run = { o, bridge: BRIDGE, sender, files, state, locks: [], accounted: new Set() } as unknown as Run;
    assert.equal(retryLock(run, 2n), true);
    assert.equal(state.locks["2"].status, "pending");
    assert.equal(state.locks["2"].left, undefined);
    assert.equal(readHistory(files.history).lines.at(-1)?.kind, "reset");
    assert.equal(failedSendsOf(readHistory(files.history).lines, "2"), 0);
    assert.equal(loadState(files.state, BRIDGE, sender, DEFAULT_START_BLOCK, true).state.locks["2"].status, "pending", "saved");
    assert.equal(retryLock(run, 3n), false, "a lock for another chain is never minted");
    assert.equal(state.locks["3"].status, "skipped");
    assert.equal(retryLock(run, 4n), true, "a pending lock: nothing to do");
    assert.equal(retryLock(run, 9n), false, "not in the state");
  });
});

// ---------------------------------------------------------------------------------------

describe("the vault's nonces against the state", () => {
  const BRIDGE_FULL = { ...BRIDGE, vaultBlock: 100_955, v3Genesis: `0x${"00".repeat(32)}`, token: `0x${"11".repeat(20)}`, client: `0x${"22".repeat(20)}` } as Bridge;
  const LOGS = [lockedLog({ nonce: 0n, block: 101_009 }), lockedLog({ nonce: 1n, block: 118_636 }), lockedLog({ nonce: 2n, block: 218_500 })];
  const runWith = (nextNonce: number, logs = LOGS) => {
    const asked: { method: string; params: unknown[] }[] = [];
    const evm = {
      call: async <T>(method: string, params: unknown[]): Promise<T> => {
        asked.push({ method, params });
        if (method === "eth_getStorageAt") return `0x${nextNonce.toString(16)}` as T;
        assert.equal(method, "eth_getLogs");
        const f = params[0] as { topics: string[]; fromBlock: string; toBlock: string };
        const from = Number(f.fromBlock);
        const to = Number(f.toBlock);
        assert.ok(to - from + 1 <= LOG_WINDOW, `a window of ${to - from + 1} blocks`);
        return logs.filter((l) => Number(l.blockNumber) >= from && Number(l.blockNumber) <= to && (f.topics.length < 2 || l.topics[1] === f.topics[1])) as T;
      },
    };
    const state = freshState();
    state.nextBlock = 219_101; // the scan read up to #219,100 and missed lock 2 (#218,500): the RPC's log index lagged
    const run = {
      o: parseOptions(["--state-dir", DIR]),
      bridge: BRIDGE_FULL,
      sender: SENDER,
      files: filesOf(DIR, SENDER),
      state,
      sepolia: { used: async (nonce: bigint) => nonce < 2n },
      evm,
      locks: [],
      accounted: new Set<string>(),
    } as unknown as Run;
    return { run, asked };
  };

  /** A stand-in for the lookup in System.Events: `found` by nonce, every call recorded. */
  const lookup = (found: Map<bigint, FoundLock | Error> = new Map()) => {
    const calls: { nonce: bigint; hint: { from?: number; block?: number } }[] = [];
    const fn: SubstrateLookup = async (nonce, hint) => {
      calls.push({ nonce, hint });
      const f = found.get(nonce);
      if (f instanceof Error) throw f;
      return f ?? null;
    };
    return { fn, calls };
  };
  /** Lock 3 as the lookup finds it in System.Events of #222,024: a Substrate extrinsic's Locked event, as the log eth_getLogs would give. */
  const EXTRINSIC: Hex = "0x953fc65cac111af0db9f6109ece77984067425be6b58b610b52ebc2d4627b7f7";
  const LOCK3: FoundLock = {
    log: { ...lockedLog({ nonce: 3n, block: 222_024, amount: 10n ** 11n }), transactionHash: EXTRINSIC, blockHash: `0x${"ea".repeat(32)}`, logIndex: "0x3" },
    block: { number: 222_024, hash: `0x${"ea".repeat(32)}` },
    extrinsic: { index: 1, hash: EXTRINSIC },
  };

  it("takes in a lock the scan missed, reads nextNonce at the finalized block, and looks up in windows of 10,000 blocks", async () => {
    const { run, asked } = runWith(3);
    const none = lookup();
    quiet.length = 0;
    await accountForNonces(run, 219_100, none.fn);
    assert.deepEqual(asked[0], { method: "eth_getStorageAt", params: [VAULT, "0x1", "0x357dc"] }, "nextNonce at #219,100");
    assert.equal(run.state.locks["2"]?.status, "pending");
    assert.equal(run.state.locks["2"]?.via, undefined, "found by eth_getLogs");
    assert.match(quiet.join("\n"), /WARN the scan missed lock 2 \(#218,500/);
    assert.deepEqual([...run.accounted].sort(), ["0", "1"]);
    assert.match(quiet.join("\n"), /lock 0 \(#101,009, below the scan's start #218,400\): minted already/);
    assert.equal(none.calls.length, 0, "eth_getLogs had every log: System.Events was not read");
    // The next round looks nothing up again.
    asked.length = 0;
    await accountForNonces(run, 219_200, none.fn);
    assert.deepEqual(
      asked.map((a) => a.method),
      ["eth_getStorageAt"],
    );
  });

  it("warns of a nonce the vault counts at a final block that no lookup finds, and looks it up again next round", async () => {
    const { run } = runWith(4);
    const none = lookup();
    quiet.length = 0;
    await accountForNonces(run, 219_100, none.fn);
    assert.match(quiet.join("\n"), /WARN the vault's nextNonce at V3 #219,100, a final block, counts lock 3, but neither V3's EVM RPC \(eth_getLogs\) nor System\.Events at the V3 node's finalized head has its Locked event yet/);
    assert.deepEqual(none.calls, [{ nonce: 3n, hint: { from: 218_500 } }], "System.Events searched from lock 2's block");
    assert.equal(run.state.locks["3"], undefined);
    assert.ok(!run.accounted.has("3"));
  });

  it("takes in a lock only System.Events holds (a Substrate extrinsic's), once, whichever source finds it", async () => {
    const { run, asked } = runWith(4);
    const found = lookup(new Map([[3n, LOCK3]]));
    quiet.length = 0;
    await accountForNonces(run, 222_100, found.fn);
    const rec = run.state.locks["3"];
    assert.equal(rec?.status, "pending");
    assert.equal(rec?.via, "System.Events");
    assert.equal(rec?.txHash, EXTRINSIC, "the extrinsic's hash stands for the transaction's");
    assert.deepEqual([rec?.block, rec?.amount], [222_024, (10n ** 11n).toString()]);
    assert.deepEqual(found.calls, [{ nonce: 3n, hint: { from: 218_500 } }]);
    assert.match(quiet.join("\n"), /new lock 3 \(#222,024, 0\.001 tPOT for 0xD9838A86…a2971071\), found in System\.Events of #222,024, extrinsic 0x953fc65c\w+: a lock sent as a Substrate extrinsic/);
    assert.doesNotMatch(quiet.join("\n"), /WARN[^\n]*lock 3/, "a Substrate extrinsic's lock is expected there, not a warning");
    // Its EVM log, should eth_getLogs ever give it: the same lock, taken in once.
    const again = absorbLogs(run.state, [lockedLog({ nonce: 3n, block: 222_024, amount: 10n ** 11n })], BRIDGE);
    assert.deepEqual([again.added.length, again.conflicts.length, run.state.locks["3"].status], [0, 0, "pending"]);
    // The other order: a lock eth_getLogs gave, then System.Events.
    const s = freshState();
    absorbLogs(s, [lockedLog({ nonce: 3n, block: 222_024, amount: 10n ** 11n })], BRIDGE);
    const later = absorbLogs(s, [LOCK3.log], BRIDGE, Date.now(), "System.Events");
    assert.deepEqual([later.added.length, later.conflicts.length, Object.keys(s.locks).length, s.locks["3"].via], [0, 0, 1, undefined]);
    // The next round looks nothing up.
    found.calls.length = 0;
    asked.length = 0;
    await accountForNonces(run, 222_200, found.fn);
    assert.deepEqual([found.calls.length, asked.map((a) => a.method)], [0, ["eth_getStorageAt"]]);
  });

  it("looks up at most MAX_LOOKUPS_PER_ROUND nonces a round, and goes on past one whose lookup fails", async () => {
    const { run } = runWith(3 + MAX_LOOKUPS_PER_ROUND + 2);
    const failing = lookup(new Map<bigint, FoundLock | Error>([[3n, new Error("the node answered something else")]]));
    quiet.length = 0;
    await accountForNonces(run, 222_100, failing.fn);
    assert.deepEqual(
      failing.calls.map((c) => c.nonce),
      Array.from({ length: MAX_LOOKUPS_PER_ROUND }, (_, i) => BigInt(3 + i)),
    );
    assert.match(quiet.join("\n"), /WARN lock 3: its lookup failed \(the node answered something else\): looked up again next round/);
    assert.match(quiet.join("\n"), new RegExp(`more nonces of the vault are not in the state yet, from ${3 + MAX_LOOKUPS_PER_ROUND}: a later round looks them up`));
    // A node that does not answer ends the check for the round (the round goes on with the locks it has).
    const down = lookup(new Map([[3n, new Unreachable("the V3 node did not answer")]]));
    await assert.rejects(accountForNonces(runWith(4).run, 222_100, down.fn), Unreachable);
  });

  it("lookupHint: a lookup starts at the block of the state's latest lock below the nonce", () => {
    const s = freshState();
    assert.deepEqual(lookupHint(s, 3n), {});
    absorbLogs(s, [lockedLog({ nonce: 1n, block: 218_450 }), lockedLog({ nonce: 2n, block: 218_500 }), lockedLog({ nonce: 5n, block: 230_000 })], BRIDGE);
    assert.deepEqual(lookupHint(s, 3n), { from: 218_500 });
    assert.deepEqual(lookupHint(s, 2n), { from: 218_450 });
  });
});

// ---------------------------------------------------------------------------------------

describe("the options", () => {
  const password = join(DIR, "not-a-password.txt");
  writeFileSync(password, "not a password\n");

  it("dry-runs by default, and takes a key and a password file only with --send", () => {
    const o = parseOptions([]);
    assert.equal(o.send, false);
    assert.equal(o.graceMs, 90_000, "the app still offers the locker its own mint: it is not raced");
    assert.equal(o.replaceAfterMs, 10 * 60_000);
    assert.equal(o.minAmount, 10n ** 11n, "0.001 tPOT");
    assert.equal(o.maxSpend, 2n * 10n ** 16n, "0.02 ETH a day");
    assert.equal(o.keep, 5n * 10n ** 16n);
    assert.equal(o.maxBaseFee, 1_500_000_000n);
    assert.equal(parseOptions(["--grace", "0", "--min-amount", "0", "--max-spend", "0.5", "--replace-after", "5"]).graceMs, 0);
    assert.equal(parseOptions(["--min-amount", "0"]).minAmount, 0n);
    assert.equal(parseOptions(["--min-amount", "1.5"]).minAmount, 15n * 10n ** 13n);
    assert.throws(() => parseOptions(["--account", "k"]), Usage);
    assert.throws(() => parseOptions(["--send"]), Usage);
    assert.throws(() => parseOptions(["--send", "--account", "k", "--password-file", join(DIR, "no-such-file")]), Usage);
    const s = parseOptions(["--send", "--account", "k", "--password-file", password, "--watch", "15", "--grace", "60", "--keep", "0.02", "--from", "218000"]);
    assert.deepEqual([s.send, s.watch, s.graceMs, s.keep, s.from], [true, 15, 60_000, 2n * 10n ** 16n, 218_000]);
  });

  it("refuses what a dry run or a send does not take", () => {
    assert.throws(() => parseOptions(["--send", "--account", "k", "--password-file", password, "--sender", SENDER]), Usage);
    assert.throws(() => parseOptions(["--send", "--account", "k", "--password-file", password, "--rehearse", "1"]), Usage);
    assert.throws(() => parseOptions(["--rehearse", "1", "--watch", "15"]), Usage);
    assert.throws(() => parseOptions(["--watch", "5"]), Usage);
    assert.throws(() => parseOptions(["--grace", "-1"]), Usage);
    assert.throws(() => parseOptions(["--from", "1e5"]), Usage);
    assert.throws(() => parseOptions(["--keep", "abc"]), Usage);
    assert.throws(() => parseOptions(["--sender", "0x12"]), Usage);
    assert.throws(() => parseOptions(["--rpc", "https://example.org"]), Usage);
    assert.throws(() => parseOptions(["--priority-fee", "2", "--max-fee", "1"]), Usage);
    assert.throws(() => parseOptions(["--no-such-option"]), Usage);
    assert.throws(() => parseOptions(["--retry", "2"]), Usage, "--retry writes: it needs --send");
    assert.throws(() => parseOptions(["--send", "--account", "k", "--password-file", password, "--retry", "x"]), Usage);
    assert.throws(() => parseOptions(["--max-spend", "0"]), Usage);
    assert.throws(() => parseOptions(["--replace-after", "0"]), Usage);
    assert.throws(() => parseOptions(["--min-amount", "0.000000000000001"]), Usage, "below one native base unit");
    assert.equal(parseOptions(["--sender", SENDER.toUpperCase().replace("0X", "0x")]).sender, SENDER);
    assert.equal(parseOptions(["--rehearse", "1"]).rehearse, 1n);
  });
});

// ---------------------------------------------------------------------------------------

describe("the timeouts: no request may stall the loop", () => {
  const sockets: Socket[] = [];
  let silent: Server;
  let answers: Server;
  let flaky: Server;
  let reverts: Server;
  let mute: TcpServer;
  let ws: Server;
  const url = (s: Server | TcpServer, scheme = "http") => `${scheme}://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const listen = (s: Server | TcpServer) => new Promise<void>((ok) => s.listen(0, "127.0.0.1", () => ok()));
  const reply = (body: object) => (_req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }));
  };

  before(async () => {
    // Takes the request and never answers it.
    silent = createHttpServer(() => undefined);
    silent.on("connection", (s) => sockets.push(s));
    answers = createHttpServer(reply({ result: "0xaa36a7" }));
    flaky = createHttpServer(reply({ error: { code: -32603, message: "internal error" } }));
    reverts = createHttpServer(reply({ error: { code: 3, message: "execution reverted", data: "0x12345678" } }));
    // Takes the connection and never answers the WebSocket handshake.
    mute = createTcpServer((s) => sockets.push(s));
    // Answers the handshake, then no request; hangs up on the close frame.
    ws = createHttpServer();
    ws.on("upgrade", (req, socket: Socket) => {
      sockets.push(socket);
      const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      socket.on("data", (chunk: Buffer) => {
        if ((chunk[0] & 0x0f) === 0x8) socket.destroy();
      });
      socket.on("error", () => undefined);
    });
    for (const s of [silent, answers, flaky, reverts, mute, ws]) await listen(s);
  });

  after(() => {
    for (const s of sockets) s.destroy();
    for (const s of [silent, answers, flaky, reverts, ws]) {
      s.closeAllConnections();
      s.close();
    }
    mute.close();
  });

  it("gives up an HTTP RPC that does not answer after its timeout, and asks the next endpoint", async () => {
    const started = Date.now();
    // The endpoint that answers has the same timeout, so it is 1 s: with 300 ms, a busy machine (npm
    // test runs the files side by side) made that endpoint miss it.
    const rpc = new HttpRpc("test RPC", [url(silent), url(answers)], 1_000, 1);
    assert.equal(await rpc.call<string>("eth_chainId", []), "0xaa36a7");
    assert.ok(Date.now() - started < 3_000);
    assert.equal(rpc.lastUrl, url(answers));
    const alone = new HttpRpc("test RPC", [url(silent)], 300, 2, 10);
    const t = Date.now();
    await assert.rejects(alone.call("eth_chainId", []), (e: unknown) => e instanceof Unreachable && /did not answer eth_chainId/.test(e.message));
    assert.ok(Date.now() - t < 3_000, "two tries of 300 ms, not a hang");
  });

  it("asks the next endpoint after a transient error, and takes a revert as an answer", async () => {
    assert.equal(await new HttpRpc("test RPC", [url(flaky), url(answers)], 1_000, 1).call<string>("eth_chainId", []), "0xaa36a7");
    const body = await new HttpRpc("test RPC", [url(reverts), url(answers)], 1_000, 1).body("eth_call", []);
    assert.equal(revertData(body.error!), "0x12345678");
    assert.equal((await new HttpRpc("test RPC", [url(silent), url(answers)], 1_000, 1).firstNonNull<string>("eth_getTransactionReceipt", ["0x00"])), "0xaa36a7");
  });

  it("gives up a V3 node that does not answer the handshake, or a request, after its timeout", async () => {
    const t = Date.now();
    await assert.rejects(openV3(url(mute, "ws"), { connectMs: 300, requestMs: 300 }), Unreachable);
    assert.ok(Date.now() - t < 3_000);
    const chain = await openV3(url(ws, "ws"), { connectMs: 2_000, requestMs: 300 });
    try {
      const r = Date.now();
      await assert.rejects(
        v3("the finalized head", () => chain.rpc.request("chain_getFinalizedHead")),
        (e: unknown) => e instanceof Unreachable && /no response after 300 ms/.test(e.message),
      );
      assert.ok(Date.now() - r < 3_000);
    } finally {
      await chain.rpc.close();
    }
  });

  it("gives up a read that hangs, such as a capture, after its deadline", async () => {
    const t = Date.now();
    await assert.rejects(withDeadline(new Promise(() => undefined), 200, "a capture"), (e: unknown) => e instanceof Unreachable && /a capture did not finish within 0 s/.test(e.message));
    assert.ok(Date.now() - t < 2_000);
    assert.equal(await withDeadline(Promise.resolve(7), 200, "a read"), 7);
  });

  it("kills cast when it runs past its timeout", () => {
    const t = Date.now();
    const hung = runTool(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], 500);
    assert.equal(hung.ok, false);
    assert.equal(hung.timedOut, true);
    assert.ok(Date.now() - t < 10_000);
    const quick = runTool(process.execPath, ["-e", "console.log('0xabc')"], 20_000);
    assert.equal(quick.ok, true);
    assert.equal(quick.stdout.trim(), "0xabc");
  });
});
