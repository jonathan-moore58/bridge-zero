// SPDX-License-Identifier: UNLICENSED
//
// What the Sepolia scripts share (test/fork/simulate-sepolia.mjs, script/deploy-sepolia.mjs and
// relayer/src/relay.ts): keccak-256 and blake2b, ABI encoding, SCALE compact, CREATE addresses,
// the JSON-RPC client, the forge artifacts with their libraries linked, the light client and
// ProvenBalance calls built from one fixtures directory, and the way a transaction is priced,
// signed, sent and followed to its receipt. Plain Node, no dependencies.

import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const RPC = process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
export const CAP = 16_777_216;
export const SEPOLIA_CHAIN_ID = 11_155_111n;
export const REQUEST_GAS = 50_000_000; // what public RPCs let one eth_simulateV1 request use
export const RECEIPT_TIMEOUT = 20 * 60_000;

const here = dirname(fileURLToPath(import.meta.url));
export const CONTRACTS = join(here, "..", "..");
export const OUT = join(CONTRACTS, "out");
export const FIXTURES = join(CONTRACTS, "..", "fixtures");

// ------------------------------------------------------------------ keccak-256

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const M64 = (1n << 64n) - 1n;
const rotl = (v, n) => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & M64);

function keccakF(A) {
  for (let round = 0; round < 24; round++) {
    const C = [0, 1, 2, 3, 4].map((x) => A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20]);
    for (let x = 0; x < 5; x++) {
      const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) A[x + y] ^= D;
    }
    const B = new Array(25);
    for (let x = 0; x < 5; x++)
      for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], ROT[x + 5 * y]);
    for (let x = 0; x < 5; x++)
      for (let y = 0; y < 25; y += 5) A[x + y] = B[x + y] ^ (~B[((x + 1) % 5) + y] & M64 & B[((x + 2) % 5) + y]);
    A[0] ^= RC[round];
  }
}

export function keccak256(bytes) {
  const rate = 136;
  const padded = new Uint8Array(Math.floor(bytes.length / rate + 1) * rate);
  padded.set(bytes);
  padded[bytes.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const A = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + 8 * i + b]);
      A[i] ^= lane;
    }
    keccakF(A);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) for (let b = 0; b < 8; b++) out[8 * i + b] = Number((A[i] >> BigInt(8 * b)) & 0xffn);
  return out;
}

// ------------------------------------------------------------------ bytes and ABI

export const hex = (b) => "0x" + Buffer.from(b).toString("hex");
export const bytes = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));
export const concat = (...parts) => Uint8Array.from(Buffer.concat(parts.map((p) => Buffer.from(p))));
export const word = (n) => bytes(BigInt(n).toString(16).padStart(64, "0"));
export const padRight = (b) => concat(b, new Uint8Array((32 - (b.length % 32)) % 32));

// Head/tail ABI encoding of a parameter list. A value is {word} (static, 32 bytes), {bytes},
// {words} (bytes32[]) or {list} (bytes[]).
export function encode(params) {
  const heads = [];
  const tails = [];
  let tailOffset = 32 * params.length;
  for (const p of params) {
    if (p.word) {
      heads.push(p.word);
      continue;
    }
    let tail;
    if (p.bytes) tail = concat(word(p.bytes.length), padRight(p.bytes));
    else if (p.words) tail = concat(word(p.words.length), ...p.words);
    else tail = concat(word(p.list.length), encode(p.list.map((b) => ({ bytes: b }))));
    heads.push(word(tailOffset));
    tails.push(tail);
    tailOffset += tail.length;
  }
  return concat(...heads, ...tails);
}

// CREATE address of `sender` at `nonce`: the last 20 bytes of keccak256(rlp([sender, nonce])).
export function createAddress(sender, nonce) {
  const digits = BigInt(nonce).toString(16);
  const be = BigInt(nonce) === 0n ? new Uint8Array() : bytes(digits.padStart(digits.length + (digits.length % 2), "0"));
  const n = be.length === 1 && be[0] < 0x80 ? be : concat(Uint8Array.of(0x80 + be.length), be);
  const body = concat(Uint8Array.of(0x94), bytes(sender), n);
  return hex(keccak256(concat(Uint8Array.of(0xc0 + body.length), body)).slice(12));
}

// ------------------------------------------------------------------ blake2b (RFC 7693)

const B2_IV = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];
const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];
const rotr = (v, n) => ((v >> BigInt(n)) | (v << BigInt(64 - n))) & M64;

