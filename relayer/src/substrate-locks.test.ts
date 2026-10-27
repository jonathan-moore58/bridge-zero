// Unit tests of substrate-locks.ts, offline, on System.Events captured from the V3 node
// (fixtures/v3-testnet-events): the committee's two releases at #117,701 and #173,062, whose
// Released events eth_getLogs never returned, decoded from Revive.ContractEmitted and checked
// against deployments/v3-testnet.json; lock 2's Locked event at #219,589, which System.Events holds
// as well as eth_getLogs; lock 3 at #222,024, sent with revive.call from a 5... account, whose
// Locked event only System.Events holds; and the lookup of a lock by its nonce against a stand-in
// node (the vault's nextNonce block by block, the captured events, the metadata block by block),
// with the requests it makes counted and the events decoded with the metadata at the block's parent.
//
//   npm test

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { parseLockedLog } from "./automint.js";
import { bytesToHex, equalBytes, hexToBytes, type Hex } from "./bytes.js";
import { childRootKey } from "./hash.js";
import { reviveAccountInfoKey, reviveOriginalAccountKey, reviveSlotKey } from "./revive.js";
import {
  contractEvents,
  extrinsicHash,
  findSubstrateLock,
  firstBlockWhere,
  logOfEvent,
  LookupError,
  nodeReads,
  SYSTEM_EVENTS_KEY,
  vaultEventsAt,
  type FoundLock,
  type V3Reads,
} from "./substrate-locks.js";
import { commitmentSlot, decodeReleased, LOCKED_TOPIC, RELEASED_TOPIC, reviveAddress, SLOTS, uintWord } from "./vault.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = <T>(path: string): T => JSON.parse(readFileSync(`${ROOT}${path}`, "utf8")) as T;

const VAULT: Hex = "0xa02ee16eb03d2cf1aef199f7658fb8c8e3188ffd";
const VAULT_BLOCK = 100_955;
const BRIDGE = { vault: VAULT, v3ChainId: 420_420_777n, chainId: 11_155_111n, minter: "0x8287b3baf205ca8456f98346f13064aa7fcdcb9e" as Hex };

interface EventsFixture {
  provenance: { block: { number: number; hash: Hex }; runtime: { specVersion: number } };
  metadata: string;
  key: Hex;
  events: Hex;
  extrinsics: Hex[];
}

const DIR = "fixtures/v3-testnet-events";
const metadataFile = read<{ stripped: { gzipBase64: string; bytes: number } }>(`${DIR}/metadata-3002.json`);
const METADATA = new Uint8Array(gunzipSync(Buffer.from(metadataFile.stripped.gzipBase64, "base64")));
const events = (n: number) => read<EventsFixture>(`${DIR}/events-${n}.json`);

const V3 = read<{
  vault: { block: { number: number } };
  locks: { status: string; vaultNonce?: string; from: Hex; recipient: Hex; amountNative: string; commitment?: Hex; block?: { number: number }; txHash: Hex }[];
  releases: { burn: { burnId: Hex }; payee: Hex; amountNative: string; released: { block: { number: number; hash: Hex } }; approvals: { action: string; extrinsicHash: Hex; block: { number: number; index: number } }[] }[];
}>("deployments/v3-testnet.json");
const recordedLock = (nonce: number) => V3.locks.find((l) => l.status === "locked" && l.vaultNonce === String(nonce))!;

// ---------------------------------------------------------------------------------------

