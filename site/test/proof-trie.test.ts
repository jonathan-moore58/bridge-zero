// The proof core's trie walk on the recorded proofs: the three mint bundles (the vault's account
// entry, its child-trie root and commitments[nonce], trie V1), V3 and old-mainnet account proofs
// (V1 with the value behind its hash, and V0), and one flipped byte anywhere, which proves nothing.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { bytesToHex, hexToBytes } from "../src/lib/hex.ts";
import { childItems, childRootKey, commitmentKey } from "../src/lib/proof/revive.ts";
import { decodeNode, provenValue, readProof, TrieProofError } from "../src/lib/proof/trie.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const read = (path: string) => JSON.parse(readFileSync(join(repo, path), "utf8"));
const bundles = ["v3-testnet-mint", "v3-testnet-hero", "v3-testnet-lock1"].map((d) => ({ dir: d, b: read(`fixtures/${d}/mint-bundle.json`) }));
const nodes = (list: string[]) => list.map((x) => hexToBytes(x));

function flip(b: Uint8Array, at: number): Uint8Array {
  const out = b.slice();
  out[at] = (out[at] ?? 0) ^ 0x01;
  return out;
}

/** The value a walk reaches, or null when it shows the key absent or fails. */
function reaches(root: Uint8Array, proof: Uint8Array[], key: Uint8Array): string | null {
  try {
    const v = readProof(root, proof, key).value;
    return v ? bytesToHex(v) : null;
  } catch {
    return null;
  }
}

for (const { dir, b } of bundles) {
  test(`${dir}: the account entry, the child root and commitments[${b.lock.nonce}] walk from block #${b.header.number}'s state root`, () => {
    const stateRoot = hexToBytes(b.header.stateRoot);
    const account = provenValue(stateRoot, nodes(b.account.proof.nodes), hexToBytes(b.account.key.hex), "account");
    assert.equal(bytesToHex(account), b.account.value.scale);
    const rootKey = childRootKey(hexToBytes(b.vault.trieId));
    assert.equal(bytesToHex(rootKey), b.childRoot.key.hex);
    const childRoot = provenValue(stateRoot, nodes(b.childRoot.proof.nodes), rootKey, "child root");
    assert.equal(bytesToHex(childRoot), b.childRoot.root);
    const slotKey = commitmentKey(BigInt(b.lock.nonce));
    assert.equal(bytesToHex(slotKey), b.slot.key.hex);
    const word = provenValue(childRoot, nodes(b.slot.proof.nodes), slotKey, "slot");
    assert.equal(bytesToHex(word), b.lock.commitment);
    // As the node serves it: the child-root items again, then the slot's own, which childItems keeps.
    assert.deepEqual(childItems([...nodes(b.childRoot.proof.nodes), ...nodes(b.slot.proof.nodes)], nodes(b.childRoot.proof.nodes)).map(bytesToHex), b.slot.proof.nodes);
  });
}

test("lock 1's proofs: every one-byte flip in every item, and a flipped root, prove nothing", () => {
  const b = bundles[2]!.b;
  const stateRoot = hexToBytes(b.header.stateRoot);
  const childRoot = hexToBytes(b.childRoot.root);
  const sets: [string, Uint8Array, Uint8Array[], Uint8Array, string][] = [
    ["account", stateRoot, nodes(b.account.proof.nodes), hexToBytes(b.account.key.hex), b.account.value.scale],
    ["child root", stateRoot, nodes(b.childRoot.proof.nodes), hexToBytes(b.childRoot.key.hex), b.childRoot.root],
    ["slot", childRoot, nodes(b.slot.proof.nodes), hexToBytes(b.slot.key.hex), b.lock.commitment],
  ];
  let flips = 0;
  for (const [what, root, proof, key, value] of sets) {
    assert.equal(reaches(root, proof, key), value, what);
    proof.forEach((item, i) => {
      for (let at = 0; at < item.length; at++) {
        const tampered = proof.map((x, k) => (k === i ? flip(x, at) : x));
        assert.notEqual(reaches(root, tampered, key), value, `${what} item ${i}, byte ${at}`);
        flips++;
      }
    });
    assert.equal(reaches(flip(root, 0), proof, key), null, `${what}: a flipped root`);
  }
  assert.equal(flips, 1501 + 1258 + 235);
});

test("a proof with an item the walk does not use, a missing item, or an absent key is refused", () => {
  const b = bundles[2]!.b;
  const childRoot = hexToBytes(b.childRoot.root);
  const slot = nodes(b.slot.proof.nodes);
  const key = hexToBytes(b.slot.key.hex);
  assert.throws(() => provenValue(childRoot, [...slot, hexToBytes(b.account.value.scale)], key, "slot"), /items the walk does not use/);
  assert.throws(() => provenValue(childRoot, slot.slice(1), key, "slot"), TrieProofError);
  // commitments[2] did not exist at #118,637: the slot proof of commitments[1] cannot show it.
  assert.equal(reaches(childRoot, slot, commitmentKey(2n)), null);
});

test("trie V1 with the value behind its hash (V3), and trie V0 (the old mainnet)", () => {
  for (const [path, hashed] of [
    ["fixtures/v3-testnet/account-proof.json", 1],
    ["fixtures/mainnet/account-proof.json", 0],
  ] as const) {
    const f = read(path);
    const r = readProof(hexToBytes(f.header.stateRoot), nodes(f.proof.nodes), hexToBytes(f.key.hex));
    assert.equal(r.value && bytesToHex(r.value), f.value.scale, path);
    assert.equal(r.itemsUsed, f.proof.nodes.length, path);
    assert.equal(r.hashedValues, hashed, path);
  }
});

test("node headers: an empty node, and a byte that is no header, are told apart", () => {
  assert.deepEqual(decodeNode(Uint8Array.of(0)), { type: "empty" });
  assert.throws(() => decodeNode(Uint8Array.of(0x01)), TrieProofError);
  assert.throws(() => decodeNode(Uint8Array.of(0x80, 0x00, 0x00)), /without children/);
});
