// GET /swap and GET /jobs (the whole job lists) are operator data: closed without RELAYER_ADMIN_TOKEN, a bearer token with
// it. GET /jobs (every submission with its fee note's opening) was open to anyone until a V6 follow-up of 2026-10-15.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { adminAuthorized } from "../src/admin";

describe("the relayer's job list", () => {
  it("is closed when no token is configured, needs the exact bearer token otherwise", () => {
    expect(adminAuthorized("Bearer x", undefined)).toMatchObject({ ok: false, status: 403, code: "admin_closed" });
    expect(adminAuthorized(undefined, "secret")).toMatchObject({ ok: false, status: 401, code: "admin_token" });
    expect(adminAuthorized("Bearer wrong", "secret")).toMatchObject({ ok: false, status: 401 });
    expect(adminAuthorized("Bearer secre", "secret")).toMatchObject({ ok: false, status: 401 });
    expect(adminAuthorized("Basic secret", "secret")).toMatchObject({ ok: false, status: 401 });
    expect(adminAuthorized("Bearer secret", "secret")).toEqual({ ok: true });
    expect(adminAuthorized(["bearer secret"], "secret")).toEqual({ ok: true });
  });
  it("guards both lists in the server: GET /swap and GET /jobs answer only through it", () => {
    const server = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "server.ts"), "utf8");
    for (const [route, list] of [
      ['url.pathname === "/swap"', "executor.list()"],
      ['url.pathname === "/jobs"', "relayer.jobs_()"],
    ]) {
      const at = server.indexOf(route);
      expect(at, route).toBeGreaterThan(0);
      const handler = server.slice(at, server.indexOf("\n    if (", at + route.length));
      expect(handler, route).toMatch(/adminAuthorized\(req\.headers\.authorization, process\.env\.RELAYER_ADMIN_TOKEN\)/);
      expect(handler, route).toContain(`auth.ok ? send(200, ${list})`);
    }
    expect(server.match(/relayer\.jobs_\(\)/g), "the submissions leave only through the guarded route").toHaveLength(1);
  });
});
