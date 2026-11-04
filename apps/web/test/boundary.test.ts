// The build-level boundary (the sixth review round, 2026-11-03): every module Vite resolves for the wallet must lie in its own
// tree, the allowed trees or node_modules; a module from a forbidden tree fails the build whatever specifier reached it.
import { resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { boundaryPlugin } from "../scripts/boundary.mjs";

const root = resolve("fake", "apps", "web");
const packages = resolve("fake", "packages");
const classic = resolve("fake", "classic");
const plugin = boundaryPlugin({ root, allowed: [packages], forbidden: [classic] });
const ctx = { error: (m: string) => { throw new Error(m); } };
const transform = (id: string) => (plugin as unknown as { transform: (this: typeof ctx, code: string, id: string) => null }).transform.call(ctx, "", id);
const slash = (p: string) => p.split(sep).join("/");

describe("the boundary plugin", () => {
  it("passes the app's own tree, the allowed trees and node_modules; a query suffix and a virtual id are no file", () => {
    expect(transform(slash(resolve(root, "src", "main.tsx")))).toBeNull();
    expect(transform(resolve(root, "src", "main.tsx") + "?worker")).toBeNull();
    expect(transform(slash(resolve(packages, "sdk", "src", "index.ts")))).toBeNull();
    expect(transform(slash(resolve("fake", "node_modules", "viem", "index.js")))).toBeNull();
    expect(transform("\0virtual:thing")).toBeNull();
    expect(transform("bare-specifier")).toBeNull();
    expect(transform("/@vite/client"), "Vite's own dev module").toBeNull();
    expect(transform("/@react-refresh")).toBeNull();
    expect(plugin.name).toBe("privacy-wallet-boundary");
    expect(plugin.enforce).toBe("pre");
  });
  it("refuses a file outside the trees and a file of a forbidden tree, even through node_modules", () => {
    expect(() => transform(slash(resolve("fake", "contracts", "abi", "x.json")))).toThrow(/outside this application's own tree/);
    expect(() => transform(slash(resolve("fake", "apps", "api", "src", "x.ts")))).toThrow(/outside this application's own tree/);
    expect(() => transform(slash(resolve(classic, "src", "x.ts")))).toThrow(/rule 9/);
    expect(() => transform(slash(resolve(classic, "node_modules", "y", "index.js"))), "a forbidden tree's node_modules too").toThrow(/rule 9/);
    expect(() => transform(slash(resolve("fake", "apps", "web-other", "src", "x.ts"))), "a sibling whose name only starts the same").toThrow(/outside/);
  });
});
