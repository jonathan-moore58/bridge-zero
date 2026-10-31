// Re-encrypts committee members 1 and 2 (polkadot-js sr25519 keystores) under one fresh random
// password that only the server will hold: the release watcher opens both keys with one
// --password-file, and the password that opens them where they are now opens neither new copy. Run it
// once, on the machine that holds the keys now, from the checkout's relayer/ folder (after npm ci
// there), so that it uses the relayer's own @polkadot/keyring:
//
//   cd relayer
//   node ../ops/server/reencrypt-committee.mjs --password-file <the file that opens them now>
//
// Options (defaults in brackets): --password-file <file> (required), --out <new folder>
// [~/.bridge-zero-server], --members-dir <folder> [~/.bridge-zero/committee], --record <file>
// [../deployments/v3-testnet.json].
//
// What it does, in order; it stops at the first failure:
// 1. Opens member-1.json and member-2.json exactly as the release watcher does (release.ts
//    loadMemberKey): the file must be a polkadot-js sr25519 keystore whose address is member k of the
//    committee in deployments/v3-testnet.json, the password is the password file less one trailing line
//    end, and the opened key must sign and verify as that member. Nothing is written before both open.
// 2. Makes the new folder (it refuses one that exists), readable by this account alone (mode 700; on
//    Windows, an access list for this account's SID).
// 3. Writes member-1.json and member-2.json, re-encrypted with pair.toJson(<new password>) (scrypt and
//    xsalsa20-poly1305, the keyring's defaults), and bz-committee-server.pw: 43 characters of base64url
//    from 32 random bytes, with no line end and no BOM.
// 4. Reads the three files back as the watcher will, with a new keyring: each key must open with the
//    new password file, be the same member, and sign and verify; the old password must not open it.
// It prints addresses and paths only: no password, no key, no part of any key file, and errors
// without their text.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const fail = (why) => {
  console.log(`FAIL ${why}`);
  process.exit(1);
};

let args;
try {
  args = parseArgs({
    options: { out: { type: "string" }, "members-dir": { type: "string" }, "password-file": { type: "string" }, record: { type: "string" } },
  }).values;
} catch {
  fail("usage: node reencrypt-committee.mjs --password-file <file> [--out <new folder>] [--members-dir <folder>] [--record <v3-testnet.json>]");
}
if (args["password-file"] === undefined) fail("--password-file <file> is required: the file that opens member-1.json and member-2.json now");
const home = homedir();
const out = resolve(args.out ?? join(home, ".bridge-zero-server"));
const membersDir = resolve(args["members-dir"] ?? join(home, ".bridge-zero", "committee"));
const oldPasswordFile = resolve(args["password-file"]);
const recordPath = resolve(args.record ?? join(process.cwd(), "..", "deployments", "v3-testnet.json"));
const MEMBERS = [1, 2];
const NEW_PASSWORD_FILE = "bz-committee-server.pw";
const MESSAGE = new TextEncoder().encode("bridge-zero committee key check");

// The relayer's own packages: the folder this runs from must be the checkout's relayer/ folder.
let pkg;
try {
  pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
} catch {
  pkg = null;
}
if (pkg?.name !== "@bridge-zero/relayer") fail("run this from the checkout's relayer/ folder (its package.json names @bridge-zero/relayer)");
const require = createRequire(join(process.cwd(), "package.json"));
const { Keyring, packageInfo } = require("@polkadot/keyring");
const { cryptoWaitReady } = require("@polkadot/util-crypto");
await cryptoWaitReady();

/** The password exactly as the watcher reads it (release.ts:1828): the file less one trailing line end. */
const readPassword = (path, what) => {
  try {
    return readFileSync(path, "utf8").replace(/\r?\n$/, "");
  } catch {
    return fail(`${what} could not be read`);
  }
};

/** Member k's key file opened as release.ts loadMemberKey opens it; returns the opened pair. */
function openMember(keyring, path, password, expected, what) {
  let json;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(`${what} could not be read as JSON`);
  }
  if (typeof json?.encoded !== "string" || !Array.isArray(json.encoding?.content) || !json.encoding.content.includes("sr25519")) fail(`${what} is not a polkadot-js sr25519 keystore`);
  let address = null;
  try {
    if (typeof json.address === "string") address = keyring.encodeAddress(keyring.decodeAddress(json.address), 42);
  } catch {
    // not an address
  }
  if (address !== expected) fail(`${what} is not the keystore of ${expected}`);
  let pair;
  try {
    pair = keyring.addFromJson(json);
    pair.decodePkcs8(password);
  } catch {
    fail(`${what}: the password file does not open it`);
  }
  if (pair.address !== expected || !pair.verify(MESSAGE, pair.sign(MESSAGE), pair.publicKey)) fail(`${what} does not sign as ${expected}`);
  return { pair, json };
}

