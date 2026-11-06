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

    /// The gas a release hands the token's transfer (the eleventh review round, G11-5), as the ETH push is bounded: a token that calls the
    /// recipient (an ERC-777 tokensReceived hook, ERC-223) let a recipient burn all it was given, the vault left 1/64 for its claim
    /// bookkeeping and the relayer's whole transact reverted — the griefing the fifth round closed for ETH. A transfer that needs more
    /// becomes claimable; the claim forwards its caller's gas.
    uint256 internal constant TOKEN_PUSH_GAS = 300_000;

    function _transferOut(address recipient, uint256 amount) internal override returns (bool) {
        return _softTransfer(recipient, amount, TOKEN_PUSH_GAS);
    }

    function _claimOut(address recipient, uint256 amount) internal override returns (bool) {
        return _softTransfer(recipient, amount, gasleft());
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

    /// @dev Soft: never reverts on the token's answer; returns false on any failure so the release can fall back to claimable. A
    /// blacklisted recipient simply yields a claimable obligation. Paid is what the vault's own balance says (the eleventh review round,
    /// G11-3): the token's answer is not read at all — the fifth round had read any non-zero word as paid, and a status-code token (0 =
    /// done, non-zero = an error, nothing moved) answers non-zero exactly when it refused, the payout then booked as Released with nothing
    /// paid; a word that is neither 0 nor 1 never reverts the transact either. Paid when the balance FELL, by anything: a payout is a claim
    /// only when nothing left. A partial hand-back during the call is never read as unpaid — a hook token's recipient that
    /// hands one unit back would otherwise keep the payout and be booked its claim too, paid twice from the other depositors' tokens (the
    /// round's first critique of slice 5). A recipient's whole take stays at most `amount` whatever it hands back: one unit back, the
    /// payout stands; all of it back, the claim pays it once. A token that moves less than asked and answers success shorts its own
    /// recipient, never the vault (fee-on-transfer and rebasing tokens were refused at the deposit).
    function _softTransfer(address to, uint256 amount, uint256 gasLimit) internal returns (bool) {
        uint256 balBefore = IERC20(asset).balanceOf(address(this));
        (bool success,) = asset.call{gas: gasLimit}(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!success) return false;
        return IERC20(asset).balanceOf(address(this)) < balBefore;
    }
}
