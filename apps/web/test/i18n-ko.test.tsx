// @vitest-environment jsdom
// Korean (spec v2.0 §18; doc §78; V6 Stage 16): the catalog has every English key, each with the English placeholders
// (a plural ending excepted) and none of the words the wallet never uses; it is its own chunk, in memory only once a
// Korean reader needs it; every Simple screen rendered in Korean shows no English word beyond names, symbols and
// units; the picker under More → Language (Automatic, English, 한국어) writes the preference, and the catalog, the
// document's lang and Intl follow — English chosen on a Korean device stays English. The safety steps of a large payment
// read in Korean too (audit round 2, r55): the address book's status under a typed destination, its way forward, the
// verification and the immediate use.
import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { resetLabels } from "@privacy-wallet/ui";
import { LIMITS } from "@privacy-wallet/protocol/wallet/privacyCenter";
import { en } from "../src/app/i18n/en";
import { ko } from "../src/app/i18n/ko";
import { catalogReady, loadCatalog } from "../src/app/i18n/catalogs";
import { getLocale, setLocale, t } from "../src/app/i18n/messages";
import { formatCount, formatDate, intlLocale } from "../src/app/i18n/intl";
import { applyLocale } from "../src/app/i18n/locale";
import { prefs } from "../src/storage/prefs";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { FIXTURES } from "../src/fixtures/registry";
import { groupByDay, type ActivityRow } from "../src/features/activity/rows";
import { LIMIT_KEYS } from "../src/features/privacy-center/View";
import { renderApp } from "./helpers/render";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { Providers } from "../src/app/Providers";
import { PROVIDER_FUTURE, ROUTER_FUTURE } from "../src/routes";
import { SendScreen } from "../src/features/send/SendScreen";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import type { Deployment } from "@privacy-wallet/sdk/chain";
import { APPROVAL_IDLE_MS, COOLING_OFF_MS } from "@privacy-wallet/protocol/wallet/addressBook";
import type { Tier } from "@privacy-wallet/protocol/wallet/valuation";
import {
  addAddress,
  approveAddress,
  destinationCheck,
  findEntry,
  overrideCoolingOff,
  retireAddress,
  verifyAddress,
  type DestinationCheck,
} from "@privacy-wallet/sdk/wallet/addressBook";
import { consumeFreshAddress } from "@privacy-wallet/sdk/keys/chainKeys";
import { AddressBookPanel, DestinationStatus } from "../src/components/protection/AddressBook";
import { destinationStatusWords } from "../src/features/destinationWords";

// the relayer's terms (Send quotes with them): read from the engine, never fetched here
vi.mock("@privacy-wallet/sdk/privateTx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@privacy-wallet/sdk/privateTx")>()),
  feeTerms: async () => ({
    url: "http://relayer.test",
    info: { feePercentBps: 100 },
    fee: { amount: 10n ** 15n, ownerCommitment: 0n, viewPub: new Uint8Array(32), vault: 0n },
  }),
}));

const nav = navigator as unknown as { languages: readonly string[] };
const browserLanguages = (languages: readonly string[]) => Object.defineProperty(navigator, "languages", { value: languages, configurable: true });
const original = nav.languages;
afterEach(() => {
  cleanup();
  setLocale("en");
  resetLabels();
  prefs().reset();
  session.forget();
  settings.reset();
  noteStore.clear();
  browserLanguages(original);
});

const placeholders = (s: string) => new Set(s.match(/\{\w+\}/g) ?? []);
/** Names, symbols and units a Korean screen keeps as they are (proper names of networks, assets and services). */
const NAMES = ["USD Coin", "Tether USD", "Wrapped Ether"];
const KEPT = new Set([
  "IP",
  "Tor",
  "ETH",
  "USDC",
  "USDT",
  "BTC",
  "WETH",
  "DAI",
  "SOL",
  "USD",
  "RPC",
  "API",
  "EVM",
  "AI",
  "ID",
  "JSON",
  "Ethereum",
  "Bitcoin",
  "Solana",
  "Base",
  "Arbitrum",
  "Optimism",
  "Sepolia",
  "THORChain",
  "THORNode",
  "Chainlink",
  "Chainflip",
  "NEAR",
  "LI.FI",
  "Face",
  "Touch",
  "Windows",
  "Hello",
  "bps",
  "tx",
  "REPLACE",
  "FORGET",
]);

