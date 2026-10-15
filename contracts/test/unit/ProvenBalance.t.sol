// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {console, Vm} from "forge-std/Test.sol";
import {GrandpaLightClient} from "../../src/grandpa/GrandpaLightClient.sol";
import {Header} from "../../src/grandpa/Header.sol";
import {ProvenBalance, IGrandpaImporter} from "../../src/kit/ProvenBalance.sol";
import {UnitFixtures} from "./UnitFixtures.sol";

/// ProvenBalance end to end on one captured mainnet snapshot: the light client starts at the
/// set-change checkpoint and imports the set change; importAndProve then imports the head
/// (7 of 10) and proves the sudo account's System.Account at it.
abstract contract ProvenBalanceSnapshotTest is UnitFixtures {
    /// EIP-7825 transaction gas limit cap (Osaka; live on Sepolia).
    uint256 internal constant TX_GAS_CAP = 16_777_216;

    GrandpaLightClient internal lc;
    ProvenBalance internal pb;

    bytes internal header; // head
    bytes32 internal headHash;
    uint32 internal headNumber;
    bytes internal finalityProof;
    bytes internal justification; // inside finalityProof at jOffset
    uint256 internal jOffset;
    bytes internal signers;
    uint256[] internal pos;
    uint256[] internal idx;

    bytes32 internal accountId;
    bytes[] internal nodes;
    ProvenBalance.AccountInfo internal expected;

    function _dir() internal pure virtual returns (string memory);

    function setUp() public override {
        super.setUp();
        string memory dir = _dir();
        string memory sc = _json(dir, "set-change");
        string memory fp = _json(dir, "finality-proof-head");
        string memory ap = _json(dir, "account-proof");

        lc = new GrandpaLightClient();
        bytes32[] memory keys = _keys(sc, ".signingSet.authorities");
        lc.initialize(
            vm.parseJsonBytes32(sc, ".provenance.genesisHash"),
            uint64(vm.parseJsonUint(sc, ".signingSet.setId")),
            keys,
            vm.parseJsonBytes(sc, ".parentHeader.scale")
        );
        (bytes memory changeSigners,,) = _signers(sc);
        lc.importHeader(
            vm.parseJsonBytes(sc, ".header.scale"), vm.parseJsonBytes(sc, ".justification.scale"), changeSigners
        );
        assertEq(lc.currentSetId(), uint64(vm.parseJsonUint(sc, ".newSetId")), "set change enacted");

        pb = new ProvenBalance(IGrandpaImporter(address(lc)));

        header = vm.parseJsonBytes(fp, ".header.scale");
        headHash = vm.parseJsonBytes32(fp, ".header.hash");
        headNumber = uint32(vm.parseJsonUint(fp, ".header.number"));
        finalityProof = vm.parseJsonBytes(fp, ".finalityProof.scale");
        justification = vm.parseJsonBytes(fp, ".justification.scale");
        (signers, pos, idx) = _signers(fp);
        assertEq(signers.length, 14, "7 signers");
        // FinalityProof = block hash, then the justification as Vec<u8>, then unknown headers.
        jOffset = 32 + _compact(justification.length).length;
        for (uint256 i = 0; i < justification.length; i++) {
            assertEq(finalityProof[jOffset + i], justification[i]);
        }
        assertEq(uint8(justification[44]), 7 << 2, "one-byte compact precommit count");

        assertEq(vm.parseJsonBytes32(ap, ".header.hash"), headHash, "the account proof is at the head");
        accountId = vm.parseJsonBytes32(ap, ".account.id");
        bytes[] memory list = vm.parseJsonBytesArray(ap, ".proof.nodes");
        for (uint256 i = 0; i < list.length; i++) {
            nodes.push(list[i]);
        }
        expected = ProvenBalance.AccountInfo({
            nonce: uint32(vm.parseJsonUint(ap, ".value.decoded.nonce")),
            consumers: uint32(vm.parseJsonUint(ap, ".value.decoded.consumers")),
            providers: uint32(vm.parseJsonUint(ap, ".value.decoded.providers")),
            sufficients: uint32(vm.parseJsonUint(ap, ".value.decoded.sufficients")),
            free: uint128(vm.parseUint(vm.parseJsonString(ap, ".value.decoded.free"))),
            reserved: uint128(vm.parseUint(vm.parseJsonString(ap, ".value.decoded.reserved"))),
            miscFrozen: uint128(vm.parseUint(vm.parseJsonString(ap, ".value.decoded.miscFrozen"))),
            feeFrozen: uint128(vm.parseUint(vm.parseJsonString(ap, ".value.decoded.feeFrozen")))
        });
        assertGt(expected.free, 0);
    }

    // ------------------------------------------------------------------ happy path

    function test_importAndProve() public {
        assertFalse(lc.isImported(headHash));
        vm.expectEmit(address(pb));
        emit ProvenBalance.BalanceProven(headHash, headNumber, accountId, expected.free);
        (bytes memory ret, uint256 txGas) =
            _send(_label("importAndProve, 7 of 10 + System.Account"), _call(header, finalityProof, nodes));
        (bytes32 h, uint32 n, ProvenBalance.AccountInfo memory info) =
            abi.decode(ret, (bytes32, uint32, ProvenBalance.AccountInfo));
        assertEq(h, headHash);
        assertEq(n, headNumber);
        _assertInfo(info);
        assertTrue(lc.isImported(headHash), "the head is imported by the same call");
        (bytes32 latest,) = lc.latestFinalized();
        assertEq(latest, headHash);
        console.log("  share of the 16,777,216 cap, in basis points:", txGas * 10_000 / TX_GAS_CAP);
    }

    function test_again_reverifiesWithoutWrites() public {
        (, uint256 first) = _send(_label("importAndProve (first)"), _call(header, finalityProof, nodes));

        vm.record();
        vm.recordLogs();
        (, uint256 again) = _send(_label("importAndProve again (no writes)"), _call(header, finalityProof, nodes));
        (, bytes32[] memory lcWrites) = vm.accesses(address(lc));
        (, bytes32[] memory pbWrites) = vm.accesses(address(pb));
        assertEq(lcWrites.length, 0, "the light client writes nothing on a re-import");
        assertEq(pbWrites.length, 0, "ProvenBalance keeps no state");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "only BalanceProven");
        assertEq(logs[0].emitter, address(pb));
        assertEq(logs[0].topics[0], ProvenBalance.BalanceProven.selector);
        assertLt(again, first, "re-verification costs less than the import");
    }

    function test_prove_view() public {
        _send(_label("importAndProve"), _call(header, finalityProof, nodes));
        (uint32 n, ProvenBalance.AccountInfo memory info) = pb.prove(headHash, accountId, nodes);
        assertEq(n, headNumber);
        _assertInfo(info);

        bytes32 unknown = keccak256("not imported");
        vm.expectRevert(abi.encodeWithSelector(GrandpaLightClient.UnknownBlock.selector, unknown));
        pb.prove(unknown, accountId, nodes);
    }

    // ------------------------------------------------------------------ tampering

    function test_tamperedHeader() public {
        bytes memory bad = _flip(header, 40); // inside the state root
        _expectFail(
            _call(bad, finalityProof, nodes),
            abi.encodeWithSelector(GrandpaLightClient.FinalityProofBlockMismatch.selector, headHash, Header.hash(bad))
        );
    }

    function test_tamperedSignature() public {
        // R of the first counted precommit, then s of the third.
        uint256 at = jOffset + 45 + pos[0] * 132 + 36;
        _expectFail(
            _call(header, _flip(finalityProof, at), nodes),
            abi.encodeWithSelector(GrandpaLightClient.InvalidSignature.selector, 0, idx[0])
        );
        at = jOffset + 45 + pos[2] * 132 + 68;
        _expectFail(
            _call(header, _flip(finalityProof, at), nodes),
            abi.encodeWithSelector(GrandpaLightClient.InvalidSignature.selector, 2, idx[2])
        );
    }

    function test_tamperedProof() public {
        bytes memory incomplete = abi.encodeWithSignature("Error(string)", "Incomplete Proof!");
        for (uint256 i = 0; i < nodes.length; i++) {
            bytes[] memory bad = nodes;
            bad[i] = _flip(nodes[i], nodes[i].length / 2);
            _expectFail(_call(header, finalityProof, bad), incomplete);
        }
        assertFalse(lc.isImported(headHash), "a failed proof undoes the import");
    }

    function test_otherAccountFails() public {
        bytes memory data = abi.encodeCall(
            ProvenBalance.importAndProve, (header, finalityProof, signers, accountId ^ bytes32(uint256(1)), nodes)
        );
        (bool ok,) = address(pb).call{gas: TX_GAS_CAP}(data);
        assertFalse(ok, "the proof does not prove another account");
    }

    // ------------------------------------------------------------------ helpers

    function _assertInfo(ProvenBalance.AccountInfo memory info) internal view {
        assertEq(info.nonce, expected.nonce, "nonce");
        assertEq(info.consumers, expected.consumers, "consumers");
        assertEq(info.providers, expected.providers, "providers");
        assertEq(info.sufficients, expected.sufficients, "sufficients");
        assertEq(info.free, expected.free, "free");
        assertEq(info.reserved, expected.reserved, "reserved");
        assertEq(info.miscFrozen, expected.miscFrozen, "miscFrozen");
        assertEq(info.feeFrozen, expected.feeFrozen, "feeFrozen");
    }

    function _call(bytes memory h, bytes memory proof, bytes[] memory proofNodes) internal view returns (bytes memory) {
        return abi.encodeCall(ProvenBalance.importAndProve, (h, proof, signers, accountId, proofNodes));
    }

    /// Sends `data` to ProvenBalance as its own transaction with the per-transaction cap as gas
    /// limit; requires success.
    function _send(string memory label, bytes memory data) internal returns (bytes memory ret, uint256 txGas) {
        assertTrue(vm.isIsolateMode(), "run with isolate, so each call is measured as a transaction");
        bool ok;
        (ok, ret) = address(pb).call{gas: TX_GAS_CAP}(data);
        txGas = vm.lastFrameGas().gasTotalUsed;
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        assertLe(txGas, TX_GAS_CAP, "within the EIP-7825 cap");
        console.log(string.concat(label, ", transaction gas:"), txGas);
    }

    function _expectFail(bytes memory data, bytes memory reason) internal {
        vm.expectRevert(reason);
        (bool ok,) = address(pb).call{gas: TX_GAS_CAP}(data);
        ok;
    }

    function _label(string memory what) internal pure returns (string memory) {
        return string.concat(_dir(), ": ", what);
    }

    function _flip(bytes memory data, uint256 at) internal pure returns (bytes memory out) {
        out = bytes.concat(data);
        out[at] = out[at] ^ 0x01;
    }

    function _keys(string memory json, string memory path) internal view returns (bytes32[] memory keys) {
        keys = new bytes32[](_count(json, path));
        for (uint256 i = 0; i < keys.length; i++) {
            keys[i] = vm.parseJsonBytes32(json, _at(path, i, ".id"));
        }
    }

    /// The signers hint (2 bytes per precommit: position, authority index; sorted by index).
    function _signers(string memory json)
        internal
        view
        returns (bytes memory out, uint256[] memory p, uint256[] memory a)
    {
        string memory path = ".justification.precommits";
        uint256 count = _count(json, path);
        p = new uint256[](count);
        a = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            p[i] = i;
            a[i] = vm.parseJsonUint(json, _at(path, i, ".authorityIndex"));
        }
        for (uint256 i = 1; i < count; i++) {
            for (uint256 k = i; k > 0 && a[k - 1] > a[k]; k--) {
                (a[k - 1], a[k]) = (a[k], a[k - 1]);
                (p[k - 1], p[k]) = (p[k], p[k - 1]);
            }
        }
        out = new bytes(2 * count);
        for (uint256 i = 0; i < count; i++) {
            out[2 * i] = bytes1(uint8(p[i]));
            out[2 * i + 1] = bytes1(uint8(a[i]));
        }
    }
}

