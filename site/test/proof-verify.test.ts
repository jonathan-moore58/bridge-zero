// The Verify page's core: each check on recorded data, and the runs against fake chains. Lock 0's
// mint (test/fixtures/hero-mint.json) and its set 30 passes all six; the Lab's tampers, made here
// offline on the same calldata, each fail exactly the step the contracts fail at, with its reason,
// and the steps after it are not reached; lock 1's account proof, which the minter did not read, is
// not taken for a bind; lock 3's mint(p) passes through the import that brought its block in; locks
// 4 and 5 check out on the rollups; inputs not served are not checked, never passed; a replay that
// pauses, mints again or stops early is told apart; route B and the fallback from V3 now; the
// burns' ids and burn 1's run, its B4 trusted, never passed; and the key history over three set
// changes, one tampered. Then the review's cases: step 6 passes only on an answer read just now;
// step 2's and step 6's failures; two RPCs' headerOf compared; a red cross-check reaches the
// verdict; a mint through Multicall3 after a set change; route B's verdict by its step 6; the keys
// carried through a set change; the way back's title by what B1 and B3 found, its failures, and B4
// trusted whatever they found; the V3 node's proof that does not walk, a red line; a mint(p) at a
// block the client does not hold; a V3 head header that does not hash to its block. Offline: the
// fakes answer from the fixtures (test/fixtures/verify-locks.json was captured read-only from the
// public nodes).

