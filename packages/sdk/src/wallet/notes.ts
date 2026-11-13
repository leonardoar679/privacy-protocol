// The wallet's notes: those this wallet created (shields, change, merged and refund notes) and those
// discovered on chain (payloads encrypted to the view key, spec §12), each with the leaf index the
// chain assigned. Held in memory while the wallet is unlocked and persisted through the encrypted
// journal (wallet/journal.ts) — never in the clear (TC-01). A rescan of the chain rebuilds it.
import type { Hex } from "viem";
import type { Note } from "@privacy-wallet/protocol/note";

export interface OwnedNote {
  note: Note;
  leafIndex: number;
  noteData: Hex; // the payload that went on-chain with it
  counter?: number; // noteSecret derivation counter when it is one of ours
  spent: boolean;
  txHash?: Hex;
  label?: string;
  /** V6 Stage 11 (spec v2.0 §14.1): when this wallet created the note (a protect, a change, a merge, a split), unix ms; absent for a note a scan found — its age is unknown */
  addedAt?: number;
  /**
   * The third review round (2026-11-03): a spent mark the light client has not yet proven at a finalized block — proven again at each
   * scan until it is (never the whole history of spent notes, audit round 2 n44), and lifted when the chain does not have the spend:
   * the endpoint quorum no longer calls the note spent (a receipt's one-confirmation mark whose block was dropped), or the finalized
   * chain at or past `spentAtBlock` does not (a dropped block, a lying endpoint set). Before, one endpoint's false "spent" hid a note for good.
   */
  spentUnproven?: true;
  /** the block the spend was seen at — the receipt's, or the endpoints' latest at the scan that read the bit */
  spentAtBlock?: number;
}

/** JSON form of a note for the encrypted journal (bigints as decimal strings). */
export interface SerializedNote { vaultId: string; amount: string; ownerCommitment: string; noteSecret: string; leafIndex: number; noteData: Hex; counter?: number; spent: boolean; txHash?: Hex; label?: string; addedAt?: number; spentUnproven?: true; spentAtBlock?: number }

type Listener = () => void;

/**
 * Thrown when a note counter is asked for while the counters are held (NoteStore.holdCounters): after a start without the
 * whole journal, until one complete scan has seen the counters this wallet already used. Nothing was made or sent.
 */
/**
 * How long a flow waits for the scan after an unlock before it asks for a counter (the fifth review round, 2026-11-03): on a
 * devnet the scan takes seconds, on mainnet with the light client up to a minute or two. Past it the allocation throws CountersHeld.
 */
export const SCAN_WAIT_MS = 120_000;

/**
 * Thrown when the note store is asked for a counter, or waited on, after a lock and before the next unlock's load (the tenth review
 * round, 2026-11-04, D-1): a lock had resolved the wait for the scan as if it had finished and reset the counter to 0, and a flow that
 * held the seed across the lock derived its note from the zeroed seed at counter 0 — a note anyone can spend. Nothing was made or sent.
 */
export class StoreClosed extends Error {
  readonly code = "locked_mid_flow";
  constructor() {
    super("the wallet locked: no new note is made and nothing more is sent");
    this.name = "StoreClosed";
  }
}

export class CountersHeld extends Error {
  readonly code = "notes_loading";
  constructor() {
    super("the wallet is still looking for its notes in the pool (after an unlock or a restore): no new note until one complete scan");
    this.name = "CountersHeld";
  }
}

const sameNote = (a: Note, b: Note): boolean =>
  a.vaultId === b.vaultId && a.amount === b.amount && a.ownerCommitment === b.ownerCommitment && a.noteSecret === b.noteSecret;

/**
 * A second copy of a note already at its leaf completes the first (a V6 follow-up of 2026-10-16, audit c23/c34): what the
 * flow knew and the scan could not — its label, counter, time and transaction — fills in, and spent stays spent. Another
 * note at that leaf replaces it: each was checked against the leaf when it came, so the later one is the leaf's now (a
 * block the chain dropped had put the first one there).
 */
function settle(into: OwnedNote, n: OwnedNote): OwnedNote {
  if (!sameNote(into.note, n.note)) return n;
  if (n.spent && !into.spent) {
    into.spent = true;
    if (n.spentUnproven) { into.spentUnproven = true; if (n.spentAtBlock !== undefined) into.spentAtBlock = n.spentAtBlock; }
  }
  into.counter ??= n.counter;
  into.txHash ??= n.txHash;
  into.addedAt ??= n.addedAt;
  if (n.label && (!into.label || into.label === "discovered")) into.label = n.label;
  return into;
}

