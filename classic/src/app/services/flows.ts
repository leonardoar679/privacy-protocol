// The two flows (spec v3.0 §7.5–§7.7; V7 Stage 9): a deposit — the note's commitment into the router (or the pool) from
// the connected wallet, the receipt awaited — and a withdrawal — the note looked up in the verified history, its path
// from the worker's tree, the proof in the worker and verified there, the user's confirmation, then the relayer's job
// followed to its end or the wallet-mode transaction awaited. Each step moves a record along the operation adapter's
// machine and is persisted at once (never a note, never a recipient). A flow refuses to start unless the pool function
// is switched live (CLASSIC_LIVE) — the screens never offer it otherwise, and this is the second lock.
import { isLive, type PoolId } from "../../config";
import type { Hex } from "../../history/events";
import { verifyAgainstChain } from "../../history/verify";
import { formatNote, leBigInt, type ClassicNote } from "../../model/notes";
import { poolOf } from "../../model/pools";
import type { DepositFacts } from "../../model/types";
import type { CircuitInput } from "../../prover/input";
import type { ProofResult, ProverProgress } from "../../prover/protocol";
import { followJob, submitWithdrawal, RelayerRefusal } from "../../relayer/client";
import { relayerArgs } from "../../wallet/calldata";
import { waitForReceipt } from "../../wallet/connection";
import { fromRelayerState, move, newJob, type JobRecord } from "./operations";
import type { ClassicServices } from "./source";

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

/** The deposit: commitment → wallet → receipt; the record moved and kept at every step. */
export async function depositFlow(s: ClassicServices, input: DepositInput): Promise<JobRecord> {
  const { pool } = input;
  if (!isLive(s.config, pool, "deposit")) throw new FlowRefused("deposits are not switched on for this pool");
  const now = s.now;
  let job = newJob(id(), "deposit", pool, now());
  const keep = async (next: JobRecord) => {
    job = next;
    await s.jobs.put(job);
    input.onJob?.(job);
    return job;
  };
  const prover = await s.prover();
  const derived = await prover.note(formatNote(input.note));
  if (!derived.ok) throw new FlowRefused("the note is not readable");
  await keep(move(job, "READY_TO_REVIEW", now()));
  await keep(move(job, "AWAITING_AUTHORIZATION", now()));
  let txHash: Hex;
  try {
    txHash = await s.wallet.sendDeposit(poolOf(pool), derived.commitment, { direct: input.direct ?? false });
  } catch (e) {
    return keep(move(job, "FAILED", now(), { failedReason: e instanceof Error ? e.message : "the wallet refused" }));
  }
  await keep(move(job, "SUBMITTING", now(), { txHash }));
  await keep(move(job, "SOURCE_CONFIRMING", now()));
  if (!s.rpc) return job; // no endpoint to read the receipt from: the record stays confirming until the history catches it
  try {
    const receipt = await waitForReceipt(s.rpc, txHash, s.receiptOptions);
    return keep(
      move(job, receipt.status === "success" ? "COMPLETED" : "FAILED", now(), receipt.status === "success" ? {} : { failedReason: "the transaction reverted" }),
    );
  } catch (e) {
    return keep(move(job, "FAILED", now(), { failedReason: e instanceof Error ? e.message : "the receipt never came" }));
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
  /** the user's confirmation once the proof is ready; false cancels */
  confirm: () => Promise<boolean>;
  onStep?: (step: FlowStep) => void;
  onJob?: (job: JobRecord) => void;
}

/** The withdrawal: path → proof (verified in the worker) → the root still known → confirm → relayer job or wallet transaction. */
export async function withdrawalFlow(s: ClassicServices, input: WithdrawalInput): Promise<JobRecord> {
  const { pool, note, facts, recipient, via } = input;
  if (!isLive(s.config, pool, "withdraw")) throw new FlowRefused("withdrawals are not switched on for this pool");
  if (!s.rpc) throw new FlowRefused("no RPC endpoint is configured");
  const now = s.now;
  const history = s.histories.get(pool);
  if (!history) throw new FlowRefused("no history for this pool");
  const p = poolOf(pool);
  const relayer = via === "relayer" ? s.relayers.entry(input.relayerId ?? "") : null;
  if (via === "relayer" && (!relayer || relayer.status !== "online" || !relayer.facts)) throw new FlowRefused("the chosen relayer is not online");
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
  const prove = async (): Promise<{ proof: ProofResult; root: Hex }> => {
    if (!history.verified) throw new FlowRefused("the history is not verified");
    const path = await history.pathFor(facts.leafIndex);
    const feeWei = via === "relayer" ? (input.feeWei ?? 0n) : 0n;
    const relayerAddress = via === "relayer" ? relayer!.facts!.rewardAccount : ZERO_ADDRESS;
    // the note's hashes come from the worker (the main thread never loads the vendored arithmetic); the rest is the note's bytes
    const derived = await prover.note(formatNote(note));
    if (!derived.ok) throw new FlowRefused("the note is not readable");
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
  let proved: { proof: ProofResult; root: Hex };
  try {
    proved = await prove();
    const chain = await verifyAgainstChain(s.rpc, p.address, { root: BigInt(proved.root), size: history.state!.leaves });
    if (!chain.known && chain.lastRoot !== proved.root) {
      await history.refresh();
      proved = await prove();
    }
  } catch (e) {
    return keep(move(job, "FAILED", now(), { failedReason: e instanceof Error ? e.message : "the proof failed" }));
  }

  await keep(move(job, "AWAITING_AUTHORIZATION", now()));
  input.onStep?.({ step: "confirm" });
  if (!(await input.confirm())) return keep(move(job, "CANCELLED", now()));

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
      return keep(
        move(job, "FAILED", now(), {
          failedReason: e instanceof RelayerRefusal ? `the relayer refused: ${e.message}` : e instanceof Error ? e.message : "the relayer did not answer",
        }),
      );
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
            state: next === "COMPLETED" || next === "FAILED" ? job.state : next === job.state ? job.state : job.state,
          });
        },
      });
      const next = fromRelayerState(final.status);
      const done = {
        ...job,
        relayerState: final.status,
        txHash: (final.txHash as Hex | null) ?? job.txHash,
        state: next,
        updatedAt: now(),
        ...(final.failedReason ? { failedReason: final.failedReason } : {}),
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
    return keep(move(job, "FAILED", now(), { failedReason: e instanceof Error ? e.message : "the wallet refused" }));
  }
  await keep(move(job, "SOURCE_CONFIRMING", now(), { txHash }));
  try {
    const receipt = await waitForReceipt(s.rpc, txHash, s.receiptOptions);
    const done = move(
      job,
      receipt.status === "success" ? "COMPLETED" : "FAILED",
      now(),
      receipt.status === "success" ? {} : { failedReason: "the transaction reverted" },
    );
    await keep(done);
    input.onStep?.({ step: "done", job: done });
    return done;
  } catch (e) {
    return keep(move(job, "RECOVERY_REQUIRED", now(), { failedReason: e instanceof Error ? e.message : "the receipt never came" }));
  }
}
