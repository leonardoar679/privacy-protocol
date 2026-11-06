// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAssetVault} from "./IAssetVault.sol";
import {VaultTypes} from "./VaultTypes.sol";
import {IPrivacyCore} from "../core/IPrivacyCore.sol";
import {CoreTypes} from "../core/CoreTypes.sol";
import {ReentrancyGuard} from "../utils/ReentrancyGuard.sol";

/// @title BaseAssetVault
/// @notice Shared vault logic (spec §7–8): immutable core binding, strict liability accounting,
/// core-only release, and the non-reverting claimable-fallback payout. Deliberately has NO owner,
/// admin, upgrade, rescue, changeToken, or changeCore.
abstract contract BaseAssetVault is IAssetVault, ReentrancyGuard {
    address public immutable core;
    uint256 public constant VAULT_VERSION = CoreTypes.VAULT_VERSION;

    /// Liabilities currently shielded in the pool (backed by assets held here).
    uint256 public accountedDeposits;
    /// Assets physically held but owed to a named recipient after a failed payout.
    uint256 public totalClaimable;
    mapping(address => uint256) public override claimable;

    modifier onlyCore() {
        if (msg.sender != core) revert VaultTypes.CallerNotCore();
        _;
    }

    constructor(address core_) {
        if (core_ == address(0)) revert VaultTypes.ZeroCore();
        core = core_;
    }

    function vaultId() public view returns (uint256) {
        return uint256(uint160(address(this)));
    }

    function actualAssetBalance() public view virtual returns (uint256);

    /// @notice Solvency: the vault physically holds at least what it owes (shielded + claimable).
    /// Unsolicited donations only make this *more* true and never become spendable liabilities.
    function isSolvent() external view returns (bool) {
        return actualAssetBalance() >= accountedDeposits + totalClaimable;
    }

    /// @inheritdoc IAssetVault
    function release(address recipient, uint256 amount) external onlyCore nonReentrant {
        if (amount == 0) revert VaultTypes.ZeroAmount();
        if (accountedDeposits < amount) revert VaultTypes.Undercollateralized();
        accountedDeposits -= amount; // effects before interaction (CEI)
        bool ok = _transferOut(recipient, amount);
        if (ok) {
            emit Released(recipient, amount);
        } else {
            // Payout failed (recipient reverts, or an issuer blacklist). Do NOT revert the completed
            // cryptographic state transition — book a claimable balance (spec §8.3).
            claimable[recipient] += amount;
            totalClaimable += amount;
            emit WithdrawalClaimCreated(recipient, amount);
        }
    }

    /// @inheritdoc IAssetVault
    function claim(address recipient) external nonReentrant {
        uint256 amt = claimable[recipient];
        if (amt == 0) revert VaultTypes.NothingToClaim();
        claimable[recipient] = 0;
        totalClaimable -= amt;
        if (!_claimOut(recipient, amt)) revert VaultTypes.ClaimTransferFailed(); // revert restores the claim
        emit Claimed(recipient, amt);
    }

    /// @dev The claim's payout (the eleventh review round, 2026-11-04, G11-2). The release's push is bounded so that a recipient cannot
    /// make the relayer's whole transact revert; a claim's caller pays its own gas and a failed claim reverts by itself, so the claim
    /// forwards it — under the release's bound, a recipient whose receive() honestly needs more was never paid, its funds held for good.
    /// claim() turns a false into a revert, which restores the obligation.
    function _claimOut(address recipient, uint256 amount) internal virtual returns (bool);

    function _commitDeposit(uint256 ownerCommitment, uint256 noteSecret, uint256 amount, bytes calldata noteData)
        internal
        returns (uint32)
    {
        return IPrivacyCore(core).commitDeposit(ownerCommitment, noteSecret, amount, noteData);
    }

    /// @dev The release's payout, bounded so that no recipient can make the relayer's whole transact revert. MUST NOT revert on an
    /// ordinary transfer failure — return false, and the release books the amount as claimable (the claim pays through `_claimOut`).
    function _transferOut(address recipient, uint256 amount) internal virtual returns (bool);
}
