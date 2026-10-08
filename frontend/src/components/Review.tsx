import { useState } from "react";
import type { Level } from "@ref/wallet/privacyCenter";
import { unacknowledgedBlocks, type LintId, type LintItem } from "@ref/wallet/privacyLint";
import { tierLabel, type Tier } from "@ref/wallet/valuation";
import { assertSecondFactor, verifyPassword, webauthnAvailable } from "../sdk/secondFactor";
import { REVIEW_HOLD_MINUTES, type Controls } from "../sdk/tiers";
import type { TradeCheck } from "../zkapi/tradeCheck";
import { DestinationCard } from "./DestinationCard";
import { HoldToConfirm } from "./HoldToConfirm";
import { PrivacyLint } from "./PrivacyLint";

// The Review (whale spec §24; plan V2 §11, §46–§47): the screen before the two irreversible moments of a
// large transfer — commit (the withdrawal funds the escrow) and execute (the signed call) — and before a
// large send or withdrawal. It shows the amount in USD and in the asset, From and To with the destination
// card, what will be received at least, the execution in words, the time, the privacy level with the
// lint, the five lines of plan §4 with their meaning, the issuer line, and the route details behind
// "Advanced details". From high-value the confirmation is a hold; from high-value-secondary the second
// factor comes first; at institutional the funding waits for the review hold and the order can be exported.
export interface ReviewLine { id: "price" | "route" | "destination" | "slippage" | "privacy" | "exposure" | "security"; label: string; ok: boolean; meaning: string; /** the line is ok only once the user acknowledges this */ ack?: { text: string; done: boolean; onAck: () => void } }
export interface RouteDetails { provider: string; mode: string; parts?: number; fees: string; expectedOutput: string; settlement: string; alternatives: { provider: string; outcome: string; reason?: string }[]; score?: string; linkEvidence?: string }
/** The maximum-loss model of a protected execution (High-Value Protection spec §15, plan V3 §46), every figure already formatted. */
export interface MaximumLoss { order: string; cap: string; maxExposure: string; protected: string; preparation: string }
/** The combined verdict (plan V3 §43): SECURITY and PRIVACY are one block — "Safe to execute" is never shown without the privacy level. */
export interface Verdict { security: "Safe to execute" | "Review" | "Do not execute"; privacy: Level; why: string; /** V4 (plan §55): the third line — the competition's winner, the only route, or a route the user chose over the winner */ execution?: "Best available" | "Only route" | "Review"; executionWhy?: string }
/** Advanced (plan V3 §94): the protection plan in figures. */
export interface ProtectionDetails { riskClass: string; custody: string; band: string; cap: string; gate: string; steps: string; duration: string; cadence: string; elpf: string; concentration: string; alternative?: string }

