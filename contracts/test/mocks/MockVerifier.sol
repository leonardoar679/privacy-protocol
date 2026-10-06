// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IProofVerifier} from "../../src/verifier/IProofVerifier.sol";

/// @dev Test verifier. `acceptAll` enables happy-path flows; `setAccepted` whitelists an EXACT
/// public-input vector so tampering any field (recipient/amount/vault/root/...) flips the keccak
/// and the proof is rejected — modelling a proof's binding to its public inputs (spec §60, §86).
contract MockVerifier is IProofVerifier {
    bool public acceptAll;
    mapping(bytes32 => bool) public accepted;

    function setAcceptAll(bool v) external {
        acceptAll = v;
    }

    function setAccepted(uint256[] memory publicInputs, bool v) external {
        accepted[keccak256(abi.encode(publicInputs))] = v;
    }

    function verify(uint256[] calldata publicInputs, bytes calldata) external view returns (bool) {
        if (acceptAll) return true;
        return accepted[keccak256(abi.encode(publicInputs))];
    }
}
