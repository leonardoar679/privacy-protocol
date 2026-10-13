//! Commitments (doc §60 `commitments/`): the owner commitment of a spending key, a note's body, and its commitment at
//! a leaf — the values the Merkle accumulator holds and the circuit opens.
pub use crate::notes::note::{note_body, note_commitment, owner_commitment_of};