describe("System.Events from the V3 node", () => {
  it("the fixture's metadata is V3's spec 3002 with its docs emptied, and the events name it", () => {
    assert.equal(METADATA.length, metadataFile.stripped.bytes);
    assert.equal(new TextDecoder().decode(METADATA.subarray(0, 4)), "meta");
    for (const n of [117_701, 173_062, 219_589, 222_024]) {
      const f = events(n);
      assert.equal(f.metadata, "metadata-3002.json");
      assert.equal(f.key, bytesToHex(SYSTEM_EVENTS_KEY));
      assert.equal(f.provenance.block.number, n);
    }
  });

  for (const [i, n] of [117_701, 173_062].entries()) {
    it(`release ${i} at #${n.toLocaleString("en-US")}: the vault's Released event, which eth_getLogs never returned, decodes from Revive.ContractEmitted`, async () => {
      const f = events(n);
      const r = V3.releases[i];
      assert.equal(r.released.block.number, n);
      assert.equal(r.released.block.hash, f.provenance.block.hash);
      const all = await contractEvents(METADATA, hexToBytes(f.events));
      assert.equal(all.length, 1, "one contract event in the block");
      const [e] = all;
      assert.equal(e.contract, VAULT);
      assert.equal(e.topics[0], RELEASED_TOPIC);
      // The extrinsic that emitted it is the committee's second approval, as the record has it.
      const run = r.approvals.find((a) => a.action === "execute")!;
      assert.equal(e.extrinsic, run.block.index);
      assert.equal(extrinsicHash(hexToBytes(f.extrinsics[e.extrinsic!])), run.extrinsicHash);
      // As a log, it reads as the EVM logs' parser reads a Released log.
      const released = decodeReleased(logOfEvent(e, f.provenance.block, run.extrinsicHash));
      assert.equal(bytesToHex(released.burnId), r.burn.burnId);
      assert.equal(bytesToHex(released.to), r.payee);
      assert.equal(released.amountNative.toString(), r.amountNative);
    });
  }

  it("lock 2 at #219,589: System.Events holds its Locked event too, which reads as the same lock as its EVM log", async () => {
    const f = events(219_589);
    const [e, ...rest] = await contractEvents(METADATA, hexToBytes(f.events));
    assert.equal(rest.length, 0);
    assert.equal(e.topics[0], LOCKED_TOPIC);
    const lock = recordedLock(2);
    const p = parseLockedLog(logOfEvent(e, f.provenance.block, extrinsicHash(hexToBytes(f.extrinsics[e.extrinsic!]))), BRIDGE);
    assert.ok(p.kind === "lock");
    assert.equal(p.lock.nonce, 2n);
    assert.equal(p.lock.block, lock.block!.number);
    assert.equal(p.lock.sender, lock.from, "an EVM lock: msg.sender is the Ethereum key's address");
    assert.equal(p.lock.recipient, lock.recipient);
    assert.equal(p.lock.amount.toString(), lock.amountNative);
    assert.equal(p.lock.commitment, lock.commitment);
  });

  it("lock 3 at #222,024, sent with revive.call from 5ERJ…gPJ7: its Locked event, which eth_getLogs does not return, is in System.Events", async () => {
    const f = events(222_024);
    const lock = recordedLock(3) as ReturnType<typeof recordedLock> & { via?: string; substrate?: { ss58: string; accountId: Hex }; extrinsicIndex?: number };
    assert.equal(lock.via, "substrate");
    assert.equal(f.provenance.block.hash, (lock.block as { hash?: Hex }).hash);
    const [e, ...rest] = await contractEvents(METADATA, hexToBytes(f.events));
    assert.equal(rest.length, 0);
    assert.equal(e.contract, VAULT);
    assert.equal(e.extrinsic, lock.extrinsicIndex);
    assert.equal(extrinsicHash(hexToBytes(f.extrinsics[e.extrinsic!])), lock.txHash, "the extrinsic's hash is the one the record has");
    const p = parseLockedLog(logOfEvent(e, f.provenance.block, lock.txHash), BRIDGE);
    assert.ok(p.kind === "lock");
    assert.equal(p.lock.nonce, 3n);
    assert.equal(p.lock.block, 222_024);
    assert.equal(p.lock.txHash, lock.txHash);
    // msg.sender is the 5... account's address: keccak-256 of its account id (AutoMap).
    assert.equal(p.lock.sender, bytesToHex(reviveAddress(hexToBytes(lock.substrate!.accountId))));
    assert.equal(p.lock.sender, lock.from);
    assert.equal(p.lock.recipient, "0xd9838a86cf83c28ee486544060d1ca4ca2971071");
    assert.equal(p.lock.amount, 10n ** 11n, "0.001 tPOT");
    assert.equal(p.lock.commitment, lock.commitment);
  });

  it("refuses bytes that do not decode whole", async () => {
    const f = events(117_701);
    await assert.rejects(contractEvents(METADATA, hexToBytes(`${f.events}00`)), /decode from/);
    await assert.rejects(contractEvents(METADATA, hexToBytes(f.events).subarray(0, 100)));
  });

  it("Revive.OriginalAccount's key, which the lock tool reads for a recipient, is the one V3's metadata gives (Identity hasher)", async () => {
    const { TypeRegistry, Metadata } = await import("@polkadot/types");
    const { expandMetadata } = await import("@polkadot/types/metadata");
    const registry = new TypeRegistry();
    const metadata = new Metadata(registry, METADATA);
    registry.setMetadata(metadata, undefined, { AuthorizeCall: { extrinsic: {}, payload: {} }, EthSetOrigin: { extrinsic: {}, payload: {} } });
    const entry = (expandMetadata(registry, metadata).query as unknown as Record<string, Record<string, (address: Hex) => Uint8Array>>).revive.originalAccount;
    // 5ERJ…'s address, which AutoMap maps back to it; polkadot-js puts the key's SCALE length (a compact 52) in front.
    const address: Hex = "0xb621f9a9dd96ba88681c40b04657cef602854e24";
    assert.equal(bytesToHex(entry(address)), `0xd0${bytesToHex(reviveOriginalAccountKey(hexToBytes(address))).slice(2)}`);
  });
});

