//! Domain separators (spec §3), byte-identical to DomainSeparators.sol, circuits/lib/domains.circom and
//! packages/protocol/src/domains.ts: `DOM(tag) = uint256(keccak256("privacy-protocol/v1/domain/<tag>")) mod p`.
//! The five Poseidon2 domains prefix a hash input; OUTPUT_BINDING and TX_DOMAIN are keccak prefixes.
use crate::field::{fr_from_be_mod, Fr};
use sha3::{Digest, Keccak256};
use std::sync::OnceLock;

pub fn keccak256(data: &[u8]) -> [u8; 32] {
    let mut h = Keccak256::new();
    h.update(data);
    h.finalize().into()
}

pub fn tag_string(tag: &str) -> String {
    format!("privacy-protocol/v1/domain/{tag}")
}

pub fn domain_tag(tag: &str) -> Fr {
    fr_from_be_mod(&keccak256(tag_string(tag).as_bytes()))
}

macro_rules! domain {
    ($name:ident, $tag:literal) => {
        pub fn $name() -> Fr {
            static CELL: OnceLock<Fr> = OnceLock::new();
            *CELL.get_or_init(|| domain_tag($tag))
        }
    };
}
domain!(note_body, "NOTE_BODY");
domain!(note_commitment, "NOTE_COMMITMENT");
domain!(owner_commitment, "OWNER_COMMITMENT");
domain!(nullifier, "NULLIFIER");
domain!(phantom_nullifier, "PHANTOM_NULLIFIER");

/// keccak prefix for the output-payload binding (spec §12): the tag string's bytes.
pub fn output_binding_tag() -> Vec<u8> {
    tag_string("OUTPUT_BINDING").into_bytes()
}

/// keccak256 of the TX_DOMAIN tag, first word of the txDomain preimage (spec §11).
pub fn tx_domain_tag() -> [u8; 32] {
    keccak256(tag_string("TX_DOMAIN").as_bytes())
}
