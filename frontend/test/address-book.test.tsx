// @vitest-environment happy-dom
// The address book on the screens (High-Value Protection spec §12, Stage 6): the journaled book — an entered address is
// added unverified with a 24 h cooling-off, verified by re-typing its groups, by a signed message the wallet checks offline
// (EIP-191 for EVM, ed25519 for Solana) or by a test transaction, usable at ≥ high-value only once verified and cooled
// or with the Immediate override (the phrase, the hold, the second factor — the separate device at institutional);
// fresh addresses enter the book when reserved and retire after one use; a retired entry is never selectable. On the
// screens: the status under a typed destination on Swap and Withdraw with the way forward, the Review's destination
// line, the Settings panel, the Receive screen's used marker, and the campaign's first step waiting for the cooling-off.
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ed25519 } from "@noble/curves/ed25519";
import { base58 } from "@scure/base";
import { utf8ToBytes } from "@noble/hashes/utils";
import { selectable, COOLING_OFF_MS } from "@ref/wallet/addressBook";
import { Swap } from "../src/components/Swap";
import { Send } from "../src/features/send/Send";
import { Receive } from "../src/features/wallet/Receive";
import { Settings } from "../src/components/Settings";
import { session } from "../src/wallet/session";
import { settings } from "../src/wallet/settings";
import { noteStore } from "../src/wallet/notes";
import { consumeFreshAddress, peekFreshAddress } from "../src/keys/chainKeys";
import { approveAddress, addAddress, bookOf, challengeMessage, destinationCheck, entryIdFor, findEntry, markAddressSettled, markAddressUsed, methodsFor, overrideCoolingOff, retireAddress, verifyAddress, verifySignedChallenge } from "../src/wallet/addressBook";
import { OVERRIDE_PHRASE } from "../src/components/protection/AddressBook";
import { buildCampaign } from "../src/wallet/campaigns";
import type { Deployment } from "../src/sdk/chain";
import type { Protection, QuoteSet } from "../src/sdk/swapService";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => { globalThis.fetch = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch; });
let root: Root | null = null;
afterEach(() => { if (root) { act(() => root!.unmount()); root = null; } session.forget(); settings.reset(); noteStore.clear(); });

const ETH_VAULT = getAddress("0x00000000000000000000000000000000000000e7");
const deployment: Deployment = { chainId: 1, core: getAddress("0x00000000000000000000000000000000000000c0"), ethVault: ETH_VAULT, rpcUrl: "http://127.0.0.1:1", rpcUrls: ["http://127.0.0.1:1"], fromBlock: 0n, erc20Vaults: [], swapFactory: getAddress("0x00000000000000000000000000000000000000f1") };
const EVM = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const BTC = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const T0 = Date.parse("2026-10-08T12:00:00Z");
const setValue = (el: HTMLInputElement, v: string) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
const button = (c: ParentNode, text: string | RegExp) => [...c.querySelectorAll("button")].find((b) => (typeof text === "string" ? b.textContent?.trim() === text : text.test(b.textContent ?? ""))) as HTMLButtonElement | undefined;
async function mount(el: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  if (root) act(() => root!.unmount());
  await act(async () => { root = createRoot(container); root.render(el); });
  return container;
}
async function hold(c: HTMLElement) {
  const b = c.querySelector('[data-testid="hold-to-confirm"]') as HTMLButtonElement;
  expect(b).toBeTruthy();
  expect(b.disabled).toBe(false);
  await act(async () => { b.dispatchEvent(new Event("pointerdown", { bubbles: true })); await new Promise((r) => setTimeout(r, 120)); });
}
/** Type the grouped address into the group inputs of the verify panel. */
async function typeGroups(c: ParentNode, address: string) {
  const body = address.startsWith("0x") ? address.slice(2) : address;
  const groups = body.match(/.{1,4}/g)!;
  for (let i = 0; i < groups.length; i++) await act(async () => { setValue(c.querySelector(`[data-testid="group-${i}"]`) as HTMLInputElement, groups[i]); });
}
async function unlocked() { await session.create("a strong password"); session.acknowledgePhrase(); }

