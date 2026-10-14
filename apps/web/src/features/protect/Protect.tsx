// Protect Assets (spec §3.4, §3.11, §9; plan §14): the connected wallet pays a public deposit into the protected
// balance — From (the wallet and its balance, read through its own provider), Protect as (the asset), the amount in
// common sizes, "You will receive", "Service fee: none now", the network cost at the wallet's own gas price, then a
// tap to confirm, the progress of the operation record, and what was added. Technical details stay collapsed. The
// engine is sdk/privateTx.ts (shieldNative / shieldERC20 over the prepare → submit → track facade); the record is
// the operation state machine's. A failed ERC-20 deposit may leave its exact-amount approval behind: it is read and
// can be revoked here.
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatUnits } from "viem";
import { bucketsFor } from "@privacy-wallet/protocol/wallet/amounts";
import { availablePrice, formatUsd, usdOf } from "@privacy-wallet/protocol/wallet/valuation";
import { AmountInput, AssetSelector, Button, Card, Collapsible, ConfirmSheet, FeeSummary, ListRow, Page, SecurityCard, SuccessCard, TextButton, type AssetOption } from "@privacy-wallet/ui";
import { useT } from "../../app/i18n/useT";
import { readAllowance, revokeAllowance } from "@privacy-wallet/sdk/allowances";
import { assetsOf, bucketBelowFor, formatAmount, isBucketFor, parseAmount, type Asset } from "@privacy-wallet/sdk/assets";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import { activeProvider } from "@privacy-wallet/wallet-engine/injected";
import { protectNet, shieldERC20, shieldNative } from "@privacy-wallet/sdk/privateTx";
import { priceStore, feedsConfigured } from "@privacy-wallet/sdk/prices";
import { protectFees } from "../fees/feeEngine";
import { PRIVACY_FEE_BPS } from "@privacy-wallet/protocol/wallet/fees";
import { shortAccount } from "@privacy-wallet/wallet-engine/connection";
import { applyEvent, newOperation } from "@privacy-wallet/sdk/operations/store";
import { engineListener } from "@privacy-wallet/sdk/operations/engineEvents";
import { classify } from "@privacy-wallet/sdk/operations/errors/catalog";
import { OperationProgress } from "../operations/OperationProgress";
import { estimateShieldCost, estimateUsd, type NetworkEstimate } from "./estimate";
import { readPublicBalance } from "./publicBalance";
import { useOperation, usePrefs, usePrices, useSettings } from "../../hooks";

export interface ProtectProps {
  masterSeed: Uint8Array;
  deployment: Deployment | null;
  /** the connected public wallet's account, if any */
  account: string | null;
  connecting?: boolean;
  onConnect?: () => void;
  onBack?: () => void;
  onDone?: () => void;
  /** More → Security, for the backup nudge */
  onBackup?: () => void;
}

type Step = "form" | "progress" | "done" | "failed";
let nudgeDismissed = false; // once per session (spec §3.2: once on the Protect review)

/** The common sizes offered as chips: the alphabet's buckets around one whole unit of the asset. */
export function chipBuckets(decimals: number): bigint[] {
  const unit = 10n ** BigInt(decimals);
  const lo = decimals >= 8 ? unit / 10n : unit * 100n;
  const hi = lo * 100n;
  return bucketsFor(decimals).filter((b) => b >= lo && b <= hi).slice(0, 6);
}

