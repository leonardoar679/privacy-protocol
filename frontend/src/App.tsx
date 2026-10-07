import { useState } from "react";
import { PrivateBalance } from "./components/PrivateBalance";
import { Shield } from "./components/Shield";
import { Send } from "./components/Send";
import { Receive } from "./components/Receive";
import { Withdraw } from "./components/Withdraw";
import { PrivacyScore } from "./components/PrivacyScore";
import { Swap } from "./components/Swap";
import { PrivateAI } from "./components/PrivateAI";
import { Lock, RecoveryPhrase } from "./components/Lock";
import { Guest } from "./components/Guest";
import { deploymentFromEnv } from "./sdk/chain";
import { settings, useSettings } from "./wallet/settings";
import { session, useSession } from "./wallet/session";

// The wallet (plan §35, §76–§77): four everyday actions — Send, Receive, Swap, Pay — plus Shield and
// Withdraw at the pool's edges. The default screens never mention Merkle trees, nullifiers, proofs,
// relayers, solvers or bridges; "Advanced" shows that detail and the submission choice.
type Tab = "shield" | "send" | "receive" | "withdraw" | "swap" | "ai";

function downloadBackup() {
  const json = session.exportBackup();
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `privacy-wallet-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function App() {
  const [tab, setTab] = useState<Tab>("shield");
  const [account, setAccount] = useState<string | null>(null);
  const [deployment] = useState(() => deploymentFromEnv());
  const [guest, setGuest] = useState(false);
  const { submission, advanced } = useSettings();
  const s = useSession();

  async function connect() {
    const eth = (window as any).ethereum;
    if (!eth) {
      alert("No injected wallet found.");
      return;
    }
    const accounts = await eth.request({ method: "eth_requestAccounts" });
    setAccount(accounts?.[0] ?? null);
  }

  if (s.status !== "unlocked" || !s.seed || s.pendingPhrase) {
    return (
      <div className="app">
        <h1>
          Privacy Protocol <span className="muted">· V1.1 wallet</span>
        </h1>
        <p className="muted">
          Immutable, non-custodial shielded pool. Keys are derived on this device from a seed that is stored only encrypted; proofs are generated in this tab.
        </p>
        {guest ? <Guest onBack={() => setGuest(false)} /> : s.pendingPhrase ? <RecoveryPhrase phrase={s.pendingPhrase} /> : <Lock hasKeystore={s.status === "locked"} onGuest={() => setGuest(true)} />}
      </div>
    );
  }
  const masterSeed = s.seed;

  return (
    <div className="app">
      <h1>
        Privacy Protocol <span className="muted">· V1.1 wallet</span>
      </h1>
      <p className="muted">
        {advanced
          ? "Immutable, non-custodial shielded pool. Keys are derived locally and the raw secret is never written to this site's storage. Proofs are generated in this tab (Web Worker) from the notes this wallet holds."
          : "Your normal wallet, except that your financial history is not broadcast to everyone."}
      </p>

      <div className="panel row">
        <div>
          {account ? `Connected: ${account.slice(0, 6)}…${account.slice(-4)}` : "Not connected"}
          <div className="muted" style={{ fontSize: 12 }}>
            {deployment ? (advanced ? `Core ${deployment.core.slice(0, 8)}… · chain ${deployment.chainId} · ${deployment.rpcUrls.length} RPC endpoint${deployment.rpcUrls.length === 1 ? "" : "s"}` : `chain ${deployment.chainId}`) : "No deployment configured: set VITE_RPC_URLS, VITE_CORE, VITE_ETH_VAULT (docs/testnet.md)"}
          </div>
        </div>
        <div className="tabs" style={{ margin: 0 }}>
          {!account && (
            <button className="primary" onClick={connect}>
              Connect wallet
            </button>
          )}
          <button className="tab" onClick={downloadBackup} title="Keystore + encrypted journal; restore with your password">Backup</button>
          <button className="tab" onClick={() => session.lock()}>Lock</button>
          <label className="tab" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={advanced} onChange={(e: any) => settings.set({ advanced: e.target.checked })} /> Advanced
          </label>
        </div>
      </div>

      {advanced && (
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
      )}

      <PrivateBalance deployment={deployment} masterSeed={masterSeed} account={account} />

      <div className="tabs">
        <button className={`tab ${tab === "shield" ? "active" : ""}`} onClick={() => setTab("shield")}>
          Shield
        </button>
        <button className={`tab ${tab === "send" ? "active" : ""}`} onClick={() => setTab("send")}>
          Send privately
        </button>
        <button className={`tab ${tab === "receive" ? "active" : ""}`} onClick={() => setTab("receive")}>
          Receive
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
      {tab === "receive" && <Receive masterSeed={masterSeed} />}
      {tab === "withdraw" && <Withdraw masterSeed={masterSeed} deployment={deployment} />}
      {tab === "swap" && <Swap masterSeed={masterSeed} deployment={deployment} />}
      {tab === "ai" && <PrivateAI masterSeed={masterSeed} deployment={deployment} />}

      {advanced && <PrivacyScore />}

      <p className="muted" style={{ marginTop: 24, fontSize: 12 }}>
        Unaudited; not for production. The proving key served in dev is the insecure single-party setup (circuits/setup/dev).
      </p>
    </div>
  );
}
