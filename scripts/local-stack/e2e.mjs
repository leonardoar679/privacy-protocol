// e2e.mjs — the end-to-end run of docs/local-run.md, driven through a real browser against the local stack (the
// Hardhat devnet as chain id 1, deploy.mjs, start-services.mjs). V5 (Privacy Wallet Web spec §2–§3, §19–§21): the
// money flow on the rebuilt screens, the viewport matrix, the pseudo-locale width pass and the leakage twin.
//   0. first launch: Welcome → the experience → Create → the phrase → Home; every route without one request off-origin
//   1. Settings → Advanced: the light client off (the devnet has no beacon chain); Settings → Connected wallet: the funding wallet connected (V7 Stage 4)
//   2. Protect: two public deposits of 500 ETH through the connected wallet's own provider (a $4.25M protected balance
//      at the mock price); V6 Stage 10: the page, the Review (a hold from $50K), the progress lines, and the deployment
//      checked before the first protect (nothing read at first launch; Advanced then shows the remembered fingerprint)
//  2b. V6 Stage 10: the document's figures in USDC — Protect 5,000 → 4,950 (50 to ProtectRouter's fee recipient), then
//      Send 2,500 → 2,470.90 to a fresh address (25.00 privacy fee + 4.10 relayer), read on the page and on chain
//   3. Send (public) $1K to a fresh address from the address book: the standard flow (a proof in the Web Worker, the
//      relayer submits, the V6 Review's tap)
//   4. Send (public) $120K: the enhanced Review (the V2–V4 screen: lint + the hold)
//   5. Swap $850K ETH → BTC (enhanced), V6 Stage 11: the quote as the amount is typed → Review Swap (the V2–V4 commit
//      Review: five lines, lint, a hold) → ONE confirmation → the order runner funds the escrow (a private withdrawal),
//      prepares the hard quote, checks the call, signs, simulates and hands it over with no second tap (a lower minimum
//      waits for the user's choice; a refused one is tried again; else the funds return) → the executor → the tracker
//   6. a reload: unlock, Home's card opens the swap's progress from the encrypted journal; nothing is funded again
//   7. Activity: every money flow has a row, never a bare "failed"
//  7b. V6 Stage 12 (spec v2.0 §7.5, §11.2): Swap 8,000 USDC → ETH into the protected balance — the quote and the Review
//      name "Your protected balance", ONE confirmation, the order pays a one-time shield receiver the wallet named and the
//      relayer watches from the hand-over; THORChain's outbound is the real router's transferOut (a 2300-gas send to the
//      receiver); the relayer deploys the receiver and shields the delivery (the tip once, the rest as the committed
//      note); the wallet finds the note and the progress ends on what was added
//  8b. V6 Stage 13 (spec v2.0 §2, §7.6–§7.7; doc §49–§50, §87): an $80,000 ETH → BTC swap is protected automatically —
//      no checkbox and no mode, the V6 Review's Protected execution checks and Hold to Confirm, ONE confirmation, the
//      steps (the band's four quarters) on /swap/steps with amounts only; the runner funds, signs and hands over the first
//      step by itself; "Return the rest" skips the steps not started
//   8. V3: the $10M protected swap on the V5 screens — a separate device registered through a virtual authenticator, five
//      more deposits, the protection line, the wizard, the campaign Review (the hold, the password fallback, the device),
//      the runner through step 1, the dashboard, the global switch, Return the rest, a reload
//   9. V5: the shell pass per viewport (VIEWPORTS, default 360x800,390x844,412x915,768x1024,1280x800,1440x900) — no horizontal
//      scroll, the controls 44 px tall, a screenshot per screen — and the same pass under ?locale=pseudo
//  9b. V6 Stage 15 (spec v2.0 §7.11, §8, §12.5, §14.3; doc §18, §74–§75, §83): the hardening in the browser — pagehide
//      locks and the unlock returns to the interrupted screen; a minute idle locks (the minutes chosen under Security);
//      a wallet disconnected mid-Protect moves nothing and the retry deposits once; a tab closed and the browser
//      restarted (a persistent profile) keep the journal; a Send whose answer is lost as the network drops waits under
//      the banner, submits nothing while offline, and finds its one transaction by nullifier once back; the proving key
//      downloaded once for the whole run (the crypto worker's cache under the pin)
//  10. V5: the leakage twin — every request body read for the phrase and the password; localStorage empty; the secure
//      store holds the two ciphertext blobs only
// Output: run/e2e/NN-step.png screenshots and run/e2e/report.json (results/ keeps a committed report).
//
//   BROWSER_CHANNEL=msedge node e2e.mjs      the system Edge or Chrome (chrome); unset: Playwright's Chromium
//   HEADED=1 node e2e.mjs                    watch it
//   VIEWPORTS=360x800,1280x800 node e2e.mjs  the shell pass on these viewports only
//   SKIP_CAMPAIGN=1 node e2e.mjs             without the $10M protected swap (section 8)
import { chromium } from "playwright";
import { encodeFunctionData, parseAbi } from "viem";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const stack = JSON.parse(readFileSync(join(HERE, "run", "stack.json"), "utf8"));
const OUT = process.argv[2] ?? join(HERE, "run", "e2e");
mkdirSync(OUT, { recursive: true });
const WALLET = "http://localhost:5173/"; // a hostname, not the IP: WebAuthn (the separate device, V3) refuses an IP origin as its RP ID
const RELAYER = "http://127.0.0.1:8790";
const API = "http://127.0.0.1:8787";
const PASSWORD = "a strong password for the local run";
const PRICE = stack.prices.ETH;
const CHANNEL = process.env.BROWSER_CHANNEL; // chrome | msedge | (unset: Playwright's Chromium)
const HEADLESS = process.env.HEADED ? false : true;
const PROOF_TIMEOUT = 420_000; // the first proof downloads the 31 MB key, then witness + proof in the worker
const VIEWPORTS = (process.env.VIEWPORTS ?? "360x800,390x844,412x915,768x1024,1280x800,1440x900").split(",").map((s) => s.trim()).filter(Boolean).map((s) => { const [w, h] = s.split("x").map(Number); return { width: w, height: h }; });
const RUN_START = Date.now();

const report = { startedAt: new Date().toISOString(), stack: { rpc: stack.rpc, core: stack.core, swapFactory: stack.swapFactory }, steps: [], checks: [], failures: [], outcome: {}, viewports: [] };
let shot = 0;
const log = (msg) => { const line = `${new Date().toISOString().slice(11, 19)} ${msg}`; console.log(line); report.steps.push(line); };
const check = (name, ok, detail = "") => { report.checks.push({ name, ok: !!ok, detail }); log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); if (!ok) report.failures.push(name); };
async function snap(page, name) { const file = `${String(++shot).padStart(2, "0")}-${name}.png`; await page.screenshot({ path: join(OUT, file), fullPage: true }); return file; }
const rpc = async (method, params = []) => { const r = await fetch(stack.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }); const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result; };
const balanceEth = async (address) => Number(BigInt(await rpc("eth_getBalance", [address, "latest"]))) / 1e18;
/** V6 Stage 10: a USDC balance in base units (6 decimals), through eth_call balanceOf on the stack's mock USDC */
const balanceUsdc = async (address) => BigInt(await rpc("eth_call", [{ to: stack.usdc.token, data: "0x70a08231" + address.slice(2).toLowerCase().padStart(64, "0") }, "latest"]));
/** the number a fee line shows: "Recipient receives2,470.90 USDC" → 2470.9 */
const figure = (s) => Number((/([0-9][0-9,]*(?:\.[0-9]+)?)\s*(?:ETH|USDC)/.exec(s ?? "")?.[1] ?? "NaN").replace(/,/g, ""));
const usd = (n) => "$" + Math.round(n).toLocaleString("en-US");
const usdRe = (n, prefix = "") => new RegExp(prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\$" + Math.round(n).toLocaleString("en-US").replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(\\.\\d{1,2})?(?!\\d)");
const text = async (locator) => ((await locator.textContent()) ?? "").replace(/\s+/g, " ");
/** V6 Stage 12: the relayer's shield jobs (its journal file: there is no list endpoint) created by this run */
function shieldJobsOfThisRun() {
  const file = join(HERE, "run", "relayer-journal", "shield-jobs.json");
  if (!existsSync(file)) return [];
  try { return JSON.parse(readFileSync(file, "utf8")).filter((j) => Number(j.createdAt ?? 0) >= RUN_START - 60_000); } catch { return []; }
}
/** polls `f` every `ms` until it returns something truthy or `timeout` passes */
async function until(page, f, timeout, ms = 2000) {
  for (const end = Date.now() + timeout; Date.now() < end; await page.waitForTimeout(ms)) { const v = await f(); if (v) return v; }
  return null;
}
/** the relayer's swap jobs created by this run (its journal keeps earlier runs' jobs) */
async function jobsOfThisRun() {
  const jobs = await (await fetch(`${RELAYER}/swap`, { headers: { authorization: "Bearer local-stack" } })).json().catch(() => null); // the operator token start-services.mjs sets
  const list = Array.isArray(jobs) ? jobs : Array.isArray(jobs?.jobs) ? jobs.jobs : Object.values(jobs ?? {});
  return list.filter((j) => j && Number(j.createdAt ?? j.updatedAt ?? 0) >= RUN_START - 60_000).sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0));
}

// --- helpers over the page -------------------------------------------------------------------------------------------
const button = (page, name) => page.getByRole("button", { name, exact: true });
const byId = (page, id) => page.getByTestId(id);
async function clickButton(page, name, opts = {}) { const b = button(page, name); await b.first().waitFor({ state: "visible", timeout: opts.timeout ?? 30_000 }); await b.first().click(); }
async function clickId(page, id, opts = {}) { const b = byId(page, id); await b.first().waitFor({ state: "visible", timeout: opts.timeout ?? 30_000 }); await b.first().click(); }
async function textAppears(page, t, timeout = 30_000) { await page.getByText(t, { exact: false }).first().waitFor({ state: "visible", timeout }); }
async function fillId(page, id, value) { const i = byId(page, id); await i.waitFor({ state: "visible", timeout: 30_000 }); await i.fill(value); }
/** The V6 Swap screen's quote, as a person gets one: it is fetched as the amount is typed; while the live providers
 *  have no route ("No route available right now" — they come and go, V6 Stage 16's run met it), type the amount again
 *  every 30 s, until `timeoutMs`. */
