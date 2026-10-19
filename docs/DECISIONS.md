# Decisions

Four decisions behind the vault on the Portaldot V3 testnet
([`contracts/src/bridge/PortaldotVault.sol`](../contracts/src/bridge/PortaldotVault.sol)) and the
way it is deployed, made on Oct 19, 2026. The numbers were measured on the V3 testnet that day
(`wss://test-node-v3.portaldot.dev`, runtime portaldot-v3 3002) with read-only calls and dry runs;
[V3.md](V3.md) lists them with the commands that deploy, lock and read the vault.

## D1. A lean vault; the trusted return path is a pallet-multisig account

**Decision.** The vault checks no signatures. The return path (a burn on the other chain, a release
of tPOT on V3) is trusted, and its 2-of-3 check is done by pallet-multisig: the committee's multisig
account is the vault's `RELEASER`, the only caller `release` accepts. The vault has no owner and no
admin, no upgrade path and no other function that changes its state.

**Why.** On V3 every byte of contract code costs a storage deposit, about 0.078 tPOT a byte on top
of about 13 tPOT: a `reviveApi.instantiate` dry run of a 1,100-byte runtime charged 98.91 tPOT, and
one of this vault (899 bytes) charges 83.232 tPOT. Checking two ECDSA signatures in the vault (the
digest, `ecrecover`, two distinct members, low `s`, three stored keys) would add several hundred bytes
of code to pay for and to review. pallet-multisig is already in the runtime and gives the same trust:
any 2 of the 3 members can release, as they could with signatures checked by the vault.

**How a release works.**

- The committee is `5DLnLMAsR3kkHnHndC4eRWhMFXPjCU8bGiSugCjUmGJaBism`,
  `5F99Y91UgQ4EDTubPWWPvWKc3ghhVA77nc7HjRhsTyXn38z9` and
  `5EJJYKuM5aaKwgegKGinAbnL7dK3m3QziyqusPotTQ3S7w1E`, threshold 2. pallet-multisig derives its
  account from the sorted members and the threshold: `5FTrjzEPPdxo3WP1RcQGTzUX1y1udD7tAkaETV1iLH24xPk3`
  (account id `0x965d40ea…2c646af8`).
- pallet-revive gives that account the address `0xA08A7f7DEd49CC81F901Fb42Fec00edFC48c0fc1`, the last
  20 bytes of keccak-256 of the account id (`reviveApi.address` returns the same). It is the vault's
  `RELEASER` and the `msg.sender` the vault sees.
- Two members approve `multisig.asMulti` of `revive.call(vault, 0, weight limit, deposit limit,
  release(burnId, to, amountNative))`. The vault refuses any other caller (`NotReleaser`), a burn id
  it has released before (`AlreadyReleased`), and more than it holds for open locks
  (`ExceedsOutstanding`).
- The burn id is the committee's: `keccak256(abi.encode(keccak256("BridgeZero.Burn.v1"), srcChainId,
  srcMinter, burnNonce))`, derived from the burn it approves. The vault does not check how it was
  derived.
- The multisig account pays the storage deposit of each release (3.8415 tPOT for `released[burnId]`),
  so it has to hold tPOT; the members pay the fees of their approvals.

**Trust.** Release is the trusted part of the design: whoever holds 2 of the 3 committee keys can pay
out any amount up to `outstanding`, to any address. The vault limits only the total, and each burn id
to one release. tPOT that reaches the vault's account outside `lock` (a `balances.transfer` to its
account id) belongs to no claim and cannot be released: `outstanding` counts locks only.

## D2. Every lock names its destination

**Decision.** A lock names the destination chain and the minter there, and the commitment the vault
stores binds them together with the V3 chain id and the vault:

```
commitment = keccak256(abi.encode(keccak256("BridgeZero.Lock.v1"), block.chainid, address(this),
                                  dstChainId, dstMinter, recipient, amountNative, nonce))
