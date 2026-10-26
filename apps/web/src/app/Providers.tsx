// The providers above every screen (spec §2): the deployment, the toasts, the locale (spec §19: the preference, else
// the browser's languages; `?locale=` for development and the layout checks). The router sits above them in App.tsx.
import { useEffect, useState, type ReactNode } from "react";
import { ToastProvider } from "@privacy-wallet/ui";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import { config } from "@privacy-wallet/sdk/config";
import { connection, discover } from "@privacy-wallet/wallet-engine/connection";
import { prefs } from "../storage/prefs";
import { DeploymentContext } from "./deployment";
import { applyLocale } from "./i18n/locale";

// V6 Stage 16: the locale's application lives in ./i18n/locale.ts (main.tsx applies it before the first render)
export { applyLocale };

export function Providers({ children, deployment }: { children: ReactNode; deployment?: Deployment | null }) {
  const [fromEnv] = useState(() => (deployment === undefined ? config().deployment : deployment));
  useEffect(() => { connection.configure({ expectedChainId: fromEnv?.chainId ?? null }); discover(); }, [fromEnv]);
  useEffect(() => { applyLocale(); return prefs().subscribe(applyLocale); }, []);
  // V7 Stage 4 (spec v3.0 §2): the connector of the last connection reconnects after a reload, without a prompt
  useEffect(() => {
    let on = true;
    void prefs().ready.then(() => {
      const id = prefs().get().lastConnector;
      if (on && id && connection.get().status === "disconnected") void connection.reconnect(id);
    });
    return () => { on = false; };
  }, []);
  return (
    <DeploymentContext.Provider value={fromEnv}>
      <ToastProvider>{children}</ToastProvider>
    </DeploymentContext.Provider>
  );
}
