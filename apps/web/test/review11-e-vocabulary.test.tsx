// @vitest-environment happy-dom
// The eleventh review round (2026-11-04): what a Simple screen says. E11-3 — the spec's vocabulary gate (spec v2.0 §1: "These words MUST NOT
// appear in a Simple screen's visible text … Gas, Merkle, root, Nullifier, Proof … escrow … slippage") ran over the visual harness's
// fixtures only, and its one recovery fixture is synthetic, so the catalog's own words — which the verdict, the recovery card, the attempt
// line, Activity and the Fees & refunds page draw in every experience — said escrow, gas, root and proof: 38 failure strings, the proving
// line, the minimum-moved card, the protected execution's cap sentence, four sentences of the fee policy. Every key a Simple screen draws is
// held here to the harness's own list (read from tests/visual/run.mjs, so the two never drift) and to its Korean renderings, in English and
// in Korean, and so are the screens of stopped operations rendered from the reducer's own records. E11-8 — the Privacy Center's "nothing is
// kept in plain text" (the preferences are not encrypted: src/storage/prefs.ts) and Receive's "nothing about the payment is public" (a
// private transfer is a public transaction) said more than the wallet keeps.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { reasonOf, recoveryFor } from "@privacy-wallet/sdk/operations/reducer";
import { reasonKey } from "@privacy-wallet/sdk/operations/errors/codes";
import type { OperationRecord } from "@privacy-wallet/sdk/wallet/operationRecord";
import { en, type MessageKey } from "../src/app/i18n/en";
import { ko } from "../src/app/i18n/ko";
import { loadCatalog } from "../src/app/i18n/catalogs";
import { setLocale, t } from "../src/app/i18n/messages";
import { OperationProgress } from "../src/features/operations/OperationProgress";
import { Recovery } from "../src/features/operations/RecoveryCard";
import { FeesAndRefunds } from "../src/features/privacy-center/FeesAndRefunds";
import { PrefsSchema } from "../src/storage/prefs";

afterEach(() => {
  cleanup();
  setLocale("en");
});

