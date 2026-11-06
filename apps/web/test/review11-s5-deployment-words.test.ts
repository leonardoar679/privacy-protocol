// The deployment check's two outcomes in their own words (the eleventh review round, the third critique of slice 5). A refusal — the chain
// does not say what this build requires: another core's identifiers, a hasher that is not this build's Poseidon2, the development key, a
// factory on another wrapped token — had read "under More → Advanced you can choose to accept the deployment it names", and nothing there
// accepts it: forgetting the remembered deployment, as told, blocked the next operation the same way. Only a remembered deployment that
// differs is forgotten there.
import { describe, expect, it } from "vitest";
import { classify } from "@privacy-wallet/sdk/operations/errors/catalog";
import { DeploymentMismatch } from "@privacy-wallet/sdk/deploymentGuard";
import { errorWords } from "../src/features/operations/errorWords";
import { loadCatalog } from "../src/app/i18n/catalogs";
import { t } from "../src/app/i18n/messages";
import { en } from "../src/app/i18n/en";

describe("a deployment refused, and a deployment that differs from the remembered one", () => {
  it("a refusal: its own code, and words that offer no Advanced remedy (en, ko)", async () => {
    await loadCatalog("ko");
    const refused = classify(new DeploymentMismatch(["the core's hasher is not this build's Poseidon2"], false));
    expect(refused.code).toBe("deployment_refused");
    expect(classify(new DeploymentMismatch(["another protocol id"], true)).code, "a problem with a changed one too").toBe("deployment_refused");
    for (const lang of ["en", "ko"] as const) {
      const reason = t("op.error.deployment_refused.reason" as never, undefined, lang);
      expect(reason, lang).not.toMatch(/Advanced|고급/);
      expect(reason, lang).toMatch(/Nothing was sent|아무것도 전송되지 않았습니다/);
    }
    expect(errorWords((k, v) => t(k, v), new DeploymentMismatch(["the dev key"], false), { advanced: false, fallback: "op.error.unknown.reason" as never }), "the line a screen shows").toBe(
      en["op.error.deployment_refused.reason"],
    );
  });
  it("a remembered deployment that differs: deployment_mismatch, whose words name the Advanced remedy; and what forgetting it does", async () => {
    await loadCatalog("ko");
    expect(classify(new DeploymentMismatch([], true)).code).toBe("deployment_mismatch");
    expect(en["op.error.deployment_mismatch.reason"]).toMatch(/More → Advanced/);
    expect(en["op.error.deployment_mismatch.reason"], "not a refusal's words").not.toMatch(/built for/);
    expect(t("advanced.fingerprintForgotten" as never)).toMatch(/checks the deployment again/);
    expect(t("advanced.fingerprintForgotten" as never, undefined, "ko")).toMatch(/다시 확인/);
  });
});
