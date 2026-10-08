import { useState } from "react";
import { formatEther, parseEther } from "viem";
import { checkThresholds, TIER_DEFAULTS, type TierThresholds } from "@ref/wallet/valuation";
import type { Deployment } from "../sdk/chain";
import { DEFAULT_RELAYER_URL } from "../sdk/relayer";
import { DELAY_WINDOW, policyFromPreference, PREFERENCE_LABELS, windowLabel } from "../sdk/policy";
import { PREFERENCES, settings, useSettings, type Preference } from "../wallet/settings";
import { session } from "../wallet/session";

// Settings (plan V2 §43, §97, §108–§110; whale spec §13, §23): backup and lock, the trade preference
// (never on the Swap screen), the value tiers, private balance maintenance, the privacy and network
// choices, Advanced. Everything here is journaled (encrypted) and nothing is sent anywhere.
function downloadBackup() {
  const json = session.exportBackup();
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `privacy-wallet-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const TIER_FIELDS: { key: keyof TierThresholds; label: string }[] = [
  { key: "enhanced", label: "Enhanced review from (USD)" },
  { key: "highValue", label: "High-value controls from (USD)" },
  { key: "highValueSecondary", label: "Second confirmation from (USD)" },
  { key: "institutional", label: "Institutional review from (USD)" },
];

export function Settings({ deployment, readsLine, coreLine }: { deployment: Deployment | null; readsLine: string; coreLine: string }) {
  const s = useSettings();
  const [tiers, setTiers] = useState<Record<keyof TierThresholds, string>>({ enhanced: String(s.tiers.enhanced), highValue: String(s.tiers.highValue), highValueSecondary: String(s.tiers.highValueSecondary), institutional: String(s.tiers.institutional) });
  const [tierError, setTierError] = useState("");
  const [cap, setCap] = useState(() => formatEther(BigInt(s.housekeeping.dailyFeeCapWei)));
  const [forget, setForget] = useState("");

  function applyTiers() {
    const t: TierThresholds = { enhanced: Number(tiers.enhanced), highValue: Number(tiers.highValue), highValueSecondary: Number(tiers.highValueSecondary), institutional: Number(tiers.institutional) };
    try { checkThresholds(t); settings.set({ tiers: t }); setTierError(""); } catch (e: any) { setTierError(e?.message ?? String(e)); }
  }
  function resetTiers() {
    settings.set({ tiers: { ...TIER_DEFAULTS } });
    setTiers({ enhanced: String(TIER_DEFAULTS.enhanced), highValue: String(TIER_DEFAULTS.highValue), highValueSecondary: String(TIER_DEFAULTS.highValueSecondary), institutional: String(TIER_DEFAULTS.institutional) });
    setTierError("");
  }
  function applyCap() {
    try { settings.set({ housekeeping: { ...s.housekeeping, dailyFeeCapWei: parseEther(cap || "0").toString() } }); } catch { setCap(formatEther(BigInt(s.housekeeping.dailyFeeCapWei))); }
  }

  return (
    <div data-testid="settings">
      <div className="panel">
        <h3>Wallet</h3>
        <div className="tabs" style={{ margin: "6px 0" }}>
          <button className="tab" onClick={downloadBackup} title="Keystore + encrypted journal; restore with your password">Backup</button>
          <button className="tab" onClick={() => session.lock()}>Lock</button>
        </div>
        <p className="muted small">The backup file holds your keystore and your encrypted journal (notes, orders, activity, settings). It opens only with your password. The 24-word phrase restores the keys anywhere; the notes then come back with a rescan.</p>
      </div>

      <div className="panel">
        <h3>Trade preference</h3>
        <p className="muted small">How swaps choose their route and when they are funded. Saved here only; never written on chain. Large transfers add privacy and execution controls by themselves.</p>
        {PREFERENCES.map((p: Preference) => (
          <label key={p} style={{ display: "block", padding: "6px 0", color: "var(--fg)" }}>
            <input type="radio" name="preference" checked={s.preference === p} onChange={() => settings.set({ preference: p })} />
            <b>{PREFERENCE_LABELS[p].label}</b> <span className="muted small">· funded within {windowLabel(DELAY_WINDOW[policyFromPreference(p)])}</span>
            <div className="muted small" style={{ marginLeft: 22 }}>{PREFERENCE_LABELS[p].help}</div>
          </label>
        ))}
      </div>

      <div className="panel">
        <h3>Large transfers</h3>
        <p className="muted small">Above these USD values the wallet adds a review, a privacy check, a simulation, a hold to confirm and a second confirmation, in that order. Values come from Chainlink through your own RPC endpoints; when no price is available the high-value controls apply.</p>
        {TIER_FIELDS.map((f) => (
          <div key={f.key}>
            <label>{f.label}</label>
            <input inputMode="numeric" value={tiers[f.key]} onChange={(e: any) => setTiers({ ...tiers, [f.key]: e.target.value.replace(/[^0-9]/g, "") })} onBlur={applyTiers} />
          </div>
        ))}
        {tierError && <p className="error small">{tierError}</p>}
        <div className="tabs" style={{ margin: "4px 0" }}><button className="tab" onClick={resetTiers}>Reset to defaults</button></div>
      </div>

      <div className="panel">
        <h3>Private balance maintenance</h3>
        <label style={{ display: "block", color: "var(--fg)" }}>
          <input type="checkbox" checked={s.housekeeping.enabled} onChange={(e: any) => settings.set({ housekeeping: { ...s.housekeeping, enabled: e.target.checked } })} /> Keep large balances in common-sized pieces (private self-transfers at quiet times)
        </label>
        <label>Daily fee cap (ETH)</label>
        <input inputMode="decimal" value={cap} onChange={(e: any) => setCap(e.target.value.replace(/[^0-9.]/g, ""))} onBlur={applyCap} />
        <p className="muted small">Each maintenance transaction pays the relayer a private fee; the cap bounds what a day may spend on it.</p>
      </div>

      <div className="panel">
        <h3>Privacy and network</h3>
        <label style={{ display: "block", color: "var(--fg)" }}>
          <input type="checkbox" checked={s.verifyReads} onChange={(e: any) => settings.set({ verifyReads: e.target.checked })} /> Verify the pool with the Ethereum light client before every transaction
        </label>
        <p className="muted small" style={{ marginTop: 2 }}>{readsLine}</p>
        <label>Submission of private transactions</label>
        <select value={s.submission.kind} onChange={(e: any) => settings.set({ submission: e.target.value === "relayer" ? { kind: "relayer", url: s.submission.kind === "relayer" ? s.submission.url : DEFAULT_RELAYER_URL } : { kind: "wallet" } })}>
          <option value="relayer">Relayer (private: paid by a private fee note; your address never submits)</option>
          <option value="wallet">Connected wallet (public: the transaction is sent from your address)</option>
        </select>
        {s.submission.kind === "relayer" && (
          <>
            <label>Relayer URL (any relayer; self-submission is the fallback)</label>
            <input value={s.submission.url} onChange={(e: any) => settings.set({ submission: { kind: "relayer", url: e.target.value } })} />
          </>
        )}
      </div>

      <div className="panel">
        <h3>Advanced</h3>
        <label style={{ display: "block", color: "var(--fg)" }}>
          <input type="checkbox" checked={s.advanced} onChange={(e: any) => settings.set({ advanced: e.target.checked })} /> Show the cryptographic detail (notes, leaves, escrows, scores)
        </label>
        <p className="muted small">{deployment ? `Core ${deployment.core.slice(0, 8)}… · chain ${deployment.chainId} · ${deployment.rpcUrls.length} RPC endpoint${deployment.rpcUrls.length === 1 ? "" : "s"} · ${coreLine}` : "No deployment configured: set VITE_RPC_URLS, VITE_CORE, VITE_ETH_VAULT (docs/testnet.md)"}</p>
        <p className="muted small">Unaudited; not for production. The proving key served in dev is the insecure single-party setup (circuits/setup/dev).</p>
      </div>

      <div className="panel">
        <h3>Forget this wallet on this device</h3>
        <p className="muted small">Removes the keystore and the encrypted journal from this device. Your phrase or a backup file is then the only way back. Type FORGET to confirm.</p>
        <input value={forget} onChange={(e: any) => setForget(e.target.value)} placeholder="FORGET" autoComplete="off" />
        <button className="danger" disabled={forget !== "FORGET"} onClick={() => session.forget()}>Forget this wallet</button>
      </div>
    </div>
  );
}
