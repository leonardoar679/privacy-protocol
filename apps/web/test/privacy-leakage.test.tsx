// @vitest-environment happy-dom
// The privacy leakage gate (Privacy Wallet Web spec §20–§21; Stage 11): a wallet is created, an asset protected through
// the connected wallet's own provider, then sent to a fresh public address through the REAL engine — the tree synced
// from a mock core, the plan, the circuit inputs handed to the (mocked) prover, the relayer's terms and the
// submission, the receipt tracked — with every request body, every provider call, every transport record and every
// console line captured and read for the seed, the phrase, the keys, the private notes' secrets, the keystore and the
// forbidden field names. XHR, WebSocket, EventSource and the worker are refused; the hosts are the allow-listed ones;
// the store holds ciphertext only. The swap scenario's requests are read the same way in test/swap-flow.test.tsx.
import "fake-indexeddb/auto";
import { request as httpRequest } from "node:http";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { decodeFunctionData, getAddress, type Hex } from "viem";
import { expectedPublicSignals, publicInputsFromSignals } from "@privacy-wallet/protocol/prover";
import { TX_LEVELS, ZERO_LEAF, type CircuitInputs } from "@privacy-wallet/protocol/txInputs";
import { noteBody, noteCommitment } from "@privacy-wallet/protocol/note";
import { allowedHosts, onRequest, type RequestRecord } from "@privacy-wallet/privacy-engine/transport/http";
import { connection } from "@privacy-wallet/wallet-engine/connection";
import { allOperations, finishedOperations, resetOperationsMemory } from "@privacy-wallet/sdk/operations/store";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import { treeLayers } from "@privacy-wallet/sdk/core";
import { nativeVaultAbi } from "@privacy-wallet/sdk/privacyProtocol";
import { privacyAddress } from "@privacy-wallet/sdk/privateTx";
import { defaultRelayerUrl } from "@privacy-wallet/sdk/relayer";
import { secureStore } from "../src/storage";
import { prefs } from "../src/storage/prefs";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { startMockCore } from "./helpers/mockRpc";
import { fieldNames, FORBIDDEN_FIELDS, leaks, sessionSecrets } from "./helpers/leakage";
import { renderApp } from "./helpers/render";

// the prover: the circuit inputs are captured (they hold the secrets by design) and a proof-shaped answer with the real
// public signals comes back, so the engine's planning, submission and tracking run unchanged
const prover = vi.hoisted(() => ({ inputs: [] as CircuitInputs[] }));
vi.mock("../src/prover/client", () => ({
  artifactUrls: () => ({ wasm: "/artifacts/transaction.wasm", zkey: "/artifacts/transaction_final.zkey", verificationKey: "/artifacts/verification_key.json" }),
  PIN_URL: "/artifacts.json",
  loadPins: async () => ({}),
  resetPins: () => {},
  proveInBrowser: async (inputs: CircuitInputs) => {
    prover.inputs.push(inputs);
    const publicSignals = expectedPublicSignals(inputs);
    return { proof: ("0x" + "11".repeat(256)) as Hex, publicInputs: publicInputsFromSignals(publicSignals), publicSignals, ms: 1, verifiedLocally: false };
  },
}));

class Forbidden { constructor(...args: unknown[]) { throw new Error(`forbidden primitive used: ${JSON.stringify(args).slice(0, 80)}`); } }

const PASSWORD = "a strong password for the leakage gate";
const OWNER = getAddress("0x9858EfFD232B4033E47d90003D41EC34EcaEda94");
const ETH_VAULT = getAddress("0x00000000000000000000000000000000000000e7");
const CORE = getAddress("0x00000000000000000000000000000000000000c0");
const RELAYER_EOA = getAddress("0x00000000000000000000000000000000000000ee");
const RELAYER = defaultRelayerUrl().replace(/\/$/, "");
const relayerSeed = Uint8Array.from({ length: 32 }, (_, i) => 200 + i);

const requests: { url: string; method: string; body: string | null }[] = [];
const providerCalls: { method: string; params: unknown[] }[] = [];
const consoleLines: string[] = [];
const transportRecords: RequestRecord[] = [];
const relayerBodies: unknown[] = [];
let mock: Awaited<ReturnType<typeof startMockCore>> | null = null;
let deployment: Deployment;

const nodeFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => new Promise((resolve, reject) => {
  const u = new URL(String(input));
  const req = httpRequest({ hostname: u.hostname, port: u.port, path: u.pathname, method: init?.method ?? "GET", headers: { "content-type": "application/json" } }, (res) => {
    let body = ""; res.on("data", (c) => { body += c; }); res.on("end", () => resolve(new Response(body, { status: res.statusCode ?? 200, headers: { "content-type": "application/json" } })));
  });
  req.on("error", reject);
  if (init?.body) req.write(init.body as string);
  req.end();
});
const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json" } });

/** The full tree's root after the leaves the mock holds (the same construction as the wallet's sync). */
async function rootOf(): Promise<bigint> {
  const leaves: bigint[] = Array(mock!.state.next).fill(ZERO_LEAF);
  for (const [i, e] of Object.entries(mock!.events)) leaves[Number(i)] = e.commitment;
  return (await treeLayers(leaves, TX_LEVELS)).root;
}

/** The relayer: its terms, and a submission that "mines" the three outputs at the next leaves. */
async function relayer(pathname: string, body: unknown): Promise<Response> {
  if (pathname === "/info") return json({ chainId: 31337, core: CORE, feeVault: ETH_VAULT, relayer: RELAYER_EOA, privacyAddress: privacyAddress(relayerSeed), minFeeWei: "1000000000000000", gasPriceWei: "1000000000", gasEstimate: "400000", feeMarginBps: 1000, requireReadableFeePayload: false, inflight: 0, feePercentBps: 100, feeMinimumWei: "1000000000000000" });
  if (pathname === "/submit") {
    relayerBodies.push(body);
    const b = body as { publicInputs: string[]; noteData: [Hex, Hex, Hex] };
    const sig = publicInputsFromSignals(b.publicInputs);
    const bodies = [sig.outputBody0, sig.outputBody1, sig.outputBody2];
    const next = mock!.state.next;
    const inserted = bodies.map((nb, i) => ({ leafIndex: next + i, commitment: noteCommitment(nb, BigInt(next + i)), noteData: b.noteData[i] }));
    const txHash = ("0x" + "cd".repeat(31) + (relayerBodies.length).toString(16).padStart(2, "0")) as Hex;
    for (const l of inserted) mock!.events[l.leafIndex] = { commitment: l.commitment, noteData: l.noteData, txHash };
    mock!.state.next = next + 3;
    mock!.mine(txHash, inserted, await rootOf());
    return json({ txHash, feeWei: "1000000000000000", gas: "350000", feePayloadReadable: true });
  }
  return json({ error: "no such route" }, 404);
}

const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const body = init?.body ? String(init.body) : null;
  requests.push({ url, method: init?.method ?? "GET", body });
  if (mock && url.startsWith(mock.url)) return nodeFetch(input, init);
  if (url.startsWith(RELAYER)) return relayer(new URL(url).pathname, body ? JSON.parse(body) : undefined);
  return new Response("{}", { status: 404 });
});

/** The connected wallet: 5 ETH, a gas estimate, and deposits that "mine" at once into the mock core. */
function provider() {
  let sent = 0;
  return {
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      providerCalls.push({ method, params: params ?? [] });
      switch (method) {
        case "eth_requestAccounts": case "eth_accounts": return [OWNER];
        case "eth_chainId": return "0x7a69";
        case "eth_getBalance": return "0x" + (5n * 10n ** 18n).toString(16);
        case "eth_estimateGas": return "0x186a0";
        case "eth_gasPrice": return "0x3b9aca00";
        case "eth_sendTransaction": {
          const tx = (params as { to: string; data: Hex; value?: string }[])[0];
          const d = decodeFunctionData({ abi: nativeVaultAbi, data: tx.data });
          if (d.functionName !== "deposit") throw new Error(`unexpected call ${d.functionName}`);
          const [ownerCommitment, noteSecret, noteData] = d.args as [bigint, bigint, Hex];
          const leafIndex = mock!.state.next;
          const commitment = noteCommitment(noteBody({ vaultId: BigInt(tx.to), amount: BigInt(tx.value ?? "0x0"), ownerCommitment, noteSecret }), BigInt(leafIndex));
          const txHash = ("0x" + "ab".repeat(31) + (++sent).toString(16).padStart(2, "0")) as Hex;
          mock!.events[leafIndex] = { commitment, noteData, txHash };
          mock!.state.next = leafIndex + 1;
          mock!.mine(txHash, [{ leafIndex, commitment, noteData }], await rootOf());
          return txHash;
        }
        default: throw new Error(`unsupported ${method}`);
      }
    },
  };
}

