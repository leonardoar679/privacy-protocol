// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseAssetVault} from "./BaseAssetVault.sol";
import {VaultTypes} from "./VaultTypes.sol";
import {IERC20} from "./IERC20.sol";

/// @title ERC20AssetVault
/// @notice Canonical vault for exactly one ERC-20 (spec §8.2). Strict balance-delta accounting, so
/// fee-on-transfer / rebasing / reflection tokens are rejected (not silently mis-accounted, fixing
/// Nova's TC-19) and a direct token donation never becomes a liability.
contract ERC20AssetVault is BaseAssetVault {
    address public immutable asset;

    constructor(address core_, address token_) BaseAssetVault(core_) {
        if (token_ == address(0)) revert VaultTypes.ZeroToken();
        asset = token_;
    }

    /// @notice Shield `amount` of the token. Reverts unless the vault's balance rose by EXACTLY
    /// `amount` (rejects fee-on-transfer / rebasing).
    function deposit(uint256 amount, uint256 ownerCommitment, uint256 noteSecret, bytes calldata noteData)
        external
        nonReentrant
        returns (uint32 leafIndex)
    {
        if (amount == 0) revert VaultTypes.ZeroAmount();
        uint256 balBefore = IERC20(asset).balanceOf(address(this));
        _strictTransferFrom(msg.sender, address(this), amount);
        uint256 balAfter = IERC20(asset).balanceOf(address(this));
        if (balAfter - balBefore != amount) revert VaultTypes.UnsupportedTokenBehavior();
        accountedDeposits += amount;
        leafIndex = _commitDeposit(ownerCommitment, noteSecret, amount, noteData);
        emit Deposited(bytes32(ownerCommitment), amount, leafIndex);
    }

    function actualAssetBalance() public view override returns (uint256) {
        return IERC20(asset).balanceOf(address(this));
    }

    function _transferOut(address recipient, uint256 amount) internal override returns (bool) {
        return _softTransfer(recipient, amount);
    }

    /// @dev Strict: revert on a reverting token, a `false` return, or a non-standard return shape.
    /// Used on the deposit path so a bad token can never create a phantom liability.
    function _strictTransferFrom(address from, address to, uint256 amount) internal {
        (bool success, bytes memory data) =
            asset.call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount));
        if (!success || !(data.length == 0 || (data.length == 32 && abi.decode(data, (bool))))) {
            revert VaultTypes.TokenTransferFailed();
        }
    }

    /// @dev Soft: never reverts; returns false on any failure so release() can fall back to
    /// claimable. A blacklisted recipient simply yields a claimable obligation. A 32-byte answer is read as a word, not a bool
    /// (the fifth review round, 2026-11-03): `abi.decode(data, (bool))` reverted on a word that is neither 0 nor 1 — a token
    /// answering with a status code or the amount, as an upgraded one may start to —, and the whole transact with it, after a
    /// valid proof, for every recipient of that asset. A non-zero word means the transfer went through (the token moved the funds;
    /// `true` is 1), zero means it did not.
    function _softTransfer(address to, uint256 amount) internal returns (bool) {
        (bool success, bytes memory data) =
            asset.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        return success && (data.length == 0 || (data.length == 32 && abi.decode(data, (uint256)) != 0));
    }
}
