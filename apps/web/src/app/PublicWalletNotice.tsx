// A wallet made from a published test phrase (the eleventh review round's critique, 2026-11-04): it opens so its owner can move what it holds,
// and every screen says that anyone can spend it. A create or a restore of such a phrase is refused; an older wallet made from one opens —
// but the zero seed's, from which no key derives, which the unlock refuses.
import { useSyncExternalStore } from "react";
import { WarningCard } from "@privacy-wallet/ui";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { useT } from "./i18n/useT";

const subscribe = (l: () => void): (() => void) => session.subscribe(l);
const isPublic = (): boolean => session.isPublicWallet();

export function PublicWalletNotice() {
  const t = useT();
  const shown = useSyncExternalStore(subscribe, isPublic, isPublic);
  if (!shown) return null;
  return (
    <div role="alert" className="notice" data-testid="public-wallet-notice">
      <WarningCard title={t("shell.publicWallet.title")} body={<p>{t("shell.publicWallet.body")}</p>} />
    </div>
  );
}
