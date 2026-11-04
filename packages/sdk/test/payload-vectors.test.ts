// Frozen vectors for the seed-derived payloads and the order key (the seventh review round, 2026-11-03): a phrase-only restore finds an
// earlier order's refund and delivery by regenerating these exact bytes, and an order's committed signer by re-deriving its key — a
// refactor that changed them (a 4-byte stream index, a little-endian counter, an orderId no longer lowercased) passed every test that
// checked only determinism. docs/wallet-formats.md §4 states the construction these pin.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deriveOrderKey, refundPayload, shieldPayload } from "../src/keys/swapKeys";

const seed = new Uint8Array(64).map((_, i) => (i * 7 + 3) & 0xff);
const sha = (h: string) =>
  createHash("sha256")
    .update(Buffer.from(h.slice(2), "hex"))
    .digest("hex");

describe("the seed-derived payloads and the order key, frozen", () => {
  it("the refund and shield payloads of counters 0 and 7", () => {
    const r7 = refundPayload(seed, 7);
    expect(r7).toBe(
      "0x01f7b3e9def62145852a6671c266468eb7af2128f6eb9ca44de903691a22c55d6bd8f6de9a03ae0741ed0d7cadf72ae57ed6b66e752a32e35b22553d9f913a58131ed4493a93fd65998a6831cc8bb3bd57592eb27129db9b0d54b0cc886d4e94f77069df5208a7e91a866ce93f515089f81aa9b711adcb08074a2fef686f035eb857b8e14865b3a7498ac46af9f2ad23ab43756072605d643327c876ef52fbc811f70e2e272c818ff7",
    );
    expect(sha(r7)).toBe("4c05f92a8d21043717168110ebeafd61055bf54172764ac3b4fa35076749abdc");
    expect(sha(shieldPayload(seed, 7))).toBe("f3119ea57fedae70d5affc4d4db7a264b5a5ff296e0e021ba1e88d73798461df");
    expect(sha(refundPayload(seed, 0))).toBe("d2df05c710924a534fafd4e343cd697b4bd850a2ade0e61784d38ab8ec86dd02");
  });
  it("an attempt's order key, the orderId read in lower case", () => {
    const k = deriveOrderKey(seed, ("0x" + "AB".repeat(32)) as `0x${string}`);
    expect(k.privateKey).toBe("0x5cbfd1d5302aca48e17c4957c90f73301bf6699a06f30bd6ff59ab667b6769cf");
    expect(k.address).toBe("0x09668c5663dBb16D2c5C3388CdF2A25d6723aD10");
    expect(deriveOrderKey(seed, ("0x" + "ab".repeat(32)) as `0x${string}`).privateKey).toBe(k.privateKey);
  });
});
