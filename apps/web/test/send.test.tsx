// @vitest-environment happy-dom
// Send on the V6 screens (spec v2.0 §3, §7.4, §7.6–§7.7; doc §24–§25, §58): /send the one page — the destination decides
// the kind (a privacy address: private inside the pool; an EVM address: a public exit; a Bitcoin address: a cross-chain
// send continued in Swap; another chain's address: asked first, never switched silently; a chain out of reach: refused
// in words), the four checks, "Recipient receives" largest with the privacy fee and the relayer's (exact input by
// default, exact output on the switch with what leaves the balance) — then /send/review, /send/progress/:opId, what was
// sent or the verdict. The fresh address of this wallet is one tap away in the book and reserved at the confirmation;
// the bands at $25K (the lint and the typed-in destination re-confirmed, a tap) and $60K (the hold).
import "fake-indexeddb/auto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { request as httpRequest } from "node:http";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router-dom";
import { getAddress } from "viem";
import { Providers } from "../src/app/Providers";
import { PROVIDER_FUTURE, ROUTER_FUTURE } from "../src/routes";
import type { EngineEvent } from "@privacy-wallet/sdk/operations/engineEvents";
import { finishedOperations, openOperations, resetOperationsMemory } from "@privacy-wallet/sdk/operations/store";
import { SendScreen, type SendScreenProps } from "../src/features/send/SendScreen";
import { privacyAddress } from "@privacy-wallet/sdk/privateTx";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import { priceStore } from "@privacy-wallet/sdk/prices";
import { peekFreshAddress } from "@privacy-wallet/sdk/keys/chainKeys";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { bookOf } from "@privacy-wallet/sdk/wallet/addressBook";
import { startMockCore } from "./helpers/mockRpc";

