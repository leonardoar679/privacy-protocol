// Local, wallet-side key derivation (spec §4). The master seed NEVER leaves the client and is NEVER
// persisted to dapp-origin storage (the TC-01 fix). This is the reference derivation; a production
// wallet may use another KDF as long as ownerCommitment is computed exactly as note.ts does.
import { keccak_256 } from "@noble/hashes/sha3";
import { utf8ToBytes, concatBytes } from "@noble/hashes/utils";
import { FIELD } from "./field";
import { bytesToBigInt } from "./domains";

function deriveField(seed: Uint8Array, label: string): bigint {
  return bytesToBigInt(keccak_256(concatBytes(seed, utf8ToBytes(label)))) % FIELD;
}

export interface WalletKeys {
  spendKey: bigint; // authorizes spends (nullifier key); H(OWNER_COMMITMENT, spendKey) is the privacy address's owner commitment, and a deposited note's own owner key derives from it (deriveOwnerKey)
  viewKey: bigint; // decrypts incoming note payloads
  noteKey: bigint; // derives per-note secrets
}

/**
 * Thrown when a key would be derived from a seed that is no seed (the tenth review round, 2026-11-04, D-1): an empty or all-zero array —
 * what a lock leaves of the seed a flow still held (the lock zeroes it in place), or the public "abandon … art" phrase. Every key it
 * gives is anyone's: a deposit made out to it is spendable by anybody.
 */
export class SeedUnavailable extends Error {
  readonly code = "locked_mid_flow";
  constructor() {
    super("the wallet's seed is not available (the wallet locked): nothing is derived from it, nothing is sent");
    this.name = "SeedUnavailable";
  }
}

/**
 * The BIP-39 reference vectors' 24-word entropies (trezor/python-mnemonic vectors.json, the english list's eight), each a phrase anyone can
 * look up: a wallet made from one is anyone's (the eleventh review round, 2026-11-04, A11-11 — the all-zero "abandon … art" alone had been
 * refused). The four below, and four seeds of one repeated byte (00, 7f, 80, ff) that isPublicSeed refuses beside them.
 */
const PUBLIC_SEED_HEX = [
  "68a79eaca2324873eacc50cb9c6eca8cc68ea5d936f98787c60c7ebc74e6ce7c", // hamster diagram private … (the critique: missed at first)
  "9f6a2878b2520799a44ef18bc7df394e7061a224d2c33cd015b157d746869863", // panda eyebrow bullet …
  "066dca1a2bb7e8a1db2832148ce9933eea0f3ac9548d793112d9a95c9407efad", // all hour make …
  "f585c11aec520db57dd353c69554b21a89b20fb0650966fa0a9d6f74fd989d8f", // void come effort …
];
const PUBLIC_SEEDS: readonly Uint8Array[] = PUBLIC_SEED_HEX.map((h) => Uint8Array.from({ length: 32 }, (_, i) => parseInt(h.slice(i * 2, i * 2 + 2), 16)));
/**
 * Whether a 32-byte seed is a published test vector's: anyone can spend what a wallet made from it holds. Byte by byte — never a string of
 * the seed (the round's second critique: a hex string built per call, at every render of the warning, is a copy no lock can zero).
 */
export function isPublicSeed(seed: Uint8Array): boolean {
  if (seed.length !== 32) return false;
  const one = seed.every((b) => b === seed[0]);
  if (one && [0x00, 0x7f, 0x80, 0xff].includes(seed[0])) return true;
  return PUBLIC_SEEDS.some((p) => p.every((b, i) => b === seed[i]));
}

/** Refuses a seed that is no seed (SeedUnavailable). */
export function assertLiveSeed(masterSeed: Uint8Array): void {
  if (!masterSeed.length || masterSeed.every((b) => b === 0)) throw new SeedUnavailable();
}

export function deriveKeys(masterSeed: Uint8Array): WalletKeys {
  assertLiveSeed(masterSeed);
  return {
    spendKey: deriveField(masterSeed, "/spend"),
    viewKey: deriveField(masterSeed, "/view"),
    noteKey: deriveField(masterSeed, "/note"),
  };
}

/** noteSecret for the wallet's own notes: keccak(noteKey ‖ uint64 counter) mod p (spec §5.5). */
export function deriveNoteSecret(noteKey: bigint, counter: number): bigint {
  const b = new Uint8Array(40);
  let k = noteKey;
  for (let i = 31; i >= 0; i--) {
    b[i] = Number(k & 0xffn);
    k >>= 8n;
  }
  let c = BigInt(counter);
  for (let i = 39; i >= 32; i--) {
    b[i] = Number(c & 0xffn);
    c >>= 8n;
  }
  return bytesToBigInt(keccak_256(b)) % FIELD;
}

/** The label of a deposited note's own owner key (deriveOwnerKey). */
export const OWNER_KEY_LABEL = "/owner-key/";

/**
 * A deposited note's own owner key (a V6 follow-up of 2026-10-16, audit c18/c29/c37): keccak(spendKey ‖ "/owner-key/" ‖
 * noteSecret) mod p. Its owner commitment H(OWNER_COMMITMENT, key) is one-time: a protect deposit, an order's refund note
 * and a same-chain receipt each name their own, so nothing public links them to each other or to the privacy address.
 * Keyed by the spend key, because a deposited note's secret is public: only the spend key's holder derives or links them,
 * and the view key cannot. The note's secret is all the wallet needs to find the key again (an opened payload gives it, so
 * does a refund's counter). The 75-byte preimage is apart from every other derivation here. Pinned by
 * test/vectors/owner-keys.json and never to change: deposits, escrows and receivers fix it for good.
 */
export function deriveOwnerKey(spendKey: bigint, noteSecret: bigint): bigint {
  if (spendKey < 0n || spendKey >= FIELD || noteSecret < 0n || noteSecret >= FIELD) throw new Error("an owner key derives from field elements only");
  const b = new Uint8Array(75);
  let k = spendKey;
  for (let i = 31; i >= 0; i--) {
    b[i] = Number(k & 0xffn);
    k >>= 8n;
  }
  b.set(utf8ToBytes(OWNER_KEY_LABEL), 32);
  let s = noteSecret;
  for (let i = 74; i >= 43; i--) {
    b[i] = Number(s & 0xffn);
    s >>= 8n;
  }
  return bytesToBigInt(keccak_256(b)) % FIELD;
}