export function blake2b(data, outlen) {
  const h = B2_IV.slice();
  h[0] ^= 0x01010000n ^ BigInt(outlen);
  const blocks = Math.max(1, Math.ceil(data.length / 128));
  for (let b = 0; b < blocks; b++) {
    const last = b === blocks - 1;
    const chunk = new Uint8Array(128);
    chunk.set(data.slice(128 * b, 128 * b + 128));
    const m = [];
    for (let i = 0; i < 16; i++) {
      let w = 0n;
      for (let k = 7; k >= 0; k--) w = (w << 8n) | BigInt(chunk[8 * i + k]);
      m.push(w);
    }
    const v = [...h, ...B2_IV];
    v[12] ^= BigInt(last ? data.length : 128 * (b + 1));
    if (last) v[14] ^= M64;
    const G = (a, c, e, d, x, y) => {
      v[a] = (v[a] + v[c] + x) & M64;
      v[d] = rotr(v[d] ^ v[a], 32);
      v[e] = (v[e] + v[d]) & M64;
      v[c] = rotr(v[c] ^ v[e], 24);
      v[a] = (v[a] + v[c] + y) & M64;
      v[d] = rotr(v[d] ^ v[a], 16);
      v[e] = (v[e] + v[d]) & M64;
      v[c] = rotr(v[c] ^ v[e], 63);
    };
    for (let r = 0; r < 12; r++) {
      const s = SIGMA[r % 10];
      G(0, 4, 8, 12, m[s[0]], m[s[1]]);
      G(1, 5, 9, 13, m[s[2]], m[s[3]]);
      G(2, 6, 10, 14, m[s[4]], m[s[5]]);
      G(3, 7, 11, 15, m[s[6]], m[s[7]]);
      G(0, 5, 10, 15, m[s[8]], m[s[9]]);
      G(1, 6, 11, 12, m[s[10]], m[s[11]]);
      G(2, 7, 8, 13, m[s[12]], m[s[13]]);
      G(3, 4, 9, 14, m[s[14]], m[s[15]]);
    }
    for (let i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
  }
  const out = new Uint8Array(outlen);
  for (let i = 0; i < outlen; i++) out[i] = Number((h[i >> 3] >> BigInt(8 * (i & 7))) & 0xffn);
  return out;
}

// ------------------------------------------------------------------ SCALE

export const le = (v, n) => {
  const out = new Uint8Array(n);
  let x = BigInt(v);
  for (let i = 0; i < n; i++, x >>= 8n) out[i] = Number(x & 0xffn);
  return out;
};
export function compact(v) {
  if (v < 1 << 6) return Uint8Array.of(v << 2);
  if (v < 1 << 14) return le((v << 2) | 1, 2);
  if (v < 2 ** 30) return le(v * 4 + 2, 4);
  throw new Error("compact: value too large for this script");
}
export const compactLen = (v) => compact(v).length;
export const filled = (byte) => new Uint8Array(32).fill(byte);

// ------------------------------------------------------------------ fixtures

// The signers hint: 2 bytes per precommit (position, authority index), sorted by index.
export function signersOf(json) {
  const list = json.justification.precommits.map((p, i) => [i, Number(p.authorityIndex)]);
  list.sort((a, b) => a[1] - b[1]);
  return { hint: Uint8Array.from(list.flat()), first: list[0] };
}

// ------------------------------------------------------------------ RPC

// The whole JSON-RPC response, error included.
export async function rpcBody(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(120_000),
  });
  return res.json();
}

export async function rpc(method, params) {
  const body = await rpcBody(method, params);
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

export let failed = false;
export function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed = true;
  return ok;
}
export const fmt = (n) => n.toLocaleString("en-US");
export const share = (used) => `${fmt(used)} gas, ${((100 * used) / CAP).toFixed(1)}% of the 16,777,216 cap`;
export const qty = (n) => "0x" + BigInt(n).toString(16);
export const gasOf = (r) => Number(BigInt(r.gasUsed));
export const withHeadroom = (used) => Math.min(CAP, used + Math.ceil(used / 10));
export const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
export const eth = (wei) => {
  const s = wei.toString().padStart(19, "0");
  const frac = s.slice(-18).replace(/0+$/, "");
  return `${s.slice(0, -18)}${frac ? "." + frac : ""} ETH`;
};

// The first log of `address` with topic0 `t` (and topic1 `first`, when given).
export const findLog = (logs, address, t, first) =>
  (logs ?? []).find((l) => l.address.toLowerCase() === address && l.topics[0] === t && (!first || l.topics[1] === first));
export const dataWord = (log, i) => BigInt(hex(bytes(log.data).slice(32 * i, 32 * i + 32)));

