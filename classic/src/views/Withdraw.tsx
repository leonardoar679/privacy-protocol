// The Withdraw tab (the original's Withdraw.vue, RelayerTotal.vue, WithdrawTotal.vue, WithdrawModalBox.vue), spec v3.0
// §7.4–§7.5, §7.9: the note, the deposit's facts with the two warnings (under 24 hours, under 5 subsequent deposits),
// the recipient with Donate, the withdrawal settings (Relayer | Wallet, the relayer list, the wallet warning), the
// current relayer, the totals at the live gas price, the Withdraw button, "Generating proof", the confirmation.
import { depositsCount, passedWords, t } from "../app/i18n/messages";
import { fromWei, toGwei } from "../model/format";
import { poolOf, type Pool } from "../model/pools";
import { notEnoughDeposits, notEnoughTime, timePassed } from "../model/time";
import type { FeeLines, NoteLookup, RelayerInfo, WithdrawMode } from "../model/types";
import { Button, Card, Field, Input, Modal, Notice, Row } from "./ui";

export type NoteError = "invalid" | "spent" | "no-deposit" | "other-network" | "unknown-pool";

export function noteError(lookup: NoteLookup | null, malformed: boolean): NoteError | null {
  if (malformed) return "invalid";
  if (!lookup) return null;
  if (lookup.kind === "found") return lookup.facts.spent ? "spent" : null;
  return lookup.kind;
}

const ERROR_KEY = {
  invalid: "error.noteInvalid",
  spent: "error.noteSpent",
  "no-deposit": "error.noDeposit",
  "other-network": "error.otherNetwork",
  "unknown-pool": "error.unknownPool",
} as const;

export interface WithdrawProps {
  text: string;
  onText: (v: string) => void;
  checking: boolean;
  lookup: NoteLookup | null;
  malformed: boolean;
  now: number;
  recipient: string;
  onRecipient: (v: string) => void;
  recipientInvalid: boolean;
  /** a well-formed address a withdrawal must not go to (the fourth review round, 2026-11-03) */
  recipientRefused?: "zero" | "burn" | "protocol" | null;
  /** whether the build names a donation address (the original's "Donate" fills the recipient with it) */
  donate: boolean;
  onDonate: () => void;
  mode: WithdrawMode;
  onMode: (m: WithdrawMode) => void;
  relayers: RelayerInfo[];
  relayerId: string | null;
  onRelayer: (id: string) => void;
  settingsOpen: boolean;
  onToggleSettings: () => void;
  fees: FeeLines | null;
  canWithdraw: boolean;
  live: boolean;
  onWithdraw: () => void;
  proving: boolean;
  confirmOpen: boolean;
  onConfirm: () => void;
  onCancelConfirm: () => void;
  submitted: boolean;
  /** the explicit on-chain read of isSpent (spec §7.4): offered when the chain can be asked; its answer; the disclosure stands beside it */
  onCheckSpent?: () => void;
  spentOnChain?: "spent" | "unspent" | "checking" | null;
  /** the history's state when a withdrawal has to wait for it */
  historyNotice?: string | null;
  /** what the flow last said: a refusal, a failure, the relayer's state */
  flowMessage?: string | null;
}

