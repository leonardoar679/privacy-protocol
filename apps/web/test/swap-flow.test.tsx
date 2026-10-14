// @vitest-environment happy-dom
// The Swap screen, clicked through against the swap service's REAL engine (behind a fetch mock that
// stands in for HTTP), a stub THORChain adapter built on the adapter's own encoders, three THORNode
// gateways and a relayer: get a quote → commit (the wallet journals the minimum it showed) → resume
// the funded order → confirm. The wallet reads the provider call before its one-time key signs: a
// call paying someone else is refused with nothing signed; a call guaranteeing less than approved is
// not signed until the user confirms that exact minimum, which is then journaled.
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { toFunctionSelector, type Hex } from "viem";
import { Swap } from "../src/features/swap/Swap";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { priceStore } from "@privacy-wallet/sdk/prices";
import { fieldNames, FORBIDDEN_FIELDS, leaks, sessionSecrets } from "./helpers/leakage";
import { allowedHosts } from "@privacy-wallet/privacy-engine/transport/http";
import { calls, deployment, ETH_VAULT, FACTORY, fetchMock, jobs, LIMIT, RELAYER_EOA, relayerBodies, requests, resetWorld, rpcSeen, world } from "./helpers/swapWorld";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// the refund note recovery itself runs against a mock RPC in test/refunds.test.ts; here only the screen's use of it
const refundHook = vi.hoisted(() => ({ calls: 0, result: [] as unknown[] }));
vi.mock("@privacy-wallet/sdk/privateTx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@privacy-wallet/sdk/privateTx")>()),
  recoverSwapRefunds: async () => { refundHook.calls++; return refundHook.result; },
}));

beforeAll(() => { globalThis.fetch = fetchMock as unknown as typeof fetch; });
let root: Root | null = null;
afterEach(() => { if (root) { act(() => root!.unmount()); root = null; } session.forget(); resetWorld(); });

const setValue = (el: HTMLInputElement, v: string) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
const button = (c: HTMLElement, text: string | RegExp) => [...c.querySelectorAll("button")].find((b) => (typeof text === "string" ? b.textContent?.trim() === text : text.test(b.textContent ?? ""))) as HTMLButtonElement | undefined;
async function mount(container: HTMLElement) {
  if (root) act(() => root!.unmount());
  await act(async () => { root = createRoot(container); root.render(<Swap masterSeed={session.state().seed!} deployment={deployment} />); });
}

/** Quote → commit → (funding happens elsewhere) → reopen the funded order from the journal. */
async function committedAndFunded(container: HTMLElement) {
  await session.create("a strong password");
  session.acknowledgePhrase();
  // a balance to value and a price for it: the swap is then standard-tier (whale spec §13) and the flow one tap, as in V1.1
  noteStore.add({ note: { vaultId: BigInt(ETH_VAULT), amount: 10n ** 18n, ownerCommitment: 1n, noteSecret: 2n }, leafIndex: 0, noteData: "0x", spent: false });
  await priceStore.refresh(deployment);
  expect(priceStore.state().status).toBe("ready");
  await mount(container);
  await act(async () => { setValue(container.querySelector('[data-testid="swap-amount-input"]') as HTMLInputElement, "0.5"); }); // V5: no amount is pre-filled
  await act(async () => { button(container, "Get a quote")!.click(); });
  await vi.waitFor(() => expect(button(container, "Review Swap")).toBeTruthy());
  await act(async () => { button(container, "Review Swap")!.click(); }); // V5 (spec §3.9): the Review before every commit, a tap at standard
  await vi.waitFor(() => expect(container.querySelector('[data-testid="confirm-tap"]')).toBeTruthy());
  await act(async () => { (container.querySelector('[data-testid="confirm-tap"]') as HTMLButtonElement).click(); });
  await vi.waitFor(() => expect(session.journal().swaps).toHaveLength(1));
  const s = session.journal().swaps[0];
  expect(s.approvedMin, "the minimum the user saw is journaled at commit").toBe(LIMIT.toString());
  session.update((j) => { j.swaps[0].fundedTx = "0x" + "11".repeat(32); j.swaps[0].state = "funded"; }); // the private withdrawal itself is covered elsewhere
  await mount(container); // a reload: the order comes back from the journal
  await act(async () => { button(container, "Open")!.click(); });
  await vi.waitFor(() => expect(button(container, "2 · Confirm the swap")?.disabled).toBe(false));
  return s.orderId;
}

