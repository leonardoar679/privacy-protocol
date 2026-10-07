//! Privacy Protocol crypto core (plan V1.1 §40, §43–§45, §69): the one implementation of the protocol's
//! client-side cryptography for the native mobile / desktop wallets and the WASM build — Poseidon2
//! (BN254, Noir sponge), domains, wallet keys, notes and nullifiers, the 4-aligned Merkle accumulator,
//! payload binding and tx domain, the output-payload envelope, the bech32m privacy address, the
//! encrypted keystore / journal formats, BIP-39 and the Chain Key Abstraction (EVM / Bitcoin / Solana).
//!
//! It must agree bit for bit with the circuit, the contracts and the TypeScript reference; the
//! shared vectors (`circuits/vectors/primitives.json`, `reference/typescript/test/vectors/*.json`,
//! `circuits/test/fixtures/v1/*.json`) are the test suite. Proof generation lives next to it: snarkjs
//! (WASM) in the browser, `core/rust/privacy-prover` (native Groth16 over the same proving key) elsewhere.
//!
//! No randomness is drawn here: every function that needs it (ephemeral keys, nonces, salts, dummies)
//! takes the bytes from the caller, so each platform uses its own CSPRNG / secure enclave.
pub mod address;
pub mod bip39;
pub mod bip39_wordlist;
pub mod chainkeys;
pub mod domains;
pub mod envelope;
pub mod field;
pub mod keys;
pub mod keystore;
pub mod merkle;
pub mod note;
pub mod payload;
pub mod poseidon2;
pub mod poseidon2_constants;

pub use field::Fr;
