// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";

/// GRANDPA precommit signing payload, as signed by Portaldot authorities:
/// 0x01 ++ target_hash ++ u32le(target_number) ++ u64le(round) ++ u64le(set_id), 53 bytes.
library GrandpaPayload {
    function precommit(bytes32 targetHash, uint32 targetNumber, uint64 round, uint64 setId)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(
            uint8(1), targetHash, bytes4(le32(targetNumber)), bytes8(le64(round)), bytes8(le64(setId))
        );
    }

    function le32(uint32 v) internal pure returns (uint32) {
        v = ((v & 0xff00ff00) >> 8) | ((v & 0x00ff00ff) << 8);
        return (v >> 16) | (v << 16);
    }

    function le64(uint64 v) internal pure returns (uint64) {
        v = ((v & 0xff00ff00ff00ff00) >> 8) | ((v & 0x00ff00ff00ff00ff) << 8);
        v = ((v & 0xffff0000ffff0000) >> 16) | ((v & 0x0000ffff0000ffff) << 16);
        return (v >> 32) | (v << 32);
    }
}

/// Loads the captured Portaldot mainnet fixtures (fixtures/mainnet, see their provenance
/// headers) and provides the RFC 8032 vector used by the ed25519 benchmarks.
abstract contract BenchFixtures is Test {
    string internal constant HEAD = "../fixtures/mainnet/finality-proof-head.json";
    string internal constant SET_CHANGE = "../fixtures/mainnet/set-change.json";
    string internal constant ACCOUNT_PROOF = "../fixtures/mainnet/account-proof.json";

    /// EIP-7825 transaction gas limit cap (Osaka; live on Sepolia).
    uint256 internal constant TX_GAS_CAP = 16_777_216;

    struct Precommit {
        bytes32 key; // authority ed25519 public key, as stored on chain
        bytes32 r; // signature bytes 0..32
        bytes32 s; // signature bytes 32..64
    }

    struct Justified {
        bytes32 blockHash;
        uint32 number;
        uint64 round;
        uint64 setId;
        bytes payload; // 53-byte signing payload shared by every precommit on the commit target
        Precommit[] precommits;
    }

    /// Gas is measured under the rules Sepolia runs (EIP-7883 MODEXP pricing among them).
    function _requireOsaka() internal pure {
        assertEq(vm.getEvmVersion(), "osaka", "benchmarks must run under the osaka rules");
    }

    /// The justification and signing set id of fixtures/mainnet/finality-proof-head.json.
    function _loadHead() internal view returns (Justified memory j) {
        string memory json = vm.readFile(HEAD);
        j.blockHash = vm.parseJsonBytes32(json, ".header.hash");
        j.number = uint32(vm.parseJsonUint(json, ".header.number"));
        j.round = uint64(vm.parseJsonUint(json, ".justification.round"));
        j.setId = uint64(vm.parseJsonUint(json, ".signingSet.setId"));

        bytes32 targetHash = vm.parseJsonBytes32(json, ".justification.targetHash");
        uint32 targetNumber = uint32(vm.parseJsonUint(json, ".justification.targetNumber"));
        assertEq(targetHash, j.blockHash, "justification target is the captured block");
        assertEq(targetNumber, j.number, "justification target number");
        j.payload = GrandpaPayload.precommit(targetHash, targetNumber, j.round, j.setId);
        assertEq(j.payload.length, 53, "payload length");

        uint256 count;
        while (vm.keyExistsJson(json, _precommitPath(count))) count++;
        j.precommits = new Precommit[](count);
        for (uint256 i = 0; i < count; i++) {
            string memory at = _precommitPath(i);
            // Every precommit must be on the commit target, so they all share one payload.
            assertEq(vm.parseJsonBytes32(json, string.concat(at, ".targetHash")), targetHash, "precommit target");
            assertEq(vm.parseJsonUint(json, string.concat(at, ".targetNumber")), targetNumber, "precommit number");
            bytes memory sig = vm.parseJsonBytes(json, string.concat(at, ".signature"));
            assertEq(sig.length, 64, "signature length");
            j.precommits[i] = Precommit({
                key: vm.parseJsonBytes32(json, string.concat(at, ".authorityId")), r: _word(sig, 0), s: _word(sig, 32)
            });
        }
    }

    function _precommitPath(uint256 i) private pure returns (string memory) {
        return string.concat(".justification.precommits[", vm.toString(i), "]");
    }

    /// The signing set's keys in :grandpa_authorities order (all weights are 1 on mainnet).
    function _signingSetKeys(string memory json) internal view returns (bytes32[] memory keys) {
        uint256 count;
        while (vm.keyExistsJson(json, _authorityPath(count))) count++;
        keys = new bytes32[](count);
        for (uint256 i = 0; i < count; i++) {
            assertEq(vm.parseJsonUint(json, string.concat(_authorityPath(i), ".weight")), 1, "authority weight");
            keys[i] = vm.parseJsonBytes32(json, string.concat(_authorityPath(i), ".id"));
        }
    }

    function _authorityPath(uint256 i) private pure returns (string memory) {
        return string.concat(".signingSet.authorities[", vm.toString(i), "]");
    }

    /// RFC 8032, section 7.1, "TEST SHA(abc)": a 64-byte message, so SHA-512(R ++ A ++ M) spans
    /// two 128-byte blocks, as it does for the 53-byte GRANDPA payload.
    function _rfc8032ShaAbc() internal pure returns (Precommit memory sig, bytes memory message) {
        sig.key = 0xec172b93ad5e563bf4932c70e1245034c35467ef2efd4d64ebf819683467e2bf;
        sig.r = 0xdc2a4459e7369633a52b1bf277839a00201009a3efbf3ecb69bea2186c26b589;
        sig.s = 0x09351fc9ac90b3ecfdfbc7c66431e0303dca179c138ac17ad9bef1177331a704;
        message = hex"ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a"
            hex"2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f";
    }

    /// A copy of `data` with one bit flipped.
    function _flipBit(bytes memory data, uint256 index, uint8 bit) internal pure returns (bytes memory out) {
        out = bytes.concat(data);
        out[index] = out[index] ^ bytes1(uint8(1) << bit);
    }

    function _flipBit(bytes32 word, uint256 index, uint8 bit) internal pure returns (bytes32) {
        return word ^ bytes32(uint256(1) << (8 * (31 - index) + bit));
    }

    function _word(bytes memory data, uint256 offset) internal pure returns (bytes32 w) {
        require(data.length >= offset + 32, "out of range");
        assembly {
            w := mload(add(add(data, 32), offset))
        }
    }

    /// Intrinsic gas of a transaction carrying `data` (EIP-2028 calldata pricing). With millions
    /// of execution gas, the EIP-7623 calldata floor does not apply.
    function _intrinsicGas(bytes memory data) internal pure returns (uint256 gas) {
        gas = 21_000;
        for (uint256 i = 0; i < data.length; i++) {
            gas += data[i] == 0 ? 4 : 16;
        }
    }
}