describe("the Swap screen reads the provider call before signing (happy-dom, real engine)", () => {
  it("an honest call: checked, signed, handed to the relayer; the check is shown in plain words", async () => {
    const container = document.createElement("div");
    await committedAndFunded(container);
    await act(async () => { button(container, "2 · Confirm the swap")!.click(); });
    await vi.waitFor(() => expect(container.textContent).toContain("Checked by this wallet before signing"), { timeout: 20_000 });
    expect(container.textContent).toContain("pays your fresh address, at least 0.030000 BTC");
    expect(container.textContent).toContain("a provider refund returns to your private balance");
    expect(calls).toContain("127.0.0.1:8787/v1/operations/:id/finalize");
    expect(calls).toContain("127.0.0.1:8790/swap/execute");
    expect(calls.filter((c) => c.endsWith("/thorchain/inbound_addresses")).length, "the wallet asked the gateways itself").toBe(3);
    // the signed execution was simulated on the deployment's endpoint before it left the wallet, with the relayer as the tip recipient
    const sim = rpcSeen.find((tx) => String(tx.to).toLowerCase() === FACTORY.toLowerCase());
    expect(sim, "deployAndExecute simulated").toBeTruthy();
    expect(String(sim.from).toLowerCase()).toBe(RELAYER_EOA.toLowerCase());
    expect(calls.indexOf("127.0.0.1:1/"), "simulated before finalize").toBeLessThan(calls.indexOf("127.0.0.1:8787/v1/operations/:id/finalize"));
    expect(session.journal().swaps[0].simulation).toMatchObject({ ok: true, gas: "210000" });
    expect(container.textContent).toContain("Simulated on your RPC endpoints before hand-over");
    expect(container.querySelector('[data-testid="privacy-lint"]')).toBeTruthy();
  });

  it("a call the chain would revert is not handed over: the escrow's error and the provider's reason are shown, nothing is finalized, the signature stays here", async () => {
    const container = document.createElement("div");
    const orderId = await committedAndFunded(container);
    world.rpcBend = { revert: toFunctionSelector("ProviderCallFailed()") as Hex, providerReason: "THORChain: trading halted" };
    await act(async () => { button(container, "2 · Confirm the swap")!.click(); });
    await vi.waitFor(() => expect(container.textContent).toContain("Not handed over: the execution would revert (ProviderCallFailed: the provider rejected the call); the provider says: THORChain: trading halted"), { timeout: 20_000 });
    expect(calls).not.toContain("127.0.0.1:8787/v1/operations/:id/finalize");
    expect(calls).not.toContain("127.0.0.1:8790/swap/execute");
    expect(session.journal().swaps.find((s) => s.orderId === orderId)!.simulation).toMatchObject({ ok: false, error: "ProviderCallFailed" });
    expect(button(container, "2 · Confirm the swap")!.disabled, "confirm again later against a fresh quote").toBe(false);
  });

  it("a call paying another address is refused and nothing is signed", async () => {
    const container = document.createElement("div");
    await committedAndFunded(container);
    world.bend = { dest: "bc1qattacker" };
    await act(async () => { button(container, "2 · Confirm the swap")!.click(); });
    await vi.waitFor(() => expect(container.textContent).toMatch(/does not do what this wallet asked for \(thorchain receiver/), { timeout: 20_000 });
    expect(calls).not.toContain("127.0.0.1:8787/v1/operations/:id/finalize");
    expect(calls).not.toContain("127.0.0.1:8790/swap/execute");
  });

  it("a refused call can be returned to the private balance: a refund-only job with the journaled params, no signature", async () => {
    const container = document.createElement("div");
    const orderId = await committedAndFunded(container);
    world.bend = { dest: "bc1qattacker" };
    await act(async () => { button(container, "2 · Confirm the swap")!.click(); });
    await vi.waitFor(() => expect(container.textContent).toMatch(/does not do what this wallet asked for/), { timeout: 20_000 });
    await act(async () => { button(container, "Return to my private balance")!.click(); });
    await vi.waitFor(() => expect(container.textContent).toContain("Returning to your private balance"), { timeout: 20_000 });
    expect(relayerBodies).toHaveLength(1);
    const sent = relayerBodies[0];
    expect(sent.execution, "nothing signed is handed over").toBeUndefined();
    expect(sent.params).toEqual(session.journal().swaps.find((s) => s.orderId === orderId)!.params);
    expect(sent.factory.toLowerCase()).toBe(FACTORY.toLowerCase());
    expect(sent.refundNoteData).toMatch(/^0x[0-9a-f]{338}$/);
    expect(calls).not.toContain("127.0.0.1:8787/v1/operations/:id/finalize");
    expect(session.journal().swaps.find((s) => s.orderId === orderId)?.state).toBe("refund-only");
  });
  it("when the executor reports the refund, the refund note is recorded at once and its amount shown (PP-S09)", async () => {
    const container = document.createElement("div");
    const orderId = await committedAndFunded(container);
    await act(async () => { button(container, "Return to my private balance")!.click(); });
    await vi.waitFor(() => expect(container.textContent).toContain("Returning to your private balance"), { timeout: 20_000 });
    refundHook.result = [{ orderId, leafIndex: 4, note: { vaultId: BigInt(ETH_VAULT), amount: 99n * 10n ** 16n, ownerCommitment: 1n, noteSecret: 2n }, counter: 0, commitment: 0n, noteData: "0x", txHash: "0x" }];
    jobs.set(orderId.toLowerCase(), "refunded"); // the escrow re-shielded once the window opened
    await mount(container); // a reload: the order comes back from the journal, its job from the relayer
    await act(async () => { button(container, "Open")!.click(); });
    await vi.waitFor(() => expect(container.textContent).toContain("Refunded: 0.99 ETH back in your private balance."), { timeout: 20_000 });
    expect(refundHook.calls).toBe(1);
    refundHook.result = [];
    refundHook.calls = 0;
  });

  it("after execution the screen says where a provider refund would land and that the executor watches for it (PP-S11, PP-S12)", async () => {
    const container = document.createElement("div");
    const orderId = await committedAndFunded(container);
    await act(async () => { button(container, "2 · Confirm the swap")!.click(); });
    await vi.waitFor(() => expect(calls).toContain("127.0.0.1:8790/swap/execute"), { timeout: 20_000 });
    jobs.set(orderId.toLowerCase(), "executed"); // the provider call went through
    await mount(container); // a reload: the order from the journal, its job from the relayer
    await act(async () => { button(container, "Open")!.click(); });
    await vi.waitFor(() => expect(container.textContent).toContain("If it cannot deliver, it refunds the escrow, and the executor re-shields that into your private balance"), { timeout: 20_000 });
    expect(container.textContent).toContain("An amount too small to be worth a re-shield is left in the escrow, where anyone can re-shield it.");
  });

  it("a lower minimum is not signed until the user confirms exactly it; the consent is journaled", async () => {
    const container = document.createElement("div");
    const orderId = await committedAndFunded(container);
    world.bend = { limit: LIMIT - 60_000n };
    await act(async () => { button(container, "2 · Confirm the swap")!.click(); });
    await vi.waitFor(() => expect(container.textContent).toContain("The price moved"), { timeout: 20_000 });
    expect(container.textContent).toContain("at least 0.029400 BTC");
    expect(container.textContent).toContain("−2 %");
    expect(calls, "nothing signed yet").not.toContain("127.0.0.1:8787/v1/operations/:id/finalize");
    await act(async () => { button(container, "Confirm at the new minimum")!.click(); });
    await vi.waitFor(() => expect(container.textContent).toContain("Checked by this wallet before signing"), { timeout: 20_000 });
    expect(calls).toContain("127.0.0.1:8787/v1/operations/:id/finalize");
    expect(session.journal().swaps.find((s) => s.orderId === orderId)?.approvedMin).toBe((LIMIT - 60_000n).toString());
    expect(container.textContent).not.toContain("The price moved");
  });

  it("the leakage gate (spec §20–§21): no request of the quote → commit → confirm scenario carries the seed, the phrase, a key, the password or a forbidden field; the service and the relayer see the order, the one-time key and the public call only", async () => {
    const container = document.createElement("div");
    requests.length = 0;
    await committedAndFunded(container);
    await act(async () => { button(container, "2 · Confirm the swap")!.click(); });
    await vi.waitFor(() => expect(container.querySelector('[data-testid="checked-line"]')).toBeTruthy(), { timeout: 30_000 });
    const { secrets } = sessionSecrets({ password: "a strong password", phrase: session.state().pendingPhrase ?? "" });
    expect(requests.length).toBeGreaterThan(5);
    const hosts = [...new Set(requests.map((r) => new URL(r.url).hostname))];
    expect(hosts.length, "the service, the relayer, the RPC endpoint, the THORNode gateways").toBeGreaterThanOrEqual(3);
    expect(hosts.filter((h) => !allowedHosts().includes(h)), "every host is allow-listed by the transport").toEqual([]);
    for (const r of requests) {
      expect(leaks(`${r.url}
${r.body ?? ""}`, secrets), r.url).toEqual([]);
      if (r.body) expect([...fieldNames(JSON.parse(r.body))].filter((n) => FORBIDDEN_FIELDS.test(n)), `${r.url}: field names`).toEqual([]);
    }
    const seedHex = Array.from(session.state().seed!, (x) => x.toString(16).padStart(2, "0")).join("");
    expect(requests.some((r) => (r.body ?? "").includes(seedHex))).toBe(false);
  }, 60_000);
});
