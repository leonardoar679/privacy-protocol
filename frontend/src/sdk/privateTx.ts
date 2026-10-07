// The wallet's money operations against the live core: a public shield (vault.deposit), a private
// transfer and a private withdrawal (PrivacyCore.transact with a locally generated proof), and note
// discovery from chain. Everything secret — the spending key, note secrets, the witness — stays in
// this tab: inputs are built here from the note store, the proof is made in the Web Worker
// (src/prover), and the calldata goes either to a relayer (private submission, paid by a private
// fee note inside the transaction — the default) or to the injected wallet (public fallback).
// Payloads are the spec §12 envelope (reference/typescript/src/envelope.ts): our own notes are
// encrypted to our view key, a recipient's note to the view key inside their privacy address, the
// relayer's fee note to its privacy address, dummies are indistinguishable filler — so every note
// can be recovered from chain by rescanning (scanNotes).
import type { Address, Hex } from "viem";
import { deriveKeys, deriveNoteSecret, type WalletKeys } from "@ref/keys";
import { encodeNote, noteBody, noteCommitment, ownerCommitmentOf, type Note } from "@ref/note";
import { noteDataHash } from "@ref/payload";
import { FIELD } from "@ref/field";
import { selectInputs } from "@ref/wallet/amounts";
import { buildTxInputs, type SpendNote, type TxSpec } from "@ref/txInputs";
import { dummyNoteData, encryptNoteData, noteFromPayload, viewKeyPair } from "@ref/envelope";
import { decodePrivacyAddress, encodePrivacyAddress } from "@ref/address";
import { nullifier } from "@ref/nullifier";
import { noteStore, type OwnedNote } from "../wallet/notes";
import { settings, type Submission } from "../wallet/settings";
import { proveInBrowser, type ProveStatus } from "../prover/client";
import { buildShieldNative, buildTransact, coreAbi } from "./privacyProtocol";
import { clientFor, noteInsertedLogsQuorum, noteInsertions, sendViaInjectedWallet, syncTreeQuorum, txDomainOf, type Deployment } from "./chain";
import { feeForRelayer, relayerInfo, relayerSubmit, type RelayerInfo } from "./relayer";
import { poolStats } from "../wallet/poolStats";

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

export interface Progress { onStatus?: ProveStatus; submission?: Submission }

/** Public shield of `amount` wei into the canonical ETH vault; the payload is encrypted to ourselves; records the note once mined. */
export async function shieldNative(o: { masterSeed: Uint8Array; deployment: Deployment; amount: bigint } & Progress): Promise<{ txHash: Hex; leafIndex: number }> {
  const keys = deriveKeys(o.masterSeed);
  const counter = noteStore.allocateCounter();
  const note: Note = { vaultId: BigInt(o.deployment.ethVault), amount: o.amount, ownerCommitment: ownerCommitmentOf(keys.spendKey), noteSecret: deriveNoteSecret(keys.noteKey, counter) };
  const noteData = encryptForSelf(keys, note);
  o.onStatus?.("Submitting the shield through the connected wallet (a shield is public by design)…");
  const txHash = await sendViaInjectedWallet(buildShieldNative(o.deployment.ethVault, note.ownerCommitment, note.noteSecret, note.amount, noteData));
  o.onStatus?.("Waiting for the deposit to be mined…");
  const inserted = await noteInsertions(clientFor(o.deployment), txHash);
  const mine = inserted.find((i) => i.commitment === noteCommitment(noteBody(note), BigInt(i.leafIndex)));
  if (!mine) throw new Error("the deposit was mined but its commitment was not found in the receipt");
  noteStore.add({ note, leafIndex: mine.leafIndex, noteData, counter, spent: false, txHash, label: "shield" });
  return { txHash, leafIndex: mine.leafIndex };
}

/** Who gets the fee note (the relayer's privacy address) and how much. */
export interface FeeTerms { ownerCommitment: bigint; viewPub: Uint8Array; amount: bigint }
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
export function planWithdrawal(masterSeed: Uint8Array, leaves: bigint[], vaultId: bigint, amount: bigint, recipient: bigint, domain: bigint, fee?: FeeTerms): WithdrawalPlan {
  const keys = deriveKeys(masterSeed);
  const { spent, inputs, change: changeAmount } = pickInputs(keys, vaultId, amount + (fee?.amount ?? 0n));
  const change = changeNote(keys, vaultId, changeAmount);
  const feeOut: FeeOutput | undefined = fee ? { note: feeNote(vaultId, fee), outputIndex: 1 } : undefined;
  const outputs: [Note, Note, Note] = [change?.note ?? dummy(vaultId), feeOut?.note ?? dummy(vaultId), dummy(vaultId)];
  const noteData: [Hex, Hex, Hex] = [change?.noteData ?? placeholderNoteData(), feeOut ? encryptTo(fee!.viewPub, feeOut.note) : placeholderNoteData(), placeholderNoteData()];
  const spec: TxSpec = { leaves, inputs, outputs, withdrawal: { vault: vaultId, amount, recipient }, outDataHash: noteData.map((d) => noteDataHash(hexToBytes(d))) as [bigint, bigint, bigint], txDomain: domain };
  return { spec, noteData, spent, change, fee: feeOut };
}

