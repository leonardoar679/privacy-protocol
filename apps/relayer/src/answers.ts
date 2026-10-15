// What the relayer answers a caller when a request fails (spec v2.0 §15; a V6 follow-up of 2026-10-15). A caller's mistake
// earns its code and its words, every URL in them reduced to its host; anything else is a bare 500. Before, every other
// error's message went to the caller whole — a viem error from the relayer's RPC (a gas price at /info, a read of the
// chain) carries the RPC's URL, and the key in its path, with the request's body — and a body that was not JSON was the
// relayer's own error (500). Nothing is logged here: the request handler logs nothing (test/logs.test.ts).
import { redactUrls } from "@privacy-wallet/server-kit/redact";
import { RelayerError } from "./relayer";
import { ShieldJobError } from "./shieldExecutor";
import { SwapJobError } from "./swapExecutor";

export interface ErrorAnswer {
  status: number;
  body: { error: string; code: string };
}

export function errorAnswer(e: unknown): ErrorAnswer {
  if (e instanceof RelayerError)
    return { status: e.code === "simulation_failed" || e.code === "nullifier_in_flight" ? 409 : 400, body: { error: redactUrls(e.message), code: e.code } };
  if (e instanceof SwapJobError || e instanceof ShieldJobError) return { status: 400, body: { error: redactUrls(e.message), code: e.code } };
  return { status: 500, body: { error: "internal error", code: "internal" } };
}

/** A request's body as JSON, at most `limit` characters; anything else is the caller's mistake. */
export async function readJson(req: AsyncIterable<string | Uint8Array>, limit: number): Promise<unknown> {
  let body = "";
  for await (const chunk of req) {
    body += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (body.length > limit) throw new RelayerError("too_large", "request too large");
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new RelayerError("bad_json", "the body is not JSON");
  }
}
