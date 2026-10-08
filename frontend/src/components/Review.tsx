import { useState } from "react";
import type { Level } from "@ref/wallet/privacyCenter";
import { unacknowledgedBlocks, type LintId, type LintItem } from "@ref/wallet/privacyLint";
import { tierLabel, type Tier } from "@ref/wallet/valuation";
import { assertSecondFactor, verifyPassword, webauthnAvailable } from "../sdk/secondFactor";
import { REVIEW_HOLD_MINUTES, type Controls } from "../sdk/tiers";
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
export interface ReviewLine { id: "price" | "route" | "destination" | "slippage" | "privacy"; label: string; ok: boolean; meaning: string; /** the line is ok only once the user acknowledges this */ ack?: { text: string; done: boolean; onAck: () => void } }
export interface RouteDetails { provider: string; mode: string; parts?: number; fees: string; expectedOutput: string; settlement: string; alternatives: { provider: string; outcome: string; reason?: string }[]; score?: string; linkEvidence?: string }

export interface ReviewProps {
  moment: "commit" | "execute" | "send" | "withdraw";
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
};

export function Review(p: ReviewProps) {
  const [showDetails, setShowDetails] = useState(false);
  const [factor, setFactor] = useState<"idle" | "asking" | "password" | "passed">("idle");
  const [password, setPassword] = useState("");
  const [factorError, setFactorError] = useState("");
  const m = MOMENT[p.moment];
  const blocks = unacknowledgedBlocks(p.lint);
  const pendingLines = p.lines.filter((l) => !l.ok);
  const ready = blocks.length === 0 && pendingLines.length === 0 && !p.busy;
  const needsFactor = p.controls.secondFactor && factor !== "passed";

  async function confirm() {
    if (!ready) return;
    if (needsFactor) {
      setFactorError("");
      if (p.secondFactor?.credentialId && webauthnAvailable()) {
        setFactor("asking");
        if (await assertSecondFactor(p.secondFactor.credentialId)) { setFactor("passed"); await p.onConfirm(); return; }
        setFactorError("The authenticator did not confirm; enter your wallet password instead.");
      }
      setFactor("password");
      return;
    }
    await p.onConfirm();
  }
  async function confirmWithPassword() {
    setFactorError("");
    if (!(await verifyPassword(password))) { setFactorError("Wrong password."); return; }
    setPassword(""); setFactor("passed");
    await p.onConfirm();
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
      <div className="row"><span className="muted">Privacy</span><b className={`level-${p.privacy.level}`}>{p.privacy.level}{p.advanced && p.privacy.score !== undefined ? ` (${p.privacy.score}/100)` : ""}</b></div>
      {p.issuer && <div className="row"><span className="muted">Token</span><b className="small">{p.issuer}</b></div>}
      {p.routeKind && <div className="row"><span className="muted">Route</span><b>{p.routeKind}</b></div>}
      <PrivacyLint items={p.lint} onAcknowledge={p.onAcknowledgeLint} compact />

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
            </div>
          )}
        </>
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
      {p.error && <p className="error small">{p.error}</p>}
      {p.busy && <p className="muted small">{p.busy}</p>}

      <div className="tabs" style={{ marginTop: 10 }}>
        {factor !== "password" && (p.controls.hold
          ? <HoldToConfirm label={needsFactor ? `${m.button} (second confirmation next)` : m.button} onConfirm={confirm} disabled={!ready || factor === "asking"} />
          : <button className="primary" onClick={confirm} disabled={!ready || factor === "asking"} data-testid="confirm-tap">{m.button}</button>)}
        <button className="tab" onClick={p.onCancel} disabled={!!p.busy}>Back</button>
      </div>
      {!ready && !p.busy && <p className="muted small">{blocks.length ? "Acknowledge the privacy check to continue." : pendingLines.length ? `Waiting on: ${pendingLines.map((l) => l.label).join(", ")}.` : ""}</p>}
    </div>
  );
}
