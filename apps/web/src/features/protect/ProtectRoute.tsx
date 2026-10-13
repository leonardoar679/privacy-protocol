// The /protect route: the Protect screen over the session, the deployment and the connection store.
import { useNavigate } from "react-router-dom";
import { useDeployment } from "../../app/deployment";
import { useUnlockedSeed } from "../../app/Gate";
import { connection, useConnection } from "../wallet/connection";
import { Protect } from "./Protect";

export function ProtectRoute() {
  const navigate = useNavigate();
  const seed = useUnlockedSeed();
  const deployment = useDeployment();
  const conn = useConnection();
  return <Protect masterSeed={seed} deployment={deployment} account={conn.account} connecting={conn.status === "connecting"} onConnect={() => void connection.connect()} onBack={() => navigate("/")} onDone={() => navigate("/")} onBackup={() => navigate("/more/security")} />;
}
