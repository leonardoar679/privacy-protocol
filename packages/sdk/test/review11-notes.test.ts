// The eleventh review round (2026-11-04), parts A and H — the note store and the lock: a store a lock closed takes nothing, nor raises the next
// opening's counter (VA NF-2); a scan's findings are one change of the store, the journal written once (H11-5); a maintenance step holds the
// lock off until its fee is booked — a lock due while its spend proved had happened inside the spend's own release (A11-10); the first touch
// after a deadline that passed while no timer ran locks, never restarts the clock, and a request to step aside can be withdrawn (H11-8, H11-3).
// The reviewer's probes (scratchpad review11/A p10, H idle-after-sleep, journal-write-per-note) became these cases.
import { beforeAll, describe, expect, it } from "vitest";
import { configure, defaultConfig } from "../src/config";
import { memoryStorage, JOURNAL_KEY, type KeyValueStorage } from "../src/wallet/storage";
import { session } from "../src/wallet/session";
import { noteStore, type OwnedNote } from "../src/wallet/notes";
import { decryptJournal, journalKey, type EncryptedJournal } from "../src/wallet/journal";
import { runHousekeepingStep } from "../src/wallet/housekeeping";
import { AutoLock, type AutoLockClock } from "../src/session/autoLock";
import { deriveKeys, deriveNoteSecret } from "@privacy-wallet/protocol/keys";
import { ownerCommitmentOf } from "@privacy-wallet/protocol/note";

const ETH = 10n ** 18n;
const VAULT = "0x00000000000000000000000000000000000000e7";
const deployment = {
  chainId: 31337,
  core: "0x00000000000000000000000000000000000000c0",
  ethVault: VAULT,
  rpcUrl: "http://127.0.0.1:1",
  rpcUrls: ["http://127.0.0.1:1"],
  fromBlock: 0n,
  erc20Vaults: [],
} as never;
const disk = memoryStorage();
let journalWrites = 0;
const store: KeyValueStorage = {
  get: (k) => disk.get(k),
  set: (k, v) => {
    if (k === JOURNAL_KEY) journalWrites++;
    disk.set(k, v);
  },
  remove: (k) => disk.remove(k),
};

beforeAll(async () => {
  configure(defaultConfig({ kdfLog2N: 12, storage: () => store }));
  await session.create("a strong password");
  session.acknowledgePhrase();
});
const seed = () => session.state().seed!;
const noteAt = (i: number, amount = ETH): OwnedNote => {
  const keys = deriveKeys(seed());
  return {
    note: { vaultId: BigInt(VAULT), amount, ownerCommitment: ownerCommitmentOf(keys.spendKey), noteSecret: deriveNoteSecret(keys.noteKey, i) },
    leafIndex: i,
    noteData: "0x",
    counter: i,
    spent: false,
  };
};

describe("a scan's findings, one change (H11-5)", () => {
  it("a batch of a hundred notes writes the journal once; outside a batch every note had written it", () => {
    noteStore.clear();
    journalWrites = 0;
    noteStore.batch(() => {
      for (let i = 0; i < 100; i++) noteStore.add(noteAt(i));
      for (let i = 0; i < 100; i++) noteStore.observeCounter(i);
    });
    expect(noteStore.all()).toHaveLength(100);
    expect(journalWrites, "once for the whole scan").toBe(1);
    journalWrites = 0;
    for (let i = 100; i < 110; i++) noteStore.add(noteAt(i));
    expect(journalWrites, "control: one per note").toBe(10);
  });
  it("a nested batch ends with the outermost; a throw inside still tells the listeners once", () => {
    journalWrites = 0;
    expect(() =>
      noteStore.batch(() => {
        noteStore.batch(() => noteStore.add(noteAt(200)));
        expect(journalWrites, "nothing yet").toBe(0);
        noteStore.add(noteAt(201));
        throw new Error("a scan that failed halfway");
      }),
    ).toThrow(/halfway/);
    expect(journalWrites).toBe(1);
    expect(noteStore.all().some((n) => n.leafIndex === 201)).toBe(true);
  });
});

describe("a closed store takes nothing (VA NF-2)", () => {
  it("after a lock a late result's note, mark or counter changes nothing in the page's memory", async () => {
    const late = noteAt(300); // a result made before the lock, arriving after it
    session.lock();
    noteStore.add(late);
    noteStore.markSpent([300]);
    noteStore.observeCounter(9_999);
    expect(noteStore.all(), "nothing of it").toEqual([]);
    expect(noteStore.nextCounter(), "no counter raised for the next opening").toBe(0);
    expect(await session.unlock("a strong password")).toBe(true);
    expect(noteStore.all().some((n) => n.leafIndex === 300)).toBe(false);
    expect(noteStore.nextCounter()).toBeLessThan(9_999);
  });
});

