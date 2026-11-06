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

    /// The gas an ETH payout hands its recipient (the fifth review round, 2026-11-03): a receive() that burnt all it was given — all
    /// but 1/64 of the transaction's remaining gas — left the vault too little for its claim bookkeeping, and the relayer's whole
    /// transact reverted at a tight gas limit, its gas paid and the user's nullifiers free to try again: repeatable griefing. A
    /// contract wallet needing more than this becomes claimable, the designed fallback.
    uint256 internal constant PUSH_GAS = 100_000;

    function _transferOut(address recipient, uint256 amount) internal override returns (bool) {
        (bool ok,) = payable(recipient).call{value: amount, gas: PUSH_GAS}("");
        return ok;
    }

    /// A claim forwards its caller's gas (G11-2): the bound above is for the release, whose relayer a recipient could otherwise grief.
    function _claimOut(address recipient, uint256 amount) internal override returns (bool) {
        (bool ok,) = payable(recipient).call{value: amount}("");
        return ok;
    }

    function actualAssetBalance() public view override returns (uint256) {
        return address(this).balance;
    }

    /// @dev Accept donations / forced value; these never create spendable liabilities.
    receive() external payable {}
}
