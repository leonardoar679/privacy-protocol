// Every number a service reads from its environment goes through the server kit's strict reader (a V6 follow-up of
// 2026-10-15): a bare Number() read "1k" as NaN, which polled every millisecond, capped nothing or allowed nothing.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("the settings", () => {
  it("server.ts reads no number with a bare Number() or BigInt()", () => {
    const server = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "server.ts"), "utf8");
    expect(server).not.toMatch(/(Number|BigInt|parseInt|parseFloat)\((env\(|env\.|process\.env)/);
    expect(server).toMatch(/intSetting/);
  });
});