beforeAll(() => {
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  for (const name of ["XMLHttpRequest", "WebSocket", "EventSource", "Worker", "SharedWorker"]) (globalThis as unknown as Record<string, unknown>)[name] = Forbidden;
  (navigator as unknown as Record<string, unknown>).sendBeacon = () => { throw new Error("forbidden primitive used: sendBeacon"); };
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => { consoleLines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a) ?? String(a))).join(" ")); original(...args); };
  }
});
afterEach(async () => {
  cleanup();
  session.forget(); settings.reset(); prefs().reset(); connection.reset(); noteStore.clear(); resetOperationsMemory();
  delete (window as unknown as { ethereum?: unknown }).ethereum;
  if (mock) { await mock.close(); mock = null; }
});

const type = (el: Element, v: string) => fireEvent.change(el, { target: { value: v } });
const LAZY = { timeout: 20_000 };

describe("the privacy leakage gate (spec §20–§21)", () => {
  it("create → protect → send through the real engine: no request, provider call or console line carries a secret; the worker alone sees the circuit inputs; the hosts are allow-listed; the store is ciphertext", async () => {
    mock = await startMockCore({ core: CORE, events: {}, nextLeafIndex: 0, root: 0n });
    mock.state.root = await rootOf();
    deployment = { chainId: 31337, core: CORE, ethVault: ETH_VAULT, rpcUrl: mock.url, rpcUrls: [mock.url], fromBlock: 0n, erc20Vaults: [] };
    const stopRecording = onRequest((r) => transportRecords.push(r));
    (window as unknown as { ethereum: unknown }).ethereum = provider();

    // the wallet
    const phrase = await session.create(PASSWORD);
    session.acknowledgePhrase();
    prefs().update({ firstLaunchDone: true });
    expect(requests, "creating a wallet makes no request").toHaveLength(0);

    // protect 1 ETH through the connected wallet's own provider
    await connection.connect();
    expect(connection.get().account).toBe(OWNER);
    const { router } = await renderApp("/protect", { deployment });
    await screen.findByTestId("protect", {}, LAZY);
    type(await screen.findByTestId("protect-amount-input"), "1");
    await waitFor(() => expect(screen.getByTestId("protect-submit")).toBeEnabled());
    fireEvent.click(screen.getByTestId("protect-submit"));
    await act(async () => { fireEvent.click(await screen.findByTestId("confirm-tap")); });
    await screen.findByTestId("protect-done", {}, LAZY);
    expect(noteStore.all()).toHaveLength(1);
    const deposit = providerCalls.find((c) => c.method === "eth_sendTransaction");
    expect(deposit, "the deposit went through the connected wallet").toBeTruthy();
    const relayerSoFar = requests.filter((r) => r.url.startsWith(RELAYER));
    expect(relayerSoFar.map((r) => `${r.method} ${new URL(r.url).pathname}`), "protecting asks the relayer nothing: its fee is ProtectRouter's (V6, spec v2.0 §3)").toEqual([]);

    // send 0.4 ETH to a fresh public address: the real withdrawal — sync, plan, (mocked) proof, the relayer, the receipt
    await act(async () => { await router.navigate("/send"); });
    await screen.findByTestId("send-tab", {}, LAZY);
    fireEvent.click(screen.getByTestId("send-mode-public"));
    const recipient = (await screen.findByTestId("send-to-input") as HTMLInputElement).value;
    expect(recipient).toMatch(/^0x[0-9a-fA-F]{40}$/);
    type(screen.getByTestId("send-amount-input"), "0.4");
    await screen.findByTestId("send-fees", {}, LAZY);
    fireEvent.click(screen.getByTestId("send-review"));
    const review = await screen.findByTestId("review", {}, LAZY);
    await act(async () => { fireEvent.click(within(review).getByTestId("confirm-tap")); });
    await screen.findByTestId("send-done", {}, { timeout: 60_000 });
    await waitFor(() => expect(finishedOperations().map((o) => [o.kind, o.state]), JSON.stringify(allOperations().map((o) => [o.kind, o.state, o.failure?.code, o.failure?.detail?.slice(0, 160)]))).toEqual(expect.arrayContaining([["protect", "COMPLETED"], ["withdraw", "COMPLETED"]])));
    expect(relayerBodies, "one submission").toHaveLength(1);
    expect(prover.inputs, "one proof").toHaveLength(1);
    stopRecording();

    // what must never travel, and the one thing that is public by design (a deposit's note secret, on chain in the deposit)
    const { secrets, shield } = sessionSecrets({ password: PASSWORD, phrase });
    expect(secrets.map((s) => s.name)).toEqual(expect.arrayContaining(["the seed", "the phrase (three consecutive words)", "the password", "the keystore's ciphertext or salt"]));
    expect(secrets.some((s) => /note secret at leaf/.test(s.name)), "the change note is journaled with its secret").toBe(true);
    expect(shield.values.length, "the deposit note's secret is known").toBeGreaterThan(0);

    for (const r of requests) {
      const text = `${r.url}\n${r.body ?? ""}`;
      expect(leaks(text, secrets), `${r.method} ${r.url}`).toEqual([]);
      if (r.body) {
        const names = [...fieldNames(JSON.parse(r.body))];
        expect(names.filter((n) => FORBIDDEN_FIELDS.test(n)), `${r.method} ${r.url}: field names`).toEqual([]);
      }
    }
    // the withdrawal's submission never names the deposit it spends: no deposit secret, no deposit commitment, no deposit payload
    const submission = JSON.stringify(relayerBodies[0]);
    expect(leaks(submission, [shield]), "the spent deposit's secret in the relayer submission").toEqual([]);
    const depositEvent = mock.events[0];
    for (const form of [depositEvent.commitment.toString(10), depositEvent.commitment.toString(16), depositEvent.noteData.slice(2, 66)]) expect(submission).not.toContain(form);
    expect(submission).not.toContain(OWNER.slice(2).toLowerCase());
    // the provider saw the deposit (public by design) and nothing private
    for (const c of providerCalls) expect(leaks(JSON.stringify(c), secrets), `provider ${c.method}`).toEqual([]);
    // the prover alone saw the inputs, which carry the spent deposit's secret
    expect(leaks(JSON.stringify(prover.inputs), [shield]).length, "the worker gets the circuit inputs (in-origin)").toBeGreaterThan(0);
    // the console names neither the recipient, nor the privacy address, nor a secret
    const consoleText = consoleLines.join("\n");
    expect(leaks(consoleText, secrets)).toEqual([]);
    expect(consoleText).not.toContain(recipient.slice(2, 22).toLowerCase());
    expect(consoleText).not.toMatch(/pp1[0-9a-z]{20,}/);
    // every request went to an allow-listed host, through the transport
    const hosts = new Set(requests.map((r) => new URL(r.url).hostname));
    expect([...hosts]).toEqual(["127.0.0.1"]);
    expect(allowedHosts()).toContain("127.0.0.1");
    expect(transportRecords.length).toBeGreaterThan(0);
    for (const t of transportRecords) expect(allowedHosts(), t.url).toContain(t.host);
    expect(new Set(transportRecords.map((t) => t.purpose))).toEqual(new Set(["rpc", "relayer"]));
    // the store: two ciphertext blobs, nothing in localStorage, nothing of ours in the prefs
    const store = secureStore();
    await store.flush();
    expect(store.keys()).toEqual(["pp.journal", "pp.keystore"]);
    for (const key of ["pp.journal", "pp.keystore"]) {
      const blob = store.get(key)!;
      expect(() => JSON.parse(blob)).not.toThrow();
      expect(leaks(blob, secrets.filter((s) => !/keystore/.test(s.name))), key).toEqual([]);
      expect(blob).not.toContain(recipient.slice(2).toLowerCase());
    }
    expect(localStorage.length).toBe(0);
    expect(leaks(JSON.stringify(prefs().get()), secrets)).toEqual([]);
  }, 120_000);
});
