// e2e.mjs — the end-to-end run of docs/local-run.md and the V2 plan's verification list, driven through a real
// browser against the local stack (the Hardhat devnet as chain id 1, deploy.mjs, start-services.mjs):
//   0. first launch: the lock screen, a wallet created, every tab and sheet — no request leaves the page's origin
//   1. Settings: the light client off (the devnet has no beacon chain), then the funding wallet connected
//   2. Add funds: two public deposits of 500 ETH (a $4.25M private balance at the mock price)
//   3. a $1K withdrawal to a fresh address: the unchanged standard flow (a proof in the Web Worker, the relayer submits)
//   4. a $120K withdrawal: the enhanced Review (lint + a tap)
//   5. an $850K swap ETH -> BTC (the enhanced tier: from $1M every order is a protected execution, section 8): the Review
//      at commit (five lines, lint, a tap; the single quote acknowledged when only one provider answered), Fund now (a
//      private withdrawal into the one-time escrow), the hard quote at
//      /prepare (a lower minimum needs consent; a hard quote the price guard refuses is retried against a fresh quote,
//      else the order is returned to the pool), the provider call checked and signed, the pre-trade simulation on both
//      RPC endpoints against the provider's real bytecode, the Review at execute (a tap), the hand-over, the executor,
//      the tracker
//   6. a reload: unlock, the open order comes back from the encrypted journal with its settlement line
//   7. Activity: every money flow has a row
//   8. V3 (High-Value Protection spec §14, §15): a $10M protected swap — a separate device registered through a virtual
//      authenticator (CDP), five more 500 ETH deposits, the protection line, the wizard, the campaign Review (maximum-loss
//      model, the paired verdict, the review hold), the password fallback for the second factor and the separate device, the
//      journaled campaign; the runner takes step 1 through commit → fund → sign → hand-over (deployAndExecute mined) while
//      step 2 waits; the dashboard; the global switch pauses; Return the rest winds down; a reload brings it back
// Output: run/e2e/NN-step.png screenshots and run/e2e/report.json (results/ keeps a committed report).
//
//   BROWSER_CHANNEL=msedge node e2e.mjs      the system Edge or Chrome (chrome); unset: Playwright's Chromium
//   HEADED=1 node e2e.mjs                    watch it
import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const stack = JSON.parse(readFileSync(join(HERE, "run", "stack.json"), "utf8"));
const OUT = process.argv[2] ?? join(HERE, "run", "e2e");
mkdirSync(OUT, { recursive: true });
const WALLET = "http://localhost:5173/"; // a hostname, not the IP: WebAuthn (the separate device, V3) refuses an IP origin as its RP ID
const RELAYER = "http://127.0.0.1:8790";
const PASSWORD = "a strong password for the local run";
const PRICE = stack.prices.ETH;
const CHANNEL = process.env.BROWSER_CHANNEL; // chrome | msedge | (unset: Playwright's Chromium)
const HEADLESS = process.env.HEADED ? false : true;
const PROOF_TIMEOUT = 420_000; // the first proof downloads the 31 MB key, then witness + proof in the worker
const RUN_START = Date.now();

const report = { startedAt: new Date().toISOString(), stack: { rpc: stack.rpc, core: stack.core, swapFactory: stack.swapFactory }, steps: [], checks: [], failures: [], outcome: {} };
let shot = 0;
const log = (msg) => { const line = `${new Date().toISOString().slice(11, 19)} ${msg}`; console.log(line); report.steps.push(line); };
const check = (name, ok, detail = "") => { report.checks.push({ name, ok: !!ok, detail }); log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); if (!ok) report.failures.push(name); };
async function snap(page, name) { const file = `${String(++shot).padStart(2, "0")}-${name}.png`; await page.screenshot({ path: join(OUT, file), fullPage: true }); return file; }
const rpc = async (method, params = []) => { const r = await fetch(stack.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }); const j = await r.json(); if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result; };
const balanceEth = async (address) => Number(BigInt(await rpc("eth_getBalance", [address, "latest"]))) / 1e18;
const usd = (n) => "$" + Math.round(n).toLocaleString("en-US");
const usdRe = (n, prefix = "≈ ") => new RegExp(prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\$" + Math.round(n).toLocaleString("en-US").replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(\\.\\d{1,2})?(?!\\d)");
const text = async (locator) => ((await locator.textContent()) ?? "").replace(/\s+/g, " ");
/** the relayer's swap jobs created by this run (its journal keeps earlier runs' jobs) */
async function jobsOfThisRun() {
  const jobs = await (await fetch(`${RELAYER}/swap`, { headers: { authorization: "Bearer local-stack" } })).json().catch(() => null); // the operator token start-services.mjs sets
  const list = Array.isArray(jobs) ? jobs : Array.isArray(jobs?.jobs) ? jobs.jobs : Object.values(jobs ?? {});
  return list.filter((j) => j && Number(j.createdAt ?? j.updatedAt ?? 0) >= RUN_START - 60_000).sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0));
}

