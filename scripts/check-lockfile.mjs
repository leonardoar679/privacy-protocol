#!/usr/bin/env node
// The lockfile check (V6 Stage 2; doc §69 "lockfile verification"): what `npm ci` will install is what the registry
// published and nothing else. Run by verify-all and first in CI, before `npm ci`.
//   - package-lock.json is lockfile v3 and lists exactly the workspaces of package.json;
//   - every installed package resolves to https://registry.npmjs.org/ with a sha512 integrity, and to the registry's own
//     tarball of its name and version (audit round 2, r49: another package's tarball with its own sha512 had installed
//     under a trusted name and passed every gate);
//   - every @privacy-wallet/* entry is a link to a workspace directory (no registry package can shadow one: the
//     dependency-confusion path is closed);
//   - no manifest of the workspaces asks for a file:, link:, git, github: or http(s) dependency;
//   - nested lockfiles exist only in the tool directories that are never shipped — and, since V7 Stage 2, in classic/,
//     the separately built and separately licensed Classic app, whose lockfile is checked by the same rules
//     (`--lockfile classic/package-lock.json --manifest classic/package.json`: a standalone project, no workspaces, and
//     no @privacy-wallet/* package at all — it shares no runtime code with the Privacy Wallet, spec v3.0 §7.8).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = "https://registry.npmjs.org/";
const TOOL_LOCKFILES = new Set([
  "package-lock.json",
  "circuits/package-lock.json",
  "scripts/local-stack/package-lock.json",
  "tools/zkapi-lab/package-lock.json",
  "classic/package-lock.json",
]);
const BAD_SPEC = /^(file|link|git|git\+[a-z]+|github|gitlab|bitbucket|https?):/;

const problems = [];
// `--lockfile <path>`: check another file than the repository's (a candidate lockfile, before it replaces this one);
// `--manifest <path>`: the package.json that lockfile belongs to (the Classic app's; default: the repository's)
const argv = process.argv.slice(2);
const lockPath = argv.includes("--lockfile") ? argv[argv.indexOf("--lockfile") + 1] : join(root, "package-lock.json");
const manifestPath = argv.includes("--manifest") ? argv[argv.indexOf("--manifest") + 1] : join(root, "package.json");
const lockName = relative(root, lockPath).replace(/\\/g, "/") || "package-lock.json";
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (lock.lockfileVersion !== 3) problems.push(`${lockName}: lockfileVersion ${lock.lockfileVersion}, expected 3`);
// a standalone project (the Classic app): its own manifest's specs are checked below, and it must declare no workspace
if (!manifest.workspaces && Object.keys(lock.packages).some((k) => k !== "" && !k.includes("node_modules/")))
  problems.push(`${lockName}: a standalone project's lockfile records a workspace`);

// the workspace directories the lockfile records, against package.json's globs
const workspaceDirs = Object.keys(lock.packages).filter((k) => k !== "" && !k.includes("node_modules/"));
const globs = manifest.workspaces ?? [];
const matches = (dir) => globs.some((g) => (g.endsWith("/*") ? dir.startsWith(g.slice(0, -1)) && !dir.slice(g.length - 1).includes("/") : dir === g));
for (const d of workspaceDirs) if (!matches(d)) problems.push(`package-lock.json: "${d}" is not a workspace of package.json (${globs.join(", ")})`);

for (const [key, entry] of Object.entries(lock.packages)) {
  if (key === "" || !key.includes("node_modules/")) continue;
  const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
  if (entry.link) {
    if (!workspaceDirs.includes(entry.resolved)) problems.push(`${key}: links to "${entry.resolved}", which is not a workspace`);
    continue;
  }
  if (name.startsWith("@privacy-wallet/")) {
    problems.push(`${key}: @privacy-wallet/* must be a workspace link, not an installed package`);
    continue;
  }
  if (entry.inBundle) continue; // shipped inside its parent's tarball, covered by the parent's integrity
  if (!entry.resolved?.startsWith(REGISTRY)) problems.push(`${key}: resolved from ${entry.resolved ?? "nowhere"} (only ${REGISTRY})`);
  else {
    // the registry's tarball of this very package and version: an alias names its real package in `name`
    const real = entry.name ?? name;
    const expected = `${REGISTRY}${real}/-/${real.slice(real.lastIndexOf("/") + 1)}-${entry.version}.tgz`;
    if (entry.resolved !== expected)
      problems.push(`${key}: resolved to ${entry.resolved}, not the registry's tarball of ${real}@${entry.version} (${expected})`);
  }
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity ?? "")) problems.push(`${key}: no sha512 integrity`);
}

// the workspaces' own manifests (the lockfile entries above carry them too, but the manifest is what a reviewer reads),
// and the manifest the lockfile belongs to (the only one of a standalone project)
const manifests = [
  [relative(root, manifestPath).replace(/\\/g, "/") || "package.json", manifest],
  ...workspaceDirs.map((d) => [`${d}/package.json`, JSON.parse(readFileSync(join(root, d, "package.json"), "utf8"))]),
];
for (const [name, pkg] of manifests) {
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [dep, spec] of Object.entries(pkg[field] ?? {})) {
      if (BAD_SPEC.test(String(spec))) problems.push(`${name} ${field}.${dep}: "${spec}" is not a registry version`);
    }
  }
}

const lockfiles = execFileSync("git", ["ls-files", "*package-lock.json", "package-lock.json"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
for (const f of lockfiles)
  if (!TOOL_LOCKFILES.has(f)) problems.push(`${f}: a nested lockfile outside the tool directories and classic/ (one root lockfile for apps/* and packages/*)`);

if (problems.length) {
  console.error(problems.join("\n"));
  console.error(`\n${problems.length} lockfile problem(s)`);
  process.exit(1);
}
const installed = Object.keys(lock.packages).filter((k) => k.includes("node_modules/") && !lock.packages[k].link).length;
console.log(
  `${lockName}: v3, ${workspaceDirs.length} workspaces, ${installed} packages from the npm registry with sha512 integrity, no non-registry dependency`,
);
