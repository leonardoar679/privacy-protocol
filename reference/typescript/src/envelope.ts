// Output payload envelope (spec §12, pinned layout) and the binding of the view key to it — the
// roadmap's "payload encryption scheme" decision, implemented here as the reference and marked a
// PROPOSAL in docs/crypto-spec.md (the core never parses payloads, so this can change under a new
// version byte without touching contracts or circuits).
//
//   viewKey (field element, spec §4)  →  X25519 secret = clamp(sha256("privacy-protocol/v1/view-x25519" ‖ be32(viewKey)))
//   privacy address                   =  (ownerCommitment, viewPub)   (address.ts encodes it as bech32m "pp1…")
//   envelope                          =  0x01 ‖ ephPub(32) ‖ nonce(24) ‖ XChaCha20-Poly1305(key, nonce, aad)(amount ‖ noteSecret ‖ vaultId)(96 + 16)
//   key                               =  sha256("privacy-protocol/v1/envelope-key" ‖ x25519(eph, viewPub) ‖ ephPub ‖ viewPub)
//   aad                               =  0x01 ‖ ephPub
//
// Authenticity of a discovered note does NOT rest on the AEAD alone: the wallet recomputes the note
// commitment from the decrypted (amount, noteSecret, vaultId) and its own ownerCommitment and checks
// it against the leaf (noteFromPayload). Dummy outputs are 169 bytes indistinguishable from a real
// envelope (same version byte, random "ephemeral key", nonce and ciphertext).
import { x25519 } from "@noble/curves/ed25519";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { sha256 } from "@noble/hashes/sha256";
import { concatBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils";
import { NOTE_DATA_BYTES, packPlaintext } from "./payload";
import { noteBody, noteCommitment, type Note } from "./note";

export const ENVELOPE_VERSION = 0x01;
export const VIEW_X25519_TAG = utf8ToBytes("privacy-protocol/v1/view-x25519");
export const ENVELOPE_KEY_TAG = utf8ToBytes("privacy-protocol/v1/envelope-key");
const EPH_OFF = 1, NONCE_OFF = 33, CT_OFF = 57, CT_LEN = 96 + 16;

export interface ViewKeyPair { secret: Uint8Array; publicKey: Uint8Array }
export interface NotePlaintext { amount: bigint; noteSecret: bigint; vaultId: bigint }

const be32 = (v: bigint): Uint8Array => { const b = new Uint8Array(32); let x = v; for (let i = 31; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };
const fromBe = (b: Uint8Array): bigint => b.reduce((acc, x) => (acc << 8n) | BigInt(x), 0n);
const clamp = (k: Uint8Array): Uint8Array => { const c = k.slice(); c[0] &= 248; c[31] &= 127; c[31] |= 64; return c; };

/** The X25519 key pair a wallet derives from its view key; `publicKey` is the second half of its privacy address. */
export function viewKeyPair(viewKey: bigint): ViewKeyPair {
  const secret = clamp(sha256(concatBytes(VIEW_X25519_TAG, be32(viewKey))));
  return { secret, publicKey: x25519.getPublicKey(secret) };
}

function envelopeKey(ephSecret: Uint8Array, ephPub: Uint8Array, viewPub: Uint8Array): Uint8Array {
  return sha256(concatBytes(ENVELOPE_KEY_TAG, x25519.getSharedSecret(ephSecret, viewPub), ephPub, viewPub));
}

/** Encrypt a note's opening to the recipient's view public key. `opts` pin the ephemeral secret and nonce for test vectors only. */
export function encryptNoteData(recipientViewPub: Uint8Array, plain: NotePlaintext, opts: { ephemeralSecret?: Uint8Array; nonce?: Uint8Array } = {}): Uint8Array {
  if (recipientViewPub.length !== 32) throw new Error("view public key must be 32 bytes");
  const ephSecret = clamp(opts.ephemeralSecret ?? randomBytes(32));
  const ephPub = x25519.getPublicKey(ephSecret);
  const nonce = opts.nonce ?? randomBytes(24);
  if (nonce.length !== 24) throw new Error("nonce must be 24 bytes");
  const out = new Uint8Array(NOTE_DATA_BYTES);
  out[0] = ENVELOPE_VERSION;
  out.set(ephPub, EPH_OFF);
  out.set(nonce, NONCE_OFF);
  const aad = out.subarray(0, NONCE_OFF); // version ‖ ephPub
  const ct = xchacha20poly1305(envelopeKey(ephSecret, ephPub, recipientViewPub), nonce, aad).encrypt(packPlaintext(plain.amount, plain.noteSecret, plain.vaultId));
  if (ct.length !== CT_LEN) throw new Error("unexpected ciphertext length");
  out.set(ct, CT_OFF);
  return out;
}

/** Try to open a payload with this view key: the plaintext, or null (wrong recipient, tampered, other version). */
export function decryptNoteData(view: ViewKeyPair, noteData: Uint8Array): NotePlaintext | null {
  if (noteData.length !== NOTE_DATA_BYTES || noteData[0] !== ENVELOPE_VERSION) return null;
  const ephPub = noteData.subarray(EPH_OFF, NONCE_OFF);
  const nonce = noteData.subarray(NONCE_OFF, CT_OFF);
  try {
    const key = sha256(concatBytes(ENVELOPE_KEY_TAG, x25519.getSharedSecret(view.secret, ephPub), ephPub, view.publicKey));
    const pt = xchacha20poly1305(key, nonce, noteData.subarray(0, NONCE_OFF)).decrypt(noteData.subarray(CT_OFF));
    return { amount: fromBe(pt.subarray(0, 32)), noteSecret: fromBe(pt.subarray(32, 64)), vaultId: fromBe(pt.subarray(64, 96)) };
  } catch {
    return null; // authentication failed (not ours) or a low-order ephemeral key
  }
}

/** A dummy output's payload (spec §5.5, §12): same shape as a real envelope, nothing inside it. */
export function dummyNoteData(): Uint8Array {
  const out = randomBytes(NOTE_DATA_BYTES);
  out[0] = ENVELOPE_VERSION;
  return out;
}

/**
 * Note discovery: given a leaf's commitment and payload, the note it opens for this wallet — or
 * null. The decrypted opening must reproduce the leaf's commitment with OUR owner commitment, so a
 * payload that decrypts but does not open the leaf (malicious or someone else's) is rejected.
 */
export function noteFromPayload(view: ViewKeyPair, ownerCommitment: bigint, leafIndex: number, leaf: bigint, noteData: Uint8Array): Note | null {
  const pt = decryptNoteData(view, noteData);
  if (!pt) return null;
  const note: Note = { vaultId: pt.vaultId, amount: pt.amount, ownerCommitment, noteSecret: pt.noteSecret };
  return noteCommitment(noteBody(note), BigInt(leafIndex)) === leaf ? note : null;
}
