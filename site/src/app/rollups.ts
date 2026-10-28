// The V3 light client on the rollups of ./dests.ts, read live for the Network page: its set, its
// latest header, its threshold and pause flags (../lib/lc-read.ts), every 30 s while the page is open
// and the tab visible. A failed read follows the rule of every other card (../lib/field.ts): the last
// live answer stays, else the records' latest import shows as Recorded, else "Could not read".

import { records } from "../lib/chains.ts";
import { nextField, type Field } from "../lib/field.ts";
import { readClient, recordedClient, searchImport, type ClientState } from "../lib/lc-read.ts";
import { request } from "../lib/rpc.ts";
import { ROLLUPS, destOf, type Dest } from "./dests.ts";
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
