// Where the vault's lock lives in V3's state: the keys the proof core reads, each against what the
// recorded bundles were captured under, and the account entry the minter binds from.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { bytesToHex, hexToBytes } from "../src/lib/hex.ts";
import { ACCOUNT_INFO_OF_PREFIX, accountInfoKey, childItems, childRootKey, commitmentKey, decodeContractInfo } from "../src/lib/proof/revive.ts";
import { ScaleError } from "../src/lib/proof/scale.ts";
import { TrieProofError } from "../src/lib/proof/trie.ts";
import { GRANDPA_SET_ID_KEY } from "../src/lib/proof/v3.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const read = (path: string) => JSON.parse(readFileSync(join(repo, path), "utf8"));
const lock0 = read("fixtures/v3-testnet-mint/mint-bundle.json");
const lock1 = read("fixtures/v3-testnet-lock1/mint-bundle.json");

test("the keys are the ones the bundles were read under", () => {
  assert.equal(bytesToHex(accountInfoKey(lock1.vault.address)), lock1.account.key.hex);
  assert.equal(lock1.account.key.hex.slice(0, 66), ACCOUNT_INFO_OF_PREFIX);
  assert.equal(bytesToHex(childRootKey(hexToBytes(lock1.vault.trieId))), lock1.childRoot.key.hex);
  assert.equal(bytesToHex(commitmentKey(0n)), lock0.slot.key.hex);
  assert.equal(bytesToHex(commitmentKey(1n)), lock1.slot.key.hex);
  assert.equal(GRANDPA_SET_ID_KEY, lock1.signingSet.setIdStorage.key);
  assert.throws(() => accountInfoKey("0x1234"), RangeError);
  assert.throws(() => childRootKey(new Uint8Array(0)), RangeError);
});

test("the vault's account entry gives its trie id and code hash, as bindVault takes them", () => {
  const info = decodeContractInfo(hexToBytes(lock1.account.value.scale));
  assert.equal(bytesToHex(info.trieId), lock1.vault.trieId);
  assert.equal(bytesToHex(info.codeHash), lock1.vault.codeHash);
  const value = hexToBytes(lock1.account.value.scale);
  assert.throws(() => decodeContractInfo(value.subarray(0, 129)), ScaleError);
  const eoa = value.slice();
  eoa[0] = 1;
  assert.throws(() => decodeContractInfo(eoa), ScaleError);
});

test("of what state_getChildReadProof serves, the child-trie items are kept, and a served list without the root proof is refused", () => {
  const root = lock1.childRoot.proof.nodes.map((x: string) => hexToBytes(x));
  const slot = lock1.slot.proof.nodes.map((x: string) => hexToBytes(x));
  assert.deepEqual(childItems([...slot, ...root], root).map(bytesToHex), lock1.slot.proof.nodes);
  assert.throws(() => childItems([...slot, ...root.slice(1)], root), TrieProofError);
});
