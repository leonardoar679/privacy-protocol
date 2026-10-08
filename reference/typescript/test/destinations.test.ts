// Destination parsing (whale spec §21): the wallet's own derived addresses parse (chain-key vectors), the
// BIP-173 / BIP-350 and base58check vectors parse to their format, testnet and malformed addresses are
// refused with a reason, a wrong-chain paste is refused with the chain's name, and the card groups in fours.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { groupAddress, looksLikeChain, parseBitcoin, parseDestination, parseEvm, parseSolana } from "../src/wallet/destinations";

const vectors = JSON.parse(readFileSync(fileURLToPath(new URL("./vectors/chainkeys.json", import.meta.url)), "utf8"));
const EVM = vectors.bip44_evm.account0.address as string; // 0x9858EfFD232B4033E47d90003D41EC34EcaEda94
const BTC = vectors.bip84.receive0.address as string; // bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu
const SOL = vectors.solana.account0.address as string; // HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk

describe("destinations", () => {
  it("the wallet's own fresh addresses parse on their chain", () => {
    expect(parseDestination("evm", EVM)).toMatchObject({ ok: true, format: "evm", normalized: EVM });
    expect(parseDestination("bitcoin", BTC)).toMatchObject({ ok: true, format: "p2wpkh", normalized: BTC });
    expect(parseDestination("solana", SOL)).toMatchObject({ ok: true, format: "ed25519" });
  });

  it("EVM: lowercase and uppercase pass, mixed case must be the EIP-55 checksum", () => {
    expect(parseEvm(EVM.toLowerCase())).toMatchObject({ ok: true, normalized: EVM });
    expect(parseEvm("0x" + EVM.slice(2).toUpperCase())).toMatchObject({ ok: true, normalized: EVM });
    expect(parseEvm("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed").ok).toBe(true);
    expect(parseEvm("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD")).toMatchObject({ ok: false, reason: expect.stringMatching(/checksum/) });
    expect(parseEvm("0x1234")).toMatchObject({ ok: false, reason: expect.stringMatching(/40 hex/) });
  });

  it("Bitcoin: bech32 v0 (20 / 32 bytes), bech32m v1 (taproot), base58check P2PKH / P2SH; testnet, mixed case, bad checksums and odd versions refused", () => {
    expect(parseBitcoin("BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4")).toMatchObject({ ok: true, format: "p2wpkh", normalized: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4" });
    expect(parseBitcoin("bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3")).toMatchObject({ ok: true, format: "p2wsh" });
    expect(parseBitcoin("bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0")).toMatchObject({ ok: true, format: "p2tr" });
    expect(parseBitcoin("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2")).toMatchObject({ ok: true, format: "p2pkh" });
    expect(parseBitcoin("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy")).toMatchObject({ ok: true, format: "p2sh" });
    expect(parseBitcoin("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx")).toMatchObject({ ok: false, reason: expect.stringMatching(/testnet/) });
    expect(parseBitcoin("mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn")).toMatchObject({ ok: false, reason: expect.stringMatching(/testnet/) });
    expect(parseBitcoin("bc1Qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4")).toMatchObject({ ok: false, reason: expect.stringMatching(/lowercase or all uppercase/) });
    expect(parseBitcoin("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5")).toMatchObject({ ok: false, reason: expect.stringMatching(/checksum/) });
    expect(parseBitcoin("BC1SW50QGDZ25J")).toMatchObject({ ok: false, reason: expect.stringMatching(/witness version 16/) });
    expect(parseBitcoin("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN3")).toMatchObject({ ok: false, reason: expect.stringMatching(/base58check/) });
  });

  it("Solana: 32 base58 bytes, never the system program", () => {
    expect(parseSolana("11111111111111111111111111111111")).toMatchObject({ ok: false, reason: expect.stringMatching(/system program/) });
    expect(parseSolana("HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi")).toMatchObject({ ok: false, reason: expect.stringMatching(/32 bytes/) });
    expect(parseSolana("0OIl")).toMatchObject({ ok: false, reason: expect.stringMatching(/base58/) });
  });

  it("a wrong-chain paste is refused with the chain's name (plan §59); an empty field asks for an address", () => {
    expect(looksLikeChain(EVM)).toBe("evm");
    expect(looksLikeChain(BTC)).toBe("bitcoin");
    expect(looksLikeChain(SOL)).toBe("solana");
    expect(looksLikeChain("hello")).toBeNull();
    expect(parseDestination("bitcoin", EVM)).toMatchObject({ ok: false, looksLike: "evm", reason: "this looks like a Ethereum address; the destination is Bitcoin" });
    expect(parseDestination("solana", BTC)).toMatchObject({ ok: false, looksLike: "bitcoin", reason: expect.stringMatching(/looks like a Bitcoin address; the destination is Solana/) });
    expect(parseDestination("evm", SOL)).toMatchObject({ ok: false, looksLike: "solana" });
    expect(parseDestination("evm", "  ")).toMatchObject({ ok: false, reason: "enter an address" });
    expect(parseDestination("bitcoin", ` ${BTC} `)).toMatchObject({ ok: true, address: BTC });
  });

  it("groups an address in fours for the card", () => {
    expect(groupAddress("0x9858EfFD232B4033E47d90003D41EC34EcaEda94")).toBe("0x9858 EfFD 232B 4033 E47d 9000 3D41 EC34 EcaE da94");
    expect(groupAddress("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu")).toBe("bc1q cr8t e4kr 609g cawu tmrz a0j4 xv80 jy8z 306f yu");
  });
});
