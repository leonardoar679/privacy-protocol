//! The module layout of doc §60 (V6 Stage 4): every grouped path (`crypto`, `notes`, `commitments`, `nullifiers`,
//! `merkle`, `encoding`, `proof`, `wallet`) names the same item as the flat path the WASM package, the FFI, the
//! prover and their callers use. Identity is checked by the compiler: `same` takes two values of one type, and every
//! function item has a type of its own, so two different functions under one name would not compile.
use std::marker::PhantomData;

use privacy_core::Fr;

fn same<T>(_: T, _: T) {}
fn same_type<T>(_: PhantomData<T>, _: PhantomData<T>) {}

#[test]
fn crypto_paths() {
    same(privacy_core::poseidon2::hash, privacy_core::crypto::poseidon2::hash);
    same(privacy_core::poseidon2::hash2, privacy_core::crypto::poseidon2::hash2);
    same(privacy_core::poseidon2::permute, privacy_core::crypto::poseidon2::permute);
    same(privacy_core::field::fr_from_be_mod, privacy_core::crypto::field::fr_from_be_mod);
    same(privacy_core::field::fr_to_be32, privacy_core::crypto::field::fr_to_be32);
    same(privacy_core::domains::domain_tag, privacy_core::crypto::domains::domain_tag);
    same(privacy_core::domains::keccak256, privacy_core::crypto::domains::keccak256);
    same_type(PhantomData::<privacy_core::field::Fr>, PhantomData::<privacy_core::crypto::field::Fr>);
    same_type(PhantomData::<privacy_core::Fr>, PhantomData::<privacy_core::crypto::field::Fr>);
    assert_eq!(privacy_core::poseidon2_constants::RC.len(), privacy_core::crypto::poseidon2_constants::RC.len());
}

#[test]
fn notes_commitments_nullifiers_paths() {
    same(privacy_core::note::note_body, privacy_core::commitments::note_body);
    same(privacy_core::note::note_commitment, privacy_core::commitments::note_commitment);
    same(privacy_core::note::owner_commitment_of, privacy_core::commitments::owner_commitment_of);
    same(privacy_core::note::nullifier, privacy_core::nullifiers::nullifier);
    same(privacy_core::note::phantom_nullifier, privacy_core::nullifiers::phantom_nullifier);
    same(privacy_core::note::encode_note, privacy_core::notes::encode_note);
    same(privacy_core::note::decode_note, privacy_core::notes::note::decode_note);
    same(privacy_core::note::scan_payloads::<std::iter::Empty<(u32, Fr, &[u8])>>, privacy_core::notes::scan_payloads::<std::iter::Empty<(u32, Fr, &[u8])>>);
    same(privacy_core::note::open_payloads::<std::iter::Empty<(u32, Fr, &[u8])>>, privacy_core::notes::open_payloads::<std::iter::Empty<(u32, Fr, &[u8])>>);
    same_type(PhantomData::<privacy_core::note::Opened>, PhantomData::<privacy_core::notes::Opened>);
    same_type(PhantomData::<privacy_core::note::Note>, PhantomData::<privacy_core::notes::Note>);
    assert_eq!(privacy_core::note::NOTE_RECORD_BYTES, privacy_core::notes::NOTE_RECORD_BYTES);

    // and the grouped names compute what the flat ones do: a note's commitment and nullifier
    let spend_key = Fr::from(7u64);
    let note = privacy_core::notes::Note { vault_id: Fr::from(1u64), amount: Fr::from(10u64), owner_commitment: privacy_core::commitments::owner_commitment_of(&spend_key), note_secret: Fr::from(3u64) };
    let c = privacy_core::commitments::note_commitment(&privacy_core::commitments::note_body(&note), 4);
    assert_eq!(c, privacy_core::note::note_commitment(&privacy_core::note::note_body(&note), 4));
    assert_eq!(privacy_core::nullifiers::nullifier(&c, &spend_key), privacy_core::note::nullifier(&c, &spend_key));
}

#[test]
fn merkle_encoding_proof_paths() {
    same(privacy_core::merkle::layers, privacy_core::merkle::layers);
    same_type(PhantomData::<privacy_core::merkle::MerkleTree>, PhantomData::<privacy_core::merkle::MerkleTree>);
    same(privacy_core::payload::tx_domain, privacy_core::encoding::payload::tx_domain);
    same(privacy_core::payload::tx_domain, privacy_core::proof::tx_domain);
    same(privacy_core::payload::note_data_hash, privacy_core::proof::note_data_hash);
    same(privacy_core::payload::protocol_id, privacy_core::proof::protocol_id);
    same(privacy_core::payload::circuit_id, privacy_core::proof::circuit_id);
    assert_eq!(privacy_core::payload::NOTE_DATA_BYTES, privacy_core::proof::NOTE_DATA_BYTES);
    same(privacy_core::envelope::view_key_pair, privacy_core::encoding::envelope::view_key_pair);
    same(privacy_core::envelope::decrypt_note_data, privacy_core::encoding::envelope::decrypt_note_data);
    same(privacy_core::address::encode_privacy_address, privacy_core::encoding::address::encode_privacy_address);
    same(privacy_core::address::decode_privacy_address, privacy_core::encoding::address::decode_privacy_address);
}

#[test]
fn wallet_paths() {
    same(privacy_core::keys::derive_keys, privacy_core::wallet::keys::derive_keys);
    same(privacy_core::keys::derive_note_secret, privacy_core::wallet::keys::derive_note_secret);
    same(privacy_core::keys::derive_owner_key, privacy_core::wallet::keys::derive_owner_key);
    same(privacy_core::keystore::create_keystore, privacy_core::wallet::keystore::create_keystore);
    same(privacy_core::keystore::unlock_keystore, privacy_core::wallet::keystore::unlock_keystore);
    same(privacy_core::bip39::seed_to_phrase, privacy_core::wallet::bip39::seed_to_phrase);
    same(privacy_core::bip39::phrase_to_seed, privacy_core::wallet::bip39::phrase_to_seed);
    same(privacy_core::chainkeys::account_for, privacy_core::wallet::chainkeys::account_for);
    same_type(PhantomData::<privacy_core::chainkeys::ChainKind>, PhantomData::<privacy_core::wallet::chainkeys::ChainKind>);
    assert_eq!(privacy_core::bip39_wordlist::WORDLIST.len(), privacy_core::wallet::bip39_wordlist::WORDLIST.len());
}
