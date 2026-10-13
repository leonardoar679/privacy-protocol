// The route table (spec §2): the onboarding routes behind RequireLocked, the shell routes behind RequireUnlocked,
// the gallery in dev builds only, every unknown path back to Home. The heavy screens — Swap, Private AI, the
// guest swap, Activity — are separate chunks loaded when their route opens (spec §20).
import { lazy } from "react";
import { Navigate, useRouteError, type RouteObject } from "react-router-dom";
import { Button, ErrorCard, Page } from "../design-system";
import { t } from "../app/i18n/messages";
import { Providers } from "../app/Providers";
import { RequireLocked, RequireUnlocked } from "../app/Gate";
import { Shell } from "../app/Shell";
import { Welcome } from "../features/onboarding/Welcome";
import { Create, Restore, Unlock } from "../features/onboarding/Lock";
import { More } from "../features/more/More";
import { Home } from "../features/wallet/Home";
import { AdvancedRoute, ClassicPoolRoute, ClassicRoute, PrivacyRoute, SecurityRoute, WalletRoute, WhatStaysPrivateRoute } from "../features/more/MoreRoutes";
import { ProtectRoute } from "../features/protect/ProtectRoute";
import { SendRoute } from "../features/send/SendRoute";
import { ReceiveRoute } from "../features/wallet/ReceiveRoute";
import { Outlet } from "react-router-dom";
import type { Deployment } from "../sdk/chain";

/** React Router 6 with the v7 behaviours already on (relative splat paths, fetcher persistence, partial hydration …). */
export const ROUTER_FUTURE = { v7_relativeSplatPath: true, v7_fetcherPersist: true, v7_normalizeFormMethod: true, v7_partialHydration: true, v7_skipActionErrorRevalidation: true } as const;
export const PROVIDER_FUTURE = { v7_startTransition: true } as const;

const SwapRoute = lazy(() => import("../features/swap/SwapRoute"));
const ActivityRoute = lazy(() => import("../features/activity/ActivityRoute"));
const ActivityDetailRoute = lazy(() => import("../features/activity/ActivityRoute").then((m) => ({ default: m.ActivityDetailRoute })));
const AIRoute = lazy(() => import("../features/ai/AIRoute"));
const GuestRoute = lazy(() => import("../features/guest/GuestRoute"));
const Gallery = lazy(() => import("../design-system/Gallery").then((m) => ({ default: m.Gallery })));

function Root({ deployment }: { deployment?: Deployment | null }) {
  return <Providers deployment={deployment}><Outlet /></Providers>;
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

export function buildRoutes({ dev, deployment }: { dev: boolean; deployment?: Deployment | null }): RouteObject[] {
  const shellChildren: RouteObject[] = [
    { index: true, element: <Home /> },
    { path: "protect/*", element: <ProtectRoute /> },
    { path: "send/*", element: <SendRoute /> },
    { path: "receive", element: <ReceiveRoute /> },
    { path: "swap/*", element: <SwapRoute /> },
    { path: "activity", element: <ActivityRoute /> },
    { path: "activity/:id", element: <ActivityDetailRoute /> },
    { path: "recovery/:id", element: <ActivityDetailRoute /> },
    { path: "more", element: <More /> },
    { path: "more/privacy", element: <PrivacyRoute /> },
    { path: "more/privacy/advanced", element: <PrivacyRoute advanced /> },
    { path: "more/privacy/what-stays-private", element: <WhatStaysPrivateRoute /> },
    { path: "more/security", element: <SecurityRoute /> },
    { path: "more/wallet", element: <WalletRoute /> },
    { path: "more/advanced", element: <AdvancedRoute /> },
    { path: "more/ai", element: <AIRoute /> },
    { path: "more/classic", element: <ClassicRoute /> },
    { path: "more/classic/:poolId", element: <ClassicPoolRoute /> },
    ...(dev ? [{ path: "gallery", element: <Gallery /> }] : []),
    { path: "*", element: <Navigate to="/" replace /> },
  ];
  return [
    {
      element: <Root deployment={deployment} />,
      errorElement: <RouteError />,
      children: [
        { element: <RequireLocked />, children: [
          { path: "/welcome", element: <Welcome /> },
          { path: "/create", element: <Create /> },
          { path: "/unlock", element: <Unlock /> },
          { path: "/restore", element: <Restore /> },
          { path: "/guest", element: <GuestRoute /> },
        ] },
        { element: <RequireUnlocked />, children: [{ element: <Shell />, children: shellChildren }] },
      ],
    },
  ];
}
