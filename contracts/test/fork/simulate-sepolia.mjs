// SPDX-License-Identifier: UNLICENSED
//
// Runs the deployment, the mainnet import and the System.Account proof on a Sepolia node itself,
// with eth_simulateV1 (validation on) at the latest block. Every deployment and every call is
// sent with the EIP-7825 cap (16,777,216) as its gas limit:
//   1. deploy the linked libraries SCL_EIP6565, GrandpaCodec, AuthoritySets and StorageProofs,
//      GrandpaLightClient and ProvenBalance, each linked to the simulated library addresses,
//      and report each deployment's gas against the cap;
//   2. call initialize, importHeader (set change) and importAndProve (head), importAndProve
//      again (re-verification), then a tampered importAndProve that has to revert.
// The node executes everything under the rules Sepolia runs now; nothing is signed or sent (the
// sender's balance and nonce are state overrides).
//
// Usage (from contracts/, after `forge build`):
//   node test/fork/simulate-sepolia.mjs
//   node test/fork/simulate-sepolia.mjs --set-change 10 16 25
//
// --set-change N... also runs, for each N, a set change of N authorities to N new keys (the
// heaviest set change for a set of N: threshold(N) signatures, then N new keys derived and
// stored) on a fresh copy of the light client: initialize with N keys, then importHeader. The
// keys, header and justification are generated here (deterministic ed25519 keys, a header with a
// FRNK ScheduledChange, precommits signed with node:crypto). When the set change does not fit
// the cap it is run again with twice the cap, to report what it needs.
// The RPC is SEPOLIA_RPC_URL when set, else the public endpoint below. Exit code 0 on success,
// 1 when a check fails, 2 when the RPC cannot be reached.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";

const RPC = process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const CAP = 16_777_216;
const SEPOLIA_CHAIN_ID = 11_155_111n;
const SENDER = "0x00000000000000000000000000000000b21d6e00"; // any address; nonce overridden
const MAX_FEE = "0x3b9aca00"; // 1 gwei; the balance is overridden

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "..", "out");
const FIXTURES = join(here, "..", "..", "..", "fixtures", "mainnet");


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

function keccak256(bytes) {
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

const hex = (b) => "0x" + Buffer.from(b).toString("hex");
const bytes = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));
const concat = (...parts) => Uint8Array.from(Buffer.concat(parts.map((p) => Buffer.from(p))));
const word = (n) => bytes(BigInt(n).toString(16).padStart(64, "0"));
const padRight = (b) => concat(b, new Uint8Array((32 - (b.length % 32)) % 32));

// Head/tail ABI encoding of a parameter list. A value is {word} (static, 32 bytes), {bytes},
// {words} (bytes32[]) or {list} (bytes[]).
function encode(params) {
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


// CREATE address of `sender` at a nonce below 128.
function createAddress(sender, nonce) {
  const n = nonce === 0 ? Uint8Array.of(0x80) : Uint8Array.of(nonce);
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

function blake2b(data, outlen) {
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

const le = (v, n) => {
  const out = new Uint8Array(n);
  let x = BigInt(v);
  for (let i = 0; i < n; i++, x >>= 8n) out[i] = Number(x & 0xffn);
  return out;
};
function compact(v) {
  if (v < 1 << 6) return Uint8Array.of(v << 2);
  if (v < 1 << 14) return le((v << 2) | 1, 2);
  if (v < 2 ** 30) return le(v * 4 + 2, 4);
  throw new Error("compact: value too large for this script");
}
const compactLen = (v) => compact(v).length;
const filled = (byte) => new Uint8Array(32).fill(byte);

// ------------------------------------------------------------------ fixtures

const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));

// The signers hint: 2 bytes per precommit (position, authority index), sorted by index.
function signersOf(json) {
  const list = json.justification.precommits.map((p, i) => [i, Number(p.authorityIndex)]);
  list.sort((a, b) => a[1] - b[1]);
  return { hint: Uint8Array.from(list.flat()), first: list[0] };
}

// ------------------------------------------------------------------ RPC

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

let failed = false;
function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed = true;
}
const fmt = (n) => n.toLocaleString("en-US");
const share = (used) => `${fmt(used)} gas, ${((100 * used) / CAP).toFixed(1)}% of the 16,777,216 cap`;

// ------------------------------------------------------------------ units

