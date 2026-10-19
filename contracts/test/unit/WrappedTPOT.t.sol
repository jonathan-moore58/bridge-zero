// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

import {Test, Vm} from "forge-std/Test.sol";
import {WrappedTPOT} from "../../src/bridge/WrappedTPOT.sol";

/// The token on its own: ERC-20 behaviour, and mint and burnFrom for the minter only.
contract WrappedTPOTTest is Test {
    bytes32 internal constant TRANSFER_TOPIC = keccak256("Transfer(address,address,uint256)");
    bytes32 internal constant APPROVAL_TOPIC = keccak256("Approval(address,address,uint256)");
    uint256 internal constant TPOT = 1e14;

    WrappedTPOT internal token;
    address internal minter;
    address internal alice;
    address internal bob;
    address internal carol;

    function setUp() public {
        minter = makeAddr("minter");
        alice = makeAddr("alice");
        bob = makeAddr("bob");
        carol = makeAddr("carol");
        token = new WrappedTPOT(minter);
    }

    function _mint(address to, uint256 amount) internal {
        vm.prank(minter);
        token.mint(to, amount);
    }

    // ------------------------------------------------------------------ metadata and constructor

    function test_metadata() public view {
        assertEq(token.name(), "Wrapped tPOTv3");
        assertEq(token.symbol(), "wtPOT");
        assertEq(token.decimals(), 14, "one unit is one native base unit of tPOT");
        assertEq(token.minter(), minter);
        assertEq(token.totalSupply(), 0);
    }

    function test_constructor_rejectsZeroMinter() public {
        vm.expectRevert(WrappedTPOT.ZeroMinter.selector);
        new WrappedTPOT(address(0));
    }

    /// Nothing is payable, and there is no fallback.
    function test_noReceiveOrFallback() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(token).call{value: 1}("");
        assertFalse(ok, "a plain value transfer reverts");
        (ok,) = address(token).call(hex"deadbeef");
        assertFalse(ok, "an unknown selector reverts");
    }

    // ------------------------------------------------------------------ mint and burnFrom

    function test_mint() public {
        vm.expectEmit(address(token));
        emit WrappedTPOT.Transfer(address(0), alice, 3 * TPOT);
        _mint(alice, 3 * TPOT);
        assertEq(token.balanceOf(alice), 3 * TPOT);
        assertEq(token.totalSupply(), 3 * TPOT);
        _mint(alice, 1);
        _mint(bob, TPOT);
        assertEq(token.balanceOf(alice), 3 * TPOT + 1);
        assertEq(token.totalSupply(), 4 * TPOT + 1);
    }

    function test_mint_onlyMinter() public {
        address[3] memory others = [alice, address(this), address(token)];
        for (uint256 i = 0; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(WrappedTPOT.NotMinter.selector);
            token.mint(alice, 1);
        }
        assertEq(token.totalSupply(), 0);
    }

    function test_mint_rejectsZeroAddress() public {
        vm.prank(minter);
        vm.expectRevert(WrappedTPOT.ZeroAddress.selector);
        token.mint(address(0), 1);
    }

    /// Minting zero is allowed and changes nothing but the log.
    function test_mint_zero() public {
        _mint(alice, 0);
        assertEq(token.balanceOf(alice), 0);
        assertEq(token.totalSupply(), 0);
    }

    function test_burnFrom() public {
        _mint(alice, 5 * TPOT);
        vm.expectEmit(address(token));
        emit WrappedTPOT.Transfer(alice, address(0), 2 * TPOT);
        vm.prank(minter);
        token.burnFrom(alice, 2 * TPOT);
        assertEq(token.balanceOf(alice), 3 * TPOT);
        assertEq(token.totalSupply(), 3 * TPOT);
        vm.prank(minter);
        token.burnFrom(alice, 3 * TPOT);
        assertEq(token.balanceOf(alice), 0);
        assertEq(token.totalSupply(), 0);
    }

    /// burnFrom needs no allowance: the minter is trusted to burn only for its own caller.
    function test_burnFrom_withoutAllowance() public {
        _mint(alice, TPOT);
        assertEq(token.allowance(alice, minter), 0);
        vm.prank(minter);
        token.burnFrom(alice, TPOT);
        assertEq(token.balanceOf(alice), 0);
    }

    function test_burnFrom_onlyMinter() public {
        _mint(alice, TPOT);
        vm.prank(alice);
        vm.expectRevert(WrappedTPOT.NotMinter.selector);
        token.burnFrom(alice, 1);
        vm.prank(alice);
        token.approve(address(this), TPOT);
        vm.expectRevert(WrappedTPOT.NotMinter.selector);
        token.burnFrom(alice, 1);
        assertEq(token.balanceOf(alice), TPOT);
    }

    function test_burnFrom_moreThanBalance() public {
        _mint(alice, TPOT);
        vm.prank(minter);
        vm.expectRevert(abi.encodeWithSelector(WrappedTPOT.InsufficientBalance.selector, TPOT, TPOT + 1));
        token.burnFrom(alice, TPOT + 1);
        vm.prank(minter);
        vm.expectRevert(abi.encodeWithSelector(WrappedTPOT.InsufficientBalance.selector, 0, 1));
        token.burnFrom(bob, 1);
        assertEq(token.totalSupply(), TPOT);
    }

    // ------------------------------------------------------------------ transfer

    function test_transfer() public {
        _mint(alice, 10 * TPOT);
        vm.expectEmit(address(token));
        emit WrappedTPOT.Transfer(alice, bob, 4 * TPOT);
        vm.prank(alice);
        assertTrue(token.transfer(bob, 4 * TPOT));
        assertEq(token.balanceOf(alice), 6 * TPOT);
        assertEq(token.balanceOf(bob), 4 * TPOT);
        assertEq(token.totalSupply(), 10 * TPOT);
    }

    function test_transfer_all() public {
        _mint(alice, TPOT);
        vm.prank(alice);
        token.transfer(bob, TPOT);
        assertEq(token.balanceOf(alice), 0);
        assertEq(token.balanceOf(bob), TPOT);
    }

    function test_transfer_toSelf() public {
        _mint(alice, TPOT);
        vm.prank(alice);
        token.transfer(alice, TPOT);
        assertEq(token.balanceOf(alice), TPOT);
    }

    function test_transfer_zeroAmount() public {
        vm.prank(alice);
        assertTrue(token.transfer(bob, 0));
        assertEq(token.balanceOf(bob), 0);
    }

    function test_transfer_moreThanBalance() public {
        _mint(alice, TPOT);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(WrappedTPOT.InsufficientBalance.selector, TPOT, TPOT + 1));
        token.transfer(bob, TPOT + 1);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(WrappedTPOT.InsufficientBalance.selector, 0, 1));
        token.transfer(alice, 1);
    }

    function test_transfer_rejectsZeroAddress() public {
        _mint(alice, TPOT);
        vm.prank(alice);
        vm.expectRevert(WrappedTPOT.ZeroAddress.selector);
        token.transfer(address(0), 1);
        assertEq(token.balanceOf(alice), TPOT);
    }

    // ------------------------------------------------------------------ approve and transferFrom

    function test_approve() public {
        vm.expectEmit(address(token));
        emit WrappedTPOT.Approval(alice, bob, 7);
        vm.prank(alice);
        assertTrue(token.approve(bob, 7));
        assertEq(token.allowance(alice, bob), 7);
        vm.prank(alice);
        token.approve(bob, 2);
        assertEq(token.allowance(alice, bob), 2, "approve sets, it does not add");
        vm.prank(alice);
        token.approve(bob, 0);
        assertEq(token.allowance(alice, bob), 0);
    }

    function test_approve_rejectsZeroSpender() public {
        vm.prank(alice);
        vm.expectRevert(WrappedTPOT.ZeroAddress.selector);
        token.approve(address(0), 1);
    }

    function test_transferFrom() public {
        _mint(alice, 10 * TPOT);
        vm.prank(alice);
        token.approve(bob, 6 * TPOT);
        vm.expectEmit(address(token));
        emit WrappedTPOT.Transfer(alice, carol, 4 * TPOT);
        vm.prank(bob);
        assertTrue(token.transferFrom(alice, carol, 4 * TPOT));
        assertEq(token.balanceOf(alice), 6 * TPOT);
        assertEq(token.balanceOf(carol), 4 * TPOT);
        assertEq(token.allowance(alice, bob), 2 * TPOT, "the allowance is spent");
        vm.prank(bob);
        token.transferFrom(alice, bob, 2 * TPOT);
        assertEq(token.allowance(alice, bob), 0);
        assertEq(token.balanceOf(bob), 2 * TPOT);
    }

    /// No Approval event is emitted when an allowance is spent.
    function test_transferFrom_logs() public {
        _mint(alice, TPOT);
        vm.prank(alice);
        token.approve(bob, TPOT);
        vm.recordLogs();
        vm.prank(bob);
        token.transferFrom(alice, carol, TPOT);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], TRANSFER_TOPIC);
        assertEq(logs[0].topics[1], bytes32(uint256(uint160(alice))));
        assertEq(logs[0].topics[2], bytes32(uint256(uint160(carol))));
        assertEq(logs[0].data, abi.encode(TPOT));
    }

    function test_transferFrom_infiniteAllowance() public {
        _mint(alice, 3 * TPOT);
        vm.prank(alice);
        token.approve(bob, type(uint256).max);
        vm.prank(bob);
        token.transferFrom(alice, carol, 2 * TPOT);
        assertEq(token.allowance(alice, bob), type(uint256).max, "not decremented");
        assertEq(token.balanceOf(carol), 2 * TPOT);
    }

    function test_transferFrom_moreThanAllowance() public {
        _mint(alice, 3 * TPOT);
        vm.prank(alice);
        token.approve(bob, TPOT);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(WrappedTPOT.InsufficientAllowance.selector, TPOT, TPOT + 1));
        token.transferFrom(alice, carol, TPOT + 1);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(WrappedTPOT.InsufficientAllowance.selector, 0, 1));
        token.transferFrom(alice, carol, 1);
        assertEq(token.balanceOf(alice), 3 * TPOT);
    }

    /// The allowance is checked before the balance.
    function test_transferFrom_moreThanBalance() public {
        _mint(alice, TPOT);
        vm.prank(alice);
        token.approve(bob, 2 * TPOT);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(WrappedTPOT.InsufficientBalance.selector, TPOT, TPOT + 1));
        token.transferFrom(alice, carol, TPOT + 1);
        assertEq(token.allowance(alice, bob), 2 * TPOT, "nothing spent");
    }

    function test_transferFrom_rejectsZeroAddress() public {
        _mint(alice, TPOT);
        vm.prank(alice);
        token.approve(bob, TPOT);
        vm.prank(bob);
        vm.expectRevert(WrappedTPOT.ZeroAddress.selector);
        token.transferFrom(alice, address(0), 1);
        assertEq(token.allowance(alice, bob), TPOT);
    }

    /// Nothing moves from the zero address: a transferFrom from it reverts, even for 0, so no
    /// Transfer log from it appears other than a mint's.
    function test_transferFrom_fromZeroAddress() public {
        vm.prank(bob);
        vm.expectRevert(WrappedTPOT.ZeroAddress.selector);
        token.transferFrom(address(0), carol, 0);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(WrappedTPOT.InsufficientAllowance.selector, 0, 1));
        token.transferFrom(address(0), carol, 1);
    }

    /// The holder can move its own units through transferFrom only with an allowance to itself.
    function test_transferFrom_selfNeedsAllowance() public {
        _mint(alice, TPOT);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(WrappedTPOT.InsufficientAllowance.selector, 0, 1));
        token.transferFrom(alice, bob, 1);
    }

    // ------------------------------------------------------------------ fuzz

    /// Mints, transfers and burns keep the balances summing to totalSupply.
    function testFuzz_accounting(uint128 a, uint128 b, uint128 moved, uint128 burned) public {
        _mint(alice, a);
        _mint(bob, b);
        moved = uint128(bound(moved, 0, a));
        vm.prank(alice);
        token.transfer(bob, moved);
        burned = uint128(bound(burned, 0, uint256(b) + moved));
        vm.prank(minter);
        token.burnFrom(bob, burned);
        assertEq(token.balanceOf(alice), uint256(a) - moved);
        assertEq(token.balanceOf(bob), uint256(b) + moved - burned);
        assertEq(token.totalSupply(), uint256(a) + b - burned);
        assertEq(token.balanceOf(alice) + token.balanceOf(bob), token.totalSupply());
    }

    function testFuzz_allowance(address spender, uint256 allowed, uint256 spent) public {
        vm.assume(spender != address(0));
        vm.assume(allowed != type(uint256).max);
        spent = bound(spent, 0, allowed);
        _mint(alice, type(uint128).max);
        spent = bound(spent, 0, type(uint128).max);
        vm.prank(alice);
        token.approve(spender, allowed);
        vm.prank(spender);
        token.transferFrom(alice, bob, spent);
        assertEq(token.allowance(alice, spender), allowed - spent);
        assertEq(token.balanceOf(bob), spent);
    }
}
