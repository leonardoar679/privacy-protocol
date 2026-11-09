// The twelfth review round's second critique (XB) of C12-4: the hand-over journals, beside the refund tokens the signed call names, the pool's
// vault of each with that token's floor — what tells a step's refund in another token (a note in one of those vaults at its floor) from a note
// anyone holding the order's payload can make in any vault.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/relayer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/relayer")>()),
  relayerSwapExecute: vi.fn(async () => ({ id: "job-9", escrow: "0x00000000000000000000000000000000000000e5", state: "executing", updatedAt: Date.now() })),
  relayerSwapRefund: vi.fn(async () => ({ id: "job-10", escrow: "0x00000000000000000000000000000000000000e5", state: "refund-only", updatedAt: Date.now() })),
}));

import { configure, defaultConfig } from "../src/config";
import { memoryStorage } from "../src/wallet/storage";
import { session } from "../src/wallet/session";
import { swapService } from "../src/swapService";
import { handOverSigned, returnOrderToBalance, type Signed } from "../src/swapExecute";
import { relayerSwapExecute, relayerSwapRefund } from "../src/relayer";
import { WRAPPED_NATIVE_OF } from "@privacy-wallet/contracts/deployments";
import type { StoredSwap } from "../src/wallet/journal";
import type { Deployment } from "../src/chain";

const ORDER = "0x" + "9c".repeat(32);
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDC_VAULT = "0x00000000000000000000000000000000000000C5";

