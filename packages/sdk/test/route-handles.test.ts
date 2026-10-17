// Route handles (the audit round of 2026-10-16, c41): the routes name a record by a handle derived from the wallet's seed,
// never by an id that carries an order id or a transaction hash. A handle says nothing of the id, resolves after a reload,
// differs between wallets, and is forgotten at the lock.
import { beforeAll, describe, expect, it } from "vitest";
import { configure, defaultConfig } from "../src/config";
import { memoryStorage } from "../src/wallet/storage";
import { session, WalletSession } from "../src/wallet/session";
import { idOfRoute, routeHandle } from "../src/wallet/routeHandles";
import { recordActivity } from "../src/wallet/activity";

const ORDER = "swap:0x" + "ab".repeat(32);
const TX = "withdraw:0x" + "cd".repeat(32);

beforeAll(async () => {
  configure(defaultConfig({ storage: () => memoryStorage(), kdfLog2N: 12 }));
  await session.create("a strong password");
  session.acknowledgePhrase();
  recordActivity({ id: TX, kind: "withdraw", asset: "ETH", decimals: 18, amount: "1", status: "completed", ref: TX.slice("withdraw:".length) }, session);
  session.update((j) => {
    j.swaps = [{ orderId: "0x" + "ab".repeat(32) } as never];
  });
});

describe("route handles", () => {
  it("a handle names the record without its order id or transaction hash, and resolves back to it", () => {
    for (const id of [ORDER, TX]) {
      const h = routeHandle(id);
      expect(h).toMatch(/^r[0-9a-f]{32}$/);
      expect(h).not.toContain(id.split(":0x")[1].slice(0, 8));
      expect(routeHandle(id), "the same handle every time").toBe(h);
      expect(idOfRoute(h), "resolved among the journal's records").toBe(id);
    }
    expect(routeHandle(ORDER)).not.toBe(routeHandle(TX));
    expect(idOfRoute("r" + "0".repeat(32)), "a handle of no record stays as it is").toBe("r" + "0".repeat(32));
    expect(idOfRoute(TX), "an id from before is taken as an id").toBe(TX);
  });

  it("differs between wallets, and a locked wallet resolves nothing", async () => {
    const other = new WalletSession(memoryStorage(), { N: 1 << 12, r: 8, p: 1 });
    await other.create("another strong password");
    expect(routeHandle(ORDER, other)).toMatch(/^r[0-9a-f]{32}$/);
    expect(routeHandle(ORDER, other), "another seed, another handle").not.toBe(routeHandle(ORDER));
    const h = routeHandle(ORDER);
    other.lock();
    expect(routeHandle(ORDER, other), "locked: no key").toBe(ORDER);
    expect(idOfRoute(h, other)).toBe(h);
  });
});
