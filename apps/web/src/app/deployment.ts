// The deployment (chain id, core, vaults, RPC endpoints) read once from the environment and handed down by
// context (spec §2): the screens stop taking it as a prop.
import { createContext, useContext } from "react";
import type { Deployment } from "../sdk/chain";

export const DeploymentContext = createContext<Deployment | null>(null);
export const useDeployment = (): Deployment | null => useContext(DeploymentContext);
