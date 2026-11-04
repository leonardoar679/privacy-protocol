//! Output payload envelope (spec §12, pinned layout) and the binding of the view key to it — the
//! reference's PROPOSAL (docs/crypto-spec.md), byte-identical to packages/protocol/src/envelope.ts:
//!
//!   viewKey (field element)  →  X25519 secret = clamp(sha256("privacy-protocol/v1/view-x25519" ‖ be32(viewKey)))
//!   envelope                 =  0x01 ‖ ephPub(32) ‖ nonce(24) ‖ XChaCha20-Poly1305(key, nonce, aad)(amount ‖ noteSecret ‖ vaultId)(96 + 16)
//!   key                      =  sha256("privacy-protocol/v1/envelope-key" ‖ x25519(eph, viewPub) ‖ ephPub ‖ viewPub)
//!   aad                      =  0x01 ‖ ephPub
//!
//! Randomness (the ephemeral secret and the nonce) is supplied by the caller: the platform wallet
//! owns its CSPRNG. Authenticity of a discovered note does not rest on the AEAD alone: `note::note_from_payload`
//! recomputes the commitment with the wallet's own owner commitment and checks it against the leaf.
use crate::field::{fr_from_be32_checked, fr_to_be32, Fr};
use crate::payload::{pack_plaintext, NOTE_DATA_BYTES};
use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};

pub const ENVELOPE_VERSION: u8 = 0x01;
pub const VIEW_X25519_TAG: &[u8] = b"privacy-protocol/v1/view-x25519";
pub const ENVELOPE_KEY_TAG: &[u8] = b"privacy-protocol/v1/envelope-key";
const EPH_OFF: usize = 1;
const NONCE_OFF: usize = 33;
const CT_OFF: usize = 57;
const CT_LEN: usize = 96 + 16;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ViewKeyPair {
    pub secret: [u8; 32],
    pub public: [u8; 32],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NotePlaintext {
    pub amount: Fr,
    pub note_secret: Fr,
    pub vault_id: Fr,
}

fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn clamp(mut k: [u8; 32]) -> [u8; 32] {
    k[0] &= 248;
    k[31] &= 127;
    k[31] |= 64;
    k
}

/// The X25519 key pair a wallet derives from its view key; `public` is the second half of its privacy address.
pub fn view_key_pair(view_key: &Fr) -> ViewKeyPair {
    let secret = clamp(sha256(&[VIEW_X25519_TAG, &fr_to_be32(view_key)]));
    let public = PublicKey::from(&StaticSecret::from(secret)).to_bytes();
    ViewKeyPair { secret, public }
}

fn envelope_key(shared: &[u8; 32], eph_pub: &[u8; 32], view_pub: &[u8; 32]) -> [u8; 32] {
    sha256(&[ENVELOPE_KEY_TAG, shared, eph_pub, view_pub])
}

/// Why a payload could not be made (audit round 2, n28).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EnvelopeError {
    /// The recipient's view key is a low-order point: the shared secret is the same for every sender.
    LowOrderViewKey,
    /// The recipient's view key is not in canonical form (bit 255 set, or u of 2^255 − 19 or more): the key derivation hashes the bytes as
    /// given, so the recipient, hashing the canonical key, could never open the payment (the seventh review round, 2026-11-03).
    NonCanonicalViewKey,
}

/// A view public key in canonical form: its little-endian u-coordinate below 2^255 − 19 (the seventh review round, 2026-11-03).
pub fn is_canonical_view_key(view_pub: &[u8; 32]) -> bool {
    // p = 2^255 − 19, little-endian: ed ff … ff 7f
    if view_pub[31] & 0x80 != 0 {
        return false;
    }
    if view_pub[31] != 0x7f || view_pub[1..31].iter().any(|&b| b != 0xff) {
        return true;
    }
    view_pub[0] < 0xed
}

/// Whether a view public key can be paid privately: never a low-order point (a low-order point times any clamped scalar, a
/// multiple of the cofactor, is the identity, which X25519 returns as an all-zero secret).
pub fn is_contributory_view_key(view_pub: &[u8; 32]) -> bool {
    StaticSecret::from(clamp([1u8; 32])).diffie_hellman(&PublicKey::from(*view_pub)).was_contributory()
}

