import { describe, it, expect } from "vitest";
import { hash, permute } from "../src/poseidon2";

// nargo-generated vectors (barretenberg v5.2.0), spec §2 — identical in circom / Solidity / Python.
const V = {
  perm0000_0: 0x18dfb8dc9b82229cff974efefc8df78b1ce96d9d844236b496785c698bc6732en,
  perm1234_0: 0x224785a48a72c75e2cbb698143e71d5d41bd89a2b9a7185871e39a54ce5785b1n,
  perm1234_3: 0x16c877b5b9c04d873218804ccbf65d0eeb12db447f66c9ca26fec380055df7e9n,
  h0: 0x2710144414c3a5f2354f4c08d52ed655b9fe253b4bf12cb9ad3de693d9b1db11n,
  h1: 0x168758332d5b3e2d13be8048c8011b454590e06c44bce7f702f09103eef5a373n,
  h00: 0x0b63a53787021a4a962a452c2921b3663aff1ffd8d5510540f8e659e782956f1n,
  h12: 0x038682aa1cb5ae4e0a3f13da432a95c77c5c111f6f030faf9cad641ce1ed7383n,
  h000: 0x2a5de47ed300af27b706aaa14762fc468f5cfc16cd8116eb6b09b0f2643ca2b9n,
  h123: 0x23864adb160dddf590f1d3303683ebcb914f828e2635f6e85a32f0a1aecd3dd8n,
  h1234: 0x130bf204a32cac1f0ace56c78b731aa3809f06df2731ebcf6b3464a15788b1b9n,
};

describe("Poseidon2 (BN254, t=4, Noir sponge) — nargo known answers", () => {
  it("permutation", () => {
    expect(permute([0n, 0n, 0n, 0n])[0]).toBe(V.perm0000_0);
    const s = permute([1n, 2n, 3n, 4n]);
    expect(s[0]).toBe(V.perm1234_0);
    expect(s[3]).toBe(V.perm1234_3);
  });
  it("sponge, 1..4 inputs (incl. the exact-chunk n=3 case)", () => {
    expect(hash([0n])).toBe(V.h0);
    expect(hash([1n])).toBe(V.h1);
    expect(hash([0n, 0n])).toBe(V.h00);
    expect(hash([1n, 2n])).toBe(V.h12);
    expect(hash([0n, 0n, 0n])).toBe(V.h000);
    expect(hash([1n, 2n, 3n])).toBe(V.h123);
    expect(hash([1n, 2n, 3n, 4n])).toBe(V.h1234);
  });
  it("length is bound through the IV", () => {
    expect(hash([1n, 2n])).not.toBe(hash([1n, 2n, 0n]));
  });
});
