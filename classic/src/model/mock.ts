// The Stage 3 data source: the four pools with the deposit counts read on chain on 2026-10-26 (spec v3.0 §7.2), a
// scripted history that knows two fixture notes (one unspent, one spent), two online relayers and one offline, a gas
// price, and an availability that says the truth of this build — nothing verified, nothing connected, nothing live.
// The screens built on it are the deliverable of Stage 3; Stages 7–9 replace it. The synchronous pieces are exported
// for the screenshot fixtures (src/fixtures/registry.tsx), which render from static data.
import { generateNote, type ClassicNote } from "./notes";
import { POOLS, type PoolId } from "./pools";
import type { ClassicSource } from "./source";
import type { Availability, DepositFacts, HistoryRow, NoteLookup, PoolStats, RelayerInfo } from "./types";

/** The counts of 2026-10-26 (`nextIndex()` of each pool). */
export const DEPOSITS_2026_10_26: Record<PoolId, number> = { "eth-0.1": 75_154, "eth-1": 96_432, "eth-10": 78_767, "eth-100": 49_612 };

const seeded = (seed: number) => {
  let x = seed >>> 0;
  return (n: number) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      x = (x * 1664525 + 1013904223) >>> 0;
      out[i] = x >>> 24;
    }
    return out;
  };
};
/** A note the mock knows as deposited into the 1 ETH pool two days ago, 431 deposits ago, unspent. */
export const FIXTURE_NOTE: ClassicNote = generateNote("eth", "1", 1, seeded(7));
/** A note the mock knows as deposited into the 10 ETH pool and already withdrawn. */
export const SPENT_NOTE: ClassicNote = generateNote("eth", "10", 1, seeded(11));

/** The fixture note's deposit, relative to the clock. */
export const fixtureFacts = (now: number): DepositFacts => ({
  leafIndex: 96_000,
  timestamp: now - 2 * 86_400 - 1_800,
  blockNumber: 26_262_700,
  txHash: "0x7c1e4d9a0f3b58e2a6d44f1b9c0e7a2d5b8f3c6e1a9d2b4f7c0e8a1d3b6f9c2e",
  depositsSince: 431,
  spent: false,
});
/** The spent note's deposit. */
export const spentFacts = (now: number): DepositFacts => ({
  leafIndex: 78_100,
  timestamp: now - 9 * 86_400,
  blockNumber: 26_214_010,
  txHash: "0x1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809",
  depositsSince: 666,
  spent: true,
});

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const equalNotes = (a: ClassicNote, b: ClassicNote) =>
  a.currency === b.currency && a.amount === b.amount && a.netId === b.netId && same(a.nullifier, b.nullifier) && same(a.secret, b.secret);

export const MOCK_RELAYERS: RelayerInfo[] = [
  { id: "one", name: "relayer-one.eth", url: "https://relayer-one.example", feePercentE4: 3_000, status: "online" },
  { id: "two", name: "relayer-two.eth", url: "https://relayer-two.example", feePercentE4: 5_000, status: "online" },
  { id: "three", name: "relayer-three.eth", url: "https://relayer-three.example", feePercentE4: 4_000, status: "offline" },
];

/** 12 gwei: the mock's gas price (a live build reads the chain's; never a constant there). */
export const MOCK_GAS_PRICE_WEI = 12_000_000_000n;

/** The pool's count and its newest ten deposits, one every few minutes to a few hours, newest first. */
export function mockStats(pool: PoolId, now: number): PoolStats {
  const deposits = DEPOSITS_2026_10_26[pool];
  const gaps = [7, 23, 41, 62, 95, 130, 170, 260, 380, 540];
  return { deposits, latest: gaps.map((minutes, i) => ({ leafIndex: deposits - 1 - i, timestamp: now - minutes * 60 })) };
}

/** What this build can honestly say of a pool: nothing verified, nothing synced, no prover, no wallet. */
export const mockAvailability = (pool: PoolId): Availability => ({
  pool,
  contract: { state: "unknown", text: "availability.contractUnverified" },
  router: { state: "unknown", text: "availability.routerUnknown" },
  relayers: { state: "warn", text: "availability.relayersMock" },
  history: { state: "unknown", text: "availability.historyUnverified" },
  prover: { state: "off", text: "availability.proverAbsent" },
  wallet: { state: "off", text: "availability.walletNotConnected" },
});

/** The scripted lookup: the two fixture notes are known; any other well-formed mainnet note has no deposit. */
export function mockLookup(note: ClassicNote, now: number): NoteLookup {
  if (note.netId !== 1) return { kind: "other-network", netId: note.netId };
  const pool = POOLS.find((p) => p.currency === note.currency && p.amount === note.amount);
  if (!pool) return { kind: "unknown-pool" };
  if (equalNotes(note, FIXTURE_NOTE)) return { kind: "found", pool: "eth-1", facts: fixtureFacts(now) };
  if (equalNotes(note, SPENT_NOTE)) return { kind: "found", pool: "eth-10", facts: spentFacts(now) };
  return { kind: "no-deposit" };
}

export interface MockOptions {
  /** the clock, seconds */
  now: number;
  /** the gas price in wei (12 gwei by default) */
  gasPriceWei?: bigint;
  /** what this device did (empty by default) */
  history?: HistoryRow[];
  /** a delay before every answer, ms (the tests keep it at 0; the dev server shows the loading states briefly) */
  delayMs?: number;
}

export function mockSource(o: MockOptions): ClassicSource {
  const gas = o.gasPriceWei ?? MOCK_GAS_PRICE_WEI;
  const history = o.history ?? [];
  const answer = <T>(value: T): Promise<T> => (o.delayMs ? new Promise((r) => setTimeout(() => r(value), o.delayMs)) : Promise.resolve(value));
  return {
    stats: (pool) => answer(mockStats(pool, o.now)),
    lookup: (note) => answer(mockLookup(note, o.now)),
    relayers: () => answer(MOCK_RELAYERS),
    gasPriceWei: () => answer(gas),
    availability: (pool) => answer(mockAvailability(pool)),
    history: () => answer(history),
  };
}
