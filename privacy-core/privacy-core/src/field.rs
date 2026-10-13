//! The BN254 scalar field (spec §1) through arkworks, plus the byte conventions every other module
//! shares: big-endian 32-byte encodings, keccak outputs reduced mod p (`uint256(bytes32) % p`, as the
//! contracts and the TypeScript reference do), and a strict decoder that refuses values ≥ p.
pub use ark_bn254::Fr;
use ark_ff::{BigInteger, PrimeField};

/// `uint256(bytes) mod p` for any byte string (big-endian).
pub fn fr_from_be_mod(bytes: &[u8]) -> Fr {
    Fr::from_be_bytes_mod_order(bytes)
}

/// Big-endian 32-byte encoding of a field element.
pub fn fr_to_be32(x: &Fr) -> [u8; 32] {
    let v = x.into_bigint().to_bytes_be();
    let mut out = [0u8; 32];
    out[32 - v.len()..].copy_from_slice(&v);
    out
}

/// Decode a canonical 32-byte big-endian field element; `None` when the value is not below p.
pub fn fr_from_be32_checked(b: &[u8; 32]) -> Option<Fr> {
    let x = Fr::from_be_bytes_mod_order(b);
    if fr_to_be32(&x) == *b { Some(x) } else { None }
}

/// Decimal string → field element (test vectors, fixtures). Panics on malformed input.
pub fn fr_from_dec(s: &str) -> Fr {
    s.parse::<Fr>().unwrap_or_else(|_| panic!("not a decimal field element: {s}"))
}

/// Field element → decimal string (the form the fixtures use).
pub fn fr_to_dec(x: &Fr) -> String {
    x.into_bigint().to_string()
}
