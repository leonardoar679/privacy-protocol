// The eleventh review round (2026-11-04), part A — the wallet at rest after round 10. One rule for where the fresh addresses resume, with a
// draw past the reserve (F11-7: two restores of one source had resumed at the same index), applied by a merge too when the backup knows more
// than this device (VF-N1) or than the restore that began this device's journal (NF-1); the backup's settings, every protective control at the
// stricter of the two, its fingerprints and its funding facts kept (A11-1); no maintenance action from a backup (A11-9); Receive offers only an
// address this installation reserved (A11-11). The session at rest: an export never carries a journal this wallet cannot open (A11-4); a load
// replaces the settings and an unlock that finds the wallet gone says so (A11-6); a restore's two records in one write (A11-7); this wallet's own
// set-aside journal read by a backup restore (A11-8); the published test phrases refused (A11-11); an opening zeroes the seed it replaces. The
// reviewer's and the verifiers' probes (scratchpad review11/A, VA, F, VF) became these cases.
import { describe, expect, it } from "vitest";
import { configure, defaultConfig } from "../src/config";
import { WalletSession, session } from "../src/wallet/session";
import { memoryStorage, JOURNAL_KEY, KEYSTORE_KEY, UNREADABLE_JOURNAL_KEY, type KeyValueStorage } from "../src/wallet/storage";
import { seedToPhrase } from "../src/wallet/keystore";
import {
  ADDRESS_INDEX_RESERVE,
  AI_FUNDING_RESERVE,
  decryptJournal,
  emptyJournal,
  journalKey,
  restoredJournal,
  resumePast,
  type EncryptedJournal,
  type JournalData,
  type StoredSwap,
} from "../src/wallet/journal";
import { mergeJournals } from "../src/wallet/journalMerge";
import { defaultSettings, holdsNoChoice, mergeSettings, settings } from "../src/wallet/settings";
import { lastUnusedFreshAddress } from "../src/keys/chainKeys";
import { findEntry } from "../src/wallet/addressBook";
import { scheduleAction } from "../src/wallet/schedule";
import { orderIsOurs } from "../src/swapFunding";
import { deriveOrderKey, deriveRefundNote } from "../src/keys/swapKeys";
import { isPublicSeed } from "@privacy-wallet/protocol/keys";
import type { Hex } from "viem";

const KDF = { N: 1 << 12, r: 8, p: 1 };
const swap = (orderId: string, extra: Partial<StoredSwap> = {}) =>
  ({
    orderId,
    attemptId: "0x01",
    refundCounter: 3,
    state: "committed",
    params: {},
    request: {},
    createdAt: 0,
    provider: "thorchain",
    policy: "balanced",
    endpoint: "0x" + "e5".repeat(20),
    ...extra,
  }) as unknown as StoredSwap;
const within = (v: number, known: number, reserve: number) => v >= known + reserve && v < known + 2 * reserve;
const journal = (o: Partial<JournalData>): JournalData => ({ ...emptyJournal(), ...o });

describe("where the fresh addresses resume (F11-7)", () => {
  it("past the reserve, plus a draw of up to another: two restores of one source part", () => {
    expect(resumePast(7, 1000, () => 0)).toBe(1007);
    expect(resumePast(7, 1000, () => 0.9999999)).toBe(2006);
    expect(
      resumePast(7, 1000, () => 1),
      "never a whole second reserve",
    ).toBe(2006);
    const a = restoredJournal(journal({ chainIndexes: { bitcoin: 12 }, aiFunding: { index: 4 } }), () => 0.25);
    const b = restoredJournal(journal({ chainIndexes: { bitcoin: 12 }, aiFunding: { index: 4 } }), () => 0.75);
    expect([a.chainIndexes.bitcoin, b.chainIndexes.bitcoin]).toEqual([1262, 1762]);
    expect([a.aiFunding?.index, b.aiFunding?.index]).toEqual([129, 179]);
    expect(a.resumedPast, "what the restore's source knew, past which it resumed").toEqual({ chainIndexes: { bitcoin: 12 }, aiFunding: 4 });
  });

  it("a phrase restore resumes every chain and Private AI at a draw past the reserve — restores of one phrase at different points (the critique, T1)", async () => {
    const evm: number[] = [];
    const ai: number[] = [];
    for (let i = 0; i < 4; i++) {
      const s = new WalletSession(memoryStorage(), KDF);
      await s.restoreFromPhrase(seedToPhrase(new Uint8Array(32).fill(4)), "a password");
      expect(within(s.journal().chainIndexes.evm, 0, ADDRESS_INDEX_RESERVE)).toBe(true);
      expect(within(s.journal().aiFunding!.index, 0, AI_FUNDING_RESERVE)).toBe(true);
      evm.push(s.journal().chainIndexes.evm);
      ai.push(s.journal().aiFunding!.index);
      s.lock();
    }
    // a fixed resume point — the reserve exactly, the earlier rule — handed the first restore's addresses out again at the next
    expect(new Set(evm).size, "four restores, not one resume point").toBeGreaterThan(1);
    expect(evm.every((v) => v === ADDRESS_INDEX_RESERVE)).toBe(false);
    expect(new Set(ai).size).toBeGreaterThan(1);
  });
});

