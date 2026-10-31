// Unit tests of state.ts, offline, against the proof kit's fixture (fixtures/v3-testnet-kit, V3
// #264,729): the keys of every read rebuilt from its arguments, every value decoded, every walk with
// the contracts' outcome (KeyNotPresent for an absent key or an address with no contract,
// EmptyValue for a branch without a value or a key that holds an empty value, the child reads of
// the vault, lock 1's LockProof), the tampers mirrored (a flip in every item, other keys, another
// root, values of another length or variant, an externally owned account's entry), B's header and
// finality against the light client's answer, the whole offline check, and the calldata of the
// Reader and the example gate against what cast computes.
//
//   npm test

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { abiEncode, mintCalldata, signersHint } from "./bridge.js";
import { bytesToHex, concatBytes, flipByte, hexToBytes, type Hex } from "./bytes.js";
import { clientVerifies, verifyJustification } from "./grandpa.js";
import { blake2_256 } from "./hash.js";
import { decodeAuthorityList, decodeFinalityProof, decodeHeader, decodeJustification } from "./scale.js";
import {
  accountInfoAt,
  assetAccountAt,
  assetsAccountKey,
  assetsAccountPrefix,
  checkStateReads,
  childSlotAt,
  claimCalldata,
  CLAIMED_TOPIC,
  contractAt,
  contractSlotAt,
  decodeAssetAccount,
  decodeContractInfo,
  decodedJson,
  decodeNftItem,
  decodeReaderResult,
  decodeSystemAccount,
  ethAccountId,
  GATE,
  gateConstructorArgs,
  INCOMPLETE_PROOF,
  keyOfRead,
  KIT_ERRORS,
  lockProofOf,
  mappingSlot,
  nftOwnerAt,
  nftsItemKey,
  outcomeOf,
  readAs,
  READER,
  readerCalldata,
  readMain,
  reviveAccountInfoKey,
  reviveSlotKey,
  slotWord,
  StateProofError,
  systemAccountKey,
  type StateReadsFixture,
} from "./state.js";
import { selector, uintWord } from "./vault.js";

const f = JSON.parse(readFileSync(new URL("../../fixtures/v3-testnet-kit/state-reads.json", import.meta.url), "utf8")) as StateReadsFixture;
const root = hexToBytes(f.header.stateRoot);
const B = hexToBytes(f.header.hash);
const nodes = (hex: Hex[]) => hex.map((n) => hexToBytes(n));
const read = (id: number) => {
  const r = f.reads.find((x) => x.id === id);
  if (!r) throw new Error(`no read ${id}`);
  return r;
};
const proof = (id: number) => nodes(read(id).proof.nodes);
const evm = (address: string) => ethAccountId(hexToBytes(address));
const reasonOf = (run: () => unknown) => outcomeOf(run);
const childRootProof = nodes(f.contract.childRoot.proof.nodes);
const trieId = hexToBytes(f.contract.trieId);

describe("the kit's keys", () => {
  it("rebuilds every read's key from its arguments", () => {
    for (const r of f.reads) assert.equal(bytesToHex(keyOfRead(r.args)), r.key.hex, `read ${r.id}`);
  });

  it("builds keys of 80, 100, 72 and 52 bytes", () => {
    assert.equal(systemAccountKey(evm("0xD9838A86cF83C28Ee486544060D1cA4Ca2971071")).length, 80);
    assert.equal(assetsAccountKey(7777, evm("0x3e79403610c21de20144960a0694b578ebc0dcdf")).length, 100);
    assert.equal(bytesToHex(assetsAccountKey(7777, evm("0x3e79403610c21de20144960a0694b578ebc0dcdf"))), read(3).key.hex);
    assert.equal(assetsAccountPrefix(7777).length, 52);
    assert.equal(nftsItemKey(10, 3163806249).length, 72);
    assert.equal(bytesToHex(nftsItemKey(10, 3163806249)), read(11).key.hex);
    assert.equal(reviveAccountInfoKey(hexToBytes(f.contract.address)).length, 52);
    assert.throws(() => assetsAccountKey(7777, new Uint8Array(20)), /32 bytes/);
  });

  it("finds each slot of the vault at keccak256(abi.encode(key, slot)) and its child-trie key at blake2_256(slot)", () => {
    for (let n = 0; n < 9; n++) assert.equal(bytesToHex(mappingSlot(BigInt(n), 0n)), f.contract.slots[n].index, `commitments[${n}]`);
    for (const s of f.contract.slots) assert.equal(bytesToHex(reviveSlotKey(hexToBytes(s.index))), s.key.hex, s.name);
    assert.equal(bytesToHex(mappingSlot(uintWord(1n), 0n)), f.contract.slots[1].index, "a 32-byte key is used as it is");
  });

  it("maps an EVM address to its V3 account: the address ++ 0xEE x 12", () => {
    assert.equal(bytesToHex(evm("0xD9838A86cF83C28Ee486544060D1cA4Ca2971071")), "0xd9838a86cf83c28ee486544060d1ca4ca2971071eeeeeeeeeeeeeeeeeeeeeeee");
  });
});

