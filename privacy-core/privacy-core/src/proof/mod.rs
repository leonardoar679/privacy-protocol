//! The statement a proof binds (doc §60 `proof/`): the protocol and circuit ids, the transaction's domain (chain and
//! core), the hash of every output payload. Proving itself lives beside the core — snarkjs (WASM) in the browser,
//! `privacy-core/privacy-prover` (native Groth16 over the same proving key) elsewhere.
pub use crate::encoding::payload::{circuit_id, note_data_hash, protocol_id, tx_domain, PayloadError, NOTE_DATA_BYTES};
