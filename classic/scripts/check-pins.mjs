// The Classic app's artifact pins (spec v3.0 §7.3): src/prover/artifacts.json — imported by the prover worker, so the
// code itself vouches for what it loads — names every runtime artifact the app serves under /classic/artifacts/ (the
// original circuit, the proving key, the precompiled witness data) with its sha256 and size; public/artifacts.json is its
// served copy and must be identical. A file present under public/artifacts/ must hash to its pin, a present file without
// a pin fails (it would be served unpinned), a pinned file absent from this machine is skipped (a clone without the
// artifacts). The build ships the served copy (dist/artifacts.json).
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
export const APP = join(here, "..");
export const PIN_FILE = join(APP, "src", "prover", "artifacts.json");
export const PUBLIC_PIN_FILE = join(APP, "public", "artifacts.json");
export const ARTIFACT_DIR = join(APP, "public", "artifacts");
export const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function readPins(file = PIN_FILE) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** @param {{ pinFile?: string, publicPinFile?: string | null, dir?: string, dist?: string }} [opts] */
export function checkPins({ pinFile = PIN_FILE, publicPinFile = null, dir = ARTIFACT_DIR, dist = join(APP, "dist") } = {}) {
  const pins = readPins(pinFile);
  if (!pins || typeof pins.files !== "object") return { ok: false, rows: [], problems: ["src/prover/artifacts.json is missing or unreadable"] };
  const rows = [];
  const problems = [];
  if (publicPinFile) {
    if (!existsSync(publicPinFile))
      problems.push("public/artifacts.json is missing (the served copy of src/prover/artifacts.json; copy-artifacts.mjs writes both)");
    else if (readFileSync(publicPinFile, "utf8") !== readFileSync(pinFile, "utf8"))
      problems.push("public/artifacts.json differs from src/prover/artifacts.json (copy-artifacts.mjs writes both)");
  }
  const present = existsSync(dir) ? readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile()) : [];
  for (const [name, pin] of Object.entries(pins.files)) {
    if (!present.includes(name)) {
      rows.push({ name, status: "skipped", detail: "pinned; the file is not on this machine" });
      continue;
    }
    const bytes = readFileSync(join(dir, name));
    const sha = sha256Hex(bytes);
    if (sha === pin.sha256 && bytes.length === pin.bytes) rows.push({ name, status: "match", detail: `${sha.slice(0, 16)}… (${bytes.length} bytes)` });
    else {
      rows.push({
        name,
        status: "mismatch",
        detail: `pinned ${String(pin.sha256).slice(0, 16)}… / ${pin.bytes} bytes, on disk ${sha.slice(0, 16)}… / ${bytes.length}`,
      });
      problems.push(`${name}: the file does not match its pin`);
    }
  }
  for (const f of present) if (!(f in pins.files)) problems.push(`public/artifacts/${f} is not pinned (it would be served unpinned)`);
  if (existsSync(join(dist, "index.html")) && !existsSync(join(dist, "artifacts.json"))) problems.push("dist/ does not ship artifacts.json");
  return { ok: problems.length === 0, rows, problems };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = checkPins({ publicPinFile: PUBLIC_PIN_FILE });
  for (const row of r.rows)
    console.log(`${row.status === "match" ? "PASS" : row.status === "skipped" ? "SKIP" : "FAIL"}  ${row.name}: ${row.status} — ${row.detail}`);
  for (const p of r.problems) console.error(`FAIL  ${p}`);
  if (r.ok)
    console.log(
      `PASS  pins: ${r.rows.filter((x) => x.status === "match").length} verified, ${r.rows.filter((x) => x.status === "skipped").length} skipped, none unpinned`,
    );
  process.exit(r.ok ? 0 : 1);
}
