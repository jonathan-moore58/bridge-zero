// Unit tests of vault.ts, offline: amounts, the lock commitment and the burn id against values
// computed independently with cast (cast keccak of cast abi-encode) and pinned in
// contracts/test/unit/PortaldotVault.t.sol, calldata and events, the addresses V3 derives, and
// the recipients and destinations a lock may name.
//
//   npm test

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Keyring } from "@polkadot/api";
import { bytesToHex, hexToBytes } from "./bytes.js";
import {
  bridgeDestination,
  burnId,
  checksumAddress,
  commitmentSlot,
  createAddress,
  decodeLocked,
  decodeReleased,
  ethAccountId,
  evmDecimals,
  fillImmutables,
  formatEvmTpot,
  formatTpot,
  LOCK_TAG,
  BURN_TAG,
  LOCKED_TOPIC,
  lockCalldata,
  lockCommitment,
  multisigAccountId,
  parseAddress,
  parseTpot,
  readImmutables,
  readVaultBuild,
  recipientProblem,
  releasedSlot,
  RELEASED_TOPIC,
  reviveAddress,
  selector,
  uintWord,
  vaultError,
} from "./vault.js";

const SEPOLIA = 11_155_111n;
const V3 = 420_420_777n;
/** The address the deploy dry run of Oct 19 gave the vault, from the testnet account 5ERJ… at nonce 1. */
const VAULT = hexToBytes("0xa02ee16eb03d2cf1aef199f7658fb8c8e3188ffd");
const MINTER = hexToBytes("0x2222222222222222222222222222222222222222");
const RECIPIENT = hexToBytes("0xd9838a86cf83c28ee486544060d1ca4ca2971071");

describe("amounts", () => {
  it("parses tPOT with up to 14 decimals into native base units", () => {
    assert.equal(parseTpot("1"), 10n ** 14n);
    assert.equal(parseTpot("1.5"), 150_000_000_000_000n);
    assert.equal(parseTpot("0.00000000000001"), 1n);
    assert.equal(parseTpot("12345.67890123456789"), 1_234_567_890_123_456_789n);
    assert.equal(parseTpot("007.10"), 710_000_000_000_000n);
  });

  it("refuses dust, zero and anything that is not a plain decimal", () => {
    assert.throws(() => parseTpot("0.000000000000001"), /more than 14 decimals/);
    assert.throws(() => parseTpot("1.000000000000000"), /more than 14 decimals/);
    assert.throws(() => parseTpot("0"), /zero/);
    assert.throws(() => parseTpot("0.0"), /zero/);
    for (const bad of ["", " 1", "1 ", "-1", "+1", "1e3", "0x10", "1,5", ".5", "5.", "1.2.3", "NaN"]) {
      assert.throws(() => parseTpot(bad), /not an amount of tPOT/, bad);
    }
  });

  it("formats native and EVM units", () => {
    assert.equal(formatTpot(150_000_000_000_000n), "1.5 tPOT");
    assert.equal(formatTpot(1n), "0.00000000000001 tPOT");
    assert.equal(formatTpot(29_998_499_371_110_948n), "299.98499371110948 tPOT");
    assert.equal(evmDecimals(10_000n), 18);
    assert.equal(formatEvmTpot(2n * 10n ** 18n, 10_000n), "2 tPOT");
    assert.equal(formatEvmTpot(39_630n, 10_000n), "0.00000000000003963 tPOT");
    assert.throws(() => evmDecimals(12_345n), /power of ten/);
  });
});

