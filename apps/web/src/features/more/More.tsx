// The More menu (spec v3.0 §2; doc §3, §15; V7 Stage 4): Tornado Classic, the Privacy Center, Settings — and Private AI
// in the Advanced experience (one list with the desktop's Wallet menu: ./entries.ts). Each row is a route, except
// Tornado Classic: a plain link to the Classic application under /classic/ (it leaves the wallet's router). The
// experience switch lives under Settings now. MoreView is pure (the screenshot fixtures render it); More is the route.
import { useNavigate } from "react-router-dom";
import { Card, Icon, ListRow, Page } from "@privacy-wallet/ui";
import { useT } from "../../app/i18n/useT";
import { usePrefs } from "../../hooks";
import { moreEntries } from "./entries";

export function MoreView({ experience, onOpen }: { experience: "simple" | "advanced"; onOpen: (to: string) => void }) {
  const t = useT();
  return (
    <Page title={t("route.more")} testId="more">
      <div className="ds-stack">
        <Card padding="md">
          {moreEntries(experience).map((e) =>
            e.external ? (
              <ListRow key={e.id} title={t(e.title)} subtitle={t(e.subtitle)} leading={<Icon name={e.icon} />} href={e.to} testId={`more-${e.id}`} />
            ) : (
              <ListRow
                key={e.id}
                title={t(e.title)}
                subtitle={t(e.subtitle)}
                leading={<Icon name={e.icon} />}
                onPress={() => onOpen(e.to)}
                testId={`more-${e.id}`}
              />
            ),
          )}
        </Card>
      </div>
    </Page>
  );
}

export function More() {
  const navigate = useNavigate();
  const p = usePrefs();
  return <MoreView experience={p.experience === "advanced" ? "advanced" : "simple"} onOpen={(to) => navigate(to)} />;
}
