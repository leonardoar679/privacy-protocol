// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Returns false instead of reverting (and moves nothing). Deposit's strict check must reject
/// (false return => revert); payout's soft check treats it as a failed transfer => claimable.
contract FalseReturnToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }
}
