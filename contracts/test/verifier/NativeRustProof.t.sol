// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "../utils/MiniTest.sol";
import {Groth16Verifier, ITransactionGroth16Verifier} from "../../src/verifier/Groth16Verifier.sol";
import {IProofVerifier} from "../../src/verifier/IProofVerifier.sol";
import {TransactionVerifierDev} from "../../src/verifier/dev/TransactionVerifierDev.sol";
import {NativeProofFixtures as N} from "./NativeProofFixtures.sol";
import {DevProofFixtures as S} from "./DevProofFixtures.sol";

/// Proofs made by the NATIVE Rust prover (core/rust/privacy-prover: the snarkjs proving key read
/// natively, arkworks Groth16 with the snarkjs QAP reduction) checked by the same on-chain verifier
/// PrivacyCore calls. The mobile / desktop wallets (plan §40) prove with that crate; this closes its
/// loop to the EVM exactly as Groth16RealProof does for snarkjs. The Rust test
/// native_proofs_are_the_ones_the_evm_verifier_accepts pins these bytes to the prover's output.
contract NativeRustProofTest is Test {
    uint256 internal constant R = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    IProofVerifier internal verifier;

    function setUp() public {
        verifier = new Groth16Verifier(ITransactionGroth16Verifier(address(new TransactionVerifierDev())));
    }

    function _pub(uint256[14] memory p) internal pure returns (uint256[] memory out) {
        out = new uint256[](14);
        for (uint256 i; i < 14; ++i) {
            out[i] = p[i];
        }
    }

    function _proof(N.Fixture memory f) internal pure returns (bytes memory) {
        return abi.encode(f.a, f.b, f.c);
    }

    function test_NativeTransferProofVerifiesOnChain() public view {
        N.Fixture memory f = N.transfer();
        assertTrue(verifier.verify(_pub(f.pub), _proof(f)), "native transfer proof verifies on-chain");
    }

    function test_NativeWithdrawProofVerifiesOnChain() public view {
        N.Fixture memory f = N.withdraw();
        assertTrue(verifier.verify(_pub(f.pub), _proof(f)), "native withdraw proof verifies on-chain");
    }

    /// Same statements as the snarkjs fixtures (the v1 ok-transfer / ok-withdraw witnesses), different
    /// proof bytes: two independent provers, one verifier.
    function test_SameStatementsAsSnarkjs_DifferentProofs() public pure {
        N.Fixture memory n = N.transfer();
        S.Fixture memory s = S.transfer();
        for (uint256 i; i < 14; ++i) {
            assertEq(n.pub[i], s.pub[i], "same public inputs as the snarkjs transfer proof");
        }
        assertTrue(n.a[0] != s.a[0] || n.a[1] != s.a[1], "a different proof");
        N.Fixture memory nw = N.withdraw();
        S.Fixture memory sw = S.withdraw();
        for (uint256 i; i < 14; ++i) {
            assertEq(nw.pub[i], sw.pub[i], "same public inputs as the snarkjs withdraw proof");
        }
    }

    /// Every public input is bound: changing any single one invalidates the native proof.
    function test_NativeProof_EveryPublicInputIsBound() public view {
        N.Fixture memory f = N.withdraw();
        for (uint256 k; k < 14; ++k) {
            uint256[] memory p = _pub(f.pub);
            p[k] = addmod(p[k], 1, R);
            assertFalse(verifier.verify(p, _proof(f)), "tampered public input accepted");
        }
    }

    /// A native proof of one statement does not verify for another (no cross-statement replay).
    function test_NativeProof_NotValidForAnotherStatement() public view {
        N.Fixture memory t = N.transfer();
        N.Fixture memory w = N.withdraw();
        assertFalse(verifier.verify(_pub(w.pub), _proof(t)), "transfer proof accepted for the withdraw");
        assertFalse(verifier.verify(_pub(t.pub), _proof(w)), "withdraw proof accepted for the transfer");
    }
}
