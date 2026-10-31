// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.27;

import {IFinalizedStateRoots} from "./IFinalizedStateRoots.sol";
import {IPortaldotStateReader} from "./IPortaldotStateReader.sol";
import {PortaldotState} from "./PortaldotState.sol";

/// @title PortaldotStateReader
/// @notice PortaldotState behind one deployed contract, so that a consumer calls it through
/// IPortaldotStateReader and compiles no trie code. Stateless: no storage, no owner, no admin, no
/// events; every function is a view. Deployed linked to the StorageProofs library, which holds the
/// trie walk, and bound to one light client for good (GrandpaLightClient #2 on Sepolia).
///
/// What a read proves: a value stored under the state root of a V3 block that the light client
/// imported. What it trusts: the light client (the validator set that finalized the block, or the
/// admin's checkpoint), V3's own rules (its sudo key and runtime upgrades included), and this
/// code's decoders, which follow V3's runtime layout (portaldot-v3 3002).
contract PortaldotStateReader is IPortaldotStateReader {
    /// The light client that finalizes V3 state roots.
    IFinalizedStateRoots public immutable override lightClient;

    constructor(IFinalizedStateRoots lightClient_) {
        if (address(lightClient_) == address(0)) revert ZeroLightClient();
        lightClient = lightClient_;
    }

    function stateRootOf(bytes32 blockHash) external view returns (bytes32 stateRoot, uint32 number) {
        return PortaldotState.stateRootOf(lightClient, blockHash);
    }

    function readMain(bytes32 blockHash, bytes calldata key, bytes[] calldata proof)
        external
        view
        returns (bytes memory value, uint32 number)
    {
        return PortaldotState.readMain(lightClient, blockHash, key, proof);
    }

    function accountInfo(bytes32 blockHash, bytes32 accountId, bytes[] calldata proof)
        external
        view
        returns (AccountInfo memory info, uint32 number)
    {
        return PortaldotState.accountInfoAt(lightClient, blockHash, accountId, proof);
    }

    function assetAccount(bytes32 blockHash, uint32 assetId, bytes32 accountId, bytes[] calldata proof)
        external
        view
        returns (uint128 balance, uint8 status, uint32 number)
    {
        return PortaldotState.assetAccountAt(lightClient, blockHash, assetId, accountId, proof);
    }

    function nftOwner(bytes32 blockHash, uint32 collection, uint32 item, bytes[] calldata proof)
        external
        view
        returns (bytes32 owner, uint32 number)
    {
        return PortaldotState.nftOwnerAt(lightClient, blockHash, collection, item, proof);
    }

    function contractInfo(bytes32 blockHash, address account, bytes[] calldata accountProof)
        external
        view
        returns (bytes32 trieId, bytes32 codeHash, uint32 number)
    {
        return PortaldotState.contractAt(lightClient, blockHash, account, accountProof);
    }

    function contractSlot(bytes32 blockHash, address account, bytes32 slot, ContractSlotProof calldata p)
        external
        view
        returns (bytes32 word, bytes32 codeHash, uint32 number)
    {
        return PortaldotState.contractSlotAt(lightClient, blockHash, account, slot, p);
    }

    function childSlot(
        bytes32 blockHash,
        bytes32 trieId,
        bytes32 slot,
        bytes[] calldata childRootProof,
        bytes[] calldata slotProof
    ) external view returns (bytes32 word, uint32 number) {
        return PortaldotState.childSlotAt(lightClient, blockHash, trieId, slot, childRootProof, slotProof);
    }
}
