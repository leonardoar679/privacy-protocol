// ClassicPrivacyUI (spec v2.0 §7.11, §11.3; V5 spec §16; V6 Stage 14): the classic screens under More only, never on the
// Swap screen — the pools, a pool (its status, a deposit with the disclosures and the note shown once, a withdrawal with
// the relayer chosen by its fee and status), a deposit recovered from a pasted note, the relayer choice. Driven over
// ClassicPrivacyService (./service.ts) with the devnet's contracts and relayer in this pass; the module's own state is
// the journal's optional `classic` field. It imports nothing of the protected-wallet engine but the session that keeps
// that field (scripts/check-boundaries.mjs rule 8), and nothing outside More's routes imports it.
import { useMemo, useState } from "react";
import { formatNote, generateNote, type ClassicNote } from "@privacy-wallet/protocol/classic/note";
import { Button, Card, Collapsible, Field, Input, Page, StatusBadge } from "@privacy-wallet/ui";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { config } from "@privacy-wallet/sdk/config";
import { useT } from "../../app/i18n/useT";
import type { MessageKey } from "../../app/i18n/en";
import { useSession, useSettings } from "../../hooks";
import { devnetContracts, noClassicContracts, type ClassicDepositRecord, type ClassicWithdrawal } from "./contracts";
import { DEVNET_RELAYERS } from "./relayer";
import { ClassicPrivacyService, type ClassicJournal, type RecoverResult } from "./service";
import { ClassicHomeView, ClassicPoolActions, ClassicPoolStatusView, ClassicRecoverView, ClassicRelayersView, type ClassicRecoverModel } from "./View";

/** The disclosures before every classic deposit (V5 spec §16). */
export const CLASSIC_DISCLOSURE_KEYS = [
  "classic.disclosure.fixed",
  "classic.disclosure.note",
  "classic.disclosure.public",
  "classic.disclosure.fee",
  "classic.disclosure.separate",
] as const;

const EMPTY: ClassicDepositRecord[] = [];
/** The classic deposits of the unlocked journal (the optional `classic` field; never written by emptyJournal()). */
export const classicDeposits = (): ClassicDepositRecord[] => (session.isUnlocked() ? (session.journal().classic?.deposits ?? EMPTY) : EMPTY);
/** The relayer the user chose (the journal's `classic.relayer`), else the devnet's. */
export const chosenRelayer = (): string => (session.isUnlocked() ? (session.journal().classic?.relayer ?? DEVNET_RELAYERS[0].id) : DEVNET_RELAYERS[0].id);
function chooseRelayer(id: string): void {
  session.update((j) => {
    j.classic = { deposits: j.classic?.deposits ?? [], relayer: id };
  });
}

const sessionJournal: ClassicJournal = {
  deposits: classicDeposits,
  put: (rec) =>
    session.update((j) => {
      j.classic = { ...(j.classic ?? {}), deposits: [...(j.classic?.deposits ?? []), rec] };
    }),
};
/** The devnet mock runs in a development build only: a production build has no classic pool and no relayer to offer. */
export const classicAvailable = (): boolean => !config().production;
/** The service the screens use: the devnet's contracts and relayer (none in a production build), the session's journal. */
export const classicService = (): ClassicPrivacyService =>
  classicAvailable()
    ? new ClassicPrivacyService(devnetContracts, sessionJournal, () => DEVNET_RELAYERS)
    : new ClassicPrivacyService(noClassicContracts, sessionJournal, () => []);

const randomBytes = (n: number): Uint8Array => {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
};

export function ClassicHome({
  onOpen,
  onRecover,
  onRelayers,
  onBack,
}: {
  onOpen: (poolId: string) => void;
  onRecover: () => void;
  onRelayers: () => void;
  onBack?: () => void;
}) {
  useSession();
  const service = useMemo(classicService, []);
  const pools = service.pools().map((p) => {
    const st = p.stats();
    return { id: p.id, amount: p.denomination, symbol: p.currency.toUpperCase(), size: st.size, deposits: st.deposits, mine: service.mine(p.id).length };
  });
  return <ClassicHomeView model={{ available: pools.length > 0, pools }} actions={{ onOpen, onRecover, onRelayers, onBack }} />;
}

