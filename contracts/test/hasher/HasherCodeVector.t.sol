// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "../utils/MiniTest.sol";
import {Poseidon2Hasher} from "../../src/hasher/Poseidon2Hasher.sol";

/// The Poseidon2 hasher's runtime code hash, as this build compiles it (the eleventh review round's first critique of slice 5): the wallet's
/// deployment check requires a core's HASHER to carry this code (packages/contracts HASHER_CODEHASH, read from
/// contracts/abi/runtime/Poseidon2Hasher.json, which scripts/export-abi.mjs writes). HASHER_VECTOR=true rewrites
/// test/periphery/vectors/hasher.json; otherwise this build must hash to what it says — and the TypeScript test holds the export to it, so
/// a hasher or compile-profile change that is not exported again fails here and there, never only on a real deployment.
contract HasherCodeVectorTest is Test {
    function test_HasherRuntimeCodeHashIsThisBuilds() public {
        string memory json = string.concat('{"poseidon2HasherRuntimeCodeHash":"', vm.toString(keccak256(type(Poseidon2Hasher).runtimeCode)), '"}\n');
        if (vm.envOr("HASHER_VECTOR", false)) vm.writeFile("test/periphery/vectors/hasher.json", json);
        assertEq(vm.readFile("test/periphery/vectors/hasher.json"), json, "hasher.json is this build's");
    }
}
