#!/usr/bin/env node
// The bundle scan (spec v2.0 §17, §19; doc §83; V6 Stage 15): what the production build of the web wallet ships —
// apps/web/dist after `npm run build` — must be first-party code only. It refuses:
//   - a tracker's SDK or host (analytics, session replay, advertising pixels, error trackers that phone home);
//   - a source map, as a file or as a sourceMappingURL comment;
//   - a test seed: a development mnemonic, a devnet account's private key, a password the suites use.
// It first proves it can see each kind (a self-test over a planted directory), then scans the build.
//   node scripts/scan-bundle.mjs [dir]
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Trackers by SDK name or host (lowercase substrings of the shipped text). */
export const TRACKERS = [
  "google-analytics.com",
  "googletagmanager.com",
  "gtag/js",
  "analytics.google.com",
  "doubleclick.net",
  "cdn.segment.com",
  "api.segment.io",
  "mixpanel.com",
  "api.amplitude.com",
  "cdn.amplitude.com",
  "static.hotjar.com",
  "fullstory.com",
  "posthog.com",
  "i.posthog.com",
  "ingest.sentry.io",
  "browser.sentry-cdn.com",
  "datadoghq.com",
  "browser-intake-datadoghq",
  "js-agent.newrelic.com",
  "widget.intercom.io",
  "connect.facebook.net",
  "fbevents.js",
  "clarity.ms",
  "plausible.io",
  "heapanalytics.com",
  "cdn.logrocket",
  "mouseflow.com",
  "matomo.js",
];
/** Test seeds: the development mnemonics, the devnet's first account key, the suites' passwords. */
export const TEST_SEEDS = [
  "test test test test test test test test test test test junk",
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "correct horse battery staple",
  "a strong password for the leakage gate",
  "core-wasm-test-seed",
  "crypto-worker-test-seed",
];

function files(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) files(p, out);
    else out.push(p);
  }
  return out;
}

/** The problems of a build directory (empty when clean). */
export function scan(dir) {
  const problems = [];
  for (const f of files(dir)) {
    const name = relative(dir, f).replace(/\\/g, "/");
    if (f.endsWith(".map")) {
      problems.push(`${name}: a source map`);
      continue;
    }
    if (!/\.(js|mjs|html|css|json|txt|webmanifest|svg)$/.test(f)) continue;
    const text = readFileSync(f, "utf8");
    const lower = text.toLowerCase();
    if (/[#@]\s*sourceMappingURL=/.test(text)) problems.push(`${name}: a sourceMappingURL comment`);
    for (const t of TRACKERS) if (lower.includes(t)) problems.push(`${name}: a tracker (${t})`);
    for (const s of TEST_SEEDS) if (lower.includes(s)) problems.push(`${name}: a test seed (${s.slice(0, 24)}…)`);
  }
  return problems;
}

/** The scan sees each kind it refuses (a planted directory), and passes a clean one. */
function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), "scan-bundle-"));
  try {
    writeFileSync(join(dir, "clean.js"), "export const a = 1;\n");
    if (scan(dir).length) throw new Error("the self-test's clean file was refused");
    writeFileSync(join(dir, "a.js"), 'import "https://www.googletagmanager.com/gtag/js";\n//# sourceMappingURL=a.js.map\n');
    writeFileSync(join(dir, "a.js.map"), "{}");
    writeFileSync(join(dir, "b.js"), `const seed = "${TEST_SEEDS[0]}";\n`);
    const found = scan(dir).join("\n");
    for (const kind of ["a tracker", "a source map", "a sourceMappingURL comment", "a test seed"])
      if (!found.includes(kind)) throw new Error(`the self-test did not see ${kind}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  selfTest();
  const dist = process.argv[2] ?? join(root, "apps/web/dist");
  if (!existsSync(join(dist, "index.html"))) {
    console.error(`FAIL  no build to scan at ${relative(root, dist) || dist} (npm run build in apps/web first)`);
    process.exit(1);
  }
  const problems = scan(dist);
  if (problems.length) {
    for (const p of problems) console.error(`FAIL  ${p}`);
    process.exit(1);
  }
  console.log(`PASS  dist/ scanned: no tracker SDK or host, no source map, no test seed (${files(dist).length} files; the self-test saw each kind)`);
}
