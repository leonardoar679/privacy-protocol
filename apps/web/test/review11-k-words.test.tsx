// @vitest-environment happy-dom
// The eleventh review round (2026-11-04), after the slice's critique (T11, T12) — the words the user sees. The trade check's answer is held to
// the wallet's words before the Swap's Review shows it (H11-6): streamed through checkTrade, a line that says "mixer", "untraceable" or "100 %
// private" is withheld, and the Review shows it under the wallet's own label and words — the forbidden ones never reach the screen. The lock
// screens say a refusal in the reader's words, never the engine's English (K3-5): the unlock of a wallet another tab forgot says the wallet is
// gone, not "Wrong password." (A11-6); a recovery phrase pasted in the backup file's field, a phrase cut short, a misspelt word read in Korean.
// (The campaign's order_not_ours line is the runner's own English history note, no catalog key; its scripted world is campaign-runner's own.)
import "fake-indexeddb/auto";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { wordlist } from "@scure/bip39/wordlists/english";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { seedToPhrase } from "@privacy-wallet/sdk/wallet/keystore";
import { JOURNAL_KEY, KEYSTORE_KEY } from "@privacy-wallet/sdk/wallet/storage";
import { controlsFor } from "@privacy-wallet/sdk/tiers";
import { createSecureStore, secureStore } from "../src/storage/secureStore";
import { checkTrade, TRADE_CHECK_FORBIDDEN, tradeSummary } from "../src/zkapi/tradeCheck";
import type { InferenceAccess } from "../src/zkapi/policy";
import { Review, type ReviewProps } from "../src/features/review/ReviewScreen";
import { Restore, Unlock } from "../src/features/onboarding/Lock";
import { en } from "../src/app/i18n/en";
import { ko } from "../src/app/i18n/ko";
import { loadCatalog } from "../src/app/i18n/catalogs";
import { setLocale } from "../src/app/i18n/messages";

afterEach(() => {
  cleanup();
  setLocale("en");
  session.forget();
});

// ---------------------------------------------------------------------------------------------------------------- H11-6
const ACCESS: InferenceAccess = {
  mode: "ephemeral-key",
  apiKey: "k",
  baseUrl: "https://inference.example/v1",
  spendingLimitUsd: 1,
  headers: { authorization: "Bearer k" },
  release: () => {},
};
const MODEL = "openai/gpt-4o-mini";
const summary = () =>
  tradeSummary({
    from: { chain: "ethereum", symbol: "ETH", decimals: 18 },
    to: { chain: "bitcoin", symbol: "BTC", decimals: 8 },
    amountUnits: 400n * 10n ** 18n,
    usd: 1_000_000,
    tier: "high-value",
  });
