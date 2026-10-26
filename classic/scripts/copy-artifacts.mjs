// The original's proving artifacts (spec v3.0 §7.3; V7 Stage 6): the circom-1 circuit `tornado.json` and the websnark
// proving key `tornadoProvingKey.bin`, copied from a pinned source — by default the tornado-cli clone beside this
// repository (`../reference/tornado-cli/build/circuits/withdraw.json` and `withdraw_proving_key.bin`, identical to the
// files classic-ui and ui-minified ship zipped) — into public/artifacts/ (git-ignored, served under /classic/artifacts/),
// the circuit with LF line endings whatever the working copy has (the pin is the LF file's), and pinned in
// public/artifacts.json by sha256 and size. The pins are the compatibility matrix's (§2); a source that does not hash to
// them is refused. The witness file compile-circuit.mjs derives is pinned there too. The pins live in
// src/prover/artifacts.json (imported by the prover worker, so a served pin file can never vouch for a served artifact)
// and are copied to public/artifacts.json for anyone to compare with what a host serves; check-pins.mjs keeps the two equal.
//   node scripts/copy-artifacts.mjs [--from <dir>]
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
export const ARTIFACT_DIR = join(here, "..", "public", "artifacts");
export const PIN_FILE = join(here, "..", "src", "prover", "artifacts.json");
export const PUBLIC_PIN_FILE = join(here, "..", "public", "artifacts.json");
export const DEFAULT_SOURCE = join(here, "..", "..", "..", "reference", "tornado-cli", "build", "circuits");

/** The pinned artifacts: the served name, the source file, its sha256 (LF for the circuit) and size (the matrix §2). */
export const ARTIFACTS = Object.freeze([
  { name: "tornado.json", source: "withdraw.json", sha256: "3ddd61dbff09caeec82d8edde95c674a3c34f9e66b1fe9f2c8783e72fe536f98", bytes: 19_474_889, text: true },
  {
    name: "tornadoProvingKey.bin",
    source: "withdraw_proving_key.bin",
    sha256: "8e2d2f22beafb5a9666daebca57b13f8029c3656c65fcfbcc86e2418fa16a3af",
    bytes: 14_522_256,
    text: false,
  },
]);

export const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** CRLF and CR line endings as LF: the circuit was pinned as the LF file; a Windows checkout may hold it converted. */
export const toLF = (bytes) => Buffer.from(bytes.toString("utf8").replace(/\r\n?/g, "\n"), "utf8");

export function readPins(file = PIN_FILE) {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { comment: "", files: {} };
}

/** Writes the pins, and their served copy when the default file is written. */
export function writePins(pins, file = PIN_FILE, publicFile = file === PIN_FILE ? PUBLIC_PIN_FILE : null) {
  const text = JSON.stringify(pins, null, 2) + "\n";
  writeFileSync(file, text);
  if (publicFile) writeFileSync(publicFile, text);
}

/** Copies and pins; returns what was done. Throws on a source that does not hash to its pin. */
export function copyArtifacts({ from = DEFAULT_SOURCE, dir = ARTIFACT_DIR, pinFile = PIN_FILE } = {}) {
  const done = [];
  mkdirSync(dir, { recursive: true });
  const pins = readPins(pinFile);
  for (const a of ARTIFACTS) {
    const src = join(from, a.source);
    if (!existsSync(src)) throw new Error(`${src} is not there (the tornado-cli clone beside the repository, or --from <dir>)`);
    let bytes = readFileSync(src);
    if (a.text) bytes = toLF(bytes);
    const sha = sha256Hex(bytes);
    if (sha !== a.sha256 || bytes.length !== a.bytes)
      throw new Error(`${a.source}: sha256 ${sha} (${bytes.length} bytes), not the pinned ${a.sha256} (${a.bytes}): refused`);
    writeFileSync(join(dir, a.name), bytes);
    pins.files[a.name] = { sha256: sha, bytes: bytes.length };
    done.push({ name: a.name, sha256: sha, bytes: bytes.length });
  }
  pins.comment =
    "The runtime artifacts served under /classic/artifacts/, pinned by sha256 and size (spec v3.0 §7.3): the original circuit and proving key (copy-artifacts.mjs), the witness file derived from the circuit (compile-circuit.mjs). The source of truth is src/prover/artifacts.json, imported by the prover worker; public/artifacts.json is its served copy. A file present under public/artifacts/ must hash to its pin (scripts/check-pins.mjs).";
  writePins(pins, pinFile);
  return done;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const from = process.argv.includes("--from") ? resolve(process.argv[process.argv.indexOf("--from") + 1]) : DEFAULT_SOURCE;
  for (const d of copyArtifacts({ from })) console.log(`PASS  ${d.name}: ${d.bytes} bytes, sha256 ${d.sha256} — copied and pinned`);
}