// The probe answers, for each 32-byte word of its calldata (an address), EXTCODEHASH and BALANCE.
// A simulation gives it this code and its own sender a balance, and calls it last in a simulated
// block: where deployments landed, and what is left of a sender's balance.
export const PROBE = "0x00000000000000000000000000000000b21dc0de";
export const PROBE_SENDER = "0x00000000000000000000000000000000b21d6e01";
export const PROBE_CODE = "0x5f5b80361115601f578035803f8280015231818001602001526020016001565b3680015ff3";
export const PROBE_GAS = 100_000;

// ------------------------------------------------------------------ artifacts

// forge's output file of each contract the scripts deploy.
const ARTIFACT_FILES = {
  SCL_EIP6565: "libSCL_EIP6565.sol",
  GrandpaCodec: "GrandpaCodec.sol",
  AuthoritySets: "AuthoritySets.sol",
  StorageProofs: "StorageProofs.sol",
  GrandpaLightClient: "GrandpaLightClient.sol",
  ProvenBalance: "ProvenBalance.sol",
};
const artifacts = {};
export function artifact(name, out = OUT) {
  if (!ARTIFACT_FILES[name]) throw new Error(`no artifact for ${name}`);
  const key = `${out}|${name}`;
  artifacts[key] ??= JSON.parse(readFileSync(join(out, ARTIFACT_FILES[name], `${name}.json`), "utf8"));
  return artifacts[key];
}
// `<source path>:<name>`, as forge names the contract.
export function contractId(name) {
  const [path] = Object.keys(artifact(name).metadata.settings.compilationTarget);
  return `${path}:${name}`;
}
export const selector = (name, sig) => {
  const s = artifact(name).methodIdentifiers[sig];
  if (!s) throw new Error(`${name} has no ${sig}`);
  return bytes(s);
};
export const errorSelector = (sig) => keccak256(Buffer.from(sig)).slice(0, 4);
export const topic = (sig) => hex(keccak256(Buffer.from(sig)));

// The libraries `name` links, as `<source path>:<library>` => library name.
export function linkedLibraries(name) {
  const out = {};
  for (const [file, refs] of Object.entries(artifact(name).bytecode.linkReferences))
    for (const lib of Object.keys(refs)) out[`${file}:${lib}`] = lib;
  return out;
}

// Creation code of `name` with every library placeholder replaced by the library's address in
// `addresses` (library name => address).
export function linkedCode(name, addresses) {
  const a = artifact(name);
  let code = a.bytecode.object;
  for (const refs of Object.values(a.bytecode.linkReferences)) {
    for (const [lib, offsets] of Object.entries(refs)) {
      if (!addresses[lib]) throw new Error(`${name} links ${lib}, which is not deployed here`);
      for (const { start, length } of offsets)
        code = code.slice(0, 2 + 2 * start) + addresses[lib].slice(2) + code.slice(2 + 2 * (start + length));
    }
  }
  if (code.includes("__$")) throw new Error(`unlinked placeholder left in ${name}`);
  return code;
}

// ------------------------------------------------------------------ calls

export const initCall = (genesis, setId, keys, checkpointHeader) =>
  concat(
    selector("GrandpaLightClient", "initialize(bytes32,uint64,bytes32[],bytes)"),
    encode([{ word: genesis }, { word: word(setId) }, { words: keys }, { bytes: checkpointHeader }]),
  );
export const importCall = (header, justification, signers) =>
  concat(
    selector("GrandpaLightClient", "importHeader(bytes,bytes,bytes)"),
    encode([{ bytes: header }, { bytes: justification }, { bytes: signers }]),
  );

