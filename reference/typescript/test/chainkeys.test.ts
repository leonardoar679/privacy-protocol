// Chain Key Abstraction (plan §45): the derivations are the standard ones, pinned against the SLIP-0010
// ed25519 vectors, the BIP-84 vectors and the BIP-44 Ethereum address of the reference mnemonic;
// fresh addresses never repeat across indexes; dApp accounts are stable per origin and distinct.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { ed25519 } from "@noble/curves/ed25519";
import { bip39Seed, bitcoinAccount, dappAccount, dappAccountIndex, evmAccount, eip55, looksLikeAddress, parseHardenedPath, slip10Ed25519, solanaAccount } from "../src/wallet/chainKeys";

const vectors = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "vectors/chainkeys.json"), "utf8"));

describe("SLIP-0010 ed25519", () => {
  for (const v of vectors.slip10_ed25519) {
    it(`reproduces every chain of the vector with seed ${v.seed.slice(0, 8)}…`, () => {
      for (const c of v.chains) {
        const path = c.path === "m" ? [] : parseHardenedPath(c.path);
        const { privateKey, chainCode } = slip10Ed25519(hexToBytes(v.seed), path);
        expect(bytesToHex(privateKey)).toBe(c.privateKey);
        expect(bytesToHex(chainCode)).toBe(c.chainCode);
        expect("00" + bytesToHex(ed25519.getPublicKey(privateKey))).toBe(c.publicKey);
      }
    });
  }
  it("refuses non-hardened components (ed25519 has no public derivation)", () => {
    expect(() => parseHardenedPath("m/44'/501'/0/0'")).toThrow(/hardened/);
  });
});

describe("BIP-84 / BIP-44 from the reference mnemonic", () => {
  const seed = bip39Seed(vectors.bip84.mnemonic);
  it("first receiving and change P2WPKH addresses", () => {
    const r = bitcoinAccount(seed, 0);
    expect(r.path).toBe(vectors.bip84.receive0.path);
    expect(bytesToHex(r.publicKey)).toBe(vectors.bip84.receive0.publicKey);
    expect(r.address).toBe(vectors.bip84.receive0.address);
    const c = bitcoinAccount(seed, 0, 1);
    expect(bytesToHex(c.publicKey)).toBe(vectors.bip84.change0.publicKey);
    expect(c.address).toBe(vectors.bip84.change0.address);
  });
  it("first Ethereum account with the EIP-55 checksum", () => {
    const a = evmAccount(seed, 0);
    expect(a.address).toBe(vectors.bip44_evm.account0.address);
    expect(eip55(hexToBytes(a.address.slice(2).toLowerCase()))).toBe(a.address);
  });
  it("Solana account 0 is the Phantom / solana-keygen address of the mnemonic; accounts follow m/44'/501'/i'/0'", () => {
    const s0 = solanaAccount(seed, 0), s1 = solanaAccount(seed, 1);
    expect(s0.path).toBe(vectors.solana.account0.path);
    expect(s0.address).toBe(vectors.solana.account0.address);
    expect(s0.address).not.toBe(s1.address);
    expect(looksLikeAddress("solana", s0.address)).toBe(true);
    expect(bytesToHex(ed25519.getPublicKey(s0.privateKey))).toBe(bytesToHex(s0.publicKey));
  });
});

describe("fresh addresses and dApp isolation", () => {
  const seed = bip39Seed(vectors.bip84.mnemonic);
  it("indexes never collide across the first 50 addresses of each chain", () => {
    for (const chain of ["evm", "bitcoin", "solana"] as const) {
      const f = chain === "evm" ? evmAccount : chain === "bitcoin" ? bitcoinAccount : solanaAccount;
      const set = new Set(Array.from({ length: 50 }, (_, i) => f(seed, i).address));
      expect(set.size).toBe(50);
    }
  });
  it("the same origin always maps to the same account, different origins to different ones, never the first account", () => {
    const a = dappAccount(seed, "https://app.example"), b = dappAccount(seed, "https://APP.example/"), c = dappAccount(seed, "https://other.example");
    expect(a.address).toBe(dappAccount(seed, "https://app.example").address);
    expect(a.index).toBe(dappAccountIndex("https://app.example"));
    expect(a.index).toBeLessThan(0x80000000);
    expect(b.address).not.toBe(a.address); // trailing slash is a different origin string; normalisation is the caller's job
    expect(c.address).not.toBe(a.address);
    expect(a.address).not.toBe(evmAccount(seed, 0).address);
  });
  it("address shape checks", () => {
    expect(looksLikeAddress("bitcoin", vectors.bip84.receive0.address)).toBe(true);
    expect(looksLikeAddress("bitcoin", vectors.bip84.receive0.address.slice(0, -1) + "x")).toBe(false);
    expect(looksLikeAddress("evm", vectors.bip44_evm.account0.address)).toBe(true);
    expect(looksLikeAddress("evm", "0x1234")).toBe(false);
    expect(looksLikeAddress("solana", "not-base58-0OIl")).toBe(false);
  });
});
