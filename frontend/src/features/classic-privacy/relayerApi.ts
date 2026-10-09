// The classic relayer API as zod schemas (spec §16): GET /v1/status, POST /v1/tornadoWithdraw, GET /v1/jobs/:id with
// the job states QUEUED / ACCEPTED / SENT / MINED / CONFIRMED / FAILED. Parsed at the boundary; nothing here is
// called in this pass (the mock pool stands in for the relayer).
import { z } from "zod";

export const ClassicJobState = z.enum(["QUEUED", "ACCEPTED", "SENT", "MINED", "CONFIRMED", "FAILED"]);
export type ClassicJobState = z.infer<typeof ClassicJobState>;

export const ClassicStatusSchema = z.object({
  rewardAccount: z.string(),
  netId: z.number().int(),
  tornadoServiceFee: z.number(),
  instances: z.record(z.string(), z.object({ instanceAddress: z.record(z.string(), z.string()), tokenAddress: z.string().optional(), symbol: z.string(), decimals: z.number().int() })),
  health: z.object({ status: z.boolean(), error: z.string().optional() }),
  version: z.string().optional(),
}).passthrough();
export type ClassicStatusResponse = z.infer<typeof ClassicStatusSchema>;

export const ClassicWithdrawRequest = z.object({
  proof: z.string().regex(/^0x[0-9a-fA-F]+$/),
  args: z.tuple([z.string(), z.string(), z.string(), z.string(), z.string(), z.string()]),
  contract: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
});
export type ClassicWithdrawRequest = z.infer<typeof ClassicWithdrawRequest>;

export const ClassicJobSchema = z.object({ id: z.string(), type: z.string().optional(), status: ClassicJobState, txHash: z.string().optional(), confirmations: z.number().int().optional(), failedReason: z.string().optional() }).passthrough();
export type ClassicJob = z.infer<typeof ClassicJobSchema>;

export const parseClassicStatus = (x: unknown): ClassicStatusResponse => ClassicStatusSchema.parse(x);
export const parseClassicJob = (x: unknown): ClassicJob => ClassicJobSchema.parse(x);
