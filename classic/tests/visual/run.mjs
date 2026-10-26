#!/usr/bin/env node
// The Classic app's screenshot harness (spec v3.0 §7.9 parity, §10 gates; V7 Stage 3) — the Privacy Wallet's
// tests/visual/run.mjs remade for a second app that shares no code with it. It starts the Classic dev server in fixtures
// mode, renders every fixture of src/fixtures/registry.tsx in the installed Chrome (Playwright, channel "chrome") under a
// fixed clock, UTC, en-US, reduced motion and a device scale factor of 1, with animations and the caret off, after the
// fonts have loaded, and:
//   - compares each image with its reviewed baseline at 390x844, 430x932, 768x1024 and 1440x900 (pixelmatch threshold 0.1;
//     a fixture fails above 0.1 % of its pixels), baselines in tests/visual/baselines/<platform>/;
//   - checks the layout at the ten sizes the wallet's spec §6 names: no horizontal scroll; the Statistics beside the form
//     from 1024 px and below it before; the Not connected banner on every screen (spec v3.0 §7.7); at most one visible
//     primary action (inside the open dialog when one is open); every control at least 44 px tall;
//   - the Classic word policy (scripts/words.mjs), no full address and no amount past six decimals on any screen;
//   - axe (axe-core in the real browser, colour contrast included) on every fixture at 390 px;
//   - the text at 200 % on every fixture at 390 px: nothing scrolls sideways, nothing is cut.
// UPDATE_BASELINES=1 writes the baselines (review every image before committing it). Diffs, the actual images and the
// report land in tests/visual/run/ (git-ignored). The suite is local: baselines are bound to a platform's rendering.
//   node tests/visual/run.mjs [--only <fixture-id>] [--a11y-only]
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { PROMISES } from "../../scripts/words.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..", "..");
const require = createRequire(import.meta.url);
const AXE = require.resolve("axe-core/axe.min.js");
const PORT = Number(process.env.CLASSIC_VISUAL_PORT ?? 5198);
const BASE = `http://127.0.0.1:${PORT}/classic`;
const PLATFORM = process.platform;
const BASELINES = join(HERE, "baselines", PLATFORM);
const RUN = join(HERE, "run", PLATFORM);
const UPDATE = process.env.UPDATE_BASELINES === "1";
const ONLY = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
/** the accessibility passes alone (no screenshots, no layout sizes): a quick loop while fixing what they find */
const A11Y_ONLY = process.argv.includes("--a11y-only");
const SHOTS = [
  [390, 844],
  [430, 932],
  [768, 1024],
  [1440, 900],
];
const SIZES = [
  [360, 800],
  [375, 812],
  [390, 844],
  [393, 852],
  [412, 915],
  [430, 932],
  [768, 1024],
  [1024, 768],
  [1280, 800],
  [1440, 900],
];
const THRESHOLD = 0.1;
const MAX_DIFF_RATIO = 0.001;
const CLOCK = new Date("2026-10-26T12:00:00Z");
const QUIET = "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }";
const ADDRESS = /\b0x[0-9a-fA-F]{40}\b/;
const LONG_DECIMALS = /\d\.\d{7,}/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startVite() {
  const vite = join(APP, "node_modules", "vite", "bin", "vite.js");
  const p = spawn(process.execPath, [vite, "--mode", "fixtures", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
    cwd: APP,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, BROWSER: "none" },
  });
  let log = "";
  p.stdout.on("data", (d) => (log += d));
  p.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${BASE}/fixtures.html`);
      if (r.ok) return p;
    } catch {
      /* not up yet */
    }
    if (p.exitCode !== null) break;
    await sleep(500);
  }
  p.kill();
  throw new Error(`the fixtures server did not start on ${BASE}:\n${log}`);
}

async function open(context, id) {
  const page = await context.newPage();
  await page.clock.setFixedTime(CLOCK);
  await page.goto(`${BASE}/fixtures.html#${encodeURIComponent(id)}`);
  await page.waitForSelector(`[data-fixture-ready="${id}"]`, { timeout: 30_000 });
  await page.addStyleTag({ content: QUIET });
  await page.evaluate(() => document.fonts.ready);
  return page;
}

