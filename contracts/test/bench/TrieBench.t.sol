// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {console} from "forge-std/Test.sol";
import {PolkadotTrie} from "../../src/trie/vendor/PolkadotTrie.sol";
import {BenchFixtures} from "./BenchFixtures.sol";
import {Blake2bBench} from "./Blake2bBench.t.sol";

/// Storage proof walk with the blake2b-256 copy of Polytope's PolkadotTrie
/// (src/trie/vendor/PolkadotTrie.sol). gasUsed covers VerifyProof alone (node hashing included),
/// measured in a fresh call frame.
contract TrieBench {
    function read(bytes32 root, bytes[] calldata proof, bytes calldata key)
        external
        view
        returns (bytes memory value, bool present, uint256 gasUsed)
    {
        bytes[] memory nodes = proof;
        bytes[] memory keys = new bytes[](1);
        keys[0] = key;
        uint256 before = gasleft();
        PolkadotTrie.StorageValue[] memory values = PolkadotTrie.VerifyProof(root, nodes, keys);
        gasUsed = before - gasleft();
        return (values[0].value, values[0].keyPresent, gasUsed);
    }
}

contract TrieBenchTest is BenchFixtures {
    TrieBench internal bench;

    bytes32 internal stateRoot;
    bytes internal key;
    bytes internal value;
    bytes[] internal proof;

    function setUp() public {
        bench = new TrieBench();
        string memory json = vm.readFile(ACCOUNT_PROOF);
        assertEq(vm.parseJsonUint(json, ".trieVersion"), 0, "old mainnet uses state version 0");
        stateRoot = vm.parseJsonBytes32(json, ".header.stateRoot");
        // The root is the one inside the header bytes: after the parent hash and the 4-byte
        // compact block number (ImportBench.t.sol also checks the header against its hash).
        assertEq(_word(vm.parseJsonBytes(json, ".header.scale"), 36), stateRoot, "state_root from the header");
        key = vm.parseJsonBytes(json, ".key.hex");
        value = vm.parseJsonBytes(json, ".value.scale");
        bytes[] memory nodes = vm.parseJsonBytesArray(json, ".proof.nodes");
        for (uint256 i = 0; i < nodes.length; i++) {
            proof.push(nodes[i]);
        }
    }

    /// The captured System.Account proof (8 nodes, 2,576 B) walks from the header's state_root
    /// to the captured 80-byte AccountInfo.
    function test_trie_systemAccount() public view {
        _requireOsaka();
        assertEq(proof.length, 8, "8 proof nodes");
        uint256 total;
        for (uint256 i = 0; i < proof.length; i++) {
            total += proof[i].length;
        }
        assertEq(total, 2576, "2,576 proof bytes");
        (bytes memory got, bool present, uint256 gasUsed) = bench.read(stateRoot, proof, key);
        assertTrue(present, "key present");
        assertEq(got, value, "walk returns the captured value");
        console.log("trie walk, System.Account, 8 nodes / 2,576 B (V0, blake2b-256):", gasUsed);
    }

    /// The node-hashing part of the walk on its own: blake2b-256 of each of the 8 nodes.
    function test_trie_nodeHashing() public {
        _requireOsaka();
        Blake2bBench hasher = new Blake2bBench();
        (bytes32[] memory digests, uint256 gasUsed) = hasher.blake2_256Each(proof);
        bool rootFound;
        for (uint256 i = 0; i < digests.length; i++) {
            if (digests[i] == stateRoot) rootFound = true;
        }
        assertTrue(rootFound, "one node hashes to the state_root");
        console.log("blake2b-256 of the 8 proof nodes (2,576 B):", gasUsed);
    }

    /// One flipped byte anywhere in the proof breaks the walk: every node is on the path, so its
    /// hash no longer matches the reference in its parent (or the state_root, for the root node).
    function test_trie_flippedByteInEachNodeFails() public {
        for (uint256 i = 0; i < proof.length; i++) {
            bytes[] memory tampered = proof;
            tampered[i] = _flipBit(proof[i], proof[i].length / 2, 0);
            vm.expectRevert(bytes("Incomplete Proof!"));
            bench.read(stateRoot, tampered, key);
        }
    }

    /// A flipped value byte (in the leaf, the last byte of node 5) also fails: the leaf hash changes.
    function test_trie_flippedValueByteFails() public {
        bytes[] memory tampered = proof;
        bytes memory leaf = proof[5];
        assertEq(uint8(leaf[0]), 0x7f, "node 5 is the leaf");
        tampered[5] = _flipBit(leaf, leaf.length - 1, 0);
        vm.expectRevert(bytes("Incomplete Proof!"));
        bench.read(stateRoot, tampered, key);
    }

    /// A different state_root fails, and so does another account's key.
    function test_trie_wrongRootOrKeyFails() public {
        vm.expectRevert(bytes("Incomplete Proof!"));
        bench.read(_flipBit(stateRoot, 31, 0), proof, key);

        bytes memory otherKey = _flipBit(key, key.length - 1, 0);
        (bytes memory got, bool present,) = bench.read(stateRoot, proof, otherKey);
        assertFalse(present, "another account is not proven present");
        assertEq(got.length, 0, "no value for another account");
    }
}
