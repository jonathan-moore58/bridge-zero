// SPDX-License-Identifier: Apache-2.0
//
// Deploys the proof kit's contracts to Sepolia (docs/PROOF-KIT.md). The plan is one transaction per
// step, in nonce order from the deployer's nonce on chain:
//   [0] PortaldotStateReader, bound to GrandpaLightClient #2 and linked to the deployed StorageProofs
//       (both from deployments/sepolia.json);
//   [1] the example ProvenAssetGate on top of it: asset 7777 (pUSD, 6 decimals), a minimum of 1 pUSD,
//       at V3 #264,729, the block fixtures/v3-testnet-kit reads and the light client imported on Oct 31.
// No claim is sent to the gate: no account of the project holds a V3 asset, and a claim names its
// holder; the gate's claims are shown by its forge tests, read-only.
//
// Usage (from contracts/, after `FOUNDRY_PROFILE=sepolia forge build --skip test --skip script`; the
// sepolia profile in foundry.toml links StorageProofs at compile time, at its deployed address, so
// Etherscan can match the metadata):
//   node script/deploy-kit.mjs [--dry-run] [--resume]
//   node script/deploy-kit.mjs --send --account bz-deployer --password-file <path> [--resume]
//   node script/deploy-kit.mjs --verify
//
// --dry-run (the default) has a Sepolia node run the plan with eth_simulateV1 (validation on) at the
// latest block, from the deployer with its own nonce and balance, each creation first with the cap
// as gas limit, then again with the limit it is sent with (its gas + 10%, at most the cap). In the
// same simulated block, after the creations, the new Reader makes five of the fixture's reads (the
// deployer's System.Account, an asset account, an NFT's owner, the vault's Revive.AccountInfoOf
// entry and its commitments[1]) and must return the fixture's values, and the gate must name its
// reader, block, asset and minimum. A build that was not compiled from the checkout's sources, or
// that links StorageProofs anywhere but at its deployed address, is refused.
// --send re-runs the dry run, checks the keystore and the nonce, signs each step with cast mktx,
// records its hash in deployments/sepolia-kit.json (repo root) and only then publishes it, and checks
// its receipt and the code at its address; once both are mined, the deployed Reader makes the same
// five reads by eth_call, with eth_estimateGas's gas for each, recorded too. --resume continues the
// record from its first unmined step.
// --verify submits both contracts to Etherscan with forge verify-contract (forge reads the key from
// ETHERSCAN_API_KEY); a dry run prints the same commands.
// Fees: a priority fee of 1,000 wei and a max fee of ten times the next base fee plus it, at least
// 0.01 gwei, fixed for the run; --priority-fee and --max-fee (gwei) replace them. The RPC is
// SEPOLIA_RPC_URL when set, else the public endpoint. Exit code 0 on success, 1 when a check fails,
// 2 when the RPC cannot be reached, 3 when a sent transaction is still pending.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  RPC,
  CAP,
  CHAIN_ID,
  NETWORK,
  REQUEST_GAS,
  RECEIPT_TIMEOUT,
  CONTRACTS,
  FIXTURES,
  keccak256,
  hex,
  bytes,
  concat,
  word,
  encode,
  createAddress,
  rpc,
  rpcBody,
  check,
  failed,
  fmt,
  share,
  qty,
  gasOf,
  withHeadroom,
  eth,
  PROBE,
  PROBE_SENDER,
  PROBE_CODE,
  PROBE_GAS,
  parseGwei,
  feesAt,
  redactAlso,
  redact,
  toolEnv,
  retry,
  nonces,
  nextNonceIs,
  receiptOf,
  signerIs,
  mktxArgs,
  signAndPublish,
  writeJsonAtomic,
} from "./lib/sepolia.mjs";

const DEPLOYER = "0xD9838A86CF83C28Ee486544060D1cA4Ca2971071";
const deployer = DEPLOYER.toLowerCase();
// The deployment build: FOUNDRY_PROFILE=sepolia forge build --skip test --skip script.
const SEPOLIA_OUT = join(CONTRACTS, "out-sepolia");
const REPO = join(CONTRACTS, "..");
const RECORD = join(REPO, "deployments", "sepolia-kit.json");
const FIXTURE = "fixtures/v3-testnet-kit/state-reads.json";
const REBUILD = "rebuild it in contracts/ with FOUNDRY_PROFILE=sepolia forge build --skip test --skip script";
// The contracts the plan creates, with their sources.
const UNITS = {
  PortaldotStateReader: "src/kit/PortaldotStateReader.sol",
  ProvenAssetGate: "src/kit/examples/ProvenAssetGate.sol",
};
const STORAGE_PROOFS_ID = "src/trie/StorageProofs.sol:StorageProofs";
// The gate's asset and minimum: pUSD ("Portaldot USD (test)", 6 decimals) and 1 pUSD.
const GATE_ASSET = 7777n;
const GATE_MINIMUM = 1_000_000n;
// The gas limit of each read the dry run has the new Reader make (the largest needs about 0.9M).
const READ_GAS = 2_000_000;
const VIEW_GAS = 100_000;

const tag = (s) => `[${String(s.index).padStart(2)}]`;
const short = (h) => `${h.slice(0, 10)}…`;
const sel = (sig) => keccak256(Buffer.from(sig)).slice(0, 4);
const fmtBig = (n) => BigInt(n).toLocaleString("en-US");

