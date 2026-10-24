//! Privacy address (wallet-level convention, packages/protocol/src/address.ts): bech32m (BIP-350),
//! human-readable part "pp", data = version 0x01 ‖ ownerCommitment (32 bytes, big-endian) ‖ viewPub
//! (32 bytes). Typo-resistant, case-insensitive, 113 characters.
use crate::field::{fr_from_be32_checked, fr_to_be32, Fr};

const CHARSET: &[u8; 32] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATORS: [u32; 5] = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const BECH32M_CONST: u32 = 0x2bc830a3;
pub const ADDRESS_HRP: &str = "pp";
pub const ADDRESS_VERSION: u8 = 0x01;

#[derive(Debug, PartialEq, Eq)]
pub enum AddressError {
    MixedCase,
    Malformed,
    InvalidCharacter,
    BadChecksum,
    InvalidPadding,
    WrongHrp(String),
    WrongLength(usize),
    UnsupportedVersion(u8),
    NotInField,
    /// the view key is a low-order point: nothing paid to it could be private (audit round 2, n28)
    LowOrderViewKey,
}

fn polymod(values: impl IntoIterator<Item = u8>) -> u32 {
    let mut chk: u32 = 1;
    for v in values {
        let top = chk >> 25;
        chk = ((chk & 0x1ff_ffff) << 5) ^ (v as u32);
        for (i, g) in GENERATORS.iter().enumerate() {
            if (top >> i) & 1 == 1 {
                chk ^= g;
            }
        }
    }
    chk
}

fn hrp_expand(hrp: &str) -> Vec<u8> {
    let b = hrp.as_bytes();
    let mut out: Vec<u8> = b.iter().map(|c| c >> 5).collect();
    out.push(0);
    out.extend(b.iter().map(|c| c & 31));
    out
}

const BECH32_CONST: u32 = 1; // BIP-173 (witness version 0 addresses)

fn create_checksum_with(hrp: &str, data: &[u8], constant: u32) -> [u8; 6] {
    let mut values = hrp_expand(hrp);
    values.extend_from_slice(data);
    values.extend_from_slice(&[0; 6]);
    let m = polymod(values) ^ constant;
    let mut out = [0u8; 6];
    for (i, o) in out.iter_mut().enumerate() {
        *o = ((m >> (5 * (5 - i))) & 31) as u8;
    }
    out
}

/// BIP-173 bech32 (NOT bech32m) encoding of a segwit v0 program, e.g. P2WPKH "bc1q…" (chainkeys.rs).
pub fn bech32_encode(hrp: &str, witness_version: u8, program: &[u8]) -> String {
    let mut data = vec![witness_version];
    data.extend(convert_bits(program, 8, 5, true).expect("8-bit input is always valid"));
    let checksum = create_checksum_with(hrp, &data, if witness_version == 0 { BECH32_CONST } else { BECH32M_CONST });
    let mut s = String::with_capacity(hrp.len() + 1 + data.len() + 6);
    s.push_str(hrp);
    s.push('1');
    for d in data.iter().chain(checksum.iter()) {
        s.push(CHARSET[*d as usize] as char);
    }
    s
}

fn create_checksum(hrp: &str, data: &[u8]) -> [u8; 6] {
    let mut values = hrp_expand(hrp);
    values.extend_from_slice(data);
    values.extend_from_slice(&[0; 6]);
    let m = polymod(values) ^ BECH32M_CONST;
    let mut out = [0u8; 6];
    for (i, o) in out.iter_mut().enumerate() {
        *o = ((m >> (5 * (5 - i))) & 31) as u8;
    }
    out
}

