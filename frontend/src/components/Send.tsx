import { useState } from "react";
import { parseEther } from "viem";
import { decodePrivacyAddress } from "@ref/address";
import type { Deployment } from "../sdk/chain";
import { privateTransfer } from "../sdk/privateTx";
import { noteStore } from "../wallet/notes";
import { useSettings } from "../wallet/settings";
import { Scorecard } from "./Scorecard";

// Private internal transfer — the preferred operation (spec §33): no public sender/recipient/amount.
// The recipient's privacy address ("pp1…", bech32m) carries their owner commitment and view key;
// their note's payload is encrypted to that key, so they find it by rescanning the chain.
export function Send({ masterSeed, deployment }: { masterSeed: Uint8Array; deployment: Deployment | null }) {
  const { submission, advanced } = useSettings();
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("0.5");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function send() {
    if (!deployment) { setStatus("No deployment configured (VITE_RPC_URLS / VITE_CORE / VITE_ETH_VAULT)."); return; }
    try { decodePrivacyAddress(recipient); } catch (e: any) { setStatus(`Recipient: ${e?.message ?? "invalid privacy address"}`); return; }
    const wei = parseEther(amount);
    if (noteStore.balance(BigInt(deployment.ethVault)) < wei) { setStatus("Not enough in your private balance."); return; }
    setBusy(true);
    try {
      const r = await privateTransfer({ masterSeed, deployment, amount: wei, recipient, onStatus: setStatus });
      setStatus(advanced
        ? `Sent ${amount} ETH privately (tx ${r.txHash.slice(0, 10)}…; proof ${(r.proofMs / 1000).toFixed(1)} s${r.verifiedLocally ? ", verified locally" : ""}). The recipient's note is at leaf ${r.recipientNote.leafIndex}${r.change ? `; your change at leaf ${r.change.leafIndex}` : ""}.`
        : `Sent ${amount} ETH privately.`);
    } catch (e: any) {
      setStatus(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <h3>Send privately</h3>
      <label>Recipient privacy address</label>
      <input value={recipient} onChange={(e: any) => setRecipient(e.target.value.trim())} placeholder="pp1…" />
      <label>Amount</label>
      <input value={amount} onChange={(e: any) => setAmount(e.target.value)} />
      <button className="primary" onClick={send} disabled={busy}>
        Send
      </button>
      {status && <p className="muted">{status}</p>}
      <Scorecard action="transfer" facts={{ delaySeconds: 0, amountIsBucket: true, privateSubmission: submission.kind === "relayer", rpcEndpoints: deployment?.rpcUrls?.length ?? 1, recipientFresh: true }} />
    </div>
  );
}
