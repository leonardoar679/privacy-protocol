//! Native Groth16 prover for the Transaction circuit (plan V1.1 §40 "native proving", the follow-up
//! named in docs/mobile.md): the same proving key snarkjs uses (`circuits/build/setup/*.zkey`), the
//! same witness layout (`.wtns`, or any witness vector), arkworks' Groth16 with the snarkjs QAP
//! reduction, and a proof exported exactly as `PrivacyCore.transact` consumes it — so a proof made
//! here verifies on the deployed verifier, and a snarkjs proof verifies here.
//!
//! No randomness is drawn inside: the two blinding scalars come from the caller (its CSPRNG), like
//! every other secret input of the core. Witness generation (running the circuit) is the next step;
//! today the witness comes from snarkjs' calculator (the web wallet's worker, or the node script).
pub mod export;
pub mod prove;
pub mod qap;
pub mod wtns;
pub mod zkey;

pub use export::{calldata_bytes, from_snarkjs, to_calldata, to_snarkjs, Calldata, ImportError, ProofJson};
pub use prove::{fr_from_bytes, prove, public_inputs, verify, ProveError};
pub use wtns::{read_wtns, WtnsError};
pub use zkey::{read_zkey, Zkey, ZkeyError};
