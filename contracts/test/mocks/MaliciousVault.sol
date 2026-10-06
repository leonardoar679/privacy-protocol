// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPrivacyCore} from "../../src/core/IPrivacyCore.sol";

/// @dev A hand-rolled "vault" that reports the right core and asset and tries to (a) register notes
/// it never funded and (b) be used as a withdrawal vault. Both must fail: the core authorizes vaults
/// purely by factory canonicality, never by what a contract claims about itself.
contract MaliciousVault {
    address public immutable core;
    address public immutable asset;

    constructor(address core_, address asset_) {
        core = core_;
        asset = asset_;
    }

    function fakeDeposit(uint256 ownerCommitment, uint256 noteSecret, uint256 amount, bytes calldata noteData)
        external
        returns (uint32)
    {
        return IPrivacyCore(core).commitDeposit(ownerCommitment, noteSecret, amount, noteData);
    }

    function release(address, uint256) external pure {}
}
