// The twelfth review round, 2026-11-06, F12-1 and F12-2: the refund target the user reviewed — where a failure refunds, to the protected
// balance through the escrow or at the destination — stays the order's through its commit and every rebuild. A campaign step had been committed
// with no reviewed quote, so the commit-time rule (D11-4: a move toward a refund at the destination refused) never ran for it, and a resume had
// rebuilt an order on a fresh quote that refunded elsewhere. A commit reviewed refunding to the pool now asks the service for that route type
// (one reviewed at the destination asks nothing: a move toward the pool is better), a campaign step's target is its campaign's Review's — through
// a reroute and its requote too —, and the resume carries the journaled target, either one: the tracker reads where a refund went from it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { recoverAddress, type Hex } from "viem";

const answer: { provider: string; refundTarget?: string } = { provider: "mayan", refundTarget: "destination" };
const bodies: Record<string, unknown>[] = [];
const resumed: Record<string, unknown>[] = [];
const quoted: Record<string, unknown>[] = [];
vi.mock("../src/swapService", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/swapService")>();
  return {
    ...real,
    swapService: {
      ...real.swapService,
      order: async (body: Record<string, unknown>) => {
        bodies.push(body);
        return {
          operationId: "op_" + "c".repeat(26),
          order: {
            orderId: ("0x" + "ef".repeat(32)) as Hex,
            params: {
              orderId: "0x" + "ef".repeat(32),
              amount: "1000000000000000000",
              executeDeadline: 2_000_000_000,
              refundAfter: 2_000_007_200,
              executorTip: "0",
            },
            endpoint: "0x00000000000000000000000000000000000e5c02",
            quote: { provider: answer.provider, toAmount: "990", toAmountMin: "980", ...(answer.refundTarget ? { refundTarget: answer.refundTarget } : {}) },
          },
          scores: [],
          status: "Pending",
        };
      },
      resume: async (req: Record<string, unknown>) => {
        resumed.push(req);
        throw new Error("recorded");
      },
      quote: async (req: Record<string, unknown>) => {
        quoted.push(req);
        throw new Error("recorded");
      },
    },
  };
});
vi.mock("../src/swapGuard", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/swapGuard")>()), checkOrder: () => undefined }));
vi.mock("../src/executionCost", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/executionCost")>()),
  tipCeiling: async () => 10n ** 30n,
  shieldTipCeiling: async () => 10n ** 30n,
}));

import { configure, defaultConfig } from "../src/config";
import { memoryStorage } from "../src/wallet/storage";
import { session } from "../src/wallet/session";
import type { Deployment } from "../src/chain";
import type { StoredSwap } from "../src/wallet/journal";
import { defaultIo, reviewedRefundTargetOf } from "../src/wallet/campaignRunner";
import { commitOrder, resumeOrder } from "../src/swapExecute";
import { resumeBody } from "../src/swapService";
import { restoreDigest, restoreRequestText } from "../src/swapGuard";
import { deriveOrderKey } from "../src/keys/swapKeys";

