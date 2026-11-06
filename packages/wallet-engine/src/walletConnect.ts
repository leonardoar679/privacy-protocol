// WalletConnect (spec §7; plan §11): loaded only when the user taps it — or, after a reload, when its own store holds a
// session to take up (the review round of 2026-11-02: never an idle socket to the relay for nothing) — and only when a
// project id is configured (VITE_WC_PROJECT_ID). Its relay sees the session's metadata and the IPs of both ends — said on
// the "What stays private" screen (spec §3.13), not mitigated here. The connector is an EIP-1193 provider like the others.
import type { Eip1193Provider } from "./injected";

let projectId: string | undefined;
let deferDeletion: ((db: string) => void) | undefined;
/**
 * The platform sets WalletConnect's project id (apps/web/src/config.ts applyConfig): the connector exists only with one. `deferDeletion`: where
 * the platform keeps a database to delete at the next page start (the eleventh review round, 2026-11-04, A11-3/H11-4).
 */
export function configureWalletConnect(id: string | undefined, o: { deferDeletion?: (db: string) => void } = {}): void {
  projectId = id;
  deferDeletion = o.deferDeletion;
}
/**
 * WalletConnect's library was loaded in this page: its core keeps a connection to its database open for the page's life (idb-keyval, no
 * versionchange handler), so a deletion from this page waits for the page to go — and every later open of that database waits behind it.
 */
let loadedHere = false;
export const walletConnectLoadedHere = (): boolean => loadedHere;

/**
 * The Web Lock a page that loads WalletConnect holds, shared, for its life (the eleventh review round's critique, 2026-11-04): its connection
 * to WalletConnect's database stays open, so another page's deletion of that database is blocked by it — and stays queued in the browser, every
 * later open of the database on this origin behind it, a WalletConnect connection "connecting" until that page closed. A deletion is made only
 * while no page holds the lock (exclusive, if available), and a page loading WalletConnect waits for a deletion in progress.
 */
export const WALLET_CONNECT_LOCK = "privacy-wallet:walletconnect";
const lockManager = (): LockManager | null => (typeof navigator !== "undefined" ? (navigator.locks ?? null) : null);
function holdWhileLoaded(): Promise<void> {
  const locks = lockManager();
  if (!locks) return Promise.resolve();
  return new Promise((resolve) => {
    locks
      .request(WALLET_CONNECT_LOCK, { mode: "shared" }, () => {
        resolve();
        return new Promise<void>(() => undefined); // held until the page goes
      })
      .catch(() => resolve());
  });
}
/** How long a deletion another connection blocks is waited for before it is called blocked (the platform's DELETE_WAIT_MS). */
const DELETE_WAIT_MS = 5_000;
function deleteDb(idb: IDBFactory | null | undefined, name: string): Promise<"deleted" | "blocked" | "failed"> {
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest | undefined;
    try {
      req = idb?.deleteDatabase(name);
    } catch {
      req = undefined;
    }
    if (!req) return resolve("failed");
    const timer = setTimeout(() => resolve("blocked"), DELETE_WAIT_MS);
    req.onsuccess = () => {
      clearTimeout(timer);
      resolve("deleted");
    };
    req.onerror = () => {
      clearTimeout(timer);
      resolve("failed");
    };
  });
}
/**
 * WalletConnect's database deleted while no page holds WalletConnect: "held" when one does — the database is kept for a later page start.
 * Without Web Locks nothing is known, and the deletion is made as before.
 */
export async function deleteWalletConnectDatabase(
  del: () => Promise<"deleted" | "blocked" | "failed">,
): Promise<"deleted" | "blocked" | "failed" | "held"> {
  const locks = lockManager();
  if (!locks) return del();
  try {
    return await locks.request(WALLET_CONNECT_LOCK, { mode: "exclusive", ifAvailable: true }, async (lock) => (lock ? del() : ("held" as const)));
  } catch {
    return "failed";
  }
}
/**
 * WalletConnect's provider, by its own `isWalletConnect` (a getter on @walletconnect/ethereum-provider's EthereumProvider): its reads go to a
 * host the policy blocks (apps/web/scripts/csp.mjs), so it gives no receipt — the one wallet whose approvals a Protect reads at the first
 * endpoint (audit gap 100; the eleventh review round, F11-10).
 */
