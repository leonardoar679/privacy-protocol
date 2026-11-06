//! The UniFFI surface of the protocol's Rust core and native prover (plan §40, §43, §69 "one core"):
//! what the iOS (Swift) and Android (Kotlin) wallets call, with Python bindings generated from the
//! same compiled library for the tests here (tests/python). Byte conventions are the WASM surface's:
//! field elements as 32-byte big-endian words (canonical, below p), keys as raw bytes, addresses and
//! phrases as strings. No randomness is drawn inside: salts, nonces, ephemeral keys and a proof's
//! blinding come from the platform's CSPRNG through the arguments.
use privacy_core::field::{fr_from_be32_checked, fr_to_be32, Fr};
use std::sync::{Arc, Mutex};

uniffi::setup_scaffolding!();

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum CoreError {
    #[error("invalid input: {reason}")]
    Invalid { reason: String },
    #[error("witness: {reason}")]
    Witness { reason: String },
    #[error("proving: {reason}")]
    Proving { reason: String },
}

fn invalid(reason: impl Into<String>) -> CoreError {
    CoreError::Invalid { reason: reason.into() }
}
fn fr(b: &[u8], what: &str) -> Result<Fr, CoreError> {
    let arr: [u8; 32] = b.try_into().map_err(|_| invalid(format!("{what}: expected a 32-byte field element")))?;
    fr_from_be32_checked(&arr).ok_or_else(|| invalid(format!("{what}: not a canonical field element (>= p)")))
}
fn fixed<const N: usize>(b: &[u8], what: &str) -> Result<[u8; N], CoreError> {
    b.try_into().map_err(|_| invalid(format!("{what}: expected {N} bytes")))
}
fn out(x: &Fr) -> Vec<u8> {
    fr_to_be32(x).to_vec()
}
fn words(b: &[u8], what: &str) -> Result<Vec<Fr>, CoreError> {
    if b.len() % 32 != 0 {
        return Err(invalid(format!("{what}: expected whole 32-byte words")));
    }
    b.chunks(32).enumerate().map(|(i, w)| fr(w, &format!("{what}[{i}]"))).collect()
}

// ---- keys, notes, nullifiers (spec §4–§5)

#[derive(uniffi::Record)]
pub struct WalletKeys {
    pub spend_key: Vec<u8>,
    pub view_key: Vec<u8>,
    pub note_key: Vec<u8>,
}

/// The three wallet keys of a master seed (spec §4); an empty or all-zero seed is refused (the eleventh review round, G11-7).
#[uniffi::export]
pub fn derive_wallet_keys(seed: Vec<u8>) -> Result<WalletKeys, CoreError> {
    let k = privacy_core::keys::derive_keys(&seed).map_err(|e| invalid(e.to_string()))?;
    Ok(WalletKeys { spend_key: out(&k.spend_key), view_key: out(&k.view_key), note_key: out(&k.note_key) })
}

#[uniffi::export]
pub fn derive_note_secret(note_key: Vec<u8>, counter: u64) -> Result<Vec<u8>, CoreError> {
    Ok(out(&privacy_core::keys::derive_note_secret(&fr(&note_key, "note key")?, counter)))
}

/// The receiving half of a privacy address: H(OWNER_COMMITMENT, spendKey).
#[uniffi::export]
pub fn owner_commitment(spend_key: Vec<u8>) -> Result<Vec<u8>, CoreError> {
    Ok(out(&privacy_core::note::owner_commitment_of(&fr(&spend_key, "spend key")?)))
}

#[derive(uniffi::Record)]
pub struct Note {
    pub vault_id: Vec<u8>,
    pub amount: Vec<u8>,
    pub owner_commitment: Vec<u8>,
    pub note_secret: Vec<u8>,
}

fn core_note(n: &Note) -> Result<privacy_core::note::Note, CoreError> {
    Ok(privacy_core::note::Note { vault_id: fr(&n.vault_id, "vault id")?, amount: fr(&n.amount, "amount")?, owner_commitment: fr(&n.owner_commitment, "owner commitment")?, note_secret: fr(&n.note_secret, "note secret")? })
}

/// The leaf a note becomes at `leaf_index`: H(NOTE_COMMITMENT, body, leafIndex).
#[uniffi::export]
pub fn note_commitment(note: Note, leaf_index: u64) -> Result<Vec<u8>, CoreError> {
    let n = core_note(&note)?;
    Ok(out(&privacy_core::note::note_commitment(&privacy_core::note::note_body(&n), leaf_index)))
}

