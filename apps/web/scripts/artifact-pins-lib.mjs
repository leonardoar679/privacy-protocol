// The artifact pins (Privacy Wallet Web spec §20; Stage 11): the files the wallet loads at runtime and their SHA-256 —
// the circuit's witness generator and proving key and the verification key (../circuits, served at /artifacts/* in
// dev or from VITE_ARTIFACT_BASE), the Rust core's WASM package (public/core, served at /core/*). The pin file,
// public/artifacts.json, ships with the build; the prover worker hashes the proving key it fetched and refuses a
// mismatch in a production build (src/prover/pins.ts). Shared by pin-artifacts.mjs and check-artifact-pins.mjs.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const here = dirname(fileURLToPath(import.meta.url));
export const frontend = join(here, "..");
export const repo = join(frontend, "..", "..");
export const PIN_FILE = join(frontend, "public", "artifacts.json");
export const DOC_FILE = join(repo, "docs", "build-hashes.md");

/** Every runtime artifact: its name as served, where the build takes it from (the first path that exists wins). */
export const ARTIFACTS = [
  { name: "transaction.wasm", served: "/artifacts/transaction.wasm", sources: ["circuits/build/transaction_js/transaction.wasm", "apps/web/public/artifacts/transaction.wasm"], what: "the circuit's witness generator (circom → wasm)" },
  { name: "transaction_final.zkey", served: "/artifacts/transaction_final.zkey", sources: ["circuits/build/setup/transaction_final.zkey", "apps/web/public/artifacts/transaction_final.zkey"], what: "the Groth16 proving key (dev: the insecure single-party setup of circuits/setup/dev)" },
  { name: "verification_key.json", served: "/artifacts/verification_key.json", sources: ["circuits/setup/dev/verification_key.json", "apps/web/public/artifacts/verification_key.json"], what: "the verification key the wallet checks a proof against before submitting it" },
  { name: "privacy_core_wasm_bg.wasm", served: "/core/privacy_core_wasm_bg.wasm", sources: ["apps/web/public/core/privacy_core_wasm_bg.wasm", "privacy-core/pkg/web/privacy_core_wasm_bg.wasm"], what: "the Rust core (Poseidon2, the layered tree, note discovery) compiled to WASM" },
  { name: "privacy_core_wasm.js", served: "/core/privacy_core_wasm.js", sources: ["apps/web/public/core/privacy_core_wasm.js", "privacy-core/pkg/web/privacy_core_wasm.js"], what: "the WASM package's JavaScript glue (wasm-bindgen)" },
];

export const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The first existing source of an artifact, or null. */
export function locate(artifact) {
  for (const rel of artifact.sources) { const p = join(repo, rel); if (existsSync(p)) return p; }
  return null;
}

/** Hashes every artifact present on this machine: { name → { sha256, bytes, source } }. */
export function hashArtifacts() {
  const out = {};
  for (const a of ARTIFACTS) {
    const p = locate(a);
    if (!p) continue;
    out[a.name] = { sha256: sha256Hex(readFileSync(p)), bytes: statSync(p).size, source: p.slice(repo.length + 1).replace(/\\/g, "/") };
  }
  return out;
}

/**
 * Compares a pin file with what is on disk. Every pinned file present on disk must hash to its pin; a pinned file absent
 * from this machine is skipped (a clone without the circuit build); a present artifact without a pin is a failure (an
 * unpinned file would be served). Returns { ok, rows: [{ name, status, detail }] }.
 */
export function comparePins(pins, actual) {
  const rows = [];
  const files = pins?.files ?? {};
  for (const a of ARTIFACTS) {
    const pin = files[a.name];
    const act = actual[a.name];
    if (!pin && !act) rows.push({ name: a.name, status: "absent", detail: "neither pinned nor present" });
    else if (!pin && act) rows.push({ name: a.name, status: "unpinned", detail: `present (${act.bytes} bytes) but not in artifacts.json — run pin-artifacts.mjs` });
    else if (pin && !act) rows.push({ name: a.name, status: "skipped", detail: "pinned; the file is not on this machine" });
    else if (pin.sha256 === act.sha256) rows.push({ name: a.name, status: "match", detail: `${act.sha256.slice(0, 16)}… (${act.bytes} bytes)` });
    else rows.push({ name: a.name, status: "mismatch", detail: `pinned ${pin.sha256.slice(0, 16)}…, on disk ${act.sha256.slice(0, 16)}…` });
  }
  return { ok: rows.every((r) => r.status === "match" || r.status === "skipped" || r.status === "absent"), rows };
}

export function readPins() {
  if (!existsSync(PIN_FILE)) return null;
  try { return JSON.parse(readFileSync(PIN_FILE, "utf8")); } catch { return null; }
}
/**
 * Whether `file` differs from `base` in git (the sixth review round, 2026-11-03): true when `git diff --quiet` exits 1. False when
 * the file is the same — and false when the base is not on this machine (a shallow clone: nothing to compare), which the gate
 * reports as such rather than failing.
 */
export function changedSinceBase(base, file, cwd = repo, exec = execFileSync) {
  try {
    exec("git", ["diff", "--quiet", base, "--", file], { cwd, stdio: "ignore" });
    return false;
  } catch (e) {
    return !!(e && typeof e.status === "number" && e.status === 1);
  }
}