const HASH = ("0x" + "ab".repeat(32)) as `0x${string}`;
const HASH2 = ("0x" + "cd".repeat(32)) as `0x${string}`;
const calls: { transfer: { amount: bigint; recipient: string; maxMergeFee?: bigint }[]; withdraw: { amount: bigint; recipient: string }[] } = {
  transfer: [],
  withdraw: [],
};
let behaviour: "ok" | "unreachable-after-submit" | "housekeeping" | "fee-moved" = "ok";
const ENGINE_LINE = "Proof ready in 1.2 s; handing it to the relayer (your address never touches the chain)…";
let feeReads = 0; // the relayer's terms read (audit round 2, r09: "Back to review" reads them again)
let maxReads = 0; // what a spend of every note leaves after its merges, asked (audit round 2, r08)
function emit(onEvent: ((e: EngineEvent) => void) | undefined, hash: `0x${string}`, leafIndex?: number) {
  for (const e of [
    { type: "fee-terms" },
    { type: "syncing" },
    { type: "verifying" },
    { type: "proving" },
    { type: "proved", ms: 900, verifiedLocally: true },
    { type: "submitting", by: "relayer" },
    { type: "submitted", txHash: hash, by: "relayer" },
  ] as EngineEvent[])
    onEvent?.(e);
  if (behaviour === "unreachable-after-submit") throw new TypeError("fetch failed");
  onEvent?.({ type: "waiting-receipt", txHash: hash });
  onEvent?.({ type: "mined", txHash: hash, ...(leafIndex !== undefined ? { leafIndex } : {}) });
}
vi.mock("@privacy-wallet/sdk/privateTx", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@privacy-wallet/sdk/privateTx")>();
  return {
    ...orig,
    feeTerms: async () => {
      feeReads++;
      return {
        url: "http://relayer.test",
        info: { feePercentBps: 100 },
        fee: { amount: 10n ** 15n, ownerCommitment: 0n, viewPub: new Uint8Array(32), vault: 0n },
      };
    },
    maxSpendable: async () => {
      maxReads++;
      return 2_997n * 10n ** 15n; // three 1 ETH notes less the fees of the merge and of the spend
    },
    privateTransfer: async (o: {
      amount: bigint;
      recipient: string;
      maxMergeFee?: bigint;
      onEvent?: (e: EngineEvent) => void;
      onStatus?: (s: string) => void;
    }) => {
      if (behaviour === "housekeeping") throw new orig.HousekeepingNeeded(12, 8, "ETH");
      if (behaviour === "fee-moved") {
        o.onStatus?.(ENGINE_LINE); // the engine's own English progress line, before it stops
        throw new orig.FeeMoved(10n ** 15n, 2n * 10n ** 15n);
      }
      calls.transfer.push({ amount: o.amount, recipient: o.recipient, ...(o.maxMergeFee !== undefined ? { maxMergeFee: o.maxMergeFee } : {}) });
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
const OTHER = getAddress("0x1111111111111111111111111111111111111111");
const ETH_VAULT = getAddress("0x00000000000000000000000000000000000000e7");
const CORE = getAddress("0x00000000000000000000000000000000000000c0");
const ETH_FEED = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419"; // the chain-1 ETH / USD proxy of the wallet's table
const BTC = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const deployment: Deployment = {
  chainId: 31337,
  core: CORE,
  ethVault: ETH_VAULT,
  rpcUrl: "http://127.0.0.1:1",
  rpcUrls: ["http://127.0.0.1:1"],
  fromBlock: 0n,
  erc20Vaults: [],
};
/** happy-dom's fetch cannot POST to a loopback server; the price mock (the band test) is reached over node's http. */
const nodeFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
  new Promise((resolve, reject) => {
    const u = new URL(String(input));
    const req = httpRequest(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: init?.method ?? "GET", headers: (init?.headers as Record<string, string>) ?? {} },
      (res) => {
        let body = "";
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => resolve(new Response(body, { status: res.statusCode ?? 200, headers: { "content-type": "application/json" } })));
      },
    );
    req.on("error", reject);
    if (init?.body) req.write(init.body as string);
    req.end();
  });
let passThrough: string | null = null; // the price mock's URL (the band test): everything else is refused
const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
  passThrough && String(input).startsWith(passThrough) ? nodeFetch(input, init) : new Response("{}", { status: 404 }),
);
beforeAll(() => {
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
});
let closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  cleanup();
  for (const c of closers) await c();
  closers = [];
  passThrough = null;
  session.forget();
  settings.reset();
  noteStore.clear();
  resetOperationsMemory();
  priceStore.reset();
  calls.transfer = [];
  calls.withdraw = [];
  behaviour = "ok";
});

async function unlocked(balance = 3n * 10n ** 18n) {
  await session.create("a strong password");
  session.acknowledgePhrase();
  noteStore.add({ note: { vaultId: BigInt(ETH_VAULT), amount: balance, ownerCommitment: 1n, noteSecret: 2n }, leafIndex: 0, noteData: "0x", spent: false });
}
const type = (el: HTMLElement, v: string) => fireEvent.input(el, { target: { value: v } });
const typeTo = (v: string) => fireEvent.change(screen.getByTestId("address-input"), { target: { value: v } });
const otherWallet = () => {
  const seed = new Uint8Array(32);
  crypto.getRandomValues(seed);
  return privacyAddress(seed);
};
const checks = () => [...screen.getByTestId("address-checks").querySelectorAll("li")].map((li) => li.getAttribute("data-state"));
const reviewButton = () => screen.getByTestId("send-review") as HTMLButtonElement;
/** Where Send hands a cross-chain destination over: the navigation's state, as SwapRoute reads it. */
function SwapProbe() {
  const location = useLocation();
  return <pre data-testid="swap-probe">{JSON.stringify(location.state)}</pre>;
}
/** The screen under its splat route inside the providers, as the application mounts it. */
function mount(props: Partial<SendScreenProps> = {}, d: Deployment = deployment) {
  const router = createMemoryRouter(
    [
      { path: "/send/*", element: <SendScreen masterSeed={session.state().seed!} deployment={d} account={OWNER} {...props} /> },
      { path: "/swap", element: <SwapProbe /> },
    ],
    { initialEntries: ["/send"], future: ROUTER_FUTURE },
  );
  render(
    <Providers deployment={d}>
      <RouterProvider router={router} future={PROVIDER_FUTURE} />
    </Providers>,
  );
  return { router, path: () => router.state.location.pathname };
}

