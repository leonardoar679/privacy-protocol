// @vitest-environment happy-dom
// The Classic screens on the Stage 3 mock (spec v3.0 §7.9, §7.11): the original's deposit flow — the four amounts, the
// Statistics of the selected pool, the note shown once with its warnings, Copy and Save, the backup checkbox gating
// Send Deposit, "Not connected" while the pool is not live —; the withdraw flow — a found note's facts and totals at
// the mock's gas price, the settings (Relayer | Wallet and its warning), the errors, the recipient and Donate —;
// History; Settings with the language stored as the only preference; the banner and no promise word on every route; a
// note never in the page after the modal closes, never in the URL, never in storage.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App, NOT_CONNECTED } from "../src/app/App";
import { resetRoute } from "../src/app/router";
import { applyConfig, configFromEnv, type ClassicConfig } from "../src/config";
import { FIXTURE_NOTE, mockSource, SPENT_NOTE } from "../src/model/mock";
import { formatNote } from "../src/model/notes";
import type { HistoryRow } from "../src/model/types";
import { STORAGE_KEYS } from "../src/storage/prefs";
import { WithdrawTab, type WithdrawProps } from "../src/views/Withdraw";
import { Statistics } from "../src/views/Statistics";
import { History } from "../src/views/History";
import { FIXTURES, NOW } from "../src/fixtures/registry";
import { scan } from "../scripts/words.mjs";

const DONATION = "0x2222222222222222222222222222222222222222";
const NOTE = formatNote(FIXTURE_NOTE);

function setup(env: Record<string, unknown> = {}, history: HistoryRow[] = []) {
  applyConfig(configFromEnv(env));
  window.history.replaceState(null, "", "/classic/");
  resetRoute();
  return render(<App source={mockSource({ now: NOW, history })} now={NOW} />);
}
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const go = (route: "deposit" | "withdraw" | "history" | "settings") =>
  fireEvent.click(screen.getByTestId(route === "history" || route === "settings" ? `classic-link-${route}` : `classic-tab-${route}`));

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  window.localStorage.clear();
});

