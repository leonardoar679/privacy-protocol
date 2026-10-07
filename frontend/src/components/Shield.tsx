import { useState } from "react";
import { parseEther } from "viem";
import type { Deployment } from "../sdk/chain";
import { shieldNative } from "../sdk/privateTx";

// Shielding is a PUBLIC deposit (amount visible); privacy comes from later private transfers. The
// note (owner commitment from the spending key, a fresh note secret) is created here and recorded in
// the session note store once the chain assigns its leaf index.
export function Shield({ masterSeed, deployment }: { masterSeed: Uint8Array; deployment: Deployment | null }) {
  const [amount, setAmount] = useState("1.0");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function shield() {
    if (!deployment) { setStatus("No deployment configured (VITE_RPC_URL / VITE_CORE / VITE_ETH_VAULT)."); return; }
    setBusy(true);
    try {
      const r = await shieldNative({ masterSeed, deployment, amount: parseEther(amount), onStatus: setStatus });
      setStatus(`Shielded ${amount} ETH — note at leaf ${r.leafIndex} (tx ${r.txHash.slice(0, 10)}…). It is spendable privately from this session.`);
    } catch (e: any) {
      setStatus(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <h3>Shield ETH</h3>
      <label>Amount (ETH)</label>
      <input value={amount} onChange={(e: any) => setAmount(e.target.value)} />
      <button className="primary" onClick={shield} disabled={busy}>
        Shield
      </button>
      {status && <p className="muted">{status}</p>}
      <p className="muted" style={{ fontSize: 12 }}>
        Public amounts should be buckets (1-2-5 series) so no deposit carries a fingerprint; the odd remainder stays outside.
      </p>
    </div>
  );
}
