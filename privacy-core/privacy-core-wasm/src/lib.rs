//! The WASM surface of privacy-core (plan §40 "WebAssembly", §69 "one core"): every value crosses the
//! boundary as bytes — field elements as 32-byte big-endian words, keys as raw bytes, strings for
//! addresses and phrases. No randomness inside: ephemeral keys, nonces and salts come from the caller.
//! Built with scripts/build-wasm.mjs; checked against the TypeScript reference by
//! packages/protocol/test/wasmCore.test.ts.
use privacy_core::address::{decode_privacy_address, encode_privacy_address};
use privacy_core::bip39::{mnemonic_to_seed as core_mnemonic_to_seed, seed_to_phrase as core_seed_to_phrase};
use privacy_core::chainkeys::{bitcoin_account, evm_account, solana_account};
use privacy_core::envelope::{decrypt_note_data as core_decrypt, encrypt_note_data as core_encrypt, view_key_pair, NotePlaintext};
use privacy_core::field::{fr_from_be32_checked, fr_to_be32, Fr};
use privacy_core::keys::{derive_keys as core_derive_keys, derive_note_secret as core_derive_note_secret};
use privacy_core::keystore::{unlock_keystore as core_unlock, Keystore};
use privacy_core::merkle::{layers, MerkleTree};
use privacy_core::note::{note_body as core_note_body, note_commitment as core_note_commitment, nullifier as core_nullifier, owner_commitment_of, phantom_nullifier as core_phantom, scan_payloads, Note};
use privacy_core::payload::NOTE_DATA_BYTES;
use privacy_core::payload::{note_data_hash as core_note_data_hash, pack_plaintext, tx_domain as core_tx_domain};
use privacy_core::poseidon2::hash;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

fn fr(b: &[u8]) -> Result<Fr, JsError> {
    let arr: [u8; 32] = b.try_into().map_err(|_| JsError::new("expected a 32-byte field element"))?;
    fr_from_be32_checked(&arr).ok_or_else(|| JsError::new("not a canonical field element (>= p)"))
}
fn arr<const N: usize>(b: &[u8], what: &str) -> Result<[u8; N], JsError> {
    b.try_into().map_err(|_| JsError::new(&format!("expected {N} bytes for {what}")))
}
fn out(x: Fr) -> Vec<u8> {
    fr_to_be32(&x).to_vec()
}

/// Poseidon2 (Noir sponge) over n concatenated 32-byte words.
#[wasm_bindgen]
pub fn poseidon2_hash(words: &[u8]) -> Result<Vec<u8>, JsError> {
    if words.len() % 32 != 0 {
        return Err(JsError::new("input must be a multiple of 32 bytes"));
    }
    let inputs: Result<Vec<Fr>, JsError> = words.chunks(32).map(fr).collect();
    Ok(out(hash(&inputs?)))
}

#[wasm_bindgen]
pub fn owner_commitment(spend_key: &[u8]) -> Result<Vec<u8>, JsError> {
    Ok(out(owner_commitment_of(&fr(spend_key)?)))
}

#[wasm_bindgen]
pub fn note_body(vault_id: &[u8], amount: &[u8], owner_commitment: &[u8], note_secret: &[u8]) -> Result<Vec<u8>, JsError> {
    let n = Note { vault_id: fr(vault_id)?, amount: fr(amount)?, owner_commitment: fr(owner_commitment)?, note_secret: fr(note_secret)? };
    Ok(out(core_note_body(&n)))
}

#[wasm_bindgen]
pub fn note_commitment(body: &[u8], leaf_index: u32) -> Result<Vec<u8>, JsError> {
    Ok(out(core_note_commitment(&fr(body)?, leaf_index as u64)))
}

#[wasm_bindgen]
pub fn nullifier(commitment: &[u8], spend_key: &[u8]) -> Result<Vec<u8>, JsError> {
    Ok(out(core_nullifier(&fr(commitment)?, &fr(spend_key)?)))
}

#[wasm_bindgen]
pub fn phantom_nullifier(nullifier0: &[u8], input_index: u32, spend_key0: &[u8]) -> Result<Vec<u8>, JsError> {
    Ok(out(core_phantom(&fr(nullifier0)?, input_index as u64, &fr(spend_key0)?)))
}

