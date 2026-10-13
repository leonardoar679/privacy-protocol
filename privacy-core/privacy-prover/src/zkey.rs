//! snarkjs `.zkey` reader (Groth16): `circuits/build/setup/transaction_final.zkey`.
//!
//! The file is a sectioned binary (little-endian): magic "zkey", version, section count, then
//! `(id u32, length u64, body)` per section —
//!   1 prover type (1 = Groth16) · 2 Groth16 header: n8q, q, n8r, r, nVars, nPublic, domainSize,
//!   alpha1, beta1, beta2, gamma2, delta1, delta2 · 3 IC · 4 coefficients (matrix, constraint,
//!   signal, value) · 5 A · 6 B1 · 7 B2 · 8 C (arkworks' L query) · 9 H · 10 contributions.
//! Field elements are stored in Montgomery form as ffjavascript writes them, so they are taken as
//! the internal representation directly; scalar coefficients carry an extra factor R and are divided
//! once. Format port of arkworks' circom-compat reader (MIT / Apache-2.0).
use ark_bn254::{Bn254, Fq, Fq2, Fr, G1Affine, G2Affine};
use ark_ff::{BigInt, BigInteger, PrimeField, Zero};
use ark_groth16::{ProvingKey, VerifyingKey};
use ark_relations::r1cs::ConstraintMatrices;
use std::collections::HashMap;

#[derive(Debug, PartialEq, Eq)]
pub enum ZkeyError {
    Truncated,
    BadMagic,
    MissingSection(u32),
    NotGroth16(u32),
    WrongCurve,
    PointNotOnCurve(&'static str),
    Inconsistent(&'static str),
}

/// A parsed proving key: arkworks' `ProvingKey` plus the constraint matrices the QAP witness map needs.
pub struct Zkey {
    pub pk: ProvingKey<Bn254>,
    pub matrices: ConstraintMatrices<Fr>,
    /// witness length (1, public inputs, private signals)
    pub n_vars: usize,
    /// public inputs (without the constant 1)
    pub n_public: usize,
    pub domain_size: usize,
}

struct Cursor<'a> {
    b: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn bytes(&mut self, n: usize) -> Result<&'a [u8], ZkeyError> {
        let end = self.pos.checked_add(n).ok_or(ZkeyError::Truncated)?;
        if end > self.b.len() {
            return Err(ZkeyError::Truncated);
        }
        let out = &self.b[self.pos..end];
        self.pos = end;
        Ok(out)
    }
    fn u32(&mut self) -> Result<u32, ZkeyError> {
        Ok(u32::from_le_bytes(self.bytes(4)?.try_into().unwrap()))
    }
    fn u64(&mut self) -> Result<u64, ZkeyError> {
        Ok(u64::from_le_bytes(self.bytes(8)?.try_into().unwrap()))
    }
    fn seek(&mut self, pos: usize) -> Result<(), ZkeyError> {
        if pos > self.b.len() {
            return Err(ZkeyError::Truncated);
        }
        self.pos = pos;
        Ok(())
    }
}

fn bigint_le(b: &[u8]) -> BigInt<4> {
    let mut limbs = [0u64; 4];
    for (i, l) in limbs.iter_mut().enumerate() {
        *l = u64::from_le_bytes(b[i * 8..(i + 1) * 8].try_into().unwrap());
    }
    BigInt::new(limbs)
}

/// A base-field element as stored: already in Montgomery form.
fn fq(c: &mut Cursor) -> Result<Fq, ZkeyError> {
    Ok(Fq::new_unchecked(bigint_le(c.bytes(32)?)))
}

/// A scalar coefficient as stored: Montgomery form times R — one extra factor to divide out.
fn fr_coef(c: &mut Cursor) -> Result<Fr, ZkeyError> {
    let twice = Fr::new_unchecked(bigint_le(c.bytes(32)?));
    Ok(Fr::new_unchecked(twice.into_bigint()))
}

fn g1(c: &mut Cursor, what: &'static str) -> Result<G1Affine, ZkeyError> {
    let x = fq(c)?;
    let y = fq(c)?;
    if x.is_zero() && y.is_zero() {
        return Ok(G1Affine::identity());
    }
    let p = G1Affine::new_unchecked(x, y);
    if !p.is_on_curve() {
        return Err(ZkeyError::PointNotOnCurve(what));
    }
    Ok(p)
}

fn g2(c: &mut Cursor, what: &'static str) -> Result<G2Affine, ZkeyError> {
    let x = Fq2::new(fq(c)?, fq(c)?);
    let y = Fq2::new(fq(c)?, fq(c)?);
    if x.is_zero() && y.is_zero() {
        return Ok(G2Affine::identity());
    }
    let p = G2Affine::new_unchecked(x, y);
    if !p.is_on_curve() {
        return Err(ZkeyError::PointNotOnCurve(what));
    }
    Ok(p)
}

