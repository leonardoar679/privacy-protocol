// Pre-trade simulation (whale spec §24): deployAndExecute(params, execution) is simulated on every endpoint
// with a non-zero tip recipient; every endpoint must succeed; a revert is decoded with the escrow's errors;
// ProviderCallFailed on an ETH order triggers a second call from the escrow to the provider that recovers
// the provider's reason (never for an ERC-20 order); an endpoint rejecting the override counts as no
// answer; the preview carries the balance override on the predicted escrow.
import { describe, it, expect, afterAll } from "vitest";
import { encodeErrorResult, parseAbi, toFunctionSelector, type Hex } from "viem";
import { startMockCore, type MockTx } from "./helpers/mockRpc";
import { decodeRevert, encodeDeployAndExecute, SIMULATION_ACCOUNT, simulateExecution, swapFactoryAbi } from "@privacy-wallet/sdk/simulate";
import { predictEscrow } from "@privacy-wallet/sdk/swapGuard";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import type { ServiceOrderParams } from "@privacy-wallet/sdk/swapService";

const FACTORY = "0x00000000000000000000000000000000000000f1";
const PROVIDER = "0x00000000000000000000000000000000000000d1";
const CORE = "0x00000000000000000000000000000000000c0de0";
const params = (assetType = 0): ServiceOrderParams => ({
  orderId: ("0x" + "ab".repeat(32)) as Hex, assetType, asset: assetType === 0 ? "0x0000000000000000000000000000000000000000" : "0x00000000000000000000000000000000000000a0", amount: (10n ** 18n).toString(),
  orderSigner: "0x0000000000000000000000000000000000000051", executeDeadline: 2_000_000_000, refundAfter: 2_000_010_000, refundVault: "0x00000000000000000000000000000000000000e7",
  refundOwnerCommitment: "1", refundNoteSecret: "2", refundNoteDataHash: ("0x" + "cd".repeat(32)) as Hex, executorTip: (10n ** 15n).toString(),
});
const execution = { provider: PROVIDER as `0x${string}`, value: 99n * 10n ** 16n, providerCalldata: "0x1234" as Hex, deadline: 1_999_999_000, signature: ("0x" + "11".repeat(65)) as Hex };
const sel = (name: string) => toFunctionSelector(`${name}()`) as Hex;
const errorString = (s: string) => encodeErrorResult({ abi: parseAbi(["error Error(string message)"]), errorName: "Error", args: [s] });

const servers: { close: () => Promise<void> }[] = [];
afterAll(async () => { for (const s of servers) await s.close(); });
async function endpoint(onCall: (tx: MockTx, override?: unknown) => ReturnType<NonNullable<Parameters<typeof startMockCore>[0]["onCall"]>>, gas: bigint | { error: { code?: number; message: string } } = 210_000n) {
  const s = await startMockCore({ core: CORE, events: {}, nextLeafIndex: 0, root: 0n, onCall, onEstimateGas: () => gas });
  servers.push(s);
  return s;
}
const deployment = (urls: string[]): Deployment => ({ chainId: 1, core: CORE, ethVault: "0x00000000000000000000000000000000000000e7", rpcUrl: urls[0], rpcUrls: urls, fromBlock: 0n, erc20Vaults: [], swapFactory: FACTORY });
const ok = () => ({ result: "0x" as Hex });
const revert = (data: Hex) => ({ error: { code: 3, message: "execution reverted", data } });

