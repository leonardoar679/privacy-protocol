// The build-level boundary (the sixth review round, 2026-11-03): every module Vite resolves for the Classic app must lie in
// classic/ (its node_modules included); a module of the wallet's tree, of the workspace packages or of any other tree fails the
// build whatever specifier reached it — rule 9 at the build, not only at the source.
import { resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { boundaryPlugin } from "../scripts/boundary.mjs";

const root = resolve("fake", "classic");
const plugin = boundaryPlugin({ root });
const ctx = {
  error: (m: string) => {
    throw new Error(m);
  },
};
const transform = (id: string) => (plugin as unknown as { transform: (this: typeof ctx, code: string, id: string) => null }).transform.call(ctx, "", id);
const slash = (p: string) => p.split(sep).join("/");

describe("the Classic boundary plugin", () => {
  it("passes the app's own tree and its node_modules; a query suffix, a virtual id and a bare specifier are no file", () => {
    expect(transform(slash(resolve(root, "src", "main.tsx")))).toBeNull();
    expect(transform(resolve(root, "src", "main.tsx") + "?worker")).toBeNull();
    expect(transform(slash(resolve(root, "node_modules", "react", "index.js")))).toBeNull();
    expect(transform("\0virtual:thing")).toBeNull();
    expect(transform("bare-specifier")).toBeNull();
    expect(transform("/@vite/client"), "Vite's own dev module").toBeNull();
    expect(transform("/@react-refresh")).toBeNull();
    expect(plugin.name).toBe("tornado-classic-boundary");
    expect(plugin.enforce).toBe("pre");
  });
  it("refuses the wallet's tree, the workspace packages, the root node_modules and a sibling whose name only starts the same", () => {
    expect(() => transform(slash(resolve("fake", "apps", "web", "src", "x.ts")))).toThrow(/outside the Classic app \(rule 9/);
    expect(() => transform(slash(resolve("fake", "packages", "sdk", "src", "index.ts")))).toThrow(/rule 9/);
    expect(() => transform(slash(resolve("fake", "node_modules", "viem", "index.js"))), "the root's node_modules are the wallet's").toThrow(/rule 9/);
    expect(() => transform(slash(resolve("fake", "classic-other", "src", "x.ts")))).toThrow(/rule 9/);
  });
});