// Ends the script with `code`. Exiting at once while a request's socket closes can fail an
// assertion in libuv on Windows (exit code 127 instead), so once the main sequence below has
// started, the script ends by throwing Exit, which that sequence turns into process.exitCode.
class Exit extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.code = code;
  }
}
let started = false;
function exit(code) {
  if (!started) process.exit(code);
  throw new Exit(code);
}

// ------------------------------------------------------------------ arguments

const VALUED = ["--account", "--password-file", "--priority-fee", "--max-fee"];
const FLAGS = ["--dry-run", "--send", "--verify", "--resume"];
const opts = {};
function usage(problem) {
  console.log(`${problem}
usage (from contracts/):
  node script/deploy-kit.mjs [--dry-run] [--resume] [--priority-fee <gwei>] [--max-fee <gwei>]
  node script/deploy-kit.mjs --send --account <keystore> --password-file <path> [--resume] [fees]
  node script/deploy-kit.mjs --verify`);
  exit(1);
}
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (VALUED.includes(a)) {
    const v = process.argv[++i];
    if (v === undefined || v.startsWith("--")) usage(`${a} needs a value`);
    opts[a] = v;
  } else if (FLAGS.includes(a)) opts[a] = true;
  else usage(`unknown argument ${a}`);
}
const modes = ["--dry-run", "--send", "--verify"].filter((m) => opts[m]);
if (modes.length > 1) usage("choose one of --dry-run, --send and --verify");
const MODE = modes[0] ?? "--dry-run";
if (MODE === "--send" && !(opts["--account"] && opts["--password-file"]))
  usage("--send needs --account <keystore name> and --password-file <path>");
if (MODE !== "--send" && (opts["--account"] || opts["--password-file"])) usage("--account and --password-file go with --send only");
// cast runs in a directory of its own: the path is made absolute here (the file is never opened by this script).
if (opts["--password-file"]) opts["--password-file"] = resolve(opts["--password-file"]);
if (MODE === "--send" && !existsSync(opts["--password-file"])) usage("--password-file: no such file");

function gwei(s) {
  try {
    return parseGwei(s);
  } catch (err) {
    usage(err.message);
  }
}
const PRIORITY_FEE = opts["--priority-fee"] && gwei(opts["--priority-fee"]);
const MAX_FEE = opts["--max-fee"] && gwei(opts["--max-fee"]);

// Tool and RPC messages leave out the password file's path (redact, in lib/sepolia.mjs).
redactAlso(opts["--password-file"]);

// ------------------------------------------------------------------ the records and the build

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const deployed = readJson(join(REPO, "deployments", "sepolia.json")).contracts;
const LIGHT_CLIENT = deployed["GrandpaLightClient #2"].toLowerCase();
const STORAGE_PROOFS = deployed.StorageProofs.toLowerCase();

// The keccak-256 a build can record for a source file: of its bytes, and of its bytes with CRLF line
// ends made LF (relayer/src/bridge.ts sourceHashes).
function sourceHashes(buf) {
  const lf = [];
  for (let i = 0; i < buf.length; i++) if (!(buf[i] === 0x0d && buf[i + 1] === 0x0a)) lf.push(buf[i]);
  return [hex(keccak256(buf)), hex(keccak256(Uint8Array.from(lf)))];
}

// The Sepolia build of `name`, refused without code, with a library placeholder left in it, compiled
// by another solc than 0.8.27, from sources other than the checkout's, or linking a library anywhere
// but at the address deployments/sepolia.json records: each deployment is verified on Etherscan
// against contracts/.
const builds = {};
function build(name) {
  if (builds[name]) return builds[name];
  const path = join(SEPOLIA_OUT, `${name}.sol`, `${name}.json`);
  if (!existsSync(path)) throw new Error(`no ${path}: ${REBUILD}`);
  const a = readJson(path);
  const code = a.bytecode?.object ?? "0x";
  if (code === "0x" || !a.deployedBytecode?.object || a.deployedBytecode.object === "0x") throw new Error(`${path} has no bytecode`);
  if (code.includes("__$")) throw new Error(`${path} has an unlinked library placeholder: ${REBUILD}`);
  const meta = a.metadata ?? {};
  const target = Object.entries(meta.settings?.compilationTarget ?? {});
  if (target.length !== 1 || target[0][0] !== UNITS[name] || target[0][1] !== name) throw new Error(`${path} is not ${UNITS[name]}:${name}'s artifact`);
  if (!meta.compiler?.version?.startsWith("0.8.27+")) throw new Error(`${path} was compiled by solc ${meta.compiler?.version}, not 0.8.27`);
  const sources = Object.entries(meta.sources ?? {});
  const stale = sources.filter(([file, s]) => {
    const p = join(CONTRACTS, file);
    return !existsSync(p) || !sourceHashes(readFileSync(p)).includes(String(s.keccak256).toLowerCase());
  });
  if (sources.length === 0 || stale.length > 0)
    throw new Error(`${path} is not built from the current sources (${stale[0]?.[0] ?? "no source list"}${stale.length > 1 ? ` and ${stale.length - 1} more` : ""}): ${REBUILD}`);
  // The libraries the code carries: the metadata names every library the profile links.
  const libraries = Object.fromEntries(
    Object.entries(meta.settings?.libraries ?? {})
      .map(([id, address]) => [id, String(address).toLowerCase()])
      .filter(([, address]) => code.toLowerCase().includes(address.slice(2))),
  );
  const want = name === "PortaldotStateReader" ? { [STORAGE_PROOFS_ID]: STORAGE_PROOFS } : {};
  if (JSON.stringify(libraries) !== JSON.stringify(want))
    throw new Error(`${path} links ${JSON.stringify(libraries)}, not ${JSON.stringify(want)} (foundry.toml's sepolia libraries): ${REBUILD}`);
  builds[name] = {
    name,
    contractId: `${UNITS[name]}:${name}`,
    creation: bytes(code),
    libraries,
    compiler: meta.compiler.version,
    evmVersion: meta.settings.evmVersion,
    optimizerRuns: meta.settings.optimizer?.enabled ? meta.settings.optimizer.runs : null,
  };
  return builds[name];
}
// The keccak-256 of each contract's creation code in the Sepolia build, to tell whether the build changed.
const artifactHashes = () => Object.fromEntries(Object.keys(UNITS).map((n) => [n, hex(keccak256(build(n).creation))]));

