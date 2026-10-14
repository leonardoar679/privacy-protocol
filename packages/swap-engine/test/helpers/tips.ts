// A test's executor tip: a fixed share of the order, so the suites' figures stay put. The service prices the execution's
// gas instead (../../src/tips.ts gasTips, spec v2.0 §3); test/tips.test.ts covers that.
import type { TipSource } from "../../src/tips";

export const shareTips = (bps: bigint): TipSource => ({ tipFor: async (_from, amount) => (amount * bps) / 10_000n });
