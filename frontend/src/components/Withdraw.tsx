import { useState } from "react";
import { isAddress, parseEther, type Address } from "viem";
import type { Deployment } from "../sdk/chain";
import { privateWithdrawal } from "../sdk/privateTx";
import { noteStore } from "../wallet/notes";

// Public exit (spec §34): reveals vault/amount/recipient on settlement. Use a fresh stealth
// recipient (§35); the proof is generated locally in a Web Worker from this session's notes.
export function Withdraw({ masterSeed, deployment }: { masterSeed: Uint8Array; deployment: Deployment | null }) {
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("1.0");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function withdraw() {
    if (!deployment) { setStatus("No deployment configured (VITE_RPC_URL / VITE_CORE / VITE_ETH_VAULT)."); return; }
    if (!isAddress(recipient)) { setStatus("Enter a fresh 0x recipient address."); return; }
    const wei = parseEther(amount);
    if (noteStore.balance(BigInt(deployment.ethVault)) < wei) { setStatus("Not enough shielded ETH in this session's notes."); return; }
    setBusy(true);
    try {
      const r = await privateWithdrawal({ masterSeed, deployment, amount: wei, recipient: recipient as Address, onStatus: setStatus });
      setStatus(`Withdrawn ${amount} ETH to ${recipient.slice(0, 8)}… (tx ${r.txHash.slice(0, 10)}…); proof ${(r.proofMs / 1000).toFixed(1)} s${r.verifiedLocally ? ", verified locally" : ""}; spent leaves ${r.spent.join(", ")}${r.change ? `; change note at leaf ${r.change.leafIndex}` : ""}.`);
    } catch (e: any) {
      setStatus(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <h3>Withdraw to a public address</h3>
      <label>Fresh stealth recipient (0x…)</label>
      <input value={recipient} onChange={(e: any) => setRecipient(e.target.value)} placeholder="0x…" />
      <label>Amount</label>
      <input value={amount} onChange={(e: any) => setAmount(e.target.value)} />
      <button className="primary" onClick={withdraw} disabled={busy}>
        Generate proof &amp; withdraw
      </button>
      {status && <p className="muted">{status}</p>}
    </div>
  );
}
