import { activeProvider } from "../sdk/injected";
import { useState } from "react";
import type { Deployment } from "../sdk/chain";
import { shieldERC20, shieldNative } from "../sdk/privateTx";
import { assetsOf, bucketBelowFor, formatAmount, isBucketFor, parseAmount } from "../sdk/assets";
import { useSettings } from "../wallet/settings";
import { AssetSelect } from "./AssetSelect";
import { Scorecard } from "./Scorecard";
import { readAllowance, revokeAllowance } from "../sdk/allowances";

// Shielding is a PUBLIC deposit (amount visible); privacy comes from later private transfers. The
// note (owner commitment from the spending key, a fresh note secret) is created here and recorded in
// the wallet's journal once the chain assigns its leaf index. ETH goes straight into the ETH vault;
// an ERC-20 (plan §36) needs an exact-amount approval first, then the token's own vault pulls it.
export function Shield({ masterSeed, deployment }: { masterSeed: Uint8Array; deployment: Deployment | null }) {
  const { advanced } = useSettings();
  const assets = assetsOf(deployment);
  const [asset, setAsset] = useState(assets[0]);
  const [amount, setAmount] = useState("1.0");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [leftover, setLeftover] = useState<bigint | null | "unknown">(null);
  const units = parseAmount(asset, amount);
  // High-Value Protection spec §13: a failed deposit may leave the exact-amount approval behind; it is read through the connected wallet and can be revoked
  async function checkLeftover() {
    if (!asset.token) return;
    const eth = activeProvider();
    const [from] = (eth ? await eth.request({ method: "eth_accounts" }).catch(() => []) : []) as `0x${string}`[];
    if (!from) { setLeftover("unknown"); return; }
    const a = await readAllowance(asset.token, from, asset.vault);
    setLeftover(a === null ? "unknown" : a);
  }
  async function revokeLeftover() {
    if (!asset.token) return;
    try { const tx = await revokeAllowance(asset.token, asset.vault); setStatus(`Allowance revoked (tx ${tx.slice(0, 10)}…).`); setLeftover(0n); } catch (e: any) { setStatus(e?.message ?? String(e)); }
  }
  const bucket = bucketBelowFor(asset, units);

  async function shield() {
    if (!deployment) { setStatus("No deployment configured (VITE_RPC_URLS / VITE_CORE / VITE_ETH_VAULT)."); return; }
    setBusy(true);
    try {
      if (asset.token === null) {
        const r = await shieldNative({ masterSeed, deployment, amount: units, onStatus: setStatus });
        setStatus(advanced ? `Shielded ${amount} ETH — note at leaf ${r.leafIndex} (tx ${r.txHash.slice(0, 10)}…).` : `Added ${amount} ETH to your private balance.`);
      } else {
        const r = await shieldERC20({ masterSeed, deployment, token: asset.token, vault: asset.vault, amount: units, onStatus: setStatus });
        setStatus(advanced ? `Shielded ${amount} ${asset.symbol} — note at leaf ${r.leafIndex} (approve ${r.approveTx.slice(0, 10)}…, deposit ${r.txHash.slice(0, 10)}…).` : `Added ${amount} ${asset.symbol} to your private balance.`);
      }
    } catch (e: any) {
      setStatus(e.message ?? String(e));
      if (asset.token) void checkLeftover();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel" data-testid="shield">
      <h3>Add funds</h3>
      <p className="muted small">Your connected wallet pays into your private balance. The deposit is public; everything after it is private.</p>
      <AssetSelect assets={assets} value={asset} onChange={(a) => { setAsset(a); setAmount(a.decimals === 18 ? "1.0" : "100"); }} />
      <label>Amount ({asset.symbol})</label>
      <input value={amount} onChange={(e: any) => setAmount(e.target.value)} />
      {units > 0n && !isBucketFor(asset, units) && (
        <p className="muted" style={{ fontSize: 12, marginTop: -6 }}>
          Public amounts should be common sizes so no deposit stands out.{" "}
          {bucket ? <button className="tab" onClick={() => setAmount(formatAmount(asset, bucket))}>Use {formatAmount(asset, bucket)} {asset.symbol}</button> : "Choose a larger amount."}
        </p>
      )}
      <button className="primary" onClick={shield} disabled={busy || units <= 0n}>
        Shield
      </button>
      {status && <p className="muted">{status}</p>}
      {asset.token && leftover !== null && (
        <p className="notice" style={{ fontSize: 12 }} data-testid="leftover-allowance">
          {leftover === "unknown" ? "The allowance left for the vault could not be read through the connected wallet; check it in that wallet." : leftover > 0n ? <>An approval of {formatAmount(asset, leftover)} {asset.symbol} for the vault remains from the failed deposit. <button className="tab" onClick={revokeLeftover} data-testid="revoke-leftover">Revoke it</button></> : "No allowance is left for the vault."}
        </p>
      )}
      <p className="muted" style={{ fontSize: 12 }}>
        This deposit is public by design (your connected wallet sends it{asset.token ? ", after an exact-amount approval" : ""}); everything after it is private.
      </p>
      <Scorecard action="shield" facts={{ delaySeconds: 0, amountIsBucket: isBucketFor(asset, units), privateSubmission: false, rpcEndpoints: deployment?.rpcUrls?.length ?? 1, recipientFresh: false }} />
    </div>
  );
}
