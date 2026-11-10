// @vitest-environment happy-dom
// The twelfth review round, 2026-11-09, W6 §5.4: a scan the counters wait on that fails says so. Over every screen, the notice: which hold — a
// restore's or this opening's — and why, what cannot finish until then, reading now, when the wallet tries again or that it waits for the
// connection, and Try again now only while a tap reads at once; its words move on their own when a time falls due (ZO's critique). Under a
// refusal it caused, the progress page's line: where the scan stands — planned, reading, failed, or read ("you can try again now"). The failing scan had said nothing anywhere (its one line was the scheduler's status, cleared in the same
// call), and the catalog's reason spoke of a restore alone and ended "Try again in a moment". Offline: the scan stubbed.
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const scan = vi.hoisted(() => ({ fails: false, error: null as unknown, releases: false, gate: null as Promise<void> | null }));
vi.mock("@privacy-wallet/sdk/privateTx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@privacy-wallet/sdk/privateTx")>()),
  scanNotes: async () => {
    if (scan.gate) await scan.gate;
    if (scan.fails) throw scan.error ?? new TypeError("fetch failed");
    if (scan.releases) (await import("@privacy-wallet/sdk/wallet/notes")).noteStore.releaseCounters(0);
    return { scanned: 10, found: 0, added: 0, spent: 0, refunds: 0, received: [], pending: [], proven: null };
  },
}));

import { RpcDisagreement, type Deployment } from "@privacy-wallet/sdk/chain";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { noteStore } from "@privacy-wallet/sdk/wallet/notes";
import { activityId, recordActivity } from "@privacy-wallet/sdk/wallet/activity";
import { schedulerStatus } from "@privacy-wallet/sdk/wallet/schedule";
import { connectivity } from "@privacy-wallet/privacy-engine/transport/connectivity";
import { settings } from "@privacy-wallet/sdk/wallet/settings";
import { DISCOVERY_ID, resetDiscoveryMemory, runDiscovery, scheduleDiscovery } from "@privacy-wallet/sdk/wallet/discovery";
import { resetOperationsMemory } from "@privacy-wallet/sdk/operations/store";
import { ScanHeldNotice } from "../src/app/ScanHeldNotice";
import { OperationProgress } from "../src/features/operations/OperationProgress";
import { registerCatalog, setLocale } from "../src/app/i18n/messages";
import { en } from "../src/app/i18n/en";
import { ko } from "../src/app/i18n/ko";
import { formatTime } from "../src/app/i18n/intl";
import { record } from "./helpers/operations";
import { renderApp } from "./helpers/render";

const MIN = 60_000;
const deployment = {
  chainId: 1,
  core: "0x00000000000000000000000000000000000000c0",
  ethVault: "0x00000000000000000000000000000000000000e7",
  rpcUrl: "http://127.0.0.1:1",
  rpcUrls: ["http://127.0.0.1:1"],
  fromBlock: 0n,
  erc20Vaults: [],
} as unknown as Deployment;
const action = () => session.journal().schedule.find((a) => a.id === DISCOVERY_ID && !a.done);
const run = (at: number) => act(() => runDiscovery(action()!, { masterSeed: new Uint8Array(32), deployment, now: () => at }));
/** the last attempt failed: the scan stubbed here fails as a fetch that never reached its host does, a failure the notice names no cause for */
const failed = (lang: typeof en | typeof ko) => lang["scan.held.lastFailed"];
/** the scheduler's poll: Try again now only while a tap brings the attempt at least this much sooner (ScanHeldNotice) */
const POLL = 10_000;
const next = (lang: typeof en | typeof ko, at: number) => `${failed(lang)} ${lang["scan.held.next"].replace("{when}", formatTime(at))}`;
const state = () => screen.getByTestId("scan-held-notice-state").textContent;
const retry = () => screen.queryByTestId("scan-held-notice-retry");
const shortly = (lang: typeof en | typeof ko) => `${failed(lang)} ${lang["scan.held.planned"]}`;
const wait = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

