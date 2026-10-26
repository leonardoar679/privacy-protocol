// The Deposit tab (the original's Deposit.vue) and the note modal (DepositModalBox.vue), spec v3.0 §7.6, §7.9: the
// token, the four amounts as a stepped selector, the Deposit button; then "Your private note" — the note shown once with
// its two warnings, Copy, Save as a file, "I backed up the note" gating "Send Deposit". While the pool's deposit is not
// live the sending button reads "Not connected" and nothing is sent.
import { t } from "../app/i18n/messages";
import { POOLS, type Pool, type PoolId } from "../model/pools";
import { Button, Card, Checkbox, Field, Modal, Notice } from "./ui";

export function DepositTab(props: { pool: PoolId; onPool: (p: PoolId) => void; onDeposit: () => void }) {
  return (
    <Card testId="classic-deposit">
      <Field label={t("deposit.token")} htmlFor="classic-token">
        <select id="classic-token" className="tc-input" data-testid="classic-token" defaultValue="eth">
          <option value="eth">ETH</option>
        </select>
      </Field>
      <Field label={t("deposit.amount")} info={t("deposit.amountTooltip")} infoLabel={t("deposit.info")}>
        <div className="tc-steps" role="radiogroup" aria-label={t("deposit.amount")} data-testid="classic-amounts">
          <span className="tc-steps-line" aria-hidden="true" />
          {POOLS.map((p: Pool) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={props.pool === p.id}
              className={`tc-step${props.pool === p.id ? " tc-step-active" : ""}`}
              data-testid={`classic-amount-${p.amount}`}
              onClick={() => props.onPool(p.id)}
            >
              <span className="tc-step-dot" aria-hidden="true" />
              <span className="tc-step-label">{p.amount} ETH</span>
            </button>
          ))}
        </div>
      </Field>
      <Button variant="primary" full large testId="classic-deposit-button" onClick={props.onDeposit}>
        {t("deposit.button")}
      </Button>
    </Card>
  );
}

export function NoteModal(props: {
  open: boolean;
  note: string;
  fileName: string;
  backedUp: boolean;
  onBackedUp: (v: boolean) => void;
  copied: boolean;
  onCopy: () => void;
  onSave: () => void;
  live: boolean;
  onSend: () => void;
  onClose: () => void;
}) {
  return (
    <Modal open={props.open} title={t("note.title")} onClose={props.onClose} testId="classic-note-modal">
      <p className="tc-text">{t("note.backup")}</p>
      <p className="tc-text">{t("note.treat")}</p>
      <div className="tc-note-box" data-testid="classic-note">
        <code className="tc-note-text">{props.note}</code>
      </div>
      <div className="tc-actions">
        <Button testId="classic-note-copy" onClick={props.onCopy}>
          {props.copied ? t("note.copied") : t("note.copy")}
        </Button>
        <Button testId="classic-note-save" onClick={props.onSave}>
          {t("note.save")}
        </Button>
      </div>
      <p className="tc-text tc-muted" data-testid="classic-note-file">
        {t("note.saveAsFile")} <span className="tc-mono">{props.fileName}</span>
      </p>
      <Checkbox id="classic-note-backed" checked={props.backedUp} onChange={props.onBackedUp} label={t("note.backedUp")} testId="classic-note-backed" />
      {props.backedUp ? (
        <Notice tone="warn" testId="classic-note-warning">
          {t("note.wontBeSaved")}
        </Notice>
      ) : null}
      {props.live ? (
        <Button variant="primary" full large testId="classic-note-send" disabled={!props.backedUp} onClick={props.onSend}>
          {t("note.send")}
        </Button>
      ) : (
        <Button variant="primary" full large testId="classic-note-send" disabled>
          {t("wallet.notConnected")}
        </Button>
      )}
    </Modal>
  );
}