async function waitQuote(page, amount, timeoutMs = 180_000) {
  const end = Date.now() + timeoutMs;
  let retries = 0;
  for (;;) {
    const left = end - Date.now();
    const shown = await byId(page, "swap-quote")
      .waitFor({ timeout: Math.max(1, Math.min(30_000, left)) })
      .then(() => true, () => false);
    if (shown) {
      if (retries) log(`a route was quoted after ${retries} retry(ies)`);
      return;
    }
    if (Date.now() >= end) throw new Error(`no quote within ${timeoutMs / 1000} s (${retries} retries after "No route available right now")`);
    if (await byId(page, "swap-no-route").count()) {
      retries++;
      log(`no route right now (the live providers): typing the amount again (${retries})`);
      await fillId(page, "amount-input", "");
      await fillId(page, "amount-input", amount);
    }
  }
}
/** the navigation (four links) */
async function nav(page, name) { await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name, exact: true }).click(); }
async function acknowledgeAll(page) { // the privacy lint's block items, the destination check, the single quote: acknowledged before a high-value confirmation
  let n = 0;
  for (let i = 0; i < 12; i++) {
    const b = page.getByRole("button", { name: /^(I understand|I checked every group|I accept the single quote)$/ });
    if ((await b.count()) === 0) break;
    await b.first().click(); n++;
    await page.waitForTimeout(150);
  }
  return n;
}
async function hold(page, ms = 2400) { // the hold to confirm (spec §3.9): a pointer hold of HOLD_MS (1.5 s), never a tap
  const b = byId(page, "hold-to-confirm");
  await b.waitFor({ state: "visible", timeout: 30_000 });
  for (let i = 0; i < 50 && (await b.isDisabled()); i++) await page.waitForTimeout(200);
  if (await b.isDisabled()) throw new Error(`the hold is still disabled: ${await b.getAttribute("title")}`);
  await b.evaluate((el) => el.scrollIntoView({ block: "center", inline: "nearest" }));
  await page.waitForTimeout(150);
  // V6 Stage 15: the real pointer rests on the button, as a person's does while holding. The pointer events below are
  // synthetic, so they cannot capture the pointer; when the real one sat elsewhere (a lint acknowledgment just above),
  // the scroll moved the button from under it, and its trusted pointerleave cancelled the hold at once.
  const box = await b.boundingBox();
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // the element's own pointer events are kept, for a hold that does not fill
  await b.evaluate((el) => {
    el.__holdEvents = [];
    for (const type of ["pointerdown", "pointerup", "pointerleave", "pointercancel"]) el.addEventListener(type, (e) => el.__holdEvents.push(`${type}${e.isTrusted ? " (trusted)" : ""}`));
  });
  // the pointer events dispatched on the button itself (as the unit tests do): no overlay, no emulated long-press can cancel them
  await b.dispatchEvent("pointerdown");
  // V6 Stage 15: held until the ring is full or the screen moved on, as a person releases after the ring completes — a
  // release at a fixed time raced the hold's own timer whenever the page was busy past HOLD_MS (the input event runs
  // before the overdue timer, and the hold is cancelled)
  const samples = [];
  let filled = false;
  for (const end = Date.now() + Math.max(ms, 1500) + 15_000; Date.now() < end; await page.waitForTimeout(100)) {
    if ((await b.count()) === 0) { filled = true; break; }
    const ring = await b.locator(".ds-hold-ring").first().getAttribute("data-progress", { timeout: 500 }).catch(() => null);
    samples.push(ring);
    if (ring === "1.00") { filled = true; break; }
  }
  await b.dispatchEvent("pointerup", {}, { timeout: 2_000 }).catch(() => {}); // the screen may already have moved on
  if (!filled) {
    const seen = await b.evaluate((el) => el.__holdEvents ?? []).catch(() => ["(the button is gone)"]);
    log(`the hold did not fill: ring progress ${samples.filter((x, i) => i % 10 === 0).join(" ")} (url ${new URL(page.url()).pathname}); the button's pointer events: ${seen.join(", ")}`);
  }
}
/** the Review's confirmation: a hold from the protected band, a tap below it (V6 Stage 10: the V6 Review's tap or the V2–V4 one) */
/**
 * A payee's figure as the page shows it, against what arrived (audit round 2, c7b): rounded down, so never more than arrived,
 * and less by under one display unit (six decimals here). Nearest rounding had shown 0.195624 for 0.195623999…
 */
function roundedDown(got, shown) {
  const d = got - shown;
  return d > -1e-9 && d < 1e-6 + 1e-9;
}
async function confirmReview(page) {
  if (await byId(page, "hold-to-confirm").count()) return hold(page);
  const tap = (await byId(page, "review-confirm").count()) ? byId(page, "review-confirm") : byId(page, "confirm-tap");
  for (let i = 0; i < 50 && (await tap.isDisabled()); i++) await page.waitForTimeout(200);
  await tap.click();
}
/** V6 Stage 10: the Review a flow opened — the V6 screen below `enhanced`, the V2–V4 one from it */
async function waitReview(page) {
  return firstOf(page, { v6: byId(page, "review-view"), v4: byId(page, "review") }, 30_000);
}
/** V6 Stage 10: an asset chosen in a screen's asset selector (a sheet) */
async function chooseAsset(page, openId, optionId, symbol) {
  await clickId(page, openId);
  const option = byId(page, optionId).filter({ hasText: symbol });
  await option.first().waitFor({ state: "visible", timeout: 30_000 });
  await option.first().click();
}
/** waits for the first of several locators; returns its key */
async function firstOf(page, candidates, timeout) {
  return Promise.any(Object.entries(candidates).map(([key, loc]) => loc.first().waitFor({ state: "visible", timeout }).then(() => key)));
}
/**
 * An order stopped for a reason the run does not answer: neither a reconcile under way nor a refused hard quote it can
 * try again (a V6 follow-up of 2026-10-15; the run waited out its timeouts and named nothing, or ended on an
 * AggregateError). The progress view carries the record's state and its reason's code.
 */
const stoppedOrder = (page) =>
  page.locator(
    '[data-testid="operation-progress"][data-state="RECOVERY_REQUIRED"]:not([data-code="reconcile"]):not([data-code="execution_unavailable"]), [data-testid="operation-progress"][data-state="CANCELLED"], [data-testid="operation-progress"][data-state="FAILED"]',
  );
