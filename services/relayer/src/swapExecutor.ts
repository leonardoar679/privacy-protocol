// Swap-order executor (private-swap spec v1.1 §3, §7, §11): once the wallet has funded a one-time
// escrow with a private withdrawal, somebody has to deploy it and forward the order to the provider
// — `SwapOrderFactory.deployAndExecute(params, execution)` — and, if the order was never executed or
// the provider refunded, re-shield the balance after `refundAfter` — `deployAndRefund(params, noteData)`.
// Both pay the committed tip to msg.sender, so a relayer does it for the tip. It can do nothing
// else: the escrow address is a function of the params, the provider call is signed by the one-time
// order key (provider, value, calldata, deadline), and the refund payload must hash to the committed
// value. The executor checks all of that locally before spending gas, then watches the escrow:
//   waiting-funding ──(balance ≥ amount, before the signed deadline)──▶ executing ──▶ executed ──▶ completed
//        │ deadline passed ▶ expired                                               ▲ leftover after refundAfter
//        └──────────────── refundAfter reached with a balance ──▶ refunding ──▶ refunded ◀─┘
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFunctionData, keccak256, parseAbi, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import type { Journal } from "./journal";
import { executionDigest, predictEscrow, recoverExecutionSigner } from "../../private-swap/src/endpoints";
import type { OrderParams } from "../../private-swap/src/types";

const ORDER_PARAMS = "(bytes32 orderId, uint8 assetType, address asset, uint256 amount, address orderSigner, uint64 executeDeadline, uint64 refundAfter, address refundVault, uint256 refundOwnerCommitment, uint256 refundNoteSecret, bytes32 refundNoteDataHash, uint256 executorTip)";
const EXECUTION = "(address provider, uint256 value, bytes providerCalldata, uint64 deadline, bytes signature)";
export const factoryAbi = parseAbi([
  `function deployAndExecute(${ORDER_PARAMS} p, ${EXECUTION} x)`,
  `function deployAndRefund(${ORDER_PARAMS} p, bytes noteData)`,
  `function predict(${ORDER_PARAMS} p) view returns (address)`,
]);
const erc20Abi = parseAbi(["function balanceOf(address owner) view returns (uint256)"]);

export interface SwapParamsJson { orderId: Hex; assetType: number; asset: Address; amount: string; orderSigner: Address; executeDeadline: number; refundAfter: number; refundVault: Address; refundOwnerCommitment: string; refundNoteSecret: string; refundNoteDataHash: Hex; executorTip: string }
export interface SwapExecutionJson { provider: Address; value: string; providerCalldata: Hex; deadline: number; signature: Hex }
export interface SwapJobRequest { factory: Address; params: SwapParamsJson; execution: SwapExecutionJson; refundNoteData: Hex }
export type SwapJobState = "waiting-funding" | "expired" | "executing" | "executed" | "execute-failed" | "refunding" | "refunded" | "refund-failed" | "completed";
export interface SwapJob { id: string; escrow: Address; factory: Address; params: SwapParamsJson; execution: SwapExecutionJson; refundNoteData: Hex; state: SwapJobState; txHash?: Hex; error?: string; balance?: string; createdAt: number; updatedAt: number }

export class SwapJobError extends Error { constructor(public readonly code: string, message: string) { super(message); } }

const isHex = (x: unknown, bytes?: number) => typeof x === "string" && /^0x[0-9a-fA-F]*$/.test(x) && (bytes === undefined || (x.length - 2) / 2 === bytes);
const TERMINAL: SwapJobState[] = ["refunded", "completed", "refund-failed"];

export function loadEscrowCreationCode(): Hex {
  const p = join(dirname(fileURLToPath(import.meta.url)), "../../../contracts/abi/periphery/SwapOrderEscrow.json");
  return JSON.parse(readFileSync(p, "utf8")).bytecode as Hex;
}

