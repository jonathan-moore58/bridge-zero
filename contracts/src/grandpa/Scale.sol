// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

/// @title Scale
/// @notice A bounds-checked read cursor over SCALE-encoded bytes in memory, with the
/// fixed-width little-endian integers and the compact integers that Substrate headers and
/// GRANDPA justifications use. Every read checks the bytes left first; offsets in errors
/// are relative to the start of the outermost input.
library Scale {
    /// @dev `base` is the memory address of byte 0 of the input, `pos` the next byte to read,
    /// `end` one past the last readable byte.
    struct Cursor {
        uint256 base;
        uint256 pos;
        uint256 end;
    }

    /// A read of `needed` bytes at `offset` ran past the end of the input (or of the
    /// length-prefixed item being read).
    error Truncated(uint256 offset, uint256 needed);
    /// `count` bytes were left over at `offset` after a complete value was decoded.
    error TrailingBytes(uint256 offset, uint256 count);
    /// The compact integer at `offset` is not in its shortest form.
    error NonCanonicalCompact(uint256 offset);
    /// The compact integer at `offset` does not fit the integer type it is decoded into.
    error CompactOverflow(uint256 offset);

    // ------------------------------------------------------------------ cursors

    function cursor(bytes memory data) internal pure returns (Cursor memory c) {
        uint256 start;
        assembly ("memory-safe") {
            start := add(data, 32)
        }
        c = Cursor(start, start, start + data.length);
    }

    /// Takes the next `len` bytes of `c` as a cursor of their own (same base, so offsets
    /// still refer to the outer input) and advances `c` past them.
    function take(Cursor memory c, uint256 len) internal pure returns (Cursor memory s) {
        _need(c, len);
        s = Cursor(c.base, c.pos, c.pos + len);
        c.pos += len;
    }

    function offset(Cursor memory c) internal pure returns (uint256) {
        return c.pos - c.base;
    }

    function remaining(Cursor memory c) internal pure returns (uint256) {
        return c.end - c.pos;
    }

    /// Reverts unless every byte of `c` has been read.
    function done(Cursor memory c) internal pure {
        if (c.pos != c.end) revert TrailingBytes(c.pos - c.base, c.end - c.pos);
    }

    function skip(Cursor memory c, uint256 n) internal pure {
        _need(c, n);
        c.pos += n;
    }

    // ------------------------------------------------------------------ fixed width

    function readU8(Cursor memory c) internal pure returns (uint8 v) {
        _need(c, 1);
        uint256 p = c.pos;
        assembly ("memory-safe") {
            v := byte(0, mload(p))
        }
        c.pos = p + 1;
    }

    function readBytes4(Cursor memory c) internal pure returns (bytes4 v) {
        _need(c, 4);
        uint256 p = c.pos;
        assembly ("memory-safe") {
            v := and(mload(p), 0xffffffff00000000000000000000000000000000000000000000000000000000)
        }
        c.pos = p + 4;
    }

    function readBytes32(Cursor memory c) internal pure returns (bytes32 v) {
        _need(c, 32);
        uint256 p = c.pos;
        assembly ("memory-safe") {
            v := mload(p)
        }
        c.pos = p + 32;
    }

    function readU32(Cursor memory c) internal pure returns (uint32) {
        _need(c, 4);
        uint256 p = c.pos;
        uint32 be;
        assembly ("memory-safe") {
            be := shr(224, mload(p))
        }
        c.pos = p + 4;
        return swap32(be);
    }

    function readU64(Cursor memory c) internal pure returns (uint64) {
        _need(c, 8);
        uint256 p = c.pos;
        uint64 be;
        assembly ("memory-safe") {
            be := shr(192, mload(p))
        }
        c.pos = p + 8;
        return swap64(be);
    }

    // ------------------------------------------------------------------ compact

    /// Compact<uN> for any N up to 256. All four modes; rejects every encoding that is not
    /// the shortest one, as parity-scale-codec does:
    ///   0b00  one byte,    value < 2^6
    ///   0b01  two bytes,   2^6  <= value < 2^14
    ///   0b10  four bytes,  2^14 <= value < 2^30
    ///   0b11  (b0 >> 2) + 4 little-endian bytes follow, value >= 2^30 and the last byte is
    ///         not zero. More than 32 bytes cannot fit a uint256 and is CompactOverflow.
    function readCompact(Cursor memory c) internal pure returns (uint256 v) {
        uint256 at = c.pos - c.base;
        uint256 b0 = readU8(c);
        uint256 mode = b0 & 3;
        if (mode == 0) return b0 >> 2;
        if (mode == 1) {
            v = (b0 | (uint256(readU8(c)) << 8)) >> 2;
            if (v < 1 << 6) revert NonCanonicalCompact(at);
            return v;
        }
        if (mode == 2) {
            c.pos -= 1;
            v = uint256(readU32(c)) >> 2;
            if (v < 1 << 14) revert NonCanonicalCompact(at);
            return v;
        }
        uint256 n = (b0 >> 2) + 4;
        if (n > 32) revert CompactOverflow(at);
        _need(c, n);
        uint256 p = c.pos;
        uint256 word;
        assembly ("memory-safe") {
            word := mload(p)
        }
        for (uint256 i = 0; i < n; i++) {
            v |= uint256(uint8(bytes32(word)[i])) << (8 * i);
        }
        c.pos = p + n;
        if (v < 1 << 30 || uint8(bytes32(word)[n - 1]) == 0) revert NonCanonicalCompact(at);
    }

    /// Compact<u32>: as readCompact, and the value must fit 32 bits.
    function readCompactU32(Cursor memory c) internal pure returns (uint32) {
        uint256 at = c.pos - c.base;
        uint256 v = readCompact(c);
        if (v > type(uint32).max) revert CompactOverflow(at);
        return uint32(v);
    }

    /// A compact length or element count. Every element takes at least one byte, so a count
    /// above the bytes left is Truncated; this also bounds what a caller allocates.
    function readLength(Cursor memory c) internal pure returns (uint256 n) {
        uint256 at = c.pos - c.base;
        n = readCompact(c);
        if (n > c.end - c.pos) revert Truncated(at, n);
    }

    /// Decodes `data` as exactly one compact integer.
    function decodeCompact(bytes memory data) internal pure returns (uint256 v) {
        Cursor memory c = cursor(data);
        v = readCompact(c);
        done(c);
    }

    // ------------------------------------------------------------------ byte order

    function swap32(uint32 v) internal pure returns (uint32) {
        v = ((v & 0xff00ff00) >> 8) | ((v & 0x00ff00ff) << 8);
        return (v >> 16) | (v << 16);
    }

    function swap64(uint64 v) internal pure returns (uint64) {
        v = ((v & 0xff00ff00ff00ff00) >> 8) | ((v & 0x00ff00ff00ff00ff) << 8);
        v = ((v & 0xffff0000ffff0000) >> 16) | ((v & 0x0000ffff0000ffff) << 16);
        return (v >> 32) | (v << 32);
    }

    function _need(Cursor memory c, uint256 n) private pure {
        if (n > c.end - c.pos) revert Truncated(c.pos - c.base, n);
    }
}