// Deployment order. The sender's nonce i deploys UNITS[i]; libraries come before what links them.
const UNITS = [
  { name: "SCL_EIP6565", file: "libSCL_EIP6565.sol" },
  { name: "GrandpaCodec", file: "GrandpaCodec.sol" },
  { name: "AuthoritySets", file: "AuthoritySets.sol" },
  { name: "GrandpaLightClient", file: "GrandpaLightClient.sol" },
  { name: "StorageProofs", file: "StorageProofs.sol" },
  { name: "ProvenBalance", file: "ProvenBalance.sol" },
];
const art = {};
const addr = {};
UNITS.forEach((u, i) => {
  art[u.name] = JSON.parse(readFileSync(join(OUT, u.file, `${u.name}.json`), "utf8"));
  addr[u.name] = createAddress(SENDER, i);
});
const selector = (name, sig) => {
  const s = art[name].methodIdentifiers[sig];
  if (!s) throw new Error(`${name} has no ${sig}`);
  return bytes(s);
};
const errorSelector = (sig) => keccak256(Buffer.from(sig)).slice(0, 4);

// Creation code of `name` with every library placeholder replaced by the library's address.
function linkedCode(name) {
  const a = art[name];
  let code = a.bytecode.object;
  for (const refs of Object.values(a.bytecode.linkReferences)) {
    for (const [lib, offsets] of Object.entries(refs)) {
      if (!addr[lib]) throw new Error(`${name} links ${lib}, which is not deployed here`);
      for (const { start, length } of offsets)
        code = code.slice(0, 2 + 2 * start) + addr[lib].slice(2) + code.slice(2 + 2 * (start + length));
    }
  }
  if (code.includes("__$")) throw new Error(`unlinked placeholder left in ${name}`);
  return code;
}
const deployData = (name) =>
  name === "ProvenBalance"
    ? hex(concat(bytes(linkedCode(name)), word(BigInt(addr.GrandpaLightClient))))
    : linkedCode(name);

// ------------------------------------------------------------------ mainnet calls

const sc = fixture("set-change");
const fp = fixture("finality-proof-head");
const ap = fixture("account-proof");

const initCall = (genesis, setId, keys, checkpointHeader) =>
  concat(
    selector("GrandpaLightClient", "initialize(bytes32,uint64,bytes32[],bytes)"),
    encode([{ word: genesis }, { word: word(setId) }, { words: keys }, { bytes: checkpointHeader }]),
  );
const importCall = (header, justification, signers) =>
  concat(
    selector("GrandpaLightClient", "importHeader(bytes,bytes,bytes)"),
    encode([{ bytes: header }, { bytes: justification }, { bytes: signers }]),
  );

