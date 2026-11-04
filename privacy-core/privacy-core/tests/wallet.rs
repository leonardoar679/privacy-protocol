//! The wallet's at-rest formats and key derivations against the vectors the web wallet pinned
//! (packages/protocol/test/vectors/wallet.json, chainkeys.json): a backup made in the browser opens
//! here, the phrase gives the same seed, the same addresses come out on every chain.
use privacy_core::bip39::{entropy_to_mnemonic, mnemonic_to_entropy, mnemonic_to_seed, phrase_to_seed, seed_to_phrase, Bip39Error};
use privacy_core::chainkeys::{base58_encode, bitcoin_account, dapp_account, dapp_account_index, ed25519_public, evm_account, parse_hardened_path, slip10_ed25519, solana_account, ChainKeyError};
use privacy_core::field::{fr_from_dec, fr_to_be32, fr_to_dec};
use privacy_core::keys::{derive_keys, derive_note_secret, derive_owner_key, OWNER_KEY_LABEL};
use privacy_core::keystore::{create_keystore, decrypt_journal, encrypt_journal, journal_key, unlock_keystore, EncryptedJournal, KdfParams, Keystore, KeystoreError};
use privacy_core::note::{note_body, note_commitment, nullifier, owner_commitment_of, phantom_nullifier, Note};
use serde_json::Value;
use std::path::PathBuf;

