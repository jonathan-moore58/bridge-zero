// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {SCL_EIP6565} from "crypto-lib/lib/libSCL_EIP6565.sol";
import {SCL_sha512} from "crypto-lib/hash/SCL_sha512.sol";
import {ModInv} from "crypto-lib/modular/SCL_modular.sol";
import {
    n as N25519,
    p as P25519,
    d as D25519,
    sqrtm1 as SQRT_M1,
    pp3div8 as P_PLUS_3_DIV_8
} from "crypto-lib/fields/SCL_wei25519.sol";
import {GrandpaLightClient} from "../../src/grandpa/GrandpaLightClient.sol";
import {Justification} from "../../src/grandpa/Justification.sol";
import {LightClientBase} from "./LightClient.t.sol";

/// Adversarial checks on the light client: what a relayer controlling calldata, a non-admin, or
/// an authority with a degenerate key can and cannot make the client accept.
contract LightClientSecurityTest is LightClientBase {
    bytes32 internal constant GENESIS = keccak256("security genesis");
    uint64 internal constant SET_ID = 40;
    uint32 internal constant START = 1000;
    uint64 internal constant ROUND = 9;

    /// The ed25519 points of order 4 and 8, as 32-byte keys (the identity and the point of
    /// order 2 have x = 0 and were already rejected).
    bytes32 internal constant ORDER4_A = 0x0000000000000000000000000000000000000000000000000000000000000000;
    bytes32 internal constant ORDER4_B = 0x0000000000000000000000000000000000000000000000000000000000000080;
    bytes32 internal constant ORDER8_A = 0x26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05;
    bytes32 internal constant ORDER8_B = 0x26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85;
    bytes32 internal constant ORDER8_C = 0xc7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a;
    bytes32 internal constant ORDER8_D = 0xc7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa;

    bytes internal checkpoint;

    function setUp() public override {
        super.setUp();
        checkpoint = _header(bytes32(0), START, new bytes[](0), 0);
    }

    // ------------------------------------------------------------------ small-order keys

    /// Anyone can sign for a small-order key: with A of order 4, [n - k]A is the identity for
    /// one hash in four, so R = [s]B passes for a random s. No secret is involved.
    function test_smallOrderKey_signatureIsForgeable() public view {
        bytes memory m = Justification.signedPayload(keccak256("any block"), 1, ROUND, SET_ID);
        (bytes32 r, bytes32 s) = _forge(ORDER4_A, m);
        assertTrue(SCL_EIP6565.Verify_LE(string(m), uint256(r), uint256(s), _ext(ORDER4_A)), "forged");
    }

    /// Every point of order 4 or 8 really has that order (so the list in deriveKey is exact).
    function test_smallOrderKeys_haveSmallOrder() public view {
        bytes32[6] memory keys = _smallOrder();
        for (uint256 i = 0; i < keys.length; i++) {
            (bool ok, uint256 x, uint256 y) = _decompress(keys[i]);
            assertTrue(ok, "a curve point");
            (x, y) = _double(x, y);
            (x, y) = _double(x, y);
            if (i >= 2) (x, y) = _double(x, y);
            assertEq(x, 0, "[4] or [8] is the identity");
            assertEq(y, 1, "[4] or [8] is the identity");
        }
    }

    function test_deriveKey_rejectsSmallOrder() public view {
        bytes32[6] memory keys = _smallOrder();
        for (uint256 i = 0; i < keys.length; i++) {
            (bool ok,,) = lc.deriveKey(keys[i]);
            assertFalse(ok, "small-order key");
        }
        (bool good,,) = lc.deriveKey(_key(0));
        assertTrue(good, "a real key");
    }

    function test_initialize_rejectsSmallOrderKey() public {
        bytes32[] memory keys = _keys(0, 3);
        keys[1] = ORDER4_A;
        vm.expectRevert(abi.encodeWithSelector(GrandpaLightClient.InvalidAuthorityKey.selector, 1, ORDER4_A));
        lc.initialize(GENESIS, SET_ID, keys, checkpoint);
    }

    /// A justified set change to a list holding a small-order key halts instead of installing a
    /// set whose votes anyone can produce.
    function test_scheduledChange_toSmallOrderKey_halts() public {
        lc.initialize(GENESIS, SET_ID, _keys(0, 1), checkpoint);
        bytes32[] memory next = new bytes32[](1);
        next[0] = ORDER8_C;
        bytes memory h1 = _header(_hash(checkpoint), START + 1, _items(_scheduled(next, 0)), 0);
        bytes memory j1 = _justify(h1, START + 1, SET_ID, _range(0, 1));
        bytes32 hash1 = _hash(h1);
        vm.expectEmit(address(lc));
        emit GrandpaLightClient.Halted(START + 1, hash1, GrandpaLightClient.HaltReason.UnusableAuthoritySet);
        lc.importHeader(h1, j1, _seq(1));
        assertTrue(lc.halted());
        assertEq(lc.currentSetId(), SET_ID, "no change enacted");

        // What the halt prevents: a header with any state root, "signed" by nobody.
        bytes memory fake = _header(_hash(h1), START + 2, new bytes[](0), 666);
        bytes memory m = Justification.signedPayload(_hash(fake), START + 2, ROUND, SET_ID + 1);
        (bytes32 r, bytes32 s) = _forge(ORDER8_C, m);
        assertTrue(SCL_EIP6565.Verify_LE(string(m), uint256(r), uint256(s), _ext(ORDER8_C)), "forgeable vote");
    }

    // ------------------------------------------------------------------ signers hint

    /// A justification that carries one authority's precommit twice: naming both copies counts
    /// it once (the authority index must strictly increase), so 2 of 4 stays below 3.
    function test_hint_sameAuthorityTwice() public {
        _initFour();
        bytes memory h1 = _next(0);
        bytes memory j = _justify(h1, START + 1, SET_ID, _list3(0, 0, 1));
        _expectFail(
            _importCall(h1, j, hex"000001000201"),
            abi.encodeWithSelector(GrandpaLightClient.DuplicateSigner.selector, 1, 0)
        );
        _expectFail(
            _importCall(h1, j, hex"010000000201"),
            abi.encodeWithSelector(GrandpaLightClient.DuplicateSigner.selector, 1, 0)
        );
    }

    /// A hint naming authority 2 for authority 1's precommit, a position twice, a position past
    /// the end, an index past the set.
    function test_hint_misattributed() public {
        _initFour();
        bytes memory h1 = _next(0);
        bytes memory j = _justify(h1, START + 1, SET_ID, _range(0, 3));
        _expectFail(
            _importCall(h1, j, hex"000001020203"),
            abi.encodeWithSelector(GrandpaLightClient.UnknownSigner.selector, 1, 2, _key(1))
        );
        _expectFail(
            _importCall(h1, j, hex"000001010102"),
            abi.encodeWithSelector(GrandpaLightClient.DuplicatePrecommit.selector, 2, 1)
        );
        _expectFail(
            _importCall(h1, j, hex"000001010302"),
            abi.encodeWithSelector(GrandpaLightClient.PrecommitIndexOutOfRange.selector, 2, 3)
        );
        _expectFail(
            _importCall(h1, j, hex"000001010204"),
            abi.encodeWithSelector(GrandpaLightClient.AuthorityIndexOutOfRange.selector, 2, 4, 4)
        );
        _expectFail(
            _importCall(h1, j, hex"0000"), abi.encodeWithSelector(GrandpaLightClient.BelowThreshold.selector, 1, 3)
        );
        lc.importHeader(h1, j, hex"000001010202");
    }

    /// A precommit that authority 2 really signed, but for a sibling block, does not count
    /// toward this target.
    function test_precommitForOtherTarget_notCounted() public {
        _initFour();
        bytes memory h1 = _next(0);
        bytes memory sibling = _next(1);
        bytes memory j = _assemble(
            _hash(h1),
            START + 1,
            bytes.concat(
                _precommit(0, _hash(h1), START + 1, SET_ID),
                _precommit(1, _hash(h1), START + 1, SET_ID),
                _precommit(2, _hash(sibling), START + 1, SET_ID)
            )
        );
        _expectFail(
            _importCall(h1, j, _seq(3)), abi.encodeWithSelector(GrandpaLightClient.PrecommitNotOnTarget.selector, 2, 2)
        );
    }

    // ------------------------------------------------------------------ payload binding

    function test_payload_boundToSetIdRoundAndHeader() public {
        _initFour();
        bytes memory h1 = _next(0);
        // signed under the next set id
        _expectFail(
            _importCall(h1, _justify(h1, START + 1, SET_ID + 1, _range(0, 3)), _seq(3)),
            abi.encodeWithSelector(GrandpaLightClient.WrongSetId.selector, SET_ID, SET_ID + 1)
        );
        // round field changed after signing (bytes 0..8)
        bytes memory j = _justify(h1, START + 1, SET_ID, _range(0, 3));
        _expectFail(
            _importCall(h1, _flip(j, 0), _seq(3)),
            abi.encodeWithSelector(GrandpaLightClient.InvalidSignature.selector, 0, 0)
        );
        // the same justification for a header with another state root
        bytes memory other = _next(7);
        _expectFail(
            _importCall(other, j, _seq(3)),
            abi.encodeWithSelector(GrandpaLightClient.HeaderHashMismatch.selector, _hash(h1), _hash(other))
        );
        // commit number rewritten (bytes 40..44), precommits still name the signed number
        bytes memory renumbered = bytes.concat(j);
        renumbered[40] = bytes1(uint8(renumbered[40]) + 1);
        _expectFail(
            _importCall(h1, renumbered, _seq(3)),
            abi.encodeWithSelector(GrandpaLightClient.TargetNumberMismatch.selector, START + 2, START + 1)
        );
    }

    // ------------------------------------------------------------------ re-import

    /// After a set change, re-importing the change header is checked against the old set: the
    /// new set's signatures do not verify it, and a valid re-import writes nothing.
    function test_reimport_usesFinalizingSet_andWritesNothing() public {
        _initFour();
        bytes32[] memory next = _keys(4, 4);
        bytes memory h1 = _header(_hash(checkpoint), START + 1, _items(_scheduled(next, 0)), 0);
        bytes memory j1 = _justify(h1, START + 1, SET_ID, _range(0, 3));
        lc.importHeader(h1, j1, _seq(3));
        assertEq(lc.currentSetId(), SET_ID + 1);
        bytes memory h2 = _header(_hash(h1), START + 2, new bytes[](0), 0);
        lc.importHeader(h2, _justify(h2, START + 2, SET_ID + 1, _range(4, 3)), _seq(3));

        // the new set re-signing h1 under its own id
        _expectFail(
            _importCall(h1, _justify(h1, START + 1, SET_ID + 1, _range(4, 3)), _seq(3)),
            abi.encodeWithSelector(GrandpaLightClient.UnknownSigner.selector, 0, 0, _key(4))
        );
        // the old set re-signing h2 (not its block)
        _expectFail(
            _importCall(h2, _justify(h2, START + 2, SET_ID, _range(0, 3)), _seq(3)),
            abi.encodeWithSelector(GrandpaLightClient.UnknownSigner.selector, 0, 0, _key(0))
        );
        vm.recordLogs();
        lc.importHeader(h1, j1, _seq(3));
        assertEq(vm.getRecordedLogs().length, 0, "no events");
        (bytes32 latest, uint32 number) = lc.latestFinalized();
        assertEq(latest, _hash(h2));
        assertEq(number, START + 2);
        assertEq(lc.currentSetId(), SET_ID + 1, "the change is not enacted twice");
        assertEq(lc.authoritySetCount(), 2);
    }

    // ------------------------------------------------------------------ admin

    function test_admin_onlyAdminChangesState() public {
        _initFour();
        address mallory = address(0xBAD);
        bytes32[] memory one = _keys(0, 1);
        vm.startPrank(mallory);
        vm.expectRevert(GrandpaLightClient.NotAdmin.selector);
        lc.pause("x");
        vm.expectRevert(GrandpaLightClient.NotAdmin.selector);
        lc.unpause();
        vm.expectRevert(GrandpaLightClient.NotAdmin.selector);
        lc.reinitialize(GENESIS, SET_ID, one, checkpoint, "x");
        vm.expectRevert(GrandpaLightClient.NotAdmin.selector);
        lc.transferAdmin(mallory);
        vm.stopPrank();

        lc.transferAdmin(mallory);
        vm.expectRevert(GrandpaLightClient.NotAdmin.selector);
        lc.pause("old admin");
        vm.prank(mallory);
        lc.pause("new admin");
        assertTrue(lc.paused());
    }

    /// reinitialize never rewrites an imported header or a stored set.
    function test_reinitialize_keepsHistory() public {
        _initFour();
        bytes memory h1 = _next(0);
        lc.importHeader(h1, _justify(h1, START + 1, SET_ID, _range(0, 3)), _seq(3));
        (bytes32 root,) = lc.stateRootOf(_hash(h1));
        lc.pause("reset");
        // a checkpoint with the same hash cannot change the stored root or set
        lc.reinitialize(GENESIS, SET_ID + 9, _keys(8, 1), h1, "reset");
        (bytes32 after_,) = lc.stateRootOf(_hash(h1));
        assertEq(after_, root);
        assertEq(lc.headerOf(_hash(h1)).setId, SET_ID);
        (GrandpaLightClient.AuthoritySet memory first, bytes32[] memory keys) = lc.authoritySetAt(0);
        assertEq(first.setId, SET_ID);
        assertEq(keys, _keys(0, 4));
        // and the old block still re-imports against the set that finalized it
        lc.importHeader(h1, _justify(h1, START + 1, SET_ID, _range(0, 3)), _seq(3));
    }

    // ------------------------------------------------------------------ gas bound

    /// The heaviest import the bounds allow: a 25-authority set (17 signatures) finalizing a
    /// change to 25 new keys, all derived in the same transaction.
    function test_gas_maxSetChange_withinCap() public {
        lc.initialize(GENESIS, SET_ID, _keys(0, 25), checkpoint);
        assertEq(lc.threshold(), 17);
        bytes memory h1 = _header(_hash(checkpoint), START + 1, _items(_scheduled(_keys(100, 25), 0)), 0);
        _send(
            "25 authorities, 17 signatures, change to 25 new keys",
            _importCall(h1, _justify(h1, START + 1, SET_ID, _range(0, 17)), _seq(17))
        );
        assertEq(lc.currentSetId(), SET_ID + 1);
    }

    // ------------------------------------------------------------------ helpers

    function _initFour() internal {
        lc.initialize(GENESIS, SET_ID, _keys(0, 4), checkpoint);
    }

    /// Block START + 1 with state-root salt `salt`.
    function _next(uint256 salt) internal view returns (bytes memory) {
        return _header(_hash(checkpoint), START + 1, new bytes[](0), salt);
    }

    function _importCall(bytes memory header, bytes memory justification, bytes memory signers)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(GrandpaLightClient.importHeader, (header, justification, signers));
    }

    function _smallOrder() internal pure returns (bytes32[6] memory) {
        return [ORDER4_A, ORDER4_B, ORDER8_A, ORDER8_B, ORDER8_C, ORDER8_D];
    }

    function _secret(uint256 i) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode("security authority", i))) % N25519;
    }

    function _key(uint256 i) internal view returns (bytes32) {
        (uint256 x, uint256 y) = SCL_EIP6565.BasePointMultiply_Edwards(_secret(i));
        return bytes32(SCL_sha512.Swap256(SCL_EIP6565.edCompress([x, y])));
    }

    function _keys(uint256 from, uint256 count) internal view returns (bytes32[] memory keys) {
        keys = new bytes32[](count);
        for (uint256 i = 0; i < count; i++) {
            keys[i] = _key(from + i);
        }
    }

    function _range(uint256 from, uint256 count) internal pure returns (uint256[] memory out) {
        out = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            out[i] = from + i;
        }
    }

    function _list3(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory out) {
        out = new uint256[](3);
        (out[0], out[1], out[2]) = (a, b, c);
    }

    function _seq(uint256 count) internal pure returns (bytes memory out) {
        out = new bytes(2 * count);
        for (uint256 i = 0; i < count; i++) {
            out[2 * i] = bytes1(uint8(i));
            out[2 * i + 1] = bytes1(uint8(i));
        }
    }

    /// One encoded precommit by synthetic authority `who` on (hash, number) under `setId`.
    function _precommit(uint256 who, bytes32 hash, uint32 number, uint64 setId) internal view returns (bytes memory) {
        bytes memory m = Justification.signedPayload(hash, number, ROUND, setId);
        bytes32 key = _key(who);
        (bytes32 r, bytes32 s) = _sign(_secret(who), key, m);
        return abi.encodePacked(hash, _le32(number), r, s, key);
    }

    function _assemble(bytes32 hash, uint32 number, bytes memory precommits) internal pure returns (bytes memory) {
        return bytes.concat(
            abi.encodePacked(_le64(ROUND), hash, _le32(number), _compact(precommits.length / 132)), precommits, hex"00"
        );
    }

    function _justify(bytes memory header, uint32 number, uint64 setId, uint256[] memory who)
        internal
        view
        returns (bytes memory)
    {
        bytes32 hash = _hash(header);
        bytes memory pcs;
        for (uint256 i = 0; i < who.length; i++) {
            pcs = bytes.concat(pcs, _precommit(who[i], hash, number, setId));
        }
        return _assemble(hash, number, pcs);
    }

    function _sign(uint256 secret, bytes32 key, bytes memory message) internal view returns (bytes32 r, bytes32 s) {
        uint256 nonce = uint256(keccak256(abi.encode("nonce", secret, message))) % N25519;
        (uint256 x, uint256 y) = SCL_EIP6565.BasePointMultiply_Edwards(nonce);
        r = bytes32(SCL_sha512.Swap256(SCL_EIP6565.edCompress([x, y])));
        uint256 k = SCL_EIP6565.HashInternal(uint256(r), uint256(key), string(message));
        s = bytes32(SCL_sha512.Swap256(addmod(nonce, mulmod(k, secret, N25519), N25519)));
    }

    /// A signature for small-order `key` on `m` made without any secret: R = [s]B, retried until
    /// [n - k]A is the identity (A has order dividing 8, n = 5 mod 8).
    function _forge(bytes32 key, bytes memory m) internal view returns (bytes32 r, bytes32 s) {
        for (uint256 t = 1;; t++) {
            uint256 scalar = uint256(keccak256(abi.encode("forge", t))) % N25519;
            (uint256 x, uint256 y) = SCL_EIP6565.BasePointMultiply_Edwards(scalar);
            r = bytes32(SCL_sha512.Swap256(SCL_EIP6565.edCompress([x, y])));
            uint256 k = SCL_EIP6565.HashInternal(uint256(r), uint256(key), string(m));
            if ((N25519 - k) % 8 == 0) return (r, bytes32(SCL_sha512.Swap256(scalar)));
        }
    }

    /// SCL's extended key for `key`, derived here (independently of the client).
    function _ext(bytes32 key) internal view returns (uint256[5] memory ext) {
        (bool ok, uint256 x, uint256 y) = _decompress(key);
        assertTrue(ok, "a curve point");
        (uint256 wx, uint256 wy) = SCL_EIP6565.Edwards2WeierStrass(x, y);
        ext = [wx, wy, 0, 0, uint256(key)];
    }

    /// RFC 8032 5.1.3 decompression, without any order check.
    function _decompress(bytes32 key) internal view returns (bool ok, uint256 x, uint256 y) {
        y = SCL_sha512.Swap256(uint256(key));
        uint256 sign = y >> 255;
        y &= (uint256(1) << 255) - 1;
        if (y >= P25519) return (false, 0, 0);
        uint256 yy = mulmod(y, y, P25519);
        uint256 u = addmod(yy, P25519 - 1, P25519);
        uint256 v = addmod(mulmod(D25519, yy, P25519), 1, P25519);
        uint256 xx = mulmod(u, ModInv(v, P25519), P25519);
        x = _modexp(xx, P_PLUS_3_DIV_8);
        if (mulmod(x, x, P25519) != xx) x = mulmod(x, SQRT_M1, P25519);
        if (mulmod(x, x, P25519) != xx) return (false, 0, 0);
        if (x & 1 != sign) x = (P25519 - x) % P25519;
        ok = true;
    }

    /// Twisted Edwards (a = -1) doubling in affine coordinates.
    function _double(uint256 x, uint256 y) internal view returns (uint256, uint256) {
        uint256 xy = mulmod(x, y, P25519);
        uint256 t = mulmod(D25519, mulmod(xy, xy, P25519), P25519);
        uint256 x3 = mulmod(addmod(xy, xy, P25519), ModInv(addmod(1, t, P25519), P25519), P25519);
        uint256 y3 = mulmod(
            addmod(mulmod(y, y, P25519), mulmod(x, x, P25519), P25519),
            ModInv(addmod(1, P25519 - t, P25519), P25519),
            P25519
        );
        return (x3, y3);
    }

    function _modexp(uint256 base, uint256 exponent) internal view returns (uint256 r) {
        (bool ok, bytes memory out) =
            address(5).staticcall(abi.encodePacked(uint256(32), uint256(32), uint256(32), base, exponent, P25519));
        require(ok);
        r = abi.decode(out, (uint256));
    }

    function _header(bytes32 parent, uint32 number, bytes[] memory items, uint256 salt)
        internal
        pure
        returns (bytes memory out)
    {
        out = abi.encodePacked(parent, _compact(number), keccak256(abi.encode("state", number, salt)), bytes32(0));
        out = bytes.concat(out, _compact(items.length));
        for (uint256 i = 0; i < items.length; i++) {
            out = bytes.concat(out, items[i]);
        }
    }

    function _items(bytes memory frnkPayload) internal pure returns (bytes[] memory items) {
        items = new bytes[](1);
        items[0] = abi.encodePacked(uint8(4), bytes4("FRNK"), _compact(frnkPayload.length), frnkPayload);
    }

    function _scheduled(bytes32[] memory keys, uint32 delay) internal pure returns (bytes memory out) {
        out = _compact(keys.length);
        for (uint256 i = 0; i < keys.length; i++) {
            out = bytes.concat(out, abi.encodePacked(keys[i], _le64(1)));
        }
        out = abi.encodePacked(uint8(1), out, _le32(delay));
    }
}
