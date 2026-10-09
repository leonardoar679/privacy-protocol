// The providers above every screen (spec §2): the deployment, the toasts. The router sits above them in App.tsx.
import { useState, type ReactNode } from "react";
import { ToastProvider } from "../design-system";
import { deploymentFromEnv, type Deployment } from "../sdk/chain";
import { DeploymentContext } from "./deployment";

export function Providers({ children, deployment }: { children: ReactNode; deployment?: Deployment | null }) {
  const [fromEnv] = useState(() => (deployment === undefined ? deploymentFromEnv() : deployment));
  return (
    <DeploymentContext.Provider value={fromEnv}>
      <ToastProvider>{children}</ToastProvider>
    </DeploymentContext.Provider>
  );
}
