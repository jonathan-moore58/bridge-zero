# From a lock on V3 to wtPOT on Sepolia

How tPOT locked in [`PortaldotVault`](../contracts/src/bridge/PortaldotVault.sol) on the Portaldot
V3 testnet becomes wtPOT on Sepolia, minted by
[`BridgeMinter`](../contracts/src/bridge/BridgeMinter.sol) from a proof, and how wtPOT goes back on
the trusted return path. The vault and the V3 testnet are described in [V3.md](V3.md); why the
Sepolia side is built this way is in [DECISIONS.md](DECISIONS.md) (D5 to D7). Measured on Oct 20,
2026 with forge and with read-only `eth_simulateV1` calls to a Sepolia node; nothing here was sent.

## The contracts

| Contract | Chain | Address | Role |
|---|---|---|---|
| `PortaldotVault` | V3 testnet (chain id 420420777) | `0xa02EE16EB03d2cf1aeF199F7658FB8c8E3188ffd` | holds locked tPOT; stores one commitment per lock |
| `GrandpaLightClient` #2 | Sepolia | `0x447171c4885Ad725eE4772E8e3c228aDeE50Dcb0` | follows V3's GRANDPA finality; stores finalized state roots |
| `StorageProofs` | Sepolia | `0x5DA053Bc5659ba9f725E4b1B5083545B933EF2a3` | the trie walk, a library linked into the minter |
| `BridgeMinter` | Sepolia | `0x8287B3Baf205CA8456f98346F13064AA7fCDcB9E` (`CREATE(deployer, 31)`), not deployed yet | proves locks and mints; holds no funds |
| [`WrappedTPOT`](../contracts/src/bridge/WrappedTPOT.sol) (wtPOT) | Sepolia | `0x1fcBbd66922AC5AA20219a5c16c2591A76B4Cb14` (`CREATE(deployer, 32)`), not deployed yet | ERC-20, 14 decimals; only the minter mints and burns |

The deployer is `0xD9838A86cF83C28Ee486544060D1cA4Ca2971071`. Neither BridgeMinter nor WrappedTPOT
has an owner or an admin: the minter's light client, vault, V3 chain id, vault code hash and token,
and the token's minter, are fixed in their constructors. `deployments/sepolia-bridge.json` records
both once the mint tool deploys them.

## From a lock to wtPOT

**1. The lock, on V3.** `lock(11155111, 0x8287B3Baf205CA8456f98346F13064AA7fCDcB9E, recipient)` with
the amount as value stores, at `commitments[nonce]` (the vault's slot 0):

```
commitment = keccak256(abi.encode(keccak256("BridgeZero.Lock.v1"), 420420777, vault,
                                  11155111, minter, recipient, amountNative, nonce))
```

`amountNative` is in native base units of tPOT (14 decimals), which are wtPOT units. Lock 0 is
1 tPOT (100,000,000,000,000 units) for `0xD983…1071`, committed as `0x9eba08c9…41e23435` at V3 block
#101,009.

**2. Finality, on Sepolia.** GrandpaLightClient #2 imports a V3 header B with B's GRANDPA finality
proof, checking on chain the signatures of the authority set it follows (2 of 2 on the testnet),
and stores B's state root.

**3. Three proofs under B's state root**, read from a V3 node at B (`state_getReadProof`,
`state_getChildReadProof`):

| Proof | Trie | Key | Value |
|---|---|---|---|
| Account | main | `twox128("Revive") ++ twox128("AccountInfoOf") ++ vault`, 52 bytes | the vault's `AccountInfo`, 130 bytes: variant 0 (Contract), the trie id at bytes 2 to 33, the code hash at bytes 34 to 65, then counters and deposits |
| Child root | main | `":child_storage:default:" ++ trie id`, 55 bytes | the root of the vault's child trie, 32 bytes |
| Slot | the vault's child trie | `blake2_256(keccak256(abi.encode(nonce, 0)))`, 32 bytes | `commitments[nonce]`, a 32-byte word |

The account proof is read once: `bindVault` checks that the entry is a contract whose code hash is
the vault's (`0xa72553f5…811c663f`) and stores its trie id (`0xbe307c2d…e2f47c3a`). Every mint carries
the other two.

