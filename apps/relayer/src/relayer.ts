// Relayer (plan §76, §81; spec v1.0 "relayer fee note"): submits a wallet's already-proven
// `PrivacyCore.transact` from the relayer's own key so the user's public address never appears, and
// is paid by one of the transaction's three outputs — a private note to the relayer's own owner
// commitment, whose opening the wallet includes in the request. Nothing on chain names the relayer
// (spec §13.3: no relayer field) and nothing it does can alter the transaction (the proof binds every
// public input, including the payload hashes). It can only refuse, which is why the wallet keeps
// self-submission and any other relayer as fallbacks (plan §85 rule 5).
//
// Fees: a transaction is single-asset, so the fee note lives in the transaction's vault. The ETH
// vault's minimum is priced live from gas; ERC-20 vaults (plan §36: private USDC / USDT) carry a
// fixed operator-set minimum per vault (no price oracle here — the operator reprices by config).
//
// Before spending gas the relayer checks: the chain/core binding (txDomain), every payload hash, that
// the fee output really is a note to it in an accepted vault with at least that vault's current
// minimum, that the nullifiers are not already in flight here, and that the call simulates without
// reverting (which covers the proof, the root and the nullifier set).
import { createPublicClient, createWalletClient, http, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deriveKeys } from "@privacy-wallet/protocol/keys";
import { noteBody, ownerCommitmentOf } from "@privacy-wallet/protocol/note";
import { NOTE_DATA_BYTES, noteDataHash, txDomain } from "@privacy-wallet/protocol/payload";
import { decryptNoteData, viewKeyPair, type ViewKeyPair } from "@privacy-wallet/protocol/envelope";
import { encodePrivacyAddress } from "@privacy-wallet/protocol/address";
import { bpsLabel, feeMeetsTerms } from "@privacy-wallet/protocol/wallet/fees";
import { coreAbi, encodeTransact, piFromStrings, type PublicInputs } from "./abi";
import type { Journal } from "./journal";
import { DROP_AFTER_MS, Sender, unknownToTheNode } from "./sender";

/** An ERC-20 vault the relayer accepts fee notes in, with a fixed minimum in the token's base units. */
export interface FeeVaultTerms { symbol: string; decimals: number; minFee: bigint }

export interface RelayerConfig {
  chainId: number;
  core: Address;
  feeVault: Address; // the canonical ETH vault: fee notes in it are priced live from gas
  feeVaults?: Record<string, FeeVaultTerms>; // lowercase ERC-20 vault address -> fixed terms (plan §36)
  minFeeWei: bigint; // floor; the live minimum is max(floor, gasEstimate × gasPrice × (1 + margin))
  gasEstimate: bigint; // transact ≈ 1.8M gas (benchmarks/gas)
  feeMarginBps: number;
  privateKey: Hex; // the submitting EOA (holds gas only)
  masterSeed: Uint8Array; // the relayer's wallet seed: fee notes are paid to its owner commitment / view key
  rpcUrl: string;
  requireReadableFeePayload: boolean; // refuse a fee whose payload the relayer cannot decrypt (recovery without the journal)
  journal?: Journal<Job>; // durable submissions: in-flight nullifiers and fee notes survive a restart
  /** V6 (Privacy Wallet Web spec v2.0 §3): the privacy fee, basis points of what a withdrawal takes out of the pool (its
   *  public amount plus the fee note), on top of the minimum — a swap's escrow funding included; a transfer's amount is
   *  hidden, so only the minimum can be enforced there; absent or 0: none */
  feePercentBps?: number;
}

