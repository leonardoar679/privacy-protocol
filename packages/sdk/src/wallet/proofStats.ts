// This device's proving time (spec v2.0 §14.3; V6 Stage 15): the platform's prover records each proof's timings in the
// encrypted journal (`proofStats`, optional), and the progress and the swap's time estimate read the next proof's
// expected duration from them — a constant only until the device has proven once.
import type { ProofStats } from "./journal";
import { session as defaultSession, type WalletSession } from "./session";

/** Before the device's first proof: the key's download and a mid-range desktop's proving. */
export const DEFAULT_PROOF_MS = 8_000;

export function recordProof(stats: Omit<ProofStats, "at">, s: WalletSession = defaultSession, now = Date.now()): void {
  if (!s.isUnlocked()) return;
  s.update((j) => {
    j.proofStats = { keyMs: Math.round(stats.keyMs), proveMs: Math.round(stats.proveMs), keyCached: stats.keyCached, at: now };
  });
}

/** The next proof's expected duration in ms: the last one's proving, plus the key's fetch unless the key was cached. */
export function proofEstimateMs(s: WalletSession = defaultSession): number {
  const p = s.isUnlocked() ? s.journal().proofStats : undefined;
  if (!p) return DEFAULT_PROOF_MS;
  return p.proveMs + (p.keyCached ? 0 : p.keyMs);
}
