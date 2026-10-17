// Fetch-all log reads in windows (the audit round of 2026-10-16, c32): every tree sync read the core's events with one
// eth_getLogs from the deployment block, and once the pool passes an RPC provider's caps that request is refused — no
// spend, funding or scan could run. One request still serves an endpoint that takes it; one refused for its size is read
// in windows, halved again on a refusal. Offline: a fake endpoint with a cap.
import { describe, expect, it } from "vitest";
import { logsInWindows } from "../src/chain";

/** An endpoint holding one log per block from 0 to `head`, refusing a range of more than `cap` blocks as providers do. */
function endpoint(head: bigint, cap: bigint | null, words = "query returned more than 10000 results") {
  const asked: [bigint, bigint | "latest"][] = [];
  return {
    asked,
    client: { getBlockNumber: async () => head },
    read: async (from: bigint, to: bigint | "latest") => {
      asked.push([from, to]);
      const end = to === "latest" ? head : to;
      if (cap !== null && end - from + 1n > cap) throw Object.assign(new Error("HTTP request failed"), { cause: new Error(words) });
      const out: bigint[] = [];
      for (let b = from; b <= end; b++) out.push(b);
      return out;
    },
  };
}

describe("fetch-all logs", () => {
  it("one request while the endpoint takes it", async () => {
    const e = endpoint(25_000n, null);
    const logs = await logsInWindows(e.client, 100n, e.read);
    expect(logs).toHaveLength(24_901);
    expect(e.asked).toEqual([[100n, "latest"]]);
  });

  it("refused for its size: read in windows, halved again where a window is refused too, every block once", async () => {
    const e = endpoint(25_000n, 3_000n, "Log response size exceeded. You can make eth_getLogs requests with up to a 2K block range");
    const logs = await logsInWindows(e.client, 100n, e.read, 10_000n);
    expect(logs).toHaveLength(24_901);
    expect(new Set(logs.map(String)).size, "no block twice").toBe(24_901);
    expect(logs[0]).toBe(100n);
    expect(logs.at(-1)).toBe(25_000n);
    expect(e.asked.slice(0, 3), "the whole history, then 10,000, then 5,000, then 2,500").toEqual([
      [100n, "latest"],
      [100n, 10_099n],
      [100n, 5_099n],
    ]);
  });

  it("any other failure is the caller's: never read in windows", async () => {
    const e = endpoint(25_000n, 1n, "execution reverted");
    await expect(logsInWindows(e.client, 0n, e.read)).rejects.toThrow(/HTTP request failed/);
    expect(e.asked).toHaveLength(1);
  });
});
