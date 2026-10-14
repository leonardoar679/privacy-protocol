// The /swap route: the Swap screen over the session, the deployment and the connection store. Send's hand-over of a
// cross-chain destination arrives as the navigation's state; it is taken once and cleared from the history entry.
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useDeployment } from "../../app/deployment";
import { useUnlockedSeed } from "../../app/Gate";
import { Swap, type SwapPrefill } from "./Swap";
import { useConnection } from "../../hooks";

export function SwapRoute() {
  const navigate = useNavigate();
  const seed = useUnlockedSeed();
  const deployment = useDeployment();
  const { account } = useConnection();
  const location = useLocation();
  const [prefill] = useState<SwapPrefill | null>(() => (location.state as { prefill?: SwapPrefill } | null)?.prefill ?? null);
  useEffect(() => {
    if (location.state) navigate(location.pathname, { replace: true, state: null });
  }, [location.state, location.pathname, navigate]);
  return <Swap masterSeed={seed} deployment={deployment} account={account} onBack={() => navigate("/")} prefill={prefill} />;
}

export default SwapRoute;
