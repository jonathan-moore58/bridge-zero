// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {IGrandpaImporter} from "./IGrandpaImporter.sol";
import {IWrappedTPOT} from "./WrappedTPOT.sol";
import {StorageProofs} from "../trie/StorageProofs.sol";
import {SubstrateProofs} from "../trie/SubstrateProofs.sol";

/// @title BridgeMinter
/// @notice Mints wtPOT on Sepolia for tPOT locked in PortaldotVault on the Portaldot V3 testnet. A
/// lock is proven, not reported: the caller brings a V3 header with its GRANDPA finality proof and
/// storage proofs against that header's state root, and the minter recomputes the lock's commitment
/// with its own chain id and address before it mints. Holds no funds; no owner, no admin, no
/// upgrade path.
///
/// What a mint trusts:
///   - the light client: a state root counts as V3's when the GRANDPA authority set the client
///     follows finalized it, or when the client's admin installed it as a checkpoint (initialize,
///     and reinitialize while the client is paused or halted, are TRUSTED in GrandpaLightClient);
///     a set or an admin that accepts a wrong state root can mint;
///   - V3's own rules, its sudo key included, which decide what the vault's storage holds;
///   - the vault's code: bindVault takes the trie id only from a Revive.AccountInfoOf(vault) entry
///     that names vaultCodeHash, the vault code this minter was deployed for, which has no way to
///     destroy the vault or replace its code.
/// Not the caller, so no relayer and no committee: the recipient and the amount come from the
/// proven commitment and nothing from msg.sender. Anyone can submit a mint, and a copied
/// transaction mints to the same recipient.
///
/// The proofs, all under the state root of one imported block (relayer/src/revive.ts has the
/// layout):
///   - Revive.AccountInfoOf(vault) in the main trie: the vault's trie id and code hash. Read once,
///     by bindVault, which stores the trie id;
///   - the root of the vault's child trie, in the main trie under ":child_storage:default:" ++
///     trie id;
///   - commitments[nonce] in that child trie, under blake2_256 of its slot index: the word the
///     vault stored for the lock.
/// The proof is checked before the replay guard: a tampered proof reverts with a proof error, and
/// a valid one sent again with NonceAlreadyUsed.
///
/// TRUSTED, the return path: burn destroys wtPOT and emits BurnRequested; the committee's
/// multisig on V3 checks the burn and has the vault release tPOT. This contract neither triggers
/// nor verifies the release.
///
/// Deployed linked to the StorageProofs library, which holds the trie walk. The child-trie read is
/// SubstrateProofs.verifyChild done as two main-trie reads through that library, with the same
/// checks and errors: inlined, verifyChild would bring the walk into this contract's code, and
/// the deployment would no longer fit the per-transaction gas cap.
contract BridgeMinter {
    // ------------------------------------------------------------------ types

    /// One lock as the minter proves it: the block whose state root the proofs are against, the
    /// three proofs, and the lock's fields, which the proven commitment has to match.
    struct LockProof {
        bytes32 blockHash;
        bytes[] accountProof; // Revive.AccountInfoOf(vault); read only while the vault is not bound
        bytes[] childRootProof; // the root of the vault's child trie, in the main trie
        bytes[] slotProof; // commitments[nonce], in the child trie
        address recipient;
        uint256 amount; // native base units of tPOT, which are wtPOT units
        uint256 nonce;
    }

    // ------------------------------------------------------------------ constants

    /// Domain tag of a lock commitment (PortaldotVault.lock).
    bytes32 public constant LOCK_TAG = keccak256("BridgeZero.Lock.v1");
    /// Domain tag of a burn id, as the committee derives it (PortaldotVault.release).
    bytes32 public constant BURN_TAG = keccak256("BridgeZero.Burn.v1");
    /// The slot of the vault's `commitments` mapping: entry `nonce` is the word at
    /// keccak256(abi.encode(nonce, 0)).
    uint256 public constant COMMITMENTS_SLOT = 0;

    /// twox128("Revive") ++ twox128("AccountInfoOf"), as SubstrateProofs.storagePrefix("Revive",
    /// "AccountInfoOf") builds it.
    bytes32 internal constant ACCOUNT_INFO_OF_PREFIX =
        0x735f040a5d490f1107ad9c56f5ca00d2ae37ff0591fdbbcd9c2406df7147a9dc;
    /// A pallet-revive AccountInfo of the Contract variant with a 32-byte trie id: the variant (0),
    /// the trie id as a Vec<u8> (compact length 0x80, then 32 bytes), the code hash (32 bytes),
    /// storage_bytes and storage_items (u32), three u128 deposits, immutable_data_len (u32) and
    /// dust (u32).
    uint256 internal constant ACCOUNT_INFO_SIZE = 130;
    uint256 internal constant TRIE_ID_AT = 2;
    uint256 internal constant CODE_HASH_AT = 34;

    // ------------------------------------------------------------------ immutables

    /// The light client that finalizes V3 state roots (GrandpaLightClient).
    IGrandpaImporter public immutable lightClient;
    /// The vault's address on V3.
    address public immutable vault;
    /// V3's chain id, part of every commitment.
    uint256 public immutable vaultChainId;
    /// keccak-256 of the vault's runtime code, the code hash its AccountInfoOf entry has to name.
    bytes32 public immutable vaultCodeHash;
    /// wtPOT, which only this contract mints and burns.
    IWrappedTPOT public immutable token;

    // ------------------------------------------------------------------ state

    /// Slot 0: the vault's trie id, from its proven AccountInfoOf entry; zero until bindVault.
    bytes32 public vaultTrieId;
    /// Slot 1: the lock nonces minted.
    mapping(uint256 => bool) public used;
    /// Slot 2: the nonce of the next burn.
    uint256 public burnCount;

    // ------------------------------------------------------------------ events and errors

    event VaultBound(address indexed vault, bytes32 trieId, bytes32 indexed blockHash);
    event Minted(uint256 indexed nonce, address indexed recipient, uint256 amount, bytes32 indexed blockHash);
    /// TRUSTED return path: the committee releases `amount` native base units to `v3Recipient` on
    /// V3 against `burnId`, if it approves the burn. Nothing on this chain enforces that.
    event BurnRequested(
        uint256 indexed burnNonce, address indexed from, address indexed v3Recipient, uint256 amount, bytes32 burnId
    );

    /// A constructor argument is zero.
    error ZeroArgument();
    error VaultAlreadyBound();
    error VaultNotBound();
    /// The proven AccountInfoOf value is not a 130-byte Contract entry with a 32-byte trie id.
    error NotAContract(uint256 length, uint8 variant);
    /// The vault's entry names another code hash than vaultCodeHash.
    error VaultCodeMismatch(bytes32 found);
    /// The proofs are for another block than the one the finality proof imported.
    error BlockMismatch(bytes32 proven, bytes32 imported);
    error ZeroAmount();
    error ZeroRecipient();
    /// The proven commitments[nonce] value is not a 32-byte word.
    error CommitmentLength(uint256 length);
    /// The proven word is not the commitment of the lock as given.
    error CommitmentMismatch(bytes32 expected, bytes32 found);
    error NonceAlreadyUsed(uint256 nonce);

    constructor(
        IGrandpaImporter lightClient_,
        address vault_,
        uint256 vaultChainId_,
        bytes32 vaultCodeHash_,
        IWrappedTPOT token_
    ) {
        if (address(lightClient_) == address(0)) revert ZeroArgument();
        if (vault_ == address(0)) revert ZeroArgument();
        if (vaultChainId_ == 0) revert ZeroArgument();
        if (vaultCodeHash_ == bytes32(0)) revert ZeroArgument();
        if (address(token_) == address(0)) revert ZeroArgument();
        lightClient = lightClient_;
        vault = vault_;
        vaultChainId = vaultChainId_;
        vaultCodeHash = vaultCodeHash_;
        token = token_;
    }

    // ------------------------------------------------------------------ bind

    /// Binds this minter to the vault, once: proves Revive.AccountInfoOf(vault) at the imported
    /// block `blockHash`, requires a Contract entry whose code hash is vaultCodeHash, and stores
    /// its trie id. Open to anyone. Reverts with the light client's UnknownBlock if `blockHash` is
    /// not imported.
    function bindVault(bytes32 blockHash, bytes[] calldata accountProof) public {
        if (vaultTrieId != bytes32(0)) revert VaultAlreadyBound();
        bytes memory value = StorageProofs.verifyMain(_stateRoot(blockHash), accountProof, accountInfoKey());
        (bytes32 trieId, bytes32 codeHash) = _contractInfo(value);
        if (codeHash != vaultCodeHash) revert VaultCodeMismatch(codeHash);
        vaultTrieId = trieId;
        // The calls before this event are reads: the light client's stateRootOf and the walk in
        // StorageProofs.
        // forge-lint: disable-next-line(reentrancy-events)
        emit VaultBound(vault, trieId, blockHash);
    }

    // ------------------------------------------------------------------ mint

    /// Mints lock `p.nonce` to its recipient, once: proves the root of the vault's child trie at
    /// the imported block `p.blockHash`, then commitments[p.nonce] under it, which has to be the
    /// commitment of exactly this recipient, amount and nonce for this minter on this chain. Open
    /// to anyone; nothing is taken from msg.sender. Reverts with the light client's UnknownBlock
    /// if `p.blockHash` is not imported.
    function mint(LockProof calldata p) public {
        bytes32 trieId = vaultTrieId;
        if (trieId == bytes32(0)) revert VaultNotBound();
        if (p.amount == 0) revert ZeroAmount();
        bytes memory value = _verifyChild(
            _stateRoot(p.blockHash),
            p.childRootProof,
            p.slotProof,
            abi.encodePacked(trieId),
            abi.encodePacked(slotKeyOf(p.nonce))
        );
        if (value.length != 32) revert CommitmentLength(value.length);
        // 32 bytes, checked above.
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes32 found = bytes32(value);
        bytes32 expected = commitmentOf(p.recipient, p.amount, p.nonce);
        if (found != expected) revert CommitmentMismatch(expected, found);
        if (used[p.nonce]) revert NonceAlreadyUsed(p.nonce);
        used[p.nonce] = true;
        token.mint(p.recipient, p.amount);
        // The nonce is spent before the call, and the token (WrappedTPOT) calls nothing.
        // forge-lint: disable-next-line(reentrancy-events)
        emit Minted(p.nonce, p.recipient, p.amount, p.blockHash);
    }

    /// The whole mint in one transaction: imports `header` through the light client (or verifies
    /// it again if it is already imported), binds the vault from `p.accountProof` if it is not
    /// bound yet, then mint(p). The proofs have to be for the imported block.
    function importAndMint(
        bytes calldata header,
        bytes calldata finalityProof,
        bytes calldata signers,
        LockProof calldata p
    ) external {
        bytes32 blockHash = lightClient.importFinalityProof(header, finalityProof, signers);
        if (p.blockHash != blockHash) revert BlockMismatch(p.blockHash, blockHash);
        if (vaultTrieId == bytes32(0)) bindVault(blockHash, p.accountProof);
        mint(p);
    }

    // ------------------------------------------------------------------ burn (trusted return path)

    /// TRUSTED return path, its first step: destroys `amount` of msg.sender's wtPOT for tPOT to be
    /// released to `v3Recipient` on V3, and returns the burn's nonce. The release is the
    /// committee's: it checks the BurnRequested event and has the vault release against
    /// burnIdOf(burnNonce) = keccak256(abi.encode(BURN_TAG, block.chainid, address(this),
    /// burnNonce)). This contract cannot make the release happen, nor undo the burn.
    function burn(uint256 amount, address v3Recipient) external returns (uint256 burnNonce) {
        if (amount == 0) revert ZeroAmount();
        if (v3Recipient == address(0)) revert ZeroRecipient();
        burnNonce = burnCount++;
        token.burnFrom(msg.sender, amount);
        // The burn nonce is taken before the call, and the token (WrappedTPOT) calls nothing.
        // forge-lint: disable-next-line(reentrancy-events)
        emit BurnRequested(burnNonce, msg.sender, v3Recipient, amount, burnIdOf(burnNonce));
    }

    // ------------------------------------------------------------------ views

    /// True once bindVault has stored the vault's trie id.
    function bound() external view returns (bool) {
        return vaultTrieId != bytes32(0);
    }

    /// The commitment PortaldotVault stores for a lock of `amount` to `recipient` at `nonce` that
    /// names this minter on this chain.
    function commitmentOf(address recipient, uint256 amount, uint256 nonce) public view returns (bytes32) {
        return
            keccak256(abi.encode(LOCK_TAG, vaultChainId, vault, block.chainid, address(this), recipient, amount, nonce));
    }

    /// The child-trie key of commitments[nonce]: blake2_256 of its slot index,
    /// keccak256(abi.encode(nonce, COMMITMENTS_SLOT)).
    function slotKeyOf(uint256 nonce) public view returns (bytes32) {
        return SubstrateProofs.blake2_256(abi.encodePacked(keccak256(abi.encode(nonce, COMMITMENTS_SLOT))));
    }

    /// The burn id of burn `burnNonce`, as the committee derives it.
    function burnIdOf(uint256 burnNonce) public view returns (bytes32) {
        return keccak256(abi.encode(BURN_TAG, block.chainid, address(this), burnNonce));
    }

    /// The main-trie key of Revive.AccountInfoOf(vault): the prefix, then the 20-byte address
    /// (Identity hasher).
    function accountInfoKey() public view returns (bytes memory) {
        return bytes.concat(ACCOUNT_INFO_OF_PREFIX, bytes20(vault));
    }

    // ------------------------------------------------------------------ internals

    /// The state root of the imported block `blockHash`; the light client's UnknownBlock otherwise.
    function _stateRoot(bytes32 blockHash) private view returns (bytes32 stateRoot) {
        // The block number is not needed.
        // forge-lint: disable-next-line(unused-return)
        (stateRoot,) = lightClient.stateRootOf(blockHash);
    }

    /// The trie id and code hash of an AccountInfo value. Reverts NotAContract unless it is a
    /// Contract entry of exactly ACCOUNT_INFO_SIZE bytes with a 32-byte trie id.
    function _contractInfo(bytes memory value) private pure returns (bytes32 trieId, bytes32 codeHash) {
        // StorageProofs returns only non-empty values, so value[0] exists.
        if (value.length != ACCOUNT_INFO_SIZE || value[0] != 0x00 || value[1] != 0x80) {
            revert NotAContract(value.length, uint8(value[0]));
        }
        assembly ("memory-safe") {
            trieId := mload(add(add(value, 0x20), TRIE_ID_AT))
            codeHash := mload(add(add(value, 0x20), CODE_HASH_AT))
        }
    }

    /// SubstrateProofs.verifyChild through the linked StorageProofs: the root of child trie
    /// `childInfo`, proven in the main trie and required to be 32 bytes and not zero
    /// (SubstrateProofs.childRootOf), then the value of `key` under that root.
    function _verifyChild(
        bytes32 stateRoot,
        bytes[] calldata mainProofNodes,
        bytes[] calldata childProofNodes,
        bytes memory childInfo,
        bytes memory key
    ) private view returns (bytes memory value) {
        bytes memory raw = StorageProofs.verifyMain(stateRoot, mainProofNodes, SubstrateProofs.childRootKey(childInfo));
        if (raw.length != 32) revert SubstrateProofs.ChildRootLength(raw.length);
        // 32 bytes, checked above.
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes32 childRoot = bytes32(raw);
        if (childRoot == bytes32(0)) revert SubstrateProofs.ZeroChildRoot();
        value = StorageProofs.verifyMain(childRoot, childProofNodes, key);
    }
}
