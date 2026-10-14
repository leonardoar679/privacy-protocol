// @vitest-environment happy-dom
// Send (spec §3.5, §10, §12–§13, §16; V6 fees, spec v2.0 §3): the private path on a privacy address with the checks and
// the exact-input fee summary ("Recipient receives" computed, "You send" typed; exact-output on the switch), the Review, the record to
// COMPLETED; the public path on a fresh address with its card, the detection of a pasted privacy address, a Bitcoin
// address refused by name; the bands at $25K (Review, lint, a tap) and $60K (the hold); the verdicts of a failure
// before and after the signature.
import "fake-indexeddb/auto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { request as httpRequest } from "node:http";
import { getAddress } from "viem";
import { Providers } from "../src/app/Providers";
import type { EngineEvent } from "@privacy-wallet/sdk/operations/engineEvents";
import { finishedOperations, openOperations, resetOperationsMemory } from "@privacy-wallet/sdk/operations/store";
import { Send } from "../src/features/send/Send";
import { privacyAddress } from "@privacy-wallet/sdk/privateTx";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import { priceStore } from "@privacy-wallet/sdk/prices";
import { peekFreshAddress } from "@privacy-wallet/sdk/keys/chainKeys";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { startMockCore } from "./helpers/mockRpc";

const HASH = ("0x" + "ab".repeat(32)) as `0x${string}`;
const HASH2 = ("0x" + "cd".repeat(32)) as `0x${string}`;
const calls: { transfer: { amount: bigint; recipient: string }[]; withdraw: { amount: bigint; recipient: string }[] } = { transfer: [], withdraw: [] };
let behaviour: "ok" | "unreachable-after-submit" | "housekeeping" = "ok";
function emit(onEvent: ((e: EngineEvent) => void) | undefined, hash: `0x${string}`, leafIndex?: number) {
  for (const e of [{ type: "fee-terms" }, { type: "syncing" }, { type: "verifying" }, { type: "proving" }, { type: "proved", ms: 900, verifiedLocally: true }, { type: "submitting", by: "relayer" }, { type: "submitted", txHash: hash, by: "relayer" }] as EngineEvent[]) onEvent?.(e);
  if (behaviour === "unreachable-after-submit") throw new TypeError("fetch failed");
  onEvent?.({ type: "waiting-receipt", txHash: hash });
  onEvent?.({ type: "mined", txHash: hash, ...(leafIndex !== undefined ? { leafIndex } : {}) });
}
vi.mock("@privacy-wallet/sdk/privateTx", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@privacy-wallet/sdk/privateTx")>();
  return {
    ...orig,
    feeTerms: async () => ({ url: "http://relayer.test", info: { feePercentBps: 100 }, fee: { amount: 10n ** 15n, ownerCommitment: 0n, viewPub: new Uint8Array(32), vault: 0n } }),
    privateTransfer: async (o: { amount: bigint; recipient: string; onEvent?: (e: EngineEvent) => void }) => {
      if (behaviour === "housekeeping") throw new orig.HousekeepingNeeded(12, 8, "ETH");
      calls.transfer.push({ amount: o.amount, recipient: o.recipient });
      emit(o.onEvent, HASH, 5);
      return { txHash: HASH, proofMs: 1234, verifiedLocally: true, recipientNote: { leafIndex: 5 }, spent: [0], submittedBy: "relayer" };
    },
    privateWithdrawal: async (o: { amount: bigint; recipient: string; onEvent?: (e: EngineEvent) => void }) => {
      calls.withdraw.push({ amount: o.amount, recipient: o.recipient });
      emit(o.onEvent, HASH2);
      return { txHash: HASH2, proofMs: 900, verifiedLocally: false, spent: [0], submittedBy: "relayer" };
    },
  };
});

