// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {console} from "forge-std/Test.sol";
import {Scale} from "../../src/grandpa/Scale.sol";
import {Justification} from "../../src/grandpa/Justification.sol";
import {GrandpaPayload} from "../bench/BenchFixtures.sol";
import {SclEd25519Bench} from "../bench/Ed25519Bench.t.sol";
import {UnitFixtures} from "./UnitFixtures.sol";

contract JustificationTest is UnitFixtures {
    SclEd25519Bench internal scl;

    function setUp() public override {
        super.setUp();
        scl = new SclEd25519Bench();
    }

    function _files() internal pure returns (string[3] memory) {
        return ["finality-proof-head", "set-change", "stored-justification-512"];
    }

    // ---------------------------------------------------------------- captured justifications

    /// Each captured justification decodes to its fixture round, target and 7 precommits.
    function test_fixtureJustifications() public view {
        string[2] memory dirs = _dirs();
        string[3] memory files = _files();
        for (uint256 d = 0; d < dirs.length; d++) {
            for (uint256 f = 0; f < files.length; f++) {
                string memory json = _json(dirs[d], files[f]);
                (Justification.Decoded memory j,) =
                    harness.justification(vm.parseJsonBytes(json, ".justification.scale"));
                _checkJustification(json, j);
            }
        }
    }

    /// The finality proof wraps the same justification, for the block it names.
    function test_fixtureFinalityProofs() public view {
        string[2] memory dirs = _dirs();
        for (uint256 d = 0; d < dirs.length; d++) {
            string memory json = _json(dirs[d], "finality-proof-head");
            (Justification.FinalityProof memory p,) =
                harness.finalityProof(vm.parseJsonBytes(json, ".finalityProof.scale"));
            assertEq(p.blockHash, vm.parseJsonBytes32(json, ".finalityProof.block"), "proof block");
            assertEq(p.blockHash, p.justification.targetHash, "proof block is the commit target");
            _checkJustification(json, p.justification);
        }
    }

    /// The payload built from the decoded justification equals the one built from the
    /// fixture fields, and precommit 0's signature verifies over it with SCL, against an
    /// extended key derived on chain from the decoded authority id.
    function test_payloadAndSignature() public {
        string[2] memory dirs = _dirs();
        string[3] memory files = _files();
        for (uint256 d = 0; d < dirs.length; d++) {
            for (uint256 f = 0; f < files.length; f++) {
                string memory json = _json(dirs[d], files[f]);
                (Justification.Decoded memory j,) =
                    harness.justification(vm.parseJsonBytes(json, ".justification.scale"));
                uint64 setId = uint64(vm.parseJsonUint(json, ".signingSet.setId"));
                Justification.Precommit memory pc = j.precommits[0];

                bytes memory payload = Justification.signedPayload(pc.targetHash, pc.targetNumber, j.round, setId);
                bytes memory expected = GrandpaPayload.precommit(
                    vm.parseJsonBytes32(json, ".justification.precommits[0].targetHash"),
                    uint32(vm.parseJsonUint(json, ".justification.precommits[0].targetNumber")),
                    uint64(vm.parseJsonUint(json, ".justification.round")),
                    setId
                );
                assertEq(payload.length, 53, "53 bytes");
                assertEq(payload, expected, "fixture payload");

                (uint256[5] memory ext,) = scl.expandKey(pc.authorityId);
                (bool ok,) = scl.verify(ext, pc.r, pc.s, payload);
                assertTrue(ok, "precommit 0 verifies");
                (bool wrongSet,) = scl.verify(
                    ext, pc.r, pc.s, Justification.signedPayload(pc.targetHash, pc.targetNumber, j.round, setId + 1)
                );
                assertFalse(wrongSet, "not under another set id");
            }
        }
    }

    function test_signedPayloadLayout() public pure {
        bytes memory p = Justification.signedPayload(bytes32(uint256(0xaa)), 0x01020304, 0x1122334455667788, 7);
        assertEq(
            p,
            abi.encodePacked(
                hex"01", bytes32(uint256(0xaa)), hex"04030201", hex"8877665544332211", hex"0700000000000000"
            )
        );
    }

    function test_gas_headJustification() public view {
        string[2] memory dirs = _dirs();
        for (uint256 d = 0; d < dirs.length; d++) {
            string memory json = _json(dirs[d], "finality-proof-head");
            bytes memory just = vm.parseJsonBytes(json, ".justification.scale");
            bytes memory proof = vm.parseJsonBytes(json, ".finalityProof.scale");
            (, uint256 justGas) = harness.justification(just);
            (, uint256 proofGas) = harness.finalityProof(proof);
            console.log(dirs[d]);
            console.log("  decode head justification, 7 precommits (bytes):", just.length);
            console.log("    gas:", justGas);
            console.log("  decode head finality proof (bytes):", proof.length);
            console.log("    gas:", proofGas);
        }
    }

    // ---------------------------------------------------------------- rejects

    function test_rejectsVotesAncestries() public {
        bytes memory just = _headJustification();
        bytes memory header = vm.parseJsonBytes(_json(_dirs()[0], "finality-proof-head"), ".header.scale");
        // Replace the empty votes_ancestries (its last byte) with one real header.
        bytes memory withAncestry = bytes.concat(_cut(just, 1), _compact(1), header);
        vm.expectRevert(abi.encodeWithSelector(Justification.VotesAncestriesNotEmpty.selector, 1));
        harness.justification(withAncestry);
    }

    function test_rejectsUnknownHeaders() public {
        string memory json = _json(_dirs()[0], "finality-proof-head");
        bytes memory proof = vm.parseJsonBytes(json, ".finalityProof.scale");
        bytes memory header = vm.parseJsonBytes(json, ".header.scale");
        bytes memory withUnknown = bytes.concat(_cut(proof, 1), _compact(1), header);
        vm.expectRevert(abi.encodeWithSelector(Justification.UnknownHeadersNotEmpty.selector, 1));
        harness.finalityProof(withUnknown);
    }

    function test_rejectsTruncation() public {
        bytes memory just = _headJustification();
        for (uint256 cut = 1; cut <= just.length; cut++) {
            vm.expectPartialRevert(Scale.Truncated.selector);
            harness.justification(_cut(just, cut));
        }
        vm.expectRevert(abi.encodeWithSelector(Scale.Truncated.selector, just.length - 1, 1));
        harness.justification(_cut(just, 1));
    }

    function test_rejectsTrailingBytes() public {
        bytes memory just = _headJustification();
        vm.expectRevert(abi.encodeWithSelector(Scale.TrailingBytes.selector, just.length, 1));
        harness.justification(bytes.concat(just, hex"00"));

        // A trailing byte inside the finality proof's length-prefixed justification.
        bytes memory proof = bytes.concat(bytes32(0), _compact(just.length + 1), just, hex"00", _compact(0));
        vm.expectRevert(abi.encodeWithSelector(Scale.TrailingBytes.selector, 32 + 2 + just.length, 1));
        harness.finalityProof(proof);

        // A trailing byte after the whole finality proof.
        proof = bytes.concat(bytes32(0), _compact(just.length), just, _compact(0), hex"00");
        vm.expectPartialRevert(Scale.TrailingBytes.selector);
        harness.finalityProof(proof);
    }

    /// A precommit count larger than the bytes left can hold is rejected before allocating.
    function test_rejectsOversizedPrecommitCount() public {
        bytes memory just = _headJustification();
        assertEq(uint8(just[44]), 7 << 2, "precommit count byte");
        just[44] = bytes1(uint8(8 << 2));
        vm.expectRevert(abi.encodeWithSelector(Scale.Truncated.selector, 45, 8 * 132));
        harness.justification(just);
    }

    // ---------------------------------------------------------------- helpers

    function _checkJustification(string memory json, Justification.Decoded memory j) internal view {
        assertEq(j.round, vm.parseJsonUint(json, ".justification.round"), "round");
        assertEq(j.targetHash, vm.parseJsonBytes32(json, ".justification.targetHash"), "target hash");
        assertEq(j.targetNumber, vm.parseJsonUint(json, ".justification.targetNumber"), "target number");
        assertEq(j.precommits.length, 7, "7 precommits");
        assertEq(j.precommits.length, _count(json, ".justification.precommits"), "fixture precommits");
        for (uint256 i = 0; i < j.precommits.length; i++) {
            Justification.Precommit memory pc = j.precommits[i];
            string memory at = string.concat(".justification.precommits[", vm.toString(i), "]");
            assertEq(pc.targetHash, vm.parseJsonBytes32(json, string.concat(at, ".targetHash")), "precommit target");
            assertEq(pc.targetNumber, vm.parseJsonUint(json, string.concat(at, ".targetNumber")), "precommit number");
            assertEq(
                abi.encodePacked(pc.r, pc.s), vm.parseJsonBytes(json, string.concat(at, ".signature")), "signature"
            );
            assertEq(pc.authorityId, vm.parseJsonBytes32(json, string.concat(at, ".authorityId")), "authority id");
        }
    }

    function _headJustification() internal view returns (bytes memory) {
        return vm.parseJsonBytes(_json(_dirs()[0], "finality-proof-head"), ".justification.scale");
    }
}
