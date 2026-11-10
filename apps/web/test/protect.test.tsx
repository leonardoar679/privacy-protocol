// @vitest-environment happy-dom
// Protect Assets on the V6 screens (spec v2.0 §7.3, §7.6–§7.7; doc §19, §22–§23, §58): /protect the one page — the
// connected wallet's account and balance read through its own provider, the amount typed once, what arrives after
// ProtectRouter's 1 %, the network cost — then /protect/review (a tap below $50K; the recovery-information card once per
// session), /protect/progress/:opId (the §58 lines), what was added; a declined prompt ("Your funds were not moved.")
// and the way back to the Review; a reverted receipt (FAILED, not moved); the ERC-20 two prompts in one operation; the
// common sizes under Advanced only; without a wallet the connection is offered and nothing is read.
import { join } from "node:path";
import "fake-indexeddb/auto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { en } from "../src/app/i18n/en";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { getAddress } from "viem";
import type { EngineEvent } from "@privacy-wallet/sdk/operations/engineEvents";
import {
  allOperations,
  applyEvent,
  finishedOperations,
  getOperation,
  newOperation,
  openOperations,
  resetOperationsMemory,
} from "@privacy-wallet/sdk/operations/store";
import { ProtectScreen, type ProtectScreenProps } from "../src/features/protect/ProtectScreen";
import { PROTECT_OPERATION_STATE, PROTECT_STEPS, protectModel, protectStepOf } from "../src/features/protect/model";
import { setActiveProvider } from "@privacy-wallet/wallet-engine/injected";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import { prefs } from "../src/storage/prefs";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { activityOf } from "@privacy-wallet/sdk/wallet/activity";
import { PROVIDER_FUTURE, ROUTER_FUTURE } from "../src/routes";
import { DEPOSIT_SCAN_DELAY_MS } from "@privacy-wallet/sdk/wallet/discovery";
import { scheduleAction } from "@privacy-wallet/sdk/wallet/schedule";

const HASH = ("0x" + "ab".repeat(32)) as `0x${string}`;
const APPROVE = ("0x" + "cd".repeat(32)) as `0x${string}`;
const calls: { native: unknown[]; erc20: unknown[] } = { native: [], erc20: [] };
let nativeBehaviour: "ok" | "rejected" | "wc-rejected" | "expired" | "reverted" | "lost" | "unconfirmed" = "ok";
/** WalletConnect's own utilities, the installed copy (resolved from @walletconnect/core's directory) — its refusal, a plain {message, code} */
const wcRequire = createRequire(import.meta.url);
const walletConnectRefusal = (key: string): { message: string; code: number } =>
  (
    wcRequire(wcRequire.resolve("@walletconnect/utils", { paths: [dirname(wcRequire.resolve("@walletconnect/core"))] })) as {
      getSdkError: (k: string) => { message: string; code: number };
    }
  ).getSdkError(key);
/** the sign client's request expiry, in its own shape (createDelayedPromise: an Error with code 6) */
const requestExpired = () => Object.assign(new Error("Request expired. Please try again."), { code: 6 });

