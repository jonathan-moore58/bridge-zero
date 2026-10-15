// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {console} from "forge-std/Test.sol";
import {SubstrateProofs} from "../../src/trie/SubstrateProofs.sol";
import {PolkadotTrie} from "../../src/trie/vendor/PolkadotTrie.sol";
import {Header} from "../../src/grandpa/Header.sol";
import {UnitFixtures} from "./UnitFixtures.sol";

/// Calls the library from a separate contract, so reverts can be expected and gas measured.
contract ProofsHarness {
    function verifyMain(bytes32 root, bytes[] memory nodes, bytes memory key)
        external
        view
        returns (bytes memory value, uint256 gasUsed)
    {
        uint256 before = gasleft();
        value = SubstrateProofs.verifyMain(root, nodes, key);
        gasUsed = before - gasleft();
    }

    function verifyChild(
        bytes32 root,
        bytes[] memory mainNodes,
        bytes[] memory childNodes,
        bytes memory childInfo,
        bytes memory key
    ) external view returns (bytes memory value, bytes32 childRoot) {
        return SubstrateProofs.verifyChild(root, mainNodes, childNodes, childInfo, key);
    }

    /// The vendored walk alone, to compare with.
    function vendorRead(bytes32 root, bytes[] memory nodes, bytes memory key)
        external
        view
        returns (bytes memory value, bool present)
    {
        bytes[] memory keys = new bytes[](1);
        keys[0] = key;
        PolkadotTrie.StorageValue memory v = PolkadotTrie.VerifyProof(root, nodes, keys)[0];
        return (v.value, v.keyPresent);
    }

    function systemAccountKey(bytes32 accountId) external view returns (bytes memory) {
        return SubstrateProofs.systemAccountKey(accountId);
    }

    function blake2_128Concat(bytes memory data) external view returns (bytes memory) {
        return SubstrateProofs.blake2_128Concat(data);
    }

    function twox128(bytes memory data) external pure returns (bytes16) {
        return SubstrateProofs.twox128(data);
    }

    function storagePrefix(bytes memory pallet, bytes memory item) external pure returns (bytes32) {
        return SubstrateProofs.storagePrefix(pallet, item);
    }
}

