// The Classic app's configuration (spec v3.0 §7.7–§7.8): the only reader of the build's environment. Everything else
// calls config(). A production build pins the chain, the RPC endpoints, the relayers, where the history snapshots and
// the proving artifacts are served, and which pool functions are live; a malformed value is refused by name.
import { z } from "zod";

export type PoolId = "eth-0.1" | "eth-1" | "eth-10" | "eth-100";
export type PoolFunction = "deposit" | "withdraw";
export const POOL_IDS: readonly PoolId[] = ["eth-0.1", "eth-1", "eth-10", "eth-100"];
const FUNCTIONS: readonly PoolFunction[] = ["deposit", "withdraw"];

export interface ClassicConfig {
  /** Ethereum mainnet; the pools exist nowhere else (spec v3.0 §7.2) */
  chainId: number;
  rpcUrls: string[];
  relayerUrls: string[];
  /** where the history snapshots are served (spec v3.0 §7.4) */
  dataBase: string;
  /** where the proving artifacts are served (spec v3.0 §7.3) */
  artifactBase: string;
  /** CLASSIC_LIVE: the pool functions that may send a transaction; everything else shows "Not connected" (spec v3.0 §7.7) */
  live: Partial<Record<PoolId, readonly PoolFunction[]>>;
  /** the original's compliance behaviour behind switches, off until the owner's legal review (spec v3.0 §7.7) */
  complianceOracle: boolean;
  geofence: boolean;
  production: boolean;
  /** the path the app is served under (Vite's base) */
  base: string;
  /** the address the withdraw tab's "Donate" fills in (the original offered its project's); null hides the button */
  donationAddress: `0x${string}` | null;
}

const list = (s: unknown): string[] =>
  String(s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
const flag = z.enum(["0", "1"]).optional();

/** `VITE_CLASSIC_LIVE`: a JSON object of pool id → functions, e.g. {"eth-1":["withdraw"]}; absent or empty = nothing live. */
export function parseLive(text: unknown): ClassicConfig["live"] {
  if (text === undefined || text === null || String(text).trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(text));
  } catch {
    throw new Error("VITE_CLASSIC_LIVE is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("VITE_CLASSIC_LIVE must be an object of pool id to functions");
  const out: Partial<Record<PoolId, PoolFunction[]>> = {};
  for (const [pool, fns] of Object.entries(parsed as Record<string, unknown>)) {
    if (!POOL_IDS.includes(pool as PoolId)) throw new Error(`VITE_CLASSIC_LIVE names an unknown pool: ${pool}`);
    if (!Array.isArray(fns) || !fns.every((f) => FUNCTIONS.includes(f as PoolFunction)))
      throw new Error(`VITE_CLASSIC_LIVE: ${pool} must list deposit and/or withdraw`);
    out[pool as PoolId] = [...new Set(fns as PoolFunction[])];
  }
  return out;
}

export const EnvSchema = z.object({
  VITE_CLASSIC_CHAIN_ID: z.string().regex(/^\d+$/).optional(),
  VITE_CLASSIC_RPC_URLS: z.string().optional(),
  VITE_CLASSIC_RELAYER_URLS: z.string().optional(),
  VITE_CLASSIC_DATA_BASE: z.string().optional(),
  VITE_CLASSIC_ARTIFACT_BASE: z.string().optional(),
  VITE_CLASSIC_LIVE: z.string().optional(),
  VITE_CLASSIC_COMPLIANCE_ORACLE: flag,
  VITE_CLASSIC_GEOFENCE: flag,
  VITE_CLASSIC_DONATION_ADDRESS: z
    .string()
    .regex(/^(0x[0-9a-fA-F]{40})?$/, "VITE_CLASSIC_DONATION_ADDRESS must be a 0x address of 40 hex digits")
    .optional(),
  PROD: z.boolean().optional(),
  BASE_URL: z.string().optional(),
});

/** The configuration of a build's environment (pure; the tests call it with their own values). */
export function configFromEnv(env: Record<string, unknown>): ClassicConfig {
  const e = EnvSchema.parse(env);
  const base = e.BASE_URL ?? "/classic/";
  return {
    chainId: Number(e.VITE_CLASSIC_CHAIN_ID ?? "1"),
    rpcUrls: list(e.VITE_CLASSIC_RPC_URLS),
    relayerUrls: list(e.VITE_CLASSIC_RELAYER_URLS),
    dataBase: e.VITE_CLASSIC_DATA_BASE ?? `${base}data`,
    artifactBase: e.VITE_CLASSIC_ARTIFACT_BASE ?? `${base}artifacts`,
    live: parseLive(e.VITE_CLASSIC_LIVE),
    complianceOracle: e.VITE_CLASSIC_COMPLIANCE_ORACLE === "1",
    geofence: e.VITE_CLASSIC_GEOFENCE === "1",
    production: e.PROD === true,
    base,
    donationAddress: e.VITE_CLASSIC_DONATION_ADDRESS ? (e.VITE_CLASSIC_DONATION_ADDRESS as `0x${string}`) : null,
  };
}

let current: ClassicConfig | null = null;
/** The running build's configuration, read once from the environment. */
export function config(): ClassicConfig {
  return (current ??= configFromEnv(import.meta.env as unknown as Record<string, unknown>));
}
/** The tests' way in. */
export function applyConfig(c: ClassicConfig): void {
  current = c;
}
/** Whether a pool function may send a transaction in this build. */
export const isLive = (c: ClassicConfig, pool: PoolId, fn: PoolFunction): boolean => (c.live[pool] ?? []).includes(fn);
