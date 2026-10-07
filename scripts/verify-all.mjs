#!/usr/bin/env node
// One command for the whole verification surface (docs/audit-package.md §3): every offline suite,
// the builds, and — opt-in — the live adapter suites and forge. Prints a summary table and exits
// non-zero if anything failed. Usage:
//   node scripts/verify-all.mjs                 # offline suites + builds (≈ 2 min)
//   node scripts/verify-all.mjs --live          # + the live provider suites (network, ≈ 2 min more)
//   node scripts/verify-all.mjs --forge <solc>  # + forge test with that solc binary (FOUNDRY_OFFLINE)
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const live = argv.includes("--live");
const solc = argv.includes("--forge") ? argv[argv.indexOf("--forge") + 1] : process.env.FOUNDRY_SOLC;
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const steps = [
  { name: "reference/typescript (45: primitives, witness, prover vs real artifacts, envelope + address, reorg)", cwd: "reference/typescript", cmd: npx, args: ["vitest", "run"] },
  { name: "services/private-swap typecheck (tsc --noEmit)", cwd: "services/private-swap", cmd: npx, args: ["tsc", "--noEmit", "-p", "."] },
  { name: "services/private-swap offline (31: state machine, scoring, privacy score, endpoints == forge, unit)", cwd: "services/private-swap", cmd: npx, args: ["vitest", "run", "test/engine-core.test.ts", "test/endpoints.test.ts", "test/chainflip-unit.test.ts", "test/mayan-unit.test.ts"] },
  ...(live ? [{ name: "services/private-swap LIVE (65: adapters, adversarial, privacy flow)", cwd: "services/private-swap", cmd: npx, args: ["vitest", "run", "test/adapters-live.test.ts", "test/adversarial.test.ts", "test/privacy-flow.test.ts"] }] : []),
  { name: "services/relayer typecheck (tsc --noEmit)", cwd: "services/relayer", cmd: npx, args: ["tsc", "--noEmit", "-p", "."] },
  { name: "services/relayer (23: submission vs forge e2e tx, swap executor vs forge vector, journals, limits)", cwd: "services/relayer", cmd: npx, args: ["vitest", "run"] },
  { name: "frontend tests (27: zkAPI policy, fresh provider, tree sync + discovery, planning, merges, relayer client)", cwd: "frontend", cmd: npx, args: ["vitest", "run"] },
  { name: "frontend build (tsc -b + vite build)", cwd: "frontend", cmd: npm, args: ["run", "build"] },
  ...(solc ? [{ name: "contracts (forge: 87 incl. real-proof e2e + swap periphery)", cwd: "contracts", cmd: process.env.FORGE ?? "forge", args: ["test", "--use", solc], env: { FOUNDRY_OFFLINE: "true" } }] : []),
];

const results = [];
for (const s of steps) {
  const cwd = join(root, s.cwd);
  if (!existsSync(cwd)) { results.push({ ...s, ok: false, ms: 0, note: "missing directory" }); continue; }
  const t0 = Date.now();
  const r = spawnSync(s.cmd, s.args, { cwd, encoding: "utf8", shell: process.platform === "win32", env: { ...process.env, ...(s.env ?? {}) } });
  const out = ((r.stdout ?? "") + (r.stderr ?? "")).replace(/\x1b\[[0-9;]*m/g, ""); // plain text summaries
  const m = out.match(/Tests\s+(\d+) passed(?: \| (\d+) failed)?|(\d+) tests? passed, (\d+) failed|Suite result: (ok|FAILED)\. (\d+) passed; (\d+) failed/);
  const summary = out.match(/Tests\s+[^\n]*|Ran \d+ test suites[^\n]*|✓ built in [^\n]*/g)?.slice(-1)[0]?.trim();
  results.push({ ...s, ok: r.status === 0, ms: Date.now() - t0, note: summary ?? (r.status === 0 ? "ok" : out.split("\n").filter((l) => /error|FAIL|×/i.test(l)).slice(0, 3).join(" | ")) });
  console.log(`${r.status === 0 ? "PASS" : "FAIL"}  ${s.name}  (${((Date.now() - t0) / 1000).toFixed(0)} s)  ${summary ?? ""}`);
  void m;
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed${live ? " (incl. live)" : ""}${solc ? " (incl. forge)" : ""}.`);
for (const f of failed) console.log(`  FAILED: ${f.name} — ${f.note}`);
process.exit(failed.length ? 1 : 0);
