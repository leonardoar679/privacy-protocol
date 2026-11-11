// The /protect route (and /protect/review, /protect/progress/:opId): the Protect screen over the session, the deployment
// and the connection store.
import { useNavigate } from "react-router-dom";
import { useDeployment } from "../../app/deployment";
import { useUnlockedSeed } from "../../app/Gate";
import { connection } from "@privacy-wallet/wallet-engine/connection";
import { connectWith } from "../wallet/connect";
import { ProtectScreen } from "./ProtectScreen";
import { useConnection } from "../../hooks";

export function ProtectRoute() {
  const navigate = useNavigate();
  const seed = useUnlockedSeed();
  const deployment = useDeployment();
  const conn = useConnection();
  // a wallet on another network is never taken as connected (a V6 follow-up of 2026-10-16): nothing is read from that chain,
  // and the page offers the switch; every send is checked against the deployment's chain anyway (sdk/chain.ts)
  const wrong = conn.status === "wrong-network";
  return (
    <ProtectScreen
      masterSeed={seed}
      deployment={deployment}
      account={wrong ? null : conn.account}
      connecting={conn.status === "connecting"}
      wrongNetwork={wrong}
      onSwitch={() => void connection.switchNetwork()}
      onConnect={() => void connectWith()}
      onBack={() => navigate("/")}
      onDone={() => navigate("/")}
      onBackup={() => navigate("/settings")}
    />
  );
}
