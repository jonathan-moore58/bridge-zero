// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {BLAKE2b} from "blake2b-solidity/BLAKE2b.sol";
import {PolkadotTrie} from "./vendor/PolkadotTrie.sol";
import {Scale} from "../grandpa/Scale.sol";

/// @title SubstrateProofs
/// @notice Reads Substrate state (trie V0 and V1) from storage proofs against a state root, and
/// builds the storage keys to read.
///
/// The walk is PolkadotTrie.VerifyProof (src/trie/vendor, Polytope's walk with blake2b-256 node
/// hashes). It decodes V0 and V1 nodes, inline child nodes and V1 hashed values; a hashed value
/// is looked up among the proof nodes by its blake2b-256 hash, exactly like a node.
///
/// This library adds the checks the walk leaves to its caller:
///   - The walk reports a key as present, with an empty value, when the key ends on a branch
///     that has no value. Here a value is returned only when the key is present AND the value is
///     not empty.
///   - A child-trie root must be exactly 32 bytes and not zero (the walk's own ReadChildProof
///     converts it with bytes32() and takes main and child nodes from one array; it is not used).
///
/// Failures raised by this library are the named errors below. A proof that is malformed or
/// incomplete under the given root (a node that is not in the proof, including any node whose
/// bytes were changed, or a node that does not decode) reverts inside the walk with its own
/// reason: "Incomplete Proof!", "Bad Format!" or "Unallowed encoding".
library SubstrateProofs {
    /// ":child_storage:default:", the main-trie prefix of a default child trie's root.
    bytes internal constant CHILD_STORAGE_DEFAULT = ":child_storage:default:";

    /// twox128("System") ++ twox128("Account").
    bytes32 internal constant SYSTEM_ACCOUNT_PREFIX =
        0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9;

    // xxHash64 primes.
    uint64 private constant P1 = 11400714785074694791;
    uint64 private constant P2 = 14029467366897019727;
    uint64 private constant P3 = 1609587929392839161;
    uint64 private constant P4 = 9650029242287828579;
    uint64 private constant P5 = 2870177450012600261;

    /// No proof nodes were given.
    error EmptyProof();
    /// The key to read is empty.
    error EmptyKey();
    /// The proof shows that `key` is not in the trie under `root`.
    error KeyNotPresent(bytes32 root, bytes key);
    /// `key` ends on a node without a value (or its value is empty).
    error EmptyValue(bytes32 root, bytes key);
    /// The value at a child-trie root key is not 32 bytes.
    error ChildRootLength(uint256 length);
    /// The child-trie root read from the main trie is zero.
    error ZeroChildRoot();

    // ------------------------------------------------------------------ proofs

    /// The value of `key` in the trie with root `stateRoot`. Reverts unless the proof shows the
    /// key with a non-empty value.
    function verifyMain(bytes32 stateRoot, bytes[] memory proofNodes, bytes memory key)
        internal
        view
        returns (bytes memory value)
    {
        if (proofNodes.length == 0) revert EmptyProof();
        if (key.length == 0) revert EmptyKey();
        bytes[] memory keys = new bytes[](1);
        keys[0] = key;
        PolkadotTrie.StorageValue memory v = PolkadotTrie.VerifyProof(stateRoot, proofNodes, keys)[0];
        if (!v.keyPresent) revert KeyNotPresent(stateRoot, key);
        if (v.value.length == 0) revert EmptyValue(stateRoot, key);
        return v.value;
    }

    /// The value of `key` in the default child trie `childInfo` (for a contract: its trie id).
    /// First proves the child root at ":child_storage:default:" ++ childInfo in the main trie
    /// with `mainProofNodes` (exactly 32 bytes, not zero), then `key` under that root with
    /// `childProofNodes`.
    function verifyChild(
        bytes32 stateRoot,
        bytes[] memory mainProofNodes,
        bytes[] memory childProofNodes,
        bytes memory childInfo,
        bytes memory key
    ) internal view returns (bytes memory value, bytes32 childRoot) {
        childRoot = childRootOf(stateRoot, mainProofNodes, childInfo);
        value = verifyMain(childRoot, childProofNodes, key);
    }

    /// The root of the default child trie `childInfo`, proven in the main trie.
    function childRootOf(bytes32 stateRoot, bytes[] memory mainProofNodes, bytes memory childInfo)
        internal
        view
        returns (bytes32 childRoot)
    {
        bytes memory raw = verifyMain(stateRoot, mainProofNodes, childRootKey(childInfo));
        if (raw.length != 32) revert ChildRootLength(raw.length);
        childRoot = bytes32(raw);
        if (childRoot == bytes32(0)) revert ZeroChildRoot();
    }

    // ------------------------------------------------------------------ storage keys

    /// Main-trie key of a default child trie's root: ":child_storage:default:" ++ childInfo.
    function childRootKey(bytes memory childInfo) internal pure returns (bytes memory) {
        return bytes.concat(CHILD_STORAGE_DEFAULT, childInfo);
    }

    /// System.Account(accountId): twox128("System") ++ twox128("Account") ++
    /// blake2_128_concat(accountId), 80 bytes.
    function systemAccountKey(bytes32 accountId) internal view returns (bytes memory) {
        return bytes.concat(SYSTEM_ACCOUNT_PREFIX, blake2_128Concat(abi.encodePacked(accountId)));
    }

    /// Key prefix of a storage item: twox128(pallet) ++ twox128(item).
    function storagePrefix(bytes memory pallet, bytes memory item) internal pure returns (bytes32) {
        return bytes32(bytes.concat(twox128(pallet), twox128(item)));
    }

    /// Blake2_128Concat hasher: blake2_128(data) ++ data.
    function blake2_128Concat(bytes memory data) internal view returns (bytes memory) {
        return bytes.concat(blake2_128(data), data);
    }

    function blake2_128(bytes memory data) internal view returns (bytes16) {
        return bytes16(BLAKE2b.hash(data, "", "", "", 16));
    }

    function blake2_256(bytes memory data) internal view returns (bytes32) {
        return bytes32(BLAKE2b.hash(data, "", "", "", 32));
    }

    /// Twox128 hasher: xxHash64 with seed 0, then with seed 1, each as 8 little-endian bytes.
    function twox128(bytes memory data) internal pure returns (bytes16) {
        return bytes16(bytes.concat(bytes8(Scale.swap64(xxh64(data, 0))), bytes8(Scale.swap64(xxh64(data, 1)))));
    }

    /// xxHash64 (XXH64) of `data` with `seed`.
    function xxh64(bytes memory data, uint64 seed) internal pure returns (uint64 h) {
        unchecked {
            uint256 len = data.length;
            uint256 p = 0;
            if (len >= 32) {
                uint64 v1 = seed + P1 + P2;
                uint64 v2 = seed + P2;
                uint64 v3 = seed;
                uint64 v4 = seed - P1;
                for (; p + 32 <= len; p += 32) {
                    v1 = _round(v1, _le64(data, p));
                    v2 = _round(v2, _le64(data, p + 8));
                    v3 = _round(v3, _le64(data, p + 16));
                    v4 = _round(v4, _le64(data, p + 24));
                }
                h = _rotl(v1, 1) + _rotl(v2, 7) + _rotl(v3, 12) + _rotl(v4, 18);
                h = _merge(h, v1);
                h = _merge(h, v2);
                h = _merge(h, v3);
                h = _merge(h, v4);
            } else {
                h = seed + P5;
            }
            h += uint64(len);
            for (; p + 8 <= len; p += 8) {
                h ^= _round(0, _le64(data, p));
                h = _rotl(h, 27) * P1 + P4;
            }
            if (p + 4 <= len) {
                h ^= uint64(Scale.swap32(uint32(bytes4(_word(data, p))))) * P1;
                h = _rotl(h, 23) * P2 + P3;
                p += 4;
            }
            for (; p < len; p++) {
                h ^= uint64(uint8(data[p])) * P5;
                h = _rotl(h, 11) * P1;
            }
            h ^= h >> 33;
            h *= P2;
            h ^= h >> 29;
            h *= P3;
            h ^= h >> 32;
        }
    }

    function _round(uint64 acc, uint64 input) private pure returns (uint64) {
        unchecked {
            return _rotl(acc + input * P2, 31) * P1;
        }
    }

    function _merge(uint64 acc, uint64 v) private pure returns (uint64) {
        unchecked {
            return (acc ^ _round(0, v)) * P1 + P4;
        }
    }

    function _rotl(uint64 x, uint64 r) private pure returns (uint64) {
        return (x << r) | (x >> (64 - r));
    }

    function _le64(bytes memory data, uint256 p) private pure returns (uint64) {
        return Scale.swap64(uint64(bytes8(_word(data, p))));
    }

    /// The 32 bytes of `data` from `p` (callers read at most 8 bytes inside `data`).
    function _word(bytes memory data, uint256 p) private pure returns (bytes32 w) {
        assembly {
            w := mload(add(add(data, 32), p))
        }
    }
}
