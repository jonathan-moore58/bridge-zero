// Reads the repository's records at build time: deployments/, fixtures/, the README's evidence
// tables and the contract sources (for the errors and events the page decodes). Every recorded
// value the page shows comes from here. The one file written for the page is
// site/data/measured-runs.json, the intervals the tools measured during lock 1's run, which
// deployments/ does not record: it is checked against deployments/ and, when the README states the
// same run, against the README. A record that does not have the expected shape fails the build
// rather than putting a wrong number on the page.

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { formatUnits } from "../src/lib/format.ts";
import type {
  VerifyBlock,
  AbiItem,
  AbiParam,
  Attack,
  BridgeRun,
  BurnRecord,
  EvidenceRow,
  Hex,
  LatestRun,
  LightClientFacts,
  Precommit,
  Records,
  RecordedTx,
  RelayEntry,
  RelayRun,
  ReleaseRecord,
  ReturnPath,
  Roadmap,
  RollupClientFacts,
  RunStep,
} from "../src/lib/records-types.ts";

const REPO_URL = "https://github.com/jonathan-moore58/bridge-zero";

type Json = Record<string, unknown>;

class RecordError extends Error {}

function fail(file: string, what: string): never {
  throw new RecordError(`${file}: ${what}`);
}

function readJson(root: string, file: string): Json {
  const path = join(root, file);
  if (!existsSync(path)) fail(file, "missing");
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Json;
  } catch (error) {
    fail(file, `not JSON (${(error as Error).message})`);
  }
}

function obj(v: unknown, file: string, what: string): Json {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(file, `${what} is not an object`);
  return v as Json;
}

function arr(v: unknown, file: string, what: string): unknown[] {
  if (!Array.isArray(v)) fail(file, `${what} is not a list`);
  return v;
}

function str(v: unknown, file: string, what: string): string {
  if (typeof v !== "string") fail(file, `${what} is not a string`);
  return v;
}

function num(v: unknown, file: string, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(file, `${what} is not a number`);
  return v;
}

function hex(v: unknown, file: string, what: string, bytes?: number): Hex {
  const s = str(v, file, what).toLowerCase();
  if (!/^0x([0-9a-f]{2})*$/.test(s)) fail(file, `${what} is not hex`);
  if (bytes !== undefined && s.length !== 2 + bytes * 2) fail(file, `${what} is not ${bytes} bytes`);
  return s as Hex;
}

function optNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function optStr(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function optHex(v: unknown): Hex | null {
  return typeof v === "string" && /^0x([0-9a-fA-F]{2})*$/.test(v) ? (v.toLowerCase() as Hex) : null;
}

// ---------------------------------------------------------------------------------------------
// README evidence tables

/** A row of an evidence table: number, what it shows, transaction, block, result. */
const ROW = /^\|\s*\**(\d+)\**\s*\|(.+)\|\s*$/;
const ETHERSCAN_TX = /\(https:\/\/sepolia\.etherscan\.io\/tx\/(0x[0-9a-fA-F]{64})\)/;
/** A rollup row links its transaction on the rollup's explorer (README, "More chains"). */
const ROLLUP_TX: readonly (readonly [RegExp, "base-sepolia" | "arbitrum-sepolia"])[] = [
  [/\(https:\/\/sepolia\.basescan\.org\/tx\/(0x[0-9a-fA-F]{64})\)/, "base-sepolia"],
  [/\(https:\/\/sepolia\.arbiscan\.io\/tx\/(0x[0-9a-fA-F]{64})\)/, "arbitrum-sepolia"],
];
const SHORT_HASH = /`(0x[0-9a-fA-F]+)…([0-9a-fA-F]+)`/;

/** Splits a table row's cells, keeping the pipes inside code spans and links. */
function cells(body: string): string[] {
  const out: string[] = [];
  let cur = "";
  let code = false;
  let depth = 0;
  for (const c of body) {
    if (c === "`") code = !code;
    else if (!code && (c === "(" || c === "[")) depth++;
    else if (!code && (c === ")" || c === "]")) depth = Math.max(0, depth - 1);
    if (c === "|" && !code && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

/**
 * The evidence rows. A Sepolia row links its transaction on Etherscan, a Base Sepolia or Arbitrum
 * Sepolia row on Basescan or Arbiscan; a V3 row prints a shortened extrinsic hash, resolved here
 * against `v3Hashes` (the full hashes deployments/ records).
 */
export function parseEvidence(readme: string, v3Hashes: string[] = []): EvidenceRow[] {
  const rows: EvidenceRow[] = [];
  let table = "";
  for (const line of readme.split(/\r?\n/)) {
    const heading = /^#{2,4}\s+(.+)$/.exec(line);
    if (heading?.[1]) table = heading[1].trim();
    const m = ROW.exec(line);
    if (!m) continue;
    const parts = cells(m[2] ?? "");
    if (parts.length !== 4) continue;
    const [what, txCell, blockCell, result] = parts as [string, string, string, string];
    const eth = ETHERSCAN_TX.exec(txCell);
    const rollup = eth ? null : (ROLLUP_TX.map(([re, chain]) => ({ hit: re.exec(txCell), chain })).find((x) => x.hit) ?? null);
    const linked = eth ?? rollup?.hit ?? null;
    const short = SHORT_HASH.exec(txCell);
    const blockDigits = /(\d[\d,]*)/.exec(blockCell.replace(/\]\(.*?\)/g, "]").replace(/\b(V3|Sepolia|Base|Arbitrum)\b/g, ""));
    if (!blockDigits?.[1] || (!linked && !short)) continue;
    const isV3 = !linked && /\bV3\b/.test(blockCell);
    let tx: Hex | null = linked?.[1] ? (linked[1].toLowerCase() as Hex) : null;
    if (!tx && short) {
      const head = (short[1] ?? "").toLowerCase();
      const tail = (short[2] ?? "").toLowerCase();
      const found = [...new Set(v3Hashes.map((h) => h.toLowerCase()))].filter((h) => h.startsWith(head) && h.endsWith(tail));
      tx = found.length === 1 ? (found[0] as Hex) : null;
    }
    const link = /\]\((https:\/\/[^)]+)\)/.exec(blockCell);
    rows.push({
      n: Number(m[1]),
      what: stripBold(what),
      chain: rollup ? rollup.chain : isV3 ? "v3" : "sepolia",
      tx,
      txText: (linked ? /`([^`]+)`/.exec(txCell)?.[1] : short?.[0]?.replace(/`/g, "")) ?? "",
      block: Number(blockDigits[1].replace(/,/g, "")),
      blockUrl: link?.[1] ?? null,
      result: stripBold(result),
      table,
    });
  }
  const seen = new Set<number>();
  for (const r of rows) {
    if (seen.has(r.n)) fail("README.md", `evidence row ${r.n} appears twice`);
    seen.add(r.n);
  }
  return rows.sort((a, b) => a.n - b.n);
}

/**
 * The first sh block under the README's "Verify it yourself" heading: the variables it sets, then
 * groups of commands, each with the comment lines above it (what it shows) and the comment lines
 * right after each command (what the README records it printing).
 */
export function parseVerify(readme: string): VerifyBlock | null {
  const at = readme.search(/^##\s+Verify it yourself\s*$/m);
  if (at < 0) return null;
  const block = /```(?:sh|bash)\r?\n([\s\S]*?)```/.exec(readme.slice(at));
  if (!block?.[1]) return null;
  const text = block[1].replace(/\r/g, "");
  const env: string[] = [];
  const groups: VerifyBlock["groups"] = [];
  let what: string[] = [];
  let last: VerifyBlock["groups"][number]["commands"][number] | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      last = null;
      continue;
    }
    if (line.startsWith("#")) {
      const c = line.replace(/^#\s?/, "");
      if (last) last.output.push(c);
      else what.push(c);
      continue;
    }
    if (/^[A-Z][A-Z0-9_]*=\S+$/.test(line) && groups.length === 0 && what.length === 0) {
      env.push(line);
      continue;
    }
    if (what.length || groups.length === 0) {
      groups.push({ what, commands: [] });
      what = [];
    }
    last = { cmd: line, output: [], now: null };
    groups.at(-1)?.commands.push(last);
  }
  if (!groups.length) return null;
  return { env, groups, text };
}

