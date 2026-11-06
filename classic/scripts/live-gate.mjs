// The live switch tied to the legal review's record (the tenth review round, C10-15): any build that turns a pool function on is refused
// unless classic/docs/legal-review.md's classic-live-gate block records the outcome cleared and lists that pool function, and the record's
// visible table says the same (the eleventh review round, C11-4, and its critique) — the release gate had been a document only, and nothing
// stopped a build from switching a pool on before the review. Read by vite.config.ts at every build.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The record's cell for a field of the table in legal-review.md ("—" or empty: not filled in) — what people read; the block below must agree. */
export function recordCell(review, field) {
  for (const line of review.split(/\r?\n/)) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length >= 4 && cells[1] === field) return cells[2];
  }
  return null;
}

/** The pools and functions a record can clear. */
const POOLS = ["eth-0.1", "eth-1", "eth-10", "eth-100"];
const FUNCTIONS = ["deposit", "withdraw"];
/**
 * The machine-read record (the eleventh review round, 2026-11-04, C11-4): exactly one `<!-- classic-live-gate … -->` block, its outcome one of
 * none, cleared, refused, its cleared tokens exact `pool:function` pairs. The table had been read loosely — any outcome but "—" passed, and a
 * token anywhere in the first row of that name cleared a function.
 */
export function gateRecord(review) {
  const blocks = [...review.matchAll(/<!--\s*classic-live-gate\s*\n([\s\S]*?)-->/g)];
  if (blocks.length !== 1) return { problem: `classic/docs/legal-review.md must hold exactly one classic-live-gate record (it holds ${blocks.length})` };
  const lines = blocks[0][1]
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const field = (name) => {
    const found = lines.filter((l) => l.startsWith(`${name}:`));
    return found.length === 1 ? found[0].slice(name.length + 1).trim() : null;
  };
  const outcome = field("outcome");
  const cleared = field("cleared");
  if (outcome === null || !["none", "cleared", "refused"].includes(outcome))
    return { problem: "the classic-live-gate record's outcome is not one of none, cleared, refused" };
  if (cleared === null) return { problem: "the classic-live-gate record names no cleared line" };
  const tokens = cleared.split(/\s+/).filter(Boolean);
  const bad = tokens.filter((t) => {
    const [pool, fn, extra] = t.split(":");
    return extra !== undefined || !POOLS.includes(pool) || !FUNCTIONS.includes(fn);
  });
  if (bad.length) return { problem: `the classic-live-gate record clears ${bad.join(", ")}, which is no pool:function pair` };
  return { outcome, cleared: new Set(tokens) };
}

/** The table's fields a block that clears pool functions needs filled in. */
const SIGNED_FIELDS = ["Reviewer (name, qualification, jurisdiction)", "Date concluded", "Outcome", "Pool functions cleared", "Owner's sign-off"];
/**
 * The visible record held to the block (the critique of C11-4): the block sits in an HTML comment, which rendered Markdown does not show — a
 * block that cleared functions under a table of "—" had switched them on while the record people read showed nothing reviewed.
 */
function tableProblems(review, record) {
  if (record.outcome !== "cleared") return [];
  const cell = (field) => recordCell(review, field);
  const filled = (field) => {
    const c = cell(field);
    return c !== null && c !== "" && c !== "—";
  };
  const problems = [];
  for (const field of SIGNED_FIELDS)
    if (!filled(field)) problems.push(`the record's table leaves "${field}" unfilled, while the classic-live-gate block clears pool functions`);
  if (filled("Outcome") && !cell("Outcome").toLowerCase().startsWith("cleared"))
    problems.push(`the record's table gives the outcome "${cell("Outcome")}", while the classic-live-gate block gives "cleared"`);
  const listed = new Set(cell("Pool functions cleared")?.match(/eth-(?:0\.1|1|10|100):(?:deposit|withdraw)\b/g) ?? []);
  if (filled("Pool functions cleared") && (listed.size !== record.cleared.size || [...listed].some((x) => !record.cleared.has(x))))
    problems.push("the record's table and the classic-live-gate block do not list the same pool functions as cleared");
  return problems;
}

/** What stops a build that turns on `live` (VITE_CLASSIC_LIVE's text) with this review record; empty when nothing does. */
export function liveGateProblems(liveText, review) {
  if (!liveText || !liveText.trim()) return [];
  let live;
  try {
    live = JSON.parse(liveText);
  } catch {
    return ["VITE_CLASSIC_LIVE is not JSON"];
  }
  const asked = Object.entries(live ?? {}).flatMap(([pool, fns]) => (Array.isArray(fns) ? fns.map((f) => `${pool}:${f}`) : []));
  if (!asked.length) return [];
  const record = gateRecord(review);
  if (record.problem) return [record.problem];
  const problems = [];
  if (record.outcome !== "cleared")
    problems.push(`the classic-live-gate block in classic/docs/legal-review.md records the outcome "${record.outcome}": no pool function may be switched on`);
  for (const a of asked)
    if (!record.cleared.has(a))
      problems.push(`VITE_CLASSIC_LIVE switches ${a} on, which the classic-live-gate block in classic/docs/legal-review.md does not list as cleared`);
  problems.push(...tableProblems(review, record));
  return problems;
}

/** The build's check: throws with every problem. */
export function assertLiveCleared(liveText, root) {
  const problems = liveGateProblems(liveText, readFileSync(join(root, "docs", "legal-review.md"), "utf8"));
  if (problems.length) throw new Error(`the live switch is not cleared by the legal review:\n- ${problems.join("\n- ")}`);
}