/// Builds small Substrate tries (V0 and V1 node layouts) for the synthetic tests.
abstract contract TrieBuilder is UnitFixtures {
    ProofsHarness internal ph;

    /// The vendored walk's revert when a node is not among the proof items.
    bytes internal INCOMPLETE;

    function setUp() public virtual override {
        super.setUp();
        ph = new ProofsHarness();
        INCOMPLETE = abi.encodeWithSignature("Error(string)", "Incomplete Proof!");
    }

    function _b2(bytes memory data) internal view returns (bytes32) {
        return SubstrateProofs.blake2_256(data);
    }

    function _nibble(bytes memory key, uint256 i) internal pure returns (uint8) {
        uint8 b = uint8(key[i / 2]);
        return i % 2 == 0 ? b >> 4 : b & 0x0f;
    }

    /// Node header: `prefix` in the top `bits` bits, then the partial-key nibble count.
    function _nodeHeader(uint8 prefix, uint256 bits, uint256 nibbles) internal pure returns (bytes memory out) {
        uint256 maxV = 255 >> bits;
        if (nibbles < maxV) return abi.encodePacked(uint8(prefix | nibbles));
        out = abi.encodePacked(uint8(prefix | maxV));
        uint256 r = nibbles - maxV;
        for (; r >= 255; r -= 255) {
            out = bytes.concat(out, hex"ff");
        }
        out = bytes.concat(out, abi.encodePacked(uint8(r)));
    }

    /// Partial key: nibbles [from, end) of `key`, an odd count left-padded with a zero nibble.
    function _partial(bytes memory key, uint256 from) internal pure returns (bytes memory out) {
        uint256 n = key.length * 2 - from;
        uint256 start = (from + 1) / 2;
        out = n % 2 == 1 ? abi.encodePacked(_nibble(key, from)) : bytes("");
        for (uint256 i = start; i < key.length; i++) {
            out = bytes.concat(out, key[i]);
        }
    }

    function _nibbleCount(bytes memory key, uint256 from) internal pure returns (uint256) {
        return key.length * 2 - from;
    }

    /// V0 leaf (inline value) for the nibbles of `key` from `from`.
    function _leaf(bytes memory key, uint256 from, bytes memory value) internal pure returns (bytes memory) {
        return
            bytes.concat(
                _nodeHeader(0x40, 2, _nibbleCount(key, from)), _partial(key, from), _compact(value.length), value
            );
    }

    /// V1 leaf with a hashed value (the value is a separate proof item).
    function _hashedLeaf(bytes memory key, uint256 from, bytes memory value) internal view returns (bytes memory) {
        return bytes.concat(_nodeHeader(0x20, 3, _nibbleCount(key, from)), _partial(key, from), _b2(value));
    }

    /// Branch without a value; partial key = nibbles [from, to) of `key`; children by nibble.
    function _branch(bytes memory key, uint256 from, uint256 to, uint8[] memory at, bytes[] memory children)
        internal
        view
        returns (bytes memory out)
    {
        bytes memory part = to > from ? _partial(_slice(key, to), from) : bytes("");
        uint16 bitmap;
        for (uint256 i = 0; i < at.length; i++) {
            bitmap |= uint16(1) << at[i];
        }
        out = bytes.concat(_nodeHeader(0x80, 2, to - from), part, abi.encodePacked(uint8(bitmap), uint8(bitmap >> 8)));
        // Children in nibble order.
        for (uint8 nib = 0; nib < 16; nib++) {
            for (uint256 i = 0; i < at.length; i++) {
                if (at[i] != nib) continue;
                bytes memory c = children[i];
                out = c.length < 32 ? bytes.concat(out, _compact(c.length), c) : bytes.concat(out, _compact(32), _b2(c));
            }
        }
    }

    /// The first `nibbles` nibbles of `key` as bytes (nibbles is even here).
    function _slice(bytes memory key, uint256 nibbles) internal pure returns (bytes memory out) {
        out = new bytes((nibbles + 1) / 2);
        for (uint256 i = 0; i < out.length; i++) {
            out[i] = key[i];
        }
    }

    function _two(uint8 a, uint8 b) internal pure returns (uint8[] memory at) {
        at = new uint8[](2);
        (at[0], at[1]) = (a, b);
    }

    function _pair(bytes memory a, bytes memory b) internal pure returns (bytes[] memory l) {
        l = new bytes[](2);
        (l[0], l[1]) = (a, b);
    }

    function _flip(bytes memory data, uint256 at) internal pure returns (bytes memory out) {
        out = bytes.concat(data);
        out[at] = out[at] ^ 0x01;
    }

    /// Expects `data` sent to the harness to revert with exactly `reason`.
    function _expectFail(bytes memory data, bytes memory reason) internal view {
        (bool ok, bytes memory ret) = address(ph).staticcall(data);
        assertFalse(ok, "reverts");
        assertEq(ret, reason, "revert reason");
    }

    function _mainCall(bytes32 root, bytes[] memory nodes, bytes memory key) internal pure returns (bytes memory) {
        return abi.encodeCall(ProofsHarness.verifyMain, (root, nodes, key));
    }
}