describe("the kit's decoders (portaldot-v3 3002)", () => {
  it("decodes every stored value to the fields the fixture records", () => {
    for (const r of f.reads.filter((x) => x.value)) assert.deepEqual(decodedJson(r.args, hexToBytes(r.value!.scale)), r.value!.decoded, `read ${r.id}`);
  });

  it("decodes the deployer's AccountInfo: nonce 6, free 15,947,352,201,127,852, flags 2^127", () => {
    const a = decodeSystemAccount(hexToBytes(read(1).value!.scale));
    assert.deepEqual(a, { nonce: 6, consumers: 0, providers: 1, sufficients: 0, free: 15_947_352_201_127_852n, reserved: 0n, frozen: 0n, flags: 1n << 127n });
  });

  it("decodes the 66-byte DepositFrom value and the Frozen balance", () => {
    const from = decodeAssetAccount(hexToBytes(read(7).value!.scale));
    assert.equal(from.balance, 136_781_096n);
    assert.equal(from.reason, "DepositFrom");
    assert.equal(from.deposit, 100_000_000_000_000n);
    assert.equal(bytesToHex(from.depositor!), "0x7a04cf1567ec6bc009418a7f88825831c5e1722d8f579aab30fa4509e25be863");
    assert.equal(read(7).value!.hashed, true, "trie V1 keeps a value over 32 bytes behind its hash");
    assert.equal(decodeAssetAccount(hexToBytes(read(8).value!.scale)).status, "Frozen");
  });

  it("parses an NFT item whole: the owner, the approvals and the deposit", () => {
    const item = decodeNftItem(hexToBytes(read(11).value!.scale));
    assert.equal(bytesToHex(item.owner), "0x104eb403971709e4a13c4c9d9200caed2bd78161eeeeeeeeeeeeeeeeeeeeeeee");
    assert.deepEqual(item.approvals, []);
    assert.equal(item.deposit.amount, 10_000_000_000_000n);
    const value = hexToBytes(read(11).value!.scale);
    const withApproval = concatBytes(value.slice(0, 32), Uint8Array.of(4), new Uint8Array(32).fill(7), Uint8Array.of(1, 9, 0, 0, 0), value.slice(33));
    assert.deepEqual(decodeNftItem(withApproval).approvals, [{ account: new Uint8Array(32).fill(7), deadline: 9 }]);
  });

  it("parses an NFT item with two approvals, and with 64 behind a two-byte compact count", () => {
    const value = hexToBytes(read(11).value!.scale);
    const owner = value.slice(0, 32);
    const deposit = value.slice(33);
    const two = concatBytes(owner, Uint8Array.of(8), new Uint8Array(32).fill(7), Uint8Array.of(0), new Uint8Array(32).fill(8), Uint8Array.of(1, 9, 0, 0, 0), deposit);
    assert.deepEqual(decodeNftItem(two).approvals.map((a) => a.deadline), [null, 9]);
    const approvals: Uint8Array[] = [];
    for (let i = 0; i < 64; i++) approvals.push(new Uint8Array(32).fill(i + 1), i % 2 === 0 ? Uint8Array.of(0) : Uint8Array.of(1, 1, 0, 0, 0));
    // Compact 64: (64 << 2) | 0b01, little-endian.
    const many = decodeNftItem(concatBytes(owner, Uint8Array.of(0x01, 0x01), ...approvals, deposit));
    assert.equal(many.approvals.length, 64);
    assert.deepEqual(many.owner, owner);
    assert.equal(many.deposit.amount, 10_000_000_000_000n);
    const over = concatBytes(owner, Uint8Array.of(0x05, 0x01), ...approvals, deposit);
    assert.throws(() => decodeNftItem(over), (error: unknown) => error instanceof StateProofError && error.message === `NftItemMalformed(${over.length})`);
  });

  it("refuses values of another length or variant with the contracts' errors", () => {
    const info = hexToBytes(read(1).value!.scale);
    const asset = hexToBytes(read(3).value!.scale);
    const item = hexToBytes(read(11).value!.scale);
    const contract = hexToBytes(read(14).value!.scale);
    const cases: [() => unknown, string][] = [
      [() => decodeSystemAccount(info.slice(0, 79)), "AccountInfoLength(79)"],
      [() => decodeAssetAccount(asset.slice(0, 17)), "AssetAccountMalformed(17, 0, 0)"],
      [() => decodeAssetAccount(concatBytes(asset, Uint8Array.of(0))), "AssetAccountMalformed(19, 0, 0)"],
      [() => decodeAssetAccount(Uint8Array.from([...asset.slice(0, 17), 2])), "AssetAccountMalformed(18, 0, 2)"],
      [() => decodeAssetAccount(Uint8Array.from([...asset.slice(0, 16), 3, 0])), "AssetAccountMalformed(18, 3, 0)"],
      [() => decodeNftItem(item.slice(0, 80)), "NftItemMalformed(80)"],
      [() => decodeNftItem(concatBytes(item, Uint8Array.of(0))), "NftItemMalformed(82)"],
      [() => decodeContractInfo(contract.slice(0, 129)), "NotAContract(129, 0)"],
      [() => decodeContractInfo(hexToBytes(read(15).value!.scale)), "NotAContract(5, 1)"],
      [() => slotWord(new Uint8Array(31)), "SlotLength(31)"],
    ];
    for (const [run, message] of cases) {
      assert.throws(run, (error: unknown) => error instanceof StateProofError && error.message === message, message);
    }
  });
});

