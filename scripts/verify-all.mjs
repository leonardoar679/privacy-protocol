#!/usr/bin/env node
// One command for the whole verification surface (docs/audit-package.md §3): every offline suite,
// the builds, and — opt-in — the live suites, forge and the Rust core (+ its WASM build).
// Prints a summary and exits non-zero if anything failed. Usage:
//   node scripts/verify-all.mjs                 # offline suites + builds (≈ 3 min)
//   node scripts/verify-all.mjs --live          # + the live suites (network, ≈ 3 min more): provider adapters and the
//                                               #   wallet's own checks against real provider calls; the wallet's light
//                                               #   client on mainnet and Sepolia. LI.FI allows an anonymous caller 75
//                                               #   quotes per 2 h: one run uses about 30
//   node scripts/verify-all.mjs --forge <solc>  # + forge test with that solc binary (FOUNDRY_OFFLINE)
//   node scripts/verify-all.mjs --rust          # + cargo test of core/rust (incl. the native prover against the circuit's
//                                               #   real artifacts when circuits/build exists), the wasm32 build, the WASM
//                                               #   package (CARGO, WASM_BINDGEN env for the binaries) and the WASM-vs-TypeScript check
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const live = argv.includes("--live");
const rust = argv.includes("--rust");
const solc = argv.includes("--forge") ? argv[argv.indexOf("--forge") + 1] : process.env.FOUNDRY_SOLC;
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const cargo = process.env.CARGO ?? "cargo";
// the native prover's tests need the circuit build (zkey) and the snarkjs witnesses; with them, they must run
const circuitsBuilt = existsSync(join(root, "circuits/build/setup/transaction_final.zkey")) && existsSync(join(root, "circuits/build/transaction_js/transaction.wasm"));

const steps = [
  // the Rust core first when requested, so the reference suite's WASM-vs-TypeScript check finds a fresh package
  ...(rust ? [
    ...(circuitsBuilt ? [{ name: "native prover fixtures (snarkjs witnesses + proofs of the v1 fixtures → circuits/build/prover-fixtures)", cwd: ".", cmd: process.execPath, args: ["core/rust/scripts/gen-prover-fixtures.mjs"] }] : []),
    { name: `core/rust (cargo test: 14 vector suites == circuit / contracts / TypeScript / web wallet + ${circuitsBuilt ? "12 native witness + prover tests on the real circuit and key" : "the native prover SKIPPED: no circuits/build"})`, cwd: "core/rust", cmd: cargo, args: ["test"], env: circuitsBuilt ? { PRIVACY_PROVER_REQUIRE_ARTIFACTS: "1" } : {} },
    { name: "core/rust FFI (UniFFI: Swift + Kotlin + Python generated from the compiled library; 11 Python tests over it incl. the EVM-verified native proof)", cwd: ".", cmd: process.execPath, args: ["core/rust/scripts/ffi-bindings.mjs"], env: circuitsBuilt ? { PRIVACY_PROVER_REQUIRE_ARTIFACTS: "1" } : {} },
    { name: "core/rust (cargo build --target wasm32-unknown-unknown, the workspace minus the native-only FFI crates)", cwd: "core/rust", cmd: cargo, args: ["build", "--target", "wasm32-unknown-unknown", "--workspace", "--exclude", "privacy-ffi", "--exclude", "uniffi-bindgen"] },
    { name: "core/rust WASM package (release + wasm-bindgen → pkg/node, pkg/web)", cwd: "core/rust", cmd: process.execPath, args: ["scripts/build-wasm.mjs"] },
  ] : []),
  { name: "reference/typescript (63 + 9 WASM-vs-TypeScript when core/rust/pkg exists: primitives, witness, layered tree, prover vs real artifacts, envelope + address, reorg, chain keys, scorecard, the sync batches)", cwd: "reference/typescript", cmd: npx, args: ["vitest", "run"] },
  { name: "services/private-swap typecheck (tsc --noEmit)", cwd: "services/private-swap", cmd: npx, args: ["tsc", "--noEmit", "-p", "."] },
  { name: "services/private-swap offline (43: state machine, scoring, privacy score incl. the link composition, endpoints == forge, restore, escrow call per ingress + asset, what an escrow can re-shield, unit)", cwd: "services/private-swap", cmd: npx, args: ["vitest", "run", "test/engine-core.test.ts", "test/endpoints.test.ts", "test/restore.test.ts", "test/escrow-call.test.ts", "test/escrow-assets.test.ts", "test/chainflip-unit.test.ts", "test/mayan-unit.test.ts"] },
  ...(live ? [{ name: "services/private-swap LIVE (79: adapters, adversarial, privacy flow incl. USDC-sourced orders, guest deposit, the wallet's own provider-call check on every prepared call)", cwd: "services/private-swap", cmd: npx, args: ["vitest", "run", "test/adapters-live.test.ts", "test/adversarial.test.ts", "test/privacy-flow.test.ts", "test/guest.test.ts", "test/wallet-check.test.ts"] }] : []),
  { name: "services/relayer typecheck (tsc --noEmit)", cwd: "services/relayer", cmd: npx, args: ["tsc", "--noEmit", "-p", "."] },
  { name: "services/relayer (33: submission vs forge e2e tx, ERC-20 fee vaults, swap executor vs forge vector incl. WETH and foreign-token refunds, the late-refund watch, refund-only jobs, journals, limits)", cwd: "services/relayer", cmd: npx, args: ["vitest", "run"] },
  { name: "frontend tests (139: the Ethereum light client on a synthetic chain + the pool check in the spend flows, refunded swaps found and proven by their commitment, the Swap screen clicked through against the real engine, the guest deposit instruction checked in the browser, the swap-service guard (escrow recomputed, orders and signatures checked), the provider call read before signing (pinned contracts, receiver, refunds, approved minimum), the Rust core path and the TypeScript path through sync / discovery / planning, keystore + journal + at-rest vectors, ERC-20 assets + fee terms + relayer failover, fresh addresses, RPC quorum, first launch, scheduling, zkAPI policy + capability failures, planning, merges, relayer client)", cwd: "frontend", cmd: npx, args: ["vitest", "run"] },
  ...(live ? [{ name: "frontend LIVE (6: the light client on mainnet and Sepolia — sync, a two-period walk, storage proofs, bent data refused)", cwd: "frontend", cmd: npx, args: ["vitest", "run", "--config", "vitest.live.config.ts"] }] : []),
  { name: "frontend build (tsc -b + vite build)", cwd: "frontend", cmd: npm, args: ["run", "build"] },
  ...(solc ? [{ name: "contracts (forge: 104 incl. real-proof e2e, swap periphery with USDT-like orders and refundToken, native-prover proofs on the verifier)", cwd: "contracts", cmd: process.env.FORGE ?? "forge", args: ["test", "--use", solc], env: { FOUNDRY_OFFLINE: "true" } }] : []),
];

