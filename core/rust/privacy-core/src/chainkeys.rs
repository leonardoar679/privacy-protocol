//! Chain Key Abstraction (plan §45) — reference/typescript/src/wallet/chainKeys.ts in Rust, pinned to
//! the same vectors (reference/typescript/test/vectors/chainkeys.json): standard derivations so the
//! 24-word phrase restores the same addresses in any wallet.
//!   EVM      BIP-44   m/44'/60'/0'/0/i            secp256k1 → keccak address (EIP-55)
//!   Bitcoin  BIP-84   m/84'/0'/0'/change/i         secp256k1 → P2WPKH, bech32 "bc1q…"
//!   Solana   SLIP-0010 ed25519  m/44'/501'/i'/0'   → base58(public key)
//! Root = BIP-32 master key of the BIP-39 seed of the phrase (empty passphrase).
use crate::address::bech32_encode;
use crate::domains::keccak256;
use hmac::{Hmac, Mac};
use k256::elliptic_curve::sec1::ToEncodedPoint;
use k256::elliptic_curve::PrimeField;
use k256::{FieldBytes, ProjectivePoint, Scalar};
use ripemd::Ripemd160;
use sha2::{Digest, Sha256, Sha512};

type HmacSha512 = Hmac<Sha512>;
const HARDENED: u32 = 0x8000_0000;

