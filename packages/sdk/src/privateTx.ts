// The wallet's money operations against the live core: a public shield (vault.deposit), a private
// transfer and a private withdrawal (PrivacyCore.transact with a locally generated proof), and note
// discovery from chain. Everything secret — the spending key, note secrets, the witness — stays in
// this tab: inputs are built here from the note store, the proof is made in the Web Worker
// (apps/web/src/prover), and the calldata goes either to a relayer (private submission, paid by a private
// fee note inside the transaction — the default) or to the injected wallet (public fallback).
// Payloads are the spec §12 envelope (packages/protocol/src/envelope.ts): our own notes are
// encrypted to our view key, a recipient's note to the view key inside their privacy address, the
// relayer's fee note to its privacy address, dummies are indistinguishable filler — so every note
// can be recovered from chain by rescanning (scanNotes).
import type { OnEvent } from "./operations/engineEvents";
import type { Address, Hex } from "viem";
import { deriveKeys, deriveNoteSecret, type WalletKeys } from "@privacy-wallet/protocol/keys";
import { encodeNote, noteBody, noteCommitment, ownerCommitmentOf, type Note } from "@privacy-wallet/protocol/note";
import { noteDataHash } from "@privacy-wallet/protocol/payload";
import { FIELD } from "@privacy-wallet/protocol/field";
import { selectInputs } from "@privacy-wallet/protocol/wallet/amounts";
import { mergeSchedule } from "./wallet/mergeSchedule";
import type { SpendNote, TxSpec } from "@privacy-wallet/protocol/txInputs";
import { dummyNoteData, encryptNoteData, viewKeyPair } from "@privacy-wallet/protocol/envelope";
import { decodePrivacyAddress, encodePrivacyAddress } from "@privacy-wallet/protocol/address";
import { nullifier } from "@privacy-wallet/protocol/nullifier";
import { MerkleLayers } from "@privacy-wallet/protocol/merkle";
import { openNotePayloads } from "./core";
import { assertOwnOwnerCommitment, depositOwnerCommitment, mainOwnerCommitment, NoOwnerKey, ownedOpening, ownerKeyOf } from "./keys/ownerKeys";
import { noteStore, type OwnedNote } from "./wallet/notes";
import { settings, type Submission } from "./wallet/settings";
import { prove, type ProveStatus } from "./config";
import { buildApprove, buildProtectERC20, buildProtectETH, buildShieldERC20, buildShieldNative, buildTransact, coreAbi, type TxRequest } from "./privacyProtocol";
import { PRIVACY_FEE_BPS, protectSplit } from "@privacy-wallet/protocol/wallet/fees";
import { clientFor, depositedLogsQuorum, minedTx, sendViaInjectedWallet, syncPoolQuorum, syncTreeQuorum, txDomainOf, type Deployment, type NoteInsertedLog } from "./chain";
import { hasRefundCandidates, matchCommittedDeposits, refundClaims, seedRefundClaims, usedCounters, type RecoveredRefund, type RefundClaim } from "./refunds";
import { session } from "./wallet/session";
import { feeInVault, isRefusal, pickRelayer, relayerFallbacks, relayerJobFor, relayerSubmit, type RelayerInfo } from "./relayer";
import { connectivity, whenOnline } from "@privacy-wallet/privacy-engine/transport/connectivity";
import { poolStats } from "./wallet/poolStats";
import { olderNotes, selectionOf } from "./wallet/privacyTiming";
import { provenSpent, TreeNotProven, verifyTree } from "./verifiedReads";
import { activityId, recordActivity, type ActivityRecord } from "./wallet/activity";
import { assetByVault } from "./assets";
import { guardDeployment } from "./deploymentGuard";
import { guardRecipient } from "./recipients";
import { readAllowance } from "./allowances";
import { activeProvider } from "@privacy-wallet/wallet-engine/injected";

/** The Activity line's asset fields for a vault (symbol + decimals; a vault the deployment does not name is shown by its address). */
/** V6 (spec v2.0 §3): the relayer's network charge F (its minimum with the wallet's margin) in the fee's asset, for the record's costs. */
function networkCharge(d: Deployment, terms: { info: RelayerInfo } | null, vault: Address): { amount: bigint; asset: string; decimals: number } | undefined {
  const amount = terms ? feeInVault(terms.info, vault) : null;
  const a = activityAsset(d, vault);
  return amount === null ? undefined : { amount, asset: a.asset, decimals: a.decimals };
}

const activityAsset = (d: Deployment, vault: Address | bigint): { asset: string; decimals: number } => {
  const a = assetByVault(d, vault);
  return a ? { asset: a.symbol, decimals: a.decimals } : { asset: `vault ${String(vault).slice(0, 10)}…`, decimals: 0 };
};

const toHex = (b: Uint8Array): Hex => ("0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")) as Hex;
const randomField = (): bigint => { const b = new Uint8Array(32); crypto.getRandomValues(b); return BigInt(toHex(b)) % FIELD; };
const hexToBytes = (h: Hex): Uint8Array => Uint8Array.from(h.slice(2).match(/../g)!.map((x) => parseInt(x, 16)));

/** A dummy output's payload (spec §5.5/§12): same shape as a real envelope, nothing inside. */
export const placeholderNoteData = (): Hex => toHex(dummyNoteData());

/** This wallet's privacy address (owner commitment + view public key, bech32m "pp1…"). */
export function privacyAddress(masterSeed: Uint8Array): string {
  const k = deriveKeys(masterSeed);
  return encodePrivacyAddress(ownerCommitmentOf(k.spendKey), viewKeyPair(k.viewKey).publicKey);
}

const encryptTo = (viewPub: Uint8Array, note: Note): Hex => toHex(encryptNoteData(viewPub, { amount: note.amount, noteSecret: note.noteSecret, vaultId: note.vaultId }));
const encryptForSelf = (keys: WalletKeys, note: Note): Hex => encryptTo(viewKeyPair(keys.viewKey).publicKey, note);

/** A new private output of this wallet (a change note): the next counter, the secret derived from the seed by it (a phrase
 *  restore finds the note), made out to the privacy address's owner commitment, which stays inside the output's body; the
 *  payload encrypted to the wallet's own view key. Never deposited: a deposit's note is depositNote's. */
export function ownNote(keys: WalletKeys, vaultId: bigint, amount: bigint): { note: Note; noteData: Hex; counter: number } {
  const counter = noteStore.allocateCounter();
  const note: Note = { vaultId, amount, ownerCommitment: ownerCommitmentOf(keys.spendKey), noteSecret: deriveNoteSecret(keys.noteKey, counter) };
  return { note, noteData: encryptForSelf(keys, note), counter };
}

/**
 * A new note of this wallet to deposit (the audit round of 2026-10-16, c18): ownNote's, made out to its own owner commitment
 * (keys.ts deriveOwnerKey, from its secret) rather than the privacy address's. A deposit publishes the owner commitment it
 * names, so every protect names a new one, linked to nothing else; the self-envelope finds it again after a restore.
 */
export function depositNote(keys: WalletKeys, vaultId: bigint, amount: bigint): { note: Note; noteData: Hex; counter: number } {
  const counter = noteStore.allocateCounter();
  const noteSecret = deriveNoteSecret(keys.noteKey, counter);
  const note: Note = { vaultId, amount, ownerCommitment: depositOwnerCommitment(keys, noteSecret), noteSecret };
  assertOwnOwnerCommitment(keys, note.ownerCommitment, "a deposit");
  return { note, noteData: encryptForSelf(keys, note), counter };
}

/** A dummy output (spec §5.5): random owner nobody holds, amount 0, random secret. */
const dummy = (vaultId: bigint): Note => ({ vaultId, amount: 0n, ownerCommitment: randomField(), noteSecret: randomField() });

/** A plan takes the synced tree (its layers: proofs are lookups) or bare leaves (the layers are then built while proving). */
export type TreeArg = bigint[] | MerkleLayers;
const treeSpec = (t: TreeArg): { leaves: bigint[]; tree?: MerkleLayers } => (t instanceof MerkleLayers ? { leaves: t.leaves, tree: t } : { leaves: t });

