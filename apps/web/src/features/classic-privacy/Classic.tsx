// Classic Privacy (spec §3.14, §16; plan §32–§33): under More only, never on the Swap screen. The fixed pools of the
// devnet mock, a deposit with the disclosures and the note shown once ("I saved my note"), a withdrawal prepared
// against a note (the proof arrives with the circuit port), a position's status, and the Advanced lines — the
// commitment, the Merkle root, the root age, the relayer, its fee, the proof status. The module keeps its own state
// (the journal's optional `classic` field) and never touches the protected balance.
import { useState } from "react";
import { formatNote, generateNote, parseNote, validateNote, type ClassicNote } from "@ref/classic/note";
import { Button, Card, Collapsible, Field, ListRow, Page, StatusBadge, TextInput } from "../../design-system";
import { useT } from "../../app/i18n/useT";
import type { MessageKey } from "../../app/i18n/en";
import { session, useSession } from "../../wallet/session";
import { useSettings } from "../../wallet/settings";
import { classicPools, poolById } from "./mockPool";
import { CLASSIC_DISCLOSURE_KEYS, type ClassicDepositRecord, type ClassicPool } from "./types";

const randomBytes = (n: number): Uint8Array => { const b = new Uint8Array(n); crypto.getRandomValues(b); return b; };
const EMPTY: ClassicDepositRecord[] = [];
/** The classic deposits of the unlocked journal (the optional `classic` field; never written by emptyJournal()). */
export const classicDeposits = (): ClassicDepositRecord[] => (session.isUnlocked() ? (session.journal().classic?.deposits ?? EMPTY) : EMPTY);
function recordDeposit(rec: ClassicDepositRecord): void {
  session.update((j) => { j.classic = { deposits: [...(j.classic?.deposits ?? []), rec] }; });
}

export function ClassicHome({ onOpen, onBack }: { onOpen: (poolId: string) => void; onBack?: () => void }) {
  const t = useT();
  useSession();
  const deposits = classicDeposits();
  return (
    <Page title={t("route.classic")} back={onBack} testId="classic">
      <div className="ds-stack">
        <Card>
          <div className="ds-stack-sm">
            <h2 className="ds-review-title">{t("classic.fixedPool")}</h2>
            <p className="ds-note">{t("classic.intro")}</p>
            <p className="ds-note" data-testid="classic-separate">{t("classic.disclosure.separate")}</p>
          </div>
        </Card>
        <Card padding="none" testId="classic-pools">
          {classicPools().map((p) => {
            const st = p.stats();
            const mine = deposits.filter((d) => d.poolId === p.id && d.status !== "withdrawn").length;
            return <ListRow key={p.id} title={t("classic.poolTitle", { amount: p.denomination, symbol: p.currency.toUpperCase() })} subtitle={t("classic.poolLine", { size: st.size, deposits: st.deposits.toLocaleString(), mine })} onPress={() => onOpen(p.id)} trailing={<StatusBadge tone="ok">{t("classic.status.ready")}</StatusBadge>} testId={`classic-pool-${p.id}`} />;
          })}
        </Card>
      </div>
    </Page>
  );
}

