// The relayer's seed is 32 random bytes and nothing else (audit round 2, r50): its privacy address is public on GET /info, so a
// phrase — the example's placeholder above all — could be tried offline against it, and a match opened every fee note.
import { describe, expect, it } from "vitest";
import { relayerSeed } from "../src/seed";

describe("RELAYER_SEED", () => {
  it("is 0x followed by 64 hex digits: those 32 bytes", () => {
    const s = relayerSeed("0x" + "ab".repeat(31) + "0F");
    expect(s).toHaveLength(32);
    expect([s[0], s[31]]).toEqual([0xab, 0x0f]);
  });
  it("anything else stops the start, the value never echoed: a phrase, the example's placeholder, a short or malformed hex, none", () => {
    for (const bad of [
      "change me: the relayer wallet seed",
      "relayer wallet seed",
      "0x" + "ab".repeat(31),
      "0x" + "zz".repeat(32),
      "0x" + "ab".repeat(33),
      "ab".repeat(32),
    ]) {
      let message = "";
      try {
        relayerSeed(bad);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message, bad).toMatch(/0x followed by 64 hex digits/);
      expect(message, "never echoed").not.toContain(bad);
    }
    expect(() => relayerSeed(undefined)).toThrow(/missing env RELAYER_SEED/);
  });
});
