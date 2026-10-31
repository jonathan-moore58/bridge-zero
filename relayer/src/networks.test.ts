// Unit tests of --network, offline: Sepolia stays the default, with its RPC, chain id, cap and the
// sender's file names as before, and useNetwork moves all of them to Base Sepolia, Arbitrum Sepolia
// or the BNB Smart Chain testnet (contracts/script/lib/sepolia.mjs NETWORKS). The priority fee: 1,000
// wei on the first three as before, the BNB Smart Chain testnet's 0.1 gwei (the least its validators
// include), and a lower --priority-fee refused there by every tool that sends. The mint tool's
// --network: Sepolia's records and nonces as before, each rollup's pair at the deployer's next two
// nonces there, bound to that rollup's V3 light client, the BNB Smart Chain testnet's at the same
// nonces and addresses, and the options it refuses. Nothing is read from a chain.
//
//   npm test

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { CAP, CHAIN_ID, feesFrom, mktxArgs, NETWORK, NETWORKS, priorityFeeProblem, RPC, SEPOLIA_CHAIN_ID, useNetwork, type Fees } from "../../contracts/script/lib/sepolia.mjs";
import { minterConstructorArgs, tokenConstructorArgs, V3_CHAIN_ID } from "./bridge.js";
import { bytesToHex, hexToBytes } from "./bytes.js";
import { bridgePair } from "./mint.js";
import { senderOf } from "./relay.js";
import { createAddress } from "./vault.js";

const ADDRESS = "0xe94a82e2c7f38f777e8845a9d8c36b6be6a30257" as const;
const fees: Fees = { base: 16n, tip: 1_000n, maxFee: 10_000_000n, gasPrice: 1_016n };
const chainOf = (args: string[]) => args[args.indexOf("--chain") + 1];
const signArgs = () => mktxArgs("t", { to: ADDRESS, data: "0x", nonce: 0, gasLimit: 21_000, fees, account: "a", passwordFile: "p" });