/** A value deployments/ gives for a command of the README's block: how to find the command, and the value. */
export interface VerifyExpectation {
  /** Matches the command line. */
  cmd: RegExp;
  /** The integer the records give at this build. */
  value: bigint;
  /** How the page writes it after the integer, e.g. "1.5 wtPOT". */
  note: string;
}

/**
 * The README records each command's output as cast printed it on the day it was written; a later
 * mint, burn or release changes some of them. Where the README's integer differs from what
 * deployments/ gives at this build, the command gets `now` (the records' value), so the page shows
 * both instead of an output that no longer holds. Returns what differed, for the build's log.
 */
export function markStaleOutputs(verify: VerifyBlock, expected: VerifyExpectation[]): string[] {
  const differ: string[] = [];
  for (const g of verify.groups) {
    for (const c of g.commands) {
      const e = expected.find((x) => x.cmd.test(c.cmd));
      if (!e) continue;
      const said = /^(\d+)\b/.exec(c.output[0]?.trim() ?? "")?.[1];
      if (said === undefined || BigInt(said) === e.value) continue;
      c.now = `${e.value} (${e.note})`;
      differ.push(`${c.cmd.split(" --rpc-url")[0]}: the README records ${said}, deployments/ gives ${e.value}`);
    }
  }
  return differ;
}

function stripBold(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/g, "$1").trim();
}

/**
 * The README's "Roadmap" section, in its words: the line under the heading, then each bold group
 * ("**Next, before Nov 6**") with its list items. An item that starts with a bold phrase keeps it
 * apart as its lead. Inline markdown (code spans, links, bold) is kept for the page to render.
 */
export function parseRoadmap(readme: string): Roadmap | null {
  const at = readme.search(/^##\s+Roadmap\s*$/m);
  if (at < 0) return null;
  const lines = readme.slice(at).split(/\r?\n/).slice(1);
  const end = lines.findIndex((l) => /^##\s/.test(l));
  const body = end < 0 ? lines : lines.slice(0, end);
  const intro: string[] = [];
  const groups: Roadmap["groups"] = [];
  let item: string[] | null = null;
  const flush = () => {
    const group = groups.at(-1);
    if (item && group) {
      const text = item.join(" ").replace(/\s+/g, " ").trim();
      const m = /^\*\*(.+?)\*\*\s*(.*)$/.exec(text);
      group.items.push(m ? { lead: (m[1] ?? "").trim(), text: (m[2] ?? "").trim() } : { lead: null, text });
    }
    item = null;
  };
  for (const raw of body) {
    const line = raw.trimEnd();
    const heading = /^\*\*([^*]+)\*\*$/.exec(line.trim());
    if (heading?.[1] && !/^\s*-/.test(line)) {
      flush();
      groups.push({ title: heading[1].trim(), items: [] });
    } else if (/^-\s+/.test(line)) {
      flush();
      item = [line.replace(/^-\s+/, "")];
    } else if (item && /^\s+\S/.test(line)) {
      item.push(line.trim());
    } else if (!line.trim()) {
      flush();
    } else if (!groups.length) {
      intro.push(line.trim());
    }
  }
  flush();
  if (!groups.length || groups.some((g) => !g.items.length)) return null;
  return { intro: intro.join(" "), groups };
}

// ---------------------------------------------------------------------------------------------
// Contract sources: errors and events

const ENUMS = new Set(["HaltReason"]);
const INTERFACES = /^(I[A-Z]\w*)$/;

function canonicalType(raw: string, file: string): string {
  const base = raw.replace(/\[\]$/, "");
  const suffix = raw.endsWith("[]") ? "[]" : "";
  if (ENUMS.has(base)) return `uint8${suffix}`;
  if (INTERFACES.test(base)) return `address${suffix}`;
  if (base === "uint") return `uint256${suffix}`;
  if (/^(u?int\d*|address|bool|bytes\d*|string)$/.test(base)) return raw;
  fail(file, `unknown parameter type ${raw}`);
}

function parseParams(list: string, file: string, allowIndexed: boolean): AbiParam[] {
  const trimmed = list.trim();
  if (!trimmed) return [];
  return trimmed.split(",").map((part, i) => {
    const words = part.trim().split(/\s+/).filter((w) => w !== "memory" && w !== "calldata");
    const type = words[0];
    if (!type) fail(file, `empty parameter in (${list})`);
    const indexed = words.includes("indexed");
    if (indexed && !allowIndexed) fail(file, `indexed parameter outside an event`);
    const name = words.filter((w) => w !== "indexed")[1] ?? `arg${i}`;
    return { type: canonicalType(type, file), name, indexed };
  });
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

function solFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...solFiles(path));
    else if (entry.endsWith(".sol")) out.push(path);
  }
  return out.sort();
}

export function parseAbi(srcDir: string): { errors: AbiItem[]; events: AbiItem[] } {
  const errors = new Map<string, AbiItem>();
  const events = new Map<string, AbiItem>();
  for (const path of solFiles(srcDir)) {
    const source = relative(srcDir, path).split(sep).join("/");
    const code = stripComments(readFileSync(path, "utf8"));
    for (const m of code.matchAll(/\berror\s+(\w+)\s*\(([^)]*)\)\s*;/g)) {
      const item: AbiItem = { kind: "error", name: m[1] ?? "", params: parseParams(m[2] ?? "", source, false), source };
      const key = signature(item);
      if (!errors.has(key)) errors.set(key, item);
    }
    for (const m of code.matchAll(/\bevent\s+(\w+)\s*\(([^)]*)\)\s*;/g)) {
      const item: AbiItem = { kind: "event", name: m[1] ?? "", params: parseParams(m[2] ?? "", source, true), source };
      const key = signature(item);
      if (!events.has(key)) events.set(key, item);
    }
  }
  return { errors: [...errors.values()], events: [...events.values()] };
}

function signature(item: AbiItem): string {
  return `${item.name}(${item.params.map((p) => p.type).join(",")})`;
}

// ---------------------------------------------------------------------------------------------
// Deployments

function recordedTx(s: Json, file: string, what: string): RecordedTx {
  return {
    name: str(s.name, file, `${what}.name`),
    kind: str(s.kind, file, `${what}.kind`),
    txHash: hex(s.txHash, file, `${what}.txHash`, 32),
    block: optNum(s.block),
    gasUsed: optNum(s.gasUsed),
    gasLimit: optNum(s.gasLimit),
    status: optNum(s.status),
    sender: hex(s.sender, file, `${what}.sender`, 20),
    to: hex(s.address, file, `${what}.address`, 20),
    signedAt: optStr(s.signedAt),
    effectiveGasPrice: optStr(s.effectiveGasPrice),
  };
}

const ATTACK_PARTS = ["signature", "header", "proof", "amount", "recipient"] as const;

