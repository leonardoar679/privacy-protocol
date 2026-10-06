// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20Mock} from "./ERC20Mock.sol";

/// @dev Elastic/rebasing-style: a receipt credits 10% MORE than sent, so the vault's measured
/// balance delta != amount and the strict deposit check must REJECT it (spec §15: rebasing
/// unsupported).
contract RebaseToken is ERC20Mock {
    function _transfer(address from, address to, uint256 amount) internal override {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        uint256 credited = amount + amount / 10;
        balanceOf[to] += credited;
        totalSupply += amount / 10;
    }
}
