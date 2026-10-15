// SPDX-License-Identifier: UNLICENSED
//
// Runs the mainnet import and the System.Account proof on a Sepolia node itself, with
// eth_simulateV1 (validation on) at the latest block: one simulated block deploys SCL_EIP6565,
// GrandpaLightClient and ProvenBalance, then calls initialize, importHeader (set change) and
// importAndProve (head), each with the EIP-7825 cap (16,777,216) as gas limit, then a tampered
// importAndProve that has to revert. The node executes everything under the rules Sepolia runs
// now; nothing is signed or sent (the sender's balance and nonce are state overrides).
//
// The deployments are sent with DEPLOY_GAS: under Sepolia's current rules (code deposit priced
// per byte of new state) GrandpaLightClient's deployment needs more than the cap, and the node
// accepts a deployment above it. The script reports the deployment gas against the cap without
// failing on it.
//
// Usage (from contracts/, after `forge build`):
//   node test/fork/simulate-sepolia.mjs
//
// --worst-case <trace> runs the heaviest set change instead (25 authorities, 17 signatures,
// change to 25 new keys), taking initialize's and importHeader's arguments from the trace of
// the unit test that builds it:
//   forge test --match-test test_gas_maxSetChange_withinCap -vvvv > cache/worst-case-trace.txt
//   node test/fork/simulate-sepolia.mjs --worst-case cache/worst-case-trace.txt
// The RPC is SEPOLIA_RPC_URL when set, else the public endpoint below. Exit code 0 on success,
// 1 when a check fails, 2 when the RPC cannot be reached.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RPC = process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const CAP = 16_777_216;
const SEPOLIA_CHAIN_ID = 11_155_111n;
const SENDER = "0x00000000000000000000000000000000b21d6e00"; // any address; nonce overridden to 0
const DEPLOY_GAS = 0x2000000; // 33,554,432
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

const artifact = (file, name) => JSON.parse(readFileSync(join(OUT, file, `${name}.json`), "utf8"));
const selector = (art, sig) => bytes(art.methodIdentifiers[sig]);
const errorSelector = (sig) => keccak256(Buffer.from(sig)).slice(0, 4);

// CREATE address of `sender` at a nonce below 128.
function createAddress(sender, nonce) {
  const n = nonce === 0 ? Uint8Array.of(0x80) : Uint8Array.of(nonce);
  const body = concat(Uint8Array.of(0x94), bytes(sender), n);
  return hex(keccak256(concat(Uint8Array.of(0xc0 + body.length), body)).slice(12));
}

// ------------------------------------------------------------------ fixtures

const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));

// The signers hint: 2 bytes per precommit (position, authority index), sorted by index.
function signersOf(json) {
  const list = json.justification.precommits.map((p, i) => [i, Number(p.authorityIndex)]);
  list.sort((a, b) => a[1] - b[1]);
  return { hint: Uint8Array.from(list.flat()), first: list[0] };
}

const compactLen = (v) => (v < 1 << 6 ? 1 : v < 1 << 14 ? 2 : v < 2 ** 30 ? 4 : 1 + Math.ceil(v.toString(16).length / 2));

// ------------------------------------------------------------------ RPC

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(60_000),
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

// ------------------------------------------------------------------ main

const lib = artifact("libSCL_EIP6565.sol", "SCL_EIP6565");
const lcArt = artifact("GrandpaLightClient.sol", "GrandpaLightClient");
const pbArt = artifact("ProvenBalance.sol", "ProvenBalance");

const libAddr = createAddress(SENDER, 0);
const lcAddr = createAddress(SENDER, 1);
const pbAddr = createAddress(SENDER, 2);

// Link GrandpaLightClient to the library at its simulated address.
let lcCode = lcArt.bytecode.object;
for (const refs of Object.values(lcArt.bytecode.linkReferences))
  for (const offsets of Object.values(refs))
    for (const { start, length } of offsets)
      lcCode = lcCode.slice(0, 2 + 2 * start) + libAddr.slice(2) + lcCode.slice(2 + 2 * (start + length));
if (lcCode.includes("__$")) throw new Error("unlinked placeholder left in GrandpaLightClient");

const sc = fixture("set-change");
const fp = fixture("finality-proof-head");
const ap = fixture("account-proof");

