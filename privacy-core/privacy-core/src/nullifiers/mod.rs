//! Nullifiers (doc §60 `nullifiers/`): a spent note's nullifier, and the phantom nullifier of a transaction's unused
//! input slot.
pub use crate::notes::note::{nullifier, phantom_nullifier};
