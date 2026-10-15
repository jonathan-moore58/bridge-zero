// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {console} from "forge-std/Test.sol";
import {BLAKE2b} from "blake2b-solidity/BLAKE2b.sol";
import {BenchFixtures} from "./BenchFixtures.sol";

/// dhl/blake2b-solidity over the EIP-152 BLAKE2F precompile. gasUsed covers the hash alone,
/// measured in a fresh call frame.
contract Blake2bBench {
    /// Substrate's blake2_256 (BlakeTwo256): header hashes and trie node hashes.
    function blake2_256(bytes calldata data) external view returns (bytes32 digest, uint256 gasUsed) {
        bytes memory input = data;
        uint256 before = gasleft();
        digest = bytes32(BLAKE2b.hash(input, "", "", "", 32));
        gasUsed = before - gasleft();
    }

    /// Substrate's blake2_128: the Blake2_128Concat storage hasher (System.Account keys).
    function blake2_128(bytes calldata data) external view returns (bytes16 digest, uint256 gasUsed) {
        bytes memory input = data;
        uint256 before = gasleft();
        digest = bytes16(BLAKE2b.hash(input, "", "", "", 16));
        gasUsed = before - gasleft();
    }

    /// blake2_256 of every item, as the trie walk hashes every proof node.
    function blake2_256Each(bytes[] calldata items) external view returns (bytes32[] memory digests, uint256 gasUsed) {
        bytes[] memory inputs = items;
        digests = new bytes32[](inputs.length);
        uint256 before = gasleft();
        for (uint256 i = 0; i < inputs.length; i++) {
            digests[i] = bytes32(BLAKE2b.hash(inputs[i], "", "", "", 32));
        }
        gasUsed = before - gasleft();
    }
}

contract Blake2bBenchTest is BenchFixtures {
    Blake2bBench internal bench;

    function setUp() public {
        bench = new Blake2bBench();
    }

    /// Known answers from RFC 7693 (Appendix A, BLAKE2b-512 of "abc") and the BLAKE2b-256 /
    /// BLAKE2b-128 digests of the empty string, so a wrong parameter block fails here first.
    function test_blake2b_knownAnswers() public view {
        (bytes32 e256,) = bench.blake2_256("");
        assertEq(e256, 0x0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8, "blake2b-256('')");
        (bytes16 e128,) = bench.blake2_128("");
        assertEq(e128, bytes16(0xcae66941d9efbd404e4d88758ea67670), "blake2b-128('')");
        bytes memory abc512 = BLAKE2b.hash("abc", "", "", "", 64);
        assertEq(
            abc512,
            hex"ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d1"
            hex"7d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923",
            "RFC 7693 blake2b-512('abc')"
        );
    }

    /// Inputs at and around the 128-byte block size, where the last block has to be the final
    /// one even when it is full. Headers and proof nodes can have any length. The expected
    /// digests were computed with Python's hashlib.blake2b over bytes (7 * i + 3) mod 256.
    function test_blake2b_blockBoundaries() public view {
        uint16[6] memory lengths = [uint16(127), 128, 129, 255, 256, 257];
        bytes32[6] memory expected = [
            bytes32(0xc9ae3859964b35f04c54b36d33cf299d7290ee621005d28e51598a943560aaaa),
            0xf0501d06597880592bc49234eef100ec1ff349058d0e9d9b753504e24af86dd6,
            0xa34a4e1e03c541dfbf3099c4b6c143c022ced65c28bd7e8a10e0a098461aecf0,
            0xf2d64a40e9412a3414161ff6250075225418fd7c271c1123e162e1bca0de9f93,
            0xd93ebb9c802f5630ab22516fd82b6c21bc8bd551d531349b715f046ed11ed871,
            0x4ce481b24d387422d2bc2baa03d1afd55a1327939ff537c71eb9b38709268649
        ];
        for (uint256 i = 0; i < lengths.length; i++) {
            (bytes32 digest,) = bench.blake2_256(_pattern(lengths[i]));
            assertEq(digest, expected[i], string.concat("blake2b-256, ", vm.toString(lengths[i]), " bytes"));
        }
        (bytes16 d128,) = bench.blake2_128(_pattern(128));
        assertEq(d128, bytes16(0x8e0cf9bb1b36fa6c42aa6490f719b575), "blake2b-128, 128 bytes");
    }

    /// blake2_256 of the captured 191-byte header equals the block hash the node reported.
    function test_blake2b_headHeader() public view {
        _requireOsaka();
        string memory json = vm.readFile(HEAD);
        bytes memory header = vm.parseJsonBytes(json, ".header.scale");
        bytes32 expected = vm.parseJsonBytes32(json, ".header.hash");
        assertEq(header.length, 191, "head header length");
        (bytes32 digest, uint256 gasUsed) = bench.blake2_256(header);
        assertEq(digest, expected, "blake2_256(header) == captured block hash");
        (bytes32 tampered,) = bench.blake2_256(_flipBit(header, 100, 0));
        assertTrue(tampered != expected, "a flipped header bit changes the hash");
        console.log("blake2b-256, head header (191 B):", gasUsed);
    }

    /// The same for the 1,045-byte set-change header (FRNK ScheduledChange digest).
    function test_blake2b_setChangeHeader() public view {
        _requireOsaka();
        string memory json = vm.readFile(SET_CHANGE);
        bytes memory header = vm.parseJsonBytes(json, ".header.scale");
        bytes32 expected = vm.parseJsonBytes32(json, ".header.hash");
        assertEq(header.length, 1045, "set-change header length");
        (bytes32 digest, uint256 gasUsed) = bench.blake2_256(header);
        assertEq(digest, expected, "blake2_256(header) == captured block hash");
        console.log("blake2b-256, set-change header (1,045 B):", gasUsed);
    }

    /// The Blake2_128Concat part of the captured System.Account key: blake2_128(account id).
    function test_blake2b_accountKeyHasher() public view {
        _requireOsaka();
        string memory json = vm.readFile(ACCOUNT_PROOF);
        bytes memory key = vm.parseJsonBytes(json, ".key.hex");
        bytes32 account = vm.parseJsonBytes32(json, ".account.id");
        assertEq(key.length, 80, "System.Account key length");
        (bytes16 digest, uint256 gasUsed) = bench.blake2_128(abi.encodePacked(account));
        assertEq(digest, bytes16(_word(key, 32)), "key[32..48] == blake2_128(account id)");
        assertEq(_word(key, 48), account, "key[48..80] == account id");
        console.log("blake2b-128, 32-byte account id:", gasUsed);
    }

    function _pattern(uint256 length) private pure returns (bytes memory data) {
        data = new bytes(length);
        for (uint256 i = 0; i < length; i++) {
            data[i] = bytes1(uint8((7 * i + 3) % 256));
        }
    }
}
