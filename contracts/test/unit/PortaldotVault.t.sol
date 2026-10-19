// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {Test, Vm} from "forge-std/Test.sol";
import {PortaldotVault} from "../../src/bridge/PortaldotVault.sol";

// ------------------------------------------------------------------ helpers

/// What a minter on the destination chain checks before it mints: the commitment recomputed from
/// a Locked event's recipient, amount and nonce, the V3 chain id and the vault's address, with its
/// own chain id and address. It mints only if the proven slot holds exactly this word.
contract MinterView {
    function expected(uint256 v3ChainId, address vault, address recipient, uint256 amountNative, uint256 nonce)
        external
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                keccak256("BridgeZero.Lock.v1"),
                v3ChainId,
                vault,
                block.chainid,
                address(this),
                recipient,
                amountNative,
                nonce
            )
        );
    }
}

/// A payout recipient that refuses value.
contract RefusingRecipient {
    receive() external payable {
        revert("refused");
    }
}

/// A payout recipient that calls the vault again while it is paid: release (it is not the
/// releaser), the same and pass the revert on, or lock what it was paid.
contract ReenteringRecipient {
    enum Mode {
        Release,
        ReleaseAndRevert,
        Lock
    }

    PortaldotVault internal immutable vault;
    Mode public mode;
    bytes public releaseRevert;
    uint256 public relockNonce;
    uint256 public relockValue;

    constructor(PortaldotVault vault_) {
        vault = vault_;
    }

    function setMode(Mode mode_) external {
        mode = mode_;
    }

    receive() external payable {
        if (mode == Mode.Lock) {
            relockValue = msg.value;
            relockNonce = vault.lock{value: msg.value}(11_155_111, address(0xB0B), address(this));
            return;
        }
        try vault.release(keccak256("re-entered"), payable(address(this)), 1) {}
        catch (bytes memory reason) {
            releaseRevert = reason;
            if (mode == Mode.ReleaseAndRevert) {
                assembly ("memory-safe") {
                    revert(add(reason, 0x20), mload(reason))
                }
            }
        }
    }
}

/// A releaser that is a contract: it pays itself, and while it is paid asks for the same burn again.
contract ReenteringReleaser {
    PortaldotVault public vault;
    bytes32 internal burnId;
    bytes public reentryRevert;

    function setVault(PortaldotVault vault_) external {
        vault = vault_;
    }

    function release(bytes32 burnId_, uint256 amountNative) external {
        burnId = burnId_;
        vault.release(burnId_, payable(address(this)), amountNative);
    }

    receive() external payable {
        try vault.release(burnId, payable(address(this)), 1) {}
        catch (bytes memory reason) {
            reentryRevert = reason;
        }
    }
}

/// Deploys the vault from its creation code with CREATE, so that the same tests run on the source
/// and on the V3 build, and a constructor revert can be inspected.
abstract contract VaultDeployer is Test {
    uint256 internal constant V3_CHAIN_ID = 420_420_777;
    uint256 internal constant SEPOLIA_CHAIN_ID = 11_155_111;
    /// pallet-revive's NativeToEthRatio on V3: native tPOT has 14 decimals, EVM values 18.
    uint256 internal constant RATIO = 10_000;
    /// One tPOT in native base units.
    uint256 internal constant TPOT = 1e14;

    /// The vault's creation code, without constructor arguments.
    function _initcode() internal view virtual returns (bytes memory);

    function _deploy(uint256 ratio, address releaser_) internal returns (PortaldotVault) {
        (address deployed, bytes memory reason) = _create(abi.encodePacked(_initcode(), abi.encode(ratio, releaser_)));
        assertEq(reason.length, 0, "the constructor reverted");
        return PortaldotVault(deployed);
    }

    /// CREATE with `initcode`: the new address, or zero and the revert data.
    function _create(bytes memory initcode) internal returns (address deployed, bytes memory reason) {
        assembly ("memory-safe") {
            deployed := create(0, add(initcode, 0x20), mload(initcode))
            if iszero(deployed) {
                reason := mload(0x40)
                mstore(reason, returndatasize())
                returndatacopy(add(reason, 0x20), 0, returndatasize())
                mstore(0x40, add(reason, and(add(returndatasize(), 0x3f), not(0x1f))))
            }
        }
    }
}

// ------------------------------------------------------------------ the suite

