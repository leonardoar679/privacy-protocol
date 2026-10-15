// What became of a funding sent for an order (a V6 follow-up of 2026-10-14). It is journaled before it is sent, and no
// runner sends another before its fate is known. Landed: its notes are spent. Pending: the relayer has a job for them,
// the node knows its transaction, or it is younger than FUNDING_SETTLE_MS. Dead: none of these. Unknown: a read failed.
import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { FUNDING_SETTLE_MS, fundingFate, type FundingReads } from "../src/swapFunding";
import type { FundingAttempt } from "../src/wallet/journal";

const NOW = 1_800_000_000_000;
const OLD = NOW - FUNDING_SETTLE_MS - 1;
const attempt = (over: Partial<FundingAttempt> = {}): FundingAttempt => ({
  nullifiers: ["11", "12"],
  by: "relayer",
  relayerUrl: "http://relayer.test",
  at: OLD,
  ...over,
});

function reads(o: { spent?: string[]; job?: boolean; known?: boolean; fail?: "spent" | "job" | "tx" } = {}): FundingReads & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    spent: async (n) => {
      asked.push(`spent:${n}`);
      if (o.fail === "spent") throw new Error("fetch failed");
      return (o.spent ?? []).includes(n.toString());
    },
    relayerJob: async (url) => {
      asked.push(`job:${url}`);
      if (o.fail === "job") throw new Error("relayer: no answer within 20 s");
      return o.job ? { txHash: `0x${"ab".repeat(32)}` as Hex } : null;
    },
    txKnown: async (hash) => {
      asked.push(`tx:${hash.slice(0, 6)}`);
      if (o.fail === "tx") throw new Error("fetch failed");
      return !!o.known;
    },
  };
}

describe("a funding's fate", () => {
  it("landed once one of its notes is spent", async () => {
    expect(await fundingFate(attempt(), reads({ spent: ["12"] }), NOW)).toBe("landed");
  });

  it("pending while the relayer has a job for its notes, the node knows its transaction, or it is young", async () => {
    expect(await fundingFate(attempt(), reads({ job: true }), NOW)).toBe("pending");
    expect(await fundingFate(attempt({ txHash: `0x${"cd".repeat(32)}` }), reads({ known: true }), NOW)).toBe("pending");
    expect(await fundingFate(attempt({ at: NOW - 1_000 }), reads(), NOW)).toBe("pending");
  });

  it("dead when old, unspent, without a job and unknown to the node: a new funding may go", async () => {
    const r = reads();
    expect(await fundingFate(attempt({ txHash: `0x${"cd".repeat(32)}` }), r, NOW)).toBe("dead");
    expect(r.asked).toEqual(["spent:11", "spent:12", "job:http://relayer.test", "tx:0xcdcd"]);
    // sent by the connected wallet: no relayer to ask
    const w = reads();
    expect(await fundingFate(attempt({ by: "wallet", relayerUrl: undefined }), w, NOW)).toBe("dead");
    expect(w.asked.some((a) => a.startsWith("job:"))).toBe(false);
    expect(FUNDING_SETTLE_MS).toBe(600_000);
  });

  it("unknown when the chain or the relayer cannot be read: never dead", async () => {
    for (const fail of ["spent", "job", "tx"] as const)
      expect(await fundingFate(attempt({ txHash: `0x${"cd".repeat(32)}` }), reads({ fail }), NOW), fail).toBe("unknown");
  });
});
