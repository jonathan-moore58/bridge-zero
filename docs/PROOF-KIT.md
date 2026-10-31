# The proof kit

The proof kit lets an EVM contract read Portaldot V3 state that the light client has finalized:
an account's balance, an asset balance, an NFT's owner, a contract's code hash and its storage
slots. It is the light client, the proof libraries and the capture and check tools of this
repository, gathered for other builders: a Solidity library (`PortaldotState`), a stateless
contract that exposes it behind one interface (`PortaldotStateReader`), an example consumer
(`ProvenAssetGate`), and the TypeScript that fetches and checks the proofs (`npm run kit`).

**Proven.** A value stored under the state root of a V3 block that the light client imported. The
light client holds a state root only for a header that more than two thirds of the GRANDPA set
that finalized it signed, checked in Solidity, or for the checkpoint its admin installed. The kit
walks the storage proof from that root to the key and decodes the value; it never takes a state
root from its caller.

**Trusted.** V3's 2 GRANDPA validators (probably development keys); each light client's admin and
the checkpoint it installed (the admin can pause the client and install a new checkpoint while it
is paused or halted); V3's own rules, its sudo key and runtime upgrades included, and for an asset
its owner and admin, who can mint, burn and freeze it; the vendored ed25519, BLAKE2b and trie
code, which is treated as unaudited ([GAS.md](GAS.md#decision); listed in
[NOTICE.md](../NOTICE.md)); and the kit's own decoders, which are new.

**Testnet limits.** The V3 testnet's public nodes have had no new block since the afternoon of
Oct 31 (PKT): read that evening, their newest block was #265,334, stamped 4:01 PM PKT, the
finalized one #265,321, and they reported no peers. The newest block GrandpaLightClient #2 on
Sepolia held that evening was #264,729: every example here reads at that block. The decoders
follow the V3 testnet's runtime (portaldot-v3 3002, trie V1); a runtime upgrade that changes a
layout needs new decoders and a new Reader. A V3 node keeps old state only as long as it chooses
to; the fixture keeps #264,729's proofs for when it does not.

## Addresses

| | Sepolia |
|---|---|
| `GrandpaLightClient` #2, the V3 light client | [`0x4471…dcb0`](https://sepolia.etherscan.io/address/0x447171c4885ad725ee4772e8e3c228adee50dcb0) |
| `StorageProofs`, the trie walk (a linked library) | [`0x5da0…f2a3`](https://sepolia.etherscan.io/address/0x5da053bc5659ba9f725e4b1b5083545b933ef2a3) |
| `PortaldotStateReader` | not deployed yet: the deployment records it in `deployments/sepolia-kit.json` |
| `ProvenAssetGate`, the example | not deployed yet |
| `ProvenBalance` #2, the first example: an account's balance at an imported block, or a header imported and a balance proven in one transaction | [`0x5b41…ad3c`](https://sepolia.etherscan.io/address/0x5b41d227248dc4775ef1061f2dfbf7136ccead3c) |

Base Sepolia and Arbitrum Sepolia have V3 light clients of their own (`GrandpaLightClient` #2 at
`0x3897…0ab6` on each, both at V3 #265,122 on the evening of Oct 31), but in v0.1 the Reader is
for Sepolia only. On a rollup it would be the same contract, bound to that rollup's client and
linked to `StorageProofs`, which is at the same address there; its examples would read at a block
that client holds (#265,122).

Until the Reader is deployed, `npm run kit -- read` runs its local build (`forge build`) at a
stand-in address through `eth_call`'s state override, on a Sepolia node, against the deployed
light client and `StorageProofs`: the same source, the same light client, nothing sent.

## How a read is checked

1. **The block.** The read takes the hash of a V3 block and asks the light client for its state
   root (`stateRootOf`). A hash the client did not import reverts `UnknownBlock(hash)` before
   anything else.
2. **The walk.** `StorageProofs.verifyMain` (the deployed library, reached with `DELEGATECALL`)
   walks the proof from the state root along the key. A proof that does not lead there reverts with
   the walk's reason, `"Incomplete Proof!"` for a missing or changed item. A complete walk that
   shows the key absent reverts `KeyNotPresent(root, key)`, and a key that holds an empty value or
   ends on a branch with no value `EmptyValue(root, key)`: the walk reports those two alike. Proof
   items the walk does not need are accepted.
3. **The value.** The decoder for the item checks the length and the variants of V3's layout and
   reverts with a named error otherwise.

A contract slot is a read in the contract's child trie, three walks, as `BridgeMinter` proves a
lock: the contract's entry and its child root under the block's state root, then the slot under
the child root. The contract's `Revive.AccountInfoOf` entry gives its trie id and code hash; the
root of its child trie is under `":child_storage:default:" ++ trie id` in the main trie (exactly
32 bytes and not zero); the slot is under `blake2_256(slot)` in the child trie. `contractSlot`
proves the trie id from the contract's address and returns the code hash, so a consumer can pin a
contract's code, as `BridgeMinter` pins the vault's; `childSlot` takes a trie id the consumer has
bound already. The code hash covers an EVM contract's immutables, which are part of its runtime
code; a PolkaVM contract keeps its immutables apart from its code (`Revive.ImmutableDataOf`), and
its code hash does not cover them.

## What you can read

The keys and layouts were checked against V3's metadata at #264,729 (runtime portaldot-v3 3002,
the version [V3.md](V3.md) lists). u32 map keys are SCALE little-endian.

| Item | Key | Value as V3 stores it | Example at #264,729 |
|---|---|---|---|
| `System.Account` | prefix ++ blake2_128(id) ++ id, 80 B | `nonce, consumers, providers, sufficients` (u32), `free, reserved, frozen, flags` (u128): 80 B | the deployer's EVM account: nonce 6, free 159.47352201127852 tPOT |
| `Assets.Account` | prefix ++ blake2_128Concat(u32 asset) ++ blake2_128Concat(id), 100 B | `balance` (u128), `status` (0 Liquid, 1 Frozen, 2 Blocked), `reason` (0 Consumer, 1 Sufficient, 2 DepositHeld + u128, 3 DepositRefunded, 4 DepositFrom + account + u128): 18, 34 or 66 B | asset 7777 (pUSD, 6 decimals), `0x3e79…dcdf`: 60,500,000, Liquid |
| `Nfts.Item` | prefix ++ blake2_128Concat(u32 collection) ++ blake2_128Concat(u32 item), 72 B | `owner`, `approvals` (a map of account to optional deadline), `deposit` (account, u128), parsed whole | collection 10, item 3,163,806,249: owned by `0x104e…8161 ++ 0xEE x 12` |
| `Revive.AccountInfoOf` | prefix ++ the 20-byte address, 52 B | a Contract entry of 130 B: variant 0, the trie id (32 B), the code hash, then sizes and deposits; an externally owned account's entry is 5 B | the vault `0xa02E…8ffd`: trie id `0xbe30…7c3a`, code hash `0xa725…663f` |
| A contract slot | `blake2_256(slot)` in the contract's child trie | the 32-byte word; a zero word is not stored | the vault's `commitments[1]`: `0x2d1a…d0a7`, lock 1's commitment |

An Ethereum key's account on V3 is its address followed by 12 bytes of `0xEE` (pallet-revive's
mapping); `PortaldotState.ethAccountId` builds it. A Substrate (`5…`) account keeps its own 32-byte
id: no Ethereum key controls the address pallet-revive derives for it.

## Blocks and freshness

A read is as of the block it names, and only blocks the light client imported can be named. While
the relayer runs and Sepolia's base fee is below its gates (0.05 gwei for a head, 1.5 gwei for a
set change), it imports every validator-set change and a V3 head every 600 blocks, so the client
is at most about 70 minutes behind V3's finalized head ([README](../README.md#status)). Anyone can
import a newer finalized header with `importFinalityProof` (about 1.7M to 1.9M gas), in the same
transaction as the read if needed, as `BridgeMinter.importAndMint` does.

How fresh a value has to be is the consumer's choice:

- A snapshot states a past fact and needs no age check: `ProvenAssetGate` fixes its block at
  deployment.
- A consumer that wants a recent value reads at the light client's latest block: it requires
  `blockHash == latestFinalized().hash` on `GrandpaLightClient` (anyone can import a newer
  finalized header first, in the same transaction). Or it compares numbers: `latestFinalized()`
  returns `(hash, number)`, the Reader returns the number of every block it reads, and the
  consumer requires `latestNumber - number <= maxAge`. `latestFinalized()` is in neither
  `IPortaldotStateReader` nor `IFinalizedStateRoots`: declare it as
  `contracts/src/bridge/IGrandpaImporter.sol` declares the import.
- Either check bounds the age against the light client's newest block, not against V3's head or
  the clock: when the relayer stops, or V3 stops as it did on Oct 31, the client's newest block
  ages too and the check still passes. Comparing numbers holds only within one chain: after a
  testnet reset the admin re-initializes the client on the new chain, the old chain's blocks stay
  readable, and their numbers can come within `maxAge` of the new latest. A consumer that compares
  numbers also requires `lightClient().genesisHash()` to be V3's
  (`0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd`) and stops when it changes.

## From Solidity

### Through the Reader

`contracts/src/kit/IPortaldotStateReader.sol`, with the `IFinalizedStateRoots.sol` beside it that
it imports, is all a consumer compiles. Both declare `pragma solidity 0.8.27;` (exact): compile
them with solc 0.8.27, or copy them with a looser pragma. Every function takes a block hash and the
proof items as `bytes[] calldata`, which a transaction passes straight through, and returns the
block's number with the value:

```solidity
// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.27;

import {IPortaldotStateReader} from "bridge-zero/kit/IPortaldotStateReader.sol";

contract MinimumBalance {
    IPortaldotStateReader public immutable reader;
    constructor(IPortaldotStateReader reader_) { reader = reader_; }

    /// True when `accountId` held at least `amount` free tPOT (native units) at the V3 block `blockHash`.
    function held(bytes32 blockHash, bytes32 accountId, uint128 amount, bytes[] calldata proof) external view returns (bool) {
        (IPortaldotStateReader.AccountInfo memory info,) = reader.accountInfo(blockHash, accountId, proof);
        return info.free >= amount;
    }
}
```

`free` counts funds that locks and freezes hold: in V3's AccountData (the newer layout, with bit
127 of `flags` set), `frozen` is a floor under the account's balance, not an amount apart from
`free`. `MinimumBalance` counts locked funds too.

