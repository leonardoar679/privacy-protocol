// @vitest-environment happy-dom
// The Classic fixtures (src/fixtures/registry.tsx): every one renders, with a unique id, the Not connected banner, no
// promise word and no full address; the sentinel that proves a build carries no fixture lives in the fixtures entry
// alone; the Korean fixtures read Korean.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { applyConfig, configFromEnv } from "../src/config";
import { FIXTURES } from "../src/fixtures/registry";
import { setLocale } from "../src/app/i18n/messages";
import { scan } from "../scripts/words.mjs";

afterEach(() => {
  cleanup();
  setLocale("en");
});

const files = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) files(p, out);
    else out.push(p);
  }
  return out;
};

describe("the Classic fixtures", () => {
  it("has unique ids, every one prefixed classic-", () => {
    const ids = FIXTURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith("classic-"))).toBe(true);
    expect(ids.length).toBeGreaterThanOrEqual(20);
  });

  it("every fixture renders with the banner, says no promise word and shows no full address", () => {
    applyConfig(configFromEnv({}));
    for (const f of FIXTURES) {
      const { unmount } = render(<>{f.render()}</>);
      const text = document.body.textContent ?? "";
      expect(screen.getByTestId("classic-not-connected"), f.id).toBeInTheDocument();
      expect(scan(text), f.id).toEqual([]);
      expect(text, f.id).not.toMatch(/\b0x[0-9a-fA-F]{40}\b/);
      if (f.locale === "ko") expect(text, f.id).toContain("연결되지 않음");
      else expect(text, f.id).toContain("Not connected");
      if (f.dialog) expect(screen.getByRole("dialog"), f.id).toBeInTheDocument();
      unmount();
    }
  });

  it("the fixture sentinel lives in src/fixtures/main.tsx alone", () => {
    const src = join(__dirname, "..", "src");
    const carriers = files(src)
      .filter((p) => readFileSync(p, "utf8").includes("tc-fixture-sentinel"))
      .map((p) => p.replace(/\\/g, "/").split("/src/")[1]);
    expect(carriers).toEqual(["fixtures/main.tsx"]);
  });
});