/** The English words of a text beyond names, symbols and units (an address, its 0x prefix or a host name is not a word). */
function englishOf(text: string): string[] {
  let s = text
    .replace(/0x[0-9a-fA-F]*(…[0-9a-fA-F]+)?/g, " ")
    .replace(/\b(bc1|tb1)[0-9a-z…]+/g, " ")
    .replace(/\b[a-z0-9-]+(\.[a-z0-9-]+)+\b/g, " ");
  for (const name of NAMES) s = s.split(name).join(" ");
  return (s.match(/[A-Za-z][A-Za-z.]*[A-Za-z]|[A-Za-z]/g) ?? []).filter((w) => !KEPT.has(w));
}

/**
 * What a reader reads in `root`, text node by node (adjacent elements do not run together), and its English words: not an
 * aria-hidden glyph, nor a text marked `translate="no"` (an address, the exact text a destination signs, a typed phrase).
 */
function englishWords(root: Element): string[] {
  const nodes: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode())
    if (!n.parentElement?.closest("[aria-hidden='true'], [translate='no']")) nodes.push(n.textContent ?? "");
  return [...new Set(nodes.flatMap(englishOf))];
}

// two destinations typed by hand (EIP-55)
const TYPED = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const OLDER = getAddress("0x" + "5a".repeat(20));

