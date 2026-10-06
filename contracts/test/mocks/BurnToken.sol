// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20Mock} from "./ERC20Mock.sol";

/// @dev Deflationary token: burns 1% of every transfer. Like fee-on-transfer, the recipient gets
/// less than `amount`, so the vault's strict balance-delta check must reject it.
contract BurnToken is ERC20Mock {
    function _transfer(address from, address to, uint256 amount) internal override {
        require(balanceOf[from] >= amount, "balance");
        uint256 burn = amount / 100;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - burn;
        totalSupply -= burn;
    }
}