beforeEach(async () => {
  await session.create("a strong password");
  session.acknowledgePhrase();
  // the wallet holds something: its scans are wanted (a first launch stays request-free, spec v2.0 §10)
  recordActivity({ id: activityId("receive", "1"), kind: "receive", asset: "ETH", decimals: 18, amount: "1", status: "completed", ref: "0x01" } as never);
});
afterEach(() => {
  scan.fails = false;
  scan.releases = false;
  scan.gate = null;
  scan.error = null;
  noteStore.releaseCounters(0);
  schedulerStatus.reset();
  resetDiscoveryMemory();
  resetOperationsMemory();
  setLocale("en");
  connectivity.reset();
  session.forget();
  settings.reset();
});

/** the counters held — a restore's hold, else this unlock's — and the scan failing at `at` (ten seconds ago by default) */
async function failHeld(hold: "restore" | "unlock" = "restore", at = Date.now() - 10_000): Promise<number> {
  if (hold === "restore") noteStore.holdCounters();
  else noteStore.holdUntilScanned();
  scan.fails = true;
  scheduleDiscovery(at);
  await run(at);
  return at;
}

/** two failures in a row, the second at `second`: its next attempt two minutes on, Try again now from a minute after its start */
async function failTwice(second: number): Promise<void> {
  await failHeld("restore", second - 3 * MIN);
  await run(second);
}

