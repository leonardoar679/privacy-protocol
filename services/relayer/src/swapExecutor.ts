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
// A wallet that will not (or cannot) execute an order hands over a REFUND-ONLY job instead — params and
// the committed refund payload, no execution — so that the funded escrow still returns to the pool after
// `refundAfter` (refund() is permissionless; somebody has to know the escrow and the payload to call it).
// A later signed execution for the same order replaces a refund-only job while it is still open.
// An ETH order's escrow can be paid back in WETH (an unfilled Across deposit is refunded to its
// depositor in the input token); the escrow unwraps it in refund(), so that balance counts for the
// refund decision — never for execution, which needs native ETH. A route that swapped first is paid
// back in the swapped token: the wallet lists it (`refundTokens`) and the executor re-shields it through
// the escrow's refundToken(), before the order's asset.
// A provider can pay back long after `refundAfter` (Across refunds an unfilled deposit with the bundle
// after its fill deadline): an executed order stays watched for `lateRefundWatchSeconds` after the
// window opens, and only an escrow still empty then is "completed" (PP-S11).
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
const factoryConfigAbi = parseAbi(["function WRAPPED_NATIVE() view returns (address)"]);
export const escrowAbi = parseAbi(["function refundToken(address token, bytes noteData)"]);
/** How long an executed order is watched after `refundAfter` for a provider's late refund (PP-S11). */
export const LATE_REFUND_WATCH_SECONDS = 24 * 3600;
const MAX_REFUND_TOKENS = 4;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface SwapParamsJson { orderId: Hex; assetType: number; asset: Address; amount: string; orderSigner: Address; executeDeadline: number; refundAfter: number; refundVault: Address; refundOwnerCommitment: string; refundNoteSecret: string; refundNoteDataHash: Hex; executorTip: string }
export interface SwapExecutionJson { provider: Address; value: string; providerCalldata: Hex; deadline: number; signature: Hex }
/** `refundTokens`: tokens other than the order's asset a provider may pay back (the token a route swapped into before bridging). */
export interface SwapJobRequest { factory: Address; params: SwapParamsJson; execution: SwapExecutionJson; refundNoteData: Hex; refundTokens?: Address[] }
/** Return a funded order to the pool after its window, without executing it. */
export interface SwapRefundRequest { factory: Address; params: SwapParamsJson; refundNoteData: Hex; refundTokens?: Address[] }
export type SwapJobState = "waiting-funding" | "expired" | "refund-only" | "executing" | "executed" | "execute-failed" | "refunding" | "refunded" | "refund-failed" | "completed";
/** `execution` is absent for a refund-only job. */
export interface SwapJob { id: string; escrow: Address; factory: Address; params: SwapParamsJson; execution?: SwapExecutionJson; refundNoteData: Hex; refundTokens?: Address[]; executed?: boolean; state: SwapJobState; txHash?: Hex; error?: string; balance?: string; createdAt: number; updatedAt: number }

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
export const encodeRefundToken = (token: Address, noteData: Hex): Hex => encodeFunctionData({ abi: escrowAbi, functionName: "refundToken", args: [token, noteData] });
/** Two lists of foreign tokens as one, lower-cased, without duplicates. */
const mergeTokens = (a: Address[] | undefined, b: Address[] | undefined): Address[] | undefined => {
  const all = [...new Set([...(a ?? []), ...(b ?? [])].map((t) => t.toLowerCase() as Address))];
  return all.length ? all : undefined;
};

/** States in which a newer execution (re-signed with a fresh quote) may replace the stored one, or a refund-only request drop it. */
const REPLACEABLE: SwapJobState[] = ["waiting-funding", "expired", "execute-failed", "refund-only"];

export class SwapExecutor {
  private jobs = new Map<string, SwapJob>();
  /** factory -> its wrapped native token (null: none, or a factory from before the getter) */
  private wrapped = new Map<string, Address | null>();
  constructor(readonly cfg: { chainId: number; escrowCreationCode: Hex; account: PrivateKeyAccount; publicClient: PublicClient; walletClient: WalletClient; now?: () => number; journal?: Journal<SwapJob>; /** default LATE_REFUND_WATCH_SECONDS */ lateRefundWatchSeconds?: number }) {
    for (const j of cfg.journal?.load() ?? []) this.jobs.set(j.id, j); // restart: resume every open job
  }

  private now(): number { return this.cfg.now ? this.cfg.now() : Math.floor(Date.now() / 1000); }
  private persist(): void { this.cfg.journal?.save([...this.jobs.values()]); }

