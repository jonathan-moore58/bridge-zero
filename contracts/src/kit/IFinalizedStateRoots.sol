// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.27;

/// Finalized state roots of a Substrate chain, by block hash: the two functions of the
/// IFinalizedStateRoots that GrandpaLightClient implements (src/grandpa/GrandpaLightClient.sol),
/// with the same signatures, so a GrandpaLightClient is one. It is declared on its own, as
/// src/bridge/IGrandpaImporter.sol is, so that the proof kit compiles without the light client and
/// its ed25519 library. A source imports this declaration or the light client's, by name, never
/// both.
interface IFinalizedStateRoots {
    /// The state root and number of an imported block. Reverts with UnknownBlock if `blockHash` was
    /// not imported as finalized.
    function stateRootOf(bytes32 blockHash) external view returns (bytes32 stateRoot, uint32 number);

    function genesisHash() external view returns (bytes32);
}