#[uniffi::export]
pub fn nullifier(commitment: Vec<u8>, spend_key: Vec<u8>) -> Result<Vec<u8>, CoreError> {
    Ok(out(&privacy_core::note::nullifier(&fr(&commitment, "commitment")?, &fr(&spend_key, "spend key")?)))
}

/// Poseidon2 (BN254, the Noir sponge) over n concatenated 32-byte words.
#[uniffi::export]
pub fn poseidon2_hash(words_be: Vec<u8>) -> Result<Vec<u8>, CoreError> {
    Ok(out(&privacy_core::poseidon2::hash(&words(&words_be, "input")?)))
}

// ---- privacy address, payload envelope, bindings (spec §12, crypto-spec)

#[uniffi::export]
pub fn view_public_key(view_key: Vec<u8>) -> Result<Vec<u8>, CoreError> {
    Ok(privacy_core::envelope::view_key_pair(&fr(&view_key, "view key")?).public.to_vec())
}

#[derive(uniffi::Record)]
pub struct PrivacyAddress {
    pub owner_commitment: Vec<u8>,
    pub view_pub: Vec<u8>,
}

/// The bech32m "pp1…" address of (owner commitment, view public key).
#[uniffi::export]
pub fn privacy_address(owner_commitment: Vec<u8>, view_pub: Vec<u8>) -> Result<String, CoreError> {
    Ok(privacy_core::address::encode_privacy_address(&fr(&owner_commitment, "owner commitment")?, &fixed::<32>(&view_pub, "view public key")?))
}

#[uniffi::export]
pub fn parse_privacy_address(address: String) -> Result<PrivacyAddress, CoreError> {
    let a = privacy_core::address::decode_privacy_address(&address).map_err(|e| invalid(format!("privacy address: {e:?}")))?;
    Ok(PrivacyAddress { owner_commitment: out(&a.owner_commitment), view_pub: a.view_pub.to_vec() })
}

#[derive(uniffi::Record)]
pub struct NotePlaintext {
    pub amount: Vec<u8>,
    pub note_secret: Vec<u8>,
    pub vault_id: Vec<u8>,
}

/// The 169-byte payload of a note for the holder of `view_pub`; 32 + 24 fresh random bytes from the caller.
#[uniffi::export]
pub fn encrypt_note_data(view_pub: Vec<u8>, plain: NotePlaintext, ephemeral_secret: Vec<u8>, nonce: Vec<u8>) -> Result<Vec<u8>, CoreError> {
    let p = privacy_core::envelope::NotePlaintext { amount: fr(&plain.amount, "amount")?, note_secret: fr(&plain.note_secret, "note secret")?, vault_id: fr(&plain.vault_id, "vault id")? };
    Ok(privacy_core::envelope::encrypt_note_data(&fixed::<32>(&view_pub, "view public key")?, &p, fixed::<32>(&ephemeral_secret, "ephemeral secret")?, fixed::<24>(&nonce, "nonce")?)
        .map_err(|e| invalid(format!("view public key: {e:?}")))?
        .to_vec())
}

/// The opening of a payload encrypted to this view key, or None (someone else's, a dummy, tampered).
#[uniffi::export]
pub fn decrypt_note_data(view_key: Vec<u8>, note_data: Vec<u8>) -> Result<Option<NotePlaintext>, CoreError> {
    let view = privacy_core::envelope::view_key_pair(&fr(&view_key, "view key")?);
    Ok(privacy_core::envelope::decrypt_note_data(&view, &note_data).map(|p| NotePlaintext { amount: out(&p.amount), note_secret: out(&p.note_secret), vault_id: out(&p.vault_id) }))
}

#[uniffi::export]
pub fn note_data_hash(note_data: Vec<u8>) -> Result<Vec<u8>, CoreError> {
    privacy_core::payload::note_data_hash(&note_data).map(|x| out(&x)).map_err(|_| invalid("noteData must be 169 bytes"))
}

/// The chain + core binding every proof carries (spec §11).
#[uniffi::export]
pub fn tx_domain(chain_id: u64, core_address: Vec<u8>) -> Result<Vec<u8>, CoreError> {
    Ok(out(&privacy_core::payload::tx_domain(chain_id, &fixed::<20>(&core_address, "core address")?)))
}

// ---- the tree and note discovery (the two batches a sync is made of)

fn checked_levels(levels: u32) -> Result<usize, CoreError> {
    if (3..=32).contains(&levels) {
        Ok(levels as usize)
    } else {
        Err(invalid("levels must be 3..=32"))
    }
}