/** Where an order's progress stands, in a line: its state, its code and the words the user reads. */
async function orderWords(page) {
  const at = page.locator('[data-testid="operation-progress"]').first();
  const state = (await at.count()) ? await at.getAttribute("data-state").catch(() => null) : null;
  const code = (await at.count()) ? await at.getAttribute("data-code").catch(() => null) : null;
  const err = page.locator('[data-testid="operation-progress-error"]').first();
  const why = (await err.count()) ? (await text(err)).slice(0, 300) : "";
  return `${state ?? `no progress view at ${page.url().slice(-60)}`}${code ? ` (${code})` : ""}: ${why || "no reason shown"}`;
}
/** V6 Stage 15: a persistent profile, so the run can close the browser and start it again on the same storage (doc §74) */
const PROFILE = join(OUT, "profile");
async function launchContext() {
  // Chrome 154's new headless mode does not come up under Playwright 1.64 here; its old headless shell does. The origin stays
  // localhost (WebAuthn's RP ID), but the browser connects to 127.0.0.1, where the stack listens: another dev server on
  // [::1]:5173 had answered the run instead (2026-10-16)
  const args = [...(CHANNEL === "chrome" && HEADLESS ? ["--headless=old"] : []), "--host-resolver-rules=MAP localhost 127.0.0.1"];
  return chromium.launchPersistentContext(PROFILE, { headless: HEADLESS, timeout: 30_000, args, ...(CHANNEL ? { channel: CHANNEL } : {}), viewport: { width: 430, height: 932 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
}
/** unlock after a reload */
async function unlock(page) {
  await byId(page, "lock-screen").waitFor({ timeout: 120_000 });
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await clickId(page, "unlock");
  await byId(page, "home").waitFor({ timeout: 60_000 });
}
/** V6 (spec v2.0 §3, §11.1): what a 500 ETH protect leaves in the vault — ProtectRouter keeps 1 % for its fee recipient */
const NET_PROTECT = stackHasRouter() ? 495 : 500;
function stackHasRouter() { return !!stack.protectRouter; }
/** the Protect page (V6 Stage 10: /protect), the funding wallet connected, `symbol` chosen and `amount` typed */
async function openProtect(page, amount, symbol) {
  await nav(page, "Home");
  await byId(page, "home").waitFor({ timeout: 30_000 });
  await clickId(page, "protect-cta"); // Home's "Protect your assets" card, always there (spec v2.0 §7.1)
  await byId(page, "protect-view").waitFor({ timeout: 30_000 });
  if (await byId(page, "protect-connect").count()) { await clickId(page, "protect-connect"); await byId(page, "protect-connect").waitFor({ state: "detached", timeout: 30_000 }); }
  if (symbol !== "ETH") await chooseAsset(page, "protect-from-asset", "protect-asset-selector-option", symbol);
  await fillId(page, "amount-input", String(amount));
  await byId(page, "protect-receive").waitFor({ timeout: 30_000 });
}
/** Protect: `amount` ETH through the connected wallet — the page, the Review (a hold from $50K), the progress —; waits until the vault holds it and the screen reports what was added */
async function protect(page, amount, expectVault) {
  await openProtect(page, amount, "ETH");
  await clickId(page, "protect-review");
  await waitReview(page);
  await confirmReview(page);
  for (let t = 0; t < 180 && (await balanceEth(stack.ethVault)) < expectVault - 1e-9; t++) await page.waitForTimeout(1000); // the deposit mined
  await byId(page, "protect-done").waitFor({ timeout: 180_000 }); // the wallet saw the receipt and journaled the note
}
/** Send (public) `amount` of `symbol` to the fresh address of this wallet, one tap away in the address book (V6 Stage 10, spec v2.0 §7.4); returns the recipient and "Recipient receives" */
async function sendPublic(page, amount, symbol = "ETH") {
  await nav(page, "Home");
  await clickButton(page, "Send");
  await byId(page, "send-view").waitFor({ timeout: 30_000 });
  if (symbol !== "ETH") await chooseAsset(page, "send-asset-change", "send-asset-selector-option", symbol);
  await byId(page, "address-book-entry").first().click(); // "A fresh address of this wallet"
  const recipient = await byId(page, "address-input").inputValue();
  await fillId(page, "amount-input", String(amount));
  await byId(page, "send-receive").waitFor({ timeout: 60_000 });
  // the lines settle once the relayer's terms are read: "Recipient receives" drops below the amount typed (exact input)
  let receive = NaN;
  for (let i = 0; i < 60; i++) {
    receive = figure(await text(byId(page, "send-receive")));
    if (receive > 0 && receive < amount) break;
    await page.waitForTimeout(250);
  }
  return { recipient, receive };
}

// --- V3: the protected swap on the V5 screens -----------------------------------------------------------------------
/** The amounts the progress panel shows, in ETH (its lines read "<n> ETH (≈ $x)"). */
async function panelAmounts(page) {
  const out = {};
  for (const key of ["completed", "in-flight", "protected", "remaining"]) {
    const t = await text(page.locator(`[data-amount="${key}"]`));
    out[key] = Number((t.match(/^([0-9.]+) ETH/) ?? [])[1] ?? NaN);
  }
  return out;
}
async function campaignRun(page) {
  const CAMPAIGN_ETH = Math.ceil(10_000_000 / PRICE); // $10M at the mock price: institutional
  // the separate device (spec §14): a virtual cross-platform authenticator through CDP stands in for a security key
  let deviceOk = false;
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "usb", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    deviceOk = true;
  } catch (e) { log(`no virtual authenticator (${e.message}); the institutional confirmation cannot be given here`); }
  // Settings: the advanced experience (the dashboard and the per-step lines), then Advanced → Protected execution (V7 Stage 4: one Settings page)
  await nav(page, "More"); await clickId(page, "more-settings"); await byId(page, "settings").waitFor();
  const experience = byId(page, "experience-toggle");
  if (!(await experience.isChecked())) await experience.check();
  await clickId(page, "settings-advanced");
  await byId(page, "protected-execution").waitFor();
  await byId(page, "protected-execution").scrollIntoViewIfNeeded();
  await snap(page, "advanced-protected-execution");
  if (deviceOk) {
    await clickId(page, "register-second-device");
    await textAppears(page, "Registered. Operations at the institutional size", 60_000);
  }
  const deviceLine = await text(byId(page, "protected-execution"));
  check("Settings → Advanced → Protected execution: the four modes, the exposure fraction, the switch; the separate device registered (a virtual cross-platform authenticator)", /Balanced/.test(deviceLine) && /Maximum safety/.test(deviceLine) && /Best execution/.test(deviceLine) && (!deviceOk || /registered/.test(deviceLine)), deviceLine.slice(0, 200));
  // five more deposits: the protected balance reaches the order
  const before = await balanceEth(stack.ethVault);
  for (const i of [1, 2, 3, 4, 5]) {
    await protect(page, 500, before + NET_PROTECT * i);
    log(`campaign deposit ${i}: 500 ETH protected`);
  }
  // the quote on the V6 page; at this size the service plans a protected execution, so Review Swap continues on the
  // protected screen (/swap/protected: V5's until Stage 13) with the amount, the asset and the target handed over
  await nav(page, "Swap");
  await byId(page, "swap-view").waitFor({ timeout: 30_000 });
  await fillId(page, "amount-input", String(CAMPAIGN_ETH));
  await byId(page, "swap-quote").waitFor({ timeout: 240_000 });
  await clickId(page, "swap-review");
  await page.waitForURL(/\/swap\/protected$/, { timeout: 30_000 });
  check("V6 Stage 11: a protected execution continues on the protected screen with the order handed over", true, page.url().slice(-40));
  const swap = byId(page, "swap");
  await swap.waitFor({ timeout: 30_000 });
  check("the amount came over", (await byId(page, "swap-amount-input").inputValue()) === String(CAMPAIGN_ETH), await byId(page, "swap-amount-input").inputValue());
  await page.getByText(usdRe(CAMPAIGN_ETH * PRICE)).first().waitFor({ timeout: 30_000 });
  let lineText = "";
  for (let attempt = 1; attempt <= 3 && !lineText; attempt++) {
    await clickId(page, "swap-quote");
    await byId(page, "quote").waitFor({ timeout: 240_000 });
    lineText = (await byId(page, "protection-line").count()) ? await text(byId(page, "protection-line")) : "";
    if (!lineText) { log(`quote attempt ${attempt}: no protection line — ${(await text(byId(page, "quote"))).slice(0, 200)}`); await page.waitForTimeout(5000); }
  }
  check("the protection line under the quote: steps, one at a time, at most $X at risk, the duration", /Protected execution: about \d+ steps of ≈ \$[\d.,]+[KM]? · one at a time · at most \$[\d.,]+[KM]? at risk · about .+/.test(lineText), lineText);
  // a sentence in a badge (never wrapping since V6 Stage 5) overflowed here once: the phone zoomed out and clicks missed
  const campaignLayout = await layoutProbe(page);
  check("the institutional quote fits the phone: no horizontal scroll", campaignLayout.scrollWidth <= page.viewportSize().width, `${campaignLayout.scrollWidth} px wide on a ${page.viewportSize().width} px screen${campaignLayout.wide.length ? `: ${campaignLayout.wide.join(", ")}` : ""}`);
  await snap(page, "campaign-quote");
  await acknowledgeAll(page);
  await clickId(page, "swap-review");
  // the wizard
  const wizard = byId(page, "campaign-wizard");
  await wizard.waitFor({ timeout: 30_000 });
  const risk = await text(byId(page, "wizard-risk"));
  await snap(page, "wizard-risk");
  await clickId(page, "wizard-next");
  const privacy = await text(byId(page, "wizard-privacy"));
  await acknowledgeAll(page);
  await snap(page, "wizard-privacy");
  await clickId(page, "wizard-next");
  const dest = await text(byId(page, "wizard-destination"));
  await snap(page, "wizard-destination");
  check("the wizard: risk analysis (class, security, steps, at most at risk, ELPF, concentration) → privacy analysis (what a protected execution reveals, the lint) → destination check (a fresh address per step)", /class/i.test(risk) && /steps/i.test(risk) && /reveal|privacy/i.test(privacy) && /fresh|destination/i.test(dest), `${risk.slice(0, 120)} | ${privacy.slice(0, 80)} | ${dest.slice(0, 80)}`);
  await clickId(page, "wizard-next");
  const review = byId(page, "review");
  await review.waitFor({ timeout: 30_000 });
  const reviewText = await text(review);
  const loss = (await byId(page, "maximum-loss").count()) ? await text(byId(page, "maximum-loss")) : "";
  const verdict = (await byId(page, "verdict").count()) ? await text(byId(page, "verdict")) : "";
  check("the campaign Review: the maximum-loss model, the paired SECURITY + PRIVACY verdict, the Exposure and Security lines, the review hold, a hold to confirm", (await review.getAttribute("data-moment")) === "campaign" && loss !== "" && /SECURITY|Security/.test(verdict) && /PRIVACY|Privacy/.test(verdict) && /Exposure/.test(reviewText) && (await byId(page, "hold-to-confirm").count()) === 1, `${loss.slice(0, 120)} | ${verdict.slice(0, 120)}`);
  await acknowledgeAll(page);
  await clickButton(page, "Advanced details").catch(() => {});
  await snap(page, "campaign-review");
  await hold(page);
  // the second factor: no platform authenticator registered → the password; then the separate device (automatic presence)
  const prompted = await byId(page, "second-factor-password").waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
  if (!prompted) { log("the hold did not take; once more"); await hold(page); await byId(page, "second-factor-password").waitFor({ timeout: 30_000 }); }
  await page.locator('[data-testid="second-factor-password"] input').fill(PASSWORD);
  await clickButton(page, "Confirm with the password");
  const progress = byId(page, "campaign-progress");
  const started = await Promise.any([progress.waitFor({ timeout: 120_000 }).then(() => true), byId(page, "second-device-error").waitFor({ timeout: 120_000 }).then(() => false)]).catch(() => false);
  if (!started) { check("the institutional confirmation: the separate device after the password", false, (await byId(page, "second-device-error").textContent().catch(() => "")) ?? ""); return; }
  let step = (await byId(page, "campaign-step").getAttribute("data-step")) ?? "";
  let amounts = await panelAmounts(page);
  check(`the campaign is journaled and shown: step ${step}, ✓ Protected, Completed 0, In progress 0, the rest protected`, step === "1" && (await text(byId(page, "campaign-status"))) === "✓ Protected" && amounts.completed === 0 && amounts["in-flight"] === 0 && amounts.protected > 0, JSON.stringify(amounts));
  await snap(page, "campaign-started");
  // the runner (the App-level scheduler, this tab open): the review hold (1 min), then step 1 through commit → fund → sign → hand-over
  let tranche1 = "", reroutes = 0;
  for (let i = 0; i < 150 && !/executing|waiting for finality|settled/.test(tranche1); i++) {
    await page.waitForTimeout(4000);
    if ((await progress.getAttribute("data-state")) === "rerouting") { // the competition at the step's size may choose another provider: a route change is reviewed (spec §8)
      reroutes++;
      const note = await text(byId(page, "campaign-reroute"));
      log(`reroute ${reroutes}: ${note.slice(0, 120)}`);
      await clickId(page, "campaign-reroute-button");
      await review.waitFor({ timeout: 30_000 });
      check("a route change at the step's size goes through the reroute Review (the same bounds, the new route's class and gate, a hold, the second factor and the separate device again)", (await review.getAttribute("data-moment")) === "reroute" && (await byId(page, "hold-to-confirm").count()) === 1, await text(review).then((t) => t.slice(0, 160)));
      await snap(page, "campaign-reroute-review");
      await acknowledgeAll(page);
      await hold(page);
      await byId(page, "second-factor-password").waitFor({ timeout: 30_000 });
      await page.locator('[data-testid="second-factor-password"] input').fill(PASSWORD);
      await clickButton(page, "Confirm with the password");
      await progress.waitFor({ timeout: 120_000 });
      continue;
    }
    // a step's hard quote below the approved minimum pauses the campaign for consent (spec §14 applied to a step): Resume accepts it, as a user would
    const resume = page.getByRole("button", { name: "Resume", exact: true });
    if ((await resume.count()) && (await progress.getAttribute("data-state")) !== "rerouting") {
      const why = (await text(progress)).match(/Paused — ([^.]+)/)?.[1] ?? "";
      if (!report.outcome.stepConsent) { report.outcome.stepConsent = why; check("a step's hard quote below the approved minimum pauses the campaign for consent; nothing is signed until Resume", /Price changed/.test(why) || /price/i.test(why), why.slice(0, 160)); await snap(page, "campaign-price-changed"); }
      log(`paused: ${why.slice(0, 120)} — resuming`);
      await resume.first().click();
      await page.waitForTimeout(2000);
      continue;
    }
    tranche1 = (await page.locator('[data-tranche="0"]').count()) ? await text(page.locator('[data-tranche="0"]')) : "";
    if (i % 15 === 14) log(`step 1: ${tranche1 || "(not visible)"} · ${await text(byId(page, "campaign-status"))}`);
  }
  report.outcome.reroutes = reroutes;
  amounts = await panelAmounts(page);
  const job = (await jobsOfThisRun()).find((j) => j.executionTx && Number(j.updatedAt ?? 0) > RUN_START);
  const receipt = job ? await rpc("eth_getTransactionReceipt", [job.executionTx]) : null;
  check("step 1 funded, signed and handed over by the runner: the executor's deployAndExecute is mined, the one-time escrow is empty", /executing|waiting for finality|settled/.test(tranche1) && receipt?.status === "0x1" && (job ? (await balanceEth(job.escrow)) === 0 : false), `${tranche1.slice(0, 120)} | ${job?.executionTx ?? "no job"}`);
  const tranche2 = (await page.locator('[data-tranche="1"]').count()) ? await text(page.locator('[data-tranche="1"]')) : "";
  check("step 2 waits while step 1 is unsettled: In progress = one step ≤ the cap, Completed 0, Protected = the rest; ● Processing", /waiting/.test(tranche2) && amounts.completed === 0 && amounts["in-flight"] > 0, `${tranche2.slice(0, 100)} | ${JSON.stringify(amounts)}`);
  const dashboard = (await byId(page, "exposure-dashboard").count()) ? await text(byId(page, "exposure-dashboard")) : "";
  check("the exposure dashboard (Advanced): order, in flight, maximum allowed, provider exposure, the per-step table, ELPF", /Maximum allowed/.test(dashboard) && /Provider exposure/.test(dashboard) && /Expected/.test(dashboard), dashboard.slice(0, 200));
  await snap(page, "campaign-executing");
  // the global switch: every campaign's automation pauses; the executed step is still tracked (V6: the switch and the
  // campaign line are the operation's detail, no longer Home's — spec v2.0 §7.1)
  await nav(page, "Activity");
  await page.locator('[data-testid^="activity-row-campaign:"]').first().click();
  await byId(page, "campaign-line").waitFor({ timeout: 30_000 });
  await byId(page, "pause-large-operations").first().check();
  let detailLine = "";
  for (let i = 0; i < 30 && !/⚠ Review/.test(detailLine); i++) { await page.waitForTimeout(2000); detailLine = await text(byId(page, "campaign-line")); }
  check("Pause large operations (the operation's detail): the campaign pauses on the next tick and the detail says ⚠ Review", /⚠ Review/.test(detailLine), detailLine.slice(0, 160));
  await snap(page, "campaign-paused-by-switch");
  await byId(page, "pause-large-operations").first().uncheck();
  // Return the rest: the planned steps are skipped; the executed step finishes on its own
  await nav(page, "Swap");
  await byId(page, "protected-swaps").waitFor({ timeout: 30_000 });
  await byId(page, "protected-swaps").getByRole("button").first().click();
  await progress.waitFor({ timeout: 30_000 });
  await clickId(page, "campaign-cancel-button");
  let state = "";
  for (let i = 0; i < 20 && state !== "winding-down"; i++) { await page.waitForTimeout(500); state = (await progress.getAttribute("data-state")) ?? ""; }
  const skipped = await page.locator('[data-tranche-state="skipped"]').count();
  check("Return the rest: the campaign winds down, the planned steps are skipped, the executed step is tracked until it settles", state === "winding-down" && skipped >= 1, `${state}, ${skipped} skipped`);
  await snap(page, "campaign-returning");
  // a reload: the campaign comes back from the journal
  await page.reload({ waitUntil: "load" });
  await unlock(page);
  await nav(page, "Swap");
  await byId(page, "protected-swaps").waitFor({ timeout: 60_000 });
  await byId(page, "protected-swaps").getByRole("button").first().click();
  await progress.waitFor({ timeout: 30_000 });
  step = (await byId(page, "campaign-step").getAttribute("data-step")) ?? "";
  check("after a reload and unlock the campaign, its steps and its state come back from the encrypted journal", step === "1" && (await progress.getAttribute("data-state")) === "winding-down", `step ${step}, ${await progress.getAttribute("data-state")}`);
  await snap(page, "campaign-after-reload");
  await nav(page, "Activity");
  await byId(page, "activity").waitFor();
  const activity = await text(byId(page, "activity"));
  // V6 (spec v2.0 §7.8): the protected execution's row reads like any swap — "ETH → BTC", the USD value confirmed at its
  // Review, one status word; its steps are rows of their own under Advanced only
  const campaignRows = page.locator('[data-testid^="activity-row-campaign:"]');
  const campaignRow = (await campaignRows.count()) === 1 ? await text(campaignRows.first()) : "";
  check("Activity: one row for the protected swap — ETH → BTC at the value confirmed at its Review (its steps under Advanced) — never a bare failed", /ETH → BTC/.test(campaignRow) && /\$[\d,]+\.\d\d/.test(campaignRow) && !/\bfailed\b/i.test(activity), `${campaignRow || "no single campaign row"} | ${activity.slice(0, 160)}`);
  await snap(page, "campaign-activity");
}

// --- V5: the viewport matrix -------------------------------------------------------------------------------------------
/** The shell screens, each reached by its route (the wallet is unlocked and funded by now). */
const SHELL_SCREENS = [
  { route: "", id: "home", name: "home" },
  { route: "protect", id: "protect-view", name: "protect" },
  { route: "send", id: "send-view", name: "send" },
  { route: "swap", id: "swap-view", name: "swap" },
  { route: "activity", id: "activity", name: "activity" },
  { route: "more", id: "more", name: "more" },
  // V7 Stage 4 (spec v3.0 §2): the Privacy Center and one Settings page at their own paths
  { route: "privacy", id: "privacy-center", name: "privacy-center" },
  { route: "settings", id: "settings", name: "settings" },
];
/** No horizontal scroll; every visible control of the design system at least 44 px tall. */
async function layoutProbe(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const short = [];
    for (const el of document.querySelectorAll("button.ds-btn, a.ds-nav-item, button.ds-list-row, button.ds-icon-btn, input.ds-input, input.ds-amount-input, button.ds-collapsible-toggle")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue; // hidden
      if (r.height < 44 - 0.5) short.push(`${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]}:${Math.round(r.height)}px${el.textContent ? ` "${el.textContent.trim().slice(0, 24)}"` : ""}`);
    }
    // the elements that reach past the viewport, widest first (what an overflow is made of)
    // (a fixed container stretches to the layout viewport on mobile Chrome once anything overflows: it and its children are left out)
    const stretched = (el) => { for (let e = el; e && e !== document.body; e = e.parentElement) { if (getComputedStyle(e).position === "fixed") return true; } return false; };
    const wide = [...document.querySelectorAll("body *")].filter((el) => !stretched(el)).map((el) => ({ el, r: el.getBoundingClientRect() })).filter(({ r }) => r.width > 0 && r.right > doc.clientWidth + 1).sort((a, b) => b.r.right - a.r.right).slice(0, 8).map(({ el, r }) => `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]}${el.getAttribute("data-testid") ? `[${el.getAttribute("data-testid")}]` : ""}:${Math.round(r.right)}px${el.children.length === 0 && el.textContent ? ` "${el.textContent.trim().slice(0, 30)}"` : ""}`);
    return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, short, wide };
  });
}
async function shellPass(page, viewport, locale) {
  await page.setViewportSize(viewport);
  const tag = `${viewport.width}x${viewport.height}${locale ? `-${locale}` : ""}`;
  const result = { viewport: tag, screens: [] };
  await page.goto(`${WALLET}${locale ? `?locale=${locale}` : ""}`, { waitUntil: "load" });
  // the app renders a splash while the store hydrates: wait for the lock screen or Home before deciding
  const landed = await firstOf(page, { home: byId(page, "home"), lock: byId(page, "lock-screen") }, 120_000);
  if (landed === "lock") await unlock(page);
  await byId(page, "home").waitFor({ timeout: 60_000 });
  for (const s of SHELL_SCREENS) {
    await page.evaluate((path) => { window.history.pushState(null, "", path); window.dispatchEvent(new PopStateEvent("popstate")); }, `/${s.route}`);
    await byId(page, s.id).waitFor({ timeout: 60_000 });
    await page.waitForTimeout(250);
    const probe = await layoutProbe(page);
    const ok = probe.scrollWidth <= probe.clientWidth + 1;
    result.screens.push({ name: s.name, ok, short: probe.short, scrollWidth: probe.scrollWidth, clientWidth: probe.clientWidth, shot: await snap(page, `shell-${tag}-${s.name}`) });
    check(`${tag} ${s.name}: no horizontal scroll`, ok, ok ? `${probe.scrollWidth} ≤ ${probe.clientWidth}` : `${probe.scrollWidth} > ${probe.clientWidth}: ${probe.wide.join(", ")}`);
    check(`${tag} ${s.name}: the controls are 44 px tall`, probe.short.length === 0, probe.short.slice(0, 6).join(", "));
  }
  if (locale) { // the pseudo-locale is on: the words are accented and longer
    const home = await text(byId(page, "more").or(byId(page, "settings")).first()).catch(() => "");
    check(`${tag}: the pseudo-locale renders (accented, bracketed words)`, /\[.*[áéíóúÞŠŽÇ].*\]/.test(home), home.slice(0, 80));
  }
  report.viewports.push(result);
}