/// Captured System.Account proofs (trie V0) of one mainnet snapshot.
abstract contract ProofsSnapshotTest is TrieBuilder {
    bytes internal header;
    bytes32 internal stateRoot;
    bytes32 internal accountId;
    bytes internal key;
    bytes internal value;
    bytes[] internal nodes;

    function _dir() internal pure virtual returns (string memory);

    function setUp() public override {
        super.setUp();
        string memory json = _json(_dir(), "account-proof");
        assertEq(vm.parseJsonUint(json, ".trieVersion"), 0, "Portaldot mainnet uses trie V0");
        header = vm.parseJsonBytes(json, ".header.scale");
        stateRoot = vm.parseJsonBytes32(json, ".header.stateRoot");
        accountId = vm.parseJsonBytes32(json, ".account.id");
        key = vm.parseJsonBytes(json, ".key.hex");
        value = vm.parseJsonBytes(json, ".value.scale");
        bytes[] memory list = vm.parseJsonBytesArray(json, ".proof.nodes");
        for (uint256 i = 0; i < list.length; i++) {
            nodes.push(list[i]);
        }
        Header.Decoded memory h = Header.decode(header);
        assertEq(h.hash, vm.parseJsonBytes32(json, ".header.hash"), "header hash");
        assertEq(h.stateRoot, stateRoot, "state root is the one inside the header");
    }

    function test_systemAccountKey() public view {
        assertEq(ph.systemAccountKey(accountId), key, "System.Account key built on chain");
        assertEq(key.length, 80);
    }

    function test_verify_returnsCapturedValue() public view {
        (bytes memory v, uint256 gasUsed) = ph.verifyMain(stateRoot, nodes, key);
        assertEq(v, value, "80-byte AccountInfo");
        (bytes memory vv, bool present) = ph.vendorRead(stateRoot, nodes, key);
        assertTrue(present);
        assertEq(vv, v, "same as the vendored walk");
        console.log(string.concat(_dir(), ": verifyMain, 8 nodes, gas"), gasUsed);
    }

    /// Changing any single byte of any node breaks the proof.
    function test_everyByteFlipFails() public view {
        bytes[] memory copy = nodes;
        uint256 checked;
        for (uint256 i = 0; i < copy.length; i++) {
            bytes memory node = copy[i];
            for (uint256 j = 0; j < node.length; j++) {
                node[j] ^= 0x01;
                (bool ok, bytes memory ret) = address(ph).staticcall(_mainCall(stateRoot, copy, key));
                node[j] ^= 0x01;
                assertFalse(ok, "a flipped byte must fail");
                assertEq(ret, INCOMPLETE, "the flipped node is not under the root");
                checked++;
            }
        }
        assertEq(checked, 2576, "every byte of the 8 nodes");
    }

    function test_otherAccountFails() public view {
        bytes32[2] memory others = [accountId ^ bytes32(uint256(1)), bytes32(uint256(0))];
        for (uint256 i = 0; i < others.length; i++) {
            (bool ok,) = address(ph).staticcall(_mainCall(stateRoot, nodes, ph.systemAccountKey(others[i])));
            assertFalse(ok, "another account is not proven by this proof");
        }
        // The right account under another root.
        _expectFail(_mainCall(stateRoot ^ bytes32(uint256(1)), nodes, key), INCOMPLETE);
    }

    function test_droppedNodeFails() public view {
        for (uint256 i = 0; i < nodes.length; i++) {
            bytes[] memory fewer = new bytes[](nodes.length - 1);
            for (uint256 k = 0; k < fewer.length; k++) {
                fewer[k] = nodes[k < i ? k : k + 1];
            }
            _expectFail(_mainCall(stateRoot, fewer, key), INCOMPLETE);
        }
    }

    function test_emptyInputs() public view {
        _expectFail(
            _mainCall(stateRoot, new bytes[](0), key), abi.encodeWithSelector(SubstrateProofs.EmptyProof.selector)
        );
        _expectFail(_mainCall(stateRoot, nodes, ""), abi.encodeWithSelector(SubstrateProofs.EmptyKey.selector));
    }
}

contract ProofsMainnetTest is ProofsSnapshotTest {
    function _dir() internal pure override returns (string memory) {
        return "../fixtures/mainnet";
    }
}

contract ProofsMainnetPreV3Test is ProofsSnapshotTest {
    function _dir() internal pure override returns (string memory) {
        return "../fixtures/mainnet-pre-v3";
    }
}

