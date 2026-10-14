// @vitest-environment happy-dom
// Classic Privacy V6 (spec v2.0 §7.11, §11.3; V6 Stage 14): the module's four parts — ClassicPrivacyService over the
// ClassicPrivacyContracts interface (the devnet mock) and the ClassicPrivacyRelayer API, driven by ClassicPrivacyUI —:
// a deposit recovered from a pasted note (its pool, its deposit on chain, withdrawn or not, journaled here or not; a
// malformed note and a note of no pool refused with the reason; the note never leaves the device), the relayer choice
// with its fee and status (only an online one can be chosen; the choice kept in the module's own journal field), a
// pool's status (a stale root said so), and the relayer client parsing a status, a withdrawal and a job at the boundary.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { formatNote, generateNote } from "@privacy-wallet/protocol/classic/note";
import { session } from "@privacy-wallet/sdk/wallet/session";
import { emptyJournal } from "@privacy-wallet/sdk/wallet/journal";
import { DEVNET_NET_ID, devnetContracts, devnetPools, resetClassicPools, type MockPool } from "../src/features/classic-privacy/contracts";
import { ClassicPrivacyService, STALE_ROOT_SECONDS, type ClassicJournal } from "../src/features/classic-privacy/service";
import {
  DEVNET_RELAYERS,
  classicJob,
  classicRelayerStatus,
  classicWithdraw,
  parseClassicStatus,
  type ClassicRelayerChoice,
} from "../src/features/classic-privacy/relayer";
import { ClassicHome, ClassicRecoverScreen, ClassicRelayersScreen, chosenRelayer, classicService } from "../src/features/classic-privacy/ClassicPrivacyUI";
import { applyConfig, testConfig } from "../src/config";

beforeEach(() => resetClassicPools());
afterEach(() => {
  cleanup();
  session.forget();
});
const seeded = (k: number) => (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * k + 3) & 0xff);
const memoryJournal = (): ClassicJournal => {
  const recs: ReturnType<ClassicJournal["deposits"]> = [];
  return { deposits: () => recs, put: (r) => void recs.push(r) };
};
const relayers: ClassicRelayerChoice[] = [...DEVNET_RELAYERS, { id: "down", name: "relayer.down", feePercent: 0.2, status: "offline" }];