/** The fee note's opening; `vault` defaults to the ETH vault (older wallets omit it). */
export interface FeeOpening { outputIndex: 0 | 1 | 2; amount: string; noteSecret: string; vault?: Address }
export interface SubmitRequest { proof: Hex; publicInputs: (string | bigint)[]; noteData: [Hex, Hex, Hex]; fee: FeeOpening }
/** V6 (spec v2.0 §3): `gasUsed` and `actualNetworkWei` (gasUsed × effectiveGasPrice) from the receipt, once mined */
/** `dropped`: the node no longer knew the transaction and its nullifiers were unspent (`monitor`); they were released */
export interface Job { txHash: Hex; nullifiers: [string, string]; feeWei: string; feeVault: Address; feeOutputIndex: number; feeNoteSecret: string; feePayloadReadable: boolean; submittedAt: number; status: "submitted" | "mined" | "reverted" | "dropped"; gasUsed?: string; actualNetworkWei?: string; droppedAt?: number }

/** How long a submitted transaction may be unknown to the node before its job counts as dropped (`monitor`). */
export { DROP_AFTER_MS };

export class RelayerError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

export interface RelayerIdentity { ownerCommitment: bigint; view: ViewKeyPair; privacyAddress: string }
export function relayerIdentity(masterSeed: Uint8Array): RelayerIdentity {
  const keys = deriveKeys(masterSeed);
  const view = viewKeyPair(keys.viewKey);
  const ownerCommitment = ownerCommitmentOf(keys.spendKey);
  return { ownerCommitment, view, privacyAddress: encodePrivacyAddress(ownerCommitment, view.publicKey) };
}

const isHex = (x: unknown, bytes?: number) => typeof x === "string" && /^0x[0-9a-fA-F]*$/.test(x) && (bytes === undefined || (x.length - 2) / 2 === bytes);
const hexToBytes = (h: Hex): Uint8Array => Uint8Array.from(h.slice(2).match(/../g)!.map((x) => parseInt(x, 16)));

export class Relayer {
  readonly account;
  /** The account's one sender: the swap and the shield executors send through it too (a V6 follow-up of 2026-10-15). */
  readonly sender: Sender;
  readonly identity: RelayerIdentity;
  private jobs = new Map<Hex, Job>();
  private inflight = new Set<string>();
  private monitoring = false;

  constructor(readonly cfg: RelayerConfig, readonly clients: { publicClient: PublicClient; walletClient: WalletClient }) {
    this.account = privateKeyToAccount(cfg.privateKey);
    this.sender = new Sender(this.account, clients);
    this.identity = relayerIdentity(cfg.masterSeed);
    for (const j of cfg.journal?.load() ?? []) {
      this.jobs.set(j.txHash, j);
      if (j.status === "submitted") j.nullifiers.forEach((n) => this.inflight.add(n));
    }
  }
  private persist(): void { this.cfg.journal?.save([...this.jobs.values()]); }

