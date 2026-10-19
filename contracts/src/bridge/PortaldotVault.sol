// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

/// @title PortaldotVault
/// @notice Holds native tPOT locked on the Portaldot V3 testnet for a token minted on another
/// chain, and pays it out again on the trusted return path. Runs as EVM bytecode on pallet-revive.
///
/// Lock, open to anyone: each lock stores one commitment, which binds this chain, this vault, the
/// destination chain and minter, the recipient, the amount and the nonce. The minter there proves
/// the commitment from a V3 state root its light client finalized, recomputes it with its own
/// chain id and address, and mints at most once per nonce. This direction trusts no relayer and
/// no committee; it trusts the V3 validator set the light client follows.
///
/// TRUSTED, release: only RELEASER can pay out, never more than is still locked. RELEASER is the
/// 2-of-3 pallet-multisig account of the return-path committee, which checks the burn on the other
/// chain before it approves; the vault does not.
///
/// No owner, no admin, no upgrade path, no other state-changing function. A plain value transfer
/// reverts. Amounts are native base units (14 decimals on V3); msg.value and payouts are in EVM
/// units, NATIVE_TO_ETH_RATIO per native base unit.
///
/// Every byte of code costs a storage deposit on V3 (about 0.078 tPOT), so the V3 build (foundry
/// profile v3) compiles this file with the IR pipeline and no CBOR metadata, and only
/// commitments, outstanding and released have getters. nextNonce is the word at slot 1
/// (eth_getStorageAt). NATIVE_TO_ETH_RATIO and RELEASER sit in the deployed code, which
/// relayer/src/v3-vault.ts compares with the artifact and the deployment record.
contract PortaldotVault {
    // ------------------------------------------------------------------ state

    // The storage layout is part of the protocol: a minter proves commitments[nonce], the word at
    // keccak256(abi.encode(nonce, 0)). Slots 0 to 3, in this order.

    /// Slot 0: the commitment of each lock, by nonce.
    mapping(uint256 => bytes32) public commitments;
    /// Slot 1: the nonce of the next lock.
    uint256 internal nextNonce;
    /// Slot 2: native base units locked and not yet released.
    uint256 public outstanding;
    /// Slot 3: the burn ids already released.
    mapping(bytes32 => bool) public released;

    /// Domain tag of a lock commitment.
    bytes32 internal constant LOCK_TAG = keccak256("BridgeZero.Lock.v1");

    /// EVM units per native base unit: pallet-revive's NativeToEthRatio, read live at deployment.
    uint256 internal immutable NATIVE_TO_ETH_RATIO;
    /// The only caller of release: the committee's multisig account, as pallet-revive maps it to
    /// an address.
    address internal immutable RELEASER;

    // ------------------------------------------------------------------ events and errors

    event Locked(
        uint256 indexed nonce,
        address indexed sender,
        address indexed recipient,
        uint256 dstChainId,
        address dstMinter,
        uint256 amountNative,
        bytes32 commitment
    );
    event Released(bytes32 indexed burnId, address indexed to, uint256 amountNative);

    /// A chain id, address or amount that has to be set is zero.
    error ZeroArgument();
    /// msg.value is not a whole number of native base units.
    error DustNotAllowed();
    /// msg.value is less than one native base unit.
    error AmountTooSmall();
    error NotReleaser();
    error AlreadyReleased();
    /// The release asks for more than is still locked.
    error ExceedsOutstanding();
    /// The payout to the recipient failed.
    error TransferFailed();

    constructor(uint256 nativeToEthRatio, address releaser) {
        if (nativeToEthRatio == 0 || releaser == address(0)) revert ZeroArgument();
        NATIVE_TO_ETH_RATIO = nativeToEthRatio;
        RELEASER = releaser;
    }

    // ------------------------------------------------------------------ lock

    /// Locks msg.value for `recipient` on chain `dstChainId`, where `dstMinter` mints it, and
    /// returns the lock's nonce. Stores the commitment
    /// keccak256(abi.encode(LOCK_TAG, block.chainid, address(this), dstChainId, dstMinter, recipient, amountNative, nonce)).
    function lock(uint256 dstChainId, address dstMinter, address recipient) external payable returns (uint256 nonce) {
        if (dstChainId == 0) revert ZeroArgument();
        if (dstMinter == address(0)) revert ZeroArgument();
        if (recipient == address(0)) revert ZeroArgument();
        uint256 ratio = NATIVE_TO_ETH_RATIO;
        if (msg.value % ratio != 0) revert DustNotAllowed();
        uint256 amountNative = msg.value / ratio;
        if (amountNative == 0) revert AmountTooSmall();

        nonce = nextNonce;
        // The eight words of the abi.encode above, hashed in free memory (the free memory pointer
        // stays where it is). The addresses are widened in Solidity, so their upper bits are zero.
        bytes32 tag = LOCK_TAG;
        uint256 minterWord = uint160(dstMinter);
        uint256 recipientWord = uint160(recipient);
        bytes32 commitment;
        assembly ("memory-safe") {
            let m := mload(0x40)
            mstore(m, tag)
            mstore(add(m, 0x20), chainid())
            mstore(add(m, 0x40), address())
            mstore(add(m, 0x60), dstChainId)
            mstore(add(m, 0x80), minterWord)
            mstore(add(m, 0xa0), recipientWord)
            mstore(add(m, 0xc0), amountNative)
            mstore(add(m, 0xe0), nonce)
            commitment := keccak256(m, 0x100)
        }
        commitments[nonce] = commitment;
        // Neither overflows: there are fewer than 2^256 locks, and outstanding is at most the
        // vault's balance in native base units.
        unchecked {
            nextNonce = nonce + 1;
            outstanding += amountNative;
        }
        // No call precedes this event; the lint takes the assembly block above for one.
        // forge-lint: disable-next-line(reentrancy-events)
        emit Locked(nonce, msg.sender, recipient, dstChainId, dstMinter, amountNative, commitment);
    }

    // ------------------------------------------------------------------ release (trusted)

    /// Pays `amountNative` to `to` for burn `burnId`, once per burn id. Only RELEASER. The
    /// committee derives the burn id from the burn it approves,
    /// keccak256(abi.encode(keccak256("BridgeZero.Burn.v1"), srcChainId, srcMinter, burnNonce));
    /// the vault does not check it.
    function release(bytes32 burnId, address payable to, uint256 amountNative) external {
        if (msg.sender != RELEASER) revert NotReleaser();
        if (released[burnId]) revert AlreadyReleased();
        if (to == address(0)) revert ZeroArgument();
        if (amountNative == 0) revert ZeroArgument();
        uint256 left = outstanding;
        if (amountNative > left) revert ExceedsOutstanding();

        released[burnId] = true;
        uint256 value;
        // amountNative is at most outstanding, and every lock added msg.value / ratio with no
        // remainder, so amountNative * ratio is at most the value locked: neither overflows.
        unchecked {
            outstanding = left - amountNative;
            value = amountNative * NATIVE_TO_ETH_RATIO;
        }
        // A plain value transfer; the recipient's return data is not copied.
        bool ok;
        assembly ("memory-safe") {
            ok := call(gas(), to, value, 0, 0, 0, 0)
        }
        if (!ok) revert TransferFailed();
        // The state is final before the payout, so a payee that calls the vault again finds it as
        // this release leaves it; only the payee's own logs can come before this one.
        // forge-lint: disable-next-line(reentrancy-events)
        emit Released(burnId, to, amountNative);
    }
}
