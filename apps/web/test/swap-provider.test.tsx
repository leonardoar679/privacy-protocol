// @vitest-environment happy-dom
// The swap provider facade in the wallet (spec v3.0 §5; V7 Stage 14): the five calls over the mock service and the wallet's
// own checks, and the parity with the direct flow — the order the facade commits is the order confirmOrder commits (the same
// commitOrder underneath: journaled, scheduled, its minimum approved) and the call it validates is the call the runner's
// prepareAndSign checks and signs (the same provider contract, value, receiver and minimum; the deadline follows the fresh
// quote's expiry). A status
// read never moves funds; the recovery options follow the record and the pause.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { assetsOf } from "@privacy-wallet/sdk/assets";
import { resetOperationsMemory } from "@privacy-wallet/sdk/operations/store";
import { prepareAndSign } from "@privacy-wallet/sdk/swapExecute";
import { patchSwap } from "@privacy-wallet/sdk/swapFunding";
import { walletSwapProvider } from "@privacy-wallet/sdk/swapProvider";
import type { SwapRequest } from "@privacy-wallet/sdk/swapService";
import { priceStore } from "@privacy-wallet/sdk/prices";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { resetOrderRunnerMemory } from "@privacy-wallet/sdk/wallet/orderRunner";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { BTC, calls, deployment, ETH_VAULT, fetchMock, LIMIT, orders, resetWorld } from "./helpers/swapWorld";

beforeAll(() => {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  session.forget();
  noteStore.clear();
  resetOperationsMemory();
  resetOrderRunnerMemory();
  resetWorld();
  settings.reset();
});

