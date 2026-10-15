// @vitest-environment happy-dom
// The Privacy Center V6 (spec v2.0 §7.10; doc §35–§36; V6 Stage 14): the seven sections in order, every row a fact; "Data
// sent to services" generated from the transport's purpose registry and the API's field list — a purpose, an API column
// group or a never-stored item without its words fails here —; the indicator with "Some blockchain metadata remains
// public."; the "Why?" lines from a swap's assessment, a failed one with its plain reason.
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { API_FIELD_GROUPS, NEVER_STORED } from "@privacy-wallet/protocol-types";
import { PURPOSES } from "@privacy-wallet/privacy-engine/transport/http";
import { en } from "../src/app/i18n/en";
import { listedPurposes, privacyCenterModel, whyLines } from "../src/features/privacy-center/model";
import { PrivacyCenterView } from "../src/features/privacy-center/View";
import { PRIVACY_CENTER_FIXTURES } from "../src/features/privacy-center/fixtures";
import { privacyPosture } from "@privacy-wallet/protocol/wallet/privacyCenter";
import { SwapView, type SwapModel } from "../src/features/swap/View";
import { SWAP_FIXTURES } from "../src/features/flowFixtures";

const posture = { overall: "Excellent" as const, categories: [], limits: ["Amounts that enter and leave are public."] };
const facts = {
  posture,
  rpcEndpoints: 2,
  lightClient: true,
  relayerSubmission: true,
  freshDestinations: true,
  stored: { notes: 3, operations: 5, addressBook: 2 },
  purposes: listedPurposes(false),
  poolNotes: 900,
};

describe("Data sent to services: generated, never written by hand", () => {
  it("every purpose of the transport has its words (what the service is, what it receives)", () => {
    for (const p of PURPOSES) {
      expect(en, p).toHaveProperty(`privacyCenter.sent.${p}`);
      expect(en, p).toHaveProperty(`privacyCenter.sent.${p}.what`);
    }
  });
  it("every group of the API's record and every item the API never keeps has its words", () => {
    for (const g of API_FIELD_GROUPS) expect(en, g).toHaveProperty(`privacyCenter.apiGroup.${g}`);
    for (const n of NEVER_STORED) expect(en, n).toHaveProperty(`privacyCenter.never.${n}`);
  });
  it("lists the purposes this build uses: Private AI only where the build has it, never the transport's default", () => {
    expect(listedPurposes(false)).not.toContain("zkapi");
    expect(listedPurposes(false)).not.toContain("inference");
    expect(listedPurposes(true)).toEqual(expect.arrayContaining(["zkapi", "inference"]));
    for (const ai of [false, true]) expect(listedPurposes(ai)).not.toContain("other");
    const sent = privacyCenterModel(facts).sections.find((s) => s.id === "sent")!;
    expect(sent.rows.map((r) => r.id)).toEqual([...listedPurposes(false).map((p) => `sent:${p}`), "apiKeeps", "never"]);
    // the operation's columns, then its execution's and the relayer's report (2026-10-14: those two had gone unlisted)
    expect(sent.rows.find((r) => r.id === "apiKeeps")!.items).toEqual(API_FIELD_GROUPS.map((g) => `privacyCenter.apiGroup.${g}`));
    expect(sent.rows.find((r) => r.id === "apiKeeps")!.items).toEqual(
      expect.arrayContaining(["privacyCenter.apiGroup.execution", "privacyCenter.apiGroup.job"]),
    );
    expect(sent.rows.find((r) => r.id === "never")!.items).toHaveLength(NEVER_STORED.length);
  });
});

describe("the fixtures are the real model (the harness shows what the screen computes)", () => {
  // the facts behind each fixture: a pool of 1,284 notes, a relayer, the light client; two read endpoints and fresh
  // destinations (protected), or one endpoint and destinations typed by hand (entered)
  const computed = (o: { freshDestinations: boolean; rpcEndpoints: number }) =>
    privacyCenterModel({
      posture: privacyPosture({
        poolSize: 1284,
        delayWindow: [3600, 86_400],
        privateSubmission: true,
        rpcEndpoints: o.rpcEndpoints,
        lightClient: true,
        freshDestinations: o.freshDestinations,
      }),
      rpcEndpoints: o.rpcEndpoints,
      lightClient: true,
      relayerSubmission: true,
      freshDestinations: o.freshDestinations,
      stored: { notes: 4, operations: 7, addressBook: 3 },
      purposes: listedPurposes(false),
      poolNotes: 1284,
    });
  it("protected and entered equal the model over the real posture", () => {
    expect(PRIVACY_CENTER_FIXTURES.protected).toEqual(computed({ freshDestinations: true, rpcEndpoints: 2 }));
    expect(PRIVACY_CENTER_FIXTURES.entered).toEqual(computed({ freshDestinations: false, rpcEndpoints: 1 }));
  });
});

