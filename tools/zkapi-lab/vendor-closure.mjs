#!/usr/bin/env node
// Vendor a crate AND its dependency closure into a cargo "directory" source without cargo touching the
// network (this machine's socket stack blocks cargo but not node): versions and checksums come from
// the crates.io sparse index, tarballs from static.crates.io, every tarball is verified against the
// index checksum, and cargo then resolves offline against the directory. Crates already present in a
// satisfying version are kept. Usage:
//   node vendor-closure.mjs <vendorDir> <crate>[@<semver req>] ...
import { createHash } from "crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { join, resolve } from "path";

const [vendorDir, ...wanted] = process.argv.slice(2);
if (!vendorDir || wanted.length === 0) { console.error("usage: node vendor-closure.mjs <vendorDir> <crate>[@req] ..."); process.exit(2); }
const vendor = resolve(vendorDir);
mkdirSync(vendor, { recursive: true });

// ---- a small semver (cargo flavour): ^ (default), ~, =, >=, >, <=, <, *, x, comma = AND ----
const parse = (v) => { const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v); return m ? { M: +m[1], m: +m[2], p: +m[3], pre: m[4] ?? null } : null; };
const cmp = (a, b) => a.M - b.M || a.m - b.m || a.p - b.p;
function satisfiesOne(ver, req) {
  req = req.trim();
  if (req === "*" || req === "") return true;
  let op = "^";
  const m = /^(\^|~|=|>=|<=|>|<)?\s*(.+)$/.exec(req);
  if (m[1]) op = m[1];
  let spec = m[2].trim();
  if (/^\d+(\.\d+)?(\.[x*])?$/.test(spec) || /^\d+\.[x*]$/.test(spec)) { /* partial */ }
  const parts = spec.replace(/\.[x*]$/, "").split(".");
  const M = +parts[0], mi = parts.length > 1 ? +parts[1] : null, p = parts.length > 2 ? +parts[2] : null;
  const lo = { M, m: mi ?? 0, p: p ?? 0 };
  const v = ver;
  if (op === "=") return v.M === M && (mi === null || v.m === mi) && (p === null || v.p === p);
  if (op === ">=") return cmp(v, lo) >= 0;
  if (op === ">") return cmp(v, lo) > 0;
  if (op === "<=") return cmp(v, lo) <= 0;
  if (op === "<") return cmp(v, lo) < 0;
  if (op === "~") { if (cmp(v, lo) < 0) return false; return mi === null ? v.M === M : v.M === M && v.m === mi; }
  // caret
  if (cmp(v, lo) < 0) return false;
  if (M > 0) return v.M === M;
  if (mi === null) return v.M === 0;
  if (mi > 0) return v.M === 0 && v.m === mi;
  if (p === null) return v.M === 0 && v.m === 0;
  return v.M === 0 && v.m === 0 && v.p === p;
}
const satisfies = (ver, req) => req.split(",").every((r) => satisfiesOne(ver, r));

// ---- sparse index ----
const prefix = (n) => (n.length === 1 ? `1/${n}` : n.length === 2 ? `2/${n}` : n.length === 3 ? `3/${n[0]}/${n}` : `${n.slice(0, 2)}/${n.slice(2, 4)}/${n}`);
const indexCache = new Map();
async function fetchText(url) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(60000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r; }
    catch (e) { if (attempt === 4) throw e; await new Promise((res) => setTimeout(res, 1500 * attempt)); }
  }
}
async function index(name) {
  if (indexCache.has(name)) return indexCache.get(name);
  const r = await fetchText(`https://index.crates.io/${prefix(name)}`);
  const lines = (await r.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  indexCache.set(name, lines);
  return lines;
}

// ---- what is already vendored ----
const present = new Map(); // name -> [version strings]
for (const d of readdirSync(vendor)) {
  const m = /^(.*)-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(d);
  if (m && existsSync(join(vendor, d, ".cargo-checksum.json"))) (present.get(m[1]) ?? present.set(m[1], []).get(m[1])).push(m[2]);
}
const have = (name, req) => (present.get(name) ?? []).some((v) => satisfies(parse(v), req));

// ---- resolve the closure (highest non-yanked, non-prerelease version satisfying each requirement) ----
const plan = new Map(); // name-version -> entry
const queue = wanted.map((w) => { const i = w.indexOf("@"); return i > 0 ? { name: w.slice(0, i), req: w.slice(i + 1) } : { name: w, req: "*" }; });
const seen = new Set();
while (queue.length) {
  const { name, req } = queue.shift();
  const key = `${name}@${req}`;
  if (seen.has(key)) continue;
  seen.add(key);
  if (have(name, req)) continue;
  if ([...plan.values()].some((e) => e.name === name && satisfies(parse(e.vers), req))) continue;
  const versions = (await index(name)).filter((e) => !e.yanked && parse(e.vers) && !parse(e.vers).pre && satisfies(parse(e.vers), req));
  if (!versions.length) { console.log(`WARN no version of ${name} satisfies ${req} (skipped)`); continue; }
  const best = versions.sort((a, b) => cmp(parse(b.vers), parse(a.vers)))[0];
  plan.set(`${name}-${best.vers}`, best);
  for (const d of best.deps) {
    if (d.kind === "dev" || d.optional) continue; // optional deps only when a feature needs them: cargo names them, run again
    queue.push({ name: d.package ?? d.name, req: d.req });
  }
}
console.log(`${plan.size} crate(s) to vendor: ${[...plan.keys()].join(", ") || "(none)"}`);

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
let failed = 0;
for (const [key, e] of plan) {
  const dir = join(vendor, key);
  try {
    const r = await fetchText(`https://static.crates.io/crates/${e.name}/${e.name}-${e.vers}.crate`);
    const buf = Buffer.from(await r.arrayBuffer());
    const h = sha256(buf);
    if (h !== e.cksum) throw new Error(`checksum mismatch: index ${e.cksum} got ${h}`);
    const tmp = join(vendor, `${key}.crate`);
    writeFileSync(tmp, buf);
    rmSync(dir, { recursive: true, force: true });
    execFileSync("tar", ["--force-local", "-xzf", tmp, "-C", vendor]);
    rmSync(tmp);
    writeFileSync(join(dir, ".cargo-checksum.json"), JSON.stringify({ files: {}, package: h }) + "\n");
    console.log(`vendored ${key}`);
  } catch (err) {
    failed++;
    console.log(`FAILED ${key}: ${err.message}`);
  }
}
process.exit(failed ? 1 : 0);
