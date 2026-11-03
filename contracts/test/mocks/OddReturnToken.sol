// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Moves the funds but answers `transfer` with a 32-byte word that is neither 0 nor 1 (a status code, the amount): what an
/// upgraded token may start to do after its deposits. `transferFrom` is standard, so a deposit passes the strict check.
contract OddReturnToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (uint256) {
        _move(msg.sender, to, amount);
        return 2;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}
