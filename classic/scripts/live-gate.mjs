// The live switch tied to the legal review's record (the tenth review round, C10-15): a production build that turns any pool function on
// is refused unless classic/docs/legal-review.md records an outcome and lists that pool function as cleared — the release gate had been a
// document only, and nothing stopped a build from switching a pool on before the review. Read by vite.config.ts at build time.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The record's cell for a field of the table in legal-review.md ("—" or empty: not filled in). */
export function recordCell(review, field) {
  for (const line of review.split(/\r?\n/)) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length >= 4 && cells[1] === field) return cells[2];
  }
  return null;
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
  const outcome = recordCell(review, "Outcome");
  const cleared = recordCell(review, "Pool functions cleared") ?? "";
  const problems = [];
  if (!outcome || outcome === "—") problems.push("classic/docs/legal-review.md records no outcome: no pool function may be switched on");
  const listed = new Set(cleared.split(/[\s,;]+/).filter(Boolean));
  for (const a of asked) if (!listed.has(a)) problems.push(`VITE_CLASSIC_LIVE switches ${a} on, which classic/docs/legal-review.md does not list as cleared`);
  return problems;
}

/** The build's check: throws with every problem. */
export function assertLiveCleared(liveText, root) {
  const problems = liveGateProblems(liveText, readFileSync(join(root, "docs", "legal-review.md"), "utf8"));
  if (problems.length) throw new Error(`the live switch is not cleared by the legal review:\n- ${problems.join("\n- ")}`);
}
