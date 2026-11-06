// The WalletConnect connection's own sheet (the eleventh review round, slice 6c), from the app's root (RootPairing), in order: from its start
// the wait — the library's load, the relay's answer —; the pairing — its QR code, the link to the wallet app, Cancel —; a failure, before
// or after the link, in the sheet's own words with Try again (the slice's second and third critiques); the retry's wait. Closing it cancels
// the connection, or dismisses the failure.
import { BottomSheet, Button } from "@privacy-wallet/ui";
import { connection, WALLETCONNECT_ID } from "@privacy-wallet/wallet-engine/connection";
import { useT } from "../../app/i18n/useT";
import { usePrefs } from "../../hooks/core";
import { connectErrorWords } from "./connectWords";
import { PairingPanel } from "./PairingPanel";

export default function PairingSheet({ uri, failure, onClose }: { uri: string | null; failure: string | null; onClose: () => void }) {
  const t = useT();
  const advanced = usePrefs().experience === "advanced";
  return (
    <BottomSheet open onClose={onClose} title={t("wallet.sheet.title")} description={t("wallet.connectionNote")} testId="pairing-sheet" id="pairing">
      {uri !== null ? (
        <PairingPanel uri={uri} onCancel={onClose} />
      ) : failure !== null ? (
        <div className="ds-stack-sm">
          <p className="ds-field-error" role="alert" data-testid="connect-error">
            {connectErrorWords(t, failure, advanced, "pairing")}
          </p>
          <Button variant="secondary" full onClick={() => void connection.connect(WALLETCONNECT_ID)} data-testid="connect-retry">
            {t("wallet.pairing.retry")}
          </Button>
        </div>
      ) : (
        <p className="ds-note" role="status" data-testid="connect-connecting">
          {t("wallet.status.connecting")}
        </p>
      )}
    </BottomSheet>
  );
}