// The fixture: V3 #264,729 and its reads.
const fixture = readJson(join(FIXTURES, "v3-testnet-kit", "state-reads.json"));
if (fixture.kind !== "state-reads") throw new Error(`${FIXTURE} is not a state-reads fixture`);
const B = { hash: fixture.header.hash.toLowerCase(), number: Number(fixture.header.number), stateRoot: fixture.header.stateRoot.toLowerCase() };
if (fixture.lightClient.address.toLowerCase() !== LIGHT_CLIENT) throw new Error(`${FIXTURE} reads another light client than GrandpaLightClient #2`);

// ------------------------------------------------------------------ the plan

// Both steps from `start`, the deployer's nonce for the first: step i is the transaction at nonce
// start + i.
function buildPlan(start) {
  const steps = [];
  const add = (step) => steps.push({ index: steps.length, nonce: start + steps.length, ...step });
  const deploy = (name, label, args, more = {}) => {
    const b = build(name);
    const address = createAddress(deployer, start + steps.length);
    add({ name, label, kind: "deploy", contract: b.contractId, address, libraries: b.libraries, constructorArgs: hex(args), data: hex(concat(b.creation, args)), ...more });
    return address;
  };
  const reader = deploy(
    "PortaldotStateReader",
    `PortaldotStateReader, bound to GrandpaLightClient #2 (${short(LIGHT_CLIENT)}), linked to StorageProofs (${short(STORAGE_PROOFS)})`,
    word(BigInt(LIGHT_CLIENT)),
    { fixtures: [] },
  );
  deploy(
    "ProvenAssetGate",
    `ProvenAssetGate: at least ${fmtBig(GATE_MINIMUM)} of asset ${GATE_ASSET} (1 pUSD) at V3 #${fmt(B.number)}`,
    concat(word(BigInt(reader)), bytes(B.hash), word(GATE_ASSET), word(GATE_MINIMUM)),
    { fixtures: [FIXTURE] },
  );
  return steps;
}

