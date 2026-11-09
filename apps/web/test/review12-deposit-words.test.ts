// The twelfth review round, 2026-11-06, A12-1: a Protect the wallet that sent it no longer knows, with no note of it in the pool, reads its own
// words — never a Send's "Send it again": a deposit sped up in the wallet app lands under another hash, and a user who sent it again would deposit
// twice, a second 1 % fee. Nothing moved as far as the wallet can tell; the words send the user to their wallet app before another Protect.
import { describe, expect, it } from "vitest";
import { loadCatalog } from "../src/app/i18n/catalogs";
import { t } from "../src/app/i18n/messages";

describe("A12-1: deposit_dropped's words, in English and Korean", () => {
  it("English: nothing moved as far as the wallet can tell, the wallet app checked before protecting again — never 'send it again'", () => {
    const title = t("op.error.deposit_dropped.title" as never);
    const reason = t("op.error.deposit_dropped.reason" as never);
    expect(title).toBe("Not added: your wallet no longer knows the deposit");
    expect(reason).toMatch(/nothing moved as far as this wallet can tell/);
    expect(reason).toMatch(/If you sped it up or replaced it in your wallet app, check there before you protect again/);
    expect(`${title} ${reason}`).not.toMatch(/send it again/i);
  });

  it("Korean: the same, the wallet app checked before another Protect", async () => {
    await loadCatalog("ko");
    const reason = t("op.error.deposit_dropped.reason" as never, undefined, "ko");
    expect(t("op.error.deposit_dropped.title" as never, undefined, "ko")).toContain("지갑이 더 이상 이 입금을 알지 못합니다");
    expect(reason).toContain("지갑 앱에서 속도를 높이거나 교체했다면 다시 보호하기 전에 지갑 앱에서 확인하세요");
    expect(reason).not.toMatch(/다시 보내/);
  });
});
