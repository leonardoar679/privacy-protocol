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
import { mergeSchedule, maxAfterMerges } from "./wallet/mergeSchedule";
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
import { buildApprove, buildProtectERC20, buildProtectETH, buildShieldERC20, buildShieldNative, buildTransact, transactInputsDigest, type TxRequest } from "./privacyProtocol";
import { PRIVACY_FEE_BPS, feeMeetsTerms, protectSplit } from "@privacy-wallet/protocol/wallet/fees";
import { clientFor, depositedLogsQuorum, minedTx, otherClientsFor, sendViaInjectedWallet, syncPoolQuorum, syncTreeQuorum, txDomainOf, walletReceipt, type Deployment, type NoteInsertedLog } from "./chain";
import { isWalletConnectProvider } from "@privacy-wallet/wallet-engine/walletConnect";
import { indexSpends, rememberSpendIndex, type SpendIndex } from "./wallet/spends";
import { hasRefundCandidates, matchCommittedDeposits, refundClaims, seedRefundClaims, usedCounters, type RecoveredRefund, type RefundClaim } from "./refunds";
import { session } from "./wallet/session";
import { syncSwapRecord } from "./operations/swapRecords";
import { kickScheduler, scheduleAction } from "./wallet/schedule";
import { feeInVault, isRefusal, pickRelayer, relayerFallbacks, relayerJobFor, relayerSubmit, type RelayerInfo, type RelayerSubmitRequest } from "./relayer";
import { connectivity, whenOnline } from "@privacy-wallet/privacy-engine/transport/connectivity";
import { poolStats } from "./wallet/poolStats";
import { olderNotes, selectionOf } from "./wallet/privacyTiming";
import { provenSpent, TreeNotProven, verifyTree } from "./verifiedReads";
import { assertPublicInputsOfSpec } from "@privacy-wallet/protocol/prover";
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
export interface Progress { onStatus?: ProveStatus; /** V5 (spec §12): the typed event beside every status string, for the operation record */ onEvent?: OnEvent; submission?: Submission; record?: false | Partial<ActivityRecord>; /** the connected account the Review showed (the eighth review round, C-L6): every prompt of the flow is sent from it, or refused */ account?: string }

/**
 * V5 (spec §17, the SDK facade): a shield in three steps. `prepareShield` builds the note and the calldata (and spends
 * one note counter); `submitShield` asks the connected wallet (an exact-amount approval first for an ERC-20), reports
 * the typed events beside the status strings, and `trackShield` waits for the receipt and journals the note at the
 * leaf the chain assigned. Shielding is a PUBLIC deposit (amount visible); privacy comes from later private transfers.
 */
/** `amount` is what the user puts in; `fee` the privacy fee ProtectRouter takes from it (0 without a router); the note holds the rest. */
export interface PreparedShield { deployment: Deployment; vault: Address; token: Address | null; amount: bigint; fee: bigint; note: Note; noteData: Hex; counter: number; approve?: TxRequest; deposit: TxRequest; /** the wallet's opening its note was made in: every prompt is refused in another (D-1) */ epoch?: number }

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
  return { deployment: o.deployment, vault, token, amount: o.amount, fee, note, noteData, counter, ...shieldTxs(o.deployment, vault, token, o.amount, note, noteData), epoch: session.epoch() };
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
  // the opening the deposit was prepared in (the eleventh review round, 2026-11-04, A11-2): read here, after the prompt, a REPLACE made while
  // the wallet asked would have recorded the deposit's note in the other wallet
  const epoch = p.epoch ?? session.epoch();
  // the receipt through the connected wallet's own provider only (the sixth review round, 2026-11-03): its `from` is the user's public
  // address, which the privacy endpoints must never see beside this client — the scan's proven pool contradicts a note a lying provider
  // would have invented (audit round 2, r24)
  const got = await walletReceipt(txHash, { stop: () => session.epoch() !== epoch, chainId: p.deployment.chainId });
  // stopped by a lock (the eighth review round, B-6): the endpoints are never asked for a receipt whose `from` is the public address
  if (!("receipt" in got) && session.epoch() !== epoch)
    throw Object.assign(new Error("the wallet was locked before the deposit was recorded; it is sent, and the next scan records its note"), { code: "locked_after_send" });
  // ... nor when the wallet gives none — another network, reads that fail as WalletConnect's do under the policy, ten minutes without one
  // (the eleventh review round, F11-10: every endpoint had been asked): the deposit is sent, and the scan records its note from the pool
  if (!("receipt" in got))
    throw Object.assign(new Error(`the connected wallet gave no receipt for the deposit (${got.none}); it is sent, and the next scan records its note`), {
      code: "deposit_unconfirmed",
    });
  const { inserted, costWei } = await minedTx(clientFor(p.deployment), txHash, undefined, [], { receipt: got.receipt });
  const mine = inserted.find((i) => i.commitment === noteCommitment(noteBody(p.note), BigInt(i.leafIndex)));
  if (!mine) throw new Error("the deposit was mined but its commitment was not found in the receipt");
  // the wallet this flow belongs to (the third review round, 2026-11-03): after a lock — and a REPLACE with another phrase in the same tab —
  // the deposit's note had gone into whatever store was open; the right wallet's scan finds it from its self-envelope
  if (session.epoch() !== epoch) throw Object.assign(new Error("the wallet was locked before the deposit was recorded; it is mined, and the next scan records its note"), { code: "locked_after_send" }); // sent: never "not moved" (the sixth review round, 2026-11-03)
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
  // unread (the eighth review round, C-L7: a WalletConnect provider sends reads to a host the policy blocks): cleared first, as any other
  return [...(open === null || open > 0n ? [buildApprove(token, spender, 0n)] : []), buildApprove(token, spender, amount)];
}

