// The /send route: the Send screen over the session, the deployment and the connection store.
import { useNavigate } from "react-router-dom";
import { useDeployment } from "../../app/deployment";
import { useUnlockedSeed } from "../../app/Gate";
import { useConnection } from "../wallet/connection";
import { Send } from "./Send";

export function SendRoute() {
  const navigate = useNavigate();
  const seed = useUnlockedSeed();
  const deployment = useDeployment();
  const { account } = useConnection();
  return <Send masterSeed={seed} deployment={deployment} account={account} onBack={() => navigate("/")} onDone={() => navigate("/")} />;
}