/** The visual harness's list (tests/visual/run.mjs `BANNED`, doc §92), read from the harness itself. */
function harnessList(): [string, RegExp][] {
  const run = readFileSync(join(__dirname, "..", "..", "..", "tests", "visual", "run.mjs"), "utf8");
  const block = /\nconst BANNED = \[([\s\S]*?)\n\];/.exec(run)?.[1] ?? "";
  return [...block.matchAll(/\[\s*"([^"]+)",\s*\/((?:\\\/|[^/])+)\/([a-z]*)\s*\]/g)].map((m): [string, RegExp] => [m[1], new RegExp(m[2], m[3])]);
}
const BANNED = harnessList();
/** The same words as the Korean catalog writes them (the harness reads Latin letters only); 증명 is proof and proving alike. */
const BANNED_KO: [string, RegExp][] = [
  ["Router", /라우터/],
  ["Calldata", /콜데이터/],
  ["Gas", /가스/],
  ["Merkle", /머클/],
  ["root", /루트/],
  ["Nullifier", /널리파이어/],
  ["Proof", /증명/],
  ["Provider ID", /제공자 ID/],
  ["escrow", /에스크로/],
  ["commitment", /커밋먼트/],
  ["witness", /위트니스/],
  ["nonce", /논스/],
  ["wei / gwei", /(?<!게이트)웨이/],
  ["tranche", /트랜치/],
  ["memo", /메모/],
  ["slippage", /슬리피지/],
];
const bannedIn = (text: string, korean: boolean): string[] => [...BANNED, ...(korean ? BANNED_KO : [])].filter(([, rx]) => rx.test(text)).map(([w]) => w);

/**
 * The keys whose words a Simple screen draws: the operation's states, progress lines, actions, first sentences, failures and recovery (the
 * verdict, the recovery card, the attempt line and Activity draw them in every experience), the progress pages, the screens, the protected
 * execution's words (its progress opens from the Simple steps page), the notifications, the settlement labels, the fee policy, the
 * Reviews' (the enhanced Review a Simple sender confirms on: the third critique of slice 4), the privacy check's lines that Review draws
 * for a send to a public address (its fourth critique), the Privacy Center Simple's More lists, What stays private it opens and the Forget
 * dialog (its fifth). The Privacy Center's "Why?" lines (privacyCenter.why.*) are its Advanced categories, opened on request, and keep
 * their technical words.
 */
const SIMPLE = /^(op\.|progress\.|screen\.|campaign\.|notification\.|settlement\.|recovery\.|feePolicy\.|review\.|lint\.|privacyCenter\.(?!why\.)|whatStaysPrivate\.|security\.forget)/;
const SIMPLE_KEYS = (Object.keys(en) as MessageKey[]).filter((k) => SIMPLE.test(k));

/** What a reader meets in `root`: its text and the names assistive technology reads (a progress bar's label is one). */
const shown = (root: Element): string => [root.textContent ?? "", ...[...root.querySelectorAll("[aria-label]")].map((e) => e.getAttribute("aria-label") ?? "")].join(" ");

const NOW = 1_800_000_000_000;
const ORDER = `0x${"ab".repeat(32)}`;
/** A swap stopped as the reducer leaves it: the catalog's reason and the recovery it opens. */
function stoppedSwap(code: string, over: Partial<OperationRecord> = {}): OperationRecord {
  const base: OperationRecord = {
    v: 3,
    id: `swap:${ORDER}`,
    kind: "cross-chain",
    state: "RECOVERY_REQUIRED",
    phase: "execution",
    createdAt: NOW - 60_000,
    updatedAt: NOW,
    amounts: { asset: "ETH", decimals: 18, input: "1000000000000000000", outputAsset: "BTC", outputDecimals: 8 },
    fees: [],
    destination: { kind: "fresh", display: "bc1qexample", chain: "bitcoin" },
    refs: { txHashes: [`0x${"11".repeat(32)}`], orderId: ORDER },
    tier: "standard",
    reason: reasonOf(code, "unknown"),
    history: [
      { state: "SOURCE_CONFIRMING", at: NOW - 50_000 },
      { state: "RECOVERY_REQUIRED", at: NOW },
    ],
    ...over,
  };
  return { ...base, recovery: recoveryFor(base, code, NOW) };
}
/** A Send the relayer refused: nothing went out. */
const stoppedSend = (code: string): OperationRecord =>
  stoppedSwap(code, {
    id: `send:${code}`,
    kind: "withdraw",
    state: "FAILED",
    refs: { txHashes: [] },
    destination: { kind: "entered", display: "0x1212…1212", chain: "ethereum" },
    history: [{ state: "FAILED", at: NOW }],
  });

const SWAP_CODES = ["execution_window_closed", "execute_failed", "late_refund", "provider_failed", "handover_unknown", "provider_timeout", "partial_delivery"];
const SEND_CODES = ["gas_too_high", "simulation_failed", "bad_proof", "payload_hash_mismatch", "relayer_unreachable", "receipt_reverted"];

describe("E11-3: the words a Simple screen shows", () => {
  it("no key a Simple screen draws names a word of the harness's list, in English or in Korean", () => {
    expect(BANNED.length, "the harness's own list, read").toBeGreaterThanOrEqual(16);
    expect(BANNED.map(([w]) => w)).toEqual(expect.arrayContaining(["Gas", "Merkle", "root", "Nullifier", "Proof", "escrow", "witness", "tranche", "slippage"]));
    expect(SIMPLE_KEYS.length).toBeGreaterThan(500);
    const found = SIMPLE_KEYS.flatMap((k) => [...bannedIn(en[k], false).map((w) => `en ${k}: ${w}`), ...bannedIn(ko[k], true).map((w) => `ko ${k}: ${w}`)]);
    expect(found).toEqual([]);
  });

  it("the screens of a stopped swap or Send and of a transaction being secured, from the reducer's records, in English and in Korean", async () => {
    await loadCatalog("ko");
    for (const locale of ["en", "ko"]) {
      setLocale(locale);
      const korean = locale === "ko";
      for (const code of SWAP_CODES) {
        const rec = stoppedSwap(code);
        const reason = t(reasonKey(code) as MessageKey, undefined, locale);
        const a = render(<OperationProgress record={rec} />);
        const progress = shown(a.container);
        a.unmount();
        const b = render(<Recovery record={rec} onRefund={() => {}} onMonitor={() => {}} />);
        const recovery = shown(b.container);
        b.unmount();
        expect(progress, `${locale} ${code}: the swap's progress page says why`).toContain(reason);
        expect(recovery, `${locale} ${code}: the recovery card says why`).toContain(reason);
        expect(bannedIn(progress, korean), `${locale} ${code}: the progress page`).toEqual([]);
        expect(bannedIn(recovery, korean), `${locale} ${code}: the recovery card`).toEqual([]);
      }
      for (const code of SEND_CODES) {
        const r = render(<OperationProgress record={stoppedSend(code)} />);
        const text = shown(r.container);
        r.unmount();
        expect(text, `${locale} ${code}`).toContain(t(reasonKey(code) as MessageKey, undefined, locale));
        expect(bannedIn(text, korean), `${locale} ${code}: the Send's page`).toEqual([]);
      }
      // the proving step's line and its progress bar's name
      const proving = stoppedSwap("unknown", { id: "send:proving", kind: "send", state: "PREPARING_PROOF", reason: undefined, refs: { txHashes: [] }, progress: { step: "proof" } });
      const p = render(<OperationProgress record={{ ...proving, recovery: undefined }} />);
      const text = shown(p.container);
      p.unmount();
      expect(text, locale).toContain(t("progress.proving", undefined, locale));
      expect(bannedIn(text, korean), `${locale}: a transaction being secured`).toEqual([]);
    }
  });

  it("the Fees & refunds page, in English and in Korean, states the policy without them", async () => {
    await loadCatalog("ko");
    for (const locale of ["en", "ko"]) {
      setLocale(locale);
      const r = render(<FeesAndRefunds onBack={() => {}} />);
      const text = shown(r.container);
      r.unmount();
      for (const k of ["feePolicy.executorTip", "feePolicy.neverTwice", "feePolicy.earnedAtFunding", "feePolicy.classic"] as const) expect(text, `${locale} ${k}`).toContain(t(k, undefined, locale));
      expect(bannedIn(text, locale === "ko"), locale).toEqual([]);
    }
  });
});

describe("E11-8: two privacy claims, as the wallet keeps them", () => {
  it("the Privacy Center's stored data: what is encrypted, and the preferences that are not", () => {
    // the preferences src/storage/prefs.ts keeps in the clear that a reader would recognize, by the words the note uses for each; the
    // others are no choice of the user's (the format's version, a flag, the language's "chosen" mark, an unused network, databases to delete)
    const NAMED: Record<string, { en: RegExp; ko: RegExp }> = {
      locale: { en: /the language/, ko: /언어/ },
      theme: { en: /the theme/, ko: /테마/ },
      experience: { en: /Simple or Advanced/, ko: /간편 또는 고급/ },
      backup: { en: /when you last backed up/, ko: /마지막 백업 시각/ },
      lastConnector: { en: /the last wallet connected/, ko: /마지막으로 연결한 지갑/ },
    };
    const INTERNAL = ["v", "firstLaunchDone", "localeChosen", "recentNetwork", "pendingWipe"];
    expect(Object.keys(PrefsSchema.shape).sort(), "a new preference kept in the clear is named here, or said to be no choice of the user's").toEqual([...Object.keys(NAMED), ...INTERNAL].sort());
    const note = { en: en["privacyCenter.storedNote"], ko: ko["privacyCenter.storedNote"] };
    expect(note.en).not.toMatch(/nothing is kept in plain text/);
    expect(note.ko).not.toContain("평문으로 보관되는 것은 없습니다");
    expect(note.en).toMatch(/^Notes, operations, the address book and the settings are encrypted with your password on this device\. Not encrypted: a few preferences \(/);
    expect(note.ko).toMatch(/^노트, 작업, 주소록, 설정은 이 기기에서 비밀번호로 암호화됩니다\. 암호화되지 않는 것: 몇 가지 환경 설정\(/);
    // the rest kept in the clear, named too (the critique of E11-8: the list had read as complete): WalletConnect's own record of a connection,
    // with the public account, and the files that make private transactions faster — they show one was made here
    expect(note.en).toMatch(/while WalletConnect is connected, its own record of the connection, with your public account/);
    expect(note.en).toMatch(/the files kept to make private transactions faster, which show that one was made here\.$/);
    expect(note.ko).toMatch(/WalletConnect가 연결되어 있는 동안 그 연결에 대한 WalletConnect 자체 기록\(공개 계정 포함\)/);
    expect(note.ko).toMatch(/비공개 거래를 빠르게 하려고 보관하는 파일\(이 기기에서 비공개 거래가 있었음을 보여 줌\)\.$/);
    for (const [field, words] of Object.entries(NAMED)) {
      expect(note.en, field).toMatch(words.en);
      expect(note.ko, field).toMatch(words.ko);
    }
  });

  it("Receive's private address: only that a private transaction took place, when, and which account submitted it is public (and its critique: the submitting account)", () => {
    expect(en["receive.notePrivate"]).not.toMatch(/nothing about the payment is public/);
    expect(ko["receive.notePrivate"]).not.toContain("어떤 정보도 공개되지 않습니다");
    expect(en["receive.notePrivate"]).toContain(
      "only that a private transaction took place, when, and which account submitted it (a relayer's, or the sender's own wallet) is public",
    );
    expect(ko["receive.notePrivate"]).toContain("비공개 거래가 있었다는 사실, 그 시각, 그리고 거래를 제출한 계정(릴레이어의 계정 또는 보내는 사람 자신의 지갑)만 공개됩니다");
  });
});
