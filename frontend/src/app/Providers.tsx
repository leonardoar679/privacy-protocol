// The providers above every screen (spec §2): the deployment, the toasts. The router sits above them in App.tsx.
import { useEffect, useState, type ReactNode } from "react";
import { ToastProvider } from "../design-system";
import { deploymentFromEnv, type Deployment } from "../sdk/chain";
import { connection, discover } from "../features/wallet/connection";
import { DeploymentContext } from "./deployment";

export function Providers({ children, deployment }: { children: ReactNode; deployment?: Deployment | null }) {
  const [fromEnv] = useState(() => (deployment === undefined ? deploymentFromEnv() : deployment));
  useEffect(() => { connection.configure({ expectedChainId: fromEnv?.chainId ?? null }); discover(); }, [fromEnv]);
  return (
    <DeploymentContext.Provider value={fromEnv}>
      <ToastProvider>{children}</ToastProvider>
    </DeploymentContext.Provider>
  );
}
