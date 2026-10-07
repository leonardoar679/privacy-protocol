// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PrivacyCore} from "../src/core/PrivacyCore.sol";
import {IHasher} from "../src/libraries/IHasher.sol";
import {Poseidon2Hasher} from "../src/hasher/Poseidon2Hasher.sol";
import {Groth16Verifier, ITransactionGroth16Verifier} from "../src/verifier/Groth16Verifier.sol";
import {IProofVerifier} from "../src/verifier/IProofVerifier.sol";
import {AssetVaultFactory} from "../src/factory/AssetVaultFactory.sol";
import {TransactionVerifierDev} from "../src/verifier/dev/TransactionVerifierDev.sol";

interface VmDeploy {
    function startBroadcast() external;
    function stopBroadcast() external;
    function envOr(string calldata, address) external view returns (address);
    function envOr(string calldata, bool) external view returns (bool);
    function toString(address) external pure returns (string memory);
}

/// Deployment sequence (spec §18). Deployment 1: the ceremony's Groth16 verifier -> adapter ->
/// Poseidon2 hasher -> PrivacyCore (which deploys its own factory) -> the ETH vault. Deployment 2
/// (V1.1): USDC / USDT vaults through the factory. Everything is immutable from the first block.
///
///   INNER_VERIFIER  address of the snarkjs-generated verifier produced by the CEREMONY. Never the dev
///                   verifier: it is insecure by design and this script refuses an unset value.
///   USDC / USDT     optional; when set, their canonical vaults are created too.
///   DEV_VERIFIER=true   local dry runs only: deploys the INSECURE dev verifier instead. Hard-gated to
///                   chain id 31337, so it cannot be broadcast to a real network by mistake.
///   SEPOLIA_DEV_VERIFIER=true   testnet rehearsals (docs/testnet.md): the same INSECURE dev verifier,
///                   hard-gated to Sepolia (11155111). Never a production path.
///
/// Dry run (no network):   DEV_VERIFIER=true forge script script/Deploy.s.sol
/// Sepolia rehearsal:      SEPOLIA_DEV_VERIFIER=true forge script script/Deploy.s.sol --rpc-url $SEPOLIA --broadcast
/// Broadcast:              INNER_VERIFIER=0x… forge script script/Deploy.s.sol --rpc-url $RPC --broadcast --verify
contract Deploy {
    VmDeploy internal constant vm = VmDeploy(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant LEVELS = 32; // the circuit's depth

    function run() external {
        address inner = vm.envOr("INNER_VERIFIER", address(0));
        bool dev = vm.envOr("DEV_VERIFIER", false);
        bool sepoliaDev = vm.envOr("SEPOLIA_DEV_VERIFIER", false);
        require(!dev || block.chainid == 31337, "DEV_VERIFIER is for local dry runs only (chain id 31337)");
        require(!sepoliaDev || block.chainid == 11155111, "SEPOLIA_DEV_VERIFIER is for Sepolia only (chain id 11155111)");
        dev = dev || sepoliaDev;

        vm.startBroadcast();
        if (dev) inner = address(new TransactionVerifierDev());
        require(inner.code.length != 0, "INNER_VERIFIER must be the deployed ceremony verifier");
        IProofVerifier verifier = new Groth16Verifier(ITransactionGroth16Verifier(inner));
        IHasher hasher = new Poseidon2Hasher();
        PrivacyCore core = new PrivacyCore(verifier, hasher, LEVELS);
        AssetVaultFactory factory = AssetVaultFactory(core.VAULT_FACTORY());
        address ethVault = factory.getOrCreateNativeVault();

        address usdc = vm.envOr("USDC", address(0));
        address usdt = vm.envOr("USDT", address(0));
        address usdcVault = usdc != address(0) ? factory.getOrCreateERC20Vault(usdc) : address(0);
        address usdtVault = usdt != address(0) ? factory.getOrCreateERC20Vault(usdt) : address(0);
        vm.stopBroadcast();

        // Verification artifacts (spec §18): publish with the source, build settings and ABIs.
        _log("Groth16Verifier (adapter)", address(verifier));
        _log("Poseidon2Hasher", address(hasher));
        _log("PrivacyCore", address(core));
        _log("AssetVaultFactory", address(factory));
        _log("NativeAssetVault (ETH)", ethVault);
        if (usdcVault != address(0)) _log("ERC20AssetVault (USDC)", usdcVault);
        if (usdtVault != address(0)) _log("ERC20AssetVault (USDT)", usdtVault);
    }

    function _log(string memory what, address a) internal view {
        (bool ok,) = address(0x000000000000000000636F6e736F6c652e6c6f67).staticcall(
            abi.encodeWithSignature("log(string,string)", what, vm.toString(a))
        );
        ok;
    }
}