describe("commitment and burn id", () => {
  it("has the tags of the contract", () => {
    assert.equal(bytesToHex(LOCK_TAG), "0x97705c2fe6926c6def9409b415f85497add261074403a14627f3c4353bf2fdaa");
    assert.equal(bytesToHex(BURN_TAG), "0xaa5369688b962d482b9c8fc1873d27f938cb062d24d1155999fbe045abeca7b3");
  });

  it("computes the commitment Solidity computes", () => {
    const commitment = lockCommitment({ v3ChainId: V3, vault: VAULT, dstChainId: SEPOLIA, dstMinter: MINTER, recipient: RECIPIENT, amountNative: 150_000_000_000_000n, nonce: 7n });
    assert.equal(bytesToHex(commitment), "0xc1463a99819a56870997bbef04e4c914b0655a07c6bf660d2fb7017be9ba0220");
    assert.equal(bytesToHex(commitmentSlot(7n)), "0x870253054e3d98b71abec8fff9ebf8a15d167f15909091a800d4acaab9266d2b");
  });

  it("changes with every field", () => {
    const base = { v3ChainId: V3, vault: VAULT, dstChainId: SEPOLIA, dstMinter: MINTER, recipient: RECIPIENT, amountNative: 1n, nonce: 0n };
    const other = hexToBytes("0x0000000000000000000000000000000000000001");
    const variants = [
      { ...base, v3ChainId: 1n },
      { ...base, vault: other },
      { ...base, dstChainId: 1n },
      { ...base, dstMinter: other },
      { ...base, recipient: other },
      { ...base, amountNative: 2n },
      { ...base, nonce: 1n },
    ];
    const seen = new Set([bytesToHex(lockCommitment(base)), ...variants.map((v) => bytesToHex(lockCommitment(v)))]);
    assert.equal(seen.size, variants.length + 1);
  });

  it("computes the burn id and its slot as Solidity does", () => {
    const id = burnId(SEPOLIA, MINTER, 3n);
    assert.equal(bytesToHex(id), "0xf688c1d329d7adf3defb167190841944f5ad9c4d6427e4d066de0ce0a54d6595");
    assert.equal(bytesToHex(releasedSlot(id)), "0x55fe0247b9ac52165caf16904b6c4b4bef53e6f691f5c32a6257343ff9f02489");
  });
});

describe("calldata and events", () => {
  it("encodes lock(uint256,address,address)", () => {
    const data = lockCalldata(SEPOLIA, MINTER, RECIPIENT);
    assert.equal(bytesToHex(selector("lock(uint256,address,address)")), "0xecd1eb6c");
    assert.equal(
      bytesToHex(data),
      "0xecd1eb6c" +
        "0000000000000000000000000000000000000000000000000000000000aa36a7" +
        "0000000000000000000000002222222222222222222222222222222222222222" +
        "000000000000000000000000d9838a86cf83c28ee486544060d1ca4ca2971071",
    );
  });

  it("decodes Locked and Released, and refuses other logs", () => {
    const commitment = "0x" + "ab".repeat(32);
    const log = {
      address: bytesToHex(VAULT),
      topics: [LOCKED_TOPIC, bytesToHex(uintWord(7n)), "0x" + "00".repeat(12) + "d9838a86cf83c28ee486544060d1ca4ca2971071", "0x" + "00".repeat(12) + "1111111111111111111111111111111111111111"],
      data: bytesToHex(uintWord(SEPOLIA)) + "000000000000000000000000" + "2222222222222222222222222222222222222222" + bytesToHex(uintWord(5n)).slice(2) + commitment.slice(2),
    };
    const e = decodeLocked(log);
    assert.equal(e.nonce, 7n);
    assert.equal(bytesToHex(e.sender), "0xd9838a86cf83c28ee486544060d1ca4ca2971071");
    assert.equal(bytesToHex(e.recipient), "0x1111111111111111111111111111111111111111");
    assert.equal(e.dstChainId, SEPOLIA);
    assert.equal(bytesToHex(e.dstMinter), bytesToHex(MINTER));
    assert.equal(e.amountNative, 5n);
    assert.equal(bytesToHex(e.commitment), commitment);
    assert.throws(() => decodeLocked({ ...log, topics: [RELEASED_TOPIC, ...log.topics.slice(1)] }), /not a Locked log/);
    assert.throws(() => decodeLocked({ ...log, data: log.data.slice(0, -2) }), /odd number|bytes of data/);
    assert.throws(() => decodeLocked({ ...log, topics: [log.topics[0], log.topics[1], "0x" + "ff".repeat(32), log.topics[3]] }), /not an address/);

    const r = decodeReleased({ address: log.address, topics: [RELEASED_TOPIC, commitment, log.topics[2]], data: bytesToHex(uintWord(9n)) });
    assert.equal(bytesToHex(r.burnId), commitment);
    assert.equal(r.amountNative, 9n);
  });

  it("names the vault's errors", () => {
    assert.equal(vaultError(hexToBytes("0x884f8896")), "DustNotAllowed()");
    assert.equal(vaultError(hexToBytes("0xb7852ebb")), "ZeroArgument()");
    assert.equal(vaultError(hexToBytes("0x12345678")), null);
  });
});

