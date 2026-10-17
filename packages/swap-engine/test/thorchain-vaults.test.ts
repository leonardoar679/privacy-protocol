// THORChain moves its inbound vault between its active vaults several times an hour (the public gateways, sampled on
// 2026-10-14: a move between two quotes of a local stack run, then two more in six minutes, one of them 13 seconds long).
// A quote's vault is checked by a quorum of THORNode gateways before the API builds the escrow's deposit: the vault
// they suggest, or another one every gateway that answers lists as active; the router they all agree on, and pinned.
// Offline: the gateways answer through a stubbed fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeVaultQuorum,
  inboundQuorum,
  quorumFrom,
  ThorchainAdapter,
  THORCHAIN_ROUTER_ETHEREUM,
  THORNODE_QUORUM,
  THORNODE_URLS,
  gatewaysOnce,
} from "../src/adapters/thorchain";
import type { AssetRef, Quote, QuoteRequest } from "../src/types";

const V1 = "0x718f6c9df785bc4e323086de024ca822efbe8ab9";
const V2 = "0x46f3fb8c14006268d153b18000495c8ee858e94b";
const RETIRING = "0x587c7c3ba9e47b1afd9da9a79c127ade753ac53a";
const ATTACKER = "0x000000000000000000000000000000000000bad1";
const ESCROW = "0x00000000000000000000000000000000000e5c00";
const ETH: AssetRef = { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" };
const BTC: AssetRef = { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" };

describe("each gateway once (the audit's unverified m25)", () => {
  it("a gateway named again — another case, a trailing slash — counts once toward the quorum", () => {
    expect(gatewaysOnce(["https://gw.example/thor/", undefined, "https://GW.example/thor", "https://other.example", " "])).toEqual([
      "https://gw.example/thor",
      "https://other.example",
    ]);
    expect(new Set(THORNODE_URLS.map((u) => u.toLowerCase())).size).toBe(THORNODE_URLS.length);
  });
});

/** what each gateway answers, in THORNODE_URLS order */
interface Gateway {
  inbound?: string;
  router?: string;
  active?: string[];
  down?: boolean;
  halted?: boolean;
}
let gateways: Gateway[] = [];
const asked: string[] = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  gateways = THORNODE_URLS.map(() => ({}));
  asked.length = 0;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    asked.push(url);
    const g = gateways[THORNODE_URLS.findIndex((b) => url.startsWith(b + "/"))];
    if (!g || g.down) throw new TypeError("fetch failed");
    if (url.endsWith("/thorchain/inbound_addresses"))
      return Response.json([
        { chain: "BTC", address: "bc1qvault", halted: false },
        { chain: "ETH", address: g.inbound ?? V1, router: g.router ?? THORCHAIN_ROUTER_ETHEREUM, halted: !!g.halted },
      ]);
    if (url.endsWith("/thorchain/vaults/asgard"))
      return Response.json([
        ...(g.active ?? [V1, V2]).map((address) => ({
          status: "ActiveVault",
          addresses: [
            { chain: "BTC", address: "bc1qvault" },
            { chain: "ETH", address },
          ],
        })),
        { status: "RetiringVault", addresses: [{ chain: "ETH", address: RETIRING }] },
      ]);
    return new Response("not here", { status: 404 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
const every = (g: Gateway) => THORNODE_URLS.map(() => ({ ...g }));

describe("THORChain's inbound vault on the move, at the API (2026-10-14)", () => {
  it("gateways that differ on the vault confirm none and do not fail; a router they differ on fails closed; halted on one is halted", async () => {
    gateways = [{ inbound: V1 }, { inbound: V2 }, { inbound: V1 }];
    await expect(inboundQuorum("ETH")).resolves.toMatchObject({ address: "", agreeing: THORNODE_URLS });
    gateways = [{}, {}, { router: ATTACKER }];
    await expect(inboundQuorum("ETH")).rejects.toThrow(/disagree on the ETH router/);
    gateways = [{}, {}, { halted: true }];
    await expect(inboundQuorum("ETH")).resolves.toMatchObject({ address: V1, halted: true });
    gateways = [{}, { down: true }, { down: true }];
    await expect(inboundQuorum("ETH")).rejects.toThrow(/quorum not reached/);
  });

  it("a vault every answering gateway lists as active is confirmed; one that does not list it, a retiring vault, or too few lists refuse", async () => {
    await expect(activeVaultQuorum("ETH", V2.toUpperCase().replace("0X", "0x"))).resolves.toEqual({ confirmedBy: THORNODE_URLS });
    expect(asked.every((u) => u.endsWith("/thorchain/vaults/asgard"))).toBe(true);
    gateways = [{}, {}, { active: [V1] }];
    await expect(activeVaultQuorum("ETH", V2)).rejects.toThrow(/is not an active ETH vault on https:\/\/thorchain-thornode-lb-1/);
    gateways = every({});
    await expect(activeVaultQuorum("ETH", RETIRING)).rejects.toThrow(/not an active ETH vault/);
    await expect(activeVaultQuorum("ETH", ATTACKER)).rejects.toThrow(/not an active ETH vault/);
    gateways = [{}, { down: true }, { down: true }];
    await expect(activeVaultQuorum("ETH", V1)).rejects.toThrow(/quorum not reached/);
    // a list with no active vault for the chain is no answer, never a refusal
    gateways = [{}, { active: [] }, { active: [] }];
    await expect(activeVaultQuorum("ETH", V1)).rejects.toThrow(/quorum not reached: 1\/2/);
  });

  it("a quote naming the vault THORChain suggested a moment ago is built on it; one naming a vault the gateways do not list is refused", async () => {
    const a = new ThorchainAdapter();
    const req: QuoteRequest = {
      from: ETH,
      to: BTC,
      amount: 10n ** 18n,
      destination: "bc1qdestinationdestinationdestinationdest",
      source: ESCROW,
      slippageBps: 50,
    };
    const quote = (vault: string) =>
      ({
        raw: { inbound_address: vault, router: THORCHAIN_ROUTER_ETHEREUM, memo: "", min1e8: "3000000", expiry: Math.floor(Date.now() / 1000) + 600 },
      }) as unknown as Quote;
    gateways = every({ inbound: V2 });
    const moved = await a.prepareIngress(req, quote(V1));
    expect(moved.kind).toBe("contract-call");
    expect(moved.calldata.toLowerCase()).toContain(V1.slice(2));
    expect(moved.verified?.[0]).toBe(`an active THORChain vault (${THORNODE_URLS.length} gateways agree)`);
    const suggested = await a.prepareIngress(req, quote(V2));
    expect(suggested.verified?.[0]).toBe(`inbound vault (${THORNODE_URLS.length} gateways agree)`);
    await expect(a.prepareIngress(req, quote(ATTACKER))).rejects.toThrow(/not confirmed by the gateway quorum/);
    await expect(a.prepareIngress(req, quote(RETIRING))).rejects.toThrow(/not confirmed by the gateway quorum/);
    // the gateways differ on the suggestion (one a block behind): the quote's vault is looked up in their lists
    gateways = [{ inbound: V1 }, { inbound: V2 }, { inbound: V2 }];
    await expect(a.prepareIngress(req, quote(V1))).resolves.toMatchObject({ kind: "contract-call" });
  });
});

describe("the quorum itself (a V6 follow-up of 2026-10-15)", () => {
  it("is a whole number from 1 to 16, 2 when unset; anything else stops the engine from loading, never one gateway taken for the quorum", () => {
    expect(THORNODE_QUORUM, "unset in the tests").toBe(2);
    expect([quorumFrom(undefined), quorumFrom(""), quorumFrom("1"), quorumFrom("3"), quorumFrom(" 16 ")]).toEqual([2, 2, 1, 3, 16]);
    // a bare Number() read these as NaN or 0, and `answered < NaN` is false for any count of gateways
    for (const bad of ["two", "0", "17", "-1", "1.5", "NaN", "2x"])
      expect(() => quorumFrom(bad), bad).toThrow(/^THORNODE_QUORUM must be a whole number from 1 to 16/);
  });
  it("set to a word, the adapter does not load: it loaded with a NaN quorum and took one gateway's answer for it", async () => {
    vi.resetModules();
    process.env.THORNODE_QUORUM = "two";
    try {
      await expect(import("../src/adapters/thorchain")).rejects.toThrow(/THORNODE_QUORUM must be a whole number from 1 to 16, not "two"/);
    } finally {
      delete process.env.THORNODE_QUORUM;
      vi.resetModules();
    }
  });
});
