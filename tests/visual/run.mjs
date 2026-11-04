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
//     button beside a confirmation (doc §57); every control is at least 44 px tall;
//   - and the acceptance checks of doc §86–§92: the vocabulary of every Simple screen (no Router, Calldata, Gas, Merkle,
//     root, Nullifier, Proof, Provider ID, escrow, commitment, witness, nonce, wei / gwei, tranche, memo, slippage, no
//     full 0x-40 address, no amount past its display decimals) and of every fixture (never anonymous, mixer, impossible to
//     trace, untraceable, invisible or undetectable — spec v2.0 §1); the $10,000 Review's ten items (§86); the $80,000
//     protected execution — the four checks, Hold to Confirm, no mode to choose (§87); every action of a 390 px screen
//     present at 1440 px (§88); the primary action visible with the amount focused above a keyboard (390 x 508, §56);
//   - and the accessibility checks a browser can make (doc §77, V6 Stage 16): every Simple screen at 390 px with the
//     text at 200 % (the root size: the type is in rem) neither scrolls sideways nor cuts a text; under more contrast the
//     high-contrast set applies (light and dark); under forced colours every button keeps a visible edge.
// UPDATE_BASELINES=1 writes the baselines (review every image before committing it). Diffs, the actual images and the
// report land in tests/visual/run/ (git-ignored). The suite is local: baselines are bound to a platform's rendering.
//   node tests/visual/run.mjs [--only <fixture-id>] [--a11y-only]
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
/** the accessibility passes alone (no screenshots, no layout sizes): a quick loop while fixing what they find */
const A11Y_ONLY = process.argv.includes("--a11y-only");
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

/** Doc §77: with the text at 200 %, no sideways scroll and no element that cuts its text (an element that hides its
 *  overflow — or ends it with an ellipsis — while its text is wider or taller than its box). The screen-reader-only text
 *  (a 1 px box by design) is not a cut. */
