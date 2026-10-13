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
import {SwapOrderFactory} from "../../src/periphery/swap/SwapOrderFactory.sol";
import {SwapOrderTypes as T} from "../../src/periphery/swap/SwapOrderTypes.sol";
import {MockSwapProvider} from "../mocks/MockSwapProvider.sol";

/// END-TO-END, nothing mocked: Poseidon2 on-chain over a depth-32 tree, the snarkjs Groth16 verifier,
/// and real proofs of circuits/transaction.circom whose witnesses the wallet reference built against
/// THIS deployment.
///   tx1  Alice shields 1 ETH, then privately withdraws 0.6 ETH to a fresh recipient, keeps 0.35 ETH as
///        a shielded change note and pays a 0.05 ETH **private relayer-fee note** (plan §49, §76).
///   tx2  The relayer spends its fee note and withdraws 0.05 ETH to its own address — no relayer
///        address or fee ever appears in tx1.
///   tx3  (V1.1 private-swap exit) Alice spends her 0.35 ETH change note and withdraws it to the
///        counterfactual SwapOrderEscrow of a pre-committed order; a relayer then deploys the escrow
///        and executes the provider call the one-time order key signed — or, after the refund window,
///        re-shields the balance as the order's pre-committed refund note;
///   tx4  Alice spends THAT refund note with a real proof — the round trip pool → swap order → pool.
/// The proofs bind the vault's address and the escrow address, so a change that moves either needs
/// new fixtures: circuits/scripts/e2e-fixture.sh.
contract RealProofE2ETest is Test {
    uint256 internal constant LEVELS = 32; // must equal the circuit's tree depth

    PrivacyCore internal core;
    NativeAssetVault internal vault;
    address internal alice = address(0xA11CE);
    address internal recipient = address(uint160(F.RECIPIENT));
    address internal relayer = address(uint160(F.RELAYER));
    address internal recipient2 = address(uint160(F.RECIPIENT2));
    SwapOrderFactory internal swapFactory;
    MockSwapProvider internal provider;
    uint256 internal constant ORDER_KEY = 0xA11CE0; // the wallet's one-time order key (fixture: ORDER_SIGNER)

    /// the test contract is the executor of the un-pranked escrow calls, so it receives the tip
    receive() external payable {}

    function setUp() public {
        Groth16Verifier verifier =
            new Groth16Verifier(ITransactionGroth16Verifier(address(new TransactionVerifierDev())));
        core = new PrivacyCore(verifier, new Poseidon2Hasher(), LEVELS);
        vault = NativeAssetVault(payable(AssetVaultFactory(core.VAULT_FACTORY()).getOrCreateNativeVault()));
        swapFactory = new SwapOrderFactory(address(0)); // no wrapped-native refunds in these flows
        provider = new MockSwapProvider();
        vm.roll(1_000);
        vm.warp(1_900_000_000); // the fixture's order deadlines are absolute (2_000_000_000 / 2_000_100_000)
    }

    /// The order the wallet pre-committed (constants shared with packages/protocol genE2EInputs.ts).
    function _swapParams() internal view returns (T.OrderParams memory p) {
        p.orderId = bytes32(F.ORDER_ID);
        p.assetType = T.ASSET_ETH;
        p.asset = address(0);
        p.amount = F.SWAP_AMOUNT;
        p.orderSigner = vm.addr(ORDER_KEY);
        p.executeDeadline = uint64(F.EXECUTE_DEADLINE);
        p.refundAfter = uint64(F.REFUND_AFTER);
        p.refundVault = address(vault);
        p.refundOwnerCommitment = F.ALICE_OWNER_COMMITMENT;
        p.refundNoteSecret = F.REFUND_NOTE_SECRET;
        p.refundNoteDataHash = keccak256(F.refundNoteData());
        p.executorTip = F.SWAP_TIP;
    }

    /// What the wallet and the relayer's suite must know about the deployment (test/e2e/deployment.json).
    function _deploymentJson() internal view returns (string memory) {
        return string.concat(
            '{"vault":"', vm.toString(address(vault)),
            '","core":"', vm.toString(address(core)),
            '","chainId":', vm.toString(block.chainid),
            ',"txDomain":"', vm.toString(core.TX_DOMAIN()),
            '","swapFactory":"', vm.toString(address(swapFactory)),
            '","orderSigner":"', vm.toString(vm.addr(ORDER_KEY)), '"}\n'
        );
    }

    /// Pass 1 of fixture generation (E2E_DUMP=true): writes test/e2e/deployment.json.
    function test_E2E_DumpDeployment() public {
        if (!vm.envOr("E2E_DUMP", false)) return;
        vm.writeFile("test/e2e/deployment.json", _deploymentJson());
    }

    /// The committed test/e2e/deployment.json — read by the relayer's suite and by CI on a clean checkout (V6 Stage 2) —
    /// is this deployment: a stale copy fails here, never later in another package's tests.
    function test_E2E_DeploymentJsonIsCurrent() public view {
        assertEq(vm.readFile("test/e2e/deployment.json"), _deploymentJson(), "test/e2e/deployment.json is stale: run circuits/scripts/e2e-fixture.sh");
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

    /// tx3: the change note leaves the pool for the escrow on the strength of a real proof.
    function _tx3ToEscrow() internal returns (address escrow) {
        escrow = swapFactory.predict(_swapParams());
        require(
            escrow == address(uint160(F.ESCROW)),
            "E2E fixture is stale (the predicted escrow moved): run circuits/scripts/e2e-fixture.sh"
        );
        _transact(2, _pi(2), F.noteData(2, 0));
        assertEq(escrow.balance, F.SWAP_AMOUNT, "escrow funded by a private withdrawal");
        assertEq(escrow.code.length, 0, "counterfactual: nothing deployed yet");
    }

    function _execution(address escrow) internal view returns (T.Execution memory x) {
        uint256 value = F.SWAP_AMOUNT - F.SWAP_TIP;
        bytes memory cd = abi.encodeWithSelector(
            MockSwapProvider.depositWithExpiry.selector,
            address(0xB0B),
            address(0),
            value,
            "=:BTC.BTC:bc1qfresh:3107812",
            block.timestamp + 1 hours
        );
        uint64 deadline = uint64(block.timestamp + 20 minutes);
        bytes32 digest = keccak256(
            abi.encode(T.EXECUTE_TAG, block.chainid, escrow, F.ORDER_ID, address(provider), value, keccak256(cd), deadline)
        );
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(ORDER_KEY, digest);
        x = T.Execution({
            provider: address(provider),
            value: value,
            providerCalldata: cd,
            deadline: deadline,
            signature: abi.encodePacked(r, sg, v)
        });
    }

    /// V1.1 step 14: pool → swap order, with the real circuit and verifier. The core never knew.
    function test_E2E_PrivateNoteExitsToSwapOrder_RealProof() public {
        _shield();
        _tx1();
        address escrow = _tx3ToEscrow();
        assertEq(uint256(core.currentRoot()), F.ROOT_AFTER_3, "tx3 outputs appended as committed");
        uint256 accounted = vault.accountedDeposits();

        vm.prank(relayer);
        swapFactory.deployAndExecute(_swapParams(), _execution(escrow));

        assertEq(address(provider).balance, F.SWAP_AMOUNT - F.SWAP_TIP, "provider received the order's value");
        assertEq(relayer.balance, F.SWAP_TIP, "the executing relayer took exactly the committed tip");
        assertEq(escrow.balance, 0, "escrow drained");
        assertEq(address(core).balance, 0, "core holds nothing, before and after");
        assertEq(vault.accountedDeposits(), accounted, "the pool's accounting is untouched by the swap");
        assertTrue(vault.isSolvent());
    }

    /// The failure branch of the same order: nobody executed before the refund window, so the balance
    /// returns to the pool as the pre-committed note, and that note is spendable with a real proof.
    function test_E2E_SwapOrderRefund_ReShieldsAndIsSpendableWithRealProof() public {
        _shield();
        _tx1();
        address escrow = _tx3ToEscrow();
        vm.warp(F.REFUND_AFTER + 1);
        uint256 accounted = vault.accountedDeposits();

        vm.prank(relayer);
        swapFactory.deployAndRefund(_swapParams(), F.refundNoteData());

        assertEq(escrow.balance, 0, "escrow emptied");
        assertEq(relayer.balance, F.SWAP_TIP, "refunding relayer took the tip");
        assertEq(vault.accountedDeposits(), accounted + F.SWAP_AMOUNT - F.SWAP_TIP, "the rest is back in the pool");
        assertEq(core.nextLeafIndex(), 16, "deposit, tx1, tx3 and the refund deposit: four groups");
        assertEq(uint256(core.currentRoot()), F.ROOT_AFTER_REFUND, "the refund note is exactly the wallet's pre-committed note");

        // tx4: Alice spends the refunded note (leaf 12) and withdraws it to a second fresh address
        _transact(3, _pi(3), F.noteData(3, 0));
        assertEq(recipient2.balance, F.SWAP_AMOUNT - F.SWAP_TIP, "refund note spent with a real proof");
        assertEq(uint256(core.currentRoot()), F.ROOT_AFTER_4, "tx4 appended as committed");
        assertTrue(vault.isSolvent());
        assertEq(address(core).balance, 0);
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