const OWNER = getAddress("0x9858EfFD232B4033E47d90003D41EC34EcaEda94");
const ETH_VAULT = getAddress("0x00000000000000000000000000000000000000e7");
const CORE = getAddress("0x00000000000000000000000000000000000000c0");
const ETH_FEED = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419"; // the chain-1 ETH / USD proxy of the wallet's table
const BTC = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const deployment: Deployment = { chainId: 31337, core: CORE, ethVault: ETH_VAULT, rpcUrl: "http://127.0.0.1:1", rpcUrls: ["http://127.0.0.1:1"], fromBlock: 0n, erc20Vaults: [] };
/** happy-dom's fetch cannot POST to a loopback server; the price mock (the band test) is reached over node's http. */
const nodeFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => new Promise((resolve, reject) => {
  const u = new URL(String(input));
  const req = httpRequest({ hostname: u.hostname, port: u.port, path: u.pathname, method: init?.method ?? "GET", headers: (init?.headers as Record<string, string>) ?? {} }, (res) => {
    let body = ""; res.on("data", (c) => { body += c; }); res.on("end", () => resolve(new Response(body, { status: res.statusCode ?? 200, headers: { "content-type": "application/json" } })));
  });
  req.on("error", reject);
  if (init?.body) req.write(init.body as string);
  req.end();
});
let passThrough: string | null = null; // the price mock's URL (the band test): everything else is refused
const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => (passThrough && String(input).startsWith(passThrough) ? nodeFetch(input, init) : new Response("{}", { status: 404 })));
beforeAll(() => { globalThis.fetch = fetchSpy as unknown as typeof fetch; });
let closers: (() => Promise<void>)[] = [];
afterEach(async () => { cleanup(); for (const c of closers) await c(); closers = []; passThrough = null; session.forget(); settings.reset(); noteStore.clear(); resetOperationsMemory(); priceStore.reset(); calls.transfer = []; calls.withdraw = []; behaviour = "ok"; });

async function unlocked(balance = 3n * 10n ** 18n) {
  await session.create("a strong password"); session.acknowledgePhrase();
  noteStore.add({ note: { vaultId: BigInt(ETH_VAULT), amount: balance, ownerCommitment: 1n, noteSecret: 2n }, leafIndex: 0, noteData: "0x", spent: false });
}
const type = (el: HTMLElement, v: string) => fireEvent.input(el, { target: { value: v } });
const mount = (el: React.ReactElement, d: Deployment = deployment) => render(<Providers deployment={d}>{el}</Providers>);
const otherWallet = () => { const seed = new Uint8Array(32); crypto.getRandomValues(seed); return privacyAddress(seed); };
const checks = () => [...screen.getByTestId("send-to-checks").querySelectorAll("li")].map((li) => li.getAttribute("data-state"));

