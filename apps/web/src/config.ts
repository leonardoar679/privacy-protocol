// The build's environment → the engine's configuration (V6 Stage 3; Privacy Wallet Web spec v2.0 §4). The ONLY module
// of the wallet that reads import.meta.env (lint enforces it): the values are validated here, once, and installed with
// applyConfig() before the first render (main.tsx); every engine module reads them through packages/sdk/src/config.ts. Tests
// install their own with applyConfig(testConfig()) (test/setup.ts).
import { z } from "zod";
import { specForChain } from "@privacy-wallet/sdk/lightclient/spec";
import { allowHosts, setStrict } from "@privacy-wallet/privacy-engine/transport/http";
import { deploymentFromEnv, feedsFromEnv } from "@privacy-wallet/sdk/env";
import { configure, defaultConfig, DEFAULTS, type CoreBackend, type SdkConfig } from "@privacy-wallet/sdk/config";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { secureStore } from "./storage/secureStore";
import { configureWalletConnect } from "@privacy-wallet/wallet-engine/walletConnect";
import { deferDeletion } from "./platform/pendingWipe";

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
  VITE_CLASSIC_URL: z.string().min(1).optional(),
  VITE_ARTIFACT_BASE: z.string().min(1).optional(),
  VITE_HOLD_MS: int(1, 60_000).optional(),
  VITE_REVIEW_HOLD_MINUTES: int(1, 24 * 60).optional(),
  VITE_KDF_LOG2N: int(12, 20).optional(),
  // the deployment's own (audit round 2, r52): a malformed one had read as absent — a VITE_PROTECT_ROUTER typo shipped a build
  // whose every protect went straight into the vault with no fee, and fingerprinted every user's deployment without it; a
  // factory's turned swaps off without a word, and a chain id read as NaN
  VITE_CHAIN_ID: int(1, Number.MAX_SAFE_INTEGER).optional(),
  VITE_CORE: address.optional(),
  VITE_ETH_VAULT: address.optional(),
  VITE_FROM_BLOCK: z.string().regex(/^\d+$/, "a block number").optional(),
  VITE_SWAP_FACTORY: address.optional(),
  VITE_PROTECT_ROUTER: address.optional(),
  VITE_SHIELD_FACTORY: address.optional(),
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
  // the Classic application's place (the fourth review round, 2026-11-03): this origin's /classic/, or its own https origin, nothing else
  if (e.VITE_CLASSIC_URL !== undefined && e.VITE_CLASSIC_URL !== "/classic/" && !/^https:\/\/[^\s/?#]+(?::\d+)?\/(?:[^\s?#]*\/)?$/.test(e.VITE_CLASSIC_URL))
    throw new Error(`the wallet's environment: VITE_CLASSIC_URL must be /classic/ or an https URL ending in /, not "${e.VITE_CLASSIC_URL}"`);
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
    ...(e.VITE_CLASSIC_URL ? { classicUrl: e.VITE_CLASSIC_URL } : {}),
    artifactBase: e.VITE_ARTIFACT_BASE ?? DEFAULTS.artifactBase,
    priceFeeds: feedsFromEnv(strings),
    holdMs: e.VITE_HOLD_MS ?? DEFAULTS.holdMs,
    reviewHoldMinutes: e.VITE_REVIEW_HOLD_MINUTES ?? DEFAULTS.reviewHoldMinutes,
    ...(e.VITE_KDF_LOG2N ? { kdfLog2N: e.VITE_KDF_LOG2N } : {}),
    production: raw.PROD === true || raw.PROD === "true",
    // the hosts the build names: the transport's allowlist (spec §7), exactly the variables the V5 transport read — and the
    // defaults it uses when it names none (the audit round of 2026-10-16, c59: a production build refused its own defaults)
    hosts: [
      e.VITE_RPC_URLS,
      e.VITE_RPC_URL,
      e.VITE_RELAYER_URL,
      e.VITE_RELAYER_URLS,
      e.VITE_SWAP_SERVICE,
      e.VITE_BEACON_URLS,
      e.VITE_THORNODE_URLS,
      e.VITE_ARTIFACT_BASE,
    ]
      .flatMap(list)
      .concat(e.VITE_THORNODE_URLS ? [] : [...DEFAULTS.thornodeGateways])
      .concat(e.VITE_BEACON_URLS ? [] : (specForChain(Number(strings.VITE_CHAIN_ID ?? 31337))?.beaconApis ?? [])),
  });
}

// The crypto client and the prover load with their first call (V6 Stage 16: not in the first route), so a lock can land
// while one loads: the call issued before it then fails as the worker's own requests do ("locked"), and no worker starts
// after the lock with the keys of the session it ended.
let locks = 0;
session.onLock(() => {
  locks += 1;
});
async function loadUnlocked<M>(load: () => Promise<M>): Promise<M> {
  const at = locks;
  const m = await load();
  if (locks !== at) throw new Error("locked");
  return m;
}
const cryptoClient = () => loadUnlocked(() => import("./platform/crypto/client"));

/** The crypto worker's core port, its module loaded at the first call (V6 Stage 16: not in the first route). */
const lazyWorkerCore: CoreBackend = {
  merkleLayers: async (leaves, levels) => (await cryptoClient()).workerCore.merkleLayers(leaves, levels),
  scanNotePayloads: async (viewKey, ownerCommitment, leafIndexes, commitments, payloads) =>
    (await cryptoClient()).workerCore.scanNotePayloads(viewKey, ownerCommitment, leafIndexes, commitments, payloads),
  openNotePayloads: async (viewKey, ownerCommitment, leafIndexes, commitments, payloads) =>
    (await cryptoClient()).workerCore.openNotePayloads!(viewKey, ownerCommitment, leafIndexes, commitments, payloads),
};

/** Installs a configuration: the engine's, the transport's allowlist (with the THORNode gateways) and its strictness. */
export function applyConfig(c: SdkConfig): SdkConfig {
  // the web platform's ports (V6 Stage 4): the IndexedDB container and the worker prover, unless the caller brings its own
  // the prover module is loaded at the first proof (and a test that mocks it is honoured); V6 Stage 15: the prover takes
  // the spend plan, and the core runs in the same long-lived crypto worker where the page has workers
  configure({
    storage: secureStore,
    prover: async (spec, onStatus) => (await loadUnlocked(() => import("./prover/client"))).proveInBrowser(spec, onStatus),
    ...(typeof Worker === "function" ? { core: lazyWorkerCore } : {}),
    ...c,
  });
  configureWalletConnect(c.walletConnectProjectId, { deferDeletion });
  allowHosts(...c.hosts, ...c.thornode.gateways);
  setStrict(c.production);
  return c;
}

const env = (import.meta as unknown as { env?: Env }).env ?? {};

/** The build's own configuration, installed (main.tsx, before the first render). */
export const configureFromBuild = (): SdkConfig => applyConfig(configFromEnv(env));

/** The configuration of the test suites: no deployment, a cheap scrypt, a short hold, no deployment check before an operation (its own suite turns it on; test/setup.ts). */
export const testConfig = (overrides: Partial<SdkConfig> = {}): SdkConfig => defaultConfig({ holdMs: 40, kdfLog2N: 12, deploymentCheck: false, ...overrides });
