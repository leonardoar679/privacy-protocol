// The test setup: jest-dom's matchers and Testing Library's cleanup after every DOM test.
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

afterEach(async () => {
  if (typeof document !== "undefined") (await import("@testing-library/react")).cleanup();
});
