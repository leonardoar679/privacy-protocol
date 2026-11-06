// The Classic app's source gates (scripts/gates.mjs): the word policy sees each promise word and allows the original's
// labels; the declared-dependency check; the generated tokens match packages/ui; the pin check over a planted directory.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkDeps } from "../scripts/check-deps.mjs";
import { checkPins, PUBLIC_PIN_FILE } from "../scripts/check-pins.mjs";
import { checkTokens, generated } from "../scripts/tokens.mjs";
import { checkWords, scan } from "../scripts/words.mjs";

describe("the word policy (spec v3.0 §7.9)", () => {
  it("sees every promise word and allows the original's statistics labels", () => {
    expect(scan("fully anonymous and untraceable mixers, invisible, undetectable, impossible to trace, 100% private")).toEqual([
      "anonymous",
      "mixer",
      "untraceable",
      "undetectable",
      "invisible",
      "impossible to trace",
      "a 100 % claim",
    ]);
    expect(scan("Anonymity set · Subsequent deposits · Time passed · 100 ETH · 0.1 ETH")).toEqual([]);
  });
  it("a build switches a pool function on only when the legal review's record clears it — its block, and the table people read (the tenth review round, C10-15; the eleventh, C11-4, and its critique)", async () => {
    const { liveGateProblems } = await import("../scripts/live-gate.mjs");
    const SIGNED: Record<string, string> = {
      "Reviewer (name, qualification, jurisdiction)": "A. Reviewer, counsel",
      "Date concluded": "2026-12-01",
      Outcome: "Cleared, with the conditions below",
      "Pool functions cleared": "`eth-1:withdraw` `eth-10:withdraw`",
      "Owner's sign-off": "the owner, 2026-12-02",
    };
    const BLANK = Object.fromEntries(Object.keys(SIGNED).map((k) => [k, "—"]));
    const table = (cells: Record<string, string>) => ["| Field | Entry |", "|---|---|", ...Object.entries(cells).map(([k, v]) => `| ${k} | ${v} |`)].join("\n");
    const record = (outcome: string, cleared: string, cells: Record<string, string> = SIGNED) =>
      `${table(cells)}\n\n<!-- classic-live-gate\noutcome: ${outcome}\ncleared: ${cleared}\n-->\n`;
    const none = record("none", "", BLANK);
    expect(liveGateProblems(undefined, none)).toEqual([]);
    expect(liveGateProblems("{}", none)).toEqual([]);
    expect(liveGateProblems('{"eth-1":["withdraw"]}', none)).toEqual([
      'the classic-live-gate block in classic/docs/legal-review.md records the outcome "none": no pool function may be switched on',
      "VITE_CLASSIC_LIVE switches eth-1:withdraw on, which the classic-live-gate block in classic/docs/legal-review.md does not list as cleared",
    ]);
    const filled = record("cleared", "eth-1:withdraw eth-10:withdraw");
    expect(liveGateProblems('{"eth-1":["withdraw"],"eth-10":["withdraw"]}', filled)).toEqual([]);
    expect(liveGateProblems('{"eth-1":["deposit","withdraw"]}', filled)).toEqual([
      "VITE_CLASSIC_LIVE switches eth-1:deposit on, which the classic-live-gate block in classic/docs/legal-review.md does not list as cleared",
    ]);
    // what the table's loose reading had let through (C11-4): any outcome but "—", a token anywhere in the row, the table alone, two records
    expect(liveGateProblems('{"eth-1":["withdraw"]}', record("not cleared", "eth-1:withdraw"))).toEqual([
      "the classic-live-gate record's outcome is not one of none, cleared, refused",
    ]);
    expect(liveGateProblems('{"eth-1":["withdraw"]}', record("refused", "eth-1:withdraw"))[0]).toMatch(/outcome "refused"/);
    expect(liveGateProblems('{"eth-1":["withdraw"]}', record("cleared", "eth-1:withdraw,eth-10:withdraw"))).toEqual([
      "the classic-live-gate record clears eth-1:withdraw,eth-10:withdraw, which is no pool:function pair",
    ]);
    expect(liveGateProblems('{"eth-1":["withdraw"]}', record("cleared", "eth-1:withdraw:x"))[0]).toMatch(/no pool:function pair/);
    expect(liveGateProblems('{"eth-1":["withdraw"]}', table(SIGNED))).toEqual([
      "classic/docs/legal-review.md must hold exactly one classic-live-gate record (it holds 0)",
    ]);
    expect(liveGateProblems('{"eth-1":["withdraw"]}', filled + filled)[0]).toMatch(/it holds 2/);
    expect(liveGateProblems('{"eth-1":["withdraw"]}', record("cleared", "eth-1:withdraw").replace("cleared: eth-1:withdraw", ""))[0]).toMatch(
      /names no cleared line/,
    );
    // the block sits in an HTML comment the rendered page does not show (the critique of C11-4): a block that clears what the table does not say
    // is refused — a table of "—", another outcome, other pool functions
    expect(liveGateProblems('{"eth-1":["withdraw"]}', record("cleared", "eth-1:withdraw", BLANK))).toEqual(
      Object.keys(SIGNED).map((f) => `the record's table leaves "${f}" unfilled, while the classic-live-gate block clears pool functions`),
    );
    expect(
      liveGateProblems(
        '{"eth-1":["withdraw"]}',
        record("cleared", "eth-1:withdraw", { ...SIGNED, Outcome: "Refused", "Pool functions cleared": "eth-1:withdraw" }),
      ),
    ).toEqual(['the record\'s table gives the outcome "Refused", while the classic-live-gate block gives "cleared"']);
    expect(liveGateProblems('{"eth-1":["withdraw"]}', record("cleared", "eth-1:withdraw"))).toEqual([
      "the record's table and the classic-live-gate block do not list the same pool functions as cleared",
    ]);
    // the committed record clears nothing today
    const { readFileSync } = await import("node:fs");
    const committed = readFileSync(new URL("../docs/legal-review.md", import.meta.url), "utf8");
    expect(liveGateProblems('{"eth-100":["withdraw"]}', committed).length).toBeGreaterThan(0);
  });

  it("every build is held to NODE_ENV=production and to the legal record, whatever its mode (the eleventh review round, C11-4, F11-3, and its critique)", async () => {
    // through a specifier tsc does not follow: the build config stays outside the typed program, as before
    const configModule = "../vite.config";
    const { default: config } = (await import(/* @vite-ignore */ configModule)) as { default: unknown };
    const make = config as (e: { mode: string; command: string }) => unknown;
    const saved = { NODE_ENV: process.env.NODE_ENV, VITE_CLASSIC_LIVE: process.env.VITE_CLASSIC_LIVE };
    try {
      delete process.env.NODE_ENV;
      expect(() => make({ mode: "staging", command: "build" })).toThrow(/needs NODE_ENV=production/);
      process.env.NODE_ENV = "production";
      process.env.VITE_CLASSIC_LIVE = '{"eth-1":["withdraw"]}';
      expect(() => make({ mode: "staging", command: "build" })).toThrow(/not cleared by the legal review/);
    } finally {
      for (const [k, v] of Object.entries(saved))
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
  });

  it("the app's sources say no promise word", () => {
    const r = checkWords();
    expect(r.problems).toEqual([]);
    expect(r.files).toBeGreaterThan(3);
  });
});

describe("the declared dependencies", () => {
  it("every bare import of the app is declared by classic/package.json", () => {
    const r = checkDeps();
    expect(r.problems).toEqual([]);
    expect(r.checked).toBeGreaterThan(5);
  });
  it("refuses an undeclared package, a Privacy Wallet package and a Node built-in in src", () => {
    const dir = mkdtempSync(join(tmpdir(), "classic-deps-"));
    try {
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { react: "1" }, devDependencies: { vitest: "1" } }));
      writeFileSync(
        join(dir, "src", "a.ts"),
        ['import "react";', 'import "lodash";', 'import "@privacy-wallet/sdk";', 'import { x } from "node:fs";'].join("\n"),
      );
      const r = checkDeps(dir);
      expect(r.problems).toHaveLength(3);
      expect(r.problems.join("\n")).toMatch(/lodash/);
      expect(r.problems.join("\n")).toMatch(/@privacy-wallet\/sdk/);
      expect(r.problems.join("\n")).toMatch(/node:fs/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the generated tokens", () => {
  it("src/tokens.generated.css is what packages/ui's tokens generate, under a header naming the source and its hash", () => {
    expect(checkTokens().ok).toBe(true);
    expect(generated()).toMatch(/^\/\* Generated by classic\/scripts\/tokens\.mjs from packages\/ui\/src\/tokens\/tokens\.css \(sha256 [0-9a-f]{64}\)/);
    expect(generated()).toContain("--fg:");
  });
});

describe("the artifact pins", () => {
  it("a planted directory: a match passes, a mismatch and an unpinned file fail, an absent pinned file is skipped", () => {
    const dir = mkdtempSync(join(tmpdir(), "classic-pins-"));
    try {
      const artifacts = join(dir, "artifacts");
      mkdirSync(artifacts);
      writeFileSync(join(artifacts, "a.bin"), "hello");
      const pins = {
        files: { "a.bin": { sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824", bytes: 5 }, "absent.bin": { sha256: "00", bytes: 1 } },
      };
      writeFileSync(join(dir, "artifacts.json"), JSON.stringify(pins));
      const ok = checkPins({ pinFile: join(dir, "artifacts.json"), dir: artifacts, dist: join(dir, "nodist") });
      expect(ok.ok).toBe(true);
      expect(ok.rows.map((r: { status: string }) => r.status)).toEqual(["match", "skipped"]);
      writeFileSync(join(artifacts, "a.bin"), "hellp");
      writeFileSync(join(artifacts, "b.bin"), "x");
      const bad = checkPins({ pinFile: join(dir, "artifacts.json"), dir: artifacts, dist: join(dir, "nodist") });
      expect(bad.ok).toBe(false);
      expect(bad.problems.join("\n")).toMatch(/a\.bin: the file does not match/);
      expect(bad.problems.join("\n")).toMatch(/b\.bin is not pinned/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("the app's own pin file names the three artifacts, and its served copy is equal", () => {
    const r = checkPins({ publicPinFile: PUBLIC_PIN_FILE, dist: join(tmpdir(), "nodist-classic") });
    expect(r.problems).toEqual([]);
    expect(r.rows.map((x: { name: string }) => x.name).sort()).toEqual(["tornado.json", "tornadoProvingKey.bin", "witness.json"]);
  });
});
