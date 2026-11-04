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
import { config, isConfigured } from "../config";

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

/**
 * The stored journal does not open, and this session saves nothing (audit round 2, r47): a swap committed or funded now
 * would be journaled in memory only — its one-time key's attempt id, its params, its refund payload — and the next lock or
 * reload would forget it, its escrow stranded. Swaps and protected executions wait until the journal is restored from a
 * backup or set aside.
 */
export class JournalUnreadable extends Error {
  readonly code = "journal_unreadable";
  constructor() {
    super("this wallet's journal could not be read: no swap is started or funded until it is restored from a backup or set aside");
    this.name = "JournalUnreadable";
  }
}

/**
 * The device keeps nothing of this wallet past this tab (audit round 2, n46): it refused its storage at hydrate, or refused a
 * write since (r16 says so on the screen). A swap's record holds its order's parameters, which nothing else keeps until the
 * executor has the order: lost when the tab closes, its funded escrow had nothing to be returned by. Swaps and protected
 * executions wait for a browser that keeps the wallet's data; Protect and Send, whose notes the phrase finds again, go on.
 */
export class JournalNotKept extends Error {
  readonly code = "journal_not_kept";
  constructor() {
    super("this browser is not keeping the wallet's data: no swap is started or funded while a closed tab would lose its record");
    this.name = "JournalNotKept";
  }
}

/** Throws JournalUnreadable while the session saves nothing (r47), JournalNotKept while the device keeps nothing past this tab (n46). */
export function assertJournalSaved(s: WalletSession): void {
  if (s.state().journalUnreadable) throw new JournalUnreadable();
  if (s.storageRefused()) throw new JournalNotKept();
}

/**
 * A wallet is already on this device (audit round 2, r27). A tab opened before another tab created one still read "no
 * wallet" — its copy of the store is filled when the page opens — and its Create or Restore wrote over that wallet's keystore
 * and journal with no REPLACE asked. The store is read again first; creating or restoring over a wallet takes the user's
 * typed REPLACE (`replace`).
 */
/** A REPLACE refused: another tab of this browser holds the wallet (the fourth review round, 2026-11-03). Nothing was written. */
export class ReplaceRefused extends Error {
  readonly code = "replace_refused";
  constructor(why: string) {
    super(why);
    this.name = "ReplaceRefused";
  }
}

export class WalletExists extends Error {
  readonly code = "wallet_exists";
  constructor() {
    super("a wallet is already on this device: replacing it takes the typed REPLACE");
    this.name = "WalletExists";
  }
}

/** A critical section that defers an automatic lock (spec v2.0 §8; ../session/autoLock.ts). */
export interface Hold { reason: string; since: number }

/** JSON with every object's keys sorted: settings equal in content compare equal, whatever order a heal built their keys in */
const sortedJson = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));

/** A pinned session's journal was asked after the wallet was locked or replaced (the sixth review round, 2026-11-03): refused. */
export class SessionChanged extends Error {
  readonly code = "locked_mid_flow";
  constructor(what: string) {
    super(`the wallet was locked or replaced since this run began: its journal ${what} is refused`);
    this.name = "SessionChanged";
  }
}

