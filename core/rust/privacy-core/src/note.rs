//! Notes (spec §5): owner commitment, the two-layer commitment, nullifiers (1:1 + phantom padding,
//! spec §5.3–5.4), the 121-byte wallet record, and note discovery from an envelope — mirroring
//! reference/typescript/src/{note,nullifier}.ts and NoteLib.sol / NullifierLib.sol.
use crate::domains;
use crate::envelope::{decrypt_note_data, ViewKeyPair};
use crate::field::{fr_from_be_mod, fr_to_be32, Fr};
use crate::poseidon2::{hash2, hash3, hash4, hash5};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Note {
    /// canonical vault address as a field element (uint160)
    pub vault_id: Fr,
    pub amount: Fr,
    pub owner_commitment: Fr,
    pub note_secret: Fr,
}

/// ownerCommitment = H(OWNER_COMMITMENT, spendKey) — the receiving address (spec §4).
pub fn owner_commitment_of(spend_key: &Fr) -> Fr {
    hash2(domains::owner_commitment(), *spend_key)
}

/// body = H(NOTE_BODY, vaultId, amount, ownerCommitment, noteSecret) — 5 inputs (spec §5.2).
pub fn note_body(n: &Note) -> Fr {
    hash5(domains::note_body(), n.vault_id, n.amount, n.owner_commitment, n.note_secret)
}

/// commitment = H(NOTE_COMMITMENT, body, leafIndex) — the contract assigns leafIndex.
pub fn note_commitment(body: &Fr, leaf_index: u64) -> Fr {
    hash3(domains::note_commitment(), *body, Fr::from(leaf_index))
}

/// nullifier = H(NULLIFIER, commitment, spendKey).
pub fn nullifier(commitment: &Fr, spend_key: &Fr) -> Fr {
    hash3(domains::nullifier(), *commitment, *spend_key)
}

/// Nullifier of an unused input slot: H(PHANTOM_NULLIFIER, nullifier0, inputIndex, spendKey0) — unique per
/// transaction and not recomputable by an observer (PP-P02).
pub fn phantom_nullifier(nullifier0: &Fr, input_index: u64, spend_key0: &Fr) -> Fr {
    hash4(domains::phantom_nullifier(), *nullifier0, Fr::from(input_index), *spend_key0)
}

pub const NOTE_RECORD_BYTES: usize = 121;

#[derive(Debug, PartialEq, Eq)]
pub enum NoteError {
    NotAV1Record,
    VaultIdTooLarge,
}

/// Wallet record, exact 121-byte encoding (spec §5.1): 0x01 ‖ vaultId(20) ‖ amount(32) ‖ ownerCommitment(32) ‖ noteSecret(32) ‖ leafIndex(4).
pub fn encode_note(n: &Note, leaf_index: u32) -> Result<[u8; NOTE_RECORD_BYTES], NoteError> {
    let vault = fr_to_be32(&n.vault_id);
    if vault[..12].iter().any(|&b| b != 0) {
        return Err(NoteError::VaultIdTooLarge);
    }
    let mut out = [0u8; NOTE_RECORD_BYTES];
    out[0] = 0x01;
    out[1..21].copy_from_slice(&vault[12..]);
    out[21..53].copy_from_slice(&fr_to_be32(&n.amount));
    out[53..85].copy_from_slice(&fr_to_be32(&n.owner_commitment));
    out[85..117].copy_from_slice(&fr_to_be32(&n.note_secret));
    out[117..].copy_from_slice(&leaf_index.to_be_bytes());
    Ok(out)
}

pub fn decode_note(b: &[u8]) -> Result<(Note, u32), NoteError> {
    if b.len() != NOTE_RECORD_BYTES || b[0] != 0x01 {
        return Err(NoteError::NotAV1Record);
    }
    let note = Note { vault_id: fr_from_be_mod(&b[1..21]), amount: fr_from_be_mod(&b[21..53]), owner_commitment: fr_from_be_mod(&b[53..85]), note_secret: fr_from_be_mod(&b[85..117]) };
    let leaf_index = u32::from_be_bytes([b[117], b[118], b[119], b[120]]);
    Ok((note, leaf_index))
}

/// Note discovery: given a leaf's commitment and payload, the note it opens for this wallet — or None.
/// The decrypted opening must reproduce the leaf's commitment with OUR owner commitment, so a payload
/// that decrypts but does not open the leaf (malicious or someone else's) is rejected.
pub fn note_from_payload(view: &ViewKeyPair, owner_commitment: &Fr, leaf_index: u64, leaf: &Fr, note_data: &[u8]) -> Option<Note> {
    let pt = decrypt_note_data(view, note_data)?;
    let note = Note { vault_id: pt.vault_id, amount: pt.amount, owner_commitment: *owner_commitment, note_secret: pt.note_secret };
    if note_commitment(&note_body(&note), leaf_index) == *leaf { Some(note) } else { None }
}
