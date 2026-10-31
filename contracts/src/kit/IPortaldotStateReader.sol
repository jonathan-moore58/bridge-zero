// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.27;

import {IFinalizedStateRoots} from "./IFinalizedStateRoots.sol";

/// @title IPortaldotStateReader
/// @notice What a contract calls to read proven Portaldot V3 state through PortaldotStateReader,
/// deployed once on Sepolia: a consumer compiles only this file and the IFinalizedStateRoots.sol it
/// imports, with no trie code. Every read takes the hash of a V3 block that the Reader's light client
/// imported, never a state root, and returns that block's number with the value.
///
/// The errors a read can revert with are declared here so that a consumer can name them:
///   - the light client's UnknownBlock, for a block it did not import;
///   - the walk's (SubstrateProofs, through the linked StorageProofs): EmptyProof, EmptyKey,
///     KeyNotPresent (a complete walk that shows the key absent: a proof that it holds nothing),
///     EmptyValue (the key holds an empty value, or ends on a branch without a value: the walk
///     reports both alike), ChildRootLength and ZeroChildRoot, and the walk's own Error strings
///     ("Incomplete Proof!", "Bad Format!", "Unallowed encoding") for a proof that does not lead
///     from the root to the key;
///   - the decoders' (PortaldotState): AccountInfoLength, AssetAccountMalformed, NftItemMalformed,
///     NotAContract and SlotLength, for a value of another layout than V3's.
interface IPortaldotStateReader {
    /// frame_system AccountInfo with pallet_balances AccountData, as V3 (portaldot-v3 3002) stores
    /// it: four u32, then four u128, 80 bytes, little-endian.
    struct AccountInfo {
        uint32 nonce;
        uint32 consumers;
        uint32 providers;
        uint32 sufficients;
        uint128 free;
        uint128 reserved;
        uint128 frozen;
        uint128 flags;
    }

    /// The three proofs of a contract's slot, all under the state root of one block:
    /// Revive.AccountInfoOf(contract) in the main trie (its trie id and code hash), the root of its
    /// child trie in the main trie, and the slot in the child trie.
    struct ContractSlotProof {
        bytes[] account;
        bytes[] childRoot;
        bytes[] slot;
    }

    /// The light client address is zero.
    error ZeroLightClient();
    /// A System.Account value that is not an 80-byte AccountInfo.
    error AccountInfoLength(uint256 length);
    /// An Assets.Account value whose length is not its reason's, or whose status is not Liquid,
    /// Frozen or Blocked.
    error AssetAccountMalformed(uint256 length, uint8 status, uint8 reason);
    /// An Nfts.Item value that does not parse as ItemDetails.
    error NftItemMalformed(uint256 length);
    /// A Revive.AccountInfoOf value that is not a 130-byte Contract entry with a 32-byte trie id.
    error NotAContract(uint256 length, uint8 variant);
    /// A contract slot's value that is not a 32-byte word.
    error SlotLength(uint256 length);
    /// No proof items were given.
    error EmptyProof();
    /// The key to read is empty.
    error EmptyKey();
    /// The proof shows that `key` is not in the trie under `root`.
    error KeyNotPresent(bytes32 root, bytes key);
    /// `key` holds an empty value, or ends on a branch without one (the walk does not tell them
    /// apart).
    error EmptyValue(bytes32 root, bytes key);
    /// The value at a child-trie root key is not 32 bytes.
    error ChildRootLength(uint256 length);
    /// The child-trie root read from the main trie is zero.
    error ZeroChildRoot();
    /// The light client did not import `blockHash` as finalized.
    error UnknownBlock(bytes32 blockHash);

    /// The light client the Reader takes state roots from (GrandpaLightClient #2 on Sepolia).
    function lightClient() external view returns (IFinalizedStateRoots);

    /// The state root and number of the imported block `blockHash`.
    function stateRootOf(bytes32 blockHash) external view returns (bytes32 stateRoot, uint32 number);

    /// The non-empty value of any main-trie `key` at the imported block `blockHash`.
    function readMain(bytes32 blockHash, bytes calldata key, bytes[] calldata proof)
        external
        view
        returns (bytes memory value, uint32 number);

    /// System.Account(accountId): its nonce and balances. An EVM account's id is its address
    /// followed by 12 bytes of 0xEE.
    function accountInfo(bytes32 blockHash, bytes32 accountId, bytes[] calldata proof)
        external
        view
        returns (AccountInfo memory info, uint32 number);

    /// Assets.Account(assetId, accountId): the balance and the status (0 Liquid, 1 Frozen,
    /// 2 Blocked).
    function assetAccount(bytes32 blockHash, uint32 assetId, bytes32 accountId, bytes[] calldata proof)
        external
        view
        returns (uint128 balance, uint8 status, uint32 number);

    /// The owner of Nfts.Item(collection, item).
    function nftOwner(bytes32 blockHash, uint32 collection, uint32 item, bytes[] calldata proof)
        external
        view
        returns (bytes32 owner, uint32 number);

    /// The trie id and code hash of the contract at `account` (Revive.AccountInfoOf).
    function contractInfo(bytes32 blockHash, address account, bytes[] calldata accountProof)
        external
        view
        returns (bytes32 trieId, bytes32 codeHash, uint32 number);

    /// Slot `slot` of the contract at `account`, with the contract's code hash: its trie id is
    /// proven from its address. An empty slot is not stored and reverts KeyNotPresent; so does an
    /// address with no Revive entry, or a contract that has stored nothing, and then no code hash
    /// comes back: a consumer that treats KeyNotPresent as zero pins the code with contractInfo and
    /// reads with childSlot.
    function contractSlot(bytes32 blockHash, address account, bytes32 slot, ContractSlotProof calldata p)
        external
        view
        returns (bytes32 word, bytes32 codeHash, uint32 number);

    /// Slot `slot` of the child trie `trieId`, a trie id the caller has already bound to a contract
    /// (from a contractInfo whose code hash it pinned): a trie id with no child trie reverts
    /// KeyNotPresent too.
    function childSlot(
        bytes32 blockHash,
        bytes32 trieId,
        bytes32 slot,
        bytes[] calldata childRootProof,
        bytes[] calldata slotProof
    ) external view returns (bytes32 word, uint32 number);
}
