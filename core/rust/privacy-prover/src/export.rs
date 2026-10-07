//! The proof in the two forms the rest of the protocol speaks: snarkjs' JSON (`pi_a`, `pi_b`, `pi_c`
//! as decimal affine coordinates, G2 as `[[x.c0, x.c1], [y.c0, y.c1]]`, projective 1s appended) and
//! the contract calldata `abi.encode(uint256[2] a, uint256[2][2] b, uint256[2] c)` with the G2 limbs
//! swapped, exactly as snarkjs' `exportSolidityCallData` emits them and as
//! `reference/typescript/src/prover.ts` encodes them.
use ark_bn254::{Bn254, Fq, Fq2, Fr, G1Affine, G2Affine};
use ark_ec::AffineRepr;
use ark_ff::{BigInteger, PrimeField, Zero};
use ark_groth16::Proof;
use serde::{Deserialize, Serialize};
use std::str::FromStr;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProofJson {
    pub pi_a: Vec<String>,
    pub pi_b: Vec<Vec<String>>,
    pub pi_c: Vec<String>,
    pub protocol: String,
    pub curve: String,
}

/// Decimal words of the calldata: `a`, `b` (limbs swapped) and `c`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Calldata {
    pub a: [String; 2],
    pub b: [[String; 2]; 2],
    pub c: [String; 2],
}

fn dec_fq(x: &Fq) -> String {
    x.into_bigint().to_string()
}
pub fn dec_fr(x: &Fr) -> String {
    x.into_bigint().to_string()
}

fn g1_coords(p: &G1Affine) -> (Fq, Fq) {
    p.xy().map(|(x, y)| (x, y)).unwrap_or((Fq::zero(), Fq::zero()))
}
fn g2_coords(p: &G2Affine) -> (Fq2, Fq2) {
    p.xy().map(|(x, y)| (x, y)).unwrap_or((Fq2::zero(), Fq2::zero()))
}

pub fn to_snarkjs(proof: &Proof<Bn254>) -> ProofJson {
    let (ax, ay) = g1_coords(&proof.a);
    let (bx, by) = g2_coords(&proof.b);
    let (cx, cy) = g1_coords(&proof.c);
    ProofJson {
        pi_a: vec![dec_fq(&ax), dec_fq(&ay), "1".into()],
        pi_b: vec![vec![dec_fq(&bx.c0), dec_fq(&bx.c1)], vec![dec_fq(&by.c0), dec_fq(&by.c1)], vec!["1".into(), "0".into()]],
        pi_c: vec![dec_fq(&cx), dec_fq(&cy), "1".into()],
        protocol: "groth16".into(),
        curve: "bn128".into(),
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum ImportError {
    Shape,
    NotANumber,
    NotOnCurve,
}

fn fq_dec(s: &str) -> Result<Fq, ImportError> {
    Fq::from_str(s).map_err(|_| ImportError::NotANumber)
}

/// A snarkjs proof (its `fullProve` / `prove` output) as an arkworks proof.
pub fn from_snarkjs(p: &ProofJson) -> Result<Proof<Bn254>, ImportError> {
    if p.pi_a.len() < 2 || p.pi_c.len() < 2 || p.pi_b.len() < 2 || p.pi_b[0].len() != 2 || p.pi_b[1].len() != 2 {
        return Err(ImportError::Shape);
    }
    let g1 = |x: &str, y: &str| -> Result<G1Affine, ImportError> {
        let (x, y) = (fq_dec(x)?, fq_dec(y)?);
        if x.is_zero() && y.is_zero() {
            return Ok(G1Affine::identity());
        }
        let p = G1Affine::new_unchecked(x, y);
        if !p.is_on_curve() || !p.is_in_correct_subgroup_assuming_on_curve() {
            return Err(ImportError::NotOnCurve);
        }
        Ok(p)
    };
    let a = g1(&p.pi_a[0], &p.pi_a[1])?;
    let c = g1(&p.pi_c[0], &p.pi_c[1])?;
    let bx = Fq2::new(fq_dec(&p.pi_b[0][0])?, fq_dec(&p.pi_b[0][1])?);
    let by = Fq2::new(fq_dec(&p.pi_b[1][0])?, fq_dec(&p.pi_b[1][1])?);
    let b = if bx.is_zero() && by.is_zero() {
        G2Affine::identity()
    } else {
        let p = G2Affine::new_unchecked(bx, by);
        if !p.is_on_curve() || !p.is_in_correct_subgroup_assuming_on_curve() {
            return Err(ImportError::NotOnCurve);
        }
        p
    };
    Ok(Proof { a, b, c })
}

/// The calldata words: `a = (x, y)`, `b = [[x.c1, x.c0], [y.c1, y.c0]]`, `c = (x, y)`.
pub fn to_calldata(proof: &Proof<Bn254>) -> Calldata {
    let (ax, ay) = g1_coords(&proof.a);
    let (bx, by) = g2_coords(&proof.b);
    let (cx, cy) = g1_coords(&proof.c);
    Calldata { a: [dec_fq(&ax), dec_fq(&ay)], b: [[dec_fq(&bx.c1), dec_fq(&bx.c0)], [dec_fq(&by.c1), dec_fq(&by.c0)]], c: [dec_fq(&cx), dec_fq(&cy)] }
}

/// `abi.encode(a, b, c)`: eight 32-byte big-endian words, 256 bytes — the `proof` argument of `transact`.
pub fn calldata_bytes(proof: &Proof<Bn254>) -> [u8; 256] {
    let (ax, ay) = g1_coords(&proof.a);
    let (bx, by) = g2_coords(&proof.b);
    let (cx, cy) = g1_coords(&proof.c);
    let words = [ax, ay, bx.c1, bx.c0, by.c1, by.c0, cx, cy];
    let mut out = [0u8; 256];
    for (i, w) in words.iter().enumerate() {
        let be = w.into_bigint().to_bytes_be();
        out[i * 32 + (32 - be.len())..(i + 1) * 32].copy_from_slice(&be);
    }
    out
}