/** the note scan's action as the deposit found it when it began (the twelfth review round, ZK's critique: the demand made before it) */
const engineSaw = vi.hoisted(() => ({ scan: undefined as { dueAt: number; heldFailures?: number } | null | undefined, at: 0 }));
vi.mock("@privacy-wallet/sdk/privateTx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@privacy-wallet/sdk/privateTx")>()),
  shieldNative: async (o: { amount: bigint; onEvent?: (e: EngineEvent) => void; onStatus?: (s: string) => void }) => {
    const { session: s } = await import("@privacy-wallet/sdk/wallet/session");
    engineSaw.at = Date.now();
    engineSaw.scan = s.journal().schedule.find((a) => a.id === "discovery:pool" && !a.done) ?? null;
    calls.native.push(o.amount);
    o.onStatus?.("Submitting the shield through the connected wallet (a shield is public by design)…");
    o.onEvent?.({ type: "wallet-prompt", step: "deposit", i: 1, n: 1 });
    if (nativeBehaviour === "rejected") throw Object.assign(new Error("User rejected the request."), { code: 4001 });
    if (nativeBehaviour === "wc-rejected") throw walletConnectRefusal("USER_REJECTED"); // the twelfth review round, B12-5
    if (nativeBehaviour === "expired") throw requestExpired(); // the twelfth review round, A12-2
    o.onEvent?.({ type: "submitted", txHash: HASH, by: "wallet" });
    o.onEvent?.({ type: "waiting-receipt", txHash: HASH });
    if (nativeBehaviour === "reverted") throw new Error(`transaction ${HASH} reverted`);
    if (nativeBehaviour === "lost") throw new Error("the commitment was not found in the receipt"); // sent: the outcome not known
    // the connected wallet gave no receipt (the eleventh review round, F11-10): sent, and the endpoints are not asked
    if (nativeBehaviour === "unconfirmed")
      throw Object.assign(new Error("the connected wallet gave no receipt for the deposit (unreadable); it is sent, and the next scan records its note"), {
        code: "deposit_unconfirmed",
      });
    o.onEvent?.({ type: "mined", txHash: HASH, leafIndex: 7 });
    return { txHash: HASH, leafIndex: 7 };
  },
  shieldERC20: async (o: { amount: bigint; onEvent?: (e: EngineEvent) => void }) => {
    calls.erc20.push(o.amount);
    o.onEvent?.({ type: "wallet-prompt", step: "approve", i: 1, n: 2 });
    o.onEvent?.({ type: "approved", txHash: APPROVE });
    o.onEvent?.({ type: "wallet-prompt", step: "deposit", i: 2, n: 2 });
    o.onEvent?.({ type: "submitted", txHash: HASH, by: "wallet" });
    o.onEvent?.({ type: "waiting-receipt", txHash: HASH });
    o.onEvent?.({ type: "mined", txHash: HASH, leafIndex: 8 });
    return { approveTx: APPROVE, txHash: HASH, leafIndex: 8 };
  },
}));

const OWNER = getAddress("0x9858EfFD232B4033E47d90003D41EC34EcaEda94");
const USDC = getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
const USDC_VAULT = getAddress("0x00000000000000000000000000000000000ca5de");
const ROUTER = getAddress("0x00000000000000000000000000000000000000a1");
const deployment: Deployment = {
  chainId: 31337,
  core: getAddress("0x00000000000000000000000000000000000000c0"),
  ethVault: getAddress("0x00000000000000000000000000000000000000e7"),
  rpcUrl: "http://127.0.0.1:1",
  rpcUrls: ["http://127.0.0.1:1"],
  fromBlock: 0n,
  erc20Vaults: [{ symbol: "USDC", decimals: 6, vault: USDC_VAULT, token: USDC }],
  protectRouter: ROUTER,
};
const fetchSpy = vi.fn(async () => new Response("{}", { status: 404 }));
beforeAll(() => {
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  session.forget();
  settings.reset();
  prefs().reset();
  noteStore.clear();
  resetOperationsMemory();
  setActiveProvider(null);
  calls.native = [];
  calls.erc20 = [];
  nativeBehaviour = "ok";
});

/** The connected wallet's provider: a 2 ETH balance, a gas estimate and a gas price of its own; nothing else. */
function provider() {
  const seen: string[] = [];
  const eth = {
    request: async ({ method }: { method: string }) => {
      seen.push(method);
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [OWNER];
      if (method === "eth_getBalance") return "0x" + (2n * 10n ** 18n).toString(16);
      if (method === "eth_estimateGas") return "0x" + 120_000n.toString(16);
      if (method === "eth_gasPrice") return "0x" + (20n * 10n ** 9n).toString(16);
      if (method === "eth_call") throw new Error("unexpected call");
      throw new Error(`unsupported ${method}`);
    },
    seen,
  };
  return eth;
}
async function unlocked() {
  await session.create("a strong password");
  session.acknowledgePhrase();
}
const type = (el: HTMLElement, v: string) => fireEvent.input(el, { target: { value: v } });
/** The screen under its splat route, as the application mounts it. */
function mount(props: Partial<ProtectScreenProps> = {}) {
  const router = createMemoryRouter(
    [{ path: "/protect/*", element: <ProtectScreen masterSeed={session.state().seed!} deployment={deployment} account={OWNER} {...props} /> }],
    { initialEntries: ["/protect"], future: ROUTER_FUTURE },
  );
  render(<RouterProvider router={router} future={PROVIDER_FUTURE} />);
  return { router, path: () => router.state.location.pathname };
}