/** The relayer's terms for this deployment, or null when submitting through the connected wallet. */
async function feeTerms(deployment: Deployment, submission: Submission): Promise<{ info: RelayerInfo; fee: FeeTerms } | null> {
  if (submission.kind !== "relayer") return null;
  const info = await relayerInfo(submission.url);
  if (Number(info.chainId) !== deployment.chainId || info.core.toLowerCase() !== deployment.core.toLowerCase()) throw new Error(`relayer ${submission.url} serves chain ${info.chainId} / core ${info.core}, not this deployment`);
  if (info.feeVault.toLowerCase() !== deployment.ethVault.toLowerCase()) throw new Error("relayer does not take fees in this vault");
  const addr = decodePrivacyAddress(info.privacyAddress);
  return { info, fee: { ownerCommitment: addr.ownerCommitment, viewPub: addr.viewPub, amount: feeForRelayer(info) } };
}

export interface Submitted { txHash: Hex; proofMs: number; verifiedLocally: boolean; change?: OwnedNote; spent: number[]; submittedBy: "relayer" | "wallet"; feeWei?: bigint; extraLeaf?: number }

async function submitAndRecord(o: { deployment: Deployment; spec: TxSpec; noteData: [Hex, Hex, Hex]; spent: OwnedNote[]; change?: WithdrawalPlan["change"]; fee?: FeeOutput; extra?: Note; submission: Submission } & Progress): Promise<Submitted> {
  const client = clientFor(o.deployment);
  const inputs = buildTxInputs(o.spec); // throws if a note does not open its leaf or value is not conserved
  const proof = await proveInBrowser(inputs, o.onStatus);
  let txHash: Hex;
  let submittedBy: Submitted["submittedBy"];
  if (o.submission.kind === "relayer") {
    if (!o.fee) throw new Error("relayer submission needs a fee output");
    o.onStatus?.(`Proof ready in ${(proof.ms / 1000).toFixed(1)} s; handing it to the relayer (your address never touches the chain)…`);
    const r = await relayerSubmit(o.submission.url, { proof: proof.proof, publicInputs: proof.publicSignals.map(String), noteData: o.noteData, fee: { outputIndex: o.fee.outputIndex, amount: o.fee.note.amount.toString(), noteSecret: o.fee.note.noteSecret.toString() } });
    txHash = r.txHash;
    submittedBy = "relayer";
  } else {
    o.onStatus?.(`Proof ready in ${(proof.ms / 1000).toFixed(1)} s; submitting through the connected wallet (public: the transaction is sent from your address)…`);
    txHash = await sendViaInjectedWallet(buildTransact(o.deployment.core, { proof: proof.proof, publicInputs: proof.publicInputs }, o.noteData));
    submittedBy = "wallet";
  }
  o.onStatus?.("Waiting for the transaction to be mined…");
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
  return { txHash, proofMs: proof.ms, verifiedLocally: proof.verifiedLocally, change, spent: o.spent.map((n) => n.leafIndex), submittedBy, feeWei: o.fee?.note.amount, extraLeaf };
}

/**
 * Private withdrawal of `amount` wei to `recipient` (a fresh public address or a swap-order escrow):
 * sync the tree → plan (with the relayer's fee note when submitting privately) → prove in the
 * worker → submit → record the change note with the leaf index the chain assigned.
 */
export async function privateWithdrawal(o: { masterSeed: Uint8Array; deployment: Deployment; amount: bigint; recipient: Address } & Progress): Promise<Submitted> {
  const submission = o.submission ?? settings.get().submission;
  const terms = await feeTerms(o.deployment, submission);
  await ensureSpendable({ ...o, submission, needed: o.amount });
  o.onStatus?.("Syncing the shielded tree from the core's events…");
  const tree = await syncTreeQuorum(o.deployment);
  poolStats.set({ notes: tree.notes, leaves: tree.nextLeafIndex });
  const plan = planWithdrawal(o.masterSeed, tree.leaves, BigInt(o.deployment.ethVault), o.amount, BigInt(o.recipient), txDomainOf(o.deployment), terms?.fee);
  return submitAndRecord({ ...o, submission, spec: plan.spec, noteData: plan.noteData, spent: plan.spent, change: plan.change, fee: plan.fee });
}