// ---------------------------------------------------------------------------------------

/** The vault's AccountInfoOf entry, as lock 1's bundle proved it (its trie id). */
const BUNDLE = read<{ account: { value: { scale: Hex } }; vault: { trieId: Hex } }>("fixtures/v3-testnet-lock1/mint-bundle.json");
const TRIE = hexToBytes(BUNDLE.vault.trieId);

interface Stand {
  head: number;
  /** Lock i is in block locks[i].block, with its commitment. */
  locks: { block: number; commitment: Hex }[];
  /** The captured events of a block, by number; any other block has none. */
  events: Map<number, EventsFixture>;
  /** The metadata in block n's state (state_getMetadata at n); the fixture's when not given. */
  metadataAt?: (n: number) => Uint8Array;
}

/** A stand-in for the V3 node: the vault's nextNonce and commitments block by block, the captured events, and every request counted. */
function standIn(s: Stand): V3Reads & { asked: string[] } {
  const asked: string[] = [];
  const hashOf = (n: number): Hex => s.events.get(n)?.provenance.block.hash ?? (`0x${n.toString(16).padStart(64, "0")}` as Hex);
  const numberOf = (hash: Hex): number => {
    for (const [n, f] of s.events) if (f.provenance.block.hash === hash) return n;
    return Number(BigInt(hash));
  };
  const inBlock = (at: Hex) => s.locks.filter((l) => l.block <= numberOf(at));
  return {
    asked,
    async finalizedHead() {
      asked.push("head");
      return { number: s.head, hash: hashOf(s.head) };
    },
    async blockHash(n) {
      asked.push(`hash ${n}`);
      if (n > s.head) throw new Error(`no block #${n}`);
      return hashOf(n);
    },
    async parentHash(at) {
      asked.push("parent");
      return hashOf(numberOf(at) - 1);
    },
    async storage(key, at) {
      asked.push("storage");
      if (equalBytes(key, reviveAccountInfoKey(hexToBytes(VAULT)))) return hexToBytes(BUNDLE.account.value.scale);
      if (equalBytes(key, SYSTEM_EVENTS_KEY)) {
        const f = s.events.get(numberOf(at));
        return f ? hexToBytes(f.events) : Uint8Array.of(0);
      }
      return null;
    },
    async childStorage(childKey, key, at) {
      asked.push(`child ${numberOf(at)}`);
      assert.ok(equalBytes(childKey, childRootKey(TRIE)), "the vault's child trie");
      const locks = inBlock(at);
      if (equalBytes(key, reviveSlotKey(uintWord(SLOTS.nextNonce)))) return locks.length === 0 ? null : uintWord(BigInt(locks.length));
      const i = locks.findIndex((_, j) => equalBytes(key, reviveSlotKey(commitmentSlot(BigInt(j)))));
      return i < 0 ? null : hexToBytes(locks[i].commitment);
    },
    async metadata(at) {
      asked.push(`metadata ${numberOf(at)}`);
      return s.metadataAt?.(numberOf(at)) ?? METADATA;
    },
    async extrinsics(at) {
      asked.push("extrinsics");
      return (s.events.get(numberOf(at))?.extrinsics ?? []).map(hexToBytes);
    },
  };
}

const LOCKS = [0, 1, 2, 3].map((n) => ({ block: recordedLock(n).block!.number, commitment: recordedLock(n).commitment! }));
const stand = (more: Partial<Stand> = {}) => standIn({ head: 221_700, locks: LOCKS, events: new Map([[219_589, events(219_589)]]), ...more });