async function clipping(page) {
  return page.evaluate(() => {
    const problems = [];
    const root = document.scrollingElement;
    const label = (el) =>
      el.getAttribute("data-testid") ?? (typeof el.className === "string" && el.className ? `.${el.className.split(" ")[0]}` : el.tagName.toLowerCase());
    if (root.scrollWidth > window.innerWidth + 1) {
      // the deepest elements that stick out to the right name the cause
      const out = [...document.querySelectorAll("body *")].filter(
        (el) =>
          el.getBoundingClientRect().right > window.innerWidth + 1 && ![...el.children].some((c) => c.getBoundingClientRect().right > window.innerWidth + 1),
      );
      problems.push(`the page scrolls sideways (${root.scrollWidth} px at ${window.innerWidth} px: ${[...new Set(out.map(label))].slice(0, 4).join(", ")})`);
    }
    for (const el of document.querySelectorAll("body *")) {
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden" || el.closest(".sr-only")) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) continue;
      if (!el.textContent.trim()) continue;
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

/** Doc §92: the words a Simple screen never shows (the visible text only: a closed Advanced section is not rendered). */
const BANNED = [
  ["Router", /\brouter\b/i],
  ["Calldata", /\bcalldata\b/i],
  ["Gas", /\bgas\b/i],
  ["Merkle", /\bmerkle\b/i],
  ["root", /\broot\b/i],
  ["Nullifier", /\bnullifier/i],
  ["Proof", /\bproofs?\b/i],
  ["Provider ID", /\bprovider id\b/i],
  ["escrow", /\bescrow/i],
  ["commitment", /\bcommitment/i],
  ["witness", /\bwitness/i],
  ["nonce", /\bnonce\b/i],
  ["wei / gwei", /\bg?wei\b/i],
  ["tranche", /\btranche/i],
  ["memo", /\bmemo\b/i],
  ["slippage", /\bslippage\b/i],
  ["a full 0x-40 address", /\b0x[0-9a-fA-F]{40}\b/],
  ["an amount past its display decimals", /\d\.\d{9,}/],
];
// the claims the wallet never makes, on any screen (spec v2.0 §1, §7.10)
const NEVER = [
  ["anonymous", /\banonym/i],
  ["mixer", /\bmixers?\b/i],
  ["impossible to trace", /\bimpossible to trace\b/i],
  ["untraceable", /\buntraceable\b/i],
  ["invisible", /\binvisible\b/i],
  ["undetectable", /\bundetectable\b/i],
];
async function vocabulary(page, simple) {
  const text = await page.evaluate(() => document.body.innerText);
  return [
    ...(simple ? BANNED.filter(([, rx]) => rx.test(text)).map(([word]) => `the Simple screen shows "${word}" (doc §92)`) : []),
    ...NEVER.filter(([, rx]) => rx.test(text)).map(([word]) => `the screen says "${word}" (spec v2.0 §1)`),
  ];
}

/** Doc §86 and §87, on the two Review fixtures. */
async function acceptance(page, which) {
  const text = await page.evaluate(() => document.body.innerText);
  const has = (s) => text.includes(s);
  const problems = [];
  if (which === "§86") {
    const items = [
      "$10,000.00",
      "10,000 USDC",
      "≈ 2.886 ETH",
      "2.857 ETH",
      "Privacy fee",
      "$100.00",
      "Relayer/network",
      "Swap/provider",
      "Total fees",
      "Your protected balance",
      "High protection",
    ];
    for (const i of items) if (!has(i)) problems.push(`doc §86: the Review lacks "${i}"`);
    if (!(await page.locator('[data-testid="review-confirm"]').isVisible())) problems.push("doc §86: no Confirm");
  } else if (which === "§87") {
    for (const i of ["Protected execution", "Destination verified", "Quote locked", "Route health checked", "Execution limits enabled"])
      if (!has(i)) problems.push(`doc §87: the Review lacks "${i}"`);
    if (!(await page.locator('[data-testid="hold-to-confirm"]').isVisible())) problems.push("doc §87: no Hold to Confirm");
    if ((await page.locator('[role="radiogroup"], [data-testid="protection-mode"]').count()) > 0)
      problems.push("doc §87: a mode to choose (protection is automatic)");
  }
  return problems;
}

/** The actions of a screen by test id (doc §88 compares 390 px with 1440 px; the bars map onto each other). */
async function actions(page) {
  const ids = await page.evaluate(() =>
    [...document.querySelectorAll("button[data-testid], a[data-testid], input[data-testid]")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })
      .map((el) => el.getAttribute("data-testid")),
  );
  const BAR = { "nav-home": "top-nav-home", "nav-swap": "top-nav-swap", "nav-activity": "top-nav-activity", "nav-more": "nav-wallet" };
  return [...new Set(ids.map((id) => BAR[id] ?? id))];
}

/** Doc §56: with the amount focused on a phone whose keyboard leaves 508 px, the primary action is still on screen. */
async function keyboard(page) {
  await page.setViewportSize({ width: 390, height: 508 });
  const input = page.locator('[data-testid="amount-input"]').first();
  await input.focus();
  await page.waitForTimeout(150);
  return page.evaluate(() => {
    const p = [...document.querySelectorAll('[data-variant="primary"]')].find((el) => el.getBoundingClientRect().width > 0);
    if (!p) return ["no primary action to keep visible"];
    const r = p.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= window.innerHeight
      ? []
      : [`with the amount focused at 390x508 the primary action is off screen (top ${Math.round(r.top)}, bottom ${Math.round(r.bottom)})`];
  });
}

/** every baseline this run produced or compared: the files in the baselines directory must be exactly these (the sixth review round, 2026-11-03) */
const produced = new Set();
function compare(name, png) {
  produced.add(`${name}.png`);
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
const seen = new Map(); // fixture → { 390: actions, 1440: actions } for doc §88
const fail = (where, problems) => {
  report.acceptance.push({ where, problems });
  if (problems.length) {
    failures++;
    console.log(`FAIL  ${where}: ${problems.join("; ")}`);
  }
};
let failures = 0;
try {
  const probe = await browser.newPage();
  await probe.goto(`${BASE}/fixtures.html`);
  await probe.waitForSelector('[data-fixture-ready="index"]');
  const fixtures = (await probe.evaluate(() => window.__PW_FIXTURES__)).filter((f) => !ONLY || f.id === ONLY);
  await probe.close();
  if (!fixtures.length) throw new Error(`no fixture${ONLY ? ` named ${ONLY}` : ""}`);

  for (const [w, h] of A11Y_ONLY ? [] : SIZES) {
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
            // a full-page image draws the phone's fixed bottom bar in the flow (after the layout checks placed it at the viewport's bottom)
            if (!selector) await page.addStyleTag({ content: ".ds-bottomnav, .ds-sticky-action { position: static !important; }" });
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
        if (f.kind === "screen" && (w === 390 || w === 1440) && h === (w === 390 ? 844 : 900))
          seen.set(f.id, { ...(seen.get(f.id) ?? {}), [w]: await actions(page) });
        if (w === 390 && h === 844) {
          fail(`vocabulary ${f.id}`, await vocabulary(page, !!f.simple));
          if (f.accept) fail(`acceptance ${f.id} (${f.accept})`, await acceptance(page, f.accept));
          if (f.keyboard) fail(`keyboard ${f.id}`, await keyboard(page));
        }
      }
      await page.close();
    }
    await context.close();
  }
  // doc §77 (V6 Stage 16): the text at 200 % on every Simple screen at 390 px — nothing scrolls sideways, nothing is cut
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, locale: "en-US", timezoneId: "UTC", reducedMotion: "reduce" };
  {
    const context = await browser.newContext({ ...phone, colorScheme: "light" });
    for (const f of fixtures.filter((x) => x.kind === "screen" && x.simple)) {
      const page = await open(context, f.id);
      if (await before(page, f, 390)) {
        await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
        await page.evaluate(() => document.fonts.ready);
        fail(`text 200 % ${f.id}`, await clipping(page));
      }
      await page.close();
    }
    await context.close();
  }
  // doc §77: more contrast draws the high-contrast set (light and dark); forced colours keep every button's edge
  const CONTRAST_FIXTURES = ["home-funded", "protect", "swap", "review-large", "activity"];
  for (const [scheme, text] of [
    ["light", "rgb(0, 0, 0)"],
    ["dark", "rgb(255, 255, 255)"],
  ]) {
    const context = await browser.newContext({ ...phone, colorScheme: scheme, contrast: "more" });
    for (const f of fixtures.filter((x) => CONTRAST_FIXTURES.includes(x.id))) {
      const page = await open(context, f.id);
      const color = await page.evaluate(() => getComputedStyle(document.body).color);
      fail(`more contrast (${scheme}) ${f.id}`, color === text ? [] : [`the text is ${color}, not the high-contrast set's ${text}`]);
      await page.close();
    }
    await context.close();
  }
  {
    const context = await browser.newContext({ ...phone, colorScheme: "light", forcedColors: "active" });
    for (const f of fixtures.filter((x) => CONTRAST_FIXTURES.includes(x.id))) {
      const page = await open(context, f.id);
      const problems = await page.evaluate(() =>
        [...document.querySelectorAll(".ds-btn")]
          .filter((el) => el.getBoundingClientRect().width > 0)
          .filter((el) => {
            const s = getComputedStyle(el);
            return s.borderTopStyle === "none" || parseFloat(s.borderTopWidth) < 1;
          })
          .map((el) => `${el.getAttribute("data-testid") ?? el.textContent.trim()} has no visible edge`),
      );
      fail(`forced colours ${f.id}`, problems);
      await page.close();
    }
    await context.close();
  }
  // doc §88: everything a 390 px screen offers is there at 1440 px (the bottom bar's items become the top bar and the Wallet menu)
  for (const [id, by] of seen) {
    if (!by[390] || !by[1440]) continue;
    const missing = by[390].filter((a) => !by[1440].includes(a));
    fail(`parity ${id} (§88)`, missing.length ? [`at 1440 px the screen lacks ${missing.join(", ")}`] : []);
  }
} finally {
  await browser.close();
  vite.kill();
}

mkdirSync(join(HERE, "run"), { recursive: true });
// a baseline without a fixture is a fixture that was deleted, a renamed id or a stale image: coverage had shrunk silently and a
// stale baseline was never flagged (the sixth review round, 2026-11-03). A partial run (--only) and a baseline update are exempt
if (!ONLY && !UPDATE && !A11Y_ONLY && existsSync(BASELINES)) {
  const stale = readdirSync(BASELINES).filter((f) => f.endsWith(".png") && !produced.has(f));
  if (stale.length)
    fail("baselines", [
      `${stale.length} baseline(s) without a fixture: ${stale.slice(0, 6).join(", ")}${stale.length > 6 ? ", …" : ""} (delete them, or restore the fixture)`,
    ]);
}
writeFileSync(join(HERE, "run", "report.json"), JSON.stringify(report, null, 2) + "\n");
const written = report.shots.filter((s) => s.status === "written").length;
const matched = report.shots.filter((s) => s.status === "match").length;
console.log(
  `visual: ${report.shots.length} screenshots (${UPDATE ? `${written} baselines written` : `${matched} match`}), ${report.layout.length} layout checks at ${SIZES.length} sizes, ${report.acceptance.length} acceptance checks; ${failures} failure(s)`,
);
process.exit(failures ? 1 : 0);
