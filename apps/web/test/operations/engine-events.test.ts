// The engine's typed events (spec §12): sdk/privateTx.ts emits one beside each status string; fromEngineEvent maps
// them to the record's events, a nested merge's proof and submission stay progress, and the documented sequences of a
// protect (native and ERC-20) and of a withdrawal with one merge drive a record from the signature to COMPLETED.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE_EVENT_ORDER, engineListener, fromEngineEvent, type EngineEvent } from "@privacy-wallet/sdk/operations/engineEvents";
import { transition } from "@privacy-wallet/sdk/operations/reducer";
import type { OperationEvent } from "@privacy-wallet/sdk/operations/types";
import type { OperationRecord } from "@privacy-wallet/sdk/wallet/operationRecord";
import { record } from "../helpers/operations";

const H1 = ("0x" + "a1".repeat(32)) as `0x${string}`;
const H2 = ("0x" + "b2".repeat(32)) as `0x${string}`;
const H3 = ("0x" + "c3".repeat(32)) as `0x${string}`;
const signed = (kind: OperationRecord["kind"]) => record({ kind, state: "AWAITING_SIGNATURE", history: [{ state: "AWAITING_SIGNATURE", at: 1_000 }] });

function drive(start: OperationRecord, events: EngineEvent[]): { record: OperationRecord; applied: OperationEvent[] } {
  let rec = start;
  const applied: OperationEvent[] = [];
  let clock = 2_000;
  const listener = engineListener((ev) => { applied.push(ev); const t = transition(rec, ev, clock++); if (!t.ok) throw new Error(`refused ${ev.type} at ${rec.state}: ${t.reason}`); rec = t.record; });
  for (const e of events) listener(e);
  return { record: rec, applied };
}

describe("fromEngineEvent", () => {
  it("maps every engine event; a nested merge's own proof, submission and receipt are not the spend's", () => {
    expect(fromEngineEvent({ type: "fee-terms" })).toEqual({ type: "progress", step: "fee-terms" });
    expect(fromEngineEvent({ type: "merging", i: 1, n: 2 })).toEqual({ type: "progress", step: "merging", i: 1, n: 2 });
    expect(fromEngineEvent({ type: "syncing" })).toEqual({ type: "progress", step: "syncing" });
    expect(fromEngineEvent({ type: "verifying" })).toEqual({ type: "progress", step: "verifying" });
    expect(fromEngineEvent({ type: "proving" })).toEqual({ type: "progress", step: "proof" });
    expect(fromEngineEvent({ type: "proved", ms: 1200, verifiedLocally: true })).toEqual({ type: "progress", step: "local-verify" });
    expect(fromEngineEvent({ type: "wallet-prompt", step: "approve", i: 1, n: 2 })).toEqual({ type: "progress", step: "submitting", i: 1, n: 2 });
    expect(fromEngineEvent({ type: "approved", txHash: H1 })).toEqual({ type: "note", note: `approval ${H1}` });
    expect(fromEngineEvent({ type: "submitting", by: "relayer" })).toEqual({ type: "progress", step: "submitting" });
    expect(fromEngineEvent({ type: "relayer-retry", attempt: 2 })).toEqual({ type: "note", note: "relayer unreachable, attempt 2" });
    expect(fromEngineEvent({ type: "submitted", txHash: H1, by: "relayer" })).toEqual({ type: "submitted", txHash: H1, by: "relayer" });
    expect(fromEngineEvent({ type: "waiting-receipt", txHash: H1 })).toEqual({ type: "confirming", txHash: H1 });
    expect(fromEngineEvent({ type: "mined", txHash: H1, leafIndex: 9 })).toEqual({ type: "completed", ref: { txHash: H1, leafIndex: 9 } });
    for (const e of [{ type: "proving" }, { type: "submitting", by: "relayer" }, { type: "submitted", txHash: H1, by: "relayer" }, { type: "waiting-receipt", txHash: H1 }, { type: "mined", txHash: H1, leafIndex: 1 }] as EngineEvent[]) expect(fromEngineEvent(e, { nested: true }), e.type).toBeNull();
    expect(fromEngineEvent({ type: "merging", i: 2, n: 2 }, { nested: true })).toEqual({ type: "progress", step: "merging", i: 2, n: 2 });
    expect(ENGINE_EVENT_ORDER[0]).toBe("fee-terms");
    expect(ENGINE_EVENT_ORDER[ENGINE_EVENT_ORDER.length - 1]).toBe("mined");
  });
});