// ---- merges: the 2-input circuit spends at most two notes; a spend that needs more first merges
// pairs of notes into one with private self-transfers (nothing public but a transaction), each paying
// the relayer fee when submitting privately. selectInputs() names the pairs; fees shrink the merged
// note, so the schedule is re-planned after every merge.
export interface MergePlan { spec: TxSpec; noteData: [Hex, Hex, Hex]; spent: OwnedNote[]; merged: { note: Note; noteData: Hex; counter: number }; fee?: FeeOutput }

/** Merge two of our notes into one (minus the fee note when there is one). Pure. */
export function planMerge(masterSeed: Uint8Array, leaves: bigint[], vaultId: bigint, a: OwnedNote, b: OwnedNote, domain: bigint, fee?: FeeTerms): MergePlan {
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
    leaves, inputs: [asSpend(a), asSpend(b)], outputs: [mergedNote, feeOut?.note ?? dummy(vaultId), dummy(vaultId)],
    withdrawal: null, outDataHash: noteData.map((d) => noteDataHash(hexToBytes(d))) as [bigint, bigint, bigint], txDomain: domain,
  };
  return { spec, noteData, spent: [a, b], merged, fee: feeOut };
}

/** The pairs to merge (largest first, as selectInputs orders them) so that ≤ 2 notes cover `needed`, fees included. Pure; ok=false when the balance cannot get there. */
export function mergeSchedule(notes: { id: string; amount: bigint }[], needed: bigint, feePerTx: bigint, maxMerges = 8): { pairs: [string, string][]; ok: boolean } {
  let pool = notes.map((n) => ({ ...n }));
  const pairs: [string, string][] = [];
  for (let i = 0; i <= maxMerges; i++) {
    let sel: ReturnType<typeof selectInputs>;
    try { sel = selectInputs(pool, needed); } catch { return { pairs, ok: false }; }
    if (!sel.merges.length) return { pairs, ok: true };
    if (i === maxMerges) break;
    const [x, y] = sel.merges[0];
    const a = pool.find((n) => n.id === x.id)!, b = pool.find((n) => n.id === y.id)!;
    if (a.amount + b.amount <= feePerTx) return { pairs, ok: false };
    pairs.push([a.id, b.id]);
    pool = [...pool.filter((n) => n.id !== a.id && n.id !== b.id), { id: `${a.id}+${b.id}`, amount: a.amount + b.amount - feePerTx }];
  }
  return { pairs, ok: false };
}

/** Perform one merge on chain (private self-transfer) and record the merged note. */
export async function mergeNotes(o: { masterSeed: Uint8Array; deployment: Deployment; a: OwnedNote; b: OwnedNote } & Progress): Promise<Submitted & { merged: OwnedNote }> {
  const submission = o.submission ?? settings.get().submission;
  const terms = await feeTerms(o.deployment, submission);
  o.onStatus?.(`Merging two notes (${o.a.leafIndex} + ${o.b.leafIndex}) privately…`);
  const tree = await syncTreeQuorum(o.deployment);
  poolStats.set({ notes: tree.notes, leaves: tree.nextLeafIndex });
  const plan = planMerge(o.masterSeed, tree.leaves, BigInt(o.deployment.ethVault), o.a, o.b, txDomainOf(o.deployment), terms?.fee);
  const r = await submitAndRecord({ ...o, submission, spec: plan.spec, noteData: plan.noteData, spent: plan.spent, fee: plan.fee, extra: plan.merged.note });
  const merged: OwnedNote = { note: plan.merged.note, leafIndex: r.extraLeaf!, noteData: plan.merged.noteData, counter: plan.merged.counter, spent: false, txHash: r.txHash, label: "merged" };
  noteStore.add(merged);
  return { ...r, merged };
}

/** Merge until two notes cover `needed` (+ the fee of each merge and of the final spend). Returns the number of merges performed. */
export async function ensureSpendable(o: { masterSeed: Uint8Array; deployment: Deployment; needed: bigint } & Progress): Promise<number> {
  const submission = o.submission ?? settings.get().submission;
  const vaultId = BigInt(o.deployment.ethVault);
  const terms = await feeTerms(o.deployment, submission);
  const feePerTx = terms?.fee.amount ?? 0n;
  let done = 0;
  for (;;) {
    const notes = noteStore.unspent(vaultId).map((n) => ({ id: String(n.leafIndex), amount: n.note.amount }));
    const sched = mergeSchedule(notes, o.needed + feePerTx, feePerTx);
    if (!sched.ok) throw new Error("insufficient shielded balance for the amount plus the relayer fees of the merges it needs");
    if (!sched.pairs.length) return done;
    const [ia, ib] = sched.pairs[0];
    const a = noteStore.unspent(vaultId).find((n) => String(n.leafIndex) === ia)!, b = noteStore.unspent(vaultId).find((n) => String(n.leafIndex) === ib)!;
    o.onStatus?.(`${sched.pairs.length} merge(s) needed before this spend; merging notes ${a.leafIndex} + ${b.leafIndex}…`);
    await mergeNotes({ ...o, a, b, submission });
    done++;
  }
}

