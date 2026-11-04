#!/usr/bin/env node
// The zkAPI SDK clone against its pins (the sixth review round, 2026-11-03; verify-all "zkapi sdk pins"): every file under the
// clone's sdk/ hashes to apps/web/zkapi-sdk.pins.json and the clone is at the pinned commit. Without a clone there is nothing to
// check — the build carries the stub — unless --require says a clone must be there (a release machine).
//   node scripts/check-zkapi-sdk.mjs [--require]
import { compareSdkPins, readSdkPins, sdkDirOf, sdkPresent } from "./zkapi-sdk-pins-lib.mjs";
const dir = sdkDirOf();
const require = process.argv.includes("--require");
if (!sdkPresent(dir)) {
  console.log(`${require ? "FAIL" : "SKIP"}  no zkAPI SDK clone at ${dir}: the build carries the stub (set ZKAPI_SDK_DIR to check a clone)`);
  process.exit(require ? 1 : 0);
}
const pins = readSdkPins();
const problems = compareSdkPins(pins, dir);
for (const p of problems) console.log(`FAIL  ${p}`);
if (!problems.length) console.log(`PASS  the zkAPI SDK clone at ${dir} is the pinned one: ${Object.keys(pins.files).length} files, commit ${String(pins.commit ?? "?").slice(0, 12)}`);
process.exit(problems.length ? 1 : 0);
