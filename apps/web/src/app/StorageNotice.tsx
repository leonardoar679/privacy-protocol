// The browser is not keeping the wallet's data (2026-10-17, the audit's unverified m49): IndexedDB is there and refused at
// hydrate (site data blocked, quota, a closed private window). The keystore and the journal then live in this tab only and
// are gone when it closes; the wallet had said nothing. Shown over the shell and on the create and restore screens.
import { useSyncExternalStore } from "react";
import { WarningCard } from "@privacy-wallet/ui";
import { config } from "@privacy-wallet/sdk/config";
import { useT } from "./i18n/useT";

/** Whether the wallet's store refused to keep anything past this tab (the web's secure store says so). */
export function storageRefused(): boolean {
  const store = config().storage?.() as { refused?: boolean } | undefined;
  return store?.refused === true;
}

/** The store's word when it stops keeping its data later: a write it refused (audit round 2, r16). */
function subscribe(listener: () => void): () => void {
  const store = config().storage?.() as { subscribe?: (l: () => void) => () => void } | undefined;
  return store?.subscribe?.(listener) ?? (() => {});
}

export function StorageNotice() {
  const t = useT();
  const refused = useSyncExternalStore(subscribe, storageRefused);
  if (!refused) return null;
  return (
    <div role="status" className="notice" data-testid="storage-memory-notice">
      <WarningCard title={t("storage.memoryTitle")} body={<p>{t("storage.memoryBody")}</p>} />
    </div>
  );
}