function parseRelay(text: string, file: string, sender: Hex): RelayEntry[] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((line, i) => {
      let e: Json;
      try {
        e = JSON.parse(line) as Json;
      } catch {
        fail(file, `line ${i + 1} is not JSON`);
      }
      const chain = str(e.chain, file, `line ${i + 1} chain`);
      if (chain !== "mainnet" && chain !== "v3") fail(file, `line ${i + 1}: unknown chain ${chain}`);
      const block = obj(e.block, file, `line ${i + 1} block`);
      return {
        chain,
        sender,
        client: hex(e.client, file, `line ${i + 1} client`, 20),
        method: str(e.method, file, `line ${i + 1} method`),
        block: { number: num(block.number, file, `line ${i + 1} block.number`), hash: hex(block.hash, file, `line ${i + 1} block.hash`, 32) },
        setBefore: num(e.setBefore, file, `line ${i + 1} setBefore`),
        setAfter: num(e.setAfter, file, `line ${i + 1} setAfter`),
        signatures: num(e.signatures, file, `line ${i + 1} signatures`),
        txHash: hex(e.txHash, file, `line ${i + 1} txHash`, 32),
        sepoliaBlock: optNum(e.sepoliaBlock),
        gasUsed: optNum(e.gasUsed),
        status: optNum(e.status),
        ok: typeof e.ok === "boolean" ? e.ok : null,
        settledAt: optStr(e.settledAt),
      };
    });
}

/** A relayer history: one file per sender, relay-sepolia-<sender>.jsonl, the sender in lowercase. */
const RELAY_FILE = /^relay-sepolia-(0x[0-9a-f]{40})\.jsonl$/;

/**
 * Every relayer history in `dir` (deployments/ by default), merged in the order of their file
 * names: a transaction recorded twice (the same txHash) counts once. Each entry keeps its sender,
 * from its file's name. `files` are the histories' paths from the repository root.
 */
function readRelayHistories(root: string, dir: string): { files: string[]; entries: RelayEntry[] } {
  const names = existsSync(dir) ? readdirSync(dir).filter((f) => RELAY_FILE.test(f)).sort() : [];
  const files: string[] = [];
  const entries: RelayEntry[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const file = relative(root, join(dir, name)).split(sep).join("/");
    files.push(file);
    const sender = (RELAY_FILE.exec(name)?.[1] ?? fail(file, "no sender in the file name")) as Hex;
    for (const e of parseRelay(readFileSync(join(dir, name), "utf8"), file, sender)) {
      if (seen.has(e.txHash)) continue;
      seen.add(e.txHash);
      entries.push(e);
    }
  }
  return { files, entries };
}

/** An auto-mint history: one file per sender, automint-sepolia-<sender>.jsonl, the sender in lowercase. */
const AUTOMINT_FILE = /^automint-sepolia-(0x[0-9a-f]{40})\.jsonl$/;

/**
 * The nonces of the locks auto-mint minted, from every auto-mint history in `dir`: a "result" line
 * with the outcome "minted" names its lock. A line cut short by a crash is skipped, as the tool
 * itself skips it.
 */
function readAutoMints(dir: string): Set<number> {
  const minted = new Set<number>();
  const names = existsSync(dir) ? readdirSync(dir).filter((f) => AUTOMINT_FILE.test(f)).sort() : [];
  for (const name of names) {
    for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
      if (!line.trim()) continue;
      let e: Json;
      try {
        e = JSON.parse(line) as Json;
      } catch {
        continue;
      }
      // The lock's nonce is written as a decimal string (a bigint), or as a number.
      const lock = typeof e.lock === "number" ? e.lock : typeof e.lock === "string" && /^\d+$/.test(e.lock) ? Number(e.lock) : null;
      if (e.kind === "result" && e.outcome === "minted" && lock !== null) minted.add(lock);
    }
  }
  return minted;
}

function latestOk(entries: RelayEntry[], chain: "mainnet" | "v3"): RelayEntry | null {
  const ok = entries.filter((e) => e.chain === chain && e.ok === true && e.status === 1);
  return ok.sort((a, b) => a.block.number - b.block.number).at(-1) ?? null;
}

/**
 * The relayer's latest run into a client: the sender of the newest successful entry, and its
 * successful entries settled within 15 minutes of that one. A run is one sender's: another
 * sender's entries in those minutes are not part of it.
 */
function latestRelayRun(entries: RelayEntry[], chain: "mainnet" | "v3"): RelayRun | null {
  const ok = entries.filter((e) => e.chain === chain && e.ok === true && e.status === 1 && e.settledAt && !Number.isNaN(Date.parse(e.settledAt)));
  if (!ok.length) return null;
  const at = (e: RelayEntry) => Date.parse(e.settledAt ?? "");
  const newest = ok.reduce((a, b) => (at(b) > at(a) ? b : a));
  const run = ok.filter((e) => e.sender === newest.sender && at(newest) - at(e) <= 15 * 60 * 1000).sort((a, b) => a.block.number - b.block.number);
  return { entries: run, settledAt: run.at(-1)?.settledAt ?? null };
}

const MEASURED = "site/data/measured-runs.json";
const STEP_KEYS = ["lock", "finality", "proofs", "mint"] as const;