const initData = initCall(
  bytes(sc.provenance.genesisHash),
  sc.signingSet.setId,
  sc.signingSet.authorities.map((a) => bytes(a.id)),
  bytes(sc.parentHeader.scale),
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
// First counted precommit's signature, byte 0 of R (see SepoliaFork.t.sol).
tampered[32 + compactLen(bytes(fp.justification.scale).length) + 45 + head.first[0] * 132 + 36] ^= 0x01;

// ------------------------------------------------------------------ generated set changes

const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");
function keyPair(label) {
  const seed = createHash("sha256").update(label).digest();
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" });
  const pub = Uint8Array.from(createPublicKey(priv).export({ format: "der", type: "spki" }).subarray(-32));
  return { priv, pub };
}

// N authorities of set 100 sign a header (#1,001) that schedules N new keys with delay 0.
function setChange(n) {
  const old = [...Array(n).keys()].map((i) => keyPair(`bridge-zero simulation, set of ${n}, old key ${i}`));
  const next = [...Array(n).keys()].map((i) => keyPair(`bridge-zero simulation, set of ${n}, new key ${i}`));
  const setId = 100n;
  const checkpoint = concat(filled(0x11), compact(1000), filled(0x22), filled(0x33), compact(0));
  const log = concat(Uint8Array.of(1), compact(n), ...next.map((k) => concat(k.pub, le(1, 8))), le(0, 4));
  const digest = concat(compact(1), Uint8Array.of(4), Buffer.from("FRNK"), compact(log.length), log);
  const header = concat(blake2b(checkpoint, 32), compact(1001), filled(0x44), filled(0x55), digest);
  const hash = blake2b(header, 32);
  const round = 7n;
  const t = n - Math.floor((n - 1) / 3);
  const message = concat(Uint8Array.of(1), hash, le(1001, 4), le(round, 8), le(setId, 8));
  const precommits = old.slice(0, t).map((k) => concat(hash, le(1001, 4), sign(null, message, k.priv), k.pub));
  const justification = concat(le(round, 8), hash, le(1001, 4), compact(t), ...precommits, compact(0));
  const signers = Uint8Array.from([...Array(t).keys()].flatMap((i) => [i, i]));
  return {
    t,
    init: initCall(filled(0x66), setId, old.map((k) => k.pub), checkpoint),
    change: importCall(header, justification, signers),
  };
}

// ------------------------------------------------------------------ main

const fixtureHash = hex(blake2b(bytes(fp.header.scale), 32));
if (fixtureHash !== fp.header.hash.toLowerCase()) throw new Error(`blake2b-256 self-check failed: ${fixtureHash}`);

let block;
let chainId;
try {
  chainId = BigInt(await rpc("eth_chainId", []));
  block = await rpc("eth_getBlockByNumber", ["latest", false]);
} catch (err) {
  console.log(`Sepolia RPC unreachable (${err.message}), skipping`);
  process.exit(2);
}
check(chainId === SEPOLIA_CHAIN_ID, `chain id ${chainId} is Sepolia`);
console.log(`Sepolia block ${BigInt(block.number)} (${block.hash}), simulated on top of it via ${new URL(RPC).host}`);

// One simulated block of `calls` ({to?, data, gas?}), sent from SENDER starting at `nonce`, on top
// of the state overrides in `overrides`.
async function simulate(calls, nonce, overrides = {}) {
  const [sim] = await rpc("eth_simulateV1", [
    {
      blockStateCalls: [
        {
          stateOverrides: { ...overrides, [SENDER]: { nonce: "0x" + nonce.toString(16), balance: "0x3635c9adc5dea00000" } },
          calls: calls.map((c, i) => ({
            from: SENDER,
            gas: "0x" + (c.gas ?? CAP).toString(16),
            maxFeePerGas: MAX_FEE,
            maxPriorityFeePerGas: "0x1",
            nonce: "0x" + (nonce + i).toString(16),
            ...(c.to ? { to: c.to } : {}),
            data: typeof c.data === "string" ? c.data : hex(c.data),
          })),
        },
      ],
      validation: true,
    },
    block.number,
  ]);
  return sim.calls;
}
const gasOf = (r) => Number(BigInt(r.gasUsed));

// Public RPCs limit the gas of one eth_simulateV1 request (50M on the default endpoint), so the
// run is several requests on the same block. Each deployment's runtime code (its return data)
// and the admin slot the light client's constructor writes (slot 0: admin = SENDER) are carried
// into the next request as state overrides.
const overrides = {};
const deployments = {};
async function deploy(names) {
  const nonce = UNITS.findIndex((u) => u.name === names[0]);
  const results = await simulate(names.map((name) => ({ data: deployData(name) })), nonce, overrides);
  names.forEach((name, i) => {
    const r = results[i];
    deployments[name] = r;
    if (r.status !== "0x1") return;
    overrides[addr[name]] = { code: r.returnData };
    if (name === "GrandpaLightClient")
      overrides[addr[name]].state = { ["0x" + "00".repeat(32)]: hex(word(BigInt(SENDER))) };
  });
}

console.log("\nDeployments, each with gas limit 16,777,216:");
await deploy(["SCL_EIP6565", "GrandpaCodec", "AuthoritySets"]);
await deploy(["GrandpaLightClient", "StorageProofs"]);
await deploy(["ProvenBalance"]);
let deployTotal = 0;
for (const { name } of UNITS) {
  const r = deployments[name];
  const used = gasOf(r);
  deployTotal += used;
  const size = r.status === "0x1" ? (r.returnData.length - 2) / 2 : 0;
  check(r.status === "0x1", `deploy ${name}: ${r.status === "0x1" ? `${fmt(size)} bytes of code, ` + share(used) : r.error?.message}`);
}
console.log(`     all ${UNITS.length} deployments: ${fmt(deployTotal)} gas`);

// The mainnet sequence, on the deployed contracts.
const lc = addr.GrandpaLightClient;
const pb = addr.ProvenBalance;
const calls = [
  ["initialize, 10 keys", { to: lc, data: initData }],
  ["set-change import, 7 of 10", { to: lc, data: changeData }],
  ["importAndProve, 7 of 10 + System.Account", { to: pb, data: proveData(finalityProof) }],
  ["importAndProve again (re-verification, no writes)", { to: pb, data: proveData(finalityProof) }],
  ["importAndProve, one signature byte flipped", { to: pb, data: proveData(tampered) }],
];
const IAP = 2;
const TAMPER = 4;
const results = await simulate(
  calls.map((c) => c[1]),
  UNITS.length,
  overrides,
);
console.log("\nMainnet sequence, each with gas limit 16,777,216:");
for (let i = 0; i < TAMPER; i++) {
  const r = results[i];
  check(r.status === "0x1", `${calls[i][0]}: ${r.status === "0x1" ? share(gasOf(r)) : r.error?.message}`);
}

// importAndProve's return value: (bytes32 blockHash, uint32 number, AccountInfo info).
const ret = bytes(results[IAP].returnData);
const w = (i) => BigInt(hex(ret.slice(32 * i, 32 * i + 32)));
const d = ap.value.decoded;
check(hex(ret.slice(0, 32)) === fp.header.hash.toLowerCase(), "importAndProve returns the head hash");
check(w(1) === BigInt(fp.header.number), `importAndProve returns block #${fp.header.number}`);
const fields = ["nonce", "consumers", "providers", "sufficients", "free", "reserved", "miscFrozen", "feeFrozen"];
fields.forEach((f, i) => check(w(2 + i) === BigInt(d[f]), `AccountInfo.${f} = ${d[f]}`));

// BalanceProven(bytes32 indexed blockHash, uint32 number, bytes32 indexed accountId, uint128 free).
const topic0 = hex(keccak256(Buffer.from("BalanceProven(bytes32,uint32,bytes32,uint128)")));
const log = results[IAP].logs.find((l) => l.address.toLowerCase() === pb && l.topics[0] === topic0);
check(!!log, "BalanceProven emitted by ProvenBalance");
if (log) {
  const data = bytes(log.data);
  check(log.topics[1] === fp.header.hash.toLowerCase(), "BalanceProven.blockHash");
  check(log.topics[2] === ap.account.id.toLowerCase(), "BalanceProven.accountId");
  check(BigInt(hex(data.slice(0, 32))) === BigInt(fp.header.number), "BalanceProven.number");
  check(BigInt(hex(data.slice(32, 64))) === BigInt(d.free), "BalanceProven.free");
}

// The tampered call reverts with InvalidSignature(0, authority index of the first signer).
const bad = results[TAMPER];
const want = hex(concat(errorSelector("InvalidSignature(uint256,uint256)"), word(0), word(head.first[1])));
const got = bad.error?.data ?? bad.returnData;
check(bad.status === "0x0", `one flipped signature byte: reverted (${fmt(gasOf(bad))} gas)`);
check(got === want, `one flipped signature byte: InvalidSignature(0, ${head.first[1]})`);

// Set changes of N authorities to N new keys, each on a fresh copy of the light client.
const sizes = process.argv.includes("--set-change")
  ? process.argv.slice(process.argv.indexOf("--set-change") + 1).map(Number)
  : [];
if (sizes.length) console.log("\nSet changes to N new keys (threshold(N) signatures), gas limit 16,777,216:");
for (const n of sizes) {
  if (!Number.isInteger(n) || n < 1) throw new Error(`--set-change: bad N ${n}`);
  const { t, init, change } = setChange(n);
  const copy = "0x" + (0x5e7c0de000n + BigInt(n)).toString(16).padStart(40, "0");
  const state = { ...overrides, [copy]: overrides[lc] };
  const run = (gas) => simulate([{ to: copy, data: init }, { to: copy, data: change, gas }], UNITS.length, state);
  const [ri, rc] = await run(CAP);
  check(ri.status === "0x1", `N = ${n}: initialize, ${n} keys: ${ri.status === "0x1" ? share(gasOf(ri)) : ri.error?.message}`);
  const halted = rc.logs?.some((l) => l.topics[0] === hex(keccak256(Buffer.from("Halted(uint32,bytes32,uint8)"))));
  const changed = rc.logs?.some(
    (l) => l.topics[0] === hex(keccak256(Buffer.from("AuthoritySetChanged(uint64,uint64,bytes32,uint256,uint32)"))),
  );
  if (rc.status === "0x1") {
    check(changed && !halted, `N = ${n}: set change, ${t} signatures, ${n} new keys: ${share(gasOf(rc))}`);
  } else {
    console.log(`     N = ${n}: set change, ${t} signatures, ${n} new keys: does not fit the cap (${rc.error?.message})`);
    const [, again] = await run(2 * CAP);
    console.log(
      `     N = ${n}: with gas limit ${fmt(2 * CAP)}: ${again.status === "0x1" ? share(gasOf(again)) : again.error?.message}`,
    );
  }
}

process.exit(failed ? 1 : 0);
