//! The inputs both cores refuse or read alike (the eleventh review round, 2026-11-04;
//! packages/protocol/test/vectors/inputs.json, read by the TypeScript reference's test/inputs.test.ts too): G11-7 — a seed that is no
//! seed derives no key (the TypeScript core refused it, this one derived its keys); G11-8 — a pasted privacy address is trimmed as
//! JavaScript trims (the byte-order mark included, U+0085 not) and holds printable ASCII only.
use privacy_core::address::{decode_privacy_address, AddressError};
use privacy_core::keys::{derive_keys, KeyError};
use serde_json::Value;
use std::path::PathBuf;

fn json(rel: &str) -> Value {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..").join(rel);
    serde_json::from_str(&std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{rel}: {e}"))).unwrap()
}

#[test]
fn a_seed_that_is_no_seed_derives_no_key() {
    let v = json("packages/protocol/test/vectors/inputs.json");
    for s in v["refusedSeeds"].as_array().unwrap() {
        let seed = hex::decode(s["hex"].as_str().unwrap()).unwrap();
        assert_eq!(derive_keys(&seed), Err(KeyError::SeedUnavailable), "{}", s["name"]);
    }
    assert!(derive_keys(b"privacy-protocol/example-master-seed").is_ok(), "a live seed derives its keys");
}

#[test]
fn a_pasted_address_reads_as_the_web_wallet_reads_it() {
    let v = json("packages/protocol/test/vectors/inputs.json");
    let mut accepted = Vec::new();
    for c in v["addresses"].as_array().unwrap() {
        let input = c["input"].as_str().unwrap();
        let got = decode_privacy_address(input);
        assert_eq!(got.is_ok(), c["accept"].as_bool().unwrap(), "{}: {:?}", c["name"], got.as_ref().err());
        // a character outside printable ASCII left after the trim is that, as the TypeScript decoder says it — never another error
        if let Err(e) = &got {
            if !input.trim_matches(|ch: char| ch.is_ascii_whitespace()).is_ascii() {
                assert_eq!(e, &AddressError::InvalidCharacter, "{}", c["name"]);
            }
        }
        if let Ok(a) = got {
            accepted.push(a.owner_commitment);
        }
    }
    accepted.dedup();
    assert_eq!(accepted.len(), 1, "every accepted form is the same address");
}
