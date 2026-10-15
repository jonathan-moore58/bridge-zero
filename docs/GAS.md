# Gas benchmark

Measured on Oct 15, 2026, before the light client is written, to settle two questions: does a
Portaldot mainnet import (7 of 10 GRANDPA signatures, the header, a storage proof) fit in one
Sepolia transaction, and which vendored ed25519 library to keep.

## Result

- **One transaction.** A stand-in for the full mainnet import (7 signatures, header hash, state
  root, System.Account proof walk, one storage write) used **5,924,383 gas** as a transaction,
  35% of the 16,777,216 cap (EIP-7825). The rule set before the benchmark was to split the work
  into two transactions only if one signature cost more than about 2.3M gas (7 × 2.3M ≈ 16.1M);
  one signature costs 0.77M.
- **Keep crypto-lib (SCL, `SCL_EIP6565.Verify_LE`); remove farcaster-solidity and
  chengwenxi/Ed25519.** SCL is the cheapest (767,596 gas per signature, against 977,523 for
  farcaster-solidity and 899,232 for chengwenxi with one signature per call frame) and the only
  candidate whose ed25519 code has been audited.

## How it was measured

- Data: the mainnet fixtures in `fixtures/mainnet/`, captured on Oct 14 with
  `relayer/src/capture.ts` (justification and header of block #2,726,202, set 3895, round 18797;
  System.Account proof at the same block).
- Each operation runs inside a small harness contract and is measured with `gasleft()` just
  before and after the library call, in a fresh call frame. The numbers below are those
  deltas unless marked "transaction".
- "Transaction" numbers come from the one-call stand-in (`test/bench/ImportBench.t.sol`), sent
  with the cap as its gas limit. forge runs with `isolate`, so that call executes as its own
  transaction (cold storage and accounts) and `vm.lastFrameGas()` includes the intrinsic gas
  (21,000 plus calldata).
- Rules: Osaka, the fork Sepolia runs (`evm_version = "osaka"` and `isolate = true` in
  `contracts/foundry.toml`). The tests that report gas assert `vm.getEvmVersion() == "osaka"`,
  so the EIP-7883 MODEXP price (which SCL pays three times per signature) is included. The
  bytecode is compiled for prague, the newest target solc 0.8.27 supports, and runs unchanged
  under Osaka, which differs here only in its gas rules.
- Tools: forge 1.8.5 (`51a52c5`), solc 0.8.27 (optimizer on, 200 runs); chengwenxi/Ed25519 with
  solc 0.6.12 (optimizer on, 200 runs, istanbul target).
- Every check also has to give the right answer: each library returns true on RFC 8032
  "TEST SHA(abc)" and on a real mainnet precommit, and false when one bit of the message or the
  signature is flipped. SCL also rejects the same signature with s + L in place of s, and under
  another authority's key. BLAKE2b must reproduce the captured block hashes, and the trie walk
  must return the captured value and fail on any flipped byte.

## ed25519, one signature

The RFC 8032 vector is section 7.1 "TEST SHA(abc)" (64-byte message, so SHA-512 runs over two
blocks, as for the 53-byte GRANDPA payload). The mainnet precommit is precommit 0 of the head
justification: authority index 5, key `0x1047f3ad…48fdd8`, payload
`0x01 ‖ target hash ‖ u32le(2,726,202) ‖ u64le(18797) ‖ u64le(3895)`.

| Library (pinned commit) | RFC 8032 vector | Mainnet precommit | 7 mainnet precommits in one call | Per signature (average of 7) | Flipped bit |
|---|---:|---:|---:|---:|---|
| crypto-lib SCL `Verify_LE` (`d714e98`) | 768,124 | 769,654 | 5,373,173 | **767,596** | false |
| farcaster-solidity `Ed25519.verify` (`cbb770d`) | 988,996 | 987,095 | 6,842,667 | 977,523 | false |
| chengwenxi/Ed25519 `verify` (`34d8c57`, solc 0.6.12) | 892,870 | 899,232 | 9,325,421 | 1,332,203 | false |

- The single-signature columns include the first (cold) access to the library accounts: one for
  SCL, three for farcaster (`Ed25519`, `Sha512`, `Ed25519_pow`).
- farcaster spends most of its cost in its Solidity SHA-512: `Sha512.hash` alone is 706,682 gas
  per signature in the gas report.
- chengwenxi's functions are `internal`, so every verification runs in the caller's frame and
  the memory it allocates is never freed. Memory cost grows with the square of the memory size,
  so seven verifications in one frame average 1.33M each. Kept at 0.90M it would need one
  external call per signature.
