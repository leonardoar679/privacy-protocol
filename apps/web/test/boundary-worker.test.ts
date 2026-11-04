// The build-level boundary over a worker's graph (the eleventh review round, 2026-11-04, H11-1): Vite bundles a worker with worker.plugins
// alone, so the boundary is set there too — a worker of the app importing the forbidden tree, and a worker entry in it, fail the build — and
// node_modules counts only where the workspace installs it. Real Vite builds over tiny fixtures in a temporary folder (the reviewer's probe).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { build } from "vite";
import { boundaryPlugin } from "../scripts/boundary.mjs";

const HERE = mkdtempSync(join(tmpdir(), "pw-boundary-"));
afterAll(() => rmSync(HERE, { recursive: true, force: true }));

function fixture(name: string, mainJs: string, files: Record<string, string>) {
  const base = join(HERE, name);
  const root = join(base, "apps", "web");
  const forbidden = join(base, "classic");
  mkdirSync(root, { recursive: true });
  mkdirSync(forbidden, { recursive: true });
  writeFileSync(join(root, "index.html"), `<!doctype html><html><head></head><body><script type="module" src="./main.js"></script></body></html>`);
  writeFileSync(join(root, "main.js"), mainJs);
  for (const [p, src] of Object.entries(files)) {
    mkdirSync(dirname(join(base, p)), { recursive: true });
    writeFileSync(join(base, p), src);
  }
  return { root, forbidden, out: join(base, "out") };
}
async function builds(f: { root: string; forbidden: string; out: string }): Promise<string | null> {
  const boundary = { root: f.root, forbidden: [f.forbidden] };
  try {
    await build({
      configFile: false,
      root: f.root,
      logLevel: "silent",
      cacheDir: join(f.out, "..", ".vite-cache"),
      plugins: [boundaryPlugin(boundary)],
      worker: { format: "es", plugins: () => [boundaryPlugin(boundary)] },
      build: { outDir: f.out, emptyOutDir: true, minify: false },
    });
    return null;
  } catch (e) {
    return String((e as Error)?.message ?? e);
  }
}

describe("the build-level boundary over workers and node_modules (H11-1)", () => {
  it("a worker of the app importing the forbidden tree fails the build, and so does a worker entry that is a file of it", async () => {
    const imports = fixture("worker-import", `const w = new Worker(new URL("./worker.js", import.meta.url), { type: "module" }); w.postMessage(1);`, {
      "apps/web/worker.js": `import { MARK } from "../../classic/gpl.js"; self.onmessage = () => self.postMessage(MARK);`,
      "classic/gpl.js": `export const MARK = "GPL";`,
    });
    expect(await builds(imports)).toMatch(/rule 9/);
    const entry = fixture(
      "worker-entry",
      `const w = new Worker(new URL("../../classic/gpl-worker.js", import.meta.url), { type: "module" }); w.postMessage(1);`,
      {
        "classic/gpl-worker.js": `self.onmessage = () => self.postMessage("GPL");`,
      },
    );
    expect(await builds(entry)).toMatch(/rule 9/);
  }, 60_000);
  it("an honest worker builds; a file under another clone's node_modules fails, the repository's own node_modules passes", async () => {
    const honest = fixture("worker-honest", `const w = new Worker(new URL("./worker.js", import.meta.url), { type: "module" }); w.postMessage(1);`, {
      "apps/web/worker.js": `import { A } from "../../node_modules/lib/index.js"; self.onmessage = () => self.postMessage(A);`,
      "node_modules/lib/index.js": `export const A = 1;`,
    });
    expect(await builds(honest)).toBeNull();
    const foreign = fixture("foreign-node-modules", `import { MARK } from "../../../elsewhere/node_modules/gpl-lib/index.js"; console.log(MARK);`, {
      "../elsewhere/node_modules/gpl-lib/index.js": `export const MARK = "GPL";`,
    });
    expect(await builds(foreign)).toMatch(/node_modules outside the workspace's own/);
  }, 60_000);
  it("both applications set the boundary on their workers' builds", () => {
    // read as text by path: neither config is imported (rule 9 reads a URL into the Classic tree as an import)
    const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const web = readFileSync(join(repo, "apps", "web", "vite.config.ts"), "utf8");
    const classic = readFileSync(join(repo, "classic", "vite.config.ts"), "utf8");
    expect(web).toMatch(/worker: \{ format: "es", plugins: \(\) => \[boundaryPlugin\(boundary\)\] \}/);
    expect(classic).toMatch(/worker: \{ format: "es", plugins: \(\) => \[boundaryPlugin\(\{ root \}\)\] \}/);
  });
});
