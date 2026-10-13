// The wallet SDK's facade (doc §61; spec v2.0 §4, §8): the names a screen or a native shell calls, over the engine
// modules below them. It holds no state of its own — the session, the note store and the operation store are the
// engine's — and the platform configures it before the first call (configure(): its store, its prover, the endpoints;
// the web's is apps/web/src/config.ts). Every name of §61 is here; test/facade.test.ts pins the list.
import type { Address, Hex } from "viem";
import { deriveKeys } from "@privacy-wallet/protocol/keys";
import type { Note } from "@privacy-wallet/protocol/note";
import type { CircuitInputs } from "@privacy-wallet/protocol/txInputs";
import { txDomainOf, type Deployment } from "./chain";
import { prove, type ProofResult, type ProveStatus } from "./config";
import { diagnose, type Diagnosis } from "./operations/recovery";
import { getOperation as operationById } from "./operations/store";
import { ownNote, planWithdrawal, prepareShield, type FeeTerms, type PreparedShield, type TreeArg, type WithdrawalPlan } from "./privateTx";
import { swapService, type QuoteSet, type SwapRequest } from "./swapService";
import { noteStore, type NoteStore } from "./wallet/notes";
import type { OperationRecord } from "./wallet/operationRecord";
import { session, type WalletSession } from "./wallet/session";

export { config, configure, defaultConfig, isConfigured, type ProofResult, type Prover, type ProveStatus, type SdkConfig } from "./config";
export type { Deployment } from "./chain";
export type { Diagnosis } from "./operations/recovery";
export type { FeeTerms, PreparedShield, TreeArg, WithdrawalPlan } from "./privateTx";
export type { QuoteSet, SwapRequest } from "./swapService";
export type { OperationRecord } from "./wallet/operationRecord";
export type { WalletSession } from "./wallet/session";

/** The unlocked session's seed; every call that builds a note needs one. */
function seedOf(s: WalletSession): Uint8Array {
  const seed = s.state().seed;
  if (!seed) throw new Error("the wallet is locked");
  return seed;
}

/** Creates the wallet under a password: a fresh seed and its encrypted keystore. Resolves to the recovery phrase, shown once. */
export const createWallet = (password: string, s: WalletSession = session): Promise<string> => s.create(password);
/** Unlocks with the password; false when it is wrong (nothing changes). */
export const unlockWallet = (password: string, s: WalletSession = session): Promise<boolean> => s.unlock(password);
/** Locks: the seed and every in-memory secret leave memory; the encrypted keystore and journal stay. */
export const lockWallet = (s: WalletSession = session): void => s.lock();

/** The protected balance in one vault, in its base units: the unspent notes this wallet holds there. */
export const getProtectedBalance = (vault: Address | bigint, notes: NoteStore = noteStore): bigint => notes.balance(BigInt(vault));

/** A new note of this wallet for `amount` in `vault`: the counter allocated, the secret derived from the seed, the payload
 *  encrypted to the wallet itself. Not yet on chain — a deposit or a transaction's output puts it there. */
export function createNote(o: { vault: Address | bigint; amount: bigint }, s: WalletSession = session): { note: Note; noteData: Hex; counter: number } {
  return ownNote(deriveKeys(seedOf(s)), BigInt(o.vault), o.amount);
}

/** Protect: the deposit of `amount` into the protected balance — the note, its payload, the transactions the public
 *  wallet signs (an approval first for a token). */
export function prepareProtect(
  o: { deployment: Deployment; amount: bigint; token?: Address | null; vault?: Address },
  s: WalletSession = session,
): PreparedShield {
  return prepareShield({ ...o, masterSeed: seedOf(s) });
}

/** A private send to a public address: the spend plan over the synced tree — at most two notes in, the recipient's
 *  withdrawal, the change back to this wallet, the relayer's fee note when one submits it. Proven by generateProof. */
export function preparePrivateSend(
  o: { deployment: Deployment; tree: TreeArg; amount: bigint; recipient: Address; vault?: Address; fee?: FeeTerms },
  s: WalletSession = session,
): WithdrawalPlan {
  const vault = o.vault ?? o.deployment.ethVault;
  return planWithdrawal(seedOf(s), o.tree, BigInt(vault), o.amount, BigInt(o.recipient), txDomainOf(o.deployment), o.fee);
}

/** A same-chain swap's quotes: every route the service found, scored; the wallet checks the chosen one itself before signing. */
export async function prepareSwap(req: SwapRequest): Promise<QuoteSet> {
  if (req.from.chain !== req.to.chain) throw new Error("a swap to another chain: prepareCrossChainSwap");
  return swapService.quote(req);
}

/** A cross-chain swap's quotes (not atomic: each leg settles on its own chain). */
export async function prepareCrossChainSwap(req: SwapRequest): Promise<QuoteSet> {
  if (req.from.chain === req.to.chain) throw new Error("a swap on one chain: prepareSwap");
  return swapService.quote(req);
}

/** Proves a spend's circuit inputs with the platform's prover (the web: a Web Worker over snarkjs). */
export const generateProof = (inputs: CircuitInputs, onStatus?: ProveStatus): Promise<ProofResult> => prove(inputs, onStatus);

/** One operation's record (the journal's, or a draft's), or null. */
export const getOperation = (id: string, s: WalletSession = session): OperationRecord | null => operationById(id, s);

/** What an operation's recovery offers: its record, the catalog code, the class of its funds, the actions it allows now
 *  and the state of a recovery under way. Nothing is re-sent: an action is a new quote, a tracked resume or a refund. */
export function recoverOperation(id: string, s: WalletSession = session): (Diagnosis & { record: OperationRecord }) | null {
  const record = operationById(id, s);
  return record ? { record, ...diagnose(record) } : null;
}