export function WithdrawTab(p: WithdrawProps) {
  const error = noteError(p.lookup, p.malformed);
  const found = p.lookup?.kind === "found" ? p.lookup : null;
  const pool: Pool | null = found ? poolOf(found.pool) : null;
  const relayer = p.relayers.find((r) => r.id === p.relayerId) ?? null;
  const facts = found?.facts ?? null;
  const lowTime = facts ? notEnoughTime(facts.timestamp, p.now) : false;
  const lowDeposits = facts ? notEnoughDeposits(facts.depositsSince) : false;
  return (
    <Card testId="classic-withdraw">
      <Field
        label={t("withdraw.note")}
        htmlFor="classic-note-input"
        info={t("withdraw.noteTooltip")}
        infoLabel={t("withdraw.noteInfo")}
        trailing={
          found && !error ? (
            <button
              type="button"
              className="tc-icon-btn"
              aria-label={t("withdraw.settings")}
              aria-expanded={p.settingsOpen}
              aria-controls="classic-withdraw-settings"
              data-testid="classic-settings-toggle"
              onClick={p.onToggleSettings}
            >
              <span aria-hidden="true">⚙</span>
            </button>
          ) : null
        }
      >
        <Input
          id="classic-note-input"
          value={p.text}
          onChange={p.onText}
          placeholder={t("withdraw.placeholder")}
          invalid={!!error}
          testId="classic-note-input"
          describedBy={error ? "classic-note-error" : undefined}
          mono
        />
        {p.checking ? (
          <p className="tc-help tc-muted" role="status" data-testid="classic-note-checking">
            {t("withdraw.checking")}
          </p>
        ) : null}
        {error ? (
          <p className="tc-help tc-error" id="classic-note-error" role="alert" data-testid="classic-note-error">
            {t(ERROR_KEY[error])}
          </p>
        ) : null}
      </Field>
      {found && facts && pool && !error ? (
        <div className="tc-facts" data-testid="classic-note-facts">
          <Row label={t("withdraw.amount")} value={`${pool.amount} ETH`} testId="classic-fact-amount" />
          <Row label={t("withdraw.timePassed")} value={passedWords(timePassed(facts.timestamp, p.now))} testId="classic-fact-time" warn={lowTime} />
          <Row label={t("withdraw.subsequent")} value={depositsCount(facts.depositsSince)} testId="classic-fact-deposits" warn={lowDeposits} />
          {lowTime ? (
            <p className="tc-help tc-warn-text" data-testid="classic-warn-time">
              {t("withdraw.timePassedTooltip")}
            </p>
          ) : null}
          {lowDeposits ? (
            <p className="tc-help tc-warn-text" data-testid="classic-warn-deposits">
              {t("withdraw.subsequentTooltip")}
            </p>
          ) : null}
        </div>
      ) : null}
      <Field
        label={t("withdraw.recipient")}
        htmlFor="classic-recipient"
        trailing={
          p.donate ? (
            <button type="button" className="tc-text-btn" data-testid="classic-donate" onClick={p.onDonate}>
              {t("withdraw.donate")}
            </button>
          ) : null
        }
      >
        <Input
          id="classic-recipient"
          value={p.recipient}
          onChange={p.onRecipient}
          placeholder={t("withdraw.recipientPlaceholder")}
          invalid={p.recipientInvalid || !!p.recipientRefused}
          testId="classic-recipient"
          describedBy={p.recipientInvalid || p.recipientRefused ? "classic-recipient-error" : undefined}
          mono
        />
        {p.recipientInvalid || p.recipientRefused ? (
          <p className="tc-help tc-error" id="classic-recipient-error" role="alert" data-testid="classic-recipient-error">
            {p.recipientRefused ? t(`withdraw.recipientRefused.${p.recipientRefused}` as "withdraw.recipientRefused.zero") : t("withdraw.recipientInvalid")}
          </p>
        ) : null}
      </Field>
      {p.settingsOpen && found && !error ? (
        <div className="tc-settings" id="classic-withdraw-settings" data-testid="classic-withdraw-settings">
          <div className="tc-segmented" role="radiogroup" aria-label={t("withdraw.settings")}>
            {(["relayer", "wallet"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={p.mode === m}
                className={`tc-segment${p.mode === m ? " tc-segment-active" : ""}`}
                data-testid={`classic-mode-${m}`}
                onClick={() => p.onMode(m)}
              >
                {t(m === "relayer" ? "withdraw.relayer" : "withdraw.wallet")}
              </button>
            ))}
          </div>
          <p className="tc-help tc-muted">{t(p.mode === "relayer" ? "withdraw.relayerTooltip" : "withdraw.walletTooltip")}</p>
          {p.mode === "relayer" ? (
            <div className="tc-relayers" role="radiogroup" aria-label={t("withdraw.chooseRelayer")} data-testid="classic-relayer-list">
              {p.relayers.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  role="radio"
                  aria-checked={p.relayerId === r.id}
                  className={`tc-relayer${p.relayerId === r.id ? " tc-relayer-active" : ""}`}
                  data-testid={`classic-relayer-${r.id}`}
                  disabled={r.status !== "online"}
                  onClick={() => p.onRelayer(r.id)}
                >
                  <span className="tc-relayer-name">{r.name}</span>
                  <span className="tc-relayer-meta">
                    {percentOf(r.feePercentE4)} % ·{" "}
                    {t(r.status === "online" ? "relayer.online" : r.status === "offline" ? "relayer.offline" : "relayer.unknown")}
                  </span>
                </button>
              ))}
              <p className="tc-help tc-muted" data-testid="classic-ip-notice">
                {t("withdraw.ipNotice")}
              </p>
            </div>
          ) : (
            <Notice tone="warn" testId="classic-wallet-warning">
              {t("withdraw.walletWarning")}
            </Notice>
          )}
        </div>
      ) : null}
      {found && !error && p.mode === "relayer" && relayer ? (
        <div className="tc-lines" data-testid="classic-relayer-total">
          <p className="tc-lines-title">{t("withdraw.currentRelayer")}</p>
          <Row label={t("withdraw.name")} value={relayer.name} testId="classic-relayer-name" />
          <Row label={t("withdraw.fee")} value={`${percentOf(relayer.feePercentE4)} %`} testId="classic-relayer-fee-percent" />
        </div>
      ) : null}
      {found && !error && pool && p.fees ? (
        <div className="tc-lines" data-testid="classic-withdraw-total">
          <p className="tc-lines-title">{t("withdraw.total")}</p>
          <Row label={t("withdraw.noteBalance")} value={`${pool.amount} ETH`} testId="classic-total-balance" />
          {p.mode === "relayer" ? (
            <>
              <Row label={t("withdraw.gasPrice")} value={`${toGwei(p.fees.gasPriceWei)} Gwei`} testId="classic-total-gas" />
              <Row label={t("withdraw.networkFee")} value={`${fromWei(p.fees.networkFeeWei)} ETH`} testId="classic-total-network" />
              <Row label={t("withdraw.relayerFee")} value={`${fromWei(p.fees.relayerFeeWei)} ETH`} testId="classic-total-relayer" />
              <Row label={t("withdraw.totalFee")} value={`${fromWei(p.fees.totalFeeWei)} ETH`} testId="classic-total-fee" />
            </>
          ) : null}
          <Row
            label={t("withdraw.receive")}
            value={`${fromWei(p.mode === "relayer" ? p.fees.receiveWei : pool.denominationWei)} ETH`}
            testId="classic-total-receive"
            strong
          />
          {p.mode === "relayer" && p.fees.receiveWei <= 0n ? (
            <Notice tone="danger" role="alert" testId="classic-not-enough">
              {t("withdraw.notEnough")}
            </Notice>
          ) : null}
        </div>
      ) : null}
      {found && !error && p.onCheckSpent ? (
        <div className="tc-lines" data-testid="classic-check-spent">
          <Button testId="classic-check-spent-button" disabled={p.spentOnChain === "checking"} onClick={p.onCheckSpent}>
            {t("withdraw.checkOnChain")}
          </Button>
          <p className="tc-text tc-muted">{t("withdraw.checkOnChainNotice")}</p>
          {p.spentOnChain === "spent" || p.spentOnChain === "unspent" ? (
            <Notice tone={p.spentOnChain === "spent" ? "danger" : "info"} role="status" testId="classic-spent-on-chain">
              {t(p.spentOnChain === "spent" ? "withdraw.spentOnChain" : "withdraw.unspentOnChain")}
            </Notice>
          ) : null}
        </div>
      ) : null}
      {p.historyNotice ? (
        <Notice tone="warn" role="status" testId="classic-history-notice">
          {p.historyNotice}
        </Notice>
      ) : null}
      {p.flowMessage ? (
        <Notice tone="info" role="status" testId="classic-flow-message">
          {p.flowMessage}
        </Notice>
      ) : null}
      {p.submitted ? (
        <Notice tone="info" testId="classic-withdraw-submitted">
          {t("withdraw.submitted")}
        </Notice>
      ) : null}
      {p.live ? (
        <Button variant="primary" full large testId="classic-withdraw-button" disabled={!p.canWithdraw} busy={p.proving} onClick={p.onWithdraw}>
          {p.proving ? t("withdraw.generating") : t("withdraw.button")}
        </Button>
      ) : (
        <Button variant="primary" full large testId="classic-withdraw-button" disabled>
          {t("wallet.notConnected")}
        </Button>
      )}
      <Modal open={p.confirmOpen} title={t("withdraw.confirmTitle")} onClose={p.onCancelConfirm} testId="classic-confirm-modal">
        <p className="tc-text" data-testid="classic-confirm-text">
          {t("withdraw.proofReady")}
        </p>
        {/* what the proof pays and what arrives, restated where it is confirmed (the seventh review round, 2026-11-03) */}
        {pool && (p.mode === "wallet" || p.fees) ? (
          <div data-testid="classic-confirm-figures">
            {p.mode === "relayer" && p.fees ? (
              <Row label={t("withdraw.totalFee")} value={`${fromWei(p.fees.totalFeeWei)} ETH`} testId="classic-confirm-fee" />
            ) : null}
            <Row
              label={t("withdraw.receive")}
              value={`${fromWei(p.mode === "relayer" && p.fees ? p.fees.receiveWei : pool.denominationWei)} ETH`}
              testId="classic-confirm-receive"
              strong
            />
          </div>
        ) : null}
        <Button variant="primary" full large testId="classic-confirm" onClick={p.onConfirm}>
          {t("withdraw.confirm")}
        </Button>
      </Modal>
    </Card>
  );
}

/** 3,000 → "0.3"; 500 → "0.05" (percent × 10,000, integer). */
export function percentOf(feePercentE4: number): string {
  const whole = Math.floor(feePercentE4 / 10_000);
  const frac = String(feePercentE4 % 10_000)
    .padStart(4, "0")
    .replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}
