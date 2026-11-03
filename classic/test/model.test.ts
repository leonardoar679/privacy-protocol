// The Classic model (spec v3.0 §7.3–§7.5): the note's format, the pools, Classic's own fee lines in integer wei at a given
// gas price (never a float, never a 1 %), "Time passed" and the two warnings, the formatting, the routes.
import { describe, expect, it } from "vitest";
import { applyConfig, configFromEnv } from "../src/config";
import { pathOf, routeOf } from "../src/app/router";
import { feeLines, MAX_FEE_PERCENT_E4, RELAYER_MIN_GAS, relayerMinimumWei, WITHDRAW_GAS } from "../src/model/fees";
import { formatCount, fromWei, isAddress, shortHash, toDecimals, toGwei, weiOfEth } from "../src/model/format";
import { FIXTURE_NOTE, mockLookup, mockStats, SPENT_NOTE } from "../src/model/mock";
import { formatNote, generateNote, leBigInt, noteFileName, parseNote } from "../src/model/notes";
import { DEPLOYMENT, NET_ID, poolFor, poolOf, POOLS } from "../src/model/pools";
import { protocolAddresses, refusedRecipient } from "../src/model/recipient";
import { MIN_HOURS, MIN_SUBSEQUENT_DEPOSITS, notEnoughDeposits, notEnoughTime, timePassed } from "../src/model/time";
import { percentOf } from "../src/views/Withdraw";

const NOW = 1_793_361_600; // 2026-10-26T12:00:00Z
const GWEI = 1_000_000_000n;

describe("a recipient a withdrawal must not go to (the fourth review round, 2026-11-03)", () => {
  it("the zero address, the burn address and the pools' own contracts are named — in any case —; a user's address and a non-address are not", () => {
    expect(refusedRecipient("0x0000000000000000000000000000000000000000")).toBe("zero");
    expect(refusedRecipient("0x000000000000000000000000000000000000dEaD")).toBe("burn");
    expect(refusedRecipient(" 0x000000000000000000000000000000000000DEAD ")).toBe("burn");
    expect(protocolAddresses()).toHaveLength(6); // the four pools, the router, the verifier
    for (const a of protocolAddresses()) expect(refusedRecipient(a)).toBe("protocol");
    expect(refusedRecipient(DEPLOYMENT.router.address.toUpperCase().replace(/^0X/, "0x"))).toBe("protocol");
    expect(refusedRecipient("0x1111111111111111111111111111111111111111")).toBeNull();
    expect(refusedRecipient("0x1234")).toBeNull(); // not an address: another check's word
    expect(refusedRecipient("")).toBeNull();
  });
});

describe("the note (spec v3.0 §7.3)", () => {
  it("formats and parses the original's note: tornado-<currency>-<amount>-<netId>-0x<31 B nullifier><31 B secret>", () => {
    const text = formatNote(FIXTURE_NOTE);
    expect(text).toMatch(/^tornado-eth-1-1-0x[0-9a-f]{124}$/);
    const back = parseNote(text);
    expect(back.ok).toBe(true);
    if (back.ok) {
      expect(back.note.currency).toBe("eth");
      expect(back.note.amount).toBe("1");
      expect(back.note.netId).toBe(1);
      expect([...back.note.nullifier]).toEqual([...FIXTURE_NOTE.nullifier]);
      expect([...back.note.secret]).toEqual([...FIXTURE_NOTE.secret]);
      expect(back.note.nullifier).toHaveLength(31);
      expect(back.note.secret).toHaveLength(31);
    }
  });
  it("reads the currency case-insensitively and ignores the whitespace around a pasted note (as the original CLI did)", () => {
    const text = formatNote(FIXTURE_NOTE);
    const upper = parseNote(`  ${text.replace("tornado-eth", "tornado-ETH")}\n`);
    expect(upper.ok && upper.note.currency).toBe("eth");
  });
  it("refuses a malformed note by name", () => {
    const hex = formatNote(FIXTURE_NOTE).slice(-124);
    for (const bad of [
      "",
      "tornado",
      `tornado-eth-1-1-0x${hex.slice(1)}`,
      `tornado-eth-1-1-0x${hex}0`,
      `tornado-eth-1-1-${hex}`,
      `cyclone-eth-1-1-0x${hex}`,
      `tornado-eth-1-1-0x${"g".repeat(124)}`,
    ])
      expect(parseNote(bad), bad).toEqual({ ok: false, reason: "malformed" });
  });
  it("generates a note from 62 random bytes and names its backup file as the original did", () => {
    const n = generateNote("ETH", "10", 1, (k) => Uint8Array.from({ length: k }, (_, i) => i));
    expect(n.currency).toBe("eth");
    expect([...n.nullifier]).toEqual([...Array(31).keys()]);
    expect(n.secret[0]).toBe(31);
    expect(noteFileName(n)).toBe("backup-tornado-eth-10-1-0001020304.txt");
    expect(() => generateNote("eth", "1", 1, () => new Uint8Array(10))).toThrow(/62 random bytes/);
  });
  it("reads a half as the circuit's little-endian field element", () => {
    expect(leBigInt(Uint8Array.from([1, 0, 0]))).toBe(1n);
    expect(leBigInt(Uint8Array.from([0, 1]))).toBe(256n);
    expect(leBigInt(Uint8Array.from([0xff, 0xff]))).toBe(65_535n);
  });
});

