// The route table (spec v2.0 §6): the onboarding routes behind RequireLocked, the shell routes behind RequireUnlocked,
// the component preview (/__preview) in the dev and fixtures builds only and outside the gates (no wallet needed),
// every unknown path back to Home. V6 Stage 16 (spec v2.0 §19's budget): the first route carries the onboarding screens
// only — the shell and every screen behind the gate are separate chunks, loaded when their route matches (the router's
// `lazy`: the shell and Home together, after the unlock); Swap, Private AI, the guest swap and Activity as before.
import { lazy, Suspense, type ComponentType } from "react";
import { Navigate, useRouteError, type RouteObject } from "react-router-dom";
import { Button, ErrorCard, Page } from "@privacy-wallet/ui";
import { t } from "../app/i18n/messages";
import { Providers } from "../app/Providers";
import { RequireLocked, RequireUnlocked } from "../app/Gate";
import { Welcome } from "../features/onboarding/Welcome";
import { Create, Restore, Unlock } from "../features/onboarding/Lock";
import { Outlet } from "react-router-dom";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import { RootPairing } from "../features/wallet/RootPairing";

/** React Router 6 with the v7 behaviours already on (relative splat paths, fetcher persistence, partial hydration …). */
export const ROUTER_FUTURE = { v7_relativeSplatPath: true, v7_fetcherPersist: true, v7_normalizeFormMethod: true, v7_partialHydration: true, v7_skipActionErrorRevalidation: true } as const;
export const PROVIDER_FUTURE = { v7_startTransition: true } as const;

/** A route whose component is loaded when the route first matches. */
const load =
  <M,>(module: () => Promise<M>, pick: (m: M) => ComponentType) =>
  async () => ({ Component: pick(await module()) });
const moreRoutes = () => import("../features/more/MoreRoutes");

const SwapRoute = lazy(() => import("../features/swap/SwapRoute"));
const ActivityRoute = lazy(() => import("../features/activity/ActivityRoute"));
const ActivityDetailRoute = lazy(() => import("../features/activity/ActivityRoute").then((m) => ({ default: m.ActivityDetailRoute })));
const AIRoute = lazy(() => import("../features/ai/AIRoute"));
const GuestRoute = lazy(() => import("../features/guest/GuestRoute"));
// __PREVIEW__ is a build constant (vite.config.ts): a production build drops this branch and the preview's chunk with it
const Preview = __PREVIEW__ ? lazy(() => import("@privacy-wallet/ui/Preview").then((m) => ({ default: m.Preview }))) : null;

// RootPairing (the eleventh review round, slice 6c): a WalletConnect pairing the connector picker does not show, in a sheet of its own
function Root({ deployment }: { deployment?: Deployment | null }) {
  return <Providers deployment={deployment}><Outlet /><RootPairing /></Providers>;
}

/** While the router loads the lazy screens the first path matched: the page's own background, marked busy. */
function Starting() {
  return <div aria-busy="true" />;
}

function RouteError() {
  const error = useRouteError();
  const reason = error instanceof Error ? error.message : String(error ?? "");
  return (
    <main className="ds-main">
      <Page title={t("app.name")}>
        <ErrorCard title={t("error.routeTitle")} fundsLine={t("funds.notMoved")} fundsState="not-moved" reason={reason} actions={<Button onClick={() => { window.location.assign("/"); }}>{t("error.goHome")}</Button>} />
      </Page>
    </main>
  );
}

/** `preview`: the component preview's route (the dev and fixtures builds pass __PREVIEW__; a production build has no Preview to route to). */
export function buildRoutes({ preview = false, deployment }: { preview?: boolean; deployment?: Deployment | null } = {}): RouteObject[] {
  const shellChildren: RouteObject[] = [
    { index: true, lazy: load(() => import("../features/wallet/Home"), (m) => m.Home) },
    { path: "protect/*", lazy: load(() => import("../features/protect/ProtectRoute"), (m) => m.ProtectRoute) },
    { path: "send/*", lazy: load(() => import("../features/send/SendRoute"), (m) => m.SendRoute) },
    { path: "receive", lazy: load(() => import("../features/wallet/ReceiveRoute"), (m) => m.ReceiveRoute) },
    { path: "swap/*", element: <SwapRoute /> },
    { path: "activity", element: <ActivityRoute /> },
    { path: "activity/:id", element: <ActivityDetailRoute /> },
    { path: "recovery/:id", element: <ActivityDetailRoute /> },
    { path: "more", lazy: load(() => import("../features/more/More"), (m) => m.More) },
    { path: "more/ai", element: <AIRoute /> },
    // V7 Stage 4 (spec v3.0 §2): the Privacy Center and one Settings page at their own paths …
    { path: "privacy", lazy: load(moreRoutes, (m) => m.PrivacyRoute) },
    { path: "privacy/advanced", lazy: load(moreRoutes, (m) => () => <m.PrivacyRoute advanced />) },
    { path: "privacy/what-stays-private", lazy: load(moreRoutes, (m) => m.WhatStaysPrivateRoute) },
    { path: "privacy/fees", lazy: load(moreRoutes, (m) => m.FeesRoute) }, // V7 Stage 12: Fees & refunds
    { path: "settings", lazy: load(() => import("../features/settings/Settings"), (m) => m.SettingsRoute) },
    { path: "settings/advanced", lazy: load(moreRoutes, (m) => m.AdvancedRoute) },
    // … and every old More path redirects to its new home (bookmarks and the auto-lock's return path keep working)
    { path: "more/privacy", element: <Navigate to="/privacy" replace /> },
    { path: "more/privacy/advanced", element: <Navigate to="/privacy/advanced" replace /> },
    { path: "more/privacy/what-stays-private", element: <Navigate to="/privacy/what-stays-private" replace /> },
    { path: "more/security", element: <Navigate to="/settings" replace /> },
    { path: "more/wallet", element: <Navigate to="/settings#wallet" replace /> },
    { path: "more/language", element: <Navigate to="/settings#language" replace /> },
    { path: "more/advanced", element: <Navigate to="/settings/advanced" replace /> },
    // V7 Stage 11 (spec v3.0 §7.8): the V6 module is gone; its old paths lead to the Classic app (another application, a full navigation)
    { path: "more/classic/*", lazy: load(moreRoutes, (m) => m.ToClassicRoute) },
    { path: "*", element: <Navigate to="/" replace /> },
  ];
  return [
    {
      element: <Root deployment={deployment} />,
      errorElement: <RouteError />,
      HydrateFallback: Starting,
      children: [
        ...(preview && Preview ? [{ path: "/__preview", element: <Suspense fallback={null}><Preview /></Suspense> }] : []),
        { element: <RequireLocked />, children: [
          { path: "/welcome", element: <Welcome /> },
          { path: "/create", element: <Create /> },
          { path: "/unlock", element: <Unlock /> },
          { path: "/restore", element: <Restore /> },
          { path: "/guest", element: <GuestRoute /> },
        ] },
        { element: <RequireUnlocked />, children: [{ lazy: load(() => import("../app/Shell"), (m) => m.Shell), children: shellChildren }] },
      ],
    },
  ];
}
