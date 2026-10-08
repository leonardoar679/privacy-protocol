import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Home, type HomeSheet } from "./components/Home";
import { Shield } from "./components/Shield";
import { Send } from "./components/Send";
import { Receive } from "./components/Receive";
import { Withdraw } from "./components/Withdraw";
import { Swap } from "./components/Swap";
import { Activity } from "./components/Activity";
import { PrivacyCenter } from "./components/PrivacyCenter";
import { Settings } from "./components/Settings";
import { PrivateAI } from "./components/PrivateAI";
import { Lock, RecoveryPhrase } from "./components/Lock";
import { Guest } from "./components/Guest";
import { deploymentFromEnv } from "./sdk/chain";
import { coreStatus, subscribeCore } from "./sdk/core";
import { runScheduledAction } from "./sdk/swapFunding";
import { useSettings } from "./wallet/settings";
import { specForChain } from "./sdk/lightclient/spec";
import { useVerifyStatus } from "./sdk/verifiedReads";
import { session, useSession } from "./wallet/session";
import { useScheduler } from "./wallet/schedule";
import { usePosture } from "./wallet/posture";

// The wallet (plan V2 §39–§45, §90–§95; whale spec §23): four tabs — Home, Swap, Send, Activity — and
// nothing else in the main navigation; on a wide screen the side column adds Private assets, the Privacy
// Center and Advanced. Add funds, Receive, the Privacy Center, Settings and the private services open as
// sheets over Home. The default screens never mention Merkle trees, nullifiers, proofs, relayers, solvers
// or bridges; "Advanced" (Settings) shows that detail. The scheduler runs here, on any tab, while unlocked.
type Tab = "home" | "swap" | "send" | "activity";
type Sheet = HomeSheet | null;

function Sheet({ title, onClose, children, testId }: { title: string; onClose: () => void; children: React.ReactNode; testId: string }) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title} data-testid={testId}>
        <div className="sheet-head">
          <h2 style={{ margin: 0 }}>{title}</h2>
          <button className="tab" onClick={onClose}>Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function SendTab({ masterSeed, deployment, account }: { masterSeed: Uint8Array; deployment: ReturnType<typeof deploymentFromEnv>; account: string | null }) {
  const [mode, setMode] = useState<"private" | "public">("private");
  return (
    <div data-testid="send-tab">
      <h2>Send</h2>
      <div className="segment" role="tablist">
        <button className={mode === "private" ? "active" : ""} onClick={() => setMode("private")}>Privately</button>
        <button className={mode === "public" ? "active" : ""} onClick={() => setMode("public")}>To a public address</button>
      </div>
      {mode === "private" ? <Send masterSeed={masterSeed} deployment={deployment} /> : <Withdraw masterSeed={masterSeed} deployment={deployment} account={account} />}
    </div>
  );
}