fn convert_bits(data: &[u8], from: u32, to: u32, pad: bool) -> Result<Vec<u8>, AddressError> {
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    let maxv: u32 = (1 << to) - 1;
    let mut out = Vec::new();
    for &v in data {
        if (v as u32) >> from != 0 {
            return Err(AddressError::InvalidCharacter);
        }
        acc = (acc << from) | v as u32;
        bits += from;
        while bits >= to {
            bits -= to;
            out.push(((acc >> bits) & maxv) as u8);
        }
    }
    if pad {
        if bits > 0 {
            out.push(((acc << (to - bits)) & maxv) as u8);
        }
    } else if bits >= from || ((acc << (to - bits)) & maxv) != 0 {
        return Err(AddressError::InvalidPadding);
    }
    Ok(out)
}

pub fn bech32m_encode(hrp: &str, bytes: &[u8]) -> String {
    let data = convert_bits(bytes, 8, 5, true).expect("8-bit input is always valid");
    let checksum = create_checksum(hrp, &data);
    let mut s = String::with_capacity(hrp.len() + 1 + data.len() + 6);
    s.push_str(hrp);
    s.push('1');
    for d in data.iter().chain(checksum.iter()) {
        s.push(CHARSET[*d as usize] as char);
    }
    s
}

pub fn bech32m_decode(s: &str) -> Result<(String, Vec<u8>), AddressError> {
    let has_lower = s.chars().any(|c| c.is_ascii_lowercase());
    let has_upper = s.chars().any(|c| c.is_ascii_uppercase());
    if has_lower && has_upper {
        return Err(AddressError::MixedCase);
    }
    let str = s.to_ascii_lowercase();
    let pos = str.rfind('1').ok_or(AddressError::Malformed)?;
    if pos < 1 || pos + 7 > str.len() {
        return Err(AddressError::Malformed);
    }
    let hrp = &str[..pos];
    let mut data = Vec::with_capacity(str.len() - pos - 1);
    for c in str[pos + 1..].bytes() {
        data.push(CHARSET.iter().position(|&x| x == c).ok_or(AddressError::InvalidCharacter)? as u8);
    }
    let mut values = hrp_expand(hrp);
    values.extend_from_slice(&data);
    if polymod(values) != BECH32M_CONST {
        return Err(AddressError::BadChecksum);
    }
    let bytes = convert_bits(&data[..data.len() - 6], 5, 8, false)?;
    Ok((hrp.to_string(), bytes))
}

pub fn encode_privacy_address(owner_commitment: &Fr, view_pub: &[u8; 32]) -> String {
    let mut payload = [0u8; 65];
    payload[0] = ADDRESS_VERSION;
    payload[1..33].copy_from_slice(&fr_to_be32(owner_commitment));
    payload[33..].copy_from_slice(view_pub);
    bech32m_encode(ADDRESS_HRP, &payload)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PrivacyAddress {
    pub version: u8,
    pub owner_commitment: Fr,
    pub view_pub: [u8; 32],
}

pub fn decode_privacy_address(s: &str) -> Result<PrivacyAddress, AddressError> {
    let (hrp, bytes) = bech32m_decode(s.trim())?;
    if hrp != ADDRESS_HRP {
        return Err(AddressError::WrongHrp(hrp));
    }
    if bytes.len() != 65 {
        return Err(AddressError::WrongLength(bytes.len()));
    }
    if bytes[0] != ADDRESS_VERSION {
        return Err(AddressError::UnsupportedVersion(bytes[0]));
    }
    let mut oc = [0u8; 32];
    oc.copy_from_slice(&bytes[1..33]);
    let mut vp = [0u8; 32];
    vp.copy_from_slice(&bytes[33..65]);
    let owner_commitment = fr_from_be32_checked(&oc).ok_or(AddressError::NotInField)?;
    // as the web wallet's decoder refuses it (audit round 2, n29/n28): a native payer had encrypted to it in the clear
    if !super::envelope::is_contributory_view_key(&vp) {
        return Err(AddressError::LowOrderViewKey);
    }
    Ok(PrivacyAddress { version: bytes[0], owner_commitment, view_pub: vp })
}