/// Root of the tree over `leaves` (k × 32 bytes, ZERO_LEAF padding included).
#[uniffi::export]
pub fn merkle_root(leaves: Vec<u8>, levels: u32) -> Result<Vec<u8>, CoreError> {
    let levels = checked_levels(levels)?;
    let l = privacy_core::merkle::layers(&words(&leaves, "leaves")?, levels);
    Ok(out(&privacy_core::merkle::layers_root(&l, levels)))
}

#[derive(uniffi::Record)]
pub struct MerklePath {
    pub root: Vec<u8>,
    pub path_elements: Vec<Vec<u8>>,
    /// 1 where the node is the right child at that level
    pub path_indices: Vec<u8>,
}

#[uniffi::export]
pub fn merkle_path(leaves: Vec<u8>, index: u32, levels: u32) -> Result<MerklePath, CoreError> {
    let levels = checked_levels(levels)?;
    let leaves = words(&leaves, "leaves")?;
    if index as usize >= leaves.len() {
        return Err(invalid("leaf index out of range"));
    }
    let p = privacy_core::merkle::proof_from_layers(&privacy_core::merkle::layers(&leaves, levels), index as usize, levels);
    Ok(MerklePath { root: out(&p.root), path_elements: p.path_elements.iter().map(out).collect(), path_indices: p.path_indices })
}

#[derive(uniffi::Record)]
pub struct DiscoveredNote {
    pub leaf_index: u32,
    pub amount: Vec<u8>,
    pub note_secret: Vec<u8>,
    pub vault_id: Vec<u8>,
}

/// Note discovery over a whole log set: the payloads that open with this view key AND reproduce their leaf.
#[uniffi::export]
pub fn scan_note_payloads(view_key: Vec<u8>, owner_commitment: Vec<u8>, leaf_indexes: Vec<u32>, commitments: Vec<u8>, payloads: Vec<u8>) -> Result<Vec<DiscoveredNote>, CoreError> {
    let n = leaf_indexes.len();
    let size = privacy_core::payload::NOTE_DATA_BYTES;
    if commitments.len() != n * 32 || payloads.len() != n * size {
        return Err(invalid("leaf indexes, commitments (32 bytes each) and payloads (169 bytes each) must have the same count"));
    }
    let view = privacy_core::envelope::view_key_pair(&fr(&view_key, "view key")?);
    let oc = fr(&owner_commitment, "owner commitment")?;
    let leaves = words(&commitments, "commitments")?;
    let items = (0..n).map(|i| (leaf_indexes[i], leaves[i], &payloads[i * size..(i + 1) * size]));
    Ok(privacy_core::note::scan_payloads(&view, &oc, items)
        .into_iter()
        .map(|d| DiscoveredNote { leaf_index: d.leaf_index, amount: out(&d.note.amount), note_secret: out(&d.note.note_secret), vault_id: out(&d.note.vault_id) })
        .collect())
}

// ---- recovery: phrase, keystore, journal (docs/wallet-formats.md — the web wallet's formats, byte for byte)

#[uniffi::export]
pub fn seed_to_phrase(seed: Vec<u8>) -> Result<String, CoreError> {
    Ok(privacy_core::bip39::seed_to_phrase(&fixed::<32>(&seed, "seed")?))
}

#[uniffi::export]
pub fn phrase_to_seed(phrase: String) -> Result<Vec<u8>, CoreError> {
    privacy_core::bip39::phrase_to_seed(&phrase).map(|s| s.to_vec()).map_err(|e| invalid(format!("recovery phrase: {e:?}")))
}

#[uniffi::export]
pub fn validate_phrase(phrase: String) -> bool {
    privacy_core::bip39::validate_mnemonic(&phrase)
}

/// The 64-byte BIP-39 seed the chain keys derive from.
#[uniffi::export]
pub fn mnemonic_to_seed(phrase: String, passphrase: String) -> Vec<u8> {
    privacy_core::bip39::mnemonic_to_seed(&phrase, &passphrase).to_vec()
}

/// The keystore JSON for `seed` under `password`: scrypt (N = 2^log2_n, r 8, p 1) + XChaCha20-Poly1305;
/// 16 salt and 24 nonce bytes from the caller.
#[uniffi::export]
pub fn create_keystore(seed: Vec<u8>, password: String, log2_n: u8, salt: Vec<u8>, nonce: Vec<u8>) -> Result<String, CoreError> {
    if !(10..=20).contains(&log2_n) {
        return Err(invalid("log2_n must be 10..=20"));
    }
    let params = privacy_core::keystore::KdfParams { name: "scrypt".into(), n: 1 << log2_n, r: 8, p: 1, dk_len: 32 };
    let ks = privacy_core::keystore::create_keystore(&fixed::<32>(&seed, "seed")?, &password, &params, fixed::<16>(&salt, "salt")?, fixed::<24>(&nonce, "nonce")?).map_err(|e| invalid(format!("keystore: {e:?}")))?;
    serde_json::to_string(&ks).map_err(|e| invalid(e.to_string()))
}

