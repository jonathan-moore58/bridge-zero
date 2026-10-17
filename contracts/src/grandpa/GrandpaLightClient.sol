// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {SCL_EIP6565} from "crypto-lib/lib/libSCL_EIP6565.sol";
import {AuthoritySets} from "./AuthoritySets.sol";
import {Justification} from "./Justification.sol";
import {GrandpaCodec} from "./GrandpaCodec.sol";
import {Scale} from "./Scale.sol";

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
///
/// Deployed with three linked libraries, so that no deployment needs more than the per-transaction
/// gas cap where new code is priced per byte: SCL_EIP6565 (ed25519 verification), GrandpaCodec
/// (SCALE decoding of headers and justifications) and AuthoritySets (key checks and derivation,
/// set and checkpoint bookkeeping, run with DELEGATECALL on this contract's storage). The
/// signature loop and the storage stay here.
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
        bytes32 listHash; // keccak256(abi.encodePacked(keys)): the key list in _s.lists
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
        uint32 setIndex; // index into _s.sets
        bool known;
    }

    // ------------------------------------------------------------------ constants

    /// Largest set accepted. Under Sepolia's gas rules a change from 16 authorities (threshold 11)
    /// to 16 new keys, derived and stored in the same transaction, costs about 15.3M of the
    /// 16,777,216 per-transaction cap; from 18 up it does not fit (docs/GAS.md).
    uint256 public constant MAX_AUTHORITIES = 16;

    // ------------------------------------------------------------------ state

    /// admin, halted, paused, genesisHash, the sets, key lists and headers. AuthoritySets writes
    /// it too (DELEGATECALL); the getters are below.
    AuthoritySets.Store private _s;

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
        _s.admin = msg.sender;
        emit AdminTransferred(address(0), msg.sender);
    }

    modifier onlyAdmin() {
        if (msg.sender != _s.admin) revert NotAdmin();
        _;
    }

    /// TRUSTED. One-time checkpoint: the chain's genesis hash, the current set id and its keys
    /// (ed25519, in :grandpa_authorities order, every weight 1) and one header taken as finalized.
    /// The keys' curve points are derived here; they are never taken from a caller.
    function initialize(bytes32 genesis, uint64 setId, bytes32[] calldata keys, bytes calldata checkpointHeader)
        external
        onlyAdmin
    {
        if (_s.sets.length != 0) revert AlreadyInitialized();
        (bytes32 listHash, uint32 number, bytes32 hash) =
            AuthoritySets.checkpoint(_s, genesis, setId, keys, checkpointHeader, MAX_AUTHORITIES);
        emit Initialized(genesis, setId, listHash, number, hash);
    }

    /// TRUSTED. Stops imports until unpause (or reinitialize).
    function pause(string calldata reason) external onlyAdmin {
        _s.paused = true;
        emit Paused(msg.sender, reason);
    }

    /// TRUSTED. Lifts a pause. A halt stays until reinitialize.
    function unpause() external onlyAdmin {
        _s.paused = false;
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
        if (_s.sets.length == 0) revert NotInitialized();
        if (!_s.halted && !_s.paused) revert NotHalted();
        (, uint32 number, bytes32 hash) =
            AuthoritySets.checkpoint(_s, genesis, setId, keys, checkpointHeader, MAX_AUTHORITIES);
        _s.halted = false;
        _s.paused = false;
        emit Reinitialized(msg.sender, genesis, setId, number, hash, reason);
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAdmin();
        emit AdminTransferred(_s.admin, newAdmin);
        _s.admin = newAdmin;
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
        (GrandpaCodec.HeaderInfo memory h, GrandpaCodec.Commit memory j) =
            GrandpaCodec.decodeImport(header, justification, false);
        return _import(h, j, _precommits(justification, j), signers, header);
    }

    /// importHeader() with the FinalityProof that grandpa_proveFinality returns (it must prove
    /// `header` itself and carry no unknown headers).
    function importFinalityProof(bytes calldata header, bytes calldata finalityProof, bytes calldata signers)
        external
        returns (bytes32 blockHash)
    {
        _requireActive();
        (GrandpaCodec.HeaderInfo memory h, GrandpaCodec.Commit memory j) =
            GrandpaCodec.decodeImport(header, finalityProof, true);
        if (j.blockHash != h.hash) revert FinalityProofBlockMismatch(j.blockHash, h.hash);
        return _import(h, j, _precommits(finalityProof, j), signers, header);
    }

    // ------------------------------------------------------------------ views

    function admin() external view returns (address) {
        return _s.admin;
    }

    /// True after an authority change the client cannot follow; imports stop until reinitialize.
    function halted() external view returns (bool) {
        return _s.halted;
    }

    function paused() external view returns (bool) {
        return _s.paused;
    }

    /// The genesis hash of the current checkpoint's chain.
    function genesisHash() external view returns (bytes32) {
        return _s.genesisHash;
    }

    function stateRootOf(bytes32 blockHash) external view returns (bytes32 stateRoot, uint32 number) {
        StoredHeader storage s = _known(blockHash);
        return (s.stateRoot, s.number);
    }

    function headerOf(bytes32 blockHash) external view returns (FinalizedHeader memory) {
        StoredHeader storage s = _known(blockHash);
        return FinalizedHeader(s.number, s.stateRoot, _s.sets[s.setIndex].setId);
    }

    function isImported(bytes32 blockHash) external view returns (bool) {
        return _s.headers[blockHash].known;
    }

    function initialized() external view returns (bool) {
        return _s.sets.length != 0;
    }

    function currentSetId() external view returns (uint64) {
        _requireInitialized();
        return _s.sets[_s.currentSet].setId;
    }

    /// Signatures required from the current set: N - floor((N - 1) / 3).
    function threshold() external view returns (uint256) {
        _requireInitialized();
        return _threshold(_s.lists[_s.sets[_s.currentSet].listHash].keys.length);
    }

    function latestFinalized() external view returns (bytes32 blockHash, uint32 number) {
        return (_s.latestHash, _s.latestNumber);
    }

    /// The keys of set `setId` of the current genesis (the latest install of that id).
    function authorities(uint64 setId) external view returns (bytes32[] memory) {
        return _s.lists[_s.sets[_setIndex(setId)].listHash].keys;
    }

    /// SCL's extended key for authority `index` of set `setId`: [Wx, Wy, 0, 0, key].
    function extendedKey(uint64 setId, uint256 index) external view returns (uint256[5] memory ext) {
        KeyList storage list = _s.lists[_s.sets[_setIndex(setId)].listHash];
        ext = [list.points[index][0], list.points[index][1], 0, 0, uint256(list.keys[index])];
    }

    /// Every set installed so far, in order (index 0 is the first checkpoint).
    function authoritySetCount() external view returns (uint256) {
        return _s.sets.length;
    }

    function authoritySetAt(uint256 index) external view returns (AuthoritySet memory set, bytes32[] memory keys) {
        set = _s.sets[index];
        keys = _s.lists[set.listHash].keys;
    }

    // ------------------------------------------------------------------ internals: import

    /// The signed precommits of `j`, as GrandpaCodec located them in `encoded`.
    function _precommits(bytes calldata encoded, GrandpaCodec.Commit memory j) private pure returns (bytes calldata) {
        return encoded[j.precommitsAt:j.precommitsAt + j.precommits * GrandpaCodec.PRECOMMIT_SIZE];
    }

    function _import(
        GrandpaCodec.HeaderInfo memory h,
        GrandpaCodec.Commit memory j,
        bytes calldata precommits,
        bytes calldata signers,
        bytes calldata header
    ) private returns (bytes32) {
        if (j.targetHash != h.hash) revert HeaderHashMismatch(j.targetHash, h.hash);
        if (j.targetNumber != h.number) revert TargetNumberMismatch(j.targetNumber, h.number);

        StoredHeader storage stored = _s.headers[h.hash];
        if (stored.known) {
            // Verified in full against the set that finalized it; nothing is written.
            _verify(j, precommits, signers, _s.sets[stored.setIndex]);
            return h.hash;
        }
        if (h.number <= _s.latestNumber) revert NotNewer(h.number, _s.latestNumber);

        uint32 setIndex = _s.currentSet;
        uint256 signatures = _verify(j, precommits, signers, _s.sets[setIndex]);
        stored.stateRoot = h.stateRoot;
        stored.number = h.number;
        stored.setIndex = setIndex;
        stored.known = true;
        _s.latestHash = h.hash;
        _s.latestNumber = h.number;
        emit HeaderImported(h.hash, h.number, h.stateRoot, _s.sets[setIndex].setId, signatures);

        if (h.authorityChange) _enactAuthorityChange(h, header);
        return h.hash;
    }

    /// Counts the precommits named by `signers` against set `setIndex`; reverts on the first
    /// check that fails. Returns the number of valid signatures (at least the threshold).
    function _verify(
        GrandpaCodec.Commit memory j,
        bytes calldata precommits,
        bytes calldata signers,
        AuthoritySet storage set
    ) private view returns (uint256 count) {
        if (signers.length % 2 != 0) revert MalformedSigners(signers.length);
        uint256 n = _s.lists[set.listHash].keys.length;
        count = signers.length / 2;
        if (count < _threshold(n)) revert BelowThreshold(count, _threshold(n));

        bytes memory payload = Justification.signedPayload(j.targetHash, j.targetNumber, j.round, set.setId);
        uint256 usedPrecommits = 0; // bitmap of positions already counted
        uint256 previous = 0;
        for (uint256 i = 0; i < count; i++) {
            uint256 position = uint8(signers[2 * i]);
            uint256 index = uint8(signers[2 * i + 1]);
            if (position >= j.precommits) revert PrecommitIndexOutOfRange(i, position);
            if (usedPrecommits & (1 << position) != 0) revert DuplicatePrecommit(i, position);
            usedPrecommits |= 1 << position;
            if (index >= n) revert AuthorityIndexOutOfRange(i, index, n);
            if (i != 0) {
                if (index == previous) revert DuplicateSigner(i, index);
                if (index < previous) revert SignersOutOfOrder(i, index, previous);
            }
            previous = index;
            _verifyOne(j, precommits, i, position, index, set, payload);
        }
    }

    /// Checks counted precommit `i` (at `position`) as authority `index` of `set`.
    function _verifyOne(
        GrandpaCodec.Commit memory j,
        bytes calldata precommits,
        uint256 i,
        uint256 position,
        uint256 index,
        AuthoritySet storage set,
        bytes memory payload
    ) private view {
        // target_hash [32] | target_number u32le [4] | R [32] | s [32] | id [32]
        bytes calldata pc =
            precommits[position * GrandpaCodec.PRECOMMIT_SIZE:(position + 1) * GrandpaCodec.PRECOMMIT_SIZE];
        uint256[5] memory ext = _signerKey(j, pc, i, position, index, set);
        if (!SCL_EIP6565.Verify_LE(string(payload), uint256(bytes32(pc[36:68])), uint256(bytes32(pc[68:100])), ext)) {
            // A whole justification is signed under one set id. If the first signature verifies
            // under a neighbouring id, say so instead of only "invalid signature".
            if (i == 0) _probeSetId(j, pc, ext, set.setId);
            revert InvalidSignature(i, index);
        }
    }

    /// The SCL extended key of authority `index`, after checking that precommit `pc` is on the
    /// commit target and names that authority.
    function _signerKey(
        GrandpaCodec.Commit memory j,
        bytes calldata pc,
        uint256 i,
        uint256 position,
        uint256 index,
        AuthoritySet storage set
    ) private view returns (uint256[5] memory ext) {
        if (bytes32(pc[0:32]) != j.targetHash || Scale.swap32(uint32(bytes4(pc[32:36]))) != j.targetNumber) {
            revert PrecommitNotOnTarget(i, position);
        }
        KeyList storage list = _s.lists[set.listHash];
        bytes32 key = list.keys[index];
        if (bytes32(pc[100:132]) != key) revert UnknownSigner(i, index, bytes32(pc[100:132]));
        uint256[2] storage point = list.points[index];
        ext = [point[0], point[1], 0, 0, uint256(key)];
    }

    function _probeSetId(GrandpaCodec.Commit memory j, bytes calldata pc, uint256[5] memory ext, uint64 setId)
        private
        view
    {
        (bool found, uint64 other) = AuthoritySets.signedUnderNeighbour(
            j.targetHash, j.targetNumber, j.round, setId, uint256(bytes32(pc[36:68])), uint256(bytes32(pc[68:100])), ext
        );
        if (found) revert WrongSetId(setId, other);
    }

    /// Applies the header's FRNK authority change (AuthoritySets.enactChange): a ScheduledChange
    /// with delay 0 moves to set_id + 1 with the digest's list; anything else that changes
    /// authorities halts.
    function _enactAuthorityChange(GrandpaCodec.HeaderInfo memory h, bytes calldata header) private {
        (uint8 reason, bytes32 listHash, uint64 newSetId, uint256 count) =
            AuthoritySets.enactChange(_s, header, MAX_AUTHORITIES);
        if (reason != GrandpaCodec.HALT_NONE) return _halt(h, HaltReason(reason));
        emit AuthoritySetChanged(newSetId - 1, newSetId, listHash, count, h.number);
    }

    function _halt(GrandpaCodec.HeaderInfo memory h, HaltReason reason) private {
        _s.halted = true;
        emit Halted(h.number, h.hash, reason);
    }

    // ------------------------------------------------------------------ keys

    /// Decompresses an ed25519 public key (RFC 8032, 5.1.3) and converts the point to the
    /// Weierstrass form SCL verifies with (AuthoritySets.deriveKey). Returns false for a key that
    /// is not the canonical encoding of a curve point, or that is a point of small order (1, 2, 4
    /// or 8): anyone can produce signatures that verify under such a key, without a secret.
    function deriveKey(bytes32 key) public view returns (bool ok, uint256 wx, uint256 wy) {
        return AuthoritySets.deriveKey(key);
    }

    // ------------------------------------------------------------------ internals: misc

    function _threshold(uint256 n) private pure returns (uint256) {
        return n - (n - 1) / 3;
    }

    function _setIndex(uint64 setId) private view returns (uint256) {
        uint256 i = _s.setIndexOf[keccak256(abi.encode(_s.genesisHash, setId))];
        if (i == 0) revert UnknownAuthoritySet(setId);
        return i - 1;
    }

    function _known(bytes32 blockHash) private view returns (StoredHeader storage s) {
        s = _s.headers[blockHash];
        if (!s.known) revert UnknownBlock(blockHash);
    }

    function _requireInitialized() private view {
        if (_s.sets.length == 0) revert NotInitialized();
    }

    function _requireActive() private view {
        _requireInitialized();
        if (_s.halted) revert ClientHalted();
        if (_s.paused) revert ClientPaused();
    }
}
