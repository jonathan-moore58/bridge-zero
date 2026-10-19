// SPDX-License-Identifier: UNLICENSED
//
// Deploys Bridge Zero to Sepolia and records the first evidence on chain. The plan is one
// transaction per step, in nonce order from the deployer's nonce on chain:
//   1. the libraries SCL_EIP6565, GrandpaCodec, AuthoritySets and StorageProofs;
//   2. GrandpaLightClient #1 and ProvenBalance #1 (bound to #1) for the old Portaldot mainnet,
//      then GrandpaLightClient #2 and ProvenBalance #2 (bound to #2) for the Portaldot V3 testnet;
//   3. on #1, from fixtures/mainnet: initialize with the set that signs the set change, at its
//      parent; importHeader (the set change); importAndProve (head + System.Account); the same
//      importAndProve with one signature byte flipped, mined as a failed transaction;
//   4. on #2, from fixtures/v3-testnet: the same, with the checkpoint at the set change that
//      started the signing set (signingSet.announced, else the parent) and a trie V1 proof.
//
// Usage (from contracts/, after `forge build` and `FOUNDRY_PROFILE=sepolia forge build --skip test
// --skip script`; the sepolia profile in foundry.toml links the libraries at compile time, at the
// addresses the deployer's nonces 0 to 3 create, so Etherscan can match the metadata):
//   node script/deploy-sepolia.mjs [--dry-run] [--resume]
//   node script/deploy-sepolia.mjs --send --account bz-deployer --password-file <path> [--resume]
//   node script/deploy-sepolia.mjs --verify
//
// --dry-run (the default) has a Sepolia node run the plan with eth_simulateV1 (validation on) at
// the latest block, from the deployer with its own nonce and balance. Each step runs with the
// cap as gas limit, then again with the limit it is sent with (its gas + 10%, at most the cap).
// --send re-runs the dry run, checks the keystore and the nonce, sends each step with cast send
// and checks its receipt; deployments/sepolia.json (repo root) records every step when it is sent
// and when it is mined, and --resume continues that file from its first unmined step.
// --verify submits every deployed contract to Etherscan with forge verify-contract (forge reads
// the key from ETHERSCAN_API_KEY).
// Fees: a priority fee of 1,000 wei and a max fee of ten times the next base fee plus it, at least
// 0.01 gwei, fixed for the run; --priority-fee and --max-fee (gwei) replace them. The
// RPC is SEPOLIA_RPC_URL when set, else the public endpoint. Exit code 0 on success, 1 when a
// check fails, 2 when the RPC cannot be reached, 3 when a sent transaction is still pending.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  RPC,
  CAP,
  SEPOLIA_CHAIN_ID,
  REQUEST_GAS,
  RECEIPT_TIMEOUT,
  CONTRACTS,
  FIXTURES,
  keccak256,
  hex,
  bytes,
  concat,
  word,
  createAddress,
  blake2b,
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
  findLog,
  dataWord,
  PROBE,
  PROBE_SENDER,
  PROBE_CODE,
  PROBE_GAS,
  artifact,
  contractId,
  linkedLibraries,
  linkedCode,
  topic,
  fixtureCalls,
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

const DEPLOYER = "0xD9838A86cF83C28Ee486544060D1cA4Ca2971071";
const deployer = DEPLOYER.toLowerCase();
const RECORD = join(CONTRACTS, "..", "deployments", "sepolia.json");
// The deployment build: FOUNDRY_PROFILE=sepolia forge build --skip test --skip script.
const SEPOLIA_OUT = join(CONTRACTS, "out-sepolia");

