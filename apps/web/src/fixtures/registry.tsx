// The fixtures (spec v2.0 §6, §19; tests/visual): what fixtures.html#<id> renders. The component preview, the shell, and
// every core screen's View in each of its states — Home, Protect, Send, Swap and cross-chain, the Reviews (doc §86's
// $10,000 swap, doc §87's $80,000 protected execution, a blocker), Progress, Activity, the detail and its recovery —
// inside the shell, from static data: none reads a wallet, a store or the network. The harness reads `kind` (a "screen"
// shows at most one visible primary action and no destructive button beside a confirmation), `simple` (the vocabulary of
// doc §92 applies), `keyboard` (the primary action stays visible with the amount focused above an on-screen keyboard)
// and `accept` (the acceptance checks of doc §86–§87).
import type { ReactNode } from "react";
import {
  AppShell,
  Button,
  Card,
  DESKTOP_QUERY,
  ErrorCard,
  Icon,
  ListRow,
  Page,
  StatusBadge,
  TextButton,
  useMediaQuery,
  type NavItem,
  type ShellNav,
} from "@privacy-wallet/ui";
import { Preview, PREVIEW_SECTIONS } from "@privacy-wallet/ui/Preview";
import { t } from "../app/i18n/messages";
import { HomeView } from "../features/home/View";
import { HOME_FIXTURES } from "../features/home/fixtures";
import { ProtectView } from "../features/protect/View";
import { SendView } from "../features/send/View";
import { SwapView } from "../features/swap/View";
import { ReviewView } from "../features/review/View";
import { ProgressView } from "../features/progress/View";
import { ActivityView, DetailView } from "../features/activity/View";
import { ACTIVITY_FIXTURES, DETAIL_FIXTURES } from "../features/activity/fixtures";
import { PROGRESS_FIXTURES, PROTECT_FIXTURES, REVIEW_FIXTURES, SEND_FIXTURES, SWAP_FIXTURES } from "../features/flowFixtures";
import { PrivacyCenterView } from "../features/privacy-center/View";
import { PRIVACY_CENTER_FIXTURES } from "../features/privacy-center/fixtures";
import { ClassicHomeView, ClassicPoolActions, ClassicPoolStatusView, ClassicRecoverView, ClassicRelayersView } from "../features/classic-privacy/View";
import { CLASSIC_HOME_FIXTURE, CLASSIC_POOL_FIXTURE, CLASSIC_RECOVER_FIXTURE, CLASSIC_RELAYERS_FIXTURE } from "../features/classic-privacy/fixtures";
// V7 Stage 4 (spec v3.0 §2): the More list, the one Settings page (its sections on a fresh wallet: the stores at their defaults) and the connector picker
import { MoreView } from "../features/more/More";
import { Settings } from "../features/settings/Settings";
import { ConnectSheet } from "../features/wallet/ConnectSheet";

export interface Fixture {
  id: string;
  title: string;
  kind: "screen" | "catalog";
  /** a Simple-experience screen: the vocabulary of doc §92 applies */
  simple?: boolean;
  /** the screen has an amount field: its primary action must stay visible above the keyboard */
  keyboard?: boolean;
  /** the acceptance checks of doc §86 / §87 */
  accept?: "§86" | "§87";
  /** element screenshots in place of the whole page: [part id, CSS selector] */
  parts?: readonly (readonly [string, string])[];
  /** what the harness does before the screenshot */
  before?: "open-wallet-menu";
  render: () => ReactNode;
}

const noop = () => undefined;
const items: NavItem[] = [
  { to: "/", label: "Home", icon: "home", testId: "nav-home" },
  { to: "/swap", label: "Swap", icon: "swap", testId: "nav-swap" },
  { to: "/activity", label: "Activity", icon: "activity", testId: "nav-activity" },
  { to: "/more", label: "More", icon: "more", testId: "nav-more" },
];

