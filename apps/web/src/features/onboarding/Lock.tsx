// The lock screens (spec §2; plan §44): unlock, create (a password twice, a typed REPLACE over an existing wallet),
// restore from the phrase or from a backup file. Nothing here talks to the network; the session does the work.
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Card, Field, Page, Segmented, TextInput } from "../../design-system";
import { useT } from "../../app/i18n/useT";
import { session, useSession } from "../../wallet/session";

export type LockMode = "unlock" | "create" | "restore";

function useRun() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };
  return { busy, error, run };
}

function ModeLinks({ mode }: { mode: LockMode }) {
  const t = useT();
  const navigate = useNavigate();
  const s = useSession();
  return (
    <div className="ds-chips">
      {s.status === "locked" && mode !== "unlock" ? <Button variant="ghost" onClick={() => navigate("/unlock")}>{t("lock.toUnlock")}</Button> : null}
      {mode !== "create" ? <Button variant="ghost" onClick={() => navigate("/create")} data-testid="to-create">{s.status === "locked" ? t("lock.createReplacing") : t("lock.create")}</Button> : null}
      {mode !== "restore" ? <Button variant="ghost" onClick={() => navigate("/restore")} data-testid="to-restore">{t("lock.restorePhrase")}</Button> : null}
      <Button variant="ghost" onClick={() => navigate("/guest")} data-testid="to-guest">{t("lock.guest")}</Button>
    </div>
  );
}

export function Unlock() {
  const t = useT();
  const { busy, error, run } = useRun();
  const [password, setPassword] = useState("");
  const submit = (e: FormEvent) => { e.preventDefault(); void run(async () => { if (!(await session.unlock(password))) throw new Error(t("lock.wrongPassword")); }); };
  return (
    <main className="ds-main">
      <Page title={t("lock.unlockTitle")} testId="lock-screen">
        <Card padding="lg">
          <form onSubmit={submit} className="ds-page-body">
            <Field label={t("lock.password")} htmlFor="unlock-password" error={error || undefined}>
              <TextInput id="unlock-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            </Field>
            <Button size="lg" full type="submit" disabled={busy || !password} data-testid="unlock">{t("lock.unlock")}</Button>
          </form>
          <ModeLinks mode="unlock" />
        </Card>
      </Page>
    </main>
  );
}

function ReplaceConfirm({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useT();
  return (
    <div className="notice">
      <p>{t("lock.replaceWarning")}</p>
      <TextInput value={value} onChange={(e) => onChange(e.target.value)} placeholder={t("lock.replacePlaceholder")} autoComplete="off" data-testid="replace-confirm" aria-label={t("lock.replacePlaceholder")} />
    </div>
  );
}

export function Create() {
  const t = useT();
  const s = useSession();
  const { busy, error, run } = useRun();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [replace, setReplace] = useState("");
  const replacing = s.status === "locked";
  const ok = password.length >= 8 && password === confirm && (!replacing || replace === "REPLACE");
  const submit = (e: FormEvent) => { e.preventDefault(); if (ok) void run(async () => { await session.create(password); }); };
  return (
    <main className="ds-main">
      <Page title={t("lock.createTitle")} testId="lock-screen">
        <Card padding="lg">
          <p className="ds-field-hint">{t("lock.createIntro")}</p>
          <form onSubmit={submit} className="ds-page-body">
            <Field label={t("lock.passwordNew")} htmlFor="create-password"><TextInput id="create-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" /></Field>
            <Field label={t("lock.passwordConfirm")} htmlFor="create-confirm" error={error || undefined}><TextInput id="create-confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" /></Field>
            {replacing ? <ReplaceConfirm value={replace} onChange={setReplace} /> : null}
            <Button size="lg" full type="submit" disabled={busy || !ok} data-testid="create">{t("lock.create")}</Button>
          </form>
          <ModeLinks mode="create" />
        </Card>
      </Page>
    </main>
  );
}

export function Restore() {
  const t = useT();
  const s = useSession();
  const { busy, error, run } = useRun();
  const [kind, setKind] = useState<"phrase" | "file">("phrase");
  const [phrase, setPhrase] = useState("");
  const [file, setFile] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [replace, setReplace] = useState("");
  const replacing = s.status === "locked";
  const confirmed = !replacing || replace === "REPLACE";
  const okPhrase = password.length >= 8 && password === confirm && confirmed && phrase.trim().length > 0;
  const okFile = password.length > 0 && file.trim().length > 0 && confirmed;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (kind === "phrase" && okPhrase) void run(() => session.restoreFromPhrase(phrase, password));
    if (kind === "file" && okFile) void run(async () => { if (!(await session.restoreFromBackup(file, password))) throw new Error(t("lock.wrongBackupPassword")); });
  };
  return (
    <main className="ds-main">
      <Page title={t("lock.restoreTitle")} testId="lock-screen">
        <Card padding="lg">
          <Segmented value={kind} onChange={(v) => setKind(v === "file" ? "file" : "phrase")} ariaLabel={t("lock.restoreTitle")} name="restore-kind" options={[{ value: "phrase", label: t("lock.restorePhrase"), testId: "restore-phrase" }, { value: "file", label: t("lock.restoreFile"), testId: "restore-file" }]} />
          <form onSubmit={submit} className="ds-page-body">
            {kind === "phrase" ? (
              <>
                <Field label={t("lock.phraseLabel")} htmlFor="restore-words" hint={t("lock.phraseRescan")}><TextInput id="restore-words" value={phrase} onChange={(e) => setPhrase(e.target.value)} placeholder={t("lock.phrasePlaceholder")} autoComplete="off" spellCheck={false} /></Field>
                <Field label={t("lock.passwordNew")} htmlFor="restore-password"><TextInput id="restore-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" /></Field>
                <Field label={t("lock.passwordConfirm")} htmlFor="restore-confirm" error={error || undefined}><TextInput id="restore-confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" /></Field>
              </>
            ) : (
              <>
                <Field label={t("lock.fileLabel")} htmlFor="restore-json"><TextInput id="restore-json" value={file} onChange={(e) => setFile(e.target.value)} autoComplete="off" spellCheck={false} /></Field>
                <Field label={t("lock.passwordBackup")} htmlFor="restore-file-password" error={error || undefined}><TextInput id="restore-file-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></Field>
              </>
            )}
            {replacing ? <ReplaceConfirm value={replace} onChange={setReplace} /> : null}
            <Button size="lg" full type="submit" disabled={busy || (kind === "phrase" ? !okPhrase : !okFile)} data-testid="restore">{t("lock.restore")}</Button>
          </form>
          <ModeLinks mode="restore" />
        </Card>
      </Page>
    </main>
  );
}
