//! The Rust core against the SAME vectors the circuit, the contracts and the TypeScript reference are
//! pinned to: circuits/vectors/primitives.json (nargo Poseidon2 + every primitive), the envelope /
//! address vectors, and a real circuit fixture (depth-32 path, nullifiers, output bodies).
use ark_ff::Zero;
use privacy_core::address::{bech32m_decode, bech32m_encode, decode_privacy_address, encode_privacy_address, AddressError};
use privacy_core::domains;
use privacy_core::envelope::{decrypt_note_data, dummy_note_data, encrypt_note_data, view_key_pair, NotePlaintext};
use privacy_core::field::{fr_from_dec, fr_to_be32, fr_to_dec, Fr};
use privacy_core::keys::{derive_keys, derive_note_secret, derive_owner_key};
use privacy_core::merkle::{fold_path, layers, layers_root, merkle_proof, proof_from_layers, zero_hashes, zero_leaf, MerkleTree};
use privacy_core::note::{decode_note, encode_note, note_body, note_commitment, note_from_payload, nullifier, open_payloads, owner_commitment_of, phantom_nullifier, scan_payloads, Discovered, Note, Opened};
use privacy_core::payload::{note_data_hash, pack_plaintext, tx_domain, NOTE_DATA_BYTES};
use privacy_core::poseidon2::{hash, permute};
use serde_json::Value;
use std::path::PathBuf;

fn repo(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..").join(rel)
}
fn json(rel: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(repo(rel)).unwrap_or_else(|e| panic!("{rel}: {e}"))).unwrap()
}
fn dec(v: &Value) -> Fr {
    fr_from_dec(v.as_str().expect("decimal string"))
}
fn hexb(v: &Value) -> Vec<u8> {
    hex::decode(v.as_str().unwrap().trim_start_matches("0x")).unwrap()
}
const EXAMPLE_SEED: &[u8] = b"privacy-protocol/example-master-seed";

#[test]
fn poseidon2_matches_the_nargo_vectors() {
    let p = json("circuits/vectors/primitives.json");
    let v = &p["poseidon2"];
    let z = [Fr::zero(); 4];
    assert_eq!(fr_to_dec(&permute(&z)[0]), v["permute([0,0,0,0])[0]"].as_str().unwrap());
    let s = [Fr::from(1u64), Fr::from(2u64), Fr::from(3u64), Fr::from(4u64)];
    let out = permute(&s);
    assert_eq!(fr_to_dec(&out[0]), v["permute([1,2,3,4])[0]"].as_str().unwrap());
    assert_eq!(fr_to_dec(&out[3]), v["permute([1,2,3,4])[3]"].as_str().unwrap());
    let one = Fr::from(1u64);
    let two = Fr::from(2u64);
    let three = Fr::from(3u64);
    let four = Fr::from(4u64);
    let cases: [(&str, Vec<Fr>); 7] = [
        ("hash([0])", vec![Fr::zero()]),
        ("hash([1])", vec![one]),
        ("hash([0,0])", vec![Fr::zero(), Fr::zero()]),
        ("hash([1,2])", vec![one, two]),
        ("hash([0,0,0])", vec![Fr::zero(); 3]),
        ("hash([1,2,3])", vec![one, two, three]), // exactly fills the rate: no final permutation
        ("hash([1,2,3,4])", vec![one, two, three, four]),
    ];
    for (name, input) in cases {
        assert_eq!(fr_to_dec(&hash(&input)), v[name].as_str().unwrap(), "{name}");
    }
}

#[test]
fn domains_zero_leaf_and_tags_match() {
    let p = json("circuits/vectors/primitives.json");
    let d = &p["domains"];
    assert_eq!(domains::note_body(), dec(&d["NOTE_BODY"]));
    assert_eq!(domains::note_commitment(), dec(&d["NOTE_COMMITMENT"]));
    assert_eq!(domains::owner_commitment(), dec(&d["OWNER_COMMITMENT"]));
    assert_eq!(domains::nullifier(), dec(&d["NULLIFIER"]));
    assert_eq!(domains::phantom_nullifier(), dec(&d["PHANTOM_NULLIFIER"]));
    assert_eq!(String::from_utf8(domains::output_binding_tag()).unwrap(), d["OUTPUT_BINDING_TAG"].as_str().unwrap());
    assert_eq!(format!("0x{}", hex::encode(domains::tx_domain_tag())), d["TX_DOMAIN_TAG_KECCAK"].as_str().unwrap());
    assert_eq!(zero_leaf(), dec(&p["zeroLeaf"]));
}

