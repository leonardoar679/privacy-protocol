#!/usr/bin/env node
// The screenshot harness (spec v2.0 §19 "screenshots" and "acceptance"; V6 Stage 5). It starts apps/web in fixtures
// mode, renders every fixture of apps/web/src/fixtures/registry.tsx in the installed Chrome (Playwright, channel
// "chrome") under a fixed clock, UTC, en-US, reduced motion and a device scale factor of 1, with animations and the caret
// off, after the fonts have loaded, and:
//   - compares each image with its reviewed baseline at 390x844, 430x932, 768x1024 and 1440x900 (pixelmatch threshold
//     0.1; a fixture fails above 0.1 % of its pixels), baselines in tests/visual/baselines/<platform>/;
//   - checks the layout at the ten sizes of spec §6: no horizontal scroll; the shell's one bar — from 1024 px the top bar
//     above <main> and no bottom bar, below it the bottom bar at the bottom of the viewport and no top bar (V5 drew the
//     desktop navigation after the content); a "screen" fixture shows at most one primary action and never a destructive
//     button beside a confirmation (doc §57); every control is at least 44 px tall.
// UPDATE_BASELINES=1 writes the baselines (review every image before committing it). Diffs, the actual images and the
// report land in tests/visual/run/ (git-ignored). The suite is local: baselines are bound to a platform's rendering.
//   node tests/visual/run.mjs [--only <fixture-id>]
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const WEB = join(ROOT, "apps", "web");
const PORT = Number(process.env.VISUAL_PORT ?? 5199);
const BASE = `http://127.0.0.1:${PORT}`;
const PLATFORM = process.platform;
const BASELINES = join(HERE, "baselines", PLATFORM);
const RUN = join(HERE, "run", PLATFORM);
const UPDATE = process.env.UPDATE_BASELINES === "1";
const ONLY = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
/** The baselines' viewports (spec §19) and the ten layout sizes (spec §6). */
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
const CLOCK = new Date("2026-10-13T12:00:00Z");
const QUIET = "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startVite() {
  const vite = join(ROOT, "node_modules", "vite", "bin", "vite.js");
  const p = spawn(process.execPath, [vite, "--mode", "fixtures", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
    cwd: WEB,
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

async function before(page, fixture, width) {
  if (fixture.before !== "open-wallet-menu") return true;
  if (width < 1024) return false; // the Wallet menu is the desktop's
  await page.click('[data-testid="nav-wallet"]');
  await page.waitForSelector('[data-testid="nav-wallet-panel"]');
  return true;
}

/** The layout checks of one fixture at one size; the problems found, in words. */
async function layout(page, fixture) {
  return page.evaluate((kind) => {
    const problems = [];
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    if (document.documentElement.scrollWidth > vw + 1)
      problems.push(`horizontal scroll: the page is ${document.documentElement.scrollWidth} px wide in ${vw} px`);
    const main = document.querySelector("main");
    const bar = document.querySelector('[data-testid="app-bar"]');
    const bottom = document.querySelector('[data-testid="bottom-navigation"]');
    if (main && (bar || bottom)) {
      if (vw >= 1024) {
        if (!visible(bar)) problems.push("from 1024 px the top bar must show");
        else if (bar.getBoundingClientRect().bottom > main.getBoundingClientRect().top + 1) problems.push("the top bar must sit above <main>");
        if (visible(bottom)) problems.push("from 1024 px no bottom bar may show");
      } else {
        if (!visible(bottom)) problems.push("below 1024 px the bottom bar must show");
        else if (Math.abs(bottom.getBoundingClientRect().bottom - vh) > 1) problems.push("the bottom bar must sit at the bottom of the viewport");
        if (visible(bar)) problems.push("below 1024 px no top bar may show");
      }
    }
    if (kind === "screen") {
      const primaries = [...document.querySelectorAll('[data-variant="primary"]')].filter(visible);
      if (primaries.length > 1) problems.push(`${primaries.length} visible primary actions (at most one per screen)`);
      for (const d of [...document.querySelectorAll('[data-variant="destructive"]')].filter(visible)) {
        const near = [d.previousElementSibling, d.nextElementSibling].filter(Boolean);
        if (near.some((n) => n.matches('[data-variant="primary"]') || n.querySelector('[data-variant="primary"]')))
          problems.push("a destructive button beside a confirmation (doc §57)");
      }
    }
    const controls =
      ".ds-btn, .ds-icon-btn, .ds-text-btn, .ds-nav-item, .ds-topnav-item, .ds-menu-button, button.ds-chip, .ds-address-chip-copy, button.ds-list-row, button.ds-asset-row";
    for (const c of [...document.querySelectorAll(controls)].filter(visible)) {
      const r = c.getBoundingClientRect();
      if (r.height < 43.5) problems.push(`a control ${Math.round(r.height)} px tall (44 px): ${c.className} "${(c.textContent ?? "").trim().slice(0, 30)}"`);
    }
    return [...new Set(problems)];
  }, fixture.kind);
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
const report = { at: new Date().toISOString(), platform: PLATFORM, shots: [], layout: [] };
let failures = 0;
try {
  const probe = await browser.newPage();
  await probe.goto(`${BASE}/fixtures.html`);
  await probe.waitForSelector('[data-fixture-ready="index"]');
  const fixtures = (await probe.evaluate(() => window.__PW_FIXTURES__)).filter((f) => !ONLY || f.id === ONLY);
  await probe.close();
  if (!fixtures.length) throw new Error(`no fixture${ONLY ? ` named ${ONLY}` : ""}`);

  for (const [w, h] of SIZES) {
    const context = await browser.newContext({
      viewport: { width: w, height: h },
      deviceScaleFactor: 1,
      locale: "en-US",
      timezoneId: "UTC",
      reducedMotion: "reduce",
      colorScheme: "light",
    });
    for (const f of fixtures) {
      const page = await open(context, f.id);
      if (await before(page, f, w)) {
        const problems = await layout(page, f);
        report.layout.push({ fixture: f.id, size: `${w}x${h}`, problems });
        if (problems.length) {
          failures++;
          console.log(`FAIL  layout ${f.id} @${w}x${h}: ${problems.join("; ")}`);
        }
        if (SHOTS.some(([sw, sh]) => sw === w && sh === h)) {
          const shots = f.parts.length ? f.parts : [["page", null]];
          for (const [part, selector] of shots) {
            const png = selector
              ? await page.locator(selector).screenshot({ animations: "disabled", caret: "hide" })
              : await page.screenshot({ fullPage: true, animations: "disabled", caret: "hide" });
            const r = compare(`${f.id}${selector ? `--${part}` : ""}@${w}x${h}`, png);
            report.shots.push(r);
            if (r.status === "failed" || r.status === "missing") {
              failures++;
              console.log(`FAIL  ${r.name}: ${r.problem}`);
            }
          }
        }
      }
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
  `visual: ${report.shots.length} screenshots (${UPDATE ? `${written} baselines written` : `${matched} match`}), ${report.layout.length} layout checks at ${SIZES.length} sizes; ${failures} failure(s)`,
);
process.exit(failures ? 1 : 0);
