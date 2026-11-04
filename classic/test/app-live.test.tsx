// @vitest-environment happy-dom
// The wired app over scripted services (spec v3.0 §7.5–§7.7; V7 Stage 9): the wallet chosen and shown in the header,
// a deposit sent from the note modal when the pool is live and the record in History, a withdrawal — the note found in
// the verified history, the totals at the live gas price, the proof, the confirmation, the relayer's job in History —,
// the on-chain spent check with its disclosure; and, with the switch off, every sending button reads Not connected and
// the wallet is never asked to send.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256 } from "js-sha3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App, NOT_CONNECTED } from "../src/app/App";
import { resetRoute } from "../src/app/router";
import { createServices, type ClassicServices } from "../src/app/services/source";
import { WalletSession } from "../src/app/services/wallet";
import { applyConfig, configFromEnv } from "../src/config";
import type { DepositEvent, RawLog } from "../src/history/events";
import { formatNote, generateNote, parseNote, type ClassicNote } from "../src/model/notes";
import { fromWei } from "../src/model/format";
import { DEPLOYMENT } from "../src/model/pools";
import { memoryHistoryStore, memoryJobsStore } from "../src/storage/historyDb";
import { fakeProver, fakeRelayerTransport, fakeWalletProvider, fixtureSnapshot, hex32, scriptedChain, withdrawalLog, word } from "./helpers/fakes";
import { nullifierHashOf, toHex32 } from "../src/crypto/hashes";
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

// the pool's real code and its pins (C2-6): the live buttons need the contract verified
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

function build(live: Record<string, string[]>, o: { logs?: RawLog[][] } = {}) {
  const config = configFromEnv({ VITE_CLASSIC_LIVE: JSON.stringify(live), VITE_CLASSIC_RPC_URLS: "https://rpc.example" });
  applyConfig(config);
  const transport = fakeRelayerTransport(status.v4.body);
  const chain = scriptedChain({
    head: snap.manifest.toBlock + 200,
    logs: o.logs ?? [[]],
    // the pool shows the note spent once the relayer has the job (the tenth review round, C10-3)
    spent: () => transport.posted.length > 0,
    nextIndex: 1024,
    knownRoot: true,
    code: POOL_CODE, // the review round of 2026-11-03 (C2-6): the buttons follow the contract's verification
    calls: PIN_CALLS,
    blockHashes: { [snap.manifest.toBlock]: snap.manifest.blockHash! },
    receipts: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [hex32(BigInt(1000 + i)), { status: "0x1" as const, blockNumber: "0x1" }])),
  });
  const { prover } = fakeProver({ commitmentFor: () => deposits[5].commitment });
  const provider = fakeWalletProvider(ACCOUNT);
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
  const services: ClassicServices = createServices({
    config,
    rpc: chain.rpc,
    prover: async () => prover,
    historyStore: memoryHistoryStore(),
    jobs: memoryJobsStore(),
    // the host serves the 100 ETH pool's snapshot; the other pools would be synced from their deployed blocks
    fetchSnapshot: async (pool) => (pool === "eth-100" ? snap : null),
    relayerTransport: transport,
    curated,
    wallet,
    now: () => NOW * 1000,
    followOptions: { intervalMs: 1, sleep: async () => undefined },
    receiptOptions: { pollMs: 1, sleep: async () => undefined },
  });
  window.history.replaceState(null, "", "/classic/");
  resetRoute();
  render(<App services={services} now={NOW} />);
  return { services, provider, prover, chain };
}
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const go = (route: "deposit" | "withdraw" | "history" | "settings") =>
  fireEvent.click(screen.getByTestId(route === "history" || route === "settings" ? `classic-link-${route}` : `classic-tab-${route}`));
async function connectWallet() {
  fireEvent.click(screen.getByTestId("classic-wallet"));
  await waitFor(() => expect(screen.getByTestId("classic-wallet-fake")).toBeInTheDocument());
  fireEvent.click(screen.getByTestId("classic-wallet-fake"));
  await waitFor(() => expect(screen.getByTestId("classic-wallet")).toHaveTextContent("0x75b9…6c3e"));
}

beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