export function App() {
  const [tab, setTab] = useState<Tab>("home");
  const [sheet, setSheet] = useState<Sheet>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [account, setAccount] = useState<string | null>(null);
  const [deployment] = useState(() => deploymentFromEnv());
  const [guest, setGuest] = useState(false);
  const { advanced, verifyReads } = useSettings();
  const core = useSyncExternalStore(subscribeCore, coreStatus);
  const vs = useVerifyStatus();
  const s = useSession();
  const posture = usePosture(deployment);
  const readsLine = !verifyReads ? "Off: the pool is read from the RPC endpoints' agreement alone."
    : !deployment || !specForChain(deployment.chainId) ? `No light client for chain ${deployment?.chainId ?? "?"} (a local devnet): reads rest on the RPC endpoints' agreement.`
    : vs.kind === "verified" ? `Verified at finalized block ${vs.proof.blockNumber}: ${vs.proof.nextLeafIndex} of ${vs.leaves} leaves proven (newer ones rest on the RPC endpoints until finality).`
    : "Checked before every transaction (beacon light client + storage proofs).";
  const coreLine = core === "wasm" ? "crypto core: Rust (WASM)" : core === "typescript" ? "crypto core: TypeScript (no WASM package served)" : "crypto core: loads on the first sync";

  // scheduled actions (a swap's funding at its drawn time) run from any tab while the wallet is unlocked
  useScheduler(useCallback(async (a) => {
    const seed = session.state().seed;
    if (!seed) return;
    await runScheduledAction(a, { masterSeed: seed, deployment });
  }, [deployment]));
  useEffect(() => { if (s.status !== "unlocked") { setSheet(null); setTab("home"); } }, [s.status]);

  async function connect() {
    const eth = (window as any).ethereum;
    if (!eth) { alert("No injected wallet found."); return; }
    const accounts = await eth.request({ method: "eth_requestAccounts" });
    setAccount(accounts?.[0] ?? null);
  }
  const open = (sh: HomeSheet) => setSheet(sh);
  const go = (t: Tab, details = false) => { setTab(t); setDetailsOpen(details); setSheet(null); };

  if (s.status !== "unlocked" || !s.seed || s.pendingPhrase) {
    return (
      <div className="app lock">
        <h1>Privacy Wallet</h1>
        <p className="muted">Your normal wallet, except that your financial history is not broadcast to everyone. Keys are derived on this device from a seed that is stored only encrypted; proofs are generated in this tab.</p>
        {guest ? <Guest onBack={() => setGuest(false)} /> : s.pendingPhrase ? <RecoveryPhrase phrase={s.pendingPhrase} /> : <Lock hasKeystore={s.status === "locked"} onGuest={() => setGuest(true)} />}
      </div>
    );
  }
  const masterSeed = s.seed;

  const nav = (t: Tab, label: string, extra?: string) => <button key={label} className={`${tab === t && !sheet ? "active" : ""} ${extra ?? ""}`} onClick={() => go(t)}>{label}</button>;

  return (
    <div className="shell">
      <nav className="nav" aria-label="Main">
        <div className="brand">Privacy Wallet</div>
        {nav("home", "Home")}
        <button className="desktop-only" onClick={() => go("home", true)}>Private assets</button>
        {nav("swap", "Swap")}
        {nav("send", "Send")}
        {nav("activity", "Activity")}
        <button className="desktop-only" onClick={() => setSheet("privacy")}>Privacy Center</button>
        <button className="desktop-only" onClick={() => setSheet("settings")}>Advanced</button>
      </nav>
      <main className="app">
        {s.journalUnreadable && (
          <div className="notice" style={{ marginBottom: 12 }} data-testid="journal-unreadable">
            <b>Your encrypted journal could not be read with this seed.</b> Nothing was overwritten. This session runs on an empty journal and saves nothing until you decide: restore a backup file (lock, then Restore), or set the unreadable journal aside and start a fresh one (your notes come back with a rescan).
            <div className="tabs" style={{ margin: "8px 0 0" }}>
              <button className="tab" onClick={() => session.lock()}>Lock and restore a backup</button>
              <button className="tab" onClick={() => session.discardUnreadableJournal()}>Set it aside and start fresh</button>
            </div>
          </div>
        )}
        {tab === "home" && <Home masterSeed={masterSeed} deployment={deployment} account={account} privacyLevel={posture.overall} detailsOpen={detailsOpen} onOpen={open} onTab={(t) => go(t)} />}
        {tab === "swap" && <Swap masterSeed={masterSeed} deployment={deployment} account={account} />}
        {tab === "send" && <SendTab masterSeed={masterSeed} deployment={deployment} account={account} />}
        {tab === "activity" && <Activity deployment={deployment} />}
      </main>

      {sheet === "add-funds" && (
        <Sheet title="Add funds" onClose={() => setSheet(null)} testId="sheet-add-funds">
          <div className="panel row" style={{ alignItems: "center" }}>
            <span className="muted small">{account ? `Connected: ${account.slice(0, 6)}…${account.slice(-4)}` : "Connect the wallet that pays the deposit"}</span>
            {!account && <button className="primary" onClick={connect}>Connect wallet</button>}
          </div>
          <Shield masterSeed={masterSeed} deployment={deployment} />
        </Sheet>
      )}
      {sheet === "receive" && <Sheet title="Receive" onClose={() => setSheet(null)} testId="sheet-receive"><Receive masterSeed={masterSeed} /></Sheet>}
      {sheet === "privacy" && <Sheet title="Privacy Center" onClose={() => setSheet(null)} testId="sheet-privacy"><PrivacyCenter deployment={deployment} /></Sheet>}
      {sheet === "settings" && <Sheet title="Settings" onClose={() => setSheet(null)} testId="sheet-settings"><Settings deployment={deployment} readsLine={readsLine} coreLine={coreLine} /></Sheet>}
      {sheet === "ai" && <Sheet title="Private AI" onClose={() => setSheet(null)} testId="sheet-ai"><PrivateAI masterSeed={masterSeed} deployment={deployment} /></Sheet>}
      {advanced && tab === "home" && <p className="muted small" style={{ textAlign: "center" }}>{coreLine}</p>}
    </div>
  );
}
