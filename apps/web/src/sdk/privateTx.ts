// The wallet's money operations against the live core: a public shield (vault.deposit), a private
// transfer and a private withdrawal (PrivacyCore.transact with a locally generated proof), and note
// discovery from chain. Everything secret — the spending key, note secrets, the witness — stays in
// this tab: inputs are built here from the note store, the proof is made in the Web Worker
// (src/prover), and the calldata goes either to a relayer (private submission, paid by a private
// fee note inside the transaction — the default) or to the injected wallet (public fallback).
// Payloads are the spec §12 envelope (packages/protocol/src/envelope.ts): our own notes are
// encrypted to our view key, a recipient's note to the view key inside their privacy address, the
// relayer's fee note to its privacy address, dummies are indistinguishable filler — so every note
// can be recovered from chain by rescanning (scanNotes).
import type { SwapFunding } from "./relayer";
import type { OnEvent } from "../features/operations/engineEvents";
import type { Address, Hex } from "viem";
import { deriveKeys, deriveNoteSecret, type WalletKeys } from "@privacy-wallet/protocol/keys";
import { encodeNote, noteBody, noteCommitment, ownerCommitmentOf, type Note } from "@privacy-wallet/protocol/note";
import { noteDataHash } from "@privacy-wallet/protocol/payload";
import { FIELD } from "@privacy-wallet/protocol/field";
import { selectInputs } from "@privacy-wallet/protocol/wallet/amounts";
import { buildTxInputs, type SpendNote, type TxSpec } from "@privacy-wallet/protocol/txInputs";
import { dummyNoteData, encryptNoteData, viewKeyPair } from "@privacy-wallet/protocol/envelope";
import { decodePrivacyAddress, encodePrivacyAddress } from "@privacy-wallet/protocol/address";
import { nullifier } from "@privacy-wallet/protocol/nullifier";
import { MerkleLayers } from "@privacy-wallet/protocol/merkle";
import { discoverNotes } from "./core";
import { noteStore, type OwnedNote } from "../wallet/notes";
import { settings, type Submission } from "../wallet/settings";
import { proveInBrowser, type ProveStatus } from "../prover/client";
import { buildApprove, buildShieldERC20, buildShieldNative, buildTransact, coreAbi, type TxRequest } from "./privacyProtocol";
import { clientFor, depositedLogsQuorum, noteInsertions, sendViaInjectedWallet, syncPoolQuorum, syncTreeQuorum, txDomainOf, type Deployment, type NoteInsertedLog } from "./chain";
import { hasRefundCandidates, matchRefunds, refundClaims, seedRefundClaims, usedCounters, type RecoveredRefund, type RefundClaim } from "./refunds";
import { session } from "../wallet/session";
import { feeInVault, isRefusal, pickRelayer, relayerFallbacks, relayerSubmit, type RelayerInfo } from "./relayer";
import { poolStats } from "../wallet/poolStats";
import { provenSpent, TreeNotProven, verifyTree } from "./verifiedReads";
import { activityId, recordActivity, type ActivityRecord } from "../wallet/activity";
import { assetByVault } from "./assets";

/** The Activity line's asset fields for a vault (symbol + decimals; a vault the deployment does not name is shown by its address). */
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
export interface PreparedShield { deployment: Deployment; vault: Address; token: Address | null; amount: bigint; note: Note; noteData: Hex; counter: number; approve?: TxRequest; deposit: TxRequest }

export function prepareShield(o: { masterSeed: Uint8Array; deployment: Deployment; amount: bigint; token?: Address | null; vault?: Address }): PreparedShield {
  const keys = deriveKeys(o.masterSeed);
  const vault = o.vault ?? o.deployment.ethVault;
  const token = o.token ?? null;
  const counter = noteStore.allocateCounter();
  const note: Note = { vaultId: BigInt(vault), amount: o.amount, ownerCommitment: ownerCommitmentOf(keys.spendKey), noteSecret: deriveNoteSecret(keys.noteKey, counter) };
  const noteData = encryptForSelf(keys, note);
  const deposit = token ? buildShieldERC20(vault, o.amount, note.ownerCommitment, note.noteSecret, noteData) : buildShieldNative(vault, note.ownerCommitment, note.noteSecret, o.amount, noteData);
  return { deployment: o.deployment, vault, token, amount: o.amount, note, noteData, counter, ...(token ? { approve: buildApprove(token, vault, o.amount) } : {}), deposit };
}

