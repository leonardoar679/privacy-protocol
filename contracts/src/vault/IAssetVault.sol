// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IAssetVault
/// @notice One canonical vault holds exactly one asset (spec §7–8). The core holds nothing; it can
/// only ask a vault to release, and a vault only obeys its immutable core. A token issuer's freeze
/// can therefore only ever affect that token's own vault.
interface IAssetVault {
    event Deposited(bytes32 indexed ownerCommitment, uint256 amount, uint32 leafIndex);
    event Released(address indexed recipient, uint256 amount);
    event WithdrawalClaimCreated(address indexed recipient, uint256 amount);
    event Claimed(address indexed recipient, uint256 amount);

    function asset() external view returns (address); // address(0) == native ETH
    function core() external view returns (address);
    function vaultId() external view returns (uint256);
    function VAULT_VERSION() external view returns (uint256);

    function accountedDeposits() external view returns (uint256);
    function totalClaimable() external view returns (uint256);
    function claimable(address recipient) external view returns (uint256);
    function actualAssetBalance() external view returns (uint256);
    function isSolvent() external view returns (bool);

    /// @dev core-only; never reverts on a failed payout — it books a claimable balance instead
    /// (spec §8.3), so a reverting recipient cannot drain a relayer's gas (fixes TC-11).
    function release(address recipient, uint256 amount) external;

    /// @dev permissionless; push a previously-failed payout to its recipient.
    function claim(address recipient) external;
}
