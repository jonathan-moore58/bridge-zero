// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {IFinalizedStateRoots} from "../grandpa/GrandpaLightClient.sol";
import {SubstrateProofs} from "../trie/SubstrateProofs.sol";

/// A finalized-state-roots source that imports GRANDPA finality proofs (GrandpaLightClient).
interface IGrandpaImporter is IFinalizedStateRoots {
    /// Imports `header` with a grandpa_proveFinality FinalityProof, or verifies it again without
    /// writing if it is already imported. Returns the block hash.
    function importFinalityProof(bytes calldata header, bytes calldata finalityProof, bytes calldata signers)
        external
        returns (bytes32 blockHash);
}

/// @title ProvenBalance
/// @notice Example consumer of the light client: proves the System.Account entry (and so the
/// free balance) of a Portaldot account at a finalized block. Holds no funds, keeps no state
/// and has no admin. What it emits is as trustworthy as the light client it reads.
contract ProvenBalance {
    /// frame_system AccountInfo with pallet_balances AccountData, 80 bytes. Runtimes on the newer
    /// AccountData layout store `frozen` and `flags` in the last two fields.
    struct AccountInfo {
        uint32 nonce;
        uint32 consumers;
        uint32 providers;
        uint32 sufficients;
        uint128 free;
        uint128 reserved;
        uint128 miscFrozen;
        uint128 feeFrozen;
    }

    uint256 public constant ACCOUNT_INFO_SIZE = 80;

    IGrandpaImporter public immutable lightClient;

    event BalanceProven(bytes32 indexed blockHash, uint32 number, bytes32 indexed accountId, uint128 free);

    /// The light client address is zero.
    error ZeroLightClient();
    /// The proven System.Account value is not an 80-byte AccountInfo.
    error AccountInfoLength(uint256 length);

    constructor(IGrandpaImporter lightClient_) {
        if (address(lightClient_) == address(0)) revert ZeroLightClient();
        lightClient = lightClient_;
    }

    /// Imports `header` through the light client (or verifies it again if already imported),
    /// then proves System.Account(accountId) against its state root and emits the free balance.
    function importAndProve(
        bytes calldata header,
        bytes calldata finalityProof,
        bytes calldata signers,
        bytes32 accountId,
        bytes[] calldata proofNodes
    ) external returns (bytes32 blockHash, uint32 number, AccountInfo memory info) {
        blockHash = lightClient.importFinalityProof(header, finalityProof, signers);
        (number, info) = prove(blockHash, accountId, proofNodes);
        emit BalanceProven(blockHash, number, accountId, info.free);
    }

    /// System.Account(accountId) at an imported block. Reverts with the light client's
    /// UnknownBlock if `blockHash` is not imported.
    function prove(bytes32 blockHash, bytes32 accountId, bytes[] calldata proofNodes)
        public
        view
        returns (uint32 number, AccountInfo memory info)
    {
        bytes32 stateRoot;
        (stateRoot, number) = lightClient.stateRootOf(blockHash);
        bytes memory value =
            SubstrateProofs.verifyMain(stateRoot, proofNodes, SubstrateProofs.systemAccountKey(accountId));
        info = decodeAccountInfo(value);
    }

    /// Decodes a SCALE AccountInfo (four u32, then four u128, little-endian).
    function decodeAccountInfo(bytes memory value) public pure returns (AccountInfo memory info) {
        if (value.length != ACCOUNT_INFO_SIZE) revert AccountInfoLength(value.length);
        info.nonce = uint32(_le(value, 0, 4));
        info.consumers = uint32(_le(value, 4, 4));
        info.providers = uint32(_le(value, 8, 4));
        info.sufficients = uint32(_le(value, 12, 4));
        info.free = uint128(_le(value, 16, 16));
        info.reserved = uint128(_le(value, 32, 16));
        info.miscFrozen = uint128(_le(value, 48, 16));
        info.feeFrozen = uint128(_le(value, 64, 16));
    }

    function _le(bytes memory data, uint256 at, uint256 size) private pure returns (uint256 v) {
        for (uint256 i = size; i > 0; i--) {
            v = (v << 8) | uint8(data[at + i - 1]);
        }
    }
}
