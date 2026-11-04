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
import type { CircuitInput } from "../../prover/input";
import type { ProofResult, ProverProgress } from "../../prover/protocol";
import { followJob, submitWithdrawal, RelayerRefusal } from "../../relayer/client";
import { relayerArgs } from "../../wallet/calldata";
import { waitForReceipt } from "../../wallet/connection";
import { isSanctioned } from "./compliance";
import { gasPriceWei } from "./gas";
import { fromRelayerState, move, newJob, type JobRecord } from "./operations";
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

export class FlowRefused extends Error {}

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
async function assertScreened(s: ClassicServices): Promise<void> {
  if (!s.config.complianceOracle) return;
  const account = s.wallet.account;
  if (!s.rpc || !account) throw new FlowRefused("the compliance check could not be made: nothing is sent");
  let listed: boolean;
  try {
    listed = await isSanctioned(s.rpc, account);
  } catch {
    throw new FlowRefused("the compliance check could not be completed: nothing is sent");
  }
  if (listed) throw new FlowRefused("this address cannot use the interface: nothing is sent");
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
  try {
    await assertScreened(s);
  } catch (e) {
    return keep(move(job, "FAILED", now(), { failedReason: e instanceof Error ? e.message : "the compliance check failed" }));
  }
  let txHash: Hex;
  try {
    txHash = await s.wallet.sendDeposit(poolOf(pool), derived.commitment, { direct: input.direct ?? false });
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
 * The withdrawal, and the prover closed once the record is terminal (the fifth review round, 2026-11-03): the witness — the note's
 * nullifier and secret among its 28,300 signals — had stayed in the prover worker's heap and its sub-workers' WebAssembly memory for
 * the page's lifetime. The next proof builds the prover again from the cached artifacts.
 */
export async function withdrawalFlow(s: ClassicServices, input: WithdrawalInput): Promise<JobRecord> {
  try {
    return await withdrawalFlowInner(s, input);
  } finally {
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
  let job = newJob(id(), "withdrawal", pool, now(), { via, ...(relayer ? { relayerUrl: relayer.url } : {}) });
  const keep = async (next: JobRecord) => {
    job = next;
    await s.jobs.put(job);
    input.onJob?.(job);
    return job;
  };
  await keep(move(job, "READY_TO_REVIEW", now()));
  await keep(move(job, "PREPARING_PROOF", now()));
  const prover = await s.prover();

  // the proof over the current root; proved again once if the root aged out of the pool's window meanwhile
  const rpc = s.rpc;
  // the note's hashes come from the worker (the main thread never loads the vendored arithmetic); the rest is the note's bytes
  const derived = await prover.note(formatNote(note));
  if (!derived.ok) throw new FlowRefused("the note is not readable");
  // spent on chain, as the pool says now (C2-10; spec §7.1, §7.4 "right before a withdrawal"): the history's events end twelve
  // blocks back, and a note spent since — another device, a relayer whose answer was lost — had cost, in wallet mode, the gas of a
  // reverting transaction. Read once the user confirmed, right before anything is sent (the tenth review round, C10-13): read before the
  // proof too, it had told the endpoint the nullifier hash of a withdrawal cancelled at its confirmation. Said under the Withdraw button
  // (withdraw.spentReadNotice); the history's Withdrawal events still refuse a note they show spent before any proof
  const assertUnspent = async (): Promise<void> => {
    if (await isSpentOnChain(rpc, p.address, derived.nullifierHash)) throw new FlowRefused("this note was already spent on chain: nothing is proved or sent");
  };
  const prove = async (): Promise<{ proof: ProofResult; root: Hex }> => {
    await history.settled(); // never read in the middle of a sync
    if (!history.verified) throw new FlowRefused("the history is not verified");
    const path = await history.pathFor(facts.leafIndex);
    const feeWei = via === "relayer" ? (input.feeWei ?? 0n) : 0n;
    const relayerAddress = via === "relayer" ? relayer!.facts!.rewardAccount : ZERO_ADDRESS;
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
  const rootKnown = async (root: Hex): Promise<boolean> => {
    const chain = await verifyAgainstChain(rpc, p.address, { root: BigInt(root), size: history.state!.leaves });
    return chain.known || chain.lastRoot === root;
  };
  const provedAndKnown = async (current?: { proof: ProofResult; root: Hex }): Promise<{ proof: ProofResult; root: Hex }> => {
    let proved = current ?? (await prove());
    // the re-proof's root is checked too (the fourth review round, 2026-11-03): one synced history and one more proof, then a refusal —
    // never a submission on a root the pool may not know (the relayer's, or in wallet mode the user's, gas on a revert)
    for (let again = 0; !(await rootKnown(proved.root)); again++) {
      if (again >= 1)
        throw new FlowRefused(
          "the proof's root is not among the pool's last hundred even after the history was synced and the proof made again: nothing is sent",
        );
      await history.refresh();
      proved = await prove();
    }
    return proved;
  };
  let proved: { proof: ProofResult; root: Hex };
  try {
    proved = await provedAndKnown();
  } catch (e) {
    return keep(move(job, "FAILED", now(), { failedReason: e instanceof Error ? e.message : "the proof failed" }));
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
  if (!(await input.confirm(termsOf(proved)))) return keep(move(job, "CANCELLED", now()));

  try {
    proved = await provedAndKnown(proved);
  } catch (e) {
    return keep(move(job, "FAILED", now(), { failedReason: e instanceof Error ? e.message : "the proof failed" }));
  }

  // once more right before anything is sent (C2-10): the confirmation can take a while
  try {
    await assertUnspent();
  } catch (e) {
    return keep(move(job, "FAILED", now(), { failedReason: e instanceof Error ? e.message : "the note was spent" }));
  }
  // a second endpoint's word on the proof's root before anything is sent, relayed or not (the tenth review round, C10-14): tornado-relayer
  // 4.x checks no root and no proof of its own and sends with a fixed gas limit, so a relayed proof on a root one lying endpoint invented
  // could be mined as a revert that publishes the nullifier hash beside the recipient — what the fifth round guarded in wallet mode only.
  // The root is the pool's, shared by everyone proving against it: asking a second endpoint about it tells that endpoint nothing of the note
  if (s.secondOpinion) {
    const other = await verifyAgainstChain(s.secondOpinion, p.address, { root: BigInt(proved.root), size: history.state!.leaves }).catch(() => null);
    if (!other || !(other.known || other.lastRoot === proved.root))
      return keep(
        move(job, "FAILED", now(), { failedReason: "the second RPC endpoint does not know the proof's root: the endpoints disagree, so nothing is sent" }),
      );
  }
  await keep(move(job, "SUBMITTING", now()));
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
      if (next === "COMPLETED" && !(await isSpentOnChain(rpc, p.address, derived.nullifierHash).catch(() => false))) next = "SOURCE_CONFIRMING";
      const done = {
        ...job,
        relayerState: final.status,
        txHash: (final.txHash as Hex | null) ?? job.txHash,
        state: next,
        updatedAt: now(),
        ...(final.failedReason ? { failedReason: plainText(final.failedReason) } : {}),
      };
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
  // publishes the nullifier hash beside the recipient. With two or more endpoints configured the second agreed on the root above and
  // must agree on the spent bit here; with one, the endpoint is the user's trust, as the screen says
  if (s.secondOpinion) {
    if (await isSpentOnChain(s.secondOpinion, p.address, derived.nullifierHash).catch(() => true))
      return keep(
        move(job, "FAILED", now(), {
          failedReason: "the second RPC endpoint reports this note as spent, or did not answer: the endpoints disagree, so nothing is sent",
        }),
      );
  }
  // the account the transaction leaves from, screened when the switch is on (C10-9)
  try {
    await assertScreened(s);
  } catch (e) {
    return keep(move(job, "FAILED", now(), { failedReason: e instanceof Error ? e.message : "the compliance check failed" }));
  }
  // wallet mode: the pool's own withdraw from the connected account
  let txHash: Hex;
  try {
    txHash = await s.wallet.sendWithdrawal(p, {
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
