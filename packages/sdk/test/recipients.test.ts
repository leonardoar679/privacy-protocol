// A private withdrawal never pays an address that loses what it receives (a V6 follow-up of 2026-10-16): the zero or a burn
// address, a contract of this deployment (the pool, a vault, the router, a factory) or a token's own contract. The screens
// refuse them as destinations; the withdrawal refuses them again, before anything is proved or sent.
import { describe, expect, it } from "vitest";
import type { Deployment } from "../src/chain";
import { guardRecipient, knownAddresses, RecipientRefused } from "../src/recipients";
import { classify } from "../src/operations/errors/catalog";

const deployment: Deployment = {
  chainId: 1,
  core: "0x5991A2dF15A8F6A256D3Ec51E99254Cd3fb576A9",
  ethVault: "0x36ffA23fd38Ae93e2b01Aa5fA1570845aDA89469",
  rpcUrl: "http://127.0.0.1:1",
  rpcUrls: ["http://127.0.0.1:1"],
  fromBlock: 0n,
  erc20Vaults: [{ symbol: "USDC", decimals: 6, token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", vault: "0x00000000000000000000000000000000000000C2" }],
  protectRouter: "0x00000000000000000000000000000000000000a1",
  swapFactory: "0x00000000000000000000000000000000000000f5",
};

describe("the recipients a withdrawal refuses", () => {
  it("knows the deployment's contracts and its tokens, with the app's tokens added", () => {
    const k = knownAddresses(deployment, [{ address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", symbol: "USDT" }]);
    expect(k.filter((x) => x.kind === "protocol").map((x) => x.address)).toEqual([
      deployment.core,
      deployment.ethVault,
      deployment.protectRouter,
      deployment.swapFactory,
      deployment.erc20Vaults[0].vault,
    ]);
    expect(k.filter((x) => x.kind === "token").map((x) => x.symbol)).toEqual(["USDC", "USDT"]);
    expect(knownAddresses(null)).toEqual([]);
  });
  it("refuses the zero address, the burn address, the deployment's contracts and its tokens — before anything — and lets any other address through", () => {
    for (const a of [
      "0x0000000000000000000000000000000000000000",
      "0x000000000000000000000000000000000000dEaD",
      deployment.core,
      deployment.ethVault,
      "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    ]) {
      let e: unknown = null;
      try {
        guardRecipient(deployment, a);
      } catch (x) {
        e = x;
      }
      expect(e, a).toBeInstanceOf(RecipientRefused);
      expect(classify(e), "the catalog's words: nothing was sent").toMatchObject({ code: "recipient_refused", fundsClass: "not-moved" });
    }
    expect(() => guardRecipient(deployment, "0x9858EfFD232B4033E47d90003D41EC34EcaEda94")).not.toThrow();
  });
});
