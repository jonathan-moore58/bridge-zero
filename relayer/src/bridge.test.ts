// Unit tests of bridge.ts, offline: the minter's calldata and constructor arguments against
// values cast computed (cast calldata, cast abi-encode, cast keccak, cast compute-address), the
// events and errors, the check of deployed code, the signers hint and the offline checks on the
// mint bundle captured from the V3 testnet (fixtures/v3-testnet-mint), the demo's tampered and
// replayed calls on that bundle, the dry-run guard (fetch, the WebSocket client, a polkadot-js
// provider), a polkadot-js connection within its timeout, and the windows a log search asks.
//
//   npm test

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, flipByte, hexToBytes } from "./bytes.js";
import {
  abiEncode,
  bindVaultCalldata,
  BRIDGE_ERRORS,
  BURN_REQUESTED_TOPIC,
  bundleCalldata,
  bundleProof,
  checkBundle,
  connectWithin,
  decodeBurnRequested,
  decodeHeaderImported,
  decodeMinted,
  decodeTransfer,
  decodeVaultBound,
  DryRunViolation,
  errorMap,
  errorString,
  formatWtpot,
  guardedFetch,
  guardedRequest,
  guardProvider,
  HEADER_IMPORTED_TOPIC,
  immutablesProblem,
  importAndMintCalldata,
  initializeCalldata,
  initializeWrites,
  installDryRunGuard,
  isWriteMethod,
  librariesIn,
  LOG_WINDOW,
  logWindows,
  MINTED_TOPIC,
  MINTER,
  minterConstructorArgs,
  mintCalldata,
  replayCall,
  revertName,
  signersHint,
  sourceHashes,
  TAMPERS,
  tamperedCall,
  tokenConstructorArgs,
  TRANSFER_TOPIC,
  VAULT_BOUND_TOPIC,
  type LockProof,
  type Tamper,
} from "./bridge.js";
import type { MintBundleFixture } from "./fixture.js";
import { blake2_256 } from "./hash.js";
import { RpcClient } from "./rpc.js";
import { decodeJustification } from "./scale.js";
import { readProof } from "./trie.js";
import { addressWord, burnId, commitmentSlot, createAddress, lockCommitment, selector, uintWord } from "./vault.js";

const SEPOLIA = 11_155_111n;
const V3 = 420_420_777n;
const DEPLOYER = hexToBytes("0xd9838a86cf83c28ee486544060d1ca4ca2971071");
const VAULT = hexToBytes("0xa02ee16eb03d2cf1aef199f7658fb8c8e3188ffd");
const VAULT_CODE_HASH = hexToBytes("0xa72553f50cdf645fb343b2cf089e431a1b26fb07e80f4e2236d55bf9811c663f");
const LIGHT_CLIENT = hexToBytes("0x447171c4885ad725ee4772e8e3c228adee50dcb0");
/** CREATE(deployer, 31) and CREATE(deployer, 32), as cast compute-address gives them. */
const MINTER_ADDRESS = "0x8287b3baf205ca8456f98346f13064aa7fcdcb9e";
const TOKEN_ADDRESS = "0x1fcbbd66922ac5aa20219a5c16c2591a76b4cb14";

const bundleFile = new URL("../../fixtures/v3-testnet-mint/mint-bundle.json", import.meta.url);
const realBundle = (): MintBundleFixture => JSON.parse(readFileSync(bundleFile, "utf8")) as MintBundleFixture;
const failed = (lines: [boolean, string][]) => lines.filter(([ok]) => !ok).map(([, what]) => what);
const word = (n: bigint) => bytesToHex(uintWord(n));

