import { useState } from "react";
import { session } from "../wallet/session";

// The screens before the wallet is usable (plan §44): create (seed → password → the 24 words shown
// once), unlock, or restore from the phrase / a backup file. Nothing here talks to the network.
type Mode = "unlock" | "create" | "restore-phrase" | "restore-file";

/** Shown by the App right after create(), until the user acknowledges the phrase (session.pendingPhrase). */
export function RecoveryPhrase({ phrase }: { phrase: string }) {
  const [ack, setAck] = useState(false);
  return (
    <div className="panel" data-testid="recovery-phrase">
      <h3>Your recovery phrase</h3>
      <p className="muted" style={{ fontSize: 13 }}>Write these 24 words down, in order, and keep them offline. They restore this wallet anywhere; this site cannot. Nobody will ever ask you for them.</p>
      <code style={{ display: "block", lineHeight: 1.8, wordBreak: "break-word" }}>{phrase}</code>
      <label style={{ display: "block", marginTop: 12 }}>
        <input type="checkbox" checked={ack} onChange={(e: any) => setAck(e.target.checked)} /> I have written the 24 words down
      </label>
      <button className="primary" disabled={!ack} onClick={() => session.acknowledgePhrase()} style={{ marginTop: 8 }}>Continue</button>
    </div>
  );
}

export function Lock({ hasKeystore, onGuest }: { hasKeystore: boolean; onGuest?: () => void }) {
  const [mode, setMode] = useState<Mode>(hasKeystore ? "unlock" : "create");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [phrase, setPhrase] = useState("");
  const [file, setFile] = useState("");
  const [replace, setReplace] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true); setError("");
    try { await fn(); } catch (e: any) { setError(e?.message ?? String(e)); setBusy(false); }
  }

  // creating or restoring over an existing wallet replaces its keystore and journal on this device: a typed confirmation, never one click
  const replacing = hasKeystore && mode !== "unlock";
  const confirmed = !replacing || replace === "REPLACE";
  const passwordOk = password.length >= 8 && password === confirm && confirmed;

  const create = () => run(async () => { await session.create(password); });
  const unlock = () => run(async () => { if (!(await session.unlock(password))) throw new Error("wrong password"); });
  const restorePhrase = () => run(() => session.restoreFromPhrase(phrase, password));
  const restoreFile = () => run(async () => { if (!(await session.restoreFromBackup(file, password))) throw new Error("wrong password for this backup"); });

  return (
    <div className="panel" data-testid="lock-screen">
      <h3>{mode === "unlock" ? "Unlock your wallet" : mode === "create" ? "Create a wallet" : "Restore a wallet"}</h3>
      {mode === "unlock" && (
        <>
          <label>Password</label>
          <input type="password" value={password} onChange={(e: any) => setPassword(e.target.value)} onKeyDown={(e: any) => { if (e.key === "Enter") unlock(); }} />
          <button className="primary" onClick={unlock} disabled={busy || !password}>Unlock</button>
        </>
      )}
      {mode === "create" && (
        <>
          <p className="muted" style={{ fontSize: 13 }}>A new seed is generated on this device. It is encrypted with your password before anything is stored; you will be shown a 24-word recovery phrase once.</p>
          <label>Password (8+ characters)</label>
          <input type="password" value={password} onChange={(e: any) => setPassword(e.target.value)} />
          <label>Confirm password</label>
          <input type="password" value={confirm} onChange={(e: any) => setConfirm(e.target.value)} />
          <button className="primary" onClick={create} disabled={busy || !passwordOk}>Create wallet</button>
        </>
      )}
      {mode === "restore-phrase" && (
        <>
          <label>24-word recovery phrase</label>
          <input value={phrase} onChange={(e: any) => setPhrase(e.target.value)} placeholder="word word word …" autoComplete="off" />
          <label>New password (8+ characters)</label>
          <input type="password" value={password} onChange={(e: any) => setPassword(e.target.value)} />
          <label>Confirm password</label>
          <input type="password" value={confirm} onChange={(e: any) => setConfirm(e.target.value)} />
          <button className="primary" onClick={restorePhrase} disabled={busy || !passwordOk || !phrase.trim()}>Restore</button>
          <p className="muted" style={{ fontSize: 12 }}>Your notes come back with "Rescan the chain for my notes" after unlocking.</p>
        </>
      )}
      {mode === "restore-file" && (
        <>
          <label>Backup file contents (JSON)</label>
          <input value={file} onChange={(e: any) => setFile(e.target.value)} placeholder='{"v":1,"keystore":…}' autoComplete="off" />
          <label>The password of that backup</label>
          <input type="password" value={password} onChange={(e: any) => setPassword(e.target.value)} />
          <button className="primary" onClick={restoreFile} disabled={busy || !password || !file.trim()}>Restore</button>
        </>
      )}
      {replacing && (
        <div className="notice" style={{ marginTop: 6 }}>
          This replaces the wallet on this device: its keystore and encrypted journal are removed. Its phrase or a backup file is then the only way back. Type REPLACE to confirm.
          <input value={replace} onChange={(e: any) => setReplace(e.target.value)} placeholder="REPLACE" autoComplete="off" data-testid="replace-confirm" style={{ marginBottom: 0 }} />
        </div>
      )}
      {error && <p style={{ color: "var(--warn)" }}>{error}</p>}
      <div className="tabs" style={{ marginTop: 10 }}>
        {hasKeystore && mode !== "unlock" && <button className="tab" onClick={() => setMode("unlock")}>Unlock</button>}
        {mode !== "create" && <button className="tab" onClick={() => setMode("create")}>{hasKeystore ? "Create a new wallet (replaces this one)" : "Create"}</button>}
        {mode !== "restore-phrase" && <button className="tab" onClick={() => setMode("restore-phrase")}>Restore from phrase</button>}
        {mode !== "restore-file" && <button className="tab" onClick={() => setMode("restore-file")}>Restore from backup file</button>}
        {onGuest && <button className="tab" onClick={onGuest}>Swap without a wallet</button>}
      </div>
    </div>
  );
}
