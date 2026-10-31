// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.27;

import {IPortaldotStateReader} from "../IPortaldotStateReader.sol";

/// @title ProvenAssetGate
/// @notice Example consumer of PortaldotStateReader: an allowlist of the EVM addresses whose V3
/// account held at least `minimum` of asset `assetId` at the V3 block `snapshotBlock`. Another
/// contract gates on `claimed(msg.sender)`. Holds no funds, has no owner and no admin.
///
/// - The block is fixed at deployment, and the constructor requires that the light client imported
///   it (the Reader reverts UnknownBlock otherwise). A snapshot states a past fact, so its age is
///   not checked; a gate that wants a recent balance reads at the light client's latest block
///   instead (docs/PROOF-KIT.md, "Blocks and freshness").
/// - One claim per holder. The proof is checked before the replay guard, as BridgeMinter checks a
///   lock's: a tampered proof reverts with a proof error, and a valid one sent again with
///   AlreadyClaimed.
/// - Anyone can send a claim, and the record names only the holder the proof names: nothing goes
///   to msg.sender. A record is a proven fact about the holder, not the holder's consent. Holders
///   are Ethereum-key accounts, whose V3 id is the address ++ 0xEE x 12; a Substrate (5...)
///   account cannot claim, and the address of a contract on V3 gets a record that only whoever
///   controls that address on Sepolia can use (pallet-revive derives contract addresses as
///   Ethereum does).
/// - What counts is the account's balance, whatever its status, Blocked included: a frozen balance
///   is still held, and the status is in the Claimed event. The asset's own status (an asset frozen
///   as a whole) is not read.
///
/// What a claim trusts: the light client (V3's validator set and the admin's checkpoint), V3's
/// rules (its sudo key, runtime upgrades, and the asset's owner and admin, who can mint, burn and
/// freeze it), the Reader's code, and pallet-revive's mapping of EVM accounts.
contract ProvenAssetGate {
    /// The last 12 bytes of an EVM account's id on V3 (PortaldotState.ETH_ACCOUNT_SUFFIX).
    bytes12 internal constant ETH_ACCOUNT_SUFFIX = 0xeeeeeeeeeeeeeeeeeeeeeeee;

    IPortaldotStateReader public immutable reader;
    /// The V3 block the balances are read at, and its number.
    bytes32 public immutable snapshotBlock;
    uint32 public immutable snapshotNumber;
    /// The pallet-assets asset, and the balance a holder needs, in its base units.
    uint32 public immutable assetId;
    uint128 public immutable minimum;

    /// The holders that claimed.
    mapping(address => bool) public claimed;

    event Claimed(address indexed holder, uint128 balance, uint8 status, bytes32 indexed blockHash, uint32 number);

    /// The reader, the snapshot block or the minimum is zero.
    error ZeroArgument();
    /// The holder's proven balance is below the minimum.
    error BelowMinimum(uint128 balance, uint128 minimum);
    /// The holder has claimed already.
    error AlreadyClaimed(address holder);

    constructor(IPortaldotStateReader reader_, bytes32 snapshotBlock_, uint32 assetId_, uint128 minimum_) {
        if (address(reader_) == address(0) || snapshotBlock_ == bytes32(0) || minimum_ == 0) revert ZeroArgument();
        // The light client's UnknownBlock unless it imported the block; the state root is not needed.
        // forge-lint: disable-next-line(unused-return)
        (, uint32 number) = reader_.stateRootOf(snapshotBlock_);
        reader = reader_;
        snapshotBlock = snapshotBlock_;
        snapshotNumber = number;
        assetId = assetId_;
        minimum = minimum_;
    }

    /// Records `holder` once its Assets.Account(assetId, holder ++ 0xEE x 12) at the snapshot
    /// block, proven by `proof`, holds at least the minimum. Open to anyone.
    function claim(address holder, bytes[] calldata proof) external {
        // 20 + 12 bytes.
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes32 accountId = bytes32(bytes.concat(bytes20(holder), ETH_ACCOUNT_SUFFIX));
        // The block number is snapshotNumber.
        // forge-lint: disable-next-line(unused-return)
        (uint128 balance, uint8 status,) = reader.assetAccount(snapshotBlock, assetId, accountId, proof);
        if (balance < minimum) revert BelowMinimum(balance, minimum);
        if (claimed[holder]) revert AlreadyClaimed(holder);
        claimed[holder] = true;
        // The call before this event is a read: the Reader is a view.
        // forge-lint: disable-next-line(reentrancy-events)
        emit Claimed(holder, balance, status, snapshotBlock, snapshotNumber);
    }
}
