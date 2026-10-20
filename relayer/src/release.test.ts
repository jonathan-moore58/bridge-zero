// The command lines release.ts refuses: each argument error ends in exit code 1 with its message
// and the usage, before any request. The tool runs as a child process whose Sepolia RPC is a closed
// local port, so a command line that slipped past its checks would end otherwise (exit code 2).
//
//   npm test

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
function run(args: string[]): Promise<Run> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/release.ts", ...args], {
      cwd: RELAYER,
      env: { ...process.env, SEPOLIA_RPC_URL: "http://127.0.0.1:9" },
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