describe("the pools (spec v3.0 §7.2)", () => {
  it("names the four mainnet pools by address and denomination, in the order of the original's slider", () => {
    expect(POOLS.map((p) => p.amount)).toEqual(["0.1", "1", "10", "100"]);
    for (const p of POOLS) expect(p.address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(poolOf("eth-1").denominationWei).toBe(1_000_000_000_000_000_000n);
    expect(poolOf("eth-0.1").denominationWei).toBe(100_000_000_000_000_000n);
    expect(poolOf("eth-100").denominationWei).toBe(100_000_000_000_000_000_000n);
    expect(NET_ID).toBe(1);
  });
  it("finds the pool a note names: mainnet only, the currency case-insensitive", () => {
    expect(poolFor("eth", "1", 1)?.id).toBe("eth-1");
    expect(poolFor("ETH", "10", 1)?.id).toBe("eth-10");
    expect(poolFor("eth", "1", 5)).toBeNull();
    expect(poolFor("dai", "100", 1)).toBeNull();
    expect(poolFor("eth", "7", 1)).toBeNull();
  });
});

describe("Classic's own fee lines (spec v3.0 §7.5; no 1 %)", () => {
  it("prices a relayed withdrawal at the live gas price over 550,000 gas plus the relayer's share, in integer wei", () => {
    const f = feeLines(poolOf("eth-1"), { feePercentE4: 3_000 }, 12n * GWEI);
    expect(WITHDRAW_GAS).toBe(550_000n);
    expect(f.gasPriceWei).toBe(12n * GWEI);
    expect(f.networkFeeWei).toBe(6_600_000_000_000_000n);
    expect(f.relayerFeeWei).toBe(3_000_000_000_000_000n);
    expect(f.totalFeeWei).toBe(9_600_000_000_000_000n);
    expect(f.receiveWei).toBe(990_400_000_000_000_000n);
    expect(fromWei(f.receiveWei)).toBe("0.9904");
  });
  it("goes negative when the fee exceeds the note, and the relayer's own minimum uses 390,000 gas", () => {
    const f = feeLines(poolOf("eth-0.1"), { feePercentE4: 3_000 }, 2_000n * GWEI);
    expect(f.networkFeeWei).toBe(1_100_000_000_000_000_000n);
    expect(f.receiveWei).toBeLessThan(0n);
    expect(RELAYER_MIN_GAS).toBe(390_000n);
    expect(relayerMinimumWei(poolOf("eth-1"), { feePercentE4: 3_000 }, 12n * GWEI)).toBe(4_680_000_000_000_000n + 3_000_000_000_000_000n);
    expect(MAX_FEE_PERCENT_E4).toBe(200_000);
  });
  it("shows a relayer's fee percent from its integer form", () => {
    expect(percentOf(3_000)).toBe("0.3");
    expect(percentOf(500)).toBe("0.05");
    expect(percentOf(10_000)).toBe("1");
    expect(percentOf(12_345)).toBe("1.2345");
    expect(percentOf(0)).toBe("0");
  });
});

describe("Time passed and the two warnings", () => {
  it("rounds down to the largest whole unit", () => {
    expect(timePassed(NOW - 2 * 86_400 - 1_800, NOW)).toEqual({ unit: "days", n: 2 });
    expect(timePassed(NOW - 3 * 3_600, NOW)).toEqual({ unit: "hours", n: 3 });
    expect(timePassed(NOW - 59 * 60, NOW)).toEqual({ unit: "minutes", n: 59 });
    expect(timePassed(NOW + 60, NOW)).toEqual({ unit: "minutes", n: 0 });
  });
  it("warns under 24 hours and under 5 subsequent deposits (the original's thresholds)", () => {
    expect(MIN_HOURS).toBe(24);
    expect(MIN_SUBSEQUENT_DEPOSITS).toBe(5);
    expect(notEnoughTime(NOW - 23 * 3_600, NOW)).toBe(true);
    expect(notEnoughTime(NOW - 25 * 3_600, NOW)).toBe(false);
    expect(notEnoughDeposits(4)).toBe(true);
    expect(notEnoughDeposits(5)).toBe(false);
  });
});

describe("formatting", () => {
  it("writes wei with at most six decimals and never a float", () => {
    expect(toDecimals(990_400_000_000_000_000n)).toBe("0.9904");
    expect(toDecimals(1n)).toBe("0");
    expect(toDecimals(1_000_000_000_000_000_000n)).toBe("1");
    expect(toDecimals(-5_000_000_000_000_000n)).toBe("-0.005");
    expect(fromWei(123_456_789_000_000_000n)).toBe("0.123456");
    expect(toGwei(12n * GWEI)).toBe("12.0");
    expect(toGwei(12_500_000_000n)).toBe("12.5");
    expect(weiOfEth("1.5")).toBe(1_500_000_000_000_000_000n);
    expect(weiOfEth("0.1")).toBe(100_000_000_000_000_000n);
  });
  it("shortens hashes, counts with separators, validates an address", () => {
    expect(shortHash("0x7c1e4d9a0f3b58e2a6d44f1b9c0e7a2d5b8f3c6e1a9d2b4f7c0e8a1d3b6f9c2e", 8, 6)).toBe("0x7c1e4d…6f9c2e");
    expect(shortHash("0x1234")).toBe("0x1234");
    expect(formatCount(96_432)).toBe("96,432");
    expect(isAddress("0x1111111111111111111111111111111111111111")).toBe(true);
    expect(isAddress(" 0x1111111111111111111111111111111111111111 ")).toBe(true);
    expect(isAddress("0x1234")).toBe(false);
    expect(isAddress("1111111111111111111111111111111111111111")).toBe(false);
    // the review round of 2026-11-03 (C2-1): a mixed-case address carries its EIP-55 checksum, or one typo pays a stranger
    expect(isAddress("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed")).toBe(true);
    expect(isAddress("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed"), "all lower: no checksum to check").toBe(true);
    expect(isAddress("0x5AAEB6053F3E94C9B9A09F33669435E7EF1BEAED"), "all upper: none either").toBe(true);
    expect(isAddress("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD"), "one case flipped").toBe(false);
  });
});

describe("the routes (spec v3.0 §2)", () => {
  it("maps the paths under /classic/ to the four routes, anything else to the deposit tab", () => {
    applyConfig(configFromEnv({}));
    expect(routeOf("/classic/")).toBe("deposit");
    expect(routeOf("/classic")).toBe("deposit");
    expect(routeOf("/classic/deposit")).toBe("deposit");
    expect(routeOf("/classic/withdraw")).toBe("withdraw");
    expect(routeOf("/classic/history/")).toBe("history");
    expect(routeOf("/classic/settings")).toBe("settings");
    expect(routeOf("/classic/nonsense")).toBe("deposit");
    expect(routeOf("/classic/fixtures.html")).toBe("deposit");
    expect(pathOf("withdraw")).toBe("/classic/withdraw");
    expect(routeOf("/other/withdraw", "/other/")).toBe("withdraw");
  });
});

describe("the Stage 3 mock", () => {
  it("knows the counts of 2026-10-26, the two fixture notes and nothing else", () => {
    expect(mockStats("eth-1", NOW).deposits).toBe(96_432);
    expect(mockStats("eth-100", NOW).latest).toHaveLength(10);
    expect(mockLookup(FIXTURE_NOTE, NOW)).toMatchObject({ kind: "found", pool: "eth-1", facts: { depositsSince: 431, spent: false } });
    expect(mockLookup(SPENT_NOTE, NOW)).toMatchObject({ kind: "found", pool: "eth-10", facts: { spent: true } });
    expect(mockLookup({ ...FIXTURE_NOTE, amount: "100" }, NOW)).toEqual({ kind: "no-deposit" });
    expect(mockLookup({ ...FIXTURE_NOTE, netId: 5 }, NOW)).toEqual({ kind: "other-network", netId: 5 });
    expect(mockLookup({ ...FIXTURE_NOTE, amount: "7" }, NOW)).toEqual({ kind: "unknown-pool" });
  });
});