describe("the minter's calls", () => {
  const proof: LockProof = {
    blockHash: hexToBytes(`0x${"11".repeat(32)}`),
    accountProof: [hexToBytes("0xaa")],
    childRootProof: [],
    slotProof: [hexToBytes("0xbbcc"), hexToBytes("0xdd")],
    recipient: hexToBytes(`0x${"22".repeat(20)}`),
    amount: 5n,
    nonce: 7n,
  };
  // cast calldata "mint((bytes32,bytes[],bytes[],bytes[],address,uint256,uint256))" "(0x11..11,[0xaa],[],[0xbbcc,0xdd],0x22..22,5,7)", after the selector.
  const lockProofTail =
    "0000000000000000000000000000000000000000000000000000000000000020" +
    "1111111111111111111111111111111111111111111111111111111111111111" +
    "00000000000000000000000000000000000000000000000000000000000000e0" +
    "0000000000000000000000000000000000000000000000000000000000000160" +
    "0000000000000000000000000000000000000000000000000000000000000180" +
    "0000000000000000000000002222222222222222222222222222222222222222" +
    "0000000000000000000000000000000000000000000000000000000000000005" +
    "0000000000000000000000000000000000000000000000000000000000000007" +
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "0000000000000000000000000000000000000000000000000000000000000020" +
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "aa00000000000000000000000000000000000000000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000002" +
    "0000000000000000000000000000000000000000000000000000000000000040" +
    "0000000000000000000000000000000000000000000000000000000000000080" +
    "0000000000000000000000000000000000000000000000000000000000000002" +
    "bbcc000000000000000000000000000000000000000000000000000000000000" +
    "0000000000000000000000000000000000000000000000000000000000000001" +
    "dd00000000000000000000000000000000000000000000000000000000000000";

  it("has the selectors cast sig gives", () => {
    assert.equal(bytesToHex(selector(MINTER.importAndMint)), "0x9bf20ea3");
    assert.equal(bytesToHex(selector(MINTER.mint)), "0x97379043");
    assert.equal(bytesToHex(selector(MINTER.bindVault)), "0x06efeeab");
    assert.equal(bytesToHex(selector(MINTER.burn)), "0xfcd3533c");
    assert.equal(bytesToHex(selector(MINTER.used)), "0x020fe6e5");
  });

  it("encodes mint and importAndMint with the LockProof struct as cast does", () => {
    assert.equal(bytesToHex(mintCalldata(proof)), `0x97379043${lockProofTail}`);
    // cast calldata "importAndMint(bytes,bytes,bytes,(...))" 0x01 0x0203 0x "(...)": three bytes heads, the struct's
    // offset, the three bytes tails, then the struct as in mint.
    const expected =
      "0x9bf20ea3" +
      "0000000000000000000000000000000000000000000000000000000000000080" +
      "00000000000000000000000000000000000000000000000000000000000000c0" +
      "0000000000000000000000000000000000000000000000000000000000000100" +
      "0000000000000000000000000000000000000000000000000000000000000120" +
      "0000000000000000000000000000000000000000000000000000000000000001" +
      "0100000000000000000000000000000000000000000000000000000000000000" +
      "0000000000000000000000000000000000000000000000000000000000000002" +
      "0203000000000000000000000000000000000000000000000000000000000000" +
      "0000000000000000000000000000000000000000000000000000000000000000" +
      lockProofTail.slice(64);
    assert.equal(bytesToHex(importAndMintCalldata(hexToBytes("0x01"), hexToBytes("0x0203"), new Uint8Array(0), proof)), expected);
  });

  it("encodes bindVault and initialize as cast does", () => {
    assert.equal(
      bytesToHex(bindVaultCalldata(proof.blockHash, [hexToBytes("0xaa"), hexToBytes("0xbbcc")])),
      "0x06efeeab" +
        "1111111111111111111111111111111111111111111111111111111111111111" +
        "0000000000000000000000000000000000000000000000000000000000000040" +
        "0000000000000000000000000000000000000000000000000000000000000002" +
        "0000000000000000000000000000000000000000000000000000000000000040" +
        "0000000000000000000000000000000000000000000000000000000000000080" +
        "0000000000000000000000000000000000000000000000000000000000000001" +
        "aa00000000000000000000000000000000000000000000000000000000000000" +
        "0000000000000000000000000000000000000000000000000000000000000002" +
        "bbcc000000000000000000000000000000000000000000000000000000000000",
    );
    const keys = [hexToBytes("0xe64cb64dacf59392463823df2978ab3ee21f72362d57c7fe3b85d435ea72d090"), hexToBytes("0x71fe90e5ae0c71f83e66da6c13b95c8627e62b3a584bb24ad18dfb56973a91f0")];
    const genesis = hexToBytes("0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd");
    assert.equal(
      bytesToHex(initializeCalldata(genesis, 29n, keys, hexToBytes("0x0102030405"))),
      "0x7feeef49" +
        "d4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd" +
        "000000000000000000000000000000000000000000000000000000000000001d" +
        "0000000000000000000000000000000000000000000000000000000000000080" +
        "00000000000000000000000000000000000000000000000000000000000000e0" +
        "0000000000000000000000000000000000000000000000000000000000000002" +
        "e64cb64dacf59392463823df2978ab3ee21f72362d57c7fe3b85d435ea72d090" +
        "71fe90e5ae0c71f83e66da6c13b95c8627e62b3a584bb24ad18dfb56973a91f0" +
        "0000000000000000000000000000000000000000000000000000000000000005" +
        "0102030405000000000000000000000000000000000000000000000000000000",
    );
  });

  it("encodes a static tuple in place and a dynamic one behind an offset", () => {
    const a = hexToBytes(word(1n));
    const b = hexToBytes(word(2n));
    assert.equal(bytesToHex(abiEncode([{ tuple: [{ word: a }, { word: b }] }])), bytesToHex(concatBytes(a, b)));
    assert.equal(bytesToHex(abiEncode([{ tuple: [{ word: a }, { bytes: new Uint8Array(0) }] }])), `0x${word(32n).slice(2)}${word(1n).slice(2)}${word(64n).slice(2)}${word(0n).slice(2)}`);
    assert.throws(() => abiEncode([{ word: new Uint8Array(31) }]), /32 bytes/);
  });
});

