// Renders the application over a memory router at a path and waits for the device's store (spec §2, §8).
import { act, render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { buildRoutes, PROVIDER_FUTURE, ROUTER_FUTURE } from "../../src/routes";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import { session } from "@privacy-wallet/sdk/wallet/session";

export async function renderApp(path = "/", opts: { preview?: boolean; deployment?: Deployment | null } = {}) {
  const router = createMemoryRouter(buildRoutes({ preview: opts.preview ?? false, deployment: opts.deployment }), { initialEntries: [path], future: ROUTER_FUTURE });
  const utils = render(<RouterProvider router={router} future={PROVIDER_FUTURE} />);
  await act(async () => { await session.ready; });
  await settle(router);
  return { router, ...utils, pathname: () => router.state.location.pathname };
}

/** V6 Stage 16: the screens behind the gate are lazy routes — wait until the router has loaded what the path matched. */
export async function settle(router: { state: { initialized: boolean; navigation: { state: string } } }): Promise<void> {
  for (let i = 0; i < 200 && (!router.state.initialized || router.state.navigation.state !== "idle"); i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  }
}
