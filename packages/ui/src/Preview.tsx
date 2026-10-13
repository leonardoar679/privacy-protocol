// The component preview (spec v2.0 §5–§6: `/__preview`, dev and fixtures builds only): every component of the doc §9
// inventory and every pattern in its states, in sections the screenshot harness captures one by one
// (tests/visual), and the page the accessibility test runs axe over. Sample figures only; nothing here reads a wallet.
// The sentinel lets the production build's check prove the page is not in dist/ (apps/web/scripts/check-dist.mjs).
import { useState, type ReactNode } from "react";
import { COLOR_NAMES, TYPE, TYPE_ROLES } from "./tokens/index";
import { Icon, ICON_NAMES } from "./icons";
import { RadioGroup, Switch, Tabs, ToastProvider, useToast } from "./primitives";
import { Button, IconButton, TextButton } from "./components/Button";
import { Card, Header, Menu } from "./components/Layout";
import { AssetRow, BalanceCard, FeeSummary, ProtectionBadge, QuoteCard, StatusBadge } from "./components/Money";
import { AddressInput, AmountInput, AssetSelector, ChainSelector, Field, Input, Segmented } from "./components/Inputs";
import { BottomSheet, ConfirmSheet, HoldButton, Modal } from "./components/Sheets";
import { Collapsible, ErrorCard, ListRow, ProgressIndicator, SecurityCard, Skeleton, SuccessCard, TransactionTimeline, WarningCard } from "./components/Status";
import { AddressChip, AmountText, FeeLines, FlowCard, ReviewLayout, StateScreen } from "./patterns/index";

export const PREVIEW_SENTINEL = "pw-preview-sentinel";

/** The sections, in order: the harness screenshots `[data-preview-section="<id>"]` at every viewport. */
export const PREVIEW_SECTIONS = ["tokens", "buttons", "cards", "money", "inputs", "status", "flow", "review", "states", "small", "overlays", "icons"] as const;
export type PreviewSection = (typeof PREVIEW_SECTIONS)[number];

function Section({ id, title, children }: { id: PreviewSection; title: string; children: ReactNode }) {
  return (
    <section className="ds-preview-section" data-preview-section={id} aria-labelledby={`preview-${id}`}>
      <h2 id={`preview-${id}`}>{title}</h2>
      {children}
    </section>
  );
}

function ToastDemo() {
  const toast = useToast();
  return (
    <Button
      variant="secondary"
      onClick={() => toast({ kind: "success", title: "Quote updated", body: "The route still guarantees the same minimum." })}
      data-testid="preview-toast"
    >
      Show a toast
    </Button>
  );
}

const USDC = 10n ** 6n;

