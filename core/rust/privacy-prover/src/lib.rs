//! Native Groth16 prover for the Transaction circuit (plan V1.1 §40 "native proving"; docs/mobile.md):
//! the same proving key snarkjs uses (`circuits/build/setup/*.zkey`), the same witness layout
//! (`.wtns`, or any witness vector), arkworks' Groth16 with the snarkjs QAP reduction, and a proof
//! exported exactly as `PrivacyCore.transact` consumes it — so a proof made here verifies on the
//! deployed verifier, and a snarkjs proof verifies here.
//!
//! No randomness is drawn inside: the two blinding scalars come from the caller (its CSPRNG), like
//! every other secret input of the core. The witness is computed natively too (`witness`: the circuit's
//! own WASM run by a pure-Rust interpreter), so a native wallet goes from circuit inputs to a proof
//! without snarkjs; snarkjs' `.wtns` files are read as well.
pub mod export;
pub mod prove;
pub mod qap;
pub mod witness;
pub mod wtns;
pub mod zkey;

pub use export::{calldata_bytes, from_calldata_bytes, from_snarkjs, to_calldata, to_snarkjs, Calldata, ImportError, ProofJson};
pub use prove::{fr_from_bytes, prove, public_inputs, verify, ProveError};
pub use witness::{fnv, fr_from_json, inputs_from_json, WitnessCalculator, WitnessError};
pub use wtns::{read_wtns, WtnsError};
pub use zkey::{read_zkey, Zkey, ZkeyError};
