// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PPTestBase} from "../PPTestBase.sol";
import {CoreTypes} from "../../src/core/CoreTypes.sol";
import {VaultTypes} from "../../src/vault/VaultTypes.sol";
import {IAssetVaultFactory} from "../../src/factory/IAssetVaultFactory.sol";
import {ERC20AssetVault} from "../../src/vault/ERC20AssetVault.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";
import {FeeOnTransferToken} from "../mocks/FeeOnTransferToken.sol";
import {RebaseToken} from "../mocks/RebaseToken.sol";
import {FalseReturnToken} from "../mocks/FalseReturnToken.sol";
import {NoReturnToken} from "../mocks/NoReturnToken.sol";
import {PauseToken} from "../mocks/PauseToken.sol";
import {MalformedToken} from "../mocks/MalformedToken.sol";
import {BurnToken} from "../mocks/BurnToken.sol";

/// Strict balance-delta accounting (spec §8.2) + canonical factory behaviour (§7.2). The token zoo
/// of plan §72: only standard behaviour becomes officially supported.
contract ERC20AccountingTest is PPTestBase {
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    function setUp() public {
        _deployCore();
    }

    function _vault(address token) internal returns (ERC20AssetVault) {
        return ERC20AssetVault(factory.getOrCreateERC20Vault(token));
    }

    function _fund(ERC20Mock tok, ERC20AssetVault v) internal {
        tok.mint(alice, 100e18);
        vm.prank(alice);
        tok.approve(address(v), type(uint256).max);
    }

    function _depositExpecting(ERC20AssetVault v, bytes memory err) internal {
        vm.expectRevert(err);
        vm.prank(alice);
        v.deposit(10e18, 1, 2, _noteData(1));
    }

    function test_StandardToken_DepositWithdraw() public {
        ERC20Mock tok = new ERC20Mock();
        ERC20AssetVault v = _vault(address(tok));
        _fund(tok, v);
        _depositERC20(v, alice, 10e18, 1);

        assertEq(tok.balanceOf(address(v)), 10e18);
        assertEq(v.accountedDeposits(), 10e18);
        assertEq(tok.balanceOf(address(core)), 0, "core holds NO ERC20");

        CoreTypes.PublicInputs memory pi = _withdrawPI(address(v), bob, 10e18, 1, 2);
        _transact(pi);
        assertEq(tok.balanceOf(bob), 10e18);
        assertEq(v.accountedDeposits(), 0);
    }

    function test_FeeOnTransfer_RejectedOnDeposit() public {
        FeeOnTransferToken tok = new FeeOnTransferToken();
        ERC20AssetVault v = _vault(address(tok));
        _fund(tok, v);
        _depositExpecting(v, abi.encodeWithSelector(VaultTypes.UnsupportedTokenBehavior.selector));
    }

    function test_Rebasing_RejectedOnDeposit() public {
        RebaseToken tok = new RebaseToken();
        ERC20AssetVault v = _vault(address(tok));
        _fund(tok, v);
        _depositExpecting(v, abi.encodeWithSelector(VaultTypes.UnsupportedTokenBehavior.selector));
    }

    function test_FalseReturnToken_RejectedOnDeposit() public {
        FalseReturnToken tok = new FalseReturnToken();
        ERC20AssetVault v = _vault(address(tok));
        tok.mint(alice, 100e18);
        vm.prank(alice);
        tok.approve(address(v), type(uint256).max);
        _depositExpecting(v, abi.encodeWithSelector(VaultTypes.TokenTransferFailed.selector));
    }

    function test_PausedToken_RejectedOnDeposit_ClaimableOnWithdraw() public {
        PauseToken tok = new PauseToken();
        ERC20AssetVault v = _vault(address(tok));
        _fund(tok, v);
        _depositERC20(v, alice, 10e18, 1);

        tok.pause();
        _depositExpecting(v, abi.encodeWithSelector(VaultTypes.TokenTransferFailed.selector));

        // A paused token cannot be paid out; the completed state transition is kept and the payout
        // becomes claimable (release never reverts), then settles once the issuer unpauses.
        CoreTypes.PublicInputs memory pi = _withdrawPI(address(v), bob, 10e18, 1, 2);
        _transact(pi);
        assertEq(tok.balanceOf(bob), 0);
        assertEq(v.claimable(bob), 10e18, "booked as claimable while paused");
        tok.unpause();
        v.claim(bob);
        assertEq(tok.balanceOf(bob), 10e18);
        assertEq(v.totalClaimable(), 0);
    }

    function test_MalformedReturnToken_RejectedOnDeposit() public {
        MalformedToken tok = new MalformedToken();
        ERC20AssetVault v = _vault(address(tok));
        tok.mint(alice, 100e18);
        vm.prank(alice);
        tok.approve(address(v), type(uint256).max);
        _depositExpecting(v, abi.encodeWithSelector(VaultTypes.TokenTransferFailed.selector));
    }

    function test_BurnOnTransferToken_RejectedOnDeposit() public {
        BurnToken tok = new BurnToken();
        ERC20AssetVault v = _vault(address(tok));
        _fund(tok, v);
        _depositExpecting(v, abi.encodeWithSelector(VaultTypes.UnsupportedTokenBehavior.selector));
    }

    function test_NoReturnToken_Supported() public {
        NoReturnToken tok = new NoReturnToken();
        ERC20AssetVault v = _vault(address(tok));
        tok.mint(alice, 100e18);
        vm.prank(alice);
        tok.approve(address(v), type(uint256).max);
        _depositERC20(v, alice, 10e18, 1);
        assertEq(v.accountedDeposits(), 10e18);
        assertEq(tok.balanceOf(address(v)), 10e18);
    }

    function test_Donation_IsNotALiability() public {
        ERC20Mock tok = new ERC20Mock();
        ERC20AssetVault v = _vault(address(tok));
        _fund(tok, v);
        _depositERC20(v, alice, 10e18, 1);

        // Someone dumps tokens straight into the vault.
        tok.mint(address(this), 5e18);
        tok.transfer(address(v), 5e18);

        assertEq(v.accountedDeposits(), 10e18, "donation does not create a liability");
        assertEq(v.actualAssetBalance(), 15e18);
        assertTrue(v.isSolvent());
    }

    function test_Factory_OneCanonicalVault_Deterministic() public {
        ERC20Mock tok = new ERC20Mock();
        address predicted = factory.predictERC20Vault(address(tok));
        address v = factory.getOrCreateERC20Vault(address(tok));
        assertEq(predicted, v, "CREATE2 address matches prediction");
        assertTrue(factory.isCanonical(v));
        assertEq(factory.getOrCreateERC20Vault(address(tok)), v, "idempotent: one canonical vault per asset");
        assertEq(factory.predictNativeVault(), address(nativeVault), "native vault predicted too");
        assertEq(factory.salt(1, address(tok)), keccak256(abi.encode(block.chainid, uint8(1), address(tok))));
        vm.expectRevert(IAssetVaultFactory.ZeroToken.selector);
        factory.getOrCreateERC20Vault(address(0));
    }
}
