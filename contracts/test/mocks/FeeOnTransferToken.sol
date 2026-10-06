// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20Mock} from "./ERC20Mock.sol";

/// @dev Fee-on-transfer: recipient receives 1% less than sent. The vault's strict balance-delta
/// check must REJECT this on deposit (spec §15).
contract FeeOnTransferToken is ERC20Mock {
    function _transfer(address from, address to, uint256 amount) internal override {
        require(balanceOf[from] >= amount, "balance");
        uint256 fee = amount / 100;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee;
        // fee is burned (leaves circulation) so the vault sees a short credit.
        totalSupply -= fee;
    }
}
