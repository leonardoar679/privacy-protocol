import { useState } from "react";
import { formatEther, parseEther } from "viem";
import { checkThresholds, TIER_DEFAULTS, type TierThresholds } from "@ref/wallet/valuation";
import type { Deployment } from "../sdk/chain";
import { DEFAULT_RELAYER_URL } from "../sdk/relayer";
import { DELAY_WINDOW, policyFromPreference, PREFERENCE_LABELS, windowLabel } from "../sdk/policy";
import { CAP_BPS_RANGE, PREFERENCES, PROTECTION_DEFAULTS, PROTECTION_MODES, settings, useSettings, type Preference, type ProtectionMode } from "../wallet/settings";
import { session } from "../wallet/session";
import { registerSecondDevice, registerSecondFactor, webauthnAvailable } from "../sdk/secondFactor";
import { requestSystemNotifications } from "../wallet/notifications";
import { AddressBookPanel } from "./protection/AddressBook";
import { allowancesFor, revokeAllowance, type AllowanceLine } from "../sdk/allowances";
import { formatAmount } from "../sdk/assets";

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

export function Settings({ deployment, readsLine, coreLine, account = null }: { deployment: Deployment | null; readsLine: string; coreLine: string; /** the connected public wallet, if any: its allowances toward the vaults can be read and revoked */ account?: string | null }) {
  const s = useSettings();
  const [tiers, setTiers] = useState<Record<keyof TierThresholds, string>>({ enhanced: String(s.tiers.enhanced), highValue: String(s.tiers.highValue), highValueSecondary: String(s.tiers.highValueSecondary), institutional: String(s.tiers.institutional) });
  const [tierError, setTierError] = useState("");
  const [cap, setCap] = useState(() => formatEther(BigInt(s.housekeeping.dailyFeeCapWei)));
  const [forget, setForget] = useState("");
  const [factorStatus, setFactorStatus] = useState("");
  const [exposure, setExposure] = useState(() => ((s.protection.capBps ?? PROTECTION_DEFAULTS[s.protection.mode].capBps) / 100).toFixed(1));
  const [exposureError, setExposureError] = useState("");
  const [deviceStatus, setDeviceStatus] = useState("");
  const [allowances, setAllowances] = useState<AllowanceLine[] | null>(null);
  const [allowanceStatus, setAllowanceStatus] = useState("");
  // V4 (plan §62, §92, §128): the opt-out asks twice; concentration and velocity are typed
  const [offAsk, setOffAsk] = useState(false);
  const [share, setShare] = useState(() => (s.protection.providerShareCapBps !== undefined ? String(s.protection.providerShareCapBps / 100) : ""));
  const [velocity, setVelocity] = useState(() => (s.protection.velocity ? String(s.protection.velocity.maxUsdPer24h) : ""));
  const [knobError, setKnobError] = useState("");
  async function readAllowances() {
    if (!account) { setAllowanceStatus("Connect the public wallet first (Home → Add funds)."); return; }
    setAllowanceStatus("Reading through the connected wallet's own provider…");
    try { setAllowances(await allowancesFor(deployment, account as `0x${string}`)); setAllowanceStatus(""); } catch (e: any) { setAllowanceStatus(e?.message ?? String(e)); }
  }
  async function revoke(line: AllowanceLine) {
    try { const tx = await revokeAllowance(line.asset.token as `0x${string}`, line.asset.vault as `0x${string}`); setAllowanceStatus(`Revoked (tx ${tx.slice(0, 10)}…); read again once it is mined.`); } catch (e: any) { setAllowanceStatus(e?.message ?? String(e)); }
  }
  const p = s.protection;
  function applyExposure() {
    const bps = Math.round(Number(exposure) * 100);
    if (!Number.isFinite(bps) || bps < CAP_BPS_RANGE[0] || bps > CAP_BPS_RANGE[1]) { setExposureError(`The exposure fraction stays between ${CAP_BPS_RANGE[0] / 100} % and ${CAP_BPS_RANGE[1] / 100} % of the order; the order's size and the route's risk set the ceiling at confirmation (2.5–3 % from $1M, 1 % on an unknown or high-risk route).`); setExposure(((p.capBps ?? PROTECTION_DEFAULTS[p.mode].capBps) / 100).toFixed(1)); return; }
    setExposureError("");
    settings.set({ protection: { ...p, capBps: bps } });
  }
  function applyShare() {
    if (share.trim() === "") { const { providerShareCapBps: _s, ...rest } = p; settings.set({ protection: rest as typeof p }); setKnobError(""); return; }
    const bps = Math.round(Number(share) * 100);
    if (!Number.isFinite(bps) || bps < 1000 || bps > 10000) { setKnobError("The concentration stays between 10 % and 100 % of the order per provider."); setShare(p.providerShareCapBps !== undefined ? String(p.providerShareCapBps / 100) : ""); return; }
    setKnobError(""); settings.set({ protection: { ...p, providerShareCapBps: bps } });
  }
  function applyVelocity() {
    if (velocity.trim() === "") { const { velocity: _v, ...rest } = p; settings.set({ protection: rest as typeof p }); setKnobError(""); return; }
    const usd = Number(velocity);
    if (!Number.isFinite(usd) || usd <= 0) { setKnobError("The velocity limit is a positive USD amount per 24 hours."); setVelocity(p.velocity ? String(p.velocity.maxUsdPer24h) : ""); return; }
    setKnobError(""); settings.set({ protection: { ...p, velocity: { maxUsdPer24h: usd } } });
  }
  async function registerDevice() {
    setDeviceStatus("Registering a separate device (a security key, or a phone over the cross-device flow)…");
    try { const credentialId = await registerSecondDevice(); settings.set({ protection: { ...p, secondDevice: { enabled: true, credentialId } } }); setDeviceStatus("Registered. Operations at the institutional size ask this device after the second confirmation; there is no password fallback for it."); }
    catch (e: any) { setDeviceStatus(e?.message ?? String(e)); }
  }
  async function enableSystemNotifications(on: boolean) {
    if (!on) { settings.set({ protection: { ...p, notifications: { ...p.notifications, system: false } } }); return; }
    const granted = await requestSystemNotifications();
    settings.set({ protection: { ...p, notifications: { ...p.notifications, system: granted } } });
  }

  async function registerFactor() {
    setFactorStatus("Registering with the platform authenticator…");
    try {
      const credentialId = await registerSecondFactor();
      settings.set({ secondFactor: { enabled: true, credentialId } });
      setFactorStatus("Registered. Transfers above the second-confirmation threshold ask the authenticator first; your password stays the fallback.");
    } catch (e: any) {
      setFactorStatus(e?.message ?? String(e));
    }
  }

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

      <div className="panel" data-testid="second-factor">
        <h3>Second confirmation</h3>
        <p className="muted small">Above the second-confirmation threshold a transfer asks this device to verify you — Face ID, Touch ID or Windows Hello — before it is sent. It gates the action and holds no key; your wallet password is always the fallback.</p>
        <div className="row"><span className="muted">Authenticator</span><b>{s.secondFactor.credentialId ? "registered on this device" : webauthnAvailable() ? "not registered (the password is asked instead)" : "not available in this browser (the password is asked instead)"}</b></div>
        <div className="tabs" style={{ margin: "6px 0" }}>
          {!s.secondFactor.credentialId && <button className="tab" onClick={registerFactor} disabled={!webauthnAvailable()}>Register this device</button>}
          {s.secondFactor.credentialId && <button className="tab" onClick={() => { settings.set({ secondFactor: { enabled: false } }); setFactorStatus("Removed; the password is asked instead."); }}>Remove</button>}
        </div>
        {factorStatus && <p className="muted small">{factorStatus}</p>}
      </div>

      <div className="panel" data-testid="protected-execution">
        <h3>Protected execution</h3>
        <p className="muted small">A large swap runs as steps, each from its own one-time escrow, with at most a small fraction of the order outside your private balance and unsettled at any time. The mode sets the fraction, the sizes and the pace; the wallet chooses the pieces.</p>
        <label style={{ display: "block", color: "var(--fg)" }}>
          <input type="checkbox" checked={p.enabled} onChange={(e: any) => { if (e.target.checked) { settings.set({ protection: { ...p, enabled: true } }); setOffAsk(false); } else setOffAsk(true); }} data-testid="protection-enabled" /> Use protected execution for large orders (from $1M; from $100K when the route is thin or when you ask)
        </label>
        {offAsk && p.enabled && (
          <div className="notice" data-testid="protection-off-warning">
            <div className="small"><b>Changing this can reduce protection.</b> With protected execution off, a large order runs as one execution: the whole amount sits with one provider at once, and a provider failure can reach all of it instead of a small fraction.</div>
            <div className="tabs" style={{ margin: "6px 0 0" }}><button className="danger" onClick={() => { settings.set({ protection: { ...p, enabled: false } }); setOffAsk(false); }} data-testid="protection-off-confirm">I understand, turn it off</button><button className="tab" onClick={() => setOffAsk(false)}>Keep it on</button></div>
          </div>
        )}
        {!p.enabled && <p className="notice small" data-testid="protection-off-notice">Protected execution is off: large orders run as one execution. Turn it back on above.</p>}
        <label style={{ display: "block", color: "var(--fg)" }}>
          <input type="checkbox" checked={p.protectFromEnhanced} onChange={(e: any) => settings.set({ protection: { ...p, protectFromEnhanced: e.target.checked } })} data-testid="protect-from-enhanced" /> Protect every order from $100K (steps of at most 5 % at a time), not only when the route is thin or unreliable
        </label>
        {PROTECTION_MODES.map((m: ProtectionMode) => (
          <label key={m} style={{ display: "block", padding: "6px 0", color: "var(--fg)" }}>
            <input type="radio" name="protection-mode" checked={p.mode === m} onChange={() => { settings.set({ protection: { ...p, mode: m, capBps: undefined } }); setExposure((PROTECTION_DEFAULTS[m].capBps / 100).toFixed(1)); }} />
            <b>{PROTECTION_DEFAULTS[m].label}</b> <span className="muted small">· at most {PROTECTION_DEFAULTS[m].capBps / 100} % exposed</span>
            <div className="muted small" style={{ marginLeft: 22 }}>{PROTECTION_DEFAULTS[m].words}</div>
          </label>
        ))}
        <label>Exposure fraction (% of the order outside your balance at once, {CAP_BPS_RANGE[0] / 100}–{CAP_BPS_RANGE[1] / 100})</label>
        <input inputMode="decimal" value={exposure} onChange={(e: any) => setExposure(e.target.value.replace(/[^0-9.]/g, ""))} onBlur={applyExposure} data-testid="exposure-input" />
        {exposureError && <p className="error small">{exposureError}</p>}
        <label style={{ display: "block", color: "var(--fg)" }}>
          <input type="checkbox" checked={p.pauseLargeOperations} onChange={(e: any) => settings.set({ protection: { ...p, pauseLargeOperations: e.target.checked } })} data-testid="pause-large-operations" /> Pause large operations (every protected swap stops releasing steps; steps already handed over finish; the protocol itself never pauses)
        </label>
        <label style={{ display: "block", color: "var(--fg)" }}>
          <input type="checkbox" checked={p.autoReroute} onChange={(e: any) => settings.set({ protection: { ...p, autoReroute: e.target.checked } })} /> Adopt a changed route without a new review below the second-confirmation size
        </label>
        <div className="muted small" style={{ marginTop: 6 }}><b>Advanced.</b> Changing these can reduce protection.</div>
        <label>Provider concentration (% of the order one provider may carry when several quote the size; the service recommends 30; empty for the recommendation)</label>
        <input inputMode="decimal" value={share} onChange={(e: any) => setShare(e.target.value.replace(/[^0-9.]/g, ""))} onBlur={applyShare} data-testid="concentration-input" />
        <label>Velocity limit (USD handed over within any 24 hours; empty for none)</label>
        <input inputMode="numeric" value={velocity} onChange={(e: any) => setVelocity(e.target.value.replace(/[^0-9]/g, ""))} onBlur={applyVelocity} data-testid="velocity-input" />
        {knobError && <p className="error small">{knobError}</p>}
        <label style={{ display: "block", color: "var(--fg)", marginTop: 6 }}>
          <input type="checkbox" checked={p.notifications.inApp} onChange={(e: any) => settings.set({ protection: { ...p, notifications: { ...p.notifications, inApp: e.target.checked } } })} /> In-app notifications about a protected swap (paused, step settled, route changed)
        </label>
        <label style={{ display: "block", color: "var(--fg)" }}>
          <input type="checkbox" checked={p.notifications.system} onChange={(e: any) => enableSystemNotifications(e.target.checked)} /> System notifications while this tab is in the background
        </label>
        <label style={{ display: "block", color: "var(--fg)" }}>
          <input type="checkbox" checked={p.notifications.generic} onChange={(e: any) => settings.set({ protection: { ...p, notifications: { ...p.notifications, generic: e.target.checked } } })} /> Keep system notifications generic ("Your private operation has updated"; no amounts)
        </label>
        <div className="row" style={{ marginTop: 8 }}><span className="muted">Second device (institutional size)</span><b>{p.secondDevice.credentialId ? "registered" : webauthnAvailable() ? "not registered" : "not available in this browser"}</b></div>
        <div className="tabs" style={{ margin: "6px 0" }}>
          {!p.secondDevice.credentialId && <button className="tab" onClick={registerDevice} disabled={!webauthnAvailable()} data-testid="register-second-device">Register a separate device</button>}
          {p.secondDevice.credentialId && <button className="tab" onClick={() => { settings.set({ protection: { ...p, secondDevice: { enabled: false } } }); setDeviceStatus("Removed. Operations at the institutional size cannot be confirmed until a device is registered again."); }}>Remove</button>}
        </div>
        <p className="muted small">A security key or a phone confirms an operation at the institutional size after this device did; a compromised phone alone does not reach that size. There is no password fallback for the second device.</p>
        {deviceStatus && <p className="muted small">{deviceStatus}</p>}
      </div>

      <AddressBookPanel deployment={deployment} />

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
        <div style={{ marginTop: 8 }} data-testid="allowances">
          <label>Token allowances of the connected wallet toward the vaults</label>
          <p className="muted small">A deposit approves the exact amount; what a failed deposit left behind can be revoked here. Read through the connected wallet's own provider, never this wallet's endpoints.</p>
          <div className="tabs" style={{ margin: "4px 0" }}><button className="tab" onClick={readAllowances} data-testid="read-allowances">Read allowances</button></div>
          {allowances?.map((l) => (
            <div key={l.asset.symbol} className="row small" data-testid="allowance-line" data-asset={l.asset.symbol}>
              <span>{l.asset.symbol} → its vault</span>
              <b>{l.allowance === null ? "unreadable" : `${formatAmount(l.asset, l.allowance)} ${l.asset.symbol}`}{l.allowance !== null && l.allowance > 0n && <button className="tab" style={{ marginLeft: 8, padding: "2px 8px", fontSize: 12 }} onClick={() => revoke(l)} data-testid="revoke-allowance">Revoke</button>}</b>
            </div>
          ))}
          {allowances && allowances.length === 0 && <p className="muted small">No ERC-20 vault on this deployment.</p>}
          {allowanceStatus && <p className="muted small">{allowanceStatus}</p>}
        </div>
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
