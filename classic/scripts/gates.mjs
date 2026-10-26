// The Classic app's source gates in one step (verify-all "classic gates"): the word policy, the declared dependencies,
// the generated tokens up to date, the vendored prover's modules exactly the pinned originals with the listed
// replacements, the precompiled circuit what the pinned circuit derives (when the artifacts are on this machine), the
// pin file and its served copy equal.
import { checkDeps } from "./check-deps.mjs";
import { checkPins, PUBLIC_PIN_FILE } from "./check-pins.mjs";
import { compileCircuit } from "./compile-circuit.mjs";
import { checkTokens } from "./tokens.mjs";
import { checkLegacy, FILES } from "./vendor.mjs";
import { checkWords } from "./words.mjs";

const results = [];
const words = checkWords();
results.push([words.ok, `words: ${words.files} files${words.ok ? ", no promise word" : ""}`, words.problems]);
const deps = checkDeps();
results.push([deps.ok, `deps: ${deps.checked} bare imports${deps.ok ? ", every one declared by classic/package.json" : ""}`, deps.problems]);
const tokens = checkTokens();
results.push([tokens.ok, `tokens: ${tokens.message}`, []]);
let vendor;
try {
  vendor = checkLegacy();
} catch (e) {
  vendor = [e instanceof Error ? e.message : String(e)];
}
results.push([
  vendor.length === 0,
  `vendor: ${FILES.length} modules under src/prover/legacy${vendor.length ? "" : " are the pinned originals with the listed replacements"}`,
  vendor,
]);
const circuit = compileCircuit({ write: false });
results.push([
  circuit.ok,
  circuit.skipped
    ? `circuit: skipped — ${circuit.skipped}`
    : `circuit: ${circuit.templates} templates and ${circuit.functions} function precompiled${circuit.ok ? "; the witness file matches its pin" : ""}`,
  circuit.problems ?? [],
]);
const pins = checkPins({ publicPinFile: PUBLIC_PIN_FILE, dist: "/nonexistent" });
results.push([
  pins.ok,
  `pins: ${pins.rows.filter((x) => x.status === "match").length} verified, ${pins.rows.filter((x) => x.status === "skipped").length} skipped${pins.ok ? ", the served copy equal" : ""}`,
  pins.problems,
]);

let ok = true;
for (const [good, line, problems] of results) {
  console.log(`${good ? "PASS" : "FAIL"}  ${line}`);
  for (const p of problems) console.error(`  ${p}`);
  ok &&= good;
}
process.exit(ok ? 0 : 1);