const tag = (s) => `[${String(s.index).padStart(2)}]`;
const short = (h) => `${h.slice(0, 10)}…`;

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
  node script/deploy-sepolia.mjs [--dry-run] [--resume] [--priority-fee <gwei>] [--max-fee <gwei>]
  node script/deploy-sepolia.mjs --send --account <keystore> --password-file <path> [--resume] [fees]
  node script/deploy-sepolia.mjs --verify`);
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
// cast runs in a directory of its own: the path is made absolute here (the file is never opened by this script).
if (opts["--password-file"]) opts["--password-file"] = resolve(opts["--password-file"]);
if (MODE === "--send" && !existsSync(opts["--password-file"])) usage("--password-file: no such file");

// An amount in gwei ("0.001") in wei.
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

// ------------------------------------------------------------------ the plan

const LIBRARIES = ["SCL_EIP6565", "GrandpaCodec", "AuthoritySets", "StorageProofs"];
const UNITS = [...LIBRARIES, "GrandpaLightClient", "ProvenBalance"];
const CHAINS = [
  { id: "#1", dir: "mainnet", title: "the old Portaldot mainnet", checkpoint: "parent" },
  { id: "#2", dir: "v3-testnet", title: "the Portaldot V3 testnet", checkpoint: "announced" },
];

const T = {
  initialized: topic("Initialized(bytes32,uint64,bytes32,uint32,bytes32)"),
  imported: topic("HeaderImported(bytes32,uint32,bytes32,uint64,uint256)"),
  changed: topic("AuthoritySetChanged(uint64,uint64,bytes32,uint256,uint32)"),
  halted: topic("Halted(uint32,bytes32,uint8)"),
  proven: topic("BalanceProven(bytes32,uint32,bytes32,uint128)"),
};

// The creation code a deployment sends: the sepolia build's, which links the libraries at compile
// time. It must hold the plan's library addresses where the default build has its placeholders.
function deployCode(name, addresses) {
  const linked = linkedCode(name, addresses);
  const code = artifact(name, SEPOLIA_OUT).bytecode.object.toLowerCase();
  const rebuild = "rebuild it with FOUNDRY_PROFILE=sepolia forge build --skip test --skip script";
  if (code.length !== linked.length || code.includes("__$")) throw new Error(`${name}: the sepolia build differs; ${rebuild}`);
  for (const refs of Object.values(artifact(name).bytecode.linkReferences))
    for (const [lib, offsets] of Object.entries(refs))
      for (const { start, length } of offsets)
        if (code.slice(2 + 2 * start, 2 + 2 * (start + length)) !== addresses[lib].slice(2).toLowerCase())
          throw new Error(`${name}: the sepolia build does not link ${lib} at ${addresses[lib]} (the deployer's nonce moved?); ${rebuild}`);
  return code;
}

