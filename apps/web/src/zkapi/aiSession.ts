// The private inference session the user opened under Private AI (plan V2 §77): held here so the Review
// screen's "Check this trade" can use it. The access carries a short-lived provider key and nothing of
// the wallet; it is released when the user ends the session. Nothing here signs or submits.
import { useSyncExternalStore } from "react";
import type { InferenceAccess } from "./policy";

export interface AiSession { access: InferenceAccess | null; model: string }

class AiSessionStore {
  private st: AiSession = { access: null, model: "" };
  private listeners = new Set<() => void>();
  get(): AiSession { return this.st; }
  set(access: InferenceAccess | null, model = this.st.model): void { this.st = { access, model }; for (const l of this.listeners) l(); }
  subscribe(l: () => void): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
}

export const aiSession = new AiSessionStore();

/**
 * The open session released and dropped — at a lock (PrivateAI.tsx registers it) and a Forget — so the provider key retires and nothing
 * of it serves the next session or wallet (the eighth review round, 2026-11-03, C-M2: a lock or a REPLACE had kept it for the Review's
 * "Check this trade", one Bearer key across two sessions, and the remounted screen could no longer end it).
 */
export function endAiSession(): void {
  const a = aiSession.get().access;
  try {
    a?.release();
  } catch {
    // released already
  }
  if (a) aiSession.set(null);
}
export const useAiSession = (): AiSession => useSyncExternalStore((l) => aiSession.subscribe(l), () => aiSession.get());
