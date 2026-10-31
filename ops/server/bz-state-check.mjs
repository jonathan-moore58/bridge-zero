// ops/server/bz-state-check.mjs  (server: /home/ubuntu/bz-ops/bz-state-check.mjs)
// Read-only: is Bridge Zero's state quiet (nothing in flight, no halt), and the sha256 of every state
// file a cutover copies and of every deployments/*.json record. Runs the same on the machine the
// processes leave and on the one they move to, Windows or Linux (Node 24, no packages):
//   node bz-state-check.mjs [--repo <checkout>] [--state <state dir>]
// Defaults: --repo ~/bridge-zero; --state ~/.bridge-zero.
// It never opens the committee folder, a *.pw file or a keystore, and writes nothing. A file that goes
// away while it reads (a lock released, a record's .tmp renamed) is noted and skipped.
// Exit code 0 when quiet, 1 when something is in flight or halted, 2 when it cannot read the state.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { repo: { type: "string" }, state: { type: "string" } } });
const repo = resolve(values.repo ?? join(homedir(), "bridge-zero"));
const state = resolve(values.state ?? join(homedir(), ".bridge-zero"));
let busy = 0;
const flag = (line) => {
  busy += 1;
  console.log(`BUSY ${line}`);
};
const note = (line) => console.log(`     ${line}`);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const minutesAgo = (ms) => Math.round((Date.now() - ms) / 60_000);
const gone = (error) => error?.code === "ENOENT";
const now = new Date().toLocaleString("en-US", { timeZone: "Asia/Karachi", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });

let names;
try {
  names = readdirSync(state).sort();
} catch {
  console.log(`cannot read ${state}`);
  process.exit(2);
}
console.log(`state ${state}, repo ${repo}, ${now} PKT`);

/** One file of the state directory: a lock's holder, a halt, an open transaction or mint, and its sha256. */
function scan(name) {
  const path = join(state, name);
  const st = statSync(path);
  if (!st.isFile() || /\.pw$/i.test(name) || !/^(relay|automint|release-watch)-/.test(name)) return;
  const bytes = readFileSync(path);
  const text = bytes.toString("utf8");
  if (/\.lock($|\.)/.test(name)) {
    let pid = "?";
    try {
      pid = JSON.parse(text).pid;
    } catch {
      // half written
    }
    note(`lock ${name}: process ${pid}, refreshed ${minutesAgo(st.mtimeMs)} min ago (never copied)`);
    return;
  }
  if (name.endsWith(".halt")) {
    flag(`${name} is there: the release watcher is halted. Copy it with the state; read it before anything starts`);
    return;
  }
  if (/\.tmp$|\.unreadable-/.test(name)) {
    note(`${name}: left by an interrupted write or set aside (never copied)`);
    return;
  }
  if (!/\.jsonl?$/.test(name)) return;
  // The deployer's relay record: its key never goes to the server, so neither does the record.
  const deployers = name.includes("0xd9838a86cf83c28ee486544060d1ca4ca2971071") ? "  (the deployer's: not copied)" : "";
  try {
    if (name.endsWith(".jsonl")) {
      // A history: one JSON line each; a line a crash cut short is left as it is, as the tools leave it.
      const lines = [];
      let bad = 0;
      for (const l of text.split("\n").map((x) => x.trim()).filter(Boolean)) {
        try {
          lines.push(JSON.parse(l));
        } catch {
          bad += 1;
        }
      }
      if (bad > 0) note(`${name}: ${bad} line(s) do not parse (cut by a crash?)`);
      if (name.startsWith("automint-")) {
        const settled = new Set(lines.filter((l) => l.kind === "result").map((l) => l.id));
        const open = [...new Set(lines.filter((l) => l.kind === "attempt" && !settled.has(l.id)).map((l) => l.lock))];
        if (open.length > 0) flag(`${name}: an attempt without a result for lock(s) ${open.join(", ")} (a mint in flight)`);
      }
    } else if (name.startsWith("relay-")) {
      const open = JSON.parse(text).open ?? [];
      if (open.length > 0) flag(`${name}: ${open.length} relay transaction(s) open (${open.map((e) => `${e.method} nonce ${e.nonce}`).join(", ")})${deployers}`);
    } else {
      JSON.parse(text);
    }
  } catch {
    flag(`${name} does not parse`);
  }
  console.log(`sha256 ${sha(bytes)}  ${name}${deployers}`);
}

for (const name of names) {
  try {
    scan(name);
  } catch (error) {
    if (gone(error)) note(`${name} went away while it was read (a lock released, a record's .tmp renamed): skipped`);
    else flag(`${name} could not be read (${error?.code ?? "error"})`);
  }
}

/** The release record: what a settling or a member still has to do. */
function checkRecord(bytes) {
  const r = JSON.parse(bytes.toString("utf8"));
  const releases = r.releases ?? [];
  const acknowledged = (x) => typeof x?.acknowledged === "string" && x.acknowledged.trim() !== "";
  const submitted = releases.flatMap((x) => (x.approvals ?? []).filter((a) => a.status === "submitted").map((a) => `burn ${x.burn}: member ${a.member}'s ${a.action}`));
  const open = releases.filter((x) => x.status === "open").map((x) => `burn ${x.burn}`);
  const funding = (r.committeeFunding ?? []).filter((f) => f.status === "submitted");
  const findings = releases.filter((x) => (x.approvals ?? []).some((a) => a.status === "failed" && a.block && !acknowledged(a)) || (x.finalizedCheck?.ok === false && !acknowledged(x.finalizedCheck)));
  if (submitted.length > 0) flag(`v3-testnet.json: approval(s) submitted and not settled: ${submitted.join("; ")}`);
  if (open.length > 0) flag(`v3-testnet.json: release(s) open (a multisig operation started, not executed): ${open.join(", ")}`);
  if (funding.length > 0) flag(`v3-testnet.json: ${funding.length} committee funding transfer(s) submitted and not settled`);
  if (findings.length > 0) flag(`v3-testnet.json: a failed check no member acknowledged (burn ${findings.map((x) => x.burn).join(", ")}): the watcher with --send halts on it`);
  const counts = {};
  for (const x of releases) counts[x.status] = (counts[x.status] ?? 0) + 1;
  note(`v3-testnet.json: ${releases.length} release(s) ${JSON.stringify(counts)}`);
}

// The records in deployments/ (the release record and what the watcher and the auto-mint read): both
// machines must hold the same bytes at a cutover.
const deployments = join(repo, "deployments");
let records = [];
try {
  records = readdirSync(deployments).filter((n) => n.endsWith(".json")).sort();
} catch {
  flag(`${deployments} cannot be read`);
}
if (!records.includes("v3-testnet.json")) flag(`${join(deployments, "v3-testnet.json")} is not there`);
for (const name of records) {
  let bytes;
  try {
    bytes = readFileSync(join(deployments, name));
  } catch (error) {
    if (gone(error)) note(`deployments/${name} went away while it was read: skipped`);
    else flag(`deployments/${name} could not be read (${error?.code ?? "error"})`);
    continue;
  }
  if (name === "v3-testnet.json") {
    try {
      checkRecord(bytes);
    } catch {
      flag("deployments/v3-testnet.json cannot be read as JSON");
    }
  }
  console.log(`sha256 ${sha(bytes)}  deployments/${name}`);
}
if (existsSync(join(deployments, "v3-testnet.json.lock"))) note("deployments/v3-testnet.json.lock is there (never copied)");
console.log(busy === 0 ? "QUIET: nothing in flight, no halt file" : `NOT QUIET: ${busy} item(s) marked BUSY above`);
process.exit(busy === 0 ? 0 : 1);