// --- the run ------------------------------------------------------------------------------------------------------------
rmSync(PROFILE, { recursive: true, force: true }); // every run starts on a fresh profile
// the devnet keeps every earlier run's spending: the funding wallet is topped up to 10,000 ETH when a run could exhaust it
// (two 500 ETH protects, the sends and the swaps spend about 1,100 ETH; a full run's campaign more)
{
  const before = await balanceEth(stack.funding);
  if (before < 5_000) {
    await rpc("hardhat_setBalance", [stack.funding, "0x" + (10_000n * 10n ** 18n).toString(16)]);
    log(`the funding wallet topped up: ${before.toFixed(2)} → ${await balanceEth(stack.funding)} ETH (devnet)`);
  }
}
const requests = []; // every request the page makes, with the phase it happened in and its body (the leakage twin)
let phase = "first-launch";
/** The injected funding wallet: an EIP-1193 provider over one of the devnet's unlocked accounts (what MetaMask would be
 *  here). V6 Stage 15: `window.__allowSends = n` lets n more transactions through, then the wallet answers as disconnected (4900). */
function injectedWallet({ rpcUrl, account }) {
  let id = 0;
  const call = async (method, params) => {
    const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params ?? [] }) });
    const j = await r.json();
    if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; throw e; }
    return j.result;
  };
  window.ethereum = {
    isLocalStackWallet: true,
    request: async ({ method, params }) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [account];
      if (method === "eth_chainId") return "0x1";
      if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
      if (method === "eth_sendTransaction") {
        if (typeof window.__allowSends === "number") {
          if (window.__allowSends <= 0) { const e = new Error("The wallet is disconnected"); e.code = 4900; throw e; }
          window.__allowSends--;
        }
        return call("eth_sendTransaction", [{ ...params[0], from: account }]);
      }
      return call(method, params);
    },
    on() { return this; }, removeListener() { return this; },
  };
}
/** A context's wallet and request log (again after a restart). */
async function prepare(ctx) {
  await ctx.addInitScript(injectedWallet, { rpcUrl: stack.rpc, account: stack.funding });
  ctx.on("request", (r) => requests.push({ phase, url: r.url(), method: r.method(), body: r.postData() ?? null }));
}
/** A page's error log. */
function watch(pg) {
  pg.on("pageerror", (e) => log(`page error: ${e.message}`));
  pg.on("console", (m) => { if (m.type() === "error") log(`console error: ${m.text().slice(0, 200)}`); });
  // a 4xx/5xx answer is what Chrome prints as "Failed to load resource": name the request behind it (the path only)
  pg.on("response", (r) => { if (r.status() >= 400) log(`http ${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`); });
  pg.on("requestfailed", (r) => { const u = new URL(r.url()); log(`request failed ${r.method()} ${u.host}${u.pathname}: ${r.failure()?.errorText ?? "?"}`); });
  return pg;
}
let context = await launchContext();
log(`browser ${context.browser()?.version() ?? "(a persistent profile)"} (${CHANNEL ?? "playwright chromium"}, ${HEADLESS ? "headless" : "headed"})`);
await prepare(context);
let page = watch(context.pages()[0] ?? (await context.newPage()));
let phrase = "";