/** The layout checks of one fixture at one size; the problems found, in words. */
async function layout(page) {
  return page.evaluate(() => {
    const problems = [];
    const vw = window.innerWidth;
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    if (document.documentElement.scrollWidth > vw + 1)
      problems.push(`horizontal scroll: the page is ${document.documentElement.scrollWidth} px wide in ${vw} px`);
    if (!visible(document.querySelector('[data-testid="classic-not-connected"]')))
      problems.push("the Not connected banner must show on every screen (spec v3.0 §7.7)");
    const main = document.querySelector("main");
    const aside = document.querySelector("aside");
    if (main && aside && visible(aside)) {
      const m = main.getBoundingClientRect();
      const a = aside.getBoundingClientRect();
      if (vw >= 1024) {
        if (a.left < m.right - 1) problems.push("from 1024 px the Statistics sit beside the form");
        if (Math.abs(a.top - m.top) > 2) problems.push("from 1024 px the Statistics start level with the form");
      } else if (a.top < m.bottom - 1) problems.push("below 1024 px the Statistics sit below the form");
    }
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find(visible);
    const scope = dialog ?? document;
    const primaries = [...scope.querySelectorAll('[data-variant="primary"]')].filter(visible);
    if (primaries.length > 1) problems.push(`${primaries.length} visible primary actions (at most one per ${dialog ? "dialog" : "screen"})`);
    for (const c of [...scope.querySelectorAll('button, a[href], select, input:not([type="checkbox"])')].filter(visible)) {
      const r = c.getBoundingClientRect();
      if (r.height < 43.5)
        problems.push(
          `a control ${Math.round(r.height)} px tall (44 px): ${c.getAttribute("data-testid") ?? c.className} "${(c.textContent ?? "").trim().slice(0, 30)}"`,
        );
    }
    return [...new Set(problems)];
  });
}

/** The Classic word policy and the two display rules, on the visible text. */
async function vocabulary(page) {
  const text = await page.evaluate(() => document.body.innerText);
  const problems = PROMISES.filter(([, rx]) => rx.test(text)).map(([word]) => `the screen says "${word}" (spec v3.0 §7.9)`);
  if (ADDRESS.test(text)) problems.push("the screen shows a full address (hashes and addresses are shortened)");
  if (LONG_DECIMALS.test(text)) problems.push("an amount past six decimals");
  return problems;
}

/** axe in the browser (the init script put axe-core on the page): every violation, with up to three targets. */
async function a11y(page) {
  return page.evaluate(async () => {
    const results = await window.axe.run(document, { resultTypes: ["violations"] });
    return results.violations.map(
      (v) =>
        `${v.id} (${v.impact}): ${v.help} — ${v.nodes
          .slice(0, 3)
          .map((n) => n.target.join(" "))
          .join(", ")}`,
    );
  });
}

/** With the text at 200 %, no sideways scroll and no element that cuts its text (an element that hides its overflow —
 *  or ends it with an ellipsis — while its text is wider or taller than its box). */
async function clipping(page) {
  return page.evaluate(() => {
    const problems = [];
    const root = document.scrollingElement;
    const label = (el) =>
      el.getAttribute("data-testid") ?? (typeof el.className === "string" && el.className ? `.${el.className.split(" ")[0]}` : el.tagName.toLowerCase());
    if (root.scrollWidth > window.innerWidth + 1) {
      const out = [...document.querySelectorAll("body *")].filter(
        (el) =>
          el.getBoundingClientRect().right > window.innerWidth + 1 && ![...el.children].some((c) => c.getBoundingClientRect().right > window.innerWidth + 1),
      );
      problems.push(`the page scrolls sideways (${root.scrollWidth} px at ${window.innerWidth} px: ${[...new Set(out.map(label))].slice(0, 4).join(", ")})`);
    }
    for (const el of document.querySelectorAll("body *")) {
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden" || el.closest(".tc-sr-only")) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) continue;
      if (!el.textContent.trim()) continue;
      if (el.matches(".tc-modal")) continue; // the dialog scrolls by design when taller than the viewport
      const cutsX = ["hidden", "clip"].includes(s.overflowX) || s.textOverflow === "ellipsis";
      const cutsY = ["hidden", "clip"].includes(s.overflowY);
      const name = label(el);
      if (cutsX && el.scrollWidth > el.clientWidth + 1) problems.push(`${name} cuts its text sideways (${el.scrollWidth} > ${el.clientWidth} px)`);
      else if (cutsY && el.scrollHeight > el.clientHeight + 1) problems.push(`${name} cuts its text (${el.scrollHeight} > ${el.clientHeight} px tall)`);
      if (problems.length >= 8) break;
    }
    return problems;
  });
}