describe("the kit's walks, as the contracts make them", () => {
  it("gives every read its recorded outcome", () => {
    for (const r of f.reads) assert.equal(reasonOf(() => readAs(r.args, root, nodes(r.proof.nodes))), r.outcome, `read ${r.id}`);
    assert.deepEqual(
      ["value", "KeyNotPresent", "EmptyValue", "KeyNotPresent", "NotAContract"],
      [3, 9, 10, 13, 15].map((id) => read(id).outcome),
    );
  });

  it("proves the reads the Reader makes", () => {
    assert.equal(accountInfoAt(root, evm("0xc6e997A757F0be410714eD04B869EFA1aEE32011"), proof(2)).free, 437_157_579_762_075n);
    assert.equal(assetAccountAt(root, 7777, evm("0x3e79403610c21de20144960a0694b578ebc0dcdf"), proof(3)).balance, 60_500_000n);
    assert.equal(assetAccountAt(root, 7777, evm("0x4f7d38d29172f91f77d3050a9e0f75a1aae5df25"), proof(6)).balance, 100_000n);
    assert.equal(bytesToHex(nftOwnerAt(root, 0, 0, proof(12))), "0x80270a11d7b2e2b8b2dfb1ca3a45ab3b3f2339613709108c72f04074a8048467");
    const vault = contractAt(root, hexToBytes(f.contract.address), proof(14));
    assert.equal(bytesToHex(vault.trieId), "0xbe307c2d11dbc9391cda93d17e9772542d1300c9af14e7431918fb49e2f47c3a");
    assert.equal(bytesToHex(vault.codeHash), "0xa72553f50cdf645fb343b2cf089e431a1b26fb07e80f4e2236d55bf9811c663f");
  });

  it("reads the vault's slots: commitments[0] to [7], nextNonce 8, outstanding 1.411 tPOT, and no commitments[8]", () => {
    for (const s of f.contract.slots) {
      const outcome = reasonOf(() => childSlotAt(root, trieId, hexToBytes(s.index), childRootProof, nodes(s.proof.nodes)));
      assert.equal(outcome, s.outcome, s.name);
      if (s.value) assert.equal(bytesToHex(childSlotAt(root, trieId, hexToBytes(s.index), childRootProof, nodes(s.proof.nodes))), s.value.hex, s.name);
    }
    const lock1 = contractSlotAt(root, hexToBytes(f.contract.address), mappingSlot(1n, 0n), { account: proof(14), childRoot: childRootProof, slot: nodes(f.contract.slots[1].proof.nodes) });
    assert.equal(bytesToHex(lock1.word), "0x2d1ab009f006fd70b9653d09a56a3b4927775d6251c4879df9c7a1364b0ad0a7");
    assert.equal(BigInt(f.contract.slots[9].value!.hex), 8n);
    assert.equal(BigInt(f.contract.slots[10].value!.hex), 141_100_000_000_000n);
    assert.equal(f.contract.slots[8].outcome, "KeyNotPresent");
  });

  it("accepts proof items the walk does not need, as the contract does", () => {
    const padded = [...proof(3), ...proof(11)];
    assert.equal(assetAccountAt(root, 7777, evm("0x3e79403610c21de20144960a0694b578ebc0dcdf"), padded).balance, 60_500_000n);
  });

  it("refuses an empty proof and an empty key", () => {
    assert.equal(reasonOf(() => readMain(root, [], hexToBytes(read(1).key.hex))), "EmptyProof");
    assert.equal(reasonOf(() => readMain(root, proof(1), new Uint8Array(0))), "EmptyKey");
  });

  it("shows an address with no contract absent: read 15's proof holds 0x…dEaD's path, and the slot read gives KeyNotPresent with no code hash", () => {
    const dead = hexToBytes("0x000000000000000000000000000000000000dead");
    assert.equal(reasonOf(() => contractAt(root, dead, proof(15))), "KeyNotPresent");
    const slot = { account: proof(15), childRoot: childRootProof, slot: nodes(f.contract.slots[1].proof.nodes) };
    assert.equal(reasonOf(() => contractSlotAt(root, dead, mappingSlot(1n, 0n), slot)), "KeyNotPresent");
  });

  it("gives EmptyValue for a key that holds an empty value, as for read 10's branch without one", () => {
    // A trie of one leaf: 2 nibbles (0x42), the nibbles 1 and 2, an empty inline value (compact 0).
    const leaf = Uint8Array.of(0x42, 0x12, 0x00);
    const leafRoot = blake2_256(leaf);
    assert.equal(reasonOf(() => readMain(leafRoot, [leaf], Uint8Array.of(0x12))), "EmptyValue");
    assert.equal(reasonOf(() => readMain(leafRoot, [leaf], Uint8Array.of(0x13))), "KeyNotPresent");
    assert.equal(read(10).outcome, "EmptyValue");
  });

  it("builds lock 1's LockProof for BridgeMinter.mint from the vault's slot proofs: 3,460 bytes of calldata", () => {
    const proofs = { account: proof(14), childRoot: childRootProof, slot: nodes(f.contract.slots[1].proof.nodes) };
    const lock = { recipient: hexToBytes("0xD9838A86cF83C28Ee486544060D1cA4Ca2971071"), amount: 100_000_000_000_000n, nonce: 1n };
    const p = lockProofOf(B, proofs, lock, false);
    assert.deepEqual(p.accountProof, []);
    assert.equal(mintCalldata(p).length, 3460);
    assert.equal(lockProofOf(B, proofs, lock, true).accountProof.length, proof(14).length, "with the bind, the vault's entry too");
  });
});