// What the deployed contracts must answer: the gate's settings and the Reader's light client, and
// five of the fixture's reads through the Reader, each with the values the fixture holds.
function checksOf(plan) {
  const reader = plan[0].address;
  const gate = plan[1].address;
  const w = (ret, i) => BigInt(hex(ret.slice(32 * i, 32 * i + 32)));
  const read = (id) => fixture.reads.find((r) => r.id === id) ?? (() => { throw new Error(`${FIXTURE} has no read ${id}`); })();
  const nodes = (p) => p.nodes.map(bytes);
  const number = BigInt(B.number);
  const views = [
    { to: reader, name: "PortaldotStateReader.lightClient()", sig: "lightClient()", want: [BigInt(LIGHT_CLIENT)], what: `GrandpaLightClient #2 ${short(LIGHT_CLIENT)}` },
    { to: gate, name: "ProvenAssetGate.reader()", sig: "reader()", want: [BigInt(reader)], what: `the Reader ${short(reader)}` },
    { to: gate, name: "ProvenAssetGate.snapshotBlock()", sig: "snapshotBlock()", want: [BigInt(B.hash)], what: `V3 ${short(B.hash)}` },
    { to: gate, name: "ProvenAssetGate.snapshotNumber()", sig: "snapshotNumber()", want: [number], what: `#${fmt(B.number)}, from the light client` },
    { to: gate, name: "ProvenAssetGate.assetId()", sig: "assetId()", want: [GATE_ASSET], what: String(GATE_ASSET) },
    { to: gate, name: "ProvenAssetGate.minimum()", sig: "minimum()", want: [GATE_MINIMUM], what: fmtBig(GATE_MINIMUM) },
  ].map((v) => ({
    ...v,
    kind: "view",
    data: hex(sel(v.sig)),
    judge: (ret) => v.want.every((x, i) => w(ret, i) === x),
  }));

  const r1 = read(1);
  const d1 = r1.value.decoded;
  const r3 = read(3);
  const r11 = read(11);
  const r14 = read(14);
  const c = fixture.contract;
  const s1 = c.slots.find((s) => s.name === "commitments[1]");
  if (c.read !== 14 || c.address !== r14.args.address || !s1) throw new Error(`${FIXTURE}: the contract section is not the vault's read 14 with commitments[1]`);
  const status = { Liquid: 0n, Frozen: 1n, Blocked: 2n };
  const reads = [
    {
      name: "accountInfo",
      what: `System.Account of the deployer's EVM account (read 1): nonce ${d1.nonce}, free ${fmtBig(d1.free)}`,
      data: concat(sel("accountInfo(bytes32,bytes32,bytes[])"), encode([{ word: bytes(B.hash) }, { word: bytes(r1.args.accountId) }, { list: nodes(r1.proof) }])),
      want: [d1.nonce, d1.consumers, d1.providers, d1.sufficients, d1.free, d1.reserved, d1.frozen, d1.flags, number].map(BigInt),
    },
    {
      name: "assetAccount",
      what: `Assets.Account(${r3.args.assetId}, ${short(r3.args.accountId)}) (read 3): ${fmtBig(r3.value.decoded.balance)}, ${r3.value.decoded.status}`,
      data: concat(sel("assetAccount(bytes32,uint32,bytes32,bytes[])"), encode([{ word: bytes(B.hash) }, { word: word(r3.args.assetId) }, { word: bytes(r3.args.accountId) }, { list: nodes(r3.proof) }])),
      want: [BigInt(r3.value.decoded.balance), status[r3.value.decoded.status], number],
    },
    {
      name: "nftOwner",
      what: `Nfts.Item(${r11.args.collection}, ${r11.args.item}) (read 11): owner ${short(r11.value.decoded.owner)}`,
      data: concat(sel("nftOwner(bytes32,uint32,uint32,bytes[])"), encode([{ word: bytes(B.hash) }, { word: word(r11.args.collection) }, { word: word(r11.args.item) }, { list: nodes(r11.proof) }])),
      want: [BigInt(r11.value.decoded.owner), number],
    },
    {
      name: "contractInfo",
      what: `Revive.AccountInfoOf of the vault ${short(c.address)} (read 14): trie id ${short(c.trieId)}, code hash ${short(c.codeHash)}`,
      data: concat(sel("contractInfo(bytes32,address,bytes[])"), encode([{ word: bytes(B.hash) }, { word: word(BigInt(c.address)) }, { list: nodes(r14.proof) }])),
      want: [BigInt(c.trieId), BigInt(c.codeHash), number],
    },
    {
      name: "contractSlot",
      what: `the vault's commitments[1]: ${short(s1.value.hex)}, with its code hash`,
      // (bytes32, address, bytes32, (bytes[], bytes[], bytes[])): the tuple is dynamic, so its head is an offset.
      data: concat(
        sel("contractSlot(bytes32,address,bytes32,(bytes[],bytes[],bytes[]))"),
        bytes(B.hash),
        word(BigInt(c.address)),
        bytes(s1.index),
        word(128),
        encode([{ list: nodes(r14.proof) }, { list: nodes(c.childRoot.proof) }, { list: nodes(s1.proof) }]),
      ),
      want: [BigInt(s1.value.hex), BigInt(c.codeHash), number],
    },
  ].map((r) => ({ ...r, kind: "read", to: reader, data: hex(r.data), judge: (ret) => ret.length === 32 * r.want.length && r.want.every((x, i) => w(ret, i) === x) }));
  return { views, reads };
}

// ------------------------------------------------------------------ dry run

// Runs `steps` on the node in one simulated block on top of ctx.block, each creation with gas limit
// `limitOf(step)`, then the checks (from the probe's sender, which a state override funds), then the
// probe. The deployer runs at its nonce and with its balance on chain: no balance is added.
async function simulate(steps, limitOf, checks, ctx) {
  const fee = { maxFeePerGas: qty(ctx.fees.maxFee), maxPriorityFeePerGas: qty(ctx.fees.tip) };
  const calls = steps.map((s) => ({ from: deployer, nonce: qty(s.nonce), gas: qty(limitOf(s)), ...fee, data: s.data }));
  for (const c of checks) calls.push({ from: PROBE_SENDER, to: c.to, gas: qty(c.kind === "read" ? READ_GAS : VIEW_GAS), ...fee, data: c.data });
  const probed = [deployer, ...steps.map((s) => s.address)];
  calls.push({ from: PROBE_SENDER, to: PROBE, gas: qty(PROBE_GAS), ...fee, data: hex(concat(...probed.map((a) => word(BigInt(a))))) });
  const stateOverrides = { [PROBE]: { code: PROBE_CODE }, [PROBE_SENDER]: { balance: qty(10n ** 18n) } };
  const params = [{ blockStateCalls: [{ stateOverrides, calls }], validation: true }, ctx.block.number];
  const [sim] = await rpc("eth_simulateV1", params);
  const probe = sim.calls.at(-1);
  if (probe.status !== "0x1") throw new Error(`the probe call failed: ${probe.error?.message}`);
  const words = bytes(probe.returnData);
  const at = (i) => hex(words.slice(32 * i, 32 * i + 32));
  // The node sets a call's whole gas limit aside from what the request may still use.
  let used = 0;
  let peak = 0;
  calls.forEach((c, i) => {
    peak = Math.max(peak, used + Number(BigInt(c.gas)));
    used += gasOf(sim.calls[i]);
  });
  const results = new Map(steps.map((s, i) => [s.index, { ...sim.calls[i], codeHashThere: at(2 * (i + 1)) }]));
  const checked = checks.map((c, i) => sim.calls[steps.length + i]);
  ctx.simulatedBaseFee = BigInt(sim.baseFeePerGas);
  return { results, checked, balance: BigInt(at(1)), peak };
}

// The line of one simulated creation: [ok, what].
function judge(s, r, limit) {
  const created = r.status === "0x1" && r.codeHashThere === hex(keccak256(bytes(r.returnData)));
  const what =
    r.status !== "0x1"
      ? r.error?.message
      : created
        ? `${fmt((r.returnData.length - 2) / 2)} bytes of code there, ${share(gasOf(r))}; gas limit ${fmt(limit)}`
        : "its code is not at the CREATE address";
  return [created, `${tag(s)} ${s.label}, nonce ${s.nonce}, at ${s.address}: ${what}`];
}