describe("addresses", () => {
  it("checks EIP-55 checksums", () => {
    assert.equal(checksumAddress(RECIPIENT), "0xD9838A86cF83C28Ee486544060D1cA4Ca2971071");
    assert.deepEqual(parseAddress("0xD9838A86cF83C28Ee486544060D1cA4Ca2971071"), RECIPIENT);
    assert.deepEqual(parseAddress("0xd9838a86cf83c28ee486544060d1ca4ca2971071"), RECIPIENT);
    assert.throws(() => parseAddress("0xD9838A86cF83C28Ee486544060D1cA4Ca2971070"), /checksum/);
    assert.throws(() => parseAddress("0xd9838a86cf83c28ee486544060d1ca4ca297107"), /40 hex digits/);
  });

  it("derives the vault's address from the deployer's address and nonce", () => {
    const deployer = hexToBytes("0xb621f9a9dd96ba88681c40b04657cef602854e24");
    assert.equal(bytesToHex(createAddress(deployer, 1n)), bytesToHex(VAULT));
    assert.equal(bytesToHex(createAddress(deployer, 0n)), "0xc38d475642c17260e9114642e9de11267728b791");
    // The deployer's nonce 0 on Sepolia created the SCL library (deployments/sepolia.json).
    assert.equal(bytesToHex(createAddress(RECIPIENT, 0n)), "0x51da20be3e6e23296f2c435b16445aae7a18b77e");
  });

  it("maps accounts to addresses as pallet-revive does", () => {
    const keyring = new Keyring({ ss58Format: 42 });
    // reviveApi.address(5ERJ…) and reviveApi.accountId(0xD983…1071) on the V3 testnet, Oct 19.
    assert.equal(bytesToHex(reviveAddress(keyring.decodeAddress("5ERJiUnzmQwEF98X3rGyKiNsyjrcenLGJST3MULCjUSwgPJ7"))), "0xb621f9a9dd96ba88681c40b04657cef602854e24");
    assert.equal(keyring.encodeAddress(ethAccountId(RECIPIENT), 42), "5GyuKkF3Hpv6aRwFa5BtcWvXLqGDjGfMLi1f2jFraJ4Zuef5");
    assert.equal(bytesToHex(reviveAddress(ethAccountId(RECIPIENT))), bytesToHex(RECIPIENT));
  });

  it("derives the committee's 2-of-3 multisig account and its address", () => {
    const keyring = new Keyring({ ss58Format: 42 });
    const members = ["5DLnLMAsR3kkHnHndC4eRWhMFXPjCU8bGiSugCjUmGJaBism", "5F99Y91UgQ4EDTubPWWPvWKc3ghhVA77nc7HjRhsTyXn38z9", "5EJJYKuM5aaKwgegKGinAbnL7dK3m3QziyqusPotTQ3S7w1E"].map((a) =>
      keyring.decodeAddress(a),
    );
    const multisig = multisigAccountId(members, 2);
    assert.equal(bytesToHex(multisig), "0x965d40eafb701a82cb344dc54fd7b89ec8b328c4fcd922b9c728ed782c646af8");
    assert.equal(keyring.encodeAddress(multisig, 42), "5FTrjzEPPdxo3WP1RcQGTzUX1y1udD7tAkaETV1iLH24xPk3");
    assert.deepEqual(multisigAccountId([...members].reverse(), 2), multisig, "the order of the members does not matter");
    // reviveApi.address(5FTrjz…) on the V3 testnet, Oct 19: the vault's RELEASER.
    assert.equal(bytesToHex(reviveAddress(multisig)), "0xa08a7f7ded49cc81f901fb42fec00edfc48c0fc1");
    assert.notDeepEqual(multisigAccountId(members, 3), multisig);
    assert.throws(() => multisigAccountId(members, 4), /threshold/);
    assert.throws(() => multisigAccountId([members[0], members[0]], 1), /twice/);
  });
});

