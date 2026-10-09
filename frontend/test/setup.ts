// The test setup (vitest.config.ts `setupFiles`): jest-dom's matchers, Testing Library's cleanup after every test,
// and the small pieces of the platform happy-dom and jsdom lack that the wrapped Radix primitives expect.
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

afterEach(async () => {
  if (typeof document !== "undefined") (await import("@testing-library/react")).cleanup();
});

if (typeof globalThis.ResizeObserver === "undefined") {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}
if (typeof window !== "undefined") {
  const w = window as unknown as Record<string, unknown>;
  if (typeof w.matchMedia !== "function") {
    w.matchMedia = (query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false });
  }
  const proto = Element.prototype as unknown as Record<string, unknown>;
  if (typeof proto.scrollIntoView !== "function") proto.scrollIntoView = () => {};
  if (typeof proto.hasPointerCapture !== "function") proto.hasPointerCapture = () => false;
  if (typeof proto.setPointerCapture !== "function") proto.setPointerCapture = () => {};
  if (typeof proto.releasePointerCapture !== "function") proto.releasePointerCapture = () => {};
}
