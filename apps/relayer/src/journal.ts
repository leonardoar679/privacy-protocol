// Durable journals for the relayer's jobs. A funded escrow with a signed execution must survive a
// restart (otherwise it sits until refundAfter), and the submission journal is what frees a fee note
// for the relayer's own wallet. JSON files written atomically (temp + rename); nothing secret beyond
// the relayer's own fee-note openings, which its wallet seed can also rediscover from chain.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Journal<T> {
  load(): T[];
  save(items: T[]): void;
}

export class MemoryJournal<T> implements Journal<T> {
  private items: T[] = [];
  load(): T[] { return this.items.map((x) => ({ ...x })); }
  save(items: T[]): void { this.items = items.map((x) => ({ ...x })); }
}

export class FileJournal<T> implements Journal<T> {
  constructor(readonly path: string) {}
  load(): T[] {
    if (!existsSync(this.path)) return [];
    try { return JSON.parse(readFileSync(this.path, "utf8")) as T[]; } catch { return []; }
  }
  save(items: T[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(items, null, 2) + "\n");
    renameSync(tmp, this.path);
  }
}
