// A diagnostic probe of the V5 pass (Stage 12), kept beside e2e.mjs: run from scripts/local-stack with the stack up —
//   BROWSER_CHANNEL=chrome node probes/probe-hold.mjs
// probe-hold.mjs — reaches the campaign Review on the local stack and observes the hold button under three gestures
// (a dispatched pointer press, a real pointer press, a keyboard hold), logging the ring's progress and the DOM state.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const stack = JSON.parse(readFileSync(join(HERE, "..", "run", "stack.json"), "utf8"));
const WALLET = "http://localhost:5173/";
const PASSWORD = "a strong password for the local run";
const PRICE = stack.prices.ETH;
const log = (m) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);
const byId = (page, id) => page.getByTestId(id);
const text = async (l) => ((await l.textContent()) ?? "").replace(/\s+/g, " ");
async function clickId(page, id) { const b = byId(page, id); await b.first().waitFor({ state: "visible", timeout: 30_000 }); await b.first().click(); }
async function fillId(page, id, v) { const i = byId(page, id); await i.waitFor({ state: "visible", timeout: 30_000 }); await i.fill(v); }
async function nav(page, name) { await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name, exact: true }).click(); }
async function acknowledgeAll(page) { let n = 0; for (let i = 0; i < 12; i++) { const b = page.getByRole("button", { name: /^(I understand|I checked every group|I accept the single quote)$/ }); if ((await b.count()) === 0) break; await b.first().click(); n++; await page.waitForTimeout(150); } return n; }
const rpc = async (method, params = []) => { const r = await fetch(stack.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }); const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result; };
const balanceEth = async (a) => Number(BigInt(await rpc("eth_getBalance", [a, "latest"]))) / 1e18;
async function protect(page, amount, expectVault) {
  await nav(page, "Home"); await byId(page, "home").waitFor();
  if (await byId(page, "protect-cta").count()) await clickId(page, "protect-cta"); else await clickId(page, "add-funds");
  await byId(page, "protect").waitFor();
  if (await byId(page, "protect-connect").count()) { await clickId(page, "protect-connect"); await page.getByText("Connected").first().waitFor(); }
  await fillId(page, "protect-amount-input", String(amount));
  await clickId(page, "protect-submit"); await clickId(page, "confirm-tap");
  for (let t = 0; t < 180 && (await balanceEth(stack.ethVault)) < expectVault - 1e-9; t++) await page.waitForTimeout(1000);
  await byId(page, "protect-done").waitFor({ timeout: 180_000 });
}
async function state(page, label) {
  const s = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="hold-to-confirm"]');
    const ring = b?.querySelector(".ds-hold-ring");
    return { present: !!b, disabled: b?.disabled ?? null, progress: ring?.getAttribute("data-progress") ?? null, label: b?.textContent?.slice(0, 40) ?? null, password: !!document.querySelector('[data-testid="second-factor-password"]'), progressPanel: !!document.querySelector('[data-testid="campaign-progress"]'), active: document.activeElement?.tagName + "." + (document.activeElement?.className || "").split(" ")[0], reviewMoment: document.querySelector('[data-testid="review"]')?.getAttribute("data-moment") ?? null };
  });
  log(`${label}: ${JSON.stringify(s)}`);
  return s;
}

