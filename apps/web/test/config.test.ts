// The configuration (V6 Stage 3; spec v2.0 §4): the build's environment parsed and checked in one place
// (src/config.ts), installed once, read by every engine module at the moment of use.
import { getAddress } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { applyConfig, configFromEnv, testConfig } from "../src/config";
import { allowedHosts, isStrict, setStrict } from "@privacy-wallet/privacy-engine/transport/http";
import { defaultRelayerUrl, relayerFallbacks } from "@privacy-wallet/sdk/relayer";
import { swapServiceUrl } from "@privacy-wallet/sdk/swapService";
import { holdMs, reviewHoldMinutes } from "@privacy-wallet/sdk/tiers";
import { PINNED, thornodeGateways, thornodeQuorum } from "@privacy-wallet/sdk/providerCall";
import { beaconUrls, lcCheckpoint } from "@privacy-wallet/sdk/verifiedReads";
import { artifactUrls } from "../src/prover/client";
import { walletConnectAvailable } from "@privacy-wallet/wallet-engine/walletConnect";

const CORE = "0x5991A2dF15A8F6A256D3Ec51E99254Cd3fb576A9";
const VAULT = "0x36ffA23fd38Ae93e2b01Aa5fA1570845aDA89469";
const ROUTER = "0x00000000000000000000000000000000000000aa";

afterEach(() => {
  applyConfig(testConfig());
  setStrict(false);
});

describe("configFromEnv", () => {
  it("an empty environment is every default: the local stack's endpoints, no deployment, only the default gateways allowlisted", () => {
    const c = configFromEnv({});
    expect(c.deployment).toBeNull();
    expect(c.relayer).toEqual({ url: "http://127.0.0.1:8790", fallbacks: [] });
    expect(c.swapService).toBe("http://127.0.0.1:8787");
    expect(c.artifactBase).toBe("/artifacts");
    expect([c.holdMs, c.reviewHoldMinutes, c.production]).toEqual([1500, 30, false]);
    expect(c.thornode.gateways).toHaveLength(3);
    // the defaults it uses are allowlisted (the audit round of 2026-10-16, c59); a devnet has no beacon API
    expect(c.hosts).toEqual(c.thornode.gateways);
    expect(c.priceFeeds).toBeNull();
  });

  it("a full environment: the deployment, the relayers (the first of a list when none is named), the switches, the hosts it names", () => {
    const c = configFromEnv({
      VITE_RPC_URLS: "https://rpc-a.example, https://rpc-b.example",
      VITE_CORE: CORE,
      VITE_ETH_VAULT: VAULT,
      VITE_CHAIN_ID: "1",
      VITE_RELAYER_URLS: "https://relay-1.example,https://relay-2.example",
      VITE_SWAP_SERVICE: "https://swap.example",
      VITE_BEACON_URLS: "https://beacon.example",
      VITE_LC_CHECKPOINT: "0x" + "ab".repeat(32),
      VITE_THORNODE_QUORUM: "3",
      VITE_THORCHAIN_ROUTER: "0x00000000000000000000000000000000000000aa",
      VITE_WC_PROJECT_ID: "wc-123",
      VITE_ARTIFACT_BASE: "https://cdn.example/a",
      VITE_HOLD_MS: "900",
      VITE_REVIEW_HOLD_MINUTES: "5",
      VITE_KDF_LOG2N: "14",
      PROD: true,
    });
    expect(c.deployment?.rpcUrls).toEqual(["https://rpc-a.example", "https://rpc-b.example"]);
    expect(c.relayer).toEqual({ url: "https://relay-1.example", fallbacks: ["https://relay-1.example", "https://relay-2.example"] });
    expect([c.swapService, c.lcCheckpoint, c.thornode.quorum, c.thorchainRouter, c.walletConnectProjectId]).toEqual([
      "https://swap.example",
      "0x" + "ab".repeat(32),
      3,
      "0x00000000000000000000000000000000000000aa",
      "wc-123",
    ]);
    expect([c.holdMs, c.reviewHoldMinutes, c.kdfLog2N, c.production]).toEqual([900, 5, 14, true]);
    expect(c.hosts).toEqual([
      "https://rpc-a.example",
      "https://rpc-b.example",
      "https://relay-1.example",
      "https://relay-2.example",
      "https://swap.example",
      "https://beacon.example",
      "https://cdn.example/a",
      ...c.thornode.gateways, // no VITE_THORNODE_URLS: the default gateways it uses (c59); beacon APIs named, no default added
    ]);
  });

  it("a malformed value is refused, naming its variable", () => {
    expect(() => configFromEnv({ VITE_KDF_LOG2N: "30" })).toThrow(/VITE_KDF_LOG2N/);
    expect(() => configFromEnv({ VITE_LC_CHECKPOINT: "0x1234" })).toThrow(/VITE_LC_CHECKPOINT/);
    expect(() => configFromEnv({ VITE_THORCHAIN_ROUTER: "0xnot" })).toThrow(/VITE_THORCHAIN_ROUTER/);
    expect(() => configFromEnv({ VITE_SWAP_SERVICE: "not a url" })).toThrow(/VITE_SWAP_SERVICE/);
    expect(() => configFromEnv({ VITE_RPC_URLS: "https://ok.example, nope" })).toThrow(/"nope" is not a URL/);
    expect(() => configFromEnv({ VITE_PRICE_FEEDS: "[{}]" })).toThrow();
  });
});

