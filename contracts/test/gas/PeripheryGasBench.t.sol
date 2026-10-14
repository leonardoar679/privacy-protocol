// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "../utils/MiniTest.sol";
import {PrivacyCore} from "../../src/core/PrivacyCore.sol";
import {CoreTypes} from "../../src/core/CoreTypes.sol";
import {AssetVaultFactory} from "../../src/factory/AssetVaultFactory.sol";
import {NativeAssetVault} from "../../src/vault/NativeAssetVault.sol";
import {ERC20AssetVault} from "../../src/vault/ERC20AssetVault.sol";
import {Poseidon2Hasher} from "../../src/hasher/Poseidon2Hasher.sol";
import {ProtectRouter} from "../../src/periphery/protect/ProtectRouter.sol";
import {SwapOrderTypes as T} from "../../src/periphery/swap/SwapOrderTypes.sol";
import {SwapOrderFactory} from "../../src/periphery/swap/SwapOrderFactory.sol";
import {MockSwapProvider} from "../mocks/MockSwapProvider.sol";
import {ShieldReceiverFactory} from "../../src/periphery/shield/ShieldReceiverFactory.sol";
import {ShieldReceiverTypes as S} from "../../src/periphery/shield/ShieldReceiverTypes.sol";
import {MockVerifier} from "../mocks/MockVerifier.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";

