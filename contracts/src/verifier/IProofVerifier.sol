// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IProofVerifier
/// @notice The proof system is pluggable behind this interface (spec §54: do not finalize
/// the proof system by ideology — benchmark Groth16 / Halo2 / Plonkish / FRI and pick later).
/// Whatever wins, the deployed verifier is IMMUTABLE and bound into PrivacyCore at construction.
interface IProofVerifier {
    /// @param publicInputs the frozen public-input vector (see PrivacyCore.encodePublicInputs)
    /// @param proof opaque proof bytes for the chosen system
    /// @return true iff the proof is valid for exactly these public inputs
    function verify(uint256[] calldata publicInputs, bytes calldata proof) external view returns (bool);
}