  /** Everything checkable before watching the chain; throws SwapJobError. */
  /** What every job needs, executed or not: a known asset type, sane deadlines, the refund payload the order committed to. */
  private checkOrder(req: { factory: Address; params: SwapParamsJson; refundNoteData: Hex }): void {
    const p = req?.params;
    if (!p || !isHex(req.factory, 20)) throw new SwapJobError("bad_request", "factory and params are required");
    if (Number(p.assetType) !== 0 && Number(p.assetType) !== 1) throw new SwapJobError("unsupported_asset", "assetType must be 0 (ETH) or 1 (ERC-20)");
    if (!isHex(req.refundNoteData, 169)) throw new SwapJobError("bad_refund_payload", "refundNoteData must be the 169-byte payload");
    if (keccak256(req.refundNoteData) !== String(p.refundNoteDataHash).toLowerCase()) throw new SwapJobError("refund_payload_mismatch", "refundNoteData does not hash to the committed refundNoteDataHash");
    if (!(Number(p.executeDeadline) < Number(p.refundAfter))) throw new SwapJobError("bad_deadlines", "executeDeadline must precede refundAfter");
    const t = (req as { refundTokens?: unknown }).refundTokens;
    if (t !== undefined) {
      if (!Array.isArray(t) || t.length > MAX_REFUND_TOKENS || !t.every((x) => isHex(x, 20) && BigInt(x as string) !== 0n)) throw new SwapJobError("bad_refund_tokens", `refundTokens must be at most ${MAX_REFUND_TOKENS} token addresses`);
      if (t.some((x) => String(x).toLowerCase() === String(p.asset).toLowerCase())) throw new SwapJobError("bad_refund_tokens", "the order's own asset re-shields through refund(), not refundToken");
    }
  }

  /**
   * A refund-only job: the order will not be executed (the wallet refused the provider call, or the user
   * cancelled), so whatever the escrow holds re-shields as the committed note once `refundAfter` is
   * reached. Drops a stored execution that has not run yet; an order already executing or settled is
   * left alone (its leftovers are refunded anyway).
   */
  addRefund(req: SwapRefundRequest): SwapJob {
    this.checkOrder(req);
    const p = req.params;
    const escrow = predictEscrow(req.factory, this.cfg.escrowCreationCode, toEngineParams(p));
    const id = p.orderId.toLowerCase();
    const existing = this.jobs.get(id);
    if (existing) {
      if (REPLACEABLE.includes(existing.state) && existing.escrow.toLowerCase() === escrow.toLowerCase()) {
        existing.execution = undefined; existing.state = "refund-only"; existing.txHash = undefined; existing.error = undefined; existing.updatedAt = Date.now();
        existing.refundTokens = mergeTokens(existing.refundTokens, req.refundTokens);
        this.persist();
      }
      return existing;
    }
    const job: SwapJob = { id, escrow, factory: req.factory, params: p, refundNoteData: req.refundNoteData, refundTokens: mergeTokens(undefined, req.refundTokens), state: "refund-only", createdAt: Date.now(), updatedAt: Date.now() };
    this.jobs.set(id, job);
    this.persist();
    return job;
  }

