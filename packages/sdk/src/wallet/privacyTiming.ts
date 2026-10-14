// The timing facts of a swap's funding (spec v2.0 §14.1): the youngest note the private withdrawal would spend — the
// same selection the withdrawal makes (`selectInputs`) — with its age (from when this wallet created it; unknown for a
// note a scan found) and the deposits since its leaf (from the pool's last sync). A funding that needs a merge first
// spends a note made just then. "Delay for more privacy" funds from older notes first (`olderFunding`): only the notes
// whose own timing is at most a bound, the best bound whose notes cover the amount; the withdrawal is held to that bound
// (`olderNotes`). Pure over the note store and the pool stats; nothing is read from the network.
import { selectInputs } from "@privacy-wallet/protocol/wallet/amounts";
import { timingOfFunding } from "@privacy-wallet/protocol/wallet/privacyAssessment";
import { noteStore, type OwnedNote } from "./notes";
import { poolStats } from "./poolStats";

export interface FundingTiming {
  /** seconds since the youngest spent note was created; null when a scan found it */
  ageSeconds: number | null;
  /** notes inserted after its leaf; null before the pool's first sync */
  depositsSince: number | null;
}

/** One note's own timing facts. */
function timingOf(n: OwnedNote, leaves: number | null, now: number): FundingTiming {
  return {
    ageSeconds: n.addedAt !== undefined ? Math.max(0, Math.floor((now - n.addedAt) / 1000)) : null,
    depositsSince: leaves !== null ? Math.max(0, leaves - n.leafIndex - 1) : null,
  };
}

const youngestOf = (notes: OwnedNote[]): OwnedNote => notes.reduce((a, b) => (b.leafIndex > a.leafIndex ? b : a));

/** The notes the withdrawal's own selection spends from `notes` for `needed`; "merge" when it needs a merge first, "short" when they do not cover it. */
export function selectionOf(notes: OwnedNote[], needed: bigint): OwnedNote[] | "merge" | "short" {
  let sel: ReturnType<typeof selectInputs>;
  try {
    sel = selectInputs(
      notes.map((n) => ({ id: String(n.leafIndex), amount: n.note.amount })),
      needed,
    );
  } catch {
    return "short";
  }
  if (sel.merges.length) return "merge";
  const ids = new Set(sel.inputs.map((i) => i.id));
  return notes.filter((n) => ids.has(String(n.leafIndex)));
}

export function fundingTiming(vaultId: bigint, amount: bigint, now = Date.now()): FundingTiming {
  const notes = noteStore.unspent(vaultId);
  if (!notes.length || amount <= 0n) return { ageSeconds: null, depositsSince: null };
  const sel = selectionOf(notes, amount);
  if (sel === "merge") return { ageSeconds: 0, depositsSince: 0 }; // a merge first: the funding spends a note made just now
  // not enough for this amount: the screen says so; the timing reads the notes there are
  return timingOf(youngestOf(sel === "short" ? notes : sel), poolStats.get()?.leaves ?? null, now);
}

/** "Delay for more privacy": the bounds tried, best first — every note the funding spends has its own timing at most the bound. */
export const OLDER_NOTE_BOUNDS = [0, 0.3, 0.7];

/** The unspent notes of a vault whose own timing (their age and the deposits since their leaf, `timingOfFunding`) is at most `maxTiming`. */
export function olderNotes(vaultId: bigint, maxTiming: number, now = Date.now()): OwnedNote[] {
  const leaves = poolStats.get()?.leaves ?? null;
  return noteStore.unspent(vaultId).filter((n) => timingOfFunding(timingOf(n, leaves, now)) <= maxTiming);
}

export interface OlderFunding {
  /** every note the funding spends has its own timing at most this: the order runner holds the withdrawal to it */
  maxTiming: number;
  /** the youngest of the notes it spends: the facts the assessment shows */
  timing: FundingTiming;
}

/**
 * "Delay for more privacy", first choice (spec v2.0 §14.1): fund at once from notes older than the ones the default
 * selection spends. The bounds are tried best first; the first whose notes cover the amount without a merge wins, and only
 * when it times better than the default selection. Null: no older notes cover it — the funding waits a random 1–24 h.
 */
export function olderFunding(vaultId: bigint, amount: bigint, now = Date.now()): OlderFunding | null {
  if (amount <= 0n) return null;
  const current = timingOfFunding(fundingTiming(vaultId, amount, now));
  const leaves = poolStats.get()?.leaves ?? null;
  for (const maxTiming of OLDER_NOTE_BOUNDS) {
    if (maxTiming >= current) return null;
    const sel = selectionOf(olderNotes(vaultId, maxTiming, now), amount);
    if (Array.isArray(sel)) return { maxTiming, timing: timingOf(youngestOf(sel), leaves, now) };
  }
  return null;
}
