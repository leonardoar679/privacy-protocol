//! Prove and verify with the parsed proving key. The witness is the full assignment (constant 1,
//! the public inputs, the private signals) — what `.wtns` holds or what a witness calculator
//! produces. The blinding scalars r and s are the caller's randomness (any 32 bytes from a CSPRNG;
//! fixed bytes give a deterministic proof, which the fixtures rely on).
use crate::qap::CircomReduction;
use crate::zkey::Zkey;
use ark_bn254::{Bn254, Fr};
use ark_ff::{PrimeField, Zero};
use ark_groth16::{prepare_verifying_key, Groth16, Proof, VerifyingKey};

#[derive(Debug, PartialEq, Eq)]
pub enum ProveError {
    WitnessLength { expected: usize, got: usize },
    NoConstantOne,
    /// r = 0 or s = 0 removes the blinding: the proof would no longer hide the witness
    ZeroBlinding,
    Synthesis(String),
}

/// A scalar from 32 caller-supplied bytes (reduced mod r).
pub fn fr_from_bytes(b: &[u8; 32]) -> Fr {
    Fr::from_be_bytes_mod_order(b)
}

/// The public inputs the witness declares: elements 1..=nPublic, in circuit order.
pub fn public_inputs<'a>(zkey: &Zkey, witness: &'a [Fr]) -> &'a [Fr] {
    &witness[1..=zkey.n_public]
}

pub fn prove(zkey: &Zkey, witness: &[Fr], r: Fr, s: Fr) -> Result<Proof<Bn254>, ProveError> {
    if witness.len() != zkey.n_vars {
        return Err(ProveError::WitnessLength { expected: zkey.n_vars, got: witness.len() });
    }
    if witness[0] != Fr::from(1u64) {
        return Err(ProveError::NoConstantOne);
    }
    if r.is_zero() || s.is_zero() {
        return Err(ProveError::ZeroBlinding);
    }
    Groth16::<Bn254, CircomReduction>::create_proof_with_reduction_and_matrices(&zkey.pk, r, s, &zkey.matrices, zkey.matrices.num_instance_variables, zkey.matrices.num_constraints, witness)
        .map_err(|e| ProveError::Synthesis(format!("{e:?}")))
}

pub fn verify(vk: &VerifyingKey<Bn254>, proof: &Proof<Bn254>, public_inputs: &[Fr]) -> bool {
    let pvk = prepare_verifying_key(vk);
    Groth16::<Bn254, CircomReduction>::verify_proof(&pvk, proof, public_inputs).unwrap_or(false)
}