// --- helpers over the page -------------------------------------------------------------------------------------------
const button = (page, name) => page.getByRole("button", { name, exact: true });
async function clickButton(page, name, opts = {}) { const b = button(page, name); await b.first().waitFor({ state: "visible", timeout: opts.timeout ?? 30_000 }); await b.first().click(); }
async function textAppears(page, t, timeout = 30_000) { await page.getByText(t, { exact: false }).first().waitFor({ state: "visible", timeout }); }
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
async function hold(page, ms = 2400) { // the hold to confirm (whale spec §24): a pointer hold of HOLD_MS (1.5 s), never a tap
  const b = page.getByTestId("hold-to-confirm");
  await b.waitFor({ state: "visible", timeout: 30_000 });
  for (let i = 0; i < 50 && (await b.isDisabled()); i++) await page.waitForTimeout(200);
  if (await b.isDisabled()) throw new Error(`the hold is still disabled: ${await b.getAttribute("title")}`);
  await b.scrollIntoViewIfNeeded();
  const box = await b.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}
/** the Review's confirmation: a hold from high-value, a tap below it */
async function confirmReview(page) {
  if (await page.getByTestId("hold-to-confirm").count()) return hold(page);
  const tap = page.getByTestId("confirm-tap");
  for (let i = 0; i < 50 && (await tap.isDisabled()); i++) await page.waitForTimeout(200);
  await tap.click();
}
/** waits for the first of several locators; returns its key */
async function firstOf(page, candidates, timeout) {
  return Promise.any(Object.entries(candidates).map(([key, loc]) => loc.first().waitFor({ state: "visible", timeout }).then(() => key)));
}
async function launch() {
  // Chrome 154's new headless mode does not come up under Playwright 1.64 here; its old headless shell does
  const args = CHANNEL === "chrome" && HEADLESS ? ["--headless=old"] : [];
  const opts = { headless: HEADLESS, timeout: 30_000, args, ...(CHANNEL ? { channel: CHANNEL } : {}) };
  return chromium.launch(opts);
}

