#!/usr/bin/env node
// Build a file:// GOPROXY from a go.sum when the Go toolchain itself cannot open outbound sockets
// (on this machine a Winsock LSP refuses connections from go.exe with WSAEACCES while curl/node work).
// For every module@version in go.sum it fetches <mod>/@v/<ver>.{info,mod,zip} from proxy.golang.org
// (escaping upper-case letters as !x, as the proxy protocol requires) into <dir>, and writes @v/list.
// Integrity: `go` itself verifies every .mod and .zip against go.sum (h1: hashes), so nothing here is
// trusted; this script only moves bytes. Usage:
//   node vendor-gomods.mjs <dir> <go.sum>     then     GOPROXY=file:///<dir> GOFLAGS=-mod=mod go test ./...
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "fs";
import { dirname, join } from "path";
import { pipeline } from "stream/promises";

const [dir, sumPath] = process.argv.slice(2);
if (!dir || !sumPath) { console.error("usage: vendor-gomods.mjs <dir> <go.sum>"); process.exit(2); }
const esc = s => s.replace(/[A-Z]/g, c => "!" + c.toLowerCase());
const mods = new Map();
for (const line of readFileSync(sumPath, "utf8").split("\n")) {
  const [mod, ver] = line.trim().split(/\s+/);
  if (!mod || !ver) continue;
  const v = ver.replace(/\/go\.mod$/, "");
  const key = `${mod}@${v}`;
  const e = mods.get(key) ?? { mod, ver: v, zip: false };
  if (!ver.endsWith("/go.mod")) e.zip = true;            // a zip hash means the module's code is needed
  mods.set(key, e);
}
async function fetchTo(url, file) {
  if (existsSync(file) && statSync(file).size > 0) return "cached";
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  mkdirSync(dirname(file), { recursive: true });
  await pipeline(r.body, createWriteStream(file + ".part"));
  const { renameSync } = await import("fs"); renameSync(file + ".part", file);
  return "fetched";
}
let n = 0; const failed = [];
for (const { mod, ver, zip } of mods.values()) {
  const base = `https://proxy.golang.org/${esc(mod)}/@v/${esc(ver)}`;
  const out = join(dir, esc(mod), "@v");
  try {
    for (const ext of ["info", "mod", ...(zip ? ["zip"] : [])]) await fetchTo(`${base}.${ext}`, join(out, `${esc(ver)}.${ext}`));
    const list = join(out, "list");
    const have = existsSync(list) ? readFileSync(list, "utf8").split("\n").filter(Boolean) : [];
    if (!have.includes(ver)) writeFileSync(list, [...have, ver].join("\n") + "\n");
    n++; if (n % 5 === 0) console.log(`${n}/${mods.size} …`);
  } catch (e) { failed.push(`${mod}@${ver}: ${e.message}`); }
}
console.log(`vendored ${n}/${mods.size} modules into ${dir}; ${failed.length} failed`);
for (const f of failed) console.log("FAILED " + f);
process.exit(failed.length ? 1 : 0);