export function ClassicPoolScreen({ poolId, onBack, onRelayers }: { poolId: string; onBack: () => void; onRelayers?: () => void }) {
  const t = useT();
  const { advanced } = useSettings();
  useSession();
  const service = useMemo(classicService, []);
  const pool = service.contracts.pool(poolId);
  const [mode, setMode] = useState<"pool" | "deposit" | "withdraw">("pool");
  const [agreed, setAgreed] = useState(false);
  const [note, setNote] = useState<ClassicNote | null>(null);
  const [saved, setSaved] = useState(false);
  const [deposited, setDeposited] = useState<ClassicDepositRecord | null>(null);
  const [noteText, setNoteText] = useState("");
  const [recipient, setRecipient] = useState("");
  const [withdrawal, setWithdrawal] = useState<ClassicWithdrawal | null>(null);
  const [error, setError] = useState("");
  if (!pool)
    return (
      <Page title={t("route.classic")} back={onBack} testId="classic-pool">
        <Card>
          <p className="ds-note">{t("classic.noPool")}</p>
        </Card>
      </Page>
    );
  const status = service.poolStatus(pool.id)!;
  const symbol = pool.currency.toUpperCase();
  const mine = service.mine(pool.id);
  const adv = pool.advanced();
  const relayer = service.relayers().find((r) => r.id === chosenRelayer()) ?? service.relayers()[0];

  function startDeposit() {
    setNote(generateNote(pool!.currency, pool!.denomination, pool!.netId, randomBytes));
    setSaved(false);
    setDeposited(null);
    setAgreed(false);
    setMode("deposit");
  }
  function confirmDeposit() {
    if (!note || !saved) return;
    setDeposited(service.deposit(pool!.id, note));
  }
  function prepare() {
    setError("");
    const r = service.prepareWithdrawal(noteText, recipient, relayer.id, pool!.id);
    if (!r.ok) {
      setError(r.reason === "bad-recipient" ? t("classic.withdraw.badRecipient") : r.detail);
      return;
    }
    setWithdrawal(r.withdrawal);
  }

  return (
    <Page title={t("classic.poolTitle", { amount: pool.denomination, symbol })} back={mode === "pool" ? onBack : () => setMode("pool")} testId="classic-pool">
      <div className="ds-stack" data-mode={mode}>
        {mode === "pool" ? (
          <>
            <Card testId="classic-position">
              <div className="ds-stack-sm">
                <ClassicPoolStatusView
                  model={{
                    size: status.size,
                    deposits: status.deposits,
                    rootAgeSeconds: status.rootAge,
                    health: status.health,
                    relayer: relayer.name,
                    relayerFeePercent: relayer.feePercent,
                    mine: mine.length ? `${mine.length} × ${pool.denomination} ${symbol}` : null,
                  }}
                />
                <ClassicPoolActions
                  onDeposit={startDeposit}
                  onWithdraw={() => {
                    setMode("withdraw");
                    setWithdrawal(null);
                    setError("");
                  }}
                />
              </div>
            </Card>
            {advanced ? (
              <Collapsible summary={t("protect.technical")} testId="classic-advanced">
                <div className="ds-stack-sm ds-note">
                  <div className="ds-kv">
                    <span className="ds-kv-label">{t("classic.adv.root")}</span>
                    <code className="ds-mono-break">{adv.root}</code>
                  </div>
                  <div className="ds-kv">
                    <span className="ds-kv-label">{t("classic.adv.rootAge")}</span>
                    <b>{t("classic.adv.seconds", { n: adv.rootAge })}</b>
                  </div>
                  <div className="ds-kv">
                    <span className="ds-kv-label">{t("classic.adv.relayerFee")}</span>
                    <b>{`${adv.relayerFeeBps / 100} %`}</b>
                  </div>
                  <div className="ds-kv">
                    <span className="ds-kv-label">{t("classic.adv.proofStatus")}</span>
                    <b data-testid="classic-proof-status">{adv.proofStatus}</b>
                  </div>
                  {mine.map((d) => (
                    <div key={d.id} className="ds-kv" data-testid="classic-commitment">
                      <span className="ds-kv-label">{t("classic.adv.commitment", { leaf: d.leafIndex })}</span>
                      <code className="ds-mono-break">{d.commitment}</code>
                    </div>
                  ))}
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
                  <ul className="ds-plain-list ds-note" data-testid="classic-disclosures">
                    {CLASSIC_DISCLOSURE_KEYS.map((k) => (
                      <li key={k}>{t(k as MessageKey)}</li>
                    ))}
                  </ul>
                  <label className="ds-switch-row ds-native-row">
                    <span>{t("classic.deposit.agree")}</span>
                    <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} data-testid="classic-agree" />
                  </label>
                  {agreed ? (
                    <>
                      <p className="ds-note-warn">{t("classic.deposit.noteOnce")}</p>
                      <code className="ds-mono-break" data-testid="classic-note">
                        {formatNote(note)}
                      </code>
                      <div className="ds-actions">
                        <Button variant="secondary" icon="copy" onClick={() => void navigator.clipboard?.writeText(formatNote(note))}>
                          {t("receive.copy")}
                        </Button>
                      </div>
                      <label className="ds-switch-row ds-native-row">
                        <span>{t("classic.deposit.saved")}</span>
                        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} data-testid="classic-saved" />
                      </label>
                    </>
                  ) : null}
                  <Button size="lg" full disabled={!agreed || !saved} onClick={confirmDeposit} data-testid="classic-deposit-confirm">
                    {t("classic.deposit.confirm", { amount: pool.denomination, symbol })}
                  </Button>
                </>
              ) : (
                <>
                  <h2 className="ds-review-title" data-testid="classic-deposited">
                    {t("classic.deposit.done", { amount: pool.denomination, symbol, leaf: deposited.leafIndex })}
                  </h2>
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
              <Field label={t("classic.withdraw.note")} htmlFor="classic-note-input">
                <Input
                  id="classic-note-input"
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  placeholder="tornado-eth-1-31337-0x…"
                  autoComplete="off"
                  spellCheck={false}
                  data-testid="classic-note-input"
                />
              </Field>
              <Field label={t("classic.withdraw.recipient")} htmlFor="classic-recipient">
                <Input
                  id="classic-recipient"
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  placeholder="0x…"
                  autoComplete="off"
                  spellCheck={false}
                  data-testid="classic-recipient"
                />
              </Field>
              <div className="ds-kv" data-testid="classic-withdraw-relayer">
                <span className="ds-kv-label">{t("classic.adv.relayer")}</span>
                <span>
                  <b>{t("classic.relayers.line", { name: relayer.name, fee: relayer.feePercent })}</b>{" "}
                  {onRelayers ? (
                    <button type="button" className="ds-chip" onClick={onRelayers} data-testid="classic-change-relayer">
                      {t("classic.relayers.change")}
                    </button>
                  ) : null}
                </span>
              </div>
              {error ? (
                <p className="ds-field-error" data-testid="classic-error">
                  {error}
                </p>
              ) : null}
              <Button size="lg" full onClick={prepare} data-testid="classic-prepare">
                {t("classic.withdraw.prepare")}
              </Button>
              {withdrawal ? (
                <div className="ds-review-block" data-testid="classic-withdrawal" data-status={withdrawal.status}>
                  <div className="ds-kv">
                    <span className="ds-kv-label">{t("classic.withdraw.recipient")}</span>
                    <code className="ds-mono-break">{withdrawal.recipient}</code>
                  </div>
                  <div className="ds-kv">
                    <span className="ds-kv-label">{t("classic.adv.relayer")}</span>
                    <b>{withdrawal.relayer}</b>
                  </div>
                  <div className="ds-kv">
                    <span className="ds-kv-label">{t("classic.adv.relayerFee")}</span>
                    <b>{withdrawal.fee}</b>
                  </div>
                  <div className="ds-kv">
                    <span className="ds-kv-label">{t("classic.adv.proofStatus")}</span>
                    <StatusBadge tone="pending" testId="classic-proof-pending">
                      {adv.proofStatus}
                    </StatusBadge>
                  </div>
                </div>
              ) : null}
            </div>
          </Card>
        ) : null}
      </div>
    </Page>
  );
}

