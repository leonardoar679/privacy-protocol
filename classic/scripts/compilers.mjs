// The compilers the deployed Classic contracts were built with (spec v3.0 §7.2; V7 Stage 5), pinned by the sha256 the
// soliditylang.org release list publishes for each solc-js build: downloaded into contracts/verified/compilers/
// (git-ignored) when a verification needs them, refused unless they hash to their pin, loaded through solc's wrapper.
// The pools are solc 0.5.11, the shared verifier 0.5.17, the router and the registries 0.6.12 (the Sourcify records).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import wrapper from "solc/wrapper.js";

const here = fileURLToPath(new URL(".", import.meta.url));
export const COMPILER_DIR = join(here, "..", "contracts", "verified", "compilers");
export const RELEASES = "https://binaries.soliditylang.org/bin/";

/** longVersion → the release list's path and sha256 (https://binaries.soliditylang.org/bin/list.json, read 2026-10-26). */
export const COMPILERS = Object.freeze({
  "0.5.11+commit.c082d0b4": { path: "soljson-v0.5.11+commit.c082d0b4.js", sha256: "b6012fb777a7f842a6e7efe8c50cb2eba3b3997c72b761810823e796d4390d44" },
  "0.5.17+commit.d19bba13": { path: "soljson-v0.5.17+commit.d19bba13.js", sha256: "dac1bc7560247d3e69bce9891f7eb2218a6a8d0106d9cdb4de8e03ede4546153" },
  "0.6.12+commit.27d51765": { path: "soljson-v0.6.12+commit.27d51765.js", sha256: "3e1956c550ca48e289044c7c0bd892403081b4b5e17e77ce707c815ce6c4228f" },
});

export const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The cached file: the release's name with a .cjs suffix — this package is "type": "module", and the legacy emscripten
 *  build exports nothing when Node evaluates it as an ES module (no `require`, no `module` in scope). */
export function compilerFile(longVersion) {
  const c = COMPILERS[longVersion];
  if (!c) throw new Error(`no pinned build for solc ${longVersion}`);
  return join(COMPILER_DIR, c.path.replace(/\.js$/, ".cjs"));
}

/** True when the build is on this machine and hashes to its pin. */
export function compilerCached(longVersion) {
  const file = compilerFile(longVersion);
  return existsSync(file) && sha256Hex(readFileSync(file)) === COMPILERS[longVersion].sha256;
}

/** Fetches the build when it is not cached (the network), refusing one that does not hash to its pin. */
export async function fetchCompiler(longVersion, { fetchImpl = fetch } = {}) {
  const c = COMPILERS[longVersion];
  const file = compilerFile(longVersion);
  if (compilerCached(longVersion)) return file;
  const r = await fetchImpl(`${RELEASES}${c.path}`);
  if (!r.ok) throw new Error(`${RELEASES}${c.path}: HTTP ${r.status}`);
  const bytes = Buffer.from(await r.arrayBuffer());
  const sha = sha256Hex(bytes);
  if (sha !== c.sha256) throw new Error(`${c.path} hashes to ${sha}, not the pinned ${c.sha256}: refused`);
  mkdirSync(COMPILER_DIR, { recursive: true });
  writeFileSync(file, bytes);
  return file;
}

/** The cached build behind solc's wrapper: `compile(standardJsonInputString)` → the standard JSON output string. */
export function loadCompiler(longVersion) {
  if (!compilerCached(longVersion)) throw new Error(`solc ${longVersion} is not cached under contracts/verified/compilers (fetchCompiler first)`);
  const require = createRequire(import.meta.url);
  return wrapper(require(compilerFile(longVersion)));
}
