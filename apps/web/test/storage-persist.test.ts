// @vitest-environment happy-dom
// Persistent storage (V7 Stage 16, spec v3.0 §9): asked of the browser once per page, the answer remembered; an origin
// already persistent is not asked again; a refusal is "best effort"; a browser without the API, or a failing call, is
// "unsupported" — and none of these throws.
import { afterEach, describe, expect, it, vi } from "vitest";
import { askPersistentStorage, persistentStorageState, resetPersistentStorage } from "../src/storage/persist";

const withStorage = (api: unknown) => Object.defineProperty(navigator, "storage", { value: api, configurable: true });
afterEach(() => {
  resetPersistentStorage();
  withStorage(undefined);
});

describe("persistent storage", () => {
  it("asks once and remembers the grant", async () => {
    const persist = vi.fn(async () => true);
    withStorage({ persist, persisted: async () => false });
    expect(persistentStorageState()).toBe("unknown");
    expect(await askPersistentStorage()).toBe(true);
    expect(await askPersistentStorage()).toBe(true);
    expect(persist, "once per page").toHaveBeenCalledTimes(1);
    expect(persistentStorageState()).toBe("persistent");
  });

  it("an origin already persistent is not asked again; a refusal is best effort", async () => {
    const persist = vi.fn(async () => true);
    withStorage({ persist, persisted: async () => true });
    expect(await askPersistentStorage()).toBe(true);
    expect(persist).not.toHaveBeenCalled();
    resetPersistentStorage();
    withStorage({ persist: async () => false, persisted: async () => false });
    expect(await askPersistentStorage()).toBe(false);
    expect(persistentStorageState()).toBe("best-effort");
  });

  it("no such API, or a failing call: unsupported, never a throw", async () => {
    withStorage(undefined);
    expect(await askPersistentStorage()).toBeNull();
    expect(persistentStorageState()).toBe("unsupported");
    resetPersistentStorage();
    withStorage({
      persist: async () => {
        throw new Error("blocked");
      },
    });
    expect(await askPersistentStorage()).toBeNull();
    expect(persistentStorageState()).toBe("unsupported");
  });
});