describe("the lookup of a lock by its nonce", () => {
  const check = (found: FoundLock | null) => {
    assert.ok(found);
    assert.deepEqual(found.block, { number: 219_589, hash: events(219_589).provenance.block.hash });
    assert.deepEqual(found.extrinsic, { index: 1, hash: extrinsicHash(hexToBytes(events(219_589).extrinsics[1])) });
    const p = parseLockedLog(found.log, BRIDGE);
    assert.ok(p.kind === "lock" && p.lock.nonce === 2n && p.lock.commitment === recordedLock(2).commitment);
  };

  it("finds the block where the vault's nextNonce passes the nonce by a binary search, then the event, in about 40 requests", async () => {
    const node = stand();
    check(await findSubstrateLock(node, { vault: VAULT, vaultBlock: VAULT_BLOCK, nonce: 2n }));
    assert.ok(node.asked.length <= 45, `${node.asked.length} requests`);
    assert.ok(node.asked.filter((a) => a.startsWith("child ")).length <= 20, "about 17 probes of nextNonce over the vault's 120,745 blocks");
  });

  it("checks a block a record names with two probes, and searches from a lower bound", async () => {
    const node = stand();
    check(await findSubstrateLock(node, { vault: VAULT, vaultBlock: VAULT_BLOCK, nonce: 2n, block: 219_589 }));
    assert.ok(node.asked.length <= 12, `${node.asked.length} requests`);
    const full = stand();
    check(await findSubstrateLock(full, { vault: VAULT, vaultBlock: VAULT_BLOCK, nonce: 2n }));
    const from = stand();
    check(await findSubstrateLock(from, { vault: VAULT, vaultBlock: VAULT_BLOCK, nonce: 2n, from: 219_500 }));
    assert.ok(from.asked.length < full.asked.length, `${from.asked.length} requests from a lower bound, ${full.asked.length} without`);
    // A wrong block or a lower bound past the lock: the search still finds it.
    check(await findSubstrateLock(stand(), { vault: VAULT, vaultBlock: VAULT_BLOCK, nonce: 2n, block: 219_600 }));
    check(await findSubstrateLock(stand(), { vault: VAULT, vaultBlock: VAULT_BLOCK, nonce: 2n, from: 220_000 }));
  });

  it("finds lock 3, which only System.Events holds, at #222,024, with the extrinsic the record names", async () => {
    const lock = recordedLock(3);
    const node = standIn({ head: 222_100, locks: LOCKS, events: new Map([[222_024, events(222_024)]]) });
    const found = await findSubstrateLock(node, { vault: VAULT, vaultBlock: VAULT_BLOCK, nonce: 3n, from: 219_589 });
    assert.ok(found);
    assert.deepEqual(found.block, { number: 222_024, hash: events(222_024).provenance.block.hash });
    assert.deepEqual(found.extrinsic, { index: 1, hash: lock.txHash });
    assert.equal(found.log.transactionHash, lock.txHash);
    const p = parseLockedLog(found.log, BRIDGE);
    assert.ok(p.kind === "lock" && p.lock.nonce === 3n && p.lock.amount === 10n ** 11n && p.lock.commitment === lock.commitment);
    assert.ok(node.asked.length <= 40, `${node.asked.length} requests from lock 2's block`);
    // At the block the record names, two probes.
    const named = standIn({ head: 222_100, locks: LOCKS, events: new Map([[222_024, events(222_024)]]) });
    assert.equal((await findSubstrateLock(named, { vault: VAULT, vaultBlock: VAULT_BLOCK, nonce: 3n, block: 222_024 }))?.block.number, 222_024);
    assert.ok(named.asked.length <= 12, `${named.asked.length} requests at the named block`);
  });

  it("finds nothing while no final block counts the nonce", async () => {
    assert.equal(await findSubstrateLock(stand(), { vault: VAULT, vaultBlock: VAULT_BLOCK, nonce: 3n }), null);
    assert.equal(await findSubstrateLock(stand({ head: 219_588 }), { vault: VAULT, vaultBlock: VAULT_BLOCK, nonce: 2n }), null);
  });

  it("refuses a block whose events lack the lock, and an event whose commitment is not the one the vault stores", async () => {
    const wrongEvents = stand({ events: new Map([[219_589, { ...events(117_701), provenance: events(219_589).provenance }]]) });
    await assert.rejects(findSubstrateLock(wrongEvents, { vault: VAULT, vaultBlock: VAULT_BLOCK, nonce: 2n }), (e: unknown) => e instanceof LookupError && /hold 0 Locked events/.test(e.message));
    const other = [...LOCKS.slice(0, 2), { block: LOCKS[2].block, commitment: `0x${"77".repeat(32)}` as Hex }];
    await assert.rejects(findSubstrateLock(stand({ locks: other }), { vault: VAULT, vaultBlock: VAULT_BLOCK, nonce: 2n }), (e: unknown) => e instanceof LookupError && /commitments\[2\]/.test(e.message));
  });

  it("vaultEventsAt gives the vault's events of a block with their extrinsics' hashes", async () => {
    const f = events(173_062);
    const node = standIn({ head: 221_700, locks: LOCKS, events: new Map([[173_062, f]]) });
    const got = await vaultEventsAt(node, VAULT, f.provenance.block.hash);
    assert.equal(got.length, 1);
    assert.equal(got[0].txHash, V3.releases[1].approvals.find((a) => a.action === "execute")!.extrinsicHash);
    assert.deepEqual(await vaultEventsAt(node, VAULT, `0x${(173_063).toString(16).padStart(64, "0")}`), [], "a block without events");
  });

  it("decodes a block's events with the metadata at its parent: a block that upgrades the runtime is run, and its events encoded, by the old one", async () => {
    // Block #219,589's own state names another runtime, whose metadata (here bytes that are no metadata) cannot decode the block's events.
    const upgraded = (n: number) => (n === 219_589 ? Uint8Array.of(1, 2, 3) : METADATA);
    const node = stand({ metadataAt: upgraded });
    check(await findSubstrateLock(node, { vault: VAULT, vaultBlock: VAULT_BLOCK, nonce: 2n, block: 219_589 }));
    assert.deepEqual(node.asked.filter((a) => a.startsWith("metadata")), ["metadata 219588"]);
    assert.ok(!node.asked.includes("parent") && node.asked.filter((a) => a === "hash 219588").length === 1, "the parent's hash is the one the probe of the block before read");
    check(await findSubstrateLock(stand({ metadataAt: upgraded }), { vault: VAULT, vaultBlock: VAULT_BLOCK, nonce: 2n }));
    // vaultEventsAt reads the parent from the block's header when it is not given; the block's own metadata does not decode it.
    const f = events(173_062);
    const release = standIn({ head: 221_700, locks: LOCKS, events: new Map([[173_062, f]]), metadataAt: (n) => (n === 173_062 ? Uint8Array.of(1, 2, 3) : METADATA) });
    assert.equal((await vaultEventsAt(release, VAULT, f.provenance.block.hash)).length, 1);
    assert.deepEqual(release.asked.filter((a) => a === "parent" || a.startsWith("metadata")), ["parent", "metadata 173061"]);
    await assert.rejects(vaultEventsAt(release, VAULT, f.provenance.block.hash, f.provenance.block.hash));
  });

  it("firstBlockWhere: the first block where a rule that stays true holds", async () => {
    for (const at of [10, 11, 15, 99, 100]) assert.equal(await firstBlockWhere(10, 100, async (n) => n >= at), at);
  });
});

