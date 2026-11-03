// The chain-key cache goes with the lock (the fifth review round, 2026-11-03): the session zeroes its seed, and the cache's copy
// of it and the 64-byte BIP-32 root it derives had stayed in the heap until the collector came.
import { describe, expect, it } from "vitest";
import { configure, defaultConfig } from "../src/config";
import { session } from "../src/wallet/session";
import { chainSeed } from "../src/keys/chainKeys";
import { memoryStorage } from "../src/wallet/storage";

describe("the chain-key cache at a lock", () => {
  it("the cached BIP-32 root is zeroed in place at the lock, and the next unlock derives it again", async () => {
    const store = memoryStorage();
    configure(defaultConfig({ storage: () => store, kdfLog2N: 12 }));
    await session.create("pw");
    const seed = session.state().seed!;
    const root = chainSeed(seed);
    expect(root.some((b) => b !== 0)).toBe(true);
    const copy = root.slice();
    expect(chainSeed(seed), "cached: the same object").toBe(root);
    session.lock();
    expect(
      root.every((b) => b === 0),
      "the cached root is zeroed",
    ).toBe(true);
    expect(
      seed.every((b) => b === 0),
      "the session's seed is zeroed",
    ).toBe(true);
    expect(await session.unlock("pw")).toBe(true);
    const again = chainSeed(session.state().seed!);
    expect(again).not.toBe(root);
    expect([...again]).toEqual([...copy]);
    session.forget();
  });
});
