import { useState } from "react";
import { PrivateBalance } from "./components/PrivateBalance";
import { Shield } from "./components/Shield";
import { Send } from "./components/Send";
import { Withdraw } from "./components/Withdraw";
import { PrivacyScore } from "./components/PrivacyScore";
import { Swap } from "./components/Swap";
import { PrivateAI } from "./components/PrivateAI";
import { generateMasterSeed } from "./keys/wallet";
import { deploymentFromEnv } from "./sdk/chain";
import { settings, useSettings } from "./wallet/settings";

type Tab = "shield" | "send" | "withdraw" | "swap" | "ai";

export function App() {
  const [tab, setTab] = useState<Tab>("shield");
  const [account, setAccount] = useState<string | null>(null);
  const [masterSeed] = useState(() => generateMasterSeed()); // in memory only (TC-01); a real wallet restores it from its keystore
  const [deployment] = useState(() => deploymentFromEnv());
  const { submission } = useSettings();

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
        Privacy Protocol <span className="muted">· V1.1 wallet</span>
      </h1>
      <p className="muted">
        Immutable, non-custodial shielded pool. Keys are derived locally and the raw secret is never
        written to this site's storage. Proofs are generated in this tab (Web Worker) from the notes
        this session created.
      </p>

      <div className="panel row">
        <div>
          {account ? `Connected: ${account.slice(0, 6)}…${account.slice(-4)}` : "Not connected"}
          <div className="muted" style={{ fontSize: 12 }}>
            {deployment ? `Core ${deployment.core.slice(0, 8)}… · chain ${deployment.chainId}` : "No deployment configured: set VITE_RPC_URL, VITE_CORE, VITE_ETH_VAULT (docs/testnet.md)"}
          </div>
        </div>
        {!account && (
          <button className="primary" onClick={connect}>
            Connect wallet
          </button>
        )}
      </div>

      <div className="panel">
        <label>Submission of private transactions</label>
        <select value={submission.kind} onChange={(e: any) => settings.set({ submission: e.target.value === "relayer" ? { kind: "relayer", url: submission.kind === "relayer" ? submission.url : "http://127.0.0.1:8790" } : { kind: "wallet" } })}>
          <option value="relayer">Relayer (private: paid by a private fee note; your address never submits)</option>
          <option value="wallet">Connected wallet (public: the transaction is sent from your address)</option>
        </select>
        {submission.kind === "relayer" && (
          <>
            <label>Relayer URL (any relayer; self-submission is the fallback)</label>
            <input value={submission.url} onChange={(e: any) => settings.set({ submission: { kind: "relayer", url: e.target.value } })} />
          </>
        )}
      </div>

      <PrivateBalance deployment={deployment} masterSeed={masterSeed} />

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
        <button className={`tab ${tab === "swap" ? "active" : ""}`} onClick={() => setTab("swap")}>
          Swap privately
        </button>
        <button className={`tab ${tab === "ai" ? "active" : ""}`} onClick={() => setTab("ai")}>
          Private AI
        </button>
      </div>

      {tab === "shield" && <Shield masterSeed={masterSeed} deployment={deployment} />}
      {tab === "send" && <Send masterSeed={masterSeed} deployment={deployment} />}
      {tab === "withdraw" && <Withdraw masterSeed={masterSeed} deployment={deployment} />}
      {tab === "swap" && <Swap masterSeed={masterSeed} deployment={deployment} />}
      {tab === "ai" && <PrivateAI masterSeed={masterSeed} deployment={deployment} />}

      <PrivacyScore />

      <p className="muted" style={{ marginTop: 24, fontSize: 12 }}>
        Unaudited; not for production. The proving key served in dev is the insecure single-party setup (circuits/setup/dev).
      </p>
    </div>
  );
}