export function ClassicPoolScreen({ poolId, onBack }: { poolId: string; onBack: () => void }) {
  const t = useT();
  const { advanced } = useSettings();
  useSession();
  const pool: ClassicPool | undefined = poolById(poolId);
  const [mode, setMode] = useState<"pool" | "deposit" | "withdraw">("pool");
  const [agreed, setAgreed] = useState(false);
  const [note, setNote] = useState<ClassicNote | null>(null);
  const [saved, setSaved] = useState(false);
  const [deposited, setDeposited] = useState<ClassicDepositRecord | null>(null);
  const [noteText, setNoteText] = useState("");
  const [recipient, setRecipient] = useState("");
  const [withdrawal, setWithdrawal] = useState<ReturnType<ClassicPool["prepareWithdrawal"]> | null>(null);
  const [error, setError] = useState("");
  if (!pool) return <Page title={t("route.classic")} back={onBack} testId="classic-pool"><Card><p className="ds-note">{t("classic.noPool")}</p></Card></Page>;
  const st = pool.stats();
  const symbol = pool.currency.toUpperCase();
  const mine = classicDeposits().filter((d) => d.poolId === pool.id && d.status !== "withdrawn");
  const adv = pool.advanced();

  function startDeposit() { setNote(generateNote(pool!.currency, pool!.denomination, pool!.netId, randomBytes)); setSaved(false); setDeposited(null); setAgreed(false); setMode("deposit"); }
  function confirmDeposit() {
    if (!note || !saved) return;
    const rec = pool!.deposit(note);
    recordDeposit(rec);
    setDeposited(rec);
  }
  function prepare() {
    setError("");
    const parsed = parseNote(noteText);
    if (!parsed.ok) { setError(parsed.reason); return; }
    const bad = validateNote(parsed.note, { currency: pool!.currency, amount: pool!.denomination, netId: pool!.netId });
    if (bad) { setError(bad); return; }
    if (!/^0x[0-9a-fA-F]{40}$/.test(recipient.trim())) { setError(t("classic.withdraw.badRecipient")); return; }
    setWithdrawal(pool!.prepareWithdrawal(parsed.note, recipient.trim(), adv.relayer));
  }

  return (
    <Page title={t("classic.poolTitle", { amount: pool.denomination, symbol })} back={mode === "pool" ? onBack : () => setMode("pool")} testId="classic-pool">
      <div className="ds-stack" data-mode={mode}>
        {mode === "pool" ? (
          <>
            <Card testId="classic-position">
              <div className="ds-stack-sm">
                <div className="ds-kv"><span className="ds-kv-label">{t("classic.poolSize")}</span><b className="ds-kv-value">{st.size}</b></div>
                <div className="ds-kv"><span className="ds-kv-label">{t("classic.deposits")}</span><b className="ds-kv-value">{st.deposits.toLocaleString()}</b></div>
                <div className="ds-kv"><span className="ds-kv-label">{t("classic.yourPosition")}</span><b className="ds-kv-value" data-testid="classic-mine">{mine.length ? `${mine.length} × ${pool.denomination} ${symbol}` : t("classic.none")}</b></div>
                <div className="ds-kv"><span className="ds-kv-label">{t("activity.status")}</span><StatusBadge tone="ok">{t("classic.status.ready")}</StatusBadge></div>
                <div className="ds-actions">
                  <Button onClick={startDeposit} data-testid="classic-protect">{t("classic.protect")}</Button>
                  <Button variant="secondary" onClick={() => { setMode("withdraw"); setWithdrawal(null); setError(""); }} data-testid="classic-withdraw">{t("classic.withdrawPrivately")}</Button>
                </div>
              </div>
            </Card>
            {advanced ? (
              <Collapsible summary={t("protect.technical")} testId="classic-advanced">
                <div className="ds-stack-sm ds-note">
                  <div className="ds-kv"><span className="ds-kv-label">{t("classic.adv.root")}</span><code className="ds-mono-break">{adv.root}</code></div>
                  <div className="ds-kv"><span className="ds-kv-label">{t("classic.adv.rootAge")}</span><b>{t("classic.adv.seconds", { n: adv.rootAge })}</b></div>
                  <div className="ds-kv"><span className="ds-kv-label">{t("classic.adv.relayer")}</span><b>{adv.relayer}</b></div>
                  <div className="ds-kv"><span className="ds-kv-label">{t("classic.adv.relayerFee")}</span><b>{`${adv.relayerFeeBps / 100} %`}</b></div>
                  <div className="ds-kv"><span className="ds-kv-label">{t("classic.adv.proofStatus")}</span><b data-testid="classic-proof-status">{adv.proofStatus}</b></div>
                  {mine.map((d) => <div key={d.id} className="ds-kv" data-testid="classic-commitment"><span className="ds-kv-label">{t("classic.adv.commitment", { leaf: d.leafIndex })}</span><code className="ds-mono-break">{d.commitment}</code></div>)}
                </div>
              </Collapsible>
            ) : null}
          </>
        ) : null}

        {mode === "deposit" && note ? (
          <Card testId="classic-deposit">
            <div className="ds-stack-sm">
              {!deposited ? (
                <>
                  <h2 className="ds-review-title">{t("classic.deposit.title", { amount: pool.denomination, symbol })}</h2>
                  <ul className="ds-plain-list ds-note" data-testid="classic-disclosures">{CLASSIC_DISCLOSURE_KEYS.map((k) => <li key={k}>{t(k as MessageKey)}</li>)}</ul>
                  <label className="ds-switch-row ds-native-row"><span>{t("classic.deposit.agree")}</span><input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} data-testid="classic-agree" /></label>
                  {agreed ? (
                    <>
                      <p className="ds-note-warn">{t("classic.deposit.noteOnce")}</p>
                      <code className="ds-mono-break" data-testid="classic-note">{formatNote(note)}</code>
                      <div className="ds-actions"><Button variant="secondary" icon="copy" onClick={() => void navigator.clipboard?.writeText(formatNote(note))}>{t("receive.copy")}</Button></div>
                      <label className="ds-switch-row ds-native-row"><span>{t("classic.deposit.saved")}</span><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} data-testid="classic-saved" /></label>
                    </>
                  ) : null}
                  <Button size="lg" full disabled={!agreed || !saved} onClick={confirmDeposit} data-testid="classic-deposit-confirm">{t("classic.deposit.confirm", { amount: pool.denomination, symbol })}</Button>
                </>
              ) : (
                <>
                  <StatusBadge tone="ok" testId="classic-deposited">{t("classic.deposit.done", { amount: pool.denomination, symbol, leaf: deposited.leafIndex })}</StatusBadge>
                  <p className="ds-note">{t("classic.deposit.doneNote")}</p>
                  <Button onClick={() => setMode("pool")}>{t("classic.backToPool")}</Button>
                </>
              )}
            </div>
          </Card>
        ) : null}

        {mode === "withdraw" ? (
          <Card testId="classic-withdraw-form">
            <div className="ds-stack-sm">
              <h2 className="ds-review-title">{t("classic.withdraw.title")}</h2>
              <Field label={t("classic.withdraw.note")} htmlFor="classic-note-input"><TextInput id="classic-note-input" value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="tornado-eth-1-31337-0x…" autoComplete="off" spellCheck={false} data-testid="classic-note-input" /></Field>
              <Field label={t("classic.withdraw.recipient")} htmlFor="classic-recipient"><TextInput id="classic-recipient" value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="0x…" autoComplete="off" spellCheck={false} data-testid="classic-recipient" /></Field>
              {error ? <p className="ds-field-error" data-testid="classic-error">{error}</p> : null}
              <Button size="lg" full onClick={prepare} data-testid="classic-prepare">{t("classic.withdraw.prepare")}</Button>
              {withdrawal ? (
                <div className="ds-review-block" data-testid="classic-withdrawal" data-status={withdrawal.status}>
                  <div className="ds-kv"><span className="ds-kv-label">{t("classic.withdraw.recipient")}</span><code className="ds-mono-break">{withdrawal.recipient}</code></div>
                  <div className="ds-kv"><span className="ds-kv-label">{t("classic.adv.relayer")}</span><b>{withdrawal.relayer}</b></div>
                  <div className="ds-kv"><span className="ds-kv-label">{t("classic.adv.relayerFee")}</span><b>{withdrawal.fee}</b></div>
                  <div className="ds-kv"><span className="ds-kv-label">{t("classic.adv.proofStatus")}</span><StatusBadge tone="pending" testId="classic-proof-pending">{adv.proofStatus}</StatusBadge></div>
                </div>
              ) : null}
            </div>
          </Card>
        ) : null}
      </div>
    </Page>
  );
}
