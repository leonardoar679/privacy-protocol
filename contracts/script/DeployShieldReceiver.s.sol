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
        // the chain's own by default, as the swap periphery's script takes it, and never none off a devnet (the eleventh review round,
        // 2026-11-04, G11-6): a factory built on none let anyone sweep an ETH receipt's WETH to the public fallback, the receiver's own rule
        // undone, while every check passed
        address wrappedNative = _wrappedNativeOrRefuse();
        address vaultFactory = ICoreVaultFactory(core).VAULT_FACTORY();
        vm.startBroadcast();
        ShieldReceiverFactory f = new ShieldReceiverFactory(vaultFactory, wrappedNative);
        vm.stopBroadcast();

        _log("ShieldReceiverFactory", vm.toString(address(f)));
        _log("VAULT_FACTORY (read from the core)", vm.toString(f.VAULT_FACTORY()));
        _log("WRAPPED_NATIVE", vm.toString(f.WRAPPED_NATIVE()));
        _log("deployment record", string.concat("shieldFactory=", vm.toString(address(f))));
    }

    /// WRAPPED_NATIVE, else the chain's own; none only on a devnet.
    function _wrappedNativeOrRefuse() internal view returns (address) {
        return _checkedWrappedNative(_envWrappedNative());
    }

    /// The operator's WRAPPED_NATIVE, else the chain's own. Virtual: a test names an override without the process-wide environment, which
    /// forge's parallel tests share (the third critique of slice 5: the run path with an override had no test).
    function _envWrappedNative() internal view virtual returns (address) {
        return vm.envOr("WRAPPED_NATIVE", _wrappedNative());
    }

    /// The token taken: none only on a devnet, and where the wallet pins one (mainnet, Sepolia) that one alone — the second critique of
    /// slice 5: an override the wallet's deployment check refuses had deployed an immutable factory, refused only at the first money
    /// operation.
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
