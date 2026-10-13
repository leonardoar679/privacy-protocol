// A badge holds a status of a word or two and never wraps (spec v2.0 §5; doc §9); a sentence belongs in a note or a
// card. V6 Stage 6: sentences the V5 screens still put in badges overflowed a phone (the institutional tier's notice ran
// about 510 px past a 430 px screen and the browser run's clicks missed). This scan keeps every badge's words short:
// each message inside a StatusBadge or a Badge stays within 40 characters, a placeholder counted as eight.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { en } from "../src/app/i18n/en";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const LIMIT = 40;
const PLACEHOLDER = 8;

function tsx(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? tsx(join(dir, e.name)) : e.name.endsWith(".tsx") ? [join(dir, e.name)] : [],
  );
}

/** The length a message renders at, its placeholders counted as PLACEHOLDER characters each. */
const renderedLength = (text: string): number => text.replace(/\{[a-zA-Z]+\}/g, "x".repeat(PLACEHOLDER)).length;

/** Every message key used inside a <StatusBadge> or a <Badge> of the files, with where. */
function badgeMessages(files: string[]): { key: string; where: string }[] {
  const out: { key: string; where: string }[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/<(StatusBadge|Badge)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
      const line = src.slice(0, m.index).split("\n").length;
      for (const k of m[2].matchAll(/\bt\("([^"]+)"/g)) out.push({ key: k[1], where: `${relative(SRC, f).replaceAll("\\", "/")}:${line}` });
    }
  }
  return out;
}

describe("badge words (spec v2.0 §5)", () => {
  it(`every message in a badge is short: at most ${LIMIT} characters, a placeholder counted as ${PLACEHOLDER}`, () => {
    const found = badgeMessages(tsx(SRC));
    expect(
      found.map((f) => f.key),
      "the scan finds the badges",
    ).toEqual(expect.arrayContaining(["security.backedUp", "recovery.fundsSafe"]));
    const long = found.filter(({ key }) => renderedLength((en as Record<string, string>)[key] ?? "") > LIMIT).map(({ key, where }) => `${where} ${key}`);
    expect(long, "a sentence goes in a note or a card, not in a badge").toEqual([]);
  });
  it("the measure: placeholders count as amounts, a sentence fails", () => {
    expect(renderedLength("Executing")).toBe(9);
    expect(renderedLength("✓ Recovery backup created · {date}")).toBeLessThanOrEqual(LIMIT);
    expect(renderedLength(en["swap.largeNotice"])).toBeGreaterThan(LIMIT);
    expect(renderedLength(en["protect.done"])).toBeGreaterThan(LIMIT);
  });
});
