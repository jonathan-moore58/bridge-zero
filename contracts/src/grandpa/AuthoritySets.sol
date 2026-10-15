// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {SCL_EIP6565} from "crypto-lib/lib/libSCL_EIP6565.sol";
import {SCL_sha512} from "crypto-lib/hash/SCL_sha512.sol";
import {ModInv} from "crypto-lib/modular/SCL_modular.sol";
import {
    p as P25519,
    d as D25519,
    sqrtm1 as SQRT_M1,
    pp3div8 as P_PLUS_3_DIV_8
} from "crypto-lib/fields/SCL_wei25519.sol";
import {GrandpaLightClient} from "./GrandpaLightClient.sol";
import {GrandpaCodec} from "./GrandpaCodec.sol";
import {Justification} from "./Justification.sol";

/// @title AuthoritySets
/// @notice The authority-set bookkeeping of GrandpaLightClient: checks a key list, derives on
/// chain the curve points SCL verifies signatures with, stores the list and installs the set,
/// installs checkpoints, and finds the set id a rejected signature was made under. Deployed once as a library of its own and linked into the light client,
/// which reaches it with DELEGATECALL on its own storage (`Store`), so every write lands in the
/// light client. It links SCL_EIP6565 and GrandpaCodec. Errors are the light client's own.
///
/// The points are never taken from a caller: a planted point would let anyone forge signatures.
library AuthoritySets {
    /// The light client's whole state, in the storage layout it has always had (admin, halted,
    /// paused and the latest header's number share slot 0).
    struct Store {
        address admin;
        bool halted;
        bool paused;
        uint32 latestNumber;
        uint32 currentSet; // index into sets
        bytes32 genesisHash; // of the current checkpoint
        bytes32 latestHash;
        GrandpaLightClient.AuthoritySet[] sets;
        mapping(bytes32 listHash => GrandpaLightClient.KeyList) lists;
        /// keccak256(abi.encode(genesisHash, setId)) => index into sets + 1 (latest install wins).
        mapping(bytes32 => uint256) setIndexOf;
        mapping(bytes32 blockHash => GrandpaLightClient.StoredHeader) headers;
    }

    /// `bad` when every key of a list is usable.
    uint256 internal constant NO_BAD_KEY = type(uint256).max;
    /// y of the ed25519 points of order 8 (the other two have y = p - Y_ORDER_8). With the
    /// points of order 1, 2 (x = 0) and 4 (y = 0) they are every point of small order.
    uint256 private constant Y_ORDER_8 = 0x05fc536d880238b13933c6d305acdfd5f098eff289f4c345b027b2c28f95e826;

    // ------------------------------------------------------------------ checkpoints

    /// Installs set `setId` of `genesis` with `keys` and takes `checkpointHeader` as finalized and
    /// latest. Reverts on an empty, oversized, duplicate or invalid key list, and on a header that
    /// does not decode.
    function checkpoint(
        Store storage s,
        bytes32 genesis,
        uint64 setId,
        bytes32[] calldata keys,
        bytes calldata checkpointHeader,
        uint256 maxAuthorities
    ) external returns (bytes32 listHash, uint32 number, bytes32 hash) {
        if (keys.length == 0) revert GrandpaLightClient.EmptyAuthoritySet();
        if (keys.length > maxAuthorities) revert GrandpaLightClient.TooManyAuthorities(keys.length);
        listHash = _storeCheckedKeys(s, keys);
        (number, hash) = _installCheckpoint(s, genesis, setId, listHash, checkpointHeader);
    }

    /// _storeKeys(), reverting on a duplicate or invalid key.
    function _storeCheckedKeys(Store storage s, bytes32[] calldata keys) private returns (bytes32 listHash) {
        uint256 bad;
        bool duplicate;
        (listHash, bad, duplicate) = _storeKeys(s, keys);
        if (bad != NO_BAD_KEY) {
            if (duplicate) revert GrandpaLightClient.DuplicateAuthorityKey(bad, keys[bad]);
            revert GrandpaLightClient.InvalidAuthorityKey(bad, keys[bad]);
        }
    }

    function _installCheckpoint(
        Store storage s,
        bytes32 genesis,
        uint64 setId,
        bytes32 listHash,
        bytes calldata checkpointHeader
    ) private returns (uint32 number, bytes32 hash) {
        GrandpaCodec.DecodedHeader memory h = GrandpaCodec.decodeHeader(checkpointHeader);
        number = h.number;
        hash = h.hash;
        s.genesisHash = genesis;
        uint32 setIndex = _installSet(s, genesis, setId, listHash, number);
        GrandpaLightClient.StoredHeader storage stored = s.headers[hash];
        if (!stored.known) {
            stored.stateRoot = h.stateRoot;
            stored.number = number;
            stored.setIndex = setIndex;
            stored.known = true;
        }
        s.latestHash = hash;
        s.latestNumber = number;
    }

    // ------------------------------------------------------------------ set changes

    /// Enacts the FRNK authority change of `header` (already imported): a ScheduledChange with
    /// delay 0 and every weight 1 moves to set_id + 1 of the current set with its list. Returns a
    /// HaltReason other than None, and writes nothing, for anything else that changes authorities
    /// or for a list that is empty, above `maxAuthorities`, or has a duplicate or invalid key.
    function enactChange(Store storage s, bytes calldata header, uint256 maxAuthorities)
        external
        returns (uint8 haltReason, bytes32 listHash, uint64 newSetId, uint256 count)
    {
        GrandpaCodec.DecodedHeader memory h = GrandpaCodec.decodeHeader(header);
        if (!h.authorityChange) return (GrandpaCodec.HALT_NONE, 0, 0, 0);
        if (h.haltReason != GrandpaCodec.HALT_NONE) return (h.haltReason, 0, 0, 0);
        bytes32[] memory keys = h.nextKeys;
        count = keys.length;
        if (count == 0 || count > maxAuthorities) return (GrandpaCodec.HALT_UNUSABLE_AUTHORITY_SET, 0, 0, 0);
        uint256 bad;
        (listHash, bad,) = _storeKeys(s, keys);
        if (bad != NO_BAD_KEY) return (GrandpaCodec.HALT_UNUSABLE_AUTHORITY_SET, 0, 0, 0);

        GrandpaLightClient.AuthoritySet storage old = s.sets[s.currentSet];
        newSetId = old.setId + 1;
        _installSet(s, old.genesisHash, newSetId, listHash, h.number);
    }

    // ------------------------------------------------------------------ signatures

    /// For a signature that does not verify under `setId`: the neighbouring set id (setId - 1 or
    /// setId + 1) it verifies under, if any. A whole justification is signed under one set id, so
    /// the light client reports the mismatch instead of only "invalid signature".
    function signedUnderNeighbour(
        bytes32 targetHash,
        uint32 targetNumber,
        uint64 round,
        uint64 setId,
        uint256 r,
        uint256 sig,
        uint256[5] memory ext
    ) external view returns (bool found, uint64 other) {
        uint64[2] memory others = [setId - (setId == 0 ? 0 : 1), setId + 1];
        for (uint256 k = 0; k < 2; k++) {
            if (others[k] == setId) continue;
            bytes memory m = Justification.signedPayload(targetHash, targetNumber, round, others[k]);
            if (SCL_EIP6565.Verify_LE(string(m), r, sig, ext)) return (true, others[k]);
        }
    }

    // ------------------------------------------------------------------ keys

    /// Decompresses an ed25519 public key (RFC 8032, 5.1.3) and converts the point to the
    /// Weierstrass form SCL verifies with. Returns false for a key that is not the canonical
    /// encoding of a curve point, or that is a point of small order (1, 2, 4 or 8): anyone can
    /// produce signatures that verify under such a key, without a secret.
    function deriveKey(bytes32 key) public view returns (bool ok, uint256 wx, uint256 wy) {
        uint256 y = SCL_sha512.Swap256(uint256(key)); // little-endian y, sign of x in bit 255
        uint256 sign = y >> 255;
        y &= (uint256(1) << 255) - 1;
        if (y >= P25519) return (false, 0, 0);
        uint256 yy = mulmod(y, y, P25519);
        uint256 u = addmod(yy, P25519 - 1, P25519); // y^2 - 1
        uint256 v = addmod(mulmod(D25519, yy, P25519), 1, P25519); // d y^2 + 1, never 0
        uint256 xx = mulmod(u, ModInv(v, P25519), P25519);
        uint256 x = _modexp(xx, P_PLUS_3_DIV_8);
        if (mulmod(x, x, P25519) != xx) x = mulmod(x, SQRT_M1, P25519);
        if (mulmod(x, x, P25519) != xx || x == 0) return (false, 0, 0);
        if (y == 0 || y == Y_ORDER_8 || y == P25519 - Y_ORDER_8) return (false, 0, 0);
        if (x & 1 != sign) x = P25519 - x;
        (wx, wy) = SCL_EIP6565.Edwards2WeierStrass(x, y);
        ok = true;
    }

    // ------------------------------------------------------------------ internals

    function _installSet(Store storage s, bytes32 genesis, uint64 setId, bytes32 listHash, uint32 activatedAt)
        private
        returns (uint32 index)
    {
        index = uint32(s.sets.length);
        s.sets.push(GrandpaLightClient.AuthoritySet(genesis, listHash, setId, activatedAt));
        s.setIndexOf[keccak256(abi.encode(genesis, setId))] = uint256(index) + 1;
        s.currentSet = index;
    }

    /// Stores `keys` with their points, derived here, unless the list is already stored. On a
    /// duplicate or invalid key nothing is written and `bad` is its index (NO_BAD_KEY otherwise).
    /// The caller checks the list length.
    function _storeKeys(Store storage s, bytes32[] memory keys)
        private
        returns (bytes32 listHash, uint256 bad, bool duplicate)
    {
        listHash = keccak256(abi.encodePacked(keys));
        bad = NO_BAD_KEY;
        GrandpaLightClient.KeyList storage list = s.lists[listHash];
        if (list.keys.length != 0) return (listHash, bad, false);
        uint256[2][] memory points = new uint256[2][](keys.length);
        for (uint256 i = 0; i < keys.length; i++) {
            for (uint256 k = 0; k < i; k++) {
                if (keys[k] == keys[i]) return (listHash, i, true);
            }
            (bool valid, uint256 wx, uint256 wy) = deriveKey(keys[i]);
            if (!valid) return (listHash, i, false);
            points[i] = [wx, wy];
        }
        for (uint256 i = 0; i < keys.length; i++) {
            list.keys.push(keys[i]);
            list.points.push(points[i]);
        }
    }

    function _modexp(uint256 base, uint256 exponent) private view returns (uint256 r) {
        assembly ("memory-safe") {
            let m := mload(0x40)
            mstore(m, 0x20)
            mstore(add(m, 0x20), 0x20)
            mstore(add(m, 0x40), 0x20)
            mstore(add(m, 0x60), base)
            mstore(add(m, 0x80), exponent)
            mstore(add(m, 0xa0), P25519)
            if iszero(staticcall(gas(), 0x05, m, 0xc0, m, 0x20)) { revert(0, 0) }
            r := mload(m)
        }
    }
}
