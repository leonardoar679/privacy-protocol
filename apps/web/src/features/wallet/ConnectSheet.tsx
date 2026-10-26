// The connector picker (spec v3.0 §2; doc §3: "Connect wallet" in the header): a sheet listing the wallets this browser
// announced (EIP-6963), the injected wallet as the fallback, WalletConnect when the build configures it. Connecting
// remembers the connector (`prefs.lastConnector`) so the next launch reconnects without a prompt; once connected the
// sheet shows the account, the connection and the connector, Switch network when the network is wrong, Disconnect
// (which forgets the connector). Connecting never creates, unlocks or exposes the protected wallet (spec v2.0 §1): the
// public wallet pays deposits and signs nothing else.
import { BottomSheet, Button, Icon, ListRow, StatusBadge, type StatusTone } from "@privacy-wallet/ui";
import { connection, shortAccount, type ConnectionStatus, type ConnectorInfo } from "@privacy-wallet/wallet-engine/connection";
import { useT } from "../../app/i18n/useT";
import type { MessageKey } from "../../app/i18n/en";
import { useConnection } from "../../hooks/core";
import { prefs } from "../../storage/prefs";

const TONE: Record<ConnectionStatus, StatusTone> = {
  connected: "ok",
  connecting: "pending",
  "wrong-network": "warn",
  disconnected: "neutral",
  unavailable: "neutral",
};
const KIND: Record<ConnectorInfo["kind"], MessageKey> = {
  eip6963: "wallet.sheet.kind.eip6963",
  injected: "wallet.sheet.kind.injected",
  walletconnect: "wallet.sheet.kind.walletconnect",
};

/** Connects the chosen connector; a connection that holds (connected, or on the wrong network) is remembered. */
export async function connectWith(id: string): Promise<boolean> {
  const s = await connection.connect(id);
  const held = s.status === "connected" || s.status === "wrong-network";
  if (held) prefs().update({ lastConnector: id });
  return held;
}

/** Disconnects and forgets the connector: the next launch asks again. */
export function disconnectWallet(): void {
  connection.disconnect();
  prefs().update({ lastConnector: undefined });
}

export function ConnectSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const conn = useConnection();
  const connected = conn.account !== null;
  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={t(connected ? "wallet.sheet.connectedTitle" : "wallet.sheet.title")}
      description={t("wallet.connectionNote")}
      testId="connect-sheet"
      id="connect"
    >
      {connected ? (
        <div className="ds-stack-sm">
          <div className="ds-kv">
            <span className="ds-kv-label">{t("wallet.account")}</span>
            <b className="ds-kv-value" data-testid="connect-account">
              {shortAccount(conn.account!)}
            </b>
          </div>
          <div className="ds-kv">
            <span className="ds-kv-label">{t("wallet.connection")}</span>
            <StatusBadge tone={TONE[conn.status]} testId="connect-status">
              {t(`wallet.status.${conn.status}` as MessageKey)}
            </StatusBadge>
          </div>
          {conn.connector ? (
            <div className="ds-kv">
              <span className="ds-kv-label">{t("wallet.sheet.via")}</span>
              <b className="ds-kv-value">{conn.connector.name}</b>
            </div>
          ) : null}
          <div className="ds-actions">
            {conn.status === "wrong-network" ? (
              <Button onClick={() => void connection.switchNetwork()} data-testid="connect-switch">
                {t("wallet.switch")}
              </Button>
            ) : null}
            <Button
              variant="secondary"
              onClick={() => {
                disconnectWallet();
                onClose();
              }}
              data-testid="connect-disconnect"
            >
              {t("wallet.disconnect")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="ds-stack-sm">
          {conn.connectors.length === 0 ? (
            <p className="ds-note" data-testid="connect-none">
              {t("wallet.sheet.none")}
            </p>
          ) : null}
          {conn.connectors.map((c) => (
            <ListRow
              key={c.id}
              title={c.name}
              subtitle={t(KIND[c.kind])}
              leading={c.icon ? <img className="ds-connector-icon" src={c.icon} alt="" width={24} height={24} /> : <Icon name="wallet" />}
              onPress={() => {
                void connectWith(c.id).then((held) => {
                  if (held) onClose();
                });
              }}
              testId={`connector-${c.id}`}
            />
          ))}
          {conn.status === "connecting" ? (
            <p className="ds-note" role="status" data-testid="connect-connecting">
              {t("wallet.status.connecting")}
            </p>
          ) : null}
          {conn.error ? (
            <p className="ds-field-error" role="alert" data-testid="connect-error">
              {conn.error}
            </p>
          ) : null}
        </div>
      )}
    </BottomSheet>
  );
}
