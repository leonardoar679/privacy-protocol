// The Classic fixtures (spec v3.0 §7.9, §10; tests/visual/run.mjs): what fixtures.html#<id> renders — every screen of
// the original flow in each of its states, inside the shell, from static data under a fixed clock: the deposit tab and
// its note modal, the withdraw tab empty, with a found note, its settings (relayer, wallet), its warnings, its errors,
// its totals, proving, the confirmation, the history, the settings page; the main ones in Korean too. None reads a
// wallet, a store or the network. The harness screenshots each at four sizes, checks the layout at ten, runs axe, the
// word policy and the 200 % text; test/fixtures.test.tsx renders every one under happy-dom.
import type { ReactNode } from "react";
import { setLocale, t, type Locale } from "../app/i18n/messages";
import type { Route } from "../app/router";
import { feeLines } from "../model/fees";
import { FIXTURE_NOTE, fixtureFacts, MOCK_GAS_PRICE_WEI, MOCK_RELAYERS, mockAvailability, mockStats, SPENT_NOTE, spentFacts } from "../model/mock";
import { formatNote, noteFileName } from "../model/notes";
import { poolOf, type PoolId } from "../model/pools";
import type { HistoryRow, NoteLookup } from "../model/types";
import { DepositTab, NoteModal } from "../views/Deposit";
import { History } from "../views/History";
import { SettingsPage } from "../views/Settings";
import { Shell } from "../views/Shell";
import { Statistics } from "../views/Statistics";
import { WithdrawTab, type WithdrawProps } from "../views/Withdraw";

export interface Fixture {
  id: string;
  title: string;
  locale: Locale;
  /** a dialog is open: the harness judges the primary action inside it */
  dialog?: boolean;
  render: () => ReactNode;
}

/** The fixtures' clock: 2026-10-26 12:00 UTC. */
export const NOW = Math.floor(Date.parse("2026-10-26T12:00:00Z") / 1000);
/** A fixture value for the recipient field — never a destination. */
export const FIXTURE_ADDRESS = "0x1111111111111111111111111111111111111111";
const noop = () => undefined;
const NOTE_TEXT = formatNote(FIXTURE_NOTE);
const found: NoteLookup = { kind: "found", pool: "eth-1", facts: fixtureFacts(NOW) };
const young: NoteLookup = { kind: "found", pool: "eth-1", facts: { ...fixtureFacts(NOW), timestamp: NOW - 3 * 3_600, depositsSince: 2 } };
const smallFound: NoteLookup = { kind: "found", pool: "eth-0.1", facts: { ...fixtureFacts(NOW), leafIndex: 75_000 } };
const spent: NoteLookup = { kind: "found", pool: "eth-10", facts: spentFacts(NOW) };
const FEES = feeLines(poolOf("eth-1"), MOCK_RELAYERS[0], MOCK_GAS_PRICE_WEI);
const LIVE_OFF = { deposit: false, withdraw: false };

const HISTORY: HistoryRow[] = [
  {
    id: "d1",
    kind: "deposit",
    pool: "eth-1",
    timestamp: NOW - 2 * 86_400 - 1_800,
    txHash: fixtureFacts(NOW).txHash,
    status: "deposited",
    depositsSince: 431,
    spent: false,
  },
  { id: "w1", kind: "withdrawal", pool: "eth-10", timestamp: NOW - 9 * 86_400 + 3_600, txHash: spentFacts(NOW).txHash, status: "CONFIRMED", spent: true },
  { id: "w2", kind: "withdrawal", pool: "eth-0.1", timestamp: NOW - 3_600, status: "FAILED" },
  { id: "d2", kind: "deposit", pool: "eth-100", timestamp: NOW - 120, status: "waiting" },
];

const page = (route: Route, children: ReactNode, statsPool: PoolId | null = "eth-0.1") => (
  <Shell
    route={route}
    onRoute={noop}
    walletLabel={t("wallet.notConnected")}
    walletEnabled={false}
    aside={statsPool ? <Statistics pool={statsPool} stats={mockStats(statsPool, NOW)} now={NOW} /> : undefined}
  >
    {children}
  </Shell>
);

const withdraw = (o: Partial<WithdrawProps> = {}): WithdrawProps => ({
  text: "",
  onText: noop,
  checking: false,
  lookup: null,
  malformed: false,
  now: NOW,
  recipient: "",
  onRecipient: noop,
  recipientInvalid: false,
  donate: true,
  onDonate: noop,
  mode: "relayer",
  onMode: noop,
  relayers: MOCK_RELAYERS,
  relayerId: "one",
  onRelayer: noop,
  settingsOpen: false,
  onToggleSettings: noop,
  fees: null,
  canWithdraw: false,
  live: false,
  onWithdraw: noop,
  proving: false,
  confirmOpen: false,
  onConfirm: noop,
  onCancelConfirm: noop,
  submitted: false,
  ...o,
});

const foundProps = (o: Partial<WithdrawProps> = {}) =>
  withdraw({ text: NOTE_TEXT, lookup: found, recipient: FIXTURE_ADDRESS, fees: FEES, canWithdraw: true, ...o });

const deposit = (pool: PoolId) => page("deposit", <DepositTab pool={pool} onPool={noop} onDeposit={noop} />, pool);
const noteModal = (backedUp: boolean, live: boolean) =>
  page(
    "deposit",
    <>
      <DepositTab pool="eth-1" onPool={noop} onDeposit={noop} />
      <NoteModal
        open
        note={NOTE_TEXT}
        fileName={noteFileName(FIXTURE_NOTE)}
        backedUp={backedUp}
        onBackedUp={noop}
        copied={false}
        onCopy={noop}
        onSave={noop}
        live={live}
        onSend={noop}
        onClose={noop}
      />
    </>,
    "eth-1",
  );
