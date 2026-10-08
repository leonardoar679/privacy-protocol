// Pre-trade simulation (whale spec §24, plan V2 §9): before the signed execution leaves this wallet, the
// exact transaction the relayer would send — SwapOrderFactory.deployAndExecute(params, execution) — is
// simulated through every configured RPC endpoint (eth_call, then eth_estimateGas) with a non-zero
// account as the tip recipient (the tip goes to msg.sender; an ERC-20 tip to address(0) reverts as
// TipTransferFailed). Every endpoint must succeed: a revert anywhere fails the simulation with the
// escrow's own error decoded; an endpoint that gives no answer (unreachable, or rejecting the call's shape)
// is reported as such and counts against success. ProviderCallFailed discards the provider's returndata,
// so for an ETH order a second eth_call from the escrow to the provider recovers the provider's reason.
// Before funding, an ETH order can be previewed with a balance override on the predicted escrow. The
// signature never leaves the wallet until the simulation passes; the relayer's own estimateGas gate stays.
import { decodeErrorResult, encodeFunctionData, parseAbi, toFunctionSelector, type Address, type Hex } from "viem";
import { abi as escrowJsonAbi } from "../../../contracts/abi/periphery/SwapOrderEscrow.json";
import { clientsFor, type Deployment } from "./chain";
import { predictEscrow } from "./swapGuard";
import type { ServiceOrderParams } from "./swapService";

const ORDER_PARAMS = "(bytes32 orderId, uint8 assetType, address asset, uint256 amount, address orderSigner, uint64 executeDeadline, uint64 refundAfter, address refundVault, uint256 refundOwnerCommitment, uint256 refundNoteSecret, bytes32 refundNoteDataHash, uint256 executorTip)";
const EXECUTION = "(address provider, uint256 value, bytes providerCalldata, uint64 deadline, bytes signature)";
/** The factory's entry points, exactly as the relayer encodes them (services/relayer/src/swapExecutor.ts). */
export const swapFactoryAbi = parseAbi([`function deployAndExecute(${ORDER_PARAMS} p, ${EXECUTION} x)`, `function deployAndRefund(${ORDER_PARAMS} p, bytes noteData)`]);
/** The tip recipient of a simulation: a plain, non-zero address (the relayer's own when known). */
export const SIMULATION_ACCOUNT: Address = "0x0000000000000000000000000000000000000001";
export const ASSET_ETH = 0;

export interface Execution { provider: Address; value: bigint; providerCalldata: Hex; deadline: number; signature: Hex }
export interface SimulationOk { ok: true; gas: bigint; endpoints: number; preview: boolean }
export interface SimulationFailed {
  ok: false;
  /** one sentence for the screen */
  reason: string;
  /** the decoded escrow / factory error, when the call reverted */
  error?: string;
  /** the provider's own reason, recovered by the second call (ETH orders) */
  providerReason?: string;
  /** endpoints that reverted, with what they said */
  reverted: string[];
  /** endpoints that gave no usable answer */
  noAnswer: string[];
  preview: boolean;
}
export type Simulation = SimulationOk | SimulationFailed;

export function encodeDeployAndExecute(p: ServiceOrderParams, x: Execution): Hex {
  return encodeFunctionData({
    abi: swapFactoryAbi, functionName: "deployAndExecute",
    args: [
      { orderId: p.orderId, assetType: p.assetType, asset: p.asset, amount: BigInt(p.amount), orderSigner: p.orderSigner, executeDeadline: BigInt(p.executeDeadline), refundAfter: BigInt(p.refundAfter), refundVault: p.refundVault, refundOwnerCommitment: BigInt(p.refundOwnerCommitment), refundNoteSecret: BigInt(p.refundNoteSecret), refundNoteDataHash: p.refundNoteDataHash, executorTip: BigInt(p.executorTip) },
      { provider: x.provider, value: x.value, providerCalldata: x.providerCalldata, deadline: BigInt(x.deadline), signature: x.signature },
    ],
  });
}

/** The escrow's custom errors by selector (all without arguments), plus Error(string) and Panic(uint256). */
const ESCROW_ERRORS: Record<string, string> = Object.fromEntries((escrowJsonAbi as { type: string; name?: string; inputs?: unknown[] }[]).filter((x) => x.type === "error" && x.name && !(x.inputs ?? []).length).map((x) => [toFunctionSelector(`${x.name}()`), x.name!]));
const ERROR_ABI = parseAbi(["error Error(string message)", "error Panic(uint256 code)"]);
const ERROR_MEANING: Record<string, string> = {
  NotFunded: "the escrow does not hold the order's amount yet",
  DeadlinePassed: "the signed quote has expired; confirm again with a fresh one",
  DeadlineTooLate: "the execution deadline is past the order's",
  BadSignature: "the signature does not match the order key",
  AlreadyExecuted: "this order was already executed",
  ProviderCallFailed: "the provider rejected the call",
  TipTransferFailed: "the executor tip could not be paid",
  ValueTooLarge: "the call forwards more than the escrow holds",
};

