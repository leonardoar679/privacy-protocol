import { useState } from "react";
import { isAddress, type Address } from "viem";
import type { Deployment } from "../sdk/chain";
import { privateWithdrawal } from "../sdk/privateTx";
import { assetsOf, bucketBelowFor, formatAmount, isBucketFor, parseAmount } from "../sdk/assets";
import { consumeFreshAddress, peekFreshAddress } from "../keys/chainKeys";
import { noteStore } from "../wallet/notes";
import { useSettings } from "../wallet/settings";
import { AssetSelect } from "./AssetSelect";
import { Scorecard } from "./Scorecard";

// Public exit (spec §34): reveals vault/amount/recipient on settlement. The default recipient is a
// fresh address of this wallet (plan §28, §45); the proof is generated locally in a Web Worker. Works
// in every private asset (plan §36): the asset's own vault releases the funds.
export function Withdraw({ masterSeed, deployment }: { masterSeed: Uint8Array; deployment: Deployment | null }) {
  const { submission, advanced } = useSettings();
  const assets = assetsOf(deployment);
  const [asset, setAsset] = useState(assets[0]);
  // the default recipient is the next fresh EVM address of this wallet (plan §28, §45): shown now,
  // reserved in the journal only when the withdrawal is confirmed, never handed out twice
  const [recipient, setRecipient] = useState(() => peekFreshAddress(masterSeed, "evm").address);
  const [edited, setEdited] = useState(false);
  const [amount, setAmount] = useState("1.0");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const units = parseAmount(asset, amount);
  const bucket = bucketBelowFor(asset, units);

  function useFresh() {
    setRecipient(peekFreshAddress(masterSeed, "evm").address);
    setEdited(false);
  }

  async function withdraw() {
    if (!deployment) { setStatus("No deployment configured (VITE_RPC_URLS / VITE_CORE / VITE_ETH_VAULT)."); return; }
    if (edited && !isAddress(recipient)) { setStatus("Enter a fresh 0x recipient address, or use one of this wallet's."); return; }
    if (noteStore.balance(BigInt(asset.vault)) < units) { setStatus(`Not enough ${asset.symbol} in your private balance.`); return; }
    setBusy(true);
    const to = (edited ? recipient : consumeFreshAddress(masterSeed, "evm").address) as Address; // reserve the fresh address now
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
    <div className="panel">
      <h3>Withdraw to a public address</h3>
      <AssetSelect assets={assets} value={asset} onChange={(a) => { setAsset(a); setAmount(a.decimals === 18 ? "1.0" : "100"); }} />
      <label>Recipient {edited ? "(an address you entered)" : "(a fresh address of this wallet, reserved when you confirm)"}</label>
      <input value={recipient} onChange={(e: any) => { setRecipient(e.target.value); setEdited(e.target.value.trim() !== ""); }} placeholder="0x… (never your public wallet address)" />
      {edited && <p className="muted" style={{ fontSize: 12, marginTop: -6 }}>Never use your public wallet address here. <button className="tab" onClick={useFresh}>Use a fresh address of this wallet</button></p>}
      <label>Amount ({asset.symbol})</label>
      <input value={amount} onChange={(e: any) => setAmount(e.target.value)} />
      {units > 0n && !isBucketFor(asset, units) && (
        <p className="muted" style={{ fontSize: 12, marginTop: -6 }}>
          An exact amount is a fingerprint on the public side.{" "}
          {bucket ? <button className="tab" onClick={() => setAmount(formatAmount(asset, bucket))}>Use {formatAmount(asset, bucket)} {asset.symbol} (the rest stays private)</button> : "Choose a larger amount."}
        </p>
      )}
      <button className="primary" onClick={withdraw} disabled={busy || units <= 0n}>
        Withdraw
      </button>
      {status && <p className="muted">{status}</p>}
      <Scorecard action="withdraw" facts={{ delaySeconds: 0, amountIsBucket: isBucketFor(asset, units), privateSubmission: submission.kind === "relayer", rpcEndpoints: deployment?.rpcUrls?.length ?? 1, recipientFresh: !edited }} />
    </div>
  );
}