// Every step from `start`, the deployer's nonce for the first one: step i is the transaction at
// nonce start + i. A deployment carries its linked creation code and constructor arguments; a
// call its target, calldata and the checks of its logs (and, simulated, of its return value).
function buildPlan(start) {
  const steps = [];
  const add = (step) => steps.push({ index: steps.length, nonce: start + steps.length, ...step });
  const lib = {};
  const deploy = (name, contract, label, args = new Uint8Array(), more = {}) => {
    const address = createAddress(deployer, start + steps.length);
    const libraries = {};
    for (const [id, l] of Object.entries(linkedLibraries(contract))) libraries[id] = lib[l];
    const data = hex(concat(bytes(deployCode(contract, lib)), args));
    add({ name, label, kind: "deploy", contract, address, libraries, constructorArgs: hex(args), data, ...more });
    return address;
  };
  for (const name of LIBRARIES) lib[name] = deploy(name, name, name);
  const chains = CHAINS.map((c) => ({ ...c }));
  for (const c of chains) {
    const chain = `${c.title} (fixtures/${c.dir})`;
    c.lc = deploy(`GrandpaLightClient ${c.id}`, "GrandpaLightClient", `GrandpaLightClient ${c.id}, ${c.title}`, undefined, { chain });
    c.pb = deploy(`ProvenBalance ${c.id}`, "ProvenBalance", `ProvenBalance ${c.id}, bound to ${c.id}`, word(BigInt(c.lc)), { chain });
  }
  for (const c of chains) {
    const f = fixtureCalls(join(FIXTURES, c.dir), { checkpoint: c.checkpoint });
    const { sc, fp, ap, checkpoint: cp } = f;
    for (const h of [cp, sc.header, fp.header])
      if (hex(blake2b(bytes(h.scale), 32)) !== h.hash.toLowerCase()) throw new Error(`fixtures/${c.dir}: header #${h.number} hash`);
    const files = (...names) => names.map((n) => `fixtures/${c.dir}/${n}.json`);
    const oldSet = sc.signingSet.setId;
    const where = cp === sc.parentHeader ? "the set change's parent" : `the set change that started set ${oldSet}`;
    const onLc = { kind: "call", to: c.lc, target: `GrandpaLightClient ${c.id}`, fixtures: files("set-change"), group: c.id };
    const onPb = { to: c.pb, target: `ProvenBalance ${c.id}`, fixtures: files("finality-proof-head", "account-proof"), group: c.id };
    add({
      ...onLc,
      name: `${c.id} initialize`,
      label: `${c.id} initialize: set ${oldSet}, ${sc.signingSet.authorities.length} keys, checkpoint #${fmt(cp.number)} (${where})`,
      data: hex(f.initData),
      checks: ({ logs }) => {
        const log = findLog(logs, c.lc, T.initialized, sc.provenance.genesisHash.toLowerCase());
        const ok =
          !!log && dataWord(log, 0) === BigInt(oldSet) && dataWord(log, 2) === BigInt(cp.number) && dataWord(log, 3) === BigInt(cp.hash);
        return [[ok, `Initialized: genesis ${short(sc.provenance.genesisHash)}, set ${oldSet}, checkpoint ${short(cp.hash)}`]];
      },
    });
    add({
      ...onLc,
      name: `${c.id} importHeader`,
      label:
        `${c.id} importHeader: set change #${fmt(sc.header.number)},` +
        ` ${sc.justification.precommits.length} of ${sc.signingSet.authorities.length} signatures`,
      data: hex(f.changeData),
      checks: ({ logs }) => {
        const imported = findLog(logs, c.lc, T.imported, sc.header.hash.toLowerCase());
        const changed = findLog(logs, c.lc, T.changed);
        const moved = !!changed && BigInt(changed.topics[1]) === BigInt(oldSet) && BigInt(changed.topics[2]) === BigInt(sc.newSetId);
        return [
          [!!imported && BigInt(imported.topics[2]) === BigInt(sc.header.number), `HeaderImported #${fmt(sc.header.number)}`],
          [moved && !findLog(logs, c.lc, T.halted), `AuthoritySetChanged ${oldSet} -> ${sc.newSetId}, not halted`],
        ];
      },
    });
    add({
      ...onPb,
      kind: "call",
      name: `${c.id} importAndProve`,
      label:
        `${c.id} importAndProve: head #${fmt(fp.header.number)}, ${f.head.hint.length / 2} of` +
        ` ${fp.signingSet.authorities.length} signatures + System.Account (trie V${ap.trieVersion})`,
      data: hex(f.proveData(f.finalityProof)),
      checks: ({ logs, returnData }) => {
        const out = [];
        const d = ap.value.decoded;
        // importAndProve's return value: (bytes32 blockHash, uint32 number, AccountInfo info).
        if (returnData !== undefined) {
          const ret = bytes(returnData);
          const w = (i) => BigInt(hex(ret.slice(32 * i, 32 * i + 32)));
          out.push([hex(ret.slice(0, 32)) === fp.header.hash.toLowerCase(), "importAndProve returns the head hash"]);
          out.push([w(1) === BigInt(fp.header.number), `importAndProve returns block #${fp.header.number}`]);
          const fields = ["nonce", "consumers", "providers", "sufficients", "free", "reserved", "miscFrozen", "feeFrozen"];
          fields.forEach((k, i) => out.push([w(2 + i) === BigInt(d[k]), `AccountInfo.${k} = ${d[k]}`]));
        }
        // BalanceProven(bytes32 indexed blockHash, uint32 number, bytes32 indexed accountId, uint128 free).
        const log = findLog(logs, c.pb, T.proven);
        out.push([!!log, "BalanceProven emitted by ProvenBalance"]);
        if (log) {
          out.push([log.topics[1] === fp.header.hash.toLowerCase(), "BalanceProven.blockHash"]);
          out.push([log.topics[2] === ap.account.id.toLowerCase(), "BalanceProven.accountId"]);
          out.push([dataWord(log, 0) === BigInt(fp.header.number), "BalanceProven.number"]);
          out.push([dataWord(log, 1) === BigInt(d.free), "BalanceProven.free"]);
        }
        out.push([!!findLog(logs, c.lc, T.imported, fp.header.hash.toLowerCase()), `HeaderImported #${fmt(fp.header.number)}`]);
        return out;
      },
    });
    add({
      ...onPb,
      kind: "tamper",
      name: `${c.id} importAndProve, one signature byte flipped`,
      label: `${c.id} importAndProve, one signature byte flipped`,
      data: hex(f.proveData(f.tampered)),
      revert: f.invalidSignature,
      revertName: `InvalidSignature(0, ${f.head.first[1]})`,
    });
  }
  return steps;
}

