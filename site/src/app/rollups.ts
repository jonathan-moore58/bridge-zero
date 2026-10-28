// The V3 light client on the rollups of ./dests.ts, read live for the Network page and for the
// status of a page about a rollup (net.ts, App.tsx): its set, its latest header, its threshold and
// pause flags (../lib/lc-read.ts), every 30 s while the page is open and the tab visible. And the
// bridge there, for the Network page's vault card: wtPOT's supply on each rollup, its minter's
// burns and those the vault has not released. A failed read follows the rule of every other card
// (../lib/field.ts): the last live answer stays, else the records' value shows as Recorded, else
// "Could not read".

import { decode, encodeCall } from "../lib/abi.ts";
import { V3_EVM, VAULT, records } from "../lib/chains.ts";
import { nextField, type Field, type Recorded } from "../lib/field.ts";
import type { Hex } from "../lib/hex.ts";
import { readClient, recordedClient, searchImport, type ClientState } from "../lib/lc-read.ts";
import { burnId } from "../lib/proofs.ts";
import { request } from "../lib/rpc.ts";
import { ROLLUPS, deployed, destOf, type Dest } from "./dests.ts";
import { Box, useBox } from "./store.ts";

export type RollupKey = "base-sepolia" | "arbitrum-sepolia";

/** V3's validator set has had 2 keys since the rollup clients' checkpoint (set 59): the recorded threshold is theirs. */
const V3_KEYS = records.lightClients.v3.fixtureSet.keys.length;

const recorded = (key: RollupKey) => recordedClient(records.rollups[key], V3_KEYS);

/** Until the first read answers, a field is loading and holds the recorded value (the card waits instead of showing it unlabelled), as ../lib/live.ts does. */
const boxes = new Map<RollupKey, Box<Field<ClientState>>>();

function boxOf(key: RollupKey): Box<Field<ClientState>> {
  let b = boxes.get(key);
  if (!b) {
    const rec = recorded(key);
    b = new Box<Field<ClientState>>({ status: "loading", value: rec?.value, from: rec?.from });
    boxes.set(key, b);
  }
  return b;
}

async function readOne(d: Dest, key: RollupKey): Promise<void> {
  const b = boxOf(key);
  b.set(await nextField(b.get(), () => readClient([...d.rpcs], d.lightClient), recorded(key)));
}

let lastRead = 0;

function readAll(): Promise<unknown> {
  lastRead = Date.now();
  return Promise.allSettled(ROLLUPS.map((d) => readOne(d, d.key)));
}

/** Reads every rollup client now unless it was read in the last 30 s, then every 30 s while the tab is visible; the returned function stops it. */
export function watchRollups(): () => void {
  if (Date.now() - lastRead > 30_000) void readAll();
  const t = setInterval(() => {
    if (!document.hidden) void readAll();
  }, 30_000);
  return () => clearInterval(t);
}

export const useRollup = (key: RollupKey): Field<ClientState> => useBox(boxOf(key));

// ---------------------------------------------------------------------------------------------
// When the client's latest block was imported

export interface RollupImport {
  /** ms */
  at: number;
  what: string;
  /** The import's transaction, for the explorer link, and its rollup block. */
  tx: string | null;
  block: number | null;
}

/** A set change when the set after the import is newer than the one that signed it; else the finalized head. */
function what(setBefore: number | bigint, setAfter: number | bigint): string {
  const a = BigInt(setBefore);
  const b = BigInt(setAfter);
  return b > a ? `set change ${a} → ${b}` : "finalized head";
}

/** The import of `hash` as the relayer's records hold it. */
export function recordedImport(key: RollupKey, hash: string): RollupImport | null {
  const e = records.rollups[key]?.imports.find((x) => x.hash === hash.toLowerCase());
  return e ? { at: Date.parse(e.settledAt ?? ""), what: what(e.setBefore, e.setAfter), tx: e.txHash, block: e.block } : null;
}

/** A lookup that searched as far back as it goes without finding the import: it is older than `at` (ms; null when that block's time could not be read). */
export interface OlderImport {
  before: number | null;
  block: number;
}

export type ImportLookup = RollupImport | OlderImport | "failed";

const lookups = new Map<string, Promise<ImportLookup>>();

/**
 * A block newer than the records: its HeaderImported log on the rollup, searched back from the
 * rollup's head to the relayer's newest recorded import (else the client's deployment), newest first,
 * in as many calls as the nodes need (../lib/lc-read.ts, searchImport). An answer is kept for the
 * page load; a failure is not, so the next read of the client (every 30 s) looks again.
 */