/// The vault's lock and release rules, its storage layout and its accounting. Every test runs on the
/// vault as the default profile compiles it (PortaldotVaultSourceTest) and on the V3 build that
/// relayer/src/v3-vault.ts deploys (PortaldotVaultV3BuildTest), with the V3 chain id and ratio.
abstract contract PortaldotVaultBase is VaultDeployer {
    bytes32 internal constant LOCK_TAG = keccak256("BridgeZero.Lock.v1");
    bytes32 internal constant BURN_TAG = keccak256("BridgeZero.Burn.v1");
    bytes32 internal constant LOCKED_TOPIC =
        keccak256("Locked(uint256,address,address,uint256,address,uint256,bytes32)");
    bytes32 internal constant RELEASED_TOPIC = keccak256("Released(bytes32,address,uint256)");

    // The storage layout, part of the protocol.
    uint256 internal constant COMMITMENTS_SLOT = 0;
    uint256 internal constant NEXT_NONCE_SLOT = 1;
    uint256 internal constant OUTSTANDING_SLOT = 2;
    uint256 internal constant RELEASED_SLOT = 3;

    PortaldotVault internal vault;
    address internal releaser;
    address internal alice;
    address internal bob;
    address internal minter;
    address internal recipient;

    function setUp() public virtual {
        vm.chainId(V3_CHAIN_ID);
        releaser = makeAddr("releaser");
        alice = makeAddr("alice");
        bob = makeAddr("bob");
        minter = makeAddr("minter");
        recipient = makeAddr("recipient");
        vault = _deploy(RATIO, releaser);
        vm.deal(alice, 1e9 ether);
        vm.deal(bob, 1e9 ether);
    }

    function _lock(address from, uint256 dstChainId, address dstMinter, address to, uint256 amountNative)
        internal
        returns (uint256 nonce)
    {
        vm.prank(from);
        nonce = vault.lock{value: amountNative * RATIO}(dstChainId, dstMinter, to);
    }

    function _release(bytes32 burnId, address to, uint256 amountNative) internal {
        vm.prank(releaser);
        vault.release(burnId, payable(to), amountNative);
    }

    /// The commitment as the spec writes it.
    function _commitment(uint256 dstChainId, address dstMinter, address to, uint256 amountNative, uint256 nonce)
        internal
        view
        returns (bytes32)
    {
        return
            keccak256(
                abi.encode(LOCK_TAG, block.chainid, address(vault), dstChainId, dstMinter, to, amountNative, nonce)
            );
    }

    /// The burn id the committee derives from a burn.
    function _burnId(uint256 srcChainId, address srcMinter, uint256 burnNonce) internal pure returns (bytes32) {
        return keccak256(abi.encode(BURN_TAG, srcChainId, srcMinter, burnNonce));
    }

    function _word(bytes32 slot) internal view returns (uint256) {
        return uint256(vm.load(address(vault), slot));
    }

    /// nextNonce has no getter: it is the word at slot 1.
    function _nextNonce() internal view returns (uint256) {
        return _word(bytes32(NEXT_NONCE_SLOT));
    }

    function _commitmentSlot(uint256 nonce) internal pure returns (bytes32) {
        return keccak256(abi.encode(nonce, COMMITMENTS_SLOT));
    }

    function _releasedSlot(bytes32 burnId) internal pure returns (bytes32) {
        return keccak256(abi.encode(burnId, RELEASED_SLOT));
    }

    function _assertUntouched() internal view {
        assertEq(_nextNonce(), 0, "nextNonce");
        assertEq(vault.outstanding(), 0, "outstanding");
        assertEq(vault.commitments(0), bytes32(0), "commitments[0]");
        assertEq(address(vault).balance, 0, "balance");
    }

    // ------------------------------------------------------------------ constructor

    function test_constructor_rejectsZeroRatio() public {
        (address deployed, bytes memory reason) =
            _create(abi.encodePacked(_initcode(), abi.encode(uint256(0), releaser)));
        assertEq(deployed, address(0));
        assertEq(reason, abi.encodeWithSelector(PortaldotVault.ZeroArgument.selector));
    }

    function test_constructor_rejectsZeroReleaser() public {
        (address deployed, bytes memory reason) = _create(abi.encodePacked(_initcode(), abi.encode(RATIO, address(0))));
        assertEq(deployed, address(0));
        assertEq(reason, abi.encodeWithSelector(PortaldotVault.ZeroArgument.selector));
    }

    function test_constructor_startsEmpty() public view {
        for (uint256 slot = 0; slot < 4; slot++) {
            assertEq(vm.load(address(vault), bytes32(slot)), bytes32(0));
        }
        _assertUntouched();
        assertFalse(vault.released(bytes32(0)));
    }

    function test_constructor_takesAnyRatio() public {
        PortaldotVault one = _deploy(1, releaser);
        vm.prank(alice);
        assertEq(one.lock{value: 1}(SEPOLIA_CHAIN_ID, minter, recipient), 0);
        assertEq(one.outstanding(), 1);
    }

    // ------------------------------------------------------------------ lock

    function test_lock_first() public {
        uint256 amountNative = 15 * TPOT / 10;
        bytes32 commitment = _commitment(SEPOLIA_CHAIN_ID, minter, recipient, amountNative, 0);
        vm.expectEmit(address(vault));
        emit PortaldotVault.Locked(0, alice, recipient, SEPOLIA_CHAIN_ID, minter, amountNative, commitment);
        uint256 nonce = _lock(alice, SEPOLIA_CHAIN_ID, minter, recipient, amountNative);

        assertEq(nonce, 0);
        assertEq(vault.commitments(0), commitment);
        assertEq(_nextNonce(), 1);
        assertEq(vault.outstanding(), amountNative);
        assertEq(address(vault).balance, amountNative * RATIO);
        assertEq(alice.balance, 1e9 ether - amountNative * RATIO);
        assertTrue(commitment != bytes32(0));
    }

    function test_lock_nonceSequence() public {
        assertEq(_lock(alice, SEPOLIA_CHAIN_ID, minter, recipient, TPOT), 0);
        assertEq(_lock(bob, SEPOLIA_CHAIN_ID, minter, alice, 2 * TPOT), 1);
        assertEq(_lock(alice, 1, address(0xB0B), recipient, 1), 2);
        assertEq(_nextNonce(), 3);
        assertEq(vault.outstanding(), 3 * TPOT + 1);
        assertEq(vault.commitments(0), _commitment(SEPOLIA_CHAIN_ID, minter, recipient, TPOT, 0));
        assertEq(vault.commitments(1), _commitment(SEPOLIA_CHAIN_ID, minter, alice, 2 * TPOT, 1));
        assertEq(vault.commitments(2), _commitment(1, address(0xB0B), recipient, 1, 2));
        assertEq(vault.commitments(3), bytes32(0), "no lock 3 yet");
    }

    /// Two locks that differ in one field only get different commitments.
    function test_lock_commitmentBindsEveryField() public {
        _lock(alice, SEPOLIA_CHAIN_ID, minter, recipient, TPOT);
        _lock(alice, SEPOLIA_CHAIN_ID, minter, recipient, TPOT);
        assertTrue(vault.commitments(0) != vault.commitments(1), "nonce");
        bytes32 base = _commitment(SEPOLIA_CHAIN_ID, minter, recipient, TPOT, 0);
        assertTrue(base != _commitment(SEPOLIA_CHAIN_ID + 1, minter, recipient, TPOT, 0), "destination chain");
        assertTrue(base != _commitment(SEPOLIA_CHAIN_ID, bob, recipient, TPOT, 0), "minter");
        assertTrue(base != _commitment(SEPOLIA_CHAIN_ID, minter, bob, TPOT, 0), "recipient");
        assertTrue(base != _commitment(SEPOLIA_CHAIN_ID, minter, recipient, TPOT + 1, 0), "amount");
        PortaldotVault other = _deploy(RATIO, releaser);
        vm.prank(alice);
        other.lock{value: TPOT * RATIO}(SEPOLIA_CHAIN_ID, minter, recipient);
        assertTrue(other.commitments(0) != base, "vault");
        vm.chainId(1);
        assertTrue(_commitment(SEPOLIA_CHAIN_ID, minter, recipient, TPOT, 0) != base, "source chain");
    }

    /// A fixed lock against values computed independently with cast (cast keccak of cast
    /// abi-encode). relayer/src/vault.test.ts checks the same values. The vault sits at the address
    /// the deploy dry run of Oct 19 gave for the testnet account 5ERJ… at its nonce 1.
    function test_lock_goldenVector() public {
        address at = 0xa02EE16EB03d2cf1aeF199F7658FB8c8E3188ffd;
        vm.etch(at, abi.encodePacked(_initcode(), abi.encode(RATIO, releaser)));
        (bool ok, bytes memory runtime) = at.call("");
        assertTrue(ok, "constructor");
        vm.etch(at, runtime);
        vm.store(at, bytes32(NEXT_NONCE_SLOT), bytes32(uint256(7)));

        vm.prank(alice);
        uint256 nonce = PortaldotVault(at).lock{value: 150_000_000_000_000 * RATIO}(
            SEPOLIA_CHAIN_ID, 0x2222222222222222222222222222222222222222, 0xD9838A86cF83C28Ee486544060D1cA4Ca2971071
        );
        bytes32 commitment = 0xc1463a99819a56870997bbef04e4c914b0655a07c6bf660d2fb7017be9ba0220;
        assertEq(nonce, 7);
        assertEq(PortaldotVault(at).commitments(7), commitment);
        assertEq(vm.load(at, 0x870253054e3d98b71abec8fff9ebf8a15d167f15909091a800d4acaab9266d2b), commitment);

        bytes32 burnId = _burnId(SEPOLIA_CHAIN_ID, 0x2222222222222222222222222222222222222222, 3);
        assertEq(burnId, 0xf688c1d329d7adf3defb167190841944f5ad9c4d6427e4d066de0ce0a54d6595);
        vm.prank(releaser);
        PortaldotVault(at).release(burnId, payable(bob), 1);
        assertEq(vm.load(at, 0x55fe0247b9ac52165caf16904b6c4b4bef53e6f691f5c32a6257343ff9f02489), bytes32(uint256(1)));
    }

    /// The Locked log as a reader decodes it: the signature, three indexed words, four data words.
    function test_lock_eventLayout() public {
        vm.recordLogs();
        _lock(alice, SEPOLIA_CHAIN_ID, minter, recipient, 3 * TPOT);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].emitter, address(vault));
        assertEq(logs[0].topics.length, 4);
        assertEq(logs[0].topics[0], LOCKED_TOPIC);
        assertEq(logs[0].topics[1], bytes32(uint256(0)));
        assertEq(logs[0].topics[2], bytes32(uint256(uint160(alice))));
        assertEq(logs[0].topics[3], bytes32(uint256(uint160(recipient))));
        assertEq(
            logs[0].data,
            abi.encode(
                SEPOLIA_CHAIN_ID, minter, 3 * TPOT, _commitment(SEPOLIA_CHAIN_ID, minter, recipient, 3 * TPOT, 0)
            )
        );
    }

    function test_lock_smallestAmount() public {
        assertEq(_lock(alice, SEPOLIA_CHAIN_ID, minter, recipient, 1), 0);
        assertEq(vault.outstanding(), 1);
        assertEq(address(vault).balance, RATIO);
    }

    function test_lock_rejectsZeroDestinationChain() public {
        vm.prank(alice);
        vm.expectRevert(PortaldotVault.ZeroArgument.selector);
        vault.lock{value: TPOT * RATIO}(0, minter, recipient);
        _assertUntouched();
    }

    function test_lock_rejectsZeroMinter() public {
        vm.prank(alice);
        vm.expectRevert(PortaldotVault.ZeroArgument.selector);
        vault.lock{value: TPOT * RATIO}(SEPOLIA_CHAIN_ID, address(0), recipient);
        _assertUntouched();
    }

    function test_lock_rejectsZeroRecipient() public {
        vm.prank(alice);
        vm.expectRevert(PortaldotVault.ZeroArgument.selector);
        vault.lock{value: TPOT * RATIO}(SEPOLIA_CHAIN_ID, minter, address(0));
        _assertUntouched();
    }

    function test_lock_rejectsDust() public {
        uint256[4] memory values = [uint256(1), RATIO - 1, RATIO + 1, 5 * TPOT * RATIO - 1];
        for (uint256 i = 0; i < values.length; i++) {
            vm.prank(alice);
            vm.expectRevert(PortaldotVault.DustNotAllowed.selector);
            vault.lock{value: values[i]}(SEPOLIA_CHAIN_ID, minter, recipient);
        }
        _assertUntouched();
    }

    function test_lock_rejectsNothing() public {
        vm.prank(alice);
        vm.expectRevert(PortaldotVault.AmountTooSmall.selector);
        vault.lock(SEPOLIA_CHAIN_ID, minter, recipient);
        _assertUntouched();
    }

    /// The checks run in the spec's order: arguments, then dust, then the amount.
    function test_lock_checkOrder() public {
        vm.startPrank(alice);
        vm.expectRevert(PortaldotVault.ZeroArgument.selector);
        vault.lock{value: 1}(0, minter, recipient);
        vm.expectRevert(PortaldotVault.ZeroArgument.selector);
        vault.lock(SEPOLIA_CHAIN_ID, minter, address(0));
        vm.expectRevert(PortaldotVault.DustNotAllowed.selector);
        vault.lock{value: RATIO / 2}(SEPOLIA_CHAIN_ID, minter, recipient);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ storage layout

    /// Slots 0 to 3 hold what the spec says, at the keys Solidity derives for a mapping
    /// (keccak256(abi.encode(key, slot))). The minter on the other chain proves slot 0.
    function test_storageLayout() public {
        _lock(alice, SEPOLIA_CHAIN_ID, minter, recipient, 5 * TPOT);
        _lock(bob, SEPOLIA_CHAIN_ID, minter, alice, 7 * TPOT);
        bytes32 burnId = _burnId(SEPOLIA_CHAIN_ID, minter, 0);
        _release(burnId, recipient, 2 * TPOT);

        assertEq(vm.load(address(vault), bytes32(COMMITMENTS_SLOT)), bytes32(0), "a mapping's own slot stays empty");
        assertEq(
            vm.load(address(vault), _commitmentSlot(0)), _commitment(SEPOLIA_CHAIN_ID, minter, recipient, 5 * TPOT, 0)
        );
        assertEq(vm.load(address(vault), _commitmentSlot(1)), _commitment(SEPOLIA_CHAIN_ID, minter, alice, 7 * TPOT, 1));
        assertEq(vm.load(address(vault), _commitmentSlot(1)), vault.commitments(1));
        assertEq(_word(bytes32(NEXT_NONCE_SLOT)), 2);
        assertEq(_word(bytes32(OUTSTANDING_SLOT)), 10 * TPOT);
        assertEq(_word(bytes32(OUTSTANDING_SLOT)), vault.outstanding());
        assertEq(vm.load(address(vault), bytes32(RELEASED_SLOT)), bytes32(0), "a mapping's own slot stays empty");
        assertEq(vm.load(address(vault), _releasedSlot(burnId)), bytes32(uint256(1)));
        assertEq(vm.load(address(vault), _releasedSlot(_burnId(SEPOLIA_CHAIN_ID, minter, 1))), bytes32(0));
        assertTrue(vault.released(burnId));
    }

    /// A lock writes exactly its commitment, nextNonce and outstanding.
    function test_storageLayout_lockWrites() public {
        vm.record();
        _lock(alice, SEPOLIA_CHAIN_ID, minter, recipient, TPOT);
        (, bytes32[] memory writes) = vm.accesses(address(vault));
        _assertSameSlots(writes, _slots(_commitmentSlot(0), bytes32(NEXT_NONCE_SLOT), bytes32(OUTSTANDING_SLOT)));
    }

    /// A release writes exactly its released flag and outstanding.
    function test_storageLayout_releaseWrites() public {
        _lock(alice, SEPOLIA_CHAIN_ID, minter, recipient, TPOT);
        bytes32 burnId = _burnId(SEPOLIA_CHAIN_ID, minter, 9);
        vm.record();
        _release(burnId, recipient, TPOT);
        (, bytes32[] memory writes) = vm.accesses(address(vault));
        _assertSameSlots(writes, _slots(_releasedSlot(burnId), bytes32(OUTSTANDING_SLOT), bytes32(0)));
    }

    function _slots(bytes32 a, bytes32 b, bytes32 c) internal pure returns (bytes32[] memory s) {
        s = new bytes32[](c == bytes32(0) ? 2 : 3);
        s[0] = a;
        s[1] = b;
        if (c != bytes32(0)) s[2] = c;
    }

    /// Every slot written is expected, and every expected slot is written (in any order, repeats allowed).
    function _assertSameSlots(bytes32[] memory written, bytes32[] memory expected) internal pure {
        for (uint256 i = 0; i < written.length; i++) {
            bool known;
            for (uint256 j = 0; j < expected.length; j++) {
                if (written[i] == expected[j]) known = true;
            }
            assertTrue(known, "a write outside the expected slots");
        }
        for (uint256 j = 0; j < expected.length; j++) {
            bool seen;
            for (uint256 i = 0; i < written.length; i++) {
                if (written[i] == expected[j]) seen = true;
            }
            assertTrue(seen, "an expected slot is not written");
        }
    }

    // ------------------------------------------------------------------ release

    function test_release_paysAmountTimesRatio() public {
        _lock(alice, SEPOLIA_CHAIN_ID, minter, recipient, 10 * TPOT);
        bytes32 burnId = _burnId(SEPOLIA_CHAIN_ID, minter, 0);
        vm.expectEmit(address(vault));
        emit PortaldotVault.Released(burnId, bob, 4 * TPOT);
        uint256 before = bob.balance;
        _release(burnId, bob, 4 * TPOT);

        assertEq(bob.balance - before, 4 * TPOT * RATIO, "exactly amountNative x ratio");
        assertEq(address(vault).balance, 6 * TPOT * RATIO);
        assertEq(vault.outstanding(), 6 * TPOT);
        assertTrue(vault.released(burnId));
    }

    function test_release_everything() public {
        _lock(alice, SEPOLIA_CHAIN_ID, minter, recipient, 3 * TPOT);
        _lock(bob, SEPOLIA_CHAIN_ID, minter, recipient, 2 * TPOT);
        _release(_burnId(SEPOLIA_CHAIN_ID, minter, 0), recipient, 4 * TPOT);
        _release(_burnId(SEPOLIA_CHAIN_ID, minter, 1), recipient, TPOT);
        assertEq(vault.outstanding(), 0);
        assertEq(address(vault).balance, 0);
        assertEq(recipient.balance, 5 * TPOT * RATIO);
        vm.prank(releaser);
        vm.expectRevert(PortaldotVault.ExceedsOutstanding.selector);
        vault.release(_burnId(SEPOLIA_CHAIN_ID, minter, 2), payable(recipient), 1);
    }

    function test_release_rejectsOthers() public {
        _lock(alice, SEPOLIA_CHAIN_ID, minter, recipient, TPOT);
        address[4] memory callers = [alice, recipient, minter, address(this)];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(PortaldotVault.NotReleaser.selector);
            vault.release(bytes32(i), payable(callers[i]), 1);
        }
        assertEq(vault.outstanding(), TPOT);
    }

    function test_release_rejectsReplay() public {
        _lock(alice, SEPOLIA_CHAIN_ID, minter, recipient, 2 * TPOT);
        bytes32 burnId = _burnId(SEPOLIA_CHAIN_ID, minter, 0);
        _release(burnId, recipient, TPOT);
        vm.prank(releaser);
        vm.expectRevert(PortaldotVault.AlreadyReleased.selector);
        vault.release(burnId, payable(recipient), TPOT);
        assertEq(vault.outstanding(), TPOT);
        assertEq(recipient.balance, TPOT * RATIO);
    }

    function test_release_rejectsZeroRecipient() public {
        _lock(alice, SEPOLIA_CHAIN_ID, minter, recipient, TPOT);
        vm.prank(releaser);
        vm.expectRevert(PortaldotVault.ZeroArgument.selector);
        vault.release(bytes32(uint256(1)), payable(address(0)), TPOT);
        assertFalse(vault.released(bytes32(uint256(1))));
    }

    function test_release_rejectsZeroAmount() public {
        _lock(alice, SEPOLIA_CHAIN_ID, minter, recipient, TPOT);
        vm.prank(releaser);
        vm.expectRevert(PortaldotVault.ZeroArgument.selector);
        vault.release(bytes32(uint256(1)), payable(recipient), 0);
        assertFalse(vault.released(bytes32(uint256(1))));
    }

    function test_release_rejectsMoreThanOutstanding() public {
        vm.prank(releaser);
        vm.expectRevert(PortaldotVault.ExceedsOutstanding.selector);
        vault.release(bytes32(uint256(1)), payable(recipient), 1);

        _lock(alice, SEPOLIA_CHAIN_ID, minter, recipient, TPOT);
        vm.prank(releaser);
        vm.expectRevert(PortaldotVault.ExceedsOutstanding.selector);
        vault.release(bytes32(uint256(1)), payable(recipient), TPOT + 1);
        assertEq(vault.outstanding(), TPOT);
        assertFalse(vault.released(bytes32(uint256(1))));
    }

    /// The checks run in the spec's order: caller, replay, arguments, outstanding.
    function test_release_checkOrder() public {
        _lock(alice, SEPOLIA_CHAIN_ID, minter, recipient, TPOT);
        bytes32 used = bytes32(uint256(1));
        _release(used, recipient, 1);
        vm.prank(alice);
        vm.expectRevert(PortaldotVault.NotReleaser.selector);
        vault.release(used, payable(address(0)), 0);
        vm.startPrank(releaser);
        vm.expectRevert(PortaldotVault.AlreadyReleased.selector);
        vault.release(used, payable(address(0)), 0);
        vm.expectRevert(PortaldotVault.ZeroArgument.selector);
        vault.release(bytes32(uint256(2)), payable(address(0)), 2 * TPOT);
        vm.stopPrank();
    }

    function test_release_refusingRecipient_changesNothing() public {
        _lock(alice, SEPOLIA_CHAIN_ID, minter, recipient, TPOT);
        RefusingRecipient refusing = new RefusingRecipient();
        bytes32 burnId = _burnId(SEPOLIA_CHAIN_ID, minter, 0);
        vm.prank(releaser);
        vm.expectRevert(PortaldotVault.TransferFailed.selector);
        vault.release(burnId, payable(address(refusing)), TPOT);
        assertFalse(vault.released(burnId));
        assertEq(vault.outstanding(), TPOT);
        assertEq(address(vault).balance, TPOT * RATIO);
        assertEq(address(refusing).balance, 0);
    }

    /// The vault has no receive or fallback, so it cannot be its own payee.
    function test_release_toTheVault_fails() public {
        _lock(alice, SEPOLIA_CHAIN_ID, minter, recipient, TPOT);
        vm.prank(releaser);
        vm.expectRevert(PortaldotVault.TransferFailed.selector);
        vault.release(bytes32(uint256(1)), payable(address(vault)), TPOT);
    }

    function test_release_rejectsValue() public {
        _lock(alice, SEPOLIA_CHAIN_ID, minter, recipient, TPOT);
        vm.deal(releaser, 1 ether);
        vm.prank(releaser);
        (bool ok,) = address(vault).call{value: 1}(
            abi.encodeCall(PortaldotVault.release, (bytes32(uint256(1)), payable(recipient), 1))
        );
        assertFalse(ok, "release is not payable");
        assertEq(vault.outstanding(), TPOT);
    }

    // ------------------------------------------------------------------ re-entry

    /// A recipient that calls release while it is paid is not the releaser.
    function test_reentry_recipientCannotRelease() public {
        ReenteringRecipient reentering = new ReenteringRecipient(vault);
        _lock(alice, SEPOLIA_CHAIN_ID, minter, recipient, 2 * TPOT);
        _release(bytes32(uint256(1)), address(reentering), TPOT);

        assertEq(reentering.releaseRevert(), abi.encodeWithSelector(PortaldotVault.NotReleaser.selector));
        assertEq(address(reentering).balance, TPOT * RATIO);
        assertEq(vault.outstanding(), TPOT);
        assertTrue(vault.released(bytes32(uint256(1))));
        assertFalse(vault.released(keccak256("re-entered")));
    }

    /// When the recipient passes that revert on, the payout fails and nothing changes.
    function test_reentry_recipientRevert_changesNothing() public {
        ReenteringRecipient reentering = new ReenteringRecipient(vault);
        reentering.setMode(ReenteringRecipient.Mode.ReleaseAndRevert);
        _lock(alice, SEPOLIA_CHAIN_ID, minter, recipient, TPOT);
        vm.prank(releaser);
        vm.expectRevert(PortaldotVault.TransferFailed.selector);
        vault.release(bytes32(uint256(1)), payable(address(reentering)), TPOT);
        assertFalse(vault.released(bytes32(uint256(1))));
        assertEq(vault.outstanding(), TPOT);
        assertEq(address(vault).balance, TPOT * RATIO);
    }

    /// A recipient that locks what it is paid, during the payout, gets the next nonce, and the
    /// accounting holds: the release is already counted when the lock runs.
    function test_reentry_recipientLocksThePayout() public {
        ReenteringRecipient reentering = new ReenteringRecipient(vault);
        reentering.setMode(ReenteringRecipient.Mode.Lock);
        _lock(alice, SEPOLIA_CHAIN_ID, minter, recipient, 5 * TPOT);
        _release(bytes32(uint256(1)), address(reentering), 2 * TPOT);

        assertEq(reentering.relockNonce(), 1);
        assertEq(reentering.relockValue(), 2 * TPOT * RATIO);
        assertEq(_nextNonce(), 2);
        assertEq(vault.outstanding(), 5 * TPOT, "5 locked, 2 released, 2 locked again");
        assertEq(address(vault).balance, 5 * TPOT * RATIO);
        assertEq(vault.commitments(1), _commitment(SEPOLIA_CHAIN_ID, address(0xB0B), address(reentering), 2 * TPOT, 1));
    }

    /// The burn is marked released before the payout: a releaser that asks for the same burn while
    /// it is paid is refused.
    function test_reentry_releaserCannotReleaseTwice() public {
        ReenteringReleaser contractReleaser = new ReenteringReleaser();
        vault = _deploy(RATIO, address(contractReleaser));
        contractReleaser.setVault(vault);
        _lock(alice, SEPOLIA_CHAIN_ID, minter, recipient, 3 * TPOT);
        bytes32 burnId = _burnId(SEPOLIA_CHAIN_ID, minter, 0);
        contractReleaser.release(burnId, TPOT);

        assertEq(contractReleaser.reentryRevert(), abi.encodeWithSelector(PortaldotVault.AlreadyReleased.selector));
        assertEq(address(contractReleaser).balance, TPOT * RATIO);
        assertEq(vault.outstanding(), 2 * TPOT);
    }

    // ------------------------------------------------------------------ plain transfers

    function test_plainValueTransferReverts() public {
        vm.startPrank(alice);
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertFalse(ok, "no receive");
        (ok,) = address(vault).call{value: 1 ether}(hex"12345678");
        assertFalse(ok, "no fallback");
        assertFalse(payable(address(vault)).send(1 ether), "send");
        vm.stopPrank();
        _assertUntouched();
    }

    // ------------------------------------------------------------------ the minter's view

    /// A minter on another chain sees only the Locked event and its own configuration (the V3
    /// chain id and the vault address). From those it recomputes the word the vault stored, which
    /// it then proves at slot 0. Another minter, or the same minter on another chain, computes a
    /// different word, so the lock can be minted once, by one minter, on one chain.
    function test_minterRecomputesTheCommitment() public {
        MinterView minterView = new MinterView();
        vm.recordLogs();
        _lock(alice, SEPOLIA_CHAIN_ID, address(minterView), recipient, 42 * TPOT);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], LOCKED_TOPIC);
        uint256 nonce = uint256(logs[0].topics[1]);
        address eventRecipient = address(uint160(uint256(logs[0].topics[3])));
        (,, uint256 amountNative, bytes32 eventCommitment) =
            abi.decode(logs[0].data, (uint256, address, uint256, bytes32));
        bytes32 stored = vm.load(address(vault), _commitmentSlot(nonce));
        assertEq(stored, eventCommitment);

        vm.chainId(SEPOLIA_CHAIN_ID);
        assertEq(minterView.expected(V3_CHAIN_ID, address(vault), eventRecipient, amountNative, nonce), stored);

        MinterView otherMinter = new MinterView();
        assertTrue(otherMinter.expected(V3_CHAIN_ID, address(vault), eventRecipient, amountNative, nonce) != stored);
        vm.chainId(1);
        assertTrue(minterView.expected(V3_CHAIN_ID, address(vault), eventRecipient, amountNative, nonce) != stored);
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_lock(uint256 amountNative, uint256 dstChainId, address dstMinter, address to, uint8 earlier)
        public
    {
        amountNative = bound(amountNative, 1, 1e8 * TPOT);
        dstChainId = bound(dstChainId, 1, type(uint256).max);
        vm.assume(dstMinter != address(0) && to != address(0));
        uint256 before = earlier % 4;
        for (uint256 i = 0; i < before; i++) {
            _lock(bob, SEPOLIA_CHAIN_ID, minter, recipient, TPOT);
        }
        bytes32 commitment = _commitment(dstChainId, dstMinter, to, amountNative, before);
        vm.expectEmit(address(vault));
        emit PortaldotVault.Locked(before, alice, to, dstChainId, dstMinter, amountNative, commitment);
        uint256 nonce = _lock(alice, dstChainId, dstMinter, to, amountNative);

        assertEq(nonce, before);
        assertEq(vault.commitments(nonce), commitment);
        assertEq(vm.load(address(vault), _commitmentSlot(nonce)), commitment);
        assertEq(_nextNonce(), before + 1);
        assertEq(vault.outstanding(), before * TPOT + amountNative);
    }

    function testFuzz_lockRejectsDust(uint256 value) public {
        value = bound(value, 1, 1e9 ether);
        if (value % RATIO == 0) value -= 1;
        vm.prank(alice);
        vm.expectRevert(PortaldotVault.DustNotAllowed.selector);
        vault.lock{value: value}(SEPOLIA_CHAIN_ID, minter, recipient);
    }

    function testFuzz_release(uint256 locked, uint256 asked) public {
        locked = bound(locked, 1, 1e8 * TPOT);
        asked = bound(asked, 1, 2e8 * TPOT);
        _lock(alice, SEPOLIA_CHAIN_ID, minter, recipient, locked);
        vm.prank(releaser);
        if (asked > locked) vm.expectRevert(PortaldotVault.ExceedsOutstanding.selector);
        vault.release(bytes32(asked), payable(bob), asked);
        uint256 paid = asked > locked ? 0 : asked;
        assertEq(vault.outstanding(), locked - paid);
        assertEq(bob.balance, 1e9 ether + paid * RATIO);
        assertEq(address(vault).balance, (locked - paid) * RATIO);
    }

    /// A random sequence of locks and releases keeps the accounting after every step.
    function testFuzz_accounting(uint256 seed) public {
        uint256 lockedSum;
        uint256 releasedSum;
        uint256 locks;
        for (uint256 i = 0; i < 24; i++) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            if (r % 3 != 0 || vault.outstanding() == 0) {
                uint256 amountNative = 1 + (r >> 8) % (1000 * TPOT);
                address from = (r >> 200) % 2 == 0 ? alice : bob;
                assertEq(_lock(from, 1 + (r >> 100) % 1000, minter, recipient, amountNative), locks);
                locks++;
                lockedSum += amountNative;
            } else {
                uint256 amountNative = 1 + (r >> 8) % vault.outstanding();
                _release(keccak256(abi.encode(seed, i)), recipient, amountNative);
                releasedSum += amountNative;
            }
            assertEq(vault.outstanding(), lockedSum - releasedSum);
            assertGe(address(vault).balance, vault.outstanding() * RATIO);
            assertEq(_nextNonce(), locks);
        }
        assertEq(recipient.balance, releasedSum * RATIO);
    }
}

