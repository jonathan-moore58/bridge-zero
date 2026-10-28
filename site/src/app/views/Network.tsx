// Network: the light clients every mint rests on, the relayer that keeps them current, the release
// watcher and the committee that run the way back, the vault against wtPOT's supply, and the
// contracts. Read live where a chain answers, recorded where only the records hold a value: each
// card says which, and when.

import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { decode, encodeCall } from "../../lib/abi.ts";
import { DECIMALS, LC, MINTER, REPO, SEPOLIA_CHAIN_ID, SEPOLIA_LOGS, TOKEN, V3_EVM, VAULT, etherscanAddress, records, repoFile } from "../../lib/chains.ts";
import { checksum } from "../../lib/display.ts";
import { eventTopic, keccak256 } from "../../lib/hashes.ts";
import { bytesToHex, type Hex } from "../../lib/hex.ts";
import { lagMinutes, setsBehind, type ClientState } from "../../lib/lc-read.ts";
import { registry, useField, type ChainHead, type Field, type LcState } from "../../lib/live.ts";
import { burnId } from "../../lib/proofs.ts";
import { request } from "../../lib/rpc.ts";
import { ROLLUPS, destOf, destState, type Dest } from "../dests.ts";
import { FAST_CAP, IMPORT_GAS, LATER_CHAINS, SPEED_NAME, V3_SCAN, timeOf } from "../facts.ts";
import { RELAY_AFTER_CHANGE_MS, SET_CHANGES_TEXT } from "../handoff.ts";
import { ChainMark } from "../marks.tsx";
import type { NetState } from "../net.ts";
import {
  lookImport as lookRollupImport,
  recordedImport as recordedRollupImport,
  useRollup,
  useRollupSupply,
  watchRollups,
  watchSupplies,
  type ImportLookup,
  type RollupKey,
  type RollupSupply,
} from "../rollups.ts";
import { Addr, Chip, Icon, fmt, num, short } from "../ui.tsx";
import { RUNS, clockUtc, dayTime, qty, runTitle, sepoliaTime, tok, type RawLog, type Run } from "./Activity.tsx";

type ClientKey = "v3" | "mainnet";
type Dot = "verify" | "trust" | "revert" | "muted";

/** The relayer imports V3's head every 600 blocks, about an hour (README, the relayer's watch mode; relayer/src/relay.ts, CHAINS.v3.headEvery). */
const HEAD_EVERY_V3 = 600;
/** While the relayer runs, each client is at most about 70 min behind its chain (README, the relayer's watch mode). */
const LAG_CEILING = 70;
// As contracts/src/grandpa/GrandpaLightClient.sol declares it; its setId is the set that signed.
const HEADER_IMPORTED = eventTopic("HeaderImported(bytes32,uint32,bytes32,uint64,uint256)");

const RP = records.returnPath;

/** "18:42", UTC, for the topology's values. */
const hm = (ms: number): string => clockUtc(ms).replace(/ UTC$/, "");

/** "18:09 UTC" on `ref`'s day (today by default), "Oct 24, 18:09 UTC" on another. */
function stamp(ms: number, ref = Date.now()): string {
  if (!Number.isFinite(ms)) return "";
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  return Number.isFinite(ref) && day(ms) === day(ref) ? clockUtc(ms) : `${dayTime(ms)} UTC`;
}

function andList(items: string[]): string {
  if (items.length < 2) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`;
}

// ---------------------------------------------------------------------------------------------
// The records' moments

interface Moment {
  at: number;
  what: string;
  block: number | null;
}

/** The records' last event: what the recorded vault and supply are "after". */
function lastMoment(): Moment {
  let best: Moment = { at: Number.NEGATIVE_INFINITY, what: "", block: null };
  for (const r of RUNS) {
    // "lock 1", "burn 0 on Arbitrum Sepolia".
    const title = runTitle(r);
    const what = `${title.charAt(0).toLowerCase()}${title.slice(1)}`;
    if (r.at > best.at) best = { at: r.at, what, block: null };
    if (r.release && r.release.at > best.at) best = { at: r.release.at, what, block: r.release.block };
  }
  return best;
}

const LAST = lastMoment();
const AFTER_LAST = Number.isFinite(LAST.at) ? `Recorded · as of ${dayTime(LAST.at)} UTC, after ${LAST.what}` : "Recorded";

/** The relayer's latest recorded run, of either client. */
const RELAY_AT = Math.max(Number.NEGATIVE_INFINITY, ...(["v3", "mainnet"] as const).map((k) => Date.parse(records.relayRuns[k]?.settledAt ?? "")).filter((t) => Number.isFinite(t)));

/** The committee's releases in the records, the newest first. */
const RELEASES = RUNS.flatMap((r) => (r.release ? [{ run: r, block: r.release.block, at: r.release.at }] : [])).sort((x, y) => y.block - x.block);

/**
 * The committee's tPOT on V3 after burn 1 (Oct 24): derived from the records, not read (the
 * prototype's data.js, committee). Each member's funding less the fees of its two approvals
 * (deployments/v3-testnet.json, committeeFunding and releases); the multisig's 16.1585 tPOT
 * (docs/V3.md) less burn 1's 3.8415 tPOT storage deposit (README rows 51 and 58).
 */
const MULTISIG_TPOT = 12.317;
const MEMBER_TPOT: Record<string, { bal: string; note: string }> = {
  "5DLnLMAsR3kkHnHndC4eRWhMFXPjCU8bGiSugCjUmGJaBism": { bal: "9.934", note: "opens a release" },
  "5F99Y91UgQ4EDTubPWWPvWKc3ghhVA77nc7HjRhsTyXn38z9": { bal: "0.933", note: "runs it" },
  "5EJJYKuM5aaKwgegKGinAbnL7dK3m3QziyqusPotTQ3S7w1E": { bal: "0", note: "not funded" },
};
/** The storage deposit each release leaves: 0.06 × 64 + 0.0015 tPOT (docs/V3.md, Costs). */
const DEPOSIT_PER_RELEASE = 3.8415;
/** The moment those balances describe: burn 1's release, by the records. */
const BALANCES_AT = RUNS.find((r) => r.id === "burn-1")?.release?.at ?? Number.NaN;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * The 20-byte address pallet-revive maps a Portaldot account to: keccak256 of its 32-byte id, the
 * last 20 bytes. The V3 EVM RPC answers eth_getBalance for it with the account's spendable tPOT
 * (its free balance less the 0.1 tPOT existential deposit), so the page reads the committee's
 * balances without a Substrate client. Checked against System.Account for all four on Oct 25.
 */
function mappedAddress(ss58Address: string): string {
  let n = 0n;
  for (const ch of ss58Address) {
    const v = B58.indexOf(ch);
    if (v < 0) throw new RangeError(`not an SS58 address: ${ss58Address}`);
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  // One prefix byte (42), the 32-byte id, a two-byte checksum.
  if (bytes.length !== 35) throw new RangeError(`not a one-byte-prefix SS58 address: ${ss58Address}`);
  return bytesToHex(keccak256(Uint8Array.from(bytes.slice(1, 33))).subarray(12));
}

interface Spendable {
  state: "loading" | "live" | "error";
  at: number | null;
  /** tPOT each account can spend, by its SS58 address. */
  tpot: Record<string, number>;
}

/** The committee's spendable tPOT, read live from V3 every minute while the page is open. */
function useCommitteeBalances(accounts: string[]): Spendable {
  const [s, setS] = useState<Spendable>({ state: "loading", at: null, tpot: {} });
  const key = accounts.join(",");
  useEffect(() => {
    let live = true;
    const read = async () => {
      try {
        const values = await Promise.all(
          accounts.map((a) => request<string>(V3_EVM, "eth_getBalance", [mappedAddress(a), "latest"]).then((r) => Number(BigInt(r.result) / 10_000n) / 10 ** DECIMALS)),
        );
        if (live) setS({ state: "live", at: Date.now(), tpot: Object.fromEntries(accounts.map((a, i) => [a, values[i] ?? 0])) });
      } catch {
        // A failed read keeps the last answer; with none yet, the card falls back to the records.
        if (live) setS((p) => (p.state === "live" ? p : { ...p, state: "error" }));
      }
    };
    void read();
    const t = setInterval(() => {
      if (!document.hidden) void read();
    }, 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [key]);
  return s;
}

/** Linea Sepolia is not one of them: its sequencer refuses BLAKE2F (the README's Roadmap). */
const LATER_NOTE =
  "Each passed a full simulated run on Oct 24: deploy, import, proof and a tampered proof. Linea Sepolia comes later: its sequencer refuses the BLAKE2F precompile, so it needs blake2b in Solidity.";

const V3_KEYS = LC.v3.fixtureSet.keys.length;
const V3_THRESHOLD = V3_KEYS - Math.floor((V3_KEYS - 1) / 3);

interface ContractFact {
  name: string;
  chain: "v3" | "sepolia";
  where: string;
  address: string;
  role: string;
}

/** The four contracts a transfer touches: the addresses from the records, the words from the prototype (data.js, contracts). */
const CONTRACTS: ContractFact[] = [
  { name: "PortaldotVault", chain: "v3", where: "Portaldot V3 testnet", address: VAULT, role: "Holds locked tPOT. Only the committee can release." },
  { name: "BridgeMinter", chain: "sepolia", where: "Ethereum Sepolia", address: MINTER, role: "Proves each lock, then mints. No owner, no admin." },
  { name: "wtPOT", chain: "sepolia", where: "Ethereum Sepolia", address: TOKEN, role: `WrappedTPOT, ${DECIMALS} decimals. BridgeMinter is its only minter.` },
  { name: "GrandpaLightClient", chain: "sepolia", where: "V3 client, on Sepolia", address: LC.v3.address, role: `Follows V3's GRANDPA finality, ${V3_THRESHOLD} of ${V3_KEYS} signatures.` },
];