describe("simulateExecution", () => {
  it("encodes exactly the factory call the relayer sends; the escrow errors decode by selector", () => {
    const data = encodeDeployAndExecute(params(), execution);
    expect(data.startsWith(toFunctionSelector(swapFactoryAbi[0]))).toBe(true);
    expect(decodeRevert(sel("NotFunded"))).toEqual({ name: "NotFunded", detail: "the escrow does not hold the order's amount yet" });
    expect(decodeRevert(sel("ProviderCallFailed"))!.name).toBe("ProviderCallFailed");
    expect(decodeRevert(errorString("slippage"))).toEqual({ name: "Error", detail: "slippage" });
    expect(decodeRevert("0x")).toBeNull();
    expect(decodeRevert("0xdeadbeef00")!.name).toBe("revert");
  });

  it("passes when every endpoint succeeds, with the tip recipient as the sender and the gas of the slowest estimate", async () => {
    const seen: MockTx[] = [];
    const a = await endpoint((tx) => { seen.push(tx); return ok(); }, 200_000n);
    const b = await endpoint(() => ok(), 230_000n);
    const r = await simulateExecution({ deployment: deployment([a.url, b.url]), factory: FACTORY, params: params(), execution });
    expect(r).toEqual({ ok: true, gas: 230_000n, endpoints: 2, preview: false });
    expect(seen[0].from?.toLowerCase()).toBe(SIMULATION_ACCOUNT);
    expect(seen[0].to?.toLowerCase()).toBe(FACTORY);
    expect(seen[0].data).toBe(encodeDeployAndExecute(params(), execution));
    const relayer = "0x00000000000000000000000000000000000000ee";
    const r2 = await simulateExecution({ deployment: deployment([a.url]), factory: FACTORY, params: params(), execution, account: relayer });
    expect(r2.ok).toBe(true);
    expect(seen.at(-1)!.from?.toLowerCase()).toBe(relayer);
  });

  it("a revert on one endpoint fails the simulation with the escrow's error decoded; the other endpoints' success does not outvote it", async () => {
    const a = await endpoint(() => ok());
    const b = await endpoint(() => revert(sel("NotFunded")));
    const r = await simulateExecution({ deployment: deployment([a.url, b.url]), factory: FACTORY, params: params(), execution });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("NotFunded");
    expect(r.reason).toMatch(/would revert \(NotFunded: the escrow does not hold/);
    expect(r.reverted).toEqual([`${b.url}: NotFunded`]);
    expect(r.noAnswer).toEqual([]);
  });

  it("ProviderCallFailed on an ETH order: the provider's reason is recovered by a second call from the escrow; an ERC-20 order reports the bare error", async () => {
    const escrow = predictEscrow(FACTORY, params()).toLowerCase();
    const inner: MockTx[] = [];
    const a = await endpoint((tx) => {
      if (tx.from?.toLowerCase() === escrow && tx.to?.toLowerCase() === PROVIDER) { inner.push(tx); return revert(errorString("THORChain: trading halted")); }
      return revert(sel("ProviderCallFailed"));
    });
    const r = await simulateExecution({ deployment: deployment([a.url]), factory: FACTORY, params: params(), execution });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("ProviderCallFailed");
    expect(r.providerReason).toBe("THORChain: trading halted");
    expect(r.reason).toMatch(/the provider says: THORChain: trading halted/);
    expect(inner).toHaveLength(1);
    expect(BigInt(inner[0].value!)).toBe(execution.value);
    expect(inner[0].data).toBe(execution.providerCalldata);
    inner.length = 0;
    const erc = await simulateExecution({ deployment: deployment([a.url]), factory: FACTORY, params: params(1), execution: { ...execution, value: 0n } });
    expect(erc.ok).toBe(false);
    if (erc.ok) return;
    expect(erc.providerReason).toBeUndefined();
    expect(inner, "no second call for an ERC-20 order").toHaveLength(0);
  });

  it("an unreachable endpoint or one rejecting the call's shape is no answer, which fails closed; the preview overrides the predicted escrow's balance", async () => {
    const escrow = predictEscrow(FACTORY, params()).toLowerCase();
    const overrides: unknown[] = [];
    const a = await endpoint((_tx, override) => { overrides.push(override); return ok(); });
    const b = await endpoint(() => ({ error: { code: -32602, message: "invalid argument 2: state override not supported" } }));
    const r = await simulateExecution({ deployment: deployment([a.url, b.url]), factory: FACTORY, params: params(), execution, preview: { balance: 10n ** 18n } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.preview).toBe(true);
    expect(r.reverted).toEqual([]);
    expect(r.noAnswer).toHaveLength(1);
    expect(r.noAnswer[0]).toMatch(new RegExp(`^${b.url}`));
    expect(r.reason).toBe("1 of 2 endpoints gave no answer to the simulation");
    const o = overrides[0] as Record<string, { balance: string }>;
    expect(Object.keys(o).map((k) => k.toLowerCase())).toEqual([escrow]);
    expect(BigInt(o[Object.keys(o)[0]].balance)).toBe(10n ** 18n);
    const dead = await simulateExecution({ deployment: deployment([a.url, "http://127.0.0.1:1"]), factory: FACTORY, params: params(), execution });
    expect(dead.ok).toBe(false);
    if (!dead.ok) expect(dead.noAnswer).toHaveLength(1);
  });
});
