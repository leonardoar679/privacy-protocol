// The twelfth review round, 2026-11-06, F12-1 and its critiques ZA–ZC: `refund_route_unavailable` is the answer to a signing — after the funding — or
// to a delayed funding's check, when Mayan quotes none of the committed route type while it quotes the other (another provider's other route is its
// provider_unavailable). Its words are shown beside a funded order (the attempt line, the Activity detail): they say the funds come back after the
// refund time, never that nothing moved (no_quote's
// words had been shown for a funded step, ZA) nor that the user approved or reviewed the route (an order reviewed at the destination may be committed on
// Swift, ZB), and they name the route the swap was set up on, the reason shown without its title (ZC).
import { describe, expect, it } from "vitest";
import { loadCatalog } from "../src/app/i18n/catalogs";
import { t } from "../src/app/i18n/messages";

describe("F12-1: refund_route_unavailable's words, in English and Korean", () => {
  it("English: the route the swap was set up on, the funds back after the refund time, nothing said to have stayed or been approved", () => {
    const title = t("op.error.refund_route_unavailable.title" as never);
    const reason = t("op.error.refund_route_unavailable.reason" as never);
    expect(title).toMatch(/route this swap was set up on/);
    expect(reason).toMatch(/if the route it was set up on does not come back in time, the funds return to your protected balance after the refund time/);
    expect(`${title} ${reason}`).not.toMatch(/nothing (left|moved|was sent)|approved|reviewed|change the amount|escrow/i);
  });

  it("Korean: 설정된 경로, 환불 시간 뒤 보호 잔액으로 — 승인·검토라 하지 않는다", async () => {
    await loadCatalog("ko");
    const title = t("op.error.refund_route_unavailable.title" as never, undefined, "ko");
    const reason = t("op.error.refund_route_unavailable.reason" as never, undefined, "ko");
    expect(title).toContain("설정된 경로");
    expect(reason).toContain("실패 시 이 스왑에 설정된 환불 위치와 다른 곳으로 환불하는 경로만");
    expect(reason).toContain("설정된 경로가 제때 다시 제공되지 않으면 환불 시간이 지난 뒤 자금이 보호 잔액으로 돌아옵니다");
    expect(`${title} ${reason}`).not.toMatch(/승인|검토|에스크로/);
  });
});
