// Destination parsing (whale spec §21): the wallet's own derived addresses parse (chain-key vectors), the
// BIP-173 / BIP-350 and base58check vectors parse to their format, testnet and malformed addresses are
// refused with a reason, a wrong-chain paste is refused with the chain's name, and the card groups in fours.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EVM_SHORT_NAMES, evmChainHint, groupAddress, looksLikeChain, parseBitcoin, parseDestination, parseEvm, parseSolana, refusedRecipient } from "../src/wallet/destinations";

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

describe("V6 (spec v2.0 §7.4): an EVM address that names its chain", () => {
  it("ERC-3770 short names and EIP-681 URIs name the chain; a bare address names none", () => {
    expect(evmChainHint(`base:${EVM}`)).toEqual({ address: EVM, chainId: 8453, name: "base" });
    expect(evmChainHint(` arb1:${EVM} `)).toEqual({ address: EVM, chainId: 42161, name: "arb1" });
    expect(evmChainHint(`eth:${EVM}`)?.chainId).toBe(1);
    expect(evmChainHint(`ethereum:${EVM}@8453`)).toEqual({ address: EVM, chainId: 8453, name: "chain 8453" });
    expect(evmChainHint(`ethereum:${EVM}`)?.chainId, "an EIP-681 URI without a chain id is mainnet").toBe(1);
    expect(evmChainHint(`ethereum:pay-${EVM}@10/transfer?value=1`)?.chainId).toBe(10);
    expect(evmChainHint(`zora:${EVM}`), "an unknown short name: the chain is not known, it is never assumed").toEqual({ address: EVM, chainId: null, name: "zora" });
    expect(evmChainHint(EVM)).toBeNull();
    expect(evmChainHint(BTC)).toBeNull();
    expect(evmChainHint("base:0x1234")).toBeNull();
    expect(Object.values(EVM_SHORT_NAMES)).toContain(1);
  });
});

describe("what a payment must not go to, and the code of every refusal (a V6 follow-up of 2026-10-16)", () => {
  const VAULT = "0x36ffA23fd38Ae93e2b01Aa5fA1570845aDA89469";
  const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
  const known = [
    { address: VAULT, kind: "protocol" as const },
    { address: USDT, kind: "token" as const, symbol: "USDT" },
  ];
  it("the zero and the burn address always; the deployment's contracts and a token's own contract when known; in any case", () => {
    expect(refusedRecipient("0x0000000000000000000000000000000000000000")).toMatchObject({ code: "zero_address" });
    expect(refusedRecipient("0x000000000000000000000000000000000000dEaD")).toMatchObject({ code: "burn_address" });
    expect(refusedRecipient(VAULT.toLowerCase(), known)).toMatchObject({ code: "protocol_contract" });
    expect(refusedRecipient(USDT.toUpperCase().replace("0X", "0x"), known)).toEqual({ code: "token_contract", reason: expect.stringContaining("USDT"), symbol: "USDT" });
    expect(refusedRecipient(VAULT), "not known: a well-formed address").toBeNull();
    expect(parseDestination("evm", USDT, known)).toMatchObject({ ok: false, code: "token_contract", symbol: "USDT" });
    expect(parseDestination("evm", "0x0000000000000000000000000000000000000000"), "refused even with nothing known").toMatchObject({ ok: false, code: "zero_address" });
    expect(parseDestination("evm", "0x9858EfFD232B4033E47d90003D41EC34EcaEda94", known).ok).toBe(true);
  });
  it("every refusal of the parsers names its code, for the user's language", () => {
    const code = (r: ReturnType<typeof parseEvm>) => (r.ok ? null : r.code);
    expect(code(parseEvm("0x1234"))).toBe("evm_format");
    expect(code(parseEvm("0x9858efFD232B4033E47d90003D41EC34EcaEda94"))).toBe("evm_checksum");
    expect(code(parseBitcoin("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx"))).toBe("btc_testnet");
    expect(code(parseBitcoin("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyx"))).toBe("btc_invalid");
    expect(code(parseBitcoin("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN3"))).toBe("btc_invalid");
    expect(code(parseSolana("0OIl"))).toBe("sol_invalid");
    expect(code(parseSolana("11111111111111111111111111111111"))).toBe("sol_system");
    expect(code(parseDestination("bitcoin", ""))).toBe("empty");
    expect(parseDestination("bitcoin", "0x9858EfFD232B4033E47d90003D41EC34EcaEda94")).toMatchObject({ ok: false, code: "other_chain", looksLike: "evm" });
    const src = readFileSync(fileURLToPath(new URL("../src/wallet/destinations.ts", import.meta.url)), "utf8");
    expect((src.match(/ok: false, chain, reason/g) ?? []).length, "each refusal written with its code").toBe((src.match(/, code: "/g) ?? []).length);
  });
});