try {
  // the relayer runs for the swap service's key (a V6 follow-up of 2026-10-16): its /info lists the API's address and the
  // deployment's swap factory, and the API's status reads it so
  const vstatus = await (await fetch(`${API}/v1/status`)).json().catch(() => null);
  const vinfo = await (await fetch(`${RELAYER}/info`)).json().catch(() => null);
  check(
    "the relayer runs for the swap service's key: its /info lists the API's address and the swap factory, and the API's status says so",
    !!vstatus?.deployment?.voucher && Array.isArray(vinfo?.vouchers) && vinfo.vouchers.includes(String(vstatus.deployment.voucher).toLowerCase()) && vstatus.deployment.relayerAcceptsVoucher === true && String(vinfo?.swapFactory).toLowerCase() === String(stack.swapFactory).toLowerCase(),
    `${vstatus?.deployment?.voucher} in ${JSON.stringify(vinfo?.vouchers)}, swapFactory ${vinfo?.swapFactory}, relayerAcceptsVoucher ${vstatus?.deployment?.relayerAcceptsVoucher}`,
  );

  // 0. first launch ----------------------------------------------------------------------------------------------------
  await page.goto(WALLET, { waitUntil: "load", timeout: 180_000 });
  await byId(page, "welcome").waitFor({ timeout: 120_000 });
  log("welcome shown");
  await snap(page, "welcome");
  check("the welcome says the plan's words", (await text(byId(page, "welcome"))).includes("Protect your financial privacy"));
  await clickId(page, "welcome-skip"); // the funding wallet is connected later, when protecting
  await byId(page, "experience").waitFor();
  await snap(page, "experience");
  await clickId(page, "experience-continue"); // Simple is the default
  await byId(page, "lock-screen").waitFor({ timeout: 60_000 });
  const pw = page.locator('input[type="password"]');
  await pw.nth(0).fill(PASSWORD);
  await pw.nth(1).fill(PASSWORD);
  await clickId(page, "create");
  await byId(page, "recovery-phrase").waitFor({ timeout: 120_000 });
  phrase = (await page.locator('[data-testid="recovery-phrase"] code').textContent()).trim();
  check("the recovery phrase has 24 words", phrase.split(/\s+/).length === 24);
  await snap(page, "recovery-phrase");
  await page.locator('input[type="checkbox"]').first().check();
  await clickId(page, "phrase-continue");
  await byId(page, "home").waitFor({ timeout: 60_000 });
  check("Home shows $0 before any balance (spec v2.0 §7.1)", (await byId(page, "private-usd").textContent()).trim() === "$0");
  await snap(page, "home-empty");
  for (const [link, id] of [["Swap", "swap-view"], ["Activity", "activity"], ["More", "more"], ["Home", "home"]]) { await nav(page, link); await byId(page, id).waitFor({ timeout: 60_000 }); }
  await clickId(page, "home-send"); await byId(page, "send-view").waitFor(); await clickId(page, "back"); await byId(page, "home").waitFor();
  await clickId(page, "home-receive"); await byId(page, "sheet-receive").waitFor(); await clickId(page, "back"); await byId(page, "home").waitFor(); // V7 Stage 4: Receive from Home's balance card (and Settings → Connected wallet)
  await clickId(page, "privacy-badge"); await byId(page, "privacy-center").waitFor(); await snap(page, "privacy-center"); await clickId(page, "back"); await byId(page, "home").waitFor();
  await clickId(page, "home-settings"); await byId(page, "settings").waitFor(); await snap(page, "settings");
  // V6 Stage 15 (spec v2.0 §8; doc §18): 15 idle minutes by default; this run waits longer than that on some screens
  check("auto-lock: 15 minutes by default (1 / 5 / 15 / 60 under Security)", (await byId(page, "auto-lock-15").getAttribute("aria-checked")) === "true");
  await clickId(page, "auto-lock-60");
  await clickId(page, "back"); await byId(page, "home").waitFor();
  const offOrigin = requests.filter((r) => r.phase === "first-launch" && !r.url.startsWith(WALLET));
  check("first launch: no request left the page's origin (creating a wallet, every route and screen)", offOrigin.length === 0, offOrigin.length ? offOrigin.slice(0, 5).map((r) => r.url).join(", ") : `${requests.length} same-origin loads`);

  // 1. Settings → Advanced: the light client off (chain id 1 has one, the devnet no beacon chain); Settings → Connected wallet: connected ----
  phase = "settings";
  await nav(page, "More"); await clickId(page, "more-settings"); await byId(page, "settings").waitFor(); // V7 Stage 4 (spec v3.0 §2): one Settings page
  const experience = byId(page, "experience-toggle");
  await experience.check(); // the Advanced settings are reachable from Settings only under the advanced experience
  await clickId(page, "settings-advanced");
  await byId(page, "advanced").waitFor();
  const lc = byId(page, "verify-reads");
  await lc.uncheck();
  await textAppears(page, "Off: the pool is read from the RPC endpoints");
  check("Settings → Advanced: the light client is off and says so", true);
  const fingerprintBefore = await text(byId(page, "deployment-fingerprint"));
  check("V6 Stage 10 (doc §71): nothing about the deployment is read before the first operation", /checked before your first operation/.test(fingerprintBefore), fingerprintBefore);
  await snap(page, "advanced");
  await clickId(page, "back"); await byId(page, "settings").waitFor();
  await byId(page, "experience-toggle").uncheck(); // Simple again for the money flow
  await byId(page, "wallet-screen").waitFor();
  await clickId(page, "wallet-connect"); // V7 Stage 4: the connector picker, the browser's injected wallet
  await byId(page, "connect-sheet").waitFor();
  await clickId(page, "connector-injected");
  await textAppears(page, "Connected");
  check("Settings → Connected wallet: the funding wallet is connected through its own provider, chosen in the picker", (await text(byId(page, "connection-status"))).includes("Connected"));
  await snap(page, "wallet-connected");

  // 2. protect: two public deposits of 500 ETH --------------------------------------------------------------------------
  phase = "protect";
  const vaultBefore = await balanceEth(stack.ethVault); // the devnet keeps earlier runs' deposits
  const feeRecipientBefore = stack.feeRecipient ? await balanceEth(stack.feeRecipient) : 0;
  for (const i of [1, 2]) {
    await protect(page, 500, vaultBefore + NET_PROTECT * i);
    log(`deposit ${i}: 500 ETH protected (vault ${await balanceEth(stack.ethVault)} ETH)`);
    if (i === 1) await snap(page, "protected-500");
  }
  const vaultBalance = await balanceEth(stack.ethVault);
  check("the ETH vault received the two deposits net of the privacy fee (V6: 2 × 495 ETH)", Math.abs(vaultBalance - vaultBefore - 2 * NET_PROTECT) < 1e-9, `${vaultBefore} → ${vaultBalance} ETH`);
  if (stack.feeRecipient) {
    const feeRecipientAfter = await balanceEth(stack.feeRecipient);
    check("V6 (spec v2.0 §3, §11.1): ProtectRouter paid exactly 1 % of each protect to the fee recipient (2 × 5 ETH)", Math.abs(feeRecipientAfter - feeRecipientBefore - 10) < 1e-9, `${feeRecipientBefore} → ${feeRecipientAfter} ETH`);
  }
  await nav(page, "Home");
  await page.getByText(usdRe(2 * NET_PROTECT * PRICE)).first().waitFor({ timeout: 60_000 });
  check(`Home values the protected balance through the RPC quorum: ≈ ${usd(2 * NET_PROTECT * PRICE)}`, true);
  await snap(page, "home-funded");
  // V6 Stage 10 (doc §71; spec v2.0 §10): the first protect checked the deployment — the core's identifiers, the
  // canonical vaults, ProtectRouter's core — and the journal remembers its fingerprint; Advanced shows it and can forget it
  await nav(page, "More"); await clickId(page, "more-settings"); await byId(page, "settings").waitFor(); // V7 Stage 4: one Settings page
  await byId(page, "experience-toggle").check();
  await clickId(page, "settings-advanced");
  await byId(page, "advanced").waitFor();
  const fingerprintAfter = await text(byId(page, "deployment-fingerprint"));
  check("the deployment was checked before the first operation and its fingerprint remembered (Advanced shows it with the way to forget it)", /0x[0-9a-f]{8}…[0-9a-f]{6}/.test(fingerprintAfter) && (await byId(page, "deployment-forget").count()) === 1, fingerprintAfter);
  await clickId(page, "back"); await byId(page, "settings").waitFor();
  await byId(page, "experience-toggle").uncheck(); // Simple again

  // 2b. V6 Stage 10 (spec v2.0 §3, §7.3–§7.4; doc §22, §24): the document's figures in USDC — Protect 5,000 → 4,950 (the
  // 1 % to ProtectRouter's fee recipient), then Send 2,500 → 2,470.90 (25.00 privacy fee + 4.10 relayer, one fee note) -----
  if (stack.usdc) {
    phase = "usdc";
    const vaultUsdcBefore = await balanceUsdc(stack.usdc.vault);
    const feeUsdcBefore = stack.feeRecipient ? await balanceUsdc(stack.feeRecipient) : 0n;
    await openProtect(page, 5000, "USDC");
    // the network line follows the wallet's own estimate (eth_estimateGas × its gas price, 250 ms after the amount)
    for (let i = 0; i < 60 && !/\$/.test(await text(byId(page, "protect-network-fee"))); i++) await page.waitForTimeout(250);
    const pReceive = await text(byId(page, "protect-receive"));
    const pFee = await text(byId(page, "protect-privacy-fee"));
    const pNetwork = await text(byId(page, "protect-network-fee"));
    check("Protect 5,000 USDC (spec v2.0 §7.3): You receive 4,950 USDC, Privacy fee 50 USDC, the relayer/network in dollars from the wallet's own estimate", figure(pReceive) === 4950 && figure(pFee) === 50 && /\$[\d,]+\.\d\d/.test(pNetwork), `${pReceive} | ${pFee} | ${pNetwork}`);
    await snap(page, "protect-usdc");
    await clickId(page, "protect-review");
    await waitReview(page);
    check("the Protect Review below $50K is a tap (spec v2.0 §7.6)", (await byId(page, "review-confirm").count()) === 1 && (await byId(page, "hold-to-confirm").count()) === 0);
    await confirmReview(page);
    await byId(page, "protect-done").waitFor({ timeout: 180_000 }); // the approval, then the protect: two prompts, one operation
    check("the progress ends on what was added: 4,950 USDC", /4,950 USDC/.test(await text(byId(page, "protect-done"))), await text(byId(page, "protect-done")));
    const vaultUsdcGain = (await balanceUsdc(stack.usdc.vault)) - vaultUsdcBefore;
    check("the USDC vault received exactly 4,950 USDC", vaultUsdcGain === 4_950_000_000n, `${vaultUsdcGain} base units`);
    if (stack.feeRecipient) {
      const feeGain = (await balanceUsdc(stack.feeRecipient)) - feeUsdcBefore;
      check("ProtectRouter paid exactly 50 USDC (1 %) to the fee recipient", feeGain === 50_000_000n, `${feeGain} base units`);
    }
    await snap(page, "protected-usdc");
    const { recipient: recipientUsdc, receive: receiveUsdc } = await sendPublic(page, 2500, "USDC");
    const sPrivacy = await text(byId(page, "send-privacy-fee"));
    const sRelayer = await text(byId(page, "send-relayer-fee"));
    check("Send 2,500 USDC (spec v2.0 §7.4): Recipient receives 2,470.90 USDC — the largest line —, Privacy fee 25.00, Relayer ≈ 4.10", receiveUsdc === 2470.9 && figure(sPrivacy) === 25 && figure(sRelayer) === 4.1, `${receiveUsdc} | ${sPrivacy} | ${sRelayer}`);
    await snap(page, "send-usdc");
    await clickId(page, "send-review");
    await waitReview(page);
    await confirmReview(page);
    await byId(page, "send-done").waitFor({ timeout: PROOF_TIMEOUT });
    const gotUsdc = await balanceUsdc(recipientUsdc);
    check("the fresh recipient received exactly 2,470.90 USDC from the vault, submitted by the relayer", gotUsdc === 2_470_900_000n, `${recipientUsdc}: ${gotUsdc} base units`);
    await snap(page, "sent-usdc");
  }

  // 3. a $1K public send: the standard flow ------------------------------------------------------------------------------
  phase = "send-1k";
  const { recipient: recipient1, receive: receive1 } = await sendPublic(page, 0.2);
  check("exact-input by default (spec §10): the recipient receives what you send minus the privacy fee and the relayer's", receive1 > 0.19 && receive1 < 0.2, `${receive1} ETH of 0.2`);
  await page.getByText(usdRe(0.2 * PRICE)).first().waitFor({ timeout: 30_000 });
  check("a $850 send is the plain flow (a Review with a tap, no lint block, no hold)", (await byId(page, "send-large").count()) === 0);
  await snap(page, "send-1k");
  await clickId(page, "send-review");
  check("V6 (spec v2.0 §7.6): below $100K the V6 Review", (await waitReview(page)) === "v6");
  await confirmReview(page);
  await byId(page, "send-done").waitFor({ timeout: PROOF_TIMEOUT });
  const got1 = await balanceEth(recipient1);
  check("the fresh recipient received the page's \"Recipient receives\" (to its six shown decimals) from the vault, submitted by the relayer", roundedDown(got1, receive1), `${recipient1}: ${got1} ETH (shown ${receive1})`);
  await snap(page, "sent-1k");

  // 4. a $120K public send: the enhanced Review --------------------------------------------------------------------------
  phase = "send-120k";
  const { recipient: recipient2, receive: receive2 } = await sendPublic(page, 28);
  check("the address book offers the next fresh address", recipient2.toLowerCase() !== recipient1.toLowerCase(), recipient2);
  await page.getByText(usdRe(28 * PRICE)).first().waitFor({ timeout: 30_000 });
  await byId(page, "send-large").waitFor({ timeout: 30_000 });
  await clickId(page, "send-review");
  check("from $100K the V2–V4 Review stays (spec v2.0 §2)", (await waitReview(page)) === "v4");
  check("the enhanced Review shows the USD numeral", (await byId(page, "review-usd").textContent()).includes(usd(28 * PRICE)), await byId(page, "review-usd").textContent());
  check("the enhanced Review carries the privacy lint", (await byId(page, "privacy-lint").count()) >= 1);
  check("V5 (spec §11): from $50K the confirmation is a hold, never a tap", (await byId(page, "hold-to-confirm").count()) === 1 && (await byId(page, "confirm-tap").count()) === 0);
  await snap(page, "review-120k");
  await acknowledgeAll(page);
  await confirmReview(page);
  await byId(page, "send-done").waitFor({ timeout: PROOF_TIMEOUT });
  const got2 = await balanceEth(recipient2);
  check("the second fresh recipient received the page's figure (28 ETH minus the fees, to its six shown decimals)", roundedDown(got2, receive2) && got2 > 27 && got2 < 28, `${recipient2}: ${got2} ETH (shown ${receive2})`);
  await snap(page, "sent-120k");

  // 5. the $850K swap with ONE confirmation (V6 Stage 11, spec v2.0 §7.5–§7.7; a $1M+ order is a protected execution:
  // section 8) — the quote as the amount is typed, the V2–V4 Review from $100K (a hold), then the order runner funds the
  // escrow by a private withdrawal, prepares the hard quote, checks the provider call, signs, simulates and hands it over
  // with no second tap. A lower minimum pauses the order for the user's choice; a hard quote the price guard refuses (§14)
  // pauses it too — tried again against a fresh quote, as a user would; when the market keeps refusing, the funds go back.
  phase = "swap";
  await nav(page, "Swap");
  await byId(page, "swap-view").waitFor({ timeout: 30_000 });
  await fillId(page, "amount-input", "200");
  await page.getByText(usdRe(200 * PRICE)).first().waitFor({ timeout: 30_000 });
  const destination = await byId(page, "destination-input").inputValue();
  check("the destination is a fresh Bitcoin address of this wallet", /^bc1q[0-9a-z]{38,}$/.test(destination), destination);
  await waitQuote(page, "200"); // fetched as the amount was typed: no "Get a quote" step
  const quoteText = await text(byId(page, "swap-quote"));
  log(`the quote: ${quoteText.slice(0, 260)}`);
  check("the quote: the best protected route, the privacy, relayer and provider fees, the time (spec v2.0 §7.5)", /Best protected route/.test(quoteText) && /Privacy fee/.test(quoteText) && /Relayer/.test(quoteText) && /Swap\/provider/.test(quoteText) && /min/.test(quoteText), quoteText.slice(0, 200));
  check("cross-chain: \"You'll receive at least\" leads", /You'll receive at least/.test(await text(byId(page, "swap-to"))));
  check("the quote says how long it stays valid", /valid for \d+ s/.test(await text(byId(page, "swap-expires"))), await text(byId(page, "swap-expires")));
  const quoteBodies = requests.filter((r) => r.url.endsWith("/v1/quotes") && r.body).map((r) => JSON.parse(r.body));
  check("the quotes carried no destination (the engine quotes a placeholder; spec v2.0 §13.2)", quoteBodies.length > 0 && quoteBodies.every((b) => !b.destination), `${quoteBodies.length} quote requests`);
  const quoteLayout = await layoutProbe(page);
  check("the quoted Swap fits the phone: no horizontal scroll", quoteLayout.scrollWidth <= page.viewportSize().width, `${quoteLayout.scrollWidth} px wide on a ${page.viewportSize().width} px screen${quoteLayout.wide.length ? `: ${quoteLayout.wide.join(", ")}` : ""}`);
  await snap(page, "swap-quote");
  await clickId(page, "swap-review");
  const review = byId(page, "review");
  await review.waitFor();
  check("from $100K the Review is the V2–V4 commit moment", (await review.getAttribute("data-moment")) === "commit");
  check("the Review shows $850,000", (await byId(page, "review-usd").textContent()).includes(usd(200 * PRICE)), await byId(page, "review-usd").textContent());
  const reviewText = await text(review);
  check("the five lines are there", ["Price protected", "Route checked", "Destination verified", "Slippage checked", "Privacy reviewed"].every((l) => reviewText.includes(l)), reviewText.slice(0, 300));
  const ackIn = await acknowledgeAll(page);
  log(`acknowledged ${ackIn} items inside the Review`);
  await snap(page, "review-commit");
  check("the $850K confirmation is a hold (from $50K), never a tap", (await byId(page, "hold-to-confirm").count()) === 1 && (await byId(page, "confirm-tap").count()) === 0);
  await confirmReview(page);
  await page.waitForURL(/\/swap\/progress\/r[0-9a-f]{32}$/, { timeout: 120_000 });
  const progressUrl = page.url();
  check("the progress URL names the order by a handle, never by its order id (audit c41)", !/0x[0-9a-f]{40}/i.test(progressUrl), new URL(progressUrl).pathname);
  check("ONE confirmation: the order is committed and its progress shown (no Fund now, no second Confirm)", (await byId(page, "order-fund").count()) === 0 && (await byId(page, "order-confirm").count()) === 0, progressUrl.slice(-80));
  await snap(page, "committed");
  log("committed: the order runner funds it now");

  // the runner moves the order on its own: the funding (a proof), the hard quote, the checks, the signature, the hand-over
  let executed = false, refusals = 0, consents = 0;
  const executing = page.locator('[data-testid="swap-progress"][data-state="EXECUTING"], [data-testid="swap-progress"][data-state="SETTLING"], [data-testid="swap-done"]');
  const movedCard = byId(page, "swap-minimum-moved");
  const tryAgain = byId(page, "swap-try-again");
  let stoppedAt = null;
  for (let round = 1; round <= 10 && !executed; round++) {
    const outcome = await firstOf(page, { executing, moved: movedCard, retry: tryAgain, stopped: stoppedOrder(page) }, PROOF_TIMEOUT).catch(() => "timeout");
    if (outcome === "executing") { executed = true; break; }
    if (outcome === "stopped" || outcome === "timeout") {
      stoppedAt = await orderWords(page);
      check(outcome === "stopped" ? "the order goes on to its execution (it stopped)" : `the order reaches its execution within ${PROOF_TIMEOUT / 1000} s`, false, stoppedAt);
      await snap(page, "order-stopped");
      break;
    }
    if (outcome === "moved") {
      const moved = (await text(movedCard)).slice(0, 200);
      if (consents === 0) { check("a lower hard quote waits for the user's choice before anything is signed (QUOTE_EXPIRED, minimum_moved)", /now guarantees at least [0-9.,]+ BTC; you approved [0-9.,]+ BTC/.test(moved), moved); await snap(page, "minimum-moved"); }
      else log(`the price moved again (${consents + 1}): ${moved.slice(0, 120)}`);
      consents++;
      await clickId(page, "swap-accept-minimum");
      await movedCard.waitFor({ state: "detached", timeout: 60_000 }).catch(() => {});
      continue;
    }
    // execution_unavailable: the price guard refused the hard quote (or the simulation failed): nothing was signed
    refusals++;
    const why = (await text(page.locator('[data-testid="operation-progress-error"]'))).slice(0, 300);
    check(`a refused hard quote pauses the order with nothing signed (attempt ${refusals})`, /cannot execute right now/i.test(why), why);
    if (refusals === 1) await snap(page, "price-guard-refusal");
    if (refusals >= 4) break;
    await page.waitForTimeout(20_000);
    await tryAgain.click();
    await tryAgain.waitFor({ state: "detached", timeout: 60_000 }).catch(() => {});
  }
  report.outcome.priceGuardRefusals = refusals;
  report.outcome.minimumConsents = consents;
  if (executed) {
    // the executor: the relayer deploys the escrow's execution and the tracker reports it
    const job = await (async () => { for (let i = 0; i < 60; i++) { const j = (await jobsOfThisRun()).find((x) => x.executionTx); if (j) return j; await page.waitForTimeout(2000); } return null; })();
    if (job) {
      const receipt = await rpc("eth_getTransactionReceipt", [job.executionTx]);
      check("the executor's deployAndExecute is mined on the devnet", receipt?.status === "0x1", `${job.executionTx} in block ${receipt ? Number(receipt.blockNumber) : "?"} (${receipt?.logs?.length ?? 0} logs)`);
      const escrowBalance = await balanceEth(job.escrow);
      check("the one-time escrow is empty after the execution", escrowBalance === 0, `${job.escrow}: ${escrowBalance} ETH`);
      report.outcome.execution = { orderId: job.id, escrow: job.escrow, executionTx: job.executionTx, provider: job.provider ?? null };
    } else check("the relayer reports this run's executed job", false, JSON.stringify(await jobsOfThisRun()).slice(0, 300));
    const funded = (await jobsOfThisRun()).length;
    check("funded and handed over once (one job for this order)", funded >= 1);
    await snap(page, "executing");
  } else if (stoppedAt && !(await byId(page, "swap-return-funds").count())) {
    log(`the order stopped with nothing to return from its screen: ${stoppedAt}`);
  } else {
    // the market kept the chosen route below the best alternative: the funded order goes back to the protected balance
    log(stoppedAt ? `the order stopped (${stoppedAt}): returning the funds to the protected balance` : "the price guard refused every attempt: returning the funds to the protected balance");
    await clickId(page, "swap-return-funds");
    let job = null;
    for (let i = 0; i < 60 && !job; i++) { job = (await jobsOfThisRun()).find((j) => j.state === "refund-only" || j.state === "refunding" || j.state === "refunded") ?? null; if (!job) await page.waitForTimeout(2000); }
    check("a refund-only job with no signature is journaled by the relayer (§20)", !!job, job ? `${job.id} escrow ${job.escrow}` : JSON.stringify(await jobsOfThisRun()).slice(0, 200));
    report.outcome.returned = job ? { orderId: job.id, escrow: job.escrow } : true;
    await snap(page, "returned-to-balance");
  }

  // 6. a reload: unlock, the order comes back from the encrypted journal; the runner carries on -------------------------------
  phase = "reload";
  await page.reload({ waitUntil: "load" });
  await unlock(page);
  await nav(page, "Home");
  await byId(page, "home").waitFor({ timeout: 60_000 });
  const card = byId(page, "operation-card");
  if (await card.count()) {
    await card.first().getByTestId("operation-open").click(); // a swap's card opens its progress (V6 Stage 11)
    await page.waitForURL(/\/swap\/progress\//, { timeout: 30_000 });
  } else {
    await page.evaluate((u) => { history.pushState({}, "", new URL(u).pathname); window.dispatchEvent(new PopStateEvent("popstate")); }, progressUrl); // already settled: no open card
  }
  const lineRe = executed ? /Executing|Waiting for destination|Completed|Partial|Swap complete|executing|verifying|confirmation/i : /Refunding|Refunded|Returned|refund/i;
  await page.getByText(lineRe).first().waitFor({ timeout: 120_000 });
  check("after a reload and unlock the order and its progress come back from the journal", true, (await text(page.locator("main"))).slice(0, 160));
  const fundings = requests.filter((r) => r.phase === "reload" && r.url.includes("/relay") && /withdraw/i.test(r.body ?? "")).length;
  check("the reload funds nothing again", fundings === 0, `${fundings} withdrawal submissions after the reload`);
  await snap(page, "after-reload");

  // 7. Activity --------------------------------------------------------------------------------------------------------------
  phase = "activity";
  await nav(page, "Activity");
  await byId(page, "activity").waitFor();
  const rows = await byId(page, "activity-row").count();
  check("Activity lists every money flow (two deposits, two sends, one swap)", rows >= 5, `${rows} rows`);
  await snap(page, "activity");
  const activityText = await text(byId(page, "activity"));
  check("the swap row never says a bare failed", !/\bfailed\b/i.test(activityText), activityText.slice(0, 300));

  // 7b. V6 Stage 12 (spec v2.0 §7.5, §11.2): a same-chain swap into the protected balance — 8,000 USDC → ETH ----------------
  if (stack.usdc && stack.shieldFactory) {
    phase = "swap-protected";
    await openProtect(page, 10000, "USDC"); // 9,900 USDC more in the protected balance (2,450 are left from 2b)
    await clickId(page, "protect-review");
    await waitReview(page);
    await confirmReview(page);
    await byId(page, "protect-done").waitFor({ timeout: 180_000 });
    await nav(page, "Swap");
    await byId(page, "swap-view").waitFor({ timeout: 30_000 });
    await chooseAsset(page, "swap-from-asset", "swap-from-selector-option", "USDC");
    await chooseAsset(page, "swap-to-asset", "swap-to-selector-option", "Ethereum"); // ETH on the pool's chain (the source USDC is no target)
    const toSide = await text(byId(page, "swap-to"));
    check("a same-chain target lands in the protected balance: no destination to type (spec v2.0 §7.5)", (await byId(page, "swap-destination").count()) === 0 && /Your protected balance/.test(toSide), toSide);
    await fillId(page, "amount-input", "8000");
    await waitQuote(page, "8000");
    const pq = await text(byId(page, "swap-quote"));
    log(`the protected quote: ${pq.slice(0, 220)} | ${await text(byId(page, "swap-to"))}`);
    check("the quote: You receive ≈ ETH, Minimum receive, Fees in dollars", /Minimum receive/.test(pq) && /Fees\s*\$[\d,]+\.\d\d/.test(pq) && /≈/.test(await text(byId(page, "swap-to"))), pq.slice(0, 200));
    const pqBodies = requests.filter((r) => r.phase === "swap-protected" && r.url.endsWith("/v1/quotes") && r.body).map((r) => JSON.parse(r.body));
    check("the quotes ask for a protected destination and carry no address (spec v2.0 §12)", pqBodies.length > 0 && pqBodies.every((b) => b.destinationType === "protected" && !b.destination), `${pqBodies.length} quote requests`);
    await snap(page, "swap-protected-quote");
    await clickId(page, "swap-review");
    await waitReview(page);
    const prv = await text(byId(page, "review-view"));
    check("the Review: destination Your protected balance, a tap below $50K", /Your protected balance/.test(prv) && (await byId(page, "review-confirm").count()) === 1 && (await byId(page, "hold-to-confirm").count()) === 0, prv.slice(0, 260));
    const minimumShown = figure(await text(byId(page, "review-minimum")));
    await snap(page, "swap-protected-review");
    const vaultEthBefore = await balanceEth(stack.ethVault);
    await confirmReview(page);
    await page.waitForURL(/\/swap\/progress\/r[0-9a-f]{32}$/, { timeout: 120_000 });
    // the page renders from the journal a moment after the navigation: wait for the line rather than count at once
    const arrives = await firstOf(page, { into: byId(page, "swap-into-protected"), adding: byId(page, "swap-adding-to-protected") }, 15_000).catch(() => null);
    check("ONE confirmation: committed, and its progress says where it arrives", !!arrives, arrives ?? "no line");
    const commitBody = requests.filter((r) => r.phase === "swap-protected" && /\/v1\/operations$/.test(r.url) && r.method === "POST" && r.body).map((r) => JSON.parse(r.body)).find((b) => b.orderSigner);
    const receiver = commitBody?.destination ?? "";
    check("the commit names the one-time shield receiver as the destination", commitBody?.destinationType === "protected" && /^0x[0-9a-fA-F]{40}$/.test(receiver), receiver);
    await snap(page, "swap-protected-committed");
    // the runner: the funding (a proof), the hard quote, the checks, the signature, the shield job, the hand-over. While the
    // live price trends one way every fresh hard quote is a little worse and the wallet asks again (it never signs below
    // an approved minimum): the V6 Stage 16 run accepted six in a row and the hand-over came 10 s after six rounds — ten
    // rounds, as a patient user would
    let handed = null;
    for (let round = 1; round <= 10 && !handed; round++) {
      handed = await until(page, async () => (await jobsOfThisRun()).find((j) => Number(j.params?.assetType) === 1 && j.executionTx) ?? null, 30_000);
      if (handed) break;
      if (await byId(page, "swap-minimum-moved").count()) { log("the price moved before signing: accepted, as a user would"); await clickId(page, "swap-accept-minimum"); continue; }
      if (await byId(page, "swap-try-again").count()) { log(`the hard quote was refused (attempt ${round}): trying again`); await clickId(page, "swap-try-again"); continue; }
      if (await stoppedOrder(page).count()) { check("the order goes on to its hand-over (it stopped)", false, await orderWords(page)); await snap(page, "swap-protected-stopped"); break; }
      handed = await until(page, async () => (await jobsOfThisRun()).find((j) => Number(j.params?.assetType) === 1 && j.executionTx) ?? null, PROOF_TIMEOUT / 6);
    }
    if (!handed) log(`no hand-over: ${await orderWords(page)}`);
    const shieldJob = shieldJobsOfThisRun().find((j) => j.receiver.toLowerCase() === receiver.toLowerCase());
    check("the relayer watches the receiver from the hand-over (POST /shield before the execution)", !!shieldJob && !!handed && Number(shieldJob.createdAt) <= Number(handed.updatedAt), shieldJob ? `${shieldJob.id.slice(0, 18)}… ${shieldJob.state}, tip ${shieldJob.params.shieldTip} wei, minAmount ${shieldJob.params.minAmount}` : "no shield job");
    if (handed && shieldJob) {
      const exec = await rpc("eth_getTransactionReceipt", [handed.executionTx]);
      check("the executor's deployAndExecute of the USDC order is mined (the router deposit, the memo naming the receiver)", exec?.status === "0x1", handed.executionTx);
      // THORChain's outbound, as its vault sends it: the real router's transferOut — `to.send(value)`, 2300 gas — to the receiver
      const tip = BigInt(shieldJob.params.shieldTip);
      const deliver = BigInt(Math.round(minimumShown * 1e6)) * 10n ** 12n + tip; // the worst case the route guarantees: the minimum and the tip
      const data = encodeFunctionData({ abi: parseAbi(["function transferOut(address to, address asset, uint256 amount, string memo) payable"]), functionName: "transferOut", args: [receiver, "0x0000000000000000000000000000000000000000", deliver, `OUT:${handed.executionTx.slice(2).toUpperCase()}`] });
      const outTx = await rpc("eth_sendTransaction", [{ from: stack.funding, to: stack.pins.thorchainRouter, data, value: "0x" + deliver.toString(16), gas: "0x30d40" }]);
      const out = await rpc("eth_getTransactionReceipt", [outTx]);
      const atReceiver = BigInt(await rpc("eth_getBalance", [receiver, "latest"]));
      check("THORChain's router paid the receiver with its 2300-gas send (before the receiver exists)", out?.status === "0x1" && (atReceiver === deliver || shieldJobsOfThisRun().some((j) => j.id === shieldJob.id && j.state !== "waiting-delivery")), `${Number(deliver) / 1e18} ETH; the receiver holds ${Number(atReceiver) / 1e18}`);
      const done = await until(page, () => shieldJobsOfThisRun().find((j) => j.id === shieldJob.id && j.state === "shielded") ?? null, 120_000);
      const s0 = done?.shields?.[0];
      check("the relayer deployed the receiver and shielded the delivery: the tip once, the rest as the committed note", !!done && done.paid === true && BigInt(s0?.tip ?? -1) === tip && BigInt(s0?.amount ?? -1) === deliver - tip && Number.isInteger(s0?.leafIndex), done ? `leaf ${s0?.leafIndex}, ${Number(BigInt(s0?.amount ?? 0)) / 1e18} ETH, tip ${s0?.tip} wei, gas ${done.gasUsed}` : JSON.stringify(shieldJobsOfThisRun().find((j) => j.id === shieldJob.id) ?? {}).slice(0, 300));
      const code = await rpc("eth_getCode", [receiver, "latest"]);
      const left = BigInt(await rpc("eth_getBalance", [receiver, "latest"]));
      check("the receiver is deployed and holds nothing", code !== "0x" && left === 0n, `${(code.length - 2) / 2} bytes, ${left} wei left`);
      const vaultGain = (await balanceEth(stack.ethVault)) - vaultEthBefore;
      check("the ETH vault received the delivery less the tip", Math.abs(vaultGain - Number(deliver - tip) / 1e18) < 1e-9, `${vaultGain} ETH`);
      report.outcome.shield = { receiver, receiptId: shieldJob.id, delivered: deliver.toString(), tip: tip.toString(), leafIndex: s0?.leafIndex ?? null, gasUsed: done?.gasUsed ?? null };
      // the wallet: its runner asks the relayer, finds the note in the pool, and the order completes with what was added
      await byId(page, "swap-done").waitFor({ timeout: 240_000 });
      const doneText = await text(byId(page, "swap-done"));
      check("the wallet found the note: the progress ends on \"Added to your protected balance\" with the amount", /Added to your protected balance: [0-9.,]+ ETH/.test(doneText) && Math.abs(figure(doneText) - Number(deliver - tip) / 1e18) < 1e-6, doneText);
      await snap(page, "swap-protected-done");
    }
  }

  // 8. the $10M protected swap (V3 on the V5 screens) ----------------------------------------------------------------------
  if (!process.env.SKIP_CAMPAIGN) { phase = "campaign"; await campaignRun(page); }

  // 8b. V6 Stage 13: the $80K protected execution (after the $10M campaign, so the two never share its list) — automatic from $50K, amounts only -------------------------------------
  {
    phase = "swap-80k";
    const sectionStart = Date.now();
    await nav(page, "Home"); // a fresh Swap screen (the last section ended inside /swap/*, whose state would carry over)
    await byId(page, "home").waitFor({ timeout: 30_000 });
    await nav(page, "Swap");
    await byId(page, "swap-view").waitFor({ timeout: 30_000 });
    const amount80 = (Math.ceil((80_000 / PRICE) * 1e6) / 1e6).toFixed(6); // rounded up: at least $80,000.00 at the stack's price
    await fillId(page, "amount-input", amount80);
    await page.getByText(usdRe(80_000)).first().waitFor({ timeout: 30_000 });
    await waitQuote(page, amount80);
    const page80 = await text(page.locator("main"));
    check("$80,000: no \"Protect this order\" and no protection mode to choose — the protection is automatic (doc §87)", (await byId(page, "protect-this-order").count()) === 0 && !/Protection mode|Max privacy|Max safety|Protect this order/i.test(page80), page80.slice(0, 200));
    await clickId(page, "swap-review");
    const kind80 = await waitReview(page);
    const review80 = await text(page.locator("main"));
    check("the $80K Review is the V6 one: Protected execution with its four checks (doc §49)", kind80 === "v6" && ["Protected execution", "Destination verified", "Quote locked", "Route health checked", "Execution limits enabled"].every((w) => review80.includes(w)), review80.slice(0, 300));
    check("from $50K: Hold to Confirm, never a tap", (await byId(page, "hold-to-confirm").count()) === 1 && (await byId(page, "review-confirm").count()) === 0);
    await snap(page, "review-80k");
    await confirmReview(page);
    await page.waitForURL(/\/swap\/steps\/0x[0-9a-f]{64}$/, { timeout: 60_000 });
    const large80 = byId(page, "progress-large");
    await large80.waitFor({ timeout: 30_000 });
    const steps80 = await text(byId(page, "swap-steps"));
    check("ONE confirmation starts the protected steps; the progress shows amounts only: $80,000 ETH → BTC, Completed / Executing / Remaining", /\$80,000(\.00)?/.test(steps80) && /ETH → BTC/.test(steps80) && ["Completed", "Executing", "Remaining"].every((w) => steps80.includes(w)) && !/Step \d|Tranche|of ~?\d/.test(steps80), steps80.slice(0, 220));
    await snap(page, "steps-80k");
    // the runner by itself: the first step funded (a proof), signed and handed over to the executor — its amount is Executing
    // from the funding on (a funded step counts as executing), so the hand-over is read from the relayer's jobs
    // the live market may pause the steps between the approval and a step's hard quote — the price moved ("Price changed"),
    // or the approved provider gave no quote for a moment ("Liquidity dropped", V6 Stage 16's run: Chainflip answered
    // nothing) — and a person resumes, as the $10M campaign's section does; the run says so each time (at most five)
    // a resumed step starts its cycle again (quote, commit, fund, sign, hand over, one action per tick): a round in
    // which the run pressed Resume earns another round (the 2026-10-14 final run's step came 10 s after one round)
    let pauses = 0;
    let firstJob = null;
    for (let round = 0; round < 3 && !firstJob; round++) {
      const before = pauses;
      firstJob = await until(
        page,
        async () => {
          const resume = byId(page, "swap-steps-resume");
          if ((await resume.count()) && pauses < 5) {
            pauses++;
            log(`the steps paused before step 1's hand-over (${(await text(page.locator("main"))).slice(0, 140)}): Resume`);
            await resume.first().click();
            await large80.waitFor({ timeout: 30_000 }).catch(() => {});
          }
          return (await jobsOfThisRun()).find((j) => Number(j.createdAt ?? 0) >= sectionStart && Number(j.params?.assetType) === 0 && j.execution) ?? null;
        },
        PROOF_TIMEOUT,
      );
      if (pauses === before) break; // no resume in this round: waiting longer would not help
    }
    if (pauses) log(`step 1 ${firstJob ? "went ahead" : "did not go ahead"} after ${pauses} resume(s)`);
    // a funded step whose route the requote replaced returns through its refund-only job, which waits for the escrow's
    // window while the band's one-quarter cap holds the next step (audit gap 44, the 2026-10-14 quick pass): named, not guessed
    const refundOnly = firstJob ? null : (await jobsOfThisRun()).find((j) => Number(j.createdAt ?? 0) >= sectionStart && Number(j.params?.assetType) === 0 && j.state === "refund-only");
    if (refundOnly) log(`step 1's order ${refundOnly.id.slice(0, 18)}… went refund-only: the requote adopted another route, and its refund waits for the escrow's window (audit gap 44)`);
    // a step that never went ahead (a provider down for the whole wait) is this section's failure, not the run's end
    const progress80 = await text(large80).catch(() => "");
    const executing = /Executing\s*\$[1-9][\d,]*\.\d\d/.test(progress80) ? progress80 : null;
    check("the first step was funded, signed and handed over with no second tap; its amount is Executing", !!executing && !!firstJob, `${(executing ?? (progress80 || (await text(page.locator("main")).catch(() => "")))).slice(0, 160)} | job ${firstJob?.id?.slice(0, 18) ?? (refundOnly ? "none: step 1 went refund-only after a route change (audit gap 44)" : "none")}…`);
    if (firstJob) {
      const quarter = Number(BigInt(firstJob.params.amount)) / 1e18;
      check("the step is a quarter of the order (the band's limit: one quarter in flight), on the route approved", Math.abs(quarter * PRICE - 20_000) < 400, `${quarter.toFixed(4)} ETH ≈ $${Math.round(quarter * PRICE)}`);
    }
    await snap(page, "steps-80k-executing");
    // Return the rest: the steps not started are skipped; the one in flight finishes first (THORChain never settles here).
    // "Nothing more" is counted from the jobs there are when Return is pressed (a step may land just as the wait ends)
    // a hand-over is a job with an execution: a step funded and never handed over returns through a refund-only job
    const handOvers = async () => (await jobsOfThisRun()).filter((j) => Number(j.createdAt ?? 0) >= sectionStart && Number(j.params?.assetType) === 0 && !!j.execution).length;
    const jobsAtReturn = await handOvers();
    await clickId(page, "swap-steps-return");
    await textAppears(page, "Returning the rest", 30_000);
    await page.waitForTimeout(20_000); // a runner tick or two: nothing more may be handed over
    const jobsAfter = await handOvers();
    check("Return the rest: nothing more is handed over (the step in flight finishes first)", jobsAfter === jobsAtReturn && jobsAfter <= 1, `${jobsAfter} hand-overs for this order (${jobsAtReturn} when Return was pressed)`);
    await snap(page, "steps-80k-returning");
    report.outcome.protectedSteps = { firstJob: firstJob?.id ?? null };
  }

  // 9. the viewport matrix: the shell screens per viewport, then under the pseudo-locale ---------------------------------------
  phase = "viewports";
  for (const v of VIEWPORTS) await shellPass(page, v, null);
  await shellPass(page, VIEWPORTS[0], "pseudo");
  await page.goto(WALLET, { waitUntil: "load" }); // the locale back to the preference
  await page.setViewportSize({ width: 430, height: 932 });

  // 9b. V6 Stage 15 (spec v2.0 §7.11, §8, §12.5, §14.3; doc §18, §74–§75, §83): the hardening, in the browser ----------------
  phase = "hardening";
  {
    // section 9 ended on a reload: the wallet is locked
    if ((await firstOf(page, { home: byId(page, "home"), lock: byId(page, "lock-screen") }, 120_000)) === "lock") await unlock(page);
    // pagehide locks at once; the unlock returns to the screen it interrupted
    await nav(page, "More"); await clickId(page, "more-privacy"); await byId(page, "privacy-center").waitFor({ timeout: 30_000 });
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await byId(page, "lock-screen").waitFor({ timeout: 30_000 });
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await clickId(page, "unlock");
    const back = await firstOf(page, { privacy: byId(page, "privacy-center"), home: byId(page, "home") }, 60_000);
    check("pagehide locks; the unlock returns to the screen it interrupted (spec v2.0 §8)", back === "privacy", `landed on ${back}`);

    // a minute idle under the 1-minute setting locks; back on the interrupted screen; 60 minutes again for the rest of the run
    await nav(page, "Home"); await clickId(page, "home-settings"); await byId(page, "settings").waitFor();
    await clickId(page, "auto-lock-1");
    await nav(page, "Activity"); await byId(page, "activity").waitFor();
    const idleStart = Date.now();
    await byId(page, "lock-screen").waitFor({ timeout: 120_000 });
    const idleS = Math.round((Date.now() - idleStart) / 1000);
    check("a minute without activity locks the wallet (the minutes chosen under Security)", idleS >= 55 && idleS <= 90, `${idleS} s`);
    await snap(page, "auto-locked");
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await clickId(page, "unlock");
    check("the unlock after an automatic lock returns to Activity", (await firstOf(page, { activity: byId(page, "activity"), home: byId(page, "home") }, 60_000)) === "activity");
    await nav(page, "Home"); await clickId(page, "home-settings"); await byId(page, "settings").waitFor();
    await clickId(page, "auto-lock-60");
    await clickId(page, "back"); await byId(page, "home").waitFor();

    // the wallet disconnects between the approval and the protect: nothing moves; the retry deposits exactly once
    if (stack.usdc) {
      const vaultBefore = await balanceUsdc(stack.usdc.vault);
      await openProtect(page, 1000, "USDC");
      await clickId(page, "protect-review");
      await waitReview(page);
      await page.evaluate(() => { window.__allowSends = 1; }); // the approval goes through, then the wallet is gone
      await confirmReview(page);
      await page.getByText(/disconnected/i).first().waitFor({ timeout: 120_000 });
      const said = await text(page.locator("main"));
      check("a wallet disconnected mid-Protect: the progress says so and that the funds have not moved (doc §74)", /disconnected/i.test(said) && /not moved|Nothing was sent/i.test(said), said.slice(0, 200));
      check("nothing reached the vault", (await balanceUsdc(stack.usdc.vault)) === vaultBefore);
      await snap(page, "protect-disconnected");
      await page.evaluate(() => { delete window.__allowSends; }); // reconnected
      await openProtect(page, 1000, "USDC");
      await clickId(page, "protect-review");
      await waitReview(page);
      await confirmReview(page);
      await byId(page, "protect-done").waitFor({ timeout: 180_000 });
      const gained = (await balanceUsdc(stack.usdc.vault)) - vaultBefore;
      check("the retry deposits exactly once: the vault gains 990 USDC (1,000 less the 1 %)", gained === 990_000_000n, `${gained} base units`);
    }

    // a tab closed: a new tab of the same profile opens on the lock screen; the journal is all there
    await nav(page, "Activity"); await byId(page, "activity").waitFor();
    const rowsBefore = await byId(page, "activity-row").count();
    await page.close();
    page = watch(await context.newPage());
    await page.goto(WALLET, { waitUntil: "load" });
    await unlock(page);
    await nav(page, "Activity"); await byId(page, "activity").waitFor();
    const rowsTab = await byId(page, "activity-row").count();
    check("a tab closed and opened again: unlock, and every Activity row is there (doc §74)", rowsTab === rowsBefore, `${rowsTab} of ${rowsBefore}`);

    // the browser restarted on the same profile: the same
    await context.close();
    context = await launchContext();
    await prepare(context);
    page = watch(context.pages()[0] ?? (await context.newPage()));
    await page.goto(WALLET, { waitUntil: "load" });
    await unlock(page);
    await nav(page, "Activity"); await byId(page, "activity").waitFor();
    const rowsRestart = await byId(page, "activity-row").count();
    check("the browser restarted: unlock, and every Activity row is there (doc §74)", rowsRestart === rowsBefore, `${rowsRestart} of ${rowsBefore}`);

    // a Send whose answer is lost as the network drops: the banner, nothing submitted offline, the one transaction found again
    phase = "offline-send";
    const jobsOf = async () => { const j = await (await fetch(`${RELAYER}/jobs`, { headers: { authorization: "Bearer local-stack" } })).json().catch(() => []); return Array.isArray(j) ? j.length : 0; }; // operator data: the token start-services.mjs sets
    const jobsBefore = await jobsOf();
    const { recipient: rOff, receive: receiveOff } = await sendPublic(page, 0.05);
    await clickId(page, "send-review");
    await waitReview(page);
    let dropped = false;
    await context.route(`${RELAYER}/submit`, async (route) => {
      if (dropped) return route.continue();
      dropped = true;
      const answered = await route.fetch(); // the relayer receives the submission and sends the transaction
      log(`the relayer answered ${answered.status()}; the answer is lost as the network drops`);
      await context.setOffline(true);
      await route.abort("internetdisconnected");
    });
    await confirmReview(page);
    await byId(page, "offline-banner").waitFor({ timeout: PROOF_TIMEOUT });
    const banner = await text(byId(page, "offline-banner"));
    check("offline: the banner's words (doc §75)", /Connection interrupted/.test(banner) && /being preserved/.test(banner) && /will not submit another transaction until the current state is verified/.test(banner), banner);
    await snap(page, "offline-banner");
    const submitsAt = requests.filter((r) => r.url === `${RELAYER}/submit`).length;
    await page.waitForTimeout(8_000);
    check("nothing is submitted while offline", requests.filter((r) => r.url === `${RELAYER}/submit`).length === submitsAt);
    await context.setOffline(false);
    await byId(page, "send-done").waitFor({ timeout: PROOF_TIMEOUT });
    await context.unroute(`${RELAYER}/submit`);
    const gotOff = await balanceEth(rOff);
    const newJobs = (await jobsOf()) - jobsBefore;
    check("back online: the one transaction is found by its nullifier — one relayer job, the recipient paid once (doc §74–§75)", newJobs === 1 && roundedDown(gotOff, receiveOff), `${newJobs} job(s); ${gotOff} ETH (shown ${receiveOff})`);
    check("the banner is gone once the state is verified", (await byId(page, "offline-banner").count()) === 0);
    await snap(page, "offline-send-done");

    // the proving key: downloaded once for the whole run — reloads, a tab closed and a browser restart included
    const zkeyDownloads = requests.filter((r) => r.url.includes("/transaction_final.zkey")).length;
    const cached = await page.evaluate(async () => { try { return (await (await caches.open("privacy-wallet-artifacts-v1")).keys()).map((k) => new URL(k.url).pathname); } catch (e) { return [String(e)]; } });
    check("the proving key downloaded once for every proof of the run, kept under its pin by the crypto worker (spec v2.0 §14.3)", zkeyDownloads === 1 && cached.some((x) => x.startsWith("/__artifact-cache/transaction_final.zkey/")), `${zkeyDownloads} download(s); cache: ${cached.join(", ")}`);
  }

  // 10. the leakage twin -------------------------------------------------------------------------------------------------------
  const words = phrase.split(/\s+/);
  const triples = words.slice(0, -2).map((_, i) => words.slice(i, i + 3).join(" "));
  const bodies = requests.filter((r) => r.body);
  const leaking = bodies.filter((r) => r.body.includes(PASSWORD) || triples.some((t) => r.body.includes(t)));
  check(`no request body carries the password or the phrase (${bodies.length} bodies read)`, leaking.length === 0, leaking.slice(0, 3).map((r) => r.url).join(", "));
  const storage = await page.evaluate(async () => {
    const out = { localStorage: localStorage.length, secure: [], shapes: [] };
    const db = await new Promise((res, rej) => { const r = indexedDB.open("privacy-wallet"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    await new Promise((res, rej) => {
      const tx = db.transaction("secure", "readonly"); const store = tx.objectStore("secure"); const req = store.openCursor();
      req.onsuccess = () => { const c = req.result; if (!c) return res(); out.secure.push(String(c.key)); try { const v = JSON.parse(typeof c.value === "string" ? c.value : c.value?.value ?? "{}"); out.shapes.push(Object.keys(v).sort().join(",")); } catch { out.shapes.push("unreadable"); } c.continue(); };
      req.onerror = () => rej(req.error);
    });
    db.close();
    return out;
  });
  check("localStorage holds nothing of ours; the secure store holds the two ciphertext blobs", storage.localStorage === 0 && storage.secure.sort().join(",") === "pp.journal,pp.keystore", JSON.stringify(storage));
  check("the stored blobs are ciphertext envelopes (a keystore with its KDF parameters, a journal {v, nonce, ct})", storage.shapes.every((s) => /ct/.test(s)), storage.shapes.join(" | "));

  const offOriginLater = requests.filter((r) => r.phase !== "first-launch").map((r) => new URL(r.url).host).filter(Boolean);
  report.hosts = [...new Set(offOriginLater)];
  log(`hosts contacted after first launch: ${report.hosts.join(", ")}`);
} catch (e) {
  report.failures.push(`exception: ${e.message}`);
  log(`EXCEPTION ${e.stack?.split("\n").slice(0, 3).join(" | ")}`);
  try { await snap(page, "exception"); } catch {}
} finally {
  report.finishedAt = new Date().toISOString();
  report.requests = requests.length;
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
  log(`${report.checks.filter((c) => c.ok).length}/${report.checks.length} checks passed; ${report.failures.length} failure(s)`);
  await context.close();
  process.exitCode = report.failures.length ? 1 : 0;
}
