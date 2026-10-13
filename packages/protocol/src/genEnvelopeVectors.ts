// Deterministic vectors for the output payload envelope and the privacy address (spec §12 +
// envelope.ts / address.ts), for other implementations: fixed seeds, ephemeral secrets and nonces.
// Usage: npx tsx src/genEnvelopeVectors.ts  → test/vectors/envelope.json
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { encryptNoteData, viewKeyPair } from "./envelope";
import { encodePrivacyAddress } from "./address";
import { deriveKeys, deriveNoteSecret } from "./keys";
import { ownerCommitmentOf } from "./note";
import { noteDataHash } from "./payload";

const VAULT = BigInt("0x36ffA23fd38Ae93e2b01Aa5fA1570845aDA89469");
const inputs: [string, number, number, bigint, number][] = [
  ["privacy-protocol/example-master-seed", 0x11, 0x22, 6n * 10n ** 17n, 7],
  ["privacy-protocol/example-bob", 0x33, 0x44, 10n ** 18n, 0],
  ["privacy-protocol/example-relayer", 0x55, 0x66, 1n, 123456],
];
const cases = inputs.map(([seed, ephFill, nonceFill, amount, counter]) => {
  const k = deriveKeys(utf8ToBytes(seed));
  const view = viewKeyPair(k.viewKey);
  const ephemeralSecret = new Uint8Array(32).fill(ephFill);
  const nonce = new Uint8Array(24).fill(nonceFill);
  const plain = { amount, noteSecret: deriveNoteSecret(k.noteKey, counter), vaultId: VAULT };
  const nd = encryptNoteData(view.publicKey, plain, { ephemeralSecret, nonce });
  const oc = ownerCommitmentOf(k.spendKey);
  return {
    seed, viewKey: k.viewKey.toString(), viewPub: bytesToHex(view.publicKey), ephemeralSecret: bytesToHex(ephemeralSecret), nonce: bytesToHex(nonce),
    amount: amount.toString(), noteSecret: plain.noteSecret.toString(), vaultId: VAULT.toString(), noteData: bytesToHex(nd), noteDataHash: noteDataHash(nd).toString(),
    ownerCommitment: oc.toString(), address: encodePrivacyAddress(oc, view.publicKey),
  };
});
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "vectors", "envelope.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({
  schema: 1,
  layout: "0x01 | ephPub(32) | nonce(24) | XChaCha20-Poly1305(key, nonce, aad = 0x01|ephPub)(amount|noteSecret|vaultId, 96)(+16 tag)",
  viewSecret: "clamp(sha256('privacy-protocol/v1/view-x25519' | be32(viewKey)))",
  key: "sha256('privacy-protocol/v1/envelope-key' | x25519(eph, viewPub) | ephPub | viewPub)",
  address: "bech32m hrp 'pp': 0x01 | ownerCommitment(32) | viewPub(32)",
  cases,
}, null, 2) + "\n");
console.log(`${cases.length} envelope vectors → ${out}`);