| Function | Returns |
|---|---|
| `stateRootOf(blockHash)` | the state root and number of an imported block |
| `accountInfo(blockHash, accountId, proof)` | `AccountInfo` (nonce, consumers, providers, sufficients, free, reserved, frozen, flags) |
| `assetAccount(blockHash, assetId, accountId, proof)` | balance and status |
| `nftOwner(blockHash, collection, item, proof)` | the owner's 32-byte account id |
| `contractInfo(blockHash, address, accountProof)` | trie id and code hash |
| `contractSlot(blockHash, address, slot, (account, childRoot, slot))` | the word and the contract's code hash |
| `childSlot(blockHash, trieId, slot, childRootProof, slotProof)` | the word, for a trie id already bound |
| `readMain(blockHash, key, proof)` | any main-trie key's raw value |

### With the library

`PortaldotState` (`contracts/src/kit/PortaldotState.sol`) holds the same reads as internal
functions that take the light client (`IFinalizedStateRoots`, which `GrandpaLightClient`
implements), plus the key builders (`systemAccountKey`, `assetsAccountKey`, `nftsItemKey`,
`reviveAccountInfoKey`, `reviveSlotKey`, `mappingSlot`, `ethAccountId`) and the decoders. Pass a
light client fixed at deployment (an immutable), never one from calldata: whoever picks the light
client picks the state root. In a Foundry project:

