// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {Scale} from "./Scale.sol";

/// @title Justification
/// @notice Decodes a GRANDPA justification
///   round u64 ‖ commit { target_hash [32] ‖ target_number u32 ‖
///     precommits Vec<{ target_hash [32] ‖ target_number u32 ‖ signature [64] ‖ id [32] }> } ‖
///   votes_ancestries Vec<Header>
/// and the FinalityProof that grandpa_proveFinality returns
///   block [32] ‖ justification Vec<u8> ‖ unknown_headers Vec<Header>,
/// and builds the 53-byte message each precommit signs. The light client accepts only
/// justifications whose precommits all name the commit target, so votes_ancestries and
/// unknown_headers must be empty.
library Justification {
    using Scale for Scale.Cursor;

    /// SCALE size of one signed precommit: target hash, target number, signature, id.
    uint256 private constant PRECOMMIT_SIZE = 32 + 4 + 64 + 32;

    /// The justification carries `count` ancestry headers; only direct precommits on the
    /// commit target are supported.
    error VotesAncestriesNotEmpty(uint256 count);
    /// The finality proof carries `count` unknown headers; only proofs for the justified
    /// block itself are supported.
    error UnknownHeadersNotEmpty(uint256 count);

    struct Precommit {
        bytes32 targetHash;
        uint32 targetNumber;
        bytes32 r; // signature bytes 0..32 (the encoded point R)
        bytes32 s; // signature bytes 32..64 (the scalar s, little-endian)
        bytes32 authorityId; // the signer's ed25519 public key
    }

    struct Decoded {
        uint64 round;
        bytes32 targetHash;
        uint32 targetNumber;
        Precommit[] precommits;
    }

    struct FinalityProof {
        bytes32 blockHash;
        Decoded justification;
    }

    /// Decodes a justification that is the whole of `encoded`.
    function decode(bytes memory encoded) internal pure returns (Decoded memory j) {
        Scale.Cursor memory c = Scale.cursor(encoded);
        j = read(c);
        c.done();
    }

    function decodeCalldata(bytes calldata encoded) internal pure returns (Decoded memory) {
        return decode(encoded);
    }

    /// Decodes a FinalityProof that is the whole of `encoded`; the inner justification must
    /// fill its length prefix exactly.
    function decodeFinalityProof(bytes memory encoded) internal pure returns (FinalityProof memory p) {
        Scale.Cursor memory c = Scale.cursor(encoded);
        p.blockHash = c.readBytes32();
        Scale.Cursor memory inner = c.take(c.readLength());
        p.justification = read(inner);
        inner.done();
        uint256 unknown = c.readCompact();
        if (unknown != 0) revert UnknownHeadersNotEmpty(unknown);
        c.done();
    }

    function decodeFinalityProofCalldata(bytes calldata encoded) internal pure returns (FinalityProof memory) {
        return decodeFinalityProof(encoded);
    }

    /// Reads one justification at the cursor.
    function read(Scale.Cursor memory c) internal pure returns (Decoded memory j) {
        j.round = c.readU64();
        j.targetHash = c.readBytes32();
        j.targetNumber = c.readU32();

        uint256 n = c.readLength();
        if (n * PRECOMMIT_SIZE > c.remaining()) revert Scale.Truncated(c.offset(), n * PRECOMMIT_SIZE);
        j.precommits = new Precommit[](n);
        for (uint256 i = 0; i < n; i++) {
            Precommit memory p = j.precommits[i];
            p.targetHash = c.readBytes32();
            p.targetNumber = c.readU32();
            p.r = c.readBytes32();
            p.s = c.readBytes32();
            p.authorityId = c.readBytes32();
        }

        // Read as a plain compact, so any non-zero count gets this error rather than
        // whatever its first ancestry header would trip over.
        uint256 ancestries = c.readCompact();
        if (ancestries != 0) revert VotesAncestriesNotEmpty(ancestries);
    }

    /// The message a precommit signs: SCALE of (Message::Precommit(Precommit { target_hash,
    /// target_number }), round, set_id), i.e.
    ///   0x01 ‖ target_hash ‖ u32le(target_number) ‖ u64le(round) ‖ u64le(set_id)
    function signedPayload(bytes32 targetHash, uint32 targetNumber, uint64 round, uint64 setId)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(
            uint8(1), targetHash, Scale.swap32(targetNumber), Scale.swap64(round), Scale.swap64(setId)
        );
    }
}
