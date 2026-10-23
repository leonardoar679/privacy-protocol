// Shield executor (Privacy Wallet Web spec v2.0 §11.2; V6 Stage 12): a same-chain swap pays its output to a one-time
// shield receiver, a counterfactual CREATE2 address out of which only the note the wallet committed can come. Somebody
// has to deploy it and shield the delivery once the provider paid — `ShieldReceiverFactory.deployAndShield(params,
// noteData)`, which pays the committed tip to msg.sender — and the relayer does it for the tip. It can do nothing else:
// the receiver's address is a function of the params, and the deposit goes to the asset's canonical vault as the note the
// wallet committed (its owner, its secret, the hash of its payload). The executor checks a job before accepting it (its
// own factory, parameters a receiver's constructor accepts, the payload's hash, a canonical vault for the asset), then
// watches the receiver:
//   waiting-delivery ──(balance ≥ minAmount: the tip-paying shield)──▶ shielding ──▶ shielded ──(a later delivery)──▶ shielding …
//        │ nothing delivered by the end of the watch ▶ expired                   a shield that still reverts at the end ▶ shield-failed
//        └──(a smaller delivery once the swap is over, `deliverBy`: a shield no tip pays for)──▶ shielding
// It never shields an ETH receipt below cost while the swap can still deliver (it waits, as the swap executor does; the tip
// is the shield's gas at quote time with a margin). Shields no tip pays for — a delivery after the paid one, one smaller
// than the minimum, one after somebody else claimed the tip — are bounded: at most `maxUnpaidShields` per receipt, each
// moving at least its floor (ETH: twice its gas; a token: twice the receipt's tip, the shield's gas at quote time in the
// token). A token's floor was the receipt's whole minimum (the audit round of 2026-10-16, c10), so a smaller token delivery
// — after a lower minimum the user accepted, or a partly filled streamed swap — never reached the pool. A delivery still
// below its floor when the watch ends ends the job (`expired`, the balance noted); it stays at the receiver (shield() is
// permissionless, but until a first shield publishes it only the wallet and this relayer know the payload). Foreign tokens
// (shieldToken, sweepUnsupported) are not watched here: anyone may call them. A shield that would revert (a paused token,
// a race) is estimated again every ESTIMATE_RETRY_SECONDS until the watch ends, and a mined one that reverted goes back to
// the state it was sent from, at most MAX_REVERTED_SHIELDS times (the audit round of 2026-10-16, c13: one revert ended the
// job for good, and the wallet, finding the job, never registered it again, so a delivery it had seen stayed at the receiver).
import { ABI, BYTECODE, predictReceiver, receiverParamsOf, receiverParamsProblem, type ReceiverParamsJson } from "@privacy-wallet/contracts";
import { encodeFunctionData, keccak256, parseAbi, parseEventLogs, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import type { Journal } from "./journal";
import { DROP_AFTER_MS, Sender, unknownToTheNode, type SentTx } from "./sender";
import { shieldVouchDigest, vouchedBy } from "@privacy-wallet/swap-engine/endpoints";

/** How long a receipt is watched after `deliverBy` for a late delivery (a provider that pays out late). */
export const LATE_DELIVERY_WATCH_SECONDS = 24 * 3600;
/** At most this many shields of a receipt that no tip pays for. */
export const MAX_UNPAID_SHIELDS = 3;
/** The furthest `deliverBy` a job may name (the swap's refundAfter is hours away, never weeks). */
const MAX_DELIVER_BY_SECONDS = 30 * 86400;
/** A shield that would revert is estimated again after this long (until the watch ends). */
export const ESTIMATE_RETRY_SECONDS = 600;
/** At most this many mined shields of a receipt that reverted send it back to its state; the next one fails the job. */
export const MAX_REVERTED_SHIELDS = 2;
const UNPAID_GAS_MULTIPLE = 2n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const erc20Abi = parseAbi(["function balanceOf(address owner) view returns (uint256)"]);
const configAbi = parseAbi([
  "function VAULT_FACTORY() view returns (address)",
  "function WRAPPED_NATIVE() view returns (address)",
  "function vaultOf(address asset) view returns (address)",
]);
const receiverAbi = parseAbi(["function tipPaid() view returns (bool)"]);
/** A token shield no tip pays for moves at least twice the receipt's tip: the shield's gas at quote time, in the token (a
 *  receipt without a tip: twice the largest it could have, 1 % of its minimum). */
const tokenFloor = (p: ReceiverParamsJson): bigint => {
  const tip = BigInt(p.shieldTip);
  return UNPAID_GAS_MULTIPLE * (tip > 0n ? tip : BigInt(p.minAmount) / 100n);
};

/** `deliverBy`: unix seconds by which the swap has delivered or refunded (the order's refundAfter). */
export interface ShieldJobRequest {
  factory: Address;
  params: ReceiverParamsJson;
  noteData: Hex;
  deliverBy: number;
  /** the swap service's vouch for the receipt (a V6 follow-up of 2026-10-16, audit gap 47) */
  vouch?: Hex;
}
export type ShieldJobState = "waiting-delivery" | "shielding" | "shielded" | "shield-failed" | "expired";
/** One mined shield: the deposit's leaf in the pool, what it deposited and the tip it paid (base units of the receipt's asset). */
export interface ShieldRecord {
  txHash: Hex;
  leafIndex?: number;
  amount?: string;
  tip?: string;
  at: number;
}
export interface ShieldJob {
  id: string;
  receiver: Address;
  factory: Address;
  params: ReceiverParamsJson;
  noteData: Hex;
  deliverBy: number;
  state: ShieldJobState;
  /** the tip-paying shield was mined */
  paid?: boolean;
  /** shields sent that no tip paid for */
  unpaidShields?: number;
  shields?: ShieldRecord[];
  txHash?: Hex;
  error?: string;
  /** what the receiver held at the last read (an ETH receipt: with its wrapped ETH) */
  balance?: string;
  /** the last mined transaction's gas and gasUsed × effectiveGasPrice */
  gasUsed?: string;
  actualNetworkWei?: string;
  /** the shield in flight: one the node drops sends the job back to `from` (a V6 follow-up of 2026-10-15) */
  sent?: SentTx<ShieldJobState>;
  /** when the last estimate reverted (unix s): estimated again ESTIMATE_RETRY_SECONDS later (audit c13) */
  revertedAt?: number;
  /** mined shields that reverted and sent the job back (audit c13) */
  revertedShields?: number;
  createdAt: number;
  updatedAt: number;
}

export class ShieldJobError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const isHex = (x: unknown, bytes?: number) => typeof x === "string" && /^0x[0-9a-fA-F]*$/.test(x) && (bytes === undefined || (x.length - 2) / 2 === bytes);
const firstLine = (e: unknown, n: number) =>
  String((e as Error)?.message ?? e)
    .split("\n")[0]
    .slice(0, n);
const TERMINAL: ShieldJobState[] = ["shield-failed", "expired"];

export const encodeDeployAndShield = (params: ReceiverParamsJson, noteData: Hex): Hex =>
  encodeFunctionData({ abi: ABI.shieldReceiverFactory, functionName: "deployAndShield", args: [receiverParamsOf(params), noteData] });

export interface ShieldExecutorConfig {
  /** the ShieldReceiverFactory this relayer serves (SHIELD_FACTORY) */
  factory: Address;
  account: PrivateKeyAccount;
  publicClient: PublicClient;
  walletClient: WalletClient;
  /** the account's one sender, shared with the submissions and the swap executor (server.ts); a test's own otherwise */
  sender?: Sender;
  /** the swap service's signer (API_VOUCHER) and the chain its vouches name: the executor shields only a vouched receipt; unset, none */
  voucher?: Address | readonly Address[];
  chainId?: number;
  /** the receiver's creation code (forge's export); a test may pass another build's */
  creationCode?: Hex;
  now?: () => number;
  journal?: Journal<ShieldJob>;
  lateDeliveryWatchSeconds?: number;
  maxUnpaidShields?: number;
  maxRevertedShields?: number;
}

export class ShieldExecutor {
  private jobs = new Map<string, ShieldJob>();
  private pool: { vaultFactory: Address; wrapped: Address | null } | null = null;
  private readonly sender: Sender;
  constructor(readonly cfg: ShieldExecutorConfig) {
    this.sender = cfg.sender ?? new Sender(cfg.account, cfg);
    for (const j of cfg.journal?.load() ?? []) this.jobs.set(j.id, j); // restart: resume every open job
  }

  private now(): number {
    return this.cfg.now ? this.cfg.now() : Math.floor(Date.now() / 1000);
  }
  private persist(): void {
    this.cfg.journal?.save([...this.jobs.values()]);
  }
  get(id: string): ShieldJob | undefined {
    return this.jobs.get(id.toLowerCase());
  }
  list(): ShieldJob[] {
    return [...this.jobs.values()];
  }
  open(): number {
    return this.list().filter((j) => !TERMINAL.includes(j.state) && !(j.state === "shielded" && this.now() >= this.watchEnd(j))).length;
  }
  private watchEnd(j: ShieldJob): number {
    return j.deliverBy + (this.cfg.lateDeliveryWatchSeconds ?? LATE_DELIVERY_WATCH_SECONDS);
  }

  /** The factory's pool (its vault factory) and wrapped native token, read once (a failed read is retried next call). */
  private async poolOf(): Promise<{ vaultFactory: Address; wrapped: Address | null }> {
    if (this.pool) return this.pool;
    const [vaultFactory, wrapped] = (await Promise.all([
      this.cfg.publicClient.readContract({ address: this.cfg.factory, abi: configAbi, functionName: "VAULT_FACTORY" }),
      this.cfg.publicClient.readContract({ address: this.cfg.factory, abi: configAbi, functionName: "WRAPPED_NATIVE" }),
    ])) as [Address, Address];
    this.pool = { vaultFactory, wrapped: wrapped.toLowerCase() === ZERO_ADDRESS ? null : wrapped };
    return this.pool;
  }

  /**
   * Accept a receipt to watch: this relayer's factory, parameters a receiver accepts, the payload that hashes to the
   * committed one, a canonical vault for the asset. The same receipt again is the same job (a wallet retrying a lost
   * answer); the same receipt id with other parameters is refused.
   */
  /** `full`: the open shield jobs fill MAX_SWAP_JOBS — a new receipt is refused `capacity`, one already watched is still answered */
  async add(req: ShieldJobRequest, o: { full?: boolean } = {}): Promise<ShieldJob> {
    if (!req || !isHex(req.factory, 20) || !req.params || typeof req.params !== "object")
      throw new ShieldJobError("bad_request", "factory, params, noteData and deliverBy are required");
    if (req.factory.toLowerCase() !== this.cfg.factory.toLowerCase())
      throw new ShieldJobError("unknown_factory", `this relayer shields for ${this.cfg.factory}, not ${req.factory}`);
    let params;
    try {
      params = receiverParamsOf(req.params);
    } catch {
      throw new ShieldJobError("bad_params", "the receiver's parameters are malformed");
    }
    const problem = receiverParamsProblem(params);
    if (problem) throw new ShieldJobError("bad_params", problem);
    if (!isHex(req.noteData, 169)) throw new ShieldJobError("bad_payload", "noteData must be the 169-byte payload");
    if (keccak256(req.noteData) !== params.noteDataHash.toLowerCase())
      throw new ShieldJobError("payload_mismatch", "noteData does not hash to the committed noteDataHash");
    const now = this.now();
    if (!Number.isInteger(req.deliverBy) || req.deliverBy < now || req.deliverBy > now + MAX_DELIVER_BY_SECONDS)
      throw new ShieldJobError("bad_deadline", "deliverBy must be a unix time within the next 30 days");
    const receiver = predictReceiver(req.factory, params, this.cfg.creationCode ?? BYTECODE.shieldReceiver);
    // the swap service vouched for this receipt at its order's commit (a V6 follow-up of 2026-10-16, audit gap 47): a receipt of
    // anyone's own, for a token of no value, had the relayer pay a shield's gas for a tip worth nothing
    if (!this.cfg.voucher || this.cfg.voucher.length === 0 || this.cfg.chainId === undefined)
      throw new ShieldJobError("shield_unavailable", "this relayer shields no receipt (API_VOUCHER is unset)");
    if (!vouchedBy(this.cfg.voucher, shieldVouchDigest(BigInt(this.cfg.chainId), receiver), req.vouch))
      throw new ShieldJobError("unvouched_order", "the swap service did not vouch for this receipt: the executor shields only receipts of orders it committed");
    const id = params.receiptId.toLowerCase();
    const existing = this.jobs.get(id);
    if (existing) {
      if (existing.receiver.toLowerCase() !== receiver.toLowerCase())
        throw new ShieldJobError("receipt_conflict", "another receipt with this id is already watched");
      return existing;
    }
    // at capacity only after that lookup (audit round 2, r13): the hand-over registers its receipt again, and the cap refused it
    // before the lookup — a funded same-chain swap whose job was taken was not handed over, until its window closed
    if (o.full) throw new ShieldJobError("capacity", "too many open shield jobs");
    const { vaultFactory } = await this.poolOf();
    const vault = (await this.cfg.publicClient.readContract({
      address: vaultFactory,
      abi: configAbi,
      functionName: "vaultOf",
      args: [params.asset],
    })) as Address;
    if (vault.toLowerCase() === ZERO_ADDRESS)
      throw new ShieldJobError("no_vault", `the pool has no canonical vault for ${params.asset}: the receipt cannot be shielded`);
    const job: ShieldJob = {
      id,
      receiver,
      factory: req.factory,
      params: req.params,
      noteData: req.noteData,
      deliverBy: req.deliverBy,
      state: "waiting-delivery",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.jobs.set(id, job);
    this.persist();
    return job;
  }

  /** What the receiver holds of its asset; an ETH receipt counts its wrapped ETH too (shield() unwraps it). */
  private async balanceOf(job: ShieldJob): Promise<bigint> {
    const asset = job.params.asset;
    if (asset.toLowerCase() !== ZERO_ADDRESS)
      return (await this.cfg.publicClient.readContract({ address: asset, abi: erc20Abi, functionName: "balanceOf", args: [job.receiver] })) as bigint;
    const eth = await this.cfg.publicClient.getBalance({ address: job.receiver });
    const { wrapped } = await this.poolOf();
    const weth = wrapped
      ? ((await this.cfg.publicClient
          .readContract({ address: wrapped, abi: erc20Abi, functionName: "balanceOf", args: [job.receiver] })
          .catch(() => 0n)) as bigint)
      : 0n;
    return eth + weth;
  }

  /** Whether the deployed receiver already paid its tip (somebody shielded a delivery of at least the minimum). */
  private async tipPaidOnChain(job: ShieldJob): Promise<boolean> {
    const code = await this.cfg.publicClient.getCode({ address: job.receiver }).catch(() => undefined);
    if (!code || code === "0x") return false;
    return (await this.cfg.publicClient.readContract({ address: job.receiver, abi: receiverAbi, functionName: "tipPaid" }).catch(() => false)) as boolean;
  }

  /** Record a note on the job once (not on every tick). */
  private note(job: ShieldJob, msg: string): void {
    if (job.error === msg) return;
    job.error = msg;
    job.updatedAt = Date.now();
    this.persist();
  }

  /** The shield, through the account's one sender (src/sender.ts); one that never left is noted and tried again next tick. */
  private async send(job: ShieldJob, data: Hex, gas: bigint, unpaid: boolean): Promise<void> {
    const sent = await this.sender.send({ to: job.factory, data, gas: (gas * 12n) / 10n });
    if (!sent.ok) {
      this.note(job, `not sent: ${sent.error}; retried next tick`);
      return;
    }
    job.sent = { from: job.state, at: this.now(), ...(unpaid ? { unpaid } : {}) };
    job.txHash = sent.hash;
    job.state = "shielding";
    job.error = sent.note;
    if (unpaid) job.unpaidShields = (job.unpaidShields ?? 0) + 1;
    job.updatedAt = Date.now();
    this.persist();
  }

  /**
   * A shield the node no longer knows DROP_AFTER_MS after it was sent was dropped and never gets a receipt: the job goes
   * back to the state it was sent from (a shield no tip paid for gives its place in the budget back), and the next tick
   * shields again (a V6 follow-up of 2026-10-15; the job waited for that receipt for good, the delivery at the receiver).
   */
  private async resendIfDropped(job: ShieldJob, now: number): Promise<void> {
    const at = job.sent?.at ?? Math.floor(job.updatedAt / 1000);
    if (!job.txHash || now - at < DROP_AFTER_MS / 1000 || !(await unknownToTheNode(this.cfg.publicClient, job.txHash))) return;
    if (job.sent?.unpaid) job.unpaidShields = Math.max(0, (job.unpaidShields ?? 1) - 1);
    job.error = `${job.txHash} was dropped before it was mined; shielded again`;
    job.state = job.sent?.from ?? (job.shields?.length ? "shielded" : "waiting-delivery");
    job.txHash = undefined;
    job.sent = undefined;
    job.updatedAt = Date.now();
    this.persist();
  }

  /** A mined shield: its gas, and from the receiver's Shielded event the leaf, the deposit and the tip. */
  private settle(job: ShieldJob, receipt: Awaited<ReturnType<PublicClient["getTransactionReceipt"]>>): void {
    job.gasUsed = receipt.gasUsed.toString();
    job.actualNetworkWei = (receipt.gasUsed * receipt.effectiveGasPrice).toString();
    if (receipt.status !== "success") {
      const reverted = (job.revertedShields ?? 0) + 1;
      job.revertedShields = reverted;
      if (job.sent?.unpaid) job.unpaidShields = Math.max(0, (job.unpaidShields ?? 1) - 1); // it shielded nothing
      if (reverted > (this.cfg.maxRevertedShields ?? MAX_REVERTED_SHIELDS)) {
        job.state = "shield-failed";
        job.error = `the shield transaction ${receipt.transactionHash} reverted (${reverted} times)`;
      } else {
        // somebody else may have shielded first, or the asset paused: the receiver is read again at the next tick
        job.state = job.sent?.from ?? (job.shields?.length ? "shielded" : "waiting-delivery");
        job.error = `the shield transaction ${receipt.transactionHash} reverted; the receiver is read again`;
      }
    } else {
      const ev = parseEventLogs({ abi: ABI.shieldReceiver, logs: receipt.logs, eventName: "Shielded" }).find(
        (l) => l.address.toLowerCase() === job.receiver.toLowerCase(),
      ) as { args: { amount: bigint; tip: bigint; leafIndex: number } } | undefined;
      const record: ShieldRecord = {
        txHash: receipt.transactionHash,
        at: Date.now(),
        ...(ev ? { leafIndex: Number(ev.args.leafIndex), amount: ev.args.amount.toString(), tip: ev.args.tip.toString() } : {}),
      };
      job.shields = [...(job.shields ?? []), record];
      if (ev && ev.args.tip > 0n) job.paid = true;
      job.state = "shielded";
      job.error = undefined;
    }
    job.txHash = undefined;
    job.sent = undefined;
    job.updatedAt = Date.now();
    this.persist();
  }

  private ticking: Promise<void> | null = null;
  private tickAgain = false;
  /** One pass over every open job, never two at once (two passes over one delivery would each send a shield). */
  async tick(): Promise<void> {
    if (this.ticking) {
      this.tickAgain = true;
      return this.ticking;
    }
    this.ticking = (async () => {
      try {
        do {
          this.tickAgain = false;
          await this.pass();
        } while (this.tickAgain);
      } finally {
        this.ticking = null;
      }
    })();
    return this.ticking;
  }

  private async pass(): Promise<void> {
    const now = this.now();
    for (const job of this.jobs.values()) {
      if (TERMINAL.includes(job.state)) continue;
      if (job.state === "shielding") {
        const receipt = job.txHash ? await this.cfg.publicClient.getTransactionReceipt({ hash: job.txHash }).catch(() => null) : null;
        if (receipt) this.settle(job, receipt);
        else await this.resendIfDropped(job, now);
        continue;
      }
      const watchEnd = this.watchEnd(job);
      if (job.state === "shielded" && now >= watchEnd) continue; // delivered and shielded; the watch for a late delivery is over
      let balance: bigint;
      try {
        balance = await this.balanceOf(job);
      } catch (e) {
        this.note(job, `could not read the receiver's balance: ${firstLine(e, 160)}; retried next tick`);
        continue;
      }
      job.balance = balance.toString();
      if (balance === 0n) {
        if (now >= watchEnd && job.state === "waiting-delivery") {
          job.state = "expired"; // nothing ever arrived (the swap refunded to its escrow instead)
          job.updatedAt = Date.now();
          this.persist();
        }
        continue;
      }
      const min = BigInt(job.params.minAmount);
      const native = job.params.asset.toLowerCase() === ZERO_ADDRESS;
      const paidPath = !job.paid && balance >= min && !(await this.tipPaidOnChain(job));
      if (!paidPath) {
        // no tip pays for this shield: a smaller delivery waits until the swap is over, then a bounded, floored shield
        if (!job.paid && balance < min && now < job.deliverBy) continue;
        if ((job.unpaidShields ?? 0) >= (this.cfg.maxUnpaidShields ?? MAX_UNPAID_SHIELDS)) {
          this.note(
            job,
            `the ${this.cfg.maxUnpaidShields ?? MAX_UNPAID_SHIELDS} shields no tip pays for are used: what arrives now stays at the receiver, where anyone can shield it`,
          );
          continue;
        }
        // a token delivery below its floor is not worth a shield's gas: never estimated, and past the watch the job ends
        if (!native && balance < tokenFloor(job.params)) {
          this.belowFloor(job, balance, now >= watchEnd);
          continue;
        }
      }
      if (job.revertedAt !== undefined && now - job.revertedAt < ESTIMATE_RETRY_SECONDS && now < watchEnd) continue;
      const data = encodeDeployAndShield(job.params, job.noteData);
      let gas: bigint;
      try {
        gas = await this.cfg.publicClient.estimateGas({ account: this.cfg.account.address, to: job.factory, data });
      } catch (e) {
        if (!/revert/i.test(String((e as Error)?.message ?? e))) {
          this.note(job, `could not estimate the shield: ${firstLine(e, 160)}; retried next tick`);
        } else if (now >= watchEnd) {
          job.state = "shield-failed"; // still reverting when the watch is over
          job.error = `would revert: ${firstLine(e, 200)}`;
          job.revertedAt = now;
          job.updatedAt = Date.now();
          this.persist();
        } else {
          job.revertedAt = now; // a paused token, a race: estimated again later, never sent while it would revert
          this.note(job, `would revert: ${firstLine(e, 160)}; estimated again in ${ESTIMATE_RETRY_SECONDS / 60} min`);
        }
        continue;
      }
      if (job.revertedAt !== undefined) {
        job.revertedAt = undefined;
        this.persist();
      }
      let price: bigint | null = null;
      if (native) price = await this.cfg.publicClient.getGasPrice().catch(() => null);
      if (paidPath) {
        // the tip pays the shield's gas: an ETH receipt waits while shielding costs more than its tip — until the swap is over
        if (native && price !== null && now < job.deliverBy && gas * price > BigInt(job.params.shieldTip)) {
          this.note(job, `waiting: shielding now costs ${gas * price} wei, above the receipt's ${job.params.shieldTip} wei tip`);
          continue;
        }
        await this.send(job, data, gas, false);
        continue;
      }
      const floor = native ? (price !== null ? UNPAID_GAS_MULTIPLE * gas * price : null) : tokenFloor(job.params);
      if (floor === null) continue;
      if (balance < floor) {
        this.belowFloor(job, balance, now >= watchEnd);
        continue;
      }
      await this.send(job, data, gas, true);
    }
  }

  /** A delivery below the floor of a shield no tip pays for waits; once the watch is over a job that shielded nothing ends. */
  private belowFloor(job: ShieldJob, balance: bigint, watchOver: boolean): void {
    if (!watchOver || job.state !== "waiting-delivery") return;
    job.state = "expired";
    job.error = `the ${balance} that arrived is below the floor of a shield no tip pays for: it stays at the receiver`;
    job.updatedAt = Date.now();
    this.persist();
  }
}