/// Encrypt a note's opening to the recipient's view public key with a caller-supplied ephemeral secret and nonce. A low-order
/// view key is refused (audit round 2, n28): its shared secret is all zero whatever the sender's secret, so the envelope's
/// key, sha256(tag ‖ 0³² ‖ ephPub ‖ viewPub), is public data, and anyone reads the payment's amount, note secret and vault.
/// The TypeScript refuses it too (noble's zero-result check).
pub fn encrypt_note_data(recipient_view_pub: &[u8; 32], plain: &NotePlaintext, ephemeral_secret: [u8; 32], nonce: [u8; 24]) -> Result<[u8; NOTE_DATA_BYTES], EnvelopeError> {
    if !is_canonical_view_key(recipient_view_pub) {
        return Err(EnvelopeError::NonCanonicalViewKey);
    }
    let eph = StaticSecret::from(clamp(ephemeral_secret));
    let eph_pub = PublicKey::from(&eph).to_bytes();
    let shared = eph.diffie_hellman(&PublicKey::from(*recipient_view_pub));
    if !shared.was_contributory() {
        return Err(EnvelopeError::LowOrderViewKey);
    }
    let shared = shared.to_bytes();
    let mut out = [0u8; NOTE_DATA_BYTES];
    out[0] = ENVELOPE_VERSION;
    out[EPH_OFF..NONCE_OFF].copy_from_slice(&eph_pub);
    out[NONCE_OFF..CT_OFF].copy_from_slice(&nonce);
    let aad = out[..NONCE_OFF].to_vec();
    let cipher = XChaCha20Poly1305::new((&envelope_key(&shared, &eph_pub, recipient_view_pub)).into());
    let ct = cipher.encrypt(XNonce::from_slice(&nonce), Payload { msg: &pack_plaintext(&plain.amount, &plain.note_secret, &plain.vault_id), aad: &aad }).expect("XChaCha20-Poly1305 never fails on a 96-byte message");
    debug_assert_eq!(ct.len(), CT_LEN);
    out[CT_OFF..].copy_from_slice(&ct);
    Ok(out)
}

/// Try to open a payload with this view key: the plaintext, or None (wrong recipient, tampered, other version).
pub fn decrypt_note_data(view: &ViewKeyPair, note_data: &[u8]) -> Option<NotePlaintext> {
    if note_data.len() != NOTE_DATA_BYTES || note_data[0] != ENVELOPE_VERSION {
        return None;
    }
    let mut eph_pub = [0u8; 32];
    eph_pub.copy_from_slice(&note_data[EPH_OFF..NONCE_OFF]);
    let shared = StaticSecret::from(view.secret).diffie_hellman(&PublicKey::from(eph_pub));
    if !shared.was_contributory() {
        return None; // low-order ephemeral key
    }
    let key = envelope_key(&shared.to_bytes(), &eph_pub, &view.public);
    let cipher = XChaCha20Poly1305::new((&key).into());
    let pt = cipher.decrypt(XNonce::from_slice(&note_data[NONCE_OFF..CT_OFF]), Payload { msg: &note_data[CT_OFF..], aad: &note_data[..NONCE_OFF] }).ok()?;
    if pt.len() != 96 {
        return None;
    }
    let word = |i: usize| -> Option<Fr> {
        let mut b = [0u8; 32];
        b.copy_from_slice(&pt[i * 32..(i + 1) * 32]);
        fr_from_be32_checked(&b)
    };
    Some(NotePlaintext { amount: word(0)?, note_secret: word(1)?, vault_id: word(2)? })
}

/// A dummy output's payload (spec §5.5, §12) from 169 caller-supplied random bytes: same shape as a real envelope, nothing inside it.
pub fn dummy_note_data(random: [u8; NOTE_DATA_BYTES]) -> [u8; NOTE_DATA_BYTES] {
    let mut out = random;
    out[0] = ENVELOPE_VERSION;
    // a real ephemeral key, of the random scalar in those bytes (the seventh review round, 2026-11-03): random bytes there had told a dummy
    // apart from an envelope (bit 255, the twist, the small subgroup) and with it every transaction's output structure
    let mut scalar = [0u8; 32];
    scalar.copy_from_slice(&random[EPH_OFF..NONCE_OFF]);
    let key = PublicKey::from(&StaticSecret::from(clamp(scalar))).to_bytes();
    out[EPH_OFF..NONCE_OFF].copy_from_slice(&key);
    out
}
