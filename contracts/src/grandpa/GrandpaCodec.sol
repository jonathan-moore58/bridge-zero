// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {Header} from "./Header.sol";
import {Justification} from "./Justification.sol";
import {Scale} from "./Scale.sol";

/// @title GrandpaCodec
/// @notice The SCALE decoding of the light client (Header, Justification and Scale), deployed once
/// as a library of its own and linked into GrandpaLightClient and AuthoritySets, which reach it
/// with DELEGATECALL.
/// Splitting it out keeps each deployment under the per-transaction gas cap on chains that price
/// new code per byte. The decoding is that of the internal libraries, and every revert
/// (Scale.Truncated, Header.UnknownDigestItem, ...) comes back to the caller unchanged.
///
/// A header comes back as the fields the light client keeps plus its GRANDPA authority change,
/// already classified, so the client never handles the digest itself.
library GrandpaCodec {
    using Scale for Scale.Cursor;

    // Values of GrandpaLightClient.HaltReason.
    uint8 internal constant HALT_NONE = 0;
    uint8 internal constant HALT_FORCED_CHANGE = 1;
    uint8 internal constant HALT_DELAYED_CHANGE = 2;
    uint8 internal constant HALT_MULTIPLE_CHANGES = 3;
    uint8 internal constant HALT_UNUSABLE_AUTHORITY_SET = 4;

    struct DecodedHeader {
        bytes32 hash; // blake2_256 of the encoded header: the block hash
        uint32 number;
        bytes32 stateRoot;
        /// The header carries a FRNK ScheduledChange or ForcedChange log.
        bool authorityChange;
        /// HALT_NONE when the change can be followed (exactly one ScheduledChange, delay 0, every
        /// weight 1): `nextKeys` is then its list, still unchecked for length, duplicates and
        /// curve points. Otherwise the reason the client halts on it.
        uint8 haltReason;
        bytes32[] nextKeys;
    }

    /// The fields of a header the light client keeps, and whether it carries an authority change
    /// (decodeHeader classifies it).
    struct HeaderInfo {
        bytes32 hash;
        uint32 number;
        bytes32 stateRoot;
        bool authorityChange;
    }

    /// A justification's commit, and where its signed precommits are in the encoded input:
    /// `precommits` records of PRECOMMIT_SIZE bytes from byte `precommitsAt`, each
    ///   target_hash [32] | target_number u32le [4] | signature R [32] | signature s [32] | id [32]
    struct Commit {
        bytes32 blockHash; // the FinalityProof's block (zero for a bare justification)
        uint64 round;
        bytes32 targetHash;
        uint32 targetNumber;
        uint256 precommits;
        uint256 precommitsAt;
    }

    /// SCALE size of one signed precommit.
    uint256 internal constant PRECOMMIT_SIZE = 32 + 4 + 64 + 32;

    /// Header.decode() of a header that is the whole of `encoded`, with its authority change.
    function decodeHeader(bytes calldata encoded) public view returns (DecodedHeader memory d) {
        Header.Decoded memory h = Header.decode(encoded);
        d.hash = h.hash;
        d.number = h.number;
        d.stateRoot = h.stateRoot;

        Header.GrandpaLog memory change;
        uint256 changes;
        for (uint256 i = 0; i < h.grandpaLogs.length; i++) {
            uint8 kind = h.grandpaLogs[i].kind;
            if (kind == Header.SCHEDULED_CHANGE || kind == Header.FORCED_CHANGE) {
                change = h.grandpaLogs[i];
                changes++;
            }
        }
        if (changes == 0) return d;
        d.authorityChange = true;
        if (changes > 1) d.haltReason = HALT_MULTIPLE_CHANGES;
        else if (change.kind == Header.FORCED_CHANGE) d.haltReason = HALT_FORCED_CHANGE;
        else if (change.delay != 0) d.haltReason = HALT_DELAYED_CHANGE;
        if (d.haltReason != HALT_NONE) return d;

        Header.Authority[] memory next = change.nextAuthorities;
        d.nextKeys = new bytes32[](next.length);
        for (uint256 i = 0; i < next.length; i++) {
            if (next[i].weight != 1) {
                d.haltReason = HALT_UNUSABLE_AUTHORITY_SET;
                delete d.nextKeys;
                return d;
            }
            d.nextKeys[i] = next[i].key;
        }
    }

    /// Decodes the two inputs of an import, in this order: the justification (or, with
    /// `finalityProof`, the FinalityProof that grandpa_proveFinality returns), then the header.
    /// Both must decode in full. The precommits are not copied out but located in
    /// `justification`, where each takes PRECOMMIT_SIZE bytes.
    function decodeImport(bytes calldata header, bytes calldata justification, bool finalityProof)
        external
        view
        returns (HeaderInfo memory h, Commit memory commit)
    {
        bytes memory encoded = justification;
        Scale.Cursor memory c = Scale.cursor(encoded);
        Justification.Decoded memory j;
        if (finalityProof) {
            Justification.FinalityProof memory p = Justification.decodeFinalityProof(encoded);
            j = p.justification;
            commit.blockHash = p.blockHash;
            c.skip(32);
            c.readLength(); // the justification's length prefix
        } else {
            j = Justification.decode(encoded);
        }
        c.skip(44); // round, target hash, target number
        c.readLength(); // the precommit count
        commit.round = j.round;
        commit.targetHash = j.targetHash;
        commit.targetNumber = j.targetNumber;
        commit.precommits = j.precommits.length;
        commit.precommitsAt = c.offset();
        DecodedHeader memory d = decodeHeader(header);
        h = HeaderInfo(d.hash, d.number, d.stateRoot, d.authorityChange);
    }
}
