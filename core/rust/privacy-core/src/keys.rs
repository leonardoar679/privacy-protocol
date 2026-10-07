//! Wallet-side key derivation (spec §4), the reference derivation of reference/typescript/src/keys.ts:
//! `spendKey / viewKey / noteKey = keccak256(seed ‖ "/spend" | "/view" | "/note") mod p`, and the
//! per-note secret `keccak256(be32(noteKey) ‖ be64(counter)) mod p` (spec §5.5, never reused). The
//! master seed never leaves the client; a native wallet keeps it in the OS keystore.
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

pub fn derive_keys(master_seed: &[u8]) -> WalletKeys {
    WalletKeys { spend_key: derive_field(master_seed, "/spend"), view_key: derive_field(master_seed, "/view"), note_key: derive_field(master_seed, "/note") }
}

/// noteSecret for the wallet's own notes: keccak(noteKey ‖ uint64 counter) mod p.
pub fn derive_note_secret(note_key: &Fr, counter: u64) -> Fr {
    let mut b = [0u8; 40];
    b[..32].copy_from_slice(&fr_to_be32(note_key));
    b[32..].copy_from_slice(&counter.to_be_bytes());
    fr_from_be_mod(&keccak256(&b))
}