/// The seed in a keystore JSON, or None when the password is wrong.
#[uniffi::export]
pub fn unlock_keystore(keystore_json: String, password: String) -> Result<Option<Vec<u8>>, CoreError> {
    let ks: privacy_core::keystore::Keystore = serde_json::from_str(&keystore_json).map_err(|e| invalid(format!("keystore JSON: {e}")))?;
    match privacy_core::keystore::unlock_keystore(&ks, &password) {
        Ok(seed) => Ok(Some(seed.to_vec())),
        Err(privacy_core::keystore::KeystoreError::WrongPassword) => Ok(None),
        Err(e) => Err(invalid(format!("keystore: {e:?}"))),
    }
}

#[uniffi::export]
pub fn journal_key(seed: Vec<u8>) -> Result<Vec<u8>, CoreError> {
    Ok(privacy_core::keystore::journal_key(&fixed::<32>(&seed, "seed")?).to_vec())
}

#[uniffi::export]
pub fn encrypt_journal(key: Vec<u8>, plaintext_json: String, nonce: Vec<u8>) -> Result<String, CoreError> {
    let blob = privacy_core::keystore::encrypt_journal(&fixed::<32>(&key, "journal key")?, &plaintext_json, fixed::<24>(&nonce, "nonce")?);
    serde_json::to_string(&blob).map_err(|e| invalid(e.to_string()))
}

#[uniffi::export]
pub fn decrypt_journal(key: Vec<u8>, encrypted_json: String) -> Result<Option<String>, CoreError> {
    let blob: privacy_core::keystore::EncryptedJournal = serde_json::from_str(&encrypted_json).map_err(|e| invalid(format!("journal JSON: {e}")))?;
    Ok(privacy_core::keystore::decrypt_journal(&fixed::<32>(&key, "journal key")?, &blob))
}

// ---- Chain Key Abstraction (plan §45): fresh receive addresses per chain

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum Chain {
    Evm,
    Bitcoin,
    Solana,
}

#[derive(uniffi::Record)]
pub struct ChainAddress {
    pub chain: Chain,
    pub index: u32,
    pub path: String,
    pub address: String,
    pub public_key: Vec<u8>,
}

fn chain_address_of(a: privacy_core::chainkeys::ChainAccount) -> ChainAddress {
    let chain = match a.chain {
        privacy_core::chainkeys::ChainKind::Evm => Chain::Evm,
        privacy_core::chainkeys::ChainKind::Bitcoin => Chain::Bitcoin,
        privacy_core::chainkeys::ChainKind::Solana => Chain::Solana,
    };
    ChainAddress { chain, index: a.index, path: a.path, address: a.address, public_key: a.public_key }
}

/// Account `index` of a chain (EVM BIP-44, Bitcoin BIP-84 P2WPKH, Solana SLIP-0010) from the 64-byte BIP-39 seed.
#[uniffi::export]
pub fn chain_address(chain: Chain, seed64: Vec<u8>, index: u32) -> Result<ChainAddress, CoreError> {
    let kind = match chain {
        Chain::Evm => privacy_core::chainkeys::ChainKind::Evm,
        Chain::Bitcoin => privacy_core::chainkeys::ChainKind::Bitcoin,
        Chain::Solana => privacy_core::chainkeys::ChainKind::Solana,
    };
    privacy_core::chainkeys::account_for(kind, &seed64, index).map(chain_address_of).map_err(|e| invalid(format!("chain key: {e:?}")))
}

/// The EVM account a dApp origin gets (plan §37: one account per site, unlinkable across sites).
#[uniffi::export]
pub fn dapp_address(seed64: Vec<u8>, origin: String) -> Result<ChainAddress, CoreError> {
    privacy_core::chainkeys::dapp_account(&seed64, &origin).map(chain_address_of).map_err(|e| invalid(format!("chain key: {e:?}")))
}

// ---- native proving (privacy-core/privacy-prover): circuit inputs → witness → Groth16 proof