/// The gas units the wallet and the services price with (Privacy Wallet Web spec v2.0 §3): a protect through the
/// router (ETH and ERC-20) beside a direct deposit, and a swap escrow's two endings — the executor's
/// deployAndExecute (a minimal provider call: packages/swap-engine adds the provider's own allowance) and the refund
/// that re-shields the order — and (V6 Stage 12) a same-chain swap's receiver deployed and shielded, ETH and ERC-20.
/// Production configuration (real Poseidon2, depth 32), steady state (the average of 8
/// after a cold first call). Units only — a cost is units × the live fee history, never a fixed gas price.
/// packages/contracts/src/gas.ts pins these (its test reads test/periphery/vectors/gas.json, which
/// GAS_VECTOR=true rewrites and test_GasVectorIsCurrent keeps current).
contract PeripheryGasBenchTest is Test {
    PrivacyCore internal core;
    AssetVaultFactory internal factory;
    NativeAssetVault internal nativeVault;
    ERC20AssetVault internal tokenVault;
    ERC20Mock internal token;
    ProtectRouter internal router;
    SwapOrderFactory internal swapFactory;
    MockSwapProvider internal provider;
    ShieldReceiverFactory internal shieldFactory;

    address internal alice = address(0xA11CE);
    address internal executor = address(0xE8EC);
    uint256 internal constant ORDER_KEY = 0xA11CE0;
    uint256 internal n = 1;
    bytes internal noteData = new bytes(CoreTypes.NOTE_DATA_BYTES);

    struct Units {
        uint256 deposit;
        uint256 protectETH;
        uint256 protectERC20;
        uint256 escrowExecuteETH;
        uint256 escrowRefundETH;
        uint256 shieldETH;
        uint256 shieldERC20;
    }

    function setUp() public {
        MockVerifier verifier = new MockVerifier();
        core = new PrivacyCore(verifier, new Poseidon2Hasher(), 32);
        factory = AssetVaultFactory(core.VAULT_FACTORY());
        nativeVault = NativeAssetVault(payable(factory.getOrCreateNativeVault()));
        token = new ERC20Mock();
        tokenVault = ERC20AssetVault(factory.getOrCreateERC20Vault(address(token)));
        router = new ProtectRouter(address(core), address(0xFEE5));
        swapFactory = new SwapOrderFactory(address(0));
        provider = new MockSwapProvider();
        shieldFactory = new ShieldReceiverFactory(address(factory), address(0));
        vm.deal(alice, 1_000 ether);
        token.mint(alice, 1_000_000e6);
        vm.roll(1_000);
    }

    function _deposit() internal returns (uint256 gas) {
        vm.prank(alice);
        uint256 g0 = gasleft();
        nativeVault.deposit{value: 1 ether}(n++, n++, noteData);
        gas = g0 - gasleft();
    }

    function _protectETH() internal returns (uint256 gas) {
        vm.prank(alice);
        uint256 g0 = gasleft();
        router.protectETH{value: 1 ether}(n++, n++, noteData, 0.99 ether);
        gas = g0 - gasleft();
    }

    function _protectERC20() internal returns (uint256 gas) {
        vm.startPrank(alice);
        token.approve(address(router), 1_000e6);
        uint256 g0 = gasleft();
        router.protectERC20(address(token), 1_000e6, n++, n++, noteData, 990e6);
        gas = g0 - gasleft();
        vm.stopPrank();
    }

    function _order(uint256 salt) internal view returns (T.OrderParams memory p) {
        p.orderId = keccak256(abi.encode("bench", salt));
        p.assetType = T.ASSET_ETH;
        p.amount = 1 ether;
        p.orderSigner = vm.addr(ORDER_KEY);
        p.executeDeadline = uint64(block.timestamp + 30 minutes);
        p.refundAfter = uint64(block.timestamp + 2 hours);
        p.refundVault = address(nativeVault);
        p.refundOwnerCommitment = 777 + salt;
        p.refundNoteSecret = 778 + salt;
        p.refundNoteDataHash = keccak256(noteData);
        p.executorTip = 0.002 ether;
    }

    function _escrowExecute(uint256 salt) internal returns (uint256 gas) {
        T.OrderParams memory p = _order(salt);
        address escrow = swapFactory.predict(p);
        vm.deal(escrow, p.amount); // the private withdrawal that funds it (measured on its own: transact)
        uint256 value = p.amount - p.executorTip;
        bytes memory cd = abi.encodeWithSelector(MockSwapProvider.depositWithExpiry.selector, address(0xB0B), address(0), value, "=:BTC.BTC:bc1q:1", block.timestamp + 1 hours);
        uint64 deadline = uint64(block.timestamp + 20 minutes);
        bytes32 digest = keccak256(abi.encode(T.EXECUTE_TAG, block.chainid, escrow, p.orderId, address(provider), value, keccak256(cd), deadline));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ORDER_KEY, digest);
        T.Execution memory x = T.Execution({provider: address(provider), value: value, providerCalldata: cd, deadline: deadline, signature: abi.encodePacked(r, s, v)});
        vm.prank(executor);
        uint256 g0 = gasleft();
        swapFactory.deployAndExecute(p, x);
        gas = g0 - gasleft();
    }

    function _escrowRefund(uint256 salt) internal returns (uint256 gas) {
        T.OrderParams memory p = _order(1_000 + salt);
        vm.deal(swapFactory.predict(p), p.amount);
        vm.warp(p.refundAfter);
        vm.prank(executor);
        uint256 g0 = gasleft();
        swapFactory.deployAndRefund(p, noteData);
        gas = g0 - gasleft();
    }

    function _receipt(uint256 salt, address asset, uint256 min) internal view returns (S.ReceiverParams memory p) {
        p.receiptId = keccak256(abi.encode("bench-shield", salt, asset));
        p.asset = asset;
        p.minAmount = min;
        p.shieldTip = min / 100;
        p.ownerCommitment = 900 + salt;
        p.noteSecret = 901 + salt;
        p.noteDataHash = keccak256(noteData);
        p.fallbackRecipient = alice;
    }

    function _shieldETH(uint256 salt) internal returns (uint256 gas) {
        S.ReceiverParams memory p = _receipt(salt, address(0), 1 ether);
        vm.deal(shieldFactory.predict(p), 1 ether); // the provider's delivery
        vm.prank(executor);
        uint256 g0 = gasleft();
        shieldFactory.deployAndShield(p, noteData);
        gas = g0 - gasleft();
    }

    function _shieldERC20(uint256 salt) internal returns (uint256 gas) {
        S.ReceiverParams memory p = _receipt(salt, address(token), 1_000e6);
        token.mint(shieldFactory.predict(p), 1_000e6);
        vm.prank(executor);
        uint256 g0 = gasleft();
        shieldFactory.deployAndShield(p, noteData);
        gas = g0 - gasleft();
    }

    function _measure() internal returns (Units memory u) {
        _deposit();
        _protectETH();
        _protectERC20();
        _escrowExecute(0);
        _escrowRefund(0);
        _shieldETH(0);
        _shieldERC20(0);
        for (uint256 i = 1; i <= 8; ++i) {
            u.deposit += _deposit();
            u.protectETH += _protectETH();
            u.protectERC20 += _protectERC20();
            u.escrowExecuteETH += _escrowExecute(i);
            u.escrowRefundETH += _escrowRefund(i);
            u.shieldETH += _shieldETH(i);
            u.shieldERC20 += _shieldERC20(i);
        }
        u.deposit /= 8;
        u.protectETH /= 8;
        u.protectERC20 /= 8;
        u.escrowExecuteETH /= 8;
        u.escrowRefundETH /= 8;
        u.shieldETH /= 8;
        u.shieldERC20 /= 8;
    }

    function _json(Units memory u) internal pure returns (string memory) {
        return string.concat(
            '{"deposit":', vm.toString(u.deposit), ',"protectETH":', vm.toString(u.protectETH), ',"protectERC20":', vm.toString(u.protectERC20),
            ',"escrowExecuteETH":', vm.toString(u.escrowExecuteETH), ',"escrowRefundETH":', vm.toString(u.escrowRefundETH),
            ',"shieldETH":', vm.toString(u.shieldETH), ',"shieldERC20":', vm.toString(u.shieldERC20), "}\n"
        );
    }

    /// GAS_VECTOR=true rewrites the committed vector; otherwise the committed one must equal this run's measurement.
    function test_GasVectorIsCurrent() public {
        Units memory u = _measure();
        log("deposit        steady-state", u.deposit);
        log("protectETH     steady-state", u.protectETH);
        log("protectERC20   steady-state", u.protectERC20);
        log("escrow execute (ETH, minimal provider call)", u.escrowExecuteETH);
        log("escrow refund  (ETH, re-shield)", u.escrowRefundETH);
        log("shield receiver (ETH: deploy, tip, deposit)", u.shieldETH);
        log("shield receiver (ERC-20: deploy, tip, deposit)", u.shieldERC20);
        assertTrue(u.protectETH > u.deposit && u.protectETH - u.deposit < 60_000, "the router adds a fee transfer, not a second deposit");
        string memory json = _json(u);
        if (vm.envOr("GAS_VECTOR", false)) vm.writeFile("test/periphery/vectors/gas.json", json);
        assertEq(vm.readFile("test/periphery/vectors/gas.json"), json, "gas.json is this build's measurement");
    }
}
