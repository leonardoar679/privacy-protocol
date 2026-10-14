// The typed logger (doc §67; spec v2.0 §15): the keys of a line are a subset of the eight, a value without its field's
// shape is redacted — an address, a hash, an amount, a Bitcoin or a Solana string never reaches the line — and an
// unknown key is dropped.
import { describe, expect, it } from "vitest";
import { LOG_KEYS, createLogger, logLine } from "../src/logger";

const AT = new Date("2026-10-13T12:00:00.000Z");
const OP = "op_" + "a".repeat(26);

describe("the typed logger", () => {
  it("writes one JSON line with the known keys, the time and the level", () => {
    const lines: string[] = [];
    const log = createLogger(
      (l) => lines.push(l),
      () => AT,
    );
    log.info({ event: "operation.created", operationId: OP, provider: "thorchain", state: "AWAITING_SIGNATURE", network: "ethereum" });
    log.warn({ event: "fee.deviation", operationId: OP, provider: "thorchain", errorClass: "fee_deviation" });
    log.error({ event: "http.error", state: "500", errorClass: "internal" });
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      {
        at: AT.toISOString(),
        level: "info",
        event: "operation.created",
        operationId: OP,
        provider: "thorchain",
        state: "AWAITING_SIGNATURE",
        network: "ethereum",
      },
      { at: AT.toISOString(), level: "warn", event: "fee.deviation", operationId: OP, provider: "thorchain", errorClass: "fee_deviation" },
      { at: AT.toISOString(), level: "error", event: "http.error", state: "500", errorClass: "internal" },
    ]);
    for (const l of lines) for (const k of Object.keys(JSON.parse(l))) expect(LOG_KEYS).toContain(k);
  });
  it("redacts what is not its field's shape: an address, a hash, an amount, a Bitcoin or a Solana string, a path", () => {
    const leaks = [
      "0x" + "ab".repeat(20),
      "0x" + "cd".repeat(32),
      "1000000000000000000",
      "2470.90",
      "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
      "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      "/v1/operations/op_x",
      "ETH 1.5",
    ];
    for (const leak of leaks) {
      const line = logLine({ event: leak, operationId: leak, provider: leak, state: leak, errorClass: leak, network: leak }, AT);
      expect(line, leak).not.toContain(leak);
      const parsed = JSON.parse(line);
      for (const k of ["event", "operationId", "provider", "state", "errorClass", "network"]) expect(parsed[k], `${k}: ${leak}`).toBe("redacted");
    }
  });
  it("drops an unknown key and an unknown level; a non-string value is redacted", () => {
    const line = JSON.parse(logLine({ event: "x.y", amount: "5", address: "0xabc", level: "debug" as never, state: 7 as never } as never, AT));
    expect(line).toEqual({ at: AT.toISOString(), level: "info", event: "x.y", state: "redacted" });
  });
});
