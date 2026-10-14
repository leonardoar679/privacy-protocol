// The wallet session (plan §44): create / unlock / lock / restore, and the encrypted journal that
// follows the unlocked seed. Recovery never depends on this site: the 24-word phrase alone restores
// the seed (then a chain rescan rebuilds the notes), and the backup file restores seed + journal.
// V2 (Stage 4): every journal write notifies the screens (the scheduler patches orders from any tab),
// and a journal that fails to decrypt is kept, never overwritten — the wallet opens read-only on an
// empty journal and says so until the user restores a backup or sets the unreadable one aside.
import { generateMasterSeed } from "../keys/wallet";
import { createKeystore, KDF_DEFAULT, phraseToSeed, seedToPhrase, unlockKeystore, type KdfParams, type Keystore } from "./keystore";
import { decryptJournal, emptyJournal, encryptJournal, journalKey, type EncryptedJournal, type JournalData } from "./journal";
import { browserStorage, JOURNAL_KEY, KEYSTORE_KEY, UNREADABLE_JOURNAL_KEY, type KeyValueStorage } from "./storage";
import { noteStore } from "./notes";
import { settings, type Settings } from "./settings";
import { config } from "../config";

export type SessionStatus = "none" | "locked" | "unlocked";
export interface SessionState {
  status: SessionStatus;
  seed: Uint8Array | null;
  /** set right after create(): the 24 words the user must acknowledge before the wallet screens appear */
  pendingPhrase: string | null;
  /** the stored journal did not decrypt under this seed: the session runs on an empty journal and writes nothing (see discardUnreadableJournal) */
  journalUnreadable: boolean;
  /** V5: the device's store has been read (status is trustworthy); the shell shows nothing before it */
  ready: boolean;
}

export interface Backup { v: 1; keystore: Keystore; journal: EncryptedJournal | null }

/** A critical section that defers an automatic lock (spec v2.0 §8; ../session/autoLock.ts). */
export interface Hold { reason: string; since: number }

export class WalletSession {
  private seed: Uint8Array | null = null;
  private key: Uint8Array | null = null;
  private data: JournalData | null = null;
  private listeners = new Set<() => void>();
  private pendingPhrase: string | null = null;
  private unreadable = false;
  private firstLaunch = false;
  private readyFlag = false;
  private snapshot: SessionState | null = null;
  private readyPromise: Promise<void> | null = null;
  private holdList = new Map<number, Hold>();
  private holdSeq = 0;
  private lockHooks = new Set<() => void>();
  private safeHooks = new Set<() => void>();
  /** resolves once the store has hydrated and the status reflects the device (V5); started by the first read (V6 Stage 4) */
  get ready(): Promise<void> {
    this.init();
    return this.readyPromise!;
  }

  // the store and the scrypt cost may be given now or resolved at the moment of use (the shared session is built at import,
  // before the platform configures the engine: V6 Stage 3–4)
  constructor(private readonly storageSource: KeyValueStorage | (() => KeyValueStorage) = browserStorage, private readonly kdf: KdfParams | (() => KdfParams) = KDF_DEFAULT) {
    // mirror the in-memory stores into the journal while unlocked
    noteStore.subscribe(() => this.update((j) => { const s = noteStore.serialize(); j.notes = s.notes; j.noteCounter = s.noteCounter; }));
    settings.subscribe(() => this.update((j) => { j.settings = { ...settings.get() }; }));
  }

  /** The first read: the platform has configured the engine by now; the store is resolved and its hydration awaited. */
  private init(): void {
    if (this.readyPromise) return;
    const store = this.store;
    this.snapshot ??= { status: this.hasKeystore() ? "locked" : "none", seed: null, pendingPhrase: null, journalUnreadable: false, ready: false };
    this.readyPromise = Promise.resolve(store.ready).then(() => { this.readyFlag = true; this.emit(); }, () => { this.readyFlag = true; this.emit(); });
  }

