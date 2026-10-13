// Keystore, recovery phrase, encrypted journal and the session that ties them together (plan §44).
// Pure node: a memory storage stands in for localStorage. Small scrypt N keeps the suite fast.
import { describe, it, expect, beforeEach } from "vitest";
import { bytesToHex } from "@noble/hashes/utils";
import { createKeystore, phraseToSeed, seedToPhrase, unlockKeystore, type Keystore } from "@privacy-wallet/sdk/wallet/keystore";
import { decryptJournal, emptyJournal, encryptJournal, journalKey } from "@privacy-wallet/sdk/wallet/journal";
import { memoryStorage, JOURNAL_KEY, KEYSTORE_KEY } from "@privacy-wallet/sdk/wallet/storage";
import { WalletSession } from "@privacy-wallet/sdk/wallet/session";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { assertNotPersistingSecret } from "@privacy-wallet/sdk/keys/wallet";

const KDF = { N: 1 << 12, r: 8, p: 1 };
const seed = Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 0xff);

describe("keystore", () => {
  it("round-trips the seed; wrong password and tampering give null, never a wrong seed", async () => {
    const ks = await createKeystore(seed, "correct horse", KDF);
    expect(ks.v).toBe(1);
    expect(bytesToHex(await (unlockKeystore(ks, "correct horse")) as Uint8Array)).toBe(bytesToHex(seed));
    expect(await unlockKeystore(ks, "wrong")).toBeNull();
    const flipped = { ...ks, ct: ks.ct.slice(0, -2) + (ks.ct.endsWith("00") ? "01" : "00") };
    expect(await unlockKeystore(flipped, "correct horse")).toBeNull();
    expect(await unlockKeystore({ ...ks, v: 2 } as unknown as Keystore, "correct horse")).toBeNull();
    expect(await unlockKeystore({ ...ks, kdf: { ...ks.kdf, N: 16 } }, "correct horse")).toBeNull(); // unsafe params refused
    await expect(createKeystore(seed.slice(0, 31), "x", KDF)).rejects.toThrow(/32 bytes/);
    await expect(createKeystore(seed, "", KDF)).rejects.toThrow(/password/);
  });
  it("the ciphertext never contains the seed and two keystores of the same seed differ (fresh salt + nonce)", async () => {
    const a = await createKeystore(seed, "pw", KDF), b = await createKeystore(seed, "pw", KDF);
    expect(JSON.stringify(a)).not.toContain(bytesToHex(seed));
    expect(a.ct).not.toBe(b.ct);
    expect(a.salt).not.toBe(b.salt);
  });
});

describe("recovery phrase", () => {
  it("is 24 words that encode exactly the seed; normalizes case and whitespace; rejects errors", () => {
    const phrase = seedToPhrase(seed);
    expect(phrase.split(" ")).toHaveLength(24);
    expect(bytesToHex(phraseToSeed(phrase))).toBe(bytesToHex(seed));
    expect(bytesToHex(phraseToSeed("  " + phrase.toUpperCase().replace(/ /g, "\n  ") + " "))).toBe(bytesToHex(seed));
    const words = phrase.split(" ");
    const wrongChecksum = [...words.slice(0, 23), words[0] === "abandon" ? "zoo" : "abandon"].join(" ");
    expect(() => phraseToSeed(wrongChecksum)).toThrow(/not a valid/);
    expect(() => phraseToSeed(words.slice(0, 12).join(" "))).toThrow(/24 words/);
    expect(() => phraseToSeed(phrase.replace(words[3], "notaword"))).toThrow(/not a valid/);
  });
  it("the all-zero seed gives the BIP-39 reference phrase", () => {
    expect(seedToPhrase(new Uint8Array(32))).toBe("abandon ".repeat(23) + "art");
  });
});

describe("journal", () => {
  it("round-trips under the seed-derived key; another seed's key cannot read it", () => {
    const key = journalKey(seed);
    const data = { ...emptyJournal(), notes: [{ vaultId: "1", amount: "1000000000000000000", ownerCommitment: "2", noteSecret: "3", leafIndex: 4, noteData: "0x01" as const, counter: 0, spent: false }], noteCounter: 1, chainIndexes: { bitcoin: 2 } };
    const blob = encryptJournal(key, data);
    expect(decryptJournal(key, blob)).toEqual(data);
    expect(decryptJournal(journalKey(new Uint8Array(32)), blob)).toBeNull();
    expect(JSON.stringify(blob)).not.toContain("1000000000000000000");
  });
});

