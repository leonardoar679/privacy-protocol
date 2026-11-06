// The /activity routes: the list, and the detail at /activity/:id or /recovery/:id (the recovery card is the detail's). The
// path names a record by its handle, never by an id that carries an order id or a transaction hash (the audit round of
// 2026-10-16, c41: packages/sdk/src/wallet/routeHandles.ts).
import { useNavigate, useParams } from "react-router-dom";
import { idOfRoute, routeHandle } from "@privacy-wallet/sdk/wallet/routeHandles";
import { useDeployment } from "../../app/deployment";
import { Activity } from "./Activity";
import { Detail } from "./Detail";

export function ActivityRoute() {
  const navigate = useNavigate();
  const deployment = useDeployment();
  return <Activity deployment={deployment} onOpen={(id) => navigate(`/activity/${encodeURIComponent(routeHandle(id))}`)} />;
}

export function ActivityDetailRoute() {
  const navigate = useNavigate();
  const deployment = useDeployment();
  const { id = "" } = useParams();
  // a funded order's pause is answered on its own page, never on a blank swap (the eleventh review round, 2026-11-04, E11-14)
  return (
    <Detail
      id={idOfRoute(decodeURIComponent(id))}
      deployment={deployment}
      onBack={() => navigate("/activity")}
      onNewQuote={() => navigate("/swap")}
      onOpenSwap={(recordId) => navigate(`/swap/progress/${routeHandle(recordId)}`)}
    />
  );
}

export default ActivityRoute;
