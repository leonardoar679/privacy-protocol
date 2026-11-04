// The Classic app's content security policy (spec v3.0 §7.8): built from the build's own hosts — never a wildcard,
// never a scheme-wide allowance, never a host the build was not configured with —, no inline or remote script, no eval
// (the circuit's templates are precompiled), WASM allowed, the workers same-origin or Blob; the plugin prepends the
// meta tag; the headers a server must send.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { buildCsp, connectHosts, cspMeta, cspOfHtml, cspPlugin, curatedRelayerOrigins, originOf, SECURITY_HEADERS } from "../scripts/csp.mjs";

const ENV = {
  VITE_CLASSIC_RPC_URLS: "https://rpc-a.example/v1/key, https://rpc-b.example",
  VITE_CLASSIC_RELAYER_URLS: "https://relayer.example/,https://rpc-a.example",
  VITE_CLASSIC_DATA_BASE: "/classic/data",
  VITE_CLASSIC_ARTIFACT_BASE: "https://cdn.example/classic",
};

describe("the Classic content security policy", () => {
  it("names exactly the build's hosts, deduplicated; a relative base adds nothing", () => {
    expect(connectHosts(ENV)).toEqual(["https://rpc-a.example", "https://rpc-b.example", "https://relayer.example", "https://cdn.example"]);
    expect(connectHosts({})).toEqual([]);
    // the curated relayers come in beside the environment's hosts, deduplicated, origins only
    expect(connectHosts(ENV, ["https://relayer.example/v1/status", "https://eth.relayer-two.example", "nonsense"])).toEqual([
      "https://relayer.example",
      "https://eth.relayer-two.example",
      "https://rpc-a.example",
      "https://rpc-b.example",
      "https://cdn.example",
    ]);
    const curated = curatedRelayerOrigins();
    expect(curated.length).toBeGreaterThan(0);
    expect(curated.every((o: string) => /^https:\/\/[a-z0-9.-]+$/.test(o))).toBe(true);
    expect(buildCsp(ENV, curated)).toContain(curated[0]);
    expect(curatedRelayerOrigins(new URL("file:///nonexistent/relayers.json"))).toEqual([]);
    expect(originOf("ws://127.0.0.1:1234/x")).toBe("ws://127.0.0.1:1234");
    expect(originOf("ftp://x.example")).toBeNull();
    expect(originOf("/classic/data")).toBeNull();
  });
  it("allows no inline script, no eval, no object, no form, no frame base; WASM and the same-origin or Blob worker", () => {
    const csp = buildCsp(ENV);
    const directive = (name: string) => csp.split("; ").find((d: string) => d.startsWith(name + " "))!;
    expect(directive("default-src")).toBe("default-src 'self'");
    expect(directive("script-src")).toBe("script-src 'self' 'wasm-unsafe-eval'");
    expect(directive("worker-src")).toBe("worker-src 'self' blob:");
    expect(directive("connect-src")).toBe("connect-src 'self' https://rpc-a.example https://rpc-b.example https://relayer.example https://cdn.example");
    expect(directive("style-src")).toBe("style-src 'self'");
    expect(directive("object-src")).toBe("object-src 'none'");
    expect(directive("base-uri")).toBe("base-uri 'none'");
    expect(directive("form-action")).toBe("form-action 'none'");
    expect(csp).not.toMatch(/'unsafe-inline'|'unsafe-eval'|\*/);
    expect(csp, "only the hosts named, never a scheme-wide allowance").not.toMatch(/ (https?|wss?):(?!\/\/)/);
    expect(buildCsp({})).toContain("connect-src 'self';");
  });
  it("a production build leaves the development relayer setting out of the policy; a curated host without a public suffix is dropped (the sixth review round)", () => {
    const production = { production: true };
    expect(connectHosts(ENV, [], production)).toEqual(["https://rpc-a.example", "https://rpc-b.example", "https://cdn.example"]);
    expect(buildCsp(ENV, [], production)).not.toContain("relayer.example");
    expect(buildCsp(ENV, ["https://eth.relayer-two.example"], production), "the curated relayers still come in").toContain("https://eth.relayer-two.example");
    expect(cspMeta(ENV, [], production).attrs.content).toBe(buildCsp(ENV, [], production));
    expect(
      (cspPlugin(ENV, [], production) as unknown as { transformIndexHtml: () => { attrs: { content: string } }[] }).transformIndexHtml()[0].attrs.content,
    ).toBe(buildCsp(ENV, [], production));
    expect(connectHosts(ENV, [], {}), "a development build keeps it").toContain("https://relayer.example");
    const dir = mkdtempSync(join(tmpdir(), "classic-csp-"));
    try {
      const file = join(dir, "relayers.json");
      writeFileSync(
        file,
        JSON.stringify({
          relayers: [{ url: "https://livetobecomeavillain" }, { url: "https://eth.relayer.example/" }, { url: "https://localhost" }, { url: "nonsense" }],
        }),
      );
      expect(curatedRelayerOrigins(pathToFileURL(file))).toEqual(["https://eth.relayer.example"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("the plugin prepends the meta tag at build time; the headers a server must send are the known set", () => {
    const meta = cspMeta(ENV);
    expect(meta).toMatchObject({ tag: "meta", injectTo: "head-prepend", attrs: { "http-equiv": "Content-Security-Policy" } });
    expect(meta.attrs.content).toBe(buildCsp(ENV));
    const plugin = cspPlugin(ENV);
    expect(plugin.apply).toBe("build");
    expect((plugin as unknown as { transformIndexHtml: () => unknown[] }).transformIndexHtml()).toEqual([meta]);
    expect(cspOfHtml(`<html><head><meta http-equiv="Content-Security-Policy" content="${buildCsp(ENV)}"></head></html>`)).toBe(buildCsp(ENV));
    expect(cspOfHtml("<html></html>")).toBeNull();
    expect(Object.keys(SECURITY_HEADERS).sort()).toEqual([
      "Cache-Control",
      "Content-Security-Policy",
      "Cross-Origin-Opener-Policy",
      "Permissions-Policy",
      "Referrer-Policy",
      "Strict-Transport-Security",
      "X-Content-Type-Options",
      "X-Frame-Options",
    ]);
    expect(SECURITY_HEADERS["Content-Security-Policy"]).toBe("frame-ancestors 'none'");
  });
});