describe("the deployment", () => {
  it("puts the minter where lock 0 names it and the token next to it", () => {
    assert.equal(bytesToHex(createAddress(DEPLOYER, 31n)), MINTER_ADDRESS);
    assert.equal(bytesToHex(createAddress(DEPLOYER, 32n)), TOKEN_ADDRESS);
  });

  it("encodes the constructor arguments as cast abi-encode does", () => {
    const args = minterConstructorArgs(LIGHT_CLIENT, VAULT, V3, VAULT_CODE_HASH, hexToBytes(TOKEN_ADDRESS));
    assert.equal(
      bytesToHex(args),
      "0x000000000000000000000000447171c4885ad725ee4772e8e3c228adee50dcb0" +
        "000000000000000000000000a02ee16eb03d2cf1aef199f7658fb8c8e3188ffd" +
        "00000000000000000000000000000000000000000000000000000000190f1ca9" +
        "a72553f50cdf645fb343b2cf089e431a1b26fb07e80f4e2236d55bf9811c663f" +
        "0000000000000000000000001fcbbd66922ac5aa20219a5c16c2591a76b4cb14",
    );
    assert.equal(bytesToHex(tokenConstructorArgs(hexToBytes(MINTER_ADDRESS))), `0x000000000000000000000000${MINTER_ADDRESS.slice(2)}`);
    assert.throws(() => minterConstructorArgs(LIGHT_CLIENT, VAULT, V3, new Uint8Array(31), hexToBytes(TOKEN_ADDRESS)), /32 bytes/);
  });

  it("computes the commitment of lock 0 and the burn ids the vault's committee expects", () => {
    // cast keccak $(cast abi-encode "f(bytes32,uint256,address,uint256,address,address,uint256,uint256)" LOCK_TAG 420420777 vault 11155111 minter recipient 100000000000000 0)
    const commitment = lockCommitment({ v3ChainId: V3, vault: VAULT, dstChainId: SEPOLIA, dstMinter: hexToBytes(MINTER_ADDRESS), recipient: DEPLOYER, amountNative: 10n ** 14n, nonce: 0n });
    assert.equal(bytesToHex(commitment), "0x9eba08c90e4527bdb00da438eb8f15ad244cbb202e8886d929b0e12941e23435");
    assert.equal(bytesToHex(commitmentSlot(0n)), "0xad3228b676f7d3cd4284a5443f17f1962b36e491b30a40b2405849e597ba5fb5");
    // cast keccak $(cast abi-encode "f(bytes32,uint256,address,uint256)" BURN_TAG 11155111 minter n)
    assert.equal(bytesToHex(burnId(SEPOLIA, hexToBytes(MINTER_ADDRESS), 0n)), "0x0b8e808d1084dd2878e3d20b124a677cdc26785882cf3aac9f7ccbf84245471f");
    assert.equal(bytesToHex(burnId(SEPOLIA, hexToBytes(MINTER_ADDRESS), 7n)), "0xa268437ac2481a0be5954dea9e9c4d36aae3e7832abe70dcba6db1a05febb0b4");
  });

  it("formats wtPOT with 14 decimals", () => {
    assert.equal(formatWtpot(10n ** 14n), "1 wtPOT");
    assert.equal(formatWtpot(1n), "0.00000000000001 wtPOT");
  });
});

