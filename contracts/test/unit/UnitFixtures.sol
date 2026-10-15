// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {Scale} from "../../src/grandpa/Scale.sol";
import {Header} from "../../src/grandpa/Header.sol";
import {Justification} from "../../src/grandpa/Justification.sol";

/// Calls the decoders from a separate contract, so reverts can be expected and gas is
/// measured inside a fresh call frame (gasUsed includes copying the input from calldata).
contract DecodeHarness {
    using Scale for Scale.Cursor;

    function header(bytes calldata encoded) external view returns (Header.Decoded memory h, uint256 gasUsed) {
        uint256 before = gasleft();
        h = Header.decodeCalldata(encoded);
        gasUsed = before - gasleft();
    }

    function justification(bytes calldata encoded)
        external
        view
        returns (Justification.Decoded memory j, uint256 gasUsed)
    {
        uint256 before = gasleft();
        j = Justification.decodeCalldata(encoded);
        gasUsed = before - gasleft();
    }

    function finalityProof(bytes calldata encoded)
        external
        view
        returns (Justification.FinalityProof memory p, uint256 gasUsed)
    {
        uint256 before = gasleft();
        p = Justification.decodeFinalityProofCalldata(encoded);
        gasUsed = before - gasleft();
    }

    /// The whole input as one compact integer.
    function compact(bytes calldata encoded) external pure returns (uint256) {
        return Scale.decodeCompact(encoded);
    }

    /// The whole input as one Compact<u32>.
    function compactU32(bytes calldata encoded) external pure returns (uint32 v) {
        Scale.Cursor memory c = Scale.cursor(encoded);
        v = c.readCompactU32();
        c.done();
    }

    /// A compact integer at the start of the input, and how many bytes it took.
    function compactPrefix(bytes calldata encoded) external pure returns (uint256 v, uint256 used) {
        Scale.Cursor memory c = Scale.cursor(encoded);
        v = c.readCompact();
        used = c.offset();
    }
}

/// Reads the captured Portaldot fixtures in both snapshots (see their provenance headers).
abstract contract UnitFixtures is Test {
    DecodeHarness internal harness;

    function setUp() public virtual {
        harness = new DecodeHarness();
    }

    function _dirs() internal pure returns (string[2] memory) {
        return ["../fixtures/mainnet", "../fixtures/mainnet-pre-v3"];
    }

    function _json(string memory dir, string memory file) internal view returns (string memory) {
        return vm.readFile(string.concat(dir, "/", file, ".json"));
    }

    /// Number of elements in the JSON array at `path`.
    function _count(string memory json, string memory path) internal view returns (uint256 n) {
        while (vm.keyExistsJson(json, string.concat(path, "[", vm.toString(n), "]"))) n++;
    }

    function _at(string memory path, uint256 i, string memory field) internal pure returns (string memory) {
        return string.concat(path, "[", vm.toString(i), "]", field);
    }

    /// Reference SCALE compact encoder (shortest form), independent of the decoder.
    function _compact(uint256 v) internal pure returns (bytes memory out) {
        if (v < 1 << 6) return abi.encodePacked(uint8(v << 2));
        if (v < 1 << 14) {
            uint256 x = (v << 2) | 1;
            return abi.encodePacked(uint8(x), uint8(x >> 8));
        }
        if (v < 1 << 30) {
            uint256 x = (v << 2) | 2;
            return abi.encodePacked(uint8(x), uint8(x >> 8), uint8(x >> 16), uint8(x >> 24));
        }
        uint256 n;
        for (uint256 t = v; t != 0; t >>= 8) {
            n++;
        }
        if (n < 4) n = 4;
        out = new bytes(n + 1);
        out[0] = bytes1(uint8(((n - 4) << 2) | 3));
        for (uint256 i = 0; i < n; i++) {
            out[1 + i] = bytes1(uint8(v >> (8 * i)));
        }
    }

    function _le32(uint32 v) internal pure returns (bytes4) {
        return bytes4(Scale.swap32(v));
    }

    function _le64(uint64 v) internal pure returns (bytes8) {
        return bytes8(Scale.swap64(v));
    }

    /// A copy of `data` without its last `n` bytes.
    function _cut(bytes memory data, uint256 n) internal pure returns (bytes memory out) {
        out = new bytes(data.length - n);
        for (uint256 i = 0; i < out.length; i++) {
            out[i] = data[i];
        }
    }
}
