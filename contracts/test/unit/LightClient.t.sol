// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {console, Vm} from "forge-std/Test.sol";
import {SCL_EIP6565} from "crypto-lib/lib/libSCL_EIP6565.sol";
import {SCL_sha512} from "crypto-lib/hash/SCL_sha512.sol";
import {n as N25519} from "crypto-lib/fields/SCL_wei25519.sol";
import {GrandpaLightClient} from "../../src/grandpa/GrandpaLightClient.sol";
import {Header} from "../../src/grandpa/Header.sol";
import {Justification} from "../../src/grandpa/Justification.sol";
import {UnitFixtures} from "./UnitFixtures.sol";

/// Helpers shared by the snapshot and synthetic light-client tests.
abstract contract LightClientBase is UnitFixtures {
    /// EIP-7825 transaction gas limit cap (Osaka; live on Sepolia).
    uint256 internal constant TX_GAS_CAP = 16_777_216;

    GrandpaLightClient internal lc;

    function setUp() public virtual override {
        super.setUp();
        lc = new GrandpaLightClient();
    }

    /// Sends `data` to the client as its own transaction (isolate mode) with the per-transaction
    /// cap as gas limit; requires success and returns the transaction's gas.
    function _send(string memory label, bytes memory data) internal returns (uint256 txGas) {
        assertTrue(vm.isIsolateMode(), "run with isolate, so each call is measured as a transaction");
        (bool ok, bytes memory ret) = address(lc).call{gas: TX_GAS_CAP}(data);
        txGas = vm.lastFrameGas().gasTotalUsed;
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        assertLe(txGas, TX_GAS_CAP, "within the EIP-7825 cap");
        console.log(string.concat(label, ", transaction gas:"), txGas);
    }

    /// Expects `data` to revert with exactly `reason`, sent with the per-transaction cap.
    function _expectFail(bytes memory data, bytes memory reason) internal {
        vm.expectRevert(reason);
        (bool ok,) = address(lc).call{gas: TX_GAS_CAP}(data);
        ok;
    }

    function _flip(bytes memory data, uint256 at) internal pure returns (bytes memory out) {
        out = bytes.concat(data);
        out[at] = out[at] ^ 0x01;
    }

    function _put32(bytes memory data, uint256 at, bytes32 word) internal pure returns (bytes memory out) {
        out = bytes.concat(data);
        for (uint256 i = 0; i < 32; i++) {
            out[at + i] = word[i];
        }
    }

    function _hash(bytes memory header) internal view returns (bytes32) {
        return Header.hash(header);
    }

    /// The 32-byte key that SCL's extended key `ext` stands for (point converted back and
    /// compressed), so stored points can be checked against their keys.
    function _keyOf(uint256[5] memory ext) internal view returns (bytes32) {
        (uint256 x, uint256 y) = SCL_EIP6565.WeierStrass2Edwards(ext[0], ext[1]);
        return bytes32(SCL_sha512.Swap256(SCL_EIP6565.edCompress([x, y])));
    }

    function _assertRoundTrip(uint64 setId, bytes32[] memory keys) internal view {
        for (uint256 i = 0; i < keys.length; i++) {
            uint256[5] memory ext = lc.extendedKey(setId, i);
            assertEq(bytes32(ext[4]), keys[i], "extended key carries the 32-byte key");
            assertEq(_keyOf(ext), keys[i], "derived point compresses back to the key");
        }
    }
}