describe("the documented sequences drive a record from the signature to COMPLETED", () => {
  it("a withdrawal with one merge: the merge's proof and submission are progress, the spend's own hash and leaf are the record's", () => {
    const events: EngineEvent[] = [
      { type: "fee-terms" }, { type: "merging", i: 1, n: 1 },
      { type: "proving" }, { type: "proved", ms: 900, verifiedLocally: true }, { type: "submitting", by: "relayer" }, { type: "submitted", txHash: H1, by: "relayer" }, { type: "waiting-receipt", txHash: H1 }, { type: "mined", txHash: H1, leafIndex: 40 },
      { type: "syncing" }, { type: "verifying" }, { type: "proving" }, { type: "proved", ms: 1100, verifiedLocally: true }, { type: "submitting", by: "relayer" }, { type: "relayer-retry", attempt: 1 },
      { type: "submitted", txHash: H2, by: "relayer" }, { type: "waiting-receipt", txHash: H2 }, { type: "mined", txHash: H2, leafIndex: 41 },
    ];
    const { record: r, applied } = drive(signed("withdraw"), events);
    expect(r.state).toBe("COMPLETED");
    expect(r.refs).toEqual({ txHashes: [H2], leafIndex: 41 });
    expect(r.history.map((h) => h.state)).toEqual(["AWAITING_SIGNATURE", "SUBMITTED", "NETWORK_CONFIRMING", "COMPLETED"]);
    expect(applied.filter((e) => e.type === "progress").map((e) => (e as { step: string }).step)).toEqual(["fee-terms", "merging", "syncing", "verifying", "proof", "local-verify", "submitting"]);
    expect(applied.filter((e) => e.type === "submitted")).toHaveLength(1);
  });
  it("a native protect and an ERC-20 protect (the approval first)", () => {
    const native = drive(signed("protect"), [{ type: "wallet-prompt", step: "deposit", i: 1, n: 1 }, { type: "submitted", txHash: H1, by: "wallet" }, { type: "waiting-receipt", txHash: H1 }, { type: "mined", txHash: H1, leafIndex: 5 }]);
    expect(native.record).toMatchObject({ state: "COMPLETED", refs: { txHashes: [H1], leafIndex: 5 } });
    const erc20 = drive(signed("protect"), [
      { type: "wallet-prompt", step: "approve", i: 1, n: 2 }, { type: "approved", txHash: H3 }, { type: "wallet-prompt", step: "deposit", i: 2, n: 2 },
      { type: "submitted", txHash: H1, by: "wallet" }, { type: "waiting-receipt", txHash: H1 }, { type: "mined", txHash: H1, leafIndex: 6 },
    ]);
    expect(erc20.record.state).toBe("COMPLETED");
    expect(erc20.record.history.map((h) => h.note).filter(Boolean)).toEqual([`approval ${H3}`]);
    expect(erc20.applied[0]).toEqual({ type: "progress", step: "submitting", i: 1, n: 2 });
  });
  it("a self-submitted send (the connected wallet): the transact prompt, then the hash and the receipt", () => {
    const { record: r } = drive(signed("send"), [{ type: "fee-terms" }, { type: "syncing" }, { type: "verifying" }, { type: "proving" }, { type: "proved", ms: 1, verifiedLocally: false }, { type: "submitting", by: "wallet" }, { type: "wallet-prompt", step: "transact", i: 1, n: 1 }, { type: "submitted", txHash: H1, by: "wallet" }, { type: "waiting-receipt", txHash: H1 }, { type: "mined", txHash: H1 }]);
    expect(r).toMatchObject({ state: "COMPLETED", refs: { txHashes: [H1] } });
    expect(r.refs.leafIndex).toBeUndefined();
  });
});

describe("the engine emits beside its status strings", () => {
  it("sdk/privateTx.ts carries onEvent on Progress and an event at every milestone of a shield, a merge, a withdrawal and a transfer", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "packages", "sdk", "src", "privateTx.ts"), "utf8");
    expect(src).toMatch(/export interface Progress \{ onStatus\?: ProveStatus;.*onEvent\?: OnEvent;/);
    const types = [...src.matchAll(/o\.onEvent\?\.\(\{ type: "([a-z-]+)"/g)].map((m) => m[1]);
    // V6 (spec v2.0 §3): "costs" — the estimate, the relayer's charge and the real cost, before the completion
    expect(new Set(types)).toEqual(new Set(["wallet-prompt", "submitted", "waiting-receipt", "mined", "approved", "proving", "proved", "submitting", "relayer-retry", "fee-terms", "syncing", "verifying", "merging", "costs"]));
    expect(types.length).toBeGreaterThanOrEqual(24);
    expect((src.match(/onStatus\?\.\(/g) ?? []).length, "the status strings stay").toBeGreaterThanOrEqual(15);
  });
});
