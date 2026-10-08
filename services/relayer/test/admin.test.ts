// GET /swap (the whole job list) is operator data: closed without RELAYER_ADMIN_TOKEN, a bearer token with it.
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
});
