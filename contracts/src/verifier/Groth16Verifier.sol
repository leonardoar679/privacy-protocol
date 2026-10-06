// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IProofVerifier} from "./IProofVerifier.sol";
import {CoreTypes} from "../core/CoreTypes.sol";

/// @notice Shape of the snarkjs-generated Groth16 verifier for circuits/transaction.circom
/// (14 public inputs, in PrivacyCore.encodePublicInputs order).
interface ITransactionGroth16Verifier {
    function verifyProof(
        uint256[2] calldata pA,
        uint256[2][2] calldata pB,
        uint256[2] calldata pC,
        uint256[14] calldata pubSignals
    ) external view returns (bool);
}

/// @title Groth16Verifier
/// @notice IProofVerifier adapter over a snarkjs-generated Groth16 verifier (spec §11).
/// `proof` = abi.encode(uint256[2] a, uint256[2][2] b, uint256[2] c), exactly as snarkjs
/// `exportSolidityCallData` emits them (G2 limbs already ordered for the EVM pairing precompile).
/// The inner verifier is IMMUTABLE and fixes the verifying key: production binds the one generated
/// from the multi-party ceremony over the finalized circuit; tests bind
/// verifier/dev/TransactionVerifierDev, which is INSECURE by design (public-beacon setup).
/// Fail-closed: a malformed proof reverts, an invalid one returns false.
contract Groth16Verifier is IProofVerifier {
    error BadPublicInputCount();
    error InnerNotContract();

    uint256 public constant N_PUBLIC = 14; // == CoreTypes.N_PUBLIC_INPUTS (fixed-size array bound)
    ITransactionGroth16Verifier public immutable INNER;

    constructor(ITransactionGroth16Verifier inner) {
        if (address(inner).code.length == 0) revert InnerNotContract();
        assert(N_PUBLIC == CoreTypes.N_PUBLIC_INPUTS);
        INNER = inner;
    }

    function verify(uint256[] calldata publicInputs, bytes calldata proof) external view returns (bool) {
        if (publicInputs.length != N_PUBLIC) revert BadPublicInputCount();
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) =
            abi.decode(proof, (uint256[2], uint256[2][2], uint256[2]));
        uint256[N_PUBLIC] memory pub;
        for (uint256 i; i < N_PUBLIC; ++i) {
            pub[i] = publicInputs[i];
        }
        return INNER.verifyProof(a, b, c, pub);
    }
}
