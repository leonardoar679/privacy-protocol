// The Classic app's source gates in one step (verify-all "classic gates"): the word policy, the declared dependencies,
// the generated tokens up to date.
import { checkDeps } from "./check-deps.mjs";
import { checkTokens } from "./tokens.mjs";
import { checkWords } from "./words.mjs";

let ok = true;
const words = checkWords();
console.log(`${words.ok ? "PASS" : "FAIL"}  words: ${words.files} files${words.ok ? ", no promise word" : ""}`);
for (const p of words.problems) console.error(`  ${p}`);
const deps = checkDeps();
console.log(`${deps.ok ? "PASS" : "FAIL"}  deps: ${deps.checked} bare imports${deps.ok ? ", every one declared by classic/package.json" : ""}`);
for (const p of deps.problems) console.error(`  ${p}`);
const tokens = checkTokens();
console.log(`${tokens.ok ? "PASS" : "FAIL"}  tokens: ${tokens.message}`);
ok = words.ok && deps.ok && tokens.ok;
process.exit(ok ? 0 : 1);
