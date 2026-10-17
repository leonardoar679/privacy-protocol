// @vitest-environment jsdom
// The browser refused the wallet's storage (the audit's unverified m49, 2026-10-17): the shell and the create and restore
// screens say the wallet is kept in this tab only; a store that keeps its data, or one that was never IndexedDB, says
// nothing.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { configure } from "@privacy-wallet/sdk/config";
import { memoryStorage } from "@privacy-wallet/sdk/wallet/storage";
import { applyConfig, testConfig } from "../src/config";
import { StorageNotice, storageRefused } from "../src/app/StorageNotice";

const withStore = (extra: Record<string, unknown>) => {
  const store = Object.assign(memoryStorage(), extra);
  configure({ ...testConfig(), storage: () => store });
};

afterEach(() => {
  cleanup();
  applyConfig(testConfig());
});

describe("the storage notice", () => {
  it("shows when the store refused, and only then", () => {
    withStore({ backend: "memory", refused: true });
    expect(storageRefused()).toBe(true);
    render(<StorageNotice />);
    expect(screen.getByTestId("storage-memory-notice").textContent).toContain("kept in this tab only");
    cleanup();
    withStore({ backend: "indexeddb", refused: false });
    render(<StorageNotice />);
    expect(screen.queryByTestId("storage-memory-notice")).toBeNull();
    cleanup();
    withStore({});
    render(<StorageNotice />);
    expect(screen.queryByTestId("storage-memory-notice"), "a store that says nothing").toBeNull();
  });
});