/** The 121-byte wallet record of a note (spec §5.1), for a manual backup / import. */
export const noteRecordHex = (note: Note, leafIndex: number): Hex => toHex(encodeNote(note, leafIndex));

/**
 * Private transfer (mode 0, spec §33 — the preferred operation): nothing public but the existence
 * of a transaction. Outputs: the recipient's note (their owner commitment, payload encrypted to
 * their view key — they find it by rescanning), our change, the relayer's fee note or a dummy.
 */
export async function privateTransfer(o: { masterSeed: Uint8Array; deployment: Deployment; amount: bigint; recipient: string } & Progress): Promise<Submitted & { recipientNote: { note: Note; leafIndex: number; record: Hex } }> {
  const to = decodePrivacyAddress(o.recipient); // throws on a malformed / mistyped address
  const submission = o.submission ?? settings.get().submission;
  const terms = await feeTerms(o.deployment, submission);
  const vaultId = BigInt(o.deployment.ethVault);
  const keys = deriveKeys(o.masterSeed);
  await ensureSpendable({ ...o, submission, needed: o.amount });
  o.onStatus?.("Syncing the shielded tree from the core's events…");
  const tree = await syncTreeQuorum(o.deployment);
  poolStats.set({ notes: tree.notes, leaves: tree.nextLeafIndex });
  const { spent, inputs, change: changeAmount } = pickInputs(keys, vaultId, o.amount + (terms?.fee.amount ?? 0n));
  const recipientNote: Note = { vaultId, amount: o.amount, ownerCommitment: to.ownerCommitment, noteSecret: randomField() };
  const change = changeNote(keys, vaultId, changeAmount);
  const fee: FeeOutput | undefined = terms ? { note: feeNote(vaultId, terms.fee), outputIndex: 2 } : undefined;
  const noteData: [Hex, Hex, Hex] = [encryptTo(to.viewPub, recipientNote), change?.noteData ?? placeholderNoteData(), fee ? encryptTo(terms!.fee.viewPub, fee.note) : placeholderNoteData()];
  const spec: TxSpec = {
    leaves: tree.leaves, inputs, outputs: [recipientNote, change?.note ?? dummy(vaultId), fee?.note ?? dummy(vaultId)],
    withdrawal: null, outDataHash: noteData.map((d) => noteDataHash(hexToBytes(d))) as [bigint, bigint, bigint], txDomain: txDomainOf(o.deployment),
  };
  const r = await submitAndRecord({ ...o, submission, spec, noteData, spent, change, fee, extra: recipientNote });
  return { ...r, recipientNote: { note: recipientNote, leafIndex: r.extraLeaf!, record: noteRecordHex(recipientNote, r.extraLeaf!) } };
}

/**
 * Note discovery (spec §12): walk every NoteInserted payload, open the ones encrypted to our view
 * key, keep only those that reproduce the leaf's commitment with OUR owner commitment, and read
 * their spent status from the core's nullifier set. Idempotent: known leaves are only updated.
 */
export async function scanNotes(o: { masterSeed: Uint8Array; deployment: Deployment } & Progress): Promise<{ scanned: number; found: number; added: number; spent: number }> {
  const keys = deriveKeys(o.masterSeed);
  const view = viewKeyPair(keys.viewKey);
  const oc = ownerCommitmentOf(keys.spendKey);
  const client = clientFor(o.deployment);
  o.onStatus?.("Scanning the core's payloads for notes encrypted to this wallet…");
  const logs = await noteInsertedLogsQuorum(o.deployment);
  poolStats.set({ notes: logs.length, leaves: logs.reduce((m, l) => Math.max(m, l.leafIndex + 1), 0) });
  let found = 0, added = 0, spentCount = 0;
  for (const l of logs) {
    const note = noteFromPayload(view, oc, l.leafIndex, l.commitment, hexToBytes(l.noteData));
    if (!note) continue;
    found++;
    const spent = (await client.readContract({ address: o.deployment.core, abi: coreAbi, functionName: "isNullifierSpent", args: [nullifier(l.commitment, keys.spendKey)] })) as boolean;
    if (spent) spentCount++;
    const known = noteStore.all().find((n) => n.leafIndex === l.leafIndex);
    if (known) {
      if (spent && !known.spent) noteStore.markSpent([l.leafIndex]);
      continue;
    }
    noteStore.add({ note, leafIndex: l.leafIndex, noteData: l.noteData, spent, txHash: l.transactionHash, label: "discovered" });
    added++;
  }
  o.onStatus?.(`Scanned ${logs.length} payloads: ${found} ours (${added} new, ${spentCount} spent).`);
  return { scanned: logs.length, found, added, spent: spentCount };
}
