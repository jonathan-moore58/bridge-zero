// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.27;

import {GrandpaLightClient} from "../../src/grandpa/GrandpaLightClient.sol";
import {IFinalizedStateRoots} from "../../src/kit/IFinalizedStateRoots.sol";
import {IPortaldotStateReader} from "../../src/kit/IPortaldotStateReader.sol";
import {PortaldotState} from "../../src/kit/PortaldotState.sol";
import {PortaldotStateReader} from "../../src/kit/PortaldotStateReader.sol";
import {ProvenAssetGate} from "../../src/kit/examples/ProvenAssetGate.sol";
import {SubstrateProofs} from "../../src/trie/SubstrateProofs.sol";
import {LightClientBase} from "./LightClient.t.sol";

/// A stand-in for the Reader that answers one frozen balance, for the gate's rule that a frozen
/// balance counts. No EVM account holds a frozen asset balance at B: the frozen one there (read 8,
/// asset 4601) belongs to a Substrate account, which the gate cannot name, and the real Reader's
/// answer for it is in PortaldotStateTest.test_assetAccount.
contract FrozenBalanceReader {
    function stateRootOf(bytes32) external pure returns (bytes32, uint32) {
        return (bytes32(uint256(1)), 264_729);
    }

    function assetAccount(bytes32, uint32, bytes32, bytes[] calldata) external pure returns (uint128, uint8, uint32) {
        return (20_000_000, PortaldotState.FROZEN, 264_729);
    }
}

