// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Records the gas its receive() was handed; burns all of it when told to (a recipient out to make the payout's transaction run dry).
contract GasProbe {
    uint256 public seen;
    bool public burn;

    function setBurn(bool b) external {
        burn = b;
    }

    receive() external payable {
        seen = gasleft();
        if (burn) {
            while (true) {}
        }
    }
}