// The line of one check's answer, `returnData` or `error` from the node: [ok, what]. `gas` describes
// a read's gas.
function judgeCheck(c, { returnData, error }, gas) {
  const name = c.kind === "read" ? `PortaldotStateReader.${c.name}` : c.name;
  if (error) return [false, `${name}: ${redact(error.message ?? JSON.stringify(error))}${error.data ? ` (${error.data})` : ""}`];
  const ok = c.judge(bytes(returnData));
  if (c.kind === "view") return [ok, `${name} = ${ok ? c.what : returnData}`];
  return [ok, `${name}: ${ok ? c.what : `another answer, ${returnData}`} at #${fmt(B.number)}; ${gas}`];
}
// A simulated call's answer, for judgeCheck.
const answerOf = (r) => (r.status === "0x1" ? { returnData: r.returnData } : { error: r.error ?? { message: "failed" } });

// Proves `steps` (what is left of the plan) on the node. Returns, per step, the gas limit it is sent
// with, its simulated gas and the hash of the code it leaves; null when a check fails.
async function dryRun(plan, steps, ctx) {
  const { fees, balance } = ctx;
  console.log(
    `Fees: next base fee ${fmt(fees.base)} wei, priority fee ${fmt(fees.tip)} wei, max fee ${fmt(fees.maxFee)} wei` +
      ` (node gas price ${fmt(fees.gasPrice)} wei)`,
  );
  if (!check(fees.maxFee >= fees.base && fees.maxFee >= fees.tip, "the max fee covers the next base fee and the priority fee")) return null;
  const { views, reads } = checksOf(plan);
  const checks = [...views, ...reads];
  console.log(
    `\nPlan: ${steps.length} creations from nonce ${steps[0].nonce}, then ${views.length} views and ${reads.length} reads through the new` +
      ` contracts, in one simulated block: eth_simulateV1 with validation on, the creations from the deployer at its nonce` +
      ` and with its balance on chain (no balance is added), first with gas limit ${fmt(CAP)}, then with the gas limit below.`,
  );

  // 1. Measure, with the cap as gas limit.
  const first = await simulate(steps, () => CAP, checks, ctx);
  const measured = steps.map((s) => judge(s, first.results.get(s.index), CAP));
  if (measured.some(([ok]) => !ok)) {
    console.log(`\nWith gas limit ${fmt(CAP)}:`);
    for (const [ok, what] of measured) check(ok, what);
    return null;
  }
  const limits = new Map(steps.map((s) => [s.index, withHeadroom(gasOf(first.results.get(s.index)))]));

  // 2. The exact plan: each creation with the gas limit it is sent with, and the checks after them.
  const run = await simulate(steps, (s) => limits.get(s.index), checks, ctx);
  console.log("\nCreations:");
  let total = 0;
  for (const s of steps) {
    const r = run.results.get(s.index);
    check(...judge(s, r, limits.get(s.index)));
    if (gasOf(r) !== gasOf(first.results.get(s.index)))
      check(false, `     ${fmt(gasOf(first.results.get(s.index)))} gas with the cap as gas limit, ${fmt(gasOf(r))} with ${fmt(limits.get(s.index))}`);
    total += gasOf(r);
  }
  console.log(`\nIn the same block, the new contracts (V3 #${fmt(B.number)} ${short(B.hash)}, from ${FIXTURE}):`);
  checks.forEach((c, i) => {
    const r = run.checked[i];
    check(...judgeCheck(c, answerOf(r), `${fmt(gasOf(r))} gas as a transaction, calldata ${fmt((c.data.length - 2) / 2)} B`));
  });

  // 3. Gas and cost. Before each transaction the deployer must hold its gas limit at the max fee;
  // at most, every earlier one paid the max fee too.
  console.log(`\n     ${steps.length} transactions: ${fmt(total)} gas`);
  const top = Math.max(...limits.values());
  check(top <= CAP, `every gas limit is within the ${fmt(CAP)} cap (the largest ${fmt(top)})`);
  const peak = Math.max(first.peak, run.peak);
  check(peak <= REQUEST_GAS, `the request needs ${fmt(peak)} of the ${fmt(REQUEST_GAS)} gas one request may use`);
  let need = 0n;
  let paid = 0n;
  for (const s of steps) {
    const upfront = paid + BigInt(limits.get(s.index)) * fees.maxFee;
    if (upfront > need) need = upfront;
    paid += BigInt(gasOf(run.results.get(s.index))) * fees.maxFee;
  }
  check(
    need <= balance,
    `cost at the current fees ${eth(balance - run.balance)} (base fee ${fmt(ctx.simulatedBaseFee)} wei + priority fee, as simulated);` +
      ` at most ${eth(need)} at the max fee; the deployer has ${eth(balance)}`,
  );
  if (failed) return null;
  console.log("\nEtherscan, once deployed (from contracts/, with ETHERSCAN_API_KEY set; --verify runs them):");
  for (const s of steps) console.log(`  ${verifyArgs(s).map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}`);
  return steps.map((s) => {
    const r = run.results.get(s.index);
    return { limit: limits.get(s.index), simulatedGas: gasOf(r), codeHash: hex(keccak256(bytes(r.returnData))) };
  });
}