  static fromConfig(cfg: RelayerConfig): Relayer {
    const chain = { id: cfg.chainId, name: `chain-${cfg.chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } } as const;
    const transport = http(cfg.rpcUrl, { batch: true, fetchOptions: { credentials: "omit", redirect: "error" } });
    const account = privateKeyToAccount(cfg.privateKey);
    return new Relayer(cfg, { publicClient: createPublicClient({ chain, transport }), walletClient: createWalletClient({ account, chain, transport }) });
  }

  /** The live minimum fee in the ETH vault: gas for one transact at the current price plus the margin, never below the floor. */
  async minFeeWei(): Promise<{ minFeeWei: bigint; gasPriceWei: bigint }> {
    const gasPriceWei = await this.clients.publicClient.getGasPrice();
    const dynamic = (this.cfg.gasEstimate * gasPriceWei * BigInt(10_000 + this.cfg.feeMarginBps)) / 10_000n;
    return { minFeeWei: dynamic > this.cfg.minFeeWei ? dynamic : this.cfg.minFeeWei, gasPriceWei };
  }

  /** The vault a fee opening names (default: the ETH vault), or null when the relayer does not take fees there. */
  feeVaultOf(fee: { vault?: Address }): { vault: Address; erc20: FeeVaultTerms | null } | null {
    const vault = (fee.vault ?? this.cfg.feeVault).toLowerCase() as Address;
    if (vault === this.cfg.feeVault.toLowerCase()) return { vault: this.cfg.feeVault, erc20: null };
    const terms = this.cfg.feeVaults?.[vault];
    return terms ? { vault, erc20: terms } : null;
  }

  async info() {
    const { minFeeWei, gasPriceWei } = await this.minFeeWei();
    return {
      chainId: this.cfg.chainId, core: this.cfg.core, feeVault: this.cfg.feeVault, relayer: this.account.address, privacyAddress: this.identity.privacyAddress,
      minFeeWei: minFeeWei.toString(), gasPriceWei: gasPriceWei.toString(), gasEstimate: this.cfg.gasEstimate.toString(), feeMarginBps: this.cfg.feeMarginBps,
      requireReadableFeePayload: this.cfg.requireReadableFeePayload, inflight: this.inflight.size,
      feePercentBps: this.cfg.feePercentBps ?? 0, feeMinimumWei: minFeeWei.toString(), // V5 (spec §10)
      feeVaults: Object.entries(this.cfg.feeVaults ?? {}).map(([vault, t]) => ({ vault, symbol: t.symbol, decimals: t.decimals, minFee: t.minFee.toString() })),
    };
  }

  /** Everything checkable without the chain. */
  validateShape(req: SubmitRequest): { pi: PublicInputs; feeWei: bigint; feeVault: Address; feePayloadReadable: boolean } {
    if (!isHex(req?.proof, 256)) throw new RelayerError("bad_proof", "proof must be abi.encode(a, b, c): 256 bytes");
    let pi: PublicInputs;
    try { pi = piFromStrings(req.publicInputs); } catch (e) { throw new RelayerError("bad_public_inputs", String((e as Error).message)); }
    if (!Array.isArray(req.noteData) || req.noteData.length !== 3 || !req.noteData.every((n) => isHex(n, NOTE_DATA_BYTES))) throw new RelayerError("bad_payloads", `noteData must be three ${NOTE_DATA_BYTES}-byte payloads`);
    if (pi.txDomain !== txDomain(BigInt(this.cfg.chainId), BigInt(this.cfg.core))) throw new RelayerError("wrong_domain", "txDomain is not this chain / core");
    const hashes = [pi.noteData0Hash, pi.noteData1Hash, pi.noteData2Hash];
    req.noteData.forEach((n, k) => { if (noteDataHash(hexToBytes(n)) !== hashes[k]) throw new RelayerError("payload_hash_mismatch", `noteData${k} does not hash to the proven value`); });
    const f = req.fee;
    if (!f || ![0, 1, 2].includes(f.outputIndex)) throw new RelayerError("bad_fee", "fee.outputIndex must be 0, 1 or 2");
    if (f.vault !== undefined && !isHex(f.vault, 20)) throw new RelayerError("bad_fee", "fee.vault must be a vault address");
    const fv = this.feeVaultOf(f);
    if (!fv) throw new RelayerError("fee_vault_not_accepted", `this relayer takes no fees in vault ${f.vault}; accepted: ${[this.cfg.feeVault, ...Object.keys(this.cfg.feeVaults ?? {})].join(", ")}`);
    let amount: bigint, secret: bigint;
    try { amount = BigInt(f.amount); secret = BigInt(f.noteSecret); } catch { throw new RelayerError("bad_fee", "fee.amount / fee.noteSecret must be integers"); }
    const body = noteBody({ vaultId: BigInt(fv.vault), amount, ownerCommitment: this.identity.ownerCommitment, noteSecret: secret });
    const bodies = [pi.outputBody0, pi.outputBody1, pi.outputBody2];
    if (body !== bodies[f.outputIndex]) throw new RelayerError("fee_note_mismatch", `output ${f.outputIndex} is not a note of ${amount} units to this relayer in vault ${fv.vault}`);
    const opened = decryptNoteData(this.identity.view, hexToBytes(req.noteData[f.outputIndex]));
    const feePayloadReadable = !!opened && opened.amount === amount && opened.noteSecret === secret && opened.vaultId === BigInt(fv.vault);
    if (this.cfg.requireReadableFeePayload && !feePayloadReadable) throw new RelayerError("fee_payload_unreadable", "the fee note's payload is not encrypted to this relayer's view key");
    return { pi, feeWei: amount, feeVault: fv.vault, feePayloadReadable };
  }

  /** The minimum this relayer takes in a vault right now: live from gas in the ETH vault, the configured floor elsewhere. */
  async minFeeIn(fee: { vault?: Address }): Promise<bigint> {
    const fv = this.feeVaultOf(fee);
    if (!fv) throw new RelayerError("fee_vault_not_accepted", `no fees taken in vault ${fee.vault}`);
    return fv.erc20 ? fv.erc20.minFee : (await this.minFeeWei()).minFeeWei;
  }

  async submit(req: SubmitRequest): Promise<{ txHash: Hex; feeWei: string; feeVault: Address; gas: string; feePayloadReadable: boolean }> {
    const { pi, feeWei, feeVault, feePayloadReadable } = this.validateShape(req);
    const minFee = await this.minFeeIn(req.fee);
    // V6 (spec v2.0 §3): f ≥ ⌈(W + f)·b / 10000⌉ + m for a withdrawal — a swap's escrow funding included, the V5 exemption
    // is gone; a transfer hides its amount, so its fee note answers to the minimum alone (the wallet pays the percentage)
    const bps = pi.mode === 1n ? (this.cfg.feePercentBps ?? 0) : 0;
    const verdict = feeMeetsTerms(pi.mode === 1n ? pi.withdrawalAmount : 0n, feeWei, bps, minFee);
    if (!verdict.ok && verdict.code === "fee_too_low") throw new RelayerError("fee_too_low", `fee ${feeWei} is below the current minimum ${minFee} in vault ${feeVault}`);
    if (!verdict.ok) throw new RelayerError("fee_below_percent", `fee ${feeWei} is below ${bpsLabel(bps)} of the ${pi.withdrawalAmount + feeWei} leaving the pool plus the minimum ${minFee} (${verdict.required} in vault ${feeVault})`);
    const nullifiers: [string, string] = [pi.nullifier0.toString(), pi.nullifier1.toString()];
    if (nullifiers.some((n) => this.inflight.has(n))) throw new RelayerError("nullifier_in_flight", "a transaction spending one of these notes is already in flight here");
    // reserved in the same step as the check, before anything is awaited (a V6 follow-up of 2026-10-15): they were
    // reserved only after the simulation, so two requests spending one note, at once, both passed the check, both were
    // sent, and the second reverted on chain at the relayer's cost
    nullifiers.forEach((n) => this.inflight.add(n));
    const data = encodeTransact(req.proof, pi, req.noteData);
    let gas: bigint;
    try {
      gas = await this.clients.publicClient.estimateGas({ account: this.account.address, to: this.cfg.core, data });
    } catch (e) {
      nullifiers.forEach((n) => this.inflight.delete(n));
      throw new RelayerError("simulation_failed", `transact would revert: ${String((e as Error).message).split("\n")[0].slice(0, 200)}`);
    }
    // one send of this account at a time; a broadcast whose answer was lost, the node holding it, is submitted (`monitor`
    // drops it if it never lands), and only one that never left or that the node refused is send_failed
    const sent = await this.sender.send({ to: this.cfg.core, data, gas: (gas * 12n) / 10n });
    if (!sent.ok) {
      nullifiers.forEach((n) => this.inflight.delete(n));
      throw new RelayerError("send_failed", sent.error);
    }
    const txHash = sent.hash;
    this.jobs.set(txHash, { txHash, nullifiers, feeWei: feeWei.toString(), feeVault, feeOutputIndex: req.fee.outputIndex, feeNoteSecret: req.fee.noteSecret, feePayloadReadable, submittedAt: Date.now(), status: "submitted" });
    this.persist();
    return { txHash, feeWei: feeWei.toString(), feeVault, gas: gas.toString(), feePayloadReadable };
  }

  async status(txHash: Hex): Promise<(Job & { blockNumber?: string }) | null> {
    const job = this.jobs.get(txHash);
    if (!job) return null;
    if (job.status === "submitted") {
      const receipt = await this.clients.publicClient.getTransactionReceipt({ hash: txHash }).catch(() => null);
      if (receipt) {
        job.status = receipt.status === "success" ? "mined" : "reverted";
        // V6 (spec v2.0 §3): what the transaction really cost, beside the fee it was paid (the wallet's estimated / actual)
        job.gasUsed = receipt.gasUsed.toString();
        job.actualNetworkWei = (receipt.gasUsed * receipt.effectiveGasPrice).toString();
        job.nullifiers.forEach((n) => this.inflight.delete(n));
        this.persist();
        return { ...job, blockNumber: receipt.blockNumber.toString() };
      }
    }
    return { ...job };
  }

  /**
   * The submitted transactions, looked at again on the relayer's own tick (a V6 follow-up of 2026-10-14). Before, a job
   * left "submitted" only when someone asked GET /status/:txHash and found its receipt, and nothing asked. Every
   * nullifier ever submitted stayed "in flight" for good (436 in the local stack's relayer, every one of them), and a
   * restart loaded them again. A transaction dropped or replaced never got a receipt, so its notes could never be
   * submitted here again.
   * A receipt settles the job (`status`). A transaction the node no longer knows DROP_AFTER_MS after it was sent, with
   * its nullifiers unspent on chain, is dropped: they are released, and the wallet's next attempt is accepted. A
   * dropped transaction mined after all spends nothing twice: the chain refuses a spent nullifier. One pass at a time.
   */
  async monitor(now = Date.now()): Promise<void> {
    if (this.monitoring) return;
    this.monitoring = true;
    try {
      for (const job of [...this.jobs.values()]) {
        if (job.status !== "submitted") continue;
        if ((await this.status(job.txHash))?.status !== "submitted") continue;
        if (now - job.submittedAt < DROP_AFTER_MS || !(await unknownToTheNode(this.clients.publicClient, job.txHash))) continue;
        const spent = await Promise.all(job.nullifiers.map((n) => this.nullifierSpent(BigInt(n))));
        if (spent.some((s) => s !== false)) continue; // spent by another transaction, or unread: watched again
        job.status = "dropped";
        job.droppedAt = now;
        job.nullifiers.forEach((n) => this.inflight.delete(n));
        this.persist();
      }
    } finally {
      this.monitoring = false;
    }
  }
  /** PrivacyCore's answer, or null when it cannot be read. */
  private async nullifierSpent(n: bigint): Promise<boolean | null> {
    try {
      return (await this.clients.publicClient.readContract({ address: this.cfg.core, abi: coreAbi, functionName: "isNullifierSpent", args: [n] })) as boolean;
    } catch {
      return null;
    }
  }

  /** Public journal (nullifiers and hashes are on chain anyway); the fee secrets are the relayer's own notes. */
  jobs_(): Job[] { return [...this.jobs.values()]; }
  /**
   * V6 Stage 15 (doc §75): the job spending this nullifier — its transaction and status only —, so a wallet whose answer
   * was lost finds its submission again instead of sending it twice. Nothing else of the job leaves the relayer.
   */
  jobByNullifier(nullifier: string): { txHash: Hex; status: Job["status"] } | null {
    // the latest that may still spend it: a dropped one never will, so the wallet's next attempt is not sent to wait on it
    let found: Job | undefined;
    for (const j of this.jobs.values()) if (j.status !== "dropped" && j.nullifiers.includes(nullifier)) found = j;
    return found ? { txHash: found.txHash, status: found.status } : null;
  }
}
