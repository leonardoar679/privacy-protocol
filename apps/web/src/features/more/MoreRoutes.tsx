// The routes behind More's lazy chunk (spec v3.0 §2; V7 Stage 4): the Privacy Center and "What stays private?" (under
// /privacy), the Advanced settings (under /settings/advanced; the Settings page itself is features/settings), and the
// V6 module's old paths (/more/classic/*) leading to the Classic app at /classic/ (V7 Stage 11). Private AI and the guest
// swap are separate chunks (features/ai, features/guest).
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useDeployment } from "../../app/deployment";
import { Advanced } from "./Advanced";
import { PrivacyCenter } from "../privacy-center/PrivacyCenter";
import { WhatStaysPrivate } from "../privacy-center/WhatStaysPrivate";

export function AdvancedRoute() { const navigate = useNavigate(); const deployment = useDeployment(); return <Advanced deployment={deployment} onBack={() => navigate(-1)} />; }
export function PrivacyRoute({ advanced = false }: { advanced?: boolean }) { const navigate = useNavigate(); const deployment = useDeployment(); return <PrivacyCenter deployment={deployment} onBack={() => navigate(-1)} onLearnMore={() => navigate("/privacy/what-stays-private")} onSettings={() => navigate("/settings/advanced")} defaultAdvanced={advanced} />; }
export function WhatStaysPrivateRoute() { const navigate = useNavigate(); return <WhatStaysPrivate onBack={() => navigate(-1)} />; }
/** V7 Stage 11 (spec v3.0 §7.8): the V6 module's old paths lead to the Classic app — another application, so a full navigation */
export function ToClassicRoute() { useEffect(() => { window.location.replace("/classic/"); }, []); return null; }
