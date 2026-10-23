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
  if (e instanceof SwapJobError || e instanceof ShieldJobError)
    return { status: e.code === "capacity" ? 503 : 400, body: { error: redactUrls(e.message), code: e.code } };
  return { status: 500, body: { error: "internal error", code: "internal" } };
}

/**
 * GET /status/:txHash: where a submission stands, and nothing of what it paid (a V6 follow-up of 2026-10-16). The job holds the
 * fee note's opening — its amount, secret, vault and output — and transaction hashes are public, so anyone could read what
 * every relayed spend paid, and from a percentage fee what it moved. The submitter got its fee in the submit answer.
 */
export function statusAnswer(job: {
  txHash: string;
  status: string;
  submittedAt: number;
  gasUsed?: string;
  actualNetworkWei?: string;
  droppedAt?: number;
  blockNumber?: string;
}): { txHash: string; status: string; submittedAt: number; gasUsed?: string; actualNetworkWei?: string; droppedAt?: number; blockNumber?: string } {
  return {
    txHash: job.txHash,
    status: job.status,
    submittedAt: job.submittedAt,
    ...(job.gasUsed !== undefined ? { gasUsed: job.gasUsed } : {}),
    ...(job.actualNetworkWei !== undefined ? { actualNetworkWei: job.actualNetworkWei } : {}),
    ...(job.droppedAt !== undefined ? { droppedAt: job.droppedAt } : {}),
    ...(job.blockNumber !== undefined ? { blockNumber: job.blockNumber } : {}),
  };
}

/**
 * GET /info: the fee terms, and what this relayer runs for (a V6 follow-up of 2026-10-16) — the deployment's swap and shield
 * factories when set, and the swap service's addresses whose vouches it accepts (API_VOUCHER, lowercased; empty: it runs no
 * swaps). An operator rotating the API's key checks here that every relayer lists the new address before the API signs
 * with it, and the API's status reads it (docs/deployment.md).
 */
export function infoAnswer<T extends object>(
  terms: T,
  o: { swapFactory: string | null; shieldFactory: string | null; vouchers: readonly string[] },
): T & { swapFactory?: string; shieldFactory?: string; vouchers: string[] } {
  return {
    ...terms,
    ...(o.swapFactory ? { swapFactory: o.swapFactory } : {}),
    ...(o.shieldFactory ? { shieldFactory: o.shieldFactory } : {}),
    vouchers: o.vouchers.map((v) => v.toLowerCase()),
  };
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