const shellNav = (current: string): ShellNav => ({
  brand: (
    <>
      <Icon name="shield-check" size={22} />
      <span>Privacy Wallet</span>
    </>
  ),
  items,
  desktopItems: items.slice(0, 3),
  current,
  onSelect: noop,
  label: "Main",
  menu: {
    label: "Wallet",
    icon: "wallet",
    testId: "nav-wallet",
    content: (close) => (
      <>
        <div className="ds-kv" data-testid="menu-connection">
          <span className="ds-kv-label">Connection</span>
          <StatusBadge tone="ok">Connected · 0x7A…91F2</StatusBadge>
        </div>
        <Button variant="secondary" full icon="wallet" onClick={close} data-testid="menu-connect">
          0x7A…91F2
        </Button>
        <ListRow title="Tornado Classic" leading={<Icon name="recovery" />} href="/classic/" testId="menu-classic" />
        <ListRow title="Privacy Center" leading={<Icon name="shield" />} onPress={close} testId="menu-privacy" />
        <ListRow title="Settings" leading={<Icon name="gear" />} onPress={close} testId="menu-settings" />
        <ListRow title="Private AI" leading={<Icon name="globe" />} onPress={close} testId="menu-ai" />
      </>
    ),
  },
});

const inShell = (current: string, node: ReactNode) => <AppShell nav={shellNav(current)}>{node}</AppShell>;

/** The shell around a sample page: the header, two cards, one primary action. */
function ShellSample() {
  return inShell(
    "/",
    <Page
      title="Home"
      primaryAction={
        <Button size="lg" full>
          Protect Assets
        </Button>
      }
    >
      <Card padding="lg">
        <div className="ds-balance">
          <span className="ds-balance-amount">$24,382.41</span>
          <span className="ds-balance-label">Protected balance</span>
        </div>
      </Card>
      <Card>
        <ListRow title="ETH" subtitle="Ethereum" trailing={<span className="ds-numeral">4.82</span>} />
        <ListRow title="USDC" subtitle="USD Coin" trailing={<span className="ds-numeral">12,400.00</span>} />
      </Card>
      <TextButton icon="chevron-right">View activity</TextButton>
    </Page>,
  );
}

function Home({ state }: { state: keyof typeof HOME_FIXTURES }) {
  const wide = useMediaQuery(DESKTOP_QUERY);
  return inShell(
    "/",
    <HomeView
      model={HOME_FIXTURES[state]}
      wide={wide}
      actions={{ onProtect: noop, onSend: noop, onSwap: noop, onPrivacy: noop, onSettings: noop, onWallet: noop, onReceive: noop, onOperation: noop }}
    />,
  );
}

function Activity({ state }: { state: keyof typeof ACTIVITY_FIXTURES }) {
  const wide = useMediaQuery(DESKTOP_QUERY);
  return inShell("/activity", <ActivityView model={ACTIVITY_FIXTURES[state]} wide={wide} onOpen={noop} onRefresh={noop} />);
}

// the catalog's words (V6 Stage 16: the fixtures render in any locale — the Korean test reads them)
const recoveryCard = () => (
  <ErrorCard
    title={t("op.state.SETTLING")}
    fundsLine={t("operation.fundsSafe")}
    fundsState="still-protected"
    reason={t("op.recovery.monitoring")}
    actions={<Button variant="secondary">{t("operation.viewProgress")}</Button>}
    testId="recovery"
  />
);

const screen = (id: string, title: string, render: () => ReactNode, o: Partial<Fixture> = {}): Fixture => ({
  id,
  title,
  kind: "screen",
  simple: true,
  render,
  ...o,
});