/** The calldata of a shield with a scratch note (random, never journaled), for a gas estimate before anything is prepared: no counter is spent. */
export function scratchShieldTx(deployment: Deployment, amount: bigint, token: Address | null, vault: Address = deployment.ethVault): { approve?: TxRequest; deposit: TxRequest } {
  const note: Note = { vaultId: BigInt(vault), amount, ownerCommitment: randomField(), noteSecret: randomField() };
  const noteData = placeholderNoteData();
  return { ...(token ? { approve: buildApprove(token, vault, amount) } : {}), deposit: token ? buildShieldERC20(vault, amount, note.ownerCommitment, note.noteSecret, noteData) : buildShieldNative(vault, note.ownerCommitment, note.noteSecret, amount, noteData) };
}

/** Wait for the deposit and journal the note at the leaf the chain assigned. */
export async function trackShield(p: PreparedShield, txHash: Hex): Promise<number> {
  const inserted = await noteInsertions(clientFor(p.deployment), txHash);
  const mine = inserted.find((i) => i.commitment === noteCommitment(noteBody(p.note), BigInt(i.leafIndex)));
  if (!mine) throw new Error("the deposit was mined but its commitment was not found in the receipt");
  noteStore.add({ note: p.note, leafIndex: mine.leafIndex, noteData: p.noteData, counter: p.counter, spent: false, txHash, label: "shield" });
  return mine.leafIndex;
}

export async function submitShield(p: PreparedShield, o: Progress = {}): Promise<{ approveTx?: Hex; txHash: Hex; leafIndex: number }> {
  let approveTx: Hex | undefined;
  if (p.approve) {
    o.onStatus?.("1/2 Approving the vault for exactly this amount (connected wallet)…");
    o.onEvent?.({ type: "wallet-prompt", step: "approve", i: 1, n: 2 });
    approveTx = await sendViaInjectedWallet(p.approve);
    const approval = await clientFor(p.deployment).waitForTransactionReceipt({ hash: approveTx });
    if (approval.status !== "success") throw new Error(`the approval ${approveTx} reverted`);
    o.onEvent?.({ type: "approved", txHash: approveTx });
    o.onStatus?.("2/2 Depositing into the vault (a shield is public by design)…");
    o.onEvent?.({ type: "wallet-prompt", step: "deposit", i: 2, n: 2 });
  } else {
    o.onStatus?.("Submitting the shield through the connected wallet (a shield is public by design)…");
    o.onEvent?.({ type: "wallet-prompt", step: "deposit", i: 1, n: 1 });
  }
  const txHash = await sendViaInjectedWallet(p.deposit);
  o.onEvent?.({ type: "submitted", txHash, by: "wallet" });
  o.onStatus?.("Waiting for the deposit to be mined…");
  o.onEvent?.({ type: "waiting-receipt", txHash });
  const leafIndex = await trackShield(p, txHash);
  o.onEvent?.({ type: "mined", txHash, leafIndex });
  if (o.record !== false) recordActivity({ id: activityId("shield", txHash), kind: "shield", ...activityAsset(p.deployment, p.vault), amount: p.amount.toString(), status: "completed", ref: txHash, ...(o.record ?? {}) });
  return { ...(approveTx ? { approveTx } : {}), txHash, leafIndex };
}

/** Public shield of `amount` wei into the canonical ETH vault (prepare → submit → track). */
export async function shieldNative(o: { masterSeed: Uint8Array; deployment: Deployment; amount: bigint } & Progress): Promise<{ txHash: Hex; leafIndex: number }> {
  const r = await submitShield(prepareShield({ masterSeed: o.masterSeed, deployment: o.deployment, amount: o.amount }), o);
  return { txHash: r.txHash, leafIndex: r.leafIndex };
}

/**
 * Public shield of `amount` token units into the token's canonical ERC-20 vault (plan §36): an exact-amount
 * approve, then the vault's deposit (it pulls the tokens and inserts the note). Two transactions through the
 * connected wallet; the second waits for the first to be mined.
 */
export async function shieldERC20(o: { masterSeed: Uint8Array; deployment: Deployment; token: Address; vault: Address; amount: bigint } & Progress): Promise<{ approveTx: Hex; txHash: Hex; leafIndex: number }> {
  const r = await submitShield(prepareShield({ masterSeed: o.masterSeed, deployment: o.deployment, amount: o.amount, token: o.token, vault: o.vault }), o);
  return { approveTx: r.approveTx!, txHash: r.txHash, leafIndex: r.leafIndex };
}