describe("the journaled address book (spec §12)", () => {
  it("adds an entered address unverified and cooling; verifies it; the Immediate override lifts the cooling-off; retire ends it; fresh addresses are verified by derivation and retire after one use", async () => {
    await unlocked();
    const r = addAddress({ chain: "evm", address: EVM, label: "treasury", now: T0 });
    expect(r.ok && r.existed).toBe(false);
    const e = (r as { entry: any }).entry;
    expect(e).toMatchObject({ id: entryIdFor("evm", EVM), chain: "evm", source: "entered", lifecycle: "generated", label: "treasury", coolingUntil: T0 + COOLING_OFF_MS, verification: { status: "unverified" } });
    expect(addAddress({ chain: "evm", address: EVM.toLowerCase(), now: T0 })).toMatchObject({ ok: true, existed: true }); // the same address, another case
    expect(addAddress({ chain: "evm", address: BTC })).toMatchObject({ ok: false, reason: expect.stringContaining("Bitcoin") });
    expect(bookOf(session.journal())).toHaveLength(1);
    expect(findEntry("evm", EVM.toLowerCase())?.id).toBe(e.id);
    // below high-value the book does not stand in the way; at high-value an unknown or unverified address does
    expect(destinationCheck("evm", BTC, { tier: "enhanced" })).toMatchObject({ entry: null, ok: true });
    expect(destinationCheck("bitcoin", BTC, { tier: "high-value" })).toMatchObject({ entry: null, ok: false, reason: "unknown", verified: false });
    expect(destinationCheck("evm", EVM, { tier: "high-value", now: T0 })).toMatchObject({ ok: false, reason: "unverified", verified: false });
    verifyAddress(e.id, "groups-read", session, T0 + 1000);
    const cooling = destinationCheck("evm", EVM, { tier: "high-value", now: T0 + 2000 });
    expect(cooling).toMatchObject({ ok: false, reason: "cooling-off", verified: true, until: T0 + COOLING_OFF_MS });
    expect(cooling.status).toMatch(/wait 24 h more/);
    // V4 (plan §19): out of the cooling-off the entry still needs the explicit approval; approving it makes it usable
    expect(destinationCheck("evm", EVM, { tier: "high-value", now: T0 + COOLING_OFF_MS + 1 })).toMatchObject({ ok: false, reason: "unapproved", verified: true });
    expect(approveAddress(e.id, session, T0 + COOLING_OFF_MS + 1)).toMatchObject({ lifecycle: "approved", approvedAt: T0 + COOLING_OFF_MS + 1 });
    expect(destinationCheck("evm", EVM, { tier: "high-value", now: T0 + COOLING_OFF_MS + 2 })).toMatchObject({ ok: true, verified: true });
    // an approval idle for 90 days is stale
    expect(destinationCheck("evm", EVM, { tier: "high-value", now: T0 + COOLING_OFF_MS + 91 * 86_400_000 })).toMatchObject({ ok: false, reason: "stale" });
    // the Immediate override is an approval of its own (the entry is re-read from the journal as it was before the approval here: the override alone suffices)
    overrideCoolingOff(e.id, "second-factor", session, T0 + 3000);
    expect(destinationCheck("evm", EVM, { tier: "high-value", now: T0 + 4000 })).toMatchObject({ ok: true, verified: true, status: "Verified; the cooling-off was overridden." });
    expect(findEntry("evm", EVM)?.override).toEqual({ at: T0 + 3000, by: "second-factor" });
    markAddressUsed("evm", EVM, "0xorder", session, T0 + 5000);
    expect(findEntry("evm", EVM)).toMatchObject({ lifecycle: "used", usedBy: ["0xorder"] });
    markAddressSettled("evm", EVM, session, T0 + 6000);
    expect(findEntry("evm", EVM)?.lifecycle, "an entered address stays usable").toBe("settled");
    retireAddress(e.id);
    expect(destinationCheck("evm", EVM, { tier: "high-value" })).toMatchObject({ ok: false, reason: "retired" });
    expect(selectable(bookOf(session.journal()))).toHaveLength(0);
    // fresh addresses: recorded when reserved, verified by derivation, no cooling-off, retired once their payment settled
    const fresh = consumeFreshAddress(session.state().seed!, "bitcoin");
    const fe = findEntry("bitcoin", fresh.address)!;
    expect(fe).toMatchObject({ source: "fresh", lifecycle: "verified", verification: { status: "verified", method: "derived" }, label: "Fresh address #1" });
    expect(fe.coolingUntil).toBeUndefined();
    expect(destinationCheck("bitcoin", fresh.address, { tier: "institutional" })).toMatchObject({ ok: true, verified: true });
    markAddressUsed("bitcoin", fresh.address, "campaign-1");
    markAddressSettled("bitcoin", fresh.address);
    expect(findEntry("bitcoin", fresh.address)?.lifecycle).toBe("retired");
    expect(methodsFor("evm")).toEqual(["groups-read", "signed-message", "test-transaction"]);
    expect(methodsFor("bitcoin")).toEqual(["groups-read"]);
    // the book survives a lock
    session.lock();
    expect(await session.unlock("a strong password")).toBe(true);
    expect(bookOf(session.journal()).map((x) => x.id).sort()).toEqual([entryIdFor("bitcoin", fresh.address), entryIdFor("evm", EVM)].sort());
  });

  it("signed messages: an EVM signature recovers to the address, a Solana ed25519 signature verifies; the wrong key fails", async () => {
    await unlocked();
    const signer = privateKeyToAccount("0x" + "77".repeat(32) as `0x${string}`);
    const other = privateKeyToAccount("0x" + "78".repeat(32) as `0x${string}`);
    const entry = (addAddress({ chain: "evm", address: signer.address, now: T0 }) as { entry: any }).entry;
    const message = challengeMessage(entry, T0);
    expect(message).toContain(signer.address);
    expect(message).toContain("2026-10-08T12:00:00.000Z");
    expect(await verifySignedChallenge(entry, message, await signer.signMessage({ message }))).toBe(true);
    expect(await verifySignedChallenge(entry, message, await other.signMessage({ message }))).toBe(false);
    expect(await verifySignedChallenge(entry, message, "0x1234")).toBe(false);
    const sk = new Uint8Array(32).fill(9);
    const pk = ed25519.getPublicKey(sk);
    const sol = (addAddress({ chain: "solana", address: base58.encode(pk), now: T0 }) as { entry: any }).entry;
    const m2 = challengeMessage(sol, T0);
    const sig = ed25519.sign(utf8ToBytes(m2), sk);
    expect(await verifySignedChallenge(sol, m2, base58.encode(sig))).toBe(true);
    expect(await verifySignedChallenge(sol, m2, "0x" + Buffer.from(sig).toString("hex"))).toBe(true);
    expect(await verifySignedChallenge(sol, m2 + " ", base58.encode(sig))).toBe(false);
    const btc = (addAddress({ chain: "bitcoin", address: BTC, now: T0 }) as { entry: any }).entry;
    expect(await verifySignedChallenge(btc, "x", "y"), "no Bitcoin message signatures").toBe(false);
  });
});

