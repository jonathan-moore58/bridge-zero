// The command lines release.ts refuses: each argument error ends in exit code 1 with its message
// and the usage, before any request. The tool runs as a child process whose Sepolia RPC is a closed
// local port, so a command line that slipped past its checks would end otherwise (exit code 2).
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
const BURN = ["burn", "--amount", "0.5", "--v3-recipient", ADDRESS];
const RELEASE = ["release", "--burn-nonce", "0"];
const FUND = ["fund", "--member", "1", "--amount", "10"];

/** [the command line, what the tool has to say]. */
const CASES: [string[], RegExp][] = [
  [[], /no command/],
  [["bogus"], /unknown command "bogus"/],
  [["burn"], /burn needs --amount <wtPOT> and --v3-recipient <h160>/],
  [["burn", "--amount", "0.5"], /burn needs --amount <wtPOT> and --v3-recipient <h160>/],
  [["burn", "--amount", "0", "--v3-recipient", ADDRESS], /--amount: the amount is zero/],
  [["burn", "--amount", "0.000000000000001", "--v3-recipient", ADDRESS], /--amount: .*more than 14 decimals/],
  [["burn", "--amount", "1e3", "--v3-recipient", ADDRESS], /--amount: not an amount of wtPOT/],
  [["burn", "--amount", "0.5", "--v3-recipient", "0x0000000000000000000000000000000000000000"], /--v3-recipient: --v3-recipient is the zero address/],
  [["burn", "--amount", "0.5", "--v3-recipient", "0xD9838A86cF83C28Ee486544060D1cA4Ca2971070"], /fails its EIP-55 checksum/],
  [["burn", "--amount", "0.5", "--v3-recipient", "0x1234"], /must be 0x and 40 hex digits/],
  [[...BURN, "--account", "bz-deployer"], /--account and --password-file are for --send; a dry run signs nothing/],
  [[...BURN, "--send"], /--send needs --account <keystore name> and --password-file <path>/],
  [[...BURN, "--send", "--account", "bz-deployer", "--password-file", "no-such-file.txt"], /--password-file: no such file/],
  [[...BURN, "--send", "--from", ADDRESS, "--account", "bz-deployer", "--password-file", "no-such-file.txt"], /--from is for a dry run/],
  [[...BURN, "--from", "0x12"], /--from: --from must be 0x and 40 hex digits/],
  [[...BURN, "--max-fee", "abc"], /--max-fee: not an amount in gwei/],
  [[...BURN, "--priority-fee", "0.0000000001"], /--priority-fee: .*less than 1 wei|--priority-fee: not an amount in gwei/],
  [[...BURN, "--rpc", "http://127.0.0.1:9"], /--rpc must be a ws:\/\/ or wss:\/\/ URL/],
  [[...BURN, "--evm", "ws://127.0.0.1:9"], /--evm must be an http:\/\/ or https:\/\/ URL/],
  [[...BURN, "--unknown"], /Unknown option '--unknown'/],
  [[...BURN, "extra"], /Unexpected argument 'extra'|positional/i],
  [["release"], /release needs --burn-nonce <n>/],
  [["release", "--burn-nonce", "x"], /--burn-nonce: a burn nonce is a whole number/],
  [["release", "--burn-nonce=-1"], /--burn-nonce: a burn nonce is a whole number/],
  [["release", "--burn-nonce", "-1"], /Option .--burn-nonce. argument is ambiguous/],
  [["release", "--burn-nonce", "99999999999999999999"], /--burn-nonce: .* is above any nonce the minter will reach/],
  [[...RELEASE, "--approve", "--cancel", "--member", "1"], /choose one of --approve and --cancel/],
  [[...RELEASE, "--rehearse", "--amount", "1", "--to", ADDRESS, "--send", "--approve", "--member", "1"], /--rehearse is a dry run of a burn that is not on Sepolia/],
  [[...RELEASE, "--rehearse", "--cancel", "--member", "1", "--amount", "1", "--to", ADDRESS], /--rehearse is a dry run of a burn that is not on Sepolia/],
  [[...RELEASE, "--rehearse", "--amount", "1"], /--rehearse needs --amount <wtPOT> and --to <h160>/],
  [[...RELEASE, "--rehearse", "--to", ADDRESS], /--rehearse needs --amount <wtPOT> and --to <h160>/],
  [[...RELEASE, "--rehearse", "--amount", "0", "--to", ADDRESS], /--amount: the amount is zero/],
  [[...RELEASE, "--amount", "1"], /--amount is for --rehearse: a release pays exactly what its burn burned/],
  [[...RELEASE, "--approve"], /--approve needs --member <1\|2\|3>/],
  [[...RELEASE, "--cancel"], /--cancel needs --member <1\|2\|3>/],
  [[...RELEASE, "--member", "1"], /--member is for --approve and --cancel/],
  [[...RELEASE, "--approve", "--member", "4"], /--member: a member is 1, 2 or 3/],
  [[...RELEASE, "--approve", "--member", "one"], /--member: a member is 1, 2 or 3/],
  [[...RELEASE, "--send"], /--send signs an approval or a cancellation: add --approve or --cancel with --member/],
  [[...RELEASE, "--approve", "--member", "1", "--send"], /--send needs --key-file <member json> and --password-file <path>/],
  [[...RELEASE, "--approve", "--member", "1", "--send", "--key-file", "member-1.json"], /--send needs --key-file <member json> and --password-file <path>/],
  [[...RELEASE, "--approve", "--member", "1", "--key-file", "member-1.json"], /--key-file and --password-file are for --send; a dry run signs nothing/],
  [[...RELEASE, "--password-file", "pw.txt"], /--key-file and --password-file are for --send; a dry run signs nothing/],
  [[...RELEASE, "--approve", "--member", "1", "--send", "--key-file", "no-such-key.json", "--password-file", "no-such-file.txt"], /--key-file: no such file/],
  [[...RELEASE, "--to", "0x1234"], /--to: --to must be 0x and 40 hex digits/],
  [[...RELEASE, "--to", "0x0000000000000000000000000000000000000000"], /--to: --to is the zero address/],
  [[...RELEASE, "--confirmations", "0"], /--confirmations: from 1 to 64 blocks/],
  [[...RELEASE, "--confirmations", "65"], /--confirmations: from 1 to 64 blocks/],
  [[...RELEASE, "--confirmations", "x"], /--confirmations: a number of blocks is a whole number/],
  [[...RELEASE, "--fast-cap", "2"], /--fast-cap is for fast mode: add --confirmations <n>/],
  [[...RELEASE, "--confirmations", "3", "--fast-cap", "0"], /--fast-cap: the amount is zero/],
  [[...RELEASE, "--confirmations", "3", "--fast-cap", "1e3"], /--fast-cap: not an amount of tPOT/],
  [[...RELEASE, "--rehearse", "--amount", "1", "--to", ADDRESS, "--confirmations", "3"], /--confirmations reads a burn on Sepolia, and a rehearsal has none/],
  [[...RELEASE, "--rounds", "1"], /--rounds is for --watch/],
  [[...RELEASE, "--member-keys", "1:a.json,2:b.json"], /--member-keys is for --watch/],
  [[...RELEASE, "--state-dir", "state"], /--state-dir is for --watch/],
  [[...RELEASE, "--confirmations", "3", "--fast-budget", "2"], /--fast-budget is for --watch/],
  [["release", "--watch", "10", "--fast-budget", "2"], /--fast-budget is for fast mode: add --confirmations <n>/],
  [["release", "--watch", "10", "--confirmations", "3", "--fast-budget", "0"], /--fast-budget: the amount is zero/],
  [["release", "--watch", "5"], /--watch: from 10 to 86,400/],
  [["release", "--watch", "ten"], /--watch: a whole number/],
  [["release", "--watch", "10", "--burn-nonce", "0"], /--burn-nonce is for a release of one burn: --watch releases every burn that qualifies/],
  [["release", "--watch", "10", "--approve"], /--approve is for a release of one burn/],
  [["release", "--watch", "10", "--member", "1"], /--member is for a release of one burn/],
  [["release", "--watch", "10", "--rounds", "0"], /--rounds: from 1 to/],
  [["release", "--watch", "10", "--fast-cap", "1"], /--fast-cap is for fast mode/],
  [["release", "--watch", "10", "--send"], /--watch --send needs --member-keys <k>:<member json>,<j>:<member json> and --password-file <path>/],
  [["release", "--watch", "10", "--send", "--member-keys", "1:a.json,2:b.json"], /--watch --send needs --member-keys/],
  [["release", "--watch", "10", "--member-keys", "1:a.json,2:b.json"], /--member-keys and --password-file are for --send; a dry run signs nothing/],
  [["release", "--watch", "10", "--send", "--member-keys", "1:a.json", "--password-file", "pw.txt"], /--member-keys: two members run a release, got 1/],
  [["release", "--watch", "10", "--send", "--member-keys", "1:a.json,1:b.json", "--password-file", "pw.txt"], /--member-keys: member 1 is named twice/],
  [["release", "--watch", "10", "--send", "--member-keys", "1:no-such-a.json,2:no-such-b.json", "--password-file", "no-such-file.txt"], /--member-keys \(member 1\): no such file/],
  [["fund"], /fund takes --member <1\|2\|3> or --multisig/],
  [["fund", "--member", "1", "--multisig", "--amount", "1"], /fund takes --member <1\|2\|3> or --multisig/],
  [["fund", "--member", "1"], /fund needs --amount <tPOT>/],
  [["fund", "--member", "0", "--amount", "1"], /--member: a member is 1, 2 or 3/],
  [["fund", "--member", "1", "--amount", "0.000000000000001"], /--amount: .*more than 14 decimals/],
  [["fund", "--multisig", "--amount", "0"], /--amount: the amount is zero/],
  [[...FUND, "--send"], /--send needs --key-file <path> \(JSON with .substrate.mnemonic\)/],
  [[...FUND, "--key-file", "key.json"], /--key-file is for --send; a dry run signs nothing/],
  [[...FUND, "--send", "--key-file", "no-such-key.json"], /--key-file: no such file/],
  [[...FUND, "--from", "bogus"], /--from: /],
  [["status", "--vault", ADDRESS], /Unknown option '--vault'/],
  [["status", "--rpc", "https://test-node-v3.portaldot.dev"], /--rpc must be a ws:\/\/ or wss:\/\/ URL/],
];