/// The suite on the vault as the default profile compiles it.
contract PortaldotVaultSourceTest is PortaldotVaultBase {
    function _initcode() internal pure override returns (bytes memory) {
        return type(PortaldotVault).creationCode;
    }
}

/// The suite on the V3 build that relayer/src/v3-vault.ts deploys: contracts/out-v3, from
/// `FOUNDRY_PROFILE=v3 forge build --skip test --skip script` (IR pipeline, cancun, no CBOR
/// metadata). Without that build the suite is skipped. It also checks the build itself.
contract PortaldotVaultV3BuildTest is PortaldotVaultBase {
    string internal constant ARTIFACT = "out-v3/PortaldotVault.sol/PortaldotVault.json";
    string internal constant SOURCE = "src/bridge/PortaldotVault.sol";
    uint256 internal constant SIZE_BUDGET = 900;

    struct ImmutableRef {
        uint256 length;
        uint256 start;
    }

    function setUp() public override {
        if (!vm.exists(ARTIFACT)) {
            vm.skip(true, "no V3 build: run FOUNDRY_PROFILE=v3 forge build --skip test --skip script");
        }
        super.setUp();
    }

    function _initcode() internal view override returns (bytes memory) {
        return vm.getCode(ARTIFACT);
    }

    /// The build is from the source in this checkout (the source hash in its metadata).
    function test_v3Build_isTheCurrentSource() public view {
        string memory json = vm.readFile(ARTIFACT);
        bytes32 built = vm.parseJsonBytes32(json, string.concat(".metadata.sources['", SOURCE, "'].keccak256"));
        assertEq(built, keccak256(bytes(vm.readFile(SOURCE))), "out-v3 is older than the source: rebuild it");
    }

    function test_v3Build_settings() public view {
        string memory json = vm.readFile(ARTIFACT);
        assertEq(vm.parseJsonString(json, ".metadata.settings.evmVersion"), "cancun");
        assertTrue(vm.parseJsonBool(json, ".metadata.settings.viaIR"), "IR pipeline");
        assertFalse(vm.parseJsonBool(json, ".metadata.settings.metadata.appendCBOR"), "no CBOR metadata");
        assertEq(vm.parseJsonString(json, ".metadata.compiler.version"), "0.8.27+commit.40a35a09");
        assertLe(address(vault).code.length, SIZE_BUDGET, "runtime code over the size budget");
        assertEq(address(vault).code.length, vm.parseJsonBytes(json, ".deployedBytecode.object").length);
    }

    /// The deployed code is the build's runtime code with the two immutables filled in: every
    /// reference of one holds the ratio, every reference of the other the releaser.
    function test_v3Build_codeHoldsTheImmutables() public view {
        string memory json = vm.readFile(ARTIFACT);
        bytes memory expected = vm.parseJsonBytes(json, ".deployedBytecode.object");
        bytes memory code = address(vault).code;
        string[] memory ids = vm.parseJsonKeys(json, ".deployedBytecode.immutableReferences");
        assertEq(ids.length, 2, "two immutables");
        bool sawRatio;
        bool sawReleaser;
        for (uint256 i = 0; i < ids.length; i++) {
            ImmutableRef[] memory refs = abi.decode(
                vm.parseJson(json, string.concat(".deployedBytecode.immutableReferences.", ids[i])), (ImmutableRef[])
            );
            bytes32 value = _wordAt(code, refs[0].start);
            if (value == bytes32(RATIO)) sawRatio = true;
            else if (value == bytes32(uint256(uint160(releaser)))) sawReleaser = true;
            else revert("an immutable holds neither the ratio nor the releaser");
            for (uint256 j = 0; j < refs.length; j++) {
                assertEq(refs[j].length, 32);
                assertEq(_wordAt(code, refs[j].start), value);
                assertEq(_wordAt(expected, refs[j].start), bytes32(0), "the build leaves immutables zero");
                for (uint256 k = 0; k < 32; k++) {
                    expected[refs[j].start + k] = code[refs[j].start + k];
                }
            }
        }
        assertTrue(sawRatio && sawReleaser);
        assertEq(code, expected, "the rest of the code is the build's");
    }

    function _wordAt(bytes memory data, uint256 at) internal pure returns (bytes32 w) {
        assembly ("memory-safe") {
            w := mload(add(add(data, 0x20), at))
        }
    }
}

