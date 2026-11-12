// WalletConnect (spec §7; plan §11): loaded only when the user taps it — or, after a reload, when its own store holds a
// session to take up (the review round of 2026-11-02: never a socket to the relay for nothing at a page's start; once loaded,
// the socket stays for the page's life, ended sessions or not: audit gap 112) — and only when a project id is configured
// (VITE_WC_PROJECT_ID). Its relay sees the session's metadata and the IPs of both ends — said on the "What stays private"
// screen (spec §3.13), not mitigated here. The connector is an EIP-1193 provider like the others.
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
  /** the session it holds, if any: none once its cleanup ran — at its own delete, or at the wallet app's end */
  readonly session?: unknown;
}

/**
 * The page's one WalletConnect provider (the twelfth review round, slice 12d3c; the owner's decision of 2026-11-12): made once and kept for
 * the page's life, paired again after an end. An end had forgotten it and the next tap had made a second over the page's one Core, whose
 * first sign client then unsubscribed the second's session within a heartbeat (its cleanupOrphanedSubscriptions drops every topic its own
 * store does not hold): a reconnect in the same page went deaf, its requests reaching the wallet app and their answers never the page.
 */
let cached: WcProvider | null = null;
/** The provider's init under way: one at a time (the eleventh review round, slice 6c's critique). */
let initing: Promise<WcProvider> | null = null;
/**
 * What an earlier end left on the page's provider (the twelfth review round, B12-3): why its delete failed (offline, its publish expired) —
 * the session still held, which its enable() would take up: the next tap deletes it again before it pairs —, or UNFINISHED: that delete
 * acknowledged but still under way past its bound, no tap pairing until it settles; null: nothing left. Set by an end and by a tap's delete
 * again: a delete that settles late leaves it set, with nothing left, until the next tap.
 */
let leftover: string | null = null;
const UNFINISHED = "its unsubscribe still unanswered at the relay";

/**
 * WalletConnect does not pair while the session an earlier end in this page left is still there, its delete failed again (B12-3): a later
 * tap deletes it again once online; a reload starts afresh, that session then listed in the wallet app until it ages out (audit gap 112).
 * `why`, the library's own words, shows under Advanced only.
 */
export class WalletConnectSessionLeft extends Error {
  constructor(why: string) {
    super(`WalletConnect could not delete the session an earlier end left in this page (${why})`);
  }
}
/**
 * WalletConnect does not pair while an earlier end's delete is still under way past its bound (B12-3): acknowledged — the wallet app has
 * removed the session — but its unsubscribe unanswered, and the library would finish it, its cleanup run on the provider, once it is. A tap
 * is refused until then, which never comes when that answer was lost with a socket that dropped: a reload starts afresh, nothing listed
 * (audit gap 112).
 */
export class WalletConnectEndUnfinished extends Error {
  constructor() {
    super(`WalletConnect has not finished ending a session an earlier end in this page began (${UNFINISHED})`);
  }
}

export async function walletConnectProvider(chainId: number): Promise<WcProvider | null> {
  const projectId = walletConnectProjectId();
  if (!projectId) return null;
  // an end under way is waited for first — a Disconnect's, a Forget's, a late approval's (the twelfth review round, B12-2): the sign client
  // deletes a session only once the relay has acknowledged its delete and the unsubscribe, and a connection made meanwhile took that session
  // up — connected with no pairing, on a session the wallet app deleted a moment later, every request refused. The tap reads "Connecting…"
  // meanwhile: at most an end's bound, then a delete again's (walletConnectEndTiming)
  for (let under = ending; under; under = ending) await under.catch(() => undefined);
  if (cached && leftover !== null) {
    // the session an earlier end left, deleted again before anything pairs (B12-3; at a tap, the owner's decision of 2026-11-12, or by a
    // later end — a Forget's —, never at the browser's online): the library's cleanup at that delete expires every pairing of the Core, none
    // of this tap's yet. Run as an end (none is under way here, the loop above waited for it), so a second tap waits for it there
    ending = deleteAgain(cached);
    await ending.catch(() => undefined);
    if (leftover !== null) throw leftover === UNFINISHED ? new WalletConnectEndUnfinished() : new WalletConnectSessionLeft(leftover);
  }
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
      if (initing !== init) return; // tests: reset meanwhile
      cached = p; // the page's one provider, an end under way or not (endWalletConnect ends the session it took up, and keeps it)
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
 * and the next WalletConnect connection reused the session. Its session deleted, the page's one provider is kept and the
 * next connection is a new pairing on it (12d3c); one whose delete failed keeps that session, deleted again at the next
 * tap before it pairs, and one still under way past its bound refuses every tap until it settles (B12-3). A session the
 * wallet already ended is not an error. The page's socket to the
 * relay stays open for the page's life — nothing subscribed once the end is complete (B12-8; stated in audit gap 112).
 * It is not closed: closing it right after the end cut the library's own pairing deletion short.
 */
let ending: Promise<void> | null = null;
/**
 * How long an end's delete is waited for (tests shorten it), just past the library's own bound on the delete's publish (60 s): the unsubscribe
 * after it has none, and a socket dropped before its answer had left the end — and every tap waiting on it — pending for good (the critique
 * of 12d3a). Past it the end goes on to its key clearing, as after a failed delete; every tap is then refused until that delete settles —
 * never, when its unsubscribe's answer was lost with a socket that dropped: a reload starts afresh (B12-3; audit gap 112).
 */
export const walletConnectEndTiming = { boundMs: 65_000 };
/** `end`'s outcome, or undefined once `ms` passes first (or it rejects). */
function within<T>(end: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(undefined), ms);
    const done = (v: T | undefined) => {
      clearTimeout(t);
      resolve(v);
    };
    void end.then(done, () => done(undefined));
  });
}
const messageOf = (e: unknown): string =>
  typeof (e as { message?: unknown } | null)?.message === "string" ? (e as { message: string }).message : String(e);