describe("the Protect flow's model (spec v2.0 §7.3: the §23 reducer on the operation states)", () => {
  it("each step from what is known, and each step as an operation state: a draft before the review, signed from the prompt", () => {
    const base = { assetChosen: true, units: 5_000_000_000n, balance: 5_210_000_000n, feeReady: true, reviewing: false, record: null };
    expect(protectStepOf({ ...base, assetChosen: false })).toBe("SELECT_ASSET");
    expect(protectStepOf({ ...base, units: 0n })).toBe("ENTER_AMOUNT");
    expect(protectStepOf({ ...base, balance: null })).toBe("VALIDATE_BALANCE");
    expect(protectStepOf({ ...base, balance: 1n })).toBe("VALIDATE_BALANCE");
    expect(protectStepOf({ ...base, feeReady: false })).toBe("CALCULATE_FEE");
    expect(protectStepOf({ ...base, reviewing: true })).toBe("PREPARE_TRANSACTION");
    expect(protectStepOf({ ...base, record: { state: "AWAITING_AUTHORIZATION" } })).toBe("WALLET_CONFIRM");
    expect(protectStepOf({ ...base, record: { state: "SUBMITTING" } }), "V7: the prompt — the transaction handed to the wallet").toBe("WALLET_CONFIRM");
    expect(protectStepOf({ ...base, record: { state: "SOURCE_CONFIRMING" } }), "V7: the hash and the receipt are one state").toBe("CONFIRMED");
    expect(protectStepOf({ ...base, record: { state: "COMPLETED" } })).toBe("PROTECTED_BALANCE_UPDATED");
    expect(PROTECT_STEPS.map((s) => PROTECT_OPERATION_STATE[s])).toEqual([
      "DRAFT",
      "DRAFT",
      "DRAFT",
      "QUOTING",
      "READY_TO_REVIEW",
      "AWAITING_AUTHORIZATION",
      "SOURCE_CONFIRMING",
      "SOURCE_CONFIRMING",
      "COMPLETED",
    ]);
  });
  it("the one page's model: the document's 5,000 USDC → 4,950 with a 50 USDC fee; the network cost in cents from the wallet's own wei; too much or too little in words' keys", () => {
    const usdc = { symbol: "USDC", decimals: 6 };
    const m = protectModel({
      asset: usdc,
      account: OWNER,
      balance: 5_210_000_000n,
      amount: "5000",
      units: 5_000_000_000n,
      split: { fee: 50_000_000n, net: 4_950_000_000n },
      networkWei: 2_400_000_000_000_000n,
      ethUsd1e8: 1_800n * 10n ** 8n,
    });
    expect(m.quote).toEqual({
      receive: { units: 4_950_000_000n, symbol: "USDC", decimals: 6, displayDecimals: 2 },
      privacyFee: { units: 50_000_000n, symbol: "USDC", decimals: 6, displayDecimals: 2 },
      networkUsdCents: 432n,
    });
    expect(m.error).toBeNull();
    expect(
      protectModel({
        asset: usdc,
        account: OWNER,
        balance: 1n,
        amount: "5000",
        units: 5_000_000_000n,
        split: { fee: 50_000_000n, net: 4_950_000_000n },
        networkWei: null,
        ethUsd1e8: null,
      }),
    ).toMatchObject({ error: "insufficient", quote: null });
    expect(
      protectModel({
        asset: usdc,
        account: OWNER,
        balance: null,
        amount: "0.000001",
        units: 1n,
        split: { fee: 1n, net: 0n },
        networkWei: null,
        ethUsd1e8: null,
      }),
    ).toMatchObject({ error: "too-small", quote: null });
    expect(
      protectModel({
        asset: usdc,
        account: OWNER,
        balance: null,
        amount: "5000",
        units: 5_000_000_000n,
        split: { fee: 50_000_000n, net: 4_950_000_000n },
        networkWei: null,
        ethUsd1e8: null,
      }).quote?.networkUsdCents,
      "no estimate: no figure",
    ).toBeNull();
  });
});