export interface ReviewProps {
  moment: "commit" | "execute" | "send" | "withdraw" | "campaign" | "reroute";
  tier: Tier;
  controls: Controls;
  usd: string | null;
  amount: string;
  from: string;
  to: { network: string; asset: string; address: string; kind: "fresh" | "entered" | "privacy-address" };
  receiveMin?: string | null;
  execution?: { words: string; detail?: string; eta: string } | null;
  privacy: { level: Level; score?: number };
  lint: LintItem[];
  onAcknowledgeLint: (id: LintId) => void;
  lines: ReviewLine[];
  issuer?: string | null;
  routeKind?: "Native-to-native" | "Issuer-dependent" | null;
  details?: RouteDetails | null;
  advanced?: boolean;
  /** institutional: the funding waits this long after the confirmation and can be cancelled meanwhile */
  reviewHold?: { minutes: number } | null;
  onExport?: () => void;
  secondFactor?: { credentialId?: string } | null;
  /** institutional (spec §14): the separate device asked after the second factor; absent credential: the confirmation is refused, there is no password fallback */
  secondDevice?: { credentialId?: string } | null;
  maximumLoss?: MaximumLoss | null;
  verdict?: Verdict | null;
  protectionDetails?: ProtectionDetails | null;
  /** V4 (plan §69): the route settles across chains; the Review states the fact in the plan's words */
  crossChain?: boolean;
  /** "Check this trade" on Private AI (spec §22): available only with an open private session; the summary is sanitized by the caller */
  tradeCheck?: { available: boolean; reason?: string; run: () => Promise<TradeCheck> } | null;
  busy?: string;
  error?: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

const MOMENT: Record<ReviewProps["moment"], { title: string; what: string; button: string }> = {
  commit: { title: "Review the swap", what: "Confirming commits the order and schedules the private withdrawal that funds its one-time escrow.", button: "Confirm and commit" },
  execute: { title: "Review the execution", what: "Confirming hands the signed provider call to the executor. This cannot be undone once it is mined.", button: "Confirm the execution" },
  send: { title: "Review the transfer", what: "Confirming proves and submits the private transfer. It cannot be undone.", button: "Confirm and send" },
  withdraw: { title: "Review the withdrawal", what: "Confirming proves and submits the withdrawal to the public address below. It cannot be undone.", button: "Confirm and withdraw" },
  campaign: { title: "Review the protected swap", what: "Confirming starts the protected execution: the order runs as steps under the exposure cap, each funded from your private balance into its own one-time escrow and handed over only when the previous step settled. Steps already handed over cannot be recalled.", button: "Confirm and start" },
  reroute: { title: "Review the new route", what: "The route changed while the operation was paused. Confirming continues the remaining steps on the new route under the same bounds you approved.", button: "Confirm the new route" },
};

export function Review(p: ReviewProps) {
  const [showDetails, setShowDetails] = useState(false);
  const [factor, setFactor] = useState<"idle" | "asking" | "password" | "passed">("idle");
  const [password, setPassword] = useState("");
  const [factorError, setFactorError] = useState("");
  const [device, setDevice] = useState<"idle" | "asking" | "passed">("idle");
  const [deviceError, setDeviceError] = useState("");
  const [check, setCheck] = useState<{ busy?: boolean; result?: TradeCheck; error?: string }>({});
  async function runCheck() {
    if (!p.tradeCheck?.available) return;
    setCheck({ busy: true });
    try { setCheck({ result: await p.tradeCheck.run() }); } catch (e: any) { setCheck({ error: e?.message ?? String(e) }); }
  }
  const m = MOMENT[p.moment];
  const blocks = unacknowledgedBlocks(p.lint);
  const pendingLines = p.lines.filter((l) => !l.ok);
  const ready = blocks.length === 0 && pendingLines.length === 0 && !p.busy;
  const needsFactor = p.controls.secondFactor && factor !== "passed";
  const needsDevice = !!p.secondDevice && device !== "passed";

  /** After the second factor (or without one): the separate device at institutional, then the confirmation. */
  async function afterFactor() {
    if (needsDevice) {
      setDeviceError("");
      if (!p.secondDevice?.credentialId) { setDeviceError("Operations at this size need a confirmation from a separate device (a security key or a phone), and there is no password fallback for it. Register one under Settings → Protected execution."); return; }
      if (!webauthnAvailable()) { setDeviceError("This browser cannot ask the separate device; the operation is not confirmed."); return; }
      setDevice("asking");
      const ok = await assertSecondFactor(p.secondDevice.credentialId);
      if (!ok) { setDevice("idle"); setDeviceError("The separate device did not confirm. There is no password fallback at this size."); return; }
      setDevice("passed");
    }
    await p.onConfirm();
  }
  async function confirm() {
    if (!ready) return;
    if (needsFactor) {
      setFactorError("");
      if (p.secondFactor?.credentialId && webauthnAvailable()) {
        setFactor("asking");
        if (await assertSecondFactor(p.secondFactor.credentialId)) { setFactor("passed"); await afterFactor(); return; }
        setFactorError("The authenticator did not confirm; enter your wallet password instead.");
      }
      setFactor("password");
      return;
    }
    await afterFactor();
  }
  async function confirmWithPassword() {
    setFactorError("");
    if (!(await verifyPassword(password))) { setFactorError("Wrong password."); return; }
    setPassword(""); setFactor("passed");
    await afterFactor();
  }

  return (
    <div className="panel" data-testid="review" data-moment={p.moment}>
      <h3>{m.title}</h3>
      <p className="muted small">{m.what} {tierLabel[p.tier]}.</p>
      <div className="numeral" data-testid="review-usd">{p.usd ?? "—"}</div>
      <div className="numeral-sm">{p.amount}</div>
      <div className="row" style={{ marginTop: 8 }}><span className="muted">From</span><b>{p.from}</b></div>
      <DestinationCard title="To" network={p.to.network} asset={p.to.asset} address={p.to.address} kind={p.to.kind} />
      {p.receiveMin && <div className="row"><span className="muted">Receive at least</span><b>{p.receiveMin}</b></div>}
      {p.execution && (
        <>
          <div className="row"><span className="muted">Execution</span><b>{p.execution.words}{p.execution.detail ? <span className="muted small"> · {p.execution.detail}</span> : null}</b></div>
          <div className="row"><span className="muted">Estimated time</span><b>{p.execution.eta}</b></div>
        </>
      )}
      {p.crossChain && <p className="notice small" style={{ margin: "6px 0" }} data-testid="non-atomic">Cross-chain settlement is not atomic: your funds leave first and arrive later, and a failure in between is refunded, not reversed.</p>}
      <div className="row"><span className="muted">Privacy</span><b className={`level-${p.privacy.level}`}>{p.privacy.level}{p.advanced && p.privacy.score !== undefined ? ` (${p.privacy.score}/100)` : ""}</b></div>
      {p.issuer && <div className="row"><span className="muted">Token</span><b className="small">{p.issuer}</b></div>}
      {p.routeKind && <div className="row"><span className="muted">Route</span><b>{p.routeKind}</b></div>}
      <PrivacyLint items={p.lint} onAcknowledge={p.onAcknowledgeLint} compact />
      {p.maximumLoss && (
        <div className="small" style={{ marginTop: 10, padding: 10, border: "1px solid var(--border)", borderRadius: 12 }} data-testid="maximum-loss">
          <div className="muted" style={{ marginBottom: 4 }}>Maximum-loss model</div>
          <div className="row"><span className="muted">Order</span><b>{p.maximumLoss.order}</b></div>
          <div className="row"><span className="muted">In-flight cap</span><b>{p.maximumLoss.cap}</b></div>
          <div className="row"><span className="muted">Maximum external exposure</span><b>{p.maximumLoss.maxExposure}</b></div>
          <div className="row"><span className="muted">Remaining protected</span><b>{p.maximumLoss.protected}</b></div>
          <div className="row"><span className="muted">Preparation cost</span><b>{p.maximumLoss.preparation}</b></div>
        </div>
      )}
      {p.verdict && (
        <div className="small" style={{ marginTop: 10, padding: 10, border: "1px solid var(--border)", borderRadius: 12 }} data-testid="verdict">
          <div className="row"><span className="muted">Security</span><b className={p.verdict.security === "Safe to execute" ? "level-Excellent" : p.verdict.security === "Review" ? "level-Reduced" : "error"} data-testid="verdict-security">{p.verdict.security}</b></div>
          <div className="row"><span className="muted">Privacy</span><b className={`level-${p.verdict.privacy}`} data-testid="verdict-privacy">{p.verdict.privacy}</b></div>
          {p.verdict.execution && <div className="row"><span className="muted">Execution</span><b className={p.verdict.execution === "Best available" ? "level-Excellent" : p.verdict.execution === "Only route" ? "level-Good" : "level-Reduced"} data-testid="verdict-execution">{p.verdict.execution}{p.verdict.execution === "Best available" ? " ✓" : ""}</b></div>}
          <div className="muted">{p.verdict.why}{p.verdict.executionWhy ? ` · ${p.verdict.executionWhy}` : ""}</div>
        </div>
      )}

      <ul style={{ listStyle: "none", padding: 0, margin: "10px 0 0" }} data-testid="review-lines">
        {p.lines.map((l) => (
          <li key={l.id} className="small" style={{ padding: "4px 0", display: "flex", gap: 8, alignItems: "flex-start" }} data-line={l.id} data-ok={l.ok ? "1" : "0"}>
            <span className={l.ok ? "level-Excellent" : "level-Reduced"} style={{ width: 16, flex: "0 0 16px" }}>{l.ok ? "✓" : "⚠"}</span>
            <span><b>{l.label}</b> <span className="muted">· {l.meaning}</span>
              {l.ack && !l.ack.done && <button className="tab" style={{ marginLeft: 8, padding: "2px 8px", fontSize: 12 }} onClick={l.ack.onAck}>{l.ack.text}</button>}
            </span>
          </li>
        ))}
      </ul>

      {p.details && (
        <>
          <button className="tab" style={{ marginTop: 8 }} onClick={() => setShowDetails((v) => !v)}>{showDetails ? "Hide advanced details" : "Advanced details"}</button>
          {showDetails && (
            <div className="muted small" style={{ marginTop: 6 }} data-testid="route-details">
              <div className="row"><span>Provider</span><b>{p.details.provider}</b></div>
              <div className="row"><span>Execution mode</span><b>{p.details.mode}{p.details.parts ? ` · ${p.details.parts} parts` : ""}</b></div>
              <div className="row"><span>Fees</span><b>{p.details.fees}</b></div>
              <div className="row"><span>Expected output</span><b>{p.details.expectedOutput}</b></div>
              <div className="row"><span>Settlement</span><b>{p.details.settlement}</b></div>
              {p.details.linkEvidence && <div className="row"><span>Link evidence</span><b>{p.details.linkEvidence}</b></div>}
              {p.details.score && <div className="row"><span>Score</span><b>{p.details.score}</b></div>}
              {p.details.alternatives.length > 0 && <div style={{ marginTop: 4 }}>Alternatives: {p.details.alternatives.map((a) => `${a.provider} — ${a.outcome}${a.reason ? ` (${a.reason})` : ""}`).join("; ")}</div>}
              {p.protectionDetails && (
                <div style={{ marginTop: 6 }} data-testid="protection-details">
                  <div className="row"><span>Risk class</span><b>{p.protectionDetails.riskClass} · {p.protectionDetails.custody}</b></div>
                  <div className="row"><span>Tranche band · cap</span><b>{p.protectionDetails.band} · {p.protectionDetails.cap}</b></div>
                  <div className="row"><span>Settlement gate</span><b>{p.protectionDetails.gate}</b></div>
                  <div className="row"><span>Steps · duration</span><b>{p.protectionDetails.steps} · {p.protectionDetails.duration}</b></div>
                  <div className="row"><span>Cadence</span><b>{p.protectionDetails.cadence}</b></div>
                  <div className="row"><span>Expected loss per failure</span><b>{p.protectionDetails.elpf}</b></div>
                  <div className="row"><span>Concentration</span><b>{p.protectionDetails.concentration}</b></div>
                  {p.protectionDetails.alternative && <div className="row"><span>Alternative</span><b>{p.protectionDetails.alternative}</b></div>}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {p.tradeCheck && (
        <div style={{ marginTop: 8 }} data-testid="trade-check">
          <div className="tabs" style={{ margin: "6px 0" }}>
            <button className="tab" onClick={runCheck} disabled={!p.tradeCheck.available || !!check.busy} title={p.tradeCheck.available ? "A sanitized summary goes to your private AI session: assets, rounded amounts, the route, the competition, the privacy check — no address" : p.tradeCheck.reason}>{check.busy ? "Checking…" : "Check this trade (Private AI)"}</button>
            {!p.tradeCheck.available && <span className="muted small">{p.tradeCheck.reason}</span>}
          </div>
          {check.error && <p className="error small">{check.error}</p>}
          {check.result && (
            <div className="panel" style={{ margin: "6px 0", padding: 12 }} data-testid="trade-check-result">
              <div className="muted small" style={{ marginBottom: 4 }}>Private AI (it recommends and warns; it signs nothing and changes nothing)</div>
              {(["bestRoute", "alternative", "estimatedSavings", "privacy", "execution", "risk"] as const).map((k) => check.result![k] ? <div key={k} className="row small"><span className="muted">{{ bestRoute: "Best route", alternative: "Alternative", estimatedSavings: "Estimated savings", privacy: "Privacy", execution: "Execution", risk: "Risk" }[k]}</span><span style={{ textAlign: "right", maxWidth: 440 }}>{check.result![k]}</span></div> : null)}
            </div>
          )}
        </div>
      )}
      {p.reviewHold && <p className="notice" style={{ marginTop: 10 }}>Review hold: after you confirm, the funding waits at least {p.reviewHold.minutes} minutes and the order can be cancelled meanwhile (Swap → open swaps → Abandon).</p>}
      {p.onExport && <div className="tabs" style={{ margin: "6px 0" }}><button className="tab" onClick={p.onExport}>Export for review (JSON)</button></div>}

      {factor === "password" && (
        <div className="notice" style={{ marginTop: 10 }} data-testid="second-factor-password">
          <div className="small">Second confirmation: {p.secondFactor?.credentialId ? "the authenticator did not confirm; " : "no authenticator is registered (Settings); "}enter your wallet password.</div>
          <input type="password" value={password} onChange={(e: any) => setPassword(e.target.value)} onKeyDown={(e: any) => { if (e.key === "Enter") confirmWithPassword(); }} style={{ marginBottom: 6 }} autoComplete="current-password" />
          <button className="primary" onClick={confirmWithPassword} disabled={!password || !!p.busy}>Confirm with the password</button>
        </div>
      )}
      {factorError && <p className="error small">{factorError}</p>}
      {deviceError && <p className="error small" data-testid="second-device-error">{deviceError}</p>}
      {device === "asking" && <p className="muted small">Confirm on your separate device…</p>}
      {p.error && <p className="error small">{p.error}</p>}
      {p.busy && <p className="muted small">{p.busy}</p>}

      <div className="tabs" style={{ marginTop: 10 }}>
        {factor !== "password" && (p.controls.hold
          ? <HoldToConfirm label={needsFactor ? `${m.button} (second confirmation next)` : needsDevice ? `${m.button} (separate device next)` : m.button} onConfirm={confirm} disabled={!ready || factor === "asking" || device === "asking"} />
          : <button className="primary" onClick={confirm} disabled={!ready || factor === "asking" || device === "asking"} data-testid="confirm-tap">{m.button}</button>)}
        <button className="tab" onClick={p.onCancel} disabled={!!p.busy}>Back</button>
      </div>
      {!ready && !p.busy && <p className="muted small">{blocks.length ? "Acknowledge the privacy check to continue." : pendingLines.length ? `Waiting on: ${pendingLines.map((l) => l.label).join(", ")}.` : ""}</p>}
    </div>
  );
}
