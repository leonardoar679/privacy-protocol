// The connector picker (spec v3.0 §2; doc §3: "Connect wallet" in the header): a sheet listing the wallets this browser
// announced (EIP-6963), the injected wallet as the fallback, WalletConnect when the build configures it. Connecting
// remembers the connector (`prefs.lastConnector`) so the next launch reconnects without a prompt; once connected the
// sheet shows the account, the connection and the connector, Switch network when the network is wrong, Disconnect
// (which forgets the connector). Connecting never creates, unlocks or exposes the protected wallet (spec v2.0 §1): the
// public wallet pays deposits and signs nothing else. The eleventh review round, slice 6c: a WalletConnect pairing shows
// here in place of the connectors — its QR code, the link to the wallet app, Cancel (PairingPanel) — and closing the sheet
// over it cancels it; a failure reads in the sheet's words, the wallet's own text after them under Advanced only.
import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { BottomSheet, Button, Icon, ListRow, StatusBadge, type StatusTone } from "@privacy-wallet/ui";
import { connection, shortAccount, type ConnectionStatus, type ConnectorInfo } from "@privacy-wallet/wallet-engine/connection";
import { useT } from "../../app/i18n/useT";
import type { MessageKey } from "../../app/i18n/en";
import { useConnection, usePrefs } from "../../hooks/core";
import { connectWith, disconnectWallet } from "./connect";
import { connectErrorWords } from "./connectWords";
import { pairingHost } from "./pairingHost";

// its own chunk (the QR code's library with it): a pairing exists only once WalletConnect's library has loaded
const PairingPanel = lazy(() => import("./PairingPanel"));

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

// connecting from any entry point remembers the connector it connected, in one place (./connect.ts; the twelfth review round, B12-6)
export { connectWith, disconnectWallet } from "./connect";


export interface ConnectSheetModel {
  /** connected (or on the wrong network): the account */
  account: string | null;
  status: ConnectionStatus;
  /** the connector it is connected through */
  via: string | null;
  connectors: ConnectorInfo[];
  /** the last failure, in words */
  error: string | null;
}

export function ConnectSheetView({
  open,
  onClose,
  model,
  pairing,
  onConnect,
  onSwitch,
  onDisconnect,
  handOver,
}: {
  open: boolean;
  onClose: () => void;
  model: ConnectSheetModel;
  /** a WalletConnect pairing waiting for the wallet app: its panel, in place of the connectors */
  pairing?: ReactNode;
  onConnect: (id: string) => void;
  onSwitch: () => void;
  onDisconnect: () => void;
  /** the sheet that takes the picker's history entry as it closes (BottomSheet's handOver), if any */
  handOver?: () => string | null;
}) {
  const t = useT();
  const connected = model.account !== null;
  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={t(connected ? "wallet.sheet.connectedTitle" : "wallet.sheet.title")}
      description={t("wallet.connectionNote")}
      testId="connect-sheet"
      id="connect"
      handOver={handOver}
    >
      {connected ? (
        <div className="ds-stack-sm">
          <div className="ds-kv">
            <span className="ds-kv-label">{t("wallet.account")}</span>
            <b className="ds-kv-value" data-testid="connect-account">
              {shortAccount(model.account!)}
            </b>
          </div>
          <div className="ds-kv">
            <span className="ds-kv-label">{t("wallet.connection")}</span>
            <StatusBadge tone={TONE[model.status]} testId="connect-status">
              {t(`wallet.status.${model.status}` as MessageKey)}
            </StatusBadge>
          </div>
          {model.via ? (
            <div className="ds-kv">
              <span className="ds-kv-label">{t("wallet.sheet.via")}</span>
              <b className="ds-kv-value">{model.via}</b>
            </div>
          ) : null}
          <div className="ds-actions">
            {model.status === "wrong-network" ? (
              <Button onClick={onSwitch} data-testid="connect-switch">
                {t("wallet.switch")}
              </Button>
            ) : null}
            <Button variant="secondary" onClick={onDisconnect} data-testid="connect-disconnect">
              {t("wallet.disconnect")}
            </Button>
          </div>
        </div>
      ) : pairing ? (
        pairing
      ) : (
        <div className="ds-stack-sm">
          {model.connectors.length === 0 ? (
            <p className="ds-note" data-testid="connect-none">
              {t("wallet.sheet.none")}
            </p>
          ) : null}
          {model.connectors.map((c) => (
            <ListRow
              key={c.id}
              title={c.name}
              subtitle={t(KIND[c.kind])}
              leading={c.icon ? <img className="ds-connector-icon" src={c.icon} alt="" width={24} height={24} /> : <Icon name="wallet" />}
              onPress={() => onConnect(c.id)}
              testId={`connector-${c.id}`}
            />
          ))}
          {model.status === "connecting" ? (
            <p className="ds-note" role="status" data-testid="connect-connecting">
              {t("wallet.status.connecting")}
            </p>
          ) : null}
          {model.error ? (
            <p className="ds-field-error" role="alert" data-testid="connect-error">
              {model.error}
            </p>
          ) : null}
        </div>
      )}
    </BottomSheet>
  );
}

export function ConnectSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const conn = useConnection();
  const advanced = usePrefs().experience === "advanced";
  // while the sheet is open a WalletConnect pairing shows in it, never in a sheet of its own as well (pairingHost)
  useEffect(() => (open ? pairingHost.hold() : undefined), [open]);
  const model: ConnectSheetModel = {
    account: conn.account,
    status: conn.status,
    via: conn.connector?.name ?? null,
    connectors: conn.connectors,
    error: conn.error ? connectErrorWords(t, conn.error, advanced, "picker", conn.connectors.length > 1) : null,
  };
  return (
    <ConnectSheetView
      open={open}
      onClose={() => {
        // closed over a pairing: the pairing is cancelled — nothing is left waiting for the wallet app
        if (conn.pairing || conn.pending?.kind === "walletconnect") connection.cancel(); // its link shown, or its library still loading
        onClose();
      }}
      model={model}
      pairing={
        conn.pairing ? (
          <Suspense fallback={null}>
            <PairingPanel uri={conn.pairing} onCancel={() => connection.cancel()} />
          </Suspense>
        ) : null
      }
      onConnect={(id) => {
        void connectWith(id).then((held) => {
          if (held) onClose();
        });
      }}
      onSwitch={() => void connection.switchNetwork()}
      onDisconnect={() => {
        disconnectWallet();
        onClose();
      }}
      handOver={() => {
        // the picker gone with a pairing still on — a lock swaps the Shell out (the twelfth review round, B12-1): it goes back no more, so no
        // traversal reaches the root's pairing sheet that shows the pairing next. That sheet takes the picker's entry when nothing writes over
        // it; at a lock the browser router's replace (the Gate's) takes it first and the sheet pushes its own, the picker's entry left behind —
        // one Back press on the page that does nothing (stated). Read as the picker closes: closed by the user, it was cancelled first
        const c = connection.get();
        return c.pairing !== null || c.pending?.kind === "walletconnect" ? "pairing" : null;
      }}
    />
  );
}