// ------------------------------------------------------------------ record

const git = (args) => {
  const r = spawnSync("git", args, { cwd: CONTRACTS, encoding: "utf8", windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
};
const dataHash = (s) => hex(keccak256(bytes(s.data)));

function newRecord(steps) {
  return {
    network: NETWORK.name,
    chainId: Number(CHAIN_ID),
    deployer: DEPLOYER,
    commit: git(["rev-parse", "HEAD"]),
    dirty: git(["status", "--porcelain", "--untracked-files=no"]) !== "",
    startNonce: steps[0].nonce,
    artifacts: artifactHashes(),
    lightClient: { name: "GrandpaLightClient #2", address: LIGHT_CLIENT },
    storageProofs: STORAGE_PROOFS,
    block: { network: "portaldot-v3-testnet", number: B.number, hash: B.hash, stateRoot: B.stateRoot, fixture: FIXTURE },
    contracts: {},
    steps: steps.map((s) => ({
      name: s.name,
      kind: s.kind,
      nonce: s.nonce,
      sender: deployer,
      contract: s.contract,
      address: s.address,
      libraries: s.libraries,
      constructorArgs: s.constructorArgs,
      fixtures: s.fixtures,
      expected: "status 1",
      dataHash: dataHash(s),
      gasLimit: null,
      simulatedGas: null,
      codeHash: null,
      txHash: null,
      signedAt: null,
      block: null,
      gasUsed: null,
      effectiveGasPrice: null,
      status: null,
      ok: null,
    })),
    reads: null,
  };
}

function save(record) {
  record.contracts = {};
  for (const s of record.steps) if (s.ok) record.contracts[s.name] = s.address;
  writeJsonAtomic(RECORD, record);
}

// The record against the plan rebuilt from its start nonce: same names, nonces, addresses and
// transaction data, from the same build. Returns the index of its first step not yet mined.
function matchRecord(record, steps) {
  const fail = (why) => {
    console.log(`FAIL ${RECORD} does not match this plan: ${why}`);
    exit(1);
  };
  if (record.chainId !== Number(CHAIN_ID) || record.deployer.toLowerCase() !== deployer) fail("network or deployer");
  const hashes = artifactHashes();
  for (const n of Object.keys(UNITS)) if (record.artifacts?.[n] !== hashes[n]) fail(`${n} is built differently (the record is from commit ${record.commit})`);
  if (record.steps.length !== steps.length) fail("step count");
  record.steps.forEach((r, i) => {
    const s = steps[i];
    if (r.name !== s.name || r.nonce !== s.nonce || r.address !== s.address || r.dataHash !== dataHash(s)) fail(`step ${i} (${r.name})`);
    if (r.block !== null && !r.ok) fail(`step ${i} (${r.name}) was mined but failed its checks; see tx ${r.txHash}`);
  });
  const next = record.steps.findIndex((r) => r.block === null);
  return next < 0 ? steps.length : next;
}

// ------------------------------------------------------------------ send

// Checks a mined creation against the dry run and writes it into the record: the contract must be at
// its CREATE address with the simulated code.
async function recordReceipt(record, s, receipt) {
  const entry = record.steps[s.index];
  const status = Number(BigInt(receipt.status));
  const gasUsed = gasOf(receipt);
  const lines = [
    [
      status === 1,
      `${tag(s)} ${s.label}: status ${status}, block ${fmt(Number(BigInt(receipt.blockNumber)))}, ${share(gasUsed)}` +
        ` (simulated ${fmt(entry.simulatedGas)}), tx ${receipt.transactionHash}`,
    ],
    [receipt.contractAddress?.toLowerCase() === s.address, `     created at ${s.address}`],
  ];
  const code = await retry("code", () => rpc("eth_getCode", [s.address, "latest"]));
  lines.push([hex(keccak256(bytes(code))) === entry.codeHash, "     with the code the dry run left there"]);
  let ok = true;
  for (const [k, what] of lines) ok = check(k, what) && ok;
  Object.assign(entry, {
    txHash: receipt.transactionHash,
    block: Number(BigInt(receipt.blockNumber)),
    gasUsed,
    effectiveGasPrice: BigInt(receipt.effectiveGasPrice ?? 0).toString(),
    status,
    ok,
  });
  save(record);
  return ok;
}

// Sends plan[from...] one at a time: cast mktx signs it (explicit nonce, gas limit and fees), its
// hash goes into the record, and only then cast publish broadcasts it, so a crash at any point
// leaves a record that --resume can reconcile.
async function send(record, plan, from, planned, fees) {
  if (!signerIs(deployer, opts["--account"], opts["--password-file"])) exit(1);
  save(record);
  for (const s of plan.slice(from)) {
    const p = planned[s.index - from];
    const entry = record.steps[s.index];
    if (!(await nextNonceIs(deployer, s.nonce))) exit(1);
    const args = mktxArgs(s.name, {
      to: null,
      data: s.data,
      nonce: s.nonce,
      gasLimit: p.limit,
      fees,
      account: opts["--account"],
      passwordFile: opts["--password-file"],
    });
    Object.assign(entry, { gasLimit: p.limit, simulatedGas: p.simulatedGas, codeHash: p.codeHash });
    save(record);
    const hash = signAndPublish(args, `${tag(s)} ${s.name}`, (signed) => {
      console.log(`     ${tag(s)} ${s.name}: signed ${signed}, gas limit ${fmt(p.limit)}`);
      entry.txHash = signed;
      entry.signedAt = new Date().toISOString();
      save(record);
    });
    if (!hash) exit(1);
    const receipt = await receiptOf(hash, true);
    if (!receipt) {
      console.log(`     ${hash} is not mined after ${RECEIPT_TIMEOUT / 60_000} minutes; run again with --resume`);
      exit(3);
    }
    if (!(await recordReceipt(record, s, receipt))) exit(1);
  }
}

// The first unmined step was sent before the run stopped: record it if it was mined (and look at
// the next), send it again if it was dropped, stop if it is still pending.
async function reconcile(record, plan, from) {
  const entry = record.steps[from];
  if (!entry?.txHash) return from;
  let receipt = null;
  for (const h of [entry.txHash, ...(entry.dropped ?? [])]) receipt ??= await receiptOf(h, false);
  if (receipt) {
    if (MODE !== "--send") {
      console.log(`     ${entry.name} was mined (tx ${entry.txHash}); --send --resume records it and goes on`);
      exit(0);
    }
    if (!(await recordReceipt(record, plan[from], receipt))) exit(1);
    return reconcile(record, plan, from + 1);
  }
  const n = await nonces(deployer);
  if (n.latest > entry.nonce) {
    console.log(`FAIL nonce ${entry.nonce} is used on chain, but not by ${entry.txHash}; look at the deployer's transactions`);
    exit(1);
  }
  if (n.pending > n.latest) {
    console.log(`     ${entry.txHash} (${entry.name}) is still pending; run again with --resume once it is mined`);
    exit(3);
  }
  console.log(`     ${entry.txHash} (${entry.name}) was dropped; ${MODE === "--send" ? "it is sent again" : "--send --resume sends it again"}`);
  Object.assign(entry, { dropped: [...(entry.dropped ?? []), entry.txHash], txHash: null, signedAt: null });
  if (MODE === "--send") save(record);
  return from;
}

// Once both are mined: the deployed contracts' answers by eth_call, and each read's gas by
// eth_estimateGas (the whole transaction, under the rules Sepolia runs since Oct 6), recorded.
async function liveChecks(record, plan) {
  const { views, reads } = checksOf(plan);
  const block = await retry("block", () => rpc("eth_getBlockByNumber", ["latest", false]));
  console.log(`\nThe deployed contracts at Sepolia block ${fmt(Number(BigInt(block.number)))}:`);
  const out = [];
  for (const c of [...views, ...reads]) {
    const body = await retry("eth_call", () => rpcBody("eth_call", [{ to: c.to, data: c.data, gas: qty(READ_GAS) }, block.number]));
    const answer = body.error ? { error: body.error } : { returnData: body.result };
    let gas = null;
    if (c.kind === "read" && !body.error) gas = Number(BigInt(await retry("eth_estimateGas", () => rpc("eth_estimateGas", [{ to: c.to, data: c.data }, block.number]))));
    const bytesIn = (c.data.length - 2) / 2;
    const [ok, what] = judgeCheck(c, answer, `${fmt(gas ?? 0)} gas (eth_estimateGas: the whole transaction), calldata ${fmt(bytesIn)} B`);
    check(ok, what);
    if (c.kind === "read") out.push({ call: c.name, read: c.what, ok, gas, calldataBytes: bytesIn });
  }
  record.reads = { sepoliaBlock: Number(BigInt(block.number)), block: { number: B.number, hash: B.hash }, method: "eth_call and eth_estimateGas", results: out };
  save(record);
}

// ------------------------------------------------------------------ verify

// The forge verify-contract arguments of a step: the compiler settings of its build, its libraries'
// addresses and its constructor arguments.
function verifyArgs(s) {
  const b = build(s.name);
  const args = [
    "forge", "verify-contract", s.address, b.contractId,
    "--chain", NETWORK.name, "--verifier", "etherscan", "--watch",
    "--compiler-version", b.compiler, "--evm-version", b.evmVersion,
  ];
  if (b.optimizerRuns !== null) args.push("--num-of-optimizations", String(b.optimizerRuns));
  for (const [lib, address] of Object.entries(s.libraries ?? {})) args.push("--libraries", `${lib}:${address}`);
  if (s.constructorArgs && s.constructorArgs !== "0x") args.push("--constructor-args", s.constructorArgs);
  return ["FOUNDRY_PROFILE=sepolia", ...args];
}

// forge verify-contract for each contract the record holds as deployed, from the build it records.
function verify() {
  if (!existsSync(RECORD)) usage(`--verify: there is no ${RECORD}`);
  if (!process.env.ETHERSCAN_API_KEY) usage("--verify: ETHERSCAN_API_KEY is not set (forge reads the Etherscan key from it)");
  const record = readJson(RECORD);
  const hashes = artifactHashes();
  for (const n of Object.keys(UNITS))
    if (record.artifacts?.[n] !== hashes[n]) usage(`--verify: ${n} is built differently from what was deployed (commit ${record.commit})`);
  for (const s of record.steps) {
    if (!s.ok) {
      console.log(`     ${s.name}: not deployed, skipped`);
      continue;
    }
    const [, , ...args] = verifyArgs(s);
    args.push("--root", CONTRACTS);
    console.log(`\n${s.name} at ${s.address}:`);
    const env = toolEnv({ FOUNDRY_PROFILE: "sepolia", ETHERSCAN_API_KEY: process.env.ETHERSCAN_API_KEY });
    const r = spawnSync("forge", args, { cwd: CONTRACTS, env, encoding: "utf8", windowsHide: true, maxBuffer: 1 << 26 });
    // forge's output, without the key should it ever print it.
    const key = process.env.ETHERSCAN_API_KEY;
    for (const text of [r.stdout, r.stderr]) if (text) console.log(redact(text).split(key).join("<redacted>"));
    check(r.status === 0, `forge verify-contract ${s.name} at ${s.address}: ${NETWORK.explorer}/address/${s.address}#code`);
  }
  exit(failed ? 1 : 0);
}

// ------------------------------------------------------------------ main

// The plan from `start`, or the reason the build cannot serve it.
function planFrom(start) {
  try {
    return buildPlan(start);
  } catch (err) {
    check(false, err.message);
    exit(1);
  }
}

started = true;
try {
  if (MODE === "--verify") {
    planFrom(0); // the build's checks
    verify();
  }

  const unreachable = (err) => {
    if (err instanceof Exit) throw err;
    console.log(`${NETWORK.title} RPC unreachable (${redact(err.message)})`);
    exit(2);
  };
  const chainId = await rpc("eth_chainId", []).catch(unreachable);
  if (!check(BigInt(chainId) === CHAIN_ID, `chain id ${BigInt(chainId)} is ${NETWORK.title}`)) exit(1);

  // With --resume, the record's first unmined step, after reconciling a step sent before the run
  // stopped; then the chain as it is now.
  let record;
  let plan;
  let from = 0;
  if (opts["--resume"]) {
    if (!existsSync(RECORD)) usage(`--resume: there is no ${RECORD}`);
    record = readJson(RECORD);
    plan = planFrom(record.startNonce);
    from = await reconcile(record, plan, matchRecord(record, plan)).catch(unreachable);
    if (from === plan.length) {
      console.log(`Every step in ${RECORD} is mined and checked.`);
      if (MODE === "--send" && !record.reads) await liveChecks(record, plan).catch(unreachable);
      exit(failed ? 1 : 0);
    }
  } else if (existsSync(RECORD)) {
    if (MODE === "--send") usage(`${RECORD} exists: continue it with --resume, or move it away to start a new deployment`);
    console.log(`(${RECORD} exists; --resume dry-runs what is left of it)`);
  }
  const ctx = {};
  let n;
  let held;
  try {
    ctx.block = await rpc("eth_getBlockByNumber", ["latest", false]);
    ctx.fees = await feesAt(ctx.block, { priorityFee: PRIORITY_FEE, maxFee: MAX_FEE });
    ctx.balance = BigInt(await rpc("eth_getBalance", [deployer, ctx.block.number]));
    ctx.nonce = Number(BigInt(await rpc("eth_getTransactionCount", [deployer, ctx.block.number])));
    n = await nonces(deployer);
    held = await rpc("eth_call", [{ to: LIGHT_CLIENT, data: hex(concat(sel("stateRootOf(bytes32)"), bytes(B.hash))) }, ctx.block.number]);
  } catch (err) {
    unreachable(err);
  }
  console.log(`${NETWORK.title} block ${fmt(Number(BigInt(ctx.block.number)))} (${ctx.block.hash}), simulated on top of it via ${new URL(RPC).host}`);
  console.log(`Deployer ${DEPLOYER}: nonce ${ctx.nonce}, balance ${eth(ctx.balance)}`);
  const heldRoot = held.slice(0, 66).toLowerCase();
  if (!check(heldRoot === B.stateRoot && BigInt("0x" + held.slice(66, 130)) === BigInt(B.number), `GrandpaLightClient #2 holds V3 #${fmt(B.number)} ${short(B.hash)} with the fixture's state root ${short(B.stateRoot)}`))
    exit(1);
  if (n.pending !== n.latest) {
    const what = `the deployer has pending transactions (nonce ${n.latest}, pending ${n.pending})`;
    if (MODE === "--send") {
      check(false, `${what}: wait until they are mined`);
      exit(1);
    }
    console.log(`     (${what}: the plan starts at the mined nonce)`);
  }
  if (record) console.log(`Resuming ${RECORD} at step ${from} (${plan[from].name}), nonce ${plan[from].nonce}`);
  plan ??= planFrom(ctx.nonce);
  if (!check(ctx.nonce === plan[from].nonce, `the deployer's next nonce is the plan's, ${plan[from].nonce}`)) {
    if (record && ctx.nonce > plan[from].nonce)
      console.log(
        `     nonce ${plan[from].nonce} is used on chain but the record has no transaction for ${plan[from].name}:` +
          ` find it on a block explorer, put its hash in that step's txHash, and resume`,
      );
    exit(1);
  }

  let planned = null;
  try {
    planned = await dryRun(plan, plan.slice(from), ctx);
  } catch (err) {
    if (err instanceof Exit) throw err;
    check(false, redact(err.message));
  }
  if (!planned) {
    console.log("\nThe dry run failed: nothing can be sent.");
    exit(1);
  }
  if (MODE !== "--send") {
    console.log("\nThe dry run passed. Nothing was signed or sent.");
    exit(0);
  }
  console.log("\nThe dry run passed. Sending:");
  record ??= newRecord(plan);
  await send(record, plan, from, planned, ctx.fees);
  await liveChecks(record, plan).catch(unreachable);
  console.log(`\nEvery step is mined and checked; the record is ${RECORD}.`);
  exit(failed ? 1 : 0);
} catch (err) {
  if (!(err instanceof Exit)) throw err;
  process.exitCode = err.code;
}