export const isWalletConnectProvider = (eth: unknown): boolean => !!eth && (eth as { isWalletConnect?: unknown }).isWalletConnect === true;
export const walletConnectProjectId = (): string | undefined => projectId;
export const walletConnectAvailable = (): boolean => !!walletConnectProjectId();

/**
 * WalletConnect's own session store holds a session this origin can take up: its sign client keeps a list under
 * `wc@2:client:<store version>//session` in localStorage. Nothing there (or no storage): nothing to initialize at a reload.
 */
export function hasWalletConnectSession(): boolean {
  try {
    const store = globalThis.localStorage;
    if (!store) return false;
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (!key || !/^wc@2:client:[^/]*\/\/session$/.test(key)) continue;
      const list = JSON.parse(store.getItem(key) ?? "[]") as unknown;
      if (Array.isArray(list) && list.length) return true;
    }
  } catch {
    // no storage, or unreadable: nothing to take up
  }
  return false;
}

/** WalletConnect's provider, as the connection uses it. */
export interface WcProvider extends Eip1193Provider {
  disconnect(): Promise<void>;
  /** its connect() when it holds no session — the pairing, whose link it gives as a `display_uri` event —, then the accounts */
  enable(): Promise<string[]>;
}

let cached: WcProvider | null = null;
/** The provider's init under way: one at a time (the eleventh review round, slice 6c's critique). */
let initing: Promise<WcProvider> | null = null;

export async function walletConnectProvider(chainId: number): Promise<WcProvider | null> {
  const projectId = walletConnectProjectId();
  if (!projectId) return null;
  if (cached) return cached;
  // one init at a time (the eleventh review round, slice 6c's critique): two taps while the library loaded had made two providers and kept
  // the last — a Disconnect then ended the one never paired, and left the paired one open at its relay
  return initing ?? startInit(projectId, chainId);
}

function startInit(projectId: string, chainId: number): Promise<WcProvider> {
  const init = initProvider(projectId, chainId);
  initing = init;
  void init.then(
    (p) => {
      if (initing !== init) return; // ended meanwhile (endWalletConnect ends what it makes)
      cached = p;
      initing = null;
    },
    () => {
      if (initing === init) initing = null;
    },
  );
  return init;
}

async function initProvider(projectId: string, chainId: number): Promise<WcProvider> {
  // the page holds WalletConnect from here on (WALLET_CONNECT_LOCK), after any deletion of its database in progress
  await holdWhileLoaded();
  const mod = await import("@walletconnect/ethereum-provider");
  loadedHere = true;
  const origin = typeof location === "undefined" ? "https://localhost" : location.origin;
  const provider = await mod.EthereumProvider.init({
    projectId,
    chains: [chainId],
    // the pairing shows in the wallet's own sheet, from the provider's display_uri (the eleventh review round, slice 6c's critique): the
    // library's modal writes its styles as <style> elements, which the page's policy refuses (style-src 'self') — under it the modal took
    // no tap and sat under the sheet, and a phone could neither start a pairing nor cancel one
    showQrModal: false,
    metadata: {
      name: "Privacy Wallet",
      description: "A private wallet",
      url: origin,
      // V7 Stage 16 (spec v3.0 §9): the icon a wallet shows for this site, and where a phone's wallet app returns after signing
      icons: [`${origin}/icon.svg`],
      redirect: { universal: origin },
    },
  });
  return provider as unknown as WcProvider;
}

/**
 * Ends the WalletConnect session (2026-10-17, the audit's unverified m65): "Disconnect" had only forgotten the account,
 * the relay socket stayed open and the next WalletConnect connection reused the session. The provider is forgotten, so
 * the next connection is a new pairing. A session the wallet already ended is not an error.
 */
