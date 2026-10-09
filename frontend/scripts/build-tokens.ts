// Writes src/design-system/tokens.css from tokens.ts (`npm run tokens`, through vite-node so the TypeScript source is
// the one that runs). The design-system test asserts the file and `toCss()` agree, so a stale file fails the gate.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { toCss } from "../src/design-system/tokens";

const out = fileURLToPath(new URL("../src/design-system/tokens.css", import.meta.url));
writeFileSync(out, toCss());
console.log(`wrote ${out}`);