// The calls one fixtures directory supports (set-change.json, finality-proof-head.json and
// account-proof.json): initialize with the set that signs the set change, the set change's
// import, and importAndProve at the head, as is and with one signature byte flipped. The
// checkpoint is the set change's parent; with `announced` it is the set change that started
// the signing set (signingSet.announced), when the capture holds it.
export function fixtureCalls(dir, { checkpoint = "parent" } = {}) {
  const read = (name) => JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8"));
  const sc = read("set-change");
  const fp = read("finality-proof-head");
  const ap = read("account-proof");
  const at = (checkpoint === "announced" && sc.signingSet.announced?.header) || sc.parentHeader;
  const initData = initCall(
    bytes(sc.provenance.genesisHash),
    sc.signingSet.setId,
    sc.signingSet.authorities.map((a) => bytes(a.id)),
    bytes(at.scale),
  );
  const changeData = importCall(bytes(sc.header.scale), bytes(sc.justification.scale), signersOf(sc).hint);
  const head = signersOf(fp);
  const proveData = (finalityProof) =>
    concat(
      selector("ProvenBalance", "importAndProve(bytes,bytes,bytes,bytes32,bytes[])"),
      encode([
        { bytes: bytes(fp.header.scale) },
        { bytes: finalityProof },
        { bytes: head.hint },
        { word: bytes(ap.account.id) },
        { list: ap.proof.nodes.map(bytes) },
      ]),
    );
  const finalityProof = bytes(fp.finalityProof.scale);
  const tampered = Uint8Array.from(finalityProof);
  // First counted precommit's signature, byte 0 of R (see SepoliaFork.t.sol). FinalityProof =
  // block hash, compact length, justification; the precommits start after round, target hash,
  // target number and their compact count, and are 132 bytes each.
  const precommits = 44 + compactLen(fp.justification.precommits.length);
  tampered[32 + compactLen(bytes(fp.justification.scale).length) + precommits + head.first[0] * 132 + 36] ^= 0x01;
  // What the tampered call reverts with: InvalidSignature(0, authority index of the first signer).
  const invalidSignature = hex(
    concat(errorSelector("InvalidSignature(uint256,uint256)"), word(0), word(head.first[1])),
  );
  return { sc, fp, ap, checkpoint: at, initData, changeData, head, proveData, finalityProof, tampered, invalidSignature };
}

// ------------------------------------------------------------------ fees

// An amount in gwei ("0.001") in wei. Throws on anything else, and on less than 1 wei.
export function parseGwei(s) {
  const m = /^(\d+)(?:\.(\d{1,9}))?$/.exec(s);
  if (!m) throw new Error(`not an amount in gwei: ${s}`);
  const wei = BigInt(m[1]) * 10n ** 9n + BigInt((m[2] ?? "").padEnd(9, "0"));
  if (wei < 1n) throw new Error(`${s} gwei is less than 1 wei`);
  return wei;
}

// Fees fixed for a whole run: a priority fee of 1,000 wei (above what most Sepolia blocks pay)
// and a max fee of ten times the next base fee plus it, at least 0.01 gwei, so a rising base fee
// cannot stall the run; `priorityFee` and `maxFee` (wei) replace them.
export async function feesAt(block, { priorityFee, maxFee } = {}) {
  const history = await rpc("eth_feeHistory", ["0x1", block.number, []]);
  const base = BigInt(history.baseFeePerGas.at(-1));
  const tip = priorityFee ?? 1_000n;
  const floor = 10n * base + tip;
  const max = maxFee ?? (floor > 10_000_000n ? floor : 10_000_000n);
  return { base, tip, maxFee: max, gasPrice: BigInt(await rpc("eth_gasPrice", [])) };
}

// ------------------------------------------------------------------ send

// Tool and RPC messages without a custom RPC URL (it can hold a key) or what redactAlso was given,
// such as the password file's path (also as Foundry prints it, with doubled backslashes).
const secrets = [];
export function redactAlso(...values) {
  for (const v of values) if (v) secrets.push(v, v.replaceAll("\\", "\\\\"));
}
export const redact = (text) =>
  [process.env.SEPOLIA_RPC_URL, ...secrets]
    .filter(Boolean)
    .reduce((t, s) => t.split(s).join("<redacted>"), String(text ?? ""))
    .trim();

// cast and forge run without the environment variables that would add a sender, a key, a gas
// setting or libraries to what is passed to them here.
export function toolEnv(keep = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env))
    if (!/^(ETH|CAST|TEMPO|FOUNDRY|ETHERSCAN|VERIFIER|DAPP)_/i.test(k) && k.toUpperCase() !== "CHAIN") env[k] = v;
  return { ...env, ...keep };
}
// cast runs in an empty directory of its own, removed on exit: Foundry loads the .env file of the
// directory it runs in and of the project root above it (contracts/ would be one), which would
// put back what toolEnv leaves out.
let castDir;
export function cast(args) {
  if (!castDir) {
    castDir = mkdtempSync(join(tmpdir(), "bz-cast-"));
    process.on("exit", () => rmSync(castDir, { recursive: true, force: true }));
  }
  return spawnSync("cast", args, { cwd: castDir, env: toolEnv(), encoding: "utf8", windowsHide: true, maxBuffer: 1 << 26 });
}

// A read that a load-balanced RPC can briefly fail on a block it has not seen yet.
export async function retry(what, fn) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === 10) throw err;
      console.log(`     (${what}: ${redact(err.message)}; retrying)`);
      await sleep(3_000);
    }
  }
}

