// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PPTestBase} from "../PPTestBase.sol";
import {CoreTypes} from "../../src/core/CoreTypes.sol";

contract SmokeTest is PPTestBase {
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    function setUp() public {
        _deployCore();
    }

    function test_DepositThenWithdraw_Native() public {
        _depositNative(alice, 1 ether, 123);
        assertEq(address(nativeVault).balance, 1 ether, "vault holds ETH");
        assertEq(address(core).balance, 0, "core holds NO ETH");
        assertEq(nativeVault.accountedDeposits(), 1 ether);
        assertEq(core.nextLeafIndex(), 4, "a deposit consumes one aligned group of 4 leaves");

        CoreTypes.PublicInputs memory pi = _withdrawPI(address(nativeVault), bob, 1 ether, 111, 222);
        _transact(pi);

        assertEq(bob.balance, 1 ether, "recipient paid");
        assertEq(address(nativeVault).balance, 0, "vault drained");
        assertEq(nativeVault.accountedDeposits(), 0);
        assertTrue(core.isNullifierSpent(111));
        assertTrue(core.isNullifierSpent(222));
        assertEq(core.nextLeafIndex(), 8, "a transaction consumes one aligned group of 4 leaves");
    }

    function test_DoubleSpend_Reverts() public {
        _depositNative(alice, 1 ether, 123);
        CoreTypes.PublicInputs memory pi = _withdrawPI(address(nativeVault), bob, 1 ether, 111, 222);
        _transact(pi);

        // Replaying the same nullifiers must revert (spent), before any payout.
        _accept(pi);
        vm.expectRevert(abi.encodeWithSelector(CoreTypes.SpentNullifier.selector, uint256(111)));
        _transactRaw(pi);
    }

    function test_CoreHoldsNoAssets_AfterDeposit() public {
        _depositNative(alice, 5 ether, 7);
        assertEq(address(core).balance, 0, "core never custodies ETH");
    }

    function test_Identifiers() public view {
        assertEq(core.PROTOCOL_ID(), keccak256("privacy-protocol/v1.0"));
        assertEq(core.HASH_ID(), keccak256("poseidon2-bn254-t4-rf8-rp56/noir-sponge/v1"));
        assertEq(core.NOTE_DATA_BYTES(), 169);
        assertEq(core.EXECUTION_CHAIN_ID(), block.chainid);
        assertTrue(core.TX_DOMAIN() < FIELD, "txDomain is a field element");
    }
}