// ------------------------------------------------------------------ dry run

// Requests of consecutive steps: deployments two at a time (two transactions at the cap and the
// probe stay under REQUEST_GAS), and every call on one light client in the same request (its
// storage is not carried from one request to the next).
function requestsOf(steps) {
  const out = [];
  for (const s of steps) {
    const last = out.at(-1);
    const joins = last && (s.group ? last[0].group === s.group : !last[0].group && last.length < 2);
    if (joins) last.push(s);
    else out.push([s]);
  }
  return out;
}

// Runs `steps` on the node, each with gas limit `limitOf(step)`, in the requests above, all on top
// of ctx.block. The first request runs on the chain's own state; later ones carry, as state
// overrides, the code of the deployments so far, the light clients' admin slot (slot 0, which the
// constructor sets to the deployer) and the deployer's nonce and remaining balance as the probe
// read them: no balance is added. Returns each step's result, the deployer's balance after the
// last step and the most gas one request needed.
async function simulatePlan(steps, limitOf, ctx) {
  const results = new Map();
  const carried = {};
  let deployerState;
  let peak = 0;
  const fee = { maxFeePerGas: qty(ctx.fees.maxFee), maxPriorityFeePerGas: qty(ctx.fees.tip) };
  for (const request of requestsOf(steps)) {
    const deployed = request.filter((s) => s.kind === "deploy");
    const probed = [deployer, ...deployed.map((s) => s.address)];
    const calls = request.map((s) => ({
      from: deployer,
      nonce: qty(s.nonce),
      gas: qty(limitOf(s)),
      ...fee,
      ...(s.to ? { to: s.to } : {}),
      data: s.data,
    }));
    calls.push({ from: PROBE_SENDER, to: PROBE, gas: qty(PROBE_GAS), ...fee, data: hex(concat(...probed.map((a) => word(BigInt(a))))) });
    const stateOverrides = { ...carried, [PROBE]: { code: PROBE_CODE }, [PROBE_SENDER]: { balance: qty(10n ** 18n) } };
    if (deployerState) stateOverrides[deployer] = deployerState;
    const params = [{ blockStateCalls: [{ stateOverrides, calls }], validation: true }, ctx.block.number];
    const [sim] = await rpc("eth_simulateV1", params).catch((err) => {
      throw new Error(`request [${request.map((s) => s.index).join(",")}]: ${err.message}`);
    });

    const probe = sim.calls.at(-1);
    if (probe.status !== "0x1") throw new Error(`the probe call failed: ${probe.error?.message}`);
    const words = bytes(probe.returnData);
    const at = (i) => hex(words.slice(32 * i, 32 * i + 32));
    // The node sets a call's whole gas limit aside from what the request may still use.
    let used = 0;
    request.forEach((s, i) => {
      results.set(s.index, sim.calls[i]);
      peak = Math.max(peak, used + limitOf(s));
      used += gasOf(sim.calls[i]);
    });
    peak = Math.max(peak, used + PROBE_GAS);
    deployed.forEach((s, k) => {
      const r = results.get(s.index);
      r.codeHashThere = at(2 * (k + 1));
      if (r.status !== "0x1") return;
      carried[s.address] = { code: r.returnData };
      if (s.contract === "GrandpaLightClient") carried[s.address].state = { ["0x" + "00".repeat(32)]: hex(word(BigInt(deployer))) };
    });
    deployerState = { nonce: qty(request.at(-1).nonce + 1), balance: qty(BigInt(at(1))) };
    ctx.simulatedBaseFee = BigInt(sim.baseFeePerGas);
  }
  return { results, balance: BigInt(deployerState.balance), peak };
}

