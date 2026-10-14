// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ProtectRouter} from "../src/periphery/protect/ProtectRouter.sol";

interface VmProtect {
    function startBroadcast() external;
    function stopBroadcast() external;
    function toString(address) external pure returns (string memory);
    function toString(uint256) external pure returns (string memory);
    function envAddress(string calldata name) external view returns (address);
}

/// The protect router (Privacy Wallet Web spec v2.0 §3, §11.1): deployed AFTER and INDEPENDENTLY of PrivacyCore, which
/// neither knows nor needs it. It reads the vault factory from the core at construction and holds three immutables
/// (CORE, VAULT_FACTORY, FEE_RECIPIENT) and the constant FEE_BPS = 100; nothing can be changed later — another fee or
/// another recipient is another router, and the wallet's deployment record names the one it uses (protectRouter).
///
/// Dry run (no network):   CORE=0x… FEE_RECIPIENT=0x… forge script script/DeployProtectRouter.s.sol
/// Broadcast:              CORE=0x… FEE_RECIPIENT=0x… forge script script/DeployProtectRouter.s.sol --rpc-url $RPC --broadcast --verify
contract DeployProtectRouter {
    VmProtect internal constant vm = VmProtect(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external {
        address core = vm.envAddress("CORE");
        address feeRecipient = vm.envAddress("FEE_RECIPIENT");
        vm.startBroadcast();
        ProtectRouter router = new ProtectRouter(core, feeRecipient);
        vm.stopBroadcast();

        _log("ProtectRouter", vm.toString(address(router)));
        _log("CORE", vm.toString(router.CORE()));
        _log("VAULT_FACTORY (read from the core)", vm.toString(router.VAULT_FACTORY()));
        _log("FEE_RECIPIENT", vm.toString(router.FEE_RECIPIENT()));
        _log("FEE_BPS", vm.toString(router.FEE_BPS()));
        _log("deployment record", string.concat("protectRouter=", vm.toString(address(router))));
    }

    function _log(string memory what, string memory v) internal view {
        (bool ok,) = address(0x000000000000000000636F6e736F6c652e6c6f67).staticcall(abi.encodeWithSignature("log(string,string)", what, v));
        ok;
    }
}
