// Note discovery (a V6 follow-up of 2026-10-14): the wallet looks for its notes in the pool by itself — a scheduled action
// `discovery:pool` planned at every unlock and on Activity's opening (at most once a minute), run one action at a time by
// the scheduler, repeated every ten minutes while unlocked; a private transfer received gets its Activity line once. A
// first launch stays request-free (spec v2.0 §10): the session that created the wallet asks for nothing by itself.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { configure, defaultConfig } from "../src/config";
import { memoryStorage } from "../src/wallet/storage";
import { session, WalletSession } from "../src/wallet/session";
import { recordActivity } from "../src/wallet/activity";
import type { Deployment } from "../src/chain";

const scan = vi.hoisted(() => ({ calls: 0, received: [] as { leafIndex: number; vaultId: bigint; amount: bigint; txHash: string }[], fails: false }));
vi.mock("../src/privateTx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/privateTx")>()),
  scanNotes: async () => {
    scan.calls++;
    if (scan.fails) throw new TypeError("fetch failed");
    return { scanned: 10, found: scan.received.length, added: scan.received.length, spent: 0, refunds: 0, received: scan.received };
  },
}));

import {
  DISCOVERY_ID,
  DISCOVERY_INTERVAL_MS,
  DISCOVERY_MIN_GAP_MS,
  discoverSoon,
  discoveryWanted,
  resetDiscoveryMemory,
  runDiscovery,
  scheduleDiscovery,
} from "../src/wallet/discovery";

const store = memoryStorage();
const T0 = Date.parse("2026-10-14T12:00:00Z");
const VAULT = "0x00000000000000000000000000000000000000e7";
const deployment = {
  chainId: 1,
  core: "0x00000000000000000000000000000000000000c0",
  ethVault: VAULT,
  rpcUrl: "http://127.0.0.1:1",
  rpcUrls: ["http://127.0.0.1:1"],
  fromBlock: 0n,
  erc20Vaults: [],
} as unknown as Deployment;
const action = () => session.journal().schedule.find((a) => a.id === DISCOVERY_ID);

beforeAll(async () => {
  configure(defaultConfig({ storage: () => store, kdfLog2N: 12 }));
  await session.create("a strong password");
  session.acknowledgePhrase();
});
afterEach(() => {
  session.update((j) => {
    j.schedule = [];
    j.activity = [];
  });
  scan.calls = 0;
  scan.received = [];
  scan.fails = false;
  resetDiscoveryMemory();
});

describe("note discovery", () => {
  it("a scan is planned once: a later request keeps the sooner one, a sooner one replaces it; nothing while locked", () => {
    expect(scheduleDiscovery(T0)).toBe(true);
    expect(action()).toMatchObject({ kind: "discovery", orderId: "pool", dueAt: T0 });
    expect(scheduleDiscovery(T0 + 5000), "already planned sooner").toBe(false);
    expect(action()!.dueAt).toBe(T0);
    expect(scheduleDiscovery(T0 - 5000)).toBe(true);
    expect(action()!.dueAt).toBe(T0 - 5000);
    expect(
      session.journal().schedule.filter((a) => a.kind === "discovery"),
      "one action, replaced",
    ).toHaveLength(1);
  });

  it("one scan: a private transfer received gets its Activity line (once), and the next scan is planned ten minutes on", async () => {
    scan.received = [{ leafIndex: 41, vaultId: BigInt(VAULT), amount: 25n * 10n ** 16n, txHash: "0x" + "ab".repeat(32) }];
    scheduleDiscovery(T0);
    await runDiscovery(action()!, { masterSeed: new Uint8Array(32), deployment, now: () => T0 });
    expect(scan.calls).toBe(1);
    expect(session.journal().activity).toEqual([
      expect.objectContaining({
        id: "receive:41",
        kind: "receive",
        asset: "ETH",
        decimals: 18,
        amount: "250000000000000000",
        status: "completed",
        ref: "0x" + "ab".repeat(32),
      }),
    ]);
    expect(action()).toMatchObject({ dueAt: T0 + DISCOVERY_INTERVAL_MS });
    // the same note found again (a later scan reports it only when it is new; even so, its line is not doubled)
    await runDiscovery(action()!, { masterSeed: new Uint8Array(32), deployment, now: () => T0 + DISCOVERY_INTERVAL_MS });
    expect(session.journal().activity).toHaveLength(1);
  });

  it("a first launch stays request-free until the wallet holds something; a later unlock and a phrase restore look at once", async () => {
    expect(session.isFirstLaunch(), "the session that created the wallet").toBe(true);
    expect(discoveryWanted()).toBe(false);
    expect(discoverSoon(T0), "Activity's opening asks for nothing").toBe(false);
    recordActivity({ id: "shield:0x1", kind: "shield", asset: "ETH", decimals: 18, amount: "1", status: "completed", ref: "0x1" });
    expect(discoveryWanted(), "it holds something now").toBe(true);
    session.update((j) => {
      j.activity = [];
    });
    session.lock();
    expect(await session.unlock("a strong password")).toBe(true);
    expect(session.isFirstLaunch()).toBe(false);
    expect(discoveryWanted(), "any later unlock").toBe(true);
    const other = new WalletSession(memoryStorage(), { N: 1 << 12, r: 8, p: 1 });
    const phrase = await other.create("another password");
    expect(other.isFirstLaunch()).toBe(true);
    await other.restoreFromPhrase(phrase, "a new password", { replace: true }); // over the wallet it holds: the typed REPLACE (audit round 2, r27)
    expect(other.isFirstLaunch(), "a restore looks for its notes at once").toBe(false);
  });

  it("Activity's opening asks for a scan at most once a minute; no deployment, no scan; a failed scan is the scheduler's backoff", async () => {
    scheduleDiscovery(T0);
    await runDiscovery(action()!, { masterSeed: new Uint8Array(32), deployment, now: () => T0 });
    expect(discoverSoon(T0 + DISCOVERY_MIN_GAP_MS - 1), "a scan ran a moment ago").toBe(false);
    expect(discoverSoon(T0 + DISCOVERY_MIN_GAP_MS)).toBe(true);
    expect(action()!.dueAt).toBe(T0 + DISCOVERY_MIN_GAP_MS);
    await runDiscovery(action()!, { masterSeed: new Uint8Array(32), deployment: null });
    expect(scan.calls, "nothing to look in").toBe(1);
    scan.fails = true;
    await expect(runDiscovery(action()!, { masterSeed: new Uint8Array(32), deployment })).rejects.toThrow(/fetch failed/);
  });
});
