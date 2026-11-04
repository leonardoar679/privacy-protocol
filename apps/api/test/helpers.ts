// The API's test harness: a deterministic engine (one stub adapter that quotes, prepares and tracks), an in-memory
// database, scripted reads (the relayer's job, the escrow's balance, the provider's track), the log captured line by
// line, and the app listening on an ephemeral port.
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { BYTECODE } from "@privacy-wallet/contracts";
import { createLogger } from "@privacy-wallet/server-kit";
import { PrivateSwapEngine } from "@privacy-wallet/swap-engine/engine";
import { orderSignerAddress, predictEscrow, restoreDigest, restoreRequestText, signExecution } from "@privacy-wallet/swap-engine/endpoints";
import { NO_VALUER } from "@privacy-wallet/swap-engine/valuation";
import type { Capabilities, Health, Ingress, ProviderAdapter, ProviderId, Quote, QuoteRequest, TrackStatus } from "@privacy-wallet/swap-engine/types";
import { createApp } from "../src/app";
import type { SwapApiDeps } from "../src/routes/swap";
import { openDb } from "../src/db";
import type { RelayerTerms } from "../src/quote";
import type { RelayerJobView } from "../src/reconcile";
import { Store } from "../src/store";
import { makeVoucher } from "../src/vouch";

