// Route handles (the audit round of 2026-10-16, c41). A private operation's record id can carry an on-chain identifier — a
// swap's order id, a transaction hash — and an id in the URL path stays in the browser's history and goes wherever the
// browser sends URLs (history sync, suggestions, extensions), where it links this browser to that order or transaction
// on chain. The routes name such a record by a handle instead: "r" and 16 bytes of HMAC-SHA256 over the id, under a key
// derived from the wallet's seed. A handle says nothing of the id, is the same after a reload (and on a device restored
// from the phrase), and differs between wallets. Nothing is stored: a handle is resolved against the records the journal
// holds, and the key is forgotten at the lock.
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { allOperations } from "../operations/store";
import { swapRecordId } from "../operations/swapRecords";
import { session as defaultSession, type WalletSession } from "./session";

const LABEL = utf8ToBytes("privacy-wallet/v6/route-handle");
const HANDLE = /^r[0-9a-f]{32}$/;
let memo: { seed: Uint8Array; key: Uint8Array; byId: Map<string, string> } | null = null;
defaultSession.onLock(() => {
  memo = null;
});

function keyed(seed: Uint8Array): NonNullable<typeof memo> {
  if (!memo || memo.seed !== seed) memo = { seed, key: hmac(sha256, seed, LABEL), byId: new Map() };
  return memo;
}

/** The handle a route names this record by; the id itself while the wallet is locked (a locked wallet shows no record). */
export function routeHandle(id: string, s: WalletSession = defaultSession): string {
  const seed = s.state().seed;
  if (!seed) return id;
  const m = keyed(seed);
  let h = m.byId.get(id);
  if (!h) {
    h = "r" + bytesToHex(hmac(sha256, m.key, utf8ToBytes(id)).slice(0, 16));
    m.byId.set(id, h);
  }
  return h;
}

/** The record a route's parameter names: a handle is looked up among the journal's records; anything else is taken as an id. */
export function idOfRoute(param: string, s: WalletSession = defaultSession): string {
  if (!HANDLE.test(param) || !s.isUnlocked()) return param;
  const j = s.journal();
  const ids = new Set<string>([...allOperations(s).map((r) => r.id), ...(j.activity ?? []).map((a) => a.id), ...j.swaps.map((x) => swapRecordId(x.orderId))]);
  for (const id of ids) if (routeHandle(id, s) === param) return id;
  return param;
}
