// `npm run preview` sends the headers a host must send (docs/deployment.md; audit round 2, n81): the build's whole policy as a
// header, frame-ancestors with it — it had sent "frame-ancestors 'none'" alone.
import { describe, expect, it } from "vitest";
import config from "../vite.config";
import { SECURITY_HEADERS } from "../scripts/csp.mjs";

describe("the preview's headers", () => {
  it("carry the build's whole policy and every header a server sends", async () => {
    const c = await (config as unknown as (e: { command: string; mode: string }) => { preview: { headers: Record<string, string> } })({
      command: "serve",
      mode: "production",
    });
    const h = c.preview.headers;
    const csp = h["Content-Security-Policy"];
    expect(csp).toMatch(/^default-src 'self'; /);
    expect(csp).toMatch(/; connect-src 'self'[ ;]/);
    expect(csp).toMatch(/; object-src 'none'; /);
    expect(csp.endsWith("; frame-ancestors 'none'")).toBe(true);
    for (const k of Object.keys(SECURITY_HEADERS).filter((k) => k !== "Content-Security-Policy"))
      expect(h[k], k).toBe((SECURITY_HEADERS as Record<string, string>)[k]);
  });
});
