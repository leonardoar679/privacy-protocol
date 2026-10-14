// ClassicPrivacyRelayer (spec v2.0 §11.3; V5 spec §16; V6 Stage 14): a classic relayer's API as zod schemas — GET /v1/status,
// POST /v1/tornadoWithdraw, GET /v1/jobs/:id with the job states QUEUED / ACCEPTED / SENT / MINED / CONFIRMED / FAILED —
// parsed at the boundary, and a client over an injected fetch. In this pass no classic relayer is called (the devnet
// mock stands in, with its fee and status); the client is what the circuit port will call, and its parsing is tested.
import { z } from "zod";

export const ClassicJobState = z.enum(["QUEUED", "ACCEPTED", "SENT", "MINED", "CONFIRMED", "FAILED"]);
export type ClassicJobState = z.infer<typeof ClassicJobState>;

export const ClassicStatusSchema = z
  .object({
    rewardAccount: z.string(),
    netId: z.number().int(),
    tornadoServiceFee: z.number(),
    instances: z.record(
      z.string(),
      z.object({ instanceAddress: z.record(z.string(), z.string()), tokenAddress: z.string().optional(), symbol: z.string(), decimals: z.number().int() }),
    ),
    health: z.object({ status: z.boolean(), error: z.string().optional() }),
    version: z.string().optional(),
  })
  .passthrough();
export type ClassicStatusResponse = z.infer<typeof ClassicStatusSchema>;

export const ClassicWithdrawRequest = z.object({
  proof: z.string().regex(/^0x[0-9a-fA-F]+$/),
  args: z.tuple([z.string(), z.string(), z.string(), z.string(), z.string(), z.string()]),
  contract: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
});
export type ClassicWithdrawRequest = z.infer<typeof ClassicWithdrawRequest>;

export const ClassicJobSchema = z
  .object({
    id: z.string(),
    type: z.string().optional(),
    status: ClassicJobState,
    txHash: z.string().optional(),
    confirmations: z.number().int().optional(),
    failedReason: z.string().optional(),
  })
  .passthrough();
export type ClassicJob = z.infer<typeof ClassicJobSchema>;

export const parseClassicStatus = (x: unknown): ClassicStatusResponse => ClassicStatusSchema.parse(x);
export const parseClassicJob = (x: unknown): ClassicJob => ClassicJobSchema.parse(x);

/** A relayer the user can choose: its fee (per cent of the pool's denomination) and whether it answers healthy. */
export interface ClassicRelayerChoice {
  id: string;
  name: string;
  feePercent: number;
  status: "online" | "offline" | "unknown";
  /** the relayer's own words when it reports unhealthy */
  error?: string;
}

/** The relayer's status as a choice: GET /v1/status parsed; an answer that does not parse is "unknown", never trusted. */
export async function classicRelayerStatus(url: string, fetchImpl: typeof fetch): Promise<ClassicRelayerChoice> {
  const id = url.replace(/\/$/, "");
  try {
    const r = await fetchImpl(`${id}/v1/status`, { method: "GET" });
    if (!r.ok) return { id, name: new URL(id).host, feePercent: 0, status: "offline", error: `HTTP ${r.status}` };
    const s = parseClassicStatus(await r.json());
    return {
      id,
      name: new URL(id).host,
      feePercent: s.tornadoServiceFee,
      status: s.health.status ? "online" : "offline",
      ...(s.health.error ? { error: s.health.error } : {}),
    };
  } catch (e) {
    return { id, name: id, feePercent: 0, status: "unknown", error: String((e as Error)?.message ?? e).slice(0, 160) };
  }
}

/** POST /v1/tornadoWithdraw: the request checked before it leaves, the job id from the answer. */
export async function classicWithdraw(url: string, req: ClassicWithdrawRequest, fetchImpl: typeof fetch): Promise<{ id: string }> {
  const body = ClassicWithdrawRequest.parse(req);
  const r = await fetchImpl(`${url.replace(/\/$/, "")}/v1/tornadoWithdraw`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = (await r.json()) as { id?: unknown; error?: unknown };
  if (!r.ok || typeof j.id !== "string") throw new Error(`the relayer refused the withdrawal: ${String(j.error ?? r.status)}`);
  return { id: j.id };
}

/** GET /v1/jobs/:id, parsed. */
export async function classicJob(url: string, id: string, fetchImpl: typeof fetch): Promise<ClassicJob> {
  const r = await fetchImpl(`${url.replace(/\/$/, "")}/v1/jobs/${encodeURIComponent(id)}`, { method: "GET" });
  return parseClassicJob(await r.json());
}

/** The devnet's relayer (the mock pool's): what the choice lists in this pass. */
export const DEVNET_RELAYERS: readonly ClassicRelayerChoice[] = [
  { id: "relayer.devnet.local", name: "relayer.devnet.local", feePercent: 0.3, status: "online" },
];