/** `record`: the Activity line this flow writes (whale spec §25) — fields to override, or `false` when the caller keeps its own line (a swap's funding). */
export interface Progress { onStatus?: ProveStatus; /** V5 (spec §12): the typed event beside every status string, for the operation record */ onEvent?: OnEvent; submission?: Submission; record?: false | Partial<ActivityRecord> }

/**
 * V5 (spec §17, the SDK facade): a shield in three steps. `prepareShield` builds the note and the calldata (and spends
 * one note counter); `submitShield` asks the connected wallet (an exact-amount approval first for an ERC-20), reports
 * the typed events beside the status strings, and `trackShield` waits for the receipt and journals the note at the
 * leaf the chain assigned. Shielding is a PUBLIC deposit (amount visible); privacy comes from later private transfers.
 */
/** `amount` is what the user puts in; `fee` the privacy fee ProtectRouter takes from it (0 without a router); the note holds the rest. */
export interface PreparedShield { deployment: Deployment; vault: Address; token: Address | null; amount: bigint; fee: bigint; note: Note; noteData: Hex; counter: number; approve?: TxRequest; deposit: TxRequest }

/**
 * The deposit of a protect (V6, spec v2.0 §3, §11.1): through the deployment's ProtectRouter — 1 % of `amount` to its fee
 * recipient, the note built for the rest, an ERC-20 approved to the router for exactly `amount` — or, for a deployment
 * that names no router, straight into the vault with no fee.
 */
function shieldTxs(deployment: Deployment, vault: Address, token: Address | null, gross: bigint, note: Note, noteData: Hex): { approve?: TxRequest; deposit: TxRequest } {
  const router = deployment.protectRouter;
  if (router) {
    const deposit = token ? buildProtectERC20(router, token, gross, note.amount, note.ownerCommitment, note.noteSecret, noteData) : buildProtectETH(router, note.ownerCommitment, note.noteSecret, gross, note.amount, noteData);
    return { ...(token ? { approve: buildApprove(token, router, gross) } : {}), deposit };
  }
  const deposit = token ? buildShieldERC20(vault, gross, note.ownerCommitment, note.noteSecret, noteData) : buildShieldNative(vault, note.ownerCommitment, note.noteSecret, gross, noteData);
  return { ...(token ? { approve: buildApprove(token, vault, gross) } : {}), deposit };
}

/** What a protect of `gross` keeps after the privacy fee: ProtectRouter's split, or everything without a router. */
export const protectNet = (deployment: Deployment, gross: bigint): { fee: bigint; net: bigint } => (deployment.protectRouter ? protectSplit(gross) : { fee: 0n, net: gross });

export function prepareShield(o: { masterSeed: Uint8Array; deployment: Deployment; amount: bigint; token?: Address | null; vault?: Address }): PreparedShield {
  const keys = deriveKeys(o.masterSeed);
  const vault = o.vault ?? o.deployment.ethVault;
  const token = o.token ?? null;
  const { fee, net } = protectNet(o.deployment, o.amount);
  if (net < 1n) throw new Error("This amount is too small to protect after fees.");
  const { note, noteData, counter } = depositNote(keys, BigInt(vault), net);
  return { deployment: o.deployment, vault, token, amount: o.amount, fee, note, noteData, counter, ...shieldTxs(o.deployment, vault, token, o.amount, note, noteData) };
}

/** The calldata of a shield with a scratch note (random, never journaled), for a gas estimate before anything is prepared: no counter is spent. */
export function scratchShieldTx(deployment: Deployment, amount: bigint, token: Address | null, vault: Address = deployment.ethVault): { approve?: TxRequest; deposit: TxRequest } {
  const note: Note = { vaultId: BigInt(vault), amount: protectNet(deployment, amount).net, ownerCommitment: randomField(), noteSecret: randomField() };
  const noteData = placeholderNoteData();
  return shieldTxs(deployment, vault, token, amount, note, noteData);
}

/** Wait for the deposit and journal the note at the leaf the chain assigned. */
export async function trackShield(p: PreparedShield, txHash: Hex): Promise<number> {
  return (await trackShieldCost(p, txHash)).leafIndex;
}

/** trackShield, with what the deposit really cost (V6, spec v2.0 §3). */
export async function trackShieldCost(p: PreparedShield, txHash: Hex): Promise<{ leafIndex: number; costWei: bigint }> {
  const { inserted, costWei } = await minedTx(clientFor(p.deployment), txHash);
  const mine = inserted.find((i) => i.commitment === noteCommitment(noteBody(p.note), BigInt(i.leafIndex)));
  if (!mine) throw new Error("the deposit was mined but its commitment was not found in the receipt");
  noteStore.add({ note: p.note, leafIndex: mine.leafIndex, noteData: p.noteData, counter: p.counter, spent: false, txHash, label: "shield", addedAt: Date.now() });
  return { leafIndex: mine.leafIndex, costWei };
}

/**
 * The approvals a protect sends before its deposit (a V6 follow-up of 2026-10-16), from the allowance the connected account
 * has open toward the spender (null when it cannot be read): none when it is exactly the amount (what a deposit that failed
 * or was refused left: a retry), approve(0) first when another amount is open — USDT and tokens like it refuse to change one
 * non-zero allowance to another — then approve(amount). Nothing is ever left approved beyond the amount the deposit pulls.
 */
export function approvalsFor(open: bigint | null, token: Address, spender: Address, amount: bigint): TxRequest[] {
  if (open === amount) return [];
  return [...(open !== null && open > 0n ? [buildApprove(token, spender, 0n)] : []), buildApprove(token, spender, amount)];
}

/** The connected account's allowance toward `spender`, read through its own provider; null when there is none to read. */
async function openAllowance(token: Address, spender: Address): Promise<bigint | null> {
  const eth = activeProvider();
  if (!eth) return null;
  try {
    const [owner] = (await eth.request({ method: "eth_accounts" })) as string[];
    return owner ? await readAllowance(token, owner as Address, spender, eth) : null;
  } catch {
    return null;
  }
}

export async function submitShield(p: PreparedShield, o: Progress & { /** V6: the network cost shown before signing */ estimatedWei?: bigint } = {}): Promise<{ approveTx?: Hex; txHash: Hex; leafIndex: number }> {
  // V6 Stage 15 (spec v2.0 §8): the wallet's prompts and the submission are a critical section for the auto-lock
  const release = session.hold("signature");
  try {
    return await submitShieldHeld(p, o);
  } finally {
    release();
  }
}
async function submitShieldHeld(p: PreparedShield, o: Progress & { estimatedWei?: bigint }): Promise<{ approveTx?: Hex; txHash: Hex; leafIndex: number }> {
  await guardDeployment(p.deployment); // V6 Stage 10 (doc §71): the deployment is checked before the first operation
  let approveTx: Hex | undefined;
  let approvalWei = 0n;
  // an ERC-20 is approved for exactly this amount, from what the connected account has open (a V6 follow-up of 2026-10-16):
  // a deposit that failed or was refused leaves its approval, and USDT refuses to change one non-zero allowance to another
  const spender = p.deployment.protectRouter ?? p.vault;
  const whom = p.deployment.protectRouter ? "the protect router" : "the vault";
  const approvals = p.approve && p.token ? approvalsFor(await openAllowance(p.token, spender), p.token, spender, p.amount) : [];
  const n = approvals.length + 1;
  for (const [k, tx] of approvals.entries()) {
    const clearing = approvals.length === 2 && k === 0;
    o.onStatus?.(`${k + 1}/${n} ${clearing ? `Clearing the earlier approval of ${whom}` : `Approving ${whom} for exactly this amount`} (connected wallet)…`);
    o.onEvent?.({ type: "wallet-prompt", step: "approve", i: k + 1, n, noteCounter: p.counter });
    const hash = await sendViaInjectedWallet(tx, p.deployment.chainId);
    const approval = await clientFor(p.deployment).waitForTransactionReceipt({ hash });
    if (approval.status !== "success") throw new Error(`the approval ${hash} reverted`);
    approvalWei += approval.gasUsed * (approval.effectiveGasPrice ?? 0n);
    if (!clearing) {
      approveTx = hash;
      o.onEvent?.({ type: "approved", txHash: hash });
    }
  }
  if (approvals.length) o.onStatus?.(`${n}/${n} Depositing into the vault (a shield is public by design)…`);
  else if (p.approve) o.onStatus?.(`The approval already open for exactly this amount is used; submitting the shield (a shield is public by design)…`);
  else o.onStatus?.("Submitting the shield through the connected wallet (a shield is public by design)…");
  o.onEvent?.({ type: "wallet-prompt", step: "deposit", i: n, n, noteCounter: p.counter });
  const txHash = await sendViaInjectedWallet(p.deposit, p.deployment.chainId);
  o.onEvent?.({ type: "submitted", txHash, by: "wallet" });
  o.onStatus?.("Waiting for the deposit to be mined…");
  o.onEvent?.({ type: "waiting-receipt", txHash });
  const { leafIndex, costWei } = await trackShieldCost(p, txHash);
  o.onEvent?.({ type: "costs", ...(o.estimatedWei !== undefined ? { estimatedWei: o.estimatedWei } : {}), actualWei: approvalWei + costWei });
  o.onEvent?.({ type: "mined", txHash, leafIndex });
  if (o.record !== false) recordActivity({ id: activityId("shield", txHash), kind: "shield", ...activityAsset(p.deployment, p.vault), amount: p.amount.toString(), status: "completed", ref: txHash, ...(o.record ?? {}) });
  return { ...(approveTx ? { approveTx } : {}), txHash, leafIndex };
}

