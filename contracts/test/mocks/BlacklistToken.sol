// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20Mock} from "./ERC20Mock.sol";

/// @dev USDT/USDC-style issuer controls: an owner can blacklist addresses (transfers to/from them
/// revert) and destroy a blacklisted address's balance. Used to prove issuer-freeze damage is
/// strictly asset-local (spec §17, §82).
contract BlacklistToken is ERC20Mock {
    address public owner;
    mapping(address => bool) public blacklisted;

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    function blacklist(address a) external onlyOwner {
        blacklisted[a] = true;
    }

    function unblacklist(address a) external onlyOwner {
        blacklisted[a] = false;
    }

    function destroyBlacklistedFunds(address a) external onlyOwner {
        require(blacklisted[a], "not blacklisted");
        uint256 b = balanceOf[a];
        balanceOf[a] = 0;
        totalSupply -= b;
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        require(!blacklisted[from] && !blacklisted[to], "blacklisted");
        super._transfer(from, to, amount);
    }
}
