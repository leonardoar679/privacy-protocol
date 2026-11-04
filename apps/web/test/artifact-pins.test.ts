// The artifact pins (spec §20; Stage 11): the pin file against the files on disk (a match, a drift, an unpinned file, a
// pinned file absent from the machine), the runtime verdict the prover worker enforces (a mismatch refuses in
// production and warns in dev; no pin refuses in production), the hash the worker computes, the pins read from the
// served manifest, and — on this machine — the committed pins against the real artifacts.
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ARTIFACTS, changedSinceBase, comparePins, hashArtifacts, readPins } from "../scripts/artifact-pins-lib.mjs";
import { enforce, pinsFromManifest, sha256Hex, verdictOf } from "../src/prover/pins";
import { loadPins, resetPins } from "../src/prover/client";

const H = "a".repeat(64), G = "b".repeat(64);

describe("the artifact pins (spec §20)", () => {
  it("comparePins: match, drift, unpinned, absent — and the overall verdict", () => {
    const pins = { v: 1, files: { "transaction_final.zkey": { sha256: H, bytes: 3 }, "transaction.wasm": { sha256: G, bytes: 2 } } };
    const r = comparePins(pins, { "transaction_final.zkey": { sha256: H, bytes: 3 }, "transaction.wasm": { sha256: H, bytes: 2 }, "verification_key.json": { sha256: G, bytes: 1 } });
    const by = Object.fromEntries(r.rows.map((x: { name: string; status: string }) => [x.name, x.status]));
    expect(by).toEqual({ "transaction.wasm": "mismatch", "transaction_final.zkey": "match", "verification_key.json": "unpinned", "privacy_core_wasm_bg.wasm": "absent", "privacy_core_wasm.js": "absent" });
    expect(r.ok).toBe(false);
    const clean = comparePins(pins, { "transaction_final.zkey": { sha256: H, bytes: 3 } });
    expect(clean.rows.find((x: { name: string }) => x.name === "transaction.wasm")!.status, "pinned but not on this machine").toBe("skipped");
    expect(clean.ok).toBe(true);
    expect(ARTIFACTS.map((a: { name: string }) => a.name)).toEqual(["transaction.wasm", "transaction_final.zkey", "verification_key.json", "privacy_core_wasm_bg.wasm", "privacy_core_wasm.js"]);
  });
  it("a pin file that changed since the base, on a machine without the artifacts, is a failure; an absent base is not (the sixth review round)", () => {
    const calls: unknown[][] = [];
    const exec = (status: number | null) => (...a: unknown[]) => {
      calls.push(a);
      if (status === null) return "";
      const e = new Error("git") as Error & { status: number };
      e.status = status;
      throw e;
    };
    expect(changedSinceBase("origin/main", "apps/web/public/artifacts.json", "/repo", exec(1) as never), "exit 1: the file differs").toBe(true);
    expect(changedSinceBase("origin/main", "apps/web/public/artifacts.json", "/repo", exec(null) as never), "exit 0: the same").toBe(false);
    expect(changedSinceBase("origin/main", "apps/web/public/artifacts.json", "/repo", exec(128) as never), "no such base here: nothing to compare").toBe(false);
    expect(calls[0]).toEqual(["git", ["diff", "--quiet", "origin/main", "--", "apps/web/public/artifacts.json"], { cwd: "/repo", stdio: "ignore" }]);
  });
  it("the worker's verdict: a match passes; a mismatch refuses in production and warns in dev; no pin refuses in production only", () => {
    expect(verdictOf(H, H.toUpperCase())).toBe("match");
    expect(verdictOf(H, G)).toBe("mismatch");
    expect(verdictOf(undefined, G)).toBe("unpinned");
    const warn = vi.fn();
    expect(enforce("transaction_final.zkey", "match", { production: true, warn })).toBe("match");
    expect(() => enforce("transaction_final.zkey", "mismatch", { production: true, warn })).toThrow(/refusing to prove — transaction_final.zkey: the fetched artifact does not hash to its pin/);
    expect(() => enforce("transaction_final.zkey", "unpinned", { production: true, warn })).toThrow(/no pin in artifacts.json/);
    expect(warn).not.toHaveBeenCalled();
    expect(enforce("transaction_final.zkey", "mismatch", { production: false, warn })).toBe("mismatch");
    expect(enforce("transaction.wasm", "unpinned", { production: false, warn })).toBe("unpinned");
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain("development build");
  });
  it("the hash the worker computes is SHA-256; the pins come from the served manifest's shape", async () => {
    const bytes = new TextEncoder().encode("privacy-protocol artifact");
    expect(await sha256Hex(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(await sha256Hex(new Uint8Array(new Uint8Array([1, 2, 3, 4, 5]).buffer, 1, 3))).toBe(createHash("sha256").update(Uint8Array.from([2, 3, 4])).digest("hex"));
    expect(pinsFromManifest({ files: { "transaction_final.zkey": { sha256: H }, "transaction.wasm": { sha256: G }, "other": { sha256: "x" } } })).toEqual({ zkey: H, wasm: G });
    expect(pinsFromManifest(null)).toEqual({});
    expect(pinsFromManifest({ nope: 1 })).toEqual({});
  });
  it("the committed pins match the artifacts present on this machine (the files absent here are skipped)", () => {
    const pins = readPins();
    expect(pins, "public/artifacts.json is committed").toBeTruthy();
    const r = comparePins(pins, hashArtifacts());
    expect(r.rows.filter((x: { status: string }) => x.status === "mismatch" || x.status === "unpinned").map((x: { name: string; detail: string }) => `${x.name}: ${x.detail}`)).toEqual([]);
  });
  it("a failed read of the pins is not kept: the next proof asks again; a good read is kept (audit round 2, r22)", async () => {
    // kept, a 502 during a redeploy had refused every later proof of the page ("no pin in artifacts.json") until a reload
    const real = globalThis.fetch;
    const answers = [new Response("bad gateway", { status: 502 }), new Response(JSON.stringify({ files: { "transaction_final.zkey": { sha256: "ab".repeat(32) } } }))];
    let reads = 0;
    globalThis.fetch = (async () => answers[reads++] ?? new Response("{}", { status: 404 })) as typeof fetch;
    resetPins();
    try {
      expect(await loadPins(), "this proof goes without them").toEqual({});
      expect(await loadPins(), "the next asks again").toMatchObject({ zkey: "ab".repeat(32) });
      expect(await loadPins(), "a good read is kept").toMatchObject({ zkey: "ab".repeat(32) });
      expect(reads).toBe(2);
    } finally {
      globalThis.fetch = real;
      resetPins();
    }
  });
});