// ---------------------------------------------------------------------------------------------
// Live reads this page adds to the shared ones

interface Imported {
  at: number;
  what: string;
}

/** The import of a client's block as the records hold it: the relayer's, or a mint's. */
function recordedImport(key: ClientKey, hash: string): Imported | null {
  const of = records.relay.entries.filter((x) => x.chain === key && x.block.hash.toLowerCase() === hash);
  // A block sent twice (a replaced transaction) has one entry that landed.
  const e = of.find((x) => x.ok === true) ?? of[0];
  if (e) return { at: Date.parse(e.settledAt ?? ""), what: e.setAfter !== e.setBefore ? `set change ${e.setBefore} → ${e.setAfter}` : "finalized head" };
  const run = records.latestRun;
  if (key === "v3" && run && run.bundle.block.hash === hash) return { at: Date.parse(run.mint.signedAt ?? ""), what: `by lock ${run.lock.nonce}'s mint` };
  if (key === "v3" && records.bridge.finality.block.hash === hash) return { at: Date.parse(records.bridge.mint.signedAt ?? ""), what: "by lock 0's mint" };
  return null;
}

/** A block newer than the records: its HeaderImported log on Sepolia, and that block's time. */
async function findImport(key: ClientKey, lc: LcState): Promise<Imported> {
  const facts = LC[key];
  // Imported after the relayer's latest recorded run, so the search starts there.
  const from = facts.latestRelay?.sepoliaBlock ?? facts.deployBlock;
  const a = await request<RawLog[]>(SEPOLIA_LOGS, "eth_getLogs", [{ address: facts.address, topics: [HEADER_IMPORTED, lc.latestHash], fromBlock: qty(from), toBlock: "latest" }], {
    accept: (r) => Array.isArray(r) && r.length > 0,
    timeoutMs: 12000,
    retries: 0,
  });
  const log = a.result.at(-1);
  if (!log) throw new Error("no HeaderImported log for the client's latest block");
  const signed = registry.decodeLog(log)?.args.find((x) => x.name === "setId")?.value;
  const what = typeof signed === "bigint" && lc.setId > signed ? `set change ${signed} → ${lc.setId}` : "finalized head";
  const at = log.blockTimestamp ? Number(BigInt(log.blockTimestamp)) * 1000 : await sepoliaTime(Number(BigInt(log.blockNumber)));
  return { at, what };
}

interface Lookup {
  done: Imported | "failed" | null;
  wait: Promise<void>;
}

/** Live lookups by block hash, once per page load. */
const lookups = new Map<string, Lookup>();

function lookImport(key: ClientKey, lc: LcState): Lookup {
  const hash = lc.latestHash.toLowerCase();
  const known = lookups.get(hash);
  if (known) return known;
  const l: Lookup = { done: null, wait: Promise.resolve() };
  l.wait = findImport(key, lc).then(
    (v) => {
      l.done = v;
    },
    () => {
      l.done = "failed";
    },
  );
  lookups.set(hash, l);
  return l;
}

/** When and how the client's latest block was imported: from the records, or looked up live. */
function useImport(key: ClientKey, lc: Field<LcState>): Imported | "reading" | "failed" | null {
  const v = lc.value;
  const hash = v ? v.latestHash.toLowerCase() : "";
  const rec = hash ? recordedImport(key, hash) : null;
  const need = !!v && !rec && lc.status === "live";
  const [, bump] = useState(0);
  useEffect(() => {
    if (!need || !v) return;
    let alive = true;
    void lookImport(key, v).wait.then(() => {
      if (alive) bump((n) => n + 1);
    });
    return () => {
      alive = false;
    };
  }, [hash, need]);
  if (rec) return rec;
  if (!need) return null;
  return lookups.get(hash)?.done ?? "reading";
}

interface Waiting {
  /** Burns the vault has not released yet, on Sepolia (useWaiting) or on every chain (withRollups); null when that is not known. */
  count: number | null;
  reading: boolean;
  live: boolean;
  at: number | null;
}

/** Burns newer than the records, by burn nonce: released(burnIdOf(n)) on the vault. */
const newerReleased = new Map<string, boolean | "failed">();

async function readNewer(nonces: string[]): Promise<void> {
  await Promise.all(
    nonces.map(async (n) => {
      try {
        // burnIdOf(n) as BridgeMinter derives it, recomputed here rather than asked for.
        const id = burnId(SEPOLIA_CHAIN_ID, MINTER, BigInt(n));
        const a = await request<Hex>(V3_EVM, "eth_call", [{ to: VAULT, data: encodeCall("released(bytes32)", [id]) }, "latest"]);
        newerReleased.set(n, decode("bool", a.result)[0] === true);
      } catch {
        newerReleased.set(n, "failed");
      }
    }),
  );
}

/** Burns waiting for a release: burnCount() against released(burnId), for the recorded burns and any newer. */
function useWaiting(): Waiting {
  const minter = useField("sepolia.minter");
  const checks = useField("return.checks");
  const [, bump] = useState(0);
  const total = minter.value?.burnCount;
  const known = checks.value ?? [];
  const newer: string[] = [];
  if (total !== undefined) for (let n = 0n; n < total; n++) if (!known.some((c) => c.burnNonce === String(n))) newer.push(String(n));
  const live = minter.status === "live" && checks.status === "live";
  // Read again with each refresh of burnCount: a waiting burn turns released.
  const key = `${live ? (minter.at ?? 0) : 0}:${newer.join(",")}`;
  useEffect(() => {
    if (!live || !newer.length) return;
    let alive = true;
    void readNewer(newer).then(() => {
      if (alive) bump((x) => x + 1);
    });
    return () => {
      alive = false;
    };
  }, [key]);
  // While a field is read, the store hands back its recorded value: not a count to show as read. (The
  // checks have no recorded value, and are never read, when the records hold no burn.)
  const pending = minter.status === "loading" || (checks.status === "loading" && checks.value !== undefined);
  if (pending) return { count: null, reading: true, live: false, at: null };
  if (total === undefined) return { count: null, reading: false, live: false, at: null };
  const states = newer.map((n) => newerReleased.get(n));
  // A newer burn is read once both fields are live: while its answer is out, it is being read, not unreadable.
  const reading = live && states.some((s) => s === undefined);
  const unknown = known.some((c) => c.released === null) || states.some((s) => s === "failed" || s === undefined);
  const count = known.filter((c) => c.released === false).length + states.filter((s) => s === false).length;
  return { count: unknown ? null : count, reading, live, at: live ? Math.min(minter.at ?? Date.now(), checks.at ?? Date.now()) : null };
}

/**
 * The burns waiting on every chain: Sepolia's (useWaiting) and each rollup's (rollups.ts), counted
 * only when each is known, and live only when every one was read live.
 */
