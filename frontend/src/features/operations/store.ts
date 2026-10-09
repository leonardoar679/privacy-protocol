// The operation store (spec §12): drafts (DRAFT … REVIEW) in memory, every record from AWAITING_SIGNATURE on in the
// encrypted journal under `operations` — it survives a lock, a reload and a backup like the Activity list. The hooks
// read through useSyncExternalStore with a stable snapshot per change.
import { useSyncExternalStore } from "react";
import type { JournalData } from "../../wallet/journal";
import { isDraft, isOpen, isTerminal, type OperationKind, type OperationRecord, type OperationState } from "../../wallet/operationRecord";
import { session as defaultSession, type WalletSession } from "../../wallet/session";
import { transition } from "./reducer";
import type { OperationEvent, TransitionResult } from "./types";
import type { Tier } from "@ref/wallet/valuation";

export const operationsOf = (j: JournalData): OperationRecord[] => j.operations ?? [];

const drafts = new Map<string, OperationRecord>();
const listeners = new Set<() => void>();
let version = 0;
let attached: WalletSession | null = null;
const bump = (): void => { version++; for (const l of listeners) l(); };
function attach(s: WalletSession): void {
  if (attached === s) return;
  attached = s;
  s.subscribe(bump);
}

let counter = 0;
export const newOperationId = (kind: OperationKind, now = Date.now()): string => `${kind}:${now.toString(36)}:${(++counter).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export interface NewOperation {
  kind: OperationKind;
  amounts: OperationRecord["amounts"];
  destination: OperationRecord["destination"];
  tier: Tier;
  fees?: OperationRecord["fees"];
  refs?: Partial<OperationRecord["refs"]>;
  id?: string;
  state?: OperationState;
}

/** A record in DRAFT (in memory). */
export function newOperation(i: NewOperation, now = Date.now()): OperationRecord {
  const state = i.state ?? "DRAFT";
  const rec: OperationRecord = {
    id: i.id ?? newOperationId(i.kind, now), kind: i.kind, state, createdAt: now, updatedAt: now,
    amounts: i.amounts, fees: i.fees ?? [], destination: i.destination, refs: { txHashes: [], ...(i.refs ?? {}) }, tier: i.tier, history: [{ state, at: now }],
  };
  drafts.set(rec.id, rec);
  bump();
  return rec;
}

export function getOperation(id: string, s: WalletSession = defaultSession): OperationRecord | null {
  const d = drafts.get(id);
  if (d) return d;
  if (!s.isUnlocked()) return null;
  return operationsOf(s.journal()).find((r) => r.id === id) ?? null;
}

/** Write a record where it belongs: a draft state in memory, anything else in the journal (when unlocked). */
export function putOperation(rec: OperationRecord, s: WalletSession = defaultSession): void {
  if (isDraft(rec.state)) { drafts.set(rec.id, rec); bump(); return; }
  if (s.isUnlocked()) {
    attach(s);
    s.update((j) => {
      const list = j.operations ?? [];
      const i = list.findIndex((r) => r.id === rec.id);
      j.operations = i >= 0 ? list.map((r, k) => (k === i ? rec : r)) : [...list, rec];
    });
    drafts.delete(rec.id);
  } else drafts.set(rec.id, rec); // a locked wallet keeps it in memory until the next write (the Gate locks the screens anyway)
  bump();
}

/** Apply an event to a record and store the result; the refusal (if any) is returned, the record untouched. */
export function applyEvent(id: string, ev: OperationEvent, s: WalletSession = defaultSession, now = Date.now()): TransitionResult | null {
  const rec = getOperation(id, s);
  if (!rec) return null;
  const t = transition(rec, ev, now);
  if (t.ok && t.changed) putOperation(t.record, s);
  return t;
}

export function removeOperation(id: string, s: WalletSession = defaultSession): void {
  drafts.delete(id);
  if (s.isUnlocked() && operationsOf(s.journal()).some((r) => r.id === id)) s.update((j) => { j.operations = (j.operations ?? []).filter((r) => r.id !== id); });
  bump();
}

export function allOperations(s: WalletSession = defaultSession): OperationRecord[] {
  const journaled = s.isUnlocked() ? operationsOf(s.journal()) : [];
  return [...journaled, ...[...drafts.values()].filter((d) => !journaled.some((r) => r.id === d.id))].sort((a, b) => b.updatedAt - a.updatedAt);
}
/** Signed and not yet terminal: what the Home's running line, the Activity's open group and the recovery tracking follow. */
export const openOperations = (s: WalletSession = defaultSession): OperationRecord[] => allOperations(s).filter((r) => isOpen(r.state));
export const finishedOperations = (s: WalletSession = defaultSession): OperationRecord[] => allOperations(s).filter((r) => isTerminal(r.state));

/** Tests: forget the drafts and the hook's cache. */
export function resetOperationsMemory(): void { drafts.clear(); bump(); }

function subscribe(l: () => void, s: WalletSession): () => void {
  attach(s);
  listeners.add(l);
  return () => { listeners.delete(l); };
}
let cache: { v: number; s: WalletSession; open: OperationRecord[]; all: OperationRecord[] } | null = null;
function snapshot(s: WalletSession): { open: OperationRecord[]; all: OperationRecord[] } {
  if (!cache || cache.v !== version || cache.s !== s) { const all = allOperations(s); cache = { v: version, s, all, open: all.filter((r) => isOpen(r.state)) }; }
  return cache;
}

export const useOperation = (id: string | null | undefined, s: WalletSession = defaultSession): OperationRecord | null =>
  useSyncExternalStore((l) => subscribe(l, s), () => (id ? (snapshot(s).all.find((r) => r.id === id) ?? null) : null));
export const useOpenOperations = (s: WalletSession = defaultSession): OperationRecord[] => useSyncExternalStore((l) => subscribe(l, s), () => snapshot(s).open);
export const useAllOperations = (s: WalletSession = defaultSession): OperationRecord[] => useSyncExternalStore((l) => subscribe(l, s), () => snapshot(s).all);
