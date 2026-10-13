#!/usr/bin/env node
// Offline vendoring for cargo when cargo's own HTTP stack cannot connect (this machine): read every
// registry package from one or more Cargo.lock files, download each .crate with fetch/curl from
// static.crates.io, verify its sha256 against the lockfile checksum, extract it into a cargo
// "directory" source, and write the .cargo-checksum.json cargo expects. Git dependencies are cloned.
// Usage: node vendor-crates.mjs <vendorDir> <Cargo.lock> [<Cargo.lock> ...]
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { execFileSync } from "child_process";
import { join, resolve } from "path";

const [vendorDir, ...locks] = process.argv.slice(2).map((p) => resolve(p));
if (!vendorDir || locks.length === 0) {
  console.error("usage: node vendor-crates.mjs <vendorDir> <Cargo.lock>...");
  process.exit(2);
}
mkdirSync(vendorDir, { recursive: true });

// ---- parse lockfiles ----
const pkgs = new Map(); // name-version -> {name, version, checksum, source}
for (const lock of locks) {
  const text = readFileSync(lock, "utf8");
  for (const block of text.split(/\n\[\[package\]\]\n/).slice(1)) {
    const get = (k) => block.match(new RegExp(`^${k} = "([^"]+)"`, "m"))?.[1];
    const name = get("name"), version = get("version"), source = get("source"), checksum = get("checksum");
    if (!source) continue; // workspace member
    pkgs.set(`${name}-${version}`, { name, version, source, checksum });
  }
}
console.log(`${pkgs.size} external packages across ${locks.length} lockfile(s)`);

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
async function download(url) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(180000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (attempt === 4) throw e;
      await new Promise((res) => setTimeout(res, 2000 * attempt));
    }
  }
}

let done = 0, skipped = 0, failed = [];
const gitDeps = [];
for (const [key, p] of pkgs) {
  const dir = join(vendorDir, key);
  if (p.source.startsWith("git+")) {
    gitDeps.push(p);
    continue;
  }
  if (existsSync(join(dir, ".cargo-checksum.json"))) {
    skipped++;
    continue;
  }
  const url = `https://static.crates.io/crates/${p.name}/${p.name}-${p.version}.crate`;
  try {
    const tmp = join(vendorDir, `${key}.crate`);
    // a .crate left behind by an earlier run is reused when its hash still matches the lockfile
    let buf = existsSync(tmp) ? readFileSync(tmp) : null;
    if (!buf || (p.checksum && sha256(buf) !== p.checksum)) buf = await download(url);
    const h = sha256(buf);
    if (p.checksum && h !== p.checksum) throw new Error(`checksum mismatch: lock ${p.checksum} got ${h}`);
    writeFileSync(tmp, buf);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    // --force-local: GNU tar would read "E:\..." as a remote host
    execFileSync("tar", ["--force-local", "-xzf", tmp, "-C", vendorDir]); // extracts to <name>-<version>/
    rmSync(tmp);
    // cargo verifies listed files only; the package hash pins the tarball we verified above
    writeFileSync(join(dir, ".cargo-checksum.json"), JSON.stringify({ files: {}, package: h }) + "\n");
    done++;
    if ((done + skipped) % 25 === 0) console.log(`${done + skipped}/${pkgs.size} …`);
  } catch (e) {
    failed.push(`${key}: ${e.message}`);
  }
}
console.log(`vendored ${done} new, ${skipped} already present, ${failed.length} failed, ${gitDeps.length} git deps`);
for (const f of failed) console.log("FAILED " + f);
for (const g of gitDeps) console.log(`GIT   ${g.name} ${g.version} ${g.source}`);
process.exit(failed.length ? 1 : 0);
