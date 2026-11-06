// The two flows (spec v3.0 §7.5–§7.7; V7 Stage 9): a deposit — the note's commitment into the router (or the pool) from
// the connected wallet, the receipt awaited — and a withdrawal — the note looked up in the verified history, its path
// from the worker's tree, the proof in the worker and verified there, the user's confirmation, then the relayer's job
// followed to its end or the wallet-mode transaction awaited. Each step moves a record along the operation adapter's
// machine and is persisted at once (never a note, never a recipient). A flow refuses to start unless the pool function
// is switched live (CLASSIC_LIVE) — the screens never offer it otherwise, and this is the second lock.
import { isLive, type PoolId } from "../../config";
import type { Hex } from "../../history/events";
import { verifyAgainstChain } from "../../history/verify";
import { relayerMinimumWei } from "../../model/fees";
import { formatNote, leBigInt, type ClassicNote } from "../../model/notes";
import { poolFor, poolOf } from "../../model/pools";
import { refusedRecipient } from "../../model/recipient";
import { canDeposit } from "../../model/availability";
import { isSpentOnChain } from "../../history/spent";
import type { DepositFacts } from "../../model/types";
import type { MessageKey } from "../i18n/messages";
import type { CircuitInput } from "../../prover/input";
import type { ProofResult, ProverProgress } from "../../prover/protocol";
import { followJob, submitWithdrawal, RelayerRefusal } from "../../relayer/client";
import { relayerArgs } from "../../wallet/calldata";
import { waitForReceipt } from "../../wallet/connection";
import { isSanctioned } from "./compliance";
import { gasPriceWei } from "./gas";
import { closedRecord, fromRelayerState, IN_FLIGHT_HOLD_MS, inFlight, move, newJob, noteDigestOf, type JobRecord } from "./operations";
import { factsOf, plainText, receiptRpcOf, type ClassicServices } from "./source";

export type FlowStep =
  | { step: "proof"; progress?: ProverProgress }
  | { step: "confirm" }
  | { step: "submitting" }
  | { step: "following"; relayerState: string }
  | { step: "done"; job: JobRecord };

export interface DepositInput {
  pool: PoolId;
  note: ClassicNote;
  /** straight to the pool (the router disabled the instance): the user's explicit choice behind the warning */
  direct?: boolean;
  onJob?: (job: JobRecord) => void;
}

/** A refusal; `key` names its words in the catalog when they have their own (the critique: the new ones had reached a Korean reader in English). */
export class FlowRefused extends Error {
  constructor(
    message: string,
    readonly key?: MessageKey,
  ) {
    super(message);
  }
}

/** A refusal's reason for the record: the English kept, the catalog key beside it for the screen. */
const reasonOf = (e: unknown, fallback: string): Partial<JobRecord> => ({
  failedReason: e instanceof Error ? e.message : fallback,
  ...(e instanceof FlowRefused && e.key ? { failedKey: e.key } : {}),
});

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const id = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

/** What a proof pays, from its own public signals: the confirmation restates it (the tenth review round, C10-1). */
export interface ProofTerms {
  recipient: Hex;
  relayer: Hex;
  feeWei: bigint;
  refundWei: bigint;
}

/** The record's reason when a receipt says the transaction reverted: the screens tell it from a refusal. */
export const REVERTED = "the transaction reverted";

/**
 * The sanctions oracle, when its switch is on, asked of the account a transaction is sent from, right before it is (the tenth review
 * round, C10-9): it had been asked at Connect only — an account the wallet switched to afterwards sent unscreened — and a read that
 * failed had left the wallet connected. A read that fails refuses, as the original did.
 */
async function assertScreened(s: ClassicServices): Promise<`0x${string}` | null> {
  if (!s.config.complianceOracle) return null;
  const account = s.wallet.account;
  if (!s.rpc || !account) throw new FlowRefused("the compliance check could not be made: nothing is sent");
  let listed: boolean;
  try {
    listed = await isSanctioned(s.rpc, account);
  } catch {
    throw new FlowRefused("the compliance check could not be completed: nothing is sent");
  }
  if (listed) throw new FlowRefused("this address cannot use the interface: nothing is sent");
  // the account screened is the one the transaction leaves from (the eleventh review round, C11-7): the send refuses another
  return account;
}