/** The recover screen's model from the service's answer. */
export function recoverModel(noteText: string, r: RecoverResult | null): ClassicRecoverModel {
  if (!r) return { noteText, result: null };
  if (!r.ok) return { noteText, result: { ok: false, detail: r.detail } };
  return {
    noteText,
    result: {
      ok: true,
      pool: `${r.pool.denomination} ${r.pool.currency.toUpperCase()}`,
      status: r.status,
      leaf: r.onChain?.leafIndex ?? null,
      journaled: r.journaled,
    },
  };
}

export function ClassicRecoverScreen({ onBack, onWithdraw }: { onBack?: () => void; onWithdraw?: (poolId: string) => void }) {
  useSession();
  const service = useMemo(classicService, []);
  const [noteText, setNoteText] = useState("");
  const [result, setResult] = useState<RecoverResult | null>(null);
  return (
    <ClassicRecoverView
      model={recoverModel(noteText, result)}
      actions={{
        onNote: (v) => {
          setNoteText(v);
          setResult(null);
        },
        onFind: () => setResult(service.recover(noteText)),
        ...(onWithdraw && result?.ok ? { onWithdraw: () => onWithdraw(result.pool.id) } : {}),
        onBack,
      }}
    />
  );
}

export function ClassicRelayersScreen({ onBack }: { onBack?: () => void }) {
  useSession();
  const service = useMemo(classicService, []);
  return <ClassicRelayersView relayers={[...service.relayers()]} chosen={chosenRelayer()} actions={{ onChoose: chooseRelayer, onBack }} />;
}
