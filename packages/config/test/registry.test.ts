// The registries (spec v2.0 §9): unique ids, checksummed addresses, real chains, the status rules, and the V5 Swap's
// four destinations reproduced exactly (they moved here from apps/web/src/features/swap/targets.ts).
import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { ASSETS, CHAINS, assetLabel, assetOn, crossChainTargets, explorerLink, statusOf } from "../src";

describe("the asset registry", () => {
  it("ids are unique and lowercase; every chain exists; decimals and display decimals are sane", () => {
    expect(new Set(ASSETS.map((a) => a.id)).size).toBe(ASSETS.length);
    for (const a of ASSETS) {
      expect(a.id).toBe(a.id.toLowerCase());
      expect(CHAINS[a.chain], a.id).toBeDefined();
      expect(a.decimals).toBeGreaterThanOrEqual(0);
      expect(a.displayDecimals).toBeLessThanOrEqual(a.decimals);
    }
  });

  it("a token address is EIP-55 checksummed and only on an EVM chain; a native asset has none", () => {
    for (const a of ASSETS) {
      if (a.address) {
        expect(getAddress(a.address), a.id).toBe(a.address);
        expect(CHAINS[a.chain].family, a.id).toBe("evm");
      }
    }
    expect(assetOn("ethereum", null)?.id).toBe("eth");
    expect(assetOn("ethereum", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48")?.id, "case-insensitive lookup").toBe("usdc");
  });

  it("statuses: an unknown or disabled token is unsupported; a protectable asset without a vault is temporarily unavailable", () => {
    expect(statusOf(assetOn("ethereum", "0x0000000000000000000000000000000000000bad"))).toBe("unsupported");
    expect(statusOf(assetOn("ethereum", null), { hasVault: true })).toBe("supported");
    expect(statusOf(assetOn("ethereum", "0xdAC17F958D2ee523a2206206994597C13D831ec7"), { hasVault: false })).toBe("temporarily-unavailable");
    expect(statusOf(assetOn("bitcoin", null), { hasVault: false }), "a destination needs no vault").toBe("supported");
    expect(statusOf({ ...ASSETS[0], enabled: false })).toBe("unsupported");
  });

  it("reproduces the V5 Swap's four cross-chain destinations (id, chain, asset, decimals, symbol, network)", () => {
    const v5 = {
      BTC: { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC", network: "Bitcoin" },
      SOL: { chain: "solana", asset: "native", decimals: 9, symbol: "SOL", network: "Solana" },
      "USDC on Base": { chain: "base", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, symbol: "USDC", network: "Base" },
      "ETH on Base": { chain: "base", asset: "native", decimals: 18, symbol: "ETH", network: "Base" },
    };
    const now = Object.fromEntries(
      crossChainTargets().map((a) => [
        assetLabel(a),
        { chain: a.chain, asset: a.address ?? "native", decimals: a.decimals, symbol: a.symbol, network: CHAINS[a.chain].name },
      ]),
    );
    expect(now).toEqual(v5);
  });
});

describe("the chain registry", () => {
  it("EVM chains carry their chain id; explorers link by hash and address; the devnet has none", () => {
    for (const c of Object.values(CHAINS)) if (c.family === "evm") expect(c.chainId, c.id).toBeTypeOf("number");
    expect(explorerLink("ethereum", "tx", "0xabc")).toBe("https://etherscan.io/tx/0xabc");
    expect(explorerLink("bitcoin", "address", "bc1qxyz")).toBe("https://mempool.space/address/bc1qxyz");
    expect(explorerLink("local", "tx", "0xabc")).toBeNull();
  });
});