describe("W6 §5.4: the notice over every screen while the scan the counters wait on fails", () => {
  it("absent while the counters are free, and while their scan has not failed", async () => {
    render(<ScanHeldNotice />);
    expect(screen.queryByTestId("scan-held-notice")).toBeNull();
    act(() => noteStore.holdCounters());
    act(() => {
      scheduleDiscovery(Date.now());
    });
    expect(screen.queryByTestId("scan-held-notice"), "planned, never failed").toBeNull();
  });

  it("after a failed attempt: which hold and why, what cannot finish, the next attempt — and no Try again now within the minute after its start, where a tap moves nothing (ZO's critique)", async () => {
    render(<ScanHeldNotice />);
    const at = await failHeld();
    const notice = await screen.findByTestId("scan-held-notice");
    expect(notice.dataset.hold).toBe("restore");
    expect(notice.textContent).toContain(en["scan.held.title"]);
    expect(notice.textContent).toContain(`${en["scan.held.restore"]} ${en["scan.held.blocked"]}`);
    expect(notice.textContent).not.toContain(en["scan.held.unlock"]);
    expect(state()).toBe(next(en, at + MIN));
    expect(retry(), "the next attempt is already that minute's end").toBeNull();
  });

  it("the words move on their own: the next attempt falling due reads 'shortly', with nothing else changing (ZO's critique)", async () => {
    render(<ScanHeldNotice />);
    const at = await failHeld("restore", Date.now() - MIN + 300);
    expect(state()).toBe(next(en, at + MIN));
    await wait(700);
    expect(state(), "a time gone by is never shown").toBe(shortly(en));
    expect(retry(), "already due: a tap would change nothing").toBeNull();
  });

  it("... and with Try again now shown, the next attempt coming within the scheduler's poll takes it away on its own: a tap would bring nothing sooner (ZS's critique)", async () => {
    render(<ScanHeldNotice />);
    const second = Date.now() - 2 * MIN + POLL + 300;
    await failTwice(second); // the next attempt a poll and 300 ms from now
    expect(state()).toBe(next(en, second + 2 * MIN));
    expect(retry(), "the minute after the last start is over, the attempt a poll away or more").toBeTruthy();
    await wait(700);
    expect(state(), "its time still ahead").toBe(next(en, second + 2 * MIN));
    expect(retry(), "within the poll").toBeNull();
  });

  it("after a quick first failure Try again now never flashes: between a minute past its start and its next attempt lies the attempt's own length (ZS's critique)", async () => {
    render(<ScanHeldNotice />);
    noteStore.holdCounters();
    scan.fails = true;
    const start = Date.now() - MIN + 300; // a minute past its start in 300 ms
    let clock = start;
    scheduleDiscovery(start);
    let open!: () => void;
    scan.gate = new Promise<void>((r) => (open = r));
    let attempt!: Promise<void>;
    act(() => {
      attempt = runDiscovery(action()!, { masterSeed: new Uint8Array(32), deployment, now: () => clock });
    });
    clock = start + 600; // it fails 600 ms after it began: its next attempt 900 ms from now
    await act(async () => {
      open();
      await attempt;
    });
    expect(state()).toBe(next(en, start + 600 + MIN));
    expect(retry()).toBeNull();
    await wait(450); // past a minute after its start, before its next attempt
    expect(retry(), "a tap could bring it no poll sooner").toBeNull();
    await wait(700);
    expect(state()).toBe(shortly(en));
    expect(retry()).toBeNull();
  });

  it("Try again now once a minute has passed since the last attempt's start: shown on its own at that moment, and a tap brings the attempt to now", async () => {
    render(<ScanHeldNotice />);
    const second = Date.now() - MIN + 300;
    await failTwice(second);
    expect(action()!.heldFailures).toBe(2);
    expect(state()).toBe(next(en, second + 2 * MIN));
    expect(retry(), "within the minute").toBeNull();
    await wait(700);
    expect(retry(), "the minute over").toBeTruthy();
    const tapped = Date.now();
    act(() => fireEvent.click(retry()!));
    expect(action()!.dueAt, "due at once").toBeGreaterThanOrEqual(tapped);
    expect(action()!.dueAt).toBeLessThanOrEqual(Date.now());
    expect(action()!.heldFailures ?? 0, "its failures counted afresh").toBe(0);
    expect(screen.getByTestId("scan-held-notice"), "still failed until an attempt goes through").toBeTruthy();
    expect(state()).toBe(shortly(en));
    expect(retry()).toBeNull();
  });

  it("offline: the next attempt's time kept with what it waits for (ZP's critique), no Try again now — nothing runs offline", async () => {
    render(<ScanHeldNotice />);
    const second = Date.now() - 90_000;
    await failTwice(second);
    expect(retry()).toBeTruthy();
    act(() => connectivity.browser(false));
    expect(state()).toBe(`${failed(en)} ${en["scan.held.nextOffline"].replace("{when}", formatTime(second + 2 * MIN))}`);
    expect(retry()).toBeNull();
    act(() => connectivity.browser(true));
    expect(state()).toBe(next(en, second + 2 * MIN));
    expect(retry()).toBeTruthy();
  });

  it("offline, the next attempt's time gives way to the connection's words once it has gone by — the words move on their own offline too (ZQ's critique)", async () => {
    render(<ScanHeldNotice />);
    const second = Date.now() - 2 * MIN + 300;
    await failTwice(second); // the next attempt at second + 2 min: 300 ms from now
    act(() => connectivity.browser(false));
    expect(state()).toBe(`${failed(en)} ${en["scan.held.nextOffline"].replace("{when}", formatTime(second + 2 * MIN))}`);
    await wait(700);
    expect(state(), "a time gone by is never shown, offline too").toBe(`${failed(en)} ${en["scan.held.offline"]}`);
  });

  it("offline with the attempt already due: it reads the pool once the connection is back", async () => {
    render(<ScanHeldNotice />);
    await failHeld("restore", Date.now() - 2 * MIN);
    expect(state()).toBe(shortly(en));
    act(() => connectivity.browser(false));
    expect(state()).toBe(`${failed(en)} ${en["scan.held.offline"]}`);
    expect(retry()).toBeNull();
  });

  it("reading now while the attempt runs — no Try again now, though the minute after the last start is over —, its next attempt once it failed again, gone once a scan goes through", async () => {
    render(<ScanHeldNotice />);
    await failTwice(Date.now() - 4 * MIN);
    const third = Date.now() - 2 * MIN; // its start: a tap could read at once, but one is reading
    let open!: () => void;
    scan.gate = new Promise<void>((r) => (open = r));
    let attempt!: Promise<void>;
    act(() => {
      attempt = runDiscovery(action()!, { masterSeed: new Uint8Array(32), deployment, now: () => third });
    });
    expect(state()).toBe(en["scan.held.reading"]);
    expect(retry()).toBeNull();
    await act(async () => {
      open();
      await attempt;
    });
    expect(state()).toBe(next(en, third + 4 * MIN));
    expect(retry()).toBeTruthy();
    scan.gate = null;
    scan.fails = false;
    scan.releases = true;
    await run(third + 4 * MIN);
    expect(screen.queryByTestId("scan-held-notice")).toBeNull();
  });

  it("why, named only when the failure tells it for certain: the endpoints that disagree; a failure of another kind named by none, its raw text never (ZR's, ZS's critiques)", async () => {
    render(<ScanHeldNotice />);
    scan.error = new RpcDisagreement("the tree", ["0x01", "0x02"]);
    const at = await failHeld();
    expect(state()).toBe(`${en["scan.held.lastFailed"]} ${en["scan.held.causeDisagree"]} ${en["scan.held.next"].replace("{when}", formatTime(at + MIN))}`);
    scan.error = new Error("the light client could not prove the pool at https://rpc.example/v3/secret-key");
    await run(at + MIN);
    expect(state()).toBe(`${en["scan.held.lastFailed"]} ${en["scan.held.next"].replace("{when}", formatTime(at + 3 * MIN))}`);
    expect(screen.getByTestId("scan-held-notice").textContent, "an endpoint's URL may carry its key").not.toContain("secret-key");
  });

  it("this opening's hold in its own words", async () => {
    render(<ScanHeldNotice />);
    await failHeld("unlock");
    const notice = await screen.findByTestId("scan-held-notice");
    expect(notice.dataset.hold).toBe("unlock");
    expect(notice.textContent).toContain(`${en["scan.held.unlock"]} ${en["scan.held.blocked"]}`);
    expect(notice.textContent).not.toContain(en["scan.held.restore"]);
  });

  it("in Korean", async () => {
    registerCatalog("ko", ko);
    setLocale("ko");
    render(<ScanHeldNotice />);
    const second = Date.now() - 90_000;
    await failTwice(second);
    const notice = await screen.findByTestId("scan-held-notice");
    expect(notice.textContent).toContain(ko["scan.held.title"]);
    expect(notice.textContent).toContain(`${ko["scan.held.restore"]} ${ko["scan.held.blocked"]}`);
    expect(state()).toBe(next(ko, second + 2 * MIN));
    expect(retry()!.textContent).toBe(ko["scan.held.retry"]);
    act(() => connectivity.browser(false));
    expect(state()).toBe(`${failed(ko)} ${ko["scan.held.nextOffline"].replace("{when}", formatTime(second + 2 * MIN))}`);
  });
});

