// Fresh receiving / destination addresses (plan §28, §45–§46): reserved through the encrypted
// journal (never repeated, survive lock/unlock), equal to the reference derivation from the phrase,
// and — for EVM — equal to an independent BIP-44 implementation (viem's mnemonicToAccount).
import { describe, it, expect, beforeEach } from "vitest";
import { mnemonicToAccount } from "viem/accounts";
import { bip39Seed, bitcoinAccount, evmAccount, solanaAccount } from "@privacy-wallet/protocol/wallet/chainKeys";
import { consumeFreshAddress, dappAccount, lastFreshAddress, lastUnusedFreshAddress, peekFreshAddress } from "@privacy-wallet/sdk/keys/chainKeys";
import { markAddressUsed, retireAddress, entryIdFor } from "@privacy-wallet/sdk/wallet/addressBook";
import { seedToPhrase } from "@privacy-wallet/sdk/wallet/keystore";
import { WalletSession } from "@privacy-wallet/sdk/wallet/session";
import { memoryStorage } from "@privacy-wallet/sdk/wallet/storage";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";

const KDF = { N: 1 << 12, r: 8, p: 1 };
const seedBytes = Uint8Array.from({ length: 32 }, (_, i) => (i * 5 + 1) & 0xff);

describe("fresh addresses", () => {
  beforeEach(() => noteStore.clear());

  it("are reserved in order, never repeat, and persist across lock/unlock", async () => {
    const s = new WalletSession(memoryStorage(), KDF);
    await s.create("pw", seedBytes);
    const seed = s.state().seed!;
    expect(lastFreshAddress(seed, "bitcoin", s)).toBeNull();
    const peek = peekFreshAddress(seed, "bitcoin", s);
    const a0 = consumeFreshAddress(seed, "bitcoin", s);
    const a1 = consumeFreshAddress(seed, "bitcoin", s);
    expect(a0.address).toBe(peek.address);
    expect(a0.index).toBe(0);
    expect(a1.index).toBe(1);
    expect(a0.address).not.toBe(a1.address);
    expect(a0.address.startsWith("bc1q")).toBe(true);
    expect(lastFreshAddress(seed, "bitcoin", s)!.address).toBe(a1.address);
    expect(consumeFreshAddress(seed, "solana", s).index).toBe(0); // chains count independently
    s.lock();
    await s.unlock("pw");
    const seed2 = s.state().seed!;
    expect(peekFreshAddress(seed2, "bitcoin", s).index).toBe(2);
    expect(peekFreshAddress(seed2, "solana", s).index).toBe(1);
    expect(peekFreshAddress(seed2, "evm", s).index).toBe(0);
  });

  it("the last reserved address is offered again only while nothing used it: consumed as a destination, or retired, Receive offers a new one (the sixth review round, 2026-11-03)", async () => {
    const s = new WalletSession(memoryStorage(), KDF);
    await s.create("pw", seedBytes);
    const seed = s.state().seed!;
    expect(lastUnusedFreshAddress(seed, "bitcoin", s)).toBeNull();
    const a0 = consumeFreshAddress(seed, "bitcoin", s);
    expect(lastUnusedFreshAddress(seed, "bitcoin", s)?.address, "reserved, unused: shown").toBe(a0.address);
    markAddressUsed("bitcoin", a0.address, "0xorder", s);
    expect(lastUnusedFreshAddress(seed, "bitcoin", s), "a swap's destination: never offered to a payer").toBeNull();
    expect(lastFreshAddress(seed, "bitcoin", s)?.address, "still the last reserved").toBe(a0.address);
    const a1 = consumeFreshAddress(seed, "bitcoin", s);
    expect(lastUnusedFreshAddress(seed, "bitcoin", s)?.address).toBe(a1.address);
    retireAddress(entryIdFor("bitcoin", a1.address), s);
    expect(lastUnusedFreshAddress(seed, "bitcoin", s), "retired: not offered").toBeNull();
  });
  it("equal the reference derivation from the recovery phrase, and viem's independent BIP-44 for EVM", async () => {
    const s = new WalletSession(memoryStorage(), KDF);
    await s.create("pw", seedBytes);
    const seed = s.state().seed!;
    const phrase = seedToPhrase(seed);
    const ref = bip39Seed(phrase);
    expect(consumeFreshAddress(seed, "bitcoin", s).address).toBe(bitcoinAccount(ref, 0).address);
    expect(consumeFreshAddress(seed, "solana", s).address).toBe(solanaAccount(ref, 0).address);
    const e0 = consumeFreshAddress(seed, "evm", s), e1 = consumeFreshAddress(seed, "evm", s);
    expect(e0.address).toBe(evmAccount(ref, 0).address);
    expect(e0.address).toBe(mnemonicToAccount(phrase, { addressIndex: 0 }).address);
    expect(e1.address).toBe(mnemonicToAccount(phrase, { addressIndex: 1 }).address);
    const d = dappAccount(seed, "https://dapp.example");
    expect(d.address).toBe(mnemonicToAccount(phrase, { addressIndex: d.index }).address);
    expect(d.address).not.toBe(e0.address);
  });
});
