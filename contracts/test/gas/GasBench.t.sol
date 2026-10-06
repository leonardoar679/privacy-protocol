// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "../utils/MiniTest.sol";
import {PrivacyCore} from "../../src/core/PrivacyCore.sol";
import {CoreTypes} from "../../src/core/CoreTypes.sol";
import {AssetVaultFactory} from "../../src/factory/AssetVaultFactory.sol";
import {NativeAssetVault} from "../../src/vault/NativeAssetVault.sol";
import {Poseidon2Hasher} from "../../src/hasher/Poseidon2Hasher.sol";
import {MockVerifier} from "../mocks/MockVerifier.sol";

/// Steady-state gas of the production configuration (real Poseidon2, depth 32). The verifier is
/// mocked here so many transactions can run; add the separately measured real verification cost
/// (Groth16RealProofTest: ~285k) to `transact`. Numbers are consumed by benchmarks/gas/cost.mjs.
/// Run: forge test --match-contract GasBench -vv
contract GasBenchTest is Test {
    PrivacyCore internal core;
    NativeAssetVault internal vault;
    MockVerifier internal verifier;
    address internal alice = address(0xA11CE);
    uint256 internal n = 1;
    bytes internal noteData = new bytes(CoreTypes.NOTE_DATA_BYTES);

    function setUp() public {
        verifier = new MockVerifier();
        verifier.setAcceptAll(true);
        core = new PrivacyCore(verifier, new Poseidon2Hasher(), 32);
        vault = NativeAssetVault(payable(AssetVaultFactory(core.VAULT_FACTORY()).getOrCreateNativeVault()));
        vm.deal(alice, 1000 ether);
        vm.roll(1_000);
    }

    function _deposit() internal returns (uint256 gas) {
        vm.prank(alice);
        uint256 g0 = gasleft();
        vault.deposit{value: 1 ether}(n++, n++, noteData);
        gas = g0 - gasleft();
    }

    function _withdraw() internal returns (uint256 gas) {
        CoreTypes.PublicInputs memory pi;
        pi.root = uint256(core.currentRoot());
        pi.nullifier0 = n++;
        pi.nullifier1 = n++;
        pi.outputBody0 = n++;
        pi.outputBody1 = n++;
        pi.outputBody2 = n++;
        pi.mode = 1;
        pi.withdrawalVault = uint256(uint160(address(vault)));
        pi.withdrawalAmount = 0.5 ether;
        pi.withdrawalRecipient = uint256(uint160(address(0xB0B)));
        uint256 h = core.noteDataHash(noteData);
        pi.noteData0Hash = h;
        pi.noteData1Hash = h;
        pi.noteData2Hash = h;
        pi.txDomain = core.TX_DOMAIN();
        uint256 g0 = gasleft();
        core.transact("", pi, noteData, noteData, noteData);
        gas = g0 - gasleft();
    }

    function test_SteadyStateGas() public {
        uint256 firstDeposit = _deposit();
        uint256 firstTx = _withdraw();
        uint256 dep;
        uint256 tx_;
        for (uint256 i; i < 8; ++i) {
            dep += _deposit();
            tx_ += _withdraw();
        }
        log("deposit   first (cold tree)          ", firstDeposit);
        log("deposit   steady-state (avg of 8)    ", dep / 8);
        log("transact  first (cold tree, mock vfy)", firstTx);
        log("transact  steady-state (mock verify) ", tx_ / 8);
        assertTrue(dep / 8 < firstDeposit && tx_ / 8 < firstTx, "steady state is cheaper than the cold first call");
    }
}