#[derive(uniffi::Record)]
pub struct TransactProof {
    /// abi.encode(uint256[2] a, uint256[2][2] b, uint256[2] c): the `proof` argument of PrivacyCore.transact
    pub proof: Vec<u8>,
    /// the public inputs, 32-byte big-endian words in PrivacyCore.encodePublicInputs order
    pub public_inputs: Vec<Vec<u8>>,
    /// the same proof as snarkjs JSON
    pub proof_json: String,
}

/// A loaded proving key and witness program; reuse it for every proof (loading is the slow part).
#[derive(uniffi::Object)]
pub struct Prover {
    zkey: privacy_prover::Zkey,
    witness: Mutex<privacy_prover::WitnessCalculator>,
}

#[uniffi::export]
impl Prover {
    /// The proving key (`transaction_final.zkey`) and the circuit's witness program (`transaction.wasm`);
    /// the app ships both or fetches them pinned by hash. Refuses a pair that does not belong together.
    #[uniffi::constructor]
    pub fn new(zkey: Vec<u8>, circuit_wasm: Vec<u8>) -> Result<Arc<Self>, CoreError> {
        let zkey = privacy_prover::read_zkey(&zkey).map_err(|e| invalid(format!("zkey: {e:?}")))?;
        let calc = privacy_prover::WitnessCalculator::new(&circuit_wasm).map_err(|e| CoreError::Witness { reason: format!("{e:?}") })?;
        if calc.witness_size != zkey.n_vars {
            return Err(invalid("the circuit and the proving key do not belong together"));
        }
        Ok(Arc::new(Self { zkey, witness: Mutex::new(calc) }))
    }

    pub fn public_input_count(&self) -> u32 {
        self.zkey.n_public as u32
    }

    /// Circuit inputs (the JSON packages/protocol/src/txInputs.ts builds) → witness → proof, verified
    /// before it is returned. The witness's public inputs must be exactly the ones the inputs declare
    /// (a tampered witness program could otherwise prove another statement with the same spending key).
    /// `r` and `s`: 32 fresh CSPRNG bytes each (the proof's blinding).
    pub fn prove(&self, inputs_json: String, r: Vec<u8>, s: Vec<u8>) -> Result<TransactProof, CoreError> {
        let v: serde_json::Value = serde_json::from_str(&inputs_json).map_err(|e| invalid(format!("inputs JSON: {e}")))?;
        let inputs = privacy_prover::inputs_from_json(&v).map_err(|e| invalid(format!("inputs: {e:?}")))?;
        let w = {
            let mut calc = self.witness.lock().map_err(|_| CoreError::Witness { reason: "the witness calculator was poisoned by an earlier panic".into() })?;
            calc.calculate(&inputs).map_err(|e| CoreError::Witness { reason: format!("{e:?}") })?
        };
        privacy_prover::check_statement(&inputs, &w).map_err(|e| CoreError::Witness { reason: format!("{e:?}") })?;
        let (r, s) = (privacy_prover::fr_from_bytes(&fixed::<32>(&r, "r")?), privacy_prover::fr_from_bytes(&fixed::<32>(&s, "s")?));
        let proof = privacy_prover::prove(&self.zkey, &w, r, s).map_err(|e| CoreError::Proving { reason: format!("{e:?}") })?;
        let public = privacy_prover::public_inputs(&self.zkey, &w);
        if !privacy_prover::verify(&self.zkey.pk.vk, &proof, public) {
            return Err(CoreError::Proving { reason: "the proof does not verify".into() });
        }
        Ok(TransactProof {
            proof: privacy_prover::calldata_bytes(&proof).to_vec(),
            public_inputs: public.iter().map(out).collect(),
            proof_json: serde_json::to_string(&privacy_prover::to_snarkjs(&proof)).map_err(|e| CoreError::Proving { reason: e.to_string() })?,
        })
    }

    /// The contract's check, off-chain: a 256-byte proof against its public inputs under this key.
    pub fn verify(&self, proof: Vec<u8>, public_inputs: Vec<Vec<u8>>) -> Result<bool, CoreError> {
        let p = privacy_prover::from_calldata_bytes(&proof).map_err(|e| invalid(format!("proof: {e:?}")))?;
        if public_inputs.len() != self.zkey.n_public {
            return Err(invalid(format!("expected {} public inputs", self.zkey.n_public)));
        }
        let ins = public_inputs.iter().enumerate().map(|(i, x)| fr(x, &format!("public input {i}"))).collect::<Result<Vec<_>, _>>()?;
        Ok(privacy_prover::verify(&self.zkey.pk.vk, &p, &ins))
    }
}
