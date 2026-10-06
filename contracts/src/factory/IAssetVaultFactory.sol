// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IAssetVaultFactory — frozen factory ABI (spec §7.2, §14)
interface IAssetVaultFactory {
    event VaultDeployed(address indexed asset, address vault);

    error VaultExists();
    error ZeroToken();
    error ZeroCore();

    function CORE() external view returns (address);
    function vaultOf(address asset) external view returns (address); // address(0) = native ETH
    function isCanonical(address vault) external view returns (bool);

    function getOrCreateNativeVault() external returns (address);
    function getOrCreateERC20Vault(address token) external returns (address);

    function predictNativeVault() external view returns (address);
    function predictERC20Vault(address token) external view returns (address);
}
