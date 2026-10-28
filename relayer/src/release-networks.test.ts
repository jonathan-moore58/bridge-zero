// The command lines release.ts refuses for --network (burn, release, the watcher, status; fund takes
// none): each argument error ends in exit code 1 with its message and the usage, before any request.
// The tool runs as a child process whose RPCs, Sepolia's and both rollups', are a closed local port,
// so a command line that slipped past its checks would end otherwise (exit code 2). And the watcher
// over several chains keeps to the committee's one lock. release.test.ts has the rest, Sepolia's.
//
//   npm test

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const RELAYER = fileURLToPath(new URL("..", import.meta.url));
const ADDRESS = "0xD9838A86cF83C28Ee486544060D1cA4Ca2971071";
const RELEASE = ["release", "--burn-nonce", "0"];
const CLOSED = "http://127.0.0.1:9";

/** [the command line, what the tool has to say]. */
const CASES: [string[], RegExp][] = [
  [[...RELEASE, "--network", "base"], /--network: one of sepolia, base-sepolia, arbitrum-sepolia, got "base"/],
  [[...RELEASE, "--network", "sepolia,base-sepolia"], /--network: .*several are for release --watch/],
  [["burn", "--amount", "0.001", "--v3-recipient", ADDRESS, "--network", "arbitrum"], /--network: one of sepolia, base-sepolia, arbitrum-sepolia/],
  [["status", "--network", "op-sepolia"], /--network: one of sepolia, base-sepolia, arbitrum-sepolia/],
  [["fund", "--member", "1", "--amount", "1", "--network", "base-sepolia"], /Unknown option '--network'/],
  [[...RELEASE, "--network", "base-sepolia", "--confirmations", "7201"], /--confirmations: \(base-sepolia\) from 1 to 7,200 blocks on Base Sepolia/],
  [[...RELEASE, "--network", "arbitrum-sepolia", "--confirmations", "0"], /--confirmations: \(arbitrum-sepolia\) from 1 to 7,200 blocks on Arbitrum Sepolia/],
  [[...RELEASE, "--network", "base-sepolia", "--approve", "--member", "1", "--send", "--key-file", "no-such-key.json", "--password-file", "no-such-file.txt", "--confirmations", "3"], /--send takes --confirmations 180 or more on Base Sepolia: 36 seconds of its blocks/],
  [[...RELEASE, "--network", "arbitrum-sepolia", "--cancel", "--member", "1", "--send", "--key-file", "no-such-key.json", "--password-file", "no-such-file.txt", "--confirmations", "143"], /--send takes --confirmations 144 or more on Arbitrum Sepolia/],
  [[...RELEASE, "--network", "base-sepolia", "--rehearse", "--amount", "1", "--to", ADDRESS, "--send", "--approve", "--member", "1"], /--rehearse is a dry run of a burn that is not on Base Sepolia/],
  [[...RELEASE, "--network", "arbitrum-sepolia", "--rehearse", "--amount", "1", "--to", ADDRESS, "--confirmations", "200"], /--confirmations reads a burn on Arbitrum Sepolia, and a rehearsal has none/],
  [["release", "--watch", "10", "--network", "base-sepolia,base-sepolia"], /--network: a network is named twice/],
  [["release", "--watch", "10", "--network", "sepolia,arbitrum"], /--network: each is one of sepolia, base-sepolia, arbitrum-sepolia, got "arbitrum"/],
  [["release", "--watch", "10", "--network", "sepolia,base-sepolia", "--confirmations", "200"], /--confirmations: \(sepolia\) from 1 to 64 blocks/],
  [["release", "--watch", "10", "--network", "sepolia", "--confirmations", "base-sepolia=180"], /--confirmations: base-sepolia is not a --network of this run/],
  [["release", "--watch", "10", "--network", "sepolia,base-sepolia", "--confirmations", "sepolia=3,optimism-sepolia=5"], /--confirmations: no network optimism-sepolia/],
  [["release", "--watch", "10", "--network", "sepolia,base-sepolia", "--confirmations", "sepolia=3,sepolia=4"], /--confirmations: sepolia is named twice/],
  [["release", "--watch", "10", "--send", "--network", "sepolia,arbitrum-sepolia", "--confirmations", "sepolia=3,arbitrum-sepolia=100", "--member-keys", "1:a.json,2:b.json", "--password-file", "pw.txt"], /--watch --send takes --confirmations 144 or more on Arbitrum Sepolia/],
  [["release", "--watch", "10", "--send", "--network", "sepolia,base-sepolia", "--confirmations", "sepolia=2,base-sepolia=180", "--member-keys", "1:a.json,2:b.json", "--password-file", "pw.txt"], /--watch --send takes --confirmations 3 or more: reorgs of one or two blocks happen on Sepolia/],
  [["release", "--watch", "10", "--network", "base-sepolia", "--fast-budget", "2"], /--fast-budget is for fast mode: add --confirmations <n>/],
];