export function lookImport(key: RollupKey, c: ClientState): Promise<ImportLookup> {
  const id = `${key}:${c.latestHash.toLowerCase()}`;
  const known = lookups.get(id);
  if (known) return known;
  const d = destOf(key);
  const facts = records.rollups[key];
  const p = (async (): Promise<ImportLookup> => {
    try {
      const head = Number(BigInt((await request<string>([...d.rpcs], "eth_blockNumber", [])).result));
      const from = facts?.latestImport?.block ?? facts?.deployBlock ?? 0;
      const r = await searchImport([...d.rpcs], d.lightClient, c.latestHash, from, head);
      if ("before" in r) return { before: r.before.at, block: r.before.block };
      return { at: r.found.at, what: what(r.found.signedBy, c.setId), tx: r.found.tx, block: r.found.block };
    } catch {
      lookups.delete(id);
      return "failed";
    }
  })();
  lookups.set(id, p);
  return p;
}

// ---------------------------------------------------------------------------------------------
// wtPOT and the burns on each rollup: one vault backs wtPOT on every chain, so the Network page
// sets its outstanding against the supply on all three, and counts the burns waiting on each

/** wtPOT's totalSupply() on a rollup, its BridgeMinter's burnCount(), and how many of those the vault has not released (null when that could not be read). */
export interface RollupSupply {
  supply: bigint;
  burns: number;
  waiting: number | null;
}

/** The burn ids released(burnId) answered true for: each is read until it is released, then not again. */
const releasedIds = new Set<string>(records.returnPath.releases.filter((r) => r.status === "released" && r.burnId).map((r) => r.burnId as string));

/** The records' supply on a rollup: auto-mint's mints there less its recorded burns, and those of the burns no release names. */
function recordedSupply(key: RollupKey): Recorded<RollupSupply> | null {
  const r = records.rollupRuns[key];
  if (!r) return null;
  const minted = r.mints.reduce((n, m) => n + BigInt(m.amountNative ?? "0"), 0n);
  const burns = r.burns.filter((b) => b.ok === true && b.status === 1);
  const burned = burns.reduce((n, b) => n + BigInt(b.amount), 0n);
  const from = [r.from, ...new Set(r.mints.map((m) => m.from))].join(" and ");
  return { value: { supply: minted - burned, burns: burns.length, waiting: burns.filter((b) => !b.burnId || !releasedIds.has(b.burnId)).length }, from };
}

async function readSupply(d: Dest): Promise<{ value: RollupSupply; endpoint: string }> {
  const { minter, token } = deployed(d);
  const call = (to: Hex, data: Hex) => request<Hex>([...d.rpcs], "eth_call", [{ to, data }, "latest"]);
  const [supply, count] = await Promise.all([call(token, encodeCall("totalSupply()")), call(minter, encodeCall("burnCount()"))]);
  const burns = Number(decode("uint256", count.result)[0] as bigint);
  // burnIdOf(n) as BridgeMinter derives it, with this chain's id, recomputed here rather than asked for.
  const open = Array.from({ length: burns }, (_, n) => burnId(BigInt(d.chainId), minter, BigInt(n))).filter((id) => !releasedIds.has(id));
  let waiting: number | null = 0;
  try {
    const answers = await Promise.all(open.map((id) => request<Hex>(V3_EVM, "eth_call", [{ to: VAULT, data: encodeCall("released(bytes32)", [id]) }, "latest"])));
    answers.forEach((a, i) => {
      if (decode("bool", a.result)[0] === true) releasedIds.add(open[i] ?? "");
    });
    waiting = open.filter((id) => !releasedIds.has(id)).length;
  } catch {
    waiting = null;
  }
  return { value: { supply: decode("uint256", supply.result)[0] as bigint, burns, waiting }, endpoint: supply.endpoint.label };
}

const supplies = new Map<RollupKey, Box<Field<RollupSupply>>>();

function supplyOf(key: RollupKey): Box<Field<RollupSupply>> {
  let b = supplies.get(key);
  if (!b) {
    const rec = recordedSupply(key);
    b = new Box<Field<RollupSupply>>({ status: "loading", value: rec?.value, from: rec?.from });
    supplies.set(key, b);
  }
  return b;
}

async function readSupplyOf(d: Dest, key: RollupKey): Promise<void> {
  const b = supplyOf(key);
  b.set(await nextField(b.get(), () => readSupply(d), recordedSupply(key)));
}

/** Reads each rollup's wtPOT and burns now, then every minute while the tab is visible: the Network page's, while it is open. */
export function watchSupplies(): () => void {
  const all = () => Promise.allSettled(ROLLUPS.map((d) => readSupplyOf(d, d.key)));
  void all();
  const t = setInterval(() => {
    if (!document.hidden) void all();
  }, 60_000);
  return () => clearInterval(t);
}

export const useRollupSupply = (key: RollupKey): Field<RollupSupply> => useBox(supplyOf(key));
