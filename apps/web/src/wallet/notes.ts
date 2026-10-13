// The wallet's notes: those this wallet created (shields, change, merged and refund notes) and those
// discovered on chain (payloads encrypted to the view key, spec §12), each with the leaf index the
// chain assigned. Held in memory while the wallet is unlocked and persisted through the encrypted
// journal (wallet/journal.ts) — never in the clear (TC-01). A rescan of the chain rebuilds it.
import { useSyncExternalStore } from "react";
import type { Hex } from "viem";
import type { Note } from "@ref/note";

export interface OwnedNote {
  note: Note;
  leafIndex: number;
  noteData: Hex; // the payload that went on-chain with it
  counter?: number; // noteSecret derivation counter when it is one of ours
  spent: boolean;
  txHash?: Hex;
  label?: string;
}

/** JSON form of a note for the encrypted journal (bigints as decimal strings). */
export interface SerializedNote { vaultId: string; amount: string; ownerCommitment: string; noteSecret: string; leafIndex: number; noteData: Hex; counter?: number; spent: boolean; txHash?: Hex; label?: string }

type Listener = () => void;

export class NoteStore {
  private notes: OwnedNote[] = [];
  private snapshot: OwnedNote[] = [];
  private listeners = new Set<Listener>();
  private counter = 0;

  add(n: OwnedNote): void {
    this.notes.push(n);
    this.emit();
  }
  markSpent(leafIndexes: number[]): void {
    for (const n of this.notes) if (leafIndexes.includes(n.leafIndex)) n.spent = true;
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
  /** The counter allocateCounter() would hand out next (read-only). */
  nextCounter(): number {
    return this.counter;
  }
  /** Next noteSecret counter for a note of ours (spec §5.5: never reused). */
  allocateCounter(): number {
    const c = this.counter++;
    this.emit();
    return c;
  }
  /** A counter this wallet is known to have used (a rescan found a note derived from it): the next one is past it. */
  observeCounter(used: number): void {
    if (used + 1 <= this.counter) return;
    this.counter = used + 1;
    this.emit();
  }
  /** Everything the journal keeps. */
  serialize(): { notes: SerializedNote[]; noteCounter: number } {
    return {
      notes: this.notes.map((n) => ({ vaultId: n.note.vaultId.toString(), amount: n.note.amount.toString(), ownerCommitment: n.note.ownerCommitment.toString(), noteSecret: n.note.noteSecret.toString(), leafIndex: n.leafIndex, noteData: n.noteData, counter: n.counter, spent: n.spent, txHash: n.txHash, label: n.label })),
      noteCounter: this.counter,
    };
  }
  /** Replace the contents with a journal's (on unlock). The counter never goes backwards. */
  load(data: { notes: SerializedNote[]; noteCounter: number }): void {
    this.notes = data.notes.map((s) => ({ note: { vaultId: BigInt(s.vaultId), amount: BigInt(s.amount), ownerCommitment: BigInt(s.ownerCommitment), noteSecret: BigInt(s.noteSecret) }, leafIndex: s.leafIndex, noteData: s.noteData, counter: s.counter, spent: s.spent, txHash: s.txHash, label: s.label }));
    this.counter = Math.max(this.counter, data.noteCounter, ...this.notes.map((n) => (n.counter ?? -1) + 1));
    this.emit();
  }
  /** Forget everything (on lock). */
  clear(): void {
    this.notes = [];
    this.counter = 0;
    this.emit();
  }
  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  private emit(): void {
    this.snapshot = this.notes.map((n) => ({ ...n }));
    for (const l of this.listeners) l();
  }
}

export const noteStore = new NoteStore();

/** React view of the store (re-renders on every change). */
export function useNotes(): OwnedNote[] {
  return useSyncExternalStore((l) => noteStore.subscribe(l), () => noteStore.all());
}
