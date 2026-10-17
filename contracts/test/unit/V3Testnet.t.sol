// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {console} from "forge-std/Test.sol";
import {GrandpaLightClient} from "../../src/grandpa/GrandpaLightClient.sol";
import {Header} from "../../src/grandpa/Header.sol";
import {ProvenBalance, IGrandpaImporter} from "../../src/kit/ProvenBalance.sol";
import {LightClientBase} from "./LightClient.t.sol";
import {ProofsHarness} from "./Proofs.t.sol";

/// The light client on the Portaldot V3 testnet snapshot (fixtures/v3-testnet): 2 authorities of
/// weight 1 (threshold 2), BABE, BEEFY and GRANDPA digest logs, and a trie V1 state. The node
/// keeps no state older than about 256 blocks, so the checkpoint is the set change before the
/// latest one (set-change.json's signingSet.announced): its FRNK log lists the outgoing set,
/// which signs the latest change.
contract V3TestnetTest is LightClientBase {
    string internal constant DIR = "../fixtures/v3-testnet";

    /// The vendored walk's revert when an item is not among the proof items.
    bytes internal INCOMPLETE;

    bytes32 internal genesis;
    uint64 internal oldSetId; // started at the checkpoint, signs the set-change header
    uint64 internal newSetId; // started by the set-change header, signs the stored justification and the head
    bytes32[] internal oldKeys; // set-change.json's signing set
    bytes32[] internal newKeys; // authority-set.json at the head
    bytes internal checkpoint; // the set change before the latest one
    bytes32 internal checkpointHash;
    uint32 internal checkpointNumber;
    bytes internal headProof; // grandpa_proveFinality at the head
    uint256 internal jOffset; // where the head justification starts inside headProof
    Signed internal change;
    Signed internal head;
    Signed internal stored;
    bool internal hasStored; // the capture leaves the file out when it cannot name the signing set
    uint64 internal storedSetId; // the stored justification's signing set, as the capture recorded it

    ProvenBalance internal pb;
    ProofsHarness internal ph;
    bytes32 internal accountId;
    bytes internal accountKey;
    bytes internal accountValue;
    bytes[] internal nodes;
    uint256 internal nodeBytes;
    ProvenBalance.AccountInfo internal expected;

    function setUp() public override {
        super.setUp();
        string memory sc = _json(DIR, "set-change");
        string memory fp = _json(DIR, "finality-proof-head");
        string memory as_ = _json(DIR, "authority-set");
        genesis = vm.parseJsonBytes32(sc, ".provenance.genesisHash");
        assertEq(vm.parseJsonBytes32(fp, ".provenance.genesisHash"), genesis, "one chain");
        oldSetId = uint64(vm.parseJsonUint(sc, ".signingSet.setId"));
        newSetId = uint64(vm.parseJsonUint(sc, ".newSetId"));
        assertEq(newSetId, oldSetId + 1, "set change moves to the next set id");
        assertTrue(
            vm.keyExistsJson(sc, ".signingSet.announced"), "the capture holds the change that started the signing set"
        );
        _keys(sc, ".signingSet.authorities", oldKeys);
        assertEq(vm.parseJsonUint(as_, ".authoritySet.setId"), newSetId, "authority-set.json is the new set");
        _keys(as_, ".authoritySet.authorities", newKeys);
        checkpoint = vm.parseJsonBytes(sc, ".signingSet.announced.header.scale");
        checkpointHash = vm.parseJsonBytes32(sc, ".signingSet.announced.header.hash");
        checkpointNumber = uint32(vm.parseJsonUint(sc, ".signingSet.announced.header.number"));
        assertEq(_hash(checkpoint), checkpointHash, "fixture checkpoint hash");
        headProof = vm.parseJsonBytes(fp, ".finalityProof.scale");
        _signed(sc, change);
        _signed(fp, head);
        hasStored = vm.exists(string.concat(DIR, "/stored-justification-512.json"));
        if (hasStored) {
            string memory sj = _json(DIR, "stored-justification-512");
            _signed(sj, stored);
            storedSetId = uint64(vm.parseJsonUint(sj, ".signingSet.setId"));
        }
        assertLt(checkpointNumber, change.number, "the checkpoint comes before the set change");

        // FinalityProof = block hash, then the justification as Vec<u8>, then unknown headers.
        jOffset = 32 + _compact(head.justification.length).length;
        for (uint256 i = 0; i < head.justification.length; i++) {
            assertEq(headProof[jOffset + i], head.justification[i]);
        }
        uint256 precommits = _count(fp, ".justification.precommits");
        assertEq(uint8(head.justification[44]), precommits << 2, "one-byte compact precommit count");

        string memory ap = _json(DIR, "account-proof");
        assertEq(vm.parseJsonUint(ap, ".trieVersion"), 1, "the V3 testnet state is a trie V1");
        assertEq(vm.parseJsonBytes32(ap, ".header.hash"), head.hash, "the account proof is at the head");
        accountId = vm.parseJsonBytes32(ap, ".account.id");
        accountKey = vm.parseJsonBytes(ap, ".key.hex");
        accountValue = vm.parseJsonBytes(ap, ".value.scale");
        bytes[] memory list = vm.parseJsonBytesArray(ap, ".proof.nodes");
        for (uint256 i = 0; i < list.length; i++) {
            nodes.push(list[i]);
        }
        nodeBytes = vm.parseJsonUint(ap, ".proof.bytes");
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

        pb = new ProvenBalance(IGrandpaImporter(address(lc)));
        ph = new ProofsHarness();
        INCOMPLETE = abi.encodeWithSignature("Error(string)", "Incomplete Proof!");
    }

    // ------------------------------------------------------------------ headers

    /// Every captured V3 header decodes to its fixture fields and hashes to its block hash: the
    /// checkpoint, the set change and its parent, the stored justification's header and the head.
    function test_headers_decodeAndHash() public view {
        string memory sc = _json(DIR, "set-change");
        _checkHeader(sc, ".signingSet.announced.header");
        _checkHeader(sc, ".header");
        _checkHeader(sc, ".parentHeader");
        if (hasStored) _checkHeader(_json(DIR, "stored-justification-512"), ".header");
        _checkHeader(_json(DIR, "finality-proof-head"), ".header");
    }

    /// The set-change header's FRNK log is a ScheduledChange to the head's set, with 2 keys of
    /// weight 1 and delay 0 (a ForcedChange or a delay would halt the client). The checkpoint's
    /// log announces the outgoing set the same way.
    function test_changeLogs_announceTheSets() public view {
        string memory sc = _json(DIR, "set-change");
        _checkChange(change.header, sc, ".scheduledChange", newKeys);
        _checkChange(checkpoint, sc, ".signingSet.announced.scheduledChange", oldKeys);
    }

    // ------------------------------------------------------------------ light client

    /// Checkpoint at the previous set change, with the keys its own FRNK log lists; the latest
    /// set change imports with its stored justification (2 of 2) and moves the client to the
    /// next set id and keys; the stored justification and the head finality proof import under
    /// the new set, and the head's state root is stored.
    function test_checkpoint_setChange_head() public {
        bytes32[] memory logged = _nextKeys(checkpoint);
        assertEq(logged, oldKeys, "the Solidity decoder reads the outgoing set the capture recorded");
        _send(
            "v3-testnet: initialize at the previous set change, 2 keys",
            abi.encodeCall(GrandpaLightClient.initialize, (genesis, oldSetId, logged, checkpoint))
        );
        assertEq(lc.currentSetId(), oldSetId);
        assertEq(
            lc.threshold(), vm.parseJsonUint(_json(DIR, "set-change"), ".signingSet.threshold"), "the fixture threshold"
        );
        (bytes32 latest, uint32 number) = lc.latestFinalized();
        assertEq(latest, checkpointHash, "checkpoint is the latest finalized header");
        assertEq(number, checkpointNumber);
        _assertRoundTrip(oldSetId, oldKeys);

        // A capture taken soon after a set change can hold a stored justification from before it,
        // signed by the outgoing set; it must then be imported before the set change.
        bool storedUsable = hasStored && stored.number > checkpointNumber && stored.number != change.number;
        bool storedFirst = storedUsable && stored.number < change.number;
        if (storedFirst) {
            _send("v3-testnet: stored justification import (before the set change), 2 of 2", _importCall(stored));
        }

        assertGe(change.signers.length / 2, lc.threshold(), "the hint counts at least the threshold");
        vm.expectEmit(address(lc));
        emit GrandpaLightClient.AuthoritySetChanged(
            oldSetId, newSetId, keccak256(abi.encodePacked(newKeys)), newKeys.length, change.number
        );
        _send("v3-testnet: set-change import, 2 of 2", _importCall(change));
        assertEq(lc.currentSetId(), newSetId, "rotated to the next set");
        assertEq(lc.authorities(newSetId), newKeys, "keys of the next set equal authority-set.json");
        assertEq(lc.authorities(oldSetId), oldKeys, "the old set stays readable");
        _assertRoundTrip(newSetId, newKeys);
        assertEq(lc.headerOf(change.hash).setId, oldSetId, "finalized by the outgoing set");
        assertEq(lc.headerOf(change.hash).stateRoot, change.stateRoot);
        assertFalse(lc.halted());

        if (storedUsable && !storedFirst) {
            _send("v3-testnet: stored justification import, 2 of 2", _importCall(stored));
        }
        _send("v3-testnet: head finality proof import, 2 of 2", _proofCall(head.header, headProof, head.signers));
        (latest, number) = lc.latestFinalized();
        assertEq(latest, head.hash);
        assertEq(number, head.number);
        (bytes32 root, uint32 n) = lc.stateRootOf(head.hash);
        assertEq(root, head.stateRoot, "head state root");
        assertEq(n, head.number);
        assertEq(lc.headerOf(head.hash).setId, newSetId);
        if (storedUsable) {
            uint64 storedSet = storedFirst ? oldSetId : newSetId;
            assertEq(storedSetId, storedSet, "the capture names the same signing set");
            (root,) = lc.stateRootOf(stored.hash);
            assertEq(root, stored.stateRoot, "stored-justification state root");
            assertEq(lc.headerOf(stored.hash).setId, storedSet);
        } else {
            console.log("v3-testnet: no usable stored justification in this capture");
        }
    }

    /// One signature fewer than the threshold does not import the set change. On the V3 testnet
    /// the threshold equals the set size, so this is 1 of 2.
    function test_belowThreshold_rejected() public {
        lc.initialize(genesis, oldSetId, oldKeys, checkpoint);
        uint256 t = lc.threshold();
        bytes memory fewer = _cut(change.signers, change.signers.length - 2 * (t - 1)); // first t - 1 entries
        _expectFail(
            _importCall(change.header, change.justification, fewer),
            abi.encodeWithSelector(GrandpaLightClient.BelowThreshold.selector, t - 1, t)
        );
        assertFalse(lc.isImported(change.hash), "the set change is not imported");
        assertEq(lc.currentSetId(), oldSetId, "and nothing is enacted");
    }

    /// The V3 sets keep their keys, so only the set id tells them apart: without the set change,
    /// the head's signatures do not verify, and the client names the set id they were made under.
    function test_skippedSetChange_wrongSetId() public {
        lc.initialize(genesis, oldSetId, oldKeys, checkpoint);
        _expectFail(
            _proofCall(head.header, headProof, head.signers),
            abi.encodeWithSelector(GrandpaLightClient.WrongSetId.selector, oldSetId, newSetId)
        );
    }

    // ------------------------------------------------------------------ System.Account, trie V1

    /// The V3 System.Account proof walks from the state root the light client stored for the
    /// head. In trie V1 the 80-byte AccountInfo is not inline in its leaf: the leaf holds its
    /// hash, and the value is a proof item of its own.
    function test_accountProof_trieV1() public {
        _importToHead();
        (bytes32 root,) = lc.stateRootOf(head.hash);
        assertEq(ph.systemAccountKey(accountId), accountKey, "System.Account key built on chain");
        (bytes memory value, uint256 gasUsed) = ph.verifyMain(root, nodes, accountKey);
        assertEq(value, accountValue, "the captured 80-byte AccountInfo");
        (bytes memory vv, bool present) = ph.vendorRead(root, nodes, accountKey);
        assertTrue(present);
        assertEq(vv, value, "same as the vendored walk");
        _assertInfo(pb.decodeAccountInfo(value));
        console.log("v3-testnet: verifyMain, trie V1, gas", gasUsed);

        uint256 at = type(uint256).max;
        for (uint256 i = 0; i < nodes.length; i++) {
            if (keccak256(nodes[i]) == keccak256(accountValue)) at = i;
        }
        assertLt(at, nodes.length, "the value is a proof item of its own (trie V1, value over 32 bytes)");
        bytes[] memory fewer = new bytes[](nodes.length - 1);
        for (uint256 k = 0; k < fewer.length; k++) {
            fewer[k] = nodes[k < at ? k : k + 1];
        }
        (bool ok, bytes memory ret) =
            address(ph).staticcall(abi.encodeCall(ProofsHarness.verifyMain, (root, fewer, accountKey)));
        assertFalse(ok, "without the value item the walk cannot read the value");
        assertEq(ret, INCOMPLETE, "the value item is looked up by its hash");
    }

    /// Changing any single byte of any proof item, the value item included, breaks the proof.
    function test_accountProof_everyByteFlipFails() public view {
        bytes[] memory copy = nodes;
        uint256 checked;
        for (uint256 i = 0; i < copy.length; i++) {
            bytes memory node = copy[i];
            for (uint256 j = 0; j < node.length; j++) {
                node[j] ^= 0x01;
                (bool ok, bytes memory ret) =
                    address(ph).staticcall(abi.encodeCall(ProofsHarness.verifyMain, (head.stateRoot, copy, accountKey)));
                node[j] ^= 0x01;
                assertFalse(ok, "a flipped byte must fail");
                assertEq(ret, INCOMPLETE, "the flipped item is not under the root");
                checked++;
            }
        }
        assertEq(checked, nodeBytes, "every byte of every proof item");
    }

    /// ProvenBalance in one transaction: the head (2 of 2) and the account's System.Account entry.
    function test_importAndProve() public {
        _importChange();
        assertFalse(lc.isImported(head.hash));
        vm.expectEmit(address(pb));
        emit ProvenBalance.BalanceProven(head.hash, head.number, accountId, expected.free);
        (bytes memory ret, uint256 txGas) = _sendTo(
            address(pb),
            "v3-testnet: importAndProve, 2 of 2 + System.Account (trie V1)",
            _proveCall(head.header, headProof)
        );
        (bytes32 h, uint32 n, ProvenBalance.AccountInfo memory info) =
            abi.decode(ret, (bytes32, uint32, ProvenBalance.AccountInfo));
        assertEq(h, head.hash);
        assertEq(n, head.number);
        _assertInfo(info);
        assertTrue(lc.isImported(head.hash), "the head is imported by the same call");
        console.log("  share of the 16,777,216 cap, in basis points:", txGas * 10_000 / TX_GAS_CAP);
    }

    // ------------------------------------------------------------------ tampers

    /// A flipped signature byte and a flipped header byte revert with their own errors: on the
    /// set-change import, on the head import and in importAndProve. Nothing is imported.
    function test_tampers() public {
        lc.initialize(genesis, oldSetId, oldKeys, checkpoint);
        bytes4 invalid = GrandpaLightClient.InvalidSignature.selector;
        (uint256[] memory cp, uint256[] memory ci) = _sorted(_json(DIR, "set-change"));
        // set change: R of the first counted precommit, s of the second, a state-root byte
        _expectFail(
            _importCall(change.header, _flip(change.justification, _pc(cp[0]) + 36), change.signers),
            abi.encodeWithSelector(invalid, 0, ci[0])
        );
        _expectFail(
            _importCall(change.header, _flip(change.justification, _pc(cp[1]) + 68), change.signers),
            abi.encodeWithSelector(invalid, 1, ci[1])
        );
        bytes memory badChange = _flip(change.header, 40);
        _expectFail(
            _importCall(badChange, change.justification, change.signers),
            abi.encodeWithSelector(GrandpaLightClient.HeaderHashMismatch.selector, change.hash, _hash(badChange))
        );
        assertFalse(lc.isImported(change.hash), "no tampered set change is imported");
        assertEq(lc.currentSetId(), oldSetId, "and nothing is enacted");
        lc.importHeader(change.header, change.justification, change.signers);

        // head: a signature byte inside the finality proof, a state-root byte
        (uint256[] memory hp, uint256[] memory hi) = _sorted(_json(DIR, "finality-proof-head"));
        _expectFail(
            _proofCall(head.header, _flip(headProof, jOffset + _pc(hp[0]) + 36), head.signers),
            abi.encodeWithSelector(invalid, 0, hi[0])
        );
        bytes memory badHead = _flip(head.header, 40);
        _expectFail(
            _proofCall(badHead, headProof, head.signers),
            abi.encodeWithSelector(GrandpaLightClient.FinalityProofBlockMismatch.selector, head.hash, _hash(badHead))
        );
        _expectFail(
            _importCall(badHead, head.justification, head.signers),
            abi.encodeWithSelector(GrandpaLightClient.HeaderHashMismatch.selector, head.hash, _hash(badHead))
        );

        // importAndProve: the same two
        _expectProveFail(
            _proveCall(head.header, _flip(headProof, jOffset + _pc(hp[1]) + 68)),
            abi.encodeWithSelector(invalid, 1, hi[1])
        );
        _expectProveFail(
            _proveCall(badHead, headProof),
            abi.encodeWithSelector(GrandpaLightClient.FinalityProofBlockMismatch.selector, head.hash, _hash(badHead))
        );
        assertFalse(lc.isImported(head.hash), "no tampered head is imported");
    }

    // ------------------------------------------------------------------ helpers

    function _importChange() internal {
        lc.initialize(genesis, oldSetId, oldKeys, checkpoint);
        lc.importHeader(change.header, change.justification, change.signers);
        assertEq(lc.currentSetId(), newSetId, "set change enacted");
    }

    function _importToHead() internal {
        _importChange();
        lc.importFinalityProof(head.header, headProof, head.signers);
    }

    function _proveCall(bytes memory header, bytes memory proof) internal view returns (bytes memory) {
        return abi.encodeCall(ProvenBalance.importAndProve, (header, proof, head.signers, accountId, nodes));
    }

    function _expectProveFail(bytes memory data, bytes memory reason) internal {
        vm.expectRevert(reason);
        // Under expectRevert a low-level call returns true only when the expected revert happened.
        (bool ok,) = address(pb).call{gas: TX_GAS_CAP}(data);
        assertTrue(ok, "the expected revert did not happen");
    }

    /// Offset of precommit `p` in a justification with a one-byte precommit count.
    function _pc(uint256 p) internal pure returns (uint256) {
        return 45 + p * 132;
    }

    /// The keys of the one FRNK ScheduledChange in `header`.
    function _nextKeys(bytes memory header) internal view returns (bytes32[] memory keys) {
        (Header.Decoded memory h,) = harness.header(header);
        assertEq(h.grandpaLogs.length, 1, "one FRNK log");
        Header.Authority[] memory next = h.grandpaLogs[0].nextAuthorities;
        keys = new bytes32[](next.length);
        for (uint256 i = 0; i < next.length; i++) {
            keys[i] = next[i].key;
        }
    }

    /// The FRNK log of `header` is a ScheduledChange with delay 0 to `keys` (weight 1), the list
    /// the fixture records at `path`.
    function _checkChange(bytes memory header, string memory json, string memory path, bytes32[] storage keys)
        internal
        view
    {
        (Header.Decoded memory h,) = harness.header(header);
        assertEq(h.grandpaLogs.length, 1, "one FRNK log");
        Header.GrandpaLog memory log = h.grandpaLogs[0];
        assertEq(log.kind, Header.SCHEDULED_CHANGE, "a ScheduledChange (the client halts on a ForcedChange)");
        assertEq(log.delay, 0, "delay 0 (the client halts on a delayed change)");
        assertEq(log.delay, vm.parseJsonUint(json, string.concat(path, ".delay")), "fixture delay");
        assertEq(log.nextAuthorities.length, keys.length, "as many keys as the fixture's set");
        string memory list = string.concat(path, ".nextAuthorities");
        assertEq(_count(json, list), keys.length, "as many keys as the fixture's log");
        for (uint256 i = 0; i < keys.length; i++) {
            assertEq(log.nextAuthorities[i].weight, 1, "weight 1");
            assertEq(log.nextAuthorities[i].key, keys[i], "the fixture set's key");
            assertEq(
                log.nextAuthorities[i].key, vm.parseJsonBytes32(json, _at(list, i, ".id")), "the fixture log's key"
            );
        }
    }

    /// The header at `path` decodes to its fixture fields and hashes to its block hash.
    function _checkHeader(string memory json, string memory path) internal view {
        (Header.Decoded memory h,) = harness.header(vm.parseJsonBytes(json, string.concat(path, ".scale")));
        assertEq(h.hash, vm.parseJsonBytes32(json, string.concat(path, ".hash")), "block hash");
        assertEq(h.number, vm.parseJsonUint(json, string.concat(path, ".number")), "number");
        assertEq(h.parentHash, vm.parseJsonBytes32(json, string.concat(path, ".parentHash")), "parent hash");
        assertEq(h.stateRoot, vm.parseJsonBytes32(json, string.concat(path, ".stateRoot")), "state root");
        assertEq(h.extrinsicsRoot, vm.parseJsonBytes32(json, string.concat(path, ".extrinsicsRoot")), "extrinsics root");
        assertEq(h.digestItems, _count(json, string.concat(path, ".digest")), "digest items");
        assertEq(h.grandpaLogs.length, _frnkLogs(json, path), "FRNK logs");
    }

    /// Consensus items of engine FRNK in the fixture digest of the header at `path`.
    function _frnkLogs(string memory json, string memory path) internal view returns (uint256 n) {
        string memory items = string.concat(path, ".digest");
        uint256 count = _count(json, items);
        for (uint256 i = 0; i < count; i++) {
            string memory engine = _at(items, i, ".engine");
            if (!vm.keyExistsJson(json, engine)) continue;
            bool frnk = keccak256(bytes(vm.parseJsonString(json, engine))) == keccak256("FRNK");
            bool consensus =
                keccak256(bytes(vm.parseJsonString(json, _at(items, i, ".kind")))) == keccak256("Consensus");
            if (frnk && consensus) n++;
        }
    }

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
}