function toEngineParams(p: SwapParamsJson): OrderParams {
  return { orderId: p.orderId, assetType: p.assetType as 0 | 1, asset: p.asset, amount: BigInt(p.amount), orderSigner: p.orderSigner, executeDeadline: Number(p.executeDeadline), refundAfter: Number(p.refundAfter), refundVault: p.refundVault, refundOwnerCommitment: BigInt(p.refundOwnerCommitment), refundNoteSecret: BigInt(p.refundNoteSecret), refundNoteDataHash: p.refundNoteDataHash, executorTip: BigInt(p.executorTip) };
}
const paramsTuple = (p: SwapParamsJson) => ({ orderId: p.orderId, assetType: p.assetType, asset: p.asset, amount: BigInt(p.amount), orderSigner: p.orderSigner, executeDeadline: BigInt(p.executeDeadline), refundAfter: BigInt(p.refundAfter), refundVault: p.refundVault, refundOwnerCommitment: BigInt(p.refundOwnerCommitment), refundNoteSecret: BigInt(p.refundNoteSecret), refundNoteDataHash: p.refundNoteDataHash, executorTip: BigInt(p.executorTip) });
const executionTuple = (x: SwapExecutionJson) => ({ provider: x.provider, value: BigInt(x.value), providerCalldata: x.providerCalldata, deadline: BigInt(x.deadline), signature: x.signature });
export const encodeDeployAndExecute = (p: SwapParamsJson, x: SwapExecutionJson): Hex => encodeFunctionData({ abi: factoryAbi, functionName: "deployAndExecute", args: [paramsTuple(p), executionTuple(x)] });
export const encodeDeployAndRefund = (p: SwapParamsJson, noteData: Hex): Hex => encodeFunctionData({ abi: factoryAbi, functionName: "deployAndRefund", args: [paramsTuple(p), noteData] });

/** States in which a newer execution (re-signed with a fresh quote) may replace the stored one. */
const REPLACEABLE: SwapJobState[] = ["waiting-funding", "expired", "execute-failed"];

export class SwapExecutor {
  private jobs = new Map<string, SwapJob>();
  constructor(readonly cfg: { chainId: number; escrowCreationCode: Hex; account: PrivateKeyAccount; publicClient: PublicClient; walletClient: WalletClient; now?: () => number; journal?: Journal<SwapJob> }) {
    for (const j of cfg.journal?.load() ?? []) this.jobs.set(j.id, j); // restart: resume every open job
  }

  private now(): number { return this.cfg.now ? this.cfg.now() : Math.floor(Date.now() / 1000); }
  private persist(): void { this.cfg.journal?.save([...this.jobs.values()]); }

  /** Everything checkable before watching the chain; throws SwapJobError. */
  add(req: SwapJobRequest): SwapJob {
    const p = req?.params, x = req?.execution;
    if (!p || !x || !isHex(req.factory, 20)) throw new SwapJobError("bad_request", "factory, params and execution are required");
    if (Number(p.assetType) !== 0 && Number(p.assetType) !== 1) throw new SwapJobError("unsupported_asset", "assetType must be 0 (ETH) or 1 (ERC-20)");
    if (Number(p.assetType) === 1 && BigInt(x.value) !== 0n) throw new SwapJobError("bad_execution", "an ERC-20 order forwards no ETH value (the provider pulls the tokens)");
    if (!isHex(req.refundNoteData, 169)) throw new SwapJobError("bad_refund_payload", "refundNoteData must be the 169-byte payload");
    if (keccak256(req.refundNoteData) !== p.refundNoteDataHash.toLowerCase()) throw new SwapJobError("refund_payload_mismatch", "refundNoteData does not hash to the committed refundNoteDataHash");
    if (!(Number(p.executeDeadline) < Number(p.refundAfter))) throw new SwapJobError("bad_deadlines", "executeDeadline must precede refundAfter");
    if (!(Number(x.deadline) <= Number(p.executeDeadline))) throw new SwapJobError("bad_deadlines", "the signed deadline exceeds the committed executeDeadline");
    if (!isHex(x.signature, 65) || !isHex(x.providerCalldata) || !isHex(x.provider, 20)) throw new SwapJobError("bad_execution", "execution needs provider, calldata and a 65-byte signature");
    const escrow = predictEscrow(req.factory, this.cfg.escrowCreationCode, toEngineParams(p));
    const digest = executionDigest(BigInt(this.cfg.chainId), escrow, p.orderId, x.provider, BigInt(x.value), x.providerCalldata, Number(x.deadline));
    let signer: string;
    try { signer = recoverExecutionSigner(digest, x.signature); } catch (e) { throw new SwapJobError("bad_signature", String((e as Error).message)); }
    if (signer.toLowerCase() !== p.orderSigner.toLowerCase()) throw new SwapJobError("bad_signature", `the execution is signed by ${signer}, not the order signer ${p.orderSigner}`);
    if (BigInt(x.value) > BigInt(p.amount) - BigInt(p.executorTip)) throw new SwapJobError("bad_execution", "value exceeds the escrow's spendable balance");
    const id = p.orderId.toLowerCase();
    const state: SwapJobState = this.now() > Number(x.deadline) ? "expired" : "waiting-funding";
    const existing = this.jobs.get(id);
    if (existing) {
      // a re-signed execution (fresh quote after expiry / a failed provider call) replaces the old one; an order already executing or settled is left alone
      if (REPLACEABLE.includes(existing.state) && existing.escrow.toLowerCase() === escrow.toLowerCase()) {
        existing.execution = x; existing.state = state; existing.txHash = undefined; existing.error = undefined; existing.updatedAt = Date.now();
        this.persist();
      }
      return existing;
    }
    const job: SwapJob = { id, escrow, factory: req.factory, params: p, execution: x, refundNoteData: req.refundNoteData, state, createdAt: Date.now(), updatedAt: Date.now() };
    this.jobs.set(id, job);
    this.persist();
    return job;
  }