describe("a backup merged into this device's journal (VF-N1, NF-1, A11-1, A11-9)", () => {
  it("an index the backup knows past this device resumes past the reserve; one this device is ahead on stays", () => {
    const m = mergeJournals(
      journal({ chainIndexes: { evm: 7, bitcoin: 2 } }),
      journal({ chainIndexes: { evm: 3, bitcoin: 1003 }, aiFunding: { index: 120 } }),
      () => 0,
    );
    expect(m.chainIndexes).toMatchObject({ evm: 7, bitcoin: 2003 });
    expect(m.aiFunding?.index).toBe(120 + AI_FUNDING_RESERVE);
    // what the device and the backup knew, recorded once the merge resumed past the backup (the twelfth review round, E12-2): the next backup
    // is compared with it, never with the resume point
    expect(m.resumedPast).toEqual({ chainIndexes: { evm: 7, bitcoin: 1003 }, aiFunding: 120 });
  });

  it("over a journal a restore began, the backup is compared with what that restore's source knew — never with the resume point, a guess", () => {
    const device = restoredJournal(emptyJournal(), () => 0.9); // a phrase restore: resumed at 1900, knowing nothing
    const m = mergeJournals(device, journal({ chainIndexes: { bitcoin: 1500 }, aiFunding: { index: 120 } }), () => 0);
    expect(m.chainIndexes.bitcoin, "past the backup's reserve, as the backup alone resumes").toBe(2500);
    expect(m.aiFunding?.index).toBe(220);
    expect(m.chainIndexes.evm, "a chain the backup never used keeps the device's").toBe(device.chainIndexes.evm);
    expect(m.resumedPast).toEqual({ chainIndexes: { bitcoin: 1500 }, aiFunding: 120 });
    const again = mergeJournals(m, journal({ chainIndexes: { bitcoin: 1500 }, aiFunding: { index: 120 } }), () => 0);
    expect(again.chainIndexes.bitcoin, "the same backup again moves nothing").toBe(2500);
  });

  it("through the session: a phrase restore, then the backup — the backup's later addresses never offered again", async () => {
    const SEED = new Uint8Array(32).fill(41);
    const first = memoryStorage();
    configure(defaultConfig({ storage: () => first, kdfLog2N: 12 }));
    session.lock();
    await session.create("pw", SEED, { replace: true });
    session.acknowledgePhrase();
    session.update((j) => {
      j.chainIndexes.bitcoin = 1500;
      j.aiFunding = { index: 120, funded: 119 };
    });
    const backup = session.exportBackup();
    session.forget();
    const second = memoryStorage();
    configure(defaultConfig({ storage: () => second, kdfLog2N: 12 }));
    await session.restoreFromPhrase(seedToPhrase(SEED), "pw2");
    session.acknowledgePhrase();
    session.lock();
    expect(await session.restoreFromBackup(backup, "pw", { replace: true })).toBe(true);
    expect(within(session.journal().chainIndexes.bitcoin, 1500, ADDRESS_INDEX_RESERVE)).toBe(true);
    expect(within(session.journal().aiFunding!.index, 120, AI_FUNDING_RESERVE)).toBe(true);
    session.forget();
  });

  it("the backup's settings where this device's journal has none; with both, each protective control at the stricter of the two", () => {
    const backup = {
      secondFactor: { enabled: true, credentialId: "cred-A" },
      protection: { mode: "max-safety", pauseLargeOperations: true, velocity: { maxUsdPer24h: 50_000 }, secondDevice: { enabled: false } },
      submission: { kind: "relayer", url: "https://mine.example" },
    };
    expect(mergeJournals(journal({}), journal({ settings: backup as never })).settings, "a phrase restore's journal has no settings").toEqual(backup);
    const device = {
      secondFactor: { enabled: false },
      protection: { mode: "balanced", pauseLargeOperations: false, velocity: { maxUsdPer24h: 80_000 }, capBps: 250, enabled: false },
      submission: { kind: "relayer", url: "https://chosen-here.example" },
      autoLockMinutes: 5,
    };
    const m = mergeSettings(device as never, { ...backup, protection: { ...backup.protection, capBps: 100 } } as never)!;
    expect(m.secondFactor).toEqual({ enabled: true, credentialId: "cred-A" });
    expect(m.protection).toMatchObject({ mode: "max-safety", pauseLargeOperations: true, velocity: { maxUsdPer24h: 50_000 }, capBps: 100, enabled: true });
    expect(m.submission, "the device's own choices stand").toEqual({ kind: "relayer", url: "https://chosen-here.example" });
    expect(m.autoLockMinutes).toBe(5);
    expect(mergeSettings(device as never, undefined)).toBe(device);
  });

  it("a journal whose settings hold no choice — the defaults but the experience and the first-time explanation, which the device mirrors by itself — takes the backup's whole (the critique, K3-1)", () => {
    expect(holdsNoChoice(undefined)).toBe(true);
    expect(holdsNoChoice({ ...defaultSettings(), advanced: true })).toBe(true);
    expect(holdsNoChoice({ ...defaultSettings(), advanced: true, protection: { ...defaultSettings().protection, introSeenAt: 5 } })).toBe(true);
    expect(holdsNoChoice({ ...defaultSettings(), autoLockMinutes: 1 })).toBe(false);
    expect(holdsNoChoice({ ...defaultSettings(), submission: { kind: "wallet" } })).toBe(false);
    const backup = {
      ...defaultSettings(),
      submission: { kind: "relayer" as const, url: "https://mine.example" },
      autoLockMinutes: 1 as const,
      housekeeping: { enabled: false, dailyFeeCapWei: "1" },
    };
    const m = mergeSettings({ ...defaultSettings(), advanced: true }, backup)!;
    expect(m).toMatchObject({ submission: backup.submission, autoLockMinutes: 1, housekeeping: { enabled: false }, advanced: true });
  });

  it("with both holding choices: the tiers, the auto-lock, the exposure caps, the switches and maintenance at the stricter (the critique, K3-1, T5)", () => {
    const d = defaultSettings();
    const device = {
      ...d,
      submission: { kind: "relayer" as const, url: "https://here.example" },
      autoLockMinutes: 5 as const,
      verifyReads: false,
      tiers: { ...d.tiers, enhanced: 80_000, highValue: 2_000_000 },
      protection: { ...d.protection, autoReroute: true, providerShareCapBps: 5000 },
    };
    const backup = {
      ...d,
      autoLockMinutes: 1 as const,
      tiers: { ...d.tiers, highValue: 600_000, highValueSecondary: 3_000_000 },
      housekeeping: { enabled: false, dailyFeeCapWei: "1000" },
      protection: {
        ...d.protection,
        secondDevice: { enabled: true, credentialId: "dev-B" },
        protectFromEnhanced: true,
        stepsAtBand: true,
        providerShareCapBps: 3000,
      },
    };
    const m = mergeSettings(device, backup)!;
    expect(m.submission, "the device's own choice stands").toEqual(device.submission);
    expect(m.autoLockMinutes, "the shorter idle lock").toBe(1);
    expect(m.verifyReads).toBe(true);
    expect(m.tiers, "each threshold the lower").toMatchObject({ enhanced: 80_000, highValue: 600_000, highValueSecondary: 3_000_000 });
    expect(m.housekeeping, "maintenance only where both had it, under the lower cap").toEqual({ enabled: false, dailyFeeCapWei: "1000" });
    expect(m.protection).toMatchObject({
      secondDevice: { enabled: true, credentialId: "dev-B" },
      protectFromEnhanced: true,
      stepsAtBand: true,
      autoReroute: false,
      providerShareCapBps: 3000,
    });
    // an absent in-flight cap is the band's default, not "none": against an explicit 300 it counts as the lowest band default (2 %)
    const capOf = (a?: number, b?: number) =>
      mergeSettings(
        { ...device, protection: { ...device.protection, ...(a ? { capBps: a } : {}) } },
        { ...backup, protection: { ...backup.protection, ...(b ? { capBps: b } : {}) } },
      )!.protection!.capBps;
    expect(capOf(undefined, 300)).toBe(200);
    expect(capOf(300, undefined)).toBe(200);
    expect(capOf(150, undefined)).toBe(150);
    expect(capOf(400, 300)).toBe(300);
    expect(capOf(undefined, undefined)).toBeUndefined();
  });

  it("the stricter in both directions: a device stricter than the backup keeps its own controls; a holds-no-choice device keeps its first-time explanation (the second critique, T2-5)", () => {
    const d = defaultSettings();
    const device = {
      ...d,
      submission: { kind: "relayer" as const, url: "https://here.example" },
      verifyReads: true,
      secondFactor: { enabled: true, credentialId: "factor-here" },
      housekeeping: { enabled: false, dailyFeeCapWei: "500" },
      protection: {
        ...d.protection,
        secondDevice: { enabled: true, credentialId: "device-here" },
        pauseLargeOperations: true,
        enabled: true,
        velocity: { maxUsdPer24h: 10_000 },
        providerShareCapBps: 2000,
        protectFromEnhanced: true,
        stepsAtBand: true,
        autoReroute: false,
      },
    };
    const backup = {
      ...d,
      verifyReads: false,
      secondFactor: { enabled: false },
      housekeeping: { enabled: true, dailyFeeCapWei: "9000" },
      protection: {
        ...d.protection,
        secondDevice: { enabled: false },
        pauseLargeOperations: false,
        enabled: false,
        velocity: { maxUsdPer24h: 90_000 },
        providerShareCapBps: 8000,
        protectFromEnhanced: false,
        autoReroute: true,
      },
    };
    const m = mergeSettings(device, backup)!;
    expect(m.verifyReads).toBe(true);
    expect(m.secondFactor).toEqual({ enabled: true, credentialId: "factor-here" });
    expect(m.housekeeping).toEqual({ enabled: false, dailyFeeCapWei: "500" });
    expect(m.protection).toMatchObject({
      secondDevice: { enabled: true, credentialId: "device-here" },
      pauseLargeOperations: true,
      enabled: true,
      velocity: { maxUsdPer24h: 10_000 },
      providerShareCapBps: 2000,
      protectFromEnhanced: true,
      stepsAtBand: true,
      autoReroute: false,
    });
    const shown = mergeSettings({ ...d, protection: { ...d.protection, introSeenAt: 7 } }, { ...backup, autoLockMinutes: 1 })!;
    expect(shown.autoLockMinutes, "the backup's whole").toBe(1);
    expect(shown.protection?.introSeenAt, "the device's first-time explanation kept").toBe(7);
  });

  it("through the session: a phrase restore, the experience mirrored at its first unlock, then the backup — the relayer, the tiers, the idle lock and maintenance come back (the critique, K3-1, T4)", async () => {
    const SEED = new Uint8Array(32).fill(47);
    const first = memoryStorage();
    configure(defaultConfig({ storage: () => first, kdfLog2N: 12 }));
    session.lock();
    await session.create("pw", SEED, { replace: true });
    session.acknowledgePhrase();
    const tiers = { ...settings.get().tiers, enhanced: 60_000, highValue: 200_000, highValueSecondary: 400_000, institutional: 800_000 };
    settings.set({
      submission: { kind: "relayer", url: "https://relayer.mine.example" },
      autoLockMinutes: 1,
      tiers,
      housekeeping: { enabled: false, dailyFeeCapWei: "0" },
    });
    const backup = session.exportBackup();
    session.forget();
    const second = memoryStorage();
    configure(defaultConfig({ storage: () => second, kdfLog2N: 12 }));
    await session.restoreFromPhrase(seedToPhrase(SEED), "pw2");
    session.acknowledgePhrase();
    settings.set({ advanced: true }); // apps/web Gate.tsx mirrorExperience at the first unlock: the defaults journaled with it
    session.lock();
    expect(await session.restoreFromBackup(backup, "pw", { replace: true })).toBe(true);
    expect(settings.get().submission).toEqual({ kind: "relayer", url: "https://relayer.mine.example" });
    expect(settings.get().autoLockMinutes).toBe(1);
    expect(settings.get().tiers).toMatchObject({ enhanced: 60_000, highValue: 200_000, institutional: 800_000 });
    expect(settings.get().housekeeping.enabled).toBe(false);
    expect(settings.get().advanced, "the device's experience").toBe(true);
    session.forget();
  });

  it("through the session: a phrase restore, then the backup over it — the second factor, the limit, the mode and the relayer come back", async () => {
    const SEED = new Uint8Array(32).fill(43);
    const first = memoryStorage();
    configure(defaultConfig({ storage: () => first, kdfLog2N: 12 }));
    session.lock();
    await session.create("pw", SEED, { replace: true });
    session.acknowledgePhrase();
    settings.set({
      secondFactor: { enabled: true, credentialId: "cred-A" },
      submission: { kind: "relayer", url: "https://relayer.mine.example" },
      protection: { ...settings.get().protection, mode: "max-safety", velocity: { maxUsdPer24h: 50_000 }, pauseLargeOperations: true },
    });
    const backup = session.exportBackup();
    session.forget();
    const second = memoryStorage();
    configure(defaultConfig({ storage: () => second, kdfLog2N: 12 }));
    await session.restoreFromPhrase(seedToPhrase(SEED), "pw2");
    session.acknowledgePhrase();
    session.lock();
    expect(await session.restoreFromBackup(backup, "pw", { replace: true })).toBe(true);
    expect(settings.get().secondFactor).toEqual({ enabled: true, credentialId: "cred-A" });
    expect(settings.get().submission).toEqual({ kind: "relayer", url: "https://relayer.mine.example" });
    expect(settings.get().protection).toMatchObject({ mode: "max-safety", velocity: { maxUsdPer24h: 50_000 }, pauseLargeOperations: true });
    session.forget();
  });

  it("an order both journals hold keeps the funding facts only the backup's row has; fingerprints and the light client where the device has none", () => {
    const attempt = { nullifiers: ["1", "2"], by: "relayer", at: 5 };
    const m = mergeJournals(
      journal({ swaps: [swap("0xAA")], deploymentFingerprints: { "1": "fp-device" } }),
      journal({
        swaps: [swap("0xaa", { fundingAttempt: attempt as never, fundedTx: "0x" + "ab".repeat(32), jobId: "job-1", state: "funded" })],
        deploymentFingerprints: { "1": "fp-backup", "8453": "fp-base" },
        lightClient: { chainId: "1", snapshot: { x: 1 } },
      }),
    );
    expect(m.swaps).toHaveLength(1);
    expect(m.swaps[0]).toMatchObject({ orderId: "0xAA", fundingAttempt: attempt, fundedTx: "0x" + "ab".repeat(32), jobId: "job-1", state: "committed" });
    expect(m.deploymentFingerprints, "the device's first-seen fingerprint stands").toEqual({ "1": "fp-device", "8453": "fp-base" });
    expect(m.lightClient).toEqual({ chainId: "1", snapshot: { x: 1 } });
  });

  it("never brings a maintenance action back from a backup (A11-9): a cancelled one had come back pending", async () => {
    const s = new WalletSession(memoryStorage(), KDF);
    await s.create("pw", new Uint8Array(32).fill(6));
    s.acknowledgePhrase();
    scheduleAction({ kind: "housekeeping", orderId: "balance:1", dueAt: 1 }, s);
    const backup = s.exportBackup();
    s.update((j) => {
      j.schedule = [];
    });
    s.lock();
    expect(await s.restoreFromBackup(backup, "pw", { replace: true })).toBe(true);
    expect(s.journal().schedule.some((a) => a.kind === "housekeeping")).toBe(false);
    s.lock();
  });
});