const keys = sc.signingSet.authorities.map((a) => bytes(a.id));
const initData = concat(
  selector(lcArt, "initialize(bytes32,uint64,bytes32[],bytes)"),
  encode([
    { word: bytes(sc.provenance.genesisHash) },
    { word: word(sc.signingSet.setId) },
    { words: keys },
    { bytes: bytes(sc.parentHeader.scale) },
  ]),
);
const changeData = concat(
  selector(lcArt, "importHeader(bytes,bytes,bytes)"),
  encode([
    { bytes: bytes(sc.header.scale) },
    { bytes: bytes(sc.justification.scale) },
    { bytes: signersOf(sc).hint },
  ]),
);
const head = signersOf(fp);
const proveData = (finalityProof) =>
  concat(
    selector(pbArt, "importAndProve(bytes,bytes,bytes,bytes32,bytes[])"),
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

const gas = "0x" + CAP.toString(16);
const deployGas = "0x" + DEPLOY_GAS.toString(16);
const calls = [
  ["deploy SCL_EIP6565", { data: lib.bytecode.object, gas: deployGas }],
  ["deploy GrandpaLightClient", { data: lcCode, gas: deployGas }],
  ["deploy ProvenBalance", { data: hex(concat(bytes(pbArt.bytecode.object), word(BigInt(lcAddr)))), gas: deployGas }],
  ["initialize, 10 keys", { to: lcAddr, data: hex(initData) }],
  ["set-change import, 7 of 10", { to: lcAddr, data: hex(changeData) }],
  ["importAndProve, 7 of 10 + System.Account", { to: pbAddr, data: hex(proveData(finalityProof)) }],
  ["importAndProve again (re-verification, no writes)", { to: pbAddr, data: hex(proveData(finalityProof)) }],
  ["importAndProve, one signature byte flipped", { to: pbAddr, data: hex(proveData(tampered)) }],
];
const IAP = 5; // index of the first importAndProve
const TAMPER = 7;

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

// One simulated block of `list` (calls, or indices into `calls`), sent from SENDER starting at
// `nonce`.
async function simulate(list, nonce, overrides = {}) {
  const [sim] = await rpc("eth_simulateV1", [
    {
      blockStateCalls: [
        {
          stateOverrides: { ...overrides, [SENDER]: { nonce: "0x" + nonce.toString(16), balance: "0x3635c9adc5dea00000" } },
          calls: list.map((k, i) => ({
            from: SENDER,
            gas,
            maxFeePerGas: MAX_FEE,
            maxPriorityFeePerGas: "0x1",
            nonce: "0x" + (nonce + i).toString(16),
            ...(typeof k === "number" ? calls[k][1] : k),
          })),
        },
      ],
      validation: true,
    },
    block.number,
  ]);
  return sim.calls;
}

// Public RPCs limit the gas of one eth_simulateV1 request (50M here), so the run is two requests
// on the same block. The first deploys the library and the light client. The second starts from
// that result: their runtime code (returned by the deployments) and the admin slot the light
// client's constructor wrote are installed as state overrides, then it deploys ProvenBalance and
// makes every call.
const first = await simulate([0, 1], 0);
const deployed = {
  [libAddr]: { code: first[0].returnData },
  [lcAddr]: {
    code: first[1].returnData,
    state: { ["0x" + "00".repeat(32)]: hex(word(BigInt(SENDER))) }, // slot 0: admin = SENDER
  },
};
const share = (used) => `${used.toLocaleString("en-US")} gas, ${((100 * used) / CAP).toFixed(1)}% of the 16,777,216 cap`;

if (process.argv[2] === "--worst-case") {
  const trace = readFileSync(process.argv[3], "utf8");
  const init = trace.match(/GrandpaLightClient::initialize\((0x[0-9a-f]{64}), (\d+), \[([^\]]*)\], (0x[0-9a-f]*)\)/);
  const imp = trace.match(/GrandpaLightClient::importHeader\((0x[0-9a-f]*), (0x[0-9a-f]*), (0x[0-9a-f]*)\)/);
  if (!init || !imp) throw new Error("initialize/importHeader not found in the trace (run it with -vvvv)");
  const wKeys = init[3].split(", ").map(bytes);
  const wInit = concat(
    selector(lcArt, "initialize(bytes32,uint64,bytes32[],bytes)"),
    encode([{ word: bytes(init[1]) }, { word: word(init[2]) }, { words: wKeys }, { bytes: bytes(init[4]) }]),
  );
  const wImport = concat(
    selector(lcArt, "importHeader(bytes,bytes,bytes)"),
    encode([{ bytes: bytes(imp[1]) }, { bytes: bytes(imp[2]) }, { bytes: bytes(imp[3]) }]),
  );
  const run = async (importGas) =>
    simulate(
      [
        { to: lcAddr, data: hex(wInit) },
        { to: lcAddr, data: hex(wImport), gas: "0x" + importGas.toString(16) },
      ],
      2,
      deployed,
    );
  const [wi, wc] = await run(CAP);
  check(wi.status === "0x1", `initialize, ${wKeys.length} keys: status success, ${share(Number(BigInt(wi.gasUsed)))}`);
  const used = Number(BigInt(wc.gasUsed));
  check(wc.status === "0x1", `worst-case set change at gas limit 16,777,216: ${wc.status === "0x1" ? "success, " + share(used) : wc.error?.message}`);
  if (wc.status !== "0x1") {
    const [, again] = await run(DEPLOY_GAS);
    console.log(`     with gas limit ${DEPLOY_GAS}: ${again.status === "0x1" ? "success, " + share(Number(BigInt(again.gasUsed))) : again.error?.message}`);
  }
  process.exit(failed ? 1 : 0);
}

const second = await simulate([2, 3, 4, 5, 6, 7], 2, deployed);
const results = [...first, ...second];
const rows = [];
for (let i = 0; i < calls.length; i++) {
  const r = results[i];
  rows.push([calls[i][0], Number(BigInt(r.gasUsed)), r.status === "0x1"]);
}
for (const [label, used, ok] of rows.slice(0, 3)) {
  check(ok, `${label}: status success`);
  console.log(`     ${label}: ${share(used)}${used > CAP ? " (above the cap, gas limit " + DEPLOY_GAS + ")" : ""}`);
}
for (const [label, used, ok] of rows.slice(3, TAMPER)) {
  check(ok, `${label}: status success, gas limit 16,777,216`);
  check(used <= CAP, `${label}: ${share(used)}`);
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
const log = results[IAP].logs.find((l) => l.address.toLowerCase() === pbAddr && l.topics[0] === topic0);
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
check(bad.status === "0x0", "one flipped signature byte: reverted");
check(got === want, `one flipped signature byte: InvalidSignature(0, ${head.first[1]})`);

process.exit(failed ? 1 : 0);