export class WalletSession {
  private seed: Uint8Array | null = null;
  private key: Uint8Array | null = null;
  private data: JournalData | null = null;
  private listeners = new Set<() => void>();
  private pendingPhrase: string | null = null;
  private unreadable = false;
  /** a journal is being loaded into the stores: the mirrors write nothing back (audit round 2, n47) */
  private loading = false;
  private firstLaunch = false;
  private readyFlag = false;
  /** the last create() kept the journal its seed opened (n45): its counters are known, nothing to hold */
  private keptJournal = false;
  private snapshot: SessionState | null = null;
  private readyPromise: Promise<void> | null = null;
  private holdList = new Map<number, Hold>();
  private holdSeq = 0;
  private lockHooks = new Set<() => void>();
  /**
   * The third review round (2026-11-03): which opening of a wallet a flow belongs to — raised at every open and lock, so a result
   * that arrives after a lock, or after another phrase replaced this wallet in the same tab, is never written into the wrong store
   * or journal (the scan records it for the right wallet).
   */
  private epochCount = 0;
  epoch(): number { return this.epochCount; }
  /**
   * This session as a run that began at the current opening sees it (the sixth review round, 2026-11-03): the journal reads and
   * writes of a scheduled runner's tick go through here and are refused once the wallet was locked, or another phrase replaced it
   * in this tab — a tick's late write had gone into whichever journal was open then. Everything else is the session itself.
   */
  pinned(): WalletSession {
    const epoch = this.epochCount;
    return new Proxy(this, {
      get(t, key) {
        if (key === "journal") return () => { if (t.epochCount !== epoch) throw new SessionChanged("read"); return t.journal(); };
        if (key === "update") return (fn: (j: JournalData) => void) => { if (t.epochCount !== epoch) throw new SessionChanged("write"); t.update(fn); };
        const v = Reflect.get(t, key);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
  }
  private safeHooks = new Set<() => void>();
  /** resolves once the store has hydrated and the status reflects the device (V5); started by the first read (V6 Stage 4) */
  get ready(): Promise<void> {
    this.init();
    return this.readyPromise!;
  }

  // the store and the scrypt cost may be given now or resolved at the moment of use (the shared session is built at import,
  // before the platform configures the engine: V6 Stage 3–4)
  constructor(private readonly storageSource: KeyValueStorage | (() => KeyValueStorage) = browserStorage, private readonly kdf: KdfParams | (() => KdfParams) = KDF_DEFAULT) {
    // mirror the in-memory stores into the journal while unlocked — when the notes changed: an unlock's load gives the
    // journal its own notes back, and journaling them again only rewrote what the store held (a V6 follow-up of 2026-10-16:
    // an older tab's unlock had written its old journal over a newer one that way, audit c40)
    noteStore.subscribe(() => {
      const j = this.data;
      if (!j || this.loading) return;
      const s = noteStore.serialize();
      if (j.noteCounter === s.noteCounter && !!j.countersHeld === !!s.countersHeld && JSON.stringify(j.notes) === JSON.stringify(s.notes)) return;
      this.update((x) => { x.notes = s.notes; x.noteCounter = s.noteCounter; if (s.countersHeld) x.countersHeld = true; else delete x.countersHeld; });
    });
    // the settings too, when they changed (audit round 2, r17): an unlock's load gives the journal its own settings back, and
    // journaling them again wrote this tab's copy over another tab's newer journal
    settings.subscribe(() => {
      if (this.loading) return;
      const now = { ...settings.get() };
      if (this.data && sortedJson(this.data.settings) === sortedJson(now)) return;
      this.update((j) => { j.settings = now; });
    });
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
  /** the device keeps nothing of this wallet's store past this tab (n46; the web's secure store says so) */
  storageRefused(): boolean { return this.store.refused === true; }
  isUnlocked(): boolean { return this.seed !== null; }
  subscribe(l: () => void): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
  private emit(): void {
    this.snapshot = { status: this.seed ? "unlocked" : this.hasKeystore() ? "locked" : "none", seed: this.seed, pendingPhrase: this.pendingPhrase, journalUnreadable: this.unreadable, ready: this.readyFlag };
    for (const l of this.listeners) l();
  }

  /** The scrypt cost this session wraps a keystore with: the configuration's, with a production floor under it (kdfFromConfig). */
  private kdfParams(): KdfParams {
    return typeof this.kdf === "function" ? this.kdf() : this.kdf;
  }

  /** New wallet: a fresh seed, encrypted under `password`; returns the recovery phrase to show once. Over a wallet already
   *  here only with `replace` (the user's typed REPLACE): WalletExists otherwise. */
  async create(password: string, seed?: Uint8Array, opts: { replace?: boolean; holdCounters?: boolean } = {}): Promise<string> {
    await this.guardExisting(opts.replace);
    // over a wallet already here (the typed REPLACE): its settings are not the new one's either (r30)
    if (this.hasKeystore() && isConfigured()) settings.reset();
    const generated = seed === undefined;
    const source = seed ?? generateMasterSeed();
    const own = source.slice(); // the session owns (and later zeroes) its own copy
    if (generated) source.fill(0); // the generated original is nobody's: zeroed, not left for the collector (the fifth review round, 2026-11-03)
    const ks = await createKeystore(own, password, this.kdfParams());
    // the journal this very seed opens stays (audit round 2, n45/n69): it is encrypted under the seed, never the password, so
    // a restore of this device's own phrase — the forgotten-password path — had deleted the open orders and campaigns, the
    // address book and the fresh-address counters it still opened
    const kept = this.journalOf(own);
    // a journal set aside as unreadable (audit round 2, n49/n70): this seed's — set aside while another wallet was here — is
    // its journal again when the stored one is not; another wallet's goes with that wallet, as a forget removes it (m44). It
    // had stayed on the device after a create or a restore over it, and a restore of the seed that wrote it never read it
    const aside = this.store.get(UNREADABLE_JOURNAL_KEY) !== null;
    const asideJournal = aside ? this.journalOf(own, UNREADABLE_JOURNAL_KEY) : null;
    const journal = kept ?? asideJournal;
    this.store.set(KEYSTORE_KEY, JSON.stringify(ks));
    if (!kept) this.store.remove(JOURNAL_KEY);
    if (aside && !asideJournal) this.store.remove(UNREADABLE_JOURNAL_KEY);
    this.keptJournal = !!journal;
    this.unreadable = false;
    this.pendingPhrase = seedToPhrase(own);
    // a restore's first journal holds its counters (audit round 2, n71): written without, then held by a second write, a tab
    // closed between the two reopened with the counters free at 0 — the next note made one the restored wallet already had
    this.open(own, journal ?? (opts.holdCounters ? { ...emptyJournal(), countersHeld: true } : emptyJournal()));
    this.update(() => {}); // the new wallet's journal is stored at once, beside its keystore
    if (!kept && asideJournal) this.store.remove(UNREADABLE_JOURNAL_KEY); // stored as the journal just now
    this.firstLaunch = true;
    return this.pendingPhrase;
  }

  /** A stored journal (the journal, or `key`: one set aside), when this seed opens it; null otherwise (none, another wallet's, unreadable). */
  private journalOf(seed: Uint8Array, key: string = JOURNAL_KEY): JournalData | null {
    const blob = this.store.get(key);
    if (!blob) return null;
    const k = journalKey(seed);
    try {
      return decryptJournal(k, JSON.parse(blob) as EncryptedJournal);
    } catch {
      return null;
    } finally {
      k.fill(0); // a key for one read (the fourth review round, 2026-11-03)
    }
  }

  /** What the store holds now (another tab may have created a wallet since this page opened): a wallet there is replaced only with `replace`. */
  private async guardExisting(replace: boolean | undefined): Promise<void> {
    await this.store.refresh?.();
    if (!this.hasKeystore()) return;
    if (replace) {
      // a REPLACE while another tab of this browser holds the wallet (the fourth review round, 2026-11-03): that tab's next write — a
      // tick, a proof's result, a settings mirror — had put the old wallet's journal over the restored one, under a key the new wallet
      // does not have, and the restore's journal was lost. The platform says whether another tab holds it (the Web Lock)
      const why = this.replaceGuard ? await this.replaceGuard() : null;
      if (why) throw new ReplaceRefused(why);
      return;
    }
    this.emit(); // its status reads "locked" now: the screens ask for REPLACE
    throw new WalletExists();
  }

  /** The platform's say on a REPLACE: a word why not (another tab holds the wallet), or null. */
  setReplaceGuard(fn: (() => Promise<string | null>) | null): void { this.replaceGuard = fn; }
  private replaceGuard: (() => Promise<string | null>) | null = null;

  /** The user has written the phrase down: forget it (the seed stays, encrypted at rest and in memory while unlocked). */
  acknowledgePhrase(): void {
    this.pendingPhrase = null;
    this.emit();
  }

  async unlock(password: string): Promise<boolean> {
    // what the store holds now, not what it held when the page opened: another tab may have written since (audit c40)
    await this.store.refresh?.();
    const raw = this.store.get(KEYSTORE_KEY);
    if (!raw) return false;
    const ks = JSON.parse(raw) as Keystore;
    const seed = await unlockKeystore(ks, password);
    if (!seed) return false;
    // a keystore below this build's scrypt cost is wrapped again at today's (the fifth review round, 2026-11-03): the production
    // floor had applied to a creation only — a backup restored from a dev build, or an edited header, kept the device at the
    // weaker cost for every later unlock and backup
    if (ks.kdf.N < this.kdfParams().N) this.store.set(KEYSTORE_KEY, JSON.stringify(await createKeystore(seed, password, this.kdfParams())));
    // and again after the derivation (audit round 2, r17): it takes 0.5–2 s, and the tab that holds the wallet journals meanwhile
    await this.store.refresh?.();
    const key = journalKey(seed);
    const blob = this.store.get(JOURNAL_KEY);
    let journal: JournalData | null = null;
    if (blob) {
      try { journal = decryptJournal(key, JSON.parse(blob) as EncryptedJournal); } catch { journal = null; }
    }
    key.fill(0); // open() derives the session's own (the fourth review round, 2026-11-03: this copy had stayed in memory)
    this.unreadable = !!blob && journal === null; // kept as it is: nothing overwrites it
    this.open(seed, journal ?? emptyJournal());
    // the journal in memory starts empty: which counters were used is unknown until one complete scan (PP-P03) — and so with
    // no journal at all (audit round 2, n71): a create or a restore whose tab closed between its keystore's write and its
    // journal's; a restored wallet's counters were in use
    if (this.unreadable || !blob) noteStore.holdCounters();
    // and at every unlock (the fifth review round, 2026-11-03): the journal's cipher proves this seed wrote it, not that it is the
    // newest — a profile restored from an older copy, a same-origin writer putting an earlier blob back — and its counter then
    // repeats a note's secret, and a deposit's own owner commitment with it (PP-P03). Held until the scan after this unlock has
    // read the pool; a counter it finds that the journal did not know makes the journal stale, and the reserve applies
    noteStore.holdUntilScanned();
    this.firstLaunch = false;
    return true;
  }

  /** Whether `password` opens this device's keystore; nothing else is derived or kept (the fifth review round, 2026-11-03: the check had built the phrase). */
  async verifyPassword(password: string): Promise<boolean> {
    const raw = this.store.get(KEYSTORE_KEY);
    if (!raw) return false;
    const seed = await unlockKeystore(JSON.parse(raw) as Keystore, password);
    if (!seed) return false;
    seed.fill(0);
    return true;
  }

  /**
   * The journal as the store holds it now (a V6 follow-up of 2026-10-16, audit c40). A tab unlocked while another held the
   * wallet opened the journal as it was then, and the other kept writing until it stepped aside; this tab reads it again
   * when it takes the wallet over (apps/web/src/platform/activeTab.ts), before anything of it runs. A journal that does not
   * open, or a lock meanwhile, leaves the session as it is.
   */
  async reload(): Promise<void> {
    if (!this.data || !this.key) return;
    await this.store.refresh?.();
    const key = this.key;
    if (!this.data || this.key !== key) return;
    // this wallet is gone from the device (audit round 2, n27): forgotten in another tab — the session locks, never writing
    // its journal back to a device that let it go
    if (this.store.get(KEYSTORE_KEY) === null) {
      this.lock();
      return;
    }
    const blob = this.store.get(JOURNAL_KEY);
    if (!blob) return;
    let journal: JournalData | null = null;
    try { journal = decryptJournal(key, JSON.parse(blob) as EncryptedJournal); } catch { journal = null; }
    // ...or replaced by a wallet whose journal this seed does not open (forgotten, then another made): locked too, never
    // written over it. A session whose own stored journal never opened (the unreadable state) stays as it is
    if (!journal) {
      if (!this.unreadable) this.lock();
      return;
    }
    // it opens now — the other tab set the unreadable one aside and replaced it (n22): this session saves again
    this.unreadable = false;
    this.data = journal;
    this.loadStores(journal);
    this.emit();
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

  /**
   * Restore from the 24 words: the same seed under a new password; notes come back with a chain rescan. No new note is
   * made before one complete scan has seen the counters already used (PP-P03; the audit round of 2026-10-16).
   */
  async restoreFromPhrase(phrase: string, password: string, opts: { replace?: boolean } = {}): Promise<void> {
    const seed = phraseToSeed(phrase);
    try {
      // the counters are held from its first journal on, unless its own journal was kept: the counters it used are known then
      await this.create(password, seed, { ...opts, holdCounters: true });
    } finally {
      seed.fill(0); // create() keeps its own copy (the fourth review round, 2026-11-03: this one had stayed in memory)
    }
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
  async restoreFromBackup(json: string, password: string, opts: { replace?: boolean } = {}): Promise<boolean> {
    const b = JSON.parse(json) as Backup;
    if (b?.v !== 1 || !b.keystore) throw new Error("not a wallet backup file");
    await this.guardExisting(opts.replace);
    const seed = await unlockKeystore(b.keystore, password);
    if (!seed) return false;
    // a journal set aside as unreadable goes unless this seed opens it (audit round 2, n49): another wallet's had stayed
    if (this.store.get(UNREADABLE_JOURNAL_KEY) !== null && !this.journalOf(seed, UNREADABLE_JOURNAL_KEY)) this.store.remove(UNREADABLE_JOURNAL_KEY);
    // wrapped again at this build's scrypt cost (the fifth review round, 2026-11-03): the file's own parameters — a dev build's, an
    // edited header's — had become the device's for good, every later unlock and backup at the weaker cost
    const ks = await createKeystore(seed, password, this.kdfParams());
    seed.fill(0); // unlock() below derives the session's own from the keystore (the fourth review round, 2026-11-03)
    this.store.set(KEYSTORE_KEY, JSON.stringify(ks));
    if (b.journal) this.store.set(JOURNAL_KEY, JSON.stringify(b.journal)); else this.store.remove(JOURNAL_KEY);
    const ok = await this.unlock(password);
    // a backup may be older than the wallet's last notes: its counter is held until one complete scan (PP-P03)
    if (ok) noteStore.holdCounters();
    return ok;
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
    if (!seed) return null;
    try {
      return seedToPhrase(seed);
    } finally {
      seed.fill(0); // the phrase is the screen's for a moment; this copy of the seed was not (the fourth review round, 2026-11-03)
    }
  }

  lock(): void {
    this.epochCount++;
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

  /**
   * Forget this wallet on this device (the phrase or a backup file is then the only way back): its three records, a
   * journal set aside as unreadable among them — it had stayed on the device (2026-10-17, the audit's unverified m44).
   */
  forget(): void {
    this.lock();
    this.store.remove(KEYSTORE_KEY);
    this.store.remove(JOURNAL_KEY);
    this.store.remove(UNREADABLE_JOURNAL_KEY);
    // the next wallet of this tab starts from the defaults (audit round 2, r30): one created or restored after this one was
    // forgotten had kept its settings (its submission, its reads, its protection) and journaled them at its first write
    if (isConfigured()) settings.reset();
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
    this.epochCount++;
    this.seed = seed;
    this.key = journalKey(seed);
    this.data = journal;
    this.loadStores(journal);
    this.emit();
  }

  /**
   * A journal's notes and settings into the in-memory stores, writing nothing (audit round 2, n47): the settings a load heals
   * (a key this build added, a value out of range) stay in memory and go out with the next write. The settings mirror had
   * journaled them at once — an unlock or a takeover wrote the whole journal as this tab had just read it, over a write of
   * the other tab in between.
   */
  private loadStores(journal: JournalData): void {
    this.loading = true;
    try {
      noteStore.load({ notes: journal.notes, noteCounter: journal.noteCounter, countersHeld: journal.countersHeld });
      if (journal.settings) settings.set(journal.settings as Partial<Settings>);
    } finally {
      this.loading = false;
    }
    if (journal.settings) journal.settings = { ...settings.get() };
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
