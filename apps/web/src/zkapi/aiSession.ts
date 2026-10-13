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
export const useAiSession = (): AiSession => useSyncExternalStore((l) => aiSession.subscribe(l), () => aiSession.get());
