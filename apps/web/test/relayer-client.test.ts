// Relayer client (packages/sdk/src/relayer.ts) against a local mock relayer: info, the exact submit body
// (proof, 14 public inputs, 3 payloads, the fee note's opening — never a key), fee margin, and
// error mapping. The relayer service itself is tested in apps/relayer.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { feeForRelayer, relayerInfo, relayerSubmit, relayerStatus, type RelayerInfo } from "@privacy-wallet/sdk/relayer";

const info: RelayerInfo = {
  chainId: 31337, core: "0x5991A2dF15A8F6A256D3Ec51E99254Cd3fb576A9", feeVault: "0x36ffA23fd38Ae93e2b01Aa5fA1570845aDA89469", relayer: "0x000000000000000000000000000000000000beef",
  privacyAddress: "pp1qq", minFeeWei: "2160000000000000", gasPriceWei: "1000000000", gasEstimate: "1800000", feeMarginBps: 2000, requireReadableFeePayload: true, inflight: 0,
};
let server: Server;
let url: string;
let lastBody: any = null;
let mode: "ok" | "reject" = "ok";

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && req.url === "/info") return res.end(JSON.stringify(info));
      if (req.method === "GET" && req.url?.startsWith("/status/")) return res.end(JSON.stringify({ status: "mined", txHash: req.url.slice(8) }));
      if (req.method === "POST" && req.url === "/submit") {
        lastBody = JSON.parse(body);
        if (mode === "reject") { res.statusCode = 400; return res.end(JSON.stringify({ error: "fee 1 wei is below the current minimum", code: "fee_too_low" })); }
        return res.end(JSON.stringify({ txHash: "0x" + "ab".repeat(32), feeWei: lastBody.fee.amount, gas: "1800000", feePayloadReadable: true }));
      }
      res.statusCode = 404; res.end(JSON.stringify({ error: "not found" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("relayer client", () => {
  it("reads the relayer's terms and prices the fee with a margin", async () => {
    const i = await relayerInfo(url);
    expect(i).toEqual(info);
    expect(feeForRelayer(i)).toBe((2_160_000_000_000_000n * 11_000n) / 10_000n);
    expect(feeForRelayer(i, 0)).toBe(2_160_000_000_000_000n);
  });
  it("submits exactly the proof, public inputs, payloads and fee opening, and returns the hash", async () => {
    const req = { proof: ("0x" + "11".repeat(256)) as `0x${string}`, publicInputs: Array.from({ length: 14 }, (_, i) => String(i)), noteData: ["0x" + "01".repeat(169), "0x" + "02".repeat(169), "0x" + "03".repeat(169)] as [`0x${string}`, `0x${string}`, `0x${string}`], fee: { outputIndex: 1 as const, amount: "2376000000000000", noteSecret: "12345" } };
    const r = await relayerSubmit(url, req);
    expect(r.txHash).toBe("0x" + "ab".repeat(32));
    expect(lastBody).toEqual(req);
    expect(JSON.stringify(lastBody)).not.toMatch(/spendKey|privateKey|seed/i);
    expect((await relayerStatus(url, r.txHash)).status).toBe("mined");
  });
  it("surfaces the relayer's refusal with its code so the wallet can fall back", async () => {
    mode = "reject";
    try {
      await expect(relayerSubmit(url, { proof: "0x", publicInputs: [], noteData: ["0x", "0x", "0x"], fee: { outputIndex: 0, amount: "1", noteSecret: "1" } })).rejects.toThrow(/below the current minimum \(fee_too_low\)/);
    } finally {
      mode = "ok";
    }
    await expect(relayerInfo("http://127.0.0.1:9/")).rejects.toThrow();
  });
});
