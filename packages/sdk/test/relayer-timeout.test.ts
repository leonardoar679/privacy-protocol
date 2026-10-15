// The wallet's waits on a relayer end (a V6 follow-up of 2026-10-14). A read gets 20 s and a submission or a hand-over
// 90 s. A relayer that keeps the connection open and never answers no longer holds the failover, or a spend and the
// spends queued behind it. The timeout is not a refusal, so a spend treats it as a lost answer: it asks the relayer for
// its job by nullifier before anything is sent again.
import { afterEach, describe, expect, it, vi } from "vitest";
import { classify } from "../src/operations/errors/catalog";
import {
  RELAYER_READ_TIMEOUT_MS,
  RELAYER_WRITE_TIMEOUT_MS,
  RelayerRefusal,
  RelayerTimeout,
  isRefusal,
  pickRelayer,
  relayerInfo,
  relayerSubmit,
  type RelayerSubmitRequest,
} from "../src/relayer";

afterEach(() => vi.useRealTimers());

const CORE = "0x00000000000000000000000000000000000000c0" as const;
const INFO = {
  chainId: 1,
  core: CORE,
  feeVault: CORE,
  relayer: CORE,
  privacyAddress: "pp1x",
  minFeeWei: "1",
  gasPriceWei: "1",
  gasEstimate: "1",
  feeMarginBps: 0,
  requireReadableFeePayload: true,
  inflight: 0,
};
const SUBMIT: RelayerSubmitRequest = { proof: "0x", publicInputs: [], noteData: ["0x", "0x", "0x"], fee: { outputIndex: 0, amount: "1", noteSecret: "1" } };

/** A relayer that never answers: the request ends only when aborted, with the signal's reason, as the browser's does. */
const neverAnswers = (_input: unknown, init?: RequestInit): Promise<Response> =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

/** Settles `p` into a flag, so a test can say it is still pending. */
function track<T>(p: Promise<T>) {
  const t = { settled: false, value: undefined as unknown };
  p.then(
    (v) => Object.assign(t, { settled: true, value: v }),
    (e) => Object.assign(t, { settled: true, value: e }),
  );
  return t;
}

describe("the wallet's waits on a relayer end", () => {
  it("a submission never answered ends after 90 s as a lost answer: not a refusal, the relayer unreachable", async () => {
    vi.useFakeTimers();
    const t = track(relayerSubmit("http://relayer.test", SUBMIT, neverAnswers as typeof fetch));
    await vi.advanceTimersByTimeAsync(RELAYER_WRITE_TIMEOUT_MS - 1);
    expect(t.settled, "still waiting a millisecond before the limit").toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.value).toBeInstanceOf(RelayerTimeout);
    expect((t.value as Error).message).toBe("relayer: no answer within 90 s");
    expect(isRefusal(t.value), "a spend retries it and asks by nullifier, never treats it as the relayer's no").toBe(false);
    expect(classify(t.value)).toMatchObject({ code: "relayer_unreachable", fundsClass: "unknown" });
    expect(RELAYER_WRITE_TIMEOUT_MS).toBe(90_000);
  });

  it("the failover moves on from a relayer that never answers its terms, after 20 s", async () => {
    vi.useFakeTimers();
    const asked: string[] = [];
    const f = (input: unknown, init?: RequestInit): Promise<Response> => {
      asked.push(String(input));
      return String(input).startsWith("http://dead.test") ? neverAnswers(input, init) : Promise.resolve(new Response(JSON.stringify(INFO)));
    };
    const t = track(pickRelayer(["http://dead.test", "http://alive.test"], { chainId: 1, core: CORE }, f as typeof fetch));
    await vi.advanceTimersByTimeAsync(RELAYER_READ_TIMEOUT_MS - 1);
    expect(t.settled).toBe(false);
    expect(asked).toEqual(["http://dead.test/info"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.value).toMatchObject({ url: "http://alive.test" });
    expect(asked).toEqual(["http://dead.test/info", "http://alive.test/info"]);
    expect(RELAYER_READ_TIMEOUT_MS).toBe(20_000);
  });

  it("a body cut off by the timeout is a RelayerTimeout, never the relayer's answer", async () => {
    vi.useFakeTimers();
    const f = async (_input: unknown, init?: RequestInit): Promise<Response> => {
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('{"chainId":1,'));
          signal?.addEventListener("abort", () => c.error(signal.reason), { once: true });
        },
      });
      return new Response(body, { status: 200 });
    };
    const t = track(relayerInfo("http://relayer.test", f as typeof fetch));
    await vi.advanceTimersByTimeAsync(RELAYER_READ_TIMEOUT_MS);
    expect(t.value).toBeInstanceOf(RelayerTimeout);
  });

  it("an answer in time is read as before, a refusal stays a refusal, and no timer is left behind", async () => {
    vi.useFakeTimers();
    const answers = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    await expect(relayerInfo("http://relayer.test/", answers(200, INFO))).resolves.toMatchObject({ chainId: 1 });
    const e = await relayerSubmit(
      "http://relayer.test",
      SUBMIT,
      answers(409, { error: "a transaction spending one of these notes is already in flight here", code: "nullifier_in_flight" }),
    ).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RelayerRefusal);
    expect(isRefusal(e)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
