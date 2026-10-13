// The funding path shared by "Fund now" and the scheduler (V2 Stage 4): an abandoned order is never funded
// (the regression: its action used to stay pending and fire), a funded order's action is dropped, a
// journaled order's state is mirrored onto its Activity line, and the funding attempt itself refuses to
// start without a deployment or a factory before any note is touched.
import { describe, it, expect, beforeEach } from "vitest";
import { WalletSession } from "@privacy-wallet/sdk/wallet/session";
import { memoryStorage } from "@privacy-wallet/sdk/wallet/storage";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { pendingActions, scheduleAction } from "@privacy-wallet/sdk/wallet/schedule";
import { activityId, recordActivity } from "@privacy-wallet/sdk/wallet/activity";
import { abandonSwap, fundEscrow, isOpenSwap, patchSwap, runScheduledAction } from "@privacy-wallet/sdk/swapFunding";
import type { StoredSwap } from "@privacy-wallet/sdk/wallet/journal";

const KDF = { N: 1 << 12, r: 8, p: 1 };
const seed = new Uint8Array(32).fill(7);
const order = (id: string, state = "committed"): StoredSwap => ({
  orderId: id, attemptId: "0x" + "11".repeat(32), refundCounter: 0, provider: "thorchain", policy: "balanced", request: { from: { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" }, to: { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" }, amount: "500000000000000000", destination: "bc1q", slippageBps: 50 },
  params: { amount: "500000000000000000" }, endpoint: "0x" + "ab".repeat(20), createdAt: 0, state,
});

describe("swap funding", () => {
  let s: WalletSession;
  beforeEach(async () => {
    noteStore.clear(); settings.reset();
    s = new WalletSession(memoryStorage(), KDF);
    await s.create("pw");
  });

  it("abandoning an order removes its scheduled funding and marks its Activity line; the runner drops actions of closed or funded orders", async () => {
    s.update((j) => { j.swaps = [order("0xa"), order("0xb"), order("0xc")]; });
    for (const id of ["0xa", "0xb", "0xc"]) { recordActivity({ id: activityId("swap", id), kind: "swap", asset: "ETH", decimals: 18, amount: "1", status: "committed", ref: id }, s); scheduleAction({ kind: "fund-escrow", orderId: id, dueAt: 0 }, s); }
    abandonSwap("0xa", s);
    expect(pendingActions(s).map((a) => a.orderId)).toEqual(["0xb", "0xc"]);
    expect(s.journal().swaps.find((x) => x.orderId === "0xa")!.state).toBe("abandoned");
    expect(s.journal().activity!.find((r) => r.id === "swap:0xa")!.status).toBe("abandoned");
    expect(isOpenSwap({ state: "abandoned" })).toBe(false);
    // 0xb was funded by hand meanwhile: its action is dropped, not run
    patchSwap("0xb", { fundedTx: "0x" + "22".repeat(32), state: "funded" }, s);
    expect(s.journal().activity!.find((r) => r.id === "swap:0xb")!.status).toBe("funded");
    await runScheduledAction(pendingActions(s).find((a) => a.orderId === "0xb")!, { masterSeed: seed, deployment: null, session: s });
    expect(pendingActions(s).map((a) => a.orderId)).toEqual(["0xc"]);
    // 0xc is open and unfunded: the runner tries to fund it (and, with no deployment, says why it cannot)
    await expect(runScheduledAction(pendingActions(s)[0], { masterSeed: seed, deployment: null, session: s })).rejects.toThrow(/No deployment configured/);
    expect(pendingActions(s).map((a) => a.orderId), "a failed attempt keeps the action for the backoff").toEqual(["0xc"]);
    // an action whose order is gone from the journal is dropped too
    scheduleAction({ kind: "fund-escrow", orderId: "0xzz", dueAt: 0 }, s);
    await runScheduledAction(pendingActions(s).find((a) => a.orderId === "0xzz")!, { masterSeed: seed, deployment: null, session: s });
    expect(pendingActions(s).map((a) => a.orderId)).toEqual(["0xc"]);
  });

  it("fundEscrow refuses closed, funded and unconfigured orders before touching a note", async () => {
    await expect(fundEscrow({ masterSeed: seed, deployment: null, stored: order("0x1"), session: s })).rejects.toThrow(/No deployment configured/);
    const deployment = { chainId: 1, core: "0x" + "c0".repeat(20), ethVault: "0x" + "e7".repeat(20), rpcUrl: "http://127.0.0.1:1", rpcUrls: ["http://127.0.0.1:1"], fromBlock: 0n, erc20Vaults: [] } as any;
    await expect(fundEscrow({ masterSeed: seed, deployment, stored: order("0x1", "abandoned"), session: s })).rejects.toThrow(/is abandoned/);
    await expect(fundEscrow({ masterSeed: seed, deployment, stored: { ...order("0x1"), fundedTx: "0x11" }, session: s })).rejects.toThrow(/already funded/);
    await expect(fundEscrow({ masterSeed: seed, deployment, stored: order("0x1"), session: s })).rejects.toThrow(/Not enough ETH/);
    noteStore.add({ note: { vaultId: BigInt(deployment.ethVault), amount: 10n ** 18n, ownerCommitment: 1n, noteSecret: 2n }, leafIndex: 0, noteData: "0x", spent: false });
    await expect(fundEscrow({ masterSeed: seed, deployment, stored: order("0x1"), session: s }), "no factory: the escrow cannot be recomputed, nothing is funded").rejects.toThrow(/VITE_SWAP_FACTORY/);
  });
});
