// The eleventh review round (2026-11-04), slice B's fifth critique: Across tracks a deposit by its origin chain's id and its transaction. The
// wallet journals the provider call's target — the SpokePool's address — as the order's reference and sends it beside the transaction; read as
// the origin chain's id, Across answered 400 and every read was "unknown", which keeps an executed order whose rest came back open for good.
import { afterEach, describe, expect, it } from "vitest";
import { AcrossAdapter } from "../src/adapters/across";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const TX = "0x" + "ee".repeat(32);
const SPOKE_POOL = "0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5";

describe("Across's track by the deposit's transaction", () => {
  it("takes the reference as the origin chain only when it is a chain id: the SpokePool's address beside the transaction reads chain 1", async () => {
    const asked: string[] = [];
    globalThis.fetch = (async (url: string | URL) => {
      asked.push(String(url));
      const origin = new URL(String(url)).searchParams.get("originChainId");
      return origin === "1" || origin === "8453"
        ? new Response(JSON.stringify({ status: "expired" }), { status: 200 })
        : new Response(JSON.stringify({ error: "originChainId must be a number" }), { status: 400 });
    }) as typeof fetch;
    const a = new AcrossAdapter();
    expect(await a.track({ sourceTxHash: TX, providerRef: SPOKE_POOL })).toMatchObject({ state: "refunded" });
    expect(new URL(asked[0]).searchParams.get("originChainId")).toBe("1");
    expect(await a.track({ sourceTxHash: TX, providerRef: "8453" }), "a chain id is still the origin").toMatchObject({ state: "refunded" });
    expect(new URL(asked[1]).searchParams.get("originChainId")).toBe("8453");
    expect(await a.track({ sourceTxHash: TX })).toMatchObject({ state: "refunded" });
  });
});
