// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "../utils/MiniTest.sol";
import {PrivacyCore} from "../../src/core/PrivacyCore.sol";
import {CoreTypes} from "../../src/core/CoreTypes.sol";
import {AssetVaultFactory} from "../../src/factory/AssetVaultFactory.sol";
import {NativeAssetVault} from "../../src/vault/NativeAssetVault.sol";
import {Poseidon2Hasher} from "../../src/hasher/Poseidon2Hasher.sol";
import {Groth16Verifier, ITransactionGroth16Verifier} from "../../src/verifier/Groth16Verifier.sol";
import {TransactionVerifierDev} from "../../src/verifier/dev/TransactionVerifierDev.sol";
import {E2EFixture as F} from "./E2EFixture.sol";

/// END-TO-END, nothing mocked: Poseidon2 on-chain over a depth-32 tree, the snarkjs Groth16 verifier,
/// and real proofs of circuits/transaction.circom whose witnesses the wallet reference built against
/// THIS deployment.
///   tx1  Alice shields 1 ETH, then privately withdraws 0.6 ETH to a fresh recipient, keeps 0.35 ETH as
///        a shielded change note and pays a 0.05 ETH **private relayer-fee note** (plan §49, §76).
///   tx2  The relayer spends its fee note and withdraws 0.05 ETH to its own address — no relayer
///        address or fee ever appears in tx1.
/// The proofs bind the vault's address, so a change that moves it needs new fixtures:
/// circuits/scripts/e2e-fixture.sh.
contract RealProofE2ETest is Test {
    uint256 internal constant LEVELS = 32; // must equal the circuit's tree depth

    PrivacyCore internal core;
    NativeAssetVault internal vault;
    address internal alice = address(0xA11CE);
    address internal recipient = address(uint160(F.RECIPIENT));
    address internal relayer = address(uint160(F.RELAYER));

    function setUp() public {
        Groth16Verifier verifier =
            new Groth16Verifier(ITransactionGroth16Verifier(address(new TransactionVerifierDev())));
        core = new PrivacyCore(verifier, new Poseidon2Hasher(), LEVELS);
        vault = NativeAssetVault(payable(AssetVaultFactory(core.VAULT_FACTORY()).getOrCreateNativeVault()));
        vm.roll(1_000);
    }

    /// Pass 1 of fixture generation (E2E_DUMP=true): what the wallet must know about the deployment.
    function test_E2E_DumpDeployment() public {
        if (!vm.envOr("E2E_DUMP", false)) return;
        vm.writeFile(
            "test/e2e/deployment.json",
            string.concat(
                '{"vault":"', vm.toString(address(vault)),
                '","core":"', vm.toString(address(core)),
                '","chainId":', vm.toString(block.chainid),
                ',"txDomain":"', vm.toString(core.TX_DOMAIN()), '"}\n'
            )
        );
    }

    function _shield() internal {
        require(
            uint256(uint160(address(vault))) == F.VAULT_ID,
            "E2E fixture is stale (the vault address moved): run circuits/scripts/e2e-fixture.sh"
        );
        vm.deal(alice, F.DEPOSIT);
        vm.prank(alice);
        vault.deposit{value: F.DEPOSIT}(F.ALICE_OWNER_COMMITMENT, F.ALICE_NOTE_SECRET, F.depositNoteData());
    }

    function _pi(uint8 t) internal pure returns (CoreTypes.PublicInputs memory) {
        uint256[14] memory p = F.pub(t);
        return CoreTypes.PublicInputs(
            p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], p[8], p[9], p[10], p[11], p[12], p[13]
        );
    }

    function _transact(uint8 t, CoreTypes.PublicInputs memory pi, bytes memory noteData0) internal {
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = F.proof(t);
        core.transact(abi.encode(a, b, c), pi, noteData0, F.noteData(t, 1), F.noteData(t, 2));
    }

    function _tx1() internal {
        _transact(0, _pi(0), F.noteData(0, 0));
    }

    function test_E2E_OnChainTreeMatchesWallet() public {
        _shield();
        assertEq(uint256(core.currentRoot()), F.ROOT, "on-chain depth-32 Poseidon2 root == the wallet's root");
    }

    function test_E2E_RealProofWithdraws() public {
        _shield();
        _tx1();

        assertEq(recipient.balance, F.WITHDRAWAL, "recipient paid on the strength of a real ZK proof");
        assertEq(address(vault).balance, F.DEPOSIT - F.WITHDRAWAL, "change + fee stay shielded in the vault");
        assertEq(vault.accountedDeposits(), F.DEPOSIT - F.WITHDRAWAL, "vault accounting follows");
        assertTrue(vault.isSolvent(), "vault solvent");
        assertEq(address(core).balance, 0, "core still holds no assets");
        CoreTypes.PublicInputs memory pi = _pi(0);
        assertTrue(core.isNullifierSpent(pi.nullifier0), "input nullifier spent");
        assertTrue(core.isNullifierSpent(pi.nullifier1), "phantom nullifier spent");
        assertEq(core.nextLeafIndex(), 8, "deposit group + transaction group");
        assertEq(uint256(core.currentRoot()), F.ROOT_AFTER, "outputs appended exactly as the proof committed");
    }

    /// Plan §76: the relayer recovers its fee from a private output note, with no public relayer field.
    function test_E2E_RelayerSpendsPrivateFeeNote() public {
        _shield();
        _tx1();
        assertEq(relayer.balance, 0);
        _transact(1, _pi(1), F.noteData(1, 0));
        assertEq(relayer.balance, F.FEE, "relayer withdrew its private fee note");
        assertEq(vault.accountedDeposits(), F.DEPOSIT - F.WITHDRAWAL - F.FEE);
        assertTrue(vault.isSolvent());
        assertEq(uint256(core.currentRoot()), F.ROOT_AFTER_2, "second transaction appended as committed");
    }

    function test_E2E_ReplayRejected() public {
        _shield();
        _tx1();
        vm.expectRevert(abi.encodeWithSelector(CoreTypes.SpentNullifier.selector, F.pub(0)[1]));
        _tx1();
    }

    function test_E2E_RedirectedRecipientRejected() public {
        _shield();
        CoreTypes.PublicInputs memory pi = _pi(0);
        pi.withdrawalRecipient = uint256(uint160(address(0xBAD)));
        vm.expectRevert(CoreTypes.InvalidProof.selector);
        _transact(0, pi, F.noteData(0, 0));
    }

    function test_E2E_SwappedNoteDataRejected() public {
        _shield();
        vm.expectRevert(abi.encodeWithSelector(CoreTypes.UnboundNoteData.selector, uint8(0)));
        _transact(0, _pi(0), F.noteData(1, 0)); // a payload from another transaction
    }

    function test_E2E_FeeNoteSpendBeforeItExistsRejected() public {
        _shield();
        vm.expectRevert(CoreTypes.UnknownRoot.selector); // tx2's root does not exist yet
        _transact(1, _pi(1), F.noteData(1, 0));
    }
}
