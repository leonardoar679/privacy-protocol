//! BIP-39 (English): the recovery phrase of the wallet is the 24-word encoding of its 32-byte seed
//! (plan §44), and the BIP-39 seed of that phrase is the root of every chain key (chainkeys.rs). The
//! wordlist is generated from the web wallet's package so both implementations share it.
use crate::bip39_wordlist::WORDLIST;
use pbkdf2::pbkdf2_hmac;
use sha2::{Digest, Sha256, Sha512};
use unicode_normalization::UnicodeNormalization;

#[derive(Debug, PartialEq, Eq)]
pub enum Bip39Error {
    BadEntropyLength(usize),
    BadWordCount(usize),
    UnknownWord(String),
    BadChecksum,
}

/// entropy (16, 20, 24, 28 or 32 bytes) → mnemonic (12 … 24 words).
pub fn entropy_to_mnemonic(entropy: &[u8]) -> Result<String, Bip39Error> {
    if !matches!(entropy.len(), 16 | 20 | 24 | 28 | 32) {
        return Err(Bip39Error::BadEntropyLength(entropy.len()));
    }
    let checksum_bits = entropy.len() * 8 / 32;
    let hash = Sha256::digest(entropy);
    let mut bits: Vec<u8> = Vec::with_capacity(entropy.len() * 8 + checksum_bits);
    for b in entropy {
        for i in (0..8).rev() {
            bits.push((b >> i) & 1);
        }
    }
    for i in 0..checksum_bits {
        bits.push((hash[i / 8] >> (7 - (i % 8))) & 1);
    }
    let words: Vec<&str> = bits.chunks(11).map(|c| WORDLIST[c.iter().fold(0usize, |acc, &b| (acc << 1) | b as usize)]).collect();
    Ok(words.join(" "))
}

/// Normalize a phrase the way the wallet does: NFKD, lower case, single spaces.
pub fn normalize_mnemonic(phrase: &str) -> String {
    phrase.nfkd().collect::<String>().to_lowercase().split(is_space).filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ")
}

/// The whitespace a phrase is split on: JavaScript's, as the web wallet's phraseToSeed (`trim`, `\s`) splits it (audit
/// round 2, n32) — the byte-order mark included (a phrase pasted with one restored on the web and was refused here), U+0085
/// not (one word on the web, two here).
pub(crate) fn is_space(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}')
}

/// mnemonic → entropy; verifies the checksum.
pub fn mnemonic_to_entropy(phrase: &str) -> Result<Vec<u8>, Bip39Error> {
    let norm = normalize_mnemonic(phrase);
    let words: Vec<&str> = norm.split(' ').filter(|w| !w.is_empty()).collect();
    if !matches!(words.len(), 12 | 15 | 18 | 21 | 24) {
        return Err(Bip39Error::BadWordCount(words.len()));
    }
    let mut bits: Vec<u8> = Vec::with_capacity(words.len() * 11);
    for w in &words {
        let idx = WORDLIST.iter().position(|x| x == w).ok_or_else(|| Bip39Error::UnknownWord((*w).to_string()))?;
        for i in (0..11).rev() {
            bits.push(((idx >> i) & 1) as u8);
        }
    }
    let checksum_bits = words.len() / 3;
    let entropy_bits = bits.len() - checksum_bits;
    let mut entropy = vec![0u8; entropy_bits / 8];
    for (i, b) in bits[..entropy_bits].iter().enumerate() {
        entropy[i / 8] |= b << (7 - (i % 8));
    }
    let hash = Sha256::digest(&entropy);
    for i in 0..checksum_bits {
        if bits[entropy_bits + i] != (hash[i / 8] >> (7 - (i % 8))) & 1 {
            return Err(Bip39Error::BadChecksum);
        }
    }
    Ok(entropy)
}

pub fn validate_mnemonic(phrase: &str) -> bool {
    mnemonic_to_entropy(phrase).is_ok()
}

/// The 64-byte BIP-39 seed: PBKDF2-HMAC-SHA512(NFKD(mnemonic), "mnemonic" ‖ NFKD(passphrase), 2048 rounds).
pub fn mnemonic_to_seed(phrase: &str, passphrase: &str) -> [u8; 64] {
    let mnemonic = normalize_mnemonic(phrase);
    let salt = format!("mnemonic{}", passphrase.nfkd().collect::<String>());
    let mut out = [0u8; 64];
    pbkdf2_hmac::<Sha512>(mnemonic.as_bytes(), salt.as_bytes(), 2048, &mut out);
    out
}

/// The wallet's phrase of its 32-byte seed (24 words).
pub fn seed_to_phrase(seed: &[u8; 32]) -> String {
    entropy_to_mnemonic(seed).expect("32 bytes is a valid entropy length")
}

/// The 32-byte seed a 24-word phrase encodes.
pub fn phrase_to_seed(phrase: &str) -> Result<[u8; 32], Bip39Error> {
    let e = mnemonic_to_entropy(phrase)?;
    if e.len() != 32 {
        return Err(Bip39Error::BadWordCount(e.len() * 3 / 4));
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&e);
    Ok(out)
}
