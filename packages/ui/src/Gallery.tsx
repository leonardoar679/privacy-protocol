// The gallery (spec §5): every component in every state on one page, for a visual review in dev (/gallery, Stage 3)
// and for the accessibility test. Sample figures only; nothing here reads the wallet.
import { useState } from "react";
import { AddressInput, AmountInput, AssetRow, AssetSelector, BalanceCard, BottomNav, BottomSheet, Button, Card, Collapsible, ConfirmSheet, ErrorCard, FeeSummary, Field, IconButton, Icon, ICON_NAMES, ListRow, Modal, Page, Progress, ProtectionBadge, QuoteCard, RadioGroup, SecurityCard, Segmented, Skeleton, StatusBadge, Switch, Tabs, TextInput, ToastProvider, TransactionTimeline, useToast } from "./index";

function ToastDemo() {
  const toast = useToast();
  return <Button variant="secondary" onClick={() => toast({ kind: "success", title: "Quote updated", body: "The route still guarantees the same minimum." })}>Show a toast</Button>;
}

export function Gallery() {
  const [sheet, setSheet] = useState(false);
  const [modal, setModal] = useState(false);
  const [confirm, setConfirm] = useState<"tap" | "hold" | null>(null);
  const [selector, setSelector] = useState(false);
  const [amount, setAmount] = useState("8000");
  const [address, setAddress] = useState("");
  const [seg, setSeg] = useState("asset");
  const [radio, setRadio] = useState("simple");
  const [on, setOn] = useState(true);
  const [tab, setTab] = useState("one");
  const assets = [{ id: "eth", symbol: "ETH", name: "Ethereum", balance: "4.82" }, { id: "usdc", symbol: "USDC", name: "USD Coin", balance: "12,400" }, { id: "btc", symbol: "BTC", name: "Bitcoin", chain: "Bitcoin" }];
  return (
    <ToastProvider>
      <div className="ds-gallery" data-testid="gallery">
        <Page title="Gallery" back={() => undefined} actions={<IconButton label="Settings" icon="gear" />}>
          <section><h2>Buttons</h2>
            <div className="ds-chips"><Button>Primary</Button><Button variant="secondary">Secondary</Button><Button variant="ghost">Ghost</Button><Button variant="danger">Danger</Button><Button loading>Loading</Button><Button disabled>Disabled</Button><Button icon="send" size="lg">Large with icon</Button></div>
          </section>
          <section><h2>Money</h2>
            <BalanceCard label="Protected balance" amountUsd="$24,382.41" subline="3 assets" status="protected" statusLabel="Protected" onStatus={() => undefined} />
            <BalanceCard label="Protected balance" amountUsd={null} status="loading" />
            <Card padding="md"><AssetRow asset={{ symbol: "ETH", name: "Ethereum" }} amount="4.82" usd="$19,280" onPress={() => undefined} /><AssetRow asset={{ symbol: "USDC", name: "USD Coin" }} amount="12,400" usd="$12,400" /></Card>
            <Card><FeeSummary receive={{ label: "You'll receive", value: "$9,886" }} pay={{ label: "You pay", value: "$10,000" }} total="$114" lines={[{ label: "Privacy fee (1.00 %)", value: "$100.00" }, { label: "Relayer / network", value: "$5.80", hint: "included in the privacy fee" }, { label: "Swap / provider", value: "$8.20" }]} /></Card>
            <QuoteCard quote={{ pay: "8,000 USDC", receive: "≈ 2.31 ETH", minimum: "2.28 ETH", fees: "$91.80", time: "~2 min", protection: "High", route: "Best route" }} labels={{ pay: "You pay", receive: "You receive", minimum: "Minimum", fees: "Fees", time: "Time", protection: "Protection High" }} onCompare={() => undefined} />
            <div className="ds-chips"><ProtectionBadge level="High" label="Protected" onPress={() => undefined} /><ProtectionBadge level="Reduced" label="Reduced" /><ProtectionBadge level="Off" label="Off" /><StatusBadge tone="ok">Completed</StatusBadge><StatusBadge tone="pending">Executing</StatusBadge><StatusBadge tone="warn">Needs attention</StatusBadge><StatusBadge tone="danger">Refunded</StatusBadge><StatusBadge tone="neutral">Cancelled</StatusBadge></div>
          </section>
          <section><h2>Inputs</h2>
            <AmountInput id="g-amount" label="Amount" asset={{ symbol: "USDC", decimals: 6 }} value={amount} onChange={setAmount} usd="≈ $8,000" buckets={[{ label: "1,000", value: "1000" }, { label: "5,000", value: "5000" }, { label: "10,000", value: "10000" }]} onMax={() => setAmount("12400")} />
            <AddressInput id="g-address" label="To" value={address} onChange={setAddress} placeholder="Paste address" checks={[{ label: "Valid address", state: "ok" }, { label: "Correct network", state: "ok" }, { label: "Token supported", state: "pending" }, { label: "Destination format valid", state: "idle" }]} book={[{ id: "1", label: "Savings", address: "0x43…82C1" }]} onPickEntry={() => setAddress("0x4300000000000000000000000000000000082C1")} />
            <Field label="Label" htmlFor="g-text" hint="A hint"><TextInput id="g-text" placeholder="Text" /></Field>
            <Field label="With an error" htmlFor="g-text2" error="This is not a valid address"><TextInput id="g-text2" invalid /></Field>
            <Segmented value={seg} onChange={setSeg} ariaLabel="Amount in" name="segmented" options={[{ value: "asset", label: "USDC" }, { value: "usd", label: "USD" }]} />
            <RadioGroup value={radio} onValueChange={setRadio} ariaLabel="Choose your experience" name="experience" options={[{ value: "simple", label: "Simple", description: "We choose the safest practical settings." }, { value: "advanced", label: "Advanced", description: "Show more controls and technical details." }]} />
            <Switch id="g-switch" checked={on} onCheckedChange={setOn} label="Notifications" description="Generic text only" />
            <Tabs value={tab} onValueChange={setTab} ariaLabel="Example tabs" items={[{ value: "one", label: "One", content: <p>First</p> }, { value: "two", label: "Two", content: <p>Second</p> }]} />
            <Button variant="secondary" onClick={() => setSelector(true)}>Choose asset</Button>
          </section>
          <section><h2>Status</h2>
            <TransactionTimeline steps={[{ label: "Quote locked", state: "done" }, { label: "Source confirmed", state: "done", detail: "12:04" }, { label: "Destination sent", state: "active" }, { label: "Destination finalized", state: "waiting" }]} />
            <Progress value={0.6} label="Generating proof" /><Progress value={null} label="Preparing" />
            <ErrorCard title="We couldn't complete this operation." fundsLine="Your funds were not moved." fundsState="not-moved" reason="The selected route expired before submission." actions={<Button>Get a new quote</Button>} />
            <ErrorCard title="We stopped the operation." fundsLine="Your funds are still protected." fundsState="still-protected" reason="The destination verification changed." actions={<Button variant="secondary">Review destination</Button>} />
            <SecurityCard title="Protect your wallet" body="Your recovery information controls access to your protected assets." action={<Button>Back up now</Button>} />
            <Collapsible summary="View details"><p>Hidden by default.</p></Collapsible>
            <Card padding="md"><ListRow title="Security" subtitle="Backup, lock, second factor" leading={<Icon name="lock" />} onPress={() => undefined} /><ListRow title="Privacy Center" leading={<Icon name="shield" />} onPress={() => undefined} /></Card>
            <Skeleton height={24} />
          </section>
          <section><h2>Sheets</h2>
            <div className="ds-chips"><Button variant="secondary" onClick={() => setSheet(true)}>Open a sheet</Button><Button variant="danger" onClick={() => setModal(true)}>Open a danger dialog</Button><Button variant="secondary" onClick={() => setConfirm("tap")}>Confirm (tap)</Button><Button variant="secondary" onClick={() => setConfirm("hold")}>Confirm (hold)</Button><ToastDemo /></div>
          </section>
          <section><h2>Icons</h2>
            <div className="ds-chips">{ICON_NAMES.map((n) => <span key={n} className="ds-chip" title={n}><Icon name={n} size={20} /></span>)}</div>
          </section>
        </Page>
        <BottomNav items={[{ to: "/", label: "Home", icon: "home" }, { to: "/swap", label: "Swap", icon: "swap" }, { to: "/activity", label: "Activity", icon: "activity" }, { to: "/more", label: "More", icon: "more" }]} current="/" onSelect={() => undefined} />
        <BottomSheet open={sheet} onClose={() => setSheet(false)} title="A sheet" description="Closes with the back button, Escape or the overlay."><p>Content</p></BottomSheet>
        <Modal open={modal} onClose={() => setModal(false)} title="Forget this wallet?" danger description="This removes the wallet from this device."><Button variant="danger" onClick={() => setModal(false)}>Forget</Button></Modal>
        <ConfirmSheet open={confirm !== null} mode={confirm ?? "tap"} holdMs={600} onCancel={() => setConfirm(null)} onConfirm={() => setConfirm(null)} title="Review Send" summary={<p>2,500 USDC to 0x43…82C1</p>} />
        <AssetSelector open={selector} onClose={() => setSelector(false)} assets={assets} onChange={() => undefined} />
      </div>
    </ToastProvider>
  );
}
