// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PPTestBase} from "../PPTestBase.sol";
import {CoreTypes} from "../../src/core/CoreTypes.sol";
import {ERC20AssetVault} from "../../src/vault/ERC20AssetVault.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";
import {BlacklistToken} from "../mocks/BlacklistToken.sol";

/// The headline property (spec §7, plan §33–34, §71): a stablecoin issuer's freeze/blacklist/destroy
/// can only ever damage that token's own vault. ETH, other tokens, the Merkle tree and the nullifier
/// set are untouched, because the core holds no assets and each asset lives in its own canonical vault.
contract IssuerFreezeTest is PPTestBase {
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    BlacklistToken internal usdt; // issuer-controlled (USDT-like)
    ERC20Mock internal usdc; // well-behaved
    ERC20AssetVault internal usdtVault;
    ERC20AssetVault internal usdcVault;

    function setUp() public {
        _deployCore();
        usdt = new BlacklistToken();
        usdc = new ERC20Mock();
        usdtVault = ERC20AssetVault(factory.getOrCreateERC20Vault(address(usdt)));
        usdcVault = ERC20AssetVault(factory.getOrCreateERC20Vault(address(usdc)));

        _depositNative(alice, 1 ether, 1);

        usdt.mint(alice, 100e18);
        vm.prank(alice);
        usdt.approve(address(usdtVault), type(uint256).max);
        _depositERC20(usdtVault, alice, 50e18, 2);

        usdc.mint(alice, 100e18);
        vm.prank(alice);
        usdc.approve(address(usdcVault), type(uint256).max);
        _depositERC20(usdcVault, alice, 50e18, 3);
    }

    function _snapshotOthers() internal view returns (bytes32) {
        // Everything that must be invariant under a USDT-only incident.
        return keccak256(
            abi.encode(
                nativeVault.accountedDeposits(),
                nativeVault.totalClaimable(),
                address(nativeVault).balance,
                usdcVault.accountedDeposits(),
                usdcVault.totalClaimable(),
                usdc.balanceOf(address(usdcVault))
            )
        );
    }

    function test_BlacklistVault_DamageIsAssetLocal() public {
        bytes32 before = _snapshotOthers();
        bytes32 rootBefore = core.currentRoot();
        usdt.blacklist(address(usdtVault)); // the vault can no longer move USDT

        // USDT withdrawal: payout soft-fails -> booked claimable, tx does NOT revert (TC-11 safe).
        CoreTypes.PublicInputs memory piU = _withdrawPI(address(usdtVault), bob, 10e18, 11, 12);
        _transact(piU);
        assertEq(usdt.balanceOf(bob), 0, "blacklisted USDT cannot move");
        assertEq(usdtVault.claimable(bob), 10e18, "booked as a claimable obligation");
        assertEq(_snapshotOthers(), before, "ETH and USDC vault accounting untouched by the USDT incident");
        assertTrue(core.currentRoot() != rootBefore, "tree advanced normally (outputs appended)");
        assertTrue(core.isNullifierSpent(11) && core.isNullifierSpent(12), "nullifier set advanced normally");

        // ETH and USDC are completely unaffected.
        CoreTypes.PublicInputs memory piE = _withdrawPI(address(nativeVault), bob, 1 ether, 13, 14);
        _transact(piE);
        assertEq(bob.balance, 1 ether, "ETH withdrawal unaffected");

        CoreTypes.PublicInputs memory piC = _withdrawPI(address(usdcVault), bob, 10e18, 15, 16);
        _transact(piC);
        assertEq(usdc.balanceOf(bob), 10e18, "USDC withdrawal unaffected");
    }

    function test_BlacklistCore_NoPrincipalAffected() public {
        usdt.blacklist(address(core)); // inert: the core never holds or moves USDT
        assertEq(usdt.balanceOf(address(core)), 0);

        CoreTypes.PublicInputs memory piU = _withdrawPI(address(usdtVault), bob, 10e18, 11, 12);
        _transact(piU);
        assertEq(usdt.balanceOf(bob), 10e18, "USDT path is vault->recipient; core blacklist is irrelevant");
    }

    function test_DestroyVaultFunds_IsolatedInsolvency() public {
        bytes32 before = _snapshotOthers();
        usdt.blacklist(address(usdtVault));
        usdt.destroyBlacklistedFunds(address(usdtVault));

        assertEq(usdt.balanceOf(address(usdtVault)), 0);
        assertFalse(usdtVault.isSolvent(), "USDT vault is now insolvent...");
        assertTrue(usdcVault.isSolvent(), "...but USDC vault is fine");
        assertTrue(nativeVault.isSolvent(), "...and so is ETH");
        assertEq(_snapshotOthers(), before, "no deficit leaks into other vaults");

        // ETH + USDC remain fully withdrawable, and the core's crypto state is intact.
        CoreTypes.PublicInputs memory piE = _withdrawPI(address(nativeVault), bob, 1 ether, 21, 22);
        _transact(piE);
        assertEq(bob.balance, 1 ether);

        CoreTypes.PublicInputs memory piC = _withdrawPI(address(usdcVault), bob, 10e18, 23, 24);
        _transact(piC);
        assertEq(usdc.balanceOf(bob), 10e18);

        assertTrue(core.isNullifierSpent(21), "core state machine unaffected");
    }

    function test_BlacklistedRecipient_GetsClaim_NotRevert() public {
        usdt.blacklist(bob); // the RECIPIENT is frozen, not the vault
        CoreTypes.PublicInputs memory piU = _withdrawPI(address(usdtVault), bob, 10e18, 11, 12);
        _transact(piU); // no revert: relayer gas is bounded (TC-11)
        assertEq(usdtVault.claimable(bob), 10e18);
        usdt.unblacklist(bob);
        usdtVault.claim(bob);
        assertEq(usdt.balanceOf(bob), 10e18);
    }
}