// The committee's members, as the watcher takes them (release.ts vaultFacts): member k is members[k-1].
let members;
try {
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  const keyring = new Keyring({ type: "sr25519", ss58Format: 42 });
  members = record.vault.committee.members.map((m) => keyring.encodeAddress(keyring.decodeAddress(m), 42));
} catch {
  fail(`${recordPath} names no committee (vault.committee.members)`);
}

console.log(`@polkadot/keyring ${packageInfo.version} (${packageInfo.path}); committee from ${recordPath}`);
const oldPassword = readPassword(oldPasswordFile, "the old password file");

// 1. Both originals open, before anything is written.
const keyring = new Keyring({ type: "sr25519", ss58Format: 42 });
const opened = new Map();
for (const k of MEMBERS) {
  const { pair } = openMember(keyring, join(membersDir, `member-${k}.json`), oldPassword, members[k - 1], `member-${k}.json`);
  opened.set(k, pair);
  console.log(`ok   member ${k} ${pair.address}: the original opens with the old password file and signs as member ${k}`);
}

// 2. The new folder, this account's alone.
if (existsSync(out)) fail(`${out} exists: give --out a folder that does not exist yet (nothing was written)`);
try {
  mkdirSync(out, { mode: 0o700 });
} catch {
  fail(`${out} could not be made (nothing was written)`);
}
if (process.platform === "win32") {
  // By SID, from System32 by full path: an account named like its computer is otherwise read as the computer.
  const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  try {
    const sid = execFileSync(join(system32, "whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" }).trim().split(",").at(-1).replaceAll('"', "");
    if (!/^S-1-5-21-[0-9-]+$/.test(sid)) throw new Error("no SID");
    execFileSync(join(system32, "icacls.exe"), [out, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`], { stdio: "ignore" });
  } catch {
    fail(`${out} was made, but its access could not be limited to this account: remove the empty folder and run this again (nothing was written)`);
  }
}
console.log(`ok   ${out} made, readable by this account alone`);

// 3. The re-encrypted keys and the new password.
const newPassword = randomBytes(32).toString("base64url");
if (!/^[A-Za-z0-9_-]{43}$/.test(newPassword)) fail("the new password is not 43 base64url characters");
const pwPath = join(out, NEW_PASSWORD_FILE);
writeFileSync(pwPath, newPassword, { flag: "wx", mode: 0o600 });
for (const k of MEMBERS) {
  const json = opened.get(k).toJson(newPassword);
  const type = json.encoding?.type ?? [];
  if (!type.includes("scrypt") || !type.includes("xsalsa20-poly1305") || !json.encoding.content.includes("sr25519")) fail(`member ${k}: the new keystore would not be encrypted (nothing more written)`);
  writeFileSync(join(out, `member-${k}.json`), JSON.stringify(json), { flag: "wx", mode: 0o600 });
  opened.get(k).lock();
}

// 4. Read back as the watcher will.
const raw = readFileSync(pwPath);
if (raw.length !== 43 || raw[0] === 0xef || raw.includes(0x0a) || raw.includes(0x0d)) fail(`${pwPath} is not 43 bytes with no BOM and no line end`);
const fresh = new Keyring({ type: "sr25519", ss58Format: 42 });
const serverPassword = readPassword(pwPath, "the new password file");
for (const k of MEMBERS) {
  const path = join(out, `member-${k}.json`);
  const { pair, json } = openMember(fresh, path, serverPassword, members[k - 1], `the new member-${k}.json`);
  let oldOpens = true;
  try {
    new Keyring({ type: "sr25519", ss58Format: 42 }).addFromJson(json).decodePkcs8(oldPassword);
  } catch {
    oldOpens = false;
  }
  if (oldOpens) fail(`the new member-${k}.json opens with the old password: do not use it`);
  console.log(`ok   member ${k} ${pair.address}: the new key file opens with ${NEW_PASSWORD_FILE}, is the same member, signs, and the old password does not open it`);
  pair.lock();
}
console.log(`\nWritten (copy these three to the server, then keep or remove this folder as you decide):
  ${join(out, "member-1.json")}  ->  /home/ubuntu/.bridge-zero/committee/member-1.json
  ${join(out, "member-2.json")}  ->  /home/ubuntu/.bridge-zero/committee/member-2.json
  ${pwPath}  ->  /home/ubuntu/.foundry/${NEW_PASSWORD_FILE}
Nothing secret was printed.`);