// --- V3: the protected swap ------------------------------------------------------------------------------------------
/** The amounts the progress panel shows, in ETH (its lines read "<n> ETH (≈ $x)"). */
async function panelAmounts(page) {
  const out = {};
  for (const key of ["completed", "in-flight", "protected", "remaining"]) {
    const t = await text(page.locator(`[data-amount="${key}"]`));
    out[key] = Number((t.match(/^([0-9.]+) ETH/) ?? [])[1] ?? NaN);
  }
  return out;
}
async function campaignRun(page, nav, swap) {
  const CAMPAIGN_ETH = Math.ceil(10_000_000 / PRICE); // $10M at the mock price: institutional
  // the separate device (spec §14): a virtual cross-platform authenticator through CDP stands in for a security key
  let deviceOk = false;
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "usb", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    deviceOk = true;
  } catch (e) { log(`no virtual authenticator (${e.message}); the institutional confirmation cannot be given here`); }
  await nav.getByRole("button", { name: "Home", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByTestId("protected-execution").waitFor();
  await page.getByTestId("protected-execution").scrollIntoViewIfNeeded();
  await snap(page, "settings-protected-execution");
  if (deviceOk) {
    await page.getByTestId("register-second-device").click();
    await textAppears(page, "Registered. Operations at the institutional size", 60_000);
  }
  const deviceLine = await text(page.getByTestId("protected-execution"));
  check("Settings → Protected execution: the three modes, the exposure fraction, the switch; the separate device registered (a virtual cross-platform authenticator)", /Balanced/.test(deviceLine) && /Maximum safety/.test(deviceLine) && /registered/.test(deviceLine), deviceLine.match(/Second device[^R]{0,60}/)?.[0]);
  // Advanced on: the dashboard and the per-step lines
  await page.locator("label", { hasText: "Show the cryptographic detail" }).locator('input[type="checkbox"]').check();
  await clickButton(page, "Close");
  // five more deposits: the private balance reaches the order
  await clickButton(page, "Add funds");
  const shieldAmount = page.locator('[data-testid="shield"] input');
  const before = await balanceEth(stack.ethVault);
  for (const i of [1, 2, 3, 4, 5]) {
    await shieldAmount.fill("500");
    await clickButton(page, "Shield");
    for (let t = 0; t < 120 && (await balanceEth(stack.ethVault)) < before + 500 * i - 1e-9; t++) await page.waitForTimeout(1000);
    await page.getByText(/Added 500 ETH to your private balance[.]|Shielded 500 ETH — note at leaf/).first().waitFor({ timeout: 180_000 }); // Advanced is on: the Shield screen names the leaf
    log(`campaign deposit ${i}: 500 ETH shielded`);
  }
  await clickButton(page, "Close");
  // the quote: the protection line
  await nav.getByRole("button", { name: "Swap", exact: true }).click();
  await swap.locator('input[inputmode="decimal"]').fill(String(CAMPAIGN_ETH));
  await swap.locator("select").selectOption("BTC");
  await page.getByText(usdRe(CAMPAIGN_ETH * PRICE)).first().waitFor({ timeout: 30_000 });
  let lineText = "";
  for (let attempt = 1; attempt <= 3 && !lineText; attempt++) {
    await clickButton(page, "Get a quote");
    await page.getByTestId("quote").waitFor({ timeout: 240_000 });
    lineText = (await page.getByTestId("protection-line").count()) ? await text(page.getByTestId("protection-line")) : "";
    if (!lineText) { log(`quote attempt ${attempt}: no protection line — ${(await text(page.getByTestId("quote"))).slice(0, 200)}`); await page.waitForTimeout(5000); }
  }
  check("the protection line under the quote: steps, one at a time, at most $X at risk, the duration", /Protected execution: about \d+ steps of ≈ \$[\d.,]+[KM]? · one at a time · at most \$[\d.,]+[KM]? at risk · about /.test(lineText), lineText);
  await snap(page, "campaign-quote");
  await acknowledgeAll(page);
  await clickButton(page, "Review");
  // the wizard
  const wizard = page.getByTestId("campaign-wizard");
  await wizard.waitFor({ timeout: 30_000 });
  const risk = await text(page.getByTestId("wizard-risk"));
  await snap(page, "wizard-risk");
  await page.getByTestId("wizard-next").click();
  const privacy = await text(page.getByTestId("wizard-privacy"));
  await acknowledgeAll(page);
  await snap(page, "wizard-privacy");
  await page.getByTestId("wizard-next").click();
  const dest = await text(page.getByTestId("wizard-destination"));
  await snap(page, "wizard-destination");
  check("the wizard: risk analysis (class, security, steps, at most at risk, ELPF, concentration) → privacy analysis (what a protected execution reveals, the lint) → destination check (a fresh address per step)", /class R\d/.test(risk) && /Expected loss per failure/.test(risk) && /What a protected execution reveals/.test(privacy) && /its own fresh address/.test(dest), risk.slice(0, 200));
  await page.getByTestId("wizard-next").click();
  const review = page.getByTestId("review");
  await review.waitFor({ timeout: 30_000 });
  const reviewText = await text(review);
  const loss = (await page.getByTestId("maximum-loss").count()) ? await text(page.getByTestId("maximum-loss")) : "";
  const verdict = (await page.getByTestId("verdict").count()) ? await text(page.getByTestId("verdict")) : "";
  check("the campaign Review: the maximum-loss model, the paired SECURITY + PRIVACY verdict, the Exposure and Security lines, the review hold, a hold to confirm", (await review.getAttribute("data-moment")) === "campaign" && /In-flight cap/.test(loss) && /Remaining protected/.test(loss) && /Security/.test(verdict) && /Privacy/.test(verdict) && /Exposure bounded/.test(reviewText) && /Security assessed/.test(reviewText) && /Review hold: after you confirm, the funding waits at least 1 minute/.test(reviewText) && (await page.getByTestId("hold-to-confirm").count()) === 1, `${loss.slice(0, 160)} | ${verdict.slice(0, 120)}`);
  await acknowledgeAll(page);
  await clickButton(page, "Advanced details");
  await snap(page, "campaign-review");
  await hold(page);
  // the second factor: no platform authenticator registered → the password; then the separate device (automatic presence)
  await page.getByTestId("second-factor-password").waitFor({ timeout: 30_000 });
  await page.locator('[data-testid="second-factor-password"] input').fill(PASSWORD);
  await clickButton(page, "Confirm with the password");
  const progress = page.getByTestId("campaign-progress");
  const started = await Promise.any([progress.waitFor({ timeout: 120_000 }).then(() => true), page.getByTestId("second-device-error").waitFor({ timeout: 120_000 }).then(() => false)]).catch(() => false);
  if (!started) { check("the institutional confirmation: the separate device after the password", false, (await page.getByTestId("second-device-error").textContent().catch(() => "")) ?? ""); return; }
  let step = (await page.getByTestId("campaign-step").getAttribute("data-step")) ?? "";
  let amounts = await panelAmounts(page);
  check(`the campaign is journaled and shown: step ${step}, ✓ Protected, Completed 0, In progress 0, the rest protected`, step === "1" && (await text(page.getByTestId("campaign-status"))) === "✓ Protected" && amounts.completed === 0 && amounts["in-flight"] === 0 && amounts.protected > 0, JSON.stringify(amounts));
  await snap(page, "campaign-started");
  // the runner (the App-level scheduler, this tab open): the review hold (1 min), then step 1 through commit → fund → sign → hand-over
  let tranche1 = "", reroutes = 0;
  for (let i = 0; i < 150 && !/executing|waiting for finality|settled/.test(tranche1); i++) {
    await page.waitForTimeout(4000);
    // the competition at the step's size may choose another provider than the whole order's: a route change is reviewed (spec §8)
    if ((await progress.getAttribute("data-state")) === "rerouting") {
      reroutes++;
      const note = await text(page.getByTestId("campaign-reroute"));
      log(`reroute ${reroutes}: ${note.slice(0, 120)}`);
      await page.getByTestId("campaign-reroute-button").click();
      await review.waitFor({ timeout: 30_000 });
      check("a route change at the step's size goes through the reroute Review (the same bounds, the new route's class and gate, a hold, the second factor and the separate device again)", (await review.getAttribute("data-moment")) === "reroute" && /Exposure bounded/.test(await text(review)) && (await page.getByTestId("hold-to-confirm").count()) === 1, note.slice(0, 160));
      await snap(page, "campaign-reroute-review");
      await acknowledgeAll(page);
      await hold(page);
      await page.getByTestId("second-factor-password").waitFor({ timeout: 30_000 });
      await page.locator('[data-testid="second-factor-password"] input').fill(PASSWORD);
      await clickButton(page, "Confirm with the password");
      await progress.waitFor({ timeout: 120_000 });
      continue;
    }
    tranche1 = (await page.locator('[data-tranche="0"]').count()) ? await text(page.locator('[data-tranche="0"]')) : "";
    if (i % 15 === 14) log(`step 1: ${tranche1 || "(not visible)"} · ${await text(page.getByTestId("campaign-status"))}`);
  }
  report.outcome.reroutes = reroutes;
  amounts = await panelAmounts(page);
  const job = (await jobsOfThisRun()).find((j) => j.executionTx && Number(j.updatedAt ?? 0) > RUN_START);
  const receipt = job ? await rpc("eth_getTransactionReceipt", [job.executionTx]) : null;
  check("step 1 funded, signed and handed over by the runner: the executor's deployAndExecute is mined, the one-time escrow is empty", /executing|waiting for finality|settled/.test(tranche1) && receipt?.status === "0x1" && job && (await balanceEth(job.escrow)) === 0, `${tranche1} · ${job?.executionTx ?? "no job"}`);
  const tranche2 = (await page.locator('[data-tranche="1"]').count()) ? await text(page.locator('[data-tranche="1"]')) : "";
  const capEth = Number((await text(swap)).match(/At most ([0-9.]+) ETH/)?.[1] ?? NaN);
  check("step 2 waits while step 1 is unsettled: In progress = one step ≤ the cap, Completed 0, Protected = the rest; ● Processing", /waiting/.test(tranche2) && amounts.completed === 0 && amounts["in-flight"] > 0 && amounts["in-flight"] <= capEth + 1e-9 && amounts.protected > 0 && (await text(page.getByTestId("campaign-status"))) === "● Processing", `${JSON.stringify(amounts)} cap ${capEth} · step 2: ${tranche2}`);
  const dashboard = (await page.getByTestId("exposure-dashboard").count()) ? await text(page.getByTestId("exposure-dashboard")) : "";
  check("the exposure dashboard (Advanced): order, in flight, maximum allowed, provider exposure, the per-step table, ELPF", /Maximum allowed/.test(dashboard) && /Provider exposure/.test(dashboard) && /Expected loss per failure/.test(dashboard) && (await page.locator("[data-tranche]").count()) >= 2, dashboard.slice(0, 200));
  await snap(page, "campaign-executing");
  // the global switch: every campaign's automation pauses; the executed step is still tracked
  await nav.getByRole("button", { name: "Home", exact: true }).click();
  await page.getByTestId("campaign-line").waitFor({ timeout: 30_000 });
  await page.getByTestId("pause-large-operations").first().check();
  let homeLine = "";
  for (let i = 0; i < 30 && !/⚠ Review/.test(homeLine); i++) { await page.waitForTimeout(2000); homeLine = await text(page.getByTestId("campaign-line")); }
  check("Pause large operations (Home): the campaign pauses on the next tick and Home says ⚠ Review", /⚠ Review/.test(homeLine), homeLine.slice(0, 160));
  await snap(page, "campaign-paused-by-switch");
  await page.getByTestId("pause-large-operations").first().uncheck();
  // Return the rest: the planned steps are skipped; the executed step finishes on its own
  await nav.getByRole("button", { name: "Swap", exact: true }).click();
  await textAppears(page, "Your protected swaps", 30_000);
  await clickButton(page, "Open");
  await progress.waitFor({ timeout: 30_000 });
  await page.getByTestId("campaign-cancel-button").click();
  let state = "";
  for (let i = 0; i < 20 && state !== "winding-down"; i++) { await page.waitForTimeout(500); state = (await progress.getAttribute("data-state")) ?? ""; }
  const skipped = await page.locator('[data-tranche-state="skipped"]').count();
  check("Return the rest: the campaign winds down, the planned steps are skipped, the executed step is tracked until it settles", state === "winding-down" && skipped >= 1 && /executing|waiting for finality|settled/.test(await text(page.locator('[data-tranche="0"]'))), `${state} · ${skipped} skipped`);
  await snap(page, "campaign-returning");
  // a reload: the campaign comes back from the journal
  await page.reload({ waitUntil: "load" });
  await page.getByTestId("lock-screen").waitFor({ timeout: 120_000 });
  await page.locator('input[type="password"]').fill(PASSWORD);
  await clickButton(page, "Unlock");
  await page.getByTestId("home").waitFor({ timeout: 60_000 });
  await nav.getByRole("button", { name: "Swap", exact: true }).click();
  await textAppears(page, "Your protected swaps", 60_000);
  await clickButton(page, "Open");
  await progress.waitFor({ timeout: 30_000 });
  step = (await page.getByTestId("campaign-step").getAttribute("data-step")) ?? "";
  check("after a reload and unlock the campaign, its steps and its state come back from the encrypted journal", step === "1" && (await progress.getAttribute("data-state")) === "winding-down" && (await page.locator("[data-tranche]").count()) >= 2, `${step} · ${await progress.getAttribute("data-state")}`);
  await snap(page, "campaign-after-reload");
  await nav.getByRole("button", { name: "Activity", exact: true }).click();
  await page.getByTestId("activity").waitFor();
  const activity = await text(page.getByTestId("activity"));
  check("Activity: one row for the protected swap (its steps under Advanced), never a bare failed", /Protected swap/.test(activity) && !/\bfailed\b/i.test(activity), activity.match(/Protected swap[^·]{0,80}/)?.[0]);
  await snap(page, "campaign-activity");
}

// --- the run ------------------------------------------------------------------------------------------------------------
const browser = await launch();
log(`browser ${browser.version()} (${CHANNEL ?? "playwright chromium"}, ${HEADLESS ? "headless" : "headed"})`);
const context = await browser.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
// the injected funding wallet: an EIP-1193 provider over one of the devnet's unlocked accounts (what MetaMask would be here)
await context.addInitScript(({ rpcUrl, account }) => {
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
      if (method === "eth_sendTransaction") return call("eth_sendTransaction", [{ ...params[0], from: account }]);
      return call(method, params);
    },
    on() { return this; }, removeListener() { return this; },
  };
}, { rpcUrl: stack.rpc, account: stack.funding });

