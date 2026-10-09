// A diagnostic probe of the V5 pass (Stage 12), kept beside e2e.mjs: run from scripts/local-stack with the stack up —
//   BROWSER_CHANNEL=chrome node probes/probe-layout.mjs
// probe-layout.mjs — a wallet with two activity rows, then Home, Activity, Security, Wallet and Classic under
// ?locale=pseudo at 360x800: the elements past the viewport (fixed containers left out), every element whose content
// overflows its own box, and the fixed elements' geometry with their widest descendant.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const stack = JSON.parse(readFileSync(join(HERE, "..", "run", "stack.json"), "utf8"));
const WALLET = "http://localhost:5173/";
const PASSWORD = "a strong password for the local run";
const log = (m) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);
const byId = (page, id) => page.getByTestId(id);
async function clickId(page, id) { const b = byId(page, id); await b.first().waitFor({ state: "visible", timeout: 30_000 }); await b.first().click(); }
async function fillId(page, id, v) { const i = byId(page, id); await i.waitFor({ state: "visible", timeout: 30_000 }); await i.fill(v); }
async function nav(page, name) { await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name, exact: true }).click(); }
const rpc = async (method, params = []) => { const r = await fetch(stack.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }); const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result; };
const balanceEth = async (a) => Number(BigInt(await rpc("eth_getBalance", [a, "latest"]))) / 1e18;

async function probe(page, label) {
  const r = await page.evaluate(() => {
    const doc = document.documentElement;
    const name = (el) => `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]}${el.getAttribute("data-testid") ? `[${el.getAttribute("data-testid")}]` : ""}`;
    const text = (el) => (el.children.length === 0 && el.textContent ? ` "${el.textContent.trim().slice(0, 30)}"` : "");
    const stretched = (el) => { for (let e = el; e && e !== document.body; e = e.parentElement) { if (getComputedStyle(e).position === "fixed") return true; } return false; };
    const all = [...document.querySelectorAll("body *")];
    const wide = all.filter((el) => !stretched(el)).map((el) => ({ el, r: el.getBoundingClientRect() })).filter(({ r }) => r.width > 0 && r.right > doc.clientWidth + 1).sort((a, b) => b.r.right - a.r.right).slice(0, 8).map(({ el, r }) => `${name(el)}:${Math.round(r.left)}→${Math.round(r.right)}${text(el)}`);
    const overflowing = all.filter((el) => el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1).sort((a, b) => b.scrollWidth - a.scrollWidth).slice(0, 8).map((el) => `${name(el)} content ${el.scrollWidth} in ${el.clientWidth}${getComputedStyle(el).position === "fixed" ? " (fixed)" : ""}`);
    const fixed = all.filter((el) => getComputedStyle(el).position === "fixed").map((el) => { const r = el.getBoundingClientRect(); const kid = [...el.querySelectorAll("*")].map((k) => ({ k, r: k.getBoundingClientRect() })).sort((a, b) => b.r.right - a.r.right)[0]; return `${name(el)} ${Math.round(r.left)}→${Math.round(r.right)} (w ${Math.round(r.width)}), widest child ${kid ? `${name(kid.k)} →${Math.round(kid.r.right)}${text(kid.k)}` : "none"}`; });
    return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, bodyScroll: document.body.scrollWidth, wide, overflowing, fixed };
  });
  log(`${label}: document ${r.scrollWidth} (body ${r.bodyScroll}) vs ${r.clientWidth}`);
  log(`   past the viewport: ${r.wide.join(" | ") || "none"}`);
  log(`   overflowing content: ${r.overflowing.join(" | ") || "none"}`);
  log(`   fixed: ${r.fixed.join(" | ") || "none"}`);
}

