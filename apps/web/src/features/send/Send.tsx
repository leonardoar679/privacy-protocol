// Send (spec §3.5, §10, §12–§13, §16; plan §15–§16): one screen for a private transfer (a `pp1…` privacy address,
// the preferred operation: nothing public) and a public exit (a chain address; a fresh address of this wallet by
// default, never the public wallet's own) — the asset, the amount, the destination with its checks and the address
// book, the privacy line, the fee summary (exact-input by default: the typed amount leaves the balance and
// "Recipient receives" is the largest number; exact-output on request), the privacy lint from the `large` band, the
// Review, then the operation record's progress. The engines are sdk/privateTx.ts (privateTransfer /
// privateWithdrawal); the Review is the V2–V4 screen, replaced in Stage 8.
import { useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import { decodePrivacyAddress } from "@privacy-wallet/protocol/address";
import { looksLikeChain, parseDestination } from "@privacy-wallet/protocol/wallet/destinations";
import { unacknowledgedBlocks, type LintId } from "@privacy-wallet/protocol/wallet/privacyLint";
import { formatUsd, type Tier } from "@privacy-wallet/protocol/wallet/valuation";
import { AddressInput, AmountInput, AssetSelector, Button, Card, ListRow, Page, Segmented, StatusBadge, FeeSummary, type AddressCheck, type AssetOption, type BookEntryView, type FeeLine } from "@privacy-wallet/ui";
import { useT } from "../../app/i18n/useT";
import { assetsOf, bucketBelowFor, formatAmount, isBucketFor, parseAmount, type Asset } from "@privacy-wallet/sdk/assets";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import { HousekeepingNeeded, privateTransfer, privateWithdrawal } from "@privacy-wallet/sdk/privateTx";
import { consumeFreshAddress, peekFreshAddress } from "@privacy-wallet/sdk/keys/chainKeys";
import { feedsConfigured, priceStore } from "@privacy-wallet/sdk/prices";
import { holdersAbove } from "@privacy-wallet/sdk/poolDeposits";
import { controlsFor, issuerLine } from "@privacy-wallet/sdk/tiers";
import { downloadText } from "@privacy-wallet/sdk/download";
import { destinationCheck } from "@privacy-wallet/sdk/wallet/addressBook";
import { scheduleHousekeeping } from "@privacy-wallet/sdk/wallet/housekeeping";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { topBucket, walletLint } from "@privacy-wallet/sdk/wallet/lintFacts";
import { DestinationCard } from "../../components/DestinationCard";
import { PrivacyLint } from "../../components/PrivacyLint";
import { Review, type ReviewLine } from "../review/ReviewScreen";
import { DestinationStatus } from "../../components/protection/AddressBook";
import { sendFees, type FeeView } from "../fees/feeEngine";
import { useFeeTerms } from "../fees/useFeeTerms";
import { applyEvent, newOperation } from "@privacy-wallet/sdk/operations/store";
import { engineListener } from "@privacy-wallet/sdk/operations/engineEvents";
import { classify } from "@privacy-wallet/sdk/operations/errors/catalog";
import { OperationProgress } from "../operations/OperationProgress";
import { useAddressBook, useNotes, useOperation, useSettings } from "../../hooks";

export type SendMode = "private" | "public";
export interface SendProps {
  masterSeed: Uint8Array;
  deployment: Deployment | null;
  /** the connected public wallet, if any: a recipient equal to it is flagged */
  account?: string | null;
  initialMode?: SendMode;
  onBack?: () => void;
  onDone?: () => void;
}
type Step = "form" | "review" | "progress" | "done" | "failed";
interface Result { txHash: string; proofMs: number; verifiedLocally: boolean; leafIndex?: number }

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;

export function Send(p: SendProps) {
  const t = useT();
  const { submission, advanced, verifyReads, secondFactor } = useSettings();
  const book = useAddressBook();
  useNotes();
  const assets = useMemo(() => assetsOf(p.deployment), [p.deployment]);
  const [asset, setAsset] = useState<Asset>(assets[0]);
  const [mode, setMode] = useState<SendMode>(p.initialMode ?? "private");
  const [amount, setAmount] = useState("");
  const [exactOutput, setExactOutput] = useState(false);
  const [recipient, setRecipient] = useState(() => (p.initialMode === "public" ? peekFreshAddress(p.masterSeed, "evm").address : ""));
  const [edited, setEdited] = useState(false);
  const [picking, setPicking] = useState(false);
  const [step, setStep] = useState<Step>("form");
  const [opId, setOpId] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [acknowledged, setAcknowledged] = useState<LintId[]>([]);
  const [destAck, setDestAck] = useState(false);
  const [consolidate, setConsolidate] = useState(false);
  const [holders, setHolders] = useState<number | null>(null);
  const record = useOperation(opId);
  const terms = useFeeTerms(asset && parseAmount(asset, amount) > 0n ? asset.vault : null); // read once an amount is typed: no request before the user acts

  const units = asset ? parseAmount(asset, amount) : 0n;
  const priced = feedsConfigured(p.deployment);
  const assessment = asset && units > 0n && priced ? priceStore.assess(units, asset) : null;
  const usd = assessment && "usd" in assessment.value ? formatUsd(assessment.value.usd) : null;
  const tier: Tier = assessment?.tier ?? "standard";
  const controls = controlsFor(tier);
  useEffect(() => { if (priced) void priceStore.refresh(p.deployment); }, [p.deployment, priced]);
  useEffect(() => {
    if (!p.deployment || !asset || mode !== "public" || units <= topBucket(asset.decimals)) { setHolders(null); return; }
    let live = true;
    holdersAbove(p.deployment, asset.vault, units).then((h) => { if (live) setHolders(h); }).catch(() => { if (live) setHolders(null); });
    return () => { live = false; };
  }, [p.deployment, units, asset, mode]);

  // the destination: a privacy address, or a chain address parsed by the §16 rules (another chain's address refused by name)
  const trimmed = recipient.trim();
  const privateOk = mode === "private" && (() => { try { decodePrivacyAddress(trimmed); return true; } catch { return false; } })();
  const privateError = mode === "private" && trimmed && !privateOk ? (() => { try { decodePrivacyAddress(trimmed); return ""; } catch (e) { return e instanceof Error ? e.message : String(e); } })() : "";
  const parsed = mode === "public" && edited ? parseDestination("evm", trimmed) : null;
  const recipientError = mode === "public" ? (parsed && !parsed.ok ? parsed.reason : "") : privateError;
  const otherChain = mode === "public" && trimmed ? looksLikeChain(trimmed) : null;
  const destCheck = mode === "public" && edited && parsed?.ok ? destinationCheck("evm", trimmed, { tier }) : null;
  const destinationLocked = controls.destinationLock && !!destCheck && !destCheck.ok;
  const destinationKind: "fresh" | "entered" | "privacy-address" = mode === "private" ? "privacy-address" : edited ? "entered" : "fresh";
  const checks: AddressCheck[] = (() => {
    const empty = !trimmed;
    const valid = mode === "private" ? privateOk : !recipientError && EVM_RE.test(trimmed);
    const state = (ok: boolean): AddressCheck["state"] => (empty ? "idle" : ok ? "ok" : "fail");
    return [
      { label: t("checks.validAddress"), state: state(valid) },
      { label: t("checks.correctNetwork"), state: state(mode === "private" ? privateOk : otherChain === null || otherChain === "evm"), ...(otherChain && otherChain !== "evm" ? { detail: t("checks.chainDetected", { chain: otherChain }) } : {}) },
      { label: t("checks.tokenSupported"), state: asset ? "ok" : "fail" },
      { label: mode === "private" ? t("checks.privacyAddress") : t("checks.formatValid"), state: state(valid) },
    ];
  })();

  const lint = asset && units > 0n && (controls.lint || mode === "public")
    ? walletLint({ action: mode === "private" ? "transfer" : "withdraw", tier, deployment: p.deployment, settings: { submission, verifyReads }, destination: trimmed, destinationKind, account: mode === "private" ? null : (p.account ?? null), delaySeconds: 0, amount: units, decimals: asset.decimals, amountIsBucket: mode === "private" ? true : isBucketFor(asset, units), holders: mode === "public" ? holders : undefined, acknowledged })
    : null;
  const blocked = lint ? unacknowledgedBlocks(lint).length > 0 : false;

  // the fee summary (spec §10): exact-input by default — the typed amount leaves the balance
  const format = (u: bigint) => (asset ? `${formatAmount(asset, u)} ${asset.symbol}` : u.toString());
  const view: FeeView | null = asset && units > 0n && terms.status === "ready" && terms.terms ? sendFees({ mode: exactOutput ? "exact-output" : "exact-input", amount: units, terms: terms.terms, withdrawal: mode === "public", format, t }) : null;
  const delivered = view ? view.split.delivered : units;
  const total = view ? view.split.total : units;
  const feeLines: FeeLine[] = view ? view.lines : terms.status === "public" ? [{ label: t("fees.relayer"), value: t("send.paidByWallet") }] : [{ label: t("fees.total"), value: t("fees.networkUnknown") }];
  // before the relayer's terms are read the recipient's figure is not known (exact-input: the fees come out of what you send); the public path pays the fees from the wallet
  const feeReceive = view ? view.receive : { label: t("fees.recipientReceives"), value: units === 0n ? "—" : terms.status === "public" ? format(units) : t("fees.networkUnknown") };
  const feePay = view?.pay;
  const feeTotal = view ? view.total : terms.status === "public" ? t("send.paidByWallet") : t("fees.networkUnknown");
  const bucket = asset && mode === "public" && units > 0n && !isBucketFor(asset, units) ? bucketBelowFor(asset, units) : null;
  const balance = asset ? noteStore.balance(BigInt(asset.vault)) : 0n;
  const options: AssetOption[] = assets.map((a) => ({ id: a.vault, symbol: a.symbol, name: a.symbol, decimals: a.decimals, ...(a.token ? { address: a.token } : {}), balance: `${formatAmount(a, noteStore.balance(BigInt(a.vault)))} ${a.symbol}` }));
  const fresh = peekFreshAddress(p.masterSeed, "evm").address;
  const bookEntries: BookEntryView[] = mode === "public"
    ? [{ id: "fresh", label: t("send.freshEntry"), address: fresh }, ...book.filter((e) => e.chain === "evm" && e.verification.status === "verified" && e.lifecycle !== "retired" && e.lifecycle !== "generated").map((e) => ({ id: e.id, label: e.label ?? `${e.address.slice(0, 6)}…${e.address.slice(-4)}`, address: e.address }))]
    : [];

  function takeFresh() { setRecipient(peekFreshAddress(p.masterSeed, "evm").address); setEdited(false); setDestAck(false); }
  function changeMode(m: SendMode) {
    if (m === mode) return;
    setMode(m); setAcknowledged([]); setDestAck(false);
    if (m === "public") { setRecipient(peekFreshAddress(p.masterSeed, "evm").address); setEdited(false); } else { setRecipient(""); setEdited(false); }
  }
  function changeRecipient(v: string) {
    const x = v.trim();
    if (x.startsWith("pp1") && mode === "public") { setMode("private"); setRecipient(x); setEdited(true); setDestAck(false); return; }
    if (mode === "private" && EVM_RE.test(x)) { setMode("public"); setRecipient(x); setEdited(true); setDestAck(false); return; }
    if (mode === "public" && x === "") { takeFresh(); return; }
    setRecipient(v); setEdited(true); setDestAck(false);
  }
  const canReview = !!asset && units > 0n && !busy && !recipientError && (mode === "private" ? privateOk : !!trimmed) && !blocked && !destinationLocked;

  async function run() {
    const deployment = p.deployment;
    if (!deployment || !asset) { setStatus(t("protect.noDeployment")); return; }
    if (mode === "private") { try { decodePrivacyAddress(trimmed); } catch (e) { setStatus(t("send.recipientError", { reason: e instanceof Error ? e.message : String(e) })); return; } }
    if (mode === "public" && edited && recipientError) { setStatus(t("send.recipientError", { reason: recipientError })); return; }
    if (balance < total) { setStatus(t("send.notEnough", { symbol: asset.symbol })); return; }
    const to = mode === "private" ? trimmed : edited ? (parsed && parsed.ok ? parsed.normalized : trimmed) : consumeFreshAddress(p.masterSeed, "evm").address; // the fresh address is reserved now
    if (mode === "public" && !edited) setRecipient(to);
    const rec = newOperation({ kind: mode === "private" ? "send" : "withdraw", amounts: { asset: asset.symbol, decimals: asset.decimals, input: total.toString(), expectedOutput: delivered.toString() }, destination: { kind: destinationKind, display: to, chain: "ethereum" }, tier, fees: feeLines });
    applyEvent(rec.id, { type: "review" });
    applyEvent(rec.id, { type: "confirm" });
    setOpId(rec.id); setStep("progress"); setBusy(true); setStatus(""); setConsolidate(false);
    const onEvent = engineListener((ev) => { applyEvent(rec.id, ev); });
    try {
      if (mode === "private") {
        const r = await privateTransfer({ masterSeed: p.masterSeed, deployment, amount: delivered, recipient: to, vault: asset.vault, onStatus: setStatus, onEvent });
        setResult({ txHash: r.txHash, proofMs: r.proofMs, verifiedLocally: r.verifiedLocally, leafIndex: r.recipientNote.leafIndex });
      } else {
        const r = await privateWithdrawal({ masterSeed: p.masterSeed, deployment, amount: delivered, recipient: to as Address, vault: asset.vault, onStatus: setStatus, onEvent });
        setResult({ txHash: r.txHash, proofMs: r.proofMs, verifiedLocally: r.verifiedLocally });
        if (!edited) setRecipient(peekFreshAddress(p.masterSeed, "evm").address); // the next withdrawal gets the next address
      }
      setStep("done");
    } catch (e) {
      const c = classify(e);
      const first = c.code === "user_rejected" ? applyEvent(rec.id, { type: "rejected", code: c.code, detail: c.detail }) : null;
      if (!first || !first.ok) {
        const second = c.fundsClass === "unknown" ? applyEvent(rec.id, { type: "recovery-required", code: c.code, detail: c.detail }) : applyEvent(rec.id, { type: "submission-failed", code: c.code, detail: c.detail });
        if (!second || !second.ok) applyEvent(rec.id, { type: "submission-failed", code: c.code, detail: c.detail });
      }
      setConsolidate(e instanceof HousekeepingNeeded); // the balance is there, spread over too many notes: offer the maintenance step now
      setStep("failed");
    } finally {
      setBusy(false);
    }
  }

  const amountText = asset ? `${formatAmount(asset, total)} ${asset.symbol}` : "";
  const pageTitle = mode === "private" ? t("send.title") : t("send.titlePublic");

  if (step === "review" && asset) {
    const lines: ReviewLine[] = mode === "private"
      ? [
        { id: "price", label: t("review.amountFixed"), ok: true, meaning: t("review.amountFixedPrivate", { amount: formatAmount(asset, total), symbol: asset.symbol }) },
        { id: "route", label: t("review.routeChecked"), ok: true, meaning: t("review.routePrivate") },
        { id: "destination", label: t("review.destinationVerified"), ok: privateOk, meaning: t("review.destinationPrivate") },
        { id: "slippage", label: t("review.noSlippage"), ok: true, meaning: t("review.noSlippageMeaning", { amount: formatAmount(asset, delivered), symbol: asset.symbol }) },
        { id: "privacy", label: t("review.privacyReviewed"), ok: !lint || unacknowledgedBlocks(lint).length === 0, meaning: t("review.privacyReviewedMeaning") },
      ]
      : [
        { id: "price", label: t("review.amountFixed"), ok: true, meaning: t("review.amountFixedPublic", { amount: formatAmount(asset, delivered), symbol: asset.symbol }) },
        { id: "route", label: t("review.routeChecked"), ok: true, meaning: t("review.routePublic") },
        { id: "destination", label: t("review.destinationVerified"), ok: !edited || (parsed?.ok === true && destAck && !destinationLocked), meaning: edited ? `${t("review.destinationEntered")}${destCheck ? `; ${destCheck.status}` : ""}` : t("review.destinationFresh"), ...(edited && !destAck ? { ack: { text: t("review.checkedGroups"), done: destAck, onAck: () => setDestAck(true) } } : {}) },
        { id: "slippage", label: t("review.noSlippage"), ok: true, meaning: t("review.noSlippageMeaning", { amount: formatAmount(asset, delivered), symbol: asset.symbol }) },
        { id: "privacy", label: t("review.privacyReviewed"), ok: !lint || unacknowledgedBlocks(lint).length === 0, meaning: t("review.privacyReviewedMeaning") },
      ];
    const exportReview = controls.export ? () => downloadText(`privacy-wallet-${mode === "private" ? "transfer" : "withdrawal"}-review-${Date.now()}.json`, JSON.stringify({ format: `privacy-protocol/${mode === "private" ? "transfer" : "withdrawal"}-review/v1`, exportedAt: new Date().toISOString(), asset: asset.symbol, amount: total.toString(), delivered: delivered.toString(), recipient: trimmed, tier, usd, lint: lint ?? [], fees: feeLines }, null, 2)) : undefined;
    return (
      <Page title={pageTitle} back={() => setStep("form")} testId="send-tab">
        <div data-testid={mode === "private" ? "send" : "withdraw"}>
          <Review moment={mode === "private" ? "send" : "withdraw"} tier={tier} controls={controls} usd={usd} amount={amountText} from={t("review.fromProtected", { symbol: asset.symbol })}
            to={mode === "private" ? { network: t("review.privatePool"), asset: asset.symbol, address: trimmed, kind: "privacy-address" } : { network: t("review.ethereum"), asset: asset.symbol, address: trimmed, kind: edited ? "entered" : "fresh" }}
            receiveMin={format(delivered)} privacy={{ level: mode === "private" ? "Excellent" : edited ? "Reduced" : "Good" }} lint={lint ?? []} onAcknowledgeLint={(id) => setAcknowledged((a) => [...a, id])} lines={lines}
            issuer={issuerLine(asset.symbol)} advanced={advanced} onExport={exportReview} secondFactor={controls.secondFactor ? { credentialId: secondFactor.credentialId } : null} busy={busy ? status : undefined} error={!busy && status ? status : undefined} onConfirm={run} onCancel={() => setStep("form")} />
        </div>
      </Page>
    );
  }

  if (step !== "form" && record && asset) {
    return (
      <Page title={pageTitle} back={step === "progress" ? undefined : p.onBack} testId="send-tab">
        <div className="ds-stack" data-testid={mode === "private" ? "send" : "withdraw"}>
          <Card>
            <div className="ds-kv"><span className="ds-kv-label">{feeReceive.label}</span><span className="ds-kv-value ds-tabular">{format(delivered)}</span></div>
            <div className="ds-kv"><span className="ds-kv-label">{t("review.to")}</span><span className="ds-mono-break">{record.destination.display}</span></div>
          </Card>
          <OperationProgress record={record} actions={step === "failed" ? (
            <>
              <Button variant="secondary" onClick={() => { setStep("review"); setStatus(""); }} data-testid="send-back-review">{t("send.backToReview")}</Button>
              <Button variant="ghost" onClick={() => { setStep("form"); setStatus(""); }} data-testid="send-edit">{t("send.edit")}</Button>
              {consolidate ? <Button variant="secondary" data-testid="consolidate-now" onClick={() => { const ok = scheduleHousekeeping(p.deployment, { now: true }); setStatus(ok ? t("send.consolidateScheduled") : t("send.consolidateNotScheduled")); }}>{t("send.consolidateNow")}</Button> : null}
            </>
          ) : undefined} />
          {status && step !== "done" ? <p className="ds-note" data-testid="send-status">{status}</p> : null}
          {step === "done" && result ? (
            <Card testId="send-done">
              <StatusBadge tone="ok">{mode === "private" ? t("send.donePrivate", { amount: formatAmount(asset, delivered), symbol: asset.symbol }) : t("send.donePublic", { amount: formatAmount(asset, delivered), symbol: asset.symbol, address: `${record.destination.display.slice(0, 8)}…` })}</StatusBadge>
              {advanced ? <p className="ds-note">{t("send.doneAdvanced", { hash: `${result.txHash.slice(0, 10)}…`, seconds: (result.proofMs / 1000).toFixed(1), verified: result.verifiedLocally ? t("send.verifiedLocally") : "", leaf: result.leafIndex !== undefined ? t("send.recipientLeaf", { leaf: result.leafIndex }) : "" })}</p> : null}
              <div className="ds-actions">
                <Button onClick={() => p.onDone?.()} data-testid="send-finish">{t("send.doneButton")}</Button>
                <Button variant="secondary" onClick={() => { setStep("form"); setAmount(""); setResult(null); setOpId(null); setStatus(""); }} data-testid="send-again">{t("send.again")}</Button>
              </div>
            </Card>
          ) : null}
        </div>
      </Page>
    );
  }

  return (
    <Page title={pageTitle} back={p.onBack} testId="send-tab" primaryAction={<Button size="lg" full onClick={() => { setStatus(""); setStep("review"); }} disabled={!canReview} data-testid="send-review" title={blocked ? t("send.acknowledgeFirst") : destinationLocked ? (destCheck?.status ?? "") : undefined}>{t("send.review")}</Button>}>
      <div className="ds-stack" data-testid={mode === "private" ? "send" : "withdraw"}>
        <Segmented value={mode} onChange={(v) => changeMode(v as SendMode)} ariaLabel={t("send.modeLabel")} name="send-mode" options={[{ value: "private", label: t("send.privately"), testId: "send-mode-private" }, { value: "public", label: t("send.public"), testId: "send-mode-public" }]} />
        <Card padding="none">
          <ListRow title={t("send.asset")} subtitle={asset ? `${asset.symbol} · ${formatAmount(asset, balance)} ${asset.symbol}` : ""} onPress={assets.length > 1 ? () => setPicking(true) : undefined} trailing={assets.length > 1 ? <span className="ds-kv-label">{t("protect.change")}</span> : null} testId="send-asset" />
        </Card>
        {asset ? (
          <AmountInput id="send-amount" label={t("send.amount")} asset={asset} value={amount} onChange={setAmount} usd={usd} onMax={balance > 0n ? () => setAmount(formatAmount(asset, balance)) : undefined} maxLabel={t("protect.max")} testId="send-amount"
            hint={bucket !== null ? <>{t("send.exactFingerprint")} <button type="button" className="ds-chip" onClick={() => setAmount(formatAmount(asset, bucket))} data-testid="send-use-bucket">{t("send.useBucket", { amount: formatAmount(asset, bucket), symbol: asset.symbol })}</button></> : undefined} />
        ) : null}
        <AddressInput id="send-to" label={t("send.to")} value={recipient} onChange={changeRecipient} checks={checks} error={recipientError || undefined} placeholder={mode === "private" ? t("send.pastePlaceholder") : t("send.publicPlaceholder")} pasteLabel={t("send.paste")} book={bookEntries} bookLabel={t("send.book")} testId="send-to"
          onPickEntry={(id) => { if (id === "fresh") takeFresh(); else { const e = book.find((x) => x.id === id); if (e) { setRecipient(e.address); setEdited(true); setDestAck(false); } } }}
          status={mode === "public" ? (
            <>
              {edited ? <p className="ds-note">{t("send.neverPublicWallet")} <button type="button" className="ds-chip" onClick={takeFresh} data-testid="send-use-fresh">{t("send.useFresh")}</button></p> : <p className="ds-note" data-testid="send-fresh-note">{t("send.freshNote")}</p>}
              {edited && parsed?.ok && asset ? <DestinationStatus chain="evm" address={trimmed} tier={tier} masterSeed={p.masterSeed} deployment={p.deployment} asset={asset.symbol} /> : null}
            </>
          ) : null} />
        {recipientError ? <p className="ds-field-error" data-testid="destination-error">{t("send.recipientError", { reason: recipientError })}</p> : null}
        {mode === "public" && asset && !recipientError && trimmed ? <DestinationCard network={t("review.ethereum")} asset={asset.symbol} address={trimmed} amount={units > 0n ? formatAmount(asset, delivered) : undefined} usd={usd} kind={edited ? "entered" : "fresh"} /> : null}
        <div className="ds-kv"><span className="ds-kv-label">{t("send.privacy")}</span><span className="ds-privacy-line" data-testid="send-privacy">{mode === "private" ? t("send.protected") : t("send.reduced")}</span></div>
        {asset && units > 0n ? (
          <>
            <FeeSummary receive={feeReceive} pay={feePay} total={feeTotal} lines={feeLines} totalLabel={t("fees.total")} detailsLabel={t("fees.viewDetails")} testId="send-fees" />
            <button type="button" className="ds-chip" aria-pressed={exactOutput} onClick={() => setExactOutput((v) => !v)} data-testid="send-exact-output">{t("send.exactOutput")}</button>
          </>
        ) : null}
        {assessment && tier !== "standard" ? <StatusBadge tone="pending" testId="send-large">{assessment.failSafe ? t("send.largeNoticeFailSafe") : t("send.largeNotice")}</StatusBadge> : null}
        {lint ? <PrivacyLint items={lint} compact={mode === "private"} onAcknowledge={(id) => setAcknowledged((a) => [...a, id])} /> : null}
        {status ? <p className="ds-note-warn" data-testid="send-status">{status}</p> : null}
        {consolidate ? <Button variant="secondary" data-testid="consolidate-now" onClick={() => { const ok = scheduleHousekeeping(p.deployment, { now: true }); setStatus(ok ? t("send.consolidateScheduled") : t("send.consolidateNotScheduled")); }}>{t("send.consolidateNow")}</Button> : null}
        <p className="ds-note">{mode === "private" ? t("send.privateNote") : t("send.exitNote")}</p>
      </div>
      <AssetSelector open={picking} onClose={() => setPicking(false)} assets={options} value={asset?.vault} onChange={(id) => { const a = assets.find((x) => x.vault === id); if (a) { setAsset(a); setAmount(""); } setPicking(false); }} title={t("send.asset")} searchLabel={t("protect.search")} testId="send-asset-selector" />
    </Page>
  );
}
