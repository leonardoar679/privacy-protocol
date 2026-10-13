// @vitest-environment happy-dom
// Protect Assets (spec §3.4, §3.11, §9, §12): the connected wallet's balance read through its own provider, the common
// sizes, the fee summary with "none now", the tap to confirm, the operation record from the signature to COMPLETED
// with the leaf, a declined prompt ("Your funds were not moved."), the ERC-20 two-step events, the backup nudge once.
import "fake-indexeddb/auto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { getAddress } from "viem";
import type { EngineEvent } from "../src/features/operations/engineEvents";
import { finishedOperations, openOperations, resetOperationsMemory } from "../src/features/operations/store";
import { Protect } from "../src/features/protect/Protect";
import { setActiveProvider } from "../src/sdk/injected";
import type { Deployment } from "../src/sdk/chain";
import { prefs } from "../src/storage/prefs";
import { session } from "../src/wallet/session";
import { settings } from "../src/wallet/settings";
import { noteStore } from "../src/wallet/notes";
import { activityOf } from "../src/wallet/activity";

const HASH = ("0x" + "ab".repeat(32)) as `0x${string}`;
const APPROVE = ("0x" + "cd".repeat(32)) as `0x${string}`;
const calls: { native: unknown[]; erc20: unknown[] } = { native: [], erc20: [] };
let nativeBehaviour: "ok" | "rejected" | "reverted" = "ok";
vi.mock("../src/sdk/privateTx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/sdk/privateTx")>()),
  shieldNative: async (o: { amount: bigint; onEvent?: (e: EngineEvent) => void; onStatus?: (s: string) => void }) => {
    calls.native.push(o.amount);
    o.onStatus?.("Submitting the shield through the connected wallet (a shield is public by design)…");
    o.onEvent?.({ type: "wallet-prompt", step: "deposit", i: 1, n: 1 });
    if (nativeBehaviour === "rejected") throw Object.assign(new Error("User rejected the request."), { code: 4001 });
    o.onEvent?.({ type: "submitted", txHash: HASH, by: "wallet" });
    o.onEvent?.({ type: "waiting-receipt", txHash: HASH });
    if (nativeBehaviour === "reverted") throw new Error(`transaction ${HASH} reverted`);
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
const deployment: Deployment = { chainId: 31337, core: getAddress("0x00000000000000000000000000000000000000c0"), ethVault: getAddress("0x00000000000000000000000000000000000000e7"), rpcUrl: "http://127.0.0.1:1", rpcUrls: ["http://127.0.0.1:1"], fromBlock: 0n, erc20Vaults: [{ symbol: "USDC", decimals: 6, vault: USDC_VAULT, token: USDC }] };
const fetchSpy = vi.fn(async () => new Response("{}", { status: 404 }));
beforeAll(() => { globalThis.fetch = fetchSpy as unknown as typeof fetch; });
afterEach(() => { cleanup(); session.forget(); settings.reset(); prefs().reset(); noteStore.clear(); resetOperationsMemory(); setActiveProvider(null); calls.native = []; calls.erc20 = []; nativeBehaviour = "ok"; });

/** The connected wallet's provider: a 2 ETH balance, a gas estimate and a gas price of its own; nothing else. */
function provider() {
  const seen: string[] = [];
  const eth = {
    request: async ({ method }: { method: string }) => {
      seen.push(method);
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [OWNER];
      if (method === "eth_getBalance") return "0x" + (2n * 10n ** 18n).toString(16);
      if (method === "eth_estimateGas") return "0x" + (120_000n).toString(16);
      if (method === "eth_gasPrice") return "0x" + (20n * 10n ** 9n).toString(16);
      if (method === "eth_call") throw new Error("unexpected call");
      throw new Error(`unsupported ${method}`);
    },
    seen,
  };
  return eth;
}
async function unlocked() { await session.create("a strong password"); session.acknowledgePhrase(); }
const type = (el: HTMLElement, v: string) => fireEvent.input(el, { target: { value: v } });

describe("Protect Assets (spec §3.4)", () => {
  it("reads the wallet's balance through its provider, offers common sizes, shows the fee summary with 'none now', and a tap takes the record from the signature to COMPLETED with the leaf", async () => {
    await unlocked();
    const eth = provider();
    setActiveProvider(eth);
    const onDone = vi.fn();
    render(<Protect masterSeed={session.state().seed!} deployment={deployment} account={OWNER} onDone={onDone} />);
    await waitFor(() => expect(screen.getByTestId("protect-public-balance").textContent).toContain("2 ETH"));
    expect(screen.getByTestId("protect-connection").textContent).toContain("Connected: 0x98…da94");
    expect(screen.getAllByTestId("protect-amount-bucket").map((b) => b.textContent)).toEqual(["0.1 ETH", "0.2 ETH", "0.5 ETH", "1 ETH", "2 ETH", "5 ETH"]);
    fireEvent.click(screen.getAllByTestId("protect-amount-bucket")[3]);
    expect((screen.getByTestId("protect-amount-input") as HTMLInputElement).value).toBe("1");
    const fees = screen.getByTestId("protect-fees");
    expect(fees.textContent).toContain("You will receive");
    expect(fees.textContent).toContain("≈ 1 ETH");
    fireEvent.click(within(fees).getByRole("button", { expanded: false }));
    expect(fees.textContent).toContain("none now · 1.00 % applies when you send or swap privately");
    await waitFor(() => expect(eth.seen).toContain("eth_estimateGas"));
    expect(eth.seen).toContain("eth_gasPrice");
    expect(fetchSpy, "nothing through this wallet's endpoints for the estimate").not.toHaveBeenCalled();
    // an exact amount is nudged toward a common size
    type(screen.getByTestId("protect-amount-input"), "1.37");
    expect(screen.getByTestId("protect-use-bucket").textContent).toBe("Use 1 ETH");
    fireEvent.click(screen.getByTestId("protect-use-bucket"));
    fireEvent.click(screen.getByTestId("protect-submit"));
    const sheet = await screen.findByTestId("protect-confirm-summary");
    expect(sheet.textContent).toContain("Your connected wallet pays 1 ETH into your protected balance.");
    expect(within(sheet).getByTestId("backup-nudge").textContent).toContain("Protect your wallet");
    await act(async () => { fireEvent.click(screen.getByTestId("confirm-tap")); });
    await screen.findByTestId("protect-done");
    expect(screen.getByTestId("protect-done").textContent).toContain("Added 1 ETH to your protected balance.");
    expect(calls.native).toEqual([10n ** 18n]);
    const [rec] = finishedOperations();
    expect(rec).toMatchObject({ kind: "protect", state: "COMPLETED", refs: { txHashes: [HASH], leafIndex: 7 }, amounts: { asset: "ETH", input: "1000000000000000000" } });
    expect(rec.history.map((h) => h.state)).toEqual(["DRAFT", "REVIEW", "AWAITING_SIGNATURE", "SUBMITTED", "NETWORK_CONFIRMING", "COMPLETED"]);
    expect(openOperations()).toEqual([]);
    expect(screen.getByTestId("operation-progress").getAttribute("data-state")).toBe("COMPLETED");
    fireEvent.click(screen.getByTestId("protect-finish"));
    expect(onDone).toHaveBeenCalled();
  });
  it("a declined wallet prompt: SIGNATURE_REJECTED with 'Your funds were not moved.' and the way back; a reverted receipt after submission is a submission failure", async () => {
    await unlocked();
    setActiveProvider(provider());
    nativeBehaviour = "rejected";
    render(<Protect masterSeed={session.state().seed!} deployment={deployment} account={OWNER} />);
    type(screen.getByTestId("protect-amount-input"), "0.5");
    fireEvent.click(screen.getByTestId("protect-submit"));
    await act(async () => { fireEvent.click(await screen.findByTestId("confirm-tap")); });
    const error = await screen.findByTestId("operation-progress-error");
    expect(error.textContent).toContain("You declined in your wallet");
    expect(error.textContent).toContain("Your funds were not moved.");
    expect(error.getAttribute("data-state") ?? within(error).getByText("Your funds were not moved.").getAttribute("data-state")).toBe("not-moved");
    expect(openOperations()[0]).toMatchObject({ state: "SIGNATURE_REJECTED", failure: { code: "user_rejected", class: "not-moved" } });
    fireEvent.click(screen.getByTestId("protect-back"));
    expect(screen.getByTestId("protect-submit")).toBeInTheDocument();
    nativeBehaviour = "reverted";
    fireEvent.click(screen.getByTestId("protect-submit"));
    await act(async () => { fireEvent.click(await screen.findByTestId("confirm-tap")); });
    const error2 = await screen.findByTestId("operation-progress-error");
    expect(error2.textContent).toContain("The transaction reverted");
    expect(openOperations().find((r) => r.state === "SUBMISSION_FAILED")).toMatchObject({ failure: { code: "receipt_reverted", class: "not-moved" }, refs: { txHashes: [HASH] } });
    expect(activityOf(session.journal())).toEqual([]);
  });
  it("an ERC-20 protect: the approval first (1 of 2), then the deposit; the record notes the approval; the backup nudge is shown once per session", async () => {
    await unlocked();
    setActiveProvider(provider());
    render(<Protect masterSeed={session.state().seed!} deployment={deployment} account={OWNER} />);
    fireEvent.click(screen.getByTestId("protect-asset"));
    const usdc = (await screen.findAllByTestId("protect-asset-selector-option")).find((b) => b.textContent?.includes("USDC"))!;
    fireEvent.click(usdc);
    expect(screen.getByTestId("protect-public-note").textContent).toContain("after an exact-amount approval");
    expect(screen.getAllByTestId("protect-amount-bucket").map((b) => b.textContent)).toEqual(["100 USDC", "200 USDC", "500 USDC", "1000 USDC", "2000 USDC", "5000 USDC"]);
    type(screen.getByTestId("protect-amount-input"), "500");
    fireEvent.click(screen.getByTestId("protect-submit"));
    const sheet = await screen.findByTestId("protect-confirm-summary");
    expect(within(sheet).queryByTestId("backup-nudge"), "dismissed earlier in this session").toBeNull();
    await act(async () => { fireEvent.click(screen.getByTestId("confirm-tap")); });
    await screen.findByTestId("protect-done");
    expect(calls.erc20).toEqual([500_000_000n]);
    const [rec] = finishedOperations();
    expect(rec).toMatchObject({ state: "COMPLETED", amounts: { asset: "USDC", decimals: 6 }, refs: { txHashes: [HASH], leafIndex: 8 } });
    expect(rec.history.find((h) => h.state === "AWAITING_SIGNATURE")?.note).toBe(`approval ${APPROVE}`);
  });
  it("without a connected wallet the balance and the estimate are not read and the connect control is offered", async () => {
    await unlocked();
    const onConnect = vi.fn();
    render(<Protect masterSeed={session.state().seed!} deployment={deployment} account={null} onConnect={onConnect} />);
    expect(screen.getByTestId("protect-connection").textContent).toBe("Connect the wallet that pays the deposit");
    fireEvent.click(screen.getByTestId("protect-connect"));
    expect(onConnect).toHaveBeenCalled();
    type(screen.getByTestId("protect-amount-input"), "1");
    expect(screen.getByTestId("protect-fees").textContent).toContain("read at confirmation");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
