// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PPTestBase} from "../PPTestBase.sol";

/// The wallet reads the pool by storage proof under a light-client-verified header
/// (frontend/src/sdk/verifiedReads.ts): slot 0 holds nextLeafIndex (uint32, the low bytes), slot 1
/// currentRoot, and a nullifier's spent flag sits at keccak256(nullifier ‖ 8) (mapping spentNullifier).
/// PrivacyCore is immutable, so this layout never changes; this test ties the wallet's constants to it.
contract StorageLayoutTest is PPTestBase {
    function setUp() public {
        _deployCore();
    }

    function test_PoolSlots_MatchTheWalletsLightClientReads() public {
        _depositNative(address(0xA11CE), 1 ether, 1);
        _depositNative(address(0xB0B), 1 ether, 2);
        uint256 slot0 = uint256(vm.load(address(core), bytes32(uint256(0))));
        assertEq(slot0 & type(uint32).max, uint256(core.nextLeafIndex()), "slot 0 (low 32 bits) is nextLeafIndex");
        assertTrue(core.nextLeafIndex() > 0);
        assertEq(vm.load(address(core), bytes32(uint256(1))), core.currentRoot(), "slot 1 is currentRoot");
    }

    function test_SpentNullifierSlot_MatchesTheWalletsLightClientReads() public {
        _depositNative(address(0xA11CE), 1 ether, 1);
        uint256 nf = 0xBEEF;
        assertEq(uint256(vm.load(address(core), keccak256(abi.encode(nf, uint256(8))))), 0, "unspent: zero");
        _transact(_withdrawPI(address(nativeVault), address(0xB0B), 0.1 ether, nf, nf + 1));
        assertTrue(core.isNullifierSpent(nf));
        assertEq(uint256(vm.load(address(core), keccak256(abi.encode(nf, uint256(8))))), 1, "spent: keccak256(nullifier, 8) holds true");
    }
}