#[derive(Debug, PartialEq, Eq)]
pub enum ChainKeyError {
    BadPath(String),
    InvalidChildKey,
    NotHardened(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChainKind {
    Evm,
    Bitcoin,
    Solana,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChainAccount {
    pub chain: ChainKind,
    pub index: u32,
    pub path: String,
    pub address: String,
    /// compressed secp256k1 (33 bytes) or ed25519 (32 bytes)
    pub public_key: Vec<u8>,
    /// 32 bytes; never persisted
    pub private_key: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExtendedKey {
    pub key: [u8; 32],
    pub chain_code: [u8; 32],
}

fn hmac512(key: &[u8], data: &[u8]) -> [u8; 64] {
    let mut mac = HmacSha512::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().into()
}

fn scalar(bytes: &[u8; 32]) -> Option<Scalar> {
    Scalar::from_repr(FieldBytes::clone_from_slice(bytes)).into()
}

fn secp_public(private: &[u8; 32], compress: bool) -> Option<Vec<u8>> {
    let s = scalar(private)?;
    if bool::from(s.is_zero()) {
        return None;
    }
    let p = ProjectivePoint::GENERATOR * s;
    Some(p.to_affine().to_encoded_point(compress).as_bytes().to_vec())
}

/// BIP-32 master key: HMAC-SHA512("Bitcoin seed", seed).
pub fn bip32_master(seed: &[u8]) -> ExtendedKey {
    let i = hmac512(b"Bitcoin seed", seed);
    let mut key = [0u8; 32];
    key.copy_from_slice(&i[..32]);
    let mut cc = [0u8; 32];
    cc.copy_from_slice(&i[32..]);
    ExtendedKey { key, chain_code: cc }
}

/// BIP-32 private child derivation (hardened when index ≥ 2^31).
pub fn bip32_child(parent: &ExtendedKey, index: u32) -> Result<ExtendedKey, ChainKeyError> {
    let mut data = Vec::with_capacity(37);
    if index >= HARDENED {
        data.push(0);
        data.extend_from_slice(&parent.key);
    } else {
        data.extend_from_slice(&secp_public(&parent.key, true).ok_or(ChainKeyError::InvalidChildKey)?);
    }
    data.extend_from_slice(&index.to_be_bytes());
    let i = hmac512(&parent.chain_code, &data);
    let mut il = [0u8; 32];
    il.copy_from_slice(&i[..32]);
    let il_s = scalar(&il).ok_or(ChainKeyError::InvalidChildKey)?; // IL ≥ n: invalid (probability < 2^-127)
    let kp = scalar(&parent.key).ok_or(ChainKeyError::InvalidChildKey)?;
    let child = il_s + kp;
    if bool::from(child.is_zero()) {
        return Err(ChainKeyError::InvalidChildKey);
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&child.to_bytes());
    let mut cc = [0u8; 32];
    cc.copy_from_slice(&i[32..]);
    Ok(ExtendedKey { key, chain_code: cc })
}

/// Parse "m/44'/60'/0'/0/5" (also "h"/"H" for hardened).
pub fn parse_path(path: &str) -> Result<Vec<u32>, ChainKeyError> {
    let mut parts = path.split('/');
    if parts.next() != Some("m") {
        return Err(ChainKeyError::BadPath(path.to_string()));
    }
    parts
        .map(|p| {
            let (num, hardened) = match p.strip_suffix('\'').or_else(|| p.strip_suffix('h')).or_else(|| p.strip_suffix('H')) {
                Some(n) => (n, true),
                None => (p, false),
            };
            let v: u32 = num.parse().map_err(|_| ChainKeyError::BadPath(path.to_string()))?;
            if v >= HARDENED {
                return Err(ChainKeyError::BadPath(path.to_string()));
            }
            Ok(if hardened { v + HARDENED } else { v })
        })
        .collect()
}

pub fn bip32_derive(seed: &[u8], path: &str) -> Result<ExtendedKey, ChainKeyError> {
    let mut k = bip32_master(seed);
    for idx in parse_path(path)? {
        k = bip32_child(&k, idx)?;
    }
    Ok(k)
}

// ---- EVM ----
pub fn eip55(address20: &[u8; 20]) -> String {
    let lower: String = address20.iter().map(|b| format!("{b:02x}")).collect();
    let h = keccak256(lower.as_bytes());
    let hex: String = h.iter().map(|b| format!("{b:02x}")).collect();
    let mut out = String::from("0x");
    for (i, c) in lower.chars().enumerate() {
        let nibble = u8::from_str_radix(&hex[i..i + 1], 16).unwrap();
        out.push(if nibble >= 8 { c.to_ascii_uppercase() } else { c });
    }
    out
}

pub fn evm_address_of(private: &[u8; 32]) -> Option<String> {
    let uncompressed = secp_public(private, false)?;
    let h = keccak256(&uncompressed[1..]);
    let mut a = [0u8; 20];
    a.copy_from_slice(&h[12..]);
    Some(eip55(&a))
}

pub fn evm_account(seed64: &[u8], index: u32) -> Result<ChainAccount, ChainKeyError> {
    let path = format!("m/44'/60'/0'/0/{index}");
    let k = bip32_derive(seed64, &path)?;
    let public_key = secp_public(&k.key, true).ok_or(ChainKeyError::InvalidChildKey)?;
    Ok(ChainAccount { chain: ChainKind::Evm, index, path, address: evm_address_of(&k.key).ok_or(ChainKeyError::InvalidChildKey)?, public_key, private_key: k.key })
}

/// Per-dApp account index (plan §37): keccak("privacy-protocol/v1/dapp" ‖ lowercase(origin)) → a non-hardened index.
pub fn dapp_account_index(origin: &str) -> u32 {
    let mut pre = b"privacy-protocol/v1/dapp".to_vec();
    pre.extend_from_slice(origin.trim().to_lowercase().as_bytes());
    let h = keccak256(&pre);
    u32::from_be_bytes([h[0], h[1], h[2], h[3]]) & 0x7fff_ffff
}

pub fn dapp_account(seed64: &[u8], origin: &str) -> Result<ChainAccount, ChainKeyError> {
    evm_account(seed64, dapp_account_index(origin))
}

// ---- Bitcoin ----
pub fn p2wpkh_address(compressed_public: &[u8], hrp: &str) -> String {
    let hash160 = Ripemd160::digest(Sha256::digest(compressed_public));
    bech32_encode(hrp, 0, &hash160)
}

pub fn bitcoin_account(seed64: &[u8], index: u32, change: u8, hrp: &str) -> Result<ChainAccount, ChainKeyError> {
    let path = format!("m/84'/0'/0'/{change}/{index}");
    let k = bip32_derive(seed64, &path)?;
    let public_key = secp_public(&k.key, true).ok_or(ChainKeyError::InvalidChildKey)?;
    Ok(ChainAccount { chain: ChainKind::Bitcoin, index, path, address: p2wpkh_address(&public_key, hrp), public_key, private_key: k.key })
}

// ---- Solana (SLIP-0010 ed25519, hardened only) ----
pub fn slip10_ed25519(seed: &[u8], hardened_path: &[u32]) -> ExtendedKey {
    let i = hmac512(b"ed25519 seed", seed);
    let mut key = [0u8; 32];
    key.copy_from_slice(&i[..32]);
    let mut cc = [0u8; 32];
    cc.copy_from_slice(&i[32..]);
    for &idx in hardened_path {
        let idx = if idx >= HARDENED { idx } else { idx + HARDENED };
        let mut data = Vec::with_capacity(37);
        data.push(0);
        data.extend_from_slice(&key);
        data.extend_from_slice(&idx.to_be_bytes());
        let i = hmac512(&cc, &data);
        key.copy_from_slice(&i[..32]);
        cc.copy_from_slice(&i[32..]);
    }
    ExtendedKey { key, chain_code: cc }
}

/// "m/44'/501'/0'/0'" → hardened indexes; every component must be hardened for ed25519.
pub fn parse_hardened_path(path: &str) -> Result<Vec<u32>, ChainKeyError> {
    let idx = parse_path(path)?;
    if let Some(bad) = idx.iter().find(|i| **i < HARDENED) {
        return Err(ChainKeyError::NotHardened(format!("{bad}")));
    }
    Ok(idx)
}

pub fn ed25519_public(private: &[u8; 32]) -> [u8; 32] {
    ed25519_dalek::SigningKey::from_bytes(private).verifying_key().to_bytes()
}

const BASE58: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

pub fn base58_encode(bytes: &[u8]) -> String {
    let zeros = bytes.iter().take_while(|&&b| b == 0).count();
    let mut digits: Vec<u8> = Vec::new(); // little-endian base-58 digits
    for &b in &bytes[zeros..] {
        let mut carry = b as u32;
        for d in digits.iter_mut() {
            carry += (*d as u32) << 8;
            *d = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }
    let mut s = String::with_capacity(zeros + digits.len());
    for _ in 0..zeros {
        s.push('1');
    }
    for d in digits.iter().rev() {
        s.push(BASE58[*d as usize] as char);
    }
    s
}

pub fn solana_account(seed64: &[u8], index: u32) -> Result<ChainAccount, ChainKeyError> {
    let path = format!("m/44'/501'/{index}'/0'");
    let k = slip10_ed25519(seed64, &parse_hardened_path(&path)?);
    let public_key = ed25519_public(&k.key);
    Ok(ChainAccount { chain: ChainKind::Solana, index, path, address: base58_encode(&public_key), public_key: public_key.to_vec(), private_key: k.key })
}

pub fn account_for(chain: ChainKind, seed64: &[u8], index: u32) -> Result<ChainAccount, ChainKeyError> {
    match chain {
        ChainKind::Evm => evm_account(seed64, index),
        ChainKind::Bitcoin => bitcoin_account(seed64, index, 0, "bc"),
        ChainKind::Solana => solana_account(seed64, index),
    }
}