#[test]
fn keys_note_nullifiers_and_record() {
    let p = json("circuits/vectors/primitives.json");
    let keys = derive_keys(EXAMPLE_SEED);
    assert_eq!(keys.spend_key, dec(&p["keys"]["spendKey"]));
    assert_eq!(keys.view_key, dec(&p["keys"]["viewKey"]));
    assert_eq!(keys.note_key, dec(&p["keys"]["noteKey"]));
    let s = &p["sampleNote"];
    let oc = owner_commitment_of(&keys.spend_key);
    assert_eq!(oc, dec(&s["ownerCommitment"]));
    let note = Note { vault_id: dec(&s["vaultId"]), amount: dec(&s["amount"]), owner_commitment: oc, note_secret: dec(&s["noteSecret"]) };
    assert_eq!(note.note_secret, derive_note_secret(&keys.note_key, 0), "sampleNote uses counter 0");
    let body = note_body(&note);
    assert_eq!(body, dec(&s["body"]));
    let leaf_index: u64 = s["leafIndex"].as_str().unwrap().parse().unwrap();
    let c = note_commitment(&body, leaf_index);
    assert_eq!(c, dec(&s["commitment"]));
    let nf = nullifier(&c, &keys.spend_key);
    assert_eq!(nf, dec(&s["nullifier"]));
    assert_eq!(phantom_nullifier(&nf, 1, &keys.spend_key), dec(&s["phantom"]));
    // the 121-byte wallet record round-trips
    let rec = encode_note(&note, leaf_index as u32).unwrap();
    assert_eq!(rec[0], 0x01);
    let (back, idx) = decode_note(&rec).unwrap();
    assert_eq!(back, note);
    assert_eq!(idx as u64, leaf_index);
    assert!(decode_note(&rec[1..]).is_err());
}

#[test]
fn merkle_tree_roots_match_the_contract_vectors() {
    let p = json("circuits/vectors/primitives.json");
    let t = &p["tree"];
    let levels = t["levels"].as_u64().unwrap() as usize;
    let mut tree = MerkleTree::new(levels);
    assert_eq!(tree.root, dec(&t["emptyRoot"]));
    assert_eq!(zero_hashes(levels)[levels], tree.root);
    let snap = tree.snapshot();
    assert_eq!(tree.insert_leaf(dec(&p["sampleNote"]["commitment"])), 0);
    assert_eq!(tree.root, dec(&t["rootAfterDeposit"]));
    let outs: Vec<Fr> = t["outputs"].as_array().unwrap().iter().map(dec).collect();
    assert_eq!(tree.insert_group(&[outs[0], outs[1], outs[2], zero_leaf()]), 4);
    assert_eq!(tree.root, dec(&t["rootAfterTx"]));
    assert_eq!(tree.leaves.len(), 8);
    // a proof for leaf 5 reproduces the root; snapshots roll back
    let proof = merkle_proof(&tree.leaves, 5, levels);
    assert_eq!(proof.root, tree.root);
    assert_eq!(fold_path(tree.leaves[5], &proof.path_elements, &proof.path_indices), tree.root);
    tree.restore(&snap);
    assert_eq!(tree.root, dec(&t["emptyRoot"]));
    assert_eq!(tree.leaves.len(), 0);
}

#[test]
fn payload_binding_and_tx_domain() {
    let p = json("circuits/vectors/primitives.json");
    let nd = hexb(&p["noteDataExample"]["hex"]);
    assert_eq!(nd.len(), NOTE_DATA_BYTES);
    assert_eq!(note_data_hash(&nd).unwrap(), dec(&p["noteDataExample"]["hash"]));
    assert!(note_data_hash(&nd[..168]).is_err());
    let ex = &p["txDomainExample"];
    let chain_id: u64 = ex["chainId"].as_str().unwrap().parse().unwrap();
    let core: u64 = ex["core"].as_str().unwrap().parse().unwrap();
    let mut addr = [0u8; 20];
    addr[12..].copy_from_slice(&core.to_be_bytes());
    assert_eq!(tx_domain(chain_id, &addr), dec(&ex["txDomain"]));
}