/** Who gets the fee note (the relayer's privacy address), in which vault, and how much. */
export interface FeeTerms { ownerCommitment: bigint; viewPub: Uint8Array; amount: bigint; vault: bigint }
export interface FeeOutput { note: Note; outputIndex: 0 | 1 | 2 }
export interface WithdrawalPlan { spec: TxSpec; noteData: [Hex, Hex, Hex]; spent: OwnedNote[]; change?: { note: Note; noteData: Hex; counter: number }; fee?: FeeOutput }

function pickInputs(keys: WalletKeys, vaultId: bigint, needed: bigint): { spent: OwnedNote[]; inputs: [SpendNote, SpendNote | null]; change: bigint } {
  const mine = noteStore.unspent(vaultId);
  const sel = selectInputs(mine.map((n) => ({ id: String(n.leafIndex), amount: n.note.amount })), needed);
  if (sel.merges.length) throw new Error("this amount needs a private merge of smaller notes first (ensureSpendable)");
  const spent = sel.inputs.map((i) => mine.find((n) => String(n.leafIndex) === i.id)!);
  const asSpend = (n: OwnedNote): SpendNote => ({ ...n.note, spendKey: keys.spendKey, leafIndex: n.leafIndex });
  return { spent, inputs: [asSpend(spent[0]), spent[1] ? asSpend(spent[1]) : null], change: sel.change };
}

function changeNote(keys: WalletKeys, vaultId: bigint, amount: bigint): WithdrawalPlan["change"] {
  if (amount <= 0n) return undefined;
  const counter = noteStore.allocateCounter();
  const note: Note = { vaultId, amount, ownerCommitment: ownerCommitmentOf(keys.spendKey), noteSecret: deriveNoteSecret(keys.noteKey, counter) };
  return { note, noteData: encryptForSelf(keys, note), counter };
}

const feeNote = (vaultId: bigint, fee: FeeTerms): Note => ({ vaultId, amount: fee.amount, ownerCommitment: fee.ownerCommitment, noteSecret: randomField() });

/**
 * Pick ≤ 2 of our notes, build the 2-in/3-out spec: withdrawal to `recipient`, change back to us
 * (encrypted to us), the relayer's fee note (encrypted to the relayer) when submitting privately, dummies.
 */