describe("the kit's tampers, mirrored", () => {
  it("fails with \"Incomplete Proof!\" for a flip in any item of any read", () => {
    for (const r of f.reads) {
      const items = nodes(r.proof.nodes);
      for (let i = 0; i < items.length; i++) {
        const copy = items.slice();
        copy[i] = flipByte(items[i], i % items[i].length);
        assert.equal(reasonOf(() => readAs(r.args, root, copy)), INCOMPLETE_PROOF, `read ${r.id}, item ${i}`);
      }
    }
  });

  it("gives each wrong key the fixture's outcome", () => {
    for (const t of f.tampers) assert.equal(reasonOf(() => readMain(root, proof(t.read), hexToBytes(t.key))), t.outcome, t.name);
    assert.deepEqual(new Set(f.tampers.map((t) => t.outcome)), new Set(["Incomplete Proof!", "EmptyValue", "KeyNotPresent"]));
  });

  it("fails every read under another root, its parent's", () => {
    const parent = hexToBytes(f.parentHeader.stateRoot);
    for (const r of f.reads) assert.equal(reasonOf(() => readAs(r.args, parent, nodes(r.proof.nodes))), INCOMPLETE_PROOF, `read ${r.id}`);
  });

  it("refuses the vault's slot under another contract's trie id", () => {
    // The child-root key of another trie id leaves the vault's path in the main trie: the walk
    // shows that key absent.
    const other = flipByte(trieId, 0);
    assert.equal(reasonOf(() => childSlotAt(root, other, hexToBytes(f.contract.slots[1].index), childRootProof, nodes(f.contract.slots[1].proof.nodes))), "KeyNotPresent");
  });
});

