// The Classic app's root (V7 Stage 2: the package and its gates; the original-style screens arrive with Stage 3).
// Nothing here sends a transaction: every build shows the "Not connected" words of spec v3.0 §7.7 until a pool function
// is switched live after its release gate and the owner's legal review.
import { config } from "../config";

export const NOT_CONNECTED = "Not connected — interface prototype. Live contract, note-generation and transaction functionality is subject to verification.";

export function App() {
  const c = config();
  return (
    <main className="tc-page">
      <header className="tc-header">
        <h1 className="tc-title">Tornado Classic</h1>
        <p className="tc-sub">Ethereum · an original-style interface for existing Classic users</p>
      </header>
      <section className="tc-banner" role="status" data-testid="classic-not-connected">
        {NOT_CONNECTED}
      </section>
      <p className="tc-note" data-testid="classic-stage">
        The deposit and withdraw screens of the original interface follow in the next stage. This build reads chain {c.chainId}.
      </p>
    </main>
  );
}
