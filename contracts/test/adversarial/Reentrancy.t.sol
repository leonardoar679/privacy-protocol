// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PPTestBase} from "../PPTestBase.sol";
import {CoreTypes} from "../../src/core/CoreTypes.sol";
import {VaultTypes} from "../../src/vault/VaultTypes.sol";
import {IAssetVault} from "../../src/vault/IAssetVault.sol";
import {ERC20AssetVault} from "../../src/vault/ERC20AssetVault.sol";
import {ReentrantToken} from "../mocks/ReentrantToken.sol";
import {ReentrantRecipient} from "../mocks/ReentrantRecipient.sol";
import {MaliciousVault} from "../mocks/MaliciousVault.sol";

/// Plan §73 reentrancy matrix + the hand-rolled vault (Inv 8). Expected everywhere: no double
/// spend, no accounting corruption, no duplicated release — a blocked re-entry only turns the
/// payout into a claim.
contract ReentrancyTest is PPTestBase {
    address internal alice = address(0xA11CE);

    function setUp() public {
        _deployCore();
        _depositNative(alice, 5 ether, 1);
    }

    /// release() -> malicious token -> release(): the token cannot be the core, so the inner call
    /// reverts; the soft transfer reports failure and the amount becomes claimable. Nothing is lost.
    function test_ReleaseReenteringRelease_IsBlocked() public {
        ReentrantToken tok = new ReentrantToken();
        ERC20AssetVault v = ERC20AssetVault(factory.getOrCreateERC20Vault(address(tok)));
        tok.mint(alice, 100e18);
        vm.prank(alice);
        tok.approve(address(v), type(uint256).max);
        _depositERC20(v, alice, 50e18, 2);

        address bob = address(0xB0B);
        tok.arm(address(v), abi.encodeWithSelector(IAssetVault.release.selector, bob, 50e18));
        CoreTypes.PublicInputs memory pi = _withdrawPI(address(v), bob, 10e18, 11, 12);
        _transact(pi); // does not revert

        assertEq(tok.balanceOf(bob), 0, "re-entrant transfer failed, nothing moved");
        assertEq(v.claimable(bob), 10e18, "booked as claimable");
        assertEq(v.accountedDeposits(), 40e18, "released exactly once");
        assertTrue(v.isSolvent());
        assertTrue(core.isNullifierSpent(11), "state transition kept");
    }

    /// release() -> malicious token -> core.transact(): the core is nonReentrant.
    function test_ReleaseReenteringCore_IsBlocked() public {
        ReentrantToken tok = new ReentrantToken();
        ERC20AssetVault v = ERC20AssetVault(factory.getOrCreateERC20Vault(address(tok)));
        tok.mint(alice, 100e18);
        vm.prank(alice);
        tok.approve(address(v), type(uint256).max);
        _depositERC20(v, alice, 50e18, 2);

        address bob = address(0xB0B);
        CoreTypes.PublicInputs memory inner = _withdrawPI(address(v), bob, 10e18, 21, 22);
        _accept(inner);
        tok.arm(
            address(core),
            abi.encodeWithSelector(core.transact.selector, "", inner, _noteData(0), _noteData(1), _noteData(2))
        );
        CoreTypes.PublicInputs memory outer = _withdrawPI(address(v), bob, 10e18, 11, 12);
        _transact(outer);

        assertFalse(core.isNullifierSpent(21), "inner transaction was blocked");
        assertEq(v.claimable(bob), 10e18);
        assertEq(v.accountedDeposits(), 40e18);
        assertTrue(v.isSolvent());
    }

    /// release() -> recipient.receive() -> claim(): blocked; the ETH payout fails and becomes a
    /// claim. Then claim() -> receive() -> claim() is blocked too, so the claim reverts and the
    /// obligation is preserved — exactly one payout can ever happen.
    function test_RecipientReenteringClaim_IsBlocked() public {
        ReentrantRecipient r = new ReentrantRecipient(nativeVault);
        CoreTypes.PublicInputs memory pi = _withdrawPI(address(nativeVault), address(r), 1 ether, 11, 12);
        _transact(pi);
        assertEq(address(r).balance, 0, "payout failed (re-entry reverted the receive)");
        assertEq(nativeVault.claimable(address(r)), 1 ether, "booked as claimable");
        assertEq(r.entries(), 0, "the re-entrant receive() reverted as a whole (its own writes rolled back)");

        vm.expectRevert(VaultTypes.ClaimTransferFailed.selector);
        nativeVault.claim(address(r));
        assertEq(nativeVault.claimable(address(r)), 1 ether, "claim preserved after a failed claim");
        assertEq(nativeVault.accountedDeposits(), 4 ether);
        assertTrue(nativeVault.isSolvent());
    }

    /// Inv 8: a contract that merely claims to be a vault can neither register notes nor be paid.
    function test_MaliciousVault_Rejected() public {
        MaliciousVault mv = new MaliciousVault(address(core), address(0));
        vm.expectRevert(CoreTypes.CallerNotCanonicalVault.selector);
        mv.fakeDeposit(1, 2, 1 ether, _noteData(1));

        CoreTypes.PublicInputs memory pi = _withdrawPI(address(mv), address(0xB0B), 1 ether, 11, 12);
        _accept(pi);
        vm.expectRevert(CoreTypes.InvalidVault.selector);
        _transactRaw(pi);
    }

    /// Inv 7 (contract form): a vault only ever moves its own asset, through its own release.
    function test_VaultReleaseIsCoreOnly() public {
        vm.expectRevert(VaultTypes.CallerNotCore.selector);
        nativeVault.release(address(0xB0B), 1 ether);
        vm.prank(address(factory));
        vm.expectRevert(VaultTypes.CallerNotCore.selector);
        nativeVault.release(address(0xB0B), 1 ether);
    }
}
