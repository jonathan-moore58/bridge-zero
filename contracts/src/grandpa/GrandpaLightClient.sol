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
import {Header} from "./Header.sol";
import {Justification} from "./Justification.sol";

/// Finalized state roots of a Substrate chain, by block hash.
interface IFinalizedStateRoots {
    /// Reverts with UnknownBlock if `blockHash` was not imported as finalized.
    function stateRootOf(bytes32 blockHash) external view returns (bytes32 stateRoot, uint32 number);
    function genesisHash() external view returns (bytes32);
}

/// @title GrandpaLightClient
/// @notice Follows the GRANDPA finality of one Substrate chain (Portaldot) from a checkpoint.
/// A header is accepted only with a justification in which at least N - floor((N - 1) / 3) of
/// the N authorities of the verifying set (every weight is 1) signed a precommit on exactly that
/// header. The client records the header's state root, enacts a FRNK ScheduledChange with delay
/// 0, and halts on any authority change it cannot follow (ForcedChange, a delayed or multiple
/// change, or an unusable list). No relayer is trusted: the signed message is built on chain,
/// the signer keys are read from storage and their curve points are derived on chain.
///
/// TRUSTED: the admin sets the initial checkpoint, can pause, and can re-initialise the client
/// while it is paused or halted. Every such action emits an event.
contract GrandpaLightClient is IFinalizedStateRoots {
    // ------------------------------------------------------------------ types

    /// Why the client stopped following authority changes.
    enum HaltReason {
        None,
        ForcedChange, // a FRNK ForcedChange
        DelayedChange, // a ScheduledChange with a non-zero delay
        MultipleChanges, // more than one ScheduledChange or ForcedChange in one header
        UnusableAuthoritySet // empty, above MAX_AUTHORITIES, a weight other than 1, a duplicate key, or a key that is not a curve point or has small order
    }

    struct FinalizedHeader {
        uint32 number;
        bytes32 stateRoot;
        uint64 setId; // the set that finalized it (for a checkpoint: the set installed with it)
    }

    /// One installed authority set. Sets are never removed: headers keep pointing at the set that
    /// finalized them, so a re-import is checked against it after later changes and
    /// re-initialisations.
    struct AuthoritySet {
        bytes32 genesisHash;
        bytes32 listHash; // keccak256(abi.encodePacked(keys)): the key list in _lists
        uint64 setId;
        uint32 activatedAt; // block number of the set-change header or checkpoint
    }

    /// The keys of a set and their points in the Weierstrass form SCL verifies with, derived on
    /// chain from the keys. Stored once per distinct list (mainnet rotates the set id and keeps
    /// the same keys).
    struct KeyList {
        bytes32[] keys;
        uint256[2][] points;
    }

    struct StoredHeader {
        bytes32 stateRoot;
        uint32 number;
        uint32 setIndex; // index into _sets
        bool known;
    }

    // ------------------------------------------------------------------ constants

    /// Largest set accepted. threshold(25) = 17 signatures plus a full key derivation for a new
    /// list stay within the 16,777,216 gas per-transaction cap.
    uint256 public constant MAX_AUTHORITIES = 25;

    uint8 private constant SCHEDULED_CHANGE = 1;
    uint8 private constant FORCED_CHANGE = 2;
    uint256 private constant NO_BAD_KEY = type(uint256).max;
    /// y of the ed25519 points of order 8 (the other two have y = p - Y_ORDER_8). With the
    /// points of order 1, 2 (x = 0) and 4 (y = 0) they are every point of small order.
    uint256 private constant Y_ORDER_8 = 0x05fc536d880238b13933c6d305acdfd5f098eff289f4c345b027b2c28f95e826;

    // ------------------------------------------------------------------ state

    address public admin;
    bool public halted;
    bool public paused;
    uint32 private _latestNumber;
    uint32 private _currentSet; // index into _sets

    bytes32 public genesisHash;
    bytes32 private _latestHash;

    AuthoritySet[] private _sets;
    mapping(bytes32 listHash => KeyList) private _lists;
    /// keccak256(abi.encode(genesisHash, setId)) => index into _sets + 1 (latest install wins).
    mapping(bytes32 => uint256) private _setIndexOf;
    mapping(bytes32 blockHash => StoredHeader) private _headers;

    // ------------------------------------------------------------------ events

    event Initialized(
        bytes32 indexed genesisHash,
        uint64 setId,
        bytes32 authoritySetHash,
        uint32 checkpointNumber,
        bytes32 checkpointHash
    );
    event HeaderImported(
        bytes32 indexed blockHash, uint32 indexed number, bytes32 stateRoot, uint64 setId, uint256 signatures
    );
    event AuthoritySetChanged(
        uint64 indexed oldSetId, uint64 indexed newSetId, bytes32 authoritySetHash, uint256 count, uint32 atBlock
    );
    event Halted(uint32 indexed atBlock, bytes32 blockHash, HaltReason reason);
    event Paused(address indexed admin, string reason);
    event Unpaused(address indexed admin);
    event Reinitialized(
        address indexed admin,
        bytes32 genesisHash,
        uint64 setId,
        uint32 checkpointNumber,
        bytes32 checkpointHash,
        string reason
    );
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    // ------------------------------------------------------------------ errors

    error NotAdmin();
    error ZeroAdmin();
    error AlreadyInitialized();
    error NotInitialized();
    error ClientHalted();
    error ClientPaused();
    /// reinitialize is accepted only while the client is paused or halted.
    error NotHalted();
    error EmptyAuthoritySet();
    error TooManyAuthorities(uint256 count);
    error InvalidAuthorityKey(uint256 index, bytes32 key);
    error DuplicateAuthorityKey(uint256 index, bytes32 key);
    error UnknownAuthoritySet(uint64 setId);

    error HeaderHashMismatch(bytes32 commitTarget, bytes32 computed);
    error TargetNumberMismatch(uint32 commitNumber, uint32 headerNumber);
    error FinalityProofBlockMismatch(bytes32 proofBlock, bytes32 headerHash);
    error NotNewer(uint32 number, uint32 latest);
    /// `signers` must be 2 bytes per counted precommit.
    error MalformedSigners(uint256 length);
    error BelowThreshold(uint256 signatures, uint256 required);
    error PrecommitIndexOutOfRange(uint256 i, uint256 precommit);
    error DuplicatePrecommit(uint256 i, uint256 precommit);
    error AuthorityIndexOutOfRange(uint256 i, uint256 authorityIndex, uint256 authorities);
    error DuplicateSigner(uint256 i, uint256 authorityIndex);
    error SignersOutOfOrder(uint256 i, uint256 authorityIndex, uint256 previous);
    error PrecommitNotOnTarget(uint256 i, uint256 precommit);
    error UnknownSigner(uint256 i, uint256 authorityIndex, bytes32 id);
    error InvalidSignature(uint256 i, uint256 authorityIndex);
    /// The signatures verify under `signedUnder`, not under the verifying set's id.
    error WrongSetId(uint64 expected, uint64 signedUnder);
    error UnknownBlock(bytes32 blockHash);

    // ------------------------------------------------------------------ admin (trusted)

    constructor() {
        admin = msg.sender;
        emit AdminTransferred(address(0), msg.sender);
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    /// TRUSTED. One-time checkpoint: the chain's genesis hash, the current set id and its keys
    /// (ed25519, in :grandpa_authorities order, every weight 1) and one header taken as finalized.
    /// The keys' curve points are derived here; they are never taken from a caller.
    function initialize(bytes32 genesis, uint64 setId, bytes32[] calldata keys, bytes calldata checkpointHeader)
        external
        onlyAdmin
    {
        if (_sets.length != 0) revert AlreadyInitialized();
        (bytes32 listHash, uint32 number, bytes32 hash) = _checkpoint(genesis, setId, keys, checkpointHeader);
        emit Initialized(genesis, setId, listHash, number, hash);
    }

    /// TRUSTED. Stops imports until unpause (or reinitialize).
    function pause(string calldata reason) external onlyAdmin {
        paused = true;
        emit Paused(msg.sender, reason);
    }

    /// TRUSTED. Lifts a pause. A halt stays until reinitialize.
    function unpause() external onlyAdmin {
        paused = false;
        emit Unpaused(msg.sender);
    }

    /// TRUSTED. Installs a new checkpoint while the client is paused or halted (after a testnet
    /// reset, a ForcedChange, or a client left too far behind). Imported headers and earlier
    /// authority sets are kept; the new set becomes current and the checkpoint the latest header.
    function reinitialize(
        bytes32 genesis,
        uint64 setId,
        bytes32[] calldata keys,
        bytes calldata checkpointHeader,
        string calldata reason
    ) external onlyAdmin {
        if (_sets.length == 0) revert NotInitialized();
        if (!halted && !paused) revert NotHalted();
        (, uint32 number, bytes32 hash) = _checkpoint(genesis, setId, keys, checkpointHeader);
        halted = false;
        paused = false;
        emit Reinitialized(msg.sender, genesis, setId, number, hash, reason);
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAdmin();
        emit AdminTransferred(admin, newAdmin);
        admin = newAdmin;
    }

    // ------------------------------------------------------------------ import

    /// Imports `header` with a SCALE GRANDPA justification for it. `signers` names the precommits
    /// to count, 2 bytes each: the precommit's position in the justification, then the signer's
    /// index in the verifying set; entries in strictly increasing authority index. A header that
    /// is already imported is verified again against the set that finalized it and nothing is
    /// written, so a mined call can be replayed with eth_call.
    function importHeader(bytes calldata header, bytes calldata justification, bytes calldata signers)
        external
        returns (bytes32 blockHash)
    {
        _requireActive();
        Justification.Decoded memory j = Justification.decodeCalldata(justification);
        Header.Decoded memory h = Header.decodeCalldata(header);
        return _import(h, j, signers);
    }

    /// importHeader() with the FinalityProof that grandpa_proveFinality returns (it must prove
    /// `header` itself and carry no unknown headers).
    function importFinalityProof(bytes calldata header, bytes calldata finalityProof, bytes calldata signers)
        external
        returns (bytes32 blockHash)
    {
        _requireActive();
        Justification.FinalityProof memory p = Justification.decodeFinalityProofCalldata(finalityProof);
        Header.Decoded memory h = Header.decodeCalldata(header);
        if (p.blockHash != h.hash) revert FinalityProofBlockMismatch(p.blockHash, h.hash);
        return _import(h, p.justification, signers);
    }

    // ------------------------------------------------------------------ views

    function stateRootOf(bytes32 blockHash) external view returns (bytes32 stateRoot, uint32 number) {
        StoredHeader storage s = _known(blockHash);
        return (s.stateRoot, s.number);
    }

    function headerOf(bytes32 blockHash) external view returns (FinalizedHeader memory) {
        StoredHeader storage s = _known(blockHash);
        return FinalizedHeader(s.number, s.stateRoot, _sets[s.setIndex].setId);
    }

    function isImported(bytes32 blockHash) external view returns (bool) {
        return _headers[blockHash].known;
    }

    function initialized() external view returns (bool) {
        return _sets.length != 0;
    }

    function currentSetId() external view returns (uint64) {
        _requireInitialized();
        return _sets[_currentSet].setId;
    }

    /// Signatures required from the current set: N - floor((N - 1) / 3).
    function threshold() external view returns (uint256) {
        _requireInitialized();
        return _threshold(_lists[_sets[_currentSet].listHash].keys.length);
    }

    function latestFinalized() external view returns (bytes32 blockHash, uint32 number) {
        return (_latestHash, _latestNumber);
    }

    /// The keys of set `setId` of the current genesis (the latest install of that id).
    function authorities(uint64 setId) external view returns (bytes32[] memory) {
        return _lists[_sets[_setIndex(setId)].listHash].keys;
    }

    /// SCL's extended key for authority `index` of set `setId`: [Wx, Wy, 0, 0, key].
    function extendedKey(uint64 setId, uint256 index) external view returns (uint256[5] memory ext) {
        KeyList storage list = _lists[_sets[_setIndex(setId)].listHash];
        ext = [list.points[index][0], list.points[index][1], 0, 0, uint256(list.keys[index])];
    }

    /// Every set installed so far, in order (index 0 is the first checkpoint).
    function authoritySetCount() external view returns (uint256) {
        return _sets.length;
    }

    function authoritySetAt(uint256 index) external view returns (AuthoritySet memory set, bytes32[] memory keys) {
        set = _sets[index];
        keys = _lists[set.listHash].keys;
    }

    // ------------------------------------------------------------------ internals: import

    function _import(Header.Decoded memory h, Justification.Decoded memory j, bytes calldata signers)
        private
        returns (bytes32)
    {
        if (j.targetHash != h.hash) revert HeaderHashMismatch(j.targetHash, h.hash);
        if (j.targetNumber != h.number) revert TargetNumberMismatch(j.targetNumber, h.number);

        StoredHeader storage stored = _headers[h.hash];
        if (stored.known) {
            // Verified in full against the set that finalized it; nothing is written.
            _verify(j, signers, _sets[stored.setIndex]);
            return h.hash;
        }
        if (h.number <= _latestNumber) revert NotNewer(h.number, _latestNumber);

        uint32 setIndex = _currentSet;
        uint256 signatures = _verify(j, signers, _sets[setIndex]);
        stored.stateRoot = h.stateRoot;
        stored.number = h.number;
        stored.setIndex = setIndex;
        stored.known = true;
        _latestHash = h.hash;
        _latestNumber = h.number;
        emit HeaderImported(h.hash, h.number, h.stateRoot, _sets[setIndex].setId, signatures);

        _enactAuthorityChange(h);
        return h.hash;
    }

    /// Counts the precommits named by `signers` against set `setIndex`; reverts on the first
    /// check that fails. Returns the number of valid signatures (at least the threshold).
    function _verify(Justification.Decoded memory j, bytes calldata signers, AuthoritySet storage set)
        private
        view
        returns (uint256 count)
    {
        if (signers.length % 2 != 0) revert MalformedSigners(signers.length);
        uint256 n = _lists[set.listHash].keys.length;
        count = signers.length / 2;
        if (count < _threshold(n)) revert BelowThreshold(count, _threshold(n));

        bytes memory payload = Justification.signedPayload(j.targetHash, j.targetNumber, j.round, set.setId);
        uint256 usedPrecommits = 0; // bitmap of positions already counted
        uint256 previous = 0;
        for (uint256 i = 0; i < count; i++) {
            uint256 position = uint8(signers[2 * i]);
            uint256 index = uint8(signers[2 * i + 1]);
            if (position >= j.precommits.length) revert PrecommitIndexOutOfRange(i, position);
            if (usedPrecommits & (1 << position) != 0) revert DuplicatePrecommit(i, position);
            usedPrecommits |= 1 << position;
            if (index >= n) revert AuthorityIndexOutOfRange(i, index, n);
            if (i != 0) {
                if (index == previous) revert DuplicateSigner(i, index);
                if (index < previous) revert SignersOutOfOrder(i, index, previous);
            }
            previous = index;
            _verifyOne(j, i, position, index, set, payload);
        }
    }

    /// Checks counted precommit `i` (at `position`) as authority `index` of `list`.
    function _verifyOne(
        Justification.Decoded memory j,
        uint256 i,
        uint256 position,
        uint256 index,
        AuthoritySet storage set,
        bytes memory payload
    ) private view {
        Justification.Precommit memory pc = j.precommits[position];
        KeyList storage list = _lists[set.listHash];
        if (pc.targetHash != j.targetHash || pc.targetNumber != j.targetNumber) {
            revert PrecommitNotOnTarget(i, position);
        }
        bytes32 key = list.keys[index];
        if (pc.authorityId != key) revert UnknownSigner(i, index, pc.authorityId);
        uint256[2] storage point = list.points[index];
        uint256[5] memory ext = [point[0], point[1], 0, 0, uint256(key)];
        if (!SCL_EIP6565.Verify_LE(string(payload), uint256(pc.r), uint256(pc.s), ext)) {
            // A whole justification is signed under one set id. If the first signature verifies
            // under a neighbouring id, say so instead of only "invalid signature".
            if (i == 0) _probeSetId(j, pc, ext, set.setId);
            revert InvalidSignature(i, index);
        }
    }

    function _probeSetId(
        Justification.Decoded memory j,
        Justification.Precommit memory pc,
        uint256[5] memory ext,
        uint64 setId
    ) private view {
        uint64[2] memory others = [setId - (setId == 0 ? 0 : 1), setId + 1];
        for (uint256 k = 0; k < 2; k++) {
            if (others[k] == setId) continue;
            bytes memory m = Justification.signedPayload(j.targetHash, j.targetNumber, j.round, others[k]);
            if (SCL_EIP6565.Verify_LE(string(m), uint256(pc.r), uint256(pc.s), ext)) {
                revert WrongSetId(setId, others[k]);
            }
        }
    }

    /// Applies the header's FRNK authority-change logs: a ScheduledChange with delay 0 moves to
    /// set_id + 1 with the digest's list; anything else that changes authorities halts.
    function _enactAuthorityChange(Header.Decoded memory h) private {
        Header.GrandpaLog memory change;
        uint256 changes;
        for (uint256 i = 0; i < h.grandpaLogs.length; i++) {
            uint8 kind = h.grandpaLogs[i].kind;
            if (kind == SCHEDULED_CHANGE || kind == FORCED_CHANGE) {
                change = h.grandpaLogs[i];
                changes++;
            }
        }
        if (changes == 0) return;
        if (changes > 1) return _halt(h, HaltReason.MultipleChanges);
        if (change.kind == FORCED_CHANGE) return _halt(h, HaltReason.ForcedChange);
        if (change.delay != 0) return _halt(h, HaltReason.DelayedChange);

        Header.Authority[] memory next = change.nextAuthorities;
        bytes32[] memory keys = new bytes32[](next.length);
        for (uint256 i = 0; i < next.length; i++) {
            if (next[i].weight != 1) return _halt(h, HaltReason.UnusableAuthoritySet);
            keys[i] = next[i].key;
        }
        if (keys.length == 0 || keys.length > MAX_AUTHORITIES) return _halt(h, HaltReason.UnusableAuthoritySet);
        (bytes32 listHash, uint256 bad,) = _storeKeys(keys);
        if (bad != NO_BAD_KEY) return _halt(h, HaltReason.UnusableAuthoritySet);

        AuthoritySet storage old = _sets[_currentSet];
        uint64 newSetId = old.setId + 1;
        _installSet(old.genesisHash, newSetId, listHash, h.number);
        emit AuthoritySetChanged(newSetId - 1, newSetId, listHash, keys.length, h.number);
    }

    function _halt(Header.Decoded memory h, HaltReason reason) private {
        halted = true;
        emit Halted(h.number, h.hash, reason);
    }

    // ------------------------------------------------------------------ internals: sets

    function _checkpoint(bytes32 genesis, uint64 setId, bytes32[] calldata keys, bytes calldata checkpointHeader)
        private
        returns (bytes32 listHash, uint32 number, bytes32 hash)
    {
        if (keys.length == 0) revert EmptyAuthoritySet();
        if (keys.length > MAX_AUTHORITIES) revert TooManyAuthorities(keys.length);
        uint256 bad;
        bool duplicate;
        (listHash, bad, duplicate) = _storeKeys(keys);
        if (bad != NO_BAD_KEY) {
            if (duplicate) revert DuplicateAuthorityKey(bad, keys[bad]);
            revert InvalidAuthorityKey(bad, keys[bad]);
        }

        Header.Decoded memory h = Header.decodeCalldata(checkpointHeader);
        number = h.number;
        hash = h.hash;
        genesisHash = genesis;
        uint32 setIndex = _installSet(genesis, setId, listHash, number);
        StoredHeader storage stored = _headers[hash];
        if (!stored.known) {
            stored.stateRoot = h.stateRoot;
            stored.number = number;
            stored.setIndex = setIndex;
            stored.known = true;
        }
        _latestHash = hash;
        _latestNumber = number;
    }

    function _installSet(bytes32 genesis, uint64 setId, bytes32 listHash, uint32 activatedAt)
        private
        returns (uint32 index)
    {
        index = uint32(_sets.length);
        _sets.push(AuthoritySet(genesis, listHash, setId, activatedAt));
        _setIndexOf[keccak256(abi.encode(genesis, setId))] = uint256(index) + 1;
        _currentSet = index;
    }

    /// Stores `keys` with their points, derived here, unless the list is already stored. On a
    /// duplicate or invalid key nothing is written and `bad` is its index (NO_BAD_KEY otherwise).
    /// The caller checks the list length.
    function _storeKeys(bytes32[] memory keys) private returns (bytes32 listHash, uint256 bad, bool duplicate) {
        listHash = keccak256(abi.encodePacked(keys));
        bad = NO_BAD_KEY;
        KeyList storage list = _lists[listHash];
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

    // ------------------------------------------------------------------ internals: misc

    function _threshold(uint256 n) private pure returns (uint256) {
        return n - (n - 1) / 3;
    }

    function _setIndex(uint64 setId) private view returns (uint256) {
        uint256 i = _setIndexOf[keccak256(abi.encode(genesisHash, setId))];
        if (i == 0) revert UnknownAuthoritySet(setId);
        return i - 1;
    }

    function _known(bytes32 blockHash) private view returns (StoredHeader storage s) {
        s = _headers[blockHash];
        if (!s.known) revert UnknownBlock(blockHash);
    }

    function _requireInitialized() private view {
        if (_sets.length == 0) revert NotInitialized();
    }

    function _requireActive() private view {
        _requireInitialized();
        if (halted) revert ClientHalted();
        if (paused) revert ClientPaused();
    }
}
