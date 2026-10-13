#!/usr/bin/env node
// The native wallets' bindings to the Rust core and prover (privacy-core/privacy-ffi, UniFFI): builds the
// library and the pinned binding generator, generates Swift (iOS), Kotlin (Android) and Python sources
// from the compiled library into privacy-core/target/bindings/<language>, places the library next to the
// Python module and runs the Python suite (privacy-ffi/tests/python/test_bindings.py) against it — the
// same generated surface the mobile apps call, held to the shared vectors and the EVM-verified proof.
// Swift / Kotlin are generated here and compiled by the platform toolchains (docs/mobile.md).
//   node privacy-core/scripts/ffi-bindings.mjs          (CARGO, PYTHON env override the binaries)
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cargo = process.env.CARGO ?? "cargo";
const python = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
const lib = process.platform === "win32" ? "privacy_ffi.dll" : process.platform === "darwin" ? "libprivacy_ffi.dylib" : "libprivacy_ffi.so";
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" && cmd !== process.execPath, ...opts });
  if (r.status !== 0) { console.error(`${cmd} ${args.join(" ")} failed (${r.status})`); process.exit(r.status ?? 1); }
};

run(cargo, ["build", "-p", "privacy-ffi", "-p", "uniffi-bindgen"]);
const library = join(root, "target", "debug", lib);
const bindgen = join(root, "target", "debug", process.platform === "win32" ? "uniffi-bindgen.exe" : "uniffi-bindgen");
if (!existsSync(library)) { console.error(`missing ${library}`); process.exit(1); }
const generated = {};
for (const language of ["python", "swift", "kotlin"]) {
  const out = join(root, "target", "bindings", language);
  mkdirSync(out, { recursive: true });
  run(bindgen, ["generate", "--library", library, "--language", language, "--out-dir", out]);
  generated[language] = readdirSync(out, { recursive: true }).filter((f) => /\.(py|swift|h|modulemap|kt)$/.test(String(f)));
}
const py = join(root, "target", "bindings", "python");
copyFileSync(library, join(py, lib));
run(python, [join(root, "privacy-ffi", "tests", "python", "test_bindings.py")], { env: { ...process.env, PRIVACY_FFI_BINDINGS: py } });
console.log(`bindings generated: ${Object.entries(generated).map(([l, f]) => `${l} (${f.join(", ")})`).join("; ")}; python suite passed`);
