// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAssetVaultFactory} from "./IAssetVaultFactory.sol";
import {NativeAssetVault} from "../vault/NativeAssetVault.sol";
import {ERC20AssetVault} from "../vault/ERC20AssetVault.sol";

/// @title AssetVaultFactory
/// @notice Deploys exactly ONE canonical vault per asset via CREATE2 (spec §7.2). Permissionless and
/// ownerless: there is no admin, and the mapping enforces one-vault-per-asset so an asset's
/// anonymity/liquidity set is never fragmented across rival vaults. The core authorizes vault
/// callers purely by `isCanonical`, so a hand-rolled fake vault (even one reporting the same
/// token/core) is rejected. ETH uses the address(0) sentinel.
/// salt = keccak256(abi.encode(chainId, assetType, token)), assetType 0 = NATIVE, 1 = ERC20.
contract AssetVaultFactory is IAssetVaultFactory {
    uint8 public constant ASSET_TYPE_NATIVE = 0;
    uint8 public constant ASSET_TYPE_ERC20 = 1;

    address public immutable CORE;

    mapping(address => address) public vaultOf; // asset (address(0)=native) => canonical vault
    mapping(address => bool) public isCanonical; // vault => is a factory-deployed canonical vault

    constructor(address core_) {
        if (core_ == address(0)) revert ZeroCore();
        CORE = core_;
    }

    function salt(uint8 assetType, address token) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, assetType, token));
    }

    function getOrCreateNativeVault() external returns (address v) {
        v = vaultOf[address(0)];
        if (v != address(0)) return v;
        v = address(new NativeAssetVault{salt: salt(ASSET_TYPE_NATIVE, address(0))}(CORE));
        vaultOf[address(0)] = v;
        isCanonical[v] = true;
        emit VaultDeployed(address(0), v);
    }

    function getOrCreateERC20Vault(address token) external returns (address v) {
        if (token == address(0)) revert ZeroToken();
        v = vaultOf[token];
        if (v != address(0)) return v;
        v = address(new ERC20AssetVault{salt: salt(ASSET_TYPE_ERC20, token)}(CORE, token));
        vaultOf[token] = v;
        isCanonical[v] = true;
        emit VaultDeployed(token, v);
    }

    /// @notice Deterministically predict the canonical vault addresses before deployment, so a
    /// wallet can derive them independently of any registry.
    function predictNativeVault() external view returns (address) {
        bytes32 initHash = keccak256(abi.encodePacked(type(NativeAssetVault).creationCode, abi.encode(CORE)));
        return _predict(salt(ASSET_TYPE_NATIVE, address(0)), initHash);
    }

    function predictERC20Vault(address token) external view returns (address) {
        bytes32 initHash =
            keccak256(abi.encodePacked(type(ERC20AssetVault).creationCode, abi.encode(CORE, token)));
        return _predict(salt(ASSET_TYPE_ERC20, token), initHash);
    }

    function _predict(bytes32 s, bytes32 initHash) private view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), s, initHash)))));
    }
}
