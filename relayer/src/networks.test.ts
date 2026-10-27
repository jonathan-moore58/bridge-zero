// Unit tests of --network, offline: Sepolia stays the default, with its RPC, chain id, cap and the
// sender's file names as before, and useNetwork moves all of them to Base Sepolia or Arbitrum
// Sepolia (contracts/script/lib/sepolia.mjs NETWORKS). Nothing is read from a chain.
//
//   npm test

import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CAP, CHAIN_ID, mktxArgs, NETWORK, NETWORKS, RPC, SEPOLIA_CHAIN_ID, useNetwork, type Fees } from "../../contracts/script/lib/sepolia.mjs";
import { senderOf } from "./relay.js";

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
