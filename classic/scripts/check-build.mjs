// The Classic app's build gates in one step (verify-all "classic build checks"): the dist, the budget, the pins.
import { checkBudget } from "./check-budget.mjs";
import { checkDist } from "./check-dist.mjs";
import { checkPins, PUBLIC_PIN_FILE } from "./check-pins.mjs";

const dist = checkDist();
for (const p of dist.problems) console.error(`FAIL  dist: ${p}`);
if (dist.ok) console.log(`PASS  dist: the policy meta, the manifest, the pin file; no source map, no sentinel (${dist.files} files)`);
const budget = checkBudget();
for (const p of budget.problems) console.error(`FAIL  budget: ${p}`);
if (budget.ok)
  console.log(
    `PASS  budget: the first route ${budget.kb.toFixed(1)} KB gzipped (≤ 200); no prover and no WASM before they are needed (${budget.chunks} chunks)`,
  );
const pins = checkPins({ publicPinFile: PUBLIC_PIN_FILE });
for (const p of pins.problems) console.error(`FAIL  pins: ${p}`);
if (pins.ok)
  console.log(
    `PASS  pins: ${pins.rows.filter((x) => x.status === "match").length} verified, ${pins.rows.filter((x) => x.status === "skipped").length} skipped, none unpinned`,
  );
process.exit(dist.ok && budget.ok && pins.ok ? 0 : 1);
