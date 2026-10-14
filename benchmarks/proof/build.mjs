#!/usr/bin/env node
// Builds the bench-only Rust prover for wasm32 (privacy-core/privacy-prover-wasm) into benchmarks/proof/pkg for Node:
// cargo (wasm32-unknown-unknown, release) + wasm-bindgen --target nodejs. The wasm-bindgen CLI must be the crate's
// version (0.2.117); point WASM_BINDGEN at it, CARGO at cargo (as privacy-core/scripts/build-wasm.mjs).
//   node build.mjs
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const core = join(here, "../../privacy-core");
const cargo = process.env.CARGO ?? "cargo";
const wbg = process.env.WASM_BINDGEN ?? "wasm-bindgen";
const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status})`);
};
run(cargo, ["build", "--release", "--target", "wasm32-unknown-unknown", "-p", "privacy-prover-wasm"], core);
const wasm = join(core, "target/wasm32-unknown-unknown/release/privacy_prover_wasm.wasm");
if (!existsSync(wasm)) throw new Error(`missing ${wasm}`);
run(wbg, ["--target", "nodejs", "--out-dir", join(here, "pkg"), "--out-name", "privacy_prover_wasm", wasm], here);
console.log("benchmarks/proof/pkg written");
