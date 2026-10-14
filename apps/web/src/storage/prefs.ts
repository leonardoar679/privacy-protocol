// The non-sensitive preferences (spec §8): the experience mode, the theme, the locale, the recent network, the
// backup timestamps, the last connector, the first-launch flag — and nothing else: no amount, no pair, no address,
// no operation time. Persisted in the `prefs` store under one key; a value outside the schema is refused, and a
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
  const persist = () => { if (!useIdb) return; const snapshot = JSON.stringify(current); queue = queue.then(() => idbPut("prefs", PREFS_KEY, snapshot), () => idbPut("prefs", PREFS_KEY, snapshot)).catch(() => undefined); };
  const ready = (async () => {
    if (!useIdb) return;
    try {
      const raw = await idbGet("prefs", PREFS_KEY);
      if (raw !== undefined) {
        const parsed = PrefsSchema.safeParse(JSON.parse(raw));
        if (parsed.success) { current = parsed.data; emit(); } else persist(); // an unreadable preference is replaced by the defaults
      }
    } catch { /* the defaults stand */ }
  })();
  return {
    ready,
    backend: useIdb ? "indexeddb" : "memory",
    get: () => current,
    update: (patch) => {
      const next = PrefsSchema.parse({ ...current, ...patch, v: 1 }); // refuses an unknown key or a bad value before anything changes
      current = next;
      persist();
      emit();
      return next;
    },
    reset: () => { current = { ...DEFAULT_PREFS }; persist(); emit(); },
    subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    flush: () => queue,
  };
}

let shared: PrefsStore | null = null;
export function prefs(): PrefsStore { return (shared ??= createPrefsStore()); }
export function resetPrefsStore(): void { shared = null; }
