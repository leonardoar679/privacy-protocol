// What the relayer answers a failed request (a V6 follow-up of 2026-10-15): a caller's mistake its code and words, every
// URL in them reduced to its host; anything else a bare 500. Before, any other error's message went to the caller whole —
// a viem error from the relayer's RPC (the gas price at /info, a read of the chain) names the RPC's URL, its key in the
// path, and the request's body — and a body that was not JSON answered as the relayer's own error.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { errorAnswer, readJson } from "../src/answers";
import { RelayerError } from "../src/relayer";
import { ShieldJobError } from "../src/shieldExecutor";
import { SwapJobError } from "../src/swapExecutor";

const VIEM =
  'HTTP request failed.\n\nURL: https://eth-mainnet.g.alchemy.com/v2/SECRET-KEY-123\nRequest body: {"method":"eth_gasPrice"}\n\nDetails: fetch failed';
async function* chunks(...xs: string[]) {
  for (const x of xs) yield x;
}

describe("the relayer's answer to a failed request", () => {
  it("its own error says nothing of itself: no RPC URL, no key, no request", () => {
    const a = errorAnswer(new Error(VIEM));
    expect(a).toEqual({ status: 500, body: { error: "internal error", code: "internal" } });
    expect(errorAnswer("a thrown string")).toEqual({ status: 500, body: { error: "internal error", code: "internal" } });
  });
  it("a caller's mistake keeps its code and words, its URLs reduced to their host", () => {
    expect(errorAnswer(new RelayerError("simulation_failed", "transact would revert: https://rpc.example/v2/KEY said no"))).toEqual({
      status: 409,
      body: { error: "transact would revert: https://rpc.example/… said no", code: "simulation_failed" },
    });
    expect(errorAnswer(new RelayerError("nullifier_in_flight", "already in flight")).status).toBe(409);
    expect(errorAnswer(new RelayerError("fee_too_low", "fee 1 is below the current minimum 2"))).toEqual({
      status: 400,
      body: { error: "fee 1 is below the current minimum 2", code: "fee_too_low" },
    });
    expect(errorAnswer(new SwapJobError("bad_signature", "invalid signature")).body).toEqual({ error: "invalid signature", code: "bad_signature" });
    expect(errorAnswer(new ShieldJobError("bad_receipt", "a receipt without its params")).status).toBe(400);
  });
  it("a body that is not JSON, or too large, is the caller's mistake", async () => {
    await expect(readJson(chunks('{"a":', "1}"), 100)).resolves.toEqual({ a: 1 });
    await expect(readJson(chunks("{not json"), 100)).rejects.toMatchObject({ code: "bad_json" });
    expect(errorAnswer(await readJson(chunks("{not json"), 100).catch((e) => e))).toEqual({
      status: 400,
      body: { error: "the body is not JSON", code: "bad_json" },
    });
    await expect(readJson(chunks("x".repeat(60), "x".repeat(60)), 100)).rejects.toMatchObject({ code: "too_large" });
  });
  it("the request handler answers every failure through errorAnswer, never an error's own message", () => {
    const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    const handler = server.slice(server.indexOf("createServer("), server.indexOf("server.listen("));
    expect(handler).toContain("errorAnswer(e)");
    expect(handler, "no message taken from an error").not.toMatch(/\.message/);
    expect(handler, "every body read as JSON through readJson").not.toMatch(/JSON\.parse/);
  });
});