/** The connected account's allowance toward `spender` (`owner`: the account the flow is bound to), read through its own provider; null when there is none to read. */
async function openAllowance(token: Address, spender: Address, owner?: string): Promise<bigint | null> {
  const eth = activeProvider();
  if (!eth) return null;
  try {
    const [now] = owner ? [owner] : ((await eth.request({ method: "eth_accounts" })) as string[]);
    return now ? await readAllowance(token, now as Address, spender, eth) : null;
  } catch {
    return null;
  }
}
/** The account the connected wallet names now (eth_accounts), or undefined. */
async function currentAccount(): Promise<string | undefined> {
  const eth = activeProvider();
  if (!eth) return undefined;
  try {
    const [a] = (await eth.request({ method: "eth_accounts" })) as string[];
    return a || undefined;
  } catch {
    return undefined;
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
/**
 * V7 Stage 16 (spec v3.0 §9): a Protect stops prompting the external wallet once the session is locked — a phone's handoff can
 * lock the page between two prompts (the hold defers an automatic lock; an explicit one, or another tab's, does not wait).
 * What was sent stays sent, nothing more is asked, and the record reads interrupted (nothing moved by the missing prompt).
 */
function assertStillUnlocked(epoch?: number): void {
  // the same opening, not only an unlocked one (the tenth review round, D-1): a lock and a quick unlock between two awaits had let a
  // flow prompt with what it made from the seed the lock zeroed
  if (!session.isUnlocked() || (epoch !== undefined && session.epoch() !== epoch))
    throw Object.assign(new Error("the wallet locked before the next prompt: nothing more is sent"), { code: "locked_mid_flow" });
}
/** The opening a flow started in, refused once the wallet locked or another phrase replaced it (D-1); `what` names the step. */
function sameOpening(epoch: number, what = "the wallet locked before anything was sent"): void {
  if (!session.isUnlocked() || session.epoch() !== epoch) throw Object.assign(new Error(what), { code: "locked_mid_flow" });
}
async function submitShieldHeld(p: PreparedShield, o: Progress & { estimatedWei?: bigint }): Promise<{ approveTx?: Hex; txHash: Hex; leafIndex: number }> {
  await guardDeployment(p.deployment); // V6 Stage 10 (doc §71): the deployment is checked before the first operation
  let approveTx: Hex | undefined;
  let approvalWei = 0n;
  // an ERC-20 is approved for exactly this amount, from what the connected account has open (a V6 follow-up of 2026-10-16):
  // a deposit that failed or was refused leaves its approval, and USDT refuses to change one non-zero allowance to another
  const spender = p.deployment.protectRouter ?? p.vault;
  const whom = p.deployment.protectRouter ? "the protect router" : "the vault";
  // one account for every prompt of the flow (the eighth review round, 2026-11-03, C-L6): the Review's, else the one named at the start;
  // an account changed between the approval and the deposit had sent the deposit from another account than the one reviewed
  const account = o.account ?? (await currentAccount());
  const approvals = p.approve && p.token ? approvalsFor(await openAllowance(p.token, spender, account), p.token, spender, p.amount) : [];
  const n = approvals.length + 1;
  for (const [k, tx] of approvals.entries()) {
    const clearing = approvals.length === 2 && k === 0;
    o.onStatus?.(`${k + 1}/${n} ${clearing ? `Clearing the earlier approval of ${whom}` : `Approving ${whom} for exactly this amount`} (connected wallet)…`);
    assertStillUnlocked(p.epoch);
    // the account it is sent from, kept for the stale mover: only that account's wallet is ever asked about it (the critique of F11-10)
    o.onEvent?.({ type: "wallet-prompt", step: "approve", i: k + 1, n, noteCounter: p.counter, ...(account ? { sender: account } : {}) });
    const epoch = session.epoch();
    const hash = await sendViaInjectedWallet(tx, p.deployment.chainId, account);
    // through the connected wallet's own provider first (the sixth review round, 2026-11-03): the approval's `from` is the user's public
    // address — and never the endpoints after a lock (the ninth review round, B-I3), as the deposit's receipt: the approval stays open for
    // exactly this amount, nothing is deposited
    const got = await walletReceipt(hash, { stop: () => session.epoch() !== epoch, chainId: p.deployment.chainId });
    if (!("receipt" in got) && session.epoch() !== epoch)
      throw Object.assign(new Error("the wallet locked before the next prompt: nothing more is sent (the approval sent stays open for exactly this amount)"), { code: "locked_mid_flow" });
    // on another network, without a provider, or ten minutes without a receipt, nothing more is sent (the eleventh review round, F11-10:
    // the first endpoint had been asked). WalletConnect's provider, which answered no read — its reads go to a host the policy blocks —, has
    // its approval's receipt read from the first endpoint, the one exception (audit gap 100): that endpoint then holds this IP beside the
    // public address; without it no ERC-20 could be protected through WalletConnect. Any other wallet stops (one whose reads fail after it
    // answered is read on, to the time: the critique of F11-10), and the deposit after it is never asked of an endpoint
    if (!("receipt" in got) && !(got.none === "unreadable" && isWalletConnectProvider(activeProvider())))
      throw Object.assign(new Error(`the connected wallet gave no receipt for the approval (${got.none}): nothing is deposited`), { code: "approval_unconfirmed" });
    const approval = "receipt" in got ? got.receipt : await clientFor(p.deployment).waitForTransactionReceipt({ hash });
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
  assertStillUnlocked(p.epoch);
  o.onEvent?.({ type: "wallet-prompt", step: "deposit", i: n, n, noteCounter: p.counter, ...(account ? { sender: account } : {}) });
  const txHash = await sendViaInjectedWallet(p.deposit, p.deployment.chainId, account);
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
  const epoch = session.epoch();
  await noteStore.untilScanned(); // the scan after an unlock first (the fifth review round, 2026-11-03): the note's counter is handed out after it
  sameOpening(epoch); // a lock during the wait (the tenth review round, D-1)
  const r = await submitShield(prepareShield({ masterSeed: o.masterSeed, deployment: o.deployment, amount: o.amount }), o);
  return { txHash: r.txHash, leafIndex: r.leafIndex };
}

/**
 * Public shield of `amount` token units into the token's canonical ERC-20 vault (plan §36): an exact-amount
 * approve, then the vault's deposit (it pulls the tokens and inserts the note). Two transactions through the
 * connected wallet; the second waits for the first to be mined.
 */
export async function shieldERC20(o: { masterSeed: Uint8Array; deployment: Deployment; token: Address; vault: Address; amount: bigint; estimatedWei?: bigint } & Progress): Promise<{ approveTx?: Hex; txHash: Hex; leafIndex: number }> {
  const epoch = session.epoch();
  await noteStore.untilScanned(); // the scan after an unlock first (the fifth review round, 2026-11-03)
  sameOpening(epoch); // a lock during the wait (the tenth review round, D-1)
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
  throw new NoRelayer(errors);
}

/**
 * The relayer's terms read again after a spend's merges (the eighth review round, B-8), from the first read's relayer alone (the ninth review
 * round, 2026-11-04, B-F4): a read that fails, or a fee above the first read's — which the merges were planned for and the Review's bound
 * held —, keeps the first terms; the relayer checks its fee again at the submission. The fallbacks' walk and a failed read had failed the
 * spend after its merges were paid (`no_relayer`, `fee_moved`).
 */
async function feeAfterMerges<T extends { url: string; info: RelayerInfo; fee: FeeTerms }>(
  deployment: Deployment,
  submission: Submission,
  vault: Address,
  terms: T | null,
  merges: number,
  delivered: bigint,
): Promise<T | null> {
  if (merges <= 0 || !terms || submission.kind !== "relayer") return terms;
  const fresh = await feeTerms(deployment, { ...submission, url: terms.url }, vault, [], { delivered }).catch(() => null);
  return fresh && fresh.url === terms.url && fresh.fee.amount <= terms.fee.amount ? ({ ...terms, info: fresh.info, fee: fresh.fee } as T) : terms;
}

/**
 * No relayer of Settings serves this asset (2026-10-17, the audit's unverified m56): thrown before anything is proved or
 * sent. Its message names each relayer's answer, "unreachable" among them, and that word had classified it as
 * `relayer_unreachable` — funds of unknown whereabouts, "We are checking where your funds are" — for a spend that never left.
 */
export class NoRelayer extends Error {
  readonly code = "no_relayer";
  constructor(readonly answers: string[]) {
    super(`no relayer available for this asset (${answers.join("; ")}); switch submission to the connected wallet (public) or add a relayer`);
    this.name = "NoRelayer";
  }
}

export interface Submitted { txHash: Hex; proofMs: number; verifiedLocally: boolean; change?: OwnedNote; spent: number[]; submittedBy: "relayer" | "wallet"; feeWei?: bigint; extraLeaf?: number; /** the extra note, when it is this wallet's (A11-10) */ extraNote?: OwnedNote }

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

/**
 * The transaction a spend was handed back is not the one that spends its notes (the audit round of 2026-10-16, c31): a
 * replacement, a cancel in the connected wallet, a relayer naming another transaction. Its notes are not marked spent —
 * nothing would ever have cleared the flag, and the balance would have lost them — and where the spend went is not known:
 * the next scan reads its nullifiers.
 */
export class NotThisSpend extends Error {
  readonly code = "not_this_spend";
  constructor(readonly txHash: Hex) {
    super(`transaction ${txHash} was mined, but it does not spend this transaction's notes: none was marked spent`);
    this.name = "NotThisSpend";
  }
}

/**
 * The fee a spend pays against the one its Review showed (`maxFee`, in the vault's base units). The terms are read again at
 * submit, and the relayer prices its minimum from the gas price at every read: a fresh fee at or below the Review's is paid;
 * above it, the Review's own is paid while it still meets the relayer's live rule — the margin this wallet adds to the
 * minimum is for just that move between the Review and the submission —, and only a fee the relayer would now refuse is
 * FeeMoved (audit round 2, r09: any rise had been refused, and a Send or a swap's funding stopped on every gas uptick).
 * `live`: the relayer's minimum now, without this wallet's margin; `delivered`: what leaves for the recipient.
 */
export function feeWithinReview(fresh: bigint, maxFee: bigint | undefined, live: { minimum: bigint; feePercentBps: number }, delivered: bigint): bigint {
  if (maxFee === undefined || fresh <= maxFee) return fresh;
  if (feeMeetsTerms(delivered, maxFee, live.feePercentBps, live.minimum).ok) return maxFee;
  throw new FeeMoved(maxFee, fresh);
}

/** The terms a spend pays with: their fee bounded by the Review's (`feeWithinReview`). */
function boundFee(terms: { info: RelayerInfo; fee: FeeTerms } | null, maxFee: bigint | undefined, vault: Address, delivered: bigint): void {
  if (!terms) return;
  const minimum = feeInVault(terms.info, vault, 0) ?? terms.fee.amount; // the relayer's own, without this wallet's margin
  terms.fee = { ...terms.fee, amount: feeWithinReview(terms.fee.amount, maxFee, { minimum, feePercentBps: terms.info.feePercentBps ?? 0 }, delivered) };
}

/**
 * A retry refused after the first attempt's answer was lost, whose job the relayer could not name (audit round 2, r44):
 * the first may still be on its way — the relayer stores a job only once it is sent, and refuses a re-priced fee or a rate
 * before it checks the notes in flight —, so the outcome is unknown, never "not moved"; the chain settles it.
 */
export class AnswerLost extends Error {
  readonly code = "relayer_unreachable";
  constructor(readonly refusal: unknown) {
    super(`the relayer's answer to this spend was lost and the retry was refused (${(refusal as Error)?.message ?? String(refusal)}): the first attempt may still be sent, and the chain is read before anything is sent again`);
    this.name = "AnswerLost";
  }
}

/**
 * Hand a proven spend to the relayer. V6 Stage 15 (doc §75): nothing is submitted while offline; an attempt the network
 * swallowed may have reached the relayer, so once back the state is verified — the relayer's job for these nullifiers —
 * before anything is sent again, and a refused retry whose job it cannot name is AnswerLost. `io`: the relayer's calls.
 */
export async function submitToRelayer(
  url: string,
  body: RelayerSubmitRequest,
  nullifiers: [bigint, bigint],
  o: Progress = {},
  io: { submit: typeof relayerSubmit; jobFor: typeof relayerJobFor } = { submit: relayerSubmit, jobFor: relayerJobFor },
): Promise<{ txHash: Hex }> {
  let unanswered = false;
  for (let attempt = 1; ; attempt++) {
    await whenOnline();
    try {
      return await io.submit(url, body);
    } catch (e) {
      if (isRefusal(e)) {
        if (!unanswered) throw e; // the first attempt refused: nothing was sent
        // after a lost answer the relayer refuses the same spend again (in flight, or already mined): its job is the answer
        const known = await io.jobFor(url, nullifiers).catch(() => null);
        if (known) return known;
        throw new AnswerLost(e);
      }
      unanswered = true;
      if (!connectivity.get().online) { attempt--; continue; } // offline: wait for the connection, the attempt does not count
      if (attempt >= 3) throw e;
      o.onStatus?.(`Relayer unreachable (attempt ${attempt}); retrying…`);
      o.onEvent?.({ type: "relayer-retry", attempt });
      await new Promise((res) => setTimeout(res, 1500 * attempt));
    }
  }
}

/**
 * A withdrawal mined whose payout its recipient refused (audit round 2, r42; a contract that takes no ETH, a token's
 * blacklisted holder): the vault holds it as that address's claim. `claim(recipient)` pays it there later, and an address
 * that can never take it leaves it in the vault. The notes are spent. The Send had read "sent" while nothing arrived.
 */
export class PayoutHeld extends Error {
  readonly code = "payout_held";
  constructor(readonly recipient: Address, readonly amount: bigint, readonly vault: Address, readonly txHash: Hex) {
    super(`the recipient ${recipient} did not take the payment: the vault holds it as that address's claim (transaction ${txHash})`);
    this.name = "PayoutHeld";
  }
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
async function submitAndRecordHeld(o: { deployment: Deployment; spec: TxSpec; noteData: [Hex, Hex, Hex]; spent: OwnedNote[]; change?: WithdrawalPlan["change"]; fee?: FeeOutput; extra?: Note; /** the extra note is this wallet's (a merge's, a split's piece): recorded with the change note (A11-10) */ extraOwn?: { noteData: Hex; counter: number; label: string }; submission: Submission; relayerUrl?: string; /** the opening the spend was planned in: nothing is sent in another (D-1, D-10) */ opening?: number; /** V6: the relayer's network charge (its F) in the fee's asset */ network?: { amount: bigint; asset: string; decimals: number }; /** a withdrawal's payout: refused by its recipient, it is PayoutHeld (r42) */ payout?: { vault: Address; recipient: Address } } & Progress): Promise<Submitted> {
  const client = clientFor(o.deployment);
  const epoch = session.epoch();
  o.onEvent?.({ type: "proving" });
  // V6 Stage 15 (spec v2.0 §14.3): the plan goes to the prover, which builds the circuit inputs where it proves (the
  // crypto worker on the web) — and throws, as the builder always did, when a note does not open its leaf or the value
  // is not conserved
  const proof = await prove(o.spec, o.onStatus);
  // the proof's public inputs are the plan's (the third review round, 2026-11-03; defence in depth): recomputed here from the spec this
  // thread made, so a prover that answered another recipient, amount, nullifier or payload hash sends nothing
  assertPublicInputsOfSpec(proof.publicInputs, o.spec);
  // nothing is sent from a wallet that locked while it proved (audit round 2, r19): its record, locked out, still reads the
  // proof step, and a reconcile would call a mined spend "nothing moved"
  // nor from another opening (the tenth review round, D-1/D-10): a spend planned before a lock had been sent after a quick unlock
  if (!session.isUnlocked() || (o.opening !== undefined && session.epoch() !== o.opening))
    throw Object.assign(new Error("the wallet locked before anything was sent"), { code: "locked_mid_flow" });
  o.onEvent?.({ type: "proved", ms: proof.ms, verifiedLocally: proof.verifiedLocally });
  // the call's identity, kept by the record at its submission (the sixth review round, 2026-11-03): a lost answer is settled only by a
  // transaction with exactly these public inputs — two Sends of one note share the nullifier pair, never these
  const inputsDigest = transactInputsDigest(buildTransact(o.deployment.core, { proof: proof.proof, publicInputs: proof.publicInputs }, o.noteData).data) ?? undefined;
  let txHash: Hex;
  let submittedBy: Submitted["submittedBy"];
  if (o.submission.kind === "relayer") {
    if (!o.fee) throw new Error("relayer submission needs a fee output");
    o.onStatus?.(`Proof ready in ${(proof.ms / 1000).toFixed(1)} s; handing it to the relayer (your address never touches the chain)…`);
    const url = o.relayerUrl ?? o.submission.url;
    const nullifiers: [bigint, bigint] = [proof.publicInputs.nullifier0, proof.publicInputs.nullifier1];
    o.onEvent?.({ type: "submitting", by: "relayer", nullifiers: [nullifiers[0].toString(), nullifiers[1].toString()], relayerUrl: url, ...(o.change ? { noteCounter: o.change.counter } : {}), ...(inputsDigest ? { inputsDigest } : {}) });
    const body = { proof: proof.proof, publicInputs: proof.publicSignals.map(String), noteData: o.noteData, fee: { outputIndex: o.fee.outputIndex, amount: o.fee.note.amount.toString(), noteSecret: o.fee.note.noteSecret.toString(), vault: ("0x" + o.fee.note.vaultId.toString(16).padStart(40, "0")) as Address } };
    const r = await submitToRelayer(url, body, nullifiers, o);
    txHash = r.txHash;
    submittedBy = "relayer";
    o.onEvent?.({ type: "submitted", txHash, by: "relayer" });
  } else {
    o.onStatus?.(`Proof ready in ${(proof.ms / 1000).toFixed(1)} s; submitting through the connected wallet (public: the transaction is sent from your address)…`);
    o.onEvent?.({ type: "submitting", by: "wallet", nullifiers: [proof.publicInputs.nullifier0.toString(), proof.publicInputs.nullifier1.toString()], ...(o.change ? { noteCounter: o.change.counter } : {}), ...(inputsDigest ? { inputsDigest } : {}) });
    o.onEvent?.({ type: "wallet-prompt", step: "transact", i: 1, n: 1 });
    txHash = await sendViaInjectedWallet(buildTransact(o.deployment.core, { proof: proof.proof, publicInputs: proof.publicInputs }, o.noteData), o.deployment.chainId, o.account); // the Review's account (C-L6)
    submittedBy = "wallet";
    o.onEvent?.({ type: "submitted", txHash, by: "wallet" });
  }
  o.onStatus?.("Waiting for the transaction to be mined…");
  o.onEvent?.({ type: "waiting-receipt", txHash });
  const { inserted, costWei, spends, claims, blockNumber } = await minedTx(client, txHash, o.deployment.core, otherClientsFor(o.deployment)); // every endpoint's receipt (audit round 2, r23)
  // the notes are spent by this transaction, or by none the wallet knows of (c31)
  const [n0, n1] = [proof.publicInputs.nullifier0, proof.publicInputs.nullifier1];
  if (!spends.some(([a, b]) => a === n0 && b === n1)) throw new NotThisSpend(txHash);
  // the wallet this flow belongs to (the third review round, 2026-11-03): after a lock — and a REPLACE with another phrase in the same tab —
  // the spent marks, the change note and the Activity line had gone into whatever store and journal were open; the right wallet's
  // scan reads the spends and finds its change note from its self-envelope
  if (session.epoch() !== epoch) throw Object.assign(new Error("the wallet was locked before the result was recorded; the transaction stands, and the next scan records it"), { code: "locked_after_send" }); // sent: never "not moved" (the sixth review round, 2026-11-03)
  noteStore.markSpent(o.spent.map((n) => n.leafIndex), { atBlock: blockNumber }); // one confirmation: proven by the scan at a finalized block
  const find = (n: Note) => inserted.find((i) => i.commitment === noteCommitment(noteBody(n), BigInt(i.leafIndex)));
  let change: OwnedNote | undefined;
  if (o.change) {
    const hit = find(o.change.note);
    if (!hit) throw new Error("mined, but the change note's commitment was not found in the receipt");
    change = { note: o.change.note, leafIndex: hit.leafIndex, noteData: o.change.noteData, counter: o.change.counter, spent: false, txHash, label: "change" };
    noteStore.add({ ...change, addedAt: Date.now() });
  }
  let extraLeaf: number | undefined;
  let extraNote: OwnedNote | undefined;
  if (o.extra) {
    const hit = find(o.extra);
    if (!hit) throw new Error("mined, but the recipient's note commitment was not found in the receipt");
    extraLeaf = hit.leafIndex;
    // this wallet's own extra note goes in here, in the same synchronous block as the change note (the eleventh review round, A11-10): the
    // spend's hold is released on return, a lock due by then happens inside that release, and a note added after it went into the closed store
    if (o.extraOwn) {
      extraNote = { note: o.extra, leafIndex: hit.leafIndex, noteData: o.extraOwn.noteData, counter: o.extraOwn.counter, spent: false, txHash, label: o.extraOwn.label };
      noteStore.add({ ...extraNote, addedAt: Date.now() });
    }
  }
  // V6 (spec v2.0 §3): the real cost beside what the relayer charged for it (its F; for the ETH vault also the estimate shown)
  const charged = submittedBy === "relayer" ? o.network : undefined;
  o.onEvent?.({ type: "costs", actualWei: costWei, ...(charged ? { charged, ...(charged.asset === "ETH" && charged.decimals === 18 ? { estimatedWei: charged.amount } : {}) } : {}) });
  // its payout refused by the recipient (audit round 2, r42): held by the vault as that address's claim, never "sent"
  const payout = o.payout;
  const held = payout ? (claims ?? []).find((c) => c.vault.toLowerCase() === payout.vault.toLowerCase() && c.recipient.toLowerCase() === payout.recipient.toLowerCase()) : undefined;
  if (held) throw new PayoutHeld(held.recipient, held.amount, held.vault, txHash);
  // V5 (spec §12): the record's COMPLETED needs the settlement reference — the mined transaction and the leaf of the note it left (the recipient's, else the change)
  o.onEvent?.({ type: "mined", txHash, ...(extraLeaf !== undefined ? { leafIndex: extraLeaf } : change ? { leafIndex: change.leafIndex } : {}) });
  return { txHash, proofMs: proof.ms, verifiedLocally: proof.verifiedLocally, change, spent: o.spent.map((n) => n.leafIndex), submittedBy, feeWei: o.fee?.note.amount, extraLeaf, ...(extraNote ? { extraNote } : {}) };
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

async function privateWithdrawalInTurn(o: { masterSeed: Uint8Array; deployment: Deployment; amount: bigint; recipient: Address; vault?: Address; maxTiming?: number; /** the relayer's fee the Review showed: a higher one stops the spend (FeeMoved) */ maxFee?: bigint; /** each merge's fee the Review showed (r43) */ maxMergeFee?: bigint; /** the merges the Review named (the eighth review round, B-2) */ maxMerges?: number; /** run inside the spend's turn before anything is read or proved (the review round of 2026-11-03, E1): a caller's own re-check */ beforeSpend?: () => void | Promise<void> } & Progress): Promise<Submitted> {
  const opening = session.epoch();
  await o.beforeSpend?.();
  await guardDeployment(o.deployment);
  // a V6 follow-up of 2026-10-16: never to an address that loses what it receives (the zero or a burn address, a contract of
  // this deployment or of one of its tokens) — refused before anything is proved or sent
  guardRecipient(o.deployment, o.recipient);
  const submission = o.submission ?? settings.get().submission;
  const vault = o.vault ?? o.deployment.ethVault;
  o.onEvent?.({ type: "fee-terms" });
  let terms = await feeTerms(o.deployment, submission, vault, undefined, { delivered: o.amount });
  boundFee(terms, o.maxFee, vault, o.amount);
  const needed = o.amount + (terms?.fee.amount ?? 0n);
  // older notes only: checked before any merge (a merge would make a new note), and again on the synced pool's numbers
  if (o.maxTiming !== undefined) olderInputs(vault, o.maxTiming, needed);
  const merges = await ensureSpendableInTurn({ ...o, submission, vault, needed: o.amount, finalFee: terms?.fee.amount ?? 0n });
  // the fee and the relayer read again after merges (the eighth review round, B-8): minutes of proving and mining later, the first
  // read's relayer could refuse the fee it named, and the spend failed after its merges were paid
  terms = await feeAfterMerges(o.deployment, submission, vault, terms, merges, o.amount);
  o.onStatus?.("Syncing the shielded tree from the core's events…");
  o.onEvent?.({ type: "syncing" });
  const tree = await syncTreeQuorum(o.deployment);
  o.onEvent?.({ type: "verifying" });
  await verifyTree(o.deployment, tree, o.onStatus); // plan §38: the tree must contain the pool proven at the latest finalized block
  poolStats.set({ notes: tree.notes, leaves: tree.nextLeafIndex });
  const from = o.maxTiming !== undefined ? olderInputs(vault, o.maxTiming, needed) : undefined;
  await noteStore.untilScanned(); // the scan after an unlock first (the fifth review round, 2026-11-03): the change note's counter is handed out after it
  sameOpening(opening); // a lock since the spend began (the tenth review round, D-1)
  const plan = planWithdrawal(o.masterSeed, tree.layers, BigInt(vault), o.amount, BigInt(o.recipient), txDomainOf(o.deployment), terms?.fee, from);
  const r = await submitAndRecord({ ...o, submission, relayerUrl: terms?.url, network: networkCharge(o.deployment, terms, vault), spec: plan.spec, noteData: plan.noteData, spent: plan.spent, change: plan.change, fee: plan.fee, payout: { vault, recipient: o.recipient }, opening });
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

/**
 * The spend needs more merges first than its Review named (the eighth review round, 2026-11-03, B-2): the notes changed since — a
 * housekeeping split, another spend, a delayed funding hours later. Thrown before any merge is paid; the Review is shown again.
 * The merges had run at the relayer's live fee, unbounded and unshown, whenever the Review had counted none.
 */
export class MergesMoved extends Error {
  readonly code = "merges_moved";
  constructor(readonly reviewed: number, readonly now: number) {
    super(`this spend now needs ${now} merge(s) first, more than the ${reviewed} its Review named: nothing was sent`);
    this.name = "MergesMoved";
  }
}

/** The balance is there but spread over too many notes for one spend (plan V2 §73): housekeeping consolidates it. */
export class HousekeepingNeeded extends Error {
  constructor(readonly notes: number, readonly merges: number, symbol: string) {
    super(`Your ${symbol} balance is spread over ${notes} notes; this spend needs more than ${merges} merges and the wallet does at most ${merges} in one go. Private balance maintenance consolidates them (Settings), or send a smaller amount now.`);
  }
}

/** Perform one merge on chain (private self-transfer) and record the merged note. */
async function mergeNotesInTurn(o: { masterSeed: Uint8Array; deployment: Deployment; a: OwnedNote; b: OwnedNote; /** the merge fee the Review showed: a higher one stops it (FeeMoved; audit round 2, r43) */ mergeFee?: bigint } & Progress): Promise<Submitted & { merged: OwnedNote }> {
  const opening = session.epoch();
  await guardDeployment(o.deployment);
  const submission = o.submission ?? settings.get().submission;
  const vaultId = o.a.note.vaultId;
  if (o.b.note.vaultId !== vaultId) throw new Error("cannot merge notes of different assets");
  const vault = ("0x" + vaultId.toString(16).padStart(40, "0")) as Address;
  const terms = await feeTerms(o.deployment, submission, vault);
  boundFee(terms, o.mergeFee, vault, 0n);
  o.onStatus?.(`Merging two notes (${o.a.leafIndex} + ${o.b.leafIndex}) privately…`);
  const tree = await syncTreeQuorum(o.deployment);
  o.onEvent?.({ type: "verifying" });
  await verifyTree(o.deployment, tree, o.onStatus); // plan §38: the tree must contain the pool proven at the latest finalized block
  poolStats.set({ notes: tree.notes, leaves: tree.nextLeafIndex });
  await noteStore.untilScanned(); // the scan after an unlock first (the fifth review round, 2026-11-03)
  sameOpening(opening); // a lock since the merge began (the tenth review round, D-1)
  const plan = planMerge(o.masterSeed, tree.layers, vaultId, o.a, o.b, txDomainOf(o.deployment), terms?.fee);
  const r = await submitAndRecord({ ...o, submission, relayerUrl: terms?.url, spec: plan.spec, noteData: plan.noteData, spent: plan.spent, fee: plan.fee, extra: plan.merged.note, extraOwn: { noteData: plan.merged.noteData, counter: plan.merged.counter, label: "merged" }, opening });
  const merged: OwnedNote = r.extraNote ?? { note: plan.merged.note, leafIndex: r.extraLeaf!, noteData: plan.merged.noteData, counter: plan.merged.counter, spent: false, txHash: r.txHash, label: "merged" };
  recordActivity({ id: activityId("housekeeping", r.txHash), kind: "housekeeping", ...activityAsset(o.deployment, vaultId), amount: merged.note.amount.toString(), status: "completed", ref: r.txHash, note: "two notes merged privately before a spend" });
  return { ...r, merged };
}

/**
 * What Max can spend from a vault (the audit's unverified m55, 2026-10-17): the balance, less the relayer's minimum for each
 * merge that brings the notes down to two (none through the connected wallet, whose merges pay no fee note). Max had been
 * the whole balance: the merges were paid and the spend then failed as more than what they left.
 */
export async function maxSpendable(deployment: Deployment, vault: Address, submission: Submission = settings.get().submission): Promise<bigint> {
  const notes = noteStore.unspent(BigInt(vault)).map((n) => n.note.amount);
  if (notes.length <= 2) return notes.reduce((a, b) => a + b, 0n);
  const terms = await feeTerms(deployment, submission, vault);
  return maxAfterMerges(notes, terms?.fee.amount ?? 0n);
}

/** Merge until two notes cover `needed` (+ the fee of each merge and of the final spend). Returns the number of merges performed. */
async function ensureSpendableInTurn(o: { masterSeed: Uint8Array; deployment: Deployment; needed: bigint; vault?: Address; /** the fee of the spend these merges are for (its p + F); read for `needed` when absent */ finalFee?: bigint; /** each merge's fee as the Review showed it (audit round 2, r43) */ maxMergeFee?: bigint; /** the merges the Review named (the eighth review round, B-2): more is MergesMoved before any is paid */ maxMerges?: number } & Progress): Promise<number> {
  const submission = o.submission ?? settings.get().submission;
  const vault = o.vault ?? o.deployment.ethVault;
  const vaultId = BigInt(vault);
  const terms = await feeTerms(o.deployment, submission, vault); // a merge's own fee: the minimum (a self-transfer)
  // the merges' fee the Review showed bounds each of them (audit round 2, r43): unshown and unbounded, a gas spike during the
  // merges — minutes apart, each needing a proof — was paid in full, before the spend itself was refused for its fee. Only a
  // merge that is needed is refused for it (and mergeNotesInTurn bounds each one again, at its own read of the terms)
  let moved: FeeMoved | null = null;
  try {
    boundFee(terms, o.maxMergeFee, vault, 0n);
  } catch (e) {
    if (!(e instanceof FeeMoved)) throw e;
    moved = e;
  }
  const feePerTx = terms?.fee.amount ?? 0n;
  // the spend these merges are for pays the percentage of what it delivers besides the minimum (the audit round of
  // 2026-10-16, c33): planned for the minimum alone, an amount just under a note pair's sum was never merged for, and the
  // spend then failed on two notes that could not pay its own fee
  const finalFee = o.finalFee ?? (terms ? ((await feeTerms(o.deployment, submission, vault, undefined, { delivered: o.needed }))?.fee.amount ?? feePerTx) : 0n);
  let done = 0;
  for (;;) {
    const notes = noteStore.unspent(vaultId).map((n) => ({ id: String(n.leafIndex), amount: n.note.amount }));
    const sched = mergeSchedule(notes, o.needed + finalFee, feePerTx);
    if (!sched.ok && sched.reason === "too-many-merges") throw new HousekeepingNeeded(notes.length, 8, assetByVault(o.deployment, vault)?.symbol ?? "private");
    if (!sched.ok) throw new Error("insufficient shielded balance for the amount plus the relayer fees of the merges it needs");
    if (!sched.pairs.length) return done;
    if (o.maxMerges !== undefined && done + sched.pairs.length > o.maxMerges) throw new MergesMoved(o.maxMerges, done + sched.pairs.length);
    if (moved) throw moved;
    const [ia, ib] = sched.pairs[0];
    const a = noteStore.unspent(vaultId).find((n) => String(n.leafIndex) === ia)!, b = noteStore.unspent(vaultId).find((n) => String(n.leafIndex) === ib)!;
    o.onStatus?.(`${sched.pairs.length} merge(s) needed before this spend; merging notes ${a.leafIndex} + ${b.leafIndex}…`);
    o.onEvent?.({ type: "merging", i: done + 1, n: done + sched.pairs.length });
    await mergeNotesInTurn({ ...o, a, b, submission, ...(o.maxMergeFee !== undefined ? { mergeFee: o.maxMergeFee } : {}) });
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
async function splitNoteInTurn(o: { masterSeed: Uint8Array; deployment: Deployment; note: OwnedNote; piece: bigint; /** the fee its caller checked (housekeeping's daily cap): a higher one stops it, FeeMoved (the eighth review round, B-1) */ maxFee?: bigint } & Progress): Promise<Submitted & { pieceNote: OwnedNote; restNote: OwnedNote }> {
  const opening = session.epoch();
  await guardDeployment(o.deployment);
  const submission = o.submission ?? settings.get().submission;
  const vaultId = o.note.note.vaultId;
  const vault = ("0x" + vaultId.toString(16).padStart(40, "0")) as Address;
  const terms = await feeTerms(o.deployment, submission, vault);
  boundFee(terms, o.maxFee, vault, 0n); // the second read had been paid whatever it said: up to the note less the piece
  o.onStatus?.(`Splitting a note (${o.note.leafIndex}) into a common-sized piece privately…`);
  const tree = await syncTreeQuorum(o.deployment);
  o.onEvent?.({ type: "verifying" });
  await verifyTree(o.deployment, tree, o.onStatus); // plan §38: the tree must contain the pool proven at the latest finalized block
  poolStats.set({ notes: tree.notes, leaves: tree.nextLeafIndex });
  await noteStore.untilScanned(); // the scan after an unlock first (the fifth review round, 2026-11-03)
  sameOpening(opening); // a lock since the split began (the tenth review round, D-1)
  const plan = planSplit(o.masterSeed, tree.layers, o.note, o.piece, txDomainOf(o.deployment), terms?.fee);
  const r = await submitAndRecord({ ...o, submission, relayerUrl: terms?.url, spec: plan.spec, noteData: plan.noteData, spent: plan.spent, change: plan.rest, fee: plan.fee, extra: plan.piece.note, extraOwn: { noteData: plan.piece.noteData, counter: plan.piece.counter, label: "piece" }, opening });
  const pieceNote: OwnedNote = r.extraNote ?? { note: plan.piece.note, leafIndex: r.extraLeaf!, noteData: plan.piece.noteData, counter: plan.piece.counter, spent: false, txHash: r.txHash, label: "piece" };
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
async function privateTransferInTurn(o: { masterSeed: Uint8Array; deployment: Deployment; amount: bigint; recipient: string; vault?: Address; /** the relayer's fee the Review showed: a higher one stops the spend (FeeMoved) */ maxFee?: bigint; /** each merge's fee the Review showed (r43) */ maxMergeFee?: bigint; /** the merges the Review named (the eighth review round, B-2) */ maxMerges?: number } & Progress): Promise<Submitted & { recipientNote: { note: Note; leafIndex: number; record: Hex } }> {
  const to = decodePrivacyAddress(o.recipient); // throws on a malformed / mistyped address
  const opening = session.epoch();
  await guardDeployment(o.deployment);
  const submission = o.submission ?? settings.get().submission;
  const vault = o.vault ?? o.deployment.ethVault;
  o.onEvent?.({ type: "fee-terms" });
  let terms = await feeTerms(o.deployment, submission, vault, undefined, { delivered: o.amount }); // V5 (spec §10): the percentage of what the recipient receives
  boundFee(terms, o.maxFee, vault, o.amount);
  const vaultId = BigInt(vault);
  const keys = deriveKeys(o.masterSeed);
  const merges = await ensureSpendableInTurn({ ...o, submission, vault, needed: o.amount, finalFee: terms?.fee.amount ?? 0n });
  terms = await feeAfterMerges(o.deployment, submission, vault, terms, merges, o.amount); // after the merges (B-8)
  o.onStatus?.("Syncing the shielded tree from the core's events…");
  o.onEvent?.({ type: "syncing" });
  const tree = await syncTreeQuorum(o.deployment);
  o.onEvent?.({ type: "verifying" });
  await verifyTree(o.deployment, tree, o.onStatus); // plan §38: the tree must contain the pool proven at the latest finalized block
  poolStats.set({ notes: tree.notes, leaves: tree.nextLeafIndex });
  await noteStore.untilScanned(); // the scan after an unlock first, as every other spend (the eighth review round, B-5): its change note takes a counter
  sameOpening(opening); // a lock since the transfer began: its keys and its change counter are another opening's (the tenth review round, D-1)
  const { spent, inputs, change: changeAmount } = pickInputs(keys, vaultId, o.amount + (terms?.fee.amount ?? 0n));
  const recipientNote: Note = { vaultId, amount: o.amount, ownerCommitment: to.ownerCommitment, noteSecret: randomField() };
  const change = changeNote(keys, vaultId, changeAmount);
  const fee: FeeOutput | undefined = terms ? { note: feeNote(vaultId, terms.fee), outputIndex: 2 } : undefined;
  const noteData: [Hex, Hex, Hex] = [encryptTo(to.viewPub, recipientNote), change?.noteData ?? placeholderNoteData(), fee ? encryptTo(terms!.fee.viewPub, fee.note) : placeholderNoteData()];
  const spec: TxSpec = {
    leaves: tree.leaves, tree: tree.layers, inputs, outputs: [recipientNote, change?.note ?? dummy(vaultId), fee?.note ?? dummy(vaultId)],
    withdrawal: null, outDataHash: noteData.map((d) => noteDataHash(hexToBytes(d))) as [bigint, bigint, bigint], txDomain: txDomainOf(o.deployment),
  };
  const r = await submitAndRecord({ ...o, submission, relayerUrl: terms?.url, network: networkCharge(o.deployment, terms, vault), spec, noteData, spent, change, fee, extra: recipientNote, opening });
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
 * refused; a spend after that block still counts. A transfer received past that pool waits, out of the
 * balance, until a scan proves its leaf, and a stored note its proven leaf contradicts is dropped (audit
 * round 2, r24: an endpoint quorum could invent a received note in the tail, and it stayed for good).
 */
interface FoundNote { leafIndex: number; note: Note; commitment: bigint; noteData: Hex; txHash: Hex; label: string; counter?: number }

/** One nullifier's spent bit from every configured endpoint; they must agree (RpcDisagreement otherwise). */
/**
 * Found notes into the store, each with its spent status: every endpoint's answer, agreed (the third review round, 2026-11-03;
 * threat-model A2 — the first endpoint alone had decided it, and its false "spent" hid a note for good, since no path lifted the
 * flag and no rescan starts from nothing), and, where a light client applies, the proven one: what the quorum calls unspent
 * (an endpoint hiding a spend, n44) and a spent mark not yet proven — new, or marked at an earlier scan or from a receipt — a
 * batch at a time, never the whole history of spent notes. A mark the finalized chain at or past its block does not confirm, or
 * the quorum no longer makes, is lifted: the chain does not have that spend.
 */
async function recordFound(d: Deployment, keys: WalletKeys, all: FoundNote[], index: SpendIndex, stop?: () => boolean): Promise<{ found: number; added: number; spent: number; addedNotes: FoundNote[] }> {
  // each note's nullifier is its own key's (the audit round of 2026-10-16, c18): with the spend key, a spent deposited note
  // would read unspent for good. A note neither key opens is left out, not the whole scan
  const main = mainOwnerCommitment(keys);
  const keyed = all.flatMap((f) => {
    const key = ownerKeyOf(keys, f.note, main);
    return key === null ? [] : [{ f, key }];
  });
  const found = keyed.map((k) => k.f);
  const nullifiers = keyed.map(({ f, key }) => nullifier(f.commitment, key));
  // the spent bits from the pool's own spend events, read fetch-all with the note events and agreed by every endpoint (the sixth
  // review round, 2026-11-03): a per-nullifier `isNullifierSpent` read had named every note of this wallet to the endpoints at
  // every scan, which links each later withdrawal to this client (threat-model A4)
  const rpcSpent = nullifiers.map((nf) => index.spent(nf));
  // where a spend was seen: the block the events were read up to (every endpoint's view at or past it), so a finalized chain at or
  // past it covers the read (the fourth review round: a block taken before the reads had sat below the spend)
  const atBlock = Number(index.block);
  const known = (f: FoundNote) => noteStore.all().find((n) => n.leafIndex === f.leafIndex);
  const toProve = rpcSpent.flatMap((s, i) => {
    if (!s) return [i];
    const k = known(found[i]);
    return !k || !k.spent || k.spentUnproven ? [i] : [];
  });
  const proven = await provenSpent(d, toProve.map((i) => nullifiers[i]));
  const provenAt = new Map<number, boolean>(proven ? toProve.map((i, j) => [i, proven.spent[j]] as [number, boolean]) : []);
  // the block each nullifier's own proof reached (the fourth review round): a lift compares against it, never the latest batch's
  const provenBlock = new Map<number, number>(proven ? toProve.map((i, j) => [i, Number(proven.blocks[j])] as [number, number]) : []);
  // a mark's block is bounded by what the chain can be at (the ninth review round, 2026-11-04, D-2): the light client's finalized block
  // plus a day of blocks, when one applies — every endpoint naming a head of 1e15 had hidden a note for good, as neither lift could reach
  // that block. A mark past what the chain can be at now (this view's block, the finalized one's lead) is one a lying view made: lifted
  // like any mark the chain does not confirm
  const ceiling = proven ? Number(proven.blockNumber) + FINALIZED_LEAD_BLOCKS : Number.POSITIVE_INFINITY;
  const markAt = Math.min(atBlock, ceiling);
  const implausible = (b: number | undefined): boolean => b !== undefined && (b > atBlock + VIEW_SLACK_BLOCKS || b > ceiling);
  if (stop?.()) throw new Error("the wallet locked during the scan"); // its store was emptied while the reads ran
  let added = 0, spentCount = 0;
  const addedNotes: FoundNote[] = [];
  // one change of the store for the whole scan (the eleventh review round, H11-5): the journal is written once, not twice per note
  noteStore.batch(() => {
  for (const [i, f] of found.entries()) {
    const spent = rpcSpent[i];
    const p = provenAt.get(i);
    if (!spent && p === true) throw new TreeNotProven(`the RPC endpoints say the note at leaf ${f.leafIndex} is unspent; it was spent by finalized block ${provenBlock.get(i)}`);
    if (spent) spentCount++;
    const k = known(f);
    if (k) {
      if (spent) {
        if (!k.spent) noteStore.markSpent([f.leafIndex], { atBlock: markAt, proven: p === true });
        else if (k.spentUnproven) {
          if (p === true) noteStore.confirmSpent([f.leafIndex]);
          // the finalized chain at or past the block the spend was seen at does not have it: a dropped block, or an endpoint set that lies
          else if (p === false && k.spentAtBlock !== undefined && ((provenBlock.get(i) ?? 0) >= k.spentAtBlock || implausible(k.spentAtBlock))) noteStore.markUnspent([f.leafIndex]);
        }
      } else if (k.spent && k.spentUnproven && (k.spentAtBlock === undefined || atBlock >= k.spentAtBlock || implausible(k.spentAtBlock))) {
        // the quorum, at or past the block the spend was seen at, no longer calls it spent: the block that spent it was dropped. A view
        // older than the mark had lifted it (the eighth review round, B-3): a scan read at N−1 while a spend's receipt marked it at N
        noteStore.markUnspent([f.leafIndex]);
      }
      continue;
    }
    // its time, as every flow's note has (the tenth review round, B10-3): without one a view a block behind dropped it past the pool at once
    noteStore.add({ note: f.note, leafIndex: f.leafIndex, noteData: f.noteData, spent, txHash: f.txHash, label: f.label, addedAt: Date.now(), ...(f.counter !== undefined ? { counter: f.counter } : {}), ...(spent && p !== true ? { spentUnproven: true as const, spentAtBlock: markAt } : {}) });
    added++;
    addedNotes.push(f);
  }
  });
  return { found: found.length, added, spent: spentCount, addedNotes };
}

/** A spent mark's block is at most this far past the light client's finalized block (about a day of 12-second blocks; D-2). */
export const FINALIZED_LEAD_BLOCKS = 7200;
/**
 * ...and at most this far past the block a later view was read at (an endpoint behind another; D-2) — two hours of blocks (the tenth review
 * round, B10-3): at 64 a view thirteen minutes behind a spend's receipt lifted the genuine mark, and the note read unspent until the next
 * caught-up scan. A lying head is past it either way, and the light client's finalized lead bounds it where there is one.
 */
export const VIEW_SLACK_BLOCKS = 600;
/** How long a note recorded past the pool the endpoints agree on is kept for them to catch up (the ninth review round, D-1). */
export const PAST_POOL_GRACE_MS = 15 * 60_000;

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
 * A job the relayer has ended, or is refunding: its refund found closes the order — unless an execution was seen, since a partial fill's rest
 * comes back through these states too (the round's second critique: an executed order had been closed REFUNDED here, its delivered part lost).
 */
const RELAYER_DONE: readonly string[] = ["lapsed", "expired", "execute-failed", "refund-failed", "refunding", "refund-only"];
/** An order's closed states (swapFunding.ts CLOSED_STATES, "completed" aside: kept here, swapFunding imports this module). */
const ORDER_CLOSED: readonly string[] = ["refunded", "abandoned", "lapsed"];
/**
 * What the scan found for each order a committed deposit came for: a refund's notes, journaled, and a same-chain swap's delivered notes on its
 * shield receipt (V6 §11.2: the order's tracker reads them as completed). A refund closes, refunded, an open order never handed over or ended at
 * the relayer with no execution seen; an order an execution was seen for, or the executor was asked about, keeps its state and is left to its
 * runner (a tick due now), which closes it on its reading; a completed order keeps its state, its record synced again.
 */
export function journalRefunds(refunds: RecoveredRefund[]): void {
  if (!refunds.length || !session.isUnlocked()) return;
  // the orders a refund leaves to their runner: ticked now, so the job and the provider are read (B11-1); the ones it closed here
  const runnerReads = new Set<string>();
  const closedHere = new Set<string>();
  const resync = new Set<string>();
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
      // which orders the refund closes (the eleventh review round, 2026-11-04, B11-1, B11-2, and the round's critique). An open order an execution
      // was seen for — its transaction journaled, its job executing or executed — is left to its runner: its refund may be the rest of a partial
      // fill, and the runner reads the job and the provider before it closes it (closed here from the bare state, a partly delivered swap had
      // been recorded REFUNDED for good, a campaign step booked refunded). So is an open one the executor was asked about: the runner reads its
      // job, and with none decides on the escrow's executed flag (orderRunner step 1b). Every other one is closed by its refund (A10-6), its pause
      // with it (B11-2) — an order
      // already closed or failed at the relayer (lapsed, refund-failed, execute-failed, expired), one never handed over (a tracker's reading is
      // no execution: a Refresh writes one for any funded order)
      // a completed order keeps its state; its record is synced again below, so what the refund changes of it is said — a provider failure
      // whose funds came back is a refund (VB-N1), the rest of a partial fill came back (B11-8) — the second critique: nothing re-synced it
      if (s.state === "completed") {
        if (!s.campaign) resync.add(s.orderId.toLowerCase());
        continue;
      }
      const executionSeen = !!s.executionTx || s.state === "executing" || s.state === "executed";
      const asked = s.handOverAttempt !== undefined || s.handedOverAt !== undefined || !!s.jobId;
      // a Return funds' job (refund-only, refunding) says nothing of an execution the executor was asked for before it (the fifth critique: a
      // hand-over whose answer was lost, then Return funds — its rest re-shielded, the order had closed REFUNDED and its delivered part was lost):
      // left to its runner, whose tracker reads the escrow's flag
      const returnAfterHandOver = (s.state === "refund-only" || s.state === "refunding") && (s.handOverAttempt !== undefined || s.handedOverAt !== undefined);
      const over = ORDER_CLOSED.includes(s.state) || (RELAYER_DONE.includes(s.state) && !executionSeen && !returnAfterHandOver);
      if (!over && (executionSeen || asked)) {
        if (!s.campaign) runnerReads.add(s.orderId);
        continue;
      }
      s.state = "refunded";
      delete s.paused;
      closedHere.add(s.orderId.toLowerCase());
    }
  });
  for (const orderId of runnerReads) {
    try {
      scheduleAction({ kind: "order-tick", orderId, dueAt: Date.now() }, session);
    } catch {
      // the wallet locked meanwhile: its next unlock ticks the order
    }
  }
  if (runnerReads.size) kickScheduler();
  // the record of each order the refund closed here moves with it (the tenth review round, A10-6): it had stayed "Refunding" until a Refresh by
  // hand. An order left to its runner is synced by the runner's reading (the critique: synced here from the journal's last reading, an
  // executed order's record had been closed before the runner read anything)
  for (const stored of session.journal().swaps) {
    const key = stored.orderId.toLowerCase();
    if ((!closedHere.has(key) && !resync.has(key)) || stored.campaign) continue;
    try {
      syncSwapRecord(stored, null, null, Date.now(), session);
    } catch {
      // a record's sync never stops the scan: the next Refresh or tick writes it
    }
  }
}

/**
 * What a scan found: the transfers received it added, those it holds back past the proven pool (`pending`, audit round 2,
 * r24), and how many leaves the light client proved (null where none applies: the reads rest on the RPC quorum).
 */
export interface ScanResult { scanned: number; found: number; added: number; spent: number; refunds: number; received: ReceivedNote[]; pending: ReceivedNote[]; proven: number | null; /** the leaves the scan's view holds */ leaves?: number }

export async function scanNotes(
  o: {
    masterSeed: Uint8Array;
    deployment: Deployment;
    refunds?: RefundClaim[];
    /** the note counters of this wallet's deposits whose records await their note (operations/stale.ts awaitedDeposits) */
    awaited?: readonly number[];
  } & Progress,
): Promise<ScanResult> {
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

async function scanNotesUnlocked(o: { masterSeed: Uint8Array; deployment: Deployment; refunds?: RefundClaim[]; awaited?: readonly number[] } & Progress, locked: () => boolean): Promise<ScanResult> {
  const keys = deriveKeys(o.masterSeed);
  o.onStatus?.("Scanning the core's payloads for notes encrypted to this wallet…");
  const { tree, logs, spends, block } = await syncPoolQuorum(o.deployment);
  const index = indexSpends(spends, block);
  rememberSpendIndex(o.deployment.core, index); // the stale mover reads it after this scan
  const verified = await verifyTree(o.deployment, tree, o.onStatus);
  const proven = verified.kind === "verified" ? verified.proof.nextLeafIndex : null;
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
  // a note this wallet's seed did not make (no counter), made out to the privacy address (only this wallet derives a
  // deposited note's own owner commitment), and that is no swap's refund or delivery: someone sent it here
  const refundLeaves = new Set(refunds.map((x) => x.leafIndex));
  const isReceived = (f: FoundNote) => f.counter === undefined && !refundLeaves.has(f.leafIndex) && f.note.ownerCommitment === main;
  // a note past the proven pool waits for the scan whose proof covers its leaf (audit round 2, r24: there an endpoint quorum can
  // invent a note made out to a published privacy address, and it entered the balance as received for good; the third review round,
  // 2026-11-03: every note new to the store, not only a transfer received — a protect's opening is public calldata, so the quorum
  // could replay this wallet's own note at a leaf in the tail just as well). This wallet's own flows record their notes from a receipt, so
  // nothing of theirs waits — and a deposit its wallet reported nothing for (a Protect through WalletConnect, a page gone before its receipt:
  // its record awaits the note, `o.awaited`) is recorded from the endpoints' agreed view at once, the trust its receipt had (the eleventh
  // review round's critique of F11-10: it had waited for finality — about half an hour on mainnet — its record reading "checking"), when
  // that view holds it at one leaf alone and the store none of its counter; the proven pool still drops it if it contradicts (r24, below)
  const awaitedAt = (f: FoundNote) => f.counter !== undefined && (o.awaited ?? []).includes(f.counter) && found.filter((g) => g.counter === f.counter).length === 1 && !noteStore.all().some((n) => n.counter === f.counter);
  const waiting = proven === null ? [] : found.filter((f) => f.leafIndex >= proven && !awaitedAt(f) && !noteStore.all().some((n) => n.leafIndex === f.leafIndex));
  const { addedNotes, ...r } = await recordFound(o.deployment, keys, waiting.length ? found.filter((f) => !waiting.includes(f)) : found, index, locked);
  // only the refunds and deliveries recorded: one waiting past the proven pool is journaled once a proof covers it, as recoverSwapRefunds
  // does (the tenth review round, B10-2: a lying quorum's replay at a tail leaf had marked an order refunded for good, nothing in the store)
  journalRefunds(waiting.length ? refunds.filter((x) => !waiting.some((f) => f.leafIndex === x.leafIndex)) : refunds);
  noteStore.batch(() => {
    for (const c of [...counters.values(), ...refunds.map((x) => x.counter)]) noteStore.observeCounter(c);
  });
  // a complete scan (every payload, the seed's claims): the counters held after a restore resume past what it found
  if (o.refunds === undefined) noteStore.releaseCounters(COUNTER_RESERVE);
  // the notes the proven pool contradicts (audit round 2, r24): an unspent note at a proven leaf that holds another
  // commitment — found in an endpoint's tail before, or recorded at the leaf a receipt named — was never in the pool there,
  // and every spend that picked it failed until a restore
  if (!locked()) {
    // without a light client the agreed tree is the authority for every leaf it holds (the ninth review round, 2026-11-04, D-1); with one,
    // the proven prefix is — the tail is the endpoints' word, never enough to drop a note
    const held = proven ?? tree.nextLeafIndex;
    const contradicted = noteStore.all().filter((n) => !n.spent && n.leafIndex < held && tree.leaves[n.leafIndex] !== noteCommitment(noteBody(n.note), BigInt(n.leafIndex)));
    // a note recorded past the pool the endpoints agree on — a receipt that named a far leaf (the connected wallet's provider), a replayed
    // opening — once they have had the time to catch up with it (D-1): it had stayed in the balance for good, every spend that picked it
    // failing, and a real deposit beside it counted twice
    const now = Date.now();
    const pastPool = noteStore.all().filter((n) => !n.spent && n.leafIndex >= tree.nextLeafIndex && (n.addedAt === undefined || now - n.addedAt > PAST_POOL_GRACE_MS));
    // one note at two leaves — a deposit's public opening replayed into the endpoints' tail beside its real leaf, an awaited note recorded
    // from the tail before the proof reached the real one (the eleventh review round's critique of F11-10): once a copy stands at a proven
    // leaf, the unproven copies go; a counter is one note's alone
    const provenCounters = new Set(
      proven === null
        ? []
        : noteStore
            .all()
            .filter((n) => n.counter !== undefined && n.leafIndex < proven && tree.leaves[n.leafIndex] === noteCommitment(noteBody(n.note), BigInt(n.leafIndex)))
            .map((n) => n.counter),
    );
    const replayed = proven === null ? [] : noteStore.all().filter((n) => !n.spent && n.counter !== undefined && n.leafIndex >= proven && provenCounters.has(n.counter));
    if (contradicted.length || pastPool.length || replayed.length) noteStore.drop([...contradicted, ...pastPool, ...replayed].map((n) => n.leafIndex));
  }
  const asReceived = (f: FoundNote): ReceivedNote => ({ leafIndex: f.leafIndex, vaultId: f.note.vaultId, amount: f.note.amount, txHash: f.txHash });
  const received = addedNotes.filter(isReceived).map(asReceived);
  o.onStatus?.(`Scanned ${logs.length} payloads: ${r.found} ours (${r.added} new, ${r.spent} spent${refunds.length ? `, ${refunds.length} swap refund${refunds.length > 1 ? "s" : ""}` : ""}${waiting.length ? `, ${waiting.length} waiting for finality` : ""}).`);
  return { scanned: logs.length, ...r, refunds: refunds.length, received, pending: waiting.filter(isReceived).map(asReceived), proven, leaves: tree.nextLeafIndex };
}

/** V6 Stage 12: the delivered note of a same-chain swap into the protected balance, once the executor reports a shield. */
export async function recoverShieldDelivery(o: { masterSeed: Uint8Array; deployment: Deployment; orderId: string; shield: { noteData: string; counter: number } } & Progress): Promise<RecoveredRefund[]> {
  return recoverSwapRefunds({ ...o, refunds: [{ orderId: o.orderId, noteData: o.shield.noteData as Hex, counter: o.shield.counter, kind: "shield" }] });
}

/** Record the refund notes of this wallet's orders without a payload scan: right after the executor reports a refund (PP-S09). */
export async function recoverSwapRefunds(o: { masterSeed: Uint8Array; deployment: Deployment; refunds?: RefundClaim[] } & Progress): Promise<RecoveredRefund[]> {
  // bound to the opening it began in, as a scan is (the eleventh review round, 2026-11-04, A11-2): after a lock and a REPLACE in this tab, the
  // lookup's note had gone into the other wallet's open store and journal — its balance wrong for good, its backups carrying this note
  const opening = session.epoch();
  const stale = () => !session.isUnlocked() || session.epoch() !== opening;
  const keys = deriveKeys(o.masterSeed);
  o.onStatus?.("Looking for the refund in the pool…");
  const { tree, logs, spends, block } = await syncPoolQuorum(o.deployment);
  const index = indexSpends(spends, block);
  rememberSpendIndex(o.deployment.core, index);
  const verified = await verifyTree(o.deployment, tree, o.onStatus);
  const proven = verified.kind === "verified" ? verified.proof.nextLeafIndex : null;
  const found = await findRefunds(o.deployment, keys, logs, o.refunds ?? journaledRefundClaims());
  // past the proven pool a refund or a delivery waits for the scan whose proof covers it, as every note new to the store does (the ninth
  // review round, 2026-11-04, D-1): its opening is public — the escrow's and the receiver's immutables —, and a lying quorum's replay at a
  // tail leaf had stayed in the balance beside the real one
  const refunds = proven === null ? found : found.filter((r) => r.leafIndex < proven || noteStore.all().some((n) => n.leafIndex === r.leafIndex));
  await recordFound(o.deployment, keys, refunds.map(refundFound), index, stale);
  if (stale()) throw new Error("the wallet locked during the lookup: the next scan records what it found");
  journalRefunds(refunds);
  return refunds;
}
