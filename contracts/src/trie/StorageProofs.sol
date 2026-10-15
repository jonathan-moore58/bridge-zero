// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {SubstrateProofs} from "./SubstrateProofs.sol";

/// @title StorageProofs
/// @notice The storage-proof check of SubstrateProofs and the trie walk it wraps
/// (vendor/PolkadotTrie.sol), deployed once as a library of their own and linked into the
/// contracts that read Substrate state, which reach it with DELEGATECALL. Splitting it out keeps
/// each deployment under the per-transaction gas cap on chains that price new code per byte.
/// Behaviour, including every revert, is that of SubstrateProofs.verifyMain.
///
/// Storage keys are built by the caller with SubstrateProofs' internal key functions (they are
/// small and do not walk the trie). A child-trie read (SubstrateProofs.verifyChild) is not
/// exposed yet: inlined, it would bring the walk back into the caller, so it belongs here once a
/// contract needs it (about 0.7 KB more code).
library StorageProofs {
    /// SubstrateProofs.verifyMain(): the non-empty value of `key` under `stateRoot`.
    function verifyMain(bytes32 stateRoot, bytes[] calldata proofNodes, bytes calldata key)
        external
        view
        returns (bytes memory value)
    {
        return SubstrateProofs.verifyMain(stateRoot, proofNodes, key);
    }
}