describe("a maintenance step is one critical section (A11-10)", () => {
  it("a lock due while the step's spend proved waits until its fee is booked, then happens", async () => {
    noteStore.clear();
    noteStore.add(noteAt(0, 25n * ETH));
    noteStore.observeCounter(1);
    let now = Date.now();
    const clock: AutoLockClock = { now: () => now, setTimeout: () => 0 as never, clearTimeout: () => undefined };
    const auto = new AutoLock({ session, minutes: () => 15, clock });
    const stop = auto.start();
    const kept = seed().slice();
    let heldDuring: string[] = [];
    try {
      const r = await runHousekeepingStep({
        masterSeed: seed(),
        deployment,
        session,
        fee: async () => 10n ** 15n,
        exec: {
          split: async () => {
            heldDuring = session.holds().map((h) => h.reason);
            now += 20 * 60_000; // the idle deadline passes while the step's spend proves
            const spend = session.hold("spend");
            spend(); // the spend's release: a safe point — the lock had happened here, before the booking
            expect(session.isUnlocked(), "the maintenance hold defers it").toBe(true);
            return 7n;
          },
          merge: async () => 7n,
        },
      });
      expect(r.ran).not.toBeNull();
    } finally {
      stop();
    }
    expect(heldDuring).toContain("maintenance");
    expect(session.isUnlocked(), "locked at the step's own release").toBe(false);
    const j = decryptJournal(journalKey(kept), JSON.parse(disk.get(JOURNAL_KEY)!) as EncryptedJournal)!;
    expect(j.housekeeping?.feeWei, "the fee booked before the lock").toBe("7");
    expect(await session.unlock("a strong password")).toBe(true);
  });
});

describe("the idle lock (H11-8, H11-3)", () => {
  class FakeSession {
    unlocked = true;
    private ls = new Set<() => void>();
    isUnlocked() {
      return this.unlocked;
    }
    subscribe(l: () => void) {
      this.ls.add(l);
      return () => {
        this.ls.delete(l);
      };
    }
    lock() {
      this.unlocked = false;
      for (const l of [...this.ls]) l();
    }
    holds() {
      return [];
    }
    onSafePoint() {
      return () => undefined;
    }
  }
  const clockAt = (t0: number) => {
    let now = t0;
    const clock: AutoLockClock = { now: () => now, setTimeout: () => 0 as never, clearTimeout: () => undefined };
    return { clock, advance: (ms: number) => void (now += ms) };
  };
  it("the first touch after a deadline that passed while no timer ran locks — it had restarted the idle clock", () => {
    const s = new FakeSession();
    const c = clockAt(1_000_000);
    const a = new AutoLock({ session: s as never, minutes: () => 15, clock: c.clock });
    a.start();
    c.advance(3 * 3600_000); // a suspend with the page visible: no timer ran
    a.activity();
    expect(s.isUnlocked()).toBe(false);
  });
  it("a touch before the deadline restarts the clock as before", () => {
    const s = new FakeSession();
    const c = clockAt(1_000_000);
    const a = new AutoLock({ session: s as never, minutes: () => 15, clock: c.clock });
    a.start();
    c.advance(14 * 60_000);
    a.activity();
    c.advance(14 * 60_000);
    a.check();
    expect(s.isUnlocked()).toBe(true);
  });
  it("a step aside withdrawn leaves the tab unlocked at its next check", () => {
    const s = new FakeSession();
    const c = clockAt(1_000_000);
    const a = new AutoLock({ session: s as never, minutes: () => 15, clock: c.clock });
    a.start();
    a.stepAside();
    expect(s.isUnlocked(), "nothing in progress: it steps aside at once").toBe(false);
    // held by a signature, then released: the check after the release is where a step aside still pending locks (the critique, T6: with the
    // hold still live the check could not lock either way)
    const held = (): { t: FakeSession; b: AutoLock; release: () => void } => {
      const t = new FakeSession();
      let holds = [{ reason: "signature", since: 1_000_000 }];
      const b = new AutoLock({
        session: {
          ...t,
          holds: () => holds,
          isUnlocked: () => t.unlocked,
          subscribe: (l: () => void) => t.subscribe(l),
          lock: () => t.lock(),
          onSafePoint: () => () => undefined,
        } as never,
        minutes: () => 15,
        clock: c.clock,
      });
      b.start();
      return { t, b, release: () => (holds = []) };
    };
    const kept = held();
    kept.b.stepAside(); // held: waits
    expect(kept.t.isUnlocked()).toBe(true);
    kept.b.cancelStepAside();
    kept.release();
    kept.b.check(true);
    expect(kept.t.isUnlocked(), "the asker gave up: this tab stays").toBe(true);
    const control = held();
    control.b.stepAside();
    control.release();
    control.b.check(true);
    expect(control.t.isUnlocked(), "control: not withdrawn, it steps aside at the release").toBe(false);
  });
});