- SCL verifies against an extended key: the key's point in Weierstrass form plus the 32-byte key.
  Computing it from the 32-byte key (decompression, then SCL's `Edwards2WeierStrass`) costs
  **20,071 gas once per key**, and the light client stores 3 slots per authority instead of 1.
  `test_scl_keyExpansionRoundTrip` checks that each expanded key converts back to its 32-byte
  key.
- The expansion has to run on chain, from the 32-byte key the chain signed. `Verify_LE` hashes
  the 32-byte key but does its curve arithmetic with the stored point, so a stored point that is
  not the key's own lets whoever knows that point's secret sign for the key.
  `test_scl_extendedKeyMustBeDerivedOnChain` builds such a signature: it verifies against the
  planted point and fails against the point derived from the key.

## BLAKE2b and the trie walk

| Operation (library) | Input | Gas | Check |
|---|---|---:|---|
| blake2b-256 (blake2b-solidity `a0aa6db`) | head header, 191 B | 2,149 | equals block hash `0xae0138…f3c14f` |
| blake2b-256 | set-change header, 1,045 B | 6,672 | equals block hash `0x23675d…5cf355` |
| blake2b-128 | 32-byte account id | 1,469 | equals bytes 32..48 of the System.Account key |
| blake2b-256 of each proof node | 8 nodes, 2,576 B | 24,296 | one node hashes to the state root |
| Trie walk, `PolkadotTrie.VerifyProof` (blake2b copy of solidity-merkle-trees `6bbc83d`) | System.Account proof, 8 nodes, 2,576 B, trie V0 | **378,560** | returns the captured 80-byte AccountInfo |

- BLAKE2b also passes fixed known answers: blake2b-256 and blake2b-128 of the empty string, the
  RFC 7693 blake2b-512("abc") vector, and inputs of 127 to 257 bytes around the 128-byte block
  size (expected digests from Python's `hashlib`).
- The trie walk includes hashing every node (24,296 gas). The rest, about 354,000, is node
  decoding in the Polytope code. That is more than the 0.1-0.3M we had estimated, and still
  small next to the signatures.
- Failing cases: a flipped byte in any of the 8 nodes, a flipped value byte, or a different state
  root reverts with `Incomplete Proof!`; another account's key returns "not present".
- The walk uses `contracts/src/trie/vendor/PolkadotTrie.sol`, a modified copy: node hashes are
  blake2b-256 instead of keccak256, and two functions become `view`. The file header and
  `NOTICE.md` list the changes.

## One transaction, measured

`test/bench/ImportBench.t.sol` runs a stand-in for an import followed by a storage read, in one
call: authority keys are read from storage by index, every signature is checked over the
53-byte payload, the header must hash to the commit target, the state root is read from the
header, the System.Account proof is walked against it, and one slot is written. It leaves out
what the light client adds on top: SCALE decoding of the justification, the header record and
events (estimated below).

| Call (transaction gas) | Calldata | Intrinsic (21,000 + calldata) | Gas | Headroom to 16,777,216 |
|---|---:|---:|---:|---:|
| SCL, mainnet 7 of 10 | 4,772 B | 79,664 | **5,924,383** | 10,852,833 |
| farcaster, mainnet 7 of 10 | 4,772 B | 79,664 | 7,362,819 | 9,414,397 |
| SCL, 1 of 1 (set reduced to one key, mainnet data) | 4,196 B | 72,692 | 1,264,568 | 15,512,648 |

- A flipped bit in a signature, in the header or in a proof node makes the same call revert
  (`invalid signature`, `header hash mismatch`, `Incomplete Proof!`), with the gas limit at the cap.
- Storing a 10-key set is a transaction of 735,637 gas for SCL (3 slots per key), plus 200,080 to
  expand the keys, against 270,971 for 32-byte keys.

## Projections against the cap

Measured parts are taken from the tables above; the rest are estimates and marked as such.

| Transaction | Signatures | Projected gas | Share of 16,777,216 | Basis |
|---|---:|---:|---:|---|
| V3 dev chain: import + vault proof (revive child trie) | 1 | about 1.9M | about 11% | measured 1 of 1 (1.26M) + a second trie walk for the child trie (estimated at the measured 0.38M) + its calldata, mint, replay guard and events (about 0.15M) + light-client additions (about 0.1M) |
| **Mainnet: import + System.Account read** | **7 of 10** | **about 6.0M** | **about 36%** | measured 5.92M + light-client additions (about 0.1M: digest scan, per-precommit target fields, header record, event) |
| Mainnet set change, same keys (as at the 3894 to 3895 change) | 7 of 10 | about 5.6M | about 34% | no storage read (minus the 0.38M walk and the proof calldata); 1,045-B header (6,672 gas to hash); FRNK log parsing estimated at 20k |
| Mainnet set change, 10 new keys | 7 of 10 | about 6.5M | about 39% | as above + key expansion (200,080) + 30 slots for the new extended keys (about 0.66M) |
| Mainnet worst case, every authority signs | 10 of 10 | about 8.4M | about 50% | three more signatures (3 × 767,596) and key loads; the relayer trims to 7 |

Per signature, an import pays 767,596 gas for SCL plus 6,300 to load the stored extended key
(3 cold slots), about 0.77M. With about 0.6M of fixed cost, one transaction holds about 20
signatures, so a set of up to 29 authorities (threshold 20) still fits. Mainnet has 10.

## Decision

1. **One transaction for the mainnet import.** 7 of 10 signatures, the header and the
   System.Account proof fit with about 10.8M gas to spare, so the import is not split into a
   signatures transaction and a header-and-proof transaction.
2. **Keep crypto-lib (SCL).**
   - Gas: 767,596 per signature, 21% below farcaster-solidity (977,523), and below chengwenxi
     even when chengwenxi runs in its own frame (899,232).
   - Audit: its ed25519 code was audited by Veridise (report v2, Sep 6, 2024, in
     `contracts/lib/crypto-lib/doc/Audits/`; reviewed at commit `c559657`). The report lists two
     high-severity findings, both marked fixed: the RIP-7696 fallback (`f40942c`) and EdDSA
     signature malleability (`0af3c3c`, the `s < L` check that `test_scl_rejectsNonCanonicalS`
     exercises). Those commits share no history with the pinned commit (GitHub finds no common
     ancestor; upstream `main` carries the same changes under other hashes), so we compared files
     instead. On the verification path the pinned code is identical to the code after the last
     audit fix (`2145023`, Aug 23, 2024), except for revert-data handling in `SCL_modular.sol`,
     `SCL_sqrtMod_5mod8.sol` and `SCL_mulmuladdX_fullgenW.sol` and one modulus load moved in the
     last of these (changed up to Sep 3, 2024, after the fix commits the report lists).
     farcaster-solidity and chengwenxi have no audit; farcaster also has no LICENSE file, and
     chengwenxi needs solc 0.6. We still treat every vendored cryptography library as unaudited
     for this use: testnet only.
   - Cost of the choice: each authority key is expanded once (20,071 gas) and stored in 3
     slots. Taking on 10 new keys costs about 0.94M (735,637 to store, 200,080 to expand),
     about 0.66M more than storing 32-byte keys (270,971). The light client can skip the rewrite
     when the key list is unchanged, as it was at the last mainnet set change (3894 to 3895). The
     expansion runs on chain, never from a caller's input (see the ed25519 notes above).
3. **Remove farcaster-solidity and chengwenxi-ed25519**: their submodules, NOTICE rows and
   remappings, the chengwenxi note and the `./out` read permission in `contracts/foundry.toml`,
   and their benchmark code (`FarcasterEd25519Bench` and the chengwenxi tests in
   `Ed25519Bench.t.sol`, `FarcasterImportBench` in `ImportBench.t.sol`, and
   `test/bench/legacy/`). The commit that adds this file keeps the full comparison reproducible.

## Reproduce

From `contracts/`, with the submodules checked out (`git submodule update --init`). On the
development machine neither compiler is in Foundry's compiler cache, so both are used from the
git-ignored `contracts/cache/` by path: the Windows builds from the Solidity GitHub releases
(v0.8.27 `solc-windows.exe`, sha256
`8474166f631caa0c51618fddb89ca149080f69c27db06f94bd323eb69f87ffd8`; v0.6.12
`solidity-windows.zip`, sha256
`7a1874cff4cae30b9ee0509631ddae34a8aa573cb2a6104f25e4a6a63ab3ad5f`, from which `solc.exe` and
its three `msvcp140*.dll` files are extracted), both matching the official solc-bin list.
`forge clean` deletes them.

```sh
cd contracts

# 1. The Solidity 0.6 wrapper for chengwenxi/Ed25519, built on its own with solc 0.6.12
forge build --offline --use cache/solc-0.6.12/solc.exe \
  --out out/legacy --cache-path cache/legacy test/bench/legacy/ChengwenxiEd25519Bench.sol

# 2. The benchmarks; the numbers are in the logs
forge test --offline --use cache/solc-0.8.27/solc-0.8.27.exe \
  --skip "test/bench/legacy/**" --match-path "test/bench/*" -vv

# 3. The gas report
forge test --offline --use cache/solc-0.8.27/solc-0.8.27.exe \
  --skip "test/bench/legacy/**" --match-path "test/bench/*" --gas-report
```

- With solc 0.8.27 and 0.6.12 installed by Foundry, a plain
  `forge test --match-path "test/bench/*" -vv` should build the wrapper in the same run, and the
  test then uses that artifact (not tried on the development machine). Without the wrapper the
  three chengwenxi tests are skipped, not failed. `forge build --force` and `forge clean` delete
  `out/legacy`; run step 1 again after them.
- In the gas report, rows of `view` functions are the gas of that call. Rows of
  `importAndRead`, `setAuthorities` and `expandKey` are whole transactions (isolate), so
  `expandKey` shows about 42,500 there against 20,071 for the expansion itself. The
  chengwenxi wrapper is deployed from its artifact and does not appear in the report.

Files: `contracts/test/bench/` (`BenchFixtures.sol`, `Ed25519Bench.t.sol`, `Blake2bBench.t.sol`,
`TrieBench.t.sol`, `ImportBench.t.sol`, `legacy/ChengwenxiEd25519Bench.sol`) and
`contracts/src/trie/vendor/PolkadotTrie.sol`.
