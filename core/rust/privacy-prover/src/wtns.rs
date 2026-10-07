//! snarkjs `.wtns` witness files: magic "wtns", version, section count; section 1 = n8, the prime
//! (n8 bytes), the witness length; section 2 = the witness, n8 little-endian bytes per element in
//! standard (non-Montgomery) form, element 0 being the constant 1, then the public inputs in circuit
//! order, then every private signal.
use ark_bn254::Fr;
use ark_ff::{BigInteger, PrimeField};

#[derive(Debug, PartialEq, Eq)]
pub enum WtnsError {
    Truncated,
    BadMagic,
    MissingSection(u32),
    WrongField,
    NonCanonical(usize),
    NoConstantOne,
}

fn u32_at(b: &[u8], pos: usize) -> Result<u32, WtnsError> {
    b.get(pos..pos + 4).map(|x| u32::from_le_bytes(x.try_into().unwrap())).ok_or(WtnsError::Truncated)
}
fn u64_at(b: &[u8], pos: usize) -> Result<u64, WtnsError> {
    b.get(pos..pos + 8).map(|x| u64::from_le_bytes(x.try_into().unwrap())).ok_or(WtnsError::Truncated)
}

pub fn read_wtns(bytes: &[u8]) -> Result<Vec<Fr>, WtnsError> {
    if bytes.get(0..4) != Some(b"wtns") {
        return Err(WtnsError::BadMagic);
    }
    let n_sections = u32_at(bytes, 8)?;
    let mut pos = 12usize;
    let mut header = None;
    let mut data = None;
    for _ in 0..n_sections {
        let id = u32_at(bytes, pos)?;
        let len = u64_at(bytes, pos + 4)? as usize;
        let body = bytes.get(pos + 12..pos + 12 + len).ok_or(WtnsError::Truncated)?;
        match id {
            1 => header = Some(body),
            2 => data = Some(body),
            _ => {}
        }
        pos += 12 + len;
    }
    let header = header.ok_or(WtnsError::MissingSection(1))?;
    let data = data.ok_or(WtnsError::MissingSection(2))?;
    let n8 = u32_at(header, 0)? as usize;
    let prime = header.get(4..4 + n8).ok_or(WtnsError::Truncated)?;
    if n8 != 32 || prime != Fr::MODULUS.to_bytes_le().as_slice() {
        return Err(WtnsError::WrongField);
    }
    let n = u32_at(header, 4 + n8)? as usize;
    if data.len() < n * 32 {
        return Err(WtnsError::Truncated);
    }
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let le = &data[i * 32..(i + 1) * 32];
        let x = Fr::from_le_bytes_mod_order(le);
        if x.into_bigint().to_bytes_le() != le {
            return Err(WtnsError::NonCanonical(i));
        }
        out.push(x);
    }
    if out.first() != Some(&Fr::from(1u64)) {
        return Err(WtnsError::NoConstantOne);
    }
    Ok(out)
}
