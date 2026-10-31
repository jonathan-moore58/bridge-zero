// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.27;

import {IFinalizedStateRoots} from "./IFinalizedStateRoots.sol";
import {IPortaldotStateReader} from "./IPortaldotStateReader.sol";
import {Scale} from "../grandpa/Scale.sol";
import {StorageProofs} from "../trie/StorageProofs.sol";
import {SubstrateProofs} from "../trie/SubstrateProofs.sol";

/// @title PortaldotState
/// @notice Reads Portaldot V3 state that a light client finalized: the value of a storage key under
/// the state root of a block the light client imported, and the decoding of what most contracts
/// want from it (an account's balance, an asset balance, an NFT's owner, a contract's code hash and
/// its slots), as the V3 testnet's runtime stores them (portaldot-v3 3002, trie V1).
///
/// The block is the only way to a state root: every read takes a block hash and asks the light
/// client for its state root (IFinalizedStateRoots.stateRootOf). A GrandpaLightClient answers only
/// for a header it stored as finalized: one imported with signatures from more than two thirds of
/// the set that finalized it, or the checkpoint its admin installed (trusted). For any other hash
/// it reverts UnknownBlock. No function here takes a state root from its caller; the helpers that
/// take one are private.
///
/// The walk is the StorageProofs library, linked and reached with DELEGATECALL, with the checks and
/// errors of SubstrateProofs.verifyMain: EmptyProof, EmptyKey, the walk's own reasons ("Incomplete
/// Proof!", "Bad Format!", "Unallowed encoding"), KeyNotPresent for a complete walk that shows the
/// key absent (a proof that it holds nothing), and EmptyValue for a key that ends on a branch
/// without a value. A child-trie read is two main-trie walks, as BridgeMinter makes it: the child
/// root under ":child_storage:default:" ++ trie id, exactly 32 bytes and not zero, then the key
/// under that root. Proof items the walk does not need are accepted, as the walk accepts them.
///
/// The decoders follow V3's layouts and revert with a named error for any other length or variant.
/// A runtime upgrade that changes a layout needs new decoders, and a contract built on these is
/// redeployed with them.
library PortaldotState {
    // ------------------------------------------------------------------ keys and layouts

    /// twox128("System") ++ twox128("Account"), checked against V3's metadata on Oct 31.
    bytes32 internal constant SYSTEM_ACCOUNT = 0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9;
    /// twox128("Assets") ++ twox128("Account").
    bytes32 internal constant ASSETS_ACCOUNT = 0x682a59d51ab9e48a8c8cc418ff9708d2b99d880ec681799c0cf30e8886371da9;
    /// twox128("Nfts") ++ twox128("Item").
    bytes32 internal constant NFTS_ITEM = 0xe8d49389c2e23e152fdd6364daadd2cce6636c7091b616c035068763633f33e2;
    /// twox128("Revive") ++ twox128("AccountInfoOf").
    bytes32 internal constant REVIVE_ACCOUNT_INFO_OF =
        0x735f040a5d490f1107ad9c56f5ca00d2ae37ff0591fdbbcd9c2406df7147a9dc;
    /// The last 12 bytes of an EVM account's id on V3: its 20-byte address, then 12 bytes of 0xEE
    /// (pallet-revive's AccountId32Mapper).
    bytes12 internal constant ETH_ACCOUNT_SUFFIX = 0xeeeeeeeeeeeeeeeeeeeeeeee;

    /// pallet-assets AccountStatus.
    uint8 internal constant LIQUID = 0;
    uint8 internal constant FROZEN = 1;
    uint8 internal constant BLOCKED = 2;

    /// AccountInfo: nonce, consumers, providers, sufficients (u32), free, reserved, frozen, flags
    /// (u128).
    uint256 internal constant ACCOUNT_INFO_SIZE = 80;
    /// A Revive.AccountInfoOf Contract entry with a 32-byte trie id: the variant (0), the trie id
    /// as a Vec<u8> (compact length 0x80, then 32 bytes), the code hash, storage_bytes and
    /// storage_items (u32), three u128 deposits, immutable_data_len (u32) and dust (u32).
    uint256 internal constant CONTRACT_INFO_SIZE = 130;
    uint256 internal constant TRIE_ID_AT = 2;
    uint256 internal constant CODE_HASH_AT = 34;
    /// An Nfts.Item value's deposit, after the approvals: the depositor (32 bytes) and the amount
    /// (u128).
    uint256 internal constant NFT_DEPOSIT_SIZE = 48;

    /// A System.Account value that is not an 80-byte AccountInfo (ProvenBalance's error).
    error AccountInfoLength(uint256 length);
    /// An Assets.Account value whose length is not its reason's (18 bytes for Consumer, Sufficient
    /// and DepositRefunded, 34 for DepositHeld, 66 for DepositFrom), or whose status is not 0 to 2.
    /// `status` and `reason` are the bytes at 16 and 17, or 0 where the value is shorter.
    error AssetAccountMalformed(uint256 length, uint8 status, uint8 reason);
    /// An Nfts.Item value that does not parse as ItemDetails.
    error NftItemMalformed(uint256 length);
    /// A Revive.AccountInfoOf value that is not a 130-byte Contract entry with a 32-byte trie id
    /// (BridgeMinter's error). An externally owned account's entry is 5 bytes, variant 1.
    error NotAContract(uint256 length, uint8 variant);
    /// A contract slot's value that is not a 32-byte word.
    error SlotLength(uint256 length);

    // ------------------------------------------------------------------ the block

    /// The state root and number of the imported block `blockHash`: the light client's
    /// UnknownBlock for any other hash.
    function stateRootOf(IFinalizedStateRoots lc, bytes32 blockHash)
        internal
        view
        returns (bytes32 stateRoot, uint32 number)
    {
        return lc.stateRootOf(blockHash);
    }

    // ------------------------------------------------------------------ reads

    /// The non-empty value of main-trie `key` at the imported block `blockHash`.
    function readMain(IFinalizedStateRoots lc, bytes32 blockHash, bytes memory key, bytes[] calldata proof)
        internal
        view
        returns (bytes memory value, uint32 number)
    {
        bytes32 root;
        (root, number) = lc.stateRootOf(blockHash);
        value = StorageProofs.verifyMain(root, proof, key);
    }

    /// System.Account(accountId) at the imported block `blockHash`.
    function accountInfoAt(IFinalizedStateRoots lc, bytes32 blockHash, bytes32 accountId, bytes[] calldata proof)
        internal
        view
        returns (IPortaldotStateReader.AccountInfo memory info, uint32 number)
    {
        bytes memory value;
        (value, number) = readMain(lc, blockHash, systemAccountKey(accountId), proof);
        info = decodeAccountInfo(value);
    }

    /// The free balance of System.Account(accountId) at the imported block `blockHash`.
    function freeBalanceAt(IFinalizedStateRoots lc, bytes32 blockHash, bytes32 accountId, bytes[] calldata proof)
        internal
        view
        returns (uint128 free, uint32 number)
    {
        IPortaldotStateReader.AccountInfo memory info;
        (info, number) = accountInfoAt(lc, blockHash, accountId, proof);
        free = info.free;
    }

    /// Assets.Account(assetId, accountId) at the imported block `blockHash`: the balance and the
    /// status (LIQUID, FROZEN or BLOCKED).
    function assetAccountAt(
        IFinalizedStateRoots lc,
        bytes32 blockHash,
        uint32 assetId,
        bytes32 accountId,
        bytes[] calldata proof
    ) internal view returns (uint128 balance, uint8 status, uint32 number) {
        bytes memory value;
        (value, number) = readMain(lc, blockHash, assetsAccountKey(assetId, accountId), proof);
        (balance, status) = decodeAssetAccount(value);
    }

    /// The owner of Nfts.Item(collection, item) at the imported block `blockHash`.
    function nftOwnerAt(IFinalizedStateRoots lc, bytes32 blockHash, uint32 collection, uint32 item, bytes[] calldata proof)
        internal
        view
        returns (bytes32 owner, uint32 number)
    {
        bytes memory value;
        (value, number) = readMain(lc, blockHash, nftsItemKey(collection, item), proof);
        owner = decodeNftOwner(value);
    }

    /// The trie id and code hash of the contract at `account` (Revive.AccountInfoOf) at the
    /// imported block `blockHash`. A consumer that pins a contract's code compares the code hash.
    function contractAt(IFinalizedStateRoots lc, bytes32 blockHash, address account, bytes[] calldata accountProof)
        internal
        view
        returns (bytes32 trieId, bytes32 codeHash, uint32 number)
    {
        bytes memory value;
        (value, number) = readMain(lc, blockHash, reviveAccountInfoKey(account), accountProof);
        (trieId, codeHash) = decodeContractInfo(value);
    }

    /// Slot `slot` of the contract at `account` at the imported block `blockHash`, with the
    /// contract's code hash: the trie id from its AccountInfoOf entry (p.account), the root of its
    /// child trie (p.childRoot), then the slot under blake2_256(slot) in it (p.slot). An empty slot
    /// is not stored: KeyNotPresent. The three proofs come in one struct: as three arrays they
    /// would not fit the stack.
    function contractSlotAt(
        IFinalizedStateRoots lc,
        bytes32 blockHash,
        address account,
        bytes32 slot,
        IPortaldotStateReader.ContractSlotProof calldata p
    ) internal view returns (bytes32 word, bytes32 codeHash, uint32 number) {
        bytes32 root;
        (root, number) = lc.stateRootOf(blockHash);
        bytes32 trieId;
        (trieId, codeHash) = _contractInfo(root, account, p.account);
        word = _childSlot(root, trieId, slot, p.childRoot, p.slot);
    }

    /// Slot `slot` of the child trie `trieId` at the imported block `blockHash`, for a trie id the
    /// caller has bound to a contract already (as BridgeMinter binds the vault's).
    function childSlotAt(
        IFinalizedStateRoots lc,
        bytes32 blockHash,
        bytes32 trieId,
        bytes32 slot,
        bytes[] calldata childRootProof,
        bytes[] calldata slotProof
    ) internal view returns (bytes32 word, uint32 number) {
        bytes32 root;
        (root, number) = lc.stateRootOf(blockHash);
        word = _childSlot(root, trieId, slot, childRootProof, slotProof);
    }

    // ------------------------------------------------------------------ keys

    /// System.Account(accountId): the prefix ++ blake2_128Concat(accountId), 80 bytes.
    function systemAccountKey(bytes32 accountId) internal view returns (bytes memory) {
        return SubstrateProofs.systemAccountKey(accountId);
    }

    /// Assets.Account(assetId, accountId): the prefix ++ blake2_128Concat(u32le(assetId)) ++
    /// blake2_128Concat(accountId), 100 bytes.
    function assetsAccountKey(uint32 assetId, bytes32 accountId) internal view returns (bytes memory) {
        return bytes.concat(
            ASSETS_ACCOUNT,
            SubstrateProofs.blake2_128Concat(abi.encodePacked(Scale.swap32(assetId))),
            SubstrateProofs.blake2_128Concat(abi.encodePacked(accountId))
        );
    }

    /// Nfts.Item(collection, item): the prefix ++ blake2_128Concat(u32le(collection)) ++
    /// blake2_128Concat(u32le(item)), 72 bytes.
    function nftsItemKey(uint32 collection, uint32 item) internal view returns (bytes memory) {
        return bytes.concat(
            NFTS_ITEM,
            SubstrateProofs.blake2_128Concat(abi.encodePacked(Scale.swap32(collection))),
            SubstrateProofs.blake2_128Concat(abi.encodePacked(Scale.swap32(item)))
        );
    }

    /// Revive.AccountInfoOf(account): the prefix ++ the 20-byte address (Identity hasher), 52
    /// bytes.
    function reviveAccountInfoKey(address account) internal pure returns (bytes memory) {
        return bytes.concat(REVIVE_ACCOUNT_INFO_OF, bytes20(account));
    }

    /// The child-trie key of a contract's slot: blake2_256 of the 32-byte slot index.
    function reviveSlotKey(bytes32 slot) internal view returns (bytes32) {
        return SubstrateProofs.blake2_256(abi.encodePacked(slot));
    }

    /// The slot of entry `key` of a Solidity mapping at slot `slot`: keccak256(abi.encode(key,
    /// slot)). The vault's commitments[nonce] is mappingSlot(nonce, 0).
    function mappingSlot(uint256 key, uint256 slot) internal pure returns (bytes32) {
        return keccak256(abi.encode(key, slot));
    }

    /// The V3 account id of an Ethereum key's address: the address ++ 0xEE x 12. A Substrate (5...)
    /// account keeps its own 32-byte id; no Ethereum key controls the address revive derives for
    /// it.
    function ethAccountId(address account) internal pure returns (bytes32) {
        // 20 + 12 bytes.
        // forge-lint: disable-next-line(unsafe-typecast)
        return bytes32(bytes.concat(bytes20(account), ETH_ACCOUNT_SUFFIX));
    }

    // ------------------------------------------------------------------ values

    /// An AccountInfo: exactly 80 bytes, else AccountInfoLength.
    function decodeAccountInfo(bytes memory value) internal pure returns (IPortaldotStateReader.AccountInfo memory info) {
        if (value.length != ACCOUNT_INFO_SIZE) revert AccountInfoLength(value.length);
        info.nonce = _u32(value, 0);
        info.consumers = _u32(value, 4);
        info.providers = _u32(value, 8);
        info.sufficients = _u32(value, 12);
        info.free = _u128(value, 16);
        info.reserved = _u128(value, 32);
        info.frozen = _u128(value, 48);
        info.flags = _u128(value, 64);
    }

    /// An AssetAccount { balance: u128, status: u8, reason, extra: () }: the balance and the
    /// status. The length must be the reason's: 18 bytes for Consumer (0), Sufficient (1) and
    /// DepositRefunded (3), 34 for DepositHeld (2, a u128), 66 for DepositFrom (4, an account and a
    /// u128); the status at most 2. Else AssetAccountMalformed.
    function decodeAssetAccount(bytes memory value) internal pure returns (uint128 balance, uint8 status) {
        uint256 length = value.length;
        status = length > 16 ? uint8(value[16]) : 0;
        uint8 reason = length > 17 ? uint8(value[17]) : 0;
        uint256 expected = reason == 2 ? 34 : reason == 4 ? 66 : reason < 5 ? 18 : 0;
        if (length != expected || status > BLOCKED) revert AssetAccountMalformed(length, status, reason);
        balance = _u128(value, 0);
    }

    /// The owner of an ItemDetails { owner: AccountId32, approvals: BTreeMap<AccountId32,
    /// Option<u32>>, deposit: { account: AccountId32, amount: u128 } }, parsed whole: the owner
    /// (32 bytes), the approvals (a compact count of one or two bytes, then per approval an account
    /// and an Option<u32> of 1 or 5 bytes), and exactly 48 bytes of deposit after them. Else
    /// NftItemMalformed.
    function decodeNftOwner(bytes memory value) internal pure returns (bytes32 owner) {
        uint256 length = value.length;
        if (length < 32 + 1 + NFT_DEPOSIT_SIZE) revert NftItemMalformed(length);
        uint256 at = 32;
        uint256 b0 = uint8(value[at]);
        uint256 count;
        if (b0 & 3 == 0) {
            count = b0 >> 2;
            at += 1;
        } else if (b0 & 3 == 1) {
            // A two-byte compact holds 64 or more; less is not canonical.
            count = (b0 | (uint256(uint8(value[at + 1])) << 8)) >> 2;
            if (count < 64) revert NftItemMalformed(length);
            at += 2;
        } else {
            revert NftItemMalformed(length);
        }
        // Each approval is an account and an Option<u32>: tag 0 (None) or tag 1 and 4 bytes.
        bool malformed = false;
        for (uint256 i = 0; i < count && !malformed; i++) {
            at += 32;
            uint8 option = at < length ? uint8(value[at]) : 2;
            if (option == 0) {
                at += 1;
            } else if (option == 1 && at + 5 <= length) {
                at += 5;
            } else {
                malformed = true;
            }
        }
        if (malformed || at > length || length - at != NFT_DEPOSIT_SIZE) revert NftItemMalformed(length);
        assembly ("memory-safe") {
            owner := mload(add(value, 0x20))
        }
    }

    /// The trie id and code hash of a Revive.AccountInfoOf value: a Contract entry of exactly 130
    /// bytes with a 32-byte trie id, else NotAContract(length, variant).
    function decodeContractInfo(bytes memory value) internal pure returns (bytes32 trieId, bytes32 codeHash) {
        if (value.length != CONTRACT_INFO_SIZE || value[0] != 0x00 || value[1] != 0x80) {
            revert NotAContract(value.length, value.length == 0 ? 0 : uint8(value[0]));
        }
        assembly ("memory-safe") {
            trieId := mload(add(add(value, 0x20), TRIE_ID_AT))
            codeHash := mload(add(add(value, 0x20), CODE_HASH_AT))
        }
    }

    /// A contract slot's value: the 32-byte word the contract stored, else SlotLength.
    function decodeSlot(bytes memory value) internal pure returns (bytes32 word) {
        if (value.length != 32) revert SlotLength(value.length);
        // 32 bytes, checked above.
        // forge-lint: disable-next-line(unsafe-typecast)
        word = bytes32(value);
    }

    // ------------------------------------------------------------------ internals

    /// The trie id and code hash of the contract at `account`, under `root`.
    function _contractInfo(bytes32 root, address account, bytes[] calldata accountProof)
        private
        view
        returns (bytes32 trieId, bytes32 codeHash)
    {
        return decodeContractInfo(StorageProofs.verifyMain(root, accountProof, reviveAccountInfoKey(account)));
    }

    /// SubstrateProofs.verifyChild through the linked StorageProofs, as BridgeMinter._verifyChild
    /// makes it: the root of child trie `trieId` under `root` (32 bytes, not zero), then the slot's
    /// word under that root.
    function _childSlot(
        bytes32 root,
        bytes32 trieId,
        bytes32 slot,
        bytes[] calldata childRootProof,
        bytes[] calldata slotProof
    ) private view returns (bytes32 word) {
        bytes memory raw =
            StorageProofs.verifyMain(root, childRootProof, SubstrateProofs.childRootKey(abi.encodePacked(trieId)));
        if (raw.length != 32) revert SubstrateProofs.ChildRootLength(raw.length);
        // 32 bytes, checked above.
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes32 childRoot = bytes32(raw);
        if (childRoot == bytes32(0)) revert SubstrateProofs.ZeroChildRoot();
        word = decodeSlot(StorageProofs.verifyMain(childRoot, slotProof, abi.encodePacked(reviveSlotKey(slot))));
    }

    /// A little-endian u32 of `data` at `at`.
    function _u32(bytes memory data, uint256 at) private pure returns (uint32) {
        // Four bytes.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint32(_le(data, at, 4));
    }

    /// A little-endian u128 of `data` at `at`.
    function _u128(bytes memory data, uint256 at) private pure returns (uint128) {
        // Sixteen bytes.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint128(_le(data, at, 16));
    }

    /// `size` little-endian bytes of `data` from `at`.
    function _le(bytes memory data, uint256 at, uint256 size) private pure returns (uint256 v) {
        for (uint256 i = size; i > 0; i--) {
            v = (v << 8) | uint8(data[at + i - 1]);
        }
    }
}