import assert from "node:assert/strict";
import { test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { decode } from "../src/lib/abi.ts";
import { importArgs, SIG } from "../src/lib/calls.ts";
import { eventTopic, selector } from "../src/lib/hashes.ts";
import { bytesToHex, concatBytes, hexToBytes, u64le, type Hex } from "../src/lib/hex.ts";
import { NO_L1 } from "../src/lib/l1.ts";
import { aggregate3Calldata, importAndMintCalldata, importHeaderCalldata, MULTICALL3 } from "../src/lib/proof/calldata.ts";
import { clientCrypto, signersHint } from "../src/lib/proof/grandpa.ts";
import type { MintPlan } from "../src/lib/proof/plan.ts";
import { childItems, childRootKey } from "../src/lib/proof/revive.ts";
import { decodeFinalityProof, decodeHeader, decodeJustification, encodeCompact, encodeRpcHeader, type RpcHeader } from "../src/lib/proof/scale.ts";
import { revertOf } from "../src/lib/proof/sepolia.ts";
import { provenValue, readProof } from "../src/lib/proof/trie.ts";
import { signedChecked, verdictOf } from "../src/lib/proof/verdict.ts";
import {
  checkCommitment,
  checkHeader,
  checkMintLogs,
  checkSignatures,
  checkStorage,
  decodeMintCall,
  importFrom,
  keyHistory,
  keysHash,
  nonceUsedData,
  plainWhy,
  releasedKey,
  replayOutcome,
  verifyBurn,
  verifyMinted,
  verifyUnminted,
  wordValue,
  type BurnTarget,
  type DestEnv,
  type History,
  type MintedLock,
  type RawLog,
  type Run,
  type UnmintedLock,
  type VerifyEnv,
} from "../src/lib/proof/verify.ts";
import { burnId, lockCommitment } from "../src/lib/proofs.ts";
import { AllFailed, type Endpoint } from "../src/lib/rpc.ts";
import {
  B as LOCK1_BLOCK,
  bundle as lock1Bundle,
  enc,
  fakeFetch,
  FakeV3,
  GENESIS,
  HELD_116992,
  HttpOnly,
  LIGHT_CLIENT,
  MINTER,
  MULTICALL_FAILED,
  proveFrom,
  readJson,
  registry,
  restoreFetch,
  revertData,
  RpcFail,
  S0,
  VAULT,
} from "./fake-chains.ts";

const crypto = clientCrypto(ed25519, sha512);
const hero = readJson("site/test/fixtures/hero-mint.json");
const heroBundle = readJson("fixtures/v3-testnet-hero/mint-bundle.json");
const F = readJson("site/test/fixtures/verify-locks.json");
const KEYS: Hex[] = heroBundle.signingSet.authorities.map((a: { id: Hex }) => a.id);
const KEY_BYTES = KEYS.map(hexToBytes);
const TRIE_ID: Hex = heroBundle.vault.trieId;
const CODE_HASH: Hex = heroBundle.vault.codeHash;
const B0: Hex = heroBundle.header.hash;
const ROLLUP_LC: Hex = "0x389781d4856f0a9f3266ca6e76be6c7b7cfe0ab6";
const ROLLUP_MINTER: Hex = "0xdc31a3bc1354545eeb985aad7b2aa662e9272348";
const SEPOLIA_ID = 11_155_111n;
const V3_ID = 420_420_777n;
const keysOf = (data: Hex): Uint8Array[] => (decode("bytes32[]", data)[0] as Hex[]).map(hexToBytes);

// ---------------------------------------------------------------------------------------------
// The checks, on lock 0's recorded mint

test("lock 0: importAndMint decodes, the header is #108,424, 2 of 2 signatures of set 30, the bind, the proven commitment and the receipt's logs", () => {
  const call = decodeMintCall(hero.input, MINTER, LIGHT_CLIENT);
  assert.equal(call.method, "importAndMint");
  assert.equal(call.multicall, false);
  const imp = call.imported;
  assert.ok(imp);
  const h = checkHeader(imp, call.p.blockHash);
  assert.equal(h.problem, null);
  assert.equal(bytesToHex(h.hash), "0xc89b7e6c5d7596897e677d464a9cc5ca373a69412f810d3f003d7aa8761e4e6d");
  assert.equal(h.header?.number, 108_424);
  assert.ok(h.j && h.header);
  const s = checkSignatures(h.j, KEY_BYTES, 30n, crypto, imp.signers);
  assert.equal(s.problem, null);
  assert.deepEqual([s.result.valid, s.result.total, s.result.required], [2, 2, 2]);
  assert.equal(bytesToHex(s.hint ?? new Uint8Array()), "0x01000001");
  const st = checkStorage(h.header.stateRoot, call.p, hexToBytes(TRIE_ID), VAULT, hexToBytes(CODE_HASH));
  assert.equal(st.problem, null);
  assert.ok(st.bind && st.value);
  assert.ok(bytesToHex(st.bind.trieId).startsWith("0xbe30"));
  assert.match(bytesToHex(st.bind.codeHash), /^0xa725.*3f$/);
  assert.equal(call.p.accountProof.length, 7);
  assert.deepEqual([call.p.childRootProof.length, call.p.slotProof.length], [6, 2]);
  assert.match(bytesToHex(st.value), /^0x9eba.*35$/);
  const c = checkCommitment({ v3ChainId: V3_ID, vault: VAULT, dstChainId: SEPOLIA_ID, minter: MINTER }, call.p, st.value);
  assert.equal(c.problem, null);
  assert.equal(c.expected, lockCommitment({ v3ChainId: V3_ID, vault: VAULT, dstChainId: SEPOLIA_ID, minter: MINTER, recipient: call.p.recipient, amountNative: call.p.amount, nonce: 0n }));
  const logs = checkMintLogs(
    hero.receipt.logs,
    { minter: MINTER, lightClient: LIGHT_CLIENT, block: B0, number: 108_424, stateRoot: bytesToHex(h.header.stateRoot), setId: 30n, p: call.p, imported: true },
    registry,
  );
  assert.equal(logs.problem, null);
  const said = logs.lines.map((l) => l.text).join("\n");
  for (const what of ["HeaderImported(#108,424, set 30, 2 signatures)", "VaultBound", "Transfer of 1 wtPOT", "Minted(0,"]) assert.ok(said.includes(what), what);
  assert.ok(logs.lines.every((l) => l.ok === true));
  assert.equal(replayOutcome(revertOf(nonceUsedData(0n), "execution reverted", registry), 0n).kind, "used");
  assert.equal(nonceUsedData(0n), `0x91cab504${"0".repeat(64)}`);
  // Without the bind (a later mint, which the minter does not read it for) the same proofs give the same word.
  const later = checkStorage(h.header.stateRoot, call.p, hexToBytes(TRIE_ID), VAULT, hexToBytes(CODE_HASH), false);
  assert.equal(later.bind, null);
  assert.equal(bytesToHex(later.value!), bytesToHex(st.value));
});

test("wrong keys, a wrong set id or a missing signature fail the signatures, in verifyJustification's words", () => {
  const call = decodeMintCall(hero.input, MINTER, LIGHT_CLIENT);
  const h = checkHeader(call.imported!, call.p.blockHash);
  const j = h.j!;
  const other = [ed25519.Point.BASE.multiply(7n).toBytes(), ed25519.Point.BASE.multiply(11n).toBytes()];
  assert.match(checkSignatures(j, other, 30n, crypto, null).problem?.text ?? "", /signer is not in the authority set/);
  assert.equal(checkSignatures(j, KEY_BYTES, 31n, crypto, null).problem?.text, "precommit 0: invalid signature");
  const one = { ...j, precommits: j.precommits.slice(0, 1) };
  assert.equal(checkSignatures(one, KEY_BYTES, 30n, crypto, null).problem?.text, "1 valid signatures, 2 required");
  // A hint that names other precommits than the ones that verify.
  assert.equal(checkSignatures(j, KEY_BYTES, 30n, crypto, hexToBytes("0x00000101")).problem?.text, "the mint named other precommits");
});

test("lock 3: mint(p) at a block the client held passes through the importFinalityProof that brought #222,687 in", () => {
  const L = F.locks["3"];
  const call = decodeMintCall(L.mint.input, MINTER, LIGHT_CLIENT);
  assert.equal(call.method, "mint");
  assert.equal(call.imported, null);
  assert.equal(call.p.nonce, 3n);
  const imp = importFrom(L.import.input, call.p.blockHash);
  assert.equal(imp.method, "importFinalityProof");
  const h = checkHeader(imp, call.p.blockHash);
  assert.equal(h.problem, null);
  assert.equal(h.header?.number, 222_687);
  assert.equal(L.setId, 62);
  const s = checkSignatures(h.j!, keysOf(L.authorities), 62n, crypto, imp.signers);
  assert.equal(s.problem, null);
  assert.equal(bytesToHex(s.hint!), "0x01000001");
  const st = checkStorage(h.header!.stateRoot, call.p, hexToBytes(TRIE_ID), VAULT, null);
  assert.equal(st.problem, null);
  assert.equal(st.bind, null);
  assert.equal(checkCommitment({ v3ChainId: V3_ID, vault: VAULT, dstChainId: SEPOLIA_ID, minter: MINTER }, call.p, st.value!).problem, null);
  // Another import does not import its block.
  assert.throws(() => importFrom(F.locks["1"].mint.input, call.p.blockHash), /hashes to/);
});

test("locks 1, 2, 4 and 5: each mint's header, signatures, proofs and commitment check out on its own chain; lock 4's commitment names Base Sepolia and its minter", () => {
  const on: Record<string, { lc: Hex; minter: Hex; id: bigint }> = {
    sepolia: { lc: LIGHT_CLIENT, minter: MINTER, id: SEPOLIA_ID },
    "base-sepolia": { lc: ROLLUP_LC, minter: ROLLUP_MINTER, id: 84_532n },
    "arbitrum-sepolia": { lc: ROLLUP_LC, minter: ROLLUP_MINTER, id: 421_614n },
  };
  for (const n of ["1", "2", "4", "5"]) {
    const L = F.locks[n];
    const d = on[L.dest]!;
    const call = decodeMintCall(L.mint.input, d.minter, d.lc);
    const h = checkHeader(call.imported!, call.p.blockHash);
    assert.equal(h.problem, null, `lock ${n}`);
    assert.equal(bytesToHex(h.hash), L.block);
    const held = decode("(uint32,bytes32,uint64)", L.headerOf)[0] as [bigint, Hex, bigint];
    assert.equal(held[1].toLowerCase(), bytesToHex(h.header!.stateRoot), `lock ${n}: headerOf's state root`);
    assert.equal(checkSignatures(h.j!, keysOf(L.authorities), BigInt(L.setId), crypto, call.imported!.signers).problem, null, `lock ${n}`);
    const st = checkStorage(h.header!.stateRoot, call.p, hexToBytes(TRIE_ID), VAULT, hexToBytes(CODE_HASH));
    assert.equal(st.problem, null, `lock ${n}`);
    const fields = { v3ChainId: V3_ID, vault: VAULT, dstChainId: d.id, minter: d.minter };
    assert.equal(checkCommitment(fields, call.p, st.value!).problem, null, `lock ${n}`);
    // V3's node serves the same header bytes.
    assert.ok(Buffer.from(encodeRpcHeader(L.v3Header as RpcHeader)).equals(Buffer.from(call.imported!.header)), `lock ${n}: the node's header`);
    if (n === "4") {
      // The same proof read as a lock for Sepolia's minter gives another commitment: the minter's CommitmentMismatch.
      assert.match(checkCommitment({ ...fields, dstChainId: SEPOLIA_ID, minter: MINTER }, call.p, st.value!).problem?.text ?? "", /^commitments\[4\] holds 0x9114…/);
      // The first mint there bound the vault: its account proof names the trie id and code hash.
      assert.ok(st.bind && bytesToHex(st.bind.trieId) === TRIE_ID);
    }
  }
});

test("the replay's outcomes: the nonce, a paused or halted client, another error, no revert", () => {
  const r = (data: Hex) => revertOf(data, "execution reverted", registry);
  assert.deepEqual(replayOutcome(r(nonceUsedData(3n)), 3n), { kind: "used" });
  assert.equal(replayOutcome(r(nonceUsedData(3n)), 4n).kind, "other");
  assert.deepEqual(replayOutcome(r(revertData("ClientPaused()")), 3n), { kind: "paused", name: "ClientPaused" });
  assert.deepEqual(replayOutcome(r(revertData("ClientHalted()")), 3n), { kind: "paused", name: "ClientHalted" });
  const mismatch = replayOutcome(r(revertData("CommitmentMismatch(bytes32,bytes32)", "bytes32,bytes32", [`0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`])), 3n);
  assert.equal(mismatch.kind, "other");
  assert.match(mismatch.kind === "other" ? mismatch.text : "", /^CommitmentMismatch\(/);
  assert.deepEqual(replayOutcome(null, 3n), { kind: "none" });
});

test("the burns' ids recompute, each with its chain's id and minter; burn 1's released[burnId] walks to 1 at a V3 head", () => {
  const sep = readJson("deployments/sepolia-bridge.json");
  const ids: [bigint, Hex, Hex, string][] = sep.steps.filter((s: any) => s.kind === "burn" && s.ok).map((s: any) => [SEPOLIA_ID, MINTER, s.burn.burnId, s.burn.burnNonce]);
  for (const [network, id] of [
    ["base-sepolia", 84_532n],
    ["arbitrum-sepolia", 421_614n],
  ] as const) {
    const b = readJson(`deployments/${network}-bridge.json`);
    for (const s of b.steps.filter((x: any) => x.kind === "burn" && x.ok)) ids.push([id, b.contracts.BridgeMinter, s.burn.burnId, s.burn.burnNonce]);
  }
  assert.equal(ids.length, 4);
  for (const [chain, minter, recorded, n] of ids) assert.equal(burnId(chain, minter, BigInt(n)), recorded.toLowerCase());
  // A burn on another chain has another id.
  assert.notEqual(burnId(84_532n, ROLLUP_MINTER, 0n), burnId(421_614n, ROLLUP_MINTER, 0n));
  const R = F.released;
  const header = decodeHeader(encodeRpcHeader(R.head.header));
  const rootNodes = (R.rootProof as Hex[]).map(hexToBytes);
  const rootKey = childRootKey(hexToBytes(R.trieId));
  const childRoot = provenValue(header.stateRoot, rootNodes, rootKey, "child-root");
  const items = childItems((R.childProof as Hex[]).map(hexToBytes), rootNodes);
  const read = readProof(childRoot, items, releasedKey(R.burnId));
  assert.equal(read.itemsUsed, items.length);
  assert.equal(wordValue(read.value), 1n);
  // The proof covers this id's path only: another id is not proven released by it.
  const other = (() => {
    try {
      return wordValue(readProof(childRoot, items, releasedKey(`0x${"ab".repeat(32)}`)).value);
    } catch {
      return null;
    }
  })();
  assert.notEqual(other, 1n);
});

// ---------------------------------------------------------------------------------------------
// The runs, against fake chains

const ep = (url: string, label: string): Endpoint => ({ id: label, label, url, batch: 8 });
const DEST_A = ep("https://dest-a.fake/", "dest-a.fake");
const DEST_B = ep("https://dest-b.fake/", "dest-b.fake");
const V3_HTTP = ep("https://v3.fake/", "v3.fake");
const V3_EVM = ep("https://v3-evm.fake/", "v3-evm.fake");
/** The destination's head in the fakes: a replay is asked at it, the re-run before the mint at its own block. */
const HEAD: Hex = "0xb70000";

const rpcHeaderOf = (h: { parentHash: string; number: number; stateRoot: string; extrinsicsRoot: string; digest: { scale: string }[] }): RpcHeader => ({
  parentHash: h.parentHash,
  number: `0x${h.number.toString(16)}`,
  stateRoot: h.stateRoot,
  extrinsicsRoot: h.extrinsicsRoot,
  digest: { logs: h.digest.map((d) => d.scale) },
});

const authorityList = (keys: Hex[]): Hex => bytesToHex(concatBytes(encodeCompact(keys.length), ...keys.map((k) => concatBytes(hexToBytes(k), u64le(1n)))));
const LIST_HASH = keysHash(KEY_BYTES);

/** Each destination's contracts and its V3 light client's checkpoint: set 19 at #67,958 on Sepolia, set 59 at #211,277 on the rollups. */
const CHAIN = {
  sepolia: { name: "Sepolia", lc: LIGHT_CLIENT, minter: MINTER, id: SEPOLIA_ID, checkpoint: [19n, 67_958] },
  "base-sepolia": { name: "Base Sepolia", lc: ROLLUP_LC, minter: ROLLUP_MINTER, id: 84_532n, checkpoint: [59n, 211_277] },
  "arbitrum-sepolia": { name: "Arbitrum Sepolia", lc: ROLLUP_LC, minter: ROLLUP_MINTER, id: 421_614n, checkpoint: [59n, 211_277] },
} as const;
type ChainName = keyof typeof CHAIN;

interface TxFix {
  hash: Hex;
  from: Hex;
  to: Hex;
  input: Hex;
  blockNumber: Hex;
}

/** A recorded lock as the fakes serve it: its mint and receipt, the import of its block for a mint(p), the client's answers and V3's header of the block. */
interface LockFix {
  n: bigint;
  dest: ChainName;
  block: Hex;
  setId: bigint;
  mint: TxFix;
  receipt: { status: Hex; gasUsed: Hex; blockNumber: Hex; from: Hex; logs: RawLog[] };
  headerOf: Hex;
  authorities: Hex;
  v3Header: RpcHeader;
  import: TxFix | null;
  via: "evm" | "substrate";
}

const fixOf = (n: string): LockFix => {
  const L = F.locks[n];
  return { n: BigInt(n), dest: L.dest, block: L.block, setId: BigInt(L.setId), mint: L.mint, receipt: L.receipt, headerOf: L.headerOf, authorities: L.authorities, v3Header: L.v3Header, import: L.import, via: n === "3" ? "substrate" : "evm" };
};

/** Lock 0 from hero-mint.json and its bundle; locks 1 to 5 from verify-locks.json. */
const LOCKS: Record<string, LockFix> = {
  "0": {
    n: 0n,
    dest: "sepolia",
    block: B0,
    setId: 30n,
    mint: { hash: hero.hash, from: hero.from, to: hero.to, input: hero.input, blockNumber: hero.blockNumber },
    receipt: { ...hero.receipt, from: hero.from },
    headerOf: enc("(uint32,bytes32,uint64)", [[108_424, heroBundle.header.stateRoot, 30n]]),
    authorities: enc("bytes32[]", [KEYS]),
    v3Header: rpcHeaderOf(heroBundle.header),
    import: null,
    via: "evm",
  },
  ...Object.fromEntries(["1", "2", "3", "4", "5"].map((n) => [n, fixOf(n)])),
};

interface Fakes {
  /** The mint's calldata as its transaction serves it: its own, or a tampered copy. */
  input?: Hex;
  /** The mint went through Multicall3: its transaction is this aggregate3, to Multicall3. */
  multicall?: Hex;
  /** eth_getTransactionByHash answers null. */
  noTx?: boolean;
  /** eth_getTransactionReceipt answers null on every RPC. */
  noReceipt?: boolean;
  /** The receipt's status, and its logs as the fake changes them. */
  status?: Hex;
  logs?: (logs: RawLog[]) => RawLog[];
  /** used(n), eth_blockNumber and the mint's replay fail with a node error that is not a revert (a rate limit), on every RPC. */
  flaky?: boolean;
  /** What used(n) answers. */
  used?: boolean;
  /** authorities() fails on every RPC. */
  noKeys?: boolean;
  /** The second RPC answers other keys. */
  otherKeys?: boolean;
  /** The second RPC answers this headerOf. */
  otherHeld?: Hex;
  /** headerOf of other blocks: a self-relay's set changes. */
  held?: Record<string, Hex>;
  /** headerOf of this block reverts UnknownBlock on every RPC: the client does not hold it. */
  unknownBlock?: Hex;
  /** BridgeMinter.lightClient(), the client's genesisHash(), admin() and its set's list hash, when the fake says otherwise. */
  lightClient?: Hex;
  genesis?: Hex;
  admin?: Hex;
  listHash?: Hex;
  /** The keys V3's runtime names at the block. */
  runtimeKeys?: Hex[];
  /** The vault's Locked logs, as V3's EVM RPC serves them. */
  locked?: RawLog[];
  /** What a replay of the mint answers: its revert data, or "0x" for none. */
  replay?: Hex;
  /** The planner's answer, for a run from V3 now. */
  plan?: MintPlan;
  /** The V3 node's child read proof of the lock's slot, as the fake changes it; "down": the node does not answer it; "pruned": it no longer has the block's state. */
  nodeChild?: ((proof: Hex[]) => Hex[] | null) | "down" | "pruned";
  /** The V3 node's header of the lock's block, when the fake serves another. */
  v3Header?: RpcHeader;
}

/** The key that deployed the contracts, and the light clients' admin. */
const DEPLOYER: Hex = "0xd9838a86cf83c28ee486544060d1ca4ca2971071";

/** A destination's RPC for lock `L`: its transactions, its receipt and its contracts. `second`: the second of the two RPCs. */
function destNode(L: LockFix, f: Fakes, second: boolean) {
  const c = CHAIN[L.dest];
  const input = f.input ?? L.mint.input;
  return (method: string, params: unknown[]): unknown => {
    const tx = params[0] as { to: string; data: Hex };
    switch (method) {
      case "eth_getTransactionByHash": {
        const h = String(params[0]).toLowerCase();
        if (h === L.mint.hash.toLowerCase()) return f.noTx ? null : f.multicall ? { ...L.mint, to: MULTICALL3.toLowerCase(), input: f.multicall } : { ...L.mint, input };
        return L.import && h === L.import.hash.toLowerCase() ? L.import : null;
      }
      case "eth_getTransactionReceipt":
        return f.noReceipt ? null : { ...L.receipt, status: f.status ?? L.receipt.status, logs: f.logs ? f.logs(L.receipt.logs) : L.receipt.logs };
      case "eth_blockNumber":
        if (f.flaky) throw new RpcFail(-32005, "rate limited");
        return HEAD;
      case "eth_getLogs":
        return [];
      case "eth_call": {
        const at = params[1];
        const to = tx.to.toLowerCase();
        const is = (sig: string) => tx.data.slice(0, 10) === selector(sig);
        if (to === MULTICALL3.toLowerCase()) {
          // Before the mint the aggregate passes; now Multicall3 answers its failed call with its own error.
          if (at !== HEAD) return "0x";
          throw new RpcFail(3, "execution reverted: Multicall3: call failed", MULTICALL_FAILED);
        }
        if (to === c.minter) {
          if (is("lightClient()")) return enc("address", [f.lightClient ?? c.lc]);
          if (is("vaultTrieId()")) return enc("bytes32", [TRIE_ID]);
          if (is("vaultCodeHash()")) return enc("bytes32", [CODE_HASH]);
          if (f.flaky) throw new RpcFail(-32005, "rate limited");
          if (is("used(uint256)")) return enc("bool", [f.used ?? true]);
          // The mint itself: at the block before it was mined it passes; now it stops at the nonce, unless a test says otherwise.
          if (at !== HEAD) return "0x";
          const r = f.replay ?? nonceUsedData(L.n);
          if (r === "0x") return "0x";
          throw new RpcFail(3, "execution reverted", r);
        }
        if (to === c.lc) {
          if (is("genesisHash()")) return enc("bytes32", [f.genesis ?? GENESIS]);
          if (is("admin()")) return enc("address", [f.admin ?? DEPLOYER]);
          if (is("headerOf(bytes32)")) {
            const b = (decode("bytes32", `0x${tx.data.slice(10)}`)[0] as string).toLowerCase();
            if (b === f.unknownBlock) throw new RpcFail(3, "execution reverted", revertData("UnknownBlock(bytes32)", "bytes32", [b]));
            return f.held?.[b] ?? (second && f.otherHeld ? f.otherHeld : L.headerOf);
          }
          if (is("authorities(uint64)")) {
            if (f.noKeys) throw new RpcFail(-32000, "the fake has no keys to give");
            return second && f.otherKeys ? enc("bytes32[]", [[KEYS[1], KEYS[0]]]) : L.authorities;
          }
          if (is("currentSetId()")) return enc("uint64", [64n]);
          if (is("latestFinalized()")) return enc("bytes32,uint32", [`0x${"cd".repeat(32)}`, 231_000]);
          if (is("authoritySetCount()")) return enc("uint256", [46n]);
          if (is("authoritySetAt(uint256)")) {
            const i = decode("uint256", `0x${tx.data.slice(10)}`)[0] as bigint;
            return enc("(bytes32,bytes32,uint64,uint32),bytes32[]", [[GENESIS, i > 0n && f.listHash ? f.listHash : LIST_HASH, c.checkpoint[0] + i, i === 0n ? c.checkpoint[1] : 107_359], KEYS]);
          }
          // The import that brought the block in, sent again as a read: it returns the block.
          if (is(SIG.importFinalityProof) || is(SIG.importHeader)) return enc("bytes32", [L.block]);
        }
        throw new RpcFail(-32601, `the fake has no call ${tx.data.slice(0, 10)} on ${to}`);
      }
      default:
        throw new RpcFail(-32601, `the fake destination has no ${method}`);
    }
  };
}

/**
 * The V3 node for lock `L`: its block's header, the runtime's keys and set there, and the lock's two
 * proofs as the node serves them; lock 0's block is also the finalized head, with the bundle's clean
 * finality proof, for the runs from V3 now.
 */
function v3Node(L: LockFix, f: Fakes = {}) {
  const c = CHAIN[L.dest];
  const p = decodeMintCall(L.mint.input, c.minter, c.lc).p;
  const root = p.childRootProof.map(bytesToHex);
  const slot = p.slotProof.map(bytesToHex);
  return (method: string, params: unknown[]): unknown => {
    switch (method) {
      case "chain_getBlockHash":
        return params[0] === 0 ? GENESIS : null;
      case "chain_getFinalizedHead":
        return B0;
      case "grandpa_proveFinality":
        return params[0] === 108_424 ? heroBundle.finalityProof.scale : null;
      case "chain_getHeader":
        return params[0] === L.block ? (f.v3Header ?? L.v3Header) : params[0] === B0 ? LOCKS["0"]!.v3Header : null;
      case "state_call":
        return authorityList(f.runtimeKeys ?? (decode("bytes32[]", L.authorities)[0] as Hex[]));
      case "state_getStorage":
        return bytesToHex(u64le(L.setId));
      case "state_getReadProof":
        return { at: L.block, proof: root };
      case "state_getChildReadProof": {
        // As the node serves it: the main-trie items that lead to the child root, then the child trie's.
        if (f.nodeChild === "down") throw new RpcFail(-32000, "node down");
        if (f.nodeChild === "pruned") throw new RpcFail(4003, "State already discarded for block");
        const proof = [...root, ...slot];
        return { at: L.block, proof: f.nodeChild ? f.nodeChild(proof) : proof };
      }
      default:
        throw new RpcFail(-32601, `the fake V3 node has no ${method}`);
    }
  };
}

/** The checks' environment over the fake endpoints `rpcs` of destination `dest`, the V3 node over HTTP only. Arbitrum Sepolia keeps no historical state. */
function baseEnv(rpcs: Endpoint[], dest: ChainName = "sepolia"): VerifyEnv {
  const c = CHAIN[dest];
  const d: DestEnv = {
    key: dest,
    name: c.name,
    chainId: c.id,
    rpcs,
    history: rpcs,
    archive: dest === "arbitrum-sepolia" ? [] : rpcs.slice(1),
    logs: rpcs.slice(0, 1),
    lightClient: c.lc,
    minter: c.minter,
    clientFrom: 11_934_000,
    deployer: DEPLOYER,
    explorer: { name: "Etherscan", tx: (h) => `tx/${h}`, address: (a) => `address/${a}`, block: (n) => `block/${n}` },
  };
  return {
    dest: d,
    v3: new HttpOnly(V3_HTTP, { id: "no-ws", label: "no WebSocket", url: "wss://v3.fake/" }),
    v3Evm: [V3_EVM],
    vault: VAULT,
    vaultFrom: 100_000,
    v3ChainId: V3_ID,
    genesis: GENESIS,
    registry,
    recordedVault: { trieId: TRIE_ID, codeHash: CODE_HASH, from: "fixtures/v3-testnet-hero/mint-bundle.json" },
    v3Block: (n) => `v3/${n}`,
    crypto: async () => crypto,
    importOf: () => null,
    plan: null,
  };
}

/** Lock `L`'s chains, faked, and the environment that reads them: the import of a mint(p)'s block as the relayer's records hold it. */
function lockEnv(L: LockFix, f: Fakes): VerifyEnv {
  fakeFetch({ [DEST_A.url]: destNode(L, f, false), [DEST_B.url]: destNode(L, f, true), [V3_HTTP.url]: v3Node(L, f), [V3_EVM.url]: (m) => (m === "eth_getLogs" ? (f.locked ?? []) : []) });
  const imp = L.import;
  const plan = f.plan;
  return {
    ...baseEnv([DEST_A, DEST_B], L.dest),
    importOf: (hash) => (imp && hash.toLowerCase() === L.block ? { tx: imp.hash, block: Number(BigInt(imp.blockNumber)), from: "deployments/relay-sepolia-0xe94a….jsonl" } : null),
    plan: plan ? async () => plan : null,
  };
}

/** What the page knows of lock `L` before its run: the mint's transaction, and the records' account of it. */
const lockedOf = (L: LockFix): MintedLock => ({
  nonce: L.n,
  mintTx: L.mint.hash,
  recorded: { block: Number(BigInt(L.mint.blockNumber)), gasUsed: Number(BigInt(L.receipt.gasUsed)), sender: L.mint.from, from: L.n < 2n ? "deployments/sepolia-bridge.json" : `deployments/automint-${L.dest}-0x57cc….jsonl` },
  lock: { tx: `0x${"25".repeat(32)}`, block: 101_009, via: L.via },
  autoMint: null,
});

/** Lock 0's fields as its Locked log gives them: the input of a run from V3 now. */
const FIELDS0 = { recipient: heroBundle.lock.recipient as Hex, amount: BigInt(heroBundle.lock.amountNative), block: 101_009, commitment: heroBundle.lock.commitment as Hex };

async function runLock(n: string, f: Fakes = {}, more: Partial<MintedLock> = {}): Promise<Run> {
  const L = LOCKS[n]!;
  const env = lockEnv(L, f);
  try {
    let last: Run | null = null;
    const run = await verifyMinted(env, { ...lockedOf(L), ...more }, { emit: (r) => (last = r), stopped: () => false });
    assert.ok(last, "the run reported itself");
    return run;
  } finally {
    restoreFetch();
  }
}

const runHero = (f: Fakes) => runLock("0", f);

const states = (r: Run) => r.steps.map((s) => s.state);
const step = (r: Run, key: string) => r.steps.find((s) => s.key === key)!;
const linesOf = (r: Run): string => r.steps.flatMap((s) => s.lines.map((l) => `${l.ok} ${l.text}`)).join("\n");

/** `input` with the bytes `find` (hex, no 0x) changed by `edit`, which must occur once. */
function tamper(input: Hex, find: string, edit: (hex: string) => string): Hex {
  const at = input.indexOf(find, 10);
  assert.ok(at > 0, "the bytes to tamper are in the calldata");
  assert.equal(input.indexOf(find, at + 1), -1, "they occur once");
  return `${input.slice(0, at)}${edit(find)}${input.slice(at + find.length)}` as Hex;
}
const flipByte = (hex: string, i: number): string => `${hex.slice(0, 2 * i)}${(parseInt(hex.slice(2 * i, 2 * i + 2), 16) ^ 0x01).toString(16).padStart(2, "0")}${hex.slice(2 * i + 2)}`;

/** A plan as the planner gives one, for the runs from V3 now: its status, why, one transaction, and the dry run's revert. */
function planOf(status: MintPlan["status"], why: string, revert: MintPlan["revert"] = null): MintPlan {
  const lock = { nonce: 0n, block: 101_009, amount: FIELDS0.amount, recipient: FIELDS0.recipient, commitment: FIELDS0.commitment };
  const tx = { to: MINTER, data: "0x12345678" as Hex, gas: 601_970n, gasLimit: 662_167n, gasFrom: "estimate" as const, l1: NO_L1, title: "mint(p) at V3 #231,000", detail: "", calls: [] };
  return { lock, status, path: "mint", why, txs: [tx], target: null, checks: [], revert, read: { sepoliaBlock: "latest", client: null, minter: null, v3: null, pending: [] }, builtAt: 0 };
}

test("lock 0's run: six checks passed in order, two RPCs agree, the V3 node's header and proof agree, NonceAlreadyUsed(0) just now; Verified", async () => {
  const run = await runHero({});
  assert.deepEqual(states(run), ["passed", "passed", "passed", "passed", "passed", "passed"]);
  assert.equal(run.done, true);
  assert.equal(run.disagree, false);
  const v = verdictOf(run, "Sepolia");
  assert.equal(v.kind, "verified");
  assert.equal(v.chip, "Verified");
  assert.match(v.sub, /^6 of 6 checks · .* · \d+ reads$/);
  assert.equal(step(run, "keys").sub, "Set 30 · 2 keys · 2 needed");
  assert.equal(step(run, "sigs").sub, "Round 4,797 · set 30 · 2 of 2 valid · 2 needed");
  const lines = linesOf(run);
  for (const want of [
    "true The light client on Sepolia stores the same state root for #108,424",
    "true The V3 node serves the same",
    "true 2 RPCs agree",
    "true The same keys as V3's runtime at #108,424",
    "true This first mint bound the minter: its account proof names the trie id the minter stored (0xbe30…7c3a)",
    "true The V3 node's own proof at #108,424 gives the same word",
    "true VaultBound: this first mint bound the minter to the vault",
    "true Sent again just now as a read: NonceAlreadyUsed(0)",
    "true Run again at Sepolia #11,950,901",
    "null Locked log: not served",
  ])
    assert.ok(lines.includes(want), want);
  assert.ok(!lines.includes("false "), "no cross-check disagrees");
  assert.deepEqual(run.facts.block, { number: 108_424, hash: B0 });
  assert.equal(run.facts.setId, 30n);
  assert.equal(run.facts.checkpoint?.setId, 19n);
  assert.equal(run.facts.checkpoint?.changes, 45);
  assert.equal(run.facts.checkpoint?.same, true);
  assert.ok(run.reads >= 13);
  assert.ok(run.steps.every((s) => s.raw.length > 0), "every step carries its raw data");
});

test("lock 1's run: the account proof it carries is not the bind (lock 0's mint bound the minter), and nothing is red; Verified", async () => {
  const run = await runLock("1");
  assert.deepEqual(states(run), ["passed", "passed", "passed", "passed", "passed", "passed"]);
  assert.equal(verdictOf(run, "Sepolia").kind, "verified");
  const lines = linesOf(run);
  assert.ok(!lines.includes("false "), "no cross-check disagrees");
  assert.ok(lines.includes("true The mint also carried the vault's account proof. The minter reads it only on its first mint, so it skipped it here. Walked in this browser, it gives the same trie id and code hash."));
  assert.ok(!lines.includes("VaultBound"), "no VaultBound: lock 0's mint bound the minter");
  assert.equal(step(run, "keys").sub, "Set 33 · 2 keys · 2 needed");
  assert.equal(step(run, "accepted").sub, "Minted once · sent again just now: NonceAlreadyUsed(1)");
  const items = step(run, "proof").ev.find((e) => e.k === "Items")?.v[0];
  assert.deepEqual(items, { t: "mono", text: "6 + 2" });
});

test("lock 3's run: mint(p) at a block the client held, through the importFinalityProof that brought #222,687 in; its Locked log is a Substrate extrinsic's", async () => {
  const run = await runLock("3");
  assert.deepEqual(states(run), ["passed", "passed", "passed", "passed", "passed", "passed"]);
  assert.equal(verdictOf(run, "Sepolia").kind, "verified");
  assert.match(step(run, "header").sub, /#222,687/);
  assert.ok(step(run, "header").raw[0]?.call.includes("importFinalityProof that brought it in, tx 0x9126…4962 (Recorded · deployments/relay-sepolia-"));
  assert.equal(step(run, "sigs").sub, "Round 2,957 · set 62 · 2 of 2 valid · 2 needed");
  const lines = linesOf(run);
  assert.ok(lines.includes("null Locked log: not served, a Substrate extrinsic's event"));
  assert.ok(lines.includes("true The import that brought it in, sent again just now as a read, returns 0xbd6b…ccdc"));
  assert.ok(!lines.includes("HeaderImported"), "mint(p) imports nothing");
  // Without the records' relay entry the import is searched in the client's logs: none here, so the header is not checked.
  const L = LOCKS["3"]!;
  const env = { ...lockEnv(L, {}), importOf: () => null };
  try {
    const r = await verifyMinted(env, lockedOf(L), { emit: () => undefined, stopped: () => false });
    assert.equal(step(r, "header").state, "skipped");
    assert.equal(step(r, "header").sub, "Not checked: the import that brought 0xbd6b…ccdc into the client was found neither in the records nor in its logs");
    assert.equal(verdictOf(r, "Sepolia").chip, "Not all checked");
  } finally {
    restoreFetch();
  }
});

test("locks 4 and 5's runs on the rollups: Base Sepolia's commitment names chain 84532 and its minter; Arbitrum Sepolia keeps no history, so the re-run line is omitted", async () => {
  const four = await runLock("4");
  assert.deepEqual(states(four), ["passed", "passed", "passed", "passed", "passed", "passed"]);
  assert.equal(step(four, "commit").sub, "0.001 tPOT · to 0xD983…1071 · on Base Sepolia · nonce 4");
  assert.equal(step(four, "accepted").title, "Accepted on Base Sepolia");
  assert.ok(linesOf(four).includes("true VaultBound: this first mint bound the minter to the vault"));
  assert.ok(linesOf(four).includes("true Run again at Base Sepolia #"));
  const five = await runLock("5");
  assert.deepEqual(states(five), ["passed", "passed", "passed", "passed", "passed", "passed"]);
  assert.equal(step(five, "commit").sub, "0.001 tPOT · to 0xD983…1071 · on Arbitrum Sepolia · nonce 5");
  assert.ok(!linesOf(five).includes("Run again at"), "no historical state on Arbitrum Sepolia: the line is omitted, not failed");
  assert.equal(verdictOf(five, "Arbitrum Sepolia").kind, "verified");
});

test("the Lab's tampers, made offline on lock 0's calldata, each fail exactly its step with its reason, the steps after it not reached", async () => {
  const call = decodeMintCall(hero.input, MINTER, LIGHT_CLIENT);
  const j = checkHeader(call.imported!, call.p.blockHash).j!;
  const sig1 = bytesToHex(j.precommits[1]!.signature).slice(2);
  const stateRoot = heroBundle.header.stateRoot.slice(2);
  const slot0 = bytesToHex(call.p.slotProof[0]!).slice(2);
  const word = (v: bigint) => v.toString(16).padStart(64, "0");
  const amount = word(call.p.amount);
  const recipient = word(BigInt(call.p.recipient));
  const cases: [string, Hex, number, RegExp][] = [
    ["R[0] of precommit 1", tamper(hero.input, sig1, (h) => flipByte(h, 0)), 2, /^precommit 1: invalid signature$/],
    ["s[0] of precommit 1", tamper(hero.input, sig1, (h) => flipByte(h, 32)), 2, /^precommit 1: invalid signature$/],
    ["a state-root byte in the header", tamper(hero.input, stateRoot, (h) => flipByte(h, 5)), 0, /^the header hashes to 0x\w{4}…\w{4}, the signatures finalize 0xc89b…4e6d$/],
    ["byte 33 of the first slot-proof item", tamper(hero.input, slot0, (h) => flipByte(h, 33)), 3, /is not in the proof$/],
    ["amount × 1,000", tamper(hero.input, amount, () => word(call.p.amount * 1000n)), 4, /^commitments\[0\] holds 0x9eba…\w{4}; this lock's fields give 0x\w{4}…\w{4}$/],
    ["another recipient", tamper(hero.input, recipient, () => word(0x1234n)), 4, /^commitments\[0\] holds 0x9eba…/],
  ];
  for (const [what, input, at, reason] of cases) {
    const run = await runHero({ input });
    const want = run.steps.map((_, i) => (i < at ? "passed" : i === at ? "failed" : "unreached"));
    assert.deepEqual(states(run), want, what);
    assert.match(run.steps[at]!.sub, reason, what);
    const v = verdictOf(run, "Sepolia");
    assert.equal(v.kind, "failed", what);
    assert.equal(v.title, `Did not check out at step ${at + 1} · ${run.steps[at]!.title}`, what);
    assert.ok(run.steps.slice(at + 1).every((s) => s.sub === "Not reached"), what);
  }
});

test("inputs not served are not checked, never passed, the node and the call named: the verdict is Not all checked", async () => {
  const noTx = await runHero({ noTx: true });
  assert.ok(noTx.steps.every((s) => s.state === "skipped"));
  assert.match(step(noTx, "header").sub, /^Not checked: no Sepolia RPC served the mint's transaction 0x9171…5cba$/);
  assert.equal(step(noTx, "header").retry, true);
  assert.equal(verdictOf(noTx, "Sepolia").chip, "Not all checked");

  const noKeys = await runHero({ noKeys: true });
  assert.deepEqual(states(noKeys), ["passed", "skipped", "skipped", "passed", "passed", "passed"]);
  assert.equal(step(noKeys, "keys").sub, "Not checked: no Sepolia RPC answered authorities(30)");
  assert.equal(step(noKeys, "sigs").sub, "Not checked: needs the keys");
  const v = verdictOf(noKeys, "Sepolia");
  assert.equal(v.kind, "partial");
  assert.match(v.sub, /^4 of 6 checks · 2 not checked/);
});

test("no RPC serves the receipt: the records' is shown, labelled, and step 6 still passes on used(n) and the replay", async () => {
  const run = await runHero({ noReceipt: true });
  assert.deepEqual(states(run), ["passed", "passed", "passed", "passed", "passed", "passed"]);
  const status = step(run, "accepted").ev.find((e) => e.k === "Status")!;
  assert.deepEqual(status.v[1], { t: "src", kind: "recorded", text: "Recorded · status 1 at #11,950,902 · deployments/sepolia-bridge.json" });
  const lines = linesOf(run);
  // Without the receipt the page cannot tell which mint bound the minter: the account proof is read as carried.
  assert.ok(lines.includes("true The account proof it carries names the trie id the minter stored (0xbe30…7c3a)"));
  assert.ok(lines.includes("null The receipt: not served by Sepolia's RPCs; the records' is shown"));
});

test("two RPCs that answer different keys fail step 2", async () => {
  const run = await runHero({ otherKeys: true });
  assert.deepEqual(states(run).slice(0, 3), ["passed", "failed", "unreached"]);
  assert.equal(step(run, "keys").sub, "the RPCs answer different keys");
});

test("the replay: ClientPaused is not checked and the receipt stands; no revert or another error fails step 6", async () => {
  const paused = await runHero({ replay: revertData("ClientPaused()") });
  assert.equal(step(paused, "accepted").state, "skipped");
  assert.equal(step(paused, "accepted").sub, "Not checked: the light client is paused; the receipt stands");
  const again = await runHero({ replay: "0x" });
  assert.equal(step(again, "accepted").state, "failed");
  assert.match(step(again, "accepted").sub, /^the minter would mint it again/);
  const other = await runHero({ replay: revertData("CommitmentMismatch(bytes32,bytes32)", "bytes32,bytes32", [`0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`]) });
  assert.equal(step(other, "accepted").state, "failed");
  assert.match(step(other, "accepted").sub, /^the replay stopped before the nonce: CommitmentMismatch\(/);
});

test("route B: a lock not minted yet is checked on a proof from V3's finalized head, and step 6 is the planner's dry run; Not minted yet", async () => {
  const env = lockEnv(LOCKS["0"]!, { plan: planOf("ready", "mint(p) at a block the client holds.") });
  try {
    const why = "Not minted yet: used(0) is false on Sepolia. The proof is read from V3 now.";
    const run = await verifyUnminted(env, { nonce: 0n, fields: FIELDS0, lock: { tx: `0x${"25".repeat(32)}`, block: 101_009, via: "evm" }, why }, { emit: () => undefined, stopped: () => false });
    assert.equal(run.route, "unminted");
    assert.deepEqual(states(run), ["passed", "passed", "passed", "passed", "passed", "passed"]);
    assert.equal(step(run, "accepted").title, "Would Sepolia accept it?");
    assert.match(step(run, "accepted").sub, /^Yes: the dry run on Sepolia passed\./);
    assert.equal(step(run, "sigs").sub, "Round 4,797 · set 30 · 2 of 2 valid · 2 needed");
    assert.ok(step(run, "header").lines.some((l) => l.ok === null && l.text === why));
    const v = verdictOf(run, "Sepolia");
    assert.deepEqual([v.kind, v.chip, v.title], ["unminted", "Not minted yet", "Not minted yet · Sepolia would accept it"]);
  } finally {
    restoreFetch();
  }
});

test("the fallback: no RPC serves a minted lock's mint transaction, so the checks run on a proof from V3 now and its dry run stops at the nonce; Not all checked, never Verified", async () => {
  const minted = planOf("minted", "Lock 0 is minted already: the dry run reverted NonceAlreadyUsed(0).", { tx: 0, call: null, text: "NonceAlreadyUsed(0)", name: "NonceAlreadyUsed", data: nonceUsedData(0n) });
  const run = await runLock("0", { noTx: true, plan: minted }, { fields: FIELDS0 });
  assert.equal(run.route, "fallback");
  assert.deepEqual(states(run), ["passed", "passed", "passed", "passed", "passed", "passed"]);
  assert.equal(step(run, "accepted").title, "Accepted on Sepolia");
  assert.equal(step(run, "accepted").sub, "Minted once: a proof read from V3 now passes every check on Sepolia and stops at NonceAlreadyUsed(0), as a read just now");
  assert.ok(step(run, "header").lines.some((l) => l.ok === null && l.text.startsWith("No Sepolia RPC served the mint's transaction 0x9171…5cba")));
  const v = verdictOf(run, "Sepolia");
  assert.deepEqual([v.kind, v.chip], ["partial", "Not all checked"]);
  // A dry run that passes means the minter would mint it again.
  const again = await runLock("0", { noTx: true, plan: planOf("ready", "") }, { fields: FIELDS0 });
  assert.equal(step(again, "accepted").state, "failed");
  assert.equal(step(again, "accepted").sub, "the dry run passed: the minter would mint lock 0 again");
});

// ---------------------------------------------------------------------------------------------
// The way back

const R = F.released;
const BURN1 = readJson("deployments/sepolia-bridge.json").steps.find((s: any) => s.kind === "burn" && s.burn.burnNonce === "1");
const word32 = (v: bigint | string): Hex => `0x${BigInt(v).toString(16).padStart(64, "0")}`;

/** What the fakes of a burn's chains answer, when a test says otherwise. */
interface BurnFakes {
  /** The burn's nonce: its log and burnIdOf name its id, recomputed. */
  n?: bigint;
  noReceipt?: boolean;
  status?: Hex;
  /** The receipt has no BurnRequested log. */
  noLog?: boolean;
  /** burnIdOf(n)'s answer, or none. */
  idOf?: Hex;
  noIdOf?: boolean;
  /** The V3 node does not answer. */
  v3Down?: boolean;
  /** The head's finality proof, and released[burnId]'s child proof, as the node gives them. */
  proof?: Hex;
  childProof?: Hex[];
  /** The head's header as the node serves it, when it serves another. */
  headHeader?: RpcHeader;
  /** released(burnId) on V3's EVM RPC. */
  released?: boolean;
}

/** A Sepolia burn as its chains answer it: the receipt's BurnRequested, the minter's burnIdOf, the client at V3's set, and released[burnId] at the captured V3 head. */
function burnEnv(o: BurnFakes = {}): VerifyEnv {
  const n = o.n ?? 1n;
  const id: Hex = n === 1n ? BURN1.burn.burnId : burnId(SEPOLIA_ID, MINTER, n);
  const log: RawLog = {
    address: MINTER,
    topics: [eventTopic("BurnRequested(uint256,address,address,uint256,bytes32)"), word32(n), word32(BURN1.sender), word32(BURN1.burn.v3Recipient)],
    data: enc("uint256,bytes32", [BigInt(BURN1.burn.amount), id]),
  };
  const dest = (method: string, params: unknown[]): unknown => {
    const tx = params[0] as { to: string; data: Hex };
    if (method === "eth_getTransactionReceipt") return o.noReceipt ? null : { status: o.status ?? "0x1", gasUsed: "0xeffa", blockNumber: `0x${BURN1.block.toString(16)}`, logs: o.noLog ? [] : [log] };
    if (method === "eth_getBlockByNumber") return { number: "0xb78a0c" };
    if (method !== "eth_call") throw new RpcFail(-32601, `no ${method}`);
    const is = (sig: string) => tx.data.slice(0, 10) === selector(sig);
    if (is("burnIdOf(uint256)")) {
      if (o.noIdOf) throw new RpcFail(-32005, "rate limited");
      return enc("bytes32", [o.idOf ?? id]);
    }
    if (is("vaultTrieId()")) return enc("bytes32", [TRIE_ID]);
    if (is("admin()")) return enc("address", [DEPLOYER]);
    if (is("currentSetId()")) return enc("uint64", [BigInt(R.head.setId)]);
    if (is("latestFinalized()")) return enc("bytes32,uint32", [`0x${"cd".repeat(32)}`, R.head.number - 100]);
    if (is("authoritySetCount()")) return enc("uint256", [BigInt(R.head.setId - 18)]);
    if (is("authorities(uint64)")) return R.head.keys;
    if (is("authoritySetAt(uint256)")) {
      const i = decode("uint256", `0x${tx.data.slice(10)}`)[0] as bigint;
      return enc("(bytes32,bytes32,uint64,uint32),bytes32[]", [[GENESIS, LIST_HASH, 19n + i, i === 0n ? 67_958 : 257_000], KEYS]);
    }
    throw new RpcFail(-32601, `no call ${tx.data.slice(0, 10)}`);
  };
  const node = (method: string, params: unknown[]): unknown => {
    if (o.v3Down) throw new RpcFail(-32000, "node down");
    switch (method) {
      case "chain_getFinalizedHead":
        return R.head.hash;
      case "chain_getHeader":
        return params[0] === R.head.hash ? (o.headHeader ?? R.head.header) : null;
      case "state_getStorage":
        return bytesToHex(u64le(BigInt(R.head.setId)));
      case "grandpa_proveFinality":
        return params[0] === R.head.number ? (o.proof ?? R.head.proof) : null;
      case "state_getReadProof":
        return { at: R.head.hash, proof: R.rootProof };
      case "state_getChildReadProof":
        return { at: R.head.hash, proof: o.childProof ?? R.childProof };
      case "chain_getBlockHash":
        return null;
      default:
        throw new RpcFail(-32601, `the fake V3 node has no ${method}`);
    }
  };
  fakeFetch({ [DEST_A.url]: dest, [DEST_B.url]: dest, [V3_HTTP.url]: node, [V3_EVM.url]: () => enc("bool", [o.released ?? true]) });
  return baseEnv([DEST_A, DEST_B]);
}

const BURN_TARGET: BurnTarget = {
  n: 1n,
  tx: BURN1.txHash,
  recorded: { block: BURN1.block, amount: BigInt(BURN1.burn.amount), payee: BURN1.burn.v3Recipient, burnId: BURN1.burn.burnId, from: "deployments/sepolia-bridge.json" },
  release: {
    payee: BURN1.burn.v3Recipient,
    amount: BigInt(BURN1.burn.amount),
    by: "fast",
    approvals: [
      { member: 1, action: "open", extrinsic: `0x${"aa".repeat(32)}`, block: 173_060 },
      { member: 2, action: "execute", extrinsic: `0x${"bb".repeat(32)}`, block: 173_062 },
    ],
    run: { extrinsic: `0x${"bb".repeat(32)}`, block: 173_062 },
    from: "deployments/v3-testnet.json",
  },
  committee: { members: ["5Member1", "5Member2", "5Member3"], threshold: 2, multisig: "5Multisig" },
};

async function runBurn(o: BurnFakes = {}, target: BurnTarget = BURN_TARGET): Promise<Run> {
  const env = burnEnv(o);
  try {
    return await verifyBurn(env, target, { emit: () => undefined, stopped: () => false });
  } finally {
    restoreFetch();
  }
}

test("burn 1's run: the burn, its id, released[burnId] = 1 proven at V3's head under 2 of 2 signatures checked here, and the release itself Trusted, never Passed", async () => {
  const run = await runBurn();
  assert.equal(run.dir, "back");
  assert.deepEqual(states(run), ["passed", "passed", "passed", "trusted"]);
  assert.equal(step(run, "burn").sub, "0.1 wtPOT burned for 0xD983…1071 on V3, at Sepolia #11,983,026");
  assert.equal(step(run, "burnId").sub, "recomputed = the log's = burnIdOf(1)");
  assert.equal(step(run, "released").sub, `released[0x1573…9c0e] = 1 at V3 #${R.head.number.toLocaleString("en-US")} · 2 of 2 · set ${R.head.setId}`);
  assert.equal(step(run, "release").trust?.kind, "trust");
  const v = verdictOf(run, "Sepolia");
  assert.deepEqual([v.kind, v.chip, v.title], ["trusted", "Trusted · 2-of-3", "Burned on Sepolia, released on V3"]);
  assert.equal(v.sub, "3 checks passed · 1 trusted: the committee's release");
  const lines = linesOf(run);
  assert.ok(lines.includes("true released() = true, from V3's EVM RPC"));
  assert.ok(lines.includes("null The release's block #173,062: not answered"));
  assert.equal(run.facts.burnId, BURN1.burn.burnId);
  assert.equal(run.facts.setId, BigInt(R.head.setId));
  assert.equal(run.facts.checkpoint?.same, true);
});

test("burn 1's run: a flipped byte in the released proof fails B3 with the walk's reason, and B4 still reads Trusted", async () => {
  const items = [...(R.childProof as Hex[])];
  // A child-trie item (the node serves the main-trie items that lead to the child root too).
  const i = items.findIndex((x) => !(R.rootProof as Hex[]).includes(x) && x.length > 200);
  assert.ok(i >= 0);
  items[i] = `0x${flipByte(items[i]!.slice(2), 40)}` as Hex;
  const run = await runBurn({ childProof: items });
  assert.deepEqual(states(run), ["passed", "passed", "failed", "trusted"]);
  assert.match(step(run, "released").sub, /^(root )?node 0x\w+…\w+ is not in the proof$/);
  assert.equal(step(run, "release").sub, "Trusted, not checked: the committee's release");
  assert.equal(verdictOf(run, "Sepolia").kind, "failed");
});

// ---------------------------------------------------------------------------------------------
// The key history

const SETS = readJson("site/test/fixtures/v3-set-changes.json");

/** What the key history's fakes answer, when a test says otherwise: a tampered justification, no proof at a change, keys that are not a set's, the admin's logs. */
interface HistoryFakes {
  tamperAt?: number;
  noProofAt?: number;
  /** authoritySetAt(i) lists other keys than its list hash's. */
  badKeysAt?: number;
  logs?: RawLog[];
}

async function history(o: HistoryFakes = {}): Promise<History> {
  const v3 = new FakeV3();
  const changes = SETS.changes as { number: number; hash: Hex; header: RpcHeader; proveFinality: Hex }[];
  for (const c of changes) v3.add({ number: c.number, hash: c.hash, header: c.header, setId: 0n, proof: c.proveFinality });
  v3.prove = (n) => {
    const c = changes.find((x) => x.number === n);
    if (!c || o.noProofAt === n) return null;
    // A flipped byte in the last signature of the change's stored justification.
    return o.tamperAt === n ? (`0x${flipByte(c.proveFinality.slice(2), c.proveFinality.length / 2 - 1 - 40)}` as Hex) : c.proveFinality;
  };
  const checkpoint: Hex = `0x${"cd".repeat(32)}`;
  const node = (method: string, params: unknown[]): unknown => {
    if (method === "chain_getBlockHash" && params[0] === 114_535) return checkpoint;
    if (method === "state_call") return authorityList(KEYS);
    return v3.handle(method, params);
  };
  const sets: [bigint, number][] = [
    [32n, 114_535],
    [33n, 118_123],
    [34n, 121_706],
    [35n, 125_299],
  ];
  const dest = (method: string, params: unknown[]): unknown => {
    const tx = params[0] as { to: string; data: Hex };
    if (method === "eth_blockNumber") return "0xb70000";
    if (method === "eth_getLogs") {
      // As a node filters them: by the first topic, one or any of several.
      const first = (params[0] as { topics: (string | string[])[] }).topics[0];
      return (o.logs ?? []).filter((l) => (Array.isArray(first) ? first.includes(l.topics[0]!) : l.topics[0] === first));
    }
    if (method !== "eth_call") throw new RpcFail(-32601, `no ${method}`);
    const sel = tx.data.slice(0, 10);
    if (sel === selector("authoritySetCount()")) return enc("uint256", [BigInt(sets.length)]);
    if (sel === selector("authoritySetAt(uint256)")) {
      const i = Number(decode("uint256", `0x${tx.data.slice(10)}`)[0] as bigint);
      const [id, at] = sets[i]!;
      return enc("(bytes32,bytes32,uint64,uint32),bytes32[]", [[GENESIS, LIST_HASH, id, at], o.badKeysAt === i ? [KEYS[1], KEYS[0]] : KEYS]);
    }
    throw new RpcFail(-32601, `no call ${sel}`);
  };
  fakeFetch({ [DEST_A.url]: dest, [V3_HTTP.url]: node });
  try {
    return await keyHistory(baseEnv([DEST_A]), { emit: () => undefined, stopped: () => false });
  } finally {
    restoreFetch();
  }
}

test("the key history: the three set changes of the fixture verify, each signed by the set before and naming the client's next list", async () => {
  const h = await history();
  assert.equal(h.done, true);
  assert.deepEqual(
    h.changes.map((c) => [c.setId, c.at, c.state]),
    [
      [33n, 118_123, "passed"],
      [34n, 121_706, "passed"],
      [35n, 125_299, "passed"],
    ],
  );
  assert.equal(h.summary, "3 of 3 set changes verified · the same 2 keys since set 32");
  assert.ok(h.checkpoint?.lines.some((l) => l.ok === true && l.text.startsWith("V3's runtime names the checkpoint's 2 keys")));
  assert.deepEqual(h.events, { ok: true, text: "Never paused, reinitialized or halted, and the same admin, since its deployment" });
});

test("the key history: a tampered justification fails that change only", async () => {
  const h = await history({ tamperAt: 121_706 });
  assert.deepEqual(
    h.changes.map((c) => c.state),
    ["passed", "failed", "passed"],
  );
  assert.match(h.changes[1]!.text, /#121,706/);
  assert.equal(h.summary, "2 of 3 set changes verified · set 34's change does not");
});

test("the key history closes the chain: a set whose listed keys do not hash to its list hash fails the change it signs; a change the node has no proof for is not checked, not failed", async () => {
  const bad = await history({ badKeysAt: 1 });
  assert.deepEqual(
    bad.changes.map((c) => c.state),
    ["passed", "failed", "passed"],
  );
  assert.match(bad.changes[1]!.text, /^#121,706: the keys the client lists for set 33 do not hash to its list hash 0x/);
  const none = await history({ noProofAt: 121_706 });
  assert.deepEqual(
    none.changes.map((c) => c.state),
    ["passed", "skipped", "passed"],
  );
  assert.equal(none.changes[1]!.text, "#121,706: not checked, the node gave no proof there");
  assert.equal(none.summary, "2 of 3 set changes verified · 1 not checked");
});

test("the key history's admin events: the deployment's own AdminTransferred is not one; a pause or a new admin is", async () => {
  const at = (topics: Hex[], data: Hex = "0x"): RawLog => ({ address: LIGHT_CLIENT, topics, data, blockNumber: "0xb60000", transactionHash: `0x${"31".repeat(32)}` });
  const AT = eventTopic("AdminTransferred(address,address)");
  const deployed = at([AT, word32(0n), word32(DEPLOYER)]);
  assert.equal((await history({ logs: [deployed] })).events?.ok, true);
  const handed = await history({ logs: [deployed, at([AT, word32(DEPLOYER), word32(0xabn)])] });
  assert.deepEqual(handed.events, { ok: false, text: "1 admin event since its deployment: AdminTransferred" });
  const paused = await history({ logs: [at([eventTopic("Paused(address,string)"), word32(DEPLOYER)], enc("string", ["a test"])), at([eventTopic("Unpaused(address)"), word32(DEPLOYER)])] });
  assert.deepEqual(paused.events, { ok: false, text: "2 admin events since its deployment: Paused, Unpaused" });
});

// ---------------------------------------------------------------------------------------------
// The review's cases: what each step passes on, and what the verdict may say

test("step 6 passes only on an answer read just now: the records' receipt alone, used(n) and the replay unanswered, is not checked; a receipt read now passes, and says so", async () => {
  const run = await runHero({ noReceipt: true, flaky: true });
  assert.deepEqual(states(run), ["passed", "passed", "passed", "passed", "passed", "skipped"]);
  const s6 = step(run, "accepted");
  assert.equal(s6.sub, "Not checked: Sepolia's RPCs answered neither used(0) nor the replay; the records' receipt is shown");
  assert.equal(s6.retry, true);
  assert.deepEqual(s6.ev.find((e) => e.k === "used(0)")?.v, [{ t: "src", kind: "missing", text: "Not answered" }]);
  assert.ok(!JSON.stringify(s6).includes("used(0) = true"));
  const v = verdictOf(run, "Sepolia");
  assert.deepEqual([v.kind, v.chip, v.title], ["partial", "Not all checked", "Not all checked"]);
  // The receipt read now, its logs matched; used(n) and the replay not answered: it passes on the receipt alone, in those words.
  const live = await runHero({ flaky: true });
  assert.equal(step(live, "accepted").state, "passed");
  assert.equal(step(live, "accepted").sub, "Minted once · its receipt, read now, has status 1");
  assert.equal(verdictOf(live, "Sepolia").kind, "verified");
  // The records' receipt and used(n) read true, the replay paused: not checked, the receipt standing.
  assert.equal(step(await runHero({ noReceipt: true, replay: revertData("ClientPaused()") }), "accepted").state, "skipped");
});

test("step 6's failures: status 0, no Minted log, a Minted or HeaderImported log of another block, used(n) false", async () => {
  const swap = (name: string) => (logs: RawLog[]) =>
    logs.map((l) => (registry.decodeLog(l)?.name === name ? (JSON.parse(JSON.stringify(l).replaceAll(B0.slice(2), "77".repeat(32))) as RawLog) : l));
  const cases: [string, Fakes, string][] = [
    ["status 0", { status: "0x0" }, "the mint's receipt has status 0"],
    ["no Minted log", { logs: (l) => l.filter((x) => registry.decodeLog(x)?.name !== "Minted") }, "the receipt has no Minted log for nonce 0"],
    ["Minted of another block", { logs: swap("Minted") }, "the Minted log names block 0x7777…7777, not 0xc89b…4e6d"],
    ["HeaderImported of another block", { logs: swap("HeaderImported") }, "no HeaderImported log names block 0xc89b…4e6d"],
    ["used(0) false", { used: false }, "used(0) is false: the minter would mint it again"],
  ];
  for (const [what, f, sub] of cases) {
    const run = await runHero(f);
    assert.deepEqual(states(run), ["passed", "passed", "passed", "passed", "passed", "failed"], what);
    assert.equal(step(run, "accepted").sub, sub, what);
    assert.equal(verdictOf(run, "Sepolia").title, "Did not check out at step 6 · Accepted on Sepolia", what);
  }
});

test("step 2's failures: another light client, a reset V3, a set entry naming other keys, V3's runtime naming other keys", async () => {
  const cases: [string, Fakes, RegExp][] = [
    ["lightClient()", { lightClient: `0x${"ab".repeat(20)}` }, /^this minter checks another light client: 0x[aA][bB]/],
    ["genesisHash()", { genesis: `0x${"ee".repeat(32)}` }, /^V3 was reset: the client follows genesis 0xeeee…eeee, V3's block 0 is 0xd4f9…83bd$/],
    ["authoritySetAt", { listHash: `0x${"99".repeat(32)}` }, /^the client's set 30 entry does not name these keys$/],
    ["V3's runtime", { runtimeKeys: [KEYS[1]!, KEYS[0]!] }, /^V3's runtime and the light client disagree on set 30$/],
  ];
  for (const [what, f, sub] of cases) {
    const run = await runHero(f);
    assert.deepEqual(states(run), ["passed", "failed", "unreached", "unreached", "unreached", "unreached"], what);
    assert.match(step(run, "keys").sub, sub, what);
    assert.equal(verdictOf(run, "Sepolia").failedAt, 2, what);
  }
});

test("headerOf is asked of two RPCs and compared: another state root fails step 1; when they agree the line says so", async () => {
  const run = await runHero({ otherHeld: enc("(uint32,bytes32,uint64)", [[108_424, `0x${"11".repeat(32)}`, 31n]]) });
  assert.deepEqual(states(run), ["failed", "unreached", "unreached", "unreached", "unreached", "unreached"]);
  assert.equal(step(run, "header").sub, "Sepolia's RPCs answer different state roots for #108,424 (headerOf): dest-a.fake and dest-b.fake");
  assert.equal(step(run, "header").diff?.found, `0x${"11".repeat(32)}`);
  const ok = await runHero({});
  assert.ok(linesOf(ok).includes("true The light client on Sepolia stores the same state root for #108,424 (headerOf; dest-a.fake and dest-b.fake agree)"));
});

test("a red cross-check under a passed step reaches the verdict: a Locked log naming other fields, an admin that is not the deployer", async () => {
  const lockedLog: RawLog = {
    address: VAULT,
    topics: [eventTopic("Locked(uint256,address,address,uint256,address,uint256,bytes32)"), word32(0n), word32(hero.from), word32(heroBundle.lock.recipient)],
    data: enc("uint256,address,uint256,bytes32", [SEPOLIA_ID, MINTER, 999n, heroBundle.lock.commitment]),
    blockNumber: "0x18a91",
    transactionHash: `0x${"25".repeat(32)}`,
  };
  const run = await runHero({ locked: [lockedLog] });
  assert.deepEqual(states(run), ["passed", "passed", "passed", "passed", "passed", "passed"]);
  assert.ok(step(run, "commit").lines.some((l) => l.ok === false && l.text === "the Locked log at V3 #101,009 (tx 0x2525…2525) names other fields"));
  assert.equal(run.disagree, true);
  const v = verdictOf(run, "Sepolia");
  assert.deepEqual([v.kind, v.chip, v.title], ["disagree", "Cross-check differs", "Verified · a cross-check disagrees"]);
  assert.match(v.sub, /^The Locked log at V3 #101,009 \(tx 0x2525…2525\) names other fields · 6 of 6 checks · /);
  // The client's admin() read just now, against its deployer's key.
  const other = await runHero({ admin: "0x00000000000000000000000000000000000000aa" });
  assert.equal(other.facts.admin, "0x00000000000000000000000000000000000000aa");
  assert.ok(linesOf(other).includes("false admin() = 0x0000…00AA, not its deployer 0xD983…1071: the client has another admin"));
  assert.equal(verdictOf(other, "Sepolia").kind, "disagree");
  const own = await runHero({});
  assert.equal(own.facts.admin, DEPLOYER);
  assert.ok(linesOf(own).includes("true admin() = 0xD983…1071, its deployer, who installed the checkpoint"));
  assert.match(step(own, "keys").trust?.text ?? "", /its admin \(its deployer, 0xD983…1071\) installed/);
});

test("a mint sent through Multicall3 after a set change: the set change line-checked, the mint replayed as its own call to the minter, the re-run as sent", async () => {
  const header = encodeRpcHeader(S0.header);
  const just = decodeFinalityProof(hexToBytes(S0.proof)).justification;
  const hint = signersHint(decodeJustification(just), KEY_BYTES, 32n, crypto.verify).hint;
  const multicall = bytesToHex(
    aggregate3Calldata([
      { target: LIGHT_CLIENT, allowFailure: false, callData: importHeaderCalldata(header, just, hint) },
      { target: MINTER, allowFailure: false, callData: hexToBytes(hero.input) },
    ]),
  );
  // The set change's HeaderImported comes first in the receipt, before the mint block's own.
  const imported: RawLog = {
    address: LIGHT_CLIENT,
    topics: [eventTopic("HeaderImported(bytes32,uint32,bytes32,uint64,uint256)"), S0.hash, word32(BigInt(S0.number))],
    data: enc("bytes32,uint64,uint256", [S0.header.stateRoot, 32n, 2n]),
  };
  const held = { [S0.hash]: enc("(uint32,bytes32,uint64)", [[S0.number, S0.header.stateRoot, 32n]]) };
  const run = await runHero({ multicall, logs: (l) => [imported, ...l], held });
  assert.deepEqual(states(run), ["passed", "passed", "passed", "passed", "passed", "passed"]);
  assert.equal(verdictOf(run, "Sepolia").kind, "verified");
  const lines = linesOf(run);
  const s0 = `${S0.hash.slice(0, 6)}…${S0.hash.slice(-4)}`;
  assert.ok(lines.includes(`true Set change 1 of 1, imported first through Multicall3: ${s0}, signed by set 32, its signatures valid, a change the client follows`));
  assert.ok(lines.includes("true HeaderImported(#118,123, set 32): set change 1 of 1, imported first"));
  assert.ok(lines.includes("true HeaderImported(#108,424, set 30, 2 signatures): the same block, state root and set"));
  assert.ok(lines.includes("true Sent again just now as a read, its own call to the minter (the mint went through Multicall3): NonceAlreadyUsed(0)"));
  assert.ok(lines.includes("true Run again at Sepolia #11,950,901, the block before it was mined: it passes"));
  assert.equal(step(run, "header").raw[0]?.call, "importAndMint calldata, inside Multicall3's aggregate3");
  assert.equal(run.facts.mint?.data, hero.input.toLowerCase());
  // Without its set change's HeaderImported the receipt does not match what the transaction imported.
  const missing = await runHero({ multicall, held });
  assert.ok(linesOf(missing).includes(`false no HeaderImported log names set change 1, ${s0}, which the transaction imported first`));
  assert.equal(verdictOf(missing, "Sepolia").kind, "disagree");
});

test("checkMintLogs takes the HeaderImported of the mint's own block, wherever it is in the receipt", () => {
  const p = decodeMintCall(hero.input, MINTER, LIGHT_CLIENT).p;
  const setChange: RawLog = {
    address: LIGHT_CLIENT,
    topics: [eventTopic("HeaderImported(bytes32,uint32,bytes32,uint64,uint256)"), `0x${"77".repeat(32)}`, word32(107_359n)],
    data: enc("bytes32,uint64,uint256", [`0x${"88".repeat(32)}`, 29n, 2n]),
  };
  const x = { minter: MINTER, lightClient: LIGHT_CLIENT, block: B0, number: 108_424, stateRoot: heroBundle.header.stateRoot as Hex, setId: 30n, p, imported: true };
  assert.equal(checkMintLogs([setChange, ...hero.receipt.logs], x, registry).problem, null);
  const both = checkMintLogs([setChange, ...hero.receipt.logs], { ...x, changes: [`0x${"77".repeat(32)}`] }, registry);
  assert.equal(both.problem, null);
  assert.equal(both.lines[0]?.text, "HeaderImported(#107,359, set 29): set change 1 of 1, imported first");
});

test("a slot proof of another nonce fails the storage proofs", async () => {
  const a = importArgs(hero.input);
  const p = decodeMintCall(hero.input, MINTER, LIGHT_CLIENT).p;
  const input = bytesToHex(importAndMintCalldata(hexToBytes(a.header), hexToBytes(a.proof), hexToBytes(a.signersHint), { ...p, recipient: hexToBytes(p.recipient), nonce: 5n }));
  const run = await runLock("0", { input, replay: nonceUsedData(5n) }, { nonce: 5n });
  assert.deepEqual(states(run), ["passed", "passed", "passed", "failed", "unreached", "unreached"]);
  assert.match(step(run, "proof").sub, /is not in the proof$|shows the key absent$/);
});

test("route B's verdict follows step 6: minted meanwhile, not all checked, and a used(n) never read", async () => {
  const lock = { tx: `0x${"25".repeat(32)}` as Hex, block: 101_009, via: "evm" as const };
  const runB = async (plan: MintPlan, more: Partial<UnmintedLock> = {}) => {
    const env = lockEnv(LOCKS["0"]!, { plan });
    try {
      return await verifyUnminted(env, { nonce: 0n, fields: FIELDS0, lock, why: "Not minted yet: used(0) is false on Sepolia. The proof is read from V3 now.", ...more }, { emit: () => undefined, stopped: () => false });
    } finally {
      restoreFetch();
    }
  };
  const meanwhile = await runB(planOf("minted", "Lock 0 is minted already."));
  assert.equal(step(meanwhile, "accepted").state, "open");
  let v = verdictOf(meanwhile, "Sepolia");
  assert.deepEqual([v.kind, v.chip, v.title], ["partial", "Minted meanwhile", "Minted meanwhile · check again"]);
  const blocked = await runB(planOf("blocked", "The light client is paused."));
  assert.equal(step(blocked, "accepted").state, "skipped");
  v = verdictOf(blocked, "Sepolia");
  assert.deepEqual([v.kind, v.chip, v.title], ["unminted", "Not minted yet", "Not minted yet · not all checked"]);
  const unread = await runB(planOf("blocked", "The light client is paused."), { unread: true });
  assert.equal(unread.usedUnread, true);
  v = verdictOf(unread, "Sepolia");
  assert.deepEqual([v.kind, v.chip, v.title], ["partial", "Not all checked", "Not all checked · whether it is minted was not read"]);
  // A dry run that passes reads the minter itself: Not minted yet stands on it.
  v = verdictOf(await runB(planOf("ready", ""), { unread: true }), "Sepolia");
  assert.deepEqual([v.kind, v.title], ["unminted", "Not minted yet · Sepolia would accept it"]);
});

test("the carried-forward keys: the client at set 32, V3's head signed by set 33, the change between checked here", async () => {
  const v3 = new FakeV3();
  v3.add(S0, LOCK1_BLOCK);
  v3.finalized = LOCK1_BLOCK.hash;
  v3.prove = proveFrom([S0, LOCK1_BLOCK]);
  v3.lockProofs(LOCK1_BLOCK.hash, lock1Bundle.childRoot.proof.nodes, [...lock1Bundle.childRoot.proof.nodes, ...lock1Bundle.slot.proof.nodes]);
  const dest = (method: string, params: unknown[]): unknown => {
    const tx = params[0] as { to: string; data: Hex };
    if (method !== "eth_call") throw new RpcFail(-32601, `no ${method}`);
    const is = (sig: string) => tx.data.slice(0, 10) === selector(sig);
    if (is("vaultTrieId()")) return enc("bytes32", [TRIE_ID]);
    if (is("lightClient()")) return enc("address", [LIGHT_CLIENT]);
    if (is("admin()")) return enc("address", [DEPLOYER]);
    if (is("genesisHash()")) return enc("bytes32", [GENESIS]);
    if (is("currentSetId()")) return enc("uint64", [32n]);
    if (is("latestFinalized()")) return enc("bytes32,uint32", [HELD_116992.hash, HELD_116992.number]);
    if (is("authoritySetCount()")) return enc("uint256", [14n]);
    if (is("authorities(uint64)")) return enc("bytes32[]", [KEYS]);
    if (is("authoritySetAt(uint256)")) {
      const i = decode("uint256", `0x${tx.data.slice(10)}`)[0] as bigint;
      return enc("(bytes32,bytes32,uint64,uint32),bytes32[]", [[GENESIS, LIST_HASH, 19n + i, i === 0n ? 67_958 : 114_535], KEYS]);
    }
    throw new RpcFail(-32601, `no call ${tx.data.slice(0, 10)}`);
  };
  fakeFetch({ [DEST_A.url]: dest, [DEST_B.url]: dest, [V3_HTTP.url]: v3.handle, [V3_EVM.url]: () => [] });
  try {
    const fields = { recipient: lock1Bundle.lock.recipient as Hex, amount: BigInt(lock1Bundle.lock.amountNative), block: lock1Bundle.parentHeader.number as number, commitment: lock1Bundle.lock.commitment as Hex };
    const env: VerifyEnv = { ...baseEnv([DEST_A, DEST_B]), plan: async () => planOf("ready", "") };
    const run = await verifyUnminted(env, { nonce: 1n, fields, lock: null, why: "Not minted yet." }, { emit: () => undefined, stopped: () => false });
    assert.deepEqual(states(run), ["passed", "passed", "passed", "passed", "passed", "passed"]);
    assert.equal(step(run, "keys").sub, "Set 33 · 2 keys · 2 needed");
    assert.ok(linesOf(run).includes("true The client is at set 32: set 33's keys carried forward through 1 set change V3 made since, each signed by the set before"));
    assert.equal(run.facts.carried, 1);
    assert.equal(step(run, "sigs").sub, "Round 2,319 · set 33 · 2 of 2 valid · 2 needed");
    assert.match(step(run, "proof").sub, /^commitments\[1\] = 0x2d1a…d0a7 at V3 #118,637$/);
  } finally {
    restoreFetch();
  }
});

test("the way back: B1 passes on the receipt read now, the records' account is shown as not checked; the title says what B1 and B3 found, and no more", async () => {
  // The receipt not served and the V3 node down: B1 and B3 not checked, B2 on burnIdOf read now, B4 trusted.
  const down = await runBurn({ noReceipt: true, v3Down: true });
  assert.deepEqual(states(down), ["skipped", "passed", "skipped", "trusted"]);
  assert.equal(step(down, "burn").sub, "Not checked: no Sepolia RPC served the burn's receipt; the records' account of it is shown");
  assert.deepEqual(step(down, "burn").ev.find((e) => e.k === "Block")?.v[1], { t: "src", kind: "recorded", text: "Recorded · deployments/sepolia-bridge.json" });
  assert.equal(step(down, "burnId").sub, "recomputed = the records' = burnIdOf(1)");
  assert.equal(step(down, "released").sub, "Not checked: the V3 node did not give its finalized head's proof (v3.fake: node down)");
  let v = verdictOf(down, "Sepolia");
  assert.deepEqual([v.kind, v.chip, v.title, v.sub], ["trusted", "Trusted · 2-of-3", "Burn not checked, release not checked on V3", "1 check passed · 2 not checked · 1 trusted: the committee's release"]);
  // Neither the log nor burnIdOf: the id is not checked either.
  assert.equal(step(await runBurn({ noReceipt: true, noIdOf: true }), "burnId").state, "skipped");
  // The burn read, the V3 node down.
  v = verdictOf(await runBurn({ v3Down: true }), "Sepolia");
  assert.equal(v.title, "Burned on Sepolia, release not checked on V3");
  // Not released yet: released[burnId] of burn 6 is proven absent at the same head (the node's proof shows its path empty).
  const target: BurnTarget = { ...BURN_TARGET, n: 6n, recorded: null, release: null };
  const open = await runBurn({ n: 6n, released: false }, target);
  assert.deepEqual(states(open), ["passed", "passed", "open", "trusted"]);
  assert.equal(step(open, "released").sub, "Not released on V3 yet");
  assert.ok(linesOf(open).includes("true released() = false, from V3's EVM RPC"));
  v = verdictOf(open, "Sepolia");
  assert.equal(v.title, "Burned on Sepolia, not released on V3 yet");
});

test("the way back's failures: status 0, no BurnRequested, another id; B4 trusted whatever B1 to B3 found; the set read is not ticked until its signatures pass", async () => {
  const cases: [string, BurnFakes, number, string][] = [
    ["status 0", { status: "0x0" }, 0, "the burn's receipt has status 0"],
    ["no BurnRequested", { noLog: true }, 0, "the transaction has no BurnRequested log for burn 1"],
    ["another id", { idOf: `0x${"ab".repeat(32)}` }, 1, "this id does not name this burn"],
  ];
  for (const [what, f, at, sub] of cases) {
    const run = await runBurn(f);
    assert.deepEqual(
      states(run),
      run.steps.map((_, i) => (i === 3 ? "trusted" : i < at ? "passed" : i === at ? "failed" : "unreached")),
      what,
    );
    assert.equal(run.steps[at]!.sub, sub, what);
    assert.equal(verdictOf(run, "Sepolia").kind, "failed", what);
  }
  // V3's head signatures do not verify: B3 fails, and the set the run read is not taken as checked.
  const p: string = R.head.proof;
  const bad = await runBurn({ proof: `0x${flipByte(p.slice(2), p.length / 2 - 1 - 40)}` as Hex });
  assert.deepEqual(states(bad), ["passed", "passed", "failed", "trusted"]);
  assert.match(step(bad, "released").sub, /^V3's head #257,373: precommit \d: invalid signature$/);
  assert.notEqual(bad.facts.setId, null);
  assert.equal(signedChecked(bad), false);
  assert.equal(signedChecked(await runBurn()), true);
});

test("a failed read reads in plain words: each endpoint's failure, its raw message left to the raw data", () => {
  const e = new AllFailed("eth_call", [
    "sepolia.drpc.org: chain is not available on free plan, please upgrade to paid plan",
    "ethereum-sepolia-rpc.publicnode.com: no answer in 15 s",
    "sepolia.gateway.tenderly.co: HTTP 429",
    "chain_getHeader: test-node-v3.portaldot.dev: unreachable",
  ]);
  assert.equal(plainWhy(e), "drpc refused: its free plan does not serve this chain; publicnode did not answer in time; tenderly refused: too many requests; test-node-v3 did not answer");
});

test("step 4's cross-check: the V3 node's proof that does not walk disagrees, a red line that reaches the verdict; not answered, not served or pruned stays neutral", async () => {
  // The last byte of the node's last child item: its hash no longer matches the reference to it.
  const flipLast = (proof: Hex[]): Hex[] => {
    const last = proof.at(-1)!.slice(2);
    return [...proof.slice(0, -1), `0x${flipByte(last, last.length / 2 - 1)}` as Hex];
  };
  const bad = await runHero({ nodeChild: flipLast });
  assert.deepEqual(states(bad), ["passed", "passed", "passed", "passed", "passed", "passed"]);
  const red = step(bad, "proof").lines.filter((l) => l.ok === false);
  assert.equal(red.length, 1);
  assert.match(red[0]!.text, /^the V3 node's proof at #108,424 does not walk: .*is not in the proof$/);
  assert.equal(bad.disagree, true);
  const v = verdictOf(bad, "Sepolia");
  assert.deepEqual([v.kind, v.chip, v.title], ["disagree", "Cross-check differs", "Verified · a cross-check disagrees"]);
  assert.match(v.sub, /^The V3 node's proof at #108,424 does not walk: /);
  // No answer, an answer with no proof, or state the node no longer has: neutral, and the mint's own proof stands.
  const cases: [Fakes["nodeChild"], string][] = [
    ["down", "null The V3 node's proof: not answered"],
    [() => null, "null The V3 node's proof: not served"],
    ["pruned", "null Not served · the V3 node no longer has state at #108,424 (pruned): the proof checked is the one the mint carried"],
  ];
  for (const [nodeChild, line] of cases) {
    const run = await runHero({ nodeChild });
    assert.ok(linesOf(run).includes(line), line);
    assert.equal(run.disagree, false, line);
    assert.equal(verdictOf(run, "Sepolia").kind, "verified", line);
  }
});

test("a mint(p) at a block the client does not hold fails step 1 with UnknownBlock's words, its import not found; one it holds is not checked without the import", async () => {
  const L = LOCKS["3"]!;
  const other = `0x${flipByte(L.block.slice(2), 0)}` as Hex;
  const input = tamper(L.mint.input, L.block.slice(2), (h) => flipByte(h, 0));
  const run = await runLock("3", { input, unknownBlock: other });
  assert.deepEqual(states(run), ["failed", "unreached", "unreached", "unreached", "unreached", "unreached"]);
  assert.equal(step(run, "header").sub, "the light client on Sepolia holds no block 0xbc6b…ccdc");
  assert.equal(step(run, "header").raw.length, 2, "both RPCs' answers to headerOf");
  assert.deepEqual(step(run, "header").from, ["dest-a.fake", "dest-b.fake"]);
  const v = verdictOf(run, "Sepolia");
  assert.deepEqual([v.kind, v.title], ["failed", "Did not check out at step 1 · Header hash"]);
  // The same block, which the client holds, without its import: not checked, as before.
  const held = await runLock("3", { input });
  assert.equal(step(held, "header").state, "skipped");
  assert.equal(step(held, "header").sub, "Not checked: the import that brought 0xbc6b…ccdc into the client was found neither in the records nor in its logs");
});

test("a V3 head header that does not hash to its block fails the step that reads it, in short hashes: B3 on the way back, B4 still Trusted; step 1 from V3 now; on a mint's run, a red line", async () => {
  const run = await runBurn({ headHeader: { ...R.head.header, stateRoot: `0x${"11".repeat(32)}` } });
  assert.deepEqual(states(run), ["passed", "passed", "failed", "trusted"]);
  const b3 = step(run, "released");
  assert.match(b3.sub, /^V3's finalized head: the header the V3 node serves for 0x8b38…91ec hashes to 0x\w{4}…\w{4}$/);
  assert.doesNotMatch(b3.sub, /0x[0-9a-f]{64}/);
  assert.equal(b3.diff?.expected, R.head.hash);
  assert.equal(step(run, "release").sub, "Trusted, not checked: the committee's release");
  let v = verdictOf(run, "Sepolia");
  assert.deepEqual([v.kind, v.title], ["failed", "Did not check out at step 3 · Released on V3"]);
  // From V3 now, the same fault fails step 1.
  const other: RpcHeader = { ...LOCKS["0"]!.v3Header, stateRoot: `0x${"11".repeat(32)}` };
  const env = lockEnv(LOCKS["0"]!, { plan: planOf("ready", ""), v3Header: other });
  try {
    const now = await verifyUnminted(env, { nonce: 0n, fields: FIELDS0, lock: null, why: "Not minted yet." }, { emit: () => undefined, stopped: () => false });
    assert.deepEqual(states(now), ["failed", "unreached", "unreached", "unreached", "unreached", "unreached"]);
    assert.match(step(now, "header").sub, /^V3's finalized head: the header the V3 node serves for 0xc89b…4e6d hashes to 0x\w{4}…\w{4}$/);
    v = verdictOf(now, "Sepolia");
    assert.deepEqual([v.kind, v.title], ["failed", "Did not check out at step 1 · Header hash"]);
  } finally {
    restoreFetch();
  }
  // On a mint's run the header checked is the mint's own: the node's other header is a red cross-check under step 1.
  const minted = await runHero({ v3Header: other });
  assert.equal(step(minted, "header").state, "passed");
  assert.ok(linesOf(minted).includes("false the V3 node serves another header for #108,424"));
  assert.equal(verdictOf(minted, "Sepolia").kind, "disagree");
});
