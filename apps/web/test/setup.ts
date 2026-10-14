// The test setup (vitest.config.ts `setupFiles`): jest-dom's matchers, Testing Library's cleanup after every test,
// and the small pieces of the platform happy-dom and jsdom lack that the wrapped Radix primitives expect.
import "@testing-library/jest-dom/vitest";
import { transferableAbortController } from "node:util";
import { afterEach } from "vitest";
import { applyConfig, testConfig } from "../src/config";

// the engine's configuration for every suite (V6 Stage 3): no deployment, a cheap scrypt, a 40 ms hold
applyConfig(testConfig());

afterEach(async () => {
  if (typeof document !== "undefined") (await import("@testing-library/react")).cleanup();
});
// V6 Stage 16: the screens behind the gate and Home's Advanced lines are lazy chunks, transformed at their first import
// here — a cold one can take longer than Testing Library's default second
if (typeof document !== "undefined") (await import("@testing-library/react")).configure({ asyncUtilTimeout: 10_000 });

if (typeof globalThis.ResizeObserver === "undefined") {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}
// V6 Stage 16: the screens behind the gate are lazy routes, and React Router loads them under a fetch Request built with
// the DOM's AbortSignal; Node's Request refuses jsdom's signal ("Expected signal to be an instance of AbortSignal"), so
// the signal is bridged to a Node one that aborts with it
if (typeof window !== "undefined" && typeof globalThis.Request === "function") {
  const NodeSignal = transferableAbortController().signal.constructor as typeof AbortSignal;
  const NativeRequest = globalThis.Request;
  globalThis.Request = class extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      const signal = init?.signal;
      if (signal && !(signal instanceof NodeSignal)) {
        const bridge = transferableAbortController();
        if (signal.aborted) bridge.abort(signal.reason);
        else signal.addEventListener("abort", () => bridge.abort(signal.reason), { once: true });
        init = { ...init, signal: bridge.signal };
      }
      super(input, init);
    }
  } as typeof Request;
}
if (typeof window !== "undefined") {
  const w = window as unknown as Record<string, unknown>;
  // the layout's media queries answer for a phone (the 390 px canvas) unless a test sets __TEST_VIEWPORT_WIDTH__ — the
  // same in happy-dom (which would answer for its own 1024 px window) and jsdom (which has no matchMedia)
  const width = () => ((globalThis as { __TEST_VIEWPORT_WIDTH__?: number }).__TEST_VIEWPORT_WIDTH__ ?? 390);
  const evaluate = (query: string): boolean => {
    const min = /\(min-width:\s*(\d+)px\)/.exec(query);
    const max = /\(max-width:\s*(\d+)px\)/.exec(query);
    if (!min && !max) return false;
    return (!min || width() >= Number(min[1])) && (!max || width() <= Number(max[1]));
  };
  w.matchMedia = (query: string) => ({ matches: evaluate(query), media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false });
  const proto = Element.prototype as unknown as Record<string, unknown>;
  if (typeof proto.scrollIntoView !== "function") proto.scrollIntoView = () => {};
  if (typeof proto.hasPointerCapture !== "function") proto.hasPointerCapture = () => false;
  if (typeof proto.setPointerCapture !== "function") proto.setPointerCapture = () => {};
  if (typeof proto.releasePointerCapture !== "function") proto.releasePointerCapture = () => {};
}