describe("Receive right after a restore (A11-11)", () => {
  it("offers no address this installation never reserved: the screen asks for a new one", async () => {
    const store = memoryStorage();
    configure(defaultConfig({ storage: () => store, kdfLog2N: 12 }));
    session.lock();
    await session.restoreFromPhrase(seedToPhrase(new Uint8Array(32).fill(11)), "a password", { replace: true });
    session.acknowledgePhrase();
    const index = session.journal().chainIndexes.bitcoin;
    expect(findEntry("bitcoin", "anything"), "nothing reserved yet").toBeNull();
    expect(lastUnusedFreshAddress(session.state().seed!, "bitcoin"), `index ${index - 1} is none of this installation's`).toBeNull();
    session.forget();
  });
});

describe("the session at rest", () => {
  it("a backup taken while the journal does not open carries none — and restores (A11-4)", async () => {
    const other = new WalletSession(memoryStorage(), KDF);
    await other.create("other password", new Uint8Array(32).fill(9));
    other.acknowledgePhrase();
    const otherJournal = JSON.parse(other.exportBackup()).journal;
    other.lock();
    const store = memoryStorage();
    const s = new WalletSession(store, KDF);
    await s.create("my password", new Uint8Array(32).fill(5));
    s.acknowledgePhrase();
    s.lock();
    store.set(JOURNAL_KEY, JSON.stringify(otherJournal));
    expect(await s.unlock("my password")).toBe(true);
    expect(s.state().journalUnreadable).toBe(true);
    const backup = JSON.parse(s.exportBackup()) as { journal: unknown };
    expect(backup.journal, "the unreadable journal is not exported").toBeNull();
    s.lock();
    const fresh = new WalletSession(memoryStorage(), KDF);
    expect(await fresh.restoreFromBackup(JSON.stringify(backup), "my password")).toBe(true);
    fresh.lock();
  });

  it("a Forget in another tab: the locked tab's unlock emits the wallet gone; the next wallet there starts on the defaults (A11-6)", async () => {
    const store = memoryStorage();
    configure(defaultConfig({ storage: () => store, kdfLog2N: 12 }));
    session.lock();
    await session.create("password of A", new Uint8Array(32).fill(3), { replace: true });
    session.acknowledgePhrase();
    settings.set({
      autoLockMinutes: 60,
      submission: { kind: "relayer", url: "https://relayer.of-wallet-a.example" },
      secondFactor: { enabled: true, credentialId: "credential-of-A" },
    });
    session.lock();
    store.remove(KEYSTORE_KEY);
    store.remove(JOURNAL_KEY);
    const statuses: string[] = [];
    const off = session.subscribe(() => statuses.push(session.state().status));
    expect(await session.unlock("password of A")).toBe(false);
    off();
    expect(statuses, "the screens hear the wallet is gone").toContain("none");
    await session.create("password of C", undefined, { replace: true });
    session.acknowledgePhrase();
    expect(settings.get().secondFactor, "none of A's").toEqual({ enabled: false });
    expect(settings.get().autoLockMinutes).toBeUndefined();
    settings.set({ advanced: true });
    const jC = decryptJournal(journalKey(session.state().seed!), JSON.parse(store.get(JOURNAL_KEY)!) as EncryptedJournal)!;
    expect((jC.settings as { submission?: { url?: string } })?.submission?.url).not.toBe("https://relayer.of-wallet-a.example");
    session.forget();
  });

  it("a backup restore writes its keystore and its journal in one write (A11-7): a crash between two had mixed the device", async () => {
    const disk = memoryStorage();
    const writes: string[][] = [];
    const store: KeyValueStorage = {
      get: (k) => disk.get(k),
      set: (k, v) => {
        writes.push([k]);
        disk.set(k, v);
      },
      remove: (k) => {
        writes.push([k]);
        disk.remove(k);
      },
      setMany: (entries) => {
        writes.push(entries.map(([k]) => k));
        disk.setMany!(entries);
      },
    };
    const s = new WalletSession(store, KDF);
    await s.create("pw of Y", new Uint8Array(32).fill(2));
    s.acknowledgePhrase();
    s.lock();
    const b = new WalletSession(memoryStorage(), KDF);
    await b.create("pw of B", new Uint8Array(32).fill(1));
    b.acknowledgePhrase();
    const backupB = b.exportBackup();
    b.lock();
    writes.length = 0;
    expect(await s.restoreFromBackup(backupB, "pw of B", { replace: true })).toBe(true);
    const together = writes.find((w) => w.includes(KEYSTORE_KEY));
    expect(together, "the keystore and the journal in the same write").toEqual(expect.arrayContaining([KEYSTORE_KEY, JOURNAL_KEY]));
    s.lock();
  });

  it("a backup restore reads this wallet's own set-aside journal, as the phrase restore does, and removes it once merged (A11-8)", async () => {
    const ORDER = "0x" + "0f".repeat(32);
    const seedA = new Uint8Array(32).fill(7);
    const store = memoryStorage();
    const s = new WalletSession(store, KDF);
    await s.create("pw of A", seedA);
    s.acknowledgePhrase();
    const oldBackup = s.exportBackup();
    s.update((j) => {
      j.swaps = [swap(ORDER, { state: "funded", fundedTx: "0x" + "ab".repeat(32) })];
    });
    s.lock();
    const xs = new WalletSession(memoryStorage(), KDF);
    await xs.create("pw of X", new Uint8Array(32).fill(8));
    xs.acknowledgePhrase();
    store.set(KEYSTORE_KEY, JSON.stringify(JSON.parse(xs.exportBackup()).keystore));
    xs.lock();
    expect(await s.unlock("pw of X")).toBe(true);
    s.discardUnreadableJournal();
    s.lock();
    expect(await s.restoreFromBackup(oldBackup, "pw of A", { replace: true })).toBe(true);
    expect(
      s.journal().swaps.map((x) => x.orderId),
      "the order funded after the backup is back",
    ).toEqual([ORDER]);
    expect(store.get(UNREADABLE_JOURNAL_KEY), "merged, then removed").toBeNull();
    s.lock();
  });

  it("a second opening zeroes the seed the first one held (A11-11)", async () => {
    const s = new WalletSession(memoryStorage(), KDF);
    await s.create("pw", new Uint8Array(32).fill(12));
    s.acknowledgePhrase();
    const first = s.state().seed!;
    expect(await s.unlock("pw")).toBe(true);
    expect(
      first.every((b) => b === 0),
      "the first opening's seed",
    ).toBe(true);
    expect(s.state().seed!.some((b) => b !== 0)).toBe(true);
    s.lock();
  });
});

