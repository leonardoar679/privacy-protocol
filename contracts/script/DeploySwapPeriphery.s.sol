// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SwapOrderFactory} from "../src/periphery/swap/SwapOrderFactory.sol";
import {SwapOrderEscrow} from "../src/periphery/swap/SwapOrderEscrow.sol";

interface VmPeriphery {
    function startBroadcast() external;
    function stopBroadcast() external;
    function toString(address) external pure returns (string memory);
    function toString(bytes32) external pure returns (string memory);
    function envOr(string calldata name, address defaultValue) external view returns (address);
}

/// Private-swap periphery (spec v1.1 §11, plan step 19): one permissionless, ownerless, stateless
/// CREATE2 factory for SwapOrderEscrow. It is deployed AFTER and INDEPENDENTLY of PrivacyCore — the
/// core neither knows nor needs it (plan §85 rules 2–4, 10). Nothing here is upgradeable; a new
/// escrow version is a new factory, and old orders keep their old escrows.
///
/// The engine (packages/swap-engine) needs two values from this run: the factory address
/// (SWAP_FACTORY) and the escrow creation-code hash, which must equal keccak256 of the `bytecode`
/// in contracts/abi/periphery/SwapOrderEscrow.json — the address prediction in endpoints.ts is only
/// valid for that exact creation code.
///
/// The factory takes the chain's wrapped native token: on mainnet and Sepolia that chain's own WETH (WETH9, Sepolia's WETH) and no
/// other — an override is refused, as the wallet's deployment check refuses it; on another chain WRAPPED_NATIVE names it, and none is
/// taken on a devnet (chain id 31337) only. Escrows unwrap a wrapped refund of an ETH order before re-shielding it.
///
/// Dry run (no network):   forge script script/DeploySwapPeriphery.s.sol
/// Broadcast:              forge script script/DeploySwapPeriphery.s.sol --rpc-url $RPC --broadcast --verify
contract DeploySwapPeriphery {
    VmPeriphery internal constant vm = VmPeriphery(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external {
        address wrappedNative = _wrappedNativeOrRefuse();
        vm.startBroadcast();
        SwapOrderFactory factory = new SwapOrderFactory(wrappedNative);
        vm.stopBroadcast();

        _log("SwapOrderFactory", vm.toString(address(factory)));
        _log("wrapped native (escrows unwrap refunds paid in it)", vm.toString(wrappedNative));
        _log("SwapOrderEscrow creationCode keccak256", vm.toString(keccak256(type(SwapOrderEscrow).creationCode)));
        _log("engine env", string.concat("SWAP_FACTORY=", vm.toString(address(factory))));
    }

    /// WRAPPED_NATIVE, else the chain's own; none only on a devnet (the eleventh review round's first critique of slice 5): the wallet's
    /// deployment check refuses a swap factory built on none off a devnet — refused here first, before an immutable factory exists.
    function _wrappedNativeOrRefuse() internal view returns (address) {
        return _checkedWrappedNative(_envWrappedNative());
    }

    /// The operator's WRAPPED_NATIVE, else the chain's own; virtual for the tests, as DeployShieldReceiver.s.sol's.
    function _envWrappedNative() internal view virtual returns (address) {
        return vm.envOr("WRAPPED_NATIVE", _wrappedNative());
    }

    /// The token taken: none only on a devnet, and where the wallet pins one (mainnet, Sepolia) that one alone (the second critique of
    /// slice 5), as DeployShieldReceiver.s.sol takes it.
    function _checkedWrappedNative(address w) internal view returns (address) {
        require(w != address(0) || block.chainid == 31337, "WRAPPED_NATIVE: the chain's wrapped native token (none only on a devnet, chain id 31337)");
        address own = _wrappedNative();
        require(own == address(0) || w == own, "WRAPPED_NATIVE: on mainnet and Sepolia only the chain's own WETH, as the wallet's deployment check requires");
        return w;
    }

    function _wrappedNative() internal view returns (address) {
        if (block.chainid == 1) return 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2; // WETH9
        if (block.chainid == 11155111) return 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14; // Sepolia WETH ("Wrapped Ether")
        return address(0);
    }

    function _log(string memory what, string memory v) internal view {
        (bool ok,) = address(0x000000000000000000636F6e736F6c652e6c6f67).staticcall(abi.encodeWithSignature("log(string,string)", what, v));
        ok;
    }
}
