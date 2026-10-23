#!/usr/bin/env node
// The dependency review (V6 Stage 2; doc §69 "dependency review … crypto dependencies require manual review"): what the
// lockfile changed since a base revision, and a refusal when a cryptography-sensitive package was added or changed
// without a dated entry in docs/dependency-reviews.md.
//   node scripts/dependency-review.mjs                 # against HEAD (the working tree's uncommitted change)
//   node scripts/dependency-review.mjs --base HEAD~1   # against a revision (CI on push: the commit's own change)
// Prints the added, removed and changed packages with their install scripts and licences. Exit 1 when a sensitive
// package (@noble/*, @scure/*, snarkjs, ffjavascript, circomlibjs, viem, ox, @walletconnect/*) is added or changes
// version and docs/dependency-reviews.md has no line naming `name@version` — and whenever a package keeps its name and
// version but not its tarball (audit round 2, r49): the registry never changes a published version, so such an entry was
// edited by hand, and the same `name@version` had read as no change at all.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const base = argv.includes("--base") ? argv[argv.indexOf("--base") + 1] : "HEAD";
const SENSITIVE = [/^@noble\//, /^@scure\//, /^snarkjs$/, /^ffjavascript$/, /^circomlibjs$/, /^viem$/, /^ox$/, /^@walletconnect\//];

const nameOf = (key) => key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
function packagesAt(text) {
  const out = new Map();
  for (const [key, e] of Object.entries(JSON.parse(text).packages ?? {})) {
    if (!key.includes("node_modules/") || e.link) continue;
    out.set(key, {
      name: nameOf(key),
      version: e.version,
      integrity: e.integrity ?? "",
      resolved: e.resolved ?? "",
      license: e.license ?? "?",
      install: Boolean(e.hasInstallScript),
    });
  }
  return out;
}

let baseText;
try {
  baseText = execFileSync("git", ["show", `${base}:package-lock.json`], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 << 20,
    stdio: ["ignore", "pipe", "ignore"],
  });
} catch {
  console.log(`dependency review: no package-lock.json at ${base} — nothing to compare (first commit or shallow clone)`);
  process.exit(0);
}
const before = packagesAt(baseText);
// `--lockfile <path>`: review a candidate lockfile instead of the working tree's
const lockPath = argv.includes("--lockfile") ? argv[argv.indexOf("--lockfile") + 1] : join(root, "package-lock.json");
const after = packagesAt(readFileSync(lockPath, "utf8"));

// a version is its tarball: the same name@version with another integrity or source is refused outright
const tarballs = new Map([...before.values()].map((p) => [`${p.name}@${p.version}`, p]));
const swapped = [...after.values()].filter((p) => {
  const b = tarballs.get(`${p.name}@${p.version}`);
  return b && (b.integrity !== p.integrity || b.resolved !== p.resolved);
});
if (swapped.length) {
  for (const p of swapped)
    console.error(
      `${p.name}@${p.version}: its tarball changed (${p.resolved}, ${p.integrity.slice(0, 19)}…) though its version did not — the registry never republishes a version`,
    );
  process.exit(1);
}

// compare by package name + version (a package moving between hoisting locations is no change)
const versions = (m) => {
  const v = new Map();
  for (const p of m.values()) v.set(`${p.name}@${p.version}`, p);
  return v;
};
const vb = versions(before),
  va = versions(after);
const added = [...va.values()].filter((p) => !vb.has(`${p.name}@${p.version}`));
const removed = [...vb.values()].filter((p) => !va.has(`${p.name}@${p.version}`));

const reviews = existsSync(join(root, "docs/dependency-reviews.md")) ? readFileSync(join(root, "docs/dependency-reviews.md"), "utf8") : "";
const reviewed = (p) => reviews.split("\n").some((l) => /\b\d{4}-\d{2}-\d{2}\b/.test(l) && l.includes(`\`${p.name}@${p.version}\``));
const problems = [];
const line = (sign, p) => `  ${sign} ${p.name}@${p.version}  (${p.license}${p.install ? ", HAS AN INSTALL SCRIPT" : ""})`;

if (!added.length && !removed.length) {
  console.log(`dependency review: the lockfile installs the same packages as ${base}`);
  process.exit(0);
}
console.log(`dependency review against ${base}: ${added.length} added or changed, ${removed.length} removed`);
for (const p of added) {
  console.log(line("+", p));
  if (SENSITIVE.some((rx) => rx.test(p.name)) && !reviewed(p))
    problems.push(`${p.name}@${p.version} is cryptography-sensitive: add a dated review line naming \`${p.name}@${p.version}\` to docs/dependency-reviews.md`);
  if (p.install && !reviewed(p))
    problems.push(
      `${p.name}@${p.version} runs an install script: review it and add a dated line naming \`${p.name}@${p.version}\` to docs/dependency-reviews.md`,
    );
}
for (const p of removed) console.log(line("-", p));
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("dependency review: every sensitive change has its review line");