// The checks of one simulated step, as [ok, what] pairs; the first is the step itself.
function judge(s, r, limit) {
  const gas = `${share(gasOf(r))}; gas limit ${fmt(limit)}`;
  if (s.kind === "deploy") {
    const created = r.status === "0x1" && r.codeHashThere === hex(keccak256(bytes(r.returnData)));
    const what =
      r.status !== "0x1"
        ? r.error?.message
        : created
          ? `${fmt((r.returnData.length - 2) / 2)} bytes of code there, ${gas}`
          : "its code is not at the CREATE address";
    return [[created, `${tag(s)} ${s.label}, nonce ${s.nonce}, at ${s.address}: ${what}`]];
  }
  if (s.kind === "tamper") {
    const got = r.error?.data ?? r.returnData;
    const ok = r.status === "0x0" && got === s.revert;
    return [[ok, `${tag(s)} ${s.label}: ${ok ? `reverted with ${s.revertName}, ${gas}` : `status ${r.status}, ${got}`}`]];
  }
  const ok = r.status === "0x1";
  const lines = [[ok, `${tag(s)} ${s.label}: ${ok ? gas : r.error?.message}`]];
  if (ok) for (const [k, what] of s.checks({ logs: r.logs, returnData: r.returnData })) lines.push([k, `     ${what}`]);
  return lines;
}

// Proves `steps` (what is left of the plan) on the node. Returns, per step, the gas limit it is
// sent with, its simulated gas and, for a deployment, the hash of the code it leaves; null when a
// check fails.
async function dryRun(steps, ctx) {
  const { fees, balance } = ctx;
  console.log(
    `Fees: next base fee ${fmt(fees.base)} wei, priority fee ${fmt(fees.tip)} wei, max fee ${fmt(fees.maxFee)} wei` +
      ` (node gas price ${fmt(fees.gasPrice)} wei)`,
  );
  if (!check(fees.maxFee >= fees.base && fees.maxFee >= fees.tip, "the max fee covers the next base fee and the priority fee")) return null;
  const deploys = steps.filter((s) => s.kind === "deploy").length;
  console.log(
    `\nPlan: ${steps.length} transactions from nonce ${steps[0].nonce}, ${deploys} deployments and ${steps.length - deploys} calls.` +
      ` eth_simulateV1 with validation on, from the deployer at its nonce and with its balance on chain;` +
      ` each request goes on from what the previous one left (no balance is added).`,
  );
  const groups = requestsOf(steps).map((r) => `[${r.map((s) => s.index).join(",")}]`);
  console.log(`Requests ${groups.join(" ")}: every step first with gas limit 16,777,216, then with the gas limit below.`);

  // 1. Measure, with the cap as gas limit.
  const first = await simulatePlan(steps, () => CAP, ctx);
  const measured = steps.map((s) => judge(s, first.results.get(s.index), CAP)).flat();
  if (measured.some(([ok]) => !ok)) {
    console.log("\nWith gas limit 16,777,216:");
    for (const [ok, what] of measured) check(ok, what);
    return null;
  }
  const limits = new Map(steps.map((s) => [s.index, withHeadroom(gasOf(first.results.get(s.index)))]));

  // 2. The exact plan: every step with the gas limit it is sent with.
  const run = await simulatePlan(steps, (s) => limits.get(s.index), ctx);
  let section;
  let total = 0;
  let largest = 0;
  for (const s of steps) {
    const c = CHAINS.find((x) => x.id === s.group);
    const heading = c ? `On GrandpaLightClient ${c.id} and ProvenBalance ${c.id}, ${c.title} (fixtures/${c.dir}):` : "Deployments:";
    if (heading !== section) console.log(`\n${heading}`);
    section = heading;
    const r = run.results.get(s.index);
    for (const [ok, what] of judge(s, r, limits.get(s.index))) check(ok, what);
    if (gasOf(r) !== gasOf(first.results.get(s.index)))
      check(false, `     ${fmt(gasOf(first.results.get(s.index)))} gas with the cap as gas limit, ${fmt(gasOf(r))} with ${fmt(limits.get(s.index))}`);
    total += gasOf(r);
    largest = Math.max(largest, gasOf(r));
  }

  // 3. Gas and cost. Before each transaction the deployer must hold its gas limit at the max fee;
  // at most, every earlier one paid the max fee too.
  console.log(`\n     ${steps.length} transactions: ${fmt(total)} gas; the largest ${share(largest)}`);
  const top = Math.max(...limits.values());
  check(top <= CAP, `every gas limit is within the 16,777,216 cap (the largest ${fmt(top)})`);
  const peak = Math.max(first.peak, run.peak);
  check(peak <= REQUEST_GAS, `the largest request needs ${fmt(peak)} of the ${fmt(REQUEST_GAS)} gas one request may use`);
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
  return steps.map((s) => {
    const r = run.results.get(s.index);
    const codeHash = s.kind === "deploy" ? hex(keccak256(bytes(r.returnData))) : null;
    return { limit: limits.get(s.index), simulatedGas: gasOf(r), codeHash };
  });
}

