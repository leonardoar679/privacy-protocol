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
// the escrow's refundToken(), before the order's asset. An ERC-20 order's escrow re-shields WETH and ETH
// as ETH there; address(0) in the list stands for the escrow's ETH balance.
// A provider can pay back long after `refundAfter` (Across refunds an unfilled deposit with the bundle
// after its fill deadline): an executed order stays watched for `lateRefundWatchSeconds` after the
// window opens, and only an escrow still empty then is "completed" (PP-S11).
// Nothing pays for those re-shields (the tip was paid at execution), and anyone can send value to an
// escrow, so they are bounded (PP-S12): at most `maxUnpaidRefunds` per order; each must move at least
// its floor (ETH and WETH twice their gas cost, the order's own token 1% of the order, a listed token
// the floor the wallet stated for it); a token goes only into a vault its pool already has. What is
// left stays re-shieldable by anyone: refund() and refundToken() are permissionless.
import { BYTECODE } from "@privacy-wallet/contracts";
import { encodeFunctionData, keccak256, parseAbi, toFunctionSelector, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import type { Journal } from "./journal";
import { DROP_AFTER_MS, Sender, unknownToTheNode, type SentTx } from "./sender";
import { executionDigest, executionVouchDigest, orderVouchDigest, predictEscrow, recoverExecutionSigner, vouchedBy } from "@privacy-wallet/swap-engine/endpoints";
import type { OrderParams } from "@privacy-wallet/swap-engine/types";

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
/** The escrow's own record of its execution: deployAndExecute is anyone's to send with the signed execution (SwapOrderEscrow.sol). */
const escrowStateAbi = parseAbi(["function executed() view returns (bool)"]);
const vaultLinkAbi = parseAbi(["function core() view returns (address)", "function VAULT_FACTORY() view returns (address)", "function vaultOf(address asset) view returns (address)"]);
/** How long an executed order is watched after `refundAfter` for a provider's late refund (PP-S11). */
export const LATE_REFUND_WATCH_SECONDS = 24 * 3600;
/**
 * How long after `refundAfter` a job whose order never executed and whose escrow holds nothing a refund would be paid for
 * is still looked at (a V6 follow-up of 2026-10-16, audit c07): then it has ended — never funded, its funds already back in
 * the pool, or only dust below its tip there (audit round 2, r00) — and is `lapsed`, no longer read every pass nor counted
 * among the open jobs (MAX_SWAP_JOBS).
 */
export const LAPSE_AFTER_SECONDS = 24 * 3600;
const MAX_REFUND_TOKENS = 4;
/** At most this many re-shields of an executed order, which no tip pays for (PP-S12). */
export const MAX_UNPAID_REFUNDS = 3;
/** An unpaid re-shield of ETH or WETH moves at least this many times its own gas cost. */
const UNPAID_GAS_MULTIPLE = 2n;
/** An unpaid re-shield of the order's own token moves at least this share of the order (basis points). */
const OWN_FLOOR_BPS = 100n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface SwapParamsJson { orderId: Hex; assetType: number; asset: Address; amount: string; orderSigner: Address; executeDeadline: number; refundAfter: number; refundVault: Address; refundOwnerCommitment: string; refundNoteSecret: string; refundNoteDataHash: Hex; executorTip: string }
export interface SwapExecutionJson { provider: Address; value: string; providerCalldata: Hex; deadline: number; signature: Hex }
/**
 * `refundTokens`: tokens other than the order's asset a provider may pay back (the token a route swapped into before bridging);
 * address(0) = ETH, for an ERC-20 order. `refundFloors`: per listed token, the least balance worth an unpaid re-shield (base units).
 */
/** `vouch`: the API's (a V6 follow-up of 2026-10-16, audit gap 47) — `execution` for the call it prepared, `order` for the order it committed. */
export interface SwapJobRequest { factory: Address; params: SwapParamsJson; execution: SwapExecutionJson; refundNoteData: Hex; refundTokens?: Address[]; refundFloors?: Record<string, string>; vouch?: { execution?: Hex; order?: Hex } }
/** Return a funded order to the pool after its window, without executing it. */
export interface SwapRefundRequest { factory: Address; params: SwapParamsJson; refundNoteData: Hex; refundTokens?: Address[]; refundFloors?: Record<string, string>; vouch?: { execution?: Hex; order?: Hex } }
export type SwapJobState = "waiting-funding" | "expired" | "refund-only" | "executing" | "executed" | "execute-failed" | "refunding" | "refunded" | "refund-failed" | "completed" | "lapsed";
/** `execution` is absent for a refund-only job. */
/** `unpaidRefunds`: re-shields sent after execution, which no tip paid for (PP-S12). */
/** `executionTx`: the deployAndExecute transaction, set once and never overwritten (whale spec §19: `txHash` is reused by refund transactions; the wallet tracks the destination side from this hash). */
/** `sent`: the transaction in flight — the state it was sent from, when (unix seconds) and whether no tip pays for it; one the node drops sends the job back there (a V6 follow-up of 2026-10-15). */
/** `refundReverts` / `revertedAt`: refunds that reverted (at the estimate or mined) and when the last did: tried again
 *  REFUND_RETRY_SECONDS later, refund-failed only at the MAX_REFUND_REVERTS-th (the audit's unverified m07, 2026-10-17). */
export interface SwapJob { id: string; escrow: Address; factory: Address; params: SwapParamsJson; execution?: SwapExecutionJson; refundNoteData: Hex; refundTokens?: Address[]; refundFloors?: Record<string, string>; executed?: boolean; unpaidRefunds?: number; refundReverts?: number; revertedAt?: number; state: SwapJobState; txHash?: Hex; executionTx?: Hex; error?: string; balance?: string; createdAt: number; updatedAt: number; /** V6 (spec v2.0 §3): the last mined transaction's gas and gasUsed × effectiveGasPrice */ gasUsed?: string; actualNetworkWei?: string; sent?: SentTx<SwapJobState> }

export class SwapJobError extends Error { constructor(public readonly code: string, message: string) { super(message); } }

/** No execution is sent closer than this to its signed deadline: three blocks, the time one takes to be mined. */
export const EXECUTE_MARGIN_SECONDS = 36;

/** A refund that reverted (a paused token, a race at the escrow) is tried again this much later, never at once. */
export const REFUND_RETRY_SECONDS = 600;
/** The refund that reverts this many times is final (refund-failed): the escrow is left to whoever calls deployAndRefund. */
export const MAX_REFUND_REVERTS = 3;

/** Whether an estimateGas failure is the call reverting (an answer), not the RPC failing (retried next tick). */
const reverted = (e: unknown) => /revert/i.test(String((e as Error)?.message ?? e));
/** TooEarlyToRefund() (SwapOrderTypes.sol): by name, or by its selector in the revert data a node returns. */
const TOO_EARLY = toFunctionSelector("TooEarlyToRefund()").slice(2);
/**
 * A refund estimated a little before the chain's clock reached refundAfter (a V6 follow-up of 2026-10-16): the executor goes
 * by its own clock, and the latest block can still be seconds behind it. That revert is not the refund's fate — it was taken
 * as final (refund-failed, or a listed token dropped), leaving the escrow to whoever called deployAndRefund — and is tried
 * again next tick. (The executor keeps its own clock: an idle devnet mints no block until a transaction asks.)
 */
const tooEarly = (e: unknown): boolean => {
  for (let x: unknown = e, depth = 0; x && depth < 8; x = (x as { cause?: unknown }).cause, depth++) {
    const o = x as { message?: unknown; data?: unknown; details?: unknown; shortMessage?: unknown };
    const words = [o.message, o.data, o.details, o.shortMessage].map((w) => String(w ?? "")).join(" ");
    if (/TooEarlyToRefund/.test(words) || words.toLowerCase().includes(TOO_EARLY)) return true;
  }
  return false;
};
const firstLine = (e: unknown, n: number) => String((e as Error)?.message ?? e).split("\n")[0].slice(0, n);
const isHex = (x: unknown, bytes?: number) => typeof x === "string" && /^0x[0-9a-fA-F]*$/.test(x) && (bytes === undefined || (x.length - 2) / 2 === bytes);
/** The states a job ends in: no pass looks at it again (but a refunded executed order's late-refund watch), and it is not open. */
export const TERMINAL: SwapJobState[] = ["refunded", "completed", "refund-failed", "lapsed"];

/** The escrow's creation code, as forge exported it (@privacy-wallet/contracts; part of every escrow's CREATE2 address). */
export function loadEscrowCreationCode(): Hex {
  return BYTECODE.swapOrderEscrow;
}

export function toEngineParams(p: SwapParamsJson): OrderParams {
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
/** A job's refund tokens and floors with a request's merged in: at most MAX_REFUND_TOKENS in all, and a floor only ever rises. */
function mergeRefunds(job: Pick<SwapJob, "refundTokens" | "refundFloors"> | undefined, req: { refundTokens?: Address[]; refundFloors?: Record<string, string> }): Pick<SwapJob, "refundTokens" | "refundFloors"> {
  const refundTokens = mergeTokens(job?.refundTokens, req.refundTokens);
  if ((refundTokens?.length ?? 0) > MAX_REFUND_TOKENS) throw new SwapJobError("bad_refund_tokens", `at most ${MAX_REFUND_TOKENS} refund tokens per order`);
  const floors: Record<string, string> = { ...(job?.refundFloors ?? {}) };
  for (const [k, v] of Object.entries(req.refundFloors ?? {})) {
    const t = k.toLowerCase();
    if (floors[t] === undefined || BigInt(v) > BigInt(floors[t])) floors[t] = BigInt(v).toString();
  }
  return { refundTokens, refundFloors: Object.keys(floors).length ? floors : undefined };
}

/** States in which a newer execution (re-signed with a fresh quote) may replace the stored one, or a refund-only request drop it. */
const REPLACEABLE: SwapJobState[] = ["waiting-funding", "expired", "execute-failed", "refund-only", "lapsed"];

export class SwapExecutor {
  private jobs = new Map<string, SwapJob>();
  /** factory -> its wrapped native token (null: none, or a factory from before the getter) */
  private wrapped = new Map<string, Address | null>();
  /** refund vault -> its pool's vault factory */
  private vaultFactories = new Map<string, Address>();
  /** the account's one sender, shared with the submissions and the shield executor (server.ts); a test's own otherwise */
  private readonly sender: Sender;
  constructor(readonly cfg: { chainId: number; escrowCreationCode: Hex; account: PrivateKeyAccount; publicClient: PublicClient; walletClient: WalletClient; sender?: Sender; /** the SwapOrderFactory this relayer executes for (SWAP_FACTORY); unset: it admits no order */ factory?: Address; /** PrivacyCore: an order refunds into its pool's own vault for its asset (`admissible`) */ core?: Address; /** the API's signer (API_VOUCHER), or its signers while it rotates its key: the executor runs only what they vouched for; unset, nothing */ voucher?: Address | readonly Address[]; now?: () => number; journal?: Journal<SwapJob>; /** default LATE_REFUND_WATCH_SECONDS */ lateRefundWatchSeconds?: number; /** default MAX_UNPAID_REFUNDS */ maxUnpaidRefunds?: number; /** default LAPSE_AFTER_SECONDS */ lapseAfterSeconds?: number; /** default MAX_REFUND_REVERTS */ maxRefundReverts?: number }) {
    this.sender = cfg.sender ?? new Sender(cfg.account, cfg);
    for (const j of cfg.journal?.load() ?? []) this.jobs.set(j.id, j); // restart: resume every open job
  }

  private now(): number { return this.cfg.now ? this.cfg.now() : Math.floor(Date.now() / 1000); }
  private persist(): void { this.cfg.journal?.save([...this.jobs.values()]); }

  private poolVaultFactory: Address | null = null;
  /**
   * What admission reads from the chain, before `add` or `addRefund` (a V6 follow-up of 2026-10-15): the order's refund
   * vault is its pool's own vault for the order's asset, `CORE.VAULT_FACTORY().vaultOf(asset)` (ETH: address(0)). A
   * refund deposits into REFUND_VAULT at the executor's gas, and the vault was whatever the order named: a contract of
   * anyone's could spend that gas on anything, and the foreign-token check trusted the vault's own word for its pool.
   * Throws SwapJobError when the vault is not the pool's, the RPC's error when it cannot be read (the caller tries again).
   */
  async admissible(req: { params?: SwapParamsJson }): Promise<void> {
    const p = req?.params;
    if (!this.cfg.core || !p || !isHex(p.asset, 20) || !isHex(p.refundVault, 20)) return; // the shape is add's to refuse
    this.poolVaultFactory ??= (await this.cfg.publicClient.readContract({ address: this.cfg.core, abi: vaultLinkAbi, functionName: "VAULT_FACTORY" })) as Address;
    const asset = Number(p.assetType) === 0 ? ZERO_ADDRESS : p.asset;
    const vault = (await this.cfg.publicClient.readContract({ address: this.poolVaultFactory, abi: vaultLinkAbi, functionName: "vaultOf", args: [asset as Address] })) as Address;
    if (vault.toLowerCase() === ZERO_ADDRESS) throw new SwapJobError("bad_refund_vault", `this pool has no vault for ${asset}: the order could not be refunded into it`);
    if (vault.toLowerCase() !== p.refundVault.toLowerCase()) throw new SwapJobError("bad_refund_vault", `the refund vault ${p.refundVault} is not this pool's vault for the order's asset (${vault})`);
  }

  /** Everything checkable before watching the chain; throws SwapJobError. */
  /** What every job needs, executed or not: a known asset type, sane deadlines, the refund payload the order committed to. */
  private checkOrder(req: { factory: Address; params: SwapParamsJson; refundNoteData: Hex }): void {
    const p = req?.params;
    if (!p || !isHex(req.factory, 20)) throw new SwapJobError("bad_request", "factory and params are required");
    // the factory the executor calls is the deployment's (a V6 follow-up of 2026-10-15): it called whatever a request named,
    // so a contract of anyone's could take deployAndExecute and deployAndRefund at the relayer's gas, keeping the escrow's
    // tip — or paying none — while the escrow it "funded" was predicted from that same contract
    if (!this.cfg.factory || !this.cfg.voucher || this.cfg.voucher.length === 0) throw new SwapJobError("swap_unavailable", "this relayer runs no swap executor (SWAP_FACTORY and API_VOUCHER are both needed)");
    if (req.factory.toLowerCase() !== this.cfg.factory.toLowerCase())
      throw new SwapJobError("unknown_swap_factory", `this relayer executes swaps for ${this.cfg.factory}, not ${req.factory}`);
    if (Number(p.assetType) !== 0 && Number(p.assetType) !== 1) throw new SwapJobError("unsupported_asset", "assetType must be 0 (ETH) or 1 (ERC-20)");
    if (!isHex(req.refundNoteData, 169)) throw new SwapJobError("bad_refund_payload", "refundNoteData must be the 169-byte payload");
    if (keccak256(req.refundNoteData) !== String(p.refundNoteDataHash).toLowerCase()) throw new SwapJobError("refund_payload_mismatch", "refundNoteData does not hash to the committed refundNoteDataHash");
    if (!(Number(p.executeDeadline) < Number(p.refundAfter))) throw new SwapJobError("bad_deadlines", "executeDeadline must precede refundAfter");
    const t = (req as { refundTokens?: unknown }).refundTokens;
    if (t !== undefined) {
      if (!Array.isArray(t) || t.length > MAX_REFUND_TOKENS || !t.every((x) => isHex(x, 20))) throw new SwapJobError("bad_refund_tokens", `refundTokens must be at most ${MAX_REFUND_TOKENS} token addresses (address(0): the escrow's ETH)`);
      // an ETH order's ETH (address(0)) and an ERC-20 order's token go through refund(); an ERC-20 order's ETH through refundToken
      const own = Number(p.assetType) === 0 ? ZERO_ADDRESS : String(p.asset).toLowerCase();
      if (t.some((x) => String(x).toLowerCase() === own)) throw new SwapJobError("bad_refund_tokens", "the order's own asset re-shields through refund(), not refundToken");
    }
    const f = (req as { refundFloors?: unknown }).refundFloors;
    if (f !== undefined) {
      const listed = new Set(((t as string[] | undefined) ?? []).map((x) => String(x).toLowerCase()));
      if (typeof f !== "object" || f === null || Array.isArray(f) || !Object.entries(f).every(([k, v]) => listed.has(k.toLowerCase()) && typeof v === "string" && /^[0-9]{1,78}$/.test(v))) {
        throw new SwapJobError("bad_refund_floors", "refundFloors maps tokens listed in refundTokens to base-unit amounts");
      }
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
    // the API vouched for this order at its commit (a V6 follow-up of 2026-10-16, audit gap 47): the first refund of an order
    // that never executed costs about 3.45M gas against its execution-sized tip, which an order of anyone's could set to zero
    if (!vouchedBy(this.cfg.voucher!, orderVouchDigest(BigInt(this.cfg.chainId), escrow), req.vouch?.order))
      throw new SwapJobError("unvouched_order", "the swap service did not vouch for this order: the executor refunds only orders it committed");
    const id = p.orderId.toLowerCase();
    const existing = this.jobs.get(id);
    if (existing) {
      if (REPLACEABLE.includes(existing.state) && existing.escrow.toLowerCase() === escrow.toLowerCase()) {
        const merged = mergeRefunds(existing, req);
        existing.execution = undefined; existing.state = "refund-only"; existing.txHash = undefined; existing.error = undefined; existing.updatedAt = Date.now();
        Object.assign(existing, merged);
        this.persist();
      }
      return existing;
    }
    const job: SwapJob = { id, escrow, factory: req.factory, params: p, refundNoteData: req.refundNoteData, ...mergeRefunds(undefined, req), state: "refund-only", createdAt: Date.now(), updatedAt: Date.now() };
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
    // the API vouched for this very call on an order it committed (a V6 follow-up of 2026-10-16, audit gap 47): an order key
    // is anyone's own, so anyone's order with a tip of no value, a zero tip or a call made to burn gas cost the relayer its gas
    const vouched = executionVouchDigest(BigInt(this.cfg.chainId), escrow, x.provider, BigInt(x.value), x.providerCalldata, Number(x.deadline));
    if (!vouchedBy(this.cfg.voucher!, vouched, req.vouch?.execution))
      throw new SwapJobError("unvouched_order", "the swap service did not vouch for this call: the executor runs only calls it prepared for an order it committed");
    if (BigInt(x.value) > BigInt(p.amount) - BigInt(p.executorTip)) throw new SwapJobError("bad_execution", "value exceeds the escrow's spendable balance");
    const id = p.orderId.toLowerCase();
    // a call with fewer than EXECUTE_MARGIN_SECONDS left is refused, never admitted only to expire at its first pass (audit
    // round 2, r02): the wallet took it as handed over and only tracked it, while its funded escrow waited for refundAfter
    if (this.now() + EXECUTE_MARGIN_SECONDS > Number(x.deadline))
      throw new SwapJobError("deadline_too_close", `the call's deadline is less than ${EXECUTE_MARGIN_SECONDS} s away, too close for the executor to send it: sign a fresh one`);
    const state: SwapJobState = "waiting-funding";
    const existing = this.jobs.get(id);
    if (existing) {
      // a re-signed execution (fresh quote after expiry / a failed provider call) replaces the old one; an order already executing or settled is left alone
      if (REPLACEABLE.includes(existing.state) && existing.escrow.toLowerCase() === escrow.toLowerCase()) {
        const merged = mergeRefunds(existing, req);
        existing.execution = x; existing.state = state; existing.txHash = undefined; existing.error = undefined; existing.updatedAt = Date.now();
        Object.assign(existing, merged);
        this.persist();
      }
      return existing;
    }
    const job: SwapJob = { id, escrow, factory: req.factory, params: p, execution: x, refundNoteData: req.refundNoteData, ...mergeRefunds(undefined, req), state, createdAt: Date.now(), updatedAt: Date.now() };
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

  /** The listed foreign assets the escrow holds now; address(0) is its ETH (an ERC-20 order paid back in ETH). */
  private async foreignHeld(job: SwapJob): Promise<{ token: Address; amount: bigint }[]> {
    const held: { token: Address; amount: bigint }[] = [];
    for (const t of job.refundTokens ?? []) {
      const b = t.toLowerCase() === ZERO_ADDRESS
        ? await this.cfg.publicClient.getBalance({ address: job.escrow }).catch(() => 0n)
        : ((await this.cfg.publicClient.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [job.escrow] }).catch(() => 0n)) as bigint);
      if (b > 0n) held.push({ token: t, amount: b });
    }
    return held;
  }

  private unpaidBudgetLeft(job: SwapJob): boolean {
    return (job.unpaidRefunds ?? 0) < (this.cfg.maxUnpaidRefunds ?? MAX_UNPAID_REFUNDS);
  }

  /** ETH or the factory's wrapped native token: valued by the executor itself, against its own gas cost. */
  private async ethValued(job: SwapJob, token: Address): Promise<boolean> {
    if (token.toLowerCase() === ZERO_ADDRESS) return true;
    const w = await this.wrappedNative(job.factory);
    return !!w && w.toLowerCase() === token.toLowerCase();
  }

  /** Twice what a transaction of `gas` costs now: the least ETH an unpaid re-shield moves. */
  private async gasFloor(gas: bigint): Promise<bigint> {
    return UNPAID_GAS_MULTIPLE * gas * (await this.cfg.publicClient.getGasPrice());
  }

  /** Whether the refund vault's pool already has a vault for `token`: refundToken would otherwise make the executor pay for deploying one. */
  private async hasVault(job: SwapJob, token: Address): Promise<boolean> {
    const rv = job.params.refundVault.toLowerCase();
    try {
      let factory = this.vaultFactories.get(rv);
      if (!factory) {
        const core = (await this.cfg.publicClient.readContract({ address: job.params.refundVault, abi: vaultLinkAbi, functionName: "core" })) as Address;
        factory = (await this.cfg.publicClient.readContract({ address: core, abi: vaultLinkAbi, functionName: "VAULT_FACTORY" })) as Address;
        this.vaultFactories.set(rv, factory);
      }
      const v = (await this.cfg.publicClient.readContract({ address: factory, abi: vaultLinkAbi, functionName: "vaultOf", args: [token] })) as Address;
      return v.toLowerCase() !== ZERO_ADDRESS;
    } catch {
      return false;
    }
  }

  /**
   * refundToken(token) on the escrow, which no tip pays for: only into a vault the pool already has, and only above the
   * token's floor (ETH and WETH: also twice the gas). Returns whether it acted: sent the call, or dropped a token its vault
   * refuses (fee-on-transfer, rebasing), with the reason, never blocking the rest.
   */
  private async refundForeign(job: SwapJob, f: { token: Address; amount: bigint }): Promise<boolean> {
    const native = await this.ethValued(job, f.token);
    if (!native && !(await this.hasVault(job, f.token))) return false;
    const data = encodeRefundToken(f.token, job.refundNoteData);
    let gas: bigint;
    try {
      gas = await this.cfg.publicClient.estimateGas({ account: this.cfg.account.address, to: job.escrow, data });
    } catch (e) {
      // an RPC failure says nothing about the token: kept, and retried next tick; so is a refund a few seconds early
      if (!reverted(e)) { this.note(job, `could not estimate refundToken(${f.token}): ${firstLine(e, 160)}; retried next tick`); return false; }
      if (tooEarly(e)) { this.note(job, "the chain's clock has not reached refundAfter yet; retried next tick"); return false; }
      job.refundTokens = (job.refundTokens ?? []).filter((t) => t.toLowerCase() !== f.token.toLowerCase());
      job.error = `${f.token} cannot be re-shielded: ${firstLine(e, 160)}`;
      job.updatedAt = Date.now();
      this.persist();
      return true;
    }
    let floor = BigInt(job.refundFloors?.[f.token.toLowerCase()] ?? "0");
    if (native) { const g = await this.gasFloor(gas); if (g > floor) floor = g; }
    if (f.amount < floor) return false;
    await this.dispatch(job, job.escrow, data, gas, "refunding", true); // not sent: retried next tick
    return true;
  }

  /**
   * deployAndRefund for the order's asset. The first refund of an order that never executed pays the committed tip — when the
   * escrow holds it: below it the escrow pays none (_payTip), so such a refund waits until it does (a V6 follow-up of
   * 2026-10-16: one wei at a vouched escrow had cost the relayer a 3.45M-gas refund for nothing; anyone can still call
   * deployAndRefund). After execution nothing pays, so it needs the budget and must move at least 1% of the order (ETH: also
   * twice its gas).
   */
  private async refundOwn(job: SwapJob, refundable: bigint): Promise<boolean> {
    const p = job.params;
    const data = encodeDeployAndRefund(p, job.refundNoteData);
    if (!job.executed) {
      const tip = BigInt(p.executorTip);
      if (tip > 0n && refundable >= tip) { await this.send(job, data, "refunding", "refund-failed"); return true; }
      this.note(job, `waiting: the escrow holds ${refundable}, less than the order's ${p.executorTip} tip, which a refund now would not be paid`);
      return false;
    }
    let gas: bigint;
    try {
      gas = await this.cfg.publicClient.estimateGas({ account: this.cfg.account.address, to: job.factory, data });
    } catch (e) {
      // during the watch a failed estimate never ends the job (an RPC outage, a balance read racing a refund): retried
      // next tick, and the watch still ends on time
      this.note(job, `${reverted(e) ? "would revert" : "could not estimate"}: ${firstLine(e, 200)}; retried next tick`);
      return false;
    }
    let floor = (BigInt(p.amount) * OWN_FLOOR_BPS) / 10000n;
    if (Number(p.assetType) === 0) { const g = await this.gasFloor(gas); if (g > floor) floor = g; }
    if (refundable < floor) return false;
    await this.send(job, data, "refunding", "refund-failed", { estimated: gas, unpaid: true });
    return true;
  }

  /**
   * V6 (spec v2.0 §3): the tip pays the execution's gas, so the executor never executes below cost — while executing an
   * ETH order would cost more than its tip it waits (until the execution's deadline; then the refund path). An ERC-20
   * order's tip is in the token, valued by the service when the order was committed; the executor does not re-value it.
   */
  private async belowCost(job: SwapJob, data: Hex): Promise<{ wait: boolean; gas?: bigint }> {
    let gas: bigint;
    try {
      gas = await this.cfg.publicClient.estimateGas({ account: this.cfg.account.address, to: job.factory, data });
    } catch {
      return { wait: false }; // send() estimates again and records why
    }
    let price: bigint;
    try {
      price = await this.cfg.publicClient.getGasPrice();
    } catch {
      return { wait: false, gas };
    }
    const cost = gas * price;
    if (cost <= BigInt(job.params.executorTip)) return { wait: false, gas };
    this.note(job, `waiting: executing now costs ${cost} wei, above the order's ${job.params.executorTip} wei tip`);
    return { wait: true };
  }

  /**
   * Whether another transaction executed this order's escrow (a V6 follow-up of 2026-10-16, audit c08/c30): deployAndExecute
   * is anyone's to send with the signed execution, so a copy of this executor's own can land first and take the tip. The
   * escrow's `executed` says so. A chain that does not answer leaves the job as it was before this check.
   */
  private async executedElsewhere(job: SwapJob): Promise<boolean> {
    if (job.executed) return false;
    try {
      const code = await this.cfg.publicClient.getCode({ address: job.escrow });
      if (!code || code === "0x") return false;
      return (await this.cfg.publicClient.readContract({ address: job.escrow, abi: escrowStateAbi, functionName: "executed" })) as boolean;
    } catch {
      return false;
    }
  }

  /** The order was executed by another transaction: the job goes on as executed (the late-refund watch, the unpaid re-shield budget). */
  private markExecutedElsewhere(job: SwapJob): void {
    job.executed = true;
    job.state = "executed";
    job.sent = undefined;
    job.error = "executed by another transaction, a copy of this executor's own: its tip went to that sender";
    job.updatedAt = Date.now();
    this.persist();
  }

  /** Record a note on the job once (not on every tick). */
  private note(job: SwapJob, msg: string): void {
    if (job.error === msg) return;
    job.error = msg; job.updatedAt = Date.now();
    this.persist();
  }

  get(id: string): SwapJob | undefined { return this.jobs.get(id.toLowerCase()); }
  list(): SwapJob[] { return [...this.jobs.values()]; }

  /**
   * A factory call that moves the job to `next`. Only the call's own answer, a revert at estimation, moves it to `failed`;
   * an RPC failure or a send that never left keeps the job as it is, with a note, and the next tick tries again (a V6
   * follow-up of 2026-10-15). Before, a refund that could not be estimated or sent was refund-failed, which is final, and an
   * execution refused on a nonce another send of this account had read was execute-failed.
   */
  private async send(job: SwapJob, data: Hex, next: SwapJobState, failed: SwapJobState, o: { estimated?: bigint; unpaid?: boolean } = {}): Promise<void> {
    let gas: bigint;
    try {
      gas = o.estimated ?? (await this.cfg.publicClient.estimateGas({ account: this.cfg.account.address, to: job.factory, data }));
    } catch (e) {
      if (!reverted(e)) { this.note(job, `could not estimate: ${firstLine(e, 200)}; retried next tick`); return; }
      if (tooEarly(e)) { this.note(job, "the chain's clock has not reached refundAfter yet; retried next tick"); return; }
      // an execution that would revert because another transaction executed the escrow first: the order is executed
      if (failed === "execute-failed" && (await this.executedElsewhere(job))) { this.markExecutedElsewhere(job); return; }
      // one reverted refund was final (the audit's unverified m07): it is tried again later, and final only at the last
      if (failed === "refund-failed" && this.refundRevertedOnce(job)) { this.note(job, `would revert: ${firstLine(e, 160)}; tried again in ${REFUND_RETRY_SECONDS / 60} min`); return; }
      job.state = failed; job.error = `would revert: ${firstLine(e, 200)}`; job.updatedAt = Date.now();
      this.persist();
      return;
    }
    await this.dispatch(job, job.factory, data, gas, next, o.unpaid);
  }

  /** Counts a reverted refund; true while it may be tried again (fewer than MAX_REFUND_REVERTS so far). */
  private refundRevertedOnce(job: SwapJob): boolean {
    job.refundReverts = (job.refundReverts ?? 0) + 1;
    job.revertedAt = this.now();
    return job.refundReverts < (this.cfg.maxRefundReverts ?? MAX_REFUND_REVERTS);
  }

  /** The transaction moving the job to `next`, through the account's one sender; false when it never left (noted, tried again next tick). */
  private async dispatch(job: SwapJob, to: Address, data: Hex, gas: bigint, next: SwapJobState, unpaid = false): Promise<boolean> {
    const sent = await this.sender.send({ to, data, gas: (gas * 12n) / 10n });
    if (!sent.ok) { this.note(job, `not sent: ${sent.error}; retried next tick`); return false; }
    job.sent = { from: job.state, at: this.now(), ...(unpaid ? { unpaid } : {}) };
    job.txHash = sent.hash; job.state = next; job.error = sent.note;
    if (next === "executing") job.executionTx = sent.hash;
    if (unpaid) job.unpaidRefunds = (job.unpaidRefunds ?? 0) + 1;
    job.updatedAt = Date.now();
    this.persist();
    return true;
  }

  /**
   * A transaction the node no longer knows DROP_AFTER_MS after it was sent was dropped (evicted, replaced, lost with a
   * node's mempool) and never gets a receipt: the job goes back to the state it was sent from, and the next tick sends
   * again with a nonce read anew, so the dropped one can no longer land as well (a V6 follow-up of 2026-10-15; the job
   * waited for that receipt for good, an order's funds in its escrow).
   */
  private async resendIfDropped(job: SwapJob, now: number): Promise<void> {
    const at = job.sent?.at ?? Math.floor(job.updatedAt / 1000);
    if (!job.txHash || now - at < DROP_AFTER_MS / 1000 || !(await unknownToTheNode(this.cfg.publicClient, job.txHash))) return;
    const back: SwapJobState = job.sent?.from ?? (job.state === "executing" ? "waiting-funding" : job.executed ? "executed" : "expired");
    if (job.executionTx === job.txHash) job.executionTx = undefined;
    if (job.sent?.unpaid) job.unpaidRefunds = Math.max(0, (job.unpaidRefunds ?? 1) - 1);
    job.error = `${job.txHash} was dropped before it was mined; sent again`;
    job.state = back; job.txHash = undefined; job.sent = undefined; job.updatedAt = Date.now();
    this.persist();
  }

  private ticking: Promise<void> | null = null;
  private tickAgain = false;
  /**
   * One pass over every open job, never two at once. The server asks for a tick on every hand-over and refund request
   * while the interval runs its own; two passes over the same funded escrow each sent deployAndExecute, and the second,
   * refused on the nonce, marked the mined execution failed (the V5 local-stack run, 2026-10-13). A tick asked for
   * during a pass runs one more pass after it, so a job added meanwhile is still acted on at once.
   */
  async tick(): Promise<void> {
    if (this.ticking) { this.tickAgain = true; return this.ticking; }
    this.ticking = (async () => { try { do { this.tickAgain = false; await this.pass(); } while (this.tickAgain); } finally { this.ticking = null; } })();
    return this.ticking;
  }

  /** One pass over every open job: read the escrow balance and the clock, act exactly once per state change. */
  private async pass(): Promise<void> {
    const now = this.now();
    for (const job of this.jobs.values()) {
      const p = job.params;
      // an executed order is watched past refundAfter for a provider's late refund; anything else is done once refunded
      const watchEnd = Number(p.refundAfter) + (job.executed ? (this.cfg.lateRefundWatchSeconds ?? LATE_REFUND_WATCH_SECONDS) : 0);
      if (TERMINAL.includes(job.state) && !(job.state === "refunded" && now < watchEnd)) continue;
      if (job.state === "executing" || job.state === "refunding") {
        const receipt = job.txHash ? await this.cfg.publicClient.getTransactionReceipt({ hash: job.txHash }).catch(() => null) : null;
        if (!receipt) { await this.resendIfDropped(job, now); continue; }
        const ok = receipt.status === "success";
        const from = job.sent?.from;
        // a mined refund that reverted goes back to the state it was sent from, tried again later (m07)
        if (job.state === "refunding" && !ok && from && this.refundRevertedOnce(job)) {
          if (job.sent?.unpaid) job.unpaidRefunds = Math.max(0, (job.unpaidRefunds ?? 1) - 1); // it re-shielded nothing
          job.sent = undefined;
          job.gasUsed = receipt.gasUsed.toString();
          job.actualNetworkWei = (receipt.gasUsed * receipt.effectiveGasPrice).toString();
          job.state = from;
          job.error = `the refund ${receipt.transactionHash} reverted; tried again in ${REFUND_RETRY_SECONDS / 60} min`;
          job.updatedAt = Date.now();
          this.persist();
          continue;
        }
        job.sent = undefined;
        job.gasUsed = receipt.gasUsed.toString();
        job.actualNetworkWei = (receipt.gasUsed * receipt.effectiveGasPrice).toString();
        // our execution reverted because a copy of it landed first: the order is executed all the same (audit c08/c30)
        if (job.state === "executing" && !ok && (await this.executedElsewhere(job))) { this.markExecutedElsewhere(job); continue; }
        if (job.state === "executing" && ok) job.executed = true;
        job.state = job.state === "executing" ? (ok ? "executed" : "execute-failed") : (ok ? "refunded" : "refund-failed");
        job.updatedAt = Date.now();
        this.persist();
        continue;
      }
      // one escrow that cannot be read is that job's tick, never the pass's (the audit's unverified m08: it aborted every job after it)
      let balances: { spendable: bigint; refundable: bigint };
      try {
        balances = await this.escrowBalances(job);
      } catch (e) {
        this.note(job, `could not read the escrow: ${firstLine(e, 160)}; read again next tick`);
        continue;
      }
      const { spendable: balance, refundable } = balances;
      job.balance = refundable.toString();
      // refund path: from refundAfter on, what is left in the escrow re-shields as the committed note: a foreign token a
      // provider paid back first (refundToken on the deployed escrow), then the order's asset (incl. WETH for ETH). After
      // execution nothing pays for that, so it is bounded (PP-S12): a budget per order, and a floor per asset
      // a refund that reverted waits REFUND_RETRY_SECONDS before it is tried again (m07)
      if (now >= Number(p.refundAfter) && job.revertedAt !== undefined && now - job.revertedAt < REFUND_RETRY_SECONDS) continue;
      if (now >= Number(p.refundAfter)) {
        // an order this executor did not execute may have been executed by a copy of its call (audit c08/c30): then it is an
        // executed order, under the watch and the budget of one
        if (!job.executed && (await this.executedElsewhere(job))) { this.markExecutedElsewhere(job); continue; }
        const foreign = await this.foreignHeld(job);
        const deployed = foreign.length > 0 && ((await this.cfg.publicClient.getCode({ address: job.escrow }).catch(() => undefined)) ?? "0x") !== "0x";
        const budget = !job.executed || this.unpaidBudgetLeft(job);
        let acted = false;
        if (deployed && budget) for (const f of foreign) if ((acted = await this.refundForeign(job, f))) break;
        if (!acted && refundable > 0n && budget) acted = await this.refundOwn(job, refundable); // deploys it too
        if (acted) continue;
        // never executed and nothing in the escrow a day past its window (audit c07): never funded, or its funds already
        // back — the job has ended, and no pass reads it again. So has one whose escrow holds less than its tip (audit round
        // 2, r00): no refund of that is ever paid (refundOwn waits for the tip), and dust at a vouched escrow had kept the job
        // open for good, until enough of them filled MAX_SWAP_JOBS. Foreign tokens do not keep it either: no provider ever
        // held this order's funds, so none paid anything back, and refundForeign has had its turn above
        const tip = BigInt(p.executorTip);
        if (!job.executed && (refundable === 0n || tip === 0n || refundable < tip) && now >= Number(p.refundAfter) + (this.cfg.lapseAfterSeconds ?? LAPSE_AFTER_SECONDS)) {
          job.state = "lapsed";
          job.error = refundable > 0n
            ? `ended a day past its window: no refund of what the escrow holds (${refundable}) would be paid by its tip; anyone can still call deployAndRefund`
            : foreign.length ? "ended a day past its window: the escrow holds only other tokens, and no provider ever held this order's funds" : "ended: nothing in the escrow a day past its window";
          job.updatedAt = Date.now();
          this.persist();
          continue;
        }
        if (!budget && (foreign.length || refundable > 0n)) this.note(job, `the ${this.cfg.maxUnpaidRefunds ?? MAX_UNPAID_REFUNDS} re-shields after execution that no tip pays for are used: what arrives now stays in the escrow, where anyone can re-shield it`);
        else if (!deployed && foreign.length && refundable === 0n) this.note(job, "foreign tokens at an escrow that was never deployed: nothing here deploys it");
        if (job.state === "executed" && now >= watchEnd) { job.state = "completed"; job.updatedAt = Date.now(); this.persist(); } // dust below its floor stays
        continue;
      }
      if (job.state === "waiting-funding" && job.execution) {
        // never in the last blocks before the signed deadline (the audit's unverified m10): one mined just after it reverts
        // DeadlinePassed at the relayer's gas — such an order goes the way of an expired one
        if (now + EXECUTE_MARGIN_SECONDS > Number(job.execution.deadline)) { job.state = "expired"; job.updatedAt = Date.now(); this.persist(); continue; }
        if (balance >= BigInt(p.amount)) {
          const data = encodeDeployAndExecute(p, job.execution);
          const priced = Number(p.assetType) === 0 ? await this.belowCost(job, data) : { wait: false };
          if (!priced.wait) await this.send(job, data, "executing", "execute-failed", { estimated: priced.gas });
        }
      }
    }
  }
}