export async function nonces(address) {
  const count = async (which) => Number(BigInt(await rpc("eth_getTransactionCount", [address, which])));
  return { latest: await count("latest"), pending: await count("pending") };
}

// Waits until `nonce` is the next nonce of `address`, mined and pending, after the previous
// transaction's receipt (an RPC behind a load balancer can lag a block). False if it was used by
// something else.
export async function nextNonceIs(address, nonce) {
  const until = Date.now() + 60_000;
  for (;;) {
    const n = await retry("nonce", () => nonces(address));
    if (n.latest === nonce && n.pending === nonce) return true;
    if (n.latest > nonce || Date.now() > until) {
      check(false, `nonce ${nonce} is next (on chain: ${n.latest}, pending: ${n.pending})`);
      return false;
    }
    await sleep(3_000);
  }
}

export async function receiptOf(hash, wait) {
  const until = Date.now() + (wait ? RECEIPT_TIMEOUT : 0);
  for (;;) {
    const r = await retry("receipt", () => rpc("eth_getTransactionReceipt", [hash]));
    if (r || Date.now() >= until) return r;
    await sleep(4_000);
  }
}

// The address keystore `account` unlocks to with the password file, with cast on PATH; null, with
// what failed printed, otherwise. cast reads the password file; these scripts never do.
export function keystoreAddress(account, passwordFile) {
  if (cast(["--version"]).status !== 0) {
    console.log("FAIL cast is not on PATH");
    return null;
  }
  const who = cast(["wallet", "address", "--account", account, "--password-file", passwordFile]);
  const unlocked = /0x[0-9a-fA-F]{40}/.exec(who.stdout ?? "")?.[0];
  if (who.status !== 0 || !unlocked) {
    console.log(`FAIL cast wallet address could not open keystore ${account} with the password file`);
    return null;
  }
  return unlocked;
}

// Keystore `account` unlocks with the password file to `address` (the deployer). Prints what fails.
export function signerIs(address, account, passwordFile) {
  const unlocked = keystoreAddress(account, passwordFile);
  if (!unlocked) return false;
  return check(unlocked.toLowerCase() === address.toLowerCase(), `keystore ${account} is the deployer (${unlocked})`);
}

// The cast mktx arguments that sign transaction `name` with the keystore: explicit nonce, gas
// limit and fees, on Sepolia's chain id. Without `to`, `data` is creation code.
export function mktxArgs(name, { to, data, nonce, gasLimit, fees, account, passwordFile }) {
  const common = [
    "--rpc-url", RPC, "--chain", String(SEPOLIA_CHAIN_ID),
    "--account", account, "--password-file", passwordFile,
    "--nonce", String(nonce), "--gas-limit", String(gasLimit),
    "--gas-price", String(fees.maxFee), "--priority-gas-price", String(fees.tip),
  ];
  // The options come before --create, which is a subcommand; a call's raw calldata is the SIG argument.
  const args = to ? ["mktx", to, data, ...common] : ["mktx", ...common, "--create", data];
  if (args.join(" ").length > 30_000) throw new Error(`${name}: the cast command line is longer than Windows accepts`);
  return args;
}

// cast mktx signs (`args` from mktxArgs), `signed(hash)` records the hash, and only then cast
// publish broadcasts the transaction, so a crash at any point leaves a record the next run can
// reconcile. Returns the hash; null when cast mktx failed (printed under `label`).
export function signAndPublish(args, label, signed) {
  const out = cast(args);
  const raw = /0x[0-9a-fA-F]+/.exec(out.stdout ?? "")?.[0];
  if (out.status !== 0 || !raw) {
    console.log(`FAIL ${label}: cast mktx failed\n${redact(out.stderr || out.stdout)}`);
    return null;
  }
  const hash = hex(keccak256(bytes(raw)));
  signed(hash);
  const published = cast(["publish", raw, "--rpc-url", RPC, "--async"]);
  const sent = /0x[0-9a-fA-F]{64}/.exec(published.stdout ?? "")?.[0]?.toLowerCase();
  if (published.status !== 0 || sent !== hash)
    console.log(`     (cast publish: ${redact(published.stderr || published.stdout) || "no hash"}; waiting for ${hash} anyway)`);
  return hash;
}

// Writes a record as JSON through a temporary file, so an interrupted write never leaves half of
// it. Renaming over the old file can fail for a moment on Windows while something reads it.
export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path + ".tmp", JSON.stringify(value, null, 2) + "\n");
  for (let i = 1; ; i++) {
    try {
      renameSync(path + ".tmp", path);
      return;
    } catch (err) {
      if (i === 20 || !/EPERM|EBUSY|EACCES/.test(err.code ?? "")) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
}