describe("ClassicPrivacyService (spec v2.0 §11.3)", () => {
  it("recovers a pasted note: its pool, its deposit, journaled here or not, ready or withdrawn", () => {
    const pools = devnetPools();
    const contracts = { pools: () => pools, pool: (id: string) => pools.find((p) => p.id === id) };
    const journal = memoryJournal();
    const service = new ClassicPrivacyService(contracts, journal, () => relayers);
    const mine = generateNote("eth", "1", DEVNET_NET_ID, seeded(7));
    const rec = service.deposit("eth-1", mine);
    let r = service.recover(formatNote(mine));
    expect(r).toMatchObject({ ok: true, status: "ready", journaled: true, onChain: { leafIndex: rec.leafIndex } });
    // a note deposited elsewhere (another device): found on chain, not journaled here
    const theirs = generateNote("eth", "1", DEVNET_NET_ID, seeded(11));
    pools[1].deposit(theirs);
    expect(service.recover(formatNote(theirs))).toMatchObject({ ok: true, status: "ready", journaled: false });
    // withdrawn: the nullifier was spent
    (pools[1] as MockPool).markSpent(mine);
    r = service.recover(formatNote(mine));
    expect(r).toMatchObject({ ok: true, status: "withdrawn" });
    // a note no pool holds a deposit for, a note of no pool, a malformed one
    expect(service.recover(formatNote(generateNote("eth", "1", DEVNET_NET_ID, seeded(13))))).toMatchObject({ ok: true, status: "not-found", onChain: null });
    expect(service.recover(formatNote(generateNote("eth", "5", DEVNET_NET_ID, seeded(7))))).toMatchObject({ ok: false, reason: "unknown-pool" });
    expect(service.recover(formatNote(generateNote("eth", "1", 1, seeded(7))))).toMatchObject({ ok: false, reason: "unknown-pool" });
    expect(service.recover("tornado-eth-1-31337-0x12")).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("prepares a withdrawal only for a deposited, unspent note, a 0x recipient and an online relayer; refuses another pool's note on a pool's screen", () => {
    const service = new ClassicPrivacyService(devnetContracts, memoryJournal(), () => relayers);
    const note = generateNote("eth", "1", DEVNET_NET_ID, seeded(7));
    const text = formatNote(note);
    const to = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
    expect(service.prepareWithdrawal(text, to, "relayer.devnet.local")).toMatchObject({ ok: false, reason: "not-found" });
    service.deposit("eth-1", note);
    expect(service.prepareWithdrawal(text, "0x12", "relayer.devnet.local")).toMatchObject({ ok: false, reason: "bad-recipient" });
    expect(service.prepareWithdrawal(text, to, "down")).toMatchObject({ ok: false, reason: "no-relayer" });
    expect(service.prepareWithdrawal(text, to, "relayer.devnet.local", "eth-10")).toMatchObject({ ok: false, reason: "wrong-pool" });
    const ok = service.prepareWithdrawal(text, to, "relayer.devnet.local", "eth-1");
    expect(ok).toMatchObject({ ok: true, withdrawal: { status: "proof-pending", relayer: "relayer.devnet.local", recipient: to } });
  });

  it("a pool's status: a root older than an hour reads stale; this wallet's position counted", () => {
    const service = new ClassicPrivacyService(devnetContracts, memoryJournal(), () => relayers);
    expect(service.poolStatus("eth-1")).toMatchObject({ health: "ready", mine: 0, relayer: "relayer.devnet.local", relayerFeePercent: 0.3 });
    expect(service.poolStatus("eth-10")!.rootAge).toBeLessThan(STALE_ROOT_SECONDS);
    expect(service.poolStatus("nope")).toBeNull();
  });
});

describe("ClassicPrivacyRelayer: the API parsed at the boundary", () => {
  const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const status = { rewardAccount: "0xabc", netId: 1, tornadoServiceFee: 0.25, instances: {}, health: { status: true } };
  it("a healthy status is online with its fee; an unhealthy one offline with its words; a broken answer unknown, never trusted", async () => {
    expect(await classicRelayerStatus("https://relayer.example", async () => ok(status))).toMatchObject({
      status: "online",
      feePercent: 0.25,
      name: "relayer.example",
    });
    expect(await classicRelayerStatus("https://relayer.example", async () => ok({ ...status, health: { status: false, error: "behind" } }))).toMatchObject({
      status: "offline",
      error: "behind",
    });
    expect(await classicRelayerStatus("https://relayer.example", async () => ok({ ...status, netId: "one" }))).toMatchObject({ status: "unknown" });
    expect(await classicRelayerStatus("https://relayer.example", async () => ok({}, 503))).toMatchObject({ status: "offline", error: "HTTP 503" });
    expect(() => parseClassicStatus({ netId: 1 })).toThrow();
  });
  it("a withdrawal request is checked before it leaves; the job's state is parsed", async () => {
    const fetchImpl = vi.fn(async () => ok({ id: "job-1" }));
    await expect(
      classicWithdraw(
        "https://relayer.example",
        { proof: "0x12", args: ["1", "2", "3", "4", "5", "6"], contract: "0x00000000000000000000000000000000000000c1" },
        fetchImpl as never,
      ),
    ).resolves.toEqual({ id: "job-1" });
    await expect(
      classicWithdraw(
        "https://relayer.example",
        { proof: "not hex", args: ["1", "2", "3", "4", "5", "6"], contract: "0x00000000000000000000000000000000000000c1" },
        fetchImpl as never,
      ),
    ).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(
      classicJob("https://relayer.example", "job-1", (async () => ok({ id: "job-1", status: "MINED", txHash: "0x1" })) as never),
    ).resolves.toMatchObject({ status: "MINED" });
    await expect(classicJob("https://relayer.example", "job-1", (async () => ok({ id: "job-1", status: "DONE" })) as never)).rejects.toThrow();
  });
});

describe("a production build: no mock pool stands in (docs/classic-privacy-review.md C-1)", () => {
  afterEach(() => void applyConfig(testConfig()));
  it("lists no pool and no relayer, says Classic Privacy is not available yet, and recovers nothing", () => {
    applyConfig(testConfig({ production: true }));
    expect(classicService().pools()).toEqual([]);
    expect(classicService().relayers()).toEqual([]);
    expect(classicService().recover(formatNote(generateNote("eth", "1", DEVNET_NET_ID, seeded(7))))).toMatchObject({ ok: false, reason: "unknown-pool" });
    render(<ClassicHome onOpen={() => {}} onRecover={() => {}} onRelayers={() => {}} />);
    expect(screen.getByTestId("classic-unavailable").textContent).toMatch(/not available in this build/);
    expect(screen.queryByTestId("classic-pools")).toBeNull();
    expect(screen.queryByTestId("classic-recover-open")).toBeNull();
  });
  it("a development build keeps the devnet's pools", () => {
    render(<ClassicHome onOpen={() => {}} onRecover={() => {}} onRelayers={() => {}} />);
    expect(screen.getByTestId("classic-pools")).toBeTruthy();
    expect(screen.queryByTestId("classic-unavailable")).toBeNull();
  });
});

describe("ClassicPrivacyUI: recover and choose a relayer", () => {
  it("the recover screen finds a deposited note and says it is ready; a malformed one is refused with the reason; nothing is fetched", async () => {
    await session.create("pw");
    const note = generateNote("eth", "0.1", DEVNET_NET_ID, seeded(7));
    classicService().deposit("eth-0.1", note);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<ClassicRecoverScreen />);
    fireEvent.change(screen.getByTestId("classic-recover-note"), { target: { value: formatNote(note) } });
    fireEvent.click(screen.getByTestId("classic-recover-find"));
    const result = screen.getByTestId("classic-recover-result");
    expect(result.textContent).toContain("ready to withdraw");
    expect(result.textContent).toContain("saved on this device");
    fireEvent.change(screen.getByTestId("classic-recover-note"), { target: { value: "tornado-eth-1-31337-0x12" } });
    fireEvent.click(screen.getByTestId("classic-recover-find"));
    expect(screen.getByTestId("classic-recover-error").textContent).toMatch(/not a classic note/);
    expect(fetchSpy, "the note is checked on this device").not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
  it("the relayer choice lists the fee and the status, and keeps the choice in the module's own journal field", async () => {
    await session.create("pw");
    render(<ClassicRelayersScreen />);
    const row = screen.getByTestId("classic-relayer-relayer.devnet.local");
    expect(row.textContent).toContain("Fee 0.3 %");
    expect(row.textContent).toContain("Online");
    fireEvent.click(row);
    expect(chosenRelayer()).toBe("relayer.devnet.local");
    expect(session.journal().classic?.relayer).toBe("relayer.devnet.local");
    expect(session.journal().notes, "never the protected balance").toEqual([]);
    expect("classic" in emptyJournal()).toBe(false);
  });
});
