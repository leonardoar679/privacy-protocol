// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PPTestBase} from "../PPTestBase.sol";

/// The wallet reads the pool by storage proof under a light-client-verified header
/// (frontend/src/sdk/verifiedReads.ts): slot 0 holds nextLeafIndex (uint32, the low bytes), slot 1
/// currentRoot. PrivacyCore is immutable, so this layout never changes; this test ties the wallet's
/// constants to the contract.
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
}
