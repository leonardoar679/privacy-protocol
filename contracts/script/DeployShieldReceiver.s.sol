// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ShieldReceiverFactory} from "../src/periphery/shield/ShieldReceiverFactory.sol";

interface VmShield {
    function startBroadcast() external;
    function stopBroadcast() external;
    function toString(address) external pure returns (string memory);
    function envAddress(string calldata name) external view returns (address);
    function envOr(string calldata name, address defaultValue) external view returns (address);
}

interface ICoreVaultFactory {
    function VAULT_FACTORY() external view returns (address);
}

/// The shield receiver factory (Privacy Wallet Web spec v2.0 §11.2): deployed AFTER and INDEPENDENTLY of PrivacyCore,
/// which neither knows nor needs it. It holds two immutables — the pool's vault factory (read from the core here) and the
/// chain's wrapped native token — and nothing can be changed later: another pool is another factory, and the wallet's
/// deployment record names the one it uses (shieldFactory).
///
/// Dry run (no network):   CORE=0x… WRAPPED_NATIVE=0x… forge script script/DeployShieldReceiver.s.sol
/// Broadcast:              CORE=0x… WRAPPED_NATIVE=0x… forge script script/DeployShieldReceiver.s.sol --rpc-url $RPC --broadcast --verify
/// (WETH: mainnet 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2, Sepolia 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14)
contract DeployShieldReceiver {
    VmShield internal constant vm = VmShield(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external {
        address core = vm.envAddress("CORE");
        address wrappedNative = vm.envOr("WRAPPED_NATIVE", address(0));
        address vaultFactory = ICoreVaultFactory(core).VAULT_FACTORY();
        vm.startBroadcast();
        ShieldReceiverFactory f = new ShieldReceiverFactory(vaultFactory, wrappedNative);
        vm.stopBroadcast();

        _log("ShieldReceiverFactory", vm.toString(address(f)));
        _log("VAULT_FACTORY (read from the core)", vm.toString(f.VAULT_FACTORY()));
        _log("WRAPPED_NATIVE", vm.toString(f.WRAPPED_NATIVE()));
        _log("deployment record", string.concat("shieldFactory=", vm.toString(address(f))));
    }

    function _log(string memory what, string memory v) internal view {
        (bool ok,) = address(0x000000000000000000636F6e736F6c652e6c6f67).staticcall(abi.encodeWithSignature("log(string,string)", what, v));
        ok;
    }
}
