// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// A devnet USDC (V6, Privacy Wallet Web spec v2.0 §3): the runtime code is placed at the mainnet USDC address with
/// hardhat_setCode, so the wallet's asset registry (6 decimals, the mainnet address) and the Chainlink USDC / USD feed
/// apply unchanged. No constructor runs there, so the name, the symbol and the decimals are constants in the code. A
/// standard ERC-20 (returns bool); anyone may mint — on the devnet only.
contract MockUSDC {
    mapping(address => uint256) public balanceOf; // slot 0
    mapping(address => mapping(address => uint256)) public allowance; // slot 1
    uint256 public totalSupply; // slot 2

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function name() external pure returns (string memory) { return "USD Coin"; }
    function symbol() external pure returns (string memory) { return "USDC"; }
    function decimals() external pure returns (uint8) { return 6; }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
