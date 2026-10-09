// The guest swap (spec §2, /guest): the V1.1 screen keeps its code and its test ids; a separate chunk loaded when the
// route opens (spec §20).
import { useNavigate } from "react-router-dom";
import { Guest } from "../../components/Guest";

export function GuestRoute() {
  const navigate = useNavigate();
  return <div className="ds-main"><Guest onBack={() => navigate("/unlock")} /></div>;
}

export default GuestRoute;
