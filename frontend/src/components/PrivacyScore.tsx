import { useState } from "react";
import { computePrivacy } from "../privacy/privacyScore";

// Live privacy score (spec §73) — the research simulations surfaced as a user feature.
export function PrivacyScore() {
  const [delay, setDelay] = useState(3600);
  const [standardized, setStandardized] = useState(true);
  const [privateRpc, setPrivateRpc] = useState(true);
  const [privateSubmission, setPrivateSubmission] = useState(true);

  const r = computePrivacy({
    poolSize: 2000,
    delaySeconds: delay,
    amountStandardized: standardized,
    privateSubmission,
    privateRpc,
  });

  return (
    <div className="panel">
      <h3>Privacy score</h3>
      <div className="bar">
        <span style={{ width: `${r.score}%` }} />
      </div>
      <div className="row">
        <span className="muted">Score</span>
        <b>{r.score}%</b>
      </div>
      <div className="row">
        <span className="muted">Effective anonymity</span>
        <b>{r.effectiveAnonymity}</b>
      </div>
      <div className="row">
        <span className="muted">Timing risk</span>
        <b>{r.timingRisk}</b>
      </div>
      <div className="row">
        <span className="muted">Amount fingerprint</span>
        <b>{r.amountRisk}</b>
      </div>
      <div className="row">
        <span className="muted">RPC exposure</span>
        <b>{r.rpcExposure}</b>
      </div>
      <div className="row">
        <span className="muted">Relayer</span>
        <b>{r.relayer}</b>
      </div>

      <div style={{ marginTop: 12 }}>
        <label>Delay before withdrawal: {delay}s</label>
        <input type="range" min={10} max={172800} value={delay} onChange={(e: any) => setDelay(Number(e.target.value))} />
        <label>
          <input type="checkbox" checked={standardized} onChange={(e: any) => setStandardized(e.target.checked)} />{" "}
          standardized amount
        </label>
        <br />
        <label>
          <input type="checkbox" checked={privateRpc} onChange={(e: any) => setPrivateRpc(e.target.checked)} /> private
          RPC (light client)
        </label>
        <br />
        <label>
          <input
            type="checkbox"
            checked={privateSubmission}
            onChange={(e: any) => setPrivateSubmission(e.target.checked)}
          />{" "}
          private submission
        </label>
      </div>
    </div>
  );
}