export const FIXTURES: readonly Fixture[] = [
  {
    id: "preview",
    title: "Component preview",
    kind: "catalog",
    parts: PREVIEW_SECTIONS.map((s) => [s, `[data-preview-section="${s}"]`] as const),
    render: () => <Preview />,
  },
  screen("shell", "The shell around a page", () => <ShellSample />),
  screen("shell-wallet-menu", "The desktop Wallet menu, open", () => <ShellSample />, { before: "open-wallet-menu" }),
  // V7 Stage 4 (spec v3.0 §2): More = Tornado Classic · Privacy Center · Settings; one Settings page; the connector picker
  screen("more", "More — Tornado Classic, the Privacy Center, Settings", () => inShell("/more", <MoreView experience="simple" onOpen={noop} />)),
  screen("settings", "Settings — the sections, on a fresh wallet", () =>
    inShell("/settings", <Settings deployment={null} onReceive={noop} onAdvanced={noop} onConnect={noop} />),
  ),
  // the sheet alone is the image (a full page under an open dialog changes height between runs)
  screen(
    "connect-sheet",
    "The connector picker — no wallet in this browser",
    () => (
      <>
        <Home state="empty" />
        <ConnectSheet open onClose={noop} />
      </>
    ),
    { parts: [["sheet", '[data-testid="connect-sheet"]']] },
  ),
  // Home (spec §7.1)
  screen("home-empty", "Home — connected, nothing protected", () => <Home state="empty" />),
  screen("home-funded", "Home — assets", () => <Home state="funded" />),
  screen("home-executing", "Home — an operation executing", () => <Home state="executing" />),
  screen("home-action-needed", "Home — action needed, funds safe", () => <Home state="action-needed" />),
  screen("home-checking", "Home — action needed, checking on the funds", () => <Home state="checking" />),
  screen("home-advanced", "Home — the Advanced experience", () => <Home state="advanced" />, { simple: false }),
  // Protect (§7.3), Send (§7.4)
  screen(
    "protect",
    "Protect 5,000 USDC",
    () =>
      inShell(
        "/protect",
        <ProtectView model={PROTECT_FIXTURES.filled} actions={{ onAmount: noop, onAsset: noop, onMax: noop, onReview: noop, onBack: noop }} />,
      ),
    {
      keyboard: true,
    },
  ),
  screen("protect-insufficient", "Protect — more than the wallet holds", () =>
    inShell("/protect", <ProtectView model={PROTECT_FIXTURES.insufficient} actions={{ onAmount: noop, onAsset: noop, onReview: noop, onBack: noop }} />),
  ),
  screen(
    "send",
    "Send 2,500 USDC",
    () => inShell("/send", <SendView model={SEND_FIXTURES.evm} actions={{ onAmount: noop, onTo: noop, onExact: noop, onReview: noop, onBack: noop }} />),
    {
      keyboard: true,
    },
  ),
  screen("send-bitcoin", "Send — to a Bitcoin address", () =>
    inShell("/send", <SendView model={SEND_FIXTURES.bitcoin} actions={{ onAmount: noop, onTo: noop, onExact: noop, onReview: noop, onBack: noop }} />),
  ),
  screen("send-other-chain", "Send — an address of another chain", () =>
    inShell(
      "/send",
      <SendView
        model={SEND_FIXTURES["other-chain"]}
        actions={{ onAmount: noop, onTo: noop, onExact: noop, onReview: noop, onConfirmChain: noop, onBack: noop }}
      />,
    ),
  ),
  // Swap and cross-chain (§7.5)
  screen(
    "swap",
    "Swap 8,000 USDC → ETH",
    () =>
      inShell(
        "/swap",
        <SwapView
          model={SWAP_FIXTURES["same-chain"]}
          actions={{ onAmount: noop, onPayAsset: noop, onReceiveAsset: noop, onSwitch: noop, onReview: noop, onNewQuote: noop }}
        />,
      ),
    { keyboard: true },
  ),
  screen("swap-cross-chain", "Swap ETH → BTC", () =>
    inShell(
      "/swap",
      <SwapView model={SWAP_FIXTURES["cross-chain"]} actions={{ onAmount: noop, onPayAsset: noop, onReceiveAsset: noop, onReview: noop, onNewQuote: noop }} />,
    ),
  ),
  screen(
    "swap-advanced",
    "Swap — the Advanced experience: the route details (beside the swap card from 1024 px)",
    () =>
      inShell(
        "/swap",
        <SwapView
          model={SWAP_FIXTURES.advanced}
          actions={{ onAmount: noop, onPayAsset: noop, onReceiveAsset: noop, onReview: noop, onNewQuote: noop, onCompare: noop }}
        />,
      ),
    { simple: false },
  ),
  screen("swap-expired", "Swap — the quote expired", () =>
    inShell(
      "/swap",
      <SwapView model={SWAP_FIXTURES.expired} actions={{ onAmount: noop, onPayAsset: noop, onReceiveAsset: noop, onReview: noop, onNewQuote: noop }} />,
    ),
  ),
  // The Review (§7.6, §7.9)
  screen(
    "review-swap",
    "Review — $10,000 USDC → ETH (doc §86)",
    () => inShell("/swap", <ReviewView model={REVIEW_FIXTURES.swap} actions={{ onConfirm: noop, onEdit: noop }} />),
    { accept: "§86" },
  ),
  screen("review-cross-chain", "Review — ETH → BTC", () =>
    inShell("/swap", <ReviewView model={REVIEW_FIXTURES["cross-chain"]} actions={{ onConfirm: noop, onEdit: noop }} />),
  ),
  screen(
    "review-large",
    "Review — $80,000 protected execution (doc §87)",
    () => inShell("/swap", <ReviewView model={REVIEW_FIXTURES.large} actions={{ onConfirm: noop, onEdit: noop }} />),
    {
      accept: "§87",
    },
  ),
  screen("review-protect", "Review — Protect", () =>
    inShell("/protect", <ReviewView model={REVIEW_FIXTURES.protect} actions={{ onConfirm: noop, onEdit: noop }} />),
  ),
  screen("review-send", "Review — Send", () => inShell("/send", <ReviewView model={REVIEW_FIXTURES.send} actions={{ onConfirm: noop, onEdit: noop }} />)),
  screen("review-blocked", "Review — stopped by a blocker", () =>
    inShell("/swap", <ReviewView model={REVIEW_FIXTURES.blocked} actions={{ onConfirm: noop, onEdit: noop, onReviewAgain: noop }} />),
  ),
  // Progress (§7.7)
  screen("progress", "Progress", () => inShell("/swap", <ProgressView model={PROGRESS_FIXTURES.standard} />)),
  screen("progress-large", "Progress — a large operation", () => inShell("/swap", <ProgressView model={PROGRESS_FIXTURES.large} />)),
  // Activity, the detail, recovery (§7.8)
  // V6 Stage 14 (spec v2.0 §7.10): the Privacy Center's seven sections
  screen("privacy-center", "Privacy Center — protected", () =>
    inShell("/more", <PrivacyCenterView model={PRIVACY_CENTER_FIXTURES.protected} actions={{ onBack: noop, onLearnMore: noop, onSettings: noop }} />),
  ),
  screen("privacy-center-entered", "Privacy Center — an entered destination, one read endpoint", () =>
    inShell("/more", <PrivacyCenterView model={PRIVACY_CENTER_FIXTURES.entered} actions={{ onBack: noop, onLearnMore: noop, onSettings: noop }} />),
  ),
  // V6 Stage 14 (spec v2.0 §7.11, §11.3): Classic Privacy under More
  screen("classic", "Classic Privacy — the pools", () =>
    inShell("/more", <ClassicHomeView model={CLASSIC_HOME_FIXTURE} actions={{ onOpen: noop, onRecover: noop, onRelayers: noop, onBack: noop }} />),
  ),
  screen("classic-pool", "Classic Privacy — a pool's status", () =>
    inShell(
      "/more",
      <Page title={t("classic.poolTitle", { amount: "1", symbol: "ETH" })} back={noop} testId="classic-pool">
        <Card testId="classic-position">
          <div className="ds-stack-sm">
            <ClassicPoolStatusView model={CLASSIC_POOL_FIXTURE} />
            <ClassicPoolActions onDeposit={noop} onWithdraw={noop} />
          </div>
        </Card>
      </Page>,
    ),
  ),
  screen("classic-recover", "Classic Privacy — a deposit recovered from its note", () =>
    inShell("/more", <ClassicRecoverView model={CLASSIC_RECOVER_FIXTURE} actions={{ onNote: noop, onFind: noop, onWithdraw: noop, onBack: noop }} />),
  ),
  screen("classic-relayers", "Classic Privacy — the relayer choice", () =>
    inShell(
      "/more",
      <ClassicRelayersView relayers={CLASSIC_RELAYERS_FIXTURE.relayers} chosen={CLASSIC_RELAYERS_FIXTURE.chosen} actions={{ onChoose: noop, onBack: noop }} />,
    ),
  ),
  screen("activity", "Activity", () => <Activity state="list" />),
  screen("activity-empty", "Activity — empty", () => <Activity state="empty" />),
  screen("detail", "Detail — ETH → BTC executing", () => inShell("/activity", <DetailView model={DETAIL_FIXTURES.executing} onBack={noop} onRefresh={noop} />)),
  screen("detail-recovery", "Detail — recovery", () =>
    inShell("/activity", <DetailView model={DETAIL_FIXTURES.recovery} onBack={noop} recovery={recoveryCard()} />),
  ),
  screen("detail-completed", "Detail — completed", () => inShell("/activity", <DetailView model={DETAIL_FIXTURES.completed} onBack={noop} onRemove={noop} />)),
];