beforeAll(async () => {
  configure(defaultConfig({ storage: () => memoryStorage(), kdfLog2N: 12 }));
  await session.create("a strong password");
  session.acknowledgePhrase();
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("the hand-over journals the vaults of the call's refund tokens", () => {
  it("each refund token's vault, by the vault's lower case, with the token's floor; a token the pool has no vault for, none", async () => {
    const stored = {
      orderId: ORDER,
      attemptId: "0x" + "01".repeat(32),
      refundCounter: 3,
      provider: "mayan",
      policy: "balanced",
      request: {
        from: { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" },
        to: { chain: "solana", asset: "native", decimals: 9, symbol: "SOL" },
        amount: "1",
        destination: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      },
      params: { amount: "1" },
      endpoint: "0x00000000000000000000000000000000000000e5",
      state: "funded",
      operationId: "op_test",
      refundNoteData: "0x00",
      createdAt: Date.now(),
    } as unknown as StoredSwap;
    session.update((j) => {
      j.swaps = [stored];
    });
    const finalize = vi.spyOn(swapService, "finalize").mockResolvedValue({ execution: { calldata: "0x" }, order: {} } as never);
    const deployment = {
      chainId: 1,
      erc20Vaults: [{ symbol: "USDC", decimals: 6, token: USDC, vault: USDC_VAULT }],
      swapFactory: "0x00000000000000000000000000000000000000f5",
    } as unknown as Deployment;
    const signed = {
      prepared: {
        deadline: Math.floor(Date.now() / 1000) + 3600,
        provider: "0x00000000000000000000000000000000000000a7",
        value: "0",
        calldata: "0x",
        digest: "0x",
      },
      params: {},
      call: {
        refundTokens: [USDC, "0x00000000000000000000000000000000000000d1"],
        refundFloors: { [USDC.toLowerCase()]: "1000000", "0x00000000000000000000000000000000000000d1": "5" },
      },
      signature: "0x",
      sim: { ok: true },
      label: "",
    } as unknown as Signed;
    await handOverSigned({ deployment, stored, order: { orderId: ORDER } as never, signed, submission: { kind: "relayer", url: "http://relayer.test" } });
    expect(finalize).toHaveBeenCalledOnce();
    const after = session.journal().swaps.find((x) => x.orderId === ORDER)!;
    expect(after.refundTokens).toEqual([USDC, "0x00000000000000000000000000000000000000d1"]);
    expect(after.refundVaults).toEqual({ [USDC_VAULT.toLowerCase()]: "1000000" });
    expect(after.jobId).toBe("job-9");
  });
});

// The sixth critique (XF): an unfilled Across deposit of ETH comes back to the escrow as WETH, which refundToken(address(0)) never unwraps — an
// ERC-20 order whose route refunds in ETH lists wrapped ETH beside it, for the executor and for Return funds alike.
describe("wrapped ETH beside an ETH refund token of an ERC-20 order", () => {
  const ZERO = "0x0000000000000000000000000000000000000000";
  const WETH = WRAPPED_NATIVE_OF[1];
  const ETH_VAULT = "0x00000000000000000000000000000000000000E7";
  const FLOOR = "30000000000000000";
  const deployment = {
    chainId: 1,
    ethVault: ETH_VAULT,
    erc20Vaults: [{ symbol: "USDC", decimals: 6, token: USDC, vault: USDC_VAULT }],
    swapFactory: "0x00000000000000000000000000000000000000f5",
  } as unknown as Deployment;
  const usdcOrder = (extra: Partial<StoredSwap> = {}) =>
    ({
      orderId: ORDER,
      attemptId: "0x" + "01".repeat(32),
      refundCounter: 4,
      provider: "lifi",
      policy: "balanced",
      request: {
        from: { chain: "ethereum", asset: USDC, decimals: 6, symbol: "USDC" },
        to: { chain: "arbitrum", asset: "native", decimals: 18, symbol: "ETH" },
        amount: "10000000000",
        destination: "0x" + "11".repeat(20),
      },
      params: { amount: "10000000000", refundAfter: Math.floor(Date.now() / 1000) - 60 },
      endpoint: "0x00000000000000000000000000000000000000e5",
      state: "funded",
      operationId: "op_test",
      refundNoteData: "0x00",
      createdAt: Date.now(),
      ...extra,
    }) as unknown as StoredSwap;

  it("the hand-over lists it at address(0)'s floor: journaled, its vault the ETH vault, and handed to the executor", async () => {
    const stored = usdcOrder();
    session.update((j) => {
      j.swaps = [stored];
    });
    vi.spyOn(swapService, "finalize").mockResolvedValue({ execution: { calldata: "0x" }, order: {} } as never);
    const signed = {
      prepared: {
        deadline: Math.floor(Date.now() / 1000) + 3600,
        provider: "0x00000000000000000000000000000000000000a7",
        value: "0",
        calldata: "0x",
        digest: "0x",
      },
      params: {},
      call: { refundTokens: [ZERO], refundFloors: { [ZERO]: FLOOR } },
      signature: "0x",
      sim: { ok: true },
      label: "",
    } as unknown as Signed;
    await handOverSigned({ deployment, stored, order: { orderId: ORDER } as never, signed, submission: { kind: "relayer", url: "http://relayer.test" } });
    const after = session.journal().swaps.find((x) => x.orderId === ORDER)!;
    expect(after.refundTokens).toEqual([ZERO, WETH]);
    expect(after.refundFloors).toEqual({ [ZERO]: FLOOR, [WETH.toLowerCase()]: FLOOR });
    expect(after.refundVaults).toEqual({ [ETH_VAULT.toLowerCase()]: FLOOR });
    expect(vi.mocked(relayerSwapExecute).mock.calls.at(-1)?.[1]).toMatchObject({
      refundTokens: [ZERO, WETH],
      refundFloors: { [ZERO]: FLOOR, [WETH.toLowerCase()]: FLOOR },
    });
  });

  it("Return funds for an order journaled before (address(0) alone): the refund-only job is asked for its wrapped ETH too", async () => {
    const stored = usdcOrder({ state: "executed", refundTokens: [ZERO], refundFloors: { [ZERO]: FLOOR } } as Partial<StoredSwap>);
    session.update((j) => {
      j.swaps = [stored];
    });
    await returnOrderToBalance({ deployment, stored, submission: { kind: "relayer", url: "http://relayer.test" } });
    expect(vi.mocked(relayerSwapRefund).mock.calls.at(-1)?.[1]).toMatchObject({
      refundTokens: [ZERO, WETH],
      refundFloors: { [ZERO]: FLOOR, [WETH.toLowerCase()]: FLOOR },
    });
    expect(session.journal().swaps.find((x) => x.orderId === ORDER)?.jobId).toBe("job-10");
  });

  it("Return funds answered with the relayer's stored 'refunded' job (it reopens only an executed one): refused, the order never journaled refunded on that word", async () => {
    const stored = usdcOrder({ state: "executing", jobId: "job-1" } as Partial<StoredSwap>);
    session.update((j) => {
      j.swaps = [stored];
    });
    vi.mocked(relayerSwapRefund).mockResolvedValueOnce({
      id: "job-1",
      escrow: "0x00000000000000000000000000000000000000e5",
      state: "refunded",
      updatedAt: Date.now(),
    } as never);
    await expect(returnOrderToBalance({ deployment, stored, submission: { kind: "relayer", url: "http://relayer.test" } })).rejects.toMatchObject({
      code: "refund_not_watched",
    });
    expect(session.journal().swaps.find((x) => x.orderId === ORDER)?.state).toBe("executing");
  });
});
