// The build's environment → the engine's configuration (V6 Stage 3; Privacy Wallet Web spec v2.0 §4). The ONLY module
// of the wallet that reads import.meta.env (lint enforces it): the values are validated here, once, and installed with
// applyConfig() before the first render (main.tsx); every engine module reads them through src/sdk/config.ts. Tests
// install their own with applyConfig(testConfig()) (test/setup.ts).
import { z } from "zod";
import { allowHosts, setStrict } from "./api/transport";
import { deploymentFromEnv } from "./sdk/chain";
import { configure, defaultConfig, DEFAULTS, type SdkConfig } from "./sdk/config";
import { feedsFromEnv } from "./sdk/prices";

type Env = Record<string, string | boolean | undefined>;

const list = (v: string | undefined): string[] =>
  String(v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const url = z.string().url();
const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "a 32-byte hex value");
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "an address");
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

/** The variables the wallet reads, each optional, each checked when present. */
const EnvSchema = z.object({
  VITE_RPC_URLS: z.string().optional(),
  VITE_RPC_URL: z.string().optional(),
  VITE_RELAYER_URL: url.optional(),
  VITE_RELAYER_URLS: z.string().optional(),
  VITE_SWAP_SERVICE: url.optional(),
  VITE_BEACON_URLS: z.string().optional(),
  VITE_LC_CHECKPOINT: hex32.optional(),
  VITE_THORNODE_URLS: z.string().optional(),
  VITE_THORNODE_QUORUM: int(1, 16).optional(),
  VITE_THORCHAIN_ROUTER: address.optional(),
  VITE_WC_PROJECT_ID: z.string().min(1).optional(),
  VITE_ARTIFACT_BASE: z.string().min(1).optional(),
  VITE_HOLD_MS: int(1, 60_000).optional(),
  VITE_REVIEW_HOLD_MINUTES: int(1, 24 * 60).optional(),
  VITE_KDF_LOG2N: int(12, 20).optional(),
});

/** The configuration a build's environment describes (throws, naming the variable, on a malformed value). */
export function configFromEnv(raw: Env): SdkConfig {
  const strings: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === "string" && v !== "") strings[k] = v;
  const parsed = EnvSchema.safeParse(strings);
  if (!parsed.success) throw new Error(`the wallet's environment: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const e = parsed.data;
  for (const u of [...list(e.VITE_RPC_URLS ?? e.VITE_RPC_URL), ...list(e.VITE_RELAYER_URLS), ...list(e.VITE_BEACON_URLS), ...list(e.VITE_THORNODE_URLS)]) {
    if (!url.safeParse(u).success) throw new Error(`the wallet's environment: "${u}" is not a URL`);
  }
  const relayers = list(e.VITE_RELAYER_URLS);
  return defaultConfig({
    deployment: deploymentFromEnv(strings),
    relayer: { url: e.VITE_RELAYER_URL ?? relayers[0] ?? DEFAULTS.relayerUrl, fallbacks: relayers },
    swapService: e.VITE_SWAP_SERVICE ?? DEFAULTS.swapService,
    beaconUrls: list(e.VITE_BEACON_URLS),
    ...(e.VITE_LC_CHECKPOINT ? { lcCheckpoint: e.VITE_LC_CHECKPOINT as `0x${string}` } : {}),
    thornode: {
      gateways: e.VITE_THORNODE_URLS ? list(e.VITE_THORNODE_URLS) : [...DEFAULTS.thornodeGateways],
      quorum: e.VITE_THORNODE_QUORUM ?? DEFAULTS.thornodeQuorum,
    },
    ...(e.VITE_THORCHAIN_ROUTER ? { thorchainRouter: e.VITE_THORCHAIN_ROUTER } : {}),
    ...(e.VITE_WC_PROJECT_ID ? { walletConnectProjectId: e.VITE_WC_PROJECT_ID } : {}),
    artifactBase: e.VITE_ARTIFACT_BASE ?? DEFAULTS.artifactBase,
    priceFeeds: feedsFromEnv(strings),
    holdMs: e.VITE_HOLD_MS ?? DEFAULTS.holdMs,
    reviewHoldMinutes: e.VITE_REVIEW_HOLD_MINUTES ?? DEFAULTS.reviewHoldMinutes,
    ...(e.VITE_KDF_LOG2N ? { kdfLog2N: e.VITE_KDF_LOG2N } : {}),
    production: raw.PROD === true || raw.PROD === "true",
    // the hosts the build names: the transport's allowlist (spec §7), exactly the variables the V5 transport read
    hosts: [
      e.VITE_RPC_URLS,
      e.VITE_RPC_URL,
      e.VITE_RELAYER_URL,
      e.VITE_RELAYER_URLS,
      e.VITE_SWAP_SERVICE,
      e.VITE_BEACON_URLS,
      e.VITE_THORNODE_URLS,
      e.VITE_ARTIFACT_BASE,
    ].flatMap(list),
  });
}

/** Installs a configuration: the engine's, the transport's allowlist (with the THORNode gateways) and its strictness. */
export function applyConfig(c: SdkConfig): SdkConfig {
  configure(c);
  allowHosts(...c.hosts, ...c.thornode.gateways);
  setStrict(c.production);
  return c;
}

const env = (import.meta as unknown as { env?: Env }).env ?? {};

/** The build's own configuration, installed (main.tsx, before the first render). */
export const configureFromBuild = (): SdkConfig => applyConfig(configFromEnv(env));

/** A dev build (the component gallery's route). */
export const DEV_BUILD = env.DEV === true || env.DEV === "true";

/** The configuration of the test suites: no deployment, a cheap scrypt, a short hold (test/setup.ts). */
export const testConfig = (overrides: Partial<SdkConfig> = {}): SdkConfig => defaultConfig({ holdMs: 40, kdfLog2N: 12, ...overrides });
