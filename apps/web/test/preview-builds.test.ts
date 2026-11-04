// The component preview ships in the dev server and the screenshot fixtures only (audit round 2, n78): a build in another
// mode than "production" — staging, say — has PROD true and had kept /__preview and its chunk.
import { describe, expect, it } from "vitest";
import config, { assertProductionNodeEnv, previewIncluded } from "../vite.config";

describe("the component preview's builds", () => {
  it("the dev server and the fixtures have it; every other build, whatever its mode, has not", () => {
    expect(previewIncluded("serve", "development")).toBe(true);
    expect(previewIncluded("serve", "fixtures")).toBe(true);
    expect(previewIncluded("build", "fixtures")).toBe(true);
    for (const mode of ["production", "staging", "development"]) expect(previewIncluded("build", mode), mode).toBe(false);
  });

  it("the build constant follows it", async () => {
    const at = async (command: "build" | "serve", mode: string) => {
      // a build runs with NODE_ENV=production (the tenth review round, D-8); vitest's is "test"
      const env = process.env.NODE_ENV;
      if (command === "build") process.env.NODE_ENV = "production";
      try {
        const c = await (config as unknown as (e: { command: string; mode: string }) => { define: Record<string, string> })({ command, mode });
        return c.define.__PREVIEW__;
      } finally {
        process.env.NODE_ENV = env;
      }
    };
    expect(await at("build", "staging")).toBe("false");
    expect(await at("serve", "development")).toBe("true");
  });
});

describe("a build's NODE_ENV (the tenth review round, D-8)", () => {
  it("a build of the wallet needs NODE_ENV=production — every production floor keys on import.meta.env.PROD, which Vite takes from it", () => {
    expect(() => assertProductionNodeEnv("build", "production", "development")).toThrow(/needs NODE_ENV=production \(it is development\)/);
    expect(() => assertProductionNodeEnv("build", "staging", "test")).toThrow(/it is test/);
    expect(() => assertProductionNodeEnv("build", "production", "production")).not.toThrow();
    // the screenshot fixtures and the dev server are no release
    expect(() => assertProductionNodeEnv("build", "fixtures", "development")).not.toThrow();
    expect(() => assertProductionNodeEnv("serve", "development", "development")).not.toThrow();
  });
});
