// The application (spec §2): a data router over the route table; the browser's history is the navigation state.
import { useState } from "react";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { buildRoutes, PROVIDER_FUTURE, ROUTER_FUTURE } from "../routes";
import { DEV_BUILD } from "../config";

export function App() {
  const [router] = useState(() => createBrowserRouter(buildRoutes({ dev: DEV_BUILD }), { future: ROUTER_FUTURE }));
  return <RouterProvider router={router} future={PROVIDER_FUTURE} />;
}