// ------------------------------------------------------------------ invariants

/// Drives the vault with random locks, releases and refused calls, and counts what succeeded.
contract VaultHandler is Test {
    uint256 internal constant RATIO = 10_000;
    uint256 internal constant TPOT = 1e14;

    PortaldotVault public immutable vault;
    address public immutable releaser;
    uint256 public lockedSum;
    uint256 public releasedSum;
    uint256 public locks;
    uint256 internal burns;
    address[3] internal actors = [address(0xA11CE), address(0xB0B), address(0xCA401)];

    constructor(PortaldotVault vault_, address releaser_) {
        vault = vault_;
        releaser = releaser_;
    }

    function lock(uint256 actorSeed, uint256 amountNative, uint256 dstChainId) external {
        address actor = actors[actorSeed % 3];
        amountNative = bound(amountNative, 1, 1e6 * TPOT);
        dstChainId = bound(dstChainId, 1, type(uint64).max);
        vm.deal(actor, amountNative * RATIO);
        vm.prank(actor);
        assertEq(vault.lock{value: amountNative * RATIO}(dstChainId, address(0xB0B), actor), locks);
        locks++;
        lockedSum += amountNative;
    }

    function release(uint256 amountNative, uint256 toSeed) external {
        uint256 left = vault.outstanding();
        if (left == 0) return;
        amountNative = bound(amountNative, 1, left);
        vm.prank(releaser);
        vault.release(keccak256(abi.encode("burn", burns++)), payable(actors[toSeed % 3]), amountNative);
        releasedSum += amountNative;
    }

    function releaseTooMuch(uint256 extra) external {
        uint256 asked = vault.outstanding() + bound(extra, 1, 1e30);
        vm.prank(releaser);
        vm.expectRevert(PortaldotVault.ExceedsOutstanding.selector);
        vault.release(keccak256("too much"), payable(actors[0]), asked);
    }

    function replay(uint256 which) external {
        if (burns == 0) return;
        vm.prank(releaser);
        vm.expectRevert(PortaldotVault.AlreadyReleased.selector);
        vault.release(keccak256(abi.encode("burn", which % burns)), payable(actors[0]), 1);
    }

    function lockDust(uint256 value) external {
        value = bound(value, 1, 1e30);
        if (value % RATIO == 0) value += 1;
        vm.deal(actors[1], value);
        vm.prank(actors[1]);
        vm.expectRevert(PortaldotVault.DustNotAllowed.selector);
        vault.lock{value: value}(1, address(0xB0B), actors[1]);
    }

    function releaseAsOther(uint256 actorSeed) external {
        vm.prank(actors[actorSeed % 3]);
        vm.expectRevert(PortaldotVault.NotReleaser.selector);
        vault.release(keccak256("other"), payable(actors[0]), 1);
    }
}