/** Public shield of `amount` wei into the canonical ETH vault (prepare → submit → track). */
export async function shieldNative(o: { masterSeed: Uint8Array; deployment: Deployment; amount: bigint; estimatedWei?: bigint } & Progress): Promise<{ txHash: Hex; leafIndex: number }> {
  const r = await submitShield(prepareShield({ masterSeed: o.masterSeed, deployment: o.deployment, amount: o.amount }), o);
  return { txHash: r.txHash, leafIndex: r.leafIndex };
}

/**
 * Public shield of `amount` token units into the token's canonical ERC-20 vault (plan §36): an exact-amount
 * approve, then the vault's deposit (it pulls the tokens and inserts the note). Two transactions through the
 * connected wallet; the second waits for the first to be mined.
 */
export async function shieldERC20(o: { masterSeed: Uint8Array; deployment: Deployment; token: Address; vault: Address; amount: bigint; estimatedWei?: bigint } & Progress): Promise<{ approveTx?: Hex; txHash: Hex; leafIndex: number }> {
  const r = await submitShield(prepareShield({ masterSeed: o.masterSeed, deployment: o.deployment, amount: o.amount, token: o.token, vault: o.vault }), o);
  return { ...(r.approveTx ? { approveTx: r.approveTx } : {}), txHash: r.txHash, leafIndex: r.leafIndex }; // none when an open approval was used
}

/** Who gets the fee note (the relayer's privacy address), in which vault, and how much. */
export interface FeeTerms { ownerCommitment: bigint; viewPub: Uint8Array; amount: bigint; vault: bigint }
export interface FeeOutput { note: Note; outputIndex: 0 | 1 | 2 }
export interface WithdrawalPlan { spec: TxSpec; noteData: [Hex, Hex, Hex]; spent: OwnedNote[]; change?: { note: Note; noteData: Hex; counter: number }; fee?: FeeOutput }

/** The key that spends one of this wallet's notes (keys/ownerKeys.ts), or NoOwnerKey before anything is proved. */
function spendKeyOf(keys: WalletKeys, n: OwnedNote): bigint {
  const key = ownerKeyOf(keys, n.note);
  if (key === null) throw new NoOwnerKey(n.leafIndex);
  return key;
}

function pickInputs(keys: WalletKeys, vaultId: bigint, needed: bigint, from?: OwnedNote[]): { spent: OwnedNote[]; inputs: [SpendNote, SpendNote | null]; change: bigint } {
  // each note with the key that spends it (the audit round of 2026-10-16, c18): one this wallet's keys do not open is left
  // out of the choice, rather than failing every spend of the asset that picks it
  const main = mainOwnerCommitment(keys);
  const keyOf = new Map<number, bigint>();
  const mine = (from ?? noteStore.unspent(vaultId)).filter((n) => {
    const key = ownerKeyOf(keys, n.note, main);
    if (key !== null) keyOf.set(n.leafIndex, key);
    return key !== null;
  });
  const sel = selectInputs(mine.map((n) => ({ id: String(n.leafIndex), amount: n.note.amount })), needed);
  if (sel.merges.length) throw new Error("this amount needs a private merge of smaller notes first (ensureSpendable)");
  const spent = sel.inputs.map((i) => mine.find((n) => String(n.leafIndex) === i.id)!);
  const asSpend = (n: OwnedNote): SpendNote => ({ ...n.note, spendKey: keyOf.get(n.leafIndex)!, leafIndex: n.leafIndex });
  return { spent, inputs: [asSpend(spent[0]), spent[1] ? asSpend(spent[1]) : null], change: sel.change };
}

function changeNote(keys: WalletKeys, vaultId: bigint, amount: bigint): WithdrawalPlan["change"] {
  return amount > 0n ? ownNote(keys, vaultId, amount) : undefined;
}

const feeNote = (vaultId: bigint, fee: FeeTerms): Note => ({ vaultId, amount: fee.amount, ownerCommitment: fee.ownerCommitment, noteSecret: randomField() });

/**
 * Pick ≤ 2 of our notes (of `from` when given: "Delay for more privacy" spends older notes only), build the 2-in/3-out
 * spec: withdrawal to `recipient`, change back to us (encrypted to us), the relayer's fee note (encrypted to the relayer)
 * when submitting privately, dummies.
 */
export function planWithdrawal(masterSeed: Uint8Array, tree: TreeArg, vaultId: bigint, amount: bigint, recipient: bigint, domain: bigint, fee?: FeeTerms, from?: OwnedNote[]): WithdrawalPlan {
  const keys = deriveKeys(masterSeed);
  const { spent, inputs, change: changeAmount } = pickInputs(keys, vaultId, amount + (fee?.amount ?? 0n), from);
  const change = changeNote(keys, vaultId, changeAmount);
  const feeOut: FeeOutput | undefined = fee ? { note: feeNote(vaultId, fee), outputIndex: 1 } : undefined;
  const outputs: [Note, Note, Note] = [change?.note ?? dummy(vaultId), feeOut?.note ?? dummy(vaultId), dummy(vaultId)];
  const noteData: [Hex, Hex, Hex] = [change?.noteData ?? placeholderNoteData(), feeOut ? encryptTo(fee!.viewPub, feeOut.note) : placeholderNoteData(), placeholderNoteData()];
  const spec: TxSpec = { ...treeSpec(tree), inputs, outputs, withdrawal: { vault: vaultId, amount, recipient }, outDataHash: noteData.map((d) => noteDataHash(hexToBytes(d))) as [bigint, bigint, bigint], txDomain: domain };
  return { spec, noteData, spent, change, fee: feeOut };
}

/**
 * The relayer's terms for a vault of this deployment, or null when submitting through the connected wallet.
 * Rule 5: the configured relayer first, then the fallbacks (VITE_RELAYER_URLS); the first one that answers,
 * serves this chain / core and takes fees in this vault is used, and the fee note is built for it.
 */
export async function feeTerms(deployment: Deployment, submission: Submission, vault: Address, fallbacks: string[] = relayerFallbacks(), opts: { /** V6 (spec v2.0 §3): a withdrawal's public amount W, for the percentage fee */ delivered?: bigint } = {}): Promise<{ url: string; info: RelayerInfo; fee: FeeTerms } | null> {
  if (submission.kind !== "relayer") return null;
  const candidates = [submission.url, ...fallbacks];
  const errors: string[] = [];
  for (const url of candidates) {
    const picked = await pickRelayer([url], { chainId: deployment.chainId, core: deployment.core });
    if (!picked) { errors.push(`${url}: unreachable or another chain / core`); continue; }
    // a relayer asking more than the 1 % privacy fee is not used (the audit round of 2026-10-16, c46): its terms were paid whatever they said
    const bps = picked.info.feePercentBps ?? 0;
    if (!Number.isInteger(bps) || bps < 0 || bps > PRIVACY_FEE_BPS) { errors.push(`${url}: asks ${bps} bps, above the ${PRIVACY_FEE_BPS / 100} % privacy fee`); continue; }
    const amount = feeInVault(picked.info, vault, undefined, opts.delivered);
    if (amount === null) { errors.push(`${url}: takes no fees in vault ${vault}`); continue; }
    const addr = decodePrivacyAddress(picked.info.privacyAddress);
    return { url: picked.url, info: picked.info, fee: { ownerCommitment: addr.ownerCommitment, viewPub: addr.viewPub, amount, vault: BigInt(vault) } };
  }
  throw new Error(`no relayer available for this asset (${errors.join("; ")}); switch submission to the connected wallet (public) or add a relayer`);
}

