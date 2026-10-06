// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal ERC-20 surface the vault needs. Return values are handled defensively in
/// ERC20AssetVault (strict on deposit, soft on payout), so non-standard tokens are rejected or
/// isolated rather than trusted.
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}