/// One captured snapshot of Portaldot mainnet: a set change and three justified headers after it.
abstract contract LightClientSnapshotTest is LightClientBase {
    struct Signed {
        bytes header;
        bytes justification;
        bytes signers; // 2 bytes per precommit: position, authority index; sorted by index
        bytes32 hash;
        uint32 number;
        bytes32 stateRoot;
    }

    bytes32 internal genesis;
    uint64 internal oldSetId; // signs the set-change header
    uint64 internal newSetId; // enacted by it, signs the head and the stored justification
    bytes32[] internal oldKeys;
    bytes32[] internal newKeys; // authority-set.json at the head
    bytes internal checkpoint; // parent of the set-change header
    bytes32 internal checkpointHash;
    uint32 internal checkpointNumber;
    bytes internal headProof; // grandpa_proveFinality at the head
    Signed internal change;
    Signed internal head;
    Signed internal stored;

    /// Positions and authority indices of the head's precommits, sorted by authority index.
    uint256[] internal pos;
    uint256[] internal idx;

    function _dir() internal pure virtual returns (string memory);

    function setUp() public override {
        super.setUp();
        string memory dir = _dir();
        string memory sc = _json(dir, "set-change");
        string memory fp = _json(dir, "finality-proof-head");
        genesis = vm.parseJsonBytes32(sc, ".provenance.genesisHash");
        oldSetId = uint64(vm.parseJsonUint(sc, ".signingSet.setId"));
        newSetId = uint64(vm.parseJsonUint(sc, ".newSetId"));
        assertEq(newSetId, oldSetId + 1, "set change moves to the next set id");
        _keys(sc, ".signingSet.authorities", oldKeys);
        string memory as_ = _json(dir, "authority-set");
        assertEq(vm.parseJsonUint(as_, ".authoritySet.setId"), newSetId, "authority-set.json is the new set");
        _keys(as_, ".authoritySet.authorities", newKeys);
        checkpoint = vm.parseJsonBytes(sc, ".parentHeader.scale");
        checkpointHash = vm.parseJsonBytes32(sc, ".parentHeader.hash");
        checkpointNumber = uint32(vm.parseJsonUint(sc, ".parentHeader.number"));
        headProof = vm.parseJsonBytes(fp, ".finalityProof.scale");
        _signed(sc, change);
        _signed(fp, head);
        _signed(_json(dir, "stored-justification-512"), stored);

        (pos, idx) = _sorted(fp);
        assertEq(uint8(head.justification[44]), 7 << 2, "7 precommits, one-byte compact count");
    }

    // ------------------------------------------------------------------ happy path

    function test_initialize() public {
        uint256 g = _send(_label("initialize, 10 keys"), _initCall(oldSetId, oldKeys, checkpoint));
        assertTrue(lc.initialized());
        assertEq(lc.genesisHash(), genesis);
        assertEq(lc.currentSetId(), oldSetId);
        assertEq(lc.threshold(), 7);
        assertEq(lc.authorities(oldSetId), oldKeys);
        (bytes32 h, uint32 number) = lc.latestFinalized();
        assertEq(h, checkpointHash, "checkpoint is the latest finalized header");
        assertEq(number, checkpointNumber);
        assertEq(lc.headerOf(checkpointHash).setId, oldSetId);
        _assertRoundTrip(oldSetId, oldKeys);
        assertLt(g, 3_000_000);
    }

    function test_importSetChange_rotates() public {
        _init(oldSetId, oldKeys);
        vm.expectEmit(address(lc));
        emit GrandpaLightClient.AuthoritySetChanged(
            oldSetId, newSetId, keccak256(abi.encodePacked(newKeys)), newKeys.length, change.number
        );
        _send(_label("set-change import, 7 of 10"), _importCall(change));
        assertEq(lc.currentSetId(), newSetId, "rotated to the next set");
        assertEq(lc.authorities(newSetId), newKeys, "keys of the next set equal authority-set.json");
        assertEq(lc.authorities(oldSetId), oldKeys, "the old set stays readable");
        _assertRoundTrip(newSetId, newKeys);
        assertEq(lc.headerOf(change.hash).setId, oldSetId, "finalized by the outgoing set");
        assertEq(lc.headerOf(change.hash).stateRoot, change.stateRoot);
        assertFalse(lc.halted());
    }

    function test_importHeadAndStored() public {
        _init(oldSetId, oldKeys);
        _send(_label("set-change import"), _importCall(change));
        _send(_label("stored justification import, 7 of 10"), _importCall(stored));
        uint256 g =
            _send(_label("head finality proof import, 7 of 10"), _proofCall(head.header, headProof, head.signers));
        (bytes32 h, uint32 number) = lc.latestFinalized();
        assertEq(h, head.hash);
        assertEq(number, head.number);
        (bytes32 root, uint32 n) = lc.stateRootOf(head.hash);
        assertEq(root, head.stateRoot, "head state root");
        assertEq(n, head.number);
        (root,) = lc.stateRootOf(stored.hash);
        assertEq(root, stored.stateRoot, "stored-justification state root");
        assertEq(lc.headerOf(head.hash).setId, newSetId);
        assertLt(g, 7_000_000);
    }

    function test_reimport_writesNothing() public {
        _init(oldSetId, oldKeys);
        _send(_label("set-change import"), _importCall(change));
        uint256 first = _send(_label("head import (first)"), _proofCall(head.header, headProof, head.signers));
        uint256 sets = lc.authoritySetCount();

        vm.record();
        vm.recordLogs();
        uint256 again = _send(_label("head re-import (no writes)"), _proofCall(head.header, headProof, head.signers));
        (bytes32[] memory reads, bytes32[] memory writes) = vm.accesses(address(lc));
        assertGt(reads.length, 0, "storage access was recorded");
        assertEq(writes.length, 0, "a re-import writes no storage");
        assertEq(vm.getRecordedLogs().length, 0, "a re-import emits nothing");
        assertLt(again, first, "a re-import costs less than the import");

        // The justification form of the same proof is a re-import too.
        _send(_label("head re-import, justification form"), _importCall(head));
        // The set-change header is checked against the set that finalized it, and does not
        // rotate a second time.
        _send(_label("set-change re-import"), _importCall(change));
        assertEq(lc.currentSetId(), newSetId);
        assertEq(lc.authoritySetCount(), sets);
        (bytes32 h,) = lc.latestFinalized();
        assertEq(h, head.hash);
    }

    // ------------------------------------------------------------------ tampers

    /// Every tamper reverts with its own error before the head is imported, and again after a
    /// valid import of the same header (when the header is checked against its stored set).
    function test_tampers_beforeAndAfterImport() public {
        _init(oldSetId, oldKeys);
        _send(_label("set-change import"), _importCall(change));
        _headTampers();
        _send(_label("head import"), _proofCall(head.header, headProof, head.signers));
        assertTrue(lc.isImported(head.hash));
        _headTampers();
    }

    /// A justification verifies only under its own set id, and the client says which.
    function test_wrongSetId() public {
        _init(oldSetId + 1, oldKeys);
        _expectFail(
            _importCall(change), abi.encodeWithSelector(GrandpaLightClient.WrongSetId.selector, oldSetId + 1, oldSetId)
        );

        lc = new GrandpaLightClient();
        _init(oldSetId - 1, oldKeys);
        _expectFail(
            _importCall(change), abi.encodeWithSelector(GrandpaLightClient.WrongSetId.selector, oldSetId - 1, oldSetId)
        );

        // The head under a client checkpointed at the set-change header with a wrong set id.
        lc = new GrandpaLightClient();
        lc.initialize(genesis, newSetId + 1, newKeys, change.header);
        _expectFail(
            _proofCall(head.header, headProof, head.signers),
            abi.encodeWithSelector(GrandpaLightClient.WrongSetId.selector, newSetId + 1, newSetId)
        );
    }

    /// Without the set change, the head (signed by the next set id) does not verify.
    function test_skippedSetChange_stalls() public {
        _init(oldSetId, oldKeys);
        _expectFail(
            _proofCall(head.header, headProof, head.signers),
            abi.encodeWithSelector(GrandpaLightClient.WrongSetId.selector, oldSetId, newSetId)
        );
    }

    function test_notNewer() public {
        _init(oldSetId, oldKeys);
        _send(_label("set-change import"), _importCall(change));
        _send(_label("head import"), _proofCall(head.header, headProof, head.signers));
        _expectFail(
            _importCall(stored),
            abi.encodeWithSelector(GrandpaLightClient.NotNewer.selector, stored.number, head.number)
        );
    }

    // ------------------------------------------------------------------ admin

    function test_paused_rejects() public {
        _init(oldSetId, oldKeys);
        vm.prank(address(0xBEEF));
        vm.expectRevert(GrandpaLightClient.NotAdmin.selector);
        lc.pause("not the admin");

        vm.expectEmit(address(lc));
        emit GrandpaLightClient.Paused(address(this), "maintenance");
        lc.pause("maintenance");
        _expectFail(_importCall(change), abi.encodeWithSelector(GrandpaLightClient.ClientPaused.selector));
        lc.unpause();
        _send(_label("set-change import after unpause"), _importCall(change));
        lc.pause("again");
        // also a re-import of a known header
        _expectFail(_importCall(change), abi.encodeWithSelector(GrandpaLightClient.ClientPaused.selector));
    }

    function test_reinitialize_keepsHistory() public {
        _init(oldSetId, oldKeys);
        _send(_label("set-change import"), _importCall(change));
        _send(_label("stored import"), _importCall(stored));

        vm.expectRevert(GrandpaLightClient.NotHalted.selector);
        lc.reinitialize(genesis, newSetId, newKeys, head.header, "not halted");

        lc.pause("re-checkpoint at the head");
        vm.expectEmit(address(lc));
        emit GrandpaLightClient.Reinitialized(address(this), genesis, newSetId, head.number, head.hash, "test");
        lc.reinitialize(genesis, newSetId, newKeys, head.header, "test");
        assertFalse(lc.paused());
        assertEq(lc.authoritySetCount(), 3, "sets are appended, never replaced");
        assertTrue(lc.isImported(checkpointHash), "the old checkpoint is kept");
        assertTrue(lc.isImported(change.hash), "imported headers are kept");
        assertEq(lc.headerOf(change.hash).setId, oldSetId);
        assertEq(lc.authorities(oldSetId), oldKeys, "old authority lists stay readable");
        (bytes32 h,) = lc.latestFinalized();
        assertEq(h, head.hash);
        // Known headers still verify against the sets that finalized them.
        _send(_label("set-change re-import after reinitialize"), _importCall(change));
        _send(_label("stored re-import after reinitialize"), _importCall(stored));
    }

    // ------------------------------------------------------------------ helpers

    function _headTampers() internal {
        bytes memory j = head.justification;
        uint256 n = pos.length;
        bytes4 E = GrandpaLightClient.InvalidSignature.selector;

        // header byte flipped (inside the state root)
        bytes memory badHeader = _flip(head.header, 40);
        _expectFail(
            _importCall(badHeader, j, head.signers),
            abi.encodeWithSelector(GrandpaLightClient.HeaderHashMismatch.selector, head.hash, _hash(badHeader))
        );
        // signature byte flipped (R of the third counted precommit)
        _expectFail(
            _importCall(head.header, _flip(j, _pc(pos[2]) + 36), head.signers), abi.encodeWithSelector(E, 2, idx[2])
        );
        // signature byte flipped (s of the first counted precommit)
        _expectFail(
            _importCall(head.header, _flip(j, _pc(pos[0]) + 68), head.signers), abi.encodeWithSelector(E, 0, idx[0])
        );
        // wrong round
        _expectFail(_importCall(head.header, _flip(j, 0), head.signers), abi.encodeWithSelector(E, 0, idx[0]));
        // wrong commit target number
        _expectFail(
            _importCall(head.header, _flip(j, 40), head.signers),
            abi.encodeWithSelector(GrandpaLightClient.TargetNumberMismatch.selector, head.number ^ 1, head.number)
        );
        // a counted precommit on another block
        _expectFail(
            _importCall(head.header, _flip(j, _pc(pos[0])), head.signers),
            abi.encodeWithSelector(GrandpaLightClient.PrecommitNotOnTarget.selector, 0, pos[0])
        );
        // unknown signer: the precommit carries a key outside the set
        bytes32 stranger = keccak256("not an authority");
        _expectFail(
            _importCall(head.header, _put32(j, _pc(pos[1]) + 100, stranger), head.signers),
            abi.encodeWithSelector(GrandpaLightClient.UnknownSigner.selector, 1, idx[1], stranger)
        );
        // 6 of 10
        _expectFail(
            _importCall(head.header, j, _signers(n - 1, type(uint256).max, 0, 0)),
            abi.encodeWithSelector(GrandpaLightClient.BelowThreshold.selector, 6, 7)
        );
        // duplicate signer: entry 1 claims entry 0's authority
        _expectFail(
            _importCall(head.header, j, _signers(n, 1, pos[1], idx[0])),
            abi.encodeWithSelector(GrandpaLightClient.DuplicateSigner.selector, 1, idx[0])
        );
        // the same precommit counted twice
        _expectFail(
            _importCall(head.header, j, _signers(n, 1, pos[0], idx[1])),
            abi.encodeWithSelector(GrandpaLightClient.DuplicatePrecommit.selector, 1, pos[0])
        );
        // signers out of order
        bytes memory swapped = _signers(n, type(uint256).max, 0, 0);
        (swapped[0], swapped[1], swapped[2], swapped[3]) = (swapped[2], swapped[3], swapped[0], swapped[1]);
        _expectFail(
            _importCall(head.header, j, swapped),
            abi.encodeWithSelector(GrandpaLightClient.SignersOutOfOrder.selector, 1, idx[0], idx[1])
        );
        // authority index out of range (the last entry names authority 10 of 0..9)
        _expectFail(
            _importCall(head.header, j, _signers(n, n - 1, pos[n - 1], 10)),
            abi.encodeWithSelector(GrandpaLightClient.AuthorityIndexOutOfRange.selector, n - 1, 10, 10)
        );
        // precommit position out of range
        _expectFail(
            _importCall(head.header, j, _signers(n, 0, 7, idx[0])),
            abi.encodeWithSelector(GrandpaLightClient.PrecommitIndexOutOfRange.selector, 0, 7)
        );
        // odd-length signer list
        _expectFail(
            _importCall(head.header, j, bytes.concat(head.signers, hex"00")),
            abi.encodeWithSelector(GrandpaLightClient.MalformedSigners.selector, 2 * n + 1)
        );
        // votes ancestries are not supported
        bytes memory withAncestry = bytes.concat(j);
        withAncestry[j.length - 1] = 0x04;
        _expectFail(
            _importCall(head.header, withAncestry, head.signers),
            abi.encodeWithSelector(Justification.VotesAncestriesNotEmpty.selector, 1)
        );
        // finality proof for another block
        _expectFail(
            _proofCall(head.header, _flip(headProof, 0), head.signers),
            abi.encodeWithSelector(
                GrandpaLightClient.FinalityProofBlockMismatch.selector,
                head.hash ^ bytes32(uint256(1) << 248),
                head.hash
            )
        );
        // signature flipped inside the finality proof (justification starts after 32 + 2 bytes)
        _expectFail(
            _proofCall(head.header, _flip(headProof, 34 + _pc(pos[3]) + 40), head.signers),
            abi.encodeWithSelector(E, 3, idx[3])
        );
    }

    /// Offset of precommit `p` in a justification with a one-byte precommit count.
    function _pc(uint256 p) internal pure returns (uint256) {
        return 45 + p * 132;
    }

    /// The first `count` sorted head signers; entry `at` (if in range) replaced by (p, a).
    function _signers(uint256 count, uint256 at, uint256 p, uint256 a) internal view returns (bytes memory out) {
        out = new bytes(2 * count);
        for (uint256 i = 0; i < count; i++) {
            (uint256 pp, uint256 aa) = i == at ? (p, a) : (pos[i], idx[i]);
            out[2 * i] = bytes1(uint8(pp));
            out[2 * i + 1] = bytes1(uint8(aa));
        }
    }

    function _label(string memory what) internal pure returns (string memory) {
        return string.concat(_dir(), ": ", what);
    }

    function _init(uint64 setId, bytes32[] memory keys) internal {
        lc.initialize(genesis, setId, keys, checkpoint);
    }

    function _initCall(uint64 setId, bytes32[] memory keys, bytes memory header) internal view returns (bytes memory) {
        return abi.encodeCall(GrandpaLightClient.initialize, (genesis, setId, keys, header));
    }

    function _importCall(Signed storage s) internal view returns (bytes memory) {
        return _importCall(s.header, s.justification, s.signers);
    }

    function _importCall(bytes memory header, bytes memory justification, bytes memory signers)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(GrandpaLightClient.importHeader, (header, justification, signers));
    }

    function _proofCall(bytes memory header, bytes memory proof, bytes memory signers)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(GrandpaLightClient.importFinalityProof, (header, proof, signers));
    }

    function _keys(string memory json, string memory path, bytes32[] storage out) internal {
        uint256 count = _count(json, path);
        for (uint256 i = 0; i < count; i++) {
            assertEq(vm.parseJsonUint(json, _at(path, i, ".weight")), 1, "weight 1");
            out.push(vm.parseJsonBytes32(json, _at(path, i, ".id")));
        }
    }

    function _signed(string memory json, Signed storage s) internal {
        s.header = vm.parseJsonBytes(json, ".header.scale");
        s.justification = vm.parseJsonBytes(json, ".justification.scale");
        s.hash = vm.parseJsonBytes32(json, ".header.hash");
        s.number = uint32(vm.parseJsonUint(json, ".header.number"));
        s.stateRoot = vm.parseJsonBytes32(json, ".header.stateRoot");
        assertEq(_hash(s.header), s.hash, "fixture header hash");
        (uint256[] memory p, uint256[] memory a) = _sorted(json);
        s.signers = new bytes(2 * p.length);
        for (uint256 i = 0; i < p.length; i++) {
            s.signers[2 * i] = bytes1(uint8(p[i]));
            s.signers[2 * i + 1] = bytes1(uint8(a[i]));
        }
    }

    /// Precommit positions and their authority indices, sorted by authority index.
    function _sorted(string memory json) internal view returns (uint256[] memory p, uint256[] memory a) {
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
    }
}