export const ETH = { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" } as const;
export const BTC = { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" } as const;
export const DEST = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
export const ORDER_KEY = new Uint8Array(32).fill(7);
export const ORDER_SIGNER = orderSignerAddress(ORDER_KEY);
export const REFUND_SECRET = "987654321987654321";
export const TIP = 25n * 10n ** 14n;
/** the engine's SwapOrderFactory */
export const FACTORY = "0x00000000000000000000000000000000000000f1";
/** a same-chain swap into the protected balance (spec v2.0 §11.2): the token, its vault, the receiver factory, the shield tip */
export const USDC = { chain: "ethereum", asset: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", decimals: 6, symbol: "USDC" } as const;
export const USDC_VAULT = "0x00000000000000000000000000000000000000e8";
export const SHIELD_FACTORY = "0x00000000000000000000000000000000000000f2";
export const SHIELD_TIP = 30_000n;

export class StubAdapter implements ProviderAdapter {
  readonly implemented = true;
  track_: TrackStatus = { state: "pending" };
  /** its output in percent of the default (the divergence tests move it between the commit and the prepare) */
  scale = 100n;
  /** whether its minimum is readable here (false: filtered under a strict policy) */
  verified = true;
  constructor(readonly id: ProviderId = "thorchain") {}
  capabilities(): Capabilities {
    return {
      routes: ["A", "B", "C", "D", "E"],
      ingress: ["contract-call"],
      nativeAssets: true,
      atomic: false,
      chains: ["ethereum", "bitcoin"],
      sameChain: true, // a swap into the protected balance stays on its chain (the vouch tests)
      destinationLinkPublic: true,
      linkEvidence: "stub: the memo names the destination",
    };
  }
  async quote(req: QuoteRequest): Promise<Quote> {
    const out = ((req.amount / 30n / 10n ** 10n) * this.scale) / 100n;
    return {
      provider: this.id,
      category: "A",
      toAmount: out,
      toAmountMin: (out * 99n) / 100n,
      fees: [],
      etaSeconds: 600,
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      nativeAssets: true,
      minOutEncoded: true,
      minOutVerified: this.verified,
      hops: [],
      raw: {},
      obtainedAt: Date.now(),
    };
  }
  async prepareIngress(req: QuoteRequest): Promise<Ingress> {
    return {
      kind: "contract-call",
      to: "0x00000000000000000000000000000000000000ee",
      calldata: "0x1234",
      value: req.amount,
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      minOutEncoded: true,
    };
  }
  async track(): Promise<TrackStatus> {
    return this.track_;
  }
  async health(): Promise<Health> {
    return { provider: this.id, reachable: true, apiLatencyMs: 1, halted: false, haltedChains: [], checkedAt: Date.now() };
  }
}

export interface Scripted {
  job: RelayerJobView | "none" | null;
  balance: bigint | null;
}

export interface Harness {
  url: string;
  store: Store;
  adapter: StubAdapter;
  lines: string[];
  script: Scripted;
  clock: { now: number };
  /** what the app was built on: a test may build its own SwapApi over the same store */
  deps: SwapApiDeps;
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any; headers: Headers }>;
  get(path: string, headers?: Record<string, string>): Promise<{ status: number; body: any; headers: Headers }>;
  close(): Promise<void>;
}

export async function harness(
  o: {
    ratePerMinute?: number;
    origins?: string[];
    tls?: boolean;
    trustProxyHops?: number;
    terms?: RelayerTerms | null;
    gatewayUpstream?: string;
    vouchKey?: `0x${string}`;
    /** API_VOUCHER_PREVIOUS: the former keys' addresses whose commit vouches still count */
    previousVouchers?: `0x${string}`[];
    /** a same-chain swap into the protected balance: the token's vault, a shield tip, the receiver factory (or `shieldFactory`) */
    protectedDestinations?: boolean;
    shieldFactory?: string | null;
    /** more stub providers beside the default thorchain one */
    extraAdapters?: StubAdapter[];
    /** the engine's EngineConfig.poolAssets (unset: not checked) */
    poolAssets?: Record<string, { symbol: string; decimals: number }>;
    /** the tip source's price (unset: TIP) */
    tipFor?: (from: unknown, amount: bigint) => Promise<bigint>;
    /** a database file instead of memory (the at-rest tests) */
    dbPath?: string;
    /** MAX_OPEN_OPERATIONS (unset: the default) */
    maxOpenOperations?: number;
    /** COMMITS_PER_MINUTE and its burst (unset: no budget a test meets) */
    commitsPerMinute?: number;
    commitBurst?: number;
  } = {},
): Promise<Harness> {
  const lines: string[] = [];
  const log = createLogger((l) => lines.push(l));
  const clock = { now: Date.now() };
  const store = new Store(openDb(o.dbPath ?? ":memory:"), log, () => clock.now);
  const adapter = new StubAdapter();
  const engine = new PrivateSwapEngine({
    adapters: [adapter, ...(o.extraAdapters ?? [])],
    factory: FACTORY,
    escrowCreationCode: BYTECODE.swapOrderEscrow,
    chainId: 1n,
    refundVaults: { native: "0x00000000000000000000000000000000000000e7", ...(o.protectedDestinations ? { [USDC.asset]: USDC_VAULT } : {}) },
    tips: { tipFor: o.tipFor ?? (async () => TIP), ...(o.protectedDestinations ? { shieldTipFor: async () => SHIELD_TIP } : {}) },
    refundWindowSeconds: 7200,
    valuer: NO_VALUER,
    ...(o.poolAssets ? { poolAssets: o.poolAssets } : {}),
  });
  store.seedProviders(["thorchain", ...(o.extraAdapters ?? []).map((a) => a.id)]);
  const script: Scripted = { job: "none", balance: 0n };
  const deps: SwapApiDeps = {
    engine,
    store,
    gateway: { upstream: o.gatewayUpstream ?? null },
    now: () => clock.now,
    relayerTerms: async () => o.terms ?? null,
    voucher: o.vouchKey ? makeVoucher(o.vouchKey, o.previousVouchers) : null,
    shieldFactory: o.shieldFactory !== undefined ? o.shieldFactory : o.protectedDestinations ? SHIELD_FACTORY : null,
    reads: { job: async () => script.job, escrowBalance: async () => script.balance, track: async () => adapter.track_ },
    ...(o.maxOpenOperations !== undefined ? { maxOpenOperations: o.maxOpenOperations } : {}),
  };
  const app = createApp(deps, {
    origins: new Set(o.origins ?? ["http://localhost:5173"]),
    tls: o.tls ?? false,
    ratePerMinute: o.ratePerMinute ?? 10_000,
    trustProxyHops: o.trustProxyHops,
    commitsPerMinute: o.commitsPerMinute ?? 1_000_000,
    ...(o.commitBurst !== undefined ? { commitBurst: o.commitBurst } : {}),
    log,
  });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const answer = async (r: Response) => ({
    status: r.status,
    body: r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text(),
    headers: r.headers,
  });
  return {
    url,
    store,
    adapter,
    lines,
    script,
    clock,
    deps,
    post: async (path, body, headers = {}) =>
      answer(
        await fetch(url + path, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: typeof body === "string" ? body : JSON.stringify(body),
        }),
      ),
    get: async (path, headers = {}) => answer(await fetch(url + path, { headers })),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** A swap request as the wallet sends it. */
export const swapRequest = (over: Record<string, unknown> = {}) => ({
  from: ETH,
  to: BTC,
  amount: (10n ** 18n).toString(),
  destination: DEST,
  slippageBps: 50,
  policy: "best-privacy",
  ...over,
});

/** The commit body: the request, the one-time signer and the refund note's commitment. */
export const orderBody = (over: Record<string, unknown> = {}) => ({
  ...swapRequest(),
  orderSigner: ORDER_SIGNER,
  refundOwnerCommitment: "1234567890",
  refundNoteSecret: REFUND_SECRET,
  refundNoteDataHash: "0x" + "ab".repeat(32),
  ...over,
});

export const sign = (digest: `0x${string}`): `0x${string}` => signExecution(ORDER_KEY, digest);

/** The escrow a body's params determine at the harness's factory, as the API recomputes it. */
export const escrowOf = (p: Record<string, unknown>): string =>
  predictEscrow(FACTORY, BYTECODE.swapOrderEscrow, {
    ...p,
    assetType: Number(p.assetType),
    amount: BigInt(p.amount as string),
    executeDeadline: Number(p.executeDeadline),
    refundAfter: Number(p.refundAfter),
    refundOwnerCommitment: BigInt(p.refundOwnerCommitment as string),
    refundNoteSecret: BigInt(p.refundNoteSecret as string),
    executorTip: BigInt(p.executorTip as string),
  } as never);

/** A restore's body signed by the order's key (or another) over the request it names, as the wallet signs its journaled one (audit round 2, r05). */
export const signedRestore = <T extends { params: Record<string, unknown> }>(body: T, key: Uint8Array = ORDER_KEY): T & { restoreSignature: `0x${string}` } => {
  const b = body as unknown as Record<string, unknown>;
  const side = (x: unknown) => x as { chain: string; asset: string };
  const text = restoreRequestText({ from: side(b.from), to: side(b.to), destination: String(b.destination ?? ""), provider: String(b.provider ?? "") });
  return { ...body, restoreSignature: signExecution(key, restoreDigest(1n, escrowOf(body.params), text)) };
};