  state(): SessionState {
    this.init();
    return this.snapshot!;
  }
  private get store(): KeyValueStorage { return typeof this.storageSource === "function" ? this.storageSource() : this.storageSource; }
  hasKeystore(): boolean { return this.store.get(KEYSTORE_KEY) !== null; }
  isUnlocked(): boolean { return this.seed !== null; }
  subscribe(l: () => void): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
  private emit(): void {
    this.snapshot = { status: this.seed ? "unlocked" : this.hasKeystore() ? "locked" : "none", seed: this.seed, pendingPhrase: this.pendingPhrase, journalUnreadable: this.unreadable, ready: this.readyFlag };
    for (const l of this.listeners) l();
  }

  /** New wallet: a fresh seed, encrypted under `password`; returns the recovery phrase to show once. */
  async create(password: string, seed: Uint8Array = generateMasterSeed()): Promise<string> {
    const own = seed.slice(); // the session owns (and later zeroes) its own copy
    const ks = await createKeystore(own, password, typeof this.kdf === "function" ? this.kdf() : this.kdf);
    this.store.set(KEYSTORE_KEY, JSON.stringify(ks));
    this.store.remove(JOURNAL_KEY);
    this.unreadable = false;
    this.pendingPhrase = seedToPhrase(own);
    this.open(own, emptyJournal());
    this.firstLaunch = true;
    return this.pendingPhrase;
  }

  /** The user has written the phrase down: forget it (the seed stays, encrypted at rest and in memory while unlocked). */
  acknowledgePhrase(): void {
    this.pendingPhrase = null;
    this.emit();
  }

  async unlock(password: string): Promise<boolean> {
    const raw = this.store.get(KEYSTORE_KEY);
    if (!raw) return false;
    const seed = await unlockKeystore(JSON.parse(raw) as Keystore, password);
    if (!seed) return false;
    const key = journalKey(seed);
    const blob = this.store.get(JOURNAL_KEY);
    let journal: JournalData | null = null;
    if (blob) {
      try { journal = decryptJournal(key, JSON.parse(blob) as EncryptedJournal); } catch { journal = null; }
    }
    this.unreadable = !!blob && journal === null; // kept as it is: nothing overwrites it
    this.open(seed, journal ?? emptyJournal());
    this.firstLaunch = false;
    return true;
  }

  /**
   * The stored journal did not decrypt: set it aside under its own key (still encrypted, never deleted) and
   * continue with the journal in memory, which is persisted from now on. The user's choice, never automatic.
   */
  discardUnreadableJournal(): void {
    if (!this.unreadable || !this.data || !this.key) return;
    const blob = this.store.get(JOURNAL_KEY);
    if (blob) this.store.set(UNREADABLE_JOURNAL_KEY, blob);
    this.unreadable = false;
    this.store.set(JOURNAL_KEY, JSON.stringify(encryptJournal(this.key, this.data)));
    this.emit();
  }

  /** Restore from the 24 words: the same seed under a new password; notes come back with a chain rescan. */
  async restoreFromPhrase(phrase: string, password: string): Promise<void> {
    const seed = phraseToSeed(phrase);
    await this.create(password, seed);
    this.firstLaunch = false; // a restore looks for its notes at once (wallet/discovery.ts)
  }

  /**
   * A V6 follow-up (note discovery): true in the session that created this wallet on this device — not a restore, not a
   * later unlock. A first launch stays request-free (spec v2.0 §10): the wallet reads the pool by itself only afterwards.
   */
  isFirstLaunch(): boolean {
    return this.firstLaunch;
  }

  /** Restore keystore + journal from a backup file (its own password). */
  async restoreFromBackup(json: string, password: string): Promise<boolean> {
    const b = JSON.parse(json) as Backup;
    if (b?.v !== 1 || !b.keystore) throw new Error("not a wallet backup file");
    const seed = await unlockKeystore(b.keystore, password);
    if (!seed) return false;
    this.store.set(KEYSTORE_KEY, JSON.stringify(b.keystore));
    if (b.journal) this.store.set(JOURNAL_KEY, JSON.stringify(b.journal)); else this.store.remove(JOURNAL_KEY);
    return this.unlock(password);
  }