**4. The check.** The minter recomputes the commitment with its own `block.chainid` and
`address(this)`, the vault and V3 chain id it was deployed with, and the recipient, amount and nonce
the caller gives. If the proven word is that commitment and the nonce is not used yet, it marks the
nonce used and mints the amount to the recipient. Otherwise it reverts, in this order: with a proof
error for a proof that does not hold (the walk's `Incomplete Proof!`, or `KeyNotPresent`,
`ChildRootLength` or `ZeroChildRoot` from SubstrateProofs), with `CommitmentLength` or
`CommitmentMismatch(expected, found)`, and only then with `NonceAlreadyUsed(nonce)`. Before the
bind it reverts `VaultNotBound`, for an amount of 0 `ZeroAmount`, and for a block the light client
has not imported, with the client's `UnknownBlock`.

**5. One transaction.** `importAndMint(header, finalityProof, signers, lockProof)` does all of it:
the import (or, if B is imported already, the import's checks again without a write), the bind if
the minter is not bound, and the mint. `lockProof` is the tuple `(blockHash, accountProof,
childRootProof, slotProof, recipient, amount, nonce)`; `signers` is the light client's hint, 2 bytes
per counted precommit. For a block already imported, `mint(lockProof)` mints alone and
`bindVault(blockHash, accountProof)` binds alone. Anyone can send any of them, and nothing is taken
from the sender (D7).

**Timing.** The V3 node keeps state for about 256 blocks (25 minutes), so the proofs are read at the
latest finalized block, B; once read they stay valid. The light client imports B only while B is
newer than its latest header and signed by its current set (a header at or below the latest that it
never imported reverts `NotNewer`). The testnet changes sets about every 6 hours: if the client is
behind, `npm run relay -- --chain v3` brings it up first, then the bundle is read again; if the
client moves past B before the mint, the bundle is read again. The lock itself does not expire.

## Deploying: the order and the nonce-31 rule

Build with the Sepolia profile, which links StorageProofs at compile time so that Etherscan
verification compiles the same code:

```
cd contracts
FOUNDRY_PROFILE=sepolia forge build --skip test --skip script
```

The deployer's next two Sepolia transactions are these, in this order:

1. Nonce 31: `BridgeMinter(0x447171c4885Ad725eE4772E8e3c228aDeE50Dcb0, 0xa02EE16EB03d2cf1aeF199F7658FB8c8E3188ffd, 420420777, 0xa72553f50cdf645fb343b2cf089e431a1b26fb07e80f4e2236d55bf9811c663f, 0x1fcBbd66922AC5AA20219a5c16c2591A76B4Cb14)`,
   which lands at `0x8287B3Baf205CA8456f98346F13064AA7fCDcB9E`, the minter lock 0 names.
2. Nonce 32: `WrappedTPOT(0x8287B3Baf205CA8456f98346F13064AA7fCDcB9E)`, which lands at
   `0x1fcBbd66922AC5AA20219a5c16c2591A76B4Cb14`, the token the minter was given.

On Oct 20 (Sepolia block #11,950,547) the deployer was at nonce 31, mined and pending, with 0.19996
ETH. Nothing else may be sent from it first: any other transaction at nonce 31 would leave lock 0
mintable nowhere (D5). Until BridgeMinter is mined, the relayer that keeps the light client current
signs with another key: run from the deployer, `npm run relay -- --chain v3` plans its imports from
nonce 31 (its dry run of Oct 20 did).

`npm run mint -- deploy` has a Sepolia node run both creations; with `--send --account <keystore>
--password-file <path>` it sends them one at a time, records each transaction's hash in
`deployments/sepolia-bridge.json` before publishing it, checks the receipt, the code at each address
against the build and the constructor arguments, and prints the `forge verify-contract` command for
each contract. Once the light client is in the set of a fresh bundle (`npm run relay -- --chain v3`,
then `bundle` again), `npm run mint -- mint --bundle <file>` (with `--send` and any key) sends lock
0's `importAndMint`: it verifies V3 finality, binds the vault, proves `commitments[0]` and mints 1
wtPOT. The [runbook](#runbook) has the commands in order.

## The mint tool

`npm run mint` in `relayer/` ([`relayer/src/mint.ts`](../relayer/src/mint.ts); its header has the
details):

| Command | What it does |
|---|---|
| `bundle --nonce <n> [--out <dir>]` | Reads, at the latest finalized V3 block B, everything `importAndMint` of lock n needs: B's header, `grandpa_proveFinality(B)` with its signatures checked under the set that signs B, the signers hint, and the three proofs, each walked against B's state root (the account entry must name the vault's code hash, the slot must hold lock n's commitment). Writes `<dir>/mint-bundle.json` (by default `fixtures/v3-testnet-mint`) and nothing else. |
| `bundle --check <file>` | Checks a bundle file offline the same way; `npm run check` checks the fixtures, bundles included. |
| `plan [--bundle <file> \| --nonce <n>] [--sandbox] [--from <address>]` | Dry run with `eth_simulateV1`, validation on, from the senders' own nonces and balances, first with the 16,777,216 cap as gas limit and then with the gas + 10%: the two creations while the minter is not deployed (refused unless the deployer's next nonce is 31 and `CREATE(deployer, 31)` is the lock's minter), then `importAndMint`. Prints the gas, fees, events and the wtPOT balance after, and runs the same `importAndMint` once more from another sender, which has to verify B again and revert `NonceAlreadyUsed`. While the light client lags behind the bundle's set it asks for `npm run relay -- --chain v3` first. `--sandbox` runs the path on a fresh GrandpaLightClient created in the simulation, at the bundle's set, so it needs no relayer run. |
| `deploy [--bundle <file> \| --nonce <n>] [--send --account <keystore> --password-file <path>]` | The two creations (above), for the minter the lock names (lock 0 by default); `--send` needs the deployer's keystore. |
| `mint [--bundle <file> \| --nonce <n>] [--from <address>] [--send --account <keystore> --password-file <path>]` | `importAndMint` of the lock; any key can send it. |
| `mint --tamper signature\|header\|proof\|amount\|recipient` or `mint --replay`, with the options of `mint`, or `--sandbox` | The demo's two reverts, as transactions. A tamper is the lock's `importAndMint` with one part changed, which has to revert with the error that names that part, before the mint or after it; the replay, once the lock is minted, is the same `importAndMint` again, which has to revert `NonceAlreadyUsed`. The dry run requires exactly that revert; `--send` records the transaction, then checks status 0 in its receipt and the revert, replayed on its block. `--sandbox` runs them on `plan --sandbox`'s path: a tamper before the mint and again after it, the replay after it. |
| `status` | The minter (bound or not, trie id, burns), the token (total supply, balances) and the vault's locks on V3, each with its commitment checked, marked minted or not, whether each burn has been released on V3, and the demo's reverts in the record. |

`plan` and `mint` take the bundle file given, a bundle read on the spot for `--nonce`, or else
`fixtures/v3-testnet-mint/mint-bundle.json`. Without `--send` nothing is signed: a dry run refuses
`--account` and `--password-file`. A plan with a creation refuses a Sepolia build that was not
compiled from the checkout's sources (each source's keccak-256 in the build's metadata, read with
LF or CRLF line ends), and a dry run prints the `forge verify-contract` command of each contract it
would create. Exit codes: 0 done, 1 a check failed or the tool refused, 2 a node could not be
reached, 3 a sent transaction is still pending.

## Costs

Gas on Sepolia, against the 16,777,216 cap per transaction:

| Transaction | Sepolia node | forge (Osaka rules) |
|---|---:|---:|
| Create BridgeMinter (6,204 bytes of runtime code) | 9,806,643 (58.5%) | |
| Create WrappedTPOT (1,923 bytes) | 3,183,649 (19.0%) | |
| `importAndMint` of lock 0: import (2 of 2 signatures), bind, mint | **2,948,867 (17.6%)** | 2,410,447 (14.4%) |
| The same call again: the header checked again, then `NonceAlreadyUsed` | 2,007,522 | 2,011,922 |
| `importAndMint` of lock 0 when the client holds B already: B verified again, bind, mint | | 2,359,151 |
| `importFinalityProof` alone | 1,879,557 | 1,694,517 |
| `bindVault` alone, B imported (7 proof items) | 416,343 | 333,523 |
| `mint` alone, B imported and the vault bound (6 + 2 proof items) | 723,446 | 464,086 |
| `mint` again (reverts `NonceAlreadyUsed`) | 386,623 | 391,823 |

- Every call row is lock 0 from the bundle captured at V3 #104,587 (`fixtures/v3-testnet-mint`, set
  29), on a GrandpaLightClient created from the build and initialized at set 29, with B's parent as
  the checkpoint (or B itself, for the rows that need B imported). The node ran the creations and
  calls with `eth_simulateV1` at Sepolia blocks #11,950,309 to #11,950,547, the light client
  created in the simulation from the Sepolia build (`npm run mint -- plan --sandbox` runs the
  creations, `importAndMint` and the same call again); forge ran them on Osaka rules, each call a
  transaction of its own (`isolate`).
  `contracts/test/unit/BridgeMinterLive.t.sol` prints the forge column; `BridgeMinter.t.sol`
  prints the forge gas of `bindVault` and `mint` on block #101,027 (`fixtures/v3-testnet-vault`):
  323,436 and 456,693.
- Sepolia's rules since Oct 6 price new code and new storage slots above Osaka
  ([GAS.md](GAS.md#measured-light-client)): about 1,600 gas per byte of code, and a first mint
  writes three new slots (`used[0]`, the recipient's balance, `totalSupply`).
- At the base fee of Oct 20 (13 to 15 wei per gas) and the tool's priority fee (1,000 wei), both
  creations cost about 0.000000013 ETH; at the tool's maximum fee (0.01 gwei), at most 0.00013 ETH.
- On V3, a lock pays the vault's storage deposit, 3.8415 tPOT for each new storage item (11.5245
  tPOT for the first lock, 3.8415 for each later one) and a fee of about 0.023 tPOT
  ([V3.md](V3.md#costs)). The minter charges nothing.

## Runbook

Step 1 starts in the repository's root; every later command runs in `relayer/`, except step 3's,
in `contracts/`. A command without `--send` is a dry run and signs nothing. `bz-deployer` is the
Foundry keystore of the deployer `0xD9838A86cF83C28Ee486544060D1cA4Ca2971071` and `<path>` its
password file. Until step 2 is mined, the deployer sends nothing else.

**1. Build and rehearse.**

```
cd contracts
FOUNDRY_PROFILE=sepolia forge build --skip test --skip script
forge test
cd ../relayer
npm ci
npm run mint -- plan --sandbox
```

The sandbox runs steps 2 and 6 on Sepolia's EVM against a light client created in the simulation,
so it needs no relayer run; it ends with "The dry run passed. Nothing was signed or sent."

**2. Deploy: nonces 31 and 32.**

```
npm run mint -- deploy
npm run mint -- deploy --send --account bz-deployer --password-file <path>
npm run mint -- status
```

The dry run refuses unless the deployer's next nonce, mined and pending, is 31. `--send` sends
BridgeMinter at nonce 31 (`0x8287B3Baf205CA8456f98346F13064AA7fCDcB9E`), checks its receipt and its
code, then sends WrappedTPOT at nonce 32 (`0x1fcBbd66922AC5AA20219a5c16c2591A76B4Cb14`), and records
both in `deployments/sepolia-bridge.json`. If a run stops between the two, run it again once any
pending transaction is mined: it reads what is deployed and sends only what is missing.

**3. Verify both contracts on Etherscan**, from `contracts/` with `ETHERSCAN_API_KEY` set (step 2
prints the same commands):

```
cd ../contracts
FOUNDRY_PROFILE=sepolia forge verify-contract 0x8287B3Baf205CA8456f98346F13064AA7fCDcB9E src/bridge/BridgeMinter.sol:BridgeMinter --chain sepolia --verifier etherscan --watch --compiler-version 0.8.27+commit.40a35a09 --evm-version prague --num-of-optimizations 200 --libraries src/trie/StorageProofs.sol:StorageProofs:0x5da053bc5659ba9f725e4b1b5083545b933ef2a3 --constructor-args 0x000000000000000000000000447171c4885ad725ee4772e8e3c228adee50dcb0000000000000000000000000a02ee16eb03d2cf1aef199f7658fb8c8e3188ffd00000000000000000000000000000000000000000000000000000000190f1ca9a72553f50cdf645fb343b2cf089e431a1b26fb07e80f4e2236d55bf9811c663f0000000000000000000000001fcbbd66922ac5aa20219a5c16c2591a76b4cb14
FOUNDRY_PROFILE=sepolia forge verify-contract 0x1fcBbd66922AC5AA20219a5c16c2591A76B4Cb14 src/bridge/WrappedTPOT.sol:WrappedTPOT --chain sepolia --verifier etherscan --watch --compiler-version 0.8.27+commit.40a35a09 --evm-version prague --num-of-optimizations 200 --constructor-args 0x0000000000000000000000008287b3baf205ca8456f98346f13064aa7fcdcb9e
cd ../relayer
```

**4. Bring light client #2 to V3's current set.**

```
npm run relay -- --chain v3
npm run relay -- --chain v3 --send --account <relayer keystore> --password-file <path>
```

On Oct 20 the client was at set 25 (#92,604) and V3 at set 30: the dry run planned the five set
changes #93,035, #96,612, #100,199, #103,784 and #107,359, then the head, six transactions and
13,842,577 gas. Run it after step 2 only: it plans from its sender's next nonce, and from the
deployer before the deploy that is nonce 31. relay.ts advises a key of its own for the relayer,
since the deployer is the client's admin.

**5. Read the bundle** at V3's latest finalized block B:

```
npm run mint -- bundle --nonce 0
```

It writes `fixtures/v3-testnet-mint/mint-bundle.json`, which `plan`, `mint` and
`BridgeMinterLive.t.sol` read. Once read, the proofs stay valid; the bundle stays usable while the
light client is in B's set and below B, or holds B. The relayer imports a head about once an hour
and V3 changes sets about every 6 hours; if the client moves past B or V3 changes sets first, the
mint's dry run says so, and steps 4 and 5 run again. A relayer left running with `--watch` is best
stopped until step 6 is mined: a head it imports between the dry run and the mint makes the mint
revert `NotNewer`.

**6. Mint lock 0**, in one transaction:

```
npm run mint -- mint
npm run mint -- mint --send --account bz-deployer --password-file <path>
npm run mint -- status
```

Any key can send it. The transaction imports B (`HeaderImported`), binds the vault (`VaultBound`),
proves `commitments[0]` and mints 1 wtPOT to `0xD9838A86cF83C28Ee486544060D1cA4Ca2971071`
(`Transfer`, `Minted`). The tool checks the four events and the balance, then calls the same
`importAndMint` on the receipt's block, which has to revert `NonceAlreadyUsed(0)`.

**7. The demo's reverts:** a tampered mint and the replay, as transactions on Sepolia.

```
npm run mint -- mint --tamper signature
npm run mint -- mint --tamper signature --send --account bz-deployer --password-file <path>
npm run mint -- mint --replay
npm run mint -- mint --replay --send --account bz-deployer --password-file <path>
npm run mint -- status
```

The tamper flips byte 0 of R in the first precommit the signers hint counts, inside the finality
proof: the light client reverts `InvalidSignature(0, 0)`, whether it is sent before step 6 or after
it. The replay is step 6's call again: the client verifies B again, then the minter reverts
`NonceAlreadyUsed(0)`; it needs step 6 mined. Each dry run requires exactly that revert, and `--send`
records the transaction, then checks status 0 in its receipt and the revert, replayed on its block;
`status` lists them. Any key can send them. The other tampers, with their gas on the Sepolia node
(`npm run mint -- mint --sandbox --tamper <part>`, on the #104,587 bundle):

| `--tamper` | What changes | Reverts with | Gas before the mint | after |
|---|---|---|---:|---:|
| `signature` | byte 0 of R in the first counted precommit | `InvalidSignature(0, 0)`, the light client's | 2,461,082 | 2,460,905 |
| `header` | byte 0 of B's state root, in the header | `FinalityProofBlockMismatch(B, the changed header's hash)`, the light client's | 357,272 | 357,272 |
| `proof` | the middle byte of the slot proof's first item | `Error("Incomplete Proof!")`, the trie walk's | 2,296,789 | 1,986,052 |
| `amount` | the amount, times 1,000 | `CommitmentMismatch(the commitment of that amount, the proven word)` | 2,316,080 | 2,005,343 |
| `recipient` | the recipient's last byte | `CommitmentMismatch`, likewise | 2,316,068 | 2,005,331 |
| (`--replay`) | nothing | `NonceAlreadyUsed(0)` | | 2,007,522 |

Each is sent with the gas limit it is dry-run with, 5,000,000, and not with its gas + 10% as the
other transactions are: on the Sepolia node a call that reverts can need a limit well above the gas
it reports. The `amount` tamper before the mint reports 2,316,080 gas and reverts without data below
a limit of about 2,650,000.

## The trusted return path

1. **Burn, on Sepolia.** A holder calls `burn(amount, v3Recipient)` on the minter. It destroys
   `amount` of the caller's wtPOT (no approval is needed: the token lets only the minter burn, and
   the minter burns only from its caller), takes the next burn nonce and emits
   `BurnRequested(burnNonce, from, v3Recipient, amount, burnId)` with

   ```
   burnId = keccak256(abi.encode(keccak256("BridgeZero.Burn.v1"), 11155111, minter, burnNonce))
   ```

   the vault's convention (`srcChainId`, `srcMinter`, `burnNonce`); `burnIdOf(burnNonce)` returns
   it.
2. **The committee.** The 2-of-3 committee (D1) reads the event on Sepolia, checks the burn and
   approves on V3 `multisig.asMulti` of `revive.call(vault, 0, weight limit, deposit limit,
   release(burnId, v3Recipient, amount))` ([V3.md](V3.md#release-trusted) has the limits).
3. **The release, on V3.** The vault, called by its `RELEASER` (the committee's multisig address
   `0xA08A7f7DEd49CC81F901Fb42Fec00edFC48c0fc1`), pays `amount` native base units (`amount × 10^4`
   wei) to `v3Recipient`, at most `outstanding`, once per burn id.

Trusted: nothing on V3 checks the burn. The committee can release without a burn, or not release
after one, and any 2 of its 3 members can pay out up to `outstanding` (D1). On Sepolia the burn is
final: the minter cannot undo it and does not see the release. `v3Recipient` has to be an address
someone controls on V3 ([V3.md](V3.md#release-trusted)); the minter refuses only the zero address.

## What the minter trusts

- **The light client.** A state root counts as V3's when GrandpaLightClient #2 holds it: imported
  with the signatures of the GRANDPA authority set the client follows (2 validators on the testnet,
  both of which sign), or installed as a checkpoint by the client's admin, the deployer
  (`initialize`, and `reinitialize` while the client is paused or halted, are TRUSTED in the
  client). If that set or that admin accepts a wrong state root, the minter mints against it.
- **V3's own rules.** What the vault's storage holds is whatever V3's runtime wrote; the testnet has
  a sudo key (`5Ca3hX34TqdyiwDu6kL1TqyQuo4aHvBSXYhWSCbyH8N1Xc5J`, `Sudo.Key` in
  `fixtures/probe/test-node-v3.portaldot.dev.json`), which can change any account's code or storage.
- **The vault's code.** `vaultCodeHash` is keccak-256 of the vault code the minter was deployed for:
  the 899-byte V3 build of `PortaldotVault.sol`, which keeps `commitments` at slot 0, stores a
  commitment only for tPOT it receives, and has no way to destroy itself or change its code. The
  bind checks it once (D6).
- **The vendored code.** The trie walk in StorageProofs (Polytope's solidity-merkle-trees, with
  blake2b-256), BLAKE2b and the ed25519 library the light client uses are vendored, and treated as
  unaudited for this use ([GAS.md](GAS.md#decision)): testnet only.
- **Not the sender.** Whoever submits a mint brings data, not trust: the header, the finality proof
  and every storage proof are checked against what the light client and the minter already hold,
  and the recipient and the amount come from the proven commitment.
- **Not the committee, for minting.** The committee of the trusted return path decides releases on
  V3 (above); it has no say over what the minter mints.
