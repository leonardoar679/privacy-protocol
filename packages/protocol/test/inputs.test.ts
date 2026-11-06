// The inputs both cores refuse or read alike (the eleventh review round, 2026-11-04; test/vectors/inputs.json, read by the Rust core's
// tests/inputs.rs too): G11-7 — a seed that is no seed derives no key; G11-8 — a pasted privacy address is trimmed as JavaScript trims and
// holds printable ASCII only (a Kelvin sign and a byte-order mark had read here and been refused by the Rust decoder; U+0085 the reverse).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hexToBytes } from "@noble/hashes/utils";
import { decodePrivacyAddress } from "../src/address";
import { deriveKeys, SeedUnavailable } from "../src/keys";

const here = dirname(fileURLToPath(import.meta.url));
const v = JSON.parse(readFileSync(join(here, "vectors", "inputs.json"), "utf8")) as {
  refusedSeeds: { name: string; hex: string }[];
  addresses: { name: string; input: string; accept: boolean }[];
};
const accepted = (s: string): boolean => {
  try {
    decodePrivacyAddress(s);
    return true;
  } catch {
    return false;
  }
};

describe("the inputs both cores refuse or read alike (the eleventh review round, G11-7, G11-8)", () => {
  it("a seed that is no seed derives no key", () => {
    for (const s of v.refusedSeeds) expect(() => deriveKeys(hexToBytes(s.hex)), s.name).toThrow(SeedUnavailable);
  });

  it("a pasted address: trimmed as JavaScript trims, printable ASCII only — every vector as the shared file says", () => {
    for (const c of v.addresses) expect(accepted(c.input), c.name).toBe(c.accept);
    // a character outside printable ASCII is that, as the Rust decoder says it — never another error
    for (const c of v.addresses.filter((x) => !x.accept && /[^\x00-\x7f]/.test(x.input))) expect(() => decodePrivacyAddress(c.input), c.name).toThrow("invalid character");
    // every accepted form is the same address
    const ok = v.addresses.filter((c) => c.accept).map((c) => decodePrivacyAddress(c.input).ownerCommitment);
    expect(new Set(ok).size).toBe(1);
  });
});
