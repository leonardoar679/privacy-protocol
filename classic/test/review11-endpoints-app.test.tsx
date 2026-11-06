// @vitest-environment happy-dom
// The eleventh review round's critique of its C11-9 and C11-12 fixes, in the wired app over a build's real services (VITE_CLASSIC_RPC_URLS
// names two endpoints, fetch stubbed per URL): a relayed withdrawal holds its pool's history from syncing from the Withdraw click to its
// end — its own record writes re-run the statistics, whose sync of a stale history had asked the second endpoint the proof's root before
// the submission — and a history an endpoint left unverified is asked again a minute later while its note is on screen.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256 } from "js-sha3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app/App";
import { resetRoute } from "../src/app/router";
import { STALE_MS } from "../src/app/services/history";
import { IN_FLIGHT_HOLD_MS } from "../src/app/services/operations";
import { createServices } from "../src/app/services/source";
import { WalletSession } from "../src/app/services/wallet";
import { applyConfig, configFromEnv } from "../src/config";
import type { DepositEvent } from "../src/history/events";
import { SELECTORS as VIEW } from "../src/history/verify";
import { formatNote, generateNote } from "../src/model/notes";
import { DEPLOYMENT } from "../src/model/pools";
import { memoryHistoryStore, memoryJobsStore } from "../src/storage/historyDb";
import { fakeProver, fakeRelayerTransport, fakeWalletProvider, fixtureSnapshot, scriptedChain, word } from "./helpers/fakes";
import status from "./fixtures/relayers/status.json";

const ROUTER = "0xd90e2f925da726b50c4ed8d0fb90ad053324f31b" as const;
const ACCOUNT = "0x75b9758bba5671c1e71c533a3fa5557f85126c3e" as const;
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const NOW = Math.floor(Date.parse("2026-10-26T12:00:00Z") / 1000);
const snap = fixtureSnapshot();
const deposits = JSON.parse(snap.texts["deposits.json"]) as DepositEvent[];
const seeded = (seed: number) => {
  let x = seed >>> 0;
  return (n: number) =>
    Uint8Array.from({ length: n }, () => {
      x = (x * 1664525 + 1013904223) >>> 0;
      return x >>> 24;
    });
};
const NOTE = formatNote(generateNote("eth", "100", 1, seeded(99)));
const POOL_CODE = (
  JSON.parse(readFileSync(join(__dirname, "..", "contracts", "verified", "pool-eth-1.json"), "utf8")) as { runtimeBytecode: { onchainBytecode: string } }
).runtimeBytecode.onchainBytecode;
const selOf = (signature: string) => "0x" + keccak256(signature).slice(0, 8);
const PIN = DEPLOYMENT.pools["eth-100"];
const PIN_CALLS: Record<string, string> = {
  [selOf("verifier()")]: `0x${PIN.verifier.slice(2).padStart(64, "0")}`,
  [selOf("levels()")]: `0x${word(PIN.levels)}`,
  [selOf("denomination()")]: `0x${word(BigInt(PIN.denominationWei))}`,
  [selOf("instances(address)")]: `0x${word(0)}${word(0)}${word(1)}${word(0)}${word(30)}`,
};
const chainOf = () =>
  scriptedChain({
    head: snap.manifest.toBlock + 200,
    logs: [[]],
    nextIndex: 1024,
    knownRoot: true,
    code: POOL_CODE,
    calls: PIN_CALLS,
    blockHashes: { [snap.manifest.toBlock]: snap.manifest.blockHash! },
  });

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
});

type Fail = (method: string, data: string | undefined) => boolean;

