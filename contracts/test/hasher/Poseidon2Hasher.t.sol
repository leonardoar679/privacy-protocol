// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "../utils/MiniTest.sol";
import {FieldLib} from "../../src/libraries/FieldLib.sol";
import {Poseidon2Hasher} from "../../src/hasher/Poseidon2Hasher.sol";
import {LibPoseidon2Yul} from "../../src/hasher/poseidon2/LibPoseidon2Yul.sol";
import {Poseidon2} from "../../src/hasher/poseidon2/Poseidon2.sol";

/// Known-answer tests for the pinned hash (spec §2): the production hasher, and BOTH vendored
/// implementations independently, must reproduce the nargo/barretenberg vectors — and agree with
/// each other on every arity the protocol uses. Parity with the circuit is a fund-loss-class
/// property: a mismatch means roots the circuit proves against never exist on-chain.
contract Poseidon2HasherTest is Test {
    // nargo-generated vectors (barretenberg v5.2.0)
    uint256 internal constant PERM_0000_0 = 0x18dfb8dc9b82229cff974efefc8df78b1ce96d9d844236b496785c698bc6732e;
    uint256 internal constant PERM_1234_0 = 0x224785a48a72c75e2cbb698143e71d5d41bd89a2b9a7185871e39a54ce5785b1;
    uint256 internal constant PERM_1234_3 = 0x16c877b5b9c04d873218804ccbf65d0eeb12db447f66c9ca26fec380055df7e9;
    uint256 internal constant H_0 = 0x2710144414c3a5f2354f4c08d52ed655b9fe253b4bf12cb9ad3de693d9b1db11;
    uint256 internal constant H_1 = 0x168758332d5b3e2d13be8048c8011b454590e06c44bce7f702f09103eef5a373;
    uint256 internal constant H_00 = 0x0b63a53787021a4a962a452c2921b3663aff1ffd8d5510540f8e659e782956f1;
    uint256 internal constant H_12 = 0x038682aa1cb5ae4e0a3f13da432a95c77c5c111f6f030faf9cad641ce1ed7383;
    uint256 internal constant H_000 = 0x2a5de47ed300af27b706aaa14762fc468f5cfc16cd8116eb6b09b0f2643ca2b9;
    uint256 internal constant H_123 = 0x23864adb160dddf590f1d3303683ebcb914f828e2635f6e85a32f0a1aecd3dd8;
    uint256 internal constant H_1234 = 0x130bf204a32cac1f0ace56c78b731aa3809f06df2731ebcf6b3464a15788b1b9;

    Poseidon2Hasher internal h;

    function setUp() public {
        h = new Poseidon2Hasher();
    }

    function _arr(uint256 n, uint256 base) internal pure returns (uint256[] memory x) {
        x = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            x[i] = base == 0 ? 0 : base + i;
        }
    }

    function test_Permutation_MatchesNargo() public pure {
        uint256[4] memory z = Poseidon2.permute([uint256(0), 0, 0, 0]);
        assertEq(z[0], PERM_0000_0, "permute(0,0,0,0)[0]");
        uint256[4] memory s = Poseidon2.permute([uint256(1), 2, 3, 4]);
        assertEq(s[0], PERM_1234_0, "permute(1,2,3,4)[0]");
        assertEq(s[3], PERM_1234_3, "permute(1,2,3,4)[3]");
        // the Yul library's core is the same permutation with the capacity element last
        assertEq(LibPoseidon2Yul.poseidon2_core(0, 0, 0, 0), PERM_0000_0, "yul permutation");
        assertEq(LibPoseidon2Yul.poseidon2_core(1, 2, 3, 4), PERM_1234_0, "yul permutation (1,2,3,4)");
    }

    function test_Hasher_MatchesNargo() public view {
        assertEq(h.poseidon2(_arr(1, 0)), H_0, "H(0)");
        assertEq(h.poseidon2(_arr(1, 1)), H_1, "H(1)");
        assertEq(h.poseidon2(_arr(2, 0)), H_00, "H(0,0)");
        assertEq(h.poseidon2(_arr(2, 1)), H_12, "H(1,2)");
        assertEq(h.poseidon2(_arr(3, 0)), H_000, "H(0,0,0)");
        assertEq(h.poseidon2(_arr(3, 1)), H_123, "H(1,2,3)  (exactly one full chunk: no extra permutation)");
        assertEq(h.poseidon2(_arr(4, 1)), H_1234, "H(1,2,3,4) (two permutations)");
    }

    /// The two vendored implementations agree on every arity the protocol uses (1..6), on random inputs.
    function test_YulAndSolidityAgree(uint256 a, uint256 b, uint256 c) public pure {
        a %= FieldLib.FIELD_SIZE;
        b %= FieldLib.FIELD_SIZE;
        c %= FieldLib.FIELD_SIZE;
        uint256[] memory one = new uint256[](1);
        one[0] = a;
        uint256[] memory two = new uint256[](2);
        (two[0], two[1]) = (a, b);
        uint256[] memory three = new uint256[](3);
        (three[0], three[1], three[2]) = (a, b, c);
        assertEq(LibPoseidon2Yul.hash_1(a), Poseidon2.hash(one), "hash_1");
        assertEq(LibPoseidon2Yul.hash_2(a, b), Poseidon2.hash(two), "hash_2");
        assertEq(LibPoseidon2Yul.hash_3(a, b, c), Poseidon2.hash(three), "hash_3");
    }

    /// x and x + p would hash identically if the permutation reduced its inputs.
    function test_RejectsNonCanonicalInput() public {
        uint256[] memory x = new uint256[](2);
        x[0] = FieldLib.FIELD_SIZE; // an alias of 0
        vm.expectRevert(Poseidon2Hasher.InputNotInField.selector);
        h.poseidon2(x);
    }

    function test_RejectsUnsupportedArity() public {
        vm.expectRevert(Poseidon2Hasher.UnsupportedArity.selector);
        h.poseidon2(new uint256[](7));
        vm.expectRevert(Poseidon2Hasher.UnsupportedArity.selector);
        h.poseidon2(new uint256[](0));
    }
}
