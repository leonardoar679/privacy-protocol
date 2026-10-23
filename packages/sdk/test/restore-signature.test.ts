// A restore is signed by the order's one-time key (audit round 2, r05). The API rebuilds an order — and answers its operation —
// only for the holder of that key: the params are public once an execution is tried, and anyone had named them with another
// destination. The wallet's digest is the engine's byte for byte (packages/swap-engine/test/endpoints.test.ts pins the same
// bytes), and the signature recovers to the order's signer.
import { describe, expect, it } from "vitest";
import { recoverAddress, type Address } from "viem";
import { restoreDigest, restoreRequestText } from "../src/swapGuard";
import { deriveOrderKey, signExecutionDigest } from "../src/keys/swapKeys";

describe("a restore's signature (audit round 2, r05)", () => {
  it("its digest is the engine's, names the request, and the order's key signs it", async () => {
    const escrow: Address = "0x00000000000000000000000000000000000e5c00";
    const text = restoreRequestText({
      from: { chain: "ethereum", asset: "native" },
      to: { chain: "bitcoin", asset: "native" },
      destination: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
      provider: "thorchain",
    });
    const digest = restoreDigest(1n, escrow, text);
    expect(digest).toBe("0x2eb2ec945fe04cd872bb62a315e6abfe0593766b1adfbef29307372888474916");
    expect(restoreDigest(1n, escrow, text.replace("thorchain", "chainflip")), "the provider is in it").not.toBe(digest);
    const key = deriveOrderKey(new Uint8Array(32).fill(3), ("0x" + "ab".repeat(32)) as `0x${string}`);
    const signature = await signExecutionDigest(key.privateKey, digest);
    expect((await recoverAddress({ hash: digest, signature })).toLowerCase()).toBe(key.address.toLowerCase());
  });
});