/** The real App over createServices with VITE_CLASSIC_RPC_URLS=A,B; `log` lists every endpoint read and the relayer's calls in order. */
function build(o: { failB?: Fail; urls?: string; postLost?: boolean } = {}) {
  const A = chainOf();
  const B = chainOf();
  const log: string[] = [];
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    const req = JSON.parse(init.body) as { id: number; method: string; params: unknown[] };
    const which = String(url).includes("a.example") ? "A" : "B";
    const chain = which === "A" ? A : B;
    const data = req.method === "eth_call" ? (req.params[0] as { data: string }).data : undefined;
    log.push(`${which}:${req.method}:${data?.slice(0, 10) ?? ""}`);
    try {
      const result = await chain.rpc(req.method, req.params);
      if (which === "B" && o.failB?.(req.method, data)) return new Response("rate limited", { status: 429 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }), { status: 200 });
    } catch (e) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: String(e) } }), { status: 200 });
    }
  }) as unknown as typeof fetch;
  const config = configFromEnv({
    VITE_CLASSIC_LIVE: JSON.stringify({ "eth-100": ["withdraw"] }),
    VITE_CLASSIC_RPC_URLS: o.urls ?? "https://a.example,https://b.example",
  });
  applyConfig(config);
  const transport = fakeRelayerTransport(status.v4.body);
  const post = transport.postJson.bind(transport);
  transport.postJson = async (url, body) => {
    log.push("RELAYER:POST");
    const answer = await post(url, body);
    // the relayer has the job, its answer lost on the way back (C2-3)
    if (o.postLost) throw new Error("The operation was aborted");
    return answer;
  };
  const getJson = transport.getJson.bind(transport);
  transport.getJson = async (url) => {
    const r = await getJson(url);
    if (url.includes("/v1/jobs/")) log.push(`RELAYER:job ${(r.body as { status: string }).status}`);
    return r;
  };
  A.options.spent = B.options.spent = () => transport.posted.length > 0;
  const { prover } = fakeProver({ commitmentFor: () => deposits[5].commitment });
  const provider = fakeWalletProvider(ACCOUNT, 1);
  const wallet = new WalletSession({ router: ROUTER, discover: async () => [{ info: { id: "fake", name: "Fake Wallet" }, provider }] });
  const curated = [
    {
      ensName: "to-relayer.eth",
      relayerAddress: status.v4.body.rewardAccount.toLowerCase(),
      url: "https://eth.to-relayer.com",
      rewardAccount: status.v4.body.rewardAccount,
      stakeTorn: "4821",
      feePercent: 0.4,
      version: "4.1.6",
      currentQueue: 0,
    },
  ];
  const clock = { ms: NOW * 1000 };
  const services = createServices({
    config,
    prover: async () => prover,
    historyStore: memoryHistoryStore(),
    jobs: memoryJobsStore(),
    fetchSnapshot: async (pool) => (pool === "eth-100" ? snap : null),
    relayerTransport: transport,
    curated,
    wallet,
    now: () => clock.ms,
    followOptions: { intervalMs: 50 },
    receiptOptions: { pollMs: 1, sleep: async () => undefined },
  });
  window.history.replaceState(null, "", "/classic/");
  resetRoute();
  render(<App services={services} now={NOW} />);
  return { A, B, log, services, transport, clock };
}
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
async function noteOnScreen() {
  fireEvent.click(screen.getByTestId("classic-tab-withdraw"));
  type(screen.getByTestId("classic-note-input"), NOTE);
  await waitFor(() => expect(screen.getByTestId("classic-fact-deposits")).toHaveTextContent("1,018 deposits"), { timeout: 30_000 });
  type(screen.getByTestId("classic-recipient"), RECIPIENT);
}

