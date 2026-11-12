// The WalletConnect connection's own sheet (the eleventh review round, slice 6c), from the app's root (RootPairing), in order: from its start
// the wait — the library's load, the relay's answer —; the pairing — its QR code, the link to the wallet app, Cancel —; a failure, before
// or after the link, in the sheet's own words with Try again (the slice's second and third critiques) — Reload beside it where the words
// name a reload, in its place for an earlier end still under way (the twelfth review round, the critique of 12d3c: connectWords'
// reloadOffered) —; the retry's wait. Closing it cancels the connection, or dismisses the failure.
import { BottomSheet, Button } from "@privacy-wallet/ui";
import { WALLETCONNECT_ID } from "@privacy-wallet/wallet-engine/connection";
import { connectWith, reloadPage } from "./connect";
import { useT } from "../../app/i18n/useT";
import { usePrefs } from "../../hooks/core";
import { connectErrorWords, reloadOffered } from "./connectWords";
import { PairingPanel } from "./PairingPanel";

export default function PairingSheet({
  uri,
  failure,
  onClose,
  onReload = reloadPage,
}: {
  uri: string | null;
  failure: string | null;
  onClose: () => void;
  /** tests: the page's reload */
  onReload?: () => void;
}) {
  const t = useT();
  const advanced = usePrefs().experience === "advanced";
  const reload = failure !== null ? reloadOffered(failure) : null;
  return (
    <BottomSheet open onClose={onClose} title={t("wallet.sheet.title")} description={t("wallet.connectionNote")} testId="pairing-sheet" id="pairing">
      {uri !== null ? (
        <PairingPanel uri={uri} onCancel={onClose} />
      ) : failure !== null ? (
        <div className="ds-stack-sm">
          <p className="ds-field-error" role="alert" data-testid="connect-error">
            {connectErrorWords(t, failure, advanced, "pairing")}
          </p>
          {reload !== "only" ? (
            <Button variant="secondary" full onClick={() => void connectWith(WALLETCONNECT_ID)} data-testid="connect-retry">
              {t("wallet.pairing.retry")}
            </Button>
          ) : null}
          {reload !== null ? (
            <Button variant="secondary" full onClick={onReload} data-testid="connect-reload">
              {t("wallet.pairing.reload")}
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="ds-note" role="status" data-testid="connect-connecting">
          {t("wallet.status.connecting")}
        </p>
      )}
    </BottomSheet>
  );
}
