// @vitest-environment happy-dom
// More → Security and Wallet, the Privacy Center on facts and "What stays private?" (spec §3.12–§3.13, §9, §11, §15;
// plan §13, §26, §30–§31, §56; Stage 10): the backup status and the file (the keystore and the encrypted journal, the
// prefs timestamp), the phrase behind the password, the thresholds journaled and nonsense refused, Forget behind the
// typed word, the trade preference journaled, the session facts computed from the stores (the fresh destination from
// the address book), the §31 rows, the categories under "Advanced privacy settings", the LIMITS verbatim — and never
// "anonymous".
import { describe, it, expect, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LIMITS } from "@privacy-wallet/protocol/wallet/privacyCenter";
import { Security } from "../src/features/more/Security";
import { Wallet } from "../src/features/more/Wallet";
import { PrivacyCenter } from "../src/features/privacy-center/PrivacyCenter";
import { WhatStaysPrivate } from "../src/features/privacy-center/WhatStaysPrivate";
import { FRESH_WINDOW_MS, freshDestinations } from "../src/features/privacy-center/status";
import { listedPurposes, privacyCenterModel } from "../src/features/privacy-center/model";
import { addAddress, findEntry, markAddressUsed } from "@privacy-wallet/sdk/wallet/addressBook";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { prefs } from "../src/storage/prefs";
import { connection } from "@privacy-wallet/wallet-engine/connection";
import type { Deployment } from "@privacy-wallet/sdk/chain";

afterEach(() => { cleanup(); session.forget(); settings.reset(); prefs().reset(); connection.reset(); vi.restoreAllMocks(); });
const type = (el: Element, v: string) => fireEvent.change(el, { target: { value: v } });
const deployment = { chainId: 1, core: "0x00000000000000000000000000000000000000c0", ethVault: "0x00000000000000000000000000000000000000e7", rpcUrl: "http://127.0.0.1:1", rpcUrls: ["http://127.0.0.1:1", "http://127.0.0.1:2"], fromBlock: 0n, erc20Vaults: [] } as unknown as Deployment;
const CATEGORIES = ["Financial history", "Address separation", "Network privacy", "RPC privacy", "Timing privacy", "Cross-chain privacy"];

describe("More → Security (spec §3.12, §9)", () => {
  it("the backup status; Back up now downloads the keystore and the encrypted journal and stamps the prefs; Lock locks", async () => {
    await session.create("a strong password");
    const exported = vi.spyOn(session, "exportBackup");
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = () => "blob:backup";
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = () => {};
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<Security />);
    expect(screen.getByTestId("backup-badge").textContent).toContain("Not backed up yet");
    fireEvent.click(screen.getByTestId("backup-now"));
    expect(exported).toHaveBeenCalledTimes(1);
    const backup = JSON.parse(exported.mock.results[0].value as string) as Record<string, unknown>;
    expect(Object.keys(backup).sort()).toEqual(["journal", "keystore", "v"]);
    expect(prefs().get().backup?.exportedAt).toBeTypeOf("number");
    expect(screen.getByTestId("backup-badge").textContent).toContain("Recovery backup created");
    fireEvent.click(screen.getByRole("button", { name: "Lock" }));
    expect(session.state().status).toBe("locked");
  });

  it("the phrase needs the password (a wrong one is refused) and marks the backup acknowledged; the thresholds are journaled and nonsense refused; Forget needs the typed word", async () => {
    await session.create("a strong password");
    const phrase = session.state().pendingPhrase!;
    render(<Security />);
    fireEvent.click(screen.getByTestId("show-phrase"));
    type(screen.getByLabelText("Your password"), "wrong");
    fireEvent.click(screen.getByTestId("reveal-phrase"));
    await screen.findByText("That password did not open the wallet.", {}, { timeout: 20_000 });
    expect(screen.queryByTestId("phrase-words")).toBeNull();
    type(screen.getByLabelText("Your password"), "a strong password");
    fireEvent.click(screen.getByTestId("reveal-phrase"));
    expect((await screen.findByTestId("phrase-words", {}, { timeout: 20_000 })).textContent).toBe(phrase);
    expect(prefs().get().backup?.phraseAcknowledgedAt).toBeTypeOf("number");
    const enhanced = screen.getByTestId("tier-enhanced") as HTMLInputElement;
    type(enhanced, "250000"); fireEvent.focusOut(enhanced);
    expect(settings.get().tiers.enhanced).toBe(250_000);
    expect((session.journal().settings as { tiers?: { enhanced: number } }).tiers?.enhanced).toBe(250_000);
    type(enhanced, "5000000"); fireEvent.focusOut(enhanced);
    expect(settings.get().tiers.enhanced, "above high-value: refused").toBe(250_000);
    expect(screen.getByTestId("tier-error")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("forget-section-toggle"));
    fireEvent.click(screen.getByTestId("forget-open"));
    const confirm = await screen.findByTestId("forget-confirm");
    expect(confirm).toBeDisabled();
    type(screen.getByTestId("forget-input"), "FORGET");
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(session.state().status).toBe("none");
  }, 60_000);
});