describe("session", () => {
  beforeEach(() => { noteStore.clear(); settings.reset(); });

  it("create → lock → unlock restores the seed, the notes and the settings; storage holds ciphertext only", async () => {
    const storage = memoryStorage();
    const s = new WalletSession(storage, KDF);
    expect(s.state().status).toBe("none");
    const phrase = await s.create("password-1");
    expect(s.state().status).toBe("unlocked");
    const seedHex = bytesToHex(s.state().seed!);
    noteStore.add({ note: { vaultId: 7n, amount: 5n * 10n ** 17n, ownerCommitment: 9n, noteSecret: 11n }, leafIndex: 12, noteData: "0x0102", counter: noteStore.allocateCounter(), spent: false, label: "shield" });
    settings.set({ advanced: true, submission: { kind: "relayer", url: "http://relayer.test" } });
    // nothing in storage reveals the seed, the phrase, the note secret or the amount
    const persisted = [storage.get(KEYSTORE_KEY)!, storage.get(JOURNAL_KEY)!].join("\n");
    expect(persisted).not.toContain(seedHex);
    for (const w of phrase.split(" ").filter((w) => w.length > 5)) expect(persisted.toLowerCase()).not.toMatch(new RegExp(`\\b${w}\\b`));
    expect(persisted).not.toContain("500000000000000000");
    expect(persisted).not.toContain("relayer.test");
    s.lock();
    expect(s.state().status).toBe("locked");
    expect(s.state().seed).toBeNull();
    expect(noteStore.all()).toHaveLength(0);
    expect(await s.unlock("nope")).toBe(false);
    expect(await s.unlock("password-1")).toBe(true);
    expect(bytesToHex(s.state().seed!)).toBe(seedHex);
    expect(noteStore.all()).toHaveLength(1);
    expect(noteStore.all()[0].note.amount).toBe(5n * 10n ** 17n);
    expect(noteStore.allocateCounter()).toBe(1); // counters continue, never reused
    expect(settings.get().advanced).toBe(true);
    expect(settings.get().submission).toEqual({ kind: "relayer", url: "http://relayer.test" });
  });

  it("restores from the phrase on a new device (empty journal) and from a backup file (journal included)", async () => {
    const a = new WalletSession(memoryStorage(), KDF);
    const phrase = await a.create("pw-a");
    const seedHex = bytesToHex(a.state().seed!);
    noteStore.add({ note: { vaultId: 1n, amount: 2n, ownerCommitment: 3n, noteSecret: 4n }, leafIndex: 0, noteData: "0x00", spent: false });
    const backup = a.exportBackup();
    a.lock();

    const b = new WalletSession(memoryStorage(), KDF);
    await b.restoreFromPhrase(phrase, "pw-b");
    expect(bytesToHex(b.state().seed!)).toBe(seedHex);
    expect(noteStore.all()).toHaveLength(0); // a phrase restores the seed; notes come from a rescan
    b.lock();

    const c = new WalletSession(memoryStorage(), KDF);
    expect(await c.restoreFromBackup(backup, "wrong")).toBe(false);
    expect(await c.restoreFromBackup(backup, "pw-a")).toBe(true);
    expect(bytesToHex(c.state().seed!)).toBe(seedHex);
    expect(noteStore.all().map((n) => n.leafIndex)).toEqual([0]);
    await expect(c.restoreFromBackup("{}", "pw-a")).rejects.toThrow(/not a wallet backup/);
  });

  it("the storage keys pass the TC-01 guard and forget() leaves nothing behind", async () => {
    expect(() => assertNotPersistingSecret(KEYSTORE_KEY)).not.toThrow();
    expect(() => assertNotPersistingSecret(JOURNAL_KEY)).not.toThrow();
    expect(() => assertNotPersistingSecret("pp.seed")).toThrow(/TC-01/);
    const storage = memoryStorage();
    const s = new WalletSession(storage, KDF);
    await s.create("pw");
    s.forget();
    expect(storage.get(KEYSTORE_KEY)).toBeNull();
    expect(storage.get(JOURNAL_KEY)).toBeNull();
    expect(s.state().status).toBe("none");
  });
});