const settings = () =>
  page(
    "settings",
    <SettingsPage
      rpcUrls={[]}
      relayers={MOCK_RELAYERS}
      localeChoice="auto"
      onLocale={noop}
      pool="eth-0.1"
      availability={mockAvailability("eth-0.1")}
      live={LIVE_OFF}
    />,
    null,
  );

const en = (id: string, title: string, render: () => ReactNode, dialog = false): Fixture => ({
  id,
  title,
  locale: "en",
  dialog,
  render: () => {
    setLocale("en");
    return render();
  },
});
const ko = (id: string, title: string, render: () => ReactNode, dialog = false): Fixture => ({
  id,
  title,
  locale: "ko",
  dialog,
  render: () => {
    setLocale("ko");
    return render();
  },
});

export const FIXTURES: readonly Fixture[] = [
  en("classic-deposit", "Deposit — 0.1 ETH selected", () => deposit("eth-0.1")),
  en("classic-deposit-100", "Deposit — 100 ETH selected", () => deposit("eth-100")),
  en("classic-deposit-note", "Deposit — your private note (not backed up yet; not connected)", () => noteModal(false, false), true),
  en("classic-deposit-note-backed", "Deposit — the note backed up, Send Deposit on a live pool", () => noteModal(true, true), true),
  en("classic-withdraw", "Withdraw — empty", () => page("withdraw", <WithdrawTab {...withdraw()} />)),
  en("classic-withdraw-found", "Withdraw — a note found: the facts, the relayer, the totals", () =>
    page("withdraw", <WithdrawTab {...foundProps()} />, "eth-1"),
  ),
  en("classic-withdraw-settings", "Withdraw — the withdrawal settings: Relayer", () =>
    page("withdraw", <WithdrawTab {...foundProps({ settingsOpen: true })} />, "eth-1"),
  ),
  en("classic-withdraw-wallet", "Withdraw — the withdrawal settings: Wallet, with its warning", () =>
    page("withdraw", <WithdrawTab {...foundProps({ settingsOpen: true, mode: "wallet" })} />, "eth-1"),
  ),
  en("classic-withdraw-young", "Withdraw — a young deposit: the two warnings", () =>
    page("withdraw", <WithdrawTab {...foundProps({ lookup: young })} />, "eth-1"),
  ),
  en("classic-withdraw-not-enough", "Withdraw — the fee exceeds the note (0.1 ETH at 2,000 gwei)", () =>
    page(
      "withdraw",
      <WithdrawTab
        {...foundProps({
          text: formatNote({ ...FIXTURE_NOTE, amount: "0.1" }),
          lookup: smallFound,
          fees: feeLines(poolOf("eth-0.1"), MOCK_RELAYERS[0], 2_000_000_000_000n),
          canWithdraw: false,
        })}
      />,
      "eth-0.1",
    ),
  ),
  en("classic-withdraw-spent", "Withdraw — the note has been spent", () =>
    page("withdraw", <WithdrawTab {...withdraw({ text: formatNote(SPENT_NOTE), lookup: spent })} />),
  ),
  en("classic-withdraw-invalid", "Withdraw — the note is invalid", () =>
    page("withdraw", <WithdrawTab {...withdraw({ text: "tornado-eth-1-1-0xnot-a-note", malformed: true })} />),
  ),
  en("classic-withdraw-no-deposit", "Withdraw — no related deposit", () =>
    page("withdraw", <WithdrawTab {...withdraw({ text: formatNote({ ...FIXTURE_NOTE, amount: "100" }), lookup: { kind: "no-deposit" } })} />),
  ),
  en("classic-withdraw-recipient-invalid", "Withdraw — the recipient is invalid", () =>
    page("withdraw", <WithdrawTab {...foundProps({ recipient: "0x1234", recipientInvalid: true, canWithdraw: false })} />, "eth-1"),
  ),
  en("classic-withdraw-proving", "Withdraw — generating the proof (a live pool)", () =>
    page("withdraw", <WithdrawTab {...foundProps({ live: true, proving: true })} />, "eth-1"),
  ),
  en(
    "classic-withdraw-confirm",
    "Withdraw — the withdrawal confirmation",
    () => page("withdraw", <WithdrawTab {...foundProps({ live: true, confirmOpen: true })} />, "eth-1"),
    true,
  ),
  en("classic-withdraw-submitted", "Withdraw — handed to the relayer", () =>
    page("withdraw", <WithdrawTab {...foundProps({ live: true, submitted: true, canWithdraw: false })} />, "eth-1"),
  ),
  en("classic-history-empty", "History — empty", () => page("history", <History rows={[]} filter="all" onFilter={noop} now={NOW} />, null)),
  en("classic-history", "History — four rows", () => page("history", <History rows={HISTORY} filter="all" onFilter={noop} now={NOW} />, null)),
  en("classic-settings", "Settings — RPC, relayers, language, the availability of a pool", settings),
  ko("classic-deposit-ko", "입금 — 0.1 ETH", () => deposit("eth-0.1")),
  ko("classic-deposit-note-ko", "입금 — 비밀 노트", () => noteModal(false, false), true),
  ko("classic-withdraw-found-ko", "출금 — 노트 확인됨", () => page("withdraw", <WithdrawTab {...foundProps()} />, "eth-1")),
  ko("classic-settings-ko", "설정", settings),
];