contract ProvenBalanceMainnetTest is ProvenBalanceSnapshotTest {
    function _dir() internal pure override returns (string memory) {
        return "../fixtures/mainnet";
    }
}

contract ProvenBalanceMainnetPreV3Test is ProvenBalanceSnapshotTest {
    function _dir() internal pure override returns (string memory) {
        return "../fixtures/mainnet-pre-v3";
    }
}

contract ProvenBalanceUnitTest is UnitFixtures {
    function test_constructor_rejectsZero() public {
        vm.expectRevert(ProvenBalance.ZeroLightClient.selector);
        new ProvenBalance(IGrandpaImporter(address(0)));
    }

    function test_decodeAccountInfo() public {
        ProvenBalance pb = new ProvenBalance(IGrandpaImporter(address(1)));
        bytes memory v = abi.encodePacked(
            hex"0100000002000000030000000400000005000000000000000000000000000001",
            hex"0600000000000000000000000000000007000000000000000000000000000000",
            hex"08000000000000000000000000000080"
        );
        ProvenBalance.AccountInfo memory info = pb.decodeAccountInfo(v);
        assertEq(info.nonce, 1);
        assertEq(info.consumers, 2);
        assertEq(info.providers, 3);
        assertEq(info.sufficients, 4);
        assertEq(info.free, (uint128(1) << 120) | 5, "little-endian u128");
        assertEq(info.reserved, 6);
        assertEq(info.miscFrozen, 7);
        assertEq(info.feeFrozen, (uint128(0x80) << 120) | 8);

        vm.expectRevert(abi.encodeWithSelector(ProvenBalance.AccountInfoLength.selector, 79));
        pb.decodeAccountInfo(_cut(v, 1));
        vm.expectRevert(abi.encodeWithSelector(ProvenBalance.AccountInfoLength.selector, 0));
        pb.decodeAccountInfo("");
    }
}