const requests = []; // every request the page makes, with the phase it happened in
let phase = "first-launch";
context.on("request", (r) => requests.push({ phase, url: r.url(), method: r.method() }));
const page = await context.newPage();
page.on("pageerror", (e) => log(`page error: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") log(`console error: ${m.text().slice(0, 200)}`); });

try {
  // 0. first launch ----------------------------------------------------------------------------------------------------
  await page.goto(WALLET, { waitUntil: "load", timeout: 180_000 });
  await page.getByTestId("lock-screen").waitFor({ timeout: 120_000 });
  log("lock screen shown");
  await snap(page, "lock-screen");
  const pw = page.locator('input[type="password"]');
  await pw.nth(0).fill(PASSWORD);
  await pw.nth(1).fill(PASSWORD);
  await clickButton(page, "Create wallet");
  await page.getByTestId("recovery-phrase").waitFor({ timeout: 120_000 });
  const phrase = (await page.locator('[data-testid="recovery-phrase"] code').textContent()).trim();
  check("the recovery phrase has 24 words", phrase.split(/\s+/).length === 24);
  await snap(page, "recovery-phrase");
  await page.locator('input[type="checkbox"]').check();
  await clickButton(page, "Continue");
  await page.getByTestId("home").waitFor({ timeout: 60_000 });
  check("Home shows no USD before any balance", (await page.getByTestId("private-usd").textContent()).trim() === "—");
  await snap(page, "home-empty");
  const nav = page.locator("nav");
  for (const tab of ["Swap", "Send", "Activity", "Home"]) {
    await nav.getByRole("button", { name: tab, exact: true }).click();
    if (tab === "Send") { await clickButton(page, "To a public address"); await page.getByTestId("withdraw").waitFor(); }
    if (tab === "Activity") await textAppears(page, "Nothing yet");
  }
  for (const [open, testId] of [["Add funds", "sheet-add-funds"], ["Receive", "sheet-receive"]]) { await clickButton(page, open); await page.getByTestId(testId).waitFor(); await clickButton(page, "Close"); }
  await page.getByTestId("privacy-badge").click(); await page.getByTestId("privacy-center").waitFor(); await clickButton(page, "Close");
  await page.getByRole("button", { name: "Settings", exact: true }).click(); await page.getByTestId("settings").waitFor(); await snap(page, "settings"); await clickButton(page, "Close");
  await clickButton(page, "Details"); await textAppears(page, "Private ETH");
  const offOrigin = requests.filter((r) => r.phase === "first-launch" && !r.url.startsWith(WALLET));
  check("first launch: no request left the page's origin (creating a wallet, every tab and sheet)", offOrigin.length === 0, offOrigin.length ? offOrigin.slice(0, 5).map((r) => r.url).join(", ") : `${requests.length} same-origin loads`);
  await snap(page, "home-details");

  // 1. settings: the light client off (chain id 1 has one, the devnet no beacon chain) -------------------------------------
  phase = "settings";
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const lc = page.locator("label", { hasText: "Verify the pool with the Ethereum light client" }).locator('input[type="checkbox"]');
  await lc.uncheck();
  await textAppears(page, "Off: the pool is read from the RPC endpoints");
  check("Settings: the light client is off and says so", true);
  await clickButton(page, "Close");

  // 2. add funds: two public deposits of 500 ETH --------------------------------------------------------------------------
  phase = "shield";
  await clickButton(page, "Add funds");
  await clickButton(page, "Connect wallet");
  await textAppears(page, `Connected: ${stack.funding.slice(0, 6)}`);
  const shieldAmount = page.locator('[data-testid="shield"] input');
  const vaultBefore = await balanceEth(stack.ethVault); // the devnet keeps earlier runs' deposits
  for (const i of [1, 2]) {
    await shieldAmount.fill("500");
    await clickButton(page, "Shield");
    for (let t = 0; t < 120 && (await balanceEth(stack.ethVault)) < vaultBefore + 500 * i - 1e-9; t++) await page.waitForTimeout(1000); // the deposit mined
    await page.getByText("Added 500 ETH to your private balance.").waitFor({ timeout: 180_000 }); // the wallet saw the receipt and journaled the note
    log(`deposit ${i}: 500 ETH shielded (vault ${await balanceEth(stack.ethVault)} ETH)`);
    if (i === 1) await snap(page, "shielded-500");
  }
  const vaultBalance = await balanceEth(stack.ethVault);
  check("the ETH vault received the two deposits", Math.abs(vaultBalance - vaultBefore - 1000) < 1e-9, `${vaultBefore} → ${vaultBalance} ETH`);
  await clickButton(page, "Close");
  await page.getByText(usdRe(1000 * PRICE)).first().waitFor({ timeout: 60_000 });
  check(`Home values the private balance through the RPC quorum: ≈ ${usd(1000 * PRICE)}`, true);
  await snap(page, "home-funded");

  // 3. a $1K withdrawal: the unchanged standard flow ------------------------------------------------------------------------
  phase = "withdraw-1k";
  await nav.getByRole("button", { name: "Send", exact: true }).click();
  await clickButton(page, "To a public address");
  const withdraw = page.getByTestId("withdraw");
  const recipient1 = await withdraw.locator("input").nth(0).inputValue();
  await withdraw.locator('input[inputmode="decimal"]').fill("0.2");
  await page.getByText(usdRe(0.2 * PRICE)).first().waitFor({ timeout: 30_000 });
  check("a $850 withdrawal is the plain flow (a Withdraw button, no Review)", (await button(page, "Withdraw").count()) === 1 && (await button(page, "Review").count()) === 0);
  await snap(page, "withdraw-1k");
  await clickButton(page, "Withdraw");
  await page.getByText(/^Withdrawn 0\.2 ETH to 0x/).waitFor({ timeout: PROOF_TIMEOUT });
  const got1 = await balanceEth(recipient1);
  check("the fresh recipient received 0.2 ETH from the vault, submitted by the relayer", Math.abs(got1 - 0.2) < 1e-9, `${recipient1}: ${got1} ETH`);
  await snap(page, "withdrawn-1k");

  // 4. a $120K withdrawal: the enhanced Review ------------------------------------------------------------------------------
  phase = "withdraw-120k";
  const recipient2 = await withdraw.locator("input").nth(0).inputValue();
  check("the next withdrawal pre-fills the next fresh address", recipient2.toLowerCase() !== recipient1.toLowerCase(), recipient2);
  await withdraw.locator('input[inputmode="decimal"]').fill("28");
  await page.getByText(usdRe(28 * PRICE)).first().waitFor({ timeout: 30_000 });
  await textAppears(page, "A large withdrawal: it is reviewed before it is sent.");
  await clickButton(page, "Review");
  await page.getByTestId("review").waitFor();
  check("the enhanced Review shows the USD numeral", (await page.getByTestId("review-usd").textContent()).includes(usd(28 * PRICE)), await page.getByTestId("review-usd").textContent());
  check("the enhanced Review carries the privacy lint", (await page.getByTestId("privacy-lint").count()) >= 1);
  check("enhanced: a tap confirms (no hold)", (await page.getByTestId("confirm-tap").count()) === 1 && (await page.getByTestId("hold-to-confirm").count()) === 0);
  await snap(page, "review-120k");
  await acknowledgeAll(page);
  await page.getByTestId("confirm-tap").click();
  await page.getByText(/^Withdrawn 28 ETH to 0x/).waitFor({ timeout: PROOF_TIMEOUT });
  const got2 = await balanceEth(recipient2);
  check("the second fresh recipient received 28 ETH", Math.abs(got2 - 28) < 1e-9, `${recipient2}: ${got2} ETH`);
  await snap(page, "withdrawn-120k");

  // 5. the $850K swap (the single-order flow; a $1M+ order is a protected execution: section 8) ------------------------------
  phase = "swap";
  await nav.getByRole("button", { name: "Swap", exact: true }).click();
  const swap = page.getByTestId("swap");
  await swap.locator('input[inputmode="decimal"]').fill("200");
  await swap.locator("select").selectOption("BTC");
  await page.getByText(usdRe(200 * PRICE)).first().waitFor({ timeout: 30_000 });
  const destination = await swap.locator('input[placeholder="fresh address"]').inputValue();
  check("the destination is a fresh Bitcoin address of this wallet", /^bc1q[0-9a-z]{38,}$/.test(destination), destination);
  // the competition is live: when only one provider answered, a user asks again (the single quote can still be accepted)
  let quoteText = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    await clickButton(page, "Get a quote");
    await page.getByTestId("quote").waitFor({ timeout: 180_000 });
    quoteText = await text(page.getByTestId("quote"));
    const single = /Only one provider answered/.test(quoteText);
    log(`quote attempt ${attempt}: ${single ? "a single quote" : "two or more quotes"} — ${quoteText.slice(0, 260)}`);
    if (!single) break;
    await page.waitForTimeout(5000);
  }
  check("one route in plain words: Best route Automatic", quoteText.includes("Best route") && quoteText.includes("Automatic"));
  check("the fee line is in asset units, never base units", /Fee ?(\$[0-9.,]+|[0-9]+\.[0-9]+ [A-Z]+( \+ [0-9]+\.[0-9]+ [A-Z]+)*|included in the rate|n\/a)/.test(quoteText), quoteText.match(/Fee ?[^A-Z]*[A-Za-z$][^D]{0,60}/)?.[0]);
  await clickButton(page, "Route details");
  await snap(page, "swap-quote");
  const ackBefore = await acknowledgeAll(page);
  log(`acknowledged ${ackBefore} privacy items before the Review`);
  check("enhanced: the commit goes through a Review (no protection line below $1M)", (await button(page, "Review").count()) === 1 && (await page.getByTestId("protection-line").count()) === 0);
  await clickButton(page, "Review");
  const review = page.getByTestId("review");
  await review.waitFor();
  check("the Review is the commit moment", (await review.getAttribute("data-moment")) === "commit");
  check("the Review shows $850,000", (await page.getByTestId("review-usd").textContent()).includes(usd(200 * PRICE)), await page.getByTestId("review-usd").textContent());
  const reviewText = await text(review);
  check("the five lines are there", ["Price protected", "Route checked", "Destination verified", "Slippage checked", "Privacy reviewed"].every((l) => reviewText.includes(l)), reviewText.slice(0, 300));
  check("the Route line names the competition (quoted by 2+ providers, or the single quote)", /\d+ providers quoted this size|only one provider answered/i.test(reviewText), reviewText.match(/Route checked[^✓]{0,160}/)?.[0]);
  const ackIn = await acknowledgeAll(page);
  log(`acknowledged ${ackIn} items inside the Review`);
  await clickButton(page, "Advanced details");
  await page.getByTestId("route-details").waitFor();
  const details = await text(page.getByTestId("route-details"));
  check("Advanced details list the provider, the mode, the fees and the alternatives", /Provider/.test(details) && /Fees/.test(details), details.slice(0, 300));
  await snap(page, "review-commit");
  check("enhanced: a tap confirms the commit (the hold starts at high-value, where every order is a protected execution)", (await page.getByTestId("confirm-tap").count()) === 1 && (await page.getByTestId("hold-to-confirm").count()) === 0);
  await confirmReview(page);
  // after the commit the order panel shows the scheduled funding (or, after a reload, the open-swaps list with Open)
  await page.locator('button:has-text("Fund now"), label:has-text("Your open swaps")').first().waitFor({ timeout: 90_000 });
  if ((await page.getByRole("button", { name: /Fund now/ }).count()) === 0) await clickButton(page, "Open");
  const panel = await text(swap);
  check("the funding is scheduled at a random time inside the policy window", /Funding scheduled/.test(panel), panel.match(/Funding scheduled[^)]*\)/)?.[0] ?? panel.slice(0, 200));
  log("committed: the order is journaled and its funding scheduled");
  await snap(page, "committed");
  // the funding: the scheduled time is hours away; Fund now runs the private withdrawal into the escrow at once
  const fundNow = page.getByRole("button", { name: /Fund now/ });
  await fundNow.waitFor({ timeout: 30_000 });
  check("Fund now is offered (no institutional hold at this tier)", !(await fundNow.isDisabled()));
  await fundNow.click();
  const confirmSwap = button(page, "2 · Confirm the swap");
  await confirmSwap.waitFor({ timeout: PROOF_TIMEOUT });
  for (let i = 0; i < PROOF_TIMEOUT / 1000 && (await confirmSwap.isDisabled()); i++) await page.waitForTimeout(1000);
  check("the escrow is funded by a private withdrawal (2 · Confirm the swap enabled)", !(await confirmSwap.isDisabled()));
  log(`after funding: ${(await text(swap)).match(/Funded[^R]{0,80}/)?.[0] ?? ""}`);
  await snap(page, "funded");

  // the confirmation: the hard quote at /prepare, the wallet's check of the provider call, the signature, the simulation,
  // then the Review at execute. A lower minimum needs consent (§14); a hard quote the price guard refuses (§14) is retried
  // against a fresh quote, as a user would; when the market keeps refusing, the order goes back to the private balance.
  let executed = false, refusals = 0;
  const consent = page.getByRole("button", { name: "Confirm at the new minimum", exact: true });
  const refusal = page.getByText(/bps below the best alternative .*; refusing to sign/i); // the guard's own sentence, not the standing high-value notice
  for (let attempt = 1; attempt <= 4 && !executed; attempt++) {
    await confirmSwap.click();
    let outcome = await firstOf(page, { review, consent, refusal }, 240_000);
    if (outcome === "consent") {
      const moved = (await text(swap)).match(/The price moved[^]*?Nothing has been signed\./)?.[0] ?? "";
      check("a lower hard quote asks for consent before anything is signed (§14)", /you approved [0-9.]+ BTC/.test(moved), moved.slice(0, 200));
      await snap(page, "minimum-moved");
      await consent.click();
      outcome = await firstOf(page, { review, refusal }, 240_000);
    }
    if (outcome === "refusal") {
      refusals++;
      const why = (await text(refusal)).slice(0, 200);
      check(`the price guard refused a worse hard quote and nothing was signed (attempt ${attempt})`, /bps below the best alternative/.test(why), why);
      if (attempt === 1) await snap(page, "price-guard-refusal");
      await page.waitForTimeout(20_000);
      continue;
    }
    check("the Review is the execute moment", (await review.getAttribute("data-moment")) === "execute");
    const routeLine = await text(page.locator('[data-line="route"]'));
    check("the signed execution was simulated on every RPC endpoint before the hand-over", /simulated on 2 RPC endpoints: it executes/.test(routeLine), routeLine);
    const priceLine = await text(page.locator('[data-line="price"]'));
    check("the price line states the guaranteed minimum", /guarantees at least [0-9.]+ BTC/.test(priceLine), priceLine);
    await snap(page, "review-execute");
    await acknowledgeAll(page);
    await confirmReview(page);
    await textAppears(page, "Checked by this wallet before signing", 120_000);
    await snap(page, "handed-over");
    executed = true;
  }
  report.outcome.priceGuardRefusals = refusals;
  if (executed) {
    // the executor: the relayer deploys the escrow's execution and the tracker reports it
    let state = "";
    for (let i = 0; i < 90; i++) {
      const t = await text(swap);
      if (/Executing|Waiting for destination|Completed|Partial/.test(t)) { state = t.match(/Executing|Waiting for destination|Completed|Partial/)[0]; break; }
      await page.waitForTimeout(2000);
    }
    check("the settlement line reports the execution", state !== "", state || (await text(swap)).slice(0, 300));
    const job = (await jobsOfThisRun()).find((j) => j.executionTx);
    if (job) {
      const receipt = await rpc("eth_getTransactionReceipt", [job.executionTx]);
      check("the executor's deployAndExecute is mined on the devnet", receipt?.status === "0x1", `${job.executionTx} in block ${receipt ? Number(receipt.blockNumber) : "?"} (${receipt?.logs?.length ?? 0} logs)`);
      const escrowBalance = await balanceEth(job.escrow);
      check("the one-time escrow is empty after the execution", escrowBalance === 0, `${job.escrow}: ${escrowBalance} ETH`);
      report.outcome.execution = { orderId: job.id, escrow: job.escrow, executionTx: job.executionTx, provider: job.provider ?? null };
    } else check("the relayer reports this run's executed job", false, JSON.stringify(await jobsOfThisRun()).slice(0, 300));
    await snap(page, "executing");
  } else {
    // the market kept the chosen route more than the cap below the best alternative: the funded order goes back to the pool
    log("the price guard refused every attempt: returning the order to the private balance");
    await clickButton(page, "Return to my private balance");
    await textAppears(page, "Returning to your private balance", 120_000);
    const job = (await jobsOfThisRun()).find((j) => j.state === "refund-only");
    check("a refund-only job with no signature is journaled by the relayer (§20)", !!job, job ? `${job.id} escrow ${job.escrow}` : JSON.stringify(await jobsOfThisRun()).slice(0, 200));
    report.outcome.returned = job ? { orderId: job.id, escrow: job.escrow } : true;
    await snap(page, "returned-to-balance");
  }

  // 6. a reload: unlock, the order comes back from the encrypted journal -----------------------------------------------------
  phase = "reload";
  await page.reload({ waitUntil: "load" });
  await page.getByTestId("lock-screen").waitFor({ timeout: 120_000 });
  await page.locator('input[type="password"]').fill(PASSWORD);
  await clickButton(page, "Unlock");
  await page.getByTestId("home").waitFor({ timeout: 60_000 });
  await nav.getByRole("button", { name: "Swap", exact: true }).click();
  await textAppears(page, "Your open swaps", 60_000);
  await clickButton(page, "Open");
  const lineRe = executed ? /Executing|Waiting for destination|Completed|Partial/ : /Refunding|Refunded|Returning|refund/i;
  await page.getByText(lineRe).first().waitFor({ timeout: 120_000 });
  check("after a reload and unlock the open order and its settlement line come back from the journal", true, (await text(swap)).match(/Status[^✓]{0,80}/)?.[0]);
  await snap(page, "after-reload");

  // 7. Activity --------------------------------------------------------------------------------------------------------------
  phase = "activity";
  await nav.getByRole("button", { name: "Activity", exact: true }).click();
  await page.getByTestId("activity").waitFor();
  const rows = await page.getByTestId("activity-row").count();
  check("Activity lists every money flow (two deposits, two withdrawals, one swap)", rows >= 5, `${rows} rows`);
  await snap(page, "activity");
  const activityText = await text(page.getByTestId("activity"));
  check("the swap row never says a bare failed", !/\bfailed\b/i.test(activityText), activityText.slice(0, 300));

  // 8. the $10M protected swap (V3) --------------------------------------------------------------------------------------
  phase = "campaign";
  await campaignRun(page, nav, swap);

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
  await browser.close();
  process.exitCode = report.failures.length ? 1 : 0;
}
