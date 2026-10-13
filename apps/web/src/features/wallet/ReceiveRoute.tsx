// The /receive route: the Receive screen over the session.
import { useNavigate } from "react-router-dom";
import { useUnlockedSeed } from "../../app/Gate";
import { Receive } from "./Receive";

export function ReceiveRoute() {
  const navigate = useNavigate();
  const seed = useUnlockedSeed();
  return <Receive masterSeed={seed} onBack={() => navigate("/")} />;
}
