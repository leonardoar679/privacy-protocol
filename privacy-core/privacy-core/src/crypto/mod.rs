//! The primitives (doc §60 `crypto/`): the BN254 scalar field, Poseidon2 (the Noir sponge, its constants generated from
//! the TypeScript reference) and the domain tags every hash is separated by.
pub mod domains;
pub mod field;
pub mod poseidon2;
pub mod poseidon2_constants;
