// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {console} from "forge-std/Test.sol";
import {Ed25519} from "farcaster-solidity/libraries/Ed25519.sol";
import {SCL_EIP6565} from "crypto-lib/lib/libSCL_EIP6565.sol";
import {SCL_sha512} from "crypto-lib/hash/SCL_sha512.sol";
import {ModInv} from "crypto-lib/modular/SCL_modular.sol";
import {SqrtMod} from "crypto-lib/modular/SCL_sqrtMod_5mod8.sol";
import {p as P25519, d as D25519, n as N25519} from "crypto-lib/fields/SCL_wei25519.sol";
import {BenchFixtures} from "./BenchFixtures.sol";

// Each harness measures the library call alone with gasleft() inside a fresh call frame, so the
// numbers do not depend on what the test contract has already put in memory.

/// pavlovdog/farcaster-solidity: Ed25519, Sha512 and Ed25519_pow are linked (external) libraries.
contract FarcasterEd25519Bench {
    function verify(bytes32 k, bytes32 r, bytes32 s, bytes calldata m)
        external
        view
        returns (bool ok, uint256 gasUsed)
    {
        bytes memory message = m;
        uint256 before = gasleft();
        ok = Ed25519.verify(k, r, s, message);
        gasUsed = before - gasleft();
    }

    /// Several signatures over one message in one call: the first call pays the cold access to
    /// the three library accounts, the rest find them warm, as in a light client import.
    function verifyBatch(bytes32[] calldata k, bytes32[] calldata r, bytes32[] calldata s, bytes calldata m)
        external
        view
        returns (uint256 valid, uint256 gasUsed)
    {
        bytes memory message = m;
        uint256 before = gasleft();
        for (uint256 i = 0; i < k.length; i++) {
            if (Ed25519.verify(k[i], r[i], s[i], message)) valid++;
        }
        gasUsed = before - gasleft();
    }
}

/// get-smooth/crypto-lib (SCL), SCL_EIP6565: a linked (public) library. It verifies against an
/// "extended" key [Wx, Wy, -, -, A] (Weierstrass coordinates of the key, then the 32-byte key),
/// which has to be computed once per authority key and stored.
contract SclEd25519Bench {
    /// Decompresses the 32-byte key (RFC 8032, 5.1.3) and converts it to the Weierstrass form
    /// SCL works in. Reverts on a key that is not a curve point.
    function expandKey(bytes32 key) external returns (uint256[5] memory ext, uint256 gasUsed) {
        uint256 before = gasleft();
        ext = _expand(key);
        gasUsed = before - gasleft();
    }

    function verify(uint256[5] calldata ext, bytes32 r, bytes32 s, bytes calldata m)
        external
        view
        returns (bool ok, uint256 gasUsed)
    {
        uint256[5] memory key = ext;
        string memory message = string(m);
        uint256 before = gasleft();
        ok = SCL_EIP6565.Verify_LE(message, uint256(r), uint256(s), key);
        gasUsed = before - gasleft();
    }

    function verifyBatch(uint256[5][] calldata ext, bytes32[] calldata r, bytes32[] calldata s, bytes calldata m)
        external
        view
        returns (uint256 valid, uint256 gasUsed)
    {
        uint256[5][] memory keys = ext;
        bytes32[] memory rs = r;
        bytes32[] memory ss = s;
        string memory message = string(m);
        uint256 before = gasleft();
        for (uint256 i = 0; i < keys.length; i++) {
            if (SCL_EIP6565.Verify_LE(message, uint256(rs[i]), uint256(ss[i]), keys[i])) valid++;
        }
        gasUsed = before - gasleft();
    }

    function _expand(bytes32 key) internal returns (uint256[5] memory ext) {
        uint256 y = SCL_sha512.Swap256(uint256(key)); // the key is a little-endian y with x's sign in bit 255
        uint256 sign = y >> 255;
        y &= (uint256(1) << 255) - 1;
        require(y < P25519, "y out of range");
        uint256 yy = mulmod(y, y, P25519);
        uint256 u = addmod(yy, P25519 - 1, P25519); // y^2 - 1
        uint256 v = addmod(mulmod(D25519, yy, P25519), 1, P25519); // d y^2 + 1
        uint256 x = SqrtMod(mulmod(u, ModInv(v, P25519), P25519)); // reverts if not a square
        require(x != 0 || sign == 0, "invalid key");
        if (x & 1 != sign) x = P25519 - x;
        (ext[0], ext[1]) = SCL_EIP6565.Edwards2WeierStrass(x, y);
        ext[4] = uint256(key);
    }
}

