// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {Scale} from "../../src/grandpa/Scale.sol";
import {UnitFixtures} from "./UnitFixtures.sol";

contract CompactTest is UnitFixtures {
    // ---------------------------------------------------------------- known encodings

    function test_modeBoundaries() public view {
        _check(hex"00", 0);
        _check(hex"04", 1);
        _check(hex"fc", 63); // largest single-byte value
        _check(hex"0101", 64); // smallest two-byte value
        _check(hex"fdff", 16383); // largest two-byte value
        _check(hex"02000100", 16384); // smallest four-byte value
        _check(hex"feffffff", (1 << 30) - 1); // largest four-byte value
        _check(hex"0300000040", 1 << 30); // smallest big-integer value
        _check(hex"03ffffffff", type(uint32).max);
        _check(hex"070000000001", 1 << 32);
        _check(hex"13ffffffffffffffff", type(uint64).max);
        _check(hex"73ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", type(uint256).max); // 32 bytes, the most a uint256 holds
        // The block number of the captured head header (2,726,202).
        _check(hex"ea64a600", 2726202);
    }

    function test_u32Bounds() public {
        assertEq(harness.compactU32(hex"03ffffffff"), type(uint32).max);
        assertEq(harness.compactU32(hex"feffffff"), (1 << 30) - 1);
        vm.expectRevert(abi.encodeWithSelector(Scale.CompactOverflow.selector, 0));
        harness.compactU32(hex"070000000001");
        vm.expectRevert(abi.encodeWithSelector(Scale.CompactOverflow.selector, 0));
        harness.compactU32(hex"13ffffffffffffffff");
    }

    // ---------------------------------------------------------------- rejects

    function test_rejectsNonCanonical() public {
        bytes[8] memory bad = [
            bytes(hex"0100"), // 0 in two-byte mode
            hex"fd00", // 63 in two-byte mode
            hex"02000000", // 0 in four-byte mode
            hex"feff0000", // 16383 in four-byte mode
            hex"03ffffff3f", // 2^30 - 1 in big-integer mode
            hex"0300000000", // 0 in big-integer mode
            hex"07ffffffff00", // 2^32 - 1 with a zero top byte
            hex"73000000000000000000000000000000000000000000000000000000000000ff00" // zero top byte, 32 bytes
        ];
        for (uint256 i = 0; i < bad.length; i++) {
            vm.expectRevert(abi.encodeWithSelector(Scale.NonCanonicalCompact.selector, 0));
            harness.compact(bad[i]);
        }
    }

    function test_rejectsMoreThan32Bytes() public {
        bytes memory b = new bytes(34);
        b[0] = 0x77; // (0x77 >> 2) + 4 = 33 bytes follow
        b[33] = 0x01;
        vm.expectRevert(abi.encodeWithSelector(Scale.CompactOverflow.selector, 0));
        harness.compact(b);
    }

    function test_rejectsTruncated() public {
        vm.expectRevert(abi.encodeWithSelector(Scale.Truncated.selector, 0, 1));
        harness.compact(hex"");
        vm.expectRevert(abi.encodeWithSelector(Scale.Truncated.selector, 1, 1));
        harness.compact(hex"01");
        vm.expectRevert(abi.encodeWithSelector(Scale.Truncated.selector, 0, 4));
        harness.compact(hex"020000");
        vm.expectRevert(abi.encodeWithSelector(Scale.Truncated.selector, 1, 4));
        harness.compact(hex"03ffffff");
        vm.expectRevert(abi.encodeWithSelector(Scale.Truncated.selector, 1, 5));
        harness.compact(hex"07ffffffff");
    }

    function test_rejectsTrailingBytes() public {
        vm.expectRevert(abi.encodeWithSelector(Scale.TrailingBytes.selector, 1, 1));
        harness.compact(hex"0000");
        vm.expectRevert(abi.encodeWithSelector(Scale.TrailingBytes.selector, 2, 2));
        harness.compact(hex"01010000");
    }

    // ---------------------------------------------------------------- fuzz

    /// Every value decodes back from its shortest encoding.
    function testFuzz_roundTrip(uint256 v) public view {
        _check(_compact(v), v);
    }

    function testFuzz_roundTripSmall(uint32 v) public view {
        _check(_compact(v), v);
        assertEq(harness.compactU32(_compact(v)), v);
    }

    /// Any input the decoder accepts is the shortest encoding of the value it returns, so
    /// each value has exactly one accepted encoding.
    function testFuzz_acceptsOnlyCanonical(bytes calldata data) public view {
        try harness.compactPrefix(data) returns (uint256 v, uint256 used) {
            assertEq(data[:used], _compact(v), "accepted encoding is the canonical one");
        } catch (bytes memory reason) {
            bytes4 sel = bytes4(reason);
            assertTrue(
                sel == Scale.Truncated.selector || sel == Scale.NonCanonicalCompact.selector
                    || sel == Scale.CompactOverflow.selector,
                "only the named errors"
            );
        }
    }

    function _check(bytes memory encoded, uint256 v) internal view {
        assertEq(harness.compact(encoded), v);
        assertEq(_compact(v), encoded, "reference encoder agrees");
    }
}
