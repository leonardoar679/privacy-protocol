// The component preview ships in the dev server and the screenshot fixtures only (audit round 2, n78): a build in another
// mode than "production" — staging, say — has PROD true and had kept /__preview and its chunk.
import { describe, expect, it } from "vitest";
import config, { previewIncluded } from "../vite.config";

describe("the component preview's builds", () => {
  it("the dev server and the fixtures have it; every other build, whatever its mode, has not", () => {
    expect(previewIncluded("serve", "development")).toBe(true);
    expect(previewIncluded("serve", "fixtures")).toBe(true);
    expect(previewIncluded("build", "fixtures")).toBe(true);
    for (const mode of ["production", "staging", "development"]) expect(previewIncluded("build", mode), mode).toBe(false);
  });

  it("the build constant follows it", async () => {
    const at = async (command: "build" | "serve", mode: string) => {
      const c = await (config as unknown as (e: { command: string; mode: string }) => { define: Record<string, string> })({ command, mode });
      return c.define.__PREVIEW__;
    };
    expect(await at("build", "staging")).toBe("false");
    expect(await at("serve", "development")).toBe("true");
  });
});
