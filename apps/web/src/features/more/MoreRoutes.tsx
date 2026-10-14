// The routes under More (spec §2): Security, Wallet, Advanced, the Privacy Center and "What stays private?", Classic
// Privacy. Private AI and the guest swap are separate chunks (features/ai, features/guest).
import { useNavigate, useParams } from "react-router-dom";
import { useDeployment } from "../../app/deployment";
import { Advanced } from "./Advanced";
import { Security } from "./Security";
import { Wallet } from "./Wallet";
import { Language } from "./Language";
import { PrivacyCenter } from "../privacy-center/PrivacyCenter";
import { WhatStaysPrivate } from "../privacy-center/WhatStaysPrivate";
import { ClassicHome, ClassicPoolScreen, ClassicRecoverScreen, ClassicRelayersScreen } from "../classic-privacy/ClassicPrivacyUI";

export function SecurityRoute() { const navigate = useNavigate(); return <Security onBack={() => navigate(-1)} />; }
export function WalletRoute() { const navigate = useNavigate(); const deployment = useDeployment(); return <Wallet deployment={deployment} onBack={() => navigate(-1)} />; }
export function AdvancedRoute() { const navigate = useNavigate(); const deployment = useDeployment(); return <Advanced deployment={deployment} onBack={() => navigate(-1)} />; }
export function PrivacyRoute({ advanced = false }: { advanced?: boolean }) { const navigate = useNavigate(); const deployment = useDeployment(); return <PrivacyCenter deployment={deployment} onBack={() => navigate(-1)} onLearnMore={() => navigate("/more/privacy/what-stays-private")} onSettings={() => navigate("/more/advanced")} defaultAdvanced={advanced} />; }
/** V6 Stage 16: the language picker */
export function LanguageRoute() { const navigate = useNavigate(); return <Language onBack={() => navigate(-1)} />; }
export function WhatStaysPrivateRoute() { const navigate = useNavigate(); return <WhatStaysPrivate onBack={() => navigate(-1)} />; }
export function ClassicRoute() { const navigate = useNavigate(); return <ClassicHome onOpen={(id) => navigate(`/more/classic/${encodeURIComponent(id)}`)} onRecover={() => navigate("/more/classic/recover")} onRelayers={() => navigate("/more/classic/relayers")} onBack={() => navigate("/more")} />; }
export function ClassicPoolRoute() { const navigate = useNavigate(); const { poolId = "" } = useParams(); return <ClassicPoolScreen poolId={decodeURIComponent(poolId)} onBack={() => navigate("/more/classic")} onRelayers={() => navigate("/more/classic/relayers")} />; }
/** V6 Stage 14: a deposit recovered from a pasted note; the relayer choice */
export function ClassicRecoverRoute() { const navigate = useNavigate(); return <ClassicRecoverScreen onBack={() => navigate("/more/classic")} onWithdraw={(id) => navigate(`/more/classic/${encodeURIComponent(id)}`)} />; }
export function ClassicRelayersRoute() { const navigate = useNavigate(); return <ClassicRelayersScreen onBack={() => navigate(-1)} />; }