describe("a lock's recipient and destination", () => {
  it("refuses a recipient that is a Substrate account's address on V3: no Ethereum key holds it", () => {
    const keyring = new Keyring({ ss58Format: 42 });
    const five = keyring.decodeAddress("5ERJiUnzmQwEF98X3rGyKiNsyjrcenLGJST3MULCjUSwgPJ7");
    const fives = reviveAddress(five);
    assert.equal(checksumAddress(fives), "0xB621f9A9Dd96BA88681c40B04657CEf602854e24");
    // revive.originalAccount maps it to 5ERJ… (AutoMap): refused, from an EVM lock or a Substrate one.
    for (const sender of [null, five, ethAccountId(RECIPIENT)]) {
      assert.match(recipientProblem(fives, "5ERJiUnzmQwEF98X3rGyKiNsyjrcenLGJST3MULCjUSwgPJ7", sender) ?? "", /Substrate account 5ERJ.*no Ethereum key holds it/);
    }
    // The locking account's own address, before revive.originalAccount maps it.
    assert.match(recipientProblem(fives, null, five) ?? "", /locking Substrate account's own address/);
    // An Ethereum key's address: from an EVM lock, from 5ERJ…, and from the account that stands for that key (its own address is the key's).
    for (const sender of [null, five, ethAccountId(RECIPIENT)]) assert.equal(recipientProblem(RECIPIENT, null, sender), null);
  });

  it("reads the destination a bridge record names for the vault: its chain and BridgeMinter", () => {
    const record = JSON.parse(readFileSync(fileURLToPath(new URL("../../deployments/sepolia-bridge.json", import.meta.url)), "utf8")) as Record<string, unknown>;
    const d = bridgeDestination(record, VAULT, V3);
    assert.ok(d);
    assert.equal(d.chainId, SEPOLIA);
    assert.equal(checksumAddress(d.minter), "0x8287B3Baf205CA8456f98346F13064AA7fCDcB9E");
    // A record of a minter for another vault, or for this address on another chain, names no destination of this vault.
    assert.equal(bridgeDestination(record, MINTER, V3), null);
    assert.equal(bridgeDestination({ ...record, vault: { ...(record.vault as object), chainId: 1 } }, VAULT, V3), null);
    // A record without that shape is refused.
    assert.throws(() => bridgeDestination({ ...record, contracts: {} }, VAULT, V3), /BridgeMinter/);
    assert.throws(() => bridgeDestination({ ...record, chainId: "sepolia" }, VAULT, V3), /chain id/);
    assert.throws(() => bridgeDestination({ ...record, vault: null }, VAULT, V3), /vault\.address/);
    assert.throws(() => bridgeDestination([], VAULT, V3), /object/);
  });
});

describe("the V3 build's immutables", () => {
  // A stand-in artifact: 64 bytes of code whose words 0 and 1 are the two immutables.
  const artifact = {
    bytecode: { object: "0x6001" },
    deployedBytecode: {
      object: "0x" + "00".repeat(64) + "5b",
      immutableReferences: { "5": [{ start: 0, length: 32 }], "9": [{ start: 32, length: 32 }] },
    },
    metadata: {
      compiler: { version: "0.8.27+commit.40a35a09" },
      settings: { evmVersion: "cancun", viaIR: true, optimizer: { enabled: true, runs: 200 }, metadata: { appendCBOR: false }, compilationTarget: { "src/bridge/PortaldotVault.sol": "PortaldotVault" } },
      sources: { "src/bridge/PortaldotVault.sol": { keccak256: "0x" + "11".repeat(32) } },
    },
    ast: {
      nodes: [
        { nodeType: "VariableDeclaration", stateVariable: true, mutability: "immutable", id: 9, name: "NATIVE_TO_ETH_RATIO" },
        { nodeType: "VariableDeclaration", stateVariable: true, mutability: "immutable", id: 5, name: "RELEASER" },
      ],
    },
  };
  const releaser = hexToBytes("0xa08a7f7ded49cc81f901fb42fec00edfc48c0fc1");

  it("fills them in by name and reads them back", () => {
    const build = readVaultBuild(artifact);
    const code = fillImmutables(build, 10_000n, releaser);
    assert.equal(bytesToHex(code), "0x" + "00".repeat(12) + "a08a7f7ded49cc81f901fb42fec00edfc48c0fc1" + bytesToHex(uintWord(10_000n)).slice(2) + "5b");
    const read = readImmutables(build, code);
    assert.ok(read);
    assert.equal(read.ratio, 10_000n);
    assert.deepEqual(read.releaser, releaser);
  });

  it("refuses code that is not the build's", () => {
    const build = readVaultBuild(artifact);
    const code = fillImmutables(build, 10_000n, releaser);
    const changed = code.slice();
    changed[64] ^= 1;
    assert.equal(readImmutables(build, changed), null);
    assert.equal(readImmutables(build, code.slice(0, 64)), null);
    assert.equal(readImmutables(build, fillImmutables(build, 0n, releaser)), null, "a zero ratio");
  });

  it("refuses an artifact without the AST or with other immutables", () => {
    assert.throws(() => readVaultBuild({ ...artifact, ast: undefined }), /no AST/);
    const renamed = { ...artifact, ast: { nodes: [{ ...artifact.ast.nodes[0], name: "OWNER" }, artifact.ast.nodes[1]] } };
    assert.throws(() => readVaultBuild(renamed), /unexpected immutable OWNER/);
  });
});
