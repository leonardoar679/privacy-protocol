// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAssetVault} from "../../src/vault/IAssetVault.sol";

/// @dev A withdrawal recipient that re-enters the vault from receive(): during release() it calls
/// claim() on itself, and during claim() it calls claim() again. Both must be blocked by the guard.
contract ReentrantRecipient {
    IAssetVault public immutable vault;
    uint256 public entries;

    constructor(IAssetVault v) {
        vault = v;
    }

    receive() external payable {
        entries++;
        vault.claim(address(this)); // re-entry: must revert, making the outer transfer fail
    }
}