describe("W6 §5.4: under a refusal because the counters wait on the scan, where the scan stands", () => {
  const refused = (code: string) =>
    record({ id: "protect:1", kind: "protect", state: "FAILED", reason: { code, fundsClass: "not-moved" } as never, history: [{ state: "FAILED", at: 1_000 }] });

  it("planned, reading, failed, then read — 'you can try again now'; the reason names both holds, never 'in a moment', in English and Korean", async () => {
    noteStore.holdCounters();
    render(<OperationProgress record={refused("notes_loading")} />);
    expect(screen.getByTestId("operation-progress-error-reason").textContent).toBe(en["op.error.notes_loading.reason"]);
    expect(en["op.error.notes_loading.reason"]).not.toMatch(/in a moment/);
    expect(en["op.error.notes_loading.reason"]).toMatch(/^Each time the wallet opens, and after a restore, it reads the pool/);
    expect(en["op.error.notes_loading.reason"], "its subject named (ZP's critique)").toContain("The wallet had not read the pool yet, so nothing was sent");
    expect(ko["op.error.notes_loading.reason"]).not.toContain("잠시 후");
    expect(ko["op.error.notes_loading.reason"]).toMatch(/^지갑은 열릴 때마다, 그리고 복원한 뒤에/);
    const line = () => screen.getByTestId("operation-progress-scan").textContent;
    act(() => {
      scheduleDiscovery(Date.now());
    });
    expect(line()).toBe(en["scan.held.planned"]);
    expect(screen.getByTestId("operation-progress-scan").dataset.hold).toBe("restore");
    // a live region: its changes are read out — "you can try again now" among them (ZR's critique)
    expect(screen.getByTestId("operation-progress-scan").getAttribute("role")).toBe("status");
    expect(screen.getByTestId("operation-progress-scan").getAttribute("aria-live")).toBe("polite");
    let open!: () => void;
    scan.gate = new Promise<void>((r) => (open = r));
    scan.fails = true;
    let attempt!: Promise<void>;
    act(() => {
      attempt = runDiscovery(action()!, { masterSeed: new Uint8Array(32), deployment, now: () => Date.now() });
    });
    expect(line()).toBe(en["scan.held.reading"]);
    await act(async () => {
      open();
      await attempt;
    });
    expect(line()).toBe(en["scan.held.lastFailed"]);
    // the retry running after the failure: reading, not the failure (ZP's critique)
    scan.gate = new Promise<void>((r) => (open = r));
    scan.fails = false;
    scan.releases = true;
    act(() => {
      attempt = runDiscovery(action()!, { masterSeed: new Uint8Array(32), deployment, now: () => Date.now() });
    });
    expect(line()).toBe(en["scan.held.reading"]);
    await act(async () => {
      open();
      await attempt;
    });
    expect(line()).toBe(en["scan.held.read"]);
    expect(screen.getByTestId("operation-progress-scan").dataset.hold).toBe("none");
  });

  it("under this opening's hold too, offline 'once the connection is back' (ZP's critique: never 'shortly' while nothing runs); none under another refusal", async () => {
    noteStore.holdUntilScanned();
    render(<OperationProgress record={refused("notes_loading")} />);
    expect(screen.getByTestId("operation-progress-scan").textContent).toBe(en["scan.held.planned"]);
    expect(screen.getByTestId("operation-progress-scan").dataset.hold).toBe("unlock");
    act(() => connectivity.browser(false));
    expect(screen.getByTestId("operation-progress-scan").textContent).toBe(en["scan.held.offline"]);
    act(() => connectivity.browser(true));
    expect(screen.getByTestId("operation-progress-scan").textContent).toBe(en["scan.held.planned"]);
    render(<OperationProgress record={refused("user_rejected")} testId="other" />);
    expect(screen.getByTestId("other")).toBeTruthy();
    expect(screen.queryByTestId("other-scan")).toBeNull();
  });
});

describe("W6 §5.4: the shell carries the notice", () => {
  it("over Home while the scan the counters wait on fails — the scheduler's own attempt —, gone once a scan frees them", async () => {
    noteStore.holdCounters();
    scan.fails = true;
    await renderApp("/", { deployment });
    await screen.findByTestId("home", {}, { timeout: 10_000 });
    const notice = await screen.findByTestId("scan-held-notice", {}, { timeout: 10_000 });
    expect(notice.dataset.hold).toBe("restore");
    act(() => noteStore.releaseCounters(0));
    await waitFor(() => expect(screen.queryByTestId("scan-held-notice")).toBeNull());
  });
});
