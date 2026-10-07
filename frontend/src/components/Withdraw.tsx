import { useState } from "react";
import { formatEther, isAddress, parseEther, type Address } from "viem";
import { BUCKETS, isBucket } from "@ref/wallet/amounts";
import type { Deployment } from "../sdk/chain";
import { privateWithdrawal } from "../sdk/privateTx";
import { consumeFreshAddress } from "../keys/chainKeys";
import { noteStore } from "../wallet/notes";
import { useSettings } from "../wallet/settings";
import { Scorecard } from "./Scorecard";

// Public exit (spec §34): reveals vault/amount/recipient on settlement. The default recipient is a
// fresh address of this wallet (plan §28, §45); the proof is generated locally in a Web Worker.
export function Withdraw({ masterSeed, deployment }: { masterSeed: Uint8Array; deployment: Deployment | null }) {
  const { submission, advanced } = useSettings();
  const [recipient, setRecipient] = useState("");
  const [fresh, setFresh] = useState(false);
  const [amount, setAmount] = useState("1.0");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const wei = (() => { try { return parseEther(amount || "0"); } catch { return 0n; } })();
  const bucket = [...BUCKETS].reverse().find((b) => b <= wei);

  function useFresh() {
    const a = consumeFreshAddress(masterSeed, "evm");
    setRecipient(a.address);
    setFresh(true);
  }

  async function withdraw() {
    if (!deployment) { setStatus("No deployment configured (VITE_RPC_URLS / VITE_CORE / VITE_ETH_VAULT)."); return; }
    if (!isAddress(recipient)) { setStatus("Enter a fresh 0x recipient address, or use one of this wallet's."); return; }
    if (noteStore.balance(BigInt(deployment.ethVault)) < wei) { setStatus("Not enough in your private balance."); return; }
    setBusy(true);
    try {
      const r = await privateWithdrawal({ masterSeed, deployment, amount: wei, recipient: recipient as Address, onStatus: setStatus });
      setStatus(advanced
        ? `Withdrawn ${amount} ETH to ${recipient.slice(0, 8)}… (tx ${r.txHash.slice(0, 10)}…); proof ${(r.proofMs / 1000).toFixed(1)} s${r.verifiedLocally ? ", verified locally" : ""}; spent leaves ${r.spent.join(", ")}${r.change ? `; change note at leaf ${r.change.leafIndex}` : ""}.`
        : `Withdrawn ${amount} ETH to ${recipient.slice(0, 8)}….`);
    } catch (e: any) {
      setStatus(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <h3>Withdraw to a public address</h3>
      <label>Recipient {fresh ? "(a fresh address of this wallet)" : ""}</label>
      <input value={recipient} onChange={(e: any) => { setRecipient(e.target.value); setFresh(false); }} placeholder="0x… (never your public wallet address)" />
      {!fresh && <p className="muted" style={{ fontSize: 12, marginTop: -6 }}><button className="tab" onClick={useFresh}>Use a fresh address of this wallet</button></p>}
      <label>Amount</label>
      <input value={amount} onChange={(e: any) => setAmount(e.target.value)} />
      {wei > 0n && !isBucket(wei) && (
        <p className="muted" style={{ fontSize: 12, marginTop: -6 }}>
          An exact amount is a fingerprint on the public side.{" "}
          {bucket ? <button className="tab" onClick={() => setAmount(formatEther(bucket))}>Use {formatEther(bucket)} ETH (the rest stays private)</button> : "Choose at least 0.001 ETH."}
        </p>
      )}
      <button className="primary" onClick={withdraw} disabled={busy || wei <= 0n}>
        Withdraw
      </button>
      {status && <p className="muted">{status}</p>}
      <Scorecard action="withdraw" facts={{ delaySeconds: 0, amountIsBucket: isBucket(wei), privateSubmission: submission.kind === "relayer", rpcEndpoints: deployment?.rpcUrls?.length ?? 1, recipientFresh: fresh }} />
    </div>
  );
}
