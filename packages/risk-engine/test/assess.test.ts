// The risk assessment (doc §47–§48; spec v2.0 §13.4): each of the eight blockers on its own fact, every blocker makes the
// assessment high at 100, a clean route is low with no warning, the concerns raise their warnings and add up to medium or
// high, and the score stays within 0–100 whatever the facts.
import { describe, expect, it } from "vitest";
import { BLOCKER_CODES, WARNING_CODES, assessRisk, blockersOf, riskLevelOf, type BlockerCode, type RiskFacts } from "../src/index";

const NOW = 1_800_000_000_000;
const clean = (): RiskFacts => ({
  now: NOW,
  quote: {
    fetchedAt: NOW - 5_000,
    expiresAt: NOW + 55_000,
    minimumOut: 1_000n,
    approvedMinimum: 1_000n,
    impactBps: 10,
    slippageBps: 50,
    parametersMatch: true,
  },
  asset: { status: "supported" },
  destination: { valid: true },
  provider: { healthy: true, recentFailures: 0, liquidityUsd: 10_000_000 },
  network: { expectedChainId: 1, chainId: 1 },
  call: { verified: true },
  execution: { steps: 1, crossChain: false },
  usd: 10_000,
  largeTrade: false,
});

const ONE_BLOCKER: Record<BlockerCode, (f: RiskFacts) => void> = {
  quote_expired: (f) => {
    f.now = f.quote.expiresAt;
  },
  asset_unsupported: (f) => {
    f.asset.status = "temporarily-unavailable";
  },
  destination_invalid: (f) => {
    f.destination.valid = false;
  },
  provider_unhealthy: (f) => {
    f.provider.healthy = false;
  },
  minimum_below_limit: (f) => {
    f.quote.minimumOut = f.quote.approvedMinimum - 1n;
  },
  parameters_changed: (f) => {
    f.quote.parametersMatch = false;
  },
  network_mismatch: (f) => {
    f.network.chainId = 8453;
  },
  unsafe_contract_call: (f) => {
    f.call = { verified: false };
  },
};

describe("assessRisk (doc §47–§48)", () => {
  it("a clean same-chain route is low, with no blocker and no warning", () => {
    expect(assessRisk(clean())).toEqual({ score: 0, level: "low", blockers: [], warnings: [] });
  });

  it("each blocker fires on its own fact alone, and any blocker makes the score 100 and the level high", () => {
    expect(Object.keys(ONE_BLOCKER).sort()).toEqual([...BLOCKER_CODES].sort());
    for (const code of BLOCKER_CODES) {
      const f = clean();
      ONE_BLOCKER[code](f);
      expect(blockersOf(f), code).toEqual([code]);
      expect(assessRisk(f), code).toMatchObject({ score: 100, level: "high", blockers: [code] });
    }
  });

  it("an unsupported asset blocks like a temporarily unavailable one; a connected wallet on no chain yet is no mismatch; no call yet is no unsafe call", () => {
    const f = clean();
    f.asset.status = "unsupported";
    expect(blockersOf(f)).toEqual(["asset_unsupported"]);
    const g = clean();
    g.network.chainId = null;
    delete g.call;
    expect(blockersOf(g)).toEqual([]);
  });

  it("several blockers come back in the order of BLOCKER_CODES", () => {
    const f = clean();
    ONE_BLOCKER.unsafe_contract_call(f);
    ONE_BLOCKER.quote_expired(f);
    ONE_BLOCKER.network_mismatch(f);
    expect(assessRisk(f).blockers).toEqual(["quote_expired", "network_mismatch", "unsafe_contract_call"]);
  });

  it("the concerns raise their warnings: an aging quote, thin liquidity, impact, slippage, steps, a second chain, a busy network, recent failures, a large trade", () => {
    const f = clean();
    f.now = f.quote.fetchedAt + 0.9 * (f.quote.expiresAt - f.quote.fetchedAt);
    f.provider.liquidityUsd = 100_000;
    f.quote.impactBps = 150;
    f.quote.slippageBps = 200;
    f.execution = { steps: 3, crossChain: true };
    f.network.busy = true;
    f.provider.recentFailures = 2;
    f.largeTrade = true;
    const a = assessRisk(f);
    expect(a.blockers).toEqual([]);
    expect(a.warnings).toEqual([...WARNING_CODES]);
    expect(a.level).toBe("high");
    expect(a.score).toBeLessThan(100);
  });

  it("a cross-chain route with one busy network is medium; the level boundaries are 30 and 60", () => {
    const f = clean();
    f.execution = { steps: 2, crossChain: true };
    f.network.busy = true;
    f.largeTrade = true;
    expect(assessRisk(f)).toMatchObject({ score: 30, level: "medium", warnings: ["multi_step", "cross_chain", "network_busy", "large_trade"] });
    expect([riskLevelOf(0), riskLevelOf(29), riskLevelOf(30), riskLevelOf(59), riskLevelOf(60), riskLevelOf(100)]).toEqual([
      "low",
      "low",
      "medium",
      "medium",
      "high",
      "high",
    ]);
  });

  it("the score stays within 0–100 over seeded random facts, and a blocker is always 100", () => {
    let x = 0x2545f491;
    const rnd = () => (x = (x * 1103515245 + 12345) >>> 0) / 2 ** 32;
    for (let i = 0; i < 2_000; i++) {
      const f = clean();
      f.now = f.quote.fetchedAt + Math.floor(rnd() * 120_000);
      f.quote.impactBps = Math.floor(rnd() * 1_000);
      f.quote.slippageBps = Math.floor(rnd() * 1_000);
      f.provider.recentFailures = Math.floor(rnd() * 10);
      f.provider.liquidityUsd = rnd() < 0.2 ? undefined : rnd() * 1e7;
      f.usd = rnd() * 1e6;
      f.execution = { steps: 1 + Math.floor(rnd() * 6), crossChain: rnd() < 0.5 };
      f.network.busy = rnd() < 0.3;
      f.largeTrade = rnd() < 0.3;
      const a = assessRisk(f);
      expect(a.score).toBeGreaterThanOrEqual(0);
      expect(a.score).toBeLessThanOrEqual(100);
      expect(a.level).toBe(riskLevelOf(a.score));
      if (a.blockers.length) expect(a.score).toBe(100);
      for (const w of a.warnings) expect(WARNING_CODES).toContain(w);
    }
  });
});
