// The /activity routes: the list, and the detail at /activity/:id or /recovery/:id (the recovery card is the detail's).
import { useNavigate, useParams } from "react-router-dom";
import { useDeployment } from "../../app/deployment";
import { Activity } from "./Activity";
import { Detail } from "./Detail";

export function ActivityRoute() {
  const navigate = useNavigate();
  const deployment = useDeployment();
  return <Activity deployment={deployment} onOpen={(id) => navigate(`/activity/${encodeURIComponent(id)}`)} />;
}

export function ActivityDetailRoute() {
  const navigate = useNavigate();
  const deployment = useDeployment();
  const { id = "" } = useParams();
  return <Detail id={decodeURIComponent(id)} deployment={deployment} onBack={() => navigate("/activity")} onNewQuote={() => navigate("/swap")} />;
}

export default ActivityRoute;