describe("Send (spec §3.5)", () => {
  it("the private path: the privacy address passes the checks, the fee summary is exact-input by default (the switch flips it), the Review, then the record to COMPLETED", async () => {
    await unlocked();
    const seed = session.state().seed!;
    const to = otherWallet();
    mount(<Send masterSeed={seed} deployment={deployment} account={OWNER} />);
    expect(checks()).toEqual(["idle", "idle", "ok", "idle"]);
    type(screen.getByTestId("send-to-input"), to);
    expect(checks()).toEqual(["ok", "ok", "ok", "ok"]);
    expect(screen.getByTestId("send-privacy").textContent).toBe("● Protected");
    type(screen.getByTestId("send-amount-input"), "1");
    const fees = await screen.findByTestId("send-fees");
    // V6 (spec v2.0 §3): 1 % of what is sent and the relayer's 0.001 on top, one fee note — 0.989 arrives
    await waitFor(() => expect(fees.textContent).toContain("0.989 ETH"));
    expect(within(fees).getByText("Recipient receives")).toBeInTheDocument();
    expect(within(fees).getByText("You send")).toBeInTheDocument();
    expect(fees.textContent).toContain("1 ETH");
    fireEvent.click(within(fees).getByRole("button", { expanded: false }));
    expect(fees.textContent).toContain("Privacy fee (1.00 %)");
    expect(fees.textContent).toContain("0.01 ETH");
    expect(fees.textContent).toContain("Relayer / network");
    expect(fees.textContent).toContain("0.001 ETH");
    expect(fees.textContent, "the two parts add up; neither covers the other").not.toContain("included");
    fireEvent.click(screen.getByTestId("send-exact-output"));
    type(screen.getByTestId("send-amount-input"), "0.989");
    await waitFor(() => expect(within(fees).getByText("You pay")).toBeInTheDocument());
    await waitFor(() => expect(fees.textContent, "exactly 0.989 arrives from the least input").toContain("1 ETH"));
    fireEvent.click(screen.getByTestId("send-exact-output"));
    type(screen.getByTestId("send-amount-input"), "1");
    expect(screen.queryByTestId("send-large"), "a standard transfer").toBeNull();
    fireEvent.click(screen.getByTestId("send-review"));
    const review = await screen.findByTestId("review");
    expect(review.getAttribute("data-moment")).toBe("send");
    expect(review.textContent).toContain("Receive at least");
    await act(async () => { fireEvent.click(within(review).getByTestId("confirm-tap")); });
    await screen.findByTestId("send-done");
    expect(screen.getByTestId("send-done").textContent).toContain("Sent 0.989 ETH privately.");
    expect(calls.transfer).toEqual([{ amount: 989n * 10n ** 15n, recipient: to }]);
    const [rec] = finishedOperations();
    expect(rec).toMatchObject({ kind: "send", state: "COMPLETED", amounts: { asset: "ETH", input: "1000000000000000000", expectedOutput: "989000000000000000" }, destination: { kind: "privacy-address", display: to }, refs: { txHashes: [HASH], leafIndex: 5 } });
    expect(rec.history.map((h) => h.state)).toEqual(["DRAFT", "REVIEW", "AWAITING_SIGNATURE", "SUBMITTED", "NETWORK_CONFIRMING", "COMPLETED"]);
    expect(fetchSpy, "the relayer terms came from the mocked engine; nothing else was fetched").not.toHaveBeenCalled();
  });
  it("the public path: a fresh address of this wallet pre-filled with its card; a pasted privacy address switches to the private path; a Bitcoin address is refused by name; the withdrawal reserves the fresh address", async () => {
    await unlocked();
    const seed = session.state().seed!;
    const fresh = peekFreshAddress(seed, "evm").address;
    mount(<Send masterSeed={seed} deployment={deployment} account={OWNER} initialMode="public" />);
    const input = screen.getByTestId("send-to-input") as HTMLInputElement;
    expect(input.value).toBe(fresh);
    expect(screen.getByTestId("destination-card").textContent).toContain("A fresh address of this wallet, used once.");
    expect(screen.getByTestId("send-privacy").textContent).toContain("Reduced");
    expect(checks()).toEqual(["ok", "ok", "ok", "ok"]);
    type(input, otherWallet());
    await waitFor(() => expect(screen.getByTestId("send-privacy").textContent).toBe("● Protected"));
    expect(screen.queryByTestId("destination-card")).toBeNull();
    fireEvent.click(screen.getByTestId("send-mode-public"));
    expect((screen.getByTestId("send-to-input") as HTMLInputElement).value).toBe(fresh);
    type(screen.getByTestId("send-to-input"), BTC);
    expect(screen.getByTestId("destination-error").textContent).toContain("this looks like a Bitcoin address; the destination is Ethereum");
    expect(checks()[1]).toBe("fail");
    expect(screen.getByTestId("send-review")).toBeDisabled();
    fireEvent.click(screen.getByTestId("send-use-fresh"));
    expect(screen.queryByTestId("destination-error")).toBeNull();
    type(screen.getByTestId("send-amount-input"), "1");
    await waitFor(() => expect(screen.getByTestId("send-fees").textContent).toContain("Recipient receives"));
    expect(screen.getByTestId("send-review")).not.toBeDisabled();
    fireEvent.click(screen.getByTestId("send-review"));
    const review = await screen.findByTestId("review");
    expect(review.getAttribute("data-moment")).toBe("withdraw");
    await act(async () => { fireEvent.click(within(review).getByTestId("confirm-tap")); });
    await screen.findByTestId("send-done");
    expect(screen.getByTestId("send-done").textContent).toContain(`Withdrawn 0.989 ETH to ${fresh.slice(0, 8)}…`);
    expect(calls.withdraw).toEqual([{ amount: 989n * 10n ** 15n, recipient: fresh }]);
    expect(peekFreshAddress(seed, "evm").address, "the next withdrawal gets the next address").not.toBe(fresh);
    expect(finishedOperations()[0]).toMatchObject({ kind: "withdraw", state: "COMPLETED", destination: { kind: "fresh", display: fresh }, refs: { txHashes: [HASH2] } });
  });
  it("the bands (spec §11): $25K gets the Review with the lint and a tap; $60K gets the hold", async () => {
    const mock = await startMockCore({ core: CORE, events: {}, nextLeafIndex: 0, root: 0n, feeds: { [ETH_FEED]: { description: "ETH / USD", answer: 2_500_00000000n, updatedAt: Math.floor(Date.now() / 1000) - 60, roundId: 3n } } });
    closers.push(mock.close);
    passThrough = mock.url;
    const priced: Deployment = { ...deployment, chainId: 1, rpcUrl: mock.url, rpcUrls: [mock.url] };
    await unlocked(100n * 10n ** 18n);
    await priceStore.refresh(priced, { force: true });
    expect(priceStore.state().status, priceStore.state().reason).toBe("ready");
    const seed = session.state().seed!;
    mount(<Send masterSeed={seed} deployment={priced} account={OWNER} />, priced);
    type(screen.getByTestId("send-to-input"), otherWallet());
    type(screen.getByTestId("send-amount-input"), "10");
    await waitFor(() => expect(screen.getByTestId("send-amount-usd").textContent).toContain("$25,000"));
    expect(screen.getByTestId("send-large").textContent).toContain("A large transfer: it is reviewed before it is sent.");
    expect(screen.getByTestId("privacy-lint")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("send-review"));
    let review = await screen.findByTestId("review");
    expect(review.textContent).toContain("Large transfer");
    expect(within(review).getByTestId("confirm-tap"), "a tap at $25K").toBeInTheDocument();
    fireEvent.click(within(review).getByRole("button", { name: "Back" }));
    type(await screen.findByTestId("send-amount-input"), "24");
    await waitFor(() => expect(screen.getByTestId("send-amount-usd").textContent).toContain("$60,000"));
    fireEvent.click(screen.getByTestId("send-review"));
    review = await screen.findByTestId("review");
    expect(review.textContent).toContain("Protected transfer");
    expect(within(review).queryByTestId("confirm-tap"), "never a tap at $60K").toBeNull();
    expect(within(review).getByTestId("hold-to-confirm")).toBeInTheDocument();
  });
  it("failures: before the signature the balance is untouched and consolidation is offered; after the submission a lost relayer answer is a recovery with 'We are checking where your funds are.'", async () => {
    await unlocked();
    const seed = session.state().seed!;
    behaviour = "housekeeping";
    mount(<Send masterSeed={seed} deployment={deployment} account={OWNER} />);
    type(screen.getByTestId("send-to-input"), otherWallet());
    type(screen.getByTestId("send-amount-input"), "1.01");
    await screen.findByTestId("send-fees");
    fireEvent.click(screen.getByTestId("send-review"));
    await act(async () => { fireEvent.click(within(await screen.findByTestId("review")).getByTestId("confirm-tap")); });
    const error = await screen.findByTestId("operation-progress-error");
    expect(error.textContent).toContain("Your balance needs consolidating first");
    expect(error.textContent).toContain("Your funds were not moved.");
    expect(screen.getByTestId("consolidate-now")).toBeInTheDocument();
    expect(openOperations()[0]).toMatchObject({ state: "SUBMISSION_FAILED", failure: { code: "housekeeping_needed", class: "not-moved" } });
    fireEvent.click(screen.getByTestId("send-back-review"));
    behaviour = "unreachable-after-submit";
    await act(async () => { fireEvent.click(within(await screen.findByTestId("review")).getByTestId("confirm-tap")); });
    const error2 = await screen.findByTestId("operation-progress-error");
    expect(error2.textContent).toContain("The relayer could not be reached");
    expect(error2.textContent).toContain("We are checking where your funds are.");
    const rec = openOperations().find((r) => r.state === "RECOVERY_REQUIRED")!;
    expect(rec).toMatchObject({ failure: { code: "relayer_unreachable", class: "unknown" }, refs: { txHashes: [HASH] }, recovery: { state: "refund-offered" } });
    expect(screen.queryByText(/transaction failed/i), "I-O5: never for a submission that may have gone through").toBeNull();
  });
});
