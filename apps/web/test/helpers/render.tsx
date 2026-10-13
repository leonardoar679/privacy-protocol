// Renders the application over a memory router at a path and waits for the device's store (spec §2, §8).
import { act, render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { buildRoutes, PROVIDER_FUTURE, ROUTER_FUTURE } from "../../src/routes";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import { session } from "@privacy-wallet/sdk/wallet/session";

export async function renderApp(path = "/", opts: { dev?: boolean; deployment?: Deployment | null } = {}) {
  const router = createMemoryRouter(buildRoutes({ dev: opts.dev ?? false, deployment: opts.deployment }), { initialEntries: [path], future: ROUTER_FUTURE });
  const utils = render(<RouterProvider router={router} future={PROVIDER_FUTURE} />);
  await act(async () => { await session.ready; });
  return { router, ...utils, pathname: () => router.state.location.pathname };
}