#[test]
fn envelope_and_address_vectors() {
    let v = json("packages/protocol/test/vectors/envelope.json");
    for case in v["cases"].as_array().unwrap() {
        let keys = derive_keys(case["seed"].as_str().unwrap().as_bytes());
        assert_eq!(keys.view_key, dec(&case["viewKey"]));
        let view = view_key_pair(&keys.view_key);
        assert_eq!(hex::encode(view.public), case["viewPub"].as_str().unwrap());
        let mut eph = [0u8; 32];
        eph.copy_from_slice(&hexb(&case["ephemeralSecret"]));
        let mut nonce = [0u8; 24];
        nonce.copy_from_slice(&hexb(&case["nonce"]));
        let plain = NotePlaintext { amount: dec(&case["amount"]), note_secret: dec(&case["noteSecret"]), vault_id: dec(&case["vaultId"]) };
        let note_data = encrypt_note_data(&view.public, &plain, eph, nonce);
        assert_eq!(hex::encode(note_data), case["noteData"].as_str().unwrap(), "pinned envelope bytes");
        assert_eq!(note_data_hash(&note_data).unwrap(), dec(&case["noteDataHash"]));
        assert_eq!(decrypt_note_data(&view, &note_data), Some(plain));
        // tampering anywhere is rejected; another wallet opens nothing
        for i in [0usize, 1, 33, 57, 168] {
            let mut t = note_data;
            t[i] ^= 1;
            assert_eq!(decrypt_note_data(&view, &t), None, "byte {i}");
        }
        let other = view_key_pair(&derive_keys(b"someone else").view_key);
        assert_eq!(decrypt_note_data(&other, &note_data), None);
        // note discovery: the opening must reproduce the leaf with OUR owner commitment
        let oc = owner_commitment_of(&keys.spend_key);
        assert_eq!(oc, dec(&case["ownerCommitment"]));
        let note = Note { vault_id: plain.vault_id, amount: plain.amount, owner_commitment: oc, note_secret: plain.note_secret };
        let leaf = note_commitment(&note_body(&note), 7);
        assert_eq!(note_from_payload(&view, &oc, 7, &leaf, &note_data), Some(note));
        assert_eq!(note_from_payload(&view, &oc, 8, &leaf, &note_data), None);
        assert_eq!(note_from_payload(&view, &Fr::from(1u64), 7, &leaf, &note_data), None);
        // the privacy address
        let addr = encode_privacy_address(&oc, &view.public);
        assert_eq!(addr, case["address"].as_str().unwrap());
        assert_eq!(addr.len(), 113);
        let back = decode_privacy_address(&addr).unwrap();
        assert_eq!(back.owner_commitment, oc);
        assert_eq!(back.view_pub, view.public);
        assert_eq!(decode_privacy_address(&addr.to_uppercase()).unwrap(), back);
        let mut typo = addr.clone().into_bytes();
        typo[40] = if typo[40] == b'q' { b'p' } else { b'q' };
        assert_eq!(decode_privacy_address(std::str::from_utf8(&typo).unwrap()), Err(AddressError::BadChecksum));
    }
    // dummies: same shape, open for nobody
    let keys = derive_keys(EXAMPLE_SEED);
    let view = view_key_pair(&keys.view_key);
    let mut rnd = [0u8; NOTE_DATA_BYTES];
    for (i, b) in rnd.iter_mut().enumerate() {
        *b = (i * 7 + 3) as u8;
    }
    let dummy = dummy_note_data(rnd);
    assert_eq!(dummy[0], 0x01);
    assert_eq!(decrypt_note_data(&view, &dummy), None);
    assert_eq!(pack_plaintext(&Fr::from(1u64), &Fr::from(2u64), &Fr::from(3u64))[31], 1);
}

#[test]
fn bech32m_reference_vector() {
    assert_eq!(bech32m_encode("a", &[]), "a1lqfn3a"); // BIP-350
    assert_eq!(bech32m_decode("A1LQFN3A").unwrap(), ("a".to_string(), vec![]));
    assert_eq!(bech32m_decode("a1lqfn3A").unwrap_err(), AddressError::MixedCase);
    assert_eq!(bech32m_decode("a1lqfn3q").unwrap_err(), AddressError::BadChecksum);
    assert_eq!(bech32m_decode("a1lqfn3b").unwrap_err(), AddressError::InvalidCharacter); // b is not in the charset
    assert!(matches!(decode_privacy_address("a1lqfn3a"), Err(AddressError::WrongHrp(_))));
}

