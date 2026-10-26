// Stage 1 reference capture: serve the original Classic UI's built output (ui-minified) statically and screenshot
// its states at the phone and desktop canvases; write a text inventory of each state for the parity table.
// Read-only toward the clone; writes PNG/JSON/TXT into classic/docs/reference/.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const req = createRequire("E:/Code/Tornado/privacy-protocol/package.json");
const { chromium } = req("playwright-core");

const ROOT = "E:/Code/Tornado/reference/ui-minified";
const OUT = "E:/Code/Tornado/privacy-protocol/classic/docs/reference";
const PORT = 5190;
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".zip": "application/zip", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".webmanifest": "application/manifest+json", ".txt": "text/plain" };

const server = http.createServer((rq, rs) => {
  const url = decodeURIComponent(rq.url.split("?")[0]);
  let file = path.join(ROOT, url);
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  if (!fs.existsSync(file)) file = path.join(ROOT, "index.html");
  const ext = path.extname(file);
  rs.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(file).pipe(rs);
});

const VIEWPORTS = [{ name: "390x844", width: 390, height: 844, mobile: true }, { name: "1440x900", width: 1440, height: 900, mobile: false }];
const NOTE_INVALID = "tornado-eth-1-1-0x" + "ab".repeat(62);
const inventory = {};

async function inv(page, state) {
  const text = await page.evaluate(() => document.body.innerText);
  const controls = await page.evaluate(() => Array.from(document.querySelectorAll("button, a, input, textarea, select, [role=tab], .tab, label.b-radio, .b-radio")).filter((e) => e.offsetParent !== null).map((e) => ({ tag: e.tagName.toLowerCase(), text: (e.innerText || e.value || e.getAttribute("placeholder") || e.getAttribute("aria-label") || "").trim().slice(0, 80), disabled: e.disabled === true, href: e.getAttribute("href") || undefined })).filter((c) => c.text));
  inventory[state] = { text, controls };
  fs.writeFileSync(path.join(OUT, `${state}.txt`), text);
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
}

async function tryStep(label, fn) {
  try { await fn(); return { label, ok: true }; } catch (e) { return { label, ok: false, error: String(e).slice(0, 160) }; }
}

(async () => {
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const log = [];
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1, isMobile: vp.mobile, hasTouch: vp.mobile, locale: "en-US", timezoneId: "UTC" });
    const page = await ctx.newPage();
    page.on("dialog", (d) => d.dismiss().catch(() => {}));
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 120)); });
    log.push(await tryStep(`${vp.name} load`, async () => { await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded", timeout: 60000 }); await page.waitForTimeout(6000); }));
    await inv(page, `${vp.name}-deposit`); await shot(page, `${vp.name}-deposit`);
    log.push(await tryStep(`${vp.name} pick 1 ETH`, async () => { const r = page.locator("text=/^1 ETH$/").first(); await r.click({ timeout: 5000 }); await page.waitForTimeout(500); }));
    log.push(await tryStep(`${vp.name} deposit button`, async () => { const b = page.locator("button:has-text('Deposit'), button:has-text('Connect')").last(); await b.click({ timeout: 5000 }); await page.waitForTimeout(2500); }));
    await inv(page, `${vp.name}-deposit-after-click`); await shot(page, `${vp.name}-deposit-after-click`);
    log.push(await tryStep(`${vp.name} close modal`, async () => { await page.keyboard.press("Escape"); await page.waitForTimeout(500); }));
    log.push(await tryStep(`${vp.name} withdraw tab`, async () => { await page.locator("a:has-text('Withdraw'), [role=tab]:has-text('Withdraw'), li:has-text('Withdraw') a").first().click({ timeout: 5000 }); await page.waitForTimeout(1500); }));
    await inv(page, `${vp.name}-withdraw`); await shot(page, `${vp.name}-withdraw`);
    log.push(await tryStep(`${vp.name} invalid note`, async () => { const f = page.locator("textarea, input[type=text]").first(); await f.fill(NOTE_INVALID, { timeout: 5000 }); await page.waitForTimeout(2500); }));
    await inv(page, `${vp.name}-withdraw-note`); await shot(page, `${vp.name}-withdraw-note`);
    log.push(await tryStep(`${vp.name} settings`, async () => { await page.locator("text=/Withdrawal settings|Settings/i").first().click({ timeout: 5000 }); await page.waitForTimeout(1500); }));
    await inv(page, `${vp.name}-withdraw-settings`); await shot(page, `${vp.name}-withdraw-settings`);
    log.push(await tryStep(`${vp.name} close settings`, async () => { await page.keyboard.press("Escape"); await page.waitForTimeout(500); }));
    log.push(await tryStep(`${vp.name} statistics tab`, async () => { await page.locator("text=/Statistics|Stats/i").first().click({ timeout: 5000 }); await page.waitForTimeout(1500); }));
    await inv(page, `${vp.name}-statistics`); await shot(page, `${vp.name}-statistics`);
    inventory[`${vp.name}-console-errors`] = errors.slice(0, 30);
    await ctx.close();
  }
  await browser.close();
  server.close();
  fs.writeFileSync(path.join(OUT, "inventory.json"), JSON.stringify({ capturedAt: "2026-10-26", source: "ui-minified 7aeae4a53f2e3f1b13f21e5ed06f42c2ac94e80a", log, inventory }, null, 2));
  console.log(JSON.stringify(log, null, 1));
  console.log("files:", fs.readdirSync(OUT).length);
})().catch((e) => { console.error(e); process.exit(1); });