export function Preview() {
  const [sheet, setSheet] = useState(false);
  const [modal, setModal] = useState(false);
  const [confirm, setConfirm] = useState<"tap" | "hold" | null>(null);
  const [assetPicker, setAssetPicker] = useState(false);
  const [chainPicker, setChainPicker] = useState(false);
  const [amount, setAmount] = useState("8000");
  const [address, setAddress] = useState("0x43a1f0c2d9b7e4f6a8c3b2d1e0f9a8b7c6d582C1");
  const [seg, setSeg] = useState("asset");
  const [radio, setRadio] = useState("simple");
  const [on, setOn] = useState(true);
  const [tab, setTab] = useState("one");
  const [chain, setChain] = useState("ethereum");
  const assets = [
    { id: "eth", symbol: "ETH", name: "Ethereum", balance: "4.82" },
    { id: "usdc", symbol: "USDC", name: "USD Coin", balance: "12,400" },
    { id: "btc", symbol: "BTC", name: "Bitcoin", chain: "Bitcoin" },
  ];
  const chains = [
    { id: "ethereum", name: "Ethereum", detail: "Recommended" },
    { id: "base", name: "Base" },
    { id: "arbitrum", name: "Arbitrum", available: false, unavailableReason: "Temporarily unavailable" },
  ];
  return (
    <ToastProvider>
      <div className="ds-preview" data-testid="preview" data-preview={PREVIEW_SENTINEL}>
        <header>
          <h1>Component preview</h1>
        </header>

        <Section id="tokens" title="Colour and type">
          <div className="ds-preview-grid">
            {COLOR_NAMES.map((c) => (
              <span key={c} className="ds-swatch">
                <span style={{ background: `var(--${c})` }} />
                <span>{c}</span>
              </span>
            ))}
          </div>
          <div>
            {TYPE_ROLES.map((r) => (
              <div key={r} className="ds-type-sample">
                <span
                  style={{
                    fontSize: `var(--${r}-size)`,
                    lineHeight: `var(--${r}-line)`,
                    fontWeight: `var(--${r}-weight)`,
                    fontVariantNumeric: TYPE[r].numeric ? "tabular-nums" : undefined,
                  }}
                >
                  {TYPE[r].numeric ? "$24,382.41" : "Protect your assets"}
                </span>
                <span className="ds-note">
                  {r} · {TYPE[r].size}/{TYPE[r].line}
                </span>
              </div>
            ))}
          </div>
        </Section>

        <Section id="buttons" title="Buttons">
          <div className="ds-chips">
            <Button>Protect Assets</Button>
            <Button variant="secondary">View Details</Button>
            <Button variant="destructive">Remove Data</Button>
            <TextButton icon="chevron-right">Compare routes</TextButton>
            <IconButton label="Settings" icon="gear" />
          </div>
          <div className="ds-chips">
            <Button loading>Securing</Button>
            <Button disabled>Review Swap</Button>
            <Button variant="secondary" icon="copy">
              Copy address
            </Button>
          </div>
          <Button size="lg" full>
            Review Swap
          </Button>
          <HoldButton label="Hold to Confirm" holdMs={1500} onConfirm={() => undefined} />
        </Section>

        <Section id="cards" title="Cards">
          <div className="ds-preview-grid">
            <Card>
              <p>A card with its default padding.</p>
            </Card>
            <WarningCard
              title="This route takes longer"
              body="Bitcoin needs about 3 confirmations; the funds arrive in about 40 minutes."
              action={<TextButton>Why?</TextButton>}
            />
            <SuccessCard
              title="Swap completed"
              body="2.31 ETH is in your protected balance."
              details={<AmountText value={231n * 10n ** 16n} decimals={18} displayDecimals={4} symbol="ETH" />}
              actions={<Button variant="secondary">View details</Button>}
            />
            <ErrorCard
              title="We couldn't complete this swap."
              fundsLine="Your funds were not moved."
              fundsState="not-moved"
              reason="The quote expired before confirmation."
              actions={<Button variant="secondary">Get a new quote</Button>}
            />
            <ErrorCard
              title="We stopped this transaction."
              fundsLine="Your funds are still protected."
              fundsState="still-protected"
              reason="The route changed before confirmation."
              actions={<Button variant="secondary">Review again</Button>}
            />
            <SecurityCard
              title="Protect your wallet"
              body="Your recovery phrase controls access to your protected assets."
              action={<Button variant="secondary">Back up now</Button>}
            />
          </div>
        </Section>

        <Section id="money" title="Balances, assets, fees, quotes, badges">
          <div className="ds-preview-grid">
            <BalanceCard
              label="Protected balance"
              amountUsd="$24,382.41"
              subline="3 assets"
              status="protected"
              statusLabel="Protected"
              onStatus={() => undefined}
            />
            <BalanceCard label="Protected balance" amountUsd={null} status="loading" />
            <Card>
              <AssetRow asset={{ symbol: "ETH", name: "Ethereum" }} amount="4.82" usd="$19,280.00" onPress={() => undefined} />
              <AssetRow asset={{ symbol: "USDC", name: "USD Coin" }} amount="12,400" usd="$12,400.00" />
            </Card>
            <Card>
              <FeeSummary
                receive={{ label: "You'll receive", value: "$9,886.00" }}
                pay={{ label: "You pay", value: "$10,000.00" }}
                total="$114.00"
                lines={[
                  { label: "Privacy fee", value: "$100.00", hint: "1 % of the amount" },
                  { label: "Relayer / network", value: "$4.10" },
                  { label: "Swap / provider", value: "$9.90" },
                ]}
              />
            </Card>
            <QuoteCard
              quote={{
                pay: "8,000 USDC",
                receive: "≈ 2.31 ETH",
                minimum: "2.28 ETH",
                fees: "$91.80",
                time: "About 2 min",
                protection: "High",
                route: "Best route",
              }}
              labels={{ pay: "You pay", receive: "You receive", minimum: "Minimum", fees: "Fees", time: "Time", protection: "Protected" }}
            />
          </div>
          <div className="ds-chips">
            <ProtectionBadge level="High" label="High protection" onPress={() => undefined} />
            <ProtectionBadge level="Reduced" label="Medium" />
            <ProtectionBadge level="Off" label="Not protected" />
          </div>
          <div className="ds-chips">
            <StatusBadge tone="ok">Completed</StatusBadge>
            <StatusBadge tone="pending">Executing</StatusBadge>
            <StatusBadge tone="warn">Action needed</StatusBadge>
            <StatusBadge tone="danger">Failed</StatusBadge>
            <StatusBadge tone="neutral">Cancelled</StatusBadge>
          </div>
        </Section>

        <Section id="inputs" title="Inputs">
          <div className="ds-preview-grid">
            <AmountInput
              id="p-amount"
              label="Amount"
              asset={{ symbol: "USDC", decimals: 6 }}
              value={amount}
              onChange={setAmount}
              usd="≈ $8,000.00"
              onMax={() => setAmount("12400")}
            />
            <AddressInput
              id="p-address"
              label="To"
              value={address}
              onChange={setAddress}
              placeholder="Paste address"
              checks={[
                { label: "Valid address", state: "ok" },
                { label: "Correct network", state: "ok" },
                { label: "Not a contract", state: "pending" },
                { label: "Not your address", state: "fail" },
              ]}
            />
            <Field label="Label" htmlFor="p-text" hint="A hint under the field">
              <Input id="p-text" placeholder="Text" />
            </Field>
            <Field label="With an error" htmlFor="p-text2" error="This is not a valid address">
              <Input id="p-text2" invalid defaultValue="0x12" />
            </Field>
            <Segmented
              value={seg}
              onChange={setSeg}
              ariaLabel="Amount in"
              name="segmented"
              options={[
                { value: "asset", label: "USDC" },
                { value: "usd", label: "USD" },
              ]}
            />
            <RadioGroup
              value={radio}
              onValueChange={setRadio}
              ariaLabel="Choose your experience"
              name="experience"
              options={[
                { value: "simple", label: "Simple", description: "We choose the safest settings." },
                { value: "advanced", label: "Advanced", description: "Every setting, with its effect." },
              ]}
            />
            <Switch id="p-switch" checked={on} onCheckedChange={setOn} label="Notifications" description="Generic text only" />
            <Tabs
              value={tab}
              onValueChange={setTab}
              ariaLabel="Example tabs"
              items={[
                { value: "one", label: "Overview", content: <p>First</p> },
                { value: "two", label: "Details", content: <p>Second</p> },
              ]}
            />
          </div>
        </Section>

        <Section id="status" title="Progress and status">
          <div className="ds-preview-grid">
            <Card>
              <TransactionTimeline
                steps={[
                  { label: "Quote locked", state: "done" },
                  { label: "Source confirmed", state: "done", detail: "12:04" },
                  { label: "Destination sent", state: "active" },
                  { label: "Completed", state: "waiting" },
                ]}
              />
            </Card>
            <Card>
              <div className="ds-stack">
                <ProgressIndicator value={0.6} label="Securing your transaction" />
                <ProgressIndicator value={null} label="Preparing" />
                <Skeleton height={24} />
                <Collapsible summary="Advanced details">
                  <p>Hidden by default.</p>
                </Collapsible>
              </div>
            </Card>
            <Card>
              <ListRow title="Security" subtitle="Backup, lock, second factor" leading={<Icon name="lock" />} onPress={() => undefined} />
              <ListRow title="Privacy Center" leading={<Icon name="shield" />} onPress={() => undefined} />
            </Card>
          </div>
        </Section>

        <Section id="flow" title="Flow card and fee lines">
          <div className="ds-preview-grid">
            <FlowCard
              from={{
                label: "You pay",
                asset: { symbol: "USDC" },
                network: "Protected balance",
                onAsset: () => undefined,
                children: <AmountText value={8000n * USDC} decimals={6} displayDecimals={2} />,
                sub: "Balance 12,400 USDC",
              }}
              to={{
                label: "You receive",
                asset: { symbol: "ETH" },
                network: "Protected balance",
                onAsset: () => undefined,
                children: <AmountText value={231n * 10n ** 16n} decimals={18} displayDecimals={4} approx />,
              }}
              onSwitch={() => undefined}
            />
            <Card>
              <FeeLines
                receive={{
                  label: "Recipient receives",
                  value: <AmountText value={2470_900_000n} decimals={6} displayDecimals={2} minDecimals={2} symbol="USDC" />,
                }}
                lines={[
                  {
                    label: "Privacy fee",
                    hint: "1 % of the amount",
                    value: <AmountText value={25n * USDC} decimals={6} displayDecimals={2} minDecimals={2} symbol="USDC" />,
                  },
                  { label: "Relayer / network", value: <AmountText value={4_100_000n} decimals={6} displayDecimals={2} minDecimals={2} symbol="USDC" /> },
                ]}
                total={{ label: "Total", value: <AmountText value={2500n * USDC} decimals={6} displayDecimals={2} minDecimals={2} symbol="USDC" /> }}
              />
            </Card>
          </div>
        </Section>

        <Section id="review" title="Review">
          <div className="ds-preview-phone">
            <ReviewLayout
              amount={{
                label: "You pay",
                primary: <AmountText usdCents={1_000_000n} />,
                secondary: <AmountText value={10_000n * USDC} decimals={6} displayDecimals={2} symbol="USDC" />,
              }}
              sections={[
                {
                  title: "You receive",
                  rows: [
                    { label: "Expected", value: <AmountText value={2_886n * 10n ** 15n} decimals={18} displayDecimals={4} symbol="ETH" approx /> },
                    { label: "At least", value: <AmountText value={2_857n * 10n ** 15n} decimals={18} displayDecimals={4} symbol="ETH" /> },
                    { label: "Destination", value: "Your protected balance", tone: "positive" },
                  ],
                },
                {
                  title: "Fees",
                  rows: [
                    { label: "Privacy fee", value: <AmountText usdCents={10_000n} /> },
                    { label: "Relayer / network", value: <AmountText usdCents={410n} /> },
                    { label: "Swap / provider", value: <AmountText usdCents={990n} /> },
                    { label: "Total", value: <AmountText usdCents={11_400n} /> },
                  ],
                },
              ]}
              notices={<WarningCard title="Prices move" body="If the price moves below the minimum, nothing is signed and you choose again." />}
              action={
                <Button size="lg" full>
                  Confirm
                </Button>
              }
              secondaryAction={<TextButton>Edit</TextButton>}
            />
          </div>
        </Section>

        <Section id="states" title="Screen states">
          <div className="ds-preview-grid">
            <Card>
              <StateScreen
                kind="empty"
                title="Nothing here yet"
                body="Protect assets to start using your protected balance."
                actions={<Button>Protect Assets</Button>}
              />
            </Card>
            <Card>
              <StateScreen kind="loading" title="Securing your transaction…" body="About 20 seconds on this device." />
            </Card>
            <Card>
              <StateScreen
                kind="error"
                title="We stopped this transaction"
                body="The route changed before confirmation. Your funds have not moved."
                actions={<Button variant="secondary">Review again</Button>}
              />
            </Card>
            <Card>
              <StateScreen
                kind="done"
                title="Protected"
                body="4,950 USDC is in your protected balance."
                actions={<Button variant="secondary">View details</Button>}
              />
            </Card>
          </div>
        </Section>

        <Section id="small" title="Addresses and amounts">
          <div className="ds-chips">
            <AddressChip address="0x43a1f0c2d9b7e4f6a8c3b2d1e0f9a8b7c6d582C1" copyable />
            <AddressChip address="bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx82c1" />
          </div>
          <div className="ds-stack-sm">
            <AmountText value={3_251_795_247_999_961_984_000n} decimals={18} displayDecimals={4} symbol="ETH" size="large" />
            <AmountText value={2_470_900_000n} decimals={6} displayDecimals={2} minDecimals={2} symbol="USDC" size="medium" />
            <AmountText value={1n} decimals={18} displayDecimals={6} symbol="ETH" />
            <AmountText usdCents={-1_234n} />
          </div>
        </Section>

        <Section id="overlays" title="Sheets, dialogs, menus, toasts">
          <div className="ds-chips">
            <Button variant="secondary" onClick={() => setSheet(true)} data-testid="preview-open-sheet">
              Open a sheet
            </Button>
            <Button variant="destructive" onClick={() => setModal(true)} data-testid="preview-open-modal">
              Forget this wallet
            </Button>
            <Button variant="secondary" onClick={() => setConfirm("tap")} data-testid="preview-open-confirm">
              Confirm (tap)
            </Button>
            <Button variant="secondary" onClick={() => setConfirm("hold")} data-testid="preview-open-hold">
              Confirm (hold)
            </Button>
            <Button variant="secondary" onClick={() => setAssetPicker(true)} data-testid="preview-open-assets">
              Choose asset
            </Button>
            <Button variant="secondary" onClick={() => setChainPicker(true)} data-testid="preview-open-chains">
              Choose network
            </Button>
            <ToastDemo />
            <Menu label="Wallet" icon="wallet" testId="preview-menu">
              {(close) => (
                <>
                  <ListRow title="Privacy Center" leading={<Icon name="shield" />} onPress={close} />
                  <ListRow title="Security" leading={<Icon name="lock" />} onPress={close} />
                </>
              )}
            </Menu>
          </div>
          <Header title="A screen header" back={() => undefined} actions={<IconButton label="Settings" icon="gear" />} />
        </Section>

        <Section id="icons" title="Icons">
          <div className="ds-chips">
            {ICON_NAMES.map((n) => (
              <span key={n} className="ds-chip" title={n}>
                <Icon name={n} size={20} />
              </span>
            ))}
          </div>
        </Section>

        <BottomSheet open={sheet} onClose={() => setSheet(false)} title="A sheet" description="Closes with the back button, Escape or the overlay.">
          <p>Content</p>
        </BottomSheet>
        <Modal open={modal} onClose={() => setModal(false)} title="Forget this wallet?" danger description="This removes the wallet from this device.">
          <Button variant="destructive" onClick={() => setModal(false)}>
            Forget
          </Button>
        </Modal>
        <ConfirmSheet
          open={confirm !== null}
          mode={confirm ?? "tap"}
          holdMs={600}
          onCancel={() => setConfirm(null)}
          onConfirm={() => setConfirm(null)}
          title="Review Send"
          summary={<p>2,500 USDC to 0x43…82C1</p>}
        />
        <AssetSelector open={assetPicker} onClose={() => setAssetPicker(false)} assets={assets} onChange={() => undefined} />
        <ChainSelector open={chainPicker} onClose={() => setChainPicker(false)} chains={chains} value={chain} onChange={setChain} />
      </div>
    </ToastProvider>
  );
}