describe("Protect Assets (spec v2.0 §7.3)", () => {
  it("one Protect at a time (V7 Stage 16, spec v3.0 §9): while one waits for the wallet's answer, the Review of a second stops it — nothing is sent", async () => {
    await unlocked();
    const eth = provider();
    setActiveProvider(eth);
    const waiting = newOperation({
      kind: "protect",
      amounts: { asset: "ETH", decimals: 18, input: "500000000000000000" },
      destination: { kind: "privacy-address", display: "protected-balance", chain: "ethereum" },
      tier: "standard",
    });
    applyEvent(waiting.id, { type: "review" });
    applyEvent(waiting.id, { type: "confirm" }); // AWAITING_AUTHORIZATION: a phone's handoff left it there
    const { path } = mount();
    await waitFor(() => expect(screen.getByTestId("protect-from").textContent).toContain("2 ETH"));
    type(screen.getByTestId("amount-input"), "1");
    fireEvent.click(screen.getByTestId("protect-review"));
    expect(path()).toBe("/protect/review");
    expect(screen.getByTestId("review-blocked")).toBeTruthy();
    expect(screen.getByTestId("review-view").textContent).toContain("Another operation of this kind is still waiting for your wallet's answer");
    expect(screen.queryByTestId("review-confirm"), "no Confirm").toBeNull();
    expect(calls.native, "nothing was sent").toEqual([]);
    expect(getOperation(waiting.id)?.state).toBe("AWAITING_AUTHORIZATION");
  });

  it("reads the wallet's balance through its provider; the 1 % comes off what arrives; Review, a tap, the progress lines, then what was added — the record from the signature to COMPLETED with the leaf", async () => {
    await unlocked();
    const eth = provider();
    setActiveProvider(eth);
    const onDone = vi.fn();
    const { path } = mount({ onDone });
    await waitFor(() => expect(screen.getByTestId("protect-from").textContent).toContain("2 ETH"));
    expect(screen.getByTestId("protect-from").textContent).toContain("0x98…da94");
    expect(screen.queryByTestId("protect-chips"), "the common sizes are Advanced only").toBeNull();
    expect((screen.getByTestId("protect-review") as HTMLButtonElement).disabled, "nothing typed yet").toBe(true);
    type(screen.getByTestId("amount-input"), "1");
    expect(screen.getByTestId("protect-receive").textContent).toContain("0.99 ETH");
    expect(screen.getByTestId("protect-privacy-fee").textContent).toContain("0.01 ETH");
    await waitFor(() => expect(eth.seen).toContain("eth_estimateGas"));
    expect(eth.seen).toContain("eth_gasPrice");
    expect(fetchSpy, "nothing through this wallet's endpoints for the estimate").not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("protect-review"));
    expect(path()).toBe("/protect/review");
    expect(screen.getByTestId("review-expected").textContent).toContain("0.99 ETH");
    expect(screen.getByTestId("review-fee-privacy").textContent).toContain("0.01 ETH");
    expect(screen.getByTestId("review-destination").textContent).toContain("Your protected balance");
    expect(screen.getByTestId("backup-nudge").textContent).toContain("Protect your wallet");
    expect(screen.queryByTestId("hold-to-confirm"), "below $50K: a tap").toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId("review-confirm"));
    });
    await screen.findByTestId("protect-done");
    expect(path()).toMatch(/^\/protect\/progress\/protect:[0-9a-z:]+$/);
    expect(screen.getByTestId("protect-done").textContent).toContain("Added 0.99 ETH to your protected balance.");
    expect(calls.native).toEqual([10n ** 18n]);
    const [rec] = finishedOperations();
    expect(rec).toMatchObject({
      kind: "protect",
      state: "COMPLETED",
      refs: { txHashes: [HASH], leafIndex: 7 },
      amounts: { asset: "ETH", input: "1000000000000000000", expectedOutput: "990000000000000000" },
    });
    expect(
      rec.history.map((h) => h.state),
      "the prompt is the authorization; the hash and the receipt one state",
    ).toEqual(["DRAFT", "READY_TO_REVIEW", "AWAITING_AUTHORIZATION", "SOURCE_CONFIRMING", "COMPLETED"]);
    expect(openOperations()).toEqual([]);
    expect(screen.queryByTestId("protect-technical"), "the technical lines are Advanced only").toBeNull();
    fireEvent.click(screen.getByTestId("protect-finish"));
    expect(onDone).toHaveBeenCalled();
  });
  it("WalletConnect's own refusal — getSdkError's plain {message, code: 5000} — is a declined prompt, as 4001 is: the way back to the Review, nothing open (the twelfth review round, B12-5)", async () => {
    await unlocked();
    setActiveProvider(provider());
    nativeBehaviour = "wc-rejected";
    mount();
    type(screen.getByTestId("amount-input"), "0.5");
    fireEvent.click(screen.getByTestId("protect-review"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("review-confirm"));
    });
    const error = await screen.findByTestId("operation-progress-error");
    expect(error.textContent).toContain("You declined in your wallet");
    expect(openOperations(), "never a recovery: nothing was signed").toEqual([]);
    expect(allOperations().find((r) => r.kind === "protect")).toMatchObject({ state: "READY_TO_REVIEW", declined: { code: "user_rejected" } });
  });

  it("the deposit's prompt its wallet app did not answer in time (WalletConnect's request expiry): RECOVERY_REQUIRED in its own words — the wallet app may still send it — never a quote's (the twelfth review round, A12-2)", async () => {
    await unlocked();
    setActiveProvider(provider());
    nativeBehaviour = "expired";
    mount();
    type(screen.getByTestId("amount-input"), "0.5");
    fireEvent.click(screen.getByTestId("protect-review"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("review-confirm"));
    });
    const error = await screen.findByTestId("operation-progress-error");
    expect(error.textContent).toContain(en["op.error.wallet_request_expired.title"]);
    expect(error.textContent, "a Protect has no quote").not.toMatch(/quote/i);
    expect(openOperations().find((r) => r.kind === "protect")).toMatchObject({
      state: "RECOVERY_REQUIRED",
      reason: { code: "wallet_request_expired", fundsClass: "unknown" },
    });
  });

  it("a declined wallet prompt: 'Your funds were not moved.' and the way back to the Review; a reverted receipt after submission is a final failure (FAILED, not moved)", async () => {
    await unlocked();
    setActiveProvider(provider());
    nativeBehaviour = "rejected";
    const { path } = mount();
    type(screen.getByTestId("amount-input"), "0.5");
    fireEvent.click(screen.getByTestId("protect-review"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("review-confirm"));
    });
    const error = await screen.findByTestId("operation-progress-error");
    expect(error.textContent).toContain("You declined in your wallet");
    expect(error.textContent).toContain("Your funds were not moved.");
    expect(openOperations(), "a declined prompt is a draft again — nothing was signed").toEqual([]);
    expect(allOperations().find((r) => r.kind === "protect")).toMatchObject({ state: "READY_TO_REVIEW", declined: { code: "user_rejected" } });
    expect(session.journal().operations ?? [], "and it left the journal").toEqual([]);
    fireEvent.click(screen.getByTestId("protect-back"));
    expect(path()).toBe("/protect/review");
    nativeBehaviour = "reverted";
    await act(async () => {
      fireEvent.click(screen.getByTestId("review-confirm"));
    });
    const error2 = await screen.findByTestId("operation-progress-error");
    expect(error2.textContent).toContain("The transaction reverted");
    expect(finishedOperations().find((r) => r.state === "FAILED")).toMatchObject({
      reason: { code: "receipt_reverted", fundsClass: "not-moved" },
      refs: { txHashes: [HASH] },
    });
    expect(activityOf(session.journal())).toEqual([]);
  });
  it("a protect whose outcome is not known offers Done only: no way back to the Review or the form (the audit round of 2026-10-16, c47)", async () => {
    await unlocked();
    setActiveProvider(provider());
    nativeBehaviour = "lost";
    mount();
    type(screen.getByTestId("amount-input"), "0.5");
    fireEvent.click(screen.getByTestId("protect-review"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("review-confirm"));
    });
    await screen.findByTestId("protect-done-unknown");
    expect(allOperations().find((r) => r.kind === "protect")).toMatchObject({ state: "RECOVERY_REQUIRED", reason: { fundsClass: "unknown" } });
    expect(screen.queryByTestId("protect-back"), "another protect from the form could deposit twice").toBeNull();
    expect(screen.queryByTestId("review-confirm")).toBeNull();
  });

  // the scan and its stale pass completing the record from the note: packages/sdk/test/review11-protect-scan.test.ts
  it("a deposit the connected wallet reports nothing for (the eleventh review round, F11-10): sent, its outcome unknown, and a scan planned half a minute on", async () => {
    await unlocked();
    setActiveProvider(provider());
    nativeBehaviour = "unconfirmed";
    mount();
    type(screen.getByTestId("amount-input"), "0.5");
    fireEvent.click(screen.getByTestId("protect-review"));
    const before = Date.now();
    await act(async () => {
      fireEvent.click(screen.getByTestId("review-confirm"));
    });
    await screen.findByTestId("protect-done-unknown");
    expect(allOperations().find((r) => r.kind === "protect")).toMatchObject({
      state: "RECOVERY_REQUIRED",
      reason: { code: "deposit_unconfirmed", fundsClass: "unknown" },
      // this flow's own: its note taken from the endpoints' agreed view at once (the twelfth review round, VA-N1 — never a page-gone record's)
      refs: { noteAwaited: true },
    });
    const scan = session.journal().schedule.find((a) => a.id === "discovery:pool" && !a.done);
    expect(scan?.dueAt, "the scan half a minute on").toBeGreaterThanOrEqual(before + DEPOSIT_SCAN_DELAY_MS);
    expect(scan!.dueAt).toBeLessThanOrEqual(Date.now() + DEPOSIT_SCAN_DELAY_MS);
    expect(screen.queryByTestId("protect-back"), "never a second deposit from the form").toBeNull();
  });

  it("the counters waiting on a scan that keeps failing: the confirmation asks for the scan at once, its failures counted afresh (the twelfth review round, W6 §5)", async () => {
    await unlocked();
    setActiveProvider(provider());
    nativeBehaviour = "ok";
    // the scan the counters wait on, backed off after three failures in a row
    scheduleAction({ kind: "discovery", orderId: "pool", dueAt: Date.now() + 4 * 60_000, heldFailures: 3 }, session);
    noteStore.holdCounters();
    try {
      mount();
      type(screen.getByTestId("amount-input"), "0.5");
      fireEvent.click(screen.getByTestId("protect-review"));
      const before = Date.now();
      await act(async () => {
        fireEvent.click(screen.getByTestId("review-confirm"));
      });
      await screen.findByTestId("protect-done");
      expect(engineSaw.scan, "asked for before the deposit took its counter").toBeTruthy();
      expect(engineSaw.scan!.dueAt).toBeLessThanOrEqual(engineSaw.at);
      expect(engineSaw.scan!.heldFailures ?? 0).toBe(0);
      const scan = session.journal().schedule.find((a) => a.id === "discovery:pool" && !a.done);
      expect(scan!.dueAt, "due at the confirmation").toBeGreaterThanOrEqual(before);
      expect(scan!.dueAt).toBeLessThanOrEqual(Date.now());
      expect(scan!.heldFailures ?? 0, "its failures counted afresh").toBe(0);
    } finally {
      noteStore.releaseCounters(0);
    }
  });

  it("an ERC-20 protect: the approval first (1 of 2), then the deposit, one operation; the common sizes under Advanced; the recovery-information card is shown once per session", async () => {
    await unlocked();
    setActiveProvider(provider());
    settings.set({ advanced: true });
    mount();
    fireEvent.click(screen.getByTestId("protect-from-asset"));
    const usdc = (await screen.findAllByTestId("protect-asset-selector-option")).find((b) => b.textContent?.includes("USDC"))!;
    fireEvent.click(usdc);
    expect(screen.getAllByTestId("protect-chip").map((b) => b.textContent)).toEqual([
      "100 USDC",
      "200 USDC",
      "500 USDC",
      "1,000 USDC",
      "2,000 USDC",
      "5,000 USDC",
    ]);
    fireEvent.click(screen.getAllByTestId("protect-chip")[2]);
    expect((screen.getByTestId("amount-input") as HTMLInputElement).value).toBe("500");
    expect(screen.getByTestId("protect-receive").textContent).toContain("495 USDC");
    expect(screen.getByTestId("protect-privacy-fee").textContent).toContain("5 USDC");
    fireEvent.click(screen.getByTestId("protect-review"));
    expect(screen.queryByTestId("backup-nudge"), "dismissed earlier in this session").toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId("review-confirm"));
    });
    await screen.findByTestId("protect-done");
    expect(screen.getByTestId("protect-done").textContent).toContain("Added 495 USDC to your protected balance.");
    fireEvent.click(screen.getByTestId("protect-technical-toggle"));
    expect(screen.getByTestId("protect-technical").textContent, "Advanced: the technical lines").toContain(APPROVE);
    expect(calls.erc20).toEqual([500_000_000n]);
    const [rec] = finishedOperations();
    expect(rec).toMatchObject({
      state: "COMPLETED",
      amounts: { asset: "USDC", decimals: 6, input: "500000000", expectedOutput: "495000000" },
      refs: { txHashes: [HASH], leafIndex: 8 },
    });
    expect(rec.history.find((h) => h.state === "AWAITING_AUTHORIZATION")?.note).toBe(`approval ${APPROVE}`);
  });
  it("more than the wallet holds is refused in words before the Review", async () => {
    await unlocked();
    setActiveProvider(provider());
    mount();
    await waitFor(() => expect(screen.getByTestId("protect-from").textContent).toContain("2 ETH"));
    type(screen.getByTestId("amount-input"), "3");
    expect(screen.getByTestId("protect-error").textContent).toMatch(/\w/);
    expect((screen.getByTestId("protect-review") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("protect-max"));
    // the eleventh review round (2026-11-04, E11-13): Max of ETH leaves the deposit's network fee — 3 × (120,000 gas × 20 gwei) of the 2 ETH
    await waitFor(() => expect((screen.getByTestId("amount-input") as HTMLInputElement).value).toBe("1.9928"));
    expect(screen.queryByTestId("protect-error")).toBeNull();
  });
  it("without a connected wallet the balance and the estimate are not read and the connection is offered", async () => {
    await unlocked();
    const onConnect = vi.fn();
    mount({ account: null, onConnect });
    fireEvent.click(screen.getByTestId("protect-connect"));
    expect(onConnect).toHaveBeenCalled();
    type(screen.getByTestId("amount-input"), "1");
    expect(screen.getByTestId("protect-review"), "no wallet to pay: Review stays closed (the review round of 2026-11-03, W4)").toBeDisabled();
    expect(screen.getByTestId("protect-receive").textContent).toContain("0.99 ETH");
    expect(screen.getByTestId("protect-network-fee").textContent).toMatch(/—$/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("a wallet on another network is not taken as connected: nothing is read from that chain, and the switch is offered (a V6 follow-up of 2026-10-16)", async () => {
    await unlocked();
    const onSwitch = vi.fn();
    mount({ account: null, wrongNetwork: true, onSwitch });
    expect(screen.queryByTestId("protect-connect"), "not the connection: the wallet is connected, on another network").toBeNull();
    expect(screen.getByTestId("protect-wrong-network").textContent).toBe("Your wallet is on another network.");
    fireEvent.click(screen.getByTestId("protect-switch"));
    expect(onSwitch).toHaveBeenCalled();
    type(screen.getByTestId("amount-input"), "1");
    expect(screen.getByTestId("protect-network-fee").textContent, "no estimate from that chain").toMatch(/—$/);
    expect(fetchSpy).not.toHaveBeenCalled();
    const { readFileSync } = await import("node:fs");
    const route = readFileSync(join(__dirname, "..", "src", "features", "protect", "ProtectRoute.tsx"), "utf8");
    expect(route, "the route maps the connection's wrong network").toContain("account={wrong ? null : conn.account}");
    expect(route).toContain("wrongNetwork={wrong}");
    expect(route).toContain("onSwitch={() => void connection.switchNetwork()}");
  });
  it("an unknown route under /protect returns to the page; the Review without an amount returns to the page", async () => {
    await unlocked();
    const router = createMemoryRouter(
      [{ path: "/protect/*", element: <ProtectScreen masterSeed={session.state().seed!} deployment={deployment} account={null} /> }],
      { initialEntries: ["/protect/review"], future: ROUTER_FUTURE },
    );
    render(<RouterProvider router={router} future={PROVIDER_FUTURE} />);
    await waitFor(() => expect(router.state.location.pathname).toBe("/protect"));
    await act(async () => {
      await router.navigate("/protect/elsewhere");
    });
    expect(router.state.location.pathname).toBe("/protect");
    expect(screen.getByTestId("protect-view")).toBeTruthy();
  });
});