/** The deposit: commitment → wallet → receipt; the record moved and kept at every step. */
export async function depositFlow(s: ClassicServices, input: DepositInput): Promise<JobRecord> {
  const { pool } = input;
  if (!isLive(s.config, pool, "deposit")) throw new FlowRefused("deposits are not switched on for this pool");
  // the note's pool is the pool deposited into (the review round of 2026-11-03, C2-2): the selector stayed reachable behind the
  // note modal, and a pool changed there sent another denomination for a note whose withdrawal could not find the deposit
  const noted = poolFor(input.note.currency, input.note.amount, input.note.netId);
  if (!noted || noted.id !== pool)
    throw new FlowRefused(`the note is for the ${input.note.amount} ${input.note.currency.toUpperCase()} pool, not the one selected`);
  // the pool's facts (C2-6; spec v3.0 §7.2, §7.7): an unverified contract, no endpoint or no wallet on mainnet sends nothing —
  // the availability rows had said so while the button stayed live
  await s.checkPool(pool);
  if (!canDeposit(factsOf(s, pool)))
    throw new FlowRefused(
      "the pool is not ready for a deposit: its contract is not verified, no RPC endpoint is configured, or the wallet is not connected on Ethereum",
    );
  const now = s.now;
  let job = newJob(id(), "deposit", pool, now());
  // the page's record, never the device's (the fourth review round, 2026-11-03): a persisted deposit row beside this device's
  // withdrawal rows was the link the pool exists to hide; the note is the user's receipt
  const keep = async (next: JobRecord) => {
    job = next;
    await s.depositJobs.put(job);
    input.onJob?.(job);
    return job;
  };
  const prover = await s.prover();
  const derived = await prover.note(formatNote(input.note));
  if (!derived.ok) throw new FlowRefused("the note is not readable");
  await keep(move(job, "READY_TO_REVIEW", now()));
  await keep(move(job, "AWAITING_AUTHORIZATION", now()));
  let screened: `0x${string}` | null;
  try {
    screened = await assertScreened(s);
  } catch (e) {
    return keep(move(job, "FAILED", now(), reasonOf(e, "the compliance check failed")));
  }
  let txHash: Hex;
  try {
    txHash = await s.wallet.sendDeposit(poolOf(pool), derived.commitment, { direct: input.direct ?? false, ...(screened ? { account: screened } : {}) });
  } catch (e) {
    return keep(move(job, "FAILED", now(), { failedReason: plainText(e instanceof Error ? e.message : "the wallet refused") }));
  }
  await keep(move(job, "SUBMITTING", now(), { txHash }));
  await keep(move(job, "SOURCE_CONFIRMING", now()));
  const rpc = receiptRpcOf(s);
  if (!rpc) return job; // nothing to read the receipt from: the record stays confirming until the history catches it
  try {
    const receipt = await waitForReceipt(rpc, txHash, s.receiptOptions);
    return keep(move(job, receipt.status === "success" ? "COMPLETED" : "FAILED", now(), receipt.status === "success" ? {} : { failedReason: REVERTED }));
  } catch {
    // a receipt that did not come in time is no failure (the tenth review round, C10-4): the transaction left the wallet and may still be
    // mined — "did not go through" had been said of deposits mined later, and a user told so throws the note away. The record waits;
    // History asks again
    return job;
  }
}

export interface WithdrawalInput {
  pool: PoolId;
  note: ClassicNote;
  facts: DepositFacts;
  recipient: Hex;
  via: "relayer" | "wallet";
  /** the relayer's id in the directory (relayer mode) */
  relayerId?: string;
  /** the fee offered to the relayer, wei (relayer mode) */
  feeWei?: bigint;
  /** the user's confirmation once the proof is ready, of the terms the proof pays (its own public signals); false cancels */
  confirm: (terms: ProofTerms) => Promise<boolean>;
  onStep?: (step: FlowStep) => void;
  onJob?: (job: JobRecord) => void;
}

/**
 * The withdrawal, and the prover's worker retired once the flow ends (the fifth review round, 2026-11-03): the witness — the note's
 * nullifier and secret among its 28,300 signals — had stayed in the prover worker's heap and its sub-workers' WebAssembly memory for
 * the page's lifetime. The retired worker answers what was sent to it, then ends; the next request starts a fresh worker, and the next
 * proof builds the prover again from the cached artifacts.
 */