export interface Submitted { txHash: Hex; proofMs: number; verifiedLocally: boolean; change?: OwnedNote; spent: number[]; submittedBy: "relayer" | "wallet"; feeWei?: bigint; extraLeaf?: number }

/**
 * Thrown before anything is proved or sent (the audit round of 2026-10-16, c46): the relayer's fee for this spend is now more
 * than the one the Review showed. The fee is read again at submit; it had been paid whatever it had become.
 */
export class FeeMoved extends Error {
  readonly code = "fee_moved";
  constructor(readonly shown: bigint, readonly now: bigint) {
    super(`the relayer's fee moved from ${shown} to ${now} since the Review: nothing was sent`);
    this.name = "FeeMoved";
  }
}

/** The fee this spend would pay, refused above the one the Review showed (`maxFee`, in the vault's base units). */
function boundFee(terms: { fee: FeeTerms } | null, maxFee: bigint | undefined): void {
  const fee = terms?.fee.amount ?? 0n;
  if (maxFee !== undefined && fee > maxFee) throw new FeeMoved(maxFee, fee);
}

/** V6 Stage 15 (spec v2.0 §8): proving and the submission are a critical section for the auto-lock. */
async function submitAndRecord(o: Parameters<typeof submitAndRecordHeld>[0]): Promise<Submitted> {
  const release = session.hold("spend");
  try {
    return await submitAndRecordHeld(o);
  } finally {
    release();
  }
}
async function submitAndRecordHeld(o: { deployment: Deployment; spec: TxSpec; noteData: [Hex, Hex, Hex]; spent: OwnedNote[]; change?: WithdrawalPlan["change"]; fee?: FeeOutput; extra?: Note; submission: Submission; relayerUrl?: string; /** V6: the relayer's network charge (its F) in the fee's asset */ network?: { amount: bigint; asset: string; decimals: number } } & Progress): Promise<Submitted> {
  const client = clientFor(o.deployment);
  o.onEvent?.({ type: "proving" });
  // V6 Stage 15 (spec v2.0 §14.3): the plan goes to the prover, which builds the circuit inputs where it proves (the
  // crypto worker on the web) — and throws, as the builder always did, when a note does not open its leaf or the value
  // is not conserved
  const proof = await prove(o.spec, o.onStatus);
  o.onEvent?.({ type: "proved", ms: proof.ms, verifiedLocally: proof.verifiedLocally });
  let txHash: Hex;
  let submittedBy: Submitted["submittedBy"];
  if (o.submission.kind === "relayer") {
    if (!o.fee) throw new Error("relayer submission needs a fee output");
    o.onStatus?.(`Proof ready in ${(proof.ms / 1000).toFixed(1)} s; handing it to the relayer (your address never touches the chain)…`);
    const url = o.relayerUrl ?? o.submission.url;
    const nullifiers: [bigint, bigint] = [proof.publicInputs.nullifier0, proof.publicInputs.nullifier1];
    o.onEvent?.({ type: "submitting", by: "relayer", nullifiers: [nullifiers[0].toString(), nullifiers[1].toString()], relayerUrl: url, ...(o.change ? { noteCounter: o.change.counter } : {}) });
    const body = { proof: proof.proof, publicInputs: proof.publicSignals.map(String), noteData: o.noteData, fee: { outputIndex: o.fee.outputIndex, amount: o.fee.note.amount.toString(), noteSecret: o.fee.note.noteSecret.toString(), vault: ("0x" + o.fee.note.vaultId.toString(16).padStart(40, "0")) as Address } };
    let r: { txHash: Hex } | undefined;
    // V6 Stage 15 (doc §75): nothing is submitted while offline; an attempt the network swallowed may have reached the
    // relayer, so once back the state is verified — the relayer's job for these nullifiers — before anything is resent
    let unanswered = false;
    for (let attempt = 1; ; attempt++) {
      await whenOnline();
      try { r = await relayerSubmit(url, body); break; }
      catch (e) {
        if (isRefusal(e)) {
          // after a lost answer the relayer refuses the same spend again (in flight, or already mined): its job is the answer
          if (unanswered) {
            const known = await relayerJobFor(url, nullifiers).catch(() => null);
            if (known) { r = known; break; }
          }
          throw e;
        }
        unanswered = true;
        if (!connectivity.get().online) { attempt--; continue; } // offline: wait for the connection, the attempt does not count
        if (attempt >= 3) throw e;
        o.onStatus?.(`Relayer unreachable (attempt ${attempt}); retrying…`); o.onEvent?.({ type: "relayer-retry", attempt }); await new Promise((res) => setTimeout(res, 1500 * attempt));
      }
    }
    txHash = r!.txHash;
    submittedBy = "relayer";
    o.onEvent?.({ type: "submitted", txHash, by: "relayer" });
  } else {
    o.onStatus?.(`Proof ready in ${(proof.ms / 1000).toFixed(1)} s; submitting through the connected wallet (public: the transaction is sent from your address)…`);
    o.onEvent?.({ type: "submitting", by: "wallet", nullifiers: [proof.publicInputs.nullifier0.toString(), proof.publicInputs.nullifier1.toString()], ...(o.change ? { noteCounter: o.change.counter } : {}) });
    o.onEvent?.({ type: "wallet-prompt", step: "transact", i: 1, n: 1 });
    txHash = await sendViaInjectedWallet(buildTransact(o.deployment.core, { proof: proof.proof, publicInputs: proof.publicInputs }, o.noteData), o.deployment.chainId);
    submittedBy = "wallet";
    o.onEvent?.({ type: "submitted", txHash, by: "wallet" });
  }
  o.onStatus?.("Waiting for the transaction to be mined…");
  o.onEvent?.({ type: "waiting-receipt", txHash });
  const { inserted, costWei } = await minedTx(client, txHash);
  noteStore.markSpent(o.spent.map((n) => n.leafIndex));
  const find = (n: Note) => inserted.find((i) => i.commitment === noteCommitment(noteBody(n), BigInt(i.leafIndex)));
  let change: OwnedNote | undefined;
  if (o.change) {
    const hit = find(o.change.note);
    if (!hit) throw new Error("mined, but the change note's commitment was not found in the receipt");
    change = { note: o.change.note, leafIndex: hit.leafIndex, noteData: o.change.noteData, counter: o.change.counter, spent: false, txHash, label: "change" };
    noteStore.add({ ...change, addedAt: Date.now() });
  }
  let extraLeaf: number | undefined;
  if (o.extra) {
    const hit = find(o.extra);
    if (!hit) throw new Error("mined, but the recipient's note commitment was not found in the receipt");
    extraLeaf = hit.leafIndex;
  }
  // V6 (spec v2.0 §3): the real cost beside what the relayer charged for it (its F; for the ETH vault also the estimate shown)
  const charged = submittedBy === "relayer" ? o.network : undefined;
  o.onEvent?.({ type: "costs", actualWei: costWei, ...(charged ? { charged, ...(charged.asset === "ETH" && charged.decimals === 18 ? { estimatedWei: charged.amount } : {}) } : {}) });
  // V5 (spec §12): the record's COMPLETED needs the settlement reference — the mined transaction and the leaf of the note it left (the recipient's, else the change)
  o.onEvent?.({ type: "mined", txHash, ...(extraLeaf !== undefined ? { leafIndex: extraLeaf } : change ? { leafIndex: change.leafIndex } : {}) });
  return { txHash, proofMs: proof.ms, verifiedLocally: proof.verifiedLocally, change, spent: o.spent.map((n) => n.leafIndex), submittedBy, feeWei: o.fee?.note.amount, extraLeaf };
}

/**
 * Private withdrawal of `amount` wei to `recipient` (a fresh public address or a swap-order escrow):
 * sync the tree → plan (with the relayer's fee note when submitting privately) → prove in the
 * worker → submit → record the change note with the leaf index the chain assigned.
 */
