// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.6.12;

// Benchmark wrapper for chengwenxi/Ed25519, which is Solidity ^0.6.8 and cannot be imported by
// 0.8 code. It is built with solc 0.6.12, either on its own into out/legacy (docs/GAS.md) or in
// the same run as the 0.8 code when both compilers are installed. The 0.8.27 benchmark
// (test/bench/Ed25519Bench.t.sol) deploys it from its artifact.

import {Ed25519} from "chengwenxi-ed25519/libraries/Ed25519.sol";

contract ChengwenxiEd25519Bench {
    /// One verification; gasUsed covers the library call alone (its code is internal and inlined).
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

    /// Several signatures over one message in one call.
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