/// fixtures/mainnet: set 3894 -> 3895 at #2,725,771, head #2,726,202.
contract LightClientMainnetTest is LightClientSnapshotTest {
    function _dir() internal pure override returns (string memory) {
        return "../fixtures/mainnet";
    }
}

/// fixtures/mainnet-pre-v3: set 3895 -> 3896 at #2,726,491, head #2,727,094.
contract LightClientPreV3Test is LightClientSnapshotTest {
    function _dir() internal pure override returns (string memory) {
        return "../fixtures/mainnet-pre-v3";
    }
}

/// Initialisation rules and the authority changes the captured chain data does not contain,
/// on a synthetic chain whose authorities sign with keys made here.
contract LightClientSyntheticTest is LightClientBase {
    bytes32 internal constant GENESIS = keccak256("synthetic genesis");
    uint64 internal constant SET_ID = 7;
    uint32 internal constant START = 100;

    bytes internal checkpoint;

    function setUp() public override {
        super.setUp();
        checkpoint = _header(bytes32(0), START, new bytes[](0));
    }

    // ------------------------------------------------------------------ initialize

    /// initialize takes 32-byte keys only (no caller-supplied curve points) and derives points
    /// that convert back to the same keys.
    function test_initialize_takesOnlyKeys_andDerivesPoints() public {
        assertEq(
            GrandpaLightClient.initialize.selector,
            bytes4(keccak256("initialize(bytes32,uint64,bytes32[],bytes)")),
            "the only key input is bytes32[]"
        );
        bytes32[] memory keys = _keys(0, 4);
        lc.initialize(GENESIS, SET_ID, keys, checkpoint);
        _assertRoundTrip(SET_ID, keys);
        assertEq(lc.threshold(), 3);

        vm.expectRevert(GrandpaLightClient.AlreadyInitialized.selector);
        lc.initialize(GENESIS, SET_ID, keys, checkpoint);
    }

    function test_initialize_rejectsBadSets() public {
        bytes32[] memory keys = _keys(0, 2);
        bytes32 notAPoint = _notAPoint();
        bytes32[] memory bad = new bytes32[](2);
        bad[0] = keys[0];
        bad[1] = notAPoint;
        vm.expectRevert(abi.encodeWithSelector(GrandpaLightClient.InvalidAuthorityKey.selector, 1, notAPoint));
        lc.initialize(GENESIS, SET_ID, bad, checkpoint);

        bad[1] = keys[0];
        vm.expectRevert(abi.encodeWithSelector(GrandpaLightClient.DuplicateAuthorityKey.selector, 1, keys[0]));
        lc.initialize(GENESIS, SET_ID, bad, checkpoint);

        vm.expectRevert(GrandpaLightClient.EmptyAuthoritySet.selector);
        lc.initialize(GENESIS, SET_ID, new bytes32[](0), checkpoint);

        vm.expectRevert(abi.encodeWithSelector(GrandpaLightClient.TooManyAuthorities.selector, 26));
        lc.initialize(GENESIS, SET_ID, new bytes32[](26), checkpoint);

        vm.prank(address(0xBEEF));
        vm.expectRevert(GrandpaLightClient.NotAdmin.selector);
        lc.initialize(GENESIS, SET_ID, keys, checkpoint);

        vm.expectRevert(GrandpaLightClient.NotInitialized.selector);
        lc.importHeader(checkpoint, hex"", hex"");
    }

    // ------------------------------------------------------------------ authority changes

    /// A ScheduledChange (delay 0) to a new list: the new points are derived on chain, and the
    /// next header needs 3 of the 4 new keys.
    function test_scheduledChange_newKeys() public {
        _initOne();
        bytes32[] memory next = _keys(1, 4);
        bytes memory h1 = _header(_hash(checkpoint), START + 1, _items(_scheduled(next, 1, 0)));
        _sendImport("synthetic set change to 4 new keys, 1 of 1", h1, _justify(h1, START + 1, SET_ID, 0, 1));
        assertEq(lc.currentSetId(), SET_ID + 1);
        assertEq(lc.authorities(SET_ID + 1), next);
        _assertRoundTrip(SET_ID + 1, next);

        bytes memory h2 = _header(_hash(h1), START + 2, new bytes[](0));
        bytes memory two = _justify(h2, START + 2, SET_ID + 1, 1, 2);
        vm.expectRevert(abi.encodeWithSelector(GrandpaLightClient.BelowThreshold.selector, 2, 3));
        lc.importHeader(h2, two, _seq(2));
        _sendImport("synthetic 3 of 4", h2, _justify(h2, START + 2, SET_ID + 1, 1, 3));
    }

    function test_forcedChange_halts() public {
        _initOne();
        bytes memory h1 = _header(_hash(checkpoint), START + 1, _items(_forced(START, _keys(0, 1))));
        bytes memory j1 = _justify(h1, START + 1, SET_ID, 0, 1);
        bytes32 hash1 = _hash(h1);
        bytes memory h2 = _header(hash1, START + 2, new bytes[](0));
        bytes memory j2 = _justify(h2, START + 2, SET_ID, 0, 1);
        vm.expectEmit(address(lc));
        emit GrandpaLightClient.Halted(START + 1, hash1, GrandpaLightClient.HaltReason.ForcedChange);
        lc.importHeader(h1, j1, _seq(1));
        assertTrue(lc.halted());
        assertTrue(lc.isImported(hash1), "the forced-change header itself is finalized");
        assertEq(lc.currentSetId(), SET_ID, "no change enacted");

        vm.expectRevert(GrandpaLightClient.ClientHalted.selector);
        lc.importHeader(h2, j2, _seq(1));
        vm.expectRevert(GrandpaLightClient.ClientHalted.selector);
        lc.importHeader(h1, j1, _seq(1));
        // unpause lifts a pause, not a halt
        lc.unpause();
        vm.expectRevert(GrandpaLightClient.ClientHalted.selector);
        lc.importHeader(h1, j1, _seq(1));
    }

    function test_forcedChange_reinitializeResumes() public {
        _initOne();
        bytes memory h1 = _header(_hash(checkpoint), START + 1, _items(_forced(START, _keys(0, 1))));
        lc.importHeader(h1, _justify(h1, START + 1, SET_ID, 0, 1), _seq(1));
        assertTrue(lc.halted());
        lc.reinitialize(GENESIS, SET_ID + 5, _keys(0, 1), h1, "after forced change");
        assertFalse(lc.halted());
        bytes memory h2 = _header(_hash(h1), START + 2, new bytes[](0));
        lc.importHeader(h2, _justify(h2, START + 2, SET_ID + 5, 0, 1), _seq(1));
        assertEq(lc.headerOf(_hash(h2)).setId, SET_ID + 5);
        assertEq(lc.headerOf(_hash(h1)).setId, SET_ID, "history keeps the set that finalized h1");
    }

    function test_delayedChange_halts() public {
        _initOne();
        bytes memory h1 = _header(_hash(checkpoint), START + 1, _items(_scheduled(_keys(0, 1), 1, 5)));
        _expectHalt(h1, GrandpaLightClient.HaltReason.DelayedChange);
        assertTrue(lc.halted());
    }

    function test_twoChanges_halt() public {
        _initOne();
        bytes[] memory items = new bytes[](2);
        items[0] = _frnk(_scheduled(_keys(0, 1), 1, 0));
        items[1] = _frnk(_scheduled(_keys(1, 1), 1, 0));
        bytes memory h1 = _header(_hash(checkpoint), START + 1, items);
        _expectHalt(h1, GrandpaLightClient.HaltReason.MultipleChanges);
    }

    function test_unusableNextSet_halts() public {
        _initOne();
        bytes32[] memory next = _keys(1, 2);
        next[1] = _notAPoint();
        bytes memory h1 = _header(_hash(checkpoint), START + 1, _items(_scheduled(next, 1, 0)));
        _expectHalt(h1, GrandpaLightClient.HaltReason.UnusableAuthoritySet);
        assertEq(lc.currentSetId(), SET_ID);
    }

    function test_weightNotOne_halts() public {
        _initOne();
        bytes memory h1 = _header(_hash(checkpoint), START + 1, _items(_scheduled(_keys(1, 2), 2, 0)));
        _expectHalt(h1, GrandpaLightClient.HaltReason.UnusableAuthoritySet);
    }

    // ------------------------------------------------------------------ synthetic chain

    /// Imports `header` (block START + 1, signed by authority 0 of SET_ID), expecting it to be
    /// stored and the client to halt for `reason`.
    function _expectHalt(bytes memory header, GrandpaLightClient.HaltReason reason) internal {
        bytes memory j = _justify(header, START + 1, SET_ID, 0, 1);
        bytes32 hash = _hash(header);
        vm.expectEmit(address(lc));
        emit GrandpaLightClient.Halted(START + 1, hash, reason);
        lc.importHeader(header, j, _seq(1));
        assertTrue(lc.halted(), "halted");
        assertTrue(lc.isImported(hash), "the header itself is imported");
    }

    function _initOne() internal {
        lc.initialize(GENESIS, SET_ID, _keys(0, 1), checkpoint);
    }

    function _sendImport(string memory label, bytes memory header, bytes memory j) internal {
        uint256 count = uint8(j[44]) >> 2;
        _send(label, abi.encodeCall(GrandpaLightClient.importHeader, (header, j, _seq(count))));
    }

    function _secret(uint256 i) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode("synthetic authority", i))) % N25519;
    }

    function _key(uint256 i) internal view returns (bytes32) {
        (uint256 x, uint256 y) = SCL_EIP6565.BasePointMultiply_Edwards(_secret(i));
        return bytes32(SCL_sha512.Swap256(SCL_EIP6565.edCompress([x, y])));
    }

    /// Keys of synthetic authorities from, from + 1, ..., count of them.
    function _keys(uint256 from, uint256 count) internal view returns (bytes32[] memory keys) {
        keys = new bytes32[](count);
        for (uint256 i = 0; i < count; i++) {
            keys[i] = _key(from + i);
        }
    }

    /// A 32-byte value that is not the encoding of a curve point.
    function _notAPoint() internal view returns (bytes32 v) {
        for (uint256 i = 2;; i++) {
            v = bytes32(i);
            (bool ok,,) = lc.deriveKey(v);
            if (!ok) return v;
        }
    }

    /// Signers hint for precommits 0..count-1 by authorities 0..count-1.
    function _seq(uint256 count) internal pure returns (bytes memory out) {
        out = new bytes(2 * count);
        for (uint256 i = 0; i < count; i++) {
            out[2 * i] = bytes1(uint8(i));
            out[2 * i + 1] = bytes1(uint8(i));
        }
    }

    /// A justification for `header` with precommits by synthetic authorities from..from+count-1.
    function _justify(bytes memory header, uint32 number, uint64 setId, uint256 from, uint256 count)
        internal
        view
        returns (bytes memory out)
    {
        bytes32 hash = _hash(header);
        uint64 round = 3;
        bytes memory payload = Justification.signedPayload(hash, number, round, setId);
        out = abi.encodePacked(_le64(round), hash, _le32(number), _compact(count));
        for (uint256 i = 0; i < count; i++) {
            bytes32 key = _key(from + i);
            (bytes32 r, bytes32 s) = _sign(_secret(from + i), key, payload);
            out = bytes.concat(out, abi.encodePacked(hash, _le32(number), r, s, key));
        }
        out = bytes.concat(out, hex"00");
    }

    function _sign(uint256 secret, bytes32 key, bytes memory message) internal view returns (bytes32 r, bytes32 s) {
        uint256 nonce = uint256(keccak256(abi.encode("nonce", secret, message))) % N25519;
        (uint256 x, uint256 y) = SCL_EIP6565.BasePointMultiply_Edwards(nonce);
        r = bytes32(SCL_sha512.Swap256(SCL_EIP6565.edCompress([x, y])));
        uint256 k = SCL_EIP6565.HashInternal(uint256(r), uint256(key), string(message));
        s = bytes32(SCL_sha512.Swap256(addmod(nonce, mulmod(k, secret, N25519), N25519)));
    }

    function _header(bytes32 parent, uint32 number, bytes[] memory items) internal pure returns (bytes memory out) {
        out = abi.encodePacked(parent, _compact(number), keccak256(abi.encode("state", number)), bytes32(0));
        out = bytes.concat(out, _compact(items.length));
        for (uint256 i = 0; i < items.length; i++) {
            out = bytes.concat(out, items[i]);
        }
    }

    function _items(bytes memory frnkPayload) internal pure returns (bytes[] memory items) {
        items = new bytes[](1);
        items[0] = _frnk(frnkPayload);
    }

    function _frnk(bytes memory payload) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(4), bytes4("FRNK"), _compact(payload.length), payload);
    }

    function _list(bytes32[] memory keys, uint64 weight) internal pure returns (bytes memory out) {
        out = _compact(keys.length);
        for (uint256 i = 0; i < keys.length; i++) {
            out = bytes.concat(out, abi.encodePacked(keys[i], _le64(weight)));
        }
    }

    function _scheduled(bytes32[] memory keys, uint64 weight, uint32 delay) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(1), _list(keys, weight), _le32(delay));
    }

    function _forced(uint32 median, bytes32[] memory keys) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(2), _le32(median), _list(keys, 1), _le32(0));
    }
}
