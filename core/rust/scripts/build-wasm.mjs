#!/usr/bin/env node
// Build the WASM surface of the core: cargo (wasm32-unknown-unknown, release) + wasm-bindgen into
// core/rust/pkg/{node,web}. The wasm-bindgen CLI must be the crate's version (0.2.117); point
// WASM_BINDGEN at it (default: a `wasm-bindgen` on PATH). CARGO overrides the cargo binary.
//   node scripts/build-wasm.mjs
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cargo = process.env.CARGO ?? "cargo";
const wbg = process.env.WASM_BINDGEN ?? "wasm-bindgen";
const run = (cmd, args, cwd = root) => {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) { console.error(`${cmd} ${args.join(" ")} failed (${r.status})`); process.exit(r.status ?? 1); }
};

run(cargo, ["build", "--release", "--target", "wasm32-unknown-unknown", "-p", "privacy-core-wasm"]);
const wasm = join(root, "target/wasm32-unknown-unknown/release/privacy_core_wasm.wasm");
if (!existsSync(wasm)) { console.error(`missing ${wasm}`); process.exit(1); }
for (const target of ["nodejs", "web"]) {
  const out = join(root, "pkg", target === "nodejs" ? "node" : "web");
  mkdirSync(out, { recursive: true });
  run(wbg, ["--target", target, "--out-dir", out, "--out-name", "privacy_core_wasm", wasm]);
}
const size = readFileSync(join(root, "pkg/node/privacy_core_wasm_bg.wasm")).length;
writeFileSync(join(root, "pkg/BUILD.json"), JSON.stringify({ builtAt: new Date().toISOString(), wasmBytes: size, wasmBindgen: "0.2.117" }, null, 2) + "\n");
console.log(`pkg/node + pkg/web written; wasm ${(size / 1024).toFixed(0)} kB`);
