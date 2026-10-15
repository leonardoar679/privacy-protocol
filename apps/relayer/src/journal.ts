// Durable journals for the relayer's jobs. A funded escrow with a signed execution must survive a
// restart (otherwise it sits until refundAfter), and the submission journal is what frees a fee note
// for the relayer's own wallet. JSON files, each written whole to a temporary file, flushed, then renamed over the
// journal, so a crash leaves the old file or the new one; nothing secret beyond
// the relayer's own fee-note openings, which its wallet seed can also rediscover from chain.
// A V6 follow-up of 2026-10-15: a journal that cannot be read stops the relayer, naming the file, instead of being read
// as empty. Before, a damaged file (a power loss before the data reached the disk, a hand edit) loaded as no jobs at all,
// and the next save overwrote it: every funded escrow's execution and refund, every shield, every fee-note opening in
// it was forgotten without a word. The temporary file is now flushed to the disk before it replaces the journal.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

/** A journal file that exists and is not a list of jobs: the relayer does not start over it. */
export class JournalUnreadable extends Error {
  constructor(readonly path: string, why: string) {
    super(`${path} is not a readable journal (${why}). The relayer does not start over it, so that no job in it is forgotten: restore it, or move it aside to start without its jobs.`);
  }
}

export class FileJournal<T> implements Journal<T> {
  constructor(readonly path: string) {}
  load(): T[] {
    if (!existsSync(this.path)) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch (e) {
      throw new JournalUnreadable(this.path, String((e as Error).message).split("\n")[0].slice(0, 120));
    }
    if (!Array.isArray(parsed)) throw new JournalUnreadable(this.path, "not a list");
    return parsed as T[];
  }
  save(items: T[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    const fd = openSync(tmp, "w");
    try {
      writeFileSync(fd, JSON.stringify(items, null, 2) + "\n");
      fsyncSync(fd); // on the disk before it replaces the journal
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.path);
  }
}