describe("a relayed withdrawal in the wired app with two endpoints (the eleventh review round's critique of C11-9 and C11-12)", () => {
  it("holds its pool's history from syncing from the Withdraw click to its end: past STALE_MS, the second endpoint hears nothing, the root posted included", async () => {
    const s = build();
    await noteOnScreen();
    await waitFor(() => expect(screen.getByTestId("classic-withdraw-button")).toBeEnabled(), { timeout: 15_000 });
    // the note was entered more than a minute before the click: the history is stale when the flow starts
    s.clock.ms += STALE_MS + 1_000;
    const mark = s.log.length;
    await act(async () => {
      fireEvent.click(screen.getByTestId("classic-withdraw-button"));
    });
    await waitFor(() => expect(screen.getByTestId("classic-confirm-modal")).toBeInTheDocument(), { timeout: 15_000 });
    // the user reads the confirmation for another minute, or a phone's proof took that long
    s.clock.ms += STALE_MS + 1_000;
    await act(async () => {
      fireEvent.click(screen.getByTestId("classic-confirm"));
    });
    await waitFor(() => expect(screen.getByTestId("classic-flow-message")).toHaveTextContent("CONFIRMED"), { timeout: 15_000 });
    // from the click to the relayer's last answer — the submission included — the flow's whole time; a sync after it ends is the page's own
    const end = s.log.lastIndexOf("RELAYER:job CONFIRMED");
    expect(s.log.slice(mark, end)).toContain("RELAYER:POST");
    expect(
      s.log.slice(mark, end + 1).filter((l) => l.startsWith("B:")),
      "the second endpoint is asked nothing from the click to the flow's end",
    ).toEqual([]);
  }, 60_000);

  it("one that ended before its relayer's outcome — its answer lost — keeps the pool held IN_FLIGHT_HOLD_MS longer: the sync after it waits, then asks both", async () => {
    const s = build({ postLost: true });
    await noteOnScreen();
    await waitFor(() => expect(screen.getByTestId("classic-withdraw-button")).toBeEnabled(), { timeout: 15_000 });
    s.clock.ms += STALE_MS + 1_000; // stale at the click: the record writes' statistics would sync it
    const mark = s.log.length;
    await act(async () => {
      fireEvent.click(screen.getByTestId("classic-withdraw-button"));
    });
    await waitFor(() => expect(screen.getByTestId("classic-confirm-modal")).toBeInTheDocument(), { timeout: 15_000 });
    await act(async () => {
      fireEvent.click(screen.getByTestId("classic-confirm"));
    });
    await waitFor(() => expect(screen.getByTestId("classic-flow-message")).toHaveTextContent("The relayer's answer did not arrive"), { timeout: 15_000 });
    await new Promise((r) => setTimeout(r, 300)); // the terminal write's statistics effect has run
    expect(s.log.slice(mark)).toContain("RELAYER:POST");
    expect(
      s.log.slice(mark).filter((l) => l.startsWith("B:")),
      "the relayer may still publish it: the second endpoint is asked nothing",
    ).toEqual([]);
    // still within the hold, past STALE_MS: a sync now would ask both — it waits (the critique: the hold's length had been tested at its ends)
    s.clock.ms += STALE_MS + 1_000;
    await act(async () => {
      await s.services.histories.get("eth-100")!.ensure();
    });
    expect(
      s.log.slice(mark).filter((l) => l.startsWith("B:")),
      "within the hold: nothing asked of the second endpoint",
    ).toEqual([]);
    // Check on chain within the hold asks the first endpoint alone, and says so
    await act(async () => {
      fireEvent.click(screen.getByTestId("classic-check-spent-button"));
    });
    await waitFor(() => expect(screen.getByTestId("classic-spent-on-chain")).toHaveTextContent("Only the first RPC endpoint was asked"));
    expect(
      s.log.slice(mark).filter((l) => l.startsWith("B:")),
      "the second endpoint not told the nullifier hash",
    ).toEqual([]);
    s.clock.ms += IN_FLIGHT_HOLD_MS + 1_000;
    await act(async () => {
      await s.services.histories.get("eth-100")!.refresh();
    });
    expect(s.log.slice(mark).filter((l) => l.startsWith("B:")).length, "past the bound, a sync asks both again").toBeGreaterThan(0);
  }, 60_000);

  it("a history an endpoint left unverified twice is asked again each minute: the button comes back after the second (the critique)", async () => {
    let silent = 2;
    build({
      failB: (m, data) => {
        if (silent === 0 || m !== "eth_call" || !data?.startsWith(VIEW.nextIndex)) return false;
        silent--;
        return true;
      },
    });
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
    await noteOnScreen();
    await waitFor(() => expect(document.body.textContent).toContain("The history is not verified yet"), { timeout: 15_000 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STALE_MS + 100);
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(screen.getByTestId("classic-withdraw-button"), "still silent at the first re-check").toBeDisabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STALE_MS + 100);
    });
    await waitFor(() => expect(screen.getByTestId("classic-withdraw-button")).toBeEnabled(), { timeout: 15_000 });
  }, 60_000);

  it("a verified history with its note on screen is never synced on its own: a page that does would have shown the second endpoint the gap a withdrawal makes", async () => {
    const s = build();
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
    await noteOnScreen();
    await waitFor(() => expect(screen.getByTestId("classic-withdraw-button")).toBeEnabled(), { timeout: 15_000 });
    const mark = s.log.length;
    for (let i = 0; i < 3; i++)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(STALE_MS + 100);
      });
    expect(s.log.slice(mark), "neither endpoint asked over three minutes").toEqual([]);
  }, 60_000);

  it("a build with no endpoint says no withdrawal can be made here, never that the history is checked again (the critique)", async () => {
    build({ urls: "" });
    fireEvent.click(screen.getByTestId("classic-tab-withdraw"));
    type(screen.getByTestId("classic-note-input"), NOTE);
    await waitFor(
      () =>
        expect(document.body.textContent).toContain(
          "No RPC endpoint is configured in this build: the pool's history cannot be verified, so no withdrawal can be made here.",
        ),
      { timeout: 30_000 },
    );
    expect(document.body.textContent).not.toContain("checked again every minute");
  }, 60_000);

  it("a history an endpoint left unverified is asked again a minute later while its note is on screen, and the Withdraw button comes back", async () => {
    let silentOnce = true;
    const s = build({
      failB: (m, data) => {
        if (!silentOnce || m !== "eth_call" || !data?.startsWith(VIEW.nextIndex)) return false;
        silentOnce = false;
        return true;
      },
    });
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
    await noteOnScreen();
    await waitFor(() => expect(document.body.textContent).toContain("The history is not verified yet"), { timeout: 15_000 });
    expect(screen.getByTestId("classic-withdraw-button")).toBeDisabled();
    expect(s.services.histories.get("eth-100")!.status).toMatchObject({
      kind: "ready",
      verified: false,
      reason: "the second RPC endpoint did not answer: the history is checked again at the next sync",
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STALE_MS + 100);
    });
    await waitFor(() => expect(screen.getByTestId("classic-withdraw-button")).toBeEnabled(), { timeout: 15_000 });
    expect(s.services.histories.get("eth-100")!.status).toMatchObject({ kind: "ready", verified: true });
  }, 60_000);
});
