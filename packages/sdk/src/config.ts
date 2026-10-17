// The engine's configuration (V6 Stage 3; Privacy Wallet Web spec v2.0 §4): every setting the SDK reads, injected once
// by the platform before the first use — apps/web/src/config.ts parses the build's environment into it; a native shell
// will parse its own. Engine modules never read import.meta.env: they call the accessors below, which read the injected
// configuration at the moment of use, so importing any module is inert and a module evaluated before configure() can
// never freeze a stale value. config() before configure() throws.
import type { Hex } from "viem";
import type { FeedSpec } from "@privacy-wallet/protocol/wallet/valuation";
import type { Deployment } from "./chain";
import type { PublicInputs } from "@privacy-wallet/protocol/prover";
import type { TxSpec } from "@privacy-wallet/protocol/txInputs";
import type { KeyValueStorage } from "./wallet/storage";

/** A status line of the proving (shown while the proof is made). */
export type ProveStatus = (message: string) => void;
/** A proof the platform made from a spend plan (the web: the crypto worker over snarkjs, apps/web/src/platform/crypto/). */
export interface ProofResult {
  proof: Hex;
  publicInputs: PublicInputs;
  publicSignals: bigint[];
  ms: number;
  verifiedLocally: boolean;
  /** what the worker found for the proving key and the witness generator */
  pins?: { zkey: string; wasm: string };
}
/**
 * The platform's prover (V6 Stage 15, spec v2.0 §14.3): it takes the spend plan and builds the circuit inputs where it
 * proves — on the web, inside the crypto worker, so the inputs never exist on the main thread.
 */
export type Prover = (spec: TxSpec, onStatus?: ProveStatus) => Promise<ProofResult>;

/** What answered a core call: the Rust core's WASM build, or the TypeScript reference. */
export type CoreEngine = "wasm" | "typescript";
/**
 * The platform's core behind a worker (V6 Stage 15, spec v2.0 §14.3): the two batch calls of the Rust core
 * (packages/sdk/src/core.ts CoreModule), asynchronous, in the core's byte formats, with the engine that answered.
 */
export interface CoreBackend {
  merkleLayers(leaves: Uint8Array, levels: number): Promise<{ out: Uint8Array; engine: CoreEngine }>;
  scanNotePayloads(
    viewKey: Uint8Array,
    ownerCommitment: Uint8Array,
    leafIndexes: Uint32Array,
    commitments: Uint8Array,
    payloads: Uint8Array,
  ): Promise<{ out: Uint8Array; engine: CoreEngine }>;
  /** every payload that opens with the view key (core.ts openNotePayloads; the audit round of 2026-10-16, c18); a platform
   *  without it: the TypeScript reference on the calling thread */
  openNotePayloads?(
    viewKey: Uint8Array,
    ownerCommitment: Uint8Array,
    leafIndexes: Uint32Array,
    commitments: Uint8Array,
    payloads: Uint8Array,
  ): Promise<{ out: Uint8Array; engine: CoreEngine }>;
}

export interface SdkConfig {
  /** the pool this wallet talks to; null when none is configured (the screens say so) */
  deployment: Deployment | null;
  /** the configured relayer and the ones tried when it does not answer (rule 5) */
  relayer: { url: string; fallbacks: string[] };
  /** the swap service (packages/swap-engine's HTTP layer) */
  swapService: string;
  /** beacon APIs for the light client; empty = the spec's public defaults */
  beaconUrls: string[];
  /** a trusted beacon block root to start the light client from */
  lcCheckpoint?: Hex;
  /** THORNode gateways the wallet reads inbound addresses from, and how many must agree */
  thornode: { gateways: string[]; quorum: number };
  /** a THORChain router after an upgrade (the wallet's pin otherwise) */
  thorchainRouter?: string;
  /** WalletConnect's project id: the connector is offered only with one */
  walletConnectProjectId?: string;
  /** where the circuit artifacts are served from */
  artifactBase: string;
  /** a deployment's own price feeds (devnets); null = the table of mainnet and Sepolia */
  priceFeeds: FeedSpec[] | null;
  /** the pointer hold of a confirmation, in ms (tests shorten it; a production build never goes below the default) */
  holdMs: number;
  /** V6 Stage 10 (doc §71): check the deployed contracts before a session's first money operation (deploymentGuard.ts); absent = on, the test configuration turns it off */
  deploymentCheck?: boolean;
  /** the institutional review hold, in minutes (the local stack shortens it; a production build never goes below the default) */
  reviewHoldMinutes: number;
  /** scrypt's cost as log2 N for tests and dev builds (12…20); a production build never goes below the keystore default */
  kdfLog2N?: number;
  /** a production build: the transport refuses hosts outside the allowlist, the prover refuses unpinned artifacts */
  production: boolean;
  /** the hosts the configuration names explicitly — the transport's allowlist (spec §7) */
  hosts: string[];
  /** the platform's store for the encrypted keystore and journal (V6 Stage 4: the engine never imports the platform) */
  storage?: () => KeyValueStorage;
  /** the platform's prover */
  prover?: Prover;
  /** V6 Stage 15: the platform's core behind its crypto worker; absent = the core in this thread (tests, a native shell) */
  core?: CoreBackend;
}

export const DEFAULTS = {
  relayerUrl: "http://127.0.0.1:8790",
  swapService: "http://127.0.0.1:8787",
  thornodeGateways: [
    "https://gateway.liquify.com/chain/thorchain_api",
    "https://rest.cosmos.directory/thorchain",
    "https://thorchain-thornode-lb-1.thorwallet.org",
  ],
  thornodeQuorum: 2,
  artifactBase: "/artifacts",
  holdMs: 1500,
  reviewHoldMinutes: 30,
} as const;

/** A configuration with every default (the local stack's endpoints, no deployment), with overrides. */
export function defaultConfig(overrides: Partial<SdkConfig> = {}): SdkConfig {
  return {
    deployment: null,
    relayer: { url: DEFAULTS.relayerUrl, fallbacks: [] },
    swapService: DEFAULTS.swapService,
    beaconUrls: [],
    thornode: { gateways: [...DEFAULTS.thornodeGateways], quorum: DEFAULTS.thornodeQuorum },
    artifactBase: DEFAULTS.artifactBase,
    priceFeeds: null,
    holdMs: DEFAULTS.holdMs,
    reviewHoldMinutes: DEFAULTS.reviewHoldMinutes,
    production: false,
    hosts: [],
    ...overrides,
  };
}

let current: SdkConfig | null = null;
const listeners = new Set<(c: SdkConfig) => void>();

/** Installs the configuration (the platform calls it once before the first render; tests call it in their setup). */
export function configure(c: SdkConfig): void {
  current = c;
  for (const l of [...listeners]) l(c);
}

/** The configuration; throws before configure() — a module used too early says so instead of reading defaults. */
export function config(): SdkConfig {
  if (!current) throw new Error("the wallet engine is not configured: call configure() first (apps/web/src/config.ts)");
  return current;
}

export const isConfigured = (): boolean => current !== null;

/** Proves a spend plan through the platform's prover (every private spend; the circuit inputs are built there). */
export function prove(spec: TxSpec, onStatus?: ProveStatus): Promise<ProofResult> {
  const p = config().prover;
  if (!p) throw new Error("no prover configured: the platform passes its prover to configure() (apps/web/src/config.ts)");
  return p(spec, onStatus);
}

/** Called on every configure() (the transport refreshes its allowlist from it). */
export function onConfigure(l: (c: SdkConfig) => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
