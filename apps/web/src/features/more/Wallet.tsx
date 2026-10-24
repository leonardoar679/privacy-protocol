// More → Wallet (spec §2, §7; plan §11, §50; High-Value Protection spec §13): the connected public wallet and its
// network (connect, switch, disconnect — through its own provider), the trade preference (how swaps choose their
// route and when they are funded; saved here only, never on chain), and the token allowances of the connected wallet
// toward the vaults, read and revoked through that wallet's own provider — never this wallet's endpoints.
import { useState } from "react";
import { Button, Card, Page, StatusBadge, TextButton } from "@privacy-wallet/ui";
import { useT } from "../../app/i18n/useT";
import type { MessageKey } from "../../app/i18n/en";
import { allowancesFor, revokeAllowance, type AllowanceLine } from "@privacy-wallet/sdk/allowances";
import { classify, reasonKey } from "@privacy-wallet/sdk/operations/errors/catalog";
import { formatAmount } from "@privacy-wallet/sdk/assets";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import { DELAY_WINDOW, policyFromPreference, PREFERENCE_LABELS, windowLabel } from "@privacy-wallet/sdk/policy";
import { PREFERENCES, settings, type Preference } from "@privacy-wallet/sdk/wallet/settings";
import { connection, shortAccount } from "@privacy-wallet/wallet-engine/connection";
import { useConnection, useSettings } from "../../hooks";

export function Wallet({ deployment, onBack }: { deployment: Deployment | null; onBack?: () => void }) {
  const t = useT();
  const s = useSettings();
  const conn = useConnection();
  // the allowances are the account's they were read for (audit round 2, n53): after an account switch the list had stayed,
  // and its Revoke sent approve(0) from whichever account the wallet had then — or again, for one already revoked
  const [allowances, setAllowances] = useState<{ account: string; lines: AllowanceLine[] } | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [status, setStatus] = useState("");
  const shown = allowances && conn.account && allowances.account.toLowerCase() === conn.account.toLowerCase() ? allowances.lines : null;
  async function readAllowances() {
    if (!conn.account) { setStatus(t("wallet.connectFirst")); return; }
    // a V6 follow-up of 2026-10-16: on another network the allowances read would be that chain's, not this deployment's
    if (conn.status === "wrong-network") { setStatus(t("wallet.switchFirst")); return; }
    setStatus(t("wallet.reading"));
    const account = conn.account;
    try { setAllowances({ account, lines: await allowancesFor(deployment, account as `0x${string}`) }); setStatus(""); } catch (e) { setStatus(e instanceof Error ? e.message : String(e)); }
  }
  async function revoke(line: AllowanceLine) {
    if (!deployment || !allowances || revoking) return;
    setRevoking(true);
    try {
      const tx = await revokeAllowance(line.asset.token as `0x${string}`, line.spender, deployment.chainId, allowances.account as `0x${string}`);
      // sent: nothing is left to revoke on this line
      setAllowances((a) => a && { ...a, lines: a.lines.map((l) => (l === line ? { ...l, allowance: 0n } : l)) });
      setStatus(t("wallet.revoked", { hash: `${tx.slice(0, 10)}…` }));
    } catch (e) {
      const c = classify(e);
      setStatus(c.code === "unknown" ? c.detail : t(reasonKey(c.code) as MessageKey));
    } finally {
      setRevoking(false);
    }
  }
  const tone = conn.status === "connected" ? "ok" : conn.status === "wrong-network" ? "warn" : conn.status === "connecting" ? "pending" : "neutral";
  return (
    <Page title={t("route.wallet")} back={onBack} testId="wallet-screen">
      <div className="ds-stack">
        <Card testId="connection">
          <div className="ds-stack-sm">
            <div className="ds-kv"><span className="ds-kv-label">{t("wallet.connection")}</span><StatusBadge tone={tone} testId="connection-status">{t(`wallet.status.${conn.status}` as MessageKey)}</StatusBadge></div>
            {conn.account ? <div className="ds-kv"><span className="ds-kv-label">{t("wallet.account")}</span><b className="ds-kv-value">{shortAccount(conn.account)}</b></div> : null}
            <div className="ds-kv"><span className="ds-kv-label">{t("wallet.network")}</span><b className="ds-kv-value">{deployment ? t("wallet.chain", { id: deployment.chainId }) : t("wallet.noDeployment")}</b></div>
            <div className="ds-actions">
              {!conn.account ? <Button onClick={() => void connection.connect()} loading={conn.status === "connecting"} data-testid="wallet-connect">{t("protect.connect")}</Button> : null}
              {conn.status === "wrong-network" ? <Button onClick={() => void connection.switchNetwork()} data-testid="wallet-switch">{t("wallet.switch")}</Button> : null}
              {conn.account ? <Button variant="secondary" onClick={() => void connection.disconnect()} data-testid="wallet-disconnect">{t("wallet.disconnect")}</Button> : null}
            </div>
            <p className="ds-note">{t("wallet.connectionNote")}</p>
          </div>
        </Card>

        <Card testId="trade-preference">
          <div className="ds-stack-sm">
            <h2 className="ds-review-title">{t("wallet.preference.title")}</h2>
            <p className="ds-note">{t("wallet.preference.body")}</p>
            {PREFERENCES.map((pref: Preference) => (
              <label key={pref} className="ds-radio-row" data-testid={`preference-${pref}`}>
                <input type="radio" name="preference" className="ds-radio" checked={s.preference === pref} onChange={() => settings.set({ preference: pref })} />
                <span className="ds-radio-text"><b>{PREFERENCE_LABELS[pref].label}</b> <span className="ds-note">· {t("wallet.preference.fundedWithin", { window: windowLabel(DELAY_WINDOW[policyFromPreference(pref)]) })}</span><span className="ds-radio-desc">{PREFERENCE_LABELS[pref].help}</span></span>
              </label>
            ))}
          </div>
        </Card>

        <Card testId="allowances">
          <div className="ds-stack-sm">
            <h2 className="ds-review-title">{t("wallet.allowances.title")}</h2>
            <p className="ds-note">{t("wallet.allowances.body")}</p>
            <div className="ds-actions"><Button variant="secondary" onClick={() => void readAllowances()} data-testid="read-allowances">{t("wallet.allowances.read")}</Button></div>
            {shown?.map((l) => (
              <div key={`${l.asset.symbol}:${l.via}`} className="ds-kv" data-testid="allowance-line" data-asset={l.asset.symbol} data-via={l.via}>
                <span className="ds-kv-label">{t(l.via === "router" ? "wallet.allowances.router" : "wallet.allowances.line", { symbol: l.asset.symbol })}</span>
                <b className="ds-kv-value">{l.allowance === null ? t("wallet.allowances.unreadable") : `${formatAmount(l.asset, l.allowance)} ${l.asset.symbol}`}{l.allowance !== null && l.allowance > 0n ? <TextButton onClick={() => void revoke(l)} data-testid="revoke-allowance">{t("wallet.allowances.revoke")}</TextButton> : null}</b>
              </div>
            ))}
            {shown && shown.length === 0 ? <p className="ds-note">{t("wallet.allowances.none")}</p> : null}
            {status ? <p className="ds-note" data-testid="allowance-status">{status}</p> : null}
          </div>
        </Card>
      </div>
    </Page>
  );
}
