// The eleventh review round (2026-11-04), slice 2b after its critique: every reader of a third party's answer stops at its bound (T7 — only
// THORNode's inbound list and readCapped itself had been tested): the relayer's, the beacon API's, the swap service's — whose over-size body is
// refused, never read as an empty success —, THORNode's vault list. A declared length one byte past the reader's bound is refused before
// the body is read: a reader back on r.text() or r.json() would read the short body and answer. And the runner's own chain clock (T4): the
// block's seconds as milliseconds, null when the block cannot be read — never a time in 1969.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/swapFunding", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/swapFunding")>()), latestBlockTime: vi.fn() }));

import { AnswerTooLarge } from "@privacy-wallet/privacy-engine/transport/http";
import { connectivity } from "@privacy-wallet/privacy-engine/transport/connectivity";
import { apiCall } from "../src/api/client";
import { configure, defaultConfig } from "../src/config";
import { beaconApi } from "../src/lightclient/beacon";
import { relayerJobFor } from "../src/relayer";
import { thornodeActiveVault, THORNODE_ANSWER_MAX_BYTES } from "../src/providerCall";
import { latestBlockTime } from "../src/swapFunding";
import { orderIo } from "../src/wallet/orderRunner";
import type { Deployment } from "../src/chain";

const realFetch = globalThis.fetch;
beforeEach(() => configure(defaultConfig()));
afterEach(() => {
  globalThis.fetch = realFetch;
  connectivity.reset();
});

/** An answer whose declared length is one byte past `bound`, with a short, well-formed body. */
const pastBound =
  (bound: number, body: unknown): typeof fetch =>
  async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", "content-length": String(bound + 1) } });

describe("a third party's answer read to its reader's bound (the critique, T7)", () => {
  it("the relayer's: refused at 4 MiB", async () => {
    await expect(relayerJobFor("http://relayer.test", [1n, 2n], pastBound(4 * 1024 * 1024, { txHash: "0x" + "11".repeat(32) }))).rejects.toBeInstanceOf(
      AnswerTooLarge,
    );
  });

  it("the beacon API's: refused at 32 MiB", async () => {
    const get = beaconApi("https://beacon.test", pastBound(32 * 1024 * 1024, { data: [] }));
    await expect(get("/eth/v1/beacon/light_client/updates?start_period=1&count=1")).rejects.toBeInstanceOf(AnswerTooLarge);
  });

  it("the swap service's: refused, never read as an empty successful answer", async () => {
    globalThis.fetch = pastBound(8 * 1024 * 1024, { operationId: "op_1" });
    await expect(apiCall("/v1/operations", { amount: "1" })).rejects.toBeInstanceOf(AnswerTooLarge);
  });

  it("THORNode's vault list: a gateway past THORNODE_ANSWER_MAX_BYTES is no answer — never the vault confirmed", async () => {
    const vault = "bc1qvault";
    const list = [{ status: "ActiveVault", addresses: [{ chain: "BTC", address: vault }] }];
    await expect(
      thornodeActiveVault("BTC", vault, { gateways: ["https://thornode.test"], quorum: 1, fetchFn: pastBound(THORNODE_ANSWER_MAX_BYTES, list) }),
    ).rejects.toThrow(/only 0 of 1 THORNode gateways/);
    // control: the same list within the bound confirms the vault
    const fine: typeof fetch = async () => new Response(JSON.stringify(list), { status: 200 });
    expect(await thornodeActiveVault("BTC", vault, { gateways: ["https://thornode.test"], quorum: 1, fetchFn: fine })).toEqual({
      confirmedBy: ["https://thornode.test"],
    });
  });
});

describe("the runner's chain clock (the critique, T4, W5)", () => {
  const deployment = { chainId: 1 } as unknown as Deployment;
  it("the latest block's seconds as milliseconds; null when it cannot be read, and with no deployment", async () => {
    const io = orderIo({ masterSeed: new Uint8Array(32), deployment, session: undefined as never, submission: { kind: "wallet" } } as never);
    vi.mocked(latestBlockTime).mockResolvedValueOnce(1_800_000_000n);
    expect(await io.chainTime!()).toBe(1_800_000_000_000);
    vi.mocked(latestBlockTime).mockRejectedValueOnce(new Error("no block"));
    expect(await io.chainTime!(), "never -1000: a time in 1969").toBeNull();
    const none = orderIo({ masterSeed: new Uint8Array(32), deployment: null, session: undefined as never, submission: { kind: "wallet" } } as never);
    expect(await none.chainTime!()).toBeNull();
  });
});
