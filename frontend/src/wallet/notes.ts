// Session note store: the notes THIS wallet created (shields, change, refund notes) with the leaf
// index the chain assigned to each. In memory only — nothing is persisted to dapp-origin storage
// (TC-01). Recovery from chain (decrypting payloads with the view key) needs the envelope cipher,
// which is still an open decision (docs/roadmap.md), so until then the wallet is the record.
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

type Listener = () => void;

class NoteStore {
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
  /** Next noteSecret counter for a note of ours (spec §5.5: never reused). */
  allocateCounter(): number {
    return this.counter++;
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
