//! Wallet-side key derivation (spec §4), the reference derivation of packages/protocol/src/keys.ts:
//! `spendKey / viewKey / noteKey = keccak256(seed ‖ "/spend" | "/view" | "/note") mod p`, and the
//! per-note secret `keccak256(be32(noteKey) ‖ be64(counter)) mod p` (spec §5.5, never reused), and a deposited
//! note's own owner key `keccak256(be32(spendKey) ‖ "/owner-key/" ‖ be32(noteSecret)) mod p`. The master seed never
//! leaves the client; a native wallet keeps it in the OS keystore.
use crate::domains::keccak256;
use crate::field::{fr_from_be_mod, fr_to_be32, Fr};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WalletKeys {
    /// authorizes spends (nullifier key); ownerCommitment = H(OWNER_COMMITMENT, spendKey)
    pub spend_key: Fr,
    /// decrypts incoming note payloads (envelope.rs)
    pub view_key: Fr,
    /// derives per-note secrets
    pub note_key: Fr,
}

fn derive_field(seed: &[u8], label: &str) -> Fr {
    let mut buf = Vec::with_capacity(seed.len() + label.len());
    buf.extend_from_slice(seed);
    buf.extend_from_slice(label.as_bytes());
    fr_from_be_mod(&keccak256(&buf))
}

/// Why no key derives: the seed is empty or all zero — the seed a lock zeroed, or none —, whose keys anyone can compute (the eleventh review
/// round, 2026-11-04, G11-7: the TypeScript core's `assertLiveSeed` refused it, and this core, its WASM build and the FFI derived its keys).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyError {
    SeedUnavailable,
}

impl core::fmt::Display for KeyError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("the wallet's seed is not available (the wallet locked): nothing is derived from it, nothing is sent")
    }
}

impl std::error::Error for KeyError {}

/// The three wallet keys of a live seed (spec §4); an empty or all-zero seed is refused, as packages/protocol/src/keys.ts refuses it.
pub fn derive_keys(master_seed: &[u8]) -> Result<WalletKeys, KeyError> {
    if master_seed.is_empty() || master_seed.iter().all(|&b| b == 0) {
        return Err(KeyError::SeedUnavailable);
    }
    Ok(WalletKeys { spend_key: derive_field(master_seed, "/spend"), view_key: derive_field(master_seed, "/view"), note_key: derive_field(master_seed, "/note") })
}

/// noteSecret for the wallet's own notes: keccak(noteKey ‖ uint64 counter) mod p.
pub fn derive_note_secret(note_key: &Fr, counter: u64) -> Fr {
    let mut b = [0u8; 40];
    b[..32].copy_from_slice(&fr_to_be32(note_key));
    b[32..].copy_from_slice(&counter.to_be_bytes());
    fr_from_be_mod(&keccak256(&b))
}

/// The label of a deposited note's own owner key (`derive_owner_key`).
pub const OWNER_KEY_LABEL: &str = "/owner-key/";

/// A deposited note's own owner key (packages/protocol/src/keys.ts deriveOwnerKey; the audit round of 2026-10-16, c18):
/// `keccak256(be32(spendKey) ‖ "/owner-key/" ‖ be32(noteSecret)) mod p`, a 75-byte preimage. Its owner commitment is
/// one-time, so a protect, a refund note and a same-chain receipt link to nothing else; the view key cannot derive it.
/// Pinned by packages/protocol/test/vectors/owner-keys.json (tests/wallet.rs).
pub fn derive_owner_key(spend_key: &Fr, note_secret: &Fr) -> Fr {
    let mut b = [0u8; 75];
    b[..32].copy_from_slice(&fr_to_be32(spend_key));
    b[32..43].copy_from_slice(OWNER_KEY_LABEL.as_bytes());
    b[43..].copy_from_slice(&fr_to_be32(note_secret));
    fr_from_be_mod(&keccak256(&b))
}
