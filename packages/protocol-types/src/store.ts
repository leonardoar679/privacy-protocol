// A store the engine exposes to any UI (V6 Stage 3): a change feed and a snapshot that stays the same object between
// changes (React's useSyncExternalStore, a React Native hook, a test).

export interface Store<T> {
  subscribe(listener: () => void): () => void;
  get(): T;
}