```sh
forge install jonathan-moore58/bridge-zero
```

(the repository's own libraries are git submodules of it: `git submodule update --init --recursive`
fetches them where an install did not), with these remappings (the kit is Solidity 0.8.27,
exact):

```
bridge-zero/=lib/bridge-zero/contracts/src/
blake2b-solidity/=lib/bridge-zero/contracts/lib/blake2b-solidity/contracts/
solidity-merkle-trees/=lib/bridge-zero/contracts/lib/solidity-merkle-trees/src/
```

The walk stays in the `StorageProofs` library, which a contract that uses `PortaldotState` links:
on Sepolia, `lib/bridge-zero/contracts/src/trie/StorageProofs.sol:StorageProofs:0x5DA053Bc5659ba9f725E4b1B5083545B933EF2a3`
in `foundry.toml`'s `libraries` (forge deploys it by itself in tests). Linking keeps the walk out
of the consumer's code: the Reader with every read is 7,658 bytes.

### Errors

| Error | When |
|---|---|
| `UnknownBlock(bytes32)` | the light client did not import the block |
| `EmptyProof()`, `EmptyKey()` | no proof items, or an empty key |
| `Error("Incomplete Proof!")` (also `"Bad Format!"`, `"Unallowed encoding"`) | the proof does not lead from the state root to the key: a missing or changed item, another block's proof |
| `KeyNotPresent(bytes32 root, bytes key)` | the proof shows that the key holds nothing; with `contractSlot`, also no contract at the address or a contract that has stored nothing ([Absent values](#absent-values)) |
| `EmptyValue(bytes32 root, bytes key)` | the key holds an empty value, or ends on a branch without a value: the walk reports both alike |
| `ChildRootLength(uint256)`, `ZeroChildRoot()` | the child-trie root is not 32 bytes, or is zero |
| `AccountInfoLength(uint256)` | a `System.Account` value that is not 80 bytes |
| `AssetAccountMalformed(uint256 length, uint8 status, uint8 reason)` | an `Assets.Account` value of another length than its reason's, or a status above 2 |
| `NftItemMalformed(uint256)` | an `Nfts.Item` value that does not parse |
| `NotAContract(uint256 length, uint8 variant)` | an `AccountInfoOf` value that is not a 130-byte Contract entry (an externally owned account's is `NotAContract(5, 1)`) |
| `SlotLength(uint256)` | a slot value that is not 32 bytes |

## Absent values

`KeyNotPresent` is a proof of absence: the walk was complete and found nothing under the key. An
account with no `Assets.Account` entry holds none of the asset, and a slot the contract never set
(or set to zero) is not stored. A consumer that wants to treat absence as zero calls the Reader in
a `try` and compares the revert's selector with `IPortaldotStateReader.KeyNotPresent.selector`;
any other revert, a walk error above all, is never absence.

`contractSlot` makes three walks, and each can revert `KeyNotPresent` with its own key: 52 bytes
when no contract is at the address at that block (`Revive.AccountInfoOf`), 55 bytes when the
contract has stored nothing (it has no child trie), and 32 bytes when the slot is empty. A revert
returns no code hash, so a successful read's code pin does not apply to it. To read a slot that may
be empty, pin the contract with `contractInfo` first (it reverts for a missing contract), then read
the slot with `childSlot` and that trie id, and treat only `childSlot`'s `KeyNotPresent` as zero:
for a pinned contract, a missing child trie means that it has stored nothing. `childSlot` also
reverts `KeyNotPresent` for a trie id that has no child trie, so its trie id comes from a pinned
`contractInfo`, never from a caller:

```solidity
(bytes32 trieId, bytes32 codeHash,) = reader.contractInfo(blockHash, CONTRACT, accountProof);
if (codeHash != CODE_HASH) revert WrongCode(codeHash);
bytes32 word;
try reader.childSlot(blockHash, trieId, slot, childRootProof, slotProof) returns (bytes32 w, uint32) {
    word = w;
} catch (bytes memory reason) {
    if (bytes4(reason) != IPortaldotStateReader.KeyNotPresent.selector) {
        assembly ("memory-safe") {
            revert(add(reason, 32), mload(reason))
        }
    }
}
```

`PinnedSlotOrZero` in `contracts/test/unit/PortaldotState.t.sol` is this consumer, tested at
#264,729: lock 1's commitment, zero for the absent `commitments[8]`, and a revert for other code,
an address with no contract, an externally owned account and a flipped proof item.

`EmptyValue` is neither presence nor absence to a consumer. A map whose value is `()` (V3's
`Nfts.Account`, for one) stores each of its keys with an empty value, so a key that is present
reverts `EmptyValue`; a key that ends on a branch, which holds no value, reverts it too.

## The vault's commitment as a contract slot

`BridgeMinter` uses the kit's pattern: a contract on V3 writes a commitment into a slot, and a
contract on Sepolia proves the slot. The vault stores `commitments[nonce]` at
`mappingSlot(nonce, 0)`, the commitment of a lock's fields
(`keccak256(abi.encode(LOCK_TAG, 420420777, vault, dstChainId, dstMinter, recipient, amount, nonce))`);
the minter recomputes it from the fields it is given and compares. The same proofs let anyone
relay a lock themselves: `fetchLockProof` (in `relayer/src/state-fetch.ts`) builds the
`LockProof` for `BridgeMinter.mint` at a block the client holds, which skips the signature
checks. Lock 0's mint at a block the client held took 723,446 gas on a Sepolia node, and importing
that block 1,879,557 more (464,086 and 1,694,517 in forge under Osaka rules, `test_stepByStep` in
`contracts/test/unit/BridgeMinterLive.t.sol`; [BRIDGE.md](BRIDGE.md#costs)); a first mint writes
new storage, which Sepolia prices above Osaka.

## The example: `ProvenAssetGate`

`contracts/src/kit/examples/ProvenAssetGate.sol` keeps an allowlist of the EVM addresses whose V3
account (`holder ++ 0xEE x 12`) held at least `minimum` of asset `assetId` at the V3 block
`snapshotBlock`; another contract gates on `gate.claimed(msg.sender)`.

- **Which block.** Fixed at deployment; the constructor reverts `UnknownBlock` unless the light
  client imported it.
- **How fresh.** Exactly as of that block: a snapshot states a past fact, so no age is checked.
- **Replay.** One claim per holder. The proof is checked before the record, as in `BridgeMinter`:
  a tampered proof reverts with a proof error, a valid repeat with `AlreadyClaimed(holder)`.
- **Who.** Anyone can send a claim; the record names the holder the proof names, never
  `msg.sender`. A record is a proven fact about the holder, not the holder's consent: anyone can
  make it. Holders are Ethereum-key accounts: a `5…` account cannot claim, and the address of a
  contract on V3 gets a record that only whoever controls that address on Sepolia can use
  (pallet-revive derives contract addresses as Ethereum does).
- **What counts.** The account's balance, whatever its status, Blocked included: a frozen balance
  is still held, and the status is in the `Claimed` event. The asset's own status (an asset frozen
  as a whole) is not read.
- **What it trusts.** The light client, V3's rules (sudo, runtime upgrades, and the asset's owner
  and admin), the Reader's code, and pallet-revive's mapping of EVM accounts.

With asset 7777 and a minimum of 1 pUSD at #264,729, a claim for `0x3e79…dcdf` (60.5 pUSD) records
it for 512,204 gas in forge, a claim for `0x4f7d…df25` (0.1 pUSD) reverts
`BelowMinimum(100000, 1000000)`, and the same claim twice reverts `AlreadyClaimed`
(`contracts/test/unit/ProvenAssetGate.t.sol`). The holders are public V3 chain data, read only.

The kit's first example is `ProvenBalance` (`contracts/src/kit/ProvenBalance.sol`; #2 on Sepolia,
in the addresses above): it proves an account's `System.Account` entry at an imported block, or
imports a header and proves the entry in the same transaction, and emits the free balance.

## From TypeScript

The TypeScript is in `relayer/src/`, beside the capture and check tools, with no new dependency:

- `state.ts`, no network: the keys (`assetsAccountKey`, `nftsItemKey`, `mappingSlot`, and
  `systemAccountKey`, `reviveAccountInfoKey`, `reviveSlotKey`, `ethAccountId`, `commitmentSlot`
  from the relayer's modules), the decoders (`decodeSystemAccount`, `decodeAssetAccount`,
  `decodeNftItem`, `decodeContractInfo`), the contracts' checks in the contracts' order and with
  their error names (`readMain`, `readChild`, `accountInfoAt`, `assetAccountAt`, `nftOwnerAt`,
  `contractAt`, `contractSlotAt`, `StateProofError`), the Reader's and the gate's ABI
  (`readerCalldata`, `decodeReaderResult`, `claimCalldata`), and the fixture's offline check
  (`checkStateReads`).
- `state-fetch.ts`, read-only network: `importedBlock` (a block the light client holds),
  `nodeAgrees` (the V3 node's header of it), `fetchMain`, `fetchContractSlot` and
  `fetchLockProof`.
- `kit.ts`, the tool: `npm run kit`.

```
npm run kit -- read balance --account <0x address | 0x 32-byte id>   [--at <V3 block hash>]
npm run kit -- read asset   --asset <id> --account <...>             [--at]
npm run kit -- read nft     --collection <n> --item <n>              [--at]
npm run kit -- read slot    --contract <0x address> --slot <0x hex | decimal> [--at]
npm run kit -- read lock    --nonce <n>                              [--at]
npm run kit -- capture [--out <dir>] [--at <hash>] [--force]
npm run kit -- check   [--dir <dir>]
options: --network sepolia (only Sepolia has a Reader in v0.1), --rpc <wss url> (the V3 node),
         --reader <address> (default: deployments/sepolia-kit.json), --from-fixture <file>
```

It runs on Node.js 24, from `relayer/`. The Sepolia RPC is `SEPOLIA_RPC_URL`, or
`https://ethereum-sepolia-rpc.publicnode.com`; the V3 node is `wss://test-node-v3.portaldot.dev`
unless `--rpc` names another.

A read takes B, the V3 block it is at: the light client's latest block, or `--at`. It checks that
the V3 node's header of B hashes to B and names the client's state root, fetches the proof
(`--from-fixture <file>` takes it from a fixture instead, for when the node no longer has the
state), walks it off chain, then has the Reader make the same read on a Sepolia node and requires
the same answer. It signs and sends nothing.

From `relayer/`, after `npm ci` there and, in `contracts/`, `git submodule update --init` and
`forge build --skip test --skip script` (the Reader step runs that build until the Reader is
deployed; without it the step is skipped with a note), on Oct 31, when #264,729 was the client's
latest block (once it holds a newer one,
`--at 0x6dc44fe16f3e36c49978c422cc11550971f4b3234f9ca23dbac9b99bb0556f50` reads at #264,729
again):

```
$ npm run kit -- read balance --account 0xD9838A86cF83C28Ee486544060D1cA4Ca2971071
System.Account(0xD9838A86cF83C28Ee486544060D1cA4Ca2971071 ++ 0xEE x 12) on the Portaldot V3 testnet, proven on Sepolia
  B: V3 #264,729 0x6dc44fe1…b0556f50, imported by GrandpaLightClient #2 0x447171c4…ee50dcb0 on Sepolia (read at block 12,034,534): the client's latest block; state root 0x9b0ab2c3…c8695aaa, finalized by set 73
  ok    the V3 node's header of B hashes to B and names the same state root
  the read: System.Account, key 80 B; proof 8 items, 2,396 B, from the V3 node test-node-v3.portaldot.dev
  ok    off chain, with the contracts' checks: nonce 6, consumers 0, providers 1, sufficients 0, free 159.47352201127852 tPOT (15947352201127852), reserved 0, frozen 0, flags 2^127
  ok    PortaldotStateReader (not deployed yet: the local build at a stand-in address, by eth_call's state override).accountInfo returns the same AccountInfo at #264,729: 452,621 gas (eth_estimateGas: the whole transaction, under Sepolia's current rules), calldata 3,204 B
Nothing was signed or sent.
```

```
$ npm run kit -- read lock --nonce 1
Lock 1 of the vault 0xa02EE16EB03d2cf1aeF199F7658FB8c8E3188ffd: commitments[1] on the Portaldot V3 testnet, proven on Sepolia
  B: V3 #264,729 0x6dc44fe1…b0556f50, imported by GrandpaLightClient #2 0x447171c4…ee50dcb0 on Sepolia (read at block 12,034,538): the client's latest block; state root 0x9b0ab2c3…c8695aaa, finalized by set 73
  ok    the V3 node's header of B hashes to B and names the same state root
  the read: Revive.AccountInfoOf(0xa02EE16EB03d2cf1aeF199F7658FB8c8E3188ffd), the root of its child trie, and slot 0xada50131…52a59e7d under blake2_256(slot); proofs of 9 + 8 + 3 items (20 items, 4,018 B), from the V3 node test-node-v3.portaldot.dev
  ok    the contract: code hash 0xa72553f5…811c663f, trie id 0xbe307c2d…e2f47c3a, child root 0x6d322d0f…e706db6f
  ok    off chain, with the contracts' checks: commitments[1] = 0x2d1ab009f006fd70b9653d09a56a3b4927775d6251c4879df9c7a1364b0ad0a7
  ok    the commitment of the lock deployments/v3-testnet.json locks[1] records: 1 tPOT to 0xD9838A86cF83C28Ee486544060D1cA4Ca2971071 on chain 11155111, minter 0x8287B3Baf205CA8456f98346F13064AA7fCDcB9E
  ok    PortaldotStateReader (not deployed yet: the local build at a stand-in address, by eth_call's state override).contractSlot returns the same word and code hash at #264,729: 877,450 gas (eth_estimateGas: the whole transaction, under Sepolia's current rules), calldata 6,052 B
  ok    BridgeMinter 0x8287b3ba…7fcdcb9e.commitmentOf(0xD9838A86cF83C28Ee486544060D1cA4Ca2971071, 100000000000000, 1) on Sepolia returns the same word
  ok    BridgeMinter.mint(p) at #264,729 as an eth_call (3,460 B of calldata) reverts NonceAlreadyUsed(1): the proofs pass, and lock 1 was minted already
Nothing was signed or sent.
```

The mint's `eth_call` shows that the proofs pass the deployed minter: it gets as far as the replay
guard, since lock 1 was minted in row 55.

Without network access, `check` verifies the fixture again: every header hash, the 2-of-2
signatures under set 73 with the light client's own check, every walk and value, and every tamper:

```
$ npm run kit -- check --dir ../fixtures/v3-testnet-kit
...
All checks passed: 41 passed, 0 failed.
```

## Gas

Each read as its own transaction at #264,729: in forge (`test_gas_reads` in
`contracts/test/unit/PortaldotState.t.sol`, Osaka rules, with the 21,000 base and the calldata)
and on a Sepolia node (`eth_estimateGas` on the local build through the state override, Oct 31,
under the rules Sepolia runs since Oct 6, which price a call's base, its calldata and new state
differently: [GAS.md](GAS.md#measured-light-client)).

| Read | Proof | forge | Sepolia node |
|---|---|---|---|
| `accountInfo` (the deployer) | 8 items, 2,396 B | 453,099 | 452,621 |
| `assetAccount`, 18-byte value (`0x3e79…dcdf`) | 9 items, 2,110 B | 480,441 | 480,180 |
| `assetAccount`, 66-byte value behind its hash | 9 items, 2,219 B | 455,188 | |
| `assetAccount`, Frozen | 8 items, 1,546 B | 403,261 | |
| `nftOwner` | 8 items, 1,600 B | 364,768 | 363,589 |
| `contractInfo` (the vault) | 9 items, 1,893 B | 405,402 | |
| `contractSlot` (`commitments[1]`) | 9 + 8 + 3 items | 874,583 | 877,450 |
| `childSlot` (`commitments[1]`, trie id bound) | 8 + 3 items | 502,305 | |
| `readMain` (the deployer's `System.Account`) | 8 items | 423,692 | |
| `ProvenAssetGate.claim` (a new record) | 9 items | 512,204 | |

The walk is most of it, and it grows with the key's depth in the trie. Reading from a block the
client holds already costs no signature check; a consumer that imports its own header first pays
about 1.7M to 1.9M more. The forge figures do not include Sepolia's newer pricing of new state,
which a claim's new record pays ([GAS.md](GAS.md)).

## Tests and fixtures

- `fixtures/v3-testnet-kit/state-reads.json`: B (#264,729) and its parent, the set that signs B,
  `grandpa_proveFinality(B)` (345 bytes) and the signers hint, the light client's answers for B and
  the transaction that imported it, 15 main-trie reads (present, absent, a branch without a value,
  an externally owned account's entry), the vault's child root and 11 slots, and 6 tampers, each
  with the outcome the contracts give. Written by `npm run kit -- capture`; `npm run kit -- check`
  passes 41 checks.
- `contracts/test/unit/PortaldotState.t.sol` (32 tests) and `ProvenAssetGate.t.sol` (11 tests): a
  real `GrandpaLightClient` initialized at set 73 with B's parent as the checkpoint imports B with
  its finality proof (2 of 2), and a `PortaldotStateReader` on top makes every read (the gate's
  frozen-balance case uses a stand-in reader: no EVM account holds a frozen balance at B). Every
  single byte of one proof flipped (2,110 flips), one flip per item of every other proof, wrong
  keys, a block the client did not import, absent keys, an address with no contract, a trie id
  with no child trie, values of another length or variant, an externally owned account's entry
  and B's proofs at another block each revert with the expected error; a key that holds an empty
  value reverts `EmptyValue` (a one-leaf trie under a stand-in light client); extra proof items
  are accepted; `PinnedSlotOrZero` follows [Absent values](#absent-values).
- `relayer/src/state.test.ts` (28 tests): the TypeScript keys, decoders, walks and tampers against
  the same fixture, lock 1's `LockProof` for `BridgeMinter.mint`, and the Reader's and the gate's
  calldata against values from `cast`.

## Not in v0.1

- An npm package (`@bridge-zero/proof-kit` stays the name for a later publish) and a packaged
  command line that re-checks a mint or proves any key, with an import mode for blocks the light
  client does not hold yet.
- The Reader on Base Sepolia, Arbitrum Sepolia or other chains: a deployment on each, with
  examples read at a block that chain's client holds.
- Absence proofs that return zero on chain: the deployed `StorageProofs` reverts `KeyNotPresent`,
  and a consumer catches it (above).
- Membership in a map whose value is `()`, such as `Nfts.Account`: a key that is present reverts
  `EmptyValue`, as a key that ends on a branch does (above).
- More readers: Uniques, PoolAssets, Oracle and AssetConversion, an NFT-ownership example, and
  extrinsic inclusion.
- A light client for Portaldot's V3 mainnet, and other finality backends behind
  `IFinalizedStateRoots`.

## Licence

The kit's sources are Apache-2.0, as the project is ([LICENSE](../LICENSE)). Three files the
library compiles, `SubstrateProofs.sol`, `StorageProofs.sol` and `Scale.sol`, keep the
`UNLICENSED` SPDX line they were deployed and verified with; the Apache-2.0 licence covers them
too ([README](../README.md#licence)). The third-party code the kit builds on (blake2b-solidity,
the modified PolkadotTrie walk from solidity-merkle-trees, forge-std, and the relayer's @noble
libraries) is listed in [NOTICE.md](../NOTICE.md); the kit adds none.