function withRollups(w: Waiting, rollups: readonly Field<RollupSupply>[]): Waiting {
  const each = rollups.map((r) => (r.status === "loading" ? undefined : r.value?.waiting));
  const live = w.live && rollups.every((r) => r.status === "live");
  const unknown = w.count === null || each.some((x) => x === undefined || x === null);
  return {
    count: unknown ? null : (w.count ?? 0) + each.reduce<number>((n, x) => n + (x ?? 0), 0),
    reading: w.reading || rollups.some((r) => r.status === "loading"),
    live,
    at: live ? Math.min(w.at ?? Date.now(), ...rollups.map((r) => r.at ?? Date.now())) : null,
  };
}

function usePhone(): boolean {
  const query = "(max-width: 640px)";
  const [phone, setPhone] = useState(() => typeof matchMedia === "function" && matchMedia(query).matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const m = matchMedia(query);
    const on = () => setPhone(m.matches);
    m.addEventListener("change", on);
    on();
    return () => m.removeEventListener("change", on);
  }, []);
  return phone;
}

// ---------------------------------------------------------------------------------------------
// The light clients

/** Minutes the client is behind its chain's finalized head (`blockTimeSec` a block), when both were read live. */
function lagOf(blockTimeSec: number, lc: Field<{ latestNumber: number }>, chain: Field<ChainHead>): number | null {
  const c = lc.value;
  const h = chain.value;
  if (lc.status !== "live" || chain.status !== "live" || !c || !h) return null;
  return lagMinutes(c.latestNumber, h.number, blockTimeSec);
}

/** Validator-set changes the chain made that the client has not imported, when both were read live. */
function behindOf(lc: Field<{ setId: bigint }>, chain: Field<ChainHead>): number {
  const c = lc.value;
  const h = chain.value;
  if (lc.status !== "live" || chain.status !== "live" || !c || !h) return 0;
  return setsBehind(c.setId, h.setId);
}

function lcAsOf(key: ClientKey, lc: Field<LcState>, chain: Field<ChainHead>): string {
  const name = key === "v3" ? "Portaldot V3" : "the old mainnet";
  if (lc.status === "live") {
    const at = chain.status === "live" ? Math.min(lc.at ?? Date.now(), chain.at ?? Date.now()) : (lc.at ?? Date.now());
    if (chain.status === "error") return `Live · as of ${clockUtc(at)} · ${name} did not answer`;
    if (chain.status === "loading") return `Live · as of ${clockUtc(at)} · reading ${name}`;
    return `Live · as of ${clockUtc(at)}`;
  }
  if (lc.status === "recorded") {
    const rec = lc.value ? recordedImport(key, lc.value.latestHash.toLowerCase()) : null;
    return rec && Number.isFinite(rec.at) ? `Recorded · as of ${dayTime(rec.at)} UTC` : "Recorded";
  }
  return lc.status === "loading" ? "Reading Sepolia" : "Could not read";
}

/**
 * The lag on a 70-min scale; its width is a runtime CSS variable, set through the CSSOM. `ceiling`:
 * the relayer's 70-min ceiling, named and turning the bar amber past it, where the relayer runs in
 * watch mode (Sepolia's clients); null where nothing keeps the client within one (the rollups'), and
 * the bar is neutral.
 */
function Meter({ lag, ceiling = LAG_CEILING }: { lag: number | null; ceiling?: number | null }) {
  const fill = useRef<HTMLSpanElement>(null);
  const pct = lag === null ? 0 : Math.min(100, Math.round((lag / LAG_CEILING) * 100));
  useLayoutEffect(() => {
    fill.current?.style.setProperty("--fill", `${pct}%`);
  }, [pct]);
  return (
    <div class={`meter${ceiling === null ? " meter--plain" : lag !== null && lag > ceiling ? " is-over" : ""}`}>
      <span class="meter__fill" ref={fill} />
      {ceiling === null ? null : <span class="meter__cap">{ceiling} min</span>}
    </div>
  );
}

