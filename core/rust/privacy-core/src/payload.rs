//! Output payloads (spec §12) and the chain/core binding (spec §11), as reference/typescript/src/payload.ts.
use crate::domains::{keccak256, output_binding_tag, tx_domain_tag};
use crate::field::{fr_from_be_mod, fr_to_be32, Fr};

pub const NOTE_DATA_BYTES: usize = 169;

pub fn protocol_id() -> [u8; 32] {
    keccak256(b"privacy-protocol/v1.0")
}

pub fn circuit_id() -> [u8; 32] {
    keccak256(b"privacy-protocol/v1/circuit/transaction-2in3out-depth32-poseidon2")
}

#[derive(Debug, PartialEq, Eq)]
pub enum PayloadError {
    WrongLength(usize),
}

/// noteDataHash = keccak256(OUTPUT_BINDING tag ‖ noteData) mod p — what PrivacyCore.noteDataHash computes.
pub fn note_data_hash(note_data: &[u8]) -> Result<Fr, PayloadError> {
    if note_data.len() != NOTE_DATA_BYTES {
        return Err(PayloadError::WrongLength(note_data.len()));
    }
    let mut pre = output_binding_tag();
    pre.extend_from_slice(note_data);
    Ok(fr_from_be_mod(&keccak256(&pre)))
}

/// txDomain = keccak256(abi.encode(TX_DOMAIN_TAG, PROTOCOL_ID, chainId, coreAddress, CIRCUIT_ID)) mod p —
/// five left-padded 32-byte words.
pub fn tx_domain(chain_id: u64, core_address: &[u8; 20]) -> Fr {
    let mut pre = Vec::with_capacity(160);
    pre.extend_from_slice(&tx_domain_tag());
    pre.extend_from_slice(&protocol_id());
    let mut w = [0u8; 32];
    w[24..].copy_from_slice(&chain_id.to_be_bytes());
    pre.extend_from_slice(&w);
    let mut a = [0u8; 32];
    a[12..].copy_from_slice(core_address);
    pre.extend_from_slice(&a);
    pre.extend_from_slice(&circuit_id());
    fr_from_be_mod(&keccak256(&pre))
}

/// Plaintext of the envelope: amount ‖ noteSecret ‖ vaultId, 3 × 32 bytes (spec §12).
pub fn pack_plaintext(amount: &Fr, note_secret: &Fr, vault_id: &Fr) -> [u8; 96] {
    let mut out = [0u8; 96];
    out[..32].copy_from_slice(&fr_to_be32(amount));
    out[32..64].copy_from_slice(&fr_to_be32(note_secret));
    out[64..].copy_from_slice(&fr_to_be32(vault_id));
    out
}
