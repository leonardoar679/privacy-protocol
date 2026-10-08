import { useEffect, useState } from "react";
import { decodePrivacyAddress } from "@ref/address";
import { formatUsd, type Tier } from "@ref/wallet/valuation";
import { unacknowledgedBlocks, type LintId } from "@ref/wallet/privacyLint";
import type { Deployment } from "../sdk/chain";
import { privateTransfer } from "../sdk/privateTx";
import { assetsOf, formatAmount, parseAmount } from "../sdk/assets";
import { feedsConfigured, priceStore } from "../sdk/prices";
import { controlsFor, issuerLine } from "../sdk/tiers";
import { downloadText } from "../sdk/download";
import { noteStore } from "../wallet/notes";
import { useSettings } from "../wallet/settings";
import { walletLint } from "../wallet/lintFacts";
import { AssetSelect } from "./AssetSelect";
import { PrivacyLint } from "./PrivacyLint";
import { Review, type ReviewLine } from "./Review";
import { Scorecard } from "./Scorecard";

// Private internal transfer — the preferred operation (spec §33): no public sender/recipient/amount.
// The recipient's privacy address ("pp1…", bech32m) carries their owner commitment and view key;
// their note's payload is encrypted to that key, so they find it by rescanning the chain. Works in
// every private asset (plan §36): the note is created in the chosen asset's vault. V2 (whale spec §13,
// §24): the value tier adds the Review with the lint from enhanced, the hold from high-value, the second
// factor from high-value-secondary and the export at institutional.
export function Send({ masterSeed, deployment }: { masterSeed: Uint8Array; deployment: Deployment | null }) {
  const { submission, advanced, verifyReads, secondFactor } = useSettings();
  const assets = assetsOf(deployment);
  const [asset, setAsset] = useState(assets[0]);
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("0.5");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState(false);
  const [acknowledged, setAcknowledged] = useState<LintId[]>([]);
  const units = parseAmount(asset, amount);
  const priced = feedsConfigured(deployment);
  const assessment = units > 0n && priced ? priceStore.assess(units, asset) : null;
  const usd = assessment && "usd" in assessment.value ? formatUsd(assessment.value.usd) : null;
  const tier: Tier = assessment?.tier ?? "standard";
  const controls = controlsFor(tier);
  useEffect(() => { if (priced) void priceStore.refresh(deployment); }, [deployment, priced]);
  const recipientOk = (() => { try { decodePrivacyAddress(recipient); return true; } catch { return false; } })();
  const lintItems = units > 0n && controls.lint ? walletLint({ action: "transfer", tier, deployment, settings: { submission, verifyReads }, destination: recipient, destinationKind: "privacy-address", account: null, delaySeconds: 0, amount: units, decimals: asset.decimals, amountIsBucket: true, acknowledged }) : null;

  async function send() {
    if (!deployment) { setStatus("No deployment configured (VITE_RPC_URLS / VITE_CORE / VITE_ETH_VAULT)."); return; }
    try { decodePrivacyAddress(recipient); } catch (e: any) { setStatus(`Recipient: ${e?.message ?? "invalid privacy address"}`); return; }
    if (noteStore.balance(BigInt(asset.vault)) < units) { setStatus(`Not enough ${asset.symbol} in your private balance.`); return; }
    setBusy(true);
    try {
      const r = await privateTransfer({ masterSeed, deployment, amount: units, recipient, vault: asset.vault, onStatus: setStatus });
      setStatus(advanced
        ? `Sent ${amount} ${asset.symbol} privately (tx ${r.txHash.slice(0, 10)}…; proof ${(r.proofMs / 1000).toFixed(1)} s${r.verifiedLocally ? ", verified locally" : ""}). The recipient's note is at leaf ${r.recipientNote.leafIndex}${r.change ? `; your change at leaf ${r.change.leafIndex}` : ""}.`
        : `Sent ${amount} ${asset.symbol} privately.`);
      setReview(false);
    } catch (e: any) {
      setStatus(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  if (review && lintItems) {
    const lines: ReviewLine[] = [
      { id: "price", label: "Amount fixed", ok: true, meaning: `${formatAmount(asset, units)} ${asset.symbol} leaves your private balance; nothing is public` },
      { id: "route", label: "Route checked", ok: true, meaning: "a private transfer inside the pool: proven in this wallet, no provider" },
      { id: "destination", label: "Destination verified", ok: recipientOk, meaning: "a privacy address with a valid checksum; the note is encrypted to its view key" },
      { id: "slippage", label: "No slippage", ok: true, meaning: "the recipient receives exactly this amount" },
      { id: "privacy", label: "Privacy reviewed", ok: unacknowledgedBlocks(lintItems).length === 0, meaning: "every privacy check is ok, a warning, or acknowledged" },
    ];
    return (
      <div className="panel" data-testid="send">
        <h3>Send privately</h3>
        <Review moment="send" tier={tier} controls={controls} usd={usd} amount={`${formatAmount(asset, units)} ${asset.symbol}`} from={`Private ${asset.symbol}`}
          to={{ network: "Private pool", asset: asset.symbol, address: recipient, kind: "privacy-address" }} privacy={{ level: "Excellent" }} lint={lintItems} onAcknowledgeLint={(id) => setAcknowledged((a) => [...a, id])} lines={lines}
          issuer={issuerLine(asset.symbol)} advanced={advanced} onExport={controls.export ? () => downloadText(`privacy-wallet-transfer-review-${Date.now()}.json`, JSON.stringify({ format: "privacy-protocol/transfer-review/v1", exportedAt: new Date().toISOString(), asset: asset.symbol, amount: units.toString(), recipient, tier, value: assessment?.value ?? null, lint: lintItems }, null, 2)) : undefined}
          secondFactor={controls.secondFactor ? { credentialId: secondFactor.credentialId } : null} busy={busy ? status : undefined} onConfirm={send} onCancel={() => setReview(false)} />
      </div>
    );
  }

  return (
    <div className="panel" data-testid="send">
      <h3>Send privately</h3>
      <AssetSelect assets={assets} value={asset} onChange={(a) => { setAsset(a); setAmount(a.decimals === 18 ? "0.5" : "50"); }} />
      <label>Recipient privacy address</label>
      <input value={recipient} onChange={(e: any) => setRecipient(e.target.value.trim())} placeholder="pp1…" />
      <label>Amount ({asset.symbol}){usd ? ` · ≈ ${usd}` : ""}</label>
      <input value={amount} onChange={(e: any) => setAmount(e.target.value)} inputMode="decimal" />
      {assessment && tier !== "standard" && <p className="notice" style={{ marginTop: -4, marginBottom: 10 }}>{assessment.failSafe ? "No price is available, so this transfer is treated as a large one: " : "A large transfer: "}it is reviewed before it is sent.</p>}
      {lintItems && <PrivacyLint items={lintItems} compact onAcknowledge={(id) => setAcknowledged((a) => [...a, id])} />}
      <button className="primary" onClick={() => (controls.review ? setReview(true) : send())} disabled={busy || units <= 0n || (controls.review && !recipientOk)}>
        {controls.review ? "Review" : "Send"}
      </button>
      {status && <p className="muted">{status}</p>}
      <Scorecard action="transfer" facts={{ delaySeconds: 0, amountIsBucket: true, privateSubmission: submission.kind === "relayer", rpcEndpoints: deployment?.rpcUrls?.length ?? 1, recipientFresh: true }} />
    </div>
  );
}