/// spendKey ‖ viewKey ‖ noteKey (96 bytes).
#[wasm_bindgen]
pub fn derive_keys(seed: &[u8]) -> Vec<u8> {
    let k = core_derive_keys(seed);
    [fr_to_be32(&k.spend_key), fr_to_be32(&k.view_key), fr_to_be32(&k.note_key)].concat()
}

#[wasm_bindgen]
pub fn derive_note_secret(note_key: &[u8], counter: u32) -> Result<Vec<u8>, JsError> {
    Ok(out(core_derive_note_secret(&fr(note_key)?, counter as u64)))
}

#[wasm_bindgen]
pub fn view_public_key(view_key: &[u8]) -> Result<Vec<u8>, JsError> {
    Ok(view_key_pair(&fr(view_key)?).public.to_vec())
}

/// The 169-byte envelope for (amount, noteSecret, vaultId) to a view public key; ephemeral secret (32) and nonce (24) from the caller.
#[wasm_bindgen]
pub fn encrypt_note_data(view_pub: &[u8], amount: &[u8], note_secret: &[u8], vault_id: &[u8], ephemeral_secret: &[u8], nonce: &[u8]) -> Result<Vec<u8>, JsError> {
    let plain = NotePlaintext { amount: fr(amount)?, note_secret: fr(note_secret)?, vault_id: fr(vault_id)? };
    Ok(core_encrypt(&arr::<32>(view_pub, "view public key")?, &plain, arr::<32>(ephemeral_secret, "ephemeral secret")?, arr::<24>(nonce, "nonce")?).to_vec())
}

/// amount ‖ noteSecret ‖ vaultId (96 bytes) when the payload opens with this view key, else undefined.
#[wasm_bindgen]
pub fn decrypt_note_data(view_key: &[u8], note_data: &[u8]) -> Result<Option<Vec<u8>>, JsError> {
    let view = view_key_pair(&fr(view_key)?);
    Ok(core_decrypt(&view, note_data).map(|p| pack_plaintext(&p.amount, &p.note_secret, &p.vault_id).to_vec()))
}

#[wasm_bindgen]
pub fn note_data_hash(note_data: &[u8]) -> Result<Vec<u8>, JsError> {
    core_note_data_hash(note_data).map(out).map_err(|_| JsError::new("noteData must be 169 bytes"))
}

#[wasm_bindgen]
pub fn tx_domain(chain_id: u32, core_address: &[u8]) -> Result<Vec<u8>, JsError> {
    Ok(out(core_tx_domain(chain_id as u64, &arr::<20>(core_address, "core address")?)))
}

/// Root of a tree with `levels` levels holding `leaves` (k × 32 bytes, k a multiple of 4, ZERO_LEAF padding included).
#[wasm_bindgen]
pub fn merkle_root(leaves: &[u8], levels: u32) -> Result<Vec<u8>, JsError> {
    if leaves.len() % 128 != 0 {
        return Err(JsError::new("leaves must be whole groups of four 32-byte words"));
    }
    let mut tree = MerkleTree::new(levels as usize);
    for g in leaves.chunks(128) {
        let group = [fr(&g[0..32])?, fr(&g[32..64])?, fr(&g[64..96])?, fr(&g[96..128])?];
        tree.insert_group(&group);
    }
    Ok(out(tree.root))
}

/// Layers 1..=levels of the tree over `leaves` (k × 32 bytes, any k), concatenated: layer l holds
/// ceil(size(l-1) / 2) words with size(0) = k, so the caller can split the result without a header;
/// the last word is the root. One call per sync instead of one hash per JS call.
#[wasm_bindgen]
pub fn merkle_layers(leaves: &[u8], levels: u32) -> Result<Vec<u8>, JsError> {
    if leaves.len() % 32 != 0 {
        return Err(JsError::new("leaves must be 32-byte words"));
    }
    if !(3..=32).contains(&levels) {
        return Err(JsError::new("levels out of range"));
    }
    let fr_leaves: Result<Vec<Fr>, JsError> = leaves.chunks(32).map(fr).collect();
    let all = layers(&fr_leaves?, levels as usize);
    let mut out = Vec::with_capacity(all[1..].iter().map(|l| l.len() * 32).sum());
    for layer in &all[1..] {
        for x in layer {
            out.extend_from_slice(&fr_to_be32(x));
        }
    }
    Ok(out)
}