describe("--network", () => {
  it("Sepolia is the default, as before", () => {
    assert.equal(NETWORK.name, "sepolia");
    assert.equal(CHAIN_ID, SEPOLIA_CHAIN_ID);
    assert.equal(CHAIN_ID, 11_155_111n);
    assert.equal(RPC, process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com");
    assert.equal(CAP, 16_777_216);
    assert.equal(chainOf(signArgs()), "11155111");
    const s = senderOf(ADDRESS, ADDRESS, "state");
    assert.equal(s.record, join("state", `relay-sepolia-${ADDRESS}.json`));
    assert.equal(s.history, join("state", `relay-sepolia-${ADDRESS}.jsonl`));
    assert.equal(s.lock, join("state", `relay-sepolia-${ADDRESS}.lock`));
    assert.deepEqual(NETWORK.archives, ["https://sepolia.drpc.org", "https://sepolia.gateway.tenderly.co"], "Sepolia's archive RPCs as before");
  });

  it("useNetwork moves the RPC, the chain id, the signing and the sender's files to the network", () => {
    try {
      for (const [name, id] of [["base-sepolia", 84_532n], ["arbitrum-sepolia", 421_614n], ["bsc-testnet", 97n]] as const) {
        const net = useNetwork(name);
        assert.equal(NETWORK, net);
        assert.equal(CHAIN_ID, id);
        assert.equal(RPC, process.env[net.rpcEnv] || net.rpcs[0]);
        assert.notEqual(RPC, NETWORKS.sepolia.rpcs[0]);
        assert.equal(CAP, 16_777_216);
        assert.equal(chainOf(signArgs()), String(id));
        const s = senderOf(ADDRESS, ADDRESS, "state");
        assert.equal(s.record, join("state", `relay-${name}-${ADDRESS}.json`));
        assert.equal(s.lock, join("state", `relay-${name}-${ADDRESS}.lock`), "one lock per network and sender: never Sepolia's");
      }
      assert.throws(() => useNetwork("linea-sepolia"), /no network linea-sepolia/);
      assert.throws(() => useNetwork("toString"), /no network toString/);
    } finally {
      useNetwork("sepolia");
    }
    assert.equal(CHAIN_ID, SEPOLIA_CHAIN_ID);
    assert.equal(RPC, process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com");
  });

  it("every network names at least two RPCs and its archives, all https, and a distinct chain id", () => {
    const ids = new Set<bigint>();
    for (const [name, net] of Object.entries(NETWORKS)) {
      assert.equal(net.name, name);
      assert.ok(net.rpcs.length >= 2, `${name}: two RPCs or more`);
      assert.ok(net.archives.length >= 1, `${name}: an archive RPC`);
      for (const url of [...net.rpcs, ...net.archives, net.explorer]) assert.match(url, /^https:\/\//, `${name}: ${url}`);
      assert.equal(new Set(net.rpcs).size, net.rpcs.length, `${name}: no RPC twice`);
      assert.ok(!ids.has(net.chainId), `${name}: chain id ${net.chainId} once`);
      ids.add(net.chainId);
    }
    assert.deepEqual(Object.keys(NETWORKS), ["sepolia", "base-sepolia", "arbitrum-sepolia", "bsc-testnet"], "the three first, in their order, then the BNB Smart Chain testnet");
  });

  it("the BNB Smart Chain testnet: its RPCs (publicnode, which serves the logs, first), archives, explorer, cap and tip", () => {
    const bsc = NETWORKS["bsc-testnet"];
    assert.deepEqual(
      [bsc.name, bsc.title, bsc.chainId, bsc.rpcEnv, bsc.archiveEnv, bsc.explorer, bsc.gasCap, bsc.tip],
      ["bsc-testnet", "BNB Smart Chain testnet", 97n, "BSC_TESTNET_RPC_URL", "BSC_TESTNET_ARCHIVE_RPC_URLS", "https://testnet.bscscan.com", 16_777_216, 100_000_000n],
    );
    assert.equal(bsc.rpcs[0], "https://bsc-testnet-rpc.publicnode.com");
    assert.ok(bsc.rpcs.every((u) => !/:8545/.test(u)), "no :8545 host: the server reaches port 443 only");
    assert.deepEqual(bsc.archives, ["https://bsc-testnet.bnbchain.org", "https://97.rpc.thirdweb.com"]);
    for (const name of ["sepolia", "base-sepolia", "arbitrum-sepolia"] as const) assert.equal(NETWORKS[name].tip, undefined, `${name}: no tip, 1,000 wei as before`);
  });
});

describe("the priority fee on each network", () => {
  it("is 1,000 wei on Sepolia and the rollups as before, and the BNB Smart Chain testnet's 0.1 gwei there, its max fee 0.1 gwei at its base fee of 0", () => {
    for (const name of ["sepolia", "base-sepolia", "arbitrum-sepolia"] as const) {
      assert.deepEqual(feesFrom(16n, {}, NETWORKS[name]), { base: 16n, tip: 1_000n, maxFee: 10_000_000n }, name);
      assert.deepEqual(feesFrom(2_000_000_000n, {}, NETWORKS[name]), { base: 2_000_000_000n, tip: 1_000n, maxFee: 20_000_001_000n }, name);
    }
    assert.deepEqual(feesFrom(0n, {}, NETWORKS["bsc-testnet"]), { base: 0n, tip: 100_000_000n, maxFee: 100_000_000n });
    assert.deepEqual(feesFrom(0n, { priorityFee: 200_000_000n }, NETWORKS["bsc-testnet"]), { base: 0n, tip: 200_000_000n, maxFee: 200_000_000n }, "--priority-fee above the tip");
    assert.deepEqual(feesFrom(0n, { maxFee: 300_000_000n }, NETWORKS["bsc-testnet"]), { base: 0n, tip: 100_000_000n, maxFee: 300_000_000n }, "--max-fee");
    // The network in use by default: Sepolia's here.
    assert.equal(NETWORK.name, "sepolia");
    assert.equal(feesFrom(0n).tip, 1_000n);
    try {
      useNetwork("bsc-testnet");
      assert.equal(feesFrom(0n).tip, 100_000_000n, "the network in use");
    } finally {
      useNetwork("sepolia");
    }
  });

  it("refuses a --priority-fee below the BNB Smart Chain testnet's 0.1 gwei, and nothing on the others", () => {
    assert.equal(
      priorityFeeProblem(50_000_000n, NETWORKS["bsc-testnet"]),
      "--priority-fee 0.05 gwei is below 0.1 gwei, the least the BNB Smart Chain testnet's validators include: a transaction offering less is never mined",
    );
    assert.equal(priorityFeeProblem(100_000_000n, NETWORKS["bsc-testnet"]), null);
    assert.equal(priorityFeeProblem(undefined, NETWORKS["bsc-testnet"]), null);
    for (const name of ["sepolia", "base-sepolia", "arbitrum-sepolia"] as const) assert.equal(priorityFeeProblem(1n, NETWORKS[name]), null, name);
  });

  it("is refused below the floor by the deploy script, the relayer, the mint tool, the auto-mint and the burn, before anything is read", () => {
    const relayer = dirname(dirname(fileURLToPath(import.meta.url)));
    const contracts = join(dirname(relayer), "contracts");
    const closed = { BSC_TESTNET_RPC_URL: "http://127.0.0.1:9", BSC_TESTNET_ARCHIVE_RPC_URLS: "http://127.0.0.1:9" };
    const run = (cwd: string, args: string[]) => spawnSync(process.execPath, args, { cwd, encoding: "utf8", windowsHide: true, timeout: 60_000, env: { ...process.env, ...closed } });
    const floor = /--priority-fee 0\.05 gwei is below 0\.1 gwei, the least the BNB Smart Chain testnet's validators include/;
    for (const [cwd, args] of [
      [contracts, ["script/deploy-sepolia.mjs", "--network", "bsc-testnet", "--priority-fee", "0.05"]],
      [relayer, ["--import", "tsx", "src/relay-main.ts", "--chain", "v3", "--network", "bsc-testnet", "--priority-fee", "0.05"]],
      [relayer, ["--import", "tsx", "src/mint.ts", "plan", "--network", "bsc-testnet", "--nonce", "8", "--priority-fee", "0.05"]],
      [relayer, ["--import", "tsx", "src/automint-main.ts", "--network", "sepolia,bsc-testnet", "--priority-fee", "0.05"]],
      [relayer, ["--import", "tsx", "src/release.ts", "burn", "--network", "bsc-testnet", "--amount", "0.001", "--v3-recipient", "0xD9838A86cF83C28Ee486544060D1cA4Ca2971071", "--priority-fee", "0.05"]],
    ] as const) {
      const r = run(cwd, [...args]);
      assert.equal(r.status, 1, `${args.join(" ")}\n${r.stdout}${r.stderr}`);
      assert.match(r.stdout, floor, args.join(" "));
      assert.doesNotMatch(r.stdout + r.stderr, /unreachable|ECONNREFUSED|fetch failed/i, `${args.join(" ")}: a request was made`);
    }
  });
});

describe("npm run mint -- deploy --network", () => {
  const relayer = dirname(dirname(fileURLToPath(import.meta.url)));
  const repo = dirname(relayer);
  const record = <T>(file: string): T => JSON.parse(readFileSync(join(repo, file), "utf8")) as T;
  type Step = { name: string; nonce: number; address: string; constructorArgs?: string; kind: string };
  const sepoliaBridge = record<{ deployer: string; vault: { address: string; codeHash: string }; steps: Step[] }>("deployments/sepolia-bridge.json");
  const deployer = hexToBytes(sepoliaBridge.deployer);
  const create = (nonce: number) => bytesToHex(createAddress(deployer, BigInt(nonce)));
  const words = (args: string) => (args.slice(2).match(/.{64}/g) ?? []).map((w) => `0x${w}`);

  it("Sepolia keeps its records and nonces 31 and 32, where its pair is", () => {
    assert.deepEqual(bridgePair("sepolia"), { clientRecord: "deployments/sepolia.json", bridgeRecord: "deployments/sepolia-bridge.json", minterNonce: 31, tokenNonce: 32 });
    const at = (name: string) => sepoliaBridge.steps.find((s) => s.kind === "deploy" && s.name === name)!;
    assert.deepEqual([at("BridgeMinter").nonce, at("BridgeMinter").address], [31, create(31)]);
    assert.deepEqual([at("WrappedTPOT").nonce, at("WrappedTPOT").address], [32, create(32)]);
  });

  for (const network of ["base-sepolia", "arbitrum-sepolia", "bsc-testnet"] as const) {
    // The BNB Smart Chain testnet's records are written at its deployment: until then this test waits.
    const records = [`deployments/${network}.json`, `deployments/${network}-funding.json`];
    const missing = records.filter((f) => !existsSync(join(repo, f)));
    const skip = missing.length === 0 ? false : `${missing.join(" and ")} not written yet: nothing is deployed on ${network}`;
    it(`${network}: the pair at the deployer's next two nonces there, bound to that chain's V3 client`, { skip }, () => {
      const pair = bridgePair(network);
      assert.deepEqual(pair, { clientRecord: `deployments/${network}.json`, bridgeRecord: `deployments/${network}-bridge.json`, minterNonce: 9, tokenNonce: 10 });
      // The light client's deployment took the deployer's nonces 0 to 7 there, the relayer's funding 8.
      const lc = record<{ chainId: number; deployer: string; contracts: Record<string, string>; steps: Step[] }>(pair.clientRecord);
      const funding = record<{ steps: Record<string, { chain: string; from: string; nonce: number }> }>(`deployments/${network}-funding.json`);
      assert.equal(lc.chainId, Number(NETWORKS[network].chainId));
      assert.equal(lc.deployer.toLowerCase(), bytesToHex(deployer));
      assert.deepEqual(lc.steps.map((s) => s.nonce), [0, 1, 2, 3, 4, 5, 6, 7]);
      const there = Object.values(funding.steps).filter((s) => s.chain === network && s.from.toLowerCase() === bytesToHex(deployer));
      assert.deepEqual(there.map((s) => s.nonce), [8]);
      assert.equal(pair.minterNonce, Math.max(...lc.steps.map((s) => s.nonce), ...there.map((s) => s.nonce)) + 1);
      assert.equal(pair.tokenNonce, pair.minterNonce + 1);
      // The same addresses on both rollups, none that a record there holds already.
      assert.equal(create(pair.minterNonce), "0xdc31a3bc1354545eeb985aad7b2aa662e9272348");
      assert.equal(create(pair.tokenNonce), "0xe1130718c56de008b47c392c85895a1a605ba95e");
      const pairAddresses: string[] = [create(pair.minterNonce), create(pair.tokenNonce)];
      for (const s of lc.steps) assert.ok(!pairAddresses.includes(s.address.toLowerCase()), `${s.name} is elsewhere`);
      // Sepolia's constructor arguments with the rollup's own V3 client and token: the same vault, V3 chain id and code hash.
      const client = lc.contracts["GrandpaLightClient #2"];
      assert.equal(client, "0x389781d4856f0a9f3266ca6e76be6c7b7cfe0ab6");
      const args = bytesToHex(minterConstructorArgs(hexToBytes(client), hexToBytes(sepoliaBridge.vault.address), V3_CHAIN_ID, hexToBytes(sepoliaBridge.vault.codeHash), hexToBytes(create(10))));
      const sepoliaArgs = words(sepoliaBridge.steps.find((s) => s.name === "BridgeMinter")!.constructorArgs!);
      const rollupArgs = words(args);
      assert.equal(rollupArgs.length, 5);
      assert.deepEqual(rollupArgs.slice(1, 4), sepoliaArgs.slice(1, 4), "vault, V3 chain id 420420777 and vault code hash as on Sepolia");
      assert.equal(BigInt(rollupArgs[0]), BigInt(client));
      assert.equal(BigInt(rollupArgs[4]), BigInt(create(10)));
      assert.equal(bytesToHex(tokenConstructorArgs(hexToBytes(create(9)))), `0x${"0".repeat(24)}${create(9).slice(2)}`);
    });
  }

  it("bsc-testnet: the pair at the deployer's nonces 9 and 10, as on the rollups, so at their addresses", () => {
    const pair = bridgePair("bsc-testnet");
    assert.deepEqual(pair, { clientRecord: "deployments/bsc-testnet.json", bridgeRecord: "deployments/bsc-testnet-bridge.json", minterNonce: 9, tokenNonce: 10 });
    assert.deepEqual([pair.minterNonce, pair.tokenNonce], [bridgePair("base-sepolia").minterNonce, bridgePair("base-sepolia").tokenNonce]);
    assert.equal(create(pair.minterNonce), "0xdc31a3bc1354545eeb985aad7b2aa662e9272348");
    assert.equal(create(pair.tokenNonce), "0xe1130718c56de008b47c392c85895a1a605ba95e");
    // Nonces 0 to 7: the light client's deployment, at the rollups' addresses (GrandpaLightClient #2 at 4, ProvenBalance #2 at 5).
    assert.equal(create(4), "0x389781d4856f0a9f3266ca6e76be6c7b7cfe0ab6");
    assert.equal(create(5), "0x40f4b03aa20d3e7ce2503c406a4fe4a46ba886f0");
  });

  it("refuses what the mint tool on a rollup does not take, before it reads anything", () => {
    const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "src/mint.ts", ...args], { cwd: relayer, encoding: "utf8", windowsHide: true, timeout: 60_000 });
    for (const [args, message] of [
      [["deploy", "--network", "base-sepolia", "--nonce", "0"], /a deploy on base-sepolia reads no lock: --bundle and --nonce are for Sepolia's/],
      // A mint there takes that rollup's lock: the default bundle is Sepolia's lock 0.
      [["mint", "--network", "arbitrum-sepolia"], /mint on arbitrum-sepolia takes --bundle <file> or --nonce <n>: fixtures\/v3-testnet-mint\/mint-bundle.json is Sepolia's lock 0/],
      [["plan", "--network", "base-sepolia", "--nonce", "4", "--sandbox"], /--sandbox, --tamper and --replay are Sepolia's: the demo ran there/],
      [["mint", "--network", "base-sepolia", "--nonce", "4", "--tamper", "signature"], /--sandbox, --tamper and --replay are Sepolia's/],
      [["bundle", "--check", "no-such-file.json", "--network", "base-sepolia"], /--check is offline: --out, --force, --rpc, --evm and --network are for a capture/],
      [["status", "--network", "linea-sepolia"], /--network takes one of sepolia, base-sepolia, arbitrum-sepolia, bsc-testnet/],
      [["deploy", "--network", "linea-sepolia"], /--network takes one of sepolia, base-sepolia, arbitrum-sepolia, bsc-testnet/],
      [["deploy", "--network", "bsc-testnet", "--nonce", "0"], /a deploy on bsc-testnet reads no lock: --bundle and --nonce are for Sepolia's/],
      [["mint", "--network", "bsc-testnet"], /mint on bsc-testnet takes --bundle <file> or --nonce <n>/],
      [["plan", "--network", "bsc-testnet", "--nonce", "8", "--sandbox"], /--sandbox, --tamper and --replay are Sepolia's/],
    ] as const) {
      const r = run(...args);
      assert.equal(r.status, 1, args.join(" "));
      assert.match(r.stdout, message);
      assert.match(r.stdout, /usage \(from relayer\/\):/);
    }
  });
});