export function Protect(p: ProtectProps) {
  const t = useT();
  const { advanced } = useSettings();
  const prices = usePrices();
  const pf = usePrefs();
  const assets = useMemo(() => assetsOf(p.deployment), [p.deployment]);
  const [asset, setAsset] = useState<Asset>(assets[0]);
  const [amount, setAmount] = useState("");
  const [picking, setPicking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [step, setStep] = useState<Step>("form");
  const [opId, setOpId] = useState<string | null>(null);
  const [result, setResult] = useState<{ approveTx?: string; txHash: string; leafIndex: number } | null>(null);
  const [status, setStatus] = useState("");
  const [publicBalance, setPublicBalance] = useState<bigint | null>(null);
  const [estimate, setEstimate] = useState<NetworkEstimate | null>(null);
  const [leftover, setLeftover] = useState<bigint | null | "unknown">(null);
  const [revoked, setRevoked] = useState<string | null>(null);
  const [nudge, setNudge] = useState(!nudgeDismissed);
  const record = useOperation(opId);
  const units = asset ? parseAmount(asset, amount) : 0n;
  const priced = feedsConfigured(p.deployment);
  useEffect(() => { if (priced) void priceStore.refresh(p.deployment); }, [p.deployment, priced]);

  // the connected wallet's balance in the asset, through its own provider
  useEffect(() => {
    let live = true;
    setPublicBalance(null);
    if (!p.account || !asset) return;
    readPublicBalance(p.account, asset.token).then((b) => { if (live) setPublicBalance(b); });
    return () => { live = false; };
  }, [p.account, asset]);
  // the network cost at the wallet's own gas price, for this amount
  useEffect(() => {
    let live = true;
    setEstimate(null);
    if (!p.deployment || !p.account || !asset || units <= 0n) return;
    const d = p.deployment;
    const id = setTimeout(() => { estimateShieldCost(d, asset, units, p.account).then((e) => { if (live) setEstimate(e); }); }, 250);
    return () => { live = false; clearTimeout(id); };
  }, [p.deployment, p.account, asset, units]);

  const ethPrice = availablePrice(prices.prices, "ETH");
  const assetPrice = asset ? availablePrice(prices.prices, asset.symbol) : null;
  const amountUsd = asset && assetPrice && units > 0n ? formatUsd(usdOf(units, asset.decimals, assetPrice.usd1e8)) : null;
  const balanceUsd = asset && assetPrice && publicBalance !== null ? formatUsd(usdOf(publicBalance, asset.decimals, assetPrice.usd1e8)) : null;
  const networkUsd = estimateUsd(estimate, prices);
  // V6 (spec v2.0 §3, §11.1): 1 % through ProtectRouter — no relayer is involved, the fee is the contract's constant
  const routed = p.deployment && units > 0n ? protectNet(p.deployment, units) : { fee: 0n, net: units };
  const fees = asset ? protectFees({ amount: units, fee: routed.fee, feePercentBps: PRIVACY_FEE_BPS, networkUsd, format: (u) => `${formatAmount(asset, u)} ${asset.symbol}`, formatUsd, t }) : null;
  const bucket = asset && units > 0n && !isBucketFor(asset, units) ? bucketBelowFor(asset, units) : null;
  const chips = asset ? chipBuckets(asset.decimals).map((b) => ({ label: `${formatUnits(b, asset.decimals)} ${asset.symbol}`, value: formatUnits(b, asset.decimals) })) : [];
  const options: AssetOption[] = assets.map((a) => ({ id: a.vault, symbol: a.symbol, name: a.symbol, decimals: a.decimals, ...(a.token ? { address: a.token } : {}) }));
  const needsBackup = !pf.backup;

  const checkLeftover = useCallback(async () => {
    if (!asset?.token) return;
    const eth = activeProvider();
    const [from] = (eth ? await eth.request({ method: "eth_accounts" }).catch(() => []) : []) as `0x${string}`[];
    if (!from) { setLeftover("unknown"); return; }
    const a = await readAllowance(asset.token, from, p.deployment?.protectRouter ?? asset.vault); // V6: the router pulls a protect's tokens
    setLeftover(a === null ? "unknown" : a);
  }, [asset]);
  async function revokeLeftover() {
    if (!asset?.token) return;
    try { const tx = await revokeAllowance(asset.token, p.deployment?.protectRouter ?? asset.vault); setRevoked(tx); setLeftover(0n); } catch (e) { setStatus(classify(e).detail); }
  }

  async function run() {
    const deployment = p.deployment;
    if (!deployment || !asset) { setStatus(t("protect.noDeployment")); return; }
    setConfirming(false);
    if (nudge) nudgeDismissed = true; // shown once per session (spec §3.2)
    const rec = newOperation({ kind: "protect", amounts: { asset: asset.symbol, decimals: asset.decimals, input: units.toString() }, destination: { kind: "privacy-address", display: t("protect.toBalance"), chain: "ethereum" }, tier: "standard", fees: fees?.lines ?? [] });
    applyEvent(rec.id, { type: "review" });
    applyEvent(rec.id, { type: "confirm" });
    setOpId(rec.id); setStep("progress"); setStatus(""); setLeftover(null); setRevoked(null);
    const onEvent = engineListener((ev) => { applyEvent(rec.id, ev); });
    try {
      const r = asset.token
        ? await shieldERC20({ masterSeed: p.masterSeed, deployment, token: asset.token, vault: asset.vault, amount: units, estimatedWei: estimate?.wei, onStatus: setStatus, onEvent })
        : await shieldNative({ masterSeed: p.masterSeed, deployment, amount: units, estimatedWei: estimate?.wei, onStatus: setStatus, onEvent });
      setResult(r);
      setStep("done");
    } catch (e) {
      const c = classify(e);
      const first = c.code === "user_rejected" ? applyEvent(rec.id, { type: "rejected", code: c.code, detail: c.detail }) : null;
      if (!first || !first.ok) {
        const second = c.fundsClass === "unknown" ? applyEvent(rec.id, { type: "recovery-required", code: c.code, detail: c.detail }) : applyEvent(rec.id, { type: "submission-failed", code: c.code, detail: c.detail });
        if (!second || !second.ok) applyEvent(rec.id, { type: "submission-failed", code: c.code, detail: c.detail });
      }
      setStep("failed");
      if (asset.token) void checkLeftover();
    }
  }

  const nudgeCard = needsBackup && nudge ? (
    <SecurityCard title={t("backup.title")} body={t("backup.body")} testId="backup-nudge" action={
      <div className="ds-actions">
        <Button variant="secondary" onClick={() => { nudgeDismissed = true; setNudge(false); p.onBackup?.(); }} data-testid="backup-now">{t("backup.now")}</Button>
        <TextButton onClick={() => { nudgeDismissed = true; setNudge(false); }} data-testid="backup-later">{t("backup.later")}</TextButton>
      </div>
    } />
  ) : null;

  const leftoverNotice = asset?.token && leftover !== null ? (
    <Card testId="leftover-allowance">
      <p className="ds-note">
        {leftover === "unknown" ? t("protect.leftoverUnknown") : leftover > 0n ? t("protect.leftoverRemains", { amount: formatAmount(asset, leftover), symbol: asset.symbol }) : t("protect.leftoverNone")}
        {revoked ? ` ${t("protect.revoked", { hash: `${revoked.slice(0, 10)}…` })}` : ""}
      </p>
      {leftover !== "unknown" && leftover > 0n ? <Button variant="secondary" onClick={() => void revokeLeftover()} data-testid="revoke-leftover">{t("protect.revoke")}</Button> : null}
    </Card>
  ) : null;

  if (step !== "form" && record) {
    const done = step === "done" && result;
    return (
      <Page title={t("route.protect")} back={step === "progress" ? undefined : p.onBack} testId="protect">
        <div className="ds-stack">
          <Card>
            <div className="ds-kv"><span className="ds-kv-label">{t("protect.amount")}</span><span className="ds-kv-value ds-tabular">{asset ? `${formatAmount(asset, units)} ${asset.symbol}` : ""}{amountUsd ? ` · ≈ ${amountUsd}` : ""}</span></div>
          </Card>
          <OperationProgress record={record} actions={step === "failed" ? <Button variant="secondary" onClick={() => setStep("form")} data-testid="protect-back">{t("protect.backToForm")}</Button> : undefined} />
          {status && step === "progress" ? <p className="ds-note" data-testid="protect-status">{status}</p> : null}
          {done ? (
            <SuccessCard
              testId="protect-done"
              title={t("protect.done", { amount: formatAmount(asset!, units), symbol: asset!.symbol })}
              body={advanced ? <p className="ds-note">{t("protect.doneAdvanced", { amount: formatAmount(asset!, units), symbol: asset!.symbol, leaf: result!.leafIndex, hash: `${result!.txHash.slice(0, 10)}…` })}</p> : undefined}
              actions={
                <>
                  <Button onClick={() => p.onDone?.()} data-testid="protect-finish">{t("protect.doneButton")}</Button>
                  <Button variant="secondary" onClick={() => { setStep("form"); setAmount(""); setResult(null); setOpId(null); }} data-testid="protect-again">{t("protect.again")}</Button>
                </>
              }
            />
          ) : null}
          {step === "failed" ? leftoverNotice : null}
          {advanced && (result || record.refs.txHashes.length) ? (
            <Collapsible summary={t("protect.technical")} testId="protect-technical">
              {asset ? <div className="ds-kv"><span className="ds-kv-label">{t("protect.vault")}</span><span className="ds-mono-break">{asset.vault}</span></div> : null}
              {result ? <div className="ds-kv"><span className="ds-kv-label">{t("protect.leaf", { leaf: result.leafIndex })}</span><span className="ds-mono-break">{result.txHash}</span></div> : null}
              {result?.approveTx ? <div className="ds-kv"><span className="ds-kv-label">{t("protect.approveTx")}</span><span className="ds-mono-break">{result.approveTx}</span></div> : null}
            </Collapsible>
          ) : null}
        </div>
      </Page>
    );
  }

  return (
    <Page title={t("route.protect")} back={p.onBack} testId="protect" primaryAction={<Button size="lg" full onClick={() => setConfirming(true)} disabled={!asset || units <= 0n || !p.deployment} data-testid="protect-submit">{t("protect.action")}</Button>}>
      <div className="ds-stack">
        <div className="ds-switch-row">
          <span className="ds-field-hint" data-testid="protect-connection">{p.account ? t("protect.connected", { account: shortAccount(p.account) }) : t("protect.connectLine")}</span>
          {!p.account && p.onConnect ? <Button variant="secondary" loading={p.connecting} onClick={p.onConnect} data-testid="protect-connect">{t("protect.connect")}</Button> : null}
        </div>
        <Card padding="none">
          <ListRow title={t("protect.wallet")} subtitle={p.account ? shortAccount(p.account) : t("protect.notConnected")} leading={<span className="ds-kv-label">{t("protect.from")}</span>}
            trailing={<span className="ds-tabular" data-testid="protect-public-balance">{asset && publicBalance !== null ? `${formatAmount(asset, publicBalance)} ${asset.symbol}${balanceUsd ? ` ≈ ${balanceUsd}` : ""}` : p.account ? t("protect.balanceUnknown") : ""}</span>} testId="protect-from" />
          <ListRow title={t("protect.as")} subtitle={asset?.symbol ?? ""} onPress={assets.length > 1 ? () => setPicking(true) : undefined} trailing={assets.length > 1 ? <span className="ds-kv-label">{t("protect.change")}</span> : null} testId="protect-asset" />
        </Card>
        {asset ? (
          <AmountInput id="protect-amount" label={t("protect.amount")} asset={asset} value={amount} onChange={setAmount} usd={amountUsd} buckets={chips} bucketsLabel={t("protect.commonSizes")}
            onMax={asset.token && publicBalance !== null && publicBalance > 0n ? () => setAmount(formatUnits(publicBalance, asset.decimals)) : undefined} maxLabel={t("protect.max")}
            hint={bucket !== null ? <>{t("protect.bucketHint")} <button type="button" className="ds-chip" onClick={() => setAmount(formatUnits(bucket, asset.decimals))} data-testid="protect-use-bucket">{t("protect.useBucket", { amount: formatUnits(bucket, asset.decimals), symbol: asset.symbol })}</button></> : units > 0n && !isBucketFor(asset, units) ? t("protect.bucketHint") : undefined} testId="protect-amount" />
        ) : null}
        {fees && asset ? <FeeSummary receive={fees.receive} total={fees.total} lines={fees.lines} totalLabel={t("fees.total")} detailsLabel={t("fees.viewDetails")} testId="protect-fees" /> : null}
        <p className="ds-note" data-testid="protect-public-note">{t("protect.publicNote", { approval: asset?.token ? t("protect.approvalNote") : "" })}</p>
        {status ? <p className="ds-note-warn" data-testid="protect-status">{status}</p> : null}
        {advanced && asset ? (
          <Collapsible summary={t("protect.technical")} testId="protect-technical">
            <div className="ds-kv"><span className="ds-kv-label">{t("protect.vault")}</span><span className="ds-mono-break">{asset.vault}</span></div>
            {asset.token ? <div className="ds-kv"><span className="ds-kv-label">{t("protect.token")}</span><span className="ds-mono-break">{asset.token}</span></div> : null}
            {estimate ? <div className="ds-kv"><span className="ds-kv-label">{t("protect.gas")}</span><span className="ds-kv-value ds-tabular">{t("protect.gasLine", { gas: estimate.gas.toString(), gwei: formatUnits(estimate.feePerGasWei, 9) })}</span></div> : null}
          </Collapsible>
        ) : null}
      </div>
      <AssetSelector open={picking} onClose={() => setPicking(false)} assets={options} value={asset?.vault} onChange={(id) => { const a = assets.find((x) => x.vault === id); if (a) { setAsset(a); setAmount(""); } setPicking(false); }} title={t("protect.as")} searchLabel={t("protect.search")} testId="protect-asset-selector" />
      <ConfirmSheet open={confirming} onCancel={() => { setConfirming(false); if (nudge) nudgeDismissed = true; }} onConfirm={() => void run()} mode="tap" title={asset ? t("protect.confirmTitle", { amount: formatAmount(asset, units), symbol: asset.symbol }) : ""} confirmLabel={t("protect.confirm")} cancelLabel={t("protect.cancel")} testId="protect-confirm"
        summary={asset ? (
          <div className="ds-stack-sm">
            <p className="ds-note">{t("protect.confirmSummary", { amount: formatAmount(asset, units), symbol: asset.symbol })}</p>
            {fees ? <FeeSummary receive={fees.receive} total={fees.total} lines={fees.lines} totalLabel={t("fees.total")} detailsLabel={t("fees.viewDetails")} testId="protect-confirm-fees" /> : null}
            {nudgeCard}
            {ethPrice === null && priced ? <p className="ds-note">{t("protect.noPrice")}</p> : null}
          </div>
        ) : null} />
    </Page>
  );
}
