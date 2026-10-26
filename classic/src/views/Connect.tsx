// The wallet chooser (spec v3.0 §7.5): the wallets this page can see, one to connect, the wallet's refusal, the wrong
// network; the header's chip reads the connected account short. Pure.
import { t } from "../app/i18n/messages";
import { shortHash } from "../model/format";
import type { ConnectionState } from "../model/types";
import { Button, Modal, Notice } from "./ui";

export interface WalletChoice {
  id: string;
  name: string;
  icon?: string;
}

export function walletLabel(state: ConnectionState, enabled: boolean): string {
  if (!enabled) return t("wallet.notConnected");
  if (state.status === "disconnected") return t("wallet.connect");
  return shortHash(state.account, 6, 4);
}

export function ConnectModal(props: {
  open: boolean;
  wallets: WalletChoice[];
  state: ConnectionState;
  connecting: boolean;
  error: string | null;
  onChoose: (id: string) => void;
  onDisconnect: () => void;
  onClose: () => void;
}) {
  return (
    <Modal open={props.open} title={t("wallet.choose")} onClose={props.onClose} testId="classic-connect-modal">
      {props.state.status !== "disconnected" ? (
        <div className="tc-lines" data-testid="classic-connect-current">
          <p className="tc-text tc-mono">{shortHash(props.state.account, 8, 6)}</p>
          {props.state.status === "wrong-network" ? (
            <Notice tone="warn" role="alert" testId="classic-wrong-network">
              {t("wallet.wrongNetwork")}
            </Notice>
          ) : null}
          <Button testId="classic-disconnect" onClick={props.onDisconnect}>
            {t("wallet.disconnect")}
          </Button>
        </div>
      ) : props.wallets.length ? (
        <ul className="tc-plain-list" data-testid="classic-wallets">
          {props.wallets.map((w) => (
            <li key={w.id}>
              <Button full testId={`classic-wallet-${w.id}`} disabled={props.connecting} onClick={() => props.onChoose(w.id)}>
                {props.connecting ? t("wallet.connecting") : w.name}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="tc-text tc-muted" data-testid="classic-wallets-none">
          {t("wallet.none")}
        </p>
      )}
      {props.error ? (
        <Notice tone="danger" role="alert" testId="classic-connect-error">
          {props.error}
        </Notice>
      ) : null}
    </Modal>
  );
}