const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL ?? "chrome", args: ["--headless=old"] });
const context = await browser.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await context.addInitScript(({ rpcUrl, account }) => {
  let id = 0;
  const call = async (method, params) => { const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params ?? [] }) }); const j = await r.json(); if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; throw e; } return j.result; };
  window.ethereum = { isLocalStackWallet: true, request: async ({ method, params }) => { if (method === "eth_requestAccounts" || method === "eth_accounts") return [account]; if (method === "eth_chainId") return "0x1"; if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null; if (method === "eth_sendTransaction") return call("eth_sendTransaction", [{ ...params[0], from: account }]); return call(method, params); }, on() { return this; }, removeListener() { return this; } };
}, { rpcUrl: stack.rpc, account: stack.funding });
const page = await context.newPage();
page.on("pageerror", (e) => log(`page error: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") log(`console ${m.type()}: ${m.text().slice(0, 160)}`); });
try {
  await page.goto(WALLET, { waitUntil: "load", timeout: 180_000 });
  await byId(page, "welcome").waitFor({ timeout: 120_000 });
  await clickId(page, "welcome-skip"); await byId(page, "experience").waitFor(); await clickId(page, "experience-continue");
  await byId(page, "lock-screen").waitFor({ timeout: 60_000 });
  const pw = page.locator('input[type="password"]'); await pw.nth(0).fill(PASSWORD); await pw.nth(1).fill(PASSWORD);
  await clickId(page, "create"); await byId(page, "recovery-phrase").waitFor({ timeout: 120_000 });
  await page.locator('input[type="checkbox"]').first().check(); await clickId(page, "phrase-continue"); await byId(page, "home").waitFor({ timeout: 60_000 });
  // the light client off, the wallet connected
  await nav(page, "More");
  await page.locator("label", { hasText: "Show the cryptographic detail" }).locator('input[type="checkbox"]').check();
  await clickId(page, "more-advanced"); await byId(page, "advanced").waitFor(); await byId(page, "verify-reads").uncheck();
  await byId(page, "protected-execution").waitFor();
  // the separate device
  try { const cdp = await context.newCDPSession(page); await cdp.send("WebAuthn.enable"); await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "usb", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } }); await clickId(page, "register-second-device"); await page.getByText("Registered. Operations at the institutional size").first().waitFor({ timeout: 60_000 }); log("device registered"); } catch (e) { log(`no device: ${e.message}`); }
  await nav(page, "More"); await clickId(page, "more-wallet"); await byId(page, "wallet-screen").waitFor(); await clickId(page, "wallet-connect"); await page.getByText("Connected").first().waitFor();
  const before = await balanceEth(stack.ethVault);
  for (const i of [1, 2, 3, 4, 5, 6, 7]) { await protect(page, 500, before + 500 * i); log(`deposit ${i}`); }
  // the $10M quote → the wizard → the Review
  const CAMPAIGN_ETH = Math.ceil(10_000_000 / PRICE);
  await nav(page, "Swap"); await byId(page, "swap").waitFor();
  await fillId(page, "swap-amount-input", String(CAMPAIGN_ETH));
  await clickId(page, "swap-quote"); await byId(page, "quote").waitFor({ timeout: 240_000 });
  await acknowledgeAll(page); await clickId(page, "swap-review");
  await byId(page, "campaign-wizard").waitFor({ timeout: 30_000 });
  await clickId(page, "wizard-next"); await acknowledgeAll(page); await clickId(page, "wizard-next"); await clickId(page, "wizard-next");
  const review = byId(page, "review"); await review.waitFor({ timeout: 30_000 });
  log(`acknowledged ${await acknowledgeAll(page)} in the review`);
  const b = byId(page, "hold-to-confirm");
  const inspect = async (label) => {
    const r = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('[data-testid="hold-to-confirm"]')];
      return nodes.map((el) => { const k = Object.keys(el).find((x) => x.startsWith("__reactProps")); const props = k ? el[k] : null; return { disabled: el.disabled, hasPointerDown: !!props?.onPointerDown, hasKeyDown: !!props?.onKeyDown, propDisabled: props?.disabled ?? null, connected: el.isConnected, visible: el.getClientRects().length > 0, progress: el.querySelector(".ds-hold-ring")?.getAttribute("data-progress") }; });
    });
    log(`${label}: ${r.length} hold node(s) ${JSON.stringify(r)}`);
  };
  const tryHold = async (label) => {
    await b.last().evaluate((el) => el.scrollIntoView({ block: "center" })); await page.waitForTimeout(150);
    await b.last().dispatchEvent("pointerdown");
    for (let i = 0; i < 6; i++) { await page.waitForTimeout(300); await state(page, `${label} +${(i + 1) * 300}ms`); }
    await b.last().dispatchEvent("pointerup", {}, { timeout: 1000 }).catch(() => {});
    await page.waitForTimeout(400);
    const ok = (await byId(page, "second-factor-password").count()) > 0;
    log(`${label}: ${ok ? "the hold took" : "the hold did NOT take"}`);
    return ok;
  };
  await state(page, "before"); await inspect("before");
  // prelude A: Advanced details
  await page.getByRole("button", { name: "Advanced details", exact: true }).first().click().catch((e) => log(`no Advanced details: ${e.message.slice(0, 80)}`));
  await page.waitForTimeout(300);
  await inspect("after Advanced details");
  let ok = await tryHold("after A");
  if (!ok) {
    // prelude B: the full-page screenshot (on top of A)
    await page.screenshot({ path: join(HERE, "..", "run", "probe-review-full.png"), fullPage: true });
    await inspect("after full-page screenshot");
    ok = await tryHold("after A+B");
  }
  if (!ok) {
    // a fresh node: collapse the details again, then hold
    await page.getByRole("button", { name: "Advanced details", exact: true }).first().click().catch(() => {});
    await page.waitForTimeout(300); await inspect("after collapsing again");
    ok = await tryHold("after collapse");
  }
  await page.screenshot({ path: join(HERE, "..", "run", "probe-hold.png"), fullPage: false });
  log(`password prompt: ${await byId(page, "second-factor-password").count()}; progress panel: ${await byId(page, "campaign-progress").count()}`);
} catch (e) { log(`EXCEPTION ${e.stack?.split("\n").slice(0, 3).join(" | ")}`); try { await page.screenshot({ path: join(HERE, "..", "run", "probe-exception.png") }); } catch {} }
finally { await browser.close(); }
