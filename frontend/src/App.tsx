import { useState } from "react";
import { PrivateBalance } from "./components/PrivateBalance";
import { Shield } from "./components/Shield";
import { Send } from "./components/Send";
import { Withdraw } from "./components/Withdraw";
import { PrivacyScore } from "./components/PrivacyScore";

type Tab = "shield" | "send" | "withdraw";

export function App() {
  const [tab, setTab] = useState<Tab>("shield");
  const [account, setAccount] = useState<string | null>(null);

  async function connect() {
    const eth = (window as any).ethereum;
    if (!eth) {
      alert("No injected wallet found.");
      return;
    }
    const accounts = await eth.request({ method: "eth_requestAccounts" });
    setAccount(accounts?.[0] ?? null);
  }

  return (
    <div className="app">
      <h1>
        Privacy Protocol <span className="muted">· V1 wallet (scaffold)</span>
      </h1>
      <p className="muted">
        Immutable, non-custodial shielded pool. Keys are derived locally and the raw secret is never
        written to this site's storage. Client-side proving is stubbed in this scaffold.
      </p>

      <div className="panel row">
        <div>{account ? `Connected: ${account.slice(0, 6)}…${account.slice(-4)}` : "Not connected"}</div>
        {!account && (
          <button className="primary" onClick={connect}>
            Connect wallet
          </button>
        )}
      </div>

      <PrivateBalance />

      <div className="tabs">
        <button className={`tab ${tab === "shield" ? "active" : ""}`} onClick={() => setTab("shield")}>
          Shield
        </button>
        <button className={`tab ${tab === "send" ? "active" : ""}`} onClick={() => setTab("send")}>
          Send privately
        </button>
        <button className={`tab ${tab === "withdraw" ? "active" : ""}`} onClick={() => setTab("withdraw")}>
          Withdraw
        </button>
      </div>

      {tab === "shield" && <Shield />}
      {tab === "send" && <Send />}
      {tab === "withdraw" && <Withdraw />}

      <PrivacyScore />

      <p className="muted" style={{ marginTop: 24, fontSize: 12 }}>
        Scaffold only — see <code>docs/</code> for the spec. Unaudited; not for production.
      </p>
    </div>
  );
}
