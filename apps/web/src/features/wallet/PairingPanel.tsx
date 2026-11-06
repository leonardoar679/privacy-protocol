// A WalletConnect pairing (the eleventh review round, slice 6c's critique): its QR code for the wallet app on another device, the link that
// opens the wallet app on this one, and Cancel — the wallet's own, since the library's modal is refused by the page's policy (it writes its
// styles as <style> elements). The link holds the pairing's key: the wallet shows it as the code and the link only — it never copies it,
// logs it, keeps it in its own storage or puts it in this page's URL; WalletConnect's own store (its keychain, WALLET_CONNECT_DB) holds it for
// the pairing's life, cleared by a Disconnect or a Forget (the fourth critique). The link is a secondary action: the page behind the sheet
// keeps its one primary (doc §10), and on a computer the code is the way.
import { ButtonLink, TextButton } from "@privacy-wallet/ui";
import { useT } from "../../app/i18n/useT";
import { QrCode } from "../../components/QrCode";

export function PairingPanel({ uri, onCancel }: { uri: string; onCancel: () => void }) {
  const t = useT();
  return (
    <div className="ds-stack" data-testid="connect-pairing">
      <p className="ds-note">{t("wallet.pairing.scan")}</p>
      <QrCode text={uri} testId="connect-qr" label={t("wallet.pairing.qr")} large />
      <ButtonLink href={uri} variant="secondary" full data-testid="connect-open-app">
        {t("wallet.pairing.openApp")}
      </ButtonLink>
      <p className="ds-note" role="status" data-testid="connect-waiting">
        {t("wallet.pairing.waiting")}
      </p>
      <TextButton onClick={onCancel} data-testid="connect-cancel">
        {t("common.cancel")}
      </TextButton>
    </div>
  );
}

export default PairingPanel;
