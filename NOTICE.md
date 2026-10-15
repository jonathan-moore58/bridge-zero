# Third-party code

Each entry gives the source, the pinned commit or tag, the licence, and whether we
changed it. Unmodified dependencies are pulled in as git submodules under
`contracts/lib/`.

| Library | Source | Pinned at | Licence | Use | Changes |
|---|---|---|---|---|---|
| forge-std | https://github.com/foundry-rs/forge-std | v1.17.0 (`f3dae6e6ee381f25eb6a246f7da9b85c91a68219`) | MIT OR Apache-2.0 | Foundry test framework | none |
| chengwenxi-ed25519 | https://github.com/chengwenxi/Ed25519 | `34d8c5701c8f73c4be68f3f6fdd50cba0e40f1af` (2021-09-06) | Apache-2.0 | ed25519 signature verification, benchmark candidate (Solidity 0.6) | none |
| farcaster-solidity | https://github.com/pavlovdog/farcaster-solidity | `cbb770d8b722ea8c3c165ad97c649e07aaf91fc0` (2024-02-13, commit "v1.4.0") | Apache-2.0, from the SPDX headers of the files we use (`contracts/libraries/Ed25519.sol`, `Ed25519_pow.sol`, `Sha512.sol`); the repository has no LICENSE file | ed25519 signature verification, benchmark candidate (Solidity 0.8 port of chengwenxi/Ed25519) | none |
| crypto-lib (SCL) | https://github.com/get-smooth/crypto-lib | `d714e9824e2e2e44be3c8fd498e0de651ddc9425` (2024-12-14) | MIT; `external/sha512/LibBytes.sol`, which the build compiles, also keeps its 2018 ZeroEx Apache-2.0 notice | ed25519 signature verification (`SCL_EIP6565`), benchmark candidate | none |
| blake2b-solidity | https://github.com/dhl/blake2b-solidity | `a0aa6db4390cd7dc8283f990dbc5d272f9575e64` (2024-10-16) | MIT | BLAKE2b over the EIP-152 precompile: header hashes, trie node hashes, storage key hashes | none |
| solidity-merkle-trees | https://github.com/polytope-labs/solidity-merkle-trees | `6bbc83d5ac33f85761725cf2eba4f8700164e8ba` (2026-06-26) | Apache-2.0 | Substrate storage proof verification (`PolkadotTrie`) | none |
| solidity-merkle-trees, `src/PolkadotTrie.sol` (modified copy at `contracts/src/trie/vendor/PolkadotTrie.sol`) | https://github.com/polytope-labs/solidity-merkle-trees | `6bbc83d5ac33f85761725cf2eba4f8700164e8ba` (2026-06-26) | Apache-2.0 | Substrate storage proof walk with blake2b-256 node hashes | modified: node hash `keccak256` changed to blake2b-256 (original line 69); `VerifyProof` and `ReadChildProof` changed from `pure` to `view`; imports point at the unmodified originals in `contracts/lib/solidity-merkle-trees` |

Apart from forge-std, none of these repositories has release tags, so each is pinned at its
default-branch head of Oct 14, 2026.

The three ed25519 libraries are candidates for a gas benchmark; the ones not chosen will be
removed. farcaster-solidity also contains files under GPL-3.0 (`contracts/libraries/Blake3.sol`,
`contracts/Test.sol`); we do not import them.

A modified copy of a single file lives under `contracts/src/**/vendor/`. It keeps its original
copyright and licence header and says at the top what was changed.

## npm packages (relayer)

Installed from npm at the exact versions in `relayer/package.json` (resolved in
`relayer/package-lock.json`); nothing is copied into the repository.

| Package | Source | Version | Licence | Use | Changes |
|---|---|---|---|---|---|
| @noble/hashes | https://github.com/paulmillr/noble-hashes | 2.4.0 | MIT | BLAKE2b hashing | none |
| @noble/curves | https://github.com/paulmillr/noble-curves | 2.4.0 | MIT | ed25519 signature checks | none |
| tsx (dev) | https://github.com/privatenumber/tsx | 4.23.15 | MIT | runs the TypeScript sources | none |
| typescript (dev) | https://github.com/microsoft/TypeScript | 6.0.3 | Apache-2.0 | type checking | none |
| @types/node (dev) | https://github.com/DefinitelyTyped/DefinitelyTyped | 24.19.0 | MIT | Node.js type definitions | none |
