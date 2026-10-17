#!/usr/bin/env node
// The dependency audit (Privacy Wallet Web spec §20–§21; Stage 11): `npm audit --omit=dev --audit-level=high` over every
// package that ships code — since V6 Stage 2 every one of them (apps/*, packages/*) is a workspace of the one root
// lockfile, so the root audit covers them all. A high or critical finding fails the gate with its name, unless scripts/audit-allowlist.json
// accepts it: an entry names the advisory's package, the reason (where it sits in the tree, why it cannot reach the
// shipped code) and a date after which it must be looked at again — an expired acceptance fails. An unreachable
// registry is reported as "skipped (offline)" and passes: the audit is a network check, never a build dependency. An
// answer naming no package and no known network failure is asked again once, three seconds later, and a second such answer
// fails with npm's whole error (2026-10-17: twice in a day npm answered an error whose code, summary and detail were empty,
// and the gate failed with "npm audit failed:" and nothing else). A self-test of how answers are read runs first.
//   node scripts/audit.mjs          the root lockfile (every workspace)
//   node scripts/audit.mjs --json   the raw reports to stdout
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const PACKAGES = ["."];
const OFFLINE =
  /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ECONNRESET|socket hang up|audit endpoint returned an error|request to .+ failed|ERR_SOCKET|fetch failed|getaddrinfo/i;
const wantJson = process.argv.includes("--json");

/** The accepted advisories: { name → { reason, until } }, expired ones excluded (they fail like any finding). */
export function loadAllowlist(path = join(root, "scripts", "audit-allowlist.json"), now = new Date()) {
  if (!existsSync(path)) return { accepted: {}, expired: [] };
  const list = JSON.parse(readFileSync(path, "utf8"));
  const accepted = {},
    expired = [];
  for (const e of list) {
    if (!e?.name || !e?.reason || !e?.until) continue;
    if (new Date(e.until).getTime() >= now.getTime()) accepted[e.name] = e;
    else expired.push(e.name);
  }
  return { accepted, expired };
}