describe("the published test phrases (A11-11)", () => {
  const PHRASES = [
    "legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title",
    "letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic bless",
    "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote",
    "panda eyebrow bullet gorilla call smoke muffin taste mesh discover soft ostrich alcohol speed nation flash devote level hobby quick inner drive ghost inside",
    "all hour make first leader extend hole alien behind guard gospel lava path output census museum junior mass reopen famous sing advance salt reform",
    "void come effort suffer camp survey warrior heavy shoot primary clutch crush open amazing screen patrol group space point ten exist slush involve unfold",
    // the critique of this round: missed at first
    "hamster diagram private dutch cause delay private meat slide toddler razor book happy fancy gospel tennis maple dilemma loan word shrug inflict delay length",
  ];
  /** every 24-word (256-bit) english entry of trezor/python-mnemonic vectors.json, by its entropy */
  const VECTOR_ENTROPIES = [
    "0000000000000000000000000000000000000000000000000000000000000000",
    "7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f",
    "8080808080808080808080808080808080808080808080808080808080808080",
    "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    "68a79eaca2324873eacc50cb9c6eca8cc68ea5d936f98787c60c7ebc74e6ce7c",
    "9f6a2878b2520799a44ef18bc7df394e7061a224d2c33cd015b157d746869863",
    "066dca1a2bb7e8a1db2832148ce9933eea0f3ac9548d793112d9a95c9407efad",
    "f585c11aec520db57dd353c69554b21a89b20fb0650966fa0a9d6f74fd989d8f",
  ];
  it("every one of the reference list is a published seed", () => {
    for (const hex of VECTOR_ENTROPIES) expect(isPublicSeed(Uint8Array.from(Buffer.from(hex, "hex"))), hex.slice(0, 8)).toBe(true);
  });
  it("are refused at a restore, beside the all-zero one; an ordinary seed of one repeated byte is not a published phrase", async () => {
    for (const p of PHRASES) {
      const s = new WalletSession(memoryStorage(), KDF);
      await expect(s.restoreFromPhrase(p, "a password"), p.slice(0, 20)).rejects.toThrow(/publicly known/);
    }
    expect(isPublicSeed(new Uint8Array(32).fill(4))).toBe(false);
    expect(isPublicSeed(new Uint8Array(32))).toBe(true);
  });
  it("a keystore made from one before they were refused opens, the warning on (isPublicWallet), so its owner can move what it holds; the zero seed, from which no key derives, is refused at the unlock (the critique)", async () => {
    const store = memoryStorage();
    const s = new WalletSession(store, KDF);
    await s.create("pw", new Uint8Array(32).fill(13));
    s.acknowledgePhrase();
    expect(s.isPublicWallet(), "an ordinary wallet").toBe(false);
    s.lock();
    const { createKeystore } = await import("../src/wallet/keystore");
    store.set(KEYSTORE_KEY, JSON.stringify(await createKeystore(new Uint8Array(32).fill(0xff), "pw", KDF)));
    expect(await s.unlock("pw")).toBe(true);
    expect(s.isPublicWallet()).toBe(true);
    s.lock();
    expect(s.isPublicWallet(), "locked: nothing to warn of").toBe(false);
    store.set(KEYSTORE_KEY, JSON.stringify(await createKeystore(new Uint8Array(32), "pw", KDF)));
    await expect(s.unlock("pw")).rejects.toMatchObject({ reason: "public-wallet" });
    expect(s.isUnlocked()).toBe(false);
  });

  it("a backup of a published seed is refused before anything is written: the device keeps its own keystore (the critique, T12)", async () => {
    const store = memoryStorage();
    const s = new WalletSession(store, KDF);
    await s.create("pw", new Uint8Array(32).fill(13));
    s.acknowledgePhrase();
    s.lock();
    const before = store.get(KEYSTORE_KEY);
    const { createKeystore } = await import("../src/wallet/keystore");
    const backup = JSON.stringify({ v: 1, keystore: await createKeystore(new Uint8Array(32).fill(0xff), "bpw", KDF), journal: null });
    await expect(s.restoreFromBackup(backup, "bpw", { replace: true })).rejects.toMatchObject({ reason: "public-backup" });
    expect(store.get(KEYSTORE_KEY), "nothing restored").toBe(before);
  });

  it("a restore says in the screens' terms what it found: no JSON, a phrase cut short, a word misspelt (the critique, K3-5)", async () => {
    const s = new WalletSession(memoryStorage(), KDF);
    await expect(s.restoreFromBackup("abandon abandon abandon", "pw")).rejects.toMatchObject({ reason: "not-a-backup" });
    await expect(s.restoreFromBackup('{"v":1,"keyst', "pw")).rejects.toMatchObject({ reason: "not-a-backup" });
    await expect(s.restoreFromBackup("null", "pw")).rejects.toMatchObject({ reason: "not-a-backup" });
    const words = seedToPhrase(new Uint8Array(32).fill(9)).split(" ");
    await expect(s.restoreFromPhrase(words.slice(0, 23).join(" "), "a password")).rejects.toMatchObject({ reason: "phrase-length" });
    await expect(s.restoreFromPhrase([...words.slice(0, 23), words[23] === "zoo" ? "abandon" : "zoo"].join(" "), "a password")).rejects.toMatchObject({
      reason: "phrase-invalid",
    });
  });
});

describe("an order's refund compared as numbers (A11-11)", () => {
  it("the same value written in hex or in decimal is this wallet's", () => {
    const seed = new Uint8Array(32).fill(21);
    const attemptId = "0x" + "ab".repeat(32);
    const refund = deriveRefundNote(seed, 3);
    const signer = deriveOrderKey(seed, attemptId as Hex).address;
    const stored = (oc: string) =>
      ({ params: { refundOwnerCommitment: oc, refundNoteSecret: refund.noteSecret.toString(), orderSigner: signer }, refundCounter: 3, attemptId }) as never;
    expect(orderIsOurs(stored(refund.ownerCommitment.toString()), seed)).toBe(true);
    expect(orderIsOurs(stored("0x" + refund.ownerCommitment.toString(16)), seed)).toBe(true);
    expect(orderIsOurs(stored((refund.ownerCommitment + 1n).toString()), seed)).toBe(false);
    expect(orderIsOurs(stored("not a number"), seed)).toBe(false);
  });
});