describe("Korean (spec v2.0 §18, doc §78)", () => {
  it("is its own chunk: not in memory until a Korean reader needs it (an English reader never downloads it)", async () => {
    expect(catalogReady("en")).toBe(true);
    expect(catalogReady("ko"), "nothing loaded it yet").toBe(false);
    const catalogs = readFileSync(join(__dirname, "..", "src", "app", "i18n", "catalogs.ts"), "utf8");
    expect(catalogs).toContain('import("./ko")');
    expect(catalogs).not.toMatch(/from "\.\/ko"/);
    await loadCatalog("ko");
    expect(catalogReady("ko")).toBe(true);
    expect(t("nav.home", undefined, "ko")).toBe("홈");
  });

  it("has every English key, each with the English placeholders (no plural ending), and translates every sentence", () => {
    expect(Object.keys(ko).sort()).toEqual(Object.keys(en).sort());
    for (const k of Object.keys(en) as (keyof typeof en)[]) {
      const e = placeholders(en[k]);
      const kk = placeholders(ko[k]);
      for (const p of kk) expect(e.has(p), `${k}: ${p} is not an English placeholder`).toBe(true);
      for (const p of e) if (p !== "{plural}") expect(kk.has(p), `${k} lacks ${p}`).toBe(true);
      expect(kk.has("{plural}"), `${k}: Korean has no plural ending`).toBe(false);
      expect(ko[k].trim(), k).not.toBe("");
      // a value left as the English is only one with no word to translate ("{n}", "tx {hash}", "REPLACE")
      if (ko[k] === en[k]) expect(en[k].replace(/\{\w+\}/g, "").replace(/\b(REPLACE|FORGET|tx)\b/g, ""), k).not.toMatch(/[A-Za-z]{3,}/);
    }
  });

  it("never uses the words the wallet never uses, says only that the settlement is not atomic, and keeps the typed words", () => {
    const NEVER = ["익명", "믹서", "믹싱", "추적 불가", "추적할 수 없", "보이지 않", "탐지 불가", "탐지할 수 없", "감지 불가", "감지할 수 없"];
    for (const [k, v] of Object.entries(ko)) {
      for (const w of NEVER) expect(v.includes(w), `${k} uses ${w}`).toBe(false);
      if (v.includes("원자적")) expect(v, k).toMatch(/원자적이지 않/);
    }
    expect(ko["screen.review.notAtomic"]).toMatch(/원자적이지 않습니다/);
    // the confirmation compares the typed word itself (Lock.tsx, Security.tsx)
    expect(ko["lock.replacePlaceholder"]).toBe("REPLACE");
    expect(ko["lock.replaceWarning"]).toContain("REPLACE");
    expect(ko["security.forget.body"]).toContain("FORGET");
    expect(ko["security.forget.typeWord"]).toContain("FORGET");
  });

  it("every Simple screen in Korean shows no English word beyond names, symbols and units", async () => {
    await loadCatalog("ko");
    prefs().update({ locale: "ko", localeChosen: true });
    expect(applyLocale(), "the catalog and the design system's words").toBe("ko");
    const screens = FIXTURES.filter((f) => f.kind === "screen" && f.simple && !f.id.startsWith("shell"));
    expect(screens.length).toBeGreaterThan(25);
    const leaks: string[] = [];
    for (const f of screens) {
      const { container, unmount } = render(<>{f.render()}</>);
      const english = englishWords(container.querySelector("main") ?? container);
      if (english.length) leaks.push(`${f.id}: ${english.join(", ")}`);
      unmount();
    }
    expect(leaks).toEqual([]);
  });

  it("the address book's safety steps read in Korean: a typed destination's status, its way forward, the verification and the immediate use (audit round 2, r55)", async () => {
    await loadCatalog("ko");
    prefs().update({ locale: "ko", localeChosen: true });
    expect(applyLocale()).toBe("ko");
    await session.create("a strong password");
    session.acknowledgePhrase();
    const seed = session.state().seed!;
    const leaks: string[] = [];
    const scan = (id: string, root: Element) => {
      const english = englishWords(root);
      if (english.length) leaks.push(`${id}: ${english.join(", ")}`);
    };
    const status = () => screen.getByTestId("destination-status");
    // not in the book, at the high-value tier (any amount while the prices are out): the status and the way forward
    const typed = render(<DestinationStatus chain="evm" address={TYPED} tier="high-value" masterSeed={seed} deployment={null} />);
    expect(status()).toHaveAttribute("data-reason", "unknown");
    expect(status()).toHaveTextContent("주소록에 없는 주소입니다");
    scan("unknown", typed.container);
    // added: the verification opens on the groups; then the signed message (its text to sign kept as it is)
    fireEvent.click(screen.getByTestId("add-to-book"));
    expect(status()).toHaveAttribute("data-reason", "unverified");
    expect(screen.getByTestId("verify-groups")).toBeInTheDocument();
    scan("verify: the groups", typed.container);
    fireEvent.click(typed.container.querySelector('[data-method="signed-message"]')!);
    expect(screen.getByTestId("challenge")).toBeInTheDocument();
    scan("verify: a signed message", typed.container);
    // verified, in its cooling-off: the immediate use (its phrase typed as it is)
    act(() => {
      verifyAddress(findEntry("evm", TYPED)!.id, "groups-read");
    });
    expect(status()).toHaveAttribute("data-reason", "cooling-off");
    fireEvent.click(screen.getByTestId("override-destination"));
    expect(screen.getByTestId("override-panel")).toBeInTheDocument();
    scan("cooling-off: the immediate use", typed.container);
    typed.unmount();
    // verified and out of its cooling-off, not approved yet
    const older = addAddress({ chain: "evm", address: OLDER, now: Date.now() - COOLING_OFF_MS - 60_000 });
    if (!older.ok) throw new Error(older.reason);
    act(() => {
      verifyAddress(older.entry.id, "groups-read");
    });
    const unapproved = render(<DestinationStatus chain="evm" address={OLDER} tier="high-value" masterSeed={seed} deployment={null} />);
    expect(status()).toHaveAttribute("data-reason", "unapproved");
    expect(screen.getByTestId("approve-destination")).toHaveTextContent("큰 금액 사용 승인");
    scan("unapproved", unapproved.container);
    unapproved.unmount();
    // the book itself (More → Advanced): every entry with its words, a fresh address of this wallet among them
    act(() => {
      consumeFreshAddress(seed, "evm");
    });
    const book = render(<AddressBookPanel deployment={null} />);
    expect(book.container.querySelectorAll('[data-testid="book-entry"]')).toHaveLength(3);
    expect(book.container).toHaveTextContent("새 주소 #1");
    scan("the address book", book.container);
    expect(leaks).toEqual([]);
  });

  it("Send to a typed address while the prices are out — the high-value tier at any amount — reads in Korean: the note under the address and its way forward (audit round 2, r55)", async () => {
    await loadCatalog("ko");
    prefs().update({ locale: "ko", localeChosen: true });
    expect(applyLocale()).toBe("ko");
    await session.create("a strong password");
    session.acknowledgePhrase();
    const vault = getAddress("0x00000000000000000000000000000000000000e7");
    // chain 1 with its price feeds unreadable here: the fail-safe tier, high-value
    const deployment: Deployment = {
      chainId: 1,
      core: getAddress("0x00000000000000000000000000000000000000c0"),
      ethVault: vault,
      rpcUrl: "http://127.0.0.1:1",
      rpcUrls: ["http://127.0.0.1:1"],
      fromBlock: 0n,
      erc20Vaults: [],
    };
    noteStore.add({ note: { vaultId: BigInt(vault), amount: 10n ** 18n, ownerCommitment: 1n, noteSecret: 2n }, leafIndex: 0, noteData: "0x", spent: false });
    const fetched = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
    try {
      const router = createMemoryRouter([{ path: "/send/*", element: <SendScreen masterSeed={session.state().seed!} deployment={deployment} /> }], {
        initialEntries: ["/send"],
        future: ROUTER_FUTURE,
      });
      const view = render(
        <Providers deployment={deployment}>
          <RouterProvider router={router} future={PROVIDER_FUTURE} />
        </Providers>,
      );
      fireEvent.change(screen.getByTestId("amount-input"), { target: { value: "0.3" } });
      fireEvent.change(screen.getByTestId("address-input"), { target: { value: TYPED } });
      await waitFor(() => expect(screen.getByTestId("destination-status")).toHaveAttribute("data-reason", "unknown"));
      expect(view.container).toHaveTextContent("주소록에 없는 주소입니다");
      expect(englishWords(view.container)).toEqual([]);
    } finally {
      globalThis.fetch = fetched;
    }
  });

  it("a destination's status reads as the address book's own words in English and in Korean words in Korean, in every state (audit round 2, r55)", async () => {
    await loadCatalog("ko");
    await session.create("a strong password");
    session.acknowledgePhrase();
    const now = Date.now();
    const states: [string, DestinationCheck, number][] = [];
    const at = (state: string, address: string, tier: Tier, when = now) => states.push([state, destinationCheck("evm", address, { tier, now: when }), when]);
    at("unknown", TYPED, "high-value");
    at("entered", TYPED, "standard");
    const typed = addAddress({ chain: "evm", address: TYPED, now });
    if (!typed.ok) throw new Error(typed.reason);
    at("unverified", TYPED, "high-value");
    verifyAddress(typed.entry.id, "groups-read", undefined, now);
    at("cooling-off", TYPED, "high-value", now + 3_600_000);
    overrideCoolingOff(typed.entry.id, "second-factor", undefined, now);
    at("overridden", TYPED, "high-value");
    const older = addAddress({ chain: "evm", address: OLDER, now: now - COOLING_OFF_MS - 60_000 });
    if (!older.ok) throw new Error(older.reason);
    verifyAddress(older.entry.id, "groups-read", undefined, now - 60_000);
    at("unapproved", OLDER, "high-value");
    approveAddress(older.entry.id, undefined, now);
    at("verified", OLDER, "high-value");
    at("stale", OLDER, "high-value", now + APPROVAL_IDLE_MS + 3_600_000);
    retireAddress(older.entry.id);
    at("retired", OLDER, "high-value");
    at("fresh", consumeFreshAddress(session.state().seed!, "evm").address, "high-value");
    expect(states.map(([, c]) => (c.ok ? "ok" : c.reason))).toEqual([
      "unknown",
      "ok",
      "unverified",
      "cooling-off",
      "ok",
      "unapproved",
      "ok",
      "stale",
      "retired",
      "ok",
    ]);
    for (const [state, check, when] of states) {
      expect(
        destinationStatusWords((k, v) => t(k, v, "en"), check, when),
        state,
      ).toBe(check.status);
      const korean = destinationStatusWords((k, v) => t(k, v, "ko"), check, when);
      expect(korean, state).toMatch(/[가-힣]/);
      expect(englishOf(korean), state).toEqual([]);
    }
    expect(
      destinationStatusWords((k, v) => t(k, v, "ko"), states[3][1], states[3][2]),
      "the hours of the cooling-off",
    ).toContain("23시간");
  });

  it("the wallet's limits are the protocol's, said in the reader's language", async () => {
    expect(LIMIT_KEYS.map((k) => en[k])).toEqual([...LIMITS]);
    for (const k of LIMIT_KEYS) expect(ko[k]).toMatch(/[가-힣]/);
  });

  it("numbers, dates and the days of Activity are written in the wallet's language (Intl)", async () => {
    await loadCatalog("ko");
    setLocale("ko");
    expect(intlLocale()).toBe("ko-KR");
    expect(formatDate(Date.UTC(2026, 9, 1, 12))).toMatch(/2026\. 10\. 1\./);
    expect(formatCount(1234567)).toBe("1,234,567");
    const now = Date.UTC(2026, 9, 14, 12);
    const row = (at: number) => ({ id: String(at), at }) as unknown as ActivityRow;
    const groups = groupByDay([row(now), row(now - 86_400_000), row(Date.UTC(2026, 9, 1, 12))], (k) => t(k), now, intlLocale());
    expect(groups.map((g) => g.label)).toEqual(["오늘", "어제", "2026년 10월 1일"]);
    setLocale("en");
    expect(intlLocale()).toBe("en-US");
  });

  it("More → Language: Automatic follows the device, an explicit choice wins — English on a Korean device stays English", async () => {
    browserLanguages(["ko-KR", "en-US"]);
    await session.create("a strong password");
    session.acknowledgePhrase();
    prefs().update({ firstLaunchDone: true });
    await renderApp("/more/language");
    // Automatic: the device is Korean, so the wallet is (once the Korean chunk has loaded)
    await waitFor(() => expect(document.documentElement.lang).toBe("ko"));
    expect(await screen.findByTestId("language")).toHaveTextContent("언어");
    expect(screen.getByTestId("language-auto")).toHaveAttribute("aria-checked", "true");
    // English, chosen
    fireEvent.click(screen.getByTestId("language-en"));
    expect(prefs().get()).toMatchObject({ locale: "en", localeChosen: true });
    await waitFor(() => expect(document.documentElement.lang).toBe("en"));
    expect(getLocale()).toBe("en");
    expect(screen.getByTestId("language")).toHaveTextContent("Language");
    expect(applyLocale(), "the device's Korean does not override the choice").toBe("en");
    // Automatic again: the device decides
    fireEvent.click(screen.getByTestId("language-auto"));
    expect(prefs().get().localeChosen).toBeUndefined();
    await waitFor(() => expect(document.documentElement.lang).toBe("ko"));
    // 한국어 on an English device
    browserLanguages(["en-US"]);
    fireEvent.click(screen.getByTestId("language-ko"));
    expect(prefs().get()).toMatchObject({ locale: "ko", localeChosen: true });
    await waitFor(() => expect(getLocale()).toBe("ko"));
    expect(document.documentElement.lang).toBe("ko");
    expect(screen.getByTestId("language-ko").closest("label")).toHaveTextContent("한국어");
  });
});