const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL ?? "chrome", args: ["--headless=old"] });
const context = await browser.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await context.addInitScript(({ rpcUrl, account }) => {
  let id = 0;
  const call = async (method, params) => { const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params ?? [] }) }); const j = await r.json(); if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; throw e; } return j.result; };
  window.ethereum = { isLocalStackWallet: true, request: async ({ method, params }) => { if (method === "eth_requestAccounts" || method === "eth_accounts") return [account]; if (method === "eth_chainId") return "0x1"; if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null; if (method === "eth_sendTransaction") return call("eth_sendTransaction", [{ ...params[0], from: account }]); return call(method, params); }, on() { return this; }, removeListener() { return this; } };
}, { rpcUrl: stack.rpc, account: stack.funding });
const page = await context.newPage();
try {
  await page.goto(WALLET, { waitUntil: "load", timeout: 180_000 });
  await byId(page, "welcome").waitFor({ timeout: 120_000 });
  await clickId(page, "welcome-skip"); await byId(page, "experience").waitFor(); await clickId(page, "experience-continue");
  await byId(page, "lock-screen").waitFor({ timeout: 60_000 });
  const pw = page.locator('input[type="password"]'); await pw.nth(0).fill(PASSWORD); await pw.nth(1).fill(PASSWORD);
  await clickId(page, "create"); await byId(page, "recovery-phrase").waitFor({ timeout: 120_000 });
  await page.locator('input[type="checkbox"]').first().check(); await clickId(page, "phrase-continue"); await byId(page, "home").waitFor({ timeout: 60_000 });
  await nav(page, "More"); await page.locator("label", { hasText: "Show the cryptographic detail" }).locator('input[type="checkbox"]').check();
  await clickId(page, "more-advanced"); await byId(page, "advanced").waitFor(); await byId(page, "verify-reads").uncheck();
  await nav(page, "More"); await page.locator("label", { hasText: "Show the cryptographic detail" }).locator('input[type="checkbox"]').uncheck();
  await clickId(page, "more-wallet"); await byId(page, "wallet-screen").waitFor(); await clickId(page, "wallet-connect"); await page.getByText("Connected").first().waitFor();
  // one deposit, one send: two activity rows
  const before = await balanceEth(stack.ethVault);
  await nav(page, "Home"); await clickId(page, "protect-cta"); await byId(page, "protect").waitFor();
  await fillId(page, "protect-amount-input", "2"); await clickId(page, "protect-submit"); await clickId(page, "confirm-tap");
  for (let t = 0; t < 120 && (await balanceEth(stack.ethVault)) < before + 2 - 1e-9; t++) await page.waitForTimeout(1000);
  await byId(page, "protect-done").waitFor({ timeout: 180_000 }); log("protected");
  await nav(page, "Home"); await page.getByRole("button", { name: "Send", exact: true }).click(); await byId(page, "send-tab").waitFor();
  await clickId(page, "send-mode-public"); await fillId(page, "send-amount-input", "0.3"); await byId(page, "send-fees").waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500); await clickId(page, "send-review"); await byId(page, "review").waitFor(); await clickId(page, "confirm-tap");
  await byId(page, "send-done").waitFor({ timeout: 420_000 }); log("sent");
  // the pseudo-locale at 360x800
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(`${WALLET}?locale=pseudo`, { waitUntil: "load" });
  await byId(page, "lock-screen").waitFor({ timeout: 120_000 });
  await page.locator('input[type="password"]').first().fill(PASSWORD); await clickId(page, "unlock"); await byId(page, "home").waitFor({ timeout: 60_000 });
  await probe(page, "home");
  for (const [route, id] of [["activity", "activity"], ["more/security", "settings"], ["more/wallet", "wallet-screen"], ["more/classic", "classic"]]) {
    await page.evaluate((path) => { window.history.pushState(null, "", path); window.dispatchEvent(new PopStateEvent("popstate")); }, `/${route}`);
    await byId(page, id).waitFor({ timeout: 60_000 }); await page.waitForTimeout(300);
    await probe(page, route);
    await page.screenshot({ path: join(HERE, "..", "run", `probe-layout-${route.replace("/", "-")}.png`), fullPage: true });
  }
} catch (e) { log(`EXCEPTION ${e.stack?.split("\n").slice(0, 3).join(" | ")}`); }
finally { await browser.close(); }