/** The notes with one entry per leaf, in order: a later copy completes the first, a later other note replaces it. */
function onePerLeaf(notes: OwnedNote[]): OwnedNote[] {
  const byLeaf = new Map<number, OwnedNote>();
  for (const n of notes) {
    const known = byLeaf.get(n.leafIndex);
    byLeaf.set(n.leafIndex, known ? settle(known, n) : n);
  }
  return [...byLeaf.values()];
}

/**
 * A note of this wallet in the latest scan's agreed view (the twelfth review round, A12-1): recorded, or waiting there for the proof of its leaf.
 * The stale mover tells by it a deposit that landed under another hash — a speed-up, the same call under a new hash — from one that never
 * did, before its note is in the store.
 */
export interface ViewNote {
  counter: number;
  vaultId: bigint;
  amount: bigint;
  leafIndex: number;
}

export class NoteStore {
  private notes: OwnedNote[] = [];
  /** the latest scan's agreed view of this wallet's notes with a counter (A12-1): never journaled, gone at a lock */
  private view: ViewNote[] = [];
  private snapshot: OwnedNote[] = [];
  private listeners = new Set<Listener>();
  private counter = 0;
  private held = false;
  /** held since the unlock, until the scan after it has read the pool (the fifth review round, 2026-11-03); never journaled */
  private scanHold = false;
  /** the journal's counter as loaded: a counter the scan finds at or past it is one the journal did not know */
  private loadedCounter = 0;
  private stale = false;
  /** the lowest counter the scan found at or past the loaded one (the twelfth review round, E12-5; W6 §3): where the chain went on from; each
   *  opening's own (load) */
  private firstPast: number | null = null;
  /** the hold is a backup merge's into this device's own journal (JournalData.countersHeldByMerge): its indexes were never resumed; each
   *  opening's own (load) */
  private heldByMerge = false;
  /** closed by a lock until the next load (D-1) */
  private closed = false;

