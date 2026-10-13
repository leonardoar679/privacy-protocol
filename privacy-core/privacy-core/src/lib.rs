//! Privacy Protocol crypto core (plan V1.1 §40, §43–§45, §69): the one implementation of the protocol's
//! client-side cryptography for the native mobile / desktop wallets and the WASM build — Poseidon2
//! (BN254, Noir sponge), domains, wallet keys, notes and nullifiers, the 4-aligned Merkle accumulator,
//! payload binding and tx domain, the output-payload envelope, the bech32m privacy address, the
//! encrypted keystore / journal formats, BIP-39 and the Chain Key Abstraction (EVM / Bitcoin / Solana).
//!
//! It must agree bit for bit with the circuit, the contracts and the TypeScript reference; the
//! shared vectors (`circuits/vectors/primitives.json`, `packages/protocol/test/vectors/*.json`,
//! `circuits/test/fixtures/v1/*.json`) are the test suite. Proof generation lives next to it: snarkjs
//! (WASM) in the browser, `privacy-core/privacy-prover` (native Groth16 over the same proving key) elsewhere.
//!
//! No randomness is drawn here: every function that needs it (ephemeral keys, nonces, salts, dummies)
//! takes the bytes from the caller, so each platform uses its own CSPRNG / secure enclave.
//!
//! The modules are grouped as doc §60 lists (V6 Stage 4): `crypto`, `notes`, `commitments`, `nullifiers`, `merkle`,
//! `encoding`, `proof`, `wallet`. Every path of the flat layout (`privacy_core::note::…`, `::payload::…`, `::keystore::…`)
//! stays, re-exported below, so the WASM package, the FFI, the prover and their callers are unchanged
//! (`tests/api_paths.rs`).
pub mod commitments;
pub mod crypto;
pub mod encoding;
pub mod merkle;
pub mod notes;
pub mod nullifiers;
pub mod proof;
pub mod wallet;

pub use crypto::{domains, field, poseidon2, poseidon2_constants};
pub use encoding::{address, envelope, payload};
pub use notes::note;
pub use wallet::{bip39, bip39_wordlist, chainkeys, keys, keystore};

pub use field::Fr;