describe("destinations on the screens (spec §12)", () => {
  it("Send to a public address at high-value: a typed address is not usable until it is in the book, verified by its groups, and either cooled or confirmed for immediate use with the phrase, the hold and the password", async () => {
    await unlocked();
    noteStore.add({ note: { vaultId: BigInt(ETH_VAULT), amount: 10n ** 18n, ownerCommitment: 1n, noteSecret: 2n }, leafIndex: 0, noteData: "0x", spent: false });
    const c = await mount(<Send masterSeed={session.state().seed!} deployment={deployment} initialMode="public" />); // no price on chain 1: the fail-safe tier is high-value
    await act(async () => { setValue(c.querySelector('[data-testid="send-amount-input"]') as HTMLInputElement, "0.5"); });
    const input = c.querySelector('input[placeholder^="0x"]') as HTMLInputElement;
    await act(async () => { setValue(input, EVM); });
    let status = c.querySelector('[data-testid="destination-status"]')!;
    expect(status.getAttribute("data-reason")).toBe("unknown");
    expect(status.textContent).toContain("Not in your address book");
    expect(button(c, "Review")!.disabled, "a large withdrawal to an unknown address is not offered").toBe(true);
    await act(async () => { button(status, "Add to the address book")!.click(); });
    expect(findEntry("evm", EVM)).toMatchObject({ lifecycle: "generated" });
    status = c.querySelector('[data-testid="destination-status"]')!;
    expect(status.getAttribute("data-reason")).toBe("unverified");
    expect(c.querySelector('[data-testid="verify-entry"]'), "the verify panel opens at once").toBeTruthy();
    // the groups: a wrong group is refused, the right ones verify
    await typeGroups(c, EVM);
    await act(async () => { setValue(c.querySelector('[data-testid="group-3"]') as HTMLInputElement, "zzzz"); });
    await act(async () => { button(c, "Check the groups")!.click(); });
    expect(c.textContent).toContain("One or more groups differ");
    expect(findEntry("evm", EVM)?.verification.status).toBe("unverified");
    await act(async () => { setValue(c.querySelector('[data-testid="group-3"]') as HTMLInputElement, EVM.slice(2).match(/.{1,4}/g)![3]); });
    await act(async () => { button(c, "Check the groups")!.click(); });
    expect(findEntry("evm", EVM)).toMatchObject({ verification: { status: "verified", method: "groups-read" }, lifecycle: "verified" });
    status = c.querySelector('[data-testid="destination-status"]')!;
    expect(status.getAttribute("data-reason")).toBe("cooling-off");
    expect(status.textContent).toContain("large payments wait");
    expect(button(c, "Review")!.disabled, "cooling: still not offered").toBe(true);
    // the Immediate override: the phrase, the hold, then the password (no authenticator registered)
    await act(async () => { button(status, "Confirm an immediate use")!.click(); });
    const panel = c.querySelector('[data-testid="override-panel"]')!;
    expect((panel.querySelector('[data-testid="hold-to-confirm"]') as HTMLButtonElement).disabled, "the phrase first").toBe(true);
    await act(async () => { setValue(panel.querySelector('[data-testid="override-phrase"]') as HTMLInputElement, OVERRIDE_PHRASE); });
    await hold(panel as HTMLElement);
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    const pw = c.querySelector('[data-testid="override-password"] input') as HTMLInputElement;
    expect(pw).toBeTruthy();
    await act(async () => { setValue(pw, "wrong"); });
    await act(async () => { button(c, "Confirm with the password")!.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
    expect(c.textContent).toContain("Wrong password.");
    await act(async () => { setValue(pw, "a strong password"); });
    await act(async () => { button(c, "Confirm with the password")!.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
    expect(findEntry("evm", EVM)?.override).toMatchObject({ by: "second-factor" });
    status = c.querySelector('[data-testid="destination-status"]')!;
    expect(status.getAttribute("data-ok")).toBe("1");
    expect(status.textContent).toContain("the cooling-off was overridden");
    for (const b of [...c.querySelectorAll("button")].filter((x) => x.textContent?.trim() === "I understand")) await act(async () => { b.click(); }); // the lint's block items (an entered destination at high-value)
    expect(button(c, "Review")!.disabled).toBe(false);
    await act(async () => { button(c, "Review")!.click(); });
    const line = c.querySelector('[data-line="destination"]')!;
    expect(line.textContent).toContain("the cooling-off was overridden");
    expect(line.getAttribute("data-ok"), "the groups acknowledgement is still asked").toBe("0");
    await act(async () => { button(c, "I checked every group")!.click(); });
    expect(c.querySelector('[data-line="destination"]')!.getAttribute("data-ok")).toBe("1");
  });

  it("Swap: the status under a typed Bitcoin destination, with the book's way forward; Settings lists the entry; Receive marks a used address", async () => {
    await unlocked();
    const c = await mount(<Swap masterSeed={session.state().seed!} deployment={deployment} />);
    const input = c.querySelector('input[placeholder="fresh address"]') as HTMLInputElement;
    await act(async () => { setValue(input, BTC); });
    const status = c.querySelector('[data-testid="destination-status"]')!;
    expect(status.getAttribute("data-reason")).toBe("unknown"); // no price: the fail-safe tier is high-value
    await act(async () => { button(status, "Add to the address book")!.click(); });
    expect(c.querySelector('[data-testid="verify-entry"]')).toBeTruthy();
    expect([...c.querySelectorAll('[data-testid="verify-entry"] [data-method]')].map((b) => b.getAttribute("data-method")), "Bitcoin: the groups only").toEqual(["groups-read"]);
    await typeGroups(c, BTC);
    await act(async () => { button(c, "Check the groups")!.click(); });
    expect(findEntry("bitcoin", BTC)?.verification.method).toBe("groups-read");
    expect(c.querySelector('[data-testid="destination-status"]')!.getAttribute("data-reason")).toBe("cooling-off");
    // Settings → Address book lists it with its status and can retire it
    const s = await mount(<Settings deployment={deployment} readsLine="" coreLine="" />);
    const entry = s.querySelector('[data-testid="book-entry"]')!;
    expect(entry.getAttribute("data-source")).toBe("entered");
    expect(entry.textContent).toContain("re-typed group by group");
    expect(entry.textContent).toContain("large payments wait");
    await act(async () => { button(entry, "Retire")!.click(); });
    expect(findEntry("bitcoin", BTC)?.lifecycle).toBe("retired");
    expect(s.querySelector('[data-testid="book-entry"]')!.getAttribute("data-lifecycle")).toBe("retired");
    // adding from the panel
    await act(async () => { setValue(s.querySelector('[data-testid="book-address"]') as HTMLInputElement, EVM); setValue(s.querySelector('[data-testid="book-label"]') as HTMLInputElement, "exchange"); });
    await act(async () => { button(s, "Add")!.click(); });
    expect(findEntry("evm", EVM)).toMatchObject({ label: "exchange", lifecycle: "generated" });
    expect(s.querySelectorAll('[data-testid="book-entry"]')).toHaveLength(2);
    // Receive: a fresh address enters the book when generated; once used it says so
    const r = await mount(<Receive masterSeed={session.state().seed!} />);
    await act(async () => { (r.querySelector('[data-testid="receive-bitcoin"]') as HTMLButtonElement).click(); });
    await act(async () => { button(r, "Generate a private receiving address")!.click(); });
    const addr = r.querySelector("code")!.textContent!;
    expect(findEntry("bitcoin", addr)).toMatchObject({ source: "fresh", lifecycle: "verified" });
    expect(r.querySelector('[data-testid="address-used"]')).toBeNull();
    await act(async () => { markAddressUsed("bitcoin", addr, "0xorder"); });
    expect(r.querySelector('[data-testid="address-used"]')).toBeTruthy();
    expect(peekFreshAddress(session.state().seed!, "bitcoin").address).not.toBe(addr);
  });

  it("a campaign toward an entered destination in its cooling-off: the first step waits for the cooling-off, like the review hold", async () => {
    await unlocked();
    const e = (addAddress({ chain: "bitcoin", address: BTC, now: T0 }) as { entry: any }).entry;
    verifyAddress(e.id, "groups-read", session, T0);
    const check = destinationCheck("bitcoin", BTC, { tier: "high-value", now: T0 + 1000 });
    expect(check).toMatchObject({ verified: true, ok: false, reason: "cooling-off", until: T0 + COOLING_OFF_MS });
    const protection: Protection = { provider: "thorchain", riskClass: "R5", flags: [], custody: "tss-vaults", bandBps: [200, 250], capBps: 250, sizing: "varied", concurrency: "sequential", maxParallel: 1, gate: "destination-final", cadenceSeconds: [600, 5400], providerShareCapBps: 10000, executeWindowSeconds: 7200, estimatedTranches: 40, estimatedSeconds: 200_000, trancheUsd: null, capUsd: null, trancheImpactBps: null, thinMarket: false, maxPieceUnits: null, concentration: { providers: [{ id: "thorchain", shareBps: 10000 }], singleVenue: true, capBps: 10000 }, elpf: { prior: 0.02, pFailure: 0.02, perTrancheUsd: null, perCampaignUsd: null }, staged: false, reasons: [] };
    const score = { provider: "thorchain", total: 80, components: { price: 80, security: 69, privacy: 72, latency: 60, liquidity: 80, reliability: 100 } };
    const quotes: QuoteSet = { quotes: [{ provider: "thorchain", category: "A", toAmount: "1200000000", toAmountMin: "1194000000", etaSeconds: 1400, expiresAt: Math.floor(T0 / 1000) + 600, nativeAssets: true, minOutEncoded: true, hops: [] }], scores: [score], errors: {}, chosen: score, links: {}, policy: "privacy-execution", competition: [], protection };
    const c = buildCampaign({ quotes, provider: "thorchain", from: { chain: "ethereum", asset: "native", decimals: 18, symbol: "ETH" }, fromAsset: { symbol: "ETH", decimals: 18, vault: ETH_VAULT } as never, to: { chain: "bitcoin", asset: "native", decimals: 8, symbol: "BTC" }, amount: 400n * 10n ** 18n, tier: "high-value", mode: "balanced", preference: "balanced", policy: "privacy-execution", destination: { kind: "entered", address: BTC, bookId: e.id }, usd: 1_000_000, now: T0 + 1000, rng: () => 0.5, reviewHoldUntil: check.until });
    expect(c.tranches[0].notBefore).toBe(T0 + COOLING_OFF_MS);
    expect(c.tranches[1].notBefore).toBeUndefined();
    expect(c.bounds.destination).toEqual({ kind: "entered", address: BTC, bookId: e.id });
  });
});
