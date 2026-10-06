// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20Mock} from "./ERC20Mock.sol";

/// @dev Issuer-pausable token (USDC-style): every transfer reverts while paused.
contract PauseToken is ERC20Mock {
    bool public paused;

    function pause() external {
        paused = true;
    }

    function unpause() external {
        paused = false;
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        require(!paused, "paused");
        super._transfer(from, to, amount);
    }
}