/** The README's "Lock to mint …" section (a timed run), if the README at this build has one. */
export function readmeTimingSection(readme: string): string | null {
  const m = /^#{2,4}\s+Lock to mint\b[^\n]*$/m.exec(readme);
  if (!m) return null;
  const rest = readme.slice(m.index + m[0].length);
  const end = rest.search(/^#{2,4}\s/m);
  return end < 0 ? rest : rest.slice(0, end);
}

/**
 * The README's section against the data file: the total, then the four steps in order ("it took 48
 * seconds: the lock 10, GRANDPA finality 14, …"), and the block stamps (HH:MM:SS). "disagrees"
 * when the README gives other numbers (the build fails); "unclear" when it gives them in words this
 * check does not read (the build says so and goes on); "agrees" otherwise.
 */
export function checkReadmeTiming(
  section: string,
  steps: RunStep[],
  total: number,
  stamps: string[],
): { status: "agrees" | "disagrees" | "unclear"; problem: string | null } {
  const text = section.replace(/\s+/g, " ");
  const times: string[] = text.match(/\b\d{2}:\d{2}:\d{2}\b/g) ?? [];
  const otherStamps = stamps.filter((s) => times.length > 0 && !times.includes(s));
  if (otherStamps.length) return { status: "disagrees", problem: `it stamps the blocks ${times.join(" and ")}, the data file ${stamps.join(" and ")}` };
  const at = text.indexOf(`${total} seconds:`);
  if (at < 0) {
    const said = /\b(\d+) seconds\b/.exec(text)?.[1];
    if (said && !text.includes(`${total} seconds`)) return { status: "disagrees", problem: `it says ${said} seconds, the data file ${total}` };
    return { status: "unclear", problem: `it does not say "${total} seconds:" followed by the steps` };
  }
  const sentence = text.slice(at + `${total} seconds:`.length).split(/\.(\s|$)/)[0] ?? "";
  const nums = (sentence.match(/\b\d+\b/g) ?? []).map(Number);
  const want = steps.map((s) => s.seconds);
  if (nums.length < want.length) return { status: "unclear", problem: `it gives ${nums.length} numbers after "${total} seconds:", not ${want.length}` };
  if (want.some((n, i) => nums[i] !== n)) return { status: "disagrees", problem: `it gives the steps as ${nums.slice(0, want.length).join(", ")} s, the data file ${want.join(", ")} s` };
  return { status: "agrees", problem: null };
}

/** The intervals measured during a run, checked against the records: both transactions recorded, steps adding up. */
function measuredTiming(root: string, readme: string, lock: { txHash: string; block: number }, mint: { txHash: string; block: number | null }): LatestRun["timing"] {
  if (!existsSync(join(root, MEASURED))) return null;
  const m = readJson(root, MEASURED);
  const about = str(m.about, MEASURED, "about");
  for (const [i, r] of arr(m.runs, MEASURED, "runs").entries()) {
    const run = obj(r, MEASURED, `run ${i}`);
    if (hex(run.mintTx, MEASURED, `run ${i}.mintTx`, 32) !== mint.txHash.toLowerCase()) continue;
    if (hex(run.lockTx, MEASURED, `run ${i}.lockTx`, 32) !== lock.txHash.toLowerCase()) fail(MEASURED, `run ${i}: its lock is not the recorded lock of that mint`);
    const steps: RunStep[] = arr(run.steps, MEASURED, `run ${i}.steps`).map((s, j) => {
      const st = obj(s, MEASURED, `run ${i} step ${j}`);
      const key = str(st.key, MEASURED, `run ${i} step ${j}.key`);
      if (key !== STEP_KEYS[j]) fail(MEASURED, `run ${i} step ${j} is ${key}, expected ${STEP_KEYS[j]}`);
      const seconds = num(st.seconds, MEASURED, `run ${i} step ${j}.seconds`);
      if (seconds <= 0) fail(MEASURED, `run ${i} step ${j}: not a duration`);
      return { key: key as RunStep["key"], seconds, what: str(st.what, MEASURED, `run ${i} step ${j}.what`) };
    });
    if (steps.length !== STEP_KEYS.length) fail(MEASURED, `run ${i}: ${steps.length} steps, expected ${STEP_KEYS.length}`);
    const totalSeconds = num(run.totalSeconds, MEASURED, `run ${i}.totalSeconds`);
    if (steps.reduce((n, s) => n + s.seconds, 0) !== totalSeconds) fail(MEASURED, `run ${i}: the steps do not add up to ${totalSeconds} s`);

    // The two blocks' timestamps: the lock's V3 block and the mint's Sepolia block, as recorded.
    let blockTimes: NonNullable<LatestRun["timing"]>["blockTimes"] = null;
    if (run.blockTimes !== undefined) {
      const bt = obj(run.blockTimes, MEASURED, `run ${i}.blockTimes`);
      const stamp = (k: "lock" | "mint") => {
        const e = obj(bt[k], MEASURED, `run ${i}.blockTimes.${k}`);
        const at = str(e.at, MEASURED, `run ${i}.blockTimes.${k}.at`);
        if (Number.isNaN(Date.parse(at))) fail(MEASURED, `run ${i}.blockTimes.${k}.at is not a time`);
        return { block: num(e.block, MEASURED, `run ${i}.blockTimes.${k}.block`), at };
      };
      const l = stamp("lock");
      const n = stamp("mint");
      if (l.block !== lock.block) fail(MEASURED, `run ${i}: the lock's block is #${l.block}, deployments/ records #${lock.block}`);
      if (n.block !== mint.block) fail(MEASURED, `run ${i}: the mint's block is ${n.block}, deployments/ records ${mint.block}`);
      const seconds = (Date.parse(n.at) - Date.parse(l.at)) / 1000;
      if (!(seconds > 0 && seconds <= totalSeconds)) fail(MEASURED, `run ${i}: the blocks are ${seconds} s apart, not within the ${totalSeconds} s run`);
      blockTimes = { lock: l, mint: n, seconds };
    }

    const section = readmeTimingSection(readme);
    let inReadme = false;
    if (section) {
      const stamps = blockTimes ? [blockTimes.lock.at.slice(11, 19), blockTimes.mint.at.slice(11, 19)] : [];
      const check = checkReadmeTiming(section, steps, totalSeconds, stamps);
      if (check.status === "disagrees") fail("README.md", `the "Lock to mint" section disagrees with ${MEASURED}: ${check.problem}`);
      if (check.status === "unclear") console.warn(`README.md: the "Lock to mint" section was not checked against ${MEASURED}: ${check.problem}`);
      inReadme = check.status === "agrees";
    }
    const readmeHeading = inReadme ? (/^#{2,4}\s+(Lock to mint\b[^\n]*)$/m.exec(readme)?.[1]?.trim() ?? null) : null;
    return { steps, totalSeconds, measuredOn: str(run.measuredOn, MEASURED, `run ${i}.measuredOn`), about, from: MEASURED, blockTimes, inReadme, readmeHeading };
  }
  return null;
}

/**
 * The newest block a light client imported, by the records: the relayer's latest import into it,
 * or, for the V3 client, a mint's bundle block (importAndMint imports it) when that is newer.
 */
function latestImportOf(relay: RelayEntry | null, relayFile: string, mints: Json[], client: "mainnet" | "v3"): LightClientFacts["latestImport"] {
  const BR = "deployments/sepolia-bridge.json";
  const fromRelay: LightClientFacts["latestImport"] = relay
    ? { number: relay.block.number, hash: relay.block.hash, setId: relay.setAfter, txHash: relay.txHash, sepoliaBlock: relay.sepoliaBlock, via: "relayer", from: relayFile }
    : null;
  if (client !== "v3") return fromRelay;
  let best = fromRelay;
  for (const s of mints) {
    const b = obj(s.bundle, BR, "mint.bundle");
    const blk = obj(b.block, BR, "mint.bundle.block");
    const number = num(blk.number, BR, "mint.bundle.block.number");
    if (best && best.number >= number) continue;
    best = {
      number,
      hash: hex(blk.hash, BR, "mint.bundle.block.hash", 32),
      setId: num(b.setId, BR, "mint.bundle.setId"),
      txHash: hex(s.txHash, BR, "mint.txHash", 32),
      sepoliaBlock: optNum(s.block),
      via: "mint",
      from: BR,
    };
  }
  return best;
}

/** The rollups where the V3 light client was deployed (README, "More chains"), and their chain ids. */
const ROLLUPS = { "base-sepolia": 84532, "arbitrum-sepolia": 421614 } as const;

/**
 * The V3 light client on a rollup, by the records: deployments/<network>.json for the addresses and
 * the deploy block, and the relayer's histories relay-<network>-<sender>.jsonl (the rollup block in
 * their `sepoliaBlock`, as the relayer names it on every network) for the imports. Null when
 * deployments/ has no record for the network.
 */
function readRollup(root: string, dir: string, network: keyof typeof ROLLUPS): RollupClientFacts | null {
  const file = `deployments/${network}.json`;
  if (!existsSync(join(root, file))) return null;
  const d = readJson(root, file);
  if (d.network !== network) fail(file, `network is ${String(d.network)}, not ${network}`);
  const chainId = num(d.chainId, file, "chainId");
  if (chainId !== ROLLUPS[network]) fail(file, `chainId ${chainId}, not ${ROLLUPS[network]}`);
  const contracts = obj(d.contracts, file, "contracts");
  const lightClient = hex(contracts["GrandpaLightClient #2"], file, "contracts.GrandpaLightClient #2", 20);
  const provenBalance = hex(contracts["ProvenBalance #2"], file, "contracts.ProvenBalance #2", 20);
  const steps = arr(d.steps, file, "steps").map((s, i) => obj(s, file, `step ${i}`));
  const deploy = steps.find((s) => s.kind === "deploy" && s.name === "GrandpaLightClient #2") ?? fail(file, "no deploy step for GrandpaLightClient #2");
  const pattern = new RegExp(`^relay-${network}-(0x[0-9a-f]{40})\\.jsonl$`);
  const names = existsSync(dir) ? readdirSync(dir).filter((f) => pattern.test(f)).sort() : [];
  const imports: RollupClientFacts["imports"] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const rel = relative(root, join(dir, name)).split(sep).join("/");
    const sender = (pattern.exec(name)?.[1] ?? fail(rel, "no sender in the file name")) as Hex;
    for (const e of parseRelay(readFileSync(join(dir, name), "utf8"), rel, sender)) {
      if (e.chain !== "v3" || e.client.toLowerCase() !== lightClient || e.ok !== true || e.status !== 1 || seen.has(e.txHash)) continue;
      seen.add(e.txHash);
      imports.push({ number: e.block.number, hash: e.block.hash, setBefore: e.setBefore, setAfter: e.setAfter, txHash: e.txHash, block: e.sepoliaBlock, settledAt: e.settledAt, from: rel });
    }
  }
  imports.sort((a, b) => a.number - b.number);
  const last = imports.at(-1);
  return {
    network,
    chainId,
    from: file,
    lightClient,
    provenBalance,
    deployBlock: num(deploy.block, file, "GrandpaLightClient #2 block"),
    imports,
    latestImport: last ? { number: last.number, hash: last.hash, setId: last.setAfter, txHash: last.txHash, block: last.block, settledAt: last.settledAt, from: last.from } : null,
  };
}

function signingSetKeys(fixture: Json, file: string): { setId: number; keys: Hex[] } {
  const set = obj(fixture.signingSet, file, "signingSet");
  return {
    setId: num(set.setId, file, "signingSet.setId"),
    keys: arr(set.authorities, file, "signingSet.authorities").map((a, i) => hex(obj(a, file, `authority ${i}`).id, file, `authority ${i}.id`, 32)),
  };
}

function probeFacts(root: string, file: string) {
  const p = readJson(root, file);
  const prov = obj(p.provenance, file, "provenance");
  const identity = obj(p.identity, file, "identity");
  const props = obj(identity.properties, file, "identity.properties");
  const finality = obj(p.finality, file, "finality");
  const sudo = obj(finality.sudoKey, file, "finality.sudoKey");
  return {
    genesis: hex(prov.genesisHash, file, "provenance.genesisHash", 32),
    blockTimeSec: Math.round(num(finality.blockTimeAvgMs, file, "finality.blockTimeAvgMs") / 1000),
    ss58Prefix: num(props.ss58Format, file, "ss58Format"),
    tokenSymbol: str(props.tokenSymbol, file, "tokenSymbol"),
    sudo: { id: hex(sudo.id, file, "sudoKey.id", 32), ss58: str(sudo.ss58, file, "sudoKey.ss58"), from: file },
  };
}

function gitCommit(root: string): string | null {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/** `relayDir` is where the relayer histories are read: deployments/ unless a test gives its own. */
export function buildRecords(root: string, relayDir = join(root, "deployments")): Records {

  // Sepolia: the light clients and libraries
  const SEP = "deployments/sepolia.json";
  const sep = readJson(root, SEP);
  const sepContracts = obj(sep.contracts, SEP, "contracts");
  const sepSteps = arr(sep.steps, SEP, "steps").map((s, i) => obj(s, SEP, `step ${i}`));
  const addr = (name: string) => hex(sepContracts[name], SEP, `contracts.${name}`, 20);

  // Sepolia: the bridge
  const BR = "deployments/sepolia-bridge.json";
  const br = readJson(root, BR);
  const brContracts = obj(br.contracts, BR, "contracts");
  const minter = hex(brContracts.BridgeMinter, BR, "contracts.BridgeMinter", 20);
  const token = hex(brContracts.WrappedTPOT, BR, "contracts.WrappedTPOT", 20);
  const steps = arr(br.steps, BR, "steps").map((s, i) => obj(s, BR, `step ${i}`));

  // V3: the vault and its locks
  const V3F = "deployments/v3-testnet.json";
  const v3 = readJson(root, V3F);
  const vault = obj(v3.vault, V3F, "vault");
  const locks = arr(v3.locks, V3F, "locks").map((l, i) => obj(l, V3F, `lock ${i}`));
  const lock0 = locks.find((l) => l.nonce === 0 && l.status === "locked") ?? fail(V3F, "no lock 0");
  const committee = obj(vault.committee, V3F, "vault.committee");

  // README evidence, with the V3 rows' extrinsic hashes resolved against the V3 record
  if (!existsSync(join(root, "README.md"))) fail("README.md", "missing");
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const v3Hashes = [...JSON.stringify(v3).matchAll(/0x[0-9a-fA-F]{64}/g)].map((m) => m[0]);
  const evidence = parseEvidence(readme, v3Hashes);
  const rowOf = (tx: string) => evidence.find((r) => r.tx === tx.toLowerCase())?.n ?? null;

  // The mint and the bundle it used
  const mintStep = steps.find((s) => s.kind === "mint" && s.ok === true) ?? fail(BR, "no mint step");
  const mintBundle = obj(mintStep.bundle, BR, "mint.bundle");
  const bundleFile = str(mintBundle.file, BR, "mint.bundle.file");
  const bundle = readJson(root, bundleFile);
  const header = obj(bundle.header, bundleFile, "header");
  const just = obj(bundle.justification, bundleFile, "justification");
  const signers = obj(bundle.signers, bundleFile, "signers");
  const account = obj(bundle.account, bundleFile, "account");
  const accountKey = obj(account.key, bundleFile, "account.key");
  const accountValue = obj(account.value, bundleFile, "account.value");
  const accountDecoded = obj(accountValue.decoded, bundleFile, "account.value.decoded");
  const accountProof = obj(account.proof, bundleFile, "account.proof");
  const childRoot = obj(bundle.childRoot, bundleFile, "childRoot");
  const childKey = obj(childRoot.key, bundleFile, "childRoot.key");
  const childProof = obj(childRoot.proof, bundleFile, "childRoot.proof");
  const slot = obj(bundle.slot, bundleFile, "slot");
  const slotKey = obj(slot.key, bundleFile, "slot.key");
  const slotValue = obj(slot.value, bundleFile, "slot.value");
  const slotProof = obj(slot.proof, bundleFile, "slot.proof");
  const provenance = obj(bundle.provenance, bundleFile, "provenance");
  const signingSet = signingSetKeys(bundle, bundleFile);
  // The V3 set the newest recorded mint was signed under: the recorded fallback of authorities(setId).
  let latestSigningSet: { setId: number; keys: Hex[]; from: string } = { ...signingSet, from: bundleFile };
  const mintLock = obj(mintStep.lock, BR, "mint.lock");

  const precommits: Precommit[] = arr(just.precommits, bundleFile, "justification.precommits").map((p, i) => {
    const pc = obj(p, bundleFile, `precommit ${i}`);
    return {
      position: i,
      authorityIndex: num(pc.authorityIndex, bundleFile, `precommit ${i}.authorityIndex`),
      authorityId: hex(pc.authorityId, bundleFile, `precommit ${i}.authorityId`, 32),
      signature: hex(pc.signature, bundleFile, `precommit ${i}.signature`, 64),
      targetHash: hex(pc.targetHash, bundleFile, `precommit ${i}.targetHash`, 32),
      targetNumber: num(pc.targetNumber, bundleFile, `precommit ${i}.targetNumber`),
    };
  });

  const lockBlock = obj(lock0.block, V3F, "lock 0 block");
  const vaultBlock = obj(vault.block, V3F, "vault.block");
  const vaultDeployer = obj(vault.deployer, V3F, "vault.deployer");
  const bridge: BridgeRun = {
    lock: {
      nonce: 0,
      txHash: hex(lock0.txHash, V3F, "lock 0 txHash", 32),
      block: { number: num(lockBlock.number, V3F, "lock 0 block.number"), hash: hex(lockBlock.hash, V3F, "lock 0 block.hash", 32) },
      from: hex(lock0.from, V3F, "lock 0 from", 20),
      recipient: hex(lock0.recipient, V3F, "lock 0 recipient", 20),
      dstChainId: str(lock0.dstChainId, V3F, "lock 0 dstChainId"),
      dstMinter: hex(lock0.dstMinter, V3F, "lock 0 dstMinter", 20),
      amountNative: str(lock0.amountNative, V3F, "lock 0 amountNative"),
      value: str(lock0.value, V3F, "lock 0 value"),
      commitment: hex(lock0.commitment, V3F, "lock 0 commitment", 32),
      slot: hex(lock0.slot, V3F, "lock 0 slot", 32),
      cost: str(lock0.cost, V3F, "lock 0 cost"),
      signedAt: str(lock0.signedAt, V3F, "lock 0 signedAt"),
    },
    vault: {
      address: hex(vault.address, V3F, "vault.address", 20),
      codeHash: hex(vault.codeHash, V3F, "vault.codeHash", 32),
      runtimeBytes: num(vault.runtimeBytes, V3F, "vault.runtimeBytes"),
      deployBlock: { number: num(vaultBlock.number, V3F, "vault.block.number"), hash: hex(vaultBlock.hash, V3F, "vault.block.hash", 32) },
      extrinsicHash: hex(vault.extrinsicHash, V3F, "vault.extrinsicHash", 32),
      deployer: str(vaultDeployer.ss58, V3F, "vault.deployer.ss58"),
      releaser: hex(vault.releaser, V3F, "vault.releaser", 20),
      nativeToEthRatio: str(vault.nativeToEthRatio, V3F, "vault.nativeToEthRatio"),
    },
    finality: {
      block: {
        number: num(header.number, bundleFile, "header.number"),
        hash: hex(header.hash, bundleFile, "header.hash", 32),
        parentHash: hex(header.parentHash, bundleFile, "header.parentHash", 32),
        stateRoot: hex(header.stateRoot, bundleFile, "header.stateRoot", 32),
        extrinsicsRoot: hex(header.extrinsicsRoot, bundleFile, "header.extrinsicsRoot", 32),
        headerBytes: num(header.bytes, bundleFile, "header.bytes"),
        scale: hex(header.scale, bundleFile, "header.scale"),
      },
      setId: num(provenance.setId, bundleFile, "provenance.setId"),
      round: num(just.round, bundleFile, "justification.round"),
      precommits,
      signers: {
        hint: hex(signers.hint, bundleFile, "signers.hint"),
        count: num(signers.count, bundleFile, "signers.count"),
        threshold: num(signers.threshold, bundleFile, "signers.threshold"),
      },
      authorities: signingSet.keys,
      finalityProofBytes: num(obj(bundle.finalityProof, bundleFile, "finalityProof").bytes, bundleFile, "finalityProof.bytes"),
      capturedAt: str(provenance.capturedAt, bundleFile, "provenance.capturedAt"),
    },
    proofs: {
      account: {
        key: hex(accountKey.hex, bundleFile, "account.key.hex"),
        keyBytes: num(accountKey.bytes, bundleFile, "account.key.bytes"),
        valueBytes: num(accountValue.bytes, bundleFile, "account.value.bytes"),
        trieId: hex(accountDecoded.trieId, bundleFile, "account.value.decoded.trieId", 32),
        codeHash: hex(accountDecoded.codeHash, bundleFile, "account.value.decoded.codeHash", 32),
        items: num(accountProof.count, bundleFile, "account.proof.count"),
        bytes: num(accountProof.bytes, bundleFile, "account.proof.bytes"),
      },
      childRoot: {
        key: hex(childKey.hex, bundleFile, "childRoot.key.hex"),
        keyBytes: num(childKey.bytes, bundleFile, "childRoot.key.bytes"),
        root: hex(childRoot.root, bundleFile, "childRoot.root", 32),
        items: num(childProof.count, bundleFile, "childRoot.proof.count"),
        bytes: num(childProof.bytes, bundleFile, "childRoot.proof.bytes"),
      },
      slot: {
        index: hex(slot.index, bundleFile, "slot.index", 32),
        key: hex(slotKey.hex, bundleFile, "slot.key.hex", 32),
        value: hex(slotValue.hex, bundleFile, "slot.value.hex"),
        items: num(slotProof.count, bundleFile, "slot.proof.count"),
        bytes: num(slotProof.bytes, bundleFile, "slot.proof.bytes"),
      },
    },
    mint: {
      ...recordedTx(mintStep, BR, "mint"),
      amountNative: str(mintLock.amountNative, BR, "mint.lock.amountNative"),
      recipient: hex(mintLock.recipient, BR, "mint.lock.recipient", 20),
    },
    bundleFile,
    row: null,
  };
  bridge.row = rowOf(bridge.mint.txHash);

  // The lock and the bundle must agree with each other.
  if (bridge.lock.commitment !== bridge.proofs.slot.value) fail(bundleFile, "slot value is not lock 0's commitment");
  if (bridge.lock.slot !== bridge.proofs.slot.index) fail(bundleFile, "slot index is not lock 0's slot");
  if (bridge.lock.amountNative !== bridge.mint.amountNative) fail(BR, "the mint's amount is not lock 0's");

  // The latest recorded transfer: the newest successful mint, its lock and its bundle.
  const okMints = steps.filter((s) => s.kind === "mint" && s.ok === true && s.status === 1);
  const newest = [...okMints].sort((a, b) => num(a.block, BR, "mint.block") - num(b.block, BR, "mint.block")).at(-1) ?? null;
  let latestRun: LatestRun | null = null;
  if (newest) {
    const ml = obj(newest.lock, BR, "latest mint.lock");
    const nonce = num(ml.nonce, BR, "latest mint.lock.nonce");
    const lk = locks.find((l) => l.nonce === nonce && l.status === "locked") ?? fail(V3F, `no lock ${nonce} for the latest mint`);
    const lkBlock = obj(lk.block, V3F, `lock ${nonce} block`);
    const bFile = str(obj(newest.bundle, BR, "latest mint.bundle").file, BR, "latest mint.bundle.file");
    const b = readJson(root, bFile);
    const bProv = obj(b.provenance, bFile, "provenance");
    const bHeader = obj(b.header, bFile, "header");
    const bParent = obj(b.parentHeader, bFile, "parentHeader");
    const bSigners = obj(b.signers, bFile, "signers");
    const bLock = obj(b.lock, bFile, "lock");
    const bSet = signingSetKeys(b, bFile);
    latestSigningSet = { ...bSet, from: bFile };
    const mintTx = recordedTx(newest, BR, "latest mint");
    latestRun = {
      lock: {
        nonce,
        txHash: hex(lk.txHash, V3F, `lock ${nonce} txHash`, 32),
        block: num(lkBlock.number, V3F, `lock ${nonce} block.number`),
        evmBlockHash: hex(lkBlock.hash, V3F, `lock ${nonce} block.hash`, 32),
        from: hex(lk.from, V3F, `lock ${nonce} from`, 20),
        recipient: hex(lk.recipient, V3F, `lock ${nonce} recipient`, 20),
        dstChainId: str(lk.dstChainId, V3F, `lock ${nonce} dstChainId`),
        dstMinter: hex(lk.dstMinter, V3F, `lock ${nonce} dstMinter`, 20),
        amountNative: str(lk.amountNative, V3F, `lock ${nonce} amountNative`),
        commitment: hex(lk.commitment, V3F, `lock ${nonce} commitment`, 32),
        slot: hex(lk.slot, V3F, `lock ${nonce} slot`, 32),
        signedAt: str(lk.signedAt, V3F, `lock ${nonce} signedAt`),
      },
      bundle: {
        file: bFile,
        block: { number: num(bHeader.number, bFile, "header.number"), hash: hex(bHeader.hash, bFile, "header.hash", 32) },
        parent: { number: num(bParent.number, bFile, "parentHeader.number"), hash: hex(bParent.hash, bFile, "parentHeader.hash", 32) },
        setId: num(bProv.setId, bFile, "provenance.setId"),
        signatures: num(bSigners.count, bFile, "signers.count"),
        threshold: num(bSigners.threshold, bFile, "signers.threshold"),
        authorities: bSet.keys.length,
        capturedAt: str(bProv.capturedAt, bFile, "provenance.capturedAt"),
      },
      mint: {
        ...mintTx,
        nonce,
        amountNative: str(ml.amountNative, BR, "latest mint.lock.amountNative"),
        recipient: hex(ml.recipient, BR, "latest mint.lock.recipient", 20),
      },
      bound: newest === okMints[0],
      row: rowOf(mintTx.txHash),
      lockRow: null,
      timing: null,
    };
    const lr = latestRun;
    if (hex(bLock.commitment, bFile, "lock.commitment", 32) !== lr.lock.commitment) fail(bFile, `the bundle's commitment is not lock ${nonce}'s`);
    if (num(bLock.nonce, bFile, "lock.nonce") !== nonce) fail(bFile, `the bundle is not for lock ${nonce}`);
    if (lr.lock.amountNative !== lr.mint.amountNative) fail(BR, `the latest mint's amount is not lock ${nonce}'s`);
    if (lr.lock.recipient !== lr.mint.recipient) fail(BR, `the latest mint's recipient is not lock ${nonce}'s`);
    if (lr.bundle.block.number <= lr.lock.block) fail(bFile, `the bundle's block #${lr.bundle.block.number} is not after the lock's #${lr.lock.block}`);
    // A V3 row of the README prints a shortened extrinsic hash; it resolves against the V3 record.
    lr.lockRow = rowOf(lr.lock.txHash);
    lr.timing = measuredTiming(root, readme, { txHash: lr.lock.txHash, block: lr.lock.block }, { txHash: lr.mint.txHash, block: lr.mint.block });
  }

  // The demo's reverts
  const attacks: Attack[] = steps
    .filter((s) => s.kind === "tamper" || s.kind === "replay")
    .map((s, i) => {
      const t = recordedTx(s, BR, `attack ${i}`);
      const rev = obj(s.expectedRevert, BR, `${t.name}.expectedRevert`);
      const part = s.kind === "replay" ? "replay" : str(obj(s.tamper, BR, `${t.name}.tamper`).part, BR, `${t.name}.tamper.part`);
      if (part !== "replay" && !(ATTACK_PARTS as readonly string[]).includes(part)) fail(BR, `unknown tamper part ${part}`);
      const what = s.kind === "replay" ? "the valid mint again, unchanged" : str(obj(s.tamper, BR, `${t.name}.tamper`).what, BR, `${t.name}.tamper.what`);
      return {
        ...t,
        part: part as Attack["part"],
        what,
        expectedRevert: { name: str(rev.name, BR, `${t.name}.expectedRevert.name`), data: hex(rev.data, BR, `${t.name}.expectedRevert.data`) },
        row: rowOf(t.txHash),
      };
    });

  // The relayer: every sender's history, merged
  const relay = readRelayHistories(root, relayDir);
  const relayEntries = relay.entries;
  const relayFileOf = (e: RelayEntry | null) => (e ? (relay.files.find((f) => f.endsWith(`relay-sepolia-${e.sender}.jsonl`)) ?? "") : "");
  const latestMainnet = latestOk(relayEntries, "mainnet");
  const latestV3 = latestOk(relayEntries, "v3");

  // Light client facts
  const MAIN_PROBE = "fixtures/probe/mainnet.portaldot.io.json";
  const V3_PROBE = "fixtures/probe/test-node-v3.portaldot.dev.json";
  const mainProbe = probeFacts(root, MAIN_PROBE);
  const v3Probe = probeFacts(root, V3_PROBE);
  const MAIN_FIX = "fixtures/mainnet/finality-proof-head.json";
  const mainSet = signingSetKeys(readJson(root, MAIN_FIX), MAIN_FIX);
  const deployBlock = (name: string) => {
    const step = sepSteps.find((s) => s.kind === "deploy" && s.name === name);
    return step ? num(step.block, SEP, `${name} block`) : fail(SEP, `no deploy step for ${name}`);
  };
  const initRow = (client: string) => {
    const step = sepSteps.find((s) => s.name === `${client} initialize`);
    return step && typeof step.txHash === "string" ? rowOf(step.txHash) : null;
  };
  const lightClients: Records["lightClients"] = {
    mainnet: {
      key: "mainnet",
      name: "GrandpaLightClient #1",
      address: addr("GrandpaLightClient #1"),
      deployBlock: deployBlock("GrandpaLightClient #1"),
      chain: "Old Portaldot mainnet",
      substrateWs: "wss://mainnet.portaldot.io",
      substrateHttp: null,
      genesis: mainProbe.genesis,
      blockTimeSec: mainProbe.blockTimeSec,
      ss58Prefix: mainProbe.ss58Prefix,
      tokenSymbol: mainProbe.tokenSymbol,
      fixtureSet: { ...mainSet, from: MAIN_FIX },
      checkpointRow: initRow("#1"),
      sudo: mainProbe.sudo,
      latestRelay: latestMainnet,
      latestImport: latestImportOf(latestMainnet, relayFileOf(latestMainnet), [], "mainnet"),
    } satisfies LightClientFacts,
    v3: {
      key: "v3",
      name: "GrandpaLightClient #2",
      address: addr("GrandpaLightClient #2"),
      deployBlock: deployBlock("GrandpaLightClient #2"),
      chain: "Portaldot V3 testnet",
      substrateWs: "wss://test-node-v3.portaldot.dev",
      substrateHttp: "https://test-node-v3.portaldot.dev",
      genesis: v3Probe.genesis,
      blockTimeSec: v3Probe.blockTimeSec,
      ss58Prefix: v3Probe.ss58Prefix,
      tokenSymbol: v3Probe.tokenSymbol,
      fixtureSet: latestSigningSet,
      checkpointRow: initRow("#2"),
      sudo: v3Probe.sudo,
      latestRelay: latestV3,
      latestImport: latestImportOf(latestV3, relayFileOf(latestV3), okMints, "v3"),
    } satisfies LightClientFacts,
  };
  if (lightClients.v3.genesis !== String(v3.genesisHash).toLowerCase()) fail(V3F, "genesis differs from the V3 probe's");

  // The return path, if the records hold any of it
  const burns: BurnRecord[] = steps
    .filter((s) => s.kind === "burn")
    .map((s) => {
      const b = obj(s.burn, BR, "burn step .burn");
      return {
        txHash: optHex(s.txHash),
        block: optNum(s.block),
        ok: typeof s.ok === "boolean" ? s.ok : null,
        status: optNum(s.status),
        signedAt: optStr(s.signedAt),
        amount: str(b.amount, BR, "burn.amount"),
        v3Recipient: hex(b.v3Recipient, BR, "burn.v3Recipient", 20),
        burnNonce: optStr(b.burnNonce),
        burnId: optHex(b.burnId),
      };
    });
  const releases: ReleaseRecord[] = (Array.isArray(v3.releases) ? v3.releases : []).map((r, i) => {
    const rel = obj(r, V3F, `release ${i}`);
    const burn = typeof rel.burn === "object" && rel.burn !== null ? (rel.burn as Json) : {};
    const released = typeof rel.released === "object" && rel.released !== null ? (rel.released as Json) : null;
    const releasedBlock = released && typeof released.block === "object" && released.block !== null ? (released.block as Json) : null;
    return {
      status: str(rel.status, V3F, `release ${i}.status`),
      burnTx: optHex(burn.txHash),
      burnNonce: optStr(burn.burnNonce),
      burnId: optHex(burn.burnId),
      payee: optHex(rel.payee),
      amountNative: optStr(rel.amountNative),
      approvals: (Array.isArray(rel.approvals) ? rel.approvals : []).map((a, j) => {
        const ap = obj(a, V3F, `release ${i} approval ${j}`);
        const blk = typeof ap.block === "object" && ap.block !== null ? (ap.block as Json) : null;
        return {
          member: num(ap.member, V3F, `release ${i} approval ${j}.member`),
          action: str(ap.action, V3F, `release ${i} approval ${j}.action`),
          extrinsicHash: hex(ap.extrinsicHash, V3F, `release ${i} approval ${j}.extrinsicHash`),
          status: str(ap.status, V3F, `release ${i} approval ${j}.status`),
          block: blk ? optNum(blk.number) : null,
          signedAt: optStr(ap.signedAt),
        };
      }),
      releasedAt: releasedBlock ? { number: num(releasedBlock.number, V3F, "released.block.number"), hash: hex(releasedBlock.hash, V3F, "released.block.hash", 32) } : null,
      by: optStr(rel.by),
    };
  });
  const funding = (Array.isArray(v3.committeeFunding) ? v3.committeeFunding : []).map((f, i) => {
    const e = obj(f, V3F, `committeeFunding ${i}`);
    const blk = typeof e.block === "object" && e.block !== null ? (e.block as Json) : null;
    return {
      status: str(e.status, V3F, `committeeFunding ${i}.status`),
      role: str(e.role, V3F, `committeeFunding ${i}.role`),
      to: str(e.to, V3F, `committeeFunding ${i}.to`),
      amount: str(e.amount, V3F, `committeeFunding ${i}.amount`),
      extrinsicHash: hex(e.extrinsicHash, V3F, `committeeFunding ${i}.extrinsicHash`, 32),
      block: blk ? optNum(blk.number) : null,
    };
  });
  // The first way back that ran: from the burn's sending to the sending of the approval that ran the release.
  const doneRelease = releases.find((r) => r.status === "released" && r.burnTx) ?? null;
  const doneBurn = doneRelease ? (burns.find((b) => b.txHash === doneRelease.burnTx && b.ok === true) ?? null) : null;
  const ranAt = doneRelease?.approvals.find((a) => a.action === "execute")?.signedAt ?? null;
  const backTiming =
    doneBurn?.signedAt && ranAt && Date.parse(ranAt) > Date.parse(doneBurn.signedAt)
      ? { burnSentAt: doneBurn.signedAt, releaseRunAt: ranAt, seconds: Math.round((Date.parse(ranAt) - Date.parse(doneBurn.signedAt)) / 1000) }
      : null;
  const returnPath: ReturnPath = {
    timing: backTiming,
    burns,
    releases,
    funding,
    committee: {
      members: arr(committee.members, V3F, "committee.members").map((m, i) => str(m, V3F, `committee.members[${i}]`)),
      threshold: num(committee.threshold, V3F, "committee.threshold"),
      multisig: str(committee.multisig, V3F, "committee.multisig"),
      releaser: bridge.vault.releaser,
    },
  };

  const roles: Record<string, string> = {
    "GrandpaLightClient #1": "follows the old Portaldot mainnet",
    "GrandpaLightClient #2": "follows the Portaldot V3 testnet",
    "ProvenBalance #1": "proves an old-mainnet balance",
    "ProvenBalance #2": "proves a V3 testnet balance",
    SCL_EIP6565: "ed25519 verification, library",
    GrandpaCodec: "SCALE headers and justifications, library",
    AuthoritySets: "validator-set bookkeeping, library",
    StorageProofs: "the Substrate trie walk, library",
  };
  const contracts = [
    { name: "BridgeMinter", address: minter, role: "proves locks, mints wtPOT" },
    { name: "WrappedTPOT", address: token, role: "wtPOT, 14 decimals" },
    ...Object.keys(roles).map((name) => ({ name, address: addr(name), role: roles[name] ?? "" })),
  ];

  const lockedAmounts = locks.filter((l) => l.status === "locked").map((l, i) => BigInt(str(l.amountNative, V3F, `lock ${i}.amountNative`)));
  const releasedAmounts = releases.filter((r) => r.status === "released").map((r) => BigInt(r.amountNative ?? "0"));
  const mints = steps.filter((s) => s.kind === "mint" && s.ok === true && s.status === 1).map((s) => obj(s.lock, BR, "mint.lock"));
  // The locks auto-mint minted from its own key (deployments/automint-sepolia-<sender>.jsonl), each
  // counted once, with the amount and recipient the V3 record holds for it.
  const mintedNonces = new Set(mints.map((l) => num(l.nonce, BR, "mint.lock.nonce")));
  for (const nonce of readAutoMints(join(root, "deployments"))) {
    if (mintedNonces.has(nonce)) continue;
    mintedNonces.add(nonce);
    mints.push(locks.find((l) => l.nonce === nonce) ?? fail(V3F, `no lock ${nonce} for auto-mint's mint`));
  }
  const minted = mints.reduce((n, l) => n + BigInt(str(l.amountNative, BR, "mint.lock.amountNative")), 0n);
  const okBurns = burns.filter((b) => b.ok === true && b.status === 1);
  const burned = okBurns.reduce((n, b) => n + BigInt(b.amount), 0n);
  const burnedByRecipient = steps
    .filter((s) => s.kind === "burn" && s.ok === true && s.status === 1 && String(s.sender).toLowerCase() === bridge.lock.recipient)
    .reduce((n, s) => n + BigInt(str(obj(s.burn, BR, "burn").amount, BR, "burn.amount")), 0n);
  const mintedToRecipient = mints
    .filter((l) => String(l.recipient).toLowerCase() === bridge.lock.recipient)
    .reduce((n, l) => n + BigInt(str(l.amountNative, BR, "mint.lock.amountNative")), 0n);
  const totals = {
    locks: lockedAmounts.length,
    outstandingNative: (lockedAmounts.reduce((a, b) => a + b, 0n) - releasedAmounts.reduce((a, b) => a + b, 0n)).toString(),
    minted: minted.toString(),
    burned: burned.toString(),
    supply: (minted - burned).toString(),
    recipientBalance: (mintedToRecipient - burnedByRecipient).toString(),
  };

  const abi = parseAbi(join(root, "contracts", "src"));
  if (abi.errors.length < 20 || abi.events.length < 8) fail("contracts/src", "fewer errors or events than expected");

  // The README's recorded outputs against deployments/ at this build: wtPOT, the vault, the burns.
  const verify = parseVerify(readme);
  if (verify) {
    const wt = (v: string) => `${formatUnits(BigInt(v), 14)} wtPOT`;
    const differ = markStaleOutputs(verify, [
      { cmd: /"totalSupply\(\)\(uint256\)"/, value: BigInt(totals.supply), note: wt(totals.supply) },
      { cmd: new RegExp(`"balanceOf\\(address\\)\\(uint256\\)"\\s+${bridge.lock.recipient}\\b`, "i"), value: BigInt(totals.recipientBalance), note: wt(totals.recipientBalance) },
      { cmd: /"outstanding\(\)\(uint256\)"/, value: BigInt(totals.outstandingNative), note: `${formatUnits(BigInt(totals.outstandingNative), 14)} tPOT` },
      { cmd: /"burnCount\(\)\(uint256\)"/, value: BigInt(okBurns.length), note: `${okBurns.length} recorded` },
    ]);
    for (const d of differ) console.warn(`README.md "Verify it yourself": ${d}; the page shows both`);
  }

  return {
    build: { commit: gitCommit(root), builtAt: new Date().toISOString() },
    verify,
    latestRun,
    relayRuns: { mainnet: latestRelayRun(relayEntries, "mainnet"), v3: latestRelayRun(relayEntries, "v3") },
    roadmap: parseRoadmap(readme),
    repo: REPO_URL,
    sepolia: { deployer: hex(br.deployer, BR, "deployer", 20), contracts, minter, token },
    evidence,
    bridge,
    attacks,
    lightClients,
    rollups: { "base-sepolia": readRollup(root, relayDir, "base-sepolia"), "arbitrum-sepolia": readRollup(root, relayDir, "arbitrum-sepolia") },
    relay: { files: relay.files, entries: relayEntries },
    returnPath,
    totals,
    abi,
  };
}
