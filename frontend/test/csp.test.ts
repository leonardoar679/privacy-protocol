// The content security policy and the headers of a build (spec §20; Stage 11): built from the environment's hosts —
// never a wildcard, never a host the build was not configured with —, no inline or remote script, WASM allowed, the
// worker same-origin, WalletConnect's relay only when a project id is set, the zkAPI profile's hosts when its assets
// ship; the plugin prepends the meta tag; the headers a server must send; a built index.html (when present) carries it.
import { describe, expect, it } from "vitest";
import { buildCsp, connectHosts, cspMeta, cspOfHtml, cspPlugin, originOf, SECURITY_HEADERS, zkapiHosts } from "../scripts/csp.mjs";

const ENV = { VITE_RPC_URLS: "https://rpc-a.example/v1/key, https://rpc-b.example", VITE_RELAYER_URL: "http://127.0.0.1:8790", VITE_RELAYER_URLS: "http://127.0.0.1:8790,https://relayer.example/", VITE_SWAP_SERVICE: "http://127.0.0.1:8787", VITE_BEACON_URLS: "https://lodestar-mainnet.chainsafe.io,https://ethereum-beacon-api.publicnode.com", VITE_ARTIFACT_BASE: "/artifacts" };

describe("the content security policy (spec §20)", () => {
  it("names exactly the build's hosts (origins, deduplicated; a relative artifact base adds nothing)", () => {
    expect(connectHosts(ENV)).toEqual(["https://rpc-a.example", "https://rpc-b.example", "http://127.0.0.1:8790", "https://relayer.example", "http://127.0.0.1:8787", "https://lodestar-mainnet.chainsafe.io", "https://ethereum-beacon-api.publicnode.com"]);
    expect(connectHosts({})).toEqual([]);
    expect(originOf("ws://127.0.0.1:1234/x")).toBe("ws://127.0.0.1:1234");
    expect(originOf("ftp://x.example")).toBeNull();
    expect(originOf("not a url")).toBeNull();
    expect(originOf("/artifacts")).toBeNull();
  });
  it("allows no inline script, no eval, no object, no form, no frame base; WASM and the same-origin worker; data images; the policy of an empty env is self only", () => {
    const csp = buildCsp(ENV);
    const directive = (name: string) => csp.split("; ").find((d) => d.startsWith(name + " "))!;
    expect(directive("default-src")).toBe("default-src 'self'");
    expect(directive("script-src")).toBe("script-src 'self' 'wasm-unsafe-eval'");
    expect(directive("worker-src")).toBe("worker-src 'self' blob:");
    expect(directive("connect-src")).toBe("connect-src 'self' https://rpc-a.example https://rpc-b.example http://127.0.0.1:8790 https://relayer.example http://127.0.0.1:8787 https://lodestar-mainnet.chainsafe.io https://ethereum-beacon-api.publicnode.com");
    expect(directive("img-src")).toBe("img-src 'self' data: blob:");
    expect(directive("style-src")).toBe("style-src 'self'");
    expect(directive("object-src")).toBe("object-src 'none'");
    expect(directive("base-uri")).toBe("base-uri 'none'");
    expect(directive("form-action")).toBe("form-action 'none'");
    expect(csp, "inline styles only through style-src-attr (the V1.1–V4 components), never a script or a stylesheet").not.toMatch(/script-src[^;]*unsafe-inline|style-src [^;]*unsafe-inline|'unsafe-eval'|\*(?!\.)/);
    expect(csp, "only the hosts named, never a scheme-wide allowance").not.toMatch(/ (https?|wss?):(?!\/\/)/);
    expect(buildCsp({})).toContain("connect-src 'self';");
  });
  it("WalletConnect's relay joins connect-src only with a project id; the zkAPI profile's hosts join when its assets ship", () => {
    expect(buildCsp(ENV)).not.toContain("walletconnect");
    const wc = buildCsp({ ...ENV, VITE_WC_PROJECT_ID: "abc" });
    expect(wc).toContain("wss://relay.walletconnect.com");
    expect(wc).toContain("https://*.walletconnect.com");
    expect(buildCsp(ENV, ["https://zkapi-sepolia.openanonymity.ai/manifest.json", "https://openrouter.ai/api/v1"])).toContain("https://zkapi-sepolia.openanonymity.ai https://openrouter.ai");
    expect(zkapiHosts("/nowhere/browser-config.json")).toEqual([]);
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
    expect(Object.keys(SECURITY_HEADERS).sort()).toEqual(["Cache-Control", "Content-Security-Policy", "Cross-Origin-Opener-Policy", "Permissions-Policy", "Referrer-Policy", "Strict-Transport-Security", "X-Content-Type-Options", "X-Frame-Options"]);
    expect(SECURITY_HEADERS["Content-Security-Policy"]).toBe("frame-ancestors 'none'");
    expect(SECURITY_HEADERS["Referrer-Policy"]).toBe("no-referrer");
    expect(SECURITY_HEADERS["X-Content-Type-Options"]).toBe("nosniff");
  });
});
