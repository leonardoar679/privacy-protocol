// The Classic word policy (spec v3.0 §7.9; the owner's decision 8): the original's labels stay — "Anonymity set",
// "Subsequent deposits", "Time passed" — and the promise words of the Privacy Wallet's rule stay banned everywhere a
// user reads: no "anonymous", no "mixer", no "untraceable", "undetectable" or "invisible", no "impossible to trace", no
// "100 %" claim. Scans src/ and index.html; exported for the tests and scripts/gates.mjs.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// the app's directory, computed when a scan asks for it: under a browser-like test environment import.meta.url is not a
// file URL, and a DOM test imports scan() alone
const appDir = () => join(fileURLToPath(new URL(".", import.meta.url)), "..");

export const PROMISES = [
  ["anonymous", /\banonymous\b/i],
  ["mixer", /\bmixers?\b/i],
  ["untraceable", /\buntraceable\b/i],
  ["undetectable", /\bundetectable\b/i],
  ["invisible", /\binvisible\b/i],
  ["impossible to trace", /\bimpossible to trace\b/i],
  ["a 100 % claim", /\b100\s?%/],
];

/** The promise words a text contains. */
export function scan(text) {
  return PROMISES.filter(([, rx]) => rx.test(text)).map(([w]) => w);
}

const TEXT = /\.(ts|tsx|html|json)$/; // what a user may read: not the stylesheets (a CSS "100%" is a size)
function files(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist" || e.startsWith(".")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) files(p, out);
    else if (TEXT.test(e)) out.push(p);
  }
  return out;
}

/** Every promise word in the app's sources, by file and line. */
export function checkWords(app = appDir()) {
  const problems = [];
  const targets = [...files(join(app, "src")), join(app, "index.html")];
  for (const f of targets) {
    readFileSync(f, "utf8")
      .split("\n")
      .forEach((line, i) => {
        for (const w of scan(line)) problems.push(`${relative(app, f).replace(/\\/g, "/")}:${i + 1}: says "${w}"`);
      });
  }
  return { ok: problems.length === 0, problems, files: targets.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = checkWords();
  if (!r.ok) {
    console.error(r.problems.join("\n"));
    process.exit(1);
  }
  console.log(`PASS  words: ${r.files} files, no promise word`);
}