```

The minter recomputes it from the lock's recipient, amount and nonce, the V3 chain id and vault
address it is configured with, and its own `block.chainid` and `address(this)`. It mints only if the
slot it proves (`commitments[nonce]`, slot 0) holds exactly that word, and only once per nonce.

**Why.** A commitment of recipient, amount and nonce alone could be minted by any minter that follows
the same vault: a second minter after a redeploy, or a minter on another chain. Naming the destination
in the lock makes one lock mintable once, by one minter, on one chain. (A replay of the same nonce at
the same minter is stopped by the minter's `used[nonce]`, not by the commitment.) Naming it per lock, rather than in the vault's
constructor, keeps the vault independent of the minter: the vault can be deployed before any minter
exists, one vault can serve several destinations, and each minter accepts only the locks that name
it.

**Consequences.** `lock` rejects a zero chain id, minter or recipient (`ZeroArgument`). A lock that
names the wrong chain or minter cannot be minted anywhere; its tPOT stays counted in `outstanding`
until the trusted return path releases it. The `Locked` event carries every input of the commitment.
`test_minterRecomputesTheCommitment` in
[`contracts/test/unit/PortaldotVault.t.sol`](../contracts/test/unit/PortaldotVault.t.sol)
recomputes it the way a minter does, from the event and its own chain id and address, and shows that
another minter, or the same minter on another chain, gets a different word.

## D3. Deployed by the testnet sr25519 account; locked with Ethereum transactions

**Decision.** The testnet sr25519 account `5ERJiUnzmQwEF98X3rGyKiNsyjrcenLGJST3MULCjUSwgPJ7`
deploys the vault with `revive.instantiateWithCode`. Users lock with ordinary Ethereum transactions
through the EVM RPC, from any wallet.

**Why.**

- A unique address. Without a salt, pallet-revive gives a new contract the CREATE address of the
  deployer's address and account nonce. The EVM deployer `0xD9838A86cF83C28Ee486544060D1cA4Ca2971071`
  is at nonce 0 on V3, and its first contract would land at `0x51da20bE3e6E23296f2c435b16445aAe7A18b77E`,
  where the same deployer put the SCL library on Sepolia. The sr25519 account's address is
  `0xB621f9A9Dd96BA88681c40B04657CEf602854e24` (keccak-256 of its account id), at nonce 1, so the
  vault will be `0xa02EE16EB03d2cf1aeF199F7658FB8c8E3188ffd`. No secp256k1 key stands behind
  `0xB621…4e24`, so no Ethereum chain can see a transaction from it, nor a contract it created at
  the vault's address.
- The extrinsic carries its weight and storage deposit limits explicitly, taken from a
  `reviveApi.instantiate` dry run of the same call from the same account.
- Locking needs nothing special: the vault is EVM bytecode at an ordinary address, so a lock is a
  call with value from MetaMask, cast or any library, and its `Locked` event is read with
  `eth_getLogs`.

## D4. EVM bytecode from solc 0.8.27 for cancun, built by a foundry profile of its own

**Decision.** The vault runs as EVM bytecode (pallet-revive's `AllowEVMBytecode` is true), compiled
by solc 0.8.27 for cancun in `[profile.v3]` of
[`contracts/foundry.toml`](../contracts/foundry.toml), which writes to `contracts/out-v3`. The
default profile keeps osaka for the Sepolia side. The V3 build is the one deployed.

**Why.** pallet-revive runs solc output with REVM, so neither resolc nor PolkaVM is needed. A
constructor probe run with `eth_call` on V3 executed solc 0.8.27 code compiled for cancun (`PUSH0`
included) and saw `block.chainid` 420420777, `msg.value` and value transfers, keccak-256 and the
`ecrecover` precompile behave as on Ethereum.

**The profile also** compiles the vault with the IR pipeline (only `src/bridge/**`: the ed25519
library does not compile with it), leaves the CBOR metadata out of the bytecode, and keeps the AST in
the artifacts, which names the immutables. The first two are for size (below).

**Both builds behave the same.** The vault's test suite runs in full on the vault as the default
profile compiles it and on the `out-v3` build (`PortaldotVaultSourceTest` and
`PortaldotVaultV3BuildTest`, 40 tests each, and an invariant test of each), and checks the `out-v3`
build itself: compiled from the current source, cancun, IR pipeline, no CBOR metadata, at most 900
bytes, its deployed code the build's with the two immutables filled in. On V3 itself, read-only: an
`eth_call` constructor probe deployed the `out-v3` build, locked, released and locked again, and
stored the commitments [`relayer/src/vault.ts`](../relayer/src/vault.ts) computes; and the build
placed by a state override at the vault's predicted address answered `eth_call` with the expected
nonces and errors.

## The size budget: 900 bytes of runtime code

The vault as first written (six getters, `abi.encode` for the commitment, checked arithmetic, a
Solidity `call` for the payout) compiled to 1,842 bytes. The V3 build is 899 bytes. In the order the
changes were made, all measured with solc 0.8.27 for cancun:

| Change | Runtime code |
|---|---:|
| As first written, legacy pipeline, CBOR metadata | 1,842 B |
| IR pipeline | 1,366 B |
| No CBOR metadata (V3 has no explorer that reads it) | 1,312 B |
| `unchecked` where nothing can overflow (the nonce, outstanding, the payout) | 1,249 B |
| The payout as a plain `call` in assembly, without copying return data | 1,174 B |
| The commitment hashed in assembly: the same eight words as `abi.encode`, in free memory | 1,111 B |
| One check per argument instead of `\|\|` (same errors, same order) | 1,084 B |
| No getters for `NATIVE_TO_ETH_RATIO`, `RELEASER` and `nextNonce` | 896 B |
| The two addresses widened to `uint256` in Solidity before the hash | 899 B |

**Getters dropped.** With every other change, the vault with all six getters is 1,087 bytes, and with
the four storage getters but neither immutable getter 939. So three getters go: the two immutables,
whose getters cost the most (each pushes a 32-byte immutable: 69 and 79 bytes), and `nextNonce`
(40 bytes). `outstanding()` stays because the committee reads it before it approves a release, and
the two mapping getters (`commitments`, `released`) stay because reading those without them needs
the slot hashed. What was dropped is still readable:

- `nextNonce` is the word at slot 1 (`eth_getStorageAt(vault, 1)`); every `Locked` log also carries
  its nonce.
- `NATIVE_TO_ETH_RATIO` and `RELEASER` are in the deployed code, at the build's immutable references.
  `npm run v3-vault -- deploy` compares the deployed code with the build and both values, and
  `deployments/v3-testnet.json` records them; the ratio is also pallet-revive's `NativeToEthRatio`.
