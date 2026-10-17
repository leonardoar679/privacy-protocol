//! Notes (doc §60 `notes/`): the note, its 121-byte record, its discovery from the encrypted payloads of a block range.
//! The commitment and the nullifier of a note are named by `commitments` and `nullifiers`.
pub mod note;

pub use note::{decode_note, encode_note, note_from_payload, open_payloads, scan_payloads, Discovered, Note, NoteError, Opened, NOTE_RECORD_BYTES};