  /** The backup file: keystore + encrypted journal, both already encrypted; safe to store anywhere. */
  exportBackup(): string {
    const ks = this.store.get(KEYSTORE_KEY);
    if (!ks) throw new Error("no wallet to back up");
    const j = this.store.get(JOURNAL_KEY);
    const b: Backup = { v: 1, keystore: JSON.parse(ks), journal: j ? JSON.parse(j) : null };
    return JSON.stringify(b);
  }

  /** The recovery phrase of the unlocked wallet (advanced users; shown only after re-entering the password). */
  async revealPhrase(password: string): Promise<string | null> {
    const raw = this.store.get(KEYSTORE_KEY);
    if (!raw) return null;
    const seed = await unlockKeystore(JSON.parse(raw) as Keystore, password);
    return seed ? seedToPhrase(seed) : null;
  }

  lock(): void {
    this.pendingPhrase = null;
    this.firstLaunch = false;
    this.seed?.fill(0);
    this.key?.fill(0);
    this.seed = null; this.key = null; this.data = null;
    this.unreadable = false;
    noteStore.clear();
    this.holdList.clear(); // a lock ends every critical section; a stale release is a no-op
    // V6 Stage 15 (spec v2.0 §8): the runners' caches, the drafts and the crypto worker go with the keys
    for (const h of this.lockHooks) { try { h(); } catch { /* a hook never stops a lock */ } }
    this.emit();
  }

  /**
   * Defers an automatic lock through a critical section — the signature prompt, proving, submission, commit → hand-over
   * (spec v2.0 §8) — for at most 30 minutes (../session/autoLock.ts). Returns the release; an explicit lock ignores holds.
   */
  hold(reason: string, now = Date.now()): () => void {
    const id = ++this.holdSeq;
    this.holdList.set(id, { reason, since: now });
    this.emit();
    return () => {
      if (this.holdList.delete(id)) this.emit();
    };
  }
  holds(): Hold[] { return [...this.holdList.values()]; }
  /** Runs at every lock (explicit or automatic), before the screens hear of it. */
  onLock(fn: () => void): () => void { this.lockHooks.add(fn); return () => { this.lockHooks.delete(fn); }; }
  /** A safe point: the scheduler between two runner ticks (a lock past the hold cap waits for one). */
  safePoint(): void { for (const h of this.safeHooks) h(); }
  onSafePoint(fn: () => void): () => void { this.safeHooks.add(fn); return () => { this.safeHooks.delete(fn); }; }

  /** Forget this wallet on this device (the phrase or a backup file is then the only way back). */
  forget(): void {
    this.lock();
    this.store.remove(KEYSTORE_KEY);
    this.store.remove(JOURNAL_KEY);
    this.emit();
  }

  journal(): JournalData {
    if (!this.data) throw new Error("wallet locked");
    return this.data;
  }

  /**
   * Mutate the journal, persist it encrypted and notify the screens. No-op while locked. While the stored
   * journal is unreadable the change stays in memory (the blob on disk is not touched).
   */
  update(fn: (j: JournalData) => void): void {
    if (!this.data || !this.key) return;
    fn(this.data);
    if (!this.unreadable) this.store.set(JOURNAL_KEY, JSON.stringify(encryptJournal(this.key, this.data)));
    this.emit();
  }

  private open(seed: Uint8Array, journal: JournalData): void {
    this.seed = seed;
    this.key = journalKey(seed);
    this.data = journal;
    noteStore.load({ notes: journal.notes, noteCounter: journal.noteCounter }); // triggers a journal write (same content)
    if (journal.settings) settings.set(journal.settings as Partial<Settings>);
    this.emit();
  }
}

/**
 * Tests and dev builds may lower the scrypt cost (the configuration's kdfLog2N, 12…20). A production build never goes
 * below the keystore default (a build environment cannot weaken every user's password protection); it may go above.
 */
export function kdfFromConfig(): KdfParams {
  const raw = config().kdfLog2N ?? NaN;
  if (!Number.isInteger(raw) || raw < 12 || raw > 20) return KDF_DEFAULT;
  const N = 1 << raw;
  return config().production && N < KDF_DEFAULT.N ? KDF_DEFAULT : { ...KDF_DEFAULT, N };
}

export const session = new WalletSession(browserStorage, kdfFromConfig);