export function planWithdrawal(masterSeed: Uint8Array, tree: TreeArg, vaultId: bigint, amount: bigint, recipient: bigint, domain: bigint, fee?: FeeTerms): WithdrawalPlan {
  const keys = deriveKeys(masterSeed);
  const { spent, inputs, change: changeAmount } = pickInputs(keys, vaultId, amount + (fee?.amount ?? 0n));
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
export async function feeTerms(deployment: Deployment, submission: Submission, vault: Address, fallbacks: string[] = relayerFallbacks(), opts: { /** V5 (spec §10): the amount delivered, for the percentage fee */ delivered?: bigint; /** the recipient is a swap escrow: the minimum only */ escrow?: boolean } = {}): Promise<{ url: string; info: RelayerInfo; fee: FeeTerms } | null> {
  if (submission.kind !== "relayer") return null;
  const candidates = [submission.url, ...fallbacks];
  const errors: string[] = [];
  for (const url of candidates) {
    const picked = await pickRelayer([url], { chainId: deployment.chainId, core: deployment.core });
    if (!picked) { errors.push(`${url}: unreachable or another chain / core`); continue; }
    const amount = feeInVault(picked.info, vault, undefined, opts.escrow ? undefined : opts.delivered);
    if (amount === null) { errors.push(`${url}: takes no fees in vault ${vault}`); continue; }
    const addr = decodePrivacyAddress(picked.info.privacyAddress);
    return { url: picked.url, info: picked.info, fee: { ownerCommitment: addr.ownerCommitment, viewPub: addr.viewPub, amount, vault: BigInt(vault) } };
  }
  throw new Error(`no relayer available for this asset (${errors.join("; ")}); switch submission to the connected wallet (public) or add a relayer`);
}

export interface Submitted { txHash: Hex; proofMs: number; verifiedLocally: boolean; change?: OwnedNote; spent: number[]; submittedBy: "relayer" | "wallet"; feeWei?: bigint; extraLeaf?: number }

async function submitAndRecord(o: { deployment: Deployment; spec: TxSpec; noteData: [Hex, Hex, Hex]; spent: OwnedNote[]; change?: WithdrawalPlan["change"]; fee?: FeeOutput; extra?: Note; submission: Submission; relayerUrl?: string; swap?: SwapFunding } & Progress): Promise<Submitted> {
  const client = clientFor(o.deployment);
  const inputs = buildTxInputs(o.spec); // throws if a note does not open its leaf or value is not conserved
  o.onEvent?.({ type: "proving" });
  const proof = await proveInBrowser(inputs, o.onStatus);
  o.onEvent?.({ type: "proved", ms: proof.ms, verifiedLocally: proof.verifiedLocally });
  let txHash: Hex;
  let submittedBy: Submitted["submittedBy"];
  if (o.submission.kind === "relayer") {
    if (!o.fee) throw new Error("relayer submission needs a fee output");
    o.onStatus?.(`Proof ready in ${(proof.ms / 1000).toFixed(1)} s; handing it to the relayer (your address never touches the chain)…`);
    const url = o.relayerUrl ?? o.submission.url;
    o.onEvent?.({ type: "submitting", by: "relayer" });
    const body = { proof: proof.proof, publicInputs: proof.publicSignals.map(String), noteData: o.noteData, fee: { outputIndex: o.fee.outputIndex, amount: o.fee.note.amount.toString(), noteSecret: o.fee.note.noteSecret.toString(), vault: ("0x" + o.fee.note.vaultId.toString(16).padStart(40, "0")) as Address }, ...(o.swap ? { swap: o.swap } : {}) };
    let r: Awaited<ReturnType<typeof relayerSubmit>> | undefined;
    for (let attempt = 1; ; attempt++) {
      try { r = await relayerSubmit(url, body); break; }
      catch (e) { if (isRefusal(e) || attempt >= 3) throw e; o.onStatus?.(`Relayer unreachable (attempt ${attempt}); retrying…`); o.onEvent?.({ type: "relayer-retry", attempt }); await new Promise((res) => setTimeout(res, 1500 * attempt)); }
    }
    txHash = r!.txHash;
    submittedBy = "relayer";
    o.onEvent?.({ type: "submitted", txHash, by: "relayer" });
  } else {
    o.onStatus?.(`Proof ready in ${(proof.ms / 1000).toFixed(1)} s; submitting through the connected wallet (public: the transaction is sent from your address)…`);
    o.onEvent?.({ type: "submitting", by: "wallet" });
    o.onEvent?.({ type: "wallet-prompt", step: "transact", i: 1, n: 1 });
    txHash = await sendViaInjectedWallet(buildTransact(o.deployment.core, { proof: proof.proof, publicInputs: proof.publicInputs }, o.noteData));
    submittedBy = "wallet";
    o.onEvent?.({ type: "submitted", txHash, by: "wallet" });
  }
  o.onStatus?.("Waiting for the transaction to be mined…");
  o.onEvent?.({ type: "waiting-receipt", txHash });
  const inserted = await noteInsertions(client, txHash);
  noteStore.markSpent(o.spent.map((n) => n.leafIndex));
  const find = (n: Note) => inserted.find((i) => i.commitment === noteCommitment(noteBody(n), BigInt(i.leafIndex)));
  let change: OwnedNote | undefined;
  if (o.change) {
    const hit = find(o.change.note);
    if (!hit) throw new Error("mined, but the change note's commitment was not found in the receipt");
    change = { note: o.change.note, leafIndex: hit.leafIndex, noteData: o.change.noteData, counter: o.change.counter, spent: false, txHash, label: "change" };
    noteStore.add(change);
  }
  let extraLeaf: number | undefined;
  if (o.extra) {
    const hit = find(o.extra);
    if (!hit) throw new Error("mined, but the recipient's note commitment was not found in the receipt");
    extraLeaf = hit.leafIndex;
  }
  // V5 (spec §12): the record's COMPLETED needs the settlement reference — the mined transaction and the leaf of the note it left (the recipient's, else the change)
  o.onEvent?.({ type: "mined", txHash, ...(extraLeaf !== undefined ? { leafIndex: extraLeaf } : change ? { leafIndex: change.leafIndex } : {}) });
  return { txHash, proofMs: proof.ms, verifiedLocally: proof.verifiedLocally, change, spent: o.spent.map((n) => n.leafIndex), submittedBy, feeWei: o.fee?.note.amount, extraLeaf };
}

/**
 * Private withdrawal of `amount` wei to `recipient` (a fresh public address or a swap-order escrow):
 * sync the tree → plan (with the relayer's fee note when submitting privately) → prove in the
 * worker → submit → record the change note with the leaf index the chain assigned.
 */
export async function privateWithdrawal(o: { masterSeed: Uint8Array; deployment: Deployment; amount: bigint; recipient: Address; vault?: Address; /** V5: the swap order this withdrawal funds (the escrow is the recipient): the relayer takes its minimum only */ swap?: SwapFunding } & Progress): Promise<Submitted> {
  const submission = o.submission ?? settings.get().submission;
  const vault = o.vault ?? o.deployment.ethVault;
  o.onEvent?.({ type: "fee-terms" });
  const terms = await feeTerms(o.deployment, submission, vault, undefined, { delivered: o.amount, escrow: !!o.swap });
  await ensureSpendable({ ...o, submission, vault, needed: o.amount });
  o.onStatus?.("Syncing the shielded tree from the core's events…");
  o.onEvent?.({ type: "syncing" });
  const tree = await syncTreeQuorum(o.deployment);
  o.onEvent?.({ type: "verifying" });
  await verifyTree(o.deployment, tree, o.onStatus); // plan §38: the tree must contain the pool proven at the latest finalized block
  poolStats.set({ notes: tree.notes, leaves: tree.nextLeafIndex });
  const plan = planWithdrawal(o.masterSeed, tree.layers, BigInt(vault), o.amount, BigInt(o.recipient), txDomainOf(o.deployment), terms?.fee);
  const r = await submitAndRecord({ ...o, submission, relayerUrl: terms?.url, spec: plan.spec, noteData: plan.noteData, spent: plan.spent, change: plan.change, fee: plan.fee, swap: o.swap });
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
  const asSpend = (n: OwnedNote): SpendNote => ({ ...n.note, spendKey: keys.spendKey, leafIndex: n.leafIndex });
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
export function mergeSchedule(notes: { id: string; amount: bigint }[], needed: bigint, feePerTx: bigint, maxMerges = 8): { pairs: [string, string][]; ok: boolean; reason?: "balance" | "fees" | "too-many-merges" } {
  let pool = notes.map((n) => ({ ...n }));
  const pairs: [string, string][] = [];
  for (let i = 0; i <= maxMerges; i++) {
    let sel: ReturnType<typeof selectInputs>;
    try { sel = selectInputs(pool, needed); } catch { return { pairs, ok: false, reason: "balance" }; }
    if (!sel.merges.length) return { pairs, ok: true };
    if (i === maxMerges) break;
    const [x, y] = sel.merges[0];
    const a = pool.find((n) => n.id === x.id)!, b = pool.find((n) => n.id === y.id)!;
    if (a.amount + b.amount <= feePerTx) return { pairs, ok: false, reason: "fees" };
    pairs.push([a.id, b.id]);
    pool = [...pool.filter((n) => n.id !== a.id && n.id !== b.id), { id: `${a.id}+${b.id}`, amount: a.amount + b.amount - feePerTx }];
  }
  return { pairs, ok: false, reason: "too-many-merges" };
}

/** The balance is there but spread over too many notes for one spend (plan V2 §73): housekeeping consolidates it. */
export class HousekeepingNeeded extends Error {
  constructor(readonly notes: number, readonly merges: number, symbol: string) {
    super(`Your ${symbol} balance is spread over ${notes} notes; this spend needs more than ${merges} merges and the wallet does at most ${merges} in one go. Private balance maintenance consolidates them (Settings), or send a smaller amount now.`);
  }
}

/** Perform one merge on chain (private self-transfer) and record the merged note. */
export async function mergeNotes(o: { masterSeed: Uint8Array; deployment: Deployment; a: OwnedNote; b: OwnedNote } & Progress): Promise<Submitted & { merged: OwnedNote }> {
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
  noteStore.add(merged);
  recordActivity({ id: activityId("housekeeping", r.txHash), kind: "housekeeping", ...activityAsset(o.deployment, vaultId), amount: merged.note.amount.toString(), status: "completed", ref: r.txHash, note: "two notes merged privately before a spend" });
  return { ...r, merged };
}

/** Merge until two notes cover `needed` (+ the fee of each merge and of the final spend). Returns the number of merges performed. */
export async function ensureSpendable(o: { masterSeed: Uint8Array; deployment: Deployment; needed: bigint; vault?: Address } & Progress): Promise<number> {
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
    await mergeNotes({ ...o, a, b, submission });
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
    ...treeSpec(tree), inputs: [{ ...note.note, spendKey: keys.spendKey, leafIndex: note.leafIndex }, null], outputs: [pieceOut.note, restOut.note, feeOut?.note ?? dummy(vaultId)],
    withdrawal: null, outDataHash: noteData.map((d) => noteDataHash(hexToBytes(d))) as [bigint, bigint, bigint], txDomain: domain,
  };
  return { spec, noteData, spent: [note], piece: pieceOut, rest: restOut, fee: feeOut };
}

/** Perform one split on chain (private self-transfer) and record both notes. */
export async function splitNote(o: { masterSeed: Uint8Array; deployment: Deployment; note: OwnedNote; piece: bigint } & Progress): Promise<Submitted & { pieceNote: OwnedNote; restNote: OwnedNote }> {
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
  noteStore.add(pieceNote);
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
export async function privateTransfer(o: { masterSeed: Uint8Array; deployment: Deployment; amount: bigint; recipient: string; vault?: Address } & Progress): Promise<Submitted & { recipientNote: { note: Note; leafIndex: number; record: Hex } }> {
  const to = decodePrivacyAddress(o.recipient); // throws on a malformed / mistyped address
  const submission = o.submission ?? settings.get().submission;
  const vault = o.vault ?? o.deployment.ethVault;
  o.onEvent?.({ type: "fee-terms" });
  const terms = await feeTerms(o.deployment, submission, vault, undefined, { delivered: o.amount }); // V5 (spec §10): the percentage of what the recipient receives
  const vaultId = BigInt(vault);
  const keys = deriveKeys(o.masterSeed);
  await ensureSpendable({ ...o, submission, vault, needed: o.amount });
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
  const r = await submitAndRecord({ ...o, submission, relayerUrl: terms?.url, spec, noteData, spent, change, fee, extra: recipientNote });
  if (o.record !== false) recordActivity({ id: activityId("transfer", r.txHash), kind: "transfer", ...activityAsset(o.deployment, vault), amount: o.amount.toString(), status: "completed", ref: r.txHash, note: `to ${o.recipient.slice(0, 14)}…`, ...(o.record ?? {}) });
  return { ...r, recipientNote: { note: recipientNote, leafIndex: r.extraLeaf!, record: noteRecordHex(recipientNote, r.extraLeaf!) } };
}

/**
 * Note discovery (spec §12): walk every NoteInserted payload, open the ones encrypted to our view
 * key, keep only those that reproduce the leaf's commitment with OUR owner commitment, and read
 * their spent status from the core's nullifier set. Idempotent: known leaves are only updated.
 * On a chain the light client serves (plan §38), the tree the payloads came from must contain the
 * pool proven at the latest finalized block (a forged event cannot add a note there), and each found
 * note's spent status is also proven at that block: an endpoint that calls a spent note unspent is
 * refused; a spend after that block still counts.
 */
interface FoundNote { leafIndex: number; note: Note; commitment: bigint; noteData: Hex; txHash: Hex; label: string; counter?: number }

/** Found notes into the store, each with its spent status: the RPC quorum's answer and, where a light client applies, the proven one. */
async function recordFound(d: Deployment, keys: WalletKeys, found: FoundNote[]): Promise<{ found: number; added: number; spent: number }> {
  const client = clientFor(d);
  const nullifiers = found.map((f) => nullifier(f.commitment, keys.spendKey));
  const rpcSpent = await Promise.all(nullifiers.map(async (nf) => (await client.readContract({ address: d.core, abi: coreAbi, functionName: "isNullifierSpent", args: [nf] })) as boolean));
  const proven = await provenSpent(d, nullifiers);
  let added = 0, spentCount = 0;
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
  }
  return { found: found.length, added, spent: spentCount };
}

/** The refund claims of the journaled orders (none while locked). */
const journaledRefundClaims = (): RefundClaim[] => (session.isUnlocked() ? refundClaims(session.journal().swaps) : []);

/** Refund notes of this wallet's orders (PP-S09); the vault deposits are read only when an insert carries a claimed payload. */
async function findRefunds(d: Deployment, keys: WalletKeys, logs: NoteInsertedLog[], claims: RefundClaim[]): Promise<RecoveredRefund[]> {
  if (!hasRefundCandidates(logs, claims)) return [];
  return matchRefunds(keys, logs, await depositedLogsQuorum(d), claims);
}

/** The journal's claims, then the seed's for every counter up to `upTo` (a journal-less wallet's refunds), one per payload. */
function allRefundClaims(masterSeed: Uint8Array, journal: RefundClaim[], upTo: number): RefundClaim[] {
  const seen = new Set(journal.map((c) => c.noteData.toLowerCase()));
  return [...journal, ...seedRefundClaims(masterSeed, upTo).filter((c) => !seen.has(c.noteData.toLowerCase()))];
}
/** How far past the highest counter found a refund is still looked for (refunds are rarer than notes). */
const REFUND_COUNTER_MARGIN = 1024;

const refundFound = (r: RecoveredRefund): FoundNote => ({ leafIndex: r.leafIndex, note: r.note, commitment: r.commitment, noteData: r.noteData, txHash: r.txHash, label: "swap refund", counter: r.counter });

/** Each order a refund came back for: its refund notes and the refunded state (a completed order keeps its state). */
function journalRefunds(refunds: RecoveredRefund[]): void {
  if (!refunds.length || !session.isUnlocked()) return;
  session.update((j) => {
    for (const r of refunds) {
      const s = j.swaps.find((x) => x.orderId.toLowerCase() === r.orderId.toLowerCase());
      if (!s) continue;
      const list = (s.refunds ??= []);
      if (!list.some((x) => x.leafIndex === r.leafIndex)) list.push({ leafIndex: r.leafIndex, vault: "0x" + r.note.vaultId.toString(16).padStart(40, "0"), amount: r.note.amount.toString() });
      if (s.state !== "completed") s.state = "refunded";
    }
  });
}

export async function scanNotes(o: { masterSeed: Uint8Array; deployment: Deployment; refunds?: RefundClaim[] } & Progress): Promise<{ scanned: number; found: number; added: number; spent: number; refunds: number }> {
  const keys = deriveKeys(o.masterSeed);
  o.onStatus?.("Scanning the core's payloads for notes encrypted to this wallet…");
  const { tree, logs } = await syncPoolQuorum(o.deployment);
  await verifyTree(o.deployment, tree, o.onStatus);
  poolStats.set({ notes: logs.length, leaves: tree.nextLeafIndex });
  const byLeaf = new Map(logs.map((l) => [l.leafIndex, l]));
  const hits = await discoverNotes(keys, logs.map((l) => ({ leafIndex: l.leafIndex, commitment: l.commitment, noteData: hexToBytes(l.noteData) })), (done, total) => o.onStatus?.(`Scanning ${done} / ${total} payloads…`));
  // which counters this wallet used, by the secrets of the notes it found (PP-P03: a phrase-only restore has no journal counter)
  const counters = usedCounters(keys.noteKey, hits.map((h) => h.note.noteSecret));
  const found: FoundNote[] = hits.map(({ leafIndex, note }) => { const l = byLeaf.get(leafIndex)!; const c = counters.get(note.noteSecret); return { leafIndex, note, commitment: l.commitment, noteData: l.noteData, txHash: l.transactionHash, label: "discovered", ...(c !== undefined ? { counter: c } : {}) }; });
  // swap refunds carry the order's payload, not an envelope: discovery cannot see them (PP-S09); the journal names them,
  // and the payload derives from the seed and the counter, so a wallet without its journal regenerates them
  const upTo = Math.max(noteStore.nextCounter(), ...[...counters.values()].map((c) => c + 1), 0) + REFUND_COUNTER_MARGIN;
  const refunds = await findRefunds(o.deployment, keys, logs, o.refunds ?? allRefundClaims(o.masterSeed, journaledRefundClaims(), upTo));
  for (const r of refunds) if (!found.some((f) => f.leafIndex === r.leafIndex)) found.push(refundFound(r));
  const r = await recordFound(o.deployment, keys, found);
  journalRefunds(refunds);
  for (const c of [...counters.values(), ...refunds.map((x) => x.counter)]) noteStore.observeCounter(c);
  o.onStatus?.(`Scanned ${logs.length} payloads: ${r.found} ours (${r.added} new, ${r.spent} spent${refunds.length ? `, ${refunds.length} swap refund${refunds.length > 1 ? "s" : ""}` : ""}).`);
  return { scanned: logs.length, ...r, refunds: refunds.length };
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