let ending: Promise<void> | null = null;
export function endWalletConnect(): Promise<void> {
  // one end at a time: a Disconnect's and a Forget's awaiting the same (the round's second critique: the Forget awaits it)
  if (ending) return ending;
  const held = cached;
  const pending = initing;
  cached = null;
  initing = null;
  ending = (async () => {
    // an init under way is waited for, and the provider it makes is ended too: never left to pair with nothing here to end it
    const p = held ?? (pending ? await pending.catch(() => null) : null);
    if (p) await p.disconnect().catch(() => {});
    // its keys through its own storage, on the connection it holds (A11-3, H11-4): a deletion of the database from this page is blocked by
    // that connection; the database itself goes at a later page start
    await clearThroughStore(storeOf(p));
    await clearWalletConnectStorage();
  })().finally(() => {
    ending = null;
  });
  return ending;
}

interface KeyStore { getKeys(): Promise<string[]>; removeItem(key: string): Promise<void> }
/** The core's key-value store (EthereumProvider → UniversalProvider → SignClient → Core): its getKeys and removeItem, or null. */
const storeOf = (p: unknown): KeyStore | null => {
  const s = (p as { signer?: { client?: { core?: { storage?: Partial<KeyStore> } } } } | null)?.signer?.client?.core?.storage;
  return s && typeof s.getKeys === "function" && typeof s.removeItem === "function" ? (s as KeyStore) : null;
};
async function clearThroughStore(s: KeyStore | null): Promise<void> {
  if (!s) return;
  try {
    for (const k of await s.getKeys()) await s.removeItem(k).catch(() => undefined);
  } catch {
    // unreadable: the deletion at the next start removes it
  }
}

/**
 * WalletConnect's and AppKit's own localStorage entries — the session, the pairings, the keychain, the connected account's
 * record — gone with the session (the fourth review round, 2026-11-03): they stayed after a Disconnect, a link between the public
 * account and this origin's storage that the "localStorage holds nothing" rule did not count. Called by Disconnect and Forget.
 */
/** WalletConnect 2's own IndexedDB store (@walletconnect/keyvaluestorage): the pairing, the session with the account, the keychain. */
export const WALLET_CONNECT_DB = "WALLET_CONNECT_V2_INDEXED_DB";

/** Resolves once the database is deleted, kept for the next page start, or found blocked (DELETE_WAIT_MS); the localStorage entries go at once. */
export function clearWalletConnectStorage(idb: IDBFactory | null | undefined = globalThis.indexedDB): Promise<void> {
  // its IndexedDB store too (the tenth review round, D-3): WalletConnect 2.26 moves every wc@ key there, and a Disconnect or a Forget that
  // cleared localStorage alone had left the session, its account and its keychain on the device. Never from a page where WalletConnect is
  // loaded (the eleventh review round, A11-3/H11-4): its own connection blocks the deletion — the next page start deletes it; nor while
  // another page holds it (the round's critique): kept for a later start then too
  let deleting: Promise<void> = Promise.resolve();
  if (loadedHere) deferDeletion?.(WALLET_CONNECT_DB);
  else
    deleting = deleteWalletConnectDatabase(() => deleteDb(idb, WALLET_CONNECT_DB)).then((r) => {
      if (r === "held") deferDeletion?.(WALLET_CONNECT_DB);
    });
  try {
    const store = globalThis.localStorage;
    if (!store) return deleting;
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k && (/^wc@2:/.test(k) || /^(@appkit|@w3m|W3M_|WALLETCONNECT_|wagmi\.)/i.test(k) || /appkit/i.test(k))) keys.push(k);
    }
    for (const k of keys) store.removeItem(k);
  } catch {
    // no storage, or unreadable: nothing to clear
  }
  return deleting;
}

/**
 * A session approved after its connection was cancelled (the eleventh review round, slice 6c): the provider the page holds is ended as a
 * Disconnect ends it; one forgotten since has its session ended at its relay and nothing else — the store it shares keeps the held one's keys.
 */
export function endWalletConnectOf(p: WcProvider): Promise<void> {
  return p === cached ? endWalletConnect() : p.disconnect().catch(() => undefined);
}

/** Tests: forget the cached provider, an init under way (and that the library was loaded). */
export function resetWalletConnect(): void { cached = null; initing = null; loadedHere = false; }
/** Tests: the library as loaded in this page. */
export function markWalletConnectLoaded(): void { loadedHere = true; }