  /**
   * A note of this wallet at its leaf. The same note already there is completed instead of added again (a V6 follow-up of
   * 2026-10-16, audit c23/c34): a scan can record a protect, a change or a merged note before its own flow does, and two
   * copies had doubled the balance and failed every spend that picked both. Another note there is replaced (settle).
   */
  add(n: OwnedNote): void {
    // nothing goes into a store a lock closed (the eleventh review round, 2026-11-04, VA NF-2): a late result had put a note's secret and amount
    // back into the page's memory until the next unlock — and, after a REPLACE, into the other wallet's store (A11-2 binds those flows too)
    if (this.closed) return;
    const i = this.notes.findIndex((x) => x.leafIndex === n.leafIndex);
    if (i < 0) this.notes.push(n);
    else this.notes[i] = settle(this.notes[i], n);
    this.emit();
  }
  /**
   * Spent — from a receipt or the endpoints' agreed bit (`atBlock`: where the spend was seen); `proven` when the light client proved it at a
   * finalized block, else the mark waits for that proof (the third review round, 2026-11-03).
   */
  markSpent(leafIndexes: number[], o: { atBlock?: number; proven?: boolean } = {}): void {
    if (this.closed) return;
    for (const n of this.notes) {
      if (!leafIndexes.includes(n.leafIndex)) continue;
      const was = n.spent;
      n.spent = true;
      if (o.proven) { delete n.spentUnproven; delete n.spentAtBlock; }
      else if (!was) { n.spentUnproven = true; if (o.atBlock !== undefined) n.spentAtBlock = o.atBlock; } // a note already spent keeps its mark as it is
    }
    this.emit();
  }
  /** The light client proved these spends at a finalized block: the marks are final. */
  confirmSpent(leafIndexes: number[]): void {
    if (this.closed) return;
    for (const n of this.notes) if (leafIndexes.includes(n.leafIndex)) { delete n.spentUnproven; delete n.spentAtBlock; }
    this.emit();
  }
  /** The chain does not have these spends (the quorum no longer calls the notes spent, or the finalized chain past the block of the mark does not): the notes are unspent again. Only an unproven mark may be lifted. */
  markUnspent(leafIndexes: number[]): void {
    if (this.closed) return;
    for (const n of this.notes) if (leafIndexes.includes(n.leafIndex) && n.spentUnproven) { n.spent = false; delete n.spentUnproven; delete n.spentAtBlock; }
    this.emit();
  }
  /** Forget the notes at these leaves: the pool proven at the latest finalized block holds other commitments there (audit round 2, r24). */
  drop(leafIndexes: number[]): void {
    if (this.closed) return;
    this.notes = this.notes.filter((n) => !leafIndexes.includes(n.leafIndex));
    this.emit();
  }
  unspent(vaultId?: bigint): OwnedNote[] {
    return this.notes.filter((n) => !n.spent && (vaultId === undefined || n.note.vaultId === vaultId));
  }
  balance(vaultId: bigint): bigint {
    return this.unspent(vaultId).reduce((s, n) => s + n.note.amount, 0n);
  }
  all(): OwnedNote[] {
    return this.snapshot;
  }
  /** The latest scan's agreed view of this wallet's notes (A12-1); ignored once a lock closed the store. */
  setScanView(view: readonly ViewNote[]): void {
    if (this.closed) return;
    this.view = [...view];
  }
  /** This wallet's notes the latest scan saw at `counter`, recorded or waiting for the proof of their leaf. */
  scanView(counter: number): readonly ViewNote[] {
    return this.view.filter((n) => n.counter === counter);
  }
  /** The counter allocateCounter() would hand out next (read-only). */
  nextCounter(): number {
    return this.counter;
  }
  /** Next noteSecret counter for a note of ours (spec §5.5: never reused); none while the counters are held. */
  allocateCounter(): number {
    if (this.closed) throw new StoreClosed();
    if (this.held || this.scanHold) throw new CountersHeld();
    const c = this.counter++;
    this.emit();
    return c;
  }
  /** A counter this wallet is known to have used (a rescan found a note derived from it): the next one is past it. */
  observeCounter(used: number): void {
    if (this.closed) return; // another opening's counters never raise the next one's (NF-2)
    if (used >= this.loadedCounter) {
      this.stale = true; // the journal did not know this counter: it is behind the chain
      if (this.firstPast === null || used < this.firstPast) this.firstPast = used;
    }
    if (used + 1 <= this.counter) return;
    this.counter = used + 1;
    this.emit();
  }
  /**
   * After a start without the whole journal — a restore from the phrase or from a backup, a journal that does not open —
   * the counters this wallet already used are unknown until one complete scan (PP-P03; the audit round of 2026-10-16): a
   * counter handed out before could repeat a note's secret already on chain, and a deposit's own owner commitment with it,
   * which links the two. Kept in the journal, so a reload before the scan keeps them held.
   */
  holdCounters(): void {
    if (this.held) return;
    this.held = true;
    this.emit();
  }
  /**
   * Held until the scan after this unlock has read the pool (the fifth review round, 2026-11-03): a journal is proved to be this
   * seed's, never to be the newest — restored from an older copy of the profile, or put back by a writer of the origin, its
   * counter repeats a secret already on chain. Not journaled: a reload before the scan holds again at its unlock.
   */
  holdUntilScanned(): void {
    if (this.scanHold) return;
    this.scanHold = true;
    this.emit();
  }
  countersHeld(): boolean {
    return this.held || this.scanHold;
  }
  /**
   * Whether the hold is a restore's — a start without the whole journal (`holdCounters`), kept in the journal until one complete scan — and
   * not this unlock's alone (the twelfth review round, W6 §5.4: the screens say which).
   */
  restoreHeld(): boolean {
    return this.held;
  }
  /**
   * Resolves once the unlock's hold is released — the scan after the unlock has read the pool — or at once when there is none;
   * after `timeoutMs` it resolves too, and the allocation that follows throws CountersHeld. A restore's hold is not waited on:
   * the screens show that scan. (A Protect started a second after an unlock had failed on the hold before the scan could run.)
   */
  untilScanned(timeoutMs = SCAN_WAIT_MS): Promise<void> {
    if (this.closed) return Promise.reject(new StoreClosed());
    if (!this.scanHold) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let off = () => {};
      const timer = setTimeout(() => {
        off();
        resolve();
      }, timeoutMs);
      off = this.subscribe(() => {
        // a lock ends the wait as a refusal, never as a finished scan (the tenth review round, D-1)
        if (this.closed) {
          clearTimeout(timer);
          off();
          reject(new StoreClosed());
          return;
        }
        if (this.scanHold) return;
        clearTimeout(timer);
        off();
        resolve();
      });
    });
  }
  /**
   * One complete scan has seen the counters it found (observeCounter): the next one is `reserve` past them, so a counter
   * that left nothing the scan reads (an executed order's refund note, a commit never funded) is not handed out again, and
   * counters are handed out again.
   *
   * Answers whether the journal is an older copy of itself (the twelfth review round, E12-5; W6 §3): read stale, the counters found beginning
   * less than a quarter of the reserve past the loaded one — this journal's own lost counters, which left notes (a profile restored from an
   * older copy) —, under no hold whose journal resumed its indexes already (a restore's without this device's journal; a backup merged into it
   * resumed only where the backup knew more). Not another installation's of the seed, whose counters begin a reserve past what it found when
   * it last resumed — unless this device used more than 192 counters since (audit gap 51). Its caller resumes the journal's fresh addresses past
   * their reserves then (journal.ts rolledBackJournal).
   */
  releaseCounters(reserve: number): boolean {
    if (!this.held && !this.scanHold) return false;
    // the reserve after a restore (the journal unknown), and after an unlock whose scan found a counter the journal did not know
    // (the fifth review round, 2026-11-03): a current journal resumes where it was
    const reserved = this.held || this.stale;
    const rolledBack = (!this.held || this.heldByMerge) && this.stale && this.firstPast !== null && this.firstPast - this.loadedCounter < reserve / 4;
    this.held = false;
    this.scanHold = false;
    this.stale = false;
    if (reserved) this.counter += reserve;
    this.emit();
    return rolledBack;
  }
  /** Everything the journal keeps. */
  serialize(): { notes: SerializedNote[]; noteCounter: number; countersHeld?: true } {
    return {
      notes: this.notes.map((n) => ({ vaultId: n.note.vaultId.toString(), amount: n.note.amount.toString(), ownerCommitment: n.note.ownerCommitment.toString(), noteSecret: n.note.noteSecret.toString(), leafIndex: n.leafIndex, noteData: n.noteData, counter: n.counter, spent: n.spent, txHash: n.txHash, label: n.label, ...(n.addedAt !== undefined ? { addedAt: n.addedAt } : {}), ...(n.spentUnproven ? { spentUnproven: true as const, ...(n.spentAtBlock !== undefined ? { spentAtBlock: n.spentAtBlock } : {}) } : {}) })),
      noteCounter: this.counter,
      ...(this.held ? { countersHeld: true as const } : {}),
    };
  }
  /** Replace the contents with a journal's (on unlock). The counter never goes backwards. */
  load(data: { notes: SerializedNote[]; noteCounter: number; countersHeld?: boolean; countersHeldByMerge?: boolean }): void {
    // a journal written before notes were one per leaf may hold a leaf twice: it loads once
    this.notes = onePerLeaf(data.notes.map((s) => ({ note: { vaultId: BigInt(s.vaultId), amount: BigInt(s.amount), ownerCommitment: BigInt(s.ownerCommitment), noteSecret: BigInt(s.noteSecret) }, leafIndex: s.leafIndex, noteData: s.noteData, counter: s.counter, spent: s.spent, txHash: s.txHash, label: s.label, ...(s.addedAt !== undefined ? { addedAt: s.addedAt } : {}), ...(s.spent && s.spentUnproven ? { spentUnproven: true as const, ...(s.spentAtBlock !== undefined ? { spentAtBlock: s.spentAtBlock } : {}) } : {}) })));
    this.counter = Math.max(this.counter, data.noteCounter, ...this.notes.map((n) => (n.counter ?? -1) + 1));
    this.loadedCounter = this.counter;
    this.stale = false;
    this.firstPast = null;
    this.held = !!data.countersHeld;
    this.heldByMerge = !!data.countersHeldByMerge; // read only with the hold
    this.view = [];
    this.closed = false;
    this.emit();
  }
  /**
   * At a lock (the tenth review round, D-1): everything forgotten, and the store closed until the next unlock's load — a flow waiting for
   * the scan is refused (StoreClosed), and no counter is handed out to a flow that still holds the seed the lock zeroed.
   */
  close(): void {
    this.closed = true;
    this.clear();
  }
  /** Whether a lock closed the store (D-1). */
  isClosed(): boolean {
    return this.closed;
  }
  /** Forget everything. */
  clear(): void {
    this.notes = [];
    this.view = [];
    this.counter = 0;
    this.held = false;
    this.scanHold = false;
    this.stale = false;
    this.loadedCounter = 0;
    this.emit();
  }
  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  private batching = 0;
  private dirty = false;
  /**
   * Many changes as one (the eleventh review round, 2026-11-04, H11-5): the listeners hear once, at the end — a scan that records n notes had
   * emitted about 2n times, and the session serialised, encrypted and queued the whole growing journal each time. Nested batches end with the
   * outermost; `all()` reads the store as it was before the batch until then.
   */
  batch<T>(fn: () => T): T {
    this.batching++;
    try {
      return fn();
    } finally {
      if (--this.batching === 0 && this.dirty) {
        this.dirty = false;
        this.emit();
      }
    }
  }
  private emit(): void {
    if (this.batching > 0) {
      this.dirty = true;
      return;
    }
    this.snapshot = this.notes.map((n) => ({ ...n }));
    for (const l of this.listeners) l();
  }
}

export const noteStore = new NoteStore();

