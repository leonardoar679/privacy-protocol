//! The R1CS → QAP witness map snarkjs uses, as an arkworks `R1CSToQAP`. arkworks' own reduction
//! computes the H coefficients as (A·B − C) / Z over the evaluation domain and returns to the
//! coefficient domain; snarkjs instead precomputes the Lagrange form of the powers of τ in a domain
//! twice as large, so the witness map is the odd coefficients of (A·B − C) in that domain and the
//! proving key's H query is set up for exactly that. Port (sequential) of circom-compat's
//! `CircomReduction` (MIT / Apache-2.0); the C evaluations are A·B pointwise because snarkjs' zkey
//! carries only the A and B matrices and the witness satisfies A·B = C.
//!
//! Constraint rows are evaluated with a plain loop: arkworks' `evaluate_constraint` spawns a rayon
//! fold per row when its `parallel` feature is on, which made this step ~150× slower (0.7 s per
//! matrix against 4 ms) and dominated the whole proof.
use ark_ff::PrimeField;
use ark_groth16::r1cs_to_qap::{LibsnarkReduction, R1CSToQAP};
use ark_poly::EvaluationDomain;
use ark_relations::r1cs::{ConstraintMatrices, ConstraintSystemRef, SynthesisError};

pub struct CircomReduction;

/// ⟨row, assignment⟩ for one sparse constraint row.
#[inline]
fn row<F: PrimeField>(terms: &[(F, usize)], assignment: &[F]) -> F {
    let mut acc = F::zero();
    for (coeff, index) in terms {
        let v = assignment[*index];
        if coeff.is_one() {
            acc += v;
        } else {
            acc += v * coeff;
        }
    }
    acc
}

impl R1CSToQAP for CircomReduction {
    #[allow(clippy::type_complexity)]
    fn instance_map_with_evaluation<F: PrimeField, D: EvaluationDomain<F>>(cs: ConstraintSystemRef<F>, t: &F) -> Result<(Vec<F>, Vec<F>, Vec<F>, F, usize, usize), SynthesisError> {
        LibsnarkReduction::instance_map_with_evaluation::<F, D>(cs, t)
    }

    fn witness_map_from_matrices<F: PrimeField, D: EvaluationDomain<F>>(matrices: &ConstraintMatrices<F>, num_inputs: usize, num_constraints: usize, full_assignment: &[F]) -> Result<Vec<F>, SynthesisError> {
        let zero = F::zero();
        let domain = D::new(num_constraints + num_inputs).ok_or(SynthesisError::PolynomialDegreeTooLarge)?;
        let domain_size = domain.size();

        let mut a = vec![zero; domain_size];
        let mut b = vec![zero; domain_size];
        for i in 0..num_constraints {
            a[i] = row(&matrices.a[i], full_assignment);
            b[i] = row(&matrices.b[i], full_assignment);
        }
        a[num_constraints..num_constraints + num_inputs].clone_from_slice(&full_assignment[..num_inputs]);

        let mut c = vec![zero; domain_size];
        for i in 0..num_constraints {
            c[i] = a[i] * b[i];
        }

        domain.ifft_in_place(&mut a);
        domain.ifft_in_place(&mut b);

        let root_of_unity = {
            let domain_double = D::new(2 * domain_size).ok_or(SynthesisError::PolynomialDegreeTooLarge)?;
            domain_double.element(1)
        };
        D::distribute_powers_and_mul_by_const(&mut a, root_of_unity, F::one());
        D::distribute_powers_and_mul_by_const(&mut b, root_of_unity, F::one());

        domain.fft_in_place(&mut a);
        domain.fft_in_place(&mut b);

        let mut ab = domain.mul_polynomials_in_evaluation_domain(&a, &b);
        drop(a);
        drop(b);

        domain.ifft_in_place(&mut c);
        D::distribute_powers_and_mul_by_const(&mut c, root_of_unity, F::one());
        domain.fft_in_place(&mut c);

        for (ab_i, c_i) in ab.iter_mut().zip(c) {
            *ab_i -= &c_i;
        }
        Ok(ab)
    }

    fn h_query_scalars<F: PrimeField, D: EvaluationDomain<F>>(max_power: usize, t: F, _zt: F, delta_inverse: F) -> Result<Vec<F>, SynthesisError> {
        // the usual H query has domain-1 powers; Z has domain powers, so HZ has 2·domain−1 powers
        let mut scalars: Vec<F> = (0..2 * max_power + 1).map(|i| delta_inverse * t.pow([i as u64])).collect();
        let domain = D::new(scalars.len()).ok_or(SynthesisError::PolynomialDegreeTooLarge)?;
        domain.ifft_in_place(&mut scalars);
        Ok(scalars.into_iter().skip(1).step_by(2).collect())
    }
}
