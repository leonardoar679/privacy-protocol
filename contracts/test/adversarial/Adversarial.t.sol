// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PPTestBase} from "../PPTestBase.sol";
import {CoreTypes} from "../../src/core/CoreTypes.sol";
import {NativeAssetVault} from "../../src/vault/NativeAssetVault.sol";
import {ERC20AssetVault} from "../../src/vault/ERC20AssetVault.sol";
import {ReentrantToken} from "../mocks/ReentrantToken.sol";
import {GasProbe} from "../mocks/GasProbe.sol";

/// Contract-level attack surface. Deeper cross-asset soundness (a USDT note cannot become a USDC
/// output) is enforced IN-CIRCUIT (asset conservation, spec §10 C11); here we prove the slice the
/// contract itself owns: proofs are bound to their public inputs, only canonical vaults can be
/// paid, nullifiers are one-shot, payloads are bound, and reentrancy is blocked.
contract AdversarialTest is PPTestBase {
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal mallory = address(0x4A);

    function setUp() public {
        _deployCore();
        _depositNative(alice, 3 ether, 1);
    }

    function test_ZeroVaultOrCoreRecipient_Rejected() public {
        // a recipient the funds cannot come back from (the fifth review round, 2026-11-03): refused by the core itself, not left to the clients
        address[3] memory bad = [address(0), address(nativeVault), address(core)];
        for (uint256 i = 0; i < bad.length; i++) {
            CoreTypes.PublicInputs memory pi = _withdrawPI(address(nativeVault), bad[i], 1 ether, 31 + i * 2, 32 + i * 2);
            _accept(pi);
            vm.expectRevert(CoreTypes.InvalidRecipient.selector);
            _transactRaw(pi);
        }
        assertEq(nativeVault.accountedDeposits(), 3 ether, "nothing left the vault");
    }

    function test_PayoutGasIsCapped_BurningRecipientBecomesClaimable() public {
        // the ETH push hands its recipient PUSH_GAS at most (the fifth review round, 2026-11-03): a receive() burning all it was given
        // had left the vault 1/64 of the transaction's gas for its bookkeeping, and the relayer's whole transact reverted at a tight limit
        GasProbe probe = new GasProbe();
        CoreTypes.PublicInputs memory pi = _withdrawPI(address(nativeVault), address(probe), 1 ether, 41, 42);
        _transact(pi);
        assertEq(address(probe).balance, 1 ether, "a plain receive is paid");
        assertTrue(probe.seen() <= 100_000 + 2_300, "the push carries at most PUSH_GAS, plus the stipend a value call adds");
        probe.setBurn(true);
        CoreTypes.PublicInputs memory pi2 = _withdrawPI(address(nativeVault), address(probe), 1 ether, 43, 44);
        _transact(pi2);
        assertEq(address(probe).balance, 1 ether, "the burning receive was not paid");
        assertEq(nativeVault.claimable(address(probe)), 1 ether, "booked as claimable instead, the transact whole");
        assertTrue(nativeVault.isSolvent());
    }

    function test_TamperedRecipient_Rejected() public {
        CoreTypes.PublicInputs memory pi = _withdrawPI(address(nativeVault), bob, 1 ether, 11, 12);
        _accept(pi); // honest proof accepted for THESE inputs
        pi.withdrawalRecipient = uint256(uint160(mallory)); // redirect after proving
        vm.expectRevert(CoreTypes.InvalidProof.selector); // public inputs changed -> proof no longer valid
        _transactRaw(pi);
    }

    function test_TamperedAmount_Rejected() public {
        CoreTypes.PublicInputs memory pi = _withdrawPI(address(nativeVault), bob, 1 ether, 11, 12);
        _accept(pi);
        pi.withdrawalAmount = 3 ether; // try to take more
        vm.expectRevert(CoreTypes.InvalidProof.selector);
        _transactRaw(pi);
    }

    function test_MalformedProof_Rejected() public {
        CoreTypes.PublicInputs memory pi = _withdrawPI(address(nativeVault), bob, 1 ether, 11, 12);
        vm.expectRevert(CoreTypes.InvalidProof.selector); // never accepted -> verifier returns false
        _transactRaw(pi);
    }

    function test_NonCanonicalVault_Rejected() public {
        NativeAssetVault fake = new NativeAssetVault(address(core)); // same core, but NOT factory-made
        CoreTypes.PublicInputs memory pi = _withdrawPI(address(fake), bob, 1 ether, 11, 12);
        _accept(pi); // verifier doesn't know canonicality; the core enforces it
        vm.expectRevert(CoreTypes.InvalidVault.selector);
        _transactRaw(pi);
    }

    function test_NullifierReuse_AcrossTransactions_Rejected() public {
        CoreTypes.PublicInputs memory pi1 = _withdrawPI(address(nativeVault), bob, 1 ether, 11, 12);
        _transact(pi1);

        CoreTypes.PublicInputs memory pi2 = _withdrawPI(address(nativeVault), bob, 1 ether, 11, 99); // reuse 11
        _accept(pi2);
        vm.expectRevert(abi.encodeWithSelector(CoreTypes.SpentNullifier.selector, uint256(11)));
        _transactRaw(pi2);
    }

    function test_DuplicateNullifier_Rejected() public {
        CoreTypes.PublicInputs memory pi = _withdrawPI(address(nativeVault), bob, 1 ether, 11, 11);
        _accept(pi);
        vm.expectRevert(CoreTypes.DuplicateNullifier.selector);
        _transactRaw(pi);
    }

    function test_WrongTxDomain_Rejected() public {
        CoreTypes.PublicInputs memory pi = _withdrawPI(address(nativeVault), bob, 1 ether, 11, 12);
        pi.txDomain = (pi.txDomain + 1) % FIELD; // a proof made for another chain / core / circuit
        _accept(pi);
        vm.expectRevert(CoreTypes.InvalidTxDomain.selector);
        _transactRaw(pi);
    }

    function test_SwappedNoteData_Rejected() public {
        CoreTypes.PublicInputs memory pi = _withdrawPI(address(nativeVault), bob, 1 ether, 11, 12);
        _accept(pi);
        vm.expectRevert(abi.encodeWithSelector(CoreTypes.UnboundNoteData.selector, uint8(1)));
        core.transact("", pi, _noteData(0), _noteData(99), _noteData(2)); // relayer swaps payload 1
    }

    function test_WrongSizeNoteData_Rejected() public {
        CoreTypes.PublicInputs memory pi = _withdrawPI(address(nativeVault), bob, 1 ether, 11, 12);
        _accept(pi);
        vm.expectRevert(abi.encodeWithSelector(CoreTypes.MalformedNoteData.selector, uint8(2)));
        core.transact("", pi, _noteData(0), _noteData(1), hex"deadbeef");
    }

    function test_TransferCarryingWithdrawal_Rejected() public {
        CoreTypes.PublicInputs memory pi = _transferPI(11, 12, 1, 2, 3);
        pi.withdrawalAmount = 1 ether; // mode 0 but trying to exit value
        _accept(pi);
        vm.expectRevert(CoreTypes.TransferMustCarryNoWithdrawal.selector);
        _transactRaw(pi);
    }

    function test_NonCanonicalField_Rejected() public {
        CoreTypes.PublicInputs memory pi = _withdrawPI(address(nativeVault), bob, 1 ether, 11, 12);
        pi.nullifier0 = FIELD + 11; // alias of 11 as a field element, a different mapping key
        _accept(pi);
        vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("InvalidField()"))));
        _transactRaw(pi);
    }

    function test_ReentrantToken_DepositBlocked() public {
        ReentrantToken tok = new ReentrantToken();
        ERC20AssetVault v = ERC20AssetVault(factory.getOrCreateERC20Vault(address(tok)));
        tok.mint(alice, 100e18);
        vm.prank(alice);
        tok.approve(address(v), type(uint256).max);
        // During transferFrom, re-enter v.deposit — must be blocked by nonReentrant, reverting all.
        bytes memory reenter =
            abi.encodeWithSelector(ERC20AssetVault.deposit.selector, uint256(1e18), uint256(2), uint256(3), _noteData(2));
        tok.arm(address(v), reenter);
        vm.expectRevert();
        vm.prank(alice);
        v.deposit(10e18, 1, 2, _noteData(1));
    }
}
