// A swap is funded only when the relayer that will execute it runs it (a V6 follow-up of 2026-10-16): its /info names the
// swap factory it executes for and the swap service's addresses whose vouches it runs. A relayer that names another factory,
// or a list without the service's key, would refuse the funded escrow's execution and its refund alike, and the funds would
// wait for the refund time with nobody to move them; such a swap stops before anything is sent.
import { describe, expect, it } from "vitest";
import { relayerRunsFor } from "../src/relayer";
import { checkRelayerReady, RelayerNotReady } from "../src/swapFunding";
import type { ServiceHealth } from "../src/swapService";

const FACTORY = "0x00000000000000000000000000000000000000f5";
const KEY = "0xd311b8bb3670cf035826c73a2c8286ad8bacc94e";
const health = (voucher: string | null | undefined): ServiceHealth =>
  ({
    deployment: { chainId: 1, factory: FACTORY, nativeVault: "0x00000000000000000000000000000000000000e1", ...(voucher !== undefined ? { voucher } : {}) },
    providers: {},
  }) as ServiceHealth;

describe("whether a relayer runs this wallet's swap", () => {
  it("its factory and the swap service's key, as far as its /info names them; a relayer that names neither is not checked", () => {
    const upper = (a: string) => a.toUpperCase().replace("0X", "0x") as `0x${string}`;
    expect(relayerRunsFor({ swapFactory: FACTORY, vouchers: [KEY] }, { factory: upper(FACTORY), voucher: upper(KEY) }), "in any case").toBeNull();
    expect(relayerRunsFor({}, { factory: FACTORY, voucher: null }), "an older relayer").toBeNull();
    expect(relayerRunsFor({ swapFactory: "0x00000000000000000000000000000000000000f6" }, { factory: FACTORY, voucher: KEY })).toMatch(
      /executes swaps for 0x0+f6, not for this wallet's/,
    );
    expect(relayerRunsFor({ vouchers: ["0x" + "ab".repeat(20)] }, { factory: FACTORY, voucher: KEY }), "still on another key").toMatch(
      /its key is not among the relayer's/,
    );
    expect(relayerRunsFor({ vouchers: [] }, { factory: FACTORY, voucher: KEY }), "a relayer that runs no swaps").toMatch(/not among/);
    expect(relayerRunsFor({ vouchers: [KEY] }, { factory: FACTORY, voucher: null }), "a service that vouches for nothing").toMatch(/vouches for nothing/);
  });

  it("checkRelayerReady throws RelayerNotReady before anything is sent, and reads the service only when the relayer names its list", async () => {
    let healthReads = 0;
    const deps = (info: { swapFactory?: string; vouchers?: string[] }, h: ServiceHealth = health(KEY)) => ({
      info: async () => info as never,
      health: async () => {
        healthReads++;
        return h;
      },
    });
    await expect(checkRelayerReady("http://relayer.test", FACTORY, deps({ swapFactory: FACTORY, vouchers: [KEY] }))).resolves.toBeUndefined();
    expect(healthReads).toBe(1);
    await expect(checkRelayerReady("http://relayer.test", FACTORY, deps({ swapFactory: FACTORY }))).resolves.toBeUndefined();
    expect(healthReads, "no list: the service is not asked").toBe(1);
    const refused = await checkRelayerReady("http://relayer.test", FACTORY, deps({ vouchers: ["0x" + "ab".repeat(20)] })).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(RelayerNotReady);
    expect(refused).toMatchObject({ code: "relayer_not_ready", message: expect.stringMatching(/^Not funded: .*Nothing was sent\.$/) });
    await expect(
      checkRelayerReady("http://relayer.test", FACTORY, deps({ vouchers: [KEY] }, health(undefined))),
      "a service from before the vouches: no voucher named",
    ).rejects.toMatchObject({ code: "relayer_not_ready" });
    const down = checkRelayerReady("http://relayer.test", FACTORY, { info: async () => Promise.reject(new TypeError("fetch failed")) });
    await expect(down, "an unreachable relayer is an ordinary error, retried").rejects.toThrow(TypeError);
  });
});
