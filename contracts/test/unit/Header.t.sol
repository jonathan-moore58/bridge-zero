// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {console} from "forge-std/Test.sol";
import {Scale} from "../../src/grandpa/Scale.sol";
import {Header} from "../../src/grandpa/Header.sol";
import {UnitFixtures} from "./UnitFixtures.sol";

contract HeaderTest is UnitFixtures {
    /// Offset of the first digest item in a header whose number takes four bytes:
    /// parent hash 32, number 4, state root 32, extrinsics root 32, digest count 1.
    uint256 internal constant FIRST_ITEM = 101;

    // ---------------------------------------------------------------- captured headers

    /// Every captured header decodes to its fixture fields and hashes to its block hash.
    function test_fixtureHeaders() public view {
        string[2] memory dirs = _dirs();
        for (uint256 d = 0; d < dirs.length; d++) {
            _checkHeader(_json(dirs[d], "finality-proof-head"), ".header", 0);
            _checkHeader(_json(dirs[d], "set-change"), ".header", 1);
            _checkHeader(_json(dirs[d], "set-change"), ".parentHeader", 0);
            _checkHeader(_json(dirs[d], "stored-justification-512"), ".header", 0);
        }
    }

    /// The set-change header's FRNK log is a ScheduledChange to the authority set captured
    /// in the same snapshot: 10 keys of weight 1, delay 0.
    function test_setChangeScheduledChange() public view {
        string[2] memory dirs = _dirs();
        for (uint256 d = 0; d < dirs.length; d++) {
            _checkScheduledChange(_json(dirs[d], "set-change"), _json(dirs[d], "authority-set"));
        }
    }

    function _checkScheduledChange(string memory json, string memory set) internal view {
        {
            assertEq(vm.parseJsonUint(json, ".newSetId"), vm.parseJsonUint(set, ".authoritySet.setId"), "same set");

            (Header.Decoded memory h,) = harness.header(vm.parseJsonBytes(json, ".header.scale"));
            assertEq(h.grandpaLogs.length, 1, "one FRNK log");
            Header.GrandpaLog memory log = h.grandpaLogs[0];
            assertEq(log.kind, Header.SCHEDULED_CHANGE, "ScheduledChange");
            assertEq(log.delay, 0, "delay");
            assertEq(log.delay, vm.parseJsonUint(json, ".scheduledChange.delay"), "fixture delay");
            assertEq(log.nextAuthorities.length, 10, "10 authorities");
            assertEq(_count(set, ".authoritySet.authorities"), 10, "fixture set size");
            for (uint256 i = 0; i < 10; i++) {
                assertEq(log.nextAuthorities[i].weight, 1, "weight 1");
                assertEq(
                    log.nextAuthorities[i].key,
                    vm.parseJsonBytes32(set, _at(".authoritySet.authorities", i, ".id")),
                    "authority set"
                );
                assertEq(
                    log.nextAuthorities[i].key,
                    vm.parseJsonBytes32(json, _at(".scheduledChange.nextAuthorities", i, ".id")),
                    "fixture log"
                );
            }
        }
    }

    function test_gas_headHeader() public view {
        string[2] memory dirs = _dirs();
        for (uint256 d = 0; d < dirs.length; d++) {
            bytes memory head = vm.parseJsonBytes(_json(dirs[d], "finality-proof-head"), ".header.scale");
            bytes memory change = vm.parseJsonBytes(_json(dirs[d], "set-change"), ".header.scale");
            (, uint256 headGas) = harness.header(head);
            (, uint256 changeGas) = harness.header(change);
            console.log(dirs[d]);
            console.log("  decode + hash, head header (bytes):", head.length);
            console.log("    gas:", headGas);
            console.log("  decode + hash, set-change header with 10-key ScheduledChange (bytes):", change.length);
            console.log("    gas:", changeGas);
        }
    }

    // ---------------------------------------------------------------- digest items

    /// DigestItem::Other carries a length-prefixed payload. Here that payload is itself a
    /// well-formed FRNK consensus item, so a decoder that does not skip it by its length
    /// would report a Pause that is not in the header.
    function test_digestOther() public view {
        bytes memory hidden = _item(4, "FRNK", abi.encodePacked(uint8(4), _le32(9))); // Pause(9)
        bytes memory digest = bytes.concat(
            _compact(4),
            abi.encodePacked(uint8(0), _compact(hidden.length), hidden), // Other
            hex"08", // RuntimeEnvironmentUpdated
            _item(4, "FRNK", abi.encodePacked(uint8(5), _le32(7))), // Resume(7)
            _item(5, "BABE", new bytes(64)) // Seal
        );
        bytes memory encoded = _synthetic(70_000, digest);

        (Header.Decoded memory h,) = harness.header(encoded);
        assertEq(h.parentHash, keccak256("parent"), "parent");
        assertEq(h.number, 70_000, "number");
        assertEq(h.stateRoot, keccak256("state"), "state root");
        assertEq(h.extrinsicsRoot, keccak256("extrinsics"), "extrinsics root");
        assertEq(h.digestItems, 4, "four items");
        assertEq(h.grandpaLogs.length, 1, "only the Consensus item is a GRANDPA log");
        assertEq(h.grandpaLogs[0].kind, Header.RESUME, "Resume");
        assertEq(h.grandpaLogs[0].delay, 7, "delay");
        assertEq(h.hash, Header.hash(encoded), "hash of the exact bytes");
    }

    /// ForcedChange, OnDisabled and Pause, and FRNK items that are not Consensus items
    /// (ignored), in one digest. A Consensus item of another engine is ignored too.
    function test_grandpaLogVariants() public view {
        bytes32 k0 = keccak256("k0");
        bytes32 k1 = keccak256("k1");
        bytes memory forced = bytes.concat(
            abi.encodePacked(uint8(2), _le32(123_456), _compact(2)),
            abi.encodePacked(k0, _le64(1), k1, _le64(3)),
            _le32(10)
        );
        bytes memory logs = bytes.concat(
            _item(4, "FRNK", forced),
            _item(4, "FRNK", abi.encodePacked(uint8(3), _le64(0x0102030405060708))), // OnDisabled
            _item(4, "FRNK", abi.encodePacked(uint8(4), _le32(42))) // Pause(42)
        );
        bytes memory digest = bytes.concat(
            _compact(6),
            logs,
            _item(6, "FRNK", hex"ff"), // PreRuntime: not a log
            _item(5, "FRNK", hex"ff"), // Seal: not a log
            _item(4, "BABE", hex"ff") // another engine
        );
        (Header.Decoded memory h,) = harness.header(_synthetic(1, digest));
        assertEq(h.digestItems, 6);
        assertEq(h.grandpaLogs.length, 3);

        Header.GrandpaLog memory f = h.grandpaLogs[0];
        assertEq(f.kind, Header.FORCED_CHANGE);
        assertEq(f.median, 123_456);
        assertEq(f.delay, 10);
        assertEq(f.nextAuthorities.length, 2);
        assertEq(f.nextAuthorities[0].key, k0);
        assertEq(f.nextAuthorities[0].weight, 1);
        assertEq(f.nextAuthorities[1].key, k1);
        assertEq(f.nextAuthorities[1].weight, 3);

        assertEq(h.grandpaLogs[1].kind, Header.ON_DISABLED);
        assertEq(h.grandpaLogs[1].disabledIndex, 0x0102030405060708);
        assertEq(h.grandpaLogs[2].kind, Header.PAUSE);
        assertEq(h.grandpaLogs[2].delay, 42);
    }

    // ---------------------------------------------------------------- rejects

    /// Every strict prefix of a real header is truncated.
    function test_rejectsTruncation() public {
        bytes memory head = _headHeader();
        for (uint256 cut = 1; cut <= head.length; cut++) {
            vm.expectPartialRevert(Scale.Truncated.selector);
            harness.header(_cut(head, cut));
        }
        // Without its last byte, the BABE seal's 64-byte payload is one byte short; the error
        // names the offset of its two-byte length prefix.
        vm.expectRevert(abi.encodeWithSelector(Scale.Truncated.selector, head.length - 64 - 2, 64));
        harness.header(_cut(head, 1));
    }

    function test_rejectsTrailingBytes() public {
        bytes memory head = _headHeader();
        vm.expectRevert(abi.encodeWithSelector(Scale.TrailingBytes.selector, head.length, 1));
        harness.header(bytes.concat(head, hex"00"));
    }

    /// Tags other than 0, 4, 5, 6 and 8 are rejected, including the retired
    /// ChangesTrieRoot (2) and ChangesTrieSignal (7).
    function test_rejectsUnknownDigestKind() public {
        bytes memory head = _headHeader();
        assertEq(uint8(head[FIRST_ITEM]), Header.DIGEST_PRE_RUNTIME, "first item is the BABE pre-digest");
        uint8[7] memory tags = [1, 2, 3, 7, 9, 0x80, 0xff];
        for (uint256 i = 0; i < tags.length; i++) {
            head[FIRST_ITEM] = bytes1(tags[i]);
            vm.expectRevert(abi.encodeWithSelector(Header.UnknownDigestItem.selector, tags[i], FIRST_ITEM));
            harness.header(head);
        }
    }

    function test_rejectsUnknownGrandpaLog() public {
        bytes memory digest = bytes.concat(_compact(1), _item(4, "FRNK", hex"06"));
        vm.expectRevert(abi.encodeWithSelector(Header.UnknownGrandpaLog.selector, 6, FIRST_ITEM + 6));
        harness.header(_synthetic(1 << 14, digest));
    }

    /// A FRNK log must fill its payload exactly, in both directions.
    function test_rejectsGrandpaLogLengthMismatch() public {
        bytes memory pause = abi.encodePacked(uint8(4), _le32(1), uint8(0));
        bytes memory digest = bytes.concat(_compact(1), _item(4, "FRNK", pause));
        vm.expectPartialRevert(Scale.TrailingBytes.selector);
        harness.header(_synthetic(1 << 14, digest));

        bytes memory scheduled = abi.encodePacked(uint8(1), _compact(1), keccak256("k"), _le64(1)); // no delay
        digest = bytes.concat(_compact(1), _item(4, "FRNK", scheduled));
        vm.expectPartialRevert(Scale.Truncated.selector);
        harness.header(_synthetic(1 << 14, digest));
    }

    function test_rejectsBlockNumberAboveU32() public {
        bytes memory encoded = abi.encodePacked(
            keccak256("parent"), _compact(1 << 32), keccak256("state"), keccak256("extrinsics"), _compact(0)
        );
        vm.expectRevert(abi.encodeWithSelector(Scale.CompactOverflow.selector, 32));
        harness.header(encoded);
    }

    function test_rejectsNonCanonicalBlockNumber() public {
        bytes memory encoded =
            abi.encodePacked(keccak256("parent"), hex"0100", keccak256("state"), keccak256("extrinsics"), _compact(0));
        vm.expectRevert(abi.encodeWithSelector(Scale.NonCanonicalCompact.selector, 32));
        harness.header(encoded);
    }

    // ---------------------------------------------------------------- helpers

    function _checkHeader(string memory json, string memory path, uint256 frnkLogs) internal view {
        (Header.Decoded memory h,) = harness.header(vm.parseJsonBytes(json, string.concat(path, ".scale")));
        assertEq(h.hash, vm.parseJsonBytes32(json, string.concat(path, ".hash")), "block hash");
        assertEq(h.number, vm.parseJsonUint(json, string.concat(path, ".number")), "number");
        assertEq(h.parentHash, vm.parseJsonBytes32(json, string.concat(path, ".parentHash")), "parent hash");
        assertEq(h.stateRoot, vm.parseJsonBytes32(json, string.concat(path, ".stateRoot")), "state root");
        assertEq(h.extrinsicsRoot, vm.parseJsonBytes32(json, string.concat(path, ".extrinsicsRoot")), "extrinsics root");
        assertEq(h.digestItems, _count(json, string.concat(path, ".digest")), "digest items");
        assertEq(h.grandpaLogs.length, frnkLogs, "FRNK logs");
    }

    function _headHeader() internal view returns (bytes memory) {
        return vm.parseJsonBytes(_json(_dirs()[0], "finality-proof-head"), ".header.scale");
    }

    /// A digest item with an engine id: tag ‖ engine ‖ Compact(len) ‖ payload.
    function _item(uint8 tag, bytes4 engine, bytes memory payload) internal pure returns (bytes memory) {
        return abi.encodePacked(tag, engine, _compact(payload.length), payload);
    }

    /// A header with fixed roots, the given number and an already encoded digest.
    function _synthetic(uint32 number, bytes memory digest) internal pure returns (bytes memory) {
        return
            abi.encodePacked(keccak256("parent"), _compact(number), keccak256("state"), keccak256("extrinsics"), digest);
    }
}
