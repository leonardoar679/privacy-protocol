// The non-sensitive preferences (spec §8): the experience mode, the theme, the locale, the recent network, the
// backup timestamps, the last connector, the first-launch flag, the databases to delete at the next start — and nothing else: no amount, no
// pair, no address, no operation time. Persisted in the `prefs` store under one key; a value outside the schema is refused, and a
// stored value that no longer parses is replaced by the defaults (the wallet never fails to start over a preference).
import { z } from "zod";
import { hasIndexedDb, idbGet, idbPut } from "./idb";

export const PrefsSchema = z.object({
  v: z.literal(1),
  experience: z.enum(["simple", "advanced"]),
  theme: z.enum(["system", "light", "dark"]),
  locale: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/),
  // V6 Stage 16: the user chose `locale` under More → Language (absent: "Automatic", the browser's languages decide)
  localeChosen: z.boolean().optional(),
  recentNetwork: z.number().int().nonnegative().optional(),
  backup: z.object({ phraseAcknowledgedAt: z.number().int().optional(), exportedAt: z.number().int().optional() }).strict().optional(),
  lastConnector: z.string().max(64).optional(),
  firstLaunchDone: z.boolean(),
  // the eleventh review round (2026-11-04, A11-3/H11-4): a database a page could not delete under its own connection (WalletConnect's)
  pendingWipe: z.array(z.string().max(64)).max(8).optional(),
}).strict();
export type Prefs = z.infer<typeof PrefsSchema>;

export const PREFS_KEY = "prefs";
export const DEFAULT_PREFS: Prefs = { v: 1, experience: "simple", theme: "system", locale: "en", firstLaunchDone: false };

export interface PrefsStore {
  readonly ready: Promise<void>;
  readonly backend: "indexeddb" | "memory";
  get(): Prefs;
  update(patch: Partial<Omit<Prefs, "v">>): Prefs;
  reset(): void;
  subscribe(l: () => void): () => void;
  flush(): Promise<void>;
  /**
   * What the store holds now, after this page's own writes: read again when this tab takes the wallet over from another
   * (2026-10-17, the audit's unverified m46 — the store was read once per page, and a tab taking over wrote back the
   * preferences it had loaded: another tab's backup time, experience and language lost).
   */
  reload(): Promise<void>;
}

export function parsePrefs(raw: unknown): Prefs {
  return PrefsSchema.parse(raw);
}

export function createPrefsStore(): PrefsStore {
  let current: Prefs = { ...DEFAULT_PREFS };
  const listeners = new Set<() => void>();
  const useIdb = hasIndexedDb();
  let queue: Promise<void> = Promise.resolve();
  const emit = () => { for (const l of listeners) l(); };
  // a store never read is never written (audit round 2, n24): a first read that failed had left the defaults in memory, and the
  // next change wrote them over the stored backup times, experience and language once IndexedDB answered again. Until a read
  // succeeds, this page's changes wait in `pending`; a write reads the store first and puts them on what it holds.
  let loaded = !useIdb;
  let pending: Partial<Prefs> = {};
  let replace = false; // a reset not yet written: what is stored is not merged under it
  let resets = 0;
  // a patch on what the store holds when the write runs, never this page's whole copy (the eleventh review round, 2026-11-04, H11-7): a tab
  // loaded before a Forget in another had written the forgotten wallet's connector, locale and experience back over the reset; a reset
  // writes the defaults with this page's changes since
  const persist = () => {
    if (!useIdb) return;
    queue = queue
      .then(async () => {
        if (!loaded) await load();
        if (!loaded) return; // still unreadable: the changes stay in memory and pending
        const written = pending;
        const wasReplace = replace;
        const at = resets;
        pending = {};
        try {
          let base: Prefs = { ...DEFAULT_PREFS };
          if (!wasReplace) {
            const raw = await idbGet("prefs", PREFS_KEY);
            const parsed = raw === undefined ? null : PrefsSchema.safeParse(JSON.parse(raw));
            base = parsed?.success ? parsed.data : { ...DEFAULT_PREFS };
          }
          const next = PrefsSchema.parse({ ...base, ...written, v: 1 });
          await idbPut("prefs", PREFS_KEY, JSON.stringify(next));
          if (resets === at) replace = false;
          // what another tab wrote is this page's too, under the changes it has not written yet
          const shown = PrefsSchema.parse({ ...next, ...pending, v: 1 });
          if (JSON.stringify(shown) !== JSON.stringify(current)) {
            current = shown;
            emit();
          }
        } catch (e) {
          pending = { ...written, ...pending };
          throw e;
        }
      })
      .catch(() => undefined);
  };
  const load = async (): Promise<void> => {
    if (!useIdb) return;
    try {
      const raw = await idbGet("prefs", PREFS_KEY);
      loaded = true;
      if (raw !== undefined) {
        const parsed = PrefsSchema.safeParse(JSON.parse(raw));
        // the screens hear only of a change: a read that finds what this page holds says nothing (a takeover's reload had
        // re-applied a locale the page's URL no longer named); this page's changes not yet written stay on top
        if (parsed.success) { const next = PrefsSchema.parse({ ...(replace ? {} : parsed.data), ...pending, v: 1 }); const changed = JSON.stringify(next) !== JSON.stringify(current); current = next; if (changed) emit(); } else persist(); // an unreadable preference is replaced by the defaults
      }
    } catch { /* what this page holds stands; not read: nothing is written until a read succeeds */ }
  };
  const ready = load();
  return {
    ready,
    backend: useIdb ? "indexeddb" : "memory",
    get: () => current,
    update: (patch) => {
      const next = PrefsSchema.parse({ ...current, ...patch, v: 1 }); // refuses an unknown key or a bad value before anything changes
      current = next;
      pending = { ...pending, ...patch };
      persist();
      emit();
      return next;
    },
    reset: () => { current = { ...DEFAULT_PREFS }; pending = { ...DEFAULT_PREFS }; replace = true; resets++; persist(); emit(); },
    subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    flush: () => queue,
    reload: () => (queue = queue.then(load, load)),
  };
}

let shared: PrefsStore | null = null;
export function prefs(): PrefsStore { return (shared ??= createPrefsStore()); }
export function resetPrefsStore(): void { shared = null; }
