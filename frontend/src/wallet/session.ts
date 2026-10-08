// The wallet session (plan §44): create / unlock / lock / restore, and the encrypted journal that
// follows the unlocked seed. Recovery never depends on this site: the 24-word phrase alone restores
// the seed (then a chain rescan rebuilds the notes), and the backup file restores seed + journal.
// V2 (Stage 4): every journal write notifies the screens (the scheduler patches orders from any tab),
// and a journal that fails to decrypt is kept, never overwritten — the wallet opens read-only on an
// empty journal and says so until the user restores a backup or sets the unreadable one aside.
import { useSyncExternalStore } from "react";
import { generateMasterSeed } from "../keys/wallet";
import { createKeystore, KDF_DEFAULT, phraseToSeed, seedToPhrase, unlockKeystore, type KdfParams, type Keystore } from "./keystore";
import { decryptJournal, emptyJournal, encryptJournal, journalKey, type EncryptedJournal, type JournalData } from "./journal";
import { browserStorage, JOURNAL_KEY, KEYSTORE_KEY, UNREADABLE_JOURNAL_KEY, type KeyValueStorage } from "./storage";
import { noteStore } from "./notes";
import { settings, type Settings } from "./settings";

export type SessionStatus = "none" | "locked" | "unlocked";
export interface SessionState {
  status: SessionStatus;
  seed: Uint8Array | null;
  /** set right after create(): the 24 words the user must acknowledge before the wallet screens appear */
  pendingPhrase: string | null;
  /** the stored journal did not decrypt under this seed: the session runs on an empty journal and writes nothing (see discardUnreadableJournal) */
  journalUnreadable: boolean;
}

export interface Backup { v: 1; keystore: Keystore; journal: EncryptedJournal | null }

export class WalletSession {
  private seed: Uint8Array | null = null;
  private key: Uint8Array | null = null;
  private data: JournalData | null = null;
  private listeners = new Set<() => void>();
  private pendingPhrase: string | null = null;
  private unreadable = false;
  private snapshot: SessionState;

  constructor(private readonly storage: KeyValueStorage = browserStorage(), private readonly kdf: KdfParams = KDF_DEFAULT) {
    this.snapshot = { status: this.hasKeystore() ? "locked" : "none", seed: null, pendingPhrase: null, journalUnreadable: false };
    // mirror the in-memory stores into the journal while unlocked
    noteStore.subscribe(() => this.update((j) => { const s = noteStore.serialize(); j.notes = s.notes; j.noteCounter = s.noteCounter; }));
    settings.subscribe(() => this.update((j) => { j.settings = { ...settings.get() }; }));
  }

  state(): SessionState { return this.snapshot; }
  hasKeystore(): boolean { return this.storage.get(KEYSTORE_KEY) !== null; }
  isUnlocked(): boolean { return this.seed !== null; }
  subscribe(l: () => void): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
  private emit(): void {
    this.snapshot = { status: this.seed ? "unlocked" : this.hasKeystore() ? "locked" : "none", seed: this.seed, pendingPhrase: this.pendingPhrase, journalUnreadable: this.unreadable };
    for (const l of this.listeners) l();
  }

  /** New wallet: a fresh seed, encrypted under `password`; returns the recovery phrase to show once. */
  async create(password: string, seed: Uint8Array = generateMasterSeed()): Promise<string> {
    const own = seed.slice(); // the session owns (and later zeroes) its own copy
    const ks = await createKeystore(own, password, this.kdf);
    this.storage.set(KEYSTORE_KEY, JSON.stringify(ks));
    this.storage.remove(JOURNAL_KEY);
    this.unreadable = false;
    this.pendingPhrase = seedToPhrase(own);
    this.open(own, emptyJournal());
    return this.pendingPhrase;
  }

  /** The user has written the phrase down: forget it (the seed stays, encrypted at rest and in memory while unlocked). */
  acknowledgePhrase(): void {
    this.pendingPhrase = null;
    this.emit();
  }

