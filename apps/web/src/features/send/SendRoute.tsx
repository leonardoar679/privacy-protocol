// The /send route (and /send/review, /send/progress/:opId): the Send screen over the session, the deployment and the
// connection store.
import { useNavigate } from "react-router-dom";
import { useDeployment } from "../../app/deployment";
import { useUnlockedSeed } from "../../app/Gate";
import { SendScreen } from "./SendScreen";
import { useConnection } from "../../hooks";

export function SendRoute() {
  const navigate = useNavigate();
  const seed = useUnlockedSeed();
  const deployment = useDeployment();
  const { account } = useConnection();
  return <SendScreen masterSeed={seed} deployment={deployment} account={account} onBack={() => navigate("/")} onDone={() => navigate("/")} />;
}