  add(req: SwapJobRequest): SwapJob {
    const p = req?.params, x = req?.execution;
    if (!x) throw new SwapJobError("bad_request", "factory, params and execution are required");
    this.checkOrder(req);
    if (Number(p.assetType) === 1 && BigInt(x.value) !== 0n) throw new SwapJobError("bad_execution", "an ERC-20 order forwards no ETH value (the provider pulls the tokens)");
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
        existing.refundTokens = mergeTokens(existing.refundTokens, req.refundTokens);
        this.persist();
      }
      return existing;
    }
    const job: SwapJob = { id, escrow, factory: req.factory, params: p, execution: x, refundNoteData: req.refundNoteData, refundTokens: mergeTokens(undefined, req.refundTokens), state, createdAt: Date.now(), updatedAt: Date.now() };
    this.jobs.set(id, job);
    this.persist();
    return job;
  }

  /** The factory's wrapped native token; looked up once per factory (a failed lookup is retried next tick). */
  private async wrappedNative(factory: Address): Promise<Address | null> {
    const key = factory.toLowerCase();
    if (this.wrapped.has(key)) return this.wrapped.get(key)!;
    try {
      const w = (await this.cfg.publicClient.readContract({ address: factory, abi: factoryConfigAbi, functionName: "WRAPPED_NATIVE" })) as Address;
      const v = w.toLowerCase() === ZERO_ADDRESS ? null : w;
      this.wrapped.set(key, v);
      return v;
    } catch {
      return null;
    }
  }

  /**
   * What the escrow holds in the order asset: `spendable` is what execute() can forward (native ETH or
   * the ERC-20); `refundable` adds, for an ETH order, the WETH refund() unwraps before re-shielding.
   */
  private async escrowBalances(job: SwapJob): Promise<{ spendable: bigint; refundable: bigint }> {
    if (Number(job.params.assetType) === 1) {
      const b = (await this.cfg.publicClient.readContract({ address: job.params.asset, abi: erc20Abi, functionName: "balanceOf", args: [job.escrow] })) as bigint;
      return { spendable: b, refundable: b };
    }
    const eth = await this.cfg.publicClient.getBalance({ address: job.escrow });
    const w = await this.wrappedNative(job.factory);
    const wrapped = w ? ((await this.cfg.publicClient.readContract({ address: w, abi: erc20Abi, functionName: "balanceOf", args: [job.escrow] }).catch(() => 0n)) as bigint) : 0n;
    return { spendable: eth, refundable: eth + wrapped };
  }

  /** The listed foreign tokens the escrow holds now. */
  private async foreignHeld(job: SwapJob): Promise<Address[]> {
    const held: Address[] = [];
    for (const t of job.refundTokens ?? []) {
      const b = (await this.cfg.publicClient.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [job.escrow] }).catch(() => 0n)) as bigint;
      if (b > 0n) held.push(t);
    }
    return held;
  }

  /** refundToken(token) on the escrow; a token its vault refuses (fee-on-transfer, rebasing) is dropped with the reason, never blocking the rest. */
  private async refundForeign(job: SwapJob, token: Address): Promise<void> {
    const data = encodeRefundToken(token, job.refundNoteData);
    let gas: bigint;
    try {
      gas = await this.cfg.publicClient.estimateGas({ account: this.cfg.account.address, to: job.escrow, data });
    } catch (e) {
      job.refundTokens = (job.refundTokens ?? []).filter((t) => t.toLowerCase() !== token.toLowerCase());
      job.error = `${token} cannot be re-shielded: ${String((e as Error).message).split("\n")[0].slice(0, 160)}`;
      job.updatedAt = Date.now();
      this.persist();
      return;
    }
    try {
      job.txHash = await this.cfg.walletClient.sendTransaction({ account: this.cfg.account, chain: this.cfg.walletClient.chain, to: job.escrow, data, gas: (gas * 12n) / 10n });
      job.state = "refunding"; job.error = undefined;
    } catch (e) {
      job.error = String((e as Error).message).split("\n")[0].slice(0, 200); // retried next tick
    }
    job.updatedAt = Date.now();
    this.persist();
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
      const p = job.params;
      // an executed order is watched past refundAfter for a provider's late refund; anything else is done once refunded
      const watchEnd = Number(p.refundAfter) + (job.executed ? (this.cfg.lateRefundWatchSeconds ?? LATE_REFUND_WATCH_SECONDS) : 0);
      if (TERMINAL.includes(job.state) && !(job.state === "refunded" && now < watchEnd)) continue;
      if (job.state === "executing" || job.state === "refunding") {
        const receipt = job.txHash ? await this.cfg.publicClient.getTransactionReceipt({ hash: job.txHash }).catch(() => null) : null;
        if (!receipt) continue;
        const ok = receipt.status === "success";
        if (job.state === "executing" && ok) job.executed = true;
        job.state = job.state === "executing" ? (ok ? "executed" : "execute-failed") : (ok ? "refunded" : "refund-failed");
        job.updatedAt = Date.now();
        this.persist();
        continue;
      }
      const { spendable: balance, refundable } = await this.escrowBalances(job);
      job.balance = refundable.toString();
      // refund path: from refundAfter on, anything left in the escrow re-shields as the committed note: a foreign token
      // a provider paid back first (refundToken on the deployed escrow), then the order's asset (incl. WETH for ETH)
      if (now >= Number(p.refundAfter)) {
        const foreign = await this.foreignHeld(job);
        const deployed = foreign.length > 0 && ((await this.cfg.publicClient.getCode({ address: job.escrow }).catch(() => undefined)) ?? "0x") !== "0x";
        if (deployed) await this.refundForeign(job, foreign[0]);
        else if (refundable > 0n) await this.send(job, encodeDeployAndRefund(p, job.refundNoteData), "refunding", "refund-failed"); // deploys it too
        else if (foreign.length) { job.error = "foreign tokens at an escrow that was never deployed: nothing here deploys it"; job.updatedAt = Date.now(); this.persist(); }
        else if (job.state === "executed" && now >= watchEnd) { job.state = "completed"; job.updatedAt = Date.now(); this.persist(); }
        continue;
      }
      if (job.state === "waiting-funding" && job.execution) {
        if (now > Number(job.execution.deadline)) { job.state = "expired"; job.updatedAt = Date.now(); this.persist(); continue; }
        if (balance >= BigInt(p.amount)) await this.send(job, encodeDeployAndExecute(p, job.execution), "executing", "execute-failed");
      }
    }
  }
}