  async unlock(password: string): Promise<boolean> {
    const raw = this.storage.get(KEYSTORE_KEY);
    if (!raw) return false;
    const seed = await unlockKeystore(JSON.parse(raw) as Keystore, password);
    if (!seed) return false;
    const key = journalKey(seed);
    const blob = this.storage.get(JOURNAL_KEY);
    let journal: JournalData | null = null;
    if (blob) {
      try { journal = decryptJournal(key, JSON.parse(blob) as EncryptedJournal); } catch { journal = null; }
    }
    this.unreadable = !!blob && journal === null; // kept as it is: nothing overwrites it
    this.open(seed, journal ?? emptyJournal());
    return true;
  }

  /**
   * The stored journal did not decrypt: set it aside under its own key (still encrypted, never deleted) and
   * continue with the journal in memory, which is persisted from now on. The user's choice, never automatic.
   */
  discardUnreadableJournal(): void {
    if (!this.unreadable || !this.data || !this.key) return;
    const blob = this.storage.get(JOURNAL_KEY);
    if (blob) this.storage.set(UNREADABLE_JOURNAL_KEY, blob);
    this.unreadable = false;
    this.storage.set(JOURNAL_KEY, JSON.stringify(encryptJournal(this.key, this.data)));
    this.emit();
  }

  /** Restore from the 24 words: the same seed under a new password; notes come back with a chain rescan. */
  async restoreFromPhrase(phrase: string, password: string): Promise<void> {
    const seed = phraseToSeed(phrase);
    await this.create(password, seed);
  }

  /** Restore keystore + journal from a backup file (its own password). */
  async restoreFromBackup(json: string, password: string): Promise<boolean> {
    const b = JSON.parse(json) as Backup;
    if (b?.v !== 1 || !b.keystore) throw new Error("not a wallet backup file");
    const seed = await unlockKeystore(b.keystore, password);
    if (!seed) return false;
    this.storage.set(KEYSTORE_KEY, JSON.stringify(b.keystore));
    if (b.journal) this.storage.set(JOURNAL_KEY, JSON.stringify(b.journal)); else this.storage.remove(JOURNAL_KEY);
    return this.unlock(password);
  }

  /** The backup file: keystore + encrypted journal, both already encrypted; safe to store anywhere. */
  exportBackup(): string {
    const ks = this.storage.get(KEYSTORE_KEY);
    if (!ks) throw new Error("no wallet to back up");
    const j = this.storage.get(JOURNAL_KEY);
    const b: Backup = { v: 1, keystore: JSON.parse(ks), journal: j ? JSON.parse(j) : null };
    return JSON.stringify(b);
  }

  /** The recovery phrase of the unlocked wallet (advanced users; shown only after re-entering the password). */
  async revealPhrase(password: string): Promise<string | null> {
    const raw = this.storage.get(KEYSTORE_KEY);
    if (!raw) return null;
    const seed = await unlockKeystore(JSON.parse(raw) as Keystore, password);
    return seed ? seedToPhrase(seed) : null;
  }

  lock(): void {
    this.pendingPhrase = null;
    this.seed?.fill(0);
    this.key?.fill(0);
    this.seed = null; this.key = null; this.data = null;
    this.unreadable = false;
    noteStore.clear();
    this.emit();
  }

  /** Forget this wallet on this device (the phrase or a backup file is then the only way back). */
  forget(): void {
    this.lock();
    this.storage.remove(KEYSTORE_KEY);
    this.storage.remove(JOURNAL_KEY);
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
    if (!this.unreadable) this.storage.set(JOURNAL_KEY, JSON.stringify(encryptJournal(this.key, this.data)));
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

/** Tests and dev builds may lower the scrypt cost (VITE_KDF_LOG2N, 12…20); production keeps the default. */
function kdfFromEnv(): KdfParams {
  const raw = Number((import.meta as any).env?.VITE_KDF_LOG2N ?? NaN);
  return Number.isInteger(raw) && raw >= 12 && raw <= 20 ? { ...KDF_DEFAULT, N: 1 << raw } : KDF_DEFAULT;
}

export const session = new WalletSession(browserStorage(), kdfFromEnv());
export const useSession = (): SessionState => useSyncExternalStore((l) => session.subscribe(l), () => session.state());