/// Note discovery over a whole log set: the payloads (n × 169 bytes) that open with this view key and
/// reproduce their leaf (commitments n × 32 bytes, leaf indexes n) with `owner_commitment`.
/// Each hit is leafIndex(4, big-endian) ‖ amount(32) ‖ noteSecret(32) ‖ vaultId(32).
#[wasm_bindgen]
pub fn scan_note_payloads(view_key: &[u8], owner_commitment: &[u8], leaf_indexes: &[u32], commitments: &[u8], payloads: &[u8]) -> Result<Vec<u8>, JsError> {
    let n = leaf_indexes.len();
    if commitments.len() != n * 32 || payloads.len() != n * NOTE_DATA_BYTES {
        return Err(JsError::new("leaf indexes, commitments (32 bytes each) and payloads (169 bytes each) must have the same count"));
    }
    let view = view_key_pair(&fr(view_key)?);
    let oc = fr(owner_commitment)?;
    let mut items = Vec::with_capacity(n);
    for i in 0..n {
        items.push((leaf_indexes[i], fr(&commitments[i * 32..(i + 1) * 32])?, &payloads[i * NOTE_DATA_BYTES..(i + 1) * NOTE_DATA_BYTES]));
    }
    let mut out = Vec::new();
    for d in scan_payloads(&view, &oc, items) {
        out.extend_from_slice(&d.leaf_index.to_be_bytes());
        out.extend_from_slice(&fr_to_be32(&d.note.amount));
        out.extend_from_slice(&fr_to_be32(&d.note.note_secret));
        out.extend_from_slice(&fr_to_be32(&d.note.vault_id));
    }
    Ok(out)
}

#[wasm_bindgen]
pub fn privacy_address(owner_commitment: &[u8], view_pub: &[u8]) -> Result<String, JsError> {
    Ok(encode_privacy_address(&fr(owner_commitment)?, &arr::<32>(view_pub, "view public key")?))
}

/// version(1) ‖ ownerCommitment(32) ‖ viewPub(32) of a "pp1…" address.
#[wasm_bindgen]
pub fn parse_privacy_address(s: &str) -> Result<Vec<u8>, JsError> {
    let a = decode_privacy_address(s).map_err(|e| JsError::new(&format!("{e:?}")))?;
    Ok([vec![a.version], fr_to_be32(&a.owner_commitment).to_vec(), a.view_pub.to_vec()].concat())
}

#[wasm_bindgen]
pub fn mnemonic_to_seed(phrase: &str, passphrase: &str) -> Vec<u8> {
    core_mnemonic_to_seed(phrase, passphrase).to_vec()
}

#[wasm_bindgen]
pub fn seed_to_phrase(seed: &[u8]) -> Result<String, JsError> {
    Ok(core_seed_to_phrase(&arr::<32>(seed, "seed")?))
}

#[wasm_bindgen]
pub fn evm_address(seed64: &[u8], index: u32) -> Result<String, JsError> {
    evm_account(seed64, index).map(|a| a.address).map_err(|e| JsError::new(&format!("{e:?}")))
}

#[wasm_bindgen]
pub fn bitcoin_address(seed64: &[u8], index: u32) -> Result<String, JsError> {
    bitcoin_account(seed64, index, 0, "bc").map(|a| a.address).map_err(|e| JsError::new(&format!("{e:?}")))
}

#[wasm_bindgen]
pub fn solana_address(seed64: &[u8], index: u32) -> Result<String, JsError> {
    solana_account(seed64, index).map(|a| a.address).map_err(|e| JsError::new(&format!("{e:?}")))
}

/// The seed of a keystore JSON under `password`, or undefined when the password is wrong.
#[wasm_bindgen]
pub fn unlock_keystore(keystore_json: &str, password: &str) -> Result<Option<Vec<u8>>, JsError> {
    let ks: Keystore = serde_json_from(keystore_json)?;
    match core_unlock(&ks, password) {
        Ok(seed) => Ok(Some(seed.to_vec())),
        Err(privacy_core::keystore::KeystoreError::WrongPassword) => Ok(None),
        Err(e) => Err(JsError::new(&format!("{e:?}"))),
    }
}

fn serde_json_from<T: serde::de::DeserializeOwned>(s: &str) -> Result<T, JsError> {
    serde_json::from_str(s).map_err(|e| JsError::new(&format!("bad keystore JSON: {e}")))
}
