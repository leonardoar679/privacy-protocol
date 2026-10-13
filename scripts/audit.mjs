#!/usr/bin/env node
// The dependency audit (Privacy Wallet Web spec §20–§21; Stage 11): `npm audit --omit=dev --audit-level=high` over every
// package that ships code — the root workspaces (packages/protocol, frontend), packages/swap-engine and
// apps/relayer. A high or critical finding fails the gate with its name, unless scripts/audit-allowlist.json
// accepts it: an entry names the advisory's package, the reason (where it sits in the tree, why it cannot reach the
// shipped code) and a date after which it must be looked at again — an expired acceptance fails. An unreachable
// registry is reported as "skipped (offline)" and passes: the audit is a network check, never a build dependency.
//   node scripts/audit.mjs          the three packages
//   node scripts/audit.mjs --json   the raw reports to stdout
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const PACKAGES = [".", "packages/swap-engine", "apps/relayer"];
const OFFLINE = /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ECONNRESET|socket hang up|audit endpoint returned an error|request to .+ failed|ERR_SOCKET|fetch failed|getaddrinfo/i;
const wantJson = process.argv.includes("--json");

/** The accepted advisories: { name → { reason, until } }, expired ones excluded (they fail like any finding). */
export function loadAllowlist(path = join(root, "scripts", "audit-allowlist.json"), now = new Date()) {
  if (!existsSync(path)) return { accepted: {}, expired: [] };
  const list = JSON.parse(readFileSync(path, "utf8"));
  const accepted = {}, expired = [];
  for (const e of list) {
    if (!e?.name || !e?.reason || !e?.until) continue;
    if (new Date(e.until).getTime() >= now.getTime()) accepted[e.name] = e; else expired.push(e.name);
  }
  return { accepted, expired };
}

/** One package: { status: "clean" | "findings" | "skipped", high, critical, names, accepted, note } */
export function auditPackage(cwd, allow = loadAllowlist()) {
  if (!existsSync(join(cwd, "package-lock.json"))) return { status: "skipped", high: 0, critical: 0, names: [], accepted: [], note: "no package-lock.json" };
  // one command string: npm is a .cmd on Windows and needs the shell; a string avoids the DEP0190 argument-escaping warning
  const r = spawnSync(`${npm} audit --omit=dev --audit-level=high --json`, { cwd, encoding: "utf8", shell: true, env: { ...process.env, npm_config_update_notifier: "false" } });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  let report = null;
  try { report = JSON.parse(r.stdout || "{}"); } catch { report = null; }
  if (report && report.error) {
    const msg = `${report.error.code ?? ""} ${report.error.summary ?? ""} ${report.error.detail ?? ""}`;
    if (OFFLINE.test(msg)) return { status: "skipped", high: 0, critical: 0, names: [], accepted: [], note: `offline (${(report.error.code ?? "registry unreachable").toString().slice(0, 40)})`, raw: report };
    return { status: "findings", high: 0, critical: 0, names: [], accepted: [], note: `npm audit failed: ${msg.slice(0, 160)}`, raw: report };
  }
  if (!report || !report.metadata) {
    if (OFFLINE.test(out)) return { status: "skipped", high: 0, critical: 0, names: [], accepted: [], note: "offline (registry unreachable)" };
    return { status: "findings", high: 0, critical: 0, names: [], accepted: [], note: `unreadable audit output: ${out.slice(0, 160)}` };
  }
  const v = report.metadata.vulnerabilities ?? {};
  const severe = Object.values(report.vulnerabilities ?? {}).filter((x) => x && (x.severity === "high" || x.severity === "critical"));
  const accepted = severe.filter((x) => allow.accepted[x.name]).map((x) => `${x.name} (${x.severity}; accepted until ${allow.accepted[x.name].until}: ${allow.accepted[x.name].reason.split(";")[0].slice(0, 80)})`);
  const open = severe.filter((x) => !allow.accepted[x.name]).map((x) => `${x.name} (${x.severity}${x.range ? ` ${x.range}` : ""}${allow.expired.includes(x.name) ? "; the acceptance expired" : ""})`);
  return { status: open.length ? "findings" : "clean", high: Number(v.high ?? 0), critical: Number(v.critical ?? 0), names: open, accepted, note: `${Number(v.total ?? 0)} advisories of any severity${accepted.length ? `, ${accepted.length} accepted` : ""}`, raw: report };
}

const allow = loadAllowlist();
const results = [];
for (const rel of PACKAGES) {
  const cwd = join(root, rel);
  if (!existsSync(cwd)) { results.push({ pkg: rel, status: "skipped", high: 0, critical: 0, names: [], accepted: [], note: "missing directory" }); continue; }
  const t0 = Date.now();
  const r = auditPackage(cwd, allow);
  results.push({ pkg: rel, ...r, ms: Date.now() - t0 });
}
if (wantJson) {
  console.log(JSON.stringify(results.map(({ raw, ...rest }) => ({ ...rest, raw: raw ?? null })), null, 2));
} else {
  for (const r of results) {
    const mark = r.status === "findings" ? "FAIL" : r.status === "skipped" ? "SKIP" : "PASS";
    const where = r.pkg === "." ? "root workspaces (packages/protocol, frontend)" : r.pkg;
    console.log(`${mark}  ${where}  — ${r.status === "findings" ? `open: ${r.names.join(", ") || r.note}` : r.note}${r.ms ? `  (${(r.ms / 1000).toFixed(1)} s)` : ""}`);
    for (const a of r.accepted ?? []) console.log(`      accepted  ${a}`);
  }
}
const failed = results.filter((r) => r.status === "findings");
const skipped = results.filter((r) => r.status === "skipped");
console.log(`dependency audit: ${results.length - failed.length - skipped.length} clean, ${skipped.length} skipped, ${failed.length} with open findings${allow.expired.length ? `; expired acceptances: ${allow.expired.join(", ")}` : ""}`);
process.exitCode = failed.length ? 1 : 0;
