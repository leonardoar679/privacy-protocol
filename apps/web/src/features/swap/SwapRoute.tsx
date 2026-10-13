// The /swap route: the Swap screen over the session, the deployment and the connection store.
import { useNavigate } from "react-router-dom";
import { useDeployment } from "../../app/deployment";
import { useUnlockedSeed } from "../../app/Gate";
import { Swap } from "./Swap";
import { useConnection } from "../../hooks";

export function SwapRoute() {
  const navigate = useNavigate();
  const seed = useUnlockedSeed();
  const deployment = useDeployment();
  const { account } = useConnection();
  return <Swap masterSeed={seed} deployment={deployment} account={account} onBack={() => navigate("/")} />;
}

export default SwapRoute;