/// Whatever the sequence of calls: outstanding is what was locked minus what was released, the
/// vault holds at least outstanding times the ratio, and nextNonce counts the locks.
abstract contract PortaldotVaultInvariantBase is VaultDeployer {
    PortaldotVault internal vault;
    VaultHandler internal handler;

    function setUp() public virtual {
        vm.chainId(V3_CHAIN_ID);
        address releaser = makeAddr("releaser");
        vault = _deploy(RATIO, releaser);
        handler = new VaultHandler(vault, releaser);
        targetContract(address(handler));
    }

    function invariant_accounting() public view {
        assertEq(vault.outstanding(), handler.lockedSum() - handler.releasedSum());
        assertGe(address(vault).balance, vault.outstanding() * RATIO);
        assertEq(address(vault).balance, vault.outstanding() * RATIO, "nothing else sends the vault value here");
        assertEq(uint256(vm.load(address(vault), bytes32(uint256(1)))), handler.locks());
    }
}

contract PortaldotVaultSourceInvariantTest is PortaldotVaultInvariantBase {
    function _initcode() internal pure override returns (bytes memory) {
        return type(PortaldotVault).creationCode;
    }
}

contract PortaldotVaultV3BuildInvariantTest is PortaldotVaultInvariantBase {
    string internal constant ARTIFACT = "out-v3/PortaldotVault.sol/PortaldotVault.json";

    function setUp() public override {
        if (!vm.exists(ARTIFACT)) {
            vm.skip(true, "no V3 build: run FOUNDRY_PROFILE=v3 forge build --skip test --skip script");
        }
        super.setUp();
    }

    function _initcode() internal view override returns (bytes memory) {
        return vm.getCode(ARTIFACT);
    }
}