describe("Send (spec v2.0 §7.4)", () => {
  it("the private path: a privacy address passes the four checks; 'Recipient receives' is exact input by default and the switch turns it into exact output with what leaves the balance; the Review, a tap, the record to COMPLETED", async () => {
    await unlocked();
    const to = otherWallet();
    const { path } = mount();
    expect(checks()).toEqual(["idle", "idle", "idle", "idle"]);
    expect(reviewButton().disabled).toBe(true);
    typeTo(to);
    expect(checks()).toEqual(["ok", "ok", "ok", "ok"]);
    expect(screen.getByTestId("send-kind").textContent).toBe("Nothing about this transfer is public.");
    type(screen.getByTestId("amount-input"), "1");
    // spec v2.0 §3: 1 % of what is sent and the relayer's 0.001 on top, one fee note — 0.989 arrives
    await waitFor(() => expect(screen.getByTestId("send-receive").textContent).toContain("0.989 ETH"));
    expect(screen.getByTestId("send-privacy-fee").textContent).toContain("0.01 ETH");
    expect(screen.getByTestId("send-relayer-fee").textContent).toContain("0.001 ETH");
    expect(screen.queryByTestId("send-total"), "exact input: the typed amount is what leaves").toBeNull();
    fireEvent.click(screen.getByTestId("send-exact"));
    type(screen.getByTestId("amount-input"), "0.989");
    await waitFor(() => expect(screen.getByTestId("send-total").textContent, "exactly 0.989 arrives from the least input").toContain("1 ETH"));
    expect(screen.getByTestId("send-receive").textContent).toContain("0.989 ETH");
    fireEvent.click(screen.getByTestId("send-exact"));
    type(screen.getByTestId("amount-input"), "1");
    expect(screen.queryByTestId("send-large"), "a standard transfer").toBeNull();
    await waitFor(() => expect(reviewButton().disabled).toBe(false));
    fireEvent.click(reviewButton());
    expect(path()).toBe("/send/review");
    expect(screen.getByTestId("review-expected").textContent).toContain("0.989 ETH");
    expect(screen.getByTestId("review-fee-privacy").textContent).toContain("0.01 ETH");
    expect(screen.getByTestId("review-fee-relayer").textContent).toContain("0.001 ETH");
    expect(screen.getByTestId("review-destination").textContent).toContain(to.slice(0, 6));
    expect(screen.queryByTestId("hold-to-confirm"), "below $50K: a tap").toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId("review-confirm"));
    });
    await screen.findByTestId("send-done");
    expect(path()).toMatch(/^\/send\/progress\/send:[0-9a-z:]+$/);
    expect(screen.getByTestId("send-done").textContent).toContain("Sent 0.989 ETH privately.");
    expect(calls.transfer).toEqual([{ amount: 989n * 10n ** 15n, recipient: to }]);
    const [rec] = finishedOperations();
    expect(rec).toMatchObject({
      kind: "send",
      state: "COMPLETED",
      amounts: { asset: "ETH", input: "1000000000000000000", expectedOutput: "989000000000000000" },
      destination: { kind: "privacy-address", display: to },
      refs: { txHashes: [HASH], leafIndex: 5 },
    });
    expect(rec.history.map((h) => h.state)).toEqual(["DRAFT", "REVIEW", "AWAITING_SIGNATURE", "SUBMITTED", "CONFIRMING", "COMPLETED"]);
    expect(fetchSpy, "the relayer terms came from the mocked engine; nothing else was fetched").not.toHaveBeenCalled();
  });

  it("the public path: the fresh address of this wallet is one tap away in the book and reserved at the confirmation; after the exit the field is cleared and the next exit gets the next address", async () => {
    await unlocked();
    const seed = session.state().seed!;
    const fresh = peekFreshAddress(seed, "evm").address;
    mount();
    const [first] = screen.getAllByTestId("address-book-entry");
    expect(first.textContent).toBe("A fresh address of this wallet");
    fireEvent.click(first);
    expect((screen.getByTestId("address-input") as HTMLInputElement).value).toBe(fresh);
    expect(checks()).toEqual(["ok", "ok", "ok", "ok"]);
    expect(screen.getByTestId("send-kind").textContent).toBe("The recipient and amount become public.");
    type(screen.getByTestId("amount-input"), "1");
    await waitFor(() => expect(screen.getByTestId("send-receive").textContent).toContain("0.989 ETH"));
    fireEvent.click(reviewButton());
    expect(screen.getByTestId("review-destination").textContent).toContain("A fresh address of this wallet");
    await act(async () => {
      fireEvent.click(screen.getByTestId("review-confirm"));
    });
    await screen.findByTestId("send-done");
    expect(screen.getByTestId("send-done").textContent).toContain(`Withdrawn 0.989 ETH to ${fresh.slice(0, 6)}…`);
    expect(calls.withdraw).toEqual([{ amount: 989n * 10n ** 15n, recipient: fresh }]);
    expect(peekFreshAddress(seed, "evm").address, "the next withdrawal gets the next address").not.toBe(fresh);
    // and the book says so: Receive never offers it again as unused (audit round 2, r32)
    expect(bookOf(session.journal()).find((e) => e.address.toLowerCase() === fresh.toLowerCase())).toMatchObject({ lifecycle: "retired" });
    expect(finishedOperations()[0]).toMatchObject({
      kind: "withdraw",
      state: "COMPLETED",
      destination: { kind: "fresh", display: fresh },
      refs: { txHashes: [HASH2] },
    });
    expect(finishedOperations()[0].fees, "its fee lines keep their keys: Activity says them in the language read then (audit round 2, n91)").toEqual(
      expect.arrayContaining([expect.objectContaining({ labelKey: "screen.send.relayer" })]),
    );
    fireEvent.click(screen.getByTestId("send-again"));
    expect((screen.getByTestId("address-input") as HTMLInputElement).value, "the used address is not offered again").toBe("");
    expect((screen.getByTestId("amount-input") as HTMLInputElement).value).toBe("");
  });

  it("a Bitcoin address continues as a cross-chain send in Swap with the asset, the amount, the target and the destination handed over", async () => {
    await unlocked();
    const { path } = mount();
    type(screen.getByTestId("amount-input"), "1");
    typeTo(BTC);
    expect(checks()).toEqual(["ok", "ok"]);
    expect(screen.getByTestId("address-checks").textContent).toContain("Bitcoin address");
    expect(screen.getByTestId("send-kind").textContent).toBe("This continues as a cross-chain send to Bitcoin.");
    expect(screen.queryByTestId("send-receive"), "the swap quotes it, not this page").toBeNull();
    expect(reviewButton().textContent).toBe("Continue to the cross-chain send");
    fireEvent.click(reviewButton());
    expect(path()).toBe("/swap");
    expect(JSON.parse(screen.getByTestId("swap-probe").textContent!)).toEqual({
      prefill: { fromVault: ETH_VAULT, amount: "1", target: "BTC", destination: BTC },
    });
    expect(calls.transfer.length + calls.withdraw.length, "nothing was sent from Send").toBe(0);
  });

  it("another chain's address asks first — the network never changes silently —; a chain this wallet cannot reach is refused in words", async () => {
    await unlocked();
    const { path } = mount();
    type(screen.getByTestId("amount-input"), "1");
    typeTo(`base:${OTHER}`);
    expect(screen.getByTestId("send-other-chain").textContent).toContain("This address is on Base");
    expect(checks()[1], "not the pool's network").toBe("fail");
    expect(reviewButton().disabled).toBe(true);
    expect(path()).toBe("/send");
    // a chain out of reach: no confirmation to give, the reason in words
    typeTo(`arb1:${OTHER}`);
    expect(screen.queryByTestId("send-other-chain")).toBeNull();
    expect(screen.getByTestId("send-address-error").textContent).toBe("Sending to Arbitrum isn't available in this wallet yet. Nothing has changed.");
    expect(reviewButton().disabled).toBe(true);
    // back to Base: confirmed explicitly, then continued in Swap with the same asset on Base
    typeTo(`base:${OTHER}`);
    fireEvent.click(screen.getByTestId("send-confirm-chain"));
    expect(screen.queryByTestId("send-other-chain")).toBeNull();
    expect(reviewButton().textContent).toBe("Continue to the cross-chain send");
    fireEvent.click(reviewButton());
    expect(path()).toBe("/swap");
    expect(JSON.parse(screen.getByTestId("swap-probe").textContent!)).toEqual({
      prefill: { fromVault: ETH_VAULT, amount: "1", target: "ETH on Base", destination: OTHER },
    });
  });

  it("an address that would lose what it receives is refused, and every refusal is said in the user's language (a V6 follow-up of 2026-10-16)", async () => {
    await unlocked(10n ** 18n);
    mount();
    typeTo("0x0000000000000000000000000000000000000000");
    expect(screen.getByTestId("send-address-error").textContent).toBe("This is the zero address: what is sent to it is lost.");
    typeTo(ETH_VAULT);
    expect(screen.getByTestId("send-address-error").textContent).toBe("This is one of this wallet's own contracts: what is sent to it cannot come back.");
    const { setLocale } = await import("../src/app/i18n/messages");
    const { loadCatalog } = await import("../src/app/i18n/catalogs");
    await loadCatalog("ko");
    try {
      act(() => setLocale("ko"));
      typeTo("0x1234");
      const said = screen.getByTestId("send-address-error").textContent ?? "";
      expect(said).toBe("이더리움 주소는 0x 뒤에 40자가 이어집니다.");
      expect(said, "no English reason inside the Korean sentence").not.toMatch(/followed by|hex characters/);
    } finally {
      act(() => setLocale("en"));
    }
  });

  it("Max pressed before the destination (the amount field comes first) leaves room for the merges a spend of three notes pays (audit round 2, r08)", async () => {
    await unlocked(10n ** 18n);
    for (const leafIndex of [1, 2])
      noteStore.add({
        note: { vaultId: BigInt(ETH_VAULT), amount: 10n ** 18n, ownerCommitment: 1n, noteSecret: BigInt(10 + leafIndex) },
        leafIndex,
        noteData: "0x",
        spent: false,
      });
    mount();
    maxReads = 0;
    fireEvent.click(screen.getByTestId("amount-max"));
    await waitFor(() => expect((screen.getByTestId("amount-input") as HTMLInputElement).value).toBe("2.997"));
    expect(maxReads, "never the whole balance of 3").toBe(1);
  });

  it("a spend of three notes merges first: the Review names the merge and its fee, counts it in what leaves, and bounds it (audit round 2, r43)", async () => {
    await unlocked(10n ** 18n);
    for (const leafIndex of [1, 2])
      noteStore.add({
        note: { vaultId: BigInt(ETH_VAULT), amount: 10n ** 18n, ownerCommitment: 1n, noteSecret: BigInt(20 + leafIndex) },
        leafIndex,
        noteData: "0x",
        spent: false,
      });
    mount();
    typeTo(otherWallet());
    type(screen.getByTestId("amount-input"), "2.5");
    await waitFor(() => expect(reviewButton().disabled).toBe(false));
    fireEvent.click(reviewButton());
    // two notes cannot cover 2.5 ETH and its fee: one merge first, at the relayer's minimum
    expect(screen.getByTestId("review-fee-merges").textContent).toContain("0.001");
    await act(async () => {
      fireEvent.click(screen.getByTestId("review-confirm"));
    });
    await waitFor(() => expect(calls.transfer).toHaveLength(1));
    expect(calls.transfer[0].maxMergeFee, "the merge pays no more than the Review showed").toBe(10n ** 15n);
  });

  it("an address that is not one is refused with its reason; the connected wallet's own address is flagged; more than the protected balance is refused", async () => {
    await unlocked(10n ** 18n);
    mount();
    typeTo("0x1234");
    expect(checks()).toEqual(["fail", "idle", "ok", "fail"]);
    expect(screen.getByTestId("send-address-error").textContent).toMatch(/\w/);
    typeTo(OWNER);
    expect(screen.getByTestId("send-destination-note").textContent).toBe(
      "This is your connected wallet: sending to it links your protected balance to it publicly.",
    );
    type(screen.getByTestId("amount-input"), "2");
    await waitFor(() => expect(screen.getByTestId("send-amount-error")).toBeTruthy());
    expect(reviewButton().disabled).toBe(true);
    fireEvent.click(screen.getByTestId("amount-max"));
    expect((screen.getByTestId("amount-input") as HTMLInputElement).value).toBe("1");
    await waitFor(() => expect(screen.queryByTestId("send-amount-error")).toBeNull());
  });

  it("the bands (spec v2.0 §2): $25K gets the lint and a tap, and a typed-in public destination is re-confirmed group by group; $60K gets the hold", async () => {
    const mock = await startMockCore({
      core: CORE,
      events: {},
      nextLeafIndex: 0,
      root: 0n,
      feeds: { [ETH_FEED]: { description: "ETH / USD", answer: 2_500_00000000n, updatedAt: Math.floor(Date.now() / 1000) - 60, roundId: 3n } },
    });
    closers.push(mock.close);
    passThrough = mock.url;
    const priced: Deployment = { ...deployment, chainId: 1, rpcUrl: mock.url, rpcUrls: [mock.url] };
    await unlocked(100n * 10n ** 18n);
    await priceStore.refresh(priced, { force: true });
    expect(priceStore.state().status, priceStore.state().reason).toBe("ready");
    const { router } = mount({}, priced);
    typeTo(otherWallet());
    type(screen.getByTestId("amount-input"), "10");
    await waitFor(() => expect(screen.getByTestId("amount-usd").textContent).toContain("$25,000"));
    expect(screen.getByTestId("send-large").textContent).toContain("A large transfer: it is reviewed before it is sent.");
    await waitFor(() => expect(reviewButton().disabled).toBe(false));
    fireEvent.click(reviewButton());
    expect(screen.getByTestId("privacy-lint")).toBeTruthy();
    expect(screen.getByTestId("review-confirm"), "a tap at $25K").toBeTruthy();
    expect(screen.queryByTestId("send-destination-ack"), "a privacy address is not typed into the public").toBeNull();
    fireEvent.click(screen.getByTestId("review-edit"));
    // a typed-in public destination at $25K: confirmed group by group before the confirmation is offered
    typeTo(OTHER);
    await waitFor(() => expect(reviewButton().disabled).toBe(false));
    fireEvent.click(reviewButton());
    expect(screen.getByTestId("send-destination-groups").textContent).toBe("0x1111 1111 1111 1111 1111 1111 1111 1111 1111 1111");
    expect((screen.getByTestId("review-confirm") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("send-destination-ack-button"));
    for (const b of screen.queryAllByRole("button", { name: "I understand" })) fireEvent.click(b); // the lint's blocks for an entered destination
    expect((screen.getByTestId("review-confirm") as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      await router.navigate("/send");
    });
    type(screen.getByTestId("amount-input"), "24");
    await waitFor(() => expect(screen.getByTestId("amount-usd").textContent).toContain("$60,000"));
    fireEvent.click(reviewButton());
    expect(screen.queryByTestId("review-confirm"), "never a tap at $60K").toBeNull();
    expect(screen.getByTestId("hold-to-confirm")).toBeTruthy();
    // exact output: 19.9 ETH ($49,750) to arrive takes about 20.1 ETH ($50.2K) with the fees — the band of what leaves, the
    // hold (the audit's unverified m59)
    await act(async () => {
      await router.navigate("/send");
    });
    fireEvent.click(screen.getByTestId("send-exact"));
    type(screen.getByTestId("amount-input"), "19.9");
    await waitFor(() => expect(screen.getByTestId("send-total").textContent).toContain("20.1"));
    await waitFor(() => expect(reviewButton().disabled).toBe(false));
    fireEvent.click(reviewButton());
    expect(screen.queryByTestId("review-confirm"), "what leaves is above $50K: never a tap").toBeNull();
    expect(screen.getByTestId("hold-to-confirm")).toBeTruthy();
  });

  it("institutional: the separate device is asked after the second factor — none registered refuses the Send, never the password alone (audit round 2, r28)", async () => {
    const mock = await startMockCore({
      core: CORE,
      events: {},
      nextLeafIndex: 0,
      root: 0n,
      feeds: { [ETH_FEED]: { description: "ETH / USD", answer: 2_500_00000000n, updatedAt: Math.floor(Date.now() / 1000) - 60, roundId: 3n } },
    });
    closers.push(mock.close);
    passThrough = mock.url;
    const priced: Deployment = { ...deployment, chainId: 1, rpcUrl: mock.url, rpcUrls: [mock.url] };
    settings.set({ tiers: { enhanced: 100_000, highValue: 110_000, highValueSecondary: 120_000, institutional: 130_000 } });
    await unlocked(100n * 10n ** 18n);
    await priceStore.refresh(priced, { force: true });
    const get = vi.fn(async (o: { publicKey: { allowCredentials: { id: Uint8Array }[] } }) => ({ rawId: o.publicKey.allowCredentials[0].id.buffer }));
    Object.defineProperty(navigator, "credentials", { value: { get, create: vi.fn() }, configurable: true });
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = class {};
    const hold = async () => {
      const b = screen.getByTestId("hold-to-confirm") as HTMLButtonElement;
      expect(b.disabled).toBe(false);
      await act(async () => {
        b.dispatchEvent(new Event("pointerdown", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 120));
      });
    };
    try {
      mount({}, priced);
      typeTo(otherWallet());
      type(screen.getByTestId("amount-input"), "60");
      await waitFor(() => expect(screen.getByTestId("amount-usd").textContent).toContain("$150,000"));
      await waitFor(() => expect(reviewButton().disabled).toBe(false));
      fireEvent.click(reviewButton());
      for (const b of screen.queryAllByRole("button", { name: "I understand" })) fireEvent.click(b);
      await hold();
      // no platform authenticator registered: the password is the second factor; then the device, which has no fallback
      const box = await screen.findByTestId("second-factor-password");
      fireEvent.change(box.querySelector("input")!, { target: { value: "a strong password" } });
      fireEvent.click(screen.getByRole("button", { name: "Confirm with the password" }));
      await waitFor(() => expect(screen.getByTestId("second-device-error").textContent).toContain("no password fallback"), { timeout: 20_000 });
      expect(calls.transfer, "nothing sent").toHaveLength(0);
      expect(get).not.toHaveBeenCalled();
      // the device registered: asked with its own credential, then the Send
      act(() => settings.set({ protection: { ...settings.get().protection, secondDevice: { enabled: true, credentialId: "BAUG" } } }));
      await hold();
      await waitFor(() => expect(calls.transfer).toHaveLength(1), { timeout: 20_000 });
      expect(get).toHaveBeenCalledTimes(1);
      expect(Array.from(get.mock.calls[0][0].publicKey.allowCredentials[0].id)).toEqual([4, 5, 6]);
    } finally {
      delete (navigator as { credentials?: unknown }).credentials;
      delete (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential;
    }
  });

  it("a fee that moved past the Review's: nothing was sent, and 'Back to review' reads the relayer's terms again so the Review shows the new fee (audit round 2, r09)", async () => {
    await unlocked();
    behaviour = "fee-moved";
    const { path } = mount();
    typeTo(otherWallet());
    type(screen.getByTestId("amount-input"), "1.01");
    await waitFor(() => expect(reviewButton().disabled).toBe(false));
    fireEvent.click(reviewButton());
    await act(async () => {
      fireEvent.click(screen.getByTestId("review-confirm"));
    });
    const error = await screen.findByTestId("operation-progress-error");
    expect(error.textContent).toContain("The relayer's fee went up");
    // the engine's own line stays under Advanced (audit round 2, n85): not on the stopped page, nor as the Review's error
    expect(screen.queryByText(ENGINE_LINE)).toBeNull();
    expect(screen.queryByTestId("send-progress-line")).toBeNull();
    const before = feeReads;
    fireEvent.click(screen.getByTestId("send-back-review"));
    expect(path()).toBe("/send/review");
    await waitFor(() => expect(feeReads, "the terms read again").toBeGreaterThan(before));
    expect(screen.queryByText(ENGINE_LINE), "the Review does not show the engine's line as its error").toBeNull();
  });

  it("under Advanced, a stopped Send shows the engine's last progress line (audit round 2, n85)", async () => {
    await unlocked();
    behaviour = "fee-moved";
    act(() => settings.set({ advanced: true }));
    mount();
    typeTo(otherWallet());
    type(screen.getByTestId("amount-input"), "1.01");
    await waitFor(() => expect(reviewButton().disabled).toBe(false));
    fireEvent.click(reviewButton());
    await act(async () => {
      fireEvent.click(screen.getByTestId("review-confirm"));
    });
    await screen.findByTestId("operation-progress-error");
    expect(screen.getByTestId("send-progress-line")).toHaveTextContent(ENGINE_LINE);
  });

  it("failures: before the signature the balance is untouched and consolidation is offered; after the submission a lost relayer answer is a recovery with 'We are checking where your funds are.'", async () => {
    await unlocked();
    behaviour = "housekeeping";
    const { path } = mount();
    typeTo(otherWallet());
    type(screen.getByTestId("amount-input"), "1.01");
    await waitFor(() => expect(reviewButton().disabled).toBe(false));
    fireEvent.click(reviewButton());
    await act(async () => {
      fireEvent.click(screen.getByTestId("review-confirm"));
    });
    const error = await screen.findByTestId("operation-progress-error");
    expect(error.textContent).toContain("Your balance needs consolidating first");
    expect(error.textContent).toContain("Your funds were not moved.");
    expect(screen.getByTestId("consolidate-now")).toBeTruthy();
    expect(finishedOperations()[0], "nothing moved and nothing to track — a final failure").toMatchObject({
      state: "FAILED",
      reason: { code: "housekeeping_needed", fundsClass: "not-moved" },
    });
    fireEvent.click(screen.getByTestId("send-back-review"));
    expect(path()).toBe("/send/review");
    behaviour = "unreachable-after-submit";
    await act(async () => {
      fireEvent.click(screen.getByTestId("review-confirm"));
    });
    const error2 = await screen.findByTestId("operation-progress-error");
    expect(error2.textContent).toContain("The relayer could not be reached");
    expect(error2.textContent).toContain("We are checking where your funds are.");
    const rec = openOperations().find((r) => r.state === "RECOVERY_REQUIRED")!;
    expect(rec, "I-O6: an unknown outcome needs recovery; a send has no escrow to return — the wallet watches").toMatchObject({
      reason: { code: "relayer_unreachable", fundsClass: "unknown" },
      refs: { txHashes: [HASH] },
      recovery: { state: "monitoring" },
    });
    expect(screen.queryByText(/transaction failed/i), "I-O5: never for a submission that may have gone through").toBeNull();
    // the audit round of 2026-10-16 (c47): an unknown outcome offers no second confirmation — only Done
    expect(screen.queryByTestId("send-back-review")).toBeNull();
    expect(screen.queryByTestId("send-edit")).toBeNull();
    expect(screen.getByTestId("send-done-unknown")).toBeTruthy();
  });

  it("a confirmed Review is not shown again by browser Back: the progress took its place (audit c48)", async () => {
    await unlocked();
    const { router, path } = mount();
    typeTo(otherWallet());
    type(screen.getByTestId("amount-input"), "0.5");
    await waitFor(() => expect(reviewButton().disabled).toBe(false));
    fireEvent.click(reviewButton());
    expect(path()).toBe("/send/review");
    await act(async () => {
      fireEvent.click(screen.getByTestId("review-confirm"));
    });
    await waitFor(() => expect(path()).toMatch(/^\/send\/progress\//));
    await act(async () => {
      await router.navigate(-1);
    });
    expect(path(), "Back lands on the form, never on the confirmed Review").toBe("/send");
    expect(screen.queryByTestId("review-confirm")).toBeNull();
    expect(calls.transfer).toHaveLength(1);
  });
});