interface Run {
  code: number | null;
  out: string;
}

/** The tool with `args`, every network endpoint a closed local port. */
function run(args: string[], env: Record<string, string> = {}): Promise<Run> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/release.ts", ...args], {
      cwd: RELAYER,
      env: { ...process.env, SEPOLIA_RPC_URL: "http://127.0.0.1:9", ...env },
      windowsHide: true,
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", fail);
    child.on("close", (code) => done({ code, out }));
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

describe("release.ts command lines", () => {
  it(`refuses each of ${CASES.length} argument errors with exit code 1, its message and the usage, before any request`, { timeout: 600_000 }, async () => {
    const runs = await pooled(CASES, 8, ([args]) => run(args));
    CASES.forEach(([args, message], i) => {
      const { code, out } = runs[i];
      const line = `npm run release -- ${args.join(" ")}`;
      assert.equal(code, 1, `${line}: exit code ${code}\n${out}`);
      assert.match(out, message, `${line}\n${out}`);
      assert.match(out, /usage \(from relayer\/\):/, `${line}: no usage\n${out}`);
      assert.doesNotMatch(out, /unreachable|ECONNREFUSED|fetch failed/i, `${line}: a request was made\n${out}`);
    });
  });
});

/** Files the tests below hand the tool, in one folder for every run, written over each time: nothing to clean up. */
const SCRATCH = join(tmpdir(), "bz-release-test");
const MULTISIG = (JSON.parse(readFileSync(join(RELAYER, "..", "deployments", "v3-testnet.json"), "utf8")) as { vault: { committee: { multisig: string } } }).vault.committee.multisig;
const OFFLINE = ["--rpc", "ws://127.0.0.1:9", "--evm", "http://127.0.0.1:9"];