describe("the deposit tab", () => {
  it("shows the banner, the four amounts and the Statistics of the selected pool", async () => {
    setup();
    expect(screen.getByTestId("classic-not-connected")).toHaveTextContent(NOT_CONNECTED);
    expect(screen.getByTestId("classic-not-connected")).toHaveAttribute("role", "status");
    expect(screen.getByTestId("classic-wallet")).toHaveTextContent("Not connected");
    expect(screen.getByTestId("classic-wallet")).toBeDisabled();
    for (const a of ["0.1", "1", "10", "100"]) expect(screen.getByTestId(`classic-amount-${a}`)).toHaveTextContent(`${a} ETH`);
    expect(screen.getByTestId("classic-amount-0.1")).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(screen.getByTestId("classic-stats-set")).toHaveTextContent("75,154 equal user deposits"));
    fireEvent.click(screen.getByTestId("classic-amount-10"));
    expect(screen.getByTestId("classic-amount-10")).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(screen.getByTestId("classic-stats-set")).toHaveTextContent("78,767 equal user deposits"));
    expect(screen.getByTestId("classic-stats-pool")).toHaveTextContent("10 ETH");
    expect(within(screen.getByTestId("classic-stats-latest")).getAllByRole("listitem")).toHaveLength(10);
    expect(screen.getByTestId("classic-stats-latest")).toHaveTextContent("7 minutes");
  });

  it("Deposit shows the note once with its warnings; the send reads Not connected while the pool is not live; the note leaves with the modal", async () => {
    setup();
    fireEvent.click(screen.getByTestId("classic-amount-10"));
    fireEvent.click(screen.getByTestId("classic-deposit-button"));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAccessibleName("Your private note");
    const note = screen.getByTestId("classic-note").textContent ?? "";
    expect(note).toMatch(/^tornado-eth-10-1-0x[0-9a-f]{124}$/);
    expect(dialog).toHaveTextContent("Please back up your note. You will need it later to withdraw your deposit.");
    expect(dialog).toHaveTextContent("Treat your note as a private key");
    expect(screen.getByTestId("classic-note-copy")).toHaveTextContent("Copy");
    expect(screen.getByTestId("classic-note-save")).toHaveTextContent("Save as a file");
    expect(screen.getByTestId("classic-note-file")).toHaveTextContent(
      `backup-tornado-eth-10-1-${note.slice(2 + "tornado-eth-10-1-".length, 2 + "tornado-eth-10-1-".length + 10)}.txt`,
    );
    const send = screen.getByTestId("classic-note-send");
    expect(send).toBeDisabled();
    expect(send).toHaveTextContent("Not connected");
    expect(screen.queryByTestId("classic-note-warning")).toBeNull();
    fireEvent.click(screen.getByTestId("classic-note-backed"));
    expect(screen.getByTestId("classic-note-warning")).toHaveTextContent("Your note won't be saved in your browser. Please make sure it's backed up!");
    expect(send).toBeDisabled();
    // the whole modal reads no promise word
    expect(scan(dialog.textContent ?? "")).toEqual([]);
    // Escape closes it; the note is gone from the page, never in the URL, never in storage
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.textContent).not.toContain(note.slice(-40));
    expect(window.location.href).not.toContain(note.slice(-40));
    expect(window.localStorage.length).toBe(0);
  });

  it("a live deposit pool enables Send Deposit only after the backup is confirmed", () => {
    setup({ VITE_CLASSIC_LIVE: JSON.stringify({ "eth-0.1": ["deposit"] }) });
    fireEvent.click(screen.getByTestId("classic-deposit-button"));
    const send = screen.getByTestId("classic-note-send");
    expect(send).toHaveTextContent("Send Deposit");
    expect(send).toBeDisabled();
    fireEvent.click(screen.getByTestId("classic-note-backed"));
    expect(send).toBeEnabled();
    fireEvent.click(screen.getByTestId("classic-note-modal-close"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the withdraw tab", () => {
  it("a found note shows its facts and the totals at the mock's gas price; the Withdraw reads Not connected", async () => {
    setup();
    go("withdraw");
    expect(screen.getByTestId("classic-withdraw")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Please enter your note")).toBeInTheDocument();
    type(screen.getByTestId("classic-note-input"), NOTE);
    await waitFor(() => expect(screen.getByTestId("classic-note-facts")).toBeInTheDocument());
    expect(screen.getByTestId("classic-fact-amount")).toHaveTextContent("1 ETH");
    expect(screen.getByTestId("classic-fact-time")).toHaveTextContent("2 days");
    expect(screen.getByTestId("classic-fact-deposits")).toHaveTextContent("431 deposits");
    expect(screen.queryByTestId("classic-warn-time")).toBeNull();
    expect(screen.queryByTestId("classic-warn-deposits")).toBeNull();
    // the statistics follow the note's pool
    await waitFor(() => expect(screen.getByTestId("classic-stats-pool")).toHaveTextContent("1 ETH"));
    expect(screen.getByTestId("classic-relayer-name")).toHaveTextContent("relayer-one.eth");
    expect(screen.getByTestId("classic-relayer-fee-percent")).toHaveTextContent("0.3 %");
    expect(screen.getByTestId("classic-total-balance")).toHaveTextContent("1 ETH");
    expect(screen.getByTestId("classic-total-gas")).toHaveTextContent("12.0 Gwei");
    expect(screen.getByTestId("classic-total-network")).toHaveTextContent("0.0066 ETH");
    expect(screen.getByTestId("classic-total-relayer")).toHaveTextContent("0.003 ETH");
    expect(screen.getByTestId("classic-total-fee")).toHaveTextContent("0.0096 ETH");
    expect(screen.getByTestId("classic-total-receive")).toHaveTextContent("0.9904 ETH");
    const button = screen.getByTestId("classic-withdraw-button");
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("Not connected");
    expect(window.location.href).not.toContain(NOTE.slice(-40));
  });

  it("the withdrawal settings: Relayer | Wallet; wallet mode shows the gas warning and the full note balance; another relayer, another fee", async () => {
    setup();
    go("withdraw");
    type(screen.getByTestId("classic-note-input"), NOTE);
    await waitFor(() => expect(screen.getByTestId("classic-settings-toggle")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("classic-settings-toggle"));
    const settings = screen.getByTestId("classic-withdraw-settings");
    expect(within(settings).getByTestId("classic-mode-relayer")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("classic-relayer-list")).toHaveTextContent("relayer-one.eth");
    expect(screen.getByTestId("classic-relayer-three")).toBeDisabled();
    expect(screen.getByTestId("classic-ip-notice")).toHaveTextContent("IP address");
    fireEvent.click(screen.getByTestId("classic-relayer-two"));
    expect(screen.getByTestId("classic-relayer-fee-percent")).toHaveTextContent("0.5 %");
    expect(screen.getByTestId("classic-total-relayer")).toHaveTextContent("0.005 ETH");
    expect(screen.getByTestId("classic-total-receive")).toHaveTextContent("0.9884 ETH");
    fireEvent.click(screen.getByTestId("classic-mode-wallet"));
    expect(screen.getByTestId("classic-wallet-warning")).toHaveTextContent("not linkable to ANY of your addresses");
    expect(screen.queryByTestId("classic-relayer-total")).toBeNull();
    expect(screen.queryByTestId("classic-total-gas")).toBeNull();
    expect(screen.getByTestId("classic-total-receive")).toHaveTextContent("1 ETH");
  });

  it("names the errors: spent, invalid, no related deposit, another network, a pool this app does not serve", async () => {
    setup();
    go("withdraw");
    const input = screen.getByTestId("classic-note-input");
    type(input, formatNote(SPENT_NOTE));
    await waitFor(() => expect(screen.getByTestId("classic-note-error")).toHaveTextContent("Note has been spent"));
    expect(screen.queryByTestId("classic-note-facts")).toBeNull();
    expect(input).toHaveAttribute("aria-invalid", "true");
    type(input, "tornado-eth-1-1-0xnot-a-note");
    expect(screen.getByTestId("classic-note-error")).toHaveTextContent("Note is invalid");
    type(input, formatNote({ ...FIXTURE_NOTE, amount: "100" }));
    // a miss says what the history holds, never "the note is invalid" (the tenth review round, C10-2)
    await waitFor(() => expect(screen.getByTestId("classic-note-error")).toHaveTextContent("No deposit with this note was found in the pool's history."));
    expect(screen.getByTestId("classic-note-error")).not.toHaveTextContent(/invalid/);
    type(input, formatNote({ ...FIXTURE_NOTE, netId: 5 }));
    await waitFor(() =>
      expect(screen.getByTestId("classic-note-error")).toHaveTextContent("Your note is from another network, please change network in the app."),
    );
    type(input, formatNote({ ...FIXTURE_NOTE, amount: "7" }));
    await waitFor(() => expect(screen.getByTestId("classic-note-error")).toHaveTextContent("This note names a pool this app does not serve."));
    type(input, "");
    expect(screen.queryByTestId("classic-note-error")).toBeNull();
    expect(input).not.toHaveAttribute("aria-invalid");
  });

  it("the recipient: invalid text is named; Donate fills the configured address; without one there is no Donate", () => {
    const first = setup({ VITE_CLASSIC_DONATION_ADDRESS: DONATION });
    go("withdraw");
    const recipient = screen.getByTestId("classic-recipient") as HTMLInputElement;
    expect(recipient).toHaveAttribute("placeholder", "Please paste address here");
    type(recipient, "0x1234");
    expect(screen.getByTestId("classic-recipient-error")).toHaveTextContent("Recipient address is invalid");
    // a recipient a withdrawal must not go to (the fourth review round, 2026-11-03): named before anything else is asked
    type(recipient, "0x0000000000000000000000000000000000000000");
    expect(screen.getByTestId("classic-recipient-error")).toHaveTextContent("The zero address: a withdrawal sent there is lost.");
    type(recipient, "0x000000000000000000000000000000000000dEaD");
    expect(screen.getByTestId("classic-recipient-error")).toHaveTextContent("A burn address: a withdrawal sent there is lost.");
    type(recipient, "0xd90e2f925da726b50c4ed8d0fb90ad053324f31b"); // the router
    expect(screen.getByTestId("classic-recipient-error")).toHaveTextContent(
      "A contract of the pools, the router or the verifier: a withdrawal sent there cannot come back.",
    );
    fireEvent.click(screen.getByTestId("classic-donate"));
    expect(recipient.value).toBe(DONATION);
    expect(screen.queryByTestId("classic-recipient-error")).toBeNull();
    first.unmount();
    setup();
    go("withdraw");
    expect(screen.queryByTestId("classic-donate")).toBeNull();
  });

  it("a young deposit warns twice; a fee above the note is refused; a live pool shows Generating proof and the confirmation", () => {
    const base: WithdrawProps = {
      ...(FIXTURES.find((f) => f.id === "classic-withdraw-young") ? {} : {}),
      text: NOTE,
      onText: () => undefined,
      checking: false,
      lookup: {
        kind: "found",
        pool: "eth-1",
        facts: { leafIndex: 1, timestamp: NOW - 3 * 3_600, blockNumber: 1, txHash: "0x00", depositsSince: 2, spent: false },
      },
      malformed: false,
      now: NOW,
      recipient: "",
      onRecipient: () => undefined,
      recipientInvalid: false,
      donate: false,
      onDonate: () => undefined,
      mode: "relayer",
      onMode: () => undefined,
      relayers: [],
      relayerId: null,
      onRelayer: () => undefined,
      settingsOpen: false,
      onToggleSettings: () => undefined,
      fees: null,
      canWithdraw: false,
      live: false,
      onWithdraw: () => undefined,
      proving: false,
      confirmOpen: false,
      onConfirm: () => undefined,
      onCancelConfirm: () => undefined,
      submitted: false,
    };
    const { rerender } = render(<WithdrawTab {...base} />);
    expect(screen.getByTestId("classic-warn-time")).toHaveTextContent("we recommend waiting for at least 24 hours");
    expect(screen.getByTestId("classic-warn-deposits")).toHaveTextContent("at least 5 deposits after yours");
    expect(screen.getByTestId("classic-fact-deposits")).toHaveTextContent("2 deposits");
    rerender(<WithdrawTab {...base} fees={{ gasPriceWei: 1n, networkFeeWei: 2n, relayerFeeWei: 3n, totalFeeWei: 5n, receiveWei: -1n }} />);
    expect(screen.getByTestId("classic-not-enough")).toHaveTextContent("The total fee is higher than the amount of tokens to be received.");
    rerender(<WithdrawTab {...base} live proving canWithdraw />);
    expect(screen.getByTestId("classic-withdraw-button")).toHaveTextContent("Generating proof");
    expect(screen.getByTestId("classic-withdraw-button")).toBeDisabled();
    rerender(<WithdrawTab {...base} live confirmOpen />);
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Withdrawal Confirmation");
    expect(screen.getByTestId("classic-confirm-text")).toHaveTextContent(
      "Your zk-Snark proof has been successfully generated! Please click Confirm to initiate the withdrawal",
    );
    expect(screen.getByTestId("classic-confirm")).toHaveTextContent("Confirm");
  });
});

describe("History and Settings", () => {
  const rows: HistoryRow[] = [
    {
      id: "d1",
      kind: "deposit",
      pool: "eth-1",
      timestamp: NOW - 2 * 86_400,
      txHash: "0x7c1e4d9a0f3b58e2a6d44f1b9c0e7a2d5b8f3c6e1a9d2b4f7c0e8a1d3b6f9c2e",
      status: "deposited",
      depositsSince: 431,
      spent: false,
    },
    {
      id: "w1",
      kind: "withdrawal",
      pool: "eth-10",
      timestamp: NOW - 3_600,
      txHash: "0x1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809",
      status: "CONFIRMED",
      spent: true,
    },
    { id: "w2", kind: "withdrawal", pool: "eth-0.1", timestamp: NOW - 600, status: "FAILED" },
    { id: "d2", kind: "deposit", pool: "eth-100", timestamp: NOW - 120, status: "waiting" },
  ];

  it("History: the empty words; the rows with their status words and shortened hashes; the Spent / Unspent filters", async () => {
    const empty = setup();
    go("history");
    expect(screen.getByTestId("classic-history-empty")).toHaveTextContent("There are no transactions yet.");
    empty.unmount();
    setup({}, rows);
    go("history");
    await waitFor(() => expect(screen.getByTestId("classic-tx-d1")).toBeInTheDocument());
    const list = screen.getByTestId("classic-history");
    expect(list).toHaveTextContent("Deposited");
    expect(list).toHaveTextContent("Confirmed");
    expect(list).toHaveTextContent("Failed");
    expect(list).toHaveTextContent("Waiting for receipt");
    expect(list).toHaveTextContent("0x7c1e4d…6f9c2e");
    expect(list.textContent).not.toMatch(/0x[0-9a-f]{64}/);
    expect(screen.getByTestId("classic-tx-d1")).toHaveTextContent("431 deposits");
    expect(screen.getByTestId("classic-tx-d2")).toHaveTextContent("pending");
    fireEvent.click(screen.getByTestId("classic-filter-spent"));
    expect(screen.queryByTestId("classic-tx-d1")).toBeNull();
    expect(screen.getByTestId("classic-tx-w1")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("classic-filter-unspent"));
    expect(screen.getByTestId("classic-tx-d1")).toBeInTheDocument();
    expect(screen.queryByTestId("classic-tx-w1")).toBeNull();
  });

  it("History: the device note, and Clear history empties the records (the fourth review round, 2026-11-03)", async () => {
    setup({}, [...rows]);
    go("history");
    await waitFor(() => expect(screen.getByTestId("classic-tx-d1")).toBeInTheDocument());
    expect(screen.getByTestId("classic-history-note")).toHaveTextContent("These records are this device's");
    expect(screen.getByTestId("classic-history-note")).toHaveTextContent("Deposits are listed for this page only.");
    fireEvent.click(screen.getByTestId("classic-history-clear"));
    await waitFor(() => expect(screen.getByTestId("classic-history-empty")).toBeInTheDocument());
    expect(screen.queryByTestId("classic-tx-d1")).toBeNull();
  });

  it("History says when its records live in this page only; an unverified history's statistics are marked not verified against the chain (the eleventh review round's critique of C11-5 and C11-13)", () => {
    applyConfig(configFromEnv({}));
    render(<History rows={rows} filter="all" onFilter={() => undefined} now={NOW} onClear={() => undefined} pageOnly />);
    expect(screen.getByTestId("classic-history-note")).toHaveTextContent(
      "These records are kept for this page only: this browser refused the device's storage.",
    );
    expect(screen.getByTestId("classic-history-note")).not.toHaveTextContent("kept until you clear them");
    const { unmount } = render(<Statistics pool="eth-100" stats={{ deposits: 1024, latest: [], verified: false }} now={NOW} />);
    expect(screen.getByTestId("classic-stats-unverified")).toHaveTextContent("not verified against the chain");
    unmount();
    // no mark for a verified history, nor for statistics that carry no verdict (the mock's, the fixtures')
    const verified = render(<Statistics pool="eth-100" stats={{ deposits: 1024, latest: [], verified: true }} now={NOW} />);
    expect(screen.queryByTestId("classic-stats-unverified")).toBeNull();
    verified.unmount();
    render(<Statistics pool="eth-100" stats={{ deposits: 1024, latest: [] }} now={NOW} />);
    expect(screen.queryByTestId("classic-stats-unverified")).toBeNull();
  });

  it("Settings: no RPC in this build, the relayers, the honest availability rows; the language is the only thing stored", async () => {
    setup();
    go("settings");
    expect(screen.getByTestId("classic-rpc-none")).toHaveTextContent("No RPC endpoint is configured in this build");
    await waitFor(() => expect(screen.getByTestId("classic-settings-relayers")).toHaveTextContent("relayer-three.eth"));
    await waitFor(() => expect(screen.getByTestId("classic-availability-contract")).toHaveTextContent("not verified in this build"));
    expect(screen.getByTestId("classic-availability-relayers")).toHaveTextContent("scripted");
    expect(screen.getByTestId("classic-availability-prover")).toHaveTextContent("not in this build");
    expect(screen.getByTestId("classic-availability-deposit")).toHaveTextContent("Off — not connected");
    expect(screen.getByTestId("classic-availability-withdraw")).toHaveTextContent("Off — not connected");
    fireEvent.click(screen.getByTestId("classic-language-ko"));
    await waitFor(() => expect(screen.getByTestId("classic-settings")).toHaveTextContent("설정"));
    expect(screen.getByTestId("classic-not-connected")).toHaveTextContent("연결되지 않음");
    expect(document.documentElement.lang).toBe("ko");
    expect(window.localStorage.getItem("tornado-classic:locale")).toBe("ko");
    expect(Object.keys(window.localStorage).every((k) => STORAGE_KEYS.includes(k))).toBe(true);
    fireEvent.click(screen.getByTestId("classic-language-auto"));
    await waitFor(() => expect(screen.getByTestId("classic-settings")).toHaveTextContent("Settings"));
    expect(window.localStorage.length).toBe(0);
  });

  it("a configured RPC endpoint is shown by host only", () => {
    setup({ VITE_CLASSIC_RPC_URLS: "https://rpc.example/v1/secret-key-123,https://second.example" });
    go("settings");
    expect(screen.getByTestId("classic-rpc-list")).toHaveTextContent("rpc.example");
    expect(screen.getByTestId("classic-rpc-list")).toHaveTextContent("second.example");
    expect(screen.getByTestId("classic-rpc-list").textContent).not.toContain("secret-key-123");
  });
});

describe("every route", () => {
  it("shows the banner, the header and no promise word, and sends nothing when the live switch is off", async () => {
    const c: ClassicConfig = configFromEnv({});
    expect(c.live).toEqual({});
    setup();
    for (const route of ["deposit", "withdraw", "history", "settings"] as const) {
      go(route);
      await act(async () => {});
      expect(screen.getByTestId("classic-not-connected")).toHaveTextContent(NOT_CONNECTED);
      expect(screen.getByTestId("classic-header")).toHaveTextContent("Tornado Classic");
      expect(scan(document.body.textContent ?? "")).toEqual([]);
      expect(window.location.pathname).toBe(route === "deposit" ? "/classic/deposit" : `/classic/${route}`);
    }
  });
});
