//! The encrypted keystore and journal formats of the wallet (plan §44), byte-compatible with
//! packages/sdk/src/wallet/{keystore,journal}.ts so a backup file made by the web wallet opens in a native
//! one and vice versa (docs/crypto-spec.md, "Wallet keystore, recovery phrase, journal and chain keys").
//!
//!   keystore  = { v: 1, kdf: { name: "scrypt", N, r, p, dkLen: 32 }, salt(hex 16), nonce(hex 24), ct(hex) }
//!   key       = scrypt(NFKD(password), salt, N, r, p, 32)
//!   ct        = XChaCha20-Poly1305(key, nonce, aad = "privacy-protocol/v1/keystore")(seed, 32 bytes)
//!   journal   = { v: 1, nonce(hex 24), ct(hex) },  key = sha256("privacy-protocol/v1/journal-key" ‖ seed),
//!               aad = "privacy-protocol/v1/journal", plaintext = the JSON journal (UTF-8)
use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

pub const KEYSTORE_AAD: &[u8] = b"privacy-protocol/v1/keystore";
pub const JOURNAL_AAD: &[u8] = b"privacy-protocol/v1/journal";
pub const JOURNAL_KEY_TAG: &[u8] = b"privacy-protocol/v1/journal-key";
pub const SEED_BYTES: usize = 32;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct KdfParams {
    pub name: String,
    #[serde(rename = "N")]
    pub n: u32,
    pub r: u32,
    pub p: u32,
    #[serde(rename = "dkLen")]
    pub dk_len: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Keystore {
    pub v: u8,
    pub kdf: KdfParams,
    pub salt: String,
    pub nonce: String,
    pub ct: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EncryptedJournal {
    pub v: u8,
    pub nonce: String,
    pub ct: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum KeystoreError {
    UnsafeParams,
    BadFormat,
    WrongPassword,
}

/// The web wallet's default: 64 MiB, about a second in a browser.
pub const KDF_DEFAULT: KdfParams = KdfParams { name: String::new(), n: 1 << 16, r: 8, p: 1, dk_len: 32 };

/// The most a keystore may ask of scrypt (audit round 2, n31): N up to 2^20, r up to 32, p up to 16, and N·r·p up to 2^23 (the
/// default's sixteen-fold). A backup file with r = 1 and p near 2^23 had run scrypt for hours to days, within the memory cap.
const MAX_LOG_N: u32 = 20;
const MAX_R: u32 = 32;
const MAX_P: u32 = 16;
const MAX_WORK: u64 = 1 << 23;

fn derive_key(password: &str, salt: &[u8], p: &KdfParams) -> Result<[u8; 32], KeystoreError> {
    if p.name != "scrypt" || p.dk_len != 32 || p.n < 1 << 10 || p.n > 1 << MAX_LOG_N || !p.n.is_power_of_two() || p.r < 1 || p.r > MAX_R || p.p < 1 || p.p > MAX_P {
        return Err(KeystoreError::UnsafeParams);
    }
    if u64::from(p.n) * u64::from(p.r) * u64::from(p.p) > MAX_WORK {
        return Err(KeystoreError::UnsafeParams);
    }
    let log_n = p.n.trailing_zeros() as u8;
    let params = scrypt::Params::new(log_n, p.r, p.p, 32).map_err(|_| KeystoreError::UnsafeParams)?;
    let pw: String = password.nfkd().collect();
    let mut key = [0u8; 32];
    scrypt::scrypt(pw.as_bytes(), salt, &params, &mut key).map_err(|_| KeystoreError::UnsafeParams)?;
    Ok(key)
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
fn unhex(s: &str) -> Result<Vec<u8>, KeystoreError> {
    // ASCII only (audit round 2, p01): a multi-byte character at an even offset had panicked on the slice's char boundary
    if s.len() % 2 != 0 || !s.is_ascii() {
        return Err(KeystoreError::BadFormat);
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|_| KeystoreError::BadFormat)).collect()
}

/// Encrypt a seed under a password with caller-supplied salt (16 bytes) and nonce (24 bytes).
pub fn create_keystore(seed: &[u8; SEED_BYTES], password: &str, params: &KdfParams, salt: [u8; 16], nonce: [u8; 24]) -> Result<Keystore, KeystoreError> {
    let p = KdfParams { name: "scrypt".into(), ..params.clone() };
    let key = derive_key(password, &salt, &p)?;
    let ct = XChaCha20Poly1305::new((&key).into()).encrypt(XNonce::from_slice(&nonce), Payload { msg: seed, aad: KEYSTORE_AAD }).map_err(|_| KeystoreError::BadFormat)?;
    Ok(Keystore { v: 1, kdf: p, salt: hex(&salt), nonce: hex(&nonce), ct: hex(&ct) })
}

/// The seed, or WrongPassword when the password is wrong or the keystore was tampered with.
pub fn unlock_keystore(ks: &Keystore, password: &str) -> Result<[u8; SEED_BYTES], KeystoreError> {
    if ks.v != 1 {
        return Err(KeystoreError::BadFormat);
    }
    let salt = unhex(&ks.salt)?;
    let nonce = unhex(&ks.nonce)?;
    let ct = unhex(&ks.ct)?;
    // the shape the web wallet holds (wallet-formats §2; the seventh review round, 2026-11-03): a 16-byte salt, a 24-byte nonce and the
    // seed's ciphertext with its tag — any other salt, an empty one included, had opened here and been refused by the web wallet
    if salt.len() != 16 || nonce.len() != 24 || ct.len() != SEED_BYTES + 16 {
        return Err(KeystoreError::BadFormat);
    }
    let key = derive_key(password, &salt, &ks.kdf)?;
    let pt = XChaCha20Poly1305::new((&key).into()).decrypt(XNonce::from_slice(&nonce), Payload { msg: &ct, aad: KEYSTORE_AAD }).map_err(|_| KeystoreError::WrongPassword)?;
    if pt.len() != SEED_BYTES {
        return Err(KeystoreError::BadFormat);
    }
    let mut out = [0u8; SEED_BYTES];
    out.copy_from_slice(&pt);
    Ok(out)
}

/// sha256("privacy-protocol/v1/journal-key" ‖ seed)
pub fn journal_key(seed: &[u8; SEED_BYTES]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(JOURNAL_KEY_TAG);
    h.update(seed);
    h.finalize().into()
}

pub fn encrypt_journal(key: &[u8; 32], plaintext_json: &str, nonce: [u8; 24]) -> EncryptedJournal {
    let ct = XChaCha20Poly1305::new(key.into()).encrypt(XNonce::from_slice(&nonce), Payload { msg: plaintext_json.as_bytes(), aad: JOURNAL_AAD }).expect("XChaCha20-Poly1305 encrypt");
    EncryptedJournal { v: 1, nonce: hex(&nonce), ct: hex(&ct) }
}

pub fn decrypt_journal(key: &[u8; 32], blob: &EncryptedJournal) -> Option<String> {
    if blob.v != 1 {
        return None;
    }
    let nonce = unhex(&blob.nonce).ok()?;
    let ct = unhex(&blob.ct).ok()?;
    // a nonce of another length is a journal it cannot open (p01): XNonce::from_slice had panicked on it
    if nonce.len() != 24 {
        return None;
    }
    let pt = XChaCha20Poly1305::new(key.into()).decrypt(XNonce::from_slice(&nonce), Payload { msg: &ct, aad: JOURNAL_AAD }).ok()?;
    String::from_utf8(pt).ok()
}
