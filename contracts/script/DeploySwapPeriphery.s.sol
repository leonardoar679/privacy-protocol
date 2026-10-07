// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SwapOrderFactory} from "../src/periphery/swap/SwapOrderFactory.sol";
import {SwapOrderEscrow} from "../src/periphery/swap/SwapOrderEscrow.sol";

interface VmPeriphery {
    function startBroadcast() external;
    function stopBroadcast() external;
    function toString(address) external pure returns (string memory);
    function toString(bytes32) external pure returns (string memory);
}

/// Private-swap periphery (spec v1.1 §11, plan step 19): one permissionless, ownerless, stateless
/// CREATE2 factory for SwapOrderEscrow. It is deployed AFTER and INDEPENDENTLY of PrivacyCore — the
/// core neither knows nor needs it (plan §85 rules 2–4, 10). Nothing here is upgradeable; a new
/// escrow version is a new factory, and old orders keep their old escrows.
///
/// The engine (services/private-swap) needs two values from this run: the factory address
/// (SWAP_FACTORY) and the escrow creation-code hash, which must equal keccak256 of the `bytecode`
/// in contracts/abi/periphery/SwapOrderEscrow.json — the address prediction in endpoints.ts is only
/// valid for that exact creation code.
///
/// Dry run (no network):   forge script script/DeploySwapPeriphery.s.sol
/// Broadcast:              forge script script/DeploySwapPeriphery.s.sol --rpc-url $RPC --broadcast --verify
contract DeploySwapPeriphery {
    VmPeriphery internal constant vm = VmPeriphery(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external {
        vm.startBroadcast();
        SwapOrderFactory factory = new SwapOrderFactory();
        vm.stopBroadcast();

        _log("SwapOrderFactory", vm.toString(address(factory)));
        _log("SwapOrderEscrow creationCode keccak256", vm.toString(keccak256(type(SwapOrderEscrow).creationCode)));
        _log("engine env", string.concat("SWAP_FACTORY=", vm.toString(address(factory))));
    }

    function _log(string memory what, string memory v) internal view {
        (bool ok,) = address(0x000000000000000000636F6e736F6c652e6c6f67).staticcall(abi.encodeWithSignature("log(string,string)", what, v));
        ok;
    }
}