  /** The balance held by the escrow, in the order asset (ETH or the ERC-20). */
  private async escrowBalance(job: SwapJob): Promise<bigint> {
    if (Number(job.params.assetType) === 1) return (await this.cfg.publicClient.readContract({ address: job.params.asset, abi: erc20Abi, functionName: "balanceOf", args: [job.escrow] })) as bigint;
    return this.cfg.publicClient.getBalance({ address: job.escrow });
  }

  get(id: string): SwapJob | undefined { return this.jobs.get(id.toLowerCase()); }
  list(): SwapJob[] { return [...this.jobs.values()]; }

  private async send(job: SwapJob, data: Hex, next: SwapJobState, failed: SwapJobState): Promise<void> {
    let gas: bigint;
    try {
      gas = await this.cfg.publicClient.estimateGas({ account: this.cfg.account.address, to: job.factory, data });
    } catch (e) {
      job.state = failed; job.error = `would revert: ${String((e as Error).message).split("\n")[0].slice(0, 200)}`; job.updatedAt = Date.now();
      this.persist();
      return;
    }
    try {
      job.txHash = await this.cfg.walletClient.sendTransaction({ account: this.cfg.account, chain: this.cfg.walletClient.chain, to: job.factory, data, gas: (gas * 12n) / 10n });
      job.state = next; job.error = undefined;
    } catch (e) {
      job.state = failed; job.error = String((e as Error).message).split("\n")[0].slice(0, 200);
    }
    job.updatedAt = Date.now();
    this.persist();
  }

  /** One pass over every open job: read the escrow balance and the clock, act exactly once per state change. */
  async tick(): Promise<void> {
    const now = this.now();
    for (const job of this.jobs.values()) {
      if (TERMINAL.includes(job.state)) continue;
      const p = job.params;
      if (job.state === "executing" || job.state === "refunding") {
        const receipt = job.txHash ? await this.cfg.publicClient.getTransactionReceipt({ hash: job.txHash }).catch(() => null) : null;
        if (!receipt) continue;
        const ok = receipt.status === "success";
        job.state = job.state === "executing" ? (ok ? "executed" : "execute-failed") : (ok ? "refunded" : "refund-failed");
        job.updatedAt = Date.now();
        this.persist();
        continue;
      }
      const balance = await this.escrowBalance(job);
      job.balance = balance.toString();
      // refund path: from refundAfter on, anything left in the escrow re-shields as the committed note
      if (now >= Number(p.refundAfter)) {
        if (balance > 0n) await this.send(job, encodeDeployAndRefund(p, job.refundNoteData), "refunding", "refund-failed");
        else if (job.state === "executed") { job.state = "completed"; job.updatedAt = Date.now(); this.persist(); }
        continue;
      }
      if (job.state === "waiting-funding") {
        if (now > Number(job.execution.deadline)) { job.state = "expired"; job.updatedAt = Date.now(); this.persist(); continue; }
        if (balance >= BigInt(p.amount)) await this.send(job, encodeDeployAndExecute(p, job.execution), "executing", "execute-failed");
      }
    }
  }
}