describe("More → Wallet (spec §7)", () => {
  it("without a wallet the connection shows Connect; the trade preference is journaled with its funding window", async () => {
    await session.create("a strong password");
    render(<Wallet deployment={null} />);
    expect(screen.getByTestId("connection-status").textContent).toBe("Not connected");
    expect(screen.getByTestId("wallet-connect")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("preference-best-privacy").querySelector("input")!);
    expect(settings.get().preference).toBe("best-privacy");
    expect((session.journal().settings as { preference?: string }).preference).toBe("best-privacy");
    expect(screen.getByTestId("trade-preference").textContent).toContain("funded within");
    expect(screen.getByTestId("read-allowances")).toBeInTheDocument();
  });
});

describe("the Privacy Center (spec §3.13, §15)", () => {
  it("computes its facts: an entered destination used this month breaks the isolation (the fact and the row), 30 days later both are back; Private RPC needs two endpoints and a light-client chain; the categories sit under Advanced; the LIMITS; never anonymous", async () => {
    await session.create("a strong password");
    const now = Date.now();
    addAddress({ chain: "evm", address: "0x9858EfFD232B4033E47d90003D41EC34EcaEda94", label: "exchange", now: now - 20 * 86_400_000 });
    const entry = findEntry("evm", "0x9858EfFD232B4033E47d90003D41EC34EcaEda94")!;
    expect(entry.source).toBe("entered");
    markAddressUsed("evm", entry.address, "order:1", session, now - 10 * 86_400_000);
    const book = session.journal().addressBook!;
    expect(freshDestinations(book, now)).toBe(false);
    expect(freshDestinations(book, now + FRESH_WINDOW_MS)).toBe(true);
    // V6 Stage 14 (spec v2.0 §7.10): the seven sections, every row a fact
    const facts = { posture: { categories: [], overall: "Good" as const, limits: [] }, rpcEndpoints: 2, lightClient: true, relayerSubmission: true, freshDestinations: freshDestinations(book, now), stored: { notes: 1, operations: 2, addressBook: 1 }, purposes: listedPurposes(false), poolNotes: 12 };
    const m = privacyCenterModel(facts);
    expect(m.sections.map((x) => x.id)).toEqual(["protection", "wallet", "network", "transaction", "stored", "sent", "advanced"]);
    const tone = (mm: typeof m) => Object.fromEntries(mm.sections.flatMap((x) => x.rows).map((r) => [r.id, r.tone]));
    expect(m.level).toBe("medium");
    expect(tone(m)).toMatchObject({ protection: "ok", walletData: "ok", analytics: "ok", tracking: "ok", privateTransport: "ok", privateSubmission: "ok", freshDestination: "warn" });
    const later = privacyCenterModel({ ...facts, posture: { ...facts.posture, overall: "Reduced" }, rpcEndpoints: 1, relayerSubmission: false, freshDestinations: freshDestinations(book, now + FRESH_WINDOW_MS) });
    expect(later.level).toBe("low");
    expect(tone(later), "one endpoint, the wallet submitting, a reduced posture").toMatchObject({ protection: "warn", privateTransport: "warn", privateSubmission: "warn", freshDestination: "ok" });

    const learn = vi.fn();
    render(<PrivacyCenter deployment={deployment} onLearnMore={learn} />);
    const center = screen.getByTestId("privacy-center");
    expect(center.querySelector('[data-row="freshDestination"]')!.getAttribute("data-tone")).toBe("warn");
    expect(center.querySelector('[data-row="privateTransport"]')!.getAttribute("data-tone")).toBe("ok");
    expect(center.querySelector('[data-row="walletData"]')!.textContent).toContain("Encrypted locally");
    expect(screen.getByTestId("privacy-limits").querySelectorAll("li")).toHaveLength(LIMITS.length);
    // the six categories are not rendered until asked (a section title — "Network privacy" — may share a category's name)
    expect(screen.queryByTestId("privacy-categories"), "collapsed until asked").toBeNull();
    fireEvent.click(screen.getByTestId("privacy-advanced-toggle"));
    for (const c of CATEGORIES) expect(screen.getByTestId("privacy-categories").textContent).toContain(c);
    fireEvent.click(screen.getByTestId("learn-more"));
    expect(learn).toHaveBeenCalledTimes(1);
    expect(center.textContent!.toLowerCase(), "the LIMITS say what is not untraceable; nothing here claims anonymity").not.toMatch(/anonymous|mixer|undetectable/);
    await act(async () => { settings.set({ submission: { kind: "wallet" } }); });
    expect(center.querySelector('[data-row="privateSubmission"]')!.getAttribute("data-tone"), "a fact, recomputed").toBe("warn");
  });

  it("What stays private? lists the LIMITS verbatim and never promises anonymity", () => {
    render(<WhatStaysPrivate />);
    const page = screen.getByTestId("what-stays-private");
    expect(page.textContent).toContain("What stays private?");
    expect(page.textContent).toContain("What stays public");
    const items = [...screen.getByTestId("limits").querySelectorAll("li")].map((li) => li.textContent);
    expect(items).toEqual([...LIMITS]);
    expect(page.textContent!.toLowerCase()).not.toMatch(/anonymous|100 %/);
  });
});
