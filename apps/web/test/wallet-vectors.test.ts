// Interoperability vectors for the wallet's at-rest formats (plan §44, §69 "shared test vectors"):
// keystore, encrypted journal and the BIP-39 phrase / seed, pinned here from the web implementation
// (deterministic salt / nonce / small scrypt N) so the Rust core (privacy-core) and any other wallet can
// reproduce them byte for byte. Regenerate with UPDATE_VECTORS=1 (then review the diff).
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import { mnemonicToSeedSync, entropyToMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { createKeystore, seedToPhrase, unlockKeystore } from "@privacy-wallet/sdk/wallet/keystore";
import { encryptJournal, journalKey, decryptJournal, emptyJournal } from "@privacy-wallet/sdk/wallet/journal";

const FILE = fileURLToPath(new URL("../../../packages/protocol/test/vectors/wallet.json", import.meta.url));
const seed = hexToBytes("0f1e2d3c4b5a69788796a5b4c3d2e1f0f1e2d3c4b5a69788796a5b4c3d2e1f00");
const salt = hexToBytes("00112233445566778899aabbccddeeff");
const nonce = hexToBytes("101112131415161718191a1b1c1d1e1f2021222324252627");
const KDF = { N: 1 << 12, r: 8, p: 1 };
const fixedRng = (bytes: Uint8Array) => (n: number) => bytes.slice(0, n);

async function generate() {
  const ks = await createKeystore(seed, "correct horse battery staple", KDF, (n) => (n === 16 ? salt : nonce));
  const phrase = seedToPhrase(seed);
  const journal = { ...emptyJournal(), notes: [{ vaultId: "171", amount: "1000000000000000000", ownerCommitment: "6296251118823642552905479752093160106216242361714863370242727181463510312526", noteSecret: "11501897306810649921226615145916377511217047860362527109580516595403634051394", leafIndex: 0, noteData: "0x01", counter: 0, spent: false, label: "shield" as const }], noteCounter: 1, chainIndexes: { bitcoin: 2 } };
  const jnonce = hexToBytes("303132333435363738393a3b3c3d3e3f4041424344454647");
  const jkey = journalKey(seed);
  const encrypted = encryptJournal(jkey, journal, fixedRng(jnonce));
  const bip39 = [new Uint8Array(16), new Uint8Array(32), seed].map((e) => { const m = entropyToMnemonic(e, wordlist); return { entropy: bytesToHex(e), mnemonic: m, seed: bytesToHex(mnemonicToSeedSync(m)), seedWithPassphrase: bytesToHex(mnemonicToSeedSync(m, "TREZOR")) }; });
  return {
    _source: "apps/web/test/wallet-vectors.test.ts (web wallet implementation); keystore = scrypt(NFKD(password)) + XChaCha20-Poly1305 with aad privacy-protocol/v1/keystore; journal key = sha256(privacy-protocol/v1/journal-key || seed), aad privacy-protocol/v1/journal",
    keystore: { seed: bytesToHex(seed), password: "correct horse battery staple", kdf: { name: "scrypt", ...KDF, dkLen: 32 }, salt: bytesToHex(salt), nonce: bytesToHex(nonce), keystore: ks, phrase },
    journal: { seed: bytesToHex(seed), key: bytesToHex(jkey), nonce: bytesToHex(jnonce), plaintext: JSON.stringify(journal), encrypted },
    bip39,
  };
}

describe("wallet at-rest format vectors", () => {
  it("are reproduced by the web implementation (UPDATE_VECTORS=1 regenerates the file)", async () => {
    const v = await generate();
    if (process.env.UPDATE_VECTORS || !existsSync(FILE)) writeFileSync(FILE, JSON.stringify(v, null, 2) + "\n");
    const pinned = JSON.parse(readFileSync(FILE, "utf8"));
    expect(v).toEqual(pinned);
    // and they open
    expect(bytesToHex((await unlockKeystore(pinned.keystore.keystore, pinned.keystore.password))!)).toBe(pinned.keystore.seed);
    expect(JSON.stringify(decryptJournal(hexToBytes(pinned.journal.key), pinned.journal.encrypted))).toBe(pinned.journal.plaintext);
    expect(pinned.bip39[0].mnemonic).toBe("abandon ".repeat(11) + "about");
    expect(utf8ToBytes(pinned.keystore.phrase).length).toBeGreaterThan(100);
  });
});