export async function withdrawalFlow(s: ClassicServices, input: WithdrawalInput): Promise<JobRecord> {
  const history = s.histories.get(input.pool);
  // a history the last attempt refused for its roots syncs first, both endpoints asked: the retry's own root (stated: whenever the pool's roots
  // moved on since the page's last sync — a busy pool, a page left open — or during the flow)
  if (history?.needsSync()) await history.ensure().catch(() => undefined);
  // with a second endpoint, a relayed withdrawal holds its pool's history from syncing until it ends (the eleventh review round's critique of
  // C11-9): its own record writes re-run the statistics, whose sync of a stale history had asked the second endpoint the proof's root between
  // the Withdraw click and the submission. In wallet mode the second endpoint is told the note at the send anyway; with one endpoint, that one
  // is the user's trust
  const release = s.secondOpinion && input.via === "relayer" ? history?.hold() : undefined;
  let ended: JobRecord | undefined;
  try {
    ended = await withdrawalFlowInner(s, input);
    return ended;
  } finally {
    // one that ended before its relayer's outcome stays held IN_FLIGHT_HOLD_MS longer (the critique of the critique of C11-9): the relayer may
    // still publish it, and the statistics' sync right after the flow had asked the second endpoint its root first
    if (release && ended && inFlight(ended)) history?.holdFor(IN_FLIGHT_HOLD_MS);
    release?.();
    await s
      .prover()
      .then((p) => p.close?.())
      .catch(() => undefined);
  }
}

