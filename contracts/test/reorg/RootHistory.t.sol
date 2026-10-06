// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PPTestBase} from "../PPTestBase.sol";
import {CoreTypes} from "../../src/core/CoreTypes.sol";

/// Block-based root history (spec §9; fixes the TC-10 "liveness cliff" and TC-14). A root's
/// validity depends on BLOCKS elapsed, not on how many insertions happened after it.
contract RootHistoryTest is PPTestBase {
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    function setUp() public {
        _deployCore();
    }

    function test_OldRootStaysValid_DespiteManyDeposits() public {
        _depositNative(alice, 1 ether, 1);
        bytes32 r0 = core.currentRoot();

        // 40 more deposits in the SAME block window. Under Tornado's 30-deposit ring this root
        // would already be dead; here it stays valid because only blocks matter.
        for (uint256 i = 0; i < 40; i++) {
            _depositNative(alice, 1, 100 + i);
        }
        assertTrue(core.isKnownRoot(r0), "old root still valid after 40 deposits");

        CoreTypes.PublicInputs memory pi = _withdrawPI(address(nativeVault), bob, 1 ether, 11, 12);
        pi.root = uint256(r0); // prove against the OLD root
        _transact(pi);
        assertEq(bob.balance, 1 ether, "withdrawal against an old-but-recent root succeeds");
    }

    function test_RootExpiresAfterBlockWindow() public {
        _depositNative(alice, 1 ether, 1);
        bytes32 r0 = core.currentRoot();
        _depositNative(alice, 1 ether, 2); // advance so r0 is no longer the current root
        assertTrue(core.isKnownRoot(r0));

        vm.roll(block.number + core.ROOT_HISTORY_BLOCKS() + 1);
        assertFalse(core.isKnownRoot(r0), "root expired by the block window");

        CoreTypes.PublicInputs memory pi = _withdrawPI(address(nativeVault), bob, 1 ether, 11, 12);
        pi.root = uint256(r0);
        _accept(pi);
        vm.expectRevert(CoreTypes.UnknownRoot.selector);
        _transactRaw(pi);
    }

    /// Plan §78 (forge part): root maintenance stays correct and bounded as the tree fills.
    function test_RootStress_1000Inserts() public {
        uint256 len0 = core.rootHistoryLength();
        for (uint256 i = 0; i < 250; i++) {
            _depositNative(alice, 1, 1000 + i); // 250 groups = 1,000 leaves of a 1,024-leaf tree
        }
        assertEq(core.nextLeafIndex(), 1000);
        assertEq(core.rootHistoryLength(), len0 + 250, "one new root per insertion");
        assertTrue(core.isKnownRoot(core.currentRoot()));
        // The tree is depth 10 here (1,024 leaves, 1,020 usable): the 255th group must be refused.
        for (uint256 i = 0; i < 5; i++) {
            _depositNative(alice, 1, 2000 + i);
        }
        assertEq(core.nextLeafIndex(), 1020);
        vm.deal(alice, 1);
        vm.prank(alice);
        vm.expectRevert(bytes4(keccak256("TreeFull()")));
        nativeVault.deposit{value: 1}(7, 8, _noteData(7));
    }
}