#[test]
fn circuit_fixture_depth_32_path_nullifiers_and_bodies() {
    let f = json("circuits/test/fixtures/v1/ok-transfer.json");
    let spend = dec(&f["inOwnerKey"][0]);
    let note = Note { vault_id: dec(&f["inVaultId"][0]), amount: dec(&f["inAmount"][0]), owner_commitment: owner_commitment_of(&spend), note_secret: dec(&f["inNoteSecret"][0]) };
    let leaf_index: u64 = f["inLeafIndex"][0].as_str().unwrap().parse().unwrap();
    let leaf = note_commitment(&note_body(&note), leaf_index);
    let path: Vec<Fr> = f["inPathElements"][0].as_array().unwrap().iter().map(dec).collect();
    let bits: Vec<u8> = f["inPathIndices"][0].as_array().unwrap().iter().map(|b| b.as_str().unwrap().parse().unwrap()).collect();
    assert_eq!(path.len(), 32);
    assert_eq!(fold_path(leaf, &path, &bits), dec(&f["root"]), "the real input opens the fixture root");
    let nf0 = nullifier(&leaf, &spend);
    assert_eq!(nf0, dec(&f["nullifier"][0]));
    assert_eq!(phantom_nullifier(&nf0, 1, &spend), dec(&f["nullifier"][1]));
    for i in 0..3 {
        let out = Note { vault_id: dec(&f["outVaultId"][i]), amount: dec(&f["outAmount"][i]), owner_commitment: dec(&f["outOwnerCommitment"][i]), note_secret: dec(&f["outNoteSecret"][i]) };
        assert_eq!(note_body(&out), dec(&f["outputBody"][i]), "output body {i}");
    }
    // value conservation of this transfer fixture, as the circuit enforces it
    let ins: Fr = (0..2).map(|i| dec(&f["inAmount"][i])).sum();
    let outs: Fr = (0..3).map(|i| dec(&f["outAmount"][i])).sum();
    assert_eq!(ins, outs);
    assert_eq!(fr_to_be32(&Fr::from(1u64))[31], 1);
}

#[test]
fn layers_give_the_incremental_root_and_every_path_in_one_pass() {
    let levels = 10;
    for n in [0usize, 1, 2, 3, 4, 5, 8, 13, 16, 100] {
        let leaves: Vec<Fr> = (0..n).map(|i| Fr::from(1000 + i as u64)).collect();
        let l = layers(&leaves, levels);
        assert_eq!(l.len(), levels + 1);
        assert_eq!(l[0], leaves);
        let root = layers_root(&l, levels);
        if n == 0 {
            assert_eq!(root, zero_hashes(levels)[levels]);
            assert!(l[levels].is_empty());
            continue;
        }
        assert_eq!(l[levels].len(), 1, "the top layer is the root");
        if n % 4 == 0 {
            let mut tree = MerkleTree::new(levels);
            for g in leaves.chunks(4) {
                tree.insert_group(&[g[0], g[1], g[2], g[3]]);
            }
            assert_eq!(root, tree.root, "n = {n}: the layered root is the accumulator's");
        }
        for i in 0..n {
            let p = proof_from_layers(&l, i, levels);
            assert_eq!(p.root, root);
            assert_eq!(p.path_elements.len(), levels);
            assert_eq!(fold_path(leaves[i], &p.path_elements, &p.path_indices), root, "n = {n}, leaf {i}");
            assert_eq!(p, merkle_proof(&leaves, i, levels));
        }
    }
}

#[test]
fn scan_payloads_finds_exactly_the_notes_that_open_their_leaf_for_us() {
    let ours = derive_keys(EXAMPLE_SEED);
    let other = derive_keys(b"someone else entirely");
    let view = view_key_pair(&ours.view_key);
    let oc = owner_commitment_of(&ours.spend_key);
    let eph = [0x11u8; 32];
    let nonce = [0x22u8; 24];
    let mine = Note { vault_id: Fr::from(171u64), amount: Fr::from(5u64), owner_commitment: oc, note_secret: derive_note_secret(&ours.note_key, 3) };
    let plain = |n: &Note| NotePlaintext { amount: n.amount, note_secret: n.note_secret, vault_id: n.vault_id };
    // leaf 4: ours. leaf 5: someone else's (their view key). leaf 6: decrypts for us but the leaf holds another
    // commitment (a payload that lies). leaf 7: a dummy. leaf 8: ours again at a different index.
    let p4 = encrypt_note_data(&view.public, &plain(&mine), eph, nonce);
    let p5 = encrypt_note_data(&view_key_pair(&other.view_key).public, &plain(&mine), eph, nonce);
    let p6 = encrypt_note_data(&view.public, &plain(&mine), [0x33u8; 32], nonce);
    let p7 = dummy_note_data([0x44u8; NOTE_DATA_BYTES]);
    let again = Note { amount: Fr::from(9u64), ..mine };
    let p8 = encrypt_note_data(&view.public, &plain(&again), [0x55u8; 32], nonce);
    let items: Vec<(u32, Fr, &[u8])> = vec![
        (4, note_commitment(&note_body(&mine), 4), &p4[..]),
        (5, note_commitment(&note_body(&Note { owner_commitment: owner_commitment_of(&other.spend_key), ..mine }), 5), &p5[..]),
        (6, Fr::from(123456u64), &p6[..]),
        (7, Fr::from(7u64), &p7[..]),
        (8, note_commitment(&note_body(&again), 8), &p8[..]),
    ];
    let found = scan_payloads(&view, &oc, items.iter().cloned());
    assert_eq!(found, vec![Discovered { leaf_index: 4, note: mine }, Discovered { leaf_index: 8, note: again }]);
    assert!(scan_payloads(&view_key_pair(&other.view_key), &owner_commitment_of(&other.spend_key), items.iter().cloned()).iter().all(|d| d.leaf_index == 5));
    assert!(scan_payloads(&view, &oc, std::iter::empty()).is_empty());
}