export function decodeRevert(data: Hex | undefined): { name: string; detail: string } | null {
  if (!data || data === "0x") return null;
  const sel = data.slice(0, 10).toLowerCase();
  if (ESCROW_ERRORS[sel]) return { name: ESCROW_ERRORS[sel], detail: ERROR_MEANING[ESCROW_ERRORS[sel]] ?? ESCROW_ERRORS[sel] };
  try {
    const d = decodeErrorResult({ abi: ERROR_ABI, data });
    if (d.errorName === "Error") return { name: "Error", detail: String(d.args?.[0] ?? "") };
    if (d.errorName === "Panic") return { name: "Panic", detail: `panic code ${String(d.args?.[0])}` };
  } catch { /* not a standard error */ }
  return { name: "revert", detail: `revert data ${data.slice(0, 18)}…` };
}

/** The revert data of a JSON-RPC error, wherever the transport put it. */
export function revertDataOf(e: unknown): Hex | undefined {
  let cur: any = e;
  for (let i = 0; i < 6 && cur; i++) {
    const d = cur.data;
    if (typeof d === "string" && /^0x([0-9a-fA-F]{2})*$/.test(d)) return d as Hex;
    if (d && typeof d === "object" && typeof d.data === "string" && /^0x/.test(d.data)) return d.data as Hex;
    cur = cur.cause;
  }
  const m = /(0x[0-9a-fA-F]{8,})/.exec(String((e as any)?.details ?? (e as any)?.message ?? ""));
  return m ? (m[1] as Hex) : undefined;
}

/** A JSON-RPC error that is the call reverting (an answer about the transaction), not the endpoint failing. */
const isRevert = (e: unknown): boolean => !!revertDataOf(e) || /revert|execution reverted/i.test(String((e as any)?.details ?? (e as any)?.message ?? ""));

type Override = Record<string, { balance: Hex }>;
const hex = (v: bigint): Hex => `0x${v.toString(16)}`;

export async function simulateExecution(o: {
  deployment: Deployment; factory: Address; params: ServiceOrderParams; execution: Execution;
  /** the tip recipient (the relayer's address when known); never the zero address */
  account?: Address;
  /** pre-funding preview: give the predicted escrow this balance (ETH orders only) */
  preview?: { balance: bigint };
}): Promise<Simulation> {
  const account = o.account && o.account !== "0x0000000000000000000000000000000000000000" ? o.account : SIMULATION_ACCOUNT;
  const escrow = predictEscrow(o.factory, o.params);
  const data = encodeDeployAndExecute(o.params, o.execution);
  const tx = { from: account, to: o.factory, data };
  const override: Override | undefined = o.preview ? { [escrow]: { balance: hex(o.preview.balance) } } : undefined;
  const clients = clientsFor(o.deployment);
  const urls = o.deployment.rpcUrls?.length ? o.deployment.rpcUrls : [o.deployment.rpcUrl];
  const reverted: string[] = [], noAnswer: string[] = [];
  let error: { name: string; detail: string } | undefined;
  let revertData: Hex | undefined;
  let gas = 0n;
  await Promise.all(clients.map(async (client, i) => {
    const url = urls[i];
    const req = (method: string, params: unknown[]) => (client.request as (a: { method: string; params: unknown[] }) => Promise<unknown>)({ method, params });
    try {
      await req("eth_call", [tx, "latest", ...(override ? [override] : [])]);
      const g = await req("eth_estimateGas", override ? [tx, "latest", override] : [tx]);
      const n = BigInt(String(g));
      if (n > gas) gas = n;
    } catch (e) {
      if (isRevert(e)) {
        const d = revertDataOf(e);
        const dec = decodeRevert(d) ?? { name: "revert", detail: String((e as any)?.details ?? (e as any)?.message ?? e).slice(0, 160) };
        if (!error) { error = dec; revertData = d; }
        reverted.push(`${url}: ${dec.name}`);
      } else noAnswer.push(`${url}: ${String((e as any)?.shortMessage ?? (e as any)?.message ?? e).slice(0, 120)}`);
    }
  }));
  const preview = !!o.preview;
  if (reverted.length) {
    let providerReason: string | undefined;
    if (error?.name === "ProviderCallFailed" && o.params.assetType === ASSET_ETH) {
      // the escrow discards the provider's returndata: ask the provider directly, as the escrow would
      const inner = { from: escrow, to: o.execution.provider, value: hex(o.execution.value), data: o.execution.providerCalldata };
      for (const client of clients) {
        try {
          await (client.request as (a: { method: string; params: unknown[] }) => Promise<unknown>)({ method: "eth_call", params: [inner, "latest", ...(override ? [override] : [])] });
        } catch (e) {
          const dec = decodeRevert(revertDataOf(e));
          if (dec) { providerReason = dec.name === "Error" ? dec.detail : `${dec.name}: ${dec.detail}`; break; }
        }
      }
    }
    void revertData;
    return { ok: false, reason: `the execution would revert (${error!.name}: ${error!.detail})${providerReason ? `; the provider says: ${providerReason}` : ""}`, error: error!.name, providerReason, reverted, noAnswer, preview };
  }
  if (noAnswer.length) return { ok: false, reason: `${noAnswer.length} of ${clients.length} endpoints gave no answer to the simulation`, reverted, noAnswer, preview };
  return { ok: true, gas, endpoints: clients.length, preview };
}