// ------------------------------------------------------------------ record

const git = (args) => {
  const r = spawnSync("git", args, { cwd: CONTRACTS, encoding: "utf8", windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
};
// The unlinked creation code of each contract, to tell whether the build changed.
const artifactHashes = () =>
  Object.fromEntries(UNITS.map((n) => [n, hex(keccak256(Buffer.from(artifact(n, SEPOLIA_OUT).bytecode.object)))]));
const dataHash = (s) => hex(keccak256(bytes(s.data)));

function newRecord(steps) {
  return {
    network: "sepolia",
    chainId: Number(SEPOLIA_CHAIN_ID),
    deployer: DEPLOYER,
    commit: git(["rev-parse", "HEAD"]),
    dirty: git(["status", "--porcelain", "--untracked-files=no"]) !== "",
    startNonce: steps[0].nonce,
    artifacts: artifactHashes(),
    contracts: {},
    steps: steps.map((s) => ({
      name: s.name,
      kind: s.kind,
      nonce: s.nonce,
      contract: s.kind === "deploy" ? contractId(s.contract) : s.target,
      address: s.kind === "deploy" ? s.address : s.to,
      ...(s.kind === "deploy" ? { libraries: s.libraries, constructorArgs: s.constructorArgs } : {}),
      ...(s.chain ? { chain: s.chain } : {}),
      fixtures: s.fixtures ?? [],
      expected: s.kind === "tamper" ? `status 0, ${s.revertName}` : "status 1",
      dataHash: dataHash(s),
      gasLimit: null,
      simulatedGas: null,
      codeHash: null,
      txHash: null,
      block: null,
      gasUsed: null,
      status: null,
      ok: null,
    })),
  };
}

function save(record) {
  record.contracts = {};
  for (const s of record.steps) if (s.kind === "deploy" && s.ok) record.contracts[s.name] = s.address;
  writeJsonAtomic(RECORD, record);
}

// The record against the plan rebuilt from its start nonce: same names, nonces, addresses and
// transaction data, from the same build. Returns the index of its first step not yet mined.
function matchRecord(record, steps) {
  const fail = (why) => {
    console.log(`FAIL ${RECORD} does not match this plan: ${why}`);
    exit(1);
  };
  if (record.chainId !== Number(SEPOLIA_CHAIN_ID) || record.deployer.toLowerCase() !== deployer) fail("network or deployer");
  const hashes = artifactHashes();
  for (const n of UNITS) if (record.artifacts?.[n] !== hashes[n]) fail(`${n} is built differently (the record is from commit ${record.commit})`);
  if (record.steps.length !== steps.length) fail("step count");
  record.steps.forEach((r, i) => {
    const s = steps[i];
    const address = s.kind === "deploy" ? s.address : s.to;
    if (r.name !== s.name || r.nonce !== s.nonce || r.address !== address || r.dataHash !== dataHash(s)) fail(`step ${i} (${r.name})`);
    if (r.block !== null && !r.ok) fail(`step ${i} (${r.name}) was mined but failed its checks; see tx ${r.txHash}`);
  });
  const next = record.steps.findIndex((r) => r.block === null);
  return next < 0 ? steps.length : next;
}

// ------------------------------------------------------------------ send

// Checks a mined step against the dry run and writes it into the record. A deployment must be
// at its CREATE address with the simulated code, a call must emit the expected events, and a
// tampered call must have failed, with the expected error when replayed on its block.
async function recordReceipt(record, s, receipt) {
  const entry = record.steps[s.index];
  const status = Number(BigInt(receipt.status));
  const gasUsed = gasOf(receipt);
  const lines = [
    [
      status === (s.kind === "tamper" ? 0 : 1),
      `${tag(s)} ${s.label}: status ${status}, block ${fmt(Number(BigInt(receipt.blockNumber)))}, ${share(gasUsed)}` +
        ` (simulated ${fmt(entry.simulatedGas)}), tx ${receipt.transactionHash}`,
    ],
  ];
  if (s.kind === "deploy") {
    lines.push([receipt.contractAddress?.toLowerCase() === s.address, `     created at ${s.address}`]);
    const code = await retry("code", () => rpc("eth_getCode", [s.address, "latest"]));
    lines.push([hex(keccak256(bytes(code))) === entry.codeHash, "     with the code the dry run left there"]);
  } else if (s.kind === "call") {
    for (const [ok, what] of s.checks({ logs: receipt.logs })) lines.push([ok, `     ${what}`]);
  } else {
    // A receipt has no revert reason: replay the call on the state its block left (it wrote nothing).
    // An error without revert data (a node that has not seen the block yet) is retried.
    const replay = await retry("replay", async () => {
      const body = await rpcBody("eth_call", [{ from: deployer, to: s.to, data: s.data, gas: qty(entry.gasLimit) }, receipt.blockNumber]);
      if (body.error && body.error.data === undefined) throw new Error(body.error.message);
      return body;
    }).catch((err) => ({ error: { message: err.message } }));
    if (replay.error && replay.error.data === undefined)
      console.log(`     (the replay returned no revert data: ${redact(replay.error.message)})`);
    else lines.push([replay.error?.data === s.revert, `     replayed on its block: ${replay.error?.data === s.revert ? s.revertName : JSON.stringify(replay)}`]);
  }
  let ok = true;
  for (const [k, what] of lines) ok = check(k, what) && ok;
  Object.assign(entry, {
    txHash: receipt.transactionHash,
    block: Number(BigInt(receipt.blockNumber)),
    gasUsed,
    status,
    effectiveGasPrice: BigInt(receipt.effectiveGasPrice ?? 0).toString(),
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
      to: s.kind === "deploy" ? null : s.to,
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

// The first unmined step was sent before the run stopped: record it if it was mined (and look
// at the next), send it again if it was dropped, stop if it is still pending.
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
  Object.assign(entry, { dropped: [...(entry.dropped ?? []), entry.txHash], txHash: null });
  if (MODE === "--send") save(record);
  return from;
}

// ------------------------------------------------------------------ verify

// forge verify-contract for each deployed contract in the record, with the compiler settings of
// its artifact, its libraries' addresses and its constructor arguments.
function verify() {
  if (!existsSync(RECORD)) usage(`--verify: there is no ${RECORD}`);
  if (!process.env.ETHERSCAN_API_KEY) usage("--verify: ETHERSCAN_API_KEY is not set (forge reads the Etherscan key from it)");
  const record = JSON.parse(readFileSync(RECORD, "utf8"));
  const hashes = artifactHashes();
  for (const n of UNITS)
    if (record.artifacts?.[n] !== hashes[n]) usage(`--verify: ${n} is built differently from what was deployed (commit ${record.commit})`);
  for (const s of record.steps.filter((x) => x.kind === "deploy")) {
    if (!s.ok) {
      console.log(`     ${s.name}: not deployed, skipped`);
      continue;
    }
    const meta = artifact(s.contract.split(":").at(-1), SEPOLIA_OUT).metadata;
    const args = [
      "verify-contract", s.address, s.contract,
      "--chain", "sepolia", "--verifier", "etherscan", "--root", CONTRACTS, "--watch",
      "--compiler-version", meta.compiler.version, "--evm-version", meta.settings.evmVersion,
    ];
    if (meta.settings.optimizer?.enabled) args.push("--num-of-optimizations", String(meta.settings.optimizer.runs));
    for (const [lib, address] of Object.entries(s.libraries ?? {})) args.push("--libraries", `${lib}:${address}`);
    if (s.constructorArgs && s.constructorArgs !== "0x") args.push("--constructor-args", s.constructorArgs);
    console.log(`\n${s.name} at ${s.address}:`);
    const env = toolEnv({ FOUNDRY_PROFILE: "sepolia", ETHERSCAN_API_KEY: process.env.ETHERSCAN_API_KEY });
    const r = spawnSync("forge", args, { cwd: CONTRACTS, env, stdio: "inherit", windowsHide: true });
    check(r.status === 0, `forge verify-contract ${s.name} at ${s.address}`);
  }
  exit(failed ? 1 : 0);
}

// ------------------------------------------------------------------ main

started = true;
try {
  if (MODE === "--verify") verify();

  const unreachable = (err) => {
    if (err instanceof Exit) throw err;
    console.log(`Sepolia RPC unreachable (${redact(err.message)})`);
    exit(2);
  };
  const chainId = await rpc("eth_chainId", []).catch(unreachable);
  if (!check(BigInt(chainId) === SEPOLIA_CHAIN_ID, `chain id ${BigInt(chainId)} is Sepolia`)) exit(1);

  // With --resume, the record's first unmined step, after reconciling a step sent before the run
  // stopped; then the chain as it is now.
  let record;
  let plan;
  let from = 0;
  if (opts["--resume"]) {
    if (!existsSync(RECORD)) usage(`--resume: there is no ${RECORD}`);
    record = JSON.parse(readFileSync(RECORD, "utf8"));
    plan = buildPlan(record.startNonce);
    from = await reconcile(record, plan, matchRecord(record, plan)).catch(unreachable);
    if (from === plan.length) {
      console.log(`Every step in ${RECORD} is mined and checked.`);
      exit(0);
    }
  } else if (existsSync(RECORD)) {
    if (MODE === "--send") usage(`${RECORD} exists: continue it with --resume, or move it away to start a new deployment`);
    console.log(`(${RECORD} exists; --resume dry-runs what is left of it)`);
  }
  const ctx = {};
  let n;
  try {
    ctx.block = await rpc("eth_getBlockByNumber", ["latest", false]);
    // The fees are fixed for the run: the plan costs at most about 0.0012 ETH at today's base fee.
    ctx.fees = await feesAt(ctx.block, { priorityFee: PRIORITY_FEE, maxFee: MAX_FEE });
    ctx.balance = BigInt(await rpc("eth_getBalance", [deployer, ctx.block.number]));
    ctx.nonce = Number(BigInt(await rpc("eth_getTransactionCount", [deployer, ctx.block.number])));
    n = await nonces(deployer);
  } catch (err) {
    unreachable(err);
  }
  console.log(`Sepolia block ${fmt(Number(BigInt(ctx.block.number)))} (${ctx.block.hash}), simulated on top of it via ${new URL(RPC).host}`);
  console.log(`Deployer ${DEPLOYER}: nonce ${ctx.nonce}, balance ${eth(ctx.balance)}`);
  if (n.pending !== n.latest) {
    const what = `the deployer has pending transactions (nonce ${n.latest}, pending ${n.pending})`;
    if (MODE === "--send") {
      check(false, `${what}: wait until they are mined`);
      exit(1);
    }
    console.log(`     (${what}: the plan starts at the mined nonce)`);
  }
  if (record) console.log(`Resuming ${RECORD} at step ${from} (${plan[from].name}), nonce ${plan[from].nonce}`);
  plan ??= buildPlan(ctx.nonce);
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
    planned = await dryRun(plan.slice(from), ctx);
  } catch (err) {
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
  await send(record ?? newRecord(plan), plan, from, planned, ctx.fees);
  console.log(`\nEvery step is mined and checked; the record is ${RECORD}.`);
  exit(failed ? 1 : 0);
} catch (err) {
  if (!(err instanceof Exit)) throw err;
  process.exitCode = err.code;
}