#[test]
fn open_payloads_opens_every_payload_for_our_view_key_and_says_which_reproduce() {
    // the audit round of 2026-10-16 (c18): a deposited note is made out to its own owner commitment, derived from its secret
    let ours = derive_keys(EXAMPLE_SEED);
    let other = derive_keys(b"someone else entirely");
    let view = view_key_pair(&ours.view_key);
    let oc = owner_commitment_of(&ours.spend_key);
    let nonce = [0x22u8; 24];
    let mine = Note { vault_id: Fr::from(171u64), amount: Fr::from(5u64), owner_commitment: oc, note_secret: derive_note_secret(&ours.note_key, 3) };
    let secret = derive_note_secret(&ours.note_key, 4);
    let deposited = Note { vault_id: Fr::from(171u64), amount: Fr::from(7u64), owner_commitment: owner_commitment_of(&derive_owner_key(&ours.spend_key, &secret)), note_secret: secret };
    let plain = |n: &Note| NotePlaintext { amount: n.amount, note_secret: n.note_secret, vault_id: n.vault_id };
    // leaf 4: ours, made out to the privacy address. 5: encrypted to someone else's view key. 6: opens for us, but the leaf
    // holds another commitment (a payload that lies). 7: a dummy. 8: a deposited note of ours.
    let p4 = encrypt_note_data(&view.public, &plain(&mine), [0x11u8; 32], nonce);
    let p5 = encrypt_note_data(&view_key_pair(&other.view_key).public, &plain(&mine), [0x11u8; 32], nonce);
    let p6 = encrypt_note_data(&view.public, &plain(&mine), [0x33u8; 32], nonce);
    let p7 = dummy_note_data([0x44u8; NOTE_DATA_BYTES]);
    let p8 = encrypt_note_data(&view.public, &plain(&deposited), [0x55u8; 32], nonce);
    let items: Vec<(u32, Fr, &[u8])> = vec![
        (4, note_commitment(&note_body(&mine), 4), &p4[..]),
        (5, note_commitment(&note_body(&mine), 5), &p5[..]),
        (6, Fr::from(123456u64), &p6[..]),
        (7, Fr::from(7u64), &p7[..]),
        (8, note_commitment(&note_body(&deposited), 8), &p8[..]),
    ];
    let opened = open_payloads(&view, &oc, items.iter().cloned());
    assert_eq!(
        opened,
        vec![
            Opened { leaf_index: 4, plain: plain(&mine), reproduces: true },
            Opened { leaf_index: 6, plain: plain(&mine), reproduces: false },
            Opened { leaf_index: 8, plain: plain(&deposited), reproduces: false },
        ]
    );
    // the ones that reproduce are exactly scan_payloads' hits
    let hits: Vec<u32> = scan_payloads(&view, &oc, items.iter().cloned()).iter().map(|d| d.leaf_index).collect();
    assert_eq!(hits, opened.iter().filter(|o| o.reproduces).map(|o| o.leaf_index).collect::<Vec<_>>());
    // the deposited note reproduces its leaf with the owner commitment derived from the opened secret
    let o = opened[2];
    let own = owner_commitment_of(&derive_owner_key(&ours.spend_key, &o.plain.note_secret));
    assert_eq!(note_commitment(&note_body(&Note { vault_id: o.plain.vault_id, amount: o.plain.amount, owner_commitment: own, note_secret: o.plain.note_secret }), 8), items[4].1);
    assert!(open_payloads(&view, &oc, std::iter::empty()).is_empty());
}