describe("deployed code against the build", () => {
  // A stand-in build: 70 bytes of runtime code with two immutables, one referenced twice.
  const runtime = hexToBytes(`0x60${"00".repeat(32)}60${"00".repeat(32)}5b5b5b5b`);
  const references = { "7": [{ start: 1, length: 32 }], "9": [{ start: 34, length: 32 }] };
  const fill = (a: Uint8Array, b: Uint8Array) => {
    const code = runtime.slice();
    code.set(a, 1);
    code.set(b, 34);
    return code;
  };
  const x = hexToBytes(word(420_420_777n));
  const y = addressWord(VAULT);

  it("takes the build's code with the constructor arguments as its immutables, in either order", () => {
    assert.equal(immutablesProblem(fill(x, y), runtime, references, [x, y]), null);
    assert.equal(immutablesProblem(fill(x, y), runtime, references, [y, x]), null);
    assert.equal(immutablesProblem(runtime, runtime, {}, []), null);
  });

  it("refuses other code, other immutables and a reference that disagrees", () => {
    assert.match(immutablesProblem(fill(x, x), runtime, references, [x, y]) ?? "", /not the constructor's/);
    const changed = fill(x, y);
    changed[67] ^= 1;
    assert.match(immutablesProblem(changed, runtime, references, [x, y]) ?? "", /outside the immutables/);
    assert.match(immutablesProblem(fill(x, y).slice(0, 69), runtime, references, [x, y]) ?? "", /bytes of code/);
    const twice = { "7": [{ start: 1, length: 32 }, { start: 34, length: 32 }] };
    assert.match(immutablesProblem(fill(x, y), runtime, twice, [x]) ?? "", /different words/);
  });

  it("hashes a source as a build records it, with its CRLF line ends or with LF", () => {
    const crlf = new TextEncoder().encode("pragma solidity 0.8.27;\r\ncontract A {}\r\n");
    const lf = new TextEncoder().encode("pragma solidity 0.8.27;\ncontract A {}\n");
    assert.deepEqual(sourceHashes(crlf), [bytesToHex(keccak_256(crlf)), bytesToHex(keccak_256(lf))]);
    assert.deepEqual(sourceHashes(lf), [bytesToHex(keccak_256(lf)), bytesToHex(keccak_256(lf))]);
    // A CR without LF is kept.
    const cr = hexToBytes("0x610d62");
    assert.equal(sourceHashes(cr)[1], bytesToHex(keccak_256(cr)));
  });

  it("names the libraries whose address the code carries", () => {
    const libraries = { "src/trie/StorageProofs.sol:StorageProofs": "0x5DA053Bc5659ba9f725E4b1B5083545B933EF2a3", "src/grandpa/GrandpaCodec.sol:GrandpaCodec": "0x482a1c993e169E962539c38eFdB26E9e0621dFD2" };
    const code = hexToBytes("0x60735da053bc5659ba9f725e4b1b5083545b933ef2a3f4");
    assert.deepEqual(Object.keys(librariesIn(code, libraries)), ["src/trie/StorageProofs.sol:StorageProofs"]);
  });

  it("lists the slots a fresh light client's initialize writes", () => {
    const keys = [hexToBytes(`0x${"01".repeat(32)}`), hexToBytes(`0x${"02".repeat(32)}`)];
    const slots = initializeWrites(hexToBytes(`0x${"33".repeat(32)}`), hexToBytes(`0x${"44".repeat(32)}`), 29n, keys);
    assert.equal(slots.length, 9 + 1 + 2 + 3 * keys.length);
    assert.equal(new Set(slots).size, slots.length);
    assert.deepEqual(slots.slice(0, 4), [0n, 1n, 2n, 3n]);
    // The first set of the array at slot 3: keccak256(uint256(3)) (cast keccak 0x...03).
    assert.equal(slots[4], 0xc2575a0e9e593c00f959f8c92f12db2869c3395a3b0502d05e2516446f71f85bn);
  });
});

describe("events and errors", () => {
  const address = (hex: string) => `0x${"00".repeat(12)}${hex.slice(2)}`;
  const hash = `0x${"ab".repeat(32)}`;

  it("decodes the minter's, the token's and the light client's events, and refuses other logs", () => {
    const bound = decodeVaultBound({ address: MINTER_ADDRESS, topics: [VAULT_BOUND_TOPIC, address(bytesToHex(VAULT)), hash], data: word(5n) });
    assert.equal(bytesToHex(bound.vault), bytesToHex(VAULT));
    assert.equal(bytesToHex(bound.trieId), word(5n));
    assert.equal(bytesToHex(bound.blockHash), hash);
    const minted = decodeMinted({ address: MINTER_ADDRESS, topics: [MINTED_TOPIC, word(3n), address(bytesToHex(DEPLOYER)), hash], data: word(10n ** 14n) });
    assert.deepEqual([minted.nonce, bytesToHex(minted.recipient), minted.amount], [3n, bytesToHex(DEPLOYER), 10n ** 14n]);
    const burn = decodeBurnRequested({ address: MINTER_ADDRESS, topics: [BURN_REQUESTED_TOPIC, word(7n), address(bytesToHex(DEPLOYER)), address(bytesToHex(VAULT))], data: `${word(9n)}${hash.slice(2)}` });
    assert.deepEqual([burn.burnNonce, bytesToHex(burn.from), bytesToHex(burn.v3Recipient), burn.amount, bytesToHex(burn.burnId)], [7n, bytesToHex(DEPLOYER), bytesToHex(VAULT), 9n, hash]);
    const transfer = decodeTransfer({ address: TOKEN_ADDRESS, topics: [TRANSFER_TOPIC, word(0n), address(bytesToHex(DEPLOYER))], data: word(1n) });
    assert.equal(transfer.value, 1n);
    const imported = decodeHeaderImported({ address: bytesToHex(LIGHT_CLIENT), topics: [HEADER_IMPORTED_TOPIC, hash, word(104_587n)], data: `${hash}${word(29n).slice(2)}${word(2n).slice(2)}` });
    assert.deepEqual([imported.number, imported.setId, imported.signatures], [104_587, 29n, 2]);
    assert.throws(() => decodeMinted({ address: MINTER_ADDRESS, topics: [VAULT_BOUND_TOPIC, word(3n), address(bytesToHex(DEPLOYER)), hash], data: word(1n) }), /not a Minted log/);
    assert.throws(() => decodeTransfer({ address: TOKEN_ADDRESS, topics: [TRANSFER_TOPIC, word(0n), `0x${"ff".repeat(32)}`], data: word(1n) }), /not an address/);
  });

  it("names a revert by the known errors, with its arguments", () => {
    const errors = errorMap(BRIDGE_ERRORS);
    assert.equal(revertName(hexToBytes(`0x91cab504${word(0n).slice(2)}`), errors), "NonceAlreadyUsed(0)");
    assert.equal(revertName(hexToBytes(`0xa7fd3a80${hash.slice(2)}`), errors), "UnknownBlock(0xabababab…abababab)");
    assert.equal(revertName(hexToBytes(`0xbac98aeb${word(0n).slice(2)}${word(1n).slice(2)}`), errors), "InvalidSignature(0, 1)");
    // KeyNotPresent(bytes32 root, bytes key): cast abi-encode "f(bytes32,bytes)" 0x11..11 0xabcdef
    const keyNotPresent = `0x5bca5061${"11".repeat(32)}${word(64n).slice(2)}${word(3n).slice(2)}abcdef${"00".repeat(29)}`;
    assert.equal(revertName(hexToBytes(keyNotPresent), errors), "KeyNotPresent(0x11111111…11111111, 0xabcdef (3 B))");
    const reason = abiEncode([{ bytes: new TextEncoder().encode("Invalid child trie proof") }]);
    assert.equal(revertName(concatBytes(selector("Error(string)"), reason), errors), 'Error("Invalid child trie proof")');
    assert.equal(revertName(hexToBytes("0x12345678"), errors), null);
    assert.equal(revertName(hexToBytes("0x91ca"), errors), null);
  });
});

describe("the mint bundle of lock 0 (fixtures/v3-testnet-mint)", () => {
  it("checks out offline", () => {
    const lines = checkBundle(realBundle());
    assert.deepEqual(failed(lines), []);
    assert.ok(lines.length >= 11);
  });

  it("carries the hint relay.ts builds, and calldata whose LockProof is the bundle's", () => {
    const b = realBundle();
    const j = decodeJustification(hexToBytes(b.justification.scale));
    const keys = b.signingSet.authorities.map((a) => hexToBytes(a.id));
    const hint = signersHint(j, keys, BigInt(b.signingSet.setId));
    assert.equal(bytesToHex(hint.hint), b.signers.hint);
    assert.equal(hint.counted.length, 2);
    assert.ok(hint.counted[0].authorityIndex < hint.counted[1].authorityIndex);
    assert.throws(() => signersHint(j, keys, BigInt(b.signingSet.setId) + 1n), /does not verify/);
    const p = bundleProof(b);
    assert.equal(p.nonce, 0n);
    assert.equal(p.amount, 10n ** 14n);
    assert.equal(bytesToHex(p.recipient), bytesToHex(DEPLOYER));
    const data = bundleCalldata(b);
    assert.equal(bytesToHex(data.slice(0, 4)), "0x9bf20ea3");
    assert.equal(bytesToHex(data), bytesToHex(importAndMintCalldata(hexToBytes(b.header.scale), hexToBytes(b.finalityProof.scale), hexToBytes(b.signers.hint), p)));
  });

  it("is the vault of the record, with lock 0's commitment in its slot", () => {
    const b = realBundle();
    assert.equal(b.vault.address, bytesToHex(VAULT));
    assert.equal(b.vault.codeHash, bytesToHex(VAULT_CODE_HASH));
    assert.equal(b.vault.trieId, "0xbe307c2d11dbc9391cda93d17e9772542d1300c9af14e7431918fb49e2f47c3a");
    assert.equal(b.lock.dstMinter, MINTER_ADDRESS);
    assert.equal(b.slot.value.hex, "0x9eba08c90e4527bdb00da438eb8f15ad244cbb202e8886d929b0e12941e23435");
  });

  it("fails the checks when any part is changed", () => {
    const tamper = (change: (b: MintBundleFixture) => void): string[] => {
      const b = realBundle();
      change(b);
      return failed(checkBundle(b));
    };
    const flipHex = (hex: string, at: number) => bytesToHex(flipByte(hexToBytes(hex), at));
    assert.ok(tamper((b) => (b.header.scale = flipHex(b.header.scale, 40))).length > 0, "a header byte");
    assert.ok(tamper((b) => (b.signers.hint = "0x00010100")).some((w) => /signers hint/.test(w)), "a hint in the wrong order");
    assert.ok(tamper((b) => (b.finalityProof.scale = flipHex(b.finalityProof.scale, 200))).some((w) => /finality proof/.test(w)), "a signature byte");
    assert.ok(tamper((b) => (b.signingSet.setId += 1)).length > 0, "another set id");
    assert.ok(tamper((b) => (b.account.proof.nodes[1] = flipHex(b.account.proof.nodes[1], 5))).some((w) => /AccountInfoOf/.test(w)), "an account proof item");
    assert.ok(tamper((b) => (b.childRoot.proof.nodes[0] = flipHex(b.childRoot.proof.nodes[0], 3))).some((w) => /child root/.test(w)), "a child-root proof item");
    assert.ok(tamper((b) => (b.slot.proof.nodes[1] = flipHex(b.slot.proof.nodes[1], 9))).some((w) => /commitments\[nonce\]/.test(w)), "a slot proof item");
    assert.ok(tamper((b) => (b.lock.amountNative = (10n ** 14n + 1n).toString())).some((w) => /commitment/.test(w)), "another amount");
    assert.ok(tamper((b) => (b.lock.nonce = 1)).some((w) => /commitments\[nonce\]/.test(w)), "another nonce");
    assert.ok(tamper((b) => (b.vault.codeHash = flipHex(b.vault.codeHash, 0))).some((w) => /code hash/.test(w)), "another code hash");
    assert.ok(tamper((b) => (b.parentHeader.scale = flipHex(b.parentHeader.scale, 10))).some((w) => /parent/.test(w)), "a parent header byte");
  });
});

describe("the demo's reverts, on the bundle of lock 0", () => {
  const errors = errorMap(BRIDGE_ERRORS);
  const minter = hexToBytes(MINTER_ADDRESS);
  const parts = () => {
    const b = realBundle();
    return { b, header: hexToBytes(b.header.scale), finalityProof: hexToBytes(b.finalityProof.scale), hint: hexToBytes(b.signers.hint), p: bundleProof(b), original: bundleCalldata(b) };
  };
  const differing = (a: Uint8Array, b: Uint8Array) => a.reduce((n, x, i) => n + (x === b[i] ? 0 : 1), 0);

  it("encodes Error(string) as revert(\"...\") returns it", () => {
    // cast calldata "Error(string)" "Incomplete Proof!"
    const expected =
      "0x08c379a0" +
      "0000000000000000000000000000000000000000000000000000000000000020" +
      "0000000000000000000000000000000000000000000000000000000000000011" +
      "496e636f6d706c6574652050726f6f6621000000000000000000000000000000";
    assert.equal(bytesToHex(errorString("Incomplete Proof!")), expected);
    assert.equal(revertName(errorString("Incomplete Proof!"), errors), 'Error("Incomplete Proof!")');
  });

  it("flips byte 0 of R in the first precommit the hint counts, and expects that signer's InvalidSignature", () => {
    const { b, header, finalityProof, hint, p, original } = parts();
    const t = tamperedCall(b, "signature", minter, SEPOLIA);
    // FinalityProof: the block hash (32 bytes), the justification's length (2 bytes for 310), then
    // the justification, whose precommit i starts at 45 + 132 i; R is 36 bytes in (V3Testnet.t.sol).
    assert.equal(b.finalityProof.justificationBytes, 310);
    const [position, index] = hint;
    const at = 32 + 2 + 45 + 132 * position + 36;
    assert.equal(bytesToHex(t.data), bytesToHex(importAndMintCalldata(header, flipByte(finalityProof, at), hint, p)));
    assert.equal(differing(t.data, original), 1);
    assert.equal(bytesToHex(t.revert), `0xbac98aeb${word(0n).slice(2)}${word(BigInt(index)).slice(2)}`);
    assert.equal(revertName(t.revert, errors), `InvalidSignature(0, ${index})`);
  });

  it("flips byte 0 of B's state root, and expects FinalityProofBlockMismatch with the changed header's hash", () => {
    const { b, header, finalityProof, hint, p, original } = parts();
    const t = tamperedCall(b, "header", minter, SEPOLIA);
    // The parent hash (32 bytes), then the number as a 4-byte compact integer, then the state root.
    assert.equal(bytesToHex(header.slice(36, 68)), b.header.stateRoot);
    const changed = flipByte(header, 36);
    assert.equal(bytesToHex(t.data), bytesToHex(importAndMintCalldata(changed, finalityProof, hint, p)));
    assert.equal(differing(t.data, original), 1);
    assert.equal(bytesToHex(t.revert), `0x928e4216${b.header.hash.slice(2)}${bytesToHex(blake2_256(changed)).slice(2)}`);
  });

  it("flips a byte of the slot proof, which then proves nothing, and expects the walk's Incomplete Proof!", () => {
    const { b, header, finalityProof, hint, p, original } = parts();
    const t = tamperedCall(b, "proof", minter, SEPOLIA);
    const item = p.slotProof[0];
    const slotProof = [flipByte(item, Math.floor(item.length / 2)), ...p.slotProof.slice(1)];
    assert.equal(bytesToHex(t.data), bytesToHex(importAndMintCalldata(header, finalityProof, hint, { ...p, slotProof })));
    assert.equal(differing(t.data, original), 1);
    let value: Uint8Array | null = null;
    try {
      value = readProof(hexToBytes(b.childRoot.root), slotProof, hexToBytes(b.slot.key.hex)).value;
    } catch {
      // the walk cannot find the changed item
    }
    assert.equal(value, null);
    assert.deepEqual(t.revert, errorString("Incomplete Proof!"));
  });

  it("changes the amount or the recipient, and expects CommitmentMismatch(the commitment they give, the proven word)", () => {
    const { b, header, finalityProof, hint, p } = parts();
    const commitment = (q: LockProof) =>
      lockCommitment({ v3ChainId: V3, vault: VAULT, dstChainId: SEPOLIA, dstMinter: minter, recipient: q.recipient, amountNative: q.amount, nonce: q.nonce });
    assert.equal(bytesToHex(commitment(p)), b.slot.value.hex, "unchanged, the lock gives the proven word");
    const changes: [Tamper, LockProof][] = [
      ["amount", { ...p, amount: p.amount * 1000n }],
      ["recipient", { ...p, recipient: flipByte(p.recipient, 19) }],
    ];
    for (const [part, q] of changes) {
      const t = tamperedCall(b, part, minter, SEPOLIA);
      assert.equal(bytesToHex(t.data), bytesToHex(importAndMintCalldata(header, finalityProof, hint, q)), part);
      assert.equal(bytesToHex(t.revert), `0xc9e0e757${bytesToHex(commitment(q)).slice(2)}${b.slot.value.hex.slice(2)}`, part);
    }
    // The commitment names the minter: another minter address expects another one.
    const other = tamperedCall(b, "amount", flipByte(minter, 0), SEPOLIA);
    assert.notEqual(bytesToHex(other.revert), bytesToHex(tamperedCall(b, "amount", minter, SEPOLIA).revert));
  });

  it("replays the mint as it is, and expects NonceAlreadyUsed of the lock", () => {
    const { b, original } = parts();
    const r = replayCall(b);
    assert.equal(bytesToHex(r.data), bytesToHex(original));
    assert.equal(revertName(r.revert, errors), "NonceAlreadyUsed(0)");
  });

  it("changes the calldata for every part, each with a revert the tool can name", () => {
    const { b, original } = parts();
    const seen = new Set<string>();
    for (const part of TAMPERS) {
      const t = tamperedCall(b, part, minter, SEPOLIA);
      assert.notEqual(bytesToHex(t.data), bytesToHex(original), part);
      assert.notEqual(revertName(t.revert, errors), null, part);
      seen.add(bytesToHex(t.data));
    }
    assert.equal(seen.size, TAMPERS.length);
  });
});

describe("the dry-run guard", () => {
  const rpcBody = (...methods: string[]) => JSON.stringify(methods.length === 1 ? { jsonrpc: "2.0", id: 1, method: methods[0], params: [] } : methods.map((method, id) => ({ jsonrpc: "2.0", id, method, params: [] })));

  it("knows the write methods", () => {
    for (const m of ["eth_sendRawTransaction", "eth_sendTransaction", "eth_sign", "eth_signTransaction", "eth_signTypedData_v4", "personal_sign", "author_submitExtrinsic", "author_submitAndWatchExtrinsic", "author_insertKey", "author_rotateKeys"]) {
      assert.ok(isWriteMethod(m), m);
    }
    for (const m of ["eth_call", "eth_simulateV1", "eth_estimateGas", "eth_getStorageAt", "state_getReadProof", "grandpa_proveFinality", "chain_getHeader"]) assert.ok(!isWriteMethod(m), m);
  });

  it("refuses a write method before the request leaves, and passes reads", async () => {
    const sent: string[] = [];
    const inner = (async (_input: string | URL | Request, init?: RequestInit) => {
      sent.push(String(init?.body));
      return new Response("{}");
    }) as typeof fetch;
    const guarded = guardedFetch(inner);
    const url = "https://ethereum-sepolia-rpc.publicnode.com";
    await assert.rejects(guarded(url, { method: "POST", body: rpcBody("eth_sendRawTransaction") }), DryRunViolation);
    await assert.rejects(guarded(url, { method: "POST", body: rpcBody("eth_call", "eth_sendTransaction") }), DryRunViolation);
    await assert.rejects(guarded(url, { method: "POST", body: new Uint8Array([1]) }), DryRunViolation);
    assert.equal(sent.length, 0);
    await guarded(url, { method: "POST", body: rpcBody("eth_simulateV1") });
    await guarded(url, { method: "POST", body: rpcBody("eth_call", "eth_getStorageAt") });
    assert.equal(sent.length, 2);
  });

  it("refuses author_submit* on the node's socket", async () => {
    const asked: string[] = [];
    const inner = (async function (method: string) {
      asked.push(method);
      return null;
    }) as RpcClient["request"];
    const request = guardedRequest(inner);
    const client = { url: "wss://test-node-v3.portaldot.dev" } as RpcClient;
    await assert.rejects(request.call(client, "author_submitExtrinsic", ["0x00"]), DryRunViolation);
    await assert.rejects(request.call(client, "author_submitAndWatchExtrinsic", ["0x00"]), DryRunViolation);
    assert.deepEqual(asked, []);
    await request.call(client, "chain_getFinalizedHead");
    assert.deepEqual(asked, ["chain_getFinalizedHead"]);
  });

  it("is installed on global fetch and on the WebSocket client", async () => {
    const fetchBefore = globalThis.fetch;
    const requestBefore = RpcClient.prototype.request;
    try {
      installDryRunGuard();
      await assert.rejects(fetch("http://127.0.0.1:9/", { method: "POST", body: rpcBody("eth_sendRawTransaction") }), DryRunViolation);
      await assert.rejects(RpcClient.prototype.request.call({ url: "wss://test-node-v3.portaldot.dev" } as RpcClient, "author_submitExtrinsic", []), DryRunViolation);
    } finally {
      globalThis.fetch = fetchBefore;
      RpcClient.prototype.request = requestBefore;
    }
  });

  it("refuses author_submit* on a polkadot-js provider before its socket, through send and subscribe", async () => {
    const asked: string[] = [];
    const provider = {
      send: async (method: string, ..._rest: unknown[]) => {
        asked.push(method);
        return null;
      },
      subscribe: async (_type: string, method: string, ..._rest: unknown[]) => {
        asked.push(method);
        return 1;
      },
    };
    guardProvider(provider, "test-node-v3.portaldot.dev");
    await assert.rejects(provider.send("author_submitExtrinsic", ["0x00"]), DryRunViolation);
    await assert.rejects(provider.subscribe("author_extrinsicUpdate", "author_submitAndWatchExtrinsic", ["0x00"]), DryRunViolation);
    await assert.rejects(provider.send("eth_sendRawTransaction", ["0x00"]), DryRunViolation);
    assert.deepEqual(asked, []);
    await provider.send("state_call", ["ReviveApi_call", "0x"]);
    await provider.subscribe("chain_newHead", "chain_subscribeNewHeads", []);
    assert.deepEqual(asked, ["state_call", "chain_subscribeNewHeads"]);
  });

  it("guards a real WsProvider: an extrinsic is refused by the guard, a read reaches the provider", async () => {
    const { WsProvider } = await import("@polkadot/api");
    // Never connected: a request that passes the guard fails in the provider, for want of a socket.
    const provider = guardProvider(new WsProvider("ws://127.0.0.1:9", false), "127.0.0.1:9");
    await assert.rejects(provider.send("author_submitExtrinsic", ["0x00"]), DryRunViolation);
    await assert.rejects(provider.subscribe("author_extrinsicUpdate", "author_submitAndWatchExtrinsic", ["0x00"], () => undefined), DryRunViolation);
    await assert.rejects(provider.send("chain_getHeader", []), (error: unknown) => !(error instanceof DryRunViolation));
  });
});

describe("a polkadot-js connection within its timeout", () => {
  /** A provider or an API that counts its disconnect() calls. */
  const stand = () => ({
    disconnected: 0,
    async disconnect() {
      this.disconnected += 1;
    },
  });
  /** A create() that settles after `ms` with `settle`: an API it resolves with, or an error it rejects with. */
  const after = <T>(ms: number, settle: T | Error) =>
    new Promise<T>((resolve, reject) => setTimeout(() => (settle instanceof Error ? reject(settle) : resolve(settle)), ms));
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("returns the API made in time, and leaves its provider to the caller", async () => {
    const provider = stand();
    const api = stand();
    assert.equal(await connectWithin(() => after(20, api), provider, 1_000), api);
    await pause(50);
    assert.equal(provider.disconnected, 0);
    assert.equal(api.disconnected, 0);
  });

  it("disconnects the provider when create() fails, throws, or makes no API in time", async () => {
    const failed = stand();
    await assert.rejects(connectWithin(() => after<never>(20, new Error("FATAL: Unable to initialize the API")), failed, 1_000), /FATAL: Unable to initialize the API/);
    assert.equal(failed.disconnected, 1);
    const thrown = stand();
    await assert.rejects(
      connectWithin(() => {
        throw new Error("Expected Provider to API create");
      }, thrown, 1_000),
      /Expected Provider to API create/,
    );
    assert.equal(thrown.disconnected, 1);
    const silent = stand();
    await assert.rejects(connectWithin(() => new Promise<never>(() => undefined), silent, 50), /^Error: no connection after 0\.05 s$/);
    assert.equal(silent.disconnected, 1);
  });

  it("disconnects an API made after the timeout as it comes: no caller holds it", async () => {
    const provider = stand();
    const api = stand();
    await assert.rejects(connectWithin(() => after(150, api), provider, 50), /no connection after 0\.05 s/);
    assert.equal(provider.disconnected, 1);
    assert.equal(api.disconnected, 0, "not made yet");
    await pause(250);
    assert.equal(api.disconnected, 1);
  });

  it("catches a failure after the timeout: no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const listen = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listen);
    try {
      const provider = stand();
      await assert.rejects(connectWithin(() => after<never>(150, new Error("FATAL: Unable to initialize the API (late)")), provider, 50), /no connection after 0\.05 s/);
      assert.equal(provider.disconnected, 1);
      await pause(250);
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", listen);
    }
  });
});

describe("log windows", () => {
  it("splits a block range into windows of at most 10,000 blocks, both ends included", () => {
    assert.deepEqual(logWindows(11_950_851, 11_954_835), [[11_950_851, 11_954_835]]);
    assert.deepEqual(logWindows(100_955, 116_345), [
      [100_955, 110_954],
      [110_955, 116_345],
    ]);
    assert.deepEqual(logWindows(0, 19_999), [
      [0, 9_999],
      [10_000, 19_999],
    ]);
    assert.deepEqual(logWindows(5, 5), [[5, 5]]);
    assert.deepEqual(logWindows(6, 5), []);
    assert.deepEqual(logWindows(1, 5, 2), [
      [1, 2],
      [3, 4],
      [5, 5],
    ]);
    for (const [a, z] of logWindows(1, 123_456)) assert.ok(z - a + 1 <= LOG_WINDOW);
  });

  it("refuses what is not a block range", () => {
    assert.throws(() => logWindows(-1, 5), RangeError);
    assert.throws(() => logWindows(1, 5, 0), RangeError);
    assert.throws(() => logWindows(0.5, 5), RangeError);
  });
});
