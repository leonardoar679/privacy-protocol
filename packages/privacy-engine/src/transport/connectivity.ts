// Connectivity (spec v2.0 §7.11, §12.5; doc §75; V6 Stage 15). The wallet is offline when:
//   - the browser says so (its offline event); or
//   - three requests in a row never reached their host (a network error or a timeout; an HTTP answer of any status
//     counts as reached, and a caller's own abort is not a failure).
// Any answer from the network, or the browser's online event, ends it. While offline the money-moving steps pause (the
// scheduler, every Confirm); back online they resume only after the state is verified (the runners reconcile before
// every send).

export interface ConnectivityState {
  online: boolean;
  /** when the state last changed (ms since the epoch; 0 at start) */
  since: number;
  cause: "browser" | "unreachable" | null;
}

export const FAILURES_TO_OFFLINE = 3;

class Connectivity {
  private state: ConnectivityState = { online: true, since: 0, cause: null };
  private failures = 0;
  private browserOffline = false;
  private listeners = new Set<() => void>();

  get(): ConnectivityState {
    return this.state;
  }
  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }
  /** The browser's online / offline event (and navigator.onLine at start). */
  browser(online: boolean, now = Date.now()): void {
    this.browserOffline = !online;
    this.failures = 0;
    this.set(online, online ? null : "browser", now);
  }
  /** A request got an answer. */
  reachable(now = Date.now()): void {
    this.failures = 0;
    if (!this.browserOffline) this.set(true, null, now);
  }
  /** A request never reached its host. */
  unreachable(now = Date.now()): void {
    this.failures++;
    if (this.failures >= FAILURES_TO_OFFLINE && this.state.online) this.set(false, "unreachable", now);
  }
  /** Tests: back to online. */
  reset(): void {
    this.failures = 0;
    this.browserOffline = false;
    this.state = { online: true, since: 0, cause: null };
    for (const l of this.listeners) l();
  }
  private set(online: boolean, cause: ConnectivityState["cause"], now: number): void {
    if (this.state.online === online && this.state.cause === cause) return;
    this.state = { online, since: now, cause };
    for (const l of this.listeners) l();
  }
}

export const connectivity = new Connectivity();

/** Resolves once the wallet is online (at once when it is). */
export function whenOnline(): Promise<void> {
  if (connectivity.get().online) return Promise.resolve();
  return new Promise((resolve) => {
    const off = connectivity.subscribe(() => {
      if (!connectivity.get().online) return;
      off();
      resolve();
    });
  });
}

/** A failure that never reached the host: a network error or a timeout; a caller's own abort is not one. */
export function isNetworkFailure(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name;
  if (name === "AbortError") return false;
  return e instanceof TypeError || name === "TimeoutError" || name === "NetworkError";
}

/**
 * A request observed: its answer marks the network reachable, a network failure counts toward offline. `abortIsTimeout`: the
 * request's only abort is its transport's timeout — viem's RPC transport aborts its fetch without a reason, and a hung RPC
 * endpoint had never counted (2026-10-17, the audit's unverified m67).
 */
export async function observed<T>(request: Promise<T>, o: { abortIsTimeout?: boolean } = {}): Promise<T> {
  try {
    const r = await request;
    connectivity.reachable();
    return r;
  } catch (e) {
    if (isNetworkFailure(e) || (o.abortIsTimeout && (e as { name?: unknown } | null)?.name === "AbortError")) connectivity.unreachable();
    throw e;
  }
}
