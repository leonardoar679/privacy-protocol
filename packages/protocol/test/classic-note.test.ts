// The classic note (Privacy Wallet Web spec §16; Stage 10): tornado-<currency>-<amount>-<netId>-0x<124 hex>, the
// nullifier then the secret, 31 bytes each; parse is the inverse of format; a note is validated against a pool; a
// fresh note needs 62 random bytes; the halves read little-endian.
import { describe, it, expect } from "vitest";
import { formatNote, generateNote, leBigInt, NOTE_PREFIX, parseNote, validateNote } from "../src/classic/note";

const bytes = (from: number, n = 31) => Uint8Array.from({ length: n }, (_, i) => from + i);
const VECTOR = "tornado-eth-1-1-0x" + "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f" + "65666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f80818283";

describe("the classic note (spec §16)", () => {
  it("formats tornado-<currency>-<amount>-<netId>-0x<124 hex>: the nullifier then the secret, 31 bytes each, the currency lower-case", () => {
    expect(formatNote({ currency: "ETH", amount: "1", netId: 1, nullifier: bytes(1), secret: bytes(101) })).toBe(VECTOR);
    expect(VECTOR.length).toBe("tornado-eth-1-1-0x".length + 124);
    expect(() => formatNote({ currency: "eth", amount: "1", netId: 1, nullifier: bytes(1, 30), secret: bytes(101) })).toThrow(/31-byte/);
  });

  it("parses its own output (upper-case hex accepted) and refuses anything else with a reason", () => {
    const p = parseNote(" " + VECTOR + "\n");
    expect(p.ok).toBe(true);
    if (!p.ok) throw new Error("unreachable");
    expect(p.note).toEqual({ currency: "eth", amount: "1", netId: 1, nullifier: bytes(1), secret: bytes(101) });
    expect(formatNote(p.note)).toBe(VECTOR);
    const upper = "tornado-eth-1-1-0x" + VECTOR.slice("tornado-eth-1-1-0x".length).toUpperCase();
    const u = parseNote(upper);
    expect(u.ok && formatNote(u.note)).toBe(VECTOR);
    for (const bad of ["", "tornado-eth-1-1-0x" + "ab".repeat(61), "tornado-eth-1-0x" + "ab".repeat(62), "classic-eth-1-1-0x" + "ab".repeat(62), VECTOR + "0", VECTOR.replace("0x", "0y")]) {
      const r = parseNote(bad);
      expect(r.ok, bad.slice(0, 30)).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/not a classic note/);
    }
  });

  it("validates a note against a pool: the currency, the amount and the network, each with its reason", () => {
    const n = { currency: "eth", amount: "1", netId: 1, nullifier: bytes(1), secret: bytes(101) };
    expect(validateNote(n, { currency: "eth", amount: "1", netId: 1 })).toBeNull();
    expect(validateNote(n, { currency: "ETH", amount: "1", netId: 1 }), "the pool's case does not matter").toBeNull();
    expect(validateNote(n, { currency: "dai", amount: "1", netId: 1 })).toMatch(/ETH note; this pool is DAI/);
    expect(validateNote(n, { currency: "eth", amount: "10", netId: 1 })).toMatch(/this pool is the 10 ETH pool/);
    expect(validateNote(n, { currency: "eth", amount: "1", netId: 31337 })).toMatch(/network 1; this pool is on network 31337/);
  });

  it("generates a note from 62 random bytes and reads the halves little-endian", () => {
    const seeded = (k: number) => Uint8Array.from({ length: k }, (_, i) => (i * 7 + 3) & 0xff);
    const n = generateNote("ETH", "0.1", 31337, seeded);
    expect([n.currency, n.amount, n.netId, n.nullifier.length, n.secret.length]).toEqual(["eth", "0.1", 31337, 31, 31]);
    expect(n.nullifier).toEqual(seeded(62).slice(0, 31));
    expect(n.secret).toEqual(seeded(62).slice(31, 62));
    expect(formatNote(n)).toMatch(new RegExp(`^${NOTE_PREFIX}-eth-0\\.1-31337-0x[0-9a-f]{124}$`));
    expect(() => generateNote("eth", "1", 1, (k) => new Uint8Array(k - 1))).toThrow(/62 random bytes/);
    expect(leBigInt(Uint8Array.from([1, 0, 0]))).toBe(1n);
    expect(leBigInt(Uint8Array.from([0, 1]))).toBe(256n);
    expect(leBigInt(Uint8Array.from([0xff, 0xff]))).toBe(65535n);
    expect(leBigInt(bytes(1))).toBe(bytes(1).reduce((a, x, i) => a + (BigInt(x) << BigInt(8 * i)), 0n));
  });
});
