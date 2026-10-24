// @vitest-environment happy-dom
// More → Advanced's relayer in a production build (audit round 2, n79): the build's transport and its content security policy
// reach only the relayers it names, so the field offers those; a development build keeps the free URL.
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { applyConfig, testConfig } from "../src/config";
import { Advanced } from "../src/features/more/Advanced";
import { settings } from "@privacy-wallet/sdk/wallet/settings";

const RELAYERS = { url: "https://relay-1.example", fallbacks: ["https://relay-1.example", "https://relay-2.example"] };

afterEach(() => {
  applyConfig(testConfig());
  settings.reset();
});

describe("the relayer under Advanced", () => {
  it("a production build offers the relayers it names, and marks a saved one it cannot reach", () => {
    applyConfig(testConfig({ production: true, relayer: RELAYERS }));
    settings.set({ advanced: true, submission: { kind: "relayer", url: "https://elsewhere.example" } });
    render(<Advanced deployment={null} />);
    const field = screen.getByTestId("relayer-url");
    expect(field.tagName).toBe("SELECT");
    const options = [...field.querySelectorAll("option")];
    expect(options.filter((o) => !o.disabled).map((o) => o.value)).toEqual(["https://relay-1.example", "https://relay-2.example"]);
    expect(options.find((o) => o.disabled)?.textContent).toBe("https://elsewhere.example — not reachable from this build");
  });

  it("a development build keeps the free URL", () => {
    applyConfig(testConfig({ relayer: RELAYERS }));
    settings.set({ advanced: true, submission: { kind: "relayer", url: "http://127.0.0.1:9999" } });
    render(<Advanced deployment={null} />);
    expect(screen.getByTestId("relayer-url").tagName).toBe("INPUT");
  });
});