describe("nodeReads", () => {
  it("starts its requests at least the interval apart, and reads the metadata once per spec version", async () => {
    const times: number[] = [];
    const methods: string[] = [];
    const node = nodeReads(
      {
        async request<T>(method: string): Promise<T> {
          times.push(Date.now());
          methods.push(method);
          if (method === "state_getRuntimeVersion") return { specVersion: 3002 } as T;
          if (method === "state_getMetadata") return "0x6d657461" as T;
          if (method === "chain_getBlockHash") return `0x${"ab".repeat(32)}` as T;
          if (method === "chain_getHeader") return { number: "0x10", parentHash: `0x${"CD".repeat(32)}` } as T;
          return null as T;
        },
      },
      40,
    );
    const [, , , , parent] = await Promise.all([node.blockHash(1), node.blockHash(2), node.storage(Uint8Array.of(1), "0x00"), node.metadata("0x00"), node.parentHash("0x02")]);
    assert.equal(parent, `0x${"cd".repeat(32)}`, "the header's parent hash");
    await node.metadata("0x01");
    assert.equal(methods.filter((m) => m === "state_getMetadata").length, 1);
    for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 35, `request ${i} came ${times[i] - times[i - 1]} ms after the one before`);
    assert.equal(node.requests(), methods.length);
  });
});
