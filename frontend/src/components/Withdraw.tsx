import { useEffect, useState } from "react";
import type { Address } from "viem";
import { parseDestination } from "@ref/wallet/destinations";
import { unacknowledgedBlocks, type LintId } from "@ref/wallet/privacyLint";
import { formatUsd } from "@ref/wallet/valuation";
import type { Deployment } from "../sdk/chain";
import { privateWithdrawal } from "../sdk/privateTx";
import { assetsOf, bucketBelowFor, formatAmount, isBucketFor, parseAmount } from "../sdk/assets";
import { consumeFreshAddress, peekFreshAddress } from "../keys/chainKeys";
import { priceStore } from "../sdk/prices";
import { holdersAbove } from "../sdk/poolDeposits";
import { noteStore } from "../wallet/notes";
import { useSettings } from "../wallet/settings";
import { topBucket, walletLint } from "../wallet/lintFacts";
import { AssetSelect } from "./AssetSelect";
import { DestinationCard } from "./DestinationCard";
import { PrivacyLint } from "./PrivacyLint";
import { Scorecard } from "./Scorecard";

// Public exit (spec §34): reveals vault/amount/recipient on settlement. The default recipient is a
// fresh address of this wallet (plan §28, §45); the proof is generated locally in a Web Worker. Works
// in every private asset (plan §36): the asset's own vault releases the funds. V2 (whale spec §18, §21):
// a typed recipient is parsed (EIP-55 when mixed-case; another chain's address refused by name), shown
// on the destination card with its USD value, and the privacy lint runs before the button is enabled.
export function Withdraw({ masterSeed, deployment, account = null }: { masterSeed: Uint8Array; deployment: Deployment | null; /** the connected public wallet, if any: a recipient equal to it is flagged */ account?: string | null }) {
  const { submission, advanced, verifyReads } = useSettings();
  const assets = assetsOf(deployment);
  const [asset, setAsset] = useState(assets[0]);
  // the default recipient is the next fresh EVM address of this wallet (plan §28, §45): shown now,
  // reserved in the journal only when the withdrawal is confirmed, never handed out twice
  const [recipient, setRecipient] = useState(() => peekFreshAddress(masterSeed, "evm").address);
  const [edited, setEdited] = useState(false);
  const [amount, setAmount] = useState("1.0");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [acknowledged, setAcknowledged] = useState<LintId[]>([]);
  const [holders, setHolders] = useState<number | null>(null);
  const units = parseAmount(asset, amount);
  const bucket = bucketBelowFor(asset, units);
  const parsed = edited ? parseDestination("evm", recipient) : null;
  const recipientError = parsed && !parsed.ok ? parsed.reason : "";
  const assessment = units > 0n ? priceStore.assess(units, asset) : null;
  const usd = assessment && "usd" in assessment.value ? formatUsd(assessment.value.usd) : null;
  useEffect(() => {
    if (!deployment || units <= topBucket(asset.decimals)) { setHolders(null); return; }
    let live = true;
    holdersAbove(deployment, asset.vault, units).then((h) => { if (live) setHolders(h); }).catch(() => { if (live) setHolders(null); });
    return () => { live = false; };
  }, [deployment, units, asset]);
  const lintItems = units > 0n ? walletLint({ action: "withdraw", tier: assessment?.tier ?? "standard", deployment, settings: { submission, verifyReads }, destination: recipient, destinationKind: edited ? "entered" : "fresh", account, delaySeconds: 0, amount: units, decimals: asset.decimals, amountIsBucket: isBucketFor(asset, units), holders, acknowledged }) : null;
  const blocked = lintItems ? unacknowledgedBlocks(lintItems).length > 0 : false;

  function useFresh() {
    setRecipient(peekFreshAddress(masterSeed, "evm").address);
    setEdited(false);
  }

  async function withdraw() {
    if (!deployment) { setStatus("No deployment configured (VITE_RPC_URLS / VITE_CORE / VITE_ETH_VAULT)."); return; }
    if (edited && recipientError) { setStatus(`Recipient: ${recipientError}.`); return; }
    if (noteStore.balance(BigInt(asset.vault)) < units) { setStatus(`Not enough ${asset.symbol} in your private balance.`); return; }
    setBusy(true);
    const to = (edited ? (parsed && parsed.ok ? parsed.normalized : recipient) : consumeFreshAddress(masterSeed, "evm").address) as Address; // reserve the fresh address now
    if (!edited) setRecipient(to);
    try {
      const r = await privateWithdrawal({ masterSeed, deployment, amount: units, recipient: to, vault: asset.vault, onStatus: setStatus });
      setStatus(advanced
        ? `Withdrawn ${amount} ${asset.symbol} to ${to.slice(0, 8)}… (tx ${r.txHash.slice(0, 10)}…); proof ${(r.proofMs / 1000).toFixed(1)} s${r.verifiedLocally ? ", verified locally" : ""}; spent leaves ${r.spent.join(", ")}${r.change ? `; change note at leaf ${r.change.leafIndex}` : ""}.`
        : `Withdrawn ${amount} ${asset.symbol} to ${to.slice(0, 8)}….`);
      if (!edited) setRecipient(peekFreshAddress(masterSeed, "evm").address); // the next withdrawal gets the next address
    } catch (e: any) {
      setStatus(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel" data-testid="withdraw">
      <h3>Withdraw to a public address</h3>
      <AssetSelect assets={assets} value={asset} onChange={(a) => { setAsset(a); setAmount(a.decimals === 18 ? "1.0" : "100"); }} />
      <label>Recipient {edited ? "(an address you entered)" : "(a fresh address of this wallet, reserved when you confirm)"}</label>
      <input value={recipient} onChange={(e: any) => { setRecipient(e.target.value); setEdited(e.target.value.trim() !== ""); }} placeholder="0x… (never your public wallet address)" />
      {edited && <p className="muted" style={{ fontSize: 12, marginTop: -6 }}>Never use your public wallet address here. <button className="tab" onClick={useFresh}>Use a fresh address of this wallet</button></p>}
      {recipientError && <p className="error" style={{ fontSize: 13, marginTop: -4 }} data-testid="destination-error">Recipient: {recipientError}.</p>}
      <label>Amount ({asset.symbol}){usd ? ` · ≈ ${usd}` : ""}</label>
      <input value={amount} onChange={(e: any) => setAmount(e.target.value)} inputMode="decimal" />
      {units > 0n && !isBucketFor(asset, units) && (
        <p className="muted" style={{ fontSize: 12, marginTop: -6 }}>
          An exact amount is a fingerprint on the public side.{" "}
          {bucket ? <button className="tab" onClick={() => setAmount(formatAmount(asset, bucket))}>Use {formatAmount(asset, bucket)} {asset.symbol} (the rest stays private)</button> : "Choose a larger amount."}
        </p>
      )}
      {units > 0n && !recipientError && <DestinationCard network="Ethereum" asset={asset.symbol} address={recipient} amount={formatAmount(asset, units)} usd={usd} kind={edited ? "entered" : "fresh"} />}
      {lintItems && <PrivacyLint items={lintItems} onAcknowledge={(id) => setAcknowledged((a) => [...a, id])} />}
      <button className="primary" onClick={withdraw} disabled={busy || units <= 0n || !!recipientError || blocked} title={blocked ? "Acknowledge the privacy check first" : undefined}>
        Withdraw
      </button>
      {status && <p className="muted">{status}</p>}
      <Scorecard action="withdraw" facts={{ delaySeconds: 0, amountIsBucket: isBucketFor(asset, units), privateSubmission: submission.kind === "relayer", rpcEndpoints: deployment?.rpcUrls?.length ?? 1, recipientFresh: !edited }} />
    </div>
  );
}