interface Run {
  code: number | null;
  out: string;
}

/** Every chain's RPC a closed local port. */
const ENV = { SEPOLIA_RPC_URL: CLOSED, BASE_SEPOLIA_RPC_URL: CLOSED, ARBITRUM_SEPOLIA_RPC_URL: CLOSED, BASE_SEPOLIA_ARCHIVE_RPC_URLS: CLOSED, ARBITRUM_SEPOLIA_ARCHIVE_RPC_URLS: CLOSED };

/** The tool with `args`; a child that runs past 90 s is killed, so none outlives its test. */
function run(args: string[], env: Record<string, string> = {}): Promise<Run> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/release.ts", ...args], { cwd: RELAYER, env: { ...process.env, ...ENV, ...env }, windowsHide: true });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    const kill = setTimeout(() => child.kill(), 90_000);
    child.on("error", (error) => {
      clearTimeout(kill);
      fail(error);
    });
    child.on("close", (code) => {
      clearTimeout(kill);
      done({ code, out });
    });
  });
}

/** `items` mapped with at most `limit` running at a time. */
async function pooled<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

describe("release.ts command lines with --network", () => {
  it(`refuses each of ${CASES.length} argument errors with exit code 1, its message and the usage, before any request`, { timeout: 600_000 }, async () => {
    const runs = await pooled(CASES, 4, ([args]) => run(args));
    CASES.forEach(([args, message], i) => {
      const { code, out } = runs[i];
      const line = `npm run release -- ${args.join(" ")}`;
      assert.equal(code, 1, `${line}: exit code ${code}\n${out}`);
      assert.match(out, message, `${line}\n${out}`);
      assert.match(out, /usage \(from relayer\/\):/, `${line}: no usage\n${out}`);
      assert.match(out, /--network sepolia\|base-sepolia\|arbitrum-sepolia: the chain of the burn/, `${line}: the usage names --network\n${out}`);
      assert.doesNotMatch(out, /unreachable|ECONNREFUSED|fetch failed/i, `${line}: a request was made\n${out}`);
    });
  });
});

/** Files the test below hands the tool, in one folder, written over each time. */
const SCRATCH = join(tmpdir(), "bz-release-networks-test");
const MULTISIG = (JSON.parse(readFileSync(join(RELAYER, "..", "deployments", "v3-testnet.json"), "utf8")) as { vault: { committee: { multisig: string } } }).vault.committee.multisig;

describe("the watcher over several chains", () => {
  it("keeps to the committee's one lock: a second watcher, for other chains, does not start while the first runs", { timeout: 120_000 }, async () => {
    mkdirSync(SCRATCH, { recursive: true });
    for (const name of ["member-1.json", "member-2.json", "password.txt"]) writeFileSync(join(SCRATCH, name), "{}");
    const home = join(SCRATCH, "home");
    mkdirSync(join(home, ".bridge-zero"), { recursive: true });
    // A running watcher's lock (this test process's): one per committee, whatever its chains.
    writeFileSync(join(home, ".bridge-zero", `release-watch-${MULTISIG}.lock`), JSON.stringify({ pid: process.pid, token: "a running watcher", since: new Date().toISOString(), holder: "the watcher" }));
    const { code, out } = await run(
      [
        "release", "--watch", "10", "--rounds", "1", "--send",
        "--network", "base-sepolia,arbitrum-sepolia", "--confirmations", "base-sepolia=180,arbitrum-sepolia=144",
        "--member-keys", `1:${join(SCRATCH, "member-1.json")},2:${join(SCRATCH, "member-2.json")}`, "--password-file", join(SCRATCH, "password.txt"),
        "--rpc", "ws://127.0.0.1:9", "--evm", CLOSED,
      ],
      { USERPROFILE: home, HOME: home },
    );
    assert.equal(code, 1, out);
    assert.match(out, /for the burns on Base Sepolia, Arbitrum Sepolia, a round every 10 s on each/);
    assert.match(out, new RegExp(`the watcher \\(process ${process.pid}\\) holds .*release-watch-${MULTISIG}\\.lock`));
    assert.match(out, /another run with --send \(the watcher, or an approval or a cancellation by hand\) holds the committee's lock: this watcher does not start/);
    assert.doesNotMatch(out, /unreachable|ECONNREFUSED|fetch failed/i, out);
  });
});