/** The model's answer: three plain lines, then a mixer, an untraceable and a 100 % private claim. */
const ANSWER = {
  bestRoute: "Keep THORChain streaming.",
  alternative: "Chainflip quoted 0.2 % less.",
  estimatedSavings: "About 0.1 % against Chainflip.",
  privacy: "The pool works like a mixer.",
  execution: "Each part is untraceable once it lands.",
  risk: "This route is 100 % private.",
};
const NEVER_SAID = /mixer|untraceable|100 % private/i;
/** The answer streamed as a provider streams it, in pieces that cut through those words: no piece alone holds one. */
function streamed(answer: Record<string, string>) {
  const text = JSON.stringify(answer);
  const cuts = [text.indexOf("mixer") + 3, text.indexOf("untraceable") + 5, text.indexOf("100 %") + 2];
  const pieces = [0, ...cuts].map((at, i) => text.slice(at, cuts[i] ?? text.length));
  const sse = [...pieces.map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`), "data: [DONE]"].join("\n\n") + "\n\n";
  const asked: string[] = [];
  const fetchImpl = (async (url: unknown) => {
    asked.push(String(url));
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return { text, pieces, asked, fetchImpl };
}
/** The Swap's Review at the commit, as Swap.tsx passes it: Check this trade runs checkTrade on the sanitized summary. */
const reviewProps = (over: Partial<ReviewProps> = {}): ReviewProps => ({
  moment: "commit",
  tier: "high-value",
  controls: controlsFor("high-value"),
  usd: "$1,000,000",
  amount: "400 ETH",
  from: "Private ETH",
  to: { network: "Bitcoin", asset: "BTC", address: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu", kind: "fresh" },
  privacy: { level: "Good" },
  lint: [],
  onAcknowledgeLint: () => {},
  lines: [],
  onConfirm: () => {},
  onCancel: () => {},
  ...over,
});

describe("the trade check's answer, held to the wallet's words before the Review (H11-6)", () => {
  it("checkTrade withholds each line of the streamed answer that says mixer, untraceable or 100 % private — its text emptied, its name in withheld — and keeps the plain lines as written", async () => {
    const { text, pieces, asked, fetchImpl } = streamed(ANSWER);
    expect(pieces.join("")).toBe(text);
    expect(
      pieces.filter((p) => TRADE_CHECK_FORBIDDEN.test(p)),
      "no piece alone holds a word: the answer is held once it is whole",
    ).toEqual([]);
    const r = await checkTrade(ACCESS, MODEL, summary(), undefined, fetchImpl);
    expect(asked).toEqual(["https://inference.example/v1/chat/completions"]);
    expect(r).toEqual({
      bestRoute: "Keep THORChain streaming.",
      alternative: "Chainflip quoted 0.2 % less.",
      estimatedSavings: "About 0.1 % against Chainflip.",
      privacy: "",
      execution: "",
      risk: "",
      withheld: ["privacy", "execution", "risk"],
    });
    expect(JSON.stringify(r)).not.toMatch(NEVER_SAID);
  });

  it("the Review's Check this trade shows the withheld lines under the wallet's own labels and words, the plain ones as written; mixer, untraceable and the 100 % claim never reach the screen", async () => {
    const { fetchImpl } = streamed(ANSWER);
    render(<Review {...reviewProps({ tradeCheck: { available: true, run: () => checkTrade(ACCESS, MODEL, summary(), undefined, fetchImpl) } })} />);
    fireEvent.click(screen.getByRole("button", { name: en["review.tradeCheck.button"] }));
    const result = await screen.findByTestId("trade-check-result");
    const withheld = [...result.querySelectorAll('[data-testid^="trade-check-withheld-"]')];
    expect(
      withheld.map((row) => [row.getAttribute("data-testid"), row.querySelector(".ds-kv-label")?.textContent, row.querySelector(".ds-kv-value")?.textContent]),
    ).toEqual([
      ["trade-check-withheld-privacy", en["review.tradeCheck.privacy"], en["review.tradeCheck.withheld"]],
      ["trade-check-withheld-execution", en["review.tradeCheck.execution"], en["review.tradeCheck.withheld"]],
      ["trade-check-withheld-risk", en["review.tradeCheck.risk"], en["review.tradeCheck.withheld"]],
    ]);
    for (const line of [ANSWER.bestRoute, ANSWER.alternative, ANSWER.estimatedSavings]) expect(result.textContent).toContain(line);
    expect(document.body.textContent).not.toMatch(NEVER_SAID);
  });
});

// ---------------------------------------------------------------------------------------------------------- A11-6, K3-5
const PASSWORD = "a strong password";
const WORDS = seedToPhrase(new Uint8Array(32).fill(9)).split(" ");
const lockScreen = (node: ReactElement) => render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>{node}</MemoryRouter>);
const type = (id: string, value: string) => fireEvent.change(document.getElementById(id) as HTMLInputElement, { target: { value } });
/** Submits the screen's form and reads the refusal it shows (the submit clears the one before). */
async function refusal(submit: "unlock" | "restore"): Promise<string | null> {
  fireEvent.click(screen.getByTestId(submit));
  return (await screen.findByRole("alert")).textContent;
}

describe("the lock screens say a refusal in the reader's words (A11-6, K3-5)", () => {
  it("the unlock of a wallet another tab forgot says it is no longer on this device — never 'Wrong password.', which a wrong password alone reads (A11-6)", async () => {
    await session.create(PASSWORD);
    session.acknowledgePhrase();
    session.lock();
    expect(secureStore().backend, "the page's store over IndexedDB").toBe("indexeddb");
    await secureStore().flush();
    lockScreen(<Unlock />);
    type("unlock-password", "not the password");
    expect(await refusal("unlock"), "control: the wallet is here, the password is wrong").toBe(en["lock.wrongPassword"]);
    // another tab of this browser forgets the wallet: its own store over the same IndexedDB removes the keystore and the journal
    const otherTab = createSecureStore();
    await otherTab.ready;
    otherTab.remove(KEYSTORE_KEY);
    otherTab.remove(JOURNAL_KEY);
    await otherTab.flush();
    expect(session.hasKeystore(), "this tab's copy still holds it: the unlock reads the store again").toBe(true);
    type("unlock-password", PASSWORD);
    const words = await refusal("unlock");
    expect(words).toBe(en["lock.walletRemoved"]);
    expect(words).not.toContain(en["lock.wrongPassword"]);
    expect([session.state().status, session.isUnlocked()]).toEqual(["none", false]);
  });

  it("Restore from a backup file with a recovery phrase pasted in the file's field: 'not a wallet backup' in the wallet's words, the paste never echoed, nothing restored (K3-5)", async () => {
    lockScreen(<Restore />);
    fireEvent.click(screen.getByTestId("restore-file"));
    type("restore-json", WORDS.join(" "));
    type("restore-file-password", PASSWORD);
    expect(await refusal("restore")).toBe(en["lock.refused.notABackup"]);
    expect(session.hasKeystore(), "nothing was restored").toBe(false);
  });

  it("Restore from a phrase cut short at 23 words: the length in the wallet's words, not the engine's 'the recovery phrase has 24 words' (K3-5)", async () => {
    lockScreen(<Restore />);
    type("restore-words", WORDS.slice(0, 23).join(" "));
    type("restore-password", PASSWORD);
    type("restore-confirm", PASSWORD);
    expect(await refusal("restore")).toBe(en["lock.refused.phraseLength"]);
    expect(session.hasKeystore(), "nothing was restored").toBe(false);
  });

  it("in Korean, a misspelt word of the phrase reads the catalog's Korean refusal — no English word of the engine's (K3-5)", async () => {
    await loadCatalog("ko");
    setLocale("ko");
    const typed = [...WORDS];
    typed[3] = typed[3] + typed[3].slice(-1); // its last letter doubled
    expect(wordlist, "a word of no recovery phrase").not.toContain(typed[3]);
    lockScreen(<Restore />);
    type("restore-words", typed.join(" "));
    type("restore-password", PASSWORD);
    type("restore-confirm", PASSWORD);
    const words = await refusal("restore");
    expect(words).toBe(ko["lock.refused.phraseInvalid"]);
    expect(words, "not one Latin letter").not.toMatch(/[A-Za-z]/);
    expect(session.hasKeystore(), "nothing was restored").toBe(false);
  });
});
