// The timing facts of a swap's funding (spec v2.0 §14.1): the youngest note the private withdrawal would spend — the
// same selection the withdrawal makes (`selectInputs`) — with its age (from when this wallet created it; unknown for a
// note a scan found) and the deposits since its leaf (from the pool's last sync). A funding that needs a merge first
// spends a note made just then. Pure over the note store and the pool stats; nothing is read from the network.
import { selectInputs } from "@privacy-wallet/protocol/wallet/amounts";
import { noteStore } from "./notes";
import { poolStats } from "./poolStats";

export interface FundingTiming {
  /** seconds since the youngest spent note was created; null when a scan found it */
  ageSeconds: number | null;
  /** notes inserted after its leaf; null before the pool's first sync */
  depositsSince: number | null;
}

export function fundingTiming(vaultId: bigint, amount: bigint, now = Date.now()): FundingTiming {
  const notes = noteStore.unspent(vaultId);
  if (!notes.length || amount <= 0n) return { ageSeconds: null, depositsSince: null };
  let spent = notes;
  try {
    const sel = selectInputs(
      notes.map((n) => ({ id: String(n.leafIndex), amount: n.note.amount })),
      amount,
    );
    if (sel.merges.length) return { ageSeconds: 0, depositsSince: 0 }; // a merge first: the funding spends a note made just now
    const ids = new Set(sel.inputs.map((i) => i.id));
    spent = notes.filter((n) => ids.has(String(n.leafIndex)));
  } catch {
    // not enough for this amount: the screen says so; the timing reads the notes there are
  }
  const youngest = spent.reduce((a, b) => (b.leafIndex > a.leafIndex ? b : a));
  const leaves = poolStats.get()?.leaves ?? null;
  return {
    ageSeconds: youngest.addedAt !== undefined ? Math.max(0, Math.floor((now - youngest.addedAt) / 1000)) : null,
    depositsSince: leaves !== null ? Math.max(0, leaves - youngest.leafIndex - 1) : null,
  };
}