/// chengwenxi/Ed25519 is Solidity 0.6 and is reached through a wrapper built on its own with
/// solc 0.6.12 (test/bench/legacy). The wrapper has the same verify/verifyBatch functions.
interface IEd25519Bench {
    function verify(bytes32 k, bytes32 r, bytes32 s, bytes calldata m) external view returns (bool ok, uint256 gasUsed);

    function verifyBatch(bytes32[] calldata k, bytes32[] calldata r, bytes32[] calldata s, bytes calldata m)
        external
        view
        returns (uint256 valid, uint256 gasUsed);
}

contract Ed25519BenchTest is BenchFixtures {
    /// The solc 0.6.12 wrapper, built on its own (single local compiler) or in the same run.
    string internal constant LEGACY_ARTIFACT = "out/legacy/ChengwenxiEd25519Bench.sol/ChengwenxiEd25519Bench.json";
    string internal constant SAME_RUN_ARTIFACT = "out/ChengwenxiEd25519Bench.sol/ChengwenxiEd25519Bench.json";

    FarcasterEd25519Bench internal farcaster;
    SclEd25519Bench internal scl;
    IEd25519Bench internal chengwenxi;

    Justified internal head;

    function setUp() public {
        farcaster = new FarcasterEd25519Bench();
        scl = new SclEd25519Bench();
        if (vm.exists(LEGACY_ARTIFACT)) {
            chengwenxi = IEd25519Bench(vm.deployCode(LEGACY_ARTIFACT));
        } else if (vm.exists(SAME_RUN_ARTIFACT)) {
            chengwenxi = IEd25519Bench(vm.deployCode(SAME_RUN_ARTIFACT));
        }
        Justified memory j = _loadHead();
        head.blockHash = j.blockHash;
        head.number = j.number;
        head.round = j.round;
        head.setId = j.setId;
        head.payload = j.payload;
        for (uint256 i = 0; i < j.precommits.length; i++) {
            head.precommits.push(j.precommits[i]);
        }
    }

    // ---------------------------------------------------------------- farcaster-solidity

    function test_farcaster_rfc8032() public view {
        _requireOsaka();
        (Precommit memory v, bytes memory m) = _rfc8032ShaAbc();
        (bool ok, uint256 gasUsed) = farcaster.verify(v.key, v.r, v.s, m);
        assertTrue(ok, "RFC 8032 vector verifies");
        (bool bad,) = farcaster.verify(v.key, v.r, v.s, _flipBit(m, 0, 0));
        assertFalse(bad, "flipped message bit is rejected");
        console.log("farcaster  verify RFC 8032 TEST SHA(abc), cold libraries:", gasUsed);
    }

    function test_farcaster_mainnetPrecommit() public view {
        _requireOsaka();
        Precommit memory pc = head.precommits[0];
        (bool ok, uint256 gasUsed) = farcaster.verify(pc.key, pc.r, pc.s, head.payload);
        assertTrue(ok, "mainnet precommit verifies");
        (bool badMsg,) = farcaster.verify(pc.key, pc.r, pc.s, _flipBit(head.payload, 0, 0));
        assertFalse(badMsg, "flipped payload bit is rejected");
        (bool badSig,) = farcaster.verify(pc.key, _flipBit(pc.r, 0, 0), pc.s, head.payload);
        assertFalse(badSig, "flipped signature bit is rejected");
        console.log("farcaster  verify mainnet precommit, cold libraries:", gasUsed);
    }

    function test_farcaster_sevenPrecommits() public view {
        _requireOsaka();
        (bytes32[] memory k, bytes32[] memory r, bytes32[] memory s) = _columns();
        (uint256 valid, uint256 gasUsed) = farcaster.verifyBatch(k, r, s, head.payload);
        assertEq(valid, 7, "all 7 mainnet precommits verify");
        console.log("farcaster  7 mainnet precommits in one call:", gasUsed);
        console.log("farcaster  per signature (average of 7):", gasUsed / 7);
    }

    // ---------------------------------------------------------------- crypto-lib (SCL)

    function test_scl_rfc8032() public {
        _requireOsaka();
        (Precommit memory v, bytes memory m) = _rfc8032ShaAbc();
        (uint256[5] memory ext, uint256 expandGas) = scl.expandKey(v.key);
        (bool ok, uint256 gasUsed) = scl.verify(ext, v.r, v.s, m);
        assertTrue(ok, "RFC 8032 vector verifies");
        (bool bad,) = scl.verify(ext, v.r, v.s, _flipBit(m, 0, 0));
        assertFalse(bad, "flipped message bit is rejected");
        console.log("scl        verify RFC 8032 TEST SHA(abc), cold library:", gasUsed);
        console.log("scl        key expansion (once per key):", expandGas);
    }

    function test_scl_mainnetPrecommit() public {
        _requireOsaka();
        Precommit memory pc = head.precommits[0];
        (uint256[5] memory ext, uint256 expandGas) = scl.expandKey(pc.key);
        (bool ok, uint256 gasUsed) = scl.verify(ext, pc.r, pc.s, head.payload);
        assertTrue(ok, "mainnet precommit verifies");
        (bool badMsg,) = scl.verify(ext, pc.r, pc.s, _flipBit(head.payload, 0, 0));
        assertFalse(badMsg, "flipped payload bit is rejected");
        (bool badSig,) = scl.verify(ext, _flipBit(pc.r, 0, 0), pc.s, head.payload);
        assertFalse(badSig, "flipped signature bit is rejected");
        console.log("scl        verify mainnet precommit, cold library:", gasUsed);
        console.log("scl        key expansion (once per key):", expandGas);
    }

    function test_scl_sevenPrecommits() public {
        _requireOsaka();
        (, bytes32[] memory r, bytes32[] memory s) = _columns();
        uint256[5][] memory ext = new uint256[5][](r.length);
        uint256 expandTotal;
        for (uint256 i = 0; i < r.length; i++) {
            uint256 g;
            (ext[i], g) = scl.expandKey(head.precommits[i].key);
            expandTotal += g;
        }
        (uint256 valid, uint256 gasUsed) = scl.verifyBatch(ext, r, s, head.payload);
        assertEq(valid, 7, "all 7 mainnet precommits verify");
        console.log("scl        7 mainnet precommits in one call:", gasUsed);
        console.log("scl        per signature (average of 7):", gasUsed / 7);
        console.log("scl        key expansion, 7 keys:", expandTotal);
    }

    /// The expanded key must be the key's own point: converting back gives the 32-byte key.
    function test_scl_keyExpansionRoundTrip() public {
        for (uint256 i = 0; i < head.precommits.length; i++) {
            (uint256[5] memory ext,) = scl.expandKey(head.precommits[i].key);
            (uint256 x, uint256 y) = SCL_EIP6565.WeierStrass2Edwards(ext[0], ext[1]);
            uint256[2] memory xy = [x, y];
            assertEq(bytes32(SCL_sha512.Swap256(SCL_EIP6565.edCompress(xy))), head.precommits[i].key, "round trip");
        }
    }

    /// s + L stands for the same scalar as s but is not its canonical encoding (RFC 8032 requires
    /// s < L), so accepting it would make signatures malleable.
    function test_scl_rejectsNonCanonicalS() public {
        Precommit memory pc = head.precommits[0];
        (uint256[5] memory ext,) = scl.expandKey(pc.key);
        uint256 sPlusL = SCL_sha512.Swap256(uint256(pc.s)) + N25519;
        (bool ok,) = scl.verify(ext, pc.r, bytes32(SCL_sha512.Swap256(sPlusL)), head.payload);
        assertFalse(ok, "s + L is rejected");
    }

    /// A valid precommit signature does not verify under another authority's key.
    function test_scl_rejectsAnotherAuthoritysKey() public {
        Precommit memory pc = head.precommits[0];
        (uint256[5] memory other,) = scl.expandKey(head.precommits[1].key);
        (bool ok,) = scl.verify(other, pc.r, pc.s, head.payload);
        assertFalse(ok, "another authority's key rejects the signature");
    }

    /// SCL hashes the 32-byte key (ext[4]) but does the curve arithmetic with the stored point
    /// (ext[0], ext[1]). If the two do not belong together, whoever knows the stored point's
    /// secret can sign for the 32-byte key. The light client therefore derives the point on chain
    /// from the key the chain signed, as expandKey does, and never takes it from a caller.
    function test_scl_extendedKeyMustBeDerivedOnChain() public {
        bytes32 key = head.precommits[0].key;
        uint256 secret = uint256(keccak256("a key outside the authority set")) % N25519;
        uint256[5] memory planted = _sclPoint(secret);
        planted[4] = uint256(key);
        (bytes32 r, bytes32 s) = _sclSign(secret, key, head.payload);

        (bool forged,) = scl.verify(planted, r, s, head.payload);
        assertTrue(forged, "a planted point lets its owner sign for the authority's key");
        (uint256[5] memory derived,) = scl.expandKey(key);
        (bool accepted,) = scl.verify(derived, r, s, head.payload);
        assertFalse(accepted, "the point derived from the key rejects that signature");
    }

    // ---------------------------------------------------------------- chengwenxi/Ed25519 (0.6)

    function test_chengwenxi_rfc8032() public {
        _requireLegacy();
        _requireOsaka();
        (Precommit memory v, bytes memory m) = _rfc8032ShaAbc();
        (bool ok, uint256 gasUsed) = chengwenxi.verify(v.key, v.r, v.s, m);
        assertTrue(ok, "RFC 8032 vector verifies");
        (bool bad,) = chengwenxi.verify(v.key, v.r, v.s, _flipBit(m, 0, 0));
        assertFalse(bad, "flipped message bit is rejected");
        console.log("chengwenxi verify RFC 8032 TEST SHA(abc):", gasUsed);
    }

    function test_chengwenxi_mainnetPrecommit() public {
        _requireLegacy();
        _requireOsaka();
        Precommit memory pc = head.precommits[0];
        (bool ok, uint256 gasUsed) = chengwenxi.verify(pc.key, pc.r, pc.s, head.payload);
        assertTrue(ok, "mainnet precommit verifies");
        (bool badMsg,) = chengwenxi.verify(pc.key, pc.r, pc.s, _flipBit(head.payload, 0, 0));
        assertFalse(badMsg, "flipped payload bit is rejected");
        (bool badSig,) = chengwenxi.verify(pc.key, _flipBit(pc.r, 0, 0), pc.s, head.payload);
        assertFalse(badSig, "flipped signature bit is rejected");
        console.log("chengwenxi verify mainnet precommit:", gasUsed);
    }

    function test_chengwenxi_sevenPrecommits() public {
        _requireLegacy();
        _requireOsaka();
        (bytes32[] memory k, bytes32[] memory r, bytes32[] memory s) = _columns();
        (uint256 valid, uint256 gasUsed) = chengwenxi.verifyBatch(k, r, s, head.payload);
        assertEq(valid, 7, "all 7 mainnet precommits verify");
        console.log("chengwenxi 7 mainnet precommits in one call:", gasUsed);
        console.log("chengwenxi per signature (average of 7):", gasUsed / 7);
    }

    // ---------------------------------------------------------------- helpers

    function _requireLegacy() internal {
        if (address(chengwenxi) == address(0)) {
            console.log("skipped: build the solc 0.6.12 wrapper first (see docs/GAS.md)");
            vm.skip(true);
        }
    }

    /// [secret]B in SCL's extended-key layout, with the 32-byte key slot (ext[4]) left empty.
    function _sclPoint(uint256 secret) internal view returns (uint256[5] memory ext) {
        (uint256 x, uint256 y) = SCL_EIP6565.BasePointMultiply_Edwards(secret);
        (ext[0], ext[1]) = SCL_EIP6565.Edwards2WeierStrass(x, y);
    }

    /// An ed25519 signature by `secret` over `message` with `key` hashed in as the public key,
    /// in raw byte order (R, then s little-endian).
    function _sclSign(uint256 secret, bytes32 key, bytes memory message) internal view returns (bytes32 r, bytes32 s) {
        uint256 nonce = uint256(keccak256(abi.encode("nonce", message))) % N25519;
        (uint256 x, uint256 y) = SCL_EIP6565.BasePointMultiply_Edwards(nonce);
        r = bytes32(SCL_sha512.Swap256(SCL_EIP6565.edCompress([x, y])));
        uint256 k = SCL_EIP6565.HashInternal(uint256(r), uint256(key), string(message));
        s = bytes32(SCL_sha512.Swap256(addmod(nonce, mulmod(k, secret, N25519), N25519)));
    }

    function _columns() internal view returns (bytes32[] memory k, bytes32[] memory r, bytes32[] memory s) {
        uint256 n = head.precommits.length;
        assertEq(n, 7, "the head justification carries 7 precommits");
        k = new bytes32[](n);
        r = new bytes32[](n);
        s = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            k[i] = head.precommits[i].key;
            r[i] = head.precommits[i].r;
            s[i] = head.precommits[i].s;
        }
    }
}
