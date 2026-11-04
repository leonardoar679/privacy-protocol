#!/usr/bin/env node
// Writes apps/web/zkapi-sdk.pins.json from the clone ZKAPI_SDK_DIR names (the sixth review round, 2026-11-03): run it against
// a clone whose commit was reviewed (docs/private-ai.md names it), then commit the pins beside the review's note.
//   node scripts/pin-zkapi-sdk.mjs
import { writeFileSync } from "node:fs";
import { bytesOf, hashSdk, headOf, PIN_FILE, sdkDirOf, sdkPresent } from "./zkapi-sdk-pins-lib.mjs";
const dir = sdkDirOf();
if (!sdkPresent(dir)) { console.error(`no zkAPI SDK clone at ${dir} (ZKAPI_SDK_DIR)`); process.exit(2); }
const files = hashSdk(dir);
const pins = { comment: "The zkAPI browser SDK clone the wallet bundles (docs/private-ai.md): its commit and the sha256 of every file under sdk/, tests apart. The build refuses a clone that differs (apps/web/scripts/zkapi-sdk-pins-lib.mjs). Re-pin only after reviewing the new commit.", commit: headOf(dir), pinnedAt: new Date().toISOString().slice(0, 10), files };
writeFileSync(PIN_FILE, JSON.stringify(pins, null, 2) + "\n");
console.log(`pinned ${Object.keys(files).length} files (${bytesOf(dir, files)} bytes) of ${dir} at ${pins.commit ?? "no git commit"} → ${PIN_FILE}`);
