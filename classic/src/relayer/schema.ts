// The relayer protocol's shapes (spec v3.0 §7.5; the compatibility matrix §4), parsed at the boundary with zod: GET
// /v1/status as tornado-relayer 4.x and 5.x answer it (health.status is the STRING "true" or "false" from Redis — the
// former in-app schema wanted a boolean and would have refused every real relayer; both forms are read), GET /v1/jobs/:id
// with the seven states including RESUBMITTED, and the withdrawal request exactly as the relayer's own validator accepts
// it (bytes32 strings for root, nullifier hash, fee and refund; addresses for the recipient and the relayer; nothing else).
import { z } from "zod";

export const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
export const PROOF = /^0x[0-9a-fA-F]{512}$/;
const address = z.string().regex(ADDRESS);
const bytes32 = z.string().regex(BYTES32);

const HealthSchema = z.object({ status: z.union([z.literal("true"), z.literal("false"), z.boolean()]), error: z.string().optional().nullable() }).passthrough();

export const RelayerStatusSchema = z
  .object({
    rewardAccount: address,
    netId: z.number().int(),
    /** a percent: 0.3 means 0.3 % */
    tornadoServiceFee: z.number().min(0).max(20),
    miningServiceFee: z.number().optional(),
    instances: z
      .object({
        eth: z.object({ instanceAddress: z.record(z.string(), address), decimals: z.number().optional(), symbol: z.string().optional() }).passthrough(),
      })
      .passthrough(),
    version: z.string(),
    health: HealthSchema,
    currentQueue: z.number().optional(),
    ethPrices: z.record(z.string(), z.string()).optional(),
    latestBlock: z.number().optional(),
  })
  .passthrough();
export type RelayerStatus = z.infer<typeof RelayerStatusSchema>;

export const JOB_STATES = ["QUEUED", "ACCEPTED", "SENT", "MINED", "RESUBMITTED", "CONFIRMED", "FAILED"] as const;
export type JobState = (typeof JOB_STATES)[number];

export const RelayerJobSchema = z
  .object({
    id: z.string(),
    type: z.string().optional(),
    status: z.enum(JOB_STATES),
    txHash: bytes32.optional().nullable(),
    confirmations: z.number().optional().nullable(),
    failedReason: z.string().optional().nullable(),
    contract: address.optional(),
    args: z.array(z.string()).optional(),
  })
  .passthrough();
export type RelayerJob = z.infer<typeof RelayerJobSchema>;

/** What leaves the device: the proof, the pool, the six arguments — nothing else (the relayer refuses extra properties). */
export const WithdrawRequestSchema = z
  .object({
    proof: z.string().regex(PROOF),
    contract: address,
    args: z.tuple([bytes32, bytes32, address, address, bytes32, bytes32]),
  })
  .strict();
export type WithdrawRequest = z.infer<typeof WithdrawRequestSchema>;

export const parseStatus = (x: unknown): RelayerStatus => RelayerStatusSchema.parse(x);
export const parseJob = (x: unknown): RelayerJob => RelayerJobSchema.parse(x);
export const isHealthy = (status: RelayerStatus): boolean => status.health.status === "true" || status.health.status === true;
export const isTerminal = (state: JobState): boolean => state === "CONFIRMED" || state === "FAILED";