const DEST = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const request: SwapRequest = {
  from: { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" },
  to: BTC,
  amount: (5n * 10n ** 17n).toString(),
  destination: DEST,
  slippageBps: 50,
  preference: "balanced",
  destinationKind: "fresh",
  preferNative: false,
  mode: "balanced",
};

async function wallet() {
  await session.create("a strong password");
  session.acknowledgePhrase();
  noteStore.add({ note: { vaultId: BigInt(ETH_VAULT), amount: 10n ** 18n, ownerCommitment: 1n, noteSecret: 2n }, leafIndex: 0, noteData: "0x", spent: false });
  await priceStore.refresh(deployment);
  return walletSwapProvider({ masterSeed: session.state().seed!, deployment });
}
const count = (suffix: string) => calls.filter((c) => c.endsWith(suffix)).length;

describe("the swap provider facade (spec v3.0 §5)", () => {
  it("getQuote is the service's competition; prepare commits the order and reads the call; validate checks it in the wallet; the runner's own signing checks the very same call (parity)", async () => {
    const facade = await wallet();
    const fromAsset = assetsOf(deployment)[0];
    expect(facade.id).toBe("privacy-wallet");
    const q = await facade.getQuote(request);
    expect(count("/v1/quotes")).toBe(1);
    expect(q.chosen?.provider).toBe("thorchain");
    expect(q.set.quotes).toHaveLength(1);
    // the two-phase commit: the order journaled and scheduled as confirmOrder journals it, the escrow the service's endpoint, the call read once
    const prepared = await facade.prepare(q, { policy: "balanced", preference: "balanced", fromAsset, walletTier: "standard", reviewedFee: 7n });
    expect(count("/v1/operations")).toBe(1);
    expect(count("/v1/operations/:id/prepare")).toBe(1);
    expect(session.journal().swaps).toHaveLength(1);
    const [stored] = session.journal().swaps;
    expect(stored.orderId).toBe(prepared.orderId);
    expect(stored).toMatchObject({ state: "committed", approvedMin: LIMIT.toString(), runner: { confirmedAt: expect.any(Number) } });
    // the review round of 2026-11-02: the facade commits what the Review showed — the request as given reaches the service, the
    // reviewed fee is journaled for the funding's bound (c46)
    expect(stored.reviewedFee).toBe("7");
    expect(stored.request).toMatchObject({ amount: request.amount, to: BTC, destination: DEST });
    expect(orders.get(prepared.orderId)?.order.request, "the service's order is the request as given").toMatchObject({ amount: BigInt(request.amount), destination: DEST, slippageBps: 50 });
    expect(
      session.journal().schedule.some((a) => a.id === `order-tick:${prepared.orderId}`),
      "the runner's tick is planned by the commit",
    ).toBe(true);
    expect(prepared.escrow.toLowerCase()).toBe(prepared.order.endpoint.toLowerCase());
    expect(prepared.operationId).toMatch(/^op_/);
    expect(prepared.call).toMatchObject({
      digest: expect.stringMatching(/^0x[0-9a-f]{64}$/i),
      provider: expect.any(String),
      calldata: expect.stringMatching(/^0x/),
    });
    // the wallet's validation: the escrow recomputed, the digest of exactly the call, the call doing what was asked, the minimum approved
    const v = await facade.validate(prepared);
    expect(v.ok).toBe(true);
    if (!v.ok) throw new Error(v.detail);
    expect(v.checks).toEqual(["order", "escrow", "call", "minimum"]);
    expect(v.escrow.toLowerCase()).toBe(prepared.escrow.toLowerCase());
    expect(v.call.minOut !== null && v.call.minOut >= LIMIT, "the minimum the user approved is guaranteed").toBe(true);
    // parity with the direct flow: the runner prepares, checks and signs the same call — the provider contract, the value, the
    // receiver and the minimum; its deadline follows the fresh quote's expiry (the mock's moves with the clock: seconds apart at most)
    const signed = await prepareAndSign({
      masterSeed: session.state().seed!,
      deployment,
      stored: prepared.stored,
      order: prepared.order,
      submission: settings.get().submission,
    });
    if (!("signature" in signed)) throw new Error("the runner's signing was asked for a lower minimum");
    expect([signed.prepared.provider, signed.prepared.value]).toEqual([prepared.call!.provider, prepared.call!.value]);
    expect(Math.abs(signed.prepared.deadline - prepared.call!.deadline)).toBeLessThanOrEqual(5);
    expect([signed.call.receiver, signed.call.minOut, signed.call.provider, signed.call.refundTo]).toEqual([
      v.call.receiver,
      v.call.minOut,
      v.call.provider,
      v.call.refundTo,
    ]);
    expect(signed.sim.ok, "the simulation lives where the signature is made").toBe(true);
    // a status read: the record, the tracker's derived state, no settlement before the funding — and nothing funded or sent
    const st = await facade.getStatus(prepared.operationId!);
    expect(st).toMatchObject({ orderId: prepared.orderId, operationId: prepared.operationId, state: "AWAITING_AUTHORIZATION", settlement: null, paused: null });
    expect(st.tracked?.state).toBe("COMMITTED");
    expect(count("/relay")).toBe(0);
    expect(count("/swap/execute")).toBe(0);
    // the recovery options follow the record and the pause
    expect(await facade.getRecoveryOptions(prepared.orderId)).toEqual([{ action: "continue-monitoring", fundsClass: "not-moved" }]);
    patchSwap(prepared.orderId, { paused: { code: "minimum_moved", at: Date.now(), minOut: "1", approved: "2" } });
    expect(await facade.getRecoveryOptions(prepared.orderId.toUpperCase())).toEqual([
      { action: "accept-new-minimum", fundsClass: "not-moved" },
      { action: "return-funds", fundsClass: "not-moved" },
    ]);
    await expect(facade.getStatus("op_nobody")).rejects.toThrow(/not in the journal/);
    await expect(facade.getRecoveryOptions("0x" + "00".repeat(32))).rejects.toThrow(/not in the journal/);
  }, 60_000);

  it("prepare without the call (the runner reads its own at funding) and the commit's facts: no facts, no commit", async () => {
    const facade = await wallet();
    const fromAsset = assetsOf(deployment)[0];
    const q = await facade.getQuote(request);
    await expect(facade.prepare(q)).rejects.toThrow(/the commit's facts/);
    expect(session.journal().swaps).toHaveLength(0);
    const prepared = await facade.prepare(q, { policy: "balanced", preference: "balanced", fromAsset, walletTier: "standard", withCall: false });
    expect(prepared.call).toBeNull();
    expect(count("/v1/operations/:id/prepare")).toBe(0);
    const v = await facade.validate(prepared);
    expect(v.ok, "validate reads the call itself when the commit left it to the runner").toBe(true);
    expect(count("/v1/operations/:id/prepare")).toBe(1);
  }, 60_000);
});
