// The words of an error that leave a service keep a URL's host and lose its key (a V6 follow-up of 2026-10-15: a viem
// error, which the API and the relayer answered with, carries the whole RPC URL — the key in its path — and the request).
import { describe, expect, it } from "vitest";
import { redactUrls } from "../src/redact";

describe("redactUrls", () => {
  it("a viem error keeps the RPC's host, never its key", () => {
    const viem = 'HTTP request failed.\n\nURL: https://eth-mainnet.g.alchemy.com/v2/SECRET-KEY-123\nRequest body: {"method":"eth_gasPrice"}';
    const out = redactUrls(viem);
    expect(out).toContain("URL: https://eth-mainnet.g.alchemy.com/…\n");
    expect(out).not.toContain("SECRET-KEY-123");
  });
  it("credentials, ports, queries and fragments go; the sentence around them stays", () => {
    expect(redactUrls("from https://user:pass@rpc.example:8545/path?key=abc#x.")).toBe("from https://rpc.example:8545/….");
    expect(redactUrls("see https://gateway.liquify.com/chain/thorchain_api, then https://rest.cosmos.directory/thorchain")).toBe(
      "see https://gateway.liquify.com/…, then https://rest.cosmos.directory/…",
    );
    expect(redactUrls("wss://node.example/ws/KEY and http://127.0.0.1:8545")).toBe("wss://node.example/… and http://127.0.0.1:8545");
    expect(redactUrls("(https://api.example/v1/quote?apiKey=K)")).toBe("(https://api.example/…)");
  });
  it("text without a URL is unchanged", () => {
    for (const t of ["fee 12 is below the minimum 30", "THORNode quorum not reached: 1/2 gateways answered for ETH", ""]) expect(redactUrls(t)).toBe(t);
  });
});
