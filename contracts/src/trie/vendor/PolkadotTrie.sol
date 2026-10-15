// Copyright (C) Polytope Labs Ltd.
// SPDX-License-Identifier: Apache-2.0

// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// 	http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// MODIFIED FILE. This is a changed copy of src/PolkadotTrie.sol from
// https://github.com/polytope-labs/solidity-merkle-trees at commit
// 6bbc83d5ac33f85761725cf2eba4f8700164e8ba, licensed under Apache-2.0 (full text in the LICENSE file
// next to this file and in contracts/lib/solidity-merkle-trees/LICENSE). Changed for
// Bridge Zero on 2026-10-15:
//   1. Proof nodes are hashed with blake2b-256 (BLAKE2b from blake2b-solidity) instead of
//      keccak256, because Substrate state tries use the BlakeTwo256 hasher (original line 69).
//   2. VerifyProof and ReadChildProof are `view` instead of `pure`: BLAKE2b reaches the
//      EIP-152 precompile with a STATICCALL.
//   3. The imports point at the unmodified originals in contracts/lib/solidity-merkle-trees
//      (remapping "solidity-merkle-trees/") instead of "./trie/", and BLAKE2b is imported.
// Nothing else is changed. Bridge Zero does not call ReadChildProof.
pragma solidity ^0.8.20;

import {
    NodeKind,
    NodeHandle,
    NibbledBranch,
    NodeHandleOption,
    Leaf,
    TrieNode,
    NibbleSlice
} from "solidity-merkle-trees/trie/Node.sol";
import {Option} from "solidity-merkle-trees/trie/Option.sol";
import {NibbleSliceOps} from "solidity-merkle-trees/trie/NibbleSlice.sol";
import {TrieDB} from "solidity-merkle-trees/trie/TrieDB.sol";
import {PolkadotTrieDb} from "solidity-merkle-trees/trie/polkadot/PolkadotTrieDb.sol";
import {BLAKE2b} from "blake2b-solidity/BLAKE2b.sol";

/**
 * @title Polkadot Merkle Patricia Trie verifier
 * @author Polytope Labs
 * @dev Verifies merkle-patricia proofs produced by substrate/polkadot state tries.
 * @dev refer to research for more info. https://research.polytope.technology/state-machine-proofs
 */
library PolkadotTrie {
    using NibbleSliceOps for NibbleSlice;
    using PolkadotTrieDb for NodeKind;

    // Outcome of a successfully verified polkadot merkle-patricia proof.
    // Substrate/FRAME allows storing empty values (e.g. `()` for set membership),
    // so `keyPresent` distinguishes "key exists with empty value" from "key absent".
    struct StorageValue {
        // the storage key
        bytes key;
        // the encoded value
        bytes value;
        // true if the key was found in the trie
        bool keyPresent;
    }

    /**
     * @notice Verifies polkadot specific merkle patricia proofs.
     * @param root hash of the merkle patricia trie
     * @param proof a list of proof nodes
     * @param keys a list of keys to verify
     * @return bytes[] a list of values corresponding to the supplied keys.
     */
    function VerifyProof(
        bytes32 root,
        bytes[] memory proof,
        bytes[] memory keys
    ) internal view returns (StorageValue[] memory) {
        StorageValue[] memory values = new StorageValue[](keys.length);
        TrieNode[] memory nodes = new TrieNode[](proof.length);

        for (uint256 i = 0; i < proof.length; i++) {
            nodes[i] = TrieNode(bytes32(BLAKE2b.hash(proof[i], "", "", "", 32)), proof[i]);
        }

        for (uint256 i = 0; i < keys.length; i++) {
            values[i].key = keys[i];
            NibbleSlice memory keyNibbles = NibbleSlice(keys[i], 0);
            NodeKind memory node = PolkadotTrieDb.decodeNodeKind(
                TrieDB.get(nodes, root)
            );

            /*
             * This loop is unbounded so that an adversary cannot insert a deeply nested key in the trie
             * and successfully convince us of it's non-existence, if we consume the block gas limit while
             * traversing the trie, then the transaction should revert.
             */
            for (uint256 j = 1; j > 0; j++) {
                NodeHandle memory nextNode;

                if (TrieDB.isLeaf(node)) {
                    Leaf memory leaf = node.decodeLeaf();
                    if (leaf.key.eq(keyNibbles)) {
                        values[i].value = TrieDB.load(nodes, leaf.value);
                        values[i].keyPresent = true;
                    }
                    break;
                } else if (TrieDB.isNibbledBranch(node)) {
                    NibbledBranch memory nibbled = node.decodeNibbledBranch();
                    uint256 nibbledBranchKeyLength = nibbled.key.len();
                    if (!keyNibbles.startsWith(nibbled.key)) {
                        break;
                    }

                    if (keyNibbles.len() == nibbledBranchKeyLength) {
                        values[i].keyPresent = true;
                        if (Option.isSome(nibbled.value)) {
                            values[i].value = TrieDB.load(
                                nodes,
                                nibbled.value.value
                            );
                        }
                        break;
                    } else {
                        uint256 index = keyNibbles.at(nibbledBranchKeyLength);
                        NodeHandleOption memory handle = nibbled.children[
                            index
                        ];
                        if (Option.isSome(handle)) {
                            keyNibbles = keyNibbles.mid(nibbledBranchKeyLength + 1);
                            nextNode = handle.value;
                        } else {
                            break;
                        }
                    }
                } else if (TrieDB.isEmpty(node)) {
                    break;
                }

                node = PolkadotTrieDb.decodeNodeKind(
                    TrieDB.load(nodes, nextNode)
                );
            }
        }

        return values;
    }

    /**
     * @notice Verify child trie keys
     * @dev substrate specific method in order to verify keys in the child trie.
     * @param root hash of the merkle root
     * @param proof a list of proof nodes
     * @param keys a list of keys to verify
     * @param childInfo data that can be used to compute the root of the child trie
     * @return bytes[], a list of values corresponding to the supplied keys.
     */
    function ReadChildProof(
        bytes32 root,
        bytes[] memory proof,
        bytes[] memory keys,
        bytes memory childInfo
    ) internal view returns (StorageValue[] memory) {
        // fetch the child trie root hash;
        bytes memory prefix = bytes(":child_storage:default:");
        bytes memory key = bytes.concat(prefix, childInfo);
        bytes[] memory _keys = new bytes[](1);
        _keys[0] = key;
        StorageValue[] memory values = VerifyProof(root, proof, _keys);

        bytes32 childRoot = bytes32(values[0].value);
        require(childRoot != bytes32(0), "Invalid child trie proof");

        return VerifyProof(childRoot, proof, keys);
    }
}
