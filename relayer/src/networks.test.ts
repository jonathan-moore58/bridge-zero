// Unit tests of --network, offline: Sepolia stays the default, with its RPC, chain id, cap and the
// sender's file names as before, and useNetwork moves all of them to Base Sepolia or Arbitrum
// Sepolia (contracts/script/lib/sepolia.mjs NETWORKS). The mint tool's --network: Sepolia's records
// and nonces as before, each rollup's pair at the deployer's next two nonces there, bound to that
// rollup's V3 light client, and the options it refuses. Nothing is read from a chain.
//
//   npm test

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { CAP, CHAIN_ID, mktxArgs, NETWORK, NETWORKS, RPC, SEPOLIA_CHAIN_ID, useNetwork, type Fees } from "../../contracts/script/lib/sepolia.mjs";
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
      for (const [name, id] of [["base-sepolia", 84_532n], ["arbitrum-sepolia", 421_614n]] as const) {
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

  for (const network of ["base-sepolia", "arbitrum-sepolia"] as const) {
    it(`${network}: the pair at the deployer's next two nonces there, bound to that rollup's V3 client`, () => {
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

  it("refuses what the mint tool on a rollup does not take, before it reads anything", () => {
    const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "src/mint.ts", ...args], { cwd: relayer, encoding: "utf8", windowsHide: true, timeout: 60_000 });
    for (const [args, message] of [
      [["deploy", "--network", "base-sepolia", "--nonce", "0"], /a deploy on base-sepolia reads no lock: --bundle and --nonce are for Sepolia's/],
      // A mint there takes that rollup's lock: the default bundle is Sepolia's lock 0.
      [["mint", "--network", "arbitrum-sepolia"], /mint on arbitrum-sepolia takes --bundle <file> or --nonce <n>: fixtures\/v3-testnet-mint\/mint-bundle.json is Sepolia's lock 0/],
      [["plan", "--network", "base-sepolia", "--nonce", "4", "--sandbox"], /--sandbox, --tamper and --replay are Sepolia's: the demo ran there/],
      [["mint", "--network", "base-sepolia", "--nonce", "4", "--tamper", "signature"], /--sandbox, --tamper and --replay are Sepolia's/],
      [["bundle", "--check", "no-such-file.json", "--network", "base-sepolia"], /--check is offline: --out, --force, --rpc, --evm and --network are for a capture/],
      [["status", "--network", "linea-sepolia"], /--network takes one of sepolia, base-sepolia, arbitrum-sepolia/],
      [["deploy", "--network", "linea-sepolia"], /--network takes one of sepolia, base-sepolia, arbitrum-sepolia/],
    ] as const) {
      const r = run(...args);
      assert.equal(r.status, 1, args.join(" "));
      assert.match(r.stdout, message);
      assert.match(r.stdout, /usage \(from relayer\/\):/);
    }
  });
});