const deployment = {
  chainId: 1,
  core: "0x00000000000000000000000000000000000000c0",
  ethVault: "0x00000000000000000000000000000000000000e1",
  rpcUrl: "http://x",
  rpcUrls: ["http://x"],
  fromBlock: 0n,
  erc20Vaults: [],
  swapFactory: "0x00000000000000000000000000000000000000f1",
} as Deployment;
const ETH = { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" };
const SOL = { chain: "solana", asset: "native", decimals: 9, symbol: "SOL" };
const DEST = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const reviewedQuote = (refundTarget?: string, provider = "mayan") => ({
  provider,
  toAmount: "990",
  toAmountMin: "980",
  ...(refundTarget ? { refundTarget } : {}),
});
const campaign = (snapshot: unknown, provider = "mayan") =>
  ({
    id: "camp-F12",
    createdAt: Date.now(),
    state: "running",
    tier: "high-value",
    mode: "balanced",
    provider,
    policy: "balanced",
    request: { from: ETH, to: SOL, amount: "4000000000000000000", preference: "balanced" },
    bounds: { destination: { kind: "entered", address: DEST }, executeWindowSeconds: 1800 },
    riskSnapshot: snapshot,
    tranches: [{ index: 0, amount: "1000000000000000000", state: "ready", attempt: 1 }],
  }) as never;
const io = () => defaultIo({ masterSeed: session.state().seed!, deployment, session, submission: { kind: "relayer", url: "http://relayer.invalid" } as never });
const stepCommit = (c: never) => io().commit(c, (c as { tranches: unknown[] }).tranches[0] as never, DEST);
const single = (shown: ReturnType<typeof reviewedQuote>) =>
  commitOrder({
    masterSeed: session.state().seed!,
    deployment,
    request: { from: ETH, to: SOL, amount: "1000000000000000000", destination: DEST, slippageBps: 50, destinationKind: "entered" },
    policy: "balanced",
    shown,
    fromAsset: { symbol: "ETH", decimals: 18, vault: deployment.ethVault, token: null },
  } as never);

beforeEach(async () => {
  const store = memoryStorage();
  configure(defaultConfig({ storage: () => store, kdfLog2N: 12 }));
  session.lock();
  await session.create("a strong password", undefined, { replace: true });
  session.acknowledgePhrase();
  bodies.length = 0;
  resumed.length = 0;
  quoted.length = 0;
  answer.refundTarget = "destination";
});

describe("F12-2: the reviewed refund target binds a commit, a campaign step's too", () => {
  it("a single order reviewed as refunding to the pool: the service is asked for it, and a commit refunding at the destination is refused (D11-4)", async () => {
    const r = await single(reviewedQuote("escrow")).catch((e: unknown) => e as Error);
    expect((r as Error).message).toMatch(/refunds a failure at your destination address/);
    expect(bodies[0]?.refundTarget, "the service asked for the reviewed route type").toBe("escrow");
  });

  it("a single order reviewed as refunding at the destination asks for nothing, and one committed refunding to the pool is taken, journaled as committed", async () => {
    answer.refundTarget = "escrow";
    const r = await single(reviewedQuote("destination"));
    expect(bodies[0] && "refundTarget" in bodies[0], "never asked for the destination").toBe(false);
    expect((r.stored.quote as { refundTarget?: string }).refundTarget).toBe("escrow");
  });

  it("a campaign step reviewed as refunding to the pool: the service is asked for it, and a step committed to refund at the destination is refused", async () => {
    const r = await stepCommit(campaign({ quote: reviewedQuote("escrow") })).catch((e: unknown) => e as Error);
    expect((r as Error).message).toMatch(/refunds a failure at your destination address/);
    expect(bodies[0]?.refundTarget).toBe("escrow");
  });

  it("a campaign whose reviewed route names no refund target (THORChain, Chainflip refund to the escrow): read as the escrow", async () => {
    const c = campaign({ quote: reviewedQuote() });
    expect(reviewedRefundTargetOf(c)).toBe("escrow");
    const r = await stepCommit(c).catch((e: unknown) => e as Error);
    expect((r as Error).message).toMatch(/refunds a failure at your destination address/);
    expect(bodies[0]?.refundTarget).toBe("escrow");
  });

  it("a rerouted campaign keeps its Review's target: reviewed on THORChain, its step on Mayan is asked for the escrow and refused at the destination", async () => {
    const c = campaign(
      { quote: reviewedQuote(undefined, "thorchain"), requote: { at: Date.now(), provider: "mayan", protection: null, competition: null } },
      "mayan",
    );
    expect(reviewedRefundTargetOf(c)).toBe("escrow");
    const r = await stepCommit(c).catch((e: unknown) => e as Error);
    expect((r as Error).message).toMatch(/refunds a failure at your destination address/);
    expect(bodies[0]?.refundTarget, "a high-value step names no provider: the competition answers Mayan").toBe("escrow");
  });

  it("a campaign reviewed as refunding at the destination: its step commits so, asked for nothing", async () => {
    const r = await stepCommit(campaign({ quote: reviewedQuote("destination") }));
    expect((r.stored.quote as { refundTarget?: string }).refundTarget).toBe("destination");
    expect(bodies[0] && "refundTarget" in bodies[0]).toBe(false);
  });

  it("a campaign journaled without its reviewed quote: nothing to bind, committed as before and asked for nothing", async () => {
    const c = campaign({ protection: null });
    expect(reviewedRefundTargetOf(c)).toBeUndefined();
    const r = await stepCommit(c);
    expect((r.stored.quote as { refundTarget?: string }).refundTarget).toBe("destination");
    expect(bodies[0] && "refundTarget" in bodies[0]).toBe(false);
  });

  it("the campaign's requote asks for its Review's escrow target as its step's commit does — a reviewed route naming none read as the escrow (ZC's critique) — and for nothing otherwise", async () => {
    for (const snapshot of [
      { quote: reviewedQuote("escrow") },
      { quote: reviewedQuote("destination") },
      { protection: null },
      { quote: reviewedQuote(undefined, "chainflip") },
    ])
      await expect(io().quote(campaign(snapshot), 10n ** 18n)).rejects.toThrow(/recorded/);
    expect(quoted.map((q) => q.refundTarget)).toEqual(["escrow", undefined, undefined, "escrow"]);
    expect(quoted.map((q) => "refundTarget" in q)).toEqual([true, false, false, true]);
  });
});

describe("F12-1: the resume carries the journaled refund target", () => {
  const stored = (refundTarget?: string) =>
    ({
      orderId: "0x" + "ef".repeat(32),
      attemptId: "0x" + "01".repeat(32),
      endpoint: "0x00000000000000000000000000000000000e5c02",
      provider: "mayan",
      policy: "balanced",
      request: { from: ETH, to: SOL, amount: "1000000000000000000", destination: DEST, slippageBps: 50 },
      params: { orderId: "0x" + "ef".repeat(32), amount: "1000000000000000000", executeDeadline: 2_000_000_000, refundAfter: 2_000_007_200, executorTip: "0" },
      quote: reviewedQuote(refundTarget),
      state: "committed",
      createdAt: Date.now(),
    }) as unknown as StoredSwap;

  it("a resume names the committed route's refund target, either one, its restore signed by the order's key over the same text as before", async () => {
    const s = stored("escrow");
    await expect(resumeOrder(deployment, s, session)).rejects.toThrow(/recorded/);
    expect(resumed[0]?.refundTarget).toBe("escrow");
    const text = restoreRequestText({ from: ETH, to: SOL, destination: DEST, provider: "mayan" });
    const signer = await recoverAddress({ hash: restoreDigest(1n, s.endpoint as Hex, text), signature: resumed[0]!.restoreSignature as Hex });
    expect(signer.toLowerCase()).toBe(deriveOrderKey(session.state().seed!, s.attemptId as Hex).address.toLowerCase());
    await expect(resumeOrder(deployment, stored("destination"), session)).rejects.toThrow(/recorded/);
    expect(resumed[1]?.refundTarget, "the destination too: a rebuild never moves it, toward the pool either").toBe("destination");
  });

  it("an order whose quote names none, or something else, sends none: the service keeps its own record", async () => {
    for (const target of [undefined, "elsewhere"]) await expect(resumeOrder(deployment, stored(target), session)).rejects.toThrow(/recorded/);
    expect(resumed.map((r) => "refundTarget" in r)).toEqual([false, false]);
  });

  it("the body the service gets carries it at the top level, beside the restore signature (unsigned: the signing gate refuses a destination refund its journal does not name)", () => {
    const req = {
      request: { from: ETH, to: SOL, amount: "1", destination: DEST, slippageBps: 50 },
      policy: "balanced",
      provider: "mayan",
      params: {},
      restoreSignature: "0x01",
    } as never;
    for (const refundTarget of ["escrow", "destination"])
      expect(resumeBody({ ...(req as object), refundTarget } as never)).toMatchObject({ refundTarget, restoreSignature: "0x01", provider: "mayan" });
    expect("refundTarget" in resumeBody(req)).toBe(false);
  });
});
