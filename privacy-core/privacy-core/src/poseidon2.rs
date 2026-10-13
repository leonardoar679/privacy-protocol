//! Poseidon2 over BN254, t = 4, R_F = 8, R_P = 56 — the hash the circuit (Noir/barretenberg blackbox),
//! the contracts (`Poseidon2.sol`) and the TypeScript client compute; this is the fourth copy and it
//! must agree bit for bit (pinned by the nargo vectors in circuits/vectors/primitives.json).
//! Sponge: state `[0, 0, 0, n·2^64]`, rate 3, Noir's rule that the final permutation is skipped
//! when the input exactly fills the rate.
use crate::field::Fr;
use crate::poseidon2_constants::{D, RC};
use ark_ff::Zero;

const RATE: usize = 3;

#[inline]
fn pow5(x: Fr) -> Fr {
    let x2 = x * x;
    let x4 = x2 * x2;
    x4 * x
}

/// The t=4 external (M4) matrix, matching bb's matmul_external.
fn external(s: &mut [Fr; 4]) {
    let four = Fr::from(4u64);
    let t0 = s[0] + s[1];
    let t1 = s[2] + s[3];
    let t2 = s[1] + s[1] + t1;
    let t3 = s[3] + s[3] + t0;
    let t4 = four * t1 + t3;
    let t5 = four * t0 + t2;
    s[0] = t3 + t5;
    s[1] = t5;
    s[2] = t2 + t4;
    s[3] = t4;
}

/// s[i] = (D_i - 1) * s[i] + sum(s), matching bb's matmul_internal.
fn internal(s: &mut [Fr; 4]) {
    let sum = s[0] + s[1] + s[2] + s[3];
    for i in 0..4 {
        s[i] = s[i] * D[i] + sum;
    }
}

/// The raw t=4 permutation. Mirrors `std::hash::poseidon2_permutation`.
pub fn permute(state: &[Fr; 4]) -> [Fr; 4] {
    let mut s = *state;
    external(&mut s);
    for r in 0..4 {
        for i in 0..4 {
            s[i] = pow5(s[i] + RC[r * 4 + i]);
        }
        external(&mut s);
    }
    for r in 4..60 {
        s[0] = pow5(s[0] + RC[r * 4]);
        internal(&mut s);
    }
    for r in 60..64 {
        for i in 0..4 {
            s[i] = pow5(s[i] + RC[r * 4 + i]);
        }
        external(&mut s);
    }
    s
}

/// The sponge Noir's `Poseidon2::hash` builds on the permutation (see the module note).
pub fn hash(input: &[Fr]) -> Fr {
    let n = input.len();
    let mut st = [Fr::zero(), Fr::zero(), Fr::zero(), Fr::from(n as u64) * Fr::from(1u128 << 64)];
    let full = n / RATE;
    for c in 0..full {
        st[0] += input[c * 3];
        st[1] += input[c * 3 + 1];
        st[2] += input[c * 3 + 2];
        st = permute(&st);
    }
    let rem = n % RATE;
    if rem != 0 {
        let start = n - rem;
        st[0] += input[start];
        if rem > 1 {
            st[1] += input[start + 1];
        }
    }
    if n == 0 || rem != 0 {
        st = permute(&st);
    }
    st[0]
}

pub fn hash2(a: Fr, b: Fr) -> Fr {
    hash(&[a, b])
}
pub fn hash3(a: Fr, b: Fr, c: Fr) -> Fr {
    hash(&[a, b, c])
}
pub fn hash4(a: Fr, b: Fr, c: Fr, d: Fr) -> Fr {
    hash(&[a, b, c, d])
}
pub fn hash5(a: Fr, b: Fr, c: Fr, d: Fr, e: Fr) -> Fr {
    hash(&[a, b, c, d, e])
}