function compare(name, png) {
  const file = join(BASELINES, `${name}.png`);
  mkdirSync(RUN, { recursive: true });
  writeFileSync(join(RUN, `${name}.png`), png);
  if (UPDATE) {
    mkdirSync(BASELINES, { recursive: true });
    writeFileSync(file, png);
    return { name, status: "written" };
  }
  if (!existsSync(file)) return { name, status: "missing", problem: "no baseline (UPDATE_BASELINES=1, then review the image)" };
  const a = PNG.sync.read(readFileSync(file));
  const b = PNG.sync.read(png);
  if (a.width !== b.width || a.height !== b.height) return { name, status: "failed", problem: `size ${b.width}x${b.height}, baseline ${a.width}x${a.height}` };
  const diff = new PNG({ width: a.width, height: a.height });
  const n = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: THRESHOLD });
  const ratio = n / (a.width * a.height);
  if (ratio > MAX_DIFF_RATIO) {
    writeFileSync(join(RUN, `${name}.diff.png`), PNG.sync.write(diff));
    return { name, status: "failed", problem: `${n} pixels differ (${(ratio * 100).toFixed(3)} %)` };
  }
  return { name, status: "match", diff: n };
}

const vite = await startVite();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const report = { at: new Date().toISOString(), platform: PLATFORM, shots: [], layout: [], acceptance: [] };
let failures = 0;
const fail = (where, problems) => {
  report.acceptance.push({ where, problems });
  if (problems.length) {
    failures++;
    console.log(`FAIL  ${where}: ${problems.join("; ")}`);
  }
};
const base = { deviceScaleFactor: 1, locale: "en-US", timezoneId: "UTC", reducedMotion: "reduce", colorScheme: "light" };
try {
  const probe = await browser.newPage();
  await probe.goto(`${BASE}/fixtures.html`);
  await probe.waitForSelector('[data-fixture-ready="index"]');
  const fixtures = (await probe.evaluate(() => window.__TC_FIXTURES__)).filter((f) => !ONLY || f.id === ONLY);
  await probe.close();
  if (!fixtures.length) throw new Error(`no fixture${ONLY ? ` named ${ONLY}` : ""}`);

  for (const [w, h] of A11Y_ONLY ? [] : SIZES) {
    const context = await browser.newContext({ ...base, viewport: { width: w, height: h } });
    for (const f of fixtures) {
      const page = await open(context, f.id);
      const problems = await layout(page);
      report.layout.push({ fixture: f.id, size: `${w}x${h}`, problems });
      if (problems.length) {
        failures++;
        console.log(`FAIL  layout ${f.id} @${w}x${h}: ${problems.join("; ")}`);
      }
      if (SHOTS.some(([sw, sh]) => sw === w && sh === h)) {
        const png = await page.screenshot({ fullPage: true, animations: "disabled", caret: "hide" });
        const r = compare(`${f.id}@${w}x${h}`, png);
        report.shots.push(r);
        if (r.status === "failed" || r.status === "missing") {
          failures++;
          console.log(`FAIL  ${r.name}: ${r.problem}`);
        }
      }
      if (w === 390 && h === 844) fail(`vocabulary ${f.id}`, await vocabulary(page));
      await page.close();
    }
    await context.close();
  }
  // axe in the real browser, then the text at 200 %, on every fixture at 390 px
  {
    const context = await browser.newContext({ ...base, viewport: { width: 390, height: 844 } });
    await context.addInitScript({ path: AXE });
    for (const f of fixtures) {
      const page = await open(context, f.id);
      fail(`axe ${f.id}`, await a11y(page));
      await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
      await page.evaluate(() => document.fonts.ready);
      fail(`text 200 % ${f.id}`, await clipping(page));
      await page.close();
    }
    await context.close();
  }
} finally {
  await browser.close();
  vite.kill();
}

mkdirSync(join(HERE, "run"), { recursive: true });
writeFileSync(join(HERE, "run", "report.json"), JSON.stringify(report, null, 2) + "\n");
const written = report.shots.filter((s) => s.status === "written").length;
const matched = report.shots.filter((s) => s.status === "match").length;
console.log(
  `classic visual: ${report.shots.length} screenshots (${UPDATE ? `${written} baselines written` : `${matched} match`}), ${report.layout.length} layout checks at ${SIZES.length} sizes, ${report.acceptance.length} acceptance checks; ${failures} failure(s)`,
);
process.exit(failures ? 1 : 0);