/** Stand-ins for the key files and the password file: the tool refuses before it opens them. */
function keyFiles(): string[] {
  mkdirSync(SCRATCH, { recursive: true });
  for (const name of ["member-1.json", "member-2.json", "password.txt"]) writeFileSync(join(SCRATCH, name), "{}");
  return ["--member-keys", `1:${join(SCRATCH, "member-1.json")},2:${join(SCRATCH, "member-2.json")}`, "--password-file", join(SCRATCH, "password.txt")];
}

/** A home folder of the tests' own (USERPROFILE and HOME), whose .bridge-zero holds a live watcher's lock: this test process's. */
function homeWithLock(): Record<string, string> {
  const home = join(SCRATCH, "home");
  mkdirSync(join(home, ".bridge-zero"), { recursive: true });
  writeFileSync(join(home, ".bridge-zero", `release-watch-${MULTISIG}.lock`), JSON.stringify({ pid: process.pid, token: "a running watcher", since: new Date().toISOString() }));
  return { USERPROFILE: home, HOME: home };
}

describe("the watcher's lock, in the home folder", () => {
  it("keeps a second watcher of the committee from sending, whatever its --state-dir", { timeout: 120_000 }, async () => {
    const { code, out } = await run(["release", "--watch", "10", "--send", ...keyFiles(), "--state-dir", join(SCRATCH, "elsewhere"), ...OFFLINE], homeWithLock());
    assert.equal(code, 1, out);
    assert.match(out, new RegExp(`another watcher \\(process ${process.pid}\\) runs for this committee`));
    assert.doesNotMatch(out, /unreachable|ECONNREFUSED|fetch failed/i, out);
  });
});

describe("release --watch after a fatal stop", () => {
  it("refuses to start with --send while the halt file is there, with exit code 4 and before any request", { timeout: 120_000 }, async () => {
    const stateDir = join(SCRATCH, "halted");
    mkdirSync(stateDir, { recursive: true });
    const halt = join(stateDir, `release-watch-${MULTISIG}.halt`);
    writeFileSync(halt, JSON.stringify({ reason: "member 2's approval failed its checks", burn: "3", extrinsicHash: "0xfeed", at: "2026-10-24T10:00:00.000Z" }));
    // A home folder of its own too: the real one's .bridge-zero is never touched.
    const home = join(SCRATCH, "home-halted");
    mkdirSync(home, { recursive: true });
    const { code, out } = await run(["release", "--watch", "10", "--send", ...keyFiles(), "--state-dir", stateDir, ...OFFLINE], { USERPROFILE: home, HOME: home });
    assert.equal(code, 4, out);
    assert.match(out, /the watcher does not start: a fatal stop at 2026-10-24T10:00:00.000Z: member 2's approval failed its checks \(burn 3, extrinsic 0xfeed\); look at it, then remove /);
    assert.doesNotMatch(out, /unreachable|ECONNREFUSED|fetch failed/i, out);
  });
});
