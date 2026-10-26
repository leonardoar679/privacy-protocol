// The Classic deployment pins against Ethereum mainnet (spec v3.0 §7.2; V7 Stage 5; verify-all --live): the chain's
// runtime code of every pinned contract held against its Sourcify record and a rebuild with the pinned compiler (fetched
// when absent, sha256-checked), the pools' facts, the router's roles, the registries' proxies and instances, and no
// drift from the committed pins. CLASSIC_RPC_URLS names the endpoints (the public ones otherwise).
import { describe, expect, it } from "vitest";
import { COMPILERS, compilerCached, fetchCompiler, loadCompiler } from "../../scripts/compilers.mjs";
import { makeRpc, PUBLIC_RPC_URLS, readPins, rebuildRecord, verifyDeployment } from "../../scripts/deployment.mjs";

const urls = (process.env.CLASSIC_RPC_URLS ?? PUBLIC_RPC_URLS.join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

describe("the Classic deployment on mainnet", () => {
  it("every pinned fact still holds: the code (Sourcify, the rebuild), the pools' constants, the router, the registries, the key", async () => {
    const pins = readPins();
    expect(pins, "src/config/deployment.json (scripts/verify-deployment.mjs --write)").not.toBeNull();
    const loaded = new Map<string, ReturnType<typeof loadCompiler>>();
    const rebuild = async (record: { compilation: { compilerVersion: string } }) => {
      const v = record.compilation.compilerVersion;
      if (!(v in COMPILERS)) return null;
      if (!loaded.has(v)) {
        if (!compilerCached(v)) await fetchCompiler(v);
        loaded.set(v, loadCompiler(v));
      }
      return { bytecode: rebuildRecord(record, loaded.get(v)!), compiler: v };
    };
    const result = await verifyDeployment({ rpc: makeRpc(urls), rebuild, pins });
    const failed = result.rows.filter((r: { ok: boolean }) => !r.ok);
    expect(failed.map((r: { name: string; detail: string; problems?: string[] }) => `${r.name}: ${r.detail} ${(r.problems ?? []).join("; ")}`)).toEqual([]);
    expect(result.rows.length).toBeGreaterThan(40);
    expect(result.pins.readAt.block).toBeGreaterThanOrEqual(pins!.readAt.block);
  }, 600_000);
});
