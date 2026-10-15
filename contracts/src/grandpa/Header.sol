// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {BLAKE2b} from "blake2b-solidity/BLAKE2b.sol";
import {Scale} from "./Scale.sol";

/// @title Header
/// @notice Decodes a SCALE-encoded Substrate block header:
///   parent_hash [32] ‖ number Compact<u32> ‖ state_root [32] ‖ extrinsics_root [32] ‖
///   digest Vec<DigestItem>
/// and the GRANDPA ("FRNK") consensus logs in its digest. The block hash is BLAKE2b-256 of
/// the exact bytes decoded. Unknown digest items, unknown GRANDPA logs, truncation and
/// trailing bytes all revert.
library Header {
    using Scale for Scale.Cursor;

    // DigestItem variants (sp-runtime generic::DigestItem). Tags 1, 2, 3 and 7 belonged to
    // items that no longer exist and do not decode in current runtimes.
    uint8 internal constant DIGEST_OTHER = 0; // Vec<u8>
    uint8 internal constant DIGEST_CONSENSUS = 4; // ([u8; 4], Vec<u8>)
    uint8 internal constant DIGEST_SEAL = 5; // ([u8; 4], Vec<u8>)
    uint8 internal constant DIGEST_PRE_RUNTIME = 6; // ([u8; 4], Vec<u8>)
    uint8 internal constant DIGEST_RUNTIME_ENVIRONMENT_UPDATED = 8; // no payload

    bytes4 internal constant GRANDPA_ENGINE_ID = "FRNK";

    // sp-consensus-grandpa ConsensusLog variants (the index byte of a FRNK payload).
    uint8 internal constant SCHEDULED_CHANGE = 1; // (Vec<(AuthorityId, u64)>, delay u32)
    uint8 internal constant FORCED_CHANGE = 2; // (median u32, Vec<(AuthorityId, u64)>, delay u32)
    uint8 internal constant ON_DISABLED = 3; // authority index u64
    uint8 internal constant PAUSE = 4; // delay u32
    uint8 internal constant RESUME = 5; // delay u32

    /// SCALE size of one (ed25519 public key, u64 weight) pair.
    uint256 private constant AUTHORITY_SIZE = 40;

    /// The digest item at `offset` has a tag that is not one of the five current variants.
    error UnknownDigestItem(uint8 tag, uint256 offset);
    /// The FRNK consensus log at `offset` has an index that is not a ConsensusLog variant.
    error UnknownGrandpaLog(uint8 index, uint256 offset);

    struct Authority {
        bytes32 key; // ed25519 public key
        uint64 weight;
    }

    /// One FRNK consensus log. `kind` is the variant index (SCHEDULED_CHANGE ... RESUME);
    /// fields that the variant does not carry are zero.
    struct GrandpaLog {
        uint8 kind;
        Authority[] nextAuthorities; // ScheduledChange, ForcedChange
        uint32 delay; // ScheduledChange, ForcedChange, Pause, Resume
        uint32 median; // ForcedChange: the best finalized block number it was issued at
        uint64 disabledIndex; // OnDisabled
    }

    struct Decoded {
        bytes32 hash; // blake2_256 of the encoded header: the block hash
        bytes32 parentHash;
        uint32 number;
        bytes32 stateRoot;
        bytes32 extrinsicsRoot;
        uint256 digestItems; // number of digest items, of every kind
        GrandpaLog[] grandpaLogs; // the FRNK consensus logs, in digest order
    }

    /// Decodes a header that is the whole of `encoded` and hashes it.
    function decode(bytes memory encoded) internal view returns (Decoded memory h) {
        Scale.Cursor memory c = Scale.cursor(encoded);
        h = read(c);
        c.done();
        h.hash = hash(encoded);
    }

    /// decode() for a header passed in calldata (copied to memory once).
    function decodeCalldata(bytes calldata encoded) internal view returns (Decoded memory) {
        return decode(encoded);
    }

    /// BLAKE2b-256 of the encoded header, i.e. Substrate's block hash.
    function hash(bytes memory encoded) internal view returns (bytes32) {
        // The digest is exactly 32 bytes, so the cast keeps all of it.
        // forge-lint: disable-next-line(unsafe-typecast)
        return bytes32(BLAKE2b.hash(encoded, "", "", "", 32));
    }

    /// Reads one header at the cursor. `hash` is left zero: it needs the header's exact
    /// bytes, which decode() has.
    function read(Scale.Cursor memory c) internal pure returns (Decoded memory h) {
        h.parentHash = c.readBytes32();
        h.number = c.readCompactU32();
        h.stateRoot = c.readBytes32();
        h.extrinsicsRoot = c.readBytes32();

        uint256 count = c.readLength();
        h.digestItems = count;
        GrandpaLog[] memory logs = new GrandpaLog[](count);
        uint256 found = 0;
        for (uint256 i = 0; i < count; i++) {
            uint256 at = c.offset();
            uint8 tag = c.readU8();
            if (tag == DIGEST_CONSENSUS || tag == DIGEST_SEAL || tag == DIGEST_PRE_RUNTIME) {
                bytes4 engine = c.readBytes4();
                Scale.Cursor memory payload = c.take(c.readLength());
                if (tag == DIGEST_CONSENSUS && engine == GRANDPA_ENGINE_ID) {
                    logs[found++] = readGrandpaLog(payload);
                }
            } else if (tag == DIGEST_OTHER) {
                c.skip(c.readLength());
            } else if (tag != DIGEST_RUNTIME_ENVIRONMENT_UPDATED) {
                revert UnknownDigestItem(tag, at);
            }
        }
        assembly ("memory-safe") {
            mstore(logs, found)
        }
        h.grandpaLogs = logs;
    }

    /// Decodes a FRNK consensus log; `c` must hold exactly its payload.
    function readGrandpaLog(Scale.Cursor memory c) internal pure returns (GrandpaLog memory log) {
        uint256 at = c.offset();
        log.kind = c.readU8();
        if (log.kind == SCHEDULED_CHANGE) {
            log.nextAuthorities = readAuthorities(c);
            log.delay = c.readU32();
        } else if (log.kind == FORCED_CHANGE) {
            log.median = c.readU32();
            log.nextAuthorities = readAuthorities(c);
            log.delay = c.readU32();
        } else if (log.kind == ON_DISABLED) {
            log.disabledIndex = c.readU64();
        } else if (log.kind == PAUSE || log.kind == RESUME) {
            log.delay = c.readU32();
        } else {
            revert UnknownGrandpaLog(log.kind, at);
        }
        c.done();
    }

    /// Vec<(AuthorityId, AuthorityWeight)>: compact count, then 32-byte key ‖ u64 weight each.
    function readAuthorities(Scale.Cursor memory c) internal pure returns (Authority[] memory list) {
        uint256 n = c.readLength();
        if (n * AUTHORITY_SIZE > c.remaining()) revert Scale.Truncated(c.offset(), n * AUTHORITY_SIZE);
        list = new Authority[](n);
        for (uint256 i = 0; i < n; i++) {
            list[i].key = c.readBytes32();
            list[i].weight = c.readU64();
        }
    }
}
