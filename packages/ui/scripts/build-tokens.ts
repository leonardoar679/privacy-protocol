// Writes src/tokens/tokens.css from the tokens module (`npm run tokens`, through vite-node so the TypeScript source is
// the one that runs). The design-system test asserts the file and `toCss()` agree, so a stale file fails the gate.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { toCss } from "../src/tokens/index";

const out = fileURLToPath(new URL("../src/tokens/tokens.css", import.meta.url));
writeFileSync(out, toCss());
console.log(`wrote ${out}`);