describe("the seven sections (doc §36)", () => {
  it("in order, every row a fact; the level in V6 words", () => {
    const m = privacyCenterModel(facts);
    expect(m.sections.map((s) => s.id)).toEqual(["protection", "wallet", "network", "transaction", "stored", "sent", "advanced"]);
    expect(m.level).toBe("high");
    const stored = m.sections.find((s) => s.id === "stored")!;
    expect(stored.rows.map((r) => [r.id, r.vars?.n])).toEqual([
      ["notes", 3],
      ["operations", 5],
      ["addressBook", 2],
      ["settings", undefined],
    ]);
    expect(privacyCenterModel({ ...facts, posture: { ...posture, overall: null } }).level).toBeNull();
  });
  it("renders the titles in order, the indicator with the public-metadata sentence, what the API keeps and what nothing keeps", () => {
    render(<PrivacyCenterView model={PRIVACY_CENTER_FIXTURES.protected} actions={{}} />);
    const page = screen.getByTestId("privacy-center");
    const titles = [
      "Protection status",
      "Wallet privacy",
      "Network privacy",
      "Transaction privacy",
      "Data stored locally",
      "Data sent to services",
      "Advanced settings",
    ];
    const text = page.textContent ?? "";
    expect(titles.map((x) => text.indexOf(x))).toEqual([...titles.map((x) => text.indexOf(x))].sort((a, b) => a - b));
    for (const x of titles) expect(text).toContain(x);
    const word = { high: "High", medium: "Medium", low: "Low" }[PRIVACY_CENTER_FIXTURES.protected.level!];
    expect(within(screen.getByTestId("privacy-section-protection")).getByTestId("protection-badge").textContent).toContain(`${word} protection`);
    expect(text).toContain("Some blockchain metadata remains public.");
    expect(screen.getByTestId("privacy-items-apiKeeps").textContent).toContain("only until the order is signed");
    expect(screen.getByTestId("privacy-items-never").textContent).toContain("your recovery phrase");
    expect(text.toLowerCase(), "never a promise of anonymity").not.toMatch(/anonymous|untraceable|invisible|undetectable|mixer/);
  });
  it("an entered destination and one read endpoint: the two facts read as not active", () => {
    render(<PrivacyCenterView model={PRIVACY_CENTER_FIXTURES.entered} actions={{}} />);
    const page = screen.getByTestId("privacy-center");
    expect(page.querySelector('[data-row="freshDestination"]')!.getAttribute("data-tone")).toBe("warn");
    expect(page.querySelector('[data-row="privateTransport"]')!.getAttribute("data-tone")).toBe("warn");
    expect(page.querySelector('[data-row="privateSubmission"]')!.getAttribute("data-tone")).toBe("ok");
  });
});

describe("Why? under the protection indicator (doc §35)", () => {
  it("each line from the assessment; a failed one with its plain reason", () => {
    expect(whyLines([]).map((l) => l.ok)).toEqual([true, true, true, true]);
    const w = whyLines(["entered-destination", "public-link", "recent"]);
    expect(w.map((l) => [l.label, l.ok, l.reason ?? null])).toEqual([
      ["privacyCenter.why.source", true, null],
      ["privacyCenter.why.destination", false, "privacyCenter.why.reason.entered"],
      ["privacyCenter.why.provider", false, "privacyCenter.why.reason.publicLink"],
      ["privacyCenter.why.execution", false, "privacyCenter.why.reason.recent"],
    ]);
    expect(whyLines(["exact-amount"])[3]).toMatchObject({ ok: false, reason: "privacyCenter.why.reason.exactAmount" });
  });
  it("the Swap quote's badge opens the sheet: the four lines and the public-metadata sentence", () => {
    const base = SWAP_FIXTURES["same-chain"];
    const model: SwapModel = { ...base, quote: { ...base.quote!, why: whyLines(["recent", "public-link"]) } as SwapModel["quote"] };
    render(
      <SwapView model={model} actions={{ onAmount: () => {}, onPayAsset: () => {}, onReceiveAsset: () => {}, onReview: () => {}, onNewQuote: () => {} }} />,
    );
    fireEvent.click(screen.getByTestId("swap-protection"));
    const sheet = screen.getByTestId("swap-why");
    const lines = within(sheet).getByTestId("swap-why-lines").querySelectorAll("li");
    expect([...lines].map((li) => li.getAttribute("data-ok"))).toEqual(["1", "1", "0", "0"]);
    expect(sheet.textContent).toContain("Protected source");
    expect(sheet.textContent).toContain("You protected these funds recently");
    expect(sheet.textContent).toContain("Some blockchain metadata remains public.");
  });
});
