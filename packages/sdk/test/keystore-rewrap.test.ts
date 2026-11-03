// The keystore's scrypt cost is this build's, not a file's (the fifth review round, 2026-11-03): a backup restored carried its
// own parameters in — a dev build's N = 4096, an edited header — and the device kept that weaker target for every later unlock
// and backup; the production floor had applied to a creation only.
import { describe, expect, it } from "vitest";
import { WalletSession } from "../src/wallet/session";
import { createKeystore, type Keystore } from "../src/wallet/keystore";
import { KEYSTORE_KEY, memoryStorage, type KeyValueStorage } from "../src/wallet/storage";
import { generateMasterSeed } from "../src/keys/wallet";

const WEAK = { N: 1 << 10, r: 8, p: 1 };
const STRONG = { N: 1 << 12, r: 8, p: 1 };
const stored = (store: KeyValueStorage) => JSON.parse(store.get(KEYSTORE_KEY)!) as Keystore;

describe("the keystore's scrypt cost is the build's", () => {
  it("a backup restored carries its own cost in; the device keeps the build's, opens the same seed, and a later backup exports that", async () => {
    const seed = generateMasterSeed();
    const weak = await createKeystore(seed, "pw", WEAK);
    const store = memoryStorage();
    const s = new WalletSession(store, STRONG);
    expect(await s.restoreFromBackup(JSON.stringify({ v: 1, keystore: weak, journal: null }), "pw")).toBe(true);
    expect(stored(store).kdf.N).toBe(STRONG.N);
    expect(stored(store).salt).not.toBe(weak.salt);
    expect(s.isUnlocked()).toBe(true);
    expect([...s.state().seed!]).toEqual([...seed]);
    expect((JSON.parse(s.exportBackup()) as { keystore: Keystore }).keystore.kdf.N).toBe(STRONG.N);
    s.lock();
    expect(await s.unlock("pw"), "the re-wrapped keystore opens with the same password").toBe(true);
    expect(await s.verifyPassword("pw")).toBe(true);
    expect(await s.verifyPassword("other")).toBe(false);
  });

  it("an unlock of a keystore below the build's cost wraps it again; one at the cost is left as it is", async () => {
    const seed = generateMasterSeed();
    const store = memoryStorage();
    store.set(KEYSTORE_KEY, JSON.stringify(await createKeystore(seed, "pw", WEAK)));
    const s = new WalletSession(store, STRONG);
    expect(await s.unlock("pw")).toBe(true);
    expect(stored(store).kdf.N).toBe(STRONG.N);
    expect([...s.state().seed!]).toEqual([...seed]);
    const after = store.get(KEYSTORE_KEY);
    s.lock();
    expect(await s.unlock("pw")).toBe(true);
    expect(store.get(KEYSTORE_KEY), "at the cost: not rewritten").toBe(after);
    s.lock();
    expect(await s.unlock("wrong")).toBe(false);
  });

  it("a keystore of another shape — an empty salt, a longer ciphertext, a longer nonce — opens nothing", async () => {
    const seed = generateMasterSeed();
    const ks = await createKeystore(seed, "pw", WEAK);
    const { unlockKeystore } = await import("../src/wallet/keystore");
    expect(await unlockKeystore(ks, "pw")).not.toBeNull();
    expect(await unlockKeystore({ ...ks, salt: "" }, "pw")).toBeNull();
    expect(await unlockKeystore({ ...ks, salt: ks.salt.slice(2) }, "pw")).toBeNull();
    expect(await unlockKeystore({ ...ks, nonce: ks.nonce + "00" }, "pw")).toBeNull();
    expect(await unlockKeystore({ ...ks, ct: ks.ct + "00" }, "pw")).toBeNull();
  });
});