/** `npm audit` in `cwd`: its stdout and stderr. */
function npmAudit(cwd) {
  // one command string: npm is a .cmd on Windows and needs the shell; a string avoids the DEP0190 argument-escaping warning
  const r = spawnSync(`${npm} audit --omit=dev --audit-level=high --json`, {
    cwd,
    encoding: "utf8",
    shell: true,
    env: { ...process.env, npm_config_update_notifier: "false" },
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * What one answer of `npm audit --json` means: { status: "clean" | "findings" | "skipped", high, critical, names, accepted,
 * note, unclear }. `unclear`: npm answered an error, or something that is no report, naming no known network failure.
 */
export function readAnswer(r, allow = loadAllowlist()) {
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  let report = null;
  try {
    report = JSON.parse(r.stdout || "{}");
  } catch {
    report = null;
  }
  if (report && report.error) {
    const e = report.error;
    const msg = [e.code, e.summary, e.detail, e.message, typeof e === "string" ? e : null].filter(Boolean).join(" ").trim() || JSON.stringify(e);
    if (OFFLINE.test(msg))
      return {
        status: "skipped",
        high: 0,
        critical: 0,
        names: [],
        accepted: [],
        note: `offline (${(e.code ?? "registry unreachable").toString().slice(0, 40)})`,
        raw: report,
      };
    return { status: "findings", high: 0, critical: 0, names: [], accepted: [], note: `npm audit failed: ${msg.slice(0, 300)}`, unclear: true, raw: report };
  }
  if (!report || !report.metadata) {
    if (OFFLINE.test(out)) return { status: "skipped", high: 0, critical: 0, names: [], accepted: [], note: "offline (registry unreachable)" };
    return { status: "findings", high: 0, critical: 0, names: [], accepted: [], note: `unreadable audit output: ${out.slice(0, 300)}`, unclear: true };
  }
  const v = report.metadata.vulnerabilities ?? {};
  const severe = Object.values(report.vulnerabilities ?? {}).filter((x) => x && (x.severity === "high" || x.severity === "critical"));
  const accepted = severe
    .filter((x) => allow.accepted[x.name])
    .map((x) => `${x.name} (${x.severity}; accepted until ${allow.accepted[x.name].until}: ${allow.accepted[x.name].reason.split(";")[0].slice(0, 80)})`);
  const open = severe
    .filter((x) => !allow.accepted[x.name])
    .map((x) => `${x.name} (${x.severity}${x.range ? ` ${x.range}` : ""}${allow.expired.includes(x.name) ? "; the acceptance expired" : ""})`);
  return {
    status: open.length ? "findings" : "clean",
    high: Number(v.high ?? 0),
    critical: Number(v.critical ?? 0),
    names: open,
    accepted,
    note: `${Number(v.total ?? 0)} advisories of any severity${accepted.length ? `, ${accepted.length} accepted` : ""}`,
    raw: report,
  };
}

/** One package: an unclear answer is asked again once, three seconds later; the second answer stands. */
export function auditPackage(cwd, allow = loadAllowlist(), run = npmAudit, pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)) {
  if (!existsSync(join(cwd, "package-lock.json"))) return { status: "skipped", high: 0, critical: 0, names: [], accepted: [], note: "no package-lock.json" };
  const first = readAnswer(run(cwd), allow);
  if (!first.unclear) return first;
  pause(3000);
  const second = readAnswer(run(cwd), allow);
  return second.unclear ? { ...second, note: `${second.note} (asked twice)` } : second;
}

/** How answers are read, checked before the network is asked (like scan-bundle's self-test): an empty error is unclear,
 *  a registry error npm names is a skip, an accepted advisory is clean, an open one fails. */
function selfTest() {
  const allowed = { accepted: { underscore: { reason: "test", until: "2999-01-01" } }, expired: [] };
  const report = (sev, name) => ({
    stdout: JSON.stringify({ metadata: { vulnerabilities: { high: 1, total: 1 } }, vulnerabilities: { [name]: { name, severity: sev } } }),
    stderr: "",
  });
  const cases = [
    [
      readAnswer({ stdout: JSON.stringify({ error: { code: null, summary: "", detail: "" } }), stderr: "" }, allowed).unclear === true,
      "an empty error is unclear",
    ],
    [
      readAnswer({ stdout: JSON.stringify({ error: { message: "audit endpoint returned an error" } }), stderr: "" }, allowed).status === "skipped",
      "a registry error in `message` is a skip",
    ],
    [readAnswer(report("high", "underscore"), allowed).status === "clean", "an accepted advisory is clean"],
    [readAnswer(report("high", "left-pad"), allowed).status === "findings", "an open advisory fails"],
  ];
  let asked = 0;
  const twice = auditPackage(
    root,
    allowed,
    () => (++asked === 1 ? { stdout: JSON.stringify({ error: {} }), stderr: "" } : report("high", "underscore")),
    () => undefined,
  );
  cases.push([asked === 2 && twice.status === "clean", "an unclear answer is asked again once"]);
  const wrong = cases.filter(([ok]) => !ok).map(([, what]) => what);
  if (wrong.length) {
    console.log(`FAIL  the audit's self-test: ${wrong.join("; ")}`);
    process.exit(1);
  }
}

selfTest();
const allow = loadAllowlist();
const results = [];
for (const rel of PACKAGES) {
  const cwd = join(root, rel);
  if (!existsSync(cwd)) {
    results.push({ pkg: rel, status: "skipped", high: 0, critical: 0, names: [], accepted: [], note: "missing directory" });
    continue;
  }
  const t0 = Date.now();
  const r = auditPackage(cwd, allow);
  results.push({ pkg: rel, ...r, ms: Date.now() - t0 });
}
if (wantJson) {
  console.log(
    JSON.stringify(
      results.map(({ raw, ...rest }) => ({ ...rest, raw: raw ?? null })),
      null,
      2,
    ),
  );
} else {
  for (const r of results) {
    const mark = r.status === "findings" ? "FAIL" : r.status === "skipped" ? "SKIP" : "PASS";
    const where = r.pkg === "." ? "the workspaces (apps/*, packages/*)" : r.pkg;
    console.log(
      `${mark}  ${where}  — ${r.status === "findings" ? `open: ${r.names.join(", ") || r.note}` : r.note}${r.ms ? `  (${(r.ms / 1000).toFixed(1)} s)` : ""}`,
    );
    for (const a of r.accepted ?? []) console.log(`      accepted  ${a}`);
  }
}
const failed = results.filter((r) => r.status === "findings");
const skipped = results.filter((r) => r.status === "skipped");
console.log(
  `dependency audit: ${results.length - failed.length - skipped.length} clean, ${skipped.length} skipped, ${failed.length} with open findings${allow.expired.length ? `; expired acceptances: ${allow.expired.join(", ")}` : ""}`,
);
process.exitCode = failed.length ? 1 : 0;
