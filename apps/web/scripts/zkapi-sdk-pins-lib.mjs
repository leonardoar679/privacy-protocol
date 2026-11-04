// The zkAPI browser SDK's pins (the sixth review round, 2026-11-03): the SDK is a sibling git clone, not an npm dependency, so
// every lockfile, review and audit gate passes it by — yet the build aliases `@openanonymity/zkapi-browser-sdk` to its files,
// runs its build script, and takes the policy's hosts from its profile. apps/web/zkapi-sdk.pins.json records the clone's commit
// and the sha256 of every file under sdk/ (tests apart); the build, the asset emitter and the pin check refuse a clone whose
// files differ. Shared by pin-zkapi-sdk.mjs (writes) and check-zkapi-sdk.mjs (checks), vite.config.ts and build-zkapi-assets.mjs.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const here = dirname(fileURLToPath(import.meta.url));
export const PIN_FILE = join(here, "..", "zkapi-sdk.pins.json");
/** The clone ZKAPI_SDK_DIR names, or the one beside the repository. */
export const sdkDirOf = () => process.env.ZKAPI_SDK_DIR ?? resolve(here, "../../../../zkapi");
/** Whether a clone with the SDK's entry points is there at all (a build without one carries the stub). */
export const sdkPresent = (dir = sdkDirOf()) => existsSync(join(dir, "package.json")) && existsSync(join(dir, "sdk", "index.js"));

const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const SKIP = new Set(["node_modules", "test"]);

/** Every file under <clone>/sdk, tests apart, as { "sdk/<path>": sha256 } (LF as on disk; the clone is an LF checkout). */
export function hashSdk(dir = sdkDirOf()) {
  const files = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) files[relative(dir, p).replace(/\\/g, "/")] = sha256(p);
    }
  };
  walk(join(dir, "sdk"));
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The clone's commit (null when it is not a git checkout). */
export function headOf(dir = sdkDirOf()) {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

export function readSdkPins(file = PIN_FILE) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** What differs between the pins and the clone: an empty list means the clone is the pinned one. */
export function compareSdkPins(pins, dir = sdkDirOf()) {
  const problems = [];
  if (!pins?.files || typeof pins.files !== "object") return ["apps/web/zkapi-sdk.pins.json is missing or unreadable: run node scripts/pin-zkapi-sdk.mjs against the reviewed clone"];
  const actual = hashSdk(dir);
  for (const [path, hash] of Object.entries(pins.files)) {
    if (!(path in actual)) problems.push(`${path}: pinned, not in the clone`);
    else if (actual[path] !== hash) problems.push(`${path}: hashes to ${actual[path].slice(0, 16)}…, pinned ${String(hash).slice(0, 16)}…`);
  }
  for (const path of Object.keys(actual)) if (!(path in pins.files)) problems.push(`${path}: in the clone, not pinned`);
  const head = headOf(dir);
  if (pins.commit && head && head !== pins.commit) problems.push(`the clone is at ${head.slice(0, 12)}, the pins name ${String(pins.commit).slice(0, 12)}`);
  return problems;
}

/** Throws when the clone is not the pinned one: the build and the asset emitter call this before touching it. */
export function assertSdkPinned(dir = sdkDirOf()) {
  const problems = compareSdkPins(readSdkPins(), dir);
  if (problems.length) throw new Error(`the zkAPI SDK clone at ${dir} is not the pinned one (apps/web/zkapi-sdk.pins.json; docs/private-ai.md):\n  ${problems.slice(0, 12).join("\n  ")}${problems.length > 12 ? `\n  … ${problems.length - 12} more` : ""}`);
}

export const bytesOf = (dir, files) => Object.keys(files).reduce((n, p) => n + statSync(join(dir, p)).size, 0);