describe("applyConfig and the accessors", () => {
  it("every engine module reads the installed configuration at the moment of use", () => {
    applyConfig(
      testConfig({
        relayer: { url: "https://r.example", fallbacks: ["https://r.example", "https://s.example"] },
        swapService: "https://swap.example",
        holdMs: 77,
        reviewHoldMinutes: 9,
        thornode: { gateways: ["https://g1.example/", "https://g2.example", "https://G1.example"], quorum: 1 },
        thorchainRouter: ROUTER,
        walletConnectProjectId: "wc",
        artifactBase: "https://cdn.example/x",
        beaconUrls: ["https://b.example"],
        lcCheckpoint: `0x${"cd".repeat(32)}`,
      }),
    );
    expect([defaultRelayerUrl(), relayerFallbacks(), swapServiceUrl()]).toEqual(["https://r.example", ["https://s.example"], "https://swap.example"]);
    expect([holdMs(), reviewHoldMinutes()]).toEqual([77, 9]);
    expect(thornodeGateways(), "trailing slashes trimmed, each gateway once (the audit's unverified m25)").toEqual([
      "https://g1.example",
      "https://g2.example",
    ]);
    expect(thornodeQuorum(), "never below two").toBe(2);
    expect(PINNED.thorchainRouter, "the override, checksummed").toBe(getAddress(ROUTER));
    expect(walletConnectAvailable()).toBe(true);
    expect(artifactUrls().zkey).toBe("https://cdn.example/x/transaction_final.zkey");
    expect([beaconUrls(), lcCheckpoint()]).toEqual([["https://b.example"], `0x${"cd".repeat(32)}`]);
    applyConfig(testConfig());
    expect([defaultRelayerUrl(), walletConnectAvailable(), PINNED.thorchainRouter]).toEqual([
      "http://127.0.0.1:8790",
      false,
      "0xD37BbE5744D730a1d98d8DC97c42F0Ca46aD7146",
    ]);
  });

  it("the transport allowlists the configured hosts and the gateways, and is strict in a production build", () => {
    applyConfig(configFromEnv({ VITE_RELAYER_URL: "https://relayer-allow.example", PROD: true }));
    expect(allowedHosts()).toEqual(expect.arrayContaining(["relayer-allow.example", "gateway.liquify.com"]));
    expect(isStrict()).toBe(true);
  });
});