describe("B and its finality", () => {
  it("hashes B's header to B, names the client's state root, and B's parent is its parent", () => {
    const header = hexToBytes(f.header.scale);
    assert.equal(bytesToHex(blake2_256(header)), f.header.hash);
    assert.equal(bytesToHex(decodeHeader(header).stateRoot), f.lightClient.stateRootOf.stateRoot);
    assert.equal(f.lightClient.stateRootOf.number, 264_729);
    assert.equal(bytesToHex(decodeHeader(header).parentHash), f.parentHeader.hash);
  });

  it("verifies the finality proof under set 73 with the client's check, and the hint is relay.ts's", () => {
    const proofScale = decodeFinalityProof(hexToBytes(f.finalityProof.scale));
    assert.equal(f.finalityProof.bytes, 345);
    const j = decodeJustification(proofScale.justification);
    const keys = decodeAuthorityList(hexToBytes(f.signingSet.runtimeCall.scale)).map((a) => a.id);
    assert.equal(f.signingSet.setId, 73);
    const result = verifyJustification(j, keys, 73n, clientVerifies);
    assert.equal(result.ok, true);
    assert.equal(result.valid, 2);
    assert.equal(bytesToHex(signersHint(j, keys, 73n).hint), f.signers.hint);
    assert.equal(verifyJustification(j, keys, 74n, clientVerifies).ok, false, "not under the next set id");
  });

  it("passes the whole offline check, and fails it for a changed value", () => {
    const lines = checkStateReads(f);
    assert.equal(lines.length, 41);
    assert.deepEqual(lines.filter(([passed]) => !passed), []);
    const changed = structuredClone(f);
    changed.reads[2].value!.decoded.balance = "60500001";
    assert.equal(checkStateReads(changed).filter(([passed]) => !passed).length, 1);
    const otherLock = structuredClone(f);
    otherLock.contract.slots[1].lock!.amountNative = "1";
    assert.match(checkStateReads(otherLock).find(([passed]) => !passed)?.[1] ?? "", /commitment of the record's lock 1/);
  });
});

describe("the Reader's and the gate's calldata", () => {
  it("has the selectors cast sig gives", () => {
    const expected: Record<keyof typeof READER, string> = {
      accountInfo: "0x262c3a5a",
      assetAccount: "0x11f2611a",
      nftOwner: "0xf160b8f5",
      contractInfo: "0x7cb8de8c",
      contractSlot: "0x037f3035",
      childSlot: "0x9d5af072",
      readMain: "0xfbd7d40c",
      stateRootOf: "0xea0f9444",
      lightClient: "0xb5700e68",
    };
    for (const [name, sig] of Object.entries(READER)) assert.equal(bytesToHex(selector(sig)), expected[name as keyof typeof READER], name);
    assert.equal(bytesToHex(selector(GATE.claim)), "0x0d1a4e30");
    assert.equal(bytesToHex(selector(GATE.claimed)), "0xc884ef83");
    assert.equal(CLAIMED_TOPIC, "0xb1e3a356489d914e055f9ef784f24b315dc27d23cf1e84382f62a55664e53e2e");
    assert.ok(KIT_ERRORS.includes("KeyNotPresent(bytes32,bytes)") && KIT_ERRORS.includes("AlreadyClaimed(address)"));
  });

  it("encodes accountInfo, contractSlot (its tuple of three proofs) and claim as cast calldata does", () => {
    const accountInfo = readerCalldata({ kind: "accountInfo", blockHash: B, accountId: evm("0xD9838A86cF83C28Ee486544060D1cA4Ca2971071"), proof: [Uint8Array.of(1, 2), Uint8Array.of(3, 4, 5)] });
    assert.equal(
      bytesToHex(accountInfo),
      "0x262c3a5a6dc44fe16f3e36c49978c422cc11550971f4b3234f9ca23dbac9b99bb0556f50d9838a86cf83c28ee486544060d1ca4ca2971071eeeeeeeeeeeeeeeeeeeeeeee00000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000002010200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000030304050000000000000000000000000000000000000000000000000000000000",
    );
    const contractSlot = readerCalldata({
      kind: "contractSlot",
      blockHash: B,
      address: hexToBytes(f.contract.address),
      slot: uintWord(2n),
      proofs: { account: [Uint8Array.of(1)], childRoot: [Uint8Array.of(2, 3)], slot: [] },
    });
    assert.equal(
      bytesToHex(contractSlot),
      "0x037f30356dc44fe16f3e36c49978c422cc11550971f4b3234f9ca23dbac9b99bb0556f50000000000000000000000000a02ee16eb03d2cf1aef199f7658fb8c8e3188ffd00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000e00000000000000000000000000000000000000000000000000000000000000160000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000001010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000202030000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
    );
    assert.equal(
      bytesToHex(claimCalldata(hexToBytes("0x3e79403610c21de20144960a0694b578ebc0dcdf"), [Uint8Array.of(0xaa, 0xbb)])),
      "0x0d1a4e300000000000000000000000003e79403610c21de20144960a0694b578ebc0dcdf0000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000002aabb000000000000000000000000000000000000000000000000000000000000",
    );
    assert.equal(gateConstructorArgs(new Uint8Array(20).fill(1), B, 7777, 1_000_000n).length, 128);
  });

  it("decodes the Reader's answers, and refuses one of the wrong size", () => {
    const words = (...values: bigint[]) => abiEncode(values.map((v) => ({ word: uintWord(v) })));
    const info = decodeReaderResult("accountInfo", words(6n, 0n, 1n, 0n, 15_947_352_201_127_852n, 0n, 0n, 1n << 127n, 264_729n));
    assert.deepEqual(info, { kind: "accountInfo", info: { nonce: 6, consumers: 0, providers: 1, sufficients: 0, free: 15_947_352_201_127_852n, reserved: 0n, frozen: 0n, flags: 1n << 127n }, number: 264_729 });
    assert.deepEqual(decodeReaderResult("assetAccount", words(60_500_000n, 1n, 264_729n)), { kind: "assetAccount", balance: 60_500_000n, status: 1, number: 264_729 });
    const value = Uint8Array.of(1, 2, 3);
    const main = decodeReaderResult("readMain", abiEncode([{ bytes: value }, { word: uintWord(264_729n) }]));
    assert.deepEqual(main, { kind: "readMain", value, number: 264_729 });
    assert.throws(() => decodeReaderResult("assetAccount", words(1n, 2n)), /96 bytes/);
    assert.throws(() => decodeReaderResult("assetAccount", words(1n, 256n, 3n)), /uint8/);
  });
});
