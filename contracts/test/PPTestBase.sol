// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "./utils/MiniTest.sol";
import {PrivacyCore} from "../src/core/PrivacyCore.sol";
import {CoreTypes} from "../src/core/CoreTypes.sol";
import {AssetVaultFactory} from "../src/factory/AssetVaultFactory.sol";
import {NativeAssetVault} from "../src/vault/NativeAssetVault.sol";
import {ERC20AssetVault} from "../src/vault/ERC20AssetVault.sol";
import {FieldLib} from "../src/libraries/FieldLib.sol";
import {MockHasher} from "./mocks/MockHasher.sol";
import {MockVerifier} from "./mocks/MockVerifier.sol";

/// @dev Shared deployment + PublicInputs builders for the mock-based suites. A small tree
/// (LEVELS=10) keeps tests fast; production uses depth 32 (spec §9).
abstract contract PPTestBase is Test {
    uint256 internal constant FIELD = FieldLib.FIELD_SIZE;
    uint256 internal constant LEVELS = 10;
    uint256 internal constant NOTE_DATA_BYTES = CoreTypes.NOTE_DATA_BYTES;

    MockHasher internal hasher;
    MockVerifier internal verifier;
    PrivacyCore internal core;
    AssetVaultFactory internal factory;
    NativeAssetVault internal nativeVault;

    function _deployCore() internal {
        hasher = new MockHasher();
        verifier = new MockVerifier();
        core = new PrivacyCore(verifier, hasher, LEVELS);
        factory = AssetVaultFactory(core.VAULT_FACTORY());
        nativeVault = NativeAssetVault(payable(factory.getOrCreateNativeVault()));
        vm.roll(1_000); // realistic nonzero block for the root-history window
    }

    /// A fixed-size output payload (spec §12); content is irrelevant to the core.
    function _noteData(uint256 seed) internal pure returns (bytes memory d) {
        d = new bytes(NOTE_DATA_BYTES);
        for (uint256 i; i < NOTE_DATA_BYTES; ++i) {
            d[i] = bytes1(uint8(uint256(keccak256(abi.encode(seed, i / 32))) >> (8 * (i % 32))));
        }
    }

    function _ndHash(bytes memory b) internal view returns (uint256) {
        return core.noteDataHash(b);
    }

    function _depositNative(address from, uint256 amount, uint256 ownerCommitment) internal {
        vm.deal(from, from.balance + amount);
        vm.prank(from);
        nativeVault.deposit{value: amount}(ownerCommitment, ownerCommitment + 1, _noteData(ownerCommitment));
    }

    function _depositERC20(ERC20AssetVault vault, address from, uint256 amount, uint256 ownerCommitment) internal {
        vm.prank(from);
        vault.deposit(amount, ownerCommitment, ownerCommitment + 1, _noteData(ownerCommitment));
    }

    function _basePI(uint256 n0, uint256 n1) internal view returns (CoreTypes.PublicInputs memory pi) {
        pi.root = uint256(core.currentRoot());
        pi.nullifier0 = n0;
        pi.nullifier1 = n1;
        pi.outputBody0 = 1;
        pi.outputBody1 = 2;
        pi.outputBody2 = 3;
        pi.noteData0Hash = _ndHash(_noteData(0));
        pi.noteData1Hash = _ndHash(_noteData(1));
        pi.noteData2Hash = _ndHash(_noteData(2));
        pi.txDomain = core.TX_DOMAIN();
    }

    function _withdrawPI(address vault, address recipient, uint256 amount, uint256 n0, uint256 n1)
        internal
        view
        returns (CoreTypes.PublicInputs memory pi)
    {
        pi = _basePI(n0, n1);
        pi.mode = CoreTypes.MODE_WITHDRAW;
        pi.withdrawalVault = uint256(uint160(vault));
        pi.withdrawalAmount = amount;
        pi.withdrawalRecipient = uint256(uint160(recipient));
    }

    function _transferPI(uint256 n0, uint256 n1, uint256 o0, uint256 o1, uint256 o2)
        internal
        view
        returns (CoreTypes.PublicInputs memory pi)
    {
        pi = _basePI(n0, n1);
        pi.outputBody0 = o0;
        pi.outputBody1 = o1;
        pi.outputBody2 = o2;
    }

    function _accept(CoreTypes.PublicInputs memory pi) internal {
        verifier.setAccepted(core.encodePublicInputs(pi), true);
    }

    function _transactRaw(CoreTypes.PublicInputs memory pi) internal {
        core.transact("", pi, _noteData(0), _noteData(1), _noteData(2));
    }

    function _transact(CoreTypes.PublicInputs memory pi) internal {
        _accept(pi);
        _transactRaw(pi);
    }
}
