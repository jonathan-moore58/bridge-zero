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
// The RPC is SEPOLIA_RPC_URL when set, else the public endpoint in script/lib/sepolia.mjs, which
// also holds the hashing, encoding and call builders this script shares with
// script/deploy-sepolia.mjs. Exit code 0 on success, 1 when a check fails, 2 when the RPC cannot
// be reached.

import { join } from "node:path";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import {
  RPC,
  CAP,
  SEPOLIA_CHAIN_ID,
  FIXTURES,
  keccak256,
  hex,
  bytes,
  concat,
  word,
  createAddress,
  blake2b,
  le,
  compact,
  filled,
  rpc,
  check,
  failed,
  fmt,
  share,
  linkedCode,
  initCall,
  importCall,
  fixtureCalls,
} from "../../script/lib/sepolia.mjs";

const SENDER = "0x00000000000000000000000000000000b21d6e00"; // any address; nonce overridden
const MAX_FEE = "0x3b9aca00"; // 1 gwei; the balance is overridden

// ------------------------------------------------------------------ units

// Deployment order. The sender's nonce i deploys UNITS[i]; libraries come before what links them.
const UNITS = ["SCL_EIP6565", "GrandpaCodec", "AuthoritySets", "GrandpaLightClient", "StorageProofs", "ProvenBalance"];
const addr = {};
UNITS.forEach((name, i) => (addr[name] = createAddress(SENDER, i)));
const deployData = (name) =>
  name === "ProvenBalance"
    ? hex(concat(bytes(linkedCode(name, addr)), word(BigInt(addr.GrandpaLightClient))))
    : linkedCode(name, addr);

// ------------------------------------------------------------------ mainnet calls

const { fp, ap, initData, changeData, head, proveData, finalityProof, tampered, invalidSignature } = fixtureCalls(
  join(FIXTURES, "mainnet"),
);

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
  const nonce = UNITS.indexOf(names[0]);
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
for (const name of UNITS) {
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
const got = bad.error?.data ?? bad.returnData;
check(bad.status === "0x0", `one flipped signature byte: reverted (${fmt(gasOf(bad))} gas)`);
check(got === invalidSignature, `one flipped signature byte: InvalidSignature(0, ${head.first[1]})`);

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