fn json(rel: &str) -> Value {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..").join(rel);
    serde_json::from_str(&std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{rel}: {e}"))).unwrap()
}
fn hexb(v: &Value) -> Vec<u8> {
    hex::decode(v.as_str().unwrap().trim_start_matches("0x")).unwrap()
}
fn arr<const N: usize>(v: &Value) -> [u8; N] {
    let b = hexb(v);
    let mut out = [0u8; N];
    out.copy_from_slice(&b);
    out
}

#[test]
fn keystore_opens_the_web_wallets_backup_and_reproduces_it() {
    let w = json("packages/protocol/test/vectors/wallet.json");
    let k = &w["keystore"];
    let seed: [u8; 32] = arr(&k["seed"]);
    let password = k["password"].as_str().unwrap();
    let pinned: Keystore = serde_json::from_value(k["keystore"].clone()).unwrap();
    assert_eq!(unlock_keystore(&pinned, password).unwrap(), seed);
    assert_eq!(unlock_keystore(&pinned, "wrong password"), Err(KeystoreError::WrongPassword));
    let params = KdfParams { name: "scrypt".into(), n: k["kdf"]["N"].as_u64().unwrap() as u32, r: k["kdf"]["r"].as_u64().unwrap() as u32, p: k["kdf"]["p"].as_u64().unwrap() as u32, dk_len: 32 };
    let ours = create_keystore(&seed, password, &params, arr(&k["salt"]), arr(&k["nonce"])).unwrap();
    assert_eq!(ours, pinned, "byte-identical keystore JSON");
    assert_eq!(serde_json::to_value(&ours).unwrap(), k["keystore"]);
    // tampering and unsafe parameters are refused
    let mut t = pinned.clone();
    t.ct.replace_range(0..2, if pinned.ct.starts_with("00") { "01" } else { "00" });
    assert_eq!(unlock_keystore(&t, password), Err(KeystoreError::WrongPassword));
    let mut weak = pinned.clone();
    weak.kdf.n = 16;
    assert_eq!(unlock_keystore(&weak, password), Err(KeystoreError::UnsafeParams));
    // the phrase is the seed
    assert_eq!(seed_to_phrase(&seed), k["phrase"].as_str().unwrap());
    assert_eq!(phrase_to_seed(k["phrase"].as_str().unwrap()).unwrap(), seed);
    assert_eq!(phrase_to_seed(&k["phrase"].as_str().unwrap().to_uppercase()).unwrap(), seed);
}

/// The backup wallet.json pins, its password and its seed.
fn pinned_backup() -> (Keystore, String, [u8; 32]) {
    let w = json("packages/protocol/test/vectors/wallet.json");
    let k = &w["keystore"];
    (serde_json::from_value(k["keystore"].clone()).unwrap(), k["password"].as_str().unwrap().to_string(), arr(&k["seed"]))
}

#[test]
fn a_runaway_scrypt_cost_is_refused_before_scrypt_runs() {
    // audit round 2, n31. r = 33 first: without the bounds it runs at once and fails on the wrong key, before r = 1 with
    // p = 2^23 would run for hours
    let (pinned, password, _) = pinned_backup();
    for (n, r, p) in [(1 << 10, 33, 1), (1 << 20, 8, 2), (1 << 21, 8, 1), (1 << 10, 1, 1 << 23)] {
        let mut slow = pinned.clone();
        (slow.kdf.n, slow.kdf.r, slow.kdf.p) = (n, r, p);
        assert_eq!(unlock_keystore(&slow, &password), Err(KeystoreError::UnsafeParams), "N={n} r={r} p={p}");
    }
}

#[test]
fn a_malformed_field_is_a_format_error_never_a_panic() {
    // audit round 2, p01: a multi-byte character in a hex field, a journal nonce of another length
    let (pinned, password, _) = pinned_backup();
    let mut odd = pinned.clone();
    odd.salt = "a\u{e9}b".to_string();
    assert_eq!(unlock_keystore(&odd, &password), Err(KeystoreError::BadFormat));
    // the web wallet's shape (the seventh review round, 2026-11-03): a salt other than 16 bytes — an empty one too — or a ciphertext other
    // than the seed's 48 bytes is no keystore of this wallet's
    for salt in [String::new(), "00".repeat(15), "00".repeat(64)] {
        let mut s = pinned.clone();
        s.salt = salt.clone();
        assert_eq!(unlock_keystore(&s, &password), Err(KeystoreError::BadFormat), "salt of {} bytes", salt.len() / 2);
    }
    let mut short_ct = pinned.clone();
    short_ct.ct.truncate(short_ct.ct.len() - 2);
    assert_eq!(unlock_keystore(&short_ct, &password), Err(KeystoreError::BadFormat));
    let short = EncryptedJournal { v: 1, nonce: "00".to_string(), ct: "00".repeat(40) };
    assert_eq!(decrypt_journal(&[7u8; 32], &short), None, "a short nonce: unopenable, not a panic");
}

#[test]
fn a_phrase_is_split_on_the_whitespace_the_web_wallet_splits_on() {
    // audit round 2, n32: a byte-order mark is whitespace, U+0085 is not
    let (_, _, seed) = pinned_backup();
    let w = json("packages/protocol/test/vectors/wallet.json");
    let phrase = w["keystore"]["phrase"].as_str().unwrap();
    assert_eq!(phrase_to_seed(&format!("\u{feff}{phrase}")).unwrap(), seed);
    assert_eq!(phrase_to_seed(&phrase.replacen(' ', "\u{feff}", 1)).unwrap(), seed);
    assert!(phrase_to_seed(&phrase.replacen(' ', "\u{85}", 1)).is_err());
}

#[test]
fn owner_keys_match_the_web_wallets_vectors() {
    // the owner key a deposited note is made out to (the audit round of 2026-10-16, c18), byte for byte as the web wallet
    // derives it: a second implementation of the frozen derivation, run by verify-all --rust
    let v = json("packages/protocol/test/vectors/owner-keys.json");
    let dec = |x: &Value| x.as_str().unwrap().to_string();
    let keys = derive_keys(v["seed"].as_str().unwrap().as_bytes());
    assert_eq!(OWNER_KEY_LABEL, v["label"].as_str().unwrap());
    assert_eq!(fr_to_dec(&keys.spend_key), dec(&v["spendKey"]));
    assert_eq!(fr_to_dec(&keys.note_key), dec(&v["noteKey"]));
    assert_eq!(fr_to_dec(&owner_commitment_of(&keys.spend_key)), dec(&v["mainOwnerCommitment"]));
    for k in v["byCounter"].as_array().unwrap() {
        let secret = derive_note_secret(&keys.note_key, k["counter"].as_u64().unwrap());
        assert_eq!(fr_to_dec(&secret), dec(&k["noteSecret"]), "counter {}", k["counter"]);
        let key = derive_owner_key(&keys.spend_key, &secret);
        assert_eq!(fr_to_dec(&key), dec(&k["ownerKey"]), "counter {}", k["counter"]);
        assert_eq!(fr_to_dec(&owner_commitment_of(&key)), dec(&k["ownerCommitment"]), "counter {}", k["counter"]);
    }
    for k in v["edgeSecrets"].as_array().unwrap() {
        let key = derive_owner_key(&keys.spend_key, &fr_from_dec(k["noteSecret"].as_str().unwrap()));
        assert_eq!(fr_to_dec(&key), dec(&k["ownerKey"]), "secret {}", k["noteSecret"]);
        assert_eq!(fr_to_dec(&owner_commitment_of(&key)), dec(&k["ownerCommitment"]), "secret {}", k["noteSecret"]);
    }
    let s = &v["sampleSpend"];
    let secret = derive_note_secret(&keys.note_key, s["counter"].as_u64().unwrap());
    let mut pre = Vec::new();
    pre.extend_from_slice(&fr_to_be32(&keys.spend_key));
    pre.extend_from_slice(b"/owner-key/");
    pre.extend_from_slice(&fr_to_be32(&secret));
    assert_eq!(format!("0x{}", hex::encode(&pre)), v["preimageCounter1"].as_str().unwrap());
    let key = derive_owner_key(&keys.spend_key, &secret);
    let note = Note { vault_id: fr_from_dec(s["vaultId"].as_str().unwrap()), amount: fr_from_dec(s["amount"].as_str().unwrap()), owner_commitment: owner_commitment_of(&key), note_secret: secret };
    assert_eq!(fr_to_dec(&note_body(&note)), dec(&s["body"]));
    let cm = note_commitment(&note_body(&note), s["leafIndex"].as_u64().unwrap());
    assert_eq!(fr_to_dec(&cm), dec(&s["commitment"]));
    assert_eq!(fr_to_dec(&nullifier(&cm, &key)), dec(&s["nullifier"]));
    assert_eq!(fr_to_dec(&phantom_nullifier(&nullifier(&cm, &key), 1, &key)), dec(&s["phantom"]));
}

#[test]
fn journal_key_and_encryption_match_the_web_wallet() {
    let w = json("packages/protocol/test/vectors/wallet.json");
    let j = &w["journal"];
    let seed: [u8; 32] = arr(&j["seed"]);
    let key = journal_key(&seed);
    assert_eq!(hex::encode(key), j["key"].as_str().unwrap());
    let pinned: EncryptedJournal = serde_json::from_value(j["encrypted"].clone()).unwrap();
    assert_eq!(decrypt_journal(&key, &pinned).unwrap(), j["plaintext"].as_str().unwrap());
    assert_eq!(encrypt_journal(&key, j["plaintext"].as_str().unwrap(), arr(&j["nonce"])), pinned);
    assert_eq!(decrypt_journal(&journal_key(&[0u8; 32]), &pinned), None);
}

#[test]
fn bip39_vectors() {
    let w = json("packages/protocol/test/vectors/wallet.json");
    for case in w["bip39"].as_array().unwrap() {
        let entropy = hexb(&case["entropy"]);
        let mnemonic = case["mnemonic"].as_str().unwrap();
        assert_eq!(entropy_to_mnemonic(&entropy).unwrap(), mnemonic);
        assert_eq!(mnemonic_to_entropy(mnemonic).unwrap(), entropy);
        assert_eq!(hex::encode(mnemonic_to_seed(mnemonic, "")), case["seed"].as_str().unwrap());
        assert_eq!(hex::encode(mnemonic_to_seed(mnemonic, "TREZOR")), case["seedWithPassphrase"].as_str().unwrap());
    }
    assert_eq!(mnemonic_to_entropy("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon"), Err(Bip39Error::BadChecksum));
    assert_eq!(mnemonic_to_entropy("abandon abandon notaword"), Err(Bip39Error::BadWordCount(3)));
    assert_eq!(entropy_to_mnemonic(&[0u8; 17]), Err(Bip39Error::BadEntropyLength(17)));
}

#[test]
fn chain_keys_match_the_pinned_vectors() {
    let v = json("packages/protocol/test/vectors/chainkeys.json");
    for case in v["slip10_ed25519"].as_array().unwrap() {
        let seed = hexb(&case["seed"]);
        for c in case["chains"].as_array().unwrap() {
            let path = c["path"].as_str().unwrap();
            let idx = if path == "m" { vec![] } else { parse_hardened_path(path).unwrap() };
            let k = slip10_ed25519(&seed, &idx);
            assert_eq!(hex::encode(k.key), c["privateKey"].as_str().unwrap(), "{path}");
            assert_eq!(hex::encode(k.chain_code), c["chainCode"].as_str().unwrap(), "{path}");
            assert_eq!(format!("00{}", hex::encode(ed25519_public(&k.key))), c["publicKey"].as_str().unwrap(), "{path}");
        }
    }
    assert!(matches!(parse_hardened_path("m/44'/501'/0/0'"), Err(ChainKeyError::NotHardened(_))));
    let seed = mnemonic_to_seed(v["bip84"]["mnemonic"].as_str().unwrap(), "");
    let r0 = bitcoin_account(&seed, 0, 0, "bc").unwrap();
    assert_eq!(r0.path, v["bip84"]["receive0"]["path"].as_str().unwrap());
    assert_eq!(hex::encode(&r0.public_key), v["bip84"]["receive0"]["publicKey"].as_str().unwrap());
    assert_eq!(r0.address, v["bip84"]["receive0"]["address"].as_str().unwrap());
    let c0 = bitcoin_account(&seed, 0, 1, "bc").unwrap();
    assert_eq!(hex::encode(&c0.public_key), v["bip84"]["change0"]["publicKey"].as_str().unwrap());
    assert_eq!(c0.address, v["bip84"]["change0"]["address"].as_str().unwrap());
    let e0 = evm_account(&seed, 0).unwrap();
    assert_eq!(e0.address, v["bip44_evm"]["account0"]["address"].as_str().unwrap());
    let s0 = solana_account(&seed, 0).unwrap();
    assert_eq!(s0.path, v["solana"]["account0"]["path"].as_str().unwrap());
    assert_eq!(s0.address, v["solana"]["account0"]["address"].as_str().unwrap());
    assert_ne!(solana_account(&seed, 1).unwrap().address, s0.address);
    // dApp accounts: stable per origin, distinct, never account 0
    let a = dapp_account(&seed, "https://app.example").unwrap();
    assert_eq!(a.index, dapp_account_index("https://app.example"));
    assert_eq!(a.address, dapp_account(&seed, "https://APP.example").unwrap().address);
    assert_ne!(a.address, dapp_account(&seed, "https://other.example").unwrap().address);
    assert_ne!(a.address, e0.address);
    assert!(a.index < 0x8000_0000);
    // base58 reference values
    assert_eq!(base58_encode(&[0, 0, 1]), "112");
    assert_eq!(base58_encode(b"hello"), "Cn8eVZg");
}