/// Parse a whole `.zkey` file. Every point is checked to lie on its curve; the verifying key must
/// additionally be compared with the published `verification_key.json` by the caller (tests do).
pub fn read_zkey(bytes: &[u8]) -> Result<Zkey, ZkeyError> {
    let mut c = Cursor { b: bytes, pos: 0 };
    if c.bytes(4)? != b"zkey" {
        return Err(ZkeyError::BadMagic);
    }
    let _version = c.u32()?;
    let n_sections = c.u32()?;
    let mut sections: HashMap<u32, (usize, usize)> = HashMap::new();
    for _ in 0..n_sections {
        let id = c.u32()?;
        let len = c.u64()? as usize;
        sections.entry(id).or_insert((c.pos, len));
        c.seek(c.pos.checked_add(len).ok_or(ZkeyError::Truncated)?)?;
    }
    let section = |id: u32| sections.get(&id).copied().ok_or(ZkeyError::MissingSection(id));

    c.seek(section(1)?.0)?;
    let prover_type = c.u32()?;
    if prover_type != 1 {
        return Err(ZkeyError::NotGroth16(prover_type));
    }

    c.seek(section(2)?.0)?;
    let n8q = c.u32()?;
    let q = c.bytes(32)?;
    let n8r = c.u32()?;
    let r = c.bytes(32)?;
    if n8q != 32 || n8r != 32 || q != Fq::MODULUS.to_bytes_le().as_slice() || r != Fr::MODULUS.to_bytes_le().as_slice() {
        return Err(ZkeyError::WrongCurve);
    }
    let n_vars = c.u32()? as usize;
    let n_public = c.u32()? as usize;
    let domain_size = c.u32()? as usize;
    if n_vars < n_public + 1 || domain_size == 0 || !domain_size.is_power_of_two() {
        return Err(ZkeyError::Inconsistent("header sizes"));
    }
    let alpha_g1 = g1(&mut c, "alpha1")?;
    let beta_g1 = g1(&mut c, "beta1")?;
    let beta_g2 = g2(&mut c, "beta2")?;
    let gamma_g2 = g2(&mut c, "gamma2")?;
    let delta_g1 = g1(&mut c, "delta1")?;
    let delta_g2 = g2(&mut c, "delta2")?;

    let g1_vec = |c: &mut Cursor, id: u32, n: usize, what: &'static str| -> Result<Vec<G1Affine>, ZkeyError> {
        let (pos, len) = section(id)?;
        if len < n * 64 {
            return Err(ZkeyError::Truncated);
        }
        c.seek(pos)?;
        (0..n).map(|_| g1(c, what)).collect()
    };
    let g2_vec = |c: &mut Cursor, id: u32, n: usize, what: &'static str| -> Result<Vec<G2Affine>, ZkeyError> {
        let (pos, len) = section(id)?;
        if len < n * 128 {
            return Err(ZkeyError::Truncated);
        }
        c.seek(pos)?;
        (0..n).map(|_| g2(c, what)).collect()
    };

    let gamma_abc_g1 = g1_vec(&mut c, 3, n_public + 1, "IC")?;

    // section 4: the A and B matrices, with snarkjs' extra rows that bind the public inputs
    // (constraint nConstraints + i has signal i with coefficient 1); arkworks adds those itself.
    c.seek(section(4)?.0)?;
    let n_coefs = c.u32()? as usize;
    let mut a: Vec<Vec<(Fr, usize)>> = vec![Vec::new(); domain_size];
    let mut b: Vec<Vec<(Fr, usize)>> = vec![Vec::new(); domain_size];
    let mut max_constraint = 0usize;
    for _ in 0..n_coefs {
        let matrix = c.u32()?;
        let constraint = c.u32()? as usize;
        let signal = c.u32()? as usize;
        let value = fr_coef(&mut c)?;
        if constraint >= domain_size || signal >= n_vars {
            return Err(ZkeyError::Inconsistent("coefficient index"));
        }
        max_constraint = max_constraint.max(constraint);
        match matrix {
            0 => a[constraint].push((value, signal)),
            1 => b[constraint].push((value, signal)),
            _ => return Err(ZkeyError::Inconsistent("matrix id")),
        }
    }
    let num_constraints = max_constraint + 1 - (n_public + 1);
    a.truncate(num_constraints);
    b.truncate(num_constraints);
    let a_num_non_zero = a.iter().map(Vec::len).sum();
    let b_num_non_zero = b.iter().map(Vec::len).sum();
    let matrices = ConstraintMatrices {
        num_instance_variables: n_public + 1,
        num_witness_variables: n_vars - n_public - 1,
        num_constraints,
        a_num_non_zero,
        b_num_non_zero,
        c_num_non_zero: 0,
        a,
        b,
        c: Vec::new(),
    };

    let a_query = g1_vec(&mut c, 5, n_vars, "A")?;
    let b_g1_query = g1_vec(&mut c, 6, n_vars, "B1")?;
    let b_g2_query = g2_vec(&mut c, 7, n_vars, "B2")?;
    let l_query = g1_vec(&mut c, 8, n_vars - n_public - 1, "C")?;
    let h_query = g1_vec(&mut c, 9, domain_size, "H")?;

    let vk = VerifyingKey::<Bn254> { alpha_g1, beta_g2, gamma_g2, delta_g2, gamma_abc_g1 };
    let pk = ProvingKey::<Bn254> { vk, beta_g1, delta_g1, a_query, b_g1_query, b_g2_query, h_query, l_query };
    Ok(Zkey { pk, matrices, n_vars, n_public, domain_size })
}
