// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.27;

/// What BridgeMinter calls on the token.
interface IWrappedTPOT {
    function mint(address to, uint256 amount) external;
    function burnFrom(address from, uint256 amount) external;
}

/// @title WrappedTPOT
/// @notice wtPOT, the ERC-20 that stands for tPOT locked in PortaldotVault on the Portaldot V3
/// testnet: 14 decimals, so one unit is one native base unit of tPOT. Only `minter`, the
/// BridgeMinter it is deployed with, creates and destroys units: it mints what a proven lock names,
/// and burns what a holder gives up through BridgeMinter.burn, where the trusted return path
/// starts. There is no other way to burn, so every burn leaves a BurnRequested event for the
/// committee to act on. No owner, no admin, no permit, no upgrade path.
///
/// A plain ERC-20 otherwise: transfer, approve and transferFrom with the usual events; an
/// allowance of type(uint256).max is not decremented; the zero address is neither a holder nor a
/// spender.
contract WrappedTPOT is IWrappedTPOT {
    string public constant name = "Wrapped tPOTv3";
    string public constant symbol = "wtPOT";
    uint8 public constant decimals = 14;

    /// The only caller of mint and burnFrom.
    address public immutable minter;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error ZeroMinter();
    error NotMinter();
    /// A holder, recipient or spender that would be the zero address.
    error ZeroAddress();
    error InsufficientBalance(uint256 balance, uint256 needed);
    error InsufficientAllowance(uint256 allowance, uint256 needed);

    constructor(address minter_) {
        if (minter_ == address(0)) revert ZeroMinter();
        minter = minter_;
    }

    modifier onlyMinter() {
        if (msg.sender != minter) revert NotMinter();
        _;
    }

    // ------------------------------------------------------------------ minter

    /// Creates `amount` units for `to`. Only the minter, for a proven lock.
    function mint(address to, uint256 amount) external onlyMinter {
        if (to == address(0)) revert ZeroAddress();
        totalSupply += amount;
        // At most totalSupply, which did not overflow.
        unchecked {
            balanceOf[to] += amount;
        }
        emit Transfer(address(0), to, amount);
    }

    /// Destroys `amount` of `from`'s units. Only the minter, which calls it for its own caller
    /// (BridgeMinter.burn); no allowance is involved.
    function burnFrom(address from, uint256 amount) external onlyMinter {
        uint256 balance = balanceOf[from];
        if (balance < amount) revert InsufficientBalance(balance, amount);
        // amount is at most the balance, which is at most totalSupply.
        unchecked {
            balanceOf[from] = balance - amount;
            totalSupply -= amount;
        }
        emit Transfer(from, address(0), amount);
    }

    // ------------------------------------------------------------------ ERC-20

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        if (spender == address(0)) revert ZeroAddress();
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    /// Spends msg.sender's allowance from `from`, unless it is type(uint256).max.
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < amount) revert InsufficientAllowance(allowed, amount);
            unchecked {
                allowance[from][msg.sender] = allowed - amount;
            }
        }
        _transfer(from, to, amount);
        return true;
    }

    /// Moves `amount` from `from` to `to`. Neither may be the zero address: a Transfer from or to
    /// it is a mint or a burn.
    function _transfer(address from, address to, uint256 amount) private {
        if (from == address(0) || to == address(0)) revert ZeroAddress();
        uint256 balance = balanceOf[from];
        if (balance < amount) revert InsufficientBalance(balance, amount);
        // The sum of all balances is totalSupply, so neither side overflows.
        unchecked {
            balanceOf[from] = balance - amount;
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
    }
}