/** The withdrawal: path → proof (verified in the worker) → the root still known → confirm → relayer job or wallet transaction. */
async function withdrawalFlowInner(s: ClassicServices, input: WithdrawalInput): Promise<JobRecord> {
  const { pool, note, facts, recipient, via } = input;
  if (!isLive(s.config, pool, "withdraw")) throw new FlowRefused("withdrawals are not switched on for this pool");
  if (!s.rpc) throw new FlowRefused("no RPC endpoint is configured");
  // a recipient a withdrawal must not go to (the fourth review round, 2026-11-03): the zero and burn addresses lose it — the pool pays
  // with a plain call that succeeds at an address without code — and the pools' own contracts keep it, as do the contracts of the tokens
  // that take ETH (the tenth review round, C10-8); the screen refuses first
  if (refusedRecipient(recipient))
    throw new FlowRefused(
      "the recipient is the zero address, a burn address, a contract of the pools or a token's own contract: a withdrawal sent there is lost, so nothing is proved or sent",
    );
  const now = s.now;
  const history = s.histories.get(pool);
  if (!history) throw new FlowRefused("no history for this pool");
  const p = poolOf(pool);
  const relayer = via === "relayer" ? s.relayers.entry(input.relayerId ?? "") : null;
  if (via === "relayer" && (!relayer || relayer.status !== "online" || !relayer.facts)) throw new FlowRefused("the chosen relayer is not online");
  // the pool's facts (C2-6): the contract verified and an endpoint configured, or nothing is proved or sent
  await s.checkPool(pool);
  const poolFacts = factsOf(s, pool);
  if (!poolFacts.rpcConfigured || poolFacts.contract !== "verified")
    throw new FlowRefused("the pool is not ready for a withdrawal: its contract is not verified, or no RPC endpoint is configured");
  // the chosen relayer's status read again now (C2-7): the directory's was the page load's — one gone offline, or asking more
  // since, had refused the job after the proof
  if (via === "relayer") {
    await s.relayers.refreshOne(relayer!.id);
    if (relayer!.status !== "online" || !relayer!.facts) throw new FlowRefused("the chosen relayer is no longer online");
  }
  // the fee offered was priced when the screen read the gas price; the relayer judges it at its own, now (the review round of
  // 2026-11-02): below its minimum at the live price the job would be refused after the proof — refused here instead, with
  // both numbers, before anything is proved; the screen reads the fees again
  if (via === "relayer") {
    const fresh = await gasPriceWei(s.rpc);
    const minimum = relayerMinimumWei(p, relayer!.facts!, fresh);
    const offered = input.feeWei ?? 0n;
    if (offered < minimum)
      throw new FlowRefused(`the fee offered (${offered} wei) is below the relayer's minimum at the current gas price (${minimum} wei): review the fees again`);
  }
  // the relayer's account copied once, after its status was read again (the eleventh review round, C11-3): the directory's entry is refreshed in
  // place, and a proof made again after the confirmation had read another account from it
  const rewardAccount = via === "relayer" ? relayer!.facts!.rewardAccount : null;
  // the note's hashes before the record (C11-8): a prover that failed at them had left the record at PREPARING_PROOF for good. They come from the
  // worker (the main thread never loads the vendored arithmetic); the rest is the note's bytes
  const prover = await s.prover();
  const derived = await prover.note(formatNote(note));
  if (!derived.ok) throw new FlowRefused("the note is not readable");
  const jobId = id();
  let job = newJob(jobId, "withdrawal", pool, now(), { via, ...(relayer ? { relayerUrl: relayer.url } : {}) });
  const keep = async (next: JobRecord) => {
    job = next;
    await s.jobs.put(job);
    input.onJob?.(job);
    return job;
  };
  await keep(move(job, "READY_TO_REVIEW", now()));
  await keep(move(job, "PREPARING_PROOF", now()));

  // the proof over the current root; proved again once if the root aged out of the pool's window meanwhile
  const rpc = s.rpc;
  // with a second endpoint configured, the reads that name the note or the proof's root go to the first endpoint alone (the eleventh review
  // round's critique of C11-9 and C11-12): `rpc` fails over, and a first endpoint's HTTP 429 had the second told the proof's root and the
  // nullifier hash at the withdrawal's moment, or answer for the first and then agree with itself. One that does not answer refuses: nothing
  // is sent
  const named = s.secondOpinion ? (s.firstOpinion ?? rpc) : rpc;
  const silent = (what: "spent" | "root" | "history") =>
    new FlowRefused(
      `${s.secondOpinion ? "the first RPC endpoint" : "the RPC endpoint"} did not answer ${
        what === "spent"
          ? "whether this note is spent: nothing is sent"
          : what === "root"
            ? "whether the proof's root is known: nothing is sent"
            : "whether the history's root is still known: nothing is proved or sent"
      }; try again later`,
      s.secondOpinion
        ? what === "spent"
          ? "refusal.firstSilentSpent"
          : what === "root"
            ? "refusal.firstSilentRoot"
            : "refusal.firstSilentHistoryRoot"
        : what === "spent"
          ? "refusal.rpcSilentSpent"
          : what === "root"
            ? "refusal.rpcSilentRoot"
            : "refusal.rpcSilentHistoryRoot",
    );
  // spent on chain, as the pool says now (C2-10; spec §7.1, §7.4 "right before a withdrawal"): the history's events end twelve
  // blocks back, and a note spent since — another device, a relayer whose answer was lost — had cost, in wallet mode, the gas of a
  // reverting transaction. Read once the user confirmed, right before anything is sent (the tenth review round, C10-13): read before the
  // proof too, it had told the endpoint the nullifier hash of a withdrawal cancelled at its confirmation. Said under the Withdraw button
  // (withdraw.spentReadNotice); the history's Withdrawal events still refuse a note they show spent before any proof
  const assertUnspent = async (): Promise<void> => {
    const spent = await isSpentOnChain(named, p.address, derived.nullifierHash).catch(() => null);
    if (spent === null) throw silent("spent");
    if (spent) throw new FlowRefused("this note was already spent on chain: nothing is sent");
  };
  const prove = async (): Promise<{ proof: ProofResult; root: Hex }> => {
    await history.settled(); // never read in the middle of a sync
    if (!history.verified) throw new FlowRefused("the history is not verified");
    const path = await history.pathFor(facts.leafIndex);
    const feeWei = via === "relayer" ? (input.feeWei ?? 0n) : 0n;
    const relayerAddress = rewardAccount ?? ZERO_ADDRESS;
    const circuit: CircuitInput = {
      root: BigInt(path.root).toString(),
      nullifierHash: BigInt(derived.nullifierHash).toString(),
      recipient: BigInt(recipient).toString(),
      relayer: BigInt(relayerAddress).toString(),
      fee: feeWei.toString(),
      refund: "0",
      nullifier: leBigInt(note.nullifier).toString(),
      secret: leBigInt(note.secret).toString(),
      pathElements: path.pathElements.map((h) => BigInt(h).toString()),
      pathIndices: path.pathIndices.map(String),
    };
    input.onStep?.({ step: "proof" });
    const proof = await prover.prove(circuit, (progress) => input.onStep?.({ step: "proof", progress }));
    if (!proof.verified) throw new Error("the proof did not verify on the device");
    return { proof, root: path.root };
  };
  // the root a proof commits to must be one of the pool's last hundred (count-based, spec §7.4): checked after proving and
  // again right before anything is sent — a confirmation can take a while — proving again once on a fresh history each time
  const rootKnown = async (root: Hex, whose: "root" | "history" = "root"): Promise<boolean> => {
    const chain = await verifyAgainstChain(named, p.address, { root: BigInt(root), size: history.state!.leaves }).catch(() => null);
    if (!chain) throw silent(whose);
    return chain.known || chain.lastRoot === root;
  };
  // a root the pool no longer knows: a relayed withdrawal with a second endpoint is refused, never proved again on a refresh it made itself
  // (the critique of C11-9: that refresh asked the second endpoint the new root within one proof's time of the submission, and on the first
  // endpoint's word alone a lying first endpoint had its forged root submitted) — the history marked stale, the next attempt starting on a
  // history synced again with both endpoints. In wallet mode the second endpoint is told the note at the send anyway, and one endpoint is the
  // user's trust: the history is synced again and the proof made on it
  const renew = async (since: boolean): Promise<void> => {
    if (s.secondOpinion && via === "relayer") {
      history.markStale();
      throw since
        ? new FlowRefused(
            "the pool's last hundred roots moved on since the history was last synced: nothing is sent; start the withdrawal again",
            "refusal.rootsMovedSince",
          )
        : new FlowRefused(
            "the pool's last hundred roots moved on during the withdrawal: nothing is sent; start the withdrawal again",
            "refusal.rootsMovedDuring",
          );
    }
    // a history held for an unsettled relayed withdrawal is not synced again: the proof would be made twice on the same root (the critique)
    if (history.isHeld())
      throw new FlowRefused(
        "the pool's history is not synced again for a few minutes after a relayed withdrawal whose outcome is not known yet: nothing is sent; try again in a few minutes",
        "refusal.historyHeld",
      );
    await history.refresh();
  };
  const provedAndKnown = async (current?: { proof: ProofResult; root: Hex }): Promise<{ proof: ProofResult; root: Hex }> => {
    // the history's own root, before a proof is made on it (the critique: a page left open for hours had proved on a root that had aged out,
    // the proof wasted and the refusal blaming the flow); the first endpoint is told this root right after the proof anyway
    if (!current) {
      await history.settled();
      if (history.verified && !(await rootKnown(history.currentRoot()!, "history"))) await renew(true);
    }
    let proved = current ?? (await prove());
    // the re-proof's root is checked too (the fourth review round, 2026-11-03): one synced history and one more proof, then a refusal —
    // never a submission on a root the pool may not know (the relayer's, or in wallet mode the user's, gas on a revert)
    for (let again = 0; !(await rootKnown(proved.root)); again++) {
      if (again >= 1)
        throw new FlowRefused(
          "the proof's root is not among the pool's last hundred even after the history was synced and the proof made again: nothing is sent",
        );
      await renew(false);
      proved = await prove();
    }
    return proved;
  };
  let proved: { proof: ProofResult; root: Hex };
  try {
    proved = await provedAndKnown();
  } catch (e) {
    return keep(move(job, "FAILED", now(), reasonOf(e, "the proof failed")));
  }

  // the terms the confirmation restates are the proof's own (the tenth review round, C10-1): the page had shown the mode selected since,
  // and neither the recipient nor the relayer, while the fields stayed editable during the proof
  const termsOf = (p: { proof: ProofResult }): ProofTerms => {
    const [, , recipientArg, relayerArg, feeArg, refundArg] = p.proof.publicSignals.map((x) => BigInt(x));
    return {
      recipient: `0x${recipientArg.toString(16).padStart(40, "0")}`,
      relayer: `0x${relayerArg.toString(16).padStart(40, "0")}`,
      feeWei: feeArg,
      refundWei: refundArg,
    };
  };
  await keep(move(job, "AWAITING_AUTHORIZATION", now()));
  input.onStep?.({ step: "confirm" });
  const confirmed = termsOf(proved);
  if (!(await input.confirm(confirmed))) return keep(move(job, "CANCELLED", now()));

  try {
    proved = await provedAndKnown(proved);
  } catch (e) {
    return keep(move(job, "FAILED", now(), reasonOf(e, "the proof failed")));
  }
  // the proof sent is the one confirmed (C11-3): one made again after the confirmation pays the same recipient, relayer, fee and refund, or
  // nothing is sent; the relayer still online
  const sent = termsOf(proved);
  if (
    sent.recipient !== confirmed.recipient ||
    sent.relayer !== confirmed.relayer ||
    sent.feeWei !== confirmed.feeWei ||
    sent.refundWei !== confirmed.refundWei
  )
    return keep(move(job, "FAILED", now(), { failedReason: "the proof made again does not pay what was confirmed: nothing is sent" }));
  if (via === "relayer" && relayer!.status !== "online")
    return keep(move(job, "FAILED", now(), { failedReason: "the chosen relayer is no longer online: nothing is sent" }));

  // in wallet mode the account is screened before any read names the note's nullifier hash (the eleventh review round, C11-13), and the one
  // screened is the one that sends (C11-7)
  let screened: `0x${string}` | null = null;
  if (via === "wallet") {
    try {
      screened = await assertScreened(s);
    } catch (e) {
      return keep(move(job, "FAILED", now(), reasonOf(e, "the compliance check failed")));
    }
  }
  // once more right before anything is sent (C2-10): the confirmation can take a while
  try {
    await assertUnspent();
  } catch (e) {
    return keep(move(job, "FAILED", now(), reasonOf(e, "the note was spent")));
  }
  // the second endpoint's word on the proof's root (the tenth review round, C10-14) is taken at the history's own syncs, where the root and the
  // count single out no user, never at a relayed withdrawal's own moment (the eleventh review round, 2026-11-04, C11-9): asked here, seconds
  // before the submission, the root named the withdrawal and its recipient to that endpoint. The history is held while the flow runs and
  // IN_FLIGHT_HOLD_MS past an unsettled end (withdrawalFlow), save the retry's sync before its hold. A proof's root is its verified history's —
  // both endpoints agreed on it at its block; a relayed withdrawal whose root aged out is refused above, never proved again on one endpoint's word.
  // The note's keyed digest from here on (the critique of C11-1): written at the draft, it had stayed on a record whose page closed before
  // anything was sent; only a submitted withdrawal is settled from the pool's Withdrawal events — those from the history's block on
  await keep(
    move(
      job,
      "SUBMITTING",
      now(),
      relayer
        ? { noteDigest: noteDigestOf(jobId, derived.nullifierHash), fromBlock: history.state!.toBlock, relayerAccount: rewardAccount!.toLowerCase() }
        : {},
    ),
  );
  input.onStep?.({ step: "submitting" });
  const [root, nullifierHash, recipientArg, relayerArg, feeArg, refundArg] = proved.proof.publicSignals.map((x) => BigInt(x));
  const args = relayerArgs({
    root: `0x${root.toString(16).padStart(64, "0")}`,
    nullifierHash: `0x${nullifierHash.toString(16).padStart(64, "0")}`,
    recipient: `0x${recipientArg.toString(16).padStart(40, "0")}`,
    relayer: `0x${relayerArg.toString(16).padStart(40, "0")}`,
    feeWei: feeArg,
    refundWei: refundArg,
  });

  if (via === "relayer") {
    let relayerJobId: string;
    try {
      relayerJobId = (await submitWithdrawal(s.relayerTransport, relayer!.url, { proof: proved.proof.proof, contract: p.address, args })).id;
    } catch (e) {
      if (e instanceof RelayerRefusal) return keep(move(job, "FAILED", now(), { failedReason: plainText(`the relayer refused: ${e.message}`) }));
      // the answer did not arrive (the review round of 2026-11-03, C2-3): the relayer may have taken the job — FAILED had sent the
      // user to a second relayer or the wallet, where the second transaction reverted on the spent nullifier
      const lost = {
        ...job,
        state: "RECOVERY_REQUIRED" as const,
        updatedAt: now(),
        failedReason: `the relayer's answer did not arrive (${e instanceof Error ? e.message : "no answer"}): check on chain whether the withdrawal went through before trying again`,
      };
      await keep(lost);
      return lost;
    }
    await keep({ ...job, relayerJobId, updatedAt: now() });
    try {
      const final = await followJob(s.relayerTransport, relayer!.url, relayerJobId, {
        ...s.followOptions,
        onUpdate: (j) => {
          input.onStep?.({ step: "following", relayerState: j.status });
          const next = fromRelayerState(j.status);
          void keep({
            ...job,
            relayerState: j.status,
            txHash: (j.txHash as Hex | null) ?? job.txHash,
            updatedAt: now(),
            state: next === "COMPLETED" || next === "FAILED" ? job.state : next, // MINED → SOURCE_CONFIRMING, RESUBMITTED → RECOVERY_REQUIRED while followed (the fourth review round, 2026-11-03: every branch had read job.state)
          });
        },
      });
      let next = fromRelayerState(final.status);
      // the relayer's CONFIRMED is believed once the pool says the note is spent (the tenth review round, C10-3): a relayer that answered
      // CONFIRMED and sent nothing had the record read "Confirmed", and a user discards a note withdrawn. The read names the nullifier hash
      // this flow asked the same endpoint about right before the submission; History asks the history's Withdrawal events later
      // — and one that could not be asked says so (the critique: its silence had read as "not spent yet")
      let spentUnread = false;
      if (next === "COMPLETED") {
        const spent = await isSpentOnChain(named, p.address, derived.nullifierHash).catch(() => null);
        if (spent !== true) next = "SOURCE_CONFIRMING";
        spentUnread = spent === null;
      }
      // its FAILED too (the eleventh review round, C11-13): a note the pool reports spent did not fail — the outcome waits for a look on chain;
      // and a pool that could not be asked leaves it open too (the critique: read as unspent, the record had closed FAILED, its digest gone)
      if (next === "FAILED") {
        const spent = await isSpentOnChain(named, p.address, derived.nullifierHash).catch(() => null);
        if (spent !== false) next = "RECOVERY_REQUIRED";
        spentUnread = spent === null;
      }
      const done = closedRecord({
        ...job,
        relayerState: final.status,
        txHash: (final.txHash as Hex | null) ?? job.txHash,
        state: next,
        updatedAt: now(),
        ...(final.failedReason ? { failedReason: plainText(final.failedReason) } : {}),
        ...(spentUnread ? { spentUnread: true as const } : {}),
      });
      await keep(done);
      input.onStep?.({ step: "done", job: done });
      return done;
    } catch (e) {
      const stalled = {
        ...job,
        state: "RECOVERY_REQUIRED" as const,
        updatedAt: now(),
        failedReason: e instanceof Error ? e.message : "the relayer's job could not be followed",
      };
      await keep(stalled);
      return stalled;
    }
  }

  // a second endpoint's word before the user's own transaction (the fifth review round, 2026-11-03): one lying endpoint — fake deposits
  // in its logs, a root it calls known, a note it calls unspent — had the wallet send a withdraw that reverts (some 300,000 gas) and
  // publishes the nullifier hash beside the recipient. With two or more endpoints configured the second agreed on the history's root at its
  // sync and must agree on the spent bit here; with one, the endpoint is the user's trust, as the screen says
  if (s.secondOpinion) {
    const second = await isSpentOnChain(s.secondOpinion, p.address, derived.nullifierHash).catch(() => null);
    if (second !== false)
      return keep(
        move(job, "FAILED", now(), {
          ...(second === null
            ? {
                failedReason: "the second RPC endpoint did not answer whether this note is spent: nothing is sent; try again later",
                failedKey: "refusal.secondSilentSpent" as const,
              }
            : {
                failedReason: "the second RPC endpoint reports this note as spent: the endpoints disagree, so nothing is sent",
                failedKey: "refusal.secondSaysSpent" as const,
              }),
        }),
      );
  }
  // wallet mode: the pool's own withdraw from the connected account, screened above (C10-9, C11-13)
  let txHash: Hex;
  try {
    txHash = await s.wallet.sendWithdrawal(p, {
      ...(screened ? { account: screened } : {}),
      proof: proved.proof.proof,
      root: args[0],
      nullifierHash: args[1],
      recipient: args[2],
      relayer: args[3],
      feeWei: feeArg,
      refundWei: refundArg,
    });
  } catch (e) {
    return keep(move(job, "FAILED", now(), { failedReason: plainText(e instanceof Error ? e.message : "the wallet refused") }));
  }
  await keep(move(job, "SOURCE_CONFIRMING", now(), { txHash }));
  try {
    const receipt = await waitForReceipt(receiptRpcOf(s) ?? rpc, txHash, s.receiptOptions);
    const done = move(job, receipt.status === "success" ? "COMPLETED" : "FAILED", now(), receipt.status === "success" ? {} : { failedReason: REVERTED });
    await keep(done);
    input.onStep?.({ step: "done", job: done });
    return done;
  } catch (e) {
    return keep(move(job, "RECOVERY_REQUIRED", now(), { failedReason: e instanceof Error ? e.message : "the receipt never came" }));
  }
}