/// The example gate on the proof kit's fixture (fixtures/v3-testnet-kit): at least 1 pUSD (asset
/// 7777, 6 decimals) at V3 block B, #264,729, read through a PortaldotStateReader over a real
/// GrandpaLightClient that imported B with its finality proof, as in PortaldotStateTest.
contract ProvenAssetGateTest is LightClientBase {
    string internal constant DIR = "../fixtures/v3-testnet-kit";

    bytes32 internal constant B = 0x6dc44fe16f3e36c49978c422cc11550971f4b3234f9ca23dbac9b99bb0556f50;
    uint32 internal constant B_NUMBER = 264_729;
    bytes32 internal constant STATE_ROOT = 0x9b0ab2c32f5a4f7aa22c50788457b17b1ed262e51e0714f243b220f0c8695aaa;
    uint32 internal constant PUSD = 7777;
    uint128 internal constant ONE_PUSD = 1_000_000;
    /// Public V3 chain data: the holder of 60.5 pUSD (read 3), and one of 0.1 pUSD (read 6).
    address internal constant HOLDER = 0x3E79403610c21de20144960A0694b578EBc0dcDF;
    address internal constant SMALL_HOLDER = 0x4f7D38D29172f91F77d3050A9e0F75A1AAe5df25;
    address internal constant OTHER_HOLDER = 0x18DD7b945aAb902034617A1a2Cdc0D936A464cFA;
    address internal constant DEPLOYER = 0xD9838A86cF83C28Ee486544060D1cA4Ca2971071;

    string internal json;
    bytes32[] internal keys;
    PortaldotStateReader internal reader;
    ProvenAssetGate internal gate;

    function setUp() public override {
        super.setUp();
        json = _json(DIR, "state-reads");
        _keys(json, ".signingSet.authorities", keys);
        lc.initialize(
            vm.parseJsonBytes32(json, ".provenance.genesisHash"),
            uint64(vm.parseJsonUint(json, ".signingSet.setId")),
            keys,
            vm.parseJsonBytes(json, ".parentHeader.scale")
        );
        lc.importFinalityProof(
            vm.parseJsonBytes(json, ".header.scale"),
            vm.parseJsonBytes(json, ".finalityProof.scale"),
            vm.parseJsonBytes(json, ".signers.hint")
        );
        reader = new PortaldotStateReader(IFinalizedStateRoots(address(lc)));
        gate = new ProvenAssetGate(IPortaldotStateReader(address(reader)), B, PUSD, ONE_PUSD);
    }

    function test_constructor() public view {
        assertEq(address(gate.reader()), address(reader));
        assertEq(gate.snapshotBlock(), B);
        assertEq(gate.snapshotNumber(), B_NUMBER, "the number the light client holds for B");
        assertEq(gate.assetId(), PUSD);
        assertEq(gate.minimum(), ONE_PUSD);
    }

    /// The holder of 60.5 pUSD at B: Claimed with the balance and status 0 (Liquid), and the
    /// record names the holder.
    function test_claim() public {
        vm.expectEmit(address(gate));
        emit ProvenAssetGate.Claimed(HOLDER, 60_500_000, 0, B, B_NUMBER);
        _sendTo(address(gate), "kit: ProvenAssetGate.claim (read 3, 9 items, a new slot)", _claim(HOLDER, _proof(3)));
        assertTrue(gate.claimed(HOLDER));
        assertFalse(gate.claimed(address(this)), "nothing for the sender");
    }

    /// Anyone can send the claim; the record is the holder's, never the sender's.
    function test_claim_byAnyone() public {
        address sender = address(0xBEEF);
        vm.prank(sender);
        gate.claim(HOLDER, _proof(3));
        assertTrue(gate.claimed(HOLDER));
        assertFalse(gate.claimed(sender));
    }

    /// The same claim again: the proof checks out, then AlreadyClaimed.
    function test_claim_replay() public {
        gate.claim(HOLDER, _proof(3));
        _expectGateFail(_claim(HOLDER, _proof(3)), abi.encodeWithSelector(ProvenAssetGate.AlreadyClaimed.selector, HOLDER));
        assertTrue(gate.claimed(HOLDER));
    }

    /// 0.1 pUSD at B (read 6): below the minimum.
    function test_belowMinimum() public {
        _expectGateFail(
            _claim(SMALL_HOLDER, _proof(6)), abi.encodeWithSelector(ProvenAssetGate.BelowMinimum.selector, 100_000, ONE_PUSD)
        );
        assertFalse(gate.claimed(SMALL_HOLDER));
    }

    /// An account that holds no pUSD at B (the deployer, read 9): the proof of absence reverts
    /// KeyNotPresent; a gate never treats it as a zero balance that passes.
    function test_absentHolder() public {
        _expectGateFail(
            _claim(DEPLOYER, _proof(9)),
            abi.encodeWithSelector(SubstrateProofs.KeyNotPresent.selector, STATE_ROOT, _key(9))
        );
    }

    /// A flipped byte in any item of the holder's proof: "Incomplete Proof!", nothing recorded.
    function test_flippedProof() public {
        bytes[] memory proof = _proof(3);
        for (uint256 i = 0; i < proof.length; i++) {
            bytes[] memory copy = _proof(3);
            copy[i] = _flip(proof[i], proof[i].length / 2);
            _expectGateFail(_claim(HOLDER, copy), abi.encodeWithSignature("Error(string)", "Incomplete Proof!"));
        }
        assertFalse(gate.claimed(HOLDER));
    }

    /// Another holder with read 3's proof: the walk for the other key needs a node the proof does
    /// not hold (the fixture's first tamper).
    function test_otherHolderWithTheProof() public {
        assertEq(vm.parseJsonString(json, ".tampers[0].outcome"), "Incomplete Proof!");
        _expectGateFail(_claim(OTHER_HOLDER, _proof(3)), abi.encodeWithSignature("Error(string)", "Incomplete Proof!"));
        assertFalse(gate.claimed(OTHER_HOLDER));
        assertFalse(gate.claimed(HOLDER));
    }

    /// A frozen balance counts and its status is in the event (with a stand-in reader: see
    /// FrozenBalanceReader).
    function test_frozenBalanceCounts() public {
        FrozenBalanceReader stub = new FrozenBalanceReader();
        ProvenAssetGate frozen = new ProvenAssetGate(IPortaldotStateReader(address(stub)), B, 4601, ONE_PUSD);
        vm.expectEmit(address(frozen));
        emit ProvenAssetGate.Claimed(HOLDER, 20_000_000, PortaldotState.FROZEN, B, B_NUMBER);
        frozen.claim(HOLDER, new bytes[](0));
        assertTrue(frozen.claimed(HOLDER));
    }

    /// A snapshot block the light client did not import, and zero arguments.
    function test_constructor_rejects() public {
        vm.expectRevert(abi.encodeWithSelector(GrandpaLightClient.UnknownBlock.selector, bytes32(uint256(1))));
        new ProvenAssetGate(IPortaldotStateReader(address(reader)), bytes32(uint256(1)), PUSD, ONE_PUSD);
        vm.expectRevert(ProvenAssetGate.ZeroArgument.selector);
        new ProvenAssetGate(IPortaldotStateReader(address(0)), B, PUSD, ONE_PUSD);
        vm.expectRevert(ProvenAssetGate.ZeroArgument.selector);
        new ProvenAssetGate(IPortaldotStateReader(address(reader)), bytes32(0), PUSD, ONE_PUSD);
        vm.expectRevert(ProvenAssetGate.ZeroArgument.selector);
        new ProvenAssetGate(IPortaldotStateReader(address(reader)), B, PUSD, 0);
    }

    // ------------------------------------------------------------------ helpers

    function _claim(address holder, bytes[] memory proof) internal pure returns (bytes memory) {
        return abi.encodeCall(ProvenAssetGate.claim, (holder, proof));
    }

    function _expectGateFail(bytes memory data, bytes memory reason) internal {
        vm.expectRevert(reason);
        // Under expectRevert a low-level call returns true only when the expected revert happened.
        (bool ok,) = address(gate).call{gas: TX_GAS_CAP}(data);
        assertTrue(ok, "the expected revert did not happen");
    }

    function _proof(uint256 id) internal view returns (bytes[] memory) {
        return vm.parseJsonBytesArray(json, _at(".reads", id - 1, ".proof.nodes"));
    }

    function _key(uint256 id) internal view returns (bytes memory) {
        return vm.parseJsonBytes(json, _at(".reads", id - 1, ".key.hex"));
    }
}
