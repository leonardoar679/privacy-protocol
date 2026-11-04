// The lock screens (spec §2; plan §44): unlock, create (a password twice, a typed REPLACE over an existing wallet),
// restore from the phrase or from a backup file. Nothing here talks to the network; the session does the work.
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Card, Field, Page, Segmented, TextButton, Input } from "@privacy-wallet/ui";
import { useT } from "../../app/i18n/useT";
import { ReplaceRefused, RestoreRefused, session, WalletExists, type RestoreRefusal } from "@privacy-wallet/sdk/wallet/session";
import type { MessageKey } from "../../app/i18n/en";
import { useSession } from "../../hooks/core";
import { lockedElsewhere } from "../../platform/autoLock";
import { StorageNotice } from "../../app/StorageNotice";
import { prefs } from "../../storage/prefs";

/** A new keystore in place: the device's backup status was the previous wallet's (audit round 2, r29). It read "✓ Recovery
 *  backup created" for a wallet never backed up, and the Protect Review's backup prompt never showed. */
const newWallet = () => void prefs().update({ backup: undefined });

export type LockMode = "unlock" | "create" | "restore";

/** A restore's or an unlock's refusal in the reader's words (the eleventh review round, 2026-11-04): the engine's English had reached the screen. */
const REFUSAL_WORDS: Record<RestoreRefusal, MessageKey> = {
  "not-a-backup": "lock.refused.notABackup",
  "journal-not-wallet": "lock.refused.journalNotWallet",
  "journal-does-not-open": "lock.refused.journalDoesNotOpen",
  "public-phrase": "lock.refused.publicPhrase",
  "public-backup": "lock.refused.publicBackup",
  "public-wallet": "lock.refused.publicWallet",
  "phrase-length": "lock.refused.phraseLength",
  "phrase-invalid": "lock.refused.phraseInvalid",
};
/** A wallet another tab created meanwhile (audit round 2, r27): said in the reader's words; the screen now asks for REPLACE. */
const worded = (e: unknown, t: ReturnType<typeof useT>) =>
  e instanceof WalletExists
    ? new Error(t("lock.walletExists"))
    : e instanceof ReplaceRefused
      ? new Error(t("lock.replaceRefused"))
      : e instanceof RestoreRefused
        ? new Error(t(REFUSAL_WORDS[e.reason]))
        : e;

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
      {s.status === "locked" && mode !== "unlock" ? <TextButton onClick={() => navigate("/unlock")}>{t("lock.toUnlock")}</TextButton> : null}
      {mode !== "create" ? <TextButton onClick={() => navigate("/create")} data-testid="to-create">{s.status === "locked" ? t("lock.createReplacing") : t("lock.create")}</TextButton> : null}
      {mode !== "restore" ? <TextButton onClick={() => navigate("/restore")} data-testid="to-restore">{t("lock.restorePhrase")}</TextButton> : null}
      <TextButton onClick={() => navigate("/guest")} data-testid="to-guest">{t("lock.guest")}</TextButton>
    </div>
  );
}

export function Unlock() {
  const t = useT();
  const { busy, error, run } = useRun();
  const [password, setPassword] = useState("");
  // a wallet forgotten in another tab is said so (the eleventh review round, A11-6), never "Wrong password."
  const submit = (e: FormEvent) => { e.preventDefault(); void run(async () => { if (!(await session.unlock(password).catch((x: unknown) => { throw worded(x, t); }))) throw new Error(t(session.hasKeystore() ? "lock.wrongPassword" : "lock.walletRemoved")); }); };
  return (
    <main className="ds-main">
      <Page title={t("lock.unlockTitle")} testId="lock-screen">
        <Card padding="lg">
          <form onSubmit={submit} className="ds-page-body">
            {lockedElsewhere() ? (
              <p className="ds-note" data-testid="locked-elsewhere">
                {t("tab.lockedElsewhere")}
              </p>
            ) : null}
            <Field label={t("lock.password")} htmlFor="unlock-password" error={error || undefined}>
              <Input id="unlock-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
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
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={t("lock.replacePlaceholder")} autoComplete="off" data-testid="replace-confirm" aria-label={t("lock.replacePlaceholder")} />
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
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ok) void run(() => session.create(password, undefined, { replace: replacing }).then(newWallet, (x: unknown) => { throw worded(x, t); }));
  };
  return (
    <main className="ds-main">
      <Page title={t("lock.createTitle")} testId="lock-screen">
        <StorageNotice />
        <Card padding="lg">
          <p className="ds-field-hint">{t("lock.createIntro")}</p>
          <form onSubmit={submit} className="ds-page-body">
            <Field label={t("lock.passwordNew")} htmlFor="create-password"><Input id="create-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" /></Field>
            <Field label={t("lock.passwordConfirm")} htmlFor="create-confirm" error={error || undefined}><Input id="create-confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" /></Field>
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
    if (kind === "phrase" && okPhrase) void run(() => session.restoreFromPhrase(phrase, password, { replace: replacing }).then(newWallet, (x: unknown) => { throw worded(x, t); }));
    if (kind === "file" && okFile)
      void run(async () => {
        const restored = await session.restoreFromBackup(file, password, { replace: replacing }).catch((x: unknown) => { throw worded(x, t); });
        if (!restored) throw new Error(t("lock.wrongBackupPassword"));
        newWallet();
      });
  };
  return (
    <main className="ds-main">
      <Page title={t("lock.restoreTitle")} testId="lock-screen">
        <StorageNotice />
        <Card padding="lg">
          <Segmented value={kind} onChange={(v) => setKind(v === "file" ? "file" : "phrase")} ariaLabel={t("lock.restoreTitle")} name="restore-kind" options={[{ value: "phrase", label: t("lock.restorePhrase"), testId: "restore-phrase" }, { value: "file", label: t("lock.restoreFile"), testId: "restore-file" }]} />
          <form onSubmit={submit} className="ds-page-body">
            {kind === "phrase" ? (
              <>
                <Field label={t("lock.phraseLabel")} htmlFor="restore-words" hint={t("lock.phraseRescan")}><Input id="restore-words" value={phrase} onChange={(e) => setPhrase(e.target.value)} placeholder={t("lock.phrasePlaceholder")} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} /></Field>
                <Field label={t("lock.passwordNew")} htmlFor="restore-password"><Input id="restore-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" /></Field>
                <Field label={t("lock.passwordConfirm")} htmlFor="restore-confirm" error={error || undefined}><Input id="restore-confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" /></Field>
              </>
            ) : (
              <>
                <Field label={t("lock.fileLabel")} htmlFor="restore-json"><Input id="restore-json" value={file} onChange={(e) => setFile(e.target.value)} autoComplete="off" spellCheck={false} /></Field>
                <Field label={t("lock.passwordBackup")} htmlFor="restore-file-password" error={error || undefined}><Input id="restore-file-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></Field>
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