/**
 * "Delay for more privacy" (spec v2.0 §14.1): the notes as old as the Review showed — each with its own timing at most
 * `maxTiming` — no longer cover the funding. Thrown before anything is sent: the order is stopped, never funded from younger notes.
 */
export class OlderNotesUnavailable extends Error {
  readonly code = "older_notes_unavailable";
  constructor(readonly maxTiming: number) {
    super(`The notes old enough for this funding (each timing at most ${maxTiming}) no longer cover it; nothing was sent.`);
    this.name = "OlderNotesUnavailable";
  }
}

/** The older notes a funding held to `maxTiming` may spend; throws `OlderNotesUnavailable` when they do not cover `needed` at once. */
function olderInputs(vault: Address, maxTiming: number, needed: bigint): OwnedNote[] {
  const notes = olderNotes(BigInt(vault), maxTiming);
  if (!Array.isArray(selectionOf(notes, needed))) throw new OlderNotesUnavailable(maxTiming);
  return notes;
}

// ---- one private spend at a time (a V6 follow-up of 2026-10-14). A spend's inputs are marked spent only once its
// transaction is mined, so two spends planned at once — a Send started while a confirmed swap funds its escrow, a
// housekeeping step — picked the same notes, and the second failed on the nullifier the first had just spent. Every
// spend entry point now takes its turn: the second waits for the first to be recorded, then plans from the notes as
// they are, the first's change note included. The merges a spend needs first run inside their caller's turn. One
// unlocked tab at a time (apps/web/src/platform/activeTab.ts) keeps it to this tab.
let spendTail: Promise<void> = Promise.resolve();
let spendBusy = false;
/** Runs `fn` when no other private spend of this tab is under way; a failed spend never blocks the next. */
function inTurn<T>(o: { onStatus?: (line: string) => void }, fn: () => Promise<T>): Promise<T> {
  if (spendBusy) o.onStatus?.("Waiting for the other private operation to finish…");
  const run = spendTail.then(async () => {
    spendBusy = true;
    try {
      return await fn();
    } finally {
      spendBusy = false;
    }
  });
  spendTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export const privateWithdrawal = (o: Parameters<typeof privateWithdrawalInTurn>[0]): Promise<Submitted> => inTurn(o, () => privateWithdrawalInTurn(o));
export const privateTransfer = (o: Parameters<typeof privateTransferInTurn>[0]): ReturnType<typeof privateTransferInTurn> => inTurn(o, () => privateTransferInTurn(o));
/** Perform one merge on chain (private self-transfer) and record the merged note. */
export const mergeNotes = (o: Parameters<typeof mergeNotesInTurn>[0]): ReturnType<typeof mergeNotesInTurn> => inTurn(o, () => mergeNotesInTurn(o));
/** Merge until two notes cover `needed` (+ the fee of each merge and of the final spend). Returns the number of merges performed. */
export const ensureSpendable = (o: Parameters<typeof ensureSpendableInTurn>[0]): Promise<number> => inTurn(o, () => ensureSpendableInTurn(o));
/** Perform one split on chain (private self-transfer) and record both notes. */
export const splitNote = (o: Parameters<typeof splitNoteInTurn>[0]): ReturnType<typeof splitNoteInTurn> => inTurn(o, () => splitNoteInTurn(o));

async function privateWithdrawalInTurn(o: { masterSeed: Uint8Array; deployment: Deployment; amount: bigint; recipient: Address; vault?: Address; maxTiming?: number; /** the relayer's fee the Review showed: a higher one stops the spend (FeeMoved) */ maxFee?: bigint } & Progress): Promise<Submitted> {
  await guardDeployment(o.deployment);
  // a V6 follow-up of 2026-10-16: never to an address that loses what it receives (the zero or a burn address, a contract of
  // this deployment or of one of its tokens) — refused before anything is proved or sent
  guardRecipient(o.deployment, o.recipient);
  const submission = o.submission ?? settings.get().submission;
  const vault = o.vault ?? o.deployment.ethVault;
  o.onEvent?.({ type: "fee-terms" });
  const terms = await feeTerms(o.deployment, submission, vault, undefined, { delivered: o.amount });
  boundFee(terms, o.maxFee);
  const needed = o.amount + (terms?.fee.amount ?? 0n);
  // older notes only: checked before any merge (a merge would make a new note), and again on the synced pool's numbers
  if (o.maxTiming !== undefined) olderInputs(vault, o.maxTiming, needed);
  await ensureSpendableInTurn({ ...o, submission, vault, needed: o.amount });
  o.onStatus?.("Syncing the shielded tree from the core's events…");
  o.onEvent?.({ type: "syncing" });
  const tree = await syncTreeQuorum(o.deployment);
  o.onEvent?.({ type: "verifying" });
  await verifyTree(o.deployment, tree, o.onStatus); // plan §38: the tree must contain the pool proven at the latest finalized block
  poolStats.set({ notes: tree.notes, leaves: tree.nextLeafIndex });
  const from = o.maxTiming !== undefined ? olderInputs(vault, o.maxTiming, needed) : undefined;
  const plan = planWithdrawal(o.masterSeed, tree.layers, BigInt(vault), o.amount, BigInt(o.recipient), txDomainOf(o.deployment), terms?.fee, from);
  const r = await submitAndRecord({ ...o, submission, relayerUrl: terms?.url, network: networkCharge(o.deployment, terms, vault), spec: plan.spec, noteData: plan.noteData, spent: plan.spent, change: plan.change, fee: plan.fee });
  if (o.record !== false) recordActivity({ id: activityId("withdraw", r.txHash), kind: "withdraw", ...activityAsset(o.deployment, vault), amount: o.amount.toString(), status: "completed", ref: r.txHash, note: `to ${o.recipient}`, ...(o.record ?? {}) });
  return r;
}

// ---- merges: the 2-input circuit spends at most two notes; a spend that needs more first merges
// pairs of notes into one with private self-transfers (nothing public but a transaction), each paying
// the relayer fee when submitting privately. selectInputs() names the pairs; fees shrink the merged
// note, so the schedule is re-planned after every merge.
export interface MergePlan { spec: TxSpec; noteData: [Hex, Hex, Hex]; spent: OwnedNote[]; merged: { note: Note; noteData: Hex; counter: number }; fee?: FeeOutput }

/** Merge two of our notes into one (minus the fee note when there is one). Pure. */
export function planMerge(masterSeed: Uint8Array, tree: TreeArg, vaultId: bigint, a: OwnedNote, b: OwnedNote, domain: bigint, fee?: FeeTerms): MergePlan {
  const keys = deriveKeys(masterSeed);
  const total = a.note.amount + b.note.amount - (fee?.amount ?? 0n);
  if (total <= 0n) throw new Error("the notes do not even cover the relayer fee");
  const asSpend = (n: OwnedNote): SpendNote => ({ ...n.note, spendKey: spendKeyOf(keys, n), leafIndex: n.leafIndex });
  const counter = noteStore.allocateCounter();
  const mergedNote: Note = { vaultId, amount: total, ownerCommitment: ownerCommitmentOf(keys.spendKey), noteSecret: deriveNoteSecret(keys.noteKey, counter) };
  const merged = { note: mergedNote, noteData: encryptForSelf(keys, mergedNote), counter };
  const feeOut: FeeOutput | undefined = fee ? { note: feeNote(vaultId, fee), outputIndex: 1 } : undefined;
  const noteData: [Hex, Hex, Hex] = [merged.noteData, feeOut ? encryptTo(fee!.viewPub, feeOut.note) : placeholderNoteData(), placeholderNoteData()];
  const spec: TxSpec = {
    ...treeSpec(tree), inputs: [asSpend(a), asSpend(b)], outputs: [mergedNote, feeOut?.note ?? dummy(vaultId), dummy(vaultId)],
    withdrawal: null, outDataHash: noteData.map((d) => noteDataHash(hexToBytes(d))) as [bigint, bigint, bigint], txDomain: domain,
  };
  return { spec, noteData, spent: [a, b], merged, fee: feeOut };
}

/**
 * The pairs to merge (largest first, as selectInputs orders them) so that ≤ 2 notes cover `needed`, fees included.
 * Pure; ok=false when the balance cannot get there, with the reason: the balance (fees included) is short, or the
 * spend needs more merges than one go does (`too-many-merges`: the balance is there, spread over too many notes).
 */
// V6 Stage 16: the merge schedule is pure and lives in ./wallet/mergeSchedule.ts (the campaigns store reads it without this module)
export { mergeSchedule } from "./wallet/mergeSchedule";

/** The balance is there but spread over too many notes for one spend (plan V2 §73): housekeeping consolidates it. */
export class HousekeepingNeeded extends Error {
  constructor(readonly notes: number, readonly merges: number, symbol: string) {
    super(`Your ${symbol} balance is spread over ${notes} notes; this spend needs more than ${merges} merges and the wallet does at most ${merges} in one go. Private balance maintenance consolidates them (Settings), or send a smaller amount now.`);
  }
}

/** Perform one merge on chain (private self-transfer) and record the merged note. */
async function mergeNotesInTurn(o: { masterSeed: Uint8Array; deployment: Deployment; a: OwnedNote; b: OwnedNote } & Progress): Promise<Submitted & { merged: OwnedNote }> {
  await guardDeployment(o.deployment);
  const submission = o.submission ?? settings.get().submission;
  const vaultId = o.a.note.vaultId;
  if (o.b.note.vaultId !== vaultId) throw new Error("cannot merge notes of different assets");
  const vault = ("0x" + vaultId.toString(16).padStart(40, "0")) as Address;
  const terms = await feeTerms(o.deployment, submission, vault);
  o.onStatus?.(`Merging two notes (${o.a.leafIndex} + ${o.b.leafIndex}) privately…`);
  const tree = await syncTreeQuorum(o.deployment);
  o.onEvent?.({ type: "verifying" });
  await verifyTree(o.deployment, tree, o.onStatus); // plan §38: the tree must contain the pool proven at the latest finalized block
  poolStats.set({ notes: tree.notes, leaves: tree.nextLeafIndex });
  const plan = planMerge(o.masterSeed, tree.layers, vaultId, o.a, o.b, txDomainOf(o.deployment), terms?.fee);
  const r = await submitAndRecord({ ...o, submission, relayerUrl: terms?.url, spec: plan.spec, noteData: plan.noteData, spent: plan.spent, fee: plan.fee, extra: plan.merged.note });
  const merged: OwnedNote = { note: plan.merged.note, leafIndex: r.extraLeaf!, noteData: plan.merged.noteData, counter: plan.merged.counter, spent: false, txHash: r.txHash, label: "merged" };
  noteStore.add({ ...merged, addedAt: Date.now() });
  recordActivity({ id: activityId("housekeeping", r.txHash), kind: "housekeeping", ...activityAsset(o.deployment, vaultId), amount: merged.note.amount.toString(), status: "completed", ref: r.txHash, note: "two notes merged privately before a spend" });
  return { ...r, merged };
}

/** Merge until two notes cover `needed` (+ the fee of each merge and of the final spend). Returns the number of merges performed. */
async function ensureSpendableInTurn(o: { masterSeed: Uint8Array; deployment: Deployment; needed: bigint; vault?: Address } & Progress): Promise<number> {
  const submission = o.submission ?? settings.get().submission;
  const vault = o.vault ?? o.deployment.ethVault;
  const vaultId = BigInt(vault);
  const terms = await feeTerms(o.deployment, submission, vault);
  const feePerTx = terms?.fee.amount ?? 0n;
  let done = 0;
  for (;;) {
    const notes = noteStore.unspent(vaultId).map((n) => ({ id: String(n.leafIndex), amount: n.note.amount }));
    const sched = mergeSchedule(notes, o.needed + feePerTx, feePerTx);
    if (!sched.ok && sched.reason === "too-many-merges") throw new HousekeepingNeeded(notes.length, 8, assetByVault(o.deployment, vault)?.symbol ?? "private");
    if (!sched.ok) throw new Error("insufficient shielded balance for the amount plus the relayer fees of the merges it needs");
    if (!sched.pairs.length) return done;
    const [ia, ib] = sched.pairs[0];
    const a = noteStore.unspent(vaultId).find((n) => String(n.leafIndex) === ia)!, b = noteStore.unspent(vaultId).find((n) => String(n.leafIndex) === ib)!;
    o.onStatus?.(`${sched.pairs.length} merge(s) needed before this spend; merging notes ${a.leafIndex} + ${b.leafIndex}…`);
    o.onEvent?.({ type: "merging", i: done + 1, n: done + sched.pairs.length });
    await mergeNotesInTurn({ ...o, a, b, submission });
    done++;
  }
}

// ---- splits (plan V2 §73–§74, housekeeping): one note of ours into two of ours — a common-sized piece and
// the rest — with a private self-transfer (1-in/3-out: piece, rest, the relayer's fee note or a dummy).
export interface SplitPlan { spec: TxSpec; noteData: [Hex, Hex, Hex]; spent: OwnedNote[]; piece: { note: Note; noteData: Hex; counter: number }; rest: { note: Note; noteData: Hex; counter: number }; fee?: FeeOutput }

/** Split `note` into `piece` and the rest (minus the fee). Pure. */
export function planSplit(masterSeed: Uint8Array, tree: TreeArg, note: OwnedNote, piece: bigint, domain: bigint, fee?: FeeTerms): SplitPlan {
  const keys = deriveKeys(masterSeed);
  const vaultId = note.note.vaultId;
  const restAmount = note.note.amount - piece - (fee?.amount ?? 0n);
  if (piece <= 0n || restAmount <= 0n) throw new Error("the note does not cover the piece, the rest and the fee");
  const mk = (amount: bigint) => { const counter = noteStore.allocateCounter(); const n: Note = { vaultId, amount, ownerCommitment: ownerCommitmentOf(keys.spendKey), noteSecret: deriveNoteSecret(keys.noteKey, counter) }; return { note: n, noteData: encryptForSelf(keys, n), counter }; };
  const pieceOut = mk(piece), restOut = mk(restAmount);
  const feeOut: FeeOutput | undefined = fee ? { note: feeNote(vaultId, fee), outputIndex: 2 } : undefined;
  const noteData: [Hex, Hex, Hex] = [pieceOut.noteData, restOut.noteData, feeOut ? encryptTo(fee!.viewPub, feeOut.note) : placeholderNoteData()];
  const spec: TxSpec = {
    ...treeSpec(tree), inputs: [{ ...note.note, spendKey: spendKeyOf(keys, note), leafIndex: note.leafIndex }, null], outputs: [pieceOut.note, restOut.note, feeOut?.note ?? dummy(vaultId)],
    withdrawal: null, outDataHash: noteData.map((d) => noteDataHash(hexToBytes(d))) as [bigint, bigint, bigint], txDomain: domain,
  };
  return { spec, noteData, spent: [note], piece: pieceOut, rest: restOut, fee: feeOut };
}

/** Perform one split on chain (private self-transfer) and record both notes. */
async function splitNoteInTurn(o: { masterSeed: Uint8Array; deployment: Deployment; note: OwnedNote; piece: bigint } & Progress): Promise<Submitted & { pieceNote: OwnedNote; restNote: OwnedNote }> {
  await guardDeployment(o.deployment);
  const submission = o.submission ?? settings.get().submission;
  const vaultId = o.note.note.vaultId;
  const vault = ("0x" + vaultId.toString(16).padStart(40, "0")) as Address;
  const terms = await feeTerms(o.deployment, submission, vault);
  o.onStatus?.(`Splitting a note (${o.note.leafIndex}) into a common-sized piece privately…`);
  const tree = await syncTreeQuorum(o.deployment);
  o.onEvent?.({ type: "verifying" });
  await verifyTree(o.deployment, tree, o.onStatus); // plan §38: the tree must contain the pool proven at the latest finalized block
  poolStats.set({ notes: tree.notes, leaves: tree.nextLeafIndex });
  const plan = planSplit(o.masterSeed, tree.layers, o.note, o.piece, txDomainOf(o.deployment), terms?.fee);
  const r = await submitAndRecord({ ...o, submission, relayerUrl: terms?.url, spec: plan.spec, noteData: plan.noteData, spent: plan.spent, change: plan.rest, fee: plan.fee, extra: plan.piece.note });
  const pieceNote: OwnedNote = { note: plan.piece.note, leafIndex: r.extraLeaf!, noteData: plan.piece.noteData, counter: plan.piece.counter, spent: false, txHash: r.txHash, label: "piece" };
  noteStore.add({ ...pieceNote, addedAt: Date.now() });
  recordActivity({ id: activityId("housekeeping", r.txHash), kind: "housekeeping", ...activityAsset(o.deployment, vaultId), amount: o.piece.toString(), status: "completed", ref: r.txHash, note: "a common-sized piece split off privately" });
  return { ...r, pieceNote, restNote: r.change! };
}

/** The 121-byte wallet record of a note (spec §5.1), for a manual backup / import. */
export const noteRecordHex = (note: Note, leafIndex: number): Hex => toHex(encodeNote(note, leafIndex));

/**
 * Private transfer (mode 0, spec §33 — the preferred operation): nothing public but the existence
 * of a transaction. Outputs: the recipient's note (their owner commitment, payload encrypted to
 * their view key — they find it by rescanning), our change, the relayer's fee note or a dummy.
 */
async function privateTransferInTurn(o: { masterSeed: Uint8Array; deployment: Deployment; amount: bigint; recipient: string; vault?: Address; /** the relayer's fee the Review showed: a higher one stops the spend (FeeMoved) */ maxFee?: bigint } & Progress): Promise<Submitted & { recipientNote: { note: Note; leafIndex: number; record: Hex } }> {
  const to = decodePrivacyAddress(o.recipient); // throws on a malformed / mistyped address
  await guardDeployment(o.deployment);
  const submission = o.submission ?? settings.get().submission;
  const vault = o.vault ?? o.deployment.ethVault;
  o.onEvent?.({ type: "fee-terms" });
  const terms = await feeTerms(o.deployment, submission, vault, undefined, { delivered: o.amount }); // V5 (spec §10): the percentage of what the recipient receives
  boundFee(terms, o.maxFee);
  const vaultId = BigInt(vault);
  const keys = deriveKeys(o.masterSeed);
  await ensureSpendableInTurn({ ...o, submission, vault, needed: o.amount });
  o.onStatus?.("Syncing the shielded tree from the core's events…");
  o.onEvent?.({ type: "syncing" });
  const tree = await syncTreeQuorum(o.deployment);
  o.onEvent?.({ type: "verifying" });
  await verifyTree(o.deployment, tree, o.onStatus); // plan §38: the tree must contain the pool proven at the latest finalized block
  poolStats.set({ notes: tree.notes, leaves: tree.nextLeafIndex });
  const { spent, inputs, change: changeAmount } = pickInputs(keys, vaultId, o.amount + (terms?.fee.amount ?? 0n));
  const recipientNote: Note = { vaultId, amount: o.amount, ownerCommitment: to.ownerCommitment, noteSecret: randomField() };
  const change = changeNote(keys, vaultId, changeAmount);
  const fee: FeeOutput | undefined = terms ? { note: feeNote(vaultId, terms.fee), outputIndex: 2 } : undefined;
  const noteData: [Hex, Hex, Hex] = [encryptTo(to.viewPub, recipientNote), change?.noteData ?? placeholderNoteData(), fee ? encryptTo(terms!.fee.viewPub, fee.note) : placeholderNoteData()];
  const spec: TxSpec = {
    leaves: tree.leaves, tree: tree.layers, inputs, outputs: [recipientNote, change?.note ?? dummy(vaultId), fee?.note ?? dummy(vaultId)],
    withdrawal: null, outDataHash: noteData.map((d) => noteDataHash(hexToBytes(d))) as [bigint, bigint, bigint], txDomain: txDomainOf(o.deployment),
  };
  const r = await submitAndRecord({ ...o, submission, relayerUrl: terms?.url, network: networkCharge(o.deployment, terms, vault), spec, noteData, spent, change, fee, extra: recipientNote });
  if (o.record !== false) recordActivity({ id: activityId("transfer", r.txHash), kind: "transfer", ...activityAsset(o.deployment, vault), amount: o.amount.toString(), status: "completed", ref: r.txHash, note: `to ${o.recipient.slice(0, 14)}…`, ...(o.record ?? {}) });
  return { ...r, recipientNote: { note: recipientNote, leafIndex: r.extraLeaf!, record: noteRecordHex(recipientNote, r.extraLeaf!) } };
}

/**
 * Note discovery (spec §12): walk every NoteInserted payload, open the ones encrypted to our view
 * key, keep only those that reproduce the leaf's commitment with OUR owner commitment — the privacy
 * address's, or (the audit round of 2026-10-16, c18) a deposited note's own, derived from the opened
 * secret with the spend key on this thread —, and read their spent status from the core's nullifier
 * set, each by its own key's nullifier. Idempotent: known leaves are only updated.
 * On a chain the light client serves (plan §38), the tree the payloads came from must contain the
 * pool proven at the latest finalized block (a forged event cannot add a note there), and each found
 * note's spent status is also proven at that block: an endpoint that calls a spent note unspent is
 * refused; a spend after that block still counts.
 */
interface FoundNote { leafIndex: number; note: Note; commitment: bigint; noteData: Hex; txHash: Hex; label: string; counter?: number }

/** Found notes into the store, each with its spent status: the RPC quorum's answer and, where a light client applies, the proven one. */
async function recordFound(d: Deployment, keys: WalletKeys, all: FoundNote[], stop?: () => boolean): Promise<{ found: number; added: number; spent: number; addedNotes: FoundNote[] }> {
  const client = clientFor(d);
  // each note's nullifier is its own key's (the audit round of 2026-10-16, c18): with the spend key, a spent deposited note
  // would read unspent for good. A note neither key opens is left out, not the whole scan
  const main = mainOwnerCommitment(keys);
  const keyed = all.flatMap((f) => {
    const key = ownerKeyOf(keys, f.note, main);
    return key === null ? [] : [{ f, key }];
  });
  const found = keyed.map((k) => k.f);
  const nullifiers = keyed.map(({ f, key }) => nullifier(f.commitment, key));
  const rpcSpent = await Promise.all(nullifiers.map(async (nf) => (await client.readContract({ address: d.core, abi: coreAbi, functionName: "isNullifierSpent", args: [nf] })) as boolean));
  const proven = await provenSpent(d, nullifiers);
  if (stop?.()) throw new Error("the wallet locked during the scan"); // its store was emptied while the reads ran
  let added = 0, spentCount = 0;
  const addedNotes: FoundNote[] = [];
  for (const [i, f] of found.entries()) {
    if (proven?.spent[i] && !rpcSpent[i]) throw new TreeNotProven(`the RPC endpoint says the note at leaf ${f.leafIndex} is unspent; it was spent by finalized block ${proven.blockNumber}`);
    const spent = rpcSpent[i] || !!proven?.spent[i];
    if (spent) spentCount++;
    const known = noteStore.all().find((n) => n.leafIndex === f.leafIndex);
    if (known) {
      if (spent && !known.spent) noteStore.markSpent([f.leafIndex]);
      continue;
    }
    noteStore.add({ note: f.note, leafIndex: f.leafIndex, noteData: f.noteData, spent, txHash: f.txHash, label: f.label, ...(f.counter !== undefined ? { counter: f.counter } : {}) });
    added++;
    addedNotes.push(f);
  }
  return { found: found.length, added, spent: spentCount, addedNotes };
}

/** A private transfer received (V6 follow-up: note discovery): a note new to this wallet that its seed did not make. */
export interface ReceivedNote { leafIndex: number; vaultId: bigint; amount: bigint; txHash: Hex }

/** The refund claims of the journaled orders (none while locked). */
const journaledRefundClaims = (): RefundClaim[] => (session.isUnlocked() ? refundClaims(session.journal().swaps) : []);

/** Refund and delivery notes of this wallet's orders (PP-S09; V6 §11.2); the vault deposits are read only when an insert carries a claimed payload. */
async function findRefunds(d: Deployment, keys: WalletKeys, logs: NoteInsertedLog[], claims: RefundClaim[]): Promise<RecoveredRefund[]> {
  if (!hasRefundCandidates(logs, claims)) return [];
  return matchCommittedDeposits(keys, logs, await depositedLogsQuorum(d), claims);
}

/** The journal's claims, then the seed's for every counter up to `upTo` (a journal-less wallet's refunds), one per payload. */
function allRefundClaims(masterSeed: Uint8Array, journal: RefundClaim[], upTo: number): RefundClaim[] {
  const seen = new Set(journal.map((c) => c.noteData.toLowerCase()));
  return [...journal, ...seedRefundClaims(masterSeed, upTo).filter((c) => !seen.has(c.noteData.toLowerCase()))];
}
/** How far past the highest counter found a refund is still looked for (refunds are rarer than notes). */
const REFUND_COUNTER_MARGIN = 1024;
/**
 * How far past the highest counter one complete scan found the counters resume after a start without the whole journal
 * (PP-P03; the audit round of 2026-10-16): past the counters that left nothing the scan reads — an executed order's
 * refund note, a commit never funded — and well inside the 1024 a later restore searches past the last one found.
 */
export const COUNTER_RESERVE = 256;

const refundFound = (r: RecoveredRefund): FoundNote => ({ leafIndex: r.leafIndex, note: r.note, commitment: r.commitment, noteData: r.noteData, txHash: r.txHash, label: r.kind === "shield" ? "swap" : "swap refund", counter: r.counter });

/**
 * Each order a committed deposit came for: a refund's notes and the refunded state (a completed order keeps its state);
 * a same-chain swap's delivered notes on its shield receipt (V6 §11.2: the order's tracker reads them as completed).
 */
function journalRefunds(refunds: RecoveredRefund[]): void {
  if (!refunds.length || !session.isUnlocked()) return;
  session.update((j) => {
    for (const r of refunds) {
      const s = j.swaps.find((x) => x.orderId.toLowerCase() === r.orderId.toLowerCase());
      if (!s) continue;
      if (r.kind === "shield") {
        if (!s.shield) continue;
        const leaves = (s.shield.leaves ??= []);
        if (!leaves.some((x) => x.leafIndex === r.leafIndex)) leaves.push({ leafIndex: r.leafIndex, vault: "0x" + r.note.vaultId.toString(16).padStart(40, "0"), amount: r.note.amount.toString() });
        continue;
      }
      const list = (s.refunds ??= []);
      if (!list.some((x) => x.leafIndex === r.leafIndex)) list.push({ leafIndex: r.leafIndex, vault: "0x" + r.note.vaultId.toString(16).padStart(40, "0"), amount: r.note.amount.toString() });
      if (s.state !== "completed") s.state = "refunded";
    }
  });
}

export async function scanNotes(o: { masterSeed: Uint8Array; deployment: Deployment; refunds?: RefundClaim[] } & Progress): Promise<{ scanned: number; found: number; added: number; spent: number; refunds: number; received: ReceivedNote[] }> {
  // a lock during the scan empties the store: nothing found afterwards goes into it, nor raises the next wallet's counter
  let locked = false;
  const off = session.onLock(() => {
    locked = true;
  });
  try {
    return await scanNotesUnlocked(o, () => locked);
  } finally {
    off();
  }
}

async function scanNotesUnlocked(o: { masterSeed: Uint8Array; deployment: Deployment; refunds?: RefundClaim[] } & Progress, locked: () => boolean): Promise<{ scanned: number; found: number; added: number; spent: number; refunds: number; received: ReceivedNote[] }> {
  const keys = deriveKeys(o.masterSeed);
  o.onStatus?.("Scanning the core's payloads for notes encrypted to this wallet…");
  const { tree, logs } = await syncPoolQuorum(o.deployment);
  await verifyTree(o.deployment, tree, o.onStatus);
  poolStats.set({ notes: logs.length, leaves: tree.nextLeafIndex });
  const byLeaf = new Map(logs.map((l) => [l.leafIndex, l]));
  const opened = await openNotePayloads(keys, logs.map((l) => ({ leafIndex: l.leafIndex, commitment: l.commitment, noteData: hexToBytes(l.noteData) })), (done, total) => o.onStatus?.(`Scanning ${done} / ${total} payloads…`));
  // the notes made out to the privacy address, and the deposited notes made out to their own owner commitment (the audit
  // round of 2026-10-16, c18), each kept only when it reproduces its leaf
  const main = mainOwnerCommitment(keys);
  const hits = opened.flatMap((op) => {
    const l = byLeaf.get(op.leafIndex);
    const note = l ? ownedOpening(keys, op, l.commitment, main) : null;
    return note ? [{ leafIndex: op.leafIndex, note }] : [];
  });
  // which counters this wallet used, by the secrets of the notes it found (PP-P03: a phrase-only restore has no journal counter)
  const counters = usedCounters(keys.noteKey, hits.map((h) => h.note.noteSecret));
  const found: FoundNote[] = hits.map(({ leafIndex, note }) => { const l = byLeaf.get(leafIndex)!; const c = counters.get(note.noteSecret); return { leafIndex, note, commitment: l.commitment, noteData: l.noteData, txHash: l.transactionHash, label: "discovered", ...(c !== undefined ? { counter: c } : {}) }; });
  // swap refunds carry the order's payload, not an envelope: discovery cannot see them (PP-S09); the journal names them,
  // and the payload derives from the seed and the counter, so a wallet without its journal regenerates them
  const upTo = Math.max(noteStore.nextCounter(), ...[...counters.values()].map((c) => c + 1), 0) + REFUND_COUNTER_MARGIN;
  const refunds = await findRefunds(o.deployment, keys, logs, o.refunds ?? allRefundClaims(o.masterSeed, journaledRefundClaims(), upTo));
  for (const r of refunds) if (!found.some((f) => f.leafIndex === r.leafIndex)) found.push(refundFound(r));
  if (locked()) throw new Error("the wallet locked during the scan");
  const { addedNotes, ...r } = await recordFound(o.deployment, keys, found, locked);
  journalRefunds(refunds);
  for (const c of [...counters.values(), ...refunds.map((x) => x.counter)]) noteStore.observeCounter(c);
  // a complete scan (every payload, the seed's claims): the counters held after a restore resume past what it found
  if (o.refunds === undefined) noteStore.releaseCounters(COUNTER_RESERVE);
  // a note this wallet's seed did not make (no counter), made out to the privacy address (only this wallet derives a
  // deposited note's own owner commitment), and that is no swap's refund or delivery: someone sent it here
  const refundLeaves = new Set(refunds.map((x) => x.leafIndex));
  const received: ReceivedNote[] = addedNotes
    .filter((f) => f.counter === undefined && !refundLeaves.has(f.leafIndex) && f.note.ownerCommitment === main)
    .map((f) => ({ leafIndex: f.leafIndex, vaultId: f.note.vaultId, amount: f.note.amount, txHash: f.txHash }));
  o.onStatus?.(`Scanned ${logs.length} payloads: ${r.found} ours (${r.added} new, ${r.spent} spent${refunds.length ? `, ${refunds.length} swap refund${refunds.length > 1 ? "s" : ""}` : ""}).`);
  return { scanned: logs.length, ...r, refunds: refunds.length, received };
}

/** V6 Stage 12: the delivered note of a same-chain swap into the protected balance, once the executor reports a shield. */
export async function recoverShieldDelivery(o: { masterSeed: Uint8Array; deployment: Deployment; orderId: string; shield: { noteData: string; counter: number } } & Progress): Promise<RecoveredRefund[]> {
  return recoverSwapRefunds({ ...o, refunds: [{ orderId: o.orderId, noteData: o.shield.noteData as Hex, counter: o.shield.counter, kind: "shield" }] });
}

/** Record the refund notes of this wallet's orders without a payload scan: right after the executor reports a refund (PP-S09). */
export async function recoverSwapRefunds(o: { masterSeed: Uint8Array; deployment: Deployment; refunds?: RefundClaim[] } & Progress): Promise<RecoveredRefund[]> {
  const keys = deriveKeys(o.masterSeed);
  o.onStatus?.("Looking for the refund in the pool…");
  const { tree, logs } = await syncPoolQuorum(o.deployment);
  await verifyTree(o.deployment, tree, o.onStatus);
  const refunds = await findRefunds(o.deployment, keys, logs, o.refunds ?? journaledRefundClaims());
  await recordFound(o.deployment, keys, refunds.map(refundFound));
  journalRefunds(refunds);
  return refunds;
}