function LcCard({ which, quiet = false }: { which: ClientKey; quiet?: boolean }) {
  const facts = LC[which];
  const lc = useField(which === "v3" ? "lc.v3" : "lc.mainnet");
  const chain = useField(which === "v3" ? "chain.v3" : "chain.mainnet");
  const set = useField(which === "v3" ? "set.v3" : "set.mainnet");
  const imp = useImport(which, lc);
  // While the client is being read, the store hands back its recorded value: shown, it would sit
  // unlabelled under "Reading Sepolia", so the cells wait instead.
  const reading = lc.status === "loading";
  const c = reading ? undefined : lc.value;
  const h = chain.value;
  const lag = lagOf(LC[which].blockTimeSec, lc, chain);
  const behind = behindOf(lc, chain);
  const inStep = lc.status === "live" && chain.status === "live" && !!c && !!h && h.setId === c.setId;
  // The set's keys likewise: the client's threshold is live before its set has been read.
  const keys = set.status === "loading" ? null : (set.value?.keys.length ?? facts.fixtureSet.keys.length);
  const wait = <span class="skel" />;
  const id = which === "v3" ? "lc-v3" : "lc-main";

  // A card carries a badge only when its state is not fine.
  let flag: ComponentChildren = null;
  if (lc.status === "recorded") {
    flag = (
      <Chip kind="muted badge--sm" icon="i-server">
        Recorded
      </Chip>
    );
  } else if (lc.status === "error" || chain.status === "error") {
    flag = (
      <Chip kind="muted badge--sm" icon="i-server">
        Could not read
      </Chip>
    );
  } else if (behind > 0) {
    flag = (
      <Chip kind="trusted badge--sm" icon="i-refresh">
        Relay due
      </Chip>
    );
  } else if (c?.halted || c?.paused) {
    flag = (
      <Chip kind="revert badge--sm" icon="i-alert">
        {c.halted ? "Halted" : "Paused"}
      </Chip>
    );
  }

  return (
    <article class={`card ncard ncard--lc${quiet ? " ncard--quiet" : ""}`} aria-labelledby={id}>
      <header class="ncard__head">
        <ChainMark mark="portaldot" cls="mark--32" />
        <div class="ncard__titles">
          <h2 class="ncard__title" id={id}>
            {facts.chain}
          </h2>
          <p class="ncard__sub">
            {quiet ? (
              "The first client, following Portaldot's original chain. Not used by these transfers."
            ) : (
              <>
                Light client on Sepolia · <span class="mono">{short(checksum(facts.address))}</span> · used by every mint
              </>
            )}
          </p>
          <span class="ncard__asof">{lcAsOf(which, lc, chain)}</span>
        </div>
        {flag}
      </header>
      <div class="lag">
        <div class="lag__num">
          <span class="lag__big">
            {lag === null ? (
              reading || chain.status === "loading" ? (
                wait
              ) : (
                "—"
              )
            ) : (
              <>
                {lag}
                <span class="unit">min</span>
              </>
            )}
          </span>
          <span class="lag__label">behind Portaldot's finalized head</span>
        </div>
        <Meter lag={lag} />
      </div>
      <dl class="ncard__grid">
        <div>
          <dt>Client head</dt>
          <dd class="mono">{c ? `#${num(c.latestNumber)}` : reading ? wait : "—"}</dd>
        </div>
        <div>
          <dt>Portaldot finalized</dt>
          <dd class="mono">{h ? `#${num(h.number)}` : chain.status === "loading" ? wait : "—"}</dd>
        </div>
        <div>
          <dt>Validator set</dt>
          <dd>
            {!c ? (
              reading ? (
                wait
              ) : (
                "—"
              )
            ) : behind > 0 && h && h.setId !== null ? (
              <>
                <span class="mono">{String(c.setId)}</span> of <span class="mono">{String(h.setId)}</span> <span class="tag tag--trust">{behind} to import</span>
              </>
            ) : inStep ? (
              <>
                <span class="mono">{String(c.setId)}</span>{" "}
                <span class="tag tag--verify">
                  <Icon id="i-check" cls="i--12" />
                  in step
                </span>
              </>
            ) : (
              <span class="mono">{String(c.setId)}</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Signatures needed</dt>
          <dd>{c && keys !== null ? `${c.threshold} of ${keys}` : reading || (c && keys === null) ? wait : "—"}</dd>
        </div>
        <div>
          <dt>Last import</dt>
          <dd>
            {reading || imp === "reading" ? (
              wait
            ) : imp === null ? (
              "—"
            ) : imp === "failed" ? (
              "Could not read"
            ) : (
              <>
                {Number.isFinite(imp.at) ? stamp(imp.at) : "—"} <span class="dim">· {imp.what}</span>
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>Paused</dt>
          <dd>{c?.halted ? <span class="tag tag--revert">Halted</span> : c?.paused ? <span class="tag tag--revert">Yes · by its admin</span> : c?.paused === false ? "No" : reading ? wait : "—"}</dd>
        </div>
        {quiet ? (
          <div>
            <dt>Contract</dt>
            <dd>
              <Addr full={checksum(facts.address)} href={etherscanAddress(facts.address)} label="old mainnet light client address" />
            </dd>
          </div>
        ) : null}
      </dl>
    </article>
  );
}

// ---------------------------------------------------------------------------------------------
// The V3 light client on the rollups (../dests.ts): the same reads as Sepolia's, from each rollup's RPCs

/** A lag in minutes, or hours and minutes from two hours on: a client nobody relays to falls hours behind. */
function LagFigure({ lag }: { lag: number }) {
  if (lag < 120) {
    return (
      <>
        {lag}
        <span class="unit">min</span>
      </>
    );
  }
  const m = lag % 60;
  return (
    <>
      {Math.floor(lag / 60)}
      <span class="unit">h</span>
      {m ? (
        <>
          {" "}
          {m}
          <span class="unit">min</span>
        </>
      ) : null}
    </>
  );
}

/**
 * When and how a rollup client's latest block was imported: from the relayer's records, or looked up
 * on the rollup. A lookup that failed is made again with the client's next live read (every 30 s).
 */
function useRollupImport(key: RollupKey, lc: Field<ClientState>): ImportLookup | "reading" | null {
  const v = lc.value;
  const hash = v ? v.latestHash.toLowerCase() : "";
  const rec = hash ? recordedRollupImport(key, hash) : null;
  const need = !!v && !rec && lc.status === "live";
  const [found, setFound] = useState<{ hash: string; r: ImportLookup } | null>(null);
  const again = found && found.hash === hash && found.r === "failed" ? (lc.at ?? 0) : 0;
  useEffect(() => {
    if (!need || !v) return;
    let alive = true;
    void lookRollupImport(key, v).then((r) => {
      if (alive) setFound({ hash, r });
    });
    return () => {
      alive = false;
    };
  }, [hash, need, again]);
  if (rec) return rec;
  if (!need) return null;
  return found && found.hash === hash ? found.r : "reading";
}

function rollupAsOf(d: Dest & { key: RollupKey }, lc: Field<ClientState>, chain: Field<ChainHead>): string {
  if (lc.status === "live") {
    const at = chain.status === "live" ? Math.min(lc.at ?? Date.now(), chain.at ?? Date.now()) : (lc.at ?? Date.now());
    if (chain.status === "error") return `Live · as of ${clockUtc(at)} · Portaldot V3 did not answer`;
    if (chain.status === "loading") return `Live · as of ${clockUtc(at)} · reading Portaldot V3`;
    return `Live · as of ${clockUtc(at)}`;
  }
  if (lc.status === "recorded") {
    const rec = lc.value ? recordedRollupImport(d.key, lc.value.latestHash) : null;
    return rec && Number.isFinite(rec.at) ? `Recorded · as of ${dayTime(rec.at)} UTC` : "Recorded";
  }
  return lc.status === "loading" ? `Reading ${d.full}` : "Could not read";
}

/** A rollup's V3 light client, by the rules of Sepolia's card: live, else recorded, each value saying which. */
function RollupLcCard({ d }: { d: Dest & { key: RollupKey } }) {
  const lc = useRollup(d.key);
  const chain = useField("chain.v3");
  const imp = useRollupImport(d.key, lc);
  // As on Sepolia's card: while the client is being read, the cells wait instead of showing the recorded value unlabelled.
  const reading = lc.status === "loading";
  const c = reading ? undefined : lc.value;
  const h = chain.value;
  const lag = lagOf(LC.v3.blockTimeSec, lc, chain);
  const behind = behindOf(lc, chain);
  const inStep = lc.status === "live" && chain.status === "live" && !!c && !!h && h.setId === c.setId;
  const wait = <span class="skel" />;
  const id = `lc-${d.key}`;
  const scan = (a: string) => `${d.explorer.url}/address/${checksum(a)}`;

  // A card carries a badge only when its state is not fine.
  let flag: ComponentChildren = null;
  if (lc.status === "recorded") {
    flag = (
      <Chip kind="muted badge--sm" icon="i-server">
        Recorded
      </Chip>
    );
  } else if (lc.status === "error" || chain.status === "error") {
    flag = (
      <Chip kind="muted badge--sm" icon="i-server">
        Could not read
      </Chip>
    );
  } else if (behind > 0) {
    flag = (
      <Chip kind="trusted badge--sm" icon="i-refresh">
        Relay due
      </Chip>
    );
  } else if (c?.halted || c?.paused) {
    flag = (
      <Chip kind="revert badge--sm" icon="i-alert">
        {c.halted ? "Halted" : "Paused"}
      </Chip>
    );
  }

  const state = destState(d);
  return (
    <article class="card ncard ncard--lc ncard--rollup" aria-labelledby={id}>
      <header class="ncard__head">
        <ChainMark mark={d.mark} cls="mark--32" />
        <div class="ncard__titles">
          <h2 class="ncard__title" id={id}>
            {d.full}
          </h2>
          <p class="ncard__sub">
            Light client on {d.short} ·{" "}
            {state === "live" ? "used by its minter" : state === "ready" ? "minter deployed, not open in the app yet" : "no minter yet, bridging soon"}
          </p>
          <span class="ncard__asof">{rollupAsOf(d, lc, chain)}</span>
        </div>
        {flag}
      </header>
      <div class="lag">
        <div class="lag__num">
          <span class="lag__big">{lag === null ? reading || chain.status === "loading" ? wait : "—" : <LagFigure lag={lag} />}</span>
          <span class="lag__label">behind Portaldot's finalized head</span>
        </div>
        {/* The relayer keeps this client at V3's set, not its head within a ceiling: the bar is neutral, never a warning. */}
        <Meter lag={lag} ceiling={null} />
      </div>
      <dl class="ncard__grid">
        <div>
          <dt>Client head</dt>
          <dd class="mono">{c ? `#${num(c.latestNumber)}` : reading ? wait : "—"}</dd>
        </div>
        <div>
          <dt>Portaldot finalized</dt>
          <dd class="mono">{h ? `#${num(h.number)}` : chain.status === "loading" ? wait : "—"}</dd>
        </div>
        <div>
          <dt>Validator set</dt>
          <dd>
            {!c ? (
              reading ? (
                wait
              ) : (
                "—"
              )
            ) : behind > 0 && h && h.setId !== null ? (
              <>
                <span class="mono">{String(c.setId)}</span> of <span class="mono">{String(h.setId)}</span> <span class="tag tag--trust">{behind} to import</span>
              </>
            ) : inStep ? (
              <>
                <span class="mono">{String(c.setId)}</span>{" "}
                <span class="tag tag--verify">
                  <Icon id="i-check" cls="i--12" />
                  in step
                </span>
              </>
            ) : (
              <span class="mono">{String(c.setId)}</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Signatures needed</dt>
          <dd>{c ? (c.keys !== null ? `${c.threshold} of ${c.keys}` : String(c.threshold)) : reading ? wait : "—"}</dd>
        </div>
        <div>
          <dt>Last import</dt>
          <dd>
            {reading || imp === "reading" ? (
              wait
            ) : imp === null ? (
              "—"
            ) : imp === "failed" ? (
              "Could not read"
            ) : "before" in imp ? (
              // Searched back as far as a lookup goes (../../lib/lc-read.ts) without finding it.
              imp.before !== null ? (
                `Before ${stamp(imp.before)}`
              ) : (
                <>
                  Before block <span class="mono">#{num(imp.block)}</span>
                </>
              )
            ) : (
              <>
                {Number.isFinite(imp.at) ? stamp(imp.at) : "—"} <span class="dim">· {imp.what}</span>
                {imp.tx ? (
                  <>
                    {" "}
                    <a class="text-link" href={`${d.explorer.url}/tx/${imp.tx}`} target="_blank" rel="noopener" aria-label={`The import's transaction on ${d.explorer.name}`}>
                      tx
                    </a>
                  </>
                ) : null}
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>Paused</dt>
          <dd>{c?.halted ? <span class="tag tag--revert">Halted</span> : c?.paused ? <span class="tag tag--revert">Yes · by its admin</span> : c?.paused === false ? "No" : reading ? wait : "—"}</dd>
        </div>
        <div>
          <dt>V3 light client</dt>
          <dd>
            <Addr full={checksum(d.lightClient)} href={scan(d.lightClient)} label={`${d.full} V3 light client address`} />
          </dd>
        </div>
        <div>
          <dt>ProvenBalance</dt>
          <dd>
            <Addr full={checksum(d.provenBalance)} href={scan(d.provenBalance)} label={`${d.full} ProvenBalance address`} />
          </dd>
        </div>
        {d.minter && d.token ? (
          <>
            <div>
              <dt>BridgeMinter</dt>
              <dd>
                <Addr full={checksum(d.minter)} href={scan(d.minter)} label={`${d.full} BridgeMinter address`} />
              </dd>
            </div>
            <div>
              <dt>wtPOT</dt>
              <dd>
                <Addr full={checksum(d.token)} href={scan(d.token)} label={`${d.full} wtPOT address`} />
              </dd>
            </div>
          </>
        ) : null}
      </dl>
      <p class="ncard__note">
        <span>
          Kept at V3's validator set by one relayer run about {RELAY_AFTER_CHANGE_MS / 60_000} minutes after each set change ({SET_CHANGES_TEXT}); between runs, mints
          import V3's head themselves, so the head lag grows to hours. Its address is also the old mainnet's client's on Sepolia: another chain, another contract.
        </span>
      </p>
    </article>
  );
}

// ---------------------------------------------------------------------------------------------
// The topology: how the parts connect, with each one's state

function TopoNode({ icon, name, where, st, children }: { icon: ComponentChildren; name: ComponentChildren; where: string; st: Dot; children: ComponentChildren }) {
  return (
    <li class="topo__node">
      <span class="topo__icon">{icon}</span>
      <span class="topo__name">{name}</span>
      <span class="topo__where">{where}</span>
      <span class="topo__state">
        <span class={`topo__dot topo__dot--${st}`} aria-hidden="true" />
        <span class="topo__val">{children}</span>
      </span>
    </li>
  );
}

function TopoLink({ label }: { label: string }) {
  return (
    <li class="topo__link" aria-hidden="true">
      <span class="topo__label">{label}</span>
      <span class="topo__line" />
    </li>
  );
}

function Topo({ net }: { net: NetState }) {
  const lc = useField("lc.v3");
  const chain = useField("chain.v3");
  const token = useField("sepolia.token");
  // Until the chains answer, or when one does not, every state dot is grey.
  const quiet = net.key === "rpc" || net.key === "checking";
  const dot = (st: Dot): Dot => (quiet ? "muted" : st);
  const lcSt: Dot = net.key === "relay" ? "trust" : net.key === "paused" ? "revert" : "verify";
  const c = lc.value;
  const h = chain.value;
  const lag = lagOf(LC.v3.blockTimeSec, lc, chain);
  const last = RELEASES[0]?.run ?? null;
  const committee = RP.committee;
  return (
    <section class="card ncard ncard--wide topo" aria-labelledby="n-topo">
      <h2 class="visually-hidden" id="n-topo">
        How the parts connect
      </h2>
      <ol class="topo__row">
        <TopoNode icon={<ChainMark mark="portaldot" cls="mark--28" />} name="Portaldot V3" where="testnet" st={dot(h ? "verify" : "muted")}>
          {h ? (
            <>
              <span class="mono">#{num(h.number)}</span> at {hm(chain.at ?? Number.NaN)}
            </>
          ) : chain.status === "loading" ? (
            "reading"
          ) : (
            "not answering"
          )}
        </TopoNode>
        <TopoLink label="finality" />
        <TopoNode
          icon={
            <span class="topo__glyph">
              <Icon id="i-refresh" cls="i--16" />
            </span>
          }
          name="Relayer"
          where="watch mode"
          st={dot("verify")}
        >
          every 10 min
        </TopoNode>
        <TopoLink label="imports" />
        <TopoNode
          icon={<ChainMark mark="ethereum" cls="mark--28" />}
          name={
            <>
              Grandpa
              <wbr />
              LightClient
            </>
          }
          where="on Sepolia"
          st={dot(lcSt)}
        >
          {net.key === "relay" && c && h && h.setId !== null
            ? `set ${c.setId} of ${h.setId}`
            : net.key === "paused"
              ? c?.halted
                ? "halted"
                : "paused"
              : lag !== null
                ? `${lag} min behind`
                : "—"}
        </TopoNode>
        <TopoLink label="proves" />
        <TopoNode
          icon={
            <span class="topo__glyph">
              <Icon id="i-shield-check" cls="i--16" />
            </span>
          }
          name="BridgeMinter"
          where="on Sepolia"
          st={dot(lcSt)}
        >
          5 checks a mint
        </TopoNode>
        <TopoLink label="mints" />
        <TopoNode
          icon={
            <span class="topo__glyph">
              <Icon id="i-cube" cls="i--16" />
            </span>
          }
          name="wtPOT"
          where="on Sepolia"
          st={dot("verify")}
        >
          {/* Not the recorded supply while it is read; when it is recorded, said so. */}
          {token.status === "loading"
            ? "reading"
            : token.value
              ? `supply ${fmt(tok(token.value.totalSupply))}${token.status === "recorded" ? ", recorded" : ""}`
              : "supply —"}
        </TopoNode>
      </ol>
      <div class="topo__back">
        <span class="topo__backline" aria-hidden="true" />
        <div class="topo__backnode">
          <span class="topo__glyph topo__glyph--trust" aria-hidden="true">
            <Icon id="i-users" cls="i--16" />
          </span>
          <span class="topo__backtext">
            <span class="topo__name">
              Committee{" "}
              <span class="topo__soft">
                {committee.threshold}-of-{committee.members.length}
              </span>
            </span>
            <span class="topo__where">release watcher, a round every 15 s</span>
          </span>
          <span class="topo__state">
            <span class={`topo__dot topo__dot--${dot("trust")}`} aria-hidden="true" />
            <span class="topo__val">{last ? `last release: ${runTitle(last).replace(/^B/, "b")}${last.took ? `, ${last.took}` : ""}` : "no release recorded"}</span>
          </span>
        </div>
        <p class="topo__backlabel">
          <span>
            <strong>Way back · trusted:</strong> a burn on Sepolia, Base Sepolia or Arbitrum Sepolia, released on V3 by the committee
          </span>
        </p>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// The relayer and the release watcher

function RelayerCard() {
  return (
    <article class="card ncard" aria-labelledby="n-relayer">
      <header class="ncard__head">
        <span class="ncard__icon" aria-hidden="true">
          <Icon id="i-refresh" />
        </span>
        <div class="ncard__titles">
          <h2 class="ncard__title" id="n-relayer">
            Relayer
          </h2>
          <p class="ncard__sub">Watch mode · a run every 10 min, one key per chain</p>
          <span class="ncard__asof">{Number.isFinite(RELAY_AT) ? `Recorded · as of ${dayTime(RELAY_AT)} UTC` : "Recorded"}</span>
        </div>
      </header>
      <ul class="nlist">
        {(["v3", "mainnet"] as const).map((k) => {
          const run = records.relayRuns[k];
          const sender = run?.entries.at(-1)?.sender ?? null;
          const changes = run?.entries.filter((e) => e.setAfter !== e.setBefore) ?? [];
          const head = run?.entries.filter((e) => e.method === "importFinalityProof").at(-1) ?? null;
          const parts: string[] = [];
          const first = changes[0];
          const lastChange = changes.at(-1);
          if (first && lastChange) parts.push(`set change ${first.setBefore} → ${lastChange.setAfter}`);
          if (head) parts.push(`head #${num(head.block.number)}`);
          const who = k === "v3" ? "V3" : "old mainnet";
          return (
            <li key={k} class="nlist__row">
              <span class="nlist__k">{k === "v3" ? "V3 testnet" : "Old mainnet"}</span>
              <span class="nlist__v">
                {run?.settledAt ? (
                  <>
                    Last run {stamp(Date.parse(run.settledAt), RELAY_AT)}
                    {parts.length ? (
                      <>
                        {" "}
                        <span class="dim">· {parts.join(", ")}</span>
                      </>
                    ) : null}
                  </>
                ) : (
                  "No run recorded"
                )}
              </span>
              <span class="nlist__end">{sender ? <Addr full={checksum(sender)} href={etherscanAddress(sender)} label={`${who} relayer key`} /> : null}</span>
            </li>
          );
        })}
      </ul>
      <p class="ncard__note">
        A run imports every set change it finds, then the head every {num(HEAD_EVERY_V3)} blocks on V3. Each client stays at most about {LAG_CEILING} min behind while Sepolia's base fee is under the
        relayer's gates.
      </p>
    </article>
  );
}

/** Fast's confirmations on each chain, in its own blocks: "3 Sepolia, 180 Base Sepolia or 144 Arbitrum Sepolia blocks". */
const FAST_BLOCKS = (() => {
  const each = [destOf("sepolia"), ...ROLLUPS].map((d) => `${num(d.fastConfirmations)} ${d.short}`);
  return `${each.slice(0, -1).join(", ")} or ${each.at(-1) ?? ""} blocks`;
})();

function WatcherCard({ waiting }: { waiting: Waiting }) {
  const lastRelease = RELEASES[0]?.at ?? Number.NaN;
  const recordedTo = Number.isFinite(lastRelease) ? ` · releases recorded to ${dayTime(lastRelease)} UTC` : "";
  const asOf =
    waiting.live && waiting.at !== null ? `Waiting read live at ${clockUtc(waiting.at)}${recordedTo}` : waiting.reading ? `Reading Sepolia, the rollups and V3${recordedTo}` : AFTER_LAST;
  const n = waiting.count;
  return (
    <article class="card ncard" aria-labelledby="n-watch">
      <header class="ncard__head">
        <span class="ncard__icon ncard__icon--trust" aria-hidden="true">
          <Icon id="i-users" />
        </span>
        <div class="ncard__titles">
          <h2 class="ncard__title" id="n-watch">
            Release watcher
          </h2>
          <p class="ncard__sub">Runs the committee's two approvals on V3</p>
          <span class="ncard__asof">{asOf}</span>
        </div>
        <Chip kind="trusted badge--sm" icon="i-users">
          Trusted
        </Chip>
      </header>
      <ul class="nlist">
        <li class="nlist__row">
          <span class="nlist__k">
            <Icon id="i-bolt" cls="i--14" />
            Fast
          </span>
          <span class="nlist__v">
            A round every 15 s, on one machine{" "}
            <span class="dim">
              · releases after {FAST_BLOCKS} (36 s) · ≤ {FAST_CAP} tPOT per burn · ≤ {FAST_CAP} tPOT in flight before finality, across the three chains
            </span>
          </span>
          {/* Whether the watcher runs right now is not something this page can read: its settings, not its state. */}
          <span class="nlist__end">
            <span class="tag tag--verify">
              <Icon id="i-check" cls="i--12" />
              Enabled
            </span>
          </span>
        </li>
        <li class="nlist__row">
          <span class="nlist__k">
            <Icon id="i-clock" cls="i--14" />
            Standard
          </span>
          <span class="nlist__v">
            After the chain's finality{" "}
            <span class="dim">· any amount, and Fast above the cap · {andList([destOf("sepolia"), ...ROLLUPS].map((d) => `${timeOf(d.key, "std")[0]} on ${d.short}`))}, est.</span>
          </span>
          <span class="nlist__end">
            <span class="tag tag--verify">
              <Icon id="i-check" cls="i--12" />
              Enabled
            </span>
          </span>
        </li>
        <li class="nlist__row">
          <span class="nlist__k">Waiting</span>
          <span class="nlist__v">{waiting.reading ? <span class="skel" /> : n === null ? "Could not read" : n ? `${n} burn${n === 1 ? "" : "s"}` : "No burn waiting for a release"}</span>
          <span class="nlist__end" />
        </li>
      </ul>
      <div class="runs">
        <p class="runs__k">Recorded releases</p>
        <ul class="nlist">
          {RELEASES.map(({ run, block, at }) => (
            <li key={run.id} class="nlist__row">
              <span class="nlist__k">Burn {run.n}</span>
              <span class="nlist__v">
                {destOf(run.dest).short} · {run.speed ? SPEED_NAME[run.speed] : "Released"}
                {run.took ? ` · ${run.took}` : ""}{" "}
                <span class="dim">
                  · {Number.isFinite(at) ? `${dayTime(at)} UTC · ` : ""}V3 <span class="mono">#{num(block)}</span>
                </span>
              </span>
              <span class="nlist__end">
                <a class="tl__link" href={`#/receipt/${run.id}`}>
                  Receipt
                  <Icon id="i-arrow-right" cls="i--12" />
                </a>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <p class="ncard__note ncard__note--trust">
        <Icon id="i-alert" cls="i--14" />
        <span>
          Fast is trusted: a reorg deeper than 3 blocks on Sepolia, or a rollup's sequencer dropping its latest blocks before their batch is on Sepolia, could undo a
          burn after its release.
        </span>
      </p>
    </article>
  );
}

// ---------------------------------------------------------------------------------------------
// The reference cards: on phones they fold into disclosure rows, so the page is not a wall

function Fold({
  phone,
  id,
  icon,
  title,
  sub,
  asOf,
  trust = false,
  wide = false,
  flag,
  children,
}: {
  phone: boolean;
  id: string;
  icon: string;
  title: string;
  sub: ComponentChildren;
  asOf?: string;
  trust?: boolean;
  wide?: boolean;
  flag?: ComponentChildren;
  children: ComponentChildren;
}) {
  const head = (
    <>
      <span class={`ncard__icon${trust ? " ncard__icon--trust" : ""}`} aria-hidden="true">
        <Icon id={icon} />
      </span>
      <div class="ncard__titles">
        <h2 class="ncard__title" id={id}>
          {title}
        </h2>
        <p class="ncard__sub">{sub}</p>
        {asOf ? <span class="ncard__asof">{asOf}</span> : null}
      </div>
    </>
  );
  if (phone) {
    return (
      <details class={`card ncard ncard--fold${wide ? " ncard--wide" : ""}`}>
        <summary class="ncard__head ncard__summary">
          {head}
          <Icon id="i-chevron-down" cls="i--16 ncard__chev" />
        </summary>
        {children}
      </details>
    );
  }
  return (
    <article class={`card ncard${wide ? " ncard--wide" : ""}`} aria-labelledby={id}>
      <header class="ncard__head">
        {head}
        {flag}
      </header>
      {children}
    </article>
  );
}

function CommitteeCard({ phone }: { phone: boolean }) {
  const C = RP.committee;
  const read = useCommitteeBalances([C.multisig, ...C.members]);
  const live = read.state === "live";
  const multisig = live ? (read.tpot[C.multisig] ?? 0) : MULTISIG_TPOT;
  const asOf =
    live && read.at !== null
      ? `Live · spendable tPOT, as of ${clockUtc(read.at)}`
      : read.state === "loading"
        ? "Reading V3…"
        : Number.isFinite(BALANCES_AT)
          ? `Recorded · as of ${dayTime(BALANCES_AT)} UTC, after burn 1`
          : "Recorded";
  return (
    <Fold
      phone={phone}
      id="n-committee"
      icon="i-key"
      title="Committee balances"
      trust
      sub={
        <>
          pallet-multisig on V3 · {C.threshold} of {C.members.length} · releaser <span class="mono">{short(checksum(C.releaser))}</span>
        </>
      }
      asOf={asOf}
    >
      <div class="bigrow">
        <div>
          <span class="bigrow__num">
            {read.state === "loading" ? <span class="skel" /> : fmt(multisig, 3)}
            <span class="unit">tPOT</span>
          </span>
          <span class="bigrow__label">
            Multisig <span class="mono">{short(C.multisig, 6, 4)}</span> · pays {fmt(DEPOSIT_PER_RELEASE)} tPOT storage deposit per release
          </span>
        </div>
        <span class="bigrow__side">
          <span class="mono">≈ {read.state === "loading" ? "…" : Math.floor(multisig / DEPOSIT_PER_RELEASE)}</span> releases funded
        </span>
      </div>
      <ul class="nlist">
        {C.members.map((m, i) => {
          const k = MEMBER_TPOT[m];
          const bal = live ? (read.tpot[m] ?? 0) : null;
          const role = k && k.note !== "not funded" ? k.note : null;
          const note = live ? (bal === 0 ? "not funded" : role) : (k?.note ?? null);
          return (
            <li key={m} class="nlist__row">
              <span class="nlist__k">Member {i + 1}</span>
              <span class="nlist__v">
                <span class="mono">{short(m, 6, 4)}</span>
                {note ? (
                  <>
                    {" "}
                    <span class="dim">· {note}</span>
                  </>
                ) : null}
              </span>
              <span class="nlist__end mono">{read.state === "loading" ? <span class="skel" /> : bal !== null ? `${fmt(bal, 4)} tPOT` : k ? `${k.bal} tPOT` : "—"}</span>
            </li>
          );
        })}
      </ul>
      <p class="ncard__note ncard__note--trust">
        <Icon id="i-alert" cls="i--14" />
        <span>On the testnet one operator holds all three keys. The committee shows the mechanics, not independent approvers.</span>
      </p>
    </Fold>
  );
}

/** "lock 0 and lock 1, both minted", and how many more the chain has than the records. */
function countNote(runs: Run[], onChain: number | null, done: string): string {
  const names = runs.map((r) => (r.dir === "in" ? `lock ${r.n}` : `burn ${r.n}${r.speed ? ` (${SPEED_NAME[r.speed]})` : ""}`));
  const finished = runs.filter((r) => r.done).length;
  const state = finished === runs.length ? (runs.length === 2 ? `both ${done}` : runs.length > 2 ? `all ${done}` : done) : `${finished} ${done}`;
  const more = onChain !== null && onChain > runs.length ? onChain - runs.length : 0;
  return `${andList(names)}, ${state}${more ? `; ${more} more since the records` : ""}`;
}

/**
 * The vault against wtPOT on every chain it is minted on: one vault backs Sepolia's, Base Sepolia's
 * and Arbitrum Sepolia's wtPOT, so its outstanding is set against their supplies summed, and the
 * burns waiting are counted on all three (`waiting`, withRollups). `rollups`: each rollup's wtPOT
 * and burns (rollups.ts).
 */
function VaultCard({ phone, waiting, rollups }: { phone: boolean; waiting: Waiting; rollups: readonly (Field<RollupSupply> & { d: Dest })[] }) {
  const vault = useField("v3.vault");
  const token = useField("sepolia.token");
  const minter = useField("sepolia.minter");
  // While a field is read, the store hands back its recorded value: it is not shown under "Reading".
  const v = vault.status === "loading" ? undefined : vault.value;
  const t = token.status === "loading" ? undefined : token.value;
  const m = minter.status === "loading" ? undefined : minter.value;
  const rs = rollups.map((r) => (r.status === "loading" ? undefined : r.value));
  // The supply on every chain, once each one's is read.
  const supply = t && rs.every((x) => x !== undefined) ? rs.reduce((s, x) => s + (x?.supply ?? 0n), t.totalSupply) : undefined;
  const wait = <span class="skel" />;
  // The supplies, read alike: all live, all recorded, or not yet.
  const supplies =
    token.status === "live" && rollups.every((r) => r.status === "live")
      ? "live"
      : token.status === "recorded" && rollups.every((r) => r.status === "recorded")
        ? "recorded"
        : token.status === "loading" || rollups.some((r) => r.status === "loading")
          ? "loading"
          : "mixed";
  const live = vault.status === "live" && supplies === "live";
  const bothRecorded = vault.status === "recorded" && supplies === "recorded";
  const recorded = vault.status === "recorded" || token.status === "recorded" || minter.status === "recorded" || rollups.some((r) => r.status === "recorded");
  const supplyAt = Math.min(token.at ?? Date.now(), ...rollups.map((r) => r.at ?? Date.now()));
  const at = Math.min(vault.at ?? Date.now(), supplyAt);
  const asOf = live
    ? `Live · as of ${clockUtc(at)}${minter.status === "recorded" ? "; burn count recorded" : ""}`
    : bothRecorded
      ? AFTER_LAST
      : vault.status === "recorded" && supplies === "live"
        ? `Outstanding recorded; supply live, as of ${clockUtc(supplyAt)}`
        : vault.status === "live" && supplies === "recorded"
          ? `Outstanding live, as of ${clockUtc(vault.at ?? Date.now())}; supply recorded`
          : vault.status === "loading" || supplies === "loading"
            ? "Reading V3, Sepolia and the rollups"
            : vault.status === "live" && supplies === "mixed"
              ? `Outstanding live, as of ${clockUtc(vault.at ?? Date.now())}; supply live on some chains, recorded on others`
              : "Could not read";
  const locks = RUNS.filter((r) => r.dir === "in").sort((x, y) => Number(x.n) - Number(y.n));
  // The burns waiting sit under the supply, so they are shown only when read alike with it: live with live, recorded with recorded.
  const alike = supplies === "live" ? waiting.live : supplies === "recorded" && !waiting.live;
  const n = alike ? waiting.count : null;
  // Each chain's burns to date: Sepolia's burnCount() and each rollup's.
  const burnCounts = [{ d: destOf("sepolia"), n: m ? Number(m.burnCount) : undefined }, ...rollups.map((r, i) => ({ d: r.d, n: rs[i]?.burns }))];
  const allBurns = burnCounts.every((b) => b.n !== undefined) ? burnCounts.reduce((s, b) => s + (b.n ?? 0), 0) : undefined;

  // Outstanding and supply are compared only when read alike: a recorded side against a live one would differ by every transfer since.
  let check: ComponentChildren = null;
  if (v && supply !== undefined && (live || bothRecorded)) {
    if (v.outstanding === supply && n === 0) {
      check = (
        <p class="balance__ok">
          <Icon id="i-check-circle" cls="i--16" />
          Balanced: outstanding = supply + burns waiting
        </p>
      );
    } else if (v.outstanding > supply) {
      check = (
        <div class="notice">
          <Icon id="i-clock" />
          <div>
            <p class="notice__title">{fmt(tok(v.outstanding - supply))} tPOT in the vault is not wtPOT yet</p>
            <p>A burn waiting for its release, or a lock waiting for its mint, on any of the three chains.</p>
          </div>
        </div>
      );
    } else if (v.outstanding < supply) {
      check = (
        <div class="notice notice--revert">
          <Icon id="i-alert" />
          <div>
            <p class="notice__title">More wtPOT than tPOT in the vault</p>
            <p>{fmt(tok(supply - v.outstanding))} wtPOT is not backed by the vault right now.</p>
          </div>
        </div>
      );
    }
  }

  return (
    <Fold
      phone={phone}
      id="n-vault"
      icon="i-lock"
      title="Vault and supply"
      sub={
        <>
          Every wtPOT is backed by tPOT in the vault
          {bothRecorded && LAST.block !== null ? (
            <>
              {" "}
              · after {LAST.what}, V3 <span class="mono">#{num(LAST.block)}</span>
            </>
          ) : null}
        </>
      }
      asOf={asOf}
      flag={
        recorded ? (
          <Chip kind="muted badge--sm" icon="i-server">
            Recorded
          </Chip>
        ) : null
      }
    >
      <div class="balance">
        <div class="balance__side">
          <ChainMark mark="portaldot" cls="mark--28" />
          <span class="balance__num">
            {v ? fmt(tok(v.outstanding)) : vault.status === "loading" ? wait : "—"}
            <span class="unit">tPOT</span>
          </span>
          <span class="balance__label">outstanding in the vault</span>
        </div>
        <span class="balance__eq" aria-label="equals">
          =
        </span>
        <div class="balance__side">
          <ChainMark mark="ethereum" cls="mark--28" />
          <span class="balance__num">
            {supply !== undefined ? fmt(tok(supply)) : supplies === "loading" ? wait : "—"}
            <span class="unit">wtPOT</span>
          </span>
          <span class="balance__label">{n === null ? "supply + burns waiting" : `supply + ${n} burn${n === 1 ? "" : "s"} waiting`}, on 3 chains</span>
        </div>
      </div>
      {check}
      <ul class="nlist">
        <li class="nlist__row">
          <span class="nlist__k">Supply</span>
          <span class="nlist__v">
            {t ? fmt(tok(t.totalSupply)) : token.status === "loading" ? wait : "—"} <span class="dim">on Sepolia</span>
            {rollups.map((r, i) => {
              const x = rs[i];
              return (
                <span key={r.d.key}>
                  {" "}
                  · {x ? fmt(tok(x.supply)) : r.status === "loading" ? wait : "—"} <span class="dim">on {r.d.short}</span>
                </span>
              );
            })}
          </span>
          <span class="nlist__end" />
        </li>
        <li class="nlist__row">
          <span class="nlist__k">Locks</span>
          <span class="nlist__v">
            {v ? `${num(Number(v.nextNonce))} to date` : vault.status === "loading" ? wait : "—"}{" "}
            <span class="dim">· {countNote(locks, v ? Number(v.nextNonce) : null, "minted")}</span>
          </span>
          <span class="nlist__end" />
        </li>
        <li class="nlist__row">
          <span class="nlist__k">Next lock</span>
          <span class="nlist__v">
            nonce <span class="mono">{v ? String(v.nextNonce) : vault.status === "loading" ? wait : "—"}</span>
          </span>
          <span class="nlist__end" />
        </li>
        <li class="nlist__row">
          <span class="nlist__k">Burns</span>
          <span class="nlist__v">
            {allBurns !== undefined ? `${num(allBurns)} to date` : minter.status === "loading" || rollups.some((r) => r.status === "loading") ? wait : "—"}{" "}
            <span class="dim">· {andList(burnCounts.map((b) => `${b.n === undefined ? "—" : num(b.n)} on ${b.d.short}`))}</span>
          </span>
          <span class="nlist__end" />
        </li>
      </ul>
    </Fold>
  );
}

/** The chains the README's evidence rows are on, in its order, as the note names them. */
const EVIDENCE_CHAINS = [
  ["sepolia", "Sepolia"],
  ["v3", "V3"],
  ["base-sepolia", "Base Sepolia"],
  ["arbitrum-sepolia", "Arbitrum Sepolia"],
] as const;

function ContractsCard({ phone }: { phone: boolean }) {
  const rows = records.evidence;
  const counts = EVIDENCE_CHAINS.map(([chain, name]) => [rows.filter((r) => r.chain === chain).length, name] as const).filter(([n]) => n > 0);
  return (
    <Fold phone={phone} wide id="n-contracts" icon="i-doc" title="Contracts" sub="BridgeMinter and wtPOT are source-verified on Etherscan">
      <ul class="clist">
        {CONTRACTS.map((c) => {
          const full = checksum(c.address);
          return (
            <li key={c.name} class="clist__row">
              <ChainMark mark={c.chain === "v3" ? "portaldot" : "ethereum"} cls="mark--28" />
              <span class="clist__text">
                <span class="clist__name">
                  {c.name} <span class="clist__where">{c.where}</span>
                </span>
                <span class="clist__role">{c.role}</span>
              </span>
              <span class="clist__addr">
                <Addr full={full} href={c.chain === "v3" ? `${V3_SCAN}/address/${full}` : etherscanAddress(full)} label={`${c.name} address`} />
              </span>
            </li>
          );
        })}
      </ul>
      {rows.length ? (
        <p class="ncard__note">
          <span>
            The README's{" "}
            <a class="text-link" href={`${REPO}#evidence`} target="_blank" rel="noopener">
              evidence table
            </a>{" "}
            numbers {num(rows.length)} transactions: {andList(counts.map(([n, name]) => `${num(n)} on ${name}`))}.
          </span>
        </p>
      ) : null}
      <p class="ncard__note">
        <span>
          The chains' and wallets' marks are their owners'; the ETH diamond is ethereum.org's, under CC BY 4.0. Each one's source and terms:{" "}
          <a class="text-link" href={repoFile("NOTICE.md")} target="_blank" rel="noopener">
            NOTICE.md
          </a>
          .
        </span>
      </p>
    </Fold>
  );
}

// ---------------------------------------------------------------------------------------------
// The page

/**
 * Which chain did not answer, from the reads net.ts makes. net.ts names V3 alone when both are down;
 * the page tells them apart, since only Sepolia's light-client reads fall back to recorded values.
 */
function useDown(net: NetState): { v3: boolean; sepolia: boolean } {
  const lc = useField("lc.v3");
  const chain = useField("chain.v3");
  if (net.key !== "rpc") return { v3: false, sepolia: false };
  return { v3: chain.status === "recorded" || chain.status === "error", sepolia: lc.status === "recorded" || lc.status === "error" };
}

function PageNotice({ net }: { net: NetState }) {
  const lc = useField("lc.v3");
  const chain = useField("chain.v3");
  const down = useDown(net);
  let n: readonly [string, string, string, string] | null = null;
  if (down.sepolia) {
    n = [
      "notice--muted",
      "i-server",
      down.v3 ? "Sepolia and Portaldot V3 are not answering" : "Sepolia RPCs are not answering",
      "Values below are the last recorded reads, tagged Recorded. Retrying every 30 s.",
    ];
  } else if (down.v3) {
    // The light clients and wtPOT are read from Sepolia and stay live: only V3's own head is missing.
    n = [
      "notice--muted",
      "i-server",
      "Portaldot V3 is not answering",
      "Its finalized head can't be read, so neither can the light client's lag. Each card says whether its values are live or recorded. Retrying every 30 s.",
    ];
  } else if (net.key === "relay") {
    const s = net.behind === 1 ? "" : "s";
    const to = chain.value?.setId;
    n = [
      "notice--trust",
      "i-refresh",
      `The V3 light client is ${net.behind} validator-set change${s} behind`,
      `${to !== null && to !== undefined ? `V3 moved to set ${to}. ` : ""}A mint made now imports ${net.behind === 1 ? "the change" : "the changes"} first, through Multicall3, for about ${IMPORT_GAS} M gas more per change; nothing waits for the relayer, which imports ${net.behind === 1 ? "it" : "them"} on its next run.`,
    ];
  } else if (net.key === "paused") {
    n = lc.value?.halted
      ? [
          "notice--revert",
          "i-alert",
          "The V3 light client is halted",
          "It met a validator-set change it cannot import. Mints are refused until its admin installs a new checkpoint. Burns and releases are not affected.",
        ]
      : ["notice--revert", "i-alert", "The V3 light client is paused by its admin", "Mints are refused until it resumes. Burns and releases are not affected."];
  }
  if (!n) return null;
  return (
    <div class={`notice ${n[0]} page__notice`}>
      <Icon id={n[1]} />
      <div>
        <p class="notice__title">{n[2]}</p>
        <p>{n[3]}</p>
      </div>
    </div>
  );
}

export function NetworkView({ net }: { net: NetState }) {
  const phone = usePhone();
  const [base, arbitrum] = ROLLUPS;
  // wtPOT and the burns on each rollup: the vault backs all three chains' wtPOT.
  const supplies = [
    { ...useRollupSupply("base-sepolia"), d: destOf("base-sepolia") },
    { ...useRollupSupply("arbitrum-sepolia"), d: destOf("arbitrum-sepolia") },
  ];
  const waiting = withRollups(useWaiting(), supplies);
  const down = useDown(net);
  // The rollups' clients, and their wtPOT and burns, are read while this page is open.
  useEffect(() => watchRollups(), []);
  useEffect(() => watchSupplies(), []);
  const eyebrow = down.sepolia
    ? "Read from records · RPC down"
    : down.v3
      ? "Read live · Portaldot V3 not answering"
      : net.key === "checking"
        ? "Reading V3, Sepolia and two rollups"
        : "Read live · V3, Sepolia and two rollups";
  return (
    <div class="page">
      <header class="page__head">
        <div>
          <p class="eyebrow page__eyebrow">{eyebrow}</p>
          <h1 class="page__title">Network</h1>
          <p class="page__lead">
            The light client every mint uses and the relayer that keeps it current, the same client on two rollups, kept at V3's validator set by the relayer after each set change, the committee that runs the way back, the vault against wtPOT on all three chains, and the contracts. Each card says when its values were read.
          </p>
        </div>
      </header>
      <PageNotice net={net} />
      {/* Two independent column stacks, so no card leaves a hole beside a taller neighbour. */}
      <div class="ngrid">
        <Topo net={net} />
        <div class="ncols">
          <div class="ncol">
            <LcCard which="v3" />
            {base ? <RollupLcCard d={base} /> : null}
            <WatcherCard waiting={waiting} />
            <VaultCard phone={phone} waiting={waiting} rollups={supplies} />
          </div>
          <div class="ncol">
            <RelayerCard />
            {arbitrum ? <RollupLcCard d={arbitrum} /> : null}
            <CommitteeCard phone={phone} />
            <LcCard which="mainnet" quiet />
          </div>
        </div>
        <ContractsCard phone={phone} />
      </div>
      <div class="later-line">
        <span class="badge badge--later badge--sm">Later</span>
        <p>
          <span class="later-line__name">More EVM chains:</span> {`${LATER_CHAINS.join(", ")}. ${LATER_NOTE}`}
        </p>
      </div>
    </div>
  );
}
