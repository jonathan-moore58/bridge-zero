// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

/// What BridgeMinter calls on the light client: GrandpaLightClient's IFinalizedStateRoots and its
/// importFinalityProof, with the same signatures, so a GrandpaLightClient is one. ProvenBalance
/// (src/kit) declares the same interface for itself. This one is declared on its own instead of
/// importing GrandpaLightClient.sol: the V3 build (foundry profile v3) compiles src/bridge/** with
/// the IR pipeline, and the import would bring the ed25519 library into that compilation, where it
/// does not compile.
interface IGrandpaImporter {
    /// The state root and number of an imported block. Reverts with UnknownBlock if `blockHash` was
    /// not imported as finalized.
    function stateRootOf(bytes32 blockHash) external view returns (bytes32 stateRoot, uint32 number);

    function genesisHash() external view returns (bytes32);

    /// Imports `header` with a grandpa_proveFinality FinalityProof, or verifies it again without
    /// writing if it is already imported. Returns the block hash.
    function importFinalityProof(bytes calldata header, bytes calldata finalityProof, bytes calldata signers)
        external
        returns (bytes32 blockHash);
}
