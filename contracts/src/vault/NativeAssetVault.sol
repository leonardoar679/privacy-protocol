// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseAssetVault} from "./BaseAssetVault.sol";
import {VaultTypes} from "./VaultTypes.sol";

/// @title NativeAssetVault
/// @notice Canonical vault for native ETH — the primary V1 asset; it has no issuer-level freeze.
/// `asset()` is address(0) (the factory's native sentinel).
contract NativeAssetVault is BaseAssetVault {
    constructor(address core_) BaseAssetVault(core_) {}

    function asset() external pure returns (address) {
        return address(0);
    }

    /// @notice Shield ETH: the exact msg.value becomes a shielded note; no issuer can block it.
    function deposit(uint256 ownerCommitment, uint256 noteSecret, bytes calldata noteData)
        external
        payable
        nonReentrant
        returns (uint32 leafIndex)
    {
        uint256 amount = msg.value;
        if (amount == 0) revert VaultTypes.ZeroAmount();
        accountedDeposits += amount;
        leafIndex = _commitDeposit(ownerCommitment, noteSecret, amount, noteData);
        emit Deposited(bytes32(ownerCommitment), amount, leafIndex);
    }

    function _transferOut(address recipient, uint256 amount) internal override returns (bool) {
        (bool ok,) = payable(recipient).call{value: amount}("");
        return ok;
    }

    function actualAssetBalance() public view override returns (uint256) {
        return address(this).balance;
    }

    /// @dev Accept donations / forced value; these never create spendable liabilities.
    receive() external payable {}
}
