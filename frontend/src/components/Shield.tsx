import { useState } from "react";
import { formatEther, parseEther } from "viem";
import { BUCKETS, isBucket } from "@ref/wallet/amounts";
import type { Deployment } from "../sdk/chain";
import { shieldNative } from "../sdk/privateTx";
import { useSettings } from "../wallet/settings";
import { Scorecard } from "./Scorecard";

// Shielding is a PUBLIC deposit (amount visible); privacy comes from later private transfers. The
// note (owner commitment from the spending key, a fresh note secret) is created here and recorded in
// the wallet's journal once the chain assigns its leaf index.
export function Shield({ masterSeed, deployment }: { masterSeed: Uint8Array; deployment: Deployment | null }) {
  const { advanced } = useSettings();
  const [amount, setAmount] = useState("1.0");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const wei = (() => { try { return parseEther(amount || "0"); } catch { return 0n; } })();
  const bucket = [...BUCKETS].reverse().find((b) => b <= wei);

  async function shield() {
    if (!deployment) { setStatus("No deployment configured (VITE_RPC_URLS / VITE_CORE / VITE_ETH_VAULT)."); return; }
    setBusy(true);
    try {
      const r = await shieldNative({ masterSeed, deployment, amount: wei, onStatus: setStatus });
      setStatus(advanced ? `Shielded ${amount} ETH — note at leaf ${r.leafIndex} (tx ${r.txHash.slice(0, 10)}…).` : `Added ${amount} ETH to your private balance.`);
    } catch (e: any) {
      setStatus(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <h3>Add to your private balance</h3>
      <label>Amount (ETH)</label>
      <input value={amount} onChange={(e: any) => setAmount(e.target.value)} />
      {wei > 0n && !isBucket(wei) && (
        <p className="muted" style={{ fontSize: 12, marginTop: -6 }}>
          Public amounts should be common sizes so no deposit stands out.{" "}
          {bucket ? <button className="tab" onClick={() => setAmount(formatEther(bucket))}>Use {formatEther(bucket)} ETH</button> : "Choose at least 0.001 ETH."}
        </p>
      )}
      <button className="primary" onClick={shield} disabled={busy || wei <= 0n}>
        Shield
      </button>
      {status && <p className="muted">{status}</p>}
      <p className="muted" style={{ fontSize: 12 }}>
        This deposit is public by design (your connected wallet sends it); everything after it is private.
      </p>
      <Scorecard action="shield" facts={{ delaySeconds: 0, amountIsBucket: isBucket(wei), privateSubmission: false, rpcEndpoints: deployment?.rpcUrls?.length ?? 1, recipientFresh: false }} />
    </div>
  );
}
