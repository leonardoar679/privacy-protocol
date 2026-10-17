// The owner keys of deposited notes (a V6 follow-up of 2026-10-16, audit c18/c29/c37): vectors every implementation must
// reproduce (keys.ts deriveOwnerKey, reference/python derive_owner_key, privacy-core keys.rs derive_owner_key).
// Usage: npx tsx src/genOwnerKeyVectors.ts → test/vectors/owner-keys.json. The derivation never changes — deposits, escrows
// and receivers fix it for good —, so the generator refuses to write a file that differs from the one there (--force does).
import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { FIELD } from "./field";
import { deriveKeys, deriveNoteSecret, deriveOwnerKey, OWNER_KEY_LABEL } from "./keys";
import { noteBody, noteCommitment, ownerCommitmentOf } from "./note";
import { nullifier, phantomNullifier } from "./nullifier";

const SEED = "privacy-protocol/example-master-seed";
const keys = deriveKeys(utf8ToBytes(SEED));
const COUNTERS = [0, 1, 7, 255, 1024, 4294967295, 4294967296];
const EDGE_SECRETS = [0n, 1n, FIELD - 1n];

const be = (x: bigint, n: number): Uint8Array => {
  const out = new Uint8Array(n);
  for (let i = n - 1; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
};
const entry = (noteSecret: bigint) => {
  const ownerKey = deriveOwnerKey(keys.spendKey, noteSecret);
  return { noteSecret: noteSecret.toString(), ownerKey: ownerKey.toString(), ownerCommitment: ownerCommitmentOf(ownerKey).toString() };
};

const secret1 = deriveNoteSecret(keys.noteKey, 1);
const ownerKey1 = deriveOwnerKey(keys.spendKey, secret1);
const note = { vaultId: 0xabn, amount: 10n ** 18n, ownerCommitment: ownerCommitmentOf(ownerKey1), noteSecret: secret1 };
const body = noteBody(note);
const commitment = noteCommitment(body, 0n);
const nf = nullifier(commitment, ownerKey1);

const out = {
  _source:
    "packages/protocol/src/genOwnerKeyVectors.ts: ownerKey = keccak256(be32(spendKey) || '/owner-key/' || be32(noteSecret)) mod p; ownerCommitment = H(OWNER_COMMITMENT, ownerKey)",
  seed: SEED,
  label: OWNER_KEY_LABEL,
  spendKey: keys.spendKey.toString(),
  noteKey: keys.noteKey.toString(),
  mainOwnerCommitment: ownerCommitmentOf(keys.spendKey).toString(),
  byCounter: COUNTERS.map((counter) => ({ counter, ...entry(deriveNoteSecret(keys.noteKey, counter)) })),
  edgeSecrets: EDGE_SECRETS.map(entry),
  preimageCounter1: "0x" + bytesToHex(new Uint8Array([...be(keys.spendKey, 32), ...utf8ToBytes(OWNER_KEY_LABEL), ...be(secret1, 32)])),
  sampleSpend: {
    counter: 1,
    vaultId: note.vaultId.toString(),
    amount: note.amount.toString(),
    leafIndex: 0,
    body: body.toString(),
    commitment: commitment.toString(),
    nullifier: nf.toString(),
    phantom: phantomNullifier(nf, 1, ownerKey1).toString(),
  },
};

const path = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "vectors", "owner-keys.json");
const text = JSON.stringify(out, null, 2) + "\n";
if (existsSync(path) && readFileSync(path, "utf8").replace(/\r\n/g, "\n") !== text && !process.argv.includes("--force"))
  throw new Error(`${path} differs from what this derivation gives: the owner keys are frozen (deposits, escrows and receivers fix them)`);
writeFileSync(path, text);
console.log(`wrote ${path}`);