// a failed step's whole output is kept here: a live suite spends rate-limited quota, so a failure must be readable without a rerun
const logDir = join(tmpdir(), "privacy-protocol-verify");
const results = [];
for (const [i, s] of steps.entries()) {
  const cwd = join(root, s.cwd);
  if (!existsSync(cwd)) { results.push({ ...s, ok: false, ms: 0, note: "missing directory" }); continue; }
  const t0 = Date.now();
  const r = spawnSync(s.cmd, s.args, { cwd, encoding: "utf8", shell: process.platform === "win32" && s.cmd !== process.execPath, env: { ...process.env, ...(s.env ?? {}) } });
  const out = ((r.stdout ?? "") + (r.stderr ?? "")).replace(/\x1b\[[0-9;]*m/g, ""); // plain text summaries
  const cargoRuns = [...out.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed/g)];
  // vitest's count line is anchored: its stderr (appended last) opens the failure list with "Failed Tests N"
  const summary = cargoRuns.length > 1
    ? `cargo: ${cargoRuns.reduce((n, m) => n + Number(m[1]), 0)} passed, ${cargoRuns.reduce((n, m) => n + Number(m[2]), 0)} failed across ${cargoRuns.length} test binaries`
    : out.match(/^[ \t]*Tests[ \t]+\d[^\n]*|Ran \d+ test suites[^\n]*|✓ built in [^\n]*|test result: [^\n]*|Finished `[^\n]*|pkg\/node \+ pkg\/web written[^\n]*|written to [^\n]*|bindings generated[^\n]*|Ran \d+ tests in [^\n]*/gm)?.slice(-1)[0]?.trim();
  let note = summary ?? (r.status === 0 ? "ok" : out.split("\n").filter((l) => /error|FAIL|×/i.test(l)).slice(0, 3).join(" | "));
  if (r.status !== 0) {
    // which tests failed and why: vitest's "FAIL file > suite > test" lines, each with the first error line under it
    const lines = out.split("\n");
    const firstError = (k) => lines.slice(k + 1, k + 15).find((m) => /Error|expected/.test(m))?.trim().slice(0, 300);
    const failing = lines.flatMap((l, k) => (/^\s*FAIL\s+\S+ >/.test(l) ? [`${l.trim()}${firstError(k) ? `  ::  ${firstError(k)}` : ""}`] : []));
    mkdirSync(logDir, { recursive: true });
    const log = join(logDir, `${String(i + 1).padStart(2, "0")}-${s.cwd.replace(/\W+/g, "_")}.log`);
    writeFileSync(log, out);
    note = [note, ...failing.slice(0, 10), `full output: ${log}`].join("\n      ");
  }
  results.push({ ...s, ok: r.status === 0, ms: Date.now() - t0, note });
  console.log(`${r.status === 0 ? "PASS" : "FAIL"}  ${s.name}  (${((Date.now() - t0) / 1000).toFixed(0)} s)  ${summary ?? ""}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed${live ? " (incl. live)" : ""}${solc ? " (incl. forge)" : ""}${rust ? " (incl. rust)" : ""}.`);
for (const f of failed) console.log(`  FAILED: ${f.name} — ${f.note}`);
process.exit(failed.length ? 1 : 0);
