// More → Language (spec v2.0 §18; doc §78; V6 Stage 16): Automatic (the browser's languages decide), English or Korean —
// the preference's `locale` with `localeChosen`, so an English reader on a Korean device keeps English by choosing it.
// The catalog, the numbers and dates (Intl) and the document's lang follow (app/i18n/locale.ts). Each language is named
// in its own words, as every language picker does.
import { Card, Page, RadioGroup } from "@privacy-wallet/ui";
import { useT } from "../../app/i18n/useT";
import { usePrefs } from "../../hooks/core";
import { prefs } from "../../storage/prefs";

/** The languages a reader can choose: complete catalogs only, each named in its own language. */
export const LANGUAGES: readonly { code: "en" | "ko"; name: string }[] = [
  { code: "en", name: "English" },
  { code: "ko", name: "한국어" },
];

export function Language({ onBack }: { onBack: () => void }) {
  const t = useT();
  const p = usePrefs();
  const value = p.localeChosen ? p.locale.split("-")[0] : "auto";
  const choose = (v: string) => {
    prefs().update(v === "auto" ? { locale: "en", localeChosen: undefined } : { locale: v, localeChosen: true });
  };
  return (
    <Page title={t("route.language")} back={onBack} testId="language">
      <Card>
        <RadioGroup
          value={value}
          onValueChange={choose}
          ariaLabel={t("route.language")}
          name="language"
          options={[
            { value: "auto", label: t("language.auto"), description: t("language.autoWhy"), testId: "language-auto" },
            ...LANGUAGES.map((l) => ({ value: l.code, label: <span lang={l.code}>{l.name}</span>, testId: `language-${l.code}` })),
          ]}
        />
      </Card>
    </Page>
  );
}
