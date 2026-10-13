// The fixtures (spec v2.0 §6, §19; tests/visual): what fixtures.html#<id> renders. Each is static — the component
// preview, the shell around sample content — and, from Stage 6, every core screen's View fed from its fixtures; none
// reads a wallet, a store or the network. `kind` tells the harness which checks apply: a "screen" has at most one
// visible primary action and no destructive button beside a confirmation; a "catalog" (the preview) shows every state.
import type { ReactNode } from "react";
import { AppShell, Button, Card, Icon, ListRow, Page, StatusBadge, TextButton, type NavItem, type ShellNav } from "@privacy-wallet/ui";
import { Preview, PREVIEW_SECTIONS } from "@privacy-wallet/ui/Preview";

export interface Fixture {
  id: string;
  title: string;
  kind: "screen" | "catalog";
  /** element screenshots in place of the whole page: [part id, CSS selector] */
  parts?: readonly (readonly [string, string])[];
  /** what the harness does before the screenshot */
  before?: "open-wallet-menu";
  render: () => ReactNode;
}

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
  onSelect: () => undefined,
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
        <ListRow title="Privacy Center" leading={<Icon name="shield" />} onPress={close} testId="menu-privacy" />
        <ListRow title="Security" leading={<Icon name="lock" />} onPress={close} testId="menu-security" />
        <ListRow title="Wallet" leading={<Icon name="wallet" />} onPress={close} testId="menu-wallet" />
        <ListRow title="Classic Privacy" leading={<Icon name="recovery" />} onPress={close} testId="menu-classic" />
        <ListRow title="Private AI" leading={<Icon name="globe" />} onPress={close} testId="menu-ai" />
      </>
    ),
  },
});

/** The shell around a sample page: the header, two cards, one primary action (the layout every screen sits in). */
function ShellSample() {
  return (
    <AppShell nav={shellNav("/")}>
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
      </Page>
    </AppShell>
  );
}

export const FIXTURES: readonly Fixture[] = [
  {
    id: "preview",
    title: "Component preview",
    kind: "catalog",
    parts: PREVIEW_SECTIONS.map((s) => [s, `[data-preview-section="${s}"]`] as const),
    render: () => <Preview />,
  },
  { id: "shell", title: "The shell around a page", kind: "screen", render: () => <ShellSample /> },
  { id: "shell-wallet-menu", title: "The desktop Wallet menu, open", kind: "screen", before: "open-wallet-menu", render: () => <ShellSample /> },
];