/**
 * The page's provider's disconnect under way — an end's or a delete again's —: its outcome (null: the session gone; else why not) and when
 * its bound passes. Past its bound the sign client may still finish it, and its cleanup then runs on the provider — a session taken up
 * meanwhile gone from it, a pairing made meanwhile expired (the twelfth review round, the critique of 12d3c): no second disconnect is
 * started beside it, and nothing pairs until it settles — which it may never do: its unsubscribe has no bound in the library, and an answer
 * lost with a socket that dropped is never resent (the critique's next round, YO).
 */
let disconnecting: { outcome: Promise<string | null>; until: number } | null = null;
function disconnectOf(p: WcProvider): { outcome: Promise<string | null>; until: number } {
  if (disconnecting) return disconnecting;
  const d = {
    // a delete that fails with the session gone from the provider all the same — the wallet app's own end ran its cleanup meanwhile — is one
    outcome: p.disconnect().then(
      () => null,
      (e: unknown) => (p.session ? messageOf(e) : null),
    ),
    until: Date.now() + walletConnectEndTiming.boundMs,
  };
  disconnecting = d;
  void d.outcome.then(() => {
    disconnecting = null;
  });
  return d;
}
/** Why `p`'s session is still there once its disconnect settled or its bound passed — null: gone. */
async function whyLeft(p: WcProvider): Promise<string | null> {
  const d = disconnectOf(p);
  const outcome = await within(d.outcome, d.until - Date.now());
  return outcome === undefined ? UNFINISHED : outcome;
}
export function endWalletConnect(): Promise<void> {
  // one end at a time: a Disconnect's and a Forget's awaiting the same (the round's second critique: the Forget awaits it)
  if (ending) return ending;
  ending = (async () => {
    // an init under way is waited for, and the session the provider it makes takes up is ended too: never left with nothing here to end it
    const p = cached ?? (initing ? await initing.catch(() => null) : null);
    // a delete that failed (offline, its publish expired) leaves the session on the provider, deleted again at the next tap before it pairs
    // (or by a later end); one still under way past the bound is never doubled: every tap is refused (WalletConnectEndUnfinished) until it
    // settles — never, when its answer was lost —, then the next tap pairs, sending nothing (B12-3; stated in audit gap 112, with what the
    // library does meanwhile) — its keys cleared all the same either way
    if (p) leftover = await whyLeft(p);
    // its keys through its own storage, on the connection it holds (A11-3, H11-4): a deletion of the database from this page is blocked by
    // that connection; the database itself goes at a later page start
    await clearThroughStore(storeOf(p));
    await clearWalletConnectStorage();
  })().finally(() => {
    ending = null;
  });
  return ending;
}
/**
 * The session an earlier end left on `p`, deleted again once that end's own delete has settled — within its bound, else still left (none
 * left — the wallet app's own end ran the provider's cleanup, or that delete completed late — is deleted too: its disconnect then has nothing
 * to send). Its keys are cleared whatever the outcome, as an end clears them — what the library wrote at the delete, and what the session's
 * sign client wrote back meanwhile (a ping's history, the account with it), among them: a Forget's end that meets a delete again under way
 * waits for it, and had left them (the critique of 12d3c, YP). Nothing of the tap's is pending yet.
 */
function deleteAgain(p: WcProvider): Promise<void> {
  return (async () => {
    leftover = await whyLeft(p);
    await clearThroughStore(storeOf(p));
  })().finally(() => {
    ending = null;
  });
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
 * A session approved after its connection was cancelled (the eleventh review round, slice 6c): ended as a Disconnect ends it, on the page's
 * one provider (12d3c: no provider is forgotten any more, so no late approval lands on one). Any other provider — none in the app — has its
 * session ended at its relay and nothing else.
 */
export function endWalletConnectOf(p: WcProvider): Promise<void> {
  return p === cached ? endWalletConnect() : within(p.disconnect(), walletConnectEndTiming.boundMs).then(() => undefined);
}

/** Tests: a new page — no provider, no init, end or disconnect under way, no session left (and the library not loaded). */
export function resetWalletConnect(): void { cached = null; initing = null; ending = null; leftover = null; disconnecting = null; loadedHere = false; }
/** Tests: the library as loaded in this page. */
export function markWalletConnectLoaded(): void { loadedHere = true; }
