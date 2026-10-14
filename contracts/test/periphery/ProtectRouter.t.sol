// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PPTestBase} from "../PPTestBase.sol";
import {PrivacyCore} from "../../src/core/PrivacyCore.sol";
import {ERC20AssetVault} from "../../src/vault/ERC20AssetVault.sol";
import {ProtectRouter} from "../../src/periphery/protect/ProtectRouter.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";
import {NoReturnToken} from "../mocks/NoReturnToken.sol";
import {FalseReturnToken} from "../mocks/FalseReturnToken.sol";
import {FeeOnTransferToken} from "../mocks/FeeOnTransferToken.sol";
import {BlacklistToken} from "../mocks/BlacklistToken.sol";
import {ReentrantToken} from "../mocks/ReentrantToken.sol";

/// The privacy fee on a protect (Privacy Wallet Web spec v2.0 §3, §11.1): 1 % of the gross to the fee recipient,
/// the net deposited as the caller's note through the canonical vault's public deposit. Mock verifier and hasher;
/// PrivacyCore and the vaults are the production contracts, untouched.
contract ProtectRouterTest is PPTestBase {
    address internal alice = address(0xA11CE);
    address internal feeRecipient = address(0xFEE5);
    ProtectRouter internal router;

    uint256 internal constant OC = 0x0C;
    uint256 internal constant SECRET = 0x5EC;

    function setUp() public {
        _deployCore();
        router = new ProtectRouter(address(core), feeRecipient);
    }

    function _vault(address token) internal returns (ERC20AssetVault) {
        return ERC20AssetVault(factory.getOrCreateERC20Vault(token));
    }

    // ---- construction ------------------------------------------------------------------------------------------------

    function test_ImmutablesComeFromTheCore() public view {
        assertEq(router.CORE(), address(core));
        assertEq(router.VAULT_FACTORY(), address(factory));
        assertEq(router.FEE_RECIPIENT(), feeRecipient);
        assertEq(router.FEE_BPS(), 100);
    }

    function test_ZeroAddressesRefused() public {
        vm.expectRevert(ProtectRouter.ZeroAddress.selector);
        new ProtectRouter(address(0), feeRecipient);
        vm.expectRevert(ProtectRouter.ZeroAddress.selector);
        new ProtectRouter(address(core), address(0));
    }

    // ---- the fee: ⌈gross · 100 / 10000⌉ ------------------------------------------------------------------------------

    function test_FeeCeilings() public view {
        assertEq(router.feeOf(1), 1, "1 unit pays 1");
        assertEq(router.feeOf(99), 1);
        assertEq(router.feeOf(100), 1, "exactly 1 %");
        assertEq(router.feeOf(101), 2, "rounded up");
        assertEq(router.feeOf(10_000), 100);
        assertEq(router.feeOf(10_001), 101);
        assertEq(router.feeOf(1_000e6), 10e6, "$1,000 in USDC pays $10");
        assertEq(router.feeOf(5_000e6), 50e6, "the spec's 5,000 USDC pays 50");
        assertEq(router.feeOf(100_000e6), 1_000e6);
        assertEq(router.feeOf(1e8), 1e6, "1 BTC in 8 decimals");
        assertEq(router.feeOf(1 ether), 0.01 ether);
        assertEq(router.feeOf(2 ** 200), uint256(2 ** 200) / 100 + 1, "2^200 is not a multiple of 100");
        assertEq(router.feeOf(type(uint256).max), type(uint256).max / 100 + 1, "no overflow at the top");
    }

    /// fee + net == gross, and the fee is the least multiple-of-1 % ceiling: fee·100 ≥ gross > (fee − 1)·100.
    function testFuzz_FeePlusNetIsGross(uint256 gross) public {
        vm.assume(gross > 0);
        uint256 fee = router.feeOf(gross);
        assertTrue(fee <= gross, "the fee never exceeds the gross");
        assertEq(fee + (gross - fee), gross);
        // the ceiling against an independent formula (no overflow: compared through division)
        assertEq(fee, gross / 100 + (gross % 100 == 0 ? 0 : 1), "fee == ceil(gross / 100)");
    }

    // ---- ETH ---------------------------------------------------------------------------------------------------------

    function test_ProtectETH() public {
        uint256 gross = 1 ether;
        uint256 fee = 0.01 ether;
        vm.deal(alice, gross);
        uint256 vaultBefore = nativeVault.accountedDeposits();
        uint256 leafBefore = core.nextLeafIndex();
        vm.prank(alice);
        uint32 leaf = router.protectETH{value: gross}(OC, SECRET, _noteData(1), gross - fee);
        assertEq(uint256(leaf), leafBefore, "the note's leaf");
        assertEq(feeRecipient.balance, fee, "1 % to the fee recipient");
        assertEq(nativeVault.accountedDeposits() - vaultBefore, gross - fee, "the net is the note");
        assertEq(address(router).balance, 0, "nothing stays in the router");
        assertTrue(nativeVault.isSolvent());
    }

    function test_ProtectETHBoundaries() public {
        vm.deal(alice, 1_000);
        vm.startPrank(alice);
        vm.expectRevert(ProtectRouter.ZeroAmount.selector);
        router.protectETH{value: 0}(OC, SECRET, _noteData(1), 0);
        vm.expectRevert(ProtectRouter.ZeroAmount.selector); // 1 wei: the fee takes it all
        router.protectETH{value: 1}(OC, SECRET, _noteData(1), 0);
        router.protectETH{value: 99}(OC, SECRET, _noteData(2), 98);
        router.protectETH{value: 100}(OC, SECRET, _noteData(3), 99);
        router.protectETH{value: 101}(OC, SECRET, _noteData(4), 99);
        vm.stopPrank();
        assertEq(feeRecipient.balance, 1 + 1 + 2, "fees of 99, 100 and 101 wei");
    }

    function test_AmountMismatchRefused() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ProtectRouter.AmountMismatch.selector, 0.99 ether, 1 ether));
        router.protectETH{value: 1 ether}(OC, SECRET, _noteData(1), 1 ether); // a note built for the gross
    }

    function test_NoNativeVaultRefused() public {
        PrivacyCore bare = new PrivacyCore(verifier, hasher, LEVELS); // no vault created on it yet
        ProtectRouter r = new ProtectRouter(address(bare), feeRecipient);
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(ProtectRouter.NoVault.selector);
        r.protectETH{value: 1 ether}(OC, SECRET, _noteData(1), 0.99 ether);
    }

    function test_RevertingFeeRecipientRefused() public {
        ProtectRouter r = new ProtectRouter(address(core), address(new Refuser()));
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(ProtectRouter.FeeTransferFailed.selector);
        r.protectETH{value: 1 ether}(OC, SECRET, _noteData(1), 0.99 ether);
    }

    function test_NoStrayEther() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(router).call{value: 1 ether}("");
        assertFalse(ok, "the router takes ETH only inside protectETH");
    }

    // ---- ERC-20 ------------------------------------------------------------------------------------------------------

    function test_ProtectERC20() public {
        ERC20Mock usdc = new ERC20Mock();
        ERC20AssetVault vault = _vault(address(usdc));
        uint256 gross = 5_000e6;
        usdc.mint(alice, gross);
        vm.startPrank(alice);
        usdc.approve(address(router), gross); // exactly the gross
        router.protectERC20(address(usdc), gross, OC, SECRET, _noteData(1), 4_950e6);
        vm.stopPrank();
        assertEq(usdc.balanceOf(alice), 0);
        assertEq(usdc.balanceOf(feeRecipient), 50e6, "the spec's example: 50 USDC");
        assertEq(usdc.balanceOf(address(vault)), 4_950e6);
        assertEq(vault.accountedDeposits(), 4_950e6, "the note is the net");
        assertEq(usdc.balanceOf(address(router)), 0, "nothing stays in the router");
        assertEq(usdc.allowance(address(router), address(vault)), 0, "no allowance left behind");
        assertEq(usdc.allowance(alice, address(router)), 0);
        assertTrue(vault.isSolvent());
    }

    function test_NoReturnTokenAccepted() public {
        NoReturnToken usdt = new NoReturnToken(); // USDT-style: no return values
        ERC20AssetVault vault = _vault(address(usdt));
        usdt.mint(alice, 1_000e6);
        vm.startPrank(alice);
        usdt.approve(address(router), 1_000e6);
        router.protectERC20(address(usdt), 1_000e6, OC, SECRET, _noteData(1), 990e6);
        vm.stopPrank();
        assertEq(usdt.balanceOf(feeRecipient), 10e6);
        assertEq(vault.accountedDeposits(), 990e6);
    }

    function test_FalseReturnTokenRefused() public {
        FalseReturnToken t = new FalseReturnToken();
        _vault(address(t));
        t.mint(alice, 1_000);
        vm.startPrank(alice);
        t.approve(address(router), 1_000);
        vm.expectRevert(ProtectRouter.TokenTransferFailed.selector);
        router.protectERC20(address(t), 1_000, OC, SECRET, _noteData(1), 990);
        vm.stopPrank();
    }

    function test_FeeOnTransferTokenRefused() public {
        FeeOnTransferToken t = new FeeOnTransferToken();
        _vault(address(t));
        t.mint(alice, 10_000);
        vm.startPrank(alice);
        t.approve(address(router), 10_000);
        vm.expectRevert(ProtectRouter.UnsupportedToken.selector);
        router.protectERC20(address(t), 10_000, OC, SECRET, _noteData(1), 9_900);
        vm.stopPrank();
    }

    function test_BlacklistedFeeRecipientRefused() public {
        BlacklistToken t = new BlacklistToken();
        _vault(address(t));
        t.blacklist(feeRecipient);
        t.mint(alice, 10_000);
        vm.startPrank(alice);
        t.approve(address(router), 10_000);
        vm.expectRevert(ProtectRouter.FeeTransferFailed.selector);
        router.protectERC20(address(t), 10_000, OC, SECRET, _noteData(1), 9_900);
        vm.stopPrank();
        assertEq(t.balanceOf(alice), 10_000, "nothing moved");
    }

    function test_NoERC20VaultRefused() public {
        ERC20Mock t = new ERC20Mock(); // no vault created for it
        t.mint(alice, 10_000);
        vm.startPrank(alice);
        t.approve(address(router), 10_000);
        vm.expectRevert(ProtectRouter.NoVault.selector);
        router.protectERC20(address(t), 10_000, OC, SECRET, _noteData(1), 9_900);
        vm.expectRevert(ProtectRouter.NoVault.selector); // the native asset only through protectETH
        router.protectERC20(address(0), 10_000, OC, SECRET, _noteData(1), 9_900);
        vm.stopPrank();
    }

    function test_InsufficientAllowanceRefused() public {
        ERC20Mock t = new ERC20Mock();
        _vault(address(t));
        t.mint(alice, 10_000);
        vm.startPrank(alice);
        t.approve(address(router), 9_999);
        vm.expectRevert(ProtectRouter.TokenTransferFailed.selector);
        router.protectERC20(address(t), 10_000, OC, SECRET, _noteData(1), 9_900);
        vm.stopPrank();
    }

    function test_ReentryRefused() public {
        ReentrantToken t = new ReentrantToken();
        _vault(address(t));
        t.mint(alice, 20_000);
        // the token re-enters the router during the pull: the guard refuses, the strict pull reverts the whole protect
        t.arm(address(router), abi.encodeWithSelector(ProtectRouter.protectERC20.selector, address(t), 10_000, OC, SECRET, _noteData(2), 9_900));
        vm.startPrank(alice);
        t.approve(address(router), 20_000);
        vm.expectRevert(ProtectRouter.TokenTransferFailed.selector);
        router.protectERC20(address(t), 10_000, OC, SECRET, _noteData(1), 9_900);
        vm.stopPrank();
        assertEq(t.balanceOf(alice), 20_000, "nothing moved");
    }

    function testFuzz_ProtectERC20Conserves(uint256 gross) public {
        gross = 2 + (gross % (2 ** 128)); // net ≥ 1
        ERC20Mock t = new ERC20Mock();
        ERC20AssetVault vault = _vault(address(t));
        t.mint(alice, gross);
        uint256 fee = router.feeOf(gross);
        vm.startPrank(alice);
        t.approve(address(router), gross);
        router.protectERC20(address(t), gross, OC, SECRET, _noteData(gross), gross - fee);
        vm.stopPrank();
        assertEq(t.balanceOf(feeRecipient) + t.balanceOf(address(vault)), gross, "fee + net == gross");
        assertEq(t.balanceOf(address(router)), 0);
    }

    // ---- the vector shared with TypeScript (packages/protocol/test/fees-v2.test.ts) -----------------------------------

    function _vectorJson() internal view returns (string memory json) {
        uint256[17] memory grosses = [
            uint256(1), 99, 100, 101, 9_999, 10_000, 10_001, 1e6, 1_000e6, 5_000e6, 10_000e6, 100_000e6, 1e8, 1e18,
            1_000e18, 2 ** 200, type(uint256).max
        ];
        json = string.concat('{"feeBps":', vm.toString(router.FEE_BPS()), ',"cases":[');
        for (uint256 i; i < grosses.length; ++i) {
            json = string.concat(
                json, i == 0 ? "" : ",", '{"gross":"', vm.toString(grosses[i]), '","fee":"', vm.toString(router.feeOf(grosses[i])), '"}'
            );
        }
        json = string.concat(json, "]}\n");
    }

    /// PROTECT_VECTOR=true rewrites the committed vector; otherwise the committed one must match the contract.
    function test_ProtectFeeVectorIsCurrent() public {
        string memory json = _vectorJson();
        if (vm.envOr("PROTECT_VECTOR", false)) vm.writeFile("test/periphery/vectors/protect-fee.json", json);
        assertEq(vm.readFile("test/periphery/vectors/protect-fee.json"), json, "protect-fee.json is the contract's fee");
    }
}

/// A fee recipient that refuses ETH.
contract Refuser {
    receive() external payable {
        revert("no");
    }
}