/// Storage keys and the synthetic V1 and child-trie proofs.
contract ProofsSyntheticTest is TrieBuilder {
    // ------------------------------------------------------------------ hashers

    function test_twox128_vectors() public view {
        // Reference values: xxhash (Python) XXH64 with seeds 0 and 1, little-endian.
        assertEq(ph.twox128("System"), bytes16(0x26aa394eea5630e07c48ae0c9558cef7));
        assertEq(ph.twox128("Account"), bytes16(0xb99d880ec681799c0cf30e8886371da9));
        assertEq(ph.twox128("Sudo"), bytes16(0x5c0d1176a568c1f92944340dbfed9e9c));
        assertEq(ph.twox128("Key"), bytes16(0x530ebca703c85910e7164cb7d1c9e47b));
        assertEq(ph.twox128("Grandpa"), bytes16(0x5f9cc45b7a00c5899361e1c6099678dc));
        assertEq(ph.twox128("CurrentSetId"), bytes16(0x8a2d09463effcc78a22d75b9cb87dffc));
        assertEq(ph.twox128(""), bytes16(0x99e9d85137db46ef4bbea33613baafd5));
        assertEq(ph.twox128(_seq(31)), bytes16(0xe18e4d9bb5d246c3fc7d97651d0331f0));
        assertEq(ph.twox128(_seq(32)), bytes16(0xb432ff16519cf5cb94ba9dce66674ed7));
        assertEq(ph.twox128(_seq(33)), bytes16(0xad8efbca1a5d530c99fe10425f8271a3));
        assertEq(ph.twox128(_seq(100)), bytes16(0x9765163280e5c16a23708a09a2a3193d));
        assertEq(ph.storagePrefix("System", "Account"), SubstrateProofs.SYSTEM_ACCOUNT_PREFIX);
    }

    function test_blake2_128Concat() public view {
        bytes memory id = abi.encodePacked(bytes32(uint256(7)));
        bytes memory out = ph.blake2_128Concat(id);
        assertEq(out.length, 48);
        assertEq(bytes16(out), SubstrateProofs.blake2_128(id));
        assertEq(bytes32(_tail(out, 16)), bytes32(uint256(7)), "the input follows the hash");
    }

    // ------------------------------------------------------------------ trie V1, hashed value

    /// Root: branch on nibbles "26" (no value) with a V1 hashed-value leaf for a System.Account
    /// key under nibble a, and an inline V0 leaf for 0x2650aabb under nibble 5.
    function _v1()
        internal
        view
        returns (bytes32 root, bytes[] memory proof, bytes memory k, bytes memory v, bytes memory rootNode)
    {
        k = SubstrateProofs.systemAccountKey(bytes32(uint256(0xb0b)));
        // An 80-byte AccountInfo: nonce 3, providers 1, free 10^18.
        v = abi.encodePacked(
            hex"03000000000000000100000000000000", hex"000064a7b3b6e00d0000000000000000", new bytes(48)
        );
        assertEq(_nibble(k, 2), 0xa);
        bytes memory leaf = _hashedLeaf(k, 3, v);
        bytes memory other = _leaf(hex"2650aabb", 3, hex"01020304");
        assertLt(other.length, 32, "inline child");
        rootNode = _branch(k, 0, 2, _two(0xa, 0x5), _pair(leaf, other));
        root = _b2(rootNode);
        proof = new bytes[](3);
        (proof[0], proof[1], proof[2]) = (rootNode, leaf, v);
    }

    function test_v1_hashedValue() public view {
        (bytes32 root, bytes[] memory proof, bytes memory k, bytes memory v,) = _v1();
        (bytes memory got,) = ph.verifyMain(root, proof, k);
        assertEq(got, v, "value looked up by its hash among the proof items");
        // Proof item order does not matter.
        (proof[0], proof[2]) = (proof[2], proof[0]);
        (got,) = ph.verifyMain(root, proof, k);
        assertEq(got, v);
    }

    function test_v1_inlineChild() public view {
        (bytes32 root,,,, bytes memory rootNode) = _v1();
        bytes[] memory proof = new bytes[](1);
        proof[0] = rootNode;
        (bytes memory got,) = ph.verifyMain(root, proof, hex"2650aabb");
        assertEq(got, hex"01020304");
    }

    function test_v1_failures() public view {
        (bytes32 root, bytes[] memory proof, bytes memory k, bytes memory v, bytes memory rootNode) = _v1();
        // Value item missing.
        bytes[] memory noValue = new bytes[](2);
        (noValue[0], noValue[1]) = (proof[0], proof[1]);
        _expectFail(_mainCall(root, noValue, k), INCOMPLETE);
        // Value item changed.
        bytes[] memory bad = new bytes[](3);
        (bad[0], bad[1], bad[2]) = (proof[0], proof[1], _flip(v, 20));
        _expectFail(_mainCall(root, bad, k), INCOMPLETE);
        // The key ends on the root branch, which has no value: the walk says "present" with an
        // empty value; the library refuses it.
        (bytes memory vv, bool present) = ph.vendorRead(root, proof, hex"26");
        assertTrue(present, "upstream reports the key as present");
        assertEq(vv.length, 0, "with an empty value");
        _expectFail(
            _mainCall(root, proof, hex"26"), abi.encodeWithSelector(SubstrateProofs.EmptyValue.selector, root, hex"26")
        );
        // No child under nibble 7.
        _expectFail(
            _mainCall(root, proof, hex"2670"),
            abi.encodeWithSelector(SubstrateProofs.KeyNotPresent.selector, root, hex"2670")
        );
        // Same path, different leaf key.
        bytes[] memory one = new bytes[](1);
        one[0] = rootNode;
        _expectFail(
            _mainCall(root, one, hex"2650aabc"),
            abi.encodeWithSelector(SubstrateProofs.KeyNotPresent.selector, root, hex"2650aabc")
        );
    }

    // ------------------------------------------------------------------ child trie

    bytes32 internal constant TRIE_ID = keccak256("synthetic contract trie id");
    bytes internal constant CK1 = hex"1111111111111111111111111111111111111111111111111111111111111111";
    bytes internal constant CK2 = hex"2222222222222222222222222222222222222222222222222222222222222222";

    /// Child trie: branch with two V0 leaves (32-byte values). Main trie: branch with the child
    /// root at ":child_storage:default:" ++ TRIE_ID (under nibble 3) and one other leaf.
    function _child(bytes memory childRootValue)
        internal
        view
        returns (bytes32 root, bytes[] memory mainProof, bytes[] memory childProof, bytes32 childRoot)
    {
        bytes memory l1 = _leaf(CK1, 1, abi.encodePacked(keccak256("slot one")));
        bytes memory l2 = _leaf(CK2, 1, abi.encodePacked(keccak256("slot two")));
        bytes memory childNode = _branch(CK1, 0, 0, _two(1, 2), _pair(l1, l2));
        childRoot = _b2(childNode);
        if (childRootValue.length == 0) childRootValue = abi.encodePacked(childRoot);

        bytes memory mk = SubstrateProofs.childRootKey(abi.encodePacked(TRIE_ID));
        assertEq(mk.length, 55);
        assertEq(_nibble(mk, 0), 3);
        bytes memory rootLeaf = _leaf(mk, 1, childRootValue);
        bytes memory other = _leaf(SubstrateProofs.systemAccountKey(bytes32(0)), 1, hex"0102");
        bytes memory mainNode = _branch(mk, 0, 0, _two(3, 2), _pair(rootLeaf, other));
        root = _b2(mainNode);
        mainProof = _pair(mainNode, rootLeaf);
        childProof = _pair(childNode, l1);
    }

    function _childCall(bytes32 root, bytes[] memory m, bytes[] memory c, bytes32 trieId, bytes memory k)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(ProofsHarness.verifyChild, (root, m, c, abi.encodePacked(trieId), k));
    }

    function test_child_proof() public view {
        (bytes32 root, bytes[] memory m, bytes[] memory c, bytes32 childRoot) = _child("");
        (bytes memory v, bytes32 cr) = ph.verifyChild(root, m, c, abi.encodePacked(TRIE_ID), CK1);
        assertEq(cr, childRoot, "child root proven in the main trie");
        assertEq(v, abi.encodePacked(keccak256("slot one")));
    }

    function test_child_failures() public view {
        (bytes32 root, bytes[] memory m, bytes[] memory c, bytes32 childRoot) = _child("");
        bytes memory otherKey = SubstrateProofs.childRootKey(abi.encodePacked(~TRIE_ID));
        // Another trie id.
        _expectFail(
            _childCall(root, m, c, ~TRIE_ID, CK1),
            abi.encodeWithSelector(SubstrateProofs.KeyNotPresent.selector, root, otherKey)
        );
        // A child key whose leaf is not in the child proof.
        _expectFail(_childCall(root, m, c, TRIE_ID, CK2), INCOMPLETE);
        // A child key that is not in the child trie.
        bytes memory absent = hex"3333";
        _expectFail(
            _childCall(root, m, c, TRIE_ID, absent),
            abi.encodeWithSelector(SubstrateProofs.KeyNotPresent.selector, childRoot, absent)
        );
        // Main and child proofs swapped.
        _expectFail(_childCall(root, c, m, TRIE_ID, CK1), INCOMPLETE);
        // A changed child node.
        _expectFail(_childCall(root, m, _pair(c[0], _flip(c[1], 5)), TRIE_ID, CK1), INCOMPLETE);
        // A changed main node.
        _expectFail(_childCall(root, _pair(m[0], _flip(m[1], 60)), c, TRIE_ID, CK1), INCOMPLETE);
    }

    function test_child_rootMustBe32NonZeroBytes() public view {
        (bytes32 root, bytes[] memory m, bytes[] memory c,) = _child(new bytes(31));
        _expectFail(
            _childCall(root, m, c, TRIE_ID, CK1), abi.encodeWithSelector(SubstrateProofs.ChildRootLength.selector, 31)
        );
        (root, m, c,) = _child(new bytes(33));
        _expectFail(
            _childCall(root, m, c, TRIE_ID, CK1), abi.encodeWithSelector(SubstrateProofs.ChildRootLength.selector, 33)
        );
        (root, m, c,) = _child(new bytes(32));
        _expectFail(
            _childCall(root, m, c, TRIE_ID, CK1), abi.encodeWithSelector(SubstrateProofs.ZeroChildRoot.selector)
        );
    }

    // ------------------------------------------------------------------ helpers

    function _seq(uint256 n) internal pure returns (bytes memory out) {
        out = new bytes(n);
        for (uint256 i = 0; i < n; i++) {
            out[i] = bytes1(uint8(i));
        }
    }

    function _tail(bytes memory data, uint256 from) internal pure returns (bytes memory out) {
        out = new bytes(data.length - from);
        for (uint256 i = 0; i < out.length; i++) {
            out[i] = data[from + i];
        }
    }
}
