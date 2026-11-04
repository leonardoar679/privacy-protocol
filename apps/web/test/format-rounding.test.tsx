// @vitest-environment happy-dom
// A balance and an amount received never read more than there is (audit round 2, the critic's area 7): packages/ui's own
// rule rounds them down, but the screens passed no rounding, and the default rounds to nearest — Home's assets, the
// balances under the amount fields, "Recipient receives", "You receive" and a cross-chain minimum could each show one
// display unit more than the wallet held or the payee would get.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Amt } from "../src/features/viewKit";

afterEach(cleanup);
const eth = (units: bigint) => ({ units, symbol: "ETH", decimals: 18, displayDecimals: 4 });

describe("amounts that must not read more than there is (audit round 2, the critic's area 7)", () => {
  it("round down where the screens ask it; an approximation keeps the nearest", () => {
    // 1.23456 ETH: four decimals shown
    const a = eth(1_234_560_000_000_000_000n);
    expect(render(<Amt a={a} rounding="down" />).container.textContent).toContain("1.2345");
    cleanup();
    expect(render(<Amt a={a} />).container.textContent, "the default, as before").toContain("1.2346");
  });

  it("a minimum or an arrived amount in a sentence rounds down too (the seventh review round)", async () => {
    const { displayAmount } = await import("../src/features/amounts");
    const a = { units: 123_456_789n, decimals: 8, displayDecimals: 4, symbol: "BTC" };
    expect(displayAmount(a, "down")).toBe("1.2345");
    expect(displayAmount(a)).toBe("1.2346");
  });
  it("the money screens pass it: Home, Protect, Send, Swap and the Review's exact amount", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    // node's path, never the global URL: happy-dom replaces it
    const here = dirname(fileURLToPath(import.meta.url));
    const read = (p: string) => readFileSync(join(here, "../src/features", p), "utf8");
    expect(read("home/View.tsx")).toContain('amount={<Amt a={x.amount} rounding="down" />}');
    expect(read("protect/View.tsx").match(/rounding="down"/g)?.length).toBe(3);
    expect(read("send/View.tsx").match(/rounding="down"/g)?.length).toBe(2);
    expect(read("swap/View.tsx")).toContain('<Amt a={q.minimum} bare rounding="down" />');
    expect(read("swap/View.tsx")).toContain('<Amt a={m.pay.balance} rounding="down" />');
    expect(read("review/View.tsx")).toContain('rounding={m.receive.approx ? undefined : "down"}');
  });
});