describe("the wired app", () => {
  it("connects a wallet from the header, shows its account, and lists the relayers and the availability facts from the services", async () => {
    build({});
    expect(screen.getByTestId("classic-wallet")).toHaveTextContent("Connect");
    expect(screen.getByTestId("classic-wallet")).toBeEnabled();
    await connectWallet();
    expect(screen.queryByTestId("classic-connect-modal")).not.toBeInTheDocument();
    // the availability card follows the selected pool; the scripted host serves the 100 ETH pool's snapshot
    fireEvent.click(screen.getByTestId("classic-amount-100"));
    go("settings");
    await waitFor(() => expect(screen.getByTestId("classic-availability-wallet")).toHaveTextContent("connected on Ethereum"));
    await waitFor(() => expect(screen.getByTestId("classic-availability-relayers")).toHaveTextContent("1 online"));
    await waitFor(() => expect(screen.getByTestId("classic-availability-history")).toHaveTextContent(/synced to block/));
    expect(screen.getByTestId("classic-settings-relayers")).toHaveTextContent("to-relayer.eth");
  });

  it("with the switch off, every sending button reads Not connected and the wallet is never asked to send", async () => {
    const { provider } = build({});
    await connectWallet();
    fireEvent.click(screen.getByTestId("classic-deposit-button"));
    expect(screen.getByTestId("classic-note-send")).toHaveTextContent("Not connected");
    expect(screen.getByTestId("classic-note-send")).toBeDisabled();
    fireEvent.click(screen.getByTestId("classic-note-backed"));
    expect(screen.getByTestId("classic-note-send")).toBeDisabled();
    expect(screen.getByTestId("classic-not-connected")).toHaveTextContent(NOT_CONNECTED);
    expect(provider.sent).toEqual([]);
  });

  it("a live deposit: the note backed up, Send Deposit hands the commitment to the wallet, History shows the deposit", async () => {
    const { provider } = build({ "eth-100": ["deposit"] });
    await connectWallet();
    fireEvent.click(screen.getByTestId("classic-amount-100"));
    fireEvent.click(screen.getByTestId("classic-deposit-button"));
    const note = screen.getByTestId("classic-note").textContent ?? "";
    expect(note).toMatch(/^tornado-eth-100-1-0x[0-9a-f]{124}$/);
    expect(screen.getByTestId("classic-note-send")).toBeDisabled();
    fireEvent.click(screen.getByTestId("classic-note-backed"));
    // live once the contract's verification is in (the review round of 2026-11-03, C2-6), not before
    await waitFor(() => expect(screen.getByTestId("classic-note-send")).toBeEnabled());
    expect(screen.getByTestId("classic-note-send")).toHaveTextContent("Send Deposit");
    await act(async () => {
      fireEvent.click(screen.getByTestId("classic-note-send"));
    });
    await waitFor(() => expect(screen.getByTestId("classic-deposit-message")).toHaveTextContent("handed to your wallet"));
    expect(provider.sent.length).toBe(1);
    expect((provider.sent[0] as { to: string }).to).toBe(ROUTER);
    // the deposit sent, the modal offers Close in place of Send Deposit (the fourth review round, 2026-11-03): a second tap had sent the same note again
    await waitFor(() => expect(screen.getByTestId("classic-note-close")).toBeInTheDocument());
    expect(screen.queryByTestId("classic-note-send")).toBeNull();
    // the note is nowhere but the modal
    fireEvent.click(screen.getByTestId("classic-note-close"));
    go("history");
    await waitFor(() => expect(screen.getByTestId("classic-history")).toHaveTextContent("Deposited"));
    expect(document.body.textContent).not.toContain(note.slice(-40));
  });

  it("a live withdrawal: the note found in the verified history, the totals at the live gas price, the proof, the confirmation, the relayer's job confirmed; the on-chain check with its disclosure", async () => {
    const { provider, prover } = build({ "eth-100": ["withdraw"] });
    go("withdraw");
    type(screen.getByTestId("classic-note-input"), NOTE);
    await waitFor(() => expect(screen.getByTestId("classic-fact-deposits")).toHaveTextContent("1,018 deposits"));
    await waitFor(() => expect(screen.getByTestId("classic-total-gas")).toHaveTextContent("12.0 Gwei"));
    expect(screen.getByTestId("classic-relayer-name")).toHaveTextContent("to-relayer.eth");
    expect(screen.getByTestId("classic-relayer-fee-percent")).toHaveTextContent("0.4 %");
    expect(screen.getByTestId("classic-withdraw-button")).toHaveTextContent("Withdraw");
    expect(screen.getByTestId("classic-withdraw-button")).toBeDisabled();
    type(screen.getByTestId("classic-recipient"), RECIPIENT);
    await waitFor(() => expect(screen.getByTestId("classic-withdraw-button")).toBeEnabled());
    // the explicit on-chain read, with its disclosure beside it
    expect(screen.getByTestId("classic-check-spent")).toHaveTextContent("nullifier hash");
    await act(async () => {
      fireEvent.click(screen.getByTestId("classic-check-spent-button"));
    });
    await waitFor(() => expect(screen.getByTestId("classic-spent-on-chain")).toHaveTextContent("unspent"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("classic-withdraw-button"));
    });
    await waitFor(() => {
      const said = screen.queryByTestId("classic-flow-message");
      if (said) throw new Error(`the flow said: ${said.textContent}`);
      expect(screen.getByTestId("classic-confirm-modal")).toBeInTheDocument();
    });
    expect(prover.proofs.length).toBe(1);
    expect(prover.proofs[0].recipient).toBe(BigInt(RECIPIENT).toString());
    // what the proof pays and what arrives, restated where it is confirmed; the rows behind it held at the proof's fee (the seventh review round)
    // — from the proof's own terms, and the inputs fixed while the flow runs (the tenth review round, C10-1)
    expect(screen.getByTestId("classic-confirm-recipient")).toHaveTextContent(RECIPIENT);
    expect(screen.getByTestId("classic-confirm-via")).toHaveTextContent("to-relayer.eth");
    expect(screen.getByTestId("classic-confirm-relayer-account").textContent?.toLowerCase()).toContain(status.v4.body.rewardAccount.toLowerCase().slice(0, 8));
    expect(screen.getByTestId("classic-recipient")).toBeDisabled();
    expect(screen.getByTestId("classic-note-input")).toBeDisabled();
    expect(screen.getByTestId("classic-confirm-fee")).toHaveTextContent(`${fromWei(BigInt(prover.proofs[0].fee))} ETH`);
    expect(screen.getByTestId("classic-total-fee")).toHaveTextContent(`${fromWei(BigInt(prover.proofs[0].fee))} ETH`);
    expect(screen.getByTestId("classic-confirm-receive")).toHaveTextContent("ETH");
    await act(async () => {
      fireEvent.click(screen.getByTestId("classic-confirm"));
    });
    await waitFor(() => expect(screen.getByTestId("classic-withdraw-submitted")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId("classic-flow-message")).toHaveTextContent("CONFIRMED"));
    expect(provider.sent).toEqual([]); // the relayer sent it, not the wallet
    go("history");
    await waitFor(() => expect(within(screen.getByTestId("classic-history")).getByText("Confirmed")).toBeInTheDocument());
    expect(document.body.textContent).not.toContain(NOTE.slice(-40));
    expect(document.body.textContent).not.toContain(RECIPIENT);
  });

  it("a note the history's Withdrawal events call spent still offers the on-chain check, and the pool's answer wins (the tenth review round, C10-7)", async () => {
    const parsed = parseNote(NOTE) as { ok: true; note: ClassicNote };
    const nullifierHash = toHex32(nullifierHashOf(parsed.note));
    build(
      { "eth-100": ["withdraw"] },
      { logs: [[withdrawalLog(DEPLOYMENT.pools["eth-100"].address as `0x${string}`, nullifierHash, snap.manifest.toBlock + 100)]] },
    );
    go("withdraw");
    type(screen.getByTestId("classic-note-input"), NOTE);
    await waitFor(() => expect(screen.getByTestId("classic-note-error")).toHaveTextContent("Note has been spent"));
    expect(screen.getByTestId("classic-note-spent-source")).toHaveTextContent("nullifier hash");
    await act(async () => {
      fireEvent.click(screen.getByTestId("classic-check-spent-button"));
    });
    await waitFor(() => expect(screen.getByTestId("classic-spent-on-chain")).toHaveTextContent("unspent"));
    expect(screen.queryByTestId("classic-note-error")).toBeNull();
    expect(screen.getByTestId("classic-note-facts")).toBeInTheDocument();
  });
});
